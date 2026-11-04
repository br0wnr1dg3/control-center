# Control Center

A personal, Linear-style task board for everything that isn't engineering, built to be driven by Claude. Capture tasks from any Claude surface (CLI, web, desktop, Slack) or by forwarding an email; agent tasks run themselves in Claude Code sessions on your Mac, and anything that needs a human comes back to your inbox.

```
Claude CLI / web / app / Slack ─┐
Email (AgentMail webhook) ──────┼─► Cloudflare Worker (MCP + OAuth) ─► Supabase Postgres ◄─┬─ Mac app (SwiftUI)
                                │                                                            └─ Runner (launchd) ─► cmux + claude
```

- `supabase/migrations/`: schema (tasks, comments, notifications, teams, projects, repos) and triggers
- `mcp/`: Cloudflare Worker with the MCP tools, passphrase-gated OAuth (single owner) and email capture
- `runner/`: picks up ready agent tasks and runs each in its own `claude` session (cmux workspace, git worktree, Remote Control), then cleans up
- `mac/`: SwiftUI board app: Inbox, Today, Upcoming calendar, board, full-page tasks, team settings

Built for one person (single owner, service-role access, macOS paths). To run your own:

- Point it at your Supabase project and Worker URL (`CC_SUPABASE_URL`, `PUBLIC_URL`, `wrangler.jsonc`).
- Set your name for agent and connector prompts: the `OWNER_NAME` Worker secret and `CC_OWNER_NAME=<name> runner/install.sh`. Unset, they say "the owner".
- Personal setup (teams, GitHub orgs, folders, base branches, pinned projects, repo nicknames) is data, not code: set it in the app's team settings, or copy `supabase/seed.example.sql` to the git-ignored `supabase/seed.local.sql` and run it once.

## Task model

`kind`: `human` | `agent` | `either` · `status`: `new → ready → in_progress → needs_you → done` (or `cancelled`)
`scheduled_on` is the day to do it (calendar; agent tasks wait for it), `due` the deadline.
"Today" = `today = true`, or scheduled/due on or before today, not done. Descriptions and comments are Markdown.

**Teams** are companies plus Personal. Each has a Markdown briefing (`context`), repos (`[{name, url, path}]`)
and a working folder; **projects** belong to one team and have their own spec and repos. Tasks keep `project` as
text and inherit the project's team (trigger `sync_task_project`); moving a project moves its tasks. The runner
puts the team briefing, project spec and repo paths at the top of every agent prompt.

### Stages

`task_dependencies` makes one task wait on others (`blocked_by` on `add_task` / `update_task`; `get_task` shows `blocked_by` and `blocks`). Self-references and cycles are rejected. Blockers delay a task, they don't approve it: `ready` still means the owner said go, and no trigger ever moves a task to `ready`.

`waiting_on(task)` is the one definition of waiting: the blockers still open, neither `done` nor `cancelled`. It's a SQL function PostgREST exposes as a computed column (`select=*,waiting_on`, `waiting_on=eq.{}`).

- **While waiting**: the runner doesn't start a `ready` agent task, and it's left out of the `agent_ready` view. A `ready` task for the owner stays off Today, with a "Waiting on CC-x" badge.
- **Last open blocker finishes**: a `ready` agent task starts as usual, once `scheduled_on` arrives. A `ready` task for the owner lands in the inbox. A `new` task stays `new`, since it still needs approving.
- **A blocker is cancelled**: a `new` or `ready` task moves to `needs_you` with a note. Answering makes it `ready`, and it still waits for any other open blockers. It's never cancelled silently.
- **A blocker is removed or deleted while open**: the task stops waiting, and that's logged on it.

Other statuses are left alone: a started task keeps going even if a blocker is added. A live session keeps receiving comments and answers while waiting. Reopening a blocker makes `ready` tasks wait again.

So to chain stages that run themselves, approve them all up front: `add_task(ready=true, blocked_by=[...])`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `add_task` | Capture a task (`team`, `project`, `scheduled_on`; `ready: true` skips `new`; agent+ready = runner queue) |
| `list_tasks` | Views: `today`, `upcoming`, `new`, `agent_ready`, `needs_you`, `human`, `open`, `done_recent`; filter by team/project/label/priority |
| `get_task` | Task + subtasks + comments + activity |
| `update_task` | Change fields (incl. `team`), labels, links; append a progress `log` |
| `add_comment` | Comment (`me` reaches a running agent; others land in the inbox) |
| `complete_task` | Mark done with a summary |
| `ask_human` | Block on a question (→ `needs_you`, keeps `session_id` for resume) |
| `answer_task` | Answer from any surface (→ `ready`, runner resumes) |
| `add_human_task` | Agent hands a step to you as a subtask on today's list |
| `plan_today` | Set today's list |
| `list_inbox` / `mark_inbox_read` | Notifications: questions, comments, hand-offs, finished work |
| `list_teams` / `get_team` | Teams and projects; a team's briefing, repos and project specs |
| `save_team` / `save_project` | Create or update a team (by key) or project (by name) |
| `add_webhook` / `list_webhooks` / `test_webhook` / `pause_webhook` / `resume_webhook` / `delete_webhook` | Outbound webhooks for a team or project (see below) |

## Local dev

```bash
supabase start                      # ports 577xx (see supabase/config.toml)
cd mcp && cp .dev.vars.example .dev.vars   # fill from `supabase status -o env`
npm run dev                         # http://localhost:8787; GET /__scheduled runs the cron once
node scripts/smoke.mjs              # full OAuth + tool round-trip
```

## Deploy

1. **Supabase**: create a project, then `supabase link --project-ref <ref> && supabase db push`.
2. **Cloudflare** (from `mcp/`):
   ```bash
   npx wrangler login
   npx wrangler kv namespace create OAUTH_KV        # paste id into wrangler.jsonc
   npx wrangler deploy                              # note the workers.dev URL
   # set PUBLIC_URL in wrangler.jsonc to that URL, then:
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put OWNER_PASSPHRASE         # long, random
   npx wrangler deploy
   node scripts/smoke.mjs https://<url> '<passphrase>'
   ```
3. **Connect**:
   - Claude Code: `claude mcp add --scope user --transport http control-center https://<url>/mcp`, then `/mcp` to sign in
   - claude.ai (each account): Settings → Connectors → Add custom connector → `https://<url>/mcp`
   - Slack: enable the same connector for Claude in Slack

## Email capture (`mcp/src/email.ts`)

Forward an email to **brownridge@agentmail.to** and it becomes task(s). AgentMail posts each message to `/hooks/agentmail` (Svix signature checked with `AGENTMAIL_WEBHOOK_SECRET`). Only `ALLOWED_SENDERS` count, and only when DKIM/DMARC pass for that domain. With `ANTHROPIC_API_KEY` set, Claude Haiku 5.5 (structured output) writes proper tickets: team, project, kind, dates, split into several if needed; without it the subject and email become one plain ticket. Tickets land as **New**; "@agent" in your own note (not the forwarded text) makes agent tickets Ready. The inbox replies with the CC keys.

## Inbound events (`mcp/src/inbound.ts`)

A trusted app sends events to `POST /hooks/inbound`. Each team has its own secret, the Worker secret `INBOUND_SECRET_<TEAM KEY>` (uppercase, `-` as `_`, e.g. `npx wrangler secret put INBOUND_SECRET_ACME`); a team without one accepts nothing. Every request is signed:

| Header | Value |
| --- | --- |
| `X-CC-Team` | Team key |
| `X-CC-Timestamp` | Unix seconds, within 5 minutes |
| `X-CC-Signature` | `v1=` + hex HMAC-SHA256 of `<timestamp>.<raw body>` |

Every event has `id` (unique per team and source), `source` (lowercase name of the sending app) and `type`:

```jsonc
{ "id": "evt_1", "source": "myapp", "type": "job.create", "job": {
    "id": "job_42", "url": "https://myapp.example/jobs/42", "title": "Make the launch video",
    "description": "Markdown", "kind": "human", "project": "Video", "labels": ["launch"], "priority": 2,
    "scheduled_on": "2026-12-01", "due": "2026-12-05", "ready": false,
    "requested_by": { "name": "Sam", "email": "sam@example.com" },
    "stages": [
      { "id": "job_42/uploads", "title": "Wait for uploads", "kind": "human" },
      { "id": "job_42/cut", "url": "https://myapp.example/jobs/42/cut", "title": "Cut the video", "kind": "agent", "ready": true, "blocked_by": ["job_42/uploads"] }
    ] } }
{ "id": "evt_2", "source": "myapp", "type": "stage.ready", "task": "job_42/uploads", "note": "uploads complete" }
{ "id": "evt_3", "source": "myapp", "type": "comment", "task": "job_42", "body": "Client added a note", "author": "Sam" }
```

- **`job.create`** makes the parent task and its stages as sub-tasks, all or nothing, and responds with `{ "tasks": { "<your id>": <CC id> } }`. Each task's `external_ref` is `{source, id, url}`; `requested_by` goes on all of them, and stages inherit the job's labels and priority unless they set their own. `blocked_by` names stages of the same job. A project must be new or already in the sender's team.
- **`stage.ready`** moves a `new` task to `ready`. It still waits for open blockers, and a `ready` task for the owner lands in the inbox when nothing holds it. A task in any other status is left alone, and the response says `"changed": false`: only the owner reopens work or answers for a cancelled blocker.
- **`comment`** lands in the inbox with author `external`. It isn't typed into a live session and an `@agent` in it does nothing.

Tasks are addressed by the sender's own ids, and only tasks made through this endpoint in the sender's team can be reached.

Sending an event again with the same `id` returns the first answer with `"duplicate": true`. An `id` reused for a different event gets 409. A failed event isn't recorded, so retry it with the same `id`.

Statuses: `200` applied or duplicate, `400` bad shape, `401` bad signature, `404` no such task (retry if the job may not have arrived yet), `409` id conflict, `413` body over 1 MB, `422` the event can't apply (unknown blocker, cycle, another team's project), `500` retry.

**`ready: true` and `stage.ready` approve work.** A ready agent task starts without further review, in a session that runs with permissions skipped, so a team's secret is as powerful as the owner's approval for that team's inbound tasks. The agent's prompt says the task's words came from outside and aren't the owner's instructions beyond the work itself; that's a guardrail, not a sandbox. Only give a secret to an app you trust, and leave `ready` off for anything built from text its users typed.

## Outbound webhooks (`mcp/src/webhooks.ts`)

Keeps the apps that create and follow work up to date. A team can have several webhooks, each following the whole team or one project, added from the team's settings in the app or with `add_webhook`. Each has its own secret, generated when it's added and shown that once; it's kept in Supabase Vault, and only the sender reads it.

| Option | Values |
| --- | --- |
| `project` | Only this project's tasks. Default: the whole team |
| `scope` | `external` (default): only tasks with an `external_ref`, i.e. made through inbound events. `all`: every task in scope |
| `events` | `task.created`, `task.status`, `review.published`, `review.decided`, `comment.added`. Default: all but `comment.added`, which is opt-in because it's noisy |

The URL must be https (plain http is only accepted for `localhost` and `127.0.0.1`, for testing).

Every delivery is a signed POST, in the same format as inbound events:

| Header | Value |
| --- | --- |
| `X-CC-Webhook` | Webhook id |
| `X-CC-Event` | Event id, the same on every retry and for every webhook. Use it to ignore repeats |
| `X-CC-Event-Type` | The event's type |
| `X-CC-Timestamp` | Unix seconds when this attempt was sent |
| `X-CC-Signature` | `v1=` + hex HMAC-SHA256 of `<timestamp>.<raw body>`, with the webhook's secret |

To verify: compute the HMAC over the raw bytes received (before parsing), compare in constant time, and reject timestamps more than 5 minutes old.

```jsonc
{
  "id": "evt_91a2acd59a164c02978465030f40a042",
  "type": "task.status",
  "created_at": "2026-11-04T18:29:01.980+00:00", // when it happened, which on a retry is earlier than the timestamp header
  "task": {
    "id": 42, "key": "CC-42", "title": "Cut the video", "status": "in_progress", "kind": "agent", "parent_id": 41,
    "project": "Video",
    "team": { "id": 3, "key": "acme", "name": "Acme" },
    "external_ref": { "source": "myapp", "id": "job_42/cut", "url": "https://myapp.example/jobs/42/cut" }, // null if not from another app
    "requested_by": { "name": "Sam", "email": "sam@example.com" }                                          // likewise
  },
  // Then, depending on the type:
  "previous_status": "ready", // task.status
  "review": { "id": 7, "title": "Cut v2", "url": "https://<worker>/r/acme/<token>", "decision": null, "decided_by": null, "decided_at": null },
  // ^ review.published and review.decided. decision is "approved" or "changes_requested". The url is the private review link: anyone with it can open and comment.
  "comment": { "id": 9, "author": "agent", "author_name": null, "body": "Markdown", "created_at": "..." }
  // ^ comment.added. author is me, claude, agent, reviewer or external (one sent through inbound events, so possibly your own: don't mirror those back).
}
{ "id": "evt_...", "type": "ping", "created_at": "...", "webhook": { "id": 5, "team": "acme", "project": null } } // a test; has no task
```

The payload is a snapshot from when the event happened. `task.created` for a job says `new`; if it was created ready, a `task.status` follows.

**Delivery.** Triggers write one row per event and matching webhook to an outbox (`webhook_deliveries`) in the same transaction as the change, so nothing is lost and webhooks fail independently. The Worker's cron sends what's due every minute, in parallel across webhooks, so a slow endpoint only delays itself. Any 2xx is success; anything else, including a redirect (never followed) or no answer in 10 seconds, is retried after 1, 2, 4, 8, 16, 32 and 64 minutes.

- **At least once, roughly in order.** A sender that dies mid-send leaves its claim to expire and the event goes again, and retries overtake newer events. Dedupe on the event id, and use `created_at` to ignore a status older than one you've already applied.
- **After 8 failed attempts** (about 2 hours) the webhook pauses, with the reason on it and a note in the inbox. Events keep queueing while it's paused, by hand or by failure; resuming sends everything queued or failed. Anything older than 30 days is dropped.
- **Testing:** `test_webhook` or "Send test" sends a `ping`, even while paused. It's tried once and a failure doesn't count against the webhook. The tool answers at once; the app shows the result as the last delivery within a minute.

MCP tools: `add_webhook`, `list_webhooks`, `test_webhook`, `pause_webhook`, `resume_webhook`, `delete_webhook`.

## Linear (`runner/linear.mjs`)

Delegate a Linear issue to the Control Center app and an agent starts on it; what the agent does goes back to the issue, so nobody copies updates across. The runner checks Linear every `CC_LINEAR_MINUTES` (3).

**Coming in.** A delegated, open issue in a mapped Linear team becomes one ready agent task, with `external_ref` `{source: "linear", id: "ENG-123", url, linear_id}` and the issue's creator as `requested_by`. Its project comes along unless another team already has a project of that name. The repo is left empty for the runner to match or the agent to ask. Edits to the title, description, priority or due date reach the task, though a session already running keeps the brief it started with.

| On the board | On the Linear issue |
| --- | --- |
| Task starts | First `started` status, if it was in backlog or todo. Triage is left to a person |
| Agent's `add_comment`, `update_task` log | Comment |
| `needs_you` (still in the inbox too) | Comment, "Waiting on <owner>" |
| PR link added with `add_links` | Comment, and the review status: the team's setting, else a `started` status with "review" in its name. Never backwards |
| Done | Comment with the summary, delegate removed. The status only moves if the team has a Done status set |
| Handed back to the owner, or cancelled | Comment, delegate removed |

Comments from the owner and reviewers, and the runner's own notes, stay on the board. Updates wait in `linear_outbox` (written by triggers, so any client's changes count), go out in order per task, and are retried for as long as Linear is unreachable; the inbox hears after a few failures.

- **Delegating again** reopens the same task. Removing the delegate when work finishes is what makes that detectable, since an issue left delegated would look the same as one delegated a second time.
- **Taken back** (delegate removed, or the issue closed): a task that hasn't started is cancelled; a running session carries on and the inbox is told once.
- **Assigned issues** (optional, off by default): set a team's "Also show issues assigned to" to an email and that person's open, undelegated issues appear as human tasks on Today. They report nothing back. Ticking one off doesn't touch Linear; one that closes or moves to someone else in Linear is cancelled here.

**Not yet:** replies written on the Linear issue aren't read, so questions are answered on the board. Webhooks for instant pickup and Linear's agent session panel are phase 2.

**Delegating approves work.** A ready agent task starts without further review in a session that runs with permissions skipped, so anyone who can delegate in a mapped Linear team can start one. Map only teams whose members you trust that far. The agent's prompt says the issue's words aren't the owner's instructions beyond the work itself; that's a guardrail, not a sandbox. Everything the agent posts is visible to whoever reads the issue, and its prompt tells it so, but nothing filters what it writes.

### Setting it up

Workspace admin, in Linear:

1. **Settings → API → OAuth applications → New.** Name it `Control Center` (this is the name people delegate to) and give it an icon. Any callback URL will do; client credentials don't use it.
2. **Turn on client credentials tokens.** The sync asks for the scopes `read,write,app:assignable`: `app:assignable` is what lets issues be delegated to it. Leave out `app:mentionable`, since nothing reads mentions yet.
3. **Leave webhooks and "Agent session events" off** for now. Turning that category on shows Linear's session panel, which marks an agent unresponsive if it doesn't answer within 10 seconds; polling can't, so that waits for phase 2.
4. **Check team access** on the app's page. It covers all public teams by default; private teams need adding.
5. **Install it as an app** by opening this once and approving (you can ignore where it redirects to; the sync only uses client credentials), so it's in the delegate menu: `https://linear.app/oauth/authorize?client_id=<id>&redirect_uri=<callback>&response_type=code&scope=read,write,app:assignable&actor=app`

On each runner machine that should sync (no restart needed):

```bash
security add-generic-password -a control-center -s "control-center linear client id" -w
security add-generic-password -a control-center -s "control-center linear client secret" -w
```

Then in the app, under each company's team settings → **Linear**, enter the Linear team keys that belong to it. That's what turns the sync on. Optionally set its review and done statuses.

To test locally: `CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> node --test runner/linear.test.mjs` runs the whole flow against the local database and a fake Linear.

## Reviews (`mcp/src/review.ts`, `runner/bin/cc-publish`)

Agents share outputs as links, not file paths: `cc-publish <file> --title "Cut v2 · 9:16"` uploads to R2 (bucket `control-center-media`, Bearer `UPLOAD_TOKEN`), attaches the link to the task and prints it. Each file gets a private `/r/<token>` page: videos get a frame-accurate player (frame stepping, timeline markers) where Chris and the team leave notes on exact frames (with a still of each), then **Approve** or **Request changes**; images, PDFs and HTML pages open inline (HTML sandboxed). Notes are stored quietly; the decision is posted to the task as one `reviewer` comment listing every note with its timecode, lands in the inbox, and the runner types it into the waiting agent session, which makes the next version or wraps up.

`cc-publish --completes-task` makes approval the end of the task: approving marks the task `done` and posts the decision, which says so only if that worked. Any approved stage waiting on it then starts. Requesting changes works as usual. The runner types any undelivered comment into a done task's session before asking it to clean up, so the session still sees the decision.

## Runner (`runner/`)

Polls every 20s. Only tasks with `kind = agent` **and** `status = ready` are started, so moving a task to ready (directly or via `plan_today`) is the approval step.

- Each task gets a cmux workspace `CC-<id> <title>` running interactive `claude --remote-control "CC-<id> <title>" --dangerously-skip-permissions` (open it from the Claude app on your phone or claude.ai/code), ready only on or after its `scheduled_on` day. The prompt carries the team briefing, project spec and repos; its human-only rules (no posting, messaging, payments as Chris) are the guardrail.
- **Start folder:** the task's `repo` field, else the single repo configured on its project (else team), else the one repo under the team's working folder that the title/description names; the session starts there in its own worktree (`<repo>/.claude/worktrees/cc-<id>`, branch `worktree-cc-<id>`) made from a fresh `git fetch` of the base branch (repo setting, else team default such as `staging`, else the GitHub default), so the main checkout is never switched or pulled. The worktree is recorded in `tasks.worktree`; the agent pushes its branch, opens a PR against the base branch and hands "Review and merge PR #n" to you. With no clear repo the session starts in the team's working folder (else `~/Developer/ControlCenter/tasks/<id>/`).
- Claude asks questions in the window **and** via `ask_human`. Answer in the window, or anywhere on the board (`answer_task`) and the runner types the answer into the live session.
- Window closed mid-task → task moves to `needs_you`; answering resumes the same Claude session (in its worktree).
- **Closing:** when a task is done, the runner types a cleanup request into its session (stop dev servers, remove the worktree if nothing would be lost), then closes the window once `CC_CLOSE_AFTER_MINUTES` (60) have passed and its screen has been still for that long, so a window someone is working in stays open; cancelled closes at once, without cleanup. As a backstop, and for PRs merged after the window closed, every `CC_CLEANUP_MINUTES` (10) the runner removes worktrees of finished tasks, but only when clean and either adding no commits or with a merged PR and nothing unpushed: `git worktree remove`, `git branch -d` (never `-D`), `git worktree prune`, one step at a time. Otherwise it keeps the worktree and logs why on the task.
- **Session hooks** (`runner/hooks/session-state.mjs`, passed with `--settings`): when a session stops or sits waiting for input, an in-progress task moves to `needs_you` with the agent's last message, so it reaches the inbox however the agent asked; typing into the session moves it back to `in_progress`.
- At most 2 tasks run at once.
- **Linear:** picks up delegated issues and reports back on them; see [Linear](#linear-runnerlinearmjs).
- **Self-update:** every `CC_UPDATE_MINUTES` (10) the runner fast-forwards its own checkout to `origin/main`, so a push to `main` reaches every runner machine. It only does so on a clean `main` with nothing unpushed; otherwise it logs why once and leaves the checkout alone. Hook changes apply at once; if `runner/*.mjs` changed, it exits and launchd restarts it on the new code (running sessions are unaffected).

```bash
node runner/runner.mjs --once     # single pass
runner/install.sh                 # launchd agent: start at login, keep alive (logs ~/Developer/ControlCenter/runner.log)
runner/install.sh uninstall
```

New machine: `node runner/clone-repos.mjs` clones every repo on the board into the same folders (the runner's published inventory, minus hidden ones), so agents find the same paths everywhere. `CC_MAX_CONCURRENT=<n>` on `install.sh` sets how many agents run at once.

Requires: cmux, `claude` signed in to the control-center MCP (`/mcp`), service key in Keychain (`control-center service key`). Env overrides: `CC_MAX_CONCURRENT`, `CC_POLL_SECONDS`, `CC_CLOSE_AFTER_MINUTES`, `CC_CLEANUP_MINUTES`, `CC_REPO_SYNC_MINUTES`, `CC_UPDATE_MINUTES`, `CC_LINEAR_MINUTES`. Needs `git` and `gh` (signed in) for worktree cleanup.

## Mac app (`mac/`)

Menu bar app "Control Center Board" (SwiftPM, no Xcode project). Reads the board with the Keychain service key, refreshes every 15s.

- Popover: quick add, **Needs you** (answer inline → runner delivers it), Today (tick off human tasks), Agents, Done today, Inbox
- Board window: Inbox / Ready / Running / Needs you / Done; right-click any task for actions
- **⌃⌥Space** floating quick add · notifications when an agent needs you or hands you a task · "Open" jumps to the task's cmux workspace
- URLs: `controlcenter://board`, `controlcenter://quick-add`, `controlcenter://add?title=…&kind=agent&today=1&ready=1`

```bash
mac/bundle.sh install   # build, copy to /Applications, relaunch
```

## Next

- Move runner to the Mac mini (same code; claim is atomic so laptop + mini can coexist)
- Morning planning routine

## License

MIT, see [LICENSE](LICENSE).

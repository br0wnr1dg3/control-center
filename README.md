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

## Local dev

```bash
supabase start                      # ports 577xx (see supabase/config.toml)
cd mcp && cp .dev.vars.example .dev.vars   # fill from `supabase status -o env`
npm run dev                         # http://localhost:8787
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

## Reviews (`mcp/src/review.ts`, `runner/bin/cc-publish`)

Agents share outputs as links, not file paths: `cc-publish <file> --title "Cut v2 · 9:16"` uploads to R2 (bucket `control-center-media`, Bearer `UPLOAD_TOKEN`), attaches the link to the task and prints it. Each file gets a private `/r/<token>` page: videos get a frame-accurate player (frame stepping, timeline markers) where Chris and the team leave notes on exact frames (with a still of each), then **Approve** or **Request changes**; images, PDFs and HTML pages open inline (HTML sandboxed). Notes are stored quietly; the decision is posted to the task as one `reviewer` comment listing every note with its timecode, lands in the inbox, and the runner types it into the waiting agent session, which makes the next version or wraps up.

## Runner (`runner/`)

Polls every 20s. Only tasks with `kind = agent` **and** `status = ready` are started, so moving a task to ready (directly or via `plan_today`) is the approval step.

- Each task gets a cmux workspace `CC-<id> <title>` running interactive `claude --remote-control "CC-<id> <title>" --dangerously-skip-permissions` (open it from the Claude app on your phone or claude.ai/code), ready only on or after its `scheduled_on` day. The prompt carries the team briefing, project spec and repos; its human-only rules (no posting, messaging, payments as Chris) are the guardrail.
- **Start folder:** the task's `repo` field, else the single repo configured on its project (else team), else the one repo under the team's working folder that the title/description names; the session starts there in its own worktree (`<repo>/.claude/worktrees/cc-<id>`, branch `worktree-cc-<id>`) made from a fresh `git fetch` of the base branch (repo setting, else team default such as `staging`, else the GitHub default), so the main checkout is never switched or pulled. The worktree is recorded in `tasks.worktree`; the agent pushes its branch, opens a PR against the base branch and hands "Review and merge PR #n" to you. With no clear repo the session starts in the team's working folder (else `~/Developer/ControlCenter/tasks/<id>/`).
- Claude asks questions in the window **and** via `ask_human`. Answer in the window, or anywhere on the board (`answer_task`) and the runner types the answer into the live session.
- Window closed mid-task → task moves to `needs_you`; answering resumes the same Claude session (in its worktree).
- **Closing:** a done task's window closes after `CC_CLOSE_AFTER_MINUTES` (5); cancelled closes at once. Every `CC_CLEANUP_MINUTES` (10) the runner removes worktrees of finished tasks, but only when clean and either adding no commits or with a merged PR and nothing unpushed: `git worktree remove`, `git branch -d` (never `-D`), `git worktree prune`, one step at a time. Otherwise it keeps the worktree and logs why on the task.
- **Session hooks** (`runner/hooks/session-state.mjs`, passed with `--settings`): when a session stops or sits waiting for input, an in-progress task moves to `needs_you` with the agent's last message, so it reaches the inbox however the agent asked; typing into the session moves it back to `in_progress`.
- At most 2 tasks run at once.

```bash
node runner/runner.mjs --once     # single pass
runner/install.sh                 # launchd agent: start at login, keep alive (logs ~/Developer/ControlCenter/runner.log)
runner/install.sh uninstall
```

New machine: `node runner/clone-repos.mjs` clones every repo on the board into the same folders (the runner's published inventory, minus hidden ones), so agents find the same paths everywhere. `CC_MAX_CONCURRENT=<n>` on `install.sh` sets how many agents run at once.

Requires: cmux, `claude` signed in to the control-center MCP (`/mcp`), service key in Keychain (`control-center service key`). Env overrides: `CC_MAX_CONCURRENT`, `CC_POLL_SECONDS`, `CC_CLOSE_AFTER_MINUTES`, `CC_CLEANUP_MINUTES`. Needs `git` and `gh` (signed in) for worktree cleanup.

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

# Control Center

A personal task board driven by Claude. Four parts share one Supabase Postgres database; see README.md for what each does.

- `supabase/migrations/`: schema and triggers. Inbox notifications, @agent hand-offs, project/team sync, hand-back and answered-question behaviour all live in triggers, so every client agrees.
- `mcp/`: Cloudflare Worker. MCP tools (`src/tools.ts`, behind passphrase OAuth), email capture (`src/email.ts`, AgentMail + Claude Haiku triage), review links (`src/review.ts`, R2).
- `runner/`: launchd agent that starts each ready agent task as an interactive `claude` session in a cmux workspace (worktree, Remote Control, session hooks), delivers comments, closes finished sessions, cleans merged worktrees and publishes the repo inventory. `hooks/session-state.mjs` keeps the board in step with the terminal; `bin/cc-publish` uploads outputs for review.
- `mac/`: SwiftUI app (SwiftPM, no Xcode project): Inbox, Today, Upcoming, Board, task pages, team settings, menu bar, ⌃⌥Space composer.

## Working on it

Production is deployed from this machine, not from GitHub, and the runner executes this checkout's `runner/` directly. So:

1. Work on a branch or in a worktree. Test locally (below), never against production.
2. Merge to `main`, then deploy from `main`.
3. Push `main`: every runner fast-forwards its own checkout to `origin/main` within 10 minutes and restarts itself if runner code changed. So anything pushed to `main` is live on the runner machines; merge only what you'd deploy. A runner checkout that isn't a clean `main` is left alone (the log says why).

### Local testing

- Database: `supabase start` (ports 577xx; other projects use 543xx/553xx/564xx). `supabase db reset --local` rebuilds from migrations; load the owner's teams with `docker exec -i supabase_db_control-center psql -U postgres < supabase/seed.local.sql` (psql isn't installed on the host).
- Worker: `cd mcp && npx wrangler dev --port 8787` (reads `.dev.vars`: local Supabase URL and demo service key). Smoke test: `node scripts/smoke.mjs` (local) or `node scripts/smoke.mjs <prod url> <passphrase>`; it leaves `source=smoke` rows to delete afterwards. Team-writing checks only run locally; set `CC_UPLOAD_TOKEN` (`UPLOAD_TOKEN` in `.dev.vars`) to also check reviews that complete their task.
- App: `cd mac && swift build`, then `CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> .build/debug/ControlCenterBoard`. `CC_SECTION=inbox|upcoming|board|team:<id>`, `CC_SELECT=<task id>` and `CC_COMPOSE=1` open a specific view for screenshots. Capture only the app window (`screencapture -l <window id>`), never the whole screen.
- Runner pieces: `runner.mjs` only starts its loop when run directly, so tests can `import { workRepo, cleanupWorktree, syncRepos, ... }`. Don't run the real runner against local data with ready agent tasks in it: it opens real Claude sessions.

### Deploying (from `main`)

- Migrations: `SUPABASE_DB_PASSWORD=$(security find-generic-password -s "supabase-db control-center" -w) supabase db push`
- Worker: `cd mcp && npx wrangler deploy`. Secrets via `wrangler secret put` (a var and a secret can't share a name).
- Runner: updates itself from `origin/main` (above); to restart it now, `launchctl kickstart -k gui/$(id -u)/com.brownridge.control-center.runner` (reinstall with `CC_OWNER_NAME=… CC_MAX_CONCURRENT=… runner/install.sh` if its env changes). Log: `~/Developer/ControlCenter/runner.log`.
- App: `cd mac && ./bundle.sh install` (rebuilds, installs to /Applications, relaunches).

## Conventions

- Secrets live in the macOS Keychain (account `control-center`) and Worker secrets; never in files, commits or chat. Read them with `security find-generic-password -w` piped straight to where they're needed.
- The repo is public. Personal data (teams, GitHub orgs, folders, branches, email addresses) stays out of it: use `supabase/seed.local.sql` (git-ignored) or the app's settings. The owner's name comes from `OWNER_NAME` / `CC_OWNER_NAME`.
- Agents run with `--dangerously-skip-permissions` (the owner's explicit choice). Guardrails are in the runner prompt: human-only actions become `add_human_task`, PRs are never merged unless asked, outputs are shared with `cc-publish`.
- Statuses: `new` = untriaged, `ready` = approved (agent tasks run on their `scheduled_on` day), `needs_you` = an agent is blocked on the owner, `done`/`cancelled`. A finished agent hands remaining human steps back with kind `human`, status `ready`.
- Stages: `task_dependencies` triggers move a `new` task to `ready` when all its blockers are `done`, or to `needs_you` when one is cancelled (see README). They never touch any other status.
- Worktrees are created by the runner from a fresh `origin/<base branch>` (repo setting → team default → GitHub default) at `<repo>/.claude/worktrees/cc-<id>`; cleanup only removes them when merged and nothing would be lost (`branch -d`, never `-D`).
- Code style: match the file you're in; comments explain why, not what. Swift uses `@Observable` `BoardStore.shared`; API calls go through `BoardAPI` (PostgREST). The Worker uses `@supabase/supabase-js` and zod schemas for tools.

## Gotchas we've hit

- cmux must be in socket **Password** mode or launchd can't open workspaces ("Failed to write to socket").
- Claude's folder-trust prompt swallows the first prompt: task folders live under `~/Developer`, which is trusted once.
- `claude --allowedTools` is variadic and eats a following positional prompt; the prompt goes first in `run.sh`.
- Session hooks read the hook script from this checkout each time, so hook edits apply to running sessions immediately; prompt and settings changes only apply to new sessions.
- AgentMail's `extracted_text` includes Gmail forwards; `email.ts` cuts the owner's own note itself before honouring `@agent`.
- PostgREST: duplicate `or=` params AND together; embedded filters use `table.column` (e.g. `local_repos.hidden`).
- Supabase local DB clock is UTC; day-based views use the owner's timezone, so "today" can differ in local tests.

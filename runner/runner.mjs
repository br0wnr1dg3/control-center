#!/usr/bin/env node
// Control Center runner: picks up ready agent tasks and runs each in its own cmux workspace
// with an interactive Claude session. Answers given on the board are typed into the live
// session, or the session is resumed if its window was closed. Tasks with a repo get their
// own git worktree; finished sessions are closed and merged worktrees removed.
//
//   node runner.mjs          run forever (launchd)
//   node runner.mjs --once   one pass, then exit

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const CONFIG = {
  supabaseUrl: process.env.CC_SUPABASE_URL ?? "https://lkjjphjscavzibalgqhh.supabase.co",
  maxConcurrent: Number(process.env.CC_MAX_CONCURRENT ?? 2),
  pollSeconds: Number(process.env.CC_POLL_SECONDS ?? 20),
  home: process.env.CC_HOME ?? join(homedir(), "Developer", "ControlCenter"),
  cmux: process.env.CC_CMUX ?? "/Applications/cmux.app/Contents/Resources/bin/cmux",
  // Minutes a finished session's window stays open so you can read the end of it.
  closeAfterMinutes: Number(process.env.CC_CLOSE_AFTER_MINUTES ?? 5),
  cleanupEveryMinutes: Number(process.env.CC_CLEANUP_MINUTES ?? 10),
  repoSyncMinutes: Number(process.env.CC_REPO_SYNC_MINUTES ?? 10),
};
const TASKS_DIR = join(CONFIG.home, "tasks");
// Whose board this is, as agent prompts name them (CC_OWNER_NAME; neutral when unset).
const OWNER = process.env.CC_OWNER_NAME || "the owner";
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "hooks", "session-state.mjs");

// Session hooks that keep the board in step with the terminal: a session waiting on the owner shows up
// as needs_you in the inbox however the agent asked, and typing into it moves the task back.
function sessionSettings(taskId) {
  const hook = (mode) => [{ hooks: [{ type: "command", command: `node ${JSON.stringify(HOOK)} ${mode} ${taskId}`, timeout: 30 }] }];
  return { hooks: { Stop: hook("waiting"), Notification: hook("waiting"), UserPromptSubmit: hook("resumed") } };
}

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------- Supabase (PostgREST) ----------

let serviceKey;
export const useServiceKey = (key) => (serviceKey = key);

async function db(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: prefer ?? "return=representation",
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

const patchTask = (id, fields, where = "") => db(`tasks?id=eq.${id}${where}`, { method: "PATCH", body: fields });

const addEvent = (task_id, kind, body) =>
  db("task_events", { method: "POST", body: { task_id, kind, body, actor: "runner" }, prefer: "return=minimal" });

// ---------- cmux ----------

async function cmux(...args) {
  const { stdout } = await run(CONFIG.cmux, args);
  return stdout.trim();
}

const workspaceTitle = (task) => `CC-${task.id} ${task.title}`.slice(0, 60);

// Map task id -> workspace ref, by the "CC-<id> " title prefix.
async function taskWorkspaces() {
  const map = new Map();
  for (const line of (await cmux("list-workspaces")).split("\n")) {
    const m = line.match(/(workspace:\d+)\s+CC-(\d+)\s/);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map;
}

async function typeInto(workspace, text) {
  await cmux("send", "--workspace", workspace, "--", text.replace(/\s*\n\s*/g, " ").replace(/\\/g, "\\\\"));
  await cmux("send-key", "--workspace", workspace, "enter");
}

const localDay = () => new Date().toLocaleDateString("en-CA");

// the owner's comments the live session hasn't seen yet (answers are comments too).
// the owner's comments and review decisions (from them or the team) the live session hasn't seen yet.
const undeliveredComments = (taskId) =>
  db(
    `task_comments?task_id=eq.${taskId}&author=in.(me,reviewer)&delivered_at=is.null&order=created_at&select=id,author,author_name,body`,
  );

async function markDelivered(comments) {
  if (!comments.length) return;
  await db(`task_comments?id=in.(${comments.map((c) => c.id).join(",")})`, {
    method: "PATCH",
    body: { delivered_at: new Date().toISOString() },
    prefer: "return=minimal",
  });
}

const formatComments = (comments) =>
  comments
    .map((c) => (c.author === "reviewer" ? `Review from ${c.author_name ?? "the team"}: ${c.body}` : `${OWNER} on the board: ${c.body}`))
    .join(" | ");

// ---------- Prompt + launch ----------

const PRIORITY = ["", "Urgent", "High", "Medium", "Low"];

const expandHome = (p) => p.replace(/^~(?=\/|$)/, homedir());

// Git repos directly under a team's working folder (~/Developer/projects/<team>/<repo>).
export function discoverRepos(team) {
  if (!team?.workdir) return [];
  const root = expandHome(team.workdir);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, ".git")))
      .map((d) => ({ name: d.name, path: join(root, d.name) }));
  } catch {
    return [];
  }
}

const isRepo = (r) => Boolean(r?.path && existsSync(join(r.path, ".git")));
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The repo a task's session starts in, decided before launch so the repo's CLAUDE.md and settings
// load and the session gets its own worktree: the task's Repo field, else the single configured
// project (or team) repo, else the one known repo the task names. Null when it isn't clear.
export function workRepo(task, team, project, synced = []) {
  const configured = [...(project?.repos ?? []), ...(team?.repos ?? [])]
    .filter((r) => r.path)
    .map((r) => ({ ...r, path: expandHome(r.path) }));
  const hidden = new Set(synced.filter((r) => r.hidden).map((r) => expandHome(r.path)));
  const found = discoverRepos(team)
    .filter((d) => !hidden.has(d.path))
    .map((d) => ({ ...d, aliases: synced.find((r) => expandHome(r.path) === d.path)?.aliases ?? [] }));
  const known = [...configured, ...found.filter((d) => !configured.some((c) => c.path === d.path))];

  if (task.repo) {
    const ref = task.repo.trim();
    if (/^[~/]/.test(ref)) {
      const path = expandHome(ref);
      return isRepo({ path }) ? { name: basename(path), path } : null;
    }
    const lower = ref.toLowerCase();
    const hit = known.find((r) => r.name.toLowerCase() === lower || r.aliases?.some((a) => a.toLowerCase() === lower));
    return isRepo(hit) ? hit : null;
  }

  const scoped = (project?.repos?.length ? project.repos : team?.repos ?? []).filter((r) => r.path);
  if (scoped.length === 1) {
    const only = { ...scoped[0], path: expandHome(scoped[0].path) };
    if (isRepo(only)) return only;
  }

  const text = `${task.title}\n${task.description ?? ""}`;
  const mentions = (term) => new RegExp(`(?<![\\w-])${escapeRe(term)}(?![\\w-])`, "i").test(text);
  const named = known.filter((r) => [r.name, ...(r.aliases ?? [])].some(mentions));
  return named.length === 1 && isRepo(named[0]) ? named[0] : null;
}

const worktreeName = (task) => `cc-${task.id}`;

// The branch work starts from and PRs target: the repo's setting, else the team default, if it exists
// on GitHub; otherwise the repo's GitHub default branch.
export async function baseBranch(repoPath, preferred) {
  for (const branch of preferred.filter(Boolean)) {
    if ((await tryGit(repoPath, "ls-remote", "--exit-code", "--heads", "origin", branch)) !== null) return branch;
  }
  const head = await tryGit(repoPath, "ls-remote", "--symref", "origin", "HEAD");
  return head?.match(/ref: refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? (await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD"));
}

// A worktree for this task from the latest origin/<base>. The main checkout is never switched or
// pulled, so whatever the owner (or another session) has open there is untouched.
export async function createWorktree(repo, task, base) {
  const path = join(repo.path, ".claude", "worktrees", worktreeName(task));
  const branch = `worktree-${worktreeName(task)}`;
  await git(repo.path, "fetch", "--quiet", "origin", base);
  // Keep nested worktrees out of the main checkout's git status.
  const exclude = join(repo.path, ".git", "info", "exclude");
  try {
    if (statSync(join(repo.path, ".git")).isDirectory() && !readFileSync(exclude, "utf8").includes(".claude/worktrees")) {
      appendFileSync(exclude, "\n.claude/worktrees/\n");
    }
  } catch {}
  const exists = await tryGit(repo.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  if (exists) await git(repo.path, "worktree", "add", path, branch);
  // --no-track: the branch pushes to its own name, not to the base it started from.
  else await git(repo.path, "worktree", "add", "--no-track", "-b", branch, path, `origin/${base}`);
  return path;
}

const formatRepos = (repos) =>
  repos.map((r) => `- ${r.name}${r.url ? ` (${r.url})` : ""}${r.path ? ` checked out at ${r.path}` : ""}`).join("\n");

function taskPrompt(task, sessionId, dir, comments, activity, team, project, repo, folder) {
  const id = task.id;
  const repos = [...(project?.repos ?? []), ...(team?.repos ?? [])];
  const meta = [
    team && `Team: ${team.name}`,
    task.project && `Project: ${task.project}`,
    task.priority && `Priority: ${PRIORITY[task.priority]}`,
    task.labels?.length && `Labels: ${task.labels.join(", ")}`,
    task.scheduled_on && `Scheduled: ${task.scheduled_on}`,
    task.due && `Due: ${task.due}`,
  ].filter(Boolean);
  const lines = [
    `You are working on Control Center task CC-${id}: ${task.title}`,
    meta.length && meta.join(" · "),
    team?.context && `\nAbout ${team.name} (read first):\n${team.context}`,
    project?.description && `\nProject ${project.name}:\n${project.description}`,
    repos.length && `\nRepositories:\n${formatRepos(repos)}`,
    team?.workdir && `\n${team.name}'s working folder: ${team.workdir} (one folder per repo)`,
    team?.github && `${team.name}'s GitHub: ${team.github}`,
    task.description && `\nTask description:\n${task.description}`,
    task.links?.length && `\nLinks:\n${task.links.map((l) => `- ${l.title}: ${l.url}`).join("\n")}`,
    comments.length && `\nComments:\n${comments.map((c) => `- ${c.author}: ${c.body}`).join("\n")}`,
    activity.length && `\nActivity:\n${activity.map((e) => `- [${e.kind}] ${e.body}`).join("\n")}`,
    `
How to work:
- Your session id is ${sessionId}. ${
      repo
        ? `You are in your own git worktree of ${repo.name}, on branch worktree-${worktreeName(task)}, started from the latest origin/${repo.base}; other sessions use other worktrees, so stay in it. Save notes and drafts that aren't code in ${dir}.`
        : folder
          ? `You are in ${team.name}'s working folder ${folder.path}${folder.repos.length ? `, which holds these repos:\n${folder.repos.map((r) => `  - ${r.name}${r.description ? `: ${r.description}` : ""}`).join("\n")}\n` : ""}. Save notes and drafts in ${dir}. If you change code in a repo, don't edit its main checkout (other work may be using it): make a worktree with \`git -C <repo> worktree add .claude/worktrees/${worktreeName(task)} -b worktree-${worktreeName(task)}\`, work there, and record it with update_task(id=${id}, worktree="<full path>") so the runner can clean it up. If it's clear which repo this task is about, also set update_task(id=${id}, repo="<name>") so future sessions start in it.`
          : `Your working directory is ${dir}; save drafts and outputs here.`
    } Attach important outputs with update_task(id=${id}, add_links=[{title, url: "file://..."}]).${
      repo
        ? `
- Code changes: commit to this branch, push it with \`git push -u origin HEAD\`, open a PR against ${repo.base} (\`gh pr create --base ${repo.base}\`), attach the PR with add_links, then hand review to ${OWNER} with add_human_task(parent_id=${id}, title="Review and merge PR #<n>: ..."). Never merge it yourself unless ${OWNER} explicitly asks you to in this task. The runner removes this worktree once the PR is merged.`
        : ""
    }
- Use the control-center MCP tools. Write comments and hand-off instructions in Markdown. Log progress with update_task(id=${id}, log=...). Post anything ${OWNER} should read (a draft, a finding, a decision you made) with add_comment(id=${id}, body, author="agent"); it lands in his inbox.
- If you need a decision or information from ${OWNER}: call ask_human(id=${id}, question, session_id="${sessionId}"), then ask the same question here and wait. He may answer here, or on the board, in which case it's typed in here as "${OWNER} on the board: ...". Once answered, call update_task(id=${id}, status="in_progress").
- ${OWNER} may also comment while you work; those arrive here the same way. Treat them as instructions. If this task was handed to you with an @agent comment, that latest comment is your brief: do what it asks, using the description and history for context.
- Anything only a human can or should do (posting publicly, sending messages or email as ${OWNER}, payments, calls, logging into accounts, physical errands): prepare everything, then call add_human_task(parent_id=${id}, ...) with exact instructions and any drafts. Do not do those yourself unless the description explicitly says to.
- If you've done your part but the rest of this task is ${OWNER}'s (decisions, posting, steps they have to do), hand it back instead of completing it: update_task(id=${id}, kind="human", status="ready", log="<what you did; what's left for ${OWNER}>"). For a separate human step on a task you are finishing, use add_human_task. Never set status "new".
- Share outputs as links, not file paths: \`cc-publish <file> --title "<what it is, e.g. Cut v2 · 9:16>"\` uploads it, attaches it to this task and prints a link. Videos get a review page where ${OWNER} and the team comment on exact frames; images, PDFs and HTML pages open inline.
- When a video or other output needs sign-off (a cut, a design, a page), publish it, say what changed and give the link, then stop and wait. ${OWNER} or the team review it and their decision arrives here as "Review from <name>: Approved ..." or "Changes requested ..." with timecoded notes (and a still of each frame you can open). For changes, make the next version, publish it with the next version number, and wait again. Once approved, finish up.
- When finished, call complete_task(id=${id}, summary=...) with what you did and where outputs are. The runner closes this window a few minutes later; the session can be resumed from the board if needed.
- Only work on this task.`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function launch(task, { resume = false } = {}) {
  const dir = join(TASKS_DIR, String(task.id));
  await mkdir(dir, { recursive: true });

  const [[team], [project]] = await Promise.all([
    task.team_id ? db(`teams?id=eq.${task.team_id}&select=name,context,repos,workdir,github,base_branch`) : [],
    task.project ? db(`projects?name=ilike.${encodeURIComponent(task.project)}&select=name,description,repos`) : [],
  ]);
  const synced = task.team_id
    ? await db(`repos?team_id=eq.${task.team_id}&select=name,path,description,aliases,base_branch,hidden&order=name`)
    : [];
  let repo = workRepo(task, team, project, synced);
  if (repo && !task.repo) await patchTask(task.id, { repo: repo.name }); // show the match on the board
  // An existing worktree (resume, or a relaunch) is entered directly; otherwise one is made from the
  // freshly fetched base branch.
  const existing = task.worktree && existsSync(task.worktree) ? task.worktree : null;
  let worktree = existing;
  if (!existing && repo) {
    const setting = synced.find((r) => expandHome(r.path) === repo.path)?.base_branch;
    try {
      repo = { ...repo, base: await baseBranch(repo.path, [setting, team?.base_branch]) };
      worktree = await createWorktree(repo, task, repo.base);
    } catch (err) {
      log(`CC-${task.id}: couldn't make a worktree in ${repo.path}: ${err.message}`);
      await addEvent(task.id, "note", `runner couldn't create a worktree in ${repo.name}; started in the team folder instead`);
      repo = null;
    }
  }
  // No clear repo: start in the team's folder (still loads its context) rather than the task folder.
  const teamDir = team?.workdir && existsSync(expandHome(team.workdir)) ? expandHome(team.workdir) : null;
  const visible = synced.filter((r) => !r.hidden);
  const folder = !repo && teamDir ? { path: teamDir, repos: synced.length ? visible : discoverRepos(team) } : null;
  let cwd = worktree ?? teamDir ?? dir;
  const worktreeArgs = "";

  let sessionId = task.session_id;
  let claudeArgs;
  if (resume && sessionId) {
    const pending = await undeliveredComments(task.id);
    await writeFile(join(dir, "prompt.md"), pending.length ? formatComments(pending) : "Continue the task from where you left off.");
    await markDelivered(pending);
    claudeArgs = `--resume ${sessionId}`;
    cwd = existing ?? teamDir ?? dir;
  } else {
    sessionId = randomUUID();
    const [comments, activity] = await Promise.all([
      db(`task_comments?task_id=eq.${task.id}&order=created_at&select=id,author,body`),
      db(`task_events?task_id=eq.${task.id}&order=created_at&select=kind,body`),
    ]);
    await writeFile(join(dir, "prompt.md"), taskPrompt(task, sessionId, dir, comments, activity, team, project, worktree && repo, folder));
    await markDelivered(comments.filter((c) => c.author === "me" || c.author === "reviewer"));
    claudeArgs = `--session-id ${sessionId}`;
  }

  const settings = join(dir, "settings.json");
  await writeFile(settings, JSON.stringify(sessionSettings(task.id), null, 2));

  const script = join(dir, "run.sh");
  await writeFile(
    script,
    `#!/bin/zsh -l
cd ${JSON.stringify(cwd)}
export CC_TASK_ID=${task.id}
export PATH=${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "bin"))}:$PATH
exec claude "$(cat ${JSON.stringify(join(dir, "prompt.md"))})" ${claudeArgs}${worktreeArgs} --name ${JSON.stringify(workspaceTitle(task))} \\
  --remote-control ${JSON.stringify(workspaceTitle(task))} --settings ${JSON.stringify(settings)} \\
  --dangerously-skip-permissions
`,
  );
  await chmod(script, 0o755);

  await patchTask(task.id, { status: "in_progress", session_id: sessionId, worktree });
  const created = await cmux("new-workspace", "--cwd", cwd, "--command", script);
  const workspace = created.match(/workspace:\d+/)?.[0];
  if (!workspace) throw new Error(`cmux new-workspace: ${created}`);
  await cmux("rename-workspace", "--workspace", workspace, workspaceTitle(task));
  await addEvent(task.id, "status", `${resume ? "runner resumed session" : `runner started session ${sessionId}`}${worktree ? ` in worktree ${worktree}` : ""}`);
  log(`${resume ? "resumed" : "started"} CC-${task.id} in ${workspace}${worktree ? ` (${worktree})` : ""}`);
}

// ---------- Closing finished work ----------

const minutesSince = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;

// Close the windows of sessions whose task is finished or no longer the agent's: cancelled at once,
// the rest after a short grace period.
async function closeFinished(workspaces, activeIds) {
  const ids = [...workspaces.keys()].filter((id) => !activeIds.has(id));
  if (!ids.length) return;
  // Finished, or no longer the agent's (handed back to the owner, or moved back to new).
  const tasks = await db(
    `tasks?id=in.(${ids.join(",")})&or=(status.in.(done,cancelled,new),kind.neq.agent)&select=id,status,completed_at,updated_at`,
  );
  for (const task of tasks) {
    const since = task.completed_at ?? task.updated_at;
    if (task.status !== "cancelled" && minutesSince(since) < CONFIG.closeAfterMinutes) continue;
    await cmux("close-workspace", "--workspace", workspaces.get(task.id));
    await addEvent(task.id, "status", "runner closed the session window");
    log(`closed CC-${task.id} (${task.status})`);
  }
}

async function git(cwd, ...args) {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

const tryGit = (cwd, ...args) => git(cwd, ...args).catch(() => null);

// Remove a finished task's worktree only when nothing would be lost: no uncommitted changes, and the
// branch either adds nothing or its PR is merged with everything pushed. One step at a time, `branch -d`
// (never -D), so git refuses anything unmerged. Otherwise leave it and say why, once.
export async function cleanupWorktree(task) {
  const wt = task.worktree;
  if (!existsSync(wt)) {
    await patchTask(task.id, { worktree: null });
    return;
  }
  const repo = wt.split("/.claude/worktrees/")[0];
  const keep = async (reason) => {
    const body = `worktree kept: ${reason} (${wt})`;
    const seen = await db(`task_events?task_id=eq.${task.id}&kind=eq.note&body=eq.${encodeURIComponent(body)}&select=id`);
    if (!seen.length) await addEvent(task.id, "note", body);
  };

  if (await git(wt, "status", "--porcelain")) return keep("uncommitted changes");
  const branch = await git(wt, "rev-parse", "--abbrev-ref", "HEAD");
  await tryGit(repo, "fetch", "--quiet", "origin");
  const [row] = await db(`repos?path=eq.${encodeURIComponent(repo.replace(homedir(), "~"))}&select=base_branch,team_id`);
  const [team] = row ? await db(`teams?id=eq.${row.team_id}&select=base_branch`) : [];
  const base = `origin/${await baseBranch(repo, [row?.base_branch, team?.base_branch])}`;
  const ahead = Number(await git(repo, "rev-list", "--count", `${base}..${branch}`));

  if (ahead > 0) {
    const unpushed = await tryGit(wt, "rev-list", "--count", "@{u}..HEAD");
    if (unpushed === null) return keep(`${ahead} commit(s) on ${branch} were never pushed`);
    if (Number(unpushed) > 0) return keep(`${unpushed} unpushed commit(s) on ${branch}`);
    const pr = await run("gh", ["pr", "view", branch, "--json", "state,number", "-q", ".state + \" #\" + (.number|tostring)"], { cwd: repo })
      .then((r) => r.stdout.trim())
      .catch(() => "");
    if (!pr.startsWith("MERGED")) return keep(pr ? `PR ${pr.split(" ")[1]} is ${pr.split(" ")[0].toLowerCase()}` : `no PR found for ${branch}`);
  }

  await git(repo, "worktree", "remove", wt);
  const deleted = await tryGit(repo, "branch", "-d", branch);
  await tryGit(repo, "worktree", "prune");
  await patchTask(task.id, { worktree: null });
  await addEvent(
    task.id,
    "note",
    `runner removed worktree ${wt}${deleted === null ? `; kept branch ${branch} because git branch -d refused (e.g. squash-merged), delete it yourself if you're sure` : ` and branch ${branch}`}`,
  );
  log(`cleaned up worktree for CC-${task.id}`);
}

// ---------- Repo inventory ----------

// Template text that says nothing about the repo.
const BOILERPLATE = /bootstrapped with|create-next-app|create-react-app|this template|getting started|^welcome to|^first, run|development server|^to get started|^install|localhost:\d+/i;
const plainText = (line) => line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();

// One line about a repo, from package.json or the first real prose line of its README.
function describeRepo(path) {
  try {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    if (pkg.description?.trim() && !BOILERPLATE.test(pkg.description)) return plainText(pkg.description).slice(0, 200);
  } catch {}
  for (const name of ["README.md", "readme.md", "README"]) {
    try {
      let inCode = false;
      for (const raw of readFileSync(join(path, name), "utf8").split("\n")) {
        const line = raw.trim();
        if (line.startsWith("```")) inCode = !inCode;
        if (inCode || !line || /^(#|!\[|<|\[!|```|---|\||>|\$)/.test(line) || BOILERPLATE.test(line)) continue;
        const text = plainText(line);
        if (text.split(/\s+/).length >= 5) return text.slice(0, 200); // a sentence, not a command or badge
      }
    } catch {}
  }
  return null;
}

const githubUrl = (remote) => remote?.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "") ?? null;

let lastRepoSync = 0;

// Publish the git repos under each team's working folder so the connector and email triage can
// set a task's repo when it's created. Aliases (edited in the app) are left alone.
export async function syncRepos() {
  if (Date.now() - lastRepoSync < CONFIG.repoSyncMinutes * 60000) return;
  lastRepoSync = Date.now();
  const started = new Date().toISOString();
  const teams = await db("teams?workdir=not.is.null&select=id,name,workdir");
  for (const team of teams) {
    const rows = [];
    for (const repo of discoverRepos(team)) {
      const remote = await tryGit(repo.path, "remote", "get-url", "origin");
      rows.push({
        team_id: team.id,
        name: repo.name,
        path: repo.path.replace(homedir(), "~"),
        github_url: githubUrl(remote),
        description: describeRepo(repo.path),
        seen_at: started,
      });
    }
    // An empty scan is more likely an unreadable folder than no repos; keep what's there (and its aliases).
    if (!rows.length) continue;
    await db("repos?on_conflict=path", { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
    // Folders that are gone (deleted or moved) drop out.
    await db(`repos?team_id=eq.${team.id}&seen_at=lt.${encodeURIComponent(started)}`, { method: "DELETE", prefer: "return=minimal" });
  }
}

let lastCleanup = 0;

async function cleanupWorktrees(workspaces) {
  if (Date.now() - lastCleanup < CONFIG.cleanupEveryMinutes * 60000) return;
  lastCleanup = Date.now();
  const tasks = await db("tasks?worktree=not.is.null&status=in.(done,cancelled)&select=id,worktree");
  for (const task of tasks) {
    if (workspaces.has(task.id)) continue; // window still open
    try {
      await cleanupWorktree(task);
    } catch (err) {
      log(`cleanup CC-${task.id}:`, err.message);
    }
  }
}

// ---------- Main loop ----------

async function tick() {
  const tasks = await db("tasks?kind=eq.agent&status=in.(ready,in_progress,needs_you)&select=*&order=sort_order,id");
  // priority 0 means none, so sort urgent (1) .. low (4) first and none last.
  tasks.sort((a, b) => (a.priority || 5) - (b.priority || 5));
  const workspaces = await taskWorkspaces();
  await closeFinished(workspaces, new Set(tasks.map((t) => t.id))).catch((err) => log("close:", err.message));
  await cleanupWorktrees(workspaces).catch((err) => log("cleanup:", err.message));
  await syncRepos().catch((err) => log("repo sync:", err.message));
  let running = tasks.filter((t) => t.status === "in_progress" && workspaces.has(t.id)).length;

  for (const task of tasks) {
    const ws = workspaces.get(task.id);
    try {
      // Waiting on the owner: a comment from them in a live session counts as their reply.
      if (task.status === "needs_you") {
        if (!ws) continue;
        const pending = await undeliveredComments(task.id);
        if (!pending.length) continue;
        await typeInto(ws, formatComments(pending));
        await markDelivered(pending);
        await patchTask(task.id, { status: "in_progress", question: null }, "&status=eq.needs_you");
        log(`delivered ${pending.length} comment(s) to waiting CC-${task.id}`);
        continue;
      }
      if (task.status === "in_progress") {
        if (ws) {
          const pending = await undeliveredComments(task.id);
          if (pending.length) {
            await typeInto(ws, formatComments(pending));
            await markDelivered(pending);
            log(`delivered ${pending.length} comment(s) to CC-${task.id}`);
          }
        } else if (task.session_id) {
          // Runner-owned session whose window is gone: park it for the owner instead of looping.
          const question = "The session window closed before the task finished. Answer to resume it (add any guidance).";
          await patchTask(task.id, { status: "needs_you", question }, "&status=eq.in_progress");
          await addEvent(task.id, "question", question);
        }
        continue;
      }

      // status === "ready": answered (live or closed session), or new work.
      if (ws && task.session_id) {
        const pending = await undeliveredComments(task.id);
        await typeInto(ws, pending.length ? formatComments(pending) : `${OWNER} marked this ready on the board; continue.`);
        await markDelivered(pending);
        await patchTask(task.id, { status: "in_progress" });
        log(`delivered answer to CC-${task.id}`);
      } else if (task.scheduled_on && task.scheduled_on > localDay()) {
        continue; // scheduled for a later day
      } else if (running < CONFIG.maxConcurrent) {
        // Claim atomically so two runners (laptop + mini) never start the same task.
        const [claimed] = await patchTask(task.id, { status: "in_progress" }, "&status=eq.ready");
        if (!claimed) continue;
        await launch(task, { resume: Boolean(task.session_id) });
        running++;
      }
    } catch (err) {
      log(`task CC-${task.id}:`, err.message);
    }
  }
}

async function main() {
  serviceKey =
    process.env.CC_SERVICE_KEY ??
    (await run("security", ["find-generic-password", "-a", "control-center", "-s", "control-center service key", "-w"]))
      .stdout.trim();
  await mkdir(TASKS_DIR, { recursive: true });

  const once = process.argv.includes("--once");
  log(`runner up (max ${CONFIG.maxConcurrent}, every ${CONFIG.pollSeconds}s${once ? ", once" : ""})`);
  do {
    try {
      await tick();
    } catch (err) {
      log("tick failed:", err.message);
    }
    if (!once) await new Promise((r) => setTimeout(r, CONFIG.pollSeconds * 1000));
  } while (!once);
}

// Run only when started directly, so tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

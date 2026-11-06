// Linear sync: issues delegated to Control Center become agent tasks, and what happens to those tasks goes
// back to the issue as comments and status changes. A delegation only approves the work if it was made by
// one of the team's approvers; anyone else's waits as new for the owner.
//
// In: every CC_LINEAR_MINUTES the runner lists what's delegated to the app and hands each issue to
// linear_upsert_issue in Postgres, which keeps it to one task per issue. Out: triggers put updates in
// linear_outbox whichever client caused them, and every tick the runner posts them, in order per task.
//
// A finished task takes the delegate off its issue. That's what makes delegating it again mean something:
// otherwise an issue still delegated after its work finished looks the same as one delegated a second time.
//
// Off until a team has Linear teams set in its settings and this machine has the app's credentials
// (see README).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const API = process.env.CC_LINEAR_API ?? "https://api.linear.app";
const POLL_MINUTES = Number(process.env.CC_LINEAR_MINUTES ?? 3);
const NOTIFY_AFTER_ATTEMPTS = 6;
// The app's token grants this. No app:mentionable: a mention would open a conversation nothing here reads.
const SCOPES = "read,write,app:assignable";

// ---------- GraphQL ----------

const keychain = (service) =>
  run("security", ["find-generic-password", "-a", "control-center", "-s", service, "-w"])
    .then((r) => r.stdout.trim())
    .catch(() => null);

let token = process.env.CC_LINEAR_TOKEN ?? null;

// Client credentials: no refresh tokens, and a new token is always one request away. Null when this
// machine isn't set up for Linear.
async function mintToken() {
  const [id, secret] = await Promise.all([keychain("control-center linear client id"), keychain("control-center linear client secret")]);
  if (!id || !secret) return null;
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES, client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Linear token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function hasCredentials() {
  token ??= await mintToken();
  return Boolean(token);
}

async function linear(query, variables = {}, retried = false) {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && !retried && !process.env.CC_LINEAR_TOKEN) {
    token = await mintToken(); // they last 30 days
    return linear(query, variables, true);
  }
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Linear: ${res.status} ${text.slice(0, 200)}`);
  }
  if (payload.errors?.length) throw new Error(`Linear: ${payload.errors.map((e) => e.message).join("; ")}`);
  if (!res.ok) throw new Error(`Linear: ${res.status} ${text.slice(0, 200)}`);
  return payload.data;
}

export const ISSUES_QUERY = `query Issues($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 50, after: $after) {
    nodes {
      id identifier url title description priority dueDate
      team { key }
      project { name }
      labels { nodes { name } }
      creator { name email }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Only asked when a delegation decides something, so not on every poll for every issue. Linear doesn't
// document which way history comes back, hence every page and the latest by date.
export const DELEGATION_QUERY = `query Delegation($id: String!, $after: String) {
  viewer { id }
  issue(id: $id) {
    history(first: 50, after: $after) {
      nodes { createdAt toDelegate { id } actor { name email } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const ISSUE_QUERY = `query Issue($id: String!) {
  viewer { id }
  issue(id: $id) {
    state { id type position }
    delegate { id }
    team { states(first: 100) { nodes { id name type position } } }
  }
}`;

export const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

async function listIssues(filter) {
  const issues = [];
  let after = null;
  do {
    const { issues: page } = await linear(ISSUES_QUERY, { filter, after });
    issues.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

// ---------- In: issues to tasks ----------

const issuePayload = (issue) => ({
  linear_id: issue.id,
  id: issue.identifier,
  url: issue.url,
  title: issue.title,
  description: issue.description ?? null,
  priority: issue.priority ?? 0,
  due: issue.dueDate ?? null,
  labels: (issue.labels?.nodes ?? []).map((l) => l.name.toLowerCase()),
  project: issue.project?.name ?? null,
  requested_by: issue.creator ? { name: issue.creator.name, email: issue.creator.email } : null,
});

const upsert = (db, team, issue, mirror, approved = false, delegatedBy = null) =>
  db("rpc/linear_upsert_issue", {
    method: "POST",
    body: { p_team: team, p_issue: issuePayload(issue), p_mirror: mirror, p_approved: approved, p_delegated_by: delegatedBy },
  });

// Who last delegated this issue to the app. Null if Linear doesn't say, as for an automation or integration.
export async function delegatedBy(issueId) {
  let latest = null;
  let after = null;
  do {
    const { viewer, issue } = await linear(DELEGATION_QUERY, { id: issueId, after });
    for (const change of issue.history.nodes) {
      if (change.toDelegate?.id !== viewer.id) continue;
      if (!latest || change.createdAt > latest.createdAt) latest = change;
    }
    after = issue.history.pageInfo.hasNextPage ? issue.history.pageInfo.endCursor : null;
  } while (after);
  return latest?.actor ?? null;
}

export function isApprover(team, actor) {
  const email = actor?.email?.trim().toLowerCase();
  return Boolean(email) && (team.linear_approvers ?? []).some((a) => a.trim().toLowerCase() === email);
}

// A Linear team key the settings give to two teams goes to the first, and says so.
export function teamsByLinearKey(teams, log = () => {}) {
  const map = new Map();
  for (const team of teams) {
    for (const key of team.linear_teams) {
      const k = key.trim().toUpperCase();
      if (map.has(k)) log(`linear: team key ${k} is set on two teams; using ${map.get(k).key}`);
      else map.set(k, team);
    }
  }
  return map;
}

const openLinearTasks = (db, teamIds, mirror) =>
  db(
    `tasks?team_id=in.(${teamIds.join(",")})&external_ref->>source=eq.linear&status=in.(new,ready,in_progress,needs_you)` +
      `&external_ref->>mirror=${mirror ? "eq.true" : "is.null"}&select=id,status,session_id,kind,external_ref`,
  );

const taskNote = (db, task_id, kind, body) =>
  db("task_events", { method: "POST", body: { task_id, kind, body, actor: "runner" }, prefer: "return=minimal" });

// Delegation taken back, or the issue closed in Linear. Work that hasn't started never does, and a new
// task hasn't, whatever session it had before it was reopened. A session that's running may be nearly
// done, so that's for the owner to decide: the inbox hears about it once.
async function undelegated(db, task) {
  const { id } = task.external_ref;
  if (task.status === "new" || (task.status === "ready" && !task.session_id)) {
    await db(`tasks?id=eq.${task.id}&status=eq.${task.status}`, { method: "PATCH", body: { status: "cancelled" }, prefer: "return=minimal" });
    await taskNote(db, task.id, "status", `cancelled: ${id} is no longer delegated in Linear`);
    return;
  }
  const body = `${id} is no longer delegated in Linear, or was closed there. The session keeps going unless you stop it.`;
  const told = await db(`task_comments?task_id=eq.${task.id}&author=eq.external&body=eq.${encodeURIComponent(body)}&select=id`);
  if (!told.length) {
    await db("task_comments", { method: "POST", body: { task_id: task.id, author: "external", author_name: "Linear", body }, prefer: "return=minimal" });
  }
}

export async function pollIssues(db, log = () => {}) {
  const teams = await db("teams?linear_teams=not.eq.{}&select=id,key,linear_teams,linear_assignee,linear_approvers");
  if (!teams.length) return false;
  if (!(await hasCredentials())) return false;

  const byKey = teamsByLinearKey(teams, log);
  const keys = [...byKey.keys()];
  const teamIds = teams.map((t) => t.id);

  const open = await openLinearTasks(db, teamIds, false);
  // An agent already has these, so who delegated them no longer decides anything.
  const taken = new Set(open.filter((t) => t.kind === "agent").map((t) => t.external_ref.linear_id));

  const delegated = await listIssues({
    delegate: { isMe: { eq: true } },
    team: { key: { in: keys } },
    state: { type: { nin: ["completed", "canceled"] } },
  });
  for (const issue of delegated) {
    const team = byKey.get(issue.team.key.toUpperCase());
    const actor = taken.has(issue.id) ? null : await delegatedBy(issue.id);
    const result = await upsert(db, team.id, issue, false, isApprover(team, actor), actor?.name ?? actor?.email ?? null);
    if (result.action !== "none") log(`linear: ${result.action} CC-${result.task} from ${issue.identifier}`);
  }

  const delegatedIds = new Set(delegated.map((i) => i.id));
  for (const task of open) {
    // Only an agent's: a hand-back keeps its task open for the owner after the delegate comes off.
    if (task.kind === "agent" && !delegatedIds.has(task.external_ref.linear_id)) await undelegated(db, task);
  }

  // Off unless a team names whose issues to show.
  for (const team of teams.filter((t) => t.linear_assignee?.trim())) {
    const teamKeys = keys.filter((k) => byKey.get(k).id === team.id);
    if (!teamKeys.length) continue;
    const assigned = await listIssues({
      assignee: { email: { eq: team.linear_assignee.trim() } },
      delegate: { null: true },
      team: { key: { in: teamKeys } },
      state: { type: { in: ["unstarted", "started"] } },
    });
    for (const issue of assigned) await upsert(db, team.id, issue, true);
    const assignedIds = new Set(assigned.map((i) => i.id));
    for (const task of await openLinearTasks(db, [team.id], true)) {
      if (assignedIds.has(task.external_ref.linear_id)) continue;
      await db(`tasks?id=eq.${task.id}`, { method: "PATCH", body: { status: "cancelled", today: false }, prefer: "return=minimal" });
      await taskNote(db, task.id, "status", `cancelled: ${task.external_ref.id} is no longer assigned or open in Linear`);
    }
  }
  return true;
}

// ---------- Out: tasks to issues ----------

const STARTED = "started";

// The state to move to, or null to leave the issue where it is. Linear's own rule for agents: a started
// status on starting work, unless it's already started or closed, and triage is left to a human.
export function targetState(kind, issue, settings) {
  const states = issue.team.states.nodes;
  const current = issue.state;
  const closed = current.type === "completed" || current.type === "canceled";
  const byPosition = (a, b) => a.position - b.position;
  // The status work starts in: the team's setting, else one named In Progress, else the first started
  // status that isn't a blocked or waiting one, which some teams order first.
  const startState = () => {
    const wanted = settings?.linear_started_state?.trim().toLowerCase();
    if (wanted) return states.find((s) => s.name.toLowerCase() === wanted) ?? null;
    const started = states.filter((s) => s.type === STARTED).sort(byPosition);
    return (
      started.find((s) => /^in progress$/i.test(s.name.trim())) ??
      started.find((s) => !/\b(block|wait|hold|paus)/i.test(s.name)) ??
      null
    );
  };
  if (kind === "started") {
    if (current.type !== "backlog" && current.type !== "unstarted") return null;
    return startState();
  }
  if (kind === "pr") {
    if (closed) return null;
    const wanted = settings?.linear_review_state?.trim().toLowerCase();
    const target = wanted
      ? states.find((s) => s.name.toLowerCase() === wanted)
      : states.filter((s) => s.type === STARTED && /\breview\b/i.test(s.name)).sort(byPosition)[0];
    if (!target || target.id === current.id) return null;
    // Never backwards, say from Ready to Merge to In Review. Leaving the status work started in is always
    // forwards, however the team has ordered its statuses.
    const fromStart = current.id === startState()?.id;
    if (!fromStart && current.type === STARTED && target.type === STARTED && current.position >= target.position) return null;
    return target;
  }
  if (kind === "done") {
    // Only where the team's settings say so: for most, a person or a merged PR closes the issue.
    const wanted = settings?.linear_done_state?.trim().toLowerCase();
    if (!wanted || closed) return null;
    return states.find((s) => s.name.toLowerCase() === wanted) ?? null;
  }
  return null;
}

async function doneSummary(db, taskId) {
  const [event] = await db(
    `task_events?task_id=eq.${taskId}&kind=eq.status&body=like.done:*&select=body&order=created_at.desc&limit=1`,
  );
  return event?.body.replace(/^done:\s*/, "") ?? null;
}

// What goes on the issue for each kind of update. Null for none: a started issue says so by its status.
export function commentFor(row, owner, summary = null) {
  switch (row.kind) {
    case "comment":
      return row.body;
    case "question":
      return `**Waiting on ${owner}:**\n\n${row.body}`;
    case "pr":
      return `Pull request opened: ${row.body}`;
    case "done":
      return `${summary ?? "The agent has finished."}\n\nDelegate this issue again to reopen the work.`;
    case "cancelled":
      return "Cancelled in Control Center, so no agent is working on this. Delegate it again to reopen the work.";
    case "handback":
      return `The agent has done its part and handed the rest to ${owner}. Delegate it again to put it back with the agent.`;
    default:
      return null;
  }
}

// Status first: it can safely be repeated, whereas a comment posted before a failure would be posted
// again on the retry.
async function deliver(db, row, owner) {
  const [task] = await db(
    `tasks?id=eq.${row.task_id}&select=external_ref,team:teams(linear_started_state,linear_review_state,linear_done_state)`,
  );
  const issueId = task.external_ref.linear_id;
  const { viewer, issue } = await linear(ISSUE_QUERY, { id: issueId });

  const input = {};
  const target = targetState(row.kind, issue, task.team);
  if (target) input.stateId = target.id;
  // Theirs if someone has since delegated it elsewhere.
  if (["done", "cancelled", "handback"].includes(row.kind) && issue.delegate?.id === viewer.id) input.delegateId = null;
  if (Object.keys(input).length) await linear(ISSUE_UPDATE, { id: issueId, input });

  const body = commentFor(row, owner, row.kind === "done" ? await doneSummary(db, row.task_id) : null);
  if (body) await linear(COMMENT_CREATE, { input: { issueId, body } });
}

const backoffMinutes = (attempts) => Math.min(2 ** attempts, 60);

export async function drainOutbox(db, owner, log = () => {}) {
  // Most ticks have nothing to send, and this asks for no credentials until one does.
  const pending = await db("linear_outbox?sent_at=is.null&select=id&limit=1");
  if (!pending.length || !(await hasCredentials())) return 0;

  let sent = 0;
  // A task's next update becomes claimable once the last is sent, so this empties the queue in order.
  for (;;) {
    const rows = await db("rpc/linear_outbox_claim", { method: "POST", body: { p_limit: 20 } });
    if (!rows.length) return sent;
    for (const row of rows) {
      const mark = (fields) => db(`linear_outbox?id=eq.${row.id}`, { method: "PATCH", body: fields, prefer: "return=minimal" });
      try {
        await deliver(db, row, owner);
        await mark({ sent_at: new Date().toISOString(), last_error: null });
        sent++;
      } catch (err) {
        log(`linear: CC-${row.task_id} update ${row.id} failed: ${err.message}`);
        // The issue is gone: nothing more can reach it, and the next update must not wait on this one.
        if (/entity not found|could not find/i.test(err.message)) {
          await mark({ sent_at: new Date().toISOString(), last_error: err.message });
          continue;
        }
        // It keeps trying however long Linear is away. A finished task's update can't be dropped: that's
        // what takes the delegate off, and with it still on, the issue would never count as delegated again.
        const next = new Date(Date.now() + backoffMinutes(row.attempts) * 60000).toISOString();
        await mark({ claimed_at: null, next_try_at: next, last_error: err.message.slice(0, 1000) });
        if (row.attempts === NOTIFY_AFTER_ATTEMPTS) {
          await db("task_comments", {
            method: "POST",
            body: { task_id: row.task_id, author: "external", author_name: "Linear", body: `Updates aren't reaching Linear and are being retried: ${err.message.slice(0, 500)}` },
            prefer: "return=minimal",
          });
        }
      }
    }
  }
}

// ---------- Called from the runner's tick ----------

let lastPoll = 0;
let toldOff = false;

export async function syncLinear(db, { owner, log }) {
  await drainOutbox(db, owner, log);
  if (Date.now() - lastPoll < POLL_MINUTES * 60000) return;
  lastPoll = Date.now();
  const polled = await pollIssues(db, log);
  // Said once, for a team with Linear set up on a machine that has no credentials.
  if (!polled && !toldOff && (await db("teams?linear_teams=not.eq.{}&select=id&limit=1")).length) {
    log("linear: teams are mapped but this machine has no Linear app credentials in the Keychain; sync is off");
    toldOff = true;
  }
}

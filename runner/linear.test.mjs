// End-to-end test of the Linear sync against the local database and a fake Linear. Never production:
//   CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> node --test runner/linear.test.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";

const URL_ = process.env.CC_SUPABASE_URL ?? "";
const KEY = process.env.CC_SERVICE_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_) || !KEY) throw new Error("Set CC_SUPABASE_URL to the local database, and CC_SERVICE_KEY");

const VIEWER = "app-user";
const STATES = [
  { id: "backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "doing", name: "In Progress", type: "started", position: 2 },
  { id: "review", name: "In Review", type: "started", position: 3 },
  { id: "merge", name: "Ready to Merge", type: "started", position: 4 },
  { id: "shipped", name: "Shipped", type: "completed", position: 5 },
  { id: "dropped", name: "Canceled", type: "canceled", position: 6 },
];
const state = (id) => STATES.find((s) => s.id === id);

// ---------- A fake Linear, holding issues and recording what's done to them ----------

const OWNER = { name: "Pat", email: "pat@example.com" };
const COLLEAGUE = { name: "Riley", email: "riley@example.com" };
const HISTORY_PAGE = 2;

let issues, comments, failNext, historyNewestFirst, historyLookups;

function matches(issue, f) {
  if (f.delegate?.isMe && issue.delegate !== VIEWER) return false;
  if (f.delegate?.null && issue.delegate) return false;
  if (f.assignee?.email?.eq && issue.assignee !== f.assignee.email.eq) return false;
  if (f.team?.key?.in && !f.team.key.in.includes(issue.team)) return false;
  const type = state(issue.state).type;
  if (f.state?.type?.nin?.includes(type)) return false;
  if (f.state?.type?.in && !f.state.type.in.includes(type)) return false;
  return true;
}

let tick = 0;
function record(i, toDelegate, actor) {
  i.history.push({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString(), toDelegate: toDelegate ? { id: toDelegate } : null, actor });
}

// As it happens in Linear: the delegate changes, and the history says who did it.
function delegate(i, actor = OWNER) {
  i.delegate = VIEWER;
  record(i, VIEWER, actor);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const { query, variables } = JSON.parse(raw);
    const name = query.match(/^(?:query|mutation) (\w+)/)[1];
    const send = (body) => res.end(JSON.stringify(body));
    if (failNext && name !== "Issues") {
      const message = failNext;
      failNext = null;
      return send({ errors: [{ message }] });
    }
    if (name === "Issues") {
      const nodes = [...issues.values()].filter((i) => matches(i, variables.filter)).map((i) => ({
        id: i.id, identifier: i.identifier, url: `https://linear.example/${i.identifier}`, title: i.title,
        description: i.description, priority: 2, dueDate: null, team: { key: i.team }, project: i.project ? { name: i.project } : null,
        labels: { nodes: [{ name: "Bug" }] }, creator: { name: "Sam", email: "sam@example.com" },
      }));
      return send({ data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (name === "Delegation") {
      if (!variables.after) historyLookups++;
      const all = [...issues.get(variables.id).history];
      if (historyNewestFirst) all.reverse();
      const start = Number(variables.after ?? 0);
      const nodes = all.slice(start, start + HISTORY_PAGE);
      const hasNextPage = start + HISTORY_PAGE < all.length;
      return send({ data: { viewer: { id: VIEWER }, issue: { history: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + HISTORY_PAGE) : null } } } } });
    }
    if (name === "Issue") {
      const i = issues.get(variables.id);
      if (!i) return send({ errors: [{ message: "Entity not found: Issue" }] });
      return send({ data: { viewer: { id: VIEWER }, issue: { state: state(i.state), delegate: i.delegate ? { id: i.delegate } : null, team: { states: { nodes: STATES } } } } });
    }
    if (name === "IssueUpdate") {
      const i = issues.get(variables.id);
      if (variables.input.stateId) i.state = variables.input.stateId;
      if ("delegateId" in variables.input) {
        i.delegate = variables.input.delegateId;
        record(i, null, null); // the app took itself off
      }
      return send({ data: { issueUpdate: { success: true } } });
    }
    if (name === "CommentCreate") {
      comments.push(variables.input);
      return send({ data: { commentCreate: { success: true } } });
    }
    send({ errors: [{ message: `unexpected ${name}` }] });
  });
});

// ---------- Local database ----------

async function db(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: prefer ?? "return=representation" },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

let linear, team, other;
const stamp = Date.now();
let counter = 0;

// Delegated by the owner unless it says otherwise.
function issue({ by = OWNER, ...fields } = {}) {
  const n = ++counter;
  const i = { id: `issue-${stamp}-${n}`, identifier: `TST${stamp % 100000}-${n}`, title: `Issue ${n}`, description: "Fix it", team: "TST", state: "todo", delegate: null, history: [], ...fields };
  issues.set(i.id, i);
  if (!("delegate" in fields)) delegate(i, by);
  return i;
}

const taskOf = async (i) => (await db(`tasks?external_ref->>linear_id=eq.${i.id}&select=*`))[0];
const countOf = async (i) => (await db(`tasks?external_ref->>linear_id=eq.${i.id}&select=id`)).length;
const patch = (id, fields) => db(`tasks?id=eq.${id}`, { method: "PATCH", body: fields });
const poll = () => linear.pollIssues(db);
// Drains without the wait a finished task's update has for its summary.
async function drain() {
  await db("linear_outbox?sent_at=is.null", { method: "PATCH", body: { next_try_at: new Date().toISOString() } });
  return linear.drainOutbox(db, "Pat");
}
const bodies = (i) => comments.filter((c) => c.issueId === i.id).map((c) => c.body);

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.CC_LINEAR_API = `http://127.0.0.1:${server.address().port}`;
  process.env.CC_LINEAR_TOKEN = "test";
  linear = await import("./linear.mjs");
  [team] = await db("teams", { method: "POST", body: { key: `linear-test-${stamp}`, name: `Linear test ${stamp}`, linear_teams: ["TST"], linear_approvers: [OWNER.email] } });
  [other] = await db("teams", { method: "POST", body: { key: `linear-other-${stamp}`, name: `Linear other ${stamp}` } });
});

after(async () => {
  server.close();
  await db(`tasks?team_id=in.(${team.id},${other.id})`, { method: "DELETE" });
  await db(`projects?team_id=in.(${team.id},${other.id})`, { method: "DELETE" });
  await db(`teams?id=in.(${team.id},${other.id})`, { method: "DELETE" });
});

beforeEach(async () => {
  issues = new Map();
  comments = [];
  failNext = null;
  historyNewestFirst = false;
  historyLookups = 0;
  await db(`tasks?team_id=eq.${team.id}`, { method: "DELETE" });
  await db(`teams?id=eq.${team.id}`, { method: "PATCH", body: { linear_assignee: null, linear_done_state: null, linear_review_state: null, linear_approvers: [OWNER.email], linear_post_progress: false } });
});

// ---------- In ----------

test("an issue the owner delegates becomes exactly one ready agent task, linked to it", async () => {
  const i = issue();
  await Promise.all([poll(), poll(), poll()]);
  await poll();
  assert.equal(await countOf(i), 1);
  const t = await taskOf(i);
  assert.equal(t.kind, "agent");
  assert.equal(t.status, "ready");
  assert.equal(t.team_id, team.id);
  assert.equal(t.source, "linear");
  assert.equal(t.repo, null);
  assert.equal(t.priority, 2);
  assert.deepEqual(t.labels, ["bug"]);
  assert.deepEqual(t.requested_by, { name: "Sam", email: "sam@example.com" });
  assert.equal(t.external_ref.source, "linear");
  assert.equal(t.external_ref.id, i.identifier);
  assert.equal(t.external_ref.url, `https://linear.example/${i.identifier}`);
});

test("issues that aren't delegated, closed, or from an unmapped team come in as nothing", async () => {
  const undelegated = issue({ delegate: null, assignee: "pat@example.com" });
  const closed = issue({ state: "shipped" });
  const unmapped = issue({ team: "NOPE" });
  await poll();
  assert.equal(await countOf(undelegated), 0);
  assert.equal(await countOf(closed), 0);
  assert.equal(await countOf(unmapped), 0);
});

test("the issue's project goes with it, unless that name belongs to another team", async () => {
  const name = `Project ${stamp}`;
  const taken = `Taken ${stamp}`;
  await db("projects", { method: "POST", body: { name: taken, team_id: other.id } });
  const a = issue({ project: name });
  const b = issue({ project: taken });
  await poll();
  const [ta, tb] = [await taskOf(a), await taskOf(b)];
  assert.equal(ta.project, name);
  assert.equal(ta.team_id, team.id);
  assert.equal(tb.project, null);
  assert.equal(tb.team_id, team.id);
});

test("editing or moving the issue updates the one task", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  i.title = "Better title";
  i.description = "More detail";
  i.identifier = "TST-MOVED";
  await poll();
  assert.equal(await countOf(i), 1);
  const t = await taskOf(i);
  assert.equal(t.id, id);
  assert.equal(t.title, "Better title");
  assert.equal(t.description, "More detail");
  assert.equal(t.external_ref.id, "TST-MOVED");
  assert.equal(t.status, "ready");
});

// ---------- Who can approve work ----------

const inboxOf = (id) => db(`notifications?task_id=eq.${id}&kind=eq.handoff&select=body`);

test("the owner's delegation is ready and quiet; anyone else's waits as new, with a note in the inbox", async () => {
  const mine = issue();
  const theirs = issue({ by: COLLEAGUE });
  await poll();
  await poll();
  const [m, t] = [await taskOf(mine), await taskOf(theirs)];
  assert.equal(m.status, "ready");
  assert.equal((await inboxOf(m.id)).length, 0);
  assert.equal(t.status, "new");
  assert.equal(t.kind, "agent");
  const inbox = await inboxOf(t.id);
  assert.equal(inbox.length, 1); // not once per poll
  assert.match(inbox[0].body, /^Riley delegated .+ It starts once you approve it/);
});

test("a task waiting for approval runs once the owner approves it, and reports as usual", async () => {
  const i = issue({ by: COLLEAGUE });
  await poll();
  const { id } = await taskOf(i);
  await poll();
  assert.equal((await taskOf(i)).status, "new"); // polling doesn't approve it
  await patch(id, { status: "ready" });
  await poll();
  assert.equal((await taskOf(i)).status, "ready"); // nor undo that
  await patch(id, { status: "in_progress" });
  await drain();
  assert.equal(i.state, "doing");
});

test("no approvers set: even the owner's delegation waits", async () => {
  await db(`teams?id=eq.${team.id}`, { method: "PATCH", body: { linear_approvers: [] } });
  const i = issue();
  await poll();
  assert.equal((await taskOf(i)).status, "new");
});

test("approvers match on email, whatever its case", async () => {
  await db(`teams?id=eq.${team.id}`, { method: "PATCH", body: { linear_approvers: [" PAT@Example.com "] } });
  const i = issue();
  await poll();
  assert.equal((await taskOf(i)).status, "ready");
});

test("nobody named means no approval: an automation, or no history of the delegation", async () => {
  const automated = issue({ by: null });
  const unrecorded = issue({ delegate: VIEWER });
  await poll();
  for (const i of [automated, unrecorded]) {
    const t = await taskOf(i);
    assert.equal(t.status, "new");
    assert.match((await inboxOf(t.id))[0].body, /^Someone delegated/);
  }
});

test("the latest delegation decides, across pages, whichever way Linear orders them", async () => {
  for (const newestFirst of [false, true]) {
    historyNewestFirst = newestFirst;
    const toThem = issue();
    toThem.delegate = null;
    record(toThem, null, OWNER);
    record(toThem, "another-agent", OWNER); // someone else's delegate, by an approver, doesn't count
    delegate(toThem, COLLEAGUE);
    const toMe = issue({ by: COLLEAGUE });
    toMe.delegate = null;
    record(toMe, null, COLLEAGUE);
    record(toMe, null, COLLEAGUE);
    delegate(toMe, OWNER);
    await poll();
    assert.equal((await taskOf(toThem)).status, "new");
    assert.equal((await taskOf(toMe)).status, "ready");
    await db(`tasks?team_id=eq.${team.id}`, { method: "DELETE" });
  }
});

test("history is only read when a delegation decides something", async () => {
  const i = issue();
  await poll();
  assert.equal(historyLookups, 1);
  await poll();
  await poll();
  assert.equal(historyLookups, 1);
  await patch((await taskOf(i)).id, { status: "done" });
  await drain();
  delegate(i);
  await poll();
  assert.equal(historyLookups, 2);
});

test("delegated again: ready if the owner did it, new with an inbox note if anyone else did", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  await patch(id, { status: "done" });
  await drain();

  delegate(i, COLLEAGUE);
  await poll();
  await poll();
  let t = await taskOf(i);
  assert.equal(t.id, id);
  assert.equal(t.status, "new");
  assert.equal((await inboxOf(id)).length, 1);

  await patch(id, { status: "cancelled" }); // the owner says no
  await drain();
  assert.equal(i.delegate, null);
  delegate(i, OWNER);
  await poll();
  t = await taskOf(i);
  assert.equal(t.status, "ready");
  assert.equal((await inboxOf(id)).length, 1);
});

test("a hand-back delegated again by someone else goes back to the agent, but waits", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  await patch(id, { status: "ready", kind: "human" });
  await drain();
  const before = (await inboxOf(id)).length;
  delegate(i, COLLEAGUE);
  await poll();
  const t = await taskOf(i);
  assert.equal(t.kind, "agent");
  assert.equal(t.status, "new");
  assert.equal((await inboxOf(id)).length, before + 1);
});

test("a new task taken back is cancelled, even one reopened with a session to resume", async () => {
  const fresh = issue({ by: COLLEAGUE });
  const reopened = issue();
  await poll();
  const r = await taskOf(reopened);
  await patch(r.id, { status: "done", session_id: "33333333-3333-4333-8333-333333333333", worktree: "/tmp/kept" });
  await drain();
  delegate(reopened, COLLEAGUE);
  await poll();
  const waiting = await taskOf(reopened);
  assert.equal(waiting.status, "new");
  assert.equal(waiting.session_id, "33333333-3333-4333-8333-333333333333");

  fresh.delegate = null;
  reopened.delegate = null;
  await poll();
  assert.equal((await taskOf(fresh)).status, "cancelled");
  assert.equal((await taskOf(reopened)).status, "cancelled");
});

test("these tasks fire a team's outbound webhooks with scope external", async () => {
  await db("rpc/create_webhook", { method: "POST", body: { p_team: team.id, p_url: "http://127.0.0.1:9/hook" } });
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  const deliveries = await db(`webhook_deliveries?task_id=eq.${id}&select=event_type`);
  assert.ok(deliveries.some((d) => d.event_type === "task.created"), JSON.stringify(deliveries));
  await db(`webhooks?team_id=eq.${team.id}`, { method: "DELETE" });
});

// ---------- Out ----------

test("starting moves the issue to the first started status, once and not backwards", async () => {
  const i = issue();
  await poll();
  const t = await taskOf(i);
  await patch(t.id, { status: "in_progress" });
  await drain();
  assert.equal(i.state, "doing");
  assert.deepEqual(bodies(i), []);

  i.state = "merge";
  await patch(t.id, { status: "needs_you", question: "Which?" });
  await patch(t.id, { status: "ready" });
  await patch(t.id, { status: "in_progress" });
  await drain();
  assert.equal(i.state, "merge");
});

test("the agent's comments are posted; the owner's, their Claude sessions', reviewers' and logs aren't", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "agent", body: "Found the cause" }] });
  await db("task_events", { method: "POST", body: { task_id: id, kind: "agent_log", body: "Reproduced it", actor: "claude" } });
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "me", body: "private" }] });
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "claude", body: "planning note about a blocker" }] });
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "reviewer", author_name: "Rev", body: "private too" }] });
  await db("task_events", { method: "POST", body: { task_id: id, kind: "note", body: "/Users/x/worktree", actor: "runner" } });
  await drain();
  assert.deepEqual(bodies(i), ["Found the cause"]);
});

test("progress logs are posted only for a team that turns them on, and the milestones either way", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  const url = "https://github.com/acme/app/pull/11";
  await db("task_events", { method: "POST", body: { task_id: id, kind: "agent_log", body: "quiet", actor: "claude" } });
  await patch(id, { status: "in_progress" });
  await patch(id, { links: [{ title: "PR", url }] });
  await patch(id, { status: "needs_you", question: "Which?" });
  await patch(id, { status: "done" });
  await drain();
  assert.equal(i.state, "review");
  assert.equal(i.delegate, null);
  const posted = bodies(i);
  assert.equal(posted.length, 3);
  assert.equal(posted[0], `Pull request opened: ${url}`);
  assert.match(posted[1], /Waiting on Pat/);
  assert.match(posted[2], /has finished/);

  await db(`teams?id=eq.${team.id}`, { method: "PATCH", body: { linear_post_progress: true } });
  const loud = issue();
  await poll();
  await db("task_events", { method: "POST", body: { task_id: (await taskOf(loud)).id, kind: "agent_log", body: "Reproduced it", actor: "claude" } });
  await drain();
  assert.deepEqual(bodies(loud), ["Reproduced it"]);
});

test("a question reaches the inbox and the issue, once", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  await patch(id, { status: "in_progress" });
  await patch(id, { status: "needs_you", question: "Staging or prod?" });
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "agent", body: "Staging or prod?" }] }); // as ask_human does
  await drain();
  assert.deepEqual(bodies(i), ["**Waiting on Pat:**\n\nStaging or prod?"]);
  const inbox = await db(`notifications?task_id=eq.${id}&kind=eq.question&select=body`);
  assert.equal(inbox.length, 1);
});

test("a PR link is posted once and moves the issue to review; other links do neither", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  const url = "https://github.com/acme/app/pull/7";
  await patch(id, { links: [{ title: "Notes", url: "file:///tmp/notes.md" }] });
  await drain();
  assert.equal(i.state, "todo");
  assert.deepEqual(bodies(i), []);
  await patch(id, { links: [{ title: "Notes", url: "file:///tmp/notes.md" }, { title: "PR", url }] });
  await patch(id, { links: [{ title: "PR #7", url }, { title: "Notes", url: "file:///tmp/notes.md" }] });
  await drain();
  assert.equal(i.state, "review");
  assert.deepEqual(bodies(i), [`Pull request opened: ${url}`]);
});

test("a team can name its review status, and an issue already past review stays put", async () => {
  const past = issue({ state: "merge" });
  const shipped = issue({ state: "doing" });
  await poll();
  await patch((await taskOf(past)).id, { links: [{ title: "PR", url: "https://github.com/acme/app/pull/8" }] });
  shipped.state = "shipped"; // closed in Linear after it came in
  await patch((await taskOf(shipped)).id, { links: [{ title: "PR", url: "https://github.com/acme/app/pull/9" }] });
  await drain();
  assert.equal(past.state, "merge");
  assert.equal(shipped.state, "shipped");

  await db(`teams?id=eq.${team.id}`, { method: "PATCH", body: { linear_review_state: "ready to merge" } });
  const named = issue();
  await poll();
  await patch((await taskOf(named)).id, { links: [{ title: "PR", url: "https://github.com/acme/app/pull/10" }] });
  await drain();
  assert.equal(named.state, "merge");
});

test("finishing posts the summary and takes the delegate off, but never marks it done by default", async () => {
  const i = issue({ state: "review" });
  await poll();
  const { id } = await taskOf(i);
  await patch(id, { status: "done" });
  await db("task_events", { method: "POST", body: { task_id: id, kind: "status", body: "done: Fixed the bug", actor: "claude" } });
  await poll(); // still delegated, but this is the old delegation, not a new one
  assert.equal((await taskOf(i)).status, "done");
  await drain();
  assert.equal(i.state, "review");
  assert.equal(i.delegate, null);
  assert.match(bodies(i)[0], /^Fixed the bug/);
});

test("a team's workflow can mark it done", async () => {
  await db(`teams?id=eq.${team.id}`, { method: "PATCH", body: { linear_done_state: "Shipped" } });
  const i = issue({ state: "review" });
  await poll();
  await patch((await taskOf(i)).id, { status: "done" });
  await drain();
  assert.equal(i.state, "shipped");
});

test("someone else's delegate is left alone", async () => {
  const i = issue();
  await poll();
  await patch((await taskOf(i)).id, { status: "done" });
  i.delegate = "another-agent";
  await drain();
  assert.equal(i.delegate, "another-agent");
});

test("delegating again reopens the same task", async () => {
  const i = issue();
  await poll();
  const t = await taskOf(i);
  await patch(t.id, { status: "done", session_id: "11111111-1111-4111-8111-111111111111" });
  await drain();
  await poll();
  assert.equal((await taskOf(i)).status, "done"); // not delegated: stays finished

  delegate(i);
  await poll();
  await poll();
  assert.equal(await countOf(i), 1);
  const again = await taskOf(i);
  assert.equal(again.id, t.id);
  assert.equal(again.status, "ready");
  assert.equal(again.session_id, null); // no worktree left to resume in
});

test("a hand-back to the owner says so and frees the issue; delegating again returns it to the agent", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  await patch(id, { status: "ready", kind: "human" });
  await drain();
  assert.equal(i.delegate, null);
  assert.match(bodies(i)[0], /handed the rest to Pat/);
  await poll();
  assert.equal((await taskOf(i)).status, "ready"); // left with the owner, not cancelled as undelegated

  delegate(i);
  await poll();
  assert.equal((await taskOf(i)).kind, "agent");
});

test("cancelling says so and frees the issue", async () => {
  const i = issue();
  await poll();
  await patch((await taskOf(i)).id, { status: "cancelled" });
  await drain();
  assert.equal(i.delegate, null);
  assert.match(bodies(i)[0], /Cancelled/);
});

test("taken back before it started: cancelled. Taken back while running: the owner hears once", async () => {
  const waiting = issue();
  const running = issue();
  await poll();
  const r = await taskOf(running);
  await patch(r.id, { status: "in_progress", session_id: "22222222-2222-4222-8222-222222222222" });
  waiting.delegate = null;
  running.delegate = null;
  await poll();
  await poll();
  assert.equal((await taskOf(waiting)).status, "cancelled");
  const after = await taskOf(running);
  assert.equal(after.status, "in_progress");
  const told = await db(`task_comments?task_id=eq.${r.id}&author=eq.external&select=body`);
  assert.equal(told.length, 1);
});

test("a failure keeps the task's updates in order and doesn't lose or repeat them", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "agent", body: "first" }] });
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "agent", body: "second" }] });
  failNext = "Linear is down";
  await drain();
  assert.deepEqual(bodies(i), []);
  const [row] = await db(`linear_outbox?task_id=eq.${id}&sent_at=is.null&order=id&limit=1`);
  assert.match(row.last_error, /Linear is down/);
  assert.ok(new Date(row.next_try_at) > new Date());
  await drain();
  assert.deepEqual(bodies(i), ["first", "second"]);
  await drain();
  assert.deepEqual(bodies(i), ["first", "second"]);
});

test("an issue deleted in Linear doesn't hold up the queue", async () => {
  const i = issue();
  await poll();
  const { id } = await taskOf(i);
  await db("task_comments", { method: "POST", body: [{ task_id: id, author: "agent", body: "hello" }] });
  issues.delete(i.id);
  await drain();
  assert.equal((await db(`linear_outbox?task_id=eq.${id}&sent_at=is.null&select=id`)).length, 0);
});

test("tasks that aren't Linear's report nothing", async () => {
  const [t] = await db("tasks", { method: "POST", body: { title: "Other", kind: "agent", status: "ready", team_id: team.id, external_ref: { source: "linear", id: "FAKE-1" } } });
  await patch(t.id, { status: "in_progress", links: [{ title: "PR", url: "https://github.com/a/b/pull/1" }] });
  await db("task_comments", { method: "POST", body: [{ task_id: t.id, author: "agent", body: "hi" }] });
  assert.equal((await db(`linear_outbox?task_id=eq.${t.id}&select=id`)).length, 0);
});

// ---------- Read-only view of assigned issues ----------

test("assigned issues show up only when turned on, as a human task on Today that reports nothing", async () => {
  const email = "pat@example.com";
  const i = issue({ delegate: null, assignee: email, state: "doing" });
  await poll();
  assert.equal(await countOf(i), 0);

  await db(`teams?id=eq.${team.id}`, { method: "PATCH", body: { linear_assignee: email } });
  await poll();
  await poll();
  assert.equal(await countOf(i), 1);
  const t = await taskOf(i);
  assert.equal(t.kind, "human");
  assert.equal(t.status, "ready");
  assert.equal(t.today, true);

  await db("task_comments", { method: "POST", body: [{ task_id: t.id, author: "claude", body: "note" }] });
  await patch(t.id, { links: [{ title: "PR", url: "https://github.com/a/b/pull/2" }] });
  await drain();
  assert.deepEqual(bodies(i), []);
  assert.equal(i.state, "doing");

  i.assignee = "someone-else@example.com";
  await poll();
  assert.equal((await taskOf(i)).status, "cancelled");
  i.assignee = email;
  await poll();
  assert.equal((await taskOf(i)).status, "ready");

  await patch(t.id, { status: "done" }); // ticked off: read-only, so it stays that way
  await poll();
  assert.equal((await taskOf(i)).status, "done");
  await patch(t.id, { status: "ready" });

  delegate(i); // delegating it turns the view into the real thing, still one task
  await poll();
  assert.equal(await countOf(i), 1);
  const real = await taskOf(i);
  assert.equal(real.id, t.id);
  assert.equal(real.kind, "agent");
  assert.equal(real.status, "ready");
  await patch(real.id, { status: "in_progress" });
  await db("task_comments", { method: "POST", body: [{ task_id: real.id, author: "agent", body: "on it" }] });
  await drain();
  assert.deepEqual(bodies(i), ["on it"]);
});

test("a task that didn't come from Linear queues nothing for it", async () => {
  const [t] = await db("tasks", { method: "POST", body: { title: "Not from Linear", kind: "agent", status: "ready", team_id: team.id } });
  await patch(t.id, { status: "in_progress" });
  await patch(t.id, { links: [{ title: "PR", url: "https://github.com/o/r/pull/1" }] });
  await db("task_comments", { method: "POST", body: [{ task_id: t.id, author: "agent", body: "working" }] });
  await patch(t.id, { status: "done" });
  assert.deepEqual(await db(`linear_outbox?task_id=eq.${t.id}&select=id`), []);
});

// ---------- Pure parts ----------

test("work starts in In Progress, not a Blocked status the team orders first", () => {
  const issue_ = (current, states) => ({ state: current, team: { states: { nodes: states } } });
  const blockedFirst = [
    { id: "todo", name: "Todo", type: "unstarted", position: 0 },
    { id: "blocked", name: "Blocked", type: "started", position: 1 },
    { id: "staging", name: "Staging", type: "started", position: 2 },
    { id: "review", name: "Code Review", type: "started", position: 3 },
    { id: "doing", name: "In Progress", type: "started", position: 4 },
    { id: "deploy", name: "Ready for Deploy", type: "started", position: 5 },
  ];
  const todo = blockedFirst[0];
  const doing = blockedFirst[4];
  assert.equal(linear.targetState("started", issue_(todo, blockedFirst), {}).id, "doing");
  // Without one named In Progress, the first that isn't blocked or waiting.
  const noInProgress = blockedFirst.filter((s) => s.id !== "doing");
  assert.equal(linear.targetState("started", issue_(todo, noInProgress), {}).id, "staging");
  // The team's setting wins.
  assert.equal(linear.targetState("started", issue_(todo, blockedFirst), { linear_started_state: "staging" }).id, "staging");
  // From the start status to review is forwards, even when review is ordered before it.
  assert.equal(linear.targetState("pr", issue_(doing, blockedFirst), { linear_review_state: "Code Review" }).id, "review");
  // But never back from a later status.
  assert.equal(linear.targetState("pr", issue_(blockedFirst[5], blockedFirst), { linear_review_state: "Code Review" }), null);
});

test("a Linear key set on two teams goes to the first", () => {
  const notes = [];
  const map = linear.teamsByLinearKey([{ key: "a", linear_teams: ["eng"] }, { key: "b", linear_teams: ["ENG", "OPS"] }], (n) => notes.push(n));
  assert.equal(map.get("ENG").key, "a");
  assert.equal(map.get("OPS").key, "b");
  assert.equal(notes.length, 1);
});

test("no started status means no move, and triage is left to a human", () => {
  const issue_ = (current, states) => ({ state: current, team: { states: { nodes: states } } });
  assert.equal(linear.targetState("started", issue_(state("todo"), [state("todo")]), {}), null);
  assert.equal(linear.targetState("started", issue_({ id: "t", type: "triage", position: 0 }, STATES), {}), null);
  assert.equal(linear.targetState("pr", issue_(state("doing"), STATES.filter((s) => s.id !== "review" )), {}), null);
});

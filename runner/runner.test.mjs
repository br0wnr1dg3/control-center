// How the runner counts its slots (CC_MAX_CONCURRENT), against the local database and a fake cmux, so
// no Claude session is ever started. Never production:
//   CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> node --test runner/runner.test.mjs

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const URL_ = process.env.CC_SUPABASE_URL ?? "";
const KEY = process.env.CC_SERVICE_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_) || !KEY) throw new Error("Set CC_SUPABASE_URL to the local database, and CC_SERVICE_KEY");

// ---------- A fake cmux: lists the windows and screens the test wrote, records what it's asked ----------

const home = mkdtempSync(join(tmpdir(), "cc-runner-test-"));
const fake = join(home, "cmux");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const [cmd, ...args] = process.argv.slice(2);
const dir = ${JSON.stringify(home)};
appendFileSync(join(dir, "calls.log"), JSON.stringify([cmd, ...args]) + "\\n");
const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
if (cmd === "list-workspaces") console.log(state.windows.map((w) => \`  \${w.ref}  CC-\${w.task} \${w.title} \`).join("\\n"));
if (cmd === "read-screen") console.log(state.windows.find((w) => w.ref === args[args.indexOf("--workspace") + 1])?.screen ?? "");
if (cmd === "new-workspace") console.log("OK workspace:900");
`,
);
chmodSync(fake, 0o755);

let windows;
let nextRef = 1;
const show = () => writeFileSync(join(home, "state.json"), JSON.stringify({ windows }));
// A session window for a task, showing a screen that stays as it is until the test changes it.
function open(task, screen = "> ") {
  const w = { ref: `workspace:${nextRef++}`, task: task.id, title: task.title, screen };
  windows.push(w);
  show();
  return w;
}
const workspacesOf = () => new Map(windows.map((w) => [w.task, w.ref]));
const started = () =>
  readFileSync(join(home, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter(([cmd]) => cmd === "new-workspace").length;

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

let runner, team;
const stamp = Date.now();
let counter = 0;

// Well over the time the fake cmux takes to answer (a node start per call), or a screen drawn a moment
// ago already counts as still.
const IDLE_MS = 500;
const idle = () => new Promise((r) => setTimeout(r, IDLE_MS * 2));

const task = async (fields = {}) =>
  (await db("tasks", { method: "POST", body: { title: `Runner test ${++counter}`, kind: "agent", status: "ready", team_id: team.id, source: "test", ...fields } }))[0];
// A session the runner started earlier: in progress, with a window.
async function session(fields = {}) {
  const t = await task({ status: "in_progress", session_id: crypto.randomUUID(), ...fields });
  return { ...t, window: open(t) };
}
const publish = async (t, fields = {}) =>
  (await db("reviews", { method: "POST", body: { token: `test-${stamp}-${++counter}`, task_id: t.id, title: "Cut v1", object_key: `test/${stamp}/${counter}`, ...fields } }))[0];
const decide = (review, status) => db(`reviews?id=eq.${review.id}`, { method: "PATCH", body: { status, decided_by: "Pat", decided_at: new Date().toISOString() } });
// As tick reads them.
const tasks = () => db(`tasks?team_id=eq.${team.id}&kind=eq.agent&status=in.(ready,in_progress,needs_you)&select=*,waiting_on,awaiting_review&order=sort_order,id`);
const statusOf = async (t) => (await db(`tasks?id=eq.${t.id}&select=status`))[0].status;
const awaiting = async (t) => (await db(`tasks?id=eq.${t.id}&select=awaiting_review`))[0].awaiting_review;
const dispatch = async () => runner.dispatch(await tasks(), workspacesOf());

before(async () => {
  process.env.CC_CMUX = fake;
  process.env.CC_HOME = home;
  process.env.CC_MAX_CONCURRENT = "1";
  process.env.CC_REVIEW_IDLE_MINUTES = String(IDLE_MS / 60000);
  runner = await import("./runner.mjs");
  runner.useServiceKey(KEY);
  [team] = await db("teams", { method: "POST", body: { key: `runner-test-${stamp}`, name: `Runner test ${stamp}` } });
});

after(async () => {
  await db(`tasks?team_id=eq.${team.id}`, { method: "DELETE" });
  await db(`teams?id=eq.${team.id}`, { method: "DELETE" });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  windows = [];
  show();
  writeFileSync(join(home, "calls.log"), "");
  await db(`tasks?team_id=eq.${team.id}`, { method: "DELETE" });
});

// ---------- The count ----------

const row = (id, status, awaiting_review = false) => ({ id, status, awaiting_review });

test("a slot is an in-progress task with a window on this machine", () => {
  const all = [row(1, "in_progress"), row(2, "in_progress"), row(3, "needs_you"), row(4, "ready"), row(5, "in_progress")];
  const here = new Map([[1, "workspace:1"], [3, "workspace:3"], [4, "workspace:4"], [5, "workspace:5"]]);
  // 2 has no window here (another machine's, or closed); 3 waits on the owner; 4 hasn't started.
  assert.equal(runner.slotsInUse(all, here, new Set()), 2);
});

test("sessions waiting on a review hold no slot, up to the cap", () => {
  const all = [1, 2, 3, 4, 5].map((id) => row(id, "in_progress", id > 1));
  const here = new Map(all.map((t) => [t.id, `workspace:${t.id}`]));
  assert.equal(runner.slotsInUse(all, here, new Set([2, 3, 4, 5])), 1);
  assert.equal(runner.slotsInUse(all, here, new Set([2, 3, 4, 5]), 3), 2, "the fifth waits past a cap of 3, so it counts again");
  assert.equal(runner.slotsInUse(all, here, new Set([2, 3, 4, 5]), 0), 5, "a cap of 0 is the old behaviour");
  // Waiting somewhere else doesn't free a slot here.
  assert.equal(runner.slotsInUse(all, new Map([[1, "workspace:1"]]), new Set([2, 3])), 1);
});

// ---------- Which sessions are waiting ----------

test("awaiting_review follows the task's latest review", async () => {
  const t = await task({ status: "in_progress" });
  assert.equal(await awaiting(t), false, "nothing published");
  const v1 = await publish(t);
  assert.equal(await awaiting(t), true, "published, undecided");
  await decide(v1, "changes_requested");
  assert.equal(await awaiting(t), false, "changes requested: the agent has work to do");
  const v2 = await publish(t, { title: "Cut v2" });
  assert.equal(await awaiting(t), true, "the next version waits again");
  await decide(v2, "approved");
  assert.equal(await awaiting(t), false, "approved");

  // An earlier output nobody decided doesn't count once a later one has been.
  const other = await task({ status: "in_progress" });
  await publish(other, { created_at: new Date(Date.now() - 60000).toISOString() });
  await decide(await publish(other, { title: "Cut v2" }), "approved");
  assert.equal(await awaiting(other), false);
});

test("a session is waiting once it has published and its screen has gone still", async () => {
  const published = await session();
  const working = await session();
  const unpublished = await session();
  await publish(published);
  await publish(working);
  const ids = async () => [...(await runner.waitingOnReview(await tasks(), workspacesOf()))];

  assert.deepEqual(await ids(), [], "first look: nothing is known to be still yet");
  await idle();
  working.window.screen = "✻ Rendering… (12s)";
  show();
  assert.deepEqual(await ids(), [published.id], "published and still; one still drawing isn't, and one that never published isn't");

  // The decision is typed in and the session starts on the next version.
  published.window.screen = "Review from Pat: Changes requested ...";
  show();
  assert.deepEqual(await ids(), []);
});

// ---------- What that does to starting work ----------

test("a session waiting on a review doesn't keep ready work from starting", async () => {
  const cut = await session();
  const next = await task();

  await dispatch();
  await idle();
  await dispatch();
  assert.equal(await statusOf(next), "ready", "the one slot is taken by a session that hasn't published");
  assert.equal(started(), 0);

  await publish(cut);
  cut.window.screen = "Published Cut v1 for review.";
  show();
  await dispatch();
  await idle();
  await dispatch();
  assert.equal(await statusOf(next), "in_progress", "published and idle: the slot is free");
  assert.equal(started(), 1);
  assert.equal(await statusOf(cut), "in_progress", "the waiting task keeps its status and its session");
  assert.ok(windows.some((w) => w.task === cut.id));

  // The session just started holds the slot like any other.
  open(next);
  const third = await task();
  await dispatch();
  assert.equal(await statusOf(third), "ready");
  assert.equal(started(), 1);
});

test("a session back at work after the decision takes its slot again", async () => {
  const cut = await session();
  const review = await publish(cut);
  await dispatch();
  await idle();

  await decide(review, "changes_requested");
  await db("task_comments", { method: "POST", body: { task_id: cut.id, author: "reviewer", author_name: "Pat", body: "Changes requested: tighten the intro" } });
  const next = await task();
  await dispatch();
  assert.equal(await statusOf(next), "ready", "the review is decided, so the session counts whatever its screen shows");
  assert.equal(started(), 0);
  const typed = readFileSync(join(home, "calls.log"), "utf8");
  assert.match(typed, /Review from Pat: Changes requested: tighten the intro/, "and the decision was typed into the same session");
});

// ---------- Sessions that went quiet ----------

const MIN = 60000;
const NOW = Date.UTC(2026, 0, 1, 12);
const STALL = { stallMinutes: 15, stallNudges: 3, stallReplyMinutes: 3 };
// One poll's decision: a session in progress, not awaiting a review, unless the test says otherwise.
const decideStall = (fields = {}, config = STALL) => runner.stallAction({ task: row(7, "in_progress"), now: NOW, ...fields }, config);
// A stretch that began 15 minutes before its first nudge.
const nudged = (count, minutesAgo) => ({ count, lastAt: NOW - minutesAgo * MIN, since: NOW - (minutesAgo + 15 * count) * MIN });

test("a session is left alone until its screen has been still for the threshold", () => {
  assert.deepEqual(decideStall({ quiet: 0 }), { action: "none", nudges: null });
  assert.deepEqual(decideStall({ quiet: 14.9 }), { action: "none", nudges: null }, "a long tool call, or a short wait");
  const first = decideStall({ quiet: 15 });
  assert.equal(first.action, "nudge");
  assert.equal(first.minutes, 15);
  assert.deepEqual(first.nudges, { count: 1, lastAt: NOW, since: NOW - 15 * MIN });
});

test("only an in-progress session with a window, no review pending and nothing to deliver is nudged", () => {
  const quiet = 60;
  const state = nudged(1, 20);
  const left = { action: "none", nudges: null };
  assert.deepEqual(decideStall({ quiet, nudges: state, task: row(7, "needs_you") }), left, "waiting on the owner");
  assert.deepEqual(decideStall({ quiet, nudges: state, task: row(7, "done") }), left, "finished, being cleaned up");
  assert.deepEqual(decideStall({ quiet, nudges: state, task: row(7, "ready") }), left);
  assert.deepEqual(decideStall({ quiet, nudges: state, task: row(7, "in_progress", true) }), left, "waiting on a review");
  assert.deepEqual(decideStall({ quiet, nudges: state, task: { id: 7, status: "in_progress" } }), left, "a database without awaiting_review: unknown, so no");
  assert.deepEqual(decideStall({ quiet, nudges: state, hasWindow: false }), left, "no window on this machine");
  assert.deepEqual(decideStall({ quiet, nudges: state, pending: 1 }), left, "a comment is about to wake it");
  assert.deepEqual(decideStall({ quiet, nudges: state }, { ...STALL, stallMinutes: 0 }), left, "turned off");
  assert.deepEqual(decideStall({ quiet: Infinity, nudges: state }), { action: "none", nudges: state }, "a screen that can't be read: no typing, count kept");
});

test("nudges are spaced by the threshold and stop at the limit", () => {
  // Nudged 10 minutes ago, and the screen hasn't moved since before the stretch began.
  let state = nudged(1, 10);
  assert.deepEqual(decideStall({ quiet: 25, nudges: state }), { action: "none", nudges: state }, "too soon after the last one");

  state = nudged(1, 15);
  const second = decideStall({ quiet: 30, nudges: state });
  assert.equal(second.action, "nudge");
  assert.equal(second.minutes, 30, "counted from when the screen first went still");
  assert.deepEqual(second.nudges, { count: 2, lastAt: NOW, since: state.since });

  state = nudged(2, 15);
  assert.equal(decideStall({ quiet: 45, nudges: state }).nudges.count, 3);

  state = nudged(3, 14);
  assert.equal(decideStall({ quiet: 59, nudges: state }).action, "none", "the last nudge gets a full threshold too");
  state = nudged(3, 15);
  assert.deepEqual(decideStall({ quiet: 60, nudges: state }), { action: "escalate", minutes: 60, count: 3, nudges: null });

  assert.equal(decideStall({ quiet: 30, nudges: nudged(1, 15) }, { ...STALL, stallNudges: 1 }).action, "escalate", "the limit is configurable");
  assert.equal(decideStall({ quiet: 15 }, { ...STALL, stallNudges: 0 }).action, "escalate", "no nudges: straight to the owner");
});

test("an answer to the nudge doesn't end the quiet stretch, but real activity does", () => {
  // The nudge was typed 15 minutes ago; the session said one line a minute later and went still again.
  let state = nudged(1, 15);
  const answered = decideStall({ quiet: 14, nudges: state });
  assert.deepEqual(answered, { action: "none", nudges: state }, "not still for a threshold yet, and the count is kept");
  state = nudged(1, 16);
  assert.equal(decideStall({ quiet: 15, nudges: state }).nudges.count, 2, "a threshold after its answer, it's nudged again");
  state = nudged(3, 16);
  assert.equal(decideStall({ quiet: 15, nudges: state }).action, "escalate", "three answers and no work reach the owner");

  // The session went back to work: its screen was still changing well after the nudge.
  state = nudged(2, 20);
  assert.deepEqual(decideStall({ quiet: 0, nudges: state }), { action: "none", nudges: null }, "working now");
  assert.deepEqual(decideStall({ quiet: 10, nudges: state }), { action: "none", nudges: null }, "worked for 10 minutes, then stopped");
  const again = decideStall({ quiet: 15, nudges: nudged(3, 30) });
  assert.equal(again.action, "nudge", "a new stretch starts at the first nudge, not at the owner");
  assert.equal(again.nudges.count, 1);
  assert.equal(again.minutes, 15);
});

test("the messages say how long and how many", () => {
  assert.match(runner.stallNudge({ id: 7 }, 15.4), /^Runner check: this session has been quiet for 15 minutes and CC-7 isn't finished\..*ask_human/);
  assert.match(runner.stallQuestion(60.2, 3), /^The session went quiet 60 minutes ago and 3 nudges didn't/);
  assert.match(runner.stallQuestion(15, 1), /and 1 nudge didn't/);
});

const typedInto = (w) =>
  readFileSync(join(home, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter(([cmd, , ref]) => cmd === "send" && ref === w.ref).map((args) => args.at(-1));
const events = (t, kind) => db(`task_events?task_id=eq.${t.id}&kind=eq.${kind}&select=body&order=id`);
// A threshold of a second: longer than a nudge takes to type and record, so the next look is too soon.
const STALL_MS = 1000;
const QUICK = { stallMinutes: STALL_MS / MIN, stallNudges: 2, stallReplyMinutes: STALL_MS / 5 / MIN };
const stalled = () => new Promise((r) => setTimeout(r, STALL_MS * 1.2));

test("a quiet session is nudged, then handed to the owner", async () => {
  const s = await session();
  const [t] = await tasks();
  const check = () => runner.checkStalled(t, s.window.ref, 0, QUICK);

  assert.equal(await check(), "none", "first look");
  await stalled();
  assert.equal(await check(), "nudge");
  assert.equal(await check(), "none", "not again straight away");
  assert.equal(typedInto(s.window).length, 1);
  assert.match(typedInto(s.window)[0], new RegExp(`^Runner check: .* CC-${s.id} isn't finished`));
  assert.equal(await statusOf(s), "in_progress");

  await stalled();
  assert.equal(await check(), "nudge");
  await stalled();
  assert.equal(await check(), "escalate");
  assert.equal(typedInto(s.window).length, 2, "nothing is typed when it goes to the owner");
  const [now] = await db(`tasks?id=eq.${s.id}&select=status,question`);
  assert.equal(now.status, "needs_you");
  assert.match(now.question, /^The session went quiet \d+ minutes ago and 2 nudges didn't/);
  assert.deepEqual((await events(s, "note")).map((e) => e.body.slice(0, 37)), ["runner nudged the session (1 of 2): i", "runner nudged the session (2 of 2): i"]);
  assert.equal((await events(s, "question")).at(-1).body, now.question);
});

test("a session that goes back to work starts a new count", async () => {
  const s = await session();
  const [t] = await tasks();
  const check = () => runner.checkStalled(t, s.window.ref, 0, QUICK);

  await check();
  await stalled();
  assert.equal(await check(), "nudge");
  await stalled();
  assert.equal(await check(), "nudge");
  await stalled();
  s.window.screen = "✻ Generating the voiceover… (3s)";
  show();
  assert.equal(await check(), "none", "working");
  await stalled();
  assert.equal(await check(), "nudge", "quiet again: a nudge, not the owner");
  assert.equal(await statusOf(s), "in_progress");
});

test("a task that has just asked something isn't nudged out of needs_you", async () => {
  const s = await session();
  const [stale] = await tasks();
  await runner.checkStalled(stale, s.window.ref, 0, QUICK);
  await stalled();
  // The session's hook moved it after this poll read the tasks.
  await db(`tasks?id=eq.${s.id}`, { method: "PATCH", body: { status: "needs_you", question: "Which cut?" } });
  assert.equal(await runner.checkStalled(stale, s.window.ref, 0, QUICK), "none");
  assert.deepEqual(typedInto(s.window), []);
  assert.equal((await db(`tasks?id=eq.${s.id}&select=question`))[0].question, "Which cut?");
});

test("the poll leaves working, waiting and review sessions alone at the default threshold", async () => {
  const working = await session();
  const asked = await session({ status: "needs_you", question: "Which cut?" });
  const published = await session();
  await publish(published);
  await dispatch();
  await idle();
  await dispatch();
  for (const s of [working, asked, published]) assert.deepEqual(typedInto(s.window), []);
});

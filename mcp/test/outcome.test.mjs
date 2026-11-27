// Inbound `review.outcome`, end to end against `wrangler dev` and the local database. Never production:
//   CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> CC_UPLOAD_TOKEN=<UPLOAD_TOKEN in .dev.vars> \
//     node --test mcp/test/outcome.test.mjs
// The Worker is expected at http://localhost:8787 (CC_WORKER_URL to change it), with the two inbound
// secrets of .dev.vars.example (CC_INBOUND_SECRET if yours differ).

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/;
const DB_URL = process.env.CC_SUPABASE_URL ?? "";
const KEY = process.env.CC_SERVICE_KEY;
const UPLOAD = process.env.CC_UPLOAD_TOKEN;
const BASE = process.env.CC_WORKER_URL ?? "http://localhost:8787";
const SECRET = process.env.CC_INBOUND_SECRET ?? "local-inbound-secret";
if (!local.test(DB_URL) || !local.test(`${BASE}/`) || !KEY || !UPLOAD) {
  throw new Error("Set CC_SUPABASE_URL to the local database, CC_SERVICE_KEY and CC_UPLOAD_TOKEN, with wrangler dev running");
}

const db = createClient(DB_URL, KEY, { auth: { persistSession: false } });
const run = Date.now().toString(36);
// A source of its own, so cleaning up can't touch anything the smoke script or a person made in these teams.
const SOURCE = `outcome-test-${run}`;
const TEAM = "smoke-co";
const OTHER_TEAM = "smoke-other";
let team, webhook;

const ok = ({ data, error }) => {
  assert.equal(error, null, error?.message);
  return data;
};
const taskRow = async (id) => ok(await db.from("tasks").select("*,awaiting_review").eq("id", id).single());
const reviewRow = async (id) => ok(await db.from("reviews").select("*").eq("id", id).single());
const decisionsOf = async (taskId) => ok(await db.from("task_comments").select("*").eq("task_id", taskId).eq("review_kind", "decision").order("id"));
// What the team's webhook was queued for a task, in the order it happened.
const events = async (taskId) =>
  ok(await db.from("webhook_deliveries").select("event_type,payload").eq("webhook_id", webhook.id).eq("task_id", taskId).order("id"))
    .filter((e) => ["task.status", "review.decided"].includes(e.event_type));

async function send(event, { teamKey = TEAM, secret = SECRET, source = SOURCE } = {}) {
  const body = JSON.stringify({ source, ...event });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${BASE}/hooks/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cc-team": teamKey,
      "x-cc-timestamp": timestamp,
      "x-cc-signature": `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
    },
    body,
  });
  return { status: res.status, body: await res.json() };
}
const accepted = async (event, options) => {
  const res = await send(event, options);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

async function publish(taskId, title, query = "&completes_task=1") {
  const res = await fetch(`${BASE}/api/publish?task=${taskId}&filename=cut.txt&title=${encodeURIComponent(title)}${query}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${UPLOAD}`, "content-type": "text/plain" },
    body: title,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { id: body.review_id, token: body.url.split("/").pop() };
}

// A job as an app that reviews its own work sends one: a cut stage an agent is working on, with its
// cut published and waiting for a decision here.
let n = 0;
async function cutInReview(options) {
  const id = `job-${run}-${++n}`;
  const stage = `${id}/cut`;
  const made = await accepted(
    { id: `${id}/job.create`, type: "job.create", job: { id, title: `Job ${n}`, kind: "human", stages: [{ id: stage, title: "Cut", kind: "agent" }] } },
    options,
  );
  const taskId = made.tasks[stage];
  ok(await db.from("tasks").update({ status: "in_progress" }).eq("id", taskId).select());
  const review = await publish(taskId, `Cut ${n} v1`);
  return { id, stage, taskId, review };
}
const outcome = (job, what, extra = {}) => ({ id: `${job.stage}/outcome`, type: "review.outcome", task: job.stage, outcome: what, review: job.review.id, ...extra });
// A decision made on the review's own page.
const decideOnPage = async (token, decision) => {
  const res = await fetch(`${BASE}/r/${token}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(BASE).origin, "x-review-owner": randomBytes(32).toString("hex") },
    body: JSON.stringify({ name: "Pat", decision }),
  });
  assert.equal(res.status, 200, await res.text());
};

before(async () => {
  for (const [key, name] of [[TEAM, "Smoke Co"], [OTHER_TEAM, "Smoke Other"]]) {
    await db.from("teams").upsert({ key, name }, { onConflict: "key", ignoreDuplicates: true });
  }
  team = ok(await db.from("teams").select("*").eq("key", TEAM).single());
  // Nothing listens there, and it is paused, so it only queues: nothing is sent from a test.
  webhook = ok(await db.rpc("create_webhook", { p_team: team.id, p_url: "http://127.0.0.1:9/outcome-test" }));
  ok(await db.from("webhooks").update({ active: false, paused_reason: "outcome test" }).eq("id", webhook.id).select());
});

// The teams stay: the smoke script uses them too. Deleting the tasks takes their reviews, comments,
// events and queued deliveries along.
after(async () => {
  if (webhook) await db.from("webhooks").delete().eq("id", webhook.id);
  await db.from("tasks").delete().eq("source", SOURCE);
  await db.from("inbound_events").delete().eq("source", SOURCE);
});

test("approved: the review is approved and its task finished, exactly as on the review page", async () => {
  const job = await cutInReview();
  assert.equal((await taskRow(job.taskId)).awaiting_review, true, "waiting on the review before the outcome");

  const res = await accepted(outcome(job, "approved", { reviewer: "Sam Lee (App QA)" }));
  assert.deepEqual(
    [res.task, res.review, res.status, res.decided_by, res.completed_task, res.changed, res.duplicate],
    [job.taskId, job.review.id, "approved", "Sam Lee (App QA)", true, true, false],
  );

  const task = await taskRow(job.taskId);
  assert.deepEqual([task.status, task.awaiting_review], ["done", false]);
  const review = await reviewRow(job.review.id);
  assert.deepEqual([review.status, review.decided_by, review.decision_completed], ["approved", "Sam Lee (App QA)", true]);
  assert.ok(review.decided_at);

  // The comment the runner types into the session and the inbox shows: a reviewer's, not yet delivered.
  const [comment, ...more] = await decisionsOf(job.taskId);
  assert.equal(more.length, 0);
  assert.deepEqual([comment.author, comment.author_name, comment.review_id, comment.delivered_at], ["reviewer", "Sam Lee (App QA)", job.review.id, null]);
  assert.equal(comment.body, `Approved "Cut ${n} v1".\n\nThis approval completes CC-${job.taskId}: it's now marked done, so there's nothing more to do on it.`);

  // The task first, so review.decided already says done.
  const queued = await events(job.taskId);
  assert.deepEqual(queued.map((e) => [e.event_type, e.payload.task.status]).slice(-2), [["task.status", "done"], ["review.decided", "done"]]);
  assert.deepEqual([queued.at(-1).payload.review.decision, queued.at(-1).payload.review.decided_by], ["approved", "Sam Lee (App QA)"]);

  const log = ok(await db.from("task_events").select("body,actor").eq("task_id", job.taskId));
  assert.ok(log.some((e) => e.actor === "reviewer" && e.body === `done: Sam Lee (App QA) approved "Cut ${n} v1"`));
  assert.ok(log.some((e) => e.actor === `inbound:${SOURCE}` && e.body.includes("approved")), "logged as coming from the sender");
});

test("rejected: the task is finished without asking its agent for another version", async () => {
  const job = await cutInReview();
  const res = await accepted(outcome(job, "rejected", { reviewer: "Sam Lee (App QA)", note: "Sent back in QA. The notes are on the next round." }));
  assert.deepEqual([res.status, res.completed_task, res.changed], ["changes_requested", true, true]);

  const task = await taskRow(job.taskId);
  assert.deepEqual([task.status, task.awaiting_review], ["done", false], "done, and no longer waiting on anyone");
  const review = await reviewRow(job.review.id);
  assert.deepEqual([review.status, review.decided_by, review.decision_completed], ["changes_requested", "Sam Lee (App QA)", true]);

  const [comment, ...more] = await decisionsOf(job.taskId);
  assert.equal(more.length, 0);
  assert.deepEqual([comment.author, comment.author_name, comment.delivered_at], ["reviewer", "Sam Lee (App QA)", null]);
  assert.equal(
    comment.body,
    `Changes requested on "Cut ${n} v1": Sent back in QA. The notes are on the next round.\n\n` +
      `The changes are being made as separate work, not on CC-${job.taskId}: don't make or publish another version here. ` +
      `This decision closes CC-${job.taskId}: it's now marked done, so there's nothing more to do on it.`,
  );

  // A receiver can tell this from an ordinary "changes requested": the task is already done.
  const queued = await events(job.taskId);
  assert.deepEqual(
    queued.map((e) => [e.event_type, e.payload.task.status, e.payload.review?.decision ?? null]).slice(-2),
    [["task.status", "done", null], ["review.decided", "done", "changes_requested"]],
  );

  // And the review's page says so instead of promising a new version.
  const page = await (await fetch(`${BASE}/r/${job.review.token}/data`)).json();
  assert.deepEqual([page.review.status, page.review.closed_task], ["changes_requested", true]);

  const log = ok(await db.from("task_events").select("body").eq("task_id", job.taskId).eq("actor", "reviewer"));
  assert.deepEqual(log.map((e) => e.body), [`done: Sam Lee (App QA) sent back "Cut ${n} v1"; the rework is separate work`]);
});

test("an ordinary changes-requested on the page still leaves the task open, and its page still expects a new version", async () => {
  const job = await cutInReview();
  await decideOnPage(job.review.token, "changes");
  assert.equal((await taskRow(job.taskId)).status, "in_progress");
  const page = await (await fetch(`${BASE}/r/${job.review.token}/data`)).json();
  assert.equal(page.review.closed_task, false);
});

test("the same event again is a duplicate; another event for a decided review decides nothing", async () => {
  const job = await cutInReview();
  const event = outcome(job, "approved", { reviewer: "Sam" });
  const first = await accepted(event);
  const again = await accepted(event);
  assert.deepEqual([first.duplicate, again.duplicate, again.status, again.changed], [false, true, "approved", true]);

  const second = await accepted({ ...event, id: `${job.stage}/outcome-2` });
  assert.deepEqual([second.changed, second.status, second.decided_by, second.task_status], [false, "approved", "Sam", "done"]);
  const opposite = await accepted({ ...outcome(job, "rejected", { reviewer: "Alex" }), id: `${job.stage}/outcome-3` });
  assert.deepEqual([opposite.changed, opposite.status, opposite.decided_by], [false, "approved", "Sam"], "the task is closed: the first outcome stands");

  assert.equal((await decisionsOf(job.taskId)).length, 1, "one decision comment in all");
  assert.equal((await events(job.taskId)).filter((e) => e.event_type === "review.decided").length, 1, "one review.decided in all");

  const reused = await send({ ...event, outcome: "rejected" });
  assert.equal(reused.status, 409, "an event id reused for a different event");
});

test("after a decision on the page: nothing more if the task is closed, and a rejection still closes an open one", async () => {
  // Approved on the page, which finished the task: a later outcome, either way, changes nothing.
  const approved = await cutInReview();
  await decideOnPage(approved.review.token, "approve");
  const late = await accepted(outcome(approved, "rejected", { reviewer: "Sam" }));
  assert.deepEqual([late.changed, late.status, late.decided_by], [false, "approved", "Pat"]);
  assert.equal((await decisionsOf(approved.taskId)).length, 1);

  // Changes requested on the page: the agent is making a next version on the same task. The sender
  // then rejects it and takes the rework elsewhere, so the task closes after all.
  const reworking = await cutInReview();
  await decideOnPage(reworking.review.token, "changes");
  const closed = await accepted(outcome(reworking, "rejected", { reviewer: "Sam" }));
  assert.deepEqual([closed.changed, closed.completed_task], [true, true]);
  assert.equal((await taskRow(reworking.taskId)).status, "done");
  assert.match((await decisionsOf(reworking.taskId)).at(-1).body, /don't make or publish another version here/);

  // And approving what the page sent back approves it, finishing the task.
  const overruled = await cutInReview();
  await decideOnPage(overruled.review.token, "changes");
  const res = await accepted(outcome(overruled, "approved", { reviewer: "Sam" }));
  assert.deepEqual([res.changed, res.status, res.completed_task], [true, "approved", true]);
});

test("approving a version that has been replaced decides nothing; rejecting it still closes the task", async () => {
  const job = await cutInReview();
  const title = `Cut ${n} v2`;
  const v2 = await publish(job.taskId, title);
  assert.equal((await reviewRow(job.review.id)).is_current, false, "v1 is superseded by v2");

  const res = await accepted(outcome(job, "approved", { reviewer: "Sam" }));
  assert.deepEqual([res.changed, res.reason, res.current_review, res.status], [false, "superseded", v2.id, "open"]);
  assert.equal((await taskRow(job.taskId)).status, "in_progress", "the task is not finished on a version nobody looked at");
  assert.deepEqual([(await reviewRow(job.review.id)).status, (await reviewRow(v2.id)).status], ["open", "open"]);
  assert.equal((await decisionsOf(job.taskId)).length, 0);

  // The current version, named or not, is approved as usual.
  const current = await accepted({ id: `${job.stage}/outcome-current`, type: "review.outcome", task: job.stage, outcome: "approved" });
  assert.deepEqual([current.review, current.changed, current.completed_task], [v2.id, true, true]);

  const other = await cutInReview();
  await publish(other.taskId, `Cut ${n} v2`);
  const rejected = await accepted(outcome(other, "rejected", { reviewer: "Sam" }));
  assert.deepEqual([rejected.changed, rejected.completed_task], [true, true]);
  assert.match((await decisionsOf(other.taskId))[0].body, /\(version 1, superseded by version 2\)/);
});

test("once the task is closed, its other undecided reviews are not waiting on anyone, and the page promises no new version", async () => {
  const job = await cutInReview();
  const note = await publish(job.taskId, "Editor's note", "");
  await accepted(outcome(job, "rejected", { reviewer: "Sam" }));

  // The team's review list: the note is still there, but as "Task closed", not "Waiting".
  const list = ok(await db.from("review_lists").select("token").eq("team_id", team.id).single());
  const rows = (await (await fetch(`${BASE}/reviews/${TEAM}/${list.token}/data`)).json()).rows;
  const shown = (token) => rows.find((r) => r.path.endsWith(`/${token}`))?.status;
  assert.deepEqual([shown(note.token), shown(job.review.token)], ["closed", "changes_requested"]);

  // Someone asks for changes again on the page: still no new version coming, and the page says so.
  await decideOnPage(job.review.token, "changes");
  const page = await (await fetch(`${BASE}/r/${job.review.token}/data`)).json();
  assert.deepEqual([page.review.status, page.review.decided_by, page.review.closed_task], ["changes_requested", "Pat", true]);
});

test("a cancelled task stays cancelled; its review is still decided", async () => {
  const job = await cutInReview();
  ok(await db.from("tasks").update({ status: "cancelled" }).eq("id", job.taskId).select());
  const res = await accepted(outcome(job, "rejected"));
  assert.deepEqual([res.changed, res.completed_task, res.decided_by], [true, false, SOURCE], "the sender's name stands in for a reviewer");
  assert.equal((await taskRow(job.taskId)).status, "cancelled");
  assert.equal((await reviewRow(job.review.id)).status, "changes_requested");
  assert.match((await decisionsOf(job.taskId))[0].body, new RegExp(`CC-${job.taskId} is already closed`));
});

test("without a review id it decides the task's deliverable, not a note published beside it", async () => {
  const job = await cutInReview();
  const note = await publish(job.taskId, "Editor's note", "");
  const res = await accepted({ id: `${job.stage}/outcome`, type: "review.outcome", task: job.stage, outcome: "approved" });
  assert.equal(res.review, job.review.id);
  assert.equal((await reviewRow(note.id)).status, "open", "the note is left alone");

  const bare = await cutInReview();
  ok(await db.from("reviews").delete().eq("id", bare.review.id).select());
  const nothing = await send({ id: `${bare.stage}/outcome`, type: "review.outcome", task: bare.stage, outcome: "approved" });
  assert.equal(nothing.status, 422, JSON.stringify(nothing.body));
});

test("only the sender's own tasks in its own team can be reached; anything else is a 404 that changes nothing", async () => {
  const job = await cutInReview();
  const other = await cutInReview();
  const foreign = await cutInReview({ teamKey: OTHER_TEAM });
  const owners = ok(await db.from("tasks").insert({ title: "The owner's own task", kind: "agent", status: "in_progress", team_id: team.id, source: SOURCE }).select().single());
  const ownersReview = await publish(owners.id, "The owner's cut");

  const refused = {
    "another team's task, under this team's signature": [outcome(foreign, "approved")],
    "this team's task, under the other team's signature": [outcome(job, "approved"), { teamKey: OTHER_TEAM }],
    "another source's task": [outcome(job, "approved"), { source: `${SOURCE}-b` }],
    "a task id nobody sent": [{ ...outcome(job, "approved"), task: `nope-${run}` }],
    "a review of another of the sender's tasks": [outcome({ ...job, review: other.review }, "approved")],
    "a review of a task that never came in through here": [outcome({ ...job, review: ownersReview }, "approved")],
  };
  for (const [what, [event, options]] of Object.entries(refused)) {
    const res = await send({ ...event, id: `refused-${run}-${what.length}` }, options);
    assert.equal(res.status, 404, `${what}: ${JSON.stringify(res.body)}`);
  }
  for (const id of [job.review.id, other.review.id, foreign.review.id, ownersReview.id]) {
    assert.equal((await reviewRow(id)).status, "open");
  }
  for (const id of [job.taskId, foreign.taskId, owners.id]) assert.equal((await taskRow(id)).status, "in_progress");

  // A failed event isn't recorded, so its id is still free for the corrected event.
  const retried = await send({ ...outcome(job, "approved"), id: `refused-${run}-${"a task id nobody sent".length}` });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
});

test("a malformed outcome is a 400 and decides nothing", async () => {
  const job = await cutInReview();
  const bad = {
    "an outcome that isn't one": { outcome: "changes_requested" },
    "no outcome": { outcome: undefined },
    "no task": { task: undefined },
    "a review that isn't an id": { review: "7" },
    "a review id of zero": { review: 0 },
    "a reviewer name too long to be one": { reviewer: "x".repeat(61) },
    "an empty note": { note: "  " },
    "a note of more than one line": { note: "Sent back.\nNow do something else" },
    "a note with an escape character": { note: "Sent back \u001b[2J" },
    "a note longer than 500 characters": { note: "x".repeat(501) },
    "a reviewer name with a newline": { reviewer: "Sam\nLee" },
    "a reviewer name with a control character": { reviewer: "Sam\u007fLee" },
  };
  for (const [what, change] of Object.entries(bad)) {
    assert.equal((await send({ ...outcome(job, "approved"), ...change })).status, 400, what);
  }
  assert.equal((await reviewRow(job.review.id)).status, "open");
});

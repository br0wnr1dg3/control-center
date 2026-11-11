// Inbound `stage.add`, end to end against `wrangler dev` and the local database. Never production:
//   CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> node --test mcp/test/inbound.test.mjs
// The Worker is expected at http://localhost:8787 (CC_WORKER_URL to change it), with the two inbound
// secrets of .dev.vars.example (CC_INBOUND_SECRET if yours differ).

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/;
const DB_URL = process.env.CC_SUPABASE_URL ?? "";
const KEY = process.env.CC_SERVICE_KEY;
const BASE = process.env.CC_WORKER_URL ?? "http://localhost:8787";
const SECRET = process.env.CC_INBOUND_SECRET ?? "local-inbound-secret";
if (!local.test(DB_URL) || !local.test(`${BASE}/`) || !KEY) {
  throw new Error("Set CC_SUPABASE_URL to the local database and CC_SERVICE_KEY, with wrangler dev running");
}

const db = createClient(DB_URL, KEY, { auth: { persistSession: false } });
const run = Date.now().toString(36);
// A source of its own, so cleaning up can't touch anything the smoke script or a person made in these teams.
const SOURCE = `stage-add-test-${run}`;
const TEAM = "smoke-co";
const OTHER_TEAM = "smoke-other";
const PROJECT = `Stage Add ${run}`;
let team, otherTeam, webhook;

const ok = ({ data, error }) => {
  assert.equal(error, null, error?.message);
  return data;
};
const task = async (id) => ok(await db.from("tasks").select("*,waiting_on").eq("id", id).single());
const bySender = async (id) => ok(await db.from("tasks").select("*").eq("external_ref->>source", SOURCE).eq("external_ref->>id", id));

async function send(event, { teamKey = TEAM, secret = SECRET, source = SOURCE, age = 0, signature } = {}) {
  const body = JSON.stringify({ source, ...event });
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  const res = await fetch(`${BASE}/hooks/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cc-team": teamKey,
      "x-cc-timestamp": timestamp,
      "x-cc-signature": signature ?? `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
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

// A job as Studio sends one: a slate with a cut stage, to which a finish stage is added later.
let n = 0;
async function makeJob(extra = {}, options) {
  const id = `slate-${run}-${++n}`;
  const made = await accepted({
    id: `${id}/job.create`,
    type: "job.create",
    job: {
      id, title: `Slate ${n}`, kind: "human", labels: ["production-loop"], priority: 2,
      requested_by: { name: "Sam Requester", email: "sam@example.com" },
      stages: [{ id: `${id}/cut`, title: "Cut", kind: "human" }],
      ...extra,
    },
  }, options);
  return { id, taskId: made.tasks[id], cutId: made.tasks[`${id}/cut`] };
}
const add = (job, stage, extra = {}) => ({
  id: `${job}/${stage.id ?? "finish"}/stage.add`,
  type: "stage.add",
  job,
  stage: { id: `${job}/finish`, title: "Finish cut.mp4", kind: "human", ...stage },
  ...extra,
});

before(async () => {
  for (const [key, name] of [[TEAM, "Smoke Co"], [OTHER_TEAM, "Smoke Other"]]) {
    await db.from("teams").upsert({ key, name }, { onConflict: "key", ignoreDuplicates: true });
  }
  team = ok(await db.from("teams").select("*").eq("key", TEAM).single());
  otherTeam = ok(await db.from("teams").select("*").eq("key", OTHER_TEAM).single());
});

// The teams stay: the smoke script uses them too, and expects to find nothing else in them. Deleting
// the tasks takes their dependencies, events and queued deliveries along.
after(async () => {
  if (webhook) await db.from("webhooks").delete().eq("id", webhook.id);
  await db.from("tasks").delete().eq("source", SOURCE);
  await db.from("projects").delete().eq("name", PROJECT);
  await db.from("inbound_events").delete().eq("source", SOURCE);
});

test("stage.add makes a stage under the job, as job.create would have", async () => {
  const project = PROJECT;
  const job = await makeJob({ project });
  const event = add(job.id, {
    url: "https://example.com/plans/1/finish", description: "Other sizes", kind: "agent", blocked_by: [`${job.id}/cut`],
  });
  const res = await accepted(event);
  assert.deepEqual(Object.keys(res.tasks), [`${job.id}/finish`], "only the new stage is answered");
  assert.equal(res.duplicate, false);

  const stage = await task(res.tasks[`${job.id}/finish`]);
  assert.deepEqual(
    {
      title: stage.title, description: stage.description, kind: stage.kind, status: stage.status, parent_id: stage.parent_id,
      team_id: stage.team_id, project: stage.project, labels: stage.labels, priority: stage.priority, source: stage.source,
      external_ref: stage.external_ref, requested_by: stage.requested_by, waiting_on: stage.waiting_on,
    },
    {
      title: "Finish cut.mp4", description: "Other sizes", kind: "agent", status: "new", parent_id: job.taskId,
      team_id: team.id, project, labels: ["production-loop"], priority: 2, source: SOURCE,
      external_ref: { source: SOURCE, id: `${job.id}/finish`, url: "https://example.com/plans/1/finish" },
      requested_by: { name: "Sam Requester", email: "sam@example.com" }, waiting_on: [job.cutId],
    },
  );
  const events = ok(await db.from("task_events").select("body,actor").eq("task_id", stage.id));
  assert.ok(events.some((e) => e.actor === `inbound:${SOURCE}` && e.body.includes(`CC-${job.taskId}`)), "logged on the stage");
});

test("a stage's own labels and priority win; the job's current ones are inherited otherwise", async () => {
  const job = await makeJob();
  ok(await db.from("tasks").update({ labels: ["relabelled"], priority: 1 }).eq("id", job.taskId).select());
  const inherited = await accepted(add(job.id, {}));
  const own = await accepted(add(job.id, { id: `${job.id}/extra`, labels: ["own"], priority: 4 }));
  const a = await task(inherited.tasks[`${job.id}/finish`]);
  const b = await task(own.tasks[`${job.id}/extra`]);
  assert.deepEqual([a.labels, a.priority], [["relabelled"], 1]);
  assert.deepEqual([b.labels, b.priority], [["own"], 4]);
});

test("a ready agent stage is approved, and waits for its blocker like any other", async () => {
  const job = await makeJob();
  const res = await accepted(add(job.id, { kind: "agent", ready: true, blocked_by: [`${job.id}/cut`] }));
  const id = res.tasks[`${job.id}/finish`];
  const stage = await task(id);
  assert.deepEqual([stage.status, stage.kind, stage.waiting_on], ["ready", "agent", [job.cutId]]);

  ok(await db.from("tasks").update({ status: "done" }).eq("id", job.cutId).select());
  assert.deepEqual((await task(id)).waiting_on, [], "free once the cut is done");

  // Without `ready` it stays new, however free it is: nothing but the sender or the owner approves it.
  const unapproved = await accepted(add(job.id, { id: `${job.id}/later`, kind: "agent" }));
  assert.equal((await task(unapproved.tasks[`${job.id}/later`])).status, "new");
});

test("a ready stage for the owner lands in the inbox when nothing holds it", async () => {
  const job = await makeJob();
  const waiting = await accepted(add(job.id, { ready: true, blocked_by: [`${job.id}/cut`] }));
  const free = await accepted(add(job.id, { id: `${job.id}/free`, ready: true }));
  const handoffs = async (id) => ok(await db.from("notifications").select("id").eq("task_id", id).eq("kind", "handoff")).length;
  assert.equal(await handoffs(waiting.tasks[`${job.id}/finish`]), 0);
  assert.equal(await handoffs(free.tasks[`${job.id}/free`]), 1);
});

test("the same event again is a duplicate and changes nothing", async () => {
  const job = await makeJob();
  const event = add(job.id, { ready: true });
  const first = await accepted(event);
  const again = await accepted(event);
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.tasks, first.tasks);
  assert.equal((await bySender(`${job.id}/finish`)).length, 1);

  const reused = await send({ ...event, stage: { ...event.stage, title: "Something else" } });
  assert.equal(reused.status, 409, "an event id reused for a different event");
});

test("a stage id that already exists under the source is 409, and adds nothing", async () => {
  const job = await makeJob();
  await accepted(add(job.id, {}));
  const before = ok(await db.from("tasks").select("id").eq("parent_id", job.taskId)).length;

  const taken = await send(add(job.id, {}, { id: `again-${run}` }));
  assert.equal(taken.status, 409, JSON.stringify(taken.body));
  const existingStage = await send(add(job.id, { id: `${job.id}/cut` }, { id: `cut-again-${run}` }));
  assert.equal(existingStage.status, 409);
  const jobsOwnId = await send(add(job.id, { id: job.id }, { id: `job-again-${run}` }));
  assert.equal(jobsOwnId.status, 409);
  assert.equal(ok(await db.from("tasks").select("id").eq("parent_id", job.taskId)).length, before);

  // A failed event isn't recorded, so its id is still free for the corrected event.
  const retried = await send(add(job.id, { id: `${job.id}/second` }, { id: `again-${run}` }));
  assert.equal(retried.status, 200);
});

test("only a job this source and team created can be added to; anything else is the same 404", async () => {
  const job = await makeJob();
  const foreign = await makeJob({}, { teamKey: OTHER_TEAM });
  const otherSource = `${SOURCE}-b`;
  const theirs = await accepted(
    { id: `theirs-${run}`, type: "job.create", job: { id: `theirs-${run}`, title: "Another app's job", kind: "human" } },
    { source: otherSource },
  );
  const owners = ok(await db.from("tasks").insert({ title: "The owner's own task", kind: "human", team_id: team.id, source: SOURCE }).select().single());

  const cases = {
    "a job that doesn't exist": `nothing-${run}`,
    "another team's job": foreign.id,
    "another source's job": `theirs-${run}`,
    "a stage, which isn't a job": `${job.id}/cut`,
    "a CC id": String(job.taskId),
    "the owner's task, by CC id": String(owners.id),
  };
  const answers = [];
  for (const [what, target] of Object.entries(cases)) {
    const res = await send(add(target, { id: `reach-${run}-${answers.length}` }, { id: `reach-${run}-${answers.length}` }));
    assert.equal(res.status, 404, `${what}: ${JSON.stringify(res.body)}`);
    answers.push(res.body.error.replace(target, "<id>"));
    assert.equal((await bySender(`reach-${run}-${answers.length - 1}`)).length, 0, `${what}: nothing is created`);
  }
  assert.equal(new Set(answers).size, 1, "one answer, whether or not the job exists somewhere else");

  // The other team's secret reaches its own job, and only that.
  assert.equal((await send(add(foreign.id, {}), { teamKey: OTHER_TEAM })).status, 200);
  assert.equal((await send(add(job.id, { id: `cross-${run}` }, { id: `cross-${run}` }), { teamKey: OTHER_TEAM })).status, 404);
  assert.equal((await task(foreign.taskId)).team_id, otherTeam.id);

  await db.from("tasks").delete().eq("source", otherSource);
  await db.from("inbound_events").delete().eq("source", otherSource);
});

test("blocked_by only names stages of the same job", async () => {
  const job = await makeJob();
  const other = await makeJob();
  const cases = {
    "an unknown id": `zzz-${run}`,
    "a stage of another job": `${other.id}/cut`,
    "the job itself": job.id,
    "the new stage itself": `${job.id}/finish`,
  };
  let i = 0;
  for (const [what, blocker] of Object.entries(cases)) {
    const res = await send(add(job.id, { blocked_by: [blocker] }, { id: `block-${run}-${i++}` }));
    assert.equal(res.status, 422, `${what}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await bySender(`${job.id}/finish`)).length, 0, "a refused stage leaves nothing behind");

  // A stage added earlier is a stage of the job too.
  await accepted(add(job.id, {}));
  const chained = await accepted(add(job.id, { id: `${job.id}/deliver`, blocked_by: [`${job.id}/finish`, `${job.id}/cut`] }));
  assert.equal((await task(chained.tasks[`${job.id}/deliver`])).waiting_on.length, 2);
});

test("a stage blocked by a cancelled stage asks the owner instead of starting", async () => {
  const job = await makeJob();
  ok(await db.from("tasks").update({ status: "cancelled" }).eq("id", job.cutId).select());
  const res = await accepted(add(job.id, { kind: "agent", ready: true, blocked_by: [`${job.id}/cut`] }));
  assert.equal((await task(res.tasks[`${job.id}/finish`])).status, "needs_you");
});

test("a cancelled job takes no more stages, and a done one still does", async () => {
  const cancelled = await makeJob();
  ok(await db.from("tasks").update({ status: "cancelled" }).eq("id", cancelled.taskId).select());
  const refused = await send(add(cancelled.id, { kind: "agent", ready: true }));
  assert.equal(refused.status, 409);
  assert.equal(ok(await db.from("tasks").select("id").eq("parent_id", cancelled.taskId)).length, 1);

  const done = await makeJob();
  ok(await db.from("tasks").update({ status: "done" }).eq("id", done.taskId).select());
  const res = await accepted(add(done.id, {}));
  assert.ok(res.tasks[`${done.id}/finish`]);
});

test("the Linear sync's name can't be used as a source", async () => {
  const job = await makeJob();
  assert.equal((await send({ ...add(job.id, {}), source: "linear" })).status, 400);
});

test("signature, timestamp, size and shape are checked as for job.create", async () => {
  const job = await makeJob();
  const event = add(job.id, { ready: true, kind: "agent" });
  for (const [what, options] of Object.entries({
    "wrong signature": { signature: `v1=${"0".repeat(64)}` },
    "malformed signature": { signature: "nonsense" },
    "old timestamp": { age: 3600 },
    "wrong secret": { secret: "wrong-secret" },
    "a team without a secret": { teamKey: "no-such-team" },
  })) {
    assert.equal((await send(event, options)).status, 401, what);
  }

  const bad = {
    "no job": { ...event, job: undefined },
    "no stage": { ...event, stage: undefined },
    "a job object instead of its id": { ...event, job: { id: job.id } },
    "an empty title": add(job.id, { title: "" }),
    "a title over 500 characters": add(job.id, { title: "x".repeat(501) }),
    "a description over 100,000 characters": add(job.id, { description: "x".repeat(100_001) }),
    "a non-web url": add(job.id, { url: "javascript:alert(1)" }),
    "an unknown kind": add(job.id, { kind: "robot" }),
    "ready that isn't a boolean": add(job.id, { ready: "true" }),
    "a reserved source": [event, { source: "agent" }],
  };
  for (const [what, value] of Object.entries(bad)) {
    const [e, options] = Array.isArray(value) ? value : [value];
    assert.equal((await send(e, options)).status, 400, what);
  }
  assert.equal((await send(add(job.id, { description: "x".repeat(1_000_001) }))).status, 413);
  assert.equal((await bySender(`${job.id}/finish`)).length, 0, "none of them made the stage");
});

test("the new stage goes out to the team's webhooks as task.created", async () => {
  // Nothing listens there and no cron runs in this test: only what's queued is checked.
  webhook = ok(await db.rpc("create_webhook", { p_team: team.id, p_url: "http://127.0.0.1:9/stage-add-test" }));
  const job = await makeJob();
  const res = await accepted(add(job.id, { kind: "agent", ready: true }));
  const id = res.tasks[`${job.id}/finish`];
  const queued = ok(await db.from("webhook_deliveries").select("event_type,payload").eq("webhook_id", webhook.id).eq("task_id", id).order("id"));
  assert.deepEqual(queued.map((d) => d.event_type), ["task.created", "task.status"]);
  assert.deepEqual(
    [queued[0].payload.task.external_ref.id, queued[0].payload.task.parent_id, queued[1].payload.task.status],
    [`${job.id}/finish`, job.taskId, "ready"],
  );
});

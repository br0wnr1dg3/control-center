// Review batches, end to end against `wrangler dev` and the local database. Never production:
//   CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> CC_UPLOAD_TOKEN=<UPLOAD_TOKEN in .dev.vars> \
//     node --test mcp/test/batch.test.mjs
// The Worker is expected at http://localhost:8787 (CC_WORKER_URL to change it).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/;
const DB_URL = process.env.CC_SUPABASE_URL ?? "";
const KEY = process.env.CC_SERVICE_KEY;
const UPLOAD = process.env.CC_UPLOAD_TOKEN;
const BASE = process.env.CC_WORKER_URL ?? "http://localhost:8787";
if (!local.test(DB_URL) || !local.test(`${BASE}/`) || !KEY || !UPLOAD) {
  throw new Error("Set CC_SUPABASE_URL to the local database, CC_SERVICE_KEY and CC_UPLOAD_TOKEN, with wrangler dev running");
}

const db = createClient(DB_URL, KEY, { auth: { persistSession: false } });
const run = Date.now().toString(36);
const CC_PUBLISH = fileURLToPath(new URL("../../runner/bin/cc-publish", import.meta.url));
let team, dir;

const ok = ({ data, error }) => {
  assert.equal(error, null, error?.message);
  return data;
};
const addTask = async (title, extra = {}) =>
  ok(await db.from("tasks").insert({ title, kind: "agent", status: "in_progress", team_id: team.id, source: "batch-test", ...extra }).select().single());
const task = async (id) => ok(await db.from("tasks").select("*").eq("id", id).single());

async function publish(taskId, title, query = "") {
  const res = await fetch(`${BASE}/api/publish?task=${taskId}&filename=cut.txt&title=${encodeURIComponent(title)}${query}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${UPLOAD}`, "content-type": "text/plain" },
    body: title,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { ...body, token: body.url.split("/").pop() };
}
const makeBatch = (body, token = UPLOAD) =>
  fetch(`${BASE}/api/batches`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const madeBatch = async (body) => {
  const res = await makeBatch(body);
  const made = await res.json();
  assert.equal(res.status, 200, JSON.stringify(made));
  return { ...made, token: made.url.split("/").pop() };
};
const batchData = async (token) => (await fetch(`${BASE}/b/${token}/data`)).json();
// What both pages send when a reviewer decides.
const decide = (token, decision, message) =>
  fetch(`${BASE}/r/${token}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sam", decision, message }) });
const titles = (data) => data.items.map((i) => i.title);

before(async () => {
  team = ok(await db.from("teams").insert({ key: `batch-${run}`, name: `Batch test ${run}` }).select().single());
  dir = mkdtempSync(join(tmpdir(), "cc-batch-"));
});

// Deleting the team's tasks takes their reviews, batches made for them, comments and notifications along.
after(async () => {
  await db.from("review_batches").delete().eq("team_id", team.id);
  await db.from("tasks").delete().eq("team_id", team.id);
  await db.from("teams").delete().eq("id", team.id);
  rmSync(dir, { recursive: true, force: true });
});

test("a batch for a parent task gathers the open reviews under it, the latest version of each", async () => {
  const parent = await addTask("Monday's videos");
  const a = await addTask("Video A", { parent_id: parent.id });
  const b = await addTask("Video B", { parent_id: parent.id });
  const elsewhere = await addTask("Not part of it");
  await publish(a.id, "Cut v1");
  await publish(a.id, "Cut v2 · 9:16");
  const decided = await publish(b.id, "Cut v1");
  assert.equal((await decide(decided.token, "approve")).status, 200);
  await publish(b.id, "Thumbnail");
  await publish(elsewhere.id, "Unrelated");

  const batch = await madeBatch({ title: "Monday", parent: `CC-${parent.id}` });
  assert.equal(batch.reviews, 2);
  assert.match(batch.url, new RegExp(`/b/${team.key}/[\\w-]{20,}$`), "the link names the parent's team");
  const data = await batchData(batch.token);
  assert.deepEqual(titles(data).sort(), ["Cut v2 · 9:16", "Thumbnail"]);
  assert.deepEqual(data.batch, { title: "Monday", team: { key: team.key, name: team.name } });
  const item = data.items.find((i) => i.title === "Thumbnail");
  assert.deepEqual({ ...item, token: null }, {
    token: null, title: "Thumbnail", status: "open", decided_by: null, content_type: "text/plain", filename: "cut.txt",
    completes_task: false, notes: 0, task: { id: b.id, title: "Video B" },
  });
  assert.deepEqual((await task(parent.id)).links, [{ title: "Review batch: Monday", url: batch.url }], "the link is attached to the parent");

  // Asking again tops the same batch up instead of making another.
  await publish(b.id, "Cut v2");
  const again = await madeBatch({ title: "Monday", parent: parent.id });
  assert.equal(again.url, batch.url);
  assert.deepEqual([again.reviews, again.added], [3, 3]);
  assert.equal((await task(parent.id)).links.length, 1);

  const page = await fetch(batch.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Monday · Review batch<\/title>/);
  const bare = await fetch(`${BASE}/b/${batch.token}`, { redirect: "manual" });
  assert.equal(bare.headers.get("location"), batch.url, "/b/<token> goes to the address naming the team");
});

test("a batch for a label gathers open reviews on tasks carrying it", async () => {
  const label = `dailies-${run}`;
  const one = await addTask("Labelled one", { labels: [label, "video"] });
  const two = await addTask("Labelled two", { labels: [label] });
  const other = await addTask("Other label", { labels: ["video"] });
  await publish(one.id, "One");
  await publish(two.id, "Two");
  await publish(other.id, "Three");

  const batch = await madeBatch({ title: "Dailies", label, team: team.key });
  assert.deepEqual(titles(await batchData(batch.token)).sort(), ["One", "Two"]);
  assert.ok(batch.url.includes(`/b/${team.key}/`));
  assert.deepEqual((await task(one.id)).links.filter((l) => /batch/i.test(l.title)), [], "no task owns a label batch");
  // Label batches aren't named: the same title again is a new link.
  assert.notEqual((await madeBatch({ title: "Dailies", label, team: team.key })).url, batch.url);

  assert.equal((await makeBatch({ title: "None", label: `nothing-${run}`, team: team.key })).status, 404);

  // A label alone would gather every team's reviews under one link.
  const teamless = await makeBatch({ title: "Every team", label });
  assert.equal(teamless.status, 400);
  assert.match((await teamless.json()).error, /team is required/);
  // Another team's tasks with the same label stay out.
  const otherTeam = ok(await db.from("teams").insert({ key: `batch-other-${run}`, name: "Other" }).select().single());
  try {
    const theirs = await addTask("Their cut", { labels: [label], team_id: otherTeam.id });
    await publish(theirs.id, "Theirs");
    assert.deepEqual(titles(await batchData((await madeBatch({ title: "Dailies", label, team: team.key })).token)).sort(), ["One", "Two"]);
    assert.deepEqual(titles(await batchData((await madeBatch({ title: "Dailies", label, team: otherTeam.key })).token)), ["Theirs"]);
  } finally {
    await db.from("review_batches").delete().eq("team_id", otherTeam.id);
    await db.from("tasks").delete().eq("team_id", otherTeam.id);
    await db.from("teams").delete().eq("id", otherTeam.id);
  }

  // Labels are slugs: anything else would mean something else inside the array filter.
  for (const bad of [`${label},video`, `${label}}`, "{video}", "two words", "-leading", "", 7]) {
    const res = await makeBatch({ title: "Bad label", label: bad, team: team.key });
    assert.equal(res.status, 400, `label ${JSON.stringify(bad)}`);
    assert.match((await res.json()).error, /label must be/);
  }
  assert.equal((await makeBatch({ title: "Upper case is folded", label: label.toUpperCase(), team: team.key })).status, 200);
  assert.equal((await makeBatch({ title: "Wrong team", label, team: "no-such-team" })).status, 404);
  assert.equal((await makeBatch({ title: "Dailies", label, team: team.key }, "wrong-token")).status, 401);
  assert.equal((await makeBatch({ label, team: team.key })).status, 400, "a title is required");
  assert.equal((await makeBatch({ title: "Two sources", label, team: team.key, parent: one.id })).status, 400);
  assert.equal((await fetch(`${BASE}/b/${"x".repeat(32)}`)).status, 404);
});

test("cc-publish --batch puts sub-tasks' cuts in one batch for their parent, each cut once", async () => {
  const parent = await addTask("Tuesday's videos");
  const a = await addTask("Video A", { parent_id: parent.id });
  const b = await addTask("Video B", { parent_id: parent.id });
  const file = join(dir, "cut.md");
  writeFileSync(file, "# A cut\n");
  const ccPublish = async (...args) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CC_PUBLISH, file, ...args], {
      env: { ...process.env, CC_PUBLIC_URL: BASE, CC_UPLOAD_TOKEN: UPLOAD },
    });
    return { review: stdout.trim(), batch: stderr.match(/\S+\/b\/\S+/)?.[0] };
  };

  const first = await ccPublish("--task", String(a.id), "--title", "Cut v1", "--batch", "Tuesday");
  assert.match(first.review, /\/r\/[\w-]+\/[\w-]{20,}$/, "stdout is still just the review link");
  assert.ok(first.batch, "the batch link is printed too");
  const second = await ccPublish("--task", `CC-${b.id}`, "--title", "Cut v1", "--batch", "Tuesday");
  assert.equal(second.batch, first.batch, "a sibling's cut joins the same batch");
  const token = first.batch.split("/").pop();
  assert.deepEqual((await batchData(token)).items.map((i) => i.task.id), [a.id, b.id]);

  const next = await ccPublish("--task", String(a.id), "--title", "Cut v2", "--batch", "Tuesday");
  assert.equal(next.batch, first.batch);
  assert.deepEqual((await batchData(token)).items.map((i) => `${i.task.title}: ${i.title}`), ["Video B: Cut v1", "Video A: Cut v2"], "v2 replaces v1");
  assert.deepEqual((await task(parent.id)).links.map((l) => l.url), [first.batch], "attached to the parent once");

  // A task without a parent keeps its own batch.
  const solo = await addTask("On its own");
  const alone = await publish(solo.id, "Cut", "&batch=Tuesday");
  assert.notEqual(alone.batch_url, first.batch);
  assert.deepEqual((await task(solo.id)).links, [{ title: "Cut", url: alone.url }, { title: "Review batch: Tuesday", url: alone.batch_url }], "the review link and the batch link are both on the task");
});

test("links added to one task at the same moment are all kept", async () => {
  // Sub-tasks' first publishes into a new batch each read-modify-wrote the parent's links; so did two publishes on one task.
  const parent = await addTask("Wednesday's videos");
  const subs = await Promise.all(["A", "B", "C", "D"].map((n) => addTask(`Video ${n}`, { parent_id: parent.id })));
  const published = await Promise.all([
    ...subs.map((s) => publish(s.id, "Cut v1", "&batch=Wednesday")),
    ...["One", "Two", "Three", "Four"].map((t) => publish(parent.id, t, "&batch=Wednesday")),
  ]);
  assert.equal(new Set(published.map((p) => p.batch_url)).size, 1, "one batch between them");
  const links = (await task(parent.id)).links.map((l) => l.url).sort();
  assert.deepEqual(links, [published[0].batch_url, ...published.slice(4).map((p) => p.url)].sort(), "the batch link once, and each of the parent's own review links");
  for (const [i, s] of subs.entries()) assert.deepEqual((await task(s.id)).links.map((l) => l.url), [published[i].url]);
  assert.equal((await batchData(published[0].batch_url.split("/").pop())).items.length, 8);
});

test("deciding from a batch is the review's own decision: comment, inbox, webhook and completing the task", async () => {
  const hook = ok(await db.rpc("create_webhook", { p_team: team.id, p_url: "https://example.com/hook", p_scope: "all" }));
  // Paused, so it only queues: nothing is sent from a test.
  await db.from("webhooks").update({ active: false, paused_reason: "batch test" }).eq("id", hook.id);
  const first = await addTask("Finishes on approval");
  const second = await addTask("Needs another pass");
  const approving = await publish(first.id, "Final cut", "&completes_task=1");
  const changing = await publish(second.id, "Rough cut");
  const batch = await madeBatch({ title: "Mixed", reviews: [approving.url, changing.token] });
  const items = (await batchData(batch.token)).items;
  assert.deepEqual(items.map((i) => [i.title, i.status, i.completes_task]), [["Final cut", "open", true], ["Rough cut", "open", false]]);

  // The page has no decision route of its own to drift from the review page's.
  assert.match(await (await fetch(batch.url)).text(), /fetch\("\/r\/" \+ item\.token \+ "\/decision"/);
  const own = await fetch(`${BASE}/b/${batch.token}/decision`, { method: "POST", body: "{}" });
  assert.equal(own.status, 404);

  const approved = await decide(items[0].token, "approve", "");
  assert.deepEqual(await approved.json(), { ok: true, status: "approved", completed_task: true });
  assert.equal((await task(first.id)).status, "done", "completes_task still completes the task");
  const comments = ok(await db.from("task_comments").select("author,author_name,body,review_id,delivered_at").eq("task_id", first.id));
  assert.equal(comments.length, 1);
  assert.deepEqual({ ...comments[0], body: null }, { author: "reviewer", author_name: "Sam", body: null, review_id: approving.review_id, delivered_at: null });
  assert.match(comments[0].body, /^Approved "Final cut"\.\n\nThis approval completes CC-\d+/);
  const inbox = ok(await db.from("notifications").select("kind,body").eq("task_id", first.id).eq("kind", "comment"));
  assert.deepEqual(inbox, [{ kind: "comment", body: comments[0].body }], "the decision is in the inbox");
  const sent = ok(await db.from("webhook_deliveries").select("payload").eq("task_id", first.id).eq("event_type", "review.decided"));
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].payload.review.decision, sent[0].payload.review.decided_by], ["approved", "Sam"]);

  // A frame note left on the review's own page waits for the decision; the batch says so and sends it.
  const note = await fetch(`${BASE}/r/${changing.token}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sam", body: "Logo is cut off", timecode: 2.5 }),
  });
  assert.equal(note.status, 200);
  assert.equal((await batchData(batch.token)).items[1].notes, 1);
  assert.equal((await decide(changing.token, "changes", "Tighten the intro")).status, 200);
  const asked = ok(await db.from("task_comments").select("body").eq("task_id", second.id).is("delivered_at", null));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].body, 'Changes requested on "Rough cut": Tighten the intro\n\nNotes:\n- [0:02.5] Logo is cut off');
  assert.equal((await task(second.id)).status, "in_progress");

  // Either page shows what the other decided.
  assert.deepEqual((await batchData(batch.token)).items.map((i) => [i.status, i.decided_by, i.notes]), [["approved", "Sam", 0], ["changes_requested", "Sam", 0]]);
  assert.equal((await (await fetch(`${BASE}/r/${approving.token}/data`)).json()).review.status, "approved");
  // And a decision made on the review's own page shows in the batch: same row, same request.
  assert.equal((await decide(changing.token, "approve")).status, 200);
  assert.equal((await batchData(batch.token)).items[1].status, "approved");
});

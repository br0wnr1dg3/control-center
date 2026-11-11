// Review versions, end to end against `wrangler dev` and the local database. Never production:
//   CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> CC_UPLOAD_TOKEN=<UPLOAD_TOKEN in .dev.vars> \
//     node --test mcp/test/versions.test.mjs
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
  ok(await db.from("tasks").insert({ title, kind: "agent", status: "in_progress", team_id: team.id, source: "versions-test", ...extra }).select().single());

const publishRaw = (taskId, title, query = "") =>
  fetch(`${BASE}/api/publish?task=${taskId}&filename=cut.txt&title=${encodeURIComponent(title)}${query}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${UPLOAD}`, "content-type": "text/plain" },
    body: title,
  });
async function publish(taskId, title, query = "") {
  const res = await publishRaw(taskId, title, query);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { ...body, token: body.url.split("/").pop() };
}
const reviewData = async (token) => (await fetch(`${BASE}/r/${token}/data`)).json();
const decide = (token, body) =>
  fetch(`${BASE}/r/${token}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sam", ...body }) });
const makeCurrent = (review, token = UPLOAD) =>
  fetch(`${BASE}/api/reviews/current`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ review }) });
// [version, current, latest] for each, newest first, as the rail lists them.
const rail = (data) => data.versions.map((v) => [v.version, v.current, v.latest]);

before(async () => {
  team = ok(await db.from("teams").insert({ key: `versions-${run}`, name: `Versions test ${run}` }).select().single());
  dir = mkdtempSync(join(tmpdir(), "cc-versions-"));
});

after(async () => {
  await db.from("review_batches").delete().eq("team_id", team.id);
  await db.from("tasks").delete().eq("team_id", team.id);
  await db.from("teams").delete().eq("id", team.id);
  rmSync(dir, { recursive: true, force: true });
});

test("the title without its version number names the piece", async () => {
  const key = async (title) => ok(await db.rpc("review_piece_key", { p_title: title }));
  assert.equal(await key("Laundry Day · 9:16 · v1"), await key("Laundry Day · 9:16 · v2"));
  assert.equal(await key("Cut v2"), await key("cut  V10"));
  assert.equal(await key("Cut"), await key("Cut v3"));
  assert.equal(await key("Cut (v2)"), await key("Cut - v3"));
  // What follows the number still counts: two reports on v1 aren't versions of each other, nor are two sizes.
  assert.notEqual(await key("Laundry Day v1 · pace gate"), await key("Laundry Day v1 · rule check"));
  assert.notEqual(await key("Cut v1 · 9:16"), await key("Cut v1 · 1:1"));
  assert.notEqual(await key("Vivid v2"), await key("Vv2"));
});

test("a version number inside a file name is part of the deliverable, not a re-cut", async () => {
  const key = async (title) => ok(await db.rpc("review_piece_key", { p_title: title }));
  const name = (it, v, size) => `FLX001_Concept-Name_${it}-${v}_${size}_AI_EN-US_45sec.mp4`;
  // V02 is a new hook and IT02 a new iteration; the finals differ only in their size.
  const names = [
    name("IT01", "V01", "1080x1920"), name("IT01", "V02", "1080x1920"), name("IT02", "V01", "1080x1920"),
    name("IT01", "V01", "1080x1080"), name("IT01", "V01", "1920x1080"),
  ];
  assert.equal(names[0], "FLX001_Concept-Name_IT01-V01_1080x1920_AI_EN-US_45sec.mp4");
  const keys = await Promise.all(names.map(key));
  assert.equal(new Set(keys).size, names.length, JSON.stringify(keys));
  // No spaces, a file extension, or a number joined by "_" or "-": nothing is dropped.
  assert.notEqual(await key("Laundry-Day_v1"), await key("Laundry-Day_v2"));
  assert.notEqual(await key("Laundry Day v1.mp4"), await key("Laundry Day v2.mp4"));
  assert.notEqual(await key("Laundry Day IT01-V01 final"), await key("Laundry Day IT01-V02 final"));
  assert.notEqual(await key("Laundry Day cut_v1"), await key("Laundry Day cut_v2"));
  // A decimal isn't a file extension.
  assert.equal(await key("Hook test v1 at 1.5"), await key("Hook test v2 at 1.5"));

  // On a task: an approved V01 isn't superseded by V02, and the same file published again is its next version.
  const task = await addTask("Deliverables");
  const v01 = await publish(task.id, names[0]);
  assert.equal((await decide(v01.token, { decision: "approve" })).status, 200);
  const published = [];
  for (const title of names.slice(1)) published.push(await publish(task.id, title));
  assert.deepEqual(published.map((p) => p.version), [1, 1, 1, 1]);
  const first = await reviewData(v01.token);
  assert.deepEqual([rail(first), first.review.status], [[[1, true, true]], "approved"]);
  const square = await publish(task.id, names[3], `&note=${encodeURIComponent("Logo moved")}`);
  assert.equal(square.version, 2);
  assert.deepEqual(rail(await reviewData(published[2].token)), [[2, true, true], [1, false, false]]);
  assert.deepEqual(rail(await reviewData(published[3].token)), [[1, true, true]], "the 1920x1080 final is its own piece");
});

test("a title with no letters or digits starts its own piece", async () => {
  const key = async (title) => ok(await db.rpc("review_piece_key", { p_title: title }));
  for (const title of ["🎬", "!!", " · "]) assert.equal(await key(title), null, title);
  assert.equal(await key("v2"), "v2", "a bare version number is the whole title, so it stays");
  const task = await addTask("Odd titles");
  const published = [];
  for (const title of ["🎬", "!!", "🎬", "v2", "v3"]) published.push(await publish(task.id, title));
  assert.deepEqual(published.map((p) => p.version), [1, 1, 1, 1, 1]);
  for (const p of published) assert.deepEqual(rail(await reviewData(p.token)), [[1, true, true]]);
  // Told to, they still chain.
  const next = await publish(task.id, "🎬", `&version_of=${published[0].token}`);
  assert.equal(next.version, 2);
  assert.equal((await publish(task.id, "!!")).version, 1, "and the one after doesn't follow by title");
});

test("versions published on a task chain by title; each keeps its own link, notes and decision", async () => {
  const task = await addTask("An ad");
  const other = await addTask("Another ad");
  const v1 = await publish(task.id, "Ad · 9:16 · v1");
  const report = await publish(task.id, "Ad v1 · pace gate");
  await publish(other.id, "Ad · 9:16 · v1");
  const v2 = await publish(task.id, "Ad · 9:16 · v2", `&note=${encodeURIComponent("Faster open")}`);
  assert.deepEqual([v1.version, report.version, v2.version], [1, 1, 2]);

  const data = await reviewData(v1.token);
  assert.deepEqual(rail(data), [[2, true, true], [1, false, false]]);
  assert.deepEqual(data.versions.map((v) => [v.token, v.title, v.note, v.status, v.path]), [
    [v2.token, "Ad · 9:16 · v2", "Faster open", "open", `/r/${team.key}/${v2.token}`],
    [v1.token, "Ad · 9:16 · v1", null, "open", `/r/${team.key}/${v1.token}`],
  ]);
  assert.deepEqual([data.review.version, data.review.current, data.review.token], [1, false, v1.token]);
  assert.deepEqual(data.others, [{ token: report.token, title: "Ad v1 · pace gate" }], "the task's other outputs, not its other versions");
  assert.deepEqual(rail(await reviewData(report.token)), [[1, true, true]], "one version: nothing to stack");

  // A note and a decision on v1 stay on v1.
  await fetch(`${BASE}/r/${v1.token}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sam", body: "Too slow", timecode: 1.5 }) });
  assert.equal((await decide(v1.token, { decision: "changes" })).status, 200);
  const after = await reviewData(v2.token);
  assert.deepEqual(after.versions.map((v) => [v.version, v.status, v.decided_by]), [[2, "open", null], [1, "changes_requested", "Sam"]]);
  assert.equal(after.notes.length, 0);
  assert.equal((await reviewData(v1.token)).notes.length, 1);

  // An old link still opens that version; the page just carries the whole chain.
  const old = await fetch(`${BASE}/r/${team.key}/${v1.token}`);
  assert.equal(old.status, 200);
  assert.match(await old.text(), /<title>Ad · 9:16 · v1 · Review<\/title>/);
});

test("--version-of chains whatever the titles or tasks; --note says what changed", async () => {
  const first = await addTask("Attempt 1");
  const second = await addTask("Attempt 2");
  const file = join(dir, "cut.md");
  writeFileSync(file, "# A cut\n");
  const ccPublish = async (...args) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CC_PUBLISH, ...args], {
      env: { ...process.env, CC_PUBLIC_URL: BASE, CC_UPLOAD_TOKEN: UPLOAD },
    });
    return { url: stdout.trim(), token: stdout.trim().split("/").pop(), said: stderr.trim() };
  };
  const v1 = await ccPublish(file, "--task", String(first.id), "--title", "Rough cut");
  assert.equal(v1.said, "");
  const v2 = await ccPublish(file, "--task", String(second.id), "--title", "Final cut", "--version-of", v1.url, "--note", "Recut from scratch");
  assert.match(v2.said, /^Version 2 of this piece/);
  const data = await reviewData(v2.token);
  assert.deepEqual(data.versions.map((v) => [v.version, v.title, v.note, v.current]), [[2, "Final cut", "Recut from scratch", true], [1, "Rough cut", null, false]]);
  assert.equal(data.task.id, second.id, "each version stays on its own task");
  // The next one on that task with the same title follows v2 into the piece without being told.
  const v3 = await publish(second.id, "Final cut v3");
  assert.equal(v3.version, 3);

  const missing = await publishRaw(second.id, "Lost", `&version_of=${"x".repeat(32)}`);
  assert.equal(missing.status, 404);

  // --make-current: the older cut counts again.
  assert.equal((await makeCurrent(v2.token, "wrong")).status, 401);
  const made = await ccPublish("--make-current", v2.url);
  assert.equal(made.url, v2.url);
  assert.match(made.said, /^Version 2 of 3 is now the current one/);
  assert.deepEqual(rail(await reviewData(v1.token)), [[3, false, true], [2, true, false], [1, false, false]]);
  const log = ok(await db.from("task_events").select("body").eq("task_id", second.id).eq("kind", "agent_log").order("id", { ascending: false }).limit(1));
  assert.match(log[0].body, /^made version 2 of Final cut the current one/);
  assert.equal((await makeCurrent("nope")).status, 404);
  // A new version is current again.
  await publish(second.id, "Final cut v4");
  assert.deepEqual(rail(await reviewData(v1.token)), [[4, true, true], [3, false, false], [2, false, false], [1, false, false]]);
});

test("approving a superseded version has to be confirmed; the comment and the webhook say which version it was", async () => {
  const hook = ok(await db.rpc("create_webhook", { p_team: team.id, p_url: "https://example.com/hook", p_scope: "all" }));
  // Paused, so it only queues: nothing is sent from a test.
  await db.from("webhooks").update({ active: false, paused_reason: "versions test" }).eq("id", hook.id);
  const task = await addTask("Withdrawn cut");
  const v1 = await publish(task.id, "Cut v1");
  const v2 = await publish(task.id, "Cut v2", "&completes_task=1");
  assert.equal((await makeCurrent(v1.url)).status, 200); // v2 was withdrawn

  const refused = await decide(v2.token, { decision: "approve" });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "Version 2 is superseded: version 1 is the current one. Approving it has to be confirmed.",
    superseded: true,
    current_version: 1,
  });
  assert.equal((await reviewData(v2.token)).review.status, "open");
  assert.equal(ok(await db.from("tasks").select("status").eq("id", task.id).single()).status, "in_progress", "nothing was completed");

  // Asking for changes on it needs no confirming, and says what it was about.
  assert.equal((await decide(v2.token, { decision: "changes", message: "Wrong label" })).status, 200);
  const comments = () => db.from("task_comments").select("body").eq("task_id", task.id).is("delivered_at", null).order("id");
  assert.equal(ok(await comments()).at(-1).body, 'Changes requested on "Cut v2" (version 2, superseded by version 1): Wrong label');

  // The current version approves as ever.
  assert.equal((await decide(v1.token, { decision: "approve" })).status, 200);
  assert.equal(ok(await comments()).at(-1).body, 'Approved "Cut v1".');

  const confirmed = await decide(v2.token, { decision: "approve", confirm_superseded: true });
  assert.deepEqual(await confirmed.json(), { ok: true, status: "approved", completed_task: true });
  assert.match(ok(await comments()).at(-1).body, /^Approved "Cut v2" \(version 2, superseded by version 1\)\./);

  const sent = ok(await db.from("webhook_deliveries").select("event_type,payload").eq("task_id", task.id).like("event_type", "review.%").order("id"));
  const told = sent.map((d) => [d.event_type, d.payload.review.title, d.payload.review.decision, d.payload.review.version, d.payload.review.versions, d.payload.review.current, d.payload.review.current_id]);
  // current_id names the review that counts, so a receiver needn't take the newest for it: v1 here, once v2 was withdrawn.
  assert.deepEqual(told, [
    ["review.published", "Cut v1", null, 1, 1, true, v1.review_id],
    ["review.published", "Cut v2", null, 2, 2, true, v2.review_id],
    ["review.decided", "Cut v2", "changes_requested", 2, 2, false, v1.review_id],
    ["review.decided", "Cut v1", "approved", 1, 2, true, v1.review_id],
    ["review.decided", "Cut v2", "approved", 2, 2, false, v1.review_id],
  ]);
  // Fields were only added.
  assert.deepEqual(Object.keys(sent[0].payload.review).sort(), ["current", "current_id", "decided_at", "decided_by", "decision", "id", "title", "token", "version", "versions"]);
});

test("a batch card is the piece's current version, whichever version was added", async () => {
  const parent = await addTask("Friday's videos");
  const sub = await addTask("Video A", { parent_id: parent.id });
  const v1 = await publish(sub.id, "Cut v1", "&batch=Friday");
  const v2 = await publish(sub.id, "Cut v2", "&batch=Friday");
  const v3 = await publish(sub.id, "Cut v3", "&batch=Friday");
  const batch = v3.batch_url.split("/").pop();
  const cards = async (token = batch) => (await (await fetch(`${BASE}/b/${token}/data`)).json()).items.map((i) => [i.token, i.title, i.version, i.versions]);
  assert.deepEqual(await cards(), [[v3.token, "Cut v3", 3, 3]]);

  // v3 is withdrawn: the grid shows v2, and v3 can't be approved from a tab that still has it.
  assert.equal((await makeCurrent(v2.token)).status, 200);
  assert.deepEqual(await cards(), [[v2.token, "Cut v2", 2, 3]]);
  assert.equal((await decide(v3.token, { decision: "approve" })).status, 409);

  // A batch made from links shows the current version of what was listed, once.
  const listed = await fetch(`${BASE}/api/batches`, {
    method: "POST",
    headers: { authorization: `Bearer ${UPLOAD}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Listed", reviews: [v1.url, v3.token] }),
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(await cards((await listed.json()).url.split("/").pop()), [[v2.token, "Cut v2", 2, 3]]);

  // Gathering a task's open reviews takes the current version only.
  const gathered = await fetch(`${BASE}/api/batches`, {
    method: "POST",
    headers: { authorization: `Bearer ${UPLOAD}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Gathered", parent: parent.id }),
  });
  assert.deepEqual([(await gathered.json()).added], [1]);
  assert.match(await (await fetch(v3.batch_url)).text(), /"v" \+ item\.version \+ " of " \+ item\.versions/);
});

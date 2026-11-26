// Review notes: who may change or delete one, until when, and what the agent is handed. End to end against
// `wrangler dev` and the local database. Never production:
//   CC_SUPABASE_URL=http://127.0.0.1:57721 CC_SERVICE_KEY=<demo key> CC_UPLOAD_TOKEN=<UPLOAD_TOKEN in .dev.vars> \
//     node --test mcp/test/notes.test.mjs
// The Worker is expected at http://localhost:8787 (CC_WORKER_URL to change it).

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import vm from "node:vm";
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
let team;

const ok = ({ data, error }) => {
  assert.equal(error, null, error?.message);
  return data;
};
const addTask = async (title) =>
  ok(await db.from("tasks").insert({ title, kind: "agent", status: "in_progress", team_id: team.id, source: "notes-test" }).select().single());
async function publish(title, query = "") {
  const task = await addTask(title);
  const res = await fetch(`${BASE}/api/publish?task=${task.id}&filename=cut.txt&title=${encodeURIComponent(title)}${query}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${UPLOAD}`, "content-type": "text/plain" },
    body: title,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { task, token: body.url.split("/").pop(), id: body.review_id };
}

// A browser, as the page presents itself: its own origin, and the secret it made for itself.
const browser = () => ({ "content-type": "application/json", origin: new URL(BASE).origin, "x-review-owner": randomBytes(32).toString("hex") });
const SAM = browser(), ALEX = browser();
const call = async (method, path, headers, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* left null: the test says what it expected */ }
  return { status: res.status, body: parsed, text };
};
const addNote = (token, who, body) => call("POST", `/r/${token}/notes`, who, { name: "Sam", ...body });
const edit = (token, id, who, body) => call("PATCH", `/r/${token}/notes/${id}`, who, body);
const remove = (token, id, who) => call("DELETE", `/r/${token}/notes/${id}`, who);
const decide = (token, who, decision, extra = {}) => call("POST", `/r/${token}/decision`, who, { name: "Sam", decision, ...extra });
const key = () => randomBytes(16).toString("hex");
// What the team's webhooks were queued for a task, in the order it happened.
const events = async (taskId) => ok(await db.from("webhook_deliveries").select("event_type,payload").eq("task_id", taskId).order("id"));
const decisionsOf = async (taskId) => ok(await db.from("task_comments").select("*").eq("task_id", taskId).eq("review_kind", "decision").order("id"));
const notesOf = async (token, who = {}) => (await call("GET", `/r/${token}/data`, who)).body.notes;
const row = async (id) => ok(await db.from("task_comments").select("*").eq("id", id).maybeSingle());
// The smallest thing a browser's canvas would call a JPEG; the Worker stores what it is given.
const STILL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64")}`;

before(async () => {
  team = ok(await db.from("teams").insert({ key: `notes-${run}`, name: `Notes test ${run}` }).select().single());
  // Paused, so it only queues: nothing is sent from a test.
  const hook = ok(await db.rpc("create_webhook", { p_team: team.id, p_url: "https://example.com/hook", p_scope: "all" }));
  await db.from("webhooks").update({ active: false, paused_reason: "notes test" }).eq("id", hook.id);
});

after(async () => {
  await db.from("review_batches").delete().eq("team_id", team.id);
  await db.from("tasks").delete().eq("team_id", team.id);
  await db.from("teams").delete().eq("id", team.id);
});

test("a note belongs to the browser that wrote it; only its hash is kept and none of it is shown", async () => {
  const r = await publish("Ownership");
  const made = await addNote(r.token, SAM, { body: "Too slow", timecode: 1.5 });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual([made.body.mine, made.body.edited_at, made.body.body], [true, null, "Too slow"]);
  assert.equal("owner_hash" in made.body, false);

  const stored = await row(made.body.id);
  assert.match(stored.owner_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.owner_hash, SAM["x-review-owner"], "the secret itself is never stored");

  for (const [who, mine] of [[SAM, true], [ALEX, false], [{}, false]]) {
    const notes = await notesOf(r.token, who);
    assert.deepEqual(notes.map((n) => [n.id, n.mine]), [[made.body.id, mine]]);
    assert.equal(JSON.stringify(notes).includes(stored.owner_hash), false, "the hash doesn't leave the server");
  }
});

test("only the writer's browser edits a note, on its own review, and the edit is marked", async () => {
  const r = await publish("Editing"), other = await publish("Editing elsewhere");
  const note = (await addNote(r.token, SAM, { body: "Too slow", timecode: 1.5 })).body;

  // Someone else, nobody, a secret that isn't one, and another review's address for the same id.
  assert.equal((await edit(r.token, note.id, ALEX, { body: "Hijacked" })).status, 403);
  assert.equal((await edit(r.token, note.id, { "content-type": "application/json", origin: SAM.origin }, { body: "Hijacked" })).status, 403);
  assert.equal((await edit(r.token, note.id, { ...SAM, "x-review-owner": "short" }, { body: "Hijacked" })).status, 403);
  assert.equal((await edit(other.token, note.id, SAM, { body: "Hijacked" })).status, 404);
  assert.equal((await edit(r.token, 999999999, SAM, { body: "Guessed" })).status, 404);
  // The page's own requests only, as for writing a note.
  assert.equal((await edit(r.token, note.id, { ...SAM, origin: "https://elsewhere.example" }, { body: "Hijacked" })).status, 403);
  assert.equal((await edit(r.token, note.id, { ...SAM, origin: undefined, "sec-fetch-site": "cross-site" }, { body: "Hijacked" })).status, 403);
  assert.deepEqual([(await row(note.id)).body, (await row(note.id)).edited_at], ["Too slow", null]);

  // Validation is the same as for a new note.
  for (const body of [{ body: "" }, { body: "   " }, {}, { body: 7 }, { body: "x".repeat(5001) }, "not json", "null", "[]"]) {
    const res = await edit(r.token, note.id, SAM, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(typeof res.body.error, "string");
  }

  const changed = await edit(r.token, note.id, SAM, { body: "  A touch slow  " });
  assert.equal(changed.status, 200, changed.text);
  assert.deepEqual([changed.body.id, changed.body.body, changed.body.mine, changed.body.timecode], [note.id, "A touch slow", true, 1.5]);
  assert.ok(changed.body.edited_at);
  assert.equal("owner_hash" in changed.body, false);
  const [listed] = await notesOf(r.token, ALEX);
  assert.deepEqual([listed.body, Boolean(listed.edited_at), listed.mine], ["A touch slow", true, false]);

  // Saving the same text again isn't an edit.
  const same = await edit(r.token, note.id, SAM, { body: "A touch slow" });
  assert.deepEqual([same.status, same.body.edited_at], [200, changed.body.edited_at]);
});

test("deleting a note removes it and its frame; someone else can't", async () => {
  const r = await publish("Deleting");
  const note = (await addNote(r.token, SAM, { body: "Drop this shot", timecode: 2, still: STILL })).body;
  const plain = (await addNote(r.token, SAM, { body: "No frame" })).body;
  assert.match(note.still_url, /\/still\/[a-f0-9-]+\.jpg$/);
  const stillPath = new URL(note.still_url).pathname;
  assert.equal((await fetch(`${BASE}${stillPath}`)).status, 200);

  assert.equal((await remove(r.token, note.id, ALEX)).status, 403);
  assert.equal((await remove(r.token, note.id, { origin: SAM.origin })).status, 403);
  assert.equal((await remove(r.token, 999999999, SAM)).status, 404);
  assert.equal((await fetch(`${BASE}${stillPath}`)).status, 200, "a refused delete leaves the frame");

  const gone = await remove(r.token, note.id, SAM);
  assert.deepEqual([gone.status, gone.body], [200, { ok: true, deleted: note.id }]);
  assert.equal(await row(note.id), null);
  assert.equal((await fetch(`${BASE}${stillPath}`)).status, 404, "the frame goes with the note");
  // Asked again (a retry whose first answer was lost): it isn't there, which the page takes as done.
  assert.equal((await remove(r.token, note.id, SAM)).status, 404);
  assert.equal((await remove(r.token, plain.id, SAM)).status, 200);
  assert.deepEqual(await notesOf(r.token, SAM), []);
});

test("a note with no owner, as every note from before this was, can't be changed by anyone", async () => {
  const r = await publish("Legacy");
  const sent = await call("POST", `/r/${r.token}/notes`, { "content-type": "application/json", origin: SAM.origin }, { name: "Sam", body: "From before" });
  assert.equal(sent.status, 200, sent.text);
  assert.equal((await row(sent.body.id)).owner_hash, null);
  assert.equal(sent.body.mine, false);
  assert.equal((await edit(r.token, sent.body.id, SAM, { body: "Claimed" })).status, 403);
  assert.equal((await remove(r.token, sent.body.id, SAM)).status, 403);
  assert.equal((await row(sent.body.id)).body, "From before");
});

test("the agent is handed the notes as they stood at the decision, and after it they are read-only", async () => {
  const r = await publish("Decided");
  const kept = (await addNote(r.token, SAM, { body: "Frist draft of the note", timecode: 1 })).body;
  const dropped = (await addNote(r.token, SAM, { body: "Changed my mind about this", timecode: 2, still: STILL })).body;
  // Nothing has reached the agent yet: notes are stored as delivered and wait for the decision.
  const undelivered = async () => ok(await db.from("task_comments").select("id,body").eq("task_id", r.task.id).is("delivered_at", null));
  assert.deepEqual(await undelivered(), []);

  assert.equal((await edit(r.token, kept.id, SAM, { body: "Tighten the first cut" })).status, 200);
  assert.equal((await remove(r.token, dropped.id, SAM)).status, 200);

  const sent = await decide(r.token, SAM, "changes");
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual([sent.body.ok, sent.body.status, sent.body.decided_by], [true, "changes_requested", "Sam"]);
  assert.ok(Date.parse(sent.body.decided_at) > Date.now() - 60_000);

  // One message, with the edited text and without the deleted note.
  const waiting = await undelivered();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].body, 'Changes requested on "Decided".\n\nNotes:\n- [0:01.0] Tighten the first cut');

  // The page is told when and by whom, and the notes no longer change.
  const page = (await call("GET", `/r/${r.token}/data`, SAM)).body;
  assert.deepEqual([page.review.status, page.review.decided_by, page.review.decided_at], ["changes_requested", "Sam", sent.body.decided_at]);
  assert.equal(page.notes[0].mine, true, "still the writer's, so the page can say why it can't be changed");
  for (const res of [await edit(r.token, kept.id, SAM, { body: "Too late" }), await remove(r.token, kept.id, SAM)]) {
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.decided, true);
  }
  assert.equal((await row(kept.id)).body, "Tighten the first cut");
  // A note added after the decision is read-only as well: the review stays decided.
  const late = (await addNote(r.token, SAM, { body: "One more thing" })).body;
  assert.equal((await edit(r.token, late.id, SAM, { body: "Changed" })).status, 409);
});

test("a new note is checked before anything is stored, and a bad request is answered in JSON", async () => {
  const r = await publish("Validation");
  for (const body of ["not json", "null", "[1]", { name: "Sam" }, { name: "Sam", body: 7 }, { name: 7, body: "x" }, { name: "Sam", body: "x".repeat(5001) }]) {
    const res = await call("POST", `/r/${r.token}/notes`, SAM, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(typeof res.body?.error, "string", res.text.slice(0, 80));
  }
  assert.equal((await addNote(r.token, SAM, { body: "x".repeat(5000) })).status, 200);
  for (const body of ["not json", "null", { name: "Sam", decision: "maybe" }, { decision: "approve" }]) {
    const res = await call("POST", `/r/${r.token}/decision`, SAM, body);
    assert.equal(res.status, 400);
    assert.equal(typeof res.body?.error, "string");
  }
  // A frame that can't be read costs the frame, not the comment.
  const broken = await addNote(r.token, SAM, { body: "Frame is broken", timecode: 3, still: "data:image/jpeg;base64,%%%not base64%%%" });
  assert.deepEqual([broken.status, broken.body.body, broken.body.still_url, broken.body.timecode], [200, "Frame is broken", null, 3]);
  assert.equal(broken.body.still_failed, true, "and the page is told, so it can say the frame wasn't captured");
  assert.equal("still_failed" in (await addNote(r.token, SAM, { body: "Frame is fine", timecode: 4, still: STILL })).body, false);
});

test("a save that is sent again with the same key isn't saved twice", async () => {
  const r = await publish("Retries");
  const key = randomBytes(16).toString("hex");
  const first = await addNote(r.token, SAM, { body: "Once", client_key: key });
  const again = await addNote(r.token, SAM, { body: "Once", client_key: key });
  const [a, b] = await Promise.all([addNote(r.token, SAM, { body: "Both at once", client_key: `${key}-2` }), addNote(r.token, SAM, { body: "Both at once", client_key: `${key}-2` })]);
  assert.deepEqual([first.status, again.status, a.status, b.status], [200, 200, 200, 200]);
  assert.equal(again.body.id, first.body.id);
  assert.equal(a.body.id, b.body.id);
  assert.deepEqual((await notesOf(r.token)).map((n) => n.body).sort(), ["Both at once", "Once"]);
  // The key is per review, and a note without one is always new.
  const elsewhere = await publish("Retries elsewhere");
  assert.notEqual((await addNote(elsewhere.token, SAM, { body: "Once", client_key: key })).body.id, first.body.id);
  assert.notEqual((await addNote(r.token, SAM, { body: "Once" })).body.id, first.body.id);
});

test("approving a review that completes its task: the task is done first, and the webhooks say so in that order", async () => {
  const r = await publish("Completes", "&completes_task=1");
  const sent = await decide(r.token, SAM, "approve");
  assert.deepEqual([sent.status, sent.body.completed_task], [200, true], sent.text);
  const queued = (await events(r.task.id)).filter((e) => ["task.status", "review.decided"].includes(e.event_type));
  assert.deepEqual(queued.map((e) => [e.event_type, e.payload.task.status]), [["task.status", "done"], ["review.decided", "done"]]);
  assert.deepEqual([queued[1].payload.review.decision, queued[1].payload.review.decided_by], ["approved", "Sam"]);
  // One comment, as the runner and the inbox expect it: a reviewer's, on the review, not yet delivered.
  const [comment, ...more] = await decisionsOf(r.task.id);
  assert.equal(more.length, 0);
  assert.deepEqual([comment.author, comment.author_name, comment.review_id, comment.delivered_at], ["reviewer", "Sam", r.id, null]);
  assert.equal(comment.body, `Approved "Completes".\n\nThis approval completes CC-${r.task.id}: it's now marked done, so there's nothing more to do on it.`);
  const log = ok(await db.from("task_events").select("body").eq("task_id", r.task.id).eq("actor", "reviewer"));
  assert.deepEqual(log.map((e) => e.body), ['done: Sam approved "Completes"']);

  // Asking for changes leaves the task as it was, in the row and in what the webhook says.
  const c = await publish("Stays open", "&completes_task=1");
  assert.equal((await decide(c.token, SAM, "changes", { message: "Not yet" })).status, 200);
  assert.equal(ok(await db.from("tasks").select("status").eq("id", c.task.id).single()).status, "in_progress");
  const quiet = (await events(c.task.id)).filter((e) => ["task.status", "review.decided"].includes(e.event_type));
  assert.deepEqual(quiet.map((e) => [e.event_type, e.payload.task.status, e.payload.review?.decision]), [["review.decided", "in_progress", "changes_requested"]]);
});

test("the same decision sent twice is decided once; a new one decides again; an overtaken one changes nothing", async () => {
  const r = await publish("Idempotent", "&completes_task=1");
  await addNote(r.token, SAM, { body: "Trim the end", timecode: 4 });
  const first = key();
  const a = await decide(r.token, SAM, "approve", { client_key: first });
  const again = await decide(r.token, SAM, "approve", { client_key: first });
  assert.deepEqual([a.status, again.status], [200, 200]);
  assert.deepEqual(again.body, a.body, "the second answer is the first one, completed_task included");
  assert.equal(a.body.completed_task, true);
  const decided = async () => (await events(r.task.id)).filter((e) => e.event_type === "review.decided").length;
  assert.deepEqual([(await decisionsOf(r.task.id)).length, await decided()], [1, 1]);
  // Both at once, as a double click that got past the page would be.
  const k = key();
  const both = await Promise.all([decide(r.token, ALEX, "changes", { client_key: k, name: "Alex" }), decide(r.token, ALEX, "changes", { client_key: k, name: "Alex" })]);
  assert.deepEqual(both.map((b) => b.status), [200, 200]);
  assert.deepEqual([(await decisionsOf(r.task.id)).length, await decided()], [2, 2], "a different key is a new decision, made once");

  // Sam's page, still waiting on its first answer, asks again after Alex decided: Alex's decision stands.
  const late = await decide(r.token, SAM, "approve", { client_key: first });
  assert.equal(late.status, 409, late.text);
  assert.deepEqual([late.body.decided, late.body.stale, late.body.status, late.body.decided_by], [true, true, "changes_requested", "Alex"]);
  assert.deepEqual([(await decisionsOf(r.task.id)).length, await decided()], [2, 2]);
  assert.equal((await call("GET", `/r/${r.token}/data`)).body.review.status, "changes_requested");
  // Without a key, as before this: every request is a decision.
  assert.equal((await decide(r.token, SAM, "approve")).status, 200);
  assert.equal((await decide(r.token, SAM, "approve")).status, 200);
  assert.equal((await decisionsOf(r.task.id)).length, 4);
});

test("a second decision hands over only what is new, and a decision's message is never taken for a note", async () => {
  const r = await publish("Twice decided");
  const one = (await addNote(r.token, SAM, { body: "Colour is cold", timecode: 61.25 })).body;
  assert.equal((await decide(r.token, SAM, "changes", { message: "First pass" })).status, 200);
  const [firstDecision] = await decisionsOf(r.task.id);
  assert.equal(firstDecision.body, 'Changes requested on "Twice decided": First pass\n\nNotes:\n- [1:01.3] Colour is cold');
  assert.ok((await row(one.id)).bundled_at, "the note is marked as handed over");
  // The runner types the decision into the session, which is what used to make it look like a note.
  await db.from("task_comments").update({ delivered_at: new Date().toISOString() }).eq("id", firstDecision.id);

  // A note that was being written while the first decision was made: older than the decision by the
  // clock, but not handed over by it. It goes with the next one instead of being lost.
  const raced = (await call("POST", `/r/${r.token}/notes`, ALEX, { name: "Alex", body: "Music too loud", quote: "the  quoted\nwords", quote_start: 3 })).body;
  await db.from("task_comments").update({ created_at: new Date(Date.parse(firstDecision.created_at) - 60_000).toISOString() }).eq("id", raced.id);
  assert.equal((await row(raced.id)).bundled_at, null);

  const page = (await call("GET", `/r/${r.token}/data`, SAM)).body;
  assert.deepEqual(page.notes.map((n) => n.body), ["Music too loud", "Colour is cold"], "the page lists the notes, not the decision");
  assert.equal((await decide(r.token, SAM, "changes")).status, 200);
  const second = (await decisionsOf(r.task.id))[1];
  assert.equal(second.body, 'Changes requested on "Twice decided".\n\nNotes:\n- On "the quoted words": Music too loud (Alex)');
  // And a third, with nothing new, says only itself.
  assert.equal((await decide(r.token, SAM, "approve")).status, 200);
  assert.equal((await decisionsOf(r.task.id))[2].body, 'Approved "Twice decided".');
  assert.equal((await call("GET", `/r/${r.token}/data`)).body.notes.length, 2);
});

test("a Worker from before this keeps working: its rows are told apart as they are written", async () => {
  const r = await publish("Old writer");
  // As that Worker writes a note and then a decision: no review_kind, no bundled_at.
  const insert = async (extra) => ok(await db.from("task_comments").insert({ task_id: r.task.id, author: "reviewer", author_name: "Sam", review_id: r.id, ...extra }).select().single());
  const note = await insert({ body: "Old note", delivered_at: new Date().toISOString() });
  assert.deepEqual([note.review_kind, note.bundled_at], ["note", null]);
  await db.from("reviews").update({ status: "changes_requested", decided_by: "Sam", decided_at: new Date(Date.now() + 1000).toISOString() }).eq("id", r.id);
  const decision = await insert({ body: 'Changes requested on "Old writer".\n\nNotes:\n- Old note' });
  assert.equal(decision.review_kind, "decision");
  assert.ok((await row(note.id)).bundled_at, "the notes that decision read are marked as handed over");
  // So the next decision, by this Worker, doesn't send the old note again.
  assert.equal((await decide(r.token, SAM, "approve")).status, 200);
  assert.equal((await decisionsOf(r.task.id)).at(-1).body, 'Approved "Old writer".');
  // A comment that has nothing to do with a review is left alone.
  const plain = ok(await db.from("task_comments").insert({ task_id: r.task.id, author: "agent", body: "Working on it" }).select().single());
  assert.equal(plain.review_kind, null);
});

test("the page's script parses, never prints a response body, and says what was decided", async () => {
  const r = await publish("Page");
  const res = await fetch(`${BASE}/r/${team.key}/${r.token}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new vm.Script(script), "the inline script is valid JavaScript");
  // A body is only ever read inside the one request helper (to parse it) and for the text file being reviewed.
  assert.equal(script.match(/res\.text\(\)/g).length, 2);
  assert.equal(/"Couldn't (save|send): " \+/.test(script), false);
  for (const id of ["outcome", "outcomeText", "redecide", "locked"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(script, /client_key: decisionKey\.key/, "a decision carries its key");

  // The batch page decides through the same route, with a key of its own and no body ever shown.
  const made = await call("POST", "/api/batches", { authorization: `Bearer ${UPLOAD}`, "content-type": "application/json" }, { title: `Notes ${run}`, reviews: [r.token] });
  assert.equal(made.status, 200, made.text);
  const batchHtml = await (await fetch(made.body.url)).text();
  const batchScript = batchHtml.slice(batchHtml.indexOf("<script>") + 8, batchHtml.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new vm.Script(batchScript));
  assert.match(batchScript, /client_key: newKey\(\)/);
  assert.equal(/"Couldn't send: " \+ \(await res\.text\(\)\)/.test(batchScript), false);
});

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
async function publish(title) {
  const task = await addTask(title);
  const res = await fetch(`${BASE}/api/publish?task=${task.id}&filename=cut.txt&title=${encodeURIComponent(title)}`, {
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
const decide = (token, who, decision) => call("POST", `/r/${token}/decision`, who, { name: "Sam", decision });
const notesOf = async (token, who = {}) => (await call("GET", `/r/${token}/data`, who)).body.notes;
const row = async (id) => ok(await db.from("task_comments").select("*").eq("id", id).maybeSingle());
// The smallest thing a browser's canvas would call a JPEG; the Worker stores what it is given.
const STILL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64")}`;

before(async () => {
  team = ok(await db.from("teams").insert({ key: `notes-${run}`, name: `Notes test ${run}` }).select().single());
});

after(async () => {
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
});

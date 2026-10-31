// Reviews: agents publish renders and other outputs to R2 and get a private link to a review page.
//
//   PUT  /api/publish?task=<id>&title=<t>&filename=<f>   upload (Bearer UPLOAD_TOKEN), returns the link
//   GET  /r/<token>                                       review page
//   GET  /r/<token>/file                                  the file (Range requests, for scrubbing)
//   GET  /r/<token>/data                                  review, task and notes as JSON
//   POST /r/<token>/notes                                 a note, optionally at a timecode with a still
//   GET  /r/<token>/still/<name>                          a commented frame
//   POST /r/<token>/decision                              approve / request changes
//
// The link is the access control (a long random token), which is fine for the owner and their team. Notes
// are stored already delivered; the decision is posted to the task as one comment listing them, so a
// waiting agent gets the whole review at once.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type ReviewEnv = Env & { MEDIA: R2Bucket; UPLOAD_TOKEN: string };

type Review = {
  id: number;
  token: string;
  task_id: number;
  title: string;
  object_key: string;
  content_type: string | null;
  size: number | null;
  status: "open" | "approved" | "changes_requested";
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const database = (env: ReviewEnv) =>
  createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
};

async function tokenMatches(given: string, expected: string) {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function handleReview(request: Request, env: ReviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/publish") return publish(request, env, url);

  const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{20,})(\/.*)?$/);
  if (!match) return null;
  const [, token, rest = ""] = match;
  const db = database(env);
  const { data: review } = await db.from("reviews").select("*").eq("token", token).maybeSingle<Review>();
  if (!review) return new Response("Not found", { status: 404 });

  if (rest === "" && request.method === "GET") return page(review);
  if (rest === "/file") return serveObject(request, env, review.object_key, review.content_type);
  if (rest === "/data") return data(db, review);
  if (rest === "/notes" && request.method === "POST") return addNote(request, env, db, review);
  if (rest === "/decision" && request.method === "POST") return decide(request, db, review);
  const still = rest.match(/^\/still\/([a-f0-9-]+\.jpg)$/);
  if (still) return serveObject(request, env, `${review.object_key.replace(/\/[^/]+$/, "")}/stills/${still[1]}`, "image/jpeg");
  return new Response("Not found", { status: 404 });
}

// ---------- Publish ----------

async function publish(request: Request, env: ReviewEnv, url: URL) {
  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  const auth = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!(await tokenMatches(auth, env.UPLOAD_TOKEN))) return new Response("Unauthorized", { status: 401 });

  const taskId = Number(url.searchParams.get("task"));
  const filename = (url.searchParams.get("filename") ?? "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const title = (url.searchParams.get("title") ?? filename).slice(0, 200);
  if (!Number.isInteger(taskId) || taskId <= 0 || !request.body) return json({ error: "task and a file body are required" }, 400);

  const db = database(env);
  const { data: task } = await db.from("tasks").select("id,links").eq("id", taskId).maybeSingle();
  if (!task) return json({ error: `CC-${taskId} not found` }, 404);

  const token = randomToken();
  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
  const key = `tasks/${taskId}/${token}/${filename}`;
  const stored = await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });

  const { data: review, error } = await db
    .from("reviews")
    .insert({ token, task_id: taskId, title, object_key: key, content_type: contentType, size: stored.size })
    .select()
    .single<Review>();
  if (error) return json({ error: error.message }, 500);

  const link = `${env.PUBLIC_URL}/r/${token}`;
  await db.from("tasks").update({ links: [...(task.links ?? []), { title, url: link }] }).eq("id", taskId);
  await db.from("task_events").insert({ task_id: taskId, kind: "agent_log", body: `published ${title} for review`, actor: "agent" });
  return json({ url: link, review_id: review.id, size: stored.size });
}

// ---------- Files ----------

// Video needs Range support to scrub; HTML outputs are sandboxed so they can't touch this origin.
async function serveObject(request: Request, env: ReviewEnv, key: string, contentType: string | null) {
  const rangeHeader = request.headers.get("Range");
  const object = await env.MEDIA.get(key, rangeHeader ? { range: request.headers } : undefined);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType ?? headers.get("Content-Type") ?? "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox allow-scripts allow-popups");

  if (rangeHeader && "range" in object && object.range) {
    const r = object.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.suffix !== undefined ? object.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix !== undefined ? r.suffix : (r.length ?? object.size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

// ---------- Notes and decisions ----------

async function data(db: SupabaseClient, review: Review) {
  const [task, notes, versions] = await Promise.all([
    db.from("tasks").select("id,title,status").eq("id", review.task_id).single(),
    db
      .from("task_comments")
      .select("id,author,author_name,body,timecode,still_url,created_at")
      .eq("review_id", review.id)
      .not("delivered_at", "is", null)
      .order("timecode", { ascending: true, nullsFirst: true })
      .order("created_at"),
    db.from("reviews").select("token,title,status,created_at").eq("task_id", review.task_id).order("created_at"),
  ]);
  return json({
    review: { title: review.title, status: review.status, content_type: review.content_type, decided_by: review.decided_by },
    task: task.data,
    notes: notes.data ?? [],
    versions: versions.data ?? [],
  });
}

async function addNote(request: Request, env: ReviewEnv, db: SupabaseClient, review: Review) {
  const input = (await request.json().catch(() => ({}))) as { name?: string; body?: string; timecode?: number; still?: string };
  const body = input.body?.trim();
  const name = input.name?.trim().slice(0, 60);
  if (!body || !name) return json({ error: "name and body are required" }, 400);

  let stillUrl: string | null = null;
  if (input.still?.startsWith("data:image/jpeg;base64,")) {
    const bytes = Uint8Array.from(atob(input.still.split(",")[1]), (c) => c.charCodeAt(0));
    if (bytes.byteLength < 5_000_000) {
      const file = `${crypto.randomUUID()}.jpg`;
      await env.MEDIA.put(`${review.object_key.replace(/\/[^/]+$/, "")}/stills/${file}`, bytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      stillUrl = `${env.PUBLIC_URL}/r/${review.token}/still/${file}`;
    }
  }
  const timecode = typeof input.timecode === "number" && Number.isFinite(input.timecode) ? input.timecode : null;
  const { data: note, error } = await db
    .from("task_comments")
    .insert({
      task_id: review.task_id,
      author: "reviewer",
      author_name: name,
      body,
      review_id: review.id,
      timecode,
      still_url: stillUrl,
      delivered_at: new Date().toISOString(), // reaches the agent with the decision, not one by one
    })
    .select("id,author,author_name,body,timecode,still_url,created_at")
    .single();
  return error ? json({ error: error.message }, 500) : json(note);
}

async function decide(request: Request, db: SupabaseClient, review: Review) {
  const input = (await request.json().catch(() => ({}))) as { name?: string; decision?: string; message?: string };
  const name = input.name?.trim().slice(0, 60);
  const decision = input.decision === "approve" ? "approved" : input.decision === "changes" ? "changes_requested" : null;
  if (!name || !decision) return json({ error: "name and decision are required" }, 400);

  // Every note since this version's last decision goes to the agent in one message.
  let notesQuery = db
    .from("task_comments")
    .select("author_name,body,timecode,still_url")
    .eq("review_id", review.id)
    .not("delivered_at", "is", null)
    .order("timecode", { ascending: true, nullsFirst: true });
  if (review.decided_at) notesQuery = notesQuery.gt("created_at", review.decided_at);
  const { data: notes } = await notesQuery;

  const lines = (notes ?? []).map(
    (n) =>
      `- ${n.timecode !== null ? `[${formatTime(n.timecode)}] ` : ""}${n.body}${n.author_name !== name ? ` (${n.author_name})` : ""}` +
      (n.still_url ? ` frame: ${n.still_url}` : ""),
  );
  const message = input.message?.trim();
  const headline = decision === "approved" ? `Approved "${review.title}"` : `Changes requested on "${review.title}"`;
  const body = [headline + (message ? `: ${message}` : "."), lines.length ? `Notes:\n${lines.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");

  await db.from("reviews").update({ status: decision, decided_by: name, decided_at: new Date().toISOString() }).eq("id", review.id);
  const { error } = await db.from("task_comments").insert({
    task_id: review.task_id,
    author: "reviewer",
    author_name: name,
    body,
    review_id: review.id,
  });
  return error ? json({ error: error.message }, 500) : json({ ok: true, status: decision });
}

// ---------- Page ----------

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(review: Review) {
  return new Response(
    REVIEW_PAGE.replaceAll("__TITLE__", escapeHtml(review.title)).replaceAll("__TOKEN__", review.token),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

const REVIEW_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>__TITLE__ · Review</title>
<style>
  :root { --bg: #f6f5f2; --panel: #fff; --text: #1d1d1f; --muted: #6e6e73; --line: #e3e1dc; --accent: #5b5bd6; --ok: #1f8a4c; --warn: #c2410c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141416; --panel: #1d1d20; --text: #f2f2f4; --muted: #a1a1a8; --line: #2e2e33; --accent: #8b8bf0; --ok: #3fbf76; --warn: #f08a4b; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 17px; margin: 0; }
  .muted { color: var(--muted); font-size: 13px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--line); }
  .badge.approved { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.changes_requested { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; padding: 20px; max-width: 1400px; margin: 0 auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 12px; } }
  .stage { background: #000; border-radius: 10px; overflow: hidden; display: flex; justify-content: center; }
  video, img.media { max-width: 100%; max-height: 72vh; display: block; }
  iframe.media { width: 100%; height: 72vh; border: 0; background: #fff; }
  .controls { display: flex; gap: 8px; align-items: center; margin: 10px 0 4px; flex-wrap: wrap; }
  button { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; border-color: transparent; }
  button.ok { background: var(--ok); color: #fff; border-color: transparent; }
  button.warn { background: var(--warn); color: #fff; border-color: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  .time { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--muted); }
  .track { position: relative; height: 14px; margin: 6px 0 0; border-radius: 7px; background: var(--line); cursor: pointer; }
  .track .marker { position: absolute; top: 2px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--accent); }
  .track .head { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--text); }
  aside { display: flex; flex-direction: column; gap: 12px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
  textarea { width: 100%; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); resize: vertical; min-height: 64px; }
  .note { padding: 8px 0; border-top: 1px solid var(--line); display: flex; gap: 10px; }
  .note:first-child { border-top: 0; }
  .note img { width: 72px; border-radius: 4px; cursor: pointer; }
  .tc { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--accent); cursor: pointer; border: 0; padding: 0; background: none; }
  .who { font-size: 12px; color: var(--muted); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  a { color: var(--accent); }
</style>
<header>
  <h1 id="title">__TITLE__</h1>
  <span id="status" class="badge"></span>
  <span id="task" class="muted"></span>
  <span id="versions" class="muted"></span>
</header>
<main>
  <section>
    <div class="stage" id="stage"></div>
    <div id="videoControls" hidden>
      <div class="track" id="track"><div class="head" id="head"></div></div>
      <div class="controls">
        <button id="back" title="Previous frame (,)">◀ Frame</button>
        <button id="play" title="Play / pause (space)">Play</button>
        <button id="fwd" title="Next frame (.)">Frame ▶</button>
        <span class="time" id="clock">0:00.0</span>
      </div>
    </div>
  </section>
  <aside>
    <div class="panel">
      <div class="row" style="justify-content: space-between">
        <strong id="noteLabel">Note</strong>
        <span class="who">as <a href="#" id="who"></a></span>
      </div>
      <textarea id="body" placeholder="What should change? (Enter adds it; pause on the frame first)"></textarea>
      <div class="row" style="margin-top: 8px"><button class="primary" id="add">Add note</button><span class="muted" id="addState"></span></div>
    </div>
    <div class="panel"><strong>Notes</strong><div id="notes"><p class="muted">No notes yet.</p></div></div>
    <div class="panel">
      <strong>Decision</strong>
      <textarea id="message" placeholder="Optional message to the agent" style="min-height: 44px; margin-top: 6px"></textarea>
      <div class="row" style="margin-top: 8px">
        <button class="warn" id="changes">Request changes</button>
        <button class="ok" id="approve">Approve</button>
      </div>
      <p class="muted" id="decisionState"></p>
    </div>
  </aside>
</main>
<script>
const base = "/r/__TOKEN__";
const FPS = 30;
const $ = (id) => document.getElementById(id);
const fmt = (s) => Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0");
let video = null, notes = [];

// Asked the first time someone adds a note or decides, then remembered on this device.
function showName() { $("who").textContent = localStorage.getItem("cc-review-name") || "set your name"; }
function name() {
  let n = localStorage.getItem("cc-review-name");
  if (!n) { n = (prompt("Your name (shown on your notes)") || "").trim(); if (n) localStorage.setItem("cc-review-name", n); }
  showName();
  return n;
}
$("who").onclick = (e) => { e.preventDefault(); localStorage.removeItem("cc-review-name"); name(); };

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function render() {
  $("notes").innerHTML = notes.length ? "" : '<p class="muted">No notes yet.</p>';
  for (const n of notes) {
    const el = document.createElement("div");
    el.className = "note";
    el.innerHTML = (n.still_url ? '<img src="' + n.still_url + '" alt="">' : "") +
      '<div>' + (n.timecode !== null ? '<button class="tc">' + fmt(n.timecode) + '</button> ' : "") +
      '<span class="who">' + esc(n.author_name || n.author) + '</span><div>' + esc(n.body) + '</div></div>';
    const seek = () => { if (video && n.timecode !== null) { video.pause(); video.currentTime = n.timecode; } };
    el.querySelector(".tc")?.addEventListener("click", seek);
    el.querySelector("img")?.addEventListener("click", seek);
    $("notes").appendChild(el);
  }
  if (video && video.duration) {
    $("track").querySelectorAll(".marker").forEach((m) => m.remove());
    for (const n of notes) if (n.timecode !== null) {
      const m = document.createElement("div");
      m.className = "marker"; m.style.left = (100 * n.timecode / video.duration) + "%"; m.title = n.body;
      m.onclick = (e) => { e.stopPropagation(); video.pause(); video.currentTime = n.timecode; };
      $("track").appendChild(m);
    }
  }
}

function still() {
  if (!video || !video.videoWidth) return null;
  const scale = Math.min(1, 960 / video.videoWidth);
  const c = document.createElement("canvas");
  c.width = video.videoWidth * scale; c.height = video.videoHeight * scale;
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}

async function add() {
  const body = $("body").value.trim(), who = name();
  if (!body || !who) return;
  $("add").disabled = true; $("addState").textContent = "Saving…";
  const payload = { name: who, body };
  if (video) { payload.timecode = video.currentTime; payload.still = still(); }
  const res = await fetch(base + "/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  $("add").disabled = false;
  if (!res.ok) { $("addState").textContent = "Couldn't save: " + (await res.text()); return; }
  notes.push(await res.json()); notes.sort((a, b) => (a.timecode ?? -1) - (b.timecode ?? -1));
  $("body").value = ""; $("addState").textContent = ""; render();
}
$("add").onclick = add;
$("body").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); } });

async function decide(decision) {
  const who = name(); if (!who) return;
  for (const b of [$("approve"), $("changes")]) b.disabled = true;
  const res = await fetch(base + "/decision", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: who, decision, message: $("message").value }) });
  for (const b of [$("approve"), $("changes")]) b.disabled = false;
  if (!res.ok) { $("decisionState").textContent = "Couldn't send: " + (await res.text()); return; }
  $("message").value = "";
  $("decisionState").textContent = decision === "approve" ? "Approved. The agent will wrap up." : "Sent. The agent is working on the next version.";
  load();
}
$("approve").onclick = () => decide("approve");
$("changes").onclick = () => decide("changes");

function setupMedia(type) {
  const src = base + "/file";
  if (type && type.startsWith("video/")) {
    video = document.createElement("video");
    video.src = src; video.playsInline = true; video.preload = "auto";
    $("stage").appendChild(video); $("videoControls").hidden = false;
    $("noteLabel").textContent = "Note at 0:00.0";
    const tick = () => {
      $("clock").textContent = fmt(video.currentTime) + " / " + fmt(video.duration || 0);
      $("noteLabel").textContent = "Note at " + fmt(video.currentTime);
      $("head").style.left = (100 * video.currentTime / (video.duration || 1)) + "%";
      $("play").textContent = video.paused ? "Play" : "Pause";
    };
    video.addEventListener("timeupdate", tick); video.addEventListener("seeked", tick);
    video.addEventListener("play", tick); video.addEventListener("pause", tick);
    video.addEventListener("loadedmetadata", () => { tick(); render(); });
    $("play").onclick = () => (video.paused ? video.play() : video.pause());
    const step = (d) => { video.pause(); video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + d / FPS)); };
    $("back").onclick = () => step(-1); $("fwd").onclick = () => step(1);
    $("track").onclick = (e) => { const r = $("track").getBoundingClientRect(); video.currentTime = (e.clientX - r.left) / r.width * video.duration; };
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
      if (e.key === ",") step(-1);
      if (e.key === ".") step(1);
    });
    $("body").addEventListener("focus", () => video.pause());
  } else if (type && type.startsWith("image/")) {
    $("stage").innerHTML = '<img class="media" src="' + src + '" alt="">';
  } else if (type && (type.startsWith("text/html") || type === "application/pdf")) {
    $("stage").innerHTML = '<iframe class="media" src="' + src + '"></iframe>';
  } else {
    $("stage").innerHTML = '<p style="color:#fff;padding:40px"><a style="color:#fff" href="' + src + '">Download the file</a></p>';
  }
}

async function load() {
  const d = await (await fetch(base + "/data")).json();
  $("status").textContent = { open: "Waiting for review", approved: "Approved", changes_requested: "Changes requested" }[d.review.status];
  $("status").className = "badge " + d.review.status;
  $("task").textContent = "CC-" + d.task.id + " · " + d.task.title;
  $("versions").innerHTML = d.versions.length > 1 ? d.versions.map((v, i) =>
    v.token === "__TOKEN__" ? "<strong>v" + (i + 1) + "</strong>" : '<a href="/r/' + v.token + '">v' + (i + 1) + "</a>").join(" · ") : "";
  notes = d.notes;
  if (!$("stage").firstChild) setupMedia(d.review.content_type);
  render();
}
showName();
load();
</script>
</html>`;

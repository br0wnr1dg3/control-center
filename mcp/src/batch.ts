// Review batches: one private link that shows many published reviews as a grid, for approving or
// striking a day's cuts quickly and only opening the frame-accurate page when one needs notes.
//
//   POST /api/batches                 make (or top up) a batch (Bearer UPLOAD_TOKEN), returns the link. JSON body:
//                                       { title, parent: <task> }          every open review on the task and its sub-tasks
//                                       { title, label, team: <key> }      every open review on that team's tasks carrying the label
//                                       { title, reviews: [<link|token>] } exactly these
//   PUT  /api/publish?...&batch=<name> publish straight into the named batch for the task's parent (review.ts)
//   GET  /b/<team>/<token>            the grid (/b/<token> redirects here)
//   GET  /b/<token>/data              the batch and its items as JSON
//
// A batch only gathers reviews. Files come from each item's /r/<token>/file and decisions are posted to
// its /r/<token>/decision, the same request the single page makes, so the task comment, inbox note,
// completes_task and review.decided webhook can't differ between the two pages. Whoever has the batch
// link can open and decide every review in it, as if they'd been sent each link.

import type { SupabaseClient } from "@supabase/supabase-js";
import { database, escapeHtml, json, mayUpload, PAGE_HEADERS, randomToken, stem, type ReviewEnv } from "./review-shared";

type Batch = { id: number; token: string; title: string; team_id: number | null; task_id: number | null };
type BatchTask = { id: number; parent_id: number | null; team_id: number | null };
type Candidate = { id: number; title: string; task_id: number; created_at: string; tasks: { team_id: number | null } };

const CANDIDATE = "id,title,task_id,created_at,tasks!inner(team_id)";

export async function handleBatch(request: Request, env: ReviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/batches") return create(request, env);

  const match = url.pathname.match(/^\/b\/(?:([a-z0-9][a-z0-9-]*)\/)?([A-Za-z0-9_-]{20,})(\/.*)?$/);
  if (!match) return null;
  const [, teamInPath, token, rest = ""] = match;
  const db = database(env);
  const { data: batch } = await db
    .from("review_batches")
    .select("id,token,title,team_id,task_id,team:teams(key,name)")
    .eq("token", token)
    .maybeSingle<Batch & { team: { key: string; name: string } | null }>();
  if (!batch) return new Response("Not found", { status: 404 });

  if (rest === "" && request.method === "GET") {
    if (batch.team?.key !== teamInPath) return Response.redirect(`${url.origin}${batchPath(batch.team?.key ?? null, token)}`, 302);
    return new Response(BATCH_PAGE.replaceAll("__TITLE__", escapeHtml(batch.title)).replaceAll("__TOKEN__", token), { headers: PAGE_HEADERS });
  }
  if (rest === "/data" && request.method === "GET") return data(db, batch);
  return new Response("Not found", { status: 404 });
}

const batchPath = (team: string | null, token: string) => (team ? `/b/${team}/${token}` : `/b/${token}`);

async function batchUrl(db: SupabaseClient, env: ReviewEnv, batch: Batch) {
  const { data: team } = batch.team_id ? await db.from("teams").select("key").eq("id", batch.team_id).maybeSingle() : { data: null };
  return `${env.PUBLIC_URL}${batchPath(team?.key ?? null, batch.token)}`;
}

// ---------- Making batches ----------

// A batch for a task is found by its title, so asking again (or publishing into it from another
// sub-task) reaches the same link. The first time, the link is attached to that task.
async function ensureBatch(db: SupabaseClient, env: ReviewEnv, title: string, task: BatchTask | null, teamId: number | null) {
  const existing = () => db.from("review_batches").select("id,token,title,team_id,task_id").eq("task_id", task!.id).eq("title", title).maybeSingle<Batch>();
  if (task) {
    const { data: found } = await existing();
    if (found) return { batch: found };
  }
  const { data: made, error } = await db
    .from("review_batches")
    .insert({ token: randomToken(), title, team_id: teamId, task_id: task?.id ?? null })
    .select("id,token,title,team_id,task_id")
    .single<Batch>();
  if (made) {
    // Appended in the database: the task's review link may have been written a moment ago, by this request or a sibling's.
    if (task) await db.rpc("append_task_link", { p_task: task.id, p_title: `Review batch: ${title}`, p_url: await batchUrl(db, env, made) });
    return { batch: made };
  }
  // Two sub-tasks publishing into a new batch at once: the other one made it.
  if (task && error.code === "23505") {
    const { data: found } = await existing();
    if (found) return { batch: found };
  }
  return { error: error.message };
}

const addItems = (db: SupabaseClient, batchId: number, reviewIds: number[]) =>
  db
    .from("review_batch_items")
    .upsert(reviewIds.map((review_id) => ({ batch_id: batchId, review_id })), { onConflict: "batch_id,review_id", ignoreDuplicates: true });

// Called by publish. The batch belongs to the task's parent (or the task itself, without one), and a new
// version takes the place of the versions it supersedes, so the grid shows each cut once.
export async function addToNamedBatch(
  db: SupabaseClient,
  env: ReviewEnv,
  task: BatchTask,
  review: { id: number; title: string; task_id: number },
  name: string,
): Promise<{ url: string } | { error: string }> {
  let owner = task;
  if (task.parent_id) {
    const { data: parent } = await db.from("tasks").select("id,parent_id,team_id").eq("id", task.parent_id).maybeSingle<BatchTask>();
    if (parent) owner = parent;
  }
  const ensured = await ensureBatch(db, env, name, owner, owner.team_id ?? task.team_id);
  if (!ensured.batch) return { error: ensured.error };
  const { error } = await addItems(db, ensured.batch.id, [review.id]);
  if (error) return { error: error.message };

  const { data: earlier } = await db.from("reviews").select("id,title").eq("task_id", review.task_id).neq("id", review.id);
  const superseded = (earlier ?? []).filter((r) => stem(r.title) === stem(review.title)).map((r) => r.id);
  if (superseded.length) await db.from("review_batch_items").delete().eq("batch_id", ensured.batch.id).in("review_id", superseded);
  return { url: await batchUrl(db, env, ensured.batch) };
}

const taskIdOf = (value: unknown) => {
  const id = Number(String(value ?? "").replace(/^cc-/i, ""));
  return Number.isInteger(id) && id > 0 ? id : null;
};

async function create(request: Request, env: ReviewEnv) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await mayUpload(request, env))) return new Response("Unauthorized", { status: 401 });
  const input = (await request.json().catch(() => ({}))) as { title?: string; parent?: unknown; label?: string; team?: string; reviews?: unknown };
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  const label = typeof input.label === "string" ? input.label.trim().toLowerCase() : "";
  const listed = Array.isArray(input.reviews) ? input.reviews.map((r) => String(r).split(/[/?#]/).filter(Boolean).pop() ?? "") : null;
  if (!title) return json({ error: "title is required" }, 400);
  // Labels go into a PostgREST array filter, where "," and "}" would mean something.
  if (input.label !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(label)) return json({ error: "label must be lowercase letters, digits and hyphens" }, 400);
  // A label alone would gather every team's reviews under one link.
  if (label && !input.team) return json({ error: "team is required with label" }, 400);
  if ([input.parent !== undefined, Boolean(label), Boolean(listed)].filter(Boolean).length !== 1) {
    return json({ error: "give one of parent (a task), label or reviews (links or tokens)" }, 400);
  }

  const db = database(env);
  let teamId: number | null = null;
  if (input.team) {
    const { data: team } = await db.from("teams").select("id").eq("key", String(input.team).toLowerCase()).maybeSingle();
    if (!team) return json({ error: `No team with key ${input.team}` }, 404);
    teamId = team.id;
  }

  let owner: BatchTask | null = null;
  let found: Candidate[];
  if (input.parent !== undefined) {
    const parentId = taskIdOf(input.parent);
    const { data: parent } = parentId ? await db.from("tasks").select("id,parent_id,team_id").eq("id", parentId).maybeSingle<BatchTask>() : { data: null };
    if (!parent) return json({ error: `Task ${input.parent} not found` }, 404);
    owner = parent;
    teamId ??= parent.team_id;
    const { data: family } = await db.from("tasks").select("id").or(`id.eq.${parent.id},parent_id.eq.${parent.id}`);
    const { data, error } = await db.from("reviews").select(CANDIDATE).eq("status", "open").in("task_id", (family ?? []).map((t) => t.id)).returns<Candidate[]>();
    if (error) return json({ error: error.message }, 500);
    found = latestVersions(data);
  } else if (label) {
    const { data, error } = await db.from("reviews").select(CANDIDATE).eq("status", "open").contains("tasks.labels", [label]).eq("tasks.team_id", teamId!).returns<Candidate[]>();
    if (error) return json({ error: error.message }, 500);
    found = latestVersions(data);
  } else {
    const tokens = [...new Set(listed)].filter((t) => /^[A-Za-z0-9_-]{20,}$/.test(t));
    const { data, error } = await db.from("reviews").select(CANDIDATE).in("token", tokens).returns<Candidate[]>();
    if (error) return json({ error: error.message }, 500);
    if (data.length !== new Set(listed).size) return json({ error: "Some of those reviews don't exist" }, 404);
    found = data;
  }
  // Nothing to look at isn't worth a link, unless it tops up a batch that already has cuts in it.
  if (!found.length && !owner) return json({ error: "No open reviews match" }, 404);

  // Without a stated team, a batch whose reviews all belong to one team is that team's.
  const teams = new Set(found.map((r) => r.tasks.team_id));
  if (teamId === null && teams.size === 1) teamId = [...teams][0];

  if (!found.length) {
    const { data: existing } = await db.from("review_batches").select("id").eq("task_id", owner!.id).eq("title", title).maybeSingle();
    if (!existing) return json({ error: "No open reviews match" }, 404);
  }
  const ensured = await ensureBatch(db, env, title, owner, teamId);
  if (!ensured.batch) return json({ error: ensured.error }, 500);
  if (found.length) {
    const { error } = await addItems(db, ensured.batch.id, found.map((r) => r.id));
    if (error) return json({ error: error.message }, 500);
  }
  const { count } = await db.from("review_batch_items").select("review_id", { count: "exact", head: true }).eq("batch_id", ensured.batch.id);
  return json({ url: await batchUrl(db, env, ensured.batch), batch_id: ensured.batch.id, reviews: count ?? found.length, added: found.length });
}

// Where an agent published v2 before v1 was decided, only v2 is worth deciding.
function latestVersions(reviews: Candidate[]) {
  const latest = new Map<string, Candidate>();
  for (const r of [...reviews].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)) latest.set(`${r.task_id}:${stem(r.title)}`, r);
  return [...latest.values()];
}

// ---------- Data ----------

type Item = {
  added_at: string;
  review: {
    id: number;
    token: string;
    title: string;
    status: string;
    decided_by: string | null;
    decided_at: string | null;
    content_type: string | null;
    object_key: string;
    completes_task: boolean;
    task: { id: number; title: string };
  };
};

async function data(db: SupabaseClient, batch: Batch & { team: { key: string; name: string } | null }) {
  const { data: items, error } = await db
    .from("review_batch_items")
    .select("added_at,review:reviews!inner(id,token,title,status,decided_by,decided_at,content_type,object_key,completes_task,task:tasks!inner(id,title))")
    .eq("batch_id", batch.id)
    .order("added_at")
    .order("review_id")
    .returns<Item[]>();
  if (error) return json({ error: error.message }, 500);

  // Frame notes left on the single page that haven't gone to the agent yet: the next decision sends them.
  const { data: notes } = items.length
    ? await db.from("task_comments").select("review_id,created_at").in("review_id", items.map((i) => i.review.id)).not("delivered_at", "is", null)
    : { data: [] };
  const waiting = (r: Item["review"]) =>
    (notes ?? []).filter((n) => n.review_id === r.id && (!r.decided_at || new Date(n.created_at) > new Date(r.decided_at))).length;

  return json({
    batch: { title: batch.title, team: batch.team },
    items: items.map(({ review: r }) => ({
      token: r.token,
      title: r.title,
      status: r.status,
      decided_by: r.decided_by,
      content_type: r.content_type,
      filename: r.object_key.split("/").pop(),
      completes_task: r.completes_task,
      notes: waiting(r),
      task: r.task,
    })),
  });
}

// ---------- Page ----------

// String.raw, as in review.ts: the page must not contain backticks or "${". Styles follow the review page.
const BATCH_PAGE = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>__TITLE__ · Review batch</title>
<style>
  :root { --bg: #f6f5f2; --panel: #fff; --text: #1d1d1f; --muted: #6e6e73; --line: #e3e1dc; --accent: #5b5bd6; --ok: #1f8a4c; --warn: #c2410c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141416; --panel: #1d1d20; --text: #f2f2f4; --muted: #a1a1a8; --line: #2e2e33; --accent: #8b8bf0; --ok: #3fbf76; --warn: #f08a4b; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;
           position: sticky; top: 0; z-index: 2; background: var(--bg); }
  header h1 { font-size: 17px; margin: 0; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 13px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--line); white-space: nowrap; }
  .badge.approved { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.changes_requested { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  a { color: var(--accent); }
  label.muted { cursor: pointer; user-select: none; }
  kbd { font: inherit; font-size: 12px; padding: 0 5px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; background: var(--panel); }
  .keys { padding: 10px 20px 0; margin: 0; }
  @media (hover: none) { .keys { display: none; } }

  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; padding: 16px 20px 40px; }
  @media (max-width: 600px) { main { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 12px; } }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column;
          outline: 0; scroll-margin: 70px 0 20px; }
  .tile[hidden] { display: none; }
  .tile.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
  .tile.decided:not(.sel) .thumb { opacity: .55; }
  .thumb { position: relative; aspect-ratio: 1; background: #000; overflow: hidden; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .thumb video, .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .thumb.page, .thumb.text { background: #fff; align-items: flex-start; justify-content: flex-start; }
  .thumb iframe { width: 1280px; height: 1280px; flex: none; border: 0; transform-origin: 0 0; pointer-events: none; background: #fff; }
  .thumb .excerpt { padding: 14px; font-size: 11px; line-height: 1.5; color: #1d1d1f; white-space: pre-wrap; overflow-wrap: anywhere; }
  .thumb .file { color: #fff; font-size: 13px; opacity: .8; }
  .meta { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .by { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  button { font: inherit; font-size: 13px; padding: 3px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  button.ok { background: var(--ok); color: #fff; border-color: transparent; }
  button.warn { background: var(--warn); color: #fff; border-color: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  .ask input { width: 100%; font: inherit; font-size: 14px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--warn); background: var(--bg); color: var(--text); }
  .state:empty, .hint:empty { display: none; }
  #empty { padding: 40px 20px; text-align: center; }
  #undo { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 3; max-width: calc(100vw - 24px); overflow: hidden;
          display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-radius: 10px; background: var(--text); color: var(--bg);
          box-shadow: 0 6px 24px rgba(0, 0, 0, .25); }
  #undo[hidden] { display: none; }
  #undo-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  #undo button { flex: none; background: transparent; color: inherit; border-color: currentColor; }
  #undo-left { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; background: var(--ok); transform-origin: 0 0; }
  #undo-left.run { animation: undo-left 5s linear forwards; }
  @keyframes undo-left { to { transform: scaleX(0); } }
</style>
<header>
  <h1>__TITLE__</h1>
  <span id="team" class="muted"></span>
  <span id="count" class="badge"></span>
  <span class="spacer"></span>
  <label class="muted"><input type="checkbox" id="undecided"> Undecided only</label>
  <span class="muted">as <a href="#" id="who"></a></span>
</header>
<p class="keys muted"><kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> or a click selects · <kbd>A</kbd> approve · <kbd>Z</kbd> undo · <kbd>X</kbd> request changes · <kbd>Enter</kbd> open for frame notes · <kbd>U</kbd> undecided only · <kbd>M</kbd> sound</p>
<main id="grid"></main>
<p id="empty" class="muted" hidden></p>
<div id="undo" role="status" hidden><span id="undo-text"></span><button type="button" id="undo-button">Undo</button><span id="undo-left"></span></div>
<script>
const base = "/b/__TOKEN__";
const $ = (id) => document.getElementById(id);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const LABEL = { open: "Waiting for review", approved: "Approved", changes_requested: "Changes requested" };
let items = [], selected = null, asking = null, sound = false, loaded = false, held = null;
let undecidedOnly = store.get("cc-batch-undecided") === "1";
const tiles = new Map();

// The same name the review page remembers on this device.
function showName() { $("who").textContent = store.get("cc-review-name") || "set your name"; }
function name() {
  let n = store.get("cc-review-name");
  if (!n) { n = (prompt("Your name (shown on your decisions)") || "").trim(); if (n) store.set("cc-review-name", n); }
  showName();
  return n;
}
$("who").onclick = (e) => { e.preventDefault(); store.set("cc-review-name", null); name(); };

function kindOf(type, filename) {
  type = type || "";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/html") || type === "application/pdf") return "page";
  if (type.startsWith("text/") || type.startsWith("application/json") || /\.(md|markdown|txt)$/i.test(filename || "")) return "text";
  return "download";
}

// ---------- Tiles ----------

// Media loads when its tile is near the viewport, so a batch of fifty cuts doesn't fetch fifty videos at once.
const lazy = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) { lazy.unobserve(entry.target); entry.target.loadMedia(); }
}, { rootMargin: "400px" });

function fillThumb(thumb, item) {
  const src = "/r/" + item.token + "/file", kind = kindOf(item.content_type, item.filename);
  thumb.classList.add(kind);
  if (kind === "video") {
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "none";
    thumb.appendChild(v);
    // "#t" makes the first frame the poster once the metadata is in.
    thumb.loadMedia = () => { v.preload = "metadata"; v.src = src + "#t=0.1"; };
  } else if (kind === "image") {
    thumb.loadMedia = () => { thumb.innerHTML = '<img alt="" src="' + src + '">'; };
  } else if (kind === "page") {
    // The page at desktop width, scaled down to the tile. The file is served sandboxed, as on the review page.
    thumb.loadMedia = () => {
      const frame = document.createElement("iframe");
      frame.src = src; frame.tabIndex = -1; frame.title = item.title;
      thumb.appendChild(frame);
      const fit = () => { frame.style.transform = "scale(" + thumb.clientWidth / 1280 + ")"; };
      new ResizeObserver(fit).observe(thumb); fit();
    };
  } else if (kind === "text") {
    thumb.loadMedia = async () => {
      const excerpt = document.createElement("div");
      excerpt.className = "excerpt";
      thumb.appendChild(excerpt);
      try { excerpt.textContent = (await (await fetch(src)).text()).slice(0, 1500); } catch {}
    };
  } else {
    thumb.innerHTML = '<span class="file"></span>';
    thumb.firstChild.textContent = item.filename || "File";
    thumb.loadMedia = () => {};
  }
  lazy.observe(thumb);
}

function makeTile(item) {
  const el = document.createElement("article");
  el.className = "tile"; el.tabIndex = 0; el.dataset.token = item.token;
  el.innerHTML = '<div class="thumb"></div><div class="meta"><div class="name"></div><div class="task muted"></div>' +
    '<div class="row"><span class="badge"></span><span class="by muted"></span></div>' +
    '<div class="row actions"><button class="ok" data-act="approve" title="Approve (A)">Approve</button>' +
    '<button class="warn" data-act="changes" title="Request changes (X)">Changes</button><span class="spacer"></span>' +
    '<a class="muted open" target="_blank" rel="noopener" title="Open for frame notes (Enter)">Open ↗</a></div>' +
    '<form class="ask" hidden><input type="text" name="note" maxlength="500" autocomplete="off"></form>' +
    '<div class="hint muted"></div><div class="state muted"></div></div>';
  const q = (s) => el.querySelector(s);
  q(".open").href = "/r/" + item.token;
  fillThumb(q(".thumb"), item);
  el.addEventListener("mouseenter", () => play(item.token, true));
  el.addEventListener("mouseleave", () => { if (selected !== item.token) play(item.token, false); });
  el.addEventListener("focus", () => select(item.token, false));
  q(".thumb").addEventListener("click", () => select(item.token, false));
  q('[data-act="approve"]').onclick = () => { select(item.token, false); approve(item); };
  q('[data-act="changes"]').onclick = () => { select(item.token, false); ask(item); };
  q(".ask").addEventListener("submit", (e) => { e.preventDefault(); sendChanges(item); });
  q(".ask input").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); ask(null); el.focus({ preventScroll: true }); } });
  return el;
}

function play(token, on) {
  const v = tiles.get(token)?.querySelector("video");
  if (!v) return;
  v.muted = !(sound && token === selected);
  if (on) v.play().catch(() => {}); else v.pause();
}

const shown = () => items.filter((i) => !undecidedOnly || i.status === "open" || i.token === asking || i.busy);

function render() {
  const visible = shown(), grid = $("grid");
  for (const [token, el] of tiles) if (!items.some((i) => i.token === token)) { el.remove(); tiles.delete(token); }
  items.forEach((item, at) => {
    let el = tiles.get(item.token);
    if (!el) { el = makeTile(item); tiles.set(item.token, el); }
    // Only moved when out of place: re-inserting a tile would reload its video or page.
    if (grid.children[at] !== el) grid.insertBefore(el, grid.children[at] || null);
    const q = (s) => el.querySelector(s);
    el.hidden = !visible.includes(item);
    el.classList.toggle("sel", item.token === selected);
    el.classList.toggle("decided", item.status !== "open");
    q(".name").textContent = item.title; q(".name").title = item.title;
    q(".task").textContent = "CC-" + item.task.id + " · " + item.task.title; q(".task").title = item.task.title;
    q(".badge").textContent = LABEL[item.status]; q(".badge").className = "badge " + item.status;
    q(".by").textContent = item.status !== "open" && item.decided_by ? "by " + item.decided_by : "";
    q(".hint").textContent = [item.notes ? item.notes + (item.notes === 1 ? " note" : " notes") + " waiting to be sent" : "",
      item.completes_task && item.status !== "approved" ? "Approving completes the task" : ""].filter(Boolean).join(" · ");
    q(".ask").hidden = asking !== item.token;
    q(".ask input").placeholder = item.notes ? "Message (optional): Enter sends, Esc cancels" : "What should change? Enter sends, Esc cancels";
    for (const b of el.querySelectorAll("button")) b.disabled = Boolean(item.busy);
    q(".state").textContent = item.state || "";
  });
  const decided = items.filter((i) => i.status !== "open").length;
  $("count").textContent = decided + " of " + items.length + " decided";
  $("undecided").checked = undecidedOnly;
  $("empty").hidden = visible.length > 0 || !loaded;
  $("empty").textContent = items.length ? "Everything here is decided." : "Nothing in this batch yet.";
}

function select(token, scroll) {
  if (asking && asking !== token) asking = null;
  const before = selected;
  selected = token;
  if (before && before !== token) play(before, false);
  render();
  const el = tiles.get(token);
  if (!el) return;
  if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  // The top row scrolls all the way up, so the key hints above it stay in view.
  if (scroll && el.offsetTop === tiles.get(shown()[0].token).offsetTop) scrollTo(0, 0);
  else if (scroll) el.scrollIntoView({ block: "nearest" });
  play(token, true);
}

// ---------- Decisions ----------

// Shows the item as decided and moves on to the next undecided one.
function settle(item, status, who) {
  // Looked up before this one drops out of an undecided-only grid.
  const order = shown(), at = order.indexOf(item);
  const next = order.slice(at + 1).concat(order.slice(0, at)).find((i) => i.status === "open" && i !== item);
  item.status = status; item.decided_by = who; item.notes = 0; item.state = "";
  if (selected === item.token && next) select(next.token, true);
  else if (selected === item.token && undecidedOnly) { selected = null; render(); }
  else render();
}

// The request the review page's Approve and Request changes buttons make, to the same address.
// keepalive lets it finish when it's sent as the page is being left.
async function send(item, decision, message, who, before) {
  item.busy = true; item.state = "Sending…"; render();
  let failure = null, reply = {};
  try {
    const res = await fetch("/r/" + item.token + "/decision", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: who, decision, message }), keepalive: true });
    if (res.ok) reply = await res.json(); else failure = (await res.text()) || String(res.status);
  } catch (e) { failure = String(e.message || e); }
  item.busy = false;
  if (failure) { Object.assign(item, before, { state: "Couldn't send: " + failure }); render(); return; }
  item.status = reply.status;
  item.state = reply.completed_task ? "CC-" + item.task.id + " is done." : "";
  render();
}

const was = (item) => ({ status: item.status, decided_by: item.decided_by, notes: item.notes });

function decide(item, decision, message) {
  const who = name();
  if (!who || item.busy) return;
  release();
  const before = was(item);
  settle(item, decision === "approve" ? "approved" : "changes_requested", who);
  send(item, decision, message, who, before);
}

// ---------- Approve, with a moment to take it back ----------

// One key approves, and an approval can complete a task, so it's held for five seconds first: the
// tile shows it and the grid moves on, but nothing is sent until the bar runs out. Z takes it back.
// Only the latest approval is held: the next decision, or leaving the page, sends it.
function approve(item) {
  if (item.status === "approved") { item.state = "Already approved."; render(); return; }
  const who = name();
  if (!who || item.busy) return;
  if (asking) asking = null;
  release();
  held = { item, who, before: was(item), timer: setTimeout(release, 5000) };
  settle(item, "approved", who);
  $("undo-text").textContent = "Approved " + item.title + (item.completes_task ? " (completes CC-" + item.task.id + ")" : "") + " · Z to undo";
  $("undo").hidden = false;
  // Restarts the countdown line.
  const left = $("undo-left"); left.classList.remove("run"); void left.offsetWidth; left.classList.add("run");
}

function release() {
  if (!held) return;
  const h = held;
  held = null; clearTimeout(h.timer); $("undo").hidden = true;
  send(h.item, "approve", "", h.who, h.before);
}

function undo() {
  if (!held) return;
  const h = held;
  held = null; clearTimeout(h.timer); $("undo").hidden = true;
  Object.assign(h.item, h.before, { state: "" });
  select(h.item.token, true);
}
$("undo-button").onclick = undo;
// "hidden" as well as pagehide: a phone can drop a background tab without ever saying it's leaving.
addEventListener("pagehide", release);
document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });

function ask(item) {
  // Asking for changes on the approval still being held replaces it.
  if (item && held && held.item === item) undo();
  asking = item ? item.token : null;
  render();
  if (!item) return;
  const input = tiles.get(item.token).querySelector(".ask input");
  input.value = ""; input.focus();
}

function sendChanges(item) {
  const message = tiles.get(item.token).querySelector(".ask input").value.trim();
  // Changes with nothing to act on are no use to the agent, unless frame notes are already waiting.
  if (!message && !item.notes) return;
  if (!name()) return;
  asking = null;
  decide(item, "changes", message);
  // Typing in the note doesn't reach the page's keys; give them back to whichever tile is selected now.
  tiles.get(selected || item.token).focus({ preventScroll: true });
}

// ---------- Keyboard ----------

function columns(order) {
  const top = tiles.get(order[0].token).offsetTop;
  let n = 0;
  while (n < order.length && tiles.get(order[n].token).offsetTop === top) n++;
  return Math.max(1, n);
}

function move(key) {
  const order = shown();
  if (!order.length) return;
  const at = order.findIndex((i) => i.token === selected);
  if (at < 0) { select(order[0].token, true); return; }
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(order), ArrowDown: columns(order) }[key];
  const to = at + step;
  if (to >= 0 && to < order.length) select(order[to].token, true);
  else if (key === "ArrowDown" && at < order.length - 1) select(order[order.length - 1].token, true); // a short last row
}

function setFilter(on) {
  undecidedOnly = on; store.set("cc-batch-undecided", on ? "1" : "0");
  if (on && selected && !shown().some((i) => i.token === selected)) selected = null;
  render();
}
$("undecided").onchange = (e) => { setFilter(e.target.checked); e.target.blur(); };

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.tagName === "INPUT" && e.target.type === "text") return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const item = items.find((i) => i.token === selected);
  if (key.startsWith("Arrow")) { e.preventDefault(); move(key); }
  else if (key === "u") setFilter(!undecidedOnly);
  else if (key === "m") { sound = !sound; if (selected) play(selected, true); }
  else if (key === "z") undo();
  else if (key === "Escape") { if (asking) ask(null); }
  else if (!item || item.busy) return;
  else if (key === "a") approve(item);
  else if (key === "x") { e.preventDefault(); ask(item); }
  else if (key === "Enter" && !["BUTTON", "A"].includes(e.target.tagName)) { e.preventDefault(); window.open("/r/" + item.token, "_blank", "noopener"); }
});

// ---------- Data ----------

// Decisions made on a review's own page (or by someone else on this one) show up when the tab is looked
// at again, and every half minute while it's open.
async function load() {
  let d;
  try { d = await (await fetch(base + "/data")).json(); } catch { return; }
  if (!d.items) return;
  $("team").textContent = d.batch.team ? d.batch.team.name : "";
  items = d.items.map((fresh) => {
    const mine = items.find((i) => i.token === fresh.token);
    if (!mine) return fresh;
    if (mine.busy || (held && held.item === mine)) return mine;
    if (mine.status !== fresh.status) mine.state = "";
    return Object.assign(mine, fresh);
  });
  loaded = true;
  if (selected && !shown().some((i) => i.token === selected)) selected = null;
  // Nothing is selected until the reviewer picks a tile, so a stray A can't approve the first cut.
  render();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden && !asking) load(); }, 30000);
showName();
load();
</script>
</html>`;

// Reviews: agents publish renders and other outputs to R2 and get a private link to a review page.
//
//   PUT  /api/publish?task=<id>&title=<t>&filename=<f>[&completes_task=1][&batch=<name>][&version_of=<link|token>][&note=<what changed>]
//                                                         upload (Bearer UPLOAD_TOKEN), returns the link
//   POST /api/reviews/current                             { review: <link|token> } makes that version the current one (Bearer UPLOAD_TOKEN)
//   GET  /r/<team>/<token>                                review page (/r/<token> redirects here)
//   GET  /r/<token>/file                                  the file (Range requests, for scrubbing)
//   GET  /r/<token>/data                                  review, task and notes as JSON
//   POST /r/<token>/notes                                 a note, at a timecode with a still or on a quoted passage (from these pages only)
//   GET  /r/<token>/still/<name>                          a commented frame
//   POST /r/<token>/decision                              approve / request changes (from these pages only, or Bearer UPLOAD_TOKEN)
//
// Notes and decisions are taken only from Control Center's own pages (review-shared.ts `fromOwnPage`).
// The link is the access control (a long random token), which is fine for the owner and their team; the team
// key in the path is only there so a link says whose work it is, and is ignored when matching. Notes
// are stored already delivered; the decision is posted to the task as one comment listing them, so a
// waiting agent gets the whole review at once. With completes_task, approving also marks the task done,
// which frees whatever was waiting on it (task_dependencies); the runner still delivers the decision to
// the session before asking it to clean up.
//
// Versions: reviews of the same deliverable form a piece (reviews.piece_id, assigned by a trigger when
// published: version_of if given, else the same task and the same title without its version number).
// Each version keeps its own link, notes and decision. One is current, the newest unless the publisher
// says otherwise; the rest are superseded, and approving one of those has to be confirmed.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addToNamedBatch } from "./batch";
import { database, escapeHtml, fromOwnPage, json, mayUpload, PAGE_HEADERS, randomToken, reviewPath, teamKey, tokenOf, type ReviewEnv } from "./review-shared";

export type { ReviewEnv };

type Review = {
  id: number;
  token: string;
  task_id: number;
  title: string;
  object_key: string;
  content_type: string | null;
  size: number | null;
  status: "open" | "approved" | "changes_requested";
  completes_task: boolean;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  piece_id: number;
  version: number;
  note: string | null;
  is_current: boolean;
};

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
};

export async function handleReview(request: Request, env: ReviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/publish") return publish(request, env, url);
  if (url.pathname === "/api/reviews/current") return makeCurrent(request, env);

  // Sub-routes are short words, so a 20+ character second segment can only be the token.
  const match = url.pathname.match(/^\/r\/(?:([a-z0-9][a-z0-9-]*)\/)?([A-Za-z0-9_-]{20,})(\/.*)?$/);
  if (!match) return null;
  const [, teamInPath, token, rest = ""] = match;
  const db = database(env);
  const { data: review } = await db.from("reviews").select("*").eq("token", token).maybeSingle<Review>();
  if (!review) return new Response("Not found", { status: 404 });

  if (rest === "" && request.method === "GET") {
    // Older links (and links from before a task changed team) go to the address naming its team.
    const team = await teamKey(db, review.task_id);
    if ((team ?? undefined) !== teamInPath) return Response.redirect(`${url.origin}${reviewPath(team, token)}`, 302);
    return page(review);
  }
  if (rest === "/file") return serveObject(request, env, review.object_key, review.content_type);
  if (rest === "/data") return data(db, review);
  if ((rest === "/notes" || rest === "/decision") && request.method === "POST") {
    if (!(await fromOwnPage(request, env))) return json({ error: "Notes and decisions are accepted only from Control Center's own pages." }, 403);
    return rest === "/notes" ? addNote(request, env, db, review) : decide(request, db, review);
  }
  const still = rest.match(/^\/still\/([a-f0-9-]+\.jpg)$/);
  if (still) return serveObject(request, env, `${review.object_key.replace(/\/[^/]+$/, "")}/stills/${still[1]}`, "image/jpeg");
  return new Response("Not found", { status: 404 });
}

// ---------- Publish ----------

async function publish(request: Request, env: ReviewEnv, url: URL) {
  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  if (!(await mayUpload(request, env))) return new Response("Unauthorized", { status: 401 });

  const taskId = Number(url.searchParams.get("task"));
  const filename = (url.searchParams.get("filename") ?? "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const title = (url.searchParams.get("title") ?? filename).slice(0, 200);
  if (!Number.isInteger(taskId) || taskId <= 0 || !request.body) return json({ error: "task and a file body are required" }, 400);

  const db = database(env);
  const { data: task } = await db.from("tasks").select("id,parent_id,team_id").eq("id", taskId).maybeSingle();
  if (!task) return json({ error: `CC-${taskId} not found` }, 404);

  // Named explicitly, a version joins that review's piece whatever either is called (and whichever task it's on).
  const note = url.searchParams.get("note")?.trim().slice(0, 500) || null;
  const versionOf = url.searchParams.get("version_of");
  let pieceId: number | undefined;
  if (versionOf) {
    const { data: earlier } = await db.from("reviews").select("piece_id").eq("token", tokenOf(versionOf)).maybeSingle();
    if (!earlier) return json({ error: "version_of doesn't name a published review" }, 404);
    pieceId = earlier.piece_id;
  }

  const token = randomToken();
  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
  const key = `tasks/${taskId}/${token}/${filename}`;
  const stored = await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });

  const { data: review, error } = await db
    .from("reviews")
    .insert({
      token,
      task_id: taskId,
      title,
      object_key: key,
      content_type: contentType,
      size: stored.size,
      completes_task: url.searchParams.get("completes_task") === "1",
      note,
      ...(pieceId ? { piece_id: pieceId } : {}),
    })
    .select()
    .single<Review>();
  if (error) return json({ error: error.message }, 500);

  const link = `${env.PUBLIC_URL}${reviewPath(await teamKey(db, taskId), token)}`;
  await db.rpc("append_task_link", { p_task: taskId, p_title: title, p_url: link });
  await db.from("task_events").insert({ task_id: taskId, kind: "agent_log", body: `published ${title} for review${review.version > 1 ? ` (version ${review.version})` : ""}`, actor: "agent" });

  // --batch: the review also joins the named batch for the task's parent, so a day's cuts share one link.
  const batchName = url.searchParams.get("batch")?.trim().slice(0, 200);
  const batch = batchName ? await addToNamedBatch(db, env, task, review, batchName) : null;
  if (batch && "error" in batch) return json({ error: `Published at ${link}, but not added to the batch: ${batch.error}`, url: link }, 500);
  return json({ url: link, review_id: review.id, size: stored.size, version: review.version, ...(batch ? { batch_url: batch.url } : {}) });
}

// For a newer cut that was withdrawn: an older version becomes the one that counts, and the rest are superseded.
async function makeCurrent(request: Request, env: ReviewEnv) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await mayUpload(request, env))) return new Response("Unauthorized", { status: 401 });
  const input = (await request.json().catch(() => ({}))) as { review?: unknown };
  const db = database(env);
  const { data: review } = await db.from("reviews").select("*").eq("token", tokenOf(input.review)).maybeSingle<Review>();
  if (!review) return json({ error: "review (a link or token) doesn't name a published review" }, 404);

  const { count } = await db.from("reviews").select("id", { count: "exact", head: true }).eq("piece_id", review.piece_id);
  if (!review.is_current) {
    const { error } = await db.rpc("set_current_review", { p_review: review.id });
    if (error) return json({ error: error.message }, 500);
    await db.from("task_events").insert({
      task_id: review.task_id,
      kind: "agent_log",
      body: `made version ${review.version} of ${review.title} the current one; the other ${(count ?? 2) > 2 ? "versions are" : "version is"} superseded`,
      actor: "agent",
    });
  }
  const link = `${env.PUBLIC_URL}${reviewPath(await teamKey(db, review.task_id), review.token)}`;
  return json({ url: link, version: review.version, versions: count ?? 1, current: true });
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

type VersionRow = Pick<Review, "token" | "title" | "status" | "decided_by" | "content_type" | "object_key" | "created_at" | "version" | "note" | "is_current"> & {
  task: { team: { key: string } | null } | null;
};

async function data(db: SupabaseClient, review: Review) {
  const [task, notes, versions, others] = await Promise.all([
    db.from("tasks").select("id,title,status,team:teams(key,name)").eq("id", review.task_id).single(),
    db
      .from("task_comments")
      .select("id,author,author_name,body,timecode,still_url,quote,quote_start,created_at")
      .eq("review_id", review.id)
      .not("delivered_at", "is", null)
      .order("timecode", { ascending: true, nullsFirst: true })
      .order("quote_start", { ascending: true, nullsFirst: true })
      .order("created_at"),
    db
      .from("reviews")
      .select("token,title,status,decided_by,content_type,object_key,created_at,version,note,is_current,task:tasks(team:teams(key))")
      .eq("piece_id", review.piece_id)
      .order("version", { ascending: false })
      .returns<VersionRow[]>(),
    // What else is on the task: the current version of each other piece.
    db.from("reviews").select("token,title").eq("task_id", review.task_id).eq("is_current", true).neq("piece_id", review.piece_id).order("created_at"),
  ]);
  const chain = versions.data ?? [];
  const newest = chain[0]?.version ?? review.version;
  return json({
    review: {
      title: review.title,
      status: review.status,
      content_type: review.content_type,
      filename: review.object_key.split("/").pop(),
      decided_by: review.decided_by,
      completes_task: review.completes_task,
      token: review.token,
      version: review.version,
      note: review.note,
      current: review.is_current,
      created_at: review.created_at,
    },
    task: task.data,
    notes: notes.data ?? [],
    // Newest first. A version can be on another task (version_of), so each carries its own address.
    versions: chain.map((v) => ({
      token: v.token,
      path: reviewPath(v.task?.team?.key ?? null, v.token),
      title: v.title,
      version: v.version,
      note: v.note,
      status: v.status,
      decided_by: v.decided_by,
      current: v.is_current,
      latest: v.version === newest,
      content_type: v.content_type,
      filename: v.object_key.split("/").pop(),
      created_at: v.created_at,
    })),
    others: others.data ?? [],
  });
}

async function addNote(request: Request, env: ReviewEnv, db: SupabaseClient, review: Review) {
  const input = (await request.json().catch(() => ({}))) as {
    name?: string;
    body?: string;
    timecode?: number;
    still?: string;
    quote?: string;
    quote_start?: number;
  };
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
  const quote = input.quote?.trim().slice(0, 2000) || null;
  const quoteStart = quote && Number.isInteger(input.quote_start) && input.quote_start! >= 0 ? input.quote_start! : null;
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
      quote,
      quote_start: quoteStart,
      delivered_at: new Date().toISOString(), // reaches the agent with the decision, not one by one
    })
    .select("id,author,author_name,body,timecode,still_url,quote,quote_start,created_at")
    .single();
  return error ? json({ error: error.message }, 500) : json(note);
}

async function decide(request: Request, db: SupabaseClient, review: Review) {
  const input = (await request.json().catch(() => ({}))) as { name?: string; decision?: string; message?: string; confirm_superseded?: boolean };
  const name = input.name?.trim().slice(0, 60);
  const decision = input.decision === "approve" ? "approved" : input.decision === "changes" ? "changes_requested" : null;
  if (!name || !decision) return json({ error: "name and decision are required" }, 400);

  // Approving a version that isn't the one that counts has to be meant. Checked here, not only on the
  // page, so a batch grid or an old tab that still thinks this version is current can't do it by accident.
  let supersededBy: number | null = null;
  if (!review.is_current) {
    const { data: current } = await db.from("reviews").select("version").eq("piece_id", review.piece_id).eq("is_current", true).maybeSingle();
    supersededBy = current?.version ?? null;
    if (decision === "approved" && input.confirm_superseded !== true) {
      return json({
        error: `Version ${review.version} is superseded${supersededBy ? `: version ${supersededBy} is the current one` : ""}. Approving it has to be confirmed.`,
        superseded: true,
        current_version: supersededBy,
      }, 409);
    }
  }

  // Every note since this version's last decision goes to the agent in one message.
  let notesQuery = db
    .from("task_comments")
    .select("author_name,body,timecode,still_url,quote")
    .eq("review_id", review.id)
    .not("delivered_at", "is", null)
    .order("timecode", { ascending: true, nullsFirst: true })
    .order("quote_start", { ascending: true, nullsFirst: true })
    .order("created_at");
  if (review.decided_at) notesQuery = notesQuery.gt("created_at", review.decided_at);
  const { data: notes } = await notesQuery;

  const lines = (notes ?? []).map(
    (n) =>
      `- ${n.timecode !== null ? `[${formatTime(n.timecode)}] ` : ""}${n.quote ? `On "${clip(n.quote)}": ` : ""}${n.body}${n.author_name !== name ? ` (${n.author_name})` : ""}` +
      (n.still_url ? ` frame: ${n.still_url}` : ""),
  );
  const message = input.message?.trim();
  // The agent should know when the decision is about a version that no longer counts.
  const which = review.is_current ? "" : ` (version ${review.version}, superseded${supersededBy ? ` by version ${supersededBy}` : ""})`;
  const headline = (decision === "approved" ? `Approved "${review.title}"` : `Changes requested on "${review.title}"`) + which;
  // Done before the comment, which only says so if it worked. Should the runner look in between, it asks
  // the session to clean up first and types the decision on its next poll: the window stays open for that.
  let completed = false;
  let completeError: string | null = null;
  if (decision === "approved" && review.completes_task) {
    // A task that was cancelled in the meantime stays cancelled.
    const { data: finished, error } = await db
      .from("tasks")
      .update({ status: "done", question: null })
      .eq("id", review.task_id)
      .not("status", "in", "(done,cancelled)")
      .select("id");
    completeError = error?.message ?? null;
    completed = Boolean(finished?.length);
  }
  const body = [
    headline + (message ? `: ${message}` : "."),
    lines.length ? `Notes:\n${lines.join("\n")}` : "",
    completed ? `This approval completes CC-${review.task_id}: it's now marked done, so there's nothing more to do on it.` : "",
  ]
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
  if (error) return json({ error: error.message }, 500);
  if (completed) {
    await db.from("task_events").insert({
      task_id: review.task_id,
      kind: "status",
      body: `done: ${name} approved "${review.title}"`,
      actor: "reviewer",
    });
  }
  // The decision is recorded and on its way to the agent, but the reviewer should know the task isn't done.
  if (completeError) return json({ error: `Decision sent, but the task couldn't be marked done: ${completeError}` }, 500);
  return json({ ok: true, status: decision, completed_task: completed });
}

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
};

// ---------- Page ----------

function page(review: Review) {
  return new Response(
    REVIEW_PAGE.replaceAll("__TITLE__", escapeHtml(review.title)).replaceAll("__TOKEN__", review.token),
    { headers: PAGE_HEADERS },
  );
}


// String.raw so the page's regexes keep their backslashes; the page must not contain backticks or "${".
const REVIEW_PAGE = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>__TITLE__ · Review</title>
<style>
  :root { --bg: #f6f5f2; --panel: #fff; --text: #1d1d1f; --muted: #6e6e73; --line: #e3e1dc; --accent: #5b5bd6; --ok: #1f8a4c; --warn: #c2410c; --mark: #fde68a; --mark-on: #fbbf24; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141416; --panel: #1d1d20; --text: #f2f2f4; --muted: #a1a1a8; --line: #2e2e33; --accent: #8b8bf0; --ok: #3fbf76; --warn: #f08a4b; --mark: #5c4a12; --mark-on: #8a6a10; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 17px; margin: 0; }
  header .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 13px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--line); }
  .badge.approved { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.changes_requested { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; padding: 20px; max-width: 1400px; margin: 0 auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 12px; } }
  .stage { background: #000; border-radius: 10px; overflow: hidden; display: flex; justify-content: center; }
  video, img.media { max-width: 100%; max-height: 72vh; display: block; }
  iframe.media { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
  .download { color: #fff; padding: 40px; }
  .download a { color: #fff; }

  /* Pages and PDFs fill the window; the review panel docks on the right and can be hidden. */
  body.wide { height: 100vh; display: flex; flex-direction: column; }
  body.wide main { flex: 1; min-height: 0; width: 100%; max-width: none; margin: 0; padding: 0; gap: 0; }
  body.wide main > section { min-height: 0; }
  body.wide .stage { height: 100%; border-radius: 0; background: #fff; }
  body.wide aside { overflow-y: auto; padding: 12px; border-left: 1px solid var(--line); }
  body.wide.collapsed main { grid-template-columns: minmax(0, 1fr); }
  body.wide.collapsed aside { display: none; }
  @media (max-width: 900px) {
    body.wide { height: auto; display: block; }
    body.wide .stage { height: 80vh; }
    body.wide aside { border-left: 0; }
  }

  /* Text outputs read as a document; select a passage to comment on it. */
  body.text .stage { background: none; display: block; overflow: visible; }
  .doc { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 44px 56px; max-width: 760px; margin: 0 auto;
         font-size: 16.5px; line-height: 1.65; overflow-wrap: anywhere; }
  @media (max-width: 700px) { .doc { padding: 24px 20px; } }
  .doc > :first-child { margin-top: 0; }
  .doc h1, .doc h2, .doc h3, .doc h4 { line-height: 1.25; margin: 1.4em 0 .5em; }
  .doc h1 { font-size: 1.6em; } .doc h2 { font-size: 1.3em; } .doc h3 { font-size: 1.1em; }
  .doc p, .doc ul, .doc ol, .doc blockquote, .doc pre { margin: 0 0 1em; }
  .doc blockquote { border-left: 3px solid var(--line); padding-left: 14px; color: var(--muted); }
  .doc pre { background: var(--bg); padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  .doc code { font-size: .9em; background: var(--bg); padding: 1px 4px; border-radius: 4px; }
  .doc pre code { background: none; padding: 0; }
  .doc hr { border: 0; border-top: 1px solid var(--line); margin: 1.6em 0; }
  .doc .plain { white-space: pre-wrap; }
  mark.q { background: var(--mark); color: inherit; border-radius: 2px; cursor: pointer; }
  mark.q.on, mark.q.pending { background: var(--mark-on); }
  #quoteBtn { position: absolute; z-index: 5; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
  .quote { font-size: 13px; color: var(--muted); border-left: 3px solid var(--mark-on); padding: 1px 0 1px 8px; margin: 2px 0 4px; cursor: pointer;
           display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .quote.missing { border-left-color: var(--line); cursor: default; }
  #pending { margin: 6px 0; display: flex; gap: 6px; align-items: flex-start; }
  #pending[hidden] { display: none; }
  #pending .quote { flex: 1; margin: 0; cursor: default; }
  #pending button { padding: 0 6px; font-size: 13px; }

  .controls { display: flex; gap: 8px; align-items: center; margin: 10px 0 4px; flex-wrap: wrap; }
  button { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; border-color: transparent; }
  button.ok { background: var(--ok); color: #fff; border-color: transparent; }
  button.warn { background: var(--warn); color: #fff; border-color: transparent; }
  button.small { font-size: 13px; padding: 3px 10px; }
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
  .note > div { min-width: 0; flex: 1; }
  .note.on { background: color-mix(in srgb, var(--mark) 35%, transparent); margin: 0 -12px; padding: 8px 12px; }
  .note img { width: 72px; border-radius: 4px; cursor: pointer; }
  .tc { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--accent); cursor: pointer; border: 0; padding: 0; background: none; }
  .who { font-size: 12px; color: var(--muted); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  a { color: var(--accent); }
  .controls .spacer { flex: 1; }
  .controls a { font-size: 13px; }
  .speed { display: inline-flex; }
  .speed button { border-radius: 0; margin-left: -1px; padding: 6px 9px; font-variant-numeric: tabular-nums; }
  .speed button:first-child { border-radius: 8px 0 0 8px; margin-left: 0; }
  .speed button:last-child { border-radius: 0 8px 8px 0; }
  .speed button[aria-pressed="true"] { background: var(--accent); color: #fff; border-color: var(--accent); position: relative; }
  /* Full screen takes the player with its timeline and controls, so notes' markers and frame stepping come along. */
  #player:fullscreen { background: var(--bg); padding: 12px 16px; display: flex; flex-direction: column; }
  #player:fullscreen .stage { flex: 1; min-height: 0; align-items: center; }
  #player:fullscreen video { max-height: 100%; }

  /* A video with several versions: they stack down the left, newest first, and the player swaps between them. */
  .mark { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 99px; white-space: nowrap; background: var(--line); color: var(--muted); }
  .mark.latest, .mark.current { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .mark:empty, .badge[hidden] { display: none; }
  #rail[hidden], #versionBar[hidden], #newer[hidden], #confirm[hidden], .row[hidden] { display: none; }
  body.chain main { grid-template-columns: 236px minmax(0, 1fr) 340px; max-width: 1640px; }
  #rail { align-self: start; position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow-y: auto; }
  #rail h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 0 0 8px; padding: 0 8px; }
  #railList { display: flex; flex-direction: column; gap: 2px; }
  .ver { display: flex; gap: 10px; padding: 8px; border-radius: 10px; border: 1px solid transparent; color: inherit; text-decoration: none; min-width: 0; }
  .ver:hover { background: color-mix(in srgb, var(--line) 55%, transparent); }
  .ver.sel { background: var(--panel); border-color: var(--line); box-shadow: inset 3px 0 0 var(--accent); }
  .ver .thumb { flex: none; width: 46px; height: 62px; border-radius: 6px; overflow: hidden; background: #000; }
  .ver .thumb video, .ver .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
  .ver.old:not(.sel) .thumb { opacity: .55; }
  .ver .about { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .ver .vn { display: flex; gap: 6px; align-items: center; font-weight: 600; font-size: 14px; white-space: nowrap; }
  .ver .vnote { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vstate { font-size: 12px; color: var(--muted); display: flex; gap: 5px; align-items: center; white-space: nowrap; overflow: hidden; }
  .vstate::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--muted); }
  .vstate.approved { color: var(--ok); } .vstate.approved::before { background: var(--ok); border-color: var(--ok); }
  .vstate.changes_requested { color: var(--warn); } .vstate.changes_requested::before { background: var(--warn); border-color: var(--warn); }
  #versionBar { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin: 0 0 10px; }
  #versionBar strong { font-size: 16px; }
  #versionNote { flex: 1 1 200px; min-width: 0; }
  #newer, #confirm { border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); background: color-mix(in srgb, var(--warn) 9%, var(--panel));
                     border-radius: 10px; padding: 8px 12px; font-size: 14px; }
  #newer { margin: 0 0 10px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  #confirm { margin-top: 8px; }
  #confirm p { margin: 0 0 8px; }
  @media (max-width: 1180px) {
    body.chain main { grid-template-columns: 212px minmax(0, 1fr); }
    body.chain aside { grid-column: 2; }
  }
  @media (max-width: 900px) {
    body.chain main { grid-template-columns: minmax(0, 1fr); }
    body.chain aside { grid-column: auto; }
    /* The rail becomes a strip above the player. */
    #rail { position: static; max-height: none; overflow: visible; min-width: 0; }
    #rail h2 { padding: 0; margin-bottom: 4px; }
    #railList { flex-direction: row; gap: 6px; overflow-x: auto; padding-bottom: 6px; scroll-snap-type: x proximity; }
    .ver { flex: none; width: 216px; border-color: var(--line); scroll-snap-align: center; }
    .ver.sel { box-shadow: inset 0 -3px 0 var(--accent); }
    .ver .thumb { width: 40px; height: 54px; }
  }
</style>
<header>
  <h1 id="title">__TITLE__</h1>
  <span id="status" class="badge"></span>
  <span id="superseded" class="badge changes_requested" hidden>Superseded</span>
  <span id="task" class="muted"></span>
  <span id="versions" class="muted"></span>
  <span id="others" class="muted"></span>
  <span class="spacer"></span>
  <a id="openFull" class="muted" href="/r/__TOKEN__/file" target="_blank" rel="noopener" hidden>Open on its own ↗</a>
  <button id="toggle" class="small" hidden>Hide notes</button>
</header>
<main>
  <nav id="rail" aria-label="Versions" hidden><h2>Versions</h2><div id="railList"></div></nav>
  <section id="player">
    <div id="versionBar" hidden><strong id="versionName"></strong><span class="muted" id="versionDate"></span><span class="mark" id="versionMark"></span><span class="muted" id="versionNote"></span></div>
    <div id="newer" hidden><span id="newerText"></span><a id="newerOpen" href="#"></a></div>
    <div class="stage" id="stage"></div>
    <div id="videoControls" hidden>
      <div class="track" id="track"><div class="head" id="head"></div></div>
      <div class="controls">
        <button id="back5" title="Back 5 seconds (←)">−5s</button>
        <button id="back" title="Previous frame (,)">◀ Frame</button>
        <button id="play" title="Play / pause (space)">Play</button>
        <button id="fwd" title="Next frame (.)">Frame ▶</button>
        <button id="fwd5" title="Forward 5 seconds (→)">+5s</button>
        <span class="time" id="clock">0:00.0</span>
        <span class="speed" id="speed" role="group" aria-label="Speed"><button data-rate="1">1×</button><button data-rate="1.5">1.5×</button><button data-rate="2">2×</button></span>
        <button id="full" title="Full screen (F)">Full screen</button>
        <span class="spacer"></span>
        <span class="muted" id="versionCount"></span>
        <button class="small" id="copy">Copy link</button>
        <a id="download" href="/r/__TOKEN__/file" download>Download</a>
      </div>
    </div>
  </section>
  <aside>
    <div class="panel">
      <div class="row" style="justify-content: space-between">
        <strong id="noteLabel">Note</strong>
        <span class="who">as <a href="#" id="who"></a></span>
      </div>
      <div id="pending" hidden><div class="quote" id="pendingQuote"></div><button id="clearQuote" title="Make it a general note">×</button></div>
      <textarea id="body" placeholder="What should change? (Enter adds it)"></textarea>
      <div class="row" style="margin-top: 8px"><button class="primary" id="add">Add note</button><span class="muted" id="addState"></span></div>
    </div>
    <div class="panel"><strong>Notes</strong><div id="notes"><p class="muted">No notes yet.</p></div></div>
    <div class="panel">
      <strong>Decision</strong>
      <textarea id="message" placeholder="Optional message to the agent" style="min-height: 44px; margin-top: 6px"></textarea>
      <div class="row" id="decide" style="margin-top: 8px">
        <button class="warn" id="changes">Request changes</button>
        <button class="ok" id="approve">Approve</button>
      </div>
      <div id="confirm" hidden>
        <p id="confirmText"></p>
        <div class="row"><button class="ok" id="confirmYes"></button><button id="confirmNo">Cancel</button><a id="confirmOpen" href="#"></a></div>
      </div>
      <p class="muted" id="decisionState"></p>
      <p class="muted" id="decisionHint" hidden>Approving completes this task.</p>
    </div>
  </aside>
</main>
<button id="quoteBtn" class="primary small" hidden>Comment</button>
<script>
// The version on screen. A video's versions swap in place, so this changes without a page load.
let token = "__TOKEN__", base = "/r/" + token;
let review = null, chain = [];
const FPS = 30;
const $ = (id) => document.getElementById(id);
const fmt = (s) => Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0");
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
let video = null, doc = null, docHtml = "", notes = [], pending = null, mode = null;

// Asked the first time someone adds a note or decides, then remembered on this device.
function showName() { $("who").textContent = store.get("cc-review-name") || "set your name"; }
function name() {
  let n = store.get("cc-review-name");
  if (!n) { n = (prompt("Your name (shown on your notes)") || "").trim(); if (n) store.set("cc-review-name", n); }
  showName();
  return n;
}
$("who").onclick = (e) => { e.preventDefault(); store.set("cc-review-name", null); name(); };

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML.replace(/"/g, "&quot;"); }

// ---------- Text documents ----------

// A small Markdown renderer that escapes everything first, so a draft can't run script on this page.
// Single line breaks are kept (posts and scripts rely on them). Blocks are joined with newlines so the
// document's text keeps its line breaks, which is what selections and saved quotes are measured in.
function inline(s) {
  const codes = [];
  s = esc(s).replace(/\x60([^\x60]+)\x60/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
       .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>")
       .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[i] + "</code>");
}
function markdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n"), out = [];
  const listItem = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^\s*\x60\x60\x60/.test(line)) {
      const code = []; i++;
      while (i < lines.length && !/^\s*\x60\x60\x60/.test(lines[i])) code.push(lines[i++]);
      i++; out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>"); continue;
    }
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push("<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push("<blockquote>" + markdown(q.join("\n")) + "</blockquote>"); continue;
    }
    if ((m = line.match(listItem))) {
      const ordered = /\d/.test(m[1]), items = [];
      while (i < lines.length && (m = lines[i].match(listItem)) && /\d/.test(m[1]) === ordered) {
        let text = m[2]; i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listItem.test(lines[i])) text += "\n" + lines[i++].trim();
        items.push("<li>" + text.split("\n").map(inline).join("\n<br>") + "</li>");
      }
      const tag = ordered ? "ol" : "ul";
      out.push("<" + tag + ">\n" + items.join("\n") + "\n</" + tag + ">"); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*\x60\x60\x60)/.test(lines[i]) && !listItem.test(lines[i])) para.push(lines[i++]);
    out.push("<p>" + para.map(inline).join("\n<br>") + "</p>");
  }
  return out.join("\n");
}

function textNodes() {
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT), list = [];
  let pos = 0, n;
  while ((n = walker.nextNode())) { list.push({ node: n, start: pos }); pos += n.data.length; }
  return list;
}
// Where a saved quote is in the document: its recorded offset if the text there still matches, else
// the first place the words appear.
function locate(quote, start) {
  const text = doc.textContent;
  if (start !== null && start !== undefined && text.substr(start, quote.length) === quote) return start;
  const i = text.indexOf(quote);
  return i >= 0 ? i : null;
}
function wrap(start, end, cls, id) {
  for (const { node, start: s } of textNodes()) {
    const e = s + node.data.length;
    if (e <= start || s >= end || !node.data.trim()) continue;
    let target = node;
    if (start > s) target = target.splitText(start - s);
    if (end < e) target.splitText(end - Math.max(start, s));
    const mark = document.createElement("mark");
    mark.className = "q " + cls; if (id !== undefined) mark.dataset.note = id;
    target.parentNode.insertBefore(mark, target); mark.appendChild(target);
  }
}
function highlight() {
  if (!doc) return;
  doc.innerHTML = docHtml;
  for (const n of notes) {
    n.at = n.quote ? locate(n.quote, n.quote_start) : null;
    if (n.at !== null) wrap(n.at, n.at + n.quote.length, "", n.id);
  }
  if (pending) wrap(pending.start, pending.start + pending.quote.length, "pending");
}
function focusNote(id, scrollDoc) {
  document.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
  const marks = doc ? doc.querySelectorAll('mark[data-note="' + id + '"]') : [];
  marks.forEach((m) => m.classList.add("on"));
  const el = document.querySelector('.note[data-id="' + id + '"]');
  if (el) { el.classList.add("on"); if (!scrollDoc) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  if (scrollDoc && marks[0]) marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
}

function selectionInDoc() {
  const sel = getSelection();
  if (!doc || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!doc.contains(range.commonAncestorContainer)) return null;
  const before = document.createRange();
  before.setStart(doc, 0); before.setEnd(range.startContainer, range.startOffset);
  const raw = range.toString(), quote = raw.trim();
  if (!quote) return null;
  return { range, quote, start: before.toString().length + (raw.length - raw.trimStart().length) };
}
function placeQuoteButton() {
  const s = selectionInDoc(), btn = $("quoteBtn");
  if (!s) { btn.hidden = true; return; }
  const r = s.range.getBoundingClientRect();
  btn.hidden = false;
  btn.style.top = (r.top + scrollY - btn.offsetHeight - 8) + "px";
  btn.style.left = Math.max(8, Math.min(innerWidth - btn.offsetWidth - 8, r.left + scrollX + r.width / 2 - btn.offsetWidth / 2)) + "px";
}
function setPending(p) {
  pending = p;
  $("pending").hidden = !p;
  $("pendingQuote").textContent = p ? "“" + p.quote + "”" : "";
  $("noteLabel").textContent = p ? "Comment on the selection" : "Note";
  highlight();
}
$("quoteBtn").addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
$("quoteBtn").onclick = () => {
  const s = selectionInDoc(); if (!s) return;
  getSelection().removeAllRanges(); $("quoteBtn").hidden = true;
  setPending({ quote: s.quote, start: s.start });
  $("body").focus();
};
$("clearQuote").onclick = () => setPending(null);

async function setupText(type, filename) {
  const res = await fetch(base + "/file");
  const src = await res.text();
  const isMarkdown = /markdown/.test(type) || /\.(md|markdown)$/i.test(filename || "");
  $("stage").innerHTML = '<article class="doc" id="doc"></article>';
  doc = $("doc");
  docHtml = isMarkdown ? markdown(src) : '<div class="plain">' + esc(src) + "</div>";
  $("body").placeholder = "Select text in the draft to comment on it, or write a general note. (Enter adds it)";
  document.addEventListener("mouseup", () => setTimeout(placeQuoteButton));
  document.addEventListener("keyup", (e) => { if (e.shiftKey) placeQuoteButton(); });
  doc.addEventListener("click", (e) => { const m = e.target.closest("mark[data-note]"); if (m) focusNote(m.dataset.note, false); });
  highlight(); render();
}

// ---------- Notes ----------

function render() {
  const list = mode === "text" ? [...notes].sort((a, b) => (a.at ?? -1) - (b.at ?? -1)) : notes;
  $("notes").innerHTML = list.length ? "" : '<p class="muted">No notes yet.</p>';
  for (const n of list) {
    const el = document.createElement("div");
    el.className = "note"; el.dataset.id = n.id;
    const missing = doc && n.at === null;
    el.innerHTML = (n.still_url ? '<img src="' + n.still_url + '" alt="">' : "") +
      '<div>' + (n.timecode !== null ? '<button class="tc">' + fmt(n.timecode) + '</button> ' : "") +
      '<span class="who">' + esc(n.author_name || n.author) + '</span>' +
      (n.quote ? '<div class="quote' + (missing ? ' missing" title="Not found in this version' : "") + '">“' + esc(n.quote) + '”</div>' : "") +
      '<div>' + esc(n.body) + '</div></div>';
    const seek = () => { if (video && n.timecode !== null) { video.pause(); video.currentTime = n.timecode; } };
    el.querySelector(".tc")?.addEventListener("click", seek);
    el.querySelector("img")?.addEventListener("click", seek);
    if (!missing) el.querySelector(".quote")?.addEventListener("click", () => focusNote(n.id, true));
    $("notes").appendChild(el);
  }
  $("track").querySelectorAll(".marker").forEach((m) => m.remove());
  if (video && video.duration) {
    for (const n of notes) if (n.timecode !== null) {
      const m = document.createElement("div");
      m.className = "marker"; m.style.left = (100 * n.timecode / video.duration) + "%"; m.title = n.body;
      m.onclick = (e) => { e.stopPropagation(); video.pause(); video.currentTime = n.timecode; };
      $("track").appendChild(m);
    }
  }
  $("toggle").textContent = document.body.classList.contains("collapsed") ? "Show notes" + (notes.length ? " (" + notes.length + ")" : "") : "Hide notes";
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
  if (pending) { payload.quote = pending.quote; payload.quote_start = pending.start; }
  const res = await fetch(base + "/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  $("add").disabled = false;
  if (!res.ok) { $("addState").textContent = "Couldn't save: " + (await res.text()); return; }
  if (!res.url.endsWith(base + "/notes")) return; // another version was opened meanwhile; it's saved on its own
  notes.push(await res.json()); notes.sort((a, b) => (a.timecode ?? -1) - (b.timecode ?? -1));
  $("body").value = ""; $("addState").textContent = "";
  setPending(null); render();
}
$("add").onclick = add;
$("body").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); } });

async function decide(decision, confirmed) {
  const who = name(); if (!who) return;
  const buttons = [$("approve"), $("changes"), $("confirmYes")];
  for (const b of buttons) b.disabled = true;
  const res = await fetch(base + "/decision", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: who, decision, message: $("message").value, confirm_superseded: Boolean(confirmed) }) });
  for (const b of buttons) b.disabled = false;
  // This version stopped being the current one while the page was open: say so, and ask.
  if (res.status === 409) { await load(); askSuperseded(); return; }
  askSuperseded(false);
  if (!res.ok) { $("decisionState").textContent = "Couldn't send: " + (await res.text()); return; }
  $("message").value = "";
  const reply = await res.json();
  $("decisionState").textContent = decision !== "approve" ? "Sent. The agent is working on the next version."
    : reply.completed_task ? "Approved. The task is done." : "Approved. The agent will wrap up.";
  load();
}

// Approving a superseded version is asked about here, in the panel, instead of in a browser dialog.
function askSuperseded(show) {
  const current = chain.find((v) => v.current);
  const on = show !== false && review && !review.current;
  $("confirm").hidden = !on; $("decide").hidden = on;
  if (!on) return;
  $("confirmText").textContent = "Version " + review.version + " is superseded" + (current ? ": version " + current.version + " is the current one" : "") + "." +
    (review.completes_task ? " Approving it completes the task." : "") + " Approve it anyway?";
  $("confirmYes").textContent = "Approve version " + review.version + " anyway";
  $("confirmOpen").hidden = !current;
  if (current) { $("confirmOpen").textContent = "Open version " + current.version; $("confirmOpen").href = current.path; $("confirmOpen").onclick = (e) => openVersion(e, current); }
}
// Cancel takes the focus, so Enter or Space straight after Approve doesn't confirm.
$("approve").onclick = () => { if (review && !review.current) { askSuperseded(); $("confirmNo").focus(); } else decide("approve"); };
$("changes").onclick = () => decide("changes");
$("confirmYes").onclick = () => decide("approve", true);
$("confirmNo").onclick = () => { askSuperseded(false); $("approve").focus(); };

// ---------- Media ----------

function kindOf(type, filename) {
  type = type || "";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/html") || type === "application/pdf") return "page";
  if (type.startsWith("text/") || type.startsWith("application/json") || /\.(md|markdown|txt)$/i.test(filename || "")) return "text";
  return "download";
}

const STATE = { open: "Undecided", approved: "Approved", changes_requested: "Changes requested" };
const markOf = (v) => (!v.current ? ["", "Superseded"] : v.latest ? ["latest", "Latest"] : ["current", "Current"]);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// ---------- Versions ----------

// Another version of this video: swapped into the player, with its own notes and decision, and the
// address changes to its link. Anything that isn't a video opens as its own page.
function openVersion(e, v) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return; // a new tab is theirs to ask for
  if (v.token === token) { if (e) e.preventDefault(); return; }
  if (mode !== "video" || kindOf(v.content_type, v.filename) !== "video") return;
  if (e) e.preventDefault();
  history.pushState(null, "", v.path);
  show(v.token);
}
function show(next) {
  token = next; base = "/r/" + token;
  notes = []; review = null;
  video.pause(); video.src = base + "/file";
  $("download").href = base + "/file";
  $("message").value = ""; $("decisionState").textContent = ""; $("addState").textContent = "";
  askSuperseded(false);
  render(); load();
}
addEventListener("popstate", () => {
  const next = location.pathname.split("/").filter(Boolean).pop();
  if (next === token) return;
  if (video && chain.some((v) => v.token === next)) show(next); else location.reload();
});

function renderVersions() {
  const stacked = mode === "video" && chain.length > 1;
  document.body.classList.toggle("chain", stacked);
  $("rail").hidden = !stacked; $("versionBar").hidden = !stacked;
  const current = chain.find((v) => v.current);
  $("superseded").hidden = review.current;
  $("superseded").title = current ? "Version " + current.version + " is the current one" : "";
  // Other kinds keep their links in the header.
  $("versions").innerHTML = stacked || chain.length < 2 ? "" : [...chain].reverse().map((v) =>
    v.token === token ? "<strong>v" + v.version + "</strong>" : '<a href="' + v.path + '"' + (v.current ? ' title="The current version"' : "") + ">v" + v.version + "</a>").join(" · ");
  $("versionCount").textContent = stacked ? chain.length + " versions" : "";
  $("newer").hidden = !stacked || review.current;
  if (!stacked) return;

  $("versionName").textContent = "Version " + review.version;
  $("versionDate").textContent = "· " + day(review.created_at);
  const [cls, label] = markOf(review);
  $("versionMark").textContent = label; $("versionMark").className = "mark " + cls;
  $("versionNote").textContent = review.note || ""; $("versionNote").title = review.note || "";
  if (!review.current && current) {
    $("newerText").textContent = "This version is superseded. Version " + current.version + (current.latest ? ", the newest," : "") + " is the current one.";
    $("newerOpen").textContent = "Open version " + current.version; $("newerOpen").href = current.path; $("newerOpen").onclick = (e) => openVersion(e, current);
  }

  const list = $("railList");
  for (const el of [...list.children]) if (!chain.some((v) => v.token === el.dataset.token)) el.remove();
  chain.forEach((v, at) => {
    let el = [...list.children].find((c) => c.dataset.token === v.token);
    if (!el) {
      el = document.createElement("a");
      el.dataset.token = v.token; el.href = v.path;
      el.innerHTML = '<span class="thumb"></span><span class="about"><span class="vn"><span class="num"></span><span class="mark"></span></span>' +
        '<span class="vnote"></span><span class="vstate"></span></span>';
      // "#t" makes an early frame the poster once the metadata is in, as on the batch grid.
      if (kindOf(v.content_type, v.filename) === "video") {
        const t = document.createElement("video");
        t.muted = true; t.playsInline = true; t.preload = "metadata"; t.tabIndex = -1; t.src = "/r/" + v.token + "/file#t=0.1";
        el.firstChild.appendChild(t);
      } else if (kindOf(v.content_type, v.filename) === "image") {
        el.firstChild.innerHTML = '<img alt="" src="/r/' + v.token + '/file">';
      }
      el.onclick = (e) => openVersion(e, v);
    }
    if (list.children[at] !== el) list.insertBefore(el, list.children[at] || null);
    const q = (c) => el.querySelector(c), [mc, ml] = markOf(v), line = v.note || v.title;
    el.className = "ver" + (v.token === token ? " sel" : "") + (v.current ? "" : " old");
    if (v.token === token) el.setAttribute("aria-current", "true"); else el.removeAttribute("aria-current");
    q(".num").textContent = "Version " + v.version;
    q(".mark").textContent = ml; q(".mark").className = "mark " + mc;
    q(".vnote").textContent = line; q(".vnote").title = line;
    q(".vstate").textContent = STATE[v.status] + (v.status !== "open" && v.decided_by ? " · " + v.decided_by : "");
    q(".vstate").className = "vstate " + v.status;
  });
  const sel = list.querySelector(".sel");
  // In the phone's strip the selected version sits in the middle, so its neighbours show on both sides.
  if (sel && list.scrollWidth > list.clientWidth) list.scrollLeft = sel.offsetLeft - list.offsetLeft - (list.clientWidth - sel.offsetWidth) / 2;
}

$("copy").onclick = async () => {
  const link = location.origin + location.pathname;
  try { await navigator.clipboard.writeText(link); $("copy").textContent = "Copied"; }
  catch { $("copy").textContent = "Couldn't copy"; }
  setTimeout(() => { $("copy").textContent = "Copy link"; }, 1500);
};

function setupMedia(type, filename) {
  const src = base + "/file";
  mode = kindOf(type, filename);
  if (mode === "video") {
    video = document.createElement("video");
    video.src = src; video.playsInline = true; video.preload = "auto";
    $("stage").appendChild(video); $("videoControls").hidden = false;
    $("noteLabel").textContent = "Note at 0:00.0";
    $("body").placeholder = "What should change? (Enter adds it; pause on the frame first)";
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
    // Unlike a frame step, a jump leaves a playing video playing.
    const jump = (s) => { video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + s)); };
    $("back5").onclick = () => jump(-5); $("fwd5").onclick = () => jump(5);
    // The default rate too: swapping to another version loads a new file, which goes back to the default.
    const speed = (rate) => {
      video.defaultPlaybackRate = video.playbackRate = rate;
      for (const b of $("speed").children) b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === rate));
    };
    for (const b of $("speed").children) b.onclick = () => speed(Number(b.dataset.rate));
    speed(1);
    // An iPhone only puts the video itself full screen, with its own controls.
    const player = $("player"), enter = player.requestFullscreen || player.webkitRequestFullscreen;
    const full = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (enter) enter.call(player);
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    };
    $("full").hidden = !enter && !video.webkitEnterFullscreen;
    $("full").onclick = full;
    const fullLabel = () => { $("full").textContent = document.fullscreenElement || document.webkitFullscreenElement ? "Exit full screen" : "Full screen"; };
    document.addEventListener("fullscreenchange", fullLabel); document.addEventListener("webkitfullscreenchange", fullLabel);
    $("track").onclick = (e) => { const r = $("track").getBoundingClientRect(); video.currentTime = (e.clientX - r.left) / r.width * video.duration; };
    document.addEventListener("keydown", (e) => {
      if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === " ") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
      if (e.key === ",") step(-1);
      if (e.key === ".") step(1);
      if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘← is the browser's Back
      if (e.key === "ArrowLeft") { e.preventDefault(); jump(-5); }
      if (e.key === "ArrowRight") { e.preventDefault(); jump(5); }
      if (e.key === "f" || e.key === "F") full();
    });
    $("body").addEventListener("focus", () => video.pause());
  } else if (mode === "image") {
    $("stage").innerHTML = '<img class="media" src="' + src + '" alt="">';
  } else if (mode === "page") {
    document.body.classList.add("wide");
    if (store.get("cc-review-collapsed") === "1") document.body.classList.add("collapsed");
    $("openFull").hidden = false; $("toggle").hidden = false;
    $("toggle").onclick = () => {
      const collapsed = document.body.classList.toggle("collapsed");
      store.set("cc-review-collapsed", collapsed ? "1" : "0"); render();
    };
    $("stage").innerHTML = '<iframe class="media" src="' + src + '"></iframe>';
  } else if (mode === "text") {
    document.body.classList.add("text");
    $("stage").innerHTML = '<p class="muted">Loading…</p>';
    setupText(type, filename);
  } else {
    $("stage").innerHTML = '<p class="download"><a href="' + src + '">Download the file</a></p>';
  }
}

async function load() {
  const asked = token;
  const d = await (await fetch(base + "/data")).json();
  if (asked !== token) return; // another version was opened while this was on its way
  review = d.review; chain = d.versions;
  const team = d.task.team, link = (t) => "/r/" + (team ? team.key + "/" : "") + t;
  $("title").textContent = review.title; document.title = review.title + " · Review";
  $("status").textContent = { open: "Waiting for review", approved: "Approved", changes_requested: "Changes requested" }[review.status];
  $("status").className = "badge " + review.status;
  $("decisionHint").hidden = !review.completes_task;
  $("task").textContent = (team ? team.name + " · " : "") + "CC-" + d.task.id + " · " + d.task.title;
  $("others").innerHTML = d.others.length ? "Also on this task: " + d.others.map((v) =>
    '<a href="' + link(v.token) + '">' + esc(v.title) + "</a>").join(" · ") : "";
  notes = d.notes;
  if (!$("stage").firstChild) setupMedia(review.content_type, review.filename);
  $("download").download = review.filename || "";
  renderVersions();
  if (!$("confirm").hidden) askSuperseded();
  highlight(); render();
}
// A decision made on another version's tab, or from a batch, shows in the rail when this one is looked at again.
document.addEventListener("visibilitychange", () => { if (!document.hidden && chain.length > 1) load(); });
showName();
load();
</script>
</html>`;

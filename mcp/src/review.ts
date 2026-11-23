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
// The sandbox comes from this header alone (the pages' iframes carry no sandbox attribute), so it holds
// however the file is opened. A link a person clicks in a sandboxed page opens as an ordinary tab
// (allow-popups-to-escape-sandbox): a tab that inherited the sandbox has no origin of its own, so the site
// it opens has no cookies or storage and mostly breaks. The page itself stays sandboxed: no allow-same-origin,
// no allow-top-navigation, and a tab it opens onto this origin's HTML files is sandboxed again by this header.
async function serveObject(request: Request, env: ReviewEnv, key: string, contentType: string | null) {
  const rangeHeader = request.headers.get("Range");
  let object: R2ObjectBody | R2Object | null;
  try {
    object = await env.MEDIA.get(key, rangeHeader ? { range: request.headers } : undefined);
  } catch (err) {
    // R2 throws on a range past the end; a player asking for one wants 416 and the real size, not a 500.
    const head = rangeHeader ? await env.MEDIA.head(key) : null;
    if (!head) throw err;
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } });
  }
  if (!object || !("body" in object)) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType ?? headers.get("Content-Type") ?? "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox");

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
  /* A viewer's layout: a slim bar, the player filling what's left, comments down the right. Dark whatever the system says. */
  :root { color-scheme: dark; --stage: #0a0a0b; --bg: #111113; --panel: #18181b; --raise: #232327; --hover: #2d2d33; --text: #ececef; --muted: #9c9ca6;
          --line: #2b2b31; --edge: #3b3b43; --accent: #8b8bf0; --ok: #3fbf76; --warn: #f08a4b; --mark: #5c4a12; --mark-on: #8a6a10; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; font: 13.5px/1.45 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; background: var(--bg); color: var(--text);
         height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
  a { color: var(--accent); }
  svg { width: 16px; height: 16px; flex: none; display: block; }
  .muted { color: var(--muted); font-size: 12.5px; }
  .spacer { flex: 1; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  button, .btn { font: inherit; font-size: 13px; line-height: 18px; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--line); background: var(--raise);
                 color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; white-space: nowrap; }
  button:hover, .btn:hover { background: var(--hover); border-color: var(--edge); }
  button:focus-visible, .btn:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary, button.primary:hover { background: var(--accent); color: #fff; border-color: transparent; }
  button.ok, button.ok:hover { background: var(--ok); color: #fff; border-color: transparent; }
  button.warn, button.warn:hover { background: var(--warn); color: #fff; border-color: transparent; }
  button.primary:hover, button.ok:hover, button.warn:hover { filter: brightness(1.08); }
  button.small { font-size: 12.5px; padding: 3px 9px; }
  button:disabled { opacity: .5; cursor: default; }
  /* Icon buttons: no box until hovered or switched on. */
  .ib, .ib:hover { padding: 6px; border-color: transparent; background: none; color: var(--muted); }
  .ib:hover { background: var(--raise); color: var(--text); }
  .ib[aria-pressed="true"] { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
  textarea, input[type="text"] { width: 100%; font: inherit; padding: 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  textarea { resize: vertical; min-height: 56px; display: block; }
  textarea:focus-visible, input[type="text"]:focus-visible { outline: 0; border-color: var(--accent); }

  /* ---- Top bar ---- */
  .bar { flex: none; display: flex; align-items: center; gap: 12px; padding: 8px 12px; min-height: 49px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .barLeft { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .barRight { flex: none; display: flex; align-items: center; gap: 6px; }
  .bar h1 { font-size: 14px; font-weight: 600; margin: 0; flex: 0 1 auto; min-width: 48px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #task { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip { flex: none; padding: 3px 6px 3px 9px; font-weight: 600; gap: 3px; }
  .chip svg { color: var(--muted); }
  .badge { flex: none; font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--line); white-space: nowrap; }
  .badge.approved { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.changes_requested { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  #openFull { white-space: nowrap; margin-right: 4px; }

  /* ---- Popovers: the version list, speed, shortcuts and the decision. Placed by script under (or over) their button. ---- */
  .pop { position: fixed; z-index: 30; left: 8px; top: 8px; background: var(--raise); border: 1px solid var(--edge); border-radius: 8px; box-shadow: 0 12px 32px rgba(0, 0, 0, .55);
         padding: 6px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-y: auto; }
  .popHead { font-size: 11.5px; color: var(--muted); padding: 4px 9px 6px; }
  .menu { min-width: 150px; }
  .menu a, .menu .item { display: flex; width: 100%; padding: 7px 9px; border: 0; border-radius: 6px; background: none; color: inherit; text-decoration: none; text-align: left; white-space: normal; }
  .menu a:hover, .menu .item:hover { background: var(--hover); }
  .menu .item[aria-checked="true"] { color: var(--accent); font-weight: 600; }
  #othersMenu a { max-width: 320px; overflow-wrap: anywhere; }
  .ver { flex-direction: column; gap: 1px; width: 300px; max-width: 100%; }
  .ver.sel { background: color-mix(in srgb, var(--accent) 15%, transparent); }
  .ver .vn { display: flex; gap: 6px; align-items: center; font-weight: 600; white-space: nowrap; }
  .ver .vdate { margin-left: auto; font-weight: 400; font-size: 12px; color: var(--muted); }
  .ver .vnote { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .mark { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 99px; white-space: nowrap; background: var(--line); color: var(--muted); }
  .mark.latest, .mark.current { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .vstate { font-size: 12px; color: var(--muted); display: flex; gap: 5px; align-items: center; white-space: nowrap; overflow: hidden; }
  .vstate::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--muted); }
  .vstate.approved { color: var(--ok); } .vstate.approved::before { background: var(--ok); border-color: var(--ok); }
  .vstate.changes_requested { color: var(--warn); } .vstate.changes_requested::before { background: var(--warn); border-color: var(--warn); }
  #decision { width: 330px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  #decision p { margin: 0; }
  #decision .row { justify-content: flex-end; }
  #decisionState:empty { display: none; }
  #decisionState, #addState.err { color: var(--warn); }
  #confirmText, #newer { border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border-radius: 7px; padding: 7px 10px; }
  #keys { padding: 10px 12px; }
  #keys dl { margin: 0; display: grid; grid-template-columns: auto auto; gap: 5px 14px; align-items: center; }
  #keys dt { white-space: nowrap; } #keys dd { margin: 0; color: var(--muted); }
  kbd { font: inherit; font-size: 11.5px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--edge); background: var(--bg); }
  #toast { position: fixed; z-index: 40; top: 58px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 24px); padding: 7px 12px; border-radius: 7px;
           background: var(--raise); border: 1px solid var(--edge); box-shadow: 0 8px 24px rgba(0, 0, 0, .5); }

  /* ---- Player pane ---- */
  main { flex: 1; min-height: 0; display: flex; }
  #player { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--stage); }
  #newer { flex: none; margin: 8px 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  /* One cell that is exactly the stage, so whatever is in it is letterboxed to the room there is. */
  .stage { flex: 1; min-height: 0; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; overflow: hidden; background: var(--stage); }
  .stage video { width: 100%; height: 100%; object-fit: contain; display: block; cursor: pointer; }
  img.media { max-width: 100%; max-height: 100%; display: block; }
  iframe.media { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
  .download { padding: 40px; }
  body.collapsed aside { display: none; }

  /* Text outputs read as a document; select a passage to comment on it. */
  body.text .stage { display: block; overflow-y: auto; padding: 24px 16px; background: var(--bg); }
  .doc { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 44px 56px; max-width: 760px; margin: 0 auto;
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
  #quoteBtn { position: fixed; z-index: 20; box-shadow: 0 4px 14px rgba(0, 0, 0, .4); }
  .quote { font-size: 12.5px; color: var(--muted); border-left: 3px solid var(--mark-on); padding: 1px 0 1px 8px; margin: 2px 0 4px; cursor: pointer;
           display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .quote.missing { border-left-color: var(--line); cursor: default; }
  #pending { display: flex; gap: 6px; align-items: flex-start; }
  #pending .quote { flex: 1; margin: 0; cursor: default; }
  #pending button { padding: 0 6px; }

  /* ---- Timeline and transport ---- */
  #videoControls { flex: none; padding: 2px 12px 8px; background: var(--panel); border-top: 1px solid var(--line); }
  /* Dragged with a finger as well as a mouse: touch-action keeps the page from scrolling instead. The whole
     band takes the drag; the rail is the thin line in it, and each note's marker sits just under the rail. */
  .track { position: relative; height: 34px; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .track:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }
  .track .rail { position: absolute; left: 0; right: 0; top: 9px; height: 8px; border-radius: 4px; background: #37373f; overflow: hidden; pointer-events: none; }
  .track .played { height: 100%; width: 0; background: var(--accent); }
  .track .head { position: absolute; top: 6px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px rgba(0, 0, 0, .4); pointer-events: none; transition: transform .1s; }
  .track.scrubbing .head { transform: scale(1.2); }
  .track .marker { position: absolute; top: 21px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--accent); border: 1.5px solid var(--panel); }
  .track .marker:hover, .track .marker.now, .track .marker.on { background: #fff; transform: scale(1.25); }
  .track .tip { position: absolute; z-index: 2; bottom: 30px; padding: 2px 6px; border-radius: 5px; background: var(--text); color: var(--stage); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; display: none; }
  .track.scrubbing .tip, .track.hover .tip { display: block; }
  .transport { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
  .transport .sep { width: 1px; height: 18px; margin: 0 6px; background: var(--line); }
  .time { font-variant-numeric: tabular-nums; font-size: 12.5px; margin: 0 8px; white-space: nowrap; }
  #speedBtn { min-width: 42px; justify-content: center; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  #volume { width: 76px; margin: 0 4px 0 2px; accent-color: var(--accent); }
  /* Full screen takes the player with its timeline and controls, so notes' markers and frame stepping come along. */
  #player:fullscreen { background: var(--stage); }
  #player:-webkit-full-screen { background: var(--stage); width: 100%; height: 100%; }

  /* ---- Comments ---- */
  aside { flex: none; width: 360px; min-height: 0; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--line); }
  .panelHead { flex: none; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 13px 14px 11px; border-bottom: 1px solid var(--line); }
  .panelHead strong { font-size: 13.5px; }
  .panelHead .muted { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #notes { flex: 1; min-height: 0; overflow-y: auto; position: relative; }
  #notes .empty { margin: 0; padding: 14px; }
  .note { display: flex; gap: 10px; padding: 10px 14px 10px 12px; border-bottom: 1px solid var(--line); border-left: 2px solid transparent; }
  .note > div { min-width: 0; flex: 1; }
  .note.seek { cursor: pointer; }
  .note:hover { background: rgba(255, 255, 255, .03); }
  .note.now { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .note.on { background: color-mix(in srgb, var(--mark) 50%, transparent); }
  body.video .note.on { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .noteHead { display: flex; gap: 8px; align-items: center; margin-bottom: 3px; }
  .author { font-size: 12.5px; font-weight: 600; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .when { margin-left: auto; font-size: 11.5px; color: var(--muted); white-space: nowrap; }
  .tc, .tc:hover { flex: none; font-variant-numeric: tabular-nums; font-size: 12px; line-height: 16px; padding: 1px 6px; border: 0; border-radius: 5px; color: var(--accent);
                   background: color-mix(in srgb, var(--accent) 17%, transparent); }
  button.tc:hover { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  .noteBody { white-space: pre-wrap; overflow-wrap: anywhere; }
  .note img { flex: none; width: 64px; align-self: flex-start; border-radius: 4px; cursor: pointer; }
  /* The composer stays at the foot of the panel while the list above it scrolls. */
  .composer { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 12px; border-top: 1px solid var(--line); background: var(--panel); }
  .composeBox { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); padding: 8px; }
  .composeBox:focus-within { border-color: var(--accent); }
  .composeBox textarea { border: 0; border-radius: 0; background: none; padding: 0; min-height: 40px; resize: none; }
  .composeBox .row { margin-top: 6px; flex-wrap: nowrap; }
  #addState { min-width: 0; }

  /* A touch keyboard zooms the page for type under 16px. */
  @media (pointer: coarse) { textarea, input[type="text"] { font-size: 16px; } #volume { display: none; } .track .marker { width: 12px; height: 12px; margin-left: -6px; } }

  /* ---- Narrow: bar, player, transport, then comments, in one scrolling page with the composer held at the bottom. ---- */
  @media (max-width: 900px) {
    body { height: auto; min-height: 100vh; min-height: 100dvh; display: block; overflow: visible; }
    .bar { flex-wrap: wrap; gap: 6px 8px; padding: 8px; }
    .barLeft { flex: 1 1 100%; flex-wrap: wrap; gap: 6px 8px; }
    .bar h1 { max-width: 100%; }
    #task { flex: 1 1 120px; }
    .barRight { flex: 1 1 100%; }
    .barRight .label, #help { display: none; }
    main { display: block; }
    .stage { min-height: 96px; }
    .stage video { height: auto; max-height: 62vh; max-height: 62dvh; }
    #player:fullscreen .stage video { height: 100%; max-height: none; }
    img.media { max-height: 70vh; }
    body.wide .stage { height: 80vh; }
    body.text .stage { overflow: visible; padding: 12px 8px; }
    #videoControls { padding: 2px 4px 6px; }
    .transport { gap: 0; }
    .transport .sep, .transport .spacer { display: none; }
    #full { margin-left: auto; }
    .time { margin: 0 2px; }
    #speedBtn { min-width: 34px; }
    aside { width: auto; border-left: 0; border-top: 1px solid var(--line); }
    #notes { overflow: visible; }
    .composer { position: sticky; bottom: 0; z-index: 5; padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  }
</style>
<header class="bar">
  <div class="barLeft">
    <h1 id="title">__TITLE__</h1>
    <button id="versionBtn" class="chip" aria-haspopup="true" aria-expanded="false" hidden><span id="versionName"></span><span data-icon="chevron"></span></button>
    <span id="status" class="badge"></span>
    <span id="superseded" class="badge changes_requested" hidden>Superseded</span>
    <button id="othersBtn" class="chip" aria-haspopup="true" aria-expanded="false" title="Other reviews on this task" hidden><span id="othersLabel"></span><span data-icon="chevron"></span></button>
    <span id="task" class="muted"></span>
  </div>
  <div class="barRight">
    <a id="openFull" class="muted" href="/r/__TOKEN__/file" target="_blank" rel="noopener" hidden>Open on its own ↗</a>
    <button id="toggle" hidden>Hide comments</button>
    <a id="download" class="btn" href="/r/__TOKEN__/file" download title="Download the file" data-icon="download"><span class="label">Download</span></a>
    <button id="copy" title="Copy this version's link" data-icon="link"><span class="label">Copy link</span></button>
    <button id="help" class="ib" aria-haspopup="true" aria-expanded="false" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" hidden><strong>?</strong></button>
    <span class="spacer"></span>
    <button class="warn" id="changes" aria-haspopup="dialog" aria-expanded="false">Request changes</button>
    <button class="ok" id="approve" aria-haspopup="dialog" aria-expanded="false">Approve</button>
  </div>
</header>
<div class="pop menu" id="versionMenu" hidden><div class="popHead" id="versionCount"></div><div id="versionList"></div></div>
<div class="pop menu" id="othersMenu" hidden><div class="popHead">Also on this task</div><div id="othersList"></div></div>
<div class="pop" id="keys" hidden>
  <dl>
    <dt><kbd>Space</kbd> <kbd>K</kbd></dt><dd>Play or pause</dd>
    <dt><kbd>J</kbd> <kbd>L</kbd></dt><dd>Back or forward 5 seconds</dd>
    <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>One frame (also <kbd>,</kbd> <kbd>.</kbd>)</dd>
    <dt><kbd>Shift</kbd> <kbd>←</kbd> <kbd>→</kbd></dt><dd>One second</dd>
    <dt><kbd>C</kbd></dt><dd>Comment on this frame</dd>
    <dt><kbd>M</kbd></dt><dd>Mute</dd>
    <dt><kbd>F</kbd></dt><dd>Full screen</dd>
    <dt><kbd>Enter</kbd></dt><dd>Send the comment (<kbd>Shift</kbd> <kbd>Enter</kbd> for a new line)</dd>
  </dl>
</div>
<!-- The decision is confirmed here, with its optional message, instead of in a browser dialog. -->
<div class="pop" id="decision" role="dialog" aria-labelledby="decisionTitle" hidden>
  <strong id="decisionTitle"></strong>
  <p id="confirmText" hidden></p>
  <a id="confirmOpen" href="#" hidden></a>
  <p class="muted" id="decisionHint" hidden>Approving completes this task.</p>
  <input type="text" id="decisionName" maxlength="60" placeholder="Your name (shown on your decision)" aria-label="Your name" hidden>
  <textarea id="message" placeholder="Optional message to the agent" aria-label="Optional message to the agent"></textarea>
  <p id="decisionState" role="alert"></p>
  <div class="row"><button id="confirmNo">Cancel</button><button id="confirmYes"></button></div>
</div>
<main>
  <section id="player">
    <div id="newer" hidden><span id="newerText"></span><a id="newerOpen" href="#"></a></div>
    <div class="stage" id="stage"></div>
    <div id="videoControls" hidden>
      <div class="track" id="track" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0"><div class="rail"><div class="played" id="played"></div></div><div class="head" id="head"></div><div class="tip" id="tip"></div></div>
      <div class="transport">
        <button class="ib" id="back5" title="Back 5 seconds (J)" aria-label="Back 5 seconds" data-icon="rewind"></button>
        <button class="ib" id="back" title="Previous frame (←)" aria-label="Previous frame" data-icon="prev"></button>
        <button class="ib" id="play" title="Play / pause (Space or K)" aria-label="Play" data-icon="play"></button>
        <button class="ib" id="fwd" title="Next frame (→)" aria-label="Next frame" data-icon="next"></button>
        <button class="ib" id="fwd5" title="Forward 5 seconds (L)" aria-label="Forward 5 seconds" data-icon="forward"></button>
        <span class="sep"></span>
        <button class="ib" id="loop" title="Loop" aria-label="Loop" aria-pressed="false" data-icon="loop"></button>
        <button class="ib" id="speedBtn" title="Speed" aria-haspopup="true" aria-expanded="false">1×</button>
        <div class="pop menu" id="speedMenu" role="menu" aria-label="Speed" hidden><button class="item" role="menuitemradio" data-rate="0.5">0.5×</button><button class="item" role="menuitemradio" data-rate="1">1×</button><button class="item" role="menuitemradio" data-rate="1.5">1.5×</button><button class="item" role="menuitemradio" data-rate="2">2×</button></div>
        <button class="ib" id="mute" title="Mute (M)" aria-label="Mute" aria-pressed="false" data-icon="volume"></button>
        <input type="range" id="volume" min="0" max="1" step="0.05" value="1" aria-label="Volume">
        <span class="time" id="clock">0:00.0 / 0:00.0</span>
        <span class="spacer"></span>
        <button class="ib" id="full" title="Full screen (F)" aria-label="Full screen" data-icon="expand"></button>
      </div>
    </div>
  </section>
  <aside>
    <div class="panelHead"><strong id="count">Comments</strong><span class="muted">as <a href="#" id="who" title="Change the name on your comments"></a></span></div>
    <div id="notes"><p class="muted empty">No comments yet.</p></div>
    <div class="composer">
      <input type="text" id="nameInput" maxlength="60" placeholder="Your name (shown on your comments)" aria-label="Your name" hidden>
      <div id="pending" hidden><div class="quote" id="pendingQuote"></div><button id="clearQuote" title="Make it a general comment">×</button></div>
      <div class="composeBox">
        <textarea id="body" rows="2" placeholder="Leave a comment (Enter sends)" aria-label="Comment"></textarea>
        <div class="row"><span class="tc" id="stamp" title="The comment is pinned to this frame" hidden>0:00.0</span><span class="muted" id="addState"></span><span class="spacer"></span><button class="primary small" id="add" data-icon="send">Send</button></div>
      </div>
    </div>
  </aside>
</main>
<div id="toast" role="status" hidden></div>
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

// Icons are drawn here, so the page asks for nothing but the review itself.
const svg = (d, filled) => '<svg viewBox="0 0 16 16" aria-hidden="true" ' +
  (filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"') + '>' + d + "</svg>";
const speaker = '<path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" stroke="none"/>';
const ICON = {
  play: svg('<path d="M4 2.5v11l9.5-5.5z"/>', true),
  pause: svg('<path d="M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z"/>', true),
  prev: svg('<path d="M3 3h2v10H3zM13 3v10L6.5 8z"/>', true),
  next: svg('<path d="M11 3h2v10h-2zM3 3v10l6.5-5z"/>', true),
  rewind: svg('<path d="M8 3.5v9L1.5 8zM14.5 3.5v9L8 8z"/>', true),
  forward: svg('<path d="M8 3.5v9L14.5 8zM1.5 3.5v9L8 8z"/>', true),
  loop: svg('<path d="M3 7V6a2 2 0 0 1 2-2h7M10 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H4M6 14l-2-2 2-2"/>'),
  volume: svg(speaker + '<path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.4 3.6a6.2 6.2 0 0 1 0 8.8"/>'),
  muted: svg(speaker + '<path d="M10.8 6l3.7 4M14.5 6l-3.7 4"/>'),
  expand: svg('<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>'),
  shrink: svg('<path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/>'),
  download: svg('<path d="M8 2v8.5M4.5 7.5L8 11l3.5-3.5M3 13.5h10"/>'),
  link: svg('<path d="M6.5 9.5l3-3M7.2 4.6l.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9M8.8 11.4l-.9.9a2.6 2.6 0 0 1-3.7-3.7l.9-.9"/>'),
  chevron: svg('<path d="M4.5 6.5L8 10l3.5-3.5"/>'),
  send: svg('<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>'),
};
const setIcon = (el, icon) => { el.innerHTML = ICON[icon]; };
document.querySelectorAll("[data-icon]").forEach((el) => el.insertAdjacentHTML("afterbegin", ICON[el.dataset.icon]));

// ---------- Popovers ----------

// One at a time. Each is placed against the button that opened it and kept inside the window; a click
// anywhere else, or Escape, closes it.
let popped = null;
function closePop() {
  if (!popped) return;
  popped.pop.hidden = true; popped.anchor.setAttribute("aria-expanded", "false"); popped = null;
}
function placePop() {
  if (!popped) return;
  const a = popped.anchor.getBoundingClientRect(), p = popped.pop, w = p.offsetWidth, h = p.offsetHeight;
  const left = a.left + a.width / 2 > innerWidth / 2 ? a.right - w : a.left;
  const top = popped.above ? a.top - h - 6 : a.bottom + 6;
  p.style.left = Math.max(8, Math.min(innerWidth - w - 8, left)) + "px";
  p.style.top = Math.max(8, Math.min(innerHeight - h - 8, top)) + "px";
}
function showPop(pop, anchor, above) {
  closePop();
  pop.hidden = false; anchor.setAttribute("aria-expanded", "true");
  popped = { pop, anchor, above: Boolean(above) };
  placePop();
}
const isOpen = (pop) => Boolean(popped && popped.pop === pop);
const togglePop = (pop, anchor, above) => (isOpen(pop) ? closePop() : showPop(pop, anchor, above));
document.addEventListener("pointerdown", (e) => { if (popped && !popped.pop.contains(e.target) && !popped.anchor.contains(e.target)) closePop(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && popped) { const a = popped.anchor; closePop(); a.focus(); } });
addEventListener("resize", placePop);
$("versionBtn").onclick = () => togglePop($("versionMenu"), $("versionBtn"));
$("othersBtn").onclick = () => togglePop($("othersMenu"), $("othersBtn"));
$("help").onclick = () => togglePop($("keys"), $("help"));

let toastTimer = 0;
function toast(text) {
  $("toast").textContent = text; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 6000);
}

// ---------- Who is reviewing ----------

// Asked for in the page the first time someone comments or decides, then remembered on this device.
let me = store.get("cc-review-name") || "";
function showName() { $("who").textContent = me || "set your name"; }
// The name to sign with: what's remembered, or what's typed in the field. Without either the field is shown and takes the focus.
function nameFrom(input) {
  const typed = input.hidden ? "" : input.value.trim().slice(0, 60);
  if (typed) { me = typed; store.set("cc-review-name", me); showName(); }
  if (me) { input.hidden = true; return me; }
  input.hidden = false; input.focus();
  return "";
}
$("who").onclick = (e) => { e.preventDefault(); const i = $("nameInput"); i.hidden = false; i.value = me; i.focus(); i.select(); };
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (nameFrom($("nameInput"))) $("body").focus(); } });

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
// Brings a comment into view inside the list without moving the page (on a phone the list is part of the page, and stays put).
function reveal(el) {
  const list = $("notes");
  if (list.scrollHeight <= list.clientHeight) return;
  const top = el.offsetTop, bottom = top + el.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}
function focusNote(id, scrollDoc) {
  document.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
  const marks = doc ? doc.querySelectorAll('mark[data-note="' + id + '"]') : [];
  marks.forEach((m) => m.classList.add("on"));
  document.querySelectorAll('.marker[data-id="' + id + '"]').forEach((m) => m.classList.add("on"));
  const el = document.querySelector('.note[data-id="' + id + '"]');
  if (el) { el.classList.add("on"); if (video) reveal(el); else if (!scrollDoc) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
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
// Fixed to the window, since the document scrolls inside its pane; it follows the selection when that scrolls.
function placeQuoteButton() {
  const s = selectionInDoc(), btn = $("quoteBtn");
  if (!s) { btn.hidden = true; return; }
  const r = s.range.getBoundingClientRect();
  btn.hidden = false;
  btn.style.top = Math.max(8, r.top - btn.offsetHeight - 8) + "px";
  btn.style.left = Math.max(8, Math.min(innerWidth - btn.offsetWidth - 8, r.left + r.width / 2 - btn.offsetWidth / 2)) + "px";
}
function setPending(p) {
  pending = p;
  $("pending").hidden = !p;
  $("pendingQuote").textContent = p ? "“" + p.quote + "”" : "";
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
  $("body").placeholder = "Select text in the draft to comment on it, or write a general comment. (Enter sends)";
  document.addEventListener("mouseup", () => setTimeout(placeQuoteButton));
  document.addEventListener("keyup", (e) => { if (e.shiftKey) placeQuoteButton(); });
  document.addEventListener("scroll", () => { if (!$("quoteBtn").hidden) placeQuoteButton(); }, true);
  doc.addEventListener("click", (e) => { const m = e.target.closest("mark[data-note]"); if (m) focusNote(m.dataset.note, false); });
  highlight(); render();
}

// ---------- Comments ----------

const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function render() {
  const list = mode === "text" ? [...notes].sort((a, b) => (a.at ?? -1) - (b.at ?? -1)) : notes;
  $("count").textContent = "Comments (" + notes.length + ")";
  $("notes").innerHTML = list.length ? "" : '<p class="muted empty">No comments yet.</p>';
  for (const n of list) {
    const el = document.createElement("div"), timed = Boolean(video) && n.timecode !== null;
    el.className = "note" + (timed ? " seek" : ""); el.dataset.id = n.id;
    const missing = doc && n.at === null;
    el.innerHTML = '<div><div class="noteHead"><span class="author">' + esc(n.author_name || n.author) + '</span>' +
      (n.timecode !== null ? '<button class="tc" title="Go to this frame">' + fmt(n.timecode) + '</button>' : "") +
      (n.created_at ? '<span class="when">' + day(n.created_at) + '</span>' : "") + '</div>' +
      (n.quote ? '<div class="quote' + (missing ? ' missing" title="Not found in this version' : "") + '">“' + esc(n.quote) + '”</div>' : "") +
      '<div class="noteBody">' + esc(n.body) + '</div></div>' +
      (n.still_url ? '<img src="' + n.still_url + '" alt="" title="The frame this comment is on">' : "");
    // Anywhere on a timed comment goes to its frame, as its timecode and its still do.
    if (timed) el.addEventListener("click", () => { video.pause(); video.currentTime = n.timecode; focusNote(n.id, false); });
    if (!missing) el.querySelector(".quote")?.addEventListener("click", () => focusNote(n.id, true));
    $("notes").appendChild(el);
  }
  $("track").querySelectorAll(".marker").forEach((m) => m.remove());
  if (video && video.duration) {
    for (const n of notes) if (n.timecode !== null) {
      const m = document.createElement("div");
      m.className = "marker"; m.style.left = (100 * n.timecode / video.duration) + "%"; m.title = fmt(n.timecode) + " · " + n.body;
      m.dataset.t = n.timecode; m.dataset.id = n.id; // a tap on it seeks there; see the track's pointer handlers
      $("track").appendChild(m);
    }
  }
  $("toggle").textContent = document.body.classList.contains("collapsed") ? "Show comments" + (notes.length ? " (" + notes.length + ")" : "") : "Hide comments";
  markNow(true);
}

// The comment the video has most recently reached is lit, in the list and on the timeline, as it plays.
let nowId = null;
function markNow(again) {
  if (!video) return;
  let best = null;
  for (const n of notes) if (n.timecode !== null && n.timecode <= video.currentTime + 0.05 && (!best || n.timecode >= best.timecode)) best = n;
  const id = best ? String(best.id) : null;
  if (id === nowId && !again) return;
  nowId = id;
  document.querySelectorAll(".now").forEach((el) => el.classList.remove("now"));
  if (id === null) return;
  document.querySelectorAll('.note[data-id="' + id + '"], .marker[data-id="' + id + '"]').forEach((el) => el.classList.add("now"));
  const el = document.querySelector('.note[data-id="' + id + '"]');
  if (el && !again) reveal(el);
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
  const body = $("body").value.trim();
  if (!body) return;
  const who = nameFrom($("nameInput"));
  $("addState").className = "muted";
  if (!who) { $("addState").textContent = "Add your name to send."; return; }
  $("add").disabled = true; $("addState").textContent = "Saving…";
  const payload = { name: who, body };
  if (video) { payload.timecode = video.currentTime; payload.still = still(); }
  if (pending) { payload.quote = pending.quote; payload.quote_start = pending.start; }
  const res = await fetch(base + "/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  $("add").disabled = false;
  if (!res.ok) { $("addState").className = "muted err"; $("addState").textContent = "Couldn't save: " + (await res.text()); return; }
  if (!res.url.endsWith(base + "/notes")) return; // another version was opened meanwhile; it's saved on its own
  const saved = await res.json();
  notes.push(saved); notes.sort((a, b) => (a.timecode ?? -1) - (b.timecode ?? -1));
  $("body").value = ""; $("addState").textContent = "";
  setPending(null); render();
  const el = document.querySelector('.note[data-id="' + saved.id + '"]');
  if (el) reveal(el);
}
$("add").onclick = add;
$("body").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); add(); } });

// ---------- Decision ----------

// Either button opens the same small panel: what is about to be sent, an optional message, and the button
// that sends it. Approving a superseded version says so there, where a browser dialog used to ask.
let deciding = null;
function renderDecision() {
  if (!deciding || !review) return;
  const approve = deciding === "approve", stale = approve && !review.current, current = chain.find((v) => v.current);
  const what = chain.length > 1 ? "version " + review.version : "this review";
  $("decisionTitle").textContent = approve ? "Approve " + what + "?" : "Request changes on " + what + "?";
  $("confirmText").hidden = !stale;
  $("confirmText").textContent = "Version " + review.version + " is superseded" + (current ? ": version " + current.version + " is the current one" : "") + "." +
    (review.completes_task ? " Approving it completes the task." : "") + " Approve it anyway?";
  $("decisionHint").hidden = !approve || stale || !review.completes_task;
  $("decisionName").hidden = Boolean(me);
  $("confirmYes").textContent = stale ? "Approve version " + review.version + " anyway" : approve ? "Approve" : "Request changes";
  $("confirmYes").className = approve ? "ok" : "warn";
  $("confirmOpen").hidden = !stale || !current;
  if (stale && current) { $("confirmOpen").textContent = "Open version " + current.version; $("confirmOpen").href = current.path; $("confirmOpen").onclick = (e) => { closePop(); openVersion(e, current); }; }
  placePop();
}
function openDecision(kind) {
  if (!review) return;
  const anchor = $(kind === "approve" ? "approve" : "changes");
  if (isOpen($("decision")) && deciding === kind) { closePop(); return; }
  deciding = kind; $("decisionState").textContent = "";
  showPop($("decision"), anchor);
  renderDecision();
  // The message takes the focus, not the button that sends: Enter or Space straight after the click doesn't decide.
  (me ? $("message") : $("decisionName")).focus();
}
$("approve").onclick = () => openDecision("approve");
$("changes").onclick = () => openDecision("changes");
$("confirmNo").onclick = () => { const a = popped && popped.anchor; closePop(); if (a) a.focus(); };
$("confirmYes").onclick = () => decide(deciding, deciding === "approve" && review && !review.current);

async function decide(decision, confirmed) {
  const who = nameFrom($("decisionName"));
  if (!who) { $("decisionState").textContent = "Add your name first."; placePop(); return; }
  const buttons = [$("approve"), $("changes"), $("confirmYes")];
  for (const b of buttons) b.disabled = true;
  const res = await fetch(base + "/decision", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: who, decision, message: $("message").value, confirm_superseded: Boolean(confirmed) }) });
  for (const b of buttons) b.disabled = false;
  // This version stopped being the current one while the page was open: say so, and ask.
  if (res.status === 409) { await load(); if (!isOpen($("decision"))) showPop($("decision"), $("approve")); renderDecision(); $("confirmNo").focus(); return; }
  if (!res.ok) { $("decisionState").textContent = "Couldn't send: " + (await res.text()); placePop(); return; }
  $("message").value = ""; closePop();
  const reply = await res.json();
  toast(decision !== "approve" ? "Sent. The agent is working on the next version."
    : reply.completed_task ? "Approved. The task is done." : "Approved. The agent will wrap up.");
  load();
}

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
  notes = []; review = null; nowId = null;
  video.pause(); video.src = base + "/file";
  $("download").href = base + "/file";
  closePop(); $("message").value = ""; $("decisionState").textContent = ""; $("addState").textContent = "";
  render(); load();
}
addEventListener("popstate", () => {
  const next = location.pathname.split("/").filter(Boolean).pop();
  if (next === token) return;
  if (video && chain.some((v) => v.token === next)) show(next); else location.reload();
});

// The versions are a menu in the bar, newest first: what changed in each, when, and what was decided on it.
function renderVersions() {
  const many = chain.length > 1, current = chain.find((v) => v.current);
  $("superseded").hidden = review.current;
  $("superseded").title = current ? "Version " + current.version + " is the current one" : "";
  $("versionBtn").hidden = !many;
  $("newer").hidden = !many || review.current || !current;
  if (!many) { if (isOpen($("versionMenu"))) closePop(); return; }

  $("versionName").textContent = "v" + review.version;
  $("versionBtn").title = "Version " + review.version + " of " + chain.length + (review.note ? ": " + review.note : "");
  $("versionCount").textContent = chain.length + " versions";
  if (!review.current && current) {
    $("newerText").textContent = "This version is superseded. Version " + current.version + (current.latest ? ", the newest," : "") + " is the current one.";
    $("newerOpen").textContent = "Open version " + current.version; $("newerOpen").href = current.path; $("newerOpen").onclick = (e) => openVersion(e, current);
  }
  const list = $("versionList");
  list.textContent = "";
  for (const v of chain) {
    const el = document.createElement("a"), [mc, ml] = markOf(v);
    el.href = v.path;
    el.className = "ver" + (v.token === token ? " sel" : "");
    if (v.token === token) el.setAttribute("aria-current", "true");
    el.innerHTML = '<span class="vn">v' + Number(v.version) + '<span class="mark ' + mc + '">' + ml + '</span><span class="vdate">' + day(v.created_at) + '</span></span>' +
      '<span class="vnote"></span><span class="vstate"></span>';
    const q = (c) => el.querySelector(c), line = v.note || v.title;
    q(".vnote").textContent = line; q(".vnote").title = line;
    q(".vstate").textContent = STATE[v.status] + (v.status !== "open" && v.decided_by ? " · " + v.decided_by : "");
    q(".vstate").className = "vstate " + v.status;
    el.onclick = (e) => { openVersion(e, v); closePop(); };
    list.appendChild(el);
  }
  placePop();
}

$("copy").onclick = async () => {
  const link = location.origin + location.pathname;
  try { await navigator.clipboard.writeText(link); toast("Link copied."); }
  catch { toast("Couldn't copy the link."); }
};

function setupMedia(type, filename) {
  const src = base + "/file";
  mode = kindOf(type, filename);
  if (mode === "video") {
    document.body.classList.add("video");
    video = document.createElement("video");
    video.src = src; video.playsInline = true; video.preload = "auto";
    $("stage").appendChild(video); $("videoControls").hidden = false; $("help").hidden = false; $("stamp").hidden = false;
    $("body").placeholder = "Leave a comment at this frame (Enter sends)";
    const track = $("track");
    // While a finger or mouse drags the timeline, the time shown is where it is, not where the video has got to.
    let scrub = null, hoverT = null, wasPaused = null;
    const tick = () => {
      const t = scrub ? scrub.t : video.currentTime, d = video.duration || 0, pct = (100 * t / (d || 1)) + "%";
      $("clock").textContent = fmt(t) + " / " + fmt(d);
      $("stamp").textContent = fmt(t);
      $("head").style.left = pct; $("played").style.width = pct;
      // The tip is over the finger while dragging, else over the mouse. Shifted by its own share so it stays on screen at either end.
      const tipT = scrub ? scrub.t : hoverT;
      if (tipT !== null) {
        const at = (100 * tipT / (d || 1)) + "%";
        $("tip").style.left = at; $("tip").style.transform = "translateX(-" + at + ")"; $("tip").textContent = fmt(tipT);
      }
      track.setAttribute("aria-valuemax", d.toFixed(1)); track.setAttribute("aria-valuenow", t.toFixed(1)); track.setAttribute("aria-valuetext", fmt(t));
      if (video.paused !== wasPaused) {
        wasPaused = video.paused;
        setIcon($("play"), wasPaused ? "play" : "pause"); $("play").setAttribute("aria-label", wasPaused ? "Play" : "Pause");
      }
      markNow();
    };
    video.addEventListener("timeupdate", tick); video.addEventListener("seeked", tick);
    video.addEventListener("play", tick); video.addEventListener("pause", tick);
    video.addEventListener("loadedmetadata", () => { tick(); render(); });
    const toggle = () => { if (!video.paused) return video.pause(); const p = video.play(); if (p) p.catch(() => {}); };
    $("play").onclick = toggle;
    video.addEventListener("click", toggle);
    const step = (d) => { video.pause(); video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + d / FPS)); };
    $("back").onclick = () => step(-1); $("fwd").onclick = () => step(1);
    // Unlike a frame step, a jump leaves a playing video playing.
    const jump = (s) => { video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + s)); };
    $("back5").onclick = () => jump(-5); $("fwd5").onclick = () => jump(5);
    // Looping, like speed and volume, belongs to the player, so it carries over when another version is swapped in.
    $("loop").onclick = () => { video.loop = !video.loop; $("loop").setAttribute("aria-pressed", String(video.loop)); };
    // The default rate too: swapping to another version loads a new file, which goes back to the default.
    const speed = (rate) => {
      video.defaultPlaybackRate = video.playbackRate = rate;
      $("speedBtn").textContent = rate + "×";
      for (const b of $("speedMenu").children) b.setAttribute("aria-checked", String(Number(b.dataset.rate) === rate));
    };
    for (const b of $("speedMenu").children) b.onclick = () => { speed(Number(b.dataset.rate)); closePop(); };
    $("speedBtn").onclick = () => togglePop($("speedMenu"), $("speedBtn"), true);
    speed(1);
    const silent = () => video.muted || video.volume === 0;
    const sound = () => {
      const off = silent();
      setIcon($("mute"), off ? "muted" : "volume"); $("mute").setAttribute("aria-pressed", String(off));
      $("mute").title = off ? "Unmute (M)" : "Mute (M)"; $("mute").setAttribute("aria-label", off ? "Unmute" : "Mute");
      $("volume").value = off ? 0 : video.volume;
    };
    const mute = () => { if (silent()) { video.muted = false; if (!video.volume) video.volume = 1; } else video.muted = true; };
    $("mute").onclick = mute;
    $("volume").oninput = () => { const v = Number($("volume").value); video.muted = v === 0; if (v) video.volume = v; };
    video.addEventListener("volumechange", sound); sound();
    // An iPhone only puts the video itself full screen, with its own controls.
    const player = $("player"), enter = player.requestFullscreen || player.webkitRequestFullscreen;
    const isFull = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    const full = () => {
      if (isFull()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (enter) { const p = enter.call(player); if (p && p.catch) p.catch(() => {}); } // refused: nothing to do
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    };
    $("full").hidden = !enter && !video.webkitEnterFullscreen;
    $("full").onclick = full;
    const fullLabel = () => {
      closePop();
      setIcon($("full"), isFull() ? "shrink" : "expand");
      $("full").title = (isFull() ? "Exit full screen" : "Full screen") + " (F)"; $("full").setAttribute("aria-label", isFull() ? "Exit full screen" : "Full screen");
    };
    document.addEventListener("fullscreenchange", fullLabel); document.addEventListener("webkitfullscreenchange", fullLabel);
    // Scrubbing. Pointer events cover mouse, touch and pen alike, and capture keeps the drag going when the
    // finger leaves the band. A phone decodes slowly, so seeks don't queue: while one is in flight only
    // the latest position is kept, and it's sought when that one lands.
    let pendingSeek = null;
    const seekTo = (t) => { if (video.seeking) pendingSeek = t; else { pendingSeek = null; video.currentTime = t; } };
    video.addEventListener("seeked", () => { if (pendingSeek !== null) { const t = pendingSeek; pendingSeek = null; video.currentTime = t; } });
    const timeAt = (x) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * video.duration; };
    const endScrub = (e, cancelled) => {
      if (!scrub || e.pointerId !== scrub.id) return;
      const s = scrub; scrub = null; track.classList.remove("scrubbing");
      // A tap on a note's marker goes to the note's exact frame and stays there, and shows which note it is.
      const onMarker = !cancelled && s.marker && !s.moved;
      pendingSeek = null; video.currentTime = onMarker ? Number(s.marker.dataset.t) : s.t;
      if (s.wasPlaying && !onMarker) video.play();
      if (onMarker) focusNote(s.marker.dataset.id, false);
      tick();
    };
    track.addEventListener("pointerdown", (e) => {
      if (!video.duration || e.button > 0 || scrub) return;
      e.preventDefault();
      track.setPointerCapture(e.pointerId);
      scrub = { id: e.pointerId, x: e.clientX, moved: false, t: timeAt(e.clientX), wasPlaying: !video.paused, marker: e.target.closest(".marker") };
      video.pause(); track.classList.add("scrubbing"); seekTo(scrub.t); tick();
    });
    track.addEventListener("pointermove", (e) => {
      if (!scrub) {
        // A mouse over the timeline is shown the time it points at.
        if (e.pointerType === "mouse" && video.duration) { hoverT = timeAt(e.clientX); track.classList.add("hover"); tick(); }
        return;
      }
      if (e.pointerId !== scrub.id) return;
      if (Math.abs(e.clientX - scrub.x) > 4) scrub.moved = true;
      if (!scrub.moved) return;
      scrub.t = timeAt(e.clientX); seekTo(scrub.t); tick();
    });
    track.addEventListener("pointerleave", () => { hoverT = null; track.classList.remove("hover"); });
    track.addEventListener("pointerup", (e) => endScrub(e, false));
    track.addEventListener("pointercancel", (e) => endScrub(e, true));
    track.addEventListener("lostpointercapture", (e) => endScrub(e, true));
    // Keys work anywhere but in a field or an open menu. Space is the player's even on a focused button.
    const typing = (e) => /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable || Boolean(e.target.closest && e.target.closest(".pop"));
    const compose = () => {
      if (isFull()) full(); // the comments aren't part of the full-screen player
      document.body.classList.remove("collapsed");
      $("body").focus();
    };
    document.addEventListener("keydown", (e) => {
      if (typing(e)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === " ") { e.preventDefault(); toggle(); }
      if (key === ",") step(-1);
      if (key === ".") step(1);
      if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘← is the browser's Back
      if (key === "k") toggle();
      if (key === "j") jump(-5);
      if (key === "l") jump(5);
      if (key === "ArrowLeft") { e.preventDefault(); e.shiftKey ? jump(-1) : step(-1); }
      if (key === "ArrowRight") { e.preventDefault(); e.shiftKey ? jump(1) : step(1); }
      if (key === "f") full();
      if (key === "m") mute();
      if (key === "c") { e.preventDefault(); compose(); }
      if (key === "?") togglePop($("keys"), $("help"));
    });
    // A focused button would also be pressed when Space comes back up.
    document.addEventListener("keyup", (e) => { if (e.key === " " && !typing(e)) e.preventDefault(); });
    // Writing a comment stops the video on the frame the comment is about.
    $("body").addEventListener("focus", () => video.pause());
    $("body").addEventListener("input", () => video.pause());
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
  $("title").textContent = review.title; $("title").title = review.title; document.title = review.title + " · Review";
  $("status").textContent = { open: "Waiting for review", approved: "Approved", changes_requested: "Changes requested" }[review.status];
  $("status").className = "badge " + review.status;
  $("approve").title = review.completes_task ? "Approving completes this task" : "";
  $("task").textContent = (team ? team.name + " · " : "") + "CC-" + d.task.id + " · " + d.task.title; $("task").title = $("task").textContent;
  // What else is on the task, as a menu in the bar.
  $("othersBtn").hidden = !d.others.length;
  $("othersLabel").textContent = d.others.length + " more on this task";
  $("othersList").innerHTML = d.others.map((v) => '<a href="' + link(v.token) + '">' + esc(v.title) + "</a>").join("");
  notes = d.notes;
  if (!$("stage").firstChild) setupMedia(review.content_type, review.filename);
  $("download").download = review.filename || "";
  renderVersions();
  renderDecision();
  highlight(); render();
}
// A decision made on another version's tab, or from a batch, shows in the version menu when this one is looked at again.
document.addEventListener("visibilitychange", () => { if (!document.hidden && chain.length > 1) load(); });
showName();
load();
</script>
</html>`;

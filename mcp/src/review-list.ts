// The review list: one private link per team to a table of every review on that team's tasks, to see
// what is waiting and open it. Nothing is decided here: a row opens the review's own page.
//
//   GET /reviews/<team>/<token>        the table (/reviews/<token> redirects here)
//   GET /reviews/<token>/data          the team and its rows as JSON
//
// The list names every review link a team has, so it has its own secret (review_lists.token, one per team,
// made in the database): a review link or a batch link doesn't lead here. Nothing the Worker serves from a
// review or batch address mentions the list's. The review page's "All reviews" link comes from the browser:
// this page leaves its address in localStorage, so only a browser that has opened the list is offered the way back.
//
// A cut with several versions is one row, its current version, as in a batch.

import type { SupabaseClient } from "@supabase/supabase-js";
import { database, escapeHtml, json, PAGE_HEADERS, type ReviewEnv } from "./review-shared";
import { LIST_ORDER, shapeRows, type ListedReview } from "./review-list-rows";

type Team = { id: number; key: string; name: string };

export const listPath = (team: string, token: string) => `/reviews/${team}/${token}`;

// For the owner (get_team): the team's list link.
export async function reviewListUrl(db: SupabaseClient, publicUrl: string, team: { id: number; key: string }): Promise<string | null> {
  const { data } = await db.from("review_lists").select("token").eq("team_id", team.id).maybeSingle();
  return data ? `${publicUrl}${listPath(team.key, data.token)}` : null;
}

export async function handleReviewList(request: Request, env: ReviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/reviews\/(?:([a-z0-9][a-z0-9-]*)\/)?([A-Za-z0-9_-]{20,})(\/.*)?$/);
  if (!match) return null;
  const [, teamInPath, token, rest = ""] = match;
  const db = database(env);
  const { data: list } = await db.from("review_lists").select("team:teams!inner(id,key,name)").eq("token", token).maybeSingle<{ team: Team }>();
  if (!list) return new Response("Not found", { status: 404 });
  const team = list.team;

  if (rest === "" && request.method === "GET") {
    if (team.key !== teamInPath) return Response.redirect(`${url.origin}${listPath(team.key, token)}`, 302);
    return new Response(
      // Functions, so a "$" in a team's name is only a "$".
      LIST_PAGE.replaceAll("__TEAM__", () => escapeHtml(team.name)).replaceAll("__KEY__", team.key).replaceAll("__TOKEN__", token),
      { headers: PAGE_HEADERS },
    );
  }
  if (rest === "/data" && request.method === "GET") return data(db, team);
  return new Response("Not found", { status: 404 });
}

// Everything waiting is listed; of what was decided, the latest of these many.
const DECIDED_SHOWN = 500;
const COLUMNS = "token,title,status,decided_by,decided_at,content_type,object_key,created_at,version,tasks!inner(id,title,project,team_id)";

async function data(db: SupabaseClient, team: Team) {
  const current = () => db.from("reviews").select(COLUMNS).eq("is_current", true).eq("tasks.team_id", team.id);
  const [waiting, decided] = await Promise.all([
    current().eq("status", "open").order("created_at").returns<ListedReview[]>(),
    current().neq("status", "open").order("decided_at", { ascending: false }).limit(DECIDED_SHOWN).returns<ListedReview[]>(),
  ]);
  const error = waiting.error ?? decided.error;
  if (error) return json({ error: error.message }, 500);
  return new Response(
    JSON.stringify({
      team: { key: team.key, name: team.name },
      rows: shapeRows(team.key, [...waiting.data!, ...decided.data!]),
      decided_cut_at: decided.data!.length === DECIDED_SHOWN ? DECIDED_SHOWN : null,
    }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}

// ---------- Page ----------

// String.raw, as in review.ts: the page must not contain backticks or "${". Colours are the review page's.
const LIST_PAGE = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Reviews · __TEAM__</title>
<style>
  :root { color-scheme: dark; --bg: #111113; --panel: #18181b; --raise: #232327; --hover: #2d2d33; --text: #ececef; --muted: #9c9ca6;
          --line: #2b2b31; --edge: #3b3b43; --accent: #8b8bf0; --ok: #3fbf76; --warn: #f08a4b; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; font: 13.5px/1.45 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  .muted { color: var(--muted); }
  .spacer { flex: 1; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; padding: 8px 12px; min-height: 49px;
         background: var(--panel); border-bottom: 1px solid var(--line); }
  .bar h1 { font-size: 14px; font-weight: 600; margin: 0; }
  #team { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .seg { flex: none; display: flex; padding: 2px; gap: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .seg button { padding: 4px 10px; line-height: 18px; border: 0; border-radius: 6px; background: none; color: var(--muted); white-space: nowrap; }
  .seg button:hover { color: var(--text); }
  .seg button[aria-pressed="true"] { background: var(--raise); color: var(--text); }
  .seg .n { margin-left: 4px; font-variant-numeric: tabular-nums; color: var(--muted); }

  main { padding: 12px; }
  /* A narrow screen scrolls the table sideways inside this box, never the page. */
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  table { width: 100%; min-width: 940px; border-collapse: collapse; }
  th, td { text-align: left; padding: 0 12px; height: 38px; white-space: nowrap; border-bottom: 1px solid var(--line); }
  tbody tr:last-child td { border-bottom: 0; }
  th { padding: 0; font-weight: 500; font-size: 12.5px; color: var(--muted); background: var(--panel); }
  th button { display: flex; align-items: center; gap: 4px; width: 100%; height: 37px; padding: 0 12px; border: 0; background: none; color: inherit; white-space: nowrap; }
  th button:hover, th[aria-sort="ascending"] button, th[aria-sort="descending"] button { color: var(--text); }
  th button:focus-visible { outline-offset: -2px; }
  .arrow { width: 8px; font-size: 10px; color: var(--accent); }
  tbody tr { cursor: pointer; }
  tbody tr:hover td { background: var(--raise); }
  td.title { max-width: 340px; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  td.title a { color: var(--text); text-decoration: none; }
  tr:hover td.title a, td.title a:focus-visible { color: var(--accent); }
  td.project { max-width: 170px; overflow: hidden; text-overflow: ellipsis; }
  td.num { font-variant-numeric: tabular-nums; }
  td .muted { margin-left: 6px; font-size: 12.5px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--line); white-space: nowrap; }
  .badge.approved { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.changes_requested { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  #empty { margin: 0; padding: 40px 16px; text-align: center; }
  #empty button { padding: 0; border: 0; background: none; color: var(--accent); text-decoration: underline; }
  #state { margin: 8px 2px 0; font-size: 12.5px; min-height: 18px; }
  #state.err { color: var(--warn); }
  @media (max-width: 600px) { main { padding: 8px; } th button, td { padding: 0 10px; } }
</style>
<header class="bar">
  <h1>Reviews</h1>
  <span id="team" class="muted">__TEAM__</span>
  <span class="spacer"></span>
  <div class="seg" role="group" aria-label="Which reviews to list">
    <button id="showWaiting" aria-pressed="true">Waiting<span class="n" id="nWaiting"></span></button>
    <button id="showAll" aria-pressed="false">All<span class="n" id="nAll"></span></button>
  </div>
</header>
<main>
  <div class="wrap">
    <table>
      <thead><tr id="heads"></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p id="empty" class="muted" hidden></p>
  </div>
  <p id="state" class="muted" role="status"></p>
</main>
<script>
` + LIST_ORDER + String.raw`
const base = "/reviews/__TOKEN__", team = "__KEY__";
const $ = (id) => document.getElementById(id);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const HEADS = [["project", "Project"], ["title", "Title"], ["kind", "Kind"], ["version", "Version"], ["status", "Status"],
               ["sent", "Sent for review"], ["decided", "Decided"], ["task", "Task"]];
const STATUS = { open: "Waiting", changes_requested: "Changes requested", approved: "Approved" };
const REFRESH_MS = 25000;

// The review page offers the way back to whoever has been here (it is told nothing about this address otherwise).
store.set("cc-review-list:" + team, location.pathname);

// Which rows and in what order, as last left on this device.
let view = { filter: "waiting", key: null, dir: 1 };
try {
  const saved = JSON.parse(store.get("cc-review-list-view:" + team) || "null");
  if (saved) view = { filter: saved.filter === "all" ? "all" : "waiting", key: saved.key in COLUMNS ? saved.key : null, dir: saved.dir === -1 ? -1 : 1 };
} catch {}
const keep = () => store.set("cc-review-list-view:" + team, JSON.stringify(view));

let rows = null, cut = null, failed = false;

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const DAY_YEAR = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
function day(iso) {
  const d = new Date(iso);
  return (d.getFullYear() === new Date().getFullYear() ? DAY : DAY_YEAR).format(d) + ", " + CLOCK.format(d);
}
function ago(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return min + " min ago";
  if (min < 60 * 24) return Math.round(min / 60) + " h ago";
  const days = Math.round(min / (60 * 24));
  return days + (days === 1 ? " day ago" : " days ago");
}

for (const [key, label] of HEADS) {
  const th = el("th"), button = el("button");
  th.scope = "col"; th.dataset.key = key;
  button.append(el("span", label), el("span", "", "arrow"));
  button.onclick = () => { const next = nextSort(view, key); view.key = next.key; view.dir = next.dir; keep(); render(); };
  th.appendChild(button);
  $("heads").appendChild(th);
}
function setFilter(filter) { view.filter = filter; keep(); render(); }
$("showWaiting").onclick = () => setFilter("waiting");
$("showAll").onclick = () => setFilter("all");

function rowOf(r) {
  const tr = el("tr");
  tr.dataset.href = r.path;
  tr.appendChild(el("td", r.project || "—", "project" + (r.project ? "" : " muted"))).title = r.project || "";
  const title = tr.appendChild(el("td", null, "title")), link = title.appendChild(el("a", r.title));
  link.href = r.path; title.title = r.title;
  tr.appendChild(el("td", r.kind));
  tr.appendChild(el("td", "v" + r.version, "num"));
  tr.appendChild(el("td")).appendChild(el("span", STATUS[r.status] || r.status, "badge " + r.status));
  const sent = tr.appendChild(el("td", null, "num"));
  sent.append(el("span", day(r.sent_at)), el("span", ago(r.sent_at), "muted"));
  const decided = tr.appendChild(el("td", null, "num"));
  if (r.decided_at) decided.append(el("span", day(r.decided_at)), el("span", r.decided_by ? "by " + r.decided_by : "", "muted"));
  else decided.appendChild(el("span", "—", "muted")).style.marginLeft = "0";
  tr.appendChild(el("td", "CC-" + r.task.id, "num")).title = r.task.title;
  return tr;
}

function render() {
  $("showWaiting").setAttribute("aria-pressed", String(view.filter !== "all"));
  $("showAll").setAttribute("aria-pressed", String(view.filter === "all"));
  for (const th of $("heads").children) {
    const on = view.key === th.dataset.key;
    if (on) th.setAttribute("aria-sort", view.dir === 1 ? "ascending" : "descending"); else th.removeAttribute("aria-sort");
    th.querySelector(".arrow").textContent = on ? (view.dir === 1 ? "▲" : "▼") : "";
  }
  $("state").className = failed ? "err" : "muted";
  $("state").textContent = failed ? "Couldn't " + (rows ? "refresh" : "load") + " the list. Trying again shortly."
    : cut && view.filter === "all" ? "Showing everything waiting and the " + cut + " most recent decisions." : "";
  if (!rows) return;
  const waiting = shownRows(rows, "waiting").length;
  $("nWaiting").textContent = waiting; $("nAll").textContent = rows.length + (cut ? "+" : "");
  const shown = sortRows(shownRows(rows, view.filter), view);
  // A refresh mustn't take the keyboard's place in the table.
  const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest("#rows a") : null;
  const at = focused ? focused.getAttribute("href") : null;
  $("rows").replaceChildren(...shown.map(rowOf));
  if (at) { const again = [...$("rows").querySelectorAll("a")].find((a) => a.getAttribute("href") === at); if (again) again.focus({ preventScroll: true }); }
  const empty = $("empty");
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.textContent = "";
    if (view.filter === "all" || !rows.length) empty.textContent = "Nothing has been sent for review yet.";
    else {
      const all = el("button", "Show all " + rows.length);
      all.onclick = () => setFilter("all");
      empty.append("Nothing is waiting for review. ", all);
    }
  }
}

// A row opens its review in this tab. The title is an ordinary link, so a new tab is there for the asking,
// and the same keys on the rest of the row do the same.
$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr || e.target.closest("a") || e.button || String(getSelection())) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey) open(tr.dataset.href, "_blank", "noopener"); else location.href = tr.dataset.href;
});

// Decisions are made on the review pages, so the table is read again whenever someone comes back to this tab,
// and every so often while it is on screen.
let loading = false, last = 0;
async function load() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch(base + "/data", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    rows = d.rows; cut = d.decided_cut_at; last = Date.now(); failed = false;
  } catch {
    failed = true;
  }
  loading = false;
  render();
}
const seen = () => { if (!document.hidden && Date.now() - last > 1000) load(); };
document.addEventListener("visibilitychange", seen);
addEventListener("focus", seen);
addEventListener("pageshow", (e) => { if (e.persisted) load(); });
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
render();
load();
</script>
</html>`;

// End-to-end check against a running worker: OAuth (DCR + PKCE + passphrase consent) then MCP tool calls.
// Usage: node scripts/smoke.mjs [baseUrl] [passphrase]
import { createHash, randomBytes } from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:8787";
const PASS = process.argv[3] ?? "local-dev-passphrase";
const REDIRECT = "http://localhost:9999/callback";
const b64url = (buf) => buf.toString("base64url");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Unauthenticated MCP request is challenged.
const challenge = await fetch(`${BASE}/mcp`, { method: "POST" });
assert(challenge.status === 401, `expected 401, got ${challenge.status}`);
console.log("✓ /mcp requires auth");

// 2. Dynamic client registration.
const reg = await fetch(`${BASE}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "smoke-test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
}).then((r) => r.json());
assert(reg.client_id, `registration failed: ${JSON.stringify(reg)}`);
console.log("✓ registered client");

// 3. Authorize: GET consent page, then POST with wrong and right passphrase.
const verifier = b64url(randomBytes(32));
const authUrl = new URL(`${BASE}/authorize`);
Object.entries({
  response_type: "code",
  client_id: reg.client_id,
  redirect_uri: REDIRECT,
  state: "xyz",
  code_challenge: b64url(createHash("sha256").update(verifier).digest()),
  code_challenge_method: "S256",
  resource: `${BASE}/mcp`,
}).forEach(([k, v]) => authUrl.searchParams.set(k, v));

const page = await fetch(authUrl);
const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)?.[1];
assert(handle, "no consent handle in page");

const post = (passphrase) =>
  fetch(authUrl, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, passphrase, decision: "approve" }),
  });

const wrong = await post("nope");
assert(wrong.status === 200 && (await wrong.text()).includes("Wrong passphrase"), "wrong passphrase accepted");
console.log("✓ wrong passphrase rejected");

const right = await post(PASS);
assert(right.status === 302, `expected redirect, got ${right.status}: ${await right.text()}`);
const code = new URL(right.headers.get("location")).searchParams.get("code");
assert(code, "no auth code");
console.log("✓ consent approved");

// 4. Token exchange.
const token = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: reg.client_id,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  }),
}).then((r) => r.json());
assert(token.access_token, `token exchange failed: ${JSON.stringify(token)}`);
console.log("✓ got access token");

// 5. MCP calls.
let id = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const json = JSON.parse(text.startsWith("{") ? text : text.match(/^data: (.*)$/m)[1]);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
const callRaw = (name, args) => rpc("tools/call", { name, arguments: args });
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  assert(!r.isError, `${name} failed: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
console.log("✓ tools:", tools.join(", "));

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const later = new Date(Date.now() + 9 * 86400e3).toISOString().slice(0, 10);

const t = await call("add_task", {
  title: "Draft LinkedIn post about launch", description: "Tone: casual", kind: "agent", priority: 2,
  project: "Content", labels: ["linkedin"], ready: true, source: "smoke",
});
assert(t.key === `CC-${t.id}` && t.status === "ready" && t.labels[0] === "linkedin", "add_task shape");
console.log(`✓ add_task → ${t.key} (ready, P2, Content, [linkedin])`);

const future = await call("add_task", { title: "Post it", kind: "agent", ready: true, scheduled_on: later, source: "smoke" });
const queue = await call("list_tasks", { view: "agent_ready" });
assert(queue.some((x) => x.id === t.id) && !queue.some((x) => x.id === future.id), "scheduled agent task should wait");
console.log("✓ agent_ready excludes future-scheduled work");
assert((await call("list_tasks", { view: "upcoming", to: later })).some((x) => x.id === future.id), "upcoming");
console.log("✓ upcoming calendar view");
const filtered = await call("list_tasks", { view: "open", label: "linkedin", project: "content" });
assert(filtered.some((x) => x.id === t.id) && filtered.every((x) => x.labels.includes("linkedin") && /^content$/i.test(x.project)), "filters");
console.log("✓ label + project filters");
const found = await call("list_tasks", { view: "open", query: "linkedin LAUNCH" });
assert(found.some((x) => x.id === t.id) && !found.some((x) => x.id === future.id), "query search");
assert((await call("list_tasks", { view: "today", query: "zzz-no-match" })).length === 0, "query + today view");
console.log("✓ text search (all words, case-insensitive), combined with views");

// Teams: projects carry their team to tasks, and agents can read team specs.
// Only against a local server: there's no tool to delete the test team afterwards.
if (BASE.includes("localhost")) {
await call("save_team", { key: "smoke-co", name: "Smoke Co", context: "# Smoke Co\n- be brief", repos: [{ name: "smoke", path: "~/Developer/smoke" }] });
await call("save_project", { name: "Smoke Project", team: "smoke-co", description: "Spec" });
const teamed = await call("add_task", { title: "Teamed task", project: "smoke project", source: "smoke" });
assert(teamed.team_id, "task inherits its project's team");
const teamList = await call("list_tasks", { view: "open", team: "Smoke Co" });
assert(teamList.length === 1 && teamList[0].team.key === "smoke-co", "team filter");
const teamSpec = await call("get_team", { team: "smoke-co" });
assert(teamSpec.repos[0].name === "smoke" && teamSpec.projects[0].name === "Smoke Project", "get_team");
assert((await call("list_teams", {})).teams.some((x) => x.key === "smoke-co" && x.projects.includes("Smoke Project")), "list_teams");
const unknown = await callRaw("add_task", { title: "x", team: "nope", source: "smoke" });
assert(unknown.isError && /Known teams/.test(unknown.content[0].text), "unknown team is rejected");
console.log("✓ teams: project → team, filter, get_team, list_teams, unknown team rejected");
} else {
  const unknown = await callRaw("list_tasks", { team: "no-such-team" });
  assert(unknown.isError && /Known teams/.test(unknown.content[0].text), "unknown team is rejected");
  console.log("✓ unknown team rejected (team write checks run locally only)");
}

await call("update_task", { id: `CC-${t.id}`, status: "in_progress", add_labels: ["draft"], add_links: [{ title: "Draft", url: "file:///tmp/d.md" }], log: "drafting", actor: "runner" });
await call("ask_human", { id: t.id, question: "Casual or formal tone?", session_id: "sess-123" });
let inbox = await call("list_inbox", {});
assert(inbox.filter((n) => n.task.id === t.id).length === 1 && inbox[0].kind === "question", "one question in inbox");
console.log("✓ ask_human → needs_you + single inbox entry");

const answered = await call("answer_task", { id: t.id, answer: "Casual" });
assert(answered.status === "ready" && answered.session_id === "sess-123", "answer didn't hand back");
inbox = await call("list_inbox", {});
assert(!inbox.some((n) => n.task.id === t.id && n.kind === "question"), "question should clear");
console.log("✓ answer_task → ready, question cleared from inbox");

await call("add_comment", { id: t.id, body: "Here's a first draft.", author: "agent" });
await call("add_comment", { id: t.id, body: "Shorter please", author: "me" });
inbox = await call("list_inbox", {});
assert(inbox.filter((n) => n.kind === "comment").length === 1, "only non-me comments notify");
console.log("✓ comments: agent comment in inbox, mine not");

const human = await call("add_human_task", { parent_id: t.id, title: "Post on LinkedIn", instructions: "Draft: ..." });
await call("complete_task", { id: t.id, summary: "drafted; handed posting to Chris" });
inbox = await call("list_inbox", {});
assert(inbox.some((n) => n.kind === "handoff" && n.task.id === human.id) && inbox.some((n) => n.kind === "done"), "handoff + done");
console.log("✓ handoff + done in inbox");
const todayList = await call("list_tasks", { view: "today" });
assert(todayList.some((x) => x.id === human.id) && !todayList.some((x) => x.id === t.id), "today view wrong");
assert(human.project === "Content" && human.priority === 2, "handoff inherits project/priority");
console.log(`✓ ${human.key} on today, inherits project + priority`);

const full = await call("get_task", { id: `CC-${t.id}` });
assert(full.status === "done" && full.subtasks.length === 1 && full.comments.length === 4 && full.links.length === 1 && full.labels.includes("draft"), "get_task");
console.log(`✓ get_task: ${full.comments.length} comments, ${full.activity.length} activity, links + labels`);

await call("mark_inbox_read", { task_id: t.id });
// replace=true would un-pin real tasks, so only exercise it locally.
await call("plan_today", { ids: [human.id], replace: BASE.includes("localhost") });
console.log("✓ mark_inbox_read, plan_today");

// Stage dependencies. Human stages, so a run against production can't start a real agent session.
const stage = (title, extra = {}) => call("add_task", { title, kind: "human", source: "smoke", ...extra });
const statusOf = async (id) => (await call("get_task", { id })).status;
const handoffFor = async (id) => (await call("list_inbox", {})).filter((n) => n.kind === "handoff" && n.task.id === id).length;
const first = await stage("Stage 1");
const second = await stage("Stage 1b");
const waiting = await stage("Stage 2", { blocked_by: [first.id, `CC-${second.id}`], ready: true, today: true });
assert(waiting.status === "ready" && waiting.waiting_on.length === 2 && waiting.blocked_by.length === 2, "ready=true is stored, and waits");
const unapproved = await stage("Stage 2 unapproved", { blocked_by: [first.id] });
assert(unapproved.status === "new", "blocked_by alone doesn't approve");
assert(!(await call("list_tasks", { view: "today" })).some((x) => x.id === waiting.id), "waiting human task stays off today");
await call("complete_task", { id: first.id });
const halfway = await call("get_task", { id: waiting.id });
assert(halfway.status === "ready" && halfway.waiting_on.join() === String(second.id), "one open blocker keeps it waiting");
assert(!(await handoffFor(waiting.id)), "no inbox entry while still waiting");
console.log("✓ dependencies: ready=true stored and waiting, off today, still waiting with one blocker open");
await call("complete_task", { id: second.id });
const released = await call("get_task", { id: waiting.id });
assert(released.status === "ready" && !released.waiting_on.length && released.blocked_by.map((b) => b.id).join() === `${first.id},${second.id}`, "free once all done");
assert((await call("get_task", { id: first.id })).blocks.map((b) => b.key).includes(waiting.key), "get_task shows what it blocks");
assert((await handoffFor(waiting.id)) === 1, "human stage lands in the inbox once");
assert((await call("list_tasks", { view: "today" })).some((x) => x.id === waiting.id), "back on today");
const stillNew = await call("get_task", { id: unapproved.id });
assert(stillNew.status === "new" && !stillNew.waiting_on.length && !(await handoffFor(unapproved.id)), "a new task is never promoted");
console.log("✓ dependencies: all blockers done → free, in inbox, back on today; new stays new; shown both ways");

const cycleA = await stage("Cycle A");
const cycleB = await stage("Cycle B", { blocked_by: [cycleA.id], ready: true });
const cycleC = await stage("Cycle C", { blocked_by: [cycleB.id] });
const cycle = await callRaw("update_task", { id: cycleA.id, blocked_by: [cycleC.id], title: "Should not change" });
assert(cycle.isError && /cycle/.test(cycle.content[0].text), "cycle rejected");
assert((await call("get_task", { id: cycleA.id })).title === "Cycle A", "a rejected cycle changes nothing");
const self = await callRaw("update_task", { id: cycleA.id, blocked_by: [cycleA.id] });
assert(self.isError && /itself/.test(self.content[0].text), "self-reference rejected");
const missing = await callRaw("add_task", { title: "Blocked by nothing", source: "smoke", blocked_by: [999999999] });
assert(missing.isError && /exist/.test(missing.content[0].text), "unknown blocker rejected");
assert(!(await call("list_tasks", { view: "new", query: "Blocked by nothing" })).length, "failed add leaves no task behind");
console.log("✓ dependencies: cycles, self-references and unknown blockers rejected");

const started = await stage("Already started", { blocked_by: [cycleA.id] });
await call("update_task", { id: started.id, status: "in_progress" }); // underway: must not be interrupted
const otherOpen = await stage("Other blocker");
await call("update_task", { id: cycleB.id, blocked_by: [cycleA.id, otherOpen.id] });
await call("update_task", { id: cycleA.id, status: "cancelled" });
const stopped = await call("get_task", { id: cycleB.id });
assert(stopped.status === "needs_you" && /cancelled/.test(stopped.question), "cancelled blocker → needs_you with a note");
assert((await call("list_inbox", {})).some((n) => n.kind === "question" && n.task.id === cycleB.id), "cancelled blocker lands in the inbox");
assert((await statusOf(started.id)) === "in_progress", "work underway is left alone");
assert((await statusOf(cycleC.id)) === "new", "only direct dependents are held");
const answeredStage = await call("answer_task", { id: cycleB.id, answer: "Go ahead without it" });
assert(answeredStage.status === "ready", "answering makes it ready");
assert((await call("get_task", { id: cycleB.id })).waiting_on.join() === String(otherOpen.id), "and it still waits for open blockers");
await call("update_task", { id: cycleB.id, blocked_by: [cycleA.id, otherOpen.id] });
assert((await statusOf(cycleB.id)) === "ready", "re-saving blockers doesn't ask again");
const lateAdd = await stage("Blocked by something already cancelled", { blocked_by: [cycleA.id], ready: true });
assert(lateAdd.status === "needs_you", "adding a cancelled blocker asks too");
console.log("✓ dependencies: cancelled blocker → needs_you, answer → ready and still waiting, work underway untouched");

await call("update_task", { id: cycleB.id, blocked_by: [cycleA.id] }); // removes the open one
const unblocked = await call("get_task", { id: cycleB.id });
assert(!unblocked.waiting_on.length && unblocked.activity.some((e) => /stopped waiting on/.test(e.body)), "removing an open blocker is logged");
assert((await handoffFor(cycleB.id)) === 1, "and flagged when nothing else holds it");
console.log("✓ dependencies: removing an open blocker stops the wait and is logged");

const heldBy = await stage("Blocks an agent task");
const heldAgent = await stage("Waiting agent task", { kind: "agent", ready: true, blocked_by: [heldBy.id] });
assert(heldAgent.status === "ready" && !(await call("list_tasks", { view: "agent_ready" })).some((x) => x.id === heldAgent.id), "waiting agent task isn't queued");
if (BASE.includes("localhost")) {
  await call("complete_task", { id: heldBy.id });
  assert((await call("list_tasks", { view: "agent_ready" })).some((x) => x.id === heldAgent.id), "queued once its blocker is done");
  const later_ = await stage("Scheduled stage", { kind: "agent", ready: true, blocked_by: [heldBy.id], scheduled_on: later });
  assert(!(await call("list_tasks", { view: "agent_ready" })).some((x) => x.id === later_.id), "scheduled_on still applies");
  console.log("✓ dependencies: agent_ready skips waiting tasks, queues them once free, still respects scheduled_on");
} else {
  // A real runner would start it if it were freed, so cancel it while it's still waiting.
  await call("update_task", { id: heldAgent.id, status: "cancelled" });
  console.log("✓ dependencies: agent_ready skips waiting tasks");
}

// Reviews that complete their task. Needs the upload token, and leaves a file in the bucket, so opt in.
const uploadToken = process.env.CC_UPLOAD_TOKEN;
if (uploadToken) {
  const publish = async (task, query) => {
    const res = await fetch(`${BASE}/api/publish?task=${task}&filename=smoke.txt&title=Smoke${query}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${uploadToken}`, "content-type": "text/plain" },
      body: "smoke test",
    });
    const body = await res.text();
    assert(res.ok, `publish failed: ${res.status} ${body}`);
    return JSON.parse(body).url.split("/").pop();
  };
  const decide = async (token, decision) => {
    const res = await fetch(`${BASE}/r/${token}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Smoke", decision }),
    });
    if (!res.ok) throw new Error(`decision failed: ${res.status} ${await res.text()}`);
  };
  const reviewed = await stage("Reviewed stage", { ready: true });
  const next = await stage("Next stage", { blocked_by: [reviewed.id], ready: true });
  const plain = await publish(reviewed.id, "");
  await decide(plain, "approve");
  assert((await statusOf(reviewed.id)) === "ready", "a plain approval doesn't finish the task");
  const completing = await publish(reviewed.id, "&completes_task=1");
  assert((await (await fetch(`${BASE}/r/${completing}/data`)).json()).review.completes_task, "review data shows completes_task");
  await decide(completing, "changes");
  assert((await statusOf(reviewed.id)) === "ready", "requesting changes doesn't finish the task");
  assert((await call("get_task", { id: next.id })).waiting_on.length === 1, "next stage waits");
  await decide(completing, "approve");
  const closed = await call("get_task", { id: reviewed.id });
  assert(closed.status === "done" && /marked done/.test(closed.comments.at(-1).body), "approval marks the task done and says so");
  const freed = await call("get_task", { id: next.id });
  assert(freed.status === "ready" && !freed.waiting_on.length, "approval frees the next stage");

  const dropped = await stage("Cancelled before approval", { ready: true });
  const late = await publish(dropped.id, "&completes_task=1");
  await call("update_task", { id: dropped.id, status: "cancelled" });
  await decide(late, "approve");
  const stays = await call("get_task", { id: dropped.id });
  assert(stays.status === "cancelled" && !/marked done/.test(stays.comments.at(-1).body), "a cancelled task stays cancelled, and the comment doesn't claim otherwise");
  console.log("✓ reviews: completes_task approval → done → next stage free; changes, plain approvals and cancelled tasks don't");
}

console.log("\nAll checks passed.");

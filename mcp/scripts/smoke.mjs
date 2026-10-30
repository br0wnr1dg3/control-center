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
console.log("✓ mark_inbox_read, plan_today\n\nAll checks passed.");

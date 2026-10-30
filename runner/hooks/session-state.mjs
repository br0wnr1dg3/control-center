#!/usr/bin/env node
// Claude Code hook for runner-started sessions: keeps the board in step with the terminal.
//
//   session-state.mjs waiting <taskId>   Stop / Notification: the session is waiting on Chris, so an
//                                        in-progress task moves to needs_you with what it said last.
//   session-state.mjs resumed <taskId>   UserPromptSubmit: someone typed into the session, so a
//                                        needs_you task goes back to in_progress.
//
// Only ever moves in_progress <-> needs_you, so finished tasks and questions filed through ask_human
// are left alone. Never blocks the session: every failure exits 0.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [mode, taskId] = process.argv.slice(2);
const SUPABASE_URL = process.env.CC_SUPABASE_URL ?? "https://lkjjphjscavzibalgqhh.supabase.co";

function serviceKey() {
  return (
    process.env.CC_SERVICE_KEY ??
    execFileSync("security", ["find-generic-password", "-a", "control-center", "-s", "control-center service key", "-w"])
      .toString()
      .trim()
  );
}

async function patch(fromStatus, fields) {
  const key = serviceKey();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${taskId}&status=eq.${fromStatus}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

// The agent's last words, so the inbox shows what it is waiting on.
function lastAssistantText(input) {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  if (!input.transcript_path) return "";
  const lines = readFileSync(input.transcript_path, "utf8").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const content = entry.message?.content;
      const text = Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : content;
      if (text?.trim()) return text;
    } catch {}
  }
  return "";
}

const excerpt = (text, max = 600) => (text.length > max ? `…${text.slice(-max)}` : text).trim();

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (!/^\d+$/.test(taskId ?? "")) process.exit(0);

  if (mode === "waiting") {
    const said = excerpt(lastAssistantText(input)) || input.message || "";
    await patch("in_progress", {
      status: "needs_you",
      question: `Waiting for your input in the session.${said ? `\n\n${said}` : ""}`,
    });
  } else if (mode === "resumed") {
    await patch("needs_you", { status: "in_progress", question: null });
  }
} catch (err) {
  console.error(`control-center hook: ${err.message}`);
}
process.exit(0);

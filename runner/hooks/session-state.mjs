#!/usr/bin/env node
// Claude Code hook for runner-started sessions: keeps the board in step with the terminal.
//
//   session-state.mjs waiting <taskId>   Stop / Notification: the session is waiting on the owner, so an
//                                        in-progress task moves to needs_you with what it said last.
//   session-state.mjs resumed <taskId>   UserPromptSubmit: someone typed into the session, so a
//                                        needs_you task goes back to in_progress.
//   session-state.mjs ask <taskId>       PreToolUse on AskUserQuestion: Claude's multiple-choice picker
//                                        only works in the terminal, so the question and its options go
//                                        to the board instead and the picker is blocked (exit 2); the
//                                        answer comes back into the session as a typed message.
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

const OWNER = process.env.CC_OWNER_NAME || "the owner";

async function patch(fromStatus, fields) {
  const key = serviceKey();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${taskId}&status=in.(${fromStatus})`, {
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

// The agent's last words, kept whole unless very long; then the end, starting at a line break.
function excerpt(text, max = 6000) {
  if (text.length <= max) return text.trim();
  const tail = text.slice(-max);
  return `…${tail.slice(tail.indexOf("\n") + 1)}`.trim();
}

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
  } else if (mode === "ask") {
    const questions = input.tool_input?.questions ?? [];
    if (!questions.length) process.exit(0);
    const said = excerpt(lastAssistantText(input));
    const asked = questions.map((q) => `**${q.question}**`).join("\n\n");
    await patch("in_progress,needs_you", {
      status: "needs_you",
      question: [said, asked].filter(Boolean).join("\n\n"),
      question_options: questions.map((q) => ({
        question: q.question,
        header: q.header ?? null,
        multiSelect: Boolean(q.multiSelect),
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? null })),
      })),
    });
    console.error(
      `Sent this question and its options to ${OWNER} on the Control Center board instead of the picker. ` +
        `Stop here and wait: the answer will be typed into this session as "${OWNER} on the board: ...".`,
    );
    process.exit(2); // blocks the picker; Claude reads the message above
  }
} catch (err) {
  console.error(`control-center hook: ${err.message}`);
}
process.exit(0);

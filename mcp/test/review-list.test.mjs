// The review list's pure parts: what a row is and how rows are ordered. No database or Worker needed:
//   node --test mcp/test/review-list.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { kindLabel, LIST_ORDER, shapeRows } from "../src/review-list-rows.ts";

// The ordering is script the page carries; this runs the same text.
const { sortRows, nextSort, shownRows, COLUMNS } = new Function(`${LIST_ORDER}; return { sortRows, nextSort, shownRows, COLUMNS };`)();

const row = (title, extra = {}) => ({
  path: `/r/acme/${title}`, title, project: "Launch", kind: "Video", version: 1, status: "open",
  sent_at: "2026-11-10T09:00:00Z", decided_at: null, decided_by: null, task: { id: 1, title: "Task" }, ...extra,
});
const titles = (rows) => rows.map((r) => r.title);

const ROWS = [
  row("approved early", { status: "approved", sent_at: "2026-11-10T08:00:00Z", decided_at: "2026-11-11T10:00:00Z", decided_by: "Sam", project: "Brand", kind: "Image", version: 3, task: { id: 7, title: "T" } }),
  row("waiting new", { sent_at: "2026-11-12T09:00:00Z", project: null, kind: "HTML", version: 2, task: { id: 12, title: "T" } }),
  row("changes late", { status: "changes_requested", decided_at: "2026-11-12T10:00:00Z", decided_by: "Ana", project: "alpha", kind: "Text", task: { id: 3, title: "T" } }),
  row("waiting old", { sent_at: "2026-11-09T09:00:00Z", project: "Zebra", kind: "PDF", version: 10, task: { id: 2, title: "T" } }),
];

test("unsorted, the list is a queue: waiting first with the longest wait on top, then the latest decisions", () => {
  assert.deepEqual(titles(sortRows(ROWS, { key: null, dir: 1 })), ["waiting old", "waiting new", "changes late", "approved early"]);
  assert.deepEqual(titles(sortRows(ROWS, null)), ["waiting old", "waiting new", "changes late", "approved early"]);
  assert.deepEqual(titles(sortRows(ROWS, { key: "nonsense", dir: 1 })), ["waiting old", "waiting new", "changes late", "approved early"]);
});

test("sorting doesn't reorder the rows it was given", () => {
  const before = titles(ROWS);
  sortRows(ROWS, { key: "title", dir: 1 });
  assert.deepEqual(titles(ROWS), before);
});

test("every column sorts both ways", () => {
  const sorted = (key, dir) => titles(sortRows(ROWS, { key, dir }));
  assert.deepEqual(Object.keys(COLUMNS), ["project", "title", "kind", "version", "status", "sent", "decided", "task"]);
  assert.deepEqual(sorted("title", 1), ["approved early", "changes late", "waiting new", "waiting old"]);
  assert.deepEqual(sorted("title", -1), ["waiting old", "waiting new", "changes late", "approved early"]);
  assert.deepEqual(sorted("kind", 1), ["waiting new", "approved early", "waiting old", "changes late"]); // HTML, Image, PDF, Text
  assert.deepEqual(sorted("version", 1), ["changes late", "waiting new", "approved early", "waiting old"]); // 1, 2, 3, 10: numbers, not text
  assert.deepEqual(sorted("version", -1), ["waiting old", "approved early", "waiting new", "changes late"]);
  assert.deepEqual(sorted("status", 1), ["waiting old", "waiting new", "changes late", "approved early"]);
  assert.deepEqual(sorted("status", -1), ["approved early", "changes late", "waiting old", "waiting new"]);
  assert.deepEqual(sorted("sent", 1), ["waiting old", "approved early", "changes late", "waiting new"]);
  assert.deepEqual(sorted("sent", -1), ["waiting new", "changes late", "approved early", "waiting old"]);
  assert.deepEqual(sorted("task", 1), ["waiting old", "changes late", "approved early", "waiting new"]); // CC-2, 3, 7, 12
  assert.deepEqual(sorted("task", -1), ["waiting new", "approved early", "changes late", "waiting old"]);
});

test("a row with nothing in the column goes last either way, in the queue's order", () => {
  const sorted = (key, dir) => titles(sortRows(ROWS, { key, dir }));
  // Project ignores case; the review with no project is last both ways.
  assert.deepEqual(sorted("project", 1), ["changes late", "approved early", "waiting old", "waiting new"]);
  assert.deepEqual(sorted("project", -1), ["waiting old", "approved early", "changes late", "waiting new"]);
  // Undecided reviews have no decision date.
  assert.deepEqual(sorted("decided", 1), ["approved early", "changes late", "waiting old", "waiting new"]);
  assert.deepEqual(sorted("decided", -1), ["changes late", "approved early", "waiting old", "waiting new"]);
});

test("rows that tie in a column keep the queue's order", () => {
  const same = [row("b", { status: "approved", decided_at: "2026-11-11T10:00:00Z" }), row("c", { sent_at: "2026-11-12T09:00:00Z" }), row("a")];
  assert.deepEqual(titles(sortRows(same, { key: "kind", dir: 1 })), ["a", "c", "b"]);
  assert.deepEqual(titles(sortRows(same, { key: "kind", dir: -1 })), ["a", "c", "b"]);
});

test("a heading goes ascending, descending, then back to the queue", () => {
  let sort = nextSort({ key: null, dir: 1 }, "title");
  assert.deepEqual(sort, { key: "title", dir: 1 });
  sort = nextSort(sort, "title");
  assert.deepEqual(sort, { key: "title", dir: -1 });
  assert.deepEqual(nextSort(sort, "task"), { key: "task", dir: 1 });
  assert.deepEqual(nextSort(sort, "title"), { key: null, dir: 1 });
});

test("the filter shows what is waiting, or everything", () => {
  assert.deepEqual(titles(shownRows(ROWS, "waiting")), ["waiting new", "waiting old"]);
  assert.equal(shownRows(ROWS, "all").length, 4);
});

test("kinds are named as the review page tells them apart", () => {
  assert.equal(kindLabel("video/mp4", "cut.mp4"), "Video");
  assert.equal(kindLabel("image/png", "still.png"), "Image");
  assert.equal(kindLabel("text/html; charset=utf-8", "page.html"), "HTML");
  assert.equal(kindLabel("application/pdf", "deck.pdf"), "PDF");
  assert.equal(kindLabel("text/markdown", "script.md"), "Text");
  assert.equal(kindLabel("application/octet-stream", "notes.md"), "Text");
  assert.equal(kindLabel("application/json", "plan.json"), "Text");
  assert.equal(kindLabel(null, "archive.zip"), "File");
});

test("a row carries what the table shows and nothing else", () => {
  const listed = {
    token: "t".repeat(32), title: "Cut · v2", status: "approved", decided_by: "Sam", decided_at: "2026-11-11T10:00:00Z",
    content_type: "video/mp4", object_key: "tasks/5/tok/cut.mp4", created_at: "2026-11-10T09:00:00Z", version: 2,
    tasks: { id: 5, title: "Edit the cut", project: " Launch ", team_id: 1 },
  };
  const [shaped] = shapeRows("acme", [listed]);
  assert.deepEqual(shaped, {
    path: `/r/acme/${"t".repeat(32)}`, title: "Cut · v2", project: "Launch", kind: "Video", version: 2, status: "approved",
    sent_at: "2026-11-10T09:00:00Z", decided_at: "2026-11-11T10:00:00Z", decided_by: "Sam", task: { id: 5, title: "Edit the cut" },
  });
  // A version published again after a decision is waiting: no decision is shown for it. No project is no project.
  const [open] = shapeRows("acme", [{ ...listed, status: "open", tasks: { ...listed.tasks, project: null } }]);
  assert.equal(open.decided_at, null);
  assert.equal(open.decided_by, null);
  assert.equal(open.project, null);
});

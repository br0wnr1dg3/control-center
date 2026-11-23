// The review list's pure parts, with no imports so tests can load this file by itself: what a row is
// (made here, on the Worker) and how rows are ordered (in the page, so it is kept as script source).

export type ListedReview = {
  token: string;
  title: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  content_type: string | null;
  object_key: string;
  created_at: string;
  version: number;
  tasks: { id: number; title: string; project: string | null };
};

export type ListRow = {
  path: string;
  title: string;
  project: string | null;
  kind: string;
  version: number;
  status: string;
  sent_at: string;
  decided_at: string | null;
  decided_by: string | null;
  task: { id: number; title: string };
};

// What the output is, as the review page tells them apart (review.ts `kindOf`), in a word a person would use.
export function kindLabel(type: string | null, filename: string): string {
  type = (type ?? "").toLowerCase();
  if (type.startsWith("video/")) return "Video";
  if (type.startsWith("image/")) return "Image";
  if (type.startsWith("text/html")) return "HTML";
  if (type === "application/pdf") return "PDF";
  if (type.startsWith("text/") || type.startsWith("application/json") || /\.(md|markdown|txt)$/i.test(filename)) return "Text";
  return "File";
}

// One row per review. Only what the table shows: no file address, no notes.
export const shapeRows = (team: string, reviews: ListedReview[]): ListRow[] =>
  reviews.map((r) => ({
    path: `/r/${team}/${r.token}`,
    title: r.title,
    project: r.tasks.project?.trim() || null,
    kind: kindLabel(r.content_type, r.object_key.split("/").pop() ?? ""),
    version: r.version,
    status: r.status,
    sent_at: r.created_at,
    decided_at: r.status === "open" ? null : r.decided_at,
    decided_by: r.status === "open" ? null : r.decided_by,
    task: { id: r.tasks.id, title: r.tasks.title },
  }));

// The page's ordering, as script: it runs in the browser, and test/review-list.test.mjs runs the same text.
// Like the page it goes into, it must not contain backticks or "${".
//
// Unsorted, the list is a queue: what is waiting first, longest wait at the top, then what was decided,
// latest decision first. A heading sorts by its column, and rows that tie there keep the queue's order.
// A row with nothing in the column goes last whichever way the column runs.
export const LIST_ORDER = String.raw`
const STATUS_RANK = { open: 0, changes_requested: 1, approved: 2 };
const when = (value) => (value ? Date.parse(value) || 0 : 0);
const words = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function queueOrder(a, b) {
  const aWaits = a.status === "open", bWaits = b.status === "open";
  if (aWaits !== bWaits) return aWaits ? -1 : 1;
  const byTime = aWaits ? when(a.sent_at) - when(b.sent_at) : when(b.decided_at) - when(a.decided_at);
  return byTime || a.task.id - b.task.id || words(a.title, b.title) || a.version - b.version;
}

const COLUMNS = {
  project: { value: (r) => r.project || null, compare: words },
  title: { value: (r) => r.title, compare: words },
  kind: { value: (r) => r.kind, compare: words },
  version: { value: (r) => r.version },
  status: { value: (r) => (r.status in STATUS_RANK ? STATUS_RANK[r.status] : 9) },
  sent: { value: (r) => when(r.sent_at) || null },
  decided: { value: (r) => when(r.decided_at) || null },
  task: { value: (r) => r.task.id },
};

// sort is { key, dir }: key a column or null for the queue, dir 1 (ascending) or -1.
function sortRows(rows, sort) {
  const column = sort && COLUMNS[sort.key];
  if (!column) return rows.slice().sort(queueOrder);
  const dir = sort.dir === -1 ? -1 : 1, compare = column.compare || ((a, b) => a - b);
  return rows.slice().sort((a, b) => {
    const x = column.value(a), y = column.value(b);
    if (x === null || y === null) return x === y ? queueOrder(a, b) : x === null ? 1 : -1;
    return compare(x, y) * dir || queueOrder(a, b);
  });
}

// A heading clicked: ascending, then descending, then back to the queue.
function nextSort(sort, key) {
  if (!sort || sort.key !== key) return { key, dir: 1 };
  return sort.dir === 1 ? { key, dir: -1 } : { key: null, dir: 1 };
}

const shownRows = (rows, filter) => (filter === "all" ? rows : rows.filter((r) => r.status === "open"));
`;

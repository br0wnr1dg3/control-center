-- Review batches: one private link (/b/<token>) showing many published reviews at once, so a day's
-- cuts can be approved or struck from a grid. A batch only gathers reviews: each item is still decided
-- through its own review (same comment, inbox note, completes_task and webhook), so there's nothing
-- about decisions here.

create table review_batches (
  id         bigint generated always as identity primary key,
  token      text not null unique,            -- the secret in /b/<token>
  title      text not null check (length(title) between 1 and 200),
  team_id    bigint references teams(id) on delete set null,
  -- The task whose work it gathers (a parent and its sub-tasks). With a task, the title names the batch:
  -- `cc-publish --batch <name>` from any of its sub-tasks lands in the same one. Null for batches made
  -- from a label or a list of reviews, which can share a title.
  task_id    bigint references tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (task_id, title)
);

create table review_batch_items (
  batch_id  bigint not null references review_batches(id) on delete cascade,
  review_id bigint not null references reviews(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (batch_id, review_id)
);

create index review_batch_items_review_idx on review_batch_items (review_id);

alter table review_batches enable row level security;
alter table review_batch_items enable row level security;

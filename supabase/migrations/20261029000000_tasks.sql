-- Control Center: single-user task board shared by Claude (CLI, web, Slack),
-- the Mac app, and the agent runner.

create type task_kind as enum ('human', 'agent', 'either');
create type task_status as enum ('inbox', 'ready', 'in_progress', 'needs_you', 'done', 'cancelled');

create table tasks (
  id          bigint generated always as identity primary key,  -- short ids: "task 42"
  title       text not null check (length(title) between 1 and 500),
  notes       text,
  kind        task_kind not null default 'either',
  status      task_status not null default 'inbox',
  area        text,                       -- personal, finance, content, health…
  due         date,
  today       boolean not null default false,
  sort_order  double precision not null default 0,
  parent_id   bigint references tasks(id) on delete set null,
  source      text,                       -- cli | web:<account> | slack | app | agent
  question    text,                       -- open question when status = needs_you
  session_id  text,                       -- claude session to resume
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  completed_at timestamptz
);

create index tasks_open_idx on tasks (status) where status not in ('done', 'cancelled');
create index tasks_parent_idx on tasks (parent_id);

-- Append-only history: notes, agent progress, questions and answers.
create table task_events (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references tasks(id) on delete cascade,
  kind       text not null check (kind in ('note', 'question', 'answer', 'status', 'agent_log')),
  body       text not null,
  actor      text,                        -- me | claude:<source> | runner
  created_at timestamptz not null default now()
);

create index task_events_task_idx on task_events (task_id, created_at);

create function touch_task() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'done' and old.status is distinct from 'done' then
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end $$;

create trigger tasks_touch before update on tasks
  for each row execute function touch_task();

-- Deny-by-default. The MCP worker and runner use the service role (bypasses RLS);
-- add policies here when the Mac app signs in as an authenticated user.
alter table tasks enable row level security;
alter table task_events enable row level security;

alter publication supabase_realtime add table tasks, task_events;

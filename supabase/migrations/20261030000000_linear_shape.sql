-- Linear-style tasks: description, project, priority, labels, links, comments, and an inbox of notifications.

alter type task_status rename value 'inbox' to 'new';
alter table tasks alter column status set default 'new';

alter table tasks rename column notes to description;
alter table tasks rename column area to project;

-- Linear's scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
alter table tasks add column priority smallint not null default 0 check (priority between 0 and 4);
alter table tasks add column labels text[] not null default '{}';
alter table tasks add column links jsonb not null default '[]';   -- [{title, url}]
-- The day to work on it (calendar placement). `due` stays the deadline.
-- The runner won't start an agent task before its scheduled day.
alter table tasks add column scheduled_on date;

create index tasks_labels_idx on tasks using gin (labels);
create index tasks_scheduled_idx on tasks (scheduled_on) where scheduled_on is not null;

-- Discussion thread. author: me | claude (chat) | agent (runner session).
create table task_comments (
  id           bigint generated always as identity primary key,
  task_id      bigint not null references tasks(id) on delete cascade,
  author       text not null check (author in ('me', 'claude', 'agent')),
  body         text not null check (length(body) > 0),
  delivered_at timestamptz,             -- runner typed it into the live agent session
  created_at   timestamptz not null default now()
);
create index task_comments_task_idx on task_comments (task_id, created_at);

-- Inbox: what needs Chris's attention. Written by triggers so every client (MCP, runner, app) agrees.
create table notifications (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references tasks(id) on delete cascade,
  kind       text not null check (kind in ('question', 'comment', 'handoff', 'done', 'stalled')),
  body       text not null,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_unread_idx on notifications (created_at desc) where read_at is null;

create function notify_on_comment() returns trigger language plpgsql as $$
begin
  -- Skip a comment that just restates the open question already in the inbox (ask_human posts both).
  if new.author <> 'me' and not exists (
    select 1 from notifications
    where task_id = new.task_id and kind = 'question' and body = new.body and read_at is null
  ) then
    insert into notifications (task_id, kind, body) values (new.task_id, 'comment', new.body);
  end if;
  return new;
end $$;

create trigger task_comments_notify after insert on task_comments
  for each row execute function notify_on_comment();

create function notify_on_task() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.kind = 'human' and new.source = 'agent' then
      insert into notifications (task_id, kind, body) values (new.id, 'handoff', new.title);
    end if;
    return new;
  end if;

  if new.status = 'needs_you' and old.status is distinct from 'needs_you' then
    insert into notifications (task_id, kind, body)
    values (new.id, case when new.question like 'The session window closed%' then 'stalled' else 'question' end,
            coalesce(new.question, new.title));
  elsif new.status = 'done' and old.status <> 'done' and new.kind = 'agent' then
    insert into notifications (task_id, kind, body) values (new.id, 'done', new.title);
  end if;

  -- Answering or finishing a task clears its open questions from the inbox.
  if old.status = 'needs_you' and new.status <> 'needs_you' then
    update notifications set read_at = now()
    where task_id = new.id and kind in ('question', 'stalled') and read_at is null;
  end if;
  return new;
end $$;

create trigger tasks_notify after insert or update of status on tasks
  for each row execute function notify_on_task();

alter table task_comments enable row level security;
alter table notifications enable row level security;
alter publication supabase_realtime add table task_comments, notifications;

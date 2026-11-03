-- Stage dependencies: a task can wait on others, so a multi-stage job advances by itself.
--
-- Blockers delay a task, they don't approve it. `ready` keeps meaning the owner approved the work, so no
-- trigger here ever moves a task to ready. Instead:
--   * While any blocker is still open, waiting_on(task) lists it. The runner doesn't start a ready agent
--     task that is waiting, and a ready task for the owner stays off Today.
--   * When the last open blocker finishes, a ready agent task simply becomes startable. A ready task for
--     the owner lands in the inbox, since no session will pick it up. A new task stays new: it still
--     needs approving.
--   * When a blocker is cancelled, a task that is new or ready moves to needs_you with a note, rather
--     than being cancelled silently: the stage may still be worth doing. Answering makes it ready. A
--     cancelled blocker no longer counts as open, so the answered task goes ahead once any others finish.
--
-- Any other status is left alone: work has begun, or someone set it on purpose. Removing a blocker that
-- is still open (or deleting the task) stops the wait, and is logged on the waiting task.

create table task_dependencies (
  task_id       bigint not null references tasks(id) on delete cascade,
  blocked_by_id bigint not null references tasks(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (task_id, blocked_by_id),
  constraint task_dependencies_no_self check (task_id <> blocked_by_id)
);

create index task_dependencies_blocker_idx on task_dependencies (blocked_by_id);

-- The one definition of "waiting", for every client. PostgREST exposes it as a computed column:
-- select=*,waiting_on and waiting_on=eq.{} (it isn't part of select=*).
create function waiting_on(task tasks) returns bigint[] language sql stable as $$
  select coalesce(array_agg(d.blocked_by_id order by d.blocked_by_id), '{}')
  from task_dependencies d
  join tasks blocker on blocker.id = d.blocked_by_id
  where d.task_id = task.id and blocker.status not in ('done', 'cancelled')
$$;

create function prevent_dependency_cycle() returns trigger language plpgsql as $$
begin
  -- One writer at a time: two concurrent edges could otherwise close a loop neither of them can see.
  perform pg_advisory_xact_lock(hashtext('task_dependencies'));
  if exists (
    with recursive upstream (id) as (
      select new.blocked_by_id
      union
      select d.blocked_by_id from task_dependencies d join upstream u on d.task_id = u.id
    )
    select 1 from upstream where id = new.task_id
  ) then
    raise exception 'CC-% can''t be blocked by CC-%: that would make a cycle', new.task_id, new.blocked_by_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger task_dependencies_no_cycle before insert or update on task_dependencies
  for each row execute function prevent_dependency_cycle();

create function hold_for_cancelled_blocker(waiting_id bigint, blocker_id bigint) returns void language plpgsql as $$
declare
  note text;
begin
  select format('CC-%s "%s", which this was waiting on, was cancelled. Answer to go ahead without it, or cancel this task.',
                id, title)
    into note from tasks where id = blocker_id;
  update tasks set status = 'needs_you', question = note  -- notify_on_task adds it to the inbox
    where id = waiting_id and status in ('new', 'ready');
  if found then
    insert into task_events (task_id, kind, body, actor) values (waiting_id, 'note', note, 'board');
  end if;
end $$;

-- These tasks may have just stopped waiting: note it on any with nothing left open.
create function note_released_tasks(ids bigint[]) returns void language plpgsql as $$
declare
  t record;
begin
  -- Without this, two blockers finishing at the same moment each see the other as still open and
  -- nobody hears the task is free. Waiting here means the later one re-reads the first one's commit.
  perform 1 from tasks where id = any(ids) and status in ('new', 'ready') order by id for update;

  for t in
    select task.id, task.kind, task.title, task.status
    from tasks task
    where task.id = any(ids) and task.status in ('new', 'ready') and cardinality(waiting_on(task)) = 0
  loop
    insert into task_events (task_id, kind, body, actor)
      values (t.id, 'note',
              case when t.status = 'new' then 'no longer waiting on anything; still new, so it needs approving'
                   else 'no longer waiting on anything' end,
              'board');
    if t.status = 'ready' and t.kind <> 'agent' then
      insert into notifications (task_id, kind, body) values (t.id, 'handoff', t.title);
    end if;
  end loop;
end $$;

create function settle_on_blocker_finished() returns trigger language plpgsql as $$
declare
  waiting bigint;
begin
  if new.status = 'cancelled' then
    for waiting in select task_id from task_dependencies where blocked_by_id = new.id order by task_id loop
      perform hold_for_cancelled_blocker(waiting, new.id);
    end loop;
  elsif old.status <> 'cancelled' then  -- a cancelled blocker wasn't holding anything back
    perform note_released_tasks(array(select task_id from task_dependencies where blocked_by_id = new.id));
  end if;
  return new;
end $$;

create trigger tasks_settle_blocked after update of status on tasks
  for each row when (new.status in ('done', 'cancelled') and old.status is distinct from new.status)
  execute function settle_on_blocker_finished();

-- Adding a blocker that's already cancelled gets the same question as one cancelled later. Only the
-- new row counts, so re-saving the list doesn't ask again about a blocker already answered for.
create function settle_on_dependency_added() returns trigger language plpgsql as $$
begin
  if exists (select 1 from tasks where id = new.blocked_by_id and status = 'cancelled') then
    perform hold_for_cancelled_blocker(new.task_id, new.blocked_by_id);
  end if;
  return null;
end $$;

create trigger task_dependencies_settle_insert after insert on task_dependencies
  for each row execute function settle_on_dependency_added();

-- Per statement, so removing several blockers notes the task once. A blocker row gone from `tasks` was
-- deleted outright, which this also runs for; a waiting task that was itself deleted is skipped.
create function settle_on_dependency_removed() returns trigger language plpgsql as $$
declare
  released bigint[];
begin
  select array_agg(distinct task.id) into released
  from changed c
  join tasks task on task.id = c.task_id and task.status in ('new', 'ready')
  left join tasks blocker on blocker.id = c.blocked_by_id
  where blocker.id is null or blocker.status not in ('done', 'cancelled');

  insert into task_events (task_id, kind, body, actor)
  select c.task_id, 'note',
         format('stopped waiting on CC-%s: %s', c.blocked_by_id,
                case when blocker.id is null then 'it was deleted' else 'the dependency was removed' end),
         'board'
  from changed c
  left join tasks blocker on blocker.id = c.blocked_by_id
  where c.task_id = any(coalesce(released, '{}'))
    and (blocker.id is null or blocker.status not in ('done', 'cancelled'));

  perform note_released_tasks(coalesce(released, '{}'));
  return null;
end $$;

create trigger task_dependencies_settle_delete after delete on task_dependencies
  referencing old table as changed
  for each statement execute function settle_on_dependency_removed();

alter table task_dependencies enable row level security;
alter publication supabase_realtime add table task_dependencies;

-- "Approving completes the task": decide() in the Worker marks the task done with the decision.
alter table reviews add column completes_task boolean not null default false;

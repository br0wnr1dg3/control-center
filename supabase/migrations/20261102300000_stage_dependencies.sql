-- Stage dependencies: a task can wait on others, so a multi-stage job advances by itself.
--
-- A task that is still `new` and has blockers settles like this, whenever a blocker finishes or its
-- list of blockers changes:
--   * any blocker cancelled: it moves to needs_you with a note, so the owner decides whether to start it
--     anyway (answering makes it ready) or cancel it. It never gets cancelled silently, because the
--     stage may still be worth doing.
--   * otherwise, all blockers done: it moves to ready. Agent tasks still wait for scheduled_on in the
--     runner as usual; anything else lands in the inbox, since no session will pick it up.
--
-- Only `new` tasks move: any other status was set on purpose (a person made it ready, or work has
-- begun), so it is left alone. That also means reopening a blocker doesn't pull back a stage that has
-- already advanced. A task whose last blocker is removed stays `new`: with nothing left to wait for,
-- it's an ordinary untriaged task and starting it is the owner's call.

create table task_dependencies (
  task_id       bigint not null references tasks(id) on delete cascade,
  blocked_by_id bigint not null references tasks(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (task_id, blocked_by_id),
  constraint task_dependencies_no_self check (task_id <> blocked_by_id)
);

create index task_dependencies_blocker_idx on task_dependencies (blocked_by_id);

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

create function settle_blocked_tasks(ids bigint[]) returns void language plpgsql as $$
declare
  t record;
  note text;
begin
  -- Without this, two blockers finishing at the same moment each see the other as still open and
  -- neither advances the task. Waiting here means the later one re-reads the first one's commit.
  perform 1 from tasks where id = any(ids) and status = 'new' order by id for update;

  for t in
    select distinct on (task.id) task.id, blocker.id as blocker_id, blocker.title as blocker_title
    from tasks task
    join task_dependencies d on d.task_id = task.id
    join tasks blocker on blocker.id = d.blocked_by_id
    where task.id = any(ids) and task.status = 'new' and blocker.status = 'cancelled'
    order by task.id, blocker.id
  loop
    note := format('CC-%s "%s", which this was waiting on, was cancelled. Answer to start this anyway, or cancel it.',
                   t.blocker_id, t.blocker_title);
    update tasks set status = 'needs_you', question = note where id = t.id;  -- notify_on_task adds it to the inbox
    insert into task_events (task_id, kind, body, actor) values (t.id, 'note', note, 'board');
  end loop;

  for t in
    update tasks task set status = 'ready'
    where task.id = any(ids) and task.status = 'new'
      and exists (select 1 from task_dependencies d where d.task_id = task.id)
      and not exists (
        select 1 from task_dependencies d join tasks blocker on blocker.id = d.blocked_by_id
        where d.task_id = task.id and blocker.status <> 'done'
      )
    returning task.id, task.kind, task.title
  loop
    insert into task_events (task_id, kind, body, actor)
      values (t.id, 'status', 'ready: everything it was waiting on is done', 'board');
    if t.kind <> 'agent' then
      insert into notifications (task_id, kind, body) values (t.id, 'handoff', t.title);
    end if;
  end loop;
end $$;

create function settle_on_blocker_finished() returns trigger language plpgsql as $$
begin
  perform settle_blocked_tasks(array(select task_id from task_dependencies where blocked_by_id = new.id));
  return new;
end $$;

create trigger tasks_settle_blocked after update of status on tasks
  for each row when (new.status in ('done', 'cancelled') and old.status is distinct from new.status)
  execute function settle_on_blocker_finished();

-- Per statement, so a task added with several blockers in one insert is judged on all of them, not on
-- whichever row went in first. Also means a stage added after its blocker finished doesn't wait forever.
create function settle_on_dependency_change() returns trigger language plpgsql as $$
begin
  perform settle_blocked_tasks(array(select distinct task_id from changed));
  return null;
end $$;

create trigger task_dependencies_settle_insert after insert on task_dependencies
  referencing new table as changed
  for each statement execute function settle_on_dependency_change();

create trigger task_dependencies_settle_delete after delete on task_dependencies
  referencing old table as changed
  for each statement execute function settle_on_dependency_change();

alter table task_dependencies enable row level security;
alter publication supabase_realtime add table task_dependencies;

-- "Approving completes the task": decide() in the Worker marks the task done after posting the decision.
alter table reviews add column completes_task boolean not null default false;

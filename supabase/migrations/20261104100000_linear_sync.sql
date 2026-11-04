-- Linear issues delegated to Control Center become ready agent tasks; what happens to them goes back to
-- Linear. The runner does the talking (runner/linear.mjs). Everything here is so that it stays one task
-- per issue however many runners poll, and so that every client's changes get reported, not just the
-- runner's: triggers write to an outbox and the runner posts from it.

alter table teams
  add column linear_teams text[] not null default '{}',  -- Linear team keys that belong to this team, e.g. {ENG}
  add column linear_review_state text,  -- status for an open PR; empty means a started status with "review" in its name
  add column linear_done_state text,    -- status for finished work; empty means never move it to done
  add column linear_assignee text;      -- email: also show that person's issues as read-only tasks; empty means off

-- external_ref.id is the human identifier, which changes if the issue moves to another Linear team, so
-- the issue's own id is what makes it one task per issue.
create unique index tasks_linear_id_idx on tasks ((external_ref ->> 'linear_id')) where external_ref ? 'linear_id';

create table linear_outbox (
  id          bigint generated always as identity primary key,
  task_id     bigint not null references tasks(id) on delete cascade,
  kind        text not null check (kind in ('started', 'comment', 'question', 'pr', 'done', 'cancelled', 'handback')),
  body        text,
  created_at  timestamptz not null default now(),
  next_try_at timestamptz not null default now(),
  claimed_at  timestamptz,
  attempts    int not null default 0,
  last_error  text,
  sent_at     timestamptz
);
create index linear_outbox_pending_idx on linear_outbox (task_id, id) where sent_at is null;
alter table linear_outbox enable row level security;

create function linear_reported(t tasks) returns boolean language sql immutable as $$
  select t.external_ref ? 'linear_id' and not coalesce((t.external_ref ->> 'mirror')::boolean, false)
$$;

create function linear_enqueue_task() returns trigger language plpgsql as $$
declare
  url text;
begin
  if not linear_reported(new) then
    return new;
  end if;

  if new.status is distinct from old.status then
    -- Only from new or ready: a task also returns to in_progress from needs_you whenever someone answers.
    if new.status = 'in_progress' and old.status in ('new', 'ready') then
      insert into linear_outbox (task_id, kind) values (new.id, 'started');
    elsif new.status = 'needs_you' then
      insert into linear_outbox (task_id, kind, body) values (new.id, 'question', coalesce(new.question, new.title));
    elsif new.status in ('done', 'cancelled') then
      -- complete_task logs its summary just after this update, so give it a moment to arrive.
      insert into linear_outbox (task_id, kind, next_try_at)
        values (new.id, new.status::text, now() + interval '30 seconds');
    end if;
  end if;

  if old.kind = 'agent' and new.kind = 'human' and new.status not in ('done', 'cancelled') then
    insert into linear_outbox (task_id, kind) values (new.id, 'handback');
  end if;

  if new.links is distinct from old.links then
    for url in
      select l ->> 'url' from jsonb_array_elements(coalesce(new.links, '[]')) l
      where l ->> 'url' ~* '^https?://[^ ]+/(pull|merge_requests)/[0-9]+'
      except
      select l ->> 'url' from jsonb_array_elements(coalesce(old.links, '[]')) l
    loop
      insert into linear_outbox (task_id, kind, body) values (new.id, 'pr', url);
    end loop;
  end if;
  return new;
end $$;

create trigger tasks_linear_outbox after update of status, kind, links on tasks
  for each row execute function linear_enqueue_task();

-- The agent's own words only. Comments from the owner and from reviewers stay on the board.
create function linear_enqueue_comment() returns trigger language plpgsql as $$
declare
  t tasks;
begin
  select * into t from tasks where id = new.task_id;
  if not linear_reported(t) then
    return new;
  end if;
  -- ask_human also posts its question as a comment; the status change has already reported it.
  if t.status = 'needs_you' and new.body = t.question then
    return new;
  end if;
  insert into linear_outbox (task_id, kind, body) values (new.task_id, 'comment', new.body);
  return new;
end $$;

create trigger task_comments_linear_outbox after insert on task_comments
  for each row when (new.author in ('agent', 'claude')) execute function linear_enqueue_comment();

create function linear_enqueue_progress() returns trigger language plpgsql as $$
declare
  t tasks;
begin
  select * into t from tasks where id = new.task_id;
  if linear_reported(t) then
    insert into linear_outbox (task_id, kind, body) values (new.task_id, 'comment', new.body);
  end if;
  return new;
end $$;

create trigger task_events_linear_outbox after insert on task_events
  for each row when (new.kind = 'agent_log') execute function linear_enqueue_progress();

-- The oldest unsent row of each task, so a task's updates reach Linear in order. Claimed for a while
-- rather than until sent, so a runner that dies mid-send doesn't strand them.
create function linear_outbox_claim(p_limit int default 20) returns setof linear_outbox language sql as $$
  update linear_outbox o
    set claimed_at = now(), attempts = o.attempts + 1
  where o.id in (
    select c.id from linear_outbox c
    where c.id in (select min(p.id) from linear_outbox p where p.sent_at is null group by p.task_id)
      and c.next_try_at <= now()
      and (c.claimed_at is null or c.claimed_at < now() - interval '5 minutes')
    order by c.id
    limit p_limit
    for update skip locked
  )
  returning o.*
$$;

-- Create or refresh the task for one issue, in one transaction. p_issue: {linear_id, id, url, title,
-- description, priority, due, labels, project, requested_by}. p_mirror = the read-only view of someone's
-- assigned issues: a human task on Today that reports nothing back.
create function linear_upsert_issue(p_team bigint, p_issue jsonb, p_mirror boolean default false)
returns jsonb language plpgsql as $$
declare
  t tasks;
  project_name text := nullif(btrim(p_issue ->> 'project'), '');
  project_team bigint;
  project_known boolean;
  ref jsonb;
  was_mirror boolean;
begin
  ref := jsonb_strip_nulls(jsonb_build_object(
    'source', 'linear', 'id', p_issue ->> 'id', 'url', p_issue ->> 'url', 'linear_id', p_issue ->> 'linear_id',
    'mirror', case when p_mirror then true end
  ));

  select * into t from tasks where external_ref ->> 'linear_id' = p_issue ->> 'linear_id' for update;

  if not found then
    -- The project sync trigger would otherwise move the task to a same-named project's team.
    if project_name is not null then
      select true, team_id into project_known, project_team from projects where lower(name) = lower(project_name);
      if project_known and project_team is distinct from p_team then
        project_name := null;
      end if;
    end if;
    begin
      insert into tasks (title, description, kind, status, priority, labels, due, today, team_id, project, source, external_ref, requested_by)
      values (
        p_issue ->> 'title',
        p_issue ->> 'description',
        case when p_mirror then 'human' else 'agent' end::task_kind,
        'ready',
        coalesce((p_issue ->> 'priority')::int, 0),
        coalesce((select array_agg(l) from jsonb_array_elements_text(p_issue -> 'labels') l), '{}'),
        (p_issue ->> 'due')::date,
        p_mirror,
        p_team,
        project_name,
        'linear',
        ref,
        p_issue -> 'requested_by'
      )
      returning * into t;
    exception when unique_violation then
      return jsonb_build_object('action', 'none');  -- another runner got there first
    end;
    insert into task_events (task_id, kind, body, actor)
      values (t.id, 'note', format('%s from Linear %s', case when p_mirror then 'assigned' else 'delegated' end, p_issue ->> 'id'), 'runner');
    return jsonb_build_object('action', 'created', 'task', t.id);
  end if;

  was_mirror := coalesce((t.external_ref ->> 'mirror')::boolean, false);

  -- Being assigned says nothing about a task an agent has or had.
  if p_mirror and not was_mirror then
    return jsonb_build_object('action', 'none', 'task', t.id);
  end if;

  -- Edits in Linear show on the board. A session already running keeps the brief it started with.
  update tasks set
    title = p_issue ->> 'title',
    description = p_issue ->> 'description',
    priority = coalesce((p_issue ->> 'priority')::int, 0),
    due = (p_issue ->> 'due')::date,
    external_ref = ref
  where id = t.id
    and (title, description, priority, due, external_ref)
      is distinct from (p_issue ->> 'title', p_issue ->> 'description', coalesce((p_issue ->> 'priority')::int, 0), (p_issue ->> 'due')::date, ref);

  if p_mirror then
    -- Stopped being assigned, then assigned again. A task someone ticked off (done) stays that way.
    if t.status = 'cancelled' then
      update tasks set status = 'ready', today = true where id = t.id;
      return jsonb_build_object('action', 'reopened', 'task', t.id);
    end if;
    return jsonb_build_object('action', 'none', 'task', t.id);
  end if;

  if t.kind = 'agent' and not was_mirror and t.status not in ('done', 'cancelled') then
    return jsonb_build_object('action', 'none', 'task', t.id);
  end if;

  -- The issue stays delegated until the runner has told Linear this task finished, which is also what
  -- takes the delegate off. Until then it's the old delegation, not a new one.
  if exists (select 1 from linear_outbox where task_id = t.id and sent_at is null) then
    return jsonb_build_object('action', 'none', 'task', t.id);
  end if;

  -- Delegated again. Without a worktree to go back to, a resumed session has nothing to stand on.
  update tasks set
    kind = 'agent',
    status = 'ready',
    today = false,
    question = null,
    session_id = case when worktree is null then null else session_id end
  where id = t.id;
  insert into task_events (task_id, kind, body, actor)
    values (t.id, 'status', format('ready: delegated again in Linear (%s)', p_issue ->> 'id'), 'runner');
  return jsonb_build_object('action', 'reopened', 'task', t.id);
end $$;

-- Same reasoning as the inbound functions: PostgREST exposes new functions, and only the runner's
-- service key should reach these.
revoke all on function linear_outbox_claim(int) from public, anon, authenticated;
revoke all on function linear_upsert_issue(bigint, jsonb, boolean) from public, anon, authenticated;
revoke all on function linear_reported(tasks) from public, anon, authenticated;
grant execute on function linear_outbox_claim(int) to service_role;
grant execute on function linear_upsert_issue(bigint, jsonb, boolean) to service_role;

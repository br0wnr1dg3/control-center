-- Signed inbound events: a trusted app (one secret per team) creates job trees and advances stages.
-- The Worker checks the signature and the event's shape (mcp/src/inbound.ts); everything else is here,
-- in one transaction, so a job appears whole or not at all and the runner never sees a stage without
-- its blockers. A failed event isn't recorded, so the sender can retry it with the same id.

alter table tasks
  add column external_ref jsonb,  -- {source, id, url}: where this task lives in the app that sent it
  add column requested_by jsonb,  -- {name, email}: the person in that app who asked for it
  add constraint tasks_external_ref_shape check (
    external_ref is null or (jsonb_typeof(external_ref -> 'source') = 'string' and jsonb_typeof(external_ref -> 'id') = 'string')
  ),
  add constraint tasks_requested_by_shape check (requested_by is null or jsonb_typeof(requested_by) = 'object');

-- Scoped by team, so one team's secret can't find out what another team's tasks are called.
create unique index tasks_external_ref_idx on tasks (team_id, (external_ref ->> 'source'), (external_ref ->> 'id'))
  where external_ref is not null;

-- 'external' comments reach the inbox, but aren't typed into live sessions (the runner only delivers
-- 'me' and 'reviewer') and can't hand a task to an agent (only 'me' can).
alter table task_comments drop constraint task_comments_author_check;
alter table task_comments add constraint task_comments_author_check
  check (author in ('me', 'claude', 'agent', 'reviewer', 'external'));

create table inbound_events (
  team_id     bigint not null references teams(id) on delete cascade,
  source      text not null,
  event_id    text not null,
  type        text not null,
  payload     jsonb not null,
  result      jsonb not null,
  received_at timestamptz not null default now(),
  primary key (team_id, source, event_id)
);
alter table inbound_events enable row level security;

-- Errors use their own SQLSTATEs, which the Worker turns into HTTP statuses: CC404, CC409, CC422.

-- Only tasks that came in through this endpoint can be addressed, in the sender's own team. So a leaked
-- secret can't approve the owner's other tasks.
create function inbound_task(p_team bigint, p_source text, p_id text) returns tasks language plpgsql as $$
declare
  t tasks;
begin
  select * into t from tasks
    where team_id = p_team and external_ref ->> 'source' = p_source and external_ref ->> 'id' = p_id
    for update;
  if not found then
    raise exception 'No task with id "%" from %', p_id, p_source using errcode = 'CC404';
  end if;
  return t;
end $$;

-- A ready task for the owner lands in the inbox unless it's still waiting (then it does so when it's freed).
create function inbound_flag_ready(p_task bigint) returns void language plpgsql as $$
begin
  insert into notifications (task_id, kind, body)
    select t.id, 'handoff', t.title from tasks t
    where t.id = p_task and t.status = 'ready' and t.kind <> 'agent' and cardinality(waiting_on(t)) = 0;
end $$;

create function inbound_insert_task(p_team bigint, p_source text, p_project text, p_parent bigint, p_requested_by jsonb, p_fields jsonb, p_inherit jsonb)
returns bigint language plpgsql as $$
declare
  new_id bigint;
begin
  insert into tasks (title, description, kind, status, priority, labels, scheduled_on, due, team_id, project, parent_id, source, external_ref, requested_by)
  values (
    p_fields ->> 'title',
    p_fields ->> 'description',
    coalesce(p_fields ->> 'kind', 'either')::task_kind,
    'new',
    coalesce((p_fields ->> 'priority')::int, (p_inherit ->> 'priority')::int, 0),
    coalesce(
      (select array_agg(l) from jsonb_array_elements_text(coalesce(p_fields -> 'labels', p_inherit -> 'labels')) l),
      '{}'
    ),
    (p_fields ->> 'scheduled_on')::date,
    (p_fields ->> 'due')::date,
    p_team,
    p_project,
    p_parent,
    p_source,
    jsonb_strip_nulls(jsonb_build_object('source', p_source, 'id', p_fields ->> 'id', 'url', p_fields ->> 'url')),
    p_requested_by
  )
  returning id into new_id;
  return new_id;
exception
  when unique_violation then
    raise exception 'A task with id "%" from % already exists', p_fields ->> 'id', p_source using errcode = 'CC409';
end $$;

create function inbound_job_create(p_team bigint, p_source text, p_job jsonb) returns jsonb language plpgsql as $$
declare
  owner_team bigint;
  project_known boolean;
  job_task bigint;
  ids jsonb;
  stage jsonb;
  blocker text;
  stage_id bigint;
  all_ids bigint[];
  one bigint;
begin
  -- The project sync trigger would otherwise move the task to the project's team, or claim a project
  -- with no team for this one and take its tasks along.
  if p_job ->> 'project' is not null then
    select true, team_id into project_known, owner_team from projects where lower(name) = lower(btrim(p_job ->> 'project'));
    if project_known and owner_team is distinct from p_team then
      raise exception 'Project "%" isn''t in this team', p_job ->> 'project' using errcode = 'CC422';
    end if;
  end if;

  job_task := inbound_insert_task(p_team, p_source, p_job ->> 'project', null, p_job -> 'requested_by', p_job, '{}');
  ids := jsonb_build_object(p_job ->> 'id', job_task);
  all_ids := array[job_task];

  for stage in select * from jsonb_array_elements(coalesce(p_job -> 'stages', '[]')) loop
    stage_id := inbound_insert_task(p_team, p_source, p_job ->> 'project', job_task, p_job -> 'requested_by', stage, p_job);
    ids := ids || jsonb_build_object(stage ->> 'id', stage_id);
    all_ids := all_ids || stage_id;
  end loop;

  -- Blockers only name stages of this job, so a sender can't hold up tasks it didn't make.
  for stage in select * from jsonb_array_elements(coalesce(p_job -> 'stages', '[]')) loop
    for blocker in select * from jsonb_array_elements_text(coalesce(stage -> 'blocked_by', '[]')) loop
      if not ids ? blocker or blocker = p_job ->> 'id' then
        raise exception 'Stage "%" is blocked by "%", which isn''t a stage of this job', stage ->> 'id', blocker using errcode = 'CC422';
      end if;
      insert into task_dependencies (task_id, blocked_by_id)
        values ((ids ->> (stage ->> 'id'))::bigint, (ids ->> blocker)::bigint)
        on conflict do nothing;
    end loop;
  end loop;

  -- Ready last, once every blocker is in.
  if (p_job ->> 'ready')::boolean then
    update tasks set status = 'ready' where id = job_task;
  end if;
  for stage in select * from jsonb_array_elements(coalesce(p_job -> 'stages', '[]')) loop
    if (stage ->> 'ready')::boolean then
      update tasks set status = 'ready' where id = (ids ->> (stage ->> 'id'))::bigint;
    end if;
  end loop;

  foreach one in array all_ids loop
    perform inbound_flag_ready(one);
    insert into task_events (task_id, kind, body, actor) values (one, 'note', 'created from a signed event', 'inbound:' || p_source);
  end loop;

  return jsonb_build_object('tasks', ids);
end $$;

-- Only moves new to ready. A task that's started, finished, or waiting on the owner's decision is left
-- alone and the response says so: only the owner reopens work or answers for a cancelled blocker.
create function inbound_stage_ready(p_team bigint, p_source text, p_event jsonb) returns jsonb language plpgsql as $$
declare
  t tasks;
begin
  t := inbound_task(p_team, p_source, p_event ->> 'task');
  if t.status <> 'new' then
    return jsonb_build_object('task', t.id, 'status', t.status, 'changed', false);
  end if;
  update tasks set status = 'ready' where id = t.id;
  insert into task_events (task_id, kind, body, actor)
    values (t.id, 'status', coalesce('ready: ' || (p_event ->> 'note'), 'ready'), 'inbound:' || p_source);
  perform inbound_flag_ready(t.id);
  return jsonb_build_object('task', t.id, 'status', 'ready', 'changed', true);
end $$;

create function inbound_comment(p_team bigint, p_source text, p_event jsonb) returns jsonb language plpgsql as $$
declare
  t tasks;
  comment_id bigint;
begin
  t := inbound_task(p_team, p_source, p_event ->> 'task');
  insert into task_comments (task_id, author, author_name, body)
    values (t.id, 'external', coalesce(p_event ->> 'author', p_source), p_event ->> 'body')
    returning id into comment_id;
  return jsonb_build_object('task', t.id, 'comment', comment_id);
end $$;

-- The one entry point. The primary key makes a concurrent duplicate wait for the first to commit, then
-- it gets the same answer. Reusing an id for a different event is a sender bug, so it's refused rather
-- than answered as if the new event had been applied.
create function apply_inbound_event(p_team bigint, p_source text, p_event_id text, p_type text, p_payload jsonb)
returns jsonb language plpgsql as $$
declare
  seen inbound_events;
  outcome jsonb;
begin
  insert into inbound_events (team_id, source, event_id, type, payload, result)
    values (p_team, p_source, p_event_id, p_type, p_payload, '{}')
    on conflict do nothing;
  if not found then
    select * into seen from inbound_events where team_id = p_team and source = p_source and event_id = p_event_id;
    if seen.type <> p_type or seen.payload <> p_payload then
      raise exception 'Event id "%" was already used for a different event', p_event_id using errcode = 'CC409';
    end if;
    return seen.result || jsonb_build_object('duplicate', true);
  end if;

  outcome := case p_type
    when 'job.create' then inbound_job_create(p_team, p_source, p_payload)
    when 'stage.ready' then inbound_stage_ready(p_team, p_source, p_payload)
    when 'comment' then inbound_comment(p_team, p_source, p_payload)
  end;
  if outcome is null then
    raise exception 'Unknown event type %', p_type using errcode = 'CC422';
  end if;

  update inbound_events set result = outcome where team_id = p_team and source = p_source and event_id = p_event_id;
  return outcome || jsonb_build_object('duplicate', false);
end $$;

-- Supabase's default privileges let anon and authenticated call new functions through PostgREST, and
-- these write as whoever calls them. Only the Worker's service role may, after checking a signature.
revoke all on function inbound_task(bigint, text, text) from public, anon, authenticated;
revoke all on function inbound_flag_ready(bigint) from public, anon, authenticated;
revoke all on function inbound_insert_task(bigint, text, text, bigint, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function inbound_job_create(bigint, text, jsonb) from public, anon, authenticated;
revoke all on function inbound_stage_ready(bigint, text, jsonb) from public, anon, authenticated;
revoke all on function inbound_comment(bigint, text, jsonb) from public, anon, authenticated;
revoke all on function apply_inbound_event(bigint, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function apply_inbound_event(bigint, text, text, text, jsonb) to service_role;

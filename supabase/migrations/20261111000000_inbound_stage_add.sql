-- Inbound `stage.add`: a sender adds one stage to a job it created earlier, e.g. a "finish" stage once
-- a cut is approved. The stage is made exactly as job.create makes one (inbound_insert_task), so it
-- carries no new trust: a team's secret could already create ready stages, only not after the fact.

create function inbound_stage_add(p_team bigint, p_source text, p_event jsonb) returns jsonb language plpgsql as $$
declare
  job tasks;
  stage jsonb := p_event -> 'stage';
  stage_id bigint;
  blocker text;
  blocker_id bigint;
begin
  -- A job is a top-level task this source made in this team. Anything else gets the one answer, so a
  -- sender learns nothing about tasks that aren't its own jobs. The lock keeps the job's project and
  -- labels still while the stage copies them.
  select * into job from tasks
    where team_id = p_team and external_ref ->> 'source' = p_source and external_ref ->> 'id' = p_event ->> 'job'
      and parent_id is null
    for update;
  if not found then
    raise exception 'No job with id "%" from %', p_event ->> 'job', p_source using errcode = 'CC404';
  end if;

  -- What the job has now, not what it was sent with: the owner may have relabelled or moved it since.
  stage_id := inbound_insert_task(
    p_team, p_source, job.project, job.id, job.requested_by, stage,
    jsonb_build_object('labels', to_jsonb(job.labels), 'priority', job.priority)
  );

  -- Blockers only name stages of this job, so a sender can't hold up tasks it didn't make.
  for blocker in select * from jsonb_array_elements_text(coalesce(stage -> 'blocked_by', '[]')) loop
    select id into blocker_id from tasks
      where team_id = p_team and external_ref ->> 'source' = p_source and external_ref ->> 'id' = blocker
        and parent_id = job.id and id <> stage_id;
    if not found then
      raise exception 'Stage "%" is blocked by "%", which isn''t a stage of this job', stage ->> 'id', blocker using errcode = 'CC422';
    end if;
    insert into task_dependencies (task_id, blocked_by_id) values (stage_id, blocker_id) on conflict do nothing;
  end loop;

  -- Ready last, once every blocker is in. A blocker that was already cancelled has moved the stage to
  -- needs_you by now, and that stands: the owner answers for it, as for one cancelled later.
  if (stage ->> 'ready')::boolean then
    update tasks set status = 'ready' where id = stage_id and status = 'new';
  end if;

  perform inbound_flag_ready(stage_id);
  insert into task_events (task_id, kind, body, actor)
    values (stage_id, 'note', 'added to CC-' || job.id || ' by a signed event', 'inbound:' || p_source);

  return jsonb_build_object('tasks', jsonb_build_object(stage ->> 'id', stage_id));
end $$;

create or replace function apply_inbound_event(p_team bigint, p_source text, p_event_id text, p_type text, p_payload jsonb)
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
    when 'stage.add' then inbound_stage_add(p_team, p_source, p_payload)
    when 'stage.ready' then inbound_stage_ready(p_team, p_source, p_payload)
    when 'comment' then inbound_comment(p_team, p_source, p_payload)
  end;
  if outcome is null then
    raise exception 'Unknown event type %', p_type using errcode = 'CC422';
  end if;

  update inbound_events set result = outcome where team_id = p_team and source = p_source and event_id = p_event_id;
  return outcome || jsonb_build_object('duplicate', false);
end $$;

-- As for the other inbound functions: only the Worker's service role, through apply_inbound_event.
revoke all on function inbound_stage_add(bigint, text, jsonb) from public, anon, authenticated;

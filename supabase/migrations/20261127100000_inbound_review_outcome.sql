-- Inbound `review.outcome`: the app that sent a task reports what its own review of the task's
-- deliverable decided. Work that is reviewed in the sending app otherwise leaves its task here waiting on
-- a review nobody is going to open: the session idles (free only up to CC_MAX_WAITING a machine) and the
-- review list keeps a row that needs no decision.
--
--   approved   the review is approved, exactly as on its page: a review that completes its task finishes it.
--   rejected   the sender's reviewers turned it down and the sender handles the rework as separate work
--              (a new stage, say). The review is marked changes requested and the task is finished, and
--              the agent is told not to make another version. That is the one new thing here: on the
--              page, "changes requested" hands the notes to the same session for a next version.
--
-- Both go through decide_review, so the task, the review, the comment the runner types into the session
-- and the webhooks (task.status, then review.decided) are what a decision on the page produces.

-- decide_review gains p_close: finish the task with this decision whatever the decision is. Dropped and
-- made again rather than overloaded, so a call with the five earlier arguments still names one function;
-- the Worker from before this keeps working, since p_close defaults to false.
drop function decide_review(bigint, text, text, text, text);

create function decide_review(p_review bigint, p_status text, p_name text, p_message text default null, p_key text default null,
                              p_close boolean default false) returns jsonb
language plpgsql set search_path = public as $$
declare
  r reviews;
  current_version integer;
  completed boolean := false;
  picked bigint[];
  lines text;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_body text;
begin
  if p_status not in ('approved', 'changes_requested') then
    raise exception 'decide_review: unknown status %', p_status;
  end if;
  select * into r from reviews where id = p_review for update;
  if not found then
    raise exception 'review % not found', p_review;
  end if;

  if p_key is not null then
    if r.decision_key = p_key then
      return jsonb_build_object('replayed', true, 'status', r.status, 'decided_by', r.decided_by, 'decided_at', r.decided_at,
                                'completed_task', coalesce(r.decision_completed, false));
    end if;
    if exists (select 1 from task_comments where review_id = r.id and review_kind = 'decision' and client_key = p_key) then
      return jsonb_build_object('stale', true, 'status', r.status, 'decided_by', r.decided_by, 'decided_at', r.decided_at);
    end if;
  end if;

  if not r.is_current then
    select version into current_version from reviews where piece_id = r.piece_id and is_current;
  end if;

  -- A task that was cancelled in the meantime stays cancelled.
  if p_close or (p_status = 'approved' and r.completes_task) then
    update tasks set status = 'done', question = null where id = r.task_id and status not in ('done', 'cancelled');
    completed := found;
  end if;

  update reviews
    set status = p_status, decided_by = p_name, decided_at = now(), decision_key = p_key, decision_completed = completed
    where id = r.id;

  -- The notes still waiting, in the order the page lists them. Exactly these are marked: one being written
  -- at this moment isn't among them, and waits for the next decision.
  select array_agg(n.id), string_agg(
           '- ' || coalesce('[' || review_timecode_label(n.timecode) || '] ', '')
                || case when n.quote is null or n.quote = '' then '' else
                     'On "' || case when length(regexp_replace(n.quote, '\s+', ' ', 'g')) > 160
                                    then left(regexp_replace(n.quote, '\s+', ' ', 'g'), 157) || '...'
                                    else regexp_replace(n.quote, '\s+', ' ', 'g') end || '": ' end
                || n.body
                || case when n.author_name is distinct from p_name then ' (' || coalesce(n.author_name, 'someone') || ')' else '' end
                || case when n.still_url is null or n.still_url = '' then '' else ' frame: ' || n.still_url end,
           E'\n' order by n.timecode nulls first, n.quote_start nulls first, n.created_at)
    into picked, lines
    from task_comments n
    where n.review_id = r.id and n.review_kind = 'note' and n.bundled_at is null;
  if picked is not null then
    update task_comments set bundled_at = now() where id = any(picked);
  end if;

  v_body := concat_ws(E'\n\n',
    case when p_status = 'approved' then 'Approved "' else 'Changes requested on "' end || r.title || '"'
      -- The agent should know when the decision is about a version that no longer counts.
      || case when r.is_current then '' else
           ' (version ' || r.version || ', superseded' || coalesce(' by version ' || current_version, '') || ')' end
      || coalesce(': ' || v_message, '.'),
    'Notes:' || E'\n' || lines,
    case
      -- Changes requested, and the task ends here: the one case where the session must not do what it
      -- otherwise does with a "changes requested", so it is said whether or not the task was still open.
      when p_close and p_status = 'changes_requested' then
        'The changes are being made as separate work, not on CC-' || r.task_id || ': don''t make or publish another version here. '
        || case when completed then 'This decision closes CC-' || r.task_id || ': it''s now marked done, so there''s nothing more to do on it.'
                else 'CC-' || r.task_id || ' is already closed, so there''s nothing more to do on it.' end
      when completed and p_status = 'approved' then
        'This approval completes CC-' || r.task_id || ': it''s now marked done, so there''s nothing more to do on it.'
    end);

  -- The agent's copy of the review. Undelivered, so the inbox and the runner pick it up as they always have.
  insert into task_comments (task_id, author, author_name, body, review_id, review_kind, client_key)
    values (r.task_id, 'reviewer', p_name, v_body, r.id, 'decision', p_key);

  if completed then
    insert into task_events (task_id, kind, body, actor)
      values (r.task_id, 'status',
              'done: ' || p_name || case when p_status = 'approved' then ' approved "' else ' sent back "' end || r.title || '"'
                || case when p_status = 'approved' then '' else '; the rework is separate work' end,
              'reviewer');
  end if;

  return jsonb_build_object('replayed', false, 'status', p_status, 'decided_by', p_name, 'decided_at', now(),
                            'completed_task', completed, 'notes', coalesce(array_length(picked, 1), 0));
end $$;

revoke all on function decide_review(bigint, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function decide_review(bigint, text, text, text, text, boolean) to service_role;

-- The task is found the way every inbound event finds one (this team, this source, the sender's own id),
-- so a secret reaches no review it couldn't already reach by making the task. Not through inbound_task,
-- which locks the task: a decision takes the review's lock and then the task's, and taking them the other
-- way round here could deadlock with one made on the page at the same moment.
create function inbound_review_outcome(p_team bigint, p_source text, p_event jsonb) returns jsonb language plpgsql as $$
declare
  t tasks;
  r reviews;
  v_task_status task_status;
  v_outcome text := p_event ->> 'outcome';
  v_name text := left(coalesce(nullif(btrim(p_event ->> 'reviewer'), ''), p_source), 60);
  done jsonb;
begin
  select * into t from tasks
    where team_id = p_team and external_ref ->> 'source' = p_source and external_ref ->> 'id' = p_event ->> 'task';
  if not found then
    raise exception 'No task with id "%" from %', p_event ->> 'task', p_source using errcode = 'CC404';
  end if;

  -- The review the sender names must be one of this task's. Unnamed: the task's deliverable, which is
  -- the current version of the newest piece that completes the task, else of the newest piece.
  if p_event ? 'review' then
    select * into r from reviews where id = (p_event ->> 'review')::bigint and task_id = t.id for update;
    if not found then
      raise exception 'Task "%" has no review %', p_event ->> 'task', p_event ->> 'review' using errcode = 'CC404';
    end if;
  else
    select * into r from reviews where task_id = t.id and is_current
      order by completes_task desc, created_at desc, id desc limit 1 for update;
    if not found then
      raise exception 'Task "%" has nothing published for review', p_event ->> 'task' using errcode = 'CC422';
    end if;
  end if;

  -- Read under the review's lock, which every decision holds while it changes the task.
  select status into v_task_status from tasks where id = t.id;

  -- An approval is of the version the sender reviewed. If a newer version has been published since, that
  -- one is what counts here, and approving the old one would finish the task with the new one never
  -- looked at. The page asks a person to confirm this; a sender can't be asked, so nothing is decided and
  -- the answer says which review is current. (A rejection still closes the task: the rework is elsewhere.)
  if v_outcome = 'approved' and not r.is_current then
    return jsonb_build_object('task', t.id, 'review', r.id, 'status', r.status, 'decided_by', r.decided_by,
                              'task_status', v_task_status, 'changed', false, 'reason', 'superseded',
                              'current_review', (select id from reviews where piece_id = r.piece_id and is_current));
  end if;

  -- Nothing left to do: someone already decided this review and the task is closed, or it is already
  -- approved and that is all an approval asks for. What stands is answered and nothing is written, so
  -- an outcome that arrives after a decision on the page never decides a second time.
  if r.status <> 'open' and (v_task_status in ('done', 'cancelled') or (v_outcome = 'approved' and r.status = 'approved')) then
    return jsonb_build_object('task', t.id, 'review', r.id, 'status', r.status, 'decided_by', r.decided_by,
                              'task_status', v_task_status, 'changed', false);
  end if;

  done := decide_review(r.id, case v_outcome when 'approved' then 'approved' else 'changes_requested' end,
                        v_name, p_event ->> 'note', null, v_outcome = 'rejected');
  insert into task_events (task_id, kind, body, actor)
    values (t.id, 'note', 'review outcome from a signed event: ' || v_outcome || ' by ' || v_name, 'inbound:' || p_source);

  return jsonb_build_object('task', t.id, 'review', r.id, 'status', done ->> 'status', 'decided_by', v_name,
                            'completed_task', coalesce((done ->> 'completed_task')::boolean, false), 'changed', true);
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
    when 'review.outcome' then inbound_review_outcome(p_team, p_source, p_payload)
  end;
  if outcome is null then
    raise exception 'Unknown event type %', p_type using errcode = 'CC422';
  end if;

  update inbound_events set result = outcome where team_id = p_team and source = p_source and event_id = p_event_id;
  return outcome || jsonb_build_object('duplicate', false);
end $$;

-- As for the other inbound functions: only the Worker's service role, through apply_inbound_event.
revoke all on function inbound_review_outcome(bigint, text, jsonb) from public, anon, authenticated;

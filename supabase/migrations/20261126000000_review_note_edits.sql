-- Review notes can be changed or removed by whoever wrote them, until the review is decided; and a decision
-- is one transaction that can be asked for twice without happening twice.
--
-- Ownership. There is no sign-in on a review page, so "whoever wrote them" is a browser: the page makes a
-- random secret once and keeps it in that browser's storage, sends it with each note, and only its SHA-256
-- is kept here (owner_hash). Changing or removing a note takes the same secret again. Notes from before
-- this have no owner_hash and stay as they are.
--
-- Decisions. A review's notes reach the agent in one message, the decision's comment. decide_review does
-- all of a decision at once: completes the task if approving does that, marks the review, marks the notes
-- it hands over (bundled_at) and writes the comment that lists them. So a review is never marked without
-- its comment, a note is handed over exactly once (one that arrives while a decision is being made goes
-- with the next), and a note can't change after it was handed over: edits take the review's row lock, as
-- the decision does, and are refused once it is decided.
--
-- Everything here is added, and the Worker that was live before it keeps working: it writes neither
-- review_kind nor bundled_at, so a trigger fills them in for it.

alter table task_comments
  add column owner_hash  text,         -- SHA-256 (hex) of the writing browser's secret; null = nobody can change it
  add column client_key  text,         -- the page's id for one send (a note, or a decision), so a retry doesn't write twice
  add column edited_at   timestamptz,  -- when a note's text was last changed, for the page's "edited" mark
  add column review_kind text check (review_kind in ('note', 'decision')),  -- on a review's comments: a reviewer's note, or a decision's message
  add column bundled_at  timestamptz;  -- on a note: when a decision handed it to the agent; null = waiting for the next one

alter table reviews
  add column decision_key       text,     -- the client_key of the decision that stands, so the same request again changes nothing
  add column decision_completed boolean;  -- whether that decision completed the task (what the same request again is told)

create unique index task_comments_client_key_idx on task_comments (review_id, client_key) where client_key is not null;

-- What is already there. A note was written with delivered_at already set (the Worker's clock, just before
-- the insert); a decision's comment was written without it and delivered later by the runner, if at all,
-- and always starts the same way. Only a row that is both is called a decision; anything unsure stays a
-- note, which is how every one of these rows was treated before.
update task_comments c
  set review_kind = case
    when c.delivered_at is null then 'decision'
    when c.delivered_at > c.created_at + interval '1 second' and c.body ~ '^(Approved|Changes requested on) "' then 'decision'
    else 'note'
  end
  where c.review_id is not null;

-- Notes written before their review's latest decision went out with a decision; later ones are still waiting.
update task_comments c
  set bundled_at = r.decided_at
  from reviews r
  where r.id = c.review_id and c.review_kind = 'note' and r.decided_at is not null and c.created_at <= r.decided_at;

-- For a writer that doesn't say which kind a review's comment is (the Worker from before this): at the
-- moment of writing the two are told apart exactly, by delivered_at. Such a writer's decision has just
-- read the notes up to the review's decided_at, so those are marked as handed over.
create function task_comments_review_kind() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.delivered_at is not null then
    new.review_kind := 'note';
  else
    new.review_kind := 'decision';
    update task_comments c
      set bundled_at = r.decided_at
      from reviews r
      where r.id = new.review_id and c.review_id = r.id and c.review_kind = 'note' and c.bundled_at is null
        and r.decided_at is not null and c.created_at <= r.decided_at;
  end if;
  return new;
end $$;

create trigger task_comments_review_kind before insert on task_comments
  for each row when (new.review_id is not null and new.review_kind is null) execute function task_comments_review_kind();

-- Both answer {"error": "not_found" | "not_owner" | "decided"} rather than raising, so the Worker can say
-- which it was. Only a note can be changed: a decision's comment is never one.
create function edit_review_note(p_review bigint, p_note bigint, p_owner_hash text, p_body text) returns jsonb
language plpgsql set search_path = public as $$
declare
  r reviews;
  c task_comments;
begin
  select * into r from reviews where id = p_review for update;
  select * into c from task_comments where id = p_note and review_id = p_review and review_kind = 'note';
  if r.id is null or c.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if c.owner_hash is null or p_owner_hash is null or c.owner_hash <> p_owner_hash then
    return jsonb_build_object('error', 'not_owner');
  end if;
  if r.status <> 'open' then
    return jsonb_build_object('error', 'decided');
  end if;
  if c.body is distinct from p_body then
    update task_comments set body = p_body, edited_at = now() where id = c.id returning * into c;
  end if;
  return jsonb_build_object('note', to_jsonb(c) - 'owner_hash' - 'client_key');
end $$;

create function delete_review_note(p_review bigint, p_note bigint, p_owner_hash text) returns jsonb
language plpgsql set search_path = public as $$
declare
  r reviews;
  c task_comments;
begin
  select * into r from reviews where id = p_review for update;
  select * into c from task_comments where id = p_note and review_id = p_review and review_kind = 'note';
  if r.id is null or c.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if c.owner_hash is null or p_owner_hash is null or c.owner_hash <> p_owner_hash then
    return jsonb_build_object('error', 'not_owner');
  end if;
  if r.status <> 'open' then
    return jsonb_build_object('error', 'decided');
  end if;
  delete from task_comments where id = c.id;
  return jsonb_build_object('deleted', c.id, 'still_url', c.still_url);
end $$;

-- A note's timecode as the review page shows it, "m:ss.s", for the decision's comment: the agent is told
-- the frame in the words the reviewer saw. The page gets the stored value (a real) as JSON, reads it as a
-- double and prints Math.floor(s / 60) + ":" + (s % 60).toFixed(1), which rounds the double's exact value,
-- a tie going up. Rounding a numeric made from the same value would not agree: 0.15 is, as a double, a
-- hair under 0.15, so the page says 0:00.1. So the same double is taken here (through the real's text, as
-- JSON carries it) and the seconds are rounded on its exact value: scaled by a power of two, which is
-- exact, it is a whole number, and the rest is integer arithmetic.
--
-- The real's text depends on the session's extra_float_digits (0 here, so six significant digits), and
-- that is wanted: the page's JSON and this function are both made in PostgREST's sessions, so they read
-- the same digits whatever the setting is. Hence stable, not immutable, and no setting pinned here.
--
-- Null for a value that isn't a time (negative, NaN, infinite), and no error for any value at all: a row
-- from before timecodes were capped must not stop its review from being decided. Past 1e9 seconds only
-- that much is promised, not the page's exact digits.
create function review_timecode_label(p_timecode real) returns text
language plpgsql stable set search_path = public as $$
declare
  x float8;
  minutes float8;
  seconds float8;
  scale int;
  tenths numeric;
begin
  if p_timecode is null or p_timecode = 'NaN'::real or p_timecode = 'Infinity'::real or p_timecode < 0 then
    return null;
  end if;
  x := p_timecode::text::float8;
  if x >= 1e9 then
    return trunc(x::numeric / 60)::text || ':' || to_char(round(x::numeric - 60 * trunc(x::numeric / 60), 1), 'FM00.0');
  end if;
  minutes := floor(x / 60);
  seconds := x - 60 * minutes;
  -- The division rounded up to a whole minute: the page then shows that minute and "60.0" seconds.
  if seconds < 0 then
    seconds := x - 60 * (minutes - 1);
  end if;
  if seconds < 0.04 then
    tenths := 0;
  else
    scale := case when seconds >= 1 then 52 else 57 end;
    tenths := div((seconds * power(2::float8, scale))::bigint::numeric * 20 + (1::bigint << scale)::numeric, (1::bigint << scale)::numeric * 2);
  end if;
  return minutes::numeric::text || ':' || to_char(tenths / 10, 'FM00.0');
end $$;

-- A decision, whole. In order: the task is completed (if this is an approval of a review that completes
-- its task), the review is marked, the waiting notes are marked as handed over, and the comment listing
-- them is written. The task goes first so that webhooks say what they always have: task.status, then
-- review.decided with the task already done.
--
-- p_key is the page's id for this one request. The same key again is the same request arriving twice (its
-- answer was lost): nothing is written and the first answer is given again ("replayed"). A key that
-- belongs to an earlier decision, replaced since by someone else's, changes nothing either and says so
-- ("stale") with what stands now, so a retry can't quietly undo a later decision. No key: always a new one.
--
-- The comment's text is made here, in the format the agent has always been sent:
--   Changes requested on "Title" (version 2, superseded by version 3): message
--
--   Notes:
--   - [0:02.5] On "quoted words": the note (Someone else) frame: https://…/still/….jpg
create function decide_review(p_review bigint, p_status text, p_name text, p_message text default null, p_key text default null) returns jsonb
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
  if p_status = 'approved' and r.completes_task then
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
    case when completed then
      'This approval completes CC-' || r.task_id || ': it''s now marked done, so there''s nothing more to do on it.' end);

  -- The agent's copy of the review. Undelivered, so the inbox and the runner pick it up as they always have.
  insert into task_comments (task_id, author, author_name, body, review_id, review_kind, client_key)
    values (r.task_id, 'reviewer', p_name, v_body, r.id, 'decision', p_key);

  if completed then
    insert into task_events (task_id, kind, body, actor)
      values (r.task_id, 'status', 'done: ' || p_name || ' approved "' || r.title || '"', 'reviewer');
  end if;

  return jsonb_build_object('replayed', false, 'status', p_status, 'decided_by', p_name, 'decided_at', now(),
                            'completed_task', completed, 'notes', coalesce(array_length(picked, 1), 0));
end $$;

revoke all on function review_timecode_label(real) from public, anon, authenticated;
revoke all on function edit_review_note(bigint, bigint, text, text) from public, anon, authenticated;
revoke all on function delete_review_note(bigint, bigint, text) from public, anon, authenticated;
revoke all on function decide_review(bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function review_timecode_label(real) to service_role;
grant execute on function edit_review_note(bigint, bigint, text, text) to service_role;
grant execute on function delete_review_note(bigint, bigint, text) to service_role;
grant execute on function decide_review(bigint, text, text, text, text) to service_role;

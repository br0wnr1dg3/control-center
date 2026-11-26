-- Review notes can be changed or removed by whoever wrote them, until the review is decided.
--
-- There is no sign-in on a review page, so "whoever wrote them" is a browser: the page makes a random
-- secret once and keeps it in that browser's storage, sends it with each note, and only its SHA-256 is
-- kept here (owner_hash). Changing or removing a note takes the same secret again. Notes from before this
-- have no owner_hash and stay as they are.
--
-- A review's notes reach the agent in one message, written when the review is decided. So the rule that
-- keeps the agent's copy true is: no change once a decision is made. Both sides take the review's row
-- lock, so a change either lands before the decision reads the notes or is refused after it.

alter table task_comments
  add column owner_hash text,         -- SHA-256 (hex) of the writing browser's secret; null = nobody can change it
  add column client_key text,         -- the page's id for one send, so a retried save doesn't add the note twice
  add column edited_at  timestamptz;  -- when its text was last changed, for the page's "edited" mark

create unique index task_comments_client_key_idx on task_comments (review_id, client_key) where client_key is not null;

-- Both answer {"error": "not_found" | "not_owner" | "decided"} rather than raising, so the Worker can say
-- which it was. A decision's own comment has no owner_hash, so it can't be changed this way either.
create function edit_review_note(p_review bigint, p_note bigint, p_owner_hash text, p_body text) returns jsonb
language plpgsql as $$
declare
  r reviews;
  c task_comments;
begin
  select * into r from reviews where id = p_review for update;
  select * into c from task_comments where id = p_note and review_id = p_review and author = 'reviewer';
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
language plpgsql as $$
declare
  r reviews;
  c task_comments;
begin
  select * into r from reviews where id = p_review for update;
  select * into c from task_comments where id = p_note and review_id = p_review and author = 'reviewer';
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

-- A decision, in one transaction: the review is marked, and the notes it hands to the agent are read
-- under the same lock that edits take. Returns those notes (the ones since this version's last decision)
-- in the order the page lists them.
create function decide_review(p_review bigint, p_status text, p_name text) returns jsonb
language plpgsql as $$
declare
  r reviews;
  notes jsonb;
begin
  if p_status not in ('approved', 'changes_requested') then
    raise exception 'decide_review: unknown status %', p_status;
  end if;
  select * into r from reviews where id = p_review for update;
  if not found then
    raise exception 'review % not found', p_review;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'author_name', c.author_name, 'body', c.body, 'timecode', c.timecode, 'still_url', c.still_url, 'quote', c.quote)
           order by c.timecode nulls first, c.quote_start nulls first, c.created_at), '[]'::jsonb)
    into notes
    from task_comments c
    where c.review_id = r.id and c.delivered_at is not null
      and (r.decided_at is null or c.created_at > r.decided_at);
  update reviews set status = p_status, decided_by = p_name, decided_at = now() where id = r.id returning * into r;
  return jsonb_build_object('notes', notes, 'decided_by', r.decided_by, 'decided_at', r.decided_at);
end $$;

revoke all on function edit_review_note(bigint, bigint, text, text) from public, anon, authenticated;
revoke all on function delete_review_note(bigint, bigint, text) from public, anon, authenticated;
revoke all on function decide_review(bigint, text, text) from public, anon, authenticated;
grant execute on function edit_review_note(bigint, bigint, text, text) to service_role;
grant execute on function delete_review_note(bigint, bigint, text) to service_role;
grant execute on function decide_review(bigint, text, text) to service_role;

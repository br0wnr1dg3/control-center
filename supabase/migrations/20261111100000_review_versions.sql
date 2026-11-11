-- Review versions: reviews that are versions of the same deliverable form a chain (a "piece"), so the
-- review page can stack a cut's versions beside the player and say which one counts.
--
-- A review joins a piece when it's published: the one named with `cc-publish --version-of`, else the
-- piece of the latest review on the same task whose title is the same once the version number is
-- dropped ("Laundry Day · 9:16 · v1" and "Laundry Day · 9:16 · v2"), else a new one. The rule lives here
-- so the page, the batch grid and webhooks can't disagree about it. The newest version is the current
-- one until the publisher makes an older one current (set_current_review); the others are superseded.

alter table reviews
  add column piece_id   bigint,                        -- the id of the piece's first review
  add column version    integer,                       -- 1, 2, 3… in the order published
  add column note       text check (note is null or length(note) between 1 and 500),  -- what changed in this version
  add column is_current boolean not null default true; -- the version that counts; exactly one per piece

-- Only the version number goes ("v2", "V02"), not what follows it: "Laundry Day v1 · pace gate" and
-- "Laundry Day v1 · rule check" are two pieces, not two versions of one. Spacing and punctuation don't count.
create function review_piece_key(p_title text) returns text
language sql immutable as $$
  select regexp_replace(
    regexp_replace(lower(p_title), '(^|[^[:alnum:]])v\d+(?![[:alnum:]])', '\1', 'g'),
    '[^[:alnum:]]+', '', 'g');
$$;

-- Reviews published before this: grouped by the same rule, in the order they were published.
with numbered as (
  select id,
         first_value(id) over w as piece,
         row_number() over w as n,
         count(*) over (partition by task_id, review_piece_key(title)) as total
    from reviews
  window w as (partition by task_id, review_piece_key(title) order by created_at, id)
)
update reviews r
   set piece_id = n.piece, version = n.n, is_current = (n.n = n.total)
  from numbered n
 where n.id = r.id;

alter table reviews
  alter column piece_id set not null,
  alter column version set not null,
  add constraint reviews_version_check check (version >= 1),
  add constraint reviews_piece_version_key unique (piece_id, version);

create unique index reviews_current_idx on reviews (piece_id) where is_current;

create function reviews_assign_piece() returns trigger language plpgsql as $$
begin
  if new.piece_id is null then
    -- Two versions published on a task at the same moment mustn't both start a piece.
    perform pg_advisory_xact_lock(hashtext('review_piece'), new.task_id::int);
    select piece_id into new.piece_id
      from reviews
     where task_id = new.task_id and review_piece_key(title) = review_piece_key(new.title)
     order by created_at desc, id desc
     limit 1;
  end if;
  if new.piece_id is null then
    new.piece_id := new.id;
    new.version := 1;
  else
    -- Holding the piece's rows makes a second publish into it wait, then count this one.
    perform 1 from reviews where piece_id = new.piece_id for update;
    select coalesce(max(version), 0) + 1 into new.version from reviews where piece_id = new.piece_id;
    update reviews set is_current = false where piece_id = new.piece_id and is_current;
  end if;
  -- A new version is the publisher saying "this one now", including after an older one was made current.
  new.is_current := true;
  return new;
end $$;

create trigger reviews_piece before insert on reviews
  for each row execute function reviews_assign_piece();

-- The publisher's "this is the one that counts": for a newer cut that was withdrawn. Two statements,
-- because the one-current-per-piece index is checked row by row.
create function set_current_review(p_review bigint) returns reviews
language plpgsql as $$
declare
  r reviews;
begin
  select * into r from reviews where id = p_review;
  if not found then
    raise exception 'review % not found', p_review;
  end if;
  perform 1 from reviews where piece_id = r.piece_id for update;
  update reviews set is_current = false where piece_id = r.piece_id and is_current and id <> r.id;
  update reviews set is_current = true where id = r.id returning * into r;
  return r;
end $$;

revoke all on function set_current_review(bigint) from public, anon, authenticated;
grant execute on function set_current_review(bigint) to service_role;

-- review.published and review.decided say which version they're about. Fields are only added:
-- version (this one's number), versions (how many the piece has) and current (false = superseded).
create or replace function webhooks_on_review() returns trigger language plpgsql as $$
declare
  t tasks;
begin
  select * into t from tasks where id = new.task_id;
  perform enqueue_webhook_event(
    case when tg_op = 'INSERT' then 'review.published' else 'review.decided' end,
    t,
    jsonb_build_object('review', jsonb_build_object(
      'id', new.id,
      'title', new.title,
      'token', new.token,
      'decision', case when tg_op = 'INSERT' then null else new.status end,
      'decided_by', new.decided_by,
      'decided_at', new.decided_at,
      'version', new.version,
      'versions', (select count(*) from reviews where piece_id = new.piece_id),
      'current', new.is_current
    ))
  );
  return null;
end $$;

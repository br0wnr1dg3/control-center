-- Review versions: reviews that are versions of the same deliverable form a chain (a "piece"), so the
-- review page can stack a cut's versions beside the player and say which one counts.
--
-- A review joins a piece when it's published: the one named with `cc-publish --version-of`, else the
-- piece of the latest review on the same task whose title is the same once a version number standing as
-- its own word is dropped ("Laundry Day · 9:16 · v1" and "Laundry Day · 9:16 · v2"), else a new one. The rule lives here
-- so the page, the batch grid and webhooks can't disagree about it. The newest version is the current
-- one until the publisher makes an older one current (set_current_review); the others are superseded.

alter table reviews
  add column piece_id   bigint,                        -- the id of the piece's first review
  add column version    integer,                       -- 1, 2, 3… in the order published
  add column note       text check (note is null or length(note) between 1 and 500),  -- what changed in this version
  add column is_current boolean not null default true; -- the version that counts; exactly one per piece

-- Only the version number goes ("v2", "V02"), not what follows it: "Laundry Day v1 · pace gate" and
-- "Laundry Day v1 · rule check" are two pieces, not two versions of one. Spacing and punctuation don't count.
--
-- A version number is only a re-cut marker as a word of its own in a title a person wrote. In a file name
-- it is part of what the deliverable is: "FLX001_Concept-Name_IT01-V01_1080x1920_AI_EN-US_45sec.mp4" and
-- "…_IT01-V02_…" are two deliverables (a new hook), and chaining them would mark an approved one
-- superseded. So nothing is dropped from a title that has no spaces or ends in a file extension, nor a
-- number joined to its neighbours by "_" or "-". A missed chain costs a `--version-of`; a wrong one hides a cut.
--
-- Null when nothing is left to compare ("🎬", "!!"): such a title matches no other, so it starts its own piece.
create function review_piece_key(p_title text) returns text
language sql immutable as $$
  select nullif(regexp_replace(
    case
      when btrim(p_title) !~ '\s' or btrim(p_title) ~* '\.[a-z][a-z0-9]{1,4}$' then lower(p_title)
      else regexp_replace(lower(p_title), '(^|[^[:alnum:]_-])v\d+(?![[:alnum:]_-])', '\1', 'g')
    end,
    '[^[:alnum:]]+', '', 'g'), '');
$$;

-- Reviews published before this: grouped by the same rule, in the order they were published. Nothing
-- recorded which version counted, so: the newest, unless an earlier one was approved and nothing
-- published after it has been decided. That approval stands until someone decides a later version;
-- an undecided later upload doesn't demote it (`cc-publish --make-current` corrects a wrong guess).
with grouped as (
  select id, status,
         first_value(id) over w as piece,
         row_number() over w as n
    from reviews
  window w as (partition by task_id, coalesce(review_piece_key(title), '#' || id) order by created_at, id)
), ranked as (
  select id, piece, n,
         max(n) over p as newest,
         max(n) filter (where status = 'approved') over p as approved,
         max(n) filter (where status <> 'open') over p as decided
    from grouped
  window p as (partition by piece)
)
update reviews r
   set piece_id = k.piece, version = k.n,
       is_current = (k.n = case when k.approved = k.decided then k.approved else k.newest end)
  from ranked k
 where k.id = r.id;

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
    -- A null key equals nothing, so a title with nothing to compare never joins another's piece.
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

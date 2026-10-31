-- Reviews: an agent publishes a render (or any output file) to R2 and gets a private link with a
-- frame-accurate review page. Chris and the team comment on frames there, then approve or request
-- changes; the decision is posted to the task as one comment, which the runner types into the
-- waiting agent session.

create table reviews (
  id           bigint generated always as identity primary key,
  token        text not null unique,          -- the secret in /r/<token>
  task_id      bigint not null references tasks(id) on delete cascade,
  title        text not null check (length(title) between 1 and 200),
  object_key   text not null,                 -- R2 key
  content_type text,
  size         bigint,
  status       text not null default 'open' check (status in ('open', 'approved', 'changes_requested')),
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index reviews_task_idx on reviews (task_id, created_at);

alter table task_comments drop constraint task_comments_author_check;
alter table task_comments add constraint task_comments_author_check
  check (author in ('me', 'claude', 'agent', 'reviewer'));

alter table task_comments
  add column author_name text,               -- who, for 'reviewer' comments from the review page
  add column review_id   bigint references reviews(id) on delete set null,
  add column timecode    real,               -- seconds into the video the note is about
  add column still_url   text;               -- the commented frame, for the agent to look at

-- Review notes are stored already delivered (the agent gets them together in the decision), and stay
-- out of the inbox; the approve / request-changes decision is what lands there.
create or replace function notify_on_comment() returns trigger language plpgsql as $$
begin
  if new.review_id is not null and new.delivered_at is not null then
    return new;
  end if;
  -- Skip a comment that just restates the open question already in the inbox (ask_human posts both).
  if new.author <> 'me' and not exists (
    select 1 from notifications
    where task_id = new.task_id and kind = 'question' and body = new.body and read_at is null
  ) then
    insert into notifications (task_id, kind, body) values (new.task_id, 'comment', new.body);
  end if;
  return new;
end $$;

alter table reviews enable row level security;
alter publication supabase_realtime add table reviews;

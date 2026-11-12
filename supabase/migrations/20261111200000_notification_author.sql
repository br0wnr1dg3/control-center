-- Comment notifications say who wrote the comment, so the inbox can leave out what agents and Claude post
-- as they work (progress notes, logs) and keep what people say. Null for everything that isn't a comment
-- (and for system notes such as a paused webhook), which always shows.
alter table notifications add column author text;

update notifications n set author = c.author
  from task_comments c
  where n.kind = 'comment' and c.task_id = n.task_id and c.body = n.body;

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
    insert into notifications (task_id, kind, body, author) values (new.task_id, 'comment', new.body, new.author);
  end if;
  return new;
end $$;

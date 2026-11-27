-- review.published and review.decided say what kind of review it is. An agent often publishes several
-- on one task: the deliverable (cc-publish --completes-task) and notes that go with it. A receiver that
-- acts on the deliverable (files it, moves its own work on) couldn't tell them apart, so it treated a
-- note as another deliverable. Fields are only added:
--   completes_task  true for the review whose approval finishes the task
--   content_type    what was uploaded ("video/mp4", "text/markdown"), as the publisher declared it
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
      'current', new.is_current,
      'current_id', (select id from reviews where piece_id = new.piece_id and is_current),
      'completes_task', new.completes_task,
      'content_type', new.content_type
    ))
  );
  return null;
end $$;

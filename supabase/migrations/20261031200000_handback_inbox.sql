-- An agent handing a task back to Chris (kind agent -> human, still open) lands in his inbox as a
-- hand-off, with the agent's last progress note saying what's left.
create function notify_on_handback() returns trigger language plpgsql as $$
declare
  note text;
begin
  if old.kind = 'agent' and new.kind = 'human' and new.status not in ('done', 'cancelled') then
    select body into note from task_events
      where task_id = new.id and kind = 'agent_log' order by created_at desc limit 1;
    insert into notifications (task_id, kind, body)
      values (new.id, 'handoff', coalesce(note, new.title));
  end if;
  return new;
end $$;

create trigger tasks_notify_handback after update of kind on tasks
  for each row execute function notify_on_handback();

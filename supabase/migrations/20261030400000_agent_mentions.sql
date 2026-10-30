-- "@agent" (or "@claude") in one of Chris's comments hands the task to an agent, like Linear's
-- agent mentions: it becomes a ready agent task and the runner starts a session with the comment
-- in its prompt. A task already being worked on just gets the comment typed into its session.
create function hand_to_agent_on_mention() returns trigger language plpgsql as $$
begin
  if new.author = 'me' and new.body ~* '(^|[^[:alnum:]_])@(agent|claude)([^[:alnum:]_]|$)' then
    update tasks
      set kind = 'agent', status = 'ready', question = null
      where id = new.task_id and status <> 'in_progress';
    if found then
      insert into task_events (task_id, kind, body, actor)
        values (new.task_id, 'status', 'handed to an agent (@agent mention)', 'me');
    end if;
  end if;
  return new;
end $$;

create trigger task_comments_agent_mention after insert on task_comments
  for each row execute function hand_to_agent_on_mention();

-- Choices that come with an agent's question (from ask_human's options, or Claude's multiple-choice
-- picker caught by the session hook), so they can be answered on the board:
-- [{question, header, multiSelect, options: [{label, description}]}]
alter table tasks add column question_options jsonb;

-- Leaving needs_you (answered in the session, on the board or anywhere) clears the open question.
create function clear_answered_question() returns trigger language plpgsql as $$
begin
  if old.status = 'needs_you' and new.status <> 'needs_you' then
    new.question_options := null;
  end if;
  return new;
end $$;

create trigger tasks_clear_question before update of status on tasks
  for each row execute function clear_answered_question();

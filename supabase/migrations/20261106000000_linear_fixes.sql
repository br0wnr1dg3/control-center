-- Two fixes to the Linear sync after its first real run.

-- A task with no external_ref made this null rather than false, and the triggers' `if not ...` treats
-- null as "carry on", so every task's status changes were queued for a Linear issue it doesn't have.
create or replace function linear_reported(t tasks) returns boolean language sql immutable as $$
  select coalesce(t.external_ref ? 'linear_id', false) and not coalesce((t.external_ref ->> 'mirror')::boolean, false)
$$;

-- Those queued updates can never be sent; left in place they retry forever and end up in the inbox.
delete from linear_outbox o
using tasks t
where t.id = o.task_id and o.sent_at is null and not linear_reported(t);

-- The status an issue moves to when an agent starts. Empty means one named In Progress, else the first
-- started status that isn't a blocked or waiting one (some teams order Blocked first).
alter table teams add column linear_started_state text;

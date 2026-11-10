-- A task whose latest published output is still undecided is waiting on a reviewer, not being worked
-- on. Its status stays as it is (the session is alive and picks the decision up), so this is derived,
-- like waiting_on: one definition for the runner, which stops counting such a session against
-- CC_MAX_CONCURRENT once it's idle, and for the board and tools, which say "Awaiting review".
--
-- Only the latest review counts: a new version supersedes the one before it, and a decision on it
-- (approved or changes requested) puts the session back to work.
-- PostgREST: select=*,awaiting_review and awaiting_review=is.true (it isn't part of select=*).
create function awaiting_review(task tasks) returns boolean language sql stable as $$
  select coalesce(
    (select r.status = 'open' from reviews r where r.task_id = task.id order by r.created_at desc, r.id desc limit 1),
    false);
$$;

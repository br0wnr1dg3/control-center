-- Who takes an agent's PR from open to merged, per project:
--   owner: the agent hands the owner a "Review and merge PR #N" human task (the default).
--   agent: the agent queues a "Review and merge PR #N" agent task (label pr-review); the runner starts it
--          as a fresh session that runs /code-review, fixes what it finds and merges once CI is green,
--          asking the owner only when a finding needs their call.
alter table projects add column pr_review text not null default 'owner'
  check (pr_review in ('owner', 'agent'));

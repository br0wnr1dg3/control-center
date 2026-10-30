-- Git worktree an agent session works in (<repo>/.claude/worktrees/cc-<id>), so the runner can
-- resume in it and remove it once the work is merged.
alter table tasks add column worktree text;
create index tasks_worktree_idx on tasks (status) where worktree is not null;

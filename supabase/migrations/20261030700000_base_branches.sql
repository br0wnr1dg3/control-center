-- The branch agent worktrees start from and PRs target: per repo, else the team default, else the
-- repo's GitHub default. The runner fetches it fresh, so the main checkout is never touched.
alter table teams add column base_branch text;
alter table repos add column base_branch text;

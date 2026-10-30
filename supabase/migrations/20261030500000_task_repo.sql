-- Which repo a task's agent session starts in: a repo name (from the team or project repos, or a
-- git folder under the team's working folder) or a path. Empty = the runner works it out.
alter table tasks add column repo text;

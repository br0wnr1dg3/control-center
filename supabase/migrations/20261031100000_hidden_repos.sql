-- Hide a repo from matching and from the lists Claude and the email triage pick from (e.g. stale
-- checkouts of a repo that has a main copy). The runner's sync never touches it.
alter table repos add column hidden boolean not null default false;

-- Hide a repo from matching and from the lists Claude and the email triage pick from (e.g. stale
-- checkouts of a repo that has a main copy). The runner's sync never touches it.
alter table repos add column hidden boolean not null default false;

update repos set hidden = true where path in (
  '~/Developer/projects/flixr/flixr-broll-improvement',
  '~/Developer/projects/flixr/flixr-concept-reviews',
  '~/Developer/projects/flixr/flixr-evidence-planning-review',
  '~/Developer/projects/flixr/flixr-mac-setup',
  '~/Developer/projects/flixr/flixr-playable-builder',
  '~/Developer/projects/flixr/flixr-shot-planning-review',
  '~/Developer/projects/flixr/flixr-team-env'
);

-- Repos found on the runner's Mac: every git folder under a team's working folder. The runner keeps
-- this in sync so the cloud side (connector, email triage) can pick a task's repo at creation.
-- Aliases are the names people actually use ("CareerSuite") and are edited in team settings.
create table repos (
  id          bigint generated always as identity primary key,
  team_id     bigint not null references teams(id) on delete cascade,
  name        text not null,                 -- folder name, what tasks.repo refers to
  path        text not null unique,          -- ~/Developer/projects/<team>/<name>
  github_url  text,
  description text,                          -- from package.json or the README
  aliases     text[] not null default '{}',
  seen_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index repos_team_idx on repos (team_id, name);

alter table repos enable row level security;
alter publication supabase_realtime add table repos;

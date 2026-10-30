-- Teams (companies and Personal) and projects with specs agents can read: a briefing,
-- GitHub repos and a local working folder. Tasks keep `project` as text; a project
-- belongs to at most one team and a task's team follows its project.

create table teams (
  id          bigint generated always as identity primary key,
  key         text not null unique check (key ~ '^[a-z0-9][a-z0-9-]*$'),  -- slug for tools: "flixr"
  name        text not null check (length(name) between 1 and 80),
  kind        text not null default 'company' check (kind in ('company', 'personal')),
  color       text,                        -- hex, e.g. #F97316
  context     text,                        -- markdown briefing given to agents
  repos       jsonb not null default '[]', -- [{name, url, path}]
  workdir     text,                        -- local folder for this team's work
  sort_order  double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table projects (
  id          bigint generated always as identity primary key,
  name        text not null check (length(name) between 1 and 120),
  team_id     bigint references teams(id) on delete set null,
  description text,                        -- markdown spec given to agents
  repos       jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index projects_name_idx on projects (lower(name));

alter table tasks add column team_id bigint references teams(id) on delete set null;
create index tasks_team_idx on tasks (team_id);

create function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger teams_touch before update on teams for each row execute function touch_updated_at();
create trigger projects_touch before update on projects for each row execute function touch_updated_at();

-- Keep tasks.project and projects in step: register new project names, inherit the
-- project's team, or claim an unassigned project for the task's team.
create function sync_task_project() returns trigger language plpgsql as $$
declare
  p projects;
begin
  if new.project is null then
    return new;
  end if;
  new.project := btrim(new.project);
  select * into p from projects where lower(name) = lower(new.project);
  if not found then
    insert into projects (name, team_id) values (new.project, new.team_id);
  elsif p.team_id is not null and (tg_op = 'INSERT' or new.project is distinct from old.project or new.team_id is null) then
    new.team_id := p.team_id;
  elsif p.team_id is null and new.team_id is not null then
    update projects set team_id = new.team_id where id = p.id;
  end if;
  return new;
end $$;

create trigger tasks_sync_project before insert or update of project, team_id on tasks
  for each row execute function sync_task_project();

-- Moving a project to another team moves its tasks.
create function cascade_project_team() returns trigger language plpgsql as $$
begin
  update tasks set team_id = new.team_id
  where lower(project) = lower(new.name) and team_id is distinct from new.team_id;
  if new.name is distinct from old.name then
    update tasks set project = new.name where lower(project) = lower(old.name);
  end if;
  return new;
end $$;

create trigger projects_cascade after update of team_id, name on projects
  for each row execute function cascade_project_team();

alter table teams enable row level security;
alter table projects enable row level security;
alter publication supabase_realtime add table teams, projects;

-- Starting teams; rename or add more in the app.
insert into teams (key, name, kind, color, sort_order) values
  ('personal', 'Personal', 'personal', '#22C55E', 0),
  ('flixr', 'Flixr', 'company', '#F97316', 1);

insert into projects (name)
  select distinct project from tasks where project is not null
  on conflict do nothing;

update projects set team_id = (select id from teams where key = 'flixr') where lower(name) = 'content';

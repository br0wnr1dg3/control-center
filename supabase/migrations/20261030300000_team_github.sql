-- Each team's GitHub org (or user), shown in settings and given to agents.
alter table teams add column github text;

insert into teams (key, name, kind, color, github, workdir, sort_order) values
  ('flixr', 'Flixr', 'company', '#F97316', 'https://github.com/flixr-studios', '~/Developer/projects/flixr', 1),
  ('cgc', 'Challenger Gray', 'company', '#22A06B', 'https://github.com/Challenger-Gray-Christmas', '~/Developer/projects/challenger-gray', 2),
  ('residence', 'The Residence', 'company', '#8B5CF6', null, '~/Developer/projects/the-residence', 3)
on conflict (key) do update set
  github = coalesce(teams.github, excluded.github),
  workdir = coalesce(teams.workdir, excluded.workdir);

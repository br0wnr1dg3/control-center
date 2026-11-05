-- Example personal setup. Copy to seed.local.sql (git-ignored), edit, and run it once against your
-- database (Supabase SQL editor, or: psql "$DATABASE_URL" -f supabase/seed.local.sql).
-- Everything here can also be set in the app's team settings; this just makes a fresh database
-- come up configured. Repos are discovered by the runner; settings on them apply once it has synced.

insert into teams (key, name, kind, color, github, workdir, base_branch, sort_order) values
  ('personal', 'Personal', 'personal', '#22C55E', null, null, null, 0),
  ('acme', 'Acme', 'company', '#F97316', 'https://github.com/acme', '~/Developer/projects/acme', 'staging', 1)
on conflict (key) do update set
  name = excluded.name, github = excluded.github, workdir = excluded.workdir, base_branch = excluded.base_branch;

-- A project pinned to one repo: its agent tasks always start there, in a fresh worktree.
insert into projects (name, team_id, description, repos)
  select 'Video production', id,
         'Ads and videos made with the creative toolkit. Agents use its skills and publish cuts for review.',
         '[{"name": "creative-toolkit", "url": "https://github.com/acme/creative-toolkit", "path": "~/Developer/projects/acme/creative-toolkit"}]'
  from teams where key = 'acme'
on conflict do nothing;

-- Per-repo settings (after the runner's first sync): nicknames, a base branch, hiding stale copies.
update repos set aliases = '{creative toolkit,video edit}' where path = '~/Developer/projects/acme/creative-toolkit';
update repos set base_branch = 'main' where path = '~/Developer/projects/acme/website';
update repos set hidden = true where path = '~/Developer/projects/acme/old-copy-of-something';

-- Linear: which Linear teams belong to a team (see README for setting up the app).
update teams set linear_teams = '{ENG}', linear_approvers = '{you@example.com}' where key = 'acme';

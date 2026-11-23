-- Review lists: one private link per team (/reviews/<team>/<token>) to a table of every review on that
-- team's tasks. A review link opens one review and a batch link the reviews gathered in it; neither says
-- anything about the rest, so the list has a secret of its own, kept here the way a batch's is.
--
-- The token is made in the database (two random UUIDs, 244 random bits), so every team has a link without
-- any page or tool having to make one: the Worker only ever reads this table. To replace a team's link:
--   update review_lists set token = default where team_id = <id>;

create table review_lists (
  team_id    bigint primary key references teams(id) on delete cascade,
  token      text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),  -- the secret in the link
  created_at timestamptz not null default now()
);

alter table review_lists enable row level security;

insert into review_lists (team_id) select id from teams;

create function teams_add_review_list() returns trigger language plpgsql as $$
begin
  insert into review_lists (team_id) values (new.id) on conflict do nothing;
  return null;
end $$;

create trigger teams_review_list after insert on teams
  for each row execute function teams_add_review_list();

-- Outbound webhooks: apps that create and follow work subscribe to a team, or one of its projects.
-- Triggers write one delivery per (event, matching webhook) in the same transaction as the change, so an
-- event can't be lost and one webhook's failures don't touch another's. The Worker's cron sends them
-- (mcp/src/webhooks.ts); deciding what to send, retry and pause on is all here.

create extension if not exists supabase_vault;

create table webhooks (
  id                 bigint generated always as identity primary key,
  team_id            bigint not null references teams(id) on delete cascade,
  project_id         bigint references projects(id) on delete cascade,  -- null = the whole team
  -- https, so the signed body isn't sent in the clear; plain http only reaches this machine, for testing.
  -- No credentials in the URL: it's shown in the app and in tool output.
  url                text not null check (
    length(url) <= 2000 and url ~ '^(https://[^\s/?#@]+|http://(localhost|127\.0\.0\.1)(:[0-9]+)?)([/?#]\S*)?$'
  ),
  events             text[] not null default array['task.created', 'task.status', 'review.published', 'review.decided'] check (
    cardinality(events) > 0
    and events <@ array['task.created', 'task.status', 'review.published', 'review.decided', 'comment.added']
  ),
  scope              text not null default 'external' check (scope in ('external', 'all')),  -- external = only tasks with an external_ref
  active             boolean not null default true,
  paused_reason      text,
  secret_id          uuid not null,  -- in Vault; only create_webhook and claim_webhook_deliveries touch it
  last_delivery_at   timestamptz,
  last_delivery_ok   boolean,
  last_delivery_http int,
  last_delivery_error text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index webhooks_team_idx on webhooks (team_id);
create trigger webhooks_touch before update on webhooks for each row execute function touch_updated_at();

-- The outbox. payload is a snapshot taken when the event happened, so a retry says the same thing.
-- A deleted task takes its unsent deliveries with it: every pausing delivery has a task to notify on.
create table webhook_deliveries (
  id              bigint generated always as identity primary key,
  webhook_id      bigint not null references webhooks(id) on delete cascade,
  event_id        text not null,  -- the same for every webhook and every retry of one event
  event_type      text not null,
  task_id         bigint references tasks(id) on delete cascade,  -- null only for pings
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts        int not null default 0,
  max_attempts    int not null default 8,  -- with the Worker's 60s base: about 2 hours of trying
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,             -- claimed by a sender until then; expires if the sender dies
  last_http       int,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (webhook_id, event_id)
);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_prune_idx on webhook_deliveries (created_at);
create index webhook_deliveries_task_idx on webhook_deliveries (task_id);

alter table webhooks enable row level security;
alter table webhook_deliveries enable row level security;

-- What the tools and the app read: everything except where the secret is, plus what's waiting to go.
create view webhook_overview with (security_invoker = on) as
  select w.id, w.team_id, t.key as team_key, w.project_id, p.name as project, w.url, w.events, w.scope,
         w.active, w.paused_reason, w.last_delivery_at, w.last_delivery_ok, w.last_delivery_http,
         w.last_delivery_error, w.created_at,
         (select count(*) from webhook_deliveries d where d.webhook_id = w.id and d.status = 'pending')::int as pending
  from webhooks w
  join teams t on t.id = w.team_id
  left join projects p on p.id = w.project_id;

-- ---------- Events ----------

create function webhook_task_json(p_task tasks) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', p_task.id,
    'key', 'CC-' || p_task.id,
    'title', p_task.title,
    'status', p_task.status,
    'kind', p_task.kind,
    'parent_id', p_task.parent_id,
    'project', p_task.project,
    'team', (select jsonb_build_object('id', t.id, 'key', t.key, 'name', t.name) from teams t where t.id = p_task.team_id),
    'external_ref', p_task.external_ref,
    'requested_by', p_task.requested_by
  )
$$;

-- p_extra holds what's specific to the event. Tasks name their project by text; the sync trigger keeps
-- that matching projects.name, whatever the case.
create function enqueue_webhook_event(p_type text, p_task tasks, p_extra jsonb default '{}') returns void language plpgsql as $$
declare
  event_id text := 'evt_' || replace(gen_random_uuid()::text, '-', '');
  body jsonb;
begin
  if p_task.team_id is null
     or not exists (select 1 from webhooks where team_id = p_task.team_id and p_type = any(events)) then
    return;
  end if;
  body := jsonb_build_object('id', event_id, 'type', p_type, 'created_at', clock_timestamp(), 'task', webhook_task_json(p_task)) || p_extra;
  -- Paused webhooks still queue: they get what they missed when resumed, so an outage loses nothing.
  insert into webhook_deliveries (webhook_id, event_id, event_type, task_id, payload)
    select w.id, event_id, p_type, p_task.id, body
    from webhooks w
    where w.team_id = p_task.team_id
      and p_type = any(w.events)
      and (w.scope = 'all' or p_task.external_ref is not null)
      and (w.project_id is null or exists (
        select 1 from projects p where p.id = w.project_id and lower(p.name) = lower(p_task.project)
      ));
end $$;

create function webhooks_on_task() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform enqueue_webhook_event('task.created', new);
  else
    perform enqueue_webhook_event('task.status', new, jsonb_build_object('previous_status', old.status));
  end if;
  return null;
end $$;

create trigger tasks_webhook_created after insert on tasks
  for each row execute function webhooks_on_task();
create trigger tasks_webhook_status after update of status on tasks
  for each row when (old.status is distinct from new.status) execute function webhooks_on_task();

-- The token is the review's private link; the Worker turns it into review.url when sending, since only
-- it knows its public address. Re-deciding a review is a new decision, so this watches decided_at.
create function webhooks_on_review() returns trigger language plpgsql as $$
declare
  t tasks;
begin
  select * into t from tasks where id = new.task_id;
  perform enqueue_webhook_event(
    case when tg_op = 'INSERT' then 'review.published' else 'review.decided' end,
    t,
    jsonb_build_object('review', jsonb_build_object(
      'id', new.id,
      'title', new.title,
      'token', new.token,
      'decision', case when tg_op = 'INSERT' then null else new.status end,
      'decided_by', new.decided_by,
      'decided_at', new.decided_at
    ))
  );
  return null;
end $$;

create trigger reviews_webhook_published after insert on reviews
  for each row execute function webhooks_on_review();
create trigger reviews_webhook_decided after update of decided_at on reviews
  for each row when (old.decided_at is distinct from new.decided_at and new.status <> 'open') execute function webhooks_on_review();

-- A review's individual notes are quiet here for the same reason they stay out of the inbox: the decision
-- that follows carries them all.
create function webhooks_on_comment() returns trigger language plpgsql as $$
declare
  t tasks;
begin
  if new.review_id is not null and new.delivered_at is not null then
    return null;
  end if;
  select * into t from tasks where id = new.task_id;
  perform enqueue_webhook_event('comment.added', t, jsonb_build_object('comment', jsonb_build_object(
    'id', new.id,
    'author', new.author,
    'author_name', new.author_name,
    'body', new.body,
    'created_at', new.created_at
  )));
  return null;
end $$;

create trigger task_comments_webhook after insert on task_comments
  for each row execute function webhooks_on_comment();

-- A project-scoped webhook follows its project to another team, as the project's tasks do.
create function webhooks_follow_project() returns trigger language plpgsql as $$
begin
  if new.team_id is not null then
    update webhooks set team_id = new.team_id where project_id = new.id;
  end if;
  return null;
end $$;

create trigger projects_webhooks_follow after update of team_id on projects
  for each row when (old.team_id is distinct from new.team_id) execute function webhooks_follow_project();

-- ---------- Secrets ----------

-- The one place a secret is ever returned to a person: right after it's made.
create function create_webhook(p_team bigint, p_url text, p_project bigint default null, p_events text[] default null, p_scope text default 'external')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  secret text := 'whsec_' || encode(extensions.gen_random_bytes(32), 'hex');
  new_id bigint;
begin
  if p_project is not null and not exists (select 1 from public.projects where id = p_project and team_id = p_team) then
    raise exception 'That project isn''t in this team' using errcode = 'CC422';
  end if;
  insert into public.webhooks (team_id, project_id, url, events, scope, secret_id)
    values (
      p_team, p_project, p_url,
      coalesce(p_events, array['task.created', 'task.status', 'review.published', 'review.decided']),
      p_scope,
      vault.create_secret(secret, 'webhook_' || gen_random_uuid(), 'Control Center webhook signing secret')
    )
    returning id into new_id;
  return (select to_jsonb(o) from public.webhook_overview o where o.id = new_id) || jsonb_build_object('secret', secret);
end $$;

-- Also covers a team or project being deleted, which removes its webhooks by cascade.
create function webhooks_forget_secret() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return null;
end $$;

create trigger webhooks_forget_secret after delete on webhooks
  for each row execute function webhooks_forget_secret();

-- ---------- Management ----------

-- Resuming sends everything that didn't get through, including what failed before the pause.
create function set_webhook_active(p_webhook bigint, p_active boolean, p_reason text default null) returns void language plpgsql as $$
begin
  if p_active then
    update webhooks set active = true, paused_reason = null where id = p_webhook;
    if not found then
      raise exception 'No webhook %', p_webhook using errcode = 'CC404';
    end if;
    update webhook_deliveries
      set status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = null
      where webhook_id = p_webhook and status <> 'delivered' and event_type <> 'ping';
  else
    update webhooks set active = false, paused_reason = coalesce(p_reason, paused_reason, 'Paused by hand') where id = p_webhook;
    if not found then
      raise exception 'No webhook %', p_webhook using errcode = 'CC404';
    end if;
  end if;
end $$;

-- A ping goes out once, even to a paused webhook (to check it before resuming), and its failure doesn't
-- count against the webhook: it's the owner asking, and the answer shows as the last delivery.
create function test_webhook(p_webhook bigint) returns bigint language plpgsql as $$
declare
  w webhook_overview;
  event_id text := 'evt_' || replace(gen_random_uuid()::text, '-', '');
  delivery bigint;
begin
  select * into w from webhook_overview where id = p_webhook;
  if not found then
    raise exception 'No webhook %', p_webhook using errcode = 'CC404';
  end if;
  insert into webhook_deliveries (webhook_id, event_id, event_type, payload, max_attempts)
    values (p_webhook, event_id, 'ping', jsonb_build_object(
      'id', event_id,
      'type', 'ping',
      'created_at', clock_timestamp(),
      'webhook', jsonb_build_object('id', w.id, 'team', w.team_key, 'project', w.project)
    ), 1)
    returning id into delivery;
  return delivery;
end $$;

-- ---------- Sending ----------

-- Oldest first, one from each webhook in turn, so a backlog on one can't take another's place in the batch.
-- The status and lock are checked in the locking query itself: Postgres re-evaluates those against the
-- latest row, so a run that arrives just as another commits its claim skips the row instead of re-sending it.
create function claim_webhook_deliveries(p_limit int default 20, p_delivery bigint default null)
returns table (delivery_id bigint, webhook_id bigint, url text, secret text, event_id text, event_type text, attempts int, payload jsonb)
language sql security definer set search_path = '' as $$
  with candidates as (
    select d.id, row_number() over (partition by d.webhook_id order by d.created_at, d.id) as turn
    from public.webhook_deliveries d
    join public.webhooks w on w.id = d.webhook_id
    where d.status = 'pending'
      and d.next_attempt_at <= now()
      and (d.locked_until is null or d.locked_until < now())
      and (w.active or d.event_type = 'ping')
      and (p_delivery is null or d.id = p_delivery)
  ),
  picked as (
    select d.id
    from public.webhook_deliveries d
    join candidates c on c.id = d.id
    where d.status = 'pending' and (d.locked_until is null or d.locked_until < now())
    order by c.turn, c.id
    limit p_limit
    for update of d skip locked
  ),
  claimed as (
    update public.webhook_deliveries d
      set attempts = d.attempts + 1, locked_until = now() + interval '5 minutes'
      from picked
      where d.id = picked.id
      returning d.*
  )
  select c.id, c.webhook_id, w.url, s.decrypted_secret, c.event_id, c.event_type, c.attempts, c.payload
  from claimed c
  join public.webhooks w on w.id = c.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_id
  order by c.created_at, c.id
$$;

-- p_http 2xx with no p_error is success. Anything else waits base * 2^(attempts - 1) seconds, and a delivery
-- out of attempts pauses its webhook and tells the owner, on the task the event was about.
create function finish_webhook_delivery(p_delivery bigint, p_http int, p_error text, p_retry_base_seconds int default 60)
returns void language plpgsql as $$
declare
  d webhook_deliveries;
  ok boolean := p_error is null and p_http between 200 and 299;
  problem text := coalesce(p_error, 'HTTP ' || p_http);
  target text;
begin
  select * into d from webhook_deliveries where id = p_delivery for update;
  if not found then
    return;  -- deleted with its webhook while it was being sent
  end if;

  update webhooks set
      last_delivery_at = now(),
      last_delivery_ok = ok,
      last_delivery_http = p_http,
      last_delivery_error = case when ok then null else problem end
    where id = d.webhook_id;

  if ok then
    update webhook_deliveries
      set status = 'delivered', delivered_at = now(), locked_until = null, last_http = p_http, last_error = null
      where id = d.id;
  elsif d.attempts < d.max_attempts then
    update webhook_deliveries
      set next_attempt_at = now() + make_interval(secs => p_retry_base_seconds * power(2, d.attempts - 1)),
          locked_until = null, last_http = p_http, last_error = problem
      where id = d.id;
  else
    update webhook_deliveries set status = 'failed', locked_until = null, last_http = p_http, last_error = problem where id = d.id;
    if d.event_type <> 'ping' then
      update webhooks
        set active = false, paused_reason = format('%s failed attempts to deliver %s (%s)', d.attempts, d.event_type, problem)
        where id = d.webhook_id and active
        returning substring(url from '^https?://([^/?#]+)') into target;
      if found then  -- the first failure to pause it says so; the rest of a batch stays quiet
        insert into notifications (task_id, kind, body) values (d.task_id, 'comment', format(
          'Webhook to %s paused after %s failed attempts to deliver %s (%s). Events keep queueing; resuming it sends them, from the team''s settings or resume_webhook.',
          target, d.attempts, d.event_type, problem
        ));
      end if;
    end if;
  end if;
end $$;

create function prune_webhook_deliveries(p_days int default 30) returns int language plpgsql as $$
declare
  removed int;
begin
  delete from webhook_deliveries where created_at < now() - make_interval(days => p_days);
  get diagnostics removed = row_count;
  return removed;
end $$;

-- As with inbound events: Supabase's defaults would let anon and authenticated call these through PostgREST.
revoke all on webhook_overview from anon, authenticated;
revoke all on function webhook_task_json(tasks) from public, anon, authenticated;
revoke all on function enqueue_webhook_event(text, tasks, jsonb) from public, anon, authenticated;
revoke all on function create_webhook(bigint, text, bigint, text[], text) from public, anon, authenticated;
revoke all on function set_webhook_active(bigint, boolean, text) from public, anon, authenticated;
revoke all on function test_webhook(bigint) from public, anon, authenticated;
revoke all on function claim_webhook_deliveries(int, bigint) from public, anon, authenticated;
revoke all on function finish_webhook_delivery(bigint, int, text, int) from public, anon, authenticated;
revoke all on function prune_webhook_deliveries(int) from public, anon, authenticated;
grant execute on function webhook_task_json(tasks) to service_role;
grant execute on function enqueue_webhook_event(text, tasks, jsonb) to service_role;
grant execute on function create_webhook(bigint, text, bigint, text[], text) to service_role;
grant execute on function set_webhook_active(bigint, boolean, text) to service_role;
grant execute on function test_webhook(bigint) to service_role;
grant execute on function claim_webhook_deliveries(int, bigint) to service_role;
grant execute on function finish_webhook_delivery(bigint, int, text, int) to service_role;
grant execute on function prune_webhook_deliveries(int) to service_role;

-- Attaching a link to a task in one statement. Publishing a review and making its batch both add a
-- link, as do sub-tasks publishing into a new batch on their parent at the same moment; reading
-- `links` and writing the longer array back let whichever wrote last drop the other's link.

create function append_task_link(p_task bigint, p_title text, p_url text) returns void
language sql as $$
  update tasks
     set links = coalesce(links, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('title', p_title, 'url', p_url))
   where id = p_task;
$$;

revoke all on function append_task_link(bigint, text, text) from public, anon, authenticated;
grant execute on function append_task_link(bigint, text, text) to service_role;

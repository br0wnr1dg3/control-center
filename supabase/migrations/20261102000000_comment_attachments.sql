-- Images pasted into a comment (screenshots for the agent). Files live in the private
-- comment-attachments bucket under <task id>/; the row lists them: [{path, name, type}].
-- The runner downloads them next to the session and hands the agent their paths.
alter table task_comments add column attachments jsonb not null default '[]'::jsonb;

-- A screenshot on its own is a whole comment.
alter table task_comments drop constraint task_comments_body_check;
alter table task_comments add constraint task_comments_body_check
  check (length(body) > 0 or jsonb_array_length(attachments) > 0);

-- Private: only the service key (app, runner, Worker) reads or writes it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comment-attachments', 'comment-attachments', false, 20971520,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/tiff'])
on conflict (id) do nothing;

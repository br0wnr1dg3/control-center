-- Files attached when a task is written (screenshots, PDFs, docs for the agent). Same shape and
-- bucket as comment attachments: [{path, name, type}] in comment-attachments. The runner downloads
-- them into the task folder and lists their paths in the agent's prompt.
alter table tasks add column attachments jsonb not null default '[]'::jsonb;

-- Any file type now, not just images, up to the project's 50 MB upload limit. The bucket stays private.
update storage.buckets
set allowed_mime_types = null, file_size_limit = 52428800
where id = 'comment-attachments';

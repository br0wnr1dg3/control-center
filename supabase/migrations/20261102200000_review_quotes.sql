-- Review notes on text outputs (drafts, scripts, concepts) can be about a passage: the reviewer selects
-- it on the review page and the note keeps the quoted text and where it starts in the document, so
-- the page can highlight it and the agent knows exactly which words the note is about.

alter table task_comments
  add column quote       text,      -- the selected passage
  add column quote_start integer;   -- its character offset in the rendered document

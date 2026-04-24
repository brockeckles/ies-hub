ALTER TABLE union_activity ADD COLUMN IF NOT EXISTS source_url text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_union_activity_dedupe ON union_activity (company, event_date, event_description);
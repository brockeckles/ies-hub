-- Slice 3.13 — add user_id to analytics_events so we can attribute events
-- to real pilots in the User Activity admin view. Historical rows (the
-- 1,194 captured 2026-04-18 → 2026-04-23 during Slice 3.5–3.11) stay NULL
-- because the session_id → auth.uid() mapping was never recorded.
--
-- RLS is already correct:
--   - analytics_events_insert_anyone (WITH CHECK true) — fire-and-forget writes
--   - analytics_events_read_admin (USING current_user_is_admin()) — SELECT admin-only
-- So we do NOT touch RLS here. The new column inherits those policies.

BEGIN;

ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Admin queries will filter and group by user_id over small time windows,
-- so a plain btree index on (user_id, created_at DESC) is the right shape.
CREATE INDEX IF NOT EXISTS analytics_events_user_id_created_at_idx
  ON public.analytics_events (user_id, created_at DESC);

COMMENT ON COLUMN public.analytics_events.user_id IS
  'Authenticated user_id (auth.users.id) at the time the event fired. NULL for pre-Slice-3.13 events and for events fired before login completes. Slice 3.13.';

COMMIT;
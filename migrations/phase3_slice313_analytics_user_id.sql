-- phase3_slice313_analytics_user_id.sql — Slice 3.13 (User Activity admin view)
--
-- Applied via Supabase MCP apply_migration on 2026-04-23.
-- Name on the server: phase3_slice313_analytics_user_id
--
-- Adds user_id attribution to analytics_events so the new Admin → User
-- Activity tab can show per-pilot login/session/route history. Historical
-- rows (the 1,194 captured 2026-04-18 → 2026-04-23) stay NULL because the
-- session_id → auth.uid() mapping was never recorded.
--
-- RLS is intentionally unchanged:
--   - analytics_events_insert_anyone (WITH CHECK true) — fire-and-forget writes
--   - analytics_events_read_admin (USING current_user_is_admin()) — SELECT admin-only
-- The new column inherits those policies.

BEGIN;

ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Admin queries filter and group by user_id over small time windows,
-- so a composite btree index on (user_id, created_at DESC) is the right shape.
CREATE INDEX IF NOT EXISTS analytics_events_user_id_created_at_idx
  ON public.analytics_events (user_id, created_at DESC);

COMMENT ON COLUMN public.analytics_events.user_id IS
  'Authenticated user_id (auth.users.id) at the time the event fired. NULL for pre-Slice-3.13 events and for events fired before login completes. Slice 3.13.';

COMMIT;

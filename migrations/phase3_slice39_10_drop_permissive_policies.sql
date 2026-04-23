-- phase3_slice39_10_drop_permissive_policies.sql
-- Slice 3.9 — Tier B advisor cleanup.
--
-- Clears the "easy" rls_policy_always_true WARNs on 6 tables:
--   1. analytics_events           — drop ALL(true), re-add INSERT(anyone) + SELECT(admin-only).
--                                   The previous `analytics_events_public` ALL policy let anyone
--                                   read AND write. Anon telemetry still needs to INSERT, so
--                                   we re-create a focused INSERT; SELECT becomes admin-only
--                                   so telemetry rows don't leak back out to the app surface.
--   2. analytics_page_views       — drop UPDATE(true). Keep the anon INSERT (intentional
--                                   telemetry); the advisor WARN on that INSERT is accepted
--                                   as a documented exception (Slice 3.9 memo).
--   3. analytics_sessions         — same treatment as page_views.
--   4. hub_feedback               — drop UPDATE(true). Keep anon INSERT (intentional: anyone
--                                   can submit feedback). SELECT stays open to authed users.
--   5. general_hours              — drop ALL(true) permissive policy. Per Brock's call
--                                   (Slice 3.9, 2026-04-23), `general_hours` is orphan data —
--                                   50 rows from a retired hours-tracking flow, no client
--                                   code reads or writes it anywhere in this repo (the live
--                                   hours system uses `project_hours`, Slice-3.3-scoped).
--                                   Lock to admin-only by removing the rw policy and leaving
--                                   RLS enabled with no member-facing policy. Admin access
--                                   still works via the current_user_is_admin() bypass on
--                                   future policies if a hours UI ever returns; for now,
--                                   only service_role (and direct SQL) can reach the rows.
--   6. project_elements           — drop the 3 write permissive policies (INSERT/UPDATE/DELETE).
--                                   Dormant DOS system (0 rows, no client code; replaced by
--                                   cost_model_projects workflow). SELECT(true) is kept —
--                                   advisor doesn't flag SELECT-always-true, and the table
--                                   is empty so there's nothing to hide. If the DOS system
--                                   ever comes back, this is the point to add real scoping.
--
-- Remaining rls_policy_always_true WARNs after this migration are the 3 intentional
-- anon-INSERT policies (analytics_page_views, analytics_sessions, hub_feedback) — accepted.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. analytics_events: drop ALL, add focused INSERT + admin-only SELECT
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS analytics_events_public ON public.analytics_events;

-- Keep anon INSERT (fire-and-forget telemetry from shared/analytics.js:98).
-- This will register a new rls_policy_always_true WARN on the INSERT, same
-- as the page_views/sessions pattern; that's the accepted intentional-open
-- exception.
CREATE POLICY analytics_events_insert_anyone ON public.analytics_events
  FOR INSERT TO public
  WITH CHECK (true);

-- Read is admin-only so telemetry rows don't leak. No app code reads
-- analytics_events today; if an admin dashboard needs them later, admin
-- bypass covers it.
CREATE POLICY analytics_events_read_admin ON public.analytics_events
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

-- ───────────────────────────────────────────────────────────────────────────
-- 2. analytics_page_views: drop UPDATE(true); keep existing INSERT + SELECT
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anonymous update on analytics_page_views" ON public.analytics_page_views;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. analytics_sessions: drop UPDATE(true); keep existing INSERT + SELECT
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anonymous update on analytics_sessions" ON public.analytics_sessions;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. hub_feedback: drop UPDATE(true); keep anon INSERT + authed SELECT
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS hub_feedback_update_authed ON public.hub_feedback;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. general_hours: drop ALL(true); no replacement. Admin-only via bypass.
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS general_hours_rw_authed ON public.general_hours;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. project_elements: drop 3 write-always-true policies; keep SELECT(true).
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can delete project_elements" ON public.project_elements;
DROP POLICY IF EXISTS "Authenticated users can insert project_elements" ON public.project_elements;
DROP POLICY IF EXISTS "Authenticated users can update project_elements" ON public.project_elements;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (not applied):
-- ═══════════════════════════════════════════════════════════════════════════
-- BEGIN;
-- -- 1. analytics_events
-- DROP POLICY IF EXISTS analytics_events_insert_anyone ON public.analytics_events;
-- DROP POLICY IF EXISTS analytics_events_read_admin ON public.analytics_events;
-- CREATE POLICY analytics_events_public ON public.analytics_events
--   FOR ALL TO public USING (true) WITH CHECK (true);
-- -- 2. analytics_page_views
-- CREATE POLICY "Allow anonymous update on analytics_page_views"
--   ON public.analytics_page_views FOR UPDATE TO public USING (true) WITH CHECK (true);
-- -- 3. analytics_sessions
-- CREATE POLICY "Allow anonymous update on analytics_sessions"
--   ON public.analytics_sessions FOR UPDATE TO public USING (true) WITH CHECK (true);
-- -- 4. hub_feedback
-- CREATE POLICY hub_feedback_update_authed ON public.hub_feedback
--   FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
-- -- 5. general_hours
-- CREATE POLICY general_hours_rw_authed ON public.general_hours
--   FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- -- 6. project_elements
-- CREATE POLICY "Authenticated users can delete project_elements"
--   ON public.project_elements FOR DELETE TO authenticated USING (true);
-- CREATE POLICY "Authenticated users can insert project_elements"
--   ON public.project_elements FOR INSERT TO authenticated WITH CHECK (true);
-- CREATE POLICY "Authenticated users can update project_elements"
--   ON public.project_elements FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
-- COMMIT;

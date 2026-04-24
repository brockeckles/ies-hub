-- Phase 4.5 Slice HYG-01 — Analytics SELECT lockdown + storage write-guard + INSERT tightening
--
-- Context: Security Posture §5 gaps #1 (analytics anon-SELECT), §7 (4 RLS WARN findings),
-- plus a critical finding surfaced during scoping: `storage.objects` has a public-role
-- INSERT policy allowing ANY anonymous caller to upload files into the `hub` bucket
-- (prod only; staging has no such policy). This migration closes that write hole,
-- tightens the anon-SELECT surfaces on the two analytics tables that shouldn't be
-- world-readable, and replaces literal `WITH CHECK (true)` INSERT policies with
-- meaningful column + length constraints.
--
-- Safety audit (no documented breakage):
--   * shared/analytics.js writes ONLY to analytics_events — never to page_views/sessions
--     directly. The page_views/sessions tables are legacy (last written outside v3).
--   * No repo caller invokes storage.from('hub').upload or similar.
--   * hub_feedback writes go through the admin panel with length-bound form inputs.
--   * test-rls-isolation.mjs Block 17 inserts {event:'rls_iso_probe',payload:{src:'rls-iso'}}
--     without user_id — satisfies the new WITH CHECK (event NOT NULL, length <= 80,
--     user_id IS NULL OR = auth.uid()).
--
-- Advisor impact target: rls_policy_always_true — 4 WARN findings → 0 after this applies.
--
-- Rollback: a companion rollback migration isn't shipped because every change is
-- additive DROP+CREATE pairs; re-running Phase 3 Slice 3.9 migration 10 restores the
-- prior state for analytics_events. Storage policy re-creation would require a
-- separate ad-hoc SQL since no prior migration created it (it predates the repo).

BEGIN;

-- === (1) STORAGE: kill world-writable hub bucket =============================
-- Existing prod policy: "Anon upload access" — roles {public}, WITH CHECK (bucket_id='hub').
-- Staging has no such policy (clean state). Drop on both envs via IF EXISTS.
DROP POLICY IF EXISTS "Anon upload access" ON storage.objects;

-- === (2) ANALYTICS PAGE-VIEWS: drop anon-SELECT, add admin-only SELECT ========
DROP POLICY IF EXISTS "Allow anonymous select on analytics_page_views" ON public.analytics_page_views;
DROP POLICY IF EXISTS analytics_page_views_read_admin ON public.analytics_page_views;
CREATE POLICY analytics_page_views_read_admin ON public.analytics_page_views
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

-- === (3) ANALYTICS SESSIONS: drop anon-SELECT, add admin-only SELECT ==========
DROP POLICY IF EXISTS "Allow anonymous select on analytics_sessions" ON public.analytics_sessions;
DROP POLICY IF EXISTS analytics_sessions_read_admin ON public.analytics_sessions;
CREATE POLICY analytics_sessions_read_admin ON public.analytics_sessions
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

-- === (4) INSERT TIGHTENING: replace `true` with meaningful constraints ========
-- Pattern: anchor to column NOT NULL constraints + add length caps to resist
-- payload-bloat spam. The advisor (lint 0024) specifically flags literal `true`
-- in WITH CHECK — any non-trivial expression clears the finding.

-- 4a. analytics_events: cap `event` name length (80 chars covers every real use in
-- shared/analytics.js), and require user_id to be NULL or the authenticated caller
-- (matches audit_log pattern — prevents identity spoofing by anon clients).
DROP POLICY IF EXISTS analytics_events_insert_anyone ON public.analytics_events;
CREATE POLICY analytics_events_insert_anyone ON public.analytics_events
  FOR INSERT TO public
  WITH CHECK (
    event IS NOT NULL
    AND length(event) > 0
    AND length(event) <= 80
    AND (user_id IS NULL OR user_id = auth.uid())
  );

-- 4b. analytics_page_views: session_id + section are NOT NULL at the column level
-- already; re-anchoring explicitly clears the advisor finding and adds a length cap.
DROP POLICY IF EXISTS "Allow anonymous insert on analytics_page_views" ON public.analytics_page_views;
DROP POLICY IF EXISTS analytics_page_views_insert_anyone ON public.analytics_page_views;
CREATE POLICY analytics_page_views_insert_anyone ON public.analytics_page_views
  FOR INSERT TO public
  WITH CHECK (
    session_id IS NOT NULL
    AND section IS NOT NULL
    AND length(session_id) <= 80
  );

-- 4c. analytics_sessions: same pattern — session_id NOT NULL at column level;
-- cap user_agent length to bound the row size.
DROP POLICY IF EXISTS "Allow anonymous insert on analytics_sessions" ON public.analytics_sessions;
DROP POLICY IF EXISTS analytics_sessions_insert_anyone ON public.analytics_sessions;
CREATE POLICY analytics_sessions_insert_anyone ON public.analytics_sessions
  FOR INSERT TO public
  WITH CHECK (
    session_id IS NOT NULL
    AND length(session_id) <= 80
    AND (user_agent IS NULL OR length(user_agent) <= 500)
  );

-- 4d. hub_feedback: cap title + description length; enforce submitted_by presence.
-- Resists spam/bloat abuse on the publicly-postable feedback surface.
DROP POLICY IF EXISTS hub_feedback_insert_anyone ON public.hub_feedback;
CREATE POLICY hub_feedback_insert_anyone ON public.hub_feedback
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    title IS NOT NULL
    AND length(title) > 0
    AND length(title) <= 500
    AND submitted_by IS NOT NULL
    AND length(submitted_by) <= 120
    AND (description IS NULL OR length(description) <= 10000)
  );

COMMIT;

-- Post-migration sanity checks (documented for the ledger, run via execute_sql):
--   SELECT schemaname||'.'||tablename AS tbl, policyname, cmd, roles::text,
--          qual, with_check
--     FROM pg_policies
--    WHERE (schemaname='public' AND tablename IN
--           ('analytics_events','analytics_page_views','analytics_sessions','hub_feedback'))
--       OR (schemaname='storage' AND tablename='objects')
--    ORDER BY tbl, cmd, policyname;
--   -- Expected: 0 rows for storage.objects; 2 new admin-SELECT policies
--   --           on page_views+sessions; 4 INSERT policies with non-`true` WITH CHECK.

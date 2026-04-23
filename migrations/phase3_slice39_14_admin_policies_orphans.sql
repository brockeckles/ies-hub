-- phase3_slice39_14_admin_policies_orphans.sql
-- Slice 3.9 follow-up — add admin-only policies on general_hours so the
-- "admin-only via current_user_is_admin() bypass" description is actually
-- true through REST (not just direct SQL).
--
-- After migration 10 dropped the permissive `general_hours_rw_authed` policy,
-- general_hours had RLS enabled with zero policies. That's the cleanest
-- "service_role only" state, but it means even an admin user hitting the REST
-- endpoint gets 0 rows (no policy matches → no access). The intent was
-- "locked to admin", not "locked to service_role", so we add an explicit
-- admin-only FOR ALL policy. Side benefit: clears the advisor INFO
-- `rls_enabled_no_policy` on general_hours.
--
-- project_elements already has SELECT USING (true) (unflagged by advisor),
-- so admin can already read via REST. INSERT/UPDATE/DELETE stay policy-less
-- — the table is empty and has no client code, so there's nothing for an
-- admin to do through REST. Service_role / direct SQL handles any cleanup.

BEGIN;

CREATE POLICY general_hours_admin_rw ON public.general_hours
  FOR ALL TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (not applied):
-- ═══════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   DROP POLICY IF EXISTS general_hours_admin_rw ON public.general_hours;
-- COMMIT;

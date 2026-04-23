-- phase3_slice39_12_matview_wrapper.sql
-- Slice 3.9 — wrap the materialized view so it's not exposed via the
-- PostgREST Data API, while preserving Slice-3.3 ownership scoping.
--
-- Advisor issue: `materialized_view_in_api` — `public.fact_pnl_monthly` was
-- selectable by both anon and authenticated roles through PostgREST. Materialized
-- views can't enforce RLS, so any authed user could read any project's P&L.
--
-- Why a SECURITY DEFINER RPC (not a security_invoker view wrapper):
--   - A security_invoker=true view on the matview would require the caller to
--     have SELECT on the matview → back to square one.
--   - A default-security_invoker-false view would trip the `security_definer_view`
--     advisor (the one we just cleaned up in Slice 3.8).
--   - A SECURITY DEFINER function *is* the idiomatic Supabase pattern for this:
--     the function runs as its owner (postgres) so it can read the matview,
--     but the function body filters by cost_model_projects ownership —
--     reproducing exactly the my/team/shared logic from the parent table.
--
-- Client change: `tools/cost-model/api.js:fetchMonthlyProjections` now calls
-- `db.rpc('get_pnl_monthly', { p_project_id })` instead of selecting from the
-- matview directly. The raw-join fallback stays in place as a safety net for
-- cases where the matview is empty (fresh project, pre-refresh), but it will
-- never be triggered by permission errors anymore.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_pnl_monthly(p_project_id BIGINT)
RETURNS SETOF public.fact_pnl_monthly
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
STABLE
AS $$
  SELECT f.*
  FROM public.fact_pnl_monthly f
  WHERE f.project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM public.cost_model_projects p
      WHERE p.id = f.project_id
        AND (
          p.owner_id = auth.uid()
          OR (p.visibility = 'team'::public.visibility_level AND p.team_id = public.current_user_team_id())
          OR p.visibility = 'shared'::public.visibility_level
          OR public.current_user_is_admin()
        )
    )
  ORDER BY f.period_index ASC;
$$;

-- Lock down execution: revoke the default PUBLIC grant, then grant only to authenticated.
REVOKE ALL ON FUNCTION public.get_pnl_monthly(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pnl_monthly(BIGINT) TO authenticated;

-- Pull the matview out of the Data API.
REVOKE SELECT ON public.fact_pnl_monthly FROM anon, authenticated;

-- service_role keeps full access (used by refresh_pnl_for_project and any
-- admin tooling running with the service key).

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (not applied):
-- ═══════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   GRANT SELECT ON public.fact_pnl_monthly TO anon, authenticated;
--   DROP FUNCTION IF EXISTS public.get_pnl_monthly(BIGINT);
-- COMMIT;

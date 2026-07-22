-- =============================================================================
-- IES Hub — Wave C6 — RPC EXECUTE-grant hygiene + search_path pin
-- =============================================================================
-- Supabase advisor lints (0028/0029, prod dklnwcshrpamzsybjlzb, 2026-07-22)
-- flag SECURITY DEFINER functions executable by anon via PostgREST /rpc/.
-- Evidence-first sweep of every caller (grep tools/ hub/ shared/
-- supabase/functions/ for rpc('<fn>')) shows NO code path ever invokes any
-- RPC as anon — the hub gates every surface behind Supabase auth; the only
-- pre-auth traffic is analytics/feedback INSERTs (plain table policies, no
-- helper fns). Full caller inventory:
--   tools/cost-model/api.js:775  refresh_pnl_for_project   (authenticated)
--   tools/cost-model/api.js:782,855 refresh_cost_model_facts (authenticated)
--   tools/cost-model/api.js:870  get_labor_monthly          (authenticated)
--   tools/cost-model/api.js:881  get_capital_monthly        (authenticated)
--   tools/cost-model/api.js:921  get_pnl_monthly            (authenticated)
--   tools/cost-model/api.js:1053 approve_scenario           (authenticated)
--   shared/auth.js:394           mfa_grace_start            (authenticated, post-sign-in)
--   hub/admin/api.js:258         admin_list_user_logins     (authenticated admin)
--   (no client call anywhere to current_user_team_id / current_user_is_admin
--    / current_user_is_aal2 — they are RLS-policy helpers only)
--
-- Authenticated EXECUTE is NOT revoked on anything: every flagged fn either
-- has a live authenticated caller (list above) or is an RLS helper that the
-- authenticated role must be able to execute because policies evaluate as
-- the querying role (86+ policies reference current_user_is_admin /
-- current_user_team_id, all created TO authenticated — verified in
-- 20260423123814, 20260423150032, 20260424180600; no policy TO anon/public
-- references any helper, so revoking anon cannot break RLS evaluation).
--
-- Idempotent: REVOKE/GRANT are naturally re-statable; the ALTER FUNCTION for
-- the prod-only trigger fn is guarded with to_regprocedure so a fresh rebuild
-- (where that fn does not exist in repo migrations) is a no-op.

BEGIN;

-- Every statement existence-guarded: staging and prod have drifted function
-- inventories (e.g. admin_list_user_logins exists on prod only — discovered
-- on staging apply 2026-07-22), and fresh rebuilds may lack the out-of-band
-- prod objects entirely.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.current_user_team_id()',
    'public.current_user_is_admin()',
    'public.current_user_is_aal2()',
    'public.admin_list_user_logins()',
    'public.get_pnl_monthly(bigint)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    ELSE
      RAISE NOTICE '% absent on this database - skipping', fn;
    END IF;
  END LOOP;

  IF to_regprocedure('public.master_channel_archetypes_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.master_channel_archetypes_set_updated_at() SET search_path = ''public''';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.master_channel_archetypes_set_updated_at() FROM PUBLIC, anon, authenticated';
  ELSE
    RAISE NOTICE 'master_channel_archetypes_set_updated_at() absent (fresh rebuild) - skipping search_path pin';
  END IF;
END $$;

COMMIT;

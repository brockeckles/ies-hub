-- Phase 0 security (2026-07-02) — lock down SECURITY DEFINER function EXECUTE grants.
--
-- The 2026-07-02 ground-up assessment (and Supabase advisor lints 0028/0029)
-- flagged SECURITY DEFINER functions in the public schema callable via
-- PostgREST (/rest/v1/rpc/<fn>) by anon/authenticated. The root cause is the
-- Postgres default of granting EXECUTE to PUBLIC on function creation (the
-- `=X/postgres` ACL entry), which no per-role REVOKE removes. This migration
-- revokes the PUBLIC grant and re-grants EXECUTE only to the roles that need
-- it — mirroring the already-correct ACL on refresh_cost_model_facts
-- ({postgres, authenticated, service_role}, no PUBLIC).
--
-- Client callers (tools/cost-model/api.js) keep authenticated EXECUTE:
--   approve_scenario(bigint,text), refresh_pnl_for_project(bigint),
--   refresh_cost_model_facts() [already correct].
-- Trigger bodies and setup/maintenance fns get PUBLIC revoked and no app-role
-- grant (service_role retained for edge-fn / SQL-editor use).
-- (Row-level ownership hardening inside approve_scenario is a Phase-1 item.)

BEGIN;

-- Trigger functions — never PostgREST-callable.
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.protect_profile_privileged_cols() FROM PUBLIC, anon, authenticated;

-- Setup/maintenance — no client caller (service_role retained via existing ACL).
REVOKE EXECUTE ON FUNCTION public.provision_market_intel() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_market_keys()       FROM PUBLIC, anon, authenticated;

-- Data-mutating RPCs the client calls — revoke PUBLIC/anon, grant authenticated.
REVOKE EXECUTE ON FUNCTION public.approve_scenario(bigint, text)  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_scenario(bigint, text)  TO authenticated;

REVOKE EXECUTE ON FUNCTION public.refresh_pnl_for_project(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.refresh_pnl_for_project(bigint) TO authenticated;

-- refresh_cost_model_facts() already has the correct ACL; ensure anon absent.
REVOKE EXECUTE ON FUNCTION public.refresh_cost_model_facts()      FROM PUBLIC, anon;

COMMIT;

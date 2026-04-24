-- Phase 4.5 Slice HYG-02 — staging search_path backfill
--
-- Background: Phase 3 Slice 3.9 migration 09 (`phase3_09_function_search_path`)
-- pinned search_path=public on 15 functions. On prod, all 11 still-extant
-- functions remain pinned (verified via pg_proc.proconfig). On staging, the
-- same 11 functions currently show NULL proconfig — likely because a later
-- migration re-ran CREATE OR REPLACE on them and did not re-attach the
-- search_path setting. The 4 DOS-framework functions in migration 09
-- (add_sub_element, get_project_elements_nested, get_project_stage_status,
-- instantiate_stage_elements) do not exist on staging — consistent with the
-- known 73-column DOS-framework schema drift.
--
-- This migration re-pins search_path=public on the 11 staging functions.
-- On prod, it is a no-op (idempotent).
-- Expected result: 11 `function_search_path_mutable` WARNs clear from staging
-- advisor; prod advisor remains at 0 findings.

BEGIN;

ALTER FUNCTION public.approve_scenario(bigint, text)       SET search_path = 'public';
ALTER FUNCTION public.fn_numstr(numeric)                   SET search_path = 'public';
ALTER FUNCTION public.fn_ref_equipment_hash()              SET search_path = 'public';
ALTER FUNCTION public.fn_ref_facility_rates_hash()         SET search_path = 'public';
ALTER FUNCTION public.fn_ref_labor_rates_hash()            SET search_path = 'public';
ALTER FUNCTION public.fn_ref_overhead_rates_hash()         SET search_path = 'public';
ALTER FUNCTION public.fn_ref_utility_rates_hash()          SET search_path = 'public';
ALTER FUNCTION public.provision_market_intel()             SET search_path = 'public';
ALTER FUNCTION public.reconcile_market_intel()             SET search_path = 'public';
ALTER FUNCTION public.sync_market_keys()                   SET search_path = 'public';
ALTER FUNCTION public.update_updated_at()                  SET search_path = 'public';

COMMIT;

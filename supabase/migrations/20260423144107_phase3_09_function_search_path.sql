-- Phase 3 Slice 3.8 Migration 09 — pin search_path on 15 functions
BEGIN;

ALTER FUNCTION public.add_sub_element(bigint, text, text, uuid) SET search_path = 'public';
ALTER FUNCTION public.approve_scenario(bigint, text) SET search_path = 'public';
ALTER FUNCTION public.fn_numstr(numeric) SET search_path = 'public';
ALTER FUNCTION public.fn_ref_equipment_hash() SET search_path = 'public';
ALTER FUNCTION public.fn_ref_facility_rates_hash() SET search_path = 'public';
ALTER FUNCTION public.fn_ref_labor_rates_hash() SET search_path = 'public';
ALTER FUNCTION public.fn_ref_overhead_rates_hash() SET search_path = 'public';
ALTER FUNCTION public.fn_ref_utility_rates_hash() SET search_path = 'public';
ALTER FUNCTION public.get_project_elements_nested(bigint, integer) SET search_path = 'public';
ALTER FUNCTION public.get_project_stage_status(bigint) SET search_path = 'public';
ALTER FUNCTION public.instantiate_stage_elements(bigint, bigint) SET search_path = 'public';
ALTER FUNCTION public.provision_market_intel() SET search_path = 'public';
ALTER FUNCTION public.reconcile_market_intel() SET search_path = 'public';
ALTER FUNCTION public.sync_market_keys() SET search_path = 'public';
ALTER FUNCTION public.update_updated_at() SET search_path = 'public';

COMMIT;
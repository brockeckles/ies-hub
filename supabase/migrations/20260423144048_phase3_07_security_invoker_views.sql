-- Phase 3 Slice 3.8 Migration 07 — recreate 5 SECURITY DEFINER views with security_invoker=true
BEGIN;

DROP VIEW IF EXISTS public.ref_labor_rates_current;
CREATE VIEW public.ref_labor_rates_current
  WITH (security_invoker = true) AS
SELECT id, market_id, role_name, role_category, hourly_rate, burden_pct,
       benefits_per_hour, overtime_multiplier, shift_differential_pct,
       annual_hours, notes, effective_date, created_at, updated_at,
       default_benefit_load_pct, default_bonus_pct, annual_escalation_pct,
       source_citation, source_date, source_url, effective_end_date,
       version_hash, superseded_by_id
  FROM public.ref_labor_rates
 WHERE effective_end_date > CURRENT_DATE
   AND superseded_by_id IS NULL;

DROP VIEW IF EXISTS public.ref_overhead_rates_current;
CREATE VIEW public.ref_overhead_rates_current
  WITH (security_invoker = true) AS
SELECT id, category, description, monthly_cost, cost_type, per_unit, notes,
       created_at, updated_at, source_citation, source_date, source_url,
       effective_date, effective_end_date, version_hash, superseded_by_id
  FROM public.ref_overhead_rates
 WHERE effective_end_date > CURRENT_DATE
   AND superseded_by_id IS NULL;

DROP VIEW IF EXISTS public.ref_utility_rates_current;
CREATE VIEW public.ref_utility_rates_current
  WITH (security_invoker = true) AS
SELECT id, market_id, electricity_kwh, natural_gas_therm, water_per_kgal,
       trash_monthly, telecom_monthly, avg_monthly_per_sqft, notes,
       effective_date, created_at, updated_at, source_citation, source_date,
       source_url, effective_end_date, version_hash, superseded_by_id
  FROM public.ref_utility_rates
 WHERE effective_end_date > CURRENT_DATE
   AND superseded_by_id IS NULL;

DROP VIEW IF EXISTS public.ref_facility_rates_current;
CREATE VIEW public.ref_facility_rates_current
  WITH (security_invoker = true) AS
SELECT id, market_id, building_type, lease_rate_psf_yr, cam_rate_psf_yr,
       tax_rate_psf_yr, insurance_rate_psf_yr, build_out_psf, clear_height_ft,
       typical_bay_size, dock_door_cost, notes, effective_date, created_at,
       updated_at, source_citation, source_date, source_url,
       effective_end_date, version_hash, superseded_by_id
  FROM public.ref_facility_rates
 WHERE effective_end_date > CURRENT_DATE
   AND superseded_by_id IS NULL;

DROP VIEW IF EXISTS public.ref_equipment_current;
CREATE VIEW public.ref_equipment_current
  WITH (security_invoker = true) AS
SELECT id, name, category, subcategory, purchase_cost, monthly_lease_cost,
       monthly_maintenance, useful_life_years, depreciation_method, power_type,
       capacity_description, notes, created_at, updated_at,
       annual_escalation_pct, source_citation, source_date, source_url,
       effective_date, effective_end_date, version_hash, superseded_by_id
  FROM public.ref_equipment
 WHERE effective_end_date > CURRENT_DATE
   AND superseded_by_id IS NULL;

COMMIT;
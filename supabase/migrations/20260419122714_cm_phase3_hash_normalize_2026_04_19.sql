
-- Normalize numeric text so client/server hashes agree.
-- '24.00' -> '24', '4.20' -> '4.2', '0.00' -> '0'.
CREATE OR REPLACE FUNCTION public.fn_numstr(n numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $body$
  SELECT CASE
    WHEN n IS NULL THEN ''
    WHEN position('.' IN n::text) > 0
      THEN rtrim(rtrim(n::text, '0'), '.')
    ELSE n::text
  END;
$body$;

CREATE OR REPLACE FUNCTION public.fn_ref_labor_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    COALESCE(NEW.market_id::text,'')
    || '|' || NEW.role_name
    || '|' || NEW.role_category
    || '|' || public.fn_numstr(NEW.hourly_rate)
    || '|' || public.fn_numstr(NEW.burden_pct)
    || '|' || public.fn_numstr(NEW.benefits_per_hour)
    || '|' || public.fn_numstr(NEW.overtime_multiplier)
    || '|' || public.fn_numstr(NEW.shift_differential_pct)
    || '|' || COALESCE(NEW.annual_hours::text,'')
    || '|' || public.fn_numstr(NEW.default_benefit_load_pct)
    || '|' || public.fn_numstr(NEW.default_bonus_pct)
    || '|' || public.fn_numstr(NEW.annual_escalation_pct)
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION public.fn_ref_facility_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    COALESCE(NEW.market_id::text,'')
    || '|' || NEW.building_type
    || '|' || public.fn_numstr(NEW.lease_rate_psf_yr)
    || '|' || public.fn_numstr(NEW.cam_rate_psf_yr)
    || '|' || public.fn_numstr(NEW.tax_rate_psf_yr)
    || '|' || public.fn_numstr(NEW.insurance_rate_psf_yr)
    || '|' || public.fn_numstr(NEW.build_out_psf)
    || '|' || COALESCE(NEW.clear_height_ft::text,'')
    || '|' || public.fn_numstr(NEW.dock_door_cost)
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION public.fn_ref_utility_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    COALESCE(NEW.market_id::text,'')
    || '|' || public.fn_numstr(NEW.electricity_kwh)
    || '|' || public.fn_numstr(NEW.natural_gas_therm)
    || '|' || public.fn_numstr(NEW.water_per_kgal)
    || '|' || public.fn_numstr(NEW.trash_monthly)
    || '|' || public.fn_numstr(NEW.telecom_monthly)
    || '|' || public.fn_numstr(NEW.avg_monthly_per_sqft)
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION public.fn_ref_overhead_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    NEW.category
    || '|' || COALESCE(NEW.description,'')
    || '|' || public.fn_numstr(NEW.monthly_cost)
    || '|' || COALESCE(NEW.cost_type,'')
    || '|' || COALESCE(NEW.per_unit,'')
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION public.fn_ref_equipment_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    NEW.name
    || '|' || NEW.category
    || '|' || COALESCE(NEW.subcategory,'')
    || '|' || public.fn_numstr(NEW.purchase_cost)
    || '|' || public.fn_numstr(NEW.monthly_lease_cost)
    || '|' || public.fn_numstr(NEW.monthly_maintenance)
    || '|' || COALESCE(NEW.useful_life_years::text,'')
    || '|' || COALESCE(NEW.depreciation_method,'')
    || '|' || public.fn_numstr(NEW.annual_escalation_pct)
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;

-- Backfill: force all triggers to recompute
UPDATE public.ref_labor_rates    SET updated_at = now();
UPDATE public.ref_facility_rates SET updated_at = now();
UPDATE public.ref_utility_rates  SET updated_at = now();
UPDATE public.ref_overhead_rates SET updated_at = now();
UPDATE public.ref_equipment      SET updated_at = now();

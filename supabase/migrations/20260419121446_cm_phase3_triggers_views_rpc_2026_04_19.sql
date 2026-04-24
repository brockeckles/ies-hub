
-- ---------- Version-hash triggers (one per rate table) ----------

CREATE OR REPLACE FUNCTION public.fn_ref_labor_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    COALESCE(NEW.market_id::text,'')
    || '|' || NEW.role_name
    || '|' || NEW.role_category
    || '|' || NEW.hourly_rate::text
    || '|' || COALESCE(NEW.burden_pct::text,'')
    || '|' || COALESCE(NEW.benefits_per_hour::text,'')
    || '|' || COALESCE(NEW.overtime_multiplier::text,'')
    || '|' || COALESCE(NEW.shift_differential_pct::text,'')
    || '|' || COALESCE(NEW.annual_hours::text,'')
    || '|' || COALESCE(NEW.default_benefit_load_pct::text,'')
    || '|' || COALESCE(NEW.default_bonus_pct::text,'')
    || '|' || COALESCE(NEW.annual_escalation_pct::text,'')
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS trg_ref_labor_rates_hash ON public.ref_labor_rates;
CREATE TRIGGER trg_ref_labor_rates_hash
  BEFORE INSERT OR UPDATE ON public.ref_labor_rates
  FOR EACH ROW EXECUTE FUNCTION public.fn_ref_labor_rates_hash();

CREATE OR REPLACE FUNCTION public.fn_ref_facility_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    COALESCE(NEW.market_id::text,'')
    || '|' || NEW.building_type
    || '|' || NEW.lease_rate_psf_yr::text
    || '|' || COALESCE(NEW.cam_rate_psf_yr::text,'')
    || '|' || COALESCE(NEW.tax_rate_psf_yr::text,'')
    || '|' || COALESCE(NEW.insurance_rate_psf_yr::text,'')
    || '|' || COALESCE(NEW.build_out_psf::text,'')
    || '|' || COALESCE(NEW.clear_height_ft::text,'')
    || '|' || COALESCE(NEW.dock_door_cost::text,'')
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS trg_ref_facility_rates_hash ON public.ref_facility_rates;
CREATE TRIGGER trg_ref_facility_rates_hash
  BEFORE INSERT OR UPDATE ON public.ref_facility_rates
  FOR EACH ROW EXECUTE FUNCTION public.fn_ref_facility_rates_hash();

CREATE OR REPLACE FUNCTION public.fn_ref_utility_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    COALESCE(NEW.market_id::text,'')
    || '|' || COALESCE(NEW.electricity_kwh::text,'')
    || '|' || COALESCE(NEW.natural_gas_therm::text,'')
    || '|' || COALESCE(NEW.water_per_kgal::text,'')
    || '|' || COALESCE(NEW.trash_monthly::text,'')
    || '|' || COALESCE(NEW.telecom_monthly::text,'')
    || '|' || COALESCE(NEW.avg_monthly_per_sqft::text,'')
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS trg_ref_utility_rates_hash ON public.ref_utility_rates;
CREATE TRIGGER trg_ref_utility_rates_hash
  BEFORE INSERT OR UPDATE ON public.ref_utility_rates
  FOR EACH ROW EXECUTE FUNCTION public.fn_ref_utility_rates_hash();

CREATE OR REPLACE FUNCTION public.fn_ref_overhead_rates_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    NEW.category
    || '|' || COALESCE(NEW.description,'')
    || '|' || COALESCE(NEW.monthly_cost::text,'')
    || '|' || COALESCE(NEW.cost_type,'')
    || '|' || COALESCE(NEW.per_unit,'')
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS trg_ref_overhead_rates_hash ON public.ref_overhead_rates;
CREATE TRIGGER trg_ref_overhead_rates_hash
  BEFORE INSERT OR UPDATE ON public.ref_overhead_rates
  FOR EACH ROW EXECUTE FUNCTION public.fn_ref_overhead_rates_hash();

CREATE OR REPLACE FUNCTION public.fn_ref_equipment_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  NEW.version_hash := md5(
    NEW.name
    || '|' || NEW.category
    || '|' || COALESCE(NEW.subcategory,'')
    || '|' || COALESCE(NEW.purchase_cost::text,'')
    || '|' || COALESCE(NEW.monthly_lease_cost::text,'')
    || '|' || COALESCE(NEW.monthly_maintenance::text,'')
    || '|' || COALESCE(NEW.useful_life_years::text,'')
    || '|' || COALESCE(NEW.depreciation_method,'')
    || '|' || COALESCE(NEW.annual_escalation_pct::text,'')
    || '|' || COALESCE(NEW.effective_date::text,'')
  );
  RETURN NEW;
END;
$body$;
DROP TRIGGER IF EXISTS trg_ref_equipment_hash ON public.ref_equipment;
CREATE TRIGGER trg_ref_equipment_hash
  BEFORE INSERT OR UPDATE ON public.ref_equipment
  FOR EACH ROW EXECUTE FUNCTION public.fn_ref_equipment_hash();

-- ---------- Backfill version_hash for existing rows (touch row to fire trigger) ----------
UPDATE public.ref_labor_rates    SET updated_at = updated_at WHERE version_hash IS NULL;
UPDATE public.ref_facility_rates SET updated_at = updated_at WHERE version_hash IS NULL;
UPDATE public.ref_utility_rates  SET updated_at = updated_at WHERE version_hash IS NULL;
UPDATE public.ref_overhead_rates SET updated_at = updated_at WHERE version_hash IS NULL;
UPDATE public.ref_equipment      SET updated_at = updated_at WHERE version_hash IS NULL;

-- ---------- _current views ----------
CREATE OR REPLACE VIEW public.ref_labor_rates_current AS
  SELECT * FROM public.ref_labor_rates
   WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL;

CREATE OR REPLACE VIEW public.ref_facility_rates_current AS
  SELECT * FROM public.ref_facility_rates
   WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL;

CREATE OR REPLACE VIEW public.ref_utility_rates_current AS
  SELECT * FROM public.ref_utility_rates
   WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL;

CREATE OR REPLACE VIEW public.ref_overhead_rates_current AS
  SELECT * FROM public.ref_overhead_rates
   WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL;

CREATE OR REPLACE VIEW public.ref_equipment_current AS
  SELECT * FROM public.ref_equipment
   WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL;

GRANT SELECT ON public.ref_labor_rates_current    TO anon, authenticated;
GRANT SELECT ON public.ref_facility_rates_current TO anon, authenticated;
GRANT SELECT ON public.ref_utility_rates_current  TO anon, authenticated;
GRANT SELECT ON public.ref_overhead_rates_current TO anon, authenticated;
GRANT SELECT ON public.ref_equipment_current      TO anon, authenticated;

-- ---------- approve_scenario RPC ----------
CREATE OR REPLACE FUNCTION public.approve_scenario(
  p_scenario_id bigint,
  p_user_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
DECLARE
  v_project_id bigint;
  v_market_id  uuid;
  v_labor int := 0; v_fac int := 0; v_util int := 0; v_oh int := 0; v_eq int := 0;
BEGIN
  SELECT project_id INTO v_project_id
  FROM public.cost_model_scenarios WHERE id = p_scenario_id;
  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'scenario % has no project', p_scenario_id;
  END IF;

  SELECT market_id INTO v_market_id
  FROM public.cost_model_projects WHERE id = v_project_id;

  -- Labor (market-filtered)
  INSERT INTO public.cost_model_rate_snapshots
    (scenario_id, rate_card_type, rate_card_id, rate_card_version_hash, snapshot_json)
  SELECT p_scenario_id, 'labor', id::text, version_hash, to_jsonb(r.*)
  FROM public.ref_labor_rates r
  WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL
    AND (v_market_id IS NULL OR market_id = v_market_id)
  ON CONFLICT (scenario_id, rate_card_type, rate_card_id) DO UPDATE
    SET rate_card_version_hash = EXCLUDED.rate_card_version_hash,
        snapshot_json = EXCLUDED.snapshot_json,
        captured_at   = now();
  GET DIAGNOSTICS v_labor = ROW_COUNT;

  -- Facility (market-filtered)
  INSERT INTO public.cost_model_rate_snapshots
    (scenario_id, rate_card_type, rate_card_id, rate_card_version_hash, snapshot_json)
  SELECT p_scenario_id, 'facility', id::text, version_hash, to_jsonb(r.*)
  FROM public.ref_facility_rates r
  WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL
    AND (v_market_id IS NULL OR market_id = v_market_id)
  ON CONFLICT (scenario_id, rate_card_type, rate_card_id) DO UPDATE
    SET rate_card_version_hash = EXCLUDED.rate_card_version_hash,
        snapshot_json = EXCLUDED.snapshot_json,
        captured_at   = now();
  GET DIAGNOSTICS v_fac = ROW_COUNT;

  -- Utility (market-filtered)
  INSERT INTO public.cost_model_rate_snapshots
    (scenario_id, rate_card_type, rate_card_id, rate_card_version_hash, snapshot_json)
  SELECT p_scenario_id, 'utility', id::text, version_hash, to_jsonb(r.*)
  FROM public.ref_utility_rates r
  WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL
    AND (v_market_id IS NULL OR market_id = v_market_id)
  ON CONFLICT (scenario_id, rate_card_type, rate_card_id) DO UPDATE
    SET rate_card_version_hash = EXCLUDED.rate_card_version_hash,
        snapshot_json = EXCLUDED.snapshot_json,
        captured_at   = now();
  GET DIAGNOSTICS v_util = ROW_COUNT;

  -- Overhead (not market-keyed)
  INSERT INTO public.cost_model_rate_snapshots
    (scenario_id, rate_card_type, rate_card_id, rate_card_version_hash, snapshot_json)
  SELECT p_scenario_id, 'overhead', id::text, version_hash, to_jsonb(r.*)
  FROM public.ref_overhead_rates r
  WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL
  ON CONFLICT (scenario_id, rate_card_type, rate_card_id) DO UPDATE
    SET rate_card_version_hash = EXCLUDED.rate_card_version_hash,
        snapshot_json = EXCLUDED.snapshot_json,
        captured_at   = now();
  GET DIAGNOSTICS v_oh = ROW_COUNT;

  -- Equipment
  INSERT INTO public.cost_model_rate_snapshots
    (scenario_id, rate_card_type, rate_card_id, rate_card_version_hash, snapshot_json)
  SELECT p_scenario_id, 'equipment', id::text, version_hash, to_jsonb(r.*)
  FROM public.ref_equipment r
  WHERE effective_end_date > CURRENT_DATE AND superseded_by_id IS NULL
  ON CONFLICT (scenario_id, rate_card_type, rate_card_id) DO UPDATE
    SET rate_card_version_hash = EXCLUDED.rate_card_version_hash,
        snapshot_json = EXCLUDED.snapshot_json,
        captured_at   = now();
  GET DIAGNOSTICS v_eq = ROW_COUNT;

  -- Transition scenario status
  UPDATE public.cost_model_scenarios
     SET status      = 'approved',
         approved_at = now(),
         approved_by = COALESCE(p_user_email, approved_by, 'system'),
         updated_at  = now()
   WHERE id = p_scenario_id;

  RETURN jsonb_build_object(
    'scenario_id', p_scenario_id,
    'approved_at', now(),
    'approved_by', COALESCE(p_user_email, 'system'),
    'snap_labor', v_labor,
    'snap_facility', v_fac,
    'snap_utility', v_util,
    'snap_overhead', v_oh,
    'snap_equipment', v_eq
  );
END;
$body$;

GRANT EXECUTE ON FUNCTION public.approve_scenario(bigint, text) TO anon, authenticated;

-- ---------- Baseline scenario backfill for existing projects ----------
INSERT INTO public.cost_model_scenarios
  (deal_id, project_id, scenario_label, is_baseline, status)
SELECT p.deal_deals_id,
       p.id,
       COALESCE(NULLIF(p.scenario_label, ''), 'Baseline'),
       TRUE,
       'draft'
FROM public.cost_model_projects p
LEFT JOIN public.cost_model_scenarios s ON s.project_id = p.id
WHERE s.id IS NULL;

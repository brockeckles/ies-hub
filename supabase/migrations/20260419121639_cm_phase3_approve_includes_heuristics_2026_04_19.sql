
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
  v_overrides  jsonb;
  v_labor int := 0; v_fac int := 0; v_util int := 0; v_oh int := 0; v_eq int := 0; v_heur int := 0;
BEGIN
  SELECT project_id INTO v_project_id
  FROM public.cost_model_scenarios WHERE id = p_scenario_id;
  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'scenario % has no project', p_scenario_id;
  END IF;

  SELECT market_id, COALESCE(heuristic_overrides, '{}'::jsonb)
    INTO v_market_id, v_overrides
  FROM public.cost_model_projects WHERE id = v_project_id;

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

  -- Heuristics: one snapshot row per heuristic key.
  -- snapshot_json includes both the catalog default and the effective value (override or default).
  INSERT INTO public.cost_model_rate_snapshots
    (scenario_id, rate_card_type, rate_card_id, rate_card_version_hash, snapshot_json)
  SELECT p_scenario_id,
         'heuristics',
         h.key,
         md5(
           h.key
           || '|' || COALESCE(h.default_value::text,'')
           || '|' || COALESCE(h.default_enum,'')
           || '|' || COALESCE(v_overrides->>h.key,'')
         ),
         jsonb_build_object(
           'key',           h.key,
           'label',         h.label,
           'category',      h.category,
           'data_type',     h.data_type,
           'unit',          h.unit,
           'default_value', h.default_value,
           'default_enum',  h.default_enum,
           'override',      v_overrides -> h.key,
           'effective',     COALESCE(v_overrides -> h.key,
                                     to_jsonb(h.default_value),
                                     to_jsonb(h.default_enum))
         )
  FROM public.ref_design_heuristics h
  WHERE h.is_active = true
  ON CONFLICT (scenario_id, rate_card_type, rate_card_id) DO UPDATE
    SET rate_card_version_hash = EXCLUDED.rate_card_version_hash,
        snapshot_json          = EXCLUDED.snapshot_json,
        captured_at            = now();
  GET DIAGNOSTICS v_heur = ROW_COUNT;

  UPDATE public.cost_model_scenarios
     SET status      = 'approved',
         approved_at = now(),
         approved_by = COALESCE(p_user_email, approved_by, 'system'),
         updated_at  = now()
   WHERE id = p_scenario_id;

  RETURN jsonb_build_object(
    'scenario_id',    p_scenario_id,
    'approved_at',    now(),
    'approved_by',    COALESCE(p_user_email, 'system'),
    'snap_labor',     v_labor,
    'snap_facility',  v_fac,
    'snap_utility',   v_util,
    'snap_overhead',  v_oh,
    'snap_equipment', v_eq,
    'snap_heuristics',v_heur
  );
END;
$body$;

GRANT EXECUTE ON FUNCTION public.approve_scenario(bigint, text) TO anon, authenticated;

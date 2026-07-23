-- =============================================================================
-- IES Hub — Wave BW (security) — approve_scenario ownership gate + approver
-- identity hardening
-- =============================================================================
-- Purpose: The live prod approve_scenario (SECURITY DEFINER) had ZERO
--   ownership check — any authenticated caller could approve ANY scenario
--   (flagged as a Phase-1 item in 20260702160000_phase0_sec_revoke_rpc_execute).
--   This migration re-states the exact live prod body/signature/flow and adds:
--     1. An authorization gate right after v_project_id resolves: the call is
--        allowed iff current_user_is_admin() OR the caller owns the parent
--        project (cost_model_projects.owner_id = auth.uid() — owner_id is the
--        ownership column used by the live cost_model_projects_* policies).
--        TEAM VISIBILITY IS DELIBERATELY EXCLUDED (Brock ruling, 2026-07-23):
--        approval is a write-power, so it is owner/admin only — team/shared
--        visibility grants READ, never approval. Do not add a team arm here.
--     2. approved_by hardening: prefer the caller's JWT email over the
--        spoofable p_user_email parameter —
--        COALESCE(auth.jwt()->>'email', p_user_email, approved_by, 'system').
--        Signature is UNCHANGED (p_scenario_id bigint, p_user_email text
--        DEFAULT NULL) — tools/cost-model/api.js approveScenarioRpc still
--        passes p_user_email; it now only matters when no JWT email exists.
-- Author:  Brock + Claude (Cowork)
-- Created: 2026-07-23
-- Rollback: re-run 20260419121639_cm_phase3_approve_includes_heuristics
--   body (WITHOUT its trailing anon GRANT — see C6), which restores the
--   ungated behavior. Not recommended.
--
-- CREATE OR REPLACE, NEVER drop+create: C6 (20260723000000_c6_rpc_grant_hygiene)
-- already fixed this function's ACLs (EXECUTE revoked from PUBLIC/anon;
-- authenticated + service_role kept). DROP FUNCTION resets ACLs to defaults
-- (GRANT to PUBLIC) — the exact prod fn-ACL drift class C6 cleaned up.
-- CREATE OR REPLACE preserves existing ACLs, so no GRANT/REVOKE is restated
-- here. SECURITY DEFINER + SET search_path TO 'public' are kept (a
-- CREATE OR REPLACE without the SET clause would silently drop the
-- search_path pin from 20260423144107).
-- Idempotent: CREATE OR REPLACE is naturally re-statable.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.approve_scenario(
  p_scenario_id bigint,
  p_user_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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

  -- ── Authorization gate (Wave BW, 2026-07-23) ──────────────────────────────
  -- SECURITY DEFINER bypasses RLS, so ownership must be checked explicitly.
  -- Allowed iff admin OR the caller owns the parent project (owner_id — the
  -- same column the live cost_model_projects UPDATE/DELETE policies use).
  -- Team visibility deliberately EXCLUDED: approval is a write-power
  -- (owner/admin only), read-visibility does not confer it.
  IF NOT (
    current_user_is_admin()
    OR EXISTS (
      SELECT 1 FROM public.cost_model_projects p
      WHERE p.id = v_project_id
        AND p.owner_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'approve_scenario: not authorized for project %', v_project_id;
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

  -- approved_by hardening (Wave BW): the caller's JWT email wins over the
  -- client-supplied (spoofable) p_user_email; p_user_email remains the
  -- fallback for contexts with no JWT email claim.
  UPDATE public.cost_model_scenarios
     SET status      = 'approved',
         approved_at = now(),
         approved_by = COALESCE(auth.jwt()->>'email', p_user_email, approved_by, 'system'),
         updated_at  = now()
   WHERE id = p_scenario_id;

  RETURN jsonb_build_object(
    'scenario_id',    p_scenario_id,
    'approved_at',    now(),
    'approved_by',    COALESCE(auth.jwt()->>'email', p_user_email, 'system'),
    'snap_labor',     v_labor,
    'snap_facility',  v_fac,
    'snap_utility',   v_util,
    'snap_overhead',  v_oh,
    'snap_equipment', v_eq,
    'snap_heuristics',v_heur
  );
END;
$body$;

COMMENT ON FUNCTION public.approve_scenario(bigint, text) IS
  'Approves a cost-model scenario: snapshots all rate cards + heuristics atomically, then sets status=approved. Wave BW (2026-07-23): gated to project owner (cost_model_projects.owner_id = auth.uid()) or admin — team visibility deliberately excluded (approval is a write-power); approved_by prefers the JWT email over the client-supplied p_user_email. ACLs managed by C6 (authenticated + service_role; anon/PUBLIC revoked) — never DROP this fn, always CREATE OR REPLACE.';

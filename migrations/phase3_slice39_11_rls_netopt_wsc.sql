-- phase3_slice39_11_rls_netopt_wsc.sql
-- Slice 3.9 — owner/team/visibility scoping on 3 live-tool tables.
--
-- Covers the three "real policy gap" tables from the Slice 3.8 Tier-B punchlist
-- that are backed by actual tools:
--
--   netopt_configs          (3 rows, Class A root for Network Optimizer — tools/network-opt)
--   netopt_scenario_results (0 rows, Class B child, CASCADE via config_id)
--   wsc_facility_configs    (3 rows, Class A root for Warehouse Sizing — tools/warehouse-sizing)
--
-- This extends the Slice 3.3 `my/team/shared` pattern to these three tables.
-- netopt_scenario_results JOIN-inherits from netopt_configs (the same Class B
-- trick as Slice 3.3 did for cost_model_labor etc.).
--
-- Backfill: all 6 existing rows are pre-Phase-3 rows created under code-mode
-- auth and now unowned. They're Brock's (he was the only author pre-Slice 3.5).
-- Assign to his uid, team='Solutions Design' (d3e79133), visibility='team' so
-- his team can see them from day one.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. netopt_configs — Class A (owner/team/visibility root)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.netopt_configs
  ADD COLUMN IF NOT EXISTS owner_id   UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS team_id    UUID REFERENCES public.teams(id),
  ADD COLUMN IF NOT EXISTS visibility public.visibility_level NOT NULL DEFAULT 'private';

-- Backfill existing 3 rows to Brock + Solutions Design + 'team' visibility.
UPDATE public.netopt_configs
SET owner_id   = 'db6d16c8-dfcd-4054-9b95-f2e1c304d7a9'::uuid,
    team_id    = 'd3e79133-18e5-4441-8b57-84920385cd8d'::uuid,
    visibility = 'team'
WHERE owner_id IS NULL;

-- Drop the old always-true policy.
DROP POLICY IF EXISTS netopt_configs_rw_authed ON public.netopt_configs;

-- 4 policies mirroring cost_model_projects (Slice 3.3 Class A pattern).
CREATE POLICY netopt_configs_read ON public.netopt_configs
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR (visibility = 'team'::public.visibility_level AND team_id = public.current_user_team_id())
    OR visibility = 'shared'::public.visibility_level
    OR public.current_user_is_admin()
  );

CREATE POLICY netopt_configs_insert ON public.netopt_configs
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY netopt_configs_update ON public.netopt_configs
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.current_user_is_admin());

CREATE POLICY netopt_configs_delete ON public.netopt_configs
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin());

-- ───────────────────────────────────────────────────────────────────────────
-- 2. netopt_scenario_results — Class B (JOIN-inherit via config_id)
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS netopt_scenario_results_rw_authed ON public.netopt_scenario_results;

-- Combined ALL policy using EXISTS against the parent — mirrors the
-- Slice 3.3 pattern used on project_hours, cost_model_labor, etc.
-- Using USING+WITH CHECK the same expression means the child's access
-- follows the parent's my/team/shared exactly.
CREATE POLICY netopt_scenario_results_rw ON public.netopt_scenario_results
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.netopt_configs parent
      WHERE parent.id = netopt_scenario_results.config_id
        AND (
          parent.owner_id = auth.uid()
          OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
          OR parent.visibility = 'shared'::public.visibility_level
          OR public.current_user_is_admin()
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.netopt_configs parent
      WHERE parent.id = netopt_scenario_results.config_id
        AND (
          parent.owner_id = auth.uid()
          OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
          OR parent.visibility = 'shared'::public.visibility_level
          OR public.current_user_is_admin()
        )
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 3. wsc_facility_configs — Class A (mirror of netopt_configs)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.wsc_facility_configs
  ADD COLUMN IF NOT EXISTS owner_id   UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS team_id    UUID REFERENCES public.teams(id),
  ADD COLUMN IF NOT EXISTS visibility public.visibility_level NOT NULL DEFAULT 'private';

-- Backfill 3 rows to Brock + Solutions Design + 'team'.
UPDATE public.wsc_facility_configs
SET owner_id   = 'db6d16c8-dfcd-4054-9b95-f2e1c304d7a9'::uuid,
    team_id    = 'd3e79133-18e5-4441-8b57-84920385cd8d'::uuid,
    visibility = 'team'
WHERE owner_id IS NULL;

DROP POLICY IF EXISTS wsc_facility_configs_rw_authed ON public.wsc_facility_configs;

CREATE POLICY wsc_facility_configs_read ON public.wsc_facility_configs
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR (visibility = 'team'::public.visibility_level AND team_id = public.current_user_team_id())
    OR visibility = 'shared'::public.visibility_level
    OR public.current_user_is_admin()
  );

CREATE POLICY wsc_facility_configs_insert ON public.wsc_facility_configs
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY wsc_facility_configs_update ON public.wsc_facility_configs
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.current_user_is_admin());

CREATE POLICY wsc_facility_configs_delete ON public.wsc_facility_configs
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin());

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (not applied):
-- ═══════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   DROP POLICY IF EXISTS netopt_configs_read   ON public.netopt_configs;
--   DROP POLICY IF EXISTS netopt_configs_insert ON public.netopt_configs;
--   DROP POLICY IF EXISTS netopt_configs_update ON public.netopt_configs;
--   DROP POLICY IF EXISTS netopt_configs_delete ON public.netopt_configs;
--   CREATE POLICY netopt_configs_rw_authed ON public.netopt_configs FOR ALL TO authenticated USING (true) WITH CHECK (true);
--   ALTER TABLE public.netopt_configs DROP COLUMN IF EXISTS visibility, DROP COLUMN IF EXISTS team_id, DROP COLUMN IF EXISTS owner_id;
--
--   DROP POLICY IF EXISTS netopt_scenario_results_rw ON public.netopt_scenario_results;
--   CREATE POLICY netopt_scenario_results_rw_authed ON public.netopt_scenario_results FOR ALL TO authenticated USING (true) WITH CHECK (true);
--
--   DROP POLICY IF EXISTS wsc_facility_configs_read   ON public.wsc_facility_configs;
--   DROP POLICY IF EXISTS wsc_facility_configs_insert ON public.wsc_facility_configs;
--   DROP POLICY IF EXISTS wsc_facility_configs_update ON public.wsc_facility_configs;
--   DROP POLICY IF EXISTS wsc_facility_configs_delete ON public.wsc_facility_configs;
--   CREATE POLICY wsc_facility_configs_rw_authed ON public.wsc_facility_configs FOR ALL TO authenticated USING (true) WITH CHECK (true);
--   ALTER TABLE public.wsc_facility_configs DROP COLUMN IF EXISTS visibility, DROP COLUMN IF EXISTS team_id, DROP COLUMN IF EXISTS owner_id;
-- COMMIT;

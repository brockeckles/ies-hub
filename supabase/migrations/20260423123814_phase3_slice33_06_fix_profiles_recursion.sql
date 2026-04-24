-- IES Hub — Phase 3 Slice 3.3 — Migration 06 (recursion fix)
-- Problem: profiles' SELECT policy references profiles, causing infinite recursion
--          on every authenticated query that joins through profiles.team_id.
-- Fix:     introduce two SECURITY DEFINER helpers that bypass RLS when looking up
--          the caller's team / admin status. Rewrite the profiles policies + all
--          deal policies that reference public.profiles to use the helpers.

CREATE OR REPLACE FUNCTION public.current_user_team_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT team_id FROM public.profiles WHERE id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') $$;

COMMENT ON FUNCTION public.current_user_team_id()   IS 'SECURITY DEFINER helper: returns caller''s team_id without triggering RLS on profiles.';
COMMENT ON FUNCTION public.current_user_is_admin()  IS 'SECURITY DEFINER helper: returns true if caller is admin, without triggering RLS on profiles.';

-- 1. Fix profiles policies (break the recursion)
DROP POLICY IF EXISTS profiles_select_self_or_teammate_or_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self_or_admin            ON public.profiles;

CREATE POLICY profiles_select_self_or_teammate_or_admin
  ON public.profiles FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR team_id = public.current_user_team_id()
    OR public.current_user_is_admin()
  );

CREATE POLICY profiles_update_self_or_admin
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.current_user_is_admin());

-- 2. Same fix for teams (references profiles inline)
DROP POLICY IF EXISTS teams_write_admin_only ON public.teams;
CREATE POLICY teams_write_admin_only ON public.teams FOR ALL TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

-- 3. Rewrite every deal-table / reference-table / audit_log policy that still
--    has an inline (SELECT ... FROM public.profiles ...) subquery so they use
--    the helpers. Drop-and-recreate by class.

-- Class A — Reference (the *_admin_write policies)
DO $outer$
DECLARE t text;
DECLARE class_a_tables text[] := ARRAY[
  'ref_allowance_profiles','ref_design_heuristics','ref_equipment',
  'ref_expense_lines','ref_facility_rates','ref_fleet_carrier_rates',
  'ref_fleet_dedicated_benchmarks','ref_heuristic_categories',
  'ref_labor_market_profiles','ref_labor_rates','ref_markets',
  'ref_most_elements','ref_most_templates','ref_overhead_rates',
  'ref_periods','ref_planning_ratios','ref_productivity_standards',
  'ref_revenue_lines','ref_shift_archetype_defaults','ref_utility_rates',
  'customers','pricing_assumptions'
];
BEGIN
  FOREACH t IN ARRAY class_a_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_admin_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated ' ||
      'USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin())',
      t || '_admin_write', t
    );
  END LOOP;
END $outer$;

-- audit_log SELECT
DROP POLICY IF EXISTS audit_log_select_admin ON public.audit_log;
CREATE POLICY audit_log_select_admin
  ON public.audit_log FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

-- Class C — 9 root deal tables
DO $outer$
DECLARE t text;
DECLARE deal_root_tables text[] := ARRAY[
  'cost_model_projects','opportunities','deal_deals','most_analyses',
  'fleet_scenarios','netopt_scenarios','warehouse_sizing_scenarios',
  'cog_scenarios','change_initiatives'
];
BEGIN
  FOREACH t IN ARRAY deal_root_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read',   t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (
        owner_id = auth.uid()
        OR (visibility = 'team' AND team_id = public.current_user_team_id())
        OR visibility = 'shared'
        OR public.current_user_is_admin()
      )
    $f$, t || '_read', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
      WITH CHECK (owner_id = auth.uid())
    $f$, t || '_insert', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
      USING      (owner_id = auth.uid() OR public.current_user_is_admin())
      WITH CHECK (owner_id = auth.uid() OR public.current_user_is_admin())
    $f$, t || '_update', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
      USING (owner_id = auth.uid() OR public.current_user_is_admin())
    $f$, t || '_delete', t);
  END LOOP;
END $outer$;

-- Class D — cost_model_projects children
DO $outer$
DECLARE t text;
DECLARE cmp_children text[] := ARRAY[
  'cost_model_cashflow_monthly','cost_model_equipment','cost_model_expense_monthly',
  'cost_model_labor','cost_model_overhead','cost_model_revenue_monthly',
  'cost_model_scenarios','cost_model_summary','cost_model_vas','cost_model_volumes',
  'network_optimization_scenarios'
];
BEGIN
  FOREACH t IN ARRAY cmp_children LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_rw', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.cost_model_projects parent
          WHERE parent.id = %I.project_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.cost_model_projects parent
          WHERE parent.id = %I.project_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
    $f$, t || '_rw', t, t, t);
  END LOOP;
END $outer$;

-- Class D — 2-hop (scenario → project) children
DO $outer$
DECLARE t text;
DECLARE scenario_children text[] := ARRAY['cost_model_rate_snapshots','cost_model_revisions'];
BEGIN
  FOREACH t IN ARRAY scenario_children LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_rw', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.cost_model_scenarios s
          JOIN public.cost_model_projects parent ON parent.id = s.project_id
          WHERE s.id = %I.scenario_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.cost_model_scenarios s
          JOIN public.cost_model_projects parent ON parent.id = s.project_id
          WHERE s.id = %I.scenario_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
    $f$, t || '_rw', t, t, t);
  END LOOP;
END $outer$;

-- Class D — opportunities children
DO $outer$
DECLARE i int;
DECLARE t text;
DECLARE col text;
DECLARE pairs text[][] := ARRAY[
  ARRAY['deal_artifacts','deal_id'],
  ARRAY['opportunity_tasks','opportunity_id'],
  ARRAY['project_hours','opportunity_id'],
  ARRAY['project_updates','opportunity_id']
];
BEGIN
  FOR i IN 1..array_length(pairs, 1) LOOP
    t   := pairs[i][1];
    col := pairs[i][2];

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_rw', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.opportunities parent
          WHERE parent.id = %I.%I
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.opportunities parent
          WHERE parent.id = %I.%I
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
    $f$, t || '_rw', t, t, col, t, col);
  END LOOP;
END $outer$;

-- fleet_lanes
DROP POLICY IF EXISTS fleet_lanes_rw ON public.fleet_lanes;
CREATE POLICY fleet_lanes_rw ON public.fleet_lanes FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.fleet_scenarios parent
    WHERE parent.id = fleet_lanes.scenario_id
      AND (
        parent.owner_id = auth.uid()
        OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
        OR parent.visibility = 'shared'
        OR public.current_user_is_admin()
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.fleet_scenarios parent
    WHERE parent.id = fleet_lanes.scenario_id
      AND (
        parent.owner_id = auth.uid()
        OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
        OR parent.visibility = 'shared'
        OR public.current_user_is_admin()
      )
  )
);

-- change_initiatives children
DO $outer$
DECLARE t text;
DECLARE ci_children text[] := ARRAY['change_activities','change_flowcharts'];
BEGIN
  FOREACH t IN ARRAY ci_children LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_rw', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.change_initiatives parent
          WHERE parent.id = %I.initiative_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.change_initiatives parent
          WHERE parent.id = %I.initiative_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = public.current_user_team_id())
              OR parent.visibility = 'shared'
              OR public.current_user_is_admin()
            )
        )
      )
    $f$, t || '_rw', t, t, t);
  END LOOP;
END $outer$;
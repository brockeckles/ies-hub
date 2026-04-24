-- IES Hub — Phase 3 Slice 3.3 — Migration 05 of 05 (deal-table RLS)

-- 1. Class C — The 9 root deal tables (my/team/shared)
DO $outer$
DECLARE t text;
DECLARE p text;
DECLARE deal_root_tables text[] := ARRAY[
  'cost_model_projects','opportunities','deal_deals','most_analyses',
  'fleet_scenarios','netopt_scenarios','warehouse_sizing_scenarios',
  'cog_scenarios','change_initiatives'
];
BEGIN
  FOREACH t IN ARRAY deal_root_tables LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (
        owner_id = auth.uid()
        OR (visibility = 'team' AND team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
        OR visibility = 'shared'
        OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'admin')
      )
    $f$, t || '_read', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
      WITH CHECK (owner_id = auth.uid())
    $f$, t || '_insert', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
      USING (
        owner_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'admin')
      )
      WITH CHECK (
        owner_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'admin')
      )
    $f$, t || '_update', t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (
        owner_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'admin')
      )
    $f$, t || '_delete', t);
  END LOOP;
END $outer$;

-- 2a. Children of cost_model_projects (via project_id)
DO $outer$
DECLARE t text;
DECLARE p text;
DECLARE cmp_children text[] := ARRAY[
  'cost_model_cashflow_monthly','cost_model_equipment','cost_model_expense_monthly',
  'cost_model_labor','cost_model_overhead','cost_model_revenue_monthly',
  'cost_model_scenarios','cost_model_summary','cost_model_vas','cost_model_volumes',
  'network_optimization_scenarios'
];
BEGIN
  FOREACH t IN ARRAY cmp_children LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.cost_model_projects parent
          WHERE parent.id = %I.project_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.cost_model_projects parent
          WHERE parent.id = %I.project_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
            )
        )
      )
    $f$, t || '_rw', t, t, t);
  END LOOP;
END $outer$;

-- 2b. Children of cost_model_scenarios (2-hop)
DO $outer$
DECLARE t text;
DECLARE p text;
DECLARE scenario_children text[] := ARRAY['cost_model_rate_snapshots','cost_model_revisions'];
BEGIN
  FOREACH t IN ARRAY scenario_children LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.cost_model_scenarios s
          JOIN public.cost_model_projects parent ON parent.id = s.project_id
          WHERE s.id = %I.scenario_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
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
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
            )
        )
      )
    $f$, t || '_rw', t, t, t);
  END LOOP;
END $outer$;

-- 2c. Children of opportunities
DO $outer$
DECLARE i int;
DECLARE t text;
DECLARE col text;
DECLARE p text;
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

    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.opportunities parent
          WHERE parent.id = %I.%I
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.opportunities parent
          WHERE parent.id = %I.%I
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
            )
        )
      )
    $f$, t || '_rw', t, t, col, t, col);
  END LOOP;
END $outer$;

-- 2d. fleet_lanes
DO $outer$
DECLARE p text;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='fleet_lanes' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.fleet_lanes', p);
  END LOOP;
END $outer$;

CREATE POLICY fleet_lanes_rw ON public.fleet_lanes FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.fleet_scenarios parent
    WHERE parent.id = fleet_lanes.scenario_id
      AND (
        parent.owner_id = auth.uid()
        OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
        OR parent.visibility = 'shared'
        OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.fleet_scenarios parent
    WHERE parent.id = fleet_lanes.scenario_id
      AND (
        parent.owner_id = auth.uid()
        OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
        OR parent.visibility = 'shared'
        OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
      )
  )
);

-- 2e. Children of change_initiatives
DO $outer$
DECLARE t text;
DECLARE p text;
DECLARE ci_children text[] := ARRAY['change_activities','change_flowcharts'];
BEGIN
  FOREACH t IN ARRAY ci_children LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.change_initiatives parent
          WHERE parent.id = %I.initiative_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.change_initiatives parent
          WHERE parent.id = %I.initiative_id
            AND (
              parent.owner_id = auth.uid()
              OR (parent.visibility = 'team' AND parent.team_id = (SELECT team_id FROM public.profiles WHERE id = auth.uid()))
              OR parent.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = auth.uid() AND a.role = 'admin')
            )
        )
      )
    $f$, t || '_rw', t, t, t);
  END LOOP;
END $outer$;
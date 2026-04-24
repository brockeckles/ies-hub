-- IES Hub — Phase 3 Slice 3.3 — Migration 04 of 05 (non-deal RLS)
-- Scope Tight: anon loses all sensitive reads; only audit_log INSERT, hub_alerts SELECT,
-- analytics_* telemetry, and hub_feedback INSERT remain anon-accessible.

-- 0. Pre-flight: promote Brock's dev user + flip legacy rows to shared
UPDATE public.profiles SET role = 'admin' WHERE id = 'fc0411e1-c24e-460a-b345-77950800f14a';

UPDATE public.cost_model_projects        SET visibility='shared' WHERE owner_id IS NULL;
UPDATE public.opportunities              SET visibility='shared' WHERE owner_id IS NULL;
UPDATE public.deal_deals                 SET visibility='shared' WHERE owner_id IS NULL;
UPDATE public.fleet_scenarios            SET visibility='shared' WHERE owner_id IS NULL;
UPDATE public.netopt_scenarios           SET visibility='shared' WHERE owner_id IS NULL;
UPDATE public.warehouse_sizing_scenarios SET visibility='shared' WHERE owner_id IS NULL;
UPDATE public.cog_scenarios              SET visibility='shared' WHERE owner_id IS NULL;
UPDATE public.change_initiatives         SET visibility='shared' WHERE owner_id IS NULL;

-- 1. Class A — Reference tables
DO $outer$
DECLARE t text;
DECLARE p text;
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
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_read_authed', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated ' ||
      'USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = ''admin'')) ' ||
      'WITH CHECK (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = ''admin''))',
      t || '_admin_write', t
    );
  END LOOP;
END $outer$;

-- 2. Class B — Analytical / ingest tables
DO $outer$
DECLARE t text;
DECLARE p text;
DECLARE class_b_tables text[] := ARRAY[
  'account_signals','ai_logistics_developments','automation_metrics',
  'automation_news','bts_cost_components','competitor_news',
  'construction_indices','freight_rates','fuel_prices',
  'industrial_real_estate','labor_markets','labor_summary',
  'market_freight','material_prices','pipeline_deals','pipeline_summary',
  'port_status','proposal_benchmarks','regulatory_updates',
  'reshoring_activity','reshoring_metrics','rfp_signals','steel_prices',
  'tariff_developments','union_activity','utility_rates',
  'vertical_spotlight_deals','vertical_spotlights','win_loss_factors',
  'wms_updates'
];
BEGIN
  FOREACH t IN ARRAY class_b_tables LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_read_authed', t
    );
  END LOOP;
END $outer$;

-- hub_alerts — keep anon read
DROP POLICY IF EXISTS "Allow public read" ON public.hub_alerts;
CREATE POLICY hub_alerts_read_anyone ON public.hub_alerts
  FOR SELECT TO anon, authenticated USING (true);

-- 3. Class E — Ambient deal-adjacent
DO $outer$
DECLARE t text;
DECLARE p text;
DECLARE class_e_tables text[] := ARRAY[
  'netopt_configs','netopt_scenario_results','wsc_facility_configs','general_hours'
];
BEGIN
  FOREACH t IN ARRAY class_e_tables LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_rw_authed', t
    );
  END LOOP;
END $outer$;

-- 4. Class F — hub_feedback (anon insert + authed read/update)
DROP POLICY IF EXISTS "Allow anon insert" ON public.hub_feedback;
DROP POLICY IF EXISTS "Allow anon read"   ON public.hub_feedback;
DROP POLICY IF EXISTS "Allow anon update" ON public.hub_feedback;

CREATE POLICY hub_feedback_insert_anyone
  ON public.hub_feedback FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY hub_feedback_read_authed
  ON public.hub_feedback FOR SELECT TO authenticated USING (true);
CREATE POLICY hub_feedback_update_authed
  ON public.hub_feedback FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- 5. Class G — audit_log
DROP POLICY IF EXISTS "insert_all" ON public.audit_log;
DROP POLICY IF EXISTS "read_all"   ON public.audit_log;

CREATE POLICY audit_log_insert_anyone
  ON public.audit_log FOR INSERT TO anon, authenticated
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());
CREATE POLICY audit_log_select_admin
  ON public.audit_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'admin'));
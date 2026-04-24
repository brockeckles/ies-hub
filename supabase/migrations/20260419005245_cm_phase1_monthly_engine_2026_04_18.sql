-- =====================================================================
-- CM Phase 1 — Monthly periodicity + chart-of-accounts fact tables
-- 2026-04-18
-- Source: /sessions/.../mnt/cm/phase1_schema.sql with D13-D15 amendments
-- =====================================================================

-- =====================================================================
-- 1. ref_periods — time axis (84 monthly + 24 quarterly + 10 annual)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.ref_periods (
  id                bigserial PRIMARY KEY,
  period_type       text NOT NULL DEFAULT 'month'
                    CHECK (period_type IN ('month','quarter','year')),
  period_index      integer NOT NULL,
  calendar_year     integer NOT NULL,
  calendar_month    integer NOT NULL CHECK (calendar_month BETWEEN 1 AND 12),
  customer_fy_index integer NOT NULL,
  customer_fm_index integer NOT NULL CHECK (customer_fm_index BETWEEN 1 AND 12),
  label             text NOT NULL,
  is_pre_go_live    boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_type, period_index, customer_fy_index)
);
CREATE INDEX IF NOT EXISTS idx_ref_periods_index    ON public.ref_periods (period_type, period_index);
CREATE INDEX IF NOT EXISTS idx_ref_periods_calendar ON public.ref_periods (calendar_year, calendar_month);

COMMENT ON TABLE public.ref_periods IS
  'Time-axis dimension. Project-relative period_index where 0 = go-live month. Calendar fields seeded against canonical 2020-01-01 go-live; calc layer resolves per-project absolute dates.';

-- =====================================================================
-- 2. ref_revenue_lines — chart-of-accounts (revenue)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.ref_revenue_lines (
  code         text PRIMARY KEY,
  display_name text NOT NULL,
  category     text NOT NULL
               CHECK (category IN ('fixed','variable','pass_through','deferred','as_incurred','one_time')),
  sort_order   integer NOT NULL DEFAULT 100,
  gl_account   text,
  notes        text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 3. ref_expense_lines — chart-of-accounts (expense)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.ref_expense_lines (
  code         text PRIMARY KEY,
  display_name text NOT NULL,
  category     text NOT NULL
               CHECK (category IN ('cogs','opex','sga','one_time','depreciation','interest','tax')),
  sort_order   integer NOT NULL DEFAULT 100,
  gl_account   text,
  notes        text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 4. cost_model_revenue_monthly — fact
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.cost_model_revenue_monthly (
  id                 bigserial PRIMARY KEY,
  project_id         bigint NOT NULL REFERENCES public.cost_model_projects(id) ON DELETE CASCADE,
  period_id          bigint NOT NULL REFERENCES public.ref_periods(id)         ON DELETE RESTRICT,
  revenue_line_code  text   NOT NULL REFERENCES public.ref_revenue_lines(code) ON DELETE RESTRICT,
  pricing_bucket_id  text,
  amount             numeric NOT NULL DEFAULT 0,
  volume_driver      text,
  volume_units       numeric,
  rate_applied       numeric,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, period_id, revenue_line_code, pricing_bucket_id)
);
CREATE INDEX IF NOT EXISTS idx_cmrev_project_period ON public.cost_model_revenue_monthly (project_id, period_id);
CREATE INDEX IF NOT EXISTS idx_cmrev_revenue_line  ON public.cost_model_revenue_monthly (revenue_line_code);

-- =====================================================================
-- 5. cost_model_expense_monthly — fact
-- =====================================================================
-- D14 amendment: source_line_id is intentionally nullable (e.g. for
-- 'derived' depreciation rows). UNIQUE includes source_line_table so
-- multiple derived rows per (project,period,line) collapse correctly.
-- COALESCE on source_line_id handles the NULL case so two 'derived'
-- rows with the same line code de-duplicate cleanly.
CREATE TABLE IF NOT EXISTS public.cost_model_expense_monthly (
  id                 bigserial PRIMARY KEY,
  project_id         bigint NOT NULL REFERENCES public.cost_model_projects(id) ON DELETE CASCADE,
  period_id          bigint NOT NULL REFERENCES public.ref_periods(id)         ON DELETE RESTRICT,
  expense_line_code  text   NOT NULL REFERENCES public.ref_expense_lines(code) ON DELETE RESTRICT,
  pricing_bucket_id  text,
  amount             numeric NOT NULL DEFAULT 0,
  source_line_id     bigint,
  source_line_table  text
                     CHECK (source_line_table IN (
                       'cost_model_labor','cost_model_equipment','cost_model_overhead',
                       'cost_model_vas','cost_model_projects','derived'
                     ) OR source_line_table IS NULL),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- D14 unique constraint: COALESCE on source_line_id treats NULLs as 0 so
-- (project, period, line, table, NULL) and (project, period, line, table, NULL)
-- collide rather than both being inserted.
CREATE UNIQUE INDEX IF NOT EXISTS uix_cmexp_dedupe
  ON public.cost_model_expense_monthly
     (project_id, period_id, expense_line_code, COALESCE(source_line_table,''), COALESCE(source_line_id, 0));
CREATE INDEX IF NOT EXISTS idx_cmexp_project_period ON public.cost_model_expense_monthly (project_id, period_id);
CREATE INDEX IF NOT EXISTS idx_cmexp_expense_line  ON public.cost_model_expense_monthly (expense_line_code);
CREATE INDEX IF NOT EXISTS idx_cmexp_source        ON public.cost_model_expense_monthly (source_line_table, source_line_id);

-- =====================================================================
-- 6. cost_model_cashflow_monthly — fact
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.cost_model_cashflow_monthly (
  id                       bigserial PRIMARY KEY,
  project_id               bigint NOT NULL REFERENCES public.cost_model_projects(id) ON DELETE CASCADE,
  period_id                bigint NOT NULL REFERENCES public.ref_periods(id)         ON DELETE RESTRICT,
  revenue                  numeric NOT NULL DEFAULT 0,
  opex                     numeric NOT NULL DEFAULT 0,
  gross_profit             numeric NOT NULL DEFAULT 0,
  ebitda                   numeric NOT NULL DEFAULT 0,
  ebit                     numeric NOT NULL DEFAULT 0,
  depreciation             numeric NOT NULL DEFAULT 0,
  amortization             numeric NOT NULL DEFAULT 0,
  taxes                    numeric NOT NULL DEFAULT 0,
  net_income               numeric NOT NULL DEFAULT 0,
  capex                    numeric NOT NULL DEFAULT 0,
  delta_ar                 numeric NOT NULL DEFAULT 0,
  delta_ap                 numeric NOT NULL DEFAULT 0,
  delta_labor_accrual      numeric NOT NULL DEFAULT 0,
  working_capital_change   numeric NOT NULL DEFAULT 0,
  operating_cash_flow      numeric NOT NULL DEFAULT 0,
  free_cash_flow           numeric NOT NULL DEFAULT 0,
  cumulative_cash_flow     numeric NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, period_id)
);
CREATE INDEX IF NOT EXISTS idx_cmcf_project_period ON public.cost_model_cashflow_monthly (project_id, period_id);

-- =====================================================================
-- 7. fact_pnl_monthly — read-model materialized view
-- =====================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.fact_pnl_monthly AS
SELECT
  cf.project_id,
  cf.period_id,
  p.period_index,
  p.calendar_year,
  p.calendar_month,
  p.customer_fy_index,
  p.customer_fm_index,
  p.label              AS period_label,
  p.is_pre_go_live,
  cf.revenue,
  cf.opex,
  cf.gross_profit,
  cf.ebitda,
  cf.ebit,
  cf.depreciation,
  cf.amortization,
  cf.taxes,
  cf.net_income,
  cf.capex,
  cf.working_capital_change,
  cf.operating_cash_flow,
  cf.free_cash_flow,
  cf.cumulative_cash_flow,
  (SELECT jsonb_agg(jsonb_build_object('code', revenue_line_code, 'amount', amount) ORDER BY amount DESC)
   FROM (
     SELECT revenue_line_code, SUM(amount) AS amount
     FROM public.cost_model_revenue_monthly
     WHERE project_id = cf.project_id AND period_id = cf.period_id
     GROUP BY revenue_line_code
     ORDER BY SUM(amount) DESC
     LIMIT 3
   ) t)                AS top_revenue_lines
FROM public.cost_model_cashflow_monthly cf
JOIN public.ref_periods p ON p.id = cf.period_id;

CREATE UNIQUE INDEX IF NOT EXISTS uix_fact_pnl_monthly
  ON public.fact_pnl_monthly (project_id, period_id);

-- =====================================================================
-- 8. RPC: refresh_pnl_for_project
-- =====================================================================
CREATE OR REPLACE FUNCTION public.refresh_pnl_for_project(p_project_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.fact_pnl_monthly;
END;
$$;

-- D15 amendment: GRANT EXECUTE so the browser-side anon role can call this.
GRANT EXECUTE ON FUNCTION public.refresh_pnl_for_project(bigint) TO anon, authenticated;

COMMENT ON FUNCTION public.refresh_pnl_for_project IS
  'Refresh the fact_pnl_monthly materialized view. Called by persistMonthlyFacts after writes. Concurrent so it does not block reads. GRANTed EXECUTE per D15.';

-- =====================================================================
-- 9. RLS — match existing patterns (permissive; D6 deferred-to-cross-cut)
-- =====================================================================
ALTER TABLE public.ref_periods                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ref_revenue_lines           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ref_expense_lines           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_model_revenue_monthly  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_model_expense_monthly  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_model_cashflow_monthly ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY anon_select_ref_periods ON public.ref_periods FOR SELECT TO public USING (true);
  CREATE POLICY anon_insert_ref_periods ON public.ref_periods FOR INSERT TO public WITH CHECK (true);
  CREATE POLICY anon_update_ref_periods ON public.ref_periods FOR UPDATE TO public USING (true) WITH CHECK (true);
  CREATE POLICY anon_delete_ref_periods ON public.ref_periods FOR DELETE TO public USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY anon_select_ref_revenue_lines ON public.ref_revenue_lines FOR SELECT TO public USING (true);
  CREATE POLICY anon_insert_ref_revenue_lines ON public.ref_revenue_lines FOR INSERT TO public WITH CHECK (true);
  CREATE POLICY anon_update_ref_revenue_lines ON public.ref_revenue_lines FOR UPDATE TO public USING (true) WITH CHECK (true);
  CREATE POLICY anon_delete_ref_revenue_lines ON public.ref_revenue_lines FOR DELETE TO public USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY anon_select_ref_expense_lines ON public.ref_expense_lines FOR SELECT TO public USING (true);
  CREATE POLICY anon_insert_ref_expense_lines ON public.ref_expense_lines FOR INSERT TO public WITH CHECK (true);
  CREATE POLICY anon_update_ref_expense_lines ON public.ref_expense_lines FOR UPDATE TO public USING (true) WITH CHECK (true);
  CREATE POLICY anon_delete_ref_expense_lines ON public.ref_expense_lines FOR DELETE TO public USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY public_all_cm_revenue_monthly  ON public.cost_model_revenue_monthly  FOR ALL TO public USING (true) WITH CHECK (true);
  CREATE POLICY public_all_cm_expense_monthly  ON public.cost_model_expense_monthly  FOR ALL TO public USING (true) WITH CHECK (true);
  CREATE POLICY public_all_cm_cashflow_monthly ON public.cost_model_cashflow_monthly FOR ALL TO public USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
-- 10. SEED DATA — periods + chart of accounts
-- =====================================================================
-- Periods: 84 monthly (-12..71), 24 quarterly, 10 annual
INSERT INTO public.ref_periods (period_type, period_index, calendar_year, calendar_month, customer_fy_index, customer_fm_index, label, is_pre_go_live)
SELECT
  'month',
  i,
  EXTRACT(YEAR  FROM (DATE '2020-01-01' + (i || ' months')::interval))::integer,
  EXTRACT(MONTH FROM (DATE '2020-01-01' + (i || ' months')::interval))::integer,
  CASE WHEN i < 0 THEN 0 ELSE (i / 12) + 1 END,
  CASE WHEN i < 0 THEN ((i % 12) + 12) % 12 + 1 ELSE (i % 12) + 1 END,
  CASE WHEN i < 0 THEN 'M' || i::text ELSE 'M' || (i + 1)::text END,
  i < 0
FROM generate_series(-12, 71) i
ON CONFLICT (period_type, period_index, customer_fy_index) DO NOTHING;

INSERT INTO public.ref_periods (period_type, period_index, calendar_year, calendar_month, customer_fy_index, customer_fm_index, label, is_pre_go_live)
SELECT 'quarter', q, 2020 + (q / 4), ((q % 4) * 3) + 1, (q / 4) + 1, (q % 4) + 1,
       'Y' || ((q / 4) + 1) || 'Q' || ((q % 4) + 1), false
FROM generate_series(0, 23) q
ON CONFLICT DO NOTHING;

INSERT INTO public.ref_periods (period_type, period_index, calendar_year, calendar_month, customer_fy_index, customer_fm_index, label, is_pre_go_live)
SELECT 'year', y, 2020 + y, 1, y + 1, 1, 'Y' || (y + 1), false
FROM generate_series(0, 9) y
ON CONFLICT DO NOTHING;

-- Revenue lines — 16-line chart
INSERT INTO public.ref_revenue_lines (code, display_name, category, sort_order) VALUES
  ('STORAGE',      'Storage revenue',                    'variable',     10),
  ('LABOR',        'Labor revenue',                      'variable',     20),
  ('ASSET_USE',    'Asset usage revenue',                'variable',     30),
  ('OP_LEASE',     'Operating lease revenue',            'fixed',        40),
  ('PASS_THROUGH', 'Pass-through revenue (assets)',      'pass_through', 50),
  ('EQUIPMENT',    'Equipment revenue',                  'variable',     60),
  ('SYSTEMS',      'Systems revenue',                    'variable',     70),
  ('SUPPLIES',     'Supplies, insurance & misc revenue', 'fixed',        80),
  ('PROF_SERV',    'Professional services revenue',      'as_incurred',  90),
  ('IT_INTEG',     'IT integration revenue',             'as_incurred', 100),
  ('ONBOARD',      'Onboarding revenue',                 'as_incurred', 110),
  ('DEFERRED',     'Deferred revenue (from balance)',    'deferred',    120),
  ('FIXED',        'Fixed revenue (mgmt fee)',           'fixed',       130),
  ('HANDLING',     'Handling revenue',                   'variable',    140),
  ('PRE_GO_LIVE',  'Storage pre-go-live revenue',        'one_time',    150),
  ('OTHER_REV',    'Other revenue',                      'variable',    160)
ON CONFLICT (code) DO NOTHING;

-- Expense lines — 15-line chart
INSERT INTO public.ref_expense_lines (code, display_name, category, sort_order) VALUES
  ('STORAGE_EXP',     'Storage expense',                 'opex',         10),
  ('LABOR_HOURLY',    'Hourly labor',                    'cogs',         20),
  ('LABOR_SALARY',    'Salary labor',                    'cogs',         30),
  ('LEASED_EQUIP',    'Leased equipment expense',        'opex',         40),
  ('OP_LEASE_PMT',    'Operating lease payments',        'opex',         50),
  ('SYSTEMS_EXP',     'Systems expense',                 'opex',         60),
  ('SUPPLIES_EXP',    'Supplies, insurance & misc',      'opex',         70),
  ('PROF_SERV_EXP',   'Professional services expense',   'one_time',     80),
  ('IT_INTEG_EXP',    'IT integration expense',          'one_time',     90),
  ('ONBOARD_EXP',     'Onboarding expense',              'one_time',    100),
  ('PASS_THROUGH_EXP','Pass-through expense (assets)',   'opex',        110),
  ('FACILITY',        'Facility (rent/CAM/tax/ins/util)','opex',        120),
  ('OVERHEAD',        'Overhead',                        'opex',        130),
  ('DEPRECIATION',    'Depreciation',                    'depreciation',140),
  ('AMORTIZATION',    'Amortization',                    'depreciation',150)
ON CONFLICT (code) DO NOTHING;
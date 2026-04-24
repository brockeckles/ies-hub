-- =====================================================================
-- CM Phase 0 prerequisites (per phase1_decisions.md, all defaults accepted)
-- 2026-04-18
-- =====================================================================
-- Adds the columns Phase 1 needs onto cost_model_projects, plus citation
-- columns on every ref_* table. Idempotent (IF NOT EXISTS everywhere).
-- =====================================================================

-- ---- A. cost_model_projects column adds ----
ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS scenario_label          text DEFAULT 'baseline',
  ADD COLUMN IF NOT EXISTS model_as_of_date        date DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS tax_rate_pct            numeric DEFAULT 25,
  ADD COLUMN IF NOT EXISTS discount_rate_pct       numeric DEFAULT 10,
  ADD COLUMN IF NOT EXISTS reinvest_rate_pct       numeric DEFAULT 8,
  ADD COLUMN IF NOT EXISTS dso_days                numeric DEFAULT 30,
  ADD COLUMN IF NOT EXISTS dpo_days                numeric DEFAULT 30,
  ADD COLUMN IF NOT EXISTS labor_payable_days      numeric DEFAULT 14,
  ADD COLUMN IF NOT EXISTS pre_go_live_months      integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS go_live_date            date,
  ADD COLUMN IF NOT EXISTS customer_fy_start_month integer DEFAULT 1
    CHECK (customer_fy_start_month BETWEEN 1 AND 12);

-- D13 amendment: ramp_profile_id pointer (5-point learning curve)
-- (allowance_profile_id already exists on the table — D13 is satisfied
-- by reusing it as the ramp profile pointer for the monthly engine.)

-- D13 amendment: seasonality_profile already exists; backfill flat shares
-- so existing rows produce sensible monthly values out of the gate.
UPDATE public.cost_model_projects
SET seasonality_profile = jsonb_build_object(
  'monthly_shares',
  jsonb_build_array(0.0833,0.0833,0.0833,0.0833,0.0833,0.0833,
                    0.0833,0.0833,0.0833,0.0833,0.0833,0.0837)
)
WHERE seasonality_profile IS NULL;

-- ---- B. Citation columns on ref_* tables ----
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'ref\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I
        ADD COLUMN IF NOT EXISTS source_citation text DEFAULT ''TBD'',
        ADD COLUMN IF NOT EXISTS source_date     date,
        ADD COLUMN IF NOT EXISTS source_url      text',
      rec.table_name
    );
  END LOOP;
END $$;

COMMENT ON COLUMN public.cost_model_projects.scenario_label IS
  'Scenario identifier within a deal (e.g. baseline, centralized, decentralized). Promoted to cost_model_scenarios in Phase 3.';
COMMENT ON COLUMN public.cost_model_projects.model_as_of_date IS
  'Hard-coded "as of" date. Frozen on archive. Never set from =TODAY()/now() at read time.';
COMMENT ON COLUMN public.cost_model_projects.pre_go_live_months IS
  'Number of months before go_live_date during which implementation expenses flow but revenue/labor do not.';
COMMENT ON COLUMN public.cost_model_projects.customer_fy_start_month IS
  'Calendar month (1-12) that customer FY1 begins. Used for fiscal-year alignment in reports.';
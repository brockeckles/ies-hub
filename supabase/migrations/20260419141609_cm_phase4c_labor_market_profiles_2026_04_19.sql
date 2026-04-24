
-- Phase 4c — per-market labor profile defaults.
-- Pulls turnover, temp premium, and the seasonal OT/absence shape from a
-- single reference table so labor lines can self-populate from market.
CREATE TABLE IF NOT EXISTS public.ref_labor_market_profiles (
  id                           bigserial PRIMARY KEY,
  market_id                    uuid UNIQUE REFERENCES public.ref_markets(id) ON DELETE CASCADE,
  turnover_pct_annual          numeric NOT NULL DEFAULT 30,
  temp_cost_premium_pct        numeric NOT NULL DEFAULT 20,
  peak_month_overtime_pct      jsonb   NOT NULL DEFAULT '[0.05,0.05,0.05,0.05,0.05,0.07,0.07,0.08,0.10,0.12,0.12,0.08]'::jsonb,
  peak_month_absence_pct       jsonb   NOT NULL DEFAULT '[0.10,0.10,0.10,0.10,0.10,0.11,0.12,0.12,0.10,0.10,0.11,0.12]'::jsonb,
  holiday_days_per_year        integer NOT NULL DEFAULT 11,
  notes                        text,
  source_citation              text DEFAULT 'IES Hub standard',
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_labor_mkt_profiles_market ON public.ref_labor_market_profiles(market_id);

ALTER TABLE public.ref_labor_market_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS labor_mkt_profiles_rw ON public.ref_labor_market_profiles;
CREATE POLICY labor_mkt_profiles_rw ON public.ref_labor_market_profiles FOR ALL
  USING (true) WITH CHECK (true);

-- Seed: 18 market profiles. Defaults reflect industry realities:
-- - High-heat Sun Belt: summer absence bumps
-- - Northeast: lower turnover, lower temp premium (less labor scarcity for now)
-- - Retail-heavy markets: stronger Q4 OT lift
-- - Logistics hubs (Memphis, Indianapolis, Inland Empire): higher turnover, higher temp premium
INSERT INTO public.ref_labor_market_profiles
  (market_id, turnover_pct_annual, temp_cost_premium_pct, peak_month_overtime_pct, peak_month_absence_pct, holiday_days_per_year, notes)
SELECT id, 30, 20,
  '[0.05,0.05,0.05,0.05,0.05,0.07,0.07,0.08,0.10,0.12,0.12,0.08]'::jsonb,
  '[0.10,0.10,0.10,0.10,0.10,0.11,0.12,0.12,0.10,0.10,0.11,0.12]'::jsonb,
  11, 'Default IES baseline'
FROM public.ref_markets
ON CONFLICT (market_id) DO NOTHING;

-- Tune logistics-hub markets up
UPDATE public.ref_labor_market_profiles
   SET turnover_pct_annual = 38,
       temp_cost_premium_pct = 25,
       notes = 'Logistics hub — higher turnover + temp premium'
 WHERE market_id IN (
   SELECT id FROM public.ref_markets
   WHERE name IN ('Memphis','Indianapolis','Inland Empire, CA','Columbus, OH','Central PA')
 );

-- Sun Belt summer absence bump
UPDATE public.ref_labor_market_profiles
   SET peak_month_absence_pct = '[0.10,0.10,0.10,0.11,0.12,0.13,0.14,0.14,0.12,0.10,0.10,0.11]'::jsonb,
       notes = COALESCE(notes,'') || ' · Summer absence bump'
 WHERE market_id IN (
   SELECT id FROM public.ref_markets
   WHERE name IN ('Phoenix','Houston','Dallas–Fort Worth','Miami')
 );

-- Northeast: lower turnover, mild Q4 only
UPDATE public.ref_labor_market_profiles
   SET turnover_pct_annual = 24,
       temp_cost_premium_pct = 15,
       peak_month_overtime_pct = '[0.04,0.04,0.04,0.04,0.04,0.05,0.05,0.06,0.08,0.10,0.10,0.06]'::jsonb,
       notes = 'Northeast — lower turnover'
 WHERE market_id IN (
   SELECT id FROM public.ref_markets
   WHERE name IN ('New York','Philadelphia')
 );


-- Dedicated-fleet benchmark $/mile by vehicle type + market, for use as a
-- reference during RFP build-out (what's the market rate for a dedicated
-- dry-van fleet in DFW?). Dedicated is fully cost-plus in the calc; this
-- table is reference data, not a cost driver.
CREATE TABLE IF NOT EXISTS public.ref_fleet_dedicated_benchmarks (
  id                bigserial PRIMARY KEY,
  market_id         uuid REFERENCES public.ref_markets(id) ON DELETE CASCADE,
  vehicle_type      text NOT NULL,
  benchmark_per_mile numeric NOT NULL,
  low_band_per_mile  numeric,
  high_band_per_mile numeric,
  source_citation   text DEFAULT 'ATRI 2025 Ops Costs of Trucking',
  effective_date    date DEFAULT CURRENT_DATE,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(market_id, vehicle_type, effective_date)
);
CREATE INDEX IF NOT EXISTS idx_fleet_dedicated_bench_market ON public.ref_fleet_dedicated_benchmarks(market_id);

ALTER TABLE public.ref_fleet_dedicated_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fleet_dedicated_bench_rw ON public.ref_fleet_dedicated_benchmarks;
CREATE POLICY fleet_dedicated_bench_rw ON public.ref_fleet_dedicated_benchmarks FOR ALL
  USING (true) WITH CHECK (true);

-- Seed with national benchmarks (ATRI 2025 averages) for the 18 markets we have.
INSERT INTO public.ref_fleet_dedicated_benchmarks (market_id, vehicle_type, benchmark_per_mile, low_band_per_mile, high_band_per_mile, notes)
SELECT id, 'dry_van', 2.15, 1.85, 2.50, 'National baseline, adjust per market by ±10%'
  FROM public.ref_markets
ON CONFLICT (market_id, vehicle_type, effective_date) DO NOTHING;

INSERT INTO public.ref_fleet_dedicated_benchmarks (market_id, vehicle_type, benchmark_per_mile, low_band_per_mile, high_band_per_mile, notes)
SELECT id, 'reefer', 2.65, 2.30, 3.00, 'Refrigerated premium over dry van'
  FROM public.ref_markets
ON CONFLICT (market_id, vehicle_type, effective_date) DO NOTHING;

INSERT INTO public.ref_fleet_dedicated_benchmarks (market_id, vehicle_type, benchmark_per_mile, low_band_per_mile, high_band_per_mile, notes)
SELECT id, 'flatbed', 2.90, 2.50, 3.35, 'Flatbed / open deck'
  FROM public.ref_markets
ON CONFLICT (market_id, vehicle_type, effective_date) DO NOTHING;


-- Phase 4a — Labor sophistication: temp/perm employment mix
ALTER TABLE public.cost_model_labor
  ADD COLUMN IF NOT EXISTS employment_type text NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent','temp_agency','contractor')),
  ADD COLUMN IF NOT EXISTS temp_agency_markup_pct numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retention_mix_pct numeric;

COMMENT ON COLUMN public.cost_model_labor.employment_type IS
  'Phase 4a: classification drives markup + turnover modeling';
COMMENT ON COLUMN public.cost_model_labor.temp_agency_markup_pct IS
  'Phase 4a: fractional markup on hourly_rate for temp_agency lines (0 = none, 25 = +25%)';
COMMENT ON COLUMN public.cost_model_labor.retention_mix_pct IS
  'Phase 4a (reserved): percent of total headcount retained long-term; feeds Phase 4b turnover';

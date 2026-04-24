
ALTER TABLE public.cost_model_labor
  ADD COLUMN IF NOT EXISTS performance_variance_pct numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.cost_model_labor.performance_variance_pct IS
  'Phase 4e: labor productivity variance (% std dev). Feeds Monte-Carlo sensitivity band on Summary. 0 = deterministic.';

-- Linkage columns for "Stand-alone vs Linked" badge on tool landing pages.
-- Each scenario can optionally point to the cost model and/or deal it was
-- created from / bound to. Both nullable; a NULL pair means Stand-alone.

ALTER TABLE public.wsc_facility_configs
  ADD COLUMN IF NOT EXISTS parent_cost_model_id bigint,
  ADD COLUMN IF NOT EXISTS parent_deal_id text;

ALTER TABLE public.netopt_configs
  ADD COLUMN IF NOT EXISTS parent_cost_model_id bigint,
  ADD COLUMN IF NOT EXISTS parent_deal_id text;

ALTER TABLE public.cog_scenarios
  ADD COLUMN IF NOT EXISTS parent_cost_model_id bigint,
  ADD COLUMN IF NOT EXISTS parent_deal_id text;

ALTER TABLE public.most_analyses
  ADD COLUMN IF NOT EXISTS parent_cost_model_id bigint,
  ADD COLUMN IF NOT EXISTS parent_deal_id text;

ALTER TABLE public.fleet_scenarios
  ADD COLUMN IF NOT EXISTS parent_cost_model_id bigint,
  ADD COLUMN IF NOT EXISTS parent_deal_id text;

-- cost_model_projects keeps its existing deal_id column; add parent_deal_id
-- as a text alias so the landing-page code can use a consistent field name.
ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS parent_deal_id text;

-- Useful index for the reverse-lookup "scenarios linked to this CM" query.
CREATE INDEX IF NOT EXISTS idx_wsc_parent_cm ON public.wsc_facility_configs(parent_cost_model_id) WHERE parent_cost_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_netopt_parent_cm ON public.netopt_configs(parent_cost_model_id) WHERE parent_cost_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cog_parent_cm ON public.cog_scenarios(parent_cost_model_id) WHERE parent_cost_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_most_parent_cm ON public.most_analyses(parent_cost_model_id) WHERE parent_cost_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fleet_parent_cm ON public.fleet_scenarios(parent_cost_model_id) WHERE parent_cost_model_id IS NOT NULL;

-- Add missing columns to cost_model_projects for v3 api.js contract.
-- Additive only; v2 continues to work with existing columns.
ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS project_data jsonb;

-- COG scenarios (Center of Gravity)
CREATE TABLE IF NOT EXISTS public.cog_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  scenario_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cog_scenarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cog_scenarios_all ON public.cog_scenarios;
CREATE POLICY cog_scenarios_all ON public.cog_scenarios
  FOR ALL TO public USING (true) WITH CHECK (true);

-- MOST Labor Standards — saved analyses
CREATE TABLE IF NOT EXISTS public.most_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  pfd_pct numeric,
  shift_hours numeric,
  operating_days integer,
  hourly_rate numeric,
  allowance_profile_id bigint REFERENCES public.ref_allowance_profiles(id) ON DELETE SET NULL,
  analysis_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.most_analyses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS most_analyses_all ON public.most_analyses;
CREATE POLICY most_analyses_all ON public.most_analyses
  FOR ALL TO public USING (true) WITH CHECK (true);

-- WSC facility configs (v3 wrapper — stores full config blob)
CREATE TABLE IF NOT EXISTS public.wsc_facility_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  config_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wsc_facility_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wsc_facility_configs_all ON public.wsc_facility_configs;
CREATE POLICY wsc_facility_configs_all ON public.wsc_facility_configs
  FOR ALL TO public USING (true) WITH CHECK (true);

-- NetOpt configs (v3 wrapper — stores full network config blob)
CREATE TABLE IF NOT EXISTS public.netopt_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  config_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.netopt_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS netopt_configs_all ON public.netopt_configs;
CREATE POLICY netopt_configs_all ON public.netopt_configs
  FOR ALL TO public USING (true) WITH CHECK (true);

-- NetOpt scenario results (linked to a config)
CREATE TABLE IF NOT EXISTS public.netopt_scenario_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid REFERENCES public.netopt_configs(id) ON DELETE CASCADE,
  name text,
  result_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.netopt_scenario_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS netopt_scenario_results_all ON public.netopt_scenario_results;
CREATE POLICY netopt_scenario_results_all ON public.netopt_scenario_results
  FOR ALL TO public USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS netopt_scenario_results_config_idx
  ON public.netopt_scenario_results(config_id);

-- updated_at trigger (shared helper; create if not present)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cog_scenarios_updated ON public.cog_scenarios;
CREATE TRIGGER trg_cog_scenarios_updated BEFORE UPDATE ON public.cog_scenarios
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_most_analyses_updated ON public.most_analyses;
CREATE TRIGGER trg_most_analyses_updated BEFORE UPDATE ON public.most_analyses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_wsc_facility_configs_updated ON public.wsc_facility_configs;
CREATE TRIGGER trg_wsc_facility_configs_updated BEFORE UPDATE ON public.wsc_facility_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_netopt_configs_updated ON public.netopt_configs;
CREATE TRIGGER trg_netopt_configs_updated BEFORE UPDATE ON public.netopt_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Add per-project override jsonb column. Separate from heuristic_overrides so
-- the existing 26-heuristic system remains untouched.
ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS planning_ratio_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.cost_model_projects.planning_ratio_overrides IS
  'Per-project overrides for ref_planning_ratios rows. Keyed by ratio_code. Shape: {"indirect.team_lead.span": {"value": 18, "note": "Tight floor layout"}}';

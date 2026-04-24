ALTER TABLE cost_model_projects
  ADD COLUMN IF NOT EXISTS facility_rate_overrides JSONB DEFAULT '{}';
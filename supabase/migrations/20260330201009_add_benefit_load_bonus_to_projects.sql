ALTER TABLE cost_model_projects ADD COLUMN IF NOT EXISTS benefit_load_pct numeric DEFAULT 35;
ALTER TABLE cost_model_projects ADD COLUMN IF NOT EXISTS bonus_pct numeric DEFAULT 0;
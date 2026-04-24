ALTER TABLE cost_model_equipment
  ADD COLUMN IF NOT EXISTS ownership_type VARCHAR DEFAULT 'lease',
  ADD COLUMN IF NOT EXISTS maintenance_pct NUMERIC DEFAULT 0.10;
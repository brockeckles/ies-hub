
-- 1. UOM + complexity tier on labor lines
ALTER TABLE cost_model_labor 
ADD COLUMN IF NOT EXISTS uom text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS complexity_tier text DEFAULT 'medium';

-- 2. Labor cost buildup defaults on reference tables
ALTER TABLE ref_labor_rates 
ADD COLUMN IF NOT EXISTS default_benefit_load_pct numeric DEFAULT 35,
ADD COLUMN IF NOT EXISTS default_bonus_pct numeric DEFAULT 0;

ALTER TABLE ref_markets 
ADD COLUMN IF NOT EXISTS default_overtime_pct numeric DEFAULT 5;

-- 3. Project-level overrides: overtime, ramp weeks, seasonality
ALTER TABLE cost_model_projects 
ADD COLUMN IF NOT EXISTS overtime_pct numeric DEFAULT 5,
ADD COLUMN IF NOT EXISTS ramp_weeks_low integer DEFAULT 2,
ADD COLUMN IF NOT EXISTS ramp_weeks_med integer DEFAULT 4,
ADD COLUMN IF NOT EXISTS ramp_weeks_high integer DEFAULT 8,
ADD COLUMN IF NOT EXISTS seasonality_profile jsonb DEFAULT NULL;

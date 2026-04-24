-- 1) Add annual escalation column to both ref catalogs
ALTER TABLE ref_equipment
  ADD COLUMN IF NOT EXISTS annual_escalation_pct NUMERIC(5,2) DEFAULT 3.00;

ALTER TABLE ref_labor_rates
  ADD COLUMN IF NOT EXISTS annual_escalation_pct NUMERIC(5,2) DEFAULT 4.00;

-- 2) Create pricing_assumptions table for multi-year inflation factors
CREATE TABLE IF NOT EXISTS pricing_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  scope_key text,
  metric text NOT NULL,
  year_1_pct NUMERIC(5,2) DEFAULT 3.00,
  year_2_pct NUMERIC(5,2) DEFAULT 3.00,
  year_3_pct NUMERIC(5,2) DEFAULT 3.00,
  year_4_pct NUMERIC(5,2) DEFAULT 3.00,
  year_5_pct NUMERIC(5,2) DEFAULT 3.00,
  effective_date date DEFAULT CURRENT_DATE,
  notes text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE (scope, scope_key, metric)
);

ALTER TABLE pricing_assumptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pricing_assumptions_read ON pricing_assumptions;
CREATE POLICY pricing_assumptions_read
  ON pricing_assumptions FOR SELECT
  USING (true);

DROP POLICY IF EXISTS pricing_assumptions_write ON pricing_assumptions;
CREATE POLICY pricing_assumptions_write
  ON pricing_assumptions FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

COMMENT ON TABLE pricing_assumptions IS 'Out-year escalation factors (CPI/wage growth) applied to ref_equipment and ref_labor_rates in multi-year cost models. Scope=global is the fallback; category-specific rows override.';
COMMENT ON COLUMN ref_equipment.annual_escalation_pct IS 'Per-row default annual capex/maintenance escalation %. CM app falls back to pricing_assumptions if unset.';
COMMENT ON COLUMN ref_labor_rates.annual_escalation_pct IS 'Per-row default annual wage escalation %. CM app falls back to pricing_assumptions if unset.';
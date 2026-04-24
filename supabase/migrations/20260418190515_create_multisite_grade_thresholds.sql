
CREATE TABLE IF NOT EXISTS ref_multisite_grade_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL DEFAULT 'default',
  metric_name TEXT NOT NULL,
  min_value NUMERIC,
  target_value NUMERIC,
  max_value NUMERIC,
  weight_pct NUMERIC DEFAULT 25,
  label TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO ref_multisite_grade_thresholds (org_id, metric_name, min_value, target_value, max_value, weight_pct, label) VALUES
  ('default', 'grossMarginPct', 8, 12, NULL, 35, 'Gross Margin'),
  ('default', 'ebitdaPct', 4, 8, NULL, 25, 'EBITDA Margin'),
  ('default', 'paybackMonths', NULL, 18, 24, 20, 'Payback Period'),
  ('default', 'costPerSqft', NULL, 12, 18, 20, 'Cost/SqFt')
ON CONFLICT DO NOTHING;

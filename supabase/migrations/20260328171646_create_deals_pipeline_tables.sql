
-- ═══════════════════════════════════════════════════
-- DEALS & PIPELINE SUPPORT (DOS Integration)
-- ═══════════════════════════════════════════════════

-- Pipeline deals (mirrors DOS data — will connect to live DOS in Phase 2)
CREATE TABLE pipeline_deals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deal_name TEXT NOT NULL,
  account_name TEXT,
  vertical industry_vertical NOT NULL,
  stage deal_stage NOT NULL,
  tcv NUMERIC(14,2),                                  -- total contract value
  annual_revenue NUMERIC(14,2),
  market TEXT,                                         -- MSA or region
  cycle_time_days INT,
  assigned_to TEXT,
  created_date DATE,
  last_stage_change DATE,
  expected_close_date DATE,
  win_probability NUMERIC(5,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Proposal benchmarks by vertical (aggregated from DOS)
CREATE TABLE proposal_benchmarks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vertical industry_vertical NOT NULL,
  avg_deal_size NUMERIC(14,2),
  avg_cycle_time_days INT,
  close_rate NUMERIC(5,2),
  win_trend trend_direction DEFAULT 'stable',
  period TEXT NOT NULL,                                -- 'TTM', 'Q1 2026', etc.
  sample_size INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vertical, period)
);

-- Win/loss pattern analysis
CREATE TABLE win_loss_factors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  factor_type TEXT NOT NULL,                           -- 'win' or 'loss'
  factor_description TEXT NOT NULL,
  impact_pct NUMERIC(5,2) NOT NULL,                    -- e.g. +18 or -22
  rank INT,
  period TEXT NOT NULL,
  sample_size INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pipeline summary metrics
CREATE TABLE pipeline_summary (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metric_name TEXT NOT NULL,                           -- 'Active Pipeline', 'Avg Deal Size (TTM)', 'Close Rate (TTM)'
  metric_value NUMERIC(14,2) NOT NULL,
  metric_unit TEXT NOT NULL,
  period_change TEXT,
  as_of_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(metric_name, as_of_date)
);

-- Vertical spotlights (rotating industry deep-dives)
CREATE TABLE vertical_spotlights (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vertical industry_vertical NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT,
  pipeline_value NUMERIC(14,2),
  active_opportunities INT,
  close_rate NUMERIC(5,2),
  as_of_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vertical spotlight deals (top opportunities per vertical)
CREATE TABLE vertical_spotlight_deals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  spotlight_id BIGINT REFERENCES vertical_spotlights(id) ON DELETE CASCADE,
  deal_description TEXT NOT NULL,
  stage deal_stage NOT NULL,
  tcv NUMERIC(14,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Hub alerts (cross-domain, surfaced in command center)
CREATE TABLE hub_alerts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain intel_domain NOT NULL,
  severity severity_level NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  source_table TEXT,                                   -- which table this alert was derived from
  source_id BIGINT,                                    -- row ID in that table
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE TRIGGER update_pipeline_deals_updated_at
  BEFORE UPDATE ON pipeline_deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_deals_vertical ON pipeline_deals(vertical);
CREATE INDEX idx_deals_stage ON pipeline_deals(stage);
CREATE INDEX idx_deals_market ON pipeline_deals(market);
CREATE INDEX idx_alerts_domain ON hub_alerts(domain);
CREATE INDEX idx_alerts_active ON hub_alerts(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_alerts_severity ON hub_alerts(severity);

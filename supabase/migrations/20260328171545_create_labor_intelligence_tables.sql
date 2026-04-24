
-- ═══════════════════════════════════════════════════
-- LABOR INTELLIGENCE
-- ═══════════════════════════════════════════════════

-- Wage rates and labor availability by MSA
CREATE TABLE labor_markets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  msa TEXT NOT NULL,                                  -- Metropolitan Statistical Area
  avg_warehouse_wage NUMERIC(6,2) NOT NULL,
  availability_status TEXT NOT NULL,                   -- 'Available', 'Moderate', 'Tight'
  availability_score INT CHECK (availability_score BETWEEN 0 AND 100),
  trend trend_direction DEFAULT 'stable',
  avg_time_to_fill_days INT,
  turnover_rate NUMERIC(5,2),
  as_of_date DATE NOT NULL,
  source TEXT DEFAULT 'BLS OEWS + proprietary model',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(msa, as_of_date)
);

-- National labor summary metrics
CREATE TABLE labor_summary (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metric_name TEXT NOT NULL,                          -- 'Nat''l Avg Warehouse Wage', 'Avg Time to Fill', etc.
  metric_value NUMERIC(10,2) NOT NULL,
  metric_unit TEXT NOT NULL,                          -- '/hr', 'days', '%', etc.
  period_change NUMERIC(6,2),
  period_label TEXT,                                  -- 'QoQ', 'YoY', etc.
  as_of_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(metric_name, as_of_date)
);

-- Union activity tracker
CREATE TABLE union_activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_description TEXT NOT NULL,                    -- 'Teamsters Local 767 — Amazon'
  union_name TEXT,
  company TEXT,
  location TEXT NOT NULL,
  status TEXT NOT NULL,                               -- 'Filed', 'Organizing', 'Negotiating', 'Strike vote', 'Ratified'
  impact severity_level DEFAULT 'medium',
  details TEXT,
  event_date DATE,
  source TEXT DEFAULT 'NLRB',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- OSHA / regulatory developments
CREATE TABLE regulatory_updates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  agency TEXT NOT NULL,                               -- 'OSHA', 'DOL', 'EPA', etc.
  effective_date DATE,
  impact severity_level DEFAULT 'medium',
  domain intel_domain DEFAULT 'labor',
  relevance_notes TEXT,                               -- why it matters for IES
  source_url TEXT,
  published_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_union_activity_updated_at
  BEFORE UPDATE ON union_activity
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_labor_markets_msa ON labor_markets(msa);
CREATE INDEX idx_union_activity_status ON union_activity(status);
CREATE INDEX idx_regulatory_agency ON regulatory_updates(agency);

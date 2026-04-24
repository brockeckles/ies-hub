
-- ═══════════════════════════════════════════════════
-- MACRO & TRADE
-- ═══════════════════════════════════════════════════

-- Freight rate indices (DAT, Freightos, Drewry)
CREATE TABLE freight_rates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  index_name TEXT NOT NULL,                           -- 'DAT Spot Van', 'DAT Contract Van', 'Freightos FBX', 'Drewry WCI'
  rate NUMERIC(10,2) NOT NULL,
  unit TEXT NOT NULL,                                 -- '/mi', '/FEU'
  report_date DATE NOT NULL,
  wow_change NUMERIC(6,2),
  mom_change NUMERIC(6,2),
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(index_name, report_date)
);

-- Tariff developments tracker
CREATE TABLE tariff_developments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,                               -- 'NEW', 'ACTIVE', 'WATCH', 'EXPIRED'
  impact severity_level DEFAULT 'medium',
  affected_categories TEXT[],                          -- product categories affected
  tariff_rate TEXT,                                    -- e.g. '15%', '25%'
  effective_date DATE,
  source TEXT,
  source_url TEXT,
  published_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Port congestion / disruption tracker
CREATE TABLE port_status (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  port_name TEXT NOT NULL,
  avg_dwell_days NUMERIC(4,1) NOT NULL,
  status TEXT NOT NULL,                               -- 'Normal', 'Moderate', 'Elevated', 'Critical'
  delta_vs_normal NUMERIC(4,1),
  report_date DATE NOT NULL,
  source TEXT DEFAULT 'MarineTraffic',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(port_name, report_date)
);

-- Nearshoring / reshoring activity
CREATE TABLE reshoring_activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  headline TEXT NOT NULL,
  summary TEXT,
  company TEXT,
  location TEXT,
  sector TEXT,
  estimated_jobs INT,
  investment_amount TEXT,
  tags TEXT[] DEFAULT '{}',
  published_date DATE NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reshoring summary metrics
CREATE TABLE reshoring_metrics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metric_name TEXT NOT NULL,
  metric_value NUMERIC(12,2) NOT NULL,
  metric_unit TEXT NOT NULL,
  period_change TEXT,
  as_of_date DATE NOT NULL,
  source TEXT DEFAULT 'Reshoring Initiative',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(metric_name, as_of_date)
);

CREATE INDEX idx_freight_rates_index ON freight_rates(index_name);
CREATE INDEX idx_freight_rates_date ON freight_rates(report_date DESC);
CREATE INDEX idx_tariff_status ON tariff_developments(status);
CREATE INDEX idx_port_status_port ON port_status(port_name);
CREATE INDEX idx_reshoring_sector ON reshoring_activity(sector);

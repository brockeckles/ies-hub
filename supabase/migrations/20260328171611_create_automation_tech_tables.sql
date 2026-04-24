
-- ═══════════════════════════════════════════════════
-- AUTOMATION & TECHNOLOGY
-- ═══════════════════════════════════════════════════

-- AMR / robotics vendor news
CREATE TABLE automation_news (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor TEXT NOT NULL,                               -- 'Symbotic', 'Locus', 'Geek+', '6 River Systems'
  headline TEXT NOT NULL,
  summary TEXT,
  tags TEXT[] DEFAULT '{}',
  relevance severity_level DEFAULT 'medium',
  source TEXT,
  source_url TEXT,
  published_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- WMS / WCS platform updates
CREATE TABLE wms_updates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform TEXT NOT NULL,                             -- 'Blue Yonder WMS', 'Manhattan Active WM'
  update_description TEXT NOT NULL,
  version TEXT,
  impact severity_level DEFAULT 'medium',
  release_date DATE,
  relevance_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI in logistics developments
CREATE TABLE ai_logistics_developments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  headline TEXT NOT NULL,
  summary TEXT,
  category TEXT NOT NULL,                             -- 'Agentic AI', 'Computer Vision', 'NLP', 'Predictive'
  tags TEXT[] DEFAULT '{}',
  roi_impact TEXT,                                    -- quantified impact if available
  source TEXT,
  source_url TEXT,
  published_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Automation summary metrics
CREATE TABLE automation_metrics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metric_name TEXT NOT NULL,                          -- 'AMR Deployments (Industry)', 'Avg AMR ROI Payback'
  metric_value NUMERIC(12,2) NOT NULL,
  metric_unit TEXT NOT NULL,
  period_change TEXT,
  as_of_date DATE NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(metric_name, as_of_date)
);

CREATE INDEX idx_automation_news_vendor ON automation_news(vendor);
CREATE INDEX idx_automation_news_date ON automation_news(published_date DESC);
CREATE INDEX idx_wms_platform ON wms_updates(platform);
CREATE INDEX idx_ai_dev_category ON ai_logistics_developments(category);

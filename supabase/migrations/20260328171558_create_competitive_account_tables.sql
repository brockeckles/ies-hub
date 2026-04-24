
-- ═══════════════════════════════════════════════════
-- COMPETITIVE & ACCOUNT INTELLIGENCE
-- ═══════════════════════════════════════════════════

-- 3PL competitor news feed
CREATE TABLE competitor_news (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competitor TEXT NOT NULL,                            -- 'DHL Supply Chain', 'Ryder', 'XPO', 'CEVA'
  headline TEXT NOT NULL,
  summary TEXT,
  tags TEXT[] DEFAULT '{}',                            -- ['DFW MARKET', 'TECH', 'LOSS']
  relevance severity_level DEFAULT 'medium',
  source TEXT,
  source_url TEXT,
  published_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Strategic account intelligence
CREATE TABLE account_signals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_name TEXT NOT NULL,
  signal_type TEXT NOT NULL,                           -- 'Leadership Change', 'M&A', 'Cost Restructuring'
  detail TEXT NOT NULL,
  relevance severity_level DEFAULT 'medium',
  recommended_action TEXT,
  signal_date DATE NOT NULL,
  vertical industry_vertical,
  source TEXT,
  source_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RFP signal tracker
CREATE TABLE rfp_signals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company TEXT NOT NULL,
  signal_type TEXT NOT NULL,                           -- 'Leadership Change', 'Facility Expansion', '10-K Commentary'
  detail TEXT NOT NULL,
  confidence INT CHECK (confidence BETWEEN 1 AND 4),  -- 1-4 dots
  estimated_timeline TEXT,                             -- '3-6 months', '1-3 months'
  vertical industry_vertical,
  status TEXT DEFAULT 'active',                        -- 'active', 'converted', 'expired'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_rfp_signals_updated_at
  BEFORE UPDATE ON rfp_signals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_competitor_news_competitor ON competitor_news(competitor);
CREATE INDEX idx_competitor_news_date ON competitor_news(published_date DESC);
CREATE INDEX idx_account_signals_account ON account_signals(account_name);
CREATE INDEX idx_rfp_signals_company ON rfp_signals(company);
CREATE INDEX idx_rfp_signals_vertical ON rfp_signals(vertical);

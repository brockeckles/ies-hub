
CREATE TABLE master_verticals (
  id BIGSERIAL PRIMARY KEY,
  vertical_name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_vertical_id BIGINT REFERENCES master_verticals(id) ON DELETE SET NULL,
  gxo_focus_level TEXT CHECK (gxo_focus_level IN ('high', 'medium', 'low')) DEFAULT 'medium',
  estimated_market_size NUMERIC,
  gxo_revenue_target NUMERIC,
  key_accounts_count INTEGER,
  status TEXT CHECK (status IN ('active', 'inactive')) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_master_verticals_parent ON master_verticals(parent_vertical_id);
CREATE INDEX idx_master_verticals_focus ON master_verticals(gxo_focus_level);
CREATE INDEX idx_master_verticals_status ON master_verticals(status);

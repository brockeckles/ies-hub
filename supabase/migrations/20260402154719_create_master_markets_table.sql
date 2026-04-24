
CREATE TABLE master_markets (
  id BIGSERIAL PRIMARY KEY,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('Northeast', 'Midwest', 'Southeast', 'Southwest', 'West')),
  market_tier TEXT NOT NULL CHECK (market_tier IN ('Tier 1', 'Tier 2', 'Tier 3')),
  metro_area TEXT,
  estimated_population BIGINT,
  gxo_presence TEXT CHECK (gxo_presence IN ('yes', 'no', 'planned')),
  wage_index NUMERIC,
  power_cost_estimate NUMERIC,
  real_estate_cost_tier TEXT CHECK (real_estate_cost_tier IN ('high', 'medium', 'low')),
  notes TEXT,
  status TEXT CHECK (status IN ('active', 'inactive')) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(city, state)
);

CREATE INDEX idx_master_markets_region ON master_markets(region);
CREATE INDEX idx_master_markets_tier ON master_markets(market_tier);
CREATE INDEX idx_master_markets_gxo_presence ON master_markets(gxo_presence);
CREATE INDEX idx_master_markets_status ON master_markets(status);

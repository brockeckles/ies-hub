
-- ═══════════════════════════════════════════════════
-- MARKET & COST INTELLIGENCE
-- ═══════════════════════════════════════════════════

-- Fuel / diesel index (EIA weekly petroleum report)
CREATE TABLE fuel_prices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_date DATE NOT NULL,
  fuel_type TEXT NOT NULL DEFAULT 'diesel',          -- diesel, gasoline, etc.
  price_per_gallon NUMERIC(6,3) NOT NULL,
  week_over_week_change NUMERIC(6,3),
  percentile_52wk NUMERIC(5,2),                      -- where it sits in 52-week range
  source TEXT NOT NULL DEFAULT 'EIA',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(report_date, fuel_type)
);

-- Industrial real estate rates by market
CREATE TABLE industrial_real_estate (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market TEXT NOT NULL,                               -- e.g. "Inland Empire, CA"
  quarter TEXT NOT NULL,                              -- e.g. "Q1 2026"
  lease_rate_psf NUMERIC(6,2) NOT NULL,              -- per square foot per year
  vacancy_rate NUMERIC(5,2),
  yoy_change NUMERIC(6,2),
  trend trend_direction DEFAULT 'stable',
  source TEXT DEFAULT 'CBRE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(market, quarter)
);

-- Construction cost indices
CREATE TABLE construction_indices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  index_name TEXT NOT NULL,                           -- 'Turner', 'Gordian RSMeans'
  quarter TEXT NOT NULL,
  index_value NUMERIC(8,2) NOT NULL,
  qoq_change NUMERIC(6,2),
  yoy_change NUMERIC(6,2),
  base_year TEXT,                                     -- e.g. "1967 = 100"
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(index_name, quarter)
);

-- Build-to-suit cost components
CREATE TABLE bts_cost_components (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component TEXT NOT NULL,                            -- 'Shell (tilt-up, 36'' clear)'
  cost_per_sf_low NUMERIC(8,2) NOT NULL,
  cost_per_sf_high NUMERIC(8,2) NOT NULL,
  trend trend_direction DEFAULT 'stable',
  as_of_date DATE NOT NULL,
  source TEXT DEFAULT 'Gordian RSMeans + Turner',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Utility rates by region
CREATE TABLE utility_rates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region TEXT NOT NULL,                               -- EIA region or state
  rate_cents_kwh NUMERIC(6,2) NOT NULL,
  month TEXT NOT NULL,                                -- e.g. "Feb 2026"
  mom_change NUMERIC(6,2),
  automation_impact TEXT,                             -- 'Favorable', 'Moderate', 'High cost'
  source TEXT DEFAULT 'EIA',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(region, month)
);

-- Lumber & pallet pricing
CREATE TABLE material_prices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item TEXT NOT NULL,                                 -- 'Softwood Lumber (MBF)', '48x40 GMA Pallet'
  price NUMERIC(10,2) NOT NULL,
  unit TEXT NOT NULL,                                 -- 'per MBF', 'per pallet'
  week_ending DATE NOT NULL,
  wow_change NUMERIC(6,2),
  avg_52wk NUMERIC(10,2),
  source TEXT DEFAULT 'Random Lengths / NWPCA',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(item, week_ending)
);

-- Indexes for common queries
CREATE INDEX idx_fuel_prices_date ON fuel_prices(report_date DESC);
CREATE INDEX idx_real_estate_market ON industrial_real_estate(market);
CREATE INDEX idx_utility_region ON utility_rates(region);
CREATE INDEX idx_material_item ON material_prices(item);

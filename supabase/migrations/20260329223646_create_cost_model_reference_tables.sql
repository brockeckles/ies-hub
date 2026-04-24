
-- ══════════════════════════════════════════════════════════
-- COST MODEL REFERENCE DATA TABLES
-- ══════════════════════════════════════════════════════════

-- Markets (core geography table — shared across Hub modules)
CREATE TABLE ref_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  abbr TEXT NOT NULL,
  region TEXT,
  state TEXT,
  lat NUMERIC,
  lng NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Labor rates by role and market
CREATE TABLE ref_labor_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES ref_markets(id) ON DELETE CASCADE,
  role_name TEXT NOT NULL,
  role_category TEXT NOT NULL DEFAULT 'hourly',
  hourly_rate NUMERIC NOT NULL,
  burden_pct NUMERIC DEFAULT 35,
  benefits_per_hour NUMERIC DEFAULT 0,
  overtime_multiplier NUMERIC DEFAULT 1.5,
  shift_differential_pct NUMERIC DEFAULT 0,
  annual_hours INT DEFAULT 2080,
  notes TEXT,
  effective_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(market_id, role_name)
);

-- Equipment catalog (MHE, racking, conveyors, etc.)
CREATE TABLE ref_equipment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  purchase_cost NUMERIC,
  monthly_lease_cost NUMERIC,
  monthly_maintenance NUMERIC DEFAULT 0,
  useful_life_years INT DEFAULT 7,
  depreciation_method TEXT DEFAULT 'straight-line',
  power_type TEXT,
  capacity_description TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Facility rates by market (lease, build-out, etc.)
CREATE TABLE ref_facility_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES ref_markets(id) ON DELETE CASCADE,
  building_type TEXT NOT NULL DEFAULT 'Class A Warehouse',
  lease_rate_psf_yr NUMERIC NOT NULL,
  cam_rate_psf_yr NUMERIC DEFAULT 0,
  tax_rate_psf_yr NUMERIC DEFAULT 0,
  insurance_rate_psf_yr NUMERIC DEFAULT 0,
  build_out_psf NUMERIC DEFAULT 0,
  clear_height_ft INT DEFAULT 32,
  typical_bay_size TEXT,
  dock_door_cost NUMERIC DEFAULT 0,
  notes TEXT,
  effective_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(market_id, building_type)
);

-- Utility rates by market
CREATE TABLE ref_utility_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES ref_markets(id) ON DELETE CASCADE,
  electricity_kwh NUMERIC DEFAULT 0,
  natural_gas_therm NUMERIC DEFAULT 0,
  water_per_kgal NUMERIC DEFAULT 0,
  trash_monthly NUMERIC DEFAULT 0,
  telecom_monthly NUMERIC DEFAULT 0,
  avg_monthly_per_sqft NUMERIC DEFAULT 0,
  notes TEXT,
  effective_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(market_id)
);

-- Overhead & indirect cost rates
CREATE TABLE ref_overhead_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL UNIQUE,
  description TEXT,
  monthly_cost NUMERIC DEFAULT 0,
  cost_type TEXT DEFAULT 'fixed',
  per_unit TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Productivity standards (engineered labor standards)
CREATE TABLE ref_productivity_standards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity TEXT NOT NULL,
  category TEXT NOT NULL,
  uom TEXT NOT NULL DEFAULT 'units/hour',
  standard_rate NUMERIC NOT NULL,
  min_rate NUMERIC,
  max_rate NUMERIC,
  method TEXT DEFAULT 'MOST',
  assumptions TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(activity, category)
);

-- Enable RLS with permissive policies (same pattern as other tables)
ALTER TABLE ref_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_labor_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_facility_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_utility_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_overhead_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_productivity_standards ENABLE ROW LEVEL SECURITY;

-- Policies for all ref tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ref_markets','ref_labor_rates','ref_equipment','ref_facility_rates','ref_utility_rates','ref_overhead_rates','ref_productivity_standards']
  LOOP
    EXECUTE format('CREATE POLICY "anon_select_%1$s" ON %1$s FOR SELECT USING (true)', tbl);
    EXECUTE format('CREATE POLICY "anon_insert_%1$s" ON %1$s FOR INSERT WITH CHECK (true)', tbl);
    EXECUTE format('CREATE POLICY "anon_update_%1$s" ON %1$s FOR UPDATE USING (true) WITH CHECK (true)', tbl);
    EXECUTE format('CREATE POLICY "anon_delete_%1$s" ON %1$s FOR DELETE USING (true)', tbl);
  END LOOP;
END $$;

-- Indexes
CREATE INDEX idx_labor_rates_market ON ref_labor_rates(market_id);
CREATE INDEX idx_facility_rates_market ON ref_facility_rates(market_id);
CREATE INDEX idx_utility_rates_market ON ref_utility_rates(market_id);
CREATE INDEX idx_equipment_category ON ref_equipment(category);
CREATE INDEX idx_productivity_category ON ref_productivity_standards(category);

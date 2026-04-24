
-- Warehouse Sizing Scenarios — stores all inputs for the sizing calculator per cost model project
CREATE TABLE IF NOT EXISTS warehouse_sizing_scenarios (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id bigint REFERENCES cost_model_projects(id) ON DELETE CASCADE,
    scenario_name text NOT NULL DEFAULT 'Default',
    is_active boolean DEFAULT true,
    
    -- All calculator inputs (numeric fields)
    peak_units numeric DEFAULT 500000,
    avg_units numeric DEFAULT 350000,
    pct_full_pallet numeric DEFAULT 60,
    pct_carton_pallet numeric DEFAULT 30,
    pct_carton_shelving numeric DEFAULT 10,
    units_per_pallet numeric DEFAULT 48,
    units_per_carton_pal numeric DEFAULT 6,
    cartons_per_pallet numeric DEFAULT 12,
    units_per_carton_shelv numeric DEFAULT 6,
    cartons_per_level numeric DEFAULT 4,
    headcount_buffer numeric DEFAULT 10,
    clear_height numeric DEFAULT 36,
    load_height numeric DEFAULT 54,
    bulk_deep numeric DEFAULT 4,
    stack_high numeric DEFAULT 3,
    mix_rack numeric DEFAULT 60,
    inbound_pallets numeric DEFAULT 400,
    outbound_pallets numeric DEFAULT 350,
    pallets_per_dock_per_hour numeric DEFAULT 12,
    dock_hours numeric DEFAULT 10,
    office_pct numeric DEFAULT 5,
    fwd_pick_skus numeric DEFAULT 2000,
    fwd_pick_days numeric DEFAULT 3,
    outbound_units numeric DEFAULT 5000000,
    operating_days numeric DEFAULT 250,
    
    -- Dropdown selections
    storage_type text DEFAULT 'single',
    aisle_type text DEFAULT 'narrow',
    rack_direction text DEFAULT 'horizontal',
    dock_config text DEFAULT 'one',
    fwd_pick_type text DEFAULT 'cartonflow',
    
    -- Checkbox toggles
    has_forward_pick boolean DEFAULT false,
    has_vas boolean DEFAULT false,
    has_returns boolean DEFAULT false,
    has_charging boolean DEFAULT false,
    has_staging boolean DEFAULT false,
    
    -- Custom zones (stored as JSONB array)
    custom_zones jsonb DEFAULT '[]'::jsonb,
    
    -- Results snapshot (for quick display without recalc)
    result_total_sqft numeric,
    result_positions numeric,
    result_dock_doors numeric,
    
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Network Optimization Scenarios — stores demand points and config per cost model project
CREATE TABLE IF NOT EXISTS network_optimization_scenarios (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id bigint REFERENCES cost_model_projects(id) ON DELETE CASCADE,
    scenario_name text NOT NULL DEFAULT 'Default',
    is_active boolean DEFAULT true,
    
    -- Configuration
    dc_count integer DEFAULT 1,
    freight_rate_per_mile numeric DEFAULT 2.25,
    loads_per_week numeric DEFAULT 2,
    
    -- Demand points (JSONB array of {city, volume})
    demand_points jsonb DEFAULT '[]'::jsonb,
    
    -- Results snapshot
    result_avg_distance numeric,
    result_est_freight numeric,
    result_avg_transit numeric,
    result_recommended_dcs integer,
    
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Indexes for fast lookup by project
CREATE INDEX idx_wss_project ON warehouse_sizing_scenarios(project_id);
CREATE INDEX idx_nos_project ON network_optimization_scenarios(project_id);

-- Enable RLS
ALTER TABLE warehouse_sizing_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_optimization_scenarios ENABLE ROW LEVEL SECURITY;

-- Open access policies (matching existing hub pattern)
CREATE POLICY "Allow all access to warehouse_sizing_scenarios" ON warehouse_sizing_scenarios FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to network_optimization_scenarios" ON network_optimization_scenarios FOR ALL USING (true) WITH CHECK (true);

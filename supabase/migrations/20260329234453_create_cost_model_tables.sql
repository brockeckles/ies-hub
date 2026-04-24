
-- Cost Model Projects
CREATE TABLE cost_model_projects (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'draft',

    -- Market & Environment
    market_id UUID REFERENCES ref_markets(id),
    allowance_profile_id BIGINT REFERENCES ref_allowance_profiles(id),
    environment_type TEXT DEFAULT 'ambient',

    -- Facility Parameters
    facility_sqft NUMERIC(12,0),
    clear_height_ft NUMERIC(6,1),
    dock_doors INTEGER,
    staging_sqft NUMERIC(10,0),
    office_sqft NUMERIC(10,0),

    -- Shift Structure
    shifts_per_day INTEGER DEFAULT 1,
    hours_per_shift NUMERIC(4,1) DEFAULT 8.0,
    days_per_week INTEGER DEFAULT 5,
    operating_weeks_per_year INTEGER DEFAULT 52,

    -- Annual Throughput Volumes
    vol_pallets_received NUMERIC(12,0) DEFAULT 0,
    vol_cases_received NUMERIC(12,0) DEFAULT 0,
    vol_pallets_putaway NUMERIC(12,0) DEFAULT 0,
    vol_cases_putaway NUMERIC(12,0) DEFAULT 0,
    vol_replenishments NUMERIC(12,0) DEFAULT 0,
    vol_eaches_picked NUMERIC(12,0) DEFAULT 0,
    vol_cases_picked NUMERIC(12,0) DEFAULT 0,
    vol_pallets_picked NUMERIC(12,0) DEFAULT 0,
    vol_orders_packed NUMERIC(12,0) DEFAULT 0,
    vol_pallets_shipped NUMERIC(12,0) DEFAULT 0,
    vol_returns_processed NUMERIC(12,0) DEFAULT 0,
    vol_vas_units NUMERIC(12,0) DEFAULT 0,

    -- Order Profile
    avg_lines_per_order NUMERIC(6,2) DEFAULT 3.0,
    avg_units_per_line NUMERIC(6,2) DEFAULT 1.5,
    avg_order_weight_lbs NUMERIC(8,2),
    pct_single_line_orders NUMERIC(5,2) DEFAULT 40.0,

    -- Pick Zone Parameters
    avg_pick_travel_ft NUMERIC(8,1) DEFAULT 20.0,
    avg_putaway_travel_ft NUMERIC(8,1) DEFAULT 120.0,
    avg_replen_travel_ft NUMERIC(8,1) DEFAULT 150.0,
    avg_slot_height TEXT DEFAULT 'waist',
    pick_method TEXT DEFAULT 'discrete',

    -- Financial Parameters
    target_margin_pct NUMERIC(5,2) DEFAULT 12.0,
    contract_term_years INTEGER DEFAULT 3,
    annual_volume_growth_pct NUMERIC(5,2) DEFAULT 0.0,
    startup_cost NUMERIC(12,2) DEFAULT 0,
    pricing_model TEXT DEFAULT 'hybrid',

    -- Metadata
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Cost Model Labor Lines
CREATE TABLE cost_model_labor (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES cost_model_projects(id) ON DELETE CASCADE,
    role_name TEXT NOT NULL,
    role_category TEXT,
    headcount NUMERIC(6,1) NOT NULL DEFAULT 0,
    hourly_rate NUMERIC(8,2),
    burden_pct NUMERIC(5,2),
    benefits_per_hour NUMERIC(8,2),
    annual_hours NUMERIC(8,0),
    total_annual_cost NUMERIC(12,2),
    source TEXT DEFAULT 'reference',
    most_template_id BIGINT REFERENCES ref_most_templates(id),
    annual_volume NUMERIC(12,0),
    calculated_uph NUMERIC(10,2),
    notes TEXT
);

-- Cost Model Equipment Lines
CREATE TABLE cost_model_equipment (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES cost_model_projects(id) ON DELETE CASCADE,
    equipment_id UUID REFERENCES ref_equipment(id),
    name TEXT NOT NULL,
    category TEXT,
    quantity INTEGER DEFAULT 1,
    acquisition_type TEXT DEFAULT 'lease',
    monthly_cost NUMERIC(10,2),
    monthly_maintenance NUMERIC(10,2),
    total_annual_cost NUMERIC(12,2),
    notes TEXT
);

-- Cost Model Overhead Lines
CREATE TABLE cost_model_overhead (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES cost_model_projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    description TEXT,
    monthly_cost NUMERIC(10,2) DEFAULT 0,
    cost_type TEXT DEFAULT 'fixed',
    scaling_factor NUMERIC(10,4),
    total_annual_cost NUMERIC(12,2),
    notes TEXT
);

-- Cost Model VAS Lines
CREATE TABLE cost_model_vas (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES cost_model_projects(id) ON DELETE CASCADE,
    service_name TEXT NOT NULL,
    description TEXT,
    rate_per_unit NUMERIC(10,4),
    uom TEXT DEFAULT 'each',
    annual_volume NUMERIC(12,0) DEFAULT 0,
    total_annual_cost NUMERIC(12,2),
    notes TEXT
);

-- Cost Model Summary
CREATE TABLE cost_model_summary (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES cost_model_projects(id) ON DELETE CASCADE,
    total_labor_cost NUMERIC(14,2),
    total_facility_cost NUMERIC(14,2),
    total_equipment_cost NUMERIC(14,2),
    total_overhead_cost NUMERIC(14,2),
    total_vas_cost NUMERIC(14,2),
    total_operating_cost NUMERIC(14,2),
    startup_amortized NUMERIC(14,2),
    margin_amount NUMERIC(14,2),
    total_revenue_needed NUMERIC(14,2),
    cost_per_order NUMERIC(10,4),
    cost_per_pallet NUMERIC(10,4),
    cost_per_case NUMERIC(10,4),
    cost_per_each NUMERIC(10,4),
    cost_per_sqft NUMERIC(10,4),
    total_headcount NUMERIC(8,1),
    total_direct_labor_hours NUMERIC(12,0),
    avg_labor_cost_per_hour NUMERIC(8,2),
    calculated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(project_id)
);

-- Indexes
CREATE INDEX idx_cm_projects_market ON cost_model_projects(market_id);
CREATE INDEX idx_cm_projects_status ON cost_model_projects(status);
CREATE INDEX idx_cm_labor_project ON cost_model_labor(project_id);
CREATE INDEX idx_cm_equipment_project ON cost_model_equipment(project_id);
CREATE INDEX idx_cm_overhead_project ON cost_model_overhead(project_id);
CREATE INDEX idx_cm_vas_project ON cost_model_vas(project_id);
CREATE INDEX idx_cm_summary_project ON cost_model_summary(project_id);

-- RLS
ALTER TABLE cost_model_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_model_labor ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_model_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_model_overhead ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_model_vas ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_model_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_all_cm_projects" ON cost_model_projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all_cm_labor" ON cost_model_labor FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all_cm_equipment" ON cost_model_equipment FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all_cm_overhead" ON cost_model_overhead FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all_cm_vas" ON cost_model_vas FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all_cm_summary" ON cost_model_summary FOR ALL USING (true) WITH CHECK (true);

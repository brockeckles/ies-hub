
-- MOST Templates: each row is a reusable activity template
CREATE TABLE ref_most_templates (
    id BIGSERIAL PRIMARY KEY,
    activity_name TEXT NOT NULL,
    process_area TEXT NOT NULL,        -- Receiving, Putaway, Replenishment, Picking, Packing, Shipping, VAS
    wms_transaction TEXT,              -- BY WMS transaction code/name (e.g. "RF Directed Putaway")
    pick_method TEXT,                  -- For picking: discrete, batch, cluster, wave, zone
    equipment_type TEXT,               -- Forklift, pallet jack, RF gun, voice, cart, etc.
    description TEXT,
    total_tmu_base NUMERIC(10,2),     -- Base TMU total (before allowances), calculated from elements
    units_per_hour_base NUMERIC(10,2),-- Calculated: 100000 / total_tmu_base (before allowances)
    uom TEXT DEFAULT 'each',          -- Unit of measure: each, case, pallet, order, line
    is_active BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- MOST Elements: individual motion elements within a template
CREATE TABLE ref_most_elements (
    id BIGSERIAL PRIMARY KEY,
    template_id BIGINT NOT NULL REFERENCES ref_most_templates(id) ON DELETE CASCADE,
    sequence_order INTEGER NOT NULL,   -- Order within the template
    element_name TEXT NOT NULL,        -- e.g. "Travel to pick location", "Reach and grasp item"
    most_sequence TEXT NOT NULL,       -- e.g. "A6 B6 G1 A1 B0 P3 A0" (General Move)
    sequence_type TEXT NOT NULL DEFAULT 'general_move',  -- general_move, controlled_move, tool_use
    tmu_value NUMERIC(10,2) NOT NULL, -- TMU for this element
    is_variable BOOLEAN DEFAULT false, -- True if this element changes with solution parameters
    variable_driver TEXT,              -- What drives the variable: travel_distance, slot_height, units_per_line, etc.
    variable_formula TEXT,             -- Description of how to adjust: "Scale A-index by avg travel distance in feet / 6"
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Allowance Profiles: PFD and adjustment factors
CREATE TABLE ref_allowance_profiles (
    id BIGSERIAL PRIMARY KEY,
    profile_name TEXT NOT NULL,        -- e.g. "Standard Warehouse", "Cold Storage", "High-Volume DC"
    personal_pct NUMERIC(5,2) DEFAULT 5.0,    -- Personal allowance %
    fatigue_pct NUMERIC(5,2) DEFAULT 4.0,     -- Fatigue allowance %
    delay_pct NUMERIC(5,2) DEFAULT 5.0,       -- Unavoidable delay %
    total_pfd_pct NUMERIC(5,2) GENERATED ALWAYS AS (personal_pct + fatigue_pct + delay_pct) STORED,
    learning_curve_wk1 NUMERIC(5,2) DEFAULT 65.0,  -- % of standard achieved week 1
    learning_curve_wk2 NUMERIC(5,2) DEFAULT 75.0,
    learning_curve_wk4 NUMERIC(5,2) DEFAULT 85.0,
    learning_curve_wk8 NUMERIC(5,2) DEFAULT 95.0,
    learning_curve_wk12 NUMERIC(5,2) DEFAULT 100.0,
    environment_type TEXT DEFAULT 'ambient',    -- ambient, cold, frozen, outdoor
    ergonomic_adjustment_pct NUMERIC(5,2) DEFAULT 0.0, -- Additional % for ergonomic factors
    notes TEXT,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_most_templates_process ON ref_most_templates(process_area);
CREATE INDEX idx_most_templates_active ON ref_most_templates(is_active);
CREATE INDEX idx_most_elements_template ON ref_most_elements(template_id);
CREATE INDEX idx_most_elements_order ON ref_most_elements(template_id, sequence_order);
CREATE INDEX idx_allowance_profiles_default ON ref_allowance_profiles(is_default);

-- RLS
ALTER TABLE ref_most_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_most_elements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ref_allowance_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read most_templates" ON ref_most_templates FOR SELECT USING (true);
CREATE POLICY "Allow public insert most_templates" ON ref_most_templates FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update most_templates" ON ref_most_templates FOR UPDATE USING (true);
CREATE POLICY "Allow public delete most_templates" ON ref_most_templates FOR DELETE USING (true);

CREATE POLICY "Allow public read most_elements" ON ref_most_elements FOR SELECT USING (true);
CREATE POLICY "Allow public insert most_elements" ON ref_most_elements FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update most_elements" ON ref_most_elements FOR UPDATE USING (true);
CREATE POLICY "Allow public delete most_elements" ON ref_most_elements FOR DELETE USING (true);

CREATE POLICY "Allow public read allowance_profiles" ON ref_allowance_profiles FOR SELECT USING (true);
CREATE POLICY "Allow public insert allowance_profiles" ON ref_allowance_profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update allowance_profiles" ON ref_allowance_profiles FOR UPDATE USING (true);
CREATE POLICY "Allow public delete allowance_profiles" ON ref_allowance_profiles FOR DELETE USING (true);


-- ═══════════════════════════════════════════════════════
-- IES Projects MVP — Core Tables
-- ═══════════════════════════════════════════════════════

-- Enum for IES project stages (mirrors DOS stage pipeline)
CREATE TYPE ies_stage AS ENUM (
  'intake',
  'qualification', 
  'discovery',
  'solutioning',
  'pricing',
  'proposal',
  'negotiation',
  'closed_won',
  'closed_lost',
  'on_hold'
);

-- Enum for project status
CREATE TYPE project_status AS ENUM (
  'active',
  'on_hold',
  'completed',
  'cancelled'
);

-- Enum for hours category
CREATE TYPE hours_category AS ENUM (
  'forecast',
  'actual'
);

-- Enum for hours type (what kind of work)
CREATE TYPE hours_type AS ENUM (
  'solutions_design',
  'engineering',
  'project_management',
  'site_visit',
  'customer_meeting',
  'internal_review',
  'documentation',
  'other'
);

-- ── CUSTOMERS ──
CREATE TABLE customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  vertical industry_vertical,
  division text,
  primary_contact text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── OPPORTUNITIES (Projects) ──
CREATE TABLE opportunities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name text NOT NULL,
  stage ies_stage DEFAULT 'intake',
  status project_status DEFAULT 'active',
  solutions_lead text,
  engineering_lead text,
  other_resources text[],
  facility_type text,
  total_sqft integer,
  state text,
  division text,
  due_date date,
  round text DEFAULT '1',
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── HOURS ──
CREATE TABLE project_hours (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  resource text NOT NULL,
  week_start date NOT NULL,
  hours numeric NOT NULL DEFAULT 0,
  category hours_category NOT NULL DEFAULT 'forecast',
  hours_type hours_type DEFAULT 'solutions_design',
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── WEEKLY UPDATES ──
CREATE TABLE project_updates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  update_date date NOT NULL DEFAULT CURRENT_DATE,
  author text NOT NULL,
  body text NOT NULL,
  next_steps text,
  blockers text,
  created_at timestamptz DEFAULT now()
);

-- ── INDEXES ──
CREATE INDEX idx_opportunities_customer ON opportunities(customer_id);
CREATE INDEX idx_opportunities_stage ON opportunities(stage);
CREATE INDEX idx_opportunities_status ON opportunities(status);
CREATE INDEX idx_hours_opportunity ON project_hours(opportunity_id);
CREATE INDEX idx_hours_week ON project_hours(week_start);
CREATE INDEX idx_hours_category ON project_hours(category);
CREATE INDEX idx_updates_opportunity ON project_updates(opportunity_id);
CREATE INDEX idx_updates_date ON project_updates(update_date DESC);

-- ── RLS POLICIES (permissive for MVP — all authenticated + anon can CRUD) ──
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to customers" ON customers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to opportunities" ON opportunities FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to project_hours" ON project_hours FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to project_updates" ON project_updates FOR ALL USING (true) WITH CHECK (true);

-- ── UPDATED_AT TRIGGER ──
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER opportunities_updated_at BEFORE UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER project_hours_updated_at BEFORE UPDATE ON project_hours FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- General time category enum
CREATE TYPE general_time_category AS ENUM (
  'admin',
  'training',
  'pto',
  'travel',
  'internal_meeting',
  'business_development',
  'mentoring',
  'tool_development',
  'other'
);

-- General hours table (non-project time)
CREATE TABLE general_hours (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource text NOT NULL,
  week_start date NOT NULL,
  category general_time_category NOT NULL,
  hours numeric(6,1) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_general_hours_resource ON general_hours(resource);
CREATE INDEX idx_general_hours_week ON general_hours(week_start);

-- RLS
ALTER TABLE general_hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for MVP" ON general_hours FOR ALL USING (true) WITH CHECK (true);

-- Updated_at trigger
CREATE TRIGGER set_updated_at BEFORE UPDATE ON general_hours
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

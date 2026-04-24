
-- ADKAR phases enum
CREATE TYPE adkar_phase AS ENUM ('awareness', 'desire', 'knowledge', 'ability', 'reinforcement');

-- Change initiative status
CREATE TYPE change_status AS ENUM ('not_started', 'in_progress', 'completed', 'on_hold', 'cancelled');

-- Activity status
CREATE TYPE activity_status AS ENUM ('todo', 'in_progress', 'done', 'blocked');

-- Main change initiatives table
CREATE TABLE change_initiatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  owner TEXT NOT NULL,
  category TEXT DEFAULT 'process',
  current_phase adkar_phase NOT NULL DEFAULT 'awareness',
  status change_status NOT NULL DEFAULT 'not_started',
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  start_date DATE,
  target_date DATE,
  completed_date DATE,
  awareness_score INT DEFAULT 0 CHECK (awareness_score BETWEEN 0 AND 100),
  desire_score INT DEFAULT 0 CHECK (desire_score BETWEEN 0 AND 100),
  knowledge_score INT DEFAULT 0 CHECK (knowledge_score BETWEEN 0 AND 100),
  ability_score INT DEFAULT 0 CHECK (ability_score BETWEEN 0 AND 100),
  reinforcement_score INT DEFAULT 0 CHECK (reinforcement_score BETWEEN 0 AND 100),
  impact_areas TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Sub-activities for each initiative
CREATE TABLE change_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id UUID NOT NULL REFERENCES change_initiatives(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  owner TEXT,
  status activity_status NOT NULL DEFAULT 'todo',
  adkar_phase adkar_phase,
  due_date DATE,
  completed_date DATE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Flowcharts associated with initiatives
CREATE TABLE change_flowcharts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id UUID REFERENCES change_initiatives(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  chart_data JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE change_initiatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_flowcharts ENABLE ROW LEVEL SECURITY;

-- Public read/write policies (matching existing hub pattern)
CREATE POLICY "Public read change_initiatives" ON change_initiatives FOR SELECT USING (true);
CREATE POLICY "Public insert change_initiatives" ON change_initiatives FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update change_initiatives" ON change_initiatives FOR UPDATE USING (true);
CREATE POLICY "Public delete change_initiatives" ON change_initiatives FOR DELETE USING (true);

CREATE POLICY "Public read change_activities" ON change_activities FOR SELECT USING (true);
CREATE POLICY "Public insert change_activities" ON change_activities FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update change_activities" ON change_activities FOR UPDATE USING (true);
CREATE POLICY "Public delete change_activities" ON change_activities FOR DELETE USING (true);

CREATE POLICY "Public read change_flowcharts" ON change_flowcharts FOR SELECT USING (true);
CREATE POLICY "Public insert change_flowcharts" ON change_flowcharts FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update change_flowcharts" ON change_flowcharts FOR UPDATE USING (true);
CREATE POLICY "Public delete change_flowcharts" ON change_flowcharts FOR DELETE USING (true);

-- Indexes
CREATE INDEX idx_change_activities_initiative ON change_activities(initiative_id);
CREATE INDEX idx_change_flowcharts_initiative ON change_flowcharts(initiative_id);


CREATE TABLE master_competitors (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  primary_vertical TEXT NOT NULL,
  status TEXT CHECK (status IN ('active', 'inactive')) DEFAULT 'active',
  hq_location TEXT,
  website TEXT,
  founded_year INTEGER,
  key_segments TEXT,
  notes TEXT,
  last_updated TIMESTAMP WITH TIME ZONE,
  intelligence_score NUMERIC CHECK (intelligence_score >= 0 AND intelligence_score <= 100),
  notes_from_research TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_master_competitors_vertical ON master_competitors(primary_vertical);
CREATE INDEX idx_master_competitors_status ON master_competitors(status);
CREATE INDEX idx_master_competitors_last_updated ON master_competitors(last_updated);

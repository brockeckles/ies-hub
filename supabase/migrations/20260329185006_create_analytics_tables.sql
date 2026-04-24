
-- Analytics sessions table
CREATE TABLE analytics_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  user_agent TEXT,
  browser TEXT,
  os TEXT,
  device_type TEXT DEFAULT 'desktop',
  screen_width INT,
  screen_height INT,
  referrer TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INT DEFAULT 0,
  page_count INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true
);

-- Analytics page views table
CREATE TABLE analytics_page_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  section TEXT NOT NULL,
  entered_at TIMESTAMPTZ DEFAULT now(),
  exited_at TIMESTAMPTZ,
  duration_seconds INT DEFAULT 0
);

-- Enable RLS but allow anonymous inserts/updates (public site)
ALTER TABLE analytics_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_page_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous insert on analytics_sessions" ON analytics_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anonymous update on analytics_sessions" ON analytics_sessions FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow anonymous select on analytics_sessions" ON analytics_sessions FOR SELECT USING (true);

CREATE POLICY "Allow anonymous insert on analytics_page_views" ON analytics_page_views FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anonymous update on analytics_page_views" ON analytics_page_views FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow anonymous select on analytics_page_views" ON analytics_page_views FOR SELECT USING (true);

-- Indexes for fast dashboard queries
CREATE INDEX idx_sessions_started_at ON analytics_sessions(started_at);
CREATE INDEX idx_sessions_session_id ON analytics_sessions(session_id);
CREATE INDEX idx_page_views_session_id ON analytics_page_views(session_id);
CREATE INDEX idx_page_views_section ON analytics_page_views(section);
CREATE INDEX idx_page_views_entered_at ON analytics_page_views(entered_at);

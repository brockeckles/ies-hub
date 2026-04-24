
-- Feedback / Ideas tracking for IES Hub
CREATE TYPE feedback_type AS ENUM ('question', 'enhancement', 'bug', 'general');
CREATE TYPE feedback_status AS ENUM ('new', 'under_review', 'in_progress', 'completed', 'declined');
CREATE TYPE feedback_priority AS ENUM ('nice_to_have', 'important', 'critical');

CREATE TABLE hub_feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type feedback_type NOT NULL DEFAULT 'enhancement',
  title TEXT NOT NULL,
  description TEXT,
  section TEXT,
  submitted_by TEXT NOT NULL DEFAULT 'Anonymous',
  priority feedback_priority NOT NULL DEFAULT 'nice_to_have',
  status feedback_status NOT NULL DEFAULT 'new',
  admin_response TEXT,
  upvotes TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE hub_feedback ENABLE ROW LEVEL SECURITY;

-- Allow anon read/insert/update (Hub uses anon key)
CREATE POLICY "Allow anon read" ON hub_feedback FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON hub_feedback FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON hub_feedback FOR UPDATE USING (true);

-- Index for common queries
CREATE INDEX idx_feedback_status ON hub_feedback(status);
CREATE INDEX idx_feedback_created ON hub_feedback(created_at DESC);

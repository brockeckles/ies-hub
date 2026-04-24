
-- Task status enum
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'done', 'blocked');

-- Task priority enum
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'critical');

-- Opportunity tasks / sub-activities
CREATE TABLE opportunity_tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  assignee text,
  status task_status NOT NULL DEFAULT 'todo',
  priority task_priority NOT NULL DEFAULT 'medium',
  due_date date,
  estimated_hours numeric(6,1),
  actual_hours numeric(6,1),
  sort_order integer DEFAULT 0,
  parent_task_id bigint REFERENCES opportunity_tasks(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Win strategy fields on opportunities
ALTER TABLE opportunities
  ADD COLUMN win_strategy text,
  ADD COLUMN differentiators text,
  ADD COLUMN risks text,
  ADD COLUMN competitive_position text,
  ADD COLUMN pricing_strategy text;

-- Indexes
CREATE INDEX idx_tasks_opportunity ON opportunity_tasks(opportunity_id);
CREATE INDEX idx_tasks_status ON opportunity_tasks(status);
CREATE INDEX idx_tasks_assignee ON opportunity_tasks(assignee);
CREATE INDEX idx_tasks_parent ON opportunity_tasks(parent_task_id);

-- RLS
ALTER TABLE opportunity_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for MVP" ON opportunity_tasks FOR ALL USING (true) WITH CHECK (true);

-- Updated_at trigger
CREATE TRIGGER set_updated_at BEFORE UPDATE ON opportunity_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

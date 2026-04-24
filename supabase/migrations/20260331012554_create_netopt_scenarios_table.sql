
CREATE TABLE netopt_scenarios (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint REFERENCES cost_model_projects(id) ON DELETE CASCADE,
  scenario_name text NOT NULL DEFAULT 'Default',
  is_active boolean DEFAULT true,
  facilities jsonb DEFAULT '[]'::jsonb,
  demands jsonb DEFAULT '[]'::jsonb,
  transport jsonb DEFAULT '{}'::jsonb,
  constraints jsonb DEFAULT '{}'::jsonb,
  solver_mode text DEFAULT 'heuristic',
  result_total_cost numeric,
  result_avg_distance numeric,
  result_service_level numeric,
  result_open_facilities jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_netopt_scenarios_project ON netopt_scenarios(project_id);

ALTER TABLE netopt_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to netopt_scenarios" ON netopt_scenarios FOR ALL USING (true) WITH CHECK (true);

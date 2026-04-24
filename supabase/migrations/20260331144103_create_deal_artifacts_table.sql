
CREATE TABLE deal_artifacts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deal_deals(id) ON DELETE CASCADE,
  artifact_type text NOT NULL CHECK (artifact_type IN ('cost_model', 'netopt_scenario', 'fleet_scenario', 'document', 'other')),
  artifact_id uuid,
  artifact_name text NOT NULL,
  artifact_notes text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE deal_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deal_artifacts_all" ON deal_artifacts FOR ALL USING (true);
CREATE INDEX idx_deal_artifacts_deal ON deal_artifacts(deal_id);
CREATE INDEX idx_deal_artifacts_type ON deal_artifacts(artifact_type);

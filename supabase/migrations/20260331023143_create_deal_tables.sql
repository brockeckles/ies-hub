CREATE TABLE IF NOT EXISTS deal_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_name TEXT NOT NULL,
  client_name TEXT,
  deal_owner TEXT,
  status TEXT DEFAULT 'Draft',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE cost_model_projects ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deal_deals(id) ON DELETE SET NULL;

ALTER TABLE deal_deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_deals_policy ON deal_deals;
CREATE POLICY deal_deals_policy ON deal_deals FOR ALL USING (true) WITH CHECK (true);
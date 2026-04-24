
-- Add account_id FK to pipeline_deals
ALTER TABLE pipeline_deals ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES master_accounts(id);

-- Add account_id FK to deal_deals
ALTER TABLE deal_deals ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES master_accounts(id);

-- Add vertical_enum column to master_accounts for enum compatibility
ALTER TABLE master_accounts ADD COLUMN IF NOT EXISTS vertical_enum industry_vertical;

-- Populate vertical_enum from vertical TEXT via master_verticals enum_key mapping
UPDATE master_accounts ma
SET vertical_enum = mv.enum_key::industry_vertical
FROM master_verticals mv
WHERE ma.vertical = mv.vertical_name
  AND mv.enum_key IS NOT NULL
  AND ma.vertical_enum IS NULL;

-- Create indexes for the new FKs
CREATE INDEX IF NOT EXISTS idx_pipeline_deals_account_id ON pipeline_deals(account_id);
CREATE INDEX IF NOT EXISTS idx_deal_deals_account_id ON deal_deals(account_id);


CREATE TABLE master_accounts (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  vertical TEXT NOT NULL,
  region TEXT NOT NULL,
  account_type TEXT CHECK (account_type IN ('prospect', 'customer', 'won', 'lost')),
  company_size TEXT CHECK (company_size IN ('enterprise', 'mid-market', 'small')),
  hq_location TEXT,
  primary_contact TEXT,
  account_manager TEXT,
  parent_account_id BIGINT REFERENCES master_accounts(id) ON DELETE SET NULL,
  annual_revenue_estimate NUMERIC,
  notes TEXT,
  status TEXT CHECK (status IN ('active', 'inactive')) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_master_accounts_vertical ON master_accounts(vertical);
CREATE INDEX idx_master_accounts_region ON master_accounts(region);
CREATE INDEX idx_master_accounts_status ON master_accounts(status);

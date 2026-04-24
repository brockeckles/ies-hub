-- Extend contract_type to support Split-Month Billing (4th variant)
-- Fixed Monthly Management Fee (billed start-of-month) + Variable Transaction
-- Fee (billed end-of-month) is a common 3PL billing mechanic. This migration:
--   (a) extends the enum CHECK to accept 'split_month'
--   (b) adds split_billing_fixed_pct — what % of total revenue is billed as
--       fixed upfront. Null for non-split contracts; 30-50 typical otherwise.
--   (c) adds split_billing_fixed_dso_days + split_billing_variable_dso_days
--       so the monthly engine can use a weighted-average DSO on this contract type.

ALTER TABLE public.cost_model_projects
  DROP CONSTRAINT IF EXISTS cost_model_projects_contract_type_check;

ALTER TABLE public.cost_model_projects
  ADD CONSTRAINT cost_model_projects_contract_type_check
    CHECK (contract_type = ANY (ARRAY['open_book'::text, 'fixed_variable'::text, 'unit_rate'::text, 'split_month'::text]));

ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS split_billing_fixed_pct         numeric,
  ADD COLUMN IF NOT EXISTS split_billing_fixed_dso_days    integer DEFAULT 15,
  ADD COLUMN IF NOT EXISTS split_billing_variable_dso_days integer DEFAULT 45;

COMMENT ON COLUMN public.cost_model_projects.split_billing_fixed_pct IS
  'Split-Month Billing only: % of total revenue billed as fixed monthly management fee at start of month. Remainder billed as variable transaction fee at end of month. 30-50 typical; NULL for non-split contracts.';
COMMENT ON COLUMN public.cost_model_projects.split_billing_fixed_dso_days IS
  'DSO for the fixed-fee portion (typically 15 — billed early, net-15).';
COMMENT ON COLUMN public.cost_model_projects.split_billing_variable_dso_days IS
  'DSO for the variable transaction-fee portion (typically 45 — billed in arrears, net-30 from month-end).';
-- 20260704160000_cm_authoritative_revenue.sql
-- Pricing-vocab ownership (UX D1 open decision, resolved 2026-07-04):
-- the COST MODEL engine is authoritative for a deal site's revenue.
--
-- Context: two revenue engines coexisted — DM's 5 hardcoded pricing_model
-- markups (cost-plus/transactional/…) vs CM's contract_type + pricing
-- buckets (Revenue = Cost / (1 - margin)). The deal tabs derived revenue
-- from the DM heuristic even when the site row IS a CM model with real
-- engine output. Resolution: CM saves stamp their engine's steady-state
-- annual revenue/cost into flat columns; DM prefers those and only falls
-- back to its markup heuristic (labeled "estimate") when a model has
-- never been engine-saved. pricing_model remains as the heuristic's knob.

alter table public.cost_model_projects
  add column if not exists total_annual_revenue numeric;

comment on column public.cost_model_projects.total_annual_revenue is
  'CM engine steady-state annual revenue (summary.totalRevenue), stamped on every CM save since 2026-07-04. NULL/0 = model never engine-saved; deal financials fall back to the DM markup heuristic labeled as an estimate.';

comment on column public.cost_model_projects.pricing_model is
  'LEGACY (2026-07-04): DM markup-heuristic knob only. Not CM vocabulary — CM pricing lives in contract_type + pricing buckets. Used solely for the estimate fallback when total_annual_revenue is not populated.';

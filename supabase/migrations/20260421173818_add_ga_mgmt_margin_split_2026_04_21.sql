-- Margin Handling Rewire — M1 (2026-04-21)
-- Split `target_margin_pct` into `ga_margin_pct` + `mgmt_fee_margin_pct`.
-- Reference model Part I §4: G&A and Mgmt Fee are the two customer-facing
-- margin components that stack on the Customer Budget Summary. Default
-- 6.0 / 10.0 per reference. Existing rows backfill proportionally from
-- target_margin_pct (G&A ≈ 37.5% of total, Mgmt ≈ 62.5% per doc MD1).
--
-- target_margin_pct retained as a derived convenience (= ga + mgmt) via
-- generated column so downstream readers don't need to change.

ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS ga_margin_pct numeric NOT NULL DEFAULT 6.0,
  ADD COLUMN IF NOT EXISTS mgmt_fee_margin_pct numeric NOT NULL DEFAULT 10.0;

-- Backfill existing rows: preserve their current total, split 37.5 / 62.5.
UPDATE public.cost_model_projects
SET
  ga_margin_pct       = ROUND((COALESCE(target_margin_pct, 16) * 0.375)::numeric, 2),
  mgmt_fee_margin_pct = ROUND((COALESCE(target_margin_pct, 16) - (COALESCE(target_margin_pct, 16) * 0.375))::numeric, 2)
WHERE target_margin_pct IS NOT NULL
  AND target_margin_pct > 0;

COMMENT ON COLUMN public.cost_model_projects.ga_margin_pct
  IS 'G&A margin component (reference Part I §4). Default 6.0. Sums with mgmt_fee_margin_pct = target_margin_pct.';

COMMENT ON COLUMN public.cost_model_projects.mgmt_fee_margin_pct
  IS 'Management Fee margin component (reference Part I §4). Default 10.0. Sums with ga_margin_pct = target_margin_pct.';

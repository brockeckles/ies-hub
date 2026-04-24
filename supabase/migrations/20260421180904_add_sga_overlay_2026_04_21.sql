-- Margin Handling Rewire — M2 (2026-04-21)
-- SG&A overlay per reference Part I §5: optional ratio-based corporate
-- overhead applied to NET revenue (revenue minus pass-through / as-incurred
-- / deferred). Sits between Contribution Margin and EBIT on the P&L.
--
-- Design decision (MD7): category-based SG&A (OVERHEAD + IT_INTEG_EXP +
-- PROF_SERV_EXP + ONBOARD_EXP cost rows) STAYS where it is. This overlay
-- is additive — represents unmodeled corporate overhead analysts may need
-- to add for reference-model-aligned RFP responses. Default 0 so existing
-- projects don't suddenly see EBIT drop.

ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS sga_overlay_pct numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS sga_applies_to text NOT NULL DEFAULT 'net_revenue'
    CHECK (sga_applies_to IN ('net_revenue', 'gross_revenue'));

COMMENT ON COLUMN public.cost_model_projects.sga_overlay_pct
  IS 'Ratio-based SG&A overlay (reference Part I §5). Default 0 = no overlay. Set to 4.5 for reference-model-aligned cost-plus RFP responses.';

COMMENT ON COLUMN public.cost_model_projects.sga_applies_to
  IS 'Whether SG&A overlay applies to net_revenue (default) or gross_revenue.';

-- Contract-type branch per reference Part I §9.
ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS contract_type text NOT NULL DEFAULT 'fixed_variable'
    CHECK (contract_type IN ('open_book', 'fixed_variable', 'unit_rate'));

COMMENT ON COLUMN public.cost_model_projects.contract_type
  IS 'Contract type per reference Part I §9. open_book | fixed_variable (default) | unit_rate. Split-Month Billing deferred.';

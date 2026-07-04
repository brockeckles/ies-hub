-- EBITDA reclass (2026-07-04): equipment capital amortization moves from
-- COGS (inside LEASED_EQUIP) to D&A. New chart-of-accounts code so the
-- monthly engine can emit EQUIP_DEPR rows (FK on
-- cost_model_expense_monthly.expense_line_code requires it).
-- P&L effect: EBITDA rises by equipment amort; EBIT/opex/cash unchanged.
-- Applied to prod + staging via MCP 2026-07-04 (same session it was written).
INSERT INTO public.ref_expense_lines (code, display_name, category, sort_order, notes) VALUES
  ('EQUIP_DEPR', 'Equipment depreciation', 'depreciation', 145,
   'Capital-equipment amortization reclassed out of LEASED_EQUIP (EBITDA fix 2026-07-04). Cash treatment unchanged: equipment cash still flows through amortized opex per the R5 convention, not t=0 capex.')
ON CONFLICT (code) DO NOTHING;

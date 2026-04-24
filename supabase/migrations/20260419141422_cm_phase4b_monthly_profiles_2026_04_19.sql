
-- Phase 4b — monthly OT/absence profiles on labor lines.
-- Each profile is a 12-element JSONB array of decimal fractions.
-- e.g. monthly_overtime_profile = [0.05, 0.05, 0.05, 0.05, 0.05, 0.10, 0.10, 0.15, 0.15, 0.10, 0.10, 0.05]
-- means 5% OT in Jan-May, 10-15% Jun-Sep+Q4, etc.
-- NULL = inherit from project flat (heuristic) — backward compatible.

ALTER TABLE public.cost_model_labor
  ADD COLUMN IF NOT EXISTS monthly_overtime_profile jsonb,
  ADD COLUMN IF NOT EXISTS monthly_absence_profile  jsonb;

COMMENT ON COLUMN public.cost_model_labor.monthly_overtime_profile IS
  'Phase 4b: 12-element jsonb array of OT% fractions (Jan..Dec). NULL = use project overtime_pct heuristic.';
COMMENT ON COLUMN public.cost_model_labor.monthly_absence_profile IS
  'Phase 4b: 12-element jsonb array of absence% fractions (Jan..Dec). NULL = use project absence_allowance_pct heuristic.';

-- Constraint: when set, must be exactly 12 elements all in [0, 1]
-- Skip CHECK for now since jsonb constraints are awkward; enforce in UI.

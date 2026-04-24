
-- Asset Defaults Guidance (Brock 2026-04-20):
--   - automation_level  drives conveyor auto-add (was volume-triggered)
--   - security_tier     drives security auto-add (was sqft-threshold)
--   - fenced_perimeter_lf adds physical fencing (capital) when > 0
ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS automation_level text DEFAULT 'none'
    CHECK (automation_level IN ('none','low','medium','high')),
  ADD COLUMN IF NOT EXISTS security_tier integer DEFAULT 3
    CHECK (security_tier BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS fenced_perimeter_lf numeric DEFAULT 0
    CHECK (fenced_perimeter_lf >= 0);

COMMENT ON COLUMN public.cost_model_projects.automation_level IS
  'Drives conveyor auto-include. none|low = manual/minor aids; medium|high = powered conveyor system.';
COMMENT ON COLUMN public.cost_model_projects.security_tier IS
  'Security tier 1-4 (cumulative). Drives security asset auto-include. Default 3 matches reference template.';
COMMENT ON COLUMN public.cost_model_projects.fenced_perimeter_lf IS
  'Linear feet of perimeter fencing. 0 = none. Drives Capital fencing auto-add.';

-- Extend cost_model_equipment.acquisition_type to support the 4-way
-- financing taxonomy (capital / lease / ti / service). 'purchase' retained
-- as a legacy alias for capital to avoid breaking existing rows.
ALTER TABLE public.cost_model_equipment
  DROP CONSTRAINT IF EXISTS cost_model_equipment_acquisition_type_check;

ALTER TABLE public.cost_model_equipment
  ADD CONSTRAINT cost_model_equipment_acquisition_type_check
  CHECK (acquisition_type IN ('capital','lease','ti','service','purchase'));

COMMENT ON COLUMN public.cost_model_equipment.acquisition_type IS
  'capital = buy+depreciate; lease = monthly op lease; ti = tenant improvement (rolls into facility rent); service = managed monthly service. ''purchase'' is legacy alias for capital.';

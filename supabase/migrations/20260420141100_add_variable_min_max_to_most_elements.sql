-- MOST template editor — restore v2 Variable-element support.
-- calc.variableElementTmu already references variable_min/variable_max but
-- those columns were missing from the schema. Elements flagged is_variable
-- were silently computing just tmu_value. Add the columns so the editor UI
-- can persist min/max + so calc can actually interpolate.
ALTER TABLE ref_most_elements
  ADD COLUMN IF NOT EXISTS variable_min numeric,
  ADD COLUMN IF NOT EXISTS variable_max numeric,
  ADD COLUMN IF NOT EXISTS variable_default_factor numeric DEFAULT 0.5;

COMMENT ON COLUMN ref_most_elements.variable_min IS
  'Min TMU when the element varies (e.g., short distance).';
COMMENT ON COLUMN ref_most_elements.variable_max IS
  'Max TMU when the element varies (e.g., long distance / complex).';
COMMENT ON COLUMN ref_most_elements.variable_default_factor IS
  'Default interpolation factor 0..1 used when a template is applied without an explicit override. 0 = min, 1 = max, 0.5 = midpoint.';
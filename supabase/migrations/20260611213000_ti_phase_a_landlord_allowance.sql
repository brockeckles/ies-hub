-- TI Phase A (2026-06-11) — landlord allowance / provider-funded split.
-- Per TI Handling doc (Brock 2026-04-20), Phase A is "the biggest accuracy
-- gain": landlordFunded = min(total TI, allowance); only the provider share
-- amortizes into facility rent. Until now the engine amortized 100% of TI
-- as provider-funded — the doc's "silent $0 allowance" common mistake.
--
-- Runtime model fields ride in project_data jsonb (facility.tiAllowancePsf /
-- facility.tiAllowanceTotal, equipment ti_classification) per the D1 pattern;
-- these columns normalize the same facts for Phase 3 SQL consumers, matching
-- the add_asset_defaults_2026_04_20 precedent.

ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS landlord_ti_allowance_psf numeric DEFAULT 0
    CHECK (landlord_ti_allowance_psf >= 0),
  ADD COLUMN IF NOT EXISTS landlord_ti_allowance_total numeric
    CHECK (landlord_ti_allowance_total IS NULL OR landlord_ti_allowance_total >= 0);

COMMENT ON COLUMN public.cost_model_projects.landlord_ti_allowance_psf IS
  'Landlord TI allowance, $ per SF. Market ~$15-25/SF on a 5-yr industrial lease. 0 = none (make it a deliberate choice, not a silent default).';
COMMENT ON COLUMN public.cost_model_projects.landlord_ti_allowance_total IS
  'Explicit total allowance $. When set (> 0) wins over psf x facility_sqft. NULL = derive from PSF.';

ALTER TABLE public.cost_model_equipment
  ADD COLUMN IF NOT EXISTS ti_classification text
    CHECK (ti_classification IS NULL OR ti_classification IN ('shell','non_shell')),
  ADD COLUMN IF NOT EXISTS ti_funder text DEFAULT 'provider'
    CHECK (ti_funder IN ('landlord','provider','mixed'));

COMMENT ON COLUMN public.cost_model_equipment.ti_classification IS
  'TI lines only: shell = base-building scope (typically landlord-funded); non_shell = provider scope (hazmat, temp control, freezer). Default non_shell in calc.';
COMMENT ON COLUMN public.cost_model_equipment.ti_funder IS
  'Informational funding attribution for TI lines. The engine''s funding split is allowance-driven (min(total TI, allowance)); this column supports per-line reporting.';

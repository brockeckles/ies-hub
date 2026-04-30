-- ============================================================
-- 2026-04-30 — R12: Split conflated environment_type into
-- storage_environment + industry_vertical
-- ============================================================
-- Source: 2026-04-29 demo audit, item R12. The single Environment
-- dropdown on Cost Model Setup mixes two orthogonal axes:
--   1. Storage climate    (Ambient / Refrigerated / Freezer / Temp Controlled)
--   2. Industry vertical  (Ecommerce / Retail / Food&Bev / Industrial /
--                          Pharma / Automotive / Consumer Goods / Other)
-- Splitting them lets planning-ratios match independently, lets the
-- Setup UI show two meaningful dropdowns, and unblocks downstream
-- segmentation analytics.
--
-- environment_type column is preserved (DEPRECATED) for back-compat —
-- legacy paths that still read it continue to work; the loader will
-- prefer the new fields when they're present.
-- ============================================================

ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS storage_environment TEXT,
  ADD COLUMN IF NOT EXISTS industry_vertical   TEXT;

-- Allowed-value guards. NULLs allowed (existing rows may have neither).
ALTER TABLE public.cost_model_projects
  DROP CONSTRAINT IF EXISTS cm_storage_environment_chk;
ALTER TABLE public.cost_model_projects
  ADD CONSTRAINT cm_storage_environment_chk
  CHECK (storage_environment IS NULL OR storage_environment IN
    ('ambient','refrigerated','freezer','temperature_controlled'));

ALTER TABLE public.cost_model_projects
  DROP CONSTRAINT IF EXISTS cm_industry_vertical_chk;
ALTER TABLE public.cost_model_projects
  ADD CONSTRAINT cm_industry_vertical_chk
  CHECK (industry_vertical IS NULL OR industry_vertical IN
    ('ecommerce','retail','food_beverage','industrial','pharmaceutical',
     'automotive','consumer_goods','other'));

-- Backfill from existing environment_type (best-guess split).
UPDATE public.cost_model_projects
   SET storage_environment = CASE LOWER(TRIM(environment_type))
       WHEN 'ambient'                THEN 'ambient'
       WHEN 'refrigerated'           THEN 'refrigerated'
       WHEN 'cold'                   THEN 'refrigerated'
       WHEN 'chilled'                THEN 'refrigerated'
       WHEN 'freezer'                THEN 'freezer'
       WHEN 'frozen'                 THEN 'freezer'
       WHEN 'temperature_controlled' THEN 'temperature_controlled'
       WHEN 'temperature controlled' THEN 'temperature_controlled'
       WHEN 'temp controlled'        THEN 'temperature_controlled'
       WHEN 'temp_controlled'        THEN 'temperature_controlled'
       ELSE NULL
     END
 WHERE environment_type IS NOT NULL
   AND storage_environment IS NULL;

UPDATE public.cost_model_projects
   SET industry_vertical = CASE LOWER(TRIM(environment_type))
       WHEN 'ecommerce'         THEN 'ecommerce'
       WHEN 'e-commerce'        THEN 'ecommerce'
       WHEN 'retail'            THEN 'retail'
       WHEN 'food & beverage'   THEN 'food_beverage'
       WHEN 'food and beverage' THEN 'food_beverage'
       WHEN 'food_beverage'     THEN 'food_beverage'
       WHEN 'industrial'        THEN 'industrial'
       WHEN 'pharmaceutical'    THEN 'pharmaceutical'
       WHEN 'pharma'            THEN 'pharmaceutical'
       WHEN 'automotive'        THEN 'automotive'
       WHEN 'consumer goods'    THEN 'consumer_goods'
       WHEN 'consumer_goods'    THEN 'consumer_goods'
       ELSE NULL
     END
 WHERE environment_type IS NOT NULL
   AND industry_vertical IS NULL;

-- Helpful indexes for planning-ratios applicability filtering.
CREATE INDEX IF NOT EXISTS idx_cm_projects_storage_environment
  ON public.cost_model_projects (storage_environment);
CREATE INDEX IF NOT EXISTS idx_cm_projects_industry_vertical
  ON public.cost_model_projects (industry_vertical);

COMMENT ON COLUMN public.cost_model_projects.storage_environment IS
  'Storage climate classification - ambient/refrigerated/freezer/temperature_controlled. Drives storage-labor + facility-rate lookups. Replaces conflated environment_type in combination with industry_vertical.';
COMMENT ON COLUMN public.cost_model_projects.industry_vertical IS
  'Customer-side industry - ecommerce/retail/food_beverage/industrial/pharmaceutical/automotive/consumer_goods/other. Drives planning-ratios applicability scoring. Replaces conflated environment_type in combination with storage_environment.';
COMMENT ON COLUMN public.cost_model_projects.environment_type IS
  'DEPRECATED - kept for back-compat. New code should write storage_environment + industry_vertical. See migration 20260430201500.';

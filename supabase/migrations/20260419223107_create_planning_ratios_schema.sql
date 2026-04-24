
-- =============================================================================
-- 1. DIMENSIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ref_heuristic_categories (
  code          text PRIMARY KEY,
  display_name  text NOT NULL,
  description   text,
  sort_order    integer NOT NULL DEFAULT 100
);

INSERT INTO public.ref_heuristic_categories (code, display_name, description, sort_order) VALUES
  ('labor_spans',        'Management spans of control',        'Indirect + salary headcount ratios per N direct',  10),
  ('labor_mix',          'Labor mix and workforce strategy',   'Permanent/temp ratios, flexing, turnover, wage load', 20),
  ('labor_escalation',   'Labor escalation + productivity',    'YOY wage growth, UPH growth, OT, PTO',              30),
  ('labor_ramp',         'Labor ramp and performance curves',  'Productivity ramp by complexity tier',              40),
  ('volume_indirect',    'Volume-driven indirect roles',       'Indirect headcount rules keyed to volume/automation drivers', 50),
  ('facility_space',     'Facility space-planning ratios',     'SF allocations, dock density, office ratio, breakroom', 60),
  ('facility_lighting',  'Lighting fixture density',           'Fixtures per 1,000 SF by zone',                     70),
  ('facility_utility',   'Utility + electrical distribution',  'Load split, HVLS fan density',                      80),
  ('facility_geometry',  'Building geometry defaults',         'Depth, column spacing, aisle widths, dock depth',   90),
  ('storage_utilization','Storage utilization targets',        'Target fill % by rack media',                      100),
  ('storage_cost_psf',   'Storage cost per SF',                'Monthly $/SF components (rent, tax, insurance, CAM, ...)', 110),
  ('security_tiers',     'Security tier composition',          'What each 1-4 security level includes',            120),
  ('asset_loaded_cost',  'Asset loaded-cost factors',          'Contingency, freight, tax, allowances %',          130),
  ('asset_useful_life',  'Asset useful life',                  'Depreciation periods by asset category',           140),
  ('startup_ratios',     'Startup + training ratios',          'PS rate, travel cost, training ramp premium',      150),
  ('seasonality',        'Seasonality by vertical',            'Monthly volume share by vertical (sums to 1.0)',   160),
  ('sku_growth',         'SKU growth defaults',                'Year-over-year SKU count growth',                  170);

CREATE TABLE IF NOT EXISTS public.ref_planning_ratios (
  id              bigserial PRIMARY KEY,
  category_code   text NOT NULL REFERENCES public.ref_heuristic_categories(code) ON DELETE RESTRICT,
  ratio_code      text NOT NULL,
  display_name    text NOT NULL,
  description     text,

  value_type      text NOT NULL CHECK (value_type IN
    ('scalar','percent','psf','per_sf_1k','per_unit','array','lookup','tiered')),
  numeric_value   numeric,
  value_unit      text,
  value_jsonb     jsonb,

  vertical        text,
  environment_type text,
  automation_level text
                  CHECK (automation_level IN ('none','low','medium','high') OR automation_level IS NULL),
  market_tier     text,
  applies_if_jsonb jsonb,

  source          text NOT NULL DEFAULT 'TBD',
  source_detail   text,
  source_date     date,
  effective_date  date NOT NULL DEFAULT CURRENT_DATE,
  effective_end_date date NOT NULL DEFAULT '9999-12-31',
  version         integer NOT NULL DEFAULT 1,
  superseded_by_id bigint REFERENCES public.ref_planning_ratios(id) ON DELETE SET NULL,

  sort_order      integer NOT NULL DEFAULT 100,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (ratio_code, vertical, environment_type, automation_level, market_tier, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_ratios_category       ON public.ref_planning_ratios (category_code);
CREATE INDEX IF NOT EXISTS idx_ratios_ratio_code     ON public.ref_planning_ratios (ratio_code);
CREATE INDEX IF NOT EXISTS idx_ratios_applicability  ON public.ref_planning_ratios (vertical, environment_type, automation_level);
CREATE INDEX IF NOT EXISTS idx_ratios_effective      ON public.ref_planning_ratios (effective_date, effective_end_date) WHERE is_active;

COMMENT ON TABLE public.ref_planning_ratios IS
  'Planning heuristics catalog. Each row is one rule (e.g. 1 Operations Manager per 75 direct FTE). Rules with null applicability fields apply to all projects; rules with filters apply only when the project matches.';

ALTER TABLE public.ref_heuristic_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ref_planning_ratios ENABLE ROW LEVEL SECURITY;

CREATE POLICY anon_select_ref_heuristic_categories ON public.ref_heuristic_categories FOR SELECT TO public USING (true);
CREATE POLICY anon_insert_ref_heuristic_categories ON public.ref_heuristic_categories FOR INSERT TO public WITH CHECK (true);
CREATE POLICY anon_update_ref_heuristic_categories ON public.ref_heuristic_categories FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY anon_delete_ref_heuristic_categories ON public.ref_heuristic_categories FOR DELETE TO public USING (true);

CREATE POLICY anon_select_ref_planning_ratios ON public.ref_planning_ratios FOR SELECT TO public USING (true);
CREATE POLICY anon_insert_ref_planning_ratios ON public.ref_planning_ratios FOR INSERT TO public WITH CHECK (true);
CREATE POLICY anon_update_ref_planning_ratios ON public.ref_planning_ratios FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY anon_delete_ref_planning_ratios ON public.ref_planning_ratios FOR DELETE TO public USING (true);

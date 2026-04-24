
-- ---------- Heuristics catalog + override column ----------

CREATE TABLE IF NOT EXISTS public.ref_design_heuristics (
  id             bigserial PRIMARY KEY,
  key            text NOT NULL UNIQUE,
  label          text NOT NULL,
  description    text,
  category       text NOT NULL
                 CHECK (category IN ('financial','working_capital','labor','ramp_seasonality','ops_escalation')),
  data_type      text NOT NULL DEFAULT 'number'
                 CHECK (data_type IN ('percent','number','integer','enum','currency')),
  unit           text,
  default_value  numeric,
  default_enum   text,
  allowed_enums  jsonb,
  min_value      numeric,
  max_value      numeric,
  sort_order     integer NOT NULL DEFAULT 0,
  source_citation text DEFAULT 'IES Hub standard',
  notes          text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_design_heur_category ON public.ref_design_heuristics(category);
CREATE INDEX IF NOT EXISTS idx_design_heur_active   ON public.ref_design_heuristics(is_active);

ALTER TABLE public.ref_design_heuristics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ref_design_heur_rw ON public.ref_design_heuristics;
CREATE POLICY ref_design_heur_rw ON public.ref_design_heuristics FOR ALL
  USING (true) WITH CHECK (true);

-- Per-project override jsonb
ALTER TABLE public.cost_model_projects
  ADD COLUMN IF NOT EXISTS heuristic_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Extend rate_card_type CHECK to include 'heuristics'
ALTER TABLE public.cost_model_rate_snapshots
  DROP CONSTRAINT IF EXISTS cost_model_rate_snapshots_rate_card_type_check;
ALTER TABLE public.cost_model_rate_snapshots
  ADD CONSTRAINT cost_model_rate_snapshots_rate_card_type_check
  CHECK (rate_card_type IN ('labor','facility','utility','equipment','overhead','pricing_assumptions','periods','heuristics'));

-- ---------- Seed 25 standard heuristics ----------
INSERT INTO public.ref_design_heuristics
  (key, label, description, category, data_type, unit, default_value, default_enum, allowed_enums, min_value, max_value, sort_order, notes)
VALUES
-- Financial (sort 100-199)
('tax_rate_pct',              'Effective Tax Rate',             'Blended corporate tax rate applied to EBIT.',                                           'financial', 'percent', '%',    25,    NULL, NULL, 0,   50, 110, 'Phase 1 uses this per-project; fallback 25%.'),
('discount_rate_pct',         'Discount Rate (NPV)',            'WACC-equivalent for NPV of monthly free cash flows.',                                  'financial', 'percent', '%',    10,    NULL, NULL, 3,   25,  120, 'GXO standard WACC band is 8–12%.'),
('reinvest_rate_pct',         'Reinvestment Rate (MIRR)',       'Rate used for reinvestment assumption in modified IRR.',                               'financial', 'percent', '%',    8,     NULL, NULL, 0,   20,  130, NULL),
('target_margin_pct',         'Target Margin',                  'Default EBIT margin target if no pricing buckets supplied (margin-driven fallback).',  'financial', 'percent', '%',    12,    NULL, NULL, 0,   50,  140, NULL),
('annual_volume_growth_pct',  'Annual Volume Growth',           'Default YoY volume growth applied to base-year volumes.',                              'financial', 'percent', '%',    0,     NULL, NULL, -20, 50,  150, NULL),
('contract_term_years',       'Contract Term',                  'Default analysis horizon in years (Year 1..N).',                                       'financial', 'integer', 'years', 5,    NULL, NULL, 1,   10,  160, 'Historical default was 3 yrs; moved to 5 for longer-range capex amortisation.'),

-- Working Capital (sort 200-299)
('dso_days',                  'Days Sales Outstanding',         'Average days between invoice and collection on customer AR.',                          'working_capital','integer','days', 30,  NULL, NULL, 0,   120, 200, NULL),
('dpo_days',                  'Days Payable Outstanding',       'Average days between vendor invoice and payment.',                                     'working_capital','integer','days', 30,  NULL, NULL, 0,   120, 210, NULL),
('labor_payable_days',        'Labor Payable Days',             'Days between hours worked and payroll disbursement (accrual).',                        'working_capital','integer','days', 14,  NULL, NULL, 0,   30,  220, NULL),
('pre_go_live_months',        'Pre-Go-Live Months',             'Number of implementation months before revenue begins (startup burn window).',         'working_capital','integer','months',0,   NULL, NULL, 0,   24,  230, NULL),

-- Labor (sort 300-399)
('benefit_load_pct',          'Benefit Load %',                 'Benefits loaded on top of hourly wage (health, 401k, PTO, etc.).',                     'labor',     'percent', '%',    35,    NULL, NULL, 0,   80,  300, NULL),
('bonus_pct',                 'Bonus / Gainshare %',            'Default bonus allowance on top of base pay.',                                          'labor',     'percent', '%',    0,     NULL, NULL, 0,   25,  310, NULL),
('overtime_pct',              'Overtime Allowance %',           'Fraction of hours paid at OT multiplier by default.',                                  'labor',     'percent', '%',    5,     NULL, NULL, 0,   30,  320, NULL),
('absence_allowance_pct',     'Absence / PTO %',                'Unproductive hours assumption (PTO, sick, training).',                                 'labor',     'percent', '%',    12,    NULL, NULL, 0,   25,  330, 'Stored as fraction on projects (0.12) but modelled as % here.'),
('shift_2_premium_pct',       'Shift 2 Premium %',              'Wage uplift for second-shift hours.',                                                  'labor',     'percent', '%',    10,    NULL, NULL, 0,   30,  340, NULL),
('shift_3_premium_pct',       'Shift 3 Premium %',              'Wage uplift for third-shift / overnight hours.',                                       'labor',     'percent', '%',    15,    NULL, NULL, 0,   40,  350, NULL),
('labor_escalation_pct',      'Labor Escalation % / yr',        'Annual wage inflation applied to hourly rates.',                                       'labor',     'percent', '%',    3,     NULL, NULL, 0,   15,  360, NULL),

-- Ramp + Seasonality (sort 400-499)
('ramp_weeks_low',            'Ramp Weeks (Low Complexity)',    'Weeks to reach full productivity for low-complexity operations.',                      'ramp_seasonality','integer','weeks',2, NULL, NULL, 1,   26, 400, NULL),
('ramp_weeks_med',            'Ramp Weeks (Med Complexity)',    'Weeks to reach full productivity for typical operations.',                             'ramp_seasonality','integer','weeks',4, NULL, NULL, 1,   26, 410, NULL),
('ramp_weeks_high',           'Ramp Weeks (High Complexity)',   'Weeks to reach full productivity for complex operations.',                             'ramp_seasonality','integer','weeks',8, NULL, NULL, 1,   52, 420, NULL),
('default_seasonality',       'Default Seasonality Profile',    'Shape applied to monthly volume when no per-project profile set.',                     'ramp_seasonality','enum',   NULL,   NULL,   'flat', '["flat","retail_peak_q4","ecomm_bimodal","cpg_steady","cold_chain_summer"]'::jsonb, NULL, NULL, 430, NULL),

-- Ops + Escalation (sort 500-599)
('equipment_escalation_pct',  'Equipment Escalation % / yr',    'Annual uplift on capex / lease rates.',                                                'ops_escalation','percent','%',  3, NULL, NULL, 0, 15, 500, NULL),
('facility_escalation_pct',   'Facility Escalation % / yr',     'Annual uplift on lease / CAM / insurance / taxes.',                                    'ops_escalation','percent','%',  3, NULL, NULL, 0, 15, 510, NULL),
('units_per_truck',           'Units per Truck (COG)',          'Payload capacity used to convert weight × distance to truckloads.',                    'ops_escalation','integer','units', 25000, NULL, NULL, 1000, 100000, 520, 'Default = typical 53-ft dry van. Refrigerated / flatbed differ.'),
('dock_sf_per_door',          'Dock SF per Door (WSC)',         'Reserved floor area per dock door for staging + maneuvering.',                         'ops_escalation','integer','sqft', 700, NULL, NULL, 300, 1200, 530, 'GXO-standard 700 SF/door replaces the old 200 SF assumption.'),
('rack_honeycomb_pct',        'Rack Honeycomb %',               'Buffer factor added to storage positions to cover slot-mix inefficiency.',             'ops_escalation','percent','%',   20, NULL, NULL, 0, 50, 540, NULL)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      data_type = EXCLUDED.data_type,
      unit = EXCLUDED.unit,
      default_value = EXCLUDED.default_value,
      default_enum = EXCLUDED.default_enum,
      allowed_enums = EXCLUDED.allowed_enums,
      min_value = EXCLUDED.min_value,
      max_value = EXCLUDED.max_value,
      sort_order = EXCLUDED.sort_order,
      notes = EXCLUDED.notes,
      updated_at = now();

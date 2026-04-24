
-- 3.12 STORAGE PSF
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('storage_cost_psf', 'storage.psf.rent',                  'Rent (NNN)',           'psf', 0.35,  'USD/SF/month', 'Reference template', 'Building Requirements D85', 10, '2018 template default. Atlanta 2026 market is $0.55-0.85.'),
  ('storage_cost_psf', 'storage.psf.real_estate_tax',       'Real estate tax',      'psf', 0.02,  'USD/SF/month', 'Reference template', 'Building Requirements D86', 20, 'Passthrough on NNN lease.'),
  ('storage_cost_psf', 'storage.psf.insurance',             'Insurance',            'psf', 0.05,  'USD/SF/month', 'Reference template', 'Building Requirements D87', 30, 'Building + contents, excluding specialty coverages.'),
  ('storage_cost_psf', 'storage.psf.cam',                   'CAM (common area maintenance)','psf', 0, 'USD/SF/month','Reference template', 'Building Requirements D88', 40, 'Model default zero - assumes NNN where CAM is customer-paid or rolled into rent.'),
  ('storage_cost_psf', 'storage.psf.utilities',             'Utilities',            'psf', 0.002, 'USD/SF/month', 'Reference template', 'Building Requirements D89', 50, 'Anomalously low - real number is typically $0.10-0.20/SF/month. Suspect this supplements a customer-paid utility bill.'),
  ('storage_cost_psf', 'storage.psf.warehouse_protection',  'Warehouse protection (sprinkler+security)','psf', 0.06, 'USD/SF/month','Reference template', 'Building Requirements D90', 60, 'Sprinkler maintenance, fire protection, alarm monitoring.'),
  ('storage_cost_psf', 'storage.psf.operating_expenses',    'Operating expenses (pest/cleaning)','psf', 0.05, 'USD/SF/month', 'Reference template', 'Building Requirements D91', 70, 'Recurring services.'),
  ('storage_cost_psf', 'storage.psf.waste_snow',            'Waste + snow removal',  'psf', 0.01, 'USD/SF/month', 'Reference template', 'Building Requirements D92', 80, 'Higher in snow belt.'),
  ('storage_cost_psf', 'storage.psf.total_loaded',          'Total storage $/SF/mo', 'psf', 0.542, 'USD/SF/month', 'Reference template', 'Building Requirements D95', 90, 'Sum of components. 2018 Atlanta - refresh for current market.');

-- 3.13 ASSET LOADED COST
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('asset_loaded_cost', 'asset.load.contingency_building',   'Contingency - building improvements',    'percent', 0.10,  'fraction', 'Reference template', 'Building Requirements K10', 10, 'Applied to building-improvement lines.'),
  ('asset_loaded_cost', 'asset.load.contingency_equipment',  'Contingency - equipment/MHE',            'percent', 0.05,  'fraction', 'Reference template', 'Assets H12',                20, 'Applied to MHE and IT.'),
  ('asset_loaded_cost', 'asset.load.freight_building',       'Freight - building improvements',        'percent', 0.025, 'fraction', 'Reference template', 'Building Requirements L10', 30, '2.5% for building items.'),
  ('asset_loaded_cost', 'asset.load.freight_equipment',      'Freight - equipment/MHE',                'percent', 0.075, 'fraction', 'Reference template', 'Assets I12',                40, '7.5% for MHE.'),
  ('asset_loaded_cost', 'asset.load.tax_pct',                'Tax on assets',                          'percent', 0.0925,'fraction', 'Reference template', 'Assets J12',                50, 'Sales tax - varies by state; 9.25% is template default.'),
  ('asset_loaded_cost', 'asset.load.allowances_pct_default', 'Installation allowances',                'percent', 0.00,  'fraction', 'Reference template', 'Assets G12',                60, 'Additional install/labor loading - 0 by default, set Y/N per asset.');

-- 3.14 RACK POSITION UNIT COSTS + DOCK / BUILDING
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('asset_loaded_cost', 'asset.rack.cost_per_position.pallet_standard',   'Std pallet rack $/position',         'per_unit', 60,   'USD/position', 'Reference template', 'Assets Pallet Rack row', 110, '2018 USD. Single-select rack.'),
  ('asset_loaded_cost', 'asset.rack.cost_per_position.double_deep_low',   'Double deep rack - low end',         'per_unit', 64,   'USD/position', 'Reference template', 'Assets row 20',          120, 'Lower range.'),
  ('asset_loaded_cost', 'asset.rack.cost_per_position.double_deep_high',  'Double deep rack - high end',        'per_unit', 94,   'USD/position', 'Reference template', 'Assets row 21',          130, 'Upper range.'),
  ('asset_loaded_cost', 'asset.rack.cost_per_position.push_back_low',     'In-rack push-back - low end',        'per_unit', 115,  'USD/position', 'Reference template', 'Assets row 22',          140, 'Lower range.'),
  ('asset_loaded_cost', 'asset.rack.cost_per_position.push_back_high',    'In-rack push-back - high end',       'per_unit', 120,  'USD/position', 'Reference template', 'Assets row 23',          150, 'Upper range.'),
  ('asset_loaded_cost', 'asset.rack.cost_per_position.pallet_flow_low',   'In-rack pallet flow - low end',      'per_unit', 140,  'USD/position', 'Reference template', 'Assets row 24',          160, 'Lower range.'),
  ('asset_loaded_cost', 'asset.rack.cost_per_position.pallet_flow_high',  'In-rack pallet flow - high end',     'per_unit', 160,  'USD/position', 'Reference template', 'Assets row 25',          170, 'Upper range.'),
  ('asset_loaded_cost', 'asset.rack.cost_per_lane.pallet_flow_lane',      'Pallet flow lane $',                 'per_unit', 1200, 'USD/lane',     'Reference template', 'Assets row 19',          180, 'Per full lane (5-deep).'),
  ('asset_loaded_cost', 'asset.dock.mechanical_leveler_35k',    '35,000-lb mechanical dock leveler', 'per_unit', 8000, 'USD/each', 'Reference template', 'Building Requirements E26', 190, 'Per dock position.'),
  ('asset_loaded_cost', 'asset.dock.dock_seal',                 'Dock seal',                         'per_unit', 1500, 'USD/each', 'Reference template', 'Building Requirements E27', 200, 'Weather seal per dock.'),
  ('asset_loaded_cost', 'asset.dock.mechanical_restraint',      'Mechanical dock restraint',         'per_unit', 4500, 'USD/each', 'Reference template', 'Building Requirements E28', 210, 'Truck restraint.'),
  ('asset_loaded_cost', 'asset.dock.swing_arm_light',           'Swing-arm light/fan',               'per_unit', 1000, 'USD/each', 'Reference template', 'Building Requirements E29', 220, 'Dock-side work light.'),
  ('asset_loaded_cost', 'asset.dock.dock_package',              'Dock package (per position)',       'per_unit', 3500, 'USD/each', 'Reference template', 'Security D44',              230, 'Full dock position packages.'),
  ('asset_loaded_cost', 'asset.ventilation.hvls_fan',           'HVLS fan unit cost',                'per_unit', 12000,'USD/each', 'Reference template', 'Building Requirements E49', 240, 'Fan hardware; installation extra.'),
  ('asset_loaded_cost', 'asset.ventilation.hvls_fan_big_ass',   'HVLS fan (Big Ass Fan brand)',      'per_unit', 8500, 'USD/each', 'Reference template', 'Security D46',              250, 'Common commercial HVLS.'),
  ('asset_loaded_cost', 'asset.building.guard_shack',           'Guard shack (HVAC + elec + sidewalk)','per_unit', 40000,'USD/each','Reference template', 'Building Requirements E36', 260, 'Full installation.'),
  ('asset_loaded_cost', 'asset.building.guard_shack_external',  'External guard shack',              'per_unit', 43000,'USD/each', 'Reference template', 'Security D36',              270, 'Variant with external enclosure.'),
  ('asset_loaded_cost', 'asset.building.gate_automation',       'Gate automation',                   'per_unit', 25000,'USD/each', 'Reference template', 'Security D37',              280, 'Motorized gate + controls.'),
  ('asset_loaded_cost', 'asset.building.compactor',             'Compactor',                         'per_unit', 15000,'USD/each', 'Reference template', 'Security D47',              290, 'Waste compactor.');

-- 3.15 SECURITY TIERS
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('security_tiers', 'security.tier.default_level', 'Default security tier', 'scalar', 3, '1-4', 'Reference template', 'Security C7', 10, 'Template defaults to Level 3.');

INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, value_jsonb, value_unit, source, source_detail, sort_order, notes) VALUES
  ('security_tiers', 'security.tier.composition', 'Security tier composition (cumulative)', 'tiered',
    jsonb_build_object(
      'level_1', jsonb_build_object('name', 'Burglar alarm + access controls', 'items', jsonb_build_array(
        jsonb_build_object('name', 'Burglar alarm system', 'cost_driver', 'per_site'),
        jsonb_build_object('name', 'Door controls - stop alarms', 'cost_each', 75, 'cost_driver', 'per_door'),
        jsonb_build_object('name', 'Overhead-door security', 'cost_each', 10, 'cost_driver', 'per_overhead_door'),
        jsonb_build_object('name', 'Ramp-door management', 'cost_each', 300, 'cost_driver', 'per_ramp_door'),
        jsonb_build_object('name', 'Security signage', 'cost_each', 1000, 'cost_driver', 'per_site'),
        jsonb_build_object('name', 'Driver cages', 'cost_each', 5500, 'cost_driver', 'per_site'),
        jsonb_build_object('name', 'C-TPAT compliance materials', 'cost_each', 500, 'cost_driver', 'per_site'))),
      'level_2', jsonb_build_object('name', 'CCTV', 'items', jsonb_build_array(
        jsonb_build_object('name', 'Camera system head-end', 'cost_each', 20000, 'cost_driver', 'per_site'),
        jsonb_build_object('name', 'Cameras', 'cost_each', 1562, 'cost_driver', 'per_camera'))),
      'level_3', jsonb_build_object('name', 'Controlled access (default tier)', 'items', jsonb_build_array(
        jsonb_build_object('name', 'Access control head-end', 'cost_each', 20000, 'cost_driver', 'per_site'),
        jsonb_build_object('name', 'Additional badge readers', 'cost_each', 1150, 'cost_driver', 'per_badge_reader'),
        jsonb_build_object('name', 'Employee entrance', 'cost_each', 2500, 'cost_driver', 'per_site'),
        jsonb_build_object('name', 'Metal detectors', 'cost_each', 5000, 'cost_driver', 'per_entrance'))),
      'level_4', jsonb_build_object('name', 'Guard-shack full', 'items', jsonb_build_array(
        jsonb_build_object('name', 'External guard shack', 'cost_each', 43000, 'cost_driver', 'per_site'),
        jsonb_build_object('name', 'Gate automation', 'cost_each', 25000, 'cost_driver', 'per_gate')))
    ), 'tiered config',
    'Reference template', 'Security sheet rows 11-38', 20,
    'Security levels are cumulative: Level 3 includes everything in Levels 1 and 2. Higher tier for regulated verticals.');

-- 3.16 STARTUP
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('startup_ratios', 'startup.professional_services.hourly_rate', 'Professional services rate', 'per_unit', 125,  'USD/hour',     'Reference template', 'Initial Expenses F11', 10, 'Standard consultant rate for PM, Engineering, LMS, HR, Facilities, Security, WMS specialist, etc.'),
  ('startup_ratios', 'startup.travel.cost_per_trip',              'Travel cost per trip',       'per_unit', 2000, 'USD/trip',     'Reference template', 'Initial Expenses H28', 20, 'Domestic US trip. International 2-3x.'),
  ('startup_ratios', 'startup.pro_services.pct_of_revenue',       'Prof services reserve',      'percent',  0.05, 'fraction',     'Reference template', 'Initial Expenses H36', 30, 'Reserve professional services budget as % of Y1 revenue.'),
  ('startup_ratios', 'startup.5s_kit_cost_per_100k_sf',           '5S startup kit cost/100k SF','per_unit', 7086, 'USD/100k SF',  'Reference template', '5S Startup Kit E16',   40, '5S kit: shadow boards, bulletin boards, trash cans, floor tape.'),
  ('startup_ratios', 'startup.5s_signage_cost',                   '5S signage (inbound+outbound)','per_unit',4400,'USD/site',     'Reference template', '5S Startup Kit E21',   50, 'Fixed signage cost per site.');

-- 3.17 SEASONALITY
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, vertical, value_type, value_jsonb, value_unit, source, source_detail, sort_order, notes) VALUES
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Straight Line',        NULL,                  'array', jsonb_build_array(0.0833,0.0833,0.0833,0.0833,0.0833,0.0833,0.0833,0.0833,0.0833,0.0833,0.0833,0.0833), 'monthly fraction', 'Derived', '1/12 each month', 10, 'Default when no vertical-specific profile applies.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Specialty Retail',    'specialty_retail',    'array', jsonb_build_array(0.0655,0.0732,0.0856,0.0812,0.0808,0.0864,0.0829,0.0912,0.0926,0.0792,0.0885,0.0927), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 20, 'Q3/Q4 peak - holiday + back-to-school.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Consumer Goods',      'consumer_goods',      'array', jsonb_build_array(0.0807,0.0832,0.0880,0.0840,0.0754,0.0777,0.0785,0.0818,0.0833,0.0897,0.0831,0.0946), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 30, 'Dec peak - holiday shipping.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Consumer Electronics','consumer_electronics','array', jsonb_build_array(0.0726,0.0698,0.0797,0.0775,0.0765,0.0818,0.0815,0.0872,0.0930,0.0928,0.0994,0.0883), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 40, 'Q4 heavy - Black Friday/Cyber Monday.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Food and Beverage',   'food_and_beverage',   'array', jsonb_build_array(0.1019,0.0765,0.0847,0.0786,0.0775,0.0813,0.0766,0.0784,0.0795,0.0850,0.0815,0.0985), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 50, 'Jan + Dec peaks.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Industrial',          'industrial',          'array', jsonb_build_array(0.0827,0.0832,0.0882,0.0867,0.0833,0.0784,0.0810,0.0833,0.0828,0.0766,0.0820,0.0919), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 60, 'Relatively flat.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Healthcare',          'healthcare',          'array', jsonb_build_array(0.0820,0.0806,0.0842,0.0788,0.0764,0.0812,0.0797,0.0829,0.0833,0.0937,0.0895,0.0879), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 70, 'Oct-Nov flu/Rx peak.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Automotive',          'automotive',          'array', jsonb_build_array(0.0765,0.0801,0.0884,0.0848,0.0820,0.0834,0.0826,0.0844,0.0882,0.0851,0.0799,0.0846), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 80, 'Mar + Sep peaks.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Publishing',          'publishing',          'array', jsonb_build_array(0.0804,0.0804,0.0832,0.0806,0.0788,0.0801,0.0830,0.0825,0.0898,0.0929,0.0834,0.0849), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 90, 'Back-to-school + holiday.'),
  ('seasonality', 'seasonality.monthly_share', 'Seasonality - Chemicals',           'chemicals',           'array', jsonb_build_array(0.0666,0.0715,0.0973,0.0853,0.0980,0.1030,0.0899,0.0858,0.0762,0.0763,0.0725,0.0775), 'monthly fraction', 'Reference template', 'Seasonality by Vertical (2010)', 100, 'Spring agricultural + summer construction peak.');

-- 3.18 SKU GROWTH
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('sku_growth', 'volume.sku_count_growth_yoy', 'YOY SKU count growth', 'percent', 0.05, 'fraction', 'Reference template', 'Storage C9', 10, 'Default 5% - applied to SKU count in rack-sizing calcs.');

-- Set source_date for "needs refresh" chip logic
UPDATE public.ref_planning_ratios SET source_date = '2018-03-01' WHERE source = 'Reference template';
UPDATE public.ref_planning_ratios SET source_date = '2014-12-31' WHERE source = 'Historical %Perm Hours';
UPDATE public.ref_planning_ratios SET source_date = '2010-01-01' WHERE category_code = 'seasonality' AND source = 'Reference template';
UPDATE public.ref_planning_ratios SET source_date = '2026-04-01' WHERE source IN ('Reference template auto-generator', 'Derived');

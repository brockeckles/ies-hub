
-- 3.6 RAMP CURVES
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, value_jsonb, value_unit, source, source_detail, sort_order, notes) VALUES
  ('labor_ramp', 'labor.ramp.low_complexity',    'Ramp curve - Low complexity',    'lookup',
    jsonb_build_object('initial_performance_pct', 0.545, 'initial_ramp_weeks', 2, 'initial_weekly_increase_pct', 0.18, 'secondary_weekly_increase_pct', 0.08, 'weeks_to_max', 4.19), 'curve',
    'Reference template', 'Labor F31:K31', 10, 'Low-complexity (picking, pallet handling). Reaches full productivity in 4.19 weeks.'),
  ('labor_ramp', 'labor.ramp.medium_complexity', 'Ramp curve - Medium complexity', 'lookup',
    jsonb_build_object('initial_performance_pct', 0.478, 'initial_ramp_weeks', 2.5, 'initial_weekly_increase_pct', 0.16, 'secondary_weekly_increase_pct', 0.065, 'weeks_to_max', 5.38), 'curve',
    'Reference template', 'Labor F32:K32', 20, 'Medium-complexity (multi-SKU picking, VAS). Reaches full productivity in 5.38 weeks.'),
  ('labor_ramp', 'labor.ramp.high_complexity',   'Ramp curve - High complexity',   'lookup',
    jsonb_build_object('initial_performance_pct', 0.40, 'initial_ramp_weeks', 5, 'initial_weekly_increase_pct', 0.10, 'secondary_weekly_increase_pct', 0.0275, 'weeks_to_max', 9.64), 'curve',
    'Reference template', 'Labor F33:K33', 30, 'High-complexity (technical, regulated, multi-step). Reaches full productivity in 9.64 weeks.');

INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('labor_ramp', 'labor.ramp.max_performance',      'Max performance (asymptote)',   'percent', 1.0, 'fraction',   'Reference template', 'Labor D37', 40, 'Productivity ceiling at 100% of standard.'),
  ('labor_ramp', 'labor.ramp.training_premium_pct', 'Training ramp inefficiency',    'percent', 0.30, 'fraction',  'Reference template auto-generator', 'calc.js line 1290', 50, 'Labor productivity is 30% below standard during the training period.'),
  ('labor_ramp', 'labor.ramp.training_weeks_default','Default training ramp duration','scalar', 8,    'weeks',     'Reference template auto-generator', 'calc.js line 1290', 60, 'Ramp premium applied over 8 weeks by default.');

-- 3.7 FACILITY SPACE
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('facility_space', 'facility.office.pct_of_total_sf',     'Main office as % of total SF',     'percent', 0.01,  'fraction',      'Reference template', 'Building Requirements B10', 10, 'Main office + restrooms = 1% of total building SF.'),
  ('facility_space', 'facility.breakroom.sf_per_employee',  'Breakroom SF per employee',        'scalar',  20,    'SF/employee',   'Reference template', 'Building Requirements B11', 20, 'Allocated based on avg employee headcount (not peak).'),
  ('facility_space', 'facility.shipping_receiving.sf_per_dock', 'Shipping/Receiving SF per dock','scalar', 1000, 'SF/dock',       'Reference template', 'Building Requirements B12', 30, 'Staging area per dock door.'),
  ('facility_space', 'facility.mdf_room.sf',                'MDF/IDF room (fixed)',             'scalar',  500,   'SF',            'Reference template', 'Building Requirements B13', 40, 'Main Distribution Frame room, typically 1 per site.'),
  ('facility_space', 'facility.dock_count.sf_per_dock',     'Dock doors per SF',                'scalar',  10000, 'SF per dock',   'Reference template', 'Building Requirements B25', 50, '1 dock door per 10,000 SF. Adjust for throughput-intensive operations.'),
  ('facility_space', 'facility.loading.sides',              'Loading sides (default)',          'scalar',  2,     'sides',         'Reference template', 'Building Requirements C5',  60, 'Cross-dock assumption. 1 side = end-load only.'),
  ('facility_space', 'facility.dock_depth',                 'Dock depth',                       'scalar',  100,   'ft',            'Reference template', 'Space sheet C32',           70, 'Standard dock staging depth.'),
  ('facility_space', 'facility.truck_court_fence_lf_cost',  'Truck court fence cost/LF',        'per_unit',30,    'USD/linear ft', 'Reference template', 'Building Requirements E35', 80, 'Fencing the truck court perimeter.');

-- 3.8 LIGHTING
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('facility_lighting', 'facility.lighting.base_fixtures_per_1k_sf', 'Base lighting fixtures per 1,000 SF',  'per_sf_1k', 1.00,   'fixtures/1k SF', 'Reference template', 'Building Requirements C19', 10, 'General overhead lighting across all zones.'),
  ('facility_lighting', 'facility.lighting.rack_fixtures_per_1k_sf', 'Rack lighting fixtures per 1,000 SF',  'per_sf_1k', 1.75,   'fixtures/1k SF', 'Reference template', 'Building Requirements C20', 20, 'Additional fixtures in racked zones (narrow aisles need more light).'),
  ('facility_lighting', 'facility.lighting.additional_fixtures_per_1k_sf', 'Additional lighting per 1,000 SF','per_sf_1k', 0.75,  'fixtures/1k SF', 'Reference template', 'Building Requirements C21', 30, 'Task lighting for pick/pack stations, dock doors.');

-- 3.9 UTILITY
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('facility_utility', 'facility.electrical.battery_charger_load_pct',  'Battery charger % of electrical load','percent', 0.30, 'fraction',          'Reference template', 'Building Requirements E42', 10, 'When battery charging is in-scope (electric MHE fleet).'),
  ('facility_utility', 'facility.electrical.warehouse_load_pct',        'Warehouse electrical % of load',      'percent', 0.70, 'fraction',          'Reference template', 'Building Requirements E43', 20, 'General warehouse electrical (no automation). Drops as automation grows.'),
  ('facility_utility', 'facility.ventilation.hvls_fan_sf_per_fan',      'HVLS fan SF coverage',                'scalar', 75000, 'SF per fan',         'Reference template', 'Building Requirements C49', 30, '1 HVLS (High Volume Low Speed) fan per 75,000 SF.');

-- 3.10 GEOMETRY
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order) VALUES
  ('facility_geometry', 'facility.geometry.building_depth',       'Building depth default',          'scalar', 400,  'ft',        'Reference template', 'Space C27',  10),
  ('facility_geometry', 'facility.geometry.column_spacing',       'Column spacing',                  'scalar', 50,   'ft',        'Reference template', 'Space C28',  20),
  ('facility_geometry', 'facility.geometry.aisle_width_pallet',   'Aisle width - pallet (VNA)',      'scalar', 11,   'ft',        'Reference template', 'Space C30',  30),
  ('facility_geometry', 'facility.geometry.aisle_width_other',    'Aisle width - other (hand-stack)','scalar', 6,    'ft',        'Reference template', 'Space C31',  40),
  ('facility_geometry', 'facility.geometry.pallet_width',         'Pallet width',                    'scalar', 40,   'inches',    'Reference template', 'Space C37',  50),
  ('facility_geometry', 'facility.geometry.pallet_length',        'Pallet length',                   'scalar', 48,   'inches',    'Reference template', 'Space C38',  60),
  ('facility_geometry', 'facility.geometry.floor_stor_ctc',       'Floor storage center-to-center',  'scalar', 54,   'inches',    'Reference template', 'Space C39',  70),
  ('facility_geometry', 'facility.geometry.ss_rack_bay_ctc',      'Single Select Rack bay C-to-C',   'scalar', 99,   'inches',    'Reference template', 'Space C40',  80);

-- 3.11 STORAGE UTIL
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order) VALUES
  ('storage_utilization', 'storage.utilization.floor',               'Floor storage utilization',       'percent', 0.85, 'fraction', 'Reference template', 'Space E12', 10),
  ('storage_utilization', 'storage.utilization.single_select_rack',  'Single Select Rack utilization',  'percent', 0.90, 'fraction', 'Reference template', 'Space E13', 20),
  ('storage_utilization', 'storage.utilization.double_deep_rack',    'Double Deep Rack utilization',    'percent', 0.90, 'fraction', 'Reference template', 'Space E14', 30),
  ('storage_utilization', 'storage.utilization.drive_in_rack',       'Drive-in Rack utilization',       'percent', 0.85, 'fraction', 'Reference template', 'Space E15', 40),
  ('storage_utilization', 'storage.utilization.pallet_flow',         'Pallet Flow utilization',         'percent', 0.85, 'fraction', 'Reference template', 'Space E16', 50),
  ('storage_utilization', 'storage.rack_position_sizing_buffer',     'Rack position sizing buffer',     'percent', 0.15, 'fraction', 'Reference template auto-generator', 'calc.js line 1081', 60);

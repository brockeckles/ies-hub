-- Item 31 closure (2026-06-11): the six density ratios the gap-analysis
-- verification found still hardcoded in calc.js now live in the
-- planning-ratios catalog. calc keeps the same constants as legacy
-- fallbacks; this seed makes them override-able per project/vertical.

INSERT INTO public.ref_heuristic_categories (code, display_name, description, sort_order) VALUES
  ('equipment_density', 'Equipment density ratios', 'Auto-generated equipment counts keyed to sqft (IT infrastructure, electronic security)', 180)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('volume_indirect',   'indirect.customer_service.per_500k_orders',        'Customer Service Rep',  'scalar', 500000, 'orders/yr per CSR',          'IES Hub legacy constant', 'calc.js auto-gen (pre-catalog)', 50, '1 CS rep per 500K outbound orders/yr, channel-aware aggregate. Was hardcoded in calc.js until 2026-06-11.'),
  ('volume_indirect',   'indirect.returns_processor.per_100k_return_orders','Returns Processor',     'scalar', 100000, 'return orders/yr per proc.', 'IES Hub legacy constant', 'calc.js auto-gen (pre-catalog)', 60, '1 processor per 100K return ORDERS/yr (G9 2026-04-30: orders not units). Per-channel returns%.'),
  ('volume_indirect',   'indirect.maintenance.per_100k_sqft',               'Maintenance Technician','scalar', 100000, 'sqft per tech',              'IES Hub legacy constant', 'calc.js auto-gen (pre-catalog)', 70, '1 maintenance tech per 100K sqft.'),
  ('equipment_density', 'equipment.it.wifi_ap',                             'WiFi Access Point',     'scalar', 10000,  'sqft per AP',                'IES Hub legacy constant', 'calc.js auto-gen (pre-catalog)', 10, '1 warehouse WiFi AP per 10K sqft (min 2). ~$540/unit capital.'),
  ('equipment_density', 'equipment.it.network_switch',                      '24-port PoE Switch',    'scalar', 50000,  'sqft per switch',            'IES Hub legacy constant', 'calc.js auto-gen (pre-catalog)', 20, '1 24-port PoE switch per 50K sqft (min 2). ~$3,024/unit capital, 7-yr.'),
  ('equipment_density', 'equipment.security.cameras',                       'Security Camera',       'scalar', 30000,  'sqft per camera',            'IES Hub legacy constant', 'calc.js auto-gen (pre-catalog)', 30, '1 CCTV camera per 30K sqft (min 4), Security Tier >= 2. TI financing, $1,562/unit.')
ON CONFLICT DO NOTHING;

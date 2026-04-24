
-- 3.1 MANAGEMENT SPANS OF CONTROL
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('labor_spans', 'indirect.team_lead.span',                 'Team Lead',                     'scalar',  15, 'direct FTE per lead',       'Reference template', 'Compensation sheet', 10,  '1 Team Lead per 15 direct labor FTE. Tightest span - front-line coordination.'),
  ('labor_spans', 'indirect.line_lead.span',                 'Line Lead',                     'scalar',  25, 'direct FTE per lead',       'Reference template', 'Compensation sheet', 20,  '1 Line Lead per 25 direct labor FTE.'),
  ('labor_spans', 'indirect.inventory_team_lead.span',       'Inventory Team Lead',           'scalar',  25, 'inventory FTE per lead',    'Reference template', 'Compensation sheet', 30,  '1 Inventory Team Lead per 25 inventory-function FTE.'),
  ('labor_spans', 'indirect.shipping_receiving_lead.span',   'Shipping/Receiving Team Lead',  'scalar',  25, 'dock FTE per lead',         'Reference template', 'Compensation sheet', 40,  '1 Shipping/Receiving Team Lead per 25 inbound+outbound FTE.'),
  ('labor_spans', 'indirect.qa_coordinator.span',            'Quality Assurance Coordinator', 'scalar',  25, 'direct FTE per coordinator','Reference template', 'Compensation sheet', 50,  '1 QA Coordinator per 25 direct FTE.'),
  ('labor_spans', 'salary.operations_supervisor.span',       'Operations Supervisor',         'scalar',  25, 'direct FTE per supervisor', 'Reference template', 'Compensation sheet', 60,  '1 Operations Supervisor per 25 direct FTE. Salary-level first-line supervision.'),
  ('labor_spans', 'salary.inventory_control_supervisor.span','Inventory Control Supervisor',  'scalar',  50, 'inventory FTE per sup.',    'Reference template', 'Compensation sheet', 70,  '1 IC Supervisor per 50 inventory FTE.'),
  ('labor_spans', 'salary.inventory_manager.span',           'Inventory Manager',             'scalar',  50, 'inventory FTE per mgr',     'Reference template', 'Compensation sheet', 80,  '1 Inventory Manager per 50 inventory FTE.'),
  ('labor_spans', 'salary.qa_supervisor.span',               'QA Supervisor',                 'scalar',  50, 'direct FTE per supervisor', 'Reference template', 'Compensation sheet', 90,  '1 QA Supervisor per 50 direct FTE.'),
  ('labor_spans', 'indirect.csr.span',                       'Customer Service Rep',          'scalar',  50, 'direct FTE per CSR',        'Reference template', 'Compensation sheet', 100, '1 CSR per 50 direct FTE. Volume-scaled, may double under high complexity.'),
  ('labor_spans', 'indirect.senior_csr.span',                'Senior Customer Service Rep',   'scalar',  50, 'direct FTE per senior CSR', 'Reference template', 'Compensation sheet', 110, '1 Senior CSR per 50 direct FTE.'),
  ('labor_spans', 'indirect.security_guard.span',            'Security Guard (contract)',     'scalar',  50, 'direct FTE per guard',      'Reference template', 'Compensation sheet', 120, '1 Security Guard per 50 direct FTE; also scales with facility perimeter and security tier.'),
  ('labor_spans', 'indirect.safety_coordinator.span',        'Safety Coordinator',            'scalar',  50, 'direct FTE per coordinator','Reference template', 'Compensation sheet', 130, '1 Safety Coordinator per 50 direct FTE.'),
  ('labor_spans', 'salary.operations_manager.span',          'Operations Manager',            'scalar',  75, 'direct FTE per manager',    'Reference template', 'Compensation sheet', 140, '1 Operations Manager per 75 direct FTE. Mid-level ops management.'),
  ('labor_spans', 'salary.admin_operations_manager.span',    'Admin Operations Manager',      'scalar', 200, 'direct FTE per manager',    'Reference template', 'Compensation sheet', 150, '1 Admin Ops Manager per 200 FTE. Cross-functional.'),
  ('labor_spans', 'salary.assistant_operations_manager.span','Assistant Operations Manager',  'scalar', 200, 'direct FTE per manager',    'Reference template', 'Compensation sheet', 160, '1 Asst Ops Manager per 200 FTE.'),
  ('labor_spans', 'salary.industrial_engineer.span',         'Industrial Engineer',           'scalar', 200, 'direct FTE per IE',         'Reference template', 'Compensation sheet', 170, '1 IE per 200 FTE. Process + engineering support.'),
  ('labor_spans', 'salary.senior_inventory_analyst.span',    'Senior Inventory Analyst',      'scalar', 200, 'direct FTE per analyst',    'Reference template', 'Compensation sheet', 180, '1 Senior Inventory Analyst per 200 FTE.'),
  ('labor_spans', 'salary.hr_admin.span',                    'HR - Admin',                    'scalar', 200, 'direct FTE per admin',      'Reference template', 'Compensation sheet', 190, '1 HR Admin per 200 FTE.'),
  ('labor_spans', 'salary.maintenance_engineer.span',        'Maintenance Engineer',          'scalar', 200, 'direct FTE per engineer',   'Reference template', 'Compensation sheet', 200, '1 Maintenance Engineer per 200 FTE.'),
  ('labor_spans', 'salary.maintenance_manager.span',         'Maintenance Manager',           'scalar', 200, 'direct FTE per manager',    'Reference template', 'Compensation sheet', 210, '1 Maintenance Manager per 200 FTE; higher for automated facilities.'),
  ('labor_spans', 'salary.qa_manager.span',                  'QA Manager',                    'scalar', 200, 'direct FTE per manager',    'Reference template', 'Compensation sheet', 220, '1 QA Manager per 200 FTE.'),
  ('labor_spans', 'salary.safety_manager.span',              'Safety Manager',                'scalar', 200, 'direct FTE per manager',    'Reference template', 'Compensation sheet', 230, '1 Safety Manager per 200 FTE.'),
  ('labor_spans', 'salary.senior_operations_manager.span',   'Senior Operations Manager',     'scalar', 200, 'direct FTE per manager',    'Reference template', 'Compensation sheet', 240, '1 Senior Ops Manager per 200 FTE.'),
  ('labor_spans', 'salary.software_super_user.span',         'Software Super User (WMS/WCS)', 'scalar', 200, 'operators per super user',  'Reference template', 'Compensation sheet', 250, '1 Super User per 200 operators. Also: LMS specifically 1 per 150 operators.'),
  ('labor_spans', 'indirect.wms_lms_support.span',           'WMS/LMS Field Support',         'scalar', 150, 'operators per support',     'Reference template', 'Indirect Matrix',    260, '1 LMS field support per 150 operators.'),
  ('labor_spans', 'salary.operations_director.span',         'Operations Director',           'scalar', 400, 'direct FTE per director',   'Reference template', 'Compensation sheet', 270, '1 Operations Director per 400 FTE. Multi-site or very large single-site.');

-- 3.2 VOLUME-DRIVEN INDIRECT
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('volume_indirect', 'indirect.retail_compliance_specialist.customers', 'Retail Compliance Specialist (Dock)',   'scalar', 9, 'retail customers per spec', 'Reference template', 'Indirect Matrix G30', 10, '1 Specialist per 8-10 retail customers (midpoint 9) for dock compliance / routing guide.'),
  ('volume_indirect', 'indirect.wave_tasker.operations',                 'Wave Tasker',                           'scalar', 1, '2-shift 8k-order op',       'Reference template', 'Indirect Matrix G30', 20, 'Scaled as 1 Wave Tasker per 2-shift, 8,000-orders-per-day operation.'),
  ('volume_indirect', 'indirect.yard_spotter.threshold',                 'Yard Spotter required?',                'scalar', 25, 'min daily trailers',        'Reference template', 'Indirect Matrix',    30, 'Heuristic: required for ops with 25+ daily trailer/shuttle moves.'),
  ('volume_indirect', 'indirect.transportation_routing.threshold',       'Transportation Routing (Prepaid/Collect)', 'scalar', 100, 'distinct carriers', 'Reference template', 'Indirect Matrix', 40, 'Needed when carrier selection is in-scope AND has >~100 distinct unitary variations.');

-- 3.3 LABOR MIX
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('labor_mix', 'labor.pct_permanent.default',        'Percent permanent (default)',      'percent', 0.74, 'fraction',      'Reference template', 'Labor key assumptions F12', 10,  'Default permanent share of total direct hours. Override per-market.'),
  ('labor_mix', 'labor.pct_permanent.min_observed',   'Percent permanent - low bound',    'percent', 0.47, 'fraction',      'Historical %Perm Hours',    'FY12-14 observed low (Crystal Lake)', 20, 'Lowest observed across 18 historical campuses.'),
  ('labor_mix', 'labor.pct_permanent.max_observed',   'Percent permanent - high bound',   'percent', 0.90, 'fraction',      'Historical %Perm Hours',    'FY12-14 observed high (Memphis)',     30, 'Highest observed.'),
  ('labor_mix', 'labor.pct_permanent.avg_observed',   'Percent permanent - historical avg','percent',0.68, 'fraction',      'Historical %Perm Hours',    'FY12-14 cross-campus average',        40, 'Across 18 campuses.'),
  ('labor_mix', 'labor.flexing_capacity',             'Flexing capacity',                  'percent', 0.10, 'fraction',      'Reference template', 'Labor key assumptions F11', 50,  'Extra capacity permanent HC can absorb via OT before triggering temps.'),
  ('labor_mix', 'labor.contractual_wage_load_temp',   'Contractual wage load (temp)',      'percent', 0.38, 'fraction',      'Reference template', 'Labor key assumptions H11', 60,  'Agency markup + fees on temp wages. Multiplier on temp base rate.'),
  ('labor_mix', 'labor.weekly_turnover',              'Weekly turnover',                   'percent', 0.01, 'fraction',      'Reference template', 'Labor key assumptions H12', 70,  'Roughly 43-52% annualized (1-(1-0.01)^52).'),
  ('labor_mix', 'labor.month_to_month_fte_increase', 'Month-to-month FTE increase cap',    'percent', 0.50, 'fraction',      'Reference template', 'Labor key assumptions K9',  80,  'Max fractional FTE increase allowed between consecutive months before flagging for review.'),
  ('labor_mix', 'labor.max_ramp_additions_per_week', 'Max ramp additions per week',        'scalar', 40,    'HC per week',   'Reference template', 'Labor key assumptions K10', 90,  'Max new hires per week during ramp - recruiting throughput constraint.');

-- 3.4 WORKING TIME FUNDAMENTALS
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order) VALUES
  ('labor_mix', 'labor.working_days_per_year', 'Working days per year',     'scalar', 255,    'days',      'Reference template', 'Labor D8',  100),
  ('labor_mix', 'labor.hours_per_day',         'Hours per day (direct)',    'scalar', 8.67,   'hours',     'Reference template', 'Labor D9',  110),
  ('labor_mix', 'labor.annual_hours_per_fte',  'Annual hours per FTE',      'scalar', 2080,   'hours/yr',  'Reference template', 'Labor F8',  120),
  ('labor_mix', 'labor.hours_per_month',       'Hours per month per FTE',   'scalar', 173.33, 'hours/mo',  'Reference template', 'Labor F9',  130),
  ('labor_mix', 'labor.days_per_week',         'Days per week',             'scalar', 5,      'days',      'Reference template', 'Labor D10', 140),
  ('labor_mix', 'labor.hours_per_week',        'Hours per week',            'scalar', 43.33,  'hours/wk',  'Reference template', 'Labor D11', 150),
  ('labor_mix', 'labor.non_overlapping_shifts','Non-overlapping shifts',    'scalar', 1,      'shifts',    'Reference template', 'Labor D12', 160),
  ('labor_mix', 'labor.direct_utilization',    'Direct utilization',        'percent',0.85,   'fraction',  'Reference template', 'Labor D36', 170),
  ('labor_mix', 'labor.pto_allowance',         'PTO allowance',             'percent',0.05,   'fraction',  'Reference template', 'Labor H10', 180);

-- 3.5 ESCALATION
INSERT INTO public.ref_planning_ratios (category_code, ratio_code, display_name, value_type, numeric_value, value_unit, source, source_detail, sort_order, notes) VALUES
  ('labor_escalation', 'escalation.wage_yoy',           'YOY wage/salary growth',       'percent', 0.03, 'fraction',  'Reference template', 'Labor F17',  10,  'Model default - 3%. Actual 2020-2025 warehouse wage inflation has been 5-7% annually.'),
  ('labor_escalation', 'escalation.uph_yoy',            'YOY UPH (productivity) growth','percent', 0.03, 'fraction',  'Reference template', 'Labor F20',  20,  'Productivity offset to wage growth. Rarely achieved 1:1 in practice.'),
  ('labor_escalation', 'escalation.equipment_yoy',      'YOY equipment cost growth',    'percent', 0.03, 'fraction',  'Reference template', 'Equip D39',  30,  'Default equipment price escalation.'),
  ('labor_escalation', 'labor.overtime_pct_default',    'Monthly overtime % (flat)',    'percent', 0.05, 'fraction',  'Reference template', 'Labor D27',  40,  'Applied uniformly across 12 months. Reality - peaks in Q4.'),
  ('labor_escalation', 'labor.overtime_premium',        'Overtime premium multiplier',  'scalar',  1.50, 'x',         'Reference template', 'Labor H9',   50,  'OT hours x 1.5 x base rate.'),
  ('labor_escalation', 'labor.wage_load_y1',            'Annual wage load Y1',          'percent', 0.30, 'fraction',  'Reference template', 'Labor E22',  60,  'Benefits + burden as % of base. Y5+ grows to 31.33%.'),
  ('labor_escalation', 'labor.wage_load_y5_plus',       'Annual wage load Y5+',         'percent', 0.3133, 'fraction','Reference template', 'Labor I22',  70,  'Wage load compounds slightly with cost-of-benefits inflation.');

-- Asset Defaults Guidance.docx bulk seed (2026-04-21 PM)
-- Brings ref_equipment from 33 → ~115 items covering MHE / Racking / IT /
-- Facility / Security / Systems / Conveyor. Costs pulled from the doc's
-- explicit references where stated; common secondary items at reasonable
-- industry estimates. source_citation = 'Asset Defaults Guidance 2026-04' for
-- traceability. All new rows default to 2026-04-21 effective_date so the SCD
-- history is clean.

INSERT INTO public.ref_equipment
  (name, category, subcategory, purchase_cost, monthly_lease_cost, monthly_maintenance, useful_life_years, power_type, capacity_description, notes, source_citation, effective_date)
VALUES
-- ============================================================
-- MHE additions (forklifts / stackers / pallet jacks / yard)
-- ============================================================
('Sit-Down Forklift (LPG)',                    'MHE', 'Forklift',        32000,  750,  150, 7,  'LPG',       '5,000 lb capacity', 'LPG counterbalance; outdoor/yard use', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Sit-Down Forklift (Electric)',               'MHE', 'Forklift',        36000,  820,  130, 7,  'Electric',  '5,000 lb capacity', 'Indoor electric counterbalance; preferred for food/pharma', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Stand-Up Reach Truck (300")',                'MHE', 'Forklift',        46000, 1050,  150, 7,  'Electric',  '3,500 lb, 300" mast', 'Rack-aisle reach truck; sized by rack positions/500', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Order Picker (270")',                        'MHE', 'Forklift',        42000,  970,  140, 7,  'Electric',  '500 lb operator platform', 'Each-pick level; sized by pick FTE/2-3', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Walkie Stacker (Short Mast)',                'MHE', 'Stacker',         7500,   195,   75, 6,  'Electric',  '2,500 lb, 130" mast', 'Single-pallet stacker; walk-behind', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Walkie Stacker (Full Mast)',                 'MHE', 'Stacker',         11000,  285,   90, 6,  'Electric',  '2,500 lb, 200" mast', 'Full-height stacker; walk-behind', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Rider Pallet Truck (Double)',                'MHE', 'Pallet Jack',     14000,  330,  100, 6,  'Electric',  '8,000 lb, 96" forks', 'Double-pallet transport; load/unload + staging', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Yard Jockey / Spotter Truck',                'MHE', 'Yard Equipment', 120000, 2750,  650, 10, 'Diesel',    'Capital LT-9513 or similar', 'Off-road trailer mover; sized 1 per dock cluster', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Yard Tractor (Hostler)',                     'MHE', 'Yard Equipment', 135000, 3100,  750, 10, 'Diesel',    '70K-lb Capacity', 'Highway-capable trailer mover', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Tow Tractor (Tugger)',                       'MHE', 'Material Movement', 9500, 225,  80, 8,  'Electric',  '5,000 lb tow rating', 'Indoor tow tractor for cart trains', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Tugger Cart (per unit)',                     'MHE', 'Material Movement', 1800,  0,    20, 10, NULL,        '2,000 lb capacity',  'Attach to tugger; typically 4-6 per train', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Floor Scrubber (Ride-On)',                   'MHE', 'Cleaning',       28000,  680,  150, 8,  'Electric',  '32" path',          'Indoor automatic scrubber', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Floor Sweeper (Walk-Behind)',                'MHE', 'Cleaning',        5500,  145,   45, 8,  'Electric',  '28" path',          'Indoor walk-behind sweeper', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
-- Battery infrastructure
('Battery — Lithium-Ion (per unit)',           'MHE', 'Charging',       12500,  0,     50, 10, 'Electric',  'Lithium, 48V / 630 Ah', 'Replaces lead-acid; 1:1 with MHE', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Battery — Lead Acid (per unit)',             'MHE', 'Charging',        4800,  0,    120, 5,  'Electric',  '48V / 630 Ah',       'Legacy option; 2-3 per MHE for 24/7', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Single-Unit Battery Charger',                'MHE', 'Charging',        2400,  0,     25, 10, 'Electric',  '48V fast charger',  '1 per MHE for opportunity charging', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Battery Changing Station',                   'MHE', 'Charging',       55000,  0,    400, 12, 'Electric',  '6-bay',             'For multi-shift operations with lead-acid fleet', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Battery Watering System',                    'MHE', 'Charging',        3200,  0,     40, 10, 'Electric',  'Auto-fill manifold', 'For lead-acid maintenance efficiency', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
-- Forklift attachments (opt-in)
('Forklift Attachment — Carton Clamp',         'MHE', 'Attachment',      7500,  0,    100, 7,  NULL,        'Hydraulic clamp',   'Appliance/boxed-goods handling', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Forklift Attachment — Fork Positioner',      'MHE', 'Attachment',      4200,  0,     60, 7,  NULL,        'Side-shift + positioner', 'Variable-pallet-size handling', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Forklift Attachment — Rotator',              'MHE', 'Attachment',      6800,  0,     90, 7,  NULL,        'Side-shift + 360°',  'Roll/bin handling', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Forklift Attachment — Slip-Sheet Push-Pull', 'MHE', 'Attachment',      9500,  0,    120, 7,  NULL,        'Slip-sheet handling', 'No-pallet handling for specific customers', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Forklift Telematics (per unit/month)',       'MHE', 'Telematics',         0, 35,      0, 1,  NULL,        'Fleet management',  'Impact / utilization / driver reporting', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),

-- ============================================================
-- Racking additions (lease variants + accessories + specialty)
-- ============================================================
('Selective Pallet Rack — Lease (per position)',   'Racking', 'Pallet Storage',    0, 1.00, 0.15, 7,  NULL, 'Single-select', '5-7 yr rack lease per reference model', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Double-Deep Rack (per position)',                 'Racking', 'Pallet Storage',  285, 0,     0, 25, NULL, 'Double-deep selective', 'Same-SKU-pair operations', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Double-Deep Rack — Lease (per position)',         'Racking', 'Pallet Storage',    0, 1.50, 0.20, 7,  NULL, 'Double-deep selective lease', 'Vendor-financed', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Drive-In Rack — Lease (per position)',            'Racking', 'Pallet Storage',    0, 1.35, 0.20, 7,  NULL, 'Drive-in / drive-through', 'Bulk same-SKU only', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Drive-Through Rack (per position)',               'Racking', 'Pallet Storage',  285, 0,     0, 25, NULL, 'FIFO drive-through',   'Bulk same-SKU, two-sided access', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Pallet Flow Rack — Lease (per position)',         'Racking', 'Pallet Storage',    0, 3.00, 0.35, 7,  NULL, 'Gravity-flow',         'Per-beam lease pricing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Push-Back Rack — Lease (per position)',           'Racking', 'Pallet Storage',    0, 2.25, 0.30, 7,  NULL, 'Cart-pushed LIFO',     'High-density FIFO/LIFO', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Carton Flow Rack — Lease (per bay)',              'Racking', 'Case/Each Storage', 0, 8.50, 1.00, 7,  NULL, 'Roller/wheel',         'Each-pick FIFO', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Bin Shelving — Small Parts',                      'Racking', 'Case/Each Storage', 195, 0,    0, 15, NULL, 'Wire/plastic bins',    'Small-parts operations', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
-- Accessories
('Wire Decking (per shelf)',                        'Racking', 'Accessory',        35, 0,     0, 20, NULL, 'Wire deck',            'Typically part of rack lease; per-unit if retrofit', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Rack Protector (End-of-Aisle)',                   'Racking', 'Accessory',       185, 0,     0, 15, NULL, 'Heavy-gauge steel',    'One per row-end + column', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Rack Protector (Column Guard)',                   'Racking', 'Accessory',        45, 0,     0, 15, NULL, 'Bolt-on',              'One per vulnerable column', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Rack Safety Netting (per LF)',                    'Racking', 'Accessory',        28, 0,     0, 15, NULL, 'Back-of-rack netting', 'Prevents carton fall to adjacent aisle', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Aisle Label (per location)',                      'Racking', 'Accessory',         2, 0,     0, 5,  NULL, 'Barcode label',        'Location identifier', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Beam Label (per beam)',                           'Racking', 'Accessory',         1, 0,     0, 5,  NULL, 'Barcode label',        'Per-beam pick-location', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),

-- ============================================================
-- IT Infrastructure (all capital per reference model §3.2)
-- ============================================================
('Switch — 24-Port PoE',                            'Systems', 'Infrastructure',  3024, 0, 15, 7, 'Electric', '1 Gbps',  '1 per 50K sqft', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Switch — 48-Port PoE',                            'Systems', 'Infrastructure',  4900, 0, 20, 7, 'Electric', '1 Gbps',  'MDF + distribution', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Switch — Core 10G Backbone',                      'Systems', 'Infrastructure',  9800, 0, 30, 7, 'Electric', '10 Gbps', 'MDF core', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Router — Enterprise WAN',                         'Systems', 'Infrastructure',  4000, 0, 30, 7, 'Electric', 'SD-WAN',  'One per site; with WAN failover', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Firewall Appliance',                              'Systems', 'Infrastructure',  5200, 0, 40, 5, 'Electric', 'NGFW',    'Perimeter firewall', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('WiFi Access Point (Warehouse)',                   'Systems', 'Infrastructure',   540, 0,  8, 7, 'Electric', 'WiFi 6',  '1 per 10K sqft', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('WiFi Access Point (Office)',                      'Systems', 'Infrastructure',   432, 0,  8, 7, 'Electric', 'WiFi 6, integrated antenna', 'Office-area', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Wireless LAN Controller',                         'Systems', 'Infrastructure',  4000, 0, 20, 7, 'Electric', 'Centralized AP mgmt', 'One per site', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('UPS — 1500VA (Rack-mount)',                       'Systems', 'Infrastructure',   900, 0, 25, 5, 'Electric', '1500VA',  'Per MDF/IDF', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('UPS — 3000VA (Rack-mount)',                       'Systems', 'Infrastructure',  1750, 0, 35, 5, 'Electric', '3000VA',  'MDF core', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Rack Cabinet (42U)',                              'Systems', 'Infrastructure',  1600, 0,  0, 15,'Electric', '42U',     'MDF / IDF housing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('PDU — Switched (per rack)',                       'Systems', 'Infrastructure',   650, 0,  0, 10,'Electric', '20A',     'Per rack cabinet', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Patch Panel (24-port)',                           'Systems', 'Infrastructure',   180, 0,  0, 15,NULL,       'CAT6a',   'Per MDF/IDF', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Network Cable Drop (CAT6a)',                      'Systems', 'Infrastructure',   243, 0,  0, 15,NULL,       'Per drop','Cable + termination + testing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Fiber Patch Cable (per unit)',                    'Systems', 'Infrastructure',    55, 0,  0, 10,NULL,       'LC-LC 10m','MDF cross-connects', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Server — File/Application (rack)',                'Systems', 'Infrastructure',  8500, 0, 80, 5, 'Electric', '1U Xeon', 'Local file/print server', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Network Monitoring License (Cisco Prime)',        'Systems', 'Software',        3500, 0,  0, 1, NULL,       'Annual',  'Can bundle as IT-as-a-service instead', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('VoIP Phone (per desk)',                           'Systems', 'Hardware',         185, 0,  0, 7, 'Electric', 'PoE',     'Per admin desk', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('IP Intercom (per dock/entrance)',                 'Systems', 'Hardware',         450, 0,  0, 10,'Electric', 'PoE',     'Dock-door communication', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),

-- ============================================================
-- Facility TI (dock + office + buildout — driven from facility card, not equipment auto-gen)
-- ============================================================
('Dock Leveler (Hydraulic) — TI',                   'Facility', 'Dock Equipment', 16000, 0,   200, 15, 'Electric', '30K-lb capacity',     'Built into facility — TI financing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Dock Leveler (Mechanical) — TI',                  'Facility', 'Dock Equipment',  6500, 0,   150, 15, NULL,       '25K-lb capacity',     'Mechanical dock plate', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Dock Seal (per door)',                            'Facility', 'Dock Equipment',  1100, 0,    20, 10, NULL,       'Foam compression',    'Weather-seal around trailer', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Dock Shelter (per door)',                         'Facility', 'Dock Equipment',  2400, 0,    40, 10, NULL,       'Fabric shelter',      'Foul-weather protection', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Dock Restraint — Automatic',                      'Facility', 'Dock Equipment',  3800, 0,    75, 15, 'Electric', 'Rotating hook',       'Prevents trailer creep', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Dock Light — Swing Arm',                          'Facility', 'Dock Equipment',   220, 0,    10, 10, 'Electric', 'LED, arm-mounted',    'Standard per dock', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Dock Communication Light (Red/Green)',            'Facility', 'Dock Equipment',   380, 0,    10, 10, 'Electric', 'LED, 2-stage',        'Driver communication', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Cross-Dock Door (9x10 Insulated)',                'Facility', 'Doors',           4500, 0,    40, 20, NULL,       '9''x10'' insulated',  'Standard overhead dock door', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Drive-In Door (14x16 Insulated)',                 'Facility', 'Doors',           9200, 0,    60, 20, NULL,       '14''x16'' insulated', 'For MHE drive-in / yard access', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Fast Roll-Up Door (per door)',                    'Facility', 'Doors',           8500, 0,   100, 15, 'Electric', 'High-speed fabric',   'Traffic-separation doors', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('HVAC — RTU (5-ton)',                              'Facility', 'Climate',         9500, 0,   250, 15, 'Electric', '5-ton cooling',       'Per 10K sqft office', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('HVAC — Warehouse Heating (per zone)',             'Facility', 'Climate',         7800, 0,   180, 15, 'Gas',      'Suspended gas unit',  'Warehouse heating only', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('LED High-Bay Light (per fixture)',                'Facility', 'Lighting',         185, 0,     5, 12, 'Electric', '150W LED',            '1 per 600 sqft warehouse', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('LED Low-Bay / Office Light',                      'Facility', 'Lighting',          85, 0,     3, 12, 'Electric', '40W LED',             '1 per 50 sqft office', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Emergency / Exit Lighting (per fixture)',         'Facility', 'Lighting',          95, 0,    10, 10, 'Electric', 'Battery backup',       'Code-required per egress', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Fire Suppression — ESFR Sprinkler (per sqft)',    'Facility', 'Life Safety',     3.50, 0,  0.10, 30, NULL,       'Early Suppression',   'In-rack + ceiling sprinklers', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Fire Alarm Panel + Pulls',                        'Facility', 'Life Safety',     8500, 0,   120, 20, 'Electric', 'Addressable',         'Fire alarm monitoring', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Floor Epoxy Seal (per sqft)',                     'Facility', 'Floor',           2.75, 0,     0, 15, NULL,       'Epoxy coating',       'Warehouse floor finish', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Floor Striping / Markings (per LF)',              'Facility', 'Floor',           1.50, 0,  0.05, 5,  NULL,       'Painted lanes',       'Pedestrian + MHE lanes', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Office Build-Out — Standard (per sqft)',          'Facility', 'Office Build-Out',  45, 0,     0, 20, NULL,       'Standard finish',     'Tenant Improvement (per reference §3.5)', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Office Build-Out — Premium (per sqft)',           'Facility', 'Office Build-Out',  78, 0,     0, 20, NULL,       'Premium finish',      'Executive / customer-facing space', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Main Office + Restrooms (per sqft)',              'Facility', 'Office Build-Out',  52, 0,     0, 20, NULL,       'Includes plumbing',   'Driven by facility.office.pct_of_total_sf', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('MDF/IDF Room Build-Out',                          'Facility', 'Office Build-Out', 8500, 0,     0, 20, NULL,       '500 sqft typical',    'IT closet with cooling + security', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Break Room Furniture Package (seating 20)',       'Facility', 'Office Build-Out', 4500, 0,     0, 10, NULL,       'Tables + chairs',     'Standard break room', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),

-- ============================================================
-- Security (TI for electronic, Capital for physical per §3.6)
-- ============================================================
('Burglar Alarm System (TI)',                       'Facility', 'Security',        4500, 0,    35, 10, 'Electric', 'Keypad + motion + glass-break', 'Tier 1+; TI financing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Camera System Head-End / NVR',                    'Facility', 'Security',       20000, 0,   150, 10, 'Electric', 'NVR + 16-channel license',    'Tier 2+; TI financing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Security Camera (IP Dome, each)',                 'Facility', 'Security',        1562, 0,    20, 10, 'Electric', '4MP IP, PoE',                 'Per camera; qty by dock + entrance count', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Access Control Head-End',                         'Facility', 'Security',       20000, 0,   150, 10, 'Electric', 'Controller + software',       'Tier 3+; TI financing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Badge Reader (per door)',                         'Facility', 'Security',        1150, 0,    15, 10, 'Electric', 'HID proximity / mobile',      'One per access-controlled door', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Turnstile (Employee Entrance)',                   'Facility', 'Security',        2500, 0,    30, 15, 'Electric', 'Optical tripod',               'Tier 3+; employee entrance', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Metal Detector (Walk-Through)',                   'Facility', 'Security',        5000, 0,    60, 8,  'Electric', '30-zone',                      'Tier 3+; employee exit screening', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Guard Shack (External)',                          'Facility', 'Security',       43000, 0,   250, 20, 'Electric', '8x10 pre-fabricated',          'Tier 4; staffed entrance', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Gate Automation (with Arm)',                      'Facility', 'Security',       25000, 0,   180, 15, 'Electric', 'Slide gate + operator',        'Tier 4; vehicle entrance', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Perimeter Fencing (per LF)',                      'Facility', 'Security',          80, 0,     2, 25, NULL,       '8ft chain-link',               'Always (physical perimeter)', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Barbed Wire Topper (per LF)',                     'Facility', 'Security',          12, 0,     0, 25, NULL,       '3-strand',                     'Optional; deters climb-over', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Security Bollard (per unit)',                     'Facility', 'Security',         550, 0,     0, 25, NULL,       'Concrete-filled steel',        'Entry / dock protection', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),

-- ============================================================
-- Systems / RF / Station equipment (all capital per §3.7)
-- ============================================================
('RF Wearable (Scanner + Battery + Charger)',       'Systems', 'Hardware',        3048, 0,   15, 4, 'Electric', 'Ring scanner kit',      'Direct FTE × 30% coverage', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('RF Handheld — Gun Scanner',                       'Systems', 'Hardware',        2848, 0,   15, 4, 'Electric', 'Zebra TC52 or similar', 'Receiving / shipping default', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Voice-Pick Headset',                              'Systems', 'Hardware',        4860, 0,   25, 4, 'Electric', 'Vocollect A730',        'Only with voice-pick WMS', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Hip Printer',                                     'Systems', 'Hardware',        1296, 0,   20, 4, 'Electric', 'Belt-mount thermal',    'Mobile label printing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Laser Printer (Office)',                          'Systems', 'Hardware',         800, 0,   20, 7, 'Electric', 'Monochrome duplex',     '1 per 10-15 admin users', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Laptop — Standard User',                          'Systems', 'Hardware',        1400, 0,    0, 4, 'Electric', '14" i5, 16GB',          'Per indirect/salary HC', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Laptop — Power User',                             'Systems', 'Hardware',        2000, 0,    0, 4, 'Electric', '15" i7, 32GB',          'Analyst / engineer seats', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Desktop PC + Monitor',                            'Systems', 'Hardware',        1400, 0,    0, 5, 'Electric', 'i5 + 24" monitor',      'Admin seat', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Mobile Cart Workstation',                         'Systems', 'Hardware',        2500, 0,   25, 7, 'Electric', 'Cart + laptop + printer', 'Receiving / cycle-count', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Cubiscan (Dimensional Scanner)',                  'Systems', 'Hardware',       11000, 0,   75, 7, 'Electric', 'Item/case cubing',      'SKU master data capture', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Pack Station (Complete)',                         'Systems', 'Station',         1785, 0,    0, 10,NULL,       'Bench + printer + PC mount', 'Per pack-line station', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Audit Station',                                   'Systems', 'Station',         1100, 0,    0, 10,NULL,       'Bench + PC',            'QC audit desk', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Receiving Station',                               'Systems', 'Station',          631, 0,    0, 10,NULL,       'Bench + scanner mount', 'Per receiving dock', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Time Clock / Kiosk',                              'Systems', 'Station',         2500, 0,   15, 7, 'Electric', 'Biometric + badge',     'Per employee entrance', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Shipping Scale (Floor, 2K-lb)',                   'Systems', 'Station',         1850, 0,   15, 10,'Electric', '2,000 lb capacity',     'Freight weighing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Shipping Scale (Bench, 150-lb)',                  'Systems', 'Station',          380, 0,    0, 10,'Electric', '150 lb capacity',       'Parcel weighing', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Case Sealer / Tape Machine',                      'Systems', 'Station',        10500, 0,  100, 10,'Electric', 'Semi-auto',             'Conditional on pack-line', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),

-- ============================================================
-- Conveyor additions (per §3.8)
-- ============================================================
('Accordion Conveyor (24" width)',                  'Conveyor', 'Transport',       6500, 140,  25, 8, 'Electric', 'Portable extensible',    'Truck load/unload', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Accordion Conveyor (14" width)',                  'Conveyor', 'Transport',       4800, 105,  20, 8, 'Electric', 'Portable extensible',    'Narrow-carton unload', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Merge / Diverter (per unit)',                     'Conveyor', 'Sortation',      12500,   0, 100, 12,'Electric', 'Single-point',           'Conveyor network branching', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Conveyor — Belt (per LF, Lease)',                 'Conveyor', 'Transport',          0,   6, 0.5, 7, 'Electric', 'Operating lease $6/LF/mo', 'Vendor-financed alternative', 'Asset Defaults Guidance 2026-04', CURRENT_DATE),
('Conveyor — Powered Roller (per LF, Lease)',       'Conveyor', 'Transport',          0,   7, 0.5, 7, 'Electric', 'Operating lease $7/LF/mo', 'Vendor-financed alternative', 'Asset Defaults Guidance 2026-04', CURRENT_DATE);


-- Seed 50+ MOST elements for the 12 templates
-- Fixes A1 (empty library)

-- Receive & Check-in Cases (5 elements; 20,000 TMU)
INSERT INTO ref_most_elements (template_id, sequence_order, sequence_type, element_name, most_sequence, tmu_value, is_variable)
SELECT id, 1, 'GET', 'Walk to dock position', 'A6 B0 G1 A0 B0 P0 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Receive & Check-in Cases'
UNION ALL
SELECT id, 2, 'VERIFY', 'Scan case barcode', 'A3 B3 G0 A1 B6 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Receive & Check-in Cases'
UNION ALL
SELECT id, 3, 'VERIFY', 'Check case contents', 'A1 B0 G3 A0 B1 P0 A0', 3500, true FROM ref_most_templates WHERE activity_name = 'Receive & Check-in Cases'
UNION ALL
SELECT id, 4, 'PUT', 'Place in staging', 'A0 B6 G0 A0 B0 P6 A0', 3000, false FROM ref_most_templates WHERE activity_name = 'Receive & Check-in Cases'
UNION ALL
SELECT id, 5, 'GET', 'Return to dock', 'A6 B0 G1 A0 B0 P0 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Receive & Check-in Cases'

-- Receive & Put-to-Dock (6 elements; 60,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to trailer', 'A10 B0 G1 A0 B0 P0 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Receive & Put-to-Dock'
UNION ALL
SELECT id, 2, 'GET', 'Position pallet jack', 'A3 B6 G1 A1 B6 P0 A0', 5600, false FROM ref_most_templates WHERE activity_name = 'Receive & Put-to-Dock'
UNION ALL
SELECT id, 3, 'MOVE', 'Jack + move pallet', 'A6 B6 G3 M4 X3 I1 A0', 32000, true FROM ref_most_templates WHERE activity_name = 'Receive & Put-to-Dock'
UNION ALL
SELECT id, 4, 'PUT', 'Lower pallet to dock', 'A0 B6 G0 A0 B6 P6 A0', 6400, false FROM ref_most_templates WHERE activity_name = 'Receive & Put-to-Dock'
UNION ALL
SELECT id, 5, 'VERIFY', 'Scan dock label', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Receive & Put-to-Dock'
UNION ALL
SELECT id, 6, 'GET', 'Return pallet jack', 'A10 B0 G1 A0 B0 P0 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Receive & Put-to-Dock'

-- Putaway (Manual) (6 elements; 15,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to staging', 'A6 B0 G1 A0 B0 P0 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Putaway (Manual - Short Distance)'
UNION ALL
SELECT id, 2, 'GET', 'Grab case from carton', 'A0 B6 G1 A1 B0 P6 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Putaway (Manual - Short Distance)'
UNION ALL
SELECT id, 3, 'MOVE', 'Walk to location', 'A6 B0 G1 A0 B0 P0 A0', 2800, true FROM ref_most_templates WHERE activity_name = 'Putaway (Manual - Short Distance)'
UNION ALL
SELECT id, 4, 'PUT', 'Place on shelf', 'A0 B3 G0 A0 B0 P3 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Putaway (Manual - Short Distance)'
UNION ALL
SELECT id, 5, 'VERIFY', 'Scan location label', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Putaway (Manual - Short Distance)'
UNION ALL
SELECT id, 6, 'GET', 'Return to staging', 'A6 B0 G1 A0 B0 P0 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Putaway (Manual - Short Distance)'

-- Putaway (MHE) (6 elements; 45,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Move to pallet staging', 'A10 B0 G1 A0 B0 P0 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Putaway (MHE - Overhead)'
UNION ALL
SELECT id, 2, 'GET', 'Position forklift', 'A3 B6 G1 A1 B6 P0 A0', 4200, false FROM ref_most_templates WHERE activity_name = 'Putaway (MHE - Overhead)'
UNION ALL
SELECT id, 3, 'MOVE', 'Drive + position overhead', 'A10 B6 G3 M6 X4 I2 A0', 20000, true FROM ref_most_templates WHERE activity_name = 'Putaway (MHE - Overhead)'
UNION ALL
SELECT id, 4, 'PUT', 'Lower pallet into slot', 'A0 B6 G0 A0 B6 P6 A0', 6400, false FROM ref_most_templates WHERE activity_name = 'Putaway (MHE - Overhead)'
UNION ALL
SELECT id, 5, 'VERIFY', 'Scan location + confirm', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Putaway (MHE - Overhead)'
UNION ALL
SELECT id, 6, 'GET', 'Return forklift', 'A10 B0 G1 A0 B0 P0 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Putaway (MHE - Overhead)'

-- Pick (Discrete) (8 elements; 30,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to first location', 'A10 B0 G1 A0 B0 P0 A0', 3500, true FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'
UNION ALL
SELECT id, 2, 'GET', 'Reach to shelf', 'A1 B6 G0 A0 B0 P0 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'
UNION ALL
SELECT id, 3, 'VERIFY', 'Scan location label', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'
UNION ALL
SELECT id, 4, 'GET', 'Grab item(s)', 'A0 B6 G1 A0 B3 P6 A0', 3500, true FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'
UNION ALL
SELECT id, 5, 'PUT', 'Place in tote', 'A0 B3 G0 A0 B0 P3 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'
UNION ALL
SELECT id, 6, 'VERIFY', 'Scan item barcode', 'A0 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'
UNION ALL
SELECT id, 7, 'GET', 'Walk to next location', 'A10 B0 G1 A0 B0 P0 A0', 3500, true FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'
UNION ALL
SELECT id, 8, 'MOVE', 'Travel to pack station', 'A10 B0 G1 A0 B0 P0 A0', 4200, false FROM ref_most_templates WHERE activity_name = 'Pick (Discrete - By Location)'

-- Pick (Wave) (7 elements; 22,500 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to first location', 'A10 B0 G1 A0 B0 P0 A0', 3500, false FROM ref_most_templates WHERE activity_name = 'Pick (Batch - Wave Assembly)'
UNION ALL
SELECT id, 2, 'GET', 'Reach to shelf', 'A1 B6 G0 A0 B0 P0 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Pick (Batch - Wave Assembly)'
UNION ALL
SELECT id, 3, 'VERIFY', 'Scan location label', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Pick (Batch - Wave Assembly)'
UNION ALL
SELECT id, 4, 'GET', 'Grab multi-order items', 'A0 B6 G1 A0 B3 P6 A0', 4200, true FROM ref_most_templates WHERE activity_name = 'Pick (Batch - Wave Assembly)'
UNION ALL
SELECT id, 5, 'PUT', 'Place in sort tote', 'A0 B3 G0 A0 B0 P3 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Pick (Batch - Wave Assembly)'
UNION ALL
SELECT id, 6, 'GET', 'Walk through picks', 'A6 B0 G1 A0 B0 P0 A0', 2800, true FROM ref_most_templates WHERE activity_name = 'Pick (Batch - Wave Assembly)'
UNION ALL
SELECT id, 7, 'MOVE', 'Transport to sort wall', 'A10 B0 G1 A0 B0 P0 A0', 4200, false FROM ref_most_templates WHERE activity_name = 'Pick (Batch - Wave Assembly)'

-- Pack & Label (6 elements; 90,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to pack station', 'A6 B0 G1 A0 B0 P0 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Pack & Label Order'
UNION ALL
SELECT id, 2, 'GET', 'Retrieve order from tote', 'A0 B6 G1 A0 B3 P6 A0', 3500, true FROM ref_most_templates WHERE activity_name = 'Pack & Label Order'
UNION ALL
SELECT id, 3, 'PUT', 'Place items in box', 'A1 B6 G0 A0 B3 P6 A0', 7000, true FROM ref_most_templates WHERE activity_name = 'Pack & Label Order'
UNION ALL
SELECT id, 4, 'VERIFY', 'Scan order barcode', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Pack & Label Order'
UNION ALL
SELECT id, 5, 'PUT', 'Apply label + close box', 'A0 B6 G0 A1 B6 P6 A0', 4200, false FROM ref_most_templates WHERE activity_name = 'Pack & Label Order'
UNION ALL
SELECT id, 6, 'PUT', 'Place in shipping sorter', 'A0 B3 G0 A0 B0 P3 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Pack & Label Order'

-- Pack & Strap (6 elements; 120,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Position pallet at wrap', 'A6 B6 G1 A1 B6 P0 A0', 5600, false FROM ref_most_templates WHERE activity_name = 'Pack & Strap Pallet'
UNION ALL
SELECT id, 2, 'PUT', 'Apply plastic wrap', 'A6 B6 G0 A0 B6 P0 A0', 28000, false FROM ref_most_templates WHERE activity_name = 'Pack & Strap Pallet'
UNION ALL
SELECT id, 3, 'VERIFY', 'Inspect wrap coverage', 'A1 B0 G3 A0 B0 P0 A0', 5600, false FROM ref_most_templates WHERE activity_name = 'Pack & Strap Pallet'
UNION ALL
SELECT id, 4, 'PUT', 'Apply corner straps', 'A1 B6 G0 A0 B6 P6 A1', 21000, false FROM ref_most_templates WHERE activity_name = 'Pack & Strap Pallet'
UNION ALL
SELECT id, 5, 'VERIFY', 'Apply shipping label', 'A0 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Pack & Strap Pallet'
UNION ALL
SELECT id, 6, 'PUT', 'Move to dock', 'A10 B0 G1 A0 B0 P0 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Pack & Strap Pallet'

-- Load Trailer (6 elements; 36,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Position pallet jack', 'A6 B6 G1 A1 B6 P0 A0', 5600, false FROM ref_most_templates WHERE activity_name = 'Load Trailer (Cross-dock)'
UNION ALL
SELECT id, 2, 'GET', 'Jack up pallet', 'A0 B6 G0 A0 B0 P6 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Load Trailer (Cross-dock)'
UNION ALL
SELECT id, 3, 'MOVE', 'Push pallet into trailer', 'A6 B6 G3 M3 X1 I0 A0', 10500, false FROM ref_most_templates WHERE activity_name = 'Load Trailer (Cross-dock)'
UNION ALL
SELECT id, 4, 'PUT', 'Lower pallet into position', 'A0 B6 G0 A0 B6 P6 A0', 3500, false FROM ref_most_templates WHERE activity_name = 'Load Trailer (Cross-dock)'
UNION ALL
SELECT id, 5, 'VERIFY', 'Scan load label', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Load Trailer (Cross-dock)'
UNION ALL
SELECT id, 6, 'GET', 'Return jack to dock', 'A6 B6 G1 A1 B6 P0 A0', 5600, false FROM ref_most_templates WHERE activity_name = 'Load Trailer (Cross-dock)'

-- Load Parcel (5 elements; 12,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to sorter', 'A3 B0 G1 A0 B0 P0 A0', 700, false FROM ref_most_templates WHERE activity_name = 'Load Parcel (Small Parcel)'
UNION ALL
SELECT id, 2, 'GET', 'Pick from conveyor', 'A0 B3 G1 A0 B3 P3 A0', 2800, false FROM ref_most_templates WHERE activity_name = 'Load Parcel (Small Parcel)'
UNION ALL
SELECT id, 3, 'VERIFY', 'Scan parcel barcode', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Load Parcel (Small Parcel)'
UNION ALL
SELECT id, 4, 'PUT', 'Place in correct chute', 'A0 B3 G0 A0 B0 P3 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Load Parcel (Small Parcel)'
UNION ALL
SELECT id, 5, 'GET', 'Return to sorter', 'A3 B0 G1 A0 B0 P0 A0', 700, false FROM ref_most_templates WHERE activity_name = 'Load Parcel (Small Parcel)'

-- Cycle Count (Case) (6 elements; 24,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to location', 'A6 B0 G1 A0 B0 P0 A0', 2100, true FROM ref_most_templates WHERE activity_name = 'Cycle Count (Case Level)'
UNION ALL
SELECT id, 2, 'GET', 'Reach to shelf', 'A1 B6 G0 A0 B0 P0 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Case Level)'
UNION ALL
SELECT id, 3, 'VERIFY', 'Scan location label', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Case Level)'
UNION ALL
SELECT id, 4, 'VERIFY', 'Physical count cases', 'A0 B0 G1 A0 B0 P0 A0', 7000, true FROM ref_most_templates WHERE activity_name = 'Cycle Count (Case Level)'
UNION ALL
SELECT id, 5, 'PUT', 'Enter count in scanner', 'A0 B3 G0 A1 B6 P3 A0', 3500, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Case Level)'
UNION ALL
SELECT id, 6, 'VERIFY', 'Confirm variance if any', 'A0 B3 G1 A0 B3 P3 A0', 2800, true FROM ref_most_templates WHERE activity_name = 'Cycle Count (Case Level)'

-- Cycle Count (Pallet) (7 elements; 36,000 TMU)
UNION ALL
SELECT id, 1, 'GET', 'Walk to pallet location', 'A10 B0 G1 A0 B0 P0 A0', 3500, true FROM ref_most_templates WHERE activity_name = 'Cycle Count (Pallet Level)'
UNION ALL
SELECT id, 2, 'GET', 'Access pallet shelf', 'A1 B6 G0 A0 B0 P0 A0', 2100, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Pallet Level)'
UNION ALL
SELECT id, 3, 'VERIFY', 'Scan location label', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Pallet Level)'
UNION ALL
SELECT id, 4, 'VERIFY', 'Inspect pallet contents', 'A0 B0 G3 A0 B0 P0 A0', 7000, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Pallet Level)'
UNION ALL
SELECT id, 5, 'VERIFY', 'Scan pallet barcode', 'A1 B3 G0 A0 B3 P3 A0', 1400, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Pallet Level)'
UNION ALL
SELECT id, 6, 'PUT', 'Enter status in system', 'A0 B3 G0 A1 B6 P3 A0', 3500, false FROM ref_most_templates WHERE activity_name = 'Cycle Count (Pallet Level)'
UNION ALL
SELECT id, 7, 'GET', 'Return to start', 'A10 B0 G1 A0 B0 P0 A0', 3500, true FROM ref_most_templates WHERE activity_name = 'Cycle Count (Pallet Level)';

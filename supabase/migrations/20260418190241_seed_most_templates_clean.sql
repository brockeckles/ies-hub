
-- Seed 12 Blue Yonder WMS-flavored MOST templates
-- Phase 5 integration; fixes A1 (empty library)

DELETE FROM ref_most_templates WHERE activity_name IN ('Receive & Check-in Cases', 'Receive & Put-to-Dock', 'Putaway (Manual - Short Distance)', 'Putaway (MHE - Overhead)', 'Pick (Discrete - By Location)', 'Pick (Batch - Wave Assembly)', 'Pack & Label Order', 'Pack & Strap Pallet', 'Load Trailer (Cross-dock)', 'Load Parcel (Small Parcel)', 'Cycle Count (Case Level)', 'Cycle Count (Pallet Level)');

INSERT INTO ref_most_templates (activity_name, process_area, labor_category, equipment_type, pick_method, uom, units_per_hour_base, total_tmu_base, wms_transaction, description, is_active)
VALUES
('Receive & Check-in Cases', 'Receiving', 'manual', NULL, NULL, 'case', 180, 20000, 'RECV01', 'Blue Yonder dock receipt + case check-in', true),
('Receive & Put-to-Dock', 'Receiving', 'hybrid', 'Pallet Jack', NULL, 'pallet', 60, 60000, 'RECV02', 'Pallet receipt + dock placement', true),
('Putaway (Manual - Short Distance)', 'Putaway', 'manual', NULL, NULL, 'case', 240, 15000, 'PUTW01', 'Short-distance case putaway to nearby location', true),
('Putaway (MHE - Overhead)', 'Putaway', 'mhe', 'Forklift', NULL, 'pallet', 80, 45000, 'PUTW02', 'Forklift putaway to high-reach overhead', true),
('Pick (Discrete - By Location)', 'Picking', 'manual', NULL, 'discrete', 'line', 120, 30000, 'PICK01', 'Single-order pick operation; discrete method', true),
('Pick (Batch - Wave Assembly)', 'Picking', 'manual', NULL, 'batch', 'line', 160, 22500, 'PICK02', 'Wave-batched picking + sort-to-order', true),
('Pack & Label Order', 'Packing', 'manual', NULL, NULL, 'order', 40, 90000, 'PACK01', 'Order packing + label application', true),
('Pack & Strap Pallet', 'Packing', 'hybrid', 'Strapping Gun', NULL, 'pallet', 30, 120000, 'PACK02', 'Pallet wrapping + strapping', true),
('Load Trailer (Cross-dock)', 'Shipping', 'hybrid', 'Pallet Jack', NULL, 'pallet', 100, 36000, 'SHIP01', 'Cross-dock pallet load onto outbound trailer', true),
('Load Parcel (Small Parcel)', 'Shipping', 'manual', NULL, NULL, 'parcel', 300, 12000, 'SHIP02', 'Small parcel induction into shipping sorter', true),
('Cycle Count (Case Level)', 'Inventory', 'manual', NULL, NULL, 'case', 150, 24000, 'CCNT01', 'Physical count + data validation at case level', true),
('Cycle Count (Pallet Level)', 'Inventory', 'manual', NULL, NULL, 'pallet', 100, 36000, 'CCNT02', 'Physical count + data validation at pallet level', true);

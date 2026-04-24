
-- Add labor_category column to classify MHE vs Manual vs Hybrid
ALTER TABLE ref_most_templates ADD COLUMN IF NOT EXISTS labor_category TEXT DEFAULT 'manual';
-- Options: 'manual', 'mhe', 'hybrid'

-- Update existing templates with proper labor categories
UPDATE ref_most_templates SET labor_category = 'mhe' WHERE equipment_type IN ('Forklift', 'Forklift w/ Clamp');
UPDATE ref_most_templates SET labor_category = 'hybrid' WHERE equipment_type IN ('Conveyor + Manual', 'RF Gun + Cart', 'Voice Headset + Cart', 'Pallet Jack');
UPDATE ref_most_templates SET labor_category = 'manual' WHERE equipment_type IN ('RF Gun', 'Pack Station');

-- Fix Batch Each Pick name (report flagged: should clarify micro-batch scope)
UPDATE ref_most_templates SET activity_name = 'Batch Each Pick - RF Directed (Micro-Batch)', 
  description = 'Micro-batch pick in high-density cluster. Assumes items within 50-ft radius. For larger batch zones, use Zone Pick template.'
WHERE id = 11;

-- Add 3rd Shipping template (Palletize & Wrap) — was identified as only having 2
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Palletize & Stretch Wrap', 'Shipping', 'PALLETIZE', null, 'Stretch Wrap Machine', 'Build pallet from staged cases, apply stretch wrap. Includes label application and weight verification.', 2400, 41.7, 'pallet', true, 'hybrid');

-- ── 6 MVP TEMPLATES ──

-- 1. Zone Picking - RF Directed
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Zone Pick - RF Directed', 'Picking', 'PICK', 'zone', 'RF Gun + Cart', 'Zone-based each picking with RF scanner. Operator works assigned zone, picks to tote on cart. Includes scan location, pick item, scan item, place in tote, and short travel within zone. Higher throughput than discrete due to reduced travel.', 680, 147.1, 'each', true, 'hybrid');

-- 2. Cluster Picking - RF Directed
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Cluster Pick - RF Directed (Multi-Order)', 'Picking', 'PICK', 'cluster', 'RF Gun + Cart', 'Cluster picking for 4-8 orders simultaneously. Operator picks to multiple totes on cart, RF directs to correct tote. Includes scan location, pick item, scan tote, place item. High efficiency for small-item DCs.', 580, 172.4, 'each', true, 'hybrid');

-- 3. Kitting / Assembly
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Kitting / Light Assembly', 'VAS', 'VAS_KIT', null, 'Workstation + RF', 'Assemble kit from component parts at VAS workstation. Includes: retrieve components from staging, scan each component, assemble per BOM, verify completeness, apply label, stage finished kit. Complexity varies by SKU count.', 1180, 84.7, 'kit', true, 'manual');

-- 4. Returns Processing / Batch Return
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Returns Processing - Inspect & Disposition', 'VAS', 'RETURN', null, 'RF Gun + Workstation', 'Receive return, open package, inspect item condition, scan to system, disposition (restock/refurbish/scrap), relabel if restockable. Includes quality grading per client SOP.', 1800, 55.6, 'unit', true, 'manual');

-- 5. Cycle Count - By Location
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Cycle Count - Location Based', 'Inventory', 'CYCLE_CNT', null, 'RF Gun', 'RF-directed cycle count by location. Travel to location, scan location barcode, count items in slot, enter count in RF, resolve discrepancies. Includes rack levels accessible from floor. Higher locations require order picker.', 900, 111.1, 'location', true, 'manual');

-- 6. Hazmat Pallet Receiving
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Hazmat Pallet Receiving - DOT Compliant', 'Receiving', 'RECEIVE', null, 'Forklift + PPE', 'Receive hazmat pallet with full DOT/EPA compliance. Includes: verify placards, check SDS availability, inspect for damage/leaks, PPE donning, RF scan, segregation putaway to hazmat storage zone. 3-4x slower than standard receiving.', 5400, 18.5, 'pallet', true, 'mhe');

-- 7. Labeling / Relabeling (VAS)
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Labeling / Relabeling', 'VAS', 'VAS_LABEL', null, 'Label Printer + Manual', 'Apply or replace labels on individual units. Includes: retrieve item, scan barcode, print label, apply label, verify placement, stage labeled item. Common for retail compliance (GS1-128, SSCC) and private label programs.', 420, 238.1, 'unit', true, 'manual');

-- 8. Quality Inspection / Rework
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Quality Inspection & Rework', 'VAS', 'VAS_QC', null, 'Inspection Station', 'Visual and dimensional quality inspection per AQL sampling plan. Includes: retrieve sample, inspect per checklist, document findings, disposition pass/fail, rework if minor defect. Rate varies significantly by product complexity.', 1500, 66.7, 'unit', true, 'manual');

-- 9. Random Putaway (non-directed)
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Random Putaway - Operator Selected', 'Putaway', 'PUTAWAY', null, 'Forklift', 'Non-directed putaway where operator selects open reserve location. Includes: pick up pallet from staging, travel to storage aisle, locate open slot, place pallet, RF confirm location. Longer travel time than directed putaway.', 5200, 19.2, 'pallet', true, 'mhe');

-- 10. Each Replenishment to Forward Pick
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Each Replenishment to Forward Pick', 'Replenishment', 'REPLEN', null, 'Pallet Jack + RF', 'Break case and replenish each-level forward pick slot. Includes: travel to reserve, retrieve case, open case, travel to forward pick location, fill slot, RF confirm. Critical for maintaining pick face availability.', 1800, 55.6, 'case', true, 'hybrid');

-- 11. Manifest & BOL Processing
INSERT INTO ref_most_templates (activity_name, process_area, wms_transaction, pick_method, equipment_type, description, total_tmu_base, units_per_hour_base, uom, is_active, labor_category)
VALUES ('Manifest & BOL Processing', 'Shipping', 'SHIP', null, 'Workstation + Printer', 'Generate and verify shipping manifest, print BOL, apply shipping labels to pallets, verify load sequence matches stop order. Includes carrier coordination and dock door assignment.', 1200, 83.3, 'shipment', true, 'manual');

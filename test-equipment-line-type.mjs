// 2026-04-22 — Brock's Equipment Peak-Capacity rewrite Phase 2a migration test.
//
// Verifies:
//   1. backfillEquipmentLineTypes() maps legacy `category` → `line_type` correctly
//   2. Idempotent: running twice produces identical output
//   3. Lines with an explicit line_type are left untouched
//   4. Unknown/missing categories fall back to owned_facility (safe default)
//   5. autoGenerateEquipment() now stamps line_type on every generated row
//
// Run:  node test-equipment-line-type.mjs

import { backfillEquipmentLineTypes } from './tools/cost-model/api.js';
import { autoGenerateEquipment } from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; /* console.log(`✓ ${name}`); */ }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

// ────────────────────────────────────────────────────────────────────────────
// 1. Back-fill from category
// ────────────────────────────────────────────────────────────────────────────

t('back-fill: MHE category → owned_mhe', () => {
  const m = { equipmentLines: [{ equipment_name: 'Reach Truck', category: 'MHE', quantity: 6 }] };
  const n = backfillEquipmentLineTypes(m);
  eq(n, 1, 'updated count');
  eq(m.equipmentLines[0].line_type, 'owned_mhe');
});

t('back-fill: IT category → it_equipment', () => {
  const m = { equipmentLines: [{ equipment_name: 'RF Handheld', category: 'IT', quantity: 20 }] };
  backfillEquipmentLineTypes(m);
  eq(m.equipmentLines[0].line_type, 'it_equipment');
});

t('back-fill: Racking category → owned_facility', () => {
  const m = { equipmentLines: [{ equipment_name: 'Selective Rack', category: 'Racking', quantity: 1250 }] };
  backfillEquipmentLineTypes(m);
  eq(m.equipmentLines[0].line_type, 'owned_facility');
});

t('back-fill: Dock/Charging/Office/Security/Conveyor all → owned_facility', () => {
  const cats = ['Dock', 'Charging', 'Office', 'Security', 'Conveyor'];
  for (const cat of cats) {
    const m = { equipmentLines: [{ equipment_name: 'x', category: cat, quantity: 1 }] };
    backfillEquipmentLineTypes(m);
    eq(m.equipmentLines[0].line_type, 'owned_facility', `${cat} → owned_facility`);
  }
});

t('back-fill: unknown/missing category → owned_facility (safe default)', () => {
  const m = { equipmentLines: [
    { equipment_name: 'mystery', category: undefined, quantity: 1 },
    { equipment_name: 'garbage', category: 'FooBar',  quantity: 1 },
    { equipment_name: 'null',    category: null,      quantity: 1 },
    { equipment_name: 'blank',   category: '',        quantity: 1 },
  ]};
  backfillEquipmentLineTypes(m);
  for (const line of m.equipmentLines) eq(line.line_type, 'owned_facility', `unknown ${JSON.stringify(line.category)}`);
});

t('back-fill: category case-insensitive', () => {
  const m = { equipmentLines: [
    { equipment_name: 'a', category: 'mhe', quantity: 1 },
    { equipment_name: 'b', category: 'It',  quantity: 1 },
    { equipment_name: 'c', category: 'MHE ', quantity: 1 },  // trailing whitespace
  ]};
  backfillEquipmentLineTypes(m);
  eq(m.equipmentLines[0].line_type, 'owned_mhe');
  eq(m.equipmentLines[1].line_type, 'it_equipment');
  eq(m.equipmentLines[2].line_type, 'owned_mhe', 'whitespace trim');
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Idempotency
// ────────────────────────────────────────────────────────────────────────────

t('idempotent: second run touches nothing', () => {
  const m = { equipmentLines: [
    { equipment_name: 'a', category: 'MHE', quantity: 1 },
    { equipment_name: 'b', category: 'IT',  quantity: 1 },
    { equipment_name: 'c', category: 'Racking', quantity: 1 },
  ]};
  const n1 = backfillEquipmentLineTypes(m);
  eq(n1, 3, 'first run updates all 3');
  const snapshot = JSON.stringify(m);
  const n2 = backfillEquipmentLineTypes(m);
  eq(n2, 0, 'second run updates 0');
  eq(JSON.stringify(m), snapshot, 'payload unchanged on second run');
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Explicit line_type wins — no back-fill clobber
// ────────────────────────────────────────────────────────────────────────────

t('preserves explicit line_type even if category disagrees', () => {
  // A user might manually reclassify a line — e.g., "this RF scanner row is
  // actually IT". Future: an MHE line manually set to rented_mhe. Back-fill
  // must NOT overwrite user intent.
  const m = { equipmentLines: [
    { equipment_name: 'hand-picked rental', category: 'MHE', line_type: 'rented_mhe', quantity: 4 },
    { equipment_name: 'reclassified',       category: 'Racking', line_type: 'it_equipment', quantity: 1 },
  ]};
  const n = backfillEquipmentLineTypes(m);
  eq(n, 0, 'nothing touched');
  eq(m.equipmentLines[0].line_type, 'rented_mhe');
  eq(m.equipmentLines[1].line_type, 'it_equipment');
});

t('invalid line_type value IS overwritten', () => {
  // If someone typo'd the enum, treat it as missing.
  const m = { equipmentLines: [{ equipment_name: 'x', category: 'MHE', line_type: 'owned_MHE', quantity: 1 }] };
  const n = backfillEquipmentLineTypes(m);
  eq(n, 1, 'invalid enum treated as missing');
  eq(m.equipmentLines[0].line_type, 'owned_mhe');
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Edge cases — null/empty/missing
// ────────────────────────────────────────────────────────────────────────────

t('null model → 0 updates, no throw', () => {
  eq(backfillEquipmentLineTypes(null), 0);
  eq(backfillEquipmentLineTypes(undefined), 0);
  eq(backfillEquipmentLineTypes({}), 0);
});

t('empty equipmentLines → 0 updates', () => {
  const m = { equipmentLines: [] };
  eq(backfillEquipmentLineTypes(m), 0);
});

t('null line in array → skipped, not crashed', () => {
  const m = { equipmentLines: [null, { equipment_name: 'a', category: 'MHE' }, undefined] };
  const n = backfillEquipmentLineTypes(m);
  eq(n, 1, 'only the valid line was updated');
  eq(m.equipmentLines[1].line_type, 'owned_mhe');
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Legacy fixture shapes — representative of real projects in production
// ────────────────────────────────────────────────────────────────────────────

t('legacy fixture A: Wayfair-shaped mixed bag', () => {
  // Pre-Phase-2a Wayfair: 4 MHE + 4 IT + 1 Racking rows.
  const m = { equipmentLines: [
    { equipment_name: 'Reach Truck', category: 'MHE', quantity: 26 },
    { equipment_name: 'Order Picker', category: 'MHE', quantity: 12 },
    { equipment_name: 'Sit-Down FL',  category: 'MHE', quantity: 3 },
    { equipment_name: 'Walkie Rider', category: 'MHE', quantity: 8 },
    { equipment_name: 'RF Handheld',  category: 'IT',  quantity: 48 },
    { equipment_name: 'Label Printer', category: 'IT', quantity: 16 },
    { equipment_name: 'WiFi AP',      category: 'IT',  quantity: 50 },
    { equipment_name: 'Switch',       category: 'IT',  quantity: 10 },
    { equipment_name: 'Selective Pallet Rack', category: 'Racking', quantity: 23000 },
  ]};
  backfillEquipmentLineTypes(m);
  const typeCounts = m.equipmentLines.reduce((acc, l) => { acc[l.line_type] = (acc[l.line_type] || 0) + 1; return acc; }, {});
  eq(typeCounts.owned_mhe, 4, '4 MHE → owned_mhe');
  eq(typeCounts.it_equipment, 4, '4 IT → it_equipment');
  eq(typeCounts.owned_facility, 1, '1 Racking → owned_facility');
  eq(typeCounts.rented_mhe, undefined, 'no rented lines in legacy data');
});

t('legacy fixture B: bare-minimum project (no MHE)', () => {
  const m = { equipmentLines: [
    { equipment_name: 'Basic Rack', category: 'Racking', quantity: 500 },
    { equipment_name: 'Dock Leveler', category: 'Dock', quantity: 6 },
  ]};
  backfillEquipmentLineTypes(m);
  assert(m.equipmentLines.every(l => l.line_type === 'owned_facility'));
});

// ────────────────────────────────────────────────────────────────────────────
// 6. autoGenerateEquipment emits line_type on every generated row
// ────────────────────────────────────────────────────────────────────────────

t('autoGen: every generated line carries line_type', () => {
  const state = {
    shifts: { shiftsPerDay: 2, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    facility: { totalSqft: 200000, automationLevel: 'none', securityTier: 3 },
    laborLines: [
      { annual_hours: 50 * 2080, mhe_type: 'reach_truck' },
      { annual_hours: 20 * 2080, mhe_type: 'order_picker' },
    ],
    indirectLaborLines: [],
    volumeLines: [{ isOutboundPrimary: true, volume: 2000000, uom: 'orders' },
                  { uom: 'pallet', volume: 50000 }],
  };
  const generated = autoGenerateEquipment(state);
  assert(generated.length > 0, 'generator produced rows');
  for (const line of generated) {
    assert(['owned_mhe','rented_mhe','it_equipment','owned_facility'].includes(line.line_type),
      `line ${line.equipment_name} has line_type=${line.line_type}`);
  }
  // Distribution sanity
  const mhe = generated.filter(l => l.line_type === 'owned_mhe');
  const it  = generated.filter(l => l.line_type === 'it_equipment');
  assert(mhe.length >= 1, 'at least 1 owned_mhe row');
  assert(it.length  >= 1, 'at least 1 it_equipment row');
});

// ────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

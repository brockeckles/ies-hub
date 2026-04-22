// 2026-04-22 — Phase 2d: autoGenerateEquipment splits MHE into owned+rental
// sibling lines driven by the MLV peak/steady/seasonal signal.
//
// Invariants:
//   1. MLV with flat demand (peak==steady) → owned only, no rental line
//   2. MLV with seasonal peak → owned (steady-sized) + rental (delta-sized)
//      - rental.line_type = 'rented_mhe'
//      - rental.seasonal_months matches MLV months > steady × 1.10
//      - rental.monthly_cost matches Brock's default rate deck
//   3. MLV absent → legacy heuristic: owned-only at 1.15 spare, no rental
//   4. IT RF sized to peak_month_fte × 0.3 (not totalDirectFtes)
//   5. Steady owned uses 1.05 spare, not 1.15
//
// Run:  node test-equipment-autogen-split.mjs

import { autoGenerateEquipment } from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function deepEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not deep eq'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

const baseState = () => ({
  shifts: { shiftsPerDay: 3, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
  facility: { totalSqft: 500000, automationLevel: 'none', securityTier: 3 },
  laborLines: [{ annual_hours: 92 * 2080 }],
  indirectLaborLines: [],
  volumeLines: [{ isOutboundPrimary: true, volume: 4100000 }, { uom: 'pallet', volume: 185000 }],
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Flat demand → owned only
// ────────────────────────────────────────────────────────────────────────────

t('flat MLV: only owned reach truck, no rental sibling', () => {
  const state = baseState();
  const mlv = {
    months: [
      { calendar_month: 3,  total_fte: 92, by_mhe: { reach_truck: 18 }, by_it: {} },
      { calendar_month: 6,  total_fte: 92, by_mhe: { reach_truck: 18 }, by_it: {} },
      { calendar_month: 9,  total_fte: 92, by_mhe: { reach_truck: 18 }, by_it: {} },
      { calendar_month: 12, total_fte: 92, by_mhe: { reach_truck: 18 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const reachLines = lines.filter(l => /reach/i.test(l.equipment_name));
  eq(reachLines.length, 1, 'only one reach truck line');
  eq(reachLines[0].line_type, 'owned_mhe');
  // qty = ceil(18 / 3 × 1.05) = ceil(6.3) = 7
  eq(reachLines[0].quantity, 7);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Seasonal peak → owned + rental split
// ────────────────────────────────────────────────────────────────────────────

t('seasonal peak: produces owned + rental pair', () => {
  const state = baseState();
  const mlv = {
    months: [
      // Steady Feb-Sep: 18 FTE
      { calendar_month: 2, total_fte: 92, by_mhe: { reach_truck: 18 }, by_it: {} },
      { calendar_month: 5, total_fte: 92, by_mhe: { reach_truck: 18 }, by_it: {} },
      // Peak Oct-Dec: 30 FTE (67% uplift — well above 1.10 threshold)
      { calendar_month: 10, total_fte: 150, by_mhe: { reach_truck: 30 }, by_it: {} },
      { calendar_month: 11, total_fte: 150, by_mhe: { reach_truck: 30 }, by_it: {} },
      { calendar_month: 12, total_fte: 150, by_mhe: { reach_truck: 30 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const reachLines = lines.filter(l => /reach/i.test(l.equipment_name));
  eq(reachLines.length, 2, 'two reach truck lines (owned + rental)');

  const owned = reachLines.find(l => l.line_type === 'owned_mhe');
  const rental = reachLines.find(l => l.line_type === 'rented_mhe');
  assert(owned, 'owned line exists');
  assert(rental, 'rental line exists');

  // Owned: ceil(18/3 × 1.05) = ceil(6.3) = 7
  eq(owned.quantity, 7);
  // Peak shift fleet = ceil(30/3) = 10; rental qty = 10 - 7 = 3
  eq(rental.quantity, 3);
  // Seasonal months = months with FTE > 18 × 1.10 = 19.8 → Oct, Nov, Dec
  deepEq(rental.seasonal_months, [10, 11, 12]);
  // Brock's default rental rate for reach_truck
  eq(rental.monthly_cost, 1000);
  // Rental line is lease-financed semantically
  eq(rental.acquisition_type, 'lease');
  eq(rental.acquisition_cost, 0);
});

t('seasonal peak: rental line has annotated driven_by', () => {
  const state = baseState();
  const mlv = {
    months: [
      { calendar_month: 2, total_fte: 92, by_mhe: { reach_truck: 15 }, by_it: {} },
      { calendar_month: 11, total_fte: 180, by_mhe: { reach_truck: 30 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const rental = lines.find(l => l.line_type === 'rented_mhe' && /reach/i.test(l.equipment_name));
  assert(rental, 'rental line exists');
  assert(rental.driven_by.includes('Peak'), 'driver string mentions Peak');
  assert(rental.driven_by.includes('Nov'), 'driver string names seasonal month');
});

t('mixed MHE types: each family splits independently', () => {
  const state = baseState();
  const mlv = {
    months: [
      { calendar_month: 2, total_fte: 92, by_mhe: { reach_truck: 18, order_picker: 10 }, by_it: {} },
      { calendar_month: 11, total_fte: 180, by_mhe: { reach_truck: 28, order_picker: 15 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const reachRentals = lines.filter(l => l.line_type === 'rented_mhe' && /reach/i.test(l.equipment_name));
  const pickerRentals = lines.filter(l => l.line_type === 'rented_mhe' && /picker/i.test(l.equipment_name));
  eq(reachRentals.length, 1);
  eq(pickerRentals.length, 1);
  eq(reachRentals[0].monthly_cost, 1000);
  eq(pickerRentals[0].monthly_cost, 900);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Sub-threshold seasonality → no rental
// ────────────────────────────────────────────────────────────────────────────

t('tiny peak (<10% above steady) → no rental line', () => {
  const state = baseState();
  const mlv = {
    months: [
      { calendar_month: 2,  total_fte: 100, by_mhe: { reach_truck: 20 }, by_it: {} },
      // 5% bump — below 1.10 threshold, shouldn't trigger rental
      { calendar_month: 11, total_fte: 105, by_mhe: { reach_truck: 21 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const reachRentals = lines.filter(l => l.line_type === 'rented_mhe' && /reach/i.test(l.equipment_name));
  eq(reachRentals.length, 0, 'no rental when bump < 10%');
});

// ────────────────────────────────────────────────────────────────────────────
// 4. No MLV → heuristic (owned only at 1.15 spare)
// ────────────────────────────────────────────────────────────────────────────

t('no MLV: heuristic produces owned reach at 1.15 spare, no rental', () => {
  const state = baseState();
  const lines = autoGenerateEquipment(state, {}); // no MLV
  const reach = lines.filter(l => /reach/i.test(l.equipment_name));
  eq(reach.length, 1, 'only owned line in heuristic path');
  eq(reach[0].line_type, 'owned_mhe');
  // Heuristic: totalDirectFtes=92, qty = ceil(92/3 × 1.15) = ceil(35.27) = 36
  eq(reach[0].quantity, 36);
});

// ────────────────────────────────────────────────────────────────────────────
// 5. IT sizing to peak HC
// ────────────────────────────────────────────────────────────────────────────

t('IT RF handheld sized to peak_month_fte × 0.3', () => {
  const state = baseState();
  const mlv = {
    months: [
      { calendar_month: 3, total_fte: 80, by_mhe: { reach_truck: 15 }, by_it: {} },
      // Peak 150 FTE in November
      { calendar_month: 11, total_fte: 150, by_mhe: { reach_truck: 25 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const rf = lines.find(l => /RF/i.test(l.equipment_name));
  assert(rf, 'RF line generated');
  // Expected: ceil(150 × 1.15 × 0.3) = ceil(51.75) = 52
  eq(rf.quantity, 52);
  // Still capital, still 3-year refresh
  eq(rf.acquisition_type, 'capital');
  eq(rf.amort_years, 3);
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Sit-down forklift — MLV-only, no heuristic fallback
// ────────────────────────────────────────────────────────────────────────────

t('sit-down forklift not generated without MLV', () => {
  const state = baseState();
  const lines = autoGenerateEquipment(state, {}); // no MLV
  const sd = lines.find(l => /sit.down/i.test(l.equipment_name));
  assert(!sd, 'no sit-down line without MLV signal');
});

t('sit-down forklift: MLV peak + steady produces owned+rental pair', () => {
  const state = baseState();
  const mlv = {
    months: [
      // Steady 3 FTE (1 per shift), Peak 12 FTE (4 per shift) — clear delta
      { calendar_month: 3,  total_fte: 92, by_mhe: { sit_down_forklift: 3 }, by_it: {} },
      { calendar_month: 11, total_fte: 130, by_mhe: { sit_down_forklift: 12 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const sdOwned = lines.find(l => l.line_type === 'owned_mhe' && /sit.down/i.test(l.equipment_name));
  const sdRental = lines.find(l => l.line_type === 'rented_mhe' && /sit.down/i.test(l.equipment_name));
  assert(sdOwned, 'sit-down owned line');
  assert(sdRental, 'sit-down rental line');
  eq(sdRental.monthly_cost, 2500, 'Brock sit-down default rental rate');
});

t('sit-down forklift: rounding absorbs tiny delta → owned only', () => {
  // Legit edge case: 3 steady → ceil(1.05) = 2 units, 6 peak → ceil(2.0) = 2 units.
  // Both round to 2, delta is 0, so no rental line. This prevents nuisance
  // 1-unit rentals when the fractional peak doesn't actually need more fleet.
  const state = baseState();
  const mlv = {
    months: [
      { calendar_month: 3,  total_fte: 92, by_mhe: { sit_down_forklift: 3 }, by_it: {} },
      { calendar_month: 11, total_fte: 130, by_mhe: { sit_down_forklift: 6 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  const sdRental = lines.find(l => l.line_type === 'rented_mhe' && /sit.down/i.test(l.equipment_name));
  assert(!sdRental, 'no rental when rounding absorbs delta');
});

// ────────────────────────────────────────────────────────────────────────────
// 7. All generated lines carry line_type (Phase 2a regression guard)
// ────────────────────────────────────────────────────────────────────────────

t('every generated line has a valid line_type', () => {
  const state = baseState();
  const mlv = {
    months: [
      { calendar_month: 3,  total_fte: 92, by_mhe: { reach_truck: 18, order_picker: 10 }, by_it: {} },
      { calendar_month: 11, total_fte: 150, by_mhe: { reach_truck: 30, order_picker: 18 }, by_it: {} },
    ],
  };
  const lines = autoGenerateEquipment(state, { mlv });
  for (const line of lines) {
    assert(['owned_mhe','rented_mhe','it_equipment','owned_facility'].includes(line.line_type),
      `${line.equipment_name} line_type=${line.line_type}`);
  }
});

// ────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

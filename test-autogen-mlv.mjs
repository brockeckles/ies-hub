// 2026-04-20 — Brock's AutoGen MLV shift-math fix (Task #5).
//
// Before: Reach Truck qty = ceil(totalDirectFtes / 3) × 1.15. On Wayfair
// this produced 36 trucks when the real shift-math says 6.
// After: when an MLV summary is supplied, qty = ceil(peak_month_fte_for_type
// ÷ shifts/day) × 1.15 — counts units you need on the floor AT ONCE, not
// across-headcount coverage.
//
// Run:  node test-autogen-mlv.mjs

import { autoGenerateEquipment } from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${a}, expected ${b}`); }
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

// Fixture: 3-shift warehouse with 18 simultaneous reach-truck FTEs at peak
// (sum of fractional FTEs assigned to reach_truck across a calendar month
// already accounts for all shifts — MLV output).
function fixture({ shiftsPerDay = 3, reachPeak = 18, pickerPeak = 10, totalDirectFtes = 92 } = {}) {
  return {
    state: {
      shifts: { shiftsPerDay, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
      facility: { totalSqft: 500000, automationLevel: 'none', securityTier: 3 },
      laborLines: [{ annual_hours: totalDirectFtes * 2080 }], // so totalDirectFtes lands right
      indirectLaborLines: [],
      volumeLines: [{ isOutboundPrimary: true, volume: 4100000 }],
    },
    mlv: {
      months: [
        // Non-peak month
        { calendar_month: 3, by_mhe: { reach_truck: reachPeak * 0.6, order_picker: pickerPeak * 0.6 }, by_it: {} },
        // Peak month
        { calendar_month: 11, by_mhe: { reach_truck: reachPeak, order_picker: pickerPeak }, by_it: {} },
      ],
    },
  };
}

// ─────────────────────────────────────────────────────────
// MLV shift-math
// ─────────────────────────────────────────────────────────

t('MLV path: Reach Truck qty = ceil(peak / shifts × 1.15) — 18 FTE ÷ 3 shifts = 6 × 1.15 = 6.9 → 7', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 3, reachPeak: 18 });
  const lines = autoGenerateEquipment(state, { mlv });
  const reach = lines.find(l => l.equipment_name === 'Reach Truck');
  assert(reach, 'Reach Truck missing');
  eq(reach.quantity, 7, 'Reach Truck qty');
});

t('MLV path: Order Picker qty = ceil(peak / shifts × 1.15) — 10 FTE ÷ 3 = 3.33 × 1.15 = 3.83 → 4', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 3, pickerPeak: 10 });
  const lines = autoGenerateEquipment(state, { mlv });
  const picker = lines.find(l => l.equipment_name === 'Order Picker');
  assert(picker, 'Order Picker missing');
  eq(picker.quantity, 4);
});

t('MLV path: drivenBy string tags "(MLV shift-math)"', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 3, reachPeak: 18 });
  const lines = autoGenerateEquipment(state, { mlv });
  const reach = lines.find(l => l.equipment_name === 'Reach Truck');
  assert(reach.driven_by.includes('MLV shift-math'), `driven_by=${reach.driven_by}`);
  assert(reach.driven_by.includes('18.0 FTE'), 'peak FTE missing from driver');
  assert(reach.driven_by.includes('3 shifts'), 'shifts missing from driver');
});

t('MLV path: Sit-Down Forklift only emitted when peak > 0.5 FTE', () => {
  const { state } = fixture();
  const mlv1 = { months: [{ calendar_month: 11, by_mhe: { sit_down_forklift: 0.2 }, by_it: {} }] };
  const lines1 = autoGenerateEquipment(state, { mlv: mlv1 });
  assert(!lines1.find(l => l.equipment_name.includes('Sit-Down')), 'should skip sit-down at 0.2 peak');
  const mlv2 = { months: [{ calendar_month: 11, by_mhe: { sit_down_forklift: 4 }, by_it: {} }] };
  const lines2 = autoGenerateEquipment(state, { mlv: mlv2 });
  const sd = lines2.find(l => l.equipment_name.includes('Sit-Down'));
  assert(sd, 'should emit sit-down at 4 peak');
  eq(sd.quantity, 2); // 4/3 × 1.15 = 1.53 → 2
});

t('MLV path: zero shifts_per_day is clamped to 1 (defensive)', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 0, reachPeak: 6 });
  // state.shifts.shiftsPerDay = 0 — autoGen clamps to 1 internally
  const lines = autoGenerateEquipment(state, { mlv });
  const reach = lines.find(l => l.equipment_name === 'Reach Truck');
  // 6 / 1 × 1.15 = 6.9 → 7
  eq(reach.quantity, 7);
});

// ─────────────────────────────────────────────────────────
// Heuristic fallback (no MLV)
// ─────────────────────────────────────────────────────────

t('Heuristic fallback: no MLV → legacy ceil(totalFtes/3) × 1.15', () => {
  const { state } = fixture({ totalDirectFtes: 30 });
  const lines = autoGenerateEquipment(state, {}); // no mlv
  const reach = lines.find(l => l.equipment_name === 'Reach Truck');
  // 30 / 3 × 1.15 = 11.5 → 12
  eq(reach.quantity, 12);
  assert(reach.driven_by.includes('heuristic'), `driven_by=${reach.driven_by}`);
});

t('Heuristic fallback: labor lines without mhe_type → peak returns null → legacy path', () => {
  const { state } = fixture({ totalDirectFtes: 30 });
  // MLV with no by_mhe entries (labor lines didn't tag mhe_type)
  const mlv = { months: [{ calendar_month: 1, by_mhe: {}, by_it: {} }] };
  const lines = autoGenerateEquipment(state, { mlv });
  const reach = lines.find(l => l.equipment_name === 'Reach Truck');
  eq(reach.quantity, 12); // heuristic since peakMheFteFromMlv() returns null
  assert(reach.driven_by.includes('heuristic'), 'should flag heuristic fallback');
});

// ─────────────────────────────────────────────────────────
// Wayfair regression (the exact case Brock flagged)
// ─────────────────────────────────────────────────────────

t('WAYFAIR REGRESSION: 3-shift × 18-FTE-peak reach truck lands at 7 (was 36)', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 3, reachPeak: 18, totalDirectFtes: 92 });
  const lines = autoGenerateEquipment(state, { mlv });
  const reach = lines.find(l => l.equipment_name === 'Reach Truck');
  eq(reach.quantity, 7); // 18÷3 × 1.15 = 6.9 → 7 (was 92/3 × 1.15 × shifts ignored = 36)
  // Without MLV, the legacy would have produced ceil(92/3 × 1.15) = ceil(35.3) = 36
  const legacyLines = autoGenerateEquipment(state, {});
  const legacyReach = legacyLines.find(l => l.equipment_name === 'Reach Truck');
  eq(legacyReach.quantity, 36, 'legacy should still be 36 without MLV');
});

if (fail === 0) {
  console.log(`${pass}/${pass} passed`);
  console.log('AutoGen MLV shift-math invariants pass ✓');
} else {
  console.log(`${pass}/${pass + fail} passed, ${fail} FAILED`);
  process.exit(1);
}

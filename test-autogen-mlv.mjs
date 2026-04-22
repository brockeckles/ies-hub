// 2026-04-20 — Brock's AutoGen MLV shift-math fix (Task #5).
// 2026-04-22 — Phase 2d rewrites the sizing: MHE types now split into
// OWNED (steady-state × 1.05) + RENTED (peak − steady, seasonal).
// Pre-2d behavior (single line × 1.15 spare) is preserved only when MLV
// is absent OR demand is flat across months.
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

t('MLV path: Reach Truck splits — owned steady 10.8 FTE → 4, rental 18−10.8 delta → 2', () => {
  // Fixture has peak=18 (Nov) and steady=10.8 (60% × 18, Mar). Post-2d:
  //   owned qty  = ceil(10.8/3 × 1.05) = ceil(3.78) = 4
  //   peak fleet = ceil(18/3) = 6
  //   rental qty = 6 − 4 = 2
  const { state, mlv } = fixture({ shiftsPerDay: 3, reachPeak: 18 });
  const lines = autoGenerateEquipment(state, { mlv });
  const reachLines = lines.filter(l => /reach/i.test(l.equipment_name));
  eq(reachLines.length, 2, 'owned + rental');
  const owned = reachLines.find(l => l.line_type === 'owned_mhe');
  const rental = reachLines.find(l => l.line_type === 'rented_mhe');
  eq(owned.quantity, 4, 'owned qty (steady × 1.05)');
  eq(rental.quantity, 2, 'rental qty (peak − steady)');
});

t('MLV path: Order Picker splits — owned + rental', () => {
  // peak=10, steady=6 (60%). owned = ceil(6/3 × 1.05) = ceil(2.1) = 3.
  // peak fleet = ceil(10/3) = 4. rental = 4 − 3 = 1.
  const { state, mlv } = fixture({ shiftsPerDay: 3, pickerPeak: 10 });
  const lines = autoGenerateEquipment(state, { mlv });
  const pickerLines = lines.filter(l => /picker/i.test(l.equipment_name));
  eq(pickerLines.length, 2);
  const owned = pickerLines.find(l => l.line_type === 'owned_mhe');
  const rental = pickerLines.find(l => l.line_type === 'rented_mhe');
  eq(owned.quantity, 3);
  eq(rental.quantity, 1);
});

t('MLV path: drivenBy string tags "(MLV)" + mentions steady/peak', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 3, reachPeak: 18 });
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  assert(owned.driven_by.includes('(MLV)'), `owned driver=${owned.driven_by}`);
  assert(owned.driven_by.includes('Steady'), 'owned mentions steady');
  const rental = lines.find(l => l.equipment_name === 'Reach Truck (peak rental)');
  assert(rental.driven_by.includes('Peak'), 'rental mentions peak');
  assert(rental.driven_by.includes('per MLV'), 'rental flags MLV source');
});

t('MLV path: Sit-Down Forklift only emitted when peak > 0.5 FTE', () => {
  const { state } = fixture();
  const mlv1 = { months: [{ calendar_month: 11, by_mhe: { sit_down_forklift: 0.2 }, by_it: {} }] };
  const lines1 = autoGenerateEquipment(state, { mlv: mlv1 });
  assert(!lines1.find(l => l.equipment_name.includes('Sit-Down')), 'should skip sit-down at 0.2 peak');
  const mlv2 = { months: [{ calendar_month: 11, by_mhe: { sit_down_forklift: 4 }, by_it: {} }] };
  const lines2 = autoGenerateEquipment(state, { mlv: mlv2 });
  const sd = lines2.find(l => l.equipment_name === 'Sit-Down Counterbalance Forklift');
  assert(sd, 'should emit sit-down at 4 peak');
  // Flat single-month fixture → peak==steady==4, owned=ceil(4/3 × 1.05)=2, no rental
  eq(sd.quantity, 2);
});

t('MLV path: zero shifts_per_day is clamped to 1 (defensive)', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 0, reachPeak: 6 });
  const lines = autoGenerateEquipment(state, { mlv });
  // Fixture: steady=3.6 (60% × 6), peak=6. With shifts clamped to 1:
  //   owned = ceil(3.6/1 × 1.05) = ceil(3.78) = 4
  //   peak fleet = ceil(6/1) = 6, rental = 2
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  eq(owned.quantity, 4);
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

t('WAYFAIR REGRESSION: 3-shift × 18-FTE-peak produces owned 4 + rental 2 (was 36 / was 7 pre-2d)', () => {
  // Phase 2d further refines the Wayfair regression:
  //   Pre-autogen-fix (2026-04-20): 36 trucks (total-HC heuristic × shifts ignored)
  //   Post-autogen-fix, pre-2d    : 7 trucks (peak × 1.15 spare, single line)
  //   Post-2d                     : 4 owned + 2 rental (steady × 1.05 + peak delta)
  // The fleet-on-floor total at peak is still 4+2=6 — matches Brock's "6 trucks"
  // mental model — but the cost structure now correctly distinguishes owned
  // capex from seasonal rental opex.
  const { state, mlv } = fixture({ shiftsPerDay: 3, reachPeak: 18, totalDirectFtes: 92 });
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  const rental = lines.find(l => l.equipment_name === 'Reach Truck (peak rental)');
  eq(owned.quantity, 4, 'owned = steady 10.8/3 × 1.05 = 3.78 → 4');
  eq(rental.quantity, 2, 'rental = peak 18/3 − owned 4 = 2');
  // Heuristic path (no MLV) unchanged — owned-only at 1.15
  const legacyLines = autoGenerateEquipment(state, {});
  const legacyReach = legacyLines.find(l => l.equipment_name === 'Reach Truck');
  eq(legacyReach.quantity, 36, 'legacy heuristic unchanged');
});

if (fail === 0) {
  console.log(`${pass}/${pass} passed`);
  console.log('AutoGen MLV shift-math invariants pass ✓');
} else {
  console.log(`${pass}/${pass + fail} passed, ${fail} FAILED`);
  process.exit(1);
}

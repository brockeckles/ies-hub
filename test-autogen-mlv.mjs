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

// ─────────────────────────────────────────────────────────
// 2026-04-22 EVE: Matrix-weighted peak (Brock option A)
//
// When the Shift Planner matrix skews toward one shift (e.g., picking 30/50/20),
// MHE sizing should respect the peak-shift share rather than assume flat
// division across all shifts. Lock the new behavior and the fallback.
// ─────────────────────────────────────────────────────────

// Extended fixture: carries a shiftAllocation + mhe_type on labor lines so
// peakShiftFractionForMheType has real signal to read.
function fixtureWithMatrix({ shiftsPerDay = 3, reachPeak = 18, matrix = null, fn = 'putaway', mheType = 'reach_truck', totalDirectFtes = 92 } = {}) {
  const base = fixture({ shiftsPerDay, reachPeak, totalDirectFtes });
  // Attach mhe_type to labor lines so the matrix lookup has something to hit.
  base.state.laborLines = [
    { annual_hours: totalDirectFtes * 2080, mhe_type: mheType, process_area: fn.charAt(0).toUpperCase() + fn.slice(1) },
  ];
  if (matrix) {
    const emptyRow = new Array(shiftsPerDay).fill(0);
    base.state.shiftAllocation = {
      archetypeRef: null, overridden: true,
      shifts: Array.from({ length: shiftsPerDay }, (_, i) => ({ num: i + 1 })),
      matrix: {
        inbound:   emptyRow.slice(), putaway:   emptyRow.slice(),
        picking:   emptyRow.slice(), replenish: emptyRow.slice(),
        pack:      emptyRow.slice(), ship:      emptyRow.slice(),
        returns:   emptyRow.slice(), vas:       emptyRow.slice(),
      },
      audit: {},
    };
    base.state.shiftAllocation.matrix[fn] = matrix.slice();
  }
  return base;
}

t('matrix skew 30/50/20 pushes owned qty higher than flat 1/3 assumption', () => {
  // Flat: ceil(10.8 × 1/3 × 1.05) = ceil(3.78) = 4
  // Skew: peak-shift fraction = 50/100 = 0.5
  //       ceil(10.8 × 0.5 × 1.05) = ceil(5.67) = 6
  const { state, mlv } = fixtureWithMatrix({ shiftsPerDay: 3, reachPeak: 18, matrix: [30, 50, 20], fn: 'putaway' });
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  eq(owned.quantity, 6, 'owned qty reflects 50% peak-shift share');
  assert(/50% peak-shift share/.test(owned.driven_by), 'driven_by annotates peak share');
  assert(/matrix/.test(owned.driven_by), 'driven_by flags matrix source');
});

t('matrix 100/0/0 (single-shift op) triples MHE vs flat 3-shift assumption', () => {
  // Flat: ceil(10.8/3 × 1.05) = 4; Skew 100%: ceil(10.8 × 1 × 1.05) = ceil(11.34) = 12
  const { state, mlv } = fixtureWithMatrix({ shiftsPerDay: 3, reachPeak: 18, matrix: [100, 0, 0], fn: 'putaway' });
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  eq(owned.quantity, 12, 'owned qty = 10.8 × 100% × 1.05');
});

t('matrix Even (33/33/33) matches pre-matrix flat sizing exactly', () => {
  // peak-shift fraction = 33.33/100 ≈ 0.3333 ≈ 1/shiftsPerDay → no skew-adjustment kicks in
  const { state, mlv } = fixtureWithMatrix({ shiftsPerDay: 3, reachPeak: 18, matrix: [33.33, 33.33, 33.33], fn: 'putaway' });
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  eq(owned.quantity, 4, 'owned qty matches flat — Even split has no skew');
  assert(/÷ 3 shifts/.test(owned.driven_by), 'driven_by uses the legacy ÷ 3 phrasing when no skew');
});

t('no shiftAllocation → falls back to flat 1/shiftsPerDay (pre-EVE behavior preserved)', () => {
  const { state, mlv } = fixture({ shiftsPerDay: 3, reachPeak: 18 });
  // Omit shiftAllocation entirely
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  eq(owned.quantity, 4, 'legacy flat sizing preserved when no allocation exists');
});

t('no labor line carries mhe_type → falls back to flat', () => {
  // Add a matrix but with labor lines missing mhe_type so the type lookup hits nothing
  const { state, mlv } = fixtureWithMatrix({ shiftsPerDay: 3, reachPeak: 18, matrix: [50, 30, 20], fn: 'putaway' });
  // Strip mhe_type from all labor lines
  state.laborLines = state.laborLines.map(l => ({ ...l, mhe_type: null }));
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  eq(owned.quantity, 4, 'fallback to flat when nothing links type→function');
});

t('all-zero matrix rows → falls back to flat', () => {
  const { state, mlv } = fixtureWithMatrix({ shiftsPerDay: 3, reachPeak: 18, matrix: [0, 0, 0], fn: 'putaway' });
  const lines = autoGenerateEquipment(state, { mlv });
  const owned = lines.find(l => l.equipment_name === 'Reach Truck' && l.line_type === 'owned_mhe');
  eq(owned.quantity, 4, 'zero row means no signal — use flat');
});

t('matrix skew also scales rental sibling qty', () => {
  // Flat: peakShiftFleet = ceil(18/3) = 6, rental = 6-4 = 2
  // Skew 50%: peakShiftFleet = ceil(18 × 0.5) = 9, owned = 6, rental = 9-6 = 3
  const { state, mlv } = fixtureWithMatrix({ shiftsPerDay: 3, reachPeak: 18, matrix: [30, 50, 20], fn: 'putaway' });
  const lines = autoGenerateEquipment(state, { mlv });
  const rental = lines.find(l => l.equipment_name === 'Reach Truck (peak rental)');
  eq(rental.quantity, 3, 'rental delta scales with peak share');
  assert(/50% peak-shift share/.test(rental.driven_by), 'rental driven_by annotates peak share');
});

if (fail === 0) {
  console.log(`${pass}/${pass} passed`);
  console.log('AutoGen MLV shift-math invariants pass ✓');
} else {
  console.log(`${pass}/${pass + fail} passed, ${fail} FAILED`);
  process.exit(1);
}

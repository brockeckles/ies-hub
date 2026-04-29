#!/usr/bin/env node
/**
 * IES Hub v3 — Phase 4d acceptance: computeMonthlyLaborFromLines + the
 * buildMonthlyProjections per-line path produce peak-month surges that
 * the aggregate path hides.
 */

import {
  computeMonthlyLaborFromLines,
  buildMonthlyProjections,
} from './tools/cost-model/calc.monthly.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${a}, expected ${b}`); }
function close(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'not close'}: got ${a}, expected ≈ ${b}`); }

const FALLBACK_HEUR = { overtimePct: 5, absenceAllowancePct: 12, benefitLoadPct: 35 };

const FLAT_LINE = {
  annual_hours: 2080,
  hourly_rate: 20,
  burden_pct: 30,
  benefits_per_hour: 0,
  employment_type: 'permanent',
  temp_agency_markup_pct: 0,
  monthly_overtime_profile: null,
  monthly_absence_profile: null,
};

const PEAK_LINE = {
  ...FLAT_LINE,
  // Q4 surge — flat 5% Jan-Jun, ramping to 20% in Nov
  monthly_overtime_profile: [0.05, 0.05, 0.05, 0.05, 0.05, 0.08, 0.08, 0.10, 0.12, 0.15, 0.20, 0.10],
  monthly_absence_profile: null, // inherit flat
};

console.log('\n--- computeMonthlyLaborFromLines ---');

test('empty laborLines → 0', () => {
  eq(computeMonthlyLaborFromLines([], { calcHeur: FALLBACK_HEUR, calendarMonth: 1, seasonalShare: 1/12 }), 0);
});

test('flat line, January: base × 26/hr × 1/12 of 2080 hrs', () => {
  // 2026-04-29 OT-fix: OT formula now (1 + otPct/100 × 0.5) — 5% OT means
  // 5% of hours at 1.5× = 2.5% premium share, not 5% extra hours.
  // monthlyEffectiveHours = 2080/12 × (1 + 0.05 × 0.5) × (1 - 0.12)
  //                       = 173.33 × 1.025 × 0.88 ≈ 156.39
  // loadedRate = 20 × 1.30 = 26
  // expected ≈ 156.39 × 26 ≈ 4066
  const cost = computeMonthlyLaborFromLines([FLAT_LINE], {
    calcHeur: FALLBACK_HEUR, calendarMonth: 1, seasonalShare: 1/12,
    escLaborMult: 1, volMult: 1, rampLaborMult: 1,
  });
  close(cost, 4066, 5);
});

test('peak line in November (20% OT) costs MORE than January (5% OT)', () => {
  const ctx = { calcHeur: FALLBACK_HEUR, seasonalShare: 1/12, escLaborMult: 1, volMult: 1, rampLaborMult: 1 };
  const jan = computeMonthlyLaborFromLines([PEAK_LINE], { ...ctx, calendarMonth: 1 });
  const nov = computeMonthlyLaborFromLines([PEAK_LINE], { ...ctx, calendarMonth: 11 });
  assert(nov > jan, `Nov (${nov.toFixed(0)}) should exceed Jan (${jan.toFixed(0)})`);
  // 2026-04-29 OT-fix: ratio is now (1 + 0.20×0.5)/(1 + 0.05×0.5) = 1.10/1.025 ≈ 1.073
  const ratio = nov / jan;
  close(ratio, (1 + 0.20*0.5) / (1 + 0.05*0.5), 0.02, 'Nov/Jan ratio ≈ 1.073');
});

test('temp_agency ratio to permanent (doc §3.3: no perm burden on temp)', () => {
  // Per Labor Build-Up Logic doc §3.3 (Brock 2026-04-20): temp rates already
  // include the agency's fully-loaded cost (markup covers agency wage load +
  // profit). Applying perm burden on top was double-counting.
  //   perm loaded = $20 × (1 + 30%) = $26/hr
  //   temp loaded = $20 × 1.25 (markup) × (1 + 0%) = $25/hr  (no wage load)
  // temp/perm ratio = 25/26 ≈ 0.962, so temp costs ~3.8% LESS than perm,
  // which is the whole reason agencies can operate profitably while still
  // undercutting permanent labor for the client.
  const TEMP_LINE = { ...FLAT_LINE, burden_pct: null, employment_type: 'temp_agency', temp_agency_markup_pct: 25 };
  const ctx = { calcHeur: FALLBACK_HEUR, calendarMonth: 1, seasonalShare: 1/12, escLaborMult: 1, volMult: 1, rampLaborMult: 1 };
  const perm = computeMonthlyLaborFromLines([FLAT_LINE], ctx);
  const temp = computeMonthlyLaborFromLines([TEMP_LINE], ctx);
  close(temp / perm, 25 / 26, 0.002, 'temp/perm ratio = 25/26 (doc §3.3)');
});

test('two lines sum to individual contributions', () => {
  const ctx = { calcHeur: FALLBACK_HEUR, calendarMonth: 6, seasonalShare: 1/12, escLaborMult: 1, volMult: 1, rampLaborMult: 1 };
  const each = computeMonthlyLaborFromLines([FLAT_LINE], ctx);
  const both = computeMonthlyLaborFromLines([FLAT_LINE, FLAT_LINE], ctx);
  close(both, each * 2, 0.001);
});

test('ramp + escalation multipliers compound correctly', () => {
  const ctx = { calcHeur: FALLBACK_HEUR, calendarMonth: 1, seasonalShare: 1/12 };
  const base = computeMonthlyLaborFromLines([FLAT_LINE], { ...ctx, rampLaborMult: 1, volMult: 1, escLaborMult: 1 });
  const scaled = computeMonthlyLaborFromLines([FLAT_LINE], { ...ctx, rampLaborMult: 0.55, volMult: 1.05, escLaborMult: 1.03 });
  const expectedFactor = 0.55 * 1.05 * 1.03;
  close(scaled / base, expectedFactor, 0.001);
});

// ---------------------------------------------------------------------------
// End-to-end: buildMonthlyProjections with per-line labor
// ---------------------------------------------------------------------------
console.log('\n--- buildMonthlyProjections end-to-end ---');

// Minimal 12-month periods array
function mkPeriods() {
  const arr = [];
  for (let i = 0; i < 12; i++) {
    arr.push({
      id: i + 1,
      period_type: 'month',
      period_index: i,
      calendar_year: 2027,
      calendar_month: i + 1,
      customer_fy_index: 1,
      customer_fm_index: i + 1,
      label: `M${i + 1}`,
      is_pre_go_live: false,
    });
  }
  return arr;
}

test('per-line path: Nov labor > Jan labor when line has Q4 OT spike', () => {
  const bundle = buildMonthlyProjections({
    project_id: 1,
    contract_term_years: 1,
    pre_go_live_months: 0,
    base_labor_cost: 0,
    base_facility_cost: 0,
    base_equipment_cost: 0,
    base_overhead_cost: 0,
    base_vas_cost: 0,
    base_orders: 1000,
    margin_pct: 0.15,
    periods: mkPeriods(),
    laborLines: [PEAK_LINE],
    calcHeur: FALLBACK_HEUR,
    ramp: { type: 'custom', wk1_factor: 1, wk2_factor: 1, wk4_factor: 1, wk8_factor: 1, wk12_factor: 1 },
    seasonality: { monthly_shares: Array(12).fill(1/12) },
  });
  const byMonth = Object.fromEntries(
    bundle.expense.filter(r => r.expense_line_code === 'LABOR_HOURLY')
      .map(r => [bundle.periods.find(p => p.id === r.period_id)?.calendar_month, r.amount])
  );
  assert(byMonth[11] > byMonth[1], `Nov (${byMonth[11]?.toFixed(0)}) should exceed Jan (${byMonth[1]?.toFixed(0)})`);
});

test('flat-profile path reconciles: sum of monthly labor ≈ annual_hours × loadedRate × (1+OT×0.5)(1-abs)', () => {
  const bundle = buildMonthlyProjections({
    project_id: 1,
    contract_term_years: 1,
    pre_go_live_months: 0,
    base_labor_cost: 0,
    base_facility_cost: 0,
    base_equipment_cost: 0,
    base_overhead_cost: 0,
    base_vas_cost: 0,
    base_orders: 1000,
    margin_pct: 0.15,
    periods: mkPeriods(),
    laborLines: [FLAT_LINE],
    calcHeur: FALLBACK_HEUR,
    ramp: { type: 'custom', wk1_factor: 1, wk2_factor: 1, wk4_factor: 1, wk8_factor: 1, wk12_factor: 1 },
    seasonality: { monthly_shares: Array(12).fill(1/12) },
  });
  const totalLaborCost = bundle.expense
    .filter(r => r.expense_line_code === 'LABOR_HOURLY')
    .reduce((s, r) => s + r.amount, 0);
  // 2026-04-29 OT-fix: OT factor is now (1 + 0.05×0.5) = 1.025, not 1.05
  // expected: 2080 × 26 × 1.025 × 0.88 ≈ 48,779
  const expected = 2080 * 26 * (1 + 0.05 * 0.5) * 0.88;
  close(totalLaborCost, expected, 50, `annual flat reconciliation ≈ ${expected.toFixed(0)}`);
});

test('aggregate fallback still works when no laborLines provided', () => {
  const bundle = buildMonthlyProjections({
    project_id: 1,
    contract_term_years: 1,
    pre_go_live_months: 0,
    base_labor_cost: 60000,
    base_facility_cost: 0,
    base_equipment_cost: 0,
    base_overhead_cost: 0,
    base_vas_cost: 0,
    base_orders: 1000,
    margin_pct: 0.15,
    periods: mkPeriods(),
    // laborLines intentionally omitted
    ramp: { type: 'custom', wk1_factor: 1, wk2_factor: 1, wk4_factor: 1, wk8_factor: 1, wk12_factor: 1 },
    seasonality: { monthly_shares: Array(12).fill(1/12) },
  });
  const totalLaborCost = bundle.expense
    .filter(r => r.expense_line_code === 'LABOR_HOURLY')
    .reduce((s, r) => s + r.amount, 0);
  // With flat season and ramp = 1, should reconcile to base_labor_cost
  close(totalLaborCost, 60000, 1);
});

console.log(`\n${pass}/${pass + fail} tests passed.`);
process.exit(fail ? 1 : 0);

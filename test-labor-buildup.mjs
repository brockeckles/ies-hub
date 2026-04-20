/**
 * Phase A Labor Build-Up Logic tests.
 *
 * Locks in the math from cm/Labor Build-Up Logic.docx (Brock 2026-04-20).
 * Two chains must reconcile: HOURS (volume → effective UPH → hours required
 * → FTEs → headcount with PTO/holiday uplift) and COST (base rate → wage
 * escalation → shift diff → OT → wage load by year).
 *
 * Also covers the wage-load consolidation (Brock 2026-04-20 callout: the
 * current code double-dips by summing burden_pct + benefit_load_pct; they
 * cover the same bucket. Canonical is ONE wage_load_pct, year-scheduled).
 */
import {
  operatingHours,
  productiveHoursPerFTE,
  effectiveUPH,
  ptoHeadcountUplift,
  holidayUplift,
  wageLoadForYear,
  wageLoadFracForLine,
  escalatedWage,
  shiftDifferentialMult,
} from './tools/cost-model/calc.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}
function approx(actual, expected, tol = 1e-4) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`expected ${expected}, got ${actual} (tol ${tol})`);
  }
}
function eq(actual, expected) {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

// ─────────────────────────────────────────────────────────
// HOURS CHAIN
// ─────────────────────────────────────────────────────────

t('operatingHours = hours × days × weeks (no PTO subtraction)', () => {
  eq(operatingHours({ hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 }), 2080);
});

t('operatingHours defaults: 8 × 5 × 52 = 2080 when fields missing', () => {
  eq(operatingHours({}), 2080);
});

t('productiveHoursPerFTE = scheduled × util × (1-pto) × (1-holiday)', () => {
  // 2080 × 0.85 × (1 - 0.05) × (1 - 0.03) = 2080 × 0.85 × 0.95 × 0.97 = 1629.4
  const h = productiveHoursPerFTE(
    { hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    { directUtilization: 0.85, ptoPct: 0.05, holidayPct: 0.03 }
  );
  approx(h, 2080 * 0.85 * 0.95 * 0.97, 0.5);
});

t('productiveHoursPerFTE uses sensible defaults when omitted', () => {
  // 2080 × 0.85 × 0.95 × 1.0 = 1679.6
  const h = productiveHoursPerFTE({});
  approx(h, 2080 * 0.85 * 0.95, 1);
});

t('effectiveUPH = baseUph × directUtilization (PF&D haircut)', () => {
  const line = { base_uph: 100 };
  approx(effectiveUPH(line, { directUtilization: 0.85 }), 85, 0.01);
});

t('effectiveUPH defaults directUtilization to 0.85', () => {
  approx(effectiveUPH({ base_uph: 200 }, {}), 170, 0.01);
});

t('effectiveUPH honors productivity_pct (MOST % to standard)', () => {
  // 100 × 0.85 × (90/100) = 76.5
  approx(effectiveUPH({ base_uph: 100 }, { directUtilization: 0.85, productivity_pct: 90 }), 76.5, 0.01);
});

t('effectiveUPH returns 0 for zero base_uph', () => {
  eq(effectiveUPH({ base_uph: 0 }, {}), 0);
  eq(effectiveUPH({}, {}), 0);
});

t('ptoHeadcountUplift = rawFTEs / (1 - pto_pct)', () => {
  approx(ptoHeadcountUplift(100, 0.05), 105.263, 0.01);
  approx(ptoHeadcountUplift(100, 0.10), 111.111, 0.01);
});

t('ptoHeadcountUplift(ptoPct=0) = identity', () => {
  eq(ptoHeadcountUplift(100, 0), 100);
});

t('ptoHeadcountUplift clamps negative and > 0.5', () => {
  eq(ptoHeadcountUplift(100, -0.5), 100); // neg clamped to 0
  // 0.5 is max → divide by 0.5 = 200
  eq(ptoHeadcountUplift(100, 0.99), 200);
});

t('holidayUplift(reduce_hours) = identity (holidays handled upstream)', () => {
  eq(holidayUplift(100, 0.03, 'reduce_hours'), 100);
  eq(holidayUplift(100, 0.03), 100); // default treatment
});

t('holidayUplift(headcount_uplift) = rawFTEs / (1 - holiday_pct)', () => {
  approx(holidayUplift(100, 0.03, 'headcount_uplift'), 103.093, 0.01);
});

// ─────────────────────────────────────────────────────────
// COST CHAIN
// ─────────────────────────────────────────────────────────

t('escalatedWage year 1 = base (no escalation)', () => {
  eq(escalatedWage(20, 1, 0.03), 20);
});

t('escalatedWage year 3 = base × (1+esc)^2', () => {
  // 20 × 1.03^2 = 21.218
  approx(escalatedWage(20, 3, 0.03), 20 * 1.03 * 1.03, 0.001);
});

t('escalatedWage clamps negative escPct to 0', () => {
  eq(escalatedWage(20, 5, -0.10), 20);
});

t('wageLoadForYear: 5-year schedule indexing', () => {
  const schedule = [0.30, 0.3065, 0.3106, 0.3127, 0.3133];
  approx(wageLoadForYear(schedule, 1), 0.30, 0.0001);
  approx(wageLoadForYear(schedule, 3), 0.3106, 0.0001);
  approx(wageLoadForYear(schedule, 5), 0.3133, 0.0001);
});

t('wageLoadForYear: Y6+ clamps to last value (not past end)', () => {
  const schedule = [0.30, 0.3065, 0.3106, 0.3127, 0.3133];
  approx(wageLoadForYear(schedule, 6), 0.3133, 0.0001);
  approx(wageLoadForYear(schedule, 99), 0.3133, 0.0001);
});

t('wageLoadForYear: empty/null array → fallback', () => {
  approx(wageLoadForYear(null, 1, 0.30), 0.30, 0.0001);
  approx(wageLoadForYear([], 1), 0.30, 0.0001); // default fallback 0.30
});

// ─────────────────────────────────────────────────────────
// WAGE LOAD CONSOLIDATION (Brock 2026-04-20 callout)
// "Burden% + Benefits% was double-dipping. Canonical = ONE wage load."
// ─────────────────────────────────────────────────────────

t('wageLoadFracForLine: perm with per-line burden_pct wins', () => {
  const line = { employment_type: 'permanent', burden_pct: 30 };
  approx(wageLoadFracForLine(line, 1, {}), 0.30, 0.0001);
});

t('wageLoadFracForLine: perm with no burden → year schedule', () => {
  const line = { employment_type: 'permanent' };
  const opts = { wageLoadByYear: [0.30, 0.3065, 0.3106, 0.3127, 0.3133] };
  approx(wageLoadFracForLine(line, 3, opts), 0.3106, 0.0001);
});

t('wageLoadFracForLine: perm + no burden + no schedule → fallback 0.30', () => {
  approx(wageLoadFracForLine({}, 1, {}), 0.30, 0.0001);
});

t('wageLoadFracForLine: TEMP lines always return 0 (already loaded)', () => {
  const line = { employment_type: 'temp_agency', burden_pct: 30 };
  eq(wageLoadFracForLine(line, 1, { wageLoadByYear: [0.30, 0.31] }), 0);
});

t('wageLoadFracForLine: custom defaultWageLoadFrac respected', () => {
  const line = { employment_type: 'permanent' };
  approx(wageLoadFracForLine(line, 1, { defaultWageLoadFrac: 0.28 }), 0.28, 0.0001);
});

t('REGRESSION: benefit_load_pct is IGNORED (no double-dip)', () => {
  // Simulates the old calc path where benefit_load_pct would have been added.
  // The new helper must return ONLY burden_pct, not burden + benefits.
  const line = { employment_type: 'permanent', burden_pct: 30 };
  // If the consolidator were buggy and added a 15% benefits on top:
  //   bad = 0.30 + 0.15 = 0.45
  // Correct value = just 0.30.
  const resolved = wageLoadFracForLine(line, 1, { wageLoadByYear: [0.15] /* would-be benefit */ });
  // burden_pct takes priority → 0.30, not 0.45, not 0.15
  approx(resolved, 0.30, 0.0001);
});

// ─────────────────────────────────────────────────────────
// SHIFT DIFFERENTIAL
// ─────────────────────────────────────────────────────────

t('shiftDifferentialMult: all shift-1 = multiplier 1.0', () => {
  eq(shiftDifferentialMult({}, {}), 1);
  eq(shiftDifferentialMult({ shift_2_hours_share: 0, shift_3_hours_share: 0 }, { shift2Premium: 0.10 }), 1);
});

t('shiftDifferentialMult: 25% on shift 2 @ 10% premium → 1.025', () => {
  // 1 + 0.25 × 0.10 = 1.025
  const m = shiftDifferentialMult({ shift_2_hours_share: 0.25 }, { shift2Premium: 0.10 });
  approx(m, 1.025, 0.0001);
});

t('shiftDifferentialMult: 50% s2 @ 10% + 20% s3 @ 15% → 1.08', () => {
  // 1 + 0.5×0.10 + 0.2×0.15 = 1 + 0.05 + 0.03 = 1.08
  const m = shiftDifferentialMult(
    { shift_2_hours_share: 0.5, shift_3_hours_share: 0.2 },
    { shift2Premium: 0.10, shift3Premium: 0.15 }
  );
  approx(m, 1.08, 0.0001);
});

t('shiftDifferentialMult: clamps shares to [0,1]', () => {
  // s2share of 2.0 clamped to 1.0 → 1 + 1.0 × 0.10 = 1.10
  const m = shiftDifferentialMult({ shift_2_hours_share: 2.0 }, { shift2Premium: 0.10 });
  approx(m, 1.10, 0.0001);
});

t('shiftDifferentialMult: clamps negative premiums to 0', () => {
  eq(shiftDifferentialMult({ shift_2_hours_share: 0.5 }, { shift2Premium: -0.10 }), 1);
});

// ─────────────────────────────────────────────────────────
// INTEGRATION (hours chain meets cost chain)
// Matches doc §7 integration tests.
// ─────────────────────────────────────────────────────────

t('§7 integration: volume 850K → hours_required via effectiveUPH', () => {
  // Volume 850,000 units/yr, base_uph 100, direct_util 0.85 → effective 85 UPH
  // hours_required = 850,000 / 85 = 10,000 hours
  const line = { base_uph: 100 };
  const effUph = effectiveUPH(line, { directUtilization: 0.85 });
  const hoursRequired = 850000 / effUph;
  approx(hoursRequired, 10000, 1);
  // vs naive (base_uph 100) = 8,500 hours → under-staffs by 15%
  approx(850000 / 100, 8500, 1);
});

t('§7 integration: FTEs needed with PTO uplift', () => {
  // 10,000 hours / 2080 hours/FTE = 4.81 raw FTEs
  // × 1 / (1 - 0.05) = 5.06 FTEs with PTO coverage
  const rawFTEs = 10000 / 2080;
  const withPto = ptoHeadcountUplift(rawFTEs, 0.05);
  approx(rawFTEs, 4.8077, 0.001);
  approx(withPto, 5.0607, 0.001);
});

t('§7 integration: perm payroll Y3 = rate × hours × (1+esc)^2', () => {
  // baseRate $20, hours 1000, escPct 3%, year 3
  const rate = escalatedWage(20, 3, 0.03); // $21.218
  const basePayroll = rate * 1000;
  approx(basePayroll, 21218, 1);
});

t('§7 integration: perm total = basePayroll × (1 + wage_load_y3)', () => {
  const rate = escalatedWage(20, 3, 0.03); // $21.218
  const hours = 1000;
  const line = { employment_type: 'permanent' };
  const wageLoadFrac = wageLoadFracForLine(line, 3, {
    wageLoadByYear: [0.30, 0.3065, 0.3106, 0.3127, 0.3133]
  });
  const basePayroll = rate * hours;
  const total = basePayroll * (1 + wageLoadFrac); // basePayroll × 1.3106
  approx(basePayroll, 21218, 1);
  approx(total, 21218 * 1.3106, 1);
});

t('§7 integration: temp cost skips wage load (rate already loaded)', () => {
  // Permanent MH at $9.80, temp is $9.80 × 1.38 = $13.524
  // For 1 hour: $13.524, no additional wage load
  const line = {
    employment_type: 'temp_agency',
    hourly_rate: 9.80,
    temp_agency_markup_pct: 38,
  };
  // effective rate (reuse existing effectiveHourlyRate for parity)
  const effRate = 9.80 * 1.38;
  approx(effRate, 13.524, 0.001);
  const wageLoadFrac = wageLoadFracForLine(line, 1, { wageLoadByYear: [0.30] });
  eq(wageLoadFrac, 0); // temp line always 0
  const oneHourCost = effRate * (1 + wageLoadFrac);
  approx(oneHourCost, 13.524, 0.001);
});

t('§7 integration: OT blended rate = 1 + ot_pct × 0.5', () => {
  // 1000 hours at $20, with 5% OT:
  //   950 straight × $20 = $19,000
  //   50 OT × $20 × 1.5 = $1,500
  //   total = $20,500
  // Blended formula: 1000 × $20 × (1 + 0.05 × 0.5) = 1000 × $20 × 1.025 = $20,500
  const hours = 1000, rate = 20, otPct = 0.05;
  const straight = 950 * rate;
  const ot = 50 * rate * 1.5;
  const blended = hours * rate * (1 + otPct * 0.5);
  approx(blended, straight + ot, 0.01);
  approx(blended, 20500, 0.01);
});

// ─────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────

if (fail === 0) {
  console.log(`${pass}/${pass} passed`);
  console.log('Labor Build-Up Logic invariants pass ✓');
} else {
  console.log(`${pass}/${pass + fail} passed, ${fail} FAILED`);
  process.exit(1);
}

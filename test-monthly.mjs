// Standalone Node ESM test runner for tools/cost-model/calc.monthly.js
// Mirrors the acceptance-criterion tests from /sessions/.../mnt/cm/phase1_tests.test.js
// without requiring vitest.
//
// Run:  node test-monthly.mjs

import {
  resolveProjectPeriods,
  periodIdForIndex,
  rampFactorAtWeek,
  rampFactorForMonth,
  seasonalizedVolume,
  validateSeasonality,
  buildMonthlyProjections,
  groupMonthlyToYearly,
  monthlyProjectionView,
} from './tools/cost-model/calc.monthly.js';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (e) {
    failed++;
    failures.push(`✗ ${name}\n    ${e.message}`);
    process.stdout.write('F');
  }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function near(actual, expected, tolerance = 0.01, msg = '') {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) throw new Error(`${msg} expected ~${expected}, got ${actual}`);
}

// ---- Fixtures ----
const MEDIUM_RAMP = { type: 'medium', wk1_factor: 0.48, wk2_factor: 0.64, wk4_factor: 0.80, wk8_factor: 0.92, wk12_factor: 0.98 };
const FLAT = { monthly_shares: Array(12).fill(1 / 12) };
const PEAK = { monthly_shares: [0.05, 0.05, 0.06, 0.07, 0.08, 0.08, 0.08, 0.09, 0.10, 0.12, 0.12, 0.10] };

function seedPeriods() {
  const ps = [];
  for (let i = -12; i <= 71; i++) {
    const goLive = new Date(2026, 0, 1);
    const d = new Date(goLive.getFullYear(), goLive.getMonth() + i, 1);
    ps.push({
      id: i + 13,
      period_type: 'month',
      period_index: i,
      calendar_year: d.getFullYear(),
      calendar_month: d.getMonth() + 1,
      customer_fy_index: Math.max(0, Math.floor(i / 12) + 1),
      customer_fm_index: ((i % 12) + 12) % 12 + 1,
      label: i < 0 ? `M${i}` : `M${i + 1}`,
      is_pre_go_live: i < 0,
    });
  }
  return ps;
}
function baseParams(over = {}) {
  return {
    project_id: 1,
    contract_term_years: 5,
    pre_go_live_months: 3,
    base_labor_cost: 6_000_000, base_facility_cost: 1_200_000,
    base_equipment_cost: 300_000, base_overhead_cost: 200_000, base_vas_cost: 100_000,
    startup_amort: 60_000, startup_capital: 300_000,
    base_orders: 2_000_000,
    margin_pct: 0.16,
    vol_growth_pct: 0.05, labor_esc_pct: 0.04, cost_esc_pct: 0.03,
    tax_rate_pct: 25,
    dso_days: 30, dpo_days: 30, labor_payable_days: 14,
    ramp: MEDIUM_RAMP,
    seasonality: FLAT,
    periods: seedPeriods(),
    startupLines: [
      { description: 'Project Management', one_time_cost: 150_000 },
      { description: 'IT Integration',     one_time_cost: 150_000 },
    ],
    pricingBuckets: [],  // exercise the margin-driven fallback by default
    ...over,
  };
}

// ============================================================
// 1. PERIOD RESOLUTION
// ============================================================
test('resolveProjectPeriods: returns (preLive + years*12) periods', () => {
  const r = resolveProjectPeriods(seedPeriods(), new Date(2026, 0, 1), 3, 5, 1);
  assert(r.length === 63, `expected 63, got ${r.length}`);
});
test('resolveProjectPeriods: index range [-preLive .. years*12-1]', () => {
  const r = resolveProjectPeriods(seedPeriods(), new Date(2026, 0, 1), 3, 5, 1);
  const min = Math.min(...r.map(p => p.period_index));
  const max = Math.max(...r.map(p => p.period_index));
  assert(min === -3, `min=${min}`);
  assert(max === 59, `max=${max}`);
});
test('resolveProjectPeriods: pre-go-live flagged correctly', () => {
  const r = resolveProjectPeriods(seedPeriods(), new Date(2026, 0, 1), 3, 5, 1);
  const pre = r.filter(p => p.is_pre_go_live);
  assert(pre.length === 3);
  assert(pre.every(p => p.period_index < 0));
});
test('resolveProjectPeriods: calendar_year/month recomputed from project go-live', () => {
  const r = resolveProjectPeriods(seedPeriods(), new Date(2030, 6, 1), 0, 1, 1);
  assert(r[0].calendar_year === 2030, `yr=${r[0].calendar_year}`);
  assert(r[0].calendar_month === 7, `mo=${r[0].calendar_month}`);
  assert(r[11].calendar_year === 2031);
  assert(r[11].calendar_month === 6);
});
test('resolveProjectPeriods: customer FY shifts with start month', () => {
  const r = resolveProjectPeriods(seedPeriods(), new Date(2026, 0, 1), 0, 2, 4);
  assert(r[0].customer_fy_index >= 1);
  assert(r[12].customer_fy_index >= 2);
});

test('periodIdForIndex returns correct id', () => {
  const ps = [{ id: 10, period_index: -2 }, { id: 11, period_index: -1 }, { id: 12, period_index: 0 }];
  assert(periodIdForIndex(ps, 0) === 12);
  assert(periodIdForIndex(ps, -1) === 11);
  assert(periodIdForIndex(ps, 5) === null);
});

// ============================================================
// 2. RAMP CURVE
// ============================================================
test('rampFactorAtWeek: returns wk1 at week 1', () => {
  near(rampFactorAtWeek(MEDIUM_RAMP, 1), 0.48, 0.001);
});
test('rampFactorAtWeek: returns 1.0 at and after week 12', () => {
  near(rampFactorAtWeek(MEDIUM_RAMP, 12), 1.0, 0.001);
  near(rampFactorAtWeek(MEDIUM_RAMP, 24), 1.0, 0.001);
});
test('rampFactorAtWeek: linear between anchors (wk3 = 0.72)', () => {
  near(rampFactorAtWeek(MEDIUM_RAMP, 3), 0.72, 0.001);
});
test('rampFactorAtWeek: monotonically non-decreasing 1..12', () => {
  let prev = 0;
  for (let w = 1; w <= 12; w += 0.5) {
    const f = rampFactorAtWeek(MEDIUM_RAMP, w);
    assert(f >= prev - 1e-6, `at w=${w}, prev=${prev}, f=${f}`);
    prev = f;
  }
});
test('rampFactorForMonth: month 1 < month 3 ≤ month 6', () => {
  const m1 = rampFactorForMonth(MEDIUM_RAMP, 1);
  const m3 = rampFactorForMonth(MEDIUM_RAMP, 3);
  const m6 = rampFactorForMonth(MEDIUM_RAMP, 6);
  assert(m1 < m3, `m1=${m1}, m3=${m3}`);
  assert(m3 <= m6 + 1e-9);
});
test('rampFactorForMonth: month 12+ fully ramped', () => {
  near(rampFactorForMonth(MEDIUM_RAMP, 12), 1.0, 0.001);
  near(rampFactorForMonth(MEDIUM_RAMP, 24), 1.0, 0.001);
});

// ============================================================
// 3. SEASONALITY
// ============================================================
test('seasonalizedVolume flat = annual/12', () => {
  for (let m = 1; m <= 12; m++) near(seasonalizedVolume(1200, FLAT, m), 100, 0.01);
});
test('seasonalizedVolume peak Q4 > 2× Q1', () => {
  const q4 = [10,11,12].reduce((s,m) => s + seasonalizedVolume(1000, PEAK, m), 0);
  const q1 = [1,2,3].reduce((s,m) => s + seasonalizedVolume(1000, PEAK, m), 0);
  assert(q4 > q1 * 2, `q4=${q4}, q1=${q1}`);
});
test('seasonalizedVolume sums to annual', () => {
  let sum = 0;
  for (let m = 1; m <= 12; m++) sum += seasonalizedVolume(1000, PEAK, m);
  near(sum, 1000, 0.5);
});
test('validateSeasonality flat OK', () => assert(validateSeasonality(FLAT).valid));
test('validateSeasonality peaked OK', () => assert(validateSeasonality(PEAK).valid));
test('validateSeasonality flags wrong sum', () => {
  const r = validateSeasonality({ monthly_shares: Array(12).fill(0.1) });
  assert(!r.valid);
  near(r.sum, 1.2, 0.001);
});
test('validateSeasonality flags wrong length', () => {
  assert(!validateSeasonality({ monthly_shares: Array(10).fill(0.1) }).valid);
});

// ============================================================
// 4. MONTHLY → YEARLY RECONCILIATION
// ============================================================
test('monthly revenue × 12 ≈ annual revenue ± 0.5%', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  const yr1MonthlyRev = bundle.cashflow.filter(cf => {
    const p = bundle.periods.find(x => x.id === cf.period_id);
    return p && p.period_index >= 0 && p.period_index < 12;
  }).reduce((s, cf) => s + cf.revenue, 0);
  const yr1AnnualRev = yearly[0].revenue;
  const diff = Math.abs(yr1MonthlyRev - yr1AnnualRev) / Math.max(1, yr1AnnualRev);
  assert(diff < 0.005, `diff=${(diff*100).toFixed(3)}%`);
});
test('monthly opex × 12 ≈ annual opex ± 0.5% (per year)', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  for (let yr = 1; yr <= params.contract_term_years; yr++) {
    const monthlyOpex = bundle.cashflow.filter(cf => {
      const p = bundle.periods.find(x => x.id === cf.period_id);
      return p && p.period_index >= (yr - 1) * 12 && p.period_index < yr * 12;
    }).reduce((s, cf) => s + cf.opex, 0);
    const diff = Math.abs(monthlyOpex - yearly[yr - 1].totalCost) / Math.max(1, yearly[yr - 1].totalCost);
    assert(diff < 0.005, `yr ${yr}: diff=${(diff*100).toFixed(3)}%`);
  }
});

// ============================================================
// 5. PRE-GO-LIVE EXPENSE RECOGNITION
// ============================================================
test('pre-go-live: zero revenue', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const pre = bundle.cashflow.filter(cf => {
    const p = bundle.periods.find(x => x.id === cf.period_id);
    return p && p.is_pre_go_live;
  });
  assert(pre.length === 3);
  for (const cf of pre) assert(cf.revenue === 0, `rev=${cf.revenue}`);
});
test('pre-go-live: positive opex (implementation expenses flow)', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const totalPreOpex = bundle.cashflow.filter(cf => {
    const p = bundle.periods.find(x => x.id === cf.period_id);
    return p && p.is_pre_go_live;
  }).reduce((s, cf) => s + cf.opex, 0);
  assert(totalPreOpex > 0, `totalPreOpex=${totalPreOpex}`);
});
test('pre-go-live: zero labor (workforce not yet onboarded)', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const preLabor = bundle.expense
    .filter(e => e.expense_line_code === 'LABOR_HOURLY' || e.expense_line_code === 'LABOR_SALARY')
    .filter(e => {
      const p = bundle.periods.find(x => x.id === e.period_id);
      return p && p.is_pre_go_live;
    })
    .reduce((s, e) => s + e.amount, 0);
  assert(preLabor === 0, `preLabor=${preLabor}`);
});

// ============================================================
// 6. WORKING CAPITAL
// ============================================================
test('delta_ar in period 0 ≈ DSO/30 × period-0 revenue', () => {
  const params = baseParams({ dso_days: 30 });
  const bundle = buildMonthlyProjections(params);
  const m0 = bundle.cashflow.find(cf => {
    const p = bundle.periods.find(x => x.id === cf.period_id);
    return p && p.period_index === 0;
  });
  // Should be revenue × dso/30 = revenue (when dso=30)
  near(m0.delta_ar, m0.revenue * 30 / 30, m0.revenue * 0.01, 'delta_ar≠rev');
});
test('delta_ap > 0 in ramp month (expenses growing)', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const ramp = bundle.cashflow.find(cf => {
    const p = bundle.periods.find(x => x.id === cf.period_id);
    return p && p.period_index === 1;
  });
  assert(ramp.delta_ap > 0, `delta_ap=${ramp.delta_ap}`);
});

// ============================================================
// 7. PAYBACK
// ============================================================
test('cumulative_cash_flow eventually positive', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const idx = bundle.cashflow.findIndex(cf => cf.cumulative_cash_flow >= 0);
  assert(idx > 0, `never paid back, last cum = ${bundle.cashflow[bundle.cashflow.length-1].cumulative_cash_flow}`);
});

// ============================================================
// 8. TAX
// ============================================================
test('tax uses project tax_rate_pct (21%)', () => {
  const params = baseParams({ tax_rate_pct: 21 });
  const bundle = buildMonthlyProjections(params);
  const pos = bundle.cashflow.find(cf => cf.ebit > 0);
  assert(pos, 'no positive ebit found');
  near(pos.taxes, pos.ebit * 0.21, 0.01, 'tax !=21%');
});
test('tax = 0 when ebit < 0', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  for (const cf of bundle.cashflow.filter(c => c.ebit < 0)) {
    assert(cf.taxes === 0, `taxes=${cf.taxes} for ebit=${cf.ebit}`);
  }
});

// ============================================================
// 9. END-TO-END
// ============================================================
test('e2e: realistic params produce plausible bundle', () => {
  const params = baseParams({
    pre_go_live_months: 3, contract_term_years: 5,
    seasonality: PEAK, vol_growth_pct: 0.08,
  });
  const bundle = buildMonthlyProjections(params);
  assert(bundle.periods.length === 63);
  assert(bundle.cashflow.length === 63);
  const ramp = bundle.cashflow.find(cf => bundle.periods.find(p => p.id === cf.period_id)?.period_index === 0);
  const steady = bundle.cashflow.find(cf => bundle.periods.find(p => p.id === cf.period_id)?.period_index === 24);
  assert(steady.revenue > ramp.revenue, `steady=${steady.revenue}, ramp=${ramp.revenue}`);
});
test('monthlyProjectionView returns ordered, complete view', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const view = monthlyProjectionView(bundle);
  assert(view.length === bundle.cashflow.length);
  for (let i = 1; i < view.length; i++) {
    assert(view[i].period_index > view[i-1].period_index);
  }
  for (const row of view) {
    assert(row.revenue_by_line, 'missing revenue_by_line');
    assert(row.expense_by_line, 'missing expense_by_line');
  }
});

// ============================================================
// 10. PER-CATEGORY ROLLUP (Multi-Year P&L Summary breakdown)
// ============================================================
// Regression: groupMonthlyToYearly used to hardcode
// labor/facility/equipment/overhead/vas/startup to 0, so the Summary
// Multi-Year P&L per-category rows rendered $0 when the monthly engine
// was enabled. The fix sums expense rows within each year window by
// expense_line_code into the matching category.
test('yearly rollup: labor > 0 when base_labor_cost > 0', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  for (const y of yearly) assert(y.labor > 0, `year ${y.year} labor=${y.labor}`);
});
test('yearly rollup: all 6 categories > 0 when their bases are set', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  for (const y of yearly) {
    assert(y.labor     > 0, `year ${y.year} labor`);
    assert(y.facility  > 0, `year ${y.year} facility`);
    assert(y.equipment > 0, `year ${y.year} equipment`);
    assert(y.overhead  > 0, `year ${y.year} overhead`);
    assert(y.vas       > 0, `year ${y.year} vas`);
    assert(y.startup   > 0, `year ${y.year} startup`);
  }
});
test('yearly rollup: labor + facility + equipment + overhead + vas + startup == totalCost (±0.5%)', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  for (const y of yearly) {
    const sumCategories = y.labor + y.facility + y.equipment + y.overhead + y.vas + y.startup;
    const drift = Math.abs(sumCategories - y.totalCost) / (y.totalCost || 1);
    assert(drift <= 0.005, `year ${y.year} categories=${sumCategories.toFixed(2)} totalCost=${y.totalCost.toFixed(2)} drift=${(drift*100).toFixed(3)}%`);
  }
});
test('yearly rollup: startup == annualized startup_amort (matches legacy yearly path)', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  for (const y of yearly) {
    near(y.startup, params.startup_amort, 0.01, `year ${y.year} startup should equal annual startup_amort:`);
  }
});
test('yearly rollup: labor escalates year over year (vol_growth + labor_esc)', () => {
  const params = baseParams({ vol_growth_pct: 0.05, labor_esc_pct: 0.04 });
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  // Year 1 has a partial ramp so we skip it; Y2 > Y2 was blocked by ramp.
  for (let i = 2; i < yearly.length; i++) {
    assert(yearly[i].labor > yearly[i-1].labor,
      `Y${yearly[i].year} labor=${yearly[i].labor} should be > Y${yearly[i-1].year} labor=${yearly[i-1].labor}`);
  }
});
test('yearly rollup: zero-cost inputs produce zero category rows (no phantom values)', () => {
  const params = baseParams({
    base_labor_cost: 0, base_facility_cost: 0, base_equipment_cost: 0,
    base_overhead_cost: 0, base_vas_cost: 0, startup_amort: 0,
  });
  const bundle = buildMonthlyProjections(params);
  const yearly = groupMonthlyToYearly(bundle, params.contract_term_years);
  for (const y of yearly) {
    assert(y.labor === 0 && y.facility === 0 && y.equipment === 0 &&
      y.overhead === 0 && y.vas === 0 && y.startup === 0,
      `year ${y.year} expected all-zero categories, got ${JSON.stringify({labor:y.labor,facility:y.facility,equipment:y.equipment,overhead:y.overhead,vas:y.vas,startup:y.startup})}`);
  }
});

// ---- Run + report ----
console.log(`\n\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
console.log('All acceptance criteria pass ✓');

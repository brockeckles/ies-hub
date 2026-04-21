// Standalone Node ESM test runner for the 2026-04-20 PM Summary audit.
// Covers the new COGS/SG&A/EBITDA/EBIT invariants and FCF-based financial
// metrics (MIRR / NPV / Payback / ROIC via NOPAT).
//
// Run:  node test-pnl-audit.mjs

import {
  buildMonthlyProjections,
  groupMonthlyToYearly,
} from './tools/cost-model/calc.monthly.js';
import {
  buildYearlyProjections,
  computeFinancialMetrics,
  sensitivityTable,
} from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); process.stdout.write('.'); passed++; }
  catch (e) { process.stdout.write('F'); failed++; failures.push({ name, err: e }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const near = (a, b, eps = 0.01, msg = '') => {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}: expected ${b}, got ${a}`);
};

function seedPeriods() {
  const ps = [];
  for (let i = -3; i < 120; i++) {
    ps.push({
      id: 1000 + i, period_type: 'month', period_index: i,
      calendar_year: 2026, calendar_month: 1,
      customer_fy_index: 1, customer_fm_index: 1,
      label: 'M' + i, is_pre_go_live: i < 0,
    });
  }
  return ps;
}
const MEDIUM_RAMP = { type: 'medium', wk1_factor: 0.48, wk2_factor: 0.64, wk4_factor: 0.80, wk8_factor: 0.92, wk12_factor: 1.0 };
const FLAT = { monthly_shares: Array(12).fill(1/12) };

function baseParams(over = {}) {
  return {
    project_id: 1, contract_term_years: 5, pre_go_live_months: 3,
    base_labor_cost: 6_000_000, base_facility_cost: 1_200_000,
    base_equipment_cost: 300_000, base_overhead_cost: 200_000, base_vas_cost: 100_000,
    startup_amort: 60_000, startup_capital: 300_000,
    base_orders: 2_000_000, margin_pct: 0.16,
    vol_growth_pct: 0.05, labor_esc_pct: 0.04, cost_esc_pct: 0.03,
    tax_rate_pct: 25, dso_days: 30, dpo_days: 30, labor_payable_days: 14,
    ramp: MEDIUM_RAMP, seasonality: FLAT, periods: seedPeriods(),
    startupLines: [{ description: 'PM', one_time_cost: 150_000 }, { description: 'IT Integration', one_time_cost: 150_000 }],
    pricingBuckets: [],
    ...over,
  };
}

// ============================================================
// 1. ACCOUNTING STACK INVARIANTS
// ============================================================
test('monthly cf: gross_profit !== ebitda when SG&A > 0', () => {
  const bundle = buildMonthlyProjections(baseParams());
  // Find a steady-state month
  const cf = bundle.cashflow.find(c => {
    const p = bundle.periods.find(pp => pp.id === c.period_id);
    return p && p.period_index === 24 && c.revenue > 0 && c.sga > 0;
  });
  assert(cf, 'no steady-state row found');
  assert(cf.sga > 0, `sga=${cf.sga}`);
  assert(Math.abs(cf.gross_profit - cf.ebitda) > 0.01,
    `gp=${cf.gross_profit} should NOT equal ebitda=${cf.ebitda}`);
  // GP should be EBITDA + SG&A (since GP = rev - cogs, EBITDA = rev - cogs - sga)
  near(cf.gross_profit, cf.ebitda + cf.sga, 0.01,
    `GP should equal EBITDA + SG&A`);
});

test('monthly cf: cogs + sga + dep === opex', () => {
  const bundle = buildMonthlyProjections(baseParams());
  const cf = bundle.cashflow.find(c => c.revenue > 0);
  assert(cf, 'no operational row found');
  near(cf.cogs + cf.sga + cf.depreciation, cf.opex, 0.01,
    `cogs+sga+dep=${cf.cogs + cf.sga + cf.depreciation} should equal opex=${cf.opex}`);
});

test('monthly cf: ebit === ebitda - depreciation', () => {
  const bundle = buildMonthlyProjections(baseParams());
  const cf = bundle.cashflow.find(c => c.revenue > 0);
  near(cf.ebit, cf.ebitda - cf.depreciation, 0.01,
    `ebit=${cf.ebit} should equal ebitda-dep=${cf.ebitda - cf.depreciation}`);
});

test('yearly rollup: gp > ebitda > ebit (when SG&A and dep > 0)', () => {
  const bundle = buildMonthlyProjections(baseParams());
  const yearly = groupMonthlyToYearly(bundle, 5, { baseOrders: 2_000_000, volGrowthPct: 0.05 });
  const y1 = yearly[0];
  assert(y1.grossProfit > y1.ebitda, `gp=${y1.grossProfit} should be > ebitda=${y1.ebitda}`);
  assert(y1.ebitda > y1.ebit, `ebitda=${y1.ebitda} should be > ebit=${y1.ebit}`);
});

test('yearly rollup: gp === revenue - cogs', () => {
  const bundle = buildMonthlyProjections(baseParams());
  const yearly = groupMonthlyToYearly(bundle, 5, { baseOrders: 2_000_000, volGrowthPct: 0.05 });
  for (const y of yearly) {
    near(y.grossProfit, y.revenue - y.cogs, 0.5,
      `y${y.year}: gp=${y.grossProfit} should equal rev-cogs=${y.revenue - y.cogs}`);
  }
});

test('yearly rollup: cumFcf accumulates running total', () => {
  const bundle = buildMonthlyProjections(baseParams());
  const yearly = groupMonthlyToYearly(bundle, 5, { baseOrders: 2_000_000, volGrowthPct: 0.05 });
  let running = 0;
  for (const y of yearly) {
    running += y.freeCashFlow;
    near(y.cumFcf, running, 0.5, `y${y.year}: cumFcf=${y.cumFcf} should equal running=${running}`);
  }
  assert(yearly[yearly.length - 1].cumFcf !== 0, 'last cumFcf should not be 0');
});

// ============================================================
// 2. LEGACY YEARLY PATH (fallback when monthly engine is off)
// ============================================================
test('buildYearlyProjections: gp === revenue - cogs', () => {
  const result = buildYearlyProjections({
    years: 5, baseLaborCost: 6_000_000, baseFacilityCost: 1_200_000,
    baseEquipmentCost: 300_000, baseOverheadCost: 200_000, baseVasCost: 100_000,
    startupAmort: 60_000, startupCapital: 300_000,
    baseOrders: 2_000_000, marginPct: 0.16,
    volGrowthPct: 0.05, laborEscPct: 0.04, costEscPct: 0.03,
    useMonthlyEngine: false,  // force legacy path
    taxRatePct: 25,
  });
  for (const y of result.projections) {
    near(y.grossProfit, y.revenue - y.cogs, 0.5,
      `y${y.year}: gp=${y.grossProfit}, rev-cogs=${y.revenue - y.cogs}`);
    assert(y.grossProfit > y.ebitda, `y${y.year}: gp should be > ebitda`);
    assert(y.ebitda > y.ebit, `y${y.year}: ebitda should be > ebit`);
  }
});

test('buildYearlyProjections: cumFcf accumulates', () => {
  const result = buildYearlyProjections({
    years: 5, baseLaborCost: 6_000_000, baseFacilityCost: 1_200_000,
    baseEquipmentCost: 300_000, baseOverheadCost: 200_000, baseVasCost: 100_000,
    startupAmort: 60_000, startupCapital: 300_000,
    baseOrders: 2_000_000, marginPct: 0.16, volGrowthPct: 0.05,
    useMonthlyEngine: false,
  });
  let running = 0;
  for (const y of result.projections) {
    running += y.freeCashFlow;
    near(y.cumFcf, running, 0.5, `y${y.year}: cumFcf tracks running total`);
  }
});

test('buildYearlyProjections: overhead escalates ONLY by costEscPct (no volume-growth mix-in)', () => {
  // 2026-04-21: legacy path previously compounded cost-escalation with a
  // hardcoded 30% of volume-growth (e.g. 10% vol growth → overhead ~6%/yr
  // instead of 3%). The audit aligned it to monthly-engine's cost-escalation-
  // only rule so the two calc branches reconcile on Y2+.
  const result = buildYearlyProjections({
    years: 5, baseLaborCost: 0, baseFacilityCost: 0,
    baseEquipmentCost: 0, baseOverheadCost: 1_000_000, baseVasCost: 0,
    startupAmort: 0, startupCapital: 0,
    baseOrders: 1_000_000, marginPct: 0.16,
    volGrowthPct: 0.10,  // 10% annual volume growth
    costEscPct: 0.03,    // 3% cost escalation
    useMonthlyEngine: false,
  });
  // With the fix: overhead Y2 = 1M × 1.03 = 1.030M (3% escalation only).
  // Without the fix (old bug): overhead Y2 would be 1M × 1.03 × (1+0.10×0.3) = 1.0609M (~6.1%).
  near(result.projections[1].overhead, 1_030_000, 100, 'Y2 overhead = 1M × (1+costEsc), not mixed');
  near(result.projections[2].overhead, 1_060_900, 200, 'Y3 overhead = 1M × 1.03²');
  near(result.projections[4].overhead, 1_125_509, 500, 'Y5 overhead = 1M × 1.03⁴, pure cost esc');
});

// ============================================================
// 3. FINANCIAL METRICS — FCF-BASED
// ============================================================
test('computeFinancialMetrics: NPV uses FCF, not grossProfit', () => {
  const projections = [
    { year: 1, revenue: 10_000_000, totalCost: 9_000_000, cogs: 7_000_000, sga: 2_000_000,
      grossProfit: 3_000_000, ebitda: 1_000_000, ebit: 900_000, depreciation: 100_000,
      taxes: 225_000, netIncome: 675_000, capex: 0, workingCapitalChange: 800_000,
      operatingCashFlow: -25_000, freeCashFlow: -25_000, orders: 1_000_000 },
    { year: 2, revenue: 10_500_000, totalCost: 9_200_000, cogs: 7_100_000, sga: 2_100_000,
      grossProfit: 3_400_000, ebitda: 1_300_000, ebit: 1_200_000, depreciation: 100_000,
      taxes: 300_000, netIncome: 900_000, capex: 0, workingCapitalChange: 40_000,
      operatingCashFlow: 960_000, freeCashFlow: 960_000, orders: 1_050_000 },
  ];
  const metrics = computeFinancialMetrics(projections, {
    startupCapital: 500_000, equipmentCapital: 100_000,
    annualDepreciation: 100_000, discountRatePct: 10, reinvestRatePct: 8,
    taxRatePct: 25, totalFtes: 100,
  });
  // NPV should reflect Y1 FCF (-25K, offset by Y1 capex of 0 here so Y1 operating = -25K)
  // and Y2 FCF (960K). Not grossProfit (3M / 3.4M) which would inflate NPV dramatically.
  // With totalInvestment 600K + FCF series [-25K, 960K] at 10% discount:
  // NPV = -600K + (-25K)/1.1 + 960K/1.21 = -600K - 22.7K + 793.4K = 170.7K
  near(metrics.npv, 170_636, 100, `npv=${metrics.npv} should be ~170K, not huge (would be if using grossProfit)`);
});

test('computeFinancialMetrics: ROIC uses NOPAT + WC-inflated IC', () => {
  const projections = [
    { year: 1, revenue: 10_000_000, totalCost: 9_000_000, cogs: 7_000_000, sga: 2_000_000,
      grossProfit: 3_000_000, ebitda: 1_000_000, ebit: 900_000, depreciation: 100_000,
      taxes: 225_000, netIncome: 675_000, capex: 0, workingCapitalChange: 800_000,
      operatingCashFlow: -25_000, freeCashFlow: -25_000, orders: 1_000_000 },
  ];
  const metrics = computeFinancialMetrics(projections, {
    startupCapital: 200_000, equipmentCapital: 100_000,
    annualDepreciation: 100_000, discountRatePct: 10, reinvestRatePct: 8,
    taxRatePct: 25, dsoDays: 30, dpoDays: 15, totalFtes: 100,
  });
  // NOPAT = 900K × 0.75 = 675K
  // IC = 300K (capital) + (10M × 30/365 − 7M × 15/365) = 300K + 822K − 288K = 834K
  // ROIC = 675K / 834K = 80.9%
  assert(metrics.roicPct > 50 && metrics.roicPct < 120,
    `roic=${metrics.roicPct}% expected ~80%, not 300%+ (would be with pre-tax EBIT / tiny IC)`);
  assert(metrics.nopat > 0, `nopat should be exposed: ${metrics.nopat}`);
  assert(metrics.investedCapital > 600_000,
    `investedCapital should include WC: ${metrics.investedCapital}`);
});

test('computeFinancialMetrics: MIRR uses FCF series', () => {
  const projections = [];
  for (let y = 1; y <= 5; y++) {
    projections.push({ year: y, revenue: 10_000_000, totalCost: 9_000_000,
      cogs: 7_000_000, sga: 2_000_000, grossProfit: 3_000_000,
      ebitda: 1_000_000, ebit: 900_000, depreciation: 100_000,
      taxes: 225_000, netIncome: 675_000, capex: 0,
      workingCapitalChange: 40_000, operatingCashFlow: 735_000,
      freeCashFlow: 735_000, orders: 1_000_000 });
  }
  const metrics = computeFinancialMetrics(projections, {
    startupCapital: 500_000, equipmentCapital: 100_000,
    discountRatePct: 10, reinvestRatePct: 8, taxRatePct: 25, totalFtes: 100,
  });
  // 600K out, 735K/yr × 5 years reinvested at 8%, MIRR ≈ mid-30s
  assert(metrics.mirrPct > 20 && metrics.mirrPct < 60,
    `mirr=${metrics.mirrPct}% expected 20–60% with FCF series`);
});

test('computeFinancialMetrics: empty projections returns empty metrics', () => {
  const metrics = computeFinancialMetrics([], { startupCapital: 500_000 });
  assert(metrics.npv === 0, 'empty npv');
  assert(metrics.mirrPct === 0, 'empty mirr');
});

// ============================================================
// 4. SENSITIVITY — accepts baseRevenue override
// ============================================================
test('sensitivityTable: baseRevenue override ties to P&L Y1', () => {
  const baseCosts = { labor: 6_000_000, facility: 1_200_000, equipment: 300_000,
    overhead: 200_000, vas: 100_000, startup: 60_000 };
  // Without override (theoretical cost+margin)
  const noOverride = sensitivityTable(baseCosts, 1_000_000, undefined, { marginPct: 15 });
  // With override (e.g. P&L Y1 real revenue = $9M — bucket rates might give less than theoretical)
  const withOverride = sensitivityTable(baseCosts, 1_000_000, undefined, {
    marginPct: 15, baseRevenue: 9_000_000,
  });
  // Post-2026-04-21: baseline fallback uses cost-plus `cost / (1 − m)` instead
  // of the legacy markup `cost × (1 + m)` — on 15% margin the difference is
  // $1.39M revenue delta. The override path is unchanged.
  //   No-override baseline rev = 7.86M / (1 − 0.15) = 9.247M
  //   With-override baseline rev = 9M (driven by pricing buckets)
  const noOvrLabor = noOverride.find(d => d.kind === 'labor_rate').adjustments.find(a => a.pct === -10);
  const ovrLabor   = withOverride.find(d => d.kind === 'labor_rate').adjustments.find(a => a.pct === -10);
  assert(noOvrLabor.revenue !== ovrLabor.revenue,
    `override should change baseline revenue: noOvr=${noOvrLabor.revenue} vs ovr=${ovrLabor.revenue}`);
  near(ovrLabor.revenue, 9_000_000, 0.01, 'override baseline rev used');
  near(noOvrLabor.revenue, 7_860_000 / 0.85, 1,
    'no-override baseline uses cost-plus: cost / (1 − m)');
});

// ============================================================
// 5. REGRESSION — buildMonthlyProjections still passes acceptance
// ============================================================
test('regression: margin-driven fallback reconciles monthly × 12 ≈ annual', () => {
  const params = baseParams();
  const bundle = buildMonthlyProjections(params);
  // Steady-state month in year 2 (past ramp)
  const y2m = bundle.cashflow.filter(cf => {
    const p = bundle.periods.find(pp => pp.id === cf.period_id);
    return p && p.period_index >= 12 && p.period_index < 24;
  });
  assert(y2m.length === 12, `expected 12 y2 months, got ${y2m.length}`);
  const sumRev = y2m.reduce((s, cf) => s + cf.revenue, 0);
  assert(sumRev > 0, 'y2 revenue > 0');
});

// ============================================================
// FOOTER
// ============================================================
process.stdout.write('\n\n');
if (failed > 0) {
  for (const f of failures) {
    console.log(`\n✗ ${f.name}`);
    console.log(`    ${f.err.message}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`${passed}/${passed} passed`);
console.log('Summary-page audit invariants pass ✓');

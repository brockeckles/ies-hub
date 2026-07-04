// test-cm-ebitda-reclass.mjs — EBITDA reclass invariants (2026-07-04)
//
// The reclass moves capital-equipment amortization from COGS (folded into
// LEASED_EQUIP via base_equipment_cost since 2026-06-10) to D&A via the new
// EQUIP_DEPR expense line. The hard contract, in BOTH engines:
//
//   vs the old folded treatment (amort inside base_equipment_cost):
//     revenue, opex/totalCost, EBIT, taxes, net income,
//     OCF, FCF, cum FCF ................................. BYTE-IDENTICAL
//     gross profit, EBITDA .............................. UP by equip depr
//     D&A ............................................... UP by equip depr
//
//   plus: Σ(7 P&L categories incl. equipmentDepr) === totalCost (opex
//   reconciliation), and the cash add-back excludes EQUIP_DEPR (equipment
//   cash is modeled as amortized outflow per the R5 convention — adding it
//   back to OCF would fabricate cash).
//
// Run:  node test-cm-ebitda-reclass.mjs

import {
  buildMonthlyProjections,
  groupMonthlyToYearly,
} from './tools/cost-model/calc.monthly.js';
import { buildYearlyProjections } from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function near(actual, expected, tol = 0.01, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg} expected ~${expected}, got ${actual}`);
}

// ---- Fixtures (mirror test-monthly.mjs conventions) ----
const MEDIUM_RAMP = { type: 'medium', wk1_factor: 0.48, wk2_factor: 0.64, wk4_factor: 0.80, wk8_factor: 0.92, wk12_factor: 0.98 };
const FLAT = { monthly_shares: Array(12).fill(1 / 12) };

function seedPeriods() {
  const ps = [];
  for (let i = -12; i <= 71; i++) {
    const goLive = new Date(2026, 0, 1);
    const d = new Date(goLive.getFullYear(), goLive.getMonth() + i, 1);
    ps.push({
      id: i + 13, period_type: 'month', period_index: i,
      calendar_year: d.getFullYear(), calendar_month: d.getMonth() + 1,
      customer_fy_index: Math.max(0, Math.floor(i / 12) + 1),
      customer_fm_index: ((i % 12) + 12) % 12 + 1,
      label: i < 0 ? `M${i}` : `M${i + 1}`, is_pre_go_live: i < 0,
    });
  }
  return ps;
}

const AMORT = 84_000; // annual equipment capital amortization

function monthlyParams(over = {}) {
  return {
    project_id: 1, contract_term_years: 5, pre_go_live_months: 3,
    base_labor_cost: 6_000_000, base_facility_cost: 1_200_000,
    base_equipment_cost: 300_000, base_overhead_cost: 200_000, base_vas_cost: 100_000,
    equipment_amort_annual: AMORT,
    startup_amort: 60_000, startup_capital: 300_000,
    base_orders: 2_000_000, margin_pct: 0.16,
    vol_growth_pct: 0.05, labor_esc_pct: 0.04, cost_esc_pct: 0.03,
    equipment_esc_pct: 0.02, // distinct from cost esc — pins the multiplier
    tax_rate_pct: 25, dso_days: 30, dpo_days: 30, labor_payable_days: 14,
    ramp: MEDIUM_RAMP, seasonality: FLAT, periods: seedPeriods(),
    startupLines: [{ description: 'PM', one_time_cost: 150_000 }],
    pricingBuckets: [],
    ...over,
  };
}

// The old folded treatment, for the equivalence contract: amort inside
// base_equipment_cost, no EQUIP_DEPR param.
function foldedParams() {
  return monthlyParams({
    base_equipment_cost: 300_000 + AMORT,
    equipment_amort_annual: 0,
  });
}

const split  = buildMonthlyProjections(monthlyParams());
const folded = buildMonthlyProjections(foldedParams());

// ---- Monthly engine: EQUIP_DEPR emission ----

t('monthly: EQUIP_DEPR rows emitted, Y1 sum = amort (esc^0)', () => {
  const y1 = split.expense.filter(e => e.expense_line_code === 'EQUIP_DEPR'
    && e.period_id >= 13 && e.period_id <= 24); // period_index 0..11
  assert(y1.length === 12, `expected 12 Y1 EQUIP_DEPR rows, got ${y1.length}`);
  near(y1.reduce((s, r) => s + r.amount, 0), AMORT, 0.5, 'Y1 EQUIP_DEPR total');
});

t('monthly: EQUIP_DEPR escalates with the equipment multiplier (Y3 = amort × 1.02²)', () => {
  const y3 = split.expense.filter(e => e.expense_line_code === 'EQUIP_DEPR'
    && e.period_id >= 37 && e.period_id <= 48); // period_index 24..35
  near(y3.reduce((s, r) => s + r.amount, 0), AMORT * 1.02 ** 2, 0.5, 'Y3 EQUIP_DEPR total');
});

t('monthly: LEASED_EQUIP no longer carries the amort (Y1 = 300K exactly)', () => {
  const y1 = split.expense.filter(e => e.expense_line_code === 'LEASED_EQUIP'
    && e.period_id >= 13 && e.period_id <= 24);
  near(y1.reduce((s, r) => s + r.amount, 0), 300_000, 0.5, 'Y1 LEASED_EQUIP total');
});

// ---- Monthly engine: split vs folded equivalence contract ----

t('monthly: revenue / opex / EBIT / NI / OCF / FCF byte-identical to folded treatment', () => {
  assert(split.cashflow.length === folded.cashflow.length, 'row count');
  for (let i = 0; i < split.cashflow.length; i++) {
    const a = split.cashflow[i], b = folded.cashflow[i];
    for (const k of ['revenue', 'opex', 'ebit', 'taxes', 'net_income',
                     'operating_cash_flow', 'free_cash_flow', 'cumulative_cash_flow']) {
      near(a[k], b[k], 0.01, `cashflow[${i}].${k}`);
    }
  }
});

t('monthly: EBITDA and gross profit rise by exactly the equip-depr slice; D&A absorbs it', () => {
  for (let i = 0; i < split.cashflow.length; i++) {
    const a = split.cashflow[i], b = folded.cashflow[i];
    const slice = a.depreciation - b.depreciation; // equip depr in this period
    assert(slice >= -0.01, `depreciation must not shrink (row ${i})`);
    near(a.ebitda - b.ebitda, slice, 0.01, `ebitda delta row ${i}`);
    near(a.gross_profit - b.gross_profit, slice, 0.01, `GP delta row ${i}`);
    near(a.ebitda - a.depreciation, a.ebit, 0.01, `stack: EBITDA − D&A = EBIT row ${i}`);
  }
});

t('monthly: cash add-back excludes EQUIP_DEPR (OCF = NI + startup dep − ΔWC)', () => {
  const ops = split.cashflow.filter((cf, i) => {
    const p = seedPeriods().find(x => x.id === cf.period_id);
    return p && !p.is_pre_go_live;
  });
  assert(ops.length > 0, 'need operational rows');
  const startupMonthly = 60_000 / 12;
  for (const cf of ops) {
    near(cf.operating_cash_flow,
         cf.net_income + startupMonthly - cf.working_capital_change, 0.01,
         'OCF must add back startup dep only');
  }
});

// ---- groupMonthlyToYearly: 7-category ↔ opex reconciliation ----

t('yearly rollup: Σ(labor+facility+equipment+equipmentDepr+overhead+vas+startup) = totalCost', () => {
  const years = groupMonthlyToYearly(split, 5, { baseOrders: 2_000_000, volGrowthPct: 0.05 });
  assert(years.length === 5, '5 years');
  for (const y of years) {
    const catSum = y.labor + y.facility + y.equipment + y.equipmentDepr
                 + y.overhead + y.vas + y.startup;
    near(catSum, y.totalCost, 0.5, `Y${y.year} category sum vs opex`);
    assert(y.equipmentDepr > 0, `Y${y.year} equipmentDepr must be > 0 on this fixture`);
    near(y.depreciation, y.startup + y.equipmentDepr, 0.5, `Y${y.year} D&A = startup + equip depr`);
    near(y.ebitda - y.depreciation, y.ebit, 0.5, `Y${y.year} stack`);
  }
});

// ---- Legacy yearly engine (monthly flag off) ----

function yearlyParams(over = {}) {
  return {
    years: 5,
    baseLaborCost: 6_000_000, baseFacilityCost: 1_200_000,
    baseEquipmentCost: 300_000, equipmentAmort: AMORT,
    baseOverheadCost: 200_000, baseVasCost: 100_000,
    startupAmort: 60_000, startupCapital: 300_000,
    baseOrders: 2_000_000, marginPct: 0.16,
    volGrowthPct: 0.05, laborEscPct: 0.04, costEscPct: 0.03,
    equipmentEscPct: 0.02, taxRatePct: 25,
    useMonthlyEngine: false, periods: [],
    ...over,
  };
}

t('legacy yearly: same equivalence contract vs folded treatment', () => {
  const a = buildYearlyProjections(yearlyParams()).projections;
  const b = buildYearlyProjections(yearlyParams({
    baseEquipmentCost: 300_000 + AMORT, equipmentAmort: 0,
  })).projections;
  for (let i = 0; i < a.length; i++) {
    for (const k of ['revenue', 'totalCost', 'ebit', 'taxes', 'netIncome',
                     'operatingCashFlow', 'freeCashFlow', 'cumFcf']) {
      near(a[i][k], b[i][k], 0.01, `Y${i + 1}.${k}`);
    }
    const slice = a[i].equipmentDepr;
    near(slice, AMORT * 1.02 ** i, 0.01, `Y${i + 1} equipmentDepr escalation`);
    near(a[i].ebitda - b[i].ebitda, slice, 0.01, `Y${i + 1} EBITDA delta`);
    near(a[i].grossProfit - b[i].grossProfit, slice, 0.01, `Y${i + 1} GP delta`);
    near(a[i].depreciation, 60_000 + slice, 0.01, `Y${i + 1} D&A composition`);
    near(a[i].ebitda - a[i].depreciation, a[i].ebit, 0.01, `Y${i + 1} stack`);
    const catSum = a[i].labor + a[i].facility + a[i].equipment + a[i].equipmentDepr
                 + a[i].overhead + a[i].vas + a[i].startup;
    near(catSum, a[i].totalCost, 0.01, `Y${i + 1} category sum vs totalCost`);
  }
});

t('legacy yearly: cash add-back excludes equipmentDepr', () => {
  const a = buildYearlyProjections(yearlyParams()).projections;
  for (const y of a) {
    near(y.operatingCashFlow, y.netIncome + 60_000 - y.workingCapitalChange, 0.01,
         `Y${y.year} OCF adds back startup amort only`);
  }
});

t('legacy yearly: amort omitted entirely → EQUIP_DEPR-free, zero equipmentDepr', () => {
  const a = buildYearlyProjections(yearlyParams({ equipmentAmort: 0 })).projections;
  for (const y of a) near(y.equipmentDepr, 0, 1e-9, `Y${y.year}`);
});

// ---- Report ----
console.log(`\ntest-cm-ebitda-reclass: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }

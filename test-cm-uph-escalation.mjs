// test-cm-uph-escalation.mjs — UPH productivity growth (escalation.uph_yoy,
// 2026-06-12). Brock's policy call: default 3%, adjustable per project.
//
// Labor cost year N = base × (1 + wage)^(N−1) / (1 + uph)^(N−1) in BOTH
// engines. Default flows: resolveCalcHeuristics 3% → buildProjectionParams
// fraction → engines. buildYearlyProjections' own param default stays 0 so
// direct legacy callers are unchanged.

import * as calc from './tools/cost-model/calc.js';
import { resolveCalcHeuristics, buildProjectionParams } from './tools/cost-model/calc.scenarios.js';

let passed = 0, failed = 0;
function eq(actual, expected, label, tol = 1e-9) {
  const denom = Math.max(Math.abs(expected), 1e-12);
  const ok = Math.abs(actual - expected) / denom < tol;
  if (ok) { passed++; } else { failed++; console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}

const base = {
  years: 3, baseLaborCost: 1000000, baseFacilityCost: 0, baseEquipmentCost: 0,
  baseOverheadCost: 0, baseVasCost: 0, startupAmort: 0, startupCapital: 0,
  baseOrders: 100000, marginPct: 0, laborLines: [], useMonthlyEngine: false,
};

// 1. Legacy default (no uphYoyPct) — unchanged behavior
const p0 = calc.buildYearlyProjections({ ...base, laborEscPct: 0.03 });
eq(p0.projections[1].labor, 1030000, 'no uph: Y2 labor = base × 1.03');
eq(p0.projections[2].labor, 1060900, 'no uph: Y3 labor = base × 1.03²');

// 2. 3% wage + 3% uph cancel — flat real labor cost
const p1 = calc.buildYearlyProjections({ ...base, laborEscPct: 0.03, uphYoyPct: 0.03 });
eq(p1.projections[1].labor, 1000000, 'wage 3% / uph 3%: Y2 labor flat');
eq(p1.projections[2].labor, 1000000, 'wage 3% / uph 3%: Y3 labor flat');

// 3. Partial offset: wage 4.5%, uph 3%
const p2 = calc.buildYearlyProjections({ ...base, laborEscPct: 0.045, uphYoyPct: 0.03 });
eq(p2.projections[2].labor, 1000000 * Math.pow(1.045 / 1.03, 2), 'wage 4.5% / uph 3%: Y3 net ratio');

// 4. Negative uph clamped to 0
const p3 = calc.buildYearlyProjections({ ...base, laborEscPct: 0.03, uphYoyPct: -0.5 });
eq(p3.projections[1].labor, 1030000, 'negative uph clamps to 0');

// 5. Monthly engine parity: same divisor in calc.monthly via adapter
const periods = Array.from({ length: 36 }, (_, i) => ({
  id: i + 1, period_index: i, period_type: 'month',
  calendar_month: (i % 12) + 1, is_pre_go_live: false,
}));
const ramp = { wk1_factor: 1, wk2_factor: 1, wk4_factor: 1, wk8_factor: 1, wk12_factor: 1 };
const season = { monthly_shares: Array(12).fill(1 / 12) };
const mp = calc.buildYearlyProjections({
  ...base, laborEscPct: 0.03, uphYoyPct: 0.03,
  useMonthlyEngine: true, periods, ramp, seasonality: season,
});
eq(mp.projections[1].labor, 1000000, 'monthly engine: wage 3% / uph 3% Y2 flat', 1e-6);
const mp2 = calc.buildYearlyProjections({
  ...base, laborEscPct: 0.045, uphYoyPct: 0.03,
  useMonthlyEngine: true, periods, ramp, seasonality: season,
});
eq(mp2.projections[2].labor, 1000000 * Math.pow(1.045 / 1.03, 2), 'monthly engine: partial offset Y3', 1e-6);

// 6. Cross-engine parity with uph active
eq(mp2.projections[2].labor,
   calc.buildYearlyProjections({ ...base, laborEscPct: 0.045, uphYoyPct: 0.03 }).projections[2].labor,
   'legacy and monthly engines agree with uph active', 1e-6);

// 7. resolveCalcHeuristics: default 3, override + transient win
const heurDefault = resolveCalcHeuristics(null, null, null, {}, null);
eq(heurDefault.uphYoyPct, 3, 'calcHeur default uphYoyPct = 3 (IES policy)');
eq(resolveCalcHeuristics(null, null, { uph_yoy_pct: 1.5 }, {}, null).uphYoyPct, 1.5, 'heuristic override wins');
eq(resolveCalcHeuristics(null, null, { uph_yoy_pct: 1.5 }, {}, { uph_yoy_pct: 0 }).uphYoyPct, 0, 'transient (What-If) wins over override');

// 8. buildProjectionParams converts to fraction
const params = buildProjectionParams({
  model: {}, summary: { laborCost: 1, facilityCost: 0, equipmentCost: 0, overheadCost: 0, vasCost: 0, startupAmort: 0, startupCapital: 0 },
  calcHeur: { ...heurDefault }, contractYears: 5, orders: 1, pricingBuckets: [],
});
eq(params.uphYoyPct, 0.03, 'buildProjectionParams: uphYoyPct = calcHeur/100');

console.log(`test-cm-uph-escalation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env node
// test-cm-learning-turnover.mjs — Phase 4f (2026-06-12): learning-curve
// factors via heuristics catalog + market-profile turnover in overhead gen.
//
// Run:  node test-cm-learning-turnover.mjs

import * as calc from './tools/cost-model/calc.js';
import { resolveCalcHeuristics } from './tools/cost-model/calc.scenarios.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function near(a, b, rel = 1e-12, m = '') {
  const d = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  if (Math.abs(a - b) / d > rel) throw new Error(`${m}: expected ${b}, got ${a}`);
}

// ── learning-curve heuristics ─────────────────────────────────────────
t('resolveCalcHeuristics: learning factors default 95/85/75', () => {
  const h = resolveCalcHeuristics(null, null, null, {}, null);
  assert(h.learningCurveY1LowPct === 95 && h.learningCurveY1MedPct === 85 && h.learningCurveY1HighPct === 75,
    `${h.learningCurveY1LowPct}/${h.learningCurveY1MedPct}/${h.learningCurveY1HighPct}`);
});
t('learningFactorsFromCalcHeur: null without keys, map with keys, clamps junk', () => {
  assert(calc.learningFactorsFromCalcHeur(null) === null, 'null calcHeur');
  assert(calc.learningFactorsFromCalcHeur({}) === null, 'no keys');
  const m = calc.learningFactorsFromCalcHeur({ learningCurveY1LowPct: 90, learningCurveY1MedPct: 80, learningCurveY1HighPct: 70 });
  near(m.low, 0.90); near(m.medium, 0.80); near(m.high, 0.70);
  const j = calc.learningFactorsFromCalcHeur({ learningCurveY1MedPct: 85, learningCurveY1HighPct: 250 });
  near(j.high, 0.75, 1e-12, 'junk >100 falls back');
});
t('computeYr1LearningFactor: custom factors override constants, defaults preserved', () => {
  const lines = [{ annual_hours: 2080, complexity_tier: 'medium' }];
  near(calc.computeYr1LearningFactor(lines), 0.85, 1e-12, 'default');
  near(calc.computeYr1LearningFactor(lines, { low: 0.95, medium: 0.80, high: 0.75 }), 0.80, 1e-12, 'override');
});
t('heuristic override flows through resolveCalcHeuristics → engine factor', () => {
  const h = resolveCalcHeuristics(null, null, { learning_curve_y1_med_pct: 80 }, {}, null);
  assert(h.learningCurveY1MedPct === 80, `override ${h.learningCurveY1MedPct}`);
  const f = calc.learningFactorsFromCalcHeur(h);
  near(f.medium, 0.80);
});
t('buildYearlyProjections: _calcHeur learning override moves Y1 labor (legacy)', () => {
  const common = {
    years: 2, baseLaborCost: 500_000, baseFacilityCost: 0, baseEquipmentCost: 0,
    baseOverheadCost: 0, baseVasCost: 0, startupAmort: 0, startupCapital: 0,
    baseOrders: 0, marginPct: 0.10, volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
    laborLines: [{ hourly_rate: 20, annual_hours: 2080, complexity_tier: 'medium' }],
  };
  const def = calc.buildYearlyProjections({ ...common }).projections;
  near(def[0].labor / def[1].labor, 1 / 0.85, 1e-9, 'default 0.85');
  const h = resolveCalcHeuristics(null, null, { learning_curve_y1_med_pct: 70 }, {}, null);
  const ovr = calc.buildYearlyProjections({ ...common, _calcHeur: h }).projections;
  near(ovr[0].labor / ovr[1].labor, 1 / 0.70, 1e-9, 'override 0.70');
});

// ── market-profile turnover in overhead generation ────────────────────
const OH_STATE = {
  shifts: {},
  laborLines: [],
  indirectLaborLines: [{ headcount: 100 }],
  facility: { totalSqft: 100000 },
};
function hrLine(lines) {
  const l = lines.find(x => x.category === 'HR & Recruiting');
  if (!l) throw new Error('HR & Recruiting line missing');
  return l;
}
t('autoGenerateOverhead: default turnover 43% preserved (no profile)', () => {
  const hr = hrLine(calc.autoGenerateOverhead(OH_STATE));
  near(hr.annual_cost ?? hr.annualCost ?? hr.cost, (100 * 2500) + (Math.ceil(100 * 0.43) * 4700), 1e-9, 'HR cost @43%');
});
t('autoGenerateOverhead: market profile turnover_pct_annual drives hires', () => {
  const hr = hrLine(calc.autoGenerateOverhead({ ...OH_STATE, marketLaborProfile: { turnover_pct_annual: 50 } }));
  near(hr.annual_cost ?? hr.annualCost ?? hr.cost, (100 * 2500) + (50 * 4700), 1e-9, 'HR cost @50%');
});
t('autoGenerateOverhead: junk profile falls back to 43%', () => {
  const a = hrLine(calc.autoGenerateOverhead({ ...OH_STATE, marketLaborProfile: { turnover_pct_annual: 0 } }));
  const b = hrLine(calc.autoGenerateOverhead(OH_STATE));
  near(a.annual_cost ?? a.annualCost ?? a.cost, b.annual_cost ?? b.annualCost ?? b.cost, 1e-12, 'zero → fallback');
});

console.log(`\ntest-cm-learning-turnover: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

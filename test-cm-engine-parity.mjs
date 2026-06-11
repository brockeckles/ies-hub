// test-cm-engine-parity.mjs — pins the 2026-06-11 legacy-vs-monthly Y1
// engine reconciliation (the last parked item from the 2026-06-10
// ground-up assessment).
//
// History: the monthly engine (canonical in-browser — the
// window.COST_MODEL_MONTHLY_ENGINE flag defaults ON) silently diverged
// from the legacy yearly engine on three axes:
//   1. Wage burden — resolveCalcHeuristics defaulted benefitLoadPct to 35,
//      which the monthly per-line path consumed as its burden fallback,
//      vs DEFAULT_WAGE_LOAD_PCT = 30 everywhere else (a relic of the
//      pre-2026-04-20 benefits double-dip bucket).
//   2. Y1 learning curve — legacy applies a complexity-tier multiplier
//      (1/0.85 ≈ +17.6% Y1 labor for medium); the monthly engine had none.
//      Its crew ramp models HIRING (cost down, months 1-3), not learning.
//   3. The monthly margin-driven revenue fallback still carried the magic
//      `0.3` overhead volume-elasticity hybrid removed from both engines'
//      expense paths on 2026-04-21, and ignored dedicated facility /
//      equipment escalation.
//
// This test pins: burden-default equality (incl. the literal mirror in
// calc.scenarios.js), shared learning-factor math, and full Y1+Y2
// cross-engine parity of every cost category + revenue under flat
// ramp/seasonality. Working capital / FCF are deliberately NOT compared —
// legacy uses an 8%-of-revenue proxy, monthly uses the defensible
// DSO/DPO model (documented intentional divergence).
//
// Run:  node test-cm-engine-parity.mjs

import * as calc from './tools/cost-model/calc.js';
import * as monthly from './tools/cost-model/calc.monthly.js';
import { resolveCalcHeuristics } from './tools/cost-model/calc.scenarios.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, rel = 1e-9, msg = '') {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  if (Math.abs(a - b) / denom > rel) throw new Error(`${msg}: expected ${b}, got ${a} (rel ${(Math.abs(a-b)/denom).toExponential(2)})`);
}

// ── fixtures ──────────────────────────────────────────────────────────
const FLAT_RAMP = { wk1_factor: 1, wk2_factor: 1, wk4_factor: 1, wk8_factor: 1, wk12_factor: 1 };
const FLAT_SEASON = { monthly_shares: Array(12).fill(1 / 12) };
function makePeriods(months) {
  return Array.from({ length: months }, (_, i) => ({
    id: i + 1, period_index: i, period_type: 'month',
    calendar_month: (i % 12) + 1, is_pre_go_live: false,
  }));
}

// ── 1. burden-default unification ─────────────────────────────────────
t('resolveCalcHeuristics default benefitLoadPct === DEFAULT_WAGE_LOAD_PCT (30)', () => {
  const heur = resolveCalcHeuristics(null, null, null, {}, null);
  assert(heur.benefitLoadPct === calc.DEFAULT_WAGE_LOAD_PCT,
    `heuristic default ${heur.benefitLoadPct} !== calc.DEFAULT_WAGE_LOAD_PCT ${calc.DEFAULT_WAGE_LOAD_PCT}`);
  assert(calc.DEFAULT_WAGE_LOAD_PCT === 30, `constant moved: ${calc.DEFAULT_WAGE_LOAD_PCT}`);
});

t('explicit benefit_load_pct override still honored end-to-end (35 → +1.35/1.30 labor)', () => {
  const line = { hourly_rate: 20, annual_hours: 2080, employment_type: 'permanent' };
  const ctx = (heur) => ({
    calcHeur: heur, marketLaborProfile: null, calendarMonth: 1,
    seasonalShare: 1 / 12, escLaborMult: 1, volMult: 1, rampLaborMult: 1, yearIdx: 0,
  });
  const at30 = monthly.computeMonthlyLaborFromLines([line], ctx(resolveCalcHeuristics(null, null, null, {}, null)));
  const at35 = monthly.computeMonthlyLaborFromLines([line], ctx(resolveCalcHeuristics(null, null, null, { benefitLoad: 35 }, null)));
  near(at35 / at30, 1.35 / 1.30, 1e-9, 'override ratio');
});

// ── 2. shared learning-factor helper ──────────────────────────────────
t('computeYr1LearningFactor: empty → 1.0, medium → 0.85, hours-weighted mix', () => {
  near(calc.computeYr1LearningFactor([]), 1.0, 1e-12, 'empty');
  near(calc.computeYr1LearningFactor([{ annual_hours: 2080 }]), 0.85, 1e-12, 'default medium');
  near(calc.computeYr1LearningFactor([
    { annual_hours: 1000, complexity_tier: 'low' },   // 0.95
    { annual_hours: 3000, complexity_tier: 'high' },  // 0.75
  ]), (1000 * 0.95 + 3000 * 0.75) / 4000, 1e-12, 'weighted');
});

// ── 3. aggregate-path cross-engine parity (Y1 + Y2) ───────────────────
const BASE = {
  years: 2,
  baseLaborCost: 1_200_000, baseFacilityCost: 500_000, baseEquipmentCost: 100_000,
  baseOverheadCost: 60_000, baseVasCost: 50_000,
  startupAmort: 20_000, startupCapital: 100_000,
  baseOrders: 1_000_000, marginPct: 0.12,
  volGrowthPct: 0.02, laborEscPct: 0.03, costEscPct: 0.025,
  facilityEscPct: 0.02, equipmentEscPct: 0.015, taxRatePct: 25,
};
const PARITY_FIELDS = ['labor', 'facility', 'equipment', 'overhead', 'vas', 'startup', 'revenue'];

t('aggregate path: legacy ≡ monthly-aggregated on every category + revenue, Y1+Y2', () => {
  const legacy = calc.buildYearlyProjections({ ...BASE }).projections;
  const viaMonthly = calc.buildYearlyProjections({
    ...BASE, useMonthlyEngine: true,
    periods: makePeriods(24), ramp: FLAT_RAMP, seasonality: FLAT_SEASON,
  }).projections;
  assert(legacy.length === 2 && viaMonthly.length === 2, 'expected 2 projection rows each');
  for (let y = 0; y < 2; y++) {
    for (const f of PARITY_FIELDS) {
      near(viaMonthly[y][f], legacy[y][f], 1e-8, `Y${y + 1}.${f}`);
    }
  }
});

t('regression: vol-growth no longer inflates monthly fallback revenue (magic 0.3 removed)', () => {
  // Pre-fix, Y2 fallback revenue carried base_overhead × (1+0.02·0.3) — a
  // ~0.6% Y2 overhead-revenue inflation vs the expense rows. Pin exact tie.
  const viaMonthly = calc.buildYearlyProjections({
    ...BASE, useMonthlyEngine: true,
    periods: makePeriods(24), ramp: FLAT_RAMP, seasonality: FLAT_SEASON,
  }).projections;
  const mFrac = BASE.marginPct;
  const y2CostFromCategories = PARITY_FIELDS.slice(0, 6)
    .reduce((s, f) => s + viaMonthly[1][f], 0);
  near(viaMonthly[1].revenue, y2CostFromCategories / (1 - mFrac), 1e-8, 'Y2 revenue vs grossed-up categories');
});

// ── 4. Y1 learning curve present in the monthly per-line path ─────────
t('monthly per-line path applies Y1 learning curve (Y1/Y2 labor = 1/0.85, flat conditions)', () => {
  const heur = resolveCalcHeuristics(null, null, null, {}, null);
  const proj = calc.buildYearlyProjections({
    years: 2,
    baseLaborCost: 0, baseFacilityCost: 0, baseEquipmentCost: 0,
    baseOverheadCost: 0, baseVasCost: 0, startupAmort: 0, startupCapital: 0,
    baseOrders: 0, marginPct: 0.10,
    volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
    laborLines: [{ hourly_rate: 20, annual_hours: 2080, complexity_tier: 'medium', employment_type: 'permanent' }],
    _calcHeur: heur,
    useMonthlyEngine: true,
    periods: makePeriods(24), ramp: FLAT_RAMP, seasonality: FLAT_SEASON,
  }).projections;
  assert(proj[1].labor > 0, 'Y2 labor should be > 0');
  near(proj[0].labor / proj[1].labor, 1 / 0.85, 1e-9, 'Y1/Y2 labor ratio');
});

t('legacy and monthly agree on the learning ratio (cross-engine, per-line vs aggregate)', () => {
  const laborLines = [{ hourly_rate: 20, annual_hours: 2080, complexity_tier: 'high', employment_type: 'permanent' }];
  const common = {
    years: 2, baseLaborCost: 500_000, baseFacilityCost: 0, baseEquipmentCost: 0,
    baseOverheadCost: 0, baseVasCost: 0, startupAmort: 0, startupCapital: 0,
    baseOrders: 0, marginPct: 0.10, volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
    laborLines,
  };
  const legacy = calc.buildYearlyProjections({ ...common }).projections;
  const heur = resolveCalcHeuristics(null, null, null, {}, null);
  const viaMonthly = calc.buildYearlyProjections({
    ...common, _calcHeur: heur, useMonthlyEngine: true,
    periods: makePeriods(24), ramp: FLAT_RAMP, seasonality: FLAT_SEASON,
  }).projections;
  near(legacy[0].labor / legacy[1].labor, 1 / 0.75, 1e-9, 'legacy Y1/Y2 (high tier)');
  near(viaMonthly[0].labor / viaMonthly[1].labor, 1 / 0.75, 1e-9, 'monthly Y1/Y2 (high tier)');
});

console.log(`\ntest-cm-engine-parity: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

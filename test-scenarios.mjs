#!/usr/bin/env node
/**
 * IES Hub v3 — Cost Model Phase 3 Scenarios + Heuristics acceptance tests
 *
 * Mirrors test-monthly.mjs (Phase 1). Zero dependencies — pure Node.
 * Run:   node test-scenarios.mjs
 *
 * Targets the pure functions in tools/cost-model/calc.scenarios.js.
 */

import {
  heuristicEffective,
  validateHeuristic,
  resolveHeuristics,
  countOverrideChanges,
  computeRateCardHash,
  loadScenarioRates,
  compareScenarios,
  buildApprovalPayload,
  spawnChildPayload,
  buildRevisionRow,
  filterCurrent,
  resolveCalcHeuristics,
  monthlyOvertimePct,
  monthlyAbsencePct,
  monthlyEffectiveHours,
  annualEffectiveHoursFromMonthly,
  validateMonthlyProfile,
  flatProfile,
  simulateLaborVariance,
  gaussianDraw,
  mulberry32,
} from './tools/cost-model/calc.scenarios.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg)     { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function close(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'not close'}: got ${a}, expected ≈ ${b}`); }

// ---------------------------------------------------------------------------
// 1. HEURISTICS
// ---------------------------------------------------------------------------
const CATALOG = [
  { key: 'tax_rate_pct',     label: 'Tax', category: 'financial', data_type: 'percent', unit: '%', default_value: 25, min_value: 0, max_value: 50 },
  { key: 'dso_days',         label: 'DSO', category: 'working_capital', data_type: 'integer', unit: 'days', default_value: 30, min_value: 0, max_value: 120 },
  { key: 'benefit_load_pct', label: 'Benefits', category: 'labor', data_type: 'percent', unit: '%', default_value: 35 },
  { key: 'default_seasonality', label: 'Seasonality', category: 'ramp_seasonality', data_type: 'enum', default_enum: 'flat', allowed_enums: ['flat','retail_peak_q4','ecomm_bimodal'] },
  { key: 'units_per_truck',  label: 'Truck', category: 'ops_escalation', data_type: 'integer', unit: 'units', default_value: 25000 },
];

console.log('\n--- Heuristics ---');
test('heuristicEffective: returns default when no override', () => {
  eq(heuristicEffective(CATALOG[0], {}), 25);
});
test('heuristicEffective: override wins over default', () => {
  eq(heuristicEffective(CATALOG[0], { tax_rate_pct: 21 }), 21);
});
test('heuristicEffective: enum default_enum used when no override', () => {
  eq(heuristicEffective(CATALOG[3], {}), 'flat');
});
test('heuristicEffective: enum override honored', () => {
  eq(heuristicEffective(CATALOG[3], { default_seasonality: 'retail_peak_q4' }), 'retail_peak_q4');
});
test('heuristicEffective: empty-string override falls through to default', () => {
  eq(heuristicEffective(CATALOG[0], { tax_rate_pct: '' }), 25);
});
test('validateHeuristic: empty value is OK (means use default)', () => {
  eq(validateHeuristic(CATALOG[0], ''), null);
  eq(validateHeuristic(CATALOG[0], null), null);
});
test('validateHeuristic: integer rejects fractional', () => {
  assert(validateHeuristic(CATALOG[1], 10.5) !== null);
});
test('validateHeuristic: min bound enforced', () => {
  assert(validateHeuristic(CATALOG[0], -1) !== null);
});
test('validateHeuristic: max bound enforced', () => {
  assert(validateHeuristic(CATALOG[0], 999) !== null);
});
test('validateHeuristic: enum rejects unknown value', () => {
  assert(validateHeuristic(CATALOG[3], 'nonsense') !== null);
  eq(validateHeuristic(CATALOG[3], 'flat'), null);
});
test('resolveHeuristics: builds full map with overrides merged', () => {
  const m = resolveHeuristics(CATALOG, { tax_rate_pct: 21, default_seasonality: 'ecomm_bimodal' });
  eq(m.tax_rate_pct, 21);
  eq(m.dso_days, 30);
  eq(m.default_seasonality, 'ecomm_bimodal');
  eq(m.units_per_truck, 25000);
});
test('countOverrideChanges: counts only real diffs', () => {
  const overrides = {
    tax_rate_pct: 25,     // matches default — NOT an override
    dso_days: 45,         // override
    benefit_load_pct: '', // empty — NOT an override
    default_seasonality: 'retail_peak_q4', // override
  };
  eq(countOverrideChanges(CATALOG, overrides), 2);
});

// ---------------------------------------------------------------------------
// 2. RATE-CARD HASH
// ---------------------------------------------------------------------------
console.log('\n--- Rate-card hash ---');
const LABOR_ROW = {
  market_id: 'mem', role_name: 'Material Handler', role_category: 'hourly',
  hourly_rate: 18.50, burden_pct: 35, benefits_per_hour: 0,
  overtime_multiplier: 1.5, shift_differential_pct: 0, annual_hours: 2080,
  default_benefit_load_pct: 35, default_bonus_pct: 0, annual_escalation_pct: 4,
  effective_date: '2026-01-01',
};

test('computeRateCardHash: labor — deterministic (same input = same hash)', () => {
  const h1 = computeRateCardHash('labor', LABOR_ROW);
  const h2 = computeRateCardHash('labor', { ...LABOR_ROW });
  eq(h1, h2);
});
test('computeRateCardHash: labor — hash changes when hourly_rate changes', () => {
  const h1 = computeRateCardHash('labor', LABOR_ROW);
  const h2 = computeRateCardHash('labor', { ...LABOR_ROW, hourly_rate: 19.00 });
  assert(h1 !== h2, 'hash must differ when a hash-relevant column changes');
});
test('computeRateCardHash: labor — returns 32 hex chars (md5 shape)', () => {
  const h = computeRateCardHash('labor', LABOR_ROW);
  assert(/^[0-9a-f]{32}$/.test(h), `expected md5 hex, got ${h}`);
});
test('computeRateCardHash: facility vs utility hash differently for same id', () => {
  const a = computeRateCardHash('facility', { market_id: 'mem', building_type: 'Class A', lease_rate_psf_yr: 7.5 });
  const b = computeRateCardHash('utility',  { market_id: 'mem', electricity_kwh: 0.08 });
  assert(a !== b);
});

// ---------------------------------------------------------------------------
// 3. SCENARIO RATE LOADING
// ---------------------------------------------------------------------------
console.log('\n--- Scenario rate loading ---');
const SNAPSHOTS = [
  { scenario_id: 1, rate_card_type: 'labor',    rate_card_id: 'u1', rate_card_version_hash: 'x', snapshot_json: { role_name: 'MH' } },
  { scenario_id: 1, rate_card_type: 'facility', rate_card_id: 'u2', rate_card_version_hash: 'y', snapshot_json: { building_type: 'A' } },
  { scenario_id: 1, rate_card_type: 'heuristics',rate_card_id: 'tax_rate_pct', rate_card_version_hash: 'h', snapshot_json: { key: 'tax_rate_pct', effective: 21 } },
];
const LIVE = { labor: [{ role_name: 'MH (current)' }], facility: [{ building_type: 'A (current)' }] };

test('loadScenarioRates: approved + snapshots → frozen', () => {
  const s = { status: 'approved' };
  const out = loadScenarioRates(s, { live: LIVE, snapshots: SNAPSHOTS });
  eq(out.source, 'snapshot');
  eq(out.rates.labor[0].role_name, 'MH');
});
test('loadScenarioRates: draft → live rates even if snapshots exist', () => {
  const s = { status: 'draft' };
  const out = loadScenarioRates(s, { live: LIVE, snapshots: SNAPSHOTS });
  eq(out.source, 'live');
  eq(out.rates.labor[0].role_name, 'MH (current)');
});
test('loadScenarioRates: approved without snapshots → live fallback', () => {
  const s = { status: 'approved' };
  const out = loadScenarioRates(s, { live: LIVE, snapshots: [] });
  eq(out.source, 'live');
});

// ---------------------------------------------------------------------------
// 4. SCENARIO COMPARISON
// ---------------------------------------------------------------------------
console.log('\n--- Scenario comparison ---');
const BUNDLE_A = {
  label: 'Baseline',
  summary: { total_revenue: 1000, total_opex: 800, ebitda: 200, net_income: 150, capex: 50 },
  monthly: [
    { period_index: 0, period_label: 'M1', revenue: 100, opex: 80, ebitda: 20, net_income: 15, free_cash_flow: 5 },
    { period_index: 1, period_label: 'M2', revenue: 110, opex: 85, ebitda: 25, net_income: 18, free_cash_flow: 7 },
  ],
};
const BUNDLE_B = {
  label: 'Upside',
  summary: { total_revenue: 1200, total_opex: 850, ebitda: 350, net_income: 250, capex: 50 },
  monthly: [
    { period_index: 0, period_label: 'M1', revenue: 120, opex: 85, ebitda: 35, net_income: 25, free_cash_flow: 10 },
    { period_index: 1, period_label: 'M2', revenue: 130, opex: 90, ebitda: 40, net_income: 28, free_cash_flow: 12 },
  ],
};

test('compareScenarios: identical bundles → zero delta', () => {
  const c = compareScenarios(BUNDLE_A, BUNDLE_A);
  eq(c.kpiDelta.total_revenue.diff, 0);
  eq(c.kpiDelta.ebitda.diff, 0);
  eq(c.kpiDelta.total_revenue.pct_change, 0);
});
test('compareScenarios: kpi deltas computed correctly', () => {
  const c = compareScenarios(BUNDLE_A, BUNDLE_B);
  eq(c.kpiDelta.total_revenue.diff, 200);
  eq(c.kpiDelta.ebitda.diff, 150);
  eq(c.kpiDelta.net_income.diff, 100);
  close(c.kpiDelta.total_revenue.pct_change, 20, 0.001);
});
test('compareScenarios: monthlyDelta aligns by period_index', () => {
  const c = compareScenarios(BUNDLE_A, BUNDLE_B);
  eq(c.monthlyDelta.length, 2);
  eq(c.monthlyDelta[0].revenue.diff, 20);
  eq(c.monthlyDelta[1].ebitda.diff, 15);
});
test('compareScenarios: handles zero baseline without NaN', () => {
  const a = { summary: { total_revenue: 0 }, monthly: [] };
  const b = { summary: { total_revenue: 100 }, monthly: [] };
  const c = compareScenarios(a, b);
  eq(c.kpiDelta.total_revenue.pct_change, null);
});

// ---------------------------------------------------------------------------
// 5. LIFECYCLE PAYLOADS
// ---------------------------------------------------------------------------
console.log('\n--- Lifecycle payloads ---');
test('buildApprovalPayload: happy path', () => {
  const p = buildApprovalPayload(42, 'brock@ies.hub');
  eq(p.p_scenario_id, 42);
  eq(p.p_user_email, 'brock@ies.hub');
});
test('buildApprovalPayload: non-integer id rejected', () => {
  let threw = false;
  try { buildApprovalPayload('nope'); } catch (_) { threw = true; }
  assert(threw, 'should throw on non-integer id');
});
test('buildApprovalPayload: null email OK', () => {
  const p = buildApprovalPayload(1, null);
  eq(p.p_user_email, null);
});
test('spawnChildPayload: parent + label captured', () => {
  const src = { id: 7, deal_id: 'd-123', scenario_label: 'Baseline', status: 'approved' };
  const p = spawnChildPayload(src, 'Child-A');
  eq(p.parent_scenario_id, 7);
  eq(p.deal_id, 'd-123');
  eq(p.scenario_label, 'Child-A');
  eq(p.status, 'draft');
  eq(p.is_baseline, false);
});
test('spawnChildPayload: default label falls back to source label (child)', () => {
  const src = { id: 7, deal_id: 'd-123', scenario_label: 'Upside' };
  const p = spawnChildPayload(src);
  eq(p.scenario_label, 'Upside (child)');
});
test('spawnChildPayload: missing source throws', () => {
  let threw = false;
  try { spawnChildPayload(null); } catch (_) { threw = true; }
  assert(threw);
});
test('buildRevisionRow: increments revision_number monotonically', () => {
  const r = buildRevisionRow(5, 0, 'brock@ies.hub', 'Initial save', { a: 1 }, { b: 2 });
  eq(r.scenario_id, 5);
  eq(r.revision_number, 1);
  eq(r.changed_by, 'brock@ies.hub');
  eq(r.inputs_json.a, 1);
});
test('buildRevisionRow: increments from prior', () => {
  const r = buildRevisionRow(5, 3, null, 'Edit', {}, {});
  eq(r.revision_number, 4);
});

// ---------------------------------------------------------------------------
// 5b. CLOSE THE PHASE 3 LOOP — calc-side heuristic resolution
// ---------------------------------------------------------------------------
console.log('\n--- Calc heuristic resolution (snapshot → override → default) ---');

const SNAP_HEURISTICS = [
  { key: 'tax_rate_pct', effective: 21, default_value: 25 },
  { key: 'dso_days',     effective: 60, default_value: 30 },
];
const APPROVED_SCEN = { id: 1, status: 'approved' };
const DRAFT_SCEN    = { id: 2, status: 'draft' };
const PROJECT_COLS  = { taxRate: 25, dsoDays: 30, dpoDays: 30, laborPayableDays: 14, targetMargin: 12, volumeGrowth: 0, laborEscalation: 3, annualEscalation: 3, preGoLiveMonths: 0 };

test('resolveCalcHeuristics: approved + snapshot → values come from snapshot', () => {
  const out = resolveCalcHeuristics(APPROVED_SCEN, { heuristics: SNAP_HEURISTICS }, {}, PROJECT_COLS);
  eq(out.taxRatePct, 21);
  eq(out.dsoDays, 60);
  eq(out.used.tax_rate_pct, 'snapshot');
  eq(out.source, 'snapshot');
});
test('resolveCalcHeuristics: draft scenario IGNORES snapshot, uses override → project', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, { heuristics: SNAP_HEURISTICS }, { tax_rate_pct: 30 }, PROJECT_COLS);
  eq(out.taxRatePct, 30);          // override wins
  eq(out.used.tax_rate_pct, 'override');
  eq(out.dsoDays, 30);             // no override, no snapshot → project column
  eq(out.used.dso_days, 'default');
});
test('resolveCalcHeuristics: draft + no override → falls all the way to project column', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, {}, PROJECT_COLS);
  eq(out.taxRatePct, 25);
  eq(out.dsoDays, 30);
  eq(out.used.tax_rate_pct, 'default');
});
test('resolveCalcHeuristics: approved + snapshot + override → snapshot still wins', () => {
  // This is the headline Phase 3 invariant: approved means FROZEN.
  const out = resolveCalcHeuristics(APPROVED_SCEN, { heuristics: SNAP_HEURISTICS }, { tax_rate_pct: 999 }, PROJECT_COLS);
  eq(out.taxRatePct, 21);
  eq(out.used.tax_rate_pct, 'snapshot');
});
test('resolveCalcHeuristics: approved without snapshot → falls through like draft', () => {
  const out = resolveCalcHeuristics(APPROVED_SCEN, { heuristics: [] }, { tax_rate_pct: 30 }, PROJECT_COLS);
  eq(out.taxRatePct, 30);
  eq(out.used.tax_rate_pct, 'override');
});
test('resolveCalcHeuristics: transient wins over snapshot + override + default (Phase 5b)', () => {
  const out = resolveCalcHeuristics(APPROVED_SCEN,
    { heuristics: SNAP_HEURISTICS },
    { tax_rate_pct: 30 },
    PROJECT_COLS,
    { tax_rate_pct: 18 });
  eq(out.taxRatePct, 18);
  eq(out.used.tax_rate_pct, 'transient');
});
// 2026-04-21 PM (Brock What-If audit): the discount-rate + reinvest-rate sliders
// in What-If Studio were landing in the transient overlay but weren't surfaced
// on calcHeur, so computeFinancialMetrics silently fell back to the 10% / 8%
// defaults — the sliders appeared to "do nothing." Lock the fix.
test('resolveCalcHeuristics: discount_rate_pct slider surfaces as discountRatePct', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, {}, PROJECT_COLS, { discount_rate_pct: 15 });
  eq(out.discountRatePct, 15);
  eq(out.used.discount_rate_pct, 'transient');
});
test('resolveCalcHeuristics: discount_rate_pct falls back to project.discountRate column', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, {}, { discountRate: 12 }, {});
  eq(out.discountRatePct, 12);
});
test('resolveCalcHeuristics: discount_rate_pct default = 10 when nothing set', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, {}, {}, {});
  eq(out.discountRatePct, 10);
});
test('resolveCalcHeuristics: reinvest_rate_pct slider surfaces as reinvestRatePct', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, {}, PROJECT_COLS, { reinvest_rate_pct: 12 });
  eq(out.reinvestRatePct, 12);
});
test('resolveCalcHeuristics: reinvest_rate_pct default = 8', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, {}, {}, {});
  eq(out.reinvestRatePct, 8);
});
test('resolveCalcHeuristics: empty transient → normal resolution chain', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, { tax_rate_pct: 30 }, PROJECT_COLS, {});
  eq(out.taxRatePct, 30);
  eq(out.used.tax_rate_pct, 'override');
});
test('resolveCalcHeuristics: numeric coercion of NaN override falls to default', () => {
  const out = resolveCalcHeuristics(DRAFT_SCEN, null, { tax_rate_pct: 'not-a-number' }, PROJECT_COLS);
  // Not-a-number override value still "counts" as present (string), so `used` marks override
  // but numeric coercion inside pick() via n() falls to 25.
  eq(out.taxRatePct, 25);
});

// ---------------------------------------------------------------------------
// 5c. PHASE 4b — monthly OT/absence profiles
// ---------------------------------------------------------------------------
console.log('\n--- Phase 4b monthly profiles ---');

const FALLBACK_HEUR = { overtimePct: 5, absenceAllowancePct: 12 };
const MARKET_PROFILE = {
  peak_month_overtime_pct: [0.04, 0.04, 0.04, 0.04, 0.04, 0.05, 0.05, 0.06, 0.08, 0.10, 0.10, 0.06],
  peak_month_absence_pct:  [0.10, 0.10, 0.10, 0.10, 0.10, 0.11, 0.12, 0.12, 0.10, 0.10, 0.11, 0.12],
};
const LINE_WITH_PROFILE = {
  annual_hours: 2400,
  monthly_overtime_profile: [0.05, 0.05, 0.05, 0.05, 0.05, 0.10, 0.10, 0.15, 0.15, 0.10, 0.10, 0.05],
  monthly_absence_profile: null,
};
const LINE_NO_PROFILE = { annual_hours: 2400 };

test('monthlyOvertimePct: per-line profile wins over market + fallback', () => {
  // Aug = month 7, line says 0.15 → 15%
  eq(monthlyOvertimePct(LINE_WITH_PROFILE, 7, MARKET_PROFILE, 5), 15);
});
test('monthlyOvertimePct: line absent → market profile wins over fallback', () => {
  // Aug = market 0.06 → 6%
  eq(monthlyOvertimePct(LINE_NO_PROFILE, 7, MARKET_PROFILE, 5), 6);
});
test('monthlyOvertimePct: line absent + no market → fallback', () => {
  eq(monthlyOvertimePct(LINE_NO_PROFILE, 7, null, 5), 5);
});
test('monthlyOvertimePct: profile wrong length is ignored, falls through', () => {
  const bad = { monthly_overtime_profile: [0.5, 0.5] };
  eq(monthlyOvertimePct(bad, 7, MARKET_PROFILE, 5), 6);
});

test('monthlyEffectiveHours: peak Aug w/ 15% OT and 12% absence', () => {
  // base monthly = 2400/12 = 200
  // 200 × 1.15 × 0.88 = 202.4
  const aug = monthlyEffectiveHours(LINE_WITH_PROFILE, 7, FALLBACK_HEUR, MARKET_PROFILE);
  close(aug, 202.4, 0.01);
});
test('monthlyEffectiveHours: profile-less line uses fallback', () => {
  // 200 × 1.05 × 0.88 = 184.8
  const may = monthlyEffectiveHours(LINE_NO_PROFILE, 4, FALLBACK_HEUR, null);
  close(may, 184.8, 0.01);
});

test('annualEffectiveHoursFromMonthly: line with no profile + flat fallback ≈ annual_hours × (1 + OT) × (1 - absence)', () => {
  // 2400 × 1.05 × 0.88 = 2217.6
  const sum = annualEffectiveHoursFromMonthly(LINE_NO_PROFILE, FALLBACK_HEUR, null);
  close(sum, 2217.6, 0.01);
});
test('annualEffectiveHoursFromMonthly: peak profile pulls more hours than flat 5%', () => {
  // The peak profile averages > 5% OT, so this MUST exceed flat
  const peak = annualEffectiveHoursFromMonthly(LINE_WITH_PROFILE, FALLBACK_HEUR, null);
  const flat = annualEffectiveHoursFromMonthly(LINE_NO_PROFILE, FALLBACK_HEUR, null);
  assert(peak > flat, `peak (${peak.toFixed(2)}) should exceed flat (${flat.toFixed(2)})`);
});

test('validateMonthlyProfile: null is OK', () => {
  eq(validateMonthlyProfile(null), null);
});
test('validateMonthlyProfile: 11 elements → error', () => {
  assert(validateMonthlyProfile([0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05]) !== null);
});
test('validateMonthlyProfile: negative → error', () => {
  assert(validateMonthlyProfile([0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,-0.01]) !== null);
});
test('validateMonthlyProfile: > 200% → error', () => {
  assert(validateMonthlyProfile([0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05,2.5]) !== null);
});
test('validateMonthlyProfile: valid 12-element passes', () => {
  eq(validateMonthlyProfile([0,0.05,0.10,0.05,0,0.07,0.07,0.08,0.10,0.12,0.12,0.08]), null);
});
test('flatProfile: returns 12-element array of constant value', () => {
  const p = flatProfile(0.07);
  eq(p.length, 12);
  eq(p.every(v => v === 0.07), true);
});

// ---------------------------------------------------------------------------
// 5d. PHASE 4e — Monte-Carlo labor variance
// ---------------------------------------------------------------------------
console.log('\n--- Phase 4e Monte-Carlo sensitivity ---');

const DETERMINISTIC_LINE = {
  annual_hours: 2080, hourly_rate: 20, burden_pct: 30,
  benefits_per_hour: 0, employment_type: 'permanent',
  temp_agency_markup_pct: 0, performance_variance_pct: 0,
  monthly_overtime_profile: null, monthly_absence_profile: null,
};
const VOLATILE_LINE = { ...DETERMINISTIC_LINE, performance_variance_pct: 15 };

test('simulateLaborVariance: zero-variance line → all trials identical', () => {
  const rng = mulberry32(42);
  const r = simulateLaborVariance([DETERMINISTIC_LINE], FALLBACK_HEUR, null, 100, rng);
  eq(r.p10, r.p50);
  eq(r.p50, r.p90);
  // stddev can be ~1e-11 due to floating-point accumulator in sum-of-squares
  assert(r.stddev < 1e-6, `stddev ${r.stddev} should be essentially zero`);
});
test('simulateLaborVariance: empty lines → zero result shape', () => {
  const r = simulateLaborVariance([], FALLBACK_HEUR, null, 50);
  eq(r.mean, 0);
  eq(r.nTrials, 0);
});
test('simulateLaborVariance: positive variance → stddev > 0, p10 < p50 < p90', () => {
  const rng = mulberry32(7);
  const r = simulateLaborVariance([VOLATILE_LINE], FALLBACK_HEUR, null, 500, rng);
  assert(r.stddev > 0, 'stddev should be positive');
  assert(r.p10 < r.p50, `p10 ${r.p10} should be < p50 ${r.p50}`);
  assert(r.p50 < r.p90, `p50 ${r.p50} should be < p90 ${r.p90}`);
});
test('simulateLaborVariance: seeded RNG is deterministic', () => {
  const r1 = simulateLaborVariance([VOLATILE_LINE], FALLBACK_HEUR, null, 200, mulberry32(999));
  const r2 = simulateLaborVariance([VOLATILE_LINE], FALLBACK_HEUR, null, 200, mulberry32(999));
  eq(r1.p10, r2.p10);
  eq(r1.p50, r2.p50);
  eq(r1.p90, r2.p90);
});
test('simulateLaborVariance: mean within 5% of deterministic target', () => {
  // Deterministic baseline: 2080 hrs × $26/hr loaded × (1+0.05)(1-0.12) ≈ $49,969
  const rng = mulberry32(2026);
  const r = simulateLaborVariance([VOLATILE_LINE], FALLBACK_HEUR, null, 2000, rng);
  close(r.mean, 49969, 49969 * 0.05, 'mean within 5% of expected');
});
test('gaussianDraw: seeded, centered around 0 over 1000 draws', () => {
  const rng = mulberry32(1);
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += gaussianDraw(rng);
  const mean = sum / 1000;
  assert(Math.abs(mean) < 0.15, `mean |${mean}| should be near 0`);
});
test('mulberry32: returns values in [0, 1)', () => {
  const rng = mulberry32(1234);
  for (let i = 0; i < 100; i++) {
    const v = rng();
    assert(v >= 0 && v < 1, `${v} not in [0,1)`);
  }
});

// ---------------------------------------------------------------------------
// 6. SCD filterCurrent
// ---------------------------------------------------------------------------
console.log('\n--- SCD helpers ---');
test('filterCurrent: drops superseded rows', () => {
  const rows = [
    { id: 1, effective_end_date: '9999-12-31', superseded_by_id: null },
    { id: 2, effective_end_date: '9999-12-31', superseded_by_id: 'later-uuid' },
    { id: 3, effective_end_date: '2025-01-01', superseded_by_id: null },
  ];
  const kept = filterCurrent(rows, new Date('2026-01-01'));
  eq(kept.length, 1);
  eq(kept[0].id, 1);
});
test('filterCurrent: empty list is safe', () => {
  eq(filterCurrent([]).length, 0);
  eq(filterCurrent(null).length, 0);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass}/${pass + fail} tests passed.`);
process.exit(fail ? 1 : 0);

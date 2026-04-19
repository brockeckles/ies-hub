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

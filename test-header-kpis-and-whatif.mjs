// Standalone Node ESM test pinning the contracts of computeHeaderKpis
// + computeWhatIfPreview after their S18 extraction out of
// cost-model/ui.js. Both functions are now pure (state injected via
// opts bag) so they can be exercised outside the browser.
//
// Caveats: these tests focus on shape + reasonable-value invariants
// rather than exact numeric assertions. The underlying engine pulls
// from many places (calc.computeSummary / calc.buildYearlyProjections /
// calc.computePricingSnapshot / calc.scenarios.resolveCalcHeuristics)
// and tiny rounding differences cascade. The goal is to catch
// regression-class bugs (returns null, returns ready:false on real
// data, item count drops below 6, kpiCtx missing) — not to pin every
// digit.
//
// Run: node test-header-kpis-and-whatif.mjs

import { computeHeaderKpis } from './tools/cost-model/header-kpis.js';
import { computeWhatIfPreview } from './tools/cost-model/what-if-preview.js';
import * as scenarios from './tools/cost-model/calc.scenarios.js';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (e) {
    failed++;
    failures.push(`X ${name}\n    ${e.message}`);
    process.stdout.write('F');
  }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- Fixtures ----

function makeModel() {
  return {
    projectDetails: { contractTerm: 5 },
    financial: { targetMargin: 12, discountRate: 10 },
    volumeLines: [{ uom: 'order', volume: 1_000_000, isOutboundPrimary: true }],
    laborLines: [
      { activity_name: 'Pick', annual_hours: 100_000, hourly_rate: 20, burden_pct: 0, benefits_per_hour: 0, pricing_bucket: 'outbound' },
    ],
    indirectLaborLines: [],
    equipmentLines: [],
    overheadLines: [],
    vasLines: [],
    startupLines: [],
    pricingBuckets: [
      { id: 'outbound', name: 'Outbound', type: 'variable', uom: 'order' },
    ],
    facility: {},
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
  };
}

function makeOpts(model) {
  return {
    model,
    refData: { facilityRates: [], utilityRates: [] },
    userHasInteracted: true,
    whatIfTransient: {},
    currentScenario: null,
    currentScenarioSnapshots: {},
    heuristicOverrides: {},
    currentMarketLaborProfile: null,
    scenarios,
  };
}

// ---- computeHeaderKpis tests ----

test('computeHeaderKpis returns the { ready, items, kpiCtx } shape', () => {
  const r = computeHeaderKpis(makeOpts(makeModel()));
  assert(r && typeof r === 'object', 'result is object');
  assert(typeof r.ready === 'boolean', 'ready is boolean');
  assert(Array.isArray(r.items), 'items is array');
  assert(r.kpiCtx && typeof r.kpiCtx === 'object', 'kpiCtx is object');
});

test('with populated model + userHasInteracted=true, ready is true', () => {
  const r = computeHeaderKpis(makeOpts(makeModel()));
  assert(r.ready === true, `expected ready=true, got ${r.ready}`);
});

test('ready path returns exactly 6 KPI items', () => {
  const r = computeHeaderKpis(makeOpts(makeModel()));
  assert(r.items.length === 6, `expected 6 items, got ${r.items.length}`);
});

test('KPI labels match the contract', () => {
  const r = computeHeaderKpis(makeOpts(makeModel()));
  const labels = r.items.map(i => i.label);
  assert(labels.some(l => /Cost/i.test(l)), 'has a Cost / X tile');
  assert(labels.includes('Y1 Revenue'), 'has Y1 Revenue');
  assert(labels.includes('GP Margin (Y1)'), 'has GP Margin');
  assert(labels.includes('Total FTEs'), 'has Total FTEs');
  assert(labels.some(l => /NPV/i.test(l)), 'has NPV tile');
  assert(labels.includes('Contract'), 'has Contract tile');
});

test('empty model + userHasInteracted=false bails to ready=false with 6 placeholder items', () => {
  const opts = makeOpts({ projectDetails: {}, financial: {} });
  opts.userHasInteracted = false;
  const r = computeHeaderKpis(opts);
  assert(r.ready === false, `expected ready=false, got ${r.ready}`);
  // Bail-out path returns 6 placeholder rows so the strip is layout-stable
  assert(r.items.length === 6, `expected 6 placeholder items, got ${r.items.length}`);
});

test('zero outbound volume bails to ready=false', () => {
  const m = makeModel();
  m.volumeLines = [{ uom: 'order', volume: 0, isOutboundPrimary: true }];
  const r = computeHeaderKpis(makeOpts(m));
  assert(r.ready === false, 'zero volume should bail');
});

test('kpiCtx contains projections, summary, calcHeur, channelLineage', () => {
  const r = computeHeaderKpis(makeOpts(makeModel()));
  assert(r.kpiCtx.projections, 'kpiCtx.projections present');
  assert(r.kpiCtx.summary, 'kpiCtx.summary present');
  assert(r.kpiCtx.calcHeur, 'kpiCtx.calcHeur present');
  assert(r.kpiCtx.channelLineage !== undefined, 'kpiCtx.channelLineage present');
  assert(r.kpiCtx.kpi && typeof r.kpiCtx.kpi === 'object', 'kpiCtx.kpi present');
});

test('Contract tile reflects projectDetails.contractTerm', () => {
  const m = makeModel();
  m.projectDetails.contractTerm = 7;
  const r = computeHeaderKpis(makeOpts(m));
  const contractTile = r.items.find(i => i.label === 'Contract');
  assert(contractTile, 'Contract tile exists');
  assert(/7 yr/.test(contractTile.value), `expected "7 yr" in Contract value, got ${contractTile.value}`);
});

test('NPV label reflects contractTerm', () => {
  const m = makeModel();
  m.projectDetails.contractTerm = 3;
  const r = computeHeaderKpis(makeOpts(m));
  const npvTile = r.items.find(i => /NPV/i.test(i.label));
  assert(npvTile, 'NPV tile exists');
  assert(npvTile.label.includes('3'), `expected "3" in NPV label, got ${npvTile.label}`);
});

// ---- computeWhatIfPreview tests ----

test('computeWhatIfPreview returns non-null for valid model', () => {
  const r = computeWhatIfPreview(undefined, makeOpts(makeModel()));
  assert(r !== null, 'result not null');
});

test('preview has the expected metric keys', () => {
  const r = computeWhatIfPreview(undefined, makeOpts(makeModel()));
  for (const key of ['totalRev', 'totalOpex', 'totalEbitda', 'totalNI', 'ebitdaMargin', 'cumFcf', 'npv', 'projections', 'calcHeur']) {
    assert(key in r, `missing key ${key}`);
  }
});

test('preview totalRev is positive for a $2M-labor model with margin', () => {
  const r = computeWhatIfPreview(undefined, makeOpts(makeModel()));
  assert(r.totalRev > 0, `expected totalRev > 0, got ${r.totalRev}`);
});

test('preview totalNI > 0 at 12% target margin', () => {
  const r = computeWhatIfPreview(undefined, makeOpts(makeModel()));
  assert(r.totalNI > 0, `expected totalNI > 0, got ${r.totalNI}`);
});

test('ebitdaMargin is in percent (0-100), not fraction (0-1)', () => {
  const r = computeWhatIfPreview(undefined, makeOpts(makeModel()));
  // Should be ~12 (percent), not 0.12 (fraction)
  assert(r.ebitdaMargin > 1, `ebitdaMargin should be in percent, got ${r.ebitdaMargin}`);
  assert(r.ebitdaMargin < 100, `ebitdaMargin should be < 100, got ${r.ebitdaMargin}`);
});

test('projections array length matches contractYears', () => {
  const r = computeWhatIfPreview(undefined, makeOpts(makeModel()));
  assert(Array.isArray(r.projections), 'projections is array');
  assert(r.projections.length === 5, `expected 5 projections (5yr contract), got ${r.projections.length}`);
});

test('null overlay defaults to whatIfTransient', () => {
  const opts = makeOpts(makeModel());
  opts.whatIfTransient = { target_margin_pct: 15 };
  const withDefault = computeWhatIfPreview(undefined, opts);
  const explicit = computeWhatIfPreview({ target_margin_pct: 15 }, { ...opts, whatIfTransient: {} });
  // Both should produce roughly the same revenue (within 1% rounding)
  const diff = Math.abs(withDefault.totalRev - explicit.totalRev) / explicit.totalRev;
  assert(diff < 0.01, `whatIfTransient default vs explicit overlay should match: ${diff}`);
});

test('preview tolerates null model — returns null gracefully', () => {
  const opts = makeOpts(null);
  // computeWhatIfPreview reads model.* extensively; if it throws on null,
  // its try/catch should catch it and return null (the failure mode).
  const r = computeWhatIfPreview(undefined, opts);
  assert(r === null, 'expected null for null model');
});

test('higher target margin overlay produces higher revenue', () => {
  const baseline = computeWhatIfPreview({}, makeOpts(makeModel()));
  const opts = makeOpts(makeModel());
  opts.heuristicOverrides = { target_margin_pct: 20 };
  const scenario = computeWhatIfPreview({ target_margin_pct: 20 }, opts);
  assert(scenario.totalRev > baseline.totalRev,
    `20% margin should produce more revenue than 12% baseline (got ${scenario.totalRev} vs ${baseline.totalRev})`);
});

// ---- Report ----

console.log();
if (failures.length) {
  console.log(failures.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`test-header-kpis-and-whatif: ${passed} passed, 0 failed.`);

// Standalone Node ESM test for the relocated computePricingSnapshot.
// S15 (2026-05-11) — moved from cost-model/ui.js to calc.js, threading
// `model` as an explicit param. This test pins the public contract so
// future refactors can't silently break the chrome KPI strip, the
// Summary pricing-bucket table, or the buildEnrichedPricingBuckets
// wrapper.
//
// Run:  node test-pricing-snapshot.mjs

import {
  computePricingSnapshot,
  computeSummary,
  operatingHours,
} from './tools/cost-model/calc.js';

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
  if (!ok) throw new Error(`${msg} expected ~${expected} (±${tolerance}), got ${actual}`);
}

// ---- Fixture: a minimal but representative cost model ----
function makeModel() {
  return {
    laborLines: [
      // 100K hours @ $20 fully-loaded = $2.0M, routed to outbound bucket
      { activity_name: 'Pick', annual_hours: 100000, hourly_rate: 20, burden_pct: 0, benefits_per_hour: 0, pricing_bucket: 'outbound' },
    ],
    indirectLaborLines: [
      // 5K hours @ $30 = $150K, unassigned (rollup target)
      { role: 'Supervisor', annual_hours: 5000, hourly_rate: 30, burden_pct: 0, benefits_per_hour: 0 },
    ],
    equipmentLines: [
      // $120K display cost = 1 forklift × $10K monthly_maintenance × 12 months
      // (capital path, no acquisition cost so no amort component)
      {
        name: 'Forklifts',
        acquisition_type: 'capital',
        quantity: 1,
        monthly_maintenance: 10_000,
        acquisition_cost: 0,
        amort_years: 5,
        pricing_bucket: 'outbound',
      },
    ],
    overheadLines: [
      // $240K/yr → mgmt_fee
      { category: 'Management', annual_cost: 240000, pricing_bucket: 'mgmt_fee' },
    ],
    vasLines: [],
    startupLines: [
      // $50K one-time amortized over 5 years = $10K/yr
      { name: 'Racking install', one_time_cost: 50000, pricing_bucket: 'mgmt_fee' },
    ],
    pricingBuckets: [
      { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed',    uom: 'month' },
      { id: 'outbound', name: 'Outbound Handling', type: 'variable', uom: 'order' },
    ],
    volumeLines: [
      { uom: 'order', volume: 1_000_000, isOutboundPrimary: true },
    ],
    facility: {},
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
    financial: { facilityBucketId: null },
  };
}

function makeSummary(model) {
  return computeSummary({
    laborLines: model.laborLines,
    indirectLaborLines: model.indirectLaborLines,
    equipmentLines: model.equipmentLines,
    overheadLines: model.overheadLines,
    vasLines: model.vasLines,
    startupLines: model.startupLines,
    facility: model.facility,
    shifts: model.shifts,
    contractYears: 5,
    targetMarginPct: 12,
    annualOrders: 1_000_000,
  });
}

// ---- Tests ----

test('returns the canonical 4-key shape', () => {
  const model = makeModel();
  const summary = makeSummary(model);
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 5,
  });
  assert(snap && typeof snap === 'object', 'snap must be object');
  assert(Array.isArray(snap.buckets), 'buckets must be array');
  assert(snap.bucketCosts && typeof snap.bucketCosts === 'object', 'bucketCosts must be object');
  assert(typeof snap.unassignedCount === 'number', 'unassignedCount must be number');
  assert(Array.isArray(snap.unassignedLines), 'unassignedLines must be array');
});

test('routes assigned costs to their target buckets', () => {
  const model = makeModel();
  const summary = makeSummary(model);
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 5,
  });
  // outbound: $2.0M labor + $120K equipment = $2.12M
  near(snap.bucketCosts['outbound'], 2_120_000, 1, 'outbound bucket');
  // mgmt_fee: $240K overhead + ($50K / 5) startup amort = $250K
  near(snap.bucketCosts['mgmt_fee'], 250_000, 1, 'mgmt_fee bucket');
});

test('startup amort respects contractYears param (3yr → ~$16.67K, not 5yr→$10K)', () => {
  const model = makeModel();
  const summary = makeSummary(model);
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 3,
  });
  // mgmt_fee: $240K overhead + ($50K / 3) startup = $256,666
  near(snap.bucketCosts['mgmt_fee'], 256_666.67, 1, 'mgmt_fee with 3yr amort');
});

test('contractYears defaults to 5 when zero/missing', () => {
  const model = makeModel();
  const summary = makeSummary(model);
  // Zero contractYears should fall back to 5 (matches Math.max(1, ...) in body)
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 0,
  });
  near(snap.bucketCosts['mgmt_fee'], 250_000, 1, 'mgmt_fee with 0 contractYears falls back to 5yr');
});

test('counts unassigned indirect labor in unassignedCount + unassignedLines', () => {
  const model = makeModel();
  const summary = makeSummary(model);
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 5,
  });
  // Indirect supervisor has no pricing_bucket → unassigned
  assert(snap.unassignedCount === 1, `expected 1 unassigned, got ${snap.unassignedCount}`);
  assert(snap.unassignedLines[0].type === 'indirect', 'first unassigned should be indirect');
  assert(snap.unassignedLines[0].line.role === 'Supervisor', 'unassigned line should be Supervisor');
});

test('zero unassignedCount when every line is assigned', () => {
  const model = makeModel();
  // Assign the orphan indirect line
  model.indirectLaborLines[0].pricing_bucket = 'mgmt_fee';
  const summary = makeSummary(model);
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 5,
  });
  assert(snap.unassignedCount === 0, `expected 0 unassigned, got ${snap.unassignedCount}`);
});

test('enriched buckets carry derived recommended rates', () => {
  const model = makeModel();
  const summary = makeSummary(model);
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 5,
  });
  const outbound = snap.buckets.find(b => b.id === 'outbound');
  assert(outbound, 'outbound bucket must exist in enriched output');
  // outbound: $2.12M cost / 0.88 margin / 1M orders ≈ $2.4091/order
  near(outbound.recommendedRate, 2.4091, 0.001, 'outbound recommendedRate');
  // No explicit override → rate equals recommendedRate
  near(outbound.rate, outbound.recommendedRate, 0.0001, 'outbound rate==recommendedRate');
});

test('explicit bucket rate override survives enrichment', () => {
  const model = makeModel();
  // Pin an explicit $3.00/order rate on outbound
  model.pricingBuckets[1].rate = 3.0;
  const summary = makeSummary(model);
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 5,
  });
  const outbound = snap.buckets.find(b => b.id === 'outbound');
  near(outbound.rate, 3.0, 0.0001, 'explicit rate wins');
  // Recommended is still populated for the UI's "Recommended" column
  near(outbound.recommendedRate, 2.4091, 0.001, 'recommendedRate populated alongside override');
});

test('tolerates missing arrays — empty model produces empty output', () => {
  const snap = computePricingSnapshot({
    model: {},
    summary: {},
    marginFrac: 0.12,
    opHrs: 8760,
    contractYears: 5,
  });
  assert(Array.isArray(snap.buckets), 'buckets array');
  assert(snap.buckets.length === 0, 'no buckets configured');
  assert(snap.unassignedCount === 0, 'no unassigned');
});

test('null model param does not throw', () => {
  // Defensive: chrome strip can call with a half-loaded model in the wild
  const snap = computePricingSnapshot({
    model: null,
    summary: null,
    marginFrac: 0,
    opHrs: 0,
    contractYears: 0,
  });
  assert(snap.unassignedCount === 0);
  assert(Array.isArray(snap.unassignedLines));
});

test('facilityBucketId routes facility cost into a bucket', () => {
  const model = makeModel();
  model.pricingBuckets.push({ id: 'occupancy', name: 'Occupancy', type: 'fixed', uom: 'month' });
  model.financial.facilityBucketId = 'occupancy';
  const summary = makeSummary(model);
  summary.facilityCost = 600_000; // override for the test
  const snap = computePricingSnapshot({
    model, summary, marginFrac: 0.12, opHrs: 8760, contractYears: 5,
  });
  near(snap.bucketCosts['occupancy'], 600_000, 1, 'facility routed to occupancy bucket');
});

// ---- Report ----

console.log();
if (failures.length) {
  console.log(failures.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`test-pricing-snapshot: ${passed} passed, 0 failed.`);

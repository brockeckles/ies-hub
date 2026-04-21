// Standalone Node ESM test runner for I-02 bucket-rate derivation.
// Verifies that computeBucketRates + enrichBucketsWithDerivedRates produce
// the same per-unit rate the Pricing UI shows, and that the monthly engine
// produces non-zero revenue when buckets lack an explicit .rate.
//
// Run:  node test-bucket-rates.mjs

import {
  computeBucketCosts,
  computeBucketRates,
  enrichBucketsWithDerivedRates,
} from './tools/cost-model/calc.js';
import {
  buildMonthlyProjections,
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
const buckets = [
  { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed',    uom: 'month' },
  { id: 'outbound', name: 'Outbound Handling', type: 'variable', uom: 'order' },
];

const laborLines = [
  // 100,000 annual hours at $20 fully-loaded = $2.0M, all assigned to outbound
  { activity_name: 'Pick', annual_hours: 100000, hourly_rate: 20, burden_pct: 0, benefits_per_hour: 0, pricing_bucket: 'outbound' },
];
const equipmentLines = [];
const overheadLines = [
  // $240K/yr of overhead routed to mgmt_fee
  { category: 'Management', annual_cost: 240000, pricing_bucket: 'mgmt_fee' },
];
const vasLines = [];
const startupLines = [];
const volumeLines = [
  { uom: 'order', volume: 1_000_000, isOutboundPrimary: true },
];

// ---- computeBucketRates ----

test('computeBucketCosts returns $2.0M for outbound and $240K for mgmt_fee', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  near(costs['outbound'], 2_000_000, 1, 'outbound cost');
  near(costs['mgmt_fee'], 240_000, 1, 'mgmt_fee cost');
});

test('derived variable rate = cost/(1−m) / annualVolume (reference-aligned gross-up)', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const rates = computeBucketRates({ buckets, bucketCosts: costs, marginPct: 0.12, volumeLines });
  // outbound: ($2.0M / 0.88) / 1M orders = $2.2727/order
  near(rates['outbound'].rate, 2.272727, 0.001);
  near(rates['outbound'].annualVolume, 1_000_000);
});

test('derived fixed rate = cost/(1−m) / 12 per month', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const rates = computeBucketRates({ buckets, bucketCosts: costs, marginPct: 0.12, volumeLines });
  // mgmt_fee: ($240K / 0.88) / 12 = $22,727.27/month
  near(rates['mgmt_fee'].rate, 22_727.27, 0.5);
});

test('enrichBucketsWithDerivedRates fills recommended rates when no override', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const enriched = enrichBucketsWithDerivedRates({
    buckets, bucketCosts: costs, marginPct: 0.12, volumeLines,
  });
  const outbound = enriched.find(b => b.id === 'outbound');
  const mgmt     = enriched.find(b => b.id === 'mgmt_fee');
  near(outbound.rate, 2.272727, 0.001);
  near(outbound.recommendedRate, 2.272727, 0.001, 'recommendedRate populated');
  near(mgmt.rate, 22_727.27, 0.5);
  assert(outbound._rateSource === 'recommended', 'should tag as recommended (no override)');
  assert(outbound._rateSourceLegacy === 'derived', 'legacy alias preserved');
  assert(outbound.overrideRate === null, 'no override set');
});

test('override bucket.rate wins over recommended, tags as override', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const overrideBuckets = [
    { ...buckets[0] },
    { ...buckets[1], rate: 5.00, overrideReason: 'customer counter-offer' },
  ];
  const enriched = enrichBucketsWithDerivedRates({
    buckets: overrideBuckets, bucketCosts: costs, marginPct: 0.12, volumeLines,
  });
  const outbound = enriched.find(b => b.id === 'outbound');
  near(outbound.rate, 5.00);
  near(outbound.recommendedRate, 2.272727, 0.001, 'recommended still computed');
  near(outbound.overrideRate, 5.00, 0.001, 'override captured');
  assert(outbound._rateSource === 'override', 'should tag as override');
  assert(outbound._rateSourceLegacy === 'explicit', 'legacy alias preserved');
  assert(outbound.overrideReason === 'customer counter-offer', 'reason captured');
  // Variance: override $5.00 vs recommended $2.27 = +$2.73 / +120%
  near(outbound.overrideDelta, 2.7273, 0.01);
  near(outbound.overrideDeltaPct, 1.20, 0.01);
});

// ---- Integration: monthly engine now produces non-zero revenue ----

test('monthly engine produces non-zero revenue when buckets lack explicit .rate (I-02 REGRESSION TEST)', () => {
  // Seed periods: 1 pre-go-live month + 12 operating months
  const periods = [];
  for (let i = -1; i < 12; i++) {
    const d = new Date(2026, 0 + i, 1);
    periods.push({
      id: i + 2, period_type: 'month', period_index: i,
      calendar_year: d.getFullYear(), calendar_month: d.getMonth() + 1,
      customer_fy_index: 1, customer_fm_index: (i % 12 + 12) % 12 + 1,
      label: `M${i + 1}`, is_pre_go_live: i < 0,
    });
  }

  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const enrichedBuckets = enrichBucketsWithDerivedRates({
    buckets, bucketCosts: costs, marginPct: 0.12, volumeLines,
  });

  const bundle = buildMonthlyProjections({
    project_id: 1, contract_term_years: 1, pre_go_live_months: 0,
    base_labor_cost: 2_000_000, base_facility_cost: 0, base_equipment_cost: 0,
    base_overhead_cost: 240_000, base_vas_cost: 0,
    startup_amort: 0, startup_capital: 0,
    base_orders: 1_000_000,
    margin_pct: 0.12,
    vol_growth_pct: 0, labor_esc_pct: 0, cost_esc_pct: 0, tax_rate_pct: 25,
    dso_days: 30, dpo_days: 30, labor_payable_days: 14,
    ramp: { type: 'medium', wk1_factor: 1, wk2_factor: 1, wk4_factor: 1, wk8_factor: 1, wk12_factor: 1 },
    seasonality: { monthly_shares: Array(12).fill(1/12) },
    periods,
    startupLines: [],
    pricingBuckets: enrichedBuckets, // ← the fix: rates are filled in
    laborLines: [],
  });

  const totalRev = bundle.revenue.reduce((s, r) => s + r.amount, 0);
  // Expected annual revenue = ($2.0M + $240K) / 0.88 = $2,545,454 (reference gross-up)
  near(totalRev, 2_545_455, 200, 'annual revenue from enriched buckets (gross-up form)');
  assert(totalRev > 0, 'revenue must be non-zero — this is the core I-02 regression');
});

test('monthly engine STILL produces $0 revenue when buckets have no rate AND are not enriched (captures pre-fix behavior)', () => {
  const periods = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(2026, i, 1);
    periods.push({
      id: i + 1, period_type: 'month', period_index: i,
      calendar_year: d.getFullYear(), calendar_month: d.getMonth() + 1,
      customer_fy_index: 1, customer_fm_index: i + 1,
      label: `M${i + 1}`, is_pre_go_live: false,
    });
  }
  const bundle = buildMonthlyProjections({
    project_id: 1, contract_term_years: 1, pre_go_live_months: 0,
    base_labor_cost: 2_000_000, base_facility_cost: 0, base_equipment_cost: 0,
    base_overhead_cost: 240_000, base_vas_cost: 0,
    startup_amort: 0, startup_capital: 0,
    base_orders: 1_000_000,
    margin_pct: 0.12,
    vol_growth_pct: 0, labor_esc_pct: 0, cost_esc_pct: 0, tax_rate_pct: 25,
    dso_days: 30, dpo_days: 30, labor_payable_days: 14,
    ramp: { type: 'medium', wk1_factor: 1, wk2_factor: 1, wk4_factor: 1, wk8_factor: 1, wk12_factor: 1 },
    seasonality: { monthly_shares: Array(12).fill(1/12) },
    periods,
    startupLines: [],
    // Bare buckets with no .rate — matches pre-fix behavior.
    pricingBuckets: buckets,
    laborLines: [],
  });
  const totalRev = bundle.revenue.reduce((s, r) => s + r.amount, 0);
  near(totalRev, 0, 0.01, 'unenriched buckets produce $0 — confirms the bug this test fixes');
});

// ---- I-01 edge: configurable facility bucket + orphan tracking ----

test('I-01 edge: facility cost routes to user-configured bucket when present', () => {
  const wayfairBuckets = [
    { id: 'bk_outbound', name: 'Outbound Fulfillment', type: 'variable', uom: 'order' },
  ];
  const costs = computeBucketCosts({
    buckets: wayfairBuckets,
    laborLines: [], indirectLaborLines: [], equipmentLines: [],
    overheadLines: [], vasLines: [], startupLines: [],
    facilityCost: 6_375_000,
    operatingHours: 8760,
    facilityBucketId: 'bk_outbound',
  });
  near(costs['bk_outbound'], 6_375_000, 1, 'facility went to configured bucket');
  assert(costs['_facilityOrphan'] === undefined || costs['_facilityOrphan'] === 0, 'no orphan');
  assert(costs['_facilityTarget'] === 'bk_outbound', 'target recorded');
});

test('I-01 edge: facility orphans when no target bucket configured AND none of storage/mgmt_fee/first exist', () => {
  // Pathological case: empty buckets array, can't route facility cost anywhere
  const costs = computeBucketCosts({
    buckets: [],
    laborLines: [], indirectLaborLines: [], equipmentLines: [],
    overheadLines: [], vasLines: [], startupLines: [],
    facilityCost: 6_375_000,
    operatingHours: 8760,
  });
  near(costs['_facilityOrphan'], 6_375_000, 1, 'orphan tracked');
  near(costs['_unassigned'], 6_375_000, 1, 'rolled to unassigned');
  assert(costs['_facilityTarget'] === null, 'target null');
});

test('I-01 edge: facility falls back to first non-startup bucket when storage/mgmt_fee absent', () => {
  // Wayfair-like: only outbound bucket exists, no storage, no mgmt_fee
  const wayfairBuckets = [
    { id: 'bk_outbound', name: 'Outbound', type: 'variable', uom: 'order' },
  ];
  const costs = computeBucketCosts({
    buckets: wayfairBuckets,
    laborLines: [], indirectLaborLines: [], equipmentLines: [],
    overheadLines: [], vasLines: [], startupLines: [],
    facilityCost: 6_375_000,
    operatingHours: 8760,
    // no facilityBucketId → should fall back to first non-startup bucket
  });
  near(costs['bk_outbound'], 6_375_000, 1, 'fell back to first bucket');
  assert(costs['_facilityTarget'] === 'bk_outbound', 'target recorded as fallback');
});

test('I-01 edge: legacy back-compat — facility goes to storage when present', () => {
  const legacyBuckets = [
    { id: 'storage',  name: 'Storage',  type: 'fixed', uom: 'month' },
    { id: 'outbound', name: 'Outbound', type: 'variable', uom: 'order' },
  ];
  const costs = computeBucketCosts({
    buckets: legacyBuckets,
    laborLines: [], indirectLaborLines: [], equipmentLines: [],
    overheadLines: [], vasLines: [], startupLines: [],
    facilityCost: 1_000_000,
    operatingHours: 8760,
  });
  near(costs['storage'], 1_000_000, 1, 'legacy storage routing preserved');
  assert(costs['_facilityTarget'] === 'storage');
});

// ---- Summary ----
console.log('\n');
if (failed > 0) {
  console.log(`${passed}/${passed + failed} passed — ${failed} FAILED`);
  console.log(failures.join('\n'));
  process.exit(1);
} else {
  console.log(`${passed}/${passed} passed`);
}

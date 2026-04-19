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

test('derived variable rate = withMargin / annualVolume', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const rates = computeBucketRates({ buckets, bucketCosts: costs, marginPct: 0.12, volumeLines });
  // outbound: ($2.0M * 1.12) / 1M orders = $2.24/order
  near(rates['outbound'].rate, 2.24, 0.001);
  near(rates['outbound'].annualVolume, 1_000_000);
});

test('derived fixed rate = withMargin / 12 per month', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const rates = computeBucketRates({ buckets, bucketCosts: costs, marginPct: 0.12, volumeLines });
  // mgmt_fee: ($240K * 1.12) / 12 = $22,400/month
  near(rates['mgmt_fee'].rate, 22_400, 0.1);
});

test('enrichBucketsWithDerivedRates fills missing rates', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const enriched = enrichBucketsWithDerivedRates({
    buckets, bucketCosts: costs, marginPct: 0.12, volumeLines,
  });
  const outbound = enriched.find(b => b.id === 'outbound');
  const mgmt     = enriched.find(b => b.id === 'mgmt_fee');
  near(outbound.rate, 2.24, 0.001);
  near(mgmt.rate, 22_400, 0.1);
  assert(outbound._rateSource === 'derived', 'should tag as derived');
});

test('explicit bucket.rate wins over derived', () => {
  const costs = computeBucketCosts({
    buckets, laborLines, indirectLaborLines: [], equipmentLines, overheadLines,
    vasLines, startupLines, facilityCost: 0, operatingHours: 8760,
  });
  const explicitBuckets = [
    { ...buckets[0] },
    { ...buckets[1], rate: 5.00 }, // user-pinned
  ];
  const enriched = enrichBucketsWithDerivedRates({
    buckets: explicitBuckets, bucketCosts: costs, marginPct: 0.12, volumeLines,
  });
  const outbound = enriched.find(b => b.id === 'outbound');
  near(outbound.rate, 5.00);
  assert(outbound._rateSource === 'explicit', 'should tag as explicit');
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
  // Expected annual revenue = ($2.0M + $240K) * 1.12 = $2.5088M
  near(totalRev, 2_508_800, 100, 'annual revenue from enriched buckets');
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

// ---- Summary ----
console.log('\n');
if (failed > 0) {
  console.log(`${passed}/${passed + failed} passed — ${failed} FAILED`);
  console.log(failures.join('\n'));
  process.exit(1);
} else {
  console.log(`${passed}/${passed} passed`);
}

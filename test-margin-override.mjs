// Standalone Node ESM test runner for the Margin Handling rewire (2026-04-21).
// Covers:
//   - grossUp() canonical form Cost / (1 − m)
//   - achievedMargin() inverse
//   - computeOverrideImpact() per-bucket + rollup
//   - Reframed M3 validator: achieved-vs-target margin under overrides
//   - Per-category revenue breakout on computeSummary + buildYearlyProjections
//
// Run:  node test-margin-override.mjs

import {
  grossUp,
  achievedMargin,
  computeBucketCosts,
  computeBucketRates,
  enrichBucketsWithDerivedRates,
  computeOverrideImpact,
  computeSummary,
  buildYearlyProjections,
  validateModel,
} from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function near(actual, expected, tol = 0.01, msg = '') {
  if (Math.abs(actual - expected) > tol) throw new Error(`${msg} expected ~${expected}, got ${actual}`);
}

// ============================================================
// grossUp() — canonical formula
// ============================================================

test('grossUp: Cost / (1 − m) at 16% — reference Part I §3', () => {
  // Reference doc §3 table: cost / (1 − 0.16) = cost × 1.1905
  near(grossUp(1_000_000, 0.16), 1_190_476.19, 0.5);
});

test('grossUp: 20% margin → cost × 1.25', () => {
  near(grossUp(1_000_000, 0.20), 1_250_000, 0.5);
});

test('grossUp: 0% margin returns cost unchanged', () => {
  near(grossUp(1_000_000, 0), 1_000_000, 0.01);
});

test('grossUp: 100% margin guard — floors at 99.9% to avoid Infinity', () => {
  const r = grossUp(1000, 1.0);
  assert(isFinite(r), `should be finite, got ${r}`);
  // 1000 / 0.001 = 1,000,000
  near(r, 1_000_000, 1);
});

test('grossUp: negative margin coerces to 0', () => {
  near(grossUp(1000, -0.1), 1000, 0.01);
});

// ============================================================
// achievedMargin() — inverse
// ============================================================

test('achievedMargin: (rev − cost) / rev', () => {
  near(achievedMargin(1_190_476, 1_000_000), 0.16, 0.001);
});

test('achievedMargin: grossUp round-trip at 12%', () => {
  const rev = grossUp(5_000_000, 0.12);
  near(achievedMargin(rev, 5_000_000), 0.12, 0.001);
});

test('achievedMargin: zero revenue returns 0 (no divide-by-zero)', () => {
  near(achievedMargin(0, 1000), 0, 0.001);
});

// ============================================================
// computeOverrideImpact — the override-rollup helper
// ============================================================

const fixtureBuckets = [
  { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed', uom: 'month' },
  { id: 'outbound', name: 'Outbound', type: 'variable', uom: 'order' },
];
const fixtureLabor = [
  { activity_name: 'Pick', annual_hours: 100_000, hourly_rate: 20, burden_pct: 0, benefits_per_hour: 0, pricing_bucket: 'outbound' },
];
const fixtureOverhead = [
  { category: 'Mgmt', annual_cost: 240_000, pricing_bucket: 'mgmt_fee' },
];
const fixtureVolumes = [{ uom: 'order', volume: 1_000_000, isOutboundPrimary: true }];

function buildFixtureEnriched(overrides = {}) {
  const costs = computeBucketCosts({
    buckets: fixtureBuckets,
    laborLines: fixtureLabor,
    indirectLaborLines: [], equipmentLines: [],
    overheadLines: fixtureOverhead, vasLines: [], startupLines: [],
    facilityCost: 0, operatingHours: 8760,
  });
  const bucketsWithOverrides = fixtureBuckets.map(b => ({ ...b, ...(overrides[b.id] || {}) }));
  return enrichBucketsWithDerivedRates({
    buckets: bucketsWithOverrides, bucketCosts: costs,
    marginPct: 0.12, volumeLines: fixtureVolumes,
  });
}

test('computeOverrideImpact: no overrides → zero delta, all tagged recommended', () => {
  const enriched = buildFixtureEnriched();
  const impact = computeOverrideImpact(enriched);
  near(impact.totalOverrideDelta, 0, 0.01);
  assert(impact.overriddenBucketCount === 0, 'zero override count');
  near(impact.totalRecommendedRevenue, impact.totalEffectiveRevenue, 0.01);
});

test('computeOverrideImpact: variable override below recommended → negative delta', () => {
  // Recommended outbound: $2.0M / 0.88 / 1M = $2.2727/order.
  // Override to $2.00/order → $0.2727 shortfall × 1M orders = −$272,727/yr.
  const enriched = buildFixtureEnriched({ outbound: { rate: 2.00 } });
  const impact = computeOverrideImpact(enriched);
  assert(impact.overriddenBucketCount === 1, 'one override');
  const outbound = impact.perBucket.find(b => b.id === 'outbound');
  near(outbound.deltaAnnual, -272_727, 100, 'outbound annual delta');
  near(outbound.deltaPct, -0.12, 0.001, 'outbound pct delta');
  assert(outbound.isOverridden, 'tagged overridden');
});

test('computeOverrideImpact: fixed override above recommended → positive delta', () => {
  // Recommended mgmt_fee: $240K / 0.88 / 12 = $22,727.27/mo.
  // Override to $25,000/mo → $2,272.73 × 12 = +$27,273/yr.
  const enriched = buildFixtureEnriched({ mgmt_fee: { rate: 25_000 } });
  const impact = computeOverrideImpact(enriched);
  const mgmt = impact.perBucket.find(b => b.id === 'mgmt_fee');
  near(mgmt.deltaAnnual, 27_273, 200, 'mgmt annual delta');
  near(mgmt.deltaPct, 0.10, 0.005, 'mgmt pct delta');
});

test('computeOverrideImpact: mixed overrides aggregate correctly', () => {
  const enriched = buildFixtureEnriched({
    outbound: { rate: 2.00, overrideReason: 'customer counter-offer' },
    mgmt_fee: { rate: 25_000 },
  });
  const impact = computeOverrideImpact(enriched);
  assert(impact.overriddenBucketCount === 2);
  // Total delta: −$272,727 + $27,273 = −$245,454
  near(impact.totalOverrideDelta, -245_454, 300);
  const outbound = impact.perBucket.find(b => b.id === 'outbound');
  assert(outbound.overrideReason === 'customer counter-offer', 'reason flows through');
});

// ============================================================
// Reframed M3 validator — achieved vs target margin under overrides
// ============================================================

function baseValidModel(overrideRate = null) {
  const buckets = fixtureBuckets.map(b => ({ ...b }));
  if (overrideRate !== null) {
    buckets.find(b => b.id === 'outbound').rate = overrideRate;
  }
  return {
    projectDetails: { name: 'test', market: 'MEM', contractTerm: 5 },
    facility: { totalSqft: 500_000 },
    financial: { targetMargin: 12 },
    laborLines: fixtureLabor.map(l => ({ ...l })),
    indirectLaborLines: [], equipmentLines: [],
    overheadLines: fixtureOverhead.map(o => ({ ...o })),
    vasLines: [], startupLines: [],
    volumeLines: [{ name: 'orders', volume: 1_000_000, isOutboundPrimary: true, uom: 'order' }],
    shifts: { shiftsPerDay: 1 },
    pricingBuckets: buckets,
  };
}

test('validateModel M3: silent when no overrides (achieved ≡ target)', () => {
  const m = baseValidModel(null);
  const ws = validateModel(m);
  const m3 = ws.filter(w => /achieved margin/i.test(w.message));
  assert(m3.length === 0, `should be silent; got ${JSON.stringify(m3)}`);
});

test('validateModel M3: silent when override keeps achieved within 2pp of target', () => {
  // Recommended outbound = $2.2727/order. Override to $2.24 — small shortfall
  // ($32.7K revenue delta on $2.5M total → ~1.3pp margin shift).
  const m = baseValidModel(2.24);
  const ws = validateModel(m);
  const m3 = ws.filter(w => /achieved margin/i.test(w.message));
  assert(m3.length === 0, `should be silent; got ${JSON.stringify(m3)}`);
});

test('validateModel M3: WARN when override pushes achieved 2pp+ below target', () => {
  // Override outbound to $2.00/order → achieved margin drops by ~12% of
  // outbound revenue share, plenty for a >2pp dip below 12% target.
  const m = baseValidModel(2.00);
  const ws = validateModel(m);
  const m3 = ws.find(w => /achieved margin/i.test(w.message));
  assert(m3, 'should produce M3 warning');
  assert(m3.level === 'warning' || m3.level === 'error', `got level ${m3.level}`);
});

test('validateModel M3: ERROR at 5pp+ below target', () => {
  // Override outbound to $1.50/order → huge shortfall (~34% below recommended
  // on the larger of the two buckets), drives achieved deep negative.
  const m = baseValidModel(1.50);
  const ws = validateModel(m);
  const m3 = ws.find(w => /achieved margin/i.test(w.message));
  assert(m3, 'should produce M3 message');
  assert(m3.level === 'error', `expected error, got ${m3.level}`);
});

// ============================================================
// Per-category revenue breakout
// ============================================================

test('computeSummary: exposes per-category revenue summing to totalRevenue', () => {
  const s = computeSummary({
    laborLines: [{ activity_name: 'x', annual_hours: 10_000, hourly_rate: 20, burden_pct: 0, benefits_per_hour: 0 }],
    indirectLaborLines: [],
    equipmentLines: [],
    overheadLines: [{ category: 'oh', annual_cost: 100_000 }],
    vasLines: [{ service: 'v', total_cost: 50_000 }],
    startupLines: [],
    facility: { totalSqft: 100_000 },
    shifts: { shiftsPerDay: 1 },
    contractYears: 5,
    targetMarginPct: 16,
    annualOrders: 1_000_000,
  });
  assert(s.laborRevenue > 0, 'laborRevenue exposed');
  assert(s.facilityRevenue >= 0, 'facilityRevenue exposed');
  assert(s.equipmentRevenue >= 0, 'equipmentRevenue exposed');
  assert(s.overheadRevenue > 0, 'overheadRevenue exposed');
  assert(s.vasRevenue > 0, 'vasRevenue exposed');
  assert(s.startupRevenue >= 0, 'startupRevenue exposed');
  const sum = s.laborRevenue + s.facilityRevenue + s.equipmentRevenue +
              s.overheadRevenue + s.vasRevenue + s.startupRevenue;
  near(sum, s.totalRevenue, 0.5, 'sum of categories = totalRevenue');
});

test('computeSummary: revenue math is gross-up form (cost / (1-m)) not markup', () => {
  const s = computeSummary({
    laborLines: [{ activity_name: 'x', annual_hours: 100_000, hourly_rate: 20, burden_pct: 0, benefits_per_hour: 0 }],
    indirectLaborLines: [], equipmentLines: [], overheadLines: [], vasLines: [], startupLines: [],
    facility: { totalSqft: 0 },
    shifts: { shiftsPerDay: 1 },
    contractYears: 5,
    targetMarginPct: 20,
    annualOrders: 1,
  });
  // Labor cost = 100K hrs × $20 = $2M. Revenue should be $2M / 0.80 = $2.5M.
  // (NOT $2M × 1.20 = $2.4M — that was the old markup form.)
  near(s.totalRevenue, 2_500_000, 1_000, 'reference gross-up');
  assert(s.totalRevenue > s.totalCost * 1.20, 'stricter than markup form');
});

test('buildYearlyProjections: per-category revenue on each year', () => {
  const { projections } = buildYearlyProjections({
    years: 3,
    baseLaborCost: 2_000_000, baseFacilityCost: 500_000,
    baseEquipmentCost: 200_000, baseOverheadCost: 100_000, baseVasCost: 50_000,
    startupAmort: 0, startupCapital: 0,
    baseOrders: 1_000_000, marginPct: 0.16,
    volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
    laborLines: [], taxRatePct: 25,
    useMonthlyEngine: false,
  });
  const y1 = projections[0];
  assert(y1.laborRevenue > 0, 'y1 laborRevenue');
  assert(y1.facilityRevenue > 0, 'y1 facilityRevenue');
  assert(y1.equipmentRevenue > 0, 'y1 equipmentRevenue');
  const catSum = y1.laborRevenue + y1.facilityRevenue + y1.equipmentRevenue +
                 y1.overheadRevenue + y1.vasRevenue + y1.startupRevenue;
  near(catSum, y1.revenue, 1, 'yr1 category sum = total revenue');
});

// ============================================================
// Summary
// ============================================================
console.log('\n');
if (failed > 0) {
  console.log(`${passed}/${passed + failed} passed — ${failed} FAILED`);
  console.log(failures.join('\n'));
  process.exit(1);
} else {
  console.log(`${passed}/${passed} passed`);
  console.log('Margin Handling rewire invariants pass ✓');
}

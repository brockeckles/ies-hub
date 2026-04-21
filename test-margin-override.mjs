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
  computeStackedRevenue,
  computeImplicationsImpact,
  computeSgaOverlay,
  computeSummary,
  buildYearlyProjections,
  totalStartupAmort,
  totalStartupCapital,
  totalStartupAsIncurred,
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
// computeStackedRevenue() — reference Part I §4 two-step decomposition
// ============================================================

test('computeStackedRevenue: G&A + Mgmt sum equals gross-up total', () => {
  const r = computeStackedRevenue({ cost: 1_000_000, gaPct: 0.06, mgmtPct: 0.10 });
  // cost / (1 - 0.16) = 1,190,476.19
  near(r.totalRevenue, 1_190_476.19, 0.5);
  // Sum invariant
  near(r.cost + r.gaComponent + r.mgmtComponent, r.totalRevenue, 0.01, 'stack sum invariant');
});

test('computeStackedRevenue: 6/10 split matches reference model defaults', () => {
  // At Cost=$1M, g=0.06, m=0.10, t=0.16:
  //   G&A component  = 1M × 0.06 / 0.84 = 71,428.57
  //   Mgmt component = 1M × 0.10 / 0.84 = 119,047.62
  //   Total revenue  = 1M + 71,428.57 + 119,047.62 = 1,190,476.19 ≡ 1M / 0.84 ✓
  const r = computeStackedRevenue({ cost: 1_000_000, gaPct: 0.06, mgmtPct: 0.10 });
  near(r.gaComponent, 71_428.57, 0.5, 'G&A at 6/16 split');
  near(r.mgmtComponent, 119_047.62, 0.5, 'Mgmt at 10/16 split');
  near(r.totalRevenue, 1_190_476.19, 0.5, 'reconciles to gross-up');
  // Layered semantics: (Cost + G&A) × (1 / (1 − m)) must equal totalRevenue.
  near((r.cost + r.gaComponent) / (1 - 0.10), r.totalRevenue, 0.5, 'layered semantics');
});

test('computeStackedRevenue: zero margin → zero components', () => {
  const r = computeStackedRevenue({ cost: 500_000, gaPct: 0, mgmtPct: 0 });
  near(r.gaComponent, 0, 0.01);
  near(r.mgmtComponent, 0, 0.01);
  near(r.totalRevenue, 500_000, 0.01);
});

test('computeStackedRevenue: handles 0% cost (degenerate)', () => {
  const r = computeStackedRevenue({ cost: 0, gaPct: 0.06, mgmtPct: 0.10 });
  near(r.totalRevenue, 0, 0.01);
  near(r.gaComponent, 0, 0.01);
  near(r.mgmtComponent, 0, 0.01);
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
// computeImplicationsImpact() — Override Implications Panel tile values
// ============================================================

test('computeImplicationsImpact: zero override → all tiles zero', () => {
  const r = computeImplicationsImpact({
    totalOverrideDeltaY1: 0,
    baselineAnnualRevenue: 10_000_000, baselineAnnualCost: 8_000_000,
    startupCapital: 500_000,
  });
  assert(!r.hasOverrides, 'hasOverrides false');
  near(r.y1RevDelta, 0);
  near(r.y1EbitdaDelta, 0);
  near(r.fiveYrNpvDelta, 0);
  near(r.paybackShiftMonths, 0);
});

test('computeImplicationsImpact: negative override propagates to all tiles', () => {
  const r = computeImplicationsImpact({
    totalOverrideDeltaY1: -500_000, // $500K/yr revenue shortfall
    baselineAnnualRevenue: 10_000_000, baselineAnnualCost: 8_000_000, // EBIT = $2M positive
    startupCapital: 500_000,
    years: 5, volGrowthPct: 5, taxRatePct: 25, discountRatePct: 10,
  });
  assert(r.hasOverrides, 'hasOverrides true');
  near(r.y1RevDelta, -500_000, 1);
  // EBITDA Δ == Revenue Δ (cost unchanged, SG&A category-based)
  near(r.y1EbitdaDelta, -500_000, 1);
  // 5-yr NPV Δ: after-tax revenue delta discounted over 5 years w/ 5% growth
  // Year 1: -500K × 0.75 / 1.10 = -340,909
  // Year 2: -525K × 0.75 / 1.21 = -325,413
  // ... NPV should be ~ -$1.5M ballpark
  assert(r.fiveYrNpvDelta < -1_000_000 && r.fiveYrNpvDelta > -3_000_000,
    `NPV Δ should be ~ -$1.5M band, got ${r.fiveYrNpvDelta}`);
  // Payback shift should be positive (payback extends since FCF drops)
  assert(r.paybackShiftMonths > 0, `payback should extend, got ${r.paybackShiftMonths}`);
});

test('computeImplicationsImpact: positive override shortens payback', () => {
  const r = computeImplicationsImpact({
    totalOverrideDeltaY1: +200_000,
    baselineAnnualRevenue: 10_000_000, baselineAnnualCost: 8_000_000,
    startupCapital: 500_000,
    years: 5, taxRatePct: 25, discountRatePct: 10,
  });
  near(r.y1RevDelta, 200_000, 1);
  assert(r.fiveYrNpvDelta > 0, 'positive override lifts NPV');
  assert(r.paybackShiftMonths < 0, 'positive override shortens payback');
});

test('computeImplicationsImpact: no tax shield when baseline EBIT is negative', () => {
  const r = computeImplicationsImpact({
    totalOverrideDeltaY1: -100_000,
    baselineAnnualRevenue: 1_000_000, baselineAnnualCost: 1_500_000, // EBIT = -$500K
    startupCapital: 0,
    taxRatePct: 25,
  });
  // No tax shield — FCF delta equals revenue delta (not × (1-tax))
  near(r.y1EbitdaDelta, -100_000, 1);
  // NPV reflects no tax shield
  // Year 1: -100K / 1.10 = -90,909, ... over 5 years w/ 0 growth: ~-$379K
  assert(r.fiveYrNpvDelta < -350_000, `NPV Δ without tax shield, got ${r.fiveYrNpvDelta}`);
});

test('computeImplicationsImpact: payback shift guarded against pathological cases', () => {
  // Override flips FCF sign — helper should cap payback shift at ±600 months
  const r = computeImplicationsImpact({
    totalOverrideDeltaY1: -5_000_000, // catastrophic override
    baselineAnnualRevenue: 10_000_000, baselineAnnualCost: 8_000_000,
    startupCapital: 500_000,
    taxRatePct: 25,
  });
  assert(isFinite(r.paybackShiftMonths), 'finite');
  assert(Math.abs(r.paybackShiftMonths) <= 600, `capped, got ${r.paybackShiftMonths}`);
});

// ============================================================
// computeSgaOverlay() — M2 reference Part I §5
// ============================================================

test('computeSgaOverlay: default 0 returns 0', () => {
  near(computeSgaOverlay({ revenue: 10_000_000, sgaOverlayPct: 0 }), 0, 0.01);
});

test('computeSgaOverlay: 4.5% of gross revenue when applies_to=gross_revenue', () => {
  near(computeSgaOverlay({ revenue: 10_000_000, sgaOverlayPct: 4.5, appliesTo: 'gross_revenue' }), 450_000, 0.5);
});

test('computeSgaOverlay: 4.5% of net revenue excludes pass-through', () => {
  // Gross revenue = $10M. Pass-through (as-incurred, deferred) = $2M. Net = $8M.
  // Overlay = 4.5% × $8M = $360,000.
  near(computeSgaOverlay({
    revenue: 10_000_000, passThroughRevenue: 2_000_000,
    sgaOverlayPct: 4.5, appliesTo: 'net_revenue',
  }), 360_000, 0.5);
});

test('computeSgaOverlay: pct capped at 50%', () => {
  near(computeSgaOverlay({ revenue: 1_000_000, sgaOverlayPct: 100 }), 500_000, 1,
    'overlay pct clamped');
});

test('buildYearlyProjections: sgaOverlayPct flows through to sga + EBITDA', () => {
  const baseline = buildYearlyProjections({
    years: 1,
    baseLaborCost: 2_000_000, baseFacilityCost: 500_000,
    baseEquipmentCost: 100_000, baseOverheadCost: 100_000, baseVasCost: 0,
    startupAmort: 0, startupCapital: 0,
    baseOrders: 1_000_000, marginPct: 0.16,
    volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
    taxRatePct: 25, useMonthlyEngine: false,
    sgaOverlayPct: 0,
  });
  const overlay = buildYearlyProjections({
    years: 1,
    baseLaborCost: 2_000_000, baseFacilityCost: 500_000,
    baseEquipmentCost: 100_000, baseOverheadCost: 100_000, baseVasCost: 0,
    startupAmort: 0, startupCapital: 0,
    baseOrders: 1_000_000, marginPct: 0.16,
    volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
    taxRatePct: 25, useMonthlyEngine: false,
    sgaOverlayPct: 4.5,
  });
  // Baseline SGA = overhead category = $100K. EBITDA = revenue − cogs − 100K.
  // Overlay SGA = $100K + 4.5% × revenue. EBITDA decreases by 4.5% × revenue.
  const rev = baseline.projections[0].revenue;
  near(overlay.projections[0].sgaOverlay, rev * 0.045, 1,
    'overlay = 4.5% × revenue');
  near(overlay.projections[0].sga - baseline.projections[0].sga, rev * 0.045, 1,
    'SGA delta = overlay amount');
  near(overlay.projections[0].ebitda - baseline.projections[0].ebitda, -rev * 0.045, 1,
    'EBITDA drops by overlay amount');
});

// ============================================================
// Startup as-incurred sub-branch (reference Part I §9)
// ============================================================

test('totalStartupAmort: skips as-incurred lines', () => {
  const lines = [
    { description: 'Cap A', one_time_cost: 100_000, billing_type: 'capitalized' },
    { description: 'PM B',  one_time_cost: 50_000,  billing_type: 'as_incurred' },
    { description: 'Default', one_time_cost: 30_000 },  // no billing_type → capitalized
  ];
  // Amortize $100K + $30K = $130K over 5 years = $26K/yr. Skip $50K as-incurred.
  near(totalStartupAmort(lines, 5), 26_000, 1);
});

test('totalStartupCapital: excludes as-incurred lines', () => {
  const lines = [
    { one_time_cost: 100_000, billing_type: 'capitalized' },
    { one_time_cost: 50_000,  billing_type: 'as_incurred' },
  ];
  // Capital includes only the $100K capitalized line.
  near(totalStartupCapital(lines), 100_000, 1);
});

test('totalStartupAsIncurred: sums only as-incurred lines', () => {
  const lines = [
    { one_time_cost: 100_000, billing_type: 'capitalized' },
    { one_time_cost: 50_000,  billing_type: 'as_incurred' },
    { one_time_cost: 25_000,  billing_type: 'as_incurred' },
  ];
  near(totalStartupAsIncurred(lines), 75_000, 1);
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

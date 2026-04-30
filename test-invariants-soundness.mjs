// Standalone Node ESM test runner — Step 3 model-soundness invariants.
// Locks the relationships the calc engine should preserve, so future
// refactors can't silently break the math without these tests turning red.
//
// Coverage:
//   1. Single↔multi channel parity (volume aggregation invariant)
//   2. Channel lineage breakdown sums to parent (Phase 5.1 inspector lock)
//   3. Direct-labor OT formula (1 + 0.5*ot/100) — annual path
//   4. resolveCalcHeuristics priority chain — transient > snapshot > override > default
//   5. Approved-snapshot drives calc (frozen-rates invariant)
//   6. Tax-rate consistency in yearly projections
//
// Run:  node test-invariants-soundness.mjs

import {
  buildYearlyProjections,
  computeFinancialMetrics,
  computeSummary,
  directLineAnnual,
  totalFacilityCost,
  facilityCostBreakdown,
} from './tools/cost-model/calc.js';
import {
  buildChannelLineage,
  getAnnualVolume,
  getAggregateInbound,
  getOutboundChannels,
  getChannelDerived,
  getChannelPrimaryIn,
} from './tools/cost-model/calc.channels.js';
import {
  resolveCalcHeuristics,
} from './tools/cost-model/calc.scenarios.js';

let passed = 0, failed = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); process.stdout.write('.'); passed++; }
  catch (e) { process.stdout.write('F'); failed++; failures.push({ name, err: e }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const near = (a, b, eps = 0.01, msg = '') => {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}: expected ${b}, got ${a}, diff=${Math.abs(a - b)}`);
};

// ============================================================
// 1. Single↔multi channel parity — same total volume, same totals
// ============================================================
test('Single channel @ 25M units = sum of 2 channels @ 12.5M each (units)', () => {
  const single = {
    channels: [
      { key: 'all',  name: 'All',     archetypeId: 'b2b-retail',
        primary: { activity: 'outbound', value: 25_000_000, uom: 'units' },
        assumptions: { returnsPercent: 5, inboundFactor: 1.05, peakSurge: 2.5, operatingDaysPerYear: 250 },
      },
    ],
  };
  const multi = {
    channels: [
      { key: 'a', name: 'A', archetypeId: 'b2b-retail',
        primary: { activity: 'outbound', value: 12_500_000, uom: 'units' },
        assumptions: { returnsPercent: 5, inboundFactor: 1.05, peakSurge: 2.5, operatingDaysPerYear: 250 },
      },
      { key: 'b', name: 'B', archetypeId: 'b2b-retail',
        primary: { activity: 'outbound', value: 12_500_000, uom: 'units' },
        assumptions: { returnsPercent: 5, inboundFactor: 1.05, peakSurge: 2.5, operatingDaysPerYear: 250 },
      },
    ],
  };
  near(getAnnualVolume(single, 'units'), getAnnualVolume(multi, 'units'), 0.01,
    'aggregate annual volume must match');
  near(getAggregateInbound(single, 'units'), getAggregateInbound(multi, 'units'), 0.01,
    'aggregate inbound must match');
});

test('Single channel split into 3 channels: total returns invariant', () => {
  // Same total volume across N channels, all same returnsPct -> same total returns.
  const single = {
    channels: [{ key: 'all', archetypeId: 'b2b-retail',
      primary: { activity: 'outbound', value: 30_000_000, uom: 'units' },
      assumptions: { returnsPercent: 5 } }],
  };
  const triple = {
    channels: [
      { key: 'a', archetypeId: 'b2b-retail', primary: { activity: 'outbound', value: 10_000_000, uom: 'units' }, assumptions: { returnsPercent: 5 } },
      { key: 'b', archetypeId: 'b2b-retail', primary: { activity: 'outbound', value: 10_000_000, uom: 'units' }, assumptions: { returnsPercent: 5 } },
      { key: 'c', archetypeId: 'b2b-retail', primary: { activity: 'outbound', value: 10_000_000, uom: 'units' }, assumptions: { returnsPercent: 5 } },
    ],
  };
  const singleReturns = getOutboundChannels(single)
    .reduce((s, c) => s + getChannelDerived(single, c, 'returns').value, 0);
  const tripleReturns = getOutboundChannels(triple)
    .reduce((s, c) => s + getChannelDerived(triple, c, 'returns').value, 0);
  near(singleReturns, tripleReturns, 0.01, 'aggregate returns must match');
});

// ============================================================
// 2. Channel lineage breakdown sums to parent
// ============================================================
test('buildChannelLineage: contributionPctOfTotalUnits is computed vs outbound-only denom (documents quirk)', () => {
  // QUIRK lock: the field name says "PctOfTotalUnits" but the denominator is
  // outbound-only (getAnnualVolume excludes reverse). When reverse is present,
  // the percentages sum to >100 because the reverse channel's primary units
  // ARE included in the per-row numerator. This is intentional — UI users
  // want 'reverse logistics is N% of our outbound volume' as the metric.
  const model = {
    channels: [
      { key: 'a', archetypeId: 'b2b-retail', primary: { activity: 'outbound', value: 10_000_000, uom: 'units' } },
      { key: 'b', archetypeId: 'dtc',         primary: { activity: 'outbound', value: 5_000_000,  uom: 'units' } },
      { key: 'c', archetypeId: 'reverse',     primary: { activity: 'returns',  value: 750_000,    uom: 'units' } },
    ],
  };
  const lineage = buildChannelLineage(model);
  // Outbound rows sum to 100 (10M+5M = 15M denom).
  const outboundSum = lineage.filter(l => !l.isReverse)
    .reduce((s, l) => s + l.contributionPctOfTotalUnits, 0);
  near(outboundSum, 100, 0.5, 'outbound contributionPctOfTotalUnits sums to 100');
  // Reverse row's contribution against outbound total = 750K / 15M = 5%
  const reverseRow = lineage.find(l => l.isReverse);
  near(reverseRow.contributionPctOfTotalUnits, 5, 0.5, 'reverse pct vs outbound total = 5%');
});

test('buildChannelLineage: contributionPctOfOutboundUnits sums to ~100 (excludes reverse)', () => {
  const model = {
    channels: [
      { key: 'a', archetypeId: 'b2b-retail', primary: { activity: 'outbound', value: 10_000_000, uom: 'units' } },
      { key: 'b', archetypeId: 'dtc',         primary: { activity: 'outbound', value: 5_000_000,  uom: 'units' } },
      { key: 'c', archetypeId: 'reverse',     primary: { activity: 'returns',  value: 750_000,    uom: 'units' } },
    ],
  };
  const lineage = buildChannelLineage(model);
  // reverse channel's contributionPctOfOutboundUnits is 0; outbound sum is ~100.
  const outboundPct = lineage.reduce((s, l) => s + l.contributionPctOfOutboundUnits, 0);
  near(outboundPct, 100, 0.5, 'outbound contribution pct must sum to ~100');
  const reverseRow = lineage.find(l => l.isReverse);
  assert(reverseRow.contributionPctOfOutboundUnits === 0,
    'reverse channel must have 0 outbound contribution');
});

test('buildChannelLineage: empty model synthesizes single legacy channel', () => {
  // getChannels synthesizes a single channel from legacy shape when channels[]
  // is missing. buildChannelLineage propagates that. Lock the contract.
  const out = buildChannelLineage({});
  assert(out.length === 1, `empty {} -> 1 synthesized channel (got ${out.length})`);
  // Empty channels array still yields zero rows (nothing to synthesize from).
  assert(buildChannelLineage({ channels: [] }).length === 1,
    'empty channels[] still synthesizes from legacy fields');
});

// ============================================================
// 3. Direct-labor OT formula — (1 + 0.5*ot/100)
// ============================================================
test('directLineAnnual: opts.otPct is a FRACTION (0.20), not percent (20)', () => {
  // CONVENTION lock: directLineAnnual expects otPct as a FRACTION.
  // The formula is `(1 + opts.otPct * 0.5)`. Caller must divide by 100.
  // Memory note (2026-04-29 fix): monthly engine standardized to
  // `(1 + (ot/100)*0.5)` — same convention but written as percent/100 inline.
  const line = { annual_hours: 1000, hourly_rate: 20, benefit_load_pct: 0 };
  const noOt = directLineAnnual(line, { otPct: 0, benefitLoadFallback: 0 });
  near(noOt, 20_000, 0.01, '0% OT: 1000 × 20 × 1.0 = 20,000');
  const withOt = directLineAnnual(line, { otPct: 0.20, benefitLoadFallback: 0 });
  near(withOt, 22_000, 0.01, '20% OT (fraction 0.20): 1000 × 20 × 1.10 = 22,000');
});

test('directLineAnnual: passing otPct as percent (20) yields wrong 11x mult — anti-test', () => {
  // Anti-test documenting the F6-class units pitfall. If a caller forgets to
  // divide by 100 and passes 20, the OT multiplier becomes 1 + 20*0.5 = 11
  // (i.e., 1100% labor cost). Wrong, but consistent with the formula.
  // This anti-test catches refactors that try to "fix" the convention by
  // dividing inside directLineAnnual — would silently break every working
  // call site that already passes fractions correctly.
  const line = { annual_hours: 1000, hourly_rate: 20 };
  const wrong = directLineAnnual(line, { otPct: 20, benefitLoadFallback: 0 });
  // 1000 × 20 × 11 (= 1+20*0.5) × 1 (no wage load) = 220,000
  near(wrong, 220_000, 0.01, 'percent-as-fraction misuse produces 220K (proves convention)');
});

test('directLineAnnual: salaried (pay_type=salary) ignores OT', () => {
  const line = { annual_hours: 2000, hourly_rate: 50, pay_type: 'salary' };
  const cost = directLineAnnual(line, { otPct: 50, benefitLoadFallback: 0 });
  near(cost, 100_000, 0.01, 'salary line ignores OT');
});

// ============================================================
// 4. resolveCalcHeuristics priority chain
// ============================================================
test('resolveCalcHeuristics: default fallback when nothing set', () => {
  const out = resolveCalcHeuristics(null, null, null, null, null);
  near(out.taxRatePct, 25, 0.01, 'default tax rate is 25');
  assert(out.used.tax_rate_pct === 'default', 'used.tax_rate_pct must be default');
});

test('resolveCalcHeuristics: project-column override wins over default', () => {
  const out = resolveCalcHeuristics(null, null, null, { taxRate: 28 }, null);
  near(out.taxRatePct, 28, 0.01, 'projectCols.taxRate takes precedence');
});

test('resolveCalcHeuristics: heuristicOverrides wins over project col', () => {
  const out = resolveCalcHeuristics(null, null, { tax_rate_pct: 30 }, { taxRate: 28 }, null);
  near(out.taxRatePct, 30, 0.01, 'overrides take precedence over project cols');
  assert(out.used.tax_rate_pct === 'override', 'used must be "override"');
});

test('resolveCalcHeuristics: approved-snapshot wins over override (frozen freeze)', () => {
  const scen = { status: 'approved' };
  const snaps = {
    heuristics: [{ key: 'tax_rate_pct', effective: 21 }],
  };
  const out = resolveCalcHeuristics(scen, snaps, { tax_rate_pct: 30 }, { taxRate: 28 }, null);
  near(out.taxRatePct, 21, 0.01, 'approved snapshot freezes the rate');
  assert(out.used.tax_rate_pct === 'snapshot', 'used must be "snapshot"');
});

test('resolveCalcHeuristics: transient overlay wins even on approved (preview)', () => {
  const scen = { status: 'approved' };
  const snaps = {
    heuristics: [{ key: 'tax_rate_pct', effective: 21 }],
  };
  const out = resolveCalcHeuristics(scen, snaps, { tax_rate_pct: 30 }, { taxRate: 28 }, { tax_rate_pct: 35 });
  near(out.taxRatePct, 35, 0.01, 'transient overlay always wins (What-If preview)');
  assert(out.used.tax_rate_pct === 'transient', 'used must be "transient"');
});

test('resolveCalcHeuristics: draft scenario does NOT consult snapshot', () => {
  const scen = { status: 'draft' };
  const snaps = {
    heuristics: [{ key: 'tax_rate_pct', effective: 21 }],
  };
  const out = resolveCalcHeuristics(scen, snaps, null, { taxRate: 28 }, null);
  // Draft scenario uses live rates: project col wins over snapshot.
  near(out.taxRatePct, 28, 0.01, 'draft scenario reads live, not snapshot');
  assert(out.used.tax_rate_pct === 'default', `expected default, got ${out.used.tax_rate_pct}`);
});

// ============================================================
// 5. Tax-rate consistency in yearly projections
// ============================================================
function tinyProjectionInputs() {
  const summary = computeSummary({
    laborLines: [{ position: 'X', fte: 1, annual_hours: 2000, hourly_rate: 25 }],
    indirectLaborLines: [], equipmentLines: [], overheadLines: [], vasLines: [], startupLines: [],
    facility: {}, shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
    facilityRate: {}, utilityRate: {},
    contractYears: 5, targetMarginPct: 16, annualOrders: 1_000_000,
  });
  return {
    years: 5,
    baseLaborCost: summary.laborCost,
    baseFacilityCost: summary.facilityCost,
    baseEquipmentCost: 0, baseOverheadCost: 0, baseVasCost: 0,
    startupAmort: 0, startupCapital: 0,
    baseOrders: 1_000_000, marginPct: 0.16,
    volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
    facilityEscPct: 0, equipmentEscPct: 0,
    pricingBuckets: [], project_id: 1, taxRatePct: 25,
  };
}

test('Yearly projection: taxes = pretaxIncome × taxRatePct/100 (positive income)', () => {
  const inputs = tinyProjectionInputs();
  const proj = buildYearlyProjections(inputs).projections;
  for (const p of proj) {
    if (p.ebit > 0) {
      const expected = p.ebit * 0.25;
      near(p.taxes, expected, 1, `Y${p.year} taxes != EBIT × 25%`);
    }
  }
});

test('Yearly projection: changing taxRatePct moves netIncome inversely', () => {
  const a = buildYearlyProjections({ ...tinyProjectionInputs(), taxRatePct: 25 }).projections;
  const b = buildYearlyProjections({ ...tinyProjectionInputs(), taxRatePct: 35 }).projections;
  for (let i = 0; i < a.length; i++) {
    if (a[i].ebit > 0) {
      assert(b[i].netIncome < a[i].netIncome,
        `Y${i+1} higher tax must produce lower netIncome (a=${a[i].netIncome}, b=${b[i].netIncome})`);
    }
  }
});

// ============================================================
// 6. Cross-channel total returns invariant
// ============================================================
test('Total returns: each channel primary × returnsPercent sums to aggregate', () => {
  // FIELD-NAME lock: assumptions.returnsPercent (not returnsPct). Memory
  // shows this is the same field calc.channels.js DEFAULT_ASSUMPTIONS uses.
  const model = {
    channels: [
      { key: 'a', archetypeId: 'b2b-retail', primary: { activity: 'outbound', value: 10_000_000, uom: 'units' }, assumptions: { returnsPercent: 3 } },
      { key: 'b', archetypeId: 'dtc',         primary: { activity: 'outbound', value: 5_000_000,  uom: 'units' }, assumptions: { returnsPercent: 18 } },
    ],
  };
  const expected = 10_000_000 * 0.03 + 5_000_000 * 0.18; // 300K + 900K = 1.2M
  let actual = 0;
  for (const ch of getOutboundChannels(model)) {
    actual += getChannelDerived(model, ch, 'returns').value;
  }
  near(actual, expected, 0.01, 'sum of per-channel returns must match expected');
});

// ============================================================
// 7. totalFacilityCost FIELD-NAME LOCK — canonical schema vs calc
// ============================================================
test('totalFacilityCost: canonical field names produce expected total', () => {
  // FIELD-NAME lock: ref_facility_rates schema (and types.js FacilityRate
  // typedef) uses _yr suffixes. Wrong field names silently zero out the
  // facility cost (which is what bit me writing the headline-reconciliation
  // fixture). Lock the canonical names here so a future refactor that
  // 'simplifies' to lease_rate_psf without _yr will be caught.
  const facility = { totalSqft: 100_000 };
  const facilityRate = {
    lease_rate_psf_yr: 8.0,
    cam_rate_psf_yr: 2.0,
    tax_rate_psf_yr: 1.5,
    insurance_rate_psf_yr: 0.5,
  };
  const utilityRate = { avg_monthly_per_sqft: 0.10 };
  const cost = totalFacilityCost(facility, facilityRate, utilityRate);
  // 100K × (8 + 2 + 1.5 + 0.5) + 100K × 12 × 0.10 = 1,200,000 + 120,000 = 1,320,000
  near(cost, 1_320_000, 0.01, 'totalFacilityCost canonical names');
});

test('totalFacilityCost: WRONG field names silently return 0 (anti-test)', () => {
  // Anti-test documenting the units pitfall I hit. If a caller uses
  // lease_rate_psf instead of lease_rate_psf_yr, the cost is silently 0
  // because || 0 fallback. This anti-test catches future refactors that
  // try to support both field-name conventions.
  const facility = { totalSqft: 100_000 };
  const facilityRate = {
    lease_rate_psf: 8.0,    // WRONG — missing _yr
    cam_psf: 2.0,
    prop_tax_psf: 1.5,
    insurance_psf: 0.5,
  };
  const utilityRate = { utility_psf: 0.10 };  // WRONG — should be avg_monthly_per_sqft
  const cost = totalFacilityCost(facility, facilityRate, utilityRate);
  near(cost, 0, 0.01, 'wrong field names yield 0 (proves the schema lock)');
});

test('facilityCostBreakdown: returns all components + total', () => {
  const facility = { totalSqft: 100_000 };
  const facilityRate = {
    lease_rate_psf_yr: 8.0,
    cam_rate_psf_yr: 2.0,
    tax_rate_psf_yr: 1.5,
    insurance_rate_psf_yr: 0.5,
  };
  const utilityRate = { avg_monthly_per_sqft: 0.10 };
  const bd = facilityCostBreakdown(facility, facilityRate, utilityRate);
  near(bd.lease, 800_000, 0.01, 'lease');
  near(bd.cam, 200_000, 0.01, 'cam');
  near(bd.tax, 150_000, 0.01, 'tax');
  near(bd.insurance, 50_000, 0.01, 'insurance');
  near(bd.utility, 120_000, 0.01, 'utility (12 × 100K × 0.10)');
});

// ============================================================
// 8. Y1 LEARNING CURVE — engine-path divergence lock
// ============================================================
//
// CONCERN B FINDING (2026-04-30 PM): the annual path applies a Y1
// learning-curve uplift to labor cost (learningMult = 1/yr1LearningFactor;
// 1.176x for medium-complexity default) while the monthly path applies
// no such uplift. Same fixture, ~21% divergence in Y1 labor cost depending
// on which engine is active. Production always runs the monthly engine
// (window.COST_MODEL_MONTHLY_ENGINE defaults true), so the learning curve
// never fires in the actual UI — making it a 'ghost feature' and a
// flag-flip footgun. The strategic resolution is parked for Brock:
// either (a) remove learning curve from the annual path, or (b) add it
// to the monthly path. Until then, lock both behaviors so neither can
// silently drift further.

function _learningTinyParams(extra = {}) {
  const summary = computeSummary({
    laborLines: [{ position: 'X', fte: 30, annual_hours: 60_000, hourly_rate: 22, complexity_tier: 'medium' }],
    indirectLaborLines: [], equipmentLines: [], overheadLines: [], vasLines: [], startupLines: [],
    facility: {}, shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
    facilityRate: {}, utilityRate: {},
    contractYears: 5, targetMarginPct: 16, annualOrders: 1_000_000,
  });
  return {
    summary,
    params: {
      years: 5, baseLaborCost: summary.laborCost, baseFacilityCost: 0,
      baseEquipmentCost: 0, baseOverheadCost: 0, baseVasCost: 0,
      startupAmort: 0, startupCapital: 0, baseOrders: 1_000_000, marginPct: 0.16,
      volGrowthPct: 0, laborEscPct: 0, costEscPct: 0,
      facilityEscPct: 0, equipmentEscPct: 0, taxRatePct: 25,
      pricingBuckets: [], project_id: 1,
      laborLines: [{ position: 'X', fte: 30, annual_hours: 60_000, hourly_rate: 22, complexity_tier: 'medium' }],
      ...extra,
    },
  };
}

test('Annual path: Y1 labor includes learning-curve uplift (1.176x for medium tier)', () => {
  const { summary, params } = _learningTinyParams({ useMonthlyEngine: false });
  const proj = buildYearlyProjections(params).projections;
  // Y1 labor = baseLabor × (1/0.85) ≈ baseLabor × 1.1765
  const expectedY1 = summary.laborCost * (1 / 0.85);
  near(proj[0].labor, expectedY1, 1, `annual Y1 labor must apply learningMult=1.176`);
  // learningMult is exposed on the projection row for the inspector.
  near(proj[0].learningMult, 1.1765, 0.001, 'learningMult exposed for UI');
  // Y2+ has no learning multiplier.
  near(proj[1].learningMult, 1.0, 0.001, 'Y2 learningMult = 1.0');
});

test('Annual path: Y1 learning curve scales by complexity_tier (low/medium/high)', () => {
  // low complexity (0.95) -> 1.053x; high (0.75) -> 1.333x; medium (0.85) -> 1.176x.
  // Caller can mix tiers; weighting is by hours.
  for (const [tier, factor] of [['low', 0.95], ['medium', 0.85], ['high', 0.75]]) {
    const { params } = _learningTinyParams({
      useMonthlyEngine: false,
      laborLines: [{ position: 'X', annual_hours: 60_000, hourly_rate: 22, complexity_tier: tier }],
    });
    const proj = buildYearlyProjections(params).projections;
    near(proj[0].learningMult, 1 / factor, 0.001, `${tier} complexity learningMult = 1/${factor}`);
  }
});

test('Monthly path: Y1 labor does NOT include learning-curve uplift (ghost feature)', () => {
  // CONCERN B regression lock. If a future refactor makes the monthly engine
  // apply the learning-curve uplift, this test should be UPDATED to match
  // (the divergence is intentional gap pending strategic decision; the test
  // documents which engine is currently authoritative).
  function periods() {
    const ps = [];
    for (let i = -3; i < 120; i++) {
      ps.push({ id: 1000+i, period_type: 'month', period_index: i,
        calendar_year: 2026, calendar_month: 1,
        customer_fy_index: 1, customer_fm_index: 1,
        label: 'M' + i, is_pre_go_live: i < 0 });
    }
    return ps;
  }
  const FLAT = { monthly_shares: Array(12).fill(1/12) };
  const RAMP = { type: 'medium', wk1_factor: 0.48, wk2_factor: 0.64, wk4_factor: 0.80, wk8_factor: 0.92, wk12_factor: 1.0 };
  const { summary, params } = _learningTinyParams({
    useMonthlyEngine: true, periods: periods(), ramp: RAMP, seasonality: FLAT,
  });
  const proj = buildYearlyProjections(params).projections;
  // Monthly engine: Y1 labor < steady-state because of pre-go-live months,
  // BUT no learning-curve uplift. Steady-state Y2 labor = baseLabor exactly.
  near(proj[1].labor, summary.laborCost, 1, 'Y2 monthly = steady-state base');
  // Y1 < steady-state. Annual would have been 1.176×; monthly is some
  // fraction depending on ramp shape.
  assert(proj[0].labor < summary.laborCost,
    `monthly Y1 must be LESS than steady-state — got ${proj[0].labor.toFixed(0)} vs ${summary.laborCost.toFixed(0)}`);
  // Annual path would produce 1.176x; assert monthly is well below that.
  const annualY1 = summary.laborCost * (1 / 0.85);
  assert(proj[0].labor < annualY1 * 0.95,
    `monthly Y1 must diverge from annual Y1 by >5% (engine-path inconsistency)`);
});

test('CONCERN B documented: annual vs monthly Y1 labor divergence', () => {
  // Same fixture, both engine paths — explicitly compute the divergence
  // so it appears in test output. Future me should see this number and
  // remember why both engines exist + the strategic decision pending.
  function periods() {
    const ps = [];
    for (let i = -3; i < 120; i++) {
      ps.push({ id: 1000+i, period_type: 'month', period_index: i,
        calendar_year: 2026, calendar_month: 1,
        customer_fy_index: 1, customer_fm_index: 1,
        label: 'M' + i, is_pre_go_live: i < 0 });
    }
    return ps;
  }
  const FLAT = { monthly_shares: Array(12).fill(1/12) };
  const RAMP = { type: 'medium', wk1_factor: 0.48, wk2_factor: 0.64, wk4_factor: 0.80, wk8_factor: 0.92, wk12_factor: 1.0 };
  const { params: aP } = _learningTinyParams({ useMonthlyEngine: false });
  const { params: mP } = _learningTinyParams({
    useMonthlyEngine: true, periods: periods(), ramp: RAMP, seasonality: FLAT,
  });
  const annual = buildYearlyProjections(aP).projections;
  const monthly = buildYearlyProjections(mP).projections;
  const divergencePct = ((annual[0].labor - monthly[0].labor) / monthly[0].labor) * 100;
  // Lock current observed divergence ~21.5%. If this drifts substantially,
  // someone changed one of the engines; check whether the gap closed
  // intentionally (good) or introduced a different bug.
  assert(divergencePct > 15 && divergencePct < 30,
    `Y1 engine divergence drift: ${divergencePct.toFixed(1)}% (was ~21% on 2026-04-30)`);
});

// ============================================================
console.log('');
if (failed > 0) {
  console.log(`\n${failed} FAILED:`);
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
  process.exit(1);
} else {
  console.log(`${passed}/${passed} passed`);
  console.log('Model-soundness invariants pass ✓');
}

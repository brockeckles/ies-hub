#!/usr/bin/env node
// test-cm-pricing-parity.mjs — P1-2 (2026-07-02 ground-up assessment):
// recommended pricing must recover the SAME labor dollars the monthly
// expense engine books.
//
// The bug: three labor drivers — market temp premium
// (marketLaborProfile.temp_cost_premium_pct), market OT/absence monthly
// profiles, and the What-If temp_share_delta_pp lever — existed only in the
// monthly expense engine (computeMonthlyLaborFromLines). The annual pricing
// path (computeSummary → totalLaborCost, computePricingSnapshot →
// computeBucketCosts) never received them, so revenue derived from bucket
// rates while expenses came from the monthly path and achieved margin
// landed structurally BELOW target on any market-profile model.
//
// The fix: ONE laborOpts bag (scenarios.resolveSummaryLaborOpts) resolved
// from the same source fields the monthly engine reads, threaded into
// computeSummary + computePricingSnapshot by every pricing surface.
//
// Pins:
//  1. BACK-COMPAT — default-house model (no market profile, no What-If
//     deltas): the bag is inert; computeSummary/computePricingSnapshot
//     output is BIT-IDENTICAL (===) to the no-bag pre-fix path, and the
//     bag deliberately omits otPct/absencePct (the annual path has never
//     priced the house-default 5% OT / 12% absence).
//  2. Market temp_cost_premium_pct now reaches priced labor: summary labor
//     rises by exactly hours × tempShare × base × (premium − house 38%) on
//     mixed lines; pure-perm and pure-temp lines are untouched.
//  3. tempShareDeltaPp What-If moves summary labor in the same direction
//     AND the same relative magnitude as the monthly engine (rate-blend
//     ratios are identical across engines — hours multipliers cancel).
//  4. Market OT/absence monthly arrays: annualized summary labor ===
//     12 × the monthly engine's flat-month labor (exact annualization of
//     the same basis under flat seasonality).
//  5. Gating: 'transient'/'override' OT threads; 'snapshot' deliberately
//     does NOT (approved scenarios froze house defaults — repricing them
//     on upgrade would silently move recommended rates on signed deals).
//  6. Bucket parity: computePricingSnapshot with the bag prices the same
//     labor dollars as computeSummary (recommended rates recover them).
//
// Run:  node test-cm-pricing-parity.mjs

import * as calc from './tools/cost-model/calc.js';
import { computeMonthlyLaborFromLines } from './tools/cost-model/calc.monthly.js';
import {
  resolveCalcHeuristics, resolveSummaryLaborOpts,
} from './tools/cost-model/calc.scenarios.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function near(a, b, rel = 1e-9, m = '') {
  const d = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  if (Math.abs(a - b) / d > rel) throw new Error(`${m}: expected ${b}, got ${a} (rel ${(Math.abs(a - b) / d).toExponential(2)})`);
}

// ── fixtures ──────────────────────────────────────────────────────────
const SHIFTS = { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 }; // 2080 op hrs
const PERM   = { description: 'Picker', hourly_rate: 18, annual_hours: 2080, employment_type: 'permanent', pricing_bucket: 'fulfillment' };
const MIXED  = { description: 'Packer', hourly_rate: 22, annual_hours: 2080, employment_type: 'permanent', retention_mix_pct: 60, pricing_bucket: 'fulfillment' };
const TEMP   = { description: 'Peak temp', hourly_rate: 16, annual_hours: 1000, employment_type: 'temp_agency', temp_agency_markup_pct: 35, pricing_bucket: 'fulfillment' };
const INDIR  = { description: 'Supervisor', hourly_rate: 32, headcount: 2, pricing_bucket: 'storage' };
const BUCKETS = [{ id: 'fulfillment', label: 'Fulfillment' }, { id: 'storage', label: 'Storage' }];

function summaryParams(overrides = {}) {
  return {
    laborLines: [PERM, MIXED, TEMP],
    indirectLaborLines: [INDIR],
    equipmentLines: [], overheadLines: [], vasLines: [], startupLines: [],
    facility: {}, shifts: SHIFTS,
    contractYears: 5, targetMarginPct: 12, annualOrders: 100000,
    ...overrides,
  };
}
function model(overrides = {}) {
  return {
    laborLines: [PERM, MIXED, TEMP],
    indirectLaborLines: [INDIR],
    equipmentLines: [], overheadLines: [], vasLines: [], startupLines: [],
    pricingBuckets: BUCKETS, volumeLines: [], financial: {},
    ...overrides,
  };
}
const HEUR_DEFAULT = resolveCalcHeuristics(null, null, null, {}, null);
const OP_HRS = calc.operatingHours(SHIFTS);

// ── 1. back-compat: default-house bag is inert, bit-identical ─────────
t('bag: default calcHeur + no profile → no otPct/absencePct, house defaults', () => {
  const bag = resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: null });
  assert(!('otPct' in bag), 'otPct must be absent for default-house models');
  assert(!('absencePct' in bag), 'absencePct must be absent for default-house models');
  assert(bag.defaultTempMarkupPct === 38, `defaultTempMarkupPct ${bag.defaultTempMarkupPct}`);
  assert(bag.tempShareDeltaPp === 0, `tempShareDeltaPp ${bag.tempShareDeltaPp}`);
  near(bag.benefitLoadFallback, 0.30, 1e-12, 'benefitLoadFallback');
  assert(bag.marketTempPremiumPct === undefined, 'no market premium without a profile');
});

t('computeSummary: default-house model bit-identical with/without the bag', () => {
  const withoutBag = calc.computeSummary(summaryParams());
  const withBag = calc.computeSummary(summaryParams({
    laborOpts: resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: null }),
  }));
  for (const k of Object.keys(withoutBag)) {
    if (typeof withoutBag[k] !== 'number') continue;
    assert(withBag[k] === withoutBag[k], `summary.${k}: ${withBag[k]} !== ${withoutBag[k]} (must be ===)`);
  }
});

t('computePricingSnapshot: default-house bucket costs bit-identical with/without the bag', () => {
  const m = model();
  const summary = calc.computeSummary(summaryParams());
  const a = calc.computePricingSnapshot({ model: m, summary, marginFrac: 0.12, opHrs: OP_HRS, contractYears: 5 });
  const b = calc.computePricingSnapshot({
    model: m, summary, marginFrac: 0.12, opHrs: OP_HRS, contractYears: 5,
    laborOpts: resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: null }),
  });
  for (const k of Object.keys(a.bucketCosts)) {
    if (typeof a.bucketCosts[k] !== 'number') continue;
    assert(a.bucketCosts[k] === b.bucketCosts[k], `bucketCosts.${k}: ${b.bucketCosts[k]} !== ${a.bucketCosts[k]}`);
  }
});

// ── 2. market temp premium reaches priced labor ───────────────────────
t('market temp_cost_premium_pct raises summary labor by the exact blend delta', () => {
  const profile = { temp_cost_premium_pct: 55 };
  const bagNo = resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: null });
  const bagMkt = resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: profile });
  assert(bagMkt.marketTempPremiumPct === 55, 'premium surfaced in bag');
  const sNo = calc.computeSummary(summaryParams({ laborOpts: bagNo }));
  const sMkt = calc.computeSummary(summaryParams({ laborOpts: bagMkt }));
  assert(sMkt.laborCost > sNo.laborCost, 'premium must raise priced labor');
  // Only MIXED participates: 40% temp share reprices 38% → 55% markup.
  // Expected delta = hours × tempShare × base × (0.55 − 0.38).
  const expectedDelta = 2080 * 0.4 * 22 * (0.55 - 0.38);
  near(sMkt.laborCost - sNo.laborCost, expectedDelta, 1e-9, 'blend delta');
  // Pure-perm + pure-temp lines are untouched by the premium.
  near(calc.directLineAnnual(PERM, bagMkt), calc.directLineAnnual(PERM, bagNo), 1e-12, 'perm line');
  near(calc.directLineAnnual(TEMP, bagMkt), calc.directLineAnnual(TEMP, bagNo), 1e-12, 'temp line (own markup wins)');
});

// ── 3. tempShareDeltaPp What-If: same direction + relative magnitude as monthly ──
t('tempShareDeltaPp: summary labor moves with the monthly engine (ratio parity)', () => {
  const heurDelta = resolveCalcHeuristics(null, null, null, {}, { temp_share_delta_pp: 20 });
  assert(heurDelta.used.temp_share_delta_pp === 'transient', 'provenance');
  const bag0 = resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: null });
  const bag20 = resolveSummaryLaborOpts({ calcHeur: heurDelta, marketLaborProfile: null });
  // Direct-only so indirect (not mix-blended) doesn't dilute the ratio.
  const p = (bag) => summaryParams({ indirectLaborLines: [], laborOpts: bag });
  const s0 = calc.computeSummary(p(bag0));
  const s20 = calc.computeSummary(p(bag20));
  assert(s20.laborCost > s0.laborCost, 'shifting perm→temp (38% markup > 30% load) must raise labor');
  // Monthly engine, flat month, same lines/heuristics.
  const ctx = (heur) => ({
    calcHeur: heur, marketLaborProfile: null, calendarMonth: 1,
    seasonalShare: 1 / 12, escLaborMult: 1, volMult: 1, rampLaborMult: 1, yearIdx: 0,
  });
  const m0 = computeMonthlyLaborFromLines([PERM, MIXED, TEMP], ctx(HEUR_DEFAULT));
  const m20 = computeMonthlyLaborFromLines([PERM, MIXED, TEMP], ctx(heurDelta));
  // Hours multipliers (OT/absence defaults) are line-uniform here and cancel
  // in the ratio — the rate-blend shift must match across engines.
  near(s20.laborCost / s0.laborCost, m20 / m0, 1e-9, 'cross-engine delta ratio');
});

// ── 4. market OT/absence arrays: exact annualization of the monthly basis ──
t('market OT/absence profiles: summary labor === 12 × monthly flat-month labor', () => {
  const profile = {
    peak_month_overtime_pct: Array(12).fill(0.06),
    peak_month_absence_pct: Array(12).fill(0.10),
  };
  const bag = resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: profile });
  near(bag.otPct, 0.06, 1e-12, 'annual-mean OT (fraction)');
  near(bag.absencePct, 0.10, 1e-12, 'annual-mean absence (fraction)');
  // Single perm line: no blend dimension, isolates the hours math.
  const s = calc.computeSummary(summaryParams({
    laborLines: [PERM], indirectLaborLines: [], laborOpts: bag,
  }));
  const monthly = computeMonthlyLaborFromLines([PERM], {
    calcHeur: HEUR_DEFAULT, marketLaborProfile: profile, calendarMonth: 1,
    seasonalShare: 1 / 12, escLaborMult: 1, volMult: 1, rampLaborMult: 1, yearIdx: 0,
  });
  near(s.laborCost, monthly * 12, 1e-9, 'annualized parity');
  // And the hand math: hours × (1 + 6%·0.5) × (1 − 10%) × rate × 1.30.
  near(s.laborCost, 2080 * (1 + 0.06 * 0.5) * 0.90 * 18 * 1.30, 1e-9, 'hand math');
});

// ── 5. OT gating: transient/override thread, snapshot does not ────────
t('explicit What-If / override OT threads into the bag; snapshot is gated out', () => {
  const heurTransient = resolveCalcHeuristics(null, null, null, {}, { overtime_pct: 8 });
  near(resolveSummaryLaborOpts({ calcHeur: heurTransient }).otPct, 0.08, 1e-12, 'transient');
  const heurOverride = resolveCalcHeuristics(null, null, { overtime_pct: 7 }, {}, null);
  near(resolveSummaryLaborOpts({ calcHeur: heurOverride }).otPct, 0.07, 1e-12, 'override');
  // Approved scenario snapshot carrying the frozen house default (5) must
  // NOT reprice — recommended rates on approved deals stay put.
  const heurSnap = resolveCalcHeuristics(
    { status: 'approved' },
    { heuristics: [{ key: 'overtime_pct', effective: 5 }] },
    null, {}, null,
  );
  assert(heurSnap.used.overtime_pct === 'snapshot', 'provenance sanity');
  const bagSnap = resolveSummaryLaborOpts({ calcHeur: heurSnap });
  assert(!('otPct' in bagSnap), 'snapshot OT must not thread into pricing');
});

// ── 6. bucket parity: snapshot prices the same labor dollars as summary ──
t('computePricingSnapshot with the bag prices the same labor the summary carries', () => {
  const profile = { temp_cost_premium_pct: 55 };
  const bag = resolveSummaryLaborOpts({ calcHeur: HEUR_DEFAULT, marketLaborProfile: profile });
  const summary = calc.computeSummary(summaryParams({ laborOpts: bag }));
  const snap = calc.computePricingSnapshot({
    model: model(), summary, marginFrac: 0.12, opHrs: OP_HRS, contractYears: 5, laborOpts: bag,
  });
  // All labor sits in fulfillment (direct) + storage (indirect); facility
  // cost is 0 in this fixture, so bucket labor must reproduce summary labor.
  const bucketLabor = (snap.bucketCosts.fulfillment || 0) + (snap.bucketCosts.storage || 0);
  near(bucketLabor, summary.laborCost, 1e-9, 'Σ bucket labor vs summary.laborCost');
});

console.log(`\ntest-cm-pricing-parity: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

#!/usr/bin/env node
// test-cm-pricing-table-parity.mjs — 2026-07-27 (Brock-reported)
//
// THE BUG: the Price station rendered two surfaces from two different bucket
// cost assemblies. The price-strip tiles read computeAll().pricingSnapshot,
// which threads the P1-2 `laborOpts` bag. The rate-card TABLE below them made
// its own calc.computeBucketCosts() call in ui.js and omitted laborOpts, and
// read the raw stored `financial.targetMargin` instead of the resolved
// heuristic. On Hearthwood Columbus the tiles showed $4.14/pallet where the
// table showed $4.4648/pallet for the same bucket — the table quoting ~8%
// above the P&L basis on labor-heavy buckets, diluted per bucket by its
// non-labor share. The quotable rate card was the wrong one.
//
// THE FIX: renderPricing() consumes computeAll().pricingSnapshot. Its local
// derivation survives only as a fallback for when computeAll throws.
//
// This file pins BOTH halves:
//   Part A — engine: the laborOpts basis is materially different, so a surface
//            that drops it is provably wrong (not a rounding artifact).
//   Part B — seam: ui.js's pricing table and model validator consume the
//            engine's basis. Source-level, because AGENTS.md forbids pure
//            tests importing UI modules.
//
// Run:  node test-cm-pricing-table-parity.mjs

import { readFileSync } from 'node:fs';
import {
  computePricingSnapshot,
  computeSummary,
  computeBucketCosts,
} from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const UI = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');

// House defaults the monthly engine applies: OT 5% at half-premium, absence 12%.
// Effective-hours factor = (1 + 0.05 * 0.5) * (1 - 0.12) = 0.902.
// NB both are FRACTIONS in the opts bag (otPct 0.05, absencePct 0.12) — passing
// whole percents here silently produces a negative multiplier.
const HOUSE_OPTS = { otPct: 0.05, absencePct: 0.12 };
const EXPECTED_FACTOR = (1 + 0.05 * 0.5) * (1 - 0.12);

function makeModel() {
  return {
    // Pure-labor bucket: isolates the effective-hours factor with no dilution.
    laborLines: [
      { activity_name: 'Pick', annual_hours: 100000, hourly_rate: 20,
        burden_pct: 0, benefits_per_hour: 0, pricing_bucket: 'outbound' },
    ],
    indirectLaborLines: [],
    equipmentLines: [],
    // Pure-overhead bucket: must NOT move with laborOpts.
    overheadLines: [
      { category: 'Management', annual_cost: 240000, pricing_bucket: 'mgmt_fee' },
    ],
    vasLines: [],
    startupLines: [],
    pricingBuckets: [
      { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed', uom: 'month' },
      { id: 'outbound', name: 'Outbound Handling', type: 'variable', uom: 'order' },
    ],
    volumeLines: [{ uom: 'order', volume: 1_000_000, isOutboundPrimary: true }],
    facility: {},
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
    financial: { facilityBucketId: null, targetMargin: 12 },
  };
}

function summaryFor(model, laborOpts) {
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
    laborOpts,
  });
}

// ============================================================
// Part A — the engine basis is material
// ============================================================

t('A1: dropping laborOpts changes labor-bucket cost by the effective-hours factor', () => {
  const model = makeModel();
  const common = {
    buckets: model.pricingBuckets,
    laborLines: model.laborLines,
    indirectLaborLines: [], equipmentLines: [], overheadLines: model.overheadLines,
    vasLines: [], startupLines: [],
    facilityCost: 0, operatingHours: 2080, facilityBucketId: null,
  };
  const withOpts = computeBucketCosts({ ...common, laborOpts: HOUSE_OPTS });
  const without  = computeBucketCosts({ ...common });
  const ratio = withOpts['outbound'] / without['outbound'];
  assert(Math.abs(ratio - EXPECTED_FACTOR) < 0.002,
    `pure-labor bucket ratio expected ~${EXPECTED_FACTOR.toFixed(4)}, got ${ratio.toFixed(4)} — ` +
    'if this drifts the two pricing surfaces will disagree again');
});

t('A2: a non-labor bucket is unaffected by laborOpts (proves it is the labor basis)', () => {
  const model = makeModel();
  const common = {
    buckets: model.pricingBuckets,
    laborLines: model.laborLines,
    indirectLaborLines: [], equipmentLines: [], overheadLines: model.overheadLines,
    vasLines: [], startupLines: [],
    facilityCost: 0, operatingHours: 2080, facilityBucketId: null,
  };
  const withOpts = computeBucketCosts({ ...common, laborOpts: HOUSE_OPTS });
  const without  = computeBucketCosts({ ...common });
  assert(Math.abs(withOpts['mgmt_fee'] - without['mgmt_fee']) < 0.01,
    'overhead-only bucket must not move with laborOpts');
});

t('A3: computePricingSnapshot threads laborOpts through to bucket costs and rates', () => {
  const model = makeModel();
  const snapWith = computePricingSnapshot({
    model, summary: summaryFor(model, HOUSE_OPTS), marginFrac: 0.12,
    opHrs: 2080, contractYears: 5, laborOpts: HOUSE_OPTS,
  });
  const snapWithout = computePricingSnapshot({
    model, summary: summaryFor(model), marginFrac: 0.12,
    opHrs: 2080, contractYears: 5,
  });
  const ratio = snapWith.bucketCosts['outbound'] / snapWithout.bucketCosts['outbound'];
  assert(Math.abs(ratio - EXPECTED_FACTOR) < 0.002,
    'snapshot must carry the laborOpts basis into bucketCosts');

  const rateWith = snapWith.buckets.find(b => b.id === 'outbound').recommendedRate;
  const rateWithout = snapWithout.buckets.find(b => b.id === 'outbound').recommendedRate;
  assert(rateWith < rateWithout,
    'the laborOpts basis must reach the recommended rate the table quotes');
});

// ============================================================
// Part B — the UI surfaces consume the engine basis
// ============================================================

t('B1: the pricing table reads the engine snapshot, not its own derivation', () => {
  assert(UI.includes('_snapshot ? _snapshot.bucketCosts : calc.computeBucketCosts({'),
    'renderPricing must prefer pricingSnapshot.bucketCosts');
  assert(UI.includes('_snapshot ? _snapshot.buckets : calc.enrichBucketsWithDerivedRates({'),
    'renderPricing must prefer pricingSnapshot.buckets');
});

t('B2: the table takes its target margin from the resolved heuristic', () => {
  assert(/_snapMarginPct\s*!=\s*null[\s\S]{0,120}model\.financial\?\.targetMargin/.test(UI),
    'renderPricing must prefer calcHeur.targetMarginPct, falling back to the stored value');
});

t('B3: exactly one computeBucketCosts call survives in ui.js (the fallback)', () => {
  const hits = UI.match(/calc\.computeBucketCosts\(/g) || [];
  assert(hits.length === 1,
    `expected 1 fallback call in ui.js, found ${hits.length} — a second pricing ` +
    'surface deriving its own bucket costs is exactly how this bug happened');
});

t('B4: the pricing audit snapshot freezes what the table displayed', () => {
  assert(/_pricingAuditSnapshot\s*=\s*\{\s*enriched,\s*bucketCosts/.test(UI),
    'audit snapshot must be built from the same enriched/bucketCosts the table rendered');
});

t('B5: validateModel is handed the same labor basis', () => {
  assert(UI.includes('calc.validateModel(model, _valOpts)'),
    'the validator call site must pass resolved laborOpts');
  const CALC = readFileSync(new URL('./tools/cost-model/calc.js', import.meta.url), 'utf8');
  assert(/laborOpts:\s*opts\.laborOpts/.test(CALC),
    'validateModel must forward laborOpts into its bucket-cost re-derivation');
});

// ============================================================
process.stdout.write('\n');
if (failures.length) failures.forEach(f => console.error(f));
console.log(`test-cm-pricing-table-parity: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);

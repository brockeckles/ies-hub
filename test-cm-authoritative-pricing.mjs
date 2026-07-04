// test-cm-authoritative-pricing.mjs — pricing-vocab ownership (2026-07-04)
//
// Brock's D1 call: the CM ENGINE is authoritative for a deal site's revenue.
// CM saves stamp summary.totalRevenue/totalCost into flat columns
// (cost_model_projects.total_annual_revenue / total_annual_cost); DM's
// 5-markup heuristic survives only as a labeled 'estimate' fallback for
// never-engine-saved rows. pricing_model is now a legacy heuristic knob.
//
//   1. computeSiteFinancials engine behavior (pure calc import).
//   2. CM api._headlineColumns lift contract (pure api import? no — api
//      imports supabase; scan + isolated eval of the exported fn instead).
//   3. Source scans: save-path stamp, payload spreads, DM mapper, hub
//      'est' badge, MSA band-aid removal.
//
// Run:  node test-cm-authoritative-pricing.mjs

import { readFileSync, existsSync } from 'node:fs';
import * as dmCalc from './tools/deal-manager/calc.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function approx(a, b, eps = 1e-6) { assert(Math.abs(a - b) < eps, `${a} !~ ${b}`); }

// ---- 1. computeSiteFinancials: CM revenue is authoritative ----

t('CM-stamped revenue drives the site P&L verbatim (source=cm)', () => {
  const f = dmCalc.computeSiteFinancials({
    id: 's1', name: 'X', sqft: 100000,
    annualCost: 4000000, annualRevenue: 5000000,
    targetMarginPct: 16, pricingModel: 'hybrid', annualVolume: 1000000,
  });
  approx(f.annualRevenue, 5000000);
  assert(f.revenueSource === 'cm', `source ${f.revenueSource}`);
  approx(f.grossMarginPct, ((5000000 - 4000000) / 5000000) * 100);
});

t('CM revenue outranks perVolumeRate and the markup table', () => {
  const f = dmCalc.computeSiteFinancials({
    id: 's2', name: 'X', annualCost: 4000000, annualRevenue: 5250000,
    perVolumeRate: 3, annualVolume: 1000000, pricingModel: 'transactional',
  });
  approx(f.annualRevenue, 5250000); // NOT 3×1M, NOT cost×1.12
  assert(f.revenueSource === 'cm');
});

t('no CM revenue → legacy cost-plus math survives, labeled estimate', () => {
  const f = dmCalc.computeSiteFinancials({
    id: 's3', name: 'X', annualCost: 4200000, targetMarginPct: 16,
    pricingModel: 'cost-plus',
  });
  approx(f.annualRevenue, 4200000 / (1 - 0.16));
  assert(f.revenueSource === 'estimate', `source ${f.revenueSource}`);
});

t('no CM revenue → transactional markup fallback intact', () => {
  const f = dmCalc.computeSiteFinancials({
    id: 's4', name: 'X', annualCost: 1000000, pricingModel: 'transactional',
  });
  approx(f.annualRevenue, 1120000);
  assert(f.revenueSource === 'estimate');
});

t('deal rollup sums CM-priced and estimate sites together', () => {
  const fin = dmCalc.computeDealFinancials([
    { id: 'a', name: 'A', annualCost: 4000000, annualRevenue: 5000000, sqft: 1 },
    { id: 'b', name: 'B', annualCost: 1000000, pricingModel: 'transactional', sqft: 1 },
  ], 5);
  approx(fin.totalAnnualRevenue, 5000000 + 1120000);
});

// ---- 2. _headlineColumns lift contract (isolated eval of the fn source) ----

const cmApiSrc = readFileSync('./tools/cost-model/api.js', 'utf8');

function extractHeadlineColumns() {
  const start = cmApiSrc.indexOf('export function _headlineColumns(data) {');
  assert(start !== -1, '_headlineColumns not found');
  let depth = 0, i = cmApiSrc.indexOf('{', start);
  for (; i < cmApiSrc.length; i++) {
    if (cmApiSrc[i] === '{') depth++;
    else if (cmApiSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  const src = cmApiSrc.slice(start + 'export '.length, i + 1);
  return new Function(`${src}; return _headlineColumns;`)();
}
const headlineColumns = extractHeadlineColumns();

t('_headlineColumns lifts engine facts + headline columns', () => {
  const cols = headlineColumns({
    headlineFacts: { totalAnnualRevenue: 5100000, totalAnnualCost: 4300000, source: 'cm-engine' },
    facility: { totalSqft: 250000 },
    financial: { targetMargin: 16 },
    projectDetails: { contractType: 'open_book' },
  });
  approx(cols.total_annual_revenue, 5100000);
  approx(cols.total_annual_cost, 4300000);
  approx(cols.facility_sqft, 250000);
  approx(cols.target_margin_pct, 16);
  assert(cols.contract_type === 'open_book');
});

t('_headlineColumns omits (never nulls) when engine facts are absent', () => {
  const cols = headlineColumns({ projectDetails: {}, facility: {}, financial: {} });
  assert(!('total_annual_revenue' in cols), 'must omit revenue');
  assert(!('total_annual_cost' in cols), 'must omit cost');
  assert(!('facility_sqft' in cols), 'must omit sqft');
  assert(!('contract_type' in cols), 'must omit contract_type');
});

t('_headlineColumns rejects non-engine sources and bogus contract types', () => {
  const cols = headlineColumns({
    headlineFacts: { totalAnnualRevenue: 1, totalAnnualCost: 1, source: 'somewhere-else' },
    projectDetails: { contractType: 'cost-plus' }, // DM vocab — NOT a CM contract type
  });
  assert(!('total_annual_revenue' in cols), 'non cm-engine source must not lift');
  assert(!('contract_type' in cols), 'DM vocab must never reach contract_type');
});

// ---- 3. source scans ----

t('CM save path stamps headlineFacts BEFORE persisting', () => {
  const ui = readFileSync('./tools/cost-model/ui.js', 'utf8');
  const save = ui.indexOf('async function handleSave()');
  const stamp = ui.indexOf('model.headlineFacts = {', save);
  const persist = ui.indexOf('api.updateModelGuarded(model.id', save);
  assert(save !== -1 && stamp !== -1 && persist !== -1, 'missing anchor');
  assert(stamp < persist, 'stamp must precede the guarded update');
});

t('both CM payload builders spread _headlineColumns', () => {
  assert((cmApiSrc.match(/\.\.\._headlineColumns\(data\),/g) || []).length === 2,
    'createModel AND _modelUpdatePayload must lift headline columns');
});

t('DM mapper reads total_annual_revenue + contract_type', () => {
  const api = readFileSync('./tools/deal-manager/api.js', 'utf8');
  assert(/annualRevenue: Number\(row\.total_annual_revenue\) \|\| 0/.test(api), 'annualRevenue map');
  assert(/contractType: row\.contract_type \|\| null/.test(api), 'contractType map');
});

t("hub Financials table badges estimate rows with 'est'", () => {
  const hub = readFileSync('./hub/deal-management/ui.js', 'utf8');
  assert(/f\.revenueSource === 'estimate'/.test(hub), 'est badge condition missing');
  assert(/pricing: CM-authoritative/.test(hub), 'provenance label missing');
});

t('MSA band-aid is dead: the whole MSA ui is retired (2026-07-04)', () => {
  // The silent unknown-value option injection died with the file — MSA route
  // fully retired; deal tabs are the only pricing surface (CM-authoritative).
  assert(!existsSync('./tools/deal-manager/ui.js'), 'MSA ui.js must be deleted');
});

process.stdout.write('\n');
if (failed) {
  console.error(failures.join('\n'));
  console.error(`test-cm-authoritative-pricing: ${passed} passed, ${failed} FAILED.`);
  process.exit(1);
}
console.log(`test-cm-authoritative-pricing: ${passed} passed, 0 failed.`);

// test-msa-route-retire.mjs — 2026-07-04: the Multi-Site Analyzer route is
// fully RETIRED. UX-1 decision #1 merged Financials/Sensitivity/Compare into
// the deal tabs (2026-07-03, card shelved); this closes the thread — route,
// card entry, breadcrumb title, DM quick-action handler, and the dead
// 1,855-line tools/deal-manager/ui.js are all gone.
//
// What SURVIVES (and must keep surviving): tools/deal-manager/{calc,api,types}
// — they are the deal-tab financial engine (msaCalc/msaApi imports in
// hub/deal-management/ui.js) and the runScenario contract surface.
//
// Run:  node test-msa-route-retire.mjs

import { readFileSync, existsSync } from 'node:fs';
import * as msaCalc from './tools/deal-manager/calc.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const index = readFileSync('./index.html', 'utf8');
const dmUi = readFileSync('./hub/deal-management/ui.js', 'utf8');

// ── retired surfaces ─────────────────────────────────────────────────────
t('route registry has no designtools/deal-manager entry', () =>
  assert(!index.includes("'designtools/deal-manager'"), 'route still registered'));

t('card grid has no Multi-Site Analyzer entry (not even shelved)', () =>
  assert(!index.includes("key: 'deal-manager'"), 'card entry survives'));

t('breadcrumb title map dropped the MSA label', () =>
  assert(!index.includes("'deal-manager': 'Multi-Site Analyzer'"), 'title map entry survives'));

t('tools/deal-manager/ui.js deleted', () =>
  assert(!existsSync('./tools/deal-manager/ui.js'), 'dead ui.js still on disk'));

t('DM quick-action handler for open-multi-site removed', () =>
  assert(!dmUi.includes('open-multi-site'), 'dead handler survives'));

// ── surviving engine ─────────────────────────────────────────────────────
t('deal tabs still import the MSA engine (msaCalc + msaApi)', () =>
  assert(/import \* as msaCalc from '\.\.\/\.\.\/tools\/deal-manager\/calc\.js/.test(dmUi)
      && /import \* as msaApi from '\.\.\/\.\.\/tools\/deal-manager\/api\.js/.test(dmUi),
    'engine imports missing — Financials/Sensitivity/Compare would die'));

t('calc engine alive: computeSiteFinancials + computeDealFinancials + calcDealSensitivity', () => {
  for (const fn of ['computeSiteFinancials', 'computeDealFinancials', 'calcDealSensitivity']) {
    assert(typeof msaCalc[fn] === 'function', `${fn} missing from calc.js`);
  }
});

t('engine math sanity: CM-priced site uses revenue verbatim (cmp1 contract)', () => {
  const f = msaCalc.computeSiteFinancials({ annualRevenue: 1200000, annualCost: 1000000 });
  assert(f.revenueSource === 'cm', `revenueSource ${f.revenueSource} ≠ cm`);
  assert(Math.abs(f.annualRevenue - 1200000) < 1e-6, 'CM revenue not verbatim');
});

console.log('');
if (failures.length) console.error(failures.join('\n'));
console.log(`test-msa-route-retire: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

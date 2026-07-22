// test-dm-sites-s1.mjs — Multi-Site S1: Sites become real (Brock rulings
// #6/#7 2026-07-22 + spec rulings s2: status vocab as mocked · single-site
// auto-attach · in_bid mirrored through S1).
//
// Locks:
//   1. Pure Σ★ roll-up (hub/deal-management/calc.js): sum of each site's ★
//      scenario; ★-weighted margin; ZERO-DIFF passthrough of the legacy
//      heuristic when no site has a ★; est flag on coverage gaps; dropped
//      sites excluded from coverage.
//   2. api.js wiring: listRealDeals reads deal_sites (not the string
//      collapse); setModelInBid's authority is deal_sites.in_bid_model_id,
//      requires a site, and mirrors the legacy in_bid boolean.
//   3. ui.js wiring: Sites tab renders real site cards + Unassigned bucket;
//      + Add Site opens the site modal (NOT createCostModelForDeal); ★
//      handler recomputes the roll-up via the SAME pure module.
//   4. deal-context: optional siteId slot round-trips; tool save paths
//      (wsc/most/cog + CM) stamp site_id from context/pending payload.
// Probe: the roll-up must NOT change legacy numbers when stars are absent —
// mutated fixture proves the zero-diff guard bites.

import { readFileSync } from 'node:fs';
import { computeStarRollup, modelRevenueEst } from './hub/deal-management/calc.js?v=20260722-s1a';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// ── 1. Pure Σ★ roll-up ──
const M = (id, cost, marginPct) => [String(id), { id, total_annual_cost: cost, target_margin_pct: marginPct }];
{
  // modelRevenueEst: cost grossed up by own margin; fallback margin; 10% floor.
  t('revenueEst uses own margin', near(modelRevenueEst({ total_annual_cost: 80, target_margin_pct: 20 }), 100));
  t('revenueEst falls to deal margin', near(modelRevenueEst({ total_annual_cost: 90 }, 10), 100));
  t('revenueEst 10% default', near(modelRevenueEst({ total_annual_cost: 90 }), 100));

  const models = new Map([M(1, 8_000_000 * 0.707, 29.3), M(2, 4_600_000 * 0.749, 25.1)]);
  const legacy = { revenue: 5_000_000, margin: 12 };

  // No ★ anywhere → legacy passthrough, byte-identical.
  const none = computeStarRollup([{ inBidModelId: null }, { inBidModelId: null }], models, legacy);
  t('no ★ → legacy revenue untouched', none.revenue === legacy.revenue && none.margin === legacy.margin);
  t('no ★ → rollupFromStars false', none.rollupFromStars === false && none.rollupIsEstimate === false);
  t('no ★ → coverage 0/2', none.bidCoverage.starred === 0 && none.bidCoverage.active === 2);

  // Two ★ → Σ of both, ★-weighted margin.
  const both = computeStarRollup([{ inBidModelId: 1 }, { inBidModelId: 2 }], models, legacy);
  const rev1 = modelRevenueEst(models.get('1')), rev2 = modelRevenueEst(models.get('2'));
  t('Σ★ revenue = rev1+rev2', near(both.revenue, rev1 + rev2, 1e-9));
  t('★-weighted margin between site margins', both.margin > 25.1 && both.margin < 29.3);
  t('full coverage → no est flag', both.rollupFromStars === true && both.rollupIsEstimate === false);

  // Partial coverage → est flag; starred site still sums alone.
  const part = computeStarRollup([{ inBidModelId: 1 }, { inBidModelId: null }], models, legacy);
  t('partial: revenue = ★ site only', near(part.revenue, rev1, 1e-9));
  t('partial: est flag set', part.rollupIsEstimate === true);
  t('partial: coverage 1/2', part.bidCoverage.starred === 1 && part.bidCoverage.active === 2);

  // Dropped sites leave coverage (no est flag from a dropped ★-less site).
  const drop = computeStarRollup([{ inBidModelId: 1 }, { inBidModelId: null, status: 'dropped' }], models, legacy);
  t('dropped site excluded from coverage', drop.bidCoverage.active === 1 && drop.rollupIsEstimate === false);

  // ★ pointing at a model not in the map (deleted model) → legacy passthrough.
  const ghost = computeStarRollup([{ inBidModelId: 999 }], models, legacy);
  t('ghost ★ → legacy passthrough', ghost.revenue === legacy.revenue && ghost.rollupFromStars === false);

  // PROBE: zero-diff guard — if the function ever recomputed no-★ deals,
  // this fixture (models whose sum ≠ legacy) would diverge.
  const probe = computeStarRollup([], models, { revenue: 123, margin: 45 });
  t('PROBE: empty sites → exact legacy echo', probe.revenue === 123 && probe.margin === 45);
}

// ── 2. api.js wiring pins ──
const apiSrc = readFileSync(new URL('./hub/deal-management/api.js', import.meta.url), 'utf8');
{
  t('listRealDeals fetches deal_sites', /db\.fetchAll\('deal_sites'/.test(apiSrc));
  t('roll-up delegates to the pure module', apiSrc.includes("from './calc.js") && apiSrc.includes('computeStarRollup(sites, modelById'));
  const fn = apiSrc.slice(apiSrc.indexOf('export async function setModelInBid'));
  t('setModelInBid authority = deal_sites.in_bid_model_id',
    fn.includes("db.update('deal_sites', target.site_id, { in_bid_model_id: target.id })"));
  t('setModelInBid rejects Unassigned models', fn.includes('Unassigned'));
  t('setModelInBid mirrors legacy in_bid (S1 soak ruling)',
    fn.includes("{ in_bid: false }") && fn.includes("{ in_bid: true }"));
  t('site CRUD exported', ['listSitesByDeal', 'createSite', 'updateSite', 'assignModelToSite', 'assignDesignToSite']
    .every(n => apiSrc.includes(`export async function ${n}`)));
  t('createSite defaults status proposed; statuses match ruling vocab',
    apiSrc.includes("status: payload.status || 'proposed'"));
}

// ── 3. ui.js wiring pins ──
const uiSrc = readFileSync(new URL('./hub/deal-management/ui.js', import.meta.url), 'utf8');
{
  t('Sites tab renders site cards keyed by site_id (not name match)',
    uiSrc.includes("String(m.site_id || '') === String(s.id)"));
  t('+ Add Site opens the site modal, not createCostModelForDeal',
    /data-action="add-site-to-deal"[\s\S]{0,400}openSiteModal\(did, null\)/.test(
      uiSrc.slice(uiSrc.indexOf('const addSite = target.closest'))));
  t('Unassigned bucket rendered', uiSrc.includes('data-assign-model'));
  t('★ handler recomputes roll-up via shared pure calc',
    uiSrc.includes('_recomputeDealRollup') && uiSrc.includes('dmCalc.computeStarRollup'));
  t('site detail drill-in exists', uiSrc.includes('function renderSiteDetail(') && uiSrc.includes('data-open-site'));
  t('site-page tool launches carry siteId into deal context',
    uiSrc.includes("launchTool.getAttribute('data-site-id')") && uiSrc.includes('siteId: sid'));
  t('new-scenario-from-site passes siteId through pending payload',
    uiSrc.includes('createCostModelForDeal(dealId, siteId)') || /createCostModelForDeal\(did, createCm\.getAttribute\('data-site-id'\)/.test(uiSrc));
}

// ── 4. deal-context site slot + tool save stamps ──
{
  const dc = readFileSync(new URL('./shared/deal-context.js', import.meta.url), 'utf8');
  t('deal-context stores siteId/siteName', dc.includes('siteId:') && dc.includes('siteName:'));
  const { setActive, getActive, clearActive } = await import('./shared/deal-context.js?v=20260722-s1a');
  setActive({ id: 'deal-1', name: 'D', siteId: 'site-9', siteName: 'Columbus DC' });
  const ctx = getActive();
  t('siteId round-trips through the store', ctx && ctx.siteId === 'site-9' && ctx.siteName === 'Columbus DC');
  setActive({ id: 'deal-1', name: 'D' });
  t('deal-level setActive clears the site slot', getActive()?.siteId === null);
  clearActive();

  for (const [f, marker] of [
    ['./tools/warehouse-sizing/api.js', 'site_id = _ctx.siteId'],
    ['./tools/most-standards/api.js', 'site_id = _ctx.siteId'],
    ['./tools/center-of-gravity/api.js', 'site_id = _ctx.siteId'],
  ]) {
    t(`${f} stamps site_id from context`, readFileSync(new URL(f, import.meta.url), 'utf8').includes(marker));
  }
  const cmApi = readFileSync(new URL('./tools/cost-model/api.js', import.meta.url), 'utf8');
  t('CM insert + update stamp site_id conditionally (never null it)',
    (cmApi.match(/if \(siteId\) payload\.site_id = siteId;/g) || []).length === 2);
  const cmUi = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');
  t('CM hydrates pd.siteId from full.site_id', cmUi.includes('pdHydrate.siteId = full.site_id'));
  t('CM pending-new consumes payload.siteId', cmUi.includes('model.projectDetails.siteId = payload.siteId'));
}

console.log(`\ntest-dm-sites-s1: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

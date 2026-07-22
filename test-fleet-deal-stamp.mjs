// test-fleet-deal-stamp.mjs — Wave C1: Fleet Modeler joins the deal spine.
//
// Locks (source-string pins, same style as test-dm-sites-s1.mjs):
//   1. tools/fleet-modeler/api.js imports shared/deal-context.js and
//      saveScenario's INSERT path stamps parent_deal_id + site_id from the
//      active deal context. Insert-only: the stamp block sits after the
//      update early-return, so updates never rebind.
//   2. tools/fleet-modeler/ui.js landing getParent reads r.parent_deal_id
//      only — fleet_scenarios has NO deal_id column, the old `|| r.deal_id`
//      hedge is gone.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── 1. api.js stamp block ──
const apiSrc = readFileSync(new URL('./tools/fleet-modeler/api.js', import.meta.url), 'utf8');
{
  t('api.js imports shared/deal-context.js', /import \* as dealContext from '\.\.\/\.\.\/shared\/deal-context\.js\?v=/.test(apiSrc));
  const fn = apiSrc.slice(
    apiSrc.indexOf('export async function saveScenario'),
    apiSrc.indexOf('export async function deleteScenario'));
  t('saveScenario reads the active deal context', fn.includes('const _ctx = dealContext.getActive();'));
  t('saveScenario stamps parent_deal_id', fn.includes('if (_ctx) payload.parent_deal_id = _ctx.id;'));
  t('saveScenario stamps site_id (S1 site binding)', fn.includes('if (_ctx && _ctx.siteId) payload.site_id = _ctx.siteId;'));
  // Insert-only: the stamp block must come AFTER the update path's return,
  // so an update can never rebind a scenario to a different deal/site.
  const updIdx = fn.indexOf("db.update('fleet_scenarios'");
  const stampIdx = fn.indexOf('const _ctx = dealContext.getActive();');
  const insIdx = fn.indexOf("db.insert('fleet_scenarios'");
  t('stamp block is insert-only (after update return, before insert)',
    updIdx !== -1 && stampIdx !== -1 && insIdx !== -1 && updIdx < stampIdx && stampIdx < insIdx);
}

// ── 2. ui.js landing parent link ──
const uiSrc = readFileSync(new URL('./tools/fleet-modeler/ui.js', import.meta.url), 'utf8');
{
  t('landing getParent reads parent_deal_id only',
    uiSrc.includes('dealId: r.parent_deal_id }'));
  t('deal_id hedge removed (fleet_scenarios has no deal_id column)',
    !uiSrc.includes('r.parent_deal_id || r.deal_id'));
}

console.log(`\ntest-fleet-deal-stamp: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

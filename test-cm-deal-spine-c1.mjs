// test-cm-deal-spine-c1.mjs — Wave C1 (deal-spine completion), CM audit fixes
// (2026-07-22). Source-string pins per test-dm-sites-s1.mjs style.
//
// Locks:
//   1. SITEID PRESTAMP — the durable deal-context paths (not just the 60s
//      cm_pending_new_for_deal relay) seed projectDetails.siteId from
//      _ctx.siteId on NEW models: _createNewModelFromTemplate plus the
//      WSC and MOST push fallback branches (fresh draft, no target model).
//      The relay path's shape (model.projectDetails.siteId = ...) is the
//      reference; existing-model update flows never rebind.
//   2. UPDATE-REBIND ASYMMETRY — _modelUpdatePayload writes deal_deals_id
//      conditionally, same rule as site_id: omit the column when the model
//      carries no dealId, never NULL a DM-side link from CM. Detach lives
//      in Deal Management (reassignModelToDeal) only. Insert keeps its own
//      conditional stamp.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const uiSrc = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('./tools/cost-model/api.js', import.meta.url), 'utf8');

// ── 1. siteId prestamp on the durable NEW-model paths (ui.js) ──
{
  // Relay reference shape + template path + WSC fallback + MOST fallback = 4
  // context-sourced/payload-sourced siteId seeds total.
  const ctxStamps = (uiSrc.match(/model\.projectDetails\.siteId = _ctx\.siteId;/g) || []).length;
  t('three _ctx.siteId prestamps (template + WSC fallback + MOST fallback)', ctxStamps === 3,
    `found ${ctxStamps}`);

  const tplStart = uiSrc.indexOf('function _createNewModelFromTemplate');
  t('_createNewModelFromTemplate exists', tplStart !== -1);
  const tplBody = uiSrc.slice(tplStart, uiSrc.indexOf('\nfunction ', tplStart + 1));
  t('template path stamps dealId from context', tplBody.includes('model.projectDetails.dealId = _ctx.id;'));
  t('template path stamps siteId from context (S1 shape)',
    tplBody.includes('if (_ctx.siteId) model.projectDetails.siteId = _ctx.siteId;'));

  // WSC fallback: siteId seed lives in the no-target branch, next to the
  // existing dealId prestamp, guarded so it never overwrites a relay stamp.
  const wscStart = uiSrc.indexOf("sessionStorage.removeItem('wsc_pending_push');");
  const mostStart = uiSrc.indexOf("sessionStorage.getItem('most_pending_push')");
  const wscBlock = uiSrc.slice(wscStart, mostStart);
  t('WSC push fallback prestamps siteId on the fresh draft',
    wscBlock.includes('!model.projectDetails.siteId) model.projectDetails.siteId = _ctx.siteId;'));

  const netoptStart = uiSrc.indexOf("sessionStorage.getItem('netopt_pending_cm_push')");
  const mostBlock = uiSrc.slice(mostStart, netoptStart);
  t('MOST push fallback prestamps siteId on the fresh draft',
    mostBlock.includes('!model.projectDetails.siteId) model.projectDetails.siteId = _ctx.siteId;'));

  // Relay path unchanged — still the reference shape.
  t('pending-new relay still consumes payload.siteId',
    uiSrc.includes('if (payload.siteId) model.projectDetails.siteId = payload.siteId;'));
}

// ── 2. _modelUpdatePayload conditional deal_deals_id (api.js) ──
{
  // Old footgun must be gone everywhere: no unconditional null-fallback write.
  t('no unconditional deal_deals_id write remains',
    !apiSrc.includes('payload.deal_deals_id = pd.dealId || data.dealId || null'));

  // Insert AND update now share the same conditional stamp.
  const dealStamps = (apiSrc.match(/if \(dealId\) payload\.deal_deals_id = dealId;/g) || []).length;
  t('insert + update both stamp deal_deals_id conditionally', dealStamps === 2, `found ${dealStamps}`);

  const updStart = apiSrc.indexOf('function _modelUpdatePayload');
  t('_modelUpdatePayload exists', updStart !== -1);
  const updBody = apiSrc.slice(updStart, apiSrc.indexOf('export async function updateModel'));
  t('update payload omits deal_deals_id when model has no dealId',
    updBody.includes('const dealId = pd.dealId || data.dealId;')
    && updBody.includes('if (dealId) payload.deal_deals_id = dealId;'));
  t('update payload keeps conditional site_id (S1, never null from CM)',
    updBody.includes('const siteId = pd.siteId || data.siteId;')
    && updBody.includes('if (siteId) payload.site_id = siteId;'));

  // Detach authority stays in DM: reassignModelToDeal is the only null path.
  t('reassignModelToDeal remains the explicit detach path',
    apiSrc.includes('deal_deals_id: dealId || null'));
}

console.log(`\ntest-cm-deal-spine-c1: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

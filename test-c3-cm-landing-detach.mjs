// test-c3-cm-landing-detach.mjs — Wave C3 UI-honesty sweep, CM slice
// (2026-07-22). Pins the three C3 changes to the flagship tool:
//
//   (a) SCENARIO LANDING — ui.js imports shared/scenario-landing.js (same
//       ?v= pin as every other importer) and calls renderScenarioLanding
//       ONLY behind mount()'s cold-start gate (viewMode === 'landing' after
//       all entry-relay consumption). Every targeted entry path — the
//       cm_pending_open deep link, cm_pending_new_for_deal, the WSC / MOST /
//       NetOpt push relays — flips viewMode to 'editor' BEFORE the gate, so
//       those paths stay byte-identical.
//   (b) EXPLICIT DETACH — api.js exports detachModelFromDeal(modelId): a
//       dedicated single-purpose update that explicitly sets
//       deal_deals_id = null OUTSIDE _modelUpdatePayload (which, per the C1
//       rule locked in test-cm-persistence-contract, OMITS the column when
//       unlinked so ordinary saves can never silently detach). Side effects
//       mirror DM hygiene: site_id → null, write-only in_bid mirror swept
//       false ({ in_bid: false } sanctioned shape, never read), and
//       deal_sites.in_bid_model_id (the ★ authority) cleared wherever it
//       points at the model. Behavioral checks run against an in-memory db.
//       ui.js gates the flow on a saved model with a current deal link,
//       confirms via showConfirm, and reverts the select on cancel/failure.
//   (c) NO ALERTS — repo-scan (test-c3-most-no-alerts pattern): zero bare
//       alert() calls anywhere under tools/cost-model/.
//
// Pure: reads source + stubs the db. No network. Run:
//   node test-c3-cm-landing-detach.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Shim window so shared/supabase.js loads without a browser.
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const api = await import('./tools/cost-model/api.js?test=c3');
const { db } = await import('./shared/supabase.js?v=20260703-hw1');

const ROOT = new URL('.', import.meta.url).pathname;
const uiSrc = readFileSync(join(ROOT, 'tools/cost-model/ui.js'), 'utf8');
const apiSrc = readFileSync(join(ROOT, 'tools/cost-model/api.js'), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ════════════════════════════════════════════════════════════════════════
// (a) Scenario landing — cold-start gate in mount()
// ════════════════════════════════════════════════════════════════════════

// Import pin — pin must MATCH the other importers (browser caches ES modules
// by full URL; a drifted ?v= would split the module singleton).
{
  const IMPORT = "import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260722-s2a';";
  t('ui.js imports renderScenarioLanding with the shared 20260722-s2a pin',
    uiSrc.includes(IMPORT));
  // Cross-check against a sibling importer so a future repin can't drift.
  const wsc = readFileSync(join(ROOT, 'tools/warehouse-sizing/ui.js'), 'utf8');
  const tag = (src) => (src.match(/scenario-landing\.js\?v=([^'"]+)/) || [])[1];
  t('scenario-landing pin matches the WSC importer (no cache-bust drift)',
    tag(uiSrc) === tag(wsc), `cm=${tag(uiSrc)} wsc=${tag(wsc)}`);
}

// Gate shape: mount()'s terminal render is gated on viewMode === 'landing',
// and the shared landing renders ONLY there (single call site in a dedicated
// helper, invoked from the gate).
{
  const mountStart = uiSrc.indexOf('export async function mount(el)');
  t('mount() exists', mountStart !== -1);
  const gateIdx = uiSrc.indexOf("if (viewMode === 'landing') {\n    await renderCmScenarioLanding();\n    return;\n  }", mountStart);
  t('mount tail gates the shared landing on cold-start (viewMode still landing)',
    gateIdx !== -1);
  const eagerIdx = uiSrc.indexOf('await ensureMarketLaborProfileLoaded();', mountStart);
  t('gate sits AFTER every entry-relay consumption (after the eager profile load)',
    eagerIdx !== -1 && gateIdx > eagerIdx);
  t('editor mounts still fall through to renderCurrentView()',
    uiSrc.slice(gateIdx, gateIdx + 300).includes('renderCurrentView();'));
  // Exactly ONE call site of the shared renderer (inside the helper) — the
  // landing must never leak into editor navigation / relay paths.
  const calls = (uiSrc.match(/await renderScenarioLanding\(rootEl, \{/g) || []).length;
  t('renderScenarioLanding called from exactly one place', calls === 1, `found ${calls}`);
  t('helper renderCmScenarioLanding exists and is landing-only',
    uiSrc.includes('async function renderCmScenarioLanding()'));
}

// Landing opts ride the EXISTING CM flows — no new mutation paths.
{
  const from = uiSrc.indexOf('async function renderCmScenarioLanding()');
  const body = uiSrc.slice(from, from + 2200);
  t("landing lists via api.listModels", body.includes('list: () => api.listModels()'));
  t('deal linkage maps from deal_deals_id (getParent)',
    body.includes('dealId: r.deal_deals_id'));
  t('onOpen rides the existing load flow (loadModelByCmId)',
    body.includes('onOpen: (row) => loadModelByCmId(row.id)'));
  t('onNew rides the existing new-model flow (template picker)',
    body.includes('onNew: () => openCmTemplatePicker()'));
  t('onCopy uses the existing duplicateModel api', body.includes('api.duplicateModel(row.id)'));
  t('onDelete uses the existing deleteModel api', body.includes('api.deleteModel(row.id)'));
}

// Entry paths that must BYPASS the landing all set viewMode='editor' before
// the gate — pin each relay's editor flip so a refactor can't strand one on
// the landing.
{
  const mountStart = uiSrc.indexOf('export async function mount(el)');
  const mountEnd = uiSrc.indexOf('\nasync function renderCmScenarioLanding()');
  const mountBody = uiSrc.slice(mountStart, mountEnd);
  t('cm_pending_open deep link hydrates straight into the editor',
    mountBody.includes("sessionStorage.getItem('cm_pending_open')") &&
    /cm_pending_open[\s\S]{0,3000}viewMode = 'editor';/.test(mountBody));
  t('cm_pending_new_for_deal relay enters the editor',
    /cm_pending_new_for_deal[\s\S]{0,1200}viewMode = 'editor';/.test(mountBody));
  t('MOST push relay enters the editor',
    /most_pending_push[\s\S]{0,2000}viewMode = 'editor';/.test(mountBody));
  t('NetOpt push relay enters the editor',
    /netopt_pending_cm_push[\s\S]{0,1200}viewMode = 'editor';/.test(mountBody));
  // WSC relay: target branch loads the model (loadModelByCmId sets editor);
  // fresh-draft branch flips inside handleWscPush's landing guard.
  t('WSC push relay flips to editor via handleWscPush landing guard',
    /function handleWscPush\(payload\) \{[\s\S]{0,600}viewMode = 'editor';/.test(uiSrc));
}

// ════════════════════════════════════════════════════════════════════════
// (b) Explicit detach — api.detachModelFromDeal
// ════════════════════════════════════════════════════════════════════════

t('api.js exports detachModelFromDeal', typeof api.detachModelFromDeal === 'function');

// Source pin: the explicit null set lives OUTSIDE _modelUpdatePayload — the
// ordinary save envelope must keep the C1 omit-when-unlinked rule.
{
  const updStart = apiSrc.indexOf('function _modelUpdatePayload');
  const updBody = apiSrc.slice(updStart, apiSrc.indexOf('export async function updateModel'));
  t('_modelUpdatePayload still omits (never nulls) deal_deals_id',
    updBody.includes('if (dealId) payload.deal_deals_id = dealId;') &&
    !updBody.includes('deal_deals_id: null'));
  const detStart = apiSrc.indexOf('export async function detachModelFromDeal');
  t('detachModelFromDeal exists in source', detStart !== -1);
  const detBody = apiSrc.slice(detStart, detStart + 1600);
  t('detach sets deal_deals_id: null explicitly', detBody.includes('deal_deals_id: null'));
  t('detach does NOT route through _modelUpdatePayload',
    !detBody.includes('_modelUpdatePayload'));
  t('detach sweeps the write-only in_bid mirror in the sanctioned shape',
    detBody.includes('{ in_bid: false }'));
  t('detach clears the deal_sites ★ authority pointer',
    detBody.includes("eq('in_bid_model_id', modelId)") &&
    detBody.includes('in_bid_model_id: null'));
}

// Behavioral: in-memory db (test-cm-persistence-contract pattern).
const realDb = { from: db.from, insert: db.insert, update: db.update, fetchAll: db.fetchAll, fetchById: db.fetchById, rpc: db.rpc };
function makeMemDb(store) {
  const ops = [];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function from(table) {
    const st = { filters: [], op: null, payload: null };
    const rows = () => store[table] || (store[table] = []);
    const matches = (r) => st.filters.every(([c, v]) => String(r[c]) === String(v));
    async function exec(single) {
      if (st.op === 'insert') {
        const arr = Array.isArray(st.payload) ? st.payload : [st.payload];
        arr.forEach(p => rows().push(clone(p)));
        ops.push({ op: 'insert', table, payload: clone(st.payload) });
        return { data: single ? clone(arr[0]) : clone(arr), error: null };
      }
      if (st.op === 'update') {
        const hit = rows().filter(matches);
        hit.forEach(r => Object.assign(r, clone(st.payload)));
        ops.push({ op: 'update', table, payload: clone(st.payload), filters: clone(st.filters) });
        return { data: single ? (hit[0] || null) : hit, error: null };
      }
      const hit = rows().filter(matches);
      return { data: single ? (hit[0] || null) : hit, error: null };
    }
    const b = {
      select() { return b; },
      eq(c, v) { st.filters.push([c, v]); return b; },
      order() { return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      maybeSingle() { return exec(true); },
      single() { return exec(true); },
      then(res, rej) { return exec(false).then(res, rej); },
    };
    return b;
  }
  return {
    ops, store, from,
    update: async (table, id, payload) => { const { data } = await from(table).update(payload).eq('id', id).single(); return data; },
  };
}

{
  const store = {
    cost_model_projects: [{ id: 77, name: 'M', deal_deals_id: 'deal-9', site_id: 'site-1', in_bid: true }],
    deal_sites: [
      { id: 'site-1', deal_id: 'deal-9', in_bid_model_id: 77 },
      { id: 'site-2', deal_id: 'deal-9', in_bid_model_id: 88 },
    ],
  };
  const mem = makeMemDb(store);
  db.from = mem.from; db.update = mem.update;
  try {
    await api.detachModelFromDeal(77);
    const proj = store.cost_model_projects[0];
    t('behavior: deal_deals_id explicitly nulled', proj.deal_deals_id === null);
    t('behavior: site_id nulled (model leaves the deal\'s site)', proj.site_id === null);
    t('behavior: in_bid mirror swept false (write-only)', proj.in_bid === false);
    t('behavior: updated_at restamped',
      /^\d{4}-\d{2}-\d{2}T/.test(proj.updated_at || ''));
    t('behavior: ★ authority cleared on the site that starred this model',
      store.deal_sites[0].in_bid_model_id === null);
    t('behavior: other sites\' ★ untouched (no orphan sweep overreach)',
      store.deal_sites[1].in_bid_model_id === 88);
    const projUpd = mem.ops.find(o => o.table === 'cost_model_projects');
    t('behavior: single-purpose payload (no project_data round-trip)',
      projUpd && !('project_data' in projUpd.payload) && !('name' in projUpd.payload));
  } finally { Object.assign(db, realDb); }
}

// ui.js flow: gated on a SAVED model with a CURRENT deal link, confirmed via
// showConfirm, reverting the select on cancel and on failure.
{
  const idx = uiSrc.indexOf("field === 'projectDetails.dealId' && !val");
  t('ui detach intercept exists on the dealId field', idx !== -1);
  const block = uiSrc.slice(idx - 200, idx + 1800);
  t('intercept requires a saved model AND a current deal link (no confirm spam)',
    block.includes('model?.id && model?.projectDetails?.dealId'));
  t('detach asks via showConfirm with the ruled copy',
    block.includes('Detach this model from') &&
    block.includes('The deal keeps its other links; this model becomes stand-alone.'));
  t('confirm path calls the dedicated api fn',
    block.includes('await api.detachModelFromDeal(model.id)'));
  t('cancel reverts the select with no writes',
    /if \(!ok\) \{ input\.value = prevDealId; return; \}/.test(block));
  t('failure path reverts the select too',
    (block.match(/input\.value = prevDealId/g) || []).length >= 2);
  t('in-memory site binding cleared so the next save cannot resurrect it',
    block.includes('model.projectDetails.siteId = null'));
}

// ════════════════════════════════════════════════════════════════════════
// (c) zero alert() calls in tools/cost-model/*
// ════════════════════════════════════════════════════════════════════════

{
  const DIR = 'tools/cost-model';
  const files = readdirSync(join(ROOT, DIR), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => join(DIR, e.name));
  t('cost-model has the expected module set', files.length >= 10, `found ${files.length}`);
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  const RE = /(?<![.\w$])alert\s*\(|(?:window|globalThis)\s*\.\s*alert\s*\(/g;
  const offenders = [];
  for (const f of files) {
    const src = stripComments(readFileSync(join(ROOT, f), 'utf8'));
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src)) !== null) {
      const ctx = src.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' ');
      offenders.push(`${f}: …${ctx.trim()}…`);
    }
  }
  t('zero bare alert( calls in tools/cost-model/*',
    offenders.length === 0, offenders.slice(0, 5).join(' | '));
  t('Excel export failures route through showToast at error level',
    uiSrc.includes("showToast('Excel library not loaded. Refresh the page and try again.', 'error')") &&
    uiSrc.includes("showToast('Excel export failed: ' + (err.message || 'unknown error'), 'error')"));
}

console.log(`\ntest-c3-cm-landing-detach: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

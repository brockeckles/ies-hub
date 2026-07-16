// test-wsc-review-mode.mjs — W6 Review / Client-safe mode (2026-07-16)
//
// Locks: client-safe scrubbing happens at the MODEL (band costs + rack
// investment note null, clientSafe flag set), the renderer drops the whole
// Rack-cost column + stamps CLIENT COPY, the full model keeps costs, the
// shell-w mode pills emit data-wsw-mode, the routing rides the bound-once
// capture block, and ui.js scrubs via buildDesignBasisModel (not a renderer
// branch) with seam-routed sizing.

import { readFileSync } from 'node:fs';
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const { buildDesignBasisModel, renderDesignBasisHtml } = await import('./tools/warehouse-sizing/basis-doc.js?v=20260710-r3');
const { computeSparseProfile } = await import('./tools/warehouse-sizing/profile-calc.js?v=20260704-n1a');
const { selectMedia } = await import('./tools/warehouse-sizing/media-calc.js?v=20260704-n3a');
const { renderShellW } = await import('./tools/warehouse-sizing/shell-w.js?v=20260715-w3a');

const uiSrc = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');
const evSrc = readFileSync('./tools/warehouse-sizing/ui-shell-events.js', 'utf8');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const profile = computeSparseProfile({
  skuCount: 1200, onHandPallets: 9000, annualOutboundUnits: 500000,
  avgPalletsPerSku: 7.5, avgCasesPerPallet: 45, peakFactor: 1.2,
});
const mediaPlan = selectMedia({ profile, policy: { rotation: 'none' } });
assert(mediaPlan, 'fixture media plan');
const bag = { facility: { name: 'T FC', clearHeight: 32 }, zones: {}, volumes: {}, profile, mediaPlan };

console.log('\n── 1. client-safe scrub at the MODEL ───────────────────────');

t('full model keeps band costs + rack investment note', () => {
  const m = buildDesignBasisModel(bag);
  assert(m.clientSafe === false, 'flag default');
  const media = m.sections.find(s => s.id === 'media');
  assert(media.mediaBands.every(b => /\$/.test(b.cost || '')), 'band costs present');
  const equip = m.sections.find(s => s.id === 'equipment');
  assert(/\$/.test(equip.rackCost || ''), 'rack investment note present');
});

t('client-safe model: NO dollar figure anywhere in media/equipment', () => {
  const m = buildDesignBasisModel({ ...bag, clientSafe: true });
  assert(m.clientSafe === true, 'flag set');
  const media = m.sections.find(s => s.id === 'media');
  assert(media.mediaBands.every(b => b.cost == null), 'band costs stripped');
  const equip = m.sections.find(s => s.id === 'equipment');
  assert(equip.rackCost == null, 'rack note stripped');
});

console.log('\n── 2. renderer: column drop + CLIENT COPY stamp ────────────');

t('client-safe html: Rack-cost column gone, CLIENT COPY stamped, no $ leaks', () => {
  const html = renderDesignBasisHtml(buildDesignBasisModel({ ...bag, clientSafe: true }));
  assert(!html.includes('Rack cost'), 'column header gone');
  assert(html.includes('CLIENT COPY'), 'stamp');
  assert(!/\$\d/.test(html), 'no dollar figures anywhere');
});

t('full html keeps the column and costs, no stamp', () => {
  const html = renderDesignBasisHtml(buildDesignBasisModel(bag));
  assert(html.includes('Rack cost'), 'column');
  assert(/\$\d/.test(html), 'costs render');
  assert(!html.includes('CLIENT COPY'), 'no stamp');
});

console.log('\n── 3. shell + routing pins ─────────────────────────────────');

t('shell-w top bar emits Working + Review + Client-safe pills', () => {
  const html = renderShellW({
    facilityName: 'T', modeLabel: 'Design', stateName: 'draft', activeStation: 'data',
    activeSection: 'basis', sections: [], actions: [], subs: {},
  });
  assert(html.includes('wsw-mode--on'), 'Working pill');
  assert(html.includes('data-wsw-mode="review"'), 'Review pill');
  assert(html.includes('data-wsw-mode="clientsafe"'), 'Client-safe pill');
});

t('mode routing rides the bound-once capture block', () => {
  const guardPos = evSrc.indexOf('rootEl.__wscShellBound = true');
  const modePos = evSrc.indexOf("closest('[data-wsw-mode]')");
  const bindPos = evSrc.indexOf('bindToolChromeEvents(rootEl, {');
  assert(guardPos !== -1 && modePos !== -1, 'markers');
  assert(modePos > guardPos && modePos < bindPos, 'inside guard, before delegation');
  assert(evSrc.includes("sctx.openWscReviewDoc?.(mode.dataset.wswMode === 'clientsafe')"), 'clientsafe routed');
});

t('ui.js scrubs at the model + sizes through the seam-routed funnel', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('function _openWscReviewDoc('));
  assert(fn.slice(0, 700).includes('clientSafe: !!clientSafe'), 'model-level scrub');
  assert(fn.slice(0, 700).includes('toSizingInputs()'), 'seamed sizing');
  assert(uiSrc.includes('openWscReviewDoc: _openWscReviewDoc'), 'ctx hook');
});

console.log(`\n\ntest-wsc-review-mode: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

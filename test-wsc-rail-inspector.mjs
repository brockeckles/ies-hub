// test-wsc-rail-inspector.mjs — W3 rail inspector (2026-07-15)
//
// Locks: derivation-chain builders per rail cell (engine math + W1 seam
// provenance + plan cross-checks), the inspector HTML contract, and the
// TRANSIENT-preview invariant — what-if levers must never reach
// toSizingInputs or persisted state (pinned at source).

import { readFileSync } from 'node:fs';
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const { INSPECTABLE_CELLS, buildRailInspector, renderInspectorHtml } =
  await import('./tools/warehouse-sizing/rail-inspector.js?v=20260715-w3a');
const shellW = await import('./tools/warehouse-sizing/shell-w.js?v=20260715-w3a');

const uiSrc = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');
const evSrc = readFileSync('./tools/warehouse-sizing/ui-shell-events.js', 'utf8');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

// Fixture — the shapes the engine actually emits (field names verified
// against calc.js sizeFacility return, 2026-07-15).
const sized = {
  totalSqft: 124325, storageSqft: 97020, rackLevels: 5, sfPerFloorPos: 40.8,
  dockRequirement: { dockSfRequired: 9000 },
  positions: {
    palletPositionsNeeded: 9000, palletPositionsOverridden: true,
    honeycombFactor: 1.1, surgeFactor: 1.2,
    surgePositions: 1980, grossPositions: 11880, floorPositions: 2376,
    shelvingGrossPositions: 0,
  },
  dock: { inboundDoors: 3, outboundDoors: 3, inboundDoorsExplicit: true, outboundDoorsExplicit: true },
  utilization: { designed: 9900, utilizationPct: 64, warning: null },
};
const facility = { clearHeight: 32 };
const mediaPlan = { totals: { positions: 12000 }, provenance: 'estimated' };
const dynamicsPlan = { flow: { inPerDay: 300, outPerDay: 300, peakFactor: 1.3 }, docks: { inbound: { doors: 3 }, outbound: { doors: 3 } } };
const seamFields = { totalPallets: { value: 9000, source: 'profile', detail: 'On-hand pallets (peak) from the Design Basis profile' } };

console.log('\n── 1. chain builders ───────────────────────────────────────');

t('INSPECTABLE_CELLS covers exactly the six summary rows', () => {
  eq([...INSPECTABLE_CELLS].sort(), ['clearHt', 'doors', 'positions', 'sizedSf', 'storageSf', 'utilPct'], 'cells');
});

t('positions chain: seam-derived source + honeycomb/surge math + media cross-check', () => {
  const m = buildRailInspector('positions', { sized, facility, volumes: {}, seamFields, mediaPlan });
  eq(m.steps[0].val, '9,000', 'needed');
  eq(m.steps[0].src, 'derived', 'seam-derived pill');
  assert(m.steps[0].why.includes('Design Basis'), 'seam detail surfaces');
  assert(m.steps[1].val.includes('1.1'), 'honeycomb factor');
  assert(m.steps[3].val.includes('11,880'), 'gross');
  assert(m.note.includes('12,000') && m.note.includes('covers'), 'media cross-check: 11,880 ≥ 12,000×0.98 tolerance — same rule as the rail recon');
  const short = buildRailInspector('positions', { sized: { ...sized, positions: { ...sized.positions, grossPositions: 11000 } }, facility, volumes: {}, seamFields, mediaPlan });
  assert(short.note.includes('SHORT'), 'genuine shortfall flags SHORT');
});

t('positions chain: typed override reads ASSERTED (no seam field)', () => {
  const m = buildRailInspector('positions', { sized, facility, volumes: { totalPallets: 9000 }, seamFields: {} });
  eq(m.steps[0].src, 'asserted', 'asserted pill');
  assert(m.steps[0].why.includes('Configure'), 'why');
});

t('sizedSf chain: stack sums to the total', () => {
  const m = buildRailInspector('sizedSf', { sized, facility, volumes: {}, seamFields: {} });
  const nums = m.steps.map(st => +(st.val.replace(/[^0-9]/g, '')));
  eq(nums[0] + nums[1] + nums[2] + nums[3], nums[4], 'storage + dock + other + circulation = total');
  assert(m.steps[4].val.includes('124,325'), 'total');
});

t('storageSf chain: gross → levels → floor positions → SF', () => {
  const m = buildRailInspector('storageSf', { sized, facility, volumes: {}, seamFields: {} });
  assert(m.steps[0].val === '11,880' && m.steps[1].val.includes('5'), 'gross ÷ levels');
  assert(m.steps[1].label.includes('2,376'), 'floor positions');
  assert(m.steps[3].val.includes('97,020'), 'storage SF');
});

t('doors chain: applied dynamics plan → rate-method steps + citation', () => {
  const m = buildRailInspector('doors', { sized, facility, volumes: {}, seamFields, dynamicsPlan });
  assert(m.steps[0].val.includes('300'), 'flow');
  assert(m.steps[2].val === '3 + 3', 'doors');
  assert(m.steps[2].cite.includes('wsc.dynamics'), 'catalog citation');
});

t('doors chain without a plan: explicit dockConfig reads ASSERTED', () => {
  const m = buildRailInspector('doors', { sized, facility, volumes: {}, seamFields: {} });
  eq(m.steps[0].src, 'asserted', 'explicit flags honored');
});

t('clearHt: single lever (clear height only); unknown cell → null', () => {
  const m = buildRailInspector('clearHt', { sized, facility, volumes: {}, seamFields: {} });
  eq(m.levers.length, 1, 'one lever');
  eq(m.levers[0].key, 'clearHeight', 'lever key');
  eq(buildRailInspector('nope', {}), null, 'unknown cell');
});

console.log('\n── 2. HTML contract ────────────────────────────────────────');

t('null model → hint; model → chain + pills + levers + idle delta', () => {
  assert(renderInspectorHtml(null).includes('wsw-hint'), 'hint');
  const m = buildRailInspector('positions', { sized, facility, volumes: {}, seamFields, mediaPlan });
  const html = renderInspectorHtml(m, { levers: {} });
  assert(html.includes('wsw-src--derived'), 'src pill');
  assert(html.includes('data-wsw-lever="clearHeight"') && html.includes('data-wsw-lever="palletScale"'), 'levers');
  assert(html.includes('data-unit='), 'unit for surgical label update');
  assert(html.includes('wsw-delta--idle'), 'idle delta');
});

t('active what-if → Δ chip + reset button; lever value reflects state', () => {
  const m = buildRailInspector('positions', { sized, facility, volumes: {}, seamFields, mediaPlan });
  const html = renderInspectorHtml(m, { levers: { clearHeight: 36 }, delta: { sf: '−9,400', positions: '+0' } });
  assert(html.includes('Δ −9,400 SF'), 'delta');
  assert(html.includes('data-wsw-lever-reset'), 'reset');
  assert(/value="36"/.test(html), 'lever carries transient value');
});

t('shell rail rows carry data-wsw-cell for every inspectable key + izbody exists', () => {
  const html = shellW.renderShellW({ actions: [], sections: [], subs: {}, activeStation: 'building', activeSection: 'dashboard' });
  for (const key of INSPECTABLE_CELLS) assert(html.includes(`data-wsw-cell="${key}"`), `row ${key}`);
  assert(html.includes('id="wsw-izbody"'), 'inspector body');
});

console.log('\n── 3. wiring pins (transient invariant) ────────────────────');

t('TRANSIENT PIN: toSizingInputs never reads the what-if levers', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('function toSizingInputs()'), uiSrc.indexOf('function _reqSeam()'));
  assert(!fn.includes('_wswLevers'), 'levers must not leak into the persisted-state funnel');
  assert(!uiSrc.slice(uiSrc.indexOf('async function handleSaveWsc')).slice(0, 3000).includes('_wswLevers'), 'save path clean');
});

t('selection + levers reset PRE-render in openEditor (M4c ordering class)', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('function openEditor(savedRow)'));
  const reset = fn.indexOf("_wswCell = ''");
  const render = fn.indexOf('rootEl.innerHTML = renderShell()');
  assert(reset !== -1 && reset < render, 'reset before the render call');
});

t('KPI cadence refreshes the inspector; delegation bound once (click capture + input)', () => {
  assert(/_refreshWswInspector\(\);\s+\/\/ W3/.test(uiSrc), 'inspector on KPI cadence');
  assert(evSrc.includes("closest('[data-wsw-cell]')"), 'cell delegation');
  assert(evSrc.includes("addEventListener('input'"), 'lever input delegation');
  const guardPos = evSrc.indexOf('rootEl.__wscShellBound = true');
  assert(evSrc.indexOf("addEventListener('input'") > guardPos, 'input listener inside the bound-once guard');
});

t('lever moves are SURGICAL (no innerHTML re-render mid-drag — focus-loss class)', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('function _setWswLever'), uiSrc.indexOf('function _resetWswLevers'));
  assert(!fn.includes('_refreshWswInspector'), 'no full re-render on input cadence');
  assert(fn.includes('textContent') || fn.includes('innerHTML ='), 'updates label/chip directly');
});

console.log(`\n\ntest-wsc-rail-inspector: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

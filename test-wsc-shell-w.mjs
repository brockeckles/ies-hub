// test-wsc-shell-w.mjs — W2 station-spine shell (2026-07-15)
//
// Locks: shell preference (classic DEFAULT until the W7 flip — the
// default-flip mutation probe protection), the station partition against
// ui.js WSC_SECTIONS, the hosting contract (shell-w must emit the same
// data-tc-*/#wsc-config/#wsc-content nodes the classic chrome does), the
// live-rail update path, and the ui.js/ui-shell-events wiring pins.

import { readFileSync } from 'node:fs';
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const shellW = await import('./tools/warehouse-sizing/shell-w.js?v=20260715-w2b');
const { SHELLS, getShellPref, setShellPref, W_STATIONS, stationForSection, renderShellW, updateWRail } = shellW;

const uiSrc = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');
const evSrc = readFileSync('./tools/warehouse-sizing/ui-shell-events.js', 'utf8');
const basisSrc = readFileSync('./tools/warehouse-sizing/ui-basis.js', 'utf8');

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

console.log('\n── 1. shell preference ─────────────────────────────────────');

t('classic is the DEFAULT until the W7 flip (mutation-probe protection)', () => {
  eq(SHELLS, ['classic', 'w'], 'SHELLS');
  eq(getShellPref(), 'classic', 'default');
});

t('set/get round-trip via the node-safe store; invalid values ignored', () => {
  eq(setShellPref('w'), 'w'); eq(getShellPref(), 'w');
  eq(setShellPref('bogus'), 'w', 'invalid ignored');
  eq(setShellPref('classic'), 'classic'); eq(getShellPref(), 'classic');
});

console.log('\n── 2. station partition vs ui.js WSC_SECTIONS ──────────────');

// Parse the real section keys from ui.js (genericized — literals go stale).
const secBlock = uiSrc.slice(uiSrc.indexOf('const WSC_SECTIONS = ['), uiSrc.indexOf('];', uiSrc.indexOf('const WSC_SECTIONS = [')));
const sectionKeys = [...secBlock.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);

t('every WSC section key appears EXACTLY ONCE across stations', () => {
  assert(sectionKeys.length >= 5, `parsed ${sectionKeys.length} section keys from ui.js`);
  const claimed = W_STATIONS.flatMap(st => st.sections);
  eq([...claimed].sort(), [...sectionKeys].sort(), 'partition');
  eq(new Set(claimed).size, claimed.length, 'no duplicates');
});

t('every station target is a real section; scroll targets ride basis stations', () => {
  for (const st of W_STATIONS) {
    assert(sectionKeys.includes(st.target), `${st.key} target '${st.target}' exists`);
    if (st.target === 'basis' && st.key !== 'data') assert(st.scroll.includes('data-wsw-card'), `${st.key} has a card scroll target`);
  }
  eq(stationForSection('dashboard')?.key, 'building', 'lookup');
  eq(stationForSection('basis')?.key, 'data', 'basis owned by Data');
});

t('scroll anchors exist in ui-basis (all 4 basis-station cards)', () => {
  for (const card of ['data', 'media', 'dynamics', 'layout', 'factors']) {
    assert(basisSrc.includes(`data-wsw-card="${card}"`), `anchor ${card}`);
  }
});

console.log('\n── 3. hosting contract (renderShellW) ──────────────────────');

const html = renderShellW({
  facilityName: 'Test FC', modeLabel: 'Design', stateName: 'draft', stateTitle: '',
  backTitle: 'Back', activeStation: 'building', activeSection: 'dashboard',
  sections: sectionKeys.map(k => ({ key: k, label: k.toUpperCase() })),
  actions: [{ id: 'wsc-shell', label: 'Classic layout' }, { id: 'wsc-save', label: 'Save' }, { id: 'push-to-cm', label: 'Use in CM', kind: 'primary' }],
  subs: { data: '1,200 SKU · sparse', storage: '12,000 pos · applied' },
});

t('emits the classic contract: #wsc-config + #wsc-content + data-tc-back', () => {
  assert(html.includes('id="wsc-config"'), 'config node');
  assert(html.includes('id="wsc-content"'), 'content node');
  assert(html.includes('data-tc-back'), 'back button');
});

t('every station emits data-tc-section + data-wsw-station', () => {
  for (const st of W_STATIONS) {
    assert(html.includes(`data-wsw-station="${st.key}"`), `station ${st.key}`);
  }
  const sectionAttrs = [...html.matchAll(/data-tc-section="([^"]+)"/g)].map(m => m[1]);
  for (const st of W_STATIONS) assert(sectionAttrs.includes(st.target), `${st.key} navigates to ${st.target}`);
});

t('building sub-nav lists all 4 canvases; actions + state chip pass through', () => {
  for (const key of ['dashboard', 'plan', 'elevation', '3d']) {
    assert(new RegExp(`wsw-pill[^>]*data-tc-section="${key}"`).test(html), `canvas pill ${key}`);
  }
  for (const id of ['wsc-shell', 'wsc-save', 'push-to-cm']) assert(html.includes(`data-tc-action="${id}"`), `action ${id}`);
  assert(html.includes('data-wsw-state'), 'state chip hook');
});

t('rail slots exist for every summary key + recon + band', () => {
  for (const key of ['sizedSf', 'storageSf', 'positions', 'utilPct', 'doors', 'clearHt', 'recon', 'costMin', 'costMid', 'costMax']) {
    assert(html.includes(`data-wsw-rail="${key}"`), `rail slot ${key}`);
  }
  assert(html.includes('data-wsw-rail-recon') && html.includes('data-wsw-rail-band'), 'recon/band containers');
  // w2b walk find: display:flex on .wsw-recon defeated the hidden attribute —
  // the empty recon box rendered on a blank design. Pin the CSS guard.
  assert(/\.wsw-recon\[hidden\][^}]*display:none/.test(html), 'hidden-attr beats display:flex');
});

console.log('\n── 4. updateWRail (fake-DOM behavior) ──────────────────────');

function fakeRoot() {
  const els = {};
  const mk = () => ({ textContent: '—', hidden: true, _cls: new Set(), classList: { toggle(c, on) { on ? this._parent._cls.add(c) : this._parent._cls.delete(c); } } });
  const get = (sel) => { if (!els[sel]) { els[sel] = mk(); els[sel].classList._parent = els[sel]; } return els[sel]; };
  return { els, querySelector: get };
}

t('rail values format + recon tone + cost band', () => {
  const root = fakeRoot();
  updateWRail(root, {
    sizedSf: 124325, storageSf: 97020, positions: 11880, utilPct: 64, doors: 6, clearHt: 32,
    recon: { ok: false, text: 'Designed 11,880 vs required 12,000 — SHORT -1%' },
    cost: { min: 960000, mid: 1200000, max: 1440000 },
  });
  eq(root.els['[data-wsw-rail="sizedSf"]'].textContent, '124,325', 'sizedSf');
  eq(root.els['[data-wsw-rail="utilPct"]'].textContent, '64%', 'util');
  eq(root.els['[data-wsw-rail-recon]'].hidden, false, 'recon shown');
  assert(root.els['[data-wsw-rail-recon]']._cls.has('wsw-recon--short'), 'short tone');
  eq(root.els['[data-wsw-rail="costMid"]'].textContent, '$1.20M', 'cost mid');
});

t('empty design → em-dashes, recon/band hidden', () => {
  const root = fakeRoot();
  updateWRail(root, { sizedSf: 0, storageSf: 0, positions: 0, utilPct: 0, doors: 0, clearHt: 0, recon: null, cost: null });
  eq(root.els['[data-wsw-rail="sizedSf"]'].textContent, '—', 'em-dash');
  eq(root.els['[data-wsw-rail-recon]'].hidden, true, 'recon hidden');
  eq(root.els['[data-wsw-rail-band]'].hidden, true, 'band hidden');
});

console.log('\n── 5. wiring pins (ui.js / ui-shell-events) ────────────────');

t('renderShell branches on the pref; KPI cadence updates the rail', () => {
  assert(/if \(getWShellPref\(\) === 'w'\) return renderShellW\(_buildWShellOpts\(\)\)/.test(uiSrc), 'renderShell branch');
  assert(/if \(getWShellPref\(\) === 'w'\) updateWRail\(rootEl, _wswRailBag\(\)\)/.test(uiSrc), 'rail on KPI cadence');
});

t('station capture rides the bound-once block, BEFORE tool-chrome delegation (capture phase)', () => {
  const guardPos = evSrc.indexOf('rootEl.__wscShellBound = true');
  const capPos = evSrc.indexOf("closest('[data-wsw-station]')");
  const bindPos = evSrc.indexOf('bindToolChromeEvents(rootEl, {');
  assert(guardPos !== -1 && capPos !== -1 && bindPos !== -1, 'all markers');
  assert(capPos > guardPos && capPos < bindPos, 'capture listener inside guard, before delegation');
  assert(/}, true\);/.test(evSrc.slice(capPos, capPos + 300)), 'capture phase flag');
  assert(evSrc.includes("if (id === 'wsc-shell') return sctx.handleWscShellToggle?.()"), 'toggle action routed');
});

t('scroll consume is one-shot and pre-render-reset (state-reset ordering class)', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('function renderContentView()'));
  const consume = fn.indexOf("_wswScrollSel = ''");
  const firstCase = fn.indexOf("case 'basis'");
  assert(consume !== -1 && consume < firstCase, 'selector consumed before section renders');
});

console.log(`\n\ntest-wsc-shell-w: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

// test-wsc-station-faces.mjs — W4 station faces (2026-07-16)
//
// Locks: the FACE_CARDS partition (5 main cards each render on EXACTLY ONE
// face; the header rides Data + Basis), face-gated rendering (a face shows
// only its own cards; classic = full stack), the prereq-hint station-contract
// button, the spine data-wsw-sub slots, and the ui.js wiring pins (face into
// the basis ctx; _refreshWswSubs on the KPI cadence; classic → face null).

import { readFileSync } from 'node:fs';
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const basis = await import('./tools/warehouse-sizing/ui-basis.js?v=20260722-s2');
const { renderBasisView, FACE_CARDS, resetBasisState } = basis;
const { computeSparseProfile } = await import('./tools/warehouse-sizing/profile-calc.js?v=20260704-n1a');
const { W_STATIONS, renderShellW } = await import('./tools/warehouse-sizing/shell-w.js?v=20260716-w7b');

const uiSrc = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');

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

// ── Fake container: renderBasisView needs innerHTML + null-safe queries ──
function fakeContainer() {
  return {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// Minimal live-getter ctx; face + profile injectable per call.
function makeCtx({ face = undefined, profile = null } = {}) {
  return {
    face,
    getProfile: () => profile,
    setProfile: () => {},
    getPinnedFactors: () => null,
    adoptFactors: () => {},
    fetchFactors: async () => [],
    getMediaPlan: () => null,
    applyMediaPlan: () => {},
    getDynamicsPlan: () => null,
    getVolumes: () => ({}),
    getFacility: () => ({ clearHeight: 32, aisleWidth: 10.5, columnSpacingX: 50, columnSpacingY: 50, flueSpace: 3 }),
    getZones: () => ({}),
    applyDynamicsPlan: () => {},
    getLayoutPlan: () => null,
    computeSized: () => null,
    applyLayoutPlan: () => {},
    rerender: () => {},
    toast: () => {},
  };
}

const CARD_MARK = {
  header: 'Profile readiness',
  data: 'data-wsw-card="data"',
  media: 'data-wsw-card="media"',
  dynamics: 'data-wsw-card="dynamics"',
  layout: 'data-wsw-card="layout"',
  factors: 'data-wsw-card="factors"',
};

console.log('\n── 1. FACE_CARDS partition ─────────────────────────────────');

t('the 5 main cards each render on EXACTLY ONE face; header rides Data + Basis', () => {
  const all = Object.values(FACE_CARDS).flat();
  for (const card of ['data', 'media', 'dynamics', 'layout', 'factors']) {
    eq(all.filter(c => c === card).length, 1, `card ${card} once`);
  }
  eq(all.filter(c => c === 'header').length, 2, 'header twice');
  assert(FACE_CARDS.data.includes('header') && FACE_CARDS.basis.includes('header'), 'header on data + basis');
});

t('every basis-chain station face is a FACE_CARDS key', () => {
  for (const st of W_STATIONS.filter(s => s.face)) {
    assert(FACE_CARDS[st.face], `station ${st.key} face '${st.face}' has cards`);
  }
});

console.log('\n── 2. face-gated rendering ─────────────────────────────────');

t('classic (no face) renders the FULL stack — every card marker present', () => {
  resetBasisState();
  const c = fakeContainer();
  renderBasisView(c, makeCtx());
  for (const [card, mark] of Object.entries(CARD_MARK)) {
    assert(c.innerHTML.includes(mark), `classic has ${card}`);
  }
});

t('data face: header + ingest cards only', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ face: 'data' }));
  assert(c.innerHTML.includes(CARD_MARK.header), 'header');
  assert(c.innerHTML.includes(CARD_MARK.data), 'data grid');
  assert(c.innerHTML.includes('wsc-basis-wizard'), 'wizard mount');
  for (const card of ['media', 'dynamics', 'layout', 'factors']) {
    assert(!c.innerHTML.includes(CARD_MARK[card]), `no ${card} on data face`);
  }
});

t('storage face w/o profile: prereq hint with the station-contract button', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ face: 'storage' }));
  assert(c.innerHTML.includes(CARD_MARK.media), 'media slot');
  assert(c.innerHTML.includes('needs a design profile'), 'hint text');
  assert(/data-wsw-station="data"[^>]*data-tc-section="basis"/.test(c.innerHTML), 'hint button rides the shell contract');
  assert(!c.innerHTML.includes(CARD_MARK.data), 'no data grid');
  assert(!c.innerHTML.includes(CARD_MARK.header), 'no header');
});

const profile = computeSparseProfile({
  skuCount: 1200, onHandPallets: 9000, annualOutboundUnits: 500000,
  avgPalletsPerSku: 7.5, avgCasesPerPallet: 45, peakFactor: 1.2,
});

t('storage face WITH profile: the real media card renders', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ face: 'storage', profile }));
  assert(c.innerHTML.includes('Media Selection') || c.innerHTML.includes('wsc-media-apply'), 'media card content');
  assert(!c.innerHTML.includes('needs a design profile'), 'no hint once profiled');
});

t('flow face: dynamics only; basis face: header + layout + factors only', () => {
  const f = fakeContainer();
  renderBasisView(f, makeCtx({ face: 'flow', profile }));
  assert(f.innerHTML.includes(CARD_MARK.dynamics), 'dynamics slot');
  assert(!f.innerHTML.includes(CARD_MARK.media) && !f.innerHTML.includes(CARD_MARK.layout), 'flow face is dynamics only');
  const b = fakeContainer();
  renderBasisView(b, makeCtx({ face: 'basis', profile }));
  assert(b.innerHTML.includes(CARD_MARK.header), 'basis header (doc button home)');
  assert(b.innerHTML.includes(CARD_MARK.layout) && b.innerHTML.includes(CARD_MARK.factors), 'layout + factors');
  assert(!b.innerHTML.includes(CARD_MARK.data) && !b.innerHTML.includes(CARD_MARK.media), 'no ingest/media');
});

t('unknown face value falls back to the full stack (never a blank canvas)', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ face: 'bogus' }));
  for (const card of ['data', 'media', 'dynamics', 'layout', 'factors']) {
    assert(c.innerHTML.includes(CARD_MARK[card]), `fallback has ${card}`);
  }
});

console.log('\n── 3. spine sub slots (surgical refresh hooks) ─────────────');

t('renderShellW emits a data-wsw-sub slot for every station', () => {
  const html = renderShellW({
    facilityName: 'T', modeLabel: 'Design', stateName: 'draft', activeStation: 'data',
    activeSection: 'basis', sections: [], actions: [], subs: { data: 'x' },
  });
  for (const st of W_STATIONS) {
    assert(html.includes(`data-wsw-sub="${st.key}"`), `sub slot ${st.key}`);
  }
});

console.log('\n── 4. ui.js wiring pins ────────────────────────────────────');

t('basis ctx carries face: _wswBasisFace(); classic short-circuits to null', () => {
  assert(/case 'basis': renderBasisView\(container, \{[^}]*face: _wswBasisFace\(\),/s.test(uiSrc), 'face in basis ctx');
  const fn = uiSrc.slice(uiSrc.indexOf('function _wswBasisFace()'));
  assert(/if \(getWShellPref\(\) !== 'w'\) return null;/.test(fn.slice(0, 400)), 'classic → null');
  assert(/\|\| 'data'/.test(fn.slice(0, 400)), 'blank station memory → data face');
});

t('setProfile + adoptFactors refresh spine subs directly (w4b walk find)', () => {
  // Build Profile / Adopt happen outside the KPI cadence — without these the
  // Data/Basis subs stay stale until the next unrelated edit.
  assert(/setProfile: \(p\) => \{ profile = p; _markDirty\(\); _refreshWswSubs\(\); \}/.test(uiSrc), 'setProfile refreshes subs');
  assert(/adoptFactors: \(live\) => \{ pinnedFactors = pinWscFactors\(live\); _markDirty\(\); _refreshWswSubs\(\); \}/.test(uiSrc), 'adoptFactors refreshes subs');
});

t('_refreshWswSubs rides the KPI cadence inside the shell-w branch', () => {
  const kpi = uiSrc.slice(uiSrc.indexOf('function _refreshWscKpis()'));
  const branch = kpi.slice(kpi.indexOf("getShellPref() === 'w'") >= 0 ? kpi.indexOf("getShellPref() === 'w'") : kpi.indexOf("getWShellPref() === 'w'"));
  assert(branch.slice(0, 300).includes('_refreshWswSubs()'), 'subs refresh on cadence');
  // and the helper updates textContent only (no innerHTML churn)
  const sub = uiSrc.slice(uiSrc.indexOf('function _refreshWswSubs()'));
  assert(sub.slice(0, 500).includes('textContent'), 'surgical textContent update');
  assert(!sub.slice(0, 500).includes('innerHTML'), 'no innerHTML in sub refresh');
});

console.log(`\n\ntest-wsc-station-faces: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

// test-wsc-adopt-flow.mjs — W5 Adopt-flow (2026-07-16)
//
// Locks: data-driven staleness (planFingerprint over material figures only —
// createdAt excluded), adoptStatus state machine, the Apply→Adopt swap under
// station faces (classic keeps its per-card Apply buttons byte-identically),
// the one-decision cascade ordering (upstream applies BEFORE downstream
// re-derives; only already-adopted downstream stages re-derive), and the
// ui.js spine-sub STALE wiring.

import { readFileSync } from 'node:fs';
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const { planFingerprint, adoptStatus, adoptSummary, buildAdoptModel, ADOPT_CHAIN, ADOPT_DOWNSTREAM }
  = await import('./tools/warehouse-sizing/adopt-calc.js?v=20260716-w5a');
const { computeSparseProfile } = await import('./tools/warehouse-sizing/profile-calc.js?v=20260704-n1a');
const { selectMedia } = await import('./tools/warehouse-sizing/media-calc.js?v=20260704-n3a');
const { computeDynamics } = await import('./tools/warehouse-sizing/dynamics-calc.js?v=20260705-mhe1');
const basis = await import('./tools/warehouse-sizing/ui-basis.js?v=20260716-w5a');
const { renderBasisView, computeAdoptStatuses } = basis;

const uiSrc = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');
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

const profileA = computeSparseProfile({
  skuCount: 1200, onHandPallets: 9000, annualOutboundUnits: 500000,
  avgPalletsPerSku: 7.5, avgCasesPerPallet: 45, peakFactor: 1.2,
});
const profileB = computeSparseProfile({
  skuCount: 1200, onHandPallets: 15000, annualOutboundUnits: 500000,
  avgPalletsPerSku: 12.5, avgCasesPerPallet: 45, peakFactor: 1.2,
});
const mediaA = selectMedia({ profile: profileA, policy: { rotation: 'none' } });
const mediaB = selectMedia({ profile: profileB, policy: { rotation: 'none' } });
assert(mediaA && mediaB, 'fixture plans must derive');

console.log('\n── 1. fingerprint + status machine ─────────────────────────');

t('fingerprint covers material figures, ignores createdAt', () => {
  const aged = { ...mediaA, createdAt: '2020-01-01' };
  eq(planFingerprint('media', aged), planFingerprint('media', mediaA), 'createdAt excluded');
  assert(planFingerprint('media', mediaA) !== planFingerprint('media', mediaB), 'different profiles → different prints');
  assert(planFingerprint('media', null) === null, 'null plan → null');
});

t('adoptStatus: pending / current / stale / none', () => {
  eq(adoptStatus('media', null, mediaA), 'pending', 'fresh only');
  eq(adoptStatus('media', mediaA, mediaA), 'current', 'match');
  eq(adoptStatus('media', mediaA, mediaB), 'stale', 'profile moved on');
  eq(adoptStatus('media', null, null), 'none', 'nothing');
  eq(adoptStatus('media', mediaA, null), 'stale', 'derivation no longer possible → stale');
});

t('dynamics + layout fingerprints react to material change', () => {
  const dynA = computeDynamics({ profile: profileA, mediaPlan: mediaA, volumes: {}, facility: { clearHeight: 32 } });
  const dynB = computeDynamics({ profile: profileB, mediaPlan: mediaB, volumes: {}, facility: { clearHeight: 32 } });
  assert(dynA && dynB, 'dynamics derive');
  assert(planFingerprint('dynamics', dynA) !== planFingerprint('dynamics', dynB), 'doors/staging move');
  eq(adoptStatus('dynamics', dynA, dynB), 'stale');
});

t('buildAdoptModel aggregates statuses + summaries', () => {
  const m = buildAdoptModel({ applied: { media: mediaA }, fresh: { media: mediaB } });
  eq(m.stages.media.status, 'stale');
  assert(m.anyStale, 'anyStale');
  assert(m.stages.media.summary.includes('positions'), 'summary text');
  eq(ADOPT_CHAIN, ['media', 'dynamics', 'layout'], 'chain order');
  eq(ADOPT_DOWNSTREAM.media, ['dynamics', 'layout'], 'media downstream');
});

console.log('\n── 2. Apply→Adopt swap under faces ─────────────────────────');

function fakeContainer() {
  return { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
}
function makeCtx({ face, profile = null, mediaPlan = null } = {}) {
  return {
    face,
    getProfile: () => profile, setProfile: () => {},
    getPinnedFactors: () => null, adoptFactors: () => {}, fetchFactors: async () => [],
    getMediaPlan: () => mediaPlan, applyMediaPlan: () => {},
    getDynamicsPlan: () => null, applyDynamicsPlan: () => {},
    getLayoutPlan: () => null, applyLayoutPlan: () => {},
    getVolumes: () => ({}), getFacility: () => ({ clearHeight: 32 }), getZones: () => ({}),
    computeSized: () => null, rerender: () => {}, toast: () => {},
  };
}

t('storage face, pending: adopt bar renders, Apply button does NOT', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ face: 'storage', profile: profileA }));
  assert(c.innerHTML.includes('data-wsw-adopt="media"'), 'adopt button');
  assert(c.innerHTML.includes('Adopt → Flow &amp; Building') || c.innerHTML.includes('Adopt → Flow & Building'), 'forward label');
  assert(!c.innerHTML.includes('wsc-media-apply'), 'Apply gone under face');
});

t('storage face, current: slim in-sync line, no orange bar', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ face: 'storage', profile: profileA, mediaPlan: mediaA }));
  assert(c.innerHTML.includes('data-wsw-adopt-state="current"'), 'in-sync line');
  assert(!c.innerHTML.includes('data-wsw-adopt="media"'), 'no adopt button when current');
});

t('storage face, stale: out-of-sync callout + re-adopt', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ face: 'storage', profile: profileB, mediaPlan: mediaA }));
  assert(c.innerHTML.includes('out of sync'), 'callout');
  assert(c.innerHTML.includes('data-wsw-adopt="media"'), 'adopt button back');
});

t('classic keeps the three Apply buttons and gets NO adopt bars', () => {
  const c = fakeContainer();
  renderBasisView(c, makeCtx({ profile: profileA, mediaPlan: mediaA }));
  for (const id of ['wsc-media-apply', 'wsc-dyn-apply', 'wsc-layout-apply']) {
    assert(c.innerHTML.includes(id), `classic has ${id}`);
  }
  assert(!c.innerHTML.includes('data-wsw-adopt='), 'no adopt buttons');
  assert(!c.innerHTML.includes('data-wsw-adopt-state'), 'no adopt state line');
});

console.log('\n── 3. cascade + wiring pins ────────────────────────────────');

t('cascade: upstream applies FIRST, only adopted downstream re-derives', () => {
  const fn = basisSrc.slice(basisSrc.indexOf('function _adopt(kind, ctx)'), basisSrc.indexOf('export function computeAdoptStatuses'));
  const snap = fn.indexOf('const dynAdopted');
  const mediaBranch = fn.indexOf("if (kind === 'media')");
  assert(snap !== -1 && snap < mediaBranch, 'adopted-state snapshot taken BEFORE any apply');
  assert(/if \(!doMedia\(\)\).*return;/s.test(fn.slice(mediaBranch, mediaBranch + 300)), 'media applies (or aborts) first');
  assert(fn.includes('if (dynAdopted && doDyn())'), 'dynamics re-derives only when adopted');
  assert(fn.includes('if (layAdopted && doLay())'), 'layout re-derives only when adopted');
  const dynPos = fn.indexOf('if (dynAdopted && doDyn())');
  const layPos = fn.indexOf('if (layAdopted && doLay())');
  assert(dynPos < layPos, 'chain order: dynamics before layout');
});

t('computeAdoptStatuses uses the SAME card policies (module state)', () => {
  const fn = basisSrc.slice(basisSrc.indexOf('export function computeAdoptStatuses'));
  assert(fn.slice(0, 600).includes('_rotationPolicy'), 'media policy shared');
  assert(fn.slice(0, 600).includes('_computeDynPreview'), 'dynamics preview shared');
  assert(fn.slice(0, 600).includes('_computeLayoutPreview'), 'layout preview shared');
});

t('ui.js: spine subs read adopt statuses; stale → STALE badge', () => {
  assert(uiSrc.includes('computeAdoptStatuses'), 'import + use');
  assert(/const tag = \(k\) => \(st && st\[k\] === 'stale'\) \? 'STALE' : 'adopted';/.test(uiSrc), 'stale tag');
  assert(/function _wswAdoptStatuses\(\)[\s\S]{0,200}if \(getWShellPref\(\) !== 'w'\) return null;/.test(uiSrc), 'classic short-circuit');
});

t('live behavior: computeAdoptStatuses flags stale after profile change', () => {
  const st1 = computeAdoptStatuses(makeCtx({ profile: profileA, mediaPlan: mediaA }));
  eq(st1.media, 'current', 'in sync');
  const st2 = computeAdoptStatuses(makeCtx({ profile: profileB, mediaPlan: mediaA }));
  eq(st2.media, 'stale', 'profile changed → stale');
});

console.log(`\n\ntest-wsc-adopt-flow: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

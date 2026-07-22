// test-wsc-requirement-seam.mjs — W1 requirement seam (2026-07-15)
//
// The two-brains fix: applied basis plans (media/dynamics) fill UNASSERTED
// Configure volume fields before calc.formStateToInputs. These tests lock:
//   1. deriveRequirement rules — identity, apply-gating, explicit-beats-derived,
//      profile-first pallet sourcing, dynamics flow fill.
//   2. Engine integration — zero-diff for plan-less scenarios (byte-identical
//      inputs), seamed inputs size a real building where unseamed sized 0 SF.
//   3. Source pin — ui.js toSizingInputs routes through the seam.
//
// ENGINES FROZEN: reads calc.js pure functions only. No network.

import { readFileSync } from 'node:fs';
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const { deriveRequirement } = await import('./tools/warehouse-sizing/requirement-seam.js?v=20260715-w1a');
const calc = await import('./tools/warehouse-sizing/calc.js?v=20260722-s1');
const { createDefaultFacility, createDefaultZones, createDefaultVolumes } =
  await import('./tools/warehouse-sizing/ui-cm-bridge.js?v=20260722-s1');

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

const profile = { mode: 'sparse', skuCount: 1200, volumes: { onHandPallets: 9000, annualOutboundUnits: null } };
const mediaPlan = { engine: 'wsc-media-v1', totals: { positions: 12000, pallets: 9000 }, bands: [] };
const dynamicsPlan = { flow: { inPerDay: 300, outPerDay: 300, peakFactor: 1.3 } };

console.log('\n── 1. deriveRequirement rules ──────────────────────────────');

t('identity: no plans → same volumes REFERENCE, inactive', () => {
  const vols = { totalPallets: 0, avgDailyInbound: 0 };
  const r = deriveRequirement({ volumes: vols, profile, mediaPlan: null, dynamicsPlan: null });
  assert(r.volumes === vols, 'must return the same object reference');
  eq(r.active, false, 'active');
  eq(Object.keys(r.fields).length, 0, 'no fields');
});

t('apply-gating: profile alone (no applied mediaPlan) derives NOTHING', () => {
  const r = deriveRequirement({ volumes: { totalPallets: 0 }, profile, mediaPlan: null, dynamicsPlan: null });
  eq(r.active, false, 'profile without Apply must not resize the design');
});

t('applied mediaPlan + profile → totalPallets from PROFILE (raw pallets, not positions)', () => {
  const r = deriveRequirement({ volumes: { totalPallets: 0 }, profile, mediaPlan, dynamicsPlan: null });
  eq(r.volumes.totalPallets, 9000, 'raw on-hand pallets — never the occupancy-adjusted 12,000');
  eq(r.fields.totalPallets.source, 'profile', 'source');
  eq(r.active, true, 'active');
});

t('applied mediaPlan without profile pallets → band-pallets fallback', () => {
  const bare = { mode: 'sparse', volumes: { onHandPallets: null } };
  const r = deriveRequirement({ volumes: { totalPallets: 0 }, profile: bare, mediaPlan, dynamicsPlan: null });
  eq(r.volumes.totalPallets, 9000, 'totals.pallets fallback');
  eq(r.fields.totalPallets.source, 'mediaPlan', 'source');
});

t('explicit beats derived: typed totalPallets survives untouched', () => {
  const r = deriveRequirement({ volumes: { totalPallets: 5000 }, profile, mediaPlan, dynamicsPlan });
  eq(r.volumes.totalPallets, 5000, 'typed value wins');
  assert(!r.fields.totalPallets, 'no derived field for an asserted input');
});

t('dynamics flow fills avgDaily in/out; per-field independence', () => {
  const r = deriveRequirement({ volumes: { totalPallets: 0, avgDailyInbound: 250, avgDailyOutbound: 0 }, profile, mediaPlan: null, dynamicsPlan });
  eq(r.volumes.avgDailyInbound, 250, 'typed inbound wins');
  eq(r.volumes.avgDailyOutbound, 300, 'unasserted outbound derives');
  eq(r.fields.avgDailyOutbound.source, 'dynamicsPlan', 'source');
  assert(!r.fields.avgDailyInbound, 'inbound not derived');
});

t('input volumes object is never mutated', () => {
  const vols = { totalPallets: 0 };
  deriveRequirement({ volumes: vols, profile, mediaPlan, dynamicsPlan });
  eq(vols.totalPallets, 0, 'caller state untouched');
});

console.log('\n── 2. engine integration ───────────────────────────────────');

function editorState() {
  const facility = { ...createDefaultFacility(), clearHeight: 32 };
  return { facility, zones: createDefaultZones(), volumes: createDefaultVolumes() };
}

t('zero-diff: plan-less scenario → formStateToInputs byte-identical', () => {
  const st = editorState();
  const unseamed = calc.formStateToInputs(st);
  const seam = deriveRequirement({ volumes: st.volumes, profile: null, mediaPlan: null, dynamicsPlan: null });
  const seamed = calc.formStateToInputs({ ...st, volumes: seam.volumes });
  eq(seamed, unseamed, 'inputs must be byte-identical');
});

t('two-brains proof: seamed state sizes a real building where unseamed sized 0', () => {
  const st = editorState();
  const before = calc.sizeFacility(calc.formStateToInputs(st));
  assert((before.totalSqft || 0) === 0, `unseamed default state must size 0 SF (got ${before.totalSqft})`);
  const seam = deriveRequirement({ volumes: st.volumes, profile, mediaPlan, dynamicsPlan });
  const inputs = calc.formStateToInputs({ ...st, volumes: seam.volumes });
  eq(inputs.totalPalletsOverride, 9000, 'override carries into engine inputs');
  eq(inputs.inPalletsDay, 300, 'inbound flow');
  eq(inputs.outPalletsDay, 300, 'outbound flow');
  const after = calc.sizeFacility(inputs);
  assert((after.totalSqft || 0) > 50000, `seamed sizing must produce a real building (got ${after.totalSqft} SF)`);
  assert((after.positions?.grossPositions || 0) > 9000, `gross positions from 9,000 pallets + buffers (got ${after.positions?.grossPositions})`);
});

console.log('\n── 3. source pins ──────────────────────────────────────────');

t('ui.js toSizingInputs routes through the seam', () => {
  const uiSrc = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');
  const fn = uiSrc.slice(uiSrc.indexOf('function toSizingInputs()'));
  assert(/_reqSeam\(\)\.volumes/.test(fn.slice(0, 600)), 'toSizingInputs must consume _reqSeam().volumes');
  const kpi = uiSrc.slice(uiSrc.indexOf('function _refreshWscKpis'));
  assert(/computeWscKpis\(\{ facility, zones, volumes: _reqSeam\(\)\.volumes \}\)/.test(kpi.slice(0, 700)),
    'KPI strip must consume the seam too — no second funnel');
  assert(uiSrc.includes("from './requirement-seam.js?v="), 'seam import present');
});

t('config + dashboard badge the seam (display must match mechanism)', () => {
  const cfg = readFileSync('./tools/warehouse-sizing/ui-config.js', 'utf8');
  const dash = readFileSync('./tools/warehouse-sizing/ui-dashboard.js', 'utf8');
  assert(cfg.includes("_seamHint('totalPallets')"), 'Configure pallet-positions hint');
  assert(cfg.includes("_seamHint('avgDailyOutbound')"), 'Configure outbound hint');
  assert(dash.includes('_seamBadge'), 'Dashboard inventory badge');
});

console.log(`\n\ntest-wsc-requirement-seam: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

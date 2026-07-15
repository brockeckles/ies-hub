// test-wsc-persistence-contract.mjs — W0 WSC contract tests (2026-07-15)
//
// THE safety net before the WSC UX redesign touches ui.js (W1 requirement
// seam, W2 station-spine shell). Locks the persistence contract between
// in-memory editor state and wsc_facility_configs so chrome/render refactors
// can't silently change what gets saved or how saved rows hydrate.
//
// Four surfaces:
//   1. Save envelope (api.saveConfig against a stubbed db) — payload shape
//      ({name, config_data}), insert-vs-update branch, deal-context stamp
//      on insert only, N1–N5 plans + pins riding config_data.
//   2. Hydration (ui.js openEditor, extracted + executed with stubbed
//      renderers) — defaults merge, plan/null fallbacks, legacy
//      buildingDimsOverride → constraint-mode migration.
//   3. Round-trip — handleSaveWsc-shaped config → saveConfig → captured
//      config_data → openEditor → state matches byte-for-byte.
//   4. duplicateConfig + factor-catalog envelope source pins.
//
// ENGINES FROZEN: this file only reads ui source and stubs the db. No
// network. Run: node test-wsc-persistence-contract.mjs

import { readFileSync } from 'node:fs';

// Shim window so shared modules load without a browser (test-env-split pattern)
globalThis.window = globalThis.window || { location: { hostname: '', pathname: '/', search: '' } };

const api = await import('./tools/warehouse-sizing/api.js?test=w0');
const { db } = await import('./shared/supabase.js?v=20260703-hw1');
const dealContext = await import('./shared/deal-context.js?v=20260703-dc1');
const { createDefaultFacility, createDefaultZones, createDefaultVolumes } =
  await import('./tools/warehouse-sizing/ui-cm-bridge.js?v=20260702-p1b');

const uiSrc = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');
const apiSrc = readFileSync('./tools/warehouse-sizing/api.js', 'utf8');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
async function ta(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

// ── openEditor extraction (brace-matched, CM M1 pattern) ─────────────────
function extractFn(src, header) {
  const start = src.indexOf(header);
  assert(start !== -1, `function not found in source: ${header}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// openEditor reads/writes module-level editor state and ends with render
// calls; execute it against declared locals + no-op renderers, then read
// the state back. If ui.js renames these bindings this constructor throws —
// which is exactly the drift alarm this test exists to raise.
const openEditorSrc = extractFn(uiSrc, 'function openEditor(savedRow)');
const harness = new Function('createDefaultFacility', 'createDefaultZones', 'createDefaultVolumes', `
  let rootEl = { innerHTML: '' };
  let viewMode = '';
  let facility, profile, pinnedFactors, mediaPlan, dynamicsPlan, layoutPlan, zones, volumes;
  const resetBasisState = () => {};
  const renderShell = () => '';
  const bindShellEvents = () => {};
  const renderConfigPanel = () => {};
  const renderContentView = () => {};
  const _refreshWscKpis = () => {};
  const _makeShellEventsCtx = () => ({});
  ${openEditorSrc}
  return {
    openEditor,
    state: () => ({ facility, profile, pinnedFactors, mediaPlan, dynamicsPlan, layoutPlan, zones, volumes }),
  };
`)(createDefaultFacility, createDefaultZones, createDefaultVolumes);

// ── db stub (db is a plain object literal — directly patchable) ──────────
const calls = [];
const origInsert = db.insert, origUpdate = db.update, origFetchById = db.fetchById;
function stubDb() {
  calls.length = 0;
  db.insert = async (table, payload) => { calls.push({ op: 'insert', table, payload }); return { id: 'new-row-1', ...payload }; };
  db.update = async (table, id, payload) => { calls.push({ op: 'update', table, id, payload }); return { id, ...payload }; };
}
function restoreDb() { db.insert = origInsert; db.update = origUpdate; db.fetchById = origFetchById; }

// ════════════════════════════════════════════════════════════════════════
// 1. Save envelope — api.saveConfig
// ════════════════════════════════════════════════════════════════════════
console.log('\n── 1. saveConfig envelope ──────────────────────────────────');

const plans = {
  profile: { mode: 'sparse', skuCount: 1200, onHandPallets: 9000, depthOfHolding: 7.5 },
  pinnedFactors: { pinnedAt: '2026-07-15', factors: { 'wsc.media.dd_occupancy': 0.75 } },
  mediaPlan: { appliedAt: '2026-07-15', bands: [{ medium: 'double_deep', positions: 12000 }] },
  dynamicsPlan: { appliedAt: '2026-07-15', doors: { inbound: 3, outbound: 3 } },
  layoutPlan: { appliedAt: '2026-07-15', grid: { bayPitchIn: 51 } },
};
// handleSaveWsc save shape: { ...facility, zones, volumes, ...plans }
function editorConfig(extra = {}) {
  return { ...createDefaultFacility(), name: 'W0 Test Facility', zones: createDefaultZones(), volumes: createDefaultVolumes(), ...plans, ...extra };
}

await ta('new scenario (no id) → insert with {name, config_data} payload', async () => {
  stubDb(); dealContext.clearActive?.();
  await api.saveConfig(editorConfig());
  eq(calls.length, 1, 'one db call');
  eq(calls[0].op, 'insert', 'op');
  eq(calls[0].table, 'wsc_facility_configs', 'table');
  eq(calls[0].payload.name, 'W0 Test Facility', 'name column');
  assert(calls[0].payload.config_data, 'config_data present');
  restoreDb();
});

await ta('config_data carries all five N1–N5 surfaces + zones + volumes', async () => {
  stubDb(); dealContext.clearActive?.();
  await api.saveConfig(editorConfig());
  const cd = calls[0].payload.config_data;
  eq(cd.profile, plans.profile, 'profile');
  eq(cd.pinnedFactors, plans.pinnedFactors, 'pinnedFactors');
  eq(cd.mediaPlan, plans.mediaPlan, 'mediaPlan');
  eq(cd.dynamicsPlan, plans.dynamicsPlan, 'dynamicsPlan');
  eq(cd.layoutPlan, plans.layoutPlan, 'layoutPlan');
  assert(cd.zones && typeof cd.zones === 'object', 'zones');
  assert(cd.volumes && typeof cd.volumes === 'object', 'volumes');
  assert(cd.clearHeight === 32, 'facility fields spread into config_data');
  restoreDb();
});

await ta('existing scenario (id set) → update, same payload shape, no deal stamp', async () => {
  stubDb();
  dealContext.setActive?.({ id: 'deal-77', name: 'Wayfair — Memphis FC' });
  await api.saveConfig(editorConfig({ id: 'cfg-123' }));
  eq(calls[0].op, 'update', 'op');
  eq(calls[0].id, 'cfg-123', 'row id');
  assert(!('parent_deal_id' in calls[0].payload), 'updates never rebind deal');
  dealContext.clearActive?.();
  restoreDb();
});

await ta('insert under active deal context → parent_deal_id stamped', async () => {
  stubDb();
  dealContext.setActive?.({ id: 'deal-77', name: 'Wayfair — Memphis FC' });
  await api.saveConfig(editorConfig());
  eq(calls[0].payload.parent_deal_id, 'deal-77', 'deal stamp');
  dealContext.clearActive?.();
  restoreDb();
});

// ════════════════════════════════════════════════════════════════════════
// 2. Hydration — openEditor (extracted)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── 2. openEditor hydration ─────────────────────────────────');

t('saved row hydrates facility + all five surfaces from config_data', () => {
  harness.openEditor({ id: 'row-9', parent_cost_model_id: 42, config_data: editorConfig() });
  const s = harness.state();
  eq(s.facility.id, 'row-9', 'id comes from the ROW, not config_data');
  eq(s.facility.parent_cost_model_id, 42, 'cm link');
  eq(s.facility.name, 'W0 Test Facility', 'name');
  eq(s.profile, plans.profile, 'profile');
  eq(s.pinnedFactors, plans.pinnedFactors, 'pinnedFactors');
  eq(s.mediaPlan, plans.mediaPlan, 'mediaPlan');
  eq(s.dynamicsPlan, plans.dynamicsPlan, 'dynamicsPlan');
  eq(s.layoutPlan, plans.layoutPlan, 'layoutPlan');
});

t('legacy row (pre-N1) hydrates null plans — never undefined, never throws', () => {
  harness.openEditor({ id: 'legacy-1', config_data: { name: 'Old', clearHeight: 28 } });
  const s = harness.state();
  eq(s.profile, null, 'profile');
  eq(s.pinnedFactors, null, 'pinnedFactors (pins on next save)');
  eq(s.mediaPlan, null, 'mediaPlan');
  eq(s.dynamicsPlan, null, 'dynamicsPlan');
  eq(s.layoutPlan, null, 'layoutPlan');
  eq(s.facility.clearHeight, 28, 'saved field wins');
  eq(s.facility.columnSpacingX, 50, 'missing fields fall back to defaults');
});

t('zones/volumes merge saved values over defaults', () => {
  const defZones = createDefaultZones();
  const someKey = Object.keys(defZones)[0];
  harness.openEditor({ id: 'z-1', config_data: { name: 'Z', zones: { [someKey]: 'MUTATED' } } });
  const s = harness.state();
  eq(s.zones[someKey], 'MUTATED', 'saved zone key wins');
  const defVols = createDefaultVolumes();
  const volKey = Object.keys(defVols)[0];
  assert(volKey in s.volumes, 'default volume keys present when row has none');
});

t('legacy buildingDimsOverride migrates to constraint mode (Phase A)', () => {
  harness.openEditor({ id: 'legacy-2', config_data: { name: 'Dims', buildingDimsOverride: true, buildingWidth: 480, buildingDepth: 320 } });
  eq(harness.state().facility.sizingMode, 'constraint', 'migrated');
});

t('saved sizingMode wins over the migration shim', () => {
  harness.openEditor({ id: 'legacy-3', config_data: { name: 'Dims2', sizingMode: 'design', buildingDimsOverride: true } });
  eq(harness.state().facility.sizingMode, 'design', 'explicit mode respected');
});

t('fresh scenario (no row) → defaults, null plans', () => {
  harness.openEditor(null);
  const s = harness.state();
  eq(s.facility.id, null, 'no id');
  eq(s.facility.name, 'New Facility', 'default name');
  eq(s.profile, null, 'no basis yet');
  eq(s.mediaPlan, null, 'no media plan yet');
});

// ════════════════════════════════════════════════════════════════════════
// 3. Round-trip — editor state → save → hydrate → same state
// ════════════════════════════════════════════════════════════════════════
console.log('\n── 3. save → hydrate round-trip ────────────────────────────');

await ta('config_data round-trips through openEditor byte-for-byte (plans)', async () => {
  stubDb(); dealContext.clearActive?.();
  const before = editorConfig({ clearHeight: 36, storageType: 'double_deep' });
  await api.saveConfig(before);
  const savedCd = calls[0].payload.config_data;
  harness.openEditor({ id: 'rt-1', config_data: savedCd });
  const s = harness.state();
  eq(s.profile, before.profile, 'profile');
  eq(s.mediaPlan, before.mediaPlan, 'mediaPlan');
  eq(s.dynamicsPlan, before.dynamicsPlan, 'dynamicsPlan');
  eq(s.layoutPlan, before.layoutPlan, 'layoutPlan');
  eq(s.pinnedFactors, before.pinnedFactors, 'pinnedFactors');
  eq(s.facility.clearHeight, 36, 'facility field');
  eq(s.facility.storageType, 'double_deep', 'storage type');
  eq(s.zones, before.zones, 'zones');
  eq(s.volumes, before.volumes, 'volumes');
  restoreDb();
});

await ta('re-save of hydrated state changes nothing (idempotent envelope)', async () => {
  stubDb(); dealContext.clearActive?.();
  const before = editorConfig();
  await api.saveConfig(before);
  const firstCd = calls[0].payload.config_data;
  harness.openEditor({ id: 'rt-2', config_data: firstCd });
  const s = harness.state();
  calls.length = 0;
  await api.saveConfig({ ...s.facility, zones: s.zones, volumes: s.volumes, profile: s.profile, pinnedFactors: s.pinnedFactors, mediaPlan: s.mediaPlan, dynamicsPlan: s.dynamicsPlan, layoutPlan: s.layoutPlan });
  const secondCd = calls[0].payload.config_data;
  const strip = (o) => { const { id, parent_cost_model_id, ...rest } = o; return rest; };
  eq(strip(secondCd), strip(firstCd), 'second save identical modulo row identity');
  restoreDb();
});

// ════════════════════════════════════════════════════════════════════════
// 4. duplicateConfig + envelope source pins
// ════════════════════════════════════════════════════════════════════════
console.log('\n── 4. duplicate + source pins ──────────────────────────────');

await ta('duplicateConfig strips row identity and appends (Copy), inserts', async () => {
  stubDb(); dealContext.clearActive?.();
  db.fetchById = async (table, id) => ({
    id, created_at: 'X', updated_at: 'Y',
    config_data: editorConfig(),
    parent_cost_model_id: 42,
  });
  await api.duplicateConfig('orig-1');
  eq(calls.length, 1, 'one write');
  eq(calls[0].op, 'insert', 'copies are new rows');
  eq(calls[0].payload.name, 'W0 Test Facility (Copy)', 'copy name');
  const cd = calls[0].payload.config_data;
  eq(cd.mediaPlan, plans.mediaPlan, 'plans ride the copy');
  assert(!cd.created_at && !cd.updated_at, 'row timestamps not smuggled into config_data');
  restoreDb();
});

t('handleSaveWsc saves ALL five surfaces (anti-drop pin)', () => {
  const m = uiSrc.match(/api\.saveConfig\(\{\s*\.\.\.facility,([^)]*)\}\)/);
  assert(m, 'handleSaveWsc saveConfig call found');
  for (const key of ['zones', 'volumes', 'profile', 'pinnedFactors', 'mediaPlan', 'dynamicsPlan', 'layoutPlan']) {
    assert(m[1].includes(key), `saveConfig spread includes ${key}`);
  }
});

t('factor catalog envelope pins: 4 wsc_* categories + is_active filter', () => {
  for (const catCode of ['wsc_media_selection', 'wsc_dynamics', 'wsc_layout_compliance', 'wsc_profile_defaults']) {
    assert(apiSrc.includes(catCode), `fetchWscFactors queries ${catCode}`);
  }
  assert(/eq\('is_active',\s*true\)/.test(apiSrc), 'is_active filter');
});

t('insert-only deal stamping pin: updates never rebind (source)', () => {
  const fn = extractFn(apiSrc, 'export async function saveConfig(config)');
  const updatePos = fn.indexOf('db.update');
  const stampPos = fn.indexOf('parent_deal_id');
  assert(updatePos !== -1 && stampPos !== -1, 'both markers present');
  assert(stampPos > updatePos, 'deal stamp sits on the insert path, after the update early-return');
});

// ════════════════════════════════════════════════════════════════════════
console.log(`\n\ntest-wsc-persistence-contract: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

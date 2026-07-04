// test-ux2-cm-template-picker.mjs — UX-2 / D6 (Brock decision #3):
// CM demo seed → starter-template picker (Blank / eComm DC / B2B Retail /
// Cold Chain). Source-wiring scans on tools/cost-model/ui.js:
//   - createEmptyModel is BLANK (no demo operating data)
//   - the old eComm seed lives in CM_STARTER_TEMPLATES.ecomm_dc verbatim
//   - templates patch ONLY model keys the blank skeleton owns
//   - landing Create New opens the picker; picker uses the P3-4 overlay
//     discipline; draft chrome carries the "defaults" provenance chip
//
// Run:  node test-ux2-cm-template-picker.mjs

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const ui = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');
const emptyStart = ui.indexOf('function createEmptyModel()');
const emptyEnd = ui.indexOf('function defaultBucketFor(');
assert(emptyStart > 0 && emptyEnd > emptyStart);
const emptyBlock = ui.slice(emptyStart, emptyEnd);
const tplStart = ui.indexOf('const CM_STARTER_TEMPLATES = {');
assert(tplStart > 0, 'CM_STARTER_TEMPLATES missing');
const tplBlock = ui.slice(tplStart, emptyStart);

t('createEmptyModel is blank — demo operating data gone', () => {
  assert(emptyBlock.includes('volumeLines: [],'), 'volumeLines must be empty');
  assert(emptyBlock.includes('equipmentLines: [],'), 'equipmentLines must be empty');
  assert(emptyBlock.includes('overheadLines: [],'), 'overheadLines must be empty');
  assert(emptyBlock.includes('facility: { totalSqft: 0, clearHeightFt: 0 }'), 'facility must be zeroed');
  assert(!emptyBlock.includes('Reach Truck'), 'demo equipment leaked into blank skeleton');
  assert(!emptyBlock.includes('150000'), 'demo sqft leaked into blank skeleton');
});

t('blank skeleton keeps policy defaults (not fabricated customer data)', () => {
  assert(emptyBlock.includes('defaultBurdenPct: 32'), 'burden policy must stay');
  assert(emptyBlock.includes('pricingBuckets'), 'buckets are structural — must stay');
  assert(emptyBlock.includes('implementationTimeline'), 'ramp defaults must stay');
});

t('all four decision-#3 templates exist with label + description', () => {
  for (const k of ['blank', 'ecomm_dc', 'b2b_retail', 'cold_chain']) {
    assert(new RegExp(`${k}:\\s*\\{`).test(tplBlock), `template ${k} missing`);
  }
  assert(tplBlock.includes("label: 'Blank model'"), 'blank label');
  assert(tplBlock.includes("label: 'eComm DC'") && tplBlock.includes("label: 'B2B Retail'") && tplBlock.includes("label: 'Cold Chain'"), 'labels');
});

t('ecomm_dc carries the old starter seed (moved, not lost)', () => {
  assert(tplBlock.includes("'Reach Truck'"), 'reach truck seed');
  assert(tplBlock.includes('totalSqft: 150000'), '150k sqft seed');
  assert(tplBlock.includes("'Orders Shipped',      volume: 80000") || /Orders Shipped[^\n]*80000/.test(tplBlock), '80k orders seed');
});

t('template seeds patch only blank-skeleton keys (no parallel state)', () => {
  const ALLOWED = new Set(['volumeLines', 'facility', 'equipmentLines', 'overheadLines', 'projectDetails']);
  // seed object keys appear as "      volumeLines: [" etc. inside seed: { ... }
  const seedKeys = [...tplBlock.matchAll(/seed:\s*\{([\s\S]*?)\n    \}/g)]
    .flatMap(m => [...m[1].matchAll(/\n      (\w+):/g)].map(x => x[1]));
  assert(seedKeys.length >= 8, `expected seed keys across templates, got ${seedKeys.length}`);
  for (const k of seedKeys) assert(ALLOWED.has(k), `seed patches unknown model key "${k}"`);
});

t('applyStarterTemplate deep-copies + stamps provenance', () => {
  assert(ui.includes('function applyStarterTemplate(m, key)'), 'fn missing');
  assert(ui.includes('v.map(row => ({ ...row }))'), 'array rows must be copied');
  assert(ui.includes('m.projectDetails.starterTemplate = key'), 'provenance stamp missing');
});

t('Create New opens the picker; picker follows overlay discipline', () => {
  assert(/cm-create-new'\)\?\.addEventListener\('click', \(\) => \{\s*openCmTemplatePicker\(\);/.test(ui), 'landing CTA must open picker');
  assert(ui.includes("data-hub-overlay', 'cm-tpl-picker'"), 'P3-4 sweep attr missing');
  assert(ui.includes('__hubOverlayTeardown'), 'teardown hook missing');
  assert(ui.includes('_createNewModelFromTemplate(key)'), 'card → create path missing');
  // create path still prestamps the active deal (UX-1 D2 must survive)
  const createFn = ui.slice(ui.indexOf('function _createNewModelFromTemplate'), ui.indexOf('function openCmTemplatePicker'));
  assert(createFn.includes('dealContext.getActive()') && createFn.includes('projectDetails.dealId = _ctx.id'), 'deal prestamp lost');
});

t('draft chrome shows the starter-defaults chip', () => {
  assert(ui.includes('_starterChip'), 'chip missing');
  assert(/starterTemplate\)\s*\?\s*model\.projectDetails\.starterTemplate/.test(ui) || ui.includes('projectDetails?.starterTemplate'), 'chip must key on provenance stamp');
});

console.log('');
if (failures.length) console.error(failures.join('\n'));
console.log(`test-ux2-cm-template-picker: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

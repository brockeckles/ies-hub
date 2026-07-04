// test-ux2-cog-setup.mjs — UX-2 / D3: COG Quick Setup + freight presets
//
// Three halves:
//   1. calc.js freight-profile presets — every preset patch key must already
//      exist on DEFAULT_CONFIG (a preset may NEVER introduce state the
//      Engineering Parameters surface doesn't own), mode mixes sum to 100,
//      applyFreightPreset is pure, industry map only returns real keys.
//   2. shared/tier.js 'cog' entry is independent of 'cm'.
//   3. Source-wiring scans on tools/center-of-gravity/ui.js pinning the
//      no-parallel-state contract: every element id the Quick Setup canvas
//      renders (minus the preset select pair) must ALSO be rendered by an
//      Engineering phase, binders are the extracted shared ones, and the
//      tier open-remap runs BEFORE renderShell (CM ux2b walk-fix lesson).
//
// Run:  node test-ux2-cog-setup.mjs

import { readFileSync } from 'node:fs';
import * as calc from './tools/center-of-gravity/calc.js';
import * as tier from './shared/tier.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- 1. Freight-profile presets ----

const DEFAULT_KEYS = new Set(Object.keys(calc.DEFAULT_CONFIG));

t('at least the four assessment presets exist with label + summary + patch', () => {
  for (const k of ['pure_tl', 'tl_ltl_blend', 'dtc_parcel', 'food_bev_reefer']) {
    const p = calc.FREIGHT_PROFILE_PRESETS[k];
    assert(p, `missing preset ${k}`);
    assert(typeof p.label === 'string' && p.label.length > 4, `${k} label`);
    assert(typeof p.summary === 'string' && p.summary.length > 10, `${k} summary`);
    assert(p.patch && typeof p.patch === 'object', `${k} patch`);
  }
});

t('every preset patch key already exists on DEFAULT_CONFIG (no parallel state)', () => {
  for (const [k, p] of Object.entries(calc.FREIGHT_PROFILE_PRESETS)) {
    for (const key of Object.keys(p.patch)) {
      assert(DEFAULT_KEYS.has(key), `preset ${k} patches "${key}" — not a DEFAULT_CONFIG key`);
    }
  }
});

t('every preset mode mix sums to 100', () => {
  for (const [k, p] of Object.entries(calc.FREIGHT_PROFILE_PRESETS)) {
    const m = p.patch.modeMix;
    assert(m, `preset ${k} must state its full mode mix`);
    const sum = (m.tlPct || 0) + (m.ltlPct || 0) + (m.parcelPct || 0);
    assert(sum === 100, `preset ${k} mix sums to ${sum}`);
  }
});

t('applyFreightPreset is pure and introduces no unknown keys', () => {
  const before = { ...calc.DEFAULT_CONFIG };
  const frozen = JSON.stringify(before);
  const next = calc.applyFreightPreset(before, 'dtc_parcel');
  assert(JSON.stringify(before) === frozen, 'input config mutated');
  assert(next.freightPreset === 'dtc_parcel', 'freightPreset not stamped');
  assert(next.modeMixEnabled === true && next.modeMix.parcelPct === 80, 'patch not applied');
  for (const key of Object.keys(next)) {
    assert(DEFAULT_KEYS.has(key), `applyFreightPreset introduced unknown key "${key}"`);
  }
  // nested objects are copies, not shared references with the preset
  next.modeMix.tlPct = 999;
  assert(calc.FREIGHT_PROFILE_PRESETS.dtc_parcel.patch.modeMix.tlPct === 15, 'preset patch mutated via result');
  // unknown key = no-op copy
  const same = calc.applyFreightPreset(before, 'nope');
  assert(JSON.stringify(same) === frozen, 'unknown preset must return unchanged copy');
});

t('pure_tl preset leaves the engine on legacy single-rate math', () => {
  const next = calc.applyFreightPreset({ ...calc.DEFAULT_CONFIG }, 'pure_tl');
  assert(next.modeMixEnabled === false, 'pure TL must keep modeMixEnabled off');
  assert(next.transportCostPerMile === calc.DEFAULT_CONFIG.transportCostPerMile, 'TL rate untouched');
});

t('freightPresetForIndustry maps every industry to null or a real preset', () => {
  for (const o of calc.INDUSTRY_OPTIONS) {
    const k = calc.freightPresetForIndustry(o.value);
    assert(k === null || calc.FREIGHT_PROFILE_PRESETS[k], `industry ${o.value || '(blank)'} → ${k}`);
  }
  assert(calc.freightPresetForIndustry('dtc_ecom') === 'dtc_parcel');
  assert(calc.freightPresetForIndustry('retail') === 'pure_tl');
  assert(calc.freightPresetForIndustry('food_bev') === 'food_bev_reefer');
  assert(calc.freightPresetForIndustry('') === null);
  assert(calc.freightPresetForIndustry('other') === null);
});

t('DEFAULT_CONFIG carries freightPreset bookkeeping key (persists with scenario)', () => {
  assert(calc.DEFAULT_CONFIG.freightPreset === '', 'freightPreset default must be empty string');
});

// ---- 2. tier service: cog entry independent ----

t('cog tier defaults quick and persists independently of cm', () => {
  assert(tier.getTier('cog') === 'quick');
  tier.setTier('cog', 'engineering');
  assert(tier.getTier('cog') === 'engineering');
  assert(tier.getTier('cm') === 'quick', 'cm unaffected by cog flip');
  tier.setTier('cog', 'quick');
});

// ---- 3. COG ui.js wiring scans ----

const ui = readFileSync(new URL('./tools/center-of-gravity/ui.js', import.meta.url), 'utf8');

t('COG imports shared/tier.js with a cache-bust', () => {
  assert(/from '\.\.\/\.\.\/shared\/tier\.js\?v=[\w.-]+'/.test(ui), 'tier import missing/unpinned');
});

t('quick chrome groups + tier action + toggle handler wired', () => {
  assert(ui.includes('COG_QUICK_GROUPS'), 'COG_QUICK_GROUPS missing');
  assert(/key:\s*'setup',\s*label:\s*'Setup'/.test(ui), 'setup group missing');
  assert(ui.includes(`id: 'cog-tier'`), 'cog-tier action missing');
  assert(ui.includes(`if (id === 'cog-tier') return handleCogTierToggle();`), 'onAction dispatch missing');
  assert(ui.includes('function handleCogTierToggle()'), 'handleCogTierToggle missing');
});

t('renderContent dispatches setup phase to renderSetupPhase', () => {
  assert(/case 'setup':\s*renderSetupPhase\(el\); break;/.test(ui), 'setup dispatch missing');
  assert(ui.includes('function renderSetupPhase(el)'), 'renderSetupPhase missing');
});

t('tier open-remap runs BEFORE renderShell in openEditor (ux2b lesson)', () => {
  assert(ui.includes('function _applyCogTierOpenRemap()'), 'remap fn missing');
  const call = ui.indexOf('_applyCogTierOpenRemap();');
  assert(call > 0, 'remap never called');
  const shellAfter = ui.indexOf('rootEl.innerHTML = renderShell();', call);
  assert(shellAfter > call && shellAfter - call < 80,
    'remap call must immediately precede renderShell in openEditor');
});

t('Setup canvas reuses shared binders (no duplicated handlers)', () => {
  const si = ui.indexOf('function renderSetupPhase(el)');
  const ei = ui.indexOf('function renderInputsPhase(el)');
  assert(si > 0 && ei > si, 'setup block not found');
  const block = ui.slice(si, ei);
  assert(block.includes('_bindDemandIngestion(el, rerender)'), 'demand binder not reused');
  assert(block.includes('_bindParametersEvents(el, rerender)'), 'parameters binder not reused');
  assert(block.includes('calc.applyFreightPreset(config,'), 'preset must apply via pure calc helper');
  // extracted binders exist + Engineering phases still use them
  assert(ui.includes('function _bindDemandIngestion(el, rerender)'), 'demand binder fn missing');
  assert(ui.includes('function _bindParametersEvents(el, rerender)'), 'parameters binder fn missing');
  assert(ui.includes('_bindDemandIngestion(el, () => renderInputsPhase(el))'), 'inputs phase must reuse demand binder');
  assert(ui.includes('_bindParametersEvents(el, () => renderParametersPhase(el))'), 'parameters phase must reuse binder');
});

t('every Quick Setup element id is also rendered by an Engineering phase', () => {
  const si = ui.indexOf('function renderSetupPhase(el)');
  const ei = ui.indexOf('function renderInputsPhase(el)');
  const block = ui.slice(si, ei);
  const engineering = ui.slice(0, si) + ui.slice(ei);
  const QUICK_ONLY = new Set(['cog-freight-preset', 'cog-preset-suggested']);
  const ids = [...block.matchAll(/id="(cog-[\w-]+)"/g)].map(m => m[1]);
  assert(ids.length >= 8, `expected ≥8 ids in Setup canvas, got ${ids.length}`);
  for (const id of ids) {
    if (QUICK_ONLY.has(id)) continue;
    assert(engineering.includes(`id="${id}"`),
      `Setup renders "${id}" but no Engineering phase does — parallel-state risk`);
  }
});

t('quick keyboard remap: 1/2 land on Setup in quick tier', () => {
  assert(ui.includes(`if (tierSvc.getTier('cog') === 'quick' && (_ph === 'inputs' || _ph === 'parameters')) _ph = 'setup';`),
    'phaseMap quick remap missing');
});

t('dead legacy upload path is gone', () => {
  assert(!ui.includes('legacy inline-resolution path below'), 'unreachable legacy upload path still shipped');
});

// ---- results ----
console.log('');
if (failures.length) console.error(failures.join('\n'));
console.log(`test-ux2-cog-setup: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

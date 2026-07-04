// test-ux2-cm-standard.mjs — UX-2 / D3: shared tier service + CM Standard mode
//
// Two halves:
//   1. shared/tier.js behavior (node-safe, default quick, persistence map,
//      idempotent set, toggle, change events).
//   2. Source-wiring scans on tools/cost-model/ui.js pinning the Standard
//      spine's contract: 6 std sections, renderers registered, every std
//      input uses data-field/data-array attributes THE ENGINEERING SECTIONS
//      ALSO WRITE (rendering filter — no parallel state), tier toggle action
//      wired, Advanced escape hatches present, provenance gate includes
//      std-results.
//
// Run:  node test-ux2-cm-standard.mjs

import { readFileSync } from 'node:fs';
import * as tier from './shared/tier.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- 1. shared/tier.js ----

t('default tier is quick (Brock decision #2)', () => {
  assert(tier.getTier('cm') === 'quick', `got ${tier.getTier('cm')}`);
  assert(tier.getTier('never-seen-tool') === 'quick');
});

t('setTier persists per tool independently', () => {
  tier.setTier('cm', 'engineering');
  assert(tier.getTier('cm') === 'engineering');
  assert(tier.getTier('wsc') === 'quick', 'other tools unaffected');
  tier.setTier('cm', 'quick');
});

t('invalid tier ignored; invalid tool ignored', () => {
  tier.setTier('cm', 'bogus');
  assert(tier.getTier('cm') === 'quick');
  assert(tier.setTier('', 'engineering') === 'quick');
});

t('toggleTier flips and returns the new tier', () => {
  const a = tier.toggleTier('cm');
  assert(a === 'engineering', `got ${a}`);
  assert(tier.toggleTier('cm') === 'quick');
});

t('onChange fires on real change, not on no-op set', () => {
  const seen = [];
  const off = tier.onChange(p => seen.push(p));
  tier.setTier('cm', 'quick');        // no-op — already quick
  tier.setTier('cm', 'engineering');  // real change
  off();
  tier.setTier('cm', 'quick');        // after unsubscribe (also restores default)
  assert(seen.length === 1, `expected 1 event, got ${seen.length}`);
  assert(seen[0].tool === 'cm' && seen[0].tier === 'engineering');
});

// ---- 2. CM Standard mode wiring scans ----

const ui = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');

t('6 std sections defined and every renderer registered', () => {
  for (const k of ['std-basics', 'std-volume', 'std-building', 'std-labor', 'std-money', 'std-results']) {
    assert(ui.includes(`key: '${k}'`), `STD_SECTIONS missing ${k}`);
    assert(new RegExp(`'${k}':\\s*render`).test(ui), `renderers map missing ${k}`);
  }
  // Results reuses the Summary renderer — answer-first, no duplicate markup.
  assert(/'std-results':\s*renderSummary/.test(ui), 'std-results must be renderSummary');
});

t('CM imports shared/tier.js with a cache-bust', () => {
  assert(/from '\.\.\/\.\.\/shared\/tier\.js\?v=[\w.-]+'/.test(ui), 'tier import missing/unpinned');
});

t('tier toggle action wired in chrome + handler', () => {
  assert(ui.includes(`id: 'cm-tier'`), 'cm-tier action missing from chrome opts');
  assert(ui.includes(`if (id === 'cm-tier')   return handleTierToggle();`), 'onAction dispatch missing');
  assert(ui.includes('function handleTierToggle()'), 'handleTierToggle missing');
});

t('every Standard input binds a data-field/data-array path Engineering also writes', () => {
  // The Standard renderers live between these two banners.
  const start = ui.indexOf('STANDARD MODE RENDERERS');
  const end = ui.indexOf('// SECTION 1: SETUP');
  assert(start > 0 && end > start, 'renderer block not found');
  const block = ui.slice(start, end);
  const engineering = ui.slice(0, start) + ui.slice(end);
  const paths = [...block.matchAll(/data-field="([^"]+)"/g)].map(m => m[1])
    .filter(p => !p.startsWith('_')); // scalar-array sentinel not used here
  assert(paths.length >= 20, `expected ≥20 data-field bindings in Standard block, got ${paths.length}`);
  for (const path of paths) {
    // channels.0.x in Standard corresponds to channels.${activeIdx}.x in
    // Engineering — normalize before comparing.
    const engPath = path.replace(/^channels\.0\./, 'channels.${activeIdx}.');
    assert(
      engineering.includes(`data-field="${engPath}"`) || engineering.includes(`data-field="${path}"`),
      `Standard binds "${path}" but no Engineering section renders it — parallel state risk`,
    );
  }
  // laborLines array bindings must match Engineering's exact field names.
  for (const f of ['activity_name', 'base_uph', 'volume', 'hourly_rate']) {
    assert(block.includes(`data-array="laborLines" data-idx="\${i}" data-field="${f}"`),
      `Standard labor table missing laborLines.${f} binding`);
  }
});

t('auto-gen actions reused, not reimplemented', () => {
  const start = ui.indexOf('STANDARD MODE RENDERERS');
  const block = ui.slice(start, ui.indexOf('// SECTION 1: SETUP'));
  for (const a of ['auto-gen-indirect', 'auto-gen-equipment', 'auto-gen-overhead', 'auto-gen-startup']) {
    assert(block.includes(`data-action="${a}"`), `Standard missing ${a} button`);
    // and the handler case must already exist OUTSIDE the std block
    assert(ui.includes(`case '${a}'`), `no existing handler for ${a}`);
  }
});

t('Advanced escape hatch per step + std-advanced/std-goto cases wired', () => {
  const start = ui.indexOf('STANDARD MODE RENDERERS');
  const block = ui.slice(start, ui.indexOf('// SECTION 1: SETUP'));
  for (const target of ['setup', 'volumes', 'facility', 'labor', 'financial']) {
    // advTarget flows into data-std-target via the _stdCard template.
    assert(block.includes(`advTarget: '${target}'`), `no Advanced link to ${target}`);
  }
  assert(block.includes('data-std-target="${advTarget}"'), '_stdCard must render the escape hatch');
  assert(ui.includes(`case 'std-advanced':`), 'std-advanced case missing');
  assert(ui.includes(`case 'std-goto':`), 'std-goto case missing');
});

t('provenance click gate admits std-results', () => {
  assert(ui.includes(`activeSection !== 'summary' && activeSection !== 'std-results'`),
    'std-results P&L cells would be dead');
});

t('cross-boundary navigation persists the tier preference', () => {
  assert(/navigateSection\(key\)\s*{\s*\n[^]*?_isStdKey\(key\) !== _isStdKey\(activeSection\)/.test(ui),
    'navigateSection missing the boundary check');
  assert(ui.includes(`tierSvc.setTier('cm', _isStdKey(key) ? 'quick' : 'engineering')`),
    'boundary crossing must persist tier');
});

t('quick-tier editor open remaps mapped Engineering sections to std', () => {
  assert(ui.includes(`tierSvc.getTier('cm') === 'quick' && ENG_TO_STD[activeSection]`),
    'renderSection open-remap missing');
});

t('completeness proxies std keys through STD_TO_ENG', () => {
  assert(ui.includes('(k) => _sectionCompleteness(STD_TO_ENG[k] || k)'),
    'sectionCompleteness proxy missing');
});

// ---- Report ----
console.log(`\ntest-ux2-cm-standard: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }

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

// ---- 2. M8b (2026-07-22, Brock GO): the std-* Standard spine is DELETED ----
// Quick depth lives in the D shell's Essentials pill; shared/tier.js still
// owns the preference (part 1 above). These pins keep the spine dead and the
// stale-key migration alive.

const ui = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');

t('CM imports shared/tier.js with a cache-bust', () => {
  assert(/from '\.\.\/\.\.\/shared\/tier\.js\?v=[\w.-]+'/.test(ui), 'tier import missing/unpinned');
});

t('std spine stays deleted: no STD_SECTIONS, no renderers, no cm-tier', () => {
  assert(!ui.includes('STD_SECTIONS'), 'STD_SECTIONS resurrected');
  assert(!/function renderStd/.test(ui), 'a renderStd* renderer resurrected');
  assert(!ui.includes("id: 'cm-tier'"), 'cm-tier chrome action resurrected');
  assert(!ui.includes('handleTierToggle'), 'handleTierToggle resurrected');
  assert(!ui.includes("case 'std-advanced'") && !ui.includes("case 'std-goto'"), 'std action cases resurrected');
});

t('stale std keys from pre-M8b sessions migrate to their Engineering section', () => {
  assert(ui.includes('const STD_MIGRATE'), 'migration map missing');
  for (const [k, v] of [['std-basics','setup'],['std-volume','volumes'],['std-building','facility'],
                        ['std-labor','labor'],['std-money','financial'],['std-results','summary']]) {
    assert(new RegExp(`'${k}':\\s*'${v}'`).test(ui), `migration missing ${k} -> ${v}`);
  }
  assert(ui.includes('function _migrateStaleStdKey'), 'migration fn missing');
  assert(/_migrateStaleStdKey\(\);/.test(ui), 'migration must run in renderCurrentView');
});

t('depth pill still writes the shared tier preference (one preference, one chrome)', () => {
  assert(ui.includes("depth: tierSvc.getTier('cm') === 'quick' ? 'essentials' : 'engineering'"),
    'depth derives from the tier service');
  const i = ui.indexOf("closest('[data-cmd-depth]')");
  assert(i > 0, 'depth-pill delegation bound');
  assert(ui.slice(i, i + 420).includes("tierSvc.setTier('cm'"), 'depth pill writes the tier');
});

// ---- Report ----
console.log(`\ntest-ux2-cm-standard: ${passed} passed, ${failed} failed.`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }

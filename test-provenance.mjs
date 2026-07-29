// test-provenance.mjs — S7c (2026-07-28): shared value-provenance grammar.
//
// Locks the contract of shared/provenance.js — the ONE visual language for
// derived / overridden / linked values (pilot surface: CM Volumes page).
// Key rules pinned here:
//   1. manual renders NOTHING (the quiet-default rule);
//   2. state pills carry their glyph (never color alone);
//   3. ghost-derived line exists for pinned values (drift visibility);
//   4. all user-supplied strings are escaped.
//
// Run: node test-provenance.mjs

import {
  PROV_STATES,
  fxGlyph,
  provPill,
  ghostDerived,
  provInputClass,
  provenanceStyles,
} from './shared/provenance.js?v=20260728-s7c';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

t('state model is the four-state grammar', () => {
  assert(JSON.stringify(PROV_STATES) === JSON.stringify(['manual', 'derived', 'override', 'linked']),
    `states drifted: ${PROV_STATES}`);
});

t('manual renders NOTHING — quiet-default rule', () => {
  assert(provPill('manual', 'anything') === '', 'manual must not decorate');
  assert(provPill('bogus', 'x') === '', 'unknown states render nothing');
  assert(provInputClass('manual') === '' && provInputClass() === '', 'no input class for manual');
});

t('pills carry state class + glyph (never color alone)', () => {
  const o = provPill('override', 'override +8.3%', 'pinned vs derived');
  assert(o.includes('hub-prov-pill--override'), 'override class');
  assert(o.includes('⚑'), 'override flag glyph');
  assert(o.includes('title="pinned vs derived"'), 'tooltip travels with the pill');
  const l = provPill('linked', 'WSC');
  assert(l.includes('hub-prov-pill--linked') && l.includes('⇄'), 'linked class + glyph');
  const d = provPill('derived', 'auto');
  assert(d.includes('hub-prov-pill--derived'), 'derived class');
});

t('fx glyph defaults to an override-affordance tooltip', () => {
  const g = fxGlyph();
  assert(g.includes('class="hub-fx"'), 'glyph class');
  assert(/title="[^"]*override[^"]*"/.test(g), 'default tooltip mentions override');
  assert(fxGlyph('22.8M ÷ 12 units/case').includes('22.8M ÷ 12 units/case'), 'formula tooltip');
});

t('ghost-derived line shows the CURRENT derived value (drift rule)', () => {
  const g = ghostDerived('2,280,000');
  assert(g.includes('hub-prov-ghost'), 'ghost class');
  assert(g.includes('ƒ 2,280,000 derived'), 'ghost format');
});

t('input classes map derived/override only', () => {
  assert(provInputClass('derived') === 'hub-in--derived');
  assert(provInputClass('override') === 'hub-in--override');
  assert(provInputClass('linked') === '', 'linked inputs are not a thing — linked values are read-only displays');
});

t('user strings are escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  assert(!provPill('derived', evil).includes('<img'), 'pill label escaped');
  assert(!fxGlyph(evil).includes('<img'), 'glyph title escaped');
  assert(!ghostDerived(evil).includes('<img'), 'ghost text escaped');
});

t('style block covers every non-manual state + row/input/ghost treatments', () => {
  const css = provenanceStyles();
  for (const sel of ['hub-fx', 'hub-prov-pill--derived', 'hub-prov-pill--override',
    'hub-prov-pill--linked', 'hub-prov-ghost', 'hub-in--derived', 'hub-in--override',
    'hub-val--override', 'hub-prov-row--override']) {
    assert(css.includes(sel), `missing selector: ${sel}`);
  }
  assert(css.includes('id="hub-prov-styles"'), 'guarded style id');
});

console.log('\n');
if (failures.length) { for (const f of failures) console.log(f); }
console.log(`test-provenance: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);

// test-back-dirty-guard.mjs — chrome ← Back dirty-guard (2026-07-04)
//
// The router's confirmLeaveIfDirty only fires on hashchange. Every tool's
// chrome ← Back button is an IN-TOOL view swap (no hashchange), so each
// tool's onBack must consult dirty state itself before leaving the editor.
// COG/NetOpt/Fleet/WSC always did; CM and MOST silently discarded drafts.
//
// Source-scan pins (P3-3 extension):
//   1. CM onBack confirms via getIsDirty() + showConfirm, then resetDirty().
//   2. MOST has ZERO bare `onBack: () => { renderMostLanding(); }` left;
//      both sites consult guardListDirty().includes('most').
//   3. Regression net: COG / NetOpt / Fleet / WSC onBack confirms survive.
//
// Run:  node test-back-dirty-guard.mjs

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const cm = readFileSync('./tools/cost-model/ui.js', 'utf8');
const most = readFileSync('./tools/most-standards/ui.js', 'utf8');

// Extract the onBack handler body (from `onBack:` to the next `onAction:`).
function onBackBlocks(src) {
  const blocks = [];
  const re = /onBack:\s*(?:async\s*)?\(\)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    let depth = 0, i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    blocks.push(src.slice(start, i + 1));
  }
  return blocks;
}

// ---- 1. CM ----

t('CM has exactly one onBack and it consults getIsDirty + showConfirm', () => {
  const blocks = onBackBlocks(cm);
  assert(blocks.length === 1, `expected 1 CM onBack, found ${blocks.length}`);
  const b = blocks[0];
  assert(/getIsDirty\(\)/.test(b), 'onBack must consult getIsDirty()');
  assert(/await showConfirm\(/.test(b), 'onBack must confirm before leaving');
  assert(/resetDirty\(\)/.test(b), 'onBack must explicit-discard via resetDirty()');
});

t('CM onBack confirm gates the landing swap (guard BEFORE viewMode flip)', () => {
  const b = onBackBlocks(cm)[0];
  const guardIdx = b.indexOf('getIsDirty()');
  const flipIdx = b.indexOf("viewMode = 'landing'");
  assert(guardIdx !== -1 && flipIdx !== -1 && guardIdx < flipIdx,
    'dirty check must precede the view swap');
  assert(/if\s*\(getIsDirty\(\)[^)]*&&\s*!\(await showConfirm/.test(b.replace(/\n\s*/g, ' ')),
    'cancel path must return before any state changes');
});

// ---- 2. MOST ----

t('MOST has no bare unguarded onBack left', () => {
  assert(!/onBack:\s*\(\)\s*=>\s*\{\s*renderMostLanding\(\);\s*\},/.test(most),
    'found a bare onBack: () => { renderMostLanding(); }');
});

t('both MOST onBack sites consult guardListDirty and clean before leaving', () => {
  const blocks = onBackBlocks(most);
  assert(blocks.length === 2, `expected 2 MOST onBack sites, found ${blocks.length}`);
  for (const b of blocks) {
    assert(/guardListDirty\(\)\.includes\('most'\)/.test(b), 'must consult guardListDirty()');
    assert(/await showConfirm\(/.test(b), 'must confirm');
    assert(/guardMarkClean\('most'\)/.test(b), 'must explicit-discard');
    assert(b.indexOf('showConfirm') < b.indexOf('renderMostLanding'),
      'confirm must precede the landing render');
  }
});

t('MOST imports listDirty from the shared guard', () => {
  assert(/import\s*\{[^}]*listDirty as guardListDirty[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/unsaved-guard\.js/.test(most),
    'guardListDirty import missing');
});

// ---- 3. regression net: previously-guarded tools stay guarded ----

for (const [tool, path, needle] of [
  ['COG',    './tools/center-of-gravity/ui.js', /onBack[\s\S]{0,200}?isDirty[\s\S]{0,120}?showConfirm/],
  ['NetOpt', './tools/network-opt/ui.js',       /onBack[\s\S]{0,200}?isDirty[\s\S]{0,120}?showConfirm/],
  ['Fleet',  './tools/fleet-modeler/ui.js',     /onBack[\s\S]{0,260}?showConfirm/],
  ['WSC',    './tools/warehouse-sizing/ui-shell-events.js', /onBack[\s\S]{0,1600}?isDirty[\s\S]{0,200}?showConfirm/],
]) {
  t(`${tool} onBack confirm survives`, () => {
    const src = readFileSync(path, 'utf8');
    assert(needle.test(src), `${tool} onBack lost its dirty confirm`);
  });
}

process.stdout.write('\n');
if (failed) {
  console.error(failures.join('\n'));
  console.error(`test-back-dirty-guard: ${passed} passed, ${failed} FAILED.`);
  process.exit(1);
}
console.log(`test-back-dirty-guard: ${passed} passed, 0 failed.`);

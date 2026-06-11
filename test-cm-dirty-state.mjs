// test-cm-dirty-state.mjs — pins the 2026-06-11 dirty-state extraction
// (the assessment's final Low-tier leftover: "CM state.js extraction").
//
// History: isDirty / lastSavedAt / lastSavedBy lived as ui.js module-level
// vars with 82 _markCmDirty() call sites and 13 scattered `isDirty = false`
// resets — untestable without a DOM. The STATE now lives in state.js
// (state-layer-lite); ui.js keeps only the _markCmDirty wrapper for its
// chrome-refresh side effect, gated on markDirty()'s transition return.
//
// Run:  node test-cm-dirty-state.mjs

import {
  cmState, markDirty, resetDirty, getIsDirty,
  setSavedMeta, getLastSavedAt, getLastSavedBy, formatSavedWhen,
  resetAll, setModel,
} from './tools/cost-model/state.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

t('markDirty: clean→dirty returns true; repeat calls return false (idempotent)', () => {
  resetAll();
  eq(getIsDirty(), false, 'starts clean');
  eq(markDirty(), true, 'first call transitions');
  eq(getIsDirty(), true, 'now dirty');
  eq(markDirty(), false, 'second call is a no-op');
  eq(markDirty(), false, 'third call is a no-op');
  eq(cmState.isDirty, true, 'live cmState ref agrees');
});

t('resetDirty re-arms the transition', () => {
  resetAll();
  markDirty();
  resetDirty();
  eq(getIsDirty(), false, 'clean after reset');
  eq(markDirty(), true, 'transition fires again');
});

t('setSavedMeta stores + normalizes falsy to null', () => {
  resetAll();
  setSavedMeta('2026-06-11T14:00:00Z', 'brock.eckles@gxo.com');
  eq(getLastSavedAt(), '2026-06-11T14:00:00Z', 'at');
  eq(getLastSavedBy(), 'brock.eckles@gxo.com', 'by');
  setSavedMeta(undefined, '');
  eq(getLastSavedAt(), null, 'undefined → null');
  eq(getLastSavedBy(), null, 'empty string → null');
});

t('formatSavedWhen: never-saved → empty string', () => {
  resetAll();
  eq(formatSavedWhen(), '', 'no timestamp');
});

t('formatSavedWhen: invalid date → empty string', () => {
  resetAll();
  setSavedMeta('not-a-date', null);
  eq(formatSavedWhen(), '', 'unparseable');
});

t('formatSavedWhen: same-day → time-only + email local-part', () => {
  resetAll();
  const today = new Date();
  today.setHours(14, 30, 0, 0);
  setSavedMeta(today.toISOString(), 'brock.eckles@gxo.com');
  const s = formatSavedWhen();
  assert(s.startsWith('Saved '), `prefix: ${s}`);
  assert(s.includes(' · brock.eckles'), `who suffix (local-part only): ${s}`);
  assert(!s.includes('@'), `domain stripped: ${s}`);
  // Same-day format carries no month name.
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  assert(!monthNames.some(m => s.includes(m)), `time-only, no date: ${s}`);
});

t('formatSavedWhen: prior-day → month+day format, no who when by=null', () => {
  resetAll();
  setSavedMeta('2025-03-05T10:00:00Z', null);
  const s = formatSavedWhen();
  assert(s.startsWith('Saved '), `prefix: ${s}`);
  assert(!s.includes('·'), `no who separator: ${s}`);
  assert(s.includes('Mar') || s.includes('3'), `carries the date: ${s}`);
});

t('resetAll wipes dirty + save meta alongside the original 8 bindings', () => {
  setModel({ id: 42 });
  markDirty();
  setSavedMeta('2026-06-11T14:00:00Z', 'x@y.com');
  resetAll(null);
  eq(getIsDirty(), false, 'isDirty wiped');
  eq(getLastSavedAt(), null, 'lastSavedAt wiped');
  eq(getLastSavedBy(), null, 'lastSavedBy wiped');
  eq(cmState.model, null, 'model wiped (original behavior intact)');
});

console.log(`\ntest-cm-dirty-state: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

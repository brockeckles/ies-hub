/**
 * P3-4 (2026-07-03) — orphaned-overlay sweep on navigation.
 *
 * Views mark transient body-level overlays with data-hub-overlay at
 * creation; the router sweeps them per navigation (calling
 * __hubOverlayTeardown when attached — the slide-over needs to unmount its
 * embedded tool). confirm-modal / toast / auth / tour / FAB stay unmarked:
 * the unsaved-guard legitimately renders a confirm mid-hashchange.
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}
async function ta(name, fn) {
  try { if ((await fn()) === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// ── functional: router sweep with a stub DOM ─────────────────────────────
class StubNode {
  constructor(attrs = {}) { this.attrs = { ...attrs }; this.innerHTML = ''; this.parentNode = null; this.removed = false; }
  cloneNode() { return new StubNode(this.attrs); }
  replaceWith(n) { n.parentNode = this.parentNode; this.parentNode = null; }
  addEventListener() {}
  remove() { this.removed = true; }
}
const orphanPlain = new StubNode();
let teardownCalled = 0;
const orphanRich = new StubNode();
orphanRich.__hubOverlayTeardown = () => { teardownCalled++; };
let overflowReset = null;
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, location: { hash: '#overview' } };
globalThis.document = {
  querySelectorAll: (sel) => (sel === 'body > [data-hub-overlay]' ? [orphanPlain, orphanRich] : []),
  body: { style: { set overflow(v) { overflowReset = v; }, get overflow() { return overflowReset; } } },
};

const { Router } = await import('./shared/router.js?v=20260710-r3');

await ta('router sweep removes plain orphans, calls rich teardowns, resets scroll lock', async () => {
  const r = new Router();
  r.register('overview', { title: 'x', load: async () => ({ mount: () => {} }) });
  const outlet = new StubNode({ id: 'hub-content' });
  outlet.parentNode = {};
  r._outlet = outlet;
  await r._onHashChange();
  if (!orphanPlain.removed) throw new Error('plain orphan not removed');
  if (teardownCalled !== 1) throw new Error('rich teardown not called exactly once: ' + teardownCalled);
  if (orphanRich.removed) throw new Error('rich orphan should be torn down via its hook, not remove()');
  if (overflowReset !== '') throw new Error('body scroll lock not reset');
  return true;
});
delete globalThis.document; // don't leak the stub into other assertions

// ── source scans: every body-appended transient overlay is marked ────────
const EXPECT = {
  'tools/cost-model/ui.js': 7,
  'tools/most-standards/ui.js': 1,
  'hub/admin/ui.js': 2,
  'hub/deal-management/ui.js': 1,
  'shared/scenario-landing.js': 1,
  'shared/tool-slideover.js': 1,
  'tools/center-of-gravity/ui.js': 1,
};
for (const [file, n] of Object.entries(EXPECT)) {
  t(`${file}: ${n} marked overlay(s)`, () => {
    const src = readFileSync('./' + file, 'utf8');
    const marks = (src.match(/\.dataset\.hubOverlay = '1'/g) || []).length;
    if (marks !== n) throw new Error(`expected ${n} marks, found ${marks}`);
    return true;
  });
}
t('slide-over attaches the rich teardown hook (embedded-tool unmount path)', () =>
  readFileSync('./shared/tool-slideover.js', 'utf8').includes('overlay.__hubOverlayTeardown = () => close();'));
t('router sweep exists and is document-guarded (node-safe)', () => {
  const src = readFileSync('./shared/router.js', 'utf8');
  return src.includes("querySelectorAll('body > [data-hub-overlay]')")
    && src.includes("typeof document !== 'undefined'")
    && src.includes("document.body.style.overflow = ''");
});
t('whitelisted shared overlays stay UNMARKED (confirm renders mid-navigation)', () => {
  for (const f of ['shared/confirm-modal.js', 'shared/toast.js', 'shared/tour.js', 'shared/feedback-fab.js', 'shared/auth.js']) {
    if (readFileSync('./' + f, 'utf8').includes('hubOverlay')) throw new Error(f + ' is marked');
  }
  return true;
});

console.log(`test-modal-teardown-p34: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);

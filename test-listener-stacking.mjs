/**
 * P3-1 listener stacking (2026-07-03) — regression guards.
 *
 * Three fixes under test:
 *   1. Router swaps in a fresh outlet node per navigation, so listeners
 *      attached to the outlet itself die with the old node (cross-mount
 *      stacking class).
 *   2. bindToolChromeEvents uses the live-context pattern: ONE click
 *      listener per rootEl node (guarded by __tcClickBound, which tools
 *      never reset), dispatching to the latest handlers via __tcHandlers
 *      (within-mount stacking class — tools re-bind on every shell
 *      re-render).
 *   3. Command-center bindEvents guarded (was stacking 2 listeners per
 *      5-min auto-refresh); WSC 3D fallback window.mouseup single-live.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
function t(name, fn) {
  try { const r = fn(); if (r === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}
async function ta(name, fn) {
  try { const r = await fn(); if (r === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// ── 1. Router outlet swap — functional ───────────────────────────────────
class StubNode {
  constructor(attrs = {}) {
    this.attrs = { ...attrs };
    this.innerHTML = '';
    this.listeners = [];
    this.parentNode = null;
    this.replacedWith = null;
  }
  cloneNode(deep) { if (deep) throw new Error('expected cloneNode(false)'); return new StubNode(this.attrs); }
  replaceWith(n) { n.parentNode = this.parentNode; this.replacedWith = n; this.parentNode = null; }
  addEventListener(type, fn) { this.listeners.push({ type, fn }); }
}

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: '#overview' },
};

const { Router } = await import('./shared/router.js?v=20260722-s3b');

await ta('router mounts each navigation into a FRESH outlet node (listeners die with the old one)', async () => {
  const r = new Router();
  const mounted = [];
  r.register('overview', { title: 'CC', load: async () => ({ mount: el => { mounted.push(el); el.addEventListener('click', () => {}); } }) });
  const outlet = new StubNode({ id: 'hub-content' });
  outlet.parentNode = {};
  r._outlet = outlet;
  await r._onHashChange();
  await r._onHashChange();
  if (mounted.length !== 2) throw new Error('expected 2 mounts, got ' + mounted.length);
  if (mounted[0] === mounted[1]) throw new Error('outlet node was reused across navigations');
  if (mounted[1].listeners.length !== 1) throw new Error('fresh node carried stale listeners');
  return true;
});

await ta('router swap preserves outlet attributes (id survives cloneNode(false))', async () => {
  const r = new Router();
  let seen = null;
  r.register('overview', { title: 'CC', load: async () => ({ mount: el => { seen = el; } }) });
  const outlet = new StubNode({ id: 'hub-content' });
  outlet.parentNode = {};
  r._outlet = outlet;
  await r._onHashChange();
  return seen && seen.attrs.id === 'hub-content';
});

// ── 2. tool-chrome live-context bind — functional ────────────────────────
const tc = await import('./shared/tool-chrome.js?v=20260706-r1');

await ta('bindToolChromeEvents adds exactly ONE click listener even after legacy __tcBound=false reset', async () => {
  const rootEl = {
    listeners: [],
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    contains: () => true,
    querySelector: () => null,
  };
  tc.bindToolChromeEvents(rootEl, { onAction: () => {} });
  rootEl.__tcBound = false; // what every tool does per shell re-render
  tc.bindToolChromeEvents(rootEl, { onAction: () => {} });
  rootEl.__tcBound = false;
  tc.bindToolChromeEvents(rootEl, { onAction: () => {} });
  const clicks = rootEl.listeners.filter(l => l.type === 'click');
  if (clicks.length !== 1) throw new Error(`expected 1 click listener, got ${clicks.length}`);
  return true;
});

await ta('re-bind dispatches to the LATEST handlers (live context, no stale closures)', async () => {
  const calls = [];
  const rootEl = {
    listeners: [],
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    contains: () => true,
    querySelector: () => null,
  };
  tc.bindToolChromeEvents(rootEl, { onAction: id => calls.push('stale:' + id) });
  rootEl.__tcBound = false;
  tc.bindToolChromeEvents(rootEl, { onAction: id => calls.push('live:' + id) });
  const clickEvt = {
    target: { closest: sel => (sel === '[data-tc-action]' ? { dataset: { tcAction: 'run' } } : null) },
  };
  for (const l of rootEl.listeners.filter(l => l.type === 'click')) l.fn(clickEvt);
  if (calls.length !== 1) throw new Error(`action fired ${calls.length} times (stacking!): ${calls.join(',')}`);
  if (calls[0] !== 'live:run') throw new Error(`stale closure won: ${calls[0]}`);
  return true;
});

// ── 3. Source scans — wiring guarantees ──────────────────────────────────
const routerSrc = readFileSync('./shared/router.js', 'utf8');
const tcSrc = readFileSync('./shared/tool-chrome.js', 'utf8');
const ccSrc = readFileSync('./hub/command-center/ui.js', 'utf8');
const wsc3dSrc = readFileSync('./tools/warehouse-sizing/ui-3d.js', 'utf8');

t('router source contains the outlet swap (cloneNode(false) + replaceWith)', () =>
  routerSrc.includes('cloneNode(false)') && routerSrc.includes('this._outlet.replaceWith(fresh)'));
t('tool-chrome click bind guarded by __tcClickBound (not the tool-resettable __tcBound)', () =>
  tcSrc.includes('rootEl.__tcClickBound') && !/if \(!rootEl \|\| rootEl\.__tcBound\) return;/.test(tcSrc));
t('tool-chrome click dispatch reads live __tcHandlers', () =>
  /const h = rootEl\.__tcHandlers \|\| \{\};/.test(tcSrc));
t('tool-chrome keydown shortcut reads live __tcHandlers too', () =>
  tcSrc.includes('if (!h.onPrimaryShortcut) return;'));
t('command-center bindEvents guarded by __ccBound (5-min refresh was stacking 2 listeners per tick)', () =>
  /if \(!rootEl \|\| rootEl\.__ccBound\) return;\s*\n\s*rootEl\.__ccBound = true;/.test(ccSrc));
t('WSC 3D fallback mouseup is single-live (remove-before-add)', () =>
  wsc3dSrc.includes("window.removeEventListener('mouseup', _wsc3dPrevMouseUp)")
  && !/window\.addEventListener\('mouseup',\s*\(\)/.test(wsc3dSrc));

// ── 4. Cache-bust consistency for every module touched by this pass ─────
const MODULES = [
  'router\\.js', 'search\\.js', 'tool-chrome\\.js', 'command-center/ui\\.js',
  'ui-3d\\.js', 'ui-shell-events\\.js', 'center-of-gravity/ui\\.js',
  'cost-model/ui\\.js', 'fleet-modeler/ui\\.js',
  'most-standards/ui\\.js', 'network-opt/ui\\.js', 'warehouse-sizing/ui\\.js',
];
function walk(dir, acc) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(js|html)$/.test(f)) acc.push(p);
  }
  return acc;
}
const files = ['index.html', ...walk('shared', []), ...walk('tools', []), ...walk('hub', [])];
const blob = files.map(f => readFileSync(f, 'utf8')).join('\n');
for (const m of MODULES) {
  t(`all ?v= refs to ${m.replace(/\\\\/g, '')} agree (no drift)`, () => {
    const versions = new Set([...blob.matchAll(new RegExp(m + '\\?v=([A-Za-z0-9-]+)', 'g'))].map(x => x[1]));
    if (versions.size > 1) throw new Error('drift: ' + [...versions].join(' vs '));
    return versions.size === 1;
  });
}

console.log(`test-listener-stacking: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);

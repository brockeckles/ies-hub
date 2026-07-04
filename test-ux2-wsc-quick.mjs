// test-ux2-wsc-quick.mjs — UX-2 WSC Quick Size (2026-07-04).
//
// Quick tier = Quick Size panel (5 inputs) + Dashboard + 3D walkthrough;
// 2D Plan/Elevation are the IE bench behind the Engineering toggle. 3D is
// the KEEPER (Brock 2026-07-04: design-process critical, beef-up thread
// open) — it must be present in BOTH tiers.
//
// Engines untouched: the quick panel writes the same facility/zones/volumes
// state through the same data-fac / data-vol attributes bindConfigEvents
// already delegates on.
//
// Run:  node test-ux2-wsc-quick.mjs

import { readFileSync } from 'node:fs';
import { WSC_QUICK_MIX_PRESETS } from './tools/warehouse-sizing/ui-config.js';
import * as tier from './shared/tier.js';

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

const ui = readFileSync('./tools/warehouse-sizing/ui.js', 'utf8');
const cfg = readFileSync('./tools/warehouse-sizing/ui-config.js', 'utf8');
const shell = readFileSync('./tools/warehouse-sizing/ui-shell-events.js', 'utf8');

// ── tier wiring ──────────────────────────────────────────────────────────
t('quick sections = dashboard + 3d only (3D is the keeper, in both tiers)', () => {
  assert(/WSC_QUICK_SECTIONS = WSC_SECTIONS\.filter\(s => s\.key === 'dashboard' \|\| s\.key === '3d'\)/.test(ui),
    'quick section filter wrong');
  assert(ui.includes("sections: _quick ? WSC_QUICK_SECTIONS : WSC_SECTIONS"), 'chrome opts not tier-aware');
});

t('tier toggle action exists and routes through the shell', () => {
  assert(ui.includes("id: 'wsc-tier'"), 'wsc-tier action missing');
  assert(shell.includes("if (id === 'wsc-tier') return sctx.handleWscTierToggle();"), 'shell routing missing');
  assert(ui.includes('handleWscTierToggle,'), 'handler not exposed in sctx');
});

t('flip to quick lands on dashboard when a bench view is active', () =>
  // N1 (2026-07-04): Design Basis joins plan/elevation as an Engineering-only
  // bench view — flipping to quick must land it on dashboard too.
  assert(/toQuick && \(activeView === 'plan' \|\| activeView === 'elevation' \|\| activeView === 'basis'\)\) activeView = 'dashboard';/.test(ui)));

t('tier persists via shared tier service (default quick, decision #2)', () => {
  assert(ui.includes("tierSvc.getTier('wsc')") && ui.includes("tierSvc.setTier('wsc'"), 'tier service not used');
  assert(tier.TIERS.includes('quick') && tier.TIERS.includes('engineering'));
});

// ── quick panel ──────────────────────────────────────────────────────────
t('sidebar renders Quick Size panel in quick, full Configure in engineering', () => {
  assert(ui.includes("(_quick ? renderQuickConfigHtml : renderConfigHtml)(_makeConfigCtx())"), 'chrome sidebar not tier-aware');
  assert(/_wscQuickChrome\(\) \? renderQuickConfigHtml : renderConfigHtml/.test(ui), 'renderConfigPanel not tier-aware');
  assert(ui.includes("_quick ? 'Quick Size' : 'Configure'"), 'sidebar header not tier-aware');
});

t('quick inputs reuse existing binder attributes (zero new plumbing)', () => {
  const panel = cfg.slice(cfg.indexOf('function renderQuickConfigHtml'), cfg.indexOf('export function bindConfigEvents'));
  for (const attr of ['data-vol="totalPallets"', 'data-vol="totalShelvingLocations"', 'data-fac="clearHeight"', 'data-fac="name"']) {
    assert(panel.includes(attr), `${attr} missing from quick panel`);
  }
});

t('mix presets: 3 named operations, each sums to 100', () => {
  assert(WSC_QUICK_MIX_PRESETS.length === 3);
  for (const p of WSC_QUICK_MIX_PRESETS) {
    const sum = p.mix.fullPallet + p.mix.cartonOnPallet + p.mix.cartonOnShelving;
    assert(sum === 100, `${p.key} mix sums to ${sum}`);
  }
});

t('preset click writes storageAllocation through ctx (engine path untouched)', () =>
  assert(/data-wsc-mix-preset[\s\S]{0,400}ctx\.zones\.storageAllocation = \{ \.\.\.preset\.mix \};/.test(cfg),
    'preset binder must replace storageAllocation'));

t('quick panel surfaces the sized answer (SF + positions)', () => {
  const panel = cfg.slice(cfg.indexOf('function renderQuickConfigHtml'), cfg.indexOf('export function bindConfigEvents'));
  assert(panel.includes('calc.sizeFacility(ctx.toSizingInputs())'), 'no live sizing readout');
  assert(panel.includes('grossPositions') && panel.includes('shelvingPositions'), 'positions readout missing');
});

// ── pins ─────────────────────────────────────────────────────────────────
t('cache-bust pins agree across consumers', () => {
  // N1 (2026-07-04): generic form — hardcoded pin literals went stale on
  // every bump (wq1→wq2→n1a churn). The invariant that matters: every
  // consumer of warehouse-sizing/ui.js carries the SAME pin.
  const index = readFileSync('./index.html', 'utf8');
  const cmUi = readFileSync('./tools/cost-model/ui.js', 'utf8');
  const pinOf = (s, name) => {
    const m = s.match(/warehouse-sizing\/ui\.js\?v=([\w.-]+)/);
    assert(m, `${name}: wsc ui pin missing`);
    return m[1];
  };
  const indexPin = pinOf(index, 'index.html');
  assert(pinOf(cmUi, 'CM slideover') === indexPin, 'CM slideover pin diverges from index.html');
  assert(ui.includes("ui-config.js?v=20260704-wq1") && ui.includes("ui-shell-events.js?v=20260704-wq1"), 'inner pins stale');
});

console.log('');
if (failures.length) console.error(failures.join('\n'));
console.log(`test-ux2-wsc-quick: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

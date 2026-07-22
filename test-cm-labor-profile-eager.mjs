// test-cm-labor-profile-eager.mjs — A-rail fix (Brock ruling 2026-07-22 s2:
// Option A, eager market-labor-profile load).
//
// The market labor profile keys computeAll's memo fingerprint but used to
// load ONLY on Summary/Timeline section open, so every computeAll surface
// (header KPI strip, D-shell P&L rail) painted a profile-less transient
// until then (Hearthwood: $7.86M/29.2% → $8.00M/29.3%). Fix: both model
// hydration paths await ensureMarketLaborProfileLoaded() BEFORE their first
// renderCurrentView(). Locks:
//   1. loadModelByCmId: awaited eager load sits between the state-reset
//      block and the first render.
//   2. mount()'s Deal-Management pending-open direct-hydrate path: same
//      awaited eager load before mount's terminal render.
//   3. The Summary/Timeline lazy call SURVIVES (it is the convergence path
//      when the user changes market mid-session).
//   4. ensureMarketLaborProfileLoaded stays null-safe (no market → profile
//      null, return false) — byte-identical guarantee for market-less models.
//   5. compute-all.js keeps currentMarketLaborProfile in the memo
//      fingerprint (the premise the fix rests on).
// Plus a self-probe: the ordering detector must FAIL on a mutated source
// with the eager call stripped (proves the pin bites).

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const ui = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');
const computeAll = readFileSync(new URL('./tools/cost-model/compute-all.js', import.meta.url), 'utf8');

// Detector: within src.slice(from), is there an awaited eager load before the
// first renderCurrentView() call? Returns true when the ordering holds.
function eagerBeforeRender(src, fromMarker) {
  const from = src.indexOf(fromMarker);
  if (from === -1) return false;
  const slice = src.slice(from);
  const eager = slice.indexOf('await ensureMarketLaborProfileLoaded()');
  const render = slice.indexOf('renderCurrentView()');
  return eager !== -1 && render !== -1 && eager < render;
}

// ── 1. loadModelByCmId path ──
t('loadModelByCmId exists', ui.includes('async function loadModelByCmId('));
t('loadModelByCmId awaits eager profile load before first render',
  eagerBeforeRender(ui, 'async function loadModelByCmId('));
// The eager call must come AFTER the per-project profile reset (the reset
// nulls it; loading before the reset would be instantly discarded).
{
  const from = ui.indexOf('async function loadModelByCmId(');
  const slice = ui.slice(from, from + 8000);
  const reset = slice.indexOf('setCurrentMarketLaborProfile(null)');
  const eager = slice.indexOf('await ensureMarketLaborProfileLoaded()');
  t('eager load sits after the profile reset', reset !== -1 && eager !== -1 && reset < eager);
}

// ── 2. mount pending-open path ──
t('mount awaits eager profile load before its terminal render',
  eagerBeforeRender(ui, 'Failed to consume Deal-Management create handoff'));

// ── 3. lazy convergence path survives ──
{
  const idx = ui.indexOf("section === 'summary' || section === 'timeline'");
  t('Summary/Timeline lazy ensure-call survives', idx !== -1 &&
    ui.slice(idx, idx + 400).includes('ensureMarketLaborProfileLoaded()'));
}

// ── 4. null-safety of the ensure fn (byte-identical for market-less models) ──
{
  const from = ui.indexOf('async function ensureMarketLaborProfileLoaded()');
  const body = from === -1 ? '' : ui.slice(from, from + 900);
  t('ensure fn exists', from !== -1);
  t('no market → null profile + false (no fetch)',
    body.includes('if (!marketId)') && body.includes('return false'));
  t('fetch failure swallowed (profile null, no throw)',
    body.includes('catch') && body.includes('currentMarketLaborProfile = null'));
}

// ── 5. premise: profile keys the computeAll memo fingerprint ──
t('compute-all fingerprint includes currentMarketLaborProfile',
  computeAll.includes('ctx.currentMarketLaborProfile'));

// ── probe: detector must bite when the eager call is stripped ──
{
  const mutated = ui.replace(/await ensureMarketLaborProfileLoaded\(\);/g, '/* stripped */');
  t('PROBE: detector fails on eager-call-stripped source',
    !eagerBeforeRender(mutated, 'async function loadModelByCmId('));
}

console.log(`\ntest-cm-labor-profile-eager: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

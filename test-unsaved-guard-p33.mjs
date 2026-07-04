/**
 * P3-3 (2026-07-03) — unsaved-guard rollout + CM optimistic concurrency.
 *
 * Guard coverage before this pass: NetOpt + COG only. Now: + cost-model,
 * warehouse-sizing, fleet-modeler, most-standards. Deal-manager is
 * deliberately NOT wired: its site edits persist per-change with
 * optimistic rollback (P2-1) — there is no transient unsaved state.
 * CM saves now compare-and-swap on updated_at instead of last-write-wins.
 */
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// ── functional: registry round-trip (node-safe — wire() skips w/o document)
const guard = await import('./shared/unsaved-guard.js?v=20260703-p34');
t('guard registry round-trip: dirty → listed → clean', () => {
  guard.markDirty('x'); 
  if (!guard.hasDirty() || !guard.listDirty().includes('x')) return false;
  guard.markClean('x');
  return !guard.hasDirty();
});

// ── coverage: all 6 stateful tools import the guard at ONE ?v= ──────────
const TOOLS = ['cost-model', 'warehouse-sizing', 'fleet-modeler', 'most-standards', 'network-opt', 'center-of-gravity'];
const srcs = Object.fromEntries(TOOLS.map(k => [k, readFileSync(`./tools/${k}/ui.js`, 'utf8')]));
const versions = new Set();
for (const k of TOOLS) {
  t(`${k} imports unsaved-guard`, () => {
    const m = srcs[k].match(/unsaved-guard\.js\?v=([A-Za-z0-9-]+)/);
    if (!m) return false;
    versions.add(m[1]);
    return true;
  });
}
t('all guard imports share one ?v= (single module instance — a second instance would have its own empty registry)', () =>
  versions.size === 1);
t('deal-manager ui retired entirely (2026-07-04 — was deliberately unwired before that)', () =>
  !existsSync('./tools/deal-manager/ui.js'));

// ── CM wiring ────────────────────────────────────────────────────────────
const cm = srcs['cost-model'];
t('CM _markCmDirty marks the hub guard on the clean→dirty transition', () =>
  /if \(!_stateMarkDirty\(\)\) return;[^\n]*\n\s*guardMarkDirty\('cost-model'\);/.test(cm));
t('CM resetDirty wrapper shadows the state.js import and clears the guard', () =>
  cm.includes("resetDirty as _stateResetDirty") &&
  cm.includes("function resetDirty() { _stateResetDirty(); guardMarkClean('cost-model'); }"));
t('CM has no bare markDirty() calls left (were ReferenceErrors — import is renamed)', () =>
  !/^\s+markDirty\(\);/m.test(cm));

// ── WSC wiring ───────────────────────────────────────────────────────────
const wsc = srcs['warehouse-sizing'];
t('WSC _markDirty marks the hub guard', () =>
  /isDirty = true;\s*\n\s*guardMarkDirty\('wsc'\);/.test(wsc));
t('WSC every dirty-clear routes through _clearDirty (guard-aware)', () =>
  wsc.includes("function _clearDirty() { isDirty = false; guardMarkClean('wsc'); }")
  && !/^\s+isDirty = false;/m.test(wsc));
t('WSC shell-ctx isDirty setter routes through the guard-aware helpers', () =>
  wsc.includes('set isDirty(v) { if (v) _markDirty(); else _clearDirty(); },'));

// ── Fleet wiring ─────────────────────────────────────────────────────────
const fleet = srcs['fleet-modeler'];
t('Fleet syncs the guard from its derived modified state (chrome-opts choke point)', () =>
  fleet.includes("if (modified) guardMarkDirty('fleet'); else guardMarkClean('fleet');"));
t('Fleet clears the guard on landing + unmount', () =>
  (fleet.match(/guardMarkClean\('fleet'\)/g) || []).length >= 3);

// ── MOST wiring ──────────────────────────────────────────────────────────
const most = srcs['most-standards'];
t('MOST editor edits mark the guard (field edit, reorder, add, delete)', () =>
  (most.match(/guardMarkDirty\('most'\)/g) || []).length >= 4);
t('MOST clears the guard on save, discard, fresh session, unmount', () =>
  (most.match(/guardMarkClean\('most'\)/g) || []).length >= 4);

// ── CM optimistic concurrency ────────────────────────────────────────────
const cmApi = readFileSync('./tools/cost-model/api.js', 'utf8');
t('api.updateModelGuarded compare-and-swaps on updated_at', () =>
  /updateModelGuarded/.test(cmApi)
  && cmApi.includes(".eq('id', id).eq('updated_at', expectedUpdatedAt).select()"));
t('guarded update falls back to unguarded when no baseline (legacy models)', () =>
  /if \(!expectedUpdatedAt\) \{\s*\n\s*return \{ row: await db\.update/.test(cmApi));
t('conflict reports the current updated_at for the user prompt', () =>
  cmApi.includes('return { row: null, conflict: true, currentUpdatedAt };'));
t('updateModel + guarded share ONE payload builder (no drift between paths)', () =>
  (cmApi.match(/_modelUpdatePayload\(data\)/g) || []).length === 3 // def + 2 call sites
  && cmApi.includes('function _modelUpdatePayload(data)'));
t('CM handleSave routes through the guarded update with the loaded baseline', () =>
  cm.includes('await api.updateModelGuarded(model.id, model, expected)')
  && cm.includes('const expected = getLastSavedAt();'));
t('conflict path asks before clobbering; decline aborts the save', () =>
  /if \(res\.conflict\) \{[\s\S]{0,700}await showConfirm\([\s\S]{0,400}if \(!ok\) \{[\s\S]{0,200}return;/.test(cm));
t('save stores the SERVER updated_at as the next CAS baseline', () =>
  cm.includes('setSavedMeta(savedRow?.updated_at || new Date().toISOString(), _savedBy);'));

// ── live-walk fix: router sequences the prompt BEFORE unmount ────────────
const guardSrc = readFileSync('./shared/unsaved-guard.js', 'utf8');
const routerSrc = readFileSync('./shared/router.js', 'utf8');
t('guard no longer owns a hashchange listener (it raced the router — Cancel lost editor state)', () =>
  !guardSrc.includes("addEventListener('hashchange'")
  && guardSrc.includes('export async function confirmLeaveIfDirty()'));
t('guard keeps the beforeunload tab-close prompt', () =>
  guardSrc.includes("addEventListener('beforeunload'"));
t('router consults confirmLeaveIfDirty before any unmount/sweep/swap', () => {
  const i = routerSrc.indexOf('await confirmLeaveIfDirty()');
  const j = routerSrc.indexOf('this._active.module.unmount()');
  return i > 0 && j > 0 && i < j;
});
t('router revert path cannot re-prompt (guardReverting early-return)', () =>
  /if \(this\._guardReverting\) \{\s*\n\s*this\._guardReverting = false;\s*\n\s*return;/.test(routerSrc));

console.log(`test-unsaved-guard-p33: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);

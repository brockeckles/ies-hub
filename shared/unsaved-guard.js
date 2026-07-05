/**
 * IES Hub v3 — Unsaved Changes Guard
 *
 * A simple registry that modules can use to declare they have unsaved edits.
 * On attempt to navigate away (hash change, close tab, back-button), the
 * guard prompts the user to confirm losing changes.
 *
 * Usage:
 *   import { markDirty, markClean } from './shared/unsaved-guard.js?v=20260703-p34';
 *
 *   // When user edits something:
 *   markDirty('cost-model');
 *
 *   // When user saves successfully OR abandons intentionally:
 *   markClean('cost-model');
 *
 * Modules should call markClean() in their unmount() hook after a successful
 * save OR when the user explicitly discards. Otherwise the guard will fire
 * once per navigation attempt.
 *
 * @module shared/unsaved-guard
 */

import { bus } from './event-bus.js?v=20260418-sK';
import { showConfirm } from './confirm-modal.js?v=20260705-u1a';

/** @type {Set<string>} */
const dirty = new Set();

/** @type {boolean} */
let _wired = false;

/** Mark a module as having unsaved changes. */
export function markDirty(moduleId) {
  if (!moduleId) return;
  dirty.add(String(moduleId));
}

/** Mark a module as clean (saved or intentionally discarded). */
export function markClean(moduleId) {
  if (!moduleId) return;
  dirty.delete(String(moduleId));
}

/** Returns true if any module has unsaved changes. */
export function hasDirty() {
  return dirty.size > 0;
}

/** Lists the module IDs with unsaved changes. */
export function listDirty() {
  return Array.from(dirty);
}

/** Force-clear the registry (use only on explicit reset, e.g., logout). */
export function clearAll() {
  dirty.clear();
}

// ---------------------------------------------------------------------------
// Browser-level guards
// ---------------------------------------------------------------------------

function wire() {
  if (_wired || typeof window === 'undefined') return;
  _wired = true;

  // Tab close / full reload — browser shows a generic prompt.
  window.addEventListener('beforeunload', (e) => {
    if (!dirty.size) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // P3-3 live-walk fix (2026-07-03): the guard's OWN hashchange listener is
  // gone. It raced the router — the router unmounted + remounted the next
  // view while showConfirm was still pending, so "Cancel" reverted the hash
  // but landed the user on the tool's LANDING page (module remount), and
  // re-opening the model reloaded from DB — the edit the prompt promised to
  // protect was already gone. The router now consults confirmLeaveIfDirty()
  // synchronously-in-sequence BEFORE unmounting (shared/router.js), so
  // Cancel truly means "nothing moves".
}

/**
 * Ask the user to confirm leaving when anything is dirty.
 * Called by the router BEFORE it unmounts the active view.
 * @returns {Promise<boolean>} true = proceed (registry cleared), false = stay
 */
export async function confirmLeaveIfDirty() {
  if (!dirty.size) return true;
  const ok = await showConfirm(
    `You have unsaved changes in ${describeDirty()}. Leave anyway?`
  );
  if (ok) clearAll();
  return ok;
}

function describeDirty() {
  const list = Array.from(dirty);
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.length} modules`;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
}

export default { markDirty, markClean, hasDirty, listDirty, clearAll };

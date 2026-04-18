/**
 * IES Hub v3 — Unsaved Changes Guard
 *
 * A simple registry that modules can use to declare they have unsaved edits.
 * On attempt to navigate away (hash change, close tab, back-button), the
 * guard prompts the user to confirm losing changes.
 *
 * Usage:
 *   import { markDirty, markClean } from './shared/unsaved-guard.js?v=20260418-s6';
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

import { bus } from './event-bus.js?v=20260418-s6';

/** @type {Set<string>} */
const dirty = new Set();

/** @type {boolean} */
let _wired = false;

/** Mark a module as having unsaved changes. */
export function markDirty(moduleId) {
  if (!moduleId) return;
  dirty.add(String(moduleId));
  bus.emit('dirty:changed', { moduleId, dirty: true, count: dirty.size });
}

/** Mark a module as clean (saved or intentionally discarded). */
export function markClean(moduleId) {
  if (!moduleId) return;
  dirty.delete(String(moduleId));
  bus.emit('dirty:changed', { moduleId, dirty: false, count: dirty.size });
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
  bus.emit('dirty:changed', { moduleId: null, dirty: false, count: 0 });
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

  // Internal hash-change navigation — intercept and confirm.
  window.addEventListener('hashchange', (e) => {
    if (!dirty.size) return;
    // Avoid reentry: if we're in the middle of reverting, bail.
    if (window.__hubGuardReverting) {
      window.__hubGuardReverting = false;
      return;
    }
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `You have unsaved changes in ${describeDirty()}. Leave anyway?`
    );
    if (!ok) {
      // Revert the hash silently.
      window.__hubGuardReverting = true;
      window.history.back();
    } else {
      // User accepted — clear the registry so we don't re-prompt.
      clearAll();
    }
  });
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

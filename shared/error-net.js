/**
 * shared/error-net.js — global error net (P3-2, 2026-07-03).
 *
 * The hub had ZERO window-level error handling: every uncaught exception or
 * rejected promise died silently (the exact failure mode behind the COG
 * marker saga and the MOST editor save-throw). This module is the net:
 *
 *   • window 'error'              → toast + console + analytics breadcrumb
 *   • window 'unhandledrejection' → same
 *
 * Design constraints:
 *   - NEVER throw from inside the net (every sink is try/catch'd).
 *   - Rate-limited + deduped: a render-loop error storm shows ONE toast per
 *     unique message per minute, not five hundred.
 *   - Analytics is best-effort fire-and-forget; offline/RLS failures are
 *     swallowed (the net must work logged-out on the login screen too).
 *
 * Import for side effects from index.html:  import './shared/error-net.js?v=…'
 */

import { showToast } from './toast.js?v=20260419-uC';

/** message → last-shown epoch ms (dedup window) */
const _recent = new Map();
const DEDUP_MS = 60_000;
const MAX_TOASTS_PER_MIN = 5;
let _windowStart = 0;
let _windowCount = 0;

function _shouldSurface(key) {
  const now = Date.now();
  if (now - _windowStart > 60_000) { _windowStart = now; _windowCount = 0; }
  if (_windowCount >= MAX_TOASTS_PER_MIN) return false;
  const last = _recent.get(key) || 0;
  if (now - last < DEDUP_MS) return false;
  _recent.set(key, now);
  if (_recent.size > 200) _recent.clear(); // unbounded-growth guard
  _windowCount++;
  return true;
}

function _describe(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

async function _breadcrumb(kind, msg, extra) {
  try {
    const { analytics } = await import('./analytics.js?v=20260504-auth1');
    analytics.track('client_error', { kind, message: String(msg).slice(0, 500), ...extra });
  } catch { /* analytics is best-effort */ }
}

function _handle(kind, err, extra = {}) {
  try {
    const msg = _describe(err);
    // Console always — this is the debugging trail.
    console.error(`[error-net:${kind}]`, err);
    _breadcrumb(kind, msg, extra);
    if (_shouldSurface(`${kind}|${msg}`)) {
      showToast(`Something went wrong: ${msg.slice(0, 160)}`, 'error');
    }
  } catch { /* the net never throws */ }
}

window.addEventListener('error', (e) => {
  // Resource-load errors (img/script) have no .error and are usually noise
  // from ad-blockers or CDN hiccups — log, don't toast.
  if (!e.error && e.target !== window) {
    try { console.warn('[error-net:resource]', e.target?.src || e.target?.href || e.target); } catch {}
    return;
  }
  _handle('error', e.error || e.message, { source: e.filename, line: e.lineno });
});

window.addEventListener('unhandledrejection', (e) => {
  _handle('unhandledrejection', e.reason);
});

export const __errorNetInstalled = true;

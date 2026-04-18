/**
 * IES Hub v3 — Analytics
 *
 * Lightweight page-view + event instrumentation writing to Supabase
 * `analytics_events`. Designed to be fire-and-forget — failures are logged
 * but never block the UI.
 *
 * Usage:
 *   import { analytics } from './shared/analytics.js?v=20260418-s8';
 *   analytics.track('feature_used', { feature: 'cm_export_excel' });
 *   analytics.pageView('designtools/cost-model');
 *
 * What's captured automatically (wired on import):
 *   - page_view     — fires on every hashchange + on load
 *   - session_start — once per session (sessionStorage-backed)
 *   - session_end   — on beforeunload (best-effort via sendBeacon)
 *
 * Modules should manually call analytics.track(...) for feature usage
 * (scenario saved, template created, deck generated, etc.).
 *
 * @module shared/analytics
 */

import { db } from './supabase.js?v=20260418-s8';

const SESSION_KEY = 'ies_hub_analytics_session';
const SESSION_TTL_MS = 30 * 60 * 1000;

let _wired = false;
let _sessionId = null;
let _sessionStart = null;
let _lastActivity = Date.now();

function newSessionId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function currentSession() {
  if (typeof sessionStorage === 'undefined') return { id: newSessionId(), start: Date.now() };
  let raw = null;
  try { raw = sessionStorage.getItem(SESSION_KEY); } catch {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.id && parsed.start && Date.now() - parsed.lastActivity < SESSION_TTL_MS) {
        parsed.lastActivity = Date.now();
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(parsed));
        return parsed;
      }
    } catch {}
  }
  const fresh = { id: newSessionId(), start: Date.now(), lastActivity: Date.now() };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(fresh)); } catch {}
  return fresh;
}

function touchSession() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    parsed.lastActivity = Date.now();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(parsed));
    _lastActivity = Date.now();
  } catch {}
}

/**
 * Track an event. Writes a row to analytics_events. Non-blocking.
 * @param {string} event
 * @param {Record<string, any>} [payload]
 */
function track(event, payload = {}) {
  if (!event) return Promise.resolve();
  touchSession();
  const row = {
    event,
    payload: payload || {},
    session_id: _sessionId,
    session_started_at: _sessionStart ? new Date(_sessionStart).toISOString() : null,
    route: typeof window !== 'undefined' ? (window.location.hash.slice(1) || 'overview') : null,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 240) : null,
  };
  return writeRow(row).catch((err) => {
    // Analytics failures must never break the UI.
    console.debug('[analytics] write failed (non-fatal)', err);
  });
}

/** Fire a page_view event. */
function pageView(route) {
  return track('page_view', { route });
}

async function writeRow(row) {
  try {
    await db.from('analytics_events').insert(row);
  } catch (err) {
    // Swallow — analytics must not block.
    console.debug('[analytics] insert error', err);
  }
}

/** Manually mark session end (also wired to beforeunload). Best-effort. */
function endSession() {
  if (!_sessionId) return;
  const dur = Date.now() - _sessionStart;
  const payload = {
    event: 'session_end',
    payload: { duration_ms: dur },
    session_id: _sessionId,
    route: typeof window !== 'undefined' ? (window.location.hash.slice(1) || 'overview') : null,
  };
  // Best-effort — may be cancelled by the browser on unload.
  writeRow(payload);
}

/** Returns basic usage counters for the current session (in-memory). */
const _counters = new Map();
function counter(name) {
  const v = (_counters.get(name) || 0) + 1;
  _counters.set(name, v);
  return v;
}
function counters() {
  return Object.fromEntries(_counters);
}

function wire() {
  if (_wired || typeof window === 'undefined') return;
  _wired = true;

  const s = currentSession();
  _sessionId = s.id;
  _sessionStart = s.start;

  // Emit session_start only on fresh sessions.
  if (Date.now() - s.start < 2000) {
    track('session_start', {});
  }

  // Page-view auto-capture.
  pageView(window.location.hash.slice(1) || 'overview');
  window.addEventListener('hashchange', () => {
    pageView(window.location.hash.slice(1) || 'overview');
  });

  // Activity heartbeat — any interaction refreshes the session.
  ['click', 'keydown', 'scroll', 'mousemove'].forEach(evt => {
    window.addEventListener(evt, () => { _lastActivity = Date.now(); touchSession(); }, { passive: true });
  });

  window.addEventListener('beforeunload', endSession);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
}

export const analytics = {
  track,
  pageView,
  endSession,
  counter,
  counters,
  get sessionId() { return _sessionId; },
  get sessionStart() { return _sessionStart; },
};

export default analytics;

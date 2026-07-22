/**
 * IES Hub v3 — Deal Context service (UX-1 / D2, 2026-07-03)
 *
 * One persistent "active deal" binding shared by every tool. This is the
 * spine primitive from the 2026-07-03 unified plan: the deal workspace
 * calls setActive(deal) once, and every tool mount can read it — no more
 * per-hop sessionStorage relays with 60-second TTLs that orphan models
 * when the user dawdles on a landing page.
 *
 * Design contract (doc §6 D2):
 *   - Persisted in localStorage (survives reload + tab close) AND readable
 *     from a `?deal=<id>` hash param (deep links; router strips query from
 *     route matching, see shared/router.js).
 *   - No TTL. Context lives until the user clears it or sets another deal.
 *   - Emits 'deal-context:changed' on the shared bus so mounted tools can
 *     live-update their chrome.
 *   - Node-safe: falls back to an in-memory store when localStorage is
 *     unavailable, so the pure suite can exercise it.
 *
 * Legacy relays (cm_pending_open / cm_pending_new_for_deal / *_pending_push)
 * still work — this module is additive. Senders should migrate to
 * setActive() + targeted payloads over subsequent UX-1 commits.
 *
 * @module shared/deal-context
 */

import { bus } from './event-bus.js?v=20260418-sK';

const STORAGE_KEY = 'ies_active_deal';
export const CHANGE_EVENT = 'deal-context:changed';

/** In-memory fallback so the module works under node (pure suite). */
const _mem = new Map();

function _store() {
  try {
    // Feature-probe, not mere presence: newer Node exposes a `localStorage`
    // object whose methods are all undefined (experimental Web Storage stub
    // with no backing file), which would silently drop every write. Private
    // browsing / sandboxed embeds can do the same. Require real methods.
    if (typeof localStorage !== 'undefined' && localStorage
        && typeof localStorage.getItem === 'function'
        && typeof localStorage.setItem === 'function'
        && typeof localStorage.removeItem === 'function') return localStorage;
  } catch { /* SecurityError in some embeds — fall through */ }
  return {
    getItem: (k) => (_mem.has(k) ? _mem.get(k) : null),
    setItem: (k, v) => { _mem.set(k, String(v)); },
    removeItem: (k) => { _mem.delete(k); },
  };
}

/**
 * Read a `deal=` param from the current hash, if any.
 * Supports "#route/sub?deal=<id>" and "#route?x=1&deal=<id>".
 * @returns {string|null}
 */
export function readDealFromUrl() {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    const hash = String(window.location.hash || '');
    const qIdx = hash.indexOf('?');
    if (qIdx < 0) return null;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const id = params.get('deal');
    return id ? String(id) : null;
  } catch { return null; }
}

/**
 * Set the active deal. Minimal shape: { id }. name/customer are optional
 * display sugar so tool chrome can label the binding without a fetch.
 * @param {{id: string|number, name?: string, customer?: string}} deal
 * @returns {object|null} the stored context, or null if invalid
 */
export function setActive(deal) {
  const id = deal && deal.id != null ? String(deal.id) : '';
  if (!id) return null;
  const ctx = {
    id,
    name: deal.name != null ? String(deal.name) : null,
    customer: deal.customer != null ? String(deal.customer) : null,
    // S1 (2026-07-22): optional site slot. Tools launched from a Site page
    // stamp new scenarios with site_id; deal-level launches leave it null.
    siteId: deal.siteId != null && String(deal.siteId) ? String(deal.siteId) : null,
    siteName: deal.siteName != null ? String(deal.siteName) : null,
    setAt: Date.now(),
  };
  try { _store().setItem(STORAGE_KEY, JSON.stringify(ctx)); } catch {}
  try { bus.emit(CHANGE_EVENT, ctx); } catch {}
  return ctx;
}

/**
 * Get the active deal context, or null.
 * A `?deal=` URL param wins over the stored value (deep-link semantics):
 * if it matches the stored id the stored sugar (name/customer) is kept,
 * otherwise a bare { id } context is returned.
 * @returns {{id: string, name: string|null, customer: string|null, setAt: number}|null}
 */
export function getActive() {
  let stored = null;
  try {
    const raw = _store().getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.id != null && String(parsed.id)) {
        stored = {
          id: String(parsed.id),
          name: parsed.name != null ? String(parsed.name) : null,
          customer: parsed.customer != null ? String(parsed.customer) : null,
          siteId: parsed.siteId != null && String(parsed.siteId) ? String(parsed.siteId) : null,
          siteName: parsed.siteName != null ? String(parsed.siteName) : null,
          setAt: Number(parsed.setAt) || 0,
        };
      }
    }
  } catch { /* garbage in storage → treat as unset */ }

  const urlId = readDealFromUrl();
  if (urlId) {
    if (stored && stored.id === urlId) return stored;
    return { id: urlId, name: null, customer: null, siteId: null, siteName: null, setAt: 0 };
  }
  return stored;
}

/** Clear the active deal. Emits CHANGE_EVENT with null. */
export function clearActive() {
  try { _store().removeItem(STORAGE_KEY); } catch {}
  try { bus.emit(CHANGE_EVENT, null); } catch {}
}

/**
 * @param {string|number} dealId
 * @returns {boolean} true if dealId is the active deal
 */
export function isActive(dealId) {
  const ctx = getActive();
  return !!ctx && dealId != null && String(dealId) === ctx.id;
}

/**
 * Subscribe to context changes. Returns the unsubscribe function.
 * @param {(ctx: object|null) => void} handler
 */
export function onChange(handler) {
  return bus.on(CHANGE_EVENT, handler);
}

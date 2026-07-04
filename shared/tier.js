/**
 * IES Hub v3 — Tool tier service (UX-2 / D3, 2026-07-04)
 *
 * One hub-wide mechanism for the Quick / Engineering two-tier pattern
 * (assessment doc §6 D3): a per-tool toggle that changes WHICH CONTROLS
 * RENDER, never what the engines compute. Tools read the tier at render
 * time and choose a curated Standard surface ('quick') or the full
 * surface ('engineering').
 *
 * Design contract:
 *   - Default is 'quick' (Brock decision #2, 2026-07-03) with a persistent
 *     per-user preference — stored per tool in one localStorage map so a
 *     user who flips CM to engineering stays there across sessions while
 *     WSC/COG/MOST keep their own choice.
 *   - Emits 'tier:changed' on the shared bus with { tool, tier } so a
 *     mounted tool can re-render its shell.
 *   - Node-safe: in-memory fallback when localStorage is unavailable, so
 *     the pure suite can exercise it (same pattern as deal-context.js).
 *   - Rendering layer ONLY. Nothing here (or downstream of it) may alter
 *     model state or engine params — a model produces identical numbers
 *     in either tier.
 *
 * @module shared/tier
 */

import { bus } from './event-bus.js?v=20260418-sK';

const STORAGE_KEY = 'ies_tool_tier';
export const CHANGE_EVENT = 'tier:changed';
export const TIERS = ['quick', 'engineering'];
const DEFAULT_TIER = 'quick';

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

function _readMap() {
  try {
    const raw = _store().getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

function _writeMap(map) {
  try { _store().setItem(STORAGE_KEY, JSON.stringify(map)); } catch {}
}

/**
 * Current tier for a tool. Always returns a valid tier string.
 * @param {string} tool — tool key, e.g. 'cm', 'wsc', 'most', 'cog'
 * @returns {'quick'|'engineering'}
 */
export function getTier(tool) {
  const t = _readMap()[String(tool || '')];
  return TIERS.includes(t) ? t : DEFAULT_TIER;
}

/**
 * Set the tier for a tool. Invalid tiers are ignored (returns current).
 * @param {string} tool
 * @param {'quick'|'engineering'} tier
 * @returns {'quick'|'engineering'} the tier now in effect
 */
export function setTier(tool, tier) {
  const key = String(tool || '');
  if (!key || !TIERS.includes(tier)) return getTier(tool);
  const map = _readMap();
  if (map[key] === tier) return tier; // idempotent — no event on no-op
  map[key] = tier;
  _writeMap(map);
  try { bus.emit(CHANGE_EVENT, { tool: key, tier }); } catch {}
  return tier;
}

/** Convenience: flip quick ↔ engineering. @returns the new tier */
export function toggleTier(tool) {
  return setTier(tool, getTier(tool) === 'quick' ? 'engineering' : 'quick');
}

/**
 * Subscribe to tier changes. Returns an unsubscribe fn.
 * @param {(payload: {tool: string, tier: string}) => void} fn
 */
export function onChange(fn) {
  return bus.on(CHANGE_EVENT, fn); // bus.on returns the unsubscribe fn
}

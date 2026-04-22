/**
 * IES Hub v3 — Cost Model Shift Archetype catalog fetcher
 *
 * SWR-style cache for public.ref_shift_archetype_defaults rows. Fetched once
 * per session; subsequent calls resolve from cache. Mirrors the planning-
 * ratios ensure-loaded pattern.
 *
 * Not pure — depends on the Supabase client via api.js. Kept tiny so the
 * pure shift-planner.js module can remain Supabase-free.
 *
 * @module tools/cost-model/shift-archetypes
 */

let _cache = [];
let _loaded = false;
let _inflight = null;

/**
 * Ensure the catalog is loaded. Returns the cached array. Idempotent — safe
 * to call from multiple code paths without racing.
 *
 * @param {{ fetchShiftArchetypes: () => Promise<any[]> }} api
 * @returns {Promise<Array>}
 */
export async function ensureArchetypesLoaded(api) {
  if (_loaded) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const rows = await api.fetchShiftArchetypes();
      _cache = Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('[CM] ensureArchetypesLoaded failed:', e);
      _cache = [];
    } finally {
      _loaded = true;
      _inflight = null;
    }
    return _cache;
  })();
  return _inflight;
}

/** Return a shallow copy of the cached catalog (safe to mutate). */
export function getArchetypes() {
  return _cache.slice();
}

/** Find one archetype by its archetype_ref. Returns null if not loaded or not found. */
export function getArchetype(ref) {
  if (!ref) return null;
  return _cache.find(a => a.archetype_ref === ref) || null;
}

/** True once the catalog load has resolved at least once. */
export function isArchetypesLoaded() {
  return _loaded;
}

/** Testing helper — reset cache between tests. Not wired to UI. */
export function _resetArchetypeCache() {
  _cache = [];
  _loaded = false;
  _inflight = null;
}

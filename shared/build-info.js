/**
 * IES Hub v3 — Build info client (Phase 4 Slice 4.4)
 *
 * Fetches ./build-info.json once at page load and caches the result.
 * The file is emitted by scripts/emit-build-info.sh before every deploy.
 * Consumed by:
 *   - hub/admin/ui.js — env chip version suffix
 *   - index.html footer chip
 *
 * If the file is missing (e.g. dev server, or forgotten before push), we
 * fall back to a stub with tag "dev" so the UI still renders cleanly.
 *
 * @module shared/build-info
 */

/** @typedef {{
 *    tag: string,
 *    sha: string,
 *    shaFull: string,
 *    date: string,
 *    timestamp: string,
 *    builtBy: string
 *  }} BuildInfo
 */

/** @type {BuildInfo|null} */
let _cached = null;

/** @type {Promise<BuildInfo>|null} */
let _fetchPromise = null;

const DEV_STUB = Object.freeze({
  tag: 'dev',
  sha: 'unknown',
  shaFull: '',
  date: '',
  timestamp: '',
  builtBy: ''
});

/**
 * Fetches build-info.json (cached). Returns a stub with tag="dev" if the
 * file is missing — the UI still renders, just without a real version.
 *
 * @returns {Promise<BuildInfo>}
 */
export async function getBuildInfo() {
  if (_cached) return _cached;
  if (_fetchPromise) return _fetchPromise;

  _fetchPromise = (async () => {
    try {
      const t = Date.now();
      const res = await fetch(`./build-info.json?t=${t}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      _cached = Object.freeze({
        tag: json.tag || DEV_STUB.tag,
        sha: json.sha || DEV_STUB.sha,
        shaFull: json.shaFull || DEV_STUB.shaFull,
        date: json.date || DEV_STUB.date,
        timestamp: json.timestamp || DEV_STUB.timestamp,
        builtBy: json.builtBy || DEV_STUB.builtBy
      });
    } catch (err) {
      console.warn('[build-info] fetch failed, using dev stub:', err && err.message);
      _cached = DEV_STUB;
    }
    return _cached;
  })();

  return _fetchPromise;
}

/**
 * Synchronous accessor — returns null until getBuildInfo() has resolved.
 * Cheap for "render now, re-render after first fetch" code paths.
 *
 * @returns {BuildInfo|null}
 */
export function getBuildInfoSync() {
  return _cached;
}

/** Test-only reset — clears the cache so the next getBuildInfo() refetches. */
export function _resetForTesting() {
  _cached = null;
  _fetchPromise = null;
}

/**
 * IES Hub v3 — Shared Run-State Tracker
 *
 * Tools with an explicit "Run / Analyze / Optimize" button hash the inputs
 * that would affect results, stash the hash after a successful run, and
 * compare against the live hash on every render to decide whether the
 * Run button shows its orange "dirty" state or its muted green "clean"
 * ("Results current") state.
 *
 * Usage:
 *   import { hashRunInputs, RunStateTracker } from '../../shared/run-state.js?v=20260419-uE';
 *
 *   const runState = new RunStateTracker();
 *
 *   // When the user triggers Run and it succeeds:
 *   runState.markClean({ points, config });
 *
 *   // Every render, ask whether inputs diverge from the last-run hash:
 *   const state = runState.state({ points, config }); // 'dirty' | 'clean'
 *   renderToolHeader({ ..., primaryAction: { ..., state } });
 *
 *   // On unmount / model switch / scenario change:
 *   runState.reset();
 *
 * Why not just diff objects?
 *   - Cheap, stable string key we can store alongside other state.
 *   - Decouples "what inputs are tracked" from "how we compare them" — the
 *     tool picks what to pass; the helper just hashes.
 *
 * @module shared/run-state
 */

/**
 * Stable stringifier — sorts object keys so {a:1,b:2} and {b:2,a:1} hash
 * the same. Arrays stay order-sensitive (which is what we want — a
 * reordered points list is a real change for the solver). Numbers that
 * are close-to-integer are rounded to 10 decimal places to avoid
 * float-drift false positives from range-input conversions.
 * @param {any} v
 * @returns {string}
 */
export function stableStringify(v) {
  return JSON.stringify(v, (_key, val) => {
    if (val === null || val === undefined) return val;
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) return null;
      // Normalise floats — 10 decimals is enough for any rate / ratio in the
      // hub without smudging genuinely-different values together.
      return Math.round(val * 1e10) / 1e10;
    }
    if (typeof val !== 'object' || Array.isArray(val)) return val;
    // Object — reconstruct with sorted keys so property order doesn't matter.
    const sorted = {};
    for (const k of Object.keys(val).sort()) sorted[k] = val[k];
    return sorted;
  });
}

/**
 * Produce a stable hash string from a set of run inputs.
 * The hash is just the stable stringify — cheap, ~no collisions for the
 * size of our inputs. If inputs balloon (10K+ points), swap this for a
 * real 32/64-bit hash without changing callers.
 * @param {any} inputs
 * @returns {string}
 */
export function hashRunInputs(inputs) {
  return stableStringify(inputs || {});
}

export class RunStateTracker {
  constructor() {
    /** @type {string|null} */
    this._lastHash = null;
  }

  /**
   * Record a successful run's input fingerprint.
   * After this, `state(sameInputs) === 'clean'`.
   * @param {any} inputs
   */
  markClean(inputs) {
    this._lastHash = hashRunInputs(inputs);
  }

  /**
   * Force the tracker to report dirty on the next query, regardless of
   * inputs. Useful after external events the tool knows invalidate the
   * last run (e.g., reference data refresh, ref_rate SQL update).
   */
  markDirty() {
    this._lastHash = null;
  }

  /** Drop all state. Tools call this on unmount / scenario switch. */
  reset() {
    this._lastHash = null;
  }

  /**
   * Has a clean baseline ever been recorded?
   * @returns {boolean}
   */
  hasBaseline() {
    return this._lastHash !== null;
  }

  /**
   * Compare live inputs against the last-run hash.
   * @param {any} inputs
   * @returns {'dirty'|'clean'}
   */
  state(inputs) {
    if (this._lastHash === null) return 'dirty';
    return (hashRunInputs(inputs) === this._lastHash) ? 'clean' : 'dirty';
  }
}

export default { hashRunInputs, stableStringify, RunStateTracker };

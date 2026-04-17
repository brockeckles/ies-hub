/**
 * IES Hub v3 — State Manager
 * Centralized reactive state with subscriptions.
 * Each tool gets its own state slice; shared data (user, nav) lives at root.
 *
 * Usage:
 *   import { state } from './state.js?v=20260417-mD';
 *
 *   // Set nested path
 *   state.set('costModel.activeSection', 'labor');
 *
 *   // Get value
 *   state.get('costModel.activeSection'); // → 'labor'
 *
 *   // Subscribe to changes on a path
 *   const off = state.subscribe('costModel.activeSection', (val, prev) => { ... });
 *   off(); // unsubscribe
 *
 * @module shared/state
 */

/** @typedef {(newVal: any, oldVal: any) => void} StateSubscriber */

class StateManager {
  constructor() {
    /** @type {Object} */
    this._store = {
      user: null,         // { email, role, authenticated }
      nav: {
        section: 'welcome',  // current sidebar section
        tool: null,           // active design tool (if in designtools)
      },
    };
    /** @type {Map<string, Set<StateSubscriber>>} */
    this._subscribers = new Map();
  }

  /**
   * Get a value by dot-path.
   * @param {string} path — e.g. 'nav.section' or 'costModel.data.labor'
   * @returns {*}
   */
  get(path) {
    return this._resolve(path);
  }

  /**
   * Set a value by dot-path. Notifies subscribers on that path.
   * @param {string} path
   * @param {*} value
   */
  set(path, value) {
    const oldVal = this._resolve(path);
    if (oldVal === value) return; // no-op if unchanged

    this._assign(path, value);

    // Notify exact-path subscribers
    const subs = this._subscribers.get(path);
    if (subs) {
      for (const fn of subs) {
        try { fn(value, oldVal); }
        catch (err) { console.error(`[State] Error in subscriber for "${path}":`, err); }
      }
    }

    // Notify parent-path subscribers (e.g. 'costModel' when 'costModel.activeSection' changes)
    const parts = path.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const parentPath = parts.slice(0, i).join('.');
      const parentSubs = this._subscribers.get(parentPath);
      if (parentSubs) {
        const parentVal = this._resolve(parentPath);
        for (const fn of parentSubs) {
          try { fn(parentVal, undefined); }
          catch (err) { console.error(`[State] Error in parent subscriber for "${parentPath}":`, err); }
        }
      }
    }
  }

  /**
   * Merge an object into an existing state slice.
   * @param {string} path
   * @param {Object} partial
   */
  merge(path, partial) {
    const current = this._resolve(path) || {};
    this.set(path, { ...current, ...partial });
  }

  /**
   * Subscribe to changes at a path.
   * @param {string} path
   * @param {StateSubscriber} handler
   * @returns {() => void} unsubscribe function
   */
  subscribe(path, handler) {
    if (!this._subscribers.has(path)) {
      this._subscribers.set(path, new Set());
    }
    this._subscribers.get(path).add(handler);
    return () => this._subscribers.get(path)?.delete(handler);
  }

  /**
   * Get a snapshot of the full store (for debugging).
   * @returns {Object}
   */
  snapshot() {
    return structuredClone(this._store);
  }

  /**
   * Reset the store to initial state (useful for testing).
   */
  reset() {
    this._store = { user: null, nav: { section: 'welcome', tool: null } };
    this._subscribers.clear();
  }

  // ---- Internal helpers ----

  /** @param {string} path */
  _resolve(path) {
    const parts = path.split('.');
    let current = this._store;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  /** @param {string} path @param {*} value */
  _assign(path, value) {
    const parts = path.split('.');
    let current = this._store;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }
}

/** Singleton state instance */
export const state = new StateManager();

export { StateManager };

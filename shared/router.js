/**
 * IES Hub v3 — Hash Router
 * Simple hash-based navigation with lazy-loading of tool modules.
 *
 * URL format: #section or #section/tool
 *   #welcome, #overview, #deals, #designtools/cost-model, #designtools/fleet-modeler
 *
 * Usage:
 *   import { router } from './router.js?v=20260417-m4';
 *
 *   router.register('designtools/cost-model', {
 *     load: () => import('../tools/cost-model/ui.js?v=20260417-m4'),
 *     title: 'Cost Model Builder',
 *   });
 *
 *   router.start(); // begins listening to hashchange
 *
 * @module shared/router
 */

import { state } from './state.js?v=20260417-m4';
import { bus } from './event-bus.js?v=20260417-m4';

/**
 * @typedef {Object} RouteConfig
 * @property {() => Promise<{ mount: (el: HTMLElement) => void, unmount?: () => void }>} load — dynamic import fn
 * @property {string} title — display name for breadcrumbs / search
 * @property {string} [parent] — parent route key for breadcrumbs
 */

class Router {
  constructor() {
    /** @type {Map<string, RouteConfig>} */
    this._routes = new Map();
    /** @type {{ key: string, module: any } | null} */
    this._active = null;
    /** @type {HTMLElement | null} */
    this._outlet = null;
    this._onHashChange = this._onHashChange.bind(this);
  }

  /**
   * Register a route.
   * @param {string} key — e.g. 'designtools/cost-model'
   * @param {RouteConfig} config
   */
  register(key, config) {
    this._routes.set(key, config);
  }

  /**
   * Start listening to hash changes.
   * @param {HTMLElement} outlet — the DOM element to mount views into
   */
  start(outlet) {
    this._outlet = outlet;
    window.addEventListener('hashchange', this._onHashChange);
    // Navigate to current hash or default
    this._onHashChange();
  }

  /**
   * Programmatic navigation.
   * @param {string} route — e.g. 'designtools/cost-model'
   */
  navigate(route) {
    window.location.hash = route;
  }

  /**
   * Get current route key from hash.
   * @returns {string}
   */
  current() {
    const hash = window.location.hash.slice(1) || 'overview';
    return hash;
  }

  /**
   * Get all registered route keys and titles (for search index).
   * @returns {Array<{ key: string, title: string }>}
   */
  allRoutes() {
    const result = [];
    for (const [key, config] of this._routes) {
      result.push({ key, title: config.title });
    }
    return result;
  }

  /**
   * Stop listening.
   */
  destroy() {
    window.removeEventListener('hashchange', this._onHashChange);
  }

  // ---- Internal ----

  async _onHashChange() {
    const key = this.current();

    // Parse section and tool from key
    const parts = key.split('/');
    const section = parts[0] || 'welcome';
    const tool = parts[1] || null;

    // Update state
    state.set('nav.section', section);
    state.set('nav.tool', tool);

    // Unmount previous
    if (this._active?.module?.unmount) {
      try { this._active.module.unmount(); }
      catch (err) { console.error(`[Router] Error unmounting "${this._active.key}":`, err); }
    }

    // Find matching route
    const config = this._routes.get(key) || this._routes.get(section);
    if (!config) {
      console.warn(`[Router] No route registered for "${key}"`);
      if (this._outlet) {
        this._outlet.innerHTML = `
          <div style="padding: 40px; text-align: center; color: var(--ies-gray-500);">
            <p class="text-section">Section not found</p>
            <p class="mt-4">The page "${key}" doesn't exist or hasn't been built yet.</p>
          </div>`;
      }
      this._active = null;
      bus.emit('nav:changed', { section, tool, found: false });
      return;
    }

    // Lazy load the module
    try {
      const mod = await config.load();
      this._active = { key, module: mod };

      // Mount into outlet
      if (this._outlet && mod.mount) {
        this._outlet.innerHTML = '';
        mod.mount(this._outlet);
      }

      bus.emit('nav:changed', { section, tool, found: true, title: config.title });
    } catch (err) {
      console.error(`[Router] Error loading route "${key}":`, err);
      if (this._outlet) {
        this._outlet.innerHTML = `
          <div style="padding: 40px; text-align: center; color: var(--ies-red);">
            <p class="text-section">Error loading module</p>
            <p class="mt-4">${err.message}</p>
          </div>`;
      }
    }
  }
}

/** Singleton router instance */
export const router = new Router();

export { Router };

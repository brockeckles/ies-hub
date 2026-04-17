/**
 * IES Hub v3 — Global Search
 * Static index + dynamic Supabase search, dropdown UI, keyboard navigation.
 *
 * Usage:
 *   import { search } from './search.js?v=20260417-mE';
 *   search.init(document.querySelector('.hub-search-container'));
 *
 * @module shared/search
 */

import { router } from './router.js?v=20260417-mE';
import { bus } from './event-bus.js?v=20260417-mE';

/**
 * @typedef {Object} SearchEntry
 * @property {string} title
 * @property {string} route — hash route to navigate to
 * @property {string} [section] — parent section label
 * @property {string[]} [keywords] — extra search terms
 */

class GlobalSearch {
  constructor() {
    /** @type {SearchEntry[]} */
    this._staticIndex = [];
    /** @type {HTMLElement|null} */
    this._container = null;
    /** @type {HTMLInputElement|null} */
    this._input = null;
    /** @type {HTMLElement|null} */
    this._dropdown = null;
    /** @type {number} */
    this._focusedIdx = -1;
    /** @type {SearchEntry[]} */
    this._results = [];
  }

  /**
   * Build the static search index from registered routes + hardcoded entries.
   */
  buildIndex() {
    // Start with router-registered routes
    this._staticIndex = router.allRoutes().map(r => ({
      title: r.title,
      route: r.key,
      section: r.key.split('/')[0],
    }));

    // Add well-known navigation targets
    const extraEntries = [
      { title: 'Command Center', route: 'overview', section: 'Intelligence', keywords: ['alerts', 'news', 'market', 'dashboard'] },
      { title: 'Deal Management', route: 'deals', section: 'Work', keywords: ['pipeline', 'opportunities', 'DOS'] },
      { title: 'Design Tools', route: 'designtools', section: 'Work', keywords: ['tools', 'cost model', 'warehouse', 'fleet'] },
      { title: 'Training Wiki', route: 'training', section: 'Resources', keywords: ['wiki', 'knowledge', 'articles'] },
      { title: 'Change Management', route: 'changemanagement', section: 'Resources', keywords: ['change', 'updates'] },
      { title: 'Hub Guide', route: 'welcome', section: 'Resources', keywords: ['home', 'guide', 'getting started'] },
      { title: 'Ideas & Feedback', route: 'feedback', section: 'Resources', keywords: ['feedback', 'ideas', 'suggestions'] },
      { title: 'Reference Data', route: 'admin', section: 'Admin', keywords: ['admin', 'settings', 'master data'] },
      { title: 'Cost Model Builder', route: 'designtools/cost-model', section: 'Design Tools', keywords: ['pricing', 'P&L', 'labor', 'equipment', 'overhead'] },
      { title: 'Multi-Site Analyzer', route: 'designtools/deal-manager', section: 'Design Tools', keywords: ['deal', 'sites', 'compare'] },
      { title: 'Warehouse Sizing Calculator', route: 'designtools/warehouse-sizing', section: 'Design Tools', keywords: ['warehouse', 'sqft', '3D', 'facility'] },
      { title: 'MOST Labor Standards', route: 'designtools/most-standards', section: 'Design Tools', keywords: ['MOST', 'labor', 'TMU', 'standards'] },
      { title: 'Center of Gravity', route: 'designtools/center-of-gravity', section: 'Design Tools', keywords: ['COG', 'location', 'clustering'] },
      { title: 'Network Optimization', route: 'designtools/network-opt', section: 'Design Tools', keywords: ['TL', 'LTL', 'parcel', 'freight', 'lanes'] },
      { title: 'Fleet Modeler', route: 'designtools/fleet-modeler', section: 'Design Tools', keywords: ['fleet', 'trucks', 'routes', 'vehicles'] },
    ];

    // Merge, deduplicating by route
    const seen = new Set(this._staticIndex.map(e => e.route));
    for (const entry of extraEntries) {
      if (!seen.has(entry.route)) {
        this._staticIndex.push(entry);
        seen.add(entry.route);
      }
    }
  }

  /**
   * Initialize search UI.
   * @param {HTMLElement} container — the .hub-search-container element
   */
  init(container) {
    this._container = container;
    this._input = container.querySelector('.hub-search-input');
    this._dropdown = container.querySelector('.hub-search-dropdown');
    if (!this._input || !this._dropdown) return;

    this.buildIndex();

    this._input.addEventListener('input', () => this._onInput());
    this._input.addEventListener('keydown', (e) => this._onKeydown(e));
    this._input.addEventListener('focus', () => {
      if (this._input.value.length > 0) this._onInput();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!container.contains(/** @type {Node} */ (e.target))) {
        this._close();
      }
    });
  }

  /**
   * Filter results based on query.
   * @param {string} query
   * @returns {SearchEntry[]}
   */
  filter(query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    return this._staticIndex
      .map(entry => {
        let score = 0;
        const title = entry.title.toLowerCase();
        const section = (entry.section || '').toLowerCase();
        const keywords = (entry.keywords || []).join(' ').toLowerCase();

        if (title === q) score = 100;
        else if (title.startsWith(q)) score = 80;
        else if (title.includes(q)) score = 60;
        else if (section.includes(q)) score = 40;
        else if (keywords.includes(q)) score = 30;
        else return null;

        return { ...entry, _score: score };
      })
      .filter(Boolean)
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);
  }

  // ---- Internal UI handlers ----

  _onInput() {
    const query = this._input.value;
    this._results = this.filter(query);
    this._focusedIdx = -1;
    this._render();
  }

  _onKeydown(e) {
    if (!this._dropdown.classList.contains('visible')) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._focusedIdx = Math.min(this._focusedIdx + 1, this._results.length - 1);
        this._render();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._focusedIdx = Math.max(this._focusedIdx - 1, 0);
        this._render();
        break;
      case 'Enter':
        e.preventDefault();
        if (this._focusedIdx >= 0 && this._results[this._focusedIdx]) {
          this._select(this._results[this._focusedIdx]);
        }
        break;
      case 'Escape':
        this._close();
        break;
    }
  }

  _render() {
    if (this._results.length === 0) {
      this._dropdown.classList.remove('visible');
      return;
    }

    this._dropdown.innerHTML = this._results.map((r, i) => `
      <div class="hub-search-result${i === this._focusedIdx ? ' focused' : ''}" data-idx="${i}">
        <div>
          <div class="hub-search-result-title">${r.title}</div>
          ${r.section ? `<div class="hub-search-result-section">${r.section}</div>` : ''}
        </div>
      </div>
    `).join('');

    this._dropdown.classList.add('visible');

    // Click handlers
    this._dropdown.querySelectorAll('.hub-search-result').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-idx'));
        this._select(this._results[idx]);
      });
    });
  }

  _select(entry) {
    router.navigate(entry.route);
    this._close();
    this._input.value = '';
    bus.emit('search:navigate', { route: entry.route, title: entry.title });
  }

  _close() {
    this._dropdown.classList.remove('visible');
    this._focusedIdx = -1;
  }
}

/** Singleton search instance */
export const search = new GlobalSearch();

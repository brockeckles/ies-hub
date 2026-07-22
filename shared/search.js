/**
 * IES Hub v3 — Global Search
 * Static index (registered routes + well-known screens/tools) PLUS live
 * Supabase results for Deals and Sites, with dropdown UI + keyboard nav.
 *
 * Static entries render instantly on every keystroke. Live entries are
 * debounced (250ms) name-substring lookups:
 *   - Deals: deal_deals.deal_name ilike %q%  → routes to `deals?deal=<id>`
 *   - Sites: deal_sites.name     ilike %q%  → routes to `deals?deal=<deal_id>`
 * (the `?deal=` hash param is the deep-link contract shared/deal-context.js
 * reads; the router strips the query for route matching).
 *
 * Fail-soft by design: no session, RLS-denied, or failed queries silently
 * yield zero live results — the static index still works and nothing throws
 * into the UI.
 *
 * Usage:
 *   import { search } from './search.js?v=20260722-s4e';
 *   search.init(document.querySelector('.hub-search-container'));
 *
 * @module shared/search
 */

import { router } from './router.js?v=20260722-s4e';
import { bus } from './event-bus.js?v=20260418-sK';
import { escapeHtml as _h } from './escape.js?v=20260702-sec2';
import { db } from './supabase.js?v=20260703-hw1';

/** Debounce for the live Supabase lookups (ms). */
const LIVE_DEBOUNCE_MS = 250;
/** Max live rows fetched per entity type. */
const LIVE_LIMIT = 8;
/** Minimum query length before hitting the network. */
const LIVE_MIN_CHARS = 2;

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
    /** @type {SearchEntry[]} — last static filter pass (live rows append) */
    this._staticResults = [];
    /** @type {number|null} */
    this._liveTimer = null;
    /** @type {number} — monotonically increasing fetch token (stale guard) */
    this._liveSeq = 0;
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
      { title: 'Ideas & Feedback', route: 'feedback', section: 'Resources', keywords: ['feedback', 'ideas', 'suggestions'] },
      { title: 'Admin', route: 'admin', section: 'Admin', keywords: ['admin', 'settings', 'master data', 'reference data', 'users', 'user activity', 'escalations', 'audit'] },
      { title: 'Cost Model Builder', route: 'designtools/cost-model', section: 'Design Tools', keywords: ['pricing', 'P&L', 'labor', 'equipment', 'overhead'] },
      // UX-1 D1p2 (2026-07-03): MSA merged into Deal Management — removed from search.
      { title: 'Warehouse Sizing Calculator', route: 'designtools/warehouse-sizing', section: 'Design Tools', keywords: ['warehouse', 'sqft', '3D', 'facility'] },
      { title: 'MOST Labor Standards', route: 'designtools/most-standards', section: 'Design Tools', keywords: ['MOST', 'labor', 'TMU', 'standards'] },
      { title: 'Center of Gravity', route: 'designtools/center-of-gravity', section: 'Design Tools', keywords: ['COG', 'location', 'clustering'] },
      // UX0-5 (2026-07-03): NetOpt shelved — removed from search index (decision #9).

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
   * Filter static results based on query.
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

  // ---- Live Supabase lookups (Deals + Sites) ----

  /**
   * Fetch live Deal + Site matches by name substring. Returns [] on ANY
   * problem — missing session, network failure, RLS denial — so the static
   * index keeps working and nothing throws into the UI.
   * @param {string} q — trimmed query
   * @returns {Promise<SearchEntry[]>}
   */
  async searchLive(q) {
    try {
      // No session → skip silently. getClient() throws when the CDN lib is
      // absent (e.g. tests); that lands in the catch below.
      const { data: sess } = await db.getClient().auth.getSession();
      if (!sess || !sess.session) return [];

      // Strip chars that would break the PostgREST ilike pattern.
      const cleaned = q.replace(/[%_,()]/g, '').trim();
      if (cleaned.length < LIVE_MIN_CHARS) return [];
      const pattern = `%${cleaned}%`;

      const [dealsRes, sitesRes] = await Promise.all([
        db.from('deal_deals')
          .select('id, deal_name, client_name')
          .ilike('deal_name', pattern)
          .limit(LIVE_LIMIT),
        db.from('deal_sites')
          .select('id, name, deal_id')
          .ilike('name', pattern)
          .limit(LIVE_LIMIT),
      ]);

      /** @type {SearchEntry[]} */
      const out = [];
      if (!dealsRes.error) {
        for (const d of dealsRes.data || []) {
          if (!d || !d.id) continue;
          out.push({
            title: d.deal_name || 'Untitled Deal',
            route: `deals?deal=${encodeURIComponent(d.id)}`,
            section: d.client_name ? `Deal · ${d.client_name}` : 'Deal',
          });
        }
      }
      if (!sitesRes.error) {
        for (const s of sitesRes.data || []) {
          if (!s || !s.id) continue;
          out.push({
            title: s.name || 'Unnamed Site',
            route: s.deal_id ? `deals?deal=${encodeURIComponent(s.deal_id)}` : 'deals',
            section: 'Site',
          });
        }
      }
      return out;
    } catch (err) {
      // Fail-soft: live search is a bonus layer, never an error surface.
      return [];
    }
  }

  /** Debounce a live lookup for the current query. */
  _scheduleLive(query) {
    if (this._liveTimer) clearTimeout(this._liveTimer);
    this._liveTimer = null;
    const q = (query || '').trim();
    if (q.length < LIVE_MIN_CHARS) return;
    this._liveTimer = setTimeout(() => {
      this._liveTimer = null;
      this._runLive(q);
    }, LIVE_DEBOUNCE_MS);
  }

  async _runLive(q) {
    const seq = ++this._liveSeq;
    const rows = await this.searchLive(q);
    // Stale guards: a newer fetch started, or the input has moved on.
    if (seq !== this._liveSeq) return;
    if (!this._input || this._input.value.trim() !== q) return;
    if (rows.length === 0) return;
    // Append after the static hits, dedup by route.
    const seen = new Set(this._staticResults.map(e => e.route));
    const merged = [...this._staticResults];
    for (const r of rows) {
      if (seen.has(r.route)) continue;
      seen.add(r.route);
      merged.push(r);
    }
    this._results = merged;
    // Keep keyboard focus only if it still points at the same (static) row.
    if (this._focusedIdx >= this._staticResults.length) this._focusedIdx = -1;
    this._render();
  }

  // ---- Internal UI handlers ----

  _onInput() {
    const query = this._input.value;
    this._staticResults = this.filter(query);
    this._results = this._staticResults;
    this._focusedIdx = -1;
    this._render();
    this._scheduleLive(query);
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
          <div class="hub-search-result-title">${_h(r.title)}</div>
          ${r.section ? `<div class="hub-search-result-section">${_h(r.section)}</div>` : ''}
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
  }

  _close() {
    if (this._liveTimer) { clearTimeout(this._liveTimer); this._liveTimer = null; }
    this._liveSeq++; // invalidate any in-flight live fetch
    this._dropdown.classList.remove('visible');
    this._focusedIdx = -1;
  }
}

/** Singleton search instance */
export const search = new GlobalSearch();

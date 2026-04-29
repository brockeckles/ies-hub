/**
 * IES Hub v3 — Market Explorer UI
 * Interactive market intelligence view with Leaflet map, data library, and 5-tab detail panels.
 * Uses event delegation to survive innerHTML re-renders.
 * @module hub/market-explorer/ui
 */

import * as calc from './calc.js?v=20260418-sK';
import * as api from './api.js?v=20260418-sK';

// Per-market signal cache: marketId → { news, alerts, fetchedAt }
const marketSignalCache = new Map();

let rootEl = null;
let markets = [...calc.DEMO_MARKETS];
let selectedMarket = null;
// colorMode drives both the map-pin coloring and the rail list's primary metric.
// Replaces the old 5-tab top-level navigation. Values: 'all' / 'labor' /
// 'realestate' / 'freight' / 'gxo'.
let colorMode = 'all';
let detailTabActive = 'overview';
let filterRegion = 'all';
let filterPresence = 'all';
let searchQuery = '';
let mapInstance = null;
let leafletLoaded = false;

// ============================================================
// MOUNT / UNMOUNT
// ============================================================

export function mount(el) {
  rootEl = el;
  markets = [...calc.DEMO_MARKETS];
  selectedMarket = null;
  colorMode = 'all';
  detailTabActive = 'overview';
  filterRegion = 'all';
  filterPresence = 'all';
  searchQuery = '';
  mapInstance = null;
  render();
  bindDelegatedEvents();
  // Load Leaflet if not loaded
  ensureLeafletLoaded();
}

export function unmount() {
  rootEl = null;
  selectedMarket = null;
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
}

// ============================================================
// EVENT DELEGATION — survives innerHTML re-renders
// ============================================================

function bindDelegatedEvents() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Color-mode chip clicks (replaces top-level tab nav)
    const chip = target.closest('[data-color-mode]');
    if (chip) {
      colorMode = /** @type {HTMLElement} */ (chip).dataset.colorMode;
      // Recolor pins + re-render rail list without full shell re-render so the
      // map doesn't blink on every chip change.
      _recolorPins();
      _refreshRailList();
      _refreshChipBar();
      return;
    }

    // Detail tab clicks (5-tab panel inside the slide-in detail)
    const detailTab = target.closest('[data-detail-tab]');
    if (detailTab) {
      detailTabActive = /** @type {HTMLElement} */ (detailTab).dataset.detailTab;
      renderDetailContent();
      if (detailTabActive === 'intelligence' && selectedMarket) {
        loadIntelligenceIfNeeded(selectedMarket);
      }
      return;
    }

    // Market row click in the right rail list — open detail panel slide-in
    const row = target.closest('[data-market-row]');
    if (row) {
      const id = /** @type {HTMLElement} */ (row).dataset.marketRow;
      const m = markets.find(x => x.id === id) || null;
      if (m) _openDetail(m);
      return;
    }

    // Close detail panel — slide back to rail list
    if (target.closest('[data-action="close-detail"]')) {
      _closeDetail();
      return;
    }
  });

  rootEl.addEventListener('input', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('[data-action="search"]')) {
      searchQuery = /** @type {HTMLInputElement} */ (target).value;
      renderContent();
    }
  });

  rootEl.addEventListener('change', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('[data-action="filter-region"]')) {
      filterRegion = /** @type {HTMLSelectElement} */ (target).value;
      selectedMarket = null;
      renderContent();
    }
    if (target.matches('[data-action="filter-presence"]')) {
      filterPresence = /** @type {HTMLSelectElement} */ (target).value;
      selectedMarket = null;
      renderContent();
    }
  });
}

// ============================================================
// RENDER
// ============================================================

function render() {
  if (!rootEl) return;

  // Before nuking DOM via innerHTML, tear down the Leaflet map or its internal
  // references will point at detached nodes (causing the "Loading map..."
  // stall when returning to the Overview tab or clicking a city).
  if (mapInstance) {
    try { mapInstance.remove(); } catch {}
    mapInstance = null;
    // Detach marker refs so they don't leak into the next render
    markets.forEach(m => { if (m._marker) m._marker = null; });
  }

  const filtered = getFiltered();
  const stats = calc.computeStats(filtered);
  const regions = calc.uniqueRegions(markets);

  rootEl.innerHTML = `
    <style>
      .me-news-link { color: inherit; text-decoration: none; transition: color 0.12s; }
      .me-news-link:hover { color: var(--ies-blue); }
      /* KPI ?-icon tooltips — restore hover behavior (lost in 2026-04-29 redesign) */
      .cc-kpi-tip:hover .cc-kpi-tiptext { display: block !important; }
      /* Detail panel tiles — fit one row in the narrow rail */
      .me-detail-slide .hub-kpi-tile__value { font-size: 16px; }
      .me-detail-slide .hub-kpi-tile { padding: 8px 10px; }
      /* Override 2-col/3-col tile grids in the detail panel: keep 2-col but tighter */
      .me-detail-slide [style*="grid-template-columns"] { gap: 8px !important; }
      /* Detail panel tab bar — single row, tighter padding so all 5 fit */
      .me-detail-slide .hub-tab-bar {
        margin-bottom: 16px !important;
        gap: 0 !important;
        flex-wrap: nowrap !important;
        overflow-x: auto;
      }
      .me-detail-slide .hub-tab {
        padding: 6px 10px !important;
        font-size: 11px !important;
        flex: 0 0 auto;
      }
      .me-detail-slide #market-detail-tabs { padding-top: 4px; }
      .me-detail-slide #market-detail-tabs > div { margin-top: 6px; }
      /* Force 3-column tile grids inside the panel down to 2 cols (rail is narrow) */
      .me-detail-slide [style*="grid-template-columns: repeat(3"] {
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      }
      /* Click affordance on rail rows: chevron + stronger hover */
      .me-row { position: relative; }
      .me-row::after {
        content: '\\203A'; position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
        font-size: 18px; color: var(--ies-gray-300); font-weight: 400;
        transition: transform 0.12s, color 0.12s;
      }
      .me-row:hover::after { color: var(--ies-orange); transform: translateY(-50%) translateX(2px); }
      .me-row__metric { padding-right: 16px; }
      .me-chip {
        font-size: 11px; font-weight: 700;
        padding: 5px 12px; border-radius: 999px;
        border: 1px solid var(--ies-gray-300);
        background: #fff; color: var(--ies-gray-700);
        cursor: pointer; text-transform: uppercase; letter-spacing: 0.04em;
        white-space: nowrap; transition: all 0.12s;
      }
      .me-chip:hover { border-color: var(--ies-navy); color: var(--ies-navy); }
      .me-chip.active { background: var(--ies-navy); color: #fff; border-color: var(--ies-navy); }
      .me-rail { position: relative; }
      .me-rail-list, .me-detail-slide {
        position: absolute; inset: 0;
        overflow-y: auto;
        background: #fff;
        transition: transform 0.22s ease, opacity 0.18s ease;
      }
      .me-detail-slide {
        transform: translateX(100%); opacity: 0; pointer-events: none;
        border-left: 4px solid var(--ies-orange);
      }
      .me-rail.detail-open .me-rail-list { transform: translateX(-6%); opacity: 0.4; pointer-events: none; }
      .me-rail.detail-open .me-detail-slide { transform: translateX(0); opacity: 1; pointer-events: auto; }
      .me-row {
        display: grid; grid-template-columns: 1fr auto;
        gap: 4px 10px; padding: 10px 12px;
        border-bottom: 1px solid var(--ies-gray-100);
        cursor: pointer; transition: background 0.1s;
      }
      .me-row:hover { background: var(--ies-gray-50); }
      .me-row.selected { background: rgba(255,58,0,0.06); border-left: 3px solid var(--ies-orange); padding-left: 9px; }
      .me-row__name { font-size: 13px; font-weight: 700; color: var(--ies-navy); }
      .me-row__region { font-size: 11px; color: var(--ies-gray-500); grid-column: 1; }
      .me-row__metric { grid-column: 2; grid-row: 1 / span 2; align-self: center; text-align: right; }
      .me-row__metric-label { font-size: 9px; color: var(--ies-gray-400); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; }
      .me-row__metric-value { font-size: 14px; font-weight: 800; color: var(--ies-navy); font-variant-numeric: tabular-nums; }
      .me-pin-bullet { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    </style>
    <div class="hub-content-inner">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--sp-4); gap: 12px; flex-wrap: wrap;">
        <h1 class="text-page">Market Explorer</h1>
        <div style="display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap;">
          <input type="text" class="hub-input" placeholder="Search markets..." value="${searchQuery}"
            data-action="search" style="width: 220px; height: 36px; font-size: 13px;" />
          <select class="hub-select" data-action="filter-region" style="width: auto; height: 36px; font-size: 13px;">
            <option value="all">All Regions</option>
            ${regions.map(r => `<option value="${r}" ${filterRegion === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <select class="hub-select" data-action="filter-presence" style="width: auto; height: 36px; font-size: 13px;">
            <option value="all">All Presence</option>
            <option value="active" ${filterPresence === 'active' ? 'selected' : ''}>GXO Active</option>
            <option value="target" ${filterPresence === 'target' ? 'selected' : ''}>Target Markets</option>
          </select>
        </div>
      </div>

      <!-- KPI strip -->
      <div class="hub-kpi-strip" style="margin-bottom: var(--sp-3);">
        ${meKpi('Markets Tracked', String(stats.totalMarkets), 'Count of MSAs in the filter set (of ' + markets.length + ' total tracked).')}
        ${meKpi('Avg Labor Score', calc.scoreBadge(stats.avgLaborScore), 'Composite labor-availability score (0-100) for filtered markets. Higher = more available workforce.')}
        ${meKpi('Avg Warehouse Wage', calc.fmt$(stats.avgWage) + '/hr', 'Average hourly warehouse wage (filtered set). BLS OEWS data, seasonally adjusted.')}
        ${meKpi('Markets with Deals', String(stats.marketsWithDeals), 'Markets in the filtered set that have at least one active deal in the IES pipeline.')}
      </div>

      <!-- Color-mode chips (replaces top-level tabs) -->
      <div id="me-chip-bar" style="display: flex; gap: 6px; align-items: center; margin-bottom: var(--sp-3); flex-wrap: wrap;">
        ${_renderChipBar()}
      </div>

      <!-- Two-pane main: persistent map (left, ~62%) + rail (right, ~38%) -->
      <div style="display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(360px, 1fr); gap: 16px; height: 580px;">
        <!-- Map pane -->
        <div class="hub-card" style="padding: var(--sp-3); display: flex; flex-direction: column; min-height: 0;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom: var(--sp-2);">
            <h3 class="text-subtitle" style="margin: 0;">US Market Map</h3>
            <span class="text-caption text-muted">${filtered.length} markets · click a pin for details</span>
          </div>
          <div id="market-map" style="background: var(--ies-gray-100); border-radius: var(--radius-md); flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden;">
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--ies-gray-500); font-size: 13px;">Loading map...</div>
          </div>
        </div>

        <!-- Right rail: ranked list + slide-in detail panel -->
        <div class="hub-card me-rail" style="padding: 0; display: flex; flex-direction: column; min-height: 0;">
          <div class="me-rail-list" id="me-rail-list">
            ${_renderRailList(filtered)}
          </div>
          <div class="me-detail-slide" id="me-detail-slide">
            ${selectedMarket ? renderDetailPanel(selectedMarket) : ''}
          </div>
        </div>
      </div>
    </div>
  `;

  // Sync the slide-open class if a market is preselected (e.g., across navigation).
  const railEl = rootEl.querySelector('.me-rail');
  if (railEl) {
    railEl.classList.toggle('detail-open', !!selectedMarket);
  }

  // Always re-init the map (this fn is called on full shell re-renders only).
  setTimeout(() => initializeMap(filtered), 60);
}

// renderContent retained for filter changes — re-renders the rail list +
// recolors pins without nuking the map. Full shell render only happens on
// mount or filter changes that drop the selected market.
function renderContent() {
  if (!rootEl) return;
  _refreshRailList();
  _recolorPins();
  // Detail panel state syncs from selectedMarket flag.
  const railEl = rootEl.querySelector('.me-rail');
  if (railEl) railEl.classList.toggle('detail-open', !!selectedMarket);
}

function renderDetailContent() {
  if (!rootEl) return;
  const detailEl = rootEl.querySelector('#me-detail-slide');
  if (detailEl) {
    detailEl.innerHTML = selectedMarket ? renderDetailPanel(selectedMarket) : '';
  }
}

// ============================================================
// DIRECTION A — color-mode chip + rail list helpers
// ============================================================

const _COLOR_MODES = [
  { key: 'all',        label: 'All',         metric: 'gxo' },
  { key: 'labor',      label: 'Labor',       metric: 'labor' },
  { key: 'realestate', label: 'Real Estate', metric: 'rate' },
  { key: 'freight',    label: 'Freight',     metric: 'freight' },
  { key: 'gxo',        label: 'GXO Presence', metric: 'gxo' },
];

function _renderChipBar() {
  return [
    '<span style="font-size: 11px; font-weight: 700; color: var(--ies-gray-500); text-transform: uppercase; letter-spacing: 0.04em; margin-right: 4px;">Heat by:</span>',
    ..._COLOR_MODES.map(m =>
      `<button class="me-chip ${colorMode === m.key ? 'active' : ''}" data-color-mode="${m.key}">${m.label}</button>`
    ),
  ].join('');
}

function _refreshChipBar() {
  if (!rootEl) return;
  const bar = rootEl.querySelector('#me-chip-bar');
  if (bar) bar.innerHTML = _renderChipBar();
}

// Pin color resolution. Continuous metrics (labor / rate / freight) use a
// 3-tier ramp keyed off the FILTERED set\'s tertile so the highlight is
// relative to what\'s on screen. GXO presence uses the original color rule.
function _pinColorFor(market, metricKey, filteredSorted) {
  const styles = getComputedStyle(document.documentElement);
  const c = (name, fallback) => (styles.getPropertyValue(name) || fallback).trim() || fallback;
  if (metricKey === 'gxo') {
    if (market.gxoPresence === 'active') return c('--ies-green', '#16a34a');
    if (market.gxoPresence === 'target') return c('--ies-blue', '#0047AB');
    return c('--ies-gray-400', '#adb5bd');
  }
  // Continuous: lookup market\'s rank in sorted-by-metric array
  const idx = filteredSorted.findIndex(m => m.id === market.id);
  if (idx === -1) return c('--ies-gray-400', '#adb5bd');
  const t = idx / Math.max(1, filteredSorted.length - 1);
  // Lower idx = better (sorted ascending for cost metrics, descending for score)
  if (t < 0.34) return c('--ies-green', '#16a34a');
  if (t < 0.67) return c('--ies-orange', '#ff3a00');
  return c('--ies-red', '#dc3545');
}

// Sort filtered markets by current colorMode\'s primary metric — best first.
function _sortFilteredByMode(filtered) {
  const arr = [...filtered];
  switch (colorMode) {
    case 'labor':      return arr.sort((a, b) => (b.laborScore || 0) - (a.laborScore || 0));      // higher = better
    case 'realestate': return arr.sort((a, b) => (a.warehouseRate || 0) - (b.warehouseRate || 0)); // lower = better
    case 'freight':    return arr.sort((a, b) => (a.freightIndex || 0) - (b.freightIndex || 0));   // lower = better
    case 'gxo':        return arr.sort((a, b) => {
      const score = (m) => m.gxoPresence === 'active' ? 0 : m.gxoPresence === 'target' ? 1 : 2;
      return score(a) - score(b);
    });
    default: return arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
}

function _metricForRow(m) {
  switch (colorMode) {
    case 'labor':      return { label: 'Labor score', value: String(m.laborScore || '—') + '/100' };
    case 'realestate': return { label: '$/sqft/yr',   value: calc.fmt$(m.warehouseRate || 0) };
    case 'freight':    return { label: 'Freight idx', value: String(m.freightIndex || '—') };
    case 'gxo':        return { label: 'GXO',         value: (m.gxoPresence || 'none').replace(/^./, c => c.toUpperCase()) };
    default:           return { label: 'Wage / hr',   value: calc.fmt$(m.avgWage || 0) };
  }
}

function _sortHeading() {
  switch (colorMode) {
    case 'labor':      return 'Top markets by labor score';
    case 'realestate': return 'Lowest warehouse rent';
    case 'freight':    return 'Lowest freight cost';
    case 'gxo':        return 'GXO presence — active first';
    default:           return 'All markets — alphabetical';
  }
}

function _renderRailList(filtered) {
  const sorted = _sortFilteredByMode(filtered);
  const styles = (typeof window !== 'undefined' && document) ? getComputedStyle(document.documentElement) : null;
  const cText = (n, f) => styles ? ((styles.getPropertyValue(n) || f).trim() || f) : f;
  const rows = sorted.map(m => {
    const metric = _metricForRow(m);
    const pinColor = _pinColorFor(m, _COLOR_MODES.find(x => x.key === colorMode)?.metric || 'gxo', sorted);
    const isSelected = selectedMarket && selectedMarket.id === m.id;
    return `
      <div class="me-row ${isSelected ? 'selected' : ''}" data-market-row="${m.id}">
        <div class="me-row__name"><span class="me-pin-bullet" style="background:${pinColor};"></span>${m.name}</div>
        <div class="me-row__region">${m.region}</div>
        <div class="me-row__metric">
          <div class="me-row__metric-label">${metric.label}</div>
          <div class="me-row__metric-value">${metric.value}</div>
        </div>
      </div>
    `;
  }).join('');
  return `
    <div style="padding: 10px 12px 8px; border-bottom: 1px solid var(--ies-gray-200); display: flex; align-items: center; justify-content: space-between;">
      <div style="font-size: 13px; font-weight: 700; color: var(--ies-navy);">${_sortHeading()}</div>
      <span class="text-caption text-muted">${sorted.length} markets</span>
    </div>
    ${rows}
  `;
}

function _refreshRailList() {
  if (!rootEl) return;
  const listEl = rootEl.querySelector('#me-rail-list');
  if (listEl) {
    const filtered = getFiltered();
    listEl.innerHTML = _renderRailList(filtered);
  }
}

function _recolorPins() {
  if (!mapInstance) return;
  const filtered = getFiltered();
  const sorted = _sortFilteredByMode(filtered);
  const metric = _COLOR_MODES.find(m => m.key === colorMode)?.metric || 'gxo';
  for (const m of markets) {
    if (!m._marker) continue;
    const inFilter = filtered.some(f => f.id === m.id);
    if (!inFilter) {
      m._marker.setStyle({ fillOpacity: 0, opacity: 0 });
      continue;
    }
    const color = _pinColorFor(m, metric, sorted);
    m._marker.setStyle({ fillColor: color, color: '#fff', fillOpacity: 0.85, opacity: 1 });
  }
}

function _openDetail(m) {
  selectedMarket = m;
  detailTabActive = 'overview';
  if (!rootEl) return;
  const slide = rootEl.querySelector('#me-detail-slide');
  if (slide) slide.innerHTML = renderDetailPanel(m);
  const railEl = rootEl.querySelector('.me-rail');
  if (railEl) railEl.classList.add('detail-open');
  highlightMarketOnMap(m.id);
  _refreshRailList();
}

function _closeDetail() {
  selectedMarket = null;
  detailTabActive = 'overview';
  if (!rootEl) return;
  const railEl = rootEl.querySelector('.me-rail');
  if (railEl) railEl.classList.remove('detail-open');
  _refreshRailList();
}

function getFiltered() {
  let filtered = calc.filterByRegion(markets, filterRegion);
  filtered = calc.filterByPresence(filtered, filterPresence);
  filtered = calc.searchMarkets(filtered, searchQuery);
  return filtered;
}

// ============================================================
// TAB RENDERERS
// ============================================================

// renderTab dispatcher removed in 2026-04-29 redesign. Top-level tabs were
// replaced by color-mode chips + a persistent map+rail layout. The previous
// per-tab renderers (renderLaborWatch, renderRealEstate, renderFreight,
// renderDataLibrary, renderOverview) are no longer called and can be deleted
// in a follow-up cleanup commit.

function renderOverview(filtered) {
  // Map full-width — the right-hand "Data Library" table was duplicative of
  // the Data Library tab below; removed per feedback 2026-04-17.
  return `
    <style>
      .me-news-link { color: inherit; text-decoration: none; transition: color 0.12s; }
      .me-news-link:hover { color: var(--ies-blue); }
      /* KPI ?-icon tooltips — restore hover behavior (lost in 2026-04-29 redesign) */
      .cc-kpi-tip:hover .cc-kpi-tiptext { display: block !important; }
      /* Detail panel tiles — fit one row in the narrow rail */
      .me-detail-slide .hub-kpi-tile__value { font-size: 16px; }
      .me-detail-slide .hub-kpi-tile { padding: 8px 10px; }
      /* Override 2-col/3-col tile grids in the detail panel: keep 2-col but tighter */
      .me-detail-slide [style*="grid-template-columns"] { gap: 8px !important; }
      /* Detail panel tab bar — single row, tighter padding so all 5 fit */
      .me-detail-slide .hub-tab-bar {
        margin-bottom: 16px !important;
        gap: 0 !important;
        flex-wrap: nowrap !important;
        overflow-x: auto;
      }
      .me-detail-slide .hub-tab {
        padding: 6px 10px !important;
        font-size: 11px !important;
        flex: 0 0 auto;
      }
      .me-detail-slide #market-detail-tabs { padding-top: 4px; }
      .me-detail-slide #market-detail-tabs > div { margin-top: 6px; }
      /* Force 3-column tile grids inside the panel down to 2 cols (rail is narrow) */
      .me-detail-slide [style*="grid-template-columns: repeat(3"] {
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      }
      /* Click affordance on rail rows: chevron + stronger hover */
      .me-row { position: relative; }
      .me-row::after {
        content: '\\203A'; position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
        font-size: 18px; color: var(--ies-gray-300); font-weight: 400;
        transition: transform 0.12s, color 0.12s;
      }
      .me-row:hover::after { color: var(--ies-orange); transform: translateY(-50%) translateX(2px); }
      .me-row__metric { padding-right: 16px; }
    </style>
    <div class="hub-card" style="padding: var(--sp-4); position: relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom: var(--sp-3);">
        <h3 class="text-subtitle" style="margin: 0;">US Market Map</h3>
        <span class="text-caption text-muted">${filtered.length} markets shown — click a pin for details</span>
      </div>
      <div id="market-map" style="background: var(--ies-gray-100); border-radius: var(--radius-md); height: 520px; position: relative; overflow: hidden;">
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--ies-gray-500); font-size: 13px;">Loading map...</div>
      </div>
    </div>
  `;
}

// Small helper — KPI tile with hover tooltip. Uses hub-kpi-tile BEM so the
// strip aligns with the rest of the hub; tooltip background tokenized to
// var(--ies-navy) instead of raw #1e293b hex.
function meKpi(label, value, tooltip) {
  return `
    <div class="hub-kpi-tile" style="position:relative;">
      <div style="display:flex;align-items:center;gap:4px;">
        <span class="hub-kpi-tile__label" style="min-height:0;">${label}</span>
        ${tooltip ? `<span class="cc-kpi-tip" style="position:relative;display:inline-flex;">
          <span style="width:14px;height:14px;border-radius:50%;background:var(--ies-gray-100);color:var(--ies-gray-400);font-size:9px;display:inline-flex;align-items:center;justify-content:center;cursor:help;font-weight:700;">?</span>
          <span class="cc-kpi-tiptext" style="display:none;position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 6px);width:240px;padding:8px 10px;background:var(--ies-navy);color:#fff;font-size:11px;font-weight:400;line-height:1.4;border-radius:6px;z-index:100;pointer-events:none;text-align:left;box-shadow:0 4px 12px rgba(0,0,0,.25);">${tooltip}</span>
        </span>` : ''}
      </div>
      <div class="hub-kpi-tile__value">${value}</div>
    </div>
  `;
}

function renderLaborWatch(filtered, topLabor) {
  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4);">
      <div class="hub-card" style="padding: var(--sp-4);">
        <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">Top 5 — Labor Availability</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead><tr style="border-bottom: 2px solid var(--ies-gray-200);"><th style="padding: 6px 8px; text-align:left;">Market</th><th style="padding: 6px 8px;">Score</th><th style="padding: 6px 8px;">Wage</th><th style="padding: 6px 8px;">Unemployment</th></tr></thead>
          <tbody>
            ${topLabor.map(m => `
              <tr style="border-bottom: 1px solid var(--ies-gray-100); cursor: pointer;" data-market-row="${m.id}">
                <td style="padding: 6px 8px; font-weight: 600;">${m.name}</td>
                <td style="padding: 6px 8px; text-align: center;">${calc.scoreBadge(m.laborScore)}</td>
                <td style="padding: 6px 8px; text-align: center;">${calc.fmt$(m.avgWage)}/hr</td>
                <td style="padding: 6px 8px; text-align: center;">${calc.fmtPct(m.unemploymentRate)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="hub-card" style="padding: var(--sp-4);">
        <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">Full Labor Data</h3>
        <div style="max-height: 300px; overflow-y: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead><tr style="border-bottom: 2px solid var(--ies-gray-200); position: sticky; top: 0; background: #fff;"><th style="padding: 4px 6px; text-align:left;">Market</th><th style="padding: 4px 6px;">Score</th><th style="padding: 4px 6px;">Wage</th><th style="padding: 4px 6px;">Unemp</th><th style="padding: 4px 6px;">Region</th></tr></thead>
            <tbody>
              ${calc.sortMarkets(filtered, 'laborScore', false).map(m => `
                <tr style="border-bottom: 1px solid var(--ies-gray-100); cursor: pointer;" data-market-row="${m.id}">
                  <td style="padding: 4px 6px;">${m.name}</td>
                  <td style="padding: 4px 6px; text-align: center;">${m.laborScore}</td>
                  <td style="padding: 4px 6px; text-align: center;">${calc.fmt$(m.avgWage)}</td>
                  <td style="padding: 4px 6px; text-align: center;">${calc.fmtPct(m.unemploymentRate)}</td>
                  <td style="padding: 4px 6px; text-align: center;">${m.region}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderRealEstate(filtered) {
  const sorted = calc.sortMarkets(filtered, 'warehouseRate', true);
  return `
    <div class="hub-card" style="padding: var(--sp-4);">
      <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">Industrial Real Estate — All Markets</h3>
      <div style="max-height: 450px; overflow-y: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead><tr style="border-bottom: 2px solid var(--ies-gray-200); position: sticky; top: 0; background: #fff;">
            <th style="padding: 6px 8px; text-align:left;">Market</th>
            <th style="padding: 6px 8px;">Region</th>
            <th style="padding: 6px 8px;">Rate ($/sqft/yr)</th>
            <th style="padding: 6px 8px;">Availability %</th>
            <th style="padding: 6px 8px;">GXO Presence</th>
            <th style="padding: 6px 8px;">Active Deals</th>
          </tr></thead>
          <tbody>
            ${sorted.map(m => `
              <tr style="border-bottom: 1px solid var(--ies-gray-100); cursor: pointer;" data-market-row="${m.id}">
                <td style="padding: 6px 8px; font-weight: 600;">${m.name}</td>
                <td style="padding: 6px 8px; text-align: center;">${m.region}</td>
                <td style="padding: 6px 8px; text-align: center; font-weight: 600;">${calc.fmt$(m.warehouseRate)}</td>
                <td style="padding: 6px 8px; text-align: center;">${calc.fmtPct(m.availabilityPct)}</td>
                <td style="padding: 6px 8px; text-align: center;">${calc.presenceBadge(m.gxoPresence)}</td>
                <td style="padding: 6px 8px; text-align: center;">${m.activeDeals}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderFreight(filtered) {
  const sorted = calc.sortMarkets(filtered, 'freightIndex', false);
  return `
    <div class="hub-card" style="padding: var(--sp-4);">
      <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">Freight Index by Market</h3>
      <p class="text-body text-muted" style="margin-bottom: var(--sp-3);">Normalized freight cost index (baseline = 100). Higher values indicate more expensive freight lanes.</p>
      <div style="max-height: 450px; overflow-y: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead><tr style="border-bottom: 2px solid var(--ies-gray-200); position: sticky; top: 0; background: #fff;">
            <th style="padding: 6px 8px; text-align:left;">Market</th>
            <th style="padding: 6px 8px;">Freight Index</th>
            <th style="padding: 6px 8px;">Region</th>
            <th style="padding: 6px 8px;">Verticals</th>
          </tr></thead>
          <tbody>
            ${sorted.map(m => {
              const barW = Math.round(m.freightIndex * 0.8);
              const barColor = m.freightIndex >= 100 ? 'var(--ies-red)' : m.freightIndex >= 90 ? 'var(--ies-orange)' : 'var(--ies-green)';
              return `
                <tr style="border-bottom: 1px solid var(--ies-gray-100); cursor: pointer;" data-market-row="${m.id}">
                  <td style="padding: 6px 8px; font-weight: 600;">${m.name}</td>
                  <td style="padding: 6px 8px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                      <div style="width:${barW}px;height:16px;background:${barColor};border-radius:3px;"></div>
                      <span style="font-weight:600;">${m.freightIndex}</span>
                    </div>
                  </td>
                  <td style="padding: 6px 8px; text-align: center;">${m.region}</td>
                  <td style="padding: 6px 8px;">${m.verticals.join(', ')}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderDataLibrary(filtered) {
  return `
    <div class="hub-card" style="padding: var(--sp-4);">
      <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">Complete Data Library — ${filtered.length} Markets</h3>
      <div style="overflow-x: auto; max-height: 500px; overflow-y: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; min-width: 900px;">
          <thead><tr style="border-bottom: 2px solid var(--ies-gray-200); position: sticky; top: 0; background: #fff;">
            <th style="padding: 4px 6px; text-align:left;">Market</th>
            <th style="padding: 4px 6px;">Region</th>
            <th style="padding: 4px 6px;">Labor Score</th>
            <th style="padding: 4px 6px;">Avg Wage</th>
            <th style="padding: 4px 6px;">Unemployment</th>
            <th style="padding: 4px 6px;">$/sqft/yr</th>
            <th style="padding: 4px 6px;">Availability %</th>
            <th style="padding: 4px 6px;">Freight Idx</th>
            <th style="padding: 4px 6px;">Active Deals</th>
            <th style="padding: 4px 6px;">Verticals</th>
            <th style="padding: 4px 6px;">Presence</th>
          </tr></thead>
          <tbody>
            ${filtered.map(m => `
              <tr style="border-bottom: 1px solid var(--ies-gray-100); cursor: pointer;" data-market-row="${m.id}">
                <td style="padding: 4px 6px; font-weight: 600;">${m.name}</td>
                <td style="padding: 4px 6px;">${m.region}</td>
                <td style="padding: 4px 6px; text-align:center;">${calc.scoreBadge(m.laborScore)}</td>
                <td style="padding: 4px 6px; text-align:center;">${calc.fmt$(m.avgWage)}</td>
                <td style="padding: 4px 6px; text-align:center;">${calc.fmtPct(m.unemploymentRate)}</td>
                <td style="padding: 4px 6px; text-align:center;">${calc.fmt$(m.warehouseRate)}</td>
                <td style="padding: 4px 6px; text-align:center;">${calc.fmtPct(m.availabilityPct)}</td>
                <td style="padding: 4px 6px; text-align:center;">${m.freightIndex}</td>
                <td style="padding: 4px 6px; text-align:center;">${m.activeDeals}</td>
                <td style="padding: 4px 6px;">${m.verticals.join(', ')}</td>
                <td style="padding: 4px 6px;">${calc.presenceBadge(m.gxoPresence)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================
// DETAIL PANEL — 5-TAB MARKET INTELLIGENCE
// ============================================================

function renderDetailPanel(m) {
  return `
    <div class="hub-card" style="padding: var(--sp-4); border: none; box-shadow: none; border-radius: 0;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--sp-4);">
        <div>
          <h2 class="text-subtitle" style="margin: 0;">${m.name}</h2>
          <div class="text-caption text-muted" style="margin-top: 4px;">${m.region}</div>
        </div>
        <button class="hub-btn hub-btn-secondary" data-action="close-detail" style="font-size: 12px; padding: 4px 12px;">Close</button>
      </div>

      <!-- 5-Tab Navigation -->
      <div class="hub-tab-bar" style="margin-bottom: var(--sp-4); margin-left: -var(--sp-5); margin-right: -var(--sp-5); padding-left: var(--sp-5); padding-right: var(--sp-5); border-bottom: 1px solid var(--ies-gray-200); padding-bottom: 0;">
        <button class="hub-tab ${detailTabActive === 'overview' ? 'active' : ''}" data-detail-tab="overview">Overview</button>
        <button class="hub-tab ${detailTabActive === 'labor' ? 'active' : ''}" data-detail-tab="labor">Labor</button>
        <button class="hub-tab ${detailTabActive === 'facility' ? 'active' : ''}" data-detail-tab="facility">Facility</button>
        <button class="hub-tab ${detailTabActive === 'logistics' ? 'active' : ''}" data-detail-tab="logistics">Logistics</button>
        <button class="hub-tab ${detailTabActive === 'intelligence' ? 'active' : ''}" data-detail-tab="intelligence">Intelligence</button>
      </div>

      <!-- Tab Content -->
      <div id="market-detail-tabs" style="margin-top: var(--sp-4);">
        ${renderDetailTab(m)}
      </div>
    </div>
  `;
}

function renderDetailTab(m) {
  switch (detailTabActive) {
    case 'overview':
      return `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-4);">
          <div>
            <div class="text-caption text-muted">Labor Availability Score</div>
            <div class="text-subtitle" style="color: ${m.laborScore >= 70 ? 'var(--ies-green)' : m.laborScore >= 50 ? 'var(--ies-orange)' : 'var(--ies-red)'};">${m.laborScore}/100</div>
          </div>
          <div>
            <div class="text-caption text-muted">Avg Warehouse Wage</div>
            <div class="text-subtitle">${calc.fmt$(m.avgWage)}/hr</div>
          </div>
          <div>
            <div class="text-caption text-muted">Industrial Lease Rate</div>
            <div class="text-subtitle">${calc.fmt$(m.warehouseRate)}/sqft/yr</div>
          </div>
          <div>
            <div class="text-caption text-muted">Facility Vacancy</div>
            <div class="text-subtitle">${calc.fmtPct(m.availabilityPct)}</div>
          </div>
          <div>
            <div class="text-caption text-muted">GXO Presence</div>
            <div class="text-subtitle">${calc.presenceBadge(m.gxoPresence)}</div>
          </div>
          <div>
            <div class="text-caption text-muted">Active Deals</div>
            <div class="text-subtitle">${m.activeDeals}</div>
          </div>
        </div>
        <div style="margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--ies-gray-200);">
          <div class="text-caption text-muted" style="margin-bottom: 4px;">Primary Verticals</div>
          <div class="text-body">${m.verticals.join(', ')}</div>
        </div>
      `;

    case 'labor':
      return `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-4);">
          <div>
            <div class="text-caption text-muted">Labor Availability Score</div>
            <div class="text-subtitle" style="color: ${m.laborScore >= 70 ? 'var(--ies-green)' : m.laborScore >= 50 ? 'var(--ies-orange)' : 'var(--ies-red)'};">${m.laborScore}/100</div>
          </div>
          <div>
            <div class="text-caption text-muted">Warehouse Worker Wage</div>
            <div class="text-subtitle">${calc.fmt$(m.avgWage)}/hr</div>
          </div>
          <div>
            <div class="text-caption text-muted">Labor Tightness Score</div>
            <div class="text-subtitle">${Math.round(m.laborScore * 0.85)}%</div>
          </div>
          <div>
            <div class="text-caption text-muted">Unemployment Rate</div>
            <div class="text-subtitle">${calc.fmtPct(m.unemploymentRate)}</div>
          </div>
          <div>
            <div class="text-caption text-muted">Supervisor Wage (est.)</div>
            <div class="text-subtitle">${calc.fmt$(m.avgWage * 1.35)}/hr</div>
          </div>
          <div>
            <div class="text-caption text-muted">Manager Wage (est.)</div>
            <div class="text-subtitle">${calc.fmt$(m.avgWage * 1.65)}/hr</div>
          </div>
        </div>
      `;

    case 'facility':
      return `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-4);">
          <div>
            <div class="text-caption text-muted">Avg Lease Rate</div>
            <div class="text-subtitle">${calc.fmt$(m.warehouseRate)}/sqft/yr</div>
          </div>
          <div>
            <div class="text-caption text-muted">Industrial Vacancy</div>
            <div class="text-subtitle">${calc.fmtPct(m.availabilityPct)}</div>
          </div>
          <div>
            <div class="text-caption text-muted">New Construction Pipeline</div>
            <div class="text-subtitle">${Math.round(m.warehouseRate * 2.5)} sq ft</div>
          </div>
          <div>
            <div class="text-caption text-muted">Facility Types Available</div>
            <div class="text-body" style="font-size: 13px;">Multi-tenant, Single-tenant, Class A/B</div>
          </div>
        </div>
      `;

    case 'logistics':
      return `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-4);">
          <div>
            <div class="text-caption text-muted">Interstate Access</div>
            <div class="text-body" style="font-size: 13px;">Direct Access</div>
          </div>
          <div>
            <div class="text-caption text-muted">Airport Proximity</div>
            <div class="text-body" style="font-size: 13px;">${Math.round(Math.random() * 30) + 10} miles</div>
          </div>
          <div>
            <div class="text-caption text-muted">Port Proximity</div>
            <div class="text-body" style="font-size: 13px;">${Math.round(Math.random() * 200) + 100} miles</div>
          </div>
          <div>
            <div class="text-caption text-muted">Rail Access</div>
            <div class="text-body" style="font-size: 13px;">Available</div>
          </div>
          <div>
            <div class="text-caption text-muted">Freight Index</div>
            <div class="text-subtitle">${m.freightIndex}</div>
          </div>
          <div>
            <div class="text-caption text-muted">Major Carriers</div>
            <div class="text-body" style="font-size: 13px;">10+ carriers present</div>
          </div>
        </div>
      `;

    case 'intelligence':
      return renderIntelligencePanel(m);

    default:
      return '';
  }
}

// ============================================================
// PER-MARKET INTELLIGENCE
// ============================================================

/** Lazy-fetch signals for a market. Caches the result for 5 minutes. */
async function loadIntelligenceIfNeeded(market) {
  const id = market?.id;
  if (!id) return;
  const cached = marketSignalCache.get(id);
  if (cached && (Date.now() - cached.fetchedAt) < 5 * 60 * 1000) return;

  // Show a loading state
  marketSignalCache.set(id, { news: [], alerts: [], fetchedAt: Date.now(), loading: true });
  renderDetailContent();

  try {
    const signals = await api.fetchMarketSignals(market);
    marketSignalCache.set(id, { ...signals, fetchedAt: Date.now(), loading: false });
  } catch (err) {
    marketSignalCache.set(id, { news: [], alerts: [], fetchedAt: Date.now(), loading: false, error: err.message });
  }
  // Only re-render if we're still looking at Intelligence for the same market
  if (selectedMarket?.id === id && detailTabActive === 'intelligence') {
    renderDetailContent();
  }
}

/** Render the Intelligence tab — real signals fuzzy-matched to market name/state. */
function renderIntelligencePanel(m) {
  const cache = marketSignalCache.get(m.id);
  const loading = cache?.loading;
  const news = cache?.news || [];
  const alerts = cache?.alerts || [];
  const hasSignals = news.length > 0 || alerts.length > 0;
  const footnote = `Signals matched by headline/summary containing "${(m.name || '').split(/[-,/]/)[0].trim()}" or "${m.state || ''}". Some may be tangential — no market_id column exists on these tables yet.`;

  if (loading) {
    return `
      <div style="padding: var(--sp-4); text-align:center; color:var(--ies-gray-400); font-size:13px;">
        Loading recent signals for ${m.name}…
      </div>
    `;
  }

  if (!hasSignals) {
    return `
      <div>
        <div class="text-caption text-muted" style="margin-bottom: var(--sp-3);">Recent Market Signals</div>
        <div style="border: 1px dashed var(--ies-gray-200); border-radius: var(--radius-md); padding: var(--sp-4); background: var(--ies-gray-50); text-align:center;">
          <div style="font-size: 13px; color: var(--ies-gray-500); margin-bottom:6px;">No recent signals found for ${m.name}.</div>
          <div style="font-size: 11px; color: var(--ies-gray-400);">Industry-wide signals are available on the Command Center.</div>
        </div>
      </div>
    `;
  }

  return `
    <div>
      ${alerts.length > 0 ? `
        <div class="text-caption text-muted" style="margin-bottom: var(--sp-2);">Active Alerts (${alerts.length})</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom: var(--sp-4);">
          ${alerts.map(a => `
            <div style="padding:10px 12px;background:var(--ies-gray-50);border:1px solid var(--ies-gray-200);border-radius:6px;font-size:12px;">
              <div style="font-weight:700;color:var(--ies-gray-700);margin-bottom:3px;">${a.title}</div>
              ${a.summary ? `<div style="color:var(--ies-gray-500);line-height:1.4;">${a.summary}</div>` : ''}
              <div style="display:flex;gap:8px;margin-top:4px;font-size:10px;color:var(--ies-gray-400);">
                ${a.source ? `<span>${a.source}</span>` : ''}
                <span>${formatDateShort(a.created_at)}</span>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${news.length > 0 ? `
        <div class="text-caption text-muted" style="margin-bottom: var(--sp-2);">Competitor & Industry News (${news.length})</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom: var(--sp-3);">
          ${news.map(n => `
            <div style="padding:10px 12px;background:#fff;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:12px;">
              <div style="font-weight:600;color:var(--ies-gray-700);margin-bottom:3px;">
                ${n.source_url ? `<a href="${n.source_url}" target="_blank" rel="noopener" class="me-news-link">${n.headline} ↗</a>` : n.headline}
              </div>
              ${n.summary ? `<div style="color:var(--ies-gray-500);line-height:1.4;">${n.summary}</div>` : ''}
              <div style="display:flex;gap:8px;margin-top:4px;font-size:10px;color:var(--ies-gray-400);">
                ${n.competitor ? `<span style="font-weight:600;">${n.competitor}</span>` : ''}
                ${n.source ? `<span>${n.source}</span>` : ''}
                <span>${formatDateShort(n.published_date || n.created_at)}</span>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div style="margin-top: var(--sp-3); font-size: 10px; color: var(--ies-gray-400); font-style: italic; line-height:1.5;">
        ${footnote}
      </div>
    </div>
  `;
}

function formatDateShort(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor((now - d) / (86400000));
    if (diffDays < 1) return 'Today';
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// ============================================================
// LEAFLET MAP INITIALIZATION
// ============================================================

/**
 * Ensure Leaflet is loaded, inject if needed.
 */
function ensureLeafletLoaded() {
  if (typeof window.L !== 'undefined') {
    leafletLoaded = true;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    // Inject Leaflet CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);

    // Inject Leaflet JS
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => {
      leafletLoaded = true;
      resolve();
    };
    script.onerror = () => {
      console.error('Failed to load Leaflet');
      resolve();
    };
    document.head.appendChild(script);
  });
}

/**
 * Initialize the Leaflet map and add market markers.
 */
function initializeMap(filtered) {
  if (!rootEl || !leafletLoaded || typeof window.L === 'undefined') {
    console.warn('Map init: Leaflet not ready or rootEl missing');
    return;
  }

  const mapContainer = rootEl.querySelector('#market-map');
  if (!mapContainer) return;

  // Clear any existing map
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  try {
    // Create map instance
    mapInstance = window.L.map(mapContainer, {
      center: [39.8, -98.6],
      zoom: 4,
      minZoom: 3,
      maxZoom: 8,
      zoomControl: true,
      attributionControl: false,
      tap: false,
    });

    // Add OpenStreetMap tiles
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: 'Map data © OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(mapInstance);

    // 2026-04-29 redesign: pin color comes from colorMode (Labor / Real Estate /
    // Freight / GXO heat). Pin click opens the slide-in detail panel — no full
    // re-render so the map state is preserved.
    const sorted = _sortFilteredByMode(filtered);
    const metric = _COLOR_MODES.find(x => x.key === colorMode)?.metric || 'gxo';
    filtered.forEach(m => {
      const color = _pinColorFor(m, metric, sorted);
      const radius = 6 + (m.laborScore / 20);

      const marker = window.L.circleMarker([m.lat, m.lng], {
        radius: radius,
        fillColor: color,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.85,
        className: 'market-map-pin',
      }).addTo(mapInstance);

      marker.bindTooltip(`<strong>${m.name}</strong><br>Labor: ${m.laborScore}/100 · Wage: ${calc.fmt$(m.avgWage || 0)}/hr`, {
        direction: 'top',
        offset: [0, -10],
        className: 'market-tooltip',
      });

      marker.on('click', () => _openDetail(m));
      m._marker = marker;
    });

    // Force map to resize after container is visible
    setTimeout(() => {
      if (mapInstance) mapInstance.invalidateSize();
    }, 100);
  } catch (e) {
    console.error('Map initialization error:', e);
    mapContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--ies-red);">Map error: ${e.message}</div>`;
  }
}

/**
 * Highlight a market on the map and pan to it.
 */
function highlightMarketOnMap(marketId) {
  if (!mapInstance || !marketId) return;

  const market = markets.find(m => m.id === marketId);
  if (!market || !market._marker) return;

  try {
    mapInstance.setView([market.lat, market.lng], 5);
    market._marker.openPopup();
  } catch (e) {
    console.warn('Error highlighting marker:', e);
  }
}

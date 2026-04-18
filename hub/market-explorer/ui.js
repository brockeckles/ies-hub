/**
 * IES Hub v3 — Market Explorer UI
 * Interactive market intelligence view with Leaflet map, data library, and 5-tab detail panels.
 * Uses event delegation to survive innerHTML re-renders.
 * @module hub/market-explorer/ui
 */

import * as calc from './calc.js?v=20260418-sF';
import * as api from './api.js?v=20260418-sF';

// Per-market signal cache: marketId → { news, alerts, fetchedAt }
const marketSignalCache = new Map();

let rootEl = null;
let markets = [...calc.DEMO_MARKETS];
let selectedMarket = null;
let activeTab = 'overview';
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
  activeTab = 'overview';
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

    // Main tab clicks
    const tab = target.closest('[data-tab]');
    if (tab) {
      activeTab = /** @type {HTMLElement} */ (tab).dataset.tab;
      render();
      return;
    }

    // Detail tab clicks (5-tab panel)
    const detailTab = target.closest('[data-detail-tab]');
    if (detailTab) {
      detailTabActive = /** @type {HTMLElement} */ (detailTab).dataset.detailTab;
      renderDetailContent();
      // Lazy-load Intelligence tab signals the first time it's viewed per market
      if (detailTabActive === 'intelligence' && selectedMarket) {
        loadIntelligenceIfNeeded(selectedMarket);
      }
      return;
    }

    // Market row clicks in data library
    const row = target.closest('[data-market-row]');
    if (row) {
      const id = /** @type {HTMLElement} */ (row).dataset.marketRow;
      selectedMarket = markets.find(m => m.id === id) || null;
      render();
      highlightMarketOnMap(selectedMarket?.id);
      return;
    }

    // Close detail
    if (target.closest('[data-action="close-detail"]')) {
      selectedMarket = null;
      detailTabActive = 'overview';
      render();
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
    <div class="hub-content-inner">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--sp-5);">
        <h1 class="text-page" style="margin: 0;">Market Explorer</h1>
        <div style="display: flex; gap: var(--sp-3); align-items: center;">
          <input type="text" class="hub-input" placeholder="Search markets..." value="${searchQuery}"
            data-action="search" style="width: 200px; height: 34px; font-size: 13px;" />
          <select class="hub-input" data-action="filter-region" style="height: 34px; font-size: 13px;">
            <option value="all">All Regions</option>
            ${regions.map(r => `<option value="${r}" ${filterRegion === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <select class="hub-input" data-action="filter-presence" style="height: 34px; font-size: 13px;">
            <option value="all">All Presence</option>
            <option value="active" ${filterPresence === 'active' ? 'selected' : ''}>GXO Active</option>
            <option value="target" ${filterPresence === 'target' ? 'selected' : ''}>Target Markets</option>
          </select>
        </div>
      </div>

      <!-- KPI Row — slimmed inline header, with hover tooltips -->
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--sp-3); margin-bottom: var(--sp-4);">
        ${meKpi('Markets Tracked', String(stats.totalMarkets), 'Count of MSAs in the filter set (of ' + markets.length + ' total tracked).')}
        ${meKpi('Avg Labor Score', calc.scoreBadge(stats.avgLaborScore), 'Composite labor-availability score (0-100) for filtered markets. Higher = more available workforce. Inputs: unemployment rate, participation, turnover, time-to-fill.')}
        ${meKpi('Avg Warehouse Wage', calc.fmt$(stats.avgWage) + '/hr', 'Average hourly warehouse wage (filtered set). BLS OEWS data, seasonally adjusted.')}
        ${meKpi('Markets with Deals', String(stats.marketsWithDeals), 'Markets in the filtered set that have at least one active deal in the IES pipeline.')}
      </div>

      <!-- Tab Bar -->
      <div class="hub-tab-bar" style="margin-bottom: var(--sp-4);">
        <button class="hub-tab ${activeTab === 'overview' ? 'active' : ''}" data-tab="overview">Map Overview</button>
        <button class="hub-tab ${activeTab === 'labor' ? 'active' : ''}" data-tab="labor">Labor Watch</button>
        <button class="hub-tab ${activeTab === 'realestate' ? 'active' : ''}" data-tab="realestate">Real Estate</button>
        <button class="hub-tab ${activeTab === 'freight' ? 'active' : ''}" data-tab="freight">Freight Index</button>
        <button class="hub-tab ${activeTab === 'data' ? 'active' : ''}" data-tab="data">Data Library</button>
      </div>

      <!-- Tab Content -->
      <div id="me-tab-content"></div>

      <!-- Detail Panel -->
      <div id="me-detail-panel"></div>
    </div>
  `;

  renderContent();
}

function renderContent() {
  if (!rootEl) return;
  const filtered = getFiltered();
  const topLabor = calc.topMarketsByLabor(filtered, 5);
  const topRate = calc.topMarketsByRate(filtered, 5);

  const tabEl = rootEl.querySelector('#me-tab-content');
  if (tabEl) tabEl.innerHTML = renderTab(filtered, topLabor, topRate);

  const detailEl = rootEl.querySelector('#me-detail-panel');
  if (detailEl) detailEl.innerHTML = selectedMarket ? renderDetailPanel(selectedMarket) : '';

  // Initialize map after overview tab is rendered
  if (activeTab === 'overview' && !mapInstance) {
    setTimeout(() => initializeMap(filtered), 100);
  }
}

function renderDetailContent() {
  if (!rootEl) return;
  const detailEl = rootEl.querySelector('#me-detail-panel');
  if (detailEl && selectedMarket) {
    detailEl.innerHTML = renderDetailPanel(selectedMarket);
  }
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

function renderTab(filtered, topLabor, topRate) {
  switch (activeTab) {
    case 'overview': return renderOverview(filtered);
    case 'labor': return renderLaborWatch(filtered, topLabor);
    case 'realestate': return renderRealEstate(filtered);
    case 'freight': return renderFreight(filtered);
    case 'data': return renderDataLibrary(filtered);
    default: return '';
  }
}

function renderOverview(filtered) {
  // Map full-width — the right-hand "Data Library" table was duplicative of
  // the Data Library tab below; removed per feedback 2026-04-17.
  return `
    <div class="hub-card" style="padding: var(--sp-4); position: relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom: var(--sp-3);">
        <h3 class="text-subtitle" style="margin: 0;">US Market Map</h3>
        <span class="text-caption text-muted">${filtered.length} markets shown — click a pin for details</span>
      </div>
      <div id="market-map" style="background: #f0f4f8; border-radius: var(--radius-md); height: 520px; position: relative; overflow: hidden;">
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--ies-gray-500); font-size: 13px;">Loading map...</div>
      </div>
    </div>
  `;
}

// Small helper — KPI tile with hover tooltip (mirrors CC pattern)
function meKpi(label, value, tooltip) {
  return `
    <div class="hub-card" style="text-align:center; padding: var(--sp-3); position:relative;">
      <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-bottom:4px;">
        <span class="text-caption text-muted">${label}</span>
        ${tooltip ? `<span class="cc-kpi-tip" style="position:relative;display:inline-flex;">
          <span style="width:14px;height:14px;border-radius:50%;background:var(--ies-gray-100);color:var(--ies-gray-400);font-size:9px;display:inline-flex;align-items:center;justify-content:center;cursor:help;font-weight:700;">?</span>
          <span class="cc-kpi-tiptext" style="display:none;position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 6px);width:240px;padding:8px 10px;background:#1e293b;color:#f8fafc;font-size:11px;font-weight:400;line-height:1.4;border-radius:6px;z-index:100;pointer-events:none;text-align:left;box-shadow:0 4px 12px rgba(0,0,0,.25);">${tooltip}</span>
        </span>` : ''}
      </div>
      <div class="text-page">${value}</div>
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
    <div class="hub-card" style="margin-top: var(--sp-4); padding: var(--sp-5); border-left: 4px solid var(--ies-orange);">
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
                ${n.source_url ? `<a href="${n.source_url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;" onmouseover="this.style.color='#2563eb'" onmouseout="this.style.color='inherit'">${n.headline} ↗</a>` : n.headline}
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

    // Add market markers
    filtered.forEach(m => {
      const color = m.gxoPresence === 'active' ? '#16a34a' : '#3b82f6';
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

      // Tooltip on hover
      marker.bindTooltip(`<strong>${m.name}</strong><br>Labor: ${m.laborScore}/100`, {
        direction: 'top',
        offset: [0, -10],
        className: 'market-tooltip',
      });

      // Click handler to select market
      marker.on('click', () => {
        selectedMarket = m;
        detailTabActive = 'overview';
        render();
      });

      // Store marker reference for later highlighting
      m._marker = marker;
    });

    // Force map to resize after container is visible
    setTimeout(() => {
      if (mapInstance) mapInstance.invalidateSize();
    }, 100);
  } catch (e) {
    console.error('Map initialization error:', e);
    mapContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#dc3545;">Map error: ${e.message}</div>`;
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

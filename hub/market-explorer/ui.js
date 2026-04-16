/**
 * IES Hub v3 — Market Explorer UI
 * Interactive market intelligence view with map, data library, and detail panels.
 * @module hub/market-explorer/ui
 */

import * as calc from './calc.js';

let rootEl = null;
let markets = [...calc.DEMO_MARKETS];
let selectedMarket = null;
let activeTab = 'overview'; // overview | labor | realestate | freight | data
let filterRegion = 'all';
let filterPresence = 'all';
let searchQuery = '';

// ============================================================
// MOUNT / UNMOUNT
// ============================================================

export function mount(el) {
  rootEl = el;
  markets = [...calc.DEMO_MARKETS];
  selectedMarket = null;
  activeTab = 'overview';
  filterRegion = 'all';
  filterPresence = 'all';
  searchQuery = '';
  render();
}

export function unmount() {
  rootEl = null;
  selectedMarket = null;
}

// ============================================================
// RENDER
// ============================================================

function render() {
  if (!rootEl) return;

  let filtered = calc.filterByRegion(markets, filterRegion);
  filtered = calc.filterByPresence(filtered, filterPresence);
  filtered = calc.searchMarkets(filtered, searchQuery);
  const stats = calc.computeStats(filtered);
  const regions = calc.uniqueRegions(markets);
  const topLabor = calc.topMarketsByLabor(filtered, 5);
  const topRate = calc.topMarketsByRate(filtered, 5);

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

      <!-- KPI Row -->
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--sp-4); margin-bottom: var(--sp-5);">
        <div class="hub-card" style="text-align: center; padding: var(--sp-4);">
          <div class="text-caption text-muted" style="margin-bottom: 4px;">Markets Tracked</div>
          <div class="text-page">${stats.totalMarkets}</div>
        </div>
        <div class="hub-card" style="text-align: center; padding: var(--sp-4);">
          <div class="text-caption text-muted" style="margin-bottom: 4px;">Avg Labor Score</div>
          <div class="text-page">${calc.scoreBadge(stats.avgLaborScore)}</div>
        </div>
        <div class="hub-card" style="text-align: center; padding: var(--sp-4);">
          <div class="text-caption text-muted" style="margin-bottom: 4px;">Avg Warehouse Wage</div>
          <div class="text-page">${calc.fmt$(stats.avgWage)}/hr</div>
        </div>
        <div class="hub-card" style="text-align: center; padding: var(--sp-4);">
          <div class="text-caption text-muted" style="margin-bottom: 4px;">Markets with Deals</div>
          <div class="text-page">${stats.marketsWithDeals}</div>
        </div>
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
      ${renderTab(filtered, topLabor, topRate)}

      ${selectedMarket ? renderDetailPanel(selectedMarket) : ''}
    </div>
  `;

  wireEvents();
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
  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4);">
      <!-- Map Placeholder + Market Grid -->
      <div class="hub-card" style="padding: var(--sp-4); min-height: 350px;">
        <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">US Market Map</h3>
        <div style="background: var(--ies-gray-100); border-radius: var(--radius-md); height: 300px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;">
          <!-- SVG US map outline with market dots -->
          <svg viewBox="0 0 960 600" style="width: 100%; height: 100%;">
            <rect width="960" height="600" fill="#f0f4f8" rx="8"/>
            <!-- Simplified US outline -->
            <path d="M200,200 L350,180 L500,170 L650,180 L750,200 L800,250 L780,350 L700,400 L600,420 L450,430 L300,400 L220,350 L180,280 Z" fill="#e2e8f0" stroke="#cbd5e0" stroke-width="2"/>
            <!-- Market dots -->
            ${filtered.map(m => {
              const x = ((m.lng + 130) / 70) * 800 + 80;
              const y = ((50 - m.lat) / 25) * 400 + 100;
              const color = m.gxoPresence === 'active' ? '#27ae60' : '#3498db';
              const r = 4 + (m.activeDeals * 2);
              return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="0.8" stroke="#fff" stroke-width="1.5" style="cursor:pointer;" data-market="${m.id}"/>`;
            }).join('')}
          </svg>
          <div style="position: absolute; bottom: 8px; right: 12px; display: flex; gap: 12px; font-size: 11px; color: #666;">
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#27ae60;margin-right:4px;"></span>GXO Active</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3498db;margin-right:4px;"></span>Target</span>
          </div>
        </div>
      </div>

      <!-- Market List -->
      <div class="hub-card" style="padding: var(--sp-4); max-height: 400px; overflow-y: auto;">
        <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">All Markets (${filtered.length})</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="border-bottom: 2px solid var(--ies-gray-200); text-align: left;">
              <th style="padding: 6px 8px;">Market</th>
              <th style="padding: 6px 8px;">Labor</th>
              <th style="padding: 6px 8px;">Wage</th>
              <th style="padding: 6px 8px;">$/sqft</th>
              <th style="padding: 6px 8px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(m => `
              <tr style="border-bottom: 1px solid var(--ies-gray-100); cursor: pointer;" data-market-row="${m.id}">
                <td style="padding: 6px 8px; font-weight: 600;">${m.name}</td>
                <td style="padding: 6px 8px;">${calc.scoreBadge(m.laborScore)}</td>
                <td style="padding: 6px 8px;">${calc.fmt$(m.avgWage)}</td>
                <td style="padding: 6px 8px;">${calc.fmt$(m.warehouseRate)}</td>
                <td style="padding: 6px 8px;">${calc.presenceBadge(m.gxoPresence)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
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
              <tr style="border-bottom: 1px solid var(--ies-gray-100);">
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
                <tr style="border-bottom: 1px solid var(--ies-gray-100);">
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
                <tr style="border-bottom: 1px solid var(--ies-gray-100);">
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
              <tr style="border-bottom: 1px solid var(--ies-gray-100);">
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
// DETAIL PANEL — shown when a market is selected
// ============================================================

function renderDetailPanel(m) {
  return `
    <div class="hub-card" style="margin-top: var(--sp-4); padding: var(--sp-5); border-left: 4px solid var(--ies-orange);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--sp-4);">
        <h2 class="text-subtitle">${m.name}</h2>
        <button class="hub-btn hub-btn-secondary" data-action="close-detail" style="font-size: 12px; padding: 4px 12px;">Close</button>
      </div>
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--sp-4);">
        <div>
          <div class="text-caption text-muted">Labor Availability</div>
          <div class="text-subtitle">${calc.scoreBadge(m.laborScore)} / 100</div>
        </div>
        <div>
          <div class="text-caption text-muted">Avg Warehouse Wage</div>
          <div class="text-subtitle">${calc.fmt$(m.avgWage)}/hr</div>
        </div>
        <div>
          <div class="text-caption text-muted">Industrial Rate</div>
          <div class="text-subtitle">${calc.fmt$(m.warehouseRate)}/sqft/yr</div>
        </div>
        <div>
          <div class="text-caption text-muted">Freight Index</div>
          <div class="text-subtitle">${m.freightIndex}</div>
        </div>
        <div>
          <div class="text-caption text-muted">Unemployment</div>
          <div class="text-subtitle">${calc.fmtPct(m.unemploymentRate)}</div>
        </div>
        <div>
          <div class="text-caption text-muted">Vacancy Rate</div>
          <div class="text-subtitle">${calc.fmtPct(m.availabilityPct)}</div>
        </div>
        <div>
          <div class="text-caption text-muted">Active Deals</div>
          <div class="text-subtitle">${m.activeDeals}</div>
        </div>
        <div>
          <div class="text-caption text-muted">GXO Presence</div>
          <div class="text-subtitle">${calc.presenceBadge(m.gxoPresence)}</div>
        </div>
      </div>
      <div style="margin-top: var(--sp-3);">
        <span class="text-caption text-muted">Region:</span> <span class="text-body">${m.region}</span>
        &nbsp;&nbsp;
        <span class="text-caption text-muted">Verticals:</span> <span class="text-body">${m.verticals.join(', ')}</span>
      </div>
    </div>
  `;
}

// ============================================================
// EVENTS
// ============================================================

function wireEvents() {
  if (!rootEl) return;

  // Search
  const searchInput = rootEl.querySelector('[data-action="search"]');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      render();
    });
  }

  // Filters
  rootEl.querySelector('[data-action="filter-region"]')?.addEventListener('change', (e) => {
    filterRegion = e.target.value;
    selectedMarket = null;
    render();
  });
  rootEl.querySelector('[data-action="filter-presence"]')?.addEventListener('change', (e) => {
    filterPresence = e.target.value;
    selectedMarket = null;
    render();
  });

  // Tabs
  rootEl.querySelectorAll('.hub-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      render();
    });
  });

  // Market row clicks
  rootEl.querySelectorAll('[data-market-row]').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.marketRow;
      selectedMarket = markets.find(m => m.id === id) || null;
      render();
    });
  });

  // SVG dot clicks
  rootEl.querySelectorAll('circle[data-market]').forEach(dot => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = dot.dataset.market;
      selectedMarket = markets.find(m => m.id === id) || null;
      render();
    });
  });

  // Close detail
  rootEl.querySelector('[data-action="close-detail"]')?.addEventListener('click', () => {
    selectedMarket = null;
    render();
  });
}

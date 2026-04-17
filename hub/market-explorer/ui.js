/**
 * IES Hub v3 — Market Explorer UI
 * Interactive market intelligence view with US map, data library, and detail panels.
 * Uses event delegation to survive innerHTML re-renders.
 * @module hub/market-explorer/ui
 */

import * as calc from './calc.js';

let rootEl = null;
let markets = [...calc.DEMO_MARKETS];
let selectedMarket = null;
let activeTab = 'overview';
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
  bindDelegatedEvents();
}

export function unmount() {
  rootEl = null;
  selectedMarket = null;
}

// ============================================================
// EVENT DELEGATION — survives innerHTML re-renders
// ============================================================

function bindDelegatedEvents() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Tab clicks
    const tab = target.closest('[data-tab]');
    if (tab) {
      activeTab = /** @type {HTMLElement} */ (tab).dataset.tab;
      render();
      return;
    }

    // Market row clicks
    const row = target.closest('[data-market-row]');
    if (row) {
      const id = /** @type {HTMLElement} */ (row).dataset.marketRow;
      selectedMarket = markets.find(m => m.id === id) || null;
      render();
      return;
    }

    // SVG dot clicks
    const dot = target.closest('circle[data-market]');
    if (dot) {
      e.stopPropagation();
      const id = dot.getAttribute('data-market');
      selectedMarket = markets.find(m => m.id === id) || null;
      render();
      return;
    }

    // Close detail
    if (target.closest('[data-action="close-detail"]')) {
      selectedMarket = null;
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
  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4);">
      <!-- US Map -->
      <div class="hub-card" style="padding: var(--sp-4); min-height: 350px;">
        <h3 class="text-subtitle" style="margin-bottom: var(--sp-3);">US Market Map</h3>
        <div style="background: #f8fafc; border-radius: var(--radius-md); height: 320px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;">
          <svg viewBox="0 0 960 600" style="width: 100%; height: 100%;">
            <rect width="960" height="600" fill="#f8fafc" rx="8"/>
            <!-- Simplified US Continental outline -->
            <path d="${US_OUTLINE_PATH}" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.5" stroke-linejoin="round"/>
            <!-- State border hints -->
            ${US_STATE_BORDERS}
            <!-- Market dots -->
            ${filtered.map(m => {
              const pos = latLngToSvg(m.lat, m.lng);
              const color = m.gxoPresence === 'active' ? '#16a34a' : '#3b82f6';
              const r = 5 + (m.activeDeals * 1.5);
              return `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="${color}" opacity="0.85" stroke="#fff" stroke-width="1.5" style="cursor:pointer;" data-market="${m.id}"/>`;
            }).join('')}
            <!-- Labels for major markets -->
            ${filtered.filter(m => m.activeDeals >= 2 || m.gxoPresence === 'active').slice(0, 10).map(m => {
              const pos = latLngToSvg(m.lat, m.lng);
              return `<text x="${pos.x}" y="${pos.y - 10}" text-anchor="middle" font-size="9" font-weight="600" fill="#475569">${m.name.split(',')[0]}</text>`;
            }).join('')}
          </svg>
          <div style="position: absolute; bottom: 8px; right: 12px; display: flex; gap: 12px; font-size: 11px; color: #666;">
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#16a34a;margin-right:4px;"></span>GXO Active</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3b82f6;margin-right:4px;"></span>Target</span>
          </div>
        </div>
      </div>

      <!-- Market List -->
      <div class="hub-card" style="padding: var(--sp-4); max-height: 420px; overflow-y: auto;">
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
              <tr style="border-bottom: 1px solid var(--ies-gray-100); cursor: pointer;" data-market-row="${m.id}" onmouseover="this.style.background='var(--ies-gray-50)'" onmouseout="this.style.background='transparent'">
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
// DETAIL PANEL
// ============================================================

function renderDetailPanel(m) {
  return `
    <div class="hub-card" style="margin-top: var(--sp-4); padding: var(--sp-5); border-left: 4px solid var(--ies-orange);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--sp-4);">
        <h2 class="text-subtitle">${m.name}</h2>
        <button class="hub-btn hub-btn-secondary" data-action="close-detail" style="font-size: 12px; padding: 4px 12px;">Close</button>
      </div>
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--sp-4);">
        <div><div class="text-caption text-muted">Labor Availability</div><div class="text-subtitle">${calc.scoreBadge(m.laborScore)} / 100</div></div>
        <div><div class="text-caption text-muted">Avg Warehouse Wage</div><div class="text-subtitle">${calc.fmt$(m.avgWage)}/hr</div></div>
        <div><div class="text-caption text-muted">Industrial Rate</div><div class="text-subtitle">${calc.fmt$(m.warehouseRate)}/sqft/yr</div></div>
        <div><div class="text-caption text-muted">Freight Index</div><div class="text-subtitle">${m.freightIndex}</div></div>
        <div><div class="text-caption text-muted">Unemployment</div><div class="text-subtitle">${calc.fmtPct(m.unemploymentRate)}</div></div>
        <div><div class="text-caption text-muted">Vacancy Rate</div><div class="text-subtitle">${calc.fmtPct(m.availabilityPct)}</div></div>
        <div><div class="text-caption text-muted">Active Deals</div><div class="text-subtitle">${m.activeDeals}</div></div>
        <div><div class="text-caption text-muted">GXO Presence</div><div class="text-subtitle">${calc.presenceBadge(m.gxoPresence)}</div></div>
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
// US MAP GEOMETRY
// ============================================================

/**
 * Convert lat/lng to SVG coordinates for the 960x600 viewBox.
 * Uses Albers-like projection approximation for continental US.
 */
function latLngToSvg(lat, lng) {
  // Continental US bounds: lat 24.5-49.5, lng -125 to -66.5
  const x = ((lng + 125) / (125 - 66.5)) * 820 + 70;
  const y = ((49.5 - lat) / (49.5 - 24.5)) * 480 + 60;
  return { x: Math.round(x), y: Math.round(y) };
}

// Simplified continental US outline path
const US_OUTLINE_PATH = `
M 120,130 L 135,128 155,125 180,122 210,118 240,115 270,112 310,108
L 340,105 370,103 400,102 430,102 460,103 490,105 520,108
L 545,112 565,118 580,125 590,118 600,115 620,110 640,108
L 660,110 680,115 695,120 710,118 725,115 740,112 760,110
L 780,112 800,118 815,125 825,135 830,145
L 835,160 838,175 835,190 830,205 825,220 820,235 818,250
L 820,265 825,280 830,295 835,310 832,325 825,340
L 818,355 810,365 800,375 790,382 775,388 760,392 745,395
L 730,398 718,400 705,398 695,392 688,385 680,378
L 670,372 658,368 645,365 630,362 615,360
L 600,358 585,355 570,350 555,345 540,340 525,335
L 510,332 495,330 480,328 465,325 450,322 435,320
L 418,318 400,320 385,325 370,332 355,340 340,348
L 325,355 310,362 295,368 280,372 265,375 250,378
L 235,382 220,388 205,395 190,402 175,408 160,412
L 145,415 130,418 120,420 112,425 105,432 100,440
L 95,448 92,455 90,462 88,468 85,472
L 82,465 80,455 78,445 76,435 75,425 74,415
L 72,405 70,395 68,385 66,372 65,358 66,345
L 68,332 72,318 78,305 85,292 90,280 95,268
L 100,255 105,242 108,228 110,215 112,200
L 115,185 118,170 120,155 120,142 120,130
Z
`;

// Minimal state boundary hints (major region separators)
const US_STATE_BORDERS = `
<path d="M 420,102 L 420,320" stroke="#cbd5e1" stroke-width="0.5" fill="none" opacity="0.4"/>
<path d="M 560,108 L 560,350" stroke="#cbd5e1" stroke-width="0.5" fill="none" opacity="0.4"/>
<path d="M 680,110 L 680,378" stroke="#cbd5e1" stroke-width="0.5" fill="none" opacity="0.4"/>
<path d="M 120,250 L 830,250" stroke="#cbd5e1" stroke-width="0.5" fill="none" opacity="0.4"/>
`;

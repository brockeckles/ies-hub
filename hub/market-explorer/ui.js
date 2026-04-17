/**
 * IES Hub v3 — Market Explorer UI
 * Interactive market intelligence view with US map, data library, and detail panels.
 * Uses event delegation to survive innerHTML re-renders.
 * @module hub/market-explorer/ui
 */

import * as calc from './calc.js?v=20260417-s1';

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

// Detailed continental US outline path (realistic coastline)
const US_OUTLINE_PATH = `
M 130,110 L 137,109 145,108 155,107 168,105 182,103 200,101 220,99 245,97 270,95
L 295,93 320,92 345,91 370,91 395,91 420,92 445,93 465,95
L 475,97 482,100 488,103 493,107 497,113 500,117 503,113 508,108
L 515,104 523,100 532,97 542,95 553,93 565,92 578,92
L 590,93 600,95 610,98 618,102 625,100 633,97 642,94
L 652,92 665,91 678,92 690,94 700,97 708,100 715,97
L 722,95 730,93 740,92 750,92 762,93 775,96 788,100
L 800,106 810,113 818,122 823,132 826,142 828,152
L 830,164 831,175 830,186 828,198 826,208 823,218 820,228
L 818,238 816,248 818,258 822,268 826,278 830,290
L 832,302 832,314 828,326 822,336 815,345 808,352 800,358
L 792,363 784,367 776,370 768,372 758,374 748,375
L 738,376 730,374 722,370 716,365 710,358 705,352
L 698,348 690,346 682,344 674,344 666,346 658,349
L 650,352 642,354 634,355 624,356 614,356 604,355
L 594,353 584,350 574,346 564,342 554,338 544,334
L 534,330 524,327 514,325 504,323 494,322 484,320
L 474,319 464,318 454,318 444,320 434,323 424,328
L 414,333 404,338 394,344 384,350 374,356 364,362
L 354,367 344,372 334,376 322,380 310,384 298,387
L 286,390 274,392 262,394 248,396 234,398 220,402
L 206,406 194,412 182,418 172,424 164,430 158,436
L 152,442 148,448 144,454 140,462 136,468
L 132,462 128,454 124,445 120,436 116,427 113,418
L 110,408 107,398 104,388 101,376 99,364 98,352
L 98,340 100,328 104,316 109,304 114,292 118,280
L 122,268 126,256 129,244 131,232 132,220 132,208
L 132,196 131,184 130,172 130,160 130,148 130,136 130,124 130,110
Z
`;

// Regional boundary hints for visual separation
const US_STATE_BORDERS = `
<line x1="420" y1="92" x2="420" y2="328" stroke="#cbd5e1" stroke-width="0.5" opacity="0.35" stroke-dasharray="4,3"/>
<line x1="560" y1="92" x2="560" y2="355" stroke="#cbd5e1" stroke-width="0.5" opacity="0.35" stroke-dasharray="4,3"/>
<line x1="690" y1="92" x2="690" y2="370" stroke="#cbd5e1" stroke-width="0.5" opacity="0.35" stroke-dasharray="4,3"/>
<line x1="130" y1="230" x2="830" y2="230" stroke="#cbd5e1" stroke-width="0.5" opacity="0.25" stroke-dasharray="4,3"/>
<line x1="130" y1="310" x2="760" y2="310" stroke="#cbd5e1" stroke-width="0.5" opacity="0.25" stroke-dasharray="4,3"/>
`;

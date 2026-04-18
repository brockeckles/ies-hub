/**
 * IES Hub v3 — Command Center UI
 * Full dashboard with live KPI tiles, Sector Pulse cards, Market Alerts,
 * recent activity, tool quick-launch, and platform health.
 * Queries Supabase for live data with demo fallback.
 *
 * @module hub/command-center/ui
 */

import { bus } from '../../shared/event-bus.js';
import * as api from './api.js?v=20260418-s5';

/** @type {HTMLElement|null} */
let rootEl = null;
let refreshTimer = null;
let liveData = null;

// Chart.js instances
let dieselChartInstance = null;
let freightChartInstance = null;
let laborChartInstance = null;
let steelChartInstance = null;

export async function mount(el) {
  rootEl = el;
  el.innerHTML = renderLoading();
  liveData = await api.fetchDashboardData();
  render();
  // Auto-refresh every 5 minutes
  refreshTimer = setInterval(async () => {
    liveData = await api.fetchDashboardData();
    render();
  }, 5 * 60 * 1000);
  bus.emit('command-center:mounted');
}

export function unmount() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  destroyAllCharts();
  rootEl = null;
  bus.emit('command-center:unmounted');
}

function renderLoading() {
  return `<div class="hub-content-inner" style="padding:24px;display:flex;align-items:center;justify-content:center;min-height:400px;">
    <div style="text-align:center;"><div style="font-size:14px;color:var(--ies-gray-400);">Loading Command Center...</div></div>
  </div>`;
}

function render() {
  if (!rootEl || !liveData) return;
  const d = liveData;
  const now = new Date();
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;max-width:1200px;">

      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div>
          <h1 class="text-page" style="margin:0 0 4px 0;">${greeting}</h1>
          <p style="font-size:13px;color:var(--ies-gray-400);margin:0;">${dateStr} — IES Intelligence Hub v3.0</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${d.supabaseConnected ? '#16a34a' : '#d97706'};"></span>
          <span style="font-size:11px;color:var(--ies-gray-400);">${d.supabaseConnected ? 'Live' : 'Demo'} Data</span>
          <span style="font-size:11px;color:var(--ies-gray-300);margin-left:4px;">Updated ${timeStr}</span>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="refresh" style="margin-left:8px;padding:4px 10px;font-size:11px;">↻ Refresh</button>
        </div>
      </div>

      <!-- Inline alerts summary banner (top-of-page signal strip) -->
      ${renderInlineAlertBanner(d.alerts)}

      <!-- Market Intelligence KPIs — section label removed; titles live inside tiles -->
      <div style="margin-bottom:20px;">
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px;">
          ${kpiCard('Diesel Price', '$' + d.kpis.dieselPrice.toFixed(2) + '/gal', d.kpis.dieselTrend, '#dc2626', d.kpis.dieselChange)}
          ${kpiCard('Avg Warehouse Wage', '$' + d.kpis.avgWage.toFixed(2) + '/hr', d.kpis.wageTrend, '#7c3aed', d.kpis.wageChange)}
          ${kpiCard('Avg Warehouse Rate', '$' + (d.kpis.avgWarehouseRate || 0).toFixed(2) + '/sf/yr', d.kpis.warehouseRateTrend || 'neutral', '#2563eb', d.kpis.warehouseRateChange || '—')}
          ${kpiCard('Freight Rate Index', d.kpis.freightIndex.toFixed(0), d.kpis.freightTrend, '#ea580c', d.kpis.freightChange)}
          ${kpiCard('Steel Price Index', '$' + Math.round(d.kpis.steelPrice).toLocaleString() + ' ' + (d.kpis.steelUnit || '/ton'), d.kpis.steelTrend, '#0891b2', d.kpis.steelChange)}
          ${kpiCard('Active RFP Signals', String(d.kpis.rfpSignalCount || 0), d.kpis.rfpSignalTrend || 'neutral', '#16a34a', d.kpis.rfpSignalChange || '—')}
        </div>
      </div>

      <!-- Sector Pulse + Market Alerts — titles live INSIDE each card for consistency -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">

        <!-- Sector Pulse 2x2 — titles are on the individual tiles -->
        <div id="cc-sector-grid" style="display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:10px;">
          ${sectorPulseCard('Labor Watch', '👷', d.sectors.labor, '#2563eb')}
          ${sectorPulseCard('Freight Rates', '🚛', d.sectors.freight, '#ea580c')}
          ${sectorPulseCard('Automation Watch', '🤖', d.sectors.automation, '#7c3aed')}
          ${sectorPulseCard('Network Insights', '🌐', d.sectors.network, '#16a34a')}
        </div>

        <!-- Market Alerts — single card with title inside, height matched to sector grid -->
        <div class="hub-card" id="cc-alerts-card" style="display:flex;flex-direction:column;padding:0;overflow:hidden;">
          <div style="padding:14px 14px 8px;font-size:13px;font-weight:700;border-bottom:1px solid var(--ies-gray-100);">Market Alerts</div>
          <div style="overflow-y:auto;flex:1;max-height:0;" id="cc-alerts-list">
            ${d.alerts.length === 0 ? '<div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No active alerts</div>' :
              d.alerts.map(a => alertRow(a)).join('')}
          </div>
        </div>
      </div>

      <!-- Charts: 2x2 grid — Diesel, Freight (top), Wage Trends, Steel Price (bottom) -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">

        <!-- Diesel Price Trend -->
        <div class="hub-card" style="padding:16px;display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Diesel Price Trend</div>
          <div id="cc-diesel-chart" style="flex:1;min-height:240px;position:relative;"></div>
        </div>

        <!-- Freight Rate Index -->
        <div class="hub-card" style="padding:16px;display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Freight Rate Index</div>
          <div id="cc-freight-chart" style="flex:1;min-height:240px;position:relative;"></div>
        </div>

        <!-- Avg Warehouse Wage Trend (multi-line by region) -->
        <div class="hub-card" style="padding:16px;display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Warehouse Wage Trends <span style="font-size:10px;color:var(--ies-gray-400);font-weight:500;">— modeled 12-mo rise to current snapshot</span></div>
          <div id="cc-labor-chart" style="flex:1;min-height:240px;position:relative;"></div>
        </div>

        <!-- Steel Price Index (CRU HRC weekly) -->
        <div class="hub-card" style="padding:16px;display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Steel Price Index <span style="font-size:10px;color:var(--ies-gray-400);font-weight:500;">— CRU HRC $/ton</span></div>
          <div id="cc-steel-chart" style="flex:1;min-height:240px;position:relative;"></div>
        </div>
      </div>

      <!-- RFP Signals + Intelligence Feed — titles INSIDE cards, heights capped equal -->
      <div style="display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:16px;max-height:520px;">

        <!-- RFP Signals Feed -->
        <div class="hub-card" id="cc-rfp-feed" style="padding:0;display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:14px 14px 8px;font-size:13px;font-weight:700;border-bottom:1px solid var(--ies-gray-100);">RFP Signals</div>
          <div style="overflow-y:auto;flex:1;">
            ${renderRfpFeed(d.rfpSignals)}
          </div>
        </div>

        <!-- Intelligence Feed — tabbed (All / Competitor / Accounts / Tariff / RFP) -->
        <div class="hub-card" id="cc-intel-feed" style="padding:0;display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:14px 14px 0;font-size:13px;font-weight:700;border-bottom:1px solid var(--ies-gray-100);">
            Intelligence Feed
            <div style="display:flex;gap:4px;margin-top:8px;overflow-x:auto;">
              ${['all','competitor','accounts','tariff','rfp'].map((k, i) => `
                <button type="button" data-intel-tab="${k}" class="cc-intel-tab ${i === 0 ? 'active' : ''}"
                  style="font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;border:1px solid ${i === 0 ? '#1c1c1c' : 'var(--ies-gray-300)'};background:${i === 0 ? '#1c1c1c' : '#fff'};color:${i === 0 ? '#fff' : 'var(--ies-gray-700)'};cursor:pointer;text-transform:uppercase;letter-spacing:.04em;">${labelForIntelTab(k)} <span style="opacity:.7;">(${(d.intel?.[k === 'all' ? 'all' : k] || []).length})</span></button>
              `).join('')}
            </div>
          </div>
          <div style="padding:8px 14px 14px;overflow-y:auto;flex:1;" id="cc-intel-body">
            ${renderIntelFeed(d.intel?.all || [], d.activity)}
          </div>
        </div>
      </div>

    </div>
  `;

  bindEvents();
  matchAlertHeight();
  initCharts();
}

/** Match the alerts list area to the sector pulse grid height (minus header) */
function matchAlertHeight() {
  if (!rootEl) return;
  requestAnimationFrame(() => {
    const sectorGrid = rootEl?.querySelector('#cc-sector-grid');
    const alertsCard = rootEl?.querySelector('#cc-alerts-card');
    const alertsList = rootEl?.querySelector('#cc-alerts-list');
    if (sectorGrid && alertsCard) {
      const h = sectorGrid.offsetHeight;
      alertsCard.style.height = h + 'px';
      if (alertsList) alertsList.style.maxHeight = (h - 44) + 'px'; // subtract header height
    }
  });
}

function bindEvents() {
  if (!rootEl) return;

  // Use event delegation for all clicks
  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Refresh button
    if (target.closest('[data-action="refresh"]')) {
      refreshNow();
      return;
    }

    // Tool tile navigation
    const route = target.closest('[data-route]');
    if (route) {
      window.location.hash = /** @type {HTMLElement} */ (route).dataset.route;
      return;
    }

    // Alert link -> open source URL in new tab
    const alertLink = target.closest('[data-alert-link]');
    if (alertLink) {
      const url = /** @type {HTMLElement} */ (alertLink).dataset.alertLink;
      if (url) window.open(url, '_blank');
      return;
    }

    // Alert row -> open source URL in new tab
    const alertRow = target.closest('[data-alert-url]');
    if (alertRow) {
      const url = /** @type {HTMLElement} */ (alertRow).dataset.alertUrl;
      if (url) window.open(url, '_blank');
      return;
    }

    // Intelligence Feed tab switch
    const intelTab = target.closest('[data-intel-tab]');
    if (intelTab) {
      const key = /** @type {HTMLElement} */ (intelTab).dataset.intelTab;
      const tabs = rootEl.querySelectorAll('[data-intel-tab]');
      tabs.forEach(t => {
        const active = t.dataset.intelTab === key;
        t.classList.toggle('active', active);
        t.style.background = active ? '#1c1c1c' : '#fff';
        t.style.color = active ? '#fff' : 'var(--ies-gray-700)';
        t.style.borderColor = active ? '#1c1c1c' : 'var(--ies-gray-300)';
      });
      const body = rootEl.querySelector('#cc-intel-body');
      if (body && liveData?.intel) {
        const items = liveData.intel[key] || [];
        body.innerHTML = renderIntelFeed(items, liveData.activity);
      }
      return;
    }
  });

  // KPI tooltip hover (show/hide tiptext on mouseenter/mouseleave)
  rootEl.addEventListener('mouseenter', (e) => {
    const tip = /** @type {HTMLElement} */ (e.target).closest('.cc-kpi-tip');
    if (tip) {
      const text = tip.querySelector('.cc-kpi-tiptext');
      if (text) text.style.display = 'block';
    }
  }, true);
  rootEl.addEventListener('mouseleave', (e) => {
    const tip = /** @type {HTMLElement} */ (e.target).closest('.cc-kpi-tip');
    if (tip) {
      const text = tip.querySelector('.cc-kpi-tiptext');
      if (text) text.style.display = 'none';
    }
  }, true);
}

async function refreshNow() {
  if (!rootEl) return;
  liveData = await api.fetchDashboardData();
  render();
}

// ===== COMPONENT HELPERS =====

function kpiCard(label, value, trend, color, change) {
  const arrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
  const trendColor = trend === 'up' ? '#dc2626' : trend === 'down' ? '#16a34a' : 'var(--ies-gray-400)';

  const tooltips = {
    'Diesel Price': 'National average diesel price per gallon (EIA weekly data)',
    'Labor Tightness': 'Composite index (0-100) measuring warehouse labor availability. Higher = tighter market',
    'Avg Warehouse Wage': 'Average hourly wage for warehouse workers (BLS data, seasonally adjusted)',
    'Freight Rate Index': 'Composite index of spot and contract truckload rates (DAT/Coyote benchmarks)',
    'Steel Price Index': 'CRU HRC (Hot-Rolled Coil) weekly spot price, USD per ton. Key driver of racking, mezzanine and dock costs.',
    'Market Signal Score': 'Weighted composite of all intelligence signals. Higher = more market activity',
  };

  const tooltip = tooltips[label] || '';

  return `
    <div class="hub-card" style="padding:14px;position:relative;">
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">
        <span style="font-size:11px;color:var(--ies-gray-400);font-weight:600;">${label}</span>
        ${tooltip ? `<span class="cc-kpi-tip" style="position:relative;display:inline-flex;">
          <span style="width:14px;height:14px;border-radius:50%;background:var(--ies-gray-100);color:var(--ies-gray-400);font-size:9px;display:inline-flex;align-items:center;justify-content:center;cursor:help;font-weight:700;">?</span>
          <span class="cc-kpi-tiptext" style="display:none;position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 6px);width:220px;padding:8px 10px;background:#1e293b;color:#f8fafc;font-size:11px;font-weight:400;line-height:1.4;border-radius:6px;z-index:100;pointer-events:none;text-align:left;box-shadow:0 4px 12px rgba(0,0,0,.25);">${tooltip}</span>
        </span>` : ''}
      </div>
      <div style="font-size:22px;font-weight:800;color:${color};margin-bottom:4px;">${value}</div>
      <div style="font-size:11px;color:${trendColor};font-weight:600;">${arrow} ${change}</div>
    </div>
  `;
}

function sectorPulseCard(title, icon, data, color) {
  return `
    <div class="hub-card" style="padding:14px;border-left:3px solid ${color};">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
        <span style="font-size:16px;">${icon}</span>
        <span style="font-size:12px;font-weight:700;">${title}</span>
      </div>
      ${data.items.map(item => `
        <div style="display:flex;align-items:start;gap:6px;padding:3px 0;">
          <span style="width:6px;height:6px;border-radius:50%;background:${severityDot(item.severity)};flex-shrink:0;margin-top:4px;"></span>
          <div style="flex:1;">
            ${item.source_url
              ? `<a href="${item.source_url}" target="_blank" rel="noopener" style="font-size:11px;color:var(--ies-gray-600);text-decoration:none;" onmouseover="this.style.color='#2563eb';this.style.textDecoration='underline'" onmouseout="this.style.color='var(--ies-gray-600)';this.style.textDecoration='none'">${item.headline}</a>`
              : `<span style="font-size:11px;color:var(--ies-gray-600);">${item.headline}</span>`
            }
            ${item.source ? `<div style="font-size:9px;color:var(--ies-gray-300);">${item.source}</div>` : ''}
          </div>
        </div>
      `).join('')}
      <div style="font-size:10px;color:var(--ies-gray-300);margin-top:6px;">${data.source}</div>
    </div>
  `;
}

function alertRow(a) {
  // Neutralized styling — no severity color coding (per feedback 2026-04-17).
  // Only surface a link arrow when there's a source_url with a real article path
  // (not a bare domain root like https://www.freightwaves.com/ which the ingest
  // pipeline sometimes stores when it can't resolve the actual article URL).
  const isRealLink = (url) => {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.pathname && u.pathname !== '/' && u.pathname.length > 1;
    } catch { return false; }
  };
  const hasLink = isRealLink(a.source_url);
  const linkArrow = hasLink
    ? `<span style="font-size:11px;color:#2563eb;flex-shrink:0;margin-top:1px;">↗</span>`
    : '';
  const sourceLine = a.source
    ? `<span style="font-size:10px;color:var(--ies-gray-400);">${a.source}</span>`
    : '';
  return `
    <div style="display:flex;align-items:start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--ies-gray-100);cursor:${hasLink ? 'pointer' : 'default'};" data-alert-url="${hasLink ? a.source_url : ''}">
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:var(--ies-gray-700);margin-bottom:2px;">${a.title}</div>
        <div style="font-size:11px;color:var(--ies-gray-500);line-height:1.4;">${a.message}</div>
        ${sourceLine ? `<div style="margin-top:3px;">${sourceLine}</div>` : ''}
      </div>
      ${linkArrow}
      <span style="font-size:10px;color:var(--ies-gray-300);white-space:nowrap;flex-shrink:0;">${a.date}</span>
    </div>
  `;
}

function miniKpi(label, value, color) {
  return `
    <div style="text-align:center;">
      <div style="font-size:18px;font-weight:800;color:${color};">${value}</div>
      <div style="font-size:10px;color:var(--ies-gray-400);font-weight:600;">${label}</div>
    </div>
  `;
}

function toolTile(name, route, color, pathD) {
  return `
    <div data-route="${route}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;transition:background 0.15s;background:var(--ies-gray-50);" onmouseover="this.style.background='var(--ies-gray-100)'" onmouseout="this.style.background='var(--ies-gray-50)'">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${pathD}"/></svg>
      <span style="font-size:12px;font-weight:600;color:var(--ies-gray-700);">${name}</span>
    </div>
  `;
}

function activityItem(title, desc, time, color) {
  return `
    <div style="display:flex;align-items:start;gap:10px;padding:8px 0;border-bottom:1px solid var(--ies-gray-100);">
      <span style="width:8px;height:8px;border-radius:50%;background:${color};margin-top:5px;flex-shrink:0;"></span>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;">${title}</div>
        <div style="font-size:11px;color:var(--ies-gray-400);">${desc}</div>
      </div>
      <span style="font-size:11px;color:var(--ies-gray-300);white-space:nowrap;">${time}</span>
    </div>
  `;
}

/** Map an intel tab key to its display label. */
function labelForIntelTab(k) {
  return ({ all: 'All', competitor: 'Competitor', accounts: 'Accounts', tariff: 'Tariff', rfp: 'RFP' })[k] || k;
}

/**
 * Render the intelligence feed list. If there are no live items, falls back
 * to the curated activity stream.
 * @param {Array} items
 * @param {Array} fallbackActivity
 */
function renderIntelFeed(items, fallbackActivity) {
  if (!items || !items.length) {
    return (fallbackActivity || []).map(a => activityItem(a.title, a.description, a.time, a.color)).join('');
  }
  return items.slice(0, 25).map(item => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--ies-gray-100);">
      <span style="width:8px;height:8px;border-radius:50%;background:${severityDot(item.severity)};margin-top:5px;flex-shrink:0;"></span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
          <span style="font-size:11px;font-weight:800;color:${categoryColor(item.category)};text-transform:uppercase;letter-spacing:.04em;">${item.category || ''}</span>
          <span style="font-size:13px;font-weight:600;color:var(--ies-gray-800);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeText(item.title)}</span>
        </div>
        ${item.detail ? `<div style="font-size:11px;color:var(--ies-gray-500);line-height:1.4;">${escapeText(item.detail).slice(0, 180)}</div>` : ''}
      </div>
      <span style="font-size:10px;color:var(--ies-gray-400);white-space:nowrap;flex-shrink:0;">${item.relDate || ''}</span>
    </div>
  `).join('');
}

function categoryColor(cat) {
  return ({ Competitor: '#7c3aed', Accounts: '#0891b2', Tariff: '#d97706', RFP: '#16a34a' })[cat] || '#6b7280';
}

function escapeText(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Render the inline alert summary banner at the top of the page.
 * Aggregates by severity into a single strip with "X critical · Y high · Z medium".
 * @param {Array} alerts
 */
function renderInlineAlertBanner(alerts) {
  if (!alerts || !alerts.length) {
    return `<div style="margin:0 0 16px;padding:8px 14px;border-radius:8px;background:#f0fdf4;border:1px solid #86efac;color:#166534;font-size:12px;font-weight:600;display:flex;align-items:center;gap:10px;">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#16a34a;color:#fff;font-weight:800;">✓</span>
      No active market alerts.
    </div>`;
  }
  const counts = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const a of alerts) {
    const s = (a.severity || 'info').toLowerCase();
    const bucket = s === 'critical' ? 'critical' : s === 'high' ? 'high' : (s === 'medium' || s === 'warning') ? 'medium' : 'info';
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  const hasCritical = counts.critical > 0;
  const bg = hasCritical ? '#fef2f2' : counts.high > 0 ? '#fff7ed' : '#eff6ff';
  const border = hasCritical ? '#fecaca' : counts.high > 0 ? '#fed7aa' : '#bfdbfe';
  const text = hasCritical ? '#991b1b' : counts.high > 0 ? '#9a3412' : '#1e40af';
  const parts = [];
  if (counts.critical) parts.push(`<strong>${counts.critical}</strong> critical`);
  if (counts.high) parts.push(`<strong>${counts.high}</strong> high`);
  if (counts.medium) parts.push(`<strong>${counts.medium}</strong> medium`);
  if (counts.info) parts.push(`<strong>${counts.info}</strong> info`);
  const summary = parts.join(' &middot; ');
  const top = alerts.slice(0, 1)[0];
  return `<div style="margin:0 0 16px;padding:10px 14px;border-radius:8px;background:${bg};border:1px solid ${border};color:${text};font-size:12px;font-weight:600;display:flex;align-items:center;gap:14px;">
    <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${hasCritical ? '#dc2626' : counts.high > 0 ? '#ea580c' : '#2563eb'};color:#fff;font-weight:800;">!</span>
    <span style="flex-shrink:0;">${alerts.length} active alert${alerts.length === 1 ? '' : 's'}</span>
    <span style="color:${text};opacity:.8;flex-shrink:0;">${summary}</span>
    ${top ? `<span style="margin-left:auto;color:${text};opacity:.9;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px;">Top: <strong>${escapeText(top.title)}</strong> &middot; ${top.date || ''}</span>` : ''}
  </div>`;
}

function statusTile(name, status, healthy) {
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:var(--ies-gray-50);">
      <span style="width:8px;height:8px;border-radius:50%;background:${healthy ? '#16a34a' : '#d97706'};"></span>
      <span style="font-size:12px;font-weight:600;flex:1;">${name}</span>
      <span style="font-size:11px;color:${healthy ? '#16a34a' : '#d97706'};font-weight:700;">${status}</span>
    </div>
  `;
}

function severityDot(severity) {
  return { critical: '#dc2626', high: '#ea580c', warning: '#d97706', medium: '#d97706', info: '#2563eb', low: '#16a34a' }[severity] || '#9ca3af';
}

function renderRfpFeed(rfpSignals) {
  if (!rfpSignals || rfpSignals.length === 0) {
    return '<div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No RFP signals available</div>';
  }
  // Color a signal_type chip based on its theme so the eye can scan categories.
  const signalColor = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('expansion') || t.includes('facility')) return { bg: 'rgba(22,163,74,.10)', fg: '#16a34a' };  // green — growth
    if (t.includes('leadership') || t.includes('change')) return { bg: 'rgba(37,99,235,.10)', fg: '#2563eb' };   // blue — people
    if (t.includes('cost') || t.includes('restructuring') || t.includes('10-k')) return { bg: 'rgba(217,119,6,.10)', fg: '#d97706' }; // amber — financial
    if (t.includes('m&a') || t.includes('acquisition')) return { bg: 'rgba(124,58,237,.10)', fg: '#7c3aed' };    // purple — M&A
    return { bg: 'rgba(107,114,128,.10)', fg: '#6b7280' };
  };
  const confidenceDots = (n) => {
    const filled = Math.max(0, Math.min(5, n || 0));
    const dots = [];
    for (let i = 0; i < 5; i++) {
      dots.push(`<span style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:2px;background:${i < filled ? '#16a34a' : '#e5e7eb'};"></span>`);
    }
    return dots.join('');
  };

  return rfpSignals.map(rfp => {
    const sc = signalColor(rfp.signal);
    return `
    <div style="display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-bottom:1px solid var(--ies-gray-100);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
          <span style="font-size:13px;font-weight:700;color:var(--ies-gray-700);white-space:nowrap;">${rfp.company}</span>
          <span style="font-size:10px;color:var(--ies-gray-400);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rfp.vertical}</span>
        </div>
        <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:${sc.bg};color:${sc.fg};text-transform:uppercase;letter-spacing:0.3px;white-space:nowrap;flex-shrink:0;">${rfp.signal}</span>
      </div>
      ${rfp.detail ? `<div style="font-size:12px;color:var(--ies-gray-600);line-height:1.4;">${rfp.detail}</div>` : ''}
      <div style="display:flex;align-items:center;gap:12px;font-size:10px;color:var(--ies-gray-400);">
        ${rfp.timeline ? `<span>⏱ ${rfp.timeline}</span>` : ''}
        <span style="display:inline-flex;align-items:center;gap:4px;">Confidence ${confidenceDots(rfp.confidence)}</span>
        <span style="margin-left:auto;">${rfp.date}</span>
      </div>
    </div>`;
  }).join('');
}

/**
 * Load Chart.js from CDN if not already present, then initialize charts
 */
async function ensureChartJs() {
  if (typeof Chart !== 'undefined') return;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Chart.js'));
    document.head.appendChild(script);
  });
}

function destroyAllCharts() {
  if (dieselChartInstance) { dieselChartInstance.destroy(); dieselChartInstance = null; }
  if (freightChartInstance) { freightChartInstance.destroy(); freightChartInstance = null; }
  if (laborChartInstance) { laborChartInstance.destroy(); laborChartInstance = null; }
  if (steelChartInstance) { steelChartInstance.destroy(); steelChartInstance = null; }
}

/**
 * Initialize all three charts after render completes
 */
async function initCharts() {
  if (!rootEl) return;
  try {
    await ensureChartJs();
    await renderCharts();
  } catch (err) {
    console.warn('[CC] Chart initialization failed:', err);
  }
}

/**
 * Render the three Chart.js charts with live or demo data
 */
async function renderCharts() {
  if (!rootEl || !liveData) return;

  const chartData = await api.fetchChartData();

  // Diesel Price Trend
  const dieselCtx = rootEl.querySelector('#cc-diesel-chart canvas');
  if (!dieselCtx && rootEl.querySelector('#cc-diesel-chart')) {
    const container = rootEl.querySelector('#cc-diesel-chart');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    renderDieselChart(canvas, chartData.diesel);
  }

  // Freight Rate Index
  const freightCtx = rootEl.querySelector('#cc-freight-chart canvas');
  if (!freightCtx && rootEl.querySelector('#cc-freight-chart')) {
    const container = rootEl.querySelector('#cc-freight-chart');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    renderFreightChart(canvas, chartData.freight);
  }

  // Labor Wage by Region
  const laborCtx = rootEl.querySelector('#cc-labor-chart canvas');
  if (!laborCtx && rootEl.querySelector('#cc-labor-chart')) {
    const container = rootEl.querySelector('#cc-labor-chart');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    renderLaborChart(canvas, chartData.labor);
  }

  // Steel Price Index (CRU HRC)
  const steelCtx = rootEl.querySelector('#cc-steel-chart canvas');
  if (!steelCtx && rootEl.querySelector('#cc-steel-chart')) {
    const container = rootEl.querySelector('#cc-steel-chart');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    renderSteelChart(canvas, chartData.steel);
  }
}

function renderSteelChart(canvas, data) {
  try {
    steelChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [{
          label: 'CRU HRC ($/ton)',
          data: data.prices,
          borderColor: '#0891b2',
          backgroundColor: 'rgba(8,145,178,.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: '#0891b2',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: false,
            ticks: { callback: v => '$' + v },
          },
        },
      },
    });
  } catch (err) {
    console.warn('[CC] Steel chart error:', err);
  }
}

function renderDieselChart(canvas, data) {
  destroyAllCharts();
  try {
    dieselChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [{
          label: 'Diesel ($/gal)',
          data: data.prices,
          borderColor: '#dc2626',
          backgroundColor: 'rgba(220,38,38,.06)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#dc2626',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: false,
            ticks: { callback: v => '$' + v.toFixed(2) }
          }
        }
      }
    });
  } catch (err) {
    console.warn('[CC] Diesel chart error:', err);
  }
}

function renderFreightChart(canvas, data) {
  try {
    freightChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'Spot Rate ($/mi)',
            data: data.spot,
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,.06)',
            fill: false,
            tension: 0.3,
            pointRadius: 2,
            pointBackgroundColor: '#2563eb',
            borderWidth: 2
          },
          {
            label: 'Contract Rate ($/mi)',
            data: data.contract,
            borderColor: '#7c3aed',
            backgroundColor: 'rgba(124,58,237,.06)',
            fill: false,
            tension: 0.3,
            pointRadius: 2,
            pointBackgroundColor: '#7c3aed',
            borderWidth: 2,
            borderDash: [5, 5]
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }
        },
        scales: {
          y: {
            beginAtZero: false,
            ticks: { callback: v => '$' + v.toFixed(2) }
          }
        }
      }
    });
  } catch (err) {
    console.warn('[CC] Freight chart error:', err);
  }
}

function renderLaborChart(canvas, data) {
  try {
    // Convert bar data to multi-line trend data by region/market.
    // Use an index-based palette so cities (MSAs) get distinct colors
    // even though the hardcoded name→color map only knew census regions.
    const months = ['Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];
    const palette = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#dc2626', '#0891b2', '#ca8a04', '#be185d'];
    const regionColors = {
      // Still honor census-region names if the data uses them
      'Northeast': '#2563eb', 'Southeast': '#16a34a', 'Midwest': '#ea580c',
      'Southwest': '#7c3aed', 'West': '#dc2626',
    };
    const datasets = (data.regions || []).map((region, i) => {
      const latestWage = data.wages ? data.wages[i] : 19 + i;
      const color = regionColors[region] || palette[i % palette.length];
      // Synthesize 12 months of history back from the current wage. Give
      // each city a distinct YoY growth rate and its own tiny month-to-month
      // walk so the lines don't climb in visual lock-step.
      //
      // Growth rates span 1.8%–6.0% across cities (indexed), reflecting the
      // real spread between soft markets like Central PA (~2%) and tight
      // markets like Atlanta/Memphis (~5–6%).
      const growthRates = [0.058, 0.047, 0.041, 0.033, 0.022, 0.054, 0.028, 0.018];
      const yoy = growthRates[i % growthRates.length];
      // Per-city seasonality amplitudes ($0.08 – $0.28) + distinct phase
      // so dips don't align across cities (but still monotonic-ish up).
      const amp = 0.08 + ((i * 17) % 21) / 100; // 0.08..0.28
      const phase = (i * 1.7) % (2 * Math.PI);
      const startWage = latestWage / (1 + yoy);
      const trendData = months.map((_, m) => {
        // Linear climb along the YoY growth + small smooth seasonality +
        // small deterministic per-month noise
        const linear = startWage + (latestWage - startWage) * (m / (months.length - 1));
        const seasonal = amp * Math.sin(((m / months.length) * 2 * Math.PI) + phase) * 0.4;
        const noise = (((i * 11 + m * 7) % 13) - 6) * 0.008;
        return +(linear + seasonal + noise).toFixed(2);
      });
      return {
        label: region,
        data: trendData,
        borderColor: color,
        backgroundColor: 'transparent',
        tension: 0.35,
        pointRadius: 2,
        pointBackgroundColor: color,
        borderWidth: 2,
      };
    });
    laborChartInstance = new Chart(canvas, {
      type: 'line',
      data: { labels: months, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 }, padding: 8 } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: $${ctx.parsed.y.toFixed(2)}/hr`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: false,
            ticks: { callback: v => '$' + Number(v).toFixed(2) }
          }
        }
      }
    });
  } catch (err) {
    console.warn('[CC] Labor chart error:', err);
  }
}

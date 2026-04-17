/**
 * IES Hub v3 — Command Center UI
 * Full dashboard with live KPI tiles, Sector Pulse cards, Market Alerts,
 * recent activity, tool quick-launch, and platform health.
 * Queries Supabase for live data with demo fallback.
 *
 * @module hub/command-center/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260417-s2';
import * as api from './api.js?v=20260417-s2';

/** @type {HTMLElement|null} */
let rootEl = null;
let refreshTimer = null;
let liveData = null;

// Chart.js instances
let dieselChartInstance = null;
let freightChartInstance = null;
let laborChartInstance = null;

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

      <!-- Market Intelligence KPIs -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Market Intelligence</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;">
          ${kpiCard('Diesel Price', '$' + d.kpis.dieselPrice.toFixed(2) + '/gal', d.kpis.dieselTrend, '#dc2626', d.kpis.dieselChange)}
          ${kpiCard('Labor Tightness', d.kpis.laborTightness.toFixed(1), d.kpis.laborTrend, '#2563eb', d.kpis.laborChange)}
          ${kpiCard('Avg Warehouse Wage', '$' + d.kpis.avgWage.toFixed(2) + '/hr', d.kpis.wageTrend, '#7c3aed', d.kpis.wageChange)}
          ${kpiCard('Freight Rate Index', d.kpis.freightIndex.toFixed(0), d.kpis.freightTrend, '#ea580c', d.kpis.freightChange)}
          ${kpiCard('Market Signal Score', d.kpis.marketSignal.toFixed(0) + '/100', d.kpis.signalTrend, '#16a34a', d.kpis.signalChange)}
        </div>
      </div>

      <!-- Sector Pulse + Market Alerts -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">

        <!-- Sector Pulse -->
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Sector Pulse</div>
          <div id="cc-sector-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            ${sectorPulseCard('Labor Watch', '👷', d.sectors.labor, '#2563eb')}
            ${sectorPulseCard('Freight Rates', '🚛', d.sectors.freight, '#ea580c')}
            ${sectorPulseCard('Automation Watch', '🤖', d.sectors.automation, '#7c3aed')}
            ${sectorPulseCard('Network Insights', '🌐', d.sectors.network, '#16a34a')}
          </div>
        </div>

        <!-- Market Alerts (height-matched to sector pulse) -->
        <div style="display:flex;flex-direction:column;">
          <div style="font-size:12px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Market Alerts</div>
          <div class="hub-card" id="cc-alerts-card" style="padding:0;overflow-y:auto;flex:1;max-height:0;">
            ${d.alerts.length === 0 ? '<div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No active alerts</div>' :
              d.alerts.map(a => alertRow(a)).join('')}
          </div>
        </div>
      </div>

      <!-- Charts: Diesel, Freight, Labor -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px;">

        <!-- Diesel Price Trend -->
        <div class="hub-card" style="padding:16px;display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Diesel Price Trend</div>
          <div id="cc-diesel-chart" style="flex:1;min-height:350px;position:relative;"></div>
        </div>

        <!-- Freight Rate Index -->
        <div class="hub-card" style="padding:16px;display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Freight Rate Index</div>
          <div id="cc-freight-chart" style="flex:1;min-height:350px;position:relative;"></div>
        </div>

        <!-- Avg Warehouse Wage by Region -->
        <div class="hub-card" style="padding:16px;display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Avg Warehouse Wage by Region</div>
          <div id="cc-labor-chart" style="flex:1;min-height:350px;position:relative;"></div>
        </div>
      </div>

      <!-- RFP Signals Feed -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">RFP Signals</div>
        <div class="hub-card" id="cc-rfp-feed" style="padding:0;overflow-y:auto;">
          ${renderRfpFeed(d.rfpSignals)}
        </div>
      </div>

      <!-- Recent Activity + Platform Health -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

        <!-- Recent Activity -->
        <div class="hub-card" style="padding:20px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:14px;">Recent Activity</div>
          ${d.activity.map(a => activityItem(a.title, a.description, a.time, a.color)).join('')}
        </div>

        <!-- Platform Health -->
        <div class="hub-card" style="padding:20px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:14px;">Platform Status</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            ${statusTile('Supabase', d.supabaseConnected ? 'Connected' : 'Demo Mode', d.supabaseConnected)}
            ${statusTile('Authentication', 'Active', true)}
            ${statusTile('Design Tools (7)', 'Operational', true)}
            ${statusTile('Training Wiki', 'Live', true)}
            ${statusTile('Change Management', 'Live', true)}
            ${statusTile('Feedback Board', 'Live', true)}
          </div>
          <div style="border-top:1px solid var(--ies-gray-100);margin-top:12px;padding-top:12px;">
            <div style="font-size:11px;color:var(--ies-gray-400);margin-bottom:6px;">Test Coverage</div>
            <div style="display:flex;align-items:center;gap:8px;">
              <div style="flex:1;height:8px;background:var(--ies-gray-100);border-radius:4px;overflow:hidden;">
                <div style="width:100%;height:100%;background:#16a34a;border-radius:4px;"></div>
              </div>
              <span style="font-size:12px;font-weight:700;color:#16a34a;">519 passing</span>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;

  bindEvents();
  matchAlertHeight();
  initCharts();
}

/** Match the alerts card height to the sector pulse grid height */
function matchAlertHeight() {
  if (!rootEl) return;
  requestAnimationFrame(() => {
    const sectorGrid = rootEl?.querySelector('#cc-sector-grid');
    const alertsCard = rootEl?.querySelector('#cc-alerts-card');
    if (sectorGrid && alertsCard) {
      const h = sectorGrid.offsetHeight;
      alertsCard.style.maxHeight = h + 'px';
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
  });
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

  // Tooltip content for each KPI
  const tooltips = {
    'Diesel Price': 'National average diesel price per gallon (EIA weekly data)',
    'Labor Tightness': 'Composite index (0-100) measuring warehouse labor availability. Higher = tighter market',
    'Avg Warehouse Wage': 'Average hourly wage for warehouse workers (BLS data, seasonally adjusted)',
    'Freight Rate Index': 'Composite index of spot and contract truckload rates (DAT/Coyote benchmarks)',
    'Market Signal Score': 'Weighted composite of all intelligence signals. Higher = more market activity',
  };

  const tooltip = tooltips[label] || '';
  const tooltipStyle = tooltip ? `position:relative;cursor:help;` : '';

  return `
    <div class="hub-card" style="padding:14px;${tooltipStyle}" title="${tooltip}">
      <div style="font-size:11px;color:var(--ies-gray-400);font-weight:600;margin-bottom:6px;">${label}</div>
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
  const sev = {
    critical: { bg: '#fef2f2', border: '#dc2626', icon: '🔴' },
    warning: { bg: '#fffbeb', border: '#d97706', icon: '🟡' },
    info: { bg: '#eff6ff', border: '#2563eb', icon: '🔵' },
  }[a.severity] || { bg: '#f9fafb', border: '#9ca3af', icon: '⚪' };

  return `
    <div style="display:flex;align-items:start;gap:8px;padding:10px 14px;border-bottom:1px solid var(--ies-gray-100);background:${sev.bg};" data-alert-url="${a.source_url || ''}">
      <span style="font-size:12px;flex-shrink:0;margin-top:1px;">${sev.icon}</span>
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:600;color:var(--ies-gray-700);">${a.title}</div>
        <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">${a.message}</div>
        ${a.source_url ? `<span style="font-size:10px;color:#2563eb;cursor:pointer;text-decoration:none;" data-alert-link="${a.source_url}">${a.source || 'Source'} →</span>` : ''}
      </div>
      <span style="font-size:10px;color:var(--ies-gray-300);white-space:nowrap;">${a.date}</span>
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
  return { critical: '#dc2626', warning: '#d97706', info: '#2563eb' }[severity] || '#9ca3af';
}

function renderRfpFeed(rfpSignals) {
  if (!rfpSignals || rfpSignals.length === 0) {
    return '<div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No RFP signals available</div>';
  }
  return rfpSignals.map(rfp => `
    <div style="display:flex;align-items:start;gap:10px;padding:12px 14px;border-bottom:1px solid var(--ies-gray-100);">
      <div style="width:32px;height:32px;border-radius:6px;background:var(--ies-gray-100);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--ies-gray-600);flex-shrink:0;">💼</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:var(--ies-gray-700);">${rfp.company}</div>
        <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">${rfp.vertical} — ${rfp.volume} pallets/mo</div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;background:rgba(37,99,235,.08);color:#2563eb;">${rfp.region}</span>
          <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;background:${rfp.stage === 'active' ? 'rgba(22,163,74,.08);color:#16a34a' : rfp.stage === 'closed' ? 'rgba(107,114,128,.08);color:#6b7280' : 'rgba(217,119,6,.08);color:#d97706'};">${rfp.stage}</span>
        </div>
      </div>
      <span style="font-size:10px;color:var(--ies-gray-300);white-space:nowrap;flex-shrink:0;">${rfp.date}</span>
    </div>
  `).join('');
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
    laborChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.regions,
        datasets: [{
          label: 'Avg Hourly Wage',
          data: data.wages,
          backgroundColor: data.regions.map((_, i) => {
            const colors = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#dc2626'];
            return colors[i % colors.length];
          }),
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { callback: v => '$' + v.toFixed(2) }
          }
        }
      }
    });
  } catch (err) {
    console.warn('[CC] Labor chart error:', err);
  }
}

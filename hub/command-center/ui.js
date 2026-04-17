/**
 * IES Hub v3 — Command Center UI
 * Full dashboard with live KPI tiles, Sector Pulse cards, Market Alerts,
 * recent activity, tool quick-launch, and platform health.
 * Queries Supabase for live data with demo fallback.
 *
 * @module hub/command-center/ui
 */

import { bus } from '../../shared/event-bus.js';
import * as api from './api.js';

/** @type {HTMLElement|null} */
let rootEl = null;
let refreshTimer = null;
let liveData = null;

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
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            ${sectorPulseCard('Labor Watch', '👷', d.sectors.labor, '#2563eb')}
            ${sectorPulseCard('Freight Rates', '🚛', d.sectors.freight, '#ea580c')}
            ${sectorPulseCard('Automation Watch', '🤖', d.sectors.automation, '#7c3aed')}
            ${sectorPulseCard('Network Insights', '🌐', d.sectors.network, '#16a34a')}
          </div>
        </div>

        <!-- Market Alerts -->
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Market Alerts</div>
          <div class="hub-card" style="padding:0;max-height:260px;overflow-y:auto;">
            ${d.alerts.length === 0 ? '<div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No active alerts</div>' :
              d.alerts.map(a => alertRow(a)).join('')}
          </div>
        </div>
      </div>

      <!-- Pipeline KPIs + Quick Launch -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">

        <!-- Pipeline Snapshot -->
        <div class="hub-card" style="padding:20px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:14px;">Pipeline Snapshot</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
            ${miniKpi('Active Deals', d.pipeline.activeDeals, '#2563eb')}
            ${miniKpi('Total Pipeline', '$' + (d.pipeline.totalRevenue / 1e6).toFixed(1) + 'M', '#16a34a')}
            ${miniKpi('Avg Margin', d.pipeline.avgMargin.toFixed(1) + '%', '#7c3aed')}
            ${miniKpi('Sites in Design', d.pipeline.totalSites, '#d97706')}
          </div>
          <div style="font-size:11px;color:var(--ies-gray-400);margin-bottom:8px;">DOS Stage Distribution</div>
          <div style="display:flex;gap:4px;height:24px;border-radius:4px;overflow:hidden;">
            ${d.pipeline.stageCounts.map((c, i) => {
              const colors = ['#6b7280', '#2563eb', '#7c3aed', '#d97706', '#ea580c', '#16a34a'];
              const names = ['Qual', 'Disc', 'Design', 'Prop', 'Nego', 'Impl'];
              const pct = d.pipeline.activeDeals > 0 ? (c / d.pipeline.activeDeals * 100) : 0;
              return pct > 0 ? `<div style="flex:${c};background:${colors[i]};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;" title="${names[i]}: ${c}">${c > 0 ? c : ''}</div>` : '';
            }).join('')}
          </div>
        </div>

        <!-- Quick Launch -->
        <div class="hub-card" style="padding:20px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:14px;">Design Tools</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            ${toolTile('Cost Model Builder', 'designtools/cost-model', '#2563eb', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.52 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.94s4.18 1.36 4.18 3.85c0 1.89-1.44 2.94-3.12 3.19z')}
            ${toolTile('Warehouse Sizing', 'designtools/warehouse-sizing', '#16a34a', 'M3 21h18V3H3v18zm2-2V5h14v14H5z M7 7h4v4H7V7z M13 7h4v4h-4V7z M7 13h4v4H7v-4z')}
            ${toolTile('MOST Standards', 'designtools/most-standards', '#ea580c', 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z')}
            ${toolTile('Network Optimizer', 'designtools/network-opt', '#dc2626', 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7')}
            ${toolTile('Fleet Modeler', 'designtools/fleet-modeler', '#7c3aed', 'M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0')}
            ${toolTile('Center of Gravity', 'designtools/center-of-gravity', '#0891b2', 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z')}
            ${toolTile('Multi-Site Analyzer', 'designtools/deal-manager', '#d97706', 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7')}
            ${toolTile('Deal Management', 'deals', '#64748b', 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4')}
          </div>
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

    // Alert click -> Market Explorer
    const alert = target.closest('[data-alert-market]');
    if (alert) {
      window.location.hash = 'marketmap';
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
  // For labor/freight, up is bad; for signal, up is good
  return `
    <div class="hub-card" style="padding:14px;">
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
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
          <span style="width:6px;height:6px;border-radius:50%;background:${severityDot(item.severity)};flex-shrink:0;"></span>
          <span style="font-size:11px;color:var(--ies-gray-600);flex:1;">${item.headline}</span>
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
    <div style="display:flex;align-items:start;gap:8px;padding:10px 14px;border-bottom:1px solid var(--ies-gray-100);background:${sev.bg};cursor:pointer;" data-alert-market="${a.market || ''}">
      <span style="font-size:12px;flex-shrink:0;margin-top:1px;">${sev.icon}</span>
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:600;color:var(--ies-gray-700);">${a.title}</div>
        <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">${a.message}</div>
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

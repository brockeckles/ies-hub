/**
 * IES Hub v3 — Command Center UI
 * Dashboard with KPI tiles, recent activity, tool quick-launch, and platform health.
 *
 * @module hub/command-center/ui
 */

import { bus } from '../../shared/event-bus.js';

/** @type {HTMLElement|null} */
let rootEl = null;

export function mount(el) {
  rootEl = el;
  el.innerHTML = renderDashboard();
  bindEvents();
  bus.emit('command-center:mounted');
}

export function unmount() { rootEl = null; bus.emit('command-center:unmounted'); }

function renderDashboard() {
  const now = new Date();
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return `
    <div class="hub-content-inner" style="padding:24px;max-width:1200px;">

      <!-- Header -->
      <div style="margin-bottom:24px;">
        <h1 class="text-page" style="margin:0 0 4px 0;">${greeting}</h1>
        <p style="font-size:13px;color:var(--ies-gray-400);margin:0;">${dateStr} — IES Intelligence Hub v3.0</p>
      </div>

      <!-- KPI Row -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;">
        ${kpi('Active Deals', '10', '#2563eb', '+2 this month', 'up')}
        ${kpi('Design Tools', '7', '#7c3aed', 'All operational', 'neutral')}
        ${kpi('Open Feedback', '3', '#d97706', '2 bugs, 1 feature', 'neutral')}
        ${kpi('Test Coverage', '519', '#16a34a', 'All passing', 'up')}
      </div>

      <!-- Two-column layout -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">

        <!-- Quick Launch -->
        <div class="hub-card" style="padding:20px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Design Tools</div>
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

        <!-- Recent Activity -->
        <div class="hub-card" style="padding:20px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Recent Activity</div>
          ${activityItem('Cost Model updated', 'Wayfair Midwest — margin adjusted to 11.2%', '2 hours ago', '#2563eb')}
          ${activityItem('Fleet scenario created', 'New fleet analysis for SE regional lanes', 'Yesterday', '#7c3aed')}
          ${activityItem('DOS element completed', 'Site Assessment checklist finalized', 'Yesterday', '#16a34a')}
          ${activityItem('Wiki article deleted', 'Removed outdated BY WMS reference', '2 days ago', '#dc2626')}
          ${activityItem('Change initiative created', 'DOS Process Standardization kickoff', '3 days ago', '#d97706')}
          ${activityItem('Feedback submitted', 'Fleet team driving toggle bug reported', '4 days ago', '#6b7280')}
        </div>
      </div>

      <!-- Platform Health -->
      <div class="hub-card" style="padding:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Platform Status</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
          ${statusTile('Supabase', 'Connected', true)}
          ${statusTile('Authentication', 'Active', true)}
          ${statusTile('Design Tools (7)', 'Operational', true)}
          ${statusTile('Training Wiki', 'Live', true)}
          ${statusTile('Change Management', 'Live', true)}
          ${statusTile('Feedback Board', 'Live', true)}
        </div>
      </div>

    </div>
  `;
}

function bindEvents() {
  if (!rootEl) return;
  rootEl.querySelectorAll('[data-route]').forEach(el => {
    el.addEventListener('click', () => {
      window.location.hash = /** @type {HTMLElement} */ (el).dataset.route;
    });
  });
}

// ===== HELPERS =====
function kpi(label, value, color, sub, trend) {
  const arrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '';
  return `
    <div class="hub-card" style="padding:16px;">
      <div style="font-size:24px;font-weight:800;color:${color};">${value}</div>
      <div style="font-size:12px;font-weight:600;color:var(--ies-gray-600);margin-top:2px;">${label}</div>
      <div style="font-size:11px;color:var(--ies-gray-400);margin-top:4px;">${arrow} ${sub}</div>
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
      <span style="width:8px;height:8px;border-radius:50%;background:${healthy ? '#16a34a' : '#dc2626'};"></span>
      <span style="font-size:12px;font-weight:600;flex:1;">${name}</span>
      <span style="font-size:11px;color:${healthy ? '#16a34a' : '#dc2626'};font-weight:700;">${status}</span>
    </div>
  `;
}

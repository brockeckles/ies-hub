/**
 * IES Hub v3 — Admin Panel UI
 * Master data management, user admin, escalation rules, and audit log.
 *
 * @module hub/admin/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sP';
import * as calc from './calc.js?v=20260423-z3';
import * as api from './api.js?v=20260423-z3';
import { showToast } from '../../shared/toast.js?v=20260418-sK';

/** @type {HTMLElement|null} */
let rootEl = null;
let activeTab = 'tables'; // tables | activity | escalations | audit
let activeMasterTable = null;

// Slice 3.13 — User Activity tab state. Keyed outside render() so a
// re-render doesn't re-fetch. Invalidated by the Refresh button and by
// the 60s auto-refresh timer in renderActivity.
let _activityRows = [];
let _activityKpis = null;
let _activityLoaded = false;
let _activityLoading = false;
let _activityLastLoad = 0;
let _activityTimer = null;
let _activityWindowDays = 7;

export async function mount(el) {
  rootEl = el;
  activeTab = 'tables';
  activeMasterTable = null;
  render();
  bus.emit('admin:mounted');
}

export function unmount() { rootEl = null; bus.emit('admin:unmounted'); }

function render() {
  if (!rootEl) return;
  const stats = calc.computeStats(calc.DEMO_USERS, calc.MASTER_TABLES, calc.DEMO_ESCALATIONS, calc.DEMO_AUDIT_LOG, '2026-04-16');

  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 class="text-page" style="margin:0;">Admin</h2>
        <div style="display:flex;gap:8px;" id="admin-tabs">
          ${['tables', 'activity', 'escalations', 'audit'].map(t => `
            <button class="hub-btn hub-btn-sm ${t === activeTab ? '' : 'hub-btn-secondary'}" data-tab="${t}">${
              t === 'tables' ? 'Master Data'
              : t === 'activity' ? 'User Activity'
              : t.charAt(0).toUpperCase() + t.slice(1)
            }</button>
          `).join('')}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;">
        ${kpi('Tables', stats.totalTables, '#7c3aed')}
        ${kpi('Records', stats.totalRecords, '#16a34a')}
        ${kpi('Active Rules', stats.activeEscalations, '#d97706')}
      </div>
      <div id="admin-content"></div>
    </div>
  `;

  rootEl.querySelector('#admin-tabs')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-tab]');
    if (btn) { activeTab = btn.dataset.tab; activeMasterTable = null; render(); }
  });

  const el = rootEl.querySelector('#admin-content');
  if (!el) return;

  // Switch tabs → cancel any pending auto-refresh timer owned by the
  // previous tab (currently just activity). Cheap and prevents stray
  // background re-renders into a detached DOM.
  if (activeTab !== 'activity' && _activityTimer) {
    clearTimeout(_activityTimer);
    _activityTimer = null;
  }

  switch (activeTab) {
    case 'tables': renderMasterData(el); break;
    case 'activity': renderActivity(el); break;
    case 'escalations': renderEscalations(el); break;
    case 'audit': renderAudit(el); break;
    // 'users' tab was removed in Slice 3.15 — the demo roster (John Smith
    // et al.) was misleading given we now have 5 real profiles. The User
    // Activity tab is the single source of truth for who's in the hub.
    // Real user management (invite / promote / deactivate) will land as
    // its own slice with working API wiring, not as a demo placeholder.
  }
}

// ===== MASTER DATA =====
function renderMasterData(el) {
  if (activeMasterTable) { renderTableDetail(el); return; }

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
      ${calc.MASTER_TABLES.map(t => `
        <div class="hub-card" style="padding:16px;cursor:pointer;transition:all 0.2s;" data-table="${t.id}">
          <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${t.name}</div>
          <div style="font-size:12px;color:var(--ies-gray-400);margin-bottom:8px;">${t.description}</div>
          <div style="display:flex;gap:12px;font-size:11px;color:var(--ies-gray-400);margin-bottom:8px;">
            <span>📊 ${t.rowCount} records</span>
            <span>📋 ${t.columns.length} columns</span>
          </div>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" style="width:100%;margin-top:8px;">View →</button>
        </div>
      `).join('')}
    </div>
  `;

  el.querySelectorAll('[data-table]').forEach(card => {
    card.addEventListener('click', () => {
      activeMasterTable = calc.MASTER_TABLES.find(t => t.id === /** @type {HTMLElement} */ (card).dataset.table);
      render();
    });
  });
}

function renderTableDetail(el) {
  const table = activeMasterTable;
  if (!table) return;

  // Sample data for each table
  const sampleData = {
    cost_buckets: [
      { name: 'Management', code: 'MGMT', sort_order: 1, active: true },
      { name: 'Labor', code: 'LABOR', sort_order: 2, active: true },
      { name: 'Facility', code: 'FAC', sort_order: 3, active: true },
      { name: 'Equipment', code: 'EQUIP', sort_order: 4, active: true },
      { name: 'Overhead', code: 'OH', sort_order: 5, active: true },
    ],
    vehicle_types: [
      { name: 'Sprinter Van', payload_lbs: 3000, cube_ft3: 380, cpm: 2.15, active: true },
      { name: 'Box Truck (26ft)', payload_lbs: 12000, cube_ft3: 1600, cpm: 3.25, active: true },
      { name: 'Semi (53ft)', payload_lbs: 43000, cube_ft3: 3400, cpm: 1.85, active: true },
      { name: 'Straight (28ft)', payload_lbs: 25000, cube_ft3: 2000, cpm: 2.45, active: true },
      { name: 'Pup Trailer', payload_lbs: 18000, cube_ft3: 1700, cpm: 1.95, active: true },
    ],
    dos_templates: [
      { name: 'Credit Check', stage: 'Stage 1', required: true, sort_order: 1 },
      { name: 'Cost Model', stage: 'Stage 3', required: true, sort_order: 2 },
      { name: 'Facility Plan', stage: 'Stage 3', required: true, sort_order: 3 },
      { name: 'P&L Projection', stage: 'Stage 3', required: false, sort_order: 4 },
      { name: 'ELT Approval', stage: 'Stage 5', required: true, sort_order: 5 },
    ],
    escalation_rates: [
      { category: 'Labor', rate_pct: 3.5, year: 2026, source: 'BLS' },
      { category: 'Facility', rate_pct: 2.8, year: 2026, source: 'CRE Data' },
      { category: 'Equipment', rate_pct: 2.2, year: 2026, source: 'Industrial' },
      { category: 'Utilities', rate_pct: 4.1, year: 2026, source: 'DOE' },
    ],
    sccs: [
      { name: 'Inbound Logistics', category: 'Operational', sort_order: 1 },
      { name: 'Warehouse Operations', category: 'Operational', sort_order: 2 },
      { name: 'Network Design', category: 'Strategic', sort_order: 3 },
      { name: 'Automation Technology', category: 'Technology', sort_order: 4 },
      { name: 'Labor Solutions', category: 'Operational', sort_order: 5 },
    ],
  };

  const rows = sampleData[table.id] || [];

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="admin-back">← Back to Tables</button>
      <h3 style="font-size:16px;font-weight:700;margin:0;flex:1;">${table.name}</h3>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="admin-refresh" title="Refresh data from Supabase">🔄 Refresh</button>
    </div>
    <div style="margin-bottom:12px;padding:12px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:6px;">
      <div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;">Sample Data</div>
      <div style="font-size:12px;color:#166534;">Showing ${rows.length} of ${table.rowCount} configured records. Connect to Supabase to load live data.</div>
    </div>
    <div class="hub-card" style="padding:16px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--ies-gray-50);">
            ${table.columns.map(c => `<th style="text-align:left;padding:10px 12px;border-bottom:2px solid var(--ies-gray-200);font-weight:700;font-size:11px;text-transform:uppercase;color:var(--ies-gray-600);">${c.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, idx) => `
            <tr style="border-bottom:1px solid var(--ies-gray-100);${idx % 2 === 0 ? 'background:#fafafa;' : ''}">
              ${table.columns.map(c => {
                const val = row[c.key];
                let display = val;
                if (c.type === 'boolean') display = val ? '✓' : '✕';
                if (c.type === 'number') display = typeof val === 'number' ? val.toLocaleString() : val;
                return `<td style="padding:10px 12px;color:var(--ies-gray-700);">${display || '—'}</td>`;
              }).join('')}
            </tr>
          `).join('')}
          ${rows.length === 0 ? `<tr><td colspan="${table.columns.length}" style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No sample data available</td></tr>` : ''}
        </tbody>
      </table>
    </div>
  `;

  el.querySelector('#admin-back')?.addEventListener('click', () => { activeMasterTable = null; render(); });
  el.querySelector('#admin-refresh')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.disabled = true;
    const prior = btn.innerHTML;
    btn.innerHTML = '↻ Refreshing…';
    // Master tables currently render from the hardcoded sampleData map above.
    // When Supabase wiring lands, replace this with an api.listMasterTable()
    // call + re-render. For now we surface a toast instead of the old
    // `alert('Refreshing... (simulated)')` placeholder so the UX is clean.
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = prior;
      showToast('Sample data refreshed (live Supabase pull lands with master-table API)', 'info', { duration: 3500 });
    }, 450);
  });
}

// ===== USERS =====
// Removed in Slice 3.15 — rendered calc.DEMO_USERS (John Smith / Sarah Connor /
// etc.), which undermined credibility once real pilots were seated. The real
// roster lives in the User Activity tab (email, role, last login, usage).
// When real user management lands — invite, role-change, deactivate — it
// should reuse listUsers() from api.js, not re-introduce a demo surface.

// ===== USER ACTIVITY (Slice 3.13) =====
async function loadActivityData(forceRefresh = false) {
  if (_activityLoading) return;
  if (_activityLoaded && !forceRefresh) return;
  _activityLoading = true;
  try {
    const inputs = await api.loadUserActivityInputs({ days: _activityWindowDays });
    _activityRows = calc.summarizeUserActivity(inputs.profiles, inputs.events);
    _activityKpis = calc.activityKpis(_activityRows);
    _activityLoaded = true;
    _activityLastLoad = Date.now();
  } catch (err) {
    console.warn('[admin] activity load failed:', err);
    _activityRows = [];
    _activityKpis = null;
    _activityLoaded = true; // show empty state rather than spinning forever
  } finally {
    _activityLoading = false;
  }
}

function renderActivity(el) {
  // First paint: kick off load, show skeleton, re-render on completion.
  if (!_activityLoaded) {
    loadActivityData().then(() => renderActivity(el));
  }

  // Schedule a background refresh every 60s while this tab is open.
  if (_activityTimer) clearTimeout(_activityTimer);
  _activityTimer = setTimeout(async () => {
    await loadActivityData(true);
    // Only re-render if we're still on the activity tab and the root
    // element is still mounted — router swap may have moved on.
    if (activeTab === 'activity' && rootEl && rootEl.contains(el)) {
      renderActivity(el);
    }
  }, 60_000);

  const rows = _activityRows;
  const kpis = _activityKpis || {};
  const nowMs = Date.now();
  const loadingBanner = !_activityLoaded
    ? '<div class="hub-card" style="padding:12px;background:#fef3c7;color:#92400e;margin-bottom:12px;">Loading activity…</div>'
    : '';

  const kpi = (label, value, sub, color) => `
    <div class="hub-card" style="padding:12px 16px;">
      <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">${label}</div>
      <div style="font-size:22px;font-weight:800;color:${color || '#111827'};margin-top:2px;">${value}</div>
      ${sub ? `<div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">${sub}</div>` : ''}
    </div>
  `;

  const activeTotal = kpis.totalPilots != null ? `${kpis.activeWindow || 0} / ${kpis.totalPilots}` : '—';
  const onlineNow = kpis.onlineNow != null ? kpis.onlineNow : 0;
  const totalPV = kpis.pageViews != null ? kpis.pageViews : 0;
  const medSession = kpis.medianSessionMin != null ? `${kpis.medianSessionMin} min` : '—';
  const lastLoadRel = _activityLastLoad ? calc.relativeAgo(_activityLastLoad, nowMs) : 'never';

  el.innerHTML = `
    ${loadingBanner}
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <span style="font-size:13px;color:var(--ies-gray-400);">
        Window:
        <select data-activity-window style="font-size:12px;margin-left:6px;">
          ${[1, 7, 14, 30].map(d => `<option value="${d}" ${_activityWindowDays === d ? 'selected' : ''}>Last ${d}d</option>`).join('')}
        </select>
      </span>
      <span style="font-size:12px;color:var(--ies-gray-400);">
        ● ${onlineNow} online now · refreshed ${lastLoadRel}
      </span>
      <span style="flex:1;"></span>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-activity-refresh title="Re-fetch events from Supabase">🔄 Refresh</button>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
      ${kpi('Active pilots', activeTotal, `in last ${_activityWindowDays}d`, '#2563eb')}
      ${kpi('Online now', onlineNow, 'seen in last 15 min', onlineNow ? '#16a34a' : '#6b7280')}
      ${kpi('Page views', totalPV, `across pilots, ${_activityWindowDays}d`, '#7c3aed')}
      ${kpi('Median session', medSession, 'duration across pilots', '#d97706')}
    </div>

    <div class="hub-card" style="padding:16px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">User</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">Role</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">Last login</th>
            <th style="text-align:right;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">Sessions</th>
            <th style="text-align:right;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">Page views</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">Most-used</th>
            <th style="text-align:right;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">Median</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0 && _activityLoaded ? `
            <tr><td colspan="7" style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No activity yet. Events start landing as soon as a pilot loads the hub.</td></tr>
          ` : rows.map(r => {
            const roleColor = calc.roleBadgeColor(r.role);
            const noActivity = r.lastLogin === null;
            return `
            <tr style="border-bottom:1px solid var(--ies-gray-100);${r.onlineNow ? 'background:#ecfdf5;' : ''}">
              <td style="padding:8px;">
                <div style="font-weight:600;display:flex;align-items:center;gap:6px;">
                  ${r.onlineNow ? '<span title="Online now" style="width:7px;height:7px;border-radius:50%;background:#16a34a;display:inline-block;"></span>' : ''}
                  ${escapeHtml(r.displayName)}
                </div>
                <div style="font-size:11px;color:var(--ies-gray-400);">${escapeHtml(r.email || '')}</div>
              </td>
              <td style="padding:8px;">
                ${r.role && r.role !== '—' ? `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${roleColor};">${escapeHtml(r.role)}</span>` : '<span style="color:var(--ies-gray-400);font-size:12px;">—</span>'}
              </td>
              <td style="padding:8px;font-size:12px;${noActivity ? 'color:#dc2626;' : 'color:var(--ies-gray-400);'}">
                ${noActivity ? 'never' : calc.relativeAgo(r.lastLogin, nowMs)}
              </td>
              <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${r.sessionsInWindow || 0}</td>
              <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${r.pageViewsInWindow || 0}</td>
              <td style="padding:8px;font-size:12px;color:var(--ies-gray-400);">${r.mostUsedRoute ? escapeHtml(calc.humanRouteLabel(r.mostUsedRoute)) : '—'}</td>
              <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;${r.medianSessionMin == null ? 'color:var(--ies-gray-400);' : ''}">${r.medianSessionMin != null ? r.medianSessionMin + ' min' : '—'}</td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  el.querySelector('[data-activity-refresh]')?.addEventListener('click', async () => {
    await loadActivityData(true);
    if (activeTab === 'activity' && rootEl && rootEl.contains(el)) renderActivity(el);
  });
  el.querySelector('[data-activity-window]')?.addEventListener('change', async (e) => {
    const next = parseInt(/** @type {HTMLSelectElement} */ (e.target).value, 10);
    if (!Number.isFinite(next) || next <= 0) return;
    _activityWindowDays = next;
    await loadActivityData(true);
    if (activeTab === 'activity' && rootEl && rootEl.contains(el)) renderActivity(el);
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== ESCALATIONS =====
function renderEscalations(el) {
  const rules = calc.DEMO_ESCALATIONS;

  el.innerHTML = `
    <div class="hub-card" style="padding:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <span style="font-size:14px;font-weight:700;">Escalation Rules</span>
        <span style="font-size:11px;color:var(--ies-gray-400);">${rules.filter(r => r.active).length} active</span>
      </div>
      ${rules.map(r => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--ies-gray-100);">
          <span style="width:8px;height:8px;border-radius:50%;background:${r.active ? '#16a34a' : '#d1d5db'};"></span>
          <span style="font-size:13px;font-weight:600;flex:1;">${r.name}</span>
          <span style="font-size:11px;color:var(--ies-gray-400);">${r.metric} ${r.condition} ${r.threshold}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${calc.severityColor(r.severity)};">${r.severity}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ===== AUDIT LOG =====
// X15 Phase 2: real audit log state (replaces DEMO_AUDIT_LOG)
let _auditLogRows = [];
let _auditFacets = { tables: [], actions: [] };
let _auditFilter = { entityTable: '', action: '', limit: 200 };
let _auditLoaded = false;

async function loadAuditData() {
  try {
    const [rows, facets] = await Promise.all([
      api.listAuditLog(_auditFilter),
      api.listAuditFacets(),
    ]);
    _auditLogRows = rows;
    _auditFacets = facets;
    _auditLoaded = true;
  } catch (err) {
    console.warn('[admin] audit load failed:', err);
    _auditLogRows = [];
    _auditFacets = { tables: [], actions: [] };
    _auditLoaded = true;
  }
}

function renderAudit(el) {
  // Kick off load once per mount; re-render when it lands
  if (!_auditLoaded) {
    loadAuditData().then(() => renderAudit(el));
  }
  const log = _auditLogRows;
  // Normalize row shape for display. Slice 3.4: rows carry user_id (uuid)
  // when captured under real auth; user_email is the display mirror only.
  // Rows with no user_id are code-mode / pre-auth sessions — we label
  // them explicitly so the migration progress is easy to eyeball here.
  const rows = log.map(a => ({
    action:     a.action,
    tableName:  a.entity_table,
    recordId:   a.entity_id,
    userName:   a.user_id
      ? (a.user_email || a.user_id.slice(0, 8) + '…')
      : (a.user_email || 'Code session'),
    authed:     !!a.user_id,
    timestamp:  a.ts,
    fields:     a.changed_fields,
    sessionId:  a.session_id,
  }));
  const counts = rows.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
  const pendingBanner = !_auditLoaded
    ? '<div class="hub-card" style="padding:12px;background:#fef3c7;color:#92400e;margin-bottom:12px;">Loading audit log…</div>'
    : '';

  el.innerHTML = `
    ${pendingBanner}
    <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
      ${Object.entries(counts).map(([action, count]) => `
        <div class="hub-card" style="padding:8px 16px;text-align:center;">
          <div style="font-size:16px;font-weight:800;color:${calc.actionBadgeColor(action)};">${count}</div>
          <div style="font-size:11px;color:var(--ies-gray-400);text-transform:capitalize;">${action}s</div>
        </div>
      `).join('')}
      <div class="hub-card" style="padding:8px 16px;text-align:center;">
        <div style="font-size:16px;font-weight:800;">${rows.length}</div>
        <div style="font-size:11px;color:var(--ies-gray-400);">Rows shown (limit ${_auditFilter.limit})</div>
      </div>
    </div>

    <div class="hub-card" style="padding:12px;margin-bottom:12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
        Entity:
        <select data-audit-filter="entityTable" style="font-size:12px;">
          <option value="">All</option>
          ${_auditFacets.tables.map(t => `<option value="${t}" ${_auditFilter.entityTable === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
        Action:
        <select data-audit-filter="action" style="font-size:12px;">
          <option value="">All</option>
          ${_auditFacets.actions.map(a => `<option value="${a}" ${_auditFilter.action === a ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
        Limit:
        <select data-audit-filter="limit" style="font-size:12px;">
          <option value="100" ${_auditFilter.limit === 100 ? 'selected' : ''}>100</option>
          <option value="200" ${_auditFilter.limit === 200 ? 'selected' : ''}>200</option>
          <option value="500" ${_auditFilter.limit === 500 ? 'selected' : ''}>500</option>
          <option value="1000" ${_auditFilter.limit === 1000 ? 'selected' : ''}>1,000</option>
        </select>
      </label>
      <button class="hub-btn" data-audit-refresh>Refresh</button>
    </div>

    <div class="hub-card" style="padding:12px;">
      ${rows.length === 0 ? `
        <div style="padding:24px;text-align:center;color:var(--ies-gray-400);">
          <em>No audit rows${_auditFilter.entityTable || _auditFilter.action ? ' for current filter' : ''}.</em>
        </div>
      ` : `
        <table class="cm-grid-table" style="width:100%;font-size:12px;">
          <thead>
            <tr>
              <th style="text-align:left;width:160px;">When</th>
              <th style="text-align:left;width:70px;">Action</th>
              <th style="text-align:left;">Entity</th>
              <th style="text-align:left;width:120px;">Entity ID</th>
              <th style="text-align:left;width:180px;">User</th>
              <th style="text-align:left;">Changed Fields</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const fieldStr = r.fields && typeof r.fields === 'object'
                ? Object.keys(r.fields).slice(0, 5).join(', ') + (Object.keys(r.fields).length > 5 ? ` +${Object.keys(r.fields).length - 5}` : '')
                : '';
              return `
                <tr>
                  <td style="color:var(--ies-gray-500);">${calc.formatDateTime(r.timestamp)}</td>
                  <td><span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;color:#fff;background:${calc.actionBadgeColor(r.action)};">${r.action}</span></td>
                  <td><code style="font-size:11px;">${r.tableName || ''}</code></td>
                  <td style="color:var(--ies-gray-500);font-size:11px;">${r.recordId || ''}</td>
                  <td style="font-size:11px;" title="${r.authed ? 'Authenticated user (auth.uid)' : 'Pre-auth / code session'}">
                    ${r.authed ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;margin-right:6px;vertical-align:middle;"></span>' : ''}
                    ${r.userName}
                  </td>
                  <td style="font-size:11px;color:var(--ies-gray-500);" title="${JSON.stringify(r.fields || {}).replace(/"/g, '&quot;')}">${fieldStr}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;

  // Wire filter + refresh
  el.querySelectorAll('[data-audit-filter]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const k = sel.dataset.auditFilter;
      let v = sel.value;
      if (k === 'limit') v = Number(v) || 200;
      _auditFilter = { ..._auditFilter, [k]: v };
      _auditLoaded = false;
      renderAudit(el);
    });
  });
  el.querySelector('[data-audit-refresh]')?.addEventListener('click', () => {
    _auditLoaded = false;
    renderAudit(el);
  });
}

// ===== HELPERS =====
function kpi(label, value, color) {
  return `
    <div class="hub-card" style="padding:12px;text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${color};">${value}</div>
      <div style="font-size:11px;color:var(--ies-gray-400);font-weight:600;">${label}</div>
    </div>
  `;
}

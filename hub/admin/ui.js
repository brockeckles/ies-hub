/**
 * IES Hub v3 — Admin Panel UI
 * Master data management, user admin, escalation rules, and audit log.
 *
 * @module hub/admin/ui
 */

import { bus } from '../../shared/event-bus.js';
import * as calc from './calc.js';

/** @type {HTMLElement|null} */
let rootEl = null;
let activeTab = 'tables'; // tables | users | escalations | audit
let activeMasterTable = null;

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
        <h2 class="text-page" style="margin:0;">Admin Panel</h2>
        <div style="display:flex;gap:8px;" id="admin-tabs">
          ${['tables', 'users', 'escalations', 'audit'].map(t => `
            <button class="hub-btn hub-btn-sm ${t === activeTab ? '' : 'hub-btn-secondary'}" data-tab="${t}">${t === 'tables' ? 'Master Data' : t.charAt(0).toUpperCase() + t.slice(1)}</button>
          `).join('')}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        ${kpi('Users', `${stats.activeUsers}/${stats.totalUsers}`, '#2563eb')}
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

  switch (activeTab) {
    case 'tables': renderMasterData(el); break;
    case 'users': renderUsers(el); break;
    case 'escalations': renderEscalations(el); break;
    case 'audit': renderAudit(el); break;
  }
}

// ===== MASTER DATA =====
function renderMasterData(el) {
  if (activeMasterTable) { renderTableDetail(el); return; }

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
      ${calc.MASTER_TABLES.map(t => `
        <div class="hub-card" style="padding:16px;cursor:pointer;" data-table="${t.id}">
          <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${t.name}</div>
          <div style="font-size:12px;color:var(--ies-gray-400);margin-bottom:8px;">${t.description}</div>
          <div style="display:flex;gap:12px;font-size:11px;color:var(--ies-gray-400);">
            <span>${t.rowCount} records</span>
            <span>${t.columns.length} columns</span>
          </div>
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

  el.innerHTML = `
    <button class="hub-btn hub-btn-sm hub-btn-secondary" id="admin-back" style="margin-bottom:16px;">← Back to Tables</button>
    <div style="margin-bottom:12px;">
      <span style="font-size:16px;font-weight:700;">${table.name}</span>
      <span style="font-size:12px;color:var(--ies-gray-400);margin-left:8px;">${table.tableName}</span>
    </div>
    <div class="hub-card" style="padding:16px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>${table.columns.map(c => `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid var(--ies-gray-200);font-weight:700;font-size:11px;text-transform:uppercase;color:var(--ies-gray-400);">${c.label}</th>`).join('')}</tr>
        </thead>
        <tbody>
          <tr><td colspan="${table.columns.length}" style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">Connect to Supabase to view live data. ${table.rowCount} records configured.</td></tr>
        </tbody>
      </table>
    </div>
  `;

  el.querySelector('#admin-back')?.addEventListener('click', () => { activeMasterTable = null; render(); });
}

// ===== USERS =====
function renderUsers(el) {
  const users = calc.DEMO_USERS;
  const byRole = calc.usersByRole(users);

  el.innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:16px;">
      ${Object.entries(byRole).map(([role, count]) => `
        <div class="hub-card" style="padding:8px 16px;text-align:center;">
          <div style="font-size:16px;font-weight:800;color:${calc.roleBadgeColor(role)};">${count}</div>
          <div style="font-size:11px;color:var(--ies-gray-400);text-transform:capitalize;">${role}s</div>
        </div>
      `).join('')}
    </div>
    <div class="hub-card" style="padding:16px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);">Name</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);">Email</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);">Role</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);">Status</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-400);">Last Login</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => `
            <tr style="border-bottom:1px solid var(--ies-gray-100);">
              <td style="padding:8px;font-weight:600;">${u.displayName}</td>
              <td style="padding:8px;color:var(--ies-gray-400);">${u.email}</td>
              <td style="padding:8px;"><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${calc.roleBadgeColor(u.role)};">${u.role}</span></td>
              <td style="padding:8px;"><span style="color:${u.active ? '#16a34a' : '#dc2626'};font-weight:700;font-size:12px;">${u.active ? 'Active' : 'Inactive'}</span></td>
              <td style="padding:8px;font-size:12px;color:var(--ies-gray-400);">${calc.formatDateTime(u.lastLogin)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
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
function renderAudit(el) {
  const log = calc.DEMO_AUDIT_LOG;
  const counts = calc.auditActionCounts(log);

  el.innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:16px;">
      ${Object.entries(counts).map(([action, count]) => `
        <div class="hub-card" style="padding:8px 16px;text-align:center;">
          <div style="font-size:16px;font-weight:800;color:${calc.actionBadgeColor(action)};">${count}</div>
          <div style="font-size:11px;color:var(--ies-gray-400);text-transform:capitalize;">${action}s</div>
        </div>
      `).join('')}
    </div>
    <div class="hub-card" style="padding:16px;">
      ${log.map(a => `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--ies-gray-100);">
          <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${calc.actionBadgeColor(a.action)};">${a.action}</span>
          <span style="font-size:13px;flex:1;">${a.tableName} <span style="color:var(--ies-gray-400);">#${a.recordId}</span></span>
          <span style="font-size:12px;color:var(--ies-gray-500);">${a.userName}</span>
          <span style="font-size:11px;color:var(--ies-gray-400);">${calc.formatDateTime(a.timestamp)}</span>
        </div>
      `).join('')}
    </div>
  `;
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

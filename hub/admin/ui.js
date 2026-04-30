/**
 * IES Hub v3 — Admin Panel UI
 * Master data management, user admin, escalation rules, and audit log.
 *
 * @module hub/admin/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import * as calc from './calc.js?v=20260427-A3';
import * as api from './api.js?v=20260427-A4';
import { showToast } from '../../shared/toast.js?v=20260418-sK';
import { getEnv, getEnvLabel, getProjectRef } from '../../shared/supabase.js?v=20260429-demo-s3';
import { getBuildInfo, getBuildInfoSync } from '../../shared/build-info.js?v=20260424-A2';
import { showConfirm } from '../../shared/confirm-modal.js';

/** @type {HTMLElement|null} */
let rootEl = null;
let activeTab = 'tables'; // tables | activity | escalations | audit

/**
 * Env + version chip. Slice 4.2 (env) + Slice 4.4 (version suffix).
 * Sourced from shared/supabase.js (env) and shared/build-info.js (tag),
 * so there's one source of truth for both.
 *
 * Renders as "<dot> PROD · 2026.04.24-5f3dfcf" (green) or
 *            "<dot> STAGING · 2026.04.24-5f3dfcf" (orange).
 * If build-info hasn't resolved yet, only the env label shows; mount()
 * awaits getBuildInfo() and re-renders once it does.
 *
 * @returns {string} HTML snippet
 */
function renderEnvChip() {
  let env, label, ref;
  try { env = getEnv(); label = getEnvLabel(); ref = getProjectRef(); }
  catch { return ''; }
  const isProd = env === 'prod';
  const bg = isProd ? '#dcfce7' : '#ffedd5';
  const fg = isProd ? '#166534' : '#9a3412';
  const bd = isProd ? '#bbf7d0' : '#fed7aa';
  const dot = isProd ? '#16a34a' : '#ea580c';
  const info = getBuildInfoSync();
  const versionSuffix = info && info.tag && info.tag !== 'dev'
    ? `<span style="opacity:0.75;text-transform:none;font-weight:500;letter-spacing:0;">· ${info.tag}</span>`
    : '';
  const titleSuffix = info && info.tag ? ` · build ${info.tag}` : '';
  return `
    <span class="hub-env-chip" data-env="${env}" title="Supabase project: ${ref}${titleSuffix}"
      style="display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;
             background:${bg};color:${fg};border:1px solid ${bd};font-size:11px;font-weight:700;
             letter-spacing:0.04em;line-height:1;text-transform:uppercase;">
      <span style="width:6px;height:6px;border-radius:50%;background:${dot};display:inline-block;"></span>
      ${label}
      ${versionSuffix}
    </span>
  `;
}

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
  // Slice 4.4 — re-render once build-info resolves so the env chip
  // picks up the version suffix. Cheap no-op if already cached.
  getBuildInfo().then(() => { if (rootEl) render(); }).catch(() => {});
}

export function unmount() { rootEl = null; bus.emit('admin:unmounted'); }

function render() {
  if (!rootEl) return;
  const stats = calc.computeStats(calc.DEMO_USERS, calc.MASTER_TABLES, calc.DEMO_ESCALATIONS, calc.DEMO_AUDIT_LOG, '2026-04-16');

  rootEl.innerHTML = `
    <div class="hub-content-inner" style="padding:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <h2 class="text-page" style="margin:0;">Admin</h2>
          ${renderEnvChip()}
        </div>
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
      <div class="hub-kpi-strip" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:20px;">
        ${kpi('Tables', stats.totalTables)}
        ${kpi('Records', stats.totalRecords)}
        ${kpi('Active Rules', stats.activeEscalations, stats.activeEscalations > 0 ? 'var(--ies-orange)' : null)}
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
            <span data-count-for="${t.tableName}">📊 — records</span>
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

  // 2026-04-29: fetch live row counts in parallel and patch each card in
  // place so the static rowCount values from MASTER_TABLES never lie.
  const tableNames = calc.MASTER_TABLES.map(t => t.tableName).filter(Boolean);
  api.countMasterRecords(tableNames).then(counts => {
    for (const [tableName, count] of Object.entries(counts)) {
      const slot = el.querySelector(`[data-count-for="${tableName}"]`);
      if (!slot) continue;
      if (count == null) {
        slot.textContent = '📊 — records';
        slot.title = 'Count unavailable (table missing or RLS-blocked)';
      } else {
        slot.textContent = `📊 ${count.toLocaleString()} record${count === 1 ? '' : 's'}`;
        slot.removeAttribute('title');
      }
    }
  }).catch(err => {
    console.warn('[admin] live counts failed', err);
  });
}

// 2026-04-29: Master table detail is fully DB-backed via api.listMasterRecords.
// Add / Edit / Delete buttons wire through api.saveMasterRecord and
// api.deleteMasterRecord. Only admins can write (RLS enforced server-side;
// the buttons render for anyone but the save call will reject for non-admins).

const _masterDataCache = new Map();   // tableName -> rows[]
let _masterEditModal = null;

async function renderTableDetail(el) {
  const table = activeMasterTable;
  if (!table) return;

  // Render frame immediately with a loading state, then async-fetch + repaint.
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="admin-back">← Back to Tables</button>
      <h3 style="font-size:16px;font-weight:700;margin:0;flex:1;">${table.name}</h3>
      <button class="hub-btn hub-btn-sm" id="admin-add">+ Add</button>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="admin-refresh" title="Refresh from Supabase">↻ Refresh</button>
    </div>
    <div id="admin-table-body">
      <div style="padding: 32px; text-align: center; color: var(--ies-gray-400); font-size: 13px;">Loading…</div>
    </div>
    <div id="admin-modal-host"></div>
  `;
  el.querySelector('#admin-back').addEventListener('click', () => { activeMasterTable = null; render(); });
  el.querySelector('#admin-add').addEventListener('click', () => _openMasterEditModal(table, null));
  el.querySelector('#admin-refresh').addEventListener('click', () => {
    _masterDataCache.delete(table.tableName);
    renderTableDetail(el);
  });

  let rows = _masterDataCache.get(table.tableName);
  if (!rows) {
    try {
      rows = await api.listMasterRecords(table.tableName);
      _masterDataCache.set(table.tableName, rows);
    } catch (err) {
      console.warn('[admin] listMasterRecords failed', err);
      rows = [];
    }
  }
  _renderMasterTableBody(el, table, rows);
}

function _renderMasterTableBody(el, table, rows) {
  const body = el.querySelector('#admin-table-body');
  if (!body) return;
  body.innerHTML = `
    <div class="hub-card" style="padding:0;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--ies-gray-50);">
            ${table.columns.map(c => `<th style="text-align:left;padding:10px 12px;border-bottom:2px solid var(--ies-gray-200);font-weight:700;font-size:11px;text-transform:uppercase;color:var(--ies-gray-600);">${c.label}</th>`).join('')}
            <th style="text-align:right;padding:10px 12px;border-bottom:2px solid var(--ies-gray-200);font-weight:700;font-size:11px;text-transform:uppercase;color:var(--ies-gray-600);width:160px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${(rows || []).map((row, idx) => `
            <tr style="border-bottom:1px solid var(--ies-gray-100);${idx % 2 === 0 ? 'background:#fafafa;' : ''}">
              ${table.columns.map(c => {
                const val = row[c.key];
                let display = val;
                if (c.type === 'boolean') display = val ? '✓' : '✕';
                else if (c.type === 'number') display = (typeof val === 'number') ? val.toLocaleString() : (val ?? '—');
                else display = (val == null || val === '') ? '—' : String(val);
                return `<td style="padding:10px 12px;color:var(--ies-gray-700);">${display}</td>`;
              }).join('')}
              <td style="padding:8px 12px;text-align:right;white-space:nowrap;">
                <button class="hub-btn hub-btn-sm hub-btn-secondary" data-edit-id="${row.id || ''}" style="font-size:11px;margin-right:6px;">Edit</button>
                <button class="hub-btn hub-btn-sm hub-btn-secondary" data-delete-id="${row.id || ''}" style="font-size:11px;color:var(--ies-red);">Delete</button>
              </td>
            </tr>
          `).join('')}
          ${(!rows || rows.length === 0) ? `<tr><td colspan="${table.columns.length + 1}" style="padding:24px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No records yet — click <strong>+ Add</strong> to create the first.</td></tr>` : ''}
        </tbody>
      </table>
      <div style="padding: 8px 12px; font-size: 11px; color: var(--ies-gray-500); border-top: 1px solid var(--ies-gray-100); background: var(--ies-gray-50);">
        ${(rows || []).length} record${(rows || []).length === 1 ? '' : 's'} · table: <code>${table.tableName}</code>
      </div>
    </div>
  `;
  // Wire row-level actions
  body.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editId;
      const row = (rows || []).find(r => String(r.id) === String(id));
      if (row) _openMasterEditModal(table, row);
    });
  });
  body.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteId;
      if (!id) return;
      if (!(await showConfirm(`Delete this ${table.name.toLowerCase()} record? This cannot be undone.`))) return;
      try {
        await api.deleteMasterRecord(table.tableName, id);
        _masterDataCache.delete(table.tableName);
        renderTableDetail(rootEl.querySelector('#admin-content') || rootEl);
        showToast('Deleted', 'success', { duration: 2000 });
      } catch (err) {
        console.warn('[admin] delete failed', err);
        showToast('Delete failed: ' + (err.message || err), 'error');
      }
    });
  });
}

function _openMasterEditModal(table, row) {
  const isEdit = !!row;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9990;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;width:480px;max-width:92vw;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <div style="font-size:15px;font-weight:800;margin-bottom:14px;">${isEdit ? 'Edit' : 'Add'} ${table.name.replace(/s$/, '')}</div>
      <form id="master-form" style="display:flex;flex-direction:column;gap:10px;">
        ${table.columns.map(c => _masterFormField(c, row)).join('')}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
          <button type="button" class="hub-btn hub-btn-sm hub-btn-secondary" id="master-cancel">Cancel</button>
          <button type="submit" class="hub-btn hub-btn-sm">${isEdit ? 'Save changes' : 'Create'}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  _masterEditModal = overlay;

  const close = () => { overlay.remove(); _masterEditModal = null; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#master-cancel').addEventListener('click', close);

  const form = overlay.querySelector('#master-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {};
    for (const c of table.columns) {
      const input = form.querySelector(`[name="${c.key}"]`);
      if (!input) continue;
      let v;
      if (c.type === 'boolean')      v = input.checked;
      else if (c.type === 'number')  v = input.value === '' ? null : Number(input.value);
      else                            v = input.value === '' ? null : input.value;
      payload[c.key] = v;
    }
    try {
      await api.saveMasterRecord(table.tableName, isEdit ? row.id : null, payload);
      _masterDataCache.delete(table.tableName);
      close();
      renderTableDetail(rootEl.querySelector('#admin-content') || rootEl);
      showToast(isEdit ? 'Saved' : 'Created', 'success', { duration: 2000 });
    } catch (err) {
      console.warn('[admin] save failed', err);
      showToast('Save failed: ' + (err.message || err), 'error');
    }
  });

  // Focus first input
  const first = overlay.querySelector('input, select, textarea');
  if (first) first.focus();
}

function _masterFormField(c, row) {
  const v = row ? row[c.key] : '';
  const safe = (s) => String(s ?? '').replace(/"/g, '&quot;');
  const label = `<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.04em;">${c.label}${c.required ? ' *' : ''}`;
  const closeLabel = '</label>';
  if (c.type === 'boolean') {
    const checked = v ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ies-gray-700);font-weight:600;">
      <input type="checkbox" name="${c.key}" ${checked} />
      ${c.label}
    </label>`;
  }
  if (c.type === 'select' && Array.isArray(c.options)) {
    return `${label}<select class="hub-select" name="${c.key}" ${c.required ? 'required' : ''}>
      <option value="">—</option>
      ${c.options.map(opt => `<option value="${safe(opt)}" ${String(v) === String(opt) ? 'selected' : ''}>${safe(opt)}</option>`).join('')}
    </select>${closeLabel}`;
  }
  if (c.type === 'number') {
    return `${label}<input class="hub-input" type="number" step="any" name="${c.key}" value="${safe(v)}" ${c.required ? 'required' : ''} />${closeLabel}`;
  }
  return `${label}<input class="hub-input" type="text" name="${c.key}" value="${safe(v)}" ${c.required ? 'required' : ''} />${closeLabel}`;
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
    _activityRows = calc.summarizeUserActivity(inputs.profiles, inputs.events, { authLogins: inputs.authLogins });
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

  // Activity-tab tile reuses hub-kpi-tile + hub-kpi-tile__hint for the sub-line.
  const kpi = (label, value, sub, color) => `
    <div class="hub-kpi-tile">
      <div class="hub-kpi-tile__label">${label}</div>
      <div class="hub-kpi-tile__value"${color ? ` style="color:${color};"` : ''}>${value}</div>
      ${sub ? `<div class="hub-kpi-tile__hint">${sub}</div>` : ''}
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
        <select data-activity-window class="hub-select" style="width:auto;height:auto;font-size:12px;padding:4px 26px 4px 10px;margin-left:6px;">
          ${[1, 7, 14, 30].map(d => `<option value="${d}" ${_activityWindowDays === d ? 'selected' : ''}>Last ${d}d</option>`).join('')}
        </select>
      </span>
      <span style="font-size:12px;color:var(--ies-gray-400);">
        ● ${onlineNow} online now · refreshed ${lastLoadRel}
      </span>
      <span style="flex:1;"></span>
      <button class="hub-btn hub-btn-sm" data-activity-invite title="Invite a new pilot user via email">+ Invite user</button>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-activity-refresh title="Re-fetch events from Supabase">🔄 Refresh</button>
    </div>

    <div class="hub-kpi-strip" style="margin-bottom:16px;">
      ${kpi('Active pilots', activeTotal, `in last ${_activityWindowDays}d`)}
      ${kpi('Online now', onlineNow, 'seen in last 15 min', onlineNow ? 'var(--ies-green)' : null)}
      ${kpi('Page views', totalPV, `across pilots, ${_activityWindowDays}d`)}
      ${kpi('Median session', medSession, 'duration across pilots')}
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
              <td style="padding:8px;font-size:12px;${noActivity ? 'color:var(--ies-red);' : 'color:var(--ies-gray-400);'}">
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
  el.querySelector('[data-activity-invite]')?.addEventListener('click', () => {
    renderInviteUserModal({
      onSuccess: async () => {
        // New pilot = new row on the activity roster. Force-refresh so the
        // admin sees the invitee immediately (even though they haven't
        // accepted yet — profile row is pre-created by handle_new_user).
        await loadActivityData(true);
        if (activeTab === 'activity' && rootEl && rootEl.contains(el)) renderActivity(el);
      },
    });
  });
}

// ===== INVITE USER MODAL (Slice 3.16) =====
/**
 * Open the Invite User modal. Loads teams on first paint, validates inputs
 * client-side, calls api.inviteUser which POSTs to the invite-user edge
 * function. On success: toast + onSuccess callback (typically refresh
 * the User Activity roster). On failure: inline error, keep the modal open
 * so the admin can fix and retry.
 *
 * @param {{onSuccess?: () => void}} [opts]
 */
function renderInviteUserModal(opts = {}) {
  const { onSuccess } = opts;
  const existing = document.getElementById('hub-invite-user-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'hub-invite-user-overlay';
  overlay.className = 'hub-auth-overlay';
  overlay.style.background = 'rgba(10, 22, 40, 0.55)';
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-modal="true" aria-label="Invite user" style="text-align:left;max-width:440px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <h2 class="hub-auth-title" style="margin:0;font-size:18px;">Invite user</h2>
        <button type="button" id="iu-close" aria-label="Close"
          style="background:none;border:none;color:var(--ies-gray-500);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;">×</button>
      </div>
      <p class="hub-auth-subtitle" style="margin:0 0 14px 0;text-align:left;">
        Sends an email with a verification code. The invitee enters the code
        on the sign-in page and sets their own password.
      </p>

      <div class="hub-auth-error" id="iu-error" role="alert"></div>

      <div class="hub-auth-pane">
        <label class="hub-auth-label" for="iu-name">Full name</label>
        <input type="text" class="hub-input hub-auth-input" id="iu-name"
          autocomplete="off" placeholder="Jane Smith" />

        <label class="hub-auth-label" for="iu-email" style="margin-top:10px;">Email</label>
        <input type="email" class="hub-input hub-auth-input" id="iu-email"
          autocomplete="off" placeholder="name@gxo.com" spellcheck="false"
          autocapitalize="off" />

        <label class="hub-auth-label" for="iu-team" style="margin-top:10px;">Team</label>
        <select class="hub-input hub-auth-input" id="iu-team">
          <option value="">Loading teams…</option>
        </select>

        <label class="hub-auth-label" style="margin-top:10px;">Role</label>
        <div style="display:flex;gap:16px;margin-top:4px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
            <input type="radio" name="iu-role" value="member" checked />
            Member
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
            <input type="radio" name="iu-role" value="admin" />
            Admin
          </label>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
          <button type="button" class="hub-btn hub-btn-secondary" id="iu-cancel">Cancel</button>
          <button type="button" class="hub-btn hub-btn-primary" id="iu-submit">Send invite</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl   = /** @type {HTMLElement} */ (overlay.querySelector('#iu-error'));
  const nameInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#iu-name'));
  const emailInput= /** @type {HTMLInputElement} */ (overlay.querySelector('#iu-email'));
  const teamSel   = /** @type {HTMLSelectElement} */ (overlay.querySelector('#iu-team'));
  const submitBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#iu-submit'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#iu-cancel'));
  const closeBtn  = /** @type {HTMLButtonElement} */ (overlay.querySelector('#iu-close'));

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.color = '';
    errorEl.classList.add('visible');
  }
  function showInfo(msg) {
    errorEl.textContent = msg;
    errorEl.style.color = 'var(--ies-blue)';
    errorEl.classList.add('visible');
  }
  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
    errorEl.style.color = '';
  }
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  // Load teams async. Default-select Solutions Design if present (most
  // invites will be members of the founder team).
  (async () => {
    try {
      const teams = await api.listTeams();
      teamSel.innerHTML = teams.length
        ? teams.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
        : '<option value="">No teams yet</option>';
      const sd = teams.find(t => t.name === 'Solutions Design');
      if (sd) teamSel.value = sd.id;
    } catch (err) {
      teamSel.innerHTML = '<option value="">Could not load teams</option>';
      showError('Could not load teams: ' + (err?.message || err));
    }
  })();

  async function attemptInvite() {
    clearError();
    const full_name = nameInput.value.trim();
    const email     = emailInput.value.trim().toLowerCase();
    const team_id   = teamSel.value;
    const roleEl    = /** @type {HTMLInputElement} */ (overlay.querySelector('input[name="iu-role"]:checked'));
    const role      = roleEl?.value || 'member';

    if (!full_name) { showError('Enter a name'); nameInput.focus(); return; }
    if (!email)     { showError('Enter an email'); emailInput.focus(); return; }
    if (!team_id)   { showError('Pick a team'); teamSel.focus(); return; }

    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = 'Sending…';
    try {
      const res = await api.inviteUser({ email, full_name, team_id, role });
      if (!res.ok) {
        // Map known codes to friendlier text.
        if (res.code === 'already_exists') {
          showError(`${email} already has an account. Use "Forgot password?" to send them a reset code.`);
        } else if (res.code === 'not_admin') {
          showError('Only admins can invite users.');
        } else {
          showError(res.error || 'Invite failed');
        }
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = orig;
        return;
      }
      showInfo(`Invite sent to ${email}. They should receive an email with a code.`);
      showToast(`Invite sent to ${email}`, 'success', { duration: 4000 });
      setTimeout(() => {
        if (typeof onSuccess === 'function') onSuccess();
        close();
      }, 900);
    } catch (err) {
      showError(err?.message || 'Unknown error');
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = orig;
    }
  }

  submitBtn.addEventListener('click', attemptInvite);
  for (const el of [nameInput, emailInput]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptInvite();
      else clearError();
    });
  }

  setTimeout(() => nameInput.focus(), 50);
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
        <select data-audit-filter="entityTable" class="hub-select" style="width:auto;height:auto;font-size:12px;padding:4px 26px 4px 10px;">
          <option value="">All</option>
          ${_auditFacets.tables.map(t => `<option value="${t}" ${_auditFilter.entityTable === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
        Action:
        <select data-audit-filter="action" class="hub-select" style="width:auto;height:auto;font-size:12px;padding:4px 26px 4px 10px;">
          <option value="">All</option>
          ${_auditFacets.actions.map(a => `<option value="${a}" ${_auditFilter.action === a ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
        Limit:
        <select data-audit-filter="limit" class="hub-select" style="width:auto;height:auto;font-size:12px;padding:4px 26px 4px 10px;">
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
  // 2026-04-29 polish — emit hub-kpi-tile so the strip aligns with the rest
  // of the hub. Optional color preserved for threshold semantics.
  const valueStyle = color ? ` style="color:${color};"` : '';
  return `
    <div class="hub-kpi-tile">
      <div class="hub-kpi-tile__label">${label}</div>
      <div class="hub-kpi-tile__value"${valueStyle}>${value}</div>
    </div>
  `;
}

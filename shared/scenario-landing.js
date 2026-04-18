/**
 * IES Hub v3 — Unified Scenario Landing
 *
 * Every Design Tool that saves scenarios (Cost Model, WSC, NetOpt, Fleet,
 * COG, MOST) uses this renderer as its first screen. Instead of dropping
 * the user into a cold-start blank form, we show a grid of saved scenarios
 * with a clear "Stand-alone" vs "Linked to CM/Deal" indicator and a
 * prominent "+ New Scenario" button.
 *
 * Usage from a tool's ui.js:
 *
 *   import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=...';
 *   await renderScenarioLanding(rootEl, {
 *     toolName: 'Warehouse Sizing',
 *     toolKey: 'wsc',               // key for CSS scoping + analytics
 *     accent: '#0047AB',             // color accent for header + new-button
 *     list: () => api.listConfigs(),
 *     getId:       (row) => row.id,
 *     getName:     (row) => row.name || row.config_data?.name || 'Untitled',
 *     getUpdated:  (row) => row.updated_at || row.created_at,
 *     getParent:   (row) => ({ cmId: row.parent_cost_model_id, dealId: row.parent_deal_id }),
 *     getSubtitle: (row) => ...,     // optional — a one-liner shown under the name
 *     onOpen:  (row) => mountEditor(row),   // load scenario into editor
 *     onNew:   ()    => mountEditor(null),  // create new blank
 *     onCopy:  async (row) => { ... },       // optional
 *     onDelete: async (row) => { ... },      // optional
 *   });
 *
 * The function replaces rootEl's contents and wires all the event handlers.
 *
 * @module shared/scenario-landing
 */

import { db } from './supabase.js?v=20260418-sH';
import { showToast } from './toast.js?v=20260418-sH';

/**
 * @param {HTMLElement} rootEl
 * @param {object} opts
 */
export async function renderScenarioLanding(rootEl, opts) {
  const {
    toolName,
    toolKey,
    accent = '#ff3a00',
    list,
    getId = (r) => r.id,
    getName = (r) => r.name || 'Untitled',
    getUpdated = (r) => r.updated_at || r.created_at,
    getParent = (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id }),
    getSubtitle = null,
    onOpen,
    onNew,
    onCopy = null,
    onDelete = null,
    emptyStateHint = '',
  } = opts;

  if (!rootEl || typeof list !== 'function' || typeof onOpen !== 'function' || typeof onNew !== 'function') {
    console.error('[scenario-landing] missing required opts');
    return;
  }

  rootEl.innerHTML = renderLoading(toolName);

  // Fetch scenarios + all cost model names (for linkage label lookup) in parallel.
  let scenarios = [];
  let costModelsById = new Map();
  try {
    const [rows, cms] = await Promise.all([
      list().catch(err => { console.warn(`[${toolKey}-landing] list failed`, err); return []; }),
      db.fetchAll('cost_model_projects').catch(() => []),
    ]);
    scenarios = Array.isArray(rows) ? rows : [];
    for (const cm of (cms || [])) {
      costModelsById.set(String(cm.id), cm.name || cm.client_name || `CM #${cm.id}`);
    }
  } catch (err) {
    console.warn(`[${toolKey}-landing] load failed`, err);
  }

  rootEl.innerHTML = renderShell({
    toolName, toolKey, accent, scenarios, costModelsById,
    getId, getName, getUpdated, getParent, getSubtitle,
    canCopy: typeof onCopy === 'function',
    canDelete: typeof onDelete === 'function',
    emptyStateHint,
  });

  // ---- Event wiring ----
  rootEl.addEventListener('click', async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);

    // + New Scenario
    if (t.closest('[data-sl-action="new"]')) {
      onNew();
      return;
    }

    // Open a scenario (row click, excluding action buttons).
    const row = t.closest('[data-sl-id]');
    const actionBtn = t.closest('[data-sl-row-action]');
    if (row && !actionBtn) {
      const id = row.dataset.slId;
      const scenario = scenarios.find(s => String(getId(s)) === String(id));
      if (scenario) onOpen(scenario);
      return;
    }

    // Row action: copy
    if (actionBtn && actionBtn.dataset.slRowAction === 'copy') {
      e.stopPropagation();
      const id = actionBtn.closest('[data-sl-id]').dataset.slId;
      const scenario = scenarios.find(s => String(getId(s)) === String(id));
      if (!scenario || !onCopy) return;
      try {
        await onCopy(scenario);
        showToast(`${toolName} scenario copied`, 'success');
        // Refresh landing.
        await renderScenarioLanding(rootEl, opts);
      } catch (err) {
        showToast(`Copy failed: ${err?.message || err}`, 'error');
      }
      return;
    }

    // Row action: delete
    if (actionBtn && actionBtn.dataset.slRowAction === 'delete') {
      e.stopPropagation();
      const id = actionBtn.closest('[data-sl-id]').dataset.slId;
      const scenario = scenarios.find(s => String(getId(s)) === String(id));
      if (!scenario || !onDelete) return;
      const name = getName(scenario);
      if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
      try {
        await onDelete(scenario);
        showToast(`Deleted "${name}"`, 'success');
        await renderScenarioLanding(rootEl, opts);
      } catch (err) {
        showToast(`Delete failed: ${err?.message || err}`, 'error');
      }
      return;
    }
  });
}

function renderLoading(toolName) {
  return `<div class="hub-content-inner" style="padding:24px;">
    <div style="text-align:center;padding:40px;color:var(--ies-gray-400);font-size:13px;">Loading ${escapeText(toolName)} scenarios…</div>
  </div>`;
}

function renderShell({
  toolName, toolKey, accent, scenarios, costModelsById,
  getId, getName, getUpdated, getParent, getSubtitle,
  canCopy, canDelete, emptyStateHint,
}) {
  const total = scenarios.length;
  const linked = scenarios.filter(s => {
    const p = getParent(s) || {};
    return p.cmId || p.dealId;
  }).length;
  const standalone = total - linked;

  return `
    <div class="hub-content-inner" style="padding:24px;max-width:1200px;">
      <style>
        .sl-row { transition: background .12s ease, transform .12s ease; }
        .sl-row:hover { background: var(--ies-gray-50); }
        .sl-row:hover [data-sl-row-action] { opacity: 1; }
      </style>

      <a href="#designtools" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ies-gray-500);text-decoration:none;margin-bottom:8px;" onmouseover="this.style.color='${accent}'" onmouseout="this.style.color='var(--ies-gray-500)'">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Design Tools
      </a>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap;">
        <div>
          <h1 class="text-page" style="margin:0;">${escapeText(toolName)}</h1>
          <p style="margin:4px 0 0;font-size:12px;color:var(--ies-gray-500);">
            ${total} scenario${total === 1 ? '' : 's'} saved
            ${total > 0 ? `· <strong style="color:${accent};">${linked}</strong> linked, <strong>${standalone}</strong> stand-alone` : ''}
          </p>
        </div>
        <button type="button" data-sl-action="new" class="hub-btn hub-btn-primary" style="font-weight:700;">
          + New Scenario
        </button>
      </div>

      ${total === 0 ? renderEmpty(toolName, accent, emptyStateHint) : `
        <div class="hub-card" style="padding:0;overflow:hidden;">
          <div style="display:grid;grid-template-columns:minmax(240px,2fr) 1fr 160px 120px;gap:0;padding:10px 16px;background:var(--ies-gray-50);border-bottom:1px solid var(--ies-gray-200);font-size:11px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:.04em;">
            <div>Scenario</div>
            <div>Linkage</div>
            <div>Last updated</div>
            <div style="text-align:right;">Actions</div>
          </div>
          ${scenarios.map(s => renderRow({
            s, accent, costModelsById,
            getId, getName, getUpdated, getParent, getSubtitle,
            canCopy, canDelete,
          })).join('')}
        </div>
      `}
    </div>
  `;
}

function renderEmpty(toolName, accent, hint) {
  return `
    <div class="hub-card" style="padding:48px 24px;text-align:center;">
      <div style="font-size:15px;font-weight:700;color:var(--ies-gray-700);margin-bottom:8px;">No ${escapeText(toolName)} scenarios yet</div>
      <p style="font-size:13px;color:var(--ies-gray-500);margin:0 auto 20px;max-width:460px;line-height:1.5;">
        ${hint ? escapeText(hint) : `Start a new scenario to build your first ${escapeText(toolName)} analysis. Scenarios save automatically as you work and can be linked to a cost model or deal later.`}
      </p>
      <button type="button" data-sl-action="new" class="hub-btn hub-btn-primary" style="font-weight:700;">
        + Start New Scenario
      </button>
    </div>
  `;
}

function renderRow({ s, accent, costModelsById, getId, getName, getUpdated, getParent, getSubtitle, canCopy, canDelete }) {
  const id = getId(s);
  const name = getName(s) || 'Untitled';
  const updatedRaw = getUpdated(s);
  const updated = updatedRaw ? formatRelative(updatedRaw) : '—';
  const parent = getParent(s) || {};
  const cmName = parent.cmId ? (costModelsById.get(String(parent.cmId)) || `CM #${parent.cmId}`) : null;
  const subtitle = typeof getSubtitle === 'function' ? getSubtitle(s) : '';

  return `
    <div class="sl-row" data-sl-id="${escapeAttr(id)}" style="display:grid;grid-template-columns:minmax(240px,2fr) 1fr 160px 120px;gap:0;padding:12px 16px;border-bottom:1px solid var(--ies-gray-100);cursor:pointer;align-items:center;">
      <div>
        <div style="font-size:14px;font-weight:700;color:#1c1c1c;">${escapeText(name)}</div>
        ${subtitle ? `<div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">${escapeText(subtitle)}</div>` : ''}
      </div>
      <div>${linkageBadge(parent, cmName, accent)}</div>
      <div style="font-size:12px;color:var(--ies-gray-600);">${escapeText(updated)}</div>
      <div style="text-align:right;display:flex;gap:4px;justify-content:flex-end;">
        ${canCopy ? `<button type="button" data-sl-row-action="copy" aria-label="Copy" title="Copy" style="opacity:0;transition:opacity .12s ease;border:1px solid var(--ies-gray-200);background:#fff;border-radius:6px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ies-gray-600);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>` : ''}
        ${canDelete ? `<button type="button" data-sl-row-action="delete" aria-label="Delete" title="Delete" style="opacity:0;transition:opacity .12s ease;border:1px solid var(--ies-gray-200);background:#fff;border-radius:6px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#dc2626;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>` : ''}
      </div>
    </div>
  `;
}

function linkageBadge(parent, cmName, accent) {
  if (parent.cmId) {
    return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:11px;font-weight:700;max-width:100%;">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">CM: ${escapeText(cmName || `#${parent.cmId}`)}</span>
    </span>`;
  }
  if (parent.dealId) {
    return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;font-size:11px;font-weight:700;max-width:100%;">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Deal: ${escapeText(parent.dealId)}</span>
    </span>`;
  }
  return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:var(--ies-gray-50);border:1px solid var(--ies-gray-200);color:var(--ies-gray-500);font-size:11px;font-weight:600;">
    <span style="width:6px;height:6px;border-radius:50%;background:var(--ies-gray-300);"></span>
    Stand-alone
  </span>`;
}

function formatRelative(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const h = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    if (h < 1) return 'Just now';
    if (h < 24) return `${h}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 365 ? 'numeric' : undefined });
  } catch { return '—'; }
}

function escapeText(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeText(s); }

export default { renderScenarioLanding };

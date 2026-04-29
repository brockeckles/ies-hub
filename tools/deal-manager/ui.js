/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) UI
 * Analyzer-pattern layout: landing view (Kanban/List), then per-deal detail views.
 * Tabs: Summary, Sites, Financials, Pipeline, Hours, Tasks, Updates.
 *
 * @module tools/deal-manager/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sL';
import { state } from '../../shared/state.js?v=20260418-sL';
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents } from '../../shared/tool-chrome.js?v=20260429-tc2-dm';
import * as calc from './calc.js?v=20260426-s3';
import * as api from './api.js?v=20260427-pm3-s2';
import * as cmApi from '../cost-model/api.js?v=20260429-vol10';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'list' | 'summary' | 'sites' | 'financials' | 'sensitivity' | 'compare' | 'pipeline' | 'hours' | 'tasks' | 'updates'} */
let activeTab = 'list';
// MUL-D1/D3/D4 — deal-financial overrides (per-session, applied to the
// active deal). UI exposes these in the Financials tab.
let dealConfig = {
  ebitdaOverheadPct: 8,
  discountRate: 10,         // expressed as percent (UI), divided by 100 inside calc
  escalationRevenuePct: 3,
  escalationCostPct: 3,
  scoreWeights: { margin: 0.35, ebitda: 0.25, payback: 0.20, npv: 0.20 },
  gradeThresholds: { A: 90, B: 75, C: 60, D: 45 },
};
// MUL-G1 — drag-to-combine state. tracks the deal currently being dragged
// (id) and shows a combined-preview when dropped on another deal card.
let dragSourceDealId = null;
// Last drag target (for combined-preview reveal)
let combineResult = null;
// MUL-G3 — sensitivity grid axes/ranges (per-session)
let sensCfg = {
  xAxis: 'costPct', yAxis: 'marginPct',
  xRange: [-10, -5, 0, 5, 10],
  yRange: [-3, -1.5, 0, 1.5, 3],
};
// MUL-G2 — selected deal IDs for side-by-side comparison
let compareDealIds = [];

/** Removed 2026-04-29 — Kanban view dropped from Multi-Site. */

/** @type {import('./types.js?v=20260418-sL').Deal|null} */
let activeDeal = null;

/** @type {import('./types.js?v=20260418-sL').Site[]} */
let sites = [];

/** @type {import('./types.js?v=20260418-sL').DealFinancials|null} */
let financials = null;

/** @type {import('./types.js?v=20260418-sL').DosStage[]} */
let dosStages = [];

/**
 * MUL-F2 cache: DB-loaded stage templates. Loaded on first openDeal,
 * memoized for the lifetime of the mount. Falls back to calc.DOS_STAGES
 * (a constant) when the DB read fails (e.g. staging schema drift, RLS,
 * offline). Each stage carries `elements: [...]` populated from
 * stage_element_templates.
 *
 * @type {{ templateVersion: { id:number, version:number, version_name:string|null }|null,
 *          stages: Array<{ id:number, stage_number:number, stage_name:string,
 *                          description:string|null, element_count:number,
 *                          elements: Array<Object> }> } | null}
 */
let stageTemplateBundle = null;
/** @type {'fresh'|'pending'|'fallback'} */
let stageTemplateSource = 'fresh';

/** @type {import('./types.js?v=20260418-sL').Deal[]} */
let allDeals = [];

/** @type {import('./types.js?v=20260418-sL').HoursEntry[]} */
let hoursEntries = [];

/** @type {import('./types.js?v=20260418-sL').Task[]} */
let tasks = [];

/** @type {import('./types.js?v=20260418-sL').WeeklyUpdate[]} */
let updates = [];

// DOS stages reference (6 stages: Pre-Sales → Delivery)
const DOS_STAGE_LABELS = [
  { number: 1, name: 'Pre-Sales Engagement' },
  { number: 2, name: 'Deal Qualification' },
  { number: 3, name: 'Kick-Off & Solution Design' },
  { number: 4, name: 'Operations Review' },
  { number: 5, name: 'Executive Review' },
  { number: 6, name: 'Delivery Handover' },
];

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Deal Manager.
 * @param {HTMLElement} el
 */
/**
 * Handle to the bus.on('cm:model-saved') subscription so we can unsubscribe
 * on unmount. Without this the listener leaks across mount/unmount cycles.
 */
let _cmSavedUnsub = null;

export async function mount(el) {
  rootEl = el;
  activeTab = 'list';
  activeDeal = null;
  sites = [];
  financials = null;
  dosStages = [];
  allDeals = [];
  // 2026-04-21 audit fix: no auto-loaded demo deal. Users now see an empty
  // state with a "Load Sample Deal" button in the action rail, or can click
  // "+ New Deal" to start a real multi-site analysis from scratch.
  el.innerHTML = renderShell();
  bindShellEvents();
  renderContent();

  // Multi-Site B4: when a linked CM is saved elsewhere in the app, re-pull
  // the fresh totals + cost breakdown for any site referencing it. Without
  // this, editing a CM never propagates to the deal-level P&L until the
  // user re-navigates to Multi-Site and re-links the CM.
  _cmSavedUnsub = bus.on('cm:model-saved', handleCmSaved);

  bus.emit('deal:mounted');
}

/**
 * Cleanup.
 */
export function unmount() {
  if (typeof _cmSavedUnsub === 'function') { _cmSavedUnsub(); _cmSavedUnsub = null; }
  rootEl = null;
  // Reset MUL-F2 stage-template cache so the next mount reloads fresh.
  stageTemplateBundle = null;
  stageTemplateSource = 'fresh';
  bus.emit('deal:unmounted');
}

/**
 * Refresh any site whose costModelId matches the just-saved CM. Pulls the
 * canonical annual cost + sqft + cost breakdown from Supabase, mutates the
 * in-memory sites array, re-computes deal financials, and re-renders the
 * active tab. No-ops if the saved CM isn't linked to any site (common case).
 *
 * @param {{ id: string|number }} payload — from cost-model/ui.js bus.emit
 */
async function handleCmSaved(payload) {
  if (!payload || !payload.id) return;
  if (!activeDeal || !sites || !sites.length) return;

  // Find all sites linked to this CM. Normalize to string to match
  // mapCmProjectToSite — IDs are bigints in Postgres, strings in memory.
  const savedId = String(payload.id);
  const affectedIdx = [];
  sites.forEach((s, i) => {
    if (s.costModelId && String(s.costModelId) === savedId) affectedIdx.push(i);
  });
  if (!affectedIdx.length) return;

  // Pull fresh project row + breakdown in parallel.
  try {
    const [project, breakdown] = await Promise.all([
      cmApi.getModel(payload.id),
      api.fetchCostModelBreakdown(payload.id),
    ]);
    for (const idx of affectedIdx) {
      const s = sites[idx];
      sites[idx] = {
        ...s,
        // Only overwrite derived fields — preserve name, pricing model,
        // margin, user-typed volumes, etc.
        sqft: project?.facility_sqft || s.sqft || 0,
        annualCost: project?.total_annual_cost || s.annualCost || 0,
        costBreakdown: breakdown || s.costBreakdown,
      };
    }
    financials = calc.computeDealFinancials(sites, activeDeal.contractTermYears || 5);
    renderContent();
    // Nudge the user so it's obvious something changed without being
    // disruptive — small toast on the active tab.
    try {
      const { showToast } = await import('../../shared/toast.js?v=20260420-vE');
      showToast(`Refreshed ${affectedIdx.length} site${affectedIdx.length > 1 ? 's' : ''} from updated cost model`, 'info');
    } catch { /* toast is best-effort; don't break the refresh on import failure */ }
  } catch (err) {
    console.warn('[Multi-Site] Failed to refresh site(s) after CM save:', err);
  }
}

// ============================================================
// SHELL
// ============================================================

// Detail-mode tab definitions (used by header)

// ============================================================
// CHROME v3 — phase + section structure (CM Chrome v3 ripple, step 3 redo)
// ============================================================
// Multi-Site has two distinct shapes:
//   - Landing: portfolio view — list / kanban toggle, no active deal.
//   - Detail: deal-level view — 9 sub-tabs grouped into 4 phases.
// _buildDmChromeOpts() branches on isLandingView() to produce the
// correct chrome opts for each.
const DM_DETAIL_GROUPS = [
  { key: 'overview',    label: 'Overview',    description: 'Deal-level rollup' },
  { key: 'composition', label: 'Composition', description: 'Sites & financials' },
  { key: 'analysis',    label: 'Analysis',    description: 'Sensitivity & compare' },
  { key: 'workflow',    label: 'Workflow',    description: 'DOS pipeline, hours, tasks, updates' },
];
const DM_DETAIL_SECTIONS = [
  { key: 'summary',     label: 'Summary',     group: 'overview' },
  { key: 'sites',       label: 'Sites',       group: 'composition' },
  { key: 'financials',  label: 'Financials',  group: 'composition' },
  { key: 'sensitivity', label: 'Sensitivity', group: 'analysis' },
  { key: 'compare',     label: 'Compare',     group: 'analysis' },
  { key: 'pipeline',    label: 'Pipeline',    group: 'workflow' },
  { key: 'hours',       label: 'Hours',       group: 'workflow' },
  { key: 'tasks',       label: 'Tasks',       group: 'workflow' },
  { key: 'updates',     label: 'Updates',     group: 'workflow' },
];
const DM_LANDING_GROUPS = [
  { key: 'portfolio', label: 'Portfolio', description: 'Multi-deal portfolio view' },
];
// 2026-04-29 (Brock): Kanban view removed from Multi-Site — pipeline-stage
// management belongs to hub/deal-management, not the analyzer.
const DM_LANDING_SECTIONS = [];

const DETAIL_TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'sites', label: 'Sites' },
  { key: 'financials', label: 'Financials' },
  { key: 'sensitivity', label: 'Sensitivity' },
  { key: 'compare', label: 'Compare' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'hours', label: 'Hours' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'updates', label: 'Updates' },
];

function isLandingView() {
  return activeTab === 'list';
}

function renderShell() {
  // CM Chrome v3 ripple — chrome HTML+CSS lives in shared/tool-chrome.js.
  return renderToolChrome(_buildDmChromeOpts());
}

/** Build chrome opts from current Multi-Site state. */
function _buildDmChromeOpts() {
  const landing = isLandingView();

  if (landing) {
    const activeSection = null; // landing has no section pills now
    const actions = [
      { id: 'dm-load-sample',
        label: 'Load Sample Deal',
        title: 'Seed a sample multi-site deal so you can see what a populated analysis looks like',
        hidden: allDeals.length > 0 },
      { id: 'dm-new-deal',
        label: '+ New Deal',
        title: 'Start a new multi-site deal',
        primary: true },
    ];
    return {
      toolKey: 'dm',
      groups: DM_LANDING_GROUPS,
      sections: DM_LANDING_SECTIONS,
      activePhase: 'portfolio',
      activeSection,
      sectionCompleteness: () => 'complete',
      saveState: null,
      actions,
      showSidebar: false,
      showSidebarToggle: false,
      sidebarHeader: 'All Sections',
      sidebarBody: '',
      bodyHtml: '<div id="dm-content" style="overflow-y:auto;padding:24px;height:100%;"></div>',
      backTitle: 'Back to Design Tools',
      emptyPhaseHint: '',
    };
  }

  // Detail mode.
  const sec = DM_DETAIL_SECTIONS.find(s => s.key === activeTab) || DM_DETAIL_SECTIONS[0];
  const activePhase = sec.group;
  return {
    toolKey: 'dm',
    groups: DM_DETAIL_GROUPS,
    sections: DM_DETAIL_SECTIONS,
    activePhase,
    activeSection: activeTab,
    sectionCompleteness: () => 'complete',
    saveState: null,
    actions: [],
    showSidebar: false,
    showSidebarToggle: false,
    sidebarHeader: 'All Sections',
    sidebarBody: '',
    bodyHtml: '<div id="dm-content" style="overflow-y:auto;padding:24px;height:100%;"></div>',
    backTitle: activeDeal ? ('Back to All Deals · ' + (activeDeal.dealName || 'Untitled')) : 'Back to All Deals',
    emptyPhaseHint: '',
  };
}

function bindShellEvents() {
  if (!rootEl) return;
  rootEl.__tcBound = false;

  bindToolChromeEvents(rootEl, {
    onPhase: (phaseKey) => {
      // Detail-mode only: jump to the first section of the new phase.
      if (isLandingView()) return;
      const sectionsInPhase = DM_DETAIL_SECTIONS.filter(s => s.group === phaseKey);
      const first = sectionsInPhase[0];
      if (first && first.key !== activeTab) {
        activeTab = /** @type {any} */ (first.key);
        renderContent();
        refreshToolChrome(rootEl, _buildDmChromeOpts());
      }
    },
    onSection: (key) => {
      if (isLandingView()) return; // Landing has no sub-sections
      if (key !== activeTab) {
        activeTab = /** @type {any} */ (key);
        renderContent();
        refreshToolChrome(rootEl, _buildDmChromeOpts());
      }
    },
    onBack: () => {
      if (isLandingView()) {
        // Landing-mode back — return to Design Tools hub.
        window.location.hash = 'designtools';
      } else {
        // Detail-mode back — return to deal list.
        activeTab = 'list';
        activeDeal = null;
        rerenderShell();
      }
    },
    onAction: (id) => {
      if (id === 'dm-new-deal') return createNewDeal();
      if (id === 'dm-load-sample') {
        allDeals = [{ ...calc.DEMO_DEAL, id: 'demo-deal-1' }];
        rerenderShell();
        bus.emit('deal:sample-loaded');
        return;
      }
    },
  });

  // Content-area click delegation — for in-content interactions (delete
  // weekly update, edit task) that the chrome doesn't know about.
  rootEl.addEventListener('click', _dmContentClickHandler);
}

/** @param {Event} e */
function _dmContentClickHandler(e) {
  if (!rootEl) return;
  const target = /** @type {HTMLElement} */ (e.target);
  if (!target || !target.closest) return;

  // Delete weekly update.
  const delUpdateBtn = /** @type {HTMLElement|null} */ (target.closest('[data-action="dm-delete-update"]'));
  if (delUpdateBtn) {
    const updateId = delUpdateBtn.dataset.updateId;
    if (updateId && activeDeal && window.confirm('Delete this weekly update? This cannot be undone.')) {
      (async () => {
        try {
          await api.deleteUpdate(updateId);
          updates = await api.fetchUpdates(activeDeal.id);
          const el = rootEl?.querySelector('#dm-content');
          if (el) renderUpdatesTab(el);
        } catch (err) {
          console.error('[DM] delete update failed:', err);
          alert('Failed to delete update — check console.');
        }
      })();
    }
    return;
  }

  // Edit task (opens inline modal).
  const editTaskBtn = /** @type {HTMLElement|null} */ (target.closest('[data-action="dm-edit-task"]'));
  if (editTaskBtn) {
    const taskId = editTaskBtn.dataset.taskId;
    const task = tasks.find(t => String(t.id) === String(taskId));
    if (task) showEditTaskModal(task);
    return;
  }
}



/**
 * Simple edit modal for an existing task. Closes a P0 stub (button was wired
 * to `onclick="alert('Edit task')"` before 2026-04-21 audit). Reuses the same
 * modal/form pattern as `showNewUpdateModal`.
 */
function showEditTaskModal(task) {
  if (!activeDeal) return;
  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:560px;">
      <h3 style="margin:0 0 16px 0;">Edit Task</h3>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Title</label>
        <input type="text" id="dm-task-title" value="${(task.title || '').replace(/"/g,'&quot;')}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Status</label>
          <select id="dm-task-status" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
            ${['todo','in_progress','done','blocked'].map(s => `<option value="${s}"${task.status === s ? ' selected' : ''}>${s.replace(/_/g,' ')}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Priority</label>
          <select id="dm-task-priority" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
            ${['low','medium','high','critical'].map(p => `<option value="${p}"${task.priority === p ? ' selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Due date</label>
          <input type="date" id="dm-task-due" value="${task.due_date || ''}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Est. hours</label>
          <input type="number" step="0.5" id="dm-task-hours" value="${task.estimated_hours || ''}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Assignee</label>
          <input type="text" id="dm-task-assignee" value="${(task.assigned_to || '').replace(/"/g,'&quot;')}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:space-between;">
        <button class="hub-btn hub-btn-secondary" data-action="dm-task-delete" style="color:var(--ies-red);">Delete Task</button>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-secondary" data-action="dm-task-cancel">Cancel</button>
          <button class="hub-btn hub-btn-primary" data-action="dm-task-save">Save</button>
        </div>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.addEventListener('click', async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t === modal || t.closest('[data-action="dm-task-cancel"]')) { modal.remove(); return; }
    if (t.closest('[data-action="dm-task-save"]')) {
      const fields = {
        title: /** @type {HTMLInputElement} */ (modal.querySelector('#dm-task-title')).value.trim() || task.title,
        status: /** @type {HTMLSelectElement} */ (modal.querySelector('#dm-task-status')).value,
        priority: /** @type {HTMLSelectElement} */ (modal.querySelector('#dm-task-priority')).value,
        due_date: /** @type {HTMLInputElement} */ (modal.querySelector('#dm-task-due')).value || null,
        estimated_hours: Number(/** @type {HTMLInputElement} */ (modal.querySelector('#dm-task-hours')).value) || null,
        assigned_to: /** @type {HTMLInputElement} */ (modal.querySelector('#dm-task-assignee')).value.trim() || null,
      };
      try {
        await api.updateTask(task.id, fields);
        tasks = await api.fetchTasks(activeDeal.id);
        modal.remove();
        const el = rootEl?.querySelector('#dm-content');
        if (el) renderTasksTab(el);
      } catch (err) {
        console.error('[DM] task update failed:', err);
        alert('Failed to save task — check console.');
      }
    }
    if (t.closest('[data-action="dm-task-delete"]')) {
      if (!window.confirm('Delete this task? This cannot be undone.')) return;
      try {
        await api.deleteTask(task.id);
        tasks = await api.fetchTasks(activeDeal.id);
        modal.remove();
        const el = rootEl?.querySelector('#dm-content');
        if (el) renderTasksTab(el);
      } catch (err) {
        console.error('[DM] task delete failed:', err);
        alert('Failed to delete task — check console.');
      }
    }
  });
}

/** Full shell re-render (used when changing landing↔detail context). */
function rerenderShell() {
  if (!rootEl) return;
  // Drop previous content-area delegation before swapping innerHTML.
  rootEl.removeEventListener('click', _dmContentClickHandler);
  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderContent();
}

function renderContent() {
  const el = rootEl?.querySelector('#dm-content');
  if (!el) return;

  switch (activeTab) {
    // 'kanban' case removed 2026-04-29 — Kanban view dropped from Multi-Site.
    case 'list': renderDealList(el); break;
    case 'summary': renderSummary(el); break;
    case 'sites': renderSites(el); break;
    case 'financials': renderFinancials(el); break;
    case 'sensitivity': renderSensitivity(el); break;
    case 'compare': renderCompare(el); break;
    case 'pipeline': renderPipeline(el); break;
    case 'hours': renderHours(el); break;
    case 'tasks': renderTasksTab(el); break;
    case 'updates': renderUpdatesTab(el); break;
  }
}

// ============================================================
// KANBAN VIEW (LANDING)
// ============================================================

function renderKanban(el) {
  const stages = [
    { number: 1, name: 'Pre-Sales Engagement' },
    { number: 2, name: 'Deal Qualification' },
    { number: 3, name: 'Kick-Off & Solution Design' },
    { number: 4, name: 'Operations Review' },
    { number: 5, name: 'Executive Review' },
    { number: 6, name: 'Delivery Handover' },
  ];

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px;overflow-x:auto;padding:4px;">
      ${stages.map(stage => {
        const dealsInStage = allDeals.filter(d => {
          // Map deal status to DOS stage for display purposes
          const stageMap = { draft: 1, in_progress: 3, proposal_sent: 5, won: 6, lost: 0 };
          return stageMap[d.status] === stage.number;
        });

        return `
          <div style="flex:0 0 280px;display:flex;flex-direction:column;background:var(--ies-gray-50);border-radius:8px;padding:12px;border:1px solid var(--ies-gray-200);">
            <div style="font-size:13px;font-weight:700;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--ies-gray-200);display:flex;justify-content:space-between;align-items:center;">
              <span>${stage.name}</span>
              <span style="font-size:11px;font-weight:700;background:var(--ies-blue);color:#fff;padding:2px 8px;border-radius:12px;">${dealsInStage.length}</span>
            </div>
            ${dealsInStage.length === 0 ? `
              <div style="text-align:center;padding:20px 0;color:var(--ies-gray-400);font-size:12px;">No deals</div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${dealsInStage.map(d => {
                  const badge = calc.statusBadge(d.status);
                  return `
                    <div class="hub-card dm-deal-card" draggable="true" style="cursor:pointer;padding:12px;border:1px solid var(--ies-gray-200);" data-deal-id="${d.id}" data-drag-deal-id="${d.id}">
                      <div style="font-size:12px;font-weight:700;margin-bottom:4px;color:var(--ies-navy);">${d.dealName}</div>
                      <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:6px;">${d.clientName}</div>
                      <div style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;background:${badge.bg};color:${badge.color};">${badge.label}</div>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>
        `;
      }).join('')}
    </div>
  `;

  el.querySelectorAll('[data-deal-id]').forEach(card => {
    card.addEventListener('click', async () => {
      await openDeal(/** @type {HTMLElement} */ (card).dataset.dealId);
    });
  });
  bindDragToCombine(el);
}

// ============================================================
// MUL-G1 — DRAG-TO-COMBINE WIRING
// ============================================================

/**
 * Wire HTML5 drag-and-drop on .dm-deal-card elements within `scope`.
 * Source: dragstart caches the deal id. Target: dragover sets a highlight
 * outline + dataTransfer.dropEffect=link; drop opens openCombinePreview().
 */
function bindDragToCombine(scope) {
  scope.querySelectorAll('.dm-deal-card').forEach(card => {
    const c = /** @type {HTMLElement} */ (card);
    c.addEventListener('dragstart', e => {
      dragSourceDealId = c.dataset.dragDealId || null;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'link';
        e.dataTransfer.setData('text/plain', dragSourceDealId || '');
      }
      c.style.opacity = '0.5';
    });
    c.addEventListener('dragend', () => {
      dragSourceDealId = null;
      c.style.opacity = '';
      scope.querySelectorAll('.dm-deal-card').forEach(o => {
        /** @type {HTMLElement} */ (o).style.outline = '';
        /** @type {HTMLElement} */ (o).style.outlineOffset = '';
      });
    });
    c.addEventListener('dragover', e => {
      const tgt = c.dataset.dragDealId;
      if (!dragSourceDealId || dragSourceDealId === tgt) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'link';
      c.style.outline = '2px dashed var(--ies-blue)';
      c.style.outlineOffset = '2px';
    });
    c.addEventListener('dragleave', () => {
      c.style.outline = '';
      c.style.outlineOffset = '';
    });
    c.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      const tgt = c.dataset.dragDealId;
      if (!dragSourceDealId || !tgt || dragSourceDealId === tgt) return;
      const srcId = dragSourceDealId;
      dragSourceDealId = null;
      c.style.outline = '';
      c.style.outlineOffset = '';
      await openCombinePreview(srcId, tgt);
    });
  });
}

/**
 * Open the combined-deal preview modal. Loads sites for both deals,
 * pipes them through calc.combineDeals(), and renders the synthetic
 * roll-up financials. The user picks a cannibalization % and either
 * cancels, "Save as new combined deal", or "Move all sites to target".
 */
async function openCombinePreview(srcId, tgtId) {
  const dealA = allDeals.find(d => String(d.id) === String(srcId));
  const dealB = allDeals.find(d => String(d.id) === String(tgtId));
  if (!dealA || !dealB) {
    showToast('Deals not found for combine', 'error');
    return;
  }
  let sitesA = [];
  let sitesB = [];
  try {
    sitesA = await api.listSites(dealA.id);
    sitesB = await api.listSites(dealB.id);
  } catch (err) {
    showToast('Failed to load sites: ' + (err && err.message || err), 'error');
    return;
  }
  combineResult = calc.combineDeals(
    { sites: sitesA, dealName: dealA.dealName },
    { sites: sitesB, dealName: dealB.dealName },
    { cannibalizationPct: 0, contractTermYears: dealA.contractTermYears || dealB.contractTermYears || 5 }
  );

  const fmt = calc.formatCurrency;
  const overlay = document.createElement('div');
  overlay.className = 'hub-modal-overlay';
  overlay.innerHTML = `
    <div class="hub-modal" style="max-width:720px;">
      <h3 style="margin:0 0 4px 0;">Combine Deals — Preview</h3>
      <div style="font-size:12px;color:var(--ies-gray-500);margin-bottom:16px;">
        <b>${dealA.dealName}</b> + <b>${dealB.dealName}</b> · ${(sitesA.length + sitesB.length)} sites total
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
        <div class="hub-card" style="padding:12px;text-align:center;">
          <div style="font-size:11px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;">Combined Annual Revenue</div>
          <div id="dm-cmb-rev" style="font-size:22px;font-weight:800;">${fmt(combineResult.financials.totalAnnualRevenue || 0, { compact: true })}</div>
        </div>
        <div class="hub-card" style="padding:12px;text-align:center;">
          <div style="font-size:11px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;">EBITDA %</div>
          <div id="dm-cmb-ebitda" style="font-size:22px;font-weight:800;">${calc.formatPct(combineResult.financials.ebitdaPct || 0)}</div>
        </div>
        <div class="hub-card" style="padding:12px;text-align:center;">
          <div style="font-size:11px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;">Score</div>
          <div id="dm-cmb-score" style="font-size:22px;font-weight:800;">${(combineResult.score?.score || 0).toFixed(0)} <span style="font-size:13px;color:var(--ies-gray-400);">${combineResult.score?.grade || ''}</span></div>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:6px;">Cross-Deal Cannibalization (%)
          <span style="color:var(--ies-gray-400);font-weight:400;">— shave revenue to model overlap between the two books</span>
        </label>
        <input type="range" id="dm-cmb-cann" min="0" max="30" step="1" value="0" style="width:100%;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ies-gray-400);">
          <span>0%</span>
          <span id="dm-cmb-cann-val" style="font-weight:700;color:var(--ies-navy);">0%</span>
          <span>30%</span>
        </div>
      </div>

      <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:12px;">
        <b>Save as new combined deal:</b> creates a new "${dealA.dealName} + ${dealB.dealName}" container with the cannibalization % applied.<br>
        <b>Move all sites to ${dealB.dealName}:</b> re-links every site from the source deal onto the target. Source deal becomes site-less but stays.
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" data-action="dm-cmb-cancel">Cancel</button>
        <button class="hub-btn hub-btn-secondary" data-action="dm-cmb-move" title="Re-link sites from source onto target">Move sites → ${dealB.dealName}</button>
        <button class="hub-btn hub-btn-primary" data-action="dm-cmb-save">Save combined deal</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(overlay);

  const cannSlider = /** @type {HTMLInputElement} */ (overlay.querySelector('#dm-cmb-cann'));
  const cannLabel = overlay.querySelector('#dm-cmb-cann-val');
  const revEl = overlay.querySelector('#dm-cmb-rev');
  const ebitdaEl = overlay.querySelector('#dm-cmb-ebitda');
  const scoreEl = overlay.querySelector('#dm-cmb-score');
  cannSlider?.addEventListener('input', () => {
    const c = parseFloat(cannSlider.value) || 0;
    if (cannLabel) cannLabel.textContent = c + '%';
    combineResult = calc.combineDeals(
      { sites: sitesA, dealName: dealA.dealName },
      { sites: sitesB, dealName: dealB.dealName },
      { cannibalizationPct: c, contractTermYears: dealA.contractTermYears || dealB.contractTermYears || 5 }
    );
    if (revEl) revEl.textContent = fmt(combineResult.financials.totalAnnualRevenue || 0, { compact: true });
    if (ebitdaEl) ebitdaEl.textContent = calc.formatPct(combineResult.financials.ebitdaPct || 0);
    if (scoreEl) scoreEl.innerHTML = `${(combineResult.score?.score || 0).toFixed(0)} <span style="font-size:13px;color:var(--ies-gray-400);">${combineResult.score?.grade || ''}</span>`;
  });

  overlay.querySelector('[data-action="dm-cmb-cancel"]')?.addEventListener('click', () => overlay.remove());

  overlay.querySelector('[data-action="dm-cmb-move"]')?.addEventListener('click', async () => {
    if (!confirm(`Move all ${sitesA.length} sites from "${dealA.dealName}" to "${dealB.dealName}"? Source deal will keep its metadata but become site-less.`)) return;
    try {
      for (const s of sitesA) {
        await api.linkSite(s.id, dealB.id);
      }
      showToast(`Moved ${sitesA.length} sites to ${dealB.dealName}`, 'success');
      overlay.remove();
      rerenderShell();
    } catch (err) {
      showToast('Move failed: ' + (err && err.message || err), 'error');
    }
  });

  overlay.querySelector('[data-action="dm-cmb-save"]')?.addEventListener('click', async () => {
    try {
      const cann = parseFloat(cannSlider.value) || 0;
      const newDeal = await api.saveDeal({
        dealName: `${dealA.dealName} + ${dealB.dealName}`,
        clientName: dealA.clientName === dealB.clientName ? dealA.clientName : `${dealA.clientName || '—'} & ${dealB.clientName || '—'}`,
        dealOwner: dealA.dealOwner || dealB.dealOwner || '',
        status: 'in_progress',
        contractTermYears: dealA.contractTermYears || dealB.contractTermYears || 5,
        notes: `Combined from "${dealA.dealName}" and "${dealB.dealName}" with ${cann}% cannibalization assumption.`,
      });
      const newId = newDeal?.id || newDeal?.deals_id || ('deal-' + Date.now());
      // Mirror the persisted record into in-memory allDeals so it shows up
      // immediately in the kanban / list without requiring a remount.
      allDeals.push({
        id: newId,
        dealName: `${dealA.dealName} + ${dealB.dealName}`,
        clientName: dealA.clientName === dealB.clientName ? dealA.clientName : `${dealA.clientName || '—'} & ${dealB.clientName || '—'}`,
        dealOwner: dealA.dealOwner || dealB.dealOwner || '',
        status: 'in_progress',
        contractTermYears: dealA.contractTermYears || dealB.contractTermYears || 5,
        notes: `Combined from "${dealA.dealName}" and "${dealB.dealName}" with ${cann}% cannibalization assumption.`,
      });
      // Site-link policy: leave originals attached, just record an audit note.
      // The combined deal is a *roll-up scenario*, not a destructive merge.
      showToast(`Combined deal saved (${cann}% cannibalization). Originals preserved.`, 'success');
      overlay.remove();
      rerenderShell();
    } catch (err) {
      showToast('Save failed: ' + (err && err.message || err), 'error');
    }
  });
}

// ============================================================
// DEAL LIST (TABLE VIEW — LANDING)
// ============================================================

function renderDealList(el) {
  el.innerHTML = `
    <div style="max-width:900px;">
      ${allDeals.length === 0 ? `
        <div class="hub-card" style="text-align:center;padding:40px;">
          <div style="font-size:20px;font-weight:700;margin-bottom:8px;">No Deals Yet</div>
          <p class="text-body text-muted">Create a deal to group multiple site cost models into a unified analysis.</p>
          <button class="hub-btn hub-btn-primary" id="dm-first-deal" style="margin-top:16px;">+ Create First Deal</button>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
          ${allDeals.map(d => {
            const badge = calc.statusBadge(d.status);
            const safeName = (d.dealName || 'Deal').replace(/"/g, '&quot;');
            return `
              <div class="hub-card dm-landing-card dm-deal-card" draggable="true" style="cursor:pointer;position:relative;" data-deal-id="${d.id}" data-drag-deal-id="${d.id}">
                <button class="dm-landing-delete" data-deal-delete="${d.id}" data-deal-name="${safeName}"
                        title="Delete this deal"
                        style="position:absolute;top:8px;right:8px;width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--ies-gray-300);cursor:pointer;border-radius:4px;font-size:14px;z-index:2;">
                  ✕
                </button>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-right:24px;">
                  <span style="font-size:14px;font-weight:700;">${d.dealName}</span>
                  <span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${badge.bg};color:${badge.color};">${badge.label}</span>
                </div>
                <div style="font-size:13px;color:var(--ies-gray-400);margin-bottom:8px;">${d.clientName}</div>
                <div style="display:flex;gap:16px;font-size:11px;color:var(--ies-gray-400);">
                  <span>Owner: ${d.dealOwner || '—'}</span>
                  ${d.contractTermYears ? `<span>${d.contractTermYears}yr term</span>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  el.querySelectorAll('[data-deal-id]').forEach(card => {
    card.addEventListener('click', async (ev) => {
      // Don't open the deal if the user clicked the delete button.
      if (/** @type {HTMLElement} */ (ev.target).closest('[data-deal-delete]')) return;
      await openDeal(/** @type {HTMLElement} */ (card).dataset.dealId);
    });
  });

  el.querySelectorAll('[data-deal-delete]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = /** @type {HTMLElement} */ (btn).getAttribute('data-deal-delete');
      const name = /** @type {HTMLElement} */ (btn).getAttribute('data-deal-name') || 'this deal';
      if (!id) return;
      if (!confirm(`Delete "${name}"? Linked sites/CMs are NOT deleted, only the deal record. This cannot be undone.`)) return;
      try {
        await api.deleteDeal(id);
        allDeals = allDeals.filter(x => x.id !== id);
        renderDealList(el);
      } catch (err) {
        console.error('[DM] deleteDeal failed:', err);
        alert('Could not delete deal: ' + (err.message || 'unknown'));
      }
    });
  });

  el.querySelector('#dm-first-deal')?.addEventListener('click', () => createNewDeal());

  // MUL-G1: drag-to-combine on the landing-list deal cards
  bindDragToCombine(el);
}

function createNewDeal() {
  const id = 'deal-' + Date.now();
  const newDeal = { id, dealName: 'New Deal', clientName: '', dealOwner: '', status: /** @type {const} */ ('draft'), contractTermYears: 5 };
  allDeals.push(newDeal);
  openDeal(id);
}

/**
 * MUL-F2: load stage templates from Supabase, with hardcoded fallback.
 * Memoized on `stageTemplateBundle` — only fetches once per mount cycle.
 * On error (RLS, offline, staging-no-table), gracefully falls back to the
 * calc.DOS_STAGES constant so the UI still renders.
 */
async function ensureStageTemplates() {
  if (stageTemplateBundle) return stageTemplateBundle;
  if (stageTemplateSource === 'pending') return null;
  stageTemplateSource = 'pending';
  try {
    const bundle = await api.fetchStageTemplates();
    if (!bundle || !Array.isArray(bundle.stages) || bundle.stages.length === 0) {
      throw new Error('empty stage_templates result');
    }
    stageTemplateBundle = bundle;
    stageTemplateSource = 'fresh';
    return bundle;
  } catch (err) {
    console.warn('[Deal Manager] Stage templates fetch failed — falling back to calc.DOS_STAGES constant.', err);
    // Synthesize a bundle from the local fallback constant so callers can use
    // the same shape regardless of DB state.
    stageTemplateBundle = {
      templateVersion: null,
      stages: calc.DOS_STAGES.map((s) => ({
        id: -s.number,
        stage_number: s.number,
        stage_name: s.name,
        description: null,
        element_count: s.elementCount,
        elements: Array.from({ length: s.elementCount }, (_, i) => ({
          id: -(s.number * 1000 + i),
          element_name: `Element ${i + 1}`,
          description: null,
          responsible_workstream: 'solutions',
          element_type: 'deliverable',
          sort_order: i,
        })),
      })),
    };
    stageTemplateSource = 'fallback';
    return stageTemplateBundle;
  }
}

/**
 * Build the in-memory `dosStages` array (UI shape) from the loaded template
 * bundle. Element status is seeded for new deals (60% complete / 20% in
 * progress / 20% not started) — once persistence wires through, this will
 * read from `project_elements` rather than the seed pattern.
 */
function buildDosStagesFromTemplates(bundle) {
  if (!bundle || !Array.isArray(bundle.stages)) return [];
  return bundle.stages.map(stage => ({
    stageNumber: stage.stage_number,
    stageName: stage.stage_name,
    elements: (stage.elements && stage.elements.length > 0
      ? stage.elements
      : Array.from({ length: stage.element_count || 0 }, (_, i) => ({
          id: -(stage.stage_number * 1000 + i),
          element_name: `Element ${i + 1}`,
          element_type: 'deliverable',
          responsible_workstream: 'solutions',
        }))
    ).map((el, i) => ({
      id: el.id != null ? `el-${stage.stage_number}-${el.id}` : `el-${stage.stage_number}-${i}`,
      name: el.element_name || `Element ${i + 1}`,
      elementType: el.element_type || 'deliverable',
      workstream: el.responsible_workstream || 'solutions',
      // Seed status — placeholder until project_elements persistence lands.
      status: /** @type {const} */ (
        i < Math.floor((stage.element_count || 0) * 0.6) ? 'complete'
        : i < Math.floor((stage.element_count || 0) * 0.8) ? 'in_progress'
        : 'not_started'
      ),
    })),
  }));
}

async function openDeal(id) {
  activeDeal = allDeals.find(d => d.id === id) || null;
  if (!activeDeal) return;

  // Demo deal gets seeded sites when explicitly loaded; real deals start
  // with an empty site list (user adds sites via "+ Link Cost Model" or
  // "+ Add Empty Site").
  if (id === 'demo-deal-1') {
    sites = calc.DEMO_SITES.map(s => ({ ...s }));
  } else {
    sites = [];
  }

  financials = calc.computeDealFinancials(sites, activeDeal.contractTermYears || 5);

  // MUL-F2 — DOS stages now load from public.stages + stage_element_templates.
  // Falls back to calc.DOS_STAGES constant when the DB query errors (offline,
  // staging schema drift, RLS denial). Memoized via ensureStageTemplates().
  const tplBundle = await ensureStageTemplates();
  dosStages = buildDosStagesFromTemplates(tplBundle);

  // Load hours, tasks, updates
  hoursEntries = await api.fetchHours(activeDeal.id);
  tasks = await api.fetchTasks(activeDeal.id);
  updates = await api.fetchUpdates(activeDeal.id);

  // 2026-04-29 (Brock): land on Sites for empty deals so the natural next
  // step (linking cost models / adding sites) is right there. For already-
  // populated deals, land on Summary so the rollup is the first thing users
  // see.
  activeTab = (sites && sites.length > 0) ? 'summary' : 'sites';
  // Switching from landing to detail — re-render shell so header swaps to detail mode
  rerenderShell();
}

// ============================================================
// SUMMARY TAB
// ============================================================

function renderSummary(el) {
  if (!activeDeal || !financials) return;

  // 2026-04-21 audit: Summary showed $0/zero KPIs on empty deals with no
  // guidance. Render an empty-state card directing the user to the Sites
  // section under the Composition phase before rendering the full dashboard
  // (which is meaningless with 0 sites).
  if (!sites || sites.length === 0) {
    const badge = calc.statusBadge(activeDeal.status);
    el.innerHTML = `
      <div style="max-width:800px;">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
          <div>
            <div style="font-size:20px;font-weight:800;">${activeDeal.dealName}</div>
            <div style="font-size:13px;color:var(--ies-gray-400);">${activeDeal.clientName} • ${activeDeal.dealOwner || 'Unassigned'}</div>
          </div>
          <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;background:${badge.bg};color:${badge.color};">${badge.label}</span>
        </div>
        <div class="hub-card" style="padding:32px;text-align:center;background:var(--ies-gray-50);border:1px dashed var(--ies-gray-300);">
          <div style="font-size:18px;font-weight:700;color:var(--ies-navy);margin-bottom:8px;">No sites linked yet</div>
          <div style="font-size:13px;color:var(--ies-gray-500);line-height:1.6;max-width:500px;margin:0 auto 16px auto;">
            Multi-site financials roll up from the cost models attached to each site. Use
            <b>Composition → Sites</b> to link existing Cost Model projects (e.g., Memphis FC,
            Atlanta DC) or add an empty site shell.
          </div>
          <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="dm-jump-to-sites">Add Sites →</button>
        </div>
      </div>
    `;
    el.querySelector('[data-action="dm-jump-to-sites"]')?.addEventListener('click', () => {
      activeTab = /** @type {any} */ ('sites');
      renderContent();
      // Sites lives under Composition phase (different from current Overview);
      // refresh chrome so phase tabs + section pills follow.
      refreshToolChrome(rootEl, _buildDmChromeOpts());
    });
    return;
  }

  const badge = calc.statusBadge(activeDeal.status);
  const score = calc.computeDealScore(financials);
  const metrics = calc.evaluateAllMetrics(financials);
  const progress = calc.computeStageProgress(dosStages);
  const overall = calc.computeOverallProgress(progress);

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Deal Header -->
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
        <div>
          <div style="font-size:20px;font-weight:800;">${activeDeal.dealName}</div>
          <div style="font-size:13px;color:var(--ies-gray-400);">${activeDeal.clientName} • ${activeDeal.dealOwner || 'Unassigned'}</div>
        </div>
        <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;background:${badge.bg};color:${badge.color};">${badge.label}</span>
        <div style="margin-left:auto;text-align:center;">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:${scoreBg(score.grade)};border:2px solid ${scoreColor(score.grade)};">
            <div style="font-size:26px;font-weight:800;line-height:1;color:${scoreColor(score.grade)};">${score.grade}</div>
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--ies-gray-400);margin-top:4px;">SCORE ${score.score}</div>
        </div>
      </div>

      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Sites', String(sites.length))}
          ${kpi('Total SqFt', financials.totalSqft.toLocaleString())}
          ${kpi('Annual Revenue', calc.formatCurrency(financials.totalAnnualRevenue, { compact: true }))}
          ${kpi('Annual Cost', calc.formatCurrency(financials.totalAnnualCost, { compact: true }))}
          ${kpi('Gross Margin', calc.formatPct(financials.grossMarginPct), financials.grossMarginPct >= 12 ? '#22c55e' : financials.grossMarginPct >= 8 ? '#f59e0b' : '#ef4444')}
          ${kpi('NPV', calc.formatCurrency(financials.npv, { compact: true }), financials.npv >= 0 ? '#22c55e' : '#ef4444')}
        </div>
      </div>

      <!-- Metric Cards + Progress -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Financial Health</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            ${metrics.map(m => `
              <div style="padding:10px;border-radius:6px;border:1px solid var(--ies-gray-200);border-left:3px solid ${calc.ratingColor(m.rating)};">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">${m.label}</div>
                <div style="font-size:20px;font-weight:800;color:${calc.ratingColor(m.rating)};">
                  ${m.metric === 'paybackMonths' ? calc.formatMonths(m.value) : m.metric.includes('Pct') || m.metric.includes('pct') ? calc.formatPct(m.value) : calc.formatCurrency(m.value)}
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="hub-card" style="padding:16px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:12px;">DOS Progress</div>
          <div style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:13px;font-weight:600;color:var(--ies-gray-700);">Overall completion <span style="font-weight:400;color:var(--ies-gray-500);">— current stage:</span> <strong>${overall.currentStage}</strong></span>
              <span style="font-size:13px;font-weight:700;">${overall.overallPct.toFixed(0)}%</span>
            </div>
            <div style="height:8px;border-radius:4px;background:var(--ies-gray-200);overflow:hidden;">
              <div style="height:100%;width:${overall.overallPct}%;background:var(--ies-blue);border-radius:4px;"></div>
            </div>
          </div>
          ${progress.map(p => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-size:11px;font-weight:600;width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.stageName}</span>
              <div style="flex:1;height:6px;border-radius:3px;background:var(--ies-gray-200);overflow:hidden;">
                <div style="height:100%;width:${p.pct}%;background:${p.pct === 100 ? '#22c55e' : p.blocked > 0 ? '#ef4444' : 'var(--ies-blue)'};border-radius:3px;"></div>
              </div>
              <span style="font-size:11px;font-weight:700;width:40px;text-align:right;">${p.completed}/${p.total}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Site Comparison -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Site Comparison</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Site</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">SqFt</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Annual Cost</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Revenue</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Margin</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">$/SqFt</th>
            </tr>
          </thead>
          <tbody>
            ${financials.bySite.map(sf => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:8px 6px;font-weight:600;">${sf.siteName}</td>
                <td style="padding:8px 6px;text-align:right;">${sites.find(s => s.id === sf.siteId)?.sqft.toLocaleString() || '—'}</td>
                <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(sf.annualCost, { compact: true })}</td>
                <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(sf.annualRevenue, { compact: true })}</td>
                <td style="padding:8px 6px;text-align:right;color:${sf.grossMarginPct >= 10 ? '#22c55e' : '#f59e0b'};">${calc.formatPct(sf.grossMarginPct)}</td>
                <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(sf.costPerSqft)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================
// SITES TAB
// ============================================================

function renderSites(el) {
  if (!activeDeal) return;

  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Linked Sites</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-link-cm">🔗 Link Cost Model</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="dm-add-site">+ Add Empty Site</button>
        </div>
      </div>

      ${sites.length === 0 ? `
        <div class="hub-card" style="text-align:center;padding:32px;">
          <p class="text-body text-muted">No sites linked to this deal. Click <strong>Link Cost Model</strong> to attach a saved CM project, or add an empty site to type numbers in.</p>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
          ${sites.map(s => {
            const sf = financials?.bySite.find(b => b.siteId === s.id);
            const linked = !!s.costModelId;
            return `
              <div class="hub-card" style="padding:16px;${linked ? 'border-left:3px solid var(--ies-blue);' : ''}">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                  <span style="font-size:14px;font-weight:700;">${s.name}</span>
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-unlink="${s.id}" style="padding:4px 8px;">✕</button>
                </div>
                <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
                  <span class="hub-status-chip ${linked ? 'linked' : 'standalone'} dot" style="font-size:11px;">${linked ? 'CM-linked' : 'Typed data'}</span>
                  ${s.environment ? `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:#dbeafe;color:#1d4ed8;">${s.environment}</span>` : ''}
                  ${s.market ? `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:#f3f4f6;color:#6b7280;">${s.market}</span>` : ''}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">SqFt</div>
                    <div style="font-weight:600;">${s.sqft.toLocaleString()}</div>
                  </div>
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">Annual Cost</div>
                    <div style="font-weight:600;">${calc.formatCurrency(s.annualCost, { compact: true })}</div>
                  </div>
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">Target Margin</div>
                    <div style="font-weight:600;">${calc.formatPct(s.targetMarginPct)}</div>
                  </div>
                  <div>
                    <div style="font-size:11px;color:var(--ies-gray-400);">Pricing</div>
                    <div style="font-weight:600;text-transform:capitalize;">${s.pricingModel || '—'}</div>
                  </div>
                </div>
                ${s.startupCost ? `
                  <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--ies-gray-200);font-size:11px;color:var(--ies-gray-400);">
                    Startup: ${calc.formatCurrency(s.startupCost, { compact: true })}
                  </div>
                ` : ''}
                ${linked && s.costBreakdown ? `
                  <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--ies-gray-200);font-size:11px;color:var(--ies-gray-500);">
                    Breakdown: L ${calc.formatCurrency(s.costBreakdown.labor || 0, { compact: true })} · F ${calc.formatCurrency(s.costBreakdown.facility || 0, { compact: true })} · E ${calc.formatCurrency(s.costBreakdown.equipment || 0, { compact: true })}
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  el.querySelectorAll('[data-unlink]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const siteId = /** @type {HTMLElement} */ (btn).dataset.unlink;
      sites = sites.filter(s => s.id !== siteId);
      financials = calc.computeDealFinancials(sites, activeDeal?.contractTermYears || 5);
      renderSites(el);
    });
  });

  el.querySelector('#dm-add-site')?.addEventListener('click', () => {
    const id = 's' + Date.now();
    sites.push({ id, name: 'New Site', sqft: 200000, annualCost: 2000000, targetMarginPct: 10, pricingModel: 'cost-plus' });
    financials = calc.computeDealFinancials(sites, activeDeal?.contractTermYears || 5);
    renderSites(el);
  });

  el.querySelector('#dm-link-cm')?.addEventListener('click', () => openLinkCmModal(el));
}

// ============================================================
// LINK COST MODEL MODAL
// ============================================================

/**
 * Open the Link-CM modal. Loads unlinked CM projects and lets the user
 * select one to attach to the current deal as a new site.
 * @param {Element} parentEl  The Sites section element, re-rendered on link success.
 */
async function openLinkCmModal(parentEl) {
  // Remove any existing modal
  document.getElementById('dm-link-cm-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dm-link-cm-modal';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;
  overlay.innerHTML = `
    <div class="hub-card" style="max-width:640px;width:100%;padding:0;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 20px 40px rgba(0,0,0,0.3);">
      <div style="padding:18px 20px;border-bottom:1px solid var(--ies-gray-200);display:flex;align-items:center;justify-content:space-between;">
        <h3 style="margin:0;font-size:16px;font-weight:700;">Link Cost Model to Deal</h3>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="dm-link-cm-close" style="padding:4px 10px;">✕</button>
      </div>
      <div id="dm-link-cm-body" style="padding:20px;max-height:60vh;overflow-y:auto;">
        <div style="text-align:center;padding:32px;color:var(--ies-gray-500);">Loading cost models…</div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--ies-gray-200);display:flex;justify-content:flex-end;gap:8px;">
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="dm-link-cm-close">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close handlers (click outside card or X button)
  overlay.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target === overlay || target.closest('[data-action="dm-link-cm-close"]')) {
      overlay.remove();
    }
  });

  const body = overlay.querySelector('#dm-link-cm-body');
  if (!body) return;

  // Load unlinked CMs
  let projects = [];
  try {
    projects = await api.listUnlinkedProjects();
  } catch (e) {
    body.innerHTML = `
      <div style="padding:24px;background:#fee2e2;border:1px solid #fecaca;border-radius:6px;color:#991b1b;font-size:13px;">
        Could not load cost models: ${escapeHtml(e.message || 'Unknown error')}<br>
        <span style="opacity:0.8;">Check your connection and Supabase status, then try again.</span>
      </div>`;
    return;
  }

  if (!projects.length) {
    body.innerHTML = `
      <div style="text-align:center;padding:32px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:8px;">No unlinked cost models found</div>
        <p class="text-body text-muted" style="margin:0;">Every saved CM project is already attached to a deal. Create a new cost model in the Cost Model Builder first, then come back here to link it.</p>
      </div>`;
    return;
  }

  body.innerHTML = `
    <p class="text-body text-muted" style="margin:0 0 16px 0;">Select a cost model to attach as a new site on <strong>${escapeHtml(activeDeal?.dealName || '')}</strong>.</p>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${projects.map(p => `
        <button class="hub-card" data-cm-id="${p.id}" style="padding:12px;text-align:left;cursor:pointer;border:1px solid var(--ies-gray-200);background:#fff;">
          <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${escapeHtml(p.name || 'Unnamed')}</div>
          <div style="display:flex;gap:16px;font-size:11px;color:var(--ies-gray-500);">
            <span>${p.total_sqft ? p.total_sqft.toLocaleString() + ' SqFt' : 'SqFt —'}</span>
            <span>${p.total_annual_cost ? calc.formatCurrency(p.total_annual_cost, { compact: true }) + '/yr' : 'Cost —'}</span>
          </div>
        </button>
      `).join('')}
    </div>
  `;

  body.querySelectorAll('[data-cm-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const projectId = /** @type {HTMLElement} */ (btn).dataset.cmId;
      if (!projectId || !activeDeal) return;

      // Visual feedback while linking
      /** @type {HTMLElement} */ (btn).style.opacity = '0.5';
      /** @type {HTMLElement} */ (btn).innerHTML += '<div style="font-size:11px;color:var(--ies-blue);margin-top:4px;">Linking…</div>';

      try {
        // Persist the link only if the deal is actually a saved row (uuid id).
        // In-memory demo / unsaved deals (`demo-*`, `deal-{timestamp}`) skip persistence
        // and just attach in memory so the UX works in the showcase flow.
        const isPersistedDeal = /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(activeDeal.id);
        if (isPersistedDeal) {
          await api.linkSite(projectId, activeDeal.id);
        }
        // Fetch the CM project row to materialize as a Site
        const chosen = projects.find(p => p.id === projectId);
        const breakdown = await api.fetchCostModelBreakdown(projectId);
        const newSite = {
          id: 's-cm-' + projectId,
          name: chosen?.name || 'Linked CM',
          sqft: chosen?.total_sqft || 0,
          annualCost: chosen?.total_annual_cost || 0,
          targetMarginPct: 10,
          pricingModel: /** @type {const} */ ('cost-plus'),
          costModelId: projectId,
          costBreakdown: breakdown || undefined,
        };
        sites.push(newSite);
        financials = calc.computeDealFinancials(sites, activeDeal.contractTermYears || 5);
        overlay.remove();
        renderSites(parentEl);
      } catch (e) {
        /** @type {HTMLElement} */ (btn).style.opacity = '1';
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'padding:10px;margin-top:12px;background:#fee2e2;border-radius:6px;color:#991b1b;font-size:12px;';
        errDiv.textContent = 'Link failed: ' + (e.message || 'unknown error');
        body.appendChild(errDiv);
      }
    });
  });
}

/** Minimal HTML escape for user-supplied strings in modal content. */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ============================================================
// FINANCIALS TAB
// ============================================================

function renderFinancials(el) {
  if (!financials || !activeDeal) return;

  // MUL-D3/D4 — recompute deal financials honoring the dealConfig overrides
  // for EBITDA overhead and discount rate so all downstream metrics
  // (EBITDA%, NPV, IRR, score) reflect the user's tuning.
  const overrideOpts = {
    ebitdaOverheadPct: Number(dealConfig.ebitdaOverheadPct),
    discountRate: Number(dealConfig.discountRate) / 100,
  };
  const fin = calc.computeDealFinancials(sites, activeDeal.contractTermYears || 5, overrideOpts);
  const plRows = calc.generateMultiYearPL(fin, activeDeal.contractTermYears || 5, {
    revenue: Number(dealConfig.escalationRevenuePct),
    cost: Number(dealConfig.escalationCostPct),
  });
  const score = calc.computeDealScore(fin, {
    weights: dealConfig.scoreWeights,
    gradeThresholds: dealConfig.gradeThresholds,
  });
  const metrics = calc.evaluateAllMetrics(fin);
  // Use the recomputed `fin` for the rest of the render (renamed local).
  const financialsLocal = fin;

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Financial Metrics Dashboard -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        ${metrics.map(m => `
          <div class="hub-card" style="padding:14px;border-left:4px solid ${calc.ratingColor(m.rating)};">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">${m.label}</div>
            <div style="font-size:20px;font-weight:800;color:${calc.ratingColor(m.rating)};margin-top:4px;">
              ${m.metric === 'paybackMonths' ? calc.formatMonths(m.value) :
                m.metric.includes('Pct') || m.metric.includes('pct') ? calc.formatPct(m.value) :
                calc.formatCurrency(m.value)}
            </div>
            <div style="font-size:11px;margin-top:4px;color:${calc.ratingColor(m.rating)};">${m.rating === 'good' ? '✓ On target' : m.rating === 'warning' ? '⚠ Below target' : '✕ Below minimum'}</div>
          </div>
        `).join('')}
      </div>

      <!-- Additional metrics -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">NPV (${activeDeal.contractTermYears || 5}yr)</div>
          <div style="font-size:20px;font-weight:800;color:${financialsLocal.npv >= 0 ? '#22c55e' : '#ef4444'};">${calc.formatCurrency(financialsLocal.npv, { compact: true })}</div>
        </div>
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">IRR</div>
          <div style="font-size:20px;font-weight:800;">${calc.formatPct(financialsLocal.irr * 100)}</div>
        </div>
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Revenue/SqFt</div>
          <div style="font-size:20px;font-weight:800;">${calc.formatCurrency(financialsLocal.revenuePerSqft)}</div>
        </div>
        <div class="hub-card" style="padding:14px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Deal Score</div>
          <div style="font-size:20px;font-weight:800;color:${scoreColor(score.grade)};">${score.grade} (${score.score})</div>
        </div>
      </div>

      <!-- MUL-D3/D4/D1: Deal financial config knobs -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="font-size:14px;font-weight:700;">Deal Financial Config</div>
          <span style="font-size:11px;color:var(--ies-gray-500);">EBITDA, NPV discount, and revenue/cost escalation tuning</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;">
          ${cfgKnob('EBITDA Overhead %', 'ebitdaOverheadPct', dealConfig.ebitdaOverheadPct, '%', '0.5', 'SGA + D&A burden subtracted from gross margin')}
          ${cfgKnob('Discount Rate', 'discountRate', dealConfig.discountRate, '%', '0.5', 'NPV discount rate')}
          ${cfgKnob('Revenue Escalator', 'escalationRevenuePct', dealConfig.escalationRevenuePct, '%/yr', '0.25', 'Year-over-year revenue uplift in P&L')}
          ${cfgKnob('Cost Escalator', 'escalationCostPct', dealConfig.escalationCostPct, '%/yr', '0.25', 'Year-over-year cost uplift in P&L')}
        </div>
        <div style="margin-top:14px;display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:10px;font-size:11px;color:var(--ies-gray-500);">
          <div><strong>Score Weights:</strong> M ${(dealConfig.scoreWeights.margin*100).toFixed(0)}% / E ${(dealConfig.scoreWeights.ebitda*100).toFixed(0)}% / P ${(dealConfig.scoreWeights.payback*100).toFixed(0)}% / N ${(dealConfig.scoreWeights.npv*100).toFixed(0)}%</div>
          <div><strong>Grade Thresholds:</strong> A ≥ ${dealConfig.gradeThresholds.A} · B ≥ ${dealConfig.gradeThresholds.B} · C ≥ ${dealConfig.gradeThresholds.C} · D ≥ ${dealConfig.gradeThresholds.D}</div>
        </div>
      </div>

      <!-- Multi-Year P&L -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Multi-Year P&L Projection
          <span style="font-size:11px;font-weight:400;color:var(--ies-gray-500);">— Revenue ${dealConfig.escalationRevenuePct}% / Cost ${dealConfig.escalationCostPct}%/yr</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:center;padding:8px;font-weight:700;">Year</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Revenue</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Cost</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Gross Profit</th>
              <th style="text-align:right;padding:8px;font-weight:700;">EBITDA</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Cumulative CF</th>
            </tr>
          </thead>
          <tbody>
            ${plRows.map(r => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:8px;text-align:center;font-weight:700;">Y${r.year}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.revenue, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.cost, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.grossProfit, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(r.ebitda, { compact: true })}</td>
                <td style="padding:8px;text-align:right;color:${r.cumulativeCashFlow >= 0 ? '#22c55e' : '#ef4444'};">${calc.formatCurrency(r.cumulativeCashFlow, { compact: true })}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Cost breakdown by site -->
      <div class="hub-card" style="padding:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Cost by Site</div>
        ${financialsLocal.bySite.map(sf => {
          const pct = financialsLocal.totalAnnualCost > 0 ? (sf.annualCost / financialsLocal.totalAnnualCost) * 100 : 0;
          return `
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;">${sf.siteName}</span>
                <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(sf.annualCost, { compact: true })} (${pct.toFixed(1)}%)</span>
              </div>
              <div style="height:20px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:var(--ies-blue);border-radius:6px;"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  // MUL-D1/D3/D4 — bind cfg knob inputs; on change update dealConfig and
  // re-render this tab so the metrics + P&L flow with the new values.
  setTimeout(() => {
    el.querySelectorAll('input[data-deal-cfg]').forEach(input => {
      input.addEventListener('change', (e) => {
        const k = /** @type {HTMLInputElement} */ (e.target).dataset.dealCfg;
        const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
        if (!Number.isFinite(v)) return;
        dealConfig = { ...dealConfig, [k]: v };
        renderFinancials(el);
      });
    });
  }, 0);
}

// ============================================================
// PIPELINE TAB (DOS Stages)
// ============================================================

function renderPipeline(el) {
  if (!activeDeal) return;

  const progress = calc.computeStageProgress(dosStages);
  const overall = calc.computeOverallProgress(progress);

  el.innerHTML = `
    <div style="max-width:900px;">
      <!-- Overall progress -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;">
          ${kpi('Current Stage', overall.currentStage)}
          ${kpi('Elements', `${overall.completedElements}/${overall.totalElements}`)}
          ${kpi('Completion', `${overall.overallPct.toFixed(0)}%`)}
        </div>
      </div>

      <!-- Stage cards -->
      ${dosStages.map((stage, si) => {
        const prog = progress[si];
        const stageColor = prog.pct === 100 ? '#22c55e' : prog.blocked > 0 ? '#ef4444' : prog.inProgress > 0 ? 'var(--ies-blue)' : '#6b7280';

        return `
          <div class="hub-card" style="margin-bottom:16px;border-left:4px solid ${stageColor};">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div>
                <span style="font-size:14px;font-weight:700;">Stage ${stage.stageNumber}: ${stage.stageName}</span>
                <span style="margin-left:8px;font-size:11px;font-weight:700;color:${stageColor};">${prog.pct.toFixed(0)}%</span>
              </div>
              <span style="font-size:11px;color:var(--ies-gray-400);">${prog.completed}/${prog.total} complete</span>
            </div>

            <div style="height:6px;border-radius:3px;background:var(--ies-gray-200);margin-bottom:12px;overflow:hidden;">
              <div style="height:100%;width:${prog.pct}%;background:${stageColor};border-radius:3px;"></div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
              ${stage.elements.map(elem => {
                const statusColors = {
                  complete: { bg: '#dcfce7', color: '#15803d', icon: '✓' },
                  in_progress: { bg: '#dbeafe', color: '#1d4ed8', icon: '◉' },
                  blocked: { bg: '#fee2e2', color: '#991b1b', icon: '✕' },
                  not_started: { bg: '#f3f4f6', color: '#6b7280', icon: '○' },
                  na: { bg: '#f3f4f6', color: '#9ca3af', icon: '—' },
                  skipped: { bg: '#f3f4f6', color: '#9ca3af', icon: '⊘' },
                };
                const sc = statusColors[elem.status] || statusColors.not_started;

                return `
                  <div style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;background:${sc.bg};cursor:pointer;" data-elem="${elem.id}">
                    <span style="font-size:14px;color:${sc.color};">${sc.icon}</span>
                    <span style="font-size:11px;font-weight:600;color:${sc.color};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${elem.name}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Click to cycle status
  el.querySelectorAll('[data-elem]').forEach(card => {
    card.addEventListener('click', () => {
      const elemId = /** @type {HTMLElement} */ (card).dataset.elem;
      cycleElementStatus(elemId);
      renderPipeline(el);
    });
  });
}

function cycleElementStatus(elemId) {
  const order = ['not_started', 'in_progress', 'complete', 'blocked', 'na'];
  for (const stage of dosStages) {
    const elem = stage.elements.find(e => e.id === elemId);
    if (elem) {
      const idx = order.indexOf(elem.status);
      elem.status = /** @type {any} */ (order[(idx + 1) % order.length]);
      break;
    }
  }
}

// ============================================================
// HOURS TAB
// ============================================================

function renderHours(el) {
  if (!activeDeal) return;

  const summary = calc.calcHoursSummary(hoursEntries);

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Summary Tiles -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Total Forecast</div>
          <div style="font-size:24px;font-weight:800;color:var(--ies-blue);margin-top:4px;">${summary.totalForecast.toFixed(1)}h</div>
        </div>
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Total Actual</div>
          <div style="font-size:24px;font-weight:800;color:var(--ies-green);margin-top:4px;">${summary.totalActual.toFixed(1)}h</div>
        </div>
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Delta</div>
          <div style="font-size:24px;font-weight:800;color:${summary.delta >= 0 ? 'var(--ies-red)' : 'var(--ies-green)'};margin-top:4px;">${summary.delta >= 0 ? '+' : ''}${summary.delta.toFixed(1)}h</div>
        </div>
        <div class="hub-card" style="padding:16px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);">Utilized</div>
          <div style="font-size:24px;font-weight:800;margin-top:4px;">${summary.percentUtilized.toFixed(0)}%</div>
        </div>
      </div>

      <!-- Hours Table -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div style="font-size:14px;font-weight:700;">Hours by Week & Work Type</div>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="dm-log-hours">+ Log Hours</button>
        </div>
        ${hoursEntries.length === 0 ? `
          <div style="text-align:center;padding:32px;color:var(--ies-gray-400);">No hours logged yet</div>
        ` : `
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:left;padding:8px;font-weight:700;">Week</th>
                <th style="text-align:left;padding:8px;font-weight:700;">Work Type</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Forecast</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Actual</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Delta</th>
                <th style="text-align:right;padding:8px;font-weight:700;"></th>
              </tr>
            </thead>
            <tbody>
              ${summary.byWeek.map(week => `
                <tr style="border-bottom:1px solid var(--ies-gray-200);">
                  <td style="padding:8px;font-weight:600;">${week.week}</td>
                  <td style="padding:8px;text-transform:capitalize;">${week.forecast > 0 || week.actual > 0 ? 'All Types' : '—'}</td>
                  <td style="padding:8px;text-align:right;font-weight:600;">${week.forecast}</td>
                  <td style="padding:8px;text-align:right;font-weight:600;">${week.actual}</td>
                  <td style="padding:8px;text-align:right;color:${week.delta >= 0 ? 'var(--ies-red)' : 'var(--ies-green)'};">${week.delta >= 0 ? '+' : ''}${week.delta}</td>
                  <td style="padding:8px;text-align:right;"></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>

      <!-- By Work Type Breakdown -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Breakdown by Work Type</div>
        ${summary.byWorkType.map(wt => {
          const total = wt.forecast + wt.actual;
          if (total === 0) return '';
          return `
            <div style="margin-bottom:16px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="font-size:12px;font-weight:600;">${wt.type}</span>
                <span style="font-size:12px;font-weight:700;">F: ${wt.forecast.toFixed(1)}h | A: ${wt.actual.toFixed(1)}h</span>
              </div>
              <div style="display:flex;height:20px;border-radius:4px;overflow:hidden;background:var(--ies-gray-200);">
                ${wt.forecast > 0 ? `<div style="flex:${wt.forecast};background:var(--ies-blue);"></div>` : ''}
                ${wt.actual > 0 ? `<div style="flex:${wt.actual};background:var(--ies-green);"></div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  el.querySelector('#dm-log-hours')?.addEventListener('click', () => showLogHoursModal());
}

function showLogHoursModal() {
  if (!activeDeal) return;
  const today = new Date().toISOString().split('T')[0];
  const Monday = new Date();
  const day = Monday.getDay();
  const diff = Monday.getDate() - day + (day === 0 ? -6 : 1);
  const startOfWeek = new Date(Monday.getFullYear(), Monday.getMonth(), diff);
  const weekStr = startOfWeek.toISOString().split('T')[0];

  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:500px;">
      <h3 style="margin:0 0 16px 0;">Log Hours</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Week Starting</label>
          <input type="date" id="dm-log-week" value="${weekStr}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Category</label>
          <select id="dm-log-category" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="forecast">Forecast</option>
            <option value="actual">Actual</option>
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Work Type</label>
          <select id="dm-log-type" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="Sales Design">Sales Design</option>
            <option value="Engineering">Engineering</option>
            <option value="Deal Mgmt">Deal Mgmt</option>
            <option value="Site Visit">Site Visit</option>
            <option value="Customer Meeting">Customer Meeting</option>
            <option value="Internal Review">Internal Review</option>
            <option value="Documentation">Documentation</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Hours</label>
          <input type="number" id="dm-log-hours-input" min="0" step="0.5" value="0" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Resource</label>
        <input type="text" id="dm-log-resource" value="Brock Eckles" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-log-save">Save Hours</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-log-save')?.addEventListener('click', async () => {
    const week = modal.querySelector('#dm-log-week').value;
    const hours = parseFloat(modal.querySelector('#dm-log-hours-input').value) || 0;
    const type = modal.querySelector('#dm-log-type').value;
    const resource = modal.querySelector('#dm-log-resource').value || 'Brock Eckles';
    const category = modal.querySelector('#dm-log-category').value;

    if (hours <= 0) { alert('Hours must be greater than 0'); return; }
    if (!activeDeal) return;

    const entry = { opportunity_id: activeDeal.id, week_start: week, hours_type: type, hours, resource, category };
    await api.logHours(entry);
    hoursEntries = await api.fetchHours(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderHours(el);
  });
}

// ============================================================
// TASKS TAB
// ============================================================

function renderTasksTab(el) {
  if (!activeDeal) return;

  const summary = calc.calcTaskProgress(tasks);

  el.innerHTML = `
    <div style="max-width:1000px;">
      <!-- Progress Summary -->
      <div class="hub-card" style="padding:16px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-size:14px;font-weight:700;">Task Progress</div>
          <span style="font-size:12px;color:var(--ies-gray-500);">${summary.done}/${summary.total} done</span>
        </div>
        <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--ies-gray-200);">
          <div style="flex:${summary.done};background:#22c55e;"></div>
          <div style="flex:${summary.inProgress};background:var(--ies-blue);"></div>
          <div style="flex:${summary.blocked};background:#ef4444;"></div>
          <div style="flex:${summary.total - summary.done - summary.inProgress - summary.blocked};background:var(--ies-gray-300);"></div>
        </div>
        <div style="display:flex;gap:16px;margin-top:12px;font-size:12px;">
          <span><strong style="color:var(--ies-green);">${summary.done}</strong> done</span>
          <span><strong style="color:var(--ies-blue);">${summary.inProgress}</strong> in progress</span>
          <span><strong style="color:var(--ies-red);">${summary.blocked}</strong> blocked</span>
        </div>
      </div>

      <!-- Tasks by Stage -->
      ${summary.byStage.map(stage => {
        const stageTasks = tasks.filter(t => t.dos_stage_number === stage.dosStageNumber);
        return `
          <div class="hub-card" style="padding:16px;margin-bottom:16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:2px solid var(--ies-gray-200);">
              <div>
                <div style="font-size:13px;font-weight:700;">Stage ${stage.dosStageNumber}: ${stage.dosStageName}</div>
              </div>
              <span style="font-size:12px;color:var(--ies-gray-500);">${stage.done}/${stage.total} complete</span>
            </div>
            ${stageTasks.length === 0 ? `
              <div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No tasks in this stage</div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${stageTasks.map(task => {
                  const statusColor = {
                    'todo': '#9ca3af',
                    'in_progress': 'var(--ies-blue)',
                    'done': '#22c55e',
                    'blocked': '#ef4444'
                  }[task.status] || '#6b7280';
                  const priorityColor = {
                    'low': '#6b7280',
                    'medium': 'var(--ies-blue)',
                    'high': '#f59e0b',
                    'critical': '#ef4444'
                  }[task.priority] || '#6b7280';

                  return `
                    <div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--ies-gray-200);border-radius:6px;">
                      <div style="width:20px;height:20px;border:2px solid ${statusColor};border-radius:4px;background:${task.status === 'done' ? statusColor : 'white'};"></div>
                      <div style="flex:1;">
                        <div style="font-size:12px;font-weight:600;${task.status === 'done' ? 'text-decoration:line-through;color:var(--ies-gray-400);' : ''}">${task.title}</div>
                        <div style="display:flex;gap:8px;margin-top:4px;font-size:10px;">
                          <span style="background:${statusColor};color:white;padding:2px 6px;border-radius:3px;font-weight:600;">${task.status.replace(/_/g,' ')}</span>
                          <span style="background:${priorityColor};color:white;padding:2px 6px;border-radius:3px;font-weight:600;">${task.priority}</span>
                          ${task.due_date ? `<span style="color:var(--ies-gray-500);">Due ${task.due_date}</span>` : ''}
                          ${task.estimated_hours ? `<span style="color:var(--ies-gray-500);">${task.estimated_hours}h</span>` : ''}
                        </div>
                      </div>
                      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="dm-edit-task" data-task-id="${task.id}">Edit</button>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>
        `;
      }).join('')}

      <!-- Add Task Button -->
      <div style="display:flex;gap:8px;margin-bottom:20px;">
        <button class="hub-btn hub-btn-primary" id="dm-add-task">+ Add Task</button>
        <button class="hub-btn hub-btn-secondary" id="dm-populate-dos">Populate DOS Activities</button>
      </div>
    </div>
  `;

  el.querySelector('#dm-add-task')?.addEventListener('click', () => showNewTaskModal());
  el.querySelector('#dm-populate-dos')?.addEventListener('click', () => showPopulateDosModal());
}

function showNewTaskModal() {
  if (!activeDeal) return;
  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:600px;">
      <h3 style="margin:0 0 16px 0;">Create Task</h3>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Title</label>
        <input type="text" id="dm-task-title" placeholder="Task title" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Priority</label>
          <select id="dm-task-priority" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">DOS Stage</label>
          <select id="dm-task-stage" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
            <option value="">None</option>
            ${DOS_STAGE_LABELS.map(s => `<option value="${s.number}">${s.number}: ${s.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Assignee</label>
          <input type="text" id="dm-task-assignee" value="Brock Eckles" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Due Date</label>
          <input type="date" id="dm-task-due" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Estimated Hours</label>
        <input type="number" id="dm-task-est-hours" min="0" step="0.5" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-task-save">Create Task</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-task-save')?.addEventListener('click', async () => {
    if (!activeDeal) return;
    const title = modal.querySelector('#dm-task-title').value.trim();
    if (!title) { alert('Title required'); return; }

    const task = {
      opportunity_id: activeDeal.id,
      title,
      priority: modal.querySelector('#dm-task-priority').value,
      status: /** @type {const} */ ('todo'),
      assignee: modal.querySelector('#dm-task-assignee').value || null,
      due_date: modal.querySelector('#dm-task-due').value || null,
      estimated_hours: parseFloat(modal.querySelector('#dm-task-est-hours').value) || null,
      dos_stage_number: parseInt(modal.querySelector('#dm-task-stage').value) || null,
    };

    await api.createTask(task);
    tasks = await api.fetchTasks(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderTasksTab(el);
  });
}

function showPopulateDosModal() {
  if (!activeDeal) return;
  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:500px;">
      <h3 style="margin:0 0 16px 0;">Populate DOS Activities</h3>
      <p style="color:var(--ies-gray-600);font-size:12px;margin-bottom:16px;">Select stages to add standard activities as tasks.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
        ${DOS_STAGE_LABELS.map(s => {
          const template = calc.getDosActivityTemplates(s.number);
          return `
            <label style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--ies-gray-200);border-radius:6px;cursor:pointer;">
              <input type="checkbox" class="dos-stage-cb" value="${s.number}" style="width:18px;height:18px;accent-color:var(--ies-blue);">
              <div style="flex:1;">
                <div style="font-weight:600;">Stage ${s.number}: ${s.name}</div>
                <div style="font-size:11px;color:var(--ies-gray-500);">${template.length} activities</div>
              </div>
            </label>
          `;
        }).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-populate-save">Populate</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-populate-save')?.addEventListener('click', async () => {
    if (!activeDeal) return;
    const selected = Array.from(modal.querySelectorAll('.dos-stage-cb:checked')).map(cb => parseInt(cb.value));
    if (selected.length === 0) { alert('Select at least one stage'); return; }

    for (const stageNum of selected) {
      const templates = calc.getDosActivityTemplates(stageNum);
      const stageName = DOS_STAGE_LABELS.find(s => s.number === stageNum)?.name || `Stage ${stageNum}`;
      for (const template of templates) {
        const task = {
          opportunity_id: activeDeal.id,
          title: template.title,
          description: template.description,
          status: /** @type {const} */ ('todo'),
          priority: /** @type {const} */ ('medium'),
          dos_stage_number: stageNum,
          dos_stage_name: stageName,
        };
        await api.createTask(task);
      }
    }

    tasks = await api.fetchTasks(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderTasksTab(el);
  });
}

// ============================================================
// UPDATES TAB
// ============================================================

function renderUpdatesTab(el) {
  if (!activeDeal) return;

  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Weekly Updates</h3>
        <button class="hub-btn hub-btn-sm hub-btn-primary" id="dm-new-update">+ New Update</button>
      </div>

      ${updates.length === 0 ? `
        <div class="hub-card" style="text-align:center;padding:32px;color:var(--ies-gray-400);">
          No updates yet
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:16px;">
          ${updates.map(u => `
            <div class="hub-card" style="padding:16px;border-left:4px solid var(--ies-blue);">
              <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">
                <div>
                  <div style="font-size:13px;font-weight:700;">${u.update_date}</div>
                  <div style="font-size:11px;color:var(--ies-gray-500);">${u.author || 'Unknown'}</div>
                </div>
                <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="dm-delete-update" data-update-id="${u.id}" style="color:var(--ies-red);">Delete</button>
              </div>
              <div style="font-size:13px;color:var(--ies-navy);line-height:1.5;margin-bottom:12px;white-space:pre-wrap;">${u.body || ''}</div>
              ${u.next_steps ? `
                <div style="padding:10px 12px;background:rgba(37,99,235,.05);border-left:3px solid var(--ies-blue);border-radius:4px;margin-bottom:8px;">
                  <div style="font-size:11px;font-weight:700;color:var(--ies-blue);text-transform:uppercase;margin-bottom:4px;">Next Steps</div>
                  <div style="font-size:12px;white-space:pre-wrap;">${u.next_steps}</div>
                </div>
              ` : ''}
              ${u.blockers ? `
                <div style="padding:10px 12px;background:rgba(239,68,68,.05);border-left:3px solid var(--ies-red);border-radius:4px;">
                  <div style="font-size:11px;font-weight:700;color:var(--ies-red);text-transform:uppercase;margin-bottom:4px;">Blockers</div>
                  <div style="font-size:12px;white-space:pre-wrap;">${u.blockers}</div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;

  el.querySelector('#dm-new-update')?.addEventListener('click', () => showNewUpdateModal());
}

function showNewUpdateModal() {
  if (!activeDeal) return;
  const today = new Date().toISOString().split('T')[0];
  const modal = document.createElement('div');
  modal.className = 'hub-modal-overlay';
  modal.innerHTML = `
    <div class="hub-modal" style="max-width:600px;">
      <h3 style="margin:0 0 16px 0;">New Weekly Update</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Date</label>
          <input type="date" id="dm-update-date" value="${today}" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Author</label>
          <input type="text" id="dm-update-author" value="Brock Eckles" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;">
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Update</label>
        <textarea id="dm-update-body" placeholder="What happened this week?" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;min-height:100px;font-family:inherit;"></textarea>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Next Steps</label>
        <textarea id="dm-update-next" placeholder="What's planned next?" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;min-height:60px;font-family:inherit;"></textarea>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px;">Blockers (optional)</label>
        <textarea id="dm-update-blockers" placeholder="Any blockers or risks?" style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;min-height:60px;font-family:inherit;"></textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="hub-btn hub-btn-secondary" onclick="this.closest('.hub-modal-overlay').remove()">Cancel</button>
        <button class="hub-btn hub-btn-primary" id="dm-update-save">Post Update</button>
      </div>
    </div>
  `;
  rootEl?.appendChild(modal);
  modal.querySelector('#dm-update-save')?.addEventListener('click', async () => {
    if (!activeDeal) return;
    const body = modal.querySelector('#dm-update-body').value.trim();
    if (!body) { alert('Update body required'); return; }

    const update = {
      opportunity_id: activeDeal.id,
      update_date: modal.querySelector('#dm-update-date').value,
      author: modal.querySelector('#dm-update-author').value || null,
      body,
      next_steps: modal.querySelector('#dm-update-next').value.trim() || null,
      blockers: modal.querySelector('#dm-update-blockers').value.trim() || null,
    };

    await api.createUpdate(update);
    updates = await api.fetchUpdates(activeDeal.id);
    modal.remove();
    const el = rootEl?.querySelector('#dm-content');
    if (el) renderUpdatesTab(el);
  });
}

// ============================================================
// HELPERS
// ============================================================

function kpi(label, value, color) {
  return `
    <div style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}

// ============================================================
// MUL-G3 — SENSITIVITY TAB
// ============================================================

function renderSensitivity(el) {
  if (!activeDeal || sites.length === 0) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Add at least one site to see sensitivity analysis.</p></div>';
    return;
  }
  const sens = calc.calcDealSensitivity(sites, {
    years: activeDeal.contractTermYears || 5,
    opts: {
      ebitdaOverheadPct: Number(dealConfig.ebitdaOverheadPct),
      discountRate: Number(dealConfig.discountRate) / 100,
      weights: dealConfig.scoreWeights,
      gradeThresholds: dealConfig.gradeThresholds,
    },
    xAxis: sensCfg.xAxis, xRange: sensCfg.xRange,
    yAxis: sensCfg.yAxis, yRange: sensCfg.yRange,
  });
  const axisLabel = (k) => ({
    costPct: 'Cost % delta', marginPct: 'Margin pp delta', volumePct: 'Volume % delta', startupPct: 'Startup % delta',
  })[k] || k;
  const cellBg = (g) => scoreBg(g);
  const cellFg = (g) => scoreColor(g);
  el.innerHTML = `
    <div style="max-width:1000px;">
      <div class="hub-card" style="padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:14px;font-weight:700;">Sensitivity Grid</div>
            <div style="font-size:12px;color:var(--ies-gray-500);margin-top:2px;">Each cell flexes the X-axis variable on top of the Y-axis variable, then re-scores the deal.</div>
          </div>
          <div style="display:flex;gap:14px;font-size:12px;align-items:center;flex-wrap:wrap;">
            <label>X-axis <select data-sens-axis="x" style="padding:4px 8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;">
              ${['costPct','marginPct','volumePct','startupPct'].map(k => `<option value="${k}" ${sensCfg.xAxis === k ? 'selected' : ''}>${axisLabel(k)}</option>`).join('')}
            </select></label>
            <label>Y-axis <select data-sens-axis="y" style="padding:4px 8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;">
              ${['costPct','marginPct','volumePct','startupPct'].map(k => `<option value="${k}" ${sensCfg.yAxis === k ? 'selected' : ''}>${axisLabel(k)}</option>`).join('')}
            </select></label>
          </div>
        </div>
      </div>

      <div class="hub-card" style="padding:16px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--ies-gray-100);">
              <th style="padding:8px;text-align:center;font-weight:700;color:var(--ies-gray-500);">${axisLabel(sens.yAxis)} \\ ${axisLabel(sens.xAxis)}</th>
              ${sens.xRange.map(x => `<th style="padding:8px;text-align:center;font-weight:700;">${x > 0 ? '+' : ''}${x}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${sens.grid.map((row, r) => `
              <tr>
                <td style="padding:8px;text-align:center;font-weight:700;background:var(--ies-gray-100);">${sens.yRange[r] > 0 ? '+' : ''}${sens.yRange[r]}</td>
                ${row.map(c => `
                  <td style="padding:10px;text-align:center;background:${cellBg(c.grade)};border:1px solid var(--ies-gray-100);">
                    <div style="font-size:14px;font-weight:800;color:${cellFg(c.grade)};">${c.grade}</div>
                    <div style="font-size:11px;color:var(--ies-gray-600);">${c.score} pts</div>
                    <div style="font-size:10px;color:var(--ies-gray-500);">${c.ebitdaPct.toFixed(1)}% EBITDA</div>
                  </td>
                `).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  setTimeout(() => {
    el.querySelectorAll('[data-sens-axis]').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const which = e.target.dataset.sensAxis;
        const v = e.target.value;
        sensCfg = { ...sensCfg, [which === 'x' ? 'xAxis' : 'yAxis']: v };
        renderSensitivity(el);
      });
    });
  }, 0);
}

// ============================================================
// MUL-G2 — COMPARE TAB
// ============================================================

function renderCompare(el) {
  if (!activeDeal) return;
  // Default: include the active deal + first 2 others
  if (compareDealIds.length === 0) {
    compareDealIds = [activeDeal.id, ...allDeals.filter(d => d.id !== activeDeal.id).slice(0, 2).map(d => d.id)];
  }
  const candidates = allDeals.length ? allDeals : [activeDeal];
  const selected = compareDealIds.map(id => candidates.find(d => d.id === id)).filter(Boolean);
  const computed = selected.map(d => {
    const dSites = (d.id === activeDeal.id) ? sites : (d._sites || []);
    const fin = calc.computeDealFinancials(dSites, d.contractTermYears || 5, {
      ebitdaOverheadPct: Number(dealConfig.ebitdaOverheadPct),
      discountRate: Number(dealConfig.discountRate) / 100,
    });
    const sc = calc.computeDealScore(fin, { weights: dealConfig.scoreWeights, gradeThresholds: dealConfig.gradeThresholds });
    return { deal: d, fin, score: sc, sitesCount: dSites.length };
  });
  el.innerHTML = `
    <div style="max-width:1100px;">
      <div class="hub-card" style="padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:14px;font-weight:700;">Side-by-Side Comparison</div>
            <div style="font-size:12px;color:var(--ies-gray-500);margin-top:2px;">Compare up to 4 deals across financial KPIs. Active deal pinned in column 1.</div>
          </div>
          <div style="font-size:12px;">
            <select id="dm-compare-add" style="padding:4px 8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;">
              <option value="">+ Add deal to compare…</option>
              ${candidates.filter(d => !compareDealIds.includes(d.id)).map(d => `<option value="${d.id}">${d.dealName}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="hub-card" style="padding:16px;overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:680px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px;font-weight:700;color:var(--ies-gray-500);">Metric</th>
              ${computed.map(c => `<th style="text-align:right;padding:8px;font-weight:700;">${c.deal.dealName}${c.deal.id === activeDeal.id ? ' <span style="font-size:10px;color:var(--ies-blue);">(active)</span>' : ` <button class="hub-btn-icon" data-compare-remove="${c.deal.id}" title="Remove" style="border:0;background:transparent;cursor:pointer;color:var(--ies-gray-400);">×</button>`}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${cmpRow('Sites', computed, c => c.sitesCount)}
            ${cmpRow('Total SqFt', computed, c => c.fin.totalSqft.toLocaleString())}
            ${cmpRow('Annual Revenue', computed, c => calc.formatCurrency(c.fin.totalAnnualRevenue, { compact: true }))}
            ${cmpRow('Annual Cost', computed, c => calc.formatCurrency(c.fin.totalAnnualCost, { compact: true }))}
            ${cmpRow('Gross Margin %', computed, c => calc.formatPct(c.fin.grossMarginPct))}
            ${cmpRow('EBITDA %', computed, c => calc.formatPct(c.fin.ebitdaPct))}
            ${cmpRow('NPV', computed, c => calc.formatCurrency(c.fin.npv, { compact: true }))}
            ${cmpRow('Payback', computed, c => calc.formatMonths(c.fin.paybackMonths))}
            ${cmpRow('Score', computed, c => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${scoreBg(c.score.grade)};color:${scoreColor(c.score.grade)};font-weight:700;">${c.score.grade} (${c.score.score})</span>`)}
          </tbody>
        </table>
      </div>
    </div>
  `;
  setTimeout(() => {
    el.querySelector('#dm-compare-add')?.addEventListener('change', (e) => {
      const v = e.target.value;
      if (v) {
        compareDealIds.push(v);
        renderCompare(el);
      }
    });
    el.querySelectorAll('[data-compare-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.compareRemove;
        compareDealIds = compareDealIds.filter(x => x !== id);
        renderCompare(el);
      });
    });
  }, 0);
}

function cmpRow(label, computed, getter) {
  return `
    <tr style="border-bottom:1px solid var(--ies-gray-100);">
      <td style="padding:8px;font-weight:600;color:var(--ies-gray-700);">${label}</td>
      ${computed.map(c => `<td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${getter(c)}</td>`).join('')}
    </tr>
  `;
}

function cfgKnob(label, key, value, unit, step, hint) {
  return `
    <div style="display:flex;flex-direction:column;gap:4px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-500);" title="${hint || ''}">${label}</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <input type="number" data-deal-cfg="${key}" value="${value}" step="${step}" style="flex:1;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:13px;font-weight:600;text-align:right;">
        <span style="font-size:11px;color:var(--ies-gray-500);width:36px;">${unit}</span>
      </div>
    </div>
  `;
}

function scoreColor(grade) {
  // MUL-A4 — softened palette. F was solid #991b1b which read as a hard
  // accusation in demos; new value is a desaturated coral that signals
  // "needs work" without dominating the deal header.
  return { A: '#22c55e', B: 'var(--ies-blue)', C: '#f59e0b', D: '#f87171', F: '#dc8a8a' }[grade] || '#6b7280';
}

/** MUL-A4 — tinted background for the score badge (subtle, never >12% alpha). */
function scoreBg(grade) {
  return { A: '#22c55e15', B: 'var(--ies-blue)15', C: '#f59e0b15', D: '#f8717115', F: '#dc8a8a18' }[grade] || '#6b728018';
}

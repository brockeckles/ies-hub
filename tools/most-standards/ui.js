/**
 * IES Hub v3 — MOST Labor Standards UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Three modes: Template Library, Quick Labor Analysis, Workflow Composer.
 *
 * @module tools/most-standards/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sM';
import { state } from '../../shared/state.js?v=20260418-sM';
import { renderToolHeader, bindPrimaryActionShortcut, flashRunButton } from '../../shared/tool-frame.js?v=20260419-uE';
// Note: MOST intentionally opts out of run-state tracking. Its Quick Analysis
// and Workflow tabs recompute inline on every render — the primary "Run"
// button is a convenience trigger rather than a discrete compute step, so a
// "clean/dirty" gate would be misleading here. Revisit if/when MOST gains a
// heavier recompute path (MOST B4 productivity factor, maybe).
import * as calc from './calc.js?v=20260426-s2';
import * as api from './api.js?v=20260426-s2';
import { getMostTplName, getMostTplBaseUph, getMostTplTmuTotal, getMostElName, getMostElSequence, getMostElTmu } from './types.js?v=20260418-sM';

// ============================================================
// STATE — tool-local
// ============================================================

/** @type {'library' | 'editor' | 'analysis' | 'workflow'} */
let activeTab = 'library';

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {{ templates: import('./types.js?v=20260418-sM').MostTemplate[], allowanceProfiles: import('./types.js?v=20260418-sM').AllowanceProfile[] }} */
let refData = { templates: [], allowanceProfiles: [] };

/** @type {import('./types.js?v=20260418-sM').MostTemplate|null} */
let selectedTemplate = null;

/** @type {import('./types.js?v=20260418-sM').MostElement[]} */
let selectedElements = [];

/** Template editor state — null if not editing, or a copy of the template being edited */
let editorTemplate = null;

/** Editor elements for the current template being edited */
let editorElements = [];

/** Saved scenarios for Quick Analysis (Supabase-backed via api.most_analyses) */
let savedScenarios = [];

/**
 * Load saved scenarios from Supabase. Falls back to legacy localStorage
 * cache if the network is unavailable so the UI is still useful offline.
 * Migrates any legacy localStorage rows to Supabase on first successful load.
 */
async function loadSavedScenarios() {
  try {
    const rows = await api.listAnalyses();
    savedScenarios = rows.map(row => analysisRowToScenario(row));

    // One-shot migration of legacy localStorage scenarios: push any local-only
    // entries up to Supabase, then clear the cache so we don't re-import.
    try {
      const legacy = JSON.parse(localStorage.getItem('most_scenarios') || '[]');
      if (Array.isArray(legacy) && legacy.length && !rows.length) {
        for (const sc of legacy) {
          const data = sc.data || sc;
          await api.saveAnalysis({
            name: sc.name || 'Migrated Scenario',
            pfd_pct: sc.pfd ?? data.pfd_pct ?? 14,
            shift_hours: sc.shiftHrs ?? data.shift_hours ?? 8,
            operating_days: data.operating_days ?? 250,
            hourly_rate: sc.rate ?? data.hourly_rate ?? 0,
            lines: data.lines || [],
          });
        }
        const migrated = await api.listAnalyses();
        savedScenarios = migrated.map(analysisRowToScenario);
        localStorage.removeItem('most_scenarios');
        console.info('[MOST] Migrated', legacy.length, 'localStorage scenarios to Supabase');
      }
    } catch (migErr) {
      console.warn('[MOST] Legacy migration skipped:', migErr);
    }
  } catch (err) {
    console.warn('[MOST] Falling back to localStorage scenarios — Supabase load failed:', err);
    try {
      const saved = localStorage.getItem('most_scenarios');
      savedScenarios = saved ? JSON.parse(saved) : [];
    } catch {
      savedScenarios = [];
    }
  }
}

/** Map a most_analyses DB row → the in-memory scenario shape used by the UI. */
function analysisRowToScenario(row) {
  const data = (row.analysis_data && typeof row.analysis_data === 'object') ? row.analysis_data : {};
  const lines = data.lines || [];
  // productivity_pct is stashed inside analysis_data jsonb (no DB column).
  const productivity = data.productivity_pct == null ? 90 : Number(data.productivity_pct);
  // Recompute summary so display KPIs always match current calc engine
  const computed = lines.map(line => ({
    ...line,
    ...calc.computeAnalysisLine({
      base_uph: line.base_uph,
      pfd_pct: row.pfd_pct,
      productivity_pct: productivity,
      daily_volume: line.daily_volume,
      shift_hours: row.shift_hours,
      hourly_rate: line.hourly_rate || row.hourly_rate,
    }),
  }));
  const summary = calc.computeAnalysisSummary(computed, row.operating_days || 250);
  return {
    id: row.id,
    name: row.name || 'Untitled',
    timestamp: row.updated_at ? new Date(row.updated_at).toLocaleString() : '',
    lines: lines.length,
    pfd: row.pfd_pct,
    shiftHrs: row.shift_hours,
    rate: row.hourly_rate,
    ftes: summary.totalFtes,
    headcount: summary.totalHeadcount,
    hours: summary.totalHoursPerDay,
    dailyCost: summary.dailyCost,
    annualCost: summary.annualCost,
    data: {
      pfd_pct: row.pfd_pct,
      productivity_pct: productivity,
      shift_hours: row.shift_hours,
      operating_days: row.operating_days || 250,
      hourly_rate: row.hourly_rate,
      // MOS-E3 + MOS-B5: per-category rates + learning curve are stashed
      // in analysis_data jsonb. Default sensibly when missing for legacy rows.
      rates_by_category: data.rates_by_category || null,
      learning_curve_pct: data.learning_curve_pct == null ? 100 : Number(data.learning_curve_pct),
      lines,
      allowance_profile_id: row.allowance_profile_id || null,
    },
  };
}

/** Filters for template library */
let filters = { search: '', processArea: '', laborCategory: '' };

// --- Analysis state ---
/** @type {import('./types.js?v=20260418-sM').LaborAnalysis} */
let analysis = createEmptyAnalysis();

// --- Workflow state ---
/** @type {import('./types.js?v=20260418-sM').Workflow} */
let workflow = createEmptyWorkflow();

// ============================================================
// PROCESS AREAS & CATEGORIES
// ============================================================

const PROCESS_AREAS = ['Receiving', 'Putaway', 'Picking', 'Packing', 'Shipping', 'Inventory'];
const LABOR_CATEGORIES = ['manual', 'mhe', 'hybrid'];

// MOST-3 — inline SVG icons for editor UI. Using SVG over emoji/text so they
// render consistently across platforms and support currentColor theming.
const ICON = {
  pencil:       `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`,
  copy:         `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  trash:        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`,
  plus:         `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  check:        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  chevronLeft:  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  templatesEmpty: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
};

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * MOST-1 — open a template in the Editor tab on tile click.
 * Loads the template + its elements via api, flips to the Editor tab,
 * re-renders the shell so the conditional Run button matches, and
 * renders the editor content.
 */
async function openTemplateInEditor(id) {
  if (!rootEl || !id) return;
  // Template IDs in refData are numeric (from Postgres); data-id attributes are strings.
  // Normalize both sides so the === match doesn't silently fail.
  const tpl = (refData.templates || []).find(t => String(t.id) === String(id));
  if (!tpl) return;
  editorTemplate = { ...tpl };
  try { editorElements = (await api.listElements(id)) || []; } catch { editorElements = []; }
  activeTab = 'editor';
  rootEl.innerHTML = renderShell(); // full re-render so Run button visibility flips + active tab chip updates
  renderContent();
}

/**
 * Mount the MOST Labor Standards tool.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeTab = 'library';
  selectedTemplate = null;
  selectedElements = [];
  editorTemplate = null;
  editorElements = [];
  filters = { search: '', processArea: '', laborCategory: '' };
  analysis = createEmptyAnalysis();
  workflow = createEmptyWorkflow();

  // Kick off async load; re-render when scenarios come back
  loadSavedScenarios().then(() => {
    if (rootEl && activeTab === 'analysis') renderContent();
  });

  el.innerHTML = renderShell();

  // Root-level event delegation survives shell re-renders (needed so
  // MOST-2's conditional Run button can toggle on tab change). Per the
  // event-delegation memo.
  el.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (!target) return;

    // Tab switching — re-render the full shell so the primary-action button
    // appears only on tabs where it does real work.
    const tabBtn = target.closest('#most-tabs [data-tab]');
    if (tabBtn) {
      activeTab = /** @type {any} */ (tabBtn.dataset.tab);
      el.innerHTML = renderShell();
      renderContent();
      return;
    }

    // Back to Design Tools
    if (target.closest('[data-action="most-back"]')) {
      window.location.hash = 'designtools';
      return;
    }

    // Primary action — routes to whichever tab's "run" makes sense
    const runBtn = target.closest('[data-primary-action="most-run"]');
    if (runBtn) {
      if (activeTab === 'analysis') {
        const calcBtn = el.querySelector('#most-analysis-calc, [data-action="most-analyze"]');
        if (calcBtn) /** @type {HTMLButtonElement} */ (calcBtn).click();
      } else if (activeTab === 'workflow') {
        const calcBtn = el.querySelector('[data-action="most-workflow-calc"]');
        if (calcBtn) /** @type {HTMLButtonElement} */ (calcBtn).click();
      }
      flashRunButton(runBtn);
      return;
    }

    // MOST-1 — Template tile clicks (root-level delegation so innerHTML
    // swaps don't orphan per-element listeners). Also catches clicks on
    // inner spans/divs inside the card.
    const tileCard = target.closest('.most-tpl-card[data-action="select-template"]');
    if (tileCard) {
      const id = tileCard.getAttribute('data-id');
      openTemplateInEditor(id);
      return;
    }
  });
  bindPrimaryActionShortcut(el, 'most-run');

  // Load ref data
  try {
    refData = await api.loadRefData();
    // Update the ref-data chip after templates load
    const chip = el.querySelector('.hub-tool-status .hub-status-chip');
    if (chip) chip.textContent = `${refData.templates.length} templates`;
  } catch (err) {
    console.warn('[MOST] Failed to load ref data:', err);
  }

  renderContent();
  bus.emit('most:mounted');
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  rootEl = null;
  bus.emit('most:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  const tabs = [
    { key: 'library', label: 'Template Library' },
    { key: 'editor', label: 'Template Editor' },
    { key: 'analysis', label: 'Quick Analysis' },
    { key: 'workflow', label: 'Workflow Composer · Preview', title: 'Preview — composes templates into a workflow; volume rebalancing + bottleneck chart still in development' },
  ];
  const chips = [
    { label: `${refData.templates.length} templates`, kind: 'default' },
    savedScenarios.length
      ? { label: `${savedScenarios.length} saved analyses`, kind: 'linked' }
      : null,
  ].filter(Boolean);
  // MOST-2 — Run Analysis is only meaningful on Quick Analysis + Workflow
  // tabs (where the calc fires). On Library + Editor it just jumps to
  // Analysis, which confuses users into thinking they have to click it
  // before picking a template. Hide it there.
  const showRunBtn = activeTab === 'analysis' || activeTab === 'workflow';
  const primaryActionLabel = activeTab === 'workflow' ? 'Run Workflow' : 'Run Analysis';
  return `
    <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height: calc(100vh - 48px);">
      ${renderToolHeader({
        toolName: 'MOST Labor Standards',
        toolKey: 'most',
        backAction: 'most-back',
        backLabel: '← Design Tools',
        tabs,
        activeTab,
        tabsId: 'most-tabs',
        statusChips: chips,
        primaryAction: showRunBtn
          ? { label: primaryActionLabel, action: 'most-run', icon: '▶', title: 'Compute labor standards (Cmd/Ctrl+Enter)' }
          : null,
      })}
      <!-- Content -->
      <div class="hub-analyzer-content" id="most-content" style="flex:1;padding: 24px; overflow-y: auto;">
        <!-- Tab content renders here -->
      </div>
    </div>

    <style>
      .most-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
      .most-tpl-card {
        border: 1px solid var(--ies-gray-200);
        border-radius: 8px;
        padding: 16px;
        cursor: pointer;
        transition: all 0.15s ease;
        background: #fff;
      }
      .most-tpl-card:hover { border-color: var(--ies-blue); box-shadow: 0 2px 8px rgba(0,71,171,0.1); }
      .most-tpl-card.selected { border-color: var(--ies-blue); background: rgba(0,71,171,0.03); }
      .most-tpl-name { font-size: 14px; font-weight: 700; color: var(--ies-navy); margin-bottom: 4px; }
      .most-tpl-meta { font-size: 12px; color: var(--ies-gray-500); display: flex; gap: 12px; margin-bottom: 8px; }
      .most-tpl-stats { display: flex; gap: 16px; font-size: 13px; }
      .most-tpl-stat { font-weight: 700; }
      .most-tpl-stat span { font-weight: 400; color: var(--ies-gray-500); font-size: 11px; display: block; }

      .most-cat-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }
      .most-cat-manual { background: rgba(0,71,171,0.1); color: var(--ies-blue); }
      .most-cat-mhe { background: rgba(32,201,151,0.1); color: #0d9668; }
      .most-cat-hybrid { background: rgba(255,149,0,0.1); color: #cc7700; }

      /* Q3: visual cue when an analysis line is variable — thin
         orange leader on the left + subtle wash so the row draws the
         eye without overwhelming the otherwise-dense table. */
      .most-row-variable td {
        background: rgba(255, 149, 0, 0.04);
      }
      .most-row-variable td:first-child {
        box-shadow: inset 3px 0 0 var(--ies-orange, #d97706);
      }

      .most-detail-panel {
        border: 1px solid var(--ies-gray-200);
        border-radius: 8px;
        padding: 20px;
        background: #fff;
        margin-top: 16px;
      }

      .most-filter-bar {
        display: flex;
        gap: 12px;
        align-items: center;
        margin-bottom: 20px;
        flex-wrap: wrap;
      }
      .most-filter-bar input, .most-filter-bar select {
        padding: 8px 12px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 10px;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 600;
      }
      .most-filter-bar input:focus, .most-filter-bar select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 2px rgba(0,71,171,0.1);
      }

      .most-workflow-step {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 8px;
        background: #fff;
        margin-bottom: 8px;
      }
      .most-workflow-step.bottleneck { border-color: var(--ies-red); background: rgba(220,53,69,0.03); }
      .most-workflow-arrow {
        text-align: center;
        color: var(--ies-gray-300);
        font-size: 18px;
        margin-bottom: 8px;
      }

      /* .most-push-btn removed 2026-04-18 (X2) — buttons now use shared .hub-btn + .hub-btn-primary */

      /* =========================================================
         MOST-3 — Template Editor refresh (2026-04-19)
         Replaces dated cm-edit-btn / cm-delete-btn with a clean
         icon+label action pattern. Tokens all reference the design
         system standards memo.
         ========================================================= */

      .most-editor-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        margin-bottom: 24px;
        padding-bottom: 20px;
        border-bottom: 1px solid var(--ies-gray-200);
      }
      .most-editor-toolbar-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-shrink: 0;
      }
      .most-editor-title {
        font-size: 20px;
        font-weight: 800;
        color: var(--ies-navy);
        margin: 0;
        letter-spacing: -0.2px;
      }
      .most-editor-subtitle {
        font-size: 13px;
        color: var(--ies-gray-500);
        margin: 4px 0 0 0;
        font-weight: 500;
      }
      .most-editor-breadcrumb {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--ies-gray-500);
        margin-bottom: 6px;
        font-weight: 600;
      }
      .most-breadcrumb-link {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: none;
        border: none;
        padding: 2px 6px;
        margin-left: -6px;
        color: var(--ies-gray-500);
        font-size: 12px;
        font-weight: 600;
        font-family: Montserrat, sans-serif;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.15s ease;
      }
      .most-breadcrumb-link:hover {
        background: var(--ies-gray-100);
        color: var(--ies-blue);
      }

      .most-table-card {
        background: #fff;
        border: 1px solid var(--ies-gray-200);
        border-radius: 10px;
        overflow: hidden;
        box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.05));
      }
      .most-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .most-table thead th {
        background: var(--ies-gray-50);
        color: var(--ies-gray-500);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 12px 16px;
        text-align: left;
        border-bottom: 1px solid var(--ies-gray-200);
      }
      .most-table tbody td {
        padding: 12px 16px;
        border-bottom: 1px solid var(--ies-gray-100);
        color: var(--ies-gray-600);
        font-weight: 500;
      }
      .most-table tbody tr:last-child td { border-bottom: none; }
      .most-row-hover:hover { background: #f8fafc; }
      .most-table td.cm-num { text-align: right; font-variant-numeric: tabular-nums; }

      /* Row actions — icon buttons with hover tint */
      .most-row-actions {
        display: inline-flex;
        gap: 4px;
        align-items: center;
      }
      .most-icon-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 10px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 10px;
        color: var(--ies-gray-500);
        font-family: Montserrat, sans-serif;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.12s ease;
        white-space: nowrap;
      }
      .most-icon-btn:hover {
        background: rgba(0, 71, 171, 0.08);
        border-color: rgba(0, 71, 171, 0.15);
        color: var(--ies-blue);
      }
      .most-icon-btn:active { transform: translateY(0.5px); }
      .most-icon-btn svg { display: block; opacity: 0.85; }
      .most-icon-btn-danger:hover {
        background: rgba(220, 53, 69, 0.08);
        border-color: rgba(220, 53, 69, 0.18);
        color: var(--ies-red);
      }

      /* MOS-F2: Drag-reorder visuals for editor element rows */
      .most-elem-row[draggable="true"] { transition: background 0.12s ease, opacity 0.12s ease; }
      .most-elem-row--dragging { opacity: 0.45; background: var(--ies-gray-50); }
      .most-elem-row--drop-target { box-shadow: inset 0 -3px 0 0 var(--ies-blue, #0047ab); }
      .most-elem-row--variable { background: rgba(249, 115, 22, 0.04); }

            /* Empty state for the editor list */
      .most-empty-state {
        text-align: center;
        padding: 60px 20px;
        background: var(--ies-gray-50);
        border: 1px dashed var(--ies-gray-200);
        border-radius: 10px;
      }
      .most-empty-icon {
        color: var(--ies-gray-300);
        margin: 0 auto 16px;
        display: inline-block;
      }
      .most-empty-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--ies-navy);
        margin-bottom: 4px;
      }
      .most-empty-body {
        font-size: 13px;
        color: var(--ies-gray-500);
      }

      /* Sticky footer action bar for the edit form */
      .most-editor-footer {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 24px;
        padding-top: 20px;
        border-top: 1px solid var(--ies-gray-200);
      }
    </style>
  `;
}

// ============================================================
// CONTENT RENDERING
// ============================================================

function renderContent() {
  const container = rootEl?.querySelector('#most-content');
  if (!container) return;

  const renderers = { library: renderLibrary, editor: renderEditor, analysis: renderAnalysis, workflow: renderWorkflowComposer };
  const render = renderers[activeTab];
  if (render) {
    container.innerHTML = render();
    bindContentEvents(container);
  }
}

/**
 * MOS-D4: re-render the active tab while preserving focus + caret position
 * on the input the user is typing into. Without this, every Analysis-tab
 * field change blew away focus mid-tab — making rapid data entry painful.
 * The selector strategy keys on data-line/data-param/data-rate-cat/data-wf
 * pairs which uniquely identify each input across renders.
 */
function rerenderPreservingFocus() {
  const container = rootEl?.querySelector('#most-content');
  if (!container) { renderContent(); return; }
  const active = document.activeElement;
  let selector = null;
  let selStart = null;
  let selEnd = null;
  if (active && active.dataset && container.contains(active)) {
    const ds = active.dataset;
    if (ds.line != null && ds.field) selector = `[data-line="${ds.line}"][data-field="${ds.field}"]`;
    else if (ds.param) selector = `[data-param="${ds.param}"]`;
    else if (ds.rateCat) selector = `[data-rate-cat="${ds.rateCat}"]`;
    else if (ds.wf) selector = `[data-wf="${ds.wf}"]`;
    else if (ds.wfStep != null && ds.field) selector = `[data-wf-step="${ds.wfStep}"][data-field="${ds.field}"]`;
    else if (ds.elemIdx != null && ds.elemField) selector = `[data-elem-idx="${ds.elemIdx}"][data-elem-field="${ds.elemField}"]`;
    if (active.selectionStart != null && typeof active.selectionStart === 'number') {
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
    }
  }
  renderContent();
  if (selector) {
    const next = container.querySelector(selector);
    if (next instanceof HTMLElement) {
      next.focus();
      if (selStart != null && next instanceof HTMLInputElement && next.type !== 'checkbox' && next.type !== 'number') {
        try { next.setSelectionRange(selStart, selEnd); } catch (_) {}
      }
    }
  }
}

// ============================================================
// TAB 1: TEMPLATE LIBRARY
// ============================================================

function renderLibrary() {
  const filtered = filterTemplates();
  const grouped = groupByProcessArea(filtered);

  return `
    <div class="most-filter-bar">
      <input type="text" placeholder="Search templates..." value="${filters.search}" id="most-search" style="width:220px;" />
      <select id="most-filter-area">
        <option value="">All Process Areas</option>
        ${PROCESS_AREAS.map(a => `<option value="${a}"${filters.processArea === a ? ' selected' : ''}>${a}</option>`).join('')}
      </select>
      <select id="most-filter-cat">
        <option value="">All Categories</option>
        ${LABOR_CATEGORIES.map(c => `<option value="${c}"${filters.laborCategory === c ? ' selected' : ''}>${c.toUpperCase()}</option>`).join('')}
      </select>
      <span style="font-size:12px; color:var(--ies-gray-400); margin-left:auto;">${filtered.length} template${filtered.length !== 1 ? 's' : ''}</span>
    </div>

    ${Object.entries(grouped).map(([area, templates]) => `
      <div style="margin-bottom: 24px;">
        <div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--ies-gray-500); margin-bottom:12px;">${area}</div>
        <div class="most-card-grid">
          ${templates.map(t => renderTemplateCard(t)).join('')}
        </div>
      </div>
    `).join('')}

    ${filtered.length === 0 ? '<div style="text-align:center; padding:40px; color:var(--ies-gray-400);">No templates match your filters.</div>' : ''}

    ${selectedTemplate ? renderTemplateDetail() : ''}
  `;
}

function renderTemplateCard(t) {
  const isSelected = selectedTemplate?.id === t.id;
  const tplName = getMostTplName(t);
  const tplUph = getMostTplBaseUph(t);
  const tplTmu = getMostTplTmuTotal(t);
  return `
    <div class="most-tpl-card${isSelected ? ' selected' : ''}" data-action="select-template" data-id="${t.id}">
      <div class="most-tpl-name">${tplName}</div>
      <div class="most-tpl-meta">
        <span class="most-cat-badge most-cat-${t.labor_category || 'manual'}">${(t.labor_category || 'manual').toUpperCase()}</span>
        <span>${t.uom || 'each'}</span>
      </div>
      <div class="most-tpl-stats">
        <div class="most-tpl-stat">${calc.formatUph(tplUph)}<span>Base UPH</span></div>
        <div class="most-tpl-stat">${tplTmu}<span>TMU</span></div>
        <div class="most-tpl-stat">${calc.formatTmu(tplTmu)}<span>Cycle Time</span></div>
      </div>
    </div>
  `;
}

function renderTemplateDetail() {
  const t = selectedTemplate;
  if (!t) return '';

  const elBreak = calc.elementBreakdown(selectedElements);
  const tplName = getMostTplName(t);
  const tplUph = getMostTplBaseUph(t);
  const tplTmu = getMostTplTmuTotal(t);

  return `
    <div class="most-detail-panel">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
        <div>
          <div style="font-size:18px; font-weight:800; color:var(--ies-navy);">${tplName}</div>
          <div style="font-size:13px; color:var(--ies-gray-500); margin-top:4px;">
            ${t.process_area} · <span class="most-cat-badge most-cat-${t.labor_category}">${(t.labor_category || 'manual').toUpperCase()}</span> · ${t.uom || 'each'}
          </div>
        </div>
        <button class="cm-delete-btn" data-action="close-detail" style="font-size:16px;">✕</button>
      </div>

      ${t.description ? `<div style="font-size:13px; color:var(--ies-gray-600); margin-bottom:16px;">${t.description}</div>` : ''}

      <!-- KPIs -->
      <div class="hub-kpi-bar mb-4">
        <div class="hub-kpi-item"><div class="hub-kpi-label">Base UPH</div><div class="hub-kpi-value">${calc.formatUph(tplUph)}</div></div>
        <div class="hub-kpi-item"><div class="hub-kpi-label">Total TMU</div><div class="hub-kpi-value">${tplTmu}</div></div>
        <div class="hub-kpi-item"><div class="hub-kpi-label">Cycle Time</div><div class="hub-kpi-value">${calc.formatTmu(tplTmu)}</div></div>
        <div class="hub-kpi-item"><div class="hub-kpi-label">Elements</div><div class="hub-kpi-value">${elBreak.total} <span style="font-size:11px; font-weight:400; color:var(--ies-gray-400);">(${elBreak.variable} var)</span></div></div>
      </div>

      <!-- Element Sequence Table -->
      ${selectedElements.length > 0 ? `
        <div style="font-size:13px; font-weight:700; margin-bottom:8px;">Element Sequence</div>
        <table class="cm-grid-table" style="font-size:12px;">
          <thead>
            <tr><th>#</th><th>Description</th><th>MOST Sequence</th><th class="cm-num">TMU</th><th class="cm-num">Time</th><th>Type</th></tr>
          </thead>
          <tbody>
            ${selectedElements.map(el => `
              <tr>
                <td>${getMostElSequence(el)}</td>
                <td>${getMostElName(el) || ''}</td>
                <td style="font-family:monospace; font-size:11px; color:var(--ies-gray-500);">${el.most_sequence || ''}</td>
                <td class="cm-num">${getMostElTmu(el)}</td>
                <td class="cm-num">${calc.formatTmu(getMostElTmu(el))}</td>
                <td>${el.is_variable ? '<span style="color:var(--ies-orange); font-weight:600;">Variable</span>' : 'Fixed'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div style="color:var(--ies-gray-400); font-size:13px;">No elements loaded for this template.</div>'}
    </div>
  `;
}

// ============================================================
// TAB 2: TEMPLATE EDITOR
// ============================================================

function renderEditor() {
  const templates = refData.templates || [];
  const isEditing = editorTemplate !== null;

  if (!isEditing) {
    // MOST-3 — Template list with freshened action buttons + layout.
    // Replaces the dated cm-edit-btn/cm-delete-btn classes with hub-btn
    // variants, adds inline SVG icons, and groups the actions in a
    // bordered action cell so they feel like a unit.
    return `
      <div class="most-editor-toolbar">
        <div>
          <h3 class="most-editor-title">Template Editor</h3>
          <p class="most-editor-subtitle">Create, edit, and manage MOST labor standards templates.</p>
        </div>
        <button class="hub-btn hub-btn-primary hub-btn-icon" data-action="create-template">
          ${ICON.plus} New Template
        </button>
      </div>

      ${templates.length === 0 ? `
        <div class="most-empty-state">
          <div class="most-empty-icon">${ICON.templatesEmpty}</div>
          <div class="most-empty-title">No templates yet</div>
          <div class="most-empty-body">Click <strong>+ New Template</strong> to create your first MOST standard.</div>
        </div>
      ` : `
        <div class="most-table-card">
          <table class="most-table">
            <thead>
              <tr>
                <th>Activity Name</th>
                <th>Process Area</th>
                <th>Category</th>
                <th class="cm-num">Base UPH</th>
                <th class="cm-num">TMU</th>
                <th class="cm-num">Elements</th>
                <th style="width:160px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${templates.map(t => `
                <tr class="most-row-hover">
                  <td style="font-weight:600; color:var(--ies-navy);">${getMostTplName(t)}</td>
                  <td>${t.process_area || '—'}</td>
                  <td><span class="most-cat-badge most-cat-${t.labor_category || 'manual'}" style="font-size:10px;">${(t.labor_category || 'manual').toUpperCase()}</span></td>
                  <td class="cm-num">${calc.formatUph(getMostTplBaseUph(t))}</td>
                  <td class="cm-num">${getMostTplTmuTotal(t)}</td>
                  <td class="cm-num">${t.element_count || 0}</td>
                  <td>
                    <div class="most-row-actions">
                      <button class="most-icon-btn" data-action="edit-template" data-id="${t.id}" title="Edit template">
                        ${ICON.pencil}<span>Edit</span>
                      </button>
                      <button class="most-icon-btn" data-action="duplicate-template" data-id="${t.id}" title="Duplicate">
                        ${ICON.copy}<span>Dup</span>
                      </button>
                      <button class="most-icon-btn most-icon-btn-danger" data-action="delete-template" data-id="${t.id}" title="Delete template">
                        ${ICON.trash}<span>Del</span>
                      </button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    `;
  }

  // Template editor form
  const t = editorTemplate;
  const totalTmu = calc.sumElementTmu(editorElements);
  const baseUph = calc.baseUph(totalTmu);

  return `
    <div class="most-editor-toolbar">
      <div>
        <div class="most-editor-breadcrumb">
          <button class="most-breadcrumb-link" data-action="close-editor" title="Back to template list">${ICON.chevronLeft} Templates</button>
          <span style="color:var(--ies-gray-300);">/</span>
          <span>${t.id ? 'Edit' : 'New'}</span>
        </div>
        <h3 class="most-editor-title">${t.id ? (getMostTplName(t) || 'Edit Template') : 'New Template'}</h3>
        <p class="most-editor-subtitle">${t.id ? 'Modify template details and elements' : 'Create a new MOST labor standards template'}</p>
      </div>
      <div class="most-editor-toolbar-actions">
        <button class="hub-btn hub-btn-secondary" data-action="close-editor">Cancel</button>
        <button class="hub-btn hub-btn-primary hub-btn-icon" data-action="save-template">${ICON.check} Save Template</button>
      </div>
    </div>

    <!-- Template Metadata -->
    <div class="hub-card" style="margin-bottom:20px;">
      <div class="text-subtitle mb-4">Template Details</div>
      <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:16px;">
        <div>
          <label class="cm-form-label">Activity Name *</label>
          <input class="hub-input" id="edit-tpl-name" value="${getMostTplName(t) || ''}" placeholder="e.g., Case Pick" />
        </div>
        <div>
          <label class="cm-form-label">Process Area *</label>
          <select class="hub-select" id="edit-tpl-area">
            <option value="">Select...</option>
            ${PROCESS_AREAS.map(a => `<option value="${a}"${t.process_area === a ? ' selected' : ''}>${a}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="cm-form-label">Labor Category *</label>
          <select class="hub-select" id="edit-tpl-cat">
            ${LABOR_CATEGORIES.map(c => `<option value="${c}"${t.labor_category === c ? ' selected' : ''}>${c.toUpperCase()}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="cm-form-label">UOM</label>
          <input class="hub-input" id="edit-tpl-uom" value="${t.uom || 'each'}" />
        </div>
        <div>
          <label class="cm-form-label">Equipment Type</label>
          <input class="hub-input" id="edit-tpl-equipment" value="${t.equipment_type || ''}" placeholder="e.g., RF Gun, Pick Cart" />
        </div>
        <div>
          <label class="cm-form-label">WMS Transaction</label>
          <input class="hub-input" id="edit-tpl-wms" value="${t.wms_transaction || ''}" placeholder="e.g., PICK, PUTAWAY" />
        </div>
      </div>
      <div style="margin-top:16px;">
        <label class="cm-form-label">Description</label>
        <textarea class="hub-input" id="edit-tpl-desc" placeholder="Describe the operation..." style="height:60px;">${t.description || ''}</textarea>
      </div>

      <!-- Live Metrics -->
      <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-top:16px;">
        <div style="border:1px solid var(--ies-gray-200); border-radius: 10px; padding:12px; text-align:center;">
          <div style="font-size:11px; color:var(--ies-gray-500); font-weight:600;">Base UPH</div>
          <div style="font-size:20px; font-weight:700; color:var(--ies-blue);" id="edit-live-uph">${calc.formatUph(baseUph)}</div>
        </div>
        <div style="border:1px solid var(--ies-gray-200); border-radius: 10px; padding:12px; text-align:center;">
          <div style="font-size:11px; color:var(--ies-gray-500); font-weight:600;">Total TMU</div>
          <div style="font-size:20px; font-weight:700; color:var(--ies-navy);" id="edit-live-tmu">${totalTmu}</div>
        </div>
        <div style="border:1px solid var(--ies-gray-200); border-radius: 10px; padding:12px; text-align:center;">
          <div style="font-size:11px; color:var(--ies-gray-500); font-weight:600;">Cycle Time</div>
          <div style="font-size:18px; font-weight:700; color:var(--ies-navy);" id="edit-live-cycle">${calc.formatTmu(totalTmu)}</div>
        </div>
        <div style="border:1px solid var(--ies-gray-200); border-radius: 10px; padding:12px; text-align:center;">
          <div style="font-size:11px; color:var(--ies-gray-500); font-weight:600;">Elements</div>
          <div style="font-size:20px; font-weight:700; color:var(--ies-navy);" id="edit-live-count">${editorElements.length}</div>
        </div>
      </div>
    </div>

    <!-- Element Sequence Editor -->
    <div class="hub-card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div class="text-subtitle">Element Sequence</div>
        <button class="hub-btn hub-btn-sm hub-btn-secondary hub-btn-icon" data-action="add-element">${ICON.plus} Add Element</button>
      </div>

      ${(() => {
        const issues = calc.validateElementSequence(editorElements);
        if (!issues.length) return '';
        const errors = issues.filter(i => i.severity === 'error');
        const warns = issues.filter(i => i.severity === 'warning');
        return `
          <div style="margin-bottom:12px;padding:10px 12px;border-radius: 10px;
                      background:${errors.length ? '#fee2e2' : '#fef3c7'};
                      border:1px solid ${errors.length ? '#fca5a5' : '#fcd34d'};
                      color:${errors.length ? '#991b1b' : '#92400e'};font-size:12px;">
            <div style="font-weight:700;margin-bottom:4px;">
              ${errors.length ? `⚠ ${errors.length} error${errors.length > 1 ? 's' : ''}` : ''}${errors.length && warns.length ? ' · ' : ''}${warns.length ? `${warns.length} warning${warns.length > 1 ? 's' : ''}` : ''} in sequence
            </div>
            <ul style="margin:0;padding-left:18px;line-height:1.5;">
              ${issues.slice(0, 6).map(iss => `<li>${iss.message}</li>`).join('')}
              ${issues.length > 6 ? `<li style="opacity:0.7;">…and ${issues.length - 6} more</li>` : ''}
            </ul>
          </div>
        `;
      })()}

      ${editorElements.length > 0 ? `
        <table class="cm-grid-table" style="font-size:12px;">
          <thead>
            <tr>
              <th style="width:24px;" title="Drag to reorder"></th>
              <th style="width:40px;">#</th>
              <th>Element Name</th>
              <th style="width:120px;">MOST Sequence</th>
              <th style="width:80px;">Seq Type</th>
              <th style="width:70px;" class="cm-num">TMU</th>
              <th style="width:60px;" class="cm-num" title="Occurrences per work cycle. 1 = every cycle, 0.5 = every other cycle.">Freq/Cyc</th>
              <th style="width:60px;">Variable</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${editorElements.map((el, i) => {
              // When is_variable is true, the element's TMU varies with a
              // workload driver (e.g., walk distance, case weight, SKU count).
              // A "Variable Detail" row expands below the main row so the
              // user can specify min/max bounds + driver description + an
              // optional formula. Collapsed when is_variable is off.
              const isVar = !!el.is_variable;
              return `
              <tr class="most-elem-row${isVar ? ' most-elem-row--variable' : ''}" draggable="true" data-elem-row="${i}">
                <td style="text-align:center;cursor:grab;color:var(--ies-gray-400);user-select:none;font-size:14px;line-height:1;" title="Drag to reorder">⠿</td>
                <td>${i + 1}</td>
                <td><input class="hub-input" type="text" value="${getMostElName(el) || ''}" data-elem-idx="${i}" data-elem-field="element_name" style="width:100%; font-size:11px; padding:4px 6px;" /></td>
                <td>
                  <input class="hub-input" type="text" value="${el.most_sequence || ''}" data-elem-idx="${i}" data-elem-field="most_sequence" style="width:100%; font-size:11px; padding:4px 6px; font-family:monospace;" />
                  ${(() => {
                    // MOS-B1 + MOS-C4: parse the MOST shorthand and surface a
                    // live readout (sum-of-indices x 10 = model TMU). Errors
                    // tint red so the analyst sees malformed atoms instantly.
                    const seq = el.most_sequence || '';
                    if (!seq.trim()) return '';
                    const r = calc.parseMostSequence(seq);
                    if (!r.valid) {
                      return `<div style="font-size:10px;color:#b91c1c;margin-top:2px;font-family:monospace;" title="${(r.errors || []).join(' | ')}">err</div>`;
                    }
                    const warn = (r.warnings || []).length > 0;
                    const color = warn ? '#92400e' : 'var(--ies-gray-500)';
                    const tip = warn ? r.warnings.join(' | ') : `Σ index=${r.indexSum}, model TMU=${r.modelTmu} (sum × 10).`;
                    return `<div style="font-size:10px;color:${color};margin-top:2px;font-family:monospace;" title="${tip}">Σ${r.indexSum} → ${r.modelTmu} TMU${warn ? ' ⚠' : ''}</div>`;
                  })()}
                </td>
                <td>
                  ${(() => {
                    // Case-insensitive match — DB stores uppercase ("GET"/"PUT"/…);
                    // catalog options use lowercase. Normalize before comparing.
                    const seq = (el.sequence_type || '').toString().toLowerCase();
                    const opt = (val, label) => `<option value="${val}"${seq === val ? ' selected' : ''}>${label}</option>`;
                    return `
                      <select data-elem-idx="${i}" data-elem-field="sequence_type" style="width:100%; font-size:11px; padding:4px 6px;">
                        ${opt('get', 'Get')}
                        ${opt('put', 'Put')}
                        ${opt('move', 'Move')}
                        ${opt('walk', 'Walk')}
                        ${opt('verify', 'Verify')}
                        ${opt('allow', 'Allow')}
                        ${opt('general_move', 'General Move (ABG · ABP · A)')}
                        ${opt('controlled_move', 'Controlled (ABG · MXI · A)')}
                        ${opt('tool_use', 'Tool Use (ABG · ABP · ABT · ABP · A)')}
                        ${opt('body_motion', 'Body Motion')}
                      </select>
                    `;
                  })()}
                </td>
                <td><input class="hub-input" type="number" value="${getMostElTmu(el) || 0}" data-elem-idx="${i}" data-elem-field="tmu_value" style="width:100%; font-size:11px; padding:4px 6px;" title="${isVar ? 'TMU at the default factor (midpoint between min/max unless overridden below)' : 'Fixed TMU for this element'}" /></td>
                <td><input class="hub-input" type="number" step="0.01" min="0" value="${el.freq_per_cycle == null ? 1 : el.freq_per_cycle}" data-elem-idx="${i}" data-elem-field="freq_per_cycle" style="width:100%; font-size:11px; padding:4px 6px;" title="Occurrences per cycle (1 = every cycle)" /></td>
                <td style="text-align:center;"><input type="checkbox" ${isVar ? 'checked' : ''} data-elem-idx="${i}" data-elem-field="is_variable" style="cursor:pointer;" title="Mark this element as variable (TMU scales with a workload driver)" /></td>
                <td><button class="most-icon-btn most-icon-btn-danger" data-action="delete-element" data-idx="${i}" title="Remove element">${ICON.trash}</button></td>
              </tr>
              ${isVar ? `
              <tr class="most-elem-variable-detail">
                <td></td>
                <td colspan="8">
                  <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; padding:6px 0 4px 4px; border-left:2px solid var(--ies-orange, #f97316); padding-left:8px;">
                    <div style="flex:0 0 140px;">
                      <label style="display:block;font-size:10px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;">Driver</label>
                      <input class="hub-input" type="text" value="${el.variable_driver || ''}" data-elem-idx="${i}" data-elem-field="variable_driver" placeholder="e.g. walk distance (ft)" style="width:100%;font-size:11px;padding:4px 6px;" />
                    </div>
                    <div style="flex:0 0 80px;">
                      <label style="display:block;font-size:10px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;" title="TMU at driver = low / short / simple">Min TMU</label>
                      <input class="hub-input" type="number" step="0.1" min="0" value="${el.variable_min == null ? '' : el.variable_min}" data-elem-idx="${i}" data-elem-field="variable_min" placeholder="${(getMostElTmu(el) * 0.5).toFixed(1)}" style="width:100%;font-size:11px;padding:4px 6px;" />
                    </div>
                    <div style="flex:0 0 80px;">
                      <label style="display:block;font-size:10px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;" title="TMU at driver = high / long / complex">Max TMU</label>
                      <input class="hub-input" type="number" step="0.1" min="0" value="${el.variable_max == null ? '' : el.variable_max}" data-elem-idx="${i}" data-elem-field="variable_max" placeholder="${(getMostElTmu(el) * 1.5).toFixed(1)}" style="width:100%;font-size:11px;padding:4px 6px;" />
                    </div>
                    <div style="flex:0 0 130px;">
                      <label style="display:block;font-size:10px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;" title="Default interpolation between min (0) and max (1). 0.5 = midpoint.">Default Factor (0-1)</label>
                      <input class="hub-input" type="number" step="0.05" min="0" max="1" value="${el.variable_default_factor == null ? 0.5 : el.variable_default_factor}" data-elem-idx="${i}" data-elem-field="variable_default_factor" style="width:100%;font-size:11px;padding:4px 6px;" />
                    </div>
                    <div style="flex:1 1 220px; min-width:180px;">
                      <label style="display:block;font-size:10px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;" title="Optional reference formula — descriptive only, not evaluated yet">Formula (optional reference)</label>
                      <input class="hub-input" type="text" value="${el.variable_formula || ''}" data-elem-idx="${i}" data-elem-field="variable_formula" placeholder="e.g. 3 TMU + 0.5 × distance_ft" style="width:100%;font-size:11px;padding:4px 6px;" />
                    </div>
                  </div>
                </td>
              </tr>
              ` : ''}
            `;}).join('')}
          </tbody>
        </table>
      ` : `
        <div style="text-align:center; padding:20px; color:var(--ies-gray-400); border:1px dashed var(--ies-gray-200); border-radius: 10px;">
          No elements yet. Click "+ Add Element" to start.
        </div>
      `}
    </div>

    <!-- Save/Cancel Buttons: anchored at the bottom of the editor too, for long scrolls -->
    <div class="most-editor-footer">
      <button class="hub-btn hub-btn-secondary" data-action="close-editor">Cancel</button>
      <button class="hub-btn hub-btn-primary hub-btn-icon" data-action="save-template">${ICON.check} Save Template</button>
    </div>
  `;
}

// ============================================================
// TAB 3: QUICK LABOR ANALYSIS
// ============================================================

function renderAnalysis() {
  const lines = analysis.lines || [];
  const pfd = analysis.pfd_pct || 14;
  // Productivity factor: % of engineered standard the operation actually
  // runs at. Default 90% (planning convention) when the analysis hasn't set
  // one explicitly. 100% = pure engineered, unachievable in practice.
  const productivity = analysis.productivity_pct == null ? 90 : analysis.productivity_pct;

  // Compute derived fields for display
  const computedLines = lines.map(line => {
    const effRate = calc.resolveCategoryRate(
      analysis.rates_by_category, line.labor_category, analysis.hourly_rate, line.hourly_rate);
    // MOS-B5: learning-curve adjusts adjusted UPH after PFD/productivity.
    const lc = analysis.learning_curve_pct == null ? 100 : analysis.learning_curve_pct;
    const baseDerived = calc.computeAnalysisLine({
      base_uph: line.base_uph,
      pfd_pct: pfd,
      productivity_pct: productivity,
      daily_volume: line.daily_volume,
      shift_hours: analysis.shift_hours,
      hourly_rate: effRate,
    });
    const lcUph = calc.applyLearningCurve(baseDerived.adjusted_uph, lc);
    const lcHours = lcUph > 0 ? (line.daily_volume || 0) / lcUph : 0;
    const lcFte = (analysis.shift_hours || 8) > 0 ? lcHours / (analysis.shift_hours || 8) : 0;
    const lcCost = lcHours * effRate;
    const derived = {
      adjusted_uph: lcUph,
      hours_per_day: lcHours,
      fte: lcFte,
      headcount: Math.ceil(lcFte),
      daily_cost: lcCost,
    };
    return { ...line, ...derived };
  });

  const summary = calc.computeAnalysisSummary(computedLines, analysis.operating_days);
  const allowProfiles = refData.allowanceProfiles || [];
  const tplsByArea = groupByProcessArea(refData.templates || []);

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <div>
        <div style="font-size:16px; font-weight:700; color:var(--ies-navy);">Quick Labor Analysis</div>
        <div style="font-size:13px; color:var(--ies-gray-500);">Add activities from template library or enter manual standards.</div>
      </div>
      <button class="hub-btn hub-btn-primary" data-action="push-to-cm"${computedLines.length === 0 ? ' disabled style="opacity:0.5;cursor:not-allowed;" title="Add at least one activity line before pushing to Cost Model"' : ''}>Push to Cost Model →</button>
    </div>

    ${lines.length === 0 ? `
      <div class="hub-card" style="padding:24px;text-align:center;background:var(--ies-gray-50);border:1px dashed var(--ies-gray-300);margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;color:var(--ies-navy);margin-bottom:8px;">No activities in this analysis yet</div>
        <div style="font-size:12px;color:var(--ies-gray-500);line-height:1.5;max-width:520px;margin:0 auto;">
          Pick a template from the library, or add a manual line below. For each activity set the daily volume — the analyzer derives FTEs needed, labor cost, and per-unit rate using PFD + Productivity from the panel above.
        </div>
      </div>
    ` : ''}

    <!-- Analysis Parameters -->
    <div style="display:grid; grid-template-columns: repeat(6, 1fr); gap:12px; margin-bottom:14px;">
      <div>
        <div style="display:flex;align-items:center;gap:6px;justify-content:space-between;">
          <label class="cm-form-label" style="margin:0;">PFD Allowance</label>
          <button type="button" class="hub-btn hub-btn-sm hub-btn-secondary" data-action="manage-allowance-profiles" title="Create / edit / delete allowance profiles" style="font-size:10px;padding:2px 8px;line-height:1.3;">Manage…</button>
        </div>
        <select class="hub-select" id="most-pfd-select">
          <option value="">Custom</option>
          ${allowProfiles.map(p => `<option value="${p.id}" data-pfd="${calc.totalPfd(p)}"${analysis.allowance_profile_id === p.id ? ' selected' : ''}>${p.profile_name || p.name || 'Profile #' + p.id} (${calc.totalPfd(p)}%)</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="cm-form-label" title="Personal + Fatigue + Delay allowance. By convention IES applies PFD on UPH (adjUPH = baseUPH x 100/(100+PFD%)). Mathematically equivalent to PFD on TMU since hours scale linearly.">PFD %</label>
        <input class="hub-input" type="number" value="${pfd}" step="1" id="most-pfd-input" data-param="pfd_pct" />
      </div>
      <div>
        <label class="cm-form-label" title="Productivity factor (% to standard). 100% = engineered MOST (unattainable in practice). Typical trained operations: 85–95%. Applied AFTER PFD.">Productivity %</label>
        <input class="hub-input" type="number" value="${productivity}" step="1" min="1" max="150" data-param="productivity_pct" title="Typical 85–95% for trained operations" />
      </div>
      <div>
        <label class="cm-form-label">Shift Hours</label>
        <input class="hub-input" type="number" value="${analysis.shift_hours}" step="0.5" data-param="shift_hours" />
      </div>
      <div>
        <label class="cm-form-label">Operating Days/Yr</label>
        <input class="hub-input" type="number" value="${analysis.operating_days}" step="1" data-param="operating_days" />
      </div>
      <div>
        <label class="cm-form-label" title="Fallback hourly rate when category rates and per-line rate are blank.">Default $/Hr</label>
        <input class="hub-input" type="number" value="${analysis.hourly_rate}" step="0.5" data-param="hourly_rate" />
      </div>
    </div>

    <!-- MOS-E3: per-category labor rates + MOS-B5: learning curve -->
    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-bottom:20px;padding:10px 12px;background:var(--ies-gray-50);border:1px solid var(--ies-gray-200);border-radius:10px;">
      <div>
        <label class="cm-form-label" title="Manual labor rate. Lines tagged MANUAL inherit this when no per-line rate is set.">$/Hr — Manual</label>
        <input class="hub-input" type="number" value="${(analysis.rates_by_category && analysis.rates_by_category.manual) || 0}" step="0.5" data-rate-cat="manual" />
      </div>
      <div>
        <label class="cm-form-label" title="MHE (powered equipment) labor rate -- typically higher than manual due to certification + premium.">$/Hr — MHE</label>
        <input class="hub-input" type="number" value="${(analysis.rates_by_category && analysis.rates_by_category.mhe) || 0}" step="0.5" data-rate-cat="mhe" />
      </div>
      <div>
        <label class="cm-form-label" title="Hybrid (mixed manual + MHE) labor rate.">$/Hr — Hybrid</label>
        <input class="hub-input" type="number" value="${(analysis.rates_by_category && analysis.rates_by_category.hybrid) || 0}" step="0.5" data-rate-cat="hybrid" />
      </div>
      <div>
        <label class="cm-form-label" title="Learning curve productivity index. 100 = mature operator at engineered standard, 50 = new operator at half throughput. Multiplies adjusted UPH.">Learning Curve %</label>
        <input class="hub-input" type="number" value="${analysis.learning_curve_pct == null ? 100 : analysis.learning_curve_pct}" min="10" max="120" step="5" data-param="learning_curve_pct" />
      </div>
    </div>

    <!-- Activity Lines Table -->
    <table class="cm-grid-table">
      <thead>
        <tr>
          <th>Activity / Template</th>
          <th>Area</th>
          <th>Category</th>
          <th class="cm-num">Base UPH</th>
          <th class="cm-num">Adj UPH</th>
          <th class="cm-num" title="Check when this line is driven by a variable element (e.g. travel time scales with distance). Surfaces Driver + Formula fields for documentation.">Var?</th>
          <th title="What drives this line's variable portion — e.g. 'pallets/order', 'units/case', 'distance_ft'. Free-form; for reference + export.">Driver</th>
          <th title="Reference formula for the variable TMU — e.g. '3 TMU + 0.5 × distance_ft'. Descriptive only, not evaluated.">Formula</th>
          <th class="cm-num">Daily Vol</th>
          <th class="cm-num">Hrs/Day</th>
          <th class="cm-num">FTE</th>
          <th class="cm-num">HC</th>
          <th class="cm-num">$/Hr</th>
          <th class="cm-num">Daily Cost</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${computedLines.map((line, i) => `
          <tr${line.is_variable ? ' class="most-row-variable"' : ''}>
            <td>
              <select style="width:160px;" data-action="set-template-line" data-idx="${i}">
                <option value="">— Manual —</option>
                ${Object.entries(tplsByArea).map(([area, tpls]) =>
                  `<optgroup label="${area}">
                    ${tpls.map(t => `<option value="${t.id}"${line.template_id === t.id ? ' selected' : ''}>${getMostTplName(t)}</option>`).join('')}
                  </optgroup>`
                ).join('')}
              </select>
            </td>
            <td style="font-size:12px;">${line.process_area || '—'}</td>
            <td><span class="most-cat-badge most-cat-${line.labor_category || 'manual'}">${(line.labor_category || 'manual').toUpperCase()}</span></td>
            <td><input type="number" value="${line.base_uph || 0}" style="width:60px;" data-line="${i}" data-field="base_uph" data-type="number" /></td>
            <td class="cm-num">${calc.formatUph(line.adjusted_uph)}</td>
            <td style="text-align:center;"><input type="checkbox" data-line="${i}" data-field="is_variable" data-type="checkbox"${line.is_variable ? ' checked' : ''} title="Variable element — driver scales TMU per cycle" /></td>
            <td><input type="text" value="${(line.variable_driver || '').replace(/"/g, '&quot;')}" style="width:100px;font-size:12px;" data-line="${i}" data-field="variable_driver" data-type="text" placeholder="${line.is_variable ? 'e.g. pallets/order' : '—'}"${!line.is_variable ? ' disabled' : ''} /></td>
            <td><input type="text" value="${(line.variable_formula || '').replace(/"/g, '&quot;')}" style="width:140px;font-size:12px;" data-line="${i}" data-field="variable_formula" data-type="text" placeholder="${line.is_variable ? 'e.g. 3 + 0.5 × dist' : '—'}"${!line.is_variable ? ' disabled' : ''} /></td>
            <td><input type="number" value="${line.daily_volume || 0}" style="width:70px;" data-line="${i}" data-field="daily_volume" data-type="number" /></td>
            <td class="cm-num">${line.hours_per_day.toFixed(1)}</td>
            <td class="cm-num">${calc.formatFte(line.fte)}</td>
            <td class="cm-num" style="font-weight:700;">${line.headcount}</td>
            <td><input type="number" value="${line.hourly_rate || (analysis.rates_by_category && analysis.rates_by_category[line.labor_category || 'manual']) || analysis.hourly_rate || 0}" style="width:55px;" step="0.5" data-line="${i}" data-field="hourly_rate" data-type="number" title="Per-line override. Blank/0 falls back to ${(line.labor_category||'manual').toUpperCase()} category rate." /></td>
            <td class="cm-num">${formatDollar(line.daily_cost)}</td>
            <td><button class="cm-delete-btn" data-action="delete-analysis-line" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-analysis-line">+ Add Activity Line</button>

    <!-- Summary -->
    ${computedLines.length > 0 ? renderAnalysisSummary(summary) : ''}
  `;
}

function renderAnalysisSummary(summary) {
  const cats = summary.ftesByCategory;
  const totalFte = summary.totalFtes || 1;
  const annualCost = calc.calcAnnualizedCost(summary.dailyCost, summary.operatingDays);

  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 24px;">
      <div class="hub-card">
        <div class="text-subtitle mb-4">Labor Summary</div>
        <div class="hub-kpi-bar">
          <div class="hub-kpi-item"><div class="hub-kpi-label">Total FTEs</div><div class="hub-kpi-value">${calc.formatFte(summary.totalFtes)}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Headcount</div><div class="hub-kpi-value">${summary.totalHeadcount}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Hrs/Day</div><div class="hub-kpi-value">${summary.totalHoursPerDay.toFixed(1)}</div></div>
        </div>
      </div>

      <div class="hub-card">
        <div class="text-subtitle mb-4">Daily Cost</div>
        <div style="font-size:32px; font-weight:700; color:var(--ies-blue); margin-bottom:8px;">${formatDollar(summary.dailyCost)}</div>
        <div style="font-size:12px; color:var(--ies-gray-500);">per day</div>
      </div>

      <div class="hub-card">
        <div class="text-subtitle mb-4">Annual Cost</div>
        <div style="font-size:32px; font-weight:700; color:var(--ies-green); margin-bottom:8px;">${formatDollar(annualCost)}</div>
        <div style="font-size:12px; color:var(--ies-gray-500);">@ ${summary.operatingDays} days/yr</div>
      </div>
    </div>

    <div class="hub-card" style="margin-top:16px;">
      <div class="text-subtitle mb-4">FTEs by Category</div>
      <div style="display:flex; height:24px; border-radius:4px; overflow:hidden; margin-bottom:12px;">
        ${cats.manual > 0 ? `<div style="width:${(cats.manual / totalFte * 100).toFixed(0)}%; background:var(--ies-blue);" title="Manual"></div>` : ''}
        ${cats.mhe > 0 ? `<div style="width:${(cats.mhe / totalFte * 100).toFixed(0)}%; background:var(--ies-teal);" title="MHE"></div>` : ''}
        ${cats.hybrid > 0 ? `<div style="width:${(cats.hybrid / totalFte * 100).toFixed(0)}%; background:#ff9500;" title="Hybrid"></div>` : ''}
      </div>
      <div style="display:flex; gap:24px;">
        <div><span class="most-cat-badge most-cat-manual">MANUAL</span> <span style="font-weight:700; margin-left:4px;">${calc.formatFte(cats.manual)}</span></div>
        <div><span class="most-cat-badge most-cat-mhe">MHE</span> <span style="font-weight:700; margin-left:4px;">${calc.formatFte(cats.mhe)}</span></div>
        <div><span class="most-cat-badge most-cat-hybrid">HYBRID</span> <span style="font-weight:700; margin-left:4px;">${calc.formatFte(cats.hybrid)}</span></div>
      </div>
    </div>

    <!-- Saved Scenarios -->
    ${renderSavedScenarios()}
  `;
}

function renderSavedScenarios() {
  return `
    <div style="margin-top:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div class="text-subtitle">Saved Scenarios</div>
        <button class="cm-add-row-btn" data-action="save-scenario" style="font-size:12px; padding:6px 12px;">+ Save Current</button>
        <button class="cm-add-row-btn" data-action="most-export-xlsx" style="font-size:12px; padding:6px 12px; margin-left:8px;" title="Export current Quick Analysis to Excel (.xlsx)">⬇ Export Excel</button>
      </div>
      <div id="most-scenarios-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:12px;">
        ${savedScenarios.map((scenario, idx) => `
          <div class="hub-card" style="padding:12px; background:var(--ies-gray-50);">
            <div style="font-size:13px; font-weight:700; color:var(--ies-navy); margin-bottom:4px;">${scenario.name}</div>
            <div style="font-size:11px; color:var(--ies-gray-500); margin-bottom:8px;">${scenario.timestamp}</div>
            <div style="font-size:11px; color:var(--ies-gray-600); margin-bottom:8px;">
              ${scenario.lines} line${scenario.lines !== 1 ? 's' : ''} · ${scenario.pfd}% PFD
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; font-size:11px; margin-bottom:8px;">
              <div><span style="color:var(--ies-gray-500);">FTE:</span> <strong>${scenario.ftes.toFixed(1)}</strong></div>
              <div><span style="color:var(--ies-gray-500);">HC:</span> <strong>${scenario.headcount}</strong></div>
            </div>
            <div style="display:flex; gap:4px;">
              <button class="cm-edit-btn" data-action="load-scenario" data-idx="${idx}" style="flex:1; font-size:11px; padding:4px 6px;">Load</button>
              <button class="cm-edit-btn" data-action="copy-scenario" data-idx="${idx}" title="Duplicate this scenario" style="font-size:11px; padding:4px 6px;">Copy</button>
              <button class="cm-delete-btn" data-action="delete-scenario" data-idx="${idx}" style="font-size:11px; padding:4px 6px;">Del</button>
            </div>
          </div>
        `).join('')}
      </div>
      ${savedScenarios.length === 0 ? '<div style="text-align:center; padding:20px; color:var(--ies-gray-400); border:1px dashed var(--ies-gray-200); border-radius: 10px; margin-top:8px;">No saved scenarios. Click "+ Save Current" to save your analysis.</div>' : ''}
    </div>
  `;
}

// ============================================================
// TAB 3: WORKFLOW COMPOSER
// ============================================================

function renderWorkflowComposer() {
  const steps = workflow.steps || [];
  const pfd = workflow.pfd_pct || 14;
  const productivity = workflow.productivity_pct == null ? 100 : workflow.productivity_pct;

  // Compute derived fields
  const computedSteps = steps.map(step => {
    const derived = calc.computeWorkflowStep({
      base_uph: step.base_uph,
      pfd_pct: pfd,
      productivity_pct: productivity,
      target_volume: workflow.target_volume_per_day,
      volume_ratio: step.volume_ratio ?? 1,
      shift_hours: workflow.shift_hours,
    });
    return { ...step, ...derived };
  });

  const wfResult = calc.analyzeWorkflow(computedSteps);
  const tplsByArea = groupByProcessArea(refData.templates || []);

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <div>
        <div style="font-size:16px; font-weight:700; color:var(--ies-navy);">Workflow Composer</div>
        <div style="font-size:13px; color:var(--ies-gray-500);">Chain templates into an end-to-end warehouse workflow to identify bottlenecks.</div>
      </div>
    </div>

    <!-- Workflow Parameters -->
    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-bottom:20px;">
      <div>
        <label class="cm-form-label">Workflow Name</label>
        <input class="hub-input" value="${workflow.name}" id="wf-name" data-wf="name" />
      </div>
      <div>
        <label class="cm-form-label">Target Volume/Day</label>
        <input class="hub-input" type="number" value="${workflow.target_volume_per_day}" data-wf="target_volume_per_day" />
      </div>
      <div>
        <label class="cm-form-label">Shift Hours</label>
        <input class="hub-input" type="number" value="${workflow.shift_hours}" step="0.5" data-wf="shift_hours" />
      </div>
      <div>
        <label class="cm-form-label">PFD %</label>
        <input class="hub-input" type="number" value="${pfd}" step="1" data-wf="pfd_pct" />
      </div>
    </div>

    <!-- Pipeline Steps -->
    <div id="most-wf-steps">
      ${computedSteps.map((step, i) => {
        const isBottleneck = step.adjusted_uph > 0 && step.adjusted_uph === wfResult.bottleneckUph;
        return `
          ${i > 0 ? '<div class="most-workflow-arrow">↓</div>' : ''}
          <div class="most-workflow-step${isBottleneck ? ' bottleneck' : ''}">
            <div style="flex:1;">
              <select style="width:180px;" data-action="set-wf-template" data-idx="${i}">
                <option value="">— Select Template —</option>
                ${Object.entries(tplsByArea).map(([area, tpls]) =>
                  `<optgroup label="${area}">
                    ${tpls.map(t => `<option value="${t.id}"${step.template_id === t.id ? ' selected' : ''}>${getMostTplName(t)}</option>`).join('')}
                  </optgroup>`
                ).join('')}
              </select>
              <div style="font-size:12px; color:var(--ies-gray-400); margin-top:4px;">${step.process_area || ''} · <span class="most-cat-badge most-cat-${step.labor_category || 'manual'}" style="font-size:10px;">${(step.labor_category || '').toUpperCase()}</span></div>
            </div>
            <div style="text-align:center; min-width:60px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">Vol Ratio</div>
              <input type="number" value="${step.volume_ratio ?? 1}" style="width:55px; text-align:center;" step="0.1" min="0" max="1" data-wf-step="${i}" data-field="volume_ratio" />
            </div>
            <div style="text-align:center; min-width:60px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">Adj UPH</div>
              <div style="font-size:16px; font-weight:700;${isBottleneck ? ' color:var(--ies-red);' : ''}">${calc.formatUph(step.adjusted_uph)}</div>
            </div>
            <div style="text-align:center; min-width:50px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">FTE</div>
              <div style="font-size:16px; font-weight:700;">${calc.formatFte(step.fte)}</div>
            </div>
            <div style="text-align:center; min-width:50px;">
              <div style="font-size:11px; color:var(--ies-gray-500);">Hrs/Day</div>
              <div style="font-size:14px; font-weight:600;">${step.hours_per_day.toFixed(1)}</div>
            </div>
            <button class="cm-delete-btn" data-action="delete-wf-step" data-idx="${i}">✕</button>
          </div>
        `;
      }).join('')}
    </div>
    <button class="cm-add-row-btn" data-action="add-wf-step" style="margin-top:12px;">+ Add Step</button>

    <!-- Workflow Summary -->
    ${computedSteps.length > 0 ? renderWorkflowSummary(wfResult, computedSteps) : ''}
  `;
}

function renderWorkflowSummary(result, steps) {
  const cats = result.ftesByCategory;
  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px;">
      <div class="hub-card">
        <div class="text-subtitle mb-4">Workflow Results</div>
        <div class="hub-kpi-bar">
          <div class="hub-kpi-item"><div class="hub-kpi-label">Total FTEs</div><div class="hub-kpi-value">${calc.formatFte(result.totalFtes)}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Total Hrs/Day</div><div class="hub-kpi-value">${result.totalHoursPerDay.toFixed(1)}</div></div>
          <div class="hub-kpi-item"><div class="hub-kpi-label">Steps</div><div class="hub-kpi-value">${steps.length}</div></div>
        </div>
      </div>
      <div class="hub-card" style="${result.bottleneckStep ? 'border-left:3px solid var(--ies-red);' : ''}">
        <div class="text-subtitle mb-4">Bottleneck</div>
        ${result.bottleneckStep ? `
          <div style="font-size:16px; font-weight:700; color:var(--ies-red); margin-bottom:4px;">${result.bottleneckStep}</div>
          <div style="font-size:13px; color:var(--ies-gray-500);">Lowest throughput: ${calc.formatUph(result.bottleneckUph)} UPH</div>
        ` : `<div style="color:var(--ies-gray-400);">Add steps to identify bottleneck</div>`}
      </div>
    </div>

    <!-- Throughput Bar Chart (CSS-only) -->
    ${steps.length > 1 ? `
      <div class="hub-card mt-4">
        <div class="text-subtitle mb-4">Throughput Comparison (UPH)</div>
        ${steps.map(s => {
          const maxUph = Math.max(...steps.map(st => st.adjusted_uph || 0));
          const pct = maxUph > 0 ? ((s.adjusted_uph || 0) / maxUph * 100) : 0;
          const isBottle = s.adjusted_uph > 0 && s.adjusted_uph === result.bottleneckUph;
          return `
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
              <div style="width:120px; font-size:12px; font-weight:600; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${s.step_name || 'Unnamed'}</div>
              <div style="flex:1; background:var(--ies-gray-100); border-radius:4px; height:24px; overflow:hidden;">
                <div style="height:100%; width:${pct}%; background:${isBottle ? 'var(--ies-red)' : 'var(--ies-blue)'}; border-radius:4px; transition:width 0.3s;"></div>
              </div>
              <div style="width:60px; font-size:13px; font-weight:700;${isBottle ? ' color:var(--ies-red);' : ''}">${calc.formatUph(s.adjusted_uph)}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}
  `;
}

// ============================================================
// EVENT BINDING
// ============================================================

function bindContentEvents(container) {
  // Filter inputs (library)
  container.querySelector('#most-search')?.addEventListener('input', e => {
    filters.search = /** @type {HTMLInputElement} */ (e.target).value;
    renderContent();
  });
  container.querySelector('#most-filter-area')?.addEventListener('change', e => {
    filters.processArea = /** @type {HTMLSelectElement} */ (e.target).value;
    renderContent();
  });
  container.querySelector('#most-filter-cat')?.addEventListener('change', e => {
    filters.laborCategory = /** @type {HTMLSelectElement} */ (e.target).value;
    renderContent();
  });

  // MOST-1 — Template tile clicks. Per-element handler provides belt-and-braces
  // coverage alongside the root-level delegation in mount(). The root-level
  // handler survives tab-change innerHTML swaps; the per-element handler is
  // the fast path for the initial render.
  container.querySelectorAll('.most-tpl-card[data-action="select-template"]').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      if (id) openTemplateInEditor(id);
    });
  });

  // Close detail
  container.querySelector('[data-action="close-detail"]')?.addEventListener('click', () => {
    selectedTemplate = null;
    selectedElements = [];
    renderContent();
  });

  // PFD profile select
  container.querySelector('#most-pfd-select')?.addEventListener('change', e => {
    const sel = /** @type {HTMLSelectElement} */ (e.target);
    const opt = sel.options[sel.selectedIndex];
    if (opt.dataset.pfd) {
      analysis.pfd_pct = parseFloat(opt.dataset.pfd);
      analysis.allowance_profile_id = sel.value;
      renderContent();
    }
  });

  // Analysis parameter inputs
  container.querySelectorAll('[data-param]').forEach(input => {
    input.addEventListener('change', e => {
      const tgt = /** @type {HTMLInputElement} */ (e.target);
      const param = tgt.dataset.param;
      analysis[param] = parseFloat(tgt.value) || 0;
      // MOS-D3: typing a custom PFD% disconnects the line from the saved
      // allowance profile so the PFD dropdown reverts to "Custom" — keeps
      // the two controls coherent.
      if (param === 'pfd_pct') analysis.allowance_profile_id = null;
      rerenderPreservingFocus();
    });
  });

  // MOS-E3: per-category rate inputs
  container.querySelectorAll('[data-rate-cat]').forEach(input => {
    input.addEventListener('change', e => {
      const tgt = /** @type {HTMLInputElement} */ (e.target);
      const cat = tgt.dataset.rateCat;
      if (!analysis.rates_by_category) analysis.rates_by_category = { manual: 0, mhe: 0, hybrid: 0 };
      analysis.rates_by_category[cat] = parseFloat(tgt.value) || 0;
      rerenderPreservingFocus();
    });
  });

  // Analysis line field inputs (type-aware: checkbox / text / number)
  container.querySelectorAll('[data-line]').forEach(input => {
    input.addEventListener('change', e => {
      const tgt = /** @type {HTMLInputElement} */ (e.target);
      const idx = parseInt(tgt.dataset.line);
      const field = tgt.dataset.field;
      const type = tgt.dataset.type || 'number';
      if (analysis.lines[idx]) {
        let value;
        if (type === 'checkbox') value = tgt.checked;
        else if (type === 'text') value = tgt.value;
        else value = parseFloat(tgt.value) || 0;
        analysis.lines[idx][field] = value;
        rerenderPreservingFocus();
      }
    });
  });

  // Template dropdown in analysis lines — pre-populate Variable/Driver/Formula
  // from the template's element list when picking a template. A template
  // with ANY is_variable element marks the analysis line as variable and
  // seeds driver/formula from the first variable element.
  container.querySelectorAll('[data-action="set-template-line"]').forEach(select => {
    select.addEventListener('change', e => {
      const idx = parseInt(/** @type {HTMLSelectElement} */ (e.target).dataset.idx);
      const tplId = /** @type {HTMLSelectElement} */ (e.target).value;
      const tpl = (refData.templates || []).find(t => t.id === tplId);
      if (tpl && analysis.lines[idx]) {
        analysis.lines[idx].template_id = tpl.id;
        analysis.lines[idx].activity_name = getMostTplName(tpl);
        analysis.lines[idx].process_area = tpl.process_area;
        analysis.lines[idx].labor_category = tpl.labor_category || 'manual';
        analysis.lines[idx].base_uph = getMostTplBaseUph(tpl);
        analysis.lines[idx].uom = tpl.uom || 'each';
        // Q3: seed Variable/Driver/Formula from template
        const elements = tpl.elements || tpl.element_list || [];
        const firstVar = elements.find(el => el && el.is_variable);
        if (firstVar) {
          analysis.lines[idx].is_variable = true;
          analysis.lines[idx].variable_driver = firstVar.variable_driver || '';
          analysis.lines[idx].variable_formula = firstVar.variable_formula || '';
        } else {
          analysis.lines[idx].is_variable = false;
          analysis.lines[idx].variable_driver = '';
          analysis.lines[idx].variable_formula = '';
        }
      }
      renderContent();
    });
  });

  // Template-specific actions (edit, duplicate, delete)
  container.querySelectorAll('[data-action="edit-template"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        editorTemplate = await api.getTemplate(id) || null;
        editorElements = editorTemplate ? await api.listElements(id) : [];
      } catch (err) {
        console.warn('[MOST] Failed to load template:', err);
      }
      renderContent();
    });
  });

  container.querySelectorAll('[data-action="duplicate-template"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        const dup = await api.duplicateTemplate(id);
        refData.templates = await api.listTemplates();
        bus.emit('most:template-saved', { id: dup.id });
      } catch (err) {
        console.error('[MOST] Duplicate template failed:', err);
      }
      renderContent();
    });
  });

  container.querySelectorAll('[data-action="delete-template"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Delete this template? This cannot be undone.')) return;
      try {
        await api.deleteTemplate(id);
        refData.templates = await api.listTemplates();
      } catch (err) {
        console.error('[MOST] Delete template failed:', err);
      }
      renderContent();
    });
  });

  // Action buttons
  container.querySelectorAll('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    if (action === 'select-template' || action === 'close-detail' || action === 'set-template-line' ||
        action === 'edit-template' || action === 'duplicate-template' || action === 'delete-template') return;

    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      handleAction(action, idx);
    });
  });

  // Workflow param inputs
  container.querySelectorAll('[data-wf]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.wf;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      workflow[field] = val;
      renderContent();
    });
  });

  // Workflow step field inputs
  container.querySelectorAll('[data-wf-step]').forEach(input => {
    input.addEventListener('change', e => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset['wfStep']);
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.field;
      if (workflow.steps[idx]) {
        workflow.steps[idx][field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
        renderContent();
      }
    });
  });

  // Workflow template dropdown
  container.querySelectorAll('[data-action="set-wf-template"]').forEach(select => {
    select.addEventListener('change', e => {
      const idx = parseInt(/** @type {HTMLSelectElement} */ (e.target).dataset.idx);
      const tplId = /** @type {HTMLSelectElement} */ (e.target).value;
      const tpl = (refData.templates || []).find(t => t.id === tplId);
      if (tpl && workflow.steps[idx]) {
        workflow.steps[idx].template_id = tpl.id;
        workflow.steps[idx].step_name = getMostTplName(tpl);
        workflow.steps[idx].process_area = tpl.process_area;
        workflow.steps[idx].labor_category = tpl.labor_category || 'manual';
        workflow.steps[idx].base_uph = getMostTplBaseUph(tpl);
      }
      renderContent();
    });
  });

  // Template editor inputs — use input+change with debounce for updateEditorMetrics (F1 P1)
  let editorMetricsTimeout = null;
  const debouncedUpdateEditorMetrics = () => {
    clearTimeout(editorMetricsTimeout);
    editorMetricsTimeout = setTimeout(() => updateEditorMetrics(), 300);
  };

  // Numeric element fields — parse as float (empty string → null so the
  // pattern "no override" round-trips through the DB). Boolean fields get
  // the checked flag. Everything else is raw text.
  const NUMERIC_FIELDS = new Set([
    'tmu_value', 'freq_per_cycle',
    'variable_min', 'variable_max', 'variable_default_factor',
  ]);
  container.querySelectorAll('[data-elem-field]').forEach(input => {
    const handleUpdate = (e) => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset.elemIdx);
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.elemField;
      if (editorElements[idx]) {
        if (field === 'is_variable') {
          editorElements[idx][field] = /** @type {HTMLInputElement} */ (e.target).checked;
          // Flipping the variable checkbox expands/collapses the detail
          // row — need a full re-render. Preserves input state for
          // everything else because editorElements is the source of truth.
          renderContent();
          return;
        } else if (NUMERIC_FIELDS.has(field)) {
          const raw = /** @type {HTMLInputElement} */ (e.target).value;
          editorElements[idx][field] = raw === '' ? null : (parseFloat(raw) || 0);
        } else {
          editorElements[idx][field] = /** @type {HTMLInputElement} */ (e.target).value;
        }
        debouncedUpdateEditorMetrics();
      }
    };
    input.addEventListener('input', handleUpdate);
    input.addEventListener('change', handleUpdate);
  });

  // MOS-F2: Drag-reorder for editor element rows.
  // We attach a single delegated set of handlers on the table body so we
  // don't have to re-wire on every render. The actual reorder happens by
  // mutating editorElements + re-rendering (focus is preserved by the
  // surgical updateEditorMetrics path; for ordering the full re-render is
  // OK because the user's hand is on the mouse, not in a text field).
  let dragSourceIdx = null;
  container.querySelectorAll('[data-elem-row]').forEach(tr => {
    tr.addEventListener('dragstart', (e) => {
      const idx = Number((e.currentTarget instanceof HTMLElement) ? e.currentTarget.getAttribute('data-elem-row') : NaN);
      if (!Number.isFinite(idx)) return;
      dragSourceIdx = idx;
      const ev = /** @type {DragEvent} */ (e);
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
      }
      tr.classList?.add('most-elem-row--dragging');
    });
    tr.addEventListener('dragend', () => {
      tr.classList?.remove('most-elem-row--dragging');
      container.querySelectorAll('.most-elem-row--drop-target').forEach(n => n.classList.remove('most-elem-row--drop-target'));
      dragSourceIdx = null;
    });
    tr.addEventListener('dragover', (e) => {
      // Allow drop
      e.preventDefault();
      const ev = /** @type {DragEvent} */ (e);
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      tr.classList?.add('most-elem-row--drop-target');
    });
    tr.addEventListener('dragleave', () => tr.classList?.remove('most-elem-row--drop-target'));
    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      tr.classList?.remove('most-elem-row--drop-target');
      const targetIdx = Number((e.currentTarget instanceof HTMLElement) ? e.currentTarget.getAttribute('data-elem-row') : NaN);
      const sourceIdx = dragSourceIdx;
      dragSourceIdx = null;
      if (!Number.isFinite(targetIdx) || sourceIdx == null || sourceIdx === targetIdx) return;
      if (sourceIdx < 0 || sourceIdx >= editorElements.length) return;
      const [moved] = editorElements.splice(sourceIdx, 1);
      editorElements.splice(targetIdx, 0, moved);
      // Re-stamp sequence_order so save preserves it
      editorElements.forEach((el, i) => { el.sequence_order = i + 1; });
      renderContent();
    });
  });

  // Scenario load/delete buttons
  container.querySelectorAll('[data-action="load-scenario"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      loadScenario(idx);
    });
  });
  container.querySelectorAll('[data-action="delete-scenario"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      deleteScenario(idx);
    });
  });
  container.querySelectorAll('[data-action="copy-scenario"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      copyScenario(idx);
    });
  });
}

// ============================================================
// ACTIONS
// ============================================================

function handleAction(action, idx) {
  switch (action) {
    // Template Editor
    case 'create-template':
      editorTemplate = { id: null, activity_name: '', process_area: '', labor_category: 'manual', uom: 'each', description: '' };
      editorElements = [];
      break;
    case 'close-editor':
      editorTemplate = null;
      editorElements = [];
      break;
    case 'add-element':
      editorElements.push(createEmptyElement());
      updateEditorMetrics();
      break;
    case 'delete-element':
      editorElements.splice(idx, 1);
      updateEditorMetrics();
      break;
    case 'save-template':
      saveTemplateAction();
      return;

    // Quick Analysis
    case 'save-scenario':
      saveCurrentScenario();
      return;
    case 'copy-scenario':
      copyScenario(idx);
      return;
    case 'most-export-xlsx':
      exportAnalysisToXlsx();
      return;
    case 'add-analysis-line':
      analysis.lines.push(createEmptyAnalysisLine());
      break;
    case 'delete-analysis-line':
      analysis.lines.splice(idx, 1);
      break;

    // Workflow Composer
    case 'add-wf-step':
      workflow.steps.push(createEmptyWorkflowStep());
      break;
    case 'delete-wf-step':
      workflow.steps.splice(idx, 1);
      break;
    case 'push-to-cm':
      pushToCostModel();
      return; // don't re-render

    // MOS-F5: Allowance profile CRUD
    case 'manage-allowance-profiles':
      showAllowanceProfileModal();
      return;
  }
  renderContent();
}

// ============================================================
// MOS-F5 — ALLOWANCE PROFILE CRUD MODAL
// ============================================================

/**
 * Opens a modal that lists current ref_allowance_profiles rows and lets the
 * user create / edit / delete them inline. On save, refreshes refData and
 * re-renders the Analysis tab so the dropdown reflects the change.
 */
function showAllowanceProfileModal() {
  const profiles = (refData.allowanceProfiles || []).slice();
  const overlay = document.createElement('div');
  overlay.className = 'hub-modal-overlay';
  overlay.style.zIndex = '9999';
  overlay.innerHTML = renderAllowanceProfileModal(profiles);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-action="ap-close"]')?.addEventListener('click', close);

  const tbody = overlay.querySelector('#ap-tbody');
  if (!tbody) return;

  // Track local edits so we can save in one pass.
  /** @type {Record<string|number, any>} */
  const dirty = {};
  /** @type {any[]} */
  const newRows = [];

  function updateRow(id, field, val) {
    if (typeof id === 'string' && id.startsWith('new:')) {
      const i = Number(id.slice(4));
      newRows[i][field] = val;
    } else {
      if (!dirty[id]) dirty[id] = {};
      dirty[id][field] = val;
    }
  }

  // Bind input changes (delegated)
  tbody.addEventListener('input', e => {
    const tgt = e.target;
    if (!(tgt instanceof HTMLInputElement) && !(tgt instanceof HTMLSelectElement)) return;
    const id = tgt.dataset.apId;
    const field = tgt.dataset.apField;
    if (!id || !field) return;
    let val = tgt.value;
    if (['personal_pct','fatigue_pct','delay_pct'].includes(field)) val = parseFloat(val) || 0;
    updateRow(id, field, val);
    // Live-update the displayed total in the row
    const row = tgt.closest('tr');
    if (row) {
      const get = (f) => {
        const inp = row.querySelector(`[data-ap-field="${f}"]`);
        return inp ? (parseFloat(inp.value) || 0) : 0;
      };
      const total = get('personal_pct') + get('fatigue_pct') + get('delay_pct');
      const totalCell = row.querySelector('[data-ap-total]');
      if (totalCell) totalCell.textContent = total.toFixed(1) + '%';
    }
  });

  // Delete (per-row)
  tbody.addEventListener('click', async (e) => {
    const tgt = e.target;
    if (!(tgt instanceof HTMLElement)) return;
    const btn = tgt.closest('[data-action="ap-delete"]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    if (id.startsWith('new:')) {
      // remove unsaved row from local list
      const i = Number(id.slice(4));
      newRows[i] = null;
      btn.closest('tr')?.remove();
      return;
    }
    if (!confirm('Delete this allowance profile? Analyses currently using it will fall back to Custom PFD.')) return;
    btn.disabled = true;
    try {
      await api.deleteAllowanceProfile(id);
      btn.closest('tr')?.remove();
      // Mark for refresh
      dirty[id] = '__deleted__';
    } catch (err) {
      alert('Delete failed: ' + (err?.message || err));
      btn.disabled = false;
    }
  });

  // Add new row
  overlay.querySelector('[data-action="ap-add"]')?.addEventListener('click', () => {
    const row = { profile_name: 'New Profile', personal_pct: 5, fatigue_pct: 4, delay_pct: 5, environment_type: 'ambient' };
    const i = newRows.length;
    newRows.push(row);
    const tr = document.createElement('tr');
    tr.innerHTML = renderAllowanceProfileRow(row, 'new:' + i, true);
    tbody.appendChild(tr);
  });

  // Save all
  overlay.querySelector('[data-action="ap-save"]')?.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      // Updates first
      for (const id of Object.keys(dirty)) {
        if (dirty[id] === '__deleted__') continue;
        const patch = dirty[id];
        if (!patch || Object.keys(patch).length === 0) continue;
        await api.updateAllowanceProfile(id, patch);
      }
      // New rows
      for (const row of newRows) {
        if (!row) continue;
        await api.createAllowanceProfile(row);
      }
      // Refresh refData
      try {
        const fresh = await api.listAllowanceProfiles();
        refData.allowanceProfiles = fresh || [];
      } catch (_) {}
      overlay.remove();
      rerenderPreservingFocus();
    } catch (err) {
      alert('Save failed: ' + (err?.message || err));
      btn.disabled = false;
      btn.textContent = 'Save All';
    }
  });
}

function renderAllowanceProfileRow(p, id, isNew) {
  const total = ((+p.personal_pct || 0) + (+p.fatigue_pct || 0) + (+p.delay_pct || 0)).toFixed(1);
  const env = p.environment_type || 'ambient';
  const ENV_OPTIONS = ['ambient','cold','frozen','outdoor','clean_room'];
  return `
    <td><input class="hub-input" type="text" value="${(p.profile_name || '').replace(/"/g,'&quot;')}" data-ap-id="${id}" data-ap-field="profile_name" style="width:100%;font-size:12px;padding:4px 6px;" /></td>
    <td>
      <select class="hub-select" data-ap-id="${id}" data-ap-field="environment_type" style="font-size:12px;padding:4px 6px;">
        ${ENV_OPTIONS.map(v => `<option value="${v}"${v === env ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
    </td>
    <td><input class="hub-input" type="number" min="0" max="50" step="0.5" value="${p.personal_pct || 0}" data-ap-id="${id}" data-ap-field="personal_pct" style="width:60px;font-size:12px;padding:4px 6px;" /></td>
    <td><input class="hub-input" type="number" min="0" max="50" step="0.5" value="${p.fatigue_pct || 0}" data-ap-id="${id}" data-ap-field="fatigue_pct" style="width:60px;font-size:12px;padding:4px 6px;" /></td>
    <td><input class="hub-input" type="number" min="0" max="50" step="0.5" value="${p.delay_pct || 0}" data-ap-id="${id}" data-ap-field="delay_pct" style="width:60px;font-size:12px;padding:4px 6px;" /></td>
    <td class="cm-num" style="font-weight:700;color:var(--ies-navy);" data-ap-total>${total}%</td>
    <td><button class="cm-delete-btn" data-action="ap-delete" data-id="${id}" title="${isNew ? 'Discard new row' : 'Delete profile'}">${isNew ? 'Discard' : 'Delete'}</button></td>
  `;
}

function renderAllowanceProfileModal(profiles) {
  return `
    <div class="hub-modal" style="max-width:880px;width:95%;max-height:85vh;overflow:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h3 style="margin:0;font-size:16px;font-weight:700;">Manage Allowance Profiles</h3>
        <button class="cm-delete-btn" data-action="ap-close" style="font-size:16px;">✕</button>
      </div>
      <p style="color:var(--ies-gray-600);font-size:12px;margin-bottom:12px;line-height:1.4;">
        PFD profiles drive the Personal + Fatigue + Delay allowance applied to base UPH on the Analysis tab.
        Edit values inline, add new profiles via <strong>+ Add Profile</strong>, then click <strong>Save All</strong>.
        Changes write directly to <code>ref_allowance_profiles</code>.
      </p>
      <div style="overflow-x:auto;border:1px solid var(--ies-gray-200);border-radius:8px;">
        <table class="cm-grid-table" style="font-size:12px;width:100%;">
          <thead>
            <tr>
              <th>Profile Name</th>
              <th style="width:120px;">Environment</th>
              <th class="cm-num">Personal %</th>
              <th class="cm-num">Fatigue %</th>
              <th class="cm-num">Delay %</th>
              <th class="cm-num">Total PFD</th>
              <th style="width:80px;">Actions</th>
            </tr>
          </thead>
          <tbody id="ap-tbody">
            ${profiles.map(p => `<tr>${renderAllowanceProfileRow(p, p.id, false)}</tr>`).join('')}
            ${profiles.length === 0 ? '<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--ies-gray-400);">No profiles yet — click + Add Profile to create one.</td></tr>' : ''}
          </tbody>
        </table>
      </div>
      <div style="display:flex;gap:8px;justify-content:space-between;margin-top:14px;align-items:center;">
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="ap-add">+ Add Profile</button>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-secondary" data-action="ap-close">Cancel</button>
          <button class="hub-btn hub-btn-primary" data-action="ap-save">Save All</button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// MOST → COST MODEL INTEGRATION
// ============================================================

function pushToCostModel() {
  const pfd = analysis.pfd_pct || 14;
  const productivity = analysis.productivity_pct == null ? 90 : analysis.productivity_pct;
  const computedLines = analysis.lines.map(line => {
    const effRate = calc.resolveCategoryRate(
      analysis.rates_by_category, line.labor_category, analysis.hourly_rate, line.hourly_rate);
    // MOS-B5: learning-curve adjusts adjusted UPH after PFD/productivity.
    const lc = analysis.learning_curve_pct == null ? 100 : analysis.learning_curve_pct;
    const baseDerived = calc.computeAnalysisLine({
      base_uph: line.base_uph,
      pfd_pct: pfd,
      productivity_pct: productivity,
      daily_volume: line.daily_volume,
      shift_hours: analysis.shift_hours,
      hourly_rate: effRate,
    });
    const lcUph = calc.applyLearningCurve(baseDerived.adjusted_uph, lc);
    const lcHours = lcUph > 0 ? (line.daily_volume || 0) / lcUph : 0;
    const lcFte = (analysis.shift_hours || 8) > 0 ? lcHours / (analysis.shift_hours || 8) : 0;
    const lcCost = lcHours * effRate;
    const derived = {
      adjusted_uph: lcUph,
      hours_per_day: lcHours,
      fte: lcFte,
      headcount: Math.ceil(lcFte),
      daily_cost: lcCost,
    };
    return { ...line, ...derived };
  });

  // Build template map for metadata lookup (E1 P0)
  const templateMap = new Map();
  (refData.templates || []).forEach(t => templateMap.set(t.id, t));

  const cmLines = calc.convertToCmLaborLines(computedLines, {
    operatingDays: analysis.operating_days,
    shiftHours: analysis.shift_hours,
    defaultBurdenPct: 30,
    templateMap,
  });

  /** @type {import('./types.js?v=20260418-sM').MostToCmPayload} */
  const payload = {
    laborLines: cmLines,
    operatingDays: analysis.operating_days,
    shiftHours: analysis.shift_hours,
  };

  // Brock 2026-04-20 — same cross-tool handoff fix as CM↔WSC. The bus emit
  // fires before CM mounts, so the event is lost. sessionStorage survives
  // the tool switch; CM's mount() consumes it there.
  try { sessionStorage.setItem('most_pending_push', JSON.stringify({ ...payload, at: Date.now() })); } catch {}
  bus.emit('most:push-to-cm', payload); // still fire for the in-session case

  // Navigate the user to CM so they land on the receiving end of the push.
  window.location.hash = '#designtools/cost-model';
}

// ============================================================
// HELPERS
// ============================================================

function filterTemplates() {
  return (refData.templates || []).filter(t => {
    if (filters.processArea && t.process_area !== filters.processArea) return false;
    if (filters.laborCategory && t.labor_category !== filters.laborCategory) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!getMostTplName(t).toLowerCase().includes(q) && !(t.description || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function groupByProcessArea(templates) {
  /** @type {Record<string, import('./types.js?v=20260418-sM').MostTemplate[]>} */
  const groups = {};
  for (const t of templates) {
    const area = t.process_area || 'Other';
    if (!groups[area]) groups[area] = [];
    groups[area].push(t);
  }
  return groups;
}

function createEmptyAnalysis() {
  return {
    id: null,
    name: 'New Analysis',
    allowance_profile_id: null,
    pfd_pct: 14,
    shift_hours: 8,
    operating_days: 260,
    // MOS-E3: legacy single rate kept for backwards compat. Effective per-line
    // rate is now resolved via resolveCategoryRate(rates_by_category, ...).
    hourly_rate: 18,
    rates_by_category: { manual: 18, mhe: 22, hybrid: 20 },
    // MOS-B5: learning-curve productivity index (100 = mature operator).
    // Multiplies adjusted UPH; default 100 = no effect.
    learning_curve_pct: 100,
    lines: [],
  };
}

function createEmptyAnalysisLine() {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
    template_id: null,
    activity_name: '',
    process_area: '',
    labor_category: 'manual',
    uom: 'each',
    base_uph: 0,
    adjusted_uph: 0,
    daily_volume: 0,
    hours_per_day: 0,
    fte: 0,
    headcount: 0,
    hourly_rate: 0,
    daily_cost: 0,
    // Q3 v2 parity (Brock 2026-04-20): per-row variable override.
    // is_variable flags a line as driven by a variable element (doc); when
    // checked, the Driver + Formula fields surface next to it so the
    // analyst can record what's driving the variability (e.g. "pallets/
    // order", "3 TMU + 0.5 × distance_ft"). Pre-populated when the picked
    // template has a variable element. Stored in analysis_data jsonb.
    is_variable: false,
    variable_driver: '',
    variable_formula: '',
  };
}

function createEmptyWorkflow() {
  return {
    id: null,
    name: 'New Workflow',
    target_volume_per_day: 5000,
    shift_hours: 8,
    pfd_pct: 14,
    steps: [],
  };
}

function createEmptyWorkflowStep() {
  return {
    id: Date.now().toString(),
    template_id: null,
    step_name: '',
    process_area: '',
    labor_category: 'manual',
    base_uph: 0,
    adjusted_uph: 0,
    volume_ratio: 1,
    daily_volume: 0,
    hours_per_day: 0,
    fte: 0,
  };
}

function formatDollar(val) {
  return '$' + (val || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ============================================================
// TEMPLATE EDITOR ACTIONS
// ============================================================

function createEmptyElement() {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
    template_id: null,
    sequence_order: (editorElements.length || 0) + 1,
    element_name: '',
    most_sequence: '',
    sequence_type: 'get',
    tmu_value: 0,
    freq_per_cycle: 1,
    is_variable: false,
    variable_driver: null,
    variable_min: 0,
    variable_max: 0,
  };
}


function updateEditorMetrics() {
  const totalTmu = calc.sumElementTmu(editorElements);
  const baseUph = calc.baseUph(totalTmu);
  const container = rootEl?.querySelector('#most-content');
  if (!container) return;

  const uphEl = container.querySelector('#edit-live-uph');
  const tmuEl = container.querySelector('#edit-live-tmu');
  const cycleEl = container.querySelector('#edit-live-cycle');
  const countEl = container.querySelector('#edit-live-count');

  if (uphEl) uphEl.textContent = calc.formatUph(baseUph);
  if (tmuEl) tmuEl.textContent = totalTmu;
  if (cycleEl) cycleEl.textContent = calc.formatTmu(totalTmu);
  if (countEl) countEl.textContent = editorElements.length;
}

async function saveTemplateAction() {
  const container = rootEl?.querySelector('#most-content');
  if (!container) return;

  const name = /** @type {HTMLInputElement} */ (container.querySelector('#edit-tpl-name')).value || '';
  const area = /** @type {HTMLInputElement} */ (container.querySelector('#edit-tpl-area')).value || '';
  const cat = /** @type {HTMLInputElement} */ (container.querySelector('#edit-tpl-cat')).value || 'manual';
  const uom = /** @type {HTMLInputElement} */ (container.querySelector('#edit-tpl-uom')).value || 'each';
  const equipment = /** @type {HTMLInputElement} */ (container.querySelector('#edit-tpl-equipment')).value || '';
  const wms = /** @type {HTMLInputElement} */ (container.querySelector('#edit-tpl-wms')).value || '';
  const desc = /** @type {HTMLInputElement} */ (container.querySelector('#edit-tpl-desc')).value || '';

  if (!name || !area || editorElements.length === 0) {
    alert('Activity name, process area, and at least 1 element are required.');
    return;
  }

  const totalTmu = calc.sumElementTmu(editorElements);
  const baseUph = calc.baseUph(totalTmu);

  try {
    let tpl = editorTemplate || { activity_name: name, process_area: area, labor_category: cat, uom, equipment_type: equipment, wms_transaction: wms, description: desc };

    if (editorTemplate?.id) {
      // Update existing
      tpl = await api.updateTemplate(editorTemplate.id, {
        activity_name: name, process_area: area, labor_category: cat, uom, equipment_type: equipment,
        wms_transaction: wms, description: desc, total_tmu_base: totalTmu, units_per_hour_base: baseUph,
      });
      // Update elements
      for (let i = 0; i < editorElements.length; i++) {
        const el = editorElements[i];
        el.sequence_order = i + 1;
        el.template_id = tpl.id;
        if (el.id && !el.id.includes('new')) {
          await api.updateElement(el.id, el);
        } else {
          const newEl = await api.createElement(el);
          editorElements[i].id = newEl.id;
        }
      }
    } else {
      // Create new
      tpl = await api.createTemplate({
        activity_name: name, process_area: area, labor_category: cat, uom, equipment_type: equipment,
        wms_transaction: wms, description: desc, total_tmu_base: totalTmu, units_per_hour_base: baseUph, is_active: true,
      });
      // Add elements
      for (let i = 0; i < editorElements.length; i++) {
        const el = { ...editorElements[i], sequence_order: i + 1, template_id: tpl.id };
        const newEl = await api.createElement(el);
        editorElements[i].id = newEl.id;
      }
    }

    // Reload templates and close editor
    refData.templates = await api.listTemplates();
    editorTemplate = null;
    editorElements = [];
    bus.emit('most:template-saved', { id: tpl.id });
    renderContent();
  } catch (err) {
    console.error('[MOST] Save template failed:', err);
    alert('Failed to save template. See console for details.');
  }
}

// ============================================================
// SCENARIO ACTIONS (localStorage-backed)
// ============================================================

async function saveCurrentScenario() {
  const linesWithVolume = (analysis.lines || []).filter(l => l.daily_volume > 0).length;
  if (linesWithVolume === 0) {
    alert('Add at least one activity with volume before saving.');
    return;
  }

  const name = prompt('Scenario name:', `Scenario ${savedScenarios.length + 1}`);
  if (!name) return;

  try {
    const saved = await api.saveAnalysis({
      name,
      pfd_pct: analysis.pfd_pct || 14,
      productivity_pct: analysis.productivity_pct == null ? 90 : analysis.productivity_pct,
      shift_hours: analysis.shift_hours || 8,
      operating_days: analysis.operating_days || 250,
      hourly_rate: analysis.hourly_rate || 0,
      allowance_profile_id: analysis.allowance_profile_id || null,
      // MOS-E3 + MOS-B5: forward per-category rates + learning curve
      rates_by_category: analysis.rates_by_category || null,
      learning_curve_pct: analysis.learning_curve_pct == null ? 100 : analysis.learning_curve_pct,
      lines: analysis.lines || [],
    });
    // Refresh the list from Supabase so we get the canonical row (incl. id, timestamps)
    const rows = await api.listAnalyses();
    savedScenarios = rows.map(analysisRowToScenario);
    renderContent();
  } catch (err) {
    console.warn('[MOST] saveAnalysis failed, falling back to localStorage:', err);
    // Fallback: keep the local-only behaviour so the user doesn't lose work
    const summary = calc.computeAnalysisSummary((analysis.lines || []).map(line => ({
      ...line,
      ...calc.computeAnalysisLine({
        base_uph: line.base_uph,
        pfd_pct: analysis.pfd_pct || 14,
        productivity_pct: analysis.productivity_pct == null ? 90 : analysis.productivity_pct,
        daily_volume: line.daily_volume,
        shift_hours: analysis.shift_hours,
        hourly_rate: line.hourly_rate || analysis.hourly_rate,
      }),
    })), analysis.operating_days);
    savedScenarios.push({
      name,
      timestamp: new Date().toLocaleString(),
      lines: linesWithVolume,
      pfd: analysis.pfd_pct,
      shiftHrs: analysis.shift_hours,
      rate: analysis.hourly_rate || 0,
      ftes: summary.totalFtes,
      headcount: summary.totalHeadcount,
      hours: summary.totalHoursPerDay,
      dailyCost: summary.dailyCost,
      annualCost: summary.annualCost,
      data: JSON.parse(JSON.stringify({ ...analysis })),
    });
    try {
      localStorage.setItem('most_scenarios', JSON.stringify(savedScenarios));
    } catch {}
    renderContent();
    alert('Saved locally — Supabase save failed: ' + (err.message || 'unknown'));
  }
}

function loadScenario(idx) {
  if (!savedScenarios[idx]) return;
  const scenario = savedScenarios[idx];
  analysis = JSON.parse(JSON.stringify(scenario.data));
  renderContent();
}

async function deleteScenario(idx) {
  if (!confirm('Delete this scenario?')) return;
  const sc = savedScenarios[idx];
  if (!sc) return;

  if (sc.id) {
    try {
      await api.deleteAnalysis(sc.id);
    } catch (err) {
      console.warn('[MOST] deleteAnalysis failed:', err);
      alert('Could not delete from Supabase: ' + (err.message || 'unknown'));
      return;
    }
  }
  savedScenarios.splice(idx, 1);
  // Keep localStorage cache in sync (defence-in-depth for offline use)
  try {
    localStorage.setItem('most_scenarios', JSON.stringify(savedScenarios.filter(s => !s.id)));
  } catch {}
  renderContent();
}

async function copyScenario(idx) {
  const sc = savedScenarios[idx];
  if (!sc) return;
  const proposed = `${sc.name} (Copy)`;
  const newName = prompt('Name for the duplicate scenario:', proposed);
  if (!newName) return;
  try {
    await api.saveAnalysis({
      name: newName,
      pfd_pct: sc.data?.pfd_pct,
      productivity_pct: sc.data?.productivity_pct,
      shift_hours: sc.data?.shift_hours,
      operating_days: sc.data?.operating_days,
      hourly_rate: sc.data?.hourly_rate,
      allowance_profile_id: sc.data?.allowance_profile_id || null,
      rates_by_category: sc.data?.rates_by_category || null,
      learning_curve_pct: sc.data?.learning_curve_pct == null ? 100 : sc.data.learning_curve_pct,
      lines: (sc.data?.lines || []).map(l => ({ ...l })),
    });
    const rows = await api.listAnalyses();
    savedScenarios = rows.map(analysisRowToScenario);
    renderContent();
  } catch (err) {
    console.warn('[MOST] copyScenario failed:', err);
    alert('Could not duplicate scenario: ' + (err.message || 'unknown'));
  }
}

/**
 * Export the currently visible Quick Analysis to xlsx via shared/export.js.
 * One sheet for activity lines, one sheet for the rolled-up summary.
 */
async function exportAnalysisToXlsx() {
  const exp = await import('../../shared/export.js?v=20260418-sM');
  const pfd = analysis.pfd_pct || 14;
  const productivity = analysis.productivity_pct == null ? 90 : analysis.productivity_pct;
  const lineRows = (analysis.lines || []).map(line => {
    const computed = calc.computeAnalysisLine({
      base_uph: line.base_uph,
      pfd_pct: pfd,
      productivity_pct: productivity,
      daily_volume: line.daily_volume,
      shift_hours: analysis.shift_hours,
      hourly_rate: line.hourly_rate || analysis.hourly_rate,
    });
    return {
      activity: line.activity_name || line.template_name || 'Activity',
      base_uph: line.base_uph || 0,
      pfd_pct: pfd,
      productivity_pct: productivity,
      effective_uph: computed.adjusted_uph || 0,
      is_variable: line.is_variable ? 'Yes' : '',
      variable_driver: line.variable_driver || '',
      variable_formula: line.variable_formula || '',
      daily_volume: line.daily_volume || 0,
      hours_per_day: computed.hours_per_day || 0,
      headcount: computed.headcount || 0,
      ftes: computed.fte || 0,
      hourly_rate: line.hourly_rate || analysis.hourly_rate || 0,
      daily_cost: computed.daily_cost || 0,
    };
  });

  const computedLines = lineRows.map(r => ({ ...r }));
  const summary = calc.computeAnalysisSummary(computedLines.map(r => ({
    headcount: r.headcount, ftes: r.ftes, hours_per_day: r.hours_per_day,
    daily_cost: r.daily_cost, annual_cost: r.annual_cost,
  })), analysis.operating_days);

  const summaryRows = [
    { metric: 'Total Headcount', value: summary.totalHeadcount },
    { metric: 'Total FTEs', value: summary.totalFtes },
    { metric: 'Total Hours/Day', value: summary.totalHoursPerDay },
    { metric: 'Daily Cost', value: summary.dailyCost },
    { metric: 'Annual Cost', value: summary.annualCost },
    { metric: 'PFD %', value: pfd },
    { metric: 'Productivity %', value: productivity },
    { metric: 'Shift Hours', value: analysis.shift_hours },
    { metric: 'Operating Days/yr', value: analysis.operating_days || 250 },
    { metric: 'Default Hourly Rate', value: analysis.hourly_rate || 0 },
  ];

  exp.downloadXLSX({
    filename: `MOST_Analysis_${new Date().toISOString().slice(0, 10)}.xlsx`,
    sheets: [
      {
        name: 'Activity Lines',
        rows: lineRows,
        columns: [
          { key: 'activity', label: 'Activity' },
          { key: 'base_uph', label: 'Base UPH', format: 'number', decimals: 1 },
          { key: 'pfd_pct', label: 'PFD %', format: 'pct' },
          { key: 'productivity_pct', label: 'Productivity %', format: 'pct' },
          { key: 'effective_uph', label: 'Effective UPH', format: 'number', decimals: 1 },
          { key: 'is_variable', label: 'Variable?' },
          { key: 'variable_driver', label: 'Driver' },
          { key: 'variable_formula', label: 'Formula' },
          { key: 'daily_volume', label: 'Daily Volume', format: 'number' },
          { key: 'hours_per_day', label: 'Hours/Day', format: 'number', decimals: 2 },
          { key: 'headcount', label: 'Headcount', format: 'number', decimals: 1 },
          { key: 'ftes', label: 'FTEs', format: 'number', decimals: 2 },
          { key: 'hourly_rate', label: 'Hourly Rate', format: 'currency', decimals: 2 },
          { key: 'daily_cost', label: 'Daily Cost', format: 'currency' },
          { key: 'annual_cost', label: 'Annual Cost', format: 'currency' },
        ],
      },
      {
        name: 'Summary',
        rows: summaryRows,
        columns: [
          { key: 'metric', label: 'Metric' },
          { key: 'value', label: 'Value', format: 'number', decimals: 2 },
        ],
      },
    ],
  });
}

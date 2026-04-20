/**
 * IES Hub v3 — Cost Model Builder UI
 * Builder-pattern layout: 220px sidebar nav + fluid content area.
 * Each section renders from state via template literals + innerHTML.
 *
 * @module tools/cost-model/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import { state } from '../../shared/state.js?v=20260418-sK';
import { downloadXLSX } from '../../shared/export.js?v=20260419-tC';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import * as calc from './calc.js?v=20260419-uC';
import * as api from './api.js?v=20260419-uH';
import * as scenarios from './calc.scenarios.js?v=20260419-sZ';
import * as planningRatios from '../../shared/planning-ratios.js?v=20260419-uH';

// ============================================================
// Non-blocking modal helpers (replace confirm/prompt/alert).
// Native dialogs freeze under the Claude-in-Chrome extension and are
// generally poor UX in SPAs; these return Promises the caller can await.
// ============================================================

/**
 * Show a non-blocking confirm modal. Resolves to true/false.
 * @param {string} message  prompt text (supports \n line breaks)
 * @param {{ okLabel?: string, cancelLabel?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
function showConfirm(message, opts = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hub-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
    const okBg = opts.danger ? '#dc2626' : 'var(--ies-blue-600)';
    overlay.innerHTML = `
      <div style="background:white;border-radius:8px;padding:24px;min-width:420px;max-width:90vw;">
        <div style="white-space:pre-line;font-size:14px;line-height:1.45;">${String(message).replace(/</g, '&lt;')}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="hub-btn" data-ans="0">${opts.cancelLabel || 'Cancel'}</button>
          <button class="hub-btn-primary" data-ans="1" style="${opts.danger ? `background:${okBg};` : ''}">${opts.okLabel || 'Confirm'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-ans="0"]')?.addEventListener('click', () => done(false));
    overlay.querySelector('[data-ans="1"]')?.addEventListener('click', () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(false); }
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); done(true); }
    });
  });
}

/**
 * Show a non-blocking prompt modal. Resolves to the string value or null
 * if cancelled.
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string|null>}
 */
function showPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hub-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
      <div style="background:white;border-radius:8px;padding:24px;min-width:480px;max-width:90vw;">
        <div style="white-space:pre-line;font-size:14px;line-height:1.45;margin-bottom:10px;">${String(message).replace(/</g, '&lt;')}</div>
        <input class="hub-input" data-prompt-input style="width:100%;font-size:14px;padding:6px 8px;" value="${String(defaultValue).replace(/"/g, '&quot;')}" />
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="hub-btn" data-ans="cancel">Cancel</button>
          <button class="hub-btn-primary" data-ans="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('[data-prompt-input]');
    setTimeout(() => input?.focus(), 20);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-ans="cancel"]')?.addEventListener('click', () => done(null));
    overlay.querySelector('[data-ans="ok"]')?.addEventListener('click', () => done(input?.value ?? ''));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(null); }
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); done(input?.value ?? ''); }
    });
  });
}

// ============================================================
// STATE — tool-local reactive state
// ============================================================

/** @type {import('./types.js?v=20260418-sK').CostModelData} */
let model = createEmptyModel();

/** @type {Object} */
let refData = {};

/** @type {string} */
let activeSection = 'setup';

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {boolean} */
let isDirty = false;

/** @type {boolean} Track whether user has interacted — suppresses validation on fresh model */
let userHasInteracted = false;

/** @type {'landing' | 'editor'} Landing page (saved models) vs editor (builder). */
let viewMode = 'landing';

/** @type {Array<{id:number,name:string,client_name:string,market_id:string|null,updated_at:string}>} */
let savedModels = [];

/** @type {Array<{id:string,deal_name:string,client_name:string|null}>} */
let savedDeals = [];

// ============================================================
// DEMO FALLBACK DATA — used when Supabase ref tables unavailable
// ============================================================

const DEMO_MARKETS_FALLBACK = [
  { market_id: 'mem', name: 'Memphis, TN' },
  { market_id: 'ind', name: 'Indianapolis, IN' },
  { market_id: 'chi', name: 'Chicago, IL' },
  { market_id: 'dal', name: 'Dallas-Fort Worth, TX' },
  { market_id: 'atl', name: 'Atlanta, GA' },
  { market_id: 'lax', name: 'Los Angeles, CA' },
  { market_id: 'njy', name: 'Northern NJ / NYC Metro' },
  { market_id: 'col', name: 'Columbus, OH' },
  { market_id: 'leh', name: 'Lehigh Valley, PA' },
  { market_id: 'sav', name: 'Savannah, GA' },
  { market_id: 'lou', name: 'Louisville, KY' },
  { market_id: 'pho', name: 'Phoenix, AZ' },
  { market_id: 'cin', name: 'Cincinnati, OH' },
  { market_id: 'rvs', name: 'Riverside / Inland Empire, CA' },
  { market_id: 'nas', name: 'Nashville, TN' },
  { market_id: 'hou', name: 'Houston, TX' },
  { market_id: 'kci', name: 'Kansas City, MO' },
  { market_id: 'rno', name: 'Reno, NV' },
  { market_id: 'cha', name: 'Charlotte, NC' },
  { market_id: 'sea', name: 'Seattle-Tacoma, WA' },
];

// ============================================================
// SECTIONS — 13 nav sections
// ============================================================

const SECTIONS = [
  // Scope — who, what, where
  { key: 'setup',          label: 'Setup',              icon: 'settings',      group: 'scope' },
  { key: 'volumes',        label: 'Volumes',            icon: 'bar-chart',     group: 'scope' },
  { key: 'orderProfile',   label: 'Order Profile',      icon: 'package',       group: 'scope' },
  // Structure — framework to build inside (physical + commercial)
  { key: 'facility',       label: 'Facility',           icon: 'home',          group: 'structure' },
  { key: 'shifts',         label: 'Shifts',             icon: 'clock',         group: 'structure' },
  { key: 'pricingBuckets', label: 'Pricing Buckets',    icon: 'layers',        group: 'structure' },
  { key: 'financial',      label: 'Financial',          icon: 'trending-up',   group: 'structure' },
  // Cost — the build itself
  { key: 'labor',          label: 'Labor',              icon: 'users',         group: 'cost' },
  { key: 'equipment',      label: 'Equipment',          icon: 'truck',         group: 'cost' },
  { key: 'overhead',       label: 'Overhead',           icon: 'layers',        group: 'cost' },
  { key: 'vas',            label: 'VAS',                icon: 'star',          group: 'cost' },
  { key: 'startup',        label: 'Start-Up / Capital', icon: 'zap',           group: 'cost' },
  // Output — what the model produces
  { key: 'summary',        label: 'Summary',            icon: 'pie-chart',     group: 'output' },
  { key: 'pricing',        label: 'Pricing',            icon: 'tag',           group: 'output' },
  { key: 'timeline',       label: 'Timeline',           icon: 'calendar',      group: 'output' },
  { key: 'scenarios',      label: 'Scenarios',          icon: 'git-branch',    group: 'output' },
  // Analysis — iterate + governance
  { key: 'whatif',         label: 'What-If Studio',     icon: 'trending-up',   group: 'analysis' },
  { key: 'assumptions',    label: 'Assumptions',        icon: 'sliders',       group: 'analysis' },
  { key: 'linked',         label: 'Linked Designs',     icon: 'link',          group: 'analysis' },
];

/**
 * v2 UI — five-phase grouping. Follows the actual build flow: scope the
 * deal → stand up the framework (facility/shifts/buckets/financial) → build
 * the cost lines INTO those buckets → see the output → analyze + iterate.
 * When flag off, sidebar renders as the flat 19-item list.
 */
const SECTION_GROUPS = [
  { key: 'scope',      label: 'Scope',       description: 'Who, what, where' },
  { key: 'structure',  label: 'Structure',   description: 'Framework: facility, shifts, pricing buckets, financial' },
  { key: 'cost',       label: 'Cost',        description: 'The build: labor, equipment, overhead, VAS, startup' },
  { key: 'output',     label: 'Output',      description: 'Summary, pricing rates, timeline, scenarios' },
  { key: 'analysis',   label: 'Analysis',    description: 'What-If, assumptions, links' },
];

// Phase 3 module-local state
let heuristicsCatalog = [];
let heuristicOverrides = {};
let dealScenarios = [];
let currentScenario = null;
let currentScenarioSnapshots = null;   // grouped { labor:[], facility:[], ..., heuristics:[] }
let currentRevisions = [];
let _lastCalcHeuristics = null;        // set by Summary calc; read by Timeline/Summary banners
// Phase 4c — cached market labor profile (set when project's market is known)
let currentMarketLaborProfile = null;
// Re-entry guards — prevent infinite render loops when the lazy loader fires
// a post-load renderSection() that then re-triggers bindSectionEvents →
// which sees the same "not loaded yet" state and schedules ANOTHER load.
let _scenariosLoadInFlight = false;
let _scenariosLoadedOnce = false;
let _heuristicsLoadInFlight = false;
// Phase 5b — What-If Studio transient overlay (preview-only; not persisted
// until user hits Apply). Highest-priority layer in resolveCalcHeuristics.
let whatIfTransient = {};
let _whatIfDebounce = null;
// Phase 6 — Planning Ratios catalog (ref_planning_ratios + ref_heuristic_categories).
// Separate from heuristicsCatalog above; this is the richer 142-rule engineering
// defaults catalog with applicability filters + SCD.
let planningRatiosCatalog = [];
let planningRatioCategories = [];
let planningRatioOverrides = {};
let _planningRatiosLoadInFlight = false;
/** UI-only: which category card is expanded. Null = all collapsed. */
let _planningRatioOpenCategory = null;

// v2 UI redesign (2026-04-19) — feature-flagged redesign of sidebar nav +
// Labor section. Flip off via `window.COST_MODEL_V2_UI = false` in console
// to compare against the old layout.
/** Groups the user has collapsed in the grouped sidebar. */
let _collapsedNavGroups = new Set();
/** Which Direct Labor line is currently selected in the master-detail view. */
let _selectedLaborIdx = 0;

function isCmV2UiOn() {
  return typeof window === 'undefined' || window.COST_MODEL_V2_UI !== false;
}

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Cost Model Builder.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeSection = 'setup';
  model = createEmptyModel();
  userHasInteracted = false;
  viewMode = 'landing';
  // Reset Phase 3/4 module state so a prior session's cache doesn't bleed in
  currentScenario = null;
  currentScenarioSnapshots = null;
  currentRevisions = [];
  dealScenarios = [];
  _scenariosLoadedOnce = false;
  _scenariosLoadInFlight = false;
  _heuristicsLoadInFlight = false;
  heuristicOverrides = {};
  currentMarketLaborProfile = null;
  // Phase 6 — planning ratios reset (catalog is shared across projects, don't
  // clear it; but overrides + open-category are per-project/session)
  planningRatioOverrides = {};
  _planningRatioOpenCategory = null;
  _planningRatiosLoadInFlight = false;
  // v2 UI — reset transient selection state
  _selectedLaborIdx = 0;
  _collapsedNavGroups = new Set();

  // Load reference data + saved models + saved deals + ref_periods in parallel
  try {
    const [rd, models, deals, periods] = await Promise.all([
      api.loadAllRefData().catch(() => ({})),
      api.listModels().catch(() => []),
      api.listDeals().catch(() => []),
      api.fetchRefPeriods().catch(() => []),
    ]);
    refData = { ...rd, periods };
    savedModels = models;
    savedDeals  = deals;
  } catch (err) {
    console.warn('[CM] Initial load failed:', err);
  }

  // Listen for cross-tool push events
  bus.on('most:push-to-cm', handleMostPush);
  bus.on('wsc:push-to-cm', handleWscPush);

  // If WSC pushed data before we mounted, consume the sessionStorage handoff.
  // This skips the landing page and takes the user straight into the editor
  // with the WSC facility dimensions applied — the expected behavior of the
  // "Use in Cost Model →" button.
  try {
    const pending = sessionStorage.getItem('wsc_pending_push');
    if (pending) {
      const payload = JSON.parse(pending);
      // Only consume if recent (within 60s) — stale entries shouldn't hijack future opens
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('wsc_pending_push');
        // Switch to editor mode first, then apply
        model = createEmptyModel();
        isDirty = false;
        userHasInteracted = false;
        activeSection = 'facility';
        viewMode = 'editor';
        // Apply payload to the fresh model
        if (payload.totalSqft)    model.facility.totalSqft = payload.totalSqft;
        if (payload.clearHeight)  model.facility.clearHeight = payload.clearHeight;
        if (payload.dockDoors)    model.facility.dockDoors = payload.dockDoors;
        if (payload.officeSqft)   model.facility.officeSqft = payload.officeSqft;
        if (payload.stagingSqft)  model.facility.stagingSqft = payload.stagingSqft;
        isDirty = true;
      } else {
        // Stale — discard
        sessionStorage.removeItem('wsc_pending_push');
      }
    }
  } catch (e) {
    console.warn('[CM] Failed to consume WSC push handoff:', e);
  }

  renderCurrentView();

  bus.emit('cm:mounted');
}

/** Render whichever view (landing vs editor) is active. Re-wires its events. */
function renderCurrentView() {
  if (!rootEl) return;
  if (viewMode === 'landing') {
    rootEl.innerHTML = renderLanding();
    wireLandingEvents();
  } else {
    rootEl.innerHTML = renderShell();
    wireEditorEvents();
  }
}

function wireLandingEvents() {
  if (!rootEl) return;
  rootEl.querySelector('#cm-create-new')?.addEventListener('click', () => {
    model = createEmptyModel();
    isDirty = false;
    userHasInteracted = false;
    activeSection = 'setup';
    viewMode = 'editor';
    renderCurrentView();
  });

  // Delete button on landing card — confirms, removes row from Supabase, re-renders.
  rootEl.querySelectorAll('[data-cm-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't trigger the card-open handler
      const id = Number(btn.getAttribute('data-cm-delete'));
      const name = btn.getAttribute('data-cm-name') || `Model #${id}`;
      if (!id) return;
      if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
      try {
        await api.deleteModel(id);
        savedModels = savedModels.filter(m => m.id !== id);
        renderCurrentView();
      } catch (err) {
        console.error('[CM] Delete failed:', err);
        showCmToast('Delete failed: ' + err.message, 'error');
      }
    });
  });

  rootEl.querySelectorAll('[data-cm-card]').forEach(card => {
    card.addEventListener('click', async () => {
      const id = Number(card.getAttribute('data-cm-card'));
      if (!id) return;
      try {
        const full = await api.getModel(id);
        if (!full) { showCmToast('Model not found — it may have been deleted.', 'error'); return; }
        // Load logic:
        //   (a) Modern rows: use project_data jsonb blob directly.
        //   (b) Legacy rows (no project_data): reconstruct a minimal model from flat columns
        //       so the user can still open / edit / re-save them. The next save populates
        //       project_data, upgrading the row in place.
        if (full.project_data) {
          model = { ...createEmptyModel(), ...full.project_data, id: full.id };
          // Belt-and-braces: hydrate any project_data fields that are missing or
          // empty from the row's flat columns. This covers rows where project_data
          // was seeded by a SQL UPDATE that didn't include every field, or where
          // project_data and the flat columns drifted out of sync. (I-03)
          if (!model.projectDetails) model.projectDetails = createEmptyModel().projectDetails;
          const pdHydrate = model.projectDetails;
          if (!pdHydrate.environment && full.environment_type) {
            pdHydrate.environment = String(full.environment_type).toLowerCase();
          }
          if (!pdHydrate.market && full.market_id) pdHydrate.market = full.market_id;
          if (!pdHydrate.clientName && full.client_name) pdHydrate.clientName = full.client_name;
          if (!pdHydrate.contractTerm && full.contract_term_years) pdHydrate.contractTerm = full.contract_term_years;
          if (!pdHydrate.dealId && full.deal_deals_id) pdHydrate.dealId = full.deal_deals_id;
          if (!pdHydrate.name && full.name) pdHydrate.name = full.name;
        } else {
          model = reconstructModelFromFlatRow(full);
          showCmToast('Legacy model loaded from summary fields. Save to upgrade to the new format.', 'info');
        }
        // Legacy models may have annual_hours=0 on lines with valid volume+uph; repair them.
        (model.laborLines || []).forEach(l => {
          if ((l.annual_hours || 0) === 0 && (l.volume || 0) > 0 && (l.base_uph || 0) > 0) {
            recomputeLineHours(l);
          }
        });
        isDirty = false;
        userHasInteracted = false;
        activeSection = 'setup';
        viewMode = 'editor';
        // Reset Phase 3/4 module state for the newly loaded project
        currentScenario = null;
        currentScenarioSnapshots = null;
        currentRevisions = [];
        dealScenarios = [];
        _scenariosLoadedOnce = false;
        _scenariosLoadInFlight = false;
        heuristicOverrides = {};
        currentMarketLaborProfile = null;
        // Phase 6 — planning ratio overrides are per-project
        planningRatioOverrides = {};
        _planningRatioOpenCategory = null;
        // v2 UI — reset selection on load
        _selectedLaborIdx = 0;
        // Reset Linked Designs cache so the next view fetches fresh for the new model
        linkedDesigns = null;
        _linkedDesignsLoadInFlight = false;
        renderCurrentView();
      } catch (err) {
        console.error('[CM] Load failed:', err);
        showCmToast('Load failed: ' + err.message, 'error');
      }
    });
  });
}

/**
 * Build a minimal v3 model object from a row that has only the flat cost_model_projects
 * columns (no project_data jsonb). Covers rows created before the v3 persistence backfill.
 * @param {any} row
 * @returns {object}
 */
function reconstructModelFromFlatRow(row) {
  const empty = createEmptyModel();
  // Volume columns → volumeLines
  const volumeMap = [
    { name: 'Pallets Received',   uom: 'pallets', key: 'vol_pallets_received',   isOut: false },
    { name: 'Put-Away (Pallets)', uom: 'pallets', key: 'vol_pallets_putaway',    isOut: false },
    { name: 'Pallets Shipped',    uom: 'pallets', key: 'vol_pallets_shipped',    isOut: true  },
    { name: 'Cases Picked',       uom: 'cases',   key: 'vol_cases_picked',       isOut: false },
    { name: 'Eaches Picked',      uom: 'eaches',  key: 'vol_eaches_picked',      isOut: false },
    { name: 'Orders Packed',      uom: 'orders',  key: 'vol_orders_packed',      isOut: false },
    { name: 'Replenishments',     uom: 'moves',   key: 'vol_replenishments',     isOut: false },
    { name: 'Returns Processed',  uom: 'orders',  key: 'vol_returns_processed',  isOut: false },
    { name: 'VAS Units',          uom: 'eaches',  key: 'vol_vas_units',          isOut: false },
  ];
  const volumeLines = volumeMap
    .filter(v => Number(row[v.key] || 0) > 0)
    .map(v => ({ name: v.name, volume: Number(row[v.key]), uom: v.uom, isOutboundPrimary: v.isOut }));
  // If no volumes, keep starter volumes so the form isn't empty
  return {
    ...empty,
    id: row.id,
    projectDetails: {
      name: row.name || '',
      clientName: row.client_name || '',
      market: row.market_id || '',
      environment: row.environment_type || '',
      facilityLocation: '',
      contractTerm: row.contract_term_years || 5,
      dealId: row.deal_deals_id || null,
    },
    volumeLines: volumeLines.length ? volumeLines : empty.volumeLines,
    facility: { ...empty.facility, totalSqft: Number(row.facility_sqft || empty.facility.totalSqft) },
    shifts: {
      shiftsPerDay: row.shifts_per_day || empty.shifts.shiftsPerDay,
      hoursPerShift: Number(row.hours_per_shift || empty.shifts.hoursPerShift),
      daysPerWeek: row.days_per_week || empty.shifts.daysPerWeek,
      weeksPerYear: row.operating_weeks_per_year || empty.shifts.weeksPerYear,
    },
    financial: {
      ...empty.financial,
      targetMargin: Number(row.target_margin_pct || empty.financial.targetMargin),
      annualEscalation: Number(row.labor_escalation_pct || empty.financial.annualEscalation),
      volumeGrowth: Number(row.annual_volume_growth_pct || empty.financial.volumeGrowth),
    },
    pricingBuckets: Array.isArray(row.pricing_buckets) && row.pricing_buckets.length
      ? row.pricing_buckets
      : empty.pricingBuckets,
  };
}

/**
 * Small non-blocking toast (replaces alert() which freezes the tab on our live URL).
 */
function showCmToast(message, level) {
  if (!rootEl) return;
  const color = level === 'error' ? '#dc2626' : level === 'info' ? '#2563eb' : '#16a34a';
  const bg = level === 'error' ? '#fef2f2' : level === 'info' ? '#eff6ff' : '#f0fdf4';
  const existing = document.getElementById('cm-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'cm-toast';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;padding:12px 16px;border-radius:8px;border:1px solid ${color};background:${bg};color:${color};font-size:13px;font-weight:600;z-index:9999;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,.12);`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 5000);
}

function wireEditorEvents() {
  if (!rootEl) return;
  // Sidebar nav
  rootEl.querySelectorAll('.cm-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const key = item.dataset.section;
      if (key) navigateSection(key);
    });
  });
  // v2 — group headers toggle their children (full editor re-render
  // keeps handler wiring simple; groups collapse/expand at local speed)
  rootEl.querySelectorAll('[data-nav-group-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.navGroupToggle;
      if (_collapsedNavGroups.has(key)) _collapsedNavGroups.delete(key);
      else _collapsedNavGroups.add(key);
      renderCurrentView();
    });
  });
  // Toolbar
  rootEl.querySelector('#cm-back-btn')?.addEventListener('click', async () => {
    // Refresh saved-models list when returning to landing
    try { savedModels = await api.listModels(); } catch {}
    viewMode = 'landing';
    renderCurrentView();
  });
  rootEl.querySelector('#cm-new-btn')?.addEventListener('click', handleNew);
  rootEl.querySelector('#cm-save-btn')?.addEventListener('click', handleSave);
  rootEl.querySelector('#cm-load-btn')?.addEventListener('click', handleLoad);
  rootEl.querySelector('#cm-export-btn')?.addEventListener('click', handleExportExcel);

  // Section content
  renderSection();
  updateValidation();
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  bus.clear('most:push-to-cm');
  bus.clear('wsc:push-to-cm');
  if (isDirty) {
    console.log('[CM] Unmounting with unsaved changes');
  }
  rootEl = null;
  bus.emit('cm:unmounted');
}

// ============================================================
// SHELL RENDERING
// ============================================================

function renderShell() {
  return `
    <div class="hub-builder" style="height: calc(100vh - 48px);">
      <!-- Builder Sidebar (220px) -->
      <div class="hub-builder-sidebar">
        <!-- Toolbar -->
        <div style="padding: 12px 16px; border-bottom: 1px solid var(--ies-gray-200);">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cm-back-btn" style="margin-bottom:8px;font-size:11px;">← All Models</button>
          <div class="text-subtitle" style="margin-bottom: 8px;">Cost Model Builder</div>
          <div class="flex gap-2" style="flex-wrap: wrap;">
            <button class="hub-btn hub-btn-primary hub-btn-sm" id="cm-new-btn">New</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-save-btn">Save</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-load-btn">Load</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-export-btn" title="Download as multi-sheet .xlsx">Export</button>
          </div>
        </div>
        <!-- Section Nav -->
        <nav style="padding: 8px 0;">
          ${isCmV2UiOn() ? renderGroupedNav() : SECTIONS.map(s => `
            <div class="cm-nav-item${s.key === activeSection ? ' active' : ''}" data-section="${s.key}">
              <span class="cm-nav-check" id="cm-check-${s.key}"></span>
              <span class="cm-nav-label">${s.label}</span>
            </div>
          `).join('')}
        </nav>
        <!-- Validation -->
        <div id="cm-validation" style="padding: 8px 16px; border-top: 1px solid var(--ies-gray-200); font-size: 11px;"></div>
      </div>

      <!-- Content Area -->
      <div class="hub-builder-content" id="cm-content">
        <div class="hub-builder-form" id="cm-section-content">
          <!-- Section content renders here -->
        </div>
      </div>
    </div>

    <style>
      .cm-nav-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: var(--ies-gray-600);
        transition: all 0.15s ease;
        border-left: 3px solid transparent;
      }
      .cm-nav-item:hover { background: var(--ies-gray-50); color: var(--ies-navy); }
      .cm-nav-item.active { background: rgba(0,71,171,0.06); color: var(--ies-blue); border-left-color: var(--ies-blue); }
      .cm-nav-check {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 2px solid var(--ies-gray-300);
        flex-shrink: 0;
      }
      .cm-nav-check.complete {
        background: var(--ies-green);
        border-color: var(--ies-green);
        position: relative;
      }
      .cm-nav-check.complete::after {
        content: '';
        position: absolute;
        left: 4px;
        top: 1px;
        width: 4px;
        height: 8px;
        border: solid #fff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }

      .cm-form-group { margin-bottom: 20px; }
      .cm-form-label {
        display: block;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--ies-gray-500);
        margin-bottom: 6px;
      }
      .cm-form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      .cm-form-row-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 16px;
      }

      .cm-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 20px;
        padding-bottom: 12px;
        border-bottom: 2px solid var(--ies-gray-200);
      }
      .cm-section-title { font-size: 16px; font-weight: 700; color: var(--ies-navy); }
      .cm-section-desc { font-size: 13px; color: var(--ies-gray-500); margin-top: 4px; }

      .cm-grid-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .cm-grid-table th {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--ies-gray-500);
        text-align: left;
        padding: 8px 10px;
        border-bottom: 2px solid var(--ies-gray-200);
        white-space: nowrap;
      }
      .cm-grid-table td {
        padding: 6px 10px;
        border-bottom: 1px solid var(--ies-gray-100);
        vertical-align: middle;
      }
      .cm-grid-table input, .cm-grid-table select {
        padding: 6px 8px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 4px;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 600;
      }
      .cm-grid-table input:focus, .cm-grid-table select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 2px rgba(0,71,171,0.1);
      }
      .cm-num { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
      .cm-total-row td { font-weight: 700; border-top: 2px solid var(--ies-gray-300); background: var(--ies-gray-50); }

      .cm-add-row-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 8px;
        padding: 6px 12px;
        background: none;
        border: 1px dashed var(--ies-gray-300);
        border-radius: 6px;
        color: var(--ies-blue);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        font-family: Montserrat, sans-serif;
      }
      .cm-add-row-btn:hover { border-color: var(--ies-blue); background: rgba(0,71,171,0.04); }

      .cm-delete-btn {
        background: none;
        border: none;
        color: var(--ies-red);
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: Montserrat, sans-serif;
      }
      .cm-delete-btn:hover { background: rgba(220,53,69,0.08); }
    </style>
  `;
}

// ============================================================
// SECTION NAVIGATION
// ============================================================

function navigateSection(key) {
  activeSection = key;
  state.set('costModel.activeSection', key);

  // Update nav highlighting
  rootEl?.querySelectorAll('.cm-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === key);
  });

  renderSection();
  bus.emit('cm:section-changed', { section: key });
}

// ============================================================
// SECTION RENDERING — delegates to section-specific renderers
// ============================================================

function renderSection() {
  const container = rootEl?.querySelector('#cm-section-content');
  if (!container) return;

  const renderers = {
    setup: renderSetup,
    volumes: renderVolumes,
    orderProfile: renderOrderProfile,
    facility: renderFacility,
    shifts: renderShifts,
    pricingBuckets: renderPricingBuckets,
    labor: renderLabor,
    equipment: renderEquipment,
    overhead: renderOverhead,
    vas: renderVas,
    financial: renderFinancial,
    startup: renderStartup,
    pricing: renderPricing,
    summary: renderSummary,
    timeline: renderTimeline,
    assumptions: renderAssumptions,
    scenarios: renderScenarios,
    whatif: renderWhatIfStudio,
    linked: renderLinkedDesigns,
  };

  const render = renderers[activeSection];
  if (render) {
    container.innerHTML = render();
    bindSectionEvents(activeSection, container);
  }
}

// ============================================================
// SECTION 1: SETUP
// ============================================================

/** Build a display label for a market row ("Chicago Metro, IL"). */
function marketLabel(m) {
  if (!m) return '';
  const name = m.name || m.market_name || m.abbr || (m.market_id || m.id);
  const state = m.state || '';
  return state ? `${name}, ${state}` : name;
}

/** Return "City, State" for the selected market id, or '' if no match. */
function deriveLocationString(marketId, markets) {
  if (!marketId || !Array.isArray(markets)) return '';
  const m = markets.find(x => (x.market_id || x.id) === marketId);
  return m ? marketLabel(m) : '';
}

// ============================================================
// v2 UI — Grouped sidebar nav renderer
// ============================================================

/**
 * Bucket the 18 nav sections into the 6 logical phases declared in
 * SECTION_GROUPS. Returns map keyed by group code → array of sections.
 */
function _sectionsByGroup() {
  const map = new Map();
  for (const g of SECTION_GROUPS) map.set(g.key, []);
  for (const s of SECTIONS) {
    if (!map.has(s.group)) map.set(s.group, []);
    map.get(s.group).push(s);
  }
  return map;
}

/**
 * Cheap per-section completion check. Returns 'complete' | 'partial' | 'empty'.
 * Today this is used to color a small dot next to each section and to roll
 * up into the group-header chip. Heuristic — not rigorous.
 */
function _sectionCompleteness(sectionKey) {
  const m = model || {};
  switch (sectionKey) {
    case 'setup': {
      const pd = m.projectDetails || {};
      const filled = ['name', 'clientName', 'market', 'environment', 'contractTerm']
        .filter(k => pd[k] !== null && pd[k] !== undefined && pd[k] !== '').length;
      if (filled === 5) return 'complete';
      if (filled === 0) return 'empty';
      return 'partial';
    }
    case 'volumes': {
      const lines = m.volumeLines || [];
      if (!lines.length) return 'empty';
      return lines.some(v => v.isOutboundPrimary) ? 'complete' : 'partial';
    }
    case 'orderProfile': {
      const op = m.orderProfile || {};
      return (op.linesPerOrder && op.unitsPerLine) ? 'complete' : op.linesPerOrder || op.unitsPerLine ? 'partial' : 'empty';
    }
    case 'facility':
      return (m.facility && m.facility.totalSqft > 0) ? 'complete' : 'empty';
    case 'shifts':
      return (m.shifts && m.shifts.shiftsPerDay > 0) ? 'complete' : 'empty';
    case 'labor':
      return (m.laborLines && m.laborLines.length > 0) ? 'complete' : 'empty';
    case 'equipment':
      return (m.equipmentLines && m.equipmentLines.length > 0) ? 'complete' : 'empty';
    case 'overhead':
      return (m.overheadLines && m.overheadLines.length > 0) ? 'complete' : 'empty';
    case 'vas':
      return (m.vasLines && m.vasLines.length > 0) ? 'complete' : 'empty';
    case 'financial':
      return (m.financial && m.financial.targetMarginPct > 0) ? 'complete' : 'empty';
    case 'pricingBuckets':
      return (m.pricingBuckets && m.pricingBuckets.length > 0) ? 'complete' : 'empty';
    case 'pricing':
      return (m.pricingBuckets && m.pricingBuckets.length > 0) ? 'complete' : 'empty';
    default:
      return 'empty';
  }
}

function renderGroupedNav() {
  const grouped = _sectionsByGroup();
  return SECTION_GROUPS.map(g => {
    const sections = grouped.get(g.key) || [];
    if (!sections.length) return '';
    const collapsed = _collapsedNavGroups.has(g.key);
    const completeCount = sections.filter(s => _sectionCompleteness(s.key) === 'complete').length;
    const groupDot = completeCount === sections.length ? 'complete'
                    : completeCount > 0                  ? 'partial'
                    : 'empty';
    return `
      <div class="hub-nav-group${collapsed ? ' is-collapsed' : ''}" data-nav-group="${g.key}">
        <button type="button" class="hub-nav-group__header" data-nav-group-toggle="${g.key}" title="${g.description}">
          <span class="hub-nav-group__caret">▾</span>
          <span>${g.label}</span>
          <span class="hub-completion-dot hub-completion-dot--${groupDot}"></span>
          <span class="hub-nav-group__count">${completeCount}/${sections.length}</span>
        </button>
        <div class="hub-nav-group__items">
          ${sections.map(s => {
            const done = _sectionCompleteness(s.key);
            return `
              <div class="cm-nav-item${s.key === activeSection ? ' active' : ''}" data-section="${s.key}">
                <span class="cm-nav-check${done === 'complete' ? ' complete' : ''}" id="cm-check-${s.key}"></span>
                <span class="cm-nav-label">${s.label}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderSetup() {
  const pd = model.projectDetails;
  const markets = (refData.markets && refData.markets.length > 0) ? refData.markets : DEMO_MARKETS_FALLBACK;

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Project Setup</div>
        <div class="cm-section-desc">Define the project basics — client, market, environment, and contract term.</div>
      </div>
    </div>

    <div class="cm-narrow-form">
      <div class="hub-field hub-field--full">
        <label class="hub-field__label">Project Name</label>
        <input class="hub-input" id="cm-name" value="${pd.name || ''}" placeholder="e.g., Acme Ecommerce Fulfillment" data-field="projectDetails.name" />
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Client Name</label>
        <input class="hub-input" id="cm-client" value="${pd.clientName || ''}" placeholder="Client name" data-field="projectDetails.clientName" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Market</label>
        <select class="hub-input" id="cm-market" data-field="projectDetails.market">
          <option value="">Select market...</option>
          ${markets.map(m => {
            const id = m.market_id || m.id;
            const label = marketLabel(m);
            return `<option value="${id}"${id === pd.market ? ' selected' : ''}>${label}</option>`;
          }).join('')}
        </select>
        <div class="hub-field__hint">Drives city / state and facility rate lookup.</div>
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Environment</label>
        <select class="hub-input" id="cm-env" data-field="projectDetails.environment">
          <option value="">Select environment...</option>
          ${(() => {
            const options = [
              // Climate / facility classification
              { label: 'Ambient', value: 'ambient' },
              { label: 'Refrigerated', value: 'refrigerated' },
              { label: 'Freezer', value: 'freezer' },
              { label: 'Temperature Controlled', value: 'temperature_controlled' },
              // Vertical / customer type
              { label: 'Ecommerce', value: 'ecommerce' },
              { label: 'Retail', value: 'retail' },
              { label: 'Food & Beverage', value: 'food & beverage' },
              { label: 'Industrial', value: 'industrial' },
              { label: 'Pharmaceutical', value: 'pharmaceutical' },
              { label: 'Automotive', value: 'automotive' },
              { label: 'Consumer Goods', value: 'consumer goods' },
            ];
            const curLower = String(pd.environment || '').toLowerCase().trim();
            // Case-insensitive match so "Ambient" or "AMBIENT" from DB still selects
            return options.map(o =>
              `<option value="${o.value}"${curLower === o.value.toLowerCase() ? ' selected' : ''}>${o.label}</option>`
            ).join('');
          })()}
        </select>
      </div>
      <div class="hub-field">
        <label class="hub-field__label">City, State</label>
        <input class="hub-input" id="cm-location-display" value="${deriveLocationString(pd.market, markets) || pd.facilityLocation || ''}" placeholder="—" readonly style="background:var(--ies-gray-50);color:var(--ies-gray-500);" />
        <div class="hub-field__hint">Derived from selected market.</div>
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Contract Term (Years)</label>
        <input class="hub-input" type="number" id="cm-term" value="${pd.contractTerm || 5}" min="1" max="20" step="1" data-field="projectDetails.contractTerm" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Link to Deal</label>
        <select class="hub-input" id="cm-deal" data-field="projectDetails.dealId">
          <option value="">— No linked deal —</option>
          ${savedDeals.map(d => {
            const label = d.deal_name + (d.client_name ? ` (${d.client_name})` : '');
            return `<option value="${d.id}"${d.id === pd.dealId ? ' selected' : ''}>${label}</option>`;
          }).join('')}
        </select>
        <div class="hub-field__hint">Optional. Links this cost model to a Deal Manager opportunity.</div>
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 2: VOLUMES
// ============================================================

function renderVolumes() {
  const lines = model.volumeLines || [];
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Annual Volumes</div>
        <div class="cm-section-desc">Define annual throughput volumes by activity type. Star the primary outbound line for unit cost metrics.</div>
      </div>
    </div>

    <table class="cm-grid-table">
      <thead>
        <tr>
          <th style="width:30px;"></th>
          <th>Activity</th>
          <th>Annual Volume</th>
          <th>UOM</th>
          <th style="width:60px;"></th>
        </tr>
      </thead>
      <tbody id="cm-volume-rows">
        ${lines.map((l, i) => `
          <tr>
            <td><button class="cm-star-btn${l.isOutboundPrimary ? ' active' : ''}" data-idx="${i}" title="Set as primary outbound">&#9733;</button></td>
            <td><input value="${l.name || ''}" style="width:180px;" data-idx="${i}" data-field="name" /></td>
            <td><input type="number" value="${l.volume || 0}" style="width:120px;" data-idx="${i}" data-field="volume" data-type="number" /></td>
            <td>
              <select style="width:90px;" data-idx="${i}" data-field="uom">
                ${['pallets', 'cases', 'eaches', 'orders', 'lines', 'units'].map(u =>
                  `<option value="${u}"${l.uom === u ? ' selected' : ''}>${u}</option>`
                ).join('')}
              </select>
            </td>
            <td><button class="cm-delete-btn" data-action="delete-volume" data-idx="${i}">Delete</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-volume">+ Add Volume Line</button>

    <style>
      .cm-star-btn { background: none; border: none; cursor: pointer; font-size: 18px; color: var(--ies-gray-300); }
      .cm-star-btn.active { color: var(--ies-orange); }
      .cm-star-btn:hover { color: var(--ies-orange); }
    </style>
  `;
}

// ============================================================
// SECTION 3: ORDER PROFILE
// ============================================================

function renderOrderProfile() {
  const op = model.orderProfile || {};
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Order Profile</div>
        <div class="cm-section-desc">Average order characteristics for cost-per-unit calculations.</div>
      </div>
    </div>

    <div class="cm-narrow-form">
      <div class="hub-field">
        <label class="hub-field__label">Lines Per Order</label>
        <input class="hub-input" type="number" value="${op.linesPerOrder || ''}" placeholder="e.g., 3.5" step="0.1" data-field="orderProfile.linesPerOrder" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Units Per Line</label>
        <input class="hub-input" type="number" value="${op.unitsPerLine || ''}" placeholder="e.g., 1.8" step="0.1" data-field="orderProfile.unitsPerLine" data-type="number" />
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Average Order Weight</label>
        <input class="hub-input" type="number" value="${op.avgOrderWeight || ''}" placeholder="e.g., 12.5" step="0.1" data-field="orderProfile.avgOrderWeight" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Weight Unit</label>
        <select class="hub-input" data-field="orderProfile.weightUnit">
          <option value="lbs"${op.weightUnit === 'lbs' || !op.weightUnit ? ' selected' : ''}>Pounds (lbs)</option>
          <option value="kg"${op.weightUnit === 'kg' ? ' selected' : ''}>Kilograms (kg)</option>
        </select>
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 4: FACILITY
// ============================================================

function renderFacility() {
  const f = model.facility || {};
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Facility</div>
        <div class="cm-section-desc">Warehouse dimensions and infrastructure. Facility cost is calculated from market rates.</div>
      </div>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="launch-wsc">Size with Calculator →</button>
    </div>

    <div class="cm-narrow-form" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
      <div class="hub-field">
        <label class="hub-field__label">Total Square Footage</label>
        <input class="hub-input" type="number" value="${f.totalSqft || ''}" placeholder="e.g., 150000" step="1000" data-field="facility.totalSqft" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Clear Height (ft)</label>
        <input class="hub-input" type="number" value="${f.clearHeight || ''}" placeholder="e.g., 32" step="1" data-field="facility.clearHeight" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Dock Doors</label>
        <input class="hub-input" type="number" value="${f.dockDoors || ''}" placeholder="e.g., 24" step="1" data-field="facility.dockDoors" data-type="number" />
      </div>
    </div>

    ${renderFacilityCostCard()}
  `;
}

function renderFacilityCostCard() {
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const bd = calc.facilityCostBreakdown(model.facility || {}, fr, ur);

  if (bd.total === 0 && !market) {
    return `<div class="hub-card mt-4" style="background: var(--ies-gray-50);"><p class="text-body text-muted">Select a market in Setup to see facility cost calculations.</p></div>`;
  }

  return `
    <div class="hub-card mt-4">
      <div class="text-subtitle mb-4">Annual Facility Cost Breakdown</div>
      <table class="cm-grid-table">
        <thead><tr><th>Component</th><th class="cm-num">$/PSF/Yr</th><th class="cm-num">Annual Cost</th></tr></thead>
        <tbody>
          <tr><td>Lease</td><td class="cm-num">${(fr?.lease_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.lease)}</td></tr>
          <tr><td>CAM</td><td class="cm-num">${(fr?.cam_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.cam)}</td></tr>
          <tr><td>Property Tax</td><td class="cm-num">${(fr?.tax_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.tax)}</td></tr>
          <tr><td>Insurance</td><td class="cm-num">${(fr?.insurance_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.insurance)}</td></tr>
          <tr><td>Utilities</td><td class="cm-num">${((ur?.avg_monthly_per_sqft || 0) * 12).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.utility)}</td></tr>
          <tr class="cm-total-row"><td>Total</td><td></td><td class="cm-num">${calc.formatCurrency(bd.total)}</td></tr>
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================
// SECTION 5: SHIFTS
// ============================================================

function renderShifts() {
  const s = model.shifts || {};
  const opHrs = calc.operatingHours(s);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Shift Configuration</div>
        <div class="cm-section-desc">Define operating schedule. This drives labor hours and FTE calculations.</div>
      </div>
    </div>

    <div class="cm-narrow-form">
      <div class="hub-field">
        <label class="hub-field__label">Shifts Per Day</label>
        <input class="hub-input" type="number" value="${s.shiftsPerDay || 1}" min="1" max="3" step="1" data-field="shifts.shiftsPerDay" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Hours Per Shift</label>
        <input class="hub-input" type="number" value="${s.hoursPerShift || 8}" min="4" max="12" step="0.5" data-field="shifts.hoursPerShift" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Days Per Week</label>
        <input class="hub-input" type="number" value="${s.daysPerWeek || 5}" min="1" max="7" step="1" data-field="shifts.daysPerWeek" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Weeks Per Year</label>
        <input class="hub-input" type="number" value="${s.weeksPerYear ?? 52}" min="1" max="52" step="1" data-field="shifts.weeksPerYear" data-type="number" />
      </div>
    </div>

    <div class="cm-opshours-card mt-4">
      <div class="cm-opshours-card__label">Annual Operating Hours / Person</div>
      <div class="cm-opshours-card__value">${opHrs.toLocaleString()}</div>
    </div>

    <div class="cm-narrow-form mt-4">
      <div class="hub-field">
        <label class="hub-field__label">2nd Shift Premium (%)</label>
        <input class="hub-input" type="number" value="${s.shift2Premium || 0}" step="0.5" data-field="shifts.shift2Premium" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">3rd Shift Premium (%)</label>
        <input class="hub-input" type="number" value="${s.shift3Premium || 0}" step="0.5" data-field="shifts.shift3Premium" data-type="number" />
      </div>
    </div>
  `;
}

// ============================================================
// SECTIONS 6-13: Stub renderers (will be fully built out)
// ============================================================

/**
 * Recompute annual_hours from volume and base_uph for a labor line in place.
 * Mirrors v2 behavior where picking a MOST template or editing volume/UPH
 * drives Hrs/Yr = volume / base_uph (no PFD applied — shifts handle allowance elsewhere).
 * @param {any} line
 */
function recomputeLineHours(line) {
  const v = line.volume || 0;
  const u = line.base_uph || 0;
  line.annual_hours = u > 0 ? v / u : 0;
}

// ---- MOST schema accessors -------------------------------------------------
// ref_most_templates uses activity_name / units_per_hour_base / total_tmu_base
// (not the `name`/`base_uph`/`tmu_total` v3 types.js declared). These helpers
// read both shapes so we stay robust if the schema is normalized later.
const mostTplName = (t) => t?.activity_name || t?.name || t?.wms_transaction || '';
const mostTplUph  = (t) => Number(t?.units_per_hour_base || t?.base_uph || 0);
const mostTplTmu  = (t) => Number(t?.total_tmu_base || t?.tmu_total || 0);
// ref_most_elements uses sequence_order / element_name / tmu_value
const mostElSeq  = (e) => (e?.sequence_order ?? e?.sequence ?? 0);
const mostElName = (e) => e?.element_name || e?.description || '';
const mostElTmu  = (e) => Number(e?.tmu_value || e?.tmu || 0);

/**
 * Render the per-row MOST Template picker cell (v3 port of v2 _mostSelectHtml).
 * Groups templates by process_area in canonical warehouse-flow order.
 * When a template is assigned, shows:
 *  • ⓘ info button (view template details modal)
 *  • "Override" badge + ↺ reset button when line.base_uph diverges from template.base_uph
 * @param {any} line
 * @param {number} idx
 */
/**
 * Render the Volume cell for a direct-labor row.
 * Dropdown of volumeLines (by name) + a "Custom" option for ad-hoc values.
 * Selecting a line syncs line.volume to the chosen volumeLines[].volume
 * and stores the source index in line.volume_source_idx.
 */
function renderLaborVolumeCell(line, idx) {
  const volumes = model.volumeLines || [];
  const sourceIdx = (line.volume_source_idx !== undefined && line.volume_source_idx !== null && line.volume_source_idx !== '')
    ? String(line.volume_source_idx)
    : 'custom';
  const options = volumes.map((v, vi) => {
    const label = `${v.name || ('Vol #' + (vi + 1))} (${(v.volume || 0).toLocaleString()} ${v.uom || ''})`;
    return `<option value="${vi}"${String(vi) === sourceIdx ? ' selected' : ''}>${label}</option>`;
  }).join('');
  return `
    <div style="display:flex;flex-direction:column;gap:2px;">
      <select style="width:170px;font-size:11px;" data-labor-volume-source data-idx="${idx}">
        ${options}
        <option value="custom"${sourceIdx === 'custom' ? ' selected' : ''}>— Custom —</option>
      </select>
      ${sourceIdx === 'custom'
        ? `<input type="number" value="${line.volume || 0}" style="width:170px;font-size:11px;" data-array="laborLines" data-idx="${idx}" data-field="volume" data-type="number" placeholder="Volume" />`
        : `<div style="font-size:10px;color:var(--ies-gray-400);padding-left:4px;">= ${(line.volume || 0).toLocaleString()}</div>`}
    </div>
  `;
}

function renderMostCell(line, idx) {
  const templates = (refData.mostTemplates || []).filter(t => t.is_active !== false);
  const currentId = line.most_template_id || '';
  const currentTpl = currentId
    ? templates.find(t => String(t.id) === String(currentId))
    : null;
  const tplUph = currentTpl ? mostTplUph(currentTpl) : 0;
  const isOverridden = currentTpl
    && (line.base_uph || 0) > 0
    && tplUph > 0
    && Math.abs((line.base_uph || 0) - tplUph) > 0.5;

  // Group templates by process_area
  const groups = {};
  templates.forEach(t => {
    const area = t.process_area || 'Other';
    (groups[area] = groups[area] || []).push(t);
  });
  const areaOrder = ['Receiving', 'Putaway', 'Replenishment', 'Picking', 'Packing', 'Shipping', 'Inventory', 'Returns', 'VAS'];
  const sortedAreas = areaOrder.filter(k => groups[k])
    .concat(Object.keys(groups).filter(k => !areaOrder.includes(k)).sort());

  let optionsHtml = '<option value="">— Select —</option>';
  sortedAreas.forEach(area => {
    optionsHtml += `<optgroup label="${area}">`;
    groups[area].forEach(t => {
      const selected = String(t.id) === String(currentId) ? ' selected' : '';
      let name = mostTplName(t) || `Template ${t.id}`;
      if (name.length > 32) name = name.substring(0, 30) + '…';
      optionsHtml += `<option value="${t.id}"${selected}>${name}</option>`;
    });
    optionsHtml += '</optgroup>';
  });

  const hasTemplate = !!currentTpl;
  const infoBtn = hasTemplate
    ? `<button class="cm-most-icon" data-action="view-most-template" data-idx="${idx}" data-template-id="${currentTpl.id}" title="View template details" style="background:none;border:none;cursor:pointer;padding:2px 4px;color:var(--ies-blue,#0047AB);font-size:14px;">ⓘ</button>`
    : '';
  // When the row's UPH differs from the template's default UPH, style the select
  // with an amber border instead of a separate 'OVERRIDE' chip + orange reset
  // button stacked below. Hover the select to see the template UPH; click the
  // small ↺ to reset. Single row, quieter visual.
  const resetBtn = isOverridden
    ? `<button class="cm-most-icon" data-action="reset-most-uph" data-idx="${idx}" title="Reset UPH to template default (${Math.round(tplUph)})" style="background:none;border:none;cursor:pointer;padding:2px 4px;color:#d97706;font-size:12px;font-weight:700;">↺</button>`
    : '';
  const selectStyle = isOverridden
    ? 'width:150px;font-size:11px;padding:4px 6px;border:1px solid #d97706;background:#fffbeb;'
    : 'width:150px;font-size:11px;padding:4px 6px;';
  const selectTitle = isOverridden
    ? `UPH overridden (template default: ${Math.round(tplUph)}). Click ↺ to reset.`
    : (hasTemplate ? `Template UPH: ${Math.round(tplUph)}` : 'Pick a MOST template to drive labor UPH');

  return `
    <div style="display:flex;align-items:center;gap:2px;">
      <select data-most-select data-idx="${idx}" style="${selectStyle}" title="${selectTitle}">${optionsHtml}</select>
      ${infoBtn}${resetBtn}
    </div>
  `;
}

function renderLabor() {
  if (isCmV2UiOn()) return renderLaborV2();
  return renderLaborV1();
}

function renderLaborV1() {
  const lines = model.laborLines || [];
  const opHrs = calc.operatingHours(model.shifts || {});
  const lc = model.laborCosting || (model.laborCosting = {});
  const totalDirect = lines.reduce((s, l) => s + calc.directLineAnnualSimple(l, lc), 0);
  const totalIndirect = (model.indirectLaborLines || []).reduce((s, l) => s + calc.indirectLineAnnualSimple(l, opHrs, lc), 0);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Labor</div>
        <div class="cm-section-desc">Direct labor (MOST-driven) and indirect/management labor. Cost factors below are global.</div>
      </div>
    </div>

    <!-- Labor Costing Factors — global multipliers that apply across rows -->
    <div class="hub-card mb-4" style="background:var(--ies-gray-50);">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;">
        <div class="text-subtitle" style="margin:0;">Labor Costing Factors <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;">(global)</span></div>
        <span style="font-size:11px;color:var(--ies-gray-400);">Per-row Burden% in the table below overrides Default Burden for that line.</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5, minmax(0, 1fr));gap:10px;font-size:12px;">
        <div class="cm-form-group" style="margin:0;">
          <label class="cm-form-label" title="Fringe rate applied to base wage for benefits + payroll taxes. Typical 28-35%.">Default Burden %</label>
          <input class="hub-input" type="number" min="0" max="100" step="0.5" value="${lc.defaultBurdenPct ?? 30}" data-field="laborCosting.defaultBurdenPct" data-type="number" />
        </div>
        <div class="cm-form-group" style="margin:0;">
          <label class="cm-form-label" title="Planned overtime hours as % of regular hours. Each OT hour costs 1.5x. Typical 3-8%.">Overtime %</label>
          <input class="hub-input" type="number" min="0" max="50" step="0.5" value="${lc.overtimePct ?? 5}" data-field="laborCosting.overtimePct" data-type="number" />
        </div>
        <div class="cm-form-group" style="margin:0;">
          <label class="cm-form-label" title="Health/retirement benefits as % of base wage — layered on top of Burden. Typical 12-18%.">Benefit Load %</label>
          <input class="hub-input" type="number" min="0" max="50" step="0.5" value="${lc.benefitLoadPct ?? 15}" data-field="laborCosting.benefitLoadPct" data-type="number" />
        </div>
        <div class="cm-form-group" style="margin:0;">
          <label class="cm-form-label" title="PTO days per FTE per year — reduces effective productive hours. Typical 10-20 days.">PTO Days</label>
          <input class="hub-input" type="number" min="0" max="40" step="1" value="${lc.ptoDays ?? 12}" data-field="laborCosting.ptoDays" data-type="number" />
        </div>
        <div class="cm-form-group" style="margin:0;">
          <label class="cm-form-label" title="Annual % of workforce requiring replacement — drives recruiting/onboarding cost. 3PL warehouses typically see 40-80%.">Turnover %</label>
          <input class="hub-input" type="number" min="0" max="150" step="1" value="${lc.turnoverPct ?? 45}" data-field="laborCosting.turnoverPct" data-type="number" />
        </div>
      </div>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-indirect">Auto-Generate Indirect Labor</button>
    </div>

    <div class="text-subtitle mb-2">Direct Labor <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;">— Volume from Volumes tab · MHE and IT/Device separate · Burden % set in Labor Costing Factors above</span></div>
    <table class="cm-grid-table">
      <thead>
        <tr><th style="min-width:180px;">MOST Template</th><th>Activity</th><th>MHE</th><th>IT / Device</th><th>Volume</th><th>UPH</th><th>Hrs/Yr</th><th>FTE</th><th>Rate</th><th>Employment</th><th>Markup %</th><th title="Productivity variance for Monte Carlo sensitivity">Var %</th><th class="cm-num">Annual Cost</th><th title="Monthly OT/absence seasonality">Seasonality</th><th></th></tr>
      </thead>
      <tbody>
        ${lines.map((l, i) => `
          <tr>
            <td>${renderMostCell(l, i)}</td>
            <td><input value="${l.activity_name || ''}" style="width:110px;" data-array="laborLines" data-idx="${i}" data-field="activity_name" /></td>
            <td>
              <select style="width:95px;font-size:11px;" data-array="laborLines" data-idx="${i}" data-field="mhe_type" title="Material handling equipment (MHE) assigned to this activity">
                <option value=""${!l.mhe_type && !['reach_truck','sit_down_forklift','stand_up_forklift','order_picker','walkie_rider','pallet_jack','electric_pallet_jack','turret_truck','amr','conveyor','manual'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
                <option value="reach_truck"${(l.mhe_type === 'reach_truck' || l.equipment_type === 'reach_truck') ? ' selected' : ''}>Reach Truck</option>
                <option value="sit_down_forklift"${(l.mhe_type === 'sit_down_forklift' || l.equipment_type === 'sit_down_forklift') ? ' selected' : ''}>Sit-Down FL</option>
                <option value="stand_up_forklift"${(l.mhe_type === 'stand_up_forklift' || l.equipment_type === 'stand_up_forklift') ? ' selected' : ''}>Stand-Up FL</option>
                <option value="order_picker"${(l.mhe_type === 'order_picker' || l.equipment_type === 'order_picker') ? ' selected' : ''}>Order Picker</option>
                <option value="walkie_rider"${(l.mhe_type === 'walkie_rider' || l.equipment_type === 'walkie_rider') ? ' selected' : ''}>Walkie Rider</option>
                <option value="pallet_jack"${(l.mhe_type === 'pallet_jack' || l.equipment_type === 'pallet_jack') ? ' selected' : ''}>Pallet Jack</option>
                <option value="electric_pallet_jack"${(l.mhe_type === 'electric_pallet_jack' || l.equipment_type === 'electric_pallet_jack') ? ' selected' : ''}>Elec Pallet Jack</option>
                <option value="turret_truck"${(l.mhe_type === 'turret_truck' || l.equipment_type === 'turret_truck') ? ' selected' : ''}>Turret Truck</option>
                <option value="amr"${(l.mhe_type === 'amr' || l.equipment_type === 'amr') ? ' selected' : ''}>AMR/Robot</option>
                <option value="conveyor"${(l.mhe_type === 'conveyor' || l.equipment_type === 'conveyor') ? ' selected' : ''}>Conveyor</option>
                <option value="manual"${(l.mhe_type === 'manual' || l.equipment_type === 'manual') ? ' selected' : ''}>Manual / Walk</option>
              </select>
            </td>
            <td>
              <select style="width:95px;font-size:11px;" data-array="laborLines" data-idx="${i}" data-field="it_device" title="IT / scanning device assigned to this activity">
                <option value=""${!l.it_device && !['rf_scanner','voice_pick'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
                <option value="rf_scanner"${(l.it_device === 'rf_scanner' || l.equipment_type === 'rf_scanner') ? ' selected' : ''}>RF Scanner</option>
                <option value="voice_pick"${(l.it_device === 'voice_pick' || l.equipment_type === 'voice_pick') ? ' selected' : ''}>Voice Pick</option>
                <option value="wearable"${l.it_device === 'wearable' ? ' selected' : ''}>Wearable</option>
                <option value="tablet"${l.it_device === 'tablet' ? ' selected' : ''}>Tablet</option>
                <option value="vision_system"${l.it_device === 'vision_system' ? ' selected' : ''}>Vision System</option>
                <option value="pick_to_light"${l.it_device === 'pick_to_light' ? ' selected' : ''}>Pick-to-Light</option>
                <option value="pick_to_display"${l.it_device === 'pick_to_display' ? ' selected' : ''}>Pick-to-Display</option>
              </select>
            </td>
            <td>${renderLaborVolumeCell(l, i)}</td>
            <td><input type="number" value="${l.base_uph || 0}" style="width:55px;" data-array="laborLines" data-idx="${i}" data-field="base_uph" data-type="number" /></td>
            <td class="cm-num">${(l.annual_hours || 0).toLocaleString(undefined, {maximumFractionDigits:0})}</td>
            <td class="cm-num">${calc.fte(l, opHrs).toFixed(1)}</td>
            <td><input type="number" value="${l.hourly_rate || 0}" style="width:55px;" step="0.5" data-array="laborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
            <td>
              <select style="width:110px;" data-array="laborLines" data-idx="${i}" data-field="employment_type">
                <option value="permanent"${(l.employment_type || 'permanent') === 'permanent' ? ' selected' : ''}>Permanent</option>
                <option value="temp_agency"${l.employment_type === 'temp_agency' ? ' selected' : ''}>Temp Agency</option>
                <option value="contractor"${l.employment_type === 'contractor' ? ' selected' : ''}>Contractor</option>
              </select>
            </td>
            <td>
              <input type="number" value="${l.temp_agency_markup_pct || 0}" style="width:55px;" step="1" min="0" max="100"
                data-array="laborLines" data-idx="${i}" data-field="temp_agency_markup_pct" data-type="number"
                ${(l.employment_type || 'permanent') !== 'temp_agency' ? 'disabled title="Only applies to Temp Agency lines"' : ''} />
            </td>
            <td>
              <input type="number" value="${l.performance_variance_pct || 0}" style="width:50px;" step="1" min="0" max="50"
                data-array="laborLines" data-idx="${i}" data-field="performance_variance_pct" data-type="number"
                title="Productivity variance (% std dev) for the Monte Carlo sensitivity card" />
            </td>
            <td class="cm-num">${calc.formatCurrency(calc.directLineAnnualSimple(l, lc))}</td>
            <td>
              <button class="hub-btn" style="padding:2px 6px;font-size:11px;" data-cm-action="edit-labor-seasonality" data-idx="${i}" title="Edit monthly OT/absence seasonality">
                ${(Array.isArray(l.monthly_overtime_profile) || Array.isArray(l.monthly_absence_profile)) ? '📊*' : '📊'}
              </button>
            </td>
            <td><button class="cm-delete-btn" data-action="delete-labor" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="13">Total Direct Labor</td><td class="cm-num">${calc.formatCurrency(totalDirect)}</td><td colspan="2"></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-labor">+ Add Labor Line</button>

    <div class="text-subtitle mb-2 mt-6">Indirect Labor <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;">— Burden % set in Labor Costing Factors above</span></div>
    <table class="cm-grid-table">
      <thead>
        <tr><th>Role</th><th>Headcount</th><th>Rate</th><th class="cm-num">Annual Cost</th><th></th></tr>
      </thead>
      <tbody>
        ${(model.indirectLaborLines || []).map((l, i) => `
          <tr>
            <td><input value="${l.role_name || ''}" style="width:140px;" data-array="indirectLaborLines" data-idx="${i}" data-field="role_name" /></td>
            <td><input type="number" value="${l.headcount || 0}" style="width:50px;" data-array="indirectLaborLines" data-idx="${i}" data-field="headcount" data-type="number" /></td>
            <td><input type="number" value="${l.hourly_rate || 0}" style="width:60px;" step="0.5" data-array="indirectLaborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
            <td class="cm-num">${calc.formatCurrency(calc.indirectLineAnnualSimple(l, opHrs, lc))}</td>
            <td><button class="cm-delete-btn" data-action="delete-indirect" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="3">Total Indirect Labor</td><td class="cm-num">${calc.formatCurrency(totalIndirect)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-indirect">+ Add Indirect Line</button>
  `;
}

// ============================================================
// v2 LABOR — master-detail layout
// ============================================================

/**
 * Short, human labels for employment types used in the compact master list.
 */
const EMPLOYMENT_CHIP = {
  permanent: { label: 'Permanent', variant: 'brand' },
  temp_agency: { label: 'Temp', variant: 'warn' },
  contractor: { label: 'Contractor', variant: 'info' },
};

function renderLaborV2() {
  const lines = model.laborLines || [];
  const opHrs = calc.operatingHours(model.shifts || {});
  const lc = model.laborCosting || (model.laborCosting = {});
  const totalDirect = lines.reduce((s, l) => s + calc.directLineAnnualSimple(l, lc), 0);
  const totalIndirect = (model.indirectLaborLines || []).reduce((s, l) => s + calc.indirectLineAnnualSimple(l, opHrs, lc), 0);
  const totalFtes = lines.reduce((s, l) => s + calc.fte(l, opHrs), 0);

  // Selected index — clamp and default sensibly
  if (lines.length === 0) _selectedLaborIdx = null;
  else if (_selectedLaborIdx === null || _selectedLaborIdx === undefined || _selectedLaborIdx >= lines.length) {
    _selectedLaborIdx = 0;
  }

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Labor</div>
        <div class="cm-section-desc">Direct labor (MOST-driven) + indirect/management labor. Cost factors apply across all rows.</div>
      </div>
    </div>

    ${renderLaborCostingFactorsV2(lc)}
    ${renderLaborKpiStripV2(lines.length, totalFtes, totalDirect, totalIndirect)}

    <!-- Master-detail for Direct Labor -->
    <div style="margin-top:24px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;">
        <div>
          <h3 class="hub-section-heading" style="margin:0;">Direct Labor</h3>
          <div class="hub-field__hint">Volume sourced from Volumes tab · MOST template drives UPH</div>
        </div>
      </div>

      <div class="hub-master-detail">
        ${renderLaborMasterPane(lines, opHrs, lc)}
        ${renderLaborDetailPane(lines, opHrs, lc)}
      </div>
    </div>

    <!-- Indirect Labor — keeps the dense table, which fits fine at 4 columns -->
    <div style="margin-top:28px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;">
        <div>
          <h3 class="hub-section-heading" style="margin:0;">Indirect / Management Labor</h3>
          <div class="hub-field__hint">Burden % set in Labor Costing Factors above</div>
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-indirect">↺ Auto-Generate</button>
      </div>

      <div class="hub-card" style="padding:0;overflow:hidden;">
        <table class="hub-datatable hub-datatable--dense">
          <thead>
            <tr>
              <th>Role</th>
              <th class="hub-num" style="width:90px;">HC</th>
              <th class="hub-num" style="width:80px;">Rate</th>
              <th style="width:180px;">Pricing Bucket</th>
              <th class="hub-num" style="width:130px;">Annual Cost</th>
              <th style="width:44px;"></th>
            </tr>
          </thead>
          <tbody>
            ${(model.indirectLaborLines || []).map((l, i) => {
              const buckets = model.pricingBuckets || [];
              return `
              <tr>
                <td><input class="hub-input" value="${escapeAttr(l.role_name || '')}" data-array="indirectLaborLines" data-idx="${i}" data-field="role_name" /></td>
                <td><input class="hub-input hub-num" type="number" value="${l.headcount || 0}" data-array="indirectLaborLines" data-idx="${i}" data-field="headcount" data-type="number" /></td>
                <td><input class="hub-input hub-num" type="number" step="0.5" value="${l.hourly_rate || 0}" data-array="indirectLaborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
                <td>
                  ${buckets.length === 0
                    ? `<span class="hub-chip hub-chip--danger">no buckets</span>`
                    : `<select class="hub-input" data-array="indirectLaborLines" data-idx="${i}" data-field="pricing_bucket">
                        <option value=""${!l.pricing_bucket ? ' selected' : ''}>— Unassigned —</option>
                        ${buckets.map(b => `<option value="${escapeAttr(b.id)}"${l.pricing_bucket === b.id ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
                       </select>`}
                </td>
                <td class="hub-num" style="font-weight:600;">${calc.formatCurrency(calc.indirectLineAnnualSimple(l, opHrs, lc))}</td>
                <td><button class="cm-delete-btn" data-action="delete-indirect" data-idx="${i}" aria-label="Delete">×</button></td>
              </tr>
            `;
            }).join('')}
            ${(model.indirectLaborLines || []).length === 0
              ? `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No indirect labor yet. Click <strong>Auto-Generate</strong> above, or add a role manually.</td></tr>`
              : ''}
          </tbody>
          ${(model.indirectLaborLines || []).length > 0 ? `
            <tfoot>
              <tr style="background:var(--ies-gray-50);font-weight:700;">
                <td colspan="4" style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ies-gray-600);">Total Indirect</td>
                <td class="hub-num" style="padding:10px 12px;">${calc.formatCurrency(totalIndirect)}</td>
                <td></td>
              </tr>
            </tfoot>` : ''}
        </table>
      </div>
      <div style="margin-top:8px;"><button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="add-indirect">+ Add Indirect Role</button></div>
    </div>
  `;
}

function renderLaborCostingFactorsV2(lc) {
  return `
    <div class="hub-card" style="padding:16px 20px;background:var(--ies-gray-50);">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;gap:12px;">
        <h3 class="hub-section-heading" style="margin:0;">Global Costing Factors</h3>
        <span class="hub-field__hint">Applied across every line. Per-line overrides live in each row's detail pane.</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5, minmax(0, 1fr));gap:16px;">
        <div class="hub-field">
          <label class="hub-field__label" title="Fringe rate applied to base wage for benefits + payroll taxes. Typical 28-35%.">Burden %</label>
          <input class="hub-input hub-num" type="number" min="0" max="100" step="0.5" value="${lc.defaultBurdenPct ?? 30}" data-field="laborCosting.defaultBurdenPct" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Planned overtime hours as % of regular hours. Each OT hour costs 1.5x. Typical 3-8%.">Overtime %</label>
          <input class="hub-input hub-num" type="number" min="0" max="50" step="0.5" value="${lc.overtimePct ?? 5}" data-field="laborCosting.overtimePct" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Health/retirement benefits as % of base wage — layered on top of Burden. Typical 12-18%.">Benefits %</label>
          <input class="hub-input hub-num" type="number" min="0" max="50" step="0.5" value="${lc.benefitLoadPct ?? 15}" data-field="laborCosting.benefitLoadPct" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="PTO days per FTE per year — reduces effective productive hours. Typical 10-20 days.">PTO Days</label>
          <input class="hub-input hub-num" type="number" min="0" max="40" step="1" value="${lc.ptoDays ?? 12}" data-field="laborCosting.ptoDays" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Annual % of workforce requiring replacement. 3PL warehouses typically see 40-80%.">Turnover %</label>
          <input class="hub-input hub-num" type="number" min="0" max="150" step="1" value="${lc.turnoverPct ?? 45}" data-field="laborCosting.turnoverPct" data-type="number" />
        </div>
      </div>
    </div>
  `;
}

function renderLaborKpiStripV2(lineCount, totalFtes, totalDirect, totalIndirect) {
  return `
    <div class="hub-kpi-strip" style="margin-top:12px;">
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Direct Lines</div>
        <div class="hub-kpi-tile__value">${lineCount}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Total Direct FTEs</div>
        <div class="hub-kpi-tile__value">${totalFtes.toFixed(1)}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Direct Annual $</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">${calc.formatCurrency(totalDirect)}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Indirect Annual $</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">${calc.formatCurrency(totalIndirect)}</div>
      </div>
    </div>
  `;
}

function renderLaborMasterPane(lines, opHrs, lc) {
  return `
    <div class="hub-master-detail__master">
      <div class="hub-master-detail__master-header">
        <span>Lines (${lines.length})</span>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="add-labor" title="Add a new direct labor line">+ Add</button>
      </div>
      <div class="hub-master-detail__master-body">
        ${lines.length === 0
          ? `<div class="hub-master-detail__empty"><div style="font-size:28px;margin-bottom:8px;">👥</div>No direct labor lines yet.<br/><span style="color:var(--ies-gray-500);">Click <strong>+ Add</strong> to create one.</span></div>`
          : lines.map((l, i) => renderLaborMasterItem(l, i, opHrs, lc)).join('')}
      </div>
    </div>
  `;
}

function renderLaborMasterItem(l, i, opHrs, lc) {
  const selected = i === _selectedLaborIdx;
  const emp = EMPLOYMENT_CHIP[l.employment_type || 'permanent'] || EMPLOYMENT_CHIP.permanent;
  const fte = calc.fte(l, opHrs);
  const annualCost = calc.directLineAnnualSimple(l, lc);
  const activityLabel = l.activity_name || '(unnamed activity)';
  const hasSeasonality = Array.isArray(l.monthly_overtime_profile) || Array.isArray(l.monthly_absence_profile);
  const hasVariance = (l.performance_variance_pct || 0) > 0;

  // Bucket chip — shows which pricing bucket this line feeds
  const bucket = (model.pricingBuckets || []).find(b => b.id === l.pricing_bucket);
  const bucketChip = bucket
    ? `<span class="hub-chip hub-chip--neutral" title="Routes to pricing bucket: ${escapeAttr(bucket.name)}">📦 ${escapeHtml(bucket.name)}</span>`
    : `<span class="hub-chip hub-chip--danger" title="No pricing bucket assigned — this line's cost will orphan to Management Fee">⚠ no bucket</span>`;

  return `
    <div class="hub-master-detail__item${selected ? ' is-selected' : ''}" data-labor-select="${i}" title="Click to edit">
      <div class="hub-master-detail__item-primary">
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(activityLabel)}</span>
        <span class="hub-master-detail__item-value">${calc.formatCurrency(annualCost)}</span>
      </div>
      <div class="hub-master-detail__item-secondary">
        <span class="hub-chip hub-chip--${emp.variant}">${emp.label}</span>
        ${bucketChip}
        <span>${fte.toFixed(1)} FTE · ${(l.base_uph || 0).toLocaleString()} UPH</span>
        ${hasSeasonality ? `<span class="hub-chip hub-chip--info" title="Has monthly OT/absence seasonality">📊</span>` : ''}
        ${hasVariance ? `<span class="hub-chip hub-chip--warn" title="Variance ±${l.performance_variance_pct}%">±${l.performance_variance_pct}%</span>` : ''}
      </div>
    </div>
  `;
}

function renderLaborDetailPane(lines, opHrs, lc) {
  if (lines.length === 0) {
    return `
      <div class="hub-master-detail__detail">
        <div class="hub-master-detail__empty">
          <div style="font-size:14px;color:var(--ies-gray-600);margin-bottom:6px;">Nothing to edit yet.</div>
          Add a line from the panel on the left to start defining direct labor.
        </div>
      </div>
    `;
  }
  const i = _selectedLaborIdx;
  const l = lines[i];
  if (!l) return `<div class="hub-master-detail__detail"><div class="hub-master-detail__empty">Select a line on the left to edit.</div></div>`;

  const hourly = l.hourly_rate || 0;
  const fte = calc.fte(l, opHrs);
  const annualCost = calc.directLineAnnualSimple(l, lc);
  const empType = l.employment_type || 'permanent';
  const isTemp = empType === 'temp_agency';

  const buckets = model.pricingBuckets || [];

  return `
    <div class="hub-master-detail__detail">
      <div class="hub-master-detail__detail-header">
        <h3 class="hub-master-detail__detail-title">${escapeHtml(l.activity_name || `Line ${i + 1}`)}</h3>
        <div style="display:flex;gap:6px;">
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-cm-action="edit-labor-seasonality" data-idx="${i}" title="Edit monthly OT/absence seasonality">📊 Seasonality</button>
          <button class="cm-delete-btn" data-action="delete-labor" data-idx="${i}" title="Delete this line">Delete</button>
        </div>
      </div>

      <!-- Group 1: Activity + MOST (2-col) -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Activity</h4>
        <div class="hub-detail-grid hub-detail-grid--2col">
          <div class="hub-field">
            <label class="hub-field__label">Activity Name</label>
            <input class="hub-input" value="${escapeAttr(l.activity_name || '')}" data-array="laborLines" data-idx="${i}" data-field="activity_name" placeholder="e.g. Pick — case"/>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">MOST Template</label>
            ${renderMostCell(l, i)}
          </div>
        </div>
      </div>

      <!-- Group 2: Volume + UPH (4-col) -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Volume &amp; Productivity</h4>
        <div class="hub-detail-grid hub-detail-grid--4col">
          <div class="hub-field">
            <label class="hub-field__label">Volume Source</label>
            ${renderLaborVolumeCell(l, i)}
          </div>
          <div class="hub-field">
            <label class="hub-field__label">UPH</label>
            <input class="hub-input hub-num" type="number" step="1" value="${l.base_uph || 0}" data-array="laborLines" data-idx="${i}" data-field="base_uph" data-type="number" />
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Annual Hours</label>
            <div class="hub-detail-readonly">${(l.annual_hours || 0).toLocaleString(undefined, {maximumFractionDigits:0})}</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">FTEs</label>
            <div class="hub-detail-readonly">${fte.toFixed(2)}</div>
          </div>
        </div>
      </div>

      <!-- Group 3: Equipment (2-col) -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Equipment Assigned</h4>
        <div class="hub-detail-grid hub-detail-grid--2col">
          <div class="hub-field">
            <label class="hub-field__label">MHE</label>
            <select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="mhe_type" title="Material-handling equipment">
              <option value=""${!l.mhe_type && !['reach_truck','sit_down_forklift','stand_up_forklift','order_picker','walkie_rider','pallet_jack','electric_pallet_jack','turret_truck','amr','conveyor','manual'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
              <option value="reach_truck"${(l.mhe_type === 'reach_truck' || l.equipment_type === 'reach_truck') ? ' selected' : ''}>Reach Truck</option>
              <option value="sit_down_forklift"${(l.mhe_type === 'sit_down_forklift' || l.equipment_type === 'sit_down_forklift') ? ' selected' : ''}>Sit-Down FL</option>
              <option value="stand_up_forklift"${(l.mhe_type === 'stand_up_forklift' || l.equipment_type === 'stand_up_forklift') ? ' selected' : ''}>Stand-Up FL</option>
              <option value="order_picker"${(l.mhe_type === 'order_picker' || l.equipment_type === 'order_picker') ? ' selected' : ''}>Order Picker</option>
              <option value="walkie_rider"${(l.mhe_type === 'walkie_rider' || l.equipment_type === 'walkie_rider') ? ' selected' : ''}>Walkie Rider</option>
              <option value="pallet_jack"${(l.mhe_type === 'pallet_jack' || l.equipment_type === 'pallet_jack') ? ' selected' : ''}>Pallet Jack</option>
              <option value="electric_pallet_jack"${(l.mhe_type === 'electric_pallet_jack' || l.equipment_type === 'electric_pallet_jack') ? ' selected' : ''}>Elec Pallet Jack</option>
              <option value="turret_truck"${(l.mhe_type === 'turret_truck' || l.equipment_type === 'turret_truck') ? ' selected' : ''}>Turret Truck</option>
              <option value="amr"${(l.mhe_type === 'amr' || l.equipment_type === 'amr') ? ' selected' : ''}>AMR / Robot</option>
              <option value="conveyor"${(l.mhe_type === 'conveyor' || l.equipment_type === 'conveyor') ? ' selected' : ''}>Conveyor</option>
              <option value="manual"${(l.mhe_type === 'manual' || l.equipment_type === 'manual') ? ' selected' : ''}>Manual / Walk</option>
            </select>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">IT / Device</label>
            <select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="it_device" title="IT / scanning device">
              <option value=""${!l.it_device && !['rf_scanner','voice_pick'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
              <option value="rf_scanner"${(l.it_device === 'rf_scanner' || l.equipment_type === 'rf_scanner') ? ' selected' : ''}>RF Scanner</option>
              <option value="voice_pick"${(l.it_device === 'voice_pick' || l.equipment_type === 'voice_pick') ? ' selected' : ''}>Voice Pick</option>
              <option value="wearable"${l.it_device === 'wearable' ? ' selected' : ''}>Wearable</option>
              <option value="tablet"${l.it_device === 'tablet' ? ' selected' : ''}>Tablet</option>
              <option value="vision_system"${l.it_device === 'vision_system' ? ' selected' : ''}>Vision System</option>
              <option value="pick_to_light"${l.it_device === 'pick_to_light' ? ' selected' : ''}>Pick-to-Light</option>
              <option value="pick_to_display"${l.it_device === 'pick_to_display' ? ' selected' : ''}>Pick-to-Display</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Group 4: Rate & Employment (4-col) -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Rate &amp; Employment</h4>
        <div class="hub-detail-grid hub-detail-grid--4col">
          <div class="hub-field">
            <label class="hub-field__label">Base Hourly Rate</label>
            <input class="hub-input hub-num" type="number" step="0.25" min="0" value="${hourly}" data-array="laborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" />
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Employment Type</label>
            <select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="employment_type">
              <option value="permanent"${empType === 'permanent' ? ' selected' : ''}>Permanent</option>
              <option value="temp_agency"${empType === 'temp_agency' ? ' selected' : ''}>Temp Agency</option>
              <option value="contractor"${empType === 'contractor' ? ' selected' : ''}>Contractor</option>
            </select>
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Agency markup over base wage. Only applies to Temp Agency lines.">Temp Markup %</label>
            <input class="hub-input hub-num" type="number" step="1" min="0" max="100" value="${l.temp_agency_markup_pct || 0}" data-array="laborLines" data-idx="${i}" data-field="temp_agency_markup_pct" data-type="number" ${!isTemp ? 'disabled' : ''} />
            ${!isTemp ? '<div class="hub-field__hint">(Temp Agency only)</div>' : ''}
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Productivity variance (% std dev) fed into the Monte Carlo sensitivity card in Summary.">Variance %</label>
            <input class="hub-input hub-num" type="number" step="1" min="0" max="50" value="${l.performance_variance_pct || 0}" data-array="laborLines" data-idx="${i}" data-field="performance_variance_pct" data-type="number" />
            <div class="hub-field__hint">Monte Carlo σ</div>
          </div>
        </div>
      </div>

      <!-- Group 5: Pricing Bucket (2-col) — the restored field -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Cost Routing</h4>
        <div class="hub-detail-grid hub-detail-grid--2col">
          <div class="hub-field">
            <label class="hub-field__label" title="Which pricing bucket this line's cost flows into. Defined in Structure → Pricing Buckets.">Pricing Bucket</label>
            ${buckets.length === 0
              ? `<div class="hub-field__error">No buckets defined. <button class="hub-btn hub-btn-secondary hub-btn-sm" data-cm-action="jump-to-buckets" style="padding:2px 8px;font-size:11px;margin-left:6px;">Open Buckets →</button></div>`
              : `<select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="pricing_bucket">
                   <option value=""${!l.pricing_bucket ? ' selected' : ''}>— Unassigned —</option>
                   ${buckets.map(b => `<option value="${escapeAttr(b.id)}"${l.pricing_bucket === b.id ? ' selected' : ''}>${escapeHtml(b.name)} (${b.type}/${b.uom})</option>`).join('')}
                 </select>`}
          </div>
          <div class="hub-field" style="align-self:flex-end;">
            ${l.pricing_bucket
              ? `<div class="hub-field__hint">Cost flows to rate card as part of the <strong>${escapeHtml((buckets.find(b => b.id === l.pricing_bucket) || {}).name || '')}</strong> bucket.</div>`
              : `<div class="hub-field__error">⚠ Unassigned costs are rolled into Management Fee. Pick a bucket above.</div>`}
          </div>
        </div>
      </div>

      <!-- Group 6: Calculated output (read-only callout) -->
      <div class="hub-detail-group hub-detail-readout" style="background:var(--ies-gray-50);padding:16px 18px;border-radius:10px;margin:0;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;">
          <div>
            <div class="hub-field__label" style="margin-bottom:4px;">Annual Cost (loaded)</div>
            <div style="font-size:20px;font-weight:800;color:var(--ies-blue);line-height:1.1;">${calc.formatCurrency(annualCost)}</div>
          </div>
          <div style="text-align:right;font-size:12px;color:var(--ies-gray-500);line-height:1.5;">
            <div>${fte.toFixed(2)} FTE · ${(l.annual_hours || 0).toLocaleString(undefined, {maximumFractionDigits:0})} hrs/yr</div>
            <div>Base rate $${hourly.toFixed(2)}/hr · burden applied</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/** Safe attribute-value escape (quotes + basic). */
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderEquipment() {
  const lines = model.equipmentLines || [];
  const total = calc.totalEquipmentCost(lines);
  const capital = calc.totalEquipmentCapital(lines);
  const lineCount = lines.length;
  const mheCount = lines.filter(l => l.category === 'MHE').reduce((s, l) => s + (parseInt(l.quantity) || 1), 0);
  const rackCount = lines.filter(l => l.category === 'Racking').length;

  // Equipment uses a table rather than master-detail because each row has
  // few enough fields to fit a dense grid legibly. Migrated to hub-datatable
  // primitives + KPI strip summary on top.
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Equipment</div>
        <div class="cm-section-desc">MHE, IT, racking, dock, and infrastructure equipment. Toggle lease vs purchase per line.</div>
      </div>
    </div>

    <!-- KPI strip — at-a-glance summary (primitives kit) -->
    ${lineCount > 0 ? `
      <div class="hub-kpi-strip mb-4">
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Lines</div>
          <div class="hub-kpi-tile__value">${lineCount}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">MHE Units</div>
          <div class="hub-kpi-tile__value">${mheCount}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Annual Operating</div>
          <div class="hub-kpi-tile__value">${calc.formatCurrency(total, {compact: true})}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Capital</div>
          <div class="hub-kpi-tile__value">${calc.formatCurrency(capital, {compact: true})}</div>
        </div>
      </div>
    ` : ''}

    <div class="cm-section-toolbar">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-equipment"
              title="Generates a starting equipment list from your current volumes + labor + facility sqft. Rules:
• MHE — Reach Trucks (1 per 3 FTEs × 1.15 spare) + Order Pickers (1 per 5 FTEs)
• IT — RF Terminals (30% of FTEs), Label Printers (1 per 50 HC), WiFi APs (1 per 10K sqft)
• Racking — Selective Pallet Rack sized to avg pallets on-hand + 15% buffer (assumes 12 turns/yr)
• Dock — Hydraulic Levelers sized at 90 daily pallets per door
• Charging — 1 station per 6 electric forklifts
• Office — Build-out (120 sqft per indirect HC) + Break Room (15 sqft per total HC)
• Security — 1 camera system per 30K sqft (for ≥50K sqft facilities) + Access Control
• Conveyor — Belt conveyor linear ft (for ≥500K orders/yr)
All lines are editable after generation.">⚡ Auto-Generate Equipment</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="open-equipment-catalog" title="Browse the GXO equipment reference catalog (33 items with specs, pricing, vendors)">📖 Browse Catalog</button>
      <span class="cm-section-toolbar__hint">Covers MHE · IT · Racking · Dock · Charging · Office · Security · Conveyor. Hover Auto-Generate for sizing rules.</span>
    </div>

    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense">
        <thead>
          <tr>
            <th>Equipment</th>
            <th>Category</th>
            <th class="hub-num">Qty</th>
            <th>Type</th>
            <th class="hub-num">$ / Mo</th>
            <th class="hub-num">Acq Cost</th>
            <th class="hub-num">Maint / Mo</th>
            <th class="hub-num">Amort Yrs</th>
            <th class="hub-num">Annual</th>
            <th class="cm-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => `
            <tr>
              <td><input class="hub-input" value="${l.equipment_name || ''}" data-array="equipmentLines" data-idx="${i}" data-field="equipment_name" /></td>
              <td>
                <select class="hub-input" data-array="equipmentLines" data-idx="${i}" data-field="category">
                  ${['MHE', 'IT', 'Racking', 'Dock', 'Charging', 'Office', 'Security', 'Conveyor'].map(c =>
                    `<option value="${c}"${l.category === c ? ' selected' : ''}>${c}</option>`
                  ).join('')}
                </select>
              </td>
              <td><input class="hub-input hub-num" type="number" value="${l.quantity || 1}" data-array="equipmentLines" data-idx="${i}" data-field="quantity" data-type="number" /></td>
              <td>
                <select class="hub-input" data-array="equipmentLines" data-idx="${i}" data-field="acquisition_type">
                  <option value="lease"${(l.acquisition_type || 'lease') === 'lease' ? ' selected' : ''}>Lease</option>
                  <option value="purchase"${l.acquisition_type === 'purchase' ? ' selected' : ''}>Purchase</option>
                  <option value="service"${l.acquisition_type === 'service' ? ' selected' : ''}>Service</option>
                </select>
              </td>
              <td><input class="hub-input hub-num" type="number" value="${l.monthly_cost || 0}" data-array="equipmentLines" data-idx="${i}" data-field="monthly_cost" data-type="number" /></td>
              <td><input class="hub-input hub-num" type="number" value="${l.acquisition_cost || 0}" data-array="equipmentLines" data-idx="${i}" data-field="acquisition_cost" data-type="number" /></td>
              <td><input class="hub-input hub-num" type="number" value="${l.monthly_maintenance || 0}" data-array="equipmentLines" data-idx="${i}" data-field="monthly_maintenance" data-type="number" /></td>
              <td><input class="hub-input hub-num" type="number" value="${l.amort_years || 5}" data-array="equipmentLines" data-idx="${i}" data-field="amort_years" data-type="number" /></td>
              <td class="hub-num">${calc.formatCurrency(calc.equipLineTableCost(l))}</td>
              <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-equipment" data-idx="${i}" title="Delete row">×</button></td>
            </tr>
          `).join('')}
          ${lineCount === 0 ? `
            <tr><td colspan="10" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No equipment lines yet. Click Auto-Generate Equipment or Add Equipment Line to start.</td></tr>
          ` : ''}
          <tr class="cm-total-row"><td colspan="8">Operating Cost</td><td class="hub-num">${calc.formatCurrency(total)}</td><td></td></tr>
          <tr><td colspan="8" style="font-weight:600; color: var(--ies-gray-500);">Capital Investment</td><td class="hub-num" style="font-weight:600;">${calc.formatCurrency(capital)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <button class="cm-add-row-btn" data-action="add-equipment">+ Add Equipment Line</button>
  `;
}

function renderOverhead() {
  const lines = model.overheadLines || [];
  const total = calc.totalOverheadCost(lines);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Overhead</div>
        <div class="cm-section-desc">Facility overhead, IT, insurance, and administrative costs.</div>
      </div>
    </div>

    <div class="cm-section-toolbar">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-overhead">⚡ Auto-Generate Overhead</button>
      <span class="cm-section-toolbar__hint">One-click seed from facility sqft + headcount. All rows editable.</span>
    </div>

    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense">
        <thead>
          <tr>
            <th style="width:22%;">Category</th>
            <th style="width:36%;">Description</th>
            <th style="width:14%;">Cost Type</th>
            <th style="width:14%;">Amount</th>
            <th class="hub-num" style="width:12%;">Annual</th>
            <th class="cm-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => `
            <tr>
              <td><input class="hub-input" value="${l.category || ''}" data-array="overheadLines" data-idx="${i}" data-field="category" /></td>
              <td><input class="hub-input" value="${l.description || ''}" data-array="overheadLines" data-idx="${i}" data-field="description" /></td>
              <td>
                <select class="hub-input" data-array="overheadLines" data-idx="${i}" data-field="cost_type">
                  <option value="monthly"${l.cost_type === 'monthly' ? ' selected' : ''}>Monthly</option>
                  <option value="annual"${l.cost_type === 'annual' ? ' selected' : ''}>Annual</option>
                </select>
              </td>
              <td><input class="hub-input hub-num" type="number" value="${l.cost_type === 'monthly' ? (l.monthly_cost || 0) : (l.annual_cost || 0)}" data-array="overheadLines" data-idx="${i}" data-field="${l.cost_type === 'monthly' ? 'monthly_cost' : 'annual_cost'}" data-type="number" /></td>
              <td class="hub-num">${calc.formatCurrency(calc.overheadLineAnnual(l))}</td>
              <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-overhead" data-idx="${i}" title="Delete row">×</button></td>
            </tr>
          `).join('')}
          ${lines.length === 0 ? `
            <tr><td colspan="6" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No overhead lines yet. Click Auto-Generate or Add Overhead Line.</td></tr>
          ` : ''}
          <tr class="cm-total-row"><td colspan="4">Total Overhead</td><td class="hub-num">${calc.formatCurrency(total)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <button class="cm-add-row-btn" data-action="add-overhead">+ Add Overhead Line</button>
  `;
}

function renderVas() {
  const lines = model.vasLines || [];
  const total = calc.totalVasCost(lines);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Value-Added Services</div>
        <div class="cm-section-desc">Kitting, labeling, special packaging, and other VAS line items.</div>
      </div>
    </div>
    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense">
        <thead>
          <tr>
            <th style="width:42%;">Service</th>
            <th style="width:18%;">Rate</th>
            <th style="width:20%;">Volume</th>
            <th class="hub-num" style="width:18%;">Annual Cost</th>
            <th class="cm-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => `
            <tr>
              <td><input class="hub-input" value="${l.service || ''}" data-array="vasLines" data-idx="${i}" data-field="service" /></td>
              <td><input class="hub-input hub-num" type="number" value="${l.rate || 0}" step="0.01" data-array="vasLines" data-idx="${i}" data-field="rate" data-type="number" /></td>
              <td><input class="hub-input hub-num" type="number" value="${l.volume || 0}" data-array="vasLines" data-idx="${i}" data-field="volume" data-type="number" /></td>
              <td class="hub-num">${calc.formatCurrency(calc.vasLineAnnual(l))}</td>
              <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-vas" data-idx="${i}" title="Delete row">×</button></td>
            </tr>
          `).join('')}
          ${lines.length === 0 ? `
            <tr><td colspan="5" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No VAS lines yet. Click Add VAS Line to start.</td></tr>
          ` : ''}
          <tr class="cm-total-row"><td colspan="3">Total VAS</td><td class="hub-num">${calc.formatCurrency(total)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <button class="cm-add-row-btn" data-action="add-vas">+ Add VAS Line</button>
  `;
}

function renderFinancial() {
  const f = model.financial || {};
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Financial Parameters</div>
        <div class="cm-section-desc">Margin targets, escalation rates, discount rates, and financial thresholds.</div>
      </div>
    </div>

    <div class="cm-narrow-form">
      <div class="hub-field">
        <label class="hub-field__label">Target Margin (%)</label>
        <input class="hub-input" type="number" value="${f.targetMargin || 12}" step="0.5" data-field="financial.targetMargin" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Volume Growth (% / yr)</label>
        <input class="hub-input" type="number" value="${f.volumeGrowth || 3}" step="0.5" data-field="financial.volumeGrowth" data-type="number" />
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Labor Escalation (% / yr)</label>
        <input class="hub-input" type="number" value="${f.laborEscalation || 4}" step="0.5" data-field="financial.laborEscalation" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Cost Escalation (% / yr)</label>
        <input class="hub-input" type="number" value="${f.annualEscalation || 3}" step="0.5" data-field="financial.annualEscalation" data-type="number" />
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Discount Rate (%)</label>
        <input class="hub-input" type="number" value="${f.discountRate || 10}" step="0.5" data-field="financial.discountRate" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Reinvestment Rate (%)</label>
        <input class="hub-input" type="number" value="${f.reinvestRate || 8}" step="0.5" data-field="financial.reinvestRate" data-type="number" />
      </div>

      <div class="hub-field hub-field--full">
        <label class="hub-field__label" title="Which pricing bucket carries the facility cost rollup. Defaults to a bucket named 'storage' if you have one; otherwise routes to Management Fee or your first bucket. (I-01 edge fix)">Facility Cost → Bucket</label>
        <select class="hub-input" data-field="financial.facilityBucketId">
          <option value=""${!f.facilityBucketId ? ' selected' : ''}>— Auto (storage → mgmt_fee → first) —</option>
          ${(model.pricingBuckets || []).map(b =>
            `<option value="${b.id}"${f.facilityBucketId === b.id ? ' selected' : ''}>${b.name} (${b.type}/${b.uom})</option>`
          ).join('')}
        </select>
        <div class="hub-field__hint">Auto-selects the sensible default. Override when a client contract requires a specific bucket carry the facility cost rollup.</div>
      </div>
    </div>
  `;
}

function renderStartup() {
  const lines = model.startupLines || [];
  const contractYears = model.projectDetails?.contractTerm || 5;
  const totalCapital = calc.totalStartupCapital(lines);
  const totalAmort = calc.totalStartupAmort(lines, contractYears);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Start-Up / Capital</div>
        <div class="cm-section-desc">One-time implementation costs amortized over the ${contractYears}-year contract term.</div>
      </div>
    </div>

    <div class="cm-section-toolbar">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-startup">⚡ Auto-Generate Start-Up Costs</button>
      <span class="cm-section-toolbar__hint">Generates typical 3PL implementation line items (PM, IT, training, travel).</span>
    </div>

    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense">
        <thead>
          <tr>
            <th style="width:50%;">Description</th>
            <th class="hub-num" style="width:16%;">One-Time Cost</th>
            <th class="hub-num" style="width:14%;">Annual Amort</th>
            <th class="hub-num" style="width:14%;">Monthly Amort</th>
            <th class="cm-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => {
            const amort = (l.one_time_cost || 0) / Math.max(1, contractYears);
            return `
              <tr>
                <td><input class="hub-input" value="${l.description || ''}" data-array="startupLines" data-idx="${i}" data-field="description" /></td>
                <td><input class="hub-input hub-num" type="number" value="${l.one_time_cost || 0}" data-array="startupLines" data-idx="${i}" data-field="one_time_cost" data-type="number" /></td>
                <td class="hub-num">${calc.formatCurrency(amort)}</td>
                <td class="hub-num">${calc.formatCurrency(amort / 12)}</td>
                <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-startup" data-idx="${i}" title="Delete row">×</button></td>
              </tr>
            `;
          }).join('')}
          ${lines.length === 0 ? `
            <tr><td colspan="5" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No capital line items yet. Click Auto-Generate or Add Capital Item.</td></tr>
          ` : ''}
          <tr class="cm-total-row"><td>Total</td><td class="hub-num">${calc.formatCurrency(totalCapital)}</td><td class="hub-num">${calc.formatCurrency(totalAmort)}</td><td class="hub-num">${calc.formatCurrency(totalAmort / 12)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <button class="cm-add-row-btn" data-action="add-startup">+ Add Capital Item</button>
  `;
}

// ============================================================
// SECTION: PRICING BUCKETS (v2 — bucket taxonomy, defined BEFORE cost build)
// ============================================================

/**
 * Starter bucket template — 5 canonical 3PL buckets that cover the
 * typical rate card structure. Seeded when the user clicks "Apply
 * Starter Template" and the project has no existing buckets.
 */
const STARTER_PRICING_BUCKETS = [
  { id: 'mgmt_fee',  name: 'Management Fee',    type: 'fixed',    uom: 'month',  rate: 0,
    description: 'Monthly fixed fee covering overhead and management overhead allocation.' },
  { id: 'storage',   name: 'Storage',           type: 'variable', uom: 'pallet', rate: 0,
    description: 'Storage cost per pallet position per month. Pass-through of facility cost + storage-specific labor/equipment.' },
  { id: 'inbound',   name: 'Inbound Handling',  type: 'variable', uom: 'pallet', rate: 0,
    description: 'Receiving / put-away per inbound pallet. Includes dock, dock-staff, and inbound MHE costs.' },
  { id: 'pick_pack', name: 'Pick & Pack',       type: 'variable', uom: 'order',  rate: 0,
    description: 'Order fulfillment rate per outbound order. Primary pricing bucket for e-comm DTC.' },
  { id: 'vas',       name: 'Value-Added Svcs',  type: 'variable', uom: 'each',   rate: 0,
    description: 'Kitting, labeling, packaging, returns processing — charge per transaction.' },
];

const BUCKET_UOM_OPTIONS = [
  { value: 'month',    label: 'per month' },
  { value: 'pallet',   label: 'per pallet' },
  { value: 'order',    label: 'per order' },
  { value: 'each',     label: 'per unit / each' },
  { value: 'case',     label: 'per case' },
  { value: 'line',     label: 'per line' },
  { value: 'shipment', label: 'per shipment' },
  { value: 'cube',     label: 'per cube (ft³)' },
  { value: 'lb',       label: 'per pound' },
  { value: 'sqft',     label: 'per sqft / month' },
];

function renderPricingBuckets() {
  const buckets = model.pricingBuckets || [];
  const empty = buckets.length === 0;

  return `
    <div class="cm-wide-layout">
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Pricing Buckets</div>
        <div class="cm-section-desc">Define the pricing structure before you build cost lines. Every labor, equipment, overhead, VAS, and startup line routes into one of these buckets, which becomes a line on the customer's rate card.</div>
      </div>
    </div>

    ${empty ? `
      <div class="hub-card" style="margin-bottom:20px;padding:24px;background:var(--ies-gray-50);text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">🧱</div>
        <h3 style="margin:0 0 6px;font-size:16px;font-weight:700;">No pricing buckets yet</h3>
        <div style="color:var(--ies-gray-500);font-size:13px;margin-bottom:16px;max-width:560px;margin-left:auto;margin-right:auto;line-height:1.5;">
          Start with the standard 5-bucket template (Management Fee, Storage, Inbound, Pick &amp; Pack, VAS) — typical for most 3PL deals — or define your own from scratch. You can edit, rename, or add buckets at any time.
        </div>
        <div style="display:flex;gap:10px;justify-content:center;">
          <button class="hub-btn hub-btn-primary hub-btn-sm" data-cm-action="apply-bucket-starter">Apply Starter Template</button>
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-cm-action="add-bucket">Add Empty Bucket</button>
        </div>
      </div>
    ` : `
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;gap:16px;">
        <div class="hub-field__hint" style="flex:1;max-width:640px;">
          <strong style="color:var(--ies-gray-700);">${buckets.length} bucket${buckets.length === 1 ? '' : 's'}.</strong>
          Each bucket has a pricing type (fixed / variable / cost-plus) and a UOM. Rates are computed in the Pricing step later — or you can set an explicit rate here to override the derivation.
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-cm-action="apply-bucket-starter" title="Reset to the standard 5-bucket template (overwrites current buckets)">↺ Reset to Template</button>
          <button class="hub-btn hub-btn-primary hub-btn-sm" data-cm-action="add-bucket">+ Add Bucket</button>
        </div>
      </div>

      <div class="hub-card" style="padding:0;overflow:hidden;">
        <table class="hub-datatable">
          <thead>
            <tr>
              <th style="width:30%;">Name</th>
              <th style="width:140px;">Pricing Type</th>
              <th style="width:170px;">UOM</th>
              <th class="hub-num" style="width:140px;">Explicit Rate</th>
              <th>Description</th>
              <th style="width:40px;"></th>
            </tr>
          </thead>
          <tbody>
            ${buckets.map((b, i) => `
              <tr>
                <td>
                  <input class="hub-input" value="${escapeAttr(b.name || '')}" data-array="pricingBuckets" data-idx="${i}" data-field="name" placeholder="e.g. Pick &amp; Pack" />
                </td>
                <td>
                  <select class="hub-input" data-array="pricingBuckets" data-idx="${i}" data-field="type" title="Fixed = flat monthly; Variable = $ per unit of volume; Cost-Plus = pass-through with markup">
                    <option value="fixed"${(b.type || 'variable') === 'fixed' ? ' selected' : ''}>Fixed</option>
                    <option value="variable"${b.type === 'variable' ? ' selected' : ''}>Variable</option>
                    <option value="cost_plus"${b.type === 'cost_plus' ? ' selected' : ''}>Cost-Plus</option>
                  </select>
                </td>
                <td>
                  <select class="hub-input" data-array="pricingBuckets" data-idx="${i}" data-field="uom">
                    ${BUCKET_UOM_OPTIONS.map(o => `<option value="${o.value}"${(b.uom || 'order') === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
                  </select>
                </td>
                <td>
                  <input class="hub-input hub-num" type="number" step="0.01" min="0" value="${b.rate || 0}" data-array="pricingBuckets" data-idx="${i}" data-field="rate" data-type="number" placeholder="derived" title="Leave 0 to let the Pricing section derive the rate from assigned costs + target margin. Set a value here to lock an explicit rate." />
                </td>
                <td>
                  <input class="hub-input" value="${escapeAttr(b.description || '')}" data-array="pricingBuckets" data-idx="${i}" data-field="description" placeholder="optional note" />
                </td>
                <td style="text-align:center;">
                  <button class="cm-delete-btn" data-cm-action="delete-bucket" data-idx="${i}" aria-label="Delete bucket" title="Delete bucket">×</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div style="margin-top:14px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:12px;color:#1e3a8a;line-height:1.5;">
        <strong>What happens next:</strong> when you build Labor, Equipment, Overhead, VAS, or Startup lines, each line picks one of these buckets to route its cost into. Buckets with no assigned lines are allowed — they'll just show $0 in the Pricing section. Missing a bucket? Add it here, then go back and re-assign the line.
      </div>
    `}
    </div>
  `;
}

function renderPricing() {
  const buckets = model.pricingBuckets || [];
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const opHrs = calc.operatingHours(model.shifts || {});
  const facilityCost = calc.totalFacilityCost(model.facility || {}, fr, ur);
  const contractYears = model.projectDetails?.contractTerm || 5;

  // Prep startup lines with annual_amort
  const startupWithAmort = (model.startupLines || []).map(l => ({
    ...l,
    annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears),
  }));

  const bucketCosts = calc.computeBucketCosts({
    buckets,
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: startupWithAmort,
    facilityCost,
    operatingHours: opHrs,
    // I-01 edge: route facility cost to user-configured bucket. Falls through
    // to 'storage' → 'mgmt_fee' → first bucket → orphan. Orphans surface in
    // the table below as an explicit row so they don't silently vanish.
    facilityBucketId: model.financial?.facilityBucketId || null,
  });

  const marginPct = (model.financial?.targetMargin || 0) / 100;
  // Sum only real bucket costs — exclude meta keys ('_unassigned', '_facilityOrphan', '_facilityTarget')
  const totalCost = Object.entries(bucketCosts).reduce((s, [k, v]) => (typeof v === 'number' && !k.startsWith('_')) ? s + v : s, 0);
  const totalRevenue = totalCost * (1 + marginPct);

  // I-02 — single source of truth: same derivation used by monthly engine.
  const derivedRates = calc.computeBucketRates({
    buckets, bucketCosts, marginPct, volumeLines: model.volumeLines || [],
  });

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Pricing Schedule</div>
        <div class="cm-section-desc">Rate derivation — each bucket's annual cost rolls up from the Cost lines you've assigned, then divides by volume and applies ${calc.formatPct(model.financial?.targetMargin || 0, 1)} target margin. Edit the bucket taxonomy itself in <strong>Structure → Pricing Buckets</strong>.</div>
      </div>
    </div>

    ${buckets.length === 0 ? `
      <div class="hub-card" style="padding:24px;text-align:center;background:var(--ies-gray-50);margin-bottom:16px;">
        <div style="font-size:28px;margin-bottom:6px;">🧱</div>
        <h3 style="margin:0 0 6px;font-size:16px;">No pricing buckets defined</h3>
        <div style="color:var(--ies-gray-500);font-size:13px;margin-bottom:14px;">Buckets are defined in <strong>Structure → Pricing Buckets</strong>. Without them the cost lines can't be allocated to a rate card.</div>
        <button class="hub-btn hub-btn-primary hub-btn-sm" data-cm-action="jump-to-buckets">Open Pricing Buckets →</button>
      </div>
    ` : ''}

    <table class="cm-grid-table">
      <thead>
        <tr>
          <th>Bucket</th>
          <th>Type</th>
          <th>UOM</th>
          <th class="cm-num">Annual Cost</th>
          <th class="cm-num">Margin-Applied</th>
          <th class="cm-num">Volume</th>
          <th class="cm-num">Rate/Unit</th>
        </tr>
      </thead>
      <tbody>
        ${buckets.map(b => {
          const cost = bucketCosts[b.id] || 0;
          const withMargin = cost * (1 + marginPct);
          const d = derivedRates[b.id] || { rate: 0, annualVolume: 0 };
          const vol = d.annualVolume;
          // Explicit bucket.rate wins (user set it in the bucket editor);
          // otherwise fall back to the derived rate so monthly engine matches.
          const hasExplicit = Number(b.rate) > 0;
          const rate = hasExplicit ? Number(b.rate) : d.rate;
          return `
            <tr>
              <td style="font-weight:600;">${b.name}</td>
              <td><span class="hub-badge hub-badge-${b.type === 'fixed' ? 'info' : 'success'}">${b.type}</span></td>
              <td>${b.type === 'fixed' ? '/month' : '/' + b.uom}</td>
              <td class="cm-num">${calc.formatCurrency(cost)}</td>
              <td class="cm-num" style="font-weight:700;">${calc.formatCurrency(withMargin)}</td>
              <td class="cm-num">${vol > 0 ? vol.toLocaleString() : '—'}</td>
              <td class="cm-num" style="font-weight:700; color: var(--ies-blue);">
                ${vol > 0 || b.type === 'fixed' ? calc.formatCurrency(rate, { decimals: 2 }) : '—'}
                ${!hasExplicit && (vol > 0 || b.type === 'fixed') ? `<span class="cm-rate-source" title="Derived from assigned costs + margin. Set an explicit rate on the bucket to override.">derived</span>` : ''}
              </td>
            </tr>
          `;
        }).join('')}
        <tr class="cm-total-row">
          <td colspan="3">Total</td>
          <td class="cm-num">${calc.formatCurrency(totalCost)}</td>
          <td class="cm-num">${calc.formatCurrency(totalRevenue)}</td>
          <td></td>
          <td></td>
        </tr>
      </tbody>
    </table>

    ${(() => {
      // Render orphan banners. Two distinct kinds of orphans:
      //   (a) facility-cost orphan — facility target bucket missing
      //   (b) line-cost orphan — lines with no pricing_bucket set
      const facilityTarget = bucketCosts['_facilityTarget'];
      const facilityOrphan = bucketCosts['_facilityOrphan'] || 0;
      const lineUnassigned = bucketCosts['_unassigned'] || 0;
      const facilityRoutedTo = facilityTarget && buckets.find(b => b.id === facilityTarget);
      const facilityNote = facilityCost > 0 && facilityRoutedTo
        ? `Facility cost (${calc.formatCurrency(facilityCost)}) routes to <b>${facilityRoutedTo.name}</b>.`
        : '';
      const facilityWarn = facilityOrphan > 0
        ? `<div style="font-size:13px;font-weight:600;color:var(--ies-red);">⚠ ${calc.formatCurrency(facilityOrphan)} facility cost has no target bucket — pick one in Setup → Financial.</div>`
        : '';
      const lineWarn = lineUnassigned > 0
        ? `<div style="font-size:13px;font-weight:600;color:var(--ies-orange);">${calc.formatCurrency(lineUnassigned)} in unassigned line costs rolled into Management Fee.</div><div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">Assign pricing buckets to labor, equipment, overhead, and VAS lines to distribute costs accurately.</div>`
        : '';
      const noteRow = facilityNote
        ? `<div style="font-size:12px;color:var(--ies-gray-500);margin-top:6px;">${facilityNote}</div>`
        : '';
      if (!facilityWarn && !lineWarn && !facilityNote) return '';
      const borderColor = facilityOrphan > 0 ? 'var(--ies-red)' : 'var(--ies-orange)';
      return `<div class="hub-card mt-4" style="border-left:3px solid ${borderColor};background:rgba(255,193,7,0.06);">${facilityWarn}${lineWarn}${noteRow}</div>`;
    })()}

    <!-- I-01: Line → Bucket assignment table lets users review + reassign every line in one place -->
    ${renderBucketAssignments(buckets)}

    <style>
      .hub-badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.3px; }
      .hub-badge-info { background:rgba(0,71,171,0.1); color:var(--ies-blue); }
      .hub-badge-success { background:rgba(32,201,151,0.1); color:#0d9668; }
      .cm-rate-source { display:inline-block; margin-left:6px; padding:1px 6px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.3px; color:var(--ies-gray-500); background:var(--ies-gray-100); border-radius:8px; cursor:help; }
      .cm-bucket-unassigned { background:rgba(255,193,7,0.1) !important; border-left:2px solid var(--ies-orange); }
      .cm-bucket-select { width:140px; font-size:12px; padding:3px 4px; }
    </style>
  `;
}

/**
 * I-01 — compact table showing every cost line with its pricing_bucket
 * dropdown, grouped by source. Lets users reassign without digging
 * through the individual Labor/Equipment/Overhead grids.
 */
function renderBucketAssignments(buckets) {
  if (!buckets.length) return '';
  const groups = [
    { type: 'labor',     label: 'Direct Labor',   arrayName: 'laborLines',         nameField: 'activity_name', lines: model.laborLines || [] },
    { type: 'indirect',  label: 'Indirect Labor', arrayName: 'indirectLaborLines', nameField: 'role_name',     lines: model.indirectLaborLines || [] },
    { type: 'equipment', label: 'Equipment',      arrayName: 'equipmentLines',     nameField: 'equipment_name',lines: model.equipmentLines || [] },
    { type: 'overhead',  label: 'Overhead',       arrayName: 'overheadLines',      nameField: 'category',      lines: model.overheadLines || [] },
    { type: 'vas',       label: 'VAS',            arrayName: 'vasLines',           nameField: 'service',       lines: model.vasLines || [] },
    { type: 'startup',   label: 'Startup',        arrayName: 'startupLines',       nameField: 'description',   lines: model.startupLines || [] },
  ].filter(g => g.lines.length > 0);

  if (groups.length === 0) return '';

  const opts = (selectedId) => `
    <option value=""${!selectedId ? ' selected' : ''}>— Unassigned —</option>
    ${buckets.map(b => `<option value="${b.id}"${selectedId === b.id ? ' selected' : ''}>${b.name} (${b.type})</option>`).join('')}
  `;

  return `
    <div class="mt-6">
      <div class="text-subtitle mb-2">Line → Bucket Assignments <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;">— change where each cost line's dollars route for pricing</span></div>
      <table class="cm-grid-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Line</th>
            <th>Bucket</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map(g => g.lines.map((l, i) => {
            const label = l[g.nameField] || `(unnamed ${g.label.toLowerCase()} #${i + 1})`;
            const unassigned = !l.pricing_bucket;
            return `
              <tr${unassigned ? ' class="cm-bucket-unassigned"' : ''}>
                <td><span class="hub-badge hub-badge-${g.type === 'labor' || g.type === 'vas' ? 'success' : 'info'}">${g.label}</span></td>
                <td style="font-weight:500;">${label}</td>
                <td>
                  <select class="cm-bucket-select" data-array="${g.arrayName}" data-idx="${i}" data-field="pricing_bucket">
                    ${opts(l.pricing_bucket)}
                  </select>
                </td>
              </tr>
            `;
          }).join('')).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSummary() {
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const opHrs = calc.operatingHours(model.shifts || {});
  const orders = (model.volumeLines || []).find(v => v.isOutboundPrimary)?.volume || 0;
  const contractYears = model.projectDetails?.contractTerm || 5;
  const fin = model.financial || {};

  const summary = calc.computeSummary({
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: model.startupLines || [],
    facility: model.facility || {},
    shifts: model.shifts || {},
    facilityRate: fr,
    utilityRate: ur,
    contractYears,
    targetMarginPct: fin.targetMargin || 0,
    annualOrders: orders || 1,
  });

  // Phase 3 close-the-loop: resolve heuristics through the
  //   transient (Phase 5b) → approved-snapshot → override → project-column
  // chain so approved scenarios re-run against their FROZEN values and
  // the What-If Studio can preview-override without persisting.
  const calcHeur = scenarios.resolveCalcHeuristics(
    currentScenario,
    currentScenarioSnapshots,
    heuristicOverrides,
    fin,
    whatIfTransient,
  );

  // Build multi-year projections
  const marginFrac = (calcHeur.targetMarginPct || 0) / 100;

  // I-02 FIX — derive missing bucket rates from assigned costs so new
  // models don't render $0 revenue until someone hand-wires bucket.rate.
  // I-01 FIX — also capture unassigned-cost rollup for the Summary banner.
  const pricingSnapshot = computePricingSnapshot(summary, marginFrac, opHrs, contractYears);
  const enrichedPricingBuckets = pricingSnapshot.buckets;
  const unassignedCost = pricingSnapshot.bucketCosts['_unassigned'] || 0;
  const unassignedCount = pricingSnapshot.unassignedCount;
  const projResult = calc.buildYearlyProjections({
    years: contractYears,
    baseLaborCost: summary.laborCost,
    baseFacilityCost: summary.facilityCost,
    baseEquipmentCost: summary.equipmentCost,
    baseOverheadCost: summary.overheadCost,
    baseVasCost: summary.vasCost,
    startupAmort: summary.startupAmort,
    startupCapital: summary.startupCapital,
    baseOrders: orders || 1,
    marginPct: marginFrac,
    volGrowthPct: calcHeur.volGrowthPct / 100,
    laborEscPct:  calcHeur.laborEscPct  / 100,
    costEscPct:   calcHeur.costEscPct   / 100,
    laborLines: model.laborLines || [],
    taxRatePct: calcHeur.taxRatePct,
    useMonthlyEngine: typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false,
    periods: (refData && refData.periods) || [],
    ramp: null,
    seasonality: model.seasonalityProfile || null,
    preGoLiveMonths: calcHeur.preGoLiveMonths,
    dsoDays:           calcHeur.dsoDays,
    dpoDays:           calcHeur.dpoDays,
    laborPayableDays:  calcHeur.laborPayableDays,
    startupLines: model.startupLines || [],
    pricingBuckets: enrichedPricingBuckets, // I-02: derived rates when unset
    project_id: model.id || 0,
    // Phase 4d — thread calc heuristics + market profile so the monthly
    // engine can compute per-line labor cost using Phase 4b profiles.
    _calcHeur: calcHeur,
    marketLaborProfile: currentMarketLaborProfile,
    // Diagnostic: carries which keys came from snapshot vs override vs default.
    _heuristicsSource: calcHeur.used,
  });
  _lastCalcHeuristics = calcHeur; // for the frozen-banner in Summary/Timeline
  // Stash the monthly bundle for save-time persistence
  if (projResult && projResult.monthlyBundle) _lastMonthlyBundle = projResult.monthlyBundle;
  const projections = projResult.projections || [];

  // Financial metrics
  const metrics = calc.computeFinancialMetrics(projections, {
    startupCapital: summary.startupCapital,
    discountRate: (fin.discountRate || 10) / 100,
    reinvestRate: (fin.reinvestRate || 8) / 100,
    totalFtes: summary.totalFtes,
    fixedCost: summary.facilityCost + summary.overheadCost + summary.startupAmort,
  });

  // Sensitivity data
  const baseCosts = {
    labor: summary.laborCost,
    facility: summary.facilityCost,
    equipment: summary.equipmentCost,
    overhead: summary.overheadCost,
    vas: summary.vasCost,
    startup: summary.startupAmort,
  };
  const sensi = calc.sensitivityTable(baseCosts, orders || 1);

  const pcts = summary.totalCost > 0 ? {
    labor: (summary.laborCost / summary.totalCost * 100).toFixed(0),
    facility: (summary.facilityCost / summary.totalCost * 100).toFixed(0),
    equipment: (summary.equipmentCost / summary.totalCost * 100).toFixed(0),
    overhead: (summary.overheadCost / summary.totalCost * 100).toFixed(0),
    vas: (summary.vasCost / summary.totalCost * 100).toFixed(0),
    startup: (summary.startupAmort / summary.totalCost * 100).toFixed(0),
  } : { labor: 0, facility: 0, equipment: 0, overhead: 0, vas: 0, startup: 0 };

  // Threshold defaults for metric coloring
  const thresholds = fin.thresholds || {
    grossMargin: 10, ebitda: 8, ebit: 5, roic: 15, mirr: 12, payback: contractYears * 12,
  };

  const frozenBannerSummary = renderFrozenBanner();

  // I-01 — unassigned cost warning banner. Shows on Summary (not just
  // Pricing) so users see the silent Management-Fee rollup as soon as
  // they land on the dashboard.
  const unassignedBanner = unassignedCost > 0 ? `
    <div class="hub-card mb-4" style="border-left: 3px solid var(--ies-orange); background: rgba(255,193,7,0.06); padding: 12px 16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-size:13px; font-weight:600; color: var(--ies-orange);">
            ${calc.formatCurrency(unassignedCost)} in unassigned costs — rolled into Management Fee
          </div>
          <div style="font-size:12px; color: var(--ies-gray-500); margin-top:2px;">
            ${unassignedCount} cost line${unassignedCount === 1 ? '' : 's'} ${unassignedCount === 1 ? 'is' : 'are'} missing a pricing bucket. New lines auto-assign a bucket now; fix older lines in the Pricing section.
          </div>
        </div>
        <button class="hub-btn" data-cm-action="go-pricing" style="white-space:nowrap;">Fix in Pricing →</button>
      </div>
    </div>
  ` : '';

  return `
    ${frozenBannerSummary}
    ${unassignedBanner}
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Summary Dashboard</div>
        <div class="cm-section-desc">Cost breakdown, financial metrics, multi-year P&L, and sensitivity analysis.</div>
      </div>
      <div>
        <button class="hub-btn-primary" data-cm-action="export-scenario-xlsx" title="Export the active scenario as a 7-sheet Excel workbook">
          ⬇ Export Scenario XLSX
        </button>
      </div>
    </div>

    <!-- KPI Strip (primitives-kit, 5-tile override) -->
    <div class="hub-kpi-strip mb-4" style="grid-template-columns: repeat(5, minmax(0, 1fr));">
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Total Cost</div>
        <div class="hub-kpi-tile__value">${calc.formatCurrency(summary.totalCost, {compact: true})}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Revenue</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">${calc.formatCurrency(summary.totalRevenue, {compact: true})}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Cost / Order</div>
        <div class="hub-kpi-tile__value">${orders > 0 ? calc.formatCurrency(summary.costPerOrder, {decimals: 2}) : '—'}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">FTEs</div>
        <div class="hub-kpi-tile__value">${summary.totalFtes.toFixed(0)}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Capital</div>
        <div class="hub-kpi-tile__value">${calc.formatCurrency(summary.equipmentCapital + summary.startupCapital, {compact: true})}</div>
      </div>
    </div>

    ${renderSensitivityCard()}

    <!-- Design Heuristics — moved up so they're the FIRST thing after KPIs (per v2 pattern) -->
    <div class="hub-card mb-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="text-subtitle" style="margin:0;">Design Heuristics & Benchmarks</div>
        <span style="font-size:11px;color:var(--ies-gray-400);">Pass/warn checks against industry norms</span>
      </div>
      <div id="cm-heuristics-panel" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        ${renderHeuristicsPanel(model, summary)}
      </div>
    </div>

    <!-- Cost Breakdown — stacked bar + legend (primitives-style) -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">Cost Breakdown</h3>
      <div class="cm-stacked-bar">
        <div style="width:${pcts.labor}%; background: #0047AB;" title="Labor ${pcts.labor}%"></div>
        <div style="width:${pcts.facility}%; background: #20c997;" title="Facility ${pcts.facility}%"></div>
        <div style="width:${pcts.equipment}%; background: #ffc107;" title="Equipment ${pcts.equipment}%"></div>
        <div style="width:${pcts.overhead}%; background: #6c757d;" title="Overhead ${pcts.overhead}%"></div>
        <div style="width:${pcts.vas}%; background: #dc3545;" title="VAS ${pcts.vas}%"></div>
        <div style="width:${pcts.startup}%; background: #ff3a00;" title="Start-Up ${pcts.startup}%"></div>
      </div>
      <div class="cm-stacked-legend">
        ${[
          { label: 'Labor', value: summary.laborCost, pct: pcts.labor, color: '#0047AB' },
          { label: 'Facility', value: summary.facilityCost, pct: pcts.facility, color: '#20c997' },
          { label: 'Equipment', value: summary.equipmentCost, pct: pcts.equipment, color: '#ffc107' },
          { label: 'Overhead', value: summary.overheadCost, pct: pcts.overhead, color: '#6c757d' },
          { label: 'VAS', value: summary.vasCost, pct: pcts.vas, color: '#dc3545' },
          { label: 'Start-Up', value: summary.startupAmort, pct: pcts.startup, color: '#ff3a00' },
        ].map(c => `
          <div class="cm-stacked-legend__item">
            <span class="cm-stacked-legend__swatch" style="background:${c.color};"></span>
            <div>
              <div class="hub-field__label" style="text-transform:none; letter-spacing:0;">${c.label} <span style="color:var(--ies-gray-400);font-weight:500;">(${c.pct}%)</span></div>
              <div class="hub-num" style="font-size:14px; font-weight:700; text-align:left;">${calc.formatCurrency(c.value, {compact: true})}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Financial Metrics — primitives kpi-tile grid -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">Financial Metrics</h3>
      <div class="cm-metrics-grid">
        ${renderMetricCard('Gross Margin', calc.formatPct(metrics.grossMarginPct), metrics.grossMarginPct >= (thresholds.grossMargin || 10))}
        ${renderMetricCard('EBITDA Margin', calc.formatPct(metrics.ebitdaMarginPct), metrics.ebitdaMarginPct >= (thresholds.ebitda || 8))}
        ${renderMetricCard('EBIT Margin', calc.formatPct(metrics.ebitMarginPct), metrics.ebitMarginPct >= (thresholds.ebit || 5))}
        ${renderMetricCard('ROIC', calc.formatPct(metrics.roicPct), metrics.roicPct >= (thresholds.roic || 15))}
        ${renderMetricCard('MIRR', calc.formatPct(metrics.mirrPct), metrics.mirrPct >= (thresholds.mirr || 12))}
        ${renderMetricCard('NPV', calc.formatCurrency(metrics.npv, {compact: true}), metrics.npv > 0)}
        ${renderMetricCard('Payback', metrics.paybackMonths > 0 ? metrics.paybackMonths + ' mo' : '—', metrics.paybackMonths > 0 && metrics.paybackMonths <= (thresholds.payback || contractYears * 12))}
        ${renderMetricCard('Rev / FTE', calc.formatCurrency(metrics.revenuePerFte, {compact: true}), null)}
        ${renderMetricCard('Contrib / Order', calc.formatCurrency(metrics.contribPerOrder, {decimals: 2}), metrics.contribPerOrder > 0)}
        ${renderMetricCard('Op Leverage', calc.formatPct(metrics.opLeveragePct), null)}
        ${renderMetricCard('Contract Value', calc.formatCurrency(metrics.contractValue, {compact: true}), null)}
        ${renderMetricCard('Total Investment', calc.formatCurrency(metrics.totalInvestment, {compact: true}), null)}
      </div>
    </div>

    <!-- Multi-Year P&L — primitives hub-datatable -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">${contractYears}-Year P&L Projection</h3>
      <div class="cm-table-scroll">
        <table class="hub-datatable hub-datatable--dense">
          <thead>
            <tr>
              <th></th>
              ${projections.map(p => `<th class="hub-num">Year ${p.year}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr><td style="font-weight:600;">Orders</td>${projections.map(p => `<td class="hub-num">${Math.round(p.orders).toLocaleString()}</td>`).join('')}</tr>
            <tr><td>Labor</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.labor, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Facility</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.facility, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Equipment</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.equipment, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Overhead</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.overhead, {compact: true})}</td>`).join('')}</tr>
            <tr><td>VAS</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.vas, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Start-Up Amort</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.startup, {compact: true})}</td>`).join('')}</tr>
            <tr class="cm-pnl-row-total"><td>Total Cost</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.totalCost, {compact: true})}</td>`).join('')}</tr>
            <tr class="cm-pnl-row-revenue"><td style="font-weight:700; color:var(--ies-blue);">Revenue</td>${projections.map(p => `<td class="hub-num" style="font-weight:700; color:var(--ies-blue);">${calc.formatCurrency(p.revenue, {compact: true})}</td>`).join('')}</tr>
            <tr><td style="font-weight:600;">Gross Profit</td>${projections.map(p => `<td class="hub-num" style="font-weight:600; color:${p.grossProfit >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">${calc.formatCurrency(p.grossProfit, {compact: true})}</td>`).join('')}</tr>
            <tr><td>EBITDA</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.ebitda, {compact: true})}</td>`).join('')}</tr>
            <tr><td>EBIT</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.ebit, {compact: true})}</td>`).join('')}</tr>
            <tr><td>Net Income</td>${projections.map(p => `<td class="hub-num">${calc.formatCurrency(p.netIncome, {compact: true})}</td>`).join('')}</tr>
            <tr class="cm-pnl-row-capex"><td>CapEx</td>${projections.map(p => `<td class="hub-num">${p.capex > 0 ? '(' + calc.formatCurrency(p.capex, {compact: true}) + ')' : '—'}</td>`).join('')}</tr>
            <tr><td>Free Cash Flow</td>${projections.map(p => `<td class="hub-num" style="font-weight:600; color:${p.freeCashFlow >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">${calc.formatCurrency(p.freeCashFlow, {compact: true})}</td>`).join('')}</tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sensitivity Analysis — primitives hub-datatable -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">Sensitivity Analysis</h3>
      <div class="cm-table-scroll">
        <table class="hub-datatable hub-datatable--dense">
          <thead>
            <tr>
              <th>Driver</th>
              ${sensi[0]?.adjustments.map(a => `<th class="hub-num">${a.pct > 0 ? '+' : ''}${a.pct}%</th>`).join('') || ''}
            </tr>
          </thead>
          <tbody>
            ${sensi.map(driver => `
              <tr>
                <td style="font-weight:600;">${driver.label}</td>
                ${driver.adjustments.map(a => `
                  <td class="hub-num" style="color: ${a.delta > 0 ? 'var(--ies-red)' : a.delta < 0 ? 'var(--ies-green)' : 'inherit'};">
                    <div>${calc.formatCurrency(a.totalCost, {compact: true})}</div>
                    <div class="hub-field__hint" style="text-align:right;">${a.delta >= 0 ? '+' : ''}${calc.formatCurrency(a.delta, {compact: true})}</div>
                  </td>
                `).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="hub-field__hint mt-2">
        Base total cost: ${calc.formatCurrency(summary.totalCost, {compact: true})}. Red = cost increase, green = cost decrease.
      </div>
    </div>

    <!-- (Design Heuristics block moved to top of Summary, right after KPIs) -->
  `;
}

/**
 * Render a single metric card. `passes` semantics:
 *   true  → green (pass against threshold)
 *   false → red   (fail against threshold)
 *   null  → neutral (display-only metric, no judgment applied)
 * Migrated to primitives kit (hub-kpi-tile base + .cm-metric-card mod).
 */
function renderMetricCard(label, value, passes) {
  const stateClass = passes === null ? 'is-neutral' : (passes ? 'is-pass' : 'is-fail');
  return `
    <div class="hub-kpi-tile cm-metric-card ${stateClass}">
      <div class="hub-kpi-tile__label">${label}</div>
      <div class="hub-kpi-tile__value">${value}</div>
    </div>
  `;
}

/** Render heuristics panel with 10 benchmark checks */
function renderHeuristicsPanel(state, summary) {
  const checks = calc.generateHeuristics(state, summary);
  if (!checks || checks.length === 0) {
    return '<div style="padding: 12px; background: var(--ies-gray-50); border-radius: 6px; font-size: 13px; color: var(--ies-gray-500);">Enter project parameters to see design guidance.</div>';
  }

  return checks.map(check => {
    const icon = check.type === 'ok' ? '✓' : check.type === 'warn' ? '⚠' : 'ℹ';
    const bg = check.type === 'ok' ? 'rgba(32,201,151,0.06)' : check.type === 'warn' ? 'rgba(255,193,7,0.06)' : 'rgba(0,71,171,0.06)';
    const borderColor = check.type === 'ok' ? 'rgba(32,201,151,0.3)' : check.type === 'warn' ? 'rgba(255,193,7,0.3)' : 'rgba(0,71,171,0.3)';
    const color = check.type === 'ok' ? '#0d9668' : check.type === 'warn' ? '#ff9800' : '#0047AB';

    return `
      <div style="padding: 12px; background: ${bg}; border-left: 3px solid ${borderColor}; border-radius: 4px; font-size: 13px;">
        <div style="display: flex; gap: 8px; margin-bottom: 4px;">
          <span style="color: ${color}; font-weight: 700; font-size: 16px;">${icon}</span>
          <div style="font-weight: 600; color: var(--ies-navy); flex: 1;">${check.title}</div>
        </div>
        <div style="font-size: 12px; color: var(--ies-gray-600); margin-left: 24px;">${check.detail}</div>
      </div>
    `;
  }).join('');
}

// ============================================================
// EVENT BINDING — generic data-field system
// ============================================================

function bindSectionEvents(section, container) {
  // Generic input binding: data-field="path.to.field"
  container.querySelectorAll('[data-field]').forEach(input => {
    const event = input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(event, (e) => {
      const field = input.dataset.field;
      const isNum = input.dataset.type === 'number';
      const val = isNum ? parseFloat(input.value) || 0 : input.value;

      // Handle array fields (data-array + data-idx)
      if (input.dataset.array) {
        const arr = model[input.dataset.array];
        const idx = parseInt(input.dataset.idx);
        if (arr && arr[idx] !== undefined) {
          arr[idx][field] = val;
          // Labor: recompute annual_hours + re-render so Hrs/Yr, FTE, Annual Cost, override badge refresh
          if (input.dataset.array === 'laborLines' && (field === 'volume' || field === 'base_uph')) {
            recomputeLineHours(arr[idx]);
            isDirty = true;
            if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
            renderSection();
            return;
          }
        }
      } else {
        // Dot-path assignment
        setNestedValue(model, field, val);
      }

      isDirty = true;
      if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
      // Re-render if the field affects calculated values
      if (shouldRerender(field)) renderSection();
    });
  });

  // MOST per-row template picker (data-most-select)
  container.querySelectorAll('[data-most-select]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx);
      applyMostTemplate(idx, sel.value);
    });
  });

  // v2 Labor — click a master-detail item to select it (updates detail pane)
  container.querySelectorAll('[data-labor-select]').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't hijack clicks on inputs/buttons/selects inside the item
      if (e.target.closest('input, button, select, textarea')) return;
      const idx = parseInt(item.dataset.laborSelect, 10);
      if (!Number.isNaN(idx) && idx !== _selectedLaborIdx) {
        _selectedLaborIdx = idx;
        renderSection();
      }
    });
  });

  // v2 Labor — up/down arrow keys on the master pane cycle selection
  // (ignored when focus is inside an input/select/textarea so typing isn't hijacked)
  if (section === 'labor' && isCmV2UiOn()) {
    const masterBody = container.querySelector('.hub-master-detail__master-body');
    if (masterBody) {
      // Make focusable so it can receive keydown
      masterBody.setAttribute('tabindex', '0');
      masterBody.addEventListener('keydown', (e) => {
        if (e.target !== masterBody) return; // only when pane itself is focused
        const lines = model.laborLines || [];
        if (!lines.length) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          _selectedLaborIdx = Math.min(lines.length - 1, (_selectedLaborIdx ?? -1) + 1);
          renderSection();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          _selectedLaborIdx = Math.max(0, (_selectedLaborIdx ?? 0) - 1);
          renderSection();
        } else if (e.key === 'Home') {
          e.preventDefault();
          _selectedLaborIdx = 0;
          renderSection();
        } else if (e.key === 'End') {
          e.preventDefault();
          _selectedLaborIdx = lines.length - 1;
          renderSection();
        }
      });
    }
  }

  // Direct-labor Volume source picker — dropdown of volumeLines + "Custom".
  // Selecting a volume line syncs the labor line's volume to that line's value.
  container.querySelectorAll('[data-labor-volume-source]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx);
      const line = (model.laborLines || [])[idx];
      if (!line) return;
      const val = sel.value;
      if (val === 'custom' || val === '') {
        line.volume_source_idx = null; // user wants manual value
      } else {
        const srcIdx = parseInt(val);
        const src = (model.volumeLines || [])[srcIdx];
        if (src) {
          line.volume_source_idx = srcIdx;
          line.volume = src.volume || 0;
          recomputeLineHours(line);
        }
      }
      isDirty = true;
      if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
      renderSection();
    });
  });

  // Action buttons
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.idx);
      // Template-detail viewer needs the template id, not just the row idx
      if (action === 'view-most-template') {
        openMostTemplateDetail(btn.dataset.templateId);
        return;
      }
      handleAction(action, idx);
    });
  });

  // Star buttons (volumes)
  container.querySelectorAll('.cm-star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      model.volumeLines.forEach((l, i) => l.isOutboundPrimary = i === idx);
      renderSection();
    });
  });

  // Phase 4b: per-row labor seasonality editor (monthly OT/absence)
  container.querySelectorAll('[data-cm-action="edit-labor-seasonality"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      openLaborSeasonalityModal(idx);
    });
  });

  // Phase 5a: scenario xlsx export (on Summary)
  container.querySelector('[data-cm-action="export-scenario-xlsx"]')?.addEventListener('click', () => {
    exportScenarioToXlsx();
  });

  // I-01: Summary "Fix in Pricing" shortcut
  container.querySelector('[data-cm-action="go-pricing"]')?.addEventListener('click', () => {
    navigateSection('pricing');
  });

  // --------------------------------------------------------------
  // Phase 5b: What-If Studio event wiring
  // --------------------------------------------------------------
  if (section === 'whatif') {
    const applySliderUpdate = (key, raw) => {
      const v = raw === '' ? '' : Number(raw);
      whatIfTransient = { ...whatIfTransient, [key]: v };
      // Mirror the slider and the number input together
      const slider = container.querySelector(`[data-whatif-slider="${key}"]`);
      const number = container.querySelector(`[data-whatif-number="${key}"]`);
      if (slider && String(slider.value) !== String(raw)) slider.value = raw;
      if (number && String(number.value) !== String(raw)) number.value = raw;
      // Debounce the full re-render (recompute is cheap but avoid churn on drag)
      if (_whatIfDebounce) clearTimeout(_whatIfDebounce);
      _whatIfDebounce = setTimeout(() => { _whatIfDebounce = null; renderSection(); }, 120);
    };

    container.querySelectorAll('[data-whatif-slider]').forEach(inp => {
      // input event fires during drag; change fires on release
      inp.addEventListener('change', () => applySliderUpdate(inp.dataset.whatifSlider, inp.value));
      // Mirror the number input DURING drag for responsiveness
      inp.addEventListener('input', () => {
        const key = inp.dataset.whatifSlider;
        const number = container.querySelector(`[data-whatif-number="${key}"]`);
        if (number) number.value = inp.value;
      });
    });
    container.querySelectorAll('[data-whatif-number]').forEach(inp => {
      inp.addEventListener('change', () => applySliderUpdate(inp.dataset.whatifNumber, inp.value));
    });

    container.querySelector('[data-cm-action="whatif-reset"]')?.addEventListener('click', async () => {
      const ok = await showConfirm('Reset all What-If sliders?\n\nThis discards the transient overlay and returns to your persisted assumptions.', { okLabel: 'Reset' });
      if (!ok) return;
      whatIfTransient = {};
      renderSection();
    });

    container.querySelector('[data-cm-action="whatif-apply"]')?.addEventListener('click', async () => {
      const keys = Object.keys(whatIfTransient).filter(k => whatIfTransient[k] !== '' && whatIfTransient[k] !== undefined);
      if (keys.length === 0) return;
      const msg = `Commit ${keys.length} What-If slider value${keys.length === 1 ? '' : 's'} as scenario overrides?\n\n` +
                  keys.map(k => `  • ${k} → ${whatIfTransient[k]}`).join('\n') +
                  `\n\nThis writes to heuristic_overrides on the project and affects every subsequent calc.`;
      const ok = await showConfirm(msg, { okLabel: 'Apply overrides' });
      if (!ok) return;
      // Merge transient into persistent overrides
      const merged = { ...heuristicOverrides };
      for (const k of keys) merged[k] = whatIfTransient[k];
      heuristicOverrides = merged;
      if (model?.id) {
        try { await api.saveHeuristicOverrides(model.id, heuristicOverrides); }
        catch (err) { showToast('Save failed: ' + (err?.message || err), 'error'); return; }
      } else {
        model.heuristicOverrides = heuristicOverrides;
      }
      whatIfTransient = {};
      showToast(`Applied ${keys.length} override${keys.length === 1 ? '' : 's'}`, 'success');
      renderSection();
    });
  }

  // Phase 4c/d: fire-and-forget market-profile load on Summary/Timeline open
  if (section === 'summary' || section === 'timeline') {
    ensureMarketLaborProfileLoaded().then(fresh => {
      // Only re-render on a truly fresh fetch to avoid an infinite loop.
      if (fresh) renderSection();
    });
  }

  // --------------------------------------------------------------
  // Phase 3: Assumptions section event wiring
  // --------------------------------------------------------------
  if (section === 'assumptions') {
    // First-open: lazy-load catalog + overrides, then re-render.
    // Guarded against re-entry so the post-load renderSection can't
    // trigger another load if the catalog happens to still be empty
    // (API error, no rows, etc.).
    if (heuristicsCatalog.length === 0 && !_heuristicsLoadInFlight) {
      _heuristicsLoadInFlight = true;
      ensureHeuristicsLoaded()
        .finally(() => { _heuristicsLoadInFlight = false; })
        .then(() => renderSection());
    }
    // Heuristic value input → merge into overrides jsonb
    container.querySelectorAll('[data-heuristic-input]').forEach(inp => {
      const evt = inp.tagName === 'SELECT' ? 'change' : 'change';
      inp.addEventListener(evt, async (e) => {
        const key = inp.dataset.heuristicInput;
        const raw = inp.value;
        const def = heuristicsCatalog.find(h => h.key === key);
        if (!def) return;
        const issue = scenarios.validateHeuristic(def, raw);
        if (issue) { console.warn('[CM] heuristic validation:', issue); return; }
        const value = def.data_type === 'enum' ? raw : (raw === '' ? null : Number(raw));
        const merged = { ...heuristicOverrides };
        if (value === null || value === undefined || value === '') delete merged[key];
        else merged[key] = value;
        heuristicOverrides = merged;
        // Persist if we have a saved project
        if (model?.id) {
          try {
            await api.saveHeuristicOverrides(model.id, heuristicOverrides);
            isDirty = false;
          } catch (err) {
            console.warn('[CM] saveHeuristicOverrides failed:', err);
          }
        } else {
          model.heuristicOverrides = heuristicOverrides;
          isDirty = true;
        }
        renderSection();
      });
    });
    // Reset-per-row + reset-all
    container.querySelectorAll('[data-cm-action="reset-heuristic"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.heuristicKey;
        const merged = { ...heuristicOverrides };
        delete merged[key];
        heuristicOverrides = merged;
        if (model?.id) {
          try { await api.saveHeuristicOverrides(model.id, heuristicOverrides); } catch (_) {}
        } else {
          model.heuristicOverrides = heuristicOverrides;
        }
        renderSection();
      });
    });
    container.querySelector('[data-cm-action="reset-all-heuristics"]')?.addEventListener('click', async () => {
      const ok = await showConfirm('Reset all heuristics on this scenario to standard defaults?', { okLabel: 'Reset' });
      if (!ok) return;
      heuristicOverrides = {};
      if (model?.id) {
        try { await api.saveHeuristicOverrides(model.id, heuristicOverrides); } catch (_) {}
      } else {
        model.heuristicOverrides = heuristicOverrides;
      }
      renderSection();
    });

    // --------------------------------------------------------------
    // Phase 6: Planning Ratios event wiring (ref_planning_ratios)
    // --------------------------------------------------------------
    if (isPlanningRatiosFlagOn()) {
      // Lazy-load once; then re-render so the catalog is visible.
      if (planningRatiosCatalog.length === 0 && !_planningRatiosLoadInFlight) {
        ensurePlanningRatiosLoaded().then(() => renderSection());
      }
      // Toggle category expand/collapse
      container.querySelectorAll('[data-pr-toggle-category]').forEach(btn => {
        btn.addEventListener('click', () => {
          const code = btn.dataset.prToggleCategory;
          _planningRatioOpenCategory = (_planningRatioOpenCategory === code) ? null : code;
          renderSection();
        });
      });
      // Planning-ratio value override
      container.querySelectorAll('[data-pr-input]').forEach(inp => {
        inp.addEventListener('change', async () => {
          const code = inp.dataset.prInput;
          const raw = inp.value;
          const merged = { ...planningRatioOverrides };
          if (raw === '' || raw === null || raw === undefined) {
            delete merged[code];
          } else {
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            merged[code] = { value: n, updated_at: new Date().toISOString() };
          }
          planningRatioOverrides = merged;
          if (model?.id) {
            try {
              await api.savePlanningRatioOverrides(model.id, planningRatioOverrides);
              isDirty = false;
            } catch (err) {
              console.warn('[CM] savePlanningRatioOverrides failed:', err);
            }
          } else {
            model.planningRatioOverrides = planningRatioOverrides;
            isDirty = true;
          }
          renderSection();
        });
      });
      // Reset single planning ratio
      container.querySelectorAll('[data-cm-action="reset-planning-ratio"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const code = btn.dataset.prCode;
          const merged = { ...planningRatioOverrides };
          delete merged[code];
          planningRatioOverrides = merged;
          if (model?.id) {
            try { await api.savePlanningRatioOverrides(model.id, planningRatioOverrides); } catch (_) {}
          } else {
            model.planningRatioOverrides = planningRatioOverrides;
          }
          renderSection();
        });
      });
    }
  }

  // --------------------------------------------------------------
  // Phase 3: Scenarios section event wiring
  // --------------------------------------------------------------
  if (section === 'scenarios') {
    // Lazy-load once per section open. The previous implementation
    // checked (!currentScenario && dealScenarios.length === 0) and
    // triggered the loader on every render — which looped forever when
    // the project genuinely has no scenario record (load returns empty,
    // condition is still true, re-renders, re-fires load, ...).
    if (!_scenariosLoadedOnce && !_scenariosLoadInFlight) {
      _scenariosLoadInFlight = true;
      ensureScenariosLoaded()
        .finally(() => {
          _scenariosLoadInFlight = false;
          _scenariosLoadedOnce = true;
        })
        .then(() => renderSection());
    }
    // Field edits on current scenario
    container.querySelectorAll('[data-scenario-field]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const field = inp.dataset.scenarioField;
        if (!currentScenario) return;
        const patch = { id: currentScenario.id };
        if (field === 'label') patch.scenario_label = inp.value;
        if (field === 'description') patch.scenario_description = inp.value;
        try {
          currentScenario = await api.saveScenario(patch);
          await ensureScenariosLoaded();
          renderSection();
        } catch (err) { console.warn('[CM] save scenario field failed:', err); }
      });
    });

    const act = (name) => container.querySelector(`[data-cm-action="${name}"]`);

    act('scenario-save-header')?.addEventListener('click', () => {
      // Field changes auto-save on blur; this button is just a reassurance
      showToast('Scenario fields auto-save on change', 'success');
    });

    act('scenario-to-review')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      currentScenario = await api.saveScenario({ id: currentScenario.id, status: 'review' });
      renderSection();
    });
    act('scenario-to-draft')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      currentScenario = await api.saveScenario({ id: currentScenario.id, status: 'draft' });
      renderSection();
    });
    act('scenario-archive')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      const ok = await showConfirm('Archive this scenario?\n\nSnapshots are preserved; status moves to "archived".',
        { okLabel: 'Archive', danger: true });
      if (!ok) return;
      currentScenario = await api.archiveScenario(currentScenario.id);
      showToast('Scenario archived', 'success');
      renderSection();
    });
    act('scenario-approve')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      const ok = await showConfirm(
        'Approve this scenario?\n\nAll active rate cards (labor, facility, utility, overhead, equipment) and the heuristics catalog will be frozen as snapshots. You will no longer be able to edit this scenario — further changes will spawn a child scenario.',
        { okLabel: 'Approve + Freeze', danger: false }
      );
      if (!ok) return;
      try {
        const email = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ies_user_email') : null);
        const result = await api.approveScenarioRpc(currentScenario.id, email);
        console.log('[CM] approve result:', result);
        // Write a revision row via the client so the log captures this event
        try {
          const prev = await api.getLatestRevisionNumber(currentScenario.id);
          const row = scenarios.buildRevisionRow(
            currentScenario.id, prev, email,
            `Approved — ${result?.snap_labor || 0} labor + ${result?.snap_facility || 0} facility + ${result?.snap_heuristics || 0} heuristic snapshots frozen`,
            { overrides: heuristicOverrides },
            { snap_counts: result }
          );
          await api.writeRevision(row);
        } catch (revErr) { console.warn('[CM] writeRevision on approve failed:', revErr); }
        await ensureScenariosLoaded();
        renderSection();
      } catch (err) {
        console.error('[CM] approve failed:', err);
        showToast('Approval failed: ' + (err?.message || err), 'error');
      }
    });
    act('scenario-clone')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      const label = await showPrompt('Label for the new child scenario?',
        (currentScenario.scenario_label || 'Scenario') + ' (child)');
      if (label === null) return;
      try {
        const { scenario: newScen, projectId: newProjId } = await api.cloneScenario(currentScenario.id, label.trim() || null);
        showToast(`Child scenario #${newScen.id} created on project #${newProjId}. Open it from the list below.`, 'success');
        await ensureScenariosLoaded();
        renderSection();
      } catch (err) {
        console.error('[CM] clone failed:', err);
        showToast('Clone failed: ' + (err?.message || err), 'error');
      }
    });
    act('scenario-init')?.addEventListener('click', async () => {
      if (!model?.id) {
        showToast('Save the project first, then initialize a scenario.', 'warning');
        return;
      }
      try {
        currentScenario = await api.saveScenario({
          project_id: model.id,
          deal_id: model?.projectDetails?.dealId || model?.deal_deals_id || null,
          scenario_label: model?.scenario_label || 'Baseline',
          is_baseline: true,
          status: 'draft',
        });
        await ensureScenariosLoaded();
        showToast('Scenario initialized', 'success');
        renderSection();
      } catch (err) { showToast('Init failed: ' + (err?.message || err), 'error'); }
    });
    act('scenarios-compare-picker')?.addEventListener('click', () => {
      openCompareModal();
    });
    container.querySelectorAll('[data-cm-action="scenario-open"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const projId = parseInt(btn.dataset.projectId);
        if (!projId) return;
        // Hand off to the existing open-model flow
        window.location.hash = `#/cost-model/${projId}`;
      });
    });
  }
}

/**
 * Compare-scenarios modal. Lists every scenario on this deal with a
 * checkbox; pick 2-3 then click Compare. Renders the kpiDelta grid +
 * monthly P&L delta table using calc.scenarios.compareScenarios.
 */
async function openCompareModal() {
  if (!Array.isArray(dealScenarios) || dealScenarios.length < 2) return;
  const overlay = document.createElement('div');
  overlay.className = 'hub-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:white;border-radius:8px;padding:24px;min-width:640px;max-width:95vw;max-height:90vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">Compare Scenarios</h3>
        <button class="hub-btn" data-close>×</button>
      </div>
      <p class="cm-subtle" style="margin-top:4px;">Select 2–3 scenarios to diff aligned KPIs + monthly cashflow.</p>
      <div style="max-height:240px;overflow:auto;margin-top:12px;">
        ${dealScenarios.map(sc => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;">
            <input type="checkbox" data-compare-id="${sc.id}" data-project-id="${sc.project_id}" />
            <span style="flex:1;">${sc.scenario_label}${sc.is_baseline ? ' ⭐' : ''}</span>
            <span class="hub-status-chip" style="background:${STATUS_COLORS[sc.status] || '#6b7280'};color:white;">${sc.status}</span>
          </label>
        `).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button class="hub-btn" data-close>Cancel</button>
        <button class="hub-btn-primary" data-run-compare>Compare →</button>
      </div>
      <div id="cm-compare-result" style="margin-top:16px;"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => overlay.remove()));
  overlay.querySelector('[data-run-compare]').addEventListener('click', async () => {
    const picked = Array.from(overlay.querySelectorAll('[data-compare-id]:checked')).map(el => ({
      scenarioId: parseInt(el.dataset.compareId),
      projectId: parseInt(el.dataset.projectId),
    }));
    if (picked.length < 2 || picked.length > 3) { showToast('Pick 2 or 3 scenarios to compare.', 'warning'); return; }
    const resultEl = overlay.querySelector('#cm-compare-result');
    resultEl.innerHTML = '<em>Loading projections…</em>';
    // Fetch monthly projections for each picked project; build minimal bundles
    const bundles = await Promise.all(picked.map(async (p) => {
      const monthly = await api.fetchMonthlyProjections(p.projectId).catch(() => []);
      const summary = monthly.reduce((a, r) => {
        a.total_revenue += (r.revenue || 0);
        a.total_opex += (r.opex || 0);
        a.ebitda += (r.ebitda || 0);
        a.net_income += (r.net_income || 0);
        a.capex += (r.capex || 0);
        return a;
      }, { total_revenue: 0, total_opex: 0, ebitda: 0, ebit: 0, net_income: 0, capex: 0, npv: 0, irr: 0, payback_months: 0 });
      const sc = dealScenarios.find(s => s.id === p.scenarioId);
      return { label: sc?.scenario_label || `#${p.scenarioId}`, summary, monthly };
    }));
    // For 2-way: compareScenarios; for 3-way: compare 1-vs-2 and 1-vs-3
    const a = bundles[0];
    const comparisons = bundles.slice(1).map(b => ({ bLabel: b.label, cmp: scenarios.compareScenarios(a, b) }));
    const fmt = n => (n == null ? '—' : (Math.abs(n) > 1e6 ? (n/1e6).toFixed(1)+'M' : Math.abs(n) > 1e3 ? (n/1e3).toFixed(0)+'K' : n.toFixed(0)));
    const fmtPct = p => (p == null ? '—' : (p > 0 ? '+' : '') + p.toFixed(1) + '%');
    resultEl.innerHTML = `
      <table class="cm-table" style="width:100%;">
        <thead>
          <tr>
            <th style="text-align:left;">KPI</th>
            <th style="text-align:right;">${a.label}</th>
            ${comparisons.map(c => `<th style="text-align:right;" colspan="2">${c.bLabel}</th>`).join('')}
          </tr>
          <tr>
            <th></th><th></th>
            ${comparisons.map(() => `<th style="text-align:right;font-size:11px;color:#666;">Value</th><th style="text-align:right;font-size:11px;color:#666;">Δ%</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${['total_revenue','total_opex','ebitda','net_income','capex'].map(k => `
            <tr>
              <td style="padding:4px 8px;font-weight:600;">${k}</td>
              <td class="cm-num">${fmt(a.summary[k])}</td>
              ${comparisons.map(c => `
                <td class="cm-num">${fmt(c.cmp.kpiDelta[k].b)}</td>
                <td class="cm-num" style="color:${(c.cmp.kpiDelta[k].diff || 0) >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">${fmtPct(c.cmp.kpiDelta[k].pct_change)}</td>
              `).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p class="cm-subtle" style="margin-top:8px;">Comparisons show the first selected scenario as baseline. Frozen scenarios reflect their snapshot rates; draft scenarios reflect current rates.</p>
    `;
  });
}

/**
 * Per-row monthly OT/absence seasonality editor (Phase 4b).
 * Opens a modal with two 12-column rows of percent inputs (one for OT,
 * one for absence). "Use Market Defaults" pulls from ref_labor_market_profiles
 * for the project's market.
 */
async function openLaborSeasonalityModal(idx) {
  const line = (model.laborLines || [])[idx];
  if (!line) return;
  const otProfile = Array.isArray(line.monthly_overtime_profile) ? [...line.monthly_overtime_profile] : null;
  const absProfile = Array.isArray(line.monthly_absence_profile) ? [...line.monthly_absence_profile] : null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtCell = (val) => (val === null || val === undefined) ? '' : (Number(val) * 100).toFixed(1);

  const overlay = document.createElement('div');
  overlay.className = 'hub-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:white;border-radius:8px;padding:24px;min-width:780px;max-width:95vw;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <h3 style="margin:0;">Monthly OT / Absence Seasonality</h3>
          <p class="cm-subtle" style="margin-top:4px;">${line.activity_name || line.role_name || `Line #${idx+1}`} — values are percent (e.g. 5 means 5%)</p>
        </div>
        <button class="hub-btn" data-close>×</button>
      </div>
      <div style="margin-top:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <strong>Overtime % per month</strong>
          <button class="hub-btn" style="font-size:11px;" data-clear-ot>Clear (use project flat)</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px;">
          ${months.map((m, mi) => `
            <div>
              <label style="font-size:11px;color:#666;display:block;text-align:center;">${m}</label>
              <input type="number" step="0.5" min="0" max="200" data-ot-month="${mi}"
                value="${otProfile ? fmtCell(otProfile[mi]) : ''}"
                placeholder=""
                style="width:100%;text-align:right;padding:4px;" />
            </div>
          `).join('')}
        </div>
      </div>
      <div style="margin-top:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <strong>Absence % per month</strong>
          <button class="hub-btn" style="font-size:11px;" data-clear-abs>Clear (use project flat)</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px;">
          ${months.map((m, mi) => `
            <div>
              <label style="font-size:11px;color:#666;display:block;text-align:center;">${m}</label>
              <input type="number" step="0.5" min="0" max="100" data-abs-month="${mi}"
                value="${absProfile ? fmtCell(absProfile[mi]) : ''}"
                style="width:100%;text-align:right;padding:4px;" />
            </div>
          `).join('')}
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:16px;border-top:1px solid #eee;padding-top:12px;">
        <button class="hub-btn" data-use-market>Use Market Defaults</button>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn" data-close>Cancel</button>
          <button class="hub-btn-primary" data-save>Save Seasonality</button>
        </div>
      </div>
      <div id="cm-seasonality-status" style="margin-top:8px;font-size:11px;color:#666;"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const status = overlay.querySelector('#cm-seasonality-status');
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => overlay.remove()));

  // Read inputs into 12-element fractional arrays. Empty cells = null
  // (means inherit). If ANY cell has a value, missing cells default to 0.
  const collect = (selectorPrefix) => {
    const arr = [];
    let hasAny = false;
    for (let m = 0; m < 12; m++) {
      const el = overlay.querySelector(`[${selectorPrefix}="${m}"]`);
      const v = el?.value?.trim();
      if (v === '' || v === undefined || v === null) { arr.push(null); }
      else { hasAny = true; arr.push(Number(v) / 100); }
    }
    if (!hasAny) return null;
    // Replace nulls with 0 so persisted profile is exactly 12 numerics
    return arr.map(x => x === null ? 0 : x);
  };

  overlay.querySelector('[data-clear-ot]')?.addEventListener('click', () => {
    overlay.querySelectorAll('[data-ot-month]').forEach(el => { el.value = ''; });
  });
  overlay.querySelector('[data-clear-abs]')?.addEventListener('click', () => {
    overlay.querySelectorAll('[data-abs-month]').forEach(el => { el.value = ''; });
  });

  overlay.querySelector('[data-use-market]')?.addEventListener('click', async () => {
    const market = model.projectDetails?.market;
    if (!market) { status.textContent = 'No market selected — pick one in Setup first.'; return; }
    status.textContent = 'Loading market profile…';
    try {
      const mp = await api.fetchLaborMarketProfile(market);
      if (!mp) { status.textContent = 'No labor market profile defined for this market.'; return; }
      const ot = Array.isArray(mp.peak_month_overtime_pct) ? mp.peak_month_overtime_pct : [];
      const abs = Array.isArray(mp.peak_month_absence_pct) ? mp.peak_month_absence_pct : [];
      for (let m = 0; m < 12; m++) {
        const otEl = overlay.querySelector(`[data-ot-month="${m}"]`);
        const absEl = overlay.querySelector(`[data-abs-month="${m}"]`);
        if (otEl && ot[m] !== undefined) otEl.value = (Number(ot[m]) * 100).toFixed(1);
        if (absEl && abs[m] !== undefined) absEl.value = (Number(abs[m]) * 100).toFixed(1);
      }
      status.textContent = `Loaded ${mp.notes || 'market defaults'} — turnover ${mp.turnover_pct_annual}%, temp premium ${mp.temp_cost_premium_pct}%. Click Save to persist to this line.`;
    } catch (e) { status.textContent = 'Load failed: ' + (e?.message || e); }
  });

  overlay.querySelector('[data-save]')?.addEventListener('click', async () => {
    const ot = collect('data-ot-month');
    const abs = collect('data-abs-month');
    const otIssue = scenarios.validateMonthlyProfile(ot);
    if (otIssue) { status.textContent = 'Overtime seasonality: ' + otIssue; return; }
    const absIssue = scenarios.validateMonthlyProfile(abs);
    if (absIssue) { status.textContent = 'Absence seasonality: ' + absIssue; return; }
    line.monthly_overtime_profile = ot;
    line.monthly_absence_profile = abs;
    if (line.id) {
      try {
        await api.saveLaborMonthlyProfile(line.id, {
          monthly_overtime_profile: ot,
          monthly_absence_profile: abs,
        });
      } catch (e) { status.textContent = 'Save failed: ' + (e?.message || e); return; }
    } else {
      isDirty = true;
    }
    overlay.remove();
    renderSection();
  });
}

// ============================================================
// PHASE 5b — WHAT-IF STUDIO (transient slider overlay + live KPI)
// ============================================================

/** Slider config — 11 high-leverage heuristics. */
const WHATIF_SLIDERS = [
  { key: 'tax_rate_pct',              label: 'Tax Rate',               group: 'Financial',    min: 0,  max: 50, step: 0.5, unit: '%' },
  { key: 'discount_rate_pct',         label: 'Discount Rate',          group: 'Financial',    min: 3,  max: 25, step: 0.25, unit: '%' },
  { key: 'target_margin_pct',         label: 'Target Margin',          group: 'Financial',    min: 0,  max: 30, step: 0.5, unit: '%' },
  { key: 'annual_volume_growth_pct',  label: 'Volume Growth',          group: 'Financial',    min: -20, max: 30, step: 0.5, unit: '%' },
  { key: 'dso_days',                  label: 'DSO',                    group: 'WC',           min: 0,  max: 120, step: 1, unit: 'days' },
  { key: 'dpo_days',                  label: 'DPO',                    group: 'WC',           min: 0,  max: 120, step: 1, unit: 'days' },
  { key: 'benefit_load_pct',          label: 'Benefit Load',           group: 'Labor',        min: 0,  max: 80, step: 1, unit: '%' },
  { key: 'overtime_pct',              label: 'Overtime %',             group: 'Labor',        min: 0,  max: 30, step: 0.5, unit: '%' },
  { key: 'absence_allowance_pct',     label: 'Absence %',              group: 'Labor',        min: 0,  max: 25, step: 0.5, unit: '%' },
  { key: 'labor_escalation_pct',      label: 'Labor Escalation / yr',  group: 'Escalation',   min: 0,  max: 15, step: 0.25, unit: '%' },
  { key: 'facility_escalation_pct',   label: 'Facility Escalation',    group: 'Escalation',   min: 0,  max: 15, step: 0.25, unit: '%' },
];

/**
 * Return the current effective value for a slider key, preferring transient
 * → override → catalog default.
 */
function whatIfCurrentValue(sliderKey) {
  if (Object.prototype.hasOwnProperty.call(whatIfTransient, sliderKey) && whatIfTransient[sliderKey] !== '') {
    return Number(whatIfTransient[sliderKey]);
  }
  if (Object.prototype.hasOwnProperty.call(heuristicOverrides, sliderKey) && heuristicOverrides[sliderKey] !== '' && heuristicOverrides[sliderKey] !== null) {
    return Number(heuristicOverrides[sliderKey]);
  }
  const def = (heuristicsCatalog || []).find(h => h.key === sliderKey);
  return def?.default_value ?? 0;
}

/** Same, but as a display string so sliders + readouts stay consistent. */
function whatIfSource(sliderKey) {
  if (Object.prototype.hasOwnProperty.call(whatIfTransient, sliderKey) && whatIfTransient[sliderKey] !== '') return 'transient';
  if (Object.prototype.hasOwnProperty.call(heuristicOverrides, sliderKey) && heuristicOverrides[sliderKey] !== '' && heuristicOverrides[sliderKey] !== null) return 'override';
  return 'default';
}

/**
 * Build a minimal what-if preview using the current model + transient overlay.
 * Returns an object with the same KPI shape the Summary KPI bar uses.
 */
function computeWhatIfPreview() {
  try {
    const market = model.projectDetails?.market;
    const fr = (refData.facilityRates || []).find(r => r.market_id === market);
    const ur = (refData.utilityRates || []).find(r => r.market_id === market);
    const opHrs = calc.operatingHours(model.shifts || {});
    const orders = (model.volumeLines || []).find(v => v.isOutboundPrimary)?.volume || 0;
    const contractYears = model.projectDetails?.contractTerm || 5;
    const fin = model.financial || {};
    const summary = calc.computeSummary({
      laborLines: model.laborLines || [],
      indirectLaborLines: model.indirectLaborLines || [],
      equipmentLines: model.equipmentLines || [],
      overheadLines: model.overheadLines || [],
      vasLines: model.vasLines || [],
      startupLines: model.startupLines || [],
      facility: model.facility || {},
      shifts: model.shifts || {},
      facilityRate: fr,
      utilityRate: ur,
      contractYears,
      targetMarginPct: fin.targetMargin || 0,
      annualOrders: orders || 1,
    });
    const calcHeur = scenarios.resolveCalcHeuristics(
      currentScenario, currentScenarioSnapshots, heuristicOverrides, fin, whatIfTransient,
    );
    const whatIfMarginFrac = (calcHeur.targetMarginPct || 0) / 100;
    const projResult = calc.buildYearlyProjections({
      years: contractYears,
      baseLaborCost: summary.laborCost,
      baseFacilityCost: summary.facilityCost,
      baseEquipmentCost: summary.equipmentCost,
      baseOverheadCost: summary.overheadCost,
      baseVasCost: summary.vasCost,
      startupAmort: summary.startupAmort,
      startupCapital: summary.startupCapital,
      baseOrders: orders || 1,
      marginPct: whatIfMarginFrac,
      volGrowthPct: calcHeur.volGrowthPct / 100,
      laborEscPct:  calcHeur.laborEscPct  / 100,
      costEscPct:   calcHeur.costEscPct   / 100,
      laborLines: model.laborLines || [],
      taxRatePct: calcHeur.taxRatePct,
      useMonthlyEngine: typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false,
      periods: (refData && refData.periods) || [],
      ramp: null,
      seasonality: model.seasonalityProfile || null,
      preGoLiveMonths: calcHeur.preGoLiveMonths,
      dsoDays:           calcHeur.dsoDays,
      dpoDays:           calcHeur.dpoDays,
      laborPayableDays:  calcHeur.laborPayableDays,
      startupLines: model.startupLines || [],
      pricingBuckets: buildEnrichedPricingBuckets(summary, whatIfMarginFrac, opHrs, contractYears),
      project_id: model.id || 0,
      _calcHeur: calcHeur,
      marketLaborProfile: currentMarketLaborProfile,
    });
    // Aggregate over the projection horizon
    const projections = projResult.projections || [];
    const totalRev = projections.reduce((s, y) => s + (y.revenue || 0), 0);
    const totalOpex = projections.reduce((s, y) => s + (y.totalCost || 0), 0);
    const totalEbitda = projections.reduce((s, y) => s + (y.ebitda || 0), 0);
    const totalNI = projections.reduce((s, y) => s + (y.netIncome || 0), 0);
    const lastCumFcf = projections.length ? (projections[projections.length - 1].cumFcf || 0) : 0;
    return {
      totalRev, totalOpex, totalEbitda, totalNI,
      ebitdaMargin: totalRev > 0 ? (totalEbitda / totalRev * 100) : 0,
      cumFcf: lastCumFcf,
      calcHeur,
    };
  } catch (err) {
    console.warn('[CM] what-if preview failed:', err);
    return null;
  }
}

function renderWhatIfStudio() {
  // Lazy-load catalog so defaults render
  if (heuristicsCatalog.length === 0 && !_heuristicsLoadInFlight) {
    _heuristicsLoadInFlight = true;
    ensureHeuristicsLoaded()
      .finally(() => { _heuristicsLoadInFlight = false; })
      .then(() => renderSection());
  }
  const preview = computeWhatIfPreview();
  const groups = new Map();
  for (const s of WHATIF_SLIDERS) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const activeCount = Object.keys(whatIfTransient).filter(k => whatIfTransient[k] !== '' && whatIfTransient[k] !== undefined).length;

  const fmt = n => (n == null ? '—' : (
    Math.abs(n) >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' :
    Math.abs(n) >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' :
    '$' + n.toFixed(0)
  ));

  const sliderRow = s => {
    const val = whatIfCurrentValue(s.key);
    const src = whatIfSource(s.key);
    const srcBadge = src === 'transient'
      ? '<span class="hub-status-chip" style="background:#7c3aed;color:white;font-size:9px;padding:1px 5px;">live</span>'
      : src === 'override'
        ? '<span class="hub-status-chip" style="background:#f59e0b;color:white;font-size:9px;padding:1px 5px;">override</span>'
        : '<span style="font-size:10px;color:var(--ies-gray-400);">default</span>';
    return `
      <div style="display:grid;grid-template-columns:1fr 100px 70px;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6;">
        <div>
          <div style="font-size:13px;font-weight:500;">${s.label} ${srcBadge}</div>
          <div style="font-size:11px;color:var(--ies-gray-400);">${s.key}</div>
        </div>
        <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${val}"
          data-whatif-slider="${s.key}" style="width:100%;" />
        <div style="display:flex;align-items:center;gap:4px;">
          <input type="number" step="${s.step}" min="${s.min}" max="${s.max}" value="${val}"
            data-whatif-number="${s.key}" style="width:55px;font-size:12px;text-align:right;" />
          <span style="font-size:11px;color:var(--ies-gray-400);">${s.unit}</span>
        </div>
      </div>
    `;
  };

  return `
    <div class="cm-section-header">
      <h2>What-If Studio
        ${activeCount > 0 ? `<span class="hub-status-chip" style="margin-left:8px;background:#7c3aed;color:white;">${activeCount} live override${activeCount === 1 ? '' : 's'}</span>` : '<span class="hub-status-chip" style="margin-left:8px;">baseline</span>'}
      </h2>
      <p class="cm-subtle">Drag sliders to preview how heuristic changes move the deal. Changes are <strong>transient</strong> — click Apply to commit as per-scenario overrides, or Reset to discard.</p>
    </div>

    <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:16px;margin-top:12px;">
      <div class="cm-card">
        ${Array.from(groups.entries()).map(([group, items]) => `
          <div style="margin-bottom:16px;">
            <div style="font-weight:600;font-size:12px;text-transform:uppercase;color:var(--ies-gray-500);letter-spacing:0.5px;margin-bottom:4px;">${group}</div>
            ${items.map(sliderRow).join('')}
          </div>
        `).join('')}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;border-top:1px solid #e5e7eb;padding-top:12px;">
          <button class="hub-btn" data-cm-action="whatif-reset" ${activeCount === 0 ? 'disabled' : ''}>Reset</button>
          <button class="hub-btn-primary" data-cm-action="whatif-apply" ${activeCount === 0 ? 'disabled' : ''}>Apply as overrides</button>
        </div>
      </div>

      <div class="cm-card" style="background:linear-gradient(180deg,#fafaff,#fff);border-left:4px solid #7c3aed;">
        <div style="font-weight:700;font-size:14px;margin-bottom:4px;">Live Preview</div>
        <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:12px;">Updates on slider release. Over the ${model.projectDetails?.contractTerm || 5}-year horizon.</div>
        ${preview ? `
          <div class="cm-whatif-kpis">
            <div class="cm-whatif-kpi"><div class="cm-whatif-kpi-label">Total Revenue</div><div class="cm-whatif-kpi-value">${fmt(preview.totalRev)}</div></div>
            <div class="cm-whatif-kpi"><div class="cm-whatif-kpi-label">Total Opex</div><div class="cm-whatif-kpi-value">${fmt(preview.totalOpex)}</div></div>
            <div class="cm-whatif-kpi"><div class="cm-whatif-kpi-label">EBITDA</div><div class="cm-whatif-kpi-value">${fmt(preview.totalEbitda)}</div></div>
            <div class="cm-whatif-kpi"><div class="cm-whatif-kpi-label">EBITDA Margin</div><div class="cm-whatif-kpi-value">${preview.ebitdaMargin.toFixed(1)}%</div></div>
            <div class="cm-whatif-kpi"><div class="cm-whatif-kpi-label">Net Income</div><div class="cm-whatif-kpi-value">${fmt(preview.totalNI)}</div></div>
            <div class="cm-whatif-kpi"><div class="cm-whatif-kpi-label">Cum FCF</div><div class="cm-whatif-kpi-value" style="color:${preview.cumFcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">${fmt(preview.cumFcf)}</div></div>
          </div>
          <style>
            /* What-If preview KPIs live in a narrow right-column card, so we
               can't use the hub-kpi-bar's auto-fill grid. Labels must wrap
               fully (not truncate to "T." / "E." / "N."). Container queries
               give us true column-aware sizing without JS measurement. */
            .cm-whatif-kpis {
              container-type: inline-size;
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 8px;
            }
            .cm-whatif-kpi {
              display: flex;
              flex-direction: column;
              padding: 10px;
              border: 1px solid var(--ies-gray-200);
              border-radius: 6px;
              background: #fff;
              min-width: 0;
            }
            .cm-whatif-kpi-label {
              font-size: clamp(10px, 1.1cqw + 9px, 12px);
              color: var(--ies-gray-500);
              font-weight: 600;
              line-height: 1.25;
              white-space: normal;        /* allow full label to wrap */
              overflow: visible;
              text-overflow: clip;
              word-break: normal;
            }
            .cm-whatif-kpi-value {
              font-size: clamp(14px, 1.6cqw + 12px, 18px);
              font-weight: 700;
              color: var(--ies-gray-900);
              margin-top: 4px;
              line-height: 1.1;
            }
            /* Collapse to single-column when the preview card is very narrow */
            @container (max-width: 240px) {
              .cm-whatif-kpis { grid-template-columns: 1fr; }
            }
            /* Fallback for browsers without container-query support */
            @supports not (container-type: inline-size) {
              .cm-whatif-kpi-label { font-size: 11px; }
              .cm-whatif-kpi-value { font-size: 15px; }
            }
          </style>
          <div style="margin-top:12px;font-size:11px;color:var(--ies-gray-500);">
            Tip: combine sliders (e.g. DSO↑ + margin↓) to stress-test the deal.
          </div>
        ` : `
          <div style="text-align:center;padding:24px;color:var(--ies-gray-400);">
            <em>No preview available — populate Labor + Pricing sections first.</em>
          </div>
        `}
      </div>
    </div>
  `;
}
// ============================================================
// LINKED DESIGNS — reverse-direction linkage from CM to design tools
// ============================================================

// Module-local cache for this render; async load kicks off on section enter.
let linkedDesigns = null; // { wsc:[], cog:[], netopt:[], fleet:[] }
let _linkedDesignsLoadInFlight = false;

// Local escape helper (CM ui.js has no shared escapeHtml import)
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function ensureLinkedDesignsLoaded() {
  if (!model?.id) return;
  if (linkedDesigns !== null) return;
  if (_linkedDesignsLoadInFlight) return;
  _linkedDesignsLoadInFlight = true;
  try {
    linkedDesigns = await api.listLinkedDesignScenarios(model.id);
  } catch (err) {
    console.warn('[CM] linked-designs load failed:', err);
    linkedDesigns = { wsc: [], cog: [], netopt: [], fleet: [] };
  } finally {
    _linkedDesignsLoadInFlight = false;
  }
}

function renderLinkedDesigns() {
  if (!model?.id) {
    return `
      <div class="cm-section-header">
        <div>
          <div class="cm-section-title">Linked Designs</div>
          <div class="cm-section-desc">Save this model before linking design scenarios.</div>
        </div>
      </div>`;
  }
  if (linkedDesigns === null) {
    ensureLinkedDesignsLoaded().then(() => renderSection());
    return `
      <div class="cm-section-header">
        <div>
          <div class="cm-section-title">Linked Designs</div>
          <div class="cm-section-desc">Loading linked design scenarios…</div>
        </div>
      </div>`;
  }
  const groups = [
    { key: 'wsc',    label: 'Warehouse Sizing',   icon: '🏭', route: 'designtools/warehouse-sizing' },
    { key: 'cog',    label: 'Center of Gravity',  icon: '📍', route: 'designtools/center-of-gravity' },
    { key: 'netopt', label: 'Network Optimizer',  icon: '🕸',  route: 'designtools/network-opt' },
    { key: 'fleet',  label: 'Fleet Modeler',      icon: '🚚', route: 'designtools/fleet-modeler' },
  ];
  const totalLinked = groups.reduce((s, g) => s + (linkedDesigns[g.key] || []).length, 0);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Linked Designs</div>
        <div class="cm-section-desc">Design scenarios pointing back at this Cost Model via <code>parent_cost_model_id</code>. Click a row to open the scenario in its tool.</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="hub-badge hub-badge-info">${totalLinked} linked</span>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="linked-refresh" title="Re-query linked scenarios">Refresh</button>
      </div>
    </div>

    ${totalLinked === 0 ? `
      <div class="hub-card" style="padding:24px;text-align:center;color:var(--ies-gray-500);font-size:13px;">
        No design scenarios linked to this Cost Model yet.<br>
        Open a design tool (WSC / COG / NetOpt / Fleet), save a scenario, and select this Cost Model as its parent.
      </div>
    ` : groups.map(g => {
      const rows = linkedDesigns[g.key] || [];
      if (rows.length === 0) return '';
      return `
        <div class="hub-card mt-4">
          <div class="text-subtitle mb-2">${g.icon} ${g.label} <span style="color:var(--ies-gray-400);font-weight:500;font-size:11px;">(${rows.length})</span></div>
          <table class="cm-grid-table" style="font-size:13px;">
            <thead>
              <tr><th>Scenario</th><th style="width:160px;">Last Updated</th><th style="width:90px;text-align:right;">Action</th></tr>
            </thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td style="font-weight:600;">${_esc(r.name)}</td>
                  <td style="color:var(--ies-gray-500);">${r.updated ? new Date(r.updated).toLocaleString() : '—'}</td>
                  <td style="text-align:right;"><a class="hub-btn hub-btn-sm hub-btn-secondary" href="#${g.route}?scenario=${encodeURIComponent(r.id)}" title="Open in ${g.label}" style="font-size:11px;padding:3px 8px;">Open →</a></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }).filter(Boolean).join('')}
  `;
}

// ============================================================
// PHASE 4e — SENSITIVITY (MONTE CARLO) CARD
// ============================================================

/**
 * Render the Monte-Carlo labor-cost sensitivity card for Summary.
 * Runs 1000 trials against the active labor lines + calcHeur. Only
 * renders when at least one labor line has performance_variance_pct > 0.
 * Uses a seeded RNG so repeated renders are stable within a session.
 */
function renderSensitivityCard() {
  const lines = model?.laborLines || [];
  const withVar = lines.filter(l => Number(l.performance_variance_pct) > 0);
  if (withVar.length === 0 || !_lastCalcHeuristics) return '';
  // Seed from a hash of the current labor config so the output is stable
  // until inputs change. Stakeholder-friendly.
  const seedStr = JSON.stringify(lines.map(l => [l.id, l.hourly_rate, l.annual_hours, l.performance_variance_pct, l.employment_type]));
  let seed = 1;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rng = scenarios.mulberry32(seed);
  const result = scenarios.simulateLaborVariance(lines, _lastCalcHeuristics, currentMarketLaborProfile, 1000, rng);
  if (!result || result.nTrials === 0) return '';

  const fmt = n => (n == null ? '—' : (
    Math.abs(n) >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' :
    Math.abs(n) >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' :
    '$' + n.toFixed(0)
  ));
  const band = result.p90 - result.p10;
  const bandPct = result.p50 !== 0 ? (band / result.p50 * 100) : 0;

  return `
    <div class="hub-card mb-4" style="border-left:4px solid #7c3aed;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div>
          <div style="font-size:14px;font-weight:700;">Labor Cost Sensitivity</div>
          <div style="font-size:11px;color:var(--ies-gray-500);">${result.nTrials.toLocaleString()} Monte-Carlo trials · ${withVar.length} of ${lines.length} lines have variance set</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:var(--ies-gray-500);">80% band width</div>
          <div style="font-size:14px;font-weight:700;">${fmt(band)} (${bandPct.toFixed(1)}%)</div>
        </div>
      </div>
      <div class="hub-kpi-bar" style="grid-template-columns:repeat(4, 1fr);">
        <div class="hub-kpi-item">
          <div class="hub-kpi-label" style="color:#059669;">P10 (optimistic)</div>
          <div class="hub-kpi-value">${fmt(result.p10)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label">P50 (median)</div>
          <div class="hub-kpi-value">${fmt(result.p50)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label" style="color:#dc2626;">P90 (pessimistic)</div>
          <div class="hub-kpi-value">${fmt(result.p90)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label">StdDev</div>
          <div class="hub-kpi-value">${fmt(result.stddev)}</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);">
        Each trial draws an independent Gaussian productivity shock per labor line. Positive shock = more productive → fewer hours. Set <strong>performance_variance_pct</strong> per line in the Labor section to tune.
      </div>
    </div>
  `;
}

// ============================================================
// PHASE 5a — SCENARIO XLSX EXPORT
// ============================================================

/**
 * Build the multi-sheet xlsx payload for the active scenario.
 * Pure function returning the sheet configuration; caller invokes
 * downloadXLSX. Kept here (not in calc.*) because it pulls from
 * module-local state (model, currentScenario, heuristics, etc.).
 *
 * @returns {{ filename: string, sheets: any[] }}
 */
function buildScenarioExportPayload() {
  const scen = currentScenario;
  const snaps = currentScenarioSnapshots;
  const isFrozen = !!(scen && scen.status === 'approved' && snaps);
  const bundle = _lastMonthlyBundle;
  const calcHeur = _lastCalcHeuristics;
  const proj = model?.projectDetails || {};
  const fin = model?.financial || {};
  const nameSlug = (proj.name || 'cost_model')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const today = new Date().toISOString().slice(0, 10);
  const filename = `cm_${nameSlug}_${scen?.scenario_label || 'draft'}_${today}.xlsx`.replace(/\s+/g, '_');

  // ----- Sheet 1: Overview -----
  const overviewRows = [
    { Field: 'Project Name',        Value: proj.name || '' },
    { Field: 'Client',              Value: proj.clientName || '' },
    { Field: 'Market',              Value: (refData.markets || []).find(m => m.id === proj.market)?.name || proj.market || '' },
    { Field: 'Environment',         Value: proj.environment || '' },
    { Field: 'Contract Term (yrs)', Value: proj.contractTerm || 5 },
    { Field: '',                    Value: '' },
    { Field: 'Scenario ID',         Value: scen?.id ?? '' },
    { Field: 'Scenario Label',      Value: scen?.scenario_label || 'draft' },
    { Field: 'Scenario Status',     Value: scen?.status || 'draft' },
    { Field: 'Is Baseline',         Value: scen?.is_baseline ? 'Yes' : 'No' },
    { Field: 'Parent Scenario ID',  Value: scen?.parent_scenario_id ?? '' },
    { Field: 'Approved At',         Value: scen?.approved_at || '' },
    { Field: 'Approved By',         Value: scen?.approved_by || '' },
    { Field: '',                    Value: '' },
    { Field: 'Reading Frozen Rates?', Value: isFrozen ? 'YES — ref_* snapshots' : 'No — live rate cards' },
    { Field: 'Exported At',         Value: new Date().toISOString() },
    { Field: 'Exported By',         Value: (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ies_user_email') : '') || '(anonymous)' },
  ];

  // ----- Sheet 2: KPI snapshot -----
  const kpiRows = [];
  if (bundle && Array.isArray(bundle.cashflow)) {
    const totalRev = bundle.cashflow.reduce((s, r) => s + (r.revenue || 0), 0);
    const totalOpex = bundle.cashflow.reduce((s, r) => s + (r.opex || 0), 0);
    const totalEbitda = bundle.cashflow.reduce((s, r) => s + (r.ebitda || 0), 0);
    const totalNI = bundle.cashflow.reduce((s, r) => s + (r.net_income || 0), 0);
    const totalCapex = bundle.cashflow.reduce((s, r) => s + (r.capex || 0), 0);
    const lastCFCF = bundle.cashflow.length > 0
      ? bundle.cashflow.reduce((_, r) => r.cumulative_cash_flow, 0)
      : 0;
    kpiRows.push({ Metric: 'Total Revenue',        Value: totalRev },
                 { Metric: 'Total Opex',           Value: totalOpex },
                 { Metric: 'Total EBITDA',         Value: totalEbitda },
                 { Metric: 'Total Net Income',     Value: totalNI },
                 { Metric: 'Total Capex',          Value: totalCapex },
                 { Metric: 'Ending Cumulative FCF', Value: lastCFCF },
                 { Metric: 'EBITDA Margin',        Value: totalRev > 0 ? (totalEbitda / totalRev * 100) : 0 });
  }

  // ----- Sheet 3: Monthly P&L (flat wide view) -----
  const monthlyRows = [];
  if (bundle && Array.isArray(bundle.cashflow)) {
    const periodById = new Map((bundle.periods || []).map(p => [p.id, p]));
    const revByPeriod = new Map(); const expByPeriod = new Map();
    for (const r of (bundle.revenue || [])) {
      if (!revByPeriod.has(r.period_id)) revByPeriod.set(r.period_id, 0);
      revByPeriod.set(r.period_id, revByPeriod.get(r.period_id) + (r.amount || 0));
    }
    for (const e of (bundle.expense || [])) {
      if (!expByPeriod.has(e.period_id)) expByPeriod.set(e.period_id, {});
      const m = expByPeriod.get(e.period_id);
      m[e.expense_line_code] = (m[e.expense_line_code] || 0) + (e.amount || 0);
    }
    for (const cf of bundle.cashflow) {
      const p = periodById.get(cf.period_id);
      const exp = expByPeriod.get(cf.period_id) || {};
      monthlyRows.push({
        Period:        p?.label || '',
        CalYear:       p?.calendar_year || '',
        CalMonth:      p?.calendar_month || '',
        PreGoLive:     p?.is_pre_go_live ? 'Yes' : 'No',
        Revenue:       cf.revenue || 0,
        LaborHourly:   exp.LABOR_HOURLY || 0,
        Facility:      exp.FACILITY || 0,
        Equipment:     exp.EQUIPMENT_LEASE || 0,
        Overhead:      exp.OVERHEAD || 0,
        VAS:           exp.VAS || 0,
        StartupAmort:  exp.STARTUP_AMORT || 0,
        Depreciation:  exp.DEPRECIATION || 0,
        Opex:          cf.opex || 0,
        GrossProfit:   cf.gross_profit || 0,
        EBITDA:        cf.ebitda || 0,
        EBIT:          cf.ebit || 0,
        Taxes:         cf.taxes || 0,
        NetIncome:     cf.net_income || 0,
        Capex:         cf.capex || 0,
        WC_Delta:      cf.working_capital_change || 0,
        OperatingCF:   cf.operating_cash_flow || 0,
        FreeCashFlow:  cf.free_cash_flow || 0,
        CumFCF:        cf.cumulative_cash_flow || 0,
      });
    }
  }

  // ----- Sheet 4: Labor Lines (per-line detail incl. Phase 4 profile) -----
  const fmt12 = (arr) => Array.isArray(arr) && arr.length === 12
    ? arr.map(v => (Number(v) * 100).toFixed(1)).join(', ')
    : '';
  const laborRows = (model?.laborLines || []).map((l, i) => ({
    '#':              i + 1,
    Activity:         l.activity_name || '',
    Volume:           l.volume || 0,
    BaseUPH:          l.base_uph || 0,
    AnnualHours:      l.annual_hours || 0,
    Rate:             l.hourly_rate || 0,
    Burden:           l.burden_pct || 0,
    Employment:       l.employment_type || 'permanent',
    TempMarkup:       l.temp_agency_markup_pct || 0,
    OT_Profile_Pct:   fmt12(l.monthly_overtime_profile),
    Absence_Profile_Pct: fmt12(l.monthly_absence_profile),
    MOST_Template:    l.most_template_name || '',
  }));

  // ----- Sheet 5: Assumptions (heuristics with Used From source) -----
  const assumptionRows = (heuristicsCatalog || []).map(h => {
    const eff = scenarios.heuristicEffective(h, heuristicOverrides);
    let usedFrom = 'default';
    if (isFrozen && Array.isArray(snaps?.heuristics)) {
      const snap = snaps.heuristics.find(s => s.key === h.key);
      if (snap) usedFrom = 'snapshot';
    } else if (heuristicOverrides && Object.prototype.hasOwnProperty.call(heuristicOverrides, h.key)
              && heuristicOverrides[h.key] !== '' && heuristicOverrides[h.key] !== null) {
      usedFrom = 'override';
    }
    return {
      Category:   HEURISTIC_CATEGORY_LABELS[h.category] || h.category,
      Key:        h.key,
      Label:      h.label,
      Default:    h.default_value ?? h.default_enum ?? '',
      Effective:  eff ?? '',
      UsedFrom:   usedFrom,
      Unit:       h.unit || '',
      Description: h.description || '',
    };
  });

  // ----- Sheet 6: Rate Snapshots (only when frozen) -----
  const snapshotRows = [];
  if (isFrozen) {
    for (const [cardType, rows] of Object.entries(snaps || {})) {
      for (const r of rows) {
        snapshotRows.push({
          CardType:    cardType,
          CardID:      r._rate_card_id || r.id || '',
          VersionHash: r._version_hash || '',
          CapturedAt:  r._captured_at || '',
          Name:        r.role_name || r.building_type || r.category || r.name || r.key || '',
          Rate:        r.hourly_rate || r.lease_rate_psf_yr || r.monthly_cost || r.purchase_cost || r.default_value || '',
          Notes:       r.notes || r.label || '',
        });
      }
    }
  }

  // ----- Sheet 7: Revisions -----
  const revisionRows = (currentRevisions || []).map(r => ({
    RevisionNumber: r.revision_number,
    ChangedAt:      r.changed_at,
    ChangedBy:      r.changed_by || '',
    Summary:        r.change_summary || '',
  }));

  return {
    filename,
    sheets: [
      { name: 'Overview',    rows: overviewRows,    columns: [
        { key: 'Field', label: 'Field' },
        { key: 'Value', label: 'Value' },
      ] },
      { name: 'KPIs',        rows: kpiRows, columns: [
        { key: 'Metric', label: 'Metric' },
        { key: 'Value',  label: 'Value', format: 'number', decimals: 0 },
      ] },
      { name: 'Monthly P&L', rows: monthlyRows },
      { name: 'Labor',       rows: laborRows },
      { name: 'Assumptions', rows: assumptionRows },
      { name: 'Snapshots',   rows: snapshotRows.length ? snapshotRows : [{ Note: 'No snapshots — scenario is not approved.' }] },
      { name: 'Revisions',   rows: revisionRows.length ? revisionRows : [{ Note: 'No revisions logged.' }] },
    ],
  };
}

/**
 * Export the active scenario as xlsx. Triggered from the Summary
 * "Export Scenario" button.
 */
async function exportScenarioToXlsx() {
  // Ensure heuristics + scenarios are loaded so export is complete
  await ensureHeuristicsLoaded();
  await ensureScenariosLoaded();
  const payload = buildScenarioExportPayload();
  if (!payload.sheets.some(s => (s.rows || []).length > 0)) {
    showToast('Nothing to export yet — open the Summary section first to build the monthly bundle.', 'warning');
    return;
  }
  try {
    downloadXLSX(payload);
    // Audit-log the export (fire-and-forget)
    if (currentScenario?.id) {
      try {
        const { recordAudit } = await import('../../shared/audit.js?v=20260419-sZ');
        recordAudit({
          table: 'cost_model_scenarios',
          id: currentScenario.id,
          action: 'update',
          fields: { exported_at: new Date().toISOString(), format: 'xlsx' },
        }).catch(() => {});
      } catch (_) { /* ignore */ }
    }
  } catch (err) {
    console.error('[CM] export failed:', err);
    showToast('Export failed: ' + (err?.message || err), 'error');
  }
}

function shouldRerender(field) {
  return field.includes('shifts.') || field.includes('facility.') ||
         field === 'projectDetails.market' || field === 'projectDetails.contractTerm' ||
         field === 'financial.targetMargin' ||
         // I-01: reassigning a line's bucket shifts the rollup; Pricing tables must re-render.
         field === 'pricing_bucket';
}

// ============================================================
// ACTIONS (add/delete rows)
// ============================================================

function handleAction(action, idx) {
  switch (action) {
    case 'linked-refresh':
      // Force re-query of parent_cost_model_id across design-tool tables.
      linkedDesigns = null;
      ensureLinkedDesignsLoaded().then(() => renderSection());
      return;
    case 'add-volume':
      model.volumeLines.push({ name: '', volume: 0, uom: 'each', isOutboundPrimary: false });
      break;
    case 'delete-volume':
      model.volumeLines.splice(idx, 1);
      break;
    case 'add-labor':
      model.laborLines.push({ activity_name: '', volume: 0, base_uph: 0, annual_hours: 0, hourly_rate: 0, burden_pct: 30, employment_type: 'permanent', temp_agency_markup_pct: 0, performance_variance_pct: 0, pricing_bucket: defaultBucketFor('labor') });
      // v2 UI — select the newly added line so the detail pane opens to it
      _selectedLaborIdx = model.laborLines.length - 1;
      break;
    case 'delete-labor':
      model.laborLines.splice(idx, 1);
      // v2 UI — keep selected idx valid after removal
      if (_selectedLaborIdx !== null) {
        if (model.laborLines.length === 0) _selectedLaborIdx = null;
        else if (_selectedLaborIdx >= model.laborLines.length) _selectedLaborIdx = model.laborLines.length - 1;
      }
      break;
    case 'add-indirect':
      model.indirectLaborLines.push({ role_name: '', headcount: 0, hourly_rate: 0, burden_pct: 30, pricing_bucket: defaultBucketFor('indirect') });
      break;
    case 'delete-indirect':
      model.indirectLaborLines.splice(idx, 1);
      break;
    case 'auto-gen-indirect': {
      // Phase 6 — pull span-of-control from the planning ratios catalog
      // when the flag is on and we have a loaded catalog. Otherwise calc
      // falls back to its legacy hardcoded divisors.
      const prMap = (isPlanningRatiosFlagOn() && planningRatiosCatalog.length)
        ? planningRatios.resolvePlanningRatios(planningRatiosCatalog, planningRatioOverrides, {
            vertical: (model.projectDetails && model.projectDetails.vertical) || null,
            environment_type: (model.projectDetails && model.projectDetails.environment) || null,
          })
        : null;
      model.indirectLaborLines = calc.autoGenerateIndirectLabor(model, { planningRatiosMap: prMap });
      // I-01 — auto-gen paths also need default bucket assignment
      model.indirectLaborLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('indirect'); });
      break;
    }
    case 'add-equipment':
      model.equipmentLines.push({ equipment_name: '', category: 'MHE', quantity: 1, acquisition_type: 'lease', monthly_cost: 0, monthly_maintenance: 0, pricing_bucket: defaultBucketFor('equipment') });
      break;
    case 'delete-equipment':
      model.equipmentLines.splice(idx, 1);
      break;
    case 'auto-gen-equipment':
      model.equipmentLines = calc.autoGenerateEquipment(model);
      model.equipmentLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('equipment'); });
      break;
    case 'open-equipment-catalog':
      openEquipmentCatalog();
      return; // modal is async, don't re-render the section yet
    case 'add-overhead':
      model.overheadLines.push({ category: '', description: '', cost_type: 'monthly', monthly_cost: 0, pricing_bucket: defaultBucketFor('overhead') });
      break;
    case 'delete-overhead':
      model.overheadLines.splice(idx, 1);
      break;
    case 'auto-gen-overhead':
      model.overheadLines = calc.autoGenerateOverhead(model);
      model.overheadLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('overhead'); });
      break;
    case 'add-vas':
      model.vasLines.push({ service: '', rate: 0, volume: 0, pricing_bucket: defaultBucketFor('vas') });
      break;
    case 'delete-vas':
      model.vasLines.splice(idx, 1);
      break;
    case 'add-startup':
      model.startupLines.push({ description: '', one_time_cost: 0, pricing_bucket: defaultBucketFor('startup') });
      break;
    case 'delete-startup':
      model.startupLines.splice(idx, 1);
      break;
    case 'auto-gen-startup':
      model.startupLines = calc.autoGenerateStartup(model);
      model.startupLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('startup'); });
      break;
    // Pricing Buckets (v2 — taxonomy editor in the Structure phase)
    case 'add-bucket': {
      model.pricingBuckets = model.pricingBuckets || [];
      // Generate a unique id slug
      const nextId = `bucket_${Date.now().toString(36).slice(-5)}`;
      model.pricingBuckets.push({
        id: nextId,
        name: '',
        type: 'variable',
        uom: 'order',
        rate: 0,
        description: '',
      });
      break;
    }
    case 'delete-bucket': {
      const removed = (model.pricingBuckets || [])[idx];
      model.pricingBuckets.splice(idx, 1);
      // Null out any lines that referenced this bucket so they show up as
      // unassigned in the Pricing section (better than silently re-pointing).
      const reassign = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const l of arr) {
          if (l && l.pricing_bucket === removed?.id) l.pricing_bucket = '';
        }
      };
      reassign(model.laborLines);
      reassign(model.indirectLaborLines);
      reassign(model.equipmentLines);
      reassign(model.overheadLines);
      reassign(model.vasLines);
      reassign(model.startupLines);
      // Clear financial.facilityBucketId if it pointed here
      if (model.financial && model.financial.facilityBucketId === removed?.id) {
        model.financial.facilityBucketId = '';
      }
      break;
    }
    case 'apply-bucket-starter': {
      // Clone the starter template so mutations don't bleed into the const
      model.pricingBuckets = STARTER_PRICING_BUCKETS.map(b => ({ ...b }));
      break;
    }
    case 'jump-to-buckets':
      navigateSection('pricingBuckets');
      return;
    case 'launch-wsc':
      bus.emit('cm:push-to-wsc', { clearHeight: model.facility?.clearHeight || 0, totalSqft: model.facility?.totalSqft || 0 });
      state.set('nav.tool', 'warehouse-sizing');
      window.location.hash = '#designtools/warehouse-sizing';
      return; // don't re-render
    case 'reset-most-uph':
      resetMostUph(idx);
      return; // resetMostUph already re-renders
  }
  isDirty = true;
  renderSection();
}

// ============================================================
// MOST TEMPLATE → LABOR LINE INTEGRATION (per-row)
// ============================================================

/**
 * Apply (or clear) a MOST template to a specific labor line.
 * Fills most_template_id / most_template_name; auto-fills activity_name if blank,
 * base_uph if unset or still matching a previous template, uom if set on template,
 * process_area + labor_category when we have them. Then recomputes annual_hours.
 * @param {number} idx
 * @param {string} templateId — empty string clears the selection
 */
function applyMostTemplate(idx, templateId) {
  const line = model.laborLines?.[idx];
  if (!line) return;

  if (!templateId) {
    line.most_template_id = '';
    line.most_template_name = '';
    isDirty = true;
    renderSection();
    return;
  }

  const templates = refData.mostTemplates || [];
  const tpl = templates.find(t => String(t.id) === String(templateId));
  if (!tpl) return;

  // Was the previous base_uph the old template's default? If so, it's safe to
  // overwrite with the new template's default instead of treating it as a manual override.
  const prevTplId = line.most_template_id;
  const prevTpl = prevTplId ? templates.find(t => String(t.id) === String(prevTplId)) : null;
  const prevTplUph = prevTpl ? mostTplUph(prevTpl) : 0;
  const prevWasDefault = prevTpl
    && (line.base_uph || 0) > 0
    && prevTplUph > 0
    && Math.abs((line.base_uph || 0) - prevTplUph) <= 0.5;

  const tplName = mostTplName(tpl);
  const tplUph = mostTplUph(tpl);

  line.most_template_id = tpl.id;
  line.most_template_name = tplName;

  if (!line.activity_name) line.activity_name = tplName;
  if (tpl.process_area && !line.process_area) line.process_area = tpl.process_area;
  if (tpl.labor_category && !line.labor_category) line.labor_category = tpl.labor_category;
  if (tpl.uom && !line.uom) line.uom = tpl.uom;

  // Only overwrite base_uph when it's zero or was the previous template's default.
  if ((line.base_uph || 0) === 0 || prevWasDefault) {
    line.base_uph = tplUph;
  }

  recomputeLineHours(line);

  isDirty = true;
  if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
  renderSection();
}

/**
 * Reset a labor line's base_uph back to its MOST template default.
 * @param {number} idx
 */
function resetMostUph(idx) {
  const line = model.laborLines?.[idx];
  if (!line || !line.most_template_id) return;
  const tpl = (refData.mostTemplates || []).find(t => String(t.id) === String(line.most_template_id));
  if (!tpl) return;
  const uph = mostTplUph(tpl);
  if (uph <= 0) return; // don't wipe user's uph if template has no uph
  line.base_uph = uph;
  recomputeLineHours(line);
  isDirty = true;
  renderSection();
}

/**
 * Open a read-only modal showing template details and element breakdown.
 * Elements fetched lazily via api.fetchMostElements on first open for a template.
 * @param {string} templateId
 */
async function openMostTemplateDetail(templateId) {
  if (!rootEl || !templateId) return;
  const tpl = (refData.mostTemplates || []).find(t => String(t.id) === String(templateId));
  if (!tpl) return;

  rootEl.querySelector('#cm-most-detail-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'cm-most-detail-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';

  const header = `
    <div style="padding:20px 24px 12px 24px;border-bottom:1px solid var(--ies-gray-200);">
      <div style="display:flex;align-items:start;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:16px;font-weight:700;">MOST Template — ${mostTplName(tpl) || '—'}</div>
          <div style="font-size:12px;color:var(--ies-gray-400);margin-top:2px;">${tpl.process_area || '—'} · ${tpl.labor_category || '—'} · UOM: ${tpl.uom || '—'}${tpl.wms_transaction ? ` · ${tpl.wms_transaction}` : ''}</div>
        </div>
        <button id="cm-most-detail-close" class="hub-btn hub-btn-sm hub-btn-secondary">✕ Close</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px;">
        <div style="background:var(--ies-gray-50);border-radius:6px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;">Base UPH</div>
          <div style="font-size:22px;font-weight:700;color:var(--ies-blue,#0047AB);">${Math.round(mostTplUph(tpl)).toLocaleString()}</div>
        </div>
        <div style="background:var(--ies-gray-50);border-radius:6px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;">Total TMU</div>
          <div style="font-size:22px;font-weight:700;color:var(--ies-gray-700);">${Math.round(mostTplTmu(tpl)).toLocaleString()}</div>
        </div>
        <div style="background:var(--ies-gray-50);border-radius:6px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;">Equipment</div>
          <div style="font-size:14px;font-weight:700;color:var(--ies-gray-700);margin-top:6px;">${tpl.equipment_type || '—'}</div>
        </div>
      </div>
      ${tpl.description ? `<div style="margin-top:12px;font-size:12px;color:var(--ies-gray-600);line-height:1.5;">${tpl.description}</div>` : ''}
    </div>
  `;

  modal.innerHTML = `
    <div style="background:#fff;border-radius:8px;width:min(760px,92vw);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden;">
      ${header}
      <div id="cm-most-detail-body" style="flex:1;overflow-y:auto;padding:16px 20px;">
        <div style="text-align:center;color:var(--ies-gray-400);font-size:13px;padding:24px;">Loading elements…</div>
      </div>
    </div>
  `;
  rootEl.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#cm-most-detail-close')?.addEventListener('click', close);

  // Lazy-load elements
  const body = modal.querySelector('#cm-most-detail-body');
  try {
    const elements = await api.fetchMostElements(templateId);
    const sorted = (elements || []).slice().sort((a, b) => mostElSeq(a) - mostElSeq(b));
    if (sorted.length === 0) {
      body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--ies-gray-400);font-size:13px;">No MOST elements defined for this template yet.</div>`;
      return;
    }
    const totalTmu = sorted.reduce((s, e) => s + mostElTmu(e), 0);
    const rows = sorted.map((el, i) => `
      <tr style="${i % 2 ? 'background:var(--ies-gray-50);' : ''}">
        <td style="padding:6px 10px;color:var(--ies-gray-400);">${mostElSeq(el) || (i + 1)}</td>
        <td style="padding:6px 10px;font-weight:500;">${mostElName(el) || '—'}</td>
        <td style="padding:6px 10px;font-family:monospace;font-size:11px;color:var(--ies-gray-500);">${el.most_sequence || '—'}</td>
        <td style="padding:6px 10px;text-align:right;font-weight:600;">${mostElTmu(el) || 0}</td>
        <td style="padding:6px 10px;text-align:center;">${el.is_variable ? `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:11px;">${el.variable_driver || 'Yes'}</span>` : '<span style="color:var(--ies-gray-300);">—</span>'}</td>
      </tr>
    `).join('');
    body.innerHTML = `
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">MOST Element Breakdown (${sorted.length} steps)</div>
      <div style="border:1px solid var(--ies-gray-200);border-radius:8px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="background:var(--ies-gray-50);">
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--ies-gray-400);">#</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--ies-gray-400);">Element</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--ies-gray-400);">MOST Sequence</th>
            <th style="padding:8px 10px;text-align:right;font-size:11px;color:var(--ies-gray-400);">TMU</th>
            <th style="padding:8px 10px;text-align:center;font-size:11px;color:var(--ies-gray-400);">Variable?</th>
          </tr></thead>
          <tbody>${rows}
            <tr style="background:var(--ies-gray-100);font-weight:700;">
              <td colspan="3" style="padding:8px 10px;text-align:right;">Total TMU</td>
              <td style="padding:8px 10px;text-align:right;">${totalTmu}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.warn('[CM] fetchMostElements failed:', err);
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#b91c1c;font-size:13px;">Could not load elements: ${err?.message || err}</div>`;
  }
}

// ============================================================
// EQUIPMENT CATALOG MODAL — browse ref_equipment and pick items
// ============================================================

/** @type {Array<any>} Cached after first fetch so re-open is instant. */
let catalogCache = null;

async function openEquipmentCatalog() {
  if (!rootEl) return;
  // Remove any existing modal
  rootEl.querySelector('#cm-eq-catalog-modal')?.remove();

  // Ensure catalog is loaded
  if (!catalogCache) {
    try {
      catalogCache = await api.fetchEquipmentCatalog();
    } catch (err) {
      console.warn('[CM] fetchEquipmentCatalog failed:', err);
      catalogCache = [];
    }
  }
  const items = Array.isArray(catalogCache) ? catalogCache : [];
  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean))).sort();

  const modal = document.createElement('div');
  modal.id = 'cm-eq-catalog-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';

  const renderRows = (query, cat) => {
    const q = (query || '').trim().toLowerCase();
    return items
      .filter(i => !cat || i.category === cat)
      .filter(i => !q || `${i.name} ${i.subcategory || ''} ${i.notes || ''}`.toLowerCase().includes(q))
      .map(i => `
        <tr data-eq-id="${i.id}" style="cursor:pointer;border-bottom:1px solid var(--ies-gray-100);">
          <td style="padding:8px 10px;">
            <div style="font-weight:600;font-size:13px;">${i.name}</div>
            ${i.subcategory ? `<div style="font-size:11px;color:var(--ies-gray-400);">${i.subcategory}</div>` : ''}
          </td>
          <td style="padding:8px 10px;"><span style="font-size:11px;padding:2px 8px;border-radius:12px;background:var(--ies-gray-100);color:var(--ies-gray-600);">${i.category || '—'}</span></td>
          <td style="padding:8px 10px;text-align:right;font-weight:600;">${i.monthly_lease_cost ? '$' + Number(i.monthly_lease_cost).toLocaleString() : '—'}</td>
          <td style="padding:8px 10px;text-align:right;font-weight:600;">${i.purchase_cost ? '$' + Number(i.purchase_cost).toLocaleString() : '—'}</td>
          <td style="padding:8px 10px;text-align:right;">${i.useful_life_years || '—'}</td>
          <td style="padding:8px 10px;font-size:11px;color:var(--ies-gray-500);max-width:280px;">${(i.capacity_description || '')}</td>
        </tr>
      `).join('') || `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--ies-gray-400);">No items match.</td></tr>`;
  };

  modal.innerHTML = `
    <div style="background:#fff;border-radius:8px;width:min(960px,92vw);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden;">
      <div style="padding:20px 24px 12px 24px;border-bottom:1px solid var(--ies-gray-200);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <div>
            <div style="font-size:16px;font-weight:700;">Equipment Catalog</div>
            <div style="font-size:12px;color:var(--ies-gray-400);">${items.length} items from the GXO reference catalog — click a row to add it as a new line.</div>
          </div>
          <button id="eq-close" class="hub-btn hub-btn-sm hub-btn-secondary" style="margin-left:auto;">✕ Close</button>
        </div>
        <div style="display:flex;gap:8px;">
          <input id="eq-search" class="hub-input" placeholder="Search name, subcategory, notes…" style="flex:1;font-size:13px;" />
          <select id="eq-cat" class="hub-select" style="width:160px;font-size:13px;">
            <option value="">All categories</option>
            ${categories.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--ies-gray-50);z-index:1;">
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="padding:10px;text-align:left;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Equipment</th>
              <th style="padding:10px;text-align:left;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Category</th>
              <th style="padding:10px;text-align:right;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Lease $/mo</th>
              <th style="padding:10px;text-align:right;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Purchase $</th>
              <th style="padding:10px;text-align:right;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Life (yrs)</th>
              <th style="padding:10px;text-align:left;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Capacity / Notes</th>
            </tr>
          </thead>
          <tbody id="eq-tbody">${renderRows('', '')}</tbody>
        </table>
      </div>
    </div>
  `;
  rootEl.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#eq-close')?.addEventListener('click', close);

  const search = /** @type {HTMLInputElement} */ (modal.querySelector('#eq-search'));
  const catSel = /** @type {HTMLSelectElement} */ (modal.querySelector('#eq-cat'));
  const tbody  = modal.querySelector('#eq-tbody');
  const refresh = () => { if (tbody) tbody.innerHTML = renderRows(search.value, catSel.value); };
  search?.addEventListener('input', refresh);
  catSel?.addEventListener('change', refresh);

  // Row click → fill a new equipment line, close modal, re-render section
  modal.querySelector('#eq-tbody')?.addEventListener('click', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('[data-eq-id]');
    if (!row) return;
    const id = row.getAttribute('data-eq-id');
    const item = items.find(i => i.id === id);
    if (!item) return;
    // Map catalog fields → equipment line shape used by createEmptyModel & renderEquipment
    const hasLease = Number(item.monthly_lease_cost) > 0;
    const newLine = {
      equipment_name: item.name || '',
      category: ['MHE','IT','Racking','Dock','Charging','Office','Security','Conveyor'].includes(item.category) ? item.category : 'MHE',
      quantity: 1,
      acquisition_type: hasLease ? 'lease' : 'purchase',
      monthly_cost: Number(item.monthly_lease_cost) || 0,
      acquisition_cost: Number(item.purchase_cost) || 0,
      monthly_maintenance: Number(item.monthly_maintenance) || 0,
      amort_years: Number(item.useful_life_years) || 5,
      notes: item.capacity_description || '',
      pricing_bucket: defaultBucketFor('equipment'), // I-01 — don't silently roll into Management Fee
    };
    if (!Array.isArray(model.equipmentLines)) model.equipmentLines = [];
    model.equipmentLines.push(newLine);
    isDirty = true;
    close();
    renderSection();
    bus.emit('cm:equipment-added-from-catalog', { name: newLine.equipment_name });
  });

  // Focus search on open
  search?.focus();
}

// ============================================================
// TOOLBAR HANDLERS
// ============================================================

async function handleNew() {
  if (isDirty && !confirm('You have unsaved changes. Start a new model?')) return;
  model = createEmptyModel();
  isDirty = false;
  activeSection = 'setup';
  navigateSection('setup');
}

async function handleSave() {
  try {
    if (model.id) {
      await api.updateModel(model.id, model);
    } else {
      const saved = await api.createModel(model);
      model.id = saved.id;
    }
    isDirty = false;
    bus.emit('cm:model-saved', { id: model.id });

    // Phase 1: if the monthly engine flag is on and we have the latest
    // projection bundle in memory, persist the monthly facts + refresh the
    // materialized view. Fire-and-forget so a flaky RPC never blocks save.
    if (typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false) {
      const bundle = _lastMonthlyBundle;
      if (bundle && model.id) {
        api.persistMonthlyFacts(model.id, bundle)
          .then(({ wrote }) => bus.emit('cm:monthly-facts-updated', { project_id: model.id, rows: wrote }))
          .catch(err => { console.warn('[CM] persistMonthlyFacts failed:', err); bus.emit('cm:pnl-refresh-failed', { project_id: model.id, error: err }); });
      }
    }
  } catch (err) {
    console.error('[CM] Save failed:', err);
    alert('Save failed: ' + err.message);
  }
}

/** Cached monthly bundle from the most recent buildYearlyProjections call. */
let _lastMonthlyBundle = null;
export function setLastMonthlyBundle(bundle) { _lastMonthlyBundle = bundle; }

/**
 * Build the monthly bundle on demand so sections other than Summary (notably
 * Timeline) can render without first requiring a Summary roundtrip. Reads the
 * current model/refData/heuristic chain the same way Summary does and caches
 * the result into `_lastMonthlyBundle`.
 */
function ensureMonthlyBundle() {
  if (_lastMonthlyBundle) return _lastMonthlyBundle;
  if (!model) return null;
  try {
    const market = model.projectDetails?.market;
    const fr = (refData.facilityRates || []).find(r => r.market_id === market);
    const ur = (refData.utilityRates || []).find(r => r.market_id === market);
    const opHrs = calc.operatingHours(model.shifts || {});
    const orders = (model.volumeLines || []).find(v => v.isOutboundPrimary)?.volume || 0;
    const contractYears = model.projectDetails?.contractTerm || 5;
    const fin = model.financial || {};
    const summary = calc.computeSummary({
      laborLines: model.laborLines || [],
      indirectLaborLines: model.indirectLaborLines || [],
      equipmentLines: model.equipmentLines || [],
      overheadLines: model.overheadLines || [],
      vasLines: model.vasLines || [],
      startupLines: model.startupLines || [],
      facility: model.facility || {},
      shifts: model.shifts || {},
      facilityRate: fr,
      utilityRate: ur,
      contractYears,
      targetMarginPct: fin.targetMargin || 0,
      annualOrders: orders || 1,
    });
    const calcHeur = scenarios.resolveCalcHeuristics(
      currentScenario,
      currentScenarioSnapshots,
      heuristicOverrides,
      fin,
      whatIfTransient,
    );
    const emBMarginFrac = (calcHeur.targetMarginPct || 0) / 100;
    const projResult = calc.buildYearlyProjections({
      years: contractYears,
      baseLaborCost: summary.laborCost,
      baseFacilityCost: summary.facilityCost,
      baseEquipmentCost: summary.equipmentCost,
      baseOverheadCost: summary.overheadCost,
      baseVasCost: summary.vasCost,
      startupAmort: summary.startupAmort,
      startupCapital: summary.startupCapital,
      baseOrders: orders || 1,
      marginPct: emBMarginFrac,
      volGrowthPct: calcHeur.volGrowthPct / 100,
      laborEscPct:  calcHeur.laborEscPct  / 100,
      costEscPct:   calcHeur.costEscPct   / 100,
      laborLines: model.laborLines || [],
      taxRatePct: calcHeur.taxRatePct,
      useMonthlyEngine: typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false,
      periods: (refData && refData.periods) || [],
      ramp: null,
      seasonality: model.seasonalityProfile || null,
      preGoLiveMonths: calcHeur.preGoLiveMonths,
      dsoDays:           calcHeur.dsoDays,
      dpoDays:           calcHeur.dpoDays,
      laborPayableDays:  calcHeur.laborPayableDays,
      startupLines: model.startupLines || [],
      pricingBuckets: buildEnrichedPricingBuckets(summary, emBMarginFrac, opHrs, contractYears),
      project_id: model.id || 0,
      _calcHeur: calcHeur,
      marketLaborProfile: currentMarketLaborProfile,
      _heuristicsSource: calcHeur.used,
    });
    if (projResult && projResult.monthlyBundle) _lastMonthlyBundle = projResult.monthlyBundle;
    if (calcHeur) _lastCalcHeuristics = calcHeur;
    return _lastMonthlyBundle;
  } catch (err) {
    console.warn('[CM] ensureMonthlyBundle failed:', err);
    return null;
  }
}

async function handleLoad() {
  // The Load button now returns to the landing page where models are shown as cards.
  // Refreshes the list so any newly-saved model appears.
  try { savedModels = await api.listModels(); } catch {}
  if (isDirty && !confirm('You have unsaved changes. Leave this model?')) return;
  viewMode = 'landing';
  renderCurrentView();
}

// ============================================================
// EXCEL EXPORT — multi-sheet .xlsx via SheetJS CDN (window.XLSX)
// ============================================================

function handleExportExcel() {
  if (!window.XLSX) {
    alert('Excel library not loaded. Refresh the page and try again.');
    return;
  }
  try {
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();
    const pd = model.projectDetails || {};

    // --- Compute summary (best-effort; if it fails we still export raw data) ---
    let summary = null;
    try {
      const outbound = (model.volumeLines || []).find(v => v.isOutboundPrimary);
      summary = calc.computeSummary({
        shifts: model.shifts,
        facility: model.facility,
        laborLines: model.laborLines || [],
        indirectLaborLines: model.indirectLaborLines || [],
        equipmentLines: model.equipmentLines || [],
        overheadLines: model.overheadLines || [],
        vasLines: model.vasLines || [],
        startupLines: model.startupLines || [],
        contractYears: pd.contractTerm || 5,
        targetMarginPct: (model.financial && model.financial.targetMargin) || 0,
        annualOrders: (outbound && outbound.volume) || 1,
        facilityRate: 0,
        utilityRate: 0,
      });
    } catch (err) {
      console.warn('[CM] computeSummary failed during export — skipping totals:', err);
    }

    // --- Sheet 1: Summary ---
    const rows = [
      ['IES Cost Model — Export'],
      ['Generated', new Date().toISOString()],
      [],
      ['Project Name',     pd.name || 'Untitled Model'],
      ['Client',           pd.clientName || '—'],
      ['Facility Location',pd.facilityLocation || '—'],
      ['Market',           pd.market || '—'],
      ['Environment',      pd.environment || '—'],
      ['Contract Term (yrs)', pd.contractTerm || 5],
    ];
    if (summary) {
      rows.push([]);
      rows.push(['— Annual Cost Summary —']);
      rows.push(['Labor Cost',       Math.round(summary.laborCost || 0)]);
      rows.push(['Facility Cost',    Math.round(summary.facilityCost || 0)]);
      rows.push(['Equipment Cost',   Math.round(summary.equipmentCost || 0)]);
      rows.push(['Overhead Cost',    Math.round(summary.overheadCost || 0)]);
      rows.push(['VAS Cost',         Math.round(summary.vasCost || 0)]);
      rows.push(['Startup Amortization', Math.round(summary.startupAmort || 0)]);
      rows.push(['Total Annual Cost',    Math.round(summary.totalCost || 0)]);
      rows.push(['Total Annual Revenue', Math.round(summary.totalRevenue || 0)]);
      rows.push(['Target Margin %',      (model.financial && model.financial.targetMargin) || 0]);
      rows.push(['Total FTEs',           (summary.totalFtes || 0).toFixed(1)]);
      rows.push(['Cost per Order',       +(summary.costPerOrder || 0).toFixed(2)]);
      rows.push(['Equipment Capital',    Math.round(summary.equipmentCapital || 0)]);
      rows.push(['Startup Capital',      Math.round(summary.startupCapital || 0)]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Summary');

    // --- Helper: append an object-array sheet, coping with empty lists ---
    const appendObjectSheet = (name, arr, fallbackHeader) => {
      if (!Array.isArray(arr) || arr.length === 0) {
        const ws = XLSX.utils.aoa_to_sheet([[...fallbackHeader], ['— no data —']]);
        XLSX.utils.book_append_sheet(wb, ws, name);
        return;
      }
      const ws = XLSX.utils.json_to_sheet(arr);
      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    // --- Sheets: Volumes / Labor (Direct, Indirect) / Equipment / Overhead / VAS / Startup / Pricing / Shifts ---
    appendObjectSheet('Volumes',       model.volumeLines || [],        ['name','volume','uom','isOutboundPrimary']);
    appendObjectSheet('Labor-Direct',  model.laborLines || [],         ['activity_name','process_area','volume','base_uph','hourly_rate','burden_pct']);
    appendObjectSheet('Labor-Indirect',model.indirectLaborLines || [], ['role','hourly_rate','ratio_to_direct','burden_pct']);
    appendObjectSheet('Equipment',     model.equipmentLines || [],     ['equipment_name','category','quantity','acquisition_type','monthly_lease','acquisition_cost','annual_maintenance','amortization_years']);
    appendObjectSheet('Overhead',      model.overheadLines || [],      ['category','annual_cost','driver','notes']);
    appendObjectSheet('VAS',           model.vasLines || [],           ['name','annual_cost']);
    appendObjectSheet('Startup',       model.startupLines || [],       ['category','amount','amortization_years']);
    appendObjectSheet('Pricing',       model.pricingBuckets || [],     ['id','name','type','uom','rate']);

    // --- Shifts block as a short sheet ---
    const s = model.shifts || {};
    const shiftsAOA = [
      ['Shifts per Day',      s.shiftsPerDay || 1],
      ['Hours per Shift',     s.hoursPerShift || 8],
      ['Days per Week',       s.daysPerWeek || 5],
      ['Weeks per Year',      s.weeksPerYear || 52],
      ['Facility Total Sqft', (model.facility && model.facility.totalSqft) || 0],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(shiftsAOA), 'Facility-Shifts');

    // --- Filename: CM_<projectName>_<yyyy-mm-dd>.xlsx, safe-chars only ---
    const safeName = (pd.name || 'Untitled_Model').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `CM_${safeName}_${dateStr}.xlsx`;
    XLSX.writeFile(wb, fileName);
    bus.emit('cm:model-exported', { fileName });
  } catch (err) {
    console.error('[CM] Excel export failed:', err);
    alert('Excel export failed: ' + (err.message || 'unknown error'));
  }
}

// ============================================================
// VALIDATION UI
// ============================================================

function updateValidation() {
  const el = rootEl?.querySelector('#cm-validation');
  if (!el) return;

  // Don't show validation errors until the user starts working
  if (!userHasInteracted) {
    el.innerHTML = '<span style="color: var(--ies-blue); font-weight: 600;">Ready — enter project details to begin</span>';
    return;
  }

  const warnings = calc.validateModel(model);
  if (warnings.length === 0) {
    el.innerHTML = '<span style="color: var(--ies-green); font-weight: 600;">No issues found</span>';
    return;
  }

  const errors = warnings.filter(w => w.level === 'error').length;
  const warns = warnings.filter(w => w.level === 'warning').length;

  el.innerHTML = `
    <div style="color: ${errors > 0 ? 'var(--ies-red)' : 'var(--ies-yellow)'}; font-weight: 600;">
      ${errors > 0 ? `${errors} error${errors > 1 ? 's' : ''}` : ''}
      ${errors > 0 && warns > 0 ? ', ' : ''}
      ${warns > 0 ? `${warns} warning${warns > 1 ? 's' : ''}` : ''}
    </div>
  `;

  // Update section completion checks
  SECTIONS.forEach(s => {
    const check = rootEl?.querySelector(`#cm-check-${s.key}`);
    if (!check) return;
    const hasError = warnings.some(w => w.area === s.key && w.level === 'error');
    const hasData = sectionHasData(s.key);
    check.classList.toggle('complete', hasData && !hasError);
  });
}

function sectionHasData(key) {
  switch (key) {
    case 'setup': return !!(model.projectDetails?.name);
    case 'volumes': return model.volumeLines.length > 0;
    case 'facility': return (model.facility?.totalSqft || 0) > 0;
    case 'shifts': return true; // defaults always valid
    case 'labor': return model.laborLines.length > 0;
    case 'equipment': return model.equipmentLines.length > 0;
    case 'overhead': return model.overheadLines.length > 0;
    case 'financial': return (model.financial?.targetMargin || 0) > 0;
    default: return false;
  }
}

// ============================================================
// MOST → CM INTEGRATION
// ============================================================

/**
 * Handle incoming labor lines from MOST tool.
 * Merges or replaces CM laborLines with MOST-derived data.
 * @param {import('../most-standards/types.js?v=20260418-sK').MostToCmPayload} payload
 */
function handleMostPush(payload) {
  if (!payload?.laborLines?.length) return;

  // Replace any existing MOST-sourced lines (by template_id), keep manual ones
  const manualLines = model.laborLines.filter(l => !l.most_template_id);
  const mostLines = payload.laborLines.map(l => ({
    activity_name: l.activity_name || '',
    process_area: l.process_area || '',
    labor_category: l.labor_category || 'manual',
    volume: l.volume || 0,
    base_uph: l.base_uph || 0,
    annual_hours: l.annual_hours || 0,
    hourly_rate: l.hourly_rate || 0,
    burden_pct: l.burden_pct || 30,
    most_template_id: l.most_template_id || '',
    most_template_name: l.most_template_name || '',
  }));

  model.laborLines = [...manualLines, ...mostLines];
  isDirty = true;

  // Navigate to labor section to show the result
  navigateSection('labor');
  updateValidation();

  bus.emit('cm:labor-updated', { source: 'most', lineCount: mostLines.length });
  console.log(`[CM] Received ${mostLines.length} labor lines from MOST`);
}

// ============================================================
// WSC → CM INTEGRATION
// ============================================================

/**
 * Handle incoming facility data from Warehouse Sizing Calculator.
 * Populates CM facility section fields.
 * @param {import('../warehouse-sizing/types.js?v=20260418-sK').WscToCmPayload} payload
 */
function handleWscPush(payload) {
  if (!payload) return;

  // If WSC fired this while we were still on the landing view, enter the editor
  // with a fresh model first — otherwise navigateSection is a no-op.
  if (viewMode === 'landing') {
    model = createEmptyModel();
    isDirty = false;
    userHasInteracted = false;
    activeSection = 'facility';
    viewMode = 'editor';
  }

  model.facility = model.facility || {};
  if (payload.totalSqft)   model.facility.totalSqft = payload.totalSqft;
  if (payload.clearHeight) model.facility.clearHeight = payload.clearHeight;
  if (payload.dockDoors)   model.facility.dockDoors = payload.dockDoors;
  if (payload.officeSqft)  model.facility.officeSqft = payload.officeSqft;
  if (payload.stagingSqft) model.facility.stagingSqft = payload.stagingSqft;

  isDirty = true;
  if (viewMode === 'editor') {
    navigateSection('facility');
    updateValidation();
  } else {
    renderCurrentView();
  }

  bus.emit('cm:facility-updated', { source: 'wsc' });
  console.log('[CM] Received facility data from WSC:', payload);
}

// ============================================================
// HELPERS
// ============================================================

// ============================================================
// LANDING PAGE — saved-scenarios grid + "+ Create New Model" CTA
// ============================================================

function renderLanding() {
  const count = savedModels.length;
  // ref_markets primary key is `id` (uuid) with a `name` column; the fallback shape
  // uses market_id/name. Build a lookup that works for either shape.
  const marketById = {};
  (refData.markets || DEMO_MARKETS_FALLBACK).forEach(m => {
    const key = m.market_id || m.id;
    const label = m.name || m.market_name || m.abbr || key;
    if (key) marketById[key] = label;
  });
  return `
    <div style="padding:32px;max-width:1280px;margin:0 auto;">
      <a href="#designtools" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ies-gray-500);text-decoration:none;margin-bottom:8px;" onmouseover="this.style.color='#ff3a00'" onmouseout="this.style.color='var(--ies-gray-500)'">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Design Tools
      </a>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
        <div>
          <h2 class="text-page" style="margin:0 0 4px 0;">Cost Model Builder</h2>
          <div style="font-size:13px;color:var(--ies-gray-400);">
            ${count === 0 ? 'Build a new pricing model from scratch.' : `${count} saved model${count === 1 ? '' : 's'} — pick one to continue, or start fresh.`}
          </div>
        </div>
        <button class="hub-btn hub-btn-primary" id="cm-create-new" style="font-weight:700;">+ Create New Model</button>
      </div>

      ${count === 0 ? `
        <div class="hub-card" style="padding:48px;text-align:center;border:2px dashed var(--ies-gray-200);">
          <div style="font-size:36px;margin-bottom:12px;">📊</div>
          <div style="font-size:16px;font-weight:700;margin-bottom:6px;">No saved models yet</div>
          <div style="font-size:13px;color:var(--ies-gray-400);margin-bottom:20px;">Start a pricing model to compute labor, equipment, overhead, and P&amp;L for a facility.</div>
          <button class="hub-btn hub-btn-primary" id="cm-create-new-alt" onclick="document.getElementById('cm-create-new').click()">+ Create New Model</button>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
          ${savedModels.map(m => {
            const updated = m.updated_at ? new Date(m.updated_at) : null;
            const updatedStr = updated ? updated.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
            const market = m.market_id ? (marketById[m.market_id] || m.market_id) : null;
            const safeName = (m.name || 'Untitled Model').replace(/"/g, '&quot;');
            return `
              <div class="hub-card cm-landing-card" data-cm-card="${m.id}" style="padding:16px;cursor:pointer;transition:all 0.15s;border:1px solid var(--ies-gray-200);position:relative;">
                <button class="cm-landing-delete" data-cm-delete="${m.id}" data-cm-name="${safeName}"
                        title="Delete this model"
                        style="position:absolute;top:8px;right:8px;width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--ies-gray-300);cursor:pointer;border-radius:4px;font-size:14px;">
                  ✕
                </button>
                <div style="font-size:14px;font-weight:700;margin-bottom:4px;color:var(--ies-navy);padding-right:24px;">${m.name || 'Untitled Model'}</div>
                <div style="font-size:12px;color:var(--ies-gray-500);margin-bottom:12px;">${m.client_name || '<span style="color:var(--ies-gray-300);">No client</span>'}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
                  ${market ? `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:var(--ies-gray-100);color:var(--ies-gray-600);">${market}</span>` : ''}
                </div>
                <div style="font-size:11px;color:var(--ies-gray-400);">Updated ${updatedStr}</div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
    <style>
      .cm-landing-card:hover { border-color: var(--ies-blue) !important; box-shadow: 0 2px 8px rgba(0,71,171,0.08); transform: translateY(-1px); }
    </style>
  `;
}

function createEmptyModel() {
  // Starter profile: representative mid-size 150k-sqft eComm DC. Replace values as you go.
  return {
    id: null,
    projectDetails: { name: '', clientName: '', market: '', environment: '', facilityLocation: '', contractTerm: 5, dealId: null },
    volumeLines: [
      { name: 'Receiving (Pallets)', volume: 15000, uom: 'pallets', isOutboundPrimary: false },
      { name: 'Put-Away',            volume: 15000, uom: 'pallets', isOutboundPrimary: false },
      { name: 'Orders Shipped',      volume: 80000, uom: 'orders',  isOutboundPrimary: true  },
      { name: 'Each Picks',          volume: 800000, uom: 'eaches', isOutboundPrimary: false },
      { name: 'Case Picks',          volume: 200000, uom: 'cases',  isOutboundPrimary: false },
    ],
    orderProfile: {},
    facility: { totalSqft: 150000 },
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52 },
    laborLines: [
      { activity_name: 'Receiving', process_area: 'Inbound',  labor_category: 'direct', volume_source_idx: 0, volume: 15000,  base_uph: 200, annual_hours: 15000 / 200,  hourly_rate: 18.00, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Put-Away',  process_area: 'Inbound',  labor_category: 'direct', volume_source_idx: 1, volume: 15000,  base_uph: 180, annual_hours: 15000 / 180,  hourly_rate: 18.00, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Picking',   process_area: 'Outbound', labor_category: 'direct', volume_source_idx: 3, volume: 800000, base_uph: 120, annual_hours: 800000 / 120, hourly_rate: 17.50, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Packing',   process_area: 'Outbound', labor_category: 'direct', volume_source_idx: 2, volume: 80000,  base_uph: 60,  annual_hours: 80000 / 60,   hourly_rate: 16.50, burden_pct: 30, most_template_id: '', most_template_name: '' },
      { activity_name: 'Shipping',  process_area: 'Outbound', labor_category: 'direct', volume_source_idx: 2, volume: 80000,  base_uph: 150, annual_hours: 80000 / 150,  hourly_rate: 17.00, burden_pct: 30, most_template_id: '', most_template_name: '' },
    ],
    indirectLaborLines: [
      { role: 'Supervisor',    hourly_rate: 28.00, ratio_to_direct: 12, burden_pct: 35 },
      { role: 'Quality Lead',  hourly_rate: 22.00, ratio_to_direct: 5,  burden_pct: 35 },
    ],
    equipmentLines: [
      // Field names match renderEquipment DOM (monthly_cost / monthly_maintenance / amort_years).
      { equipment_name: 'Reach Truck',              category: 'MHE',     quantity: 4,    acquisition_type: 'lease',    monthly_cost: 850,  acquisition_cost: 0,     monthly_maintenance: 100, amort_years: 7,  notes: '' },
      { equipment_name: 'RF Scanners',              category: 'IT',      quantity: 15,   acquisition_type: 'lease',    monthly_cost: 45,   acquisition_cost: 0,     monthly_maintenance: 12,  amort_years: 5,  notes: '' },
      { equipment_name: 'Selective Pallet Racking', category: 'Racking', quantity: 3000, acquisition_type: 'purchase', monthly_cost: 0,    acquisition_cost: 95,    monthly_maintenance: 0,   amort_years: 15, notes: 'Position count' },
      { equipment_name: 'Dock Levelers',            category: 'Dock',    quantity: 20,   acquisition_type: 'purchase', monthly_cost: 0,    acquisition_cost: 4500,  monthly_maintenance: 21,  amort_years: 10, notes: '' },
      { equipment_name: 'WMS License',              category: 'IT',      quantity: 1,    acquisition_type: 'service',  monthly_cost: 8500, acquisition_cost: 0,     monthly_maintenance: 0,   amort_years: 5,  notes: 'Annual SaaS license' },
    ],
    overheadLines: [
      { category: 'Utilities',    annual_cost: 180000, driver: 'sqft',             notes: 'Electric + gas ($1.20/sqft)' },
      { category: 'Insurance',    annual_cost: 24000,  driver: 'fixed',            notes: '' },
      { category: 'Maintenance',  annual_cost: 60000,  driver: 'equipment value',  notes: '' },
      { category: 'Supplies',     annual_cost: 48000,  driver: 'per unit shipped', notes: 'Labels, tape, stretch wrap' },
    ],
    vasLines: [],
    financial: { targetMargin: 12, volumeGrowth: 3, laborEscalation: 4, annualEscalation: 3, discountRate: 10, reinvestRate: 8 },
    laborCosting: { defaultBurdenPct: 30, overtimePct: 5, benefitLoadPct: 15, ptoDays: 12, turnoverPct: 45 },
    startupLines: [],
    pricingBuckets: [
      { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed', uom: 'month' },
      { id: 'storage', name: 'Storage', type: 'variable', uom: 'pallet' },
      { id: 'inbound', name: 'Inbound Handling', type: 'variable', uom: 'pallet' },
      { id: 'pick_pack', name: 'Pick & Pack', type: 'variable', uom: 'order' },
      { id: 'each_pick', name: 'Each Pick', type: 'variable', uom: 'each' },
      { id: 'outbound', name: 'Outbound Handling', type: 'variable', uom: 'order' },
      { id: 'vas', name: 'VAS', type: 'variable', uom: 'each' },
      { id: 'case_pick', name: 'Case Pick', type: 'variable', uom: 'case' },
    ],
  };
}

/**
 * I-01 helper: pick a sensible default pricing_bucket for a new cost line
 * so it doesn't silently roll into Management Fee.
 *
 * Strategy by line type:
 *   - labor (direct):  prefer 'outbound', then first variable bucket, then first
 *   - indirect labor:  prefer 'mgmt_fee', then first fixed bucket, then first
 *   - equipment:       prefer 'mgmt_fee', then first fixed bucket, then first
 *   - overhead:        prefer 'mgmt_fee', then first fixed bucket, then first
 *   - vas:             prefer 'vas',      then first variable bucket, then first
 *   - startup:         prefer 'mgmt_fee', then first fixed bucket, then first
 *
 * Returns null when no buckets exist (caller should leave pricing_bucket unset).
 */
function defaultBucketFor(lineType) {
  const buckets = (model && model.pricingBuckets) || [];
  if (buckets.length === 0) return null;
  const byId = (id) => buckets.find(b => b.id === id);
  const firstOfType = (type) => buckets.find(b => b.type === type);
  const preference = {
    labor:    ['outbound', 'pick_pack', 'each_pick', 'case_pick'],
    indirect: ['mgmt_fee'],
    equipment:['mgmt_fee'],
    overhead: ['mgmt_fee'],
    vas:      ['vas'],
    startup:  ['mgmt_fee'],
  }[lineType] || ['mgmt_fee'];
  for (const id of preference) {
    if (byId(id)) return id;
  }
  // Fallbacks
  if (['labor', 'vas'].includes(lineType)) {
    return (firstOfType('variable') || buckets[0]).id;
  }
  return (firstOfType('fixed') || buckets[0]).id;
}

/**
 * I-02 helper: build a pricingBuckets array with rate + annualVolume
 * derived from the same cost rollup the Pricing Schedule UI shows.
 * Explicit bucket.rate values win; this is only the fallback so brand-new
 * models don't render $0 monthly revenue.
 *
 * @param {Object} summary — output of calc.computeSummary
 * @param {number} marginFrac — target margin as a 0-based fraction
 * @param {number} opHrs — operating hours per year
 * @param {number} contractYears — for startup amortization
 */
function buildEnrichedPricingBuckets(summary, marginFrac, opHrs, contractYears) {
  return computePricingSnapshot(summary, marginFrac, opHrs, contractYears).buckets;
}

/**
 * Full pricing snapshot for Summary — returns both the enriched buckets
 * (I-02) and the raw bucket costs including the '_unassigned' pseudo-bucket
 * (I-01 warning banner).
 */
function computePricingSnapshot(summary, marginFrac, opHrs, contractYears) {
  const startupWithAmort = (model.startupLines || []).map(l => ({
    ...l,
    annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears || 5),
  }));
  // Compute WITHOUT unassigned-rollup so we can see the real unassigned total.
  // The existing computeBucketCosts rolls unassigned into mgmt_fee — we want
  // the pre-rollup number for the banner, so we recompute from line data.
  const buckets = model.pricingBuckets || [];
  const bucketCosts = calc.computeBucketCosts({
    buckets,
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: startupWithAmort,
    facilityCost: summary.facilityCost || 0,
    operatingHours: opHrs || 0,
    facilityBucketId: model.financial?.facilityBucketId || null,
  });
  // Count lines that explicitly lack a pricing_bucket (what goes to _unassigned)
  const unassignedLines = [];
  const tally = (arr, type) => (arr || []).forEach(l => {
    if (!l.pricing_bucket) unassignedLines.push({ type, line: l });
  });
  tally(model.laborLines, 'labor');
  tally(model.indirectLaborLines, 'indirect');
  tally(model.equipmentLines, 'equipment');
  tally(model.overheadLines, 'overhead');
  tally(model.vasLines, 'vas');
  tally(model.startupLines, 'startup');

  const enrichedBuckets = calc.enrichBucketsWithDerivedRates({
    buckets,
    bucketCosts,
    marginPct: marginFrac || 0,
    volumeLines: model.volumeLines || [],
  });

  return {
    buckets: enrichedBuckets,
    bucketCosts,
    unassignedCount: unassignedLines.length,
    unassignedLines,
  };
}

function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// ============================================================
// SECTION 14: TIMELINE (Phase 1)
// ============================================================

/**
 * Monthly P&L + cumulative cash flow rendered from the monthly bundle.
 * When the flag is off or no bundle exists, shows a helpful empty state.
 */
function renderTimeline() {
  const flagOn = typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false;
  const frozenBanner = renderFrozenBanner();

  if (!flagOn) {
    return `
      ${frozenBanner}
      <div class="cm-section">
        <h2 class="cm-section-title">Timeline <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;margin-left:8px;">Legacy mode</span></h2>
        <div class="hub-card" style="background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:16px;">
          <strong>Monthly engine is disabled.</strong> Re-enable it in the browser console to view the timeline:
          <code style="display:block;margin-top:8px;background:#fff;padding:8px;border-radius:4px;font-family:monospace;">window.COST_MODEL_MONTHLY_ENGINE = true;</code>
        </div>
      </div>
    `;
  }

  // Build the bundle on demand so Timeline works without a Summary round-trip.
  const bundle = ensureMonthlyBundle();

  if (!bundle || !bundle.cashflow || bundle.cashflow.length === 0) {
    return `
      <div class="cm-section">
        <h2 class="cm-section-title">Timeline</h2>
        <div class="hub-card" style="padding:24px;text-align:center;color:var(--ies-gray-400);">
          Add labor, equipment, and pricing inputs to generate the monthly timeline. Empty models have no cashflow to render.
        </div>
      </div>
    `;
  }

  // Aggregate monthly cashflow for the Timeline table
  const periods = bundle.periods;
  const byId = new Map(periods.map(p => [p.id, p]));
  const rows = bundle.cashflow.map(cf => {
    const p = byId.get(cf.period_id);
    return {
      label: p?.label || '',
      period_index: p?.period_index ?? 0,
      is_pre_go_live: p?.is_pre_go_live ?? false,
      revenue: cf.revenue,
      opex: cf.opex,
      ebitda: cf.ebitda,
      net_income: cf.net_income,
      capex: cf.capex,
      ocf: cf.operating_cash_flow,
      fcf: cf.free_cash_flow,
      cum_fcf: cf.cumulative_cash_flow,
    };
  }).sort((a, b) => a.period_index - b.period_index);

  // Year-over-year totals for a quick summary strip
  const yearly = {};
  for (const r of rows) {
    if (r.is_pre_go_live) continue;
    const yr = Math.floor(r.period_index / 12) + 1;
    if (!yearly[yr]) yearly[yr] = { revenue: 0, opex: 0, net_income: 0, fcf: 0 };
    yearly[yr].revenue    += r.revenue;
    yearly[yr].opex       += r.opex;
    yearly[yr].net_income += r.net_income;
    yearly[yr].fcf        += r.fcf;
  }

  const fmt = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  };

  // Cumulative-cash-flow trend colors
  const payback = rows.find(r => r.cum_fcf >= 0 && !r.is_pre_go_live);

  const lastCumFcf = rows[rows.length - 1].cum_fcf;

  return `
    ${frozenBanner}
    <div class="cm-section">
      <div class="cm-timeline-meta">
        <h2 class="cm-timeline-meta__title">Timeline</h2>
        <span class="cm-timeline-meta__hint">${rows.length} months · Phase 1 monthly engine</span>
      </div>

      <!-- KPI strip (primitives kit) -->
      <div class="hub-kpi-strip mb-4">
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Total Revenue</div>
          <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">$${fmt(rows.reduce((s, r) => s + r.revenue, 0))}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Total Opex</div>
          <div class="hub-kpi-tile__value">$${fmt(rows.reduce((s, r) => s + r.opex, 0))}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Cumulative FCF</div>
          <div class="hub-kpi-tile__value" style="color:${lastCumFcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(lastCumFcf)}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Payback Month</div>
          <div class="hub-kpi-tile__value">${payback ? payback.label : '—'}</div>
        </div>
      </div>

      <!-- Year summary -->
      <div class="hub-card mb-4">
        <h3 class="hub-section-heading">Annual Roll-Up</h3>
        <table class="hub-datatable hub-datatable--dense">
          <thead><tr><th>Year</th><th class="hub-num">Revenue</th><th class="hub-num">Opex</th><th class="hub-num">Net Income</th><th class="hub-num">FCF</th></tr></thead>
          <tbody>
            ${Object.entries(yearly).map(([yr, y]) => `
              <tr>
                <td>Y${yr}</td>
                <td class="hub-num">$${fmt(y.revenue)}</td>
                <td class="hub-num">$${fmt(y.opex)}</td>
                <td class="hub-num">$${fmt(y.net_income)}</td>
                <td class="hub-num" style="color:${y.fcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(y.fcf)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Monthly cashflow table (first 24 months + cumulative) -->
      <div class="hub-card">
        <h3 class="hub-section-heading">Monthly Cashflow (first 24 months)</h3>
        <div class="cm-timeline-monthly-scroll">
          <table class="hub-datatable hub-datatable--dense">
            <thead>
              <tr>
                <th>Month</th>
                <th class="hub-num">Revenue</th>
                <th class="hub-num">Opex</th>
                <th class="hub-num">EBITDA</th>
                <th class="hub-num">Net Income</th>
                <th class="hub-num">CapEx</th>
                <th class="hub-num">FCF</th>
                <th class="hub-num">Cum FCF</th>
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 24).map(r => `
                <tr class="${r.is_pre_go_live ? 'cm-timeline-pre-go-live' : ''}">
                  <td style="font-weight:600;">${r.label}${r.is_pre_go_live ? ' <span class="cm-timeline-pre-go-live-tag">pre-live</span>' : ''}</td>
                  <td class="hub-num">$${fmt(r.revenue)}</td>
                  <td class="hub-num">$${fmt(r.opex)}</td>
                  <td class="hub-num">$${fmt(r.ebitda)}</td>
                  <td class="hub-num">$${fmt(r.net_income)}</td>
                  <td class="hub-num">${r.capex > 0 ? '$' + fmt(r.capex) : '—'}</td>
                  <td class="hub-num" style="color:${r.fcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(r.fcf)}</td>
                  <td class="hub-num" style="font-weight:700;color:${r.cum_fcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(r.cum_fcf)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${rows.length > 24 ? `<div class="hub-field__hint mt-2">…${rows.length - 24} more months (full 60-month view coming in the Phase 5 assumption studio)</div>` : ''}
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 15: ASSUMPTIONS (Phase 3 — design heuristics catalog + overrides)
// ============================================================

/**
 * Lazy-load the heuristics catalog + override jsonb. Called from bindSectionEvents
 * when the Assumptions section is first opened so mount() stays fast.
 */
async function ensureHeuristicsLoaded() {
  if (heuristicsCatalog.length === 0) {
    try { heuristicsCatalog = await api.fetchDesignHeuristics(); }
    catch (e) { console.warn('[CM] ensureHeuristicsLoaded:', e); heuristicsCatalog = []; }
  }
  // Overrides come from the project jsonb; re-fetch from the active model on each call.
  const projectId = model?.id;
  if (projectId) {
    try {
      const p = await api.getModel(projectId);
      heuristicOverrides = p?.heuristic_overrides || {};
    } catch (_) { heuristicOverrides = {}; }
  } else {
    // Unsaved model — keep local overrides in the model itself
    heuristicOverrides = model?.heuristicOverrides || {};
  }
}

const HEURISTIC_CATEGORY_LABELS = {
  financial: 'Financial',
  working_capital: 'Working Capital',
  labor: 'Labor',
  ramp_seasonality: 'Ramp & Seasonality',
  ops_escalation: 'Operations & Escalation',
};

/**
 * Phase 6 — load the planning-ratios catalog + categories + per-project
 * overrides. Mirrors ensureHeuristicsLoaded(). Guarded against re-entry.
 */
async function ensurePlanningRatiosLoaded() {
  if (_planningRatiosLoadInFlight) return;
  _planningRatiosLoadInFlight = true;
  try {
    if (planningRatiosCatalog.length === 0 || planningRatioCategories.length === 0) {
      const [cats, rows] = await Promise.all([
        api.fetchPlanningRatioCategories().catch(() => []),
        api.fetchPlanningRatios().catch(() => []),
      ]);
      planningRatioCategories = cats || [];
      planningRatiosCatalog = rows || [];
    }
    const projectId = model?.id;
    if (projectId) {
      try {
        const p = await api.getModel(projectId);
        planningRatioOverrides = (p && p.planning_ratio_overrides) || {};
      } catch (_) { planningRatioOverrides = {}; }
    } else {
      planningRatioOverrides = (model && model.planningRatioOverrides) || {};
    }
  } finally {
    _planningRatiosLoadInFlight = false;
  }
}

/**
 * Feature flag — default ON. Set `window.COST_MODEL_PLANNING_RATIOS = false`
 * in console to hide the Planning Ratios sub-section without touching code.
 */
function isPlanningRatiosFlagOn() {
  return typeof window === 'undefined' || window.COST_MODEL_PLANNING_RATIOS !== false;
}

/**
 * Format a ratio's effective value for display. Coerces percent to "%" and
 * respects value_unit hints. Structured types (array/lookup/tiered) render
 * as a terse summary.
 */
function formatRatioValue(resolved) {
  if (!resolved || resolved.value === null || resolved.value === undefined) return '—';
  const { value, def } = resolved;
  if (def && (def.value_type === 'array' || def.value_type === 'lookup' || def.value_type === 'tiered')) {
    if (Array.isArray(value)) return `[${value.length} values]`;
    if (typeof value === 'object') return `{${Object.keys(value).length} keys}`;
    return String(value);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (def && def.value_type === 'percent') return `${(n * 100).toFixed(n >= 0.1 ? 1 : 2)}%`;
  if (def && def.value_type === 'psf') return `$${n.toFixed(3)}`;
  if (def && def.value_type === 'per_unit') return `$${n.toLocaleString()}`;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

/** Returns { value, isStructured } for editor rendering. */
function ratioEditorValue(code, def) {
  const ov = planningRatioOverrides[code];
  if (ov && ov.value !== null && ov.value !== undefined && ov.value !== '') return { value: ov.value, isStructured: false };
  if (!def) return { value: '', isStructured: false };
  if (def.value_type === 'array' || def.value_type === 'lookup' || def.value_type === 'tiered') {
    return { value: null, isStructured: true };
  }
  return { value: '', isStructured: false };
}

function renderAssumptions() {
  const cat = heuristicsCatalog;
  if (!cat || cat.length === 0) {
    return `
      <div class="cm-section-header">
        <h2>Assumptions</h2>
        <p class="cm-subtle">All design heuristics that shape this scenario's math.</p>
      </div>
      <div class="cm-empty-state">Loading heuristics catalog…</div>
    `;
  }

  const overrideCount = scenarios.countOverrideChanges(cat, heuristicOverrides);
  const grouped = new Map();
  for (const h of cat) {
    if (!grouped.has(h.category)) grouped.set(h.category, []);
    grouped.get(h.category).push(h);
  }

  const fmtEffective = (h) => {
    const eff = scenarios.heuristicEffective(h, heuristicOverrides);
    if (eff === null || eff === undefined || eff === '') return '—';
    return String(eff);
  };
  const fmtDefault = (h) => {
    if (h.data_type === 'enum') return h.default_enum || '—';
    return h.default_value !== null && h.default_value !== undefined ? String(h.default_value) : '—';
  };
  const isOverride = (h) => {
    if (!Object.prototype.hasOwnProperty.call(heuristicOverrides, h.key)) return false;
    const v = heuristicOverrides[h.key];
    if (v === null || v === undefined || v === '') return false;
    const def_val = h.data_type === 'enum' ? h.default_enum : h.default_value;
    return String(v) !== String(def_val);
  };

  return `
    <div class="cm-section-header">
      <h2>Assumptions
        ${overrideCount > 0 ? `<span class="hub-status-chip" style="margin-left:8px;background:#fbbf24;color:#78350f;">${overrideCount} override${overrideCount === 1 ? '' : 's'}</span>` : '<span class="hub-status-chip" style="margin-left:8px;">all standard values</span>'}
      </h2>
      <p class="cm-subtle">Design heuristics drive the calc engine beyond the external rate cards. Defaults come from GXO/IES standards. Overrides are captured per scenario and frozen at approval time.</p>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="hub-btn" data-cm-action="reset-all-heuristics">Reset all to defaults</button>
      </div>
    </div>

    ${Array.from(grouped.entries()).map(([category, items]) => `
      <div class="cm-card" style="margin-top:16px;">
        <h3 style="margin-top:0;">${HEURISTIC_CATEGORY_LABELS[category] || category}</h3>
        <table class="cm-table" style="width:100%;">
          <thead>
            <tr>
              <th style="text-align:left;">Heuristic</th>
              <th style="text-align:left;width:30%;">Description</th>
              <th style="text-align:right;width:90px;">Default</th>
              <th style="text-align:right;width:140px;">Your Value</th>
              <th style="text-align:center;width:70px;">Reset</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(h => `
              <tr data-heuristic-key="${h.key}" style="${isOverride(h) ? 'background:#fffbeb;' : ''}">
                <td style="padding:6px 8px;">
                  <div style="font-weight:600;">${h.label}</div>
                  <div style="font-size:11px;color:var(--ies-gray-500);">${h.key}${h.unit ? ` · ${h.unit}` : ''}</div>
                </td>
                <td style="padding:6px 8px;font-size:12px;color:var(--ies-gray-600);">${h.description || ''}</td>
                <td class="cm-num">${fmtDefault(h)}</td>
                <td class="cm-num">
                  ${h.data_type === 'enum'
                    ? `<select class="hub-input" data-heuristic-input="${h.key}" style="width:130px;">
                         ${(Array.isArray(h.allowed_enums) ? h.allowed_enums : []).map(opt => `<option value="${opt}" ${String(heuristicOverrides[h.key] || h.default_enum) === String(opt) ? 'selected' : ''}>${opt}</option>`).join('')}
                       </select>`
                    : `<input class="hub-input" type="number" step="any" data-heuristic-input="${h.key}" value="${heuristicOverrides[h.key] !== undefined && heuristicOverrides[h.key] !== null ? heuristicOverrides[h.key] : ''}" placeholder="${fmtDefault(h)}" style="width:120px;text-align:right;" />`
                  }
                </td>
                <td style="text-align:center;">
                  ${isOverride(h) ? `<button class="hub-btn" style="padding:2px 8px;font-size:11px;" data-cm-action="reset-heuristic" data-heuristic-key="${h.key}">↺</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('')}

    ${renderPlanningRatios()}
  `;
}

/**
 * Phase 6 — render the 142-rule Planning Ratios catalog as a collapsible
 * library below the 26-row Assumptions. Each category card expands to show
 * its rules with source + applicability + override. Feature-flagged.
 */
function renderPlanningRatios() {
  if (!isPlanningRatiosFlagOn()) return '';
  if (!planningRatiosCatalog.length) {
    return `
      <div class="cm-card" style="margin-top:24px;">
        <h3 style="margin-top:0;">Planning Ratios <span class="hub-status-chip" style="margin-left:8px;">Loading…</span></h3>
        <p class="cm-subtle" style="font-size:12px;margin:0;">Engineering defaults catalog (spans of control, facility ratios, storage PSF, seasonality, …).</p>
      </div>
    `;
  }

  const ctx = {
    vertical: (model && model.projectDetails && model.projectDetails.vertical) || null,
    environment_type: (model && model.projectDetails && model.projectDetails.environment) || null,
    automation_level: null,
    market_tier: null,
  };
  const grouped = planningRatios.groupByCategory(planningRatiosCatalog, planningRatioCategories);
  const overrideCount = planningRatios.countRatioOverrides(planningRatioOverrides);

  return `
    <div class="cm-section-header" style="margin-top:32px;padding-top:16px;border-top:2px solid var(--ies-gray-100);">
      <h2>Planning Ratios
        ${overrideCount > 0
          ? `<span class="hub-status-chip" style="margin-left:8px;background:#fbbf24;color:#78350f;">${overrideCount} override${overrideCount === 1 ? '' : 's'}</span>`
          : `<span class="hub-status-chip" style="margin-left:8px;">${planningRatiosCatalog.length} rules · ${planningRatioCategories.length} categories</span>`}
      </h2>
      <p class="cm-subtle">Engineering defaults extracted from the reference 3PL cost model. Spans of control, space ratios, storage $/SF components, seasonality by vertical, asset loaded-cost factors. Override per-scenario; defaults apply to all projects otherwise.</p>
    </div>

    ${grouped.map(({ category, rows }) => {
      if (!rows.length) return '';
      const isOpen = _planningRatioOpenCategory === category.code;
      const resolvedList = rows.map(r => ({
        row: r,
        resolved: planningRatios.lookupRatio(r.ratio_code, ctx, planningRatiosCatalog, planningRatioOverrides),
      }));
      const overridesInCategory = resolvedList.filter(x => x.resolved.source === 'override').length;
      const staleCount = rows.filter(r => planningRatios.isStale(r)).length;
      return `
        <div class="cm-card" style="margin-top:12px;padding:0;overflow:hidden;">
          <button data-pr-toggle-category="${category.code}"
            style="display:flex;width:100%;align-items:center;gap:10px;padding:14px 16px;border:0;background:#fff;cursor:pointer;text-align:left;border-bottom:${isOpen ? '1px solid var(--ies-gray-100)' : '0'};">
            <span style="font-size:14px;font-weight:700;flex:1;">${escapeHtml(category.display_name)}</span>
            ${overridesInCategory > 0 ? `<span class="hub-status-chip" style="background:#fbbf24;color:#78350f;">${overridesInCategory} override${overridesInCategory === 1 ? '' : 's'}</span>` : ''}
            ${staleCount > 0 ? `<span class="hub-status-chip" style="background:#fef3c7;color:#92400e;" title="${staleCount} row(s) with pre-2022 source — audit recommended">${staleCount} stale</span>` : ''}
            <span style="font-size:11px;color:var(--ies-gray-400);">${rows.length} rule${rows.length === 1 ? '' : 's'}</span>
            <span style="font-size:14px;color:var(--ies-gray-400);">${isOpen ? '▾' : '▸'}</span>
          </button>
          ${isOpen ? `
            ${category.description ? `<div style="padding:8px 16px 0;font-size:12px;color:var(--ies-gray-500);">${escapeHtml(category.description)}</div>` : ''}
            <table class="cm-table" style="width:100%;margin-top:8px;">
              <thead>
                <tr>
                  <th style="text-align:left;">Rule</th>
                  <th style="text-align:left;width:28%;">Notes</th>
                  <th style="text-align:right;width:110px;">Default</th>
                  <th style="text-align:right;width:150px;">Your Value</th>
                  <th style="text-align:left;width:160px;">Source</th>
                  <th style="text-align:center;width:50px;"></th>
                </tr>
              </thead>
              <tbody>
                ${resolvedList.map(({ row: r, resolved }) => {
                  const structured = r.value_type === 'array' || r.value_type === 'lookup' || r.value_type === 'tiered';
                  const isOver = resolved.source === 'override';
                  const stale = planningRatios.isStale(r);
                  const ov = planningRatioOverrides[r.ratio_code];
                  const filters = [];
                  if (r.vertical) filters.push(`v: ${r.vertical}`);
                  if (r.environment_type) filters.push(`env: ${r.environment_type}`);
                  if (r.automation_level) filters.push(`auto: ${r.automation_level}`);
                  if (r.market_tier) filters.push(`tier: ${r.market_tier}`);
                  return `
                    <tr data-pr-row="${r.ratio_code}" style="${isOver ? 'background:#fffbeb;' : ''}">
                      <td style="padding:6px 8px;vertical-align:top;">
                        <div style="font-weight:600;font-size:13px;">${escapeHtml(r.display_name)}</div>
                        <div style="font-size:11px;color:var(--ies-gray-500);font-family:monospace;">${escapeHtml(r.ratio_code)}${r.value_unit ? ` · ${escapeHtml(r.value_unit)}` : ''}</div>
                        ${filters.length ? `<div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">${filters.join(' · ')}</div>` : ''}
                      </td>
                      <td style="padding:6px 8px;font-size:11px;color:var(--ies-gray-600);vertical-align:top;">${escapeHtml(r.notes || '')}</td>
                      <td class="cm-num" style="vertical-align:top;">${formatRatioValue({ value: r.value_type === 'array' || r.value_type === 'lookup' || r.value_type === 'tiered' ? r.value_jsonb : r.numeric_value, def: r })}</td>
                      <td class="cm-num" style="vertical-align:top;">
                        ${structured
                          ? `<span style="font-size:11px;color:var(--ies-gray-400);">(structured)</span>`
                          : `<input class="hub-input" type="number" step="any" data-pr-input="${escapeHtml(r.ratio_code)}" value="${ov && ov.value !== undefined && ov.value !== null ? escapeHtml(String(ov.value)) : ''}" placeholder="${r.numeric_value != null ? r.numeric_value : ''}" style="width:130px;text-align:right;" />`}
                      </td>
                      <td style="padding:6px 8px;font-size:11px;color:var(--ies-gray-500);vertical-align:top;">
                        <div>${escapeHtml(r.source || '')}</div>
                        ${r.source_detail ? `<div style="font-size:10px;color:var(--ies-gray-400);">${escapeHtml(r.source_detail)}</div>` : ''}
                        ${stale ? `<div style="margin-top:2px;"><span class="hub-status-chip" style="background:#fef3c7;color:#92400e;font-size:9px;padding:1px 6px;" title="Source pre-2022 — recommend audit before trusting">needs refresh</span></div>` : ''}
                      </td>
                      <td style="text-align:center;vertical-align:top;">
                        ${isOver ? `<button class="hub-btn" style="padding:2px 8px;font-size:11px;" data-cm-action="reset-planning-ratio" data-pr-code="${escapeHtml(r.ratio_code)}" title="Reset to default">↺</button>` : ''}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          ` : ''}
        </div>
      `;
    }).join('')}
  `;
}

/** Tiny escape for user-displayed text pulled from the DB. */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ============================================================
// SECTION 16: SCENARIOS (Phase 3 — status + clone + approve + compare)
// ============================================================

/**
 * Phase 4c: fetch the market labor profile for the active market so the
 * monthly engine can apply per-market OT/absence defaults when a labor
 * line has no per-line profile set.
 *
 * @returns {Promise<boolean>} true if a FRESH fetch happened (caller may re-render)
 */
async function ensureMarketLaborProfileLoaded() {
  const marketId = model?.projectDetails?.market;
  if (!marketId) { currentMarketLaborProfile = null; return false; }
  if (currentMarketLaborProfile && currentMarketLaborProfile.market_id === marketId) return false;
  try {
    currentMarketLaborProfile = await api.fetchLaborMarketProfile(marketId);
    return true;
  } catch (_) { currentMarketLaborProfile = null; return false; }
}

async function ensureScenariosLoaded() {
  const projectId = model?.id;
  const dealId = model?.projectDetails?.dealId || model?.deal_deals_id;
  if (projectId) {
    try { currentScenario = await api.getScenarioByProject(projectId); }
    catch (_) { currentScenario = null; }
    if (currentScenario) {
      try { currentRevisions = await api.listRevisions(currentScenario.id); }
      catch (_) { currentRevisions = []; }
      // Phase 3 close-the-loop: pull snapshots so approved scenarios re-run
      // against their frozen heuristics/rates instead of the live ref_* tables.
      if (currentScenario.status === 'approved') {
        try {
          const grouped = await api.fetchSnapshots(currentScenario.id);
          currentScenarioSnapshots = grouped || null;
        } catch (_) { currentScenarioSnapshots = null; }
      } else {
        currentScenarioSnapshots = null;
      }
    } else {
      currentScenarioSnapshots = null;
    }
  }
  if (dealId) {
    try { dealScenarios = await api.listScenarios(dealId); }
    catch (_) { dealScenarios = []; }
  } else {
    dealScenarios = [];
  }
}

/** Returns HTML for the "Reading frozen rates" banner, or empty string. */
function renderFrozenBanner() {
  if (!currentScenario || currentScenario.status !== 'approved') return '';
  if (!currentScenarioSnapshots) return '';
  const ts = currentScenario.approved_at ? new Date(currentScenario.approved_at).toLocaleDateString() : '';
  const counts = Object.fromEntries(Object.entries(currentScenarioSnapshots).map(([k, v]) => [k, (v || []).length]));
  return `
    <div class="cm-card" style="background:#ecfdf5;border-left:4px solid #059669;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <strong style="color:#065f46;">Reading frozen rates</strong>
        <span style="font-size:12px;color:#065f46;">
          Approved ${ts}${currentScenario.approved_by ? ` · by ${currentScenario.approved_by}` : ''}
          · ${counts.labor || 0} labor · ${counts.facility || 0} facility · ${counts.heuristics || 0} heuristics frozen
        </span>
      </div>
      <div style="font-size:11px;color:#065f46;margin-top:4px;">
        Edits on this scenario spawn a child. To unfreeze, create a child scenario.
      </div>
    </div>
  `;
}

const STATUS_COLORS = {
  draft: '#6b7280',
  review: '#2563eb',
  approved: '#059669',
  archived: '#9ca3af',
};

function renderScenarios() {
  const s = currentScenario;
  const others = dealScenarios.filter(x => !s || x.id !== s.id);
  const statusColor = s ? (STATUS_COLORS[s.status] || '#6b7280') : '#6b7280';

  return `
    <div class="cm-section-header">
      <h2>Scenarios
        ${s ? `<span class="hub-status-chip" style="margin-left:8px;background:${statusColor};color:white;">${s.status}</span>` : ''}
      </h2>
      <p class="cm-subtle">Group alternative designs under one deal. Approve a scenario to freeze its rate cards + heuristics for reproducibility. Edits on approved scenarios create a child.</p>
    </div>

    ${s ? `
      <div class="cm-card" style="margin-top:12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="flex:1;">
            <label style="font-size:11px;color:var(--ies-gray-500);">SCENARIO LABEL</label>
            <input class="hub-input" data-scenario-field="label" value="${s.scenario_label || 'Baseline'}" style="font-size:16px;font-weight:600;margin-top:2px;" ${s.status === 'approved' ? 'disabled' : ''} />
            <div style="margin-top:6px;">
              <label style="font-size:11px;color:var(--ies-gray-500);">DESCRIPTION</label>
              <textarea class="hub-input" data-scenario-field="description" rows="2" style="margin-top:2px;width:100%;" ${s.status === 'approved' ? 'disabled' : ''}>${s.scenario_description || ''}</textarea>
            </div>
            ${s.is_baseline ? '<div style="margin-top:6px;font-size:11px;color:var(--ies-green);">⭐ Baseline scenario</div>' : ''}
            ${s.parent_scenario_id ? `<div style="font-size:11px;color:var(--ies-gray-500);">Child of scenario #${s.parent_scenario_id}</div>` : ''}
            ${s.approved_at ? `<div style="font-size:11px;color:var(--ies-gray-500);margin-top:4px;">Approved ${new Date(s.approved_at).toLocaleString()} · by ${s.approved_by || 'system'}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;min-width:180px;">
            ${s.status === 'draft' ? `
              <button class="hub-btn-primary" data-cm-action="scenario-save-header">Save</button>
              <button class="hub-btn" data-cm-action="scenario-to-review">Move to Review</button>
              <button class="hub-btn-primary" data-cm-action="scenario-approve" style="background:#059669;">Approve + Freeze Rates</button>
            ` : ''}
            ${s.status === 'review' ? `
              <button class="hub-btn-primary" data-cm-action="scenario-approve" style="background:#059669;">Approve + Freeze Rates</button>
              <button class="hub-btn" data-cm-action="scenario-to-draft">Back to Draft</button>
            ` : ''}
            ${s.status === 'approved' ? `
              <button class="hub-btn-primary" data-cm-action="scenario-clone">Edit → Spawn Child</button>
              <button class="hub-btn" data-cm-action="scenario-archive">Archive</button>
            ` : ''}
            ${s.status === 'archived' ? `
              <button class="hub-btn" data-cm-action="scenario-clone">Clone</button>
            ` : ''}
          </div>
        </div>
      </div>
    ` : `
      <div class="cm-card" style="margin-top:12px;background:#fef3c7;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong>No scenario record yet.</strong> This project was created before the Phase 3 migration.
            Click "Initialize scenario" to retroactively add a baseline scenario.
          </div>
          <button class="hub-btn-primary" data-cm-action="scenario-init">Initialize scenario</button>
        </div>
      </div>
    `}

    ${dealScenarios.length > 0 ? `
      <div class="cm-card" style="margin-top:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;">Sibling scenarios on this deal (${dealScenarios.length})</h3>
          <button class="hub-btn" data-cm-action="scenarios-compare-picker" ${dealScenarios.length < 2 ? 'disabled title="Need at least 2 scenarios"' : ''}>Compare scenarios →</button>
        </div>
        <table class="cm-table" style="margin-top:12px;width:100%;">
          <thead>
            <tr>
              <th style="text-align:left;">Label</th>
              <th style="text-align:left;width:100px;">Status</th>
              <th style="text-align:left;width:120px;">Approved</th>
              <th style="text-align:right;width:90px;">Project #</th>
              <th style="width:100px;"></th>
            </tr>
          </thead>
          <tbody>
            ${dealScenarios.map(sc => `
              <tr>
                <td style="padding:6px 8px;">${sc.scenario_label}${sc.is_baseline ? ' ⭐' : ''}${s && sc.id === s.id ? ' <em style="color:var(--ies-gray-500);">(current)</em>' : ''}</td>
                <td><span class="hub-status-chip" style="background:${STATUS_COLORS[sc.status] || '#6b7280'};color:white;">${sc.status}</span></td>
                <td style="font-size:11px;color:var(--ies-gray-500);">${sc.approved_at ? new Date(sc.approved_at).toLocaleDateString() : '—'}</td>
                <td class="cm-num">${sc.project_id || '—'}</td>
                <td>${s && sc.id !== s.id ? `<button class="hub-btn" style="padding:2px 8px;font-size:11px;" data-cm-action="scenario-open" data-scenario-id="${sc.id}" data-project-id="${sc.project_id}">Open</button>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}

    ${currentRevisions.length > 0 ? `
      <div class="cm-card" style="margin-top:16px;">
        <h3 style="margin-top:0;">Revision log (${currentRevisions.length})</h3>
        <table class="cm-table" style="width:100%;">
          <thead>
            <tr>
              <th style="text-align:left;width:60px;">Rev</th>
              <th style="text-align:left;width:160px;">When</th>
              <th style="text-align:left;width:160px;">Who</th>
              <th style="text-align:left;">Summary</th>
            </tr>
          </thead>
          <tbody>
            ${currentRevisions.slice(0, 20).map(r => `
              <tr>
                <td><strong>#${r.revision_number}</strong></td>
                <td style="font-size:11px;">${new Date(r.changed_at).toLocaleString()}</td>
                <td style="font-size:11px;">${r.changed_by || '(anonymous)'}</td>
                <td>${r.change_summary || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}
  `;
}


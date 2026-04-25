/**
 * IES Hub v3 — Network Optimization UI
 * Builder-pattern layout: config sidebar + content area with 4 views.
 * Views: Setup (facilities + demand tables), Map (Leaflet + flow lines),
 *        Results (scenario detail), Comparison (multi-scenario table).
 *
 * @module tools/network-opt/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sM';
import { state } from '../../shared/state.js?v=20260418-sM';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sM';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { renderToolHeader, bindPrimaryActionShortcut, flashRunButton } from '../../shared/tool-frame.js?v=20260419-uE';
import { RunStateTracker } from '../../shared/run-state.js?v=20260419-uE';
import { downloadXLSX } from '../../shared/export.js?v=20260418-sM';
import { markDirty as guardMarkDirty, markClean as guardMarkClean } from '../../shared/unsaved-guard.js?v=20260418-sM';
import * as calc from './calc.js?v=20260425-s8';
import * as api from './api.js?v=20260418-sM';
import { createChart } from '../../shared/cdn-wrappers/chart-wrapper.js?v=20260418-sK';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'setup' | 'map' | 'results' | 'comparison'} */
let activeView = 'setup';

/** @type {'facilities' | 'demand' | 'modemix' | 'service'} */
let activeSection = 'facilities';

/** @type {import('./types.js?v=20260418-sM').Facility[]} */
let facilities = [];

/** @type {import('./types.js?v=20260418-sM').DemandPoint[]} */
let demands = [];

/** @type {import('./types.js?v=20260418-sM').ModeMix} */
let modeMix = { tlPct: 30, ltlPct: 40, parcelPct: 30 };

/** @type {import('./types.js?v=20260418-sM').RateCard} */
let rateCard = { ...calc.DEFAULT_RATES };

/** @type {import('./types.js?v=20260418-sM').ServiceConfig} */
let serviceConfig = { ...calc.DEFAULT_SERVICE };

/** @type {import('./types.js?v=20260418-sM').ScenarioResult[]} */
let scenarios = [];

/** @type {import('./types.js?v=20260418-sM').ScenarioResult|null} */
let activeScenario = null;

/** @type {string|null} */
let selectedArchetype = null;

/** @type {object|null} map instance */
let mapInstance = null;

/** @type {import('./types.js?v=20260418-sM').ScenarioResult[]|null} */
let comparisonResults = null;
let costChartInstance = null; // Chart.js handle for Compare-tab cost-vs-k curve; destroyed before each re-render.

/** @type {number|null} */
let recommendedDCCount = null;
// Slice A (2026-04-25): pre-flight gate on Run. When set, the Results pane
// renders a blocking guidance panel instead of fake zero-cost KPIs.
let runBlockReason = null;
let runBlockDetail = null; // detail object from validateScenarioInputs (errors + warnings)

/** @type {number} */
let maxDCsToTest = 5;

// ============================================================
// DEMO FACILITIES
// ============================================================

const DEMO_FACILITIES = [
  { id: 'f1', name: 'Chicago DC', city: 'Chicago', state: 'IL', lat: 41.8781, lng: -87.6298, capacity: 500000, fixedCost: 2400000, variableCost: 3.50, isOpen: true },
  { id: 'f2', name: 'Dallas DC', city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.7970, capacity: 400000, fixedCost: 1800000, variableCost: 3.20, isOpen: true },
  { id: 'f3', name: 'Atlanta DC', city: 'Atlanta', state: 'GA', lat: 33.7490, lng: -84.3880, capacity: 350000, fixedCost: 1600000, variableCost: 3.00, isOpen: true },
  { id: 'f4', name: 'Los Angeles DC', city: 'Los Angeles', state: 'CA', lat: 34.0522, lng: -118.2437, capacity: 450000, fixedCost: 2800000, variableCost: 4.00, isOpen: true },
  { id: 'f5', name: 'Edison DC', city: 'Edison', state: 'NJ', lat: 40.5187, lng: -74.4121, capacity: 400000, fixedCost: 2200000, variableCost: 3.80, isOpen: true },
  { id: 'f6', name: 'Memphis DC', city: 'Memphis', state: 'TN', lat: 35.1495, lng: -90.0490, capacity: 300000, fixedCost: 1400000, variableCost: 2.80, isOpen: false },
];

// Demo demand points — major US metros
const DEMO_DEMANDS = [
  { id: 'd1', zip3: '100', lat: 40.7128, lng: -74.0060, annualDemand: 85000, maxDays: 2, avgWeight: 25 },
  { id: 'd2', zip3: '900', lat: 34.0522, lng: -118.2437, annualDemand: 72000, maxDays: 2, avgWeight: 30 },
  { id: 'd3', zip3: '606', lat: 41.8781, lng: -87.6298, annualDemand: 55000, maxDays: 3, avgWeight: 20 },
  { id: 'd4', zip3: '770', lat: 29.7604, lng: -95.3698, annualDemand: 48000, maxDays: 3, avgWeight: 35 },
  { id: 'd5', zip3: '852', lat: 33.4484, lng: -112.0740, annualDemand: 32000, maxDays: 3, avgWeight: 25 },
  { id: 'd6', zip3: '303', lat: 33.7490, lng: -84.3880, annualDemand: 42000, maxDays: 2, avgWeight: 20 },
  { id: 'd7', zip3: '752', lat: 32.7767, lng: -96.7970, annualDemand: 38000, maxDays: 3, avgWeight: 30 },
  { id: 'd8', zip3: '331', lat: 25.7617, lng: -80.1918, annualDemand: 35000, maxDays: 3, avgWeight: 25 },
  { id: 'd9', zip3: '981', lat: 47.6062, lng: -122.3321, annualDemand: 28000, maxDays: 3, avgWeight: 20 },
  { id: 'd10', zip3: '191', lat: 39.9526, lng: -75.1652, annualDemand: 40000, maxDays: 2, avgWeight: 25 },
  { id: 'd11', zip3: '021', lat: 42.3601, lng: -71.0589, annualDemand: 36000, maxDays: 2, avgWeight: 25 },
  { id: 'd12', zip3: '802', lat: 39.7392, lng: -104.9903, annualDemand: 26000, maxDays: 3, avgWeight: 30 },
  { id: 'd13', zip3: '554', lat: 44.9778, lng: -93.2650, annualDemand: 22000, maxDays: 3, avgWeight: 25 },
  { id: 'd14', zip3: '481', lat: 42.3314, lng: -83.0458, annualDemand: 30000, maxDays: 3, avgWeight: 35 },
  { id: 'd15', zip3: '980', lat: 47.2529, lng: -122.4443, annualDemand: 18000, maxDays: 3, avgWeight: 20 },
];

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Network Optimizer.
 * @param {HTMLElement} el
 */
let activeConfigId = null;
let activeParentCmId = null;
let isDirty = false;          // I-05 — track unsaved changes

// Run-state tracker: flips the header Run button between orange "dirty"
// and muted green "✓ Results current" based on whether run inputs have
// changed since the last successful optimizer run.
const runState = new RunStateTracker();
function runStateInputs() {
  return { facilities, demands, modeMix, rateCard, serviceConfig, maxDCsToTest };
}
/**
 * Update the Run button's visual state in place. Avoids a full shell re-render
 * when the only thing that changed is the clean/dirty flag.
 */
function updateRunButtonState() {
  if (!rootEl) return;
  const btn = rootEl.querySelector('[data-primary-action="netopt-run"]');
  if (!btn) return;
  const state = runState.state(runStateInputs());
  const isClean = state === 'clean';
  btn.classList.toggle('is-clean', isClean);
  btn.setAttribute('data-run-state', state);
  // Update the visible label + icon slot
  const iconSpan = btn.querySelector('.hub-run-icon');
  const labelSpan = btn.querySelector('span:not(.hub-run-icon):not(.hub-run-shortcut)');
  if (labelSpan) labelSpan.textContent = isClean ? '✓ Results current' : 'Run Scenario';
  if (iconSpan) iconSpan.style.display = isClean ? 'none' : '';
  btn.setAttribute('title', isClean
    ? 'Inputs unchanged since the last run — optimizer results match the current setup. Click to force a re-run.'
    : 'Run optimizer (Cmd/Ctrl+Enter)');
}
let _configName = '';         // I-05 — persisted name for resave

export async function mount(el) {
  rootEl = el;

  // Brock 2026-04-20 — cross-tool: consume COG→NetOpt handoff if present.
  // COG's pushToNetOpt emits a bus event + stashes sessionStorage; this
  // picks the payload up when we mount. The listener below also catches
  // the in-session emit if both tools happen to be open together.
  bus.on('cog:push-to-netopt', (payload) => {
    applyCogHandoff(payload);
  });
  try {
    const pending = sessionStorage.getItem('cog_pending_push');
    if (pending) {
      const payload = JSON.parse(pending);
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('cog_pending_push');
        openEditor(null);
        applyCogHandoff(payload);
        bus.emit('netopt:mounted');
        return;
      }
      sessionStorage.removeItem('cog_pending_push');
    }
  } catch (e) { console.warn('[NetOpt] Failed to consume COG handoff:', e); }

  await renderLanding();
  bus.emit('netopt:mounted');
}

/**
 * Apply COG candidates as NetOpt facility seeds. Called from both the
 * in-session bus listener and the sessionStorage handoff path. Appends
 * to the module-level `facilities` array so the editor's Facility panel
 * renders them; the user can tune fixedCost / variableCost / capacity
 * before running optimization.
 * @param {{ candidates?: Array<{ name:string, lat:number, lng:number, annualDemand?:number }> }} payload
 */
function applyCogHandoff(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  if (candidates.length === 0) return;
  for (const c of candidates) {
    facilities.push({
      id: 'f' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: c.name || `COG Center ${facilities.length + 1}`,
      city: '', state: '',
      lat: Number(c.lat) || 0,
      lng: Number(c.lng) || 0,
      capacity: Number(c.annualDemand) || 200000,
      fixedCost: 1000000,
      variableCost: 3.00,
      isOpen: true,
    });
  }
  markDirty();
  // If the editor shell is rendered, re-render its facility list
  if (rootEl?.querySelector('#no-facilities-panel')) {
    renderFacilities(rootEl);
    renderSidebar();
  }
  console.log(`[NetOpt] Received ${candidates.length} facility candidates from COG`);
}

async function renderLanding() {
  if (!rootEl) return;
  await renderScenarioLanding(rootEl, {
    toolName: 'Network Optimizer',
    toolKey: 'netopt',
    accent: 'var(--ies-teal)',
    list: () => api.listConfigs(),
    getId: (r) => r.id,
    getName: (r) => r.name || r.config_data?.name || 'Untitled network',
    getUpdated: (r) => r.updated_at || r.created_at,
    getParent: (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id }),
    getSubtitle: (r) => {
      const d = r.config_data || {};
      const nFac = (d.facilities || []).length;
      const nDem = (d.demands || []).length;
      return nFac ? `${nFac} facilities · ${nDem} demand points` : '';
    },
    onNew: () => openEditor(null),
    onOpen: (row) => openEditor(row),
    onDelete: async (row) => { await api.deleteConfig(row.id); },
    onCopy: async (row) => await api.duplicateConfig(row.id),
    onLink: async (row, cmId) => { await api.linkToCm(row.id, cmId); },
    onUnlink: async (row) => { await api.unlinkFromCm(row.id); },
    emptyStateHint: 'Optimize TL/LTL/Parcel mix across facility and demand sets. Run multi-DC comparisons, exhaustive searches, and heatmap overlays — every scenario saves here.',
  });
}

function openEditor(savedRow) {
  if (!rootEl) return;
  activeView = 'setup';
  activeSection = 'facilities';
  const d = savedRow?.config_data || {};
  // 2026-04-21 audit fix: new configs start EMPTY. Demo network available
  // via the "Load Sample Network" button on the Facilities section so users
  // can still reach it intentionally. Prior behavior auto-loaded 5 DCs + 10
  // demand points on every "New Config".
  facilities = (d.facilities && d.facilities.length) ? d.facilities.map(f => ({ ...f })) : [];
  demands = (d.demands && d.demands.length) ? d.demands.map(x => ({ ...x })) : [];
  modeMix = d.modeMix || { tlPct: 30, ltlPct: 40, parcelPct: 30 };
  rateCard = d.rateCard || { ...calc.DEFAULT_RATES };
  serviceConfig = d.serviceConfig || { ...calc.DEFAULT_SERVICE };
  scenarios = [];
  activeScenario = null;
  selectedArchetype = null;
  comparisonResults = null;
  recommendedDCCount = null;
  runBlockReason = null;
  runBlockDetail = null;
  maxDCsToTest = 5;
  activeConfigId = savedRow?.id || null;
  activeParentCmId = savedRow?.parent_cost_model_id || null;
  isDirty = false;
  _configName = savedRow?.name || d.name || '';
  // New editor session — the prior scenario's run-state tracker is stale.
  // If the loaded scenario already has saved results, we treat that as the
  // clean baseline (saved row → results were computed against saved inputs).
  runState.reset();
  if (savedRow && d.scenarios && d.scenarios.length > 0) {
    runState.markClean({ facilities, demands, modeMix, rateCard, serviceConfig, maxDCsToTest });
  }

  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderSidebar();
  renderContentView();

  // Wire the "← Scenarios" back button.
  rootEl.querySelector('[data-action="netopt-back"]')?.addEventListener('click', async () => {
    if (isDirty && !confirm('You have unsaved changes. Leave anyway?')) return;
    guardMarkClean('netopt');
    await renderLanding();
  });
}

// I-05 — dirty tracking + Save handler
function markDirty() {
  // Run-state check runs regardless of isDirty short-circuit — even repeat
  // edits against a clean run should flip the Run button back to orange.
  updateRunButtonState();
  if (isDirty) return;
  isDirty = true;
  guardMarkDirty('netopt');
  updateHeaderSaveState();
}
function updateHeaderSaveState() {
  if (!rootEl) return;
  const btn = rootEl.querySelector('[data-action="netopt-save"]');
  if (!btn) return;
  btn.removeAttribute('disabled');
  btn.textContent = isDirty ? (activeConfigId ? '💾 Save' : '💾 Save Scenario') : (activeConfigId ? '✓ Saved' : '💾 Save Scenario');
  btn.classList.toggle('hub-btn-primary', isDirty);
  btn.classList.toggle('hub-btn-secondary', !isDirty);
  const draftChip = rootEl.querySelector('.hub-status-chip.draft, .hub-status-chip.saved');
  if (draftChip) {
    draftChip.classList.toggle('saved', !!activeConfigId);
    draftChip.classList.toggle('draft', !activeConfigId);
    draftChip.textContent = activeConfigId ? 'Saved' : 'Draft';
  }
}
async function handleSaveNetopt() {
  try {
    let name = _configName;
    if (!activeConfigId) {
      const defaultName = name || `Network ${new Date().toLocaleDateString()}`;
      const entered = window.prompt('Name this scenario:', defaultName);
      if (entered === null) return;
      name = (entered || '').trim() || defaultName;
    }
    const payload = {
      id: activeConfigId || undefined,
      name,
      facilities,
      demands,
      modeMix,
      rateCard,
      serviceConfig,
    };
    const saved = await api.saveConfig(payload);
    activeConfigId = saved?.id || activeConfigId;
    _configName = saved?.name || name;
    isDirty = false;
    guardMarkClean('netopt');
    rootEl.innerHTML = renderShell();
    bindShellEvents();
    renderSidebar();
    renderContentView();
    showToast(`Saved "${_configName}".`, 'ok');
  } catch (err) {
    console.error('[NetOpt] save failed:', err);
    showToast(`Save failed: ${err.message || err}`, 'err');
  }
}

/**
 * Cleanup.
 */
export function unmount() {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  bus.clear('cog:push-to-netopt'); // free the COG handoff listener
  runState.reset();
  rootEl = null;
  bus.emit('netopt:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  const tabs = ['setup', 'map', 'results', 'comparison'].map(v => ({ key: v, label: viewLabel(v) }));
  const chips = [
    { label: activeConfigId ? 'Saved' : 'Draft', kind: activeConfigId ? 'saved' : 'draft', dot: true },
    activeParentCmId
      ? { label: 'Linked to CM', kind: 'linked', title: `Linked to Cost Model #${activeParentCmId}` }
      : { label: scenarios.length ? `${scenarios.length} scenarios run` : 'Stand-alone', kind: scenarios.length ? 'linked' : 'standalone' },
  ];
  return `
    <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height:100%;">
      ${renderToolHeader({
        toolName: 'Network Optimizer',
        toolKey: 'netopt',
        backAction: 'netopt-back',
        tabs,
        activeTab: activeView,
        tabsId: 'no-view-tabs',
        statusChips: chips,
        // I-05 — Save button always visible so work persists across tab closes.
        secondaryActions: [
          { label: isDirty ? (activeConfigId ? '💾 Save' : '💾 Save Scenario') : (activeConfigId ? '✓ Saved' : '💾 Save Scenario'),
            action: 'netopt-save',
            primary: isDirty,
            title: activeConfigId ? 'Update this scenario' : 'Save this scenario so you can reopen it later' },
        ],
        primaryAction: {
          label: 'Run Scenario',
          action: 'netopt-run',
          icon: '▶',
          title: 'Run optimizer (Cmd/Ctrl+Enter)',
          state: runState.state(runStateInputs()),
          cleanLabel: '✓ Results current',
          cleanTitle: 'Inputs unchanged since the last run — optimizer results match the current setup. Click to force a re-run.',
        },
      })}

      <!-- P1 #6 — process-flow chip strip (Setup -> Optimize -> Run -> Compare). Populated by renderProcessFlow(). -->
      <div id="no-process-flow" style="margin-top:8px;"></div>

      <!-- Main area: sidebar + content -->
      <div style="display:flex;flex:1;overflow:hidden;">
        <!-- Sidebar -->
        <div id="no-sidebar" style="width:232px;flex-shrink:0;border-right:1px solid var(--ies-gray-200);padding:14px 12px;overflow-y:auto;">
        </div>
        <!-- Content -->
        <div id="no-content" style="flex:1;overflow-y:auto;padding:24px;">
        </div>
      </div>
    </div>
  `;
}

function viewLabel(v) {
  const labels = { setup: 'Setup', map: 'Network Map', results: 'Results', comparison: 'Compare' };
  return labels[v] || v;
}

function bindShellEvents() {
  if (!rootEl) return;

  // View tabs (now [data-tab] from shared tool-frame)
  rootEl.querySelector('#no-view-tabs')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-tab]');
    if (!btn) return;
    activeView = /** @type {any} */ (btn.dataset.tab);
    rootEl.querySelectorAll('#no-view-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeView);
    });
    renderContentView();
  });

  // Header primary action proxies to the existing sidebar Run button so we keep one code path.
  const headerRun = rootEl.querySelector('[data-primary-action="netopt-run"]');
  headerRun?.addEventListener('click', () => {
    const sidebarRun = rootEl.querySelector('[data-action="run"]');
    if (sidebarRun) /** @type {HTMLButtonElement} */ (sidebarRun).click();
    flashRunButton(headerRun);
  });
  bindPrimaryActionShortcut(rootEl, 'netopt-run');

  // I-05 — Save button (in the header secondaryActions rail).
  rootEl.querySelector('[data-action="netopt-save"]')?.addEventListener('click', handleSaveNetopt);

  // Sidebar clicks
  rootEl.querySelector('#no-sidebar')?.addEventListener('click', (e) => {
    const item = /** @type {HTMLElement} */ (e.target).closest('[data-section]');
    if (!item) return;
    activeSection = /** @type {any} */ (item.dataset.section);
    renderSidebar();
    if (activeView === 'setup') renderContentView();
  });

  // P1 #6 — process-flow chip clicks. Each chip jumps to the canonical view+section
  // for that phase. The phase chip strip is purely a navigation-and-status surface;
  // the content tabs (no-view-tabs) and sidebar sections both still work.
  rootEl.querySelector('#no-process-flow')?.addEventListener('click', (e) => {
    const chip = /** @type {HTMLElement} */ (e.target).closest('[data-phase]');
    if (!chip) return;
    jumpToPhase(/** @type {any} */ (chip.dataset.phase));
  });
}

// ============================================================
// PROCESS FLOW (P1 #6 — 2026-04-25 EVE)
// ============================================================
// Horizontal chip strip showing the user's progress through the optimization
// workflow: Setup -> Optimize -> Run -> Compare. Each chip is clickable and
// jumps the view+sidebar to the canonical entry point for that phase. Status
// is computed from current state (presence of demand/facilities/results/comparison).

/** @returns {{setup: 'pending'|'active'|'complete', optimize: 'pending'|'active'|'complete', run: 'pending'|'active'|'complete', compare: 'pending'|'active'|'complete'}} */
function phaseStatus() {
  const hasDemand = demands.length > 0;
  const hasFacilities = facilities.length > 0;
  const hasOpenFacilities = facilities.some(f => f.isOpen);
  const hasResult = !!activeScenario;
  const hasComparison = Array.isArray(comparisonResults) && comparisonResults.length > 0;

  const setupComplete = hasDemand && hasFacilities;
  const optimizeComplete = hasOpenFacilities && hasDemand;

  return {
    setup: setupComplete ? 'complete' : (hasDemand || hasFacilities ? 'active' : 'pending'),
    optimize: optimizeComplete ? 'complete' : (setupComplete ? 'active' : 'pending'),
    run: hasResult ? 'complete' : (optimizeComplete ? 'active' : 'pending'),
    compare: hasComparison ? 'complete' : (hasResult ? 'active' : 'pending'),
  };
}

function renderProcessFlow() {
  const el = rootEl?.querySelector('#no-process-flow');
  if (!el) return;
  const s = phaseStatus();
  const phases = [
    { key: 'setup',    num: 1, label: 'Setup',    sub: 'Demand + facilities' },
    { key: 'optimize', num: 2, label: 'Optimize', sub: 'Find candidates · balance' },
    { key: 'run',      num: 3, label: 'Run',      sub: 'Compute cost + service' },
    { key: 'compare',  num: 4, label: 'Compare',  sub: 'k-sweep + sensitivity' },
  ];
  // Pending: gray. Active: solid blue. Complete: green check.
  const styleFor = (status) => {
    if (status === 'complete') return { circleBg: 'var(--ies-green, #047857)', label: 'var(--ies-green, #047857)', circleFg: '#fff', icon: '✓' };
    if (status === 'active')   return { circleBg: 'var(--ies-blue)',           label: 'var(--ies-blue)',           circleFg: '#fff', icon: null };
    return                              { circleBg: 'var(--ies-gray-300)',     label: 'var(--ies-gray-500)',       circleFg: '#fff', icon: null };
  };
  el.innerHTML = `
    <div style="display:flex;align-items:stretch;gap:0;padding:8px 14px 10px 14px;background:var(--ies-gray-50, #f9fafb);border-bottom:1px solid var(--ies-gray-200);">
      ${phases.map((p, idx) => {
        const status = s[p.key];
        const c = styleFor(status);
        const display = c.icon || String(p.num);
        return `
          <div data-phase="${p.key}"
               role="button" tabindex="0"
               style="flex:1;display:flex;align-items:center;gap:9px;cursor:pointer;padding:5px 8px;border-radius:6px;min-width:0;transition:background .15s;"
               onmouseover="this.style.background='var(--ies-gray-100)'"
               onmouseout="this.style.background='transparent'"
               title="Jump to ${p.label} (status: ${status})">
            <div style="width:26px;height:26px;border-radius:50%;background:${c.circleBg};color:${c.circleFg};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0;">
              ${display}
            </div>
            <div style="display:flex;flex-direction:column;line-height:1.2;min-width:0;">
              <span style="font-size:12px;font-weight:700;color:${c.label};">${p.label}</span>
              <span style="font-size:10px;color:var(--ies-gray-500);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.sub}</span>
            </div>
          </div>
          ${idx < phases.length - 1 ? `
            <div style="display:flex;align-items:center;color:var(--ies-gray-300);font-size:13px;padding:0 2px;flex-shrink:0;">▶</div>
          ` : ''}
        `;
      }).join('')}
    </div>
  `;
}

/** @param {'setup'|'optimize'|'run'|'compare'} phase */
function jumpToPhase(phase) {
  switch (phase) {
    case 'setup':
      activeView = 'setup';
      // If demand isn't loaded yet, that's the natural starting point.
      activeSection = (demands.length === 0) ? 'demand' : 'facilities';
      break;
    case 'optimize':
      activeView = 'setup';
      activeSection = 'modemix';
      // Surface the OPTIMIZE block in the sidebar.
      setTimeout(() => {
        rootEl?.querySelector('#no-sidebar [data-phase-block="optimize"]')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      break;
    case 'run':
      activeView = 'results';
      break;
    case 'compare':
      activeView = 'comparison';
      break;
  }
  // Sync the tool-frame view-tab buttons.
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === activeView);
  });
  renderSidebar();
  renderContentView();
}

// ============================================================
// SIDEBAR
// ============================================================

function renderSidebar() {
  const el = rootEl?.querySelector('#no-sidebar');
  if (!el) return;

  // P1 #6 — sidebar reorganized into Setup -> Optimize -> Run/Review -> Utilities phase blocks.
  // Sections (Demand/Facilities/Mode Mix/Service Config) are split across SETUP and OPTIMIZE
  // by their nature: SETUP holds raw inputs (demand, candidate facilities) + archetype quick-seed;
  // OPTIMIZE holds cost/service assumptions (mode mix, service) + the actions that act on inputs
  // (Find Optimal, Balance, Apply Rates, Upload CSV) + the Max-DCs sweep ceiling.
  const status = phaseStatus();
  const setupSections = [
    { key: 'demand',     label: 'Demand Points', icon: '📍', count: String(demands.length) },
    { key: 'facilities', label: 'Facilities',    icon: '🏭', count: facilities.filter(f => f.isOpen).length + '/' + facilities.length },
  ];
  const optimizeSections = [
    { key: 'modemix', label: 'Mode Mix',       icon: '🚛', count: '' },
    { key: 'service', label: 'Service Config', icon: '⏱',  count: '' },
  ];

  const phaseBadge = (num, status) => {
    const bg = status === 'complete' ? 'var(--ies-green, #047857)' : status === 'active' ? 'var(--ies-blue)' : 'var(--ies-gray-300)';
    const display = status === 'complete' ? '✓' : String(num);
    return `<div style="width:18px;height:18px;border-radius:50%;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:10px;flex-shrink:0;">${display}</div>`;
  };
  const phaseHeader = (num, label, status, sub) => `
    <div style="display:flex;align-items:center;gap:8px;margin:0 0 6px 0;padding:0 2px;">
      ${phaseBadge(num, status)}
      <span class="text-caption" style="color:var(--ies-gray-500);font-weight:700;letter-spacing:0.5px;font-size:10px;">${label}</span>
    </div>
    <div style="font-size:10px;color:var(--ies-gray-400);margin:0 0 8px 28px;line-height:1.3;">${sub}</div>
  `;
  const renderSection = (s) => `
    <div data-section="${s.key}" style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;cursor:pointer;margin-bottom:3px;
         background:${s.key === activeSection ? 'var(--ies-blue)' : 'transparent'};
         color:${s.key === activeSection ? '#fff' : 'var(--ies-gray-600)'};">
      <span style="font-size:14px;">${s.icon}</span>
      <span style="font-size:12px;font-weight:600;flex:1;">${s.label}</span>
      ${s.count ? `<span style="font-size:10px;font-weight:700;opacity:0.75;">${s.count}</span>` : ''}
    </div>
  `;

  el.innerHTML = `
    <!-- PHASE 1: SETUP -->
    <div data-phase-block="setup" style="margin-bottom:6px;">
      ${phaseHeader(1, 'SETUP', status.setup, 'Add demand and candidate facilities.')}
      ${setupSections.map(renderSection).join('')}

      <details style="margin:8px 0 4px 0;" ${selectedArchetype ? 'open' : ''}>
        <summary style="font-size:10px;color:var(--ies-gray-500);cursor:pointer;padding:5px 4px;font-weight:700;letter-spacing:0.4px;">
          QUICK-SEED · ARCHETYPES ▾
        </summary>
        <div style="margin-top:4px;padding-left:2px;">
          ${calc.listArchetypes().map(a => `
            <button class="hub-btn hub-btn-sm hub-btn-secondary" data-archetype="${a.key}"
                    style="width:100%;margin-bottom:4px;font-size:10px;text-align:left;padding:4px 8px;${selectedArchetype === a.key ? 'border-color:var(--ies-blue);color:var(--ies-blue);' : ''}">
              ${a.name}
            </button>
          `).join('')}
        </div>
      </details>
    </div>

    <div style="border-top:1px solid var(--ies-gray-200);margin:10px 0;"></div>

    <!-- PHASE 2: OPTIMIZE -->
    <div data-phase-block="optimize" style="margin-bottom:6px;">
      ${phaseHeader(2, 'OPTIMIZE', status.optimize, 'Find candidates, balance modes, and apply rates.')}
      ${optimizeSections.map(renderSection).join('')}

      <div style="display:flex;flex-direction:column;gap:5px;margin-top:8px;">
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="find-optimal" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;" title="Weighted k-means on your demand → recommended DC metros. Adds candidate facilities to the list without opening them; you pick which to activate.">🎯 Find Optimal Locations</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="balance-mode-mix" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;" title="Auto-balance TL/LTL/Parcel mix to match average demand weight">⚖ Balance Mode Mix</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="apply-market-rates" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;" title="Pull latest spot/contract rates from market data and apply to rate card">💲 Apply Market Rates</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="upload-rates-csv" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;">📤 Upload Rate Card CSV</button>
      </div>

      <div style="margin-top:10px;padding:6px 4px;">
        <label style="display:block;font-size:10px;font-weight:700;color:var(--ies-gray-500);margin-bottom:4px;letter-spacing:0.3px;">MAX DCs TO TEST (k-sweep)</label>
        <input type="number" id="netopt-max-dcs" min="1" max="20" value="${maxDCsToTest}" style="width:100%;padding:5px 7px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:11px;"/>
      </div>
    </div>

    <div style="border-top:1px solid var(--ies-gray-200);margin:10px 0;"></div>

    <!-- PHASE 3 + 4: RUN & REVIEW -->
    <div data-phase-block="run" style="margin-bottom:6px;">
      ${phaseHeader(3, 'RUN & REVIEW', status.run, 'Compute, compare, and search.')}
      <div style="display:flex;flex-direction:column;gap:5px;">
        <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="run" style="width:100%;font-weight:700;padding:7px 10px;">▶ Run Scenario</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="compare-dcs" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;" title="Sweep k from 1 to Max DCs and chart the cost-vs-k curve with elbow point">📊 Compare DCs (k-sweep)</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="exact-solve" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;" title="Brute-force enumeration of all C(n,k) combinations — best for small candidate sets (≤10)">🧮 Exhaustive Search</button>
      </div>
    </div>

    <div style="border-top:1px solid var(--ies-gray-200);margin:10px 0;"></div>

    <!-- UTILITIES -->
    <div data-phase-block="utilities">
      <div style="display:flex;align-items:center;gap:8px;margin:0 0 8px 0;padding:0 2px;">
        <span class="text-caption" style="color:var(--ies-gray-400);font-weight:700;letter-spacing:0.5px;font-size:10px;">UTILITIES</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="export-csv" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;">📥 Export XLSX</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="clear-scenarios" style="width:100%;font-size:11px;text-align:left;padding:6px 10px;color:var(--ies-red, #b91c1c);">🗑 Clear All</button>
      </div>
      <input type="file" id="netopt-csv-upload" accept=".csv,text/csv" style="display:none;"/>
    </div>
  `;

  // Archetype buttons
  el.querySelectorAll('[data-archetype]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = /** @type {HTMLElement} */ (btn).dataset.archetype;
      applyArchetype(key);
      markDirty();
    });
  });

  // Action buttons
  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = /** @type {HTMLElement} */ (btn).dataset.action;
      // I-05 — the sidebar's Save button is handled at the shell level.
      if (action === 'netopt-save') return;
      if (action === 'run') { runScenario(); markDirty(); }
      else if (action === 'find-optimal') { findOptimalLocations(); markDirty(); }
      else if (action === 'compare-dcs') { compareMultipleDCs(); markDirty(); }
      else if (action === 'exact-solve')  { runExactSolver();    markDirty(); }
      else if (action === 'export-csv') exportToCSV();
      else if (action === 'clear-scenarios') { scenarios = []; activeScenario = null; comparisonResults = null; markDirty(); renderContentView(); }
      else if (action === 'apply-market-rates') { applyMarketRates(); markDirty(); }
      else if (action === 'balance-mode-mix')   { balanceModeMix();    markDirty(); }
      else if (action === 'upload-rates-csv') document.getElementById('netopt-csv-upload')?.click();
    });
  });

  // Max DCs input
  const maxDcsInput = el.querySelector('#netopt-max-dcs');
  maxDcsInput?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10) || 5;
    maxDCsToTest = Math.max(1, Math.min(20, val));
    // Clear stale comparison results
    comparisonResults = null;
    recommendedDCCount = null;
    e.target.value = String(maxDCsToTest);
  });

  // CSV rate card upload
  const fileInput = el.querySelector('#netopt-csv-upload');
  fileInput?.addEventListener('change', handleCsvUpload);

  // P1 #6 — keep the process-flow chip strip in sync with sidebar render.
  renderProcessFlow();
}

/** Pull latest freight_rates avg from Supabase and apply to rateCard. */
async function applyMarketRates() {
  try {
    const rates = await api.fetchFreightRates();
    if (!rates || !rates.length) { showNoToast('No market rate data available', 'info'); return; }
    // Take latest rate per index_name
    const byIdx = new Map();
    for (const r of rates) {
      const k = r.index_name || r.rate_type || 'default';
      const prev = byIdx.get(k);
      if (!prev || (r.report_date || '') > (prev.report_date || '')) byIdx.set(k, r);
    }
    const spot = Array.from(byIdx.values()).find(r => /spot/i.test(r.rate_type || '') || /spot/i.test(r.index_name || ''));
    const contract = Array.from(byIdx.values()).find(r => /contract/i.test(r.rate_type || '') || /contract/i.test(r.index_name || ''));
    const tlPerMile = parseFloat((contract?.rate || spot?.rate || rateCard.tlPerMile || 2.25));
    rateCard.tlPerMile = tlPerMile;
    // LTL per lb approximation: TL / (TL capacity ~44000 lb)
    rateCard.ltlPerLb = Math.max(0.15, tlPerMile / 90);
    showNoToast(`Applied latest market rates (TL $${tlPerMile.toFixed(2)}/mi)`, 'success');
    renderContentView();
  } catch (err) {
    console.error('[netopt] applyMarketRates failed', err);
    showNoToast('Market rate fetch failed', 'error');
  }
}

/** Auto-balance the TL / LTL / Parcel mix to satisfy the archetype targets
 *  using average demand weight. Conservative heuristic — see calc.js. */
function balanceModeMix() {
  // Weight-based heuristic: heavier avg weight favors TL; lighter favors Parcel.
  const avgWeight = demands.reduce((s, d) => s + (d.avgWeight || 25), 0) / Math.max(1, demands.length);
  let tl, ltl, parcel;
  if (avgWeight > 500) { tl = 70; ltl = 25; parcel = 5; }
  else if (avgWeight > 100) { tl = 35; ltl = 55; parcel = 10; }
  else if (avgWeight > 25) { tl = 15; ltl = 45; parcel = 40; }
  else { tl = 5; ltl = 25; parcel = 70; }
  modeMix = { tlPct: tl, ltlPct: ltl, parcelPct: parcel };
  showNoToast(`Balanced mode mix to avg weight ${avgWeight.toFixed(0)} lb`, 'success');
  renderContentView();
}

/** Parse a CSV rate card upload. Expects columns: lane,mode,rate. */
function handleCsvUpload(e) {
  const file = /** @type {HTMLInputElement} */ (e.currentTarget).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const text = String(ev.target.result || '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) { showNoToast('Empty CSV', 'error'); return; }
    let applied = 0;
    for (let i = 1; i < lines.length; i++) {
      const [_lane, mode, rate] = lines[i].split(',').map(s => s.trim());
      const r = parseFloat(rate);
      if (!isNaN(r)) {
        if (/tl/i.test(mode)) { rateCard.tlPerMile = r; applied++; }
        else if (/ltl/i.test(mode)) { rateCard.ltlPerLb = r; applied++; }
        else if (/parcel/i.test(mode)) { rateCard.parcelPerLb = r; applied++; }
      }
    }
    showNoToast(`Rate card CSV applied (${applied} rate${applied === 1 ? '' : 's'})`, 'success');
    renderContentView();
  };
  reader.onerror = () => showNoToast('CSV read failed', 'error');
  reader.readAsText(file);
}

function showNoToast(msg, level) {
  try {
    const ev = new CustomEvent('toast:show', { detail: { message: msg, level } });
    // Prefer event bus if present; fall back to console.
    if (window.__hubToast) window.__hubToast(msg, level);
    else console.log(`[netopt toast] ${level}: ${msg}`);
  } catch { console.log(msg); }
}

function applyArchetype(key) {
  const arch = calc.getArchetype(key);
  if (!arch) return;
  selectedArchetype = key;
  modeMix = { ...arch.modeMix };
  serviceConfig = { ...serviceConfig, globalMaxDays: arch.maxDays };

  // If the user has no demand yet, seed the demo 15-metro demand set and
  // scale each point proportionally so total annual demand matches this
  // archetype's baseVolume. Gives the archetype button an IMMEDIATE visible
  // effect (it was silently updating mode mix only, which felt dead).
  // When demand exists, we only apply maxDays — don't trample the user's data.
  if (demands.length === 0) {
    const baseTotal = DEMO_DEMANDS.reduce((s, d) => s + d.annualDemand, 0);
    const scale = (arch.baseVolume || baseTotal) / baseTotal;
    demands = DEMO_DEMANDS.map(d => ({
      ...d,
      annualDemand: Math.round(d.annualDemand * scale),
      maxDays: arch.maxDays,
    }));
    showNoToast(`Applied ${arch.name} — seeded ${demands.length} demand points at ${(arch.baseVolume || baseTotal).toLocaleString()} total annual volume`, 'success');
  } else {
    demands = demands.map(d => ({ ...d, maxDays: arch.maxDays }));
    showNoToast(`Applied ${arch.name} — mode mix ${arch.modeMix.tlPct}/${arch.modeMix.ltlPct}/${arch.modeMix.parcelPct} + max ${arch.maxDays}-day service`, 'success');
  }
  renderSidebar();
  // Re-render whichever view is active so visible state updates (Facilities
  // counts, Demand table, Service banner).
  renderContentView();
}

/**
 * Run weighted k-means on demand points → recommend N facility metros and
 * add them to the facility list as candidates (not opened). Restores the
 * v2 Auto-Recommend capability.
 */
function findOptimalLocations() {
  if (demands.length === 0) {
    alert('Add demand points first. The optimizer needs demand to cluster against.\n\nTip: pick an Archetype in the sidebar to seed a demo demand set.');
    return;
  }
  const k = Math.max(1, Math.min(maxDCsToTest || 3, 8));
  const existingCities = facilities.map(f => (f.city || '').toLowerCase().trim()).filter(Boolean);
  // calc.findOptimalLocations weights by volume + maps each cluster to the
  // nearest real metro (deduplicated so two close clusters can't collapse
  // to the same city).
  const recs = calc.findOptimalLocations(
    demands.map(d => ({ id: d.id, lat: d.lat, lng: d.lng, volume: d.annualDemand })),
    k,
    { excludeCities: existingCities },
  );
  if (!recs || recs.length === 0) {
    alert('Could not recommend locations — check that demand points have lat/lng coordinates.');
    return;
  }
  // Add recommendations as candidate facilities (isOpen false — user picks which to activate).
  for (const r of recs) {
    facilities.push({
      id: r.id,
      name: r.name,
      city: r.city,
      state: r.state,
      lat: r.lat,
      lng: r.lng,
      capacity: Math.max(200000, Math.round(r.clusterWeight * 1.2)),
      fixedCost: 1_200_000,
      variableCost: 2.80,
      isOpen: false,
    });
  }
  activeSection = 'facilities';
  renderSidebar();
  renderContentView();
  showNoToast(`Recommended ${recs.length} DC location${recs.length > 1 ? 's' : ''} based on demand clusters — activate the ones to evaluate, then hit Run Scenario`, 'success');
}

// ============================================================
// SCENARIO EXECUTION
// ============================================================

function runScenario() {
  // Slice A: refuse to compute against incomplete inputs. Surface the reason
  // inline on the Results tab rather than producing fake $0 KPIs that look
  // valid (the run-state chip would otherwise flip to clean against garbage).
  if (demands.length === 0) {
    runBlockReason = 'no-demand';
    activeScenario = null;
    activeView = 'results';
    rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeView);
    });
    renderContentView();
    return;
  }
  if (facilities.filter(f => f.isOpen).length === 0) {
    runBlockReason = 'no-open-facilities';
    activeScenario = null;
    activeView = 'results';
    rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeView);
    });
    renderContentView();
    return;
  }
  // 2026-04-25 bug-fix: validate every facility/demand before running. A
  // single facility with a blank lat would corrupt the assignment sort and
  // produce NaN avg distance / $0 transport / $0 handling — an easy
  // mistake from manual edits or a CoG handoff with bad coords. The gate
  // now refuses to run and tells the user which row is broken.
  const validation = calc.validateScenarioInputs(facilities, demands);
  if (!validation.ok) {
    runBlockReason = 'invalid-inputs';
    runBlockDetail = validation;
    activeScenario = null;
    activeView = 'results';
    rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeView);
    });
    renderContentView();
    return;
  }
  runBlockReason = null;
  runBlockDetail = null;
  const name = `Scenario ${scenarios.length + 1} — ${facilities.filter(f => f.isOpen).length} DCs`;
  const result = calc.evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig);
  activeScenario = result;
  activeView = 'results';
  // Run succeeded — stash the inputs so the header Run button flips to the
  // muted "✓ Results current" state until the user changes something.
  runState.markClean(runStateInputs());
  // Update view tabs
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
  updateRunButtonState();
}

function addToComparison() {
  const name = `Scenario ${scenarios.length + 1} — ${facilities.filter(f => f.isOpen).length} DCs`;
  const result = calc.evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig);
  scenarios.push(result);
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function compareMultipleDCs() {
  if (demands.length === 0) {
    alert('Please add demand points first.');
    return;
  }
  comparisonResults = calc.multiDCComparison(facilities, demands, modeMix, rateCard, serviceConfig, maxDCsToTest);
  const rec = calc.recommendOptimalDCs(comparisonResults);
  recommendedDCCount = rec.recommendedIdx;
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function runExactSolver() {
  if (demands.length === 0) {
    alert('Please add demand points first.');
    return;
  }
  const openCount = facilities.filter(f => f.isOpen).length;
  if (openCount === 0) {
    alert('Please activate at least one facility.');
    return;
  }
  const result = calc.exactSolver(facilities, demands, maxDCsToTest, modeMix, rateCard, serviceConfig);
  if (!result) {
    alert('Exhaustive search space is too large (>10,000 combinations). Use comparison instead.');
    return;
  }
  comparisonResults = result.scenarios;
  const rec = calc.recommendOptimalDCs(comparisonResults);
  recommendedDCCount = rec.recommendedIdx;
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function exportToCSV() {
  if (!activeScenario && !comparisonResults) {
    alert('Run a scenario first to export data.');
    return;
  }

  const sheets = {};
  const timestamp = new Date().toISOString();

  // Facilities sheet
  const facilitiesData = [
    ['Name', 'City', 'State', 'Lat', 'Lng', 'Capacity', 'Fixed Cost', 'Variable Cost', 'Is Open'],
    ...facilities.map(f => [
      f.name, f.city || '', f.state || '',
      parseFloat(f.lat.toFixed(4)),
      parseFloat(f.lng.toFixed(4)),
      f.capacity || 0, f.fixedCost || 0, f.variableCost || 0, f.isOpen ? 'Yes' : 'No'
    ])
  ];
  sheets['Facilities'] = facilitiesData;

  // Demand sheet
  const demandData = [
    ['ZIP3', 'Lat', 'Lng', 'Annual Demand', 'Max Days', 'Avg Weight (lbs)'],
    ...demands.map(d => [
      d.zip3 || '', parseFloat(d.lat.toFixed(4)), parseFloat(d.lng.toFixed(4)),
      d.annualDemand, d.maxDays || 3, d.avgWeight || 25
    ])
  ];
  sheets['Demand'] = demandData;

  // Assignments sheet (per scenario)
  if (activeScenario && activeScenario.assignments.length > 0) {
    const assignmentsData = [
      ['Facility ID', 'Demand ID', 'Distance (mi)', 'Transit Days', 'TL Cost', 'LTL Cost', 'Parcel Cost', 'Blended Cost', 'Meets SLA'],
      ...activeScenario.assignments.map(a => [
        a.facilityId, a.demandId,
        parseFloat(a.distanceMiles.toFixed(1)),
        a.transitDays,
        parseFloat(a.tlCost.toFixed(2)),
        parseFloat(a.ltlCost.toFixed(2)),
        parseFloat(a.parcelCost.toFixed(2)),
        parseFloat(a.blendedCost.toFixed(2)),
        a.meetsSlA ? 'Yes' : 'No'
      ])
    ];
    sheets['Assignments'] = assignmentsData;
  }

  // Comparison sheet (multi-scenario)
  if (comparisonResults && comparisonResults.length > 0) {
    const comparisonData = [
      ['DC Count', 'Total Cost', 'Avg Distance (mi)', 'Service Level (%)', 'SLA Met', 'Avg Cost/Unit'],
      ...comparisonResults.map((s, i) => [
        i + 1,
        parseFloat(s.totalCost.toFixed(2)),
        parseFloat(s.avgDistance.toFixed(1)),
        parseFloat(s.serviceLevel.toFixed(1)),
        `${s.slaMet}/${s.slaTotal}`,
        parseFloat(s.avgCostPerUnit.toFixed(2))
      ])
    ];
    sheets['Comparison'] = comparisonData;
  }

  downloadXLSX(sheets, `netopt-export-${new Date().getTime()}.xlsx`);
}

// ============================================================
// CONTENT VIEW ROUTER
// ============================================================

function renderContentView() {
  const el = rootEl?.querySelector('#no-content');
  if (!el) return;

  switch (activeView) {
    case 'setup': renderSetup(el); break;
    case 'map': renderMap(el); break;
    case 'results': renderResults(el); break;
    case 'comparison': renderComparison(el); break;
  }
}

// ============================================================
// SETUP VIEW
// ============================================================

function renderSetup(el) {
  switch (activeSection) {
    case 'facilities': renderFacilities(el); break;
    case 'demand': renderDemand(el); break;
    case 'modemix': renderModeMix(el); break;
    case 'service': renderServiceConfig(el); break;
  }
}

function renderFacilities(el) {
  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Facility Network</h3>
        <div style="display:flex;gap:8px;">
          ${facilities.length === 0 && demands.length === 0 ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-load-sample" title="Seed 5 candidate DCs + 10 demand points so you can explore the optimizer without entering data.">Load Sample Network</button>` : ''}
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-add-facility">+ Add Facility</button>
        </div>
      </div>
      ${facilities.length === 0 ? (demands.length > 0 ? `
        <div class="hub-card" style="padding:24px;text-align:center;background:#f0fdf4;border:1px dashed #86efac;margin-bottom:16px;">
          <div style="display:inline-flex;align-items:center;gap:6px;background:#dcfce7;color:#166534;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;margin-bottom:12px;">
            <span>✓</span><span>${demands.length} demand point${demands.length === 1 ? '' : 's'} loaded</span>
          </div>
          <div style="font-size:14px;font-weight:600;color:var(--ies-navy);margin-bottom:6px;">Step 2 of 3 — add candidate facilities</div>
          <div style="font-size:12px;color:var(--ies-gray-600);line-height:1.5;margin-bottom:14px;">Demand is ready. Now seed candidate DC locations by clustering against your demand, or add them one at a time.</div>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
            <button class="hub-btn hub-btn-sm hub-btn-primary" id="no-find-optimal-empty" style="display:inline-flex;align-items:center;gap:6px;">🎯 Find Optimal Locations</button>
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-add-facility-empty">+ Add Facility manually</button>
          </div>
        </div>
      ` : `
        <div class="hub-card" style="padding:24px;text-align:center;background:var(--ies-gray-50);border:1px dashed var(--ies-gray-300);margin-bottom:16px;">
          <div style="font-size:14px;font-weight:600;color:var(--ies-navy);margin-bottom:8px;">No facilities yet</div>
          <div style="font-size:12px;color:var(--ies-gray-500);line-height:1.5;">Add candidate DCs one at a time with <b>+ Add Facility</b>, or click <b>Load Sample Network</b> to seed a 5-DC + 10-demand-point US example you can modify. To load demand from an industry preset first, pick one under <b>ARCHETYPES</b> in the sidebar.</div>
        </div>
      `) : ''}

      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:2px solid var(--ies-gray-200);">
            <th style="text-align:left;padding:8px 6px;font-weight:700;">Active</th>
            <th style="text-align:left;padding:8px 6px;font-weight:700;" title="Lock this facility's state — the optimizer respects locks during scenario sweeps.">Lock</th>
            <th style="text-align:left;padding:8px 6px;font-weight:700;">Name</th>
            <th style="text-align:left;padding:8px 6px;font-weight:700;">City</th>
            <th style="text-align:left;padding:8px 6px;font-weight:700;">State</th>
            <th style="text-align:right;padding:8px 6px;font-weight:700;">Capacity</th>
            <th style="text-align:right;padding:8px 6px;font-weight:700;">Fixed Cost</th>
            <th style="text-align:right;padding:8px 6px;font-weight:700;">$/Unit</th>
            <th style="text-align:center;padding:8px 6px;font-weight:700;"></th>
          </tr>
        </thead>
        <tbody>
          ${facilities.map((f, i) => {
            const lockState = (serviceConfig.lockedOpenIds || []).includes(f.id) ? 'open'
              : (serviceConfig.lockedClosedIds || []).includes(f.id) ? 'closed'
              : 'none';
            return `
            <tr style="border-bottom:1px solid var(--ies-gray-200);${f.isOpen ? '' : 'opacity:0.5;'}">
              <td style="padding:8px 6px;">
                <input type="checkbox" ${f.isOpen ? 'checked' : ''} data-fac-toggle="${i}" ${lockState !== 'none' ? 'disabled' : ''} style="cursor:pointer;" title="${lockState !== 'none' ? 'Locked — clear lock to toggle' : ''}">
              </td>
              <td style="padding:8px 6px;">
                <select data-fac-lock="${f.id}" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;background:${lockState === 'open' ? '#dbeafe' : lockState === 'closed' ? '#fee2e2' : '#fff'};">
                  <option value="none"${lockState === 'none' ? ' selected' : ''}>—</option>
                  <option value="open"${lockState === 'open' ? ' selected' : ''}>🔒 Open</option>
                  <option value="closed"${lockState === 'closed' ? ' selected' : ''}>🔒 Closed</option>
                </select>
              </td>
              <td style="padding:8px 6px;font-weight:600;">${f.name}</td>
              <td style="padding:8px 6px;">${f.city || ''}</td>
              <td style="padding:8px 6px;">${f.state || ''}</td>
              <td style="padding:8px 6px;text-align:right;">${(f.capacity || 0).toLocaleString()}</td>
              <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(f.fixedCost || 0, { compact: true })}</td>
              <td style="padding:8px 6px;text-align:right;">$${(f.variableCost || 0).toFixed(2)}</td>
              <td style="padding:8px 6px;text-align:center;">
                <button class="hub-btn hub-btn-sm hub-btn-secondary" data-fac-delete="${i}" style="padding:4px 8px;">✕</button>
              </td>
            </tr>
          `;}).join('')}
        </tbody>
      </table>

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          <div>
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Open DCs</span>
            <div style="font-size:32px;font-weight:800;">${facilities.filter(f => f.isOpen).length}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Total Capacity</span>
            <div style="font-size:32px;font-weight:800;">${facilities.filter(f => f.isOpen).reduce((s, f) => s + (f.capacity || 0), 0).toLocaleString()}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Annual Fixed Cost</span>
            <div style="font-size:32px;font-weight:800;">${calc.formatCurrency(facilities.filter(f => f.isOpen).reduce((s, f) => s + (f.fixedCost || 0), 0), { compact: true })}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Toggle facility open/closed
  el.querySelectorAll('[data-fac-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (cb).dataset.facToggle);
      facilities[idx].isOpen = /** @type {HTMLInputElement} */ (cb).checked;
      markDirty();  // audit: missing — open/closed toggle didn't invalidate Run.
      renderFacilities(el);
      renderSidebar();
    });
  });

  // Lock facility open/closed — syncs to serviceConfig.lockedOpenIds/lockedClosedIds
  el.querySelectorAll('[data-fac-lock]').forEach(select => {
    select.addEventListener('change', () => {
      const id = /** @type {HTMLElement} */ (select).dataset.facLock;
      const state = /** @type {HTMLSelectElement} */ (select).value;
      serviceConfig.lockedOpenIds = (serviceConfig.lockedOpenIds || []).filter(x => x !== id);
      serviceConfig.lockedClosedIds = (serviceConfig.lockedClosedIds || []).filter(x => x !== id);
      if (state === 'open') {
        serviceConfig.lockedOpenIds.push(id);
        // Locked-open implies isOpen=true
        const f = facilities.find(x => x.id === id);
        if (f) f.isOpen = true;
      } else if (state === 'closed') {
        serviceConfig.lockedClosedIds.push(id);
        const f = facilities.find(x => x.id === id);
        if (f) f.isOpen = false;
      }
      markDirty();  // audit: missing — lock-state change didn't invalidate Run.
      renderFacilities(el);
      renderSidebar();
    });
  });

  // Delete facility
  el.querySelectorAll('[data-fac-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (btn).dataset.facDelete);
      facilities.splice(idx, 1);
      markDirty();
      renderFacilities(el);
      renderSidebar();
    });
  });

  // Add facility
  function _addBlankFacility() {
    const id = 'f' + Date.now();
    facilities.push({ id, name: 'New DC', city: '', state: '', lat: 39.8283, lng: -98.5795, capacity: 200000, fixedCost: 1000000, variableCost: 3.00, isOpen: true });
    markDirty();
    renderFacilities(el);
    renderSidebar();
  }
  el.querySelector('#no-add-facility')?.addEventListener('click', _addBlankFacility);
  // Slice B (2026-04-25): empty-state CTAs when demand is loaded but facilities are empty.
  el.querySelector('#no-add-facility-empty')?.addEventListener('click', _addBlankFacility);
  el.querySelector('#no-find-optimal-empty')?.addEventListener('click', () => {
    findOptimalLocations();
    markDirty();
  });

  // Load sample network — seeds 5 DCs + 10 demand points from the demo
  // constants so users can try the optimizer without entering data.
  el.querySelector('#no-load-sample')?.addEventListener('click', () => {
    facilities = DEMO_FACILITIES.map(f => ({ ...f }));
    demands   = DEMO_DEMANDS.map(x => ({ ...x }));
    markDirty();
    renderFacilities(el);
    renderSidebar();
    if (typeof window !== 'undefined' && window.__iesToast) {
      window.__iesToast(`Loaded sample network — ${facilities.length} DCs + ${demands.length} demand points`, 'success');
    }
  });
}

function renderDemand(el) {
  const totalDemand = demands.reduce((s, d) => s + d.annualDemand, 0);

  el.innerHTML = `
    <div style="max-width:900px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Demand Points</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-add-demand">+ Add Point</button>
        </div>
      </div>

      <div style="max-height:400px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:#fff;z-index:1;">
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">ZIP3</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lat</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lng</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Annual Demand</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Max Days</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Wt (lbs)</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;" title="NMFC freight class for LTL costing — drives the class multiplier (50 dense → 0.65×; 500 light → 2.60×). 100 is baseline.">NMFC</th>
              <th style="text-align:center;padding:8px 6px;font-weight:700;"></th>
            </tr>
          </thead>
          <tbody>
            ${demands.map((d, i) => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${d.zip3 || '—'}</td>
                <td style="padding:6px;text-align:right;">${d.lat.toFixed(2)}</td>
                <td style="padding:6px;text-align:right;">${d.lng.toFixed(2)}</td>
                <td style="padding:6px;text-align:right;">${d.annualDemand.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${d.maxDays || 3}</td>
                <td style="padding:6px;text-align:right;">${d.avgWeight || 25}</td>
                <td style="padding:6px;text-align:right;">
                  <select data-dem-nmfc="${i}" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;background:#fff;">
                    ${calc.NMFC_CLASS_CODES.map(c => `<option value="${c}"${(d.nmfcClass || 100) === c ? ' selected' : ''}>${c}</option>`).join('')}
                  </select>
                </td>
                <td style="padding:6px;text-align:center;">
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-dem-delete="${i}" style="padding:4px 8px;">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          <div>
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Demand Points</span>
            <div style="font-size:32px;font-weight:800;">${demands.length}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Total Annual Demand</span>
            <div style="font-size:32px;font-weight:800;">${totalDemand.toLocaleString()}</div>
          </div>
          <div style="border-left:1px solid rgba(255,255,255,.15);padding-left:32px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">Avg per Point</span>
            <div style="font-size:32px;font-weight:800;">${demands.length > 0 ? Math.round(totalDemand / demands.length).toLocaleString() : '0'}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelectorAll('[data-dem-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      demands.splice(parseInt(/** @type {HTMLElement} */ (btn).dataset.demDelete), 1);
      markDirty();
      renderDemand(el);
      renderSidebar();
    });
  });

  // Per-demand NMFC class — feeds into ltlCost via blendedLaneCost
  el.querySelectorAll('[data-dem-nmfc]').forEach(select => {
    select.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (select).dataset.demNmfc);
      const v = parseInt(/** @type {HTMLSelectElement} */ (select).value);
      if (demands[idx] && Number.isFinite(v)) { demands[idx].nmfcClass = v; markDirty(); }
    });
  });

  el.querySelector('#no-add-demand')?.addEventListener('click', () => {
    demands.push({ id: 'd' + Date.now(), zip3: '', lat: 39.83, lng: -98.58, annualDemand: 10000, maxDays: 3, avgWeight: 25, nmfcClass: 100 });
    markDirty();
    renderDemand(el);
    renderSidebar();
  });
}

function renderModeMix(el) {
  el.innerHTML = `
    <div style="max-width:500px;">
      <h3 class="text-section" style="margin-bottom:16px;">Transportation Mode Mix</h3>

      <div class="hub-card" style="margin-bottom:20px;">
        <div style="display:flex;flex-direction:column;gap:16px;">
          ${renderSlider('Truckload (TL)', 'tlPct', modeMix.tlPct)}
          ${renderSlider('Less-Than-Truckload (LTL)', 'ltlPct', modeMix.ltlPct)}
          ${renderSlider('Parcel', 'parcelPct', modeMix.parcelPct)}
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--ies-gray-200);font-size:13px;font-weight:600;text-align:right;">
          Total: ${modeMix.tlPct + modeMix.ltlPct + modeMix.parcelPct}%
          ${(modeMix.tlPct + modeMix.ltlPct + modeMix.parcelPct) !== 100 ? '<span style="color:var(--ies-orange);margin-left:8px;">Must equal 100%</span>' : '<span style="color:#22c55e;margin-left:8px;">✓</span>'}
        </div>
      </div>

      <h3 class="text-section" style="margin-bottom:16px;">Rate Card</h3>
      <div class="hub-card">
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${renderInput('TL Rate per Mile', 'tlRatePerMile', rateCard.tlRatePerMile, '$')}
          ${renderInput('LTL Base Rate ($/CWT)', 'ltlBaseRate', rateCard.ltlBaseRate, '$')}
          ${renderInput('Fuel Surcharge', 'fuelSurcharge', (rateCard.fuelSurcharge * 100).toFixed(0), '%')}
        </div>
      </div>

      <h3 class="text-section" style="margin:20px 0 16px;">LTL Weight-Break Rate Deck
        <span style="font-size:11px;font-weight:normal;color:var(--ies-gray-500);margin-left:8px;">$/CWT by shipment weight tier</span>
      </h3>
      <div class="hub-card">
        <table class="cm-grid-table" style="width:100%;font-size:13px;">
          <thead>
            <tr>
              <th style="text-align:left;">Weight Tier (lbs)</th>
              <th style="text-align:right;width:110px;">$/CWT</th>
              <th style="text-align:left;color:var(--ies-gray-500);">Notes</th>
            </tr>
          </thead>
          <tbody>
            ${(rateCard.ltlWeightBreaks || calc.DEFAULT_RATES.ltlWeightBreaks).map((wb, i) => {
              const prev = i === 0 ? 0 : (rateCard.ltlWeightBreaks || calc.DEFAULT_RATES.ltlWeightBreaks)[i - 1];
              const rate = (rateCard.ltlBreakRates || calc.DEFAULT_RATES.ltlBreakRates)[i] ?? 0;
              const label = i === 0 ? `< ${wb.toLocaleString()}` : `${prev.toLocaleString()}–${wb.toLocaleString()}`;
              return `
                <tr>
                  <td style="padding:6px 8px;"><strong>${label}</strong></td>
                  <td style="text-align:right;padding:6px 8px;">
                    <span style="color:var(--ies-gray-400);">$</span>
                    <input type="number" step="0.25" min="0" value="${rate}" data-ltl-break-idx="${i}" style="width:75px;text-align:right;" />
                  </td>
                  <td style="color:var(--ies-gray-500);font-size:11px;">${['full-truck-like, lowest CWT','class-avg base','class-avg mid','LTL typical','heavy LTL / partial TL','TL crossover tier'][i] || ''}</td>
                </tr>
              `;
            }).join('')}
            <tr>
              <td style="padding:6px 8px;">≥ ${(rateCard.ltlWeightBreaks || calc.DEFAULT_RATES.ltlWeightBreaks).slice(-1)[0].toLocaleString()}</td>
              <td style="text-align:right;padding:6px 8px;color:var(--ies-gray-400);">— uses top tier rate —</td>
              <td style="color:var(--ies-gray-400);"></td>
            </tr>
          </tbody>
        </table>
        <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);">
          Rates cascade — engine uses the rate at or below the shipment weight. Changes persist with the scenario.
        </div>
      </div>
    </div>
  `;

  // Bind sliders
  el.querySelectorAll('input[type="range"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.key;
      const val = parseInt(/** @type {HTMLInputElement} */ (e.target).value);
      modeMix[key] = val;
      markDirty();  // 2026-04-21 audit: was missing — Run button stayed
                    // "✓ Results current" after mix slider moved.
      renderModeMix(el);
    });
  });

  // Bind rate inputs
  el.querySelectorAll('input[data-rate]').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.rate;
      let val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (key === 'fuelSurcharge') val = val / 100;
      rateCard[key] = val;
      markDirty();  // audit: missing — rate-card edits didn't invalidate Run.
    });
  });

  // Bind LTL weight-break rate deck
  el.querySelectorAll('input[data-ltl-break-idx]').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset.ltlBreakIdx);
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!Array.isArray(rateCard.ltlBreakRates)) {
        rateCard.ltlBreakRates = [...calc.DEFAULT_RATES.ltlBreakRates];
        rateCard.ltlWeightBreaks = [...calc.DEFAULT_RATES.ltlWeightBreaks];
      }
      rateCard.ltlBreakRates[idx] = val;
      markDirty();  // audit: missing — LTL break-rate edits didn't invalidate Run.
    });
  });
}

function renderSlider(label, key, value) {
  return `
    <div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:600;">${label}</span>
        <span style="font-size:13px;font-weight:700;">${value}%</span>
      </div>
      <input type="range" min="0" max="100" value="${value}" data-key="${key}"
             style="width:100%;accent-color:var(--ies-blue);">
    </div>
  `;
}

function renderInput(label, key, value, prefix) {
  return `
    <div style="display:flex;align-items:center;gap:12px;">
      <label style="font-size:13px;font-weight:600;flex:1;">${label}</label>
      <div style="display:flex;align-items:center;gap:4px;">
        ${prefix === '$' ? '<span style="font-size:13px;font-weight:600;">$</span>' : ''}
        <input type="number" value="${value}" data-rate="${key}" step="0.01"
               style="width:100px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
        ${prefix === '%' ? '<span style="font-size:13px;font-weight:600;">%</span>' : ''}
      </div>
    </div>
  `;
}

function renderServiceConfig(el) {
  el.innerHTML = `
    <div style="max-width:500px;">
      <h3 class="text-section" style="margin-bottom:16px;">Service Requirements</h3>
      <div class="hub-card">
        <div style="display:flex;flex-direction:column;gap:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Target Service Level</label>
            <div style="display:flex;align-items:center;gap:4px;">
              <input type="number" value="${serviceConfig.targetServicePct}" data-svc="targetServicePct" min="0" max="100"
                     style="width:80px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="font-size:13px;font-weight:600;">%</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Global Max Transit Days</label>
            <input type="number" value="${serviceConfig.globalMaxDays}" data-svc="globalMaxDays" min="1" max="14"
                   style="width:80px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Average Truck Speed</label>
            <div style="display:flex;align-items:center;gap:4px;">
              <input type="number" value="${serviceConfig.truckSpeedMph}" data-svc="truckSpeedMph" min="20" max="80"
                     style="width:80px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="font-size:13px;font-weight:600;">mph</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <label style="font-size:13px;font-weight:600;">Hard SLA Constraint</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" ${serviceConfig.hardConstraint ? 'checked' : ''} data-svc="hardConstraint">
              <span style="font-size:11px;color:var(--ies-gray-400);">${serviceConfig.hardConstraint ? 'Scenarios below target will fail' : 'Soft constraint (warn only)'}</span>
            </label>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--ies-gray-200);padding-top:14px;">
            <label style="font-size:13px;font-weight:600;" title="Demands beyond this distance from any facility are flagged. 0 disables the constraint.">Max Lane Distance</label>
            <div style="display:flex;align-items:center;gap:4px;">
              <input type="number" value="${serviceConfig.maxDistanceMiles ?? 0}" data-svc="maxDistanceMiles" min="0" step="50"
                     style="width:80px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="font-size:13px;font-weight:600;">mi</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--ies-gray-500);">
            <span>Locked open: <strong>${(serviceConfig.lockedOpenIds || []).length}</strong></span>
            <span>Locked closed: <strong>${(serviceConfig.lockedClosedIds || []).length}</strong></span>
            <span style="opacity:0.7;">(set per row in Facilities tab)</span>
          </div>
        </div>
      </div>

      <div class="hub-card" style="margin-top:16px;background:#f0fdf4;border-color:#22c55e;">
        <div style="font-size:13px;font-weight:600;color:#15803d;margin-bottom:8px;">Service Level Guide</div>
        <div style="font-size:13px;color:#166534;line-height:1.6;">
          <strong>95%+</strong> — Premium service, typical for healthcare/pharma and DTC e-commerce.<br>
          <strong>90-95%</strong> — Standard for CPG big-box and industrial distribution.<br>
          <strong>85-90%</strong> — Acceptable for bulk/commodity, cost-optimized networks.<br>
          <strong>&lt;85%</strong> — Risk zone. Consider adding facilities or relaxing transit requirements.
        </div>
      </div>
    </div>
  `;

  el.querySelectorAll('input[data-svc]').forEach(input => {
    const handler = (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.svc;
      if (key === 'hardConstraint') {
        serviceConfig[key] = /** @type {HTMLInputElement} */ (e.target).checked;
      } else if (key === 'maxDistanceMiles') {
        const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
        // 0 or blank disables the constraint (engine checks for null)
        serviceConfig.maxDistanceMiles = Number.isFinite(v) && v > 0 ? v : null;
      } else {
        serviceConfig[key] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
      markDirty();  // 2026-04-21 audit: missing — service-config edits didn't invalidate Run.
    };
    input.addEventListener('change', handler);
  });
}

// ============================================================
// MAP VIEW
// ============================================================

function renderMap(el) {
  // Run scenario first to get assignments for flow lines
  if (!activeScenario) {
    const result = calc.evaluateScenario('Preview', facilities, demands, modeMix, rateCard, serviceConfig);
    activeScenario = result;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <h3 class="text-section" style="margin:0;">Network Map</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">
          ${facilities.filter(f => f.isOpen).length} facilities • ${demands.length} demand points • ${activeScenario?.assignments?.length || 0} lanes
        </span>
        <div style="margin-left:auto;display:flex;gap:6px;">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-map-toggle="heat" checked style="margin:0;"/> Heatmap
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-map-toggle="zones" checked style="margin:0;"/> Service zones
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-map-toggle="flows" checked style="margin:0;"/> Flow lines
          </label>
        </div>
      </div>
      <div id="no-map-container" style="flex:1;min-height:500px;border-radius:10px;border:1px solid var(--ies-gray-200);overflow:hidden;"></div>
      <div style="display:flex;gap:20px;margin-top:12px;font-size:11px;color:var(--ies-gray-400);flex-wrap:wrap;">
        <span><span style="display:inline-block;width:12px;height:12px;background:var(--ies-blue);border-radius:50%;vertical-align:middle;"></span> Facility (open)</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:var(--ies-gray-300);border-radius:50%;vertical-align:middle;"></span> Facility (closed)</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:var(--ies-orange);border-radius:50%;vertical-align:middle;"></span> Demand point</span>
        <span><span style="display:inline-block;width:20px;height:5px;background:var(--ies-blue);vertical-align:middle;"></span> Heavy lane</span>
        <span><span style="display:inline-block;width:20px;height:1px;background:var(--ies-blue);vertical-align:middle;"></span> Light lane</span>
        <span><span style="display:inline-block;width:20px;height:2px;background:#ef4444;vertical-align:middle;border-style:dashed;border-width:1px 0;"></span> SLA missed</span>
      </div>
    </div>
  `;

  // Initialize Leaflet map — use setTimeout(100) rather than rAF so the
  // flex layout settles before L.map(container) measures height. rAF fires
  // before the browser has painted the new panel sizes, so L.map() sees
  // height=0 and the tile layer never requests tiles.
  setTimeout(() => { if (rootEl?.querySelector('#no-map-container')) initMap(); }, 100);
}

function initMap() {
  const container = rootEl?.querySelector('#no-map-container');
  if (!container) return;

  // Clean up previous map
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  // Check if Leaflet is loaded
  if (typeof L === 'undefined') {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--ies-gray-400);">
        <div style="text-align:center;">
          <div style="font-size:20px;margin-bottom:8px;">Map requires Leaflet.js</div>
          <div>Add Leaflet CSS + JS to index.html to enable the network map view.</div>
        </div>
      </div>
    `;
    return;
  }

  mapInstance = L.map(container).setView([39.8283, -98.5795], 4);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> · OpenStreetMap'
  }).addTo(mapInstance);

  // Layer groups so toggles can show/hide each class of overlay
  const zoneLayer = L.layerGroup().addTo(mapInstance);
  const flowLayer = L.layerGroup().addTo(mapInstance);
  let heatLayer = null;
  if (typeof L.heatLayer === 'function') {
    const heatPoints = demands.map(d => [d.lat, d.lng, Math.min(1, (d.annualDemand || 0) / 200000)]);
    heatLayer = L.heatLayer(heatPoints, {
      radius: 28, blur: 22, minOpacity: 0.35, maxZoom: 10,
      gradient: { 0.2: '#2563eb', 0.4: '#7c3aed', 0.6: '#ea580c', 0.8: '#dc2626', 1.0: '#b91c1c' },
    }).addTo(mapInstance);
  }
  // Wire up layer toggles.
  rootEl?.querySelectorAll('[data-map-toggle]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.currentTarget);
      const key = t.dataset.mapToggle;
      const on = t.checked;
      if (key === 'zones') on ? mapInstance.addLayer(zoneLayer) : mapInstance.removeLayer(zoneLayer);
      else if (key === 'flows') on ? mapInstance.addLayer(flowLayer) : mapInstance.removeLayer(flowLayer);
      else if (key === 'heat' && heatLayer) on ? mapInstance.addLayer(heatLayer) : mapInstance.removeLayer(heatLayer);
    });
  });

  // Facility markers
  const facColors = ['var(--ies-blue)', '#22c55e', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];
  const openFacs = facilities.filter(f => f.isOpen);

  facilities.forEach((f, i) => {
    const color = f.isOpen ? facColors[i % facColors.length] : '#9ca3af';
    const marker = L.circleMarker([f.lat, f.lng], {
      radius: 10, fillColor: color, color: '#fff', weight: 2, fillOpacity: f.isOpen ? 0.9 : 0.4,
    }).addTo(mapInstance);
    marker.bindPopup(`<strong>${f.name}</strong><br>${f.city}, ${f.state}<br>Capacity: ${(f.capacity || 0).toLocaleString()}<br>${f.isOpen ? 'OPEN' : 'CLOSED'}`);

    // D2: service zone radius computed from serviceConfig.
    //   miles = truckSpeedMph × 10 driving-hours/day × globalMaxDays
    // For SLA defaults (50 mph × 3 days) → 1500 miles, which is the
    // honest 2-day-with-driver-rest band most carriers commit to.
    if (f.isOpen) {
      const speed = serviceConfig.truckSpeedMph || 50;
      const days  = serviceConfig.globalMaxDays || 2;
      const radiusMiles  = speed * 10 * days;
      const radiusMeters = radiusMiles * 1609.34;
      L.circle([f.lat, f.lng], {
        radius: radiusMeters,
        color: color,
        weight: 1,
        opacity: 0.25,
        fillColor: color,
        fillOpacity: 0.07,
      }).addTo(zoneLayer)
        .bindTooltip(`${days}-day service radius (~${radiusMiles.toLocaleString()} mi)`,
                     { sticky: true, opacity: 0.9 });
    }
  });

  // Demand markers
  demands.forEach(d => {
    const marker = L.circleMarker([d.lat, d.lng], {
      radius: Math.max(3, Math.min(8, d.annualDemand / 10000)),
      fillColor: 'var(--ies-orange)', color: 'var(--ies-orange)', weight: 1, fillOpacity: 0.6,
    }).addTo(mapInstance);
    marker.bindPopup(`<strong>ZIP3: ${d.zip3 || '—'}</strong><br>Demand: ${d.annualDemand.toLocaleString()}/yr<br>Max transit: ${d.maxDays || 3} days`);
  });

  // Flow lines from assignments — D1 width scales with lane volume.
  if (activeScenario?.assignments) {
    // Pre-compute the max lane demand so widths are normalised across the
    // current scenario instead of using an absolute scale that can collapse
    // (e.g. a 1M-unit national network) or saturate (e.g. a 10k regional one).
    const laneDemands = activeScenario.assignments.map(a => {
      const dem = demands.find(d => d.id === a.demandId);
      return dem?.annualDemand || 0;
    });
    const maxLane = Math.max(1, ...laneDemands);
    activeScenario.assignments.forEach(a => {
      const fac = facilities.find(f => f.id === a.facilityId);
      const dem = demands.find(d => d.id === a.demandId);
      if (!fac || !dem) return;

      // Color by mode (TL = blue, LTL = orange, Parcel = purple); fall back to SLA color
      let modeColor = a.meetsSlA ? '#22c55e' : '#ef4444';
      if (a.tlCost > 0 && a.tlCost <= a.ltlCost && a.tlCost <= a.parcelCost) modeColor = 'var(--ies-blue)';
      else if (a.ltlCost > 0 && a.ltlCost <= a.tlCost && a.ltlCost <= a.parcelCost) modeColor = '#ea580c';
      else if (a.parcelCost > 0) modeColor = '#7c3aed';

      // D1: weight ∈ [1, 7] px proportional to lane share of max demand.
      // Sqrt curve keeps small lanes visible without dwarfing the big ones.
      const norm = Math.sqrt((dem.annualDemand || 0) / maxLane);
      const weight = 1 + norm * 6;

      const line = L.polyline([[fac.lat, fac.lng], [dem.lat, dem.lng]], {
        color: modeColor, weight, opacity: 0.55, dashArray: a.meetsSlA ? null : '5,5',
      }).addTo(flowLayer);
      line.bindPopup(`${fac.name} → ZIP ${dem.zip3}<br>Annual demand: ${(dem.annualDemand || 0).toLocaleString()}<br>Distance: ${calc.formatMiles(a.distanceMiles)}<br>Transit: ${a.transitDays} day(s)<br>Cost: ${calc.formatCurrency(a.blendedCost)}`);
    });
  }

  // Fit bounds
  const allPoints = [...facilities.map(f => [f.lat, f.lng]), ...demands.map(d => [d.lat, d.lng])];
  if (allPoints.length > 0) {
    mapInstance.fitBounds(allPoints, { padding: [30, 30] });
  }
}

// ============================================================
// RESULTS VIEW
// ============================================================

function renderResults(el) {
  if (!activeScenario) {
    // Slice A: distinguish between "never run" and "run was blocked by missing inputs".
    if (runBlockReason === 'no-demand') {
      el.innerHTML = `
        <div class="hub-card" style="padding:24px;background:#fef2f2;border:1px solid #fecaca;">
          <div style="display:inline-flex;align-items:center;gap:6px;background:#fee2e2;color:#991b1b;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;margin-bottom:12px;">
            <span>⚠</span><span>Run blocked</span>
          </div>
          <div style="font-size:14px;font-weight:700;color:var(--ies-navy);margin-bottom:6px;">No demand to run against</div>
          <div style="font-size:13px;color:var(--ies-gray-600);line-height:1.5;margin-bottom:14px;">The optimizer needs demand points before it can produce cost or service-level results. Either pick an industry preset under <b>ARCHETYPES</b> in the sidebar, or open the <b>Demand Points</b> section and add them manually.</div>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="no-results-go-demand">Go to Demand Points</button>
        </div>`;
      el.querySelector('#no-results-go-demand')?.addEventListener('click', () => {
        activeSection = 'demand';
        activeView = 'setup';
        rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === activeView);
        });
        renderSidebar();
        renderContentView();
      });
      return;
    }
    if (runBlockReason === 'no-open-facilities') {
      const total = facilities.length;
      const hint = total === 0
        ? 'You have no candidate facilities yet. Click <b>Find Optimal Locations</b> in the sidebar to seed candidates from a k-means cluster of your demand, or add them manually.'
        : `You have ${total} facilit${total === 1 ? 'y' : 'ies'} on the list but none are <b>Active</b>. Tick the Active checkbox on at least one row in <b>Setup → Facilities</b>, or click <b>Find Optimal Locations</b> to add more candidates.`;
      el.innerHTML = `
        <div class="hub-card" style="padding:24px;background:#fffbeb;border:1px solid #fde68a;">
          <div style="display:inline-flex;align-items:center;gap:6px;background:#fef3c7;color:#92400e;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;margin-bottom:12px;">
            <span>⚠</span><span>Run blocked</span>
          </div>
          <div style="font-size:14px;font-weight:700;color:var(--ies-navy);margin-bottom:6px;">No active facilities to evaluate</div>
          <div style="font-size:13px;color:var(--ies-gray-600);line-height:1.5;margin-bottom:14px;">${hint}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="hub-btn hub-btn-sm hub-btn-primary" id="no-results-find-optimal" style="display:inline-flex;align-items:center;gap:6px;">🎯 Find Optimal Locations</button>
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-results-go-facilities">Open Facilities tab</button>
          </div>
        </div>`;
      el.querySelector('#no-results-find-optimal')?.addEventListener('click', () => {
        findOptimalLocations();
        markDirty();
      });
      el.querySelector('#no-results-go-facilities')?.addEventListener('click', () => {
        activeSection = 'facilities';
        activeView = 'setup';
        rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === activeView);
        });
        renderSidebar();
        renderContentView();
      });
      return;
    }
    if (runBlockReason === 'invalid-inputs' && runBlockDetail) {
      const errs = (runBlockDetail.errors || []).map(e => `<li>${e}</li>`).join('');
      const warns = (runBlockDetail.warnings || []).map(w => `<li>${w}</li>`).join('');
      el.innerHTML = `
        <div class="hub-card" style="padding:24px;background:#fef2f2;border:1px solid #fecaca;">
          <div style="display:inline-flex;align-items:center;gap:6px;background:#fee2e2;color:#991b1b;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;margin-bottom:12px;">
            <span>⚠</span><span>Run blocked — invalid inputs</span>
          </div>
          <div style="font-size:14px;font-weight:700;color:var(--ies-navy);margin-bottom:6px;">Some rows are missing required values</div>
          <div style="font-size:13px;color:var(--ies-gray-600);line-height:1.5;margin-bottom:10px;">A facility with a blank lat/lng (or a demand without coordinates) would corrupt the optimizer math and silently produce <code>NaN</code> distance and \$0 cost results. Fix the rows below and re-run.</div>
          ${errs ? `<div style="font-size:13px;color:#991b1b;margin-bottom:6px;"><b>Errors:</b><ul style="margin:6px 0 12px 18px;">${errs}</ul></div>` : ''}
          ${warns ? `<div style="font-size:13px;color:#92400e;margin-bottom:6px;"><b>Warnings:</b><ul style="margin:6px 0 12px 18px;">${warns}</ul></div>` : ''}
          <div style="display:flex;gap:8px;">
            <button class="hub-btn hub-btn-sm hub-btn-primary" id="no-results-go-fix-fac">Open Facilities</button>
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-results-go-fix-dem">Open Demand</button>
          </div>
        </div>`;
      el.querySelector('#no-results-go-fix-fac')?.addEventListener('click', () => {
        activeSection = 'facilities'; activeView = 'setup';
        rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === activeView));
        renderSidebar(); renderContentView();
      });
      el.querySelector('#no-results-go-fix-dem')?.addEventListener('click', () => {
        activeSection = 'demand'; activeView = 'setup';
        rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === activeView));
        renderSidebar(); renderContentView();
      });
      return;
    }
    el.innerHTML = `<div class="hub-card"><p class="text-body text-muted">Run a scenario first to see results here.</p></div>`;
    return;
  }

  const s = activeScenario;
  const slaColor = s.serviceLevel >= 95 ? '#22c55e' : s.serviceLevel >= 90 ? '#f59e0b' : '#ef4444';

  el.innerHTML = `
    <div style="max-width:1000px;">
      <h3 class="text-section" style="margin-bottom:16px;">${s.name}</h3>

      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Total Cost', calc.formatCurrency(s.totalCost, { compact: true }))}
          ${kpi('Cost/Unit', calc.formatCurrency(s.avgCostPerUnit))}
          ${kpi('Avg Distance', calc.formatMiles(s.avgDistance))}
          ${kpi('Service Level', calc.formatPct(s.serviceLevel), slaColor, '% of lanes whose blended transit time is within the SLA window (≤ each demand point\'s maxDays). 95+ green, 90-94 amber, <90 red.')}
          ${kpi('Coverage', `${s.slaMet}/${s.slaTotal} lanes`, undefined, 'Lanes meeting SLA window / total lanes evaluated.')}
          ${kpi('Total Demand', s.totalDemand.toLocaleString())}
        </div>
      </div>

      <!-- Cost Breakdown -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px;">
        ${costCard('Facility Costs', s.costBreakdown.facility, s.totalCost)}
        ${costCard('Transportation', s.costBreakdown.transport, s.totalCost)}
        ${costCard('Handling', s.costBreakdown.handling, s.totalCost, 'Handling = Σ (annualDemand × facility.variableCost) across all assigned demand. Variable cost is per-unit handling, set on each facility row (defaults $2.80–$4.00/unit on the demo network).')}
      </div>

      <!-- Primary Actions -->
      <div style="display:flex;gap:8px;margin-bottom:20px;">
        <button class="hub-btn hub-btn-primary hub-btn-sm" id="no-push-fleet" style="display:flex;align-items:center;gap:6px;">
          📊 Push to Fleet
        </button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" id="no-push-cm" title="Seed Cost Model with this scenario's annual demand + total transport cost so you can iterate downstream P&amp;L from a sized network." style="display:flex;align-items:center;gap:6px;">
          💵 Push to Cost Model
        </button>
      </div>

      <!-- Assignment Table -->
      <div class="hub-card" style="padding:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <span style="font-size:14px;font-weight:700;">Lane Assignments</span>
          <span style="font-size:11px;color:var(--ies-gray-400);">${s.assignments.length} lanes</span>
        </div>
        <div style="max-height:300px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead style="position:sticky;top:0;background:#fff;">
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:left;padding:6px;">Facility</th>
                <th style="text-align:left;padding:6px;">Demand</th>
                <th style="text-align:right;padding:6px;">Distance</th>
                <th style="text-align:right;padding:6px;">Transit</th>
                <th style="text-align:right;padding:6px;">TL Cost</th>
                <th style="text-align:right;padding:6px;">LTL Cost</th>
                <th style="text-align:right;padding:6px;">Parcel</th>
                <th style="text-align:right;padding:6px;">Blended</th>
                <th style="text-align:center;padding:6px;">SLA</th>
              </tr>
            </thead>
            <tbody>
              ${s.assignments.map(a => {
                const fac = facilities.find(f => f.id === a.facilityId);
                const dem = demands.find(d => d.id === a.demandId);
                return `
                  <tr style="border-bottom:1px solid var(--ies-gray-200);">
                    <td style="padding:6px;font-weight:600;">${fac?.name || a.facilityId}</td>
                    <td style="padding:6px;">ZIP ${dem?.zip3 || a.demandId}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatMiles(a.distanceMiles)}</td>
                    <td style="padding:6px;text-align:right;">${a.transitDays}d</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.tlCost)}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.ltlCost)}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.parcelCost)}</td>
                    <td style="padding:6px;text-align:right;font-weight:600;">${calc.formatCurrency(a.blendedCost)}</td>
                    <td style="padding:6px;text-align:center;">
                      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${a.meetsSlA ? '#22c55e' : '#ef4444'};"></span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Bind Push to Fleet button
  el.querySelector('#no-push-fleet')?.addEventListener('click', () => {
    if (!activeScenario) return;
    pushToFleet(activeScenario);
  });
  // Bind Push to Cost Model — seeds CM with total annual demand + transport cost
  el.querySelector('#no-push-cm')?.addEventListener('click', () => {
    if (!activeScenario) return;
    pushToCostModel(activeScenario);
  });
}

function pushToFleet(scenario) {
  if (!scenario || !scenario.assignments) return;

  // Build lanes array from assignments
  const lanes = scenario.assignments.map(a => {
    const fac = facilities.find(f => f.id === a.facilityId);
    const dem = demands.find(d => d.id === a.demandId);
    if (!fac || !dem) return null;

    return {
      origin: fac,
      destination: dem,
      weeklyShipments: Math.ceil(dem.annualDemand / 52),
      avgWeightLbs: dem.avgWeight || 25,
      avgCubeFt3: (dem.avgWeight || 25) / 10, // Rough estimate: 1 cu ft per 10 lbs
      distanceMiles: a.distanceMiles,
    };
  }).filter(Boolean);

  // Emit event for Fleet Modeler to listen + stash for the nav case.
  const payload = { lanes, sourceScenario: scenario.name, at: Date.now() };
  try { sessionStorage.setItem('netopt_pending_push', JSON.stringify(payload)); } catch {}
  bus.emit('netopt:push-to-fleet', payload);
  showNoToast(`Pushed ${lanes.length} lanes to Fleet Modeler`, 'success');
  // Take the user to Fleet so the handoff is visible.
  window.location.hash = '#designtools/fleet-modeler';
}

/**
 * Push the network scenario downstream into the Cost Model.
 * Sends total annual demand + transport cost so CM can seed Volumes
 * with a primary "Outbound Orders" line and stash transport as a
 * pre-known cost reference for the user to validate against CM's
 * own labor/handling math.
 *
 * Mirrors the WSC→CM and MOST→CM patterns: bus.emit + sessionStorage,
 * then navigate. CM consumes whichever arrives first.
 */
function pushToCostModel(scenario) {
  if (!scenario) return;
  const totalDemand = demands.reduce((s, d) => s + (d.annualDemand || 0), 0);
  const totalTransport = scenario.totalCost || (scenario.costBreakdown?.transport || 0);
  const openFacs = facilities.filter(f => f.isOpen).length;
  const payload = {
    sourceScenario: scenario.name || 'NetOpt scenario',
    totalAnnualDemand: totalDemand,
    transportCost: scenario.costBreakdown?.transport || 0,
    facilityCost:  scenario.costBreakdown?.facility  || 0,
    handlingCost:  scenario.costBreakdown?.handling  || 0,
    totalCost:     scenario.totalCost || totalTransport,
    openFacilities: openFacs,
    at: Date.now(),
  };
  try { sessionStorage.setItem('netopt_pending_cm_push', JSON.stringify(payload)); } catch {}
  bus.emit('netopt:push-to-cm', payload);
  showNoToast(`Pushed ${totalDemand.toLocaleString()} annual units + transport cost to Cost Model`, 'success');
  window.location.hash = '#designtools/cost-model';
}

function kpi(label, value, color, tooltip) {
  return `
    <div ${tooltip ? `title="${tooltip.replace(/"/g, '&quot;')}"` : ''} style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;${tooltip ? 'cursor:help;' : ''}">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}${tooltip ? ' <span style="opacity:0.5;">ⓘ</span>' : ''}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}

function costCard(label, amount, total, tooltip) {
  const pct = total > 0 ? (amount / total) * 100 : 0;
  return `
    <div class="hub-card" ${tooltip ? `title="${tooltip.replace(/"/g, '&quot;')}"` : ''} style="padding:16px;${tooltip ? 'cursor:help;' : ''}">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);margin-bottom:8px;">${label}${tooltip ? ' <span style="opacity:0.5;">ⓘ</span>' : ''}</div>
      <div style="font-size:20px;font-weight:800;margin-bottom:8px;">${calc.formatCurrency(amount, { compact: true })}</div>
      <div style="height:6px;border-radius:3px;background:var(--ies-gray-200);overflow:hidden;">
        <div style="height:100%;width:${Math.min(100, pct)}%;background:var(--ies-blue);border-radius:3px;"></div>
      </div>
      <div style="font-size:11px;color:var(--ies-gray-400);margin-top:4px;">${pct.toFixed(1)}% of total</div>
    </div>
  `;
}

// ============================================================
// COMPARISON VIEW
// ============================================================

function renderComparison(el) {
  // Show multi-DC comparison if available, otherwise show scenario comparison
  if (comparisonResults && comparisonResults.length > 0) {
    renderMultiDCComparison(el);
  } else if (scenarios.length === 0) {
    el.innerHTML = `
      <div class="hub-card">
        <p class="text-body text-muted">No comparison run yet. Click <b>Compare DCs</b> in the sidebar to evaluate 1-N DC configurations and surface the cost-vs-k inflection.</p>
      </div>
    `;
    return;
  } else {
    renderScenarioComparison(el);
  }
}

function renderMultiDCComparison(el) {
  const rec = calc.recommendOptimalDCs(comparisonResults);

  el.innerHTML = `
    <div style="max-width:1200px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">DC Network Comparison (1-5 facilities)</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${comparisonResults.length} scenario(s)</span>
      </div>

      <!-- Recommendation Panel -->
      <div class="hub-card" style="margin-bottom:20px;background:linear-gradient(135deg,#f0fdf4,#f0f9ff);border:1px solid #22c55e;padding:16px 20px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <span style="font-size:20px;">✓</span>
          <span style="font-size:14px;font-weight:700;color:#059669;">RECOMMENDED</span>
        </div>
        <div style="font-size:13px;color:var(--ies-gray-700);line-height:1.6;margin-bottom:12px;">
          <strong>${rec.recommendedIdx + 1} Distribution Centers:</strong> ${rec.recommendation}
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;">
          <div style="background:#fff;padding:12px 16px;border-radius:6px;border:1px solid #22c55e;">
            <div style="font-size:11px;color:var(--ies-gray-500);font-weight:600;text-transform:uppercase;">Annual Savings</div>
            <div style="font-size:18px;font-weight:800;color:#059669;">${calc.formatCurrency(rec.savings, { compact: true })}</div>
            <div style="font-size:10px;color:var(--ies-gray-500);">${calc.formatPct(rec.savingsPct)} vs 1 DC</div>
          </div>
        </div>
      </div>

      <!-- Comparison Table -->
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:800px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);background:#f9fafb;">
              <th style="text-align:left;padding:10px 8px;font-weight:700;">DCs</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Avg Distance</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Annual Freight</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Transit Days</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Service Level</th>
              <th style="text-align:right;padding:10px 8px;font-weight:700;">Savings vs 1 DC</th>
              <th style="text-align:center;padding:10px 8px;font-weight:700;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${comparisonResults.map((s, i) => {
              const baseline = comparisonResults[0].totalCost;
              const savings = baseline - s.totalCost;
              const savingsPct = baseline > 0 ? (savings / baseline) * 100 : 0;
              const isRecommended = i === rec.recommendedIdx;

              return `
                <tr style="border-bottom:1px solid var(--ies-gray-200);background:${isRecommended ? '#f0fdf4' : 'transparent'};">
                  <td style="padding:10px 8px;font-weight:700;color:var(--ies-navy);">${i + 1}</td>
                  <td style="padding:10px 8px;text-align:right;">${calc.formatMiles(s.avgDistance)}</td>
                  <td style="padding:10px 8px;text-align:right;">${calc.formatCurrency(s.costBreakdown.transport, { compact: true })}</td>
                  <td style="padding:10px 8px;text-align:right;">${s.assignments.length > 0 ? (s.assignments.reduce((sum, a) => sum + a.transitDays, 0) / s.assignments.length).toFixed(1) : '—'} days</td>
                  <td style="padding:10px 8px;text-align:right;font-weight:600;color:${s.serviceLevel >= 95 ? '#22c55e' : s.serviceLevel >= 90 ? '#f59e0b' : '#ef4444'};">${calc.formatPct(s.serviceLevel)}</td>
                  <td style="padding:10px 8px;text-align:right;font-weight:700;${savings < 0 ? 'color:#ef4444;' : 'color:#22c55e;'}">${savings >= 0 ? '+' : ''}${calc.formatCurrency(savings, { compact: true })}</td>
                  <td style="padding:10px 8px;text-align:center;">
                    ${isRecommended ? '<span style="display:inline-block;padding:4px 12px;background:#22c55e;color:#fff;border-radius:12px;font-size:11px;font-weight:700;">RECOMMENDED</span>' : ''}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Cost-vs-DC-Count Sensitivity Curve (slice 2 — kneedle-annotated line chart) -->
      <div class="hub-card" style="margin-top:20px;padding:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
          <div style="font-size:14px;font-weight:700;">Total Cost vs. DC Count</div>
          <div style="font-size:11px;color:var(--ies-gray-500);">
            Inflection: <strong style="color:#16a34a;">${rec.recommendedIdx + 1} DC${rec.recommendedIdx === 0 ? '' : 's'}</strong> · detected via kneedle (Satopaa et al. 2011)
          </div>
        </div>
        <div style="position:relative;height:280px;">
          <canvas id="netopt-multidc-cost-chart" aria-label="Total cost vs. DC count"></canvas>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);line-height:1.5;">
          The green-highlighted point is the cost-vs-k inflection — where adding another facility no longer pays for itself in transport savings. Total cost includes facility, transport, and handling.
        </div>
      </div>
    </div>
  `;

  // Render the cost-vs-k line chart now that the canvas is in the DOM.
  // Chart.js is loaded as a global via index.html; createChart() wraps it.
  const canvas = el.querySelector('#netopt-multidc-cost-chart');
  if (canvas && typeof window !== 'undefined' && /** @type {any} */ (window).Chart) {
    if (costChartInstance) {
      try { costChartInstance.destroy(); } catch {}
      costChartInstance = null;
    }
    const labels = comparisonResults.map((_, i) => `${i + 1} DC${i === 0 ? '' : 's'}`);
    const totals = comparisonResults.map(r => r.totalCost);
    const transports = comparisonResults.map(r => r.costBreakdown?.transport || 0);
    const facilities = comparisonResults.map(r => r.costBreakdown?.facility || 0);
    // Highlight the inflection point with a larger green marker; others stay
    // small and blue.
    const totalPointRadii = totals.map((_, i) => i === rec.recommendedIdx ? 9 : 4);
    const totalPointColors = totals.map((_, i) => i === rec.recommendedIdx ? '#16a34a' : '#1e40af');

    costChartInstance = createChart(/** @type {HTMLCanvasElement} */ (canvas), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Total Cost',
            data: totals,
            borderColor: '#1e40af',
            backgroundColor: 'rgba(30, 64, 175, 0.1)',
            borderWidth: 2.5,
            tension: 0.25,
            fill: true,
            pointRadius: totalPointRadii,
            pointHoverRadius: totalPointRadii.map(r => r + 2),
            pointBackgroundColor: totalPointColors,
            pointBorderColor: totalPointColors,
            order: 0,
          },
          {
            label: 'Transport',
            data: transports,
            borderColor: '#94a3b8',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [6, 4],
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            order: 1,
          },
          {
            label: 'Facility',
            data: facilities,
            borderColor: '#fb923c',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [3, 4],
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            order: 2,
          },
        ],
      },
      options: {
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (v) => calc.formatCurrency(/** @type {number} */ (v), { compact: true }),
            },
            title: { display: true, text: 'Annual cost' },
          },
          x: {
            title: { display: true, text: 'Distribution centers (k)' },
          },
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${calc.formatCurrency(/** @type {number} */ (ctx.parsed.y))}` + (ctx.dataset.label === 'Total Cost' && ctx.dataIndex === rec.recommendedIdx ? '  (inflection point)' : ''),
            },
          },
        },
      },
    });
  }
}

function renderScenarioComparison(el) {
  const compared = calc.compareScenarios(scenarios);

  el.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Scenario Comparison</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${scenarios.length} scenario(s)</span>
      </div>

      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:900px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Scenario</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Total Cost</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Δ Cost%</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Cost/Unit</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Facility</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Transport</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Handling</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Dist</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Service</th>
              <th style="text-align:center;padding:8px 6px;font-weight:700;">Verdict</th>
            </tr>
          </thead>
          <tbody>
            ${compared.map(s => {
              const verdictColor = {
                'OPTIMAL': '#22c55e', 'BEST COST': 'var(--ies-blue)', 'BEST SERVICE': '#8b5cf6',
                'VIABLE': '#6b7280', 'SERVICE RISK': '#ef4444',
              }[s.verdict] || '#6b7280';

              return `
                <tr style="border-bottom:1px solid var(--ies-gray-200);">
                  <td style="padding:8px 6px;font-weight:600;">${s.name}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.totalCost, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;color:${s.deltaPct > 0 ? '#ef4444' : '#22c55e'};">${s.deltaPct > 0 ? '+' : ''}${s.deltaPct.toFixed(1)}%</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.avgCostPerUnit)}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.costBreakdown.facility, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.costBreakdown.transport, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatCurrency(s.costBreakdown.handling, { compact: true })}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatMiles(s.avgDistance)}</td>
                  <td style="padding:8px 6px;text-align:right;">${calc.formatPct(s.serviceLevel)}</td>
                  <td style="padding:8px 6px;text-align:center;">
                    <span style="display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${verdictColor};color:#fff;">${s.verdict}</span>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Cost comparison bar chart -->
      <div class="hub-card" style="margin-top:20px;padding:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Cost Comparison</div>
        ${compared.map(s => {
          const maxCost = Math.max(...compared.map(sc => sc.totalCost));
          const pct = maxCost > 0 ? (s.totalCost / maxCost) * 100 : 0;
          const verdictColor = {
            'OPTIMAL': '#22c55e', 'BEST COST': 'var(--ies-blue)', 'BEST SERVICE': '#8b5cf6',
            'VIABLE': '#6b7280', 'SERVICE RISK': '#ef4444',
          }[s.verdict] || '#6b7280';

          return `
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;">${s.name}</span>
                <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(s.totalCost, { compact: true })}</span>
              </div>
              <div style="height:24px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;position:relative;">
                <div style="height:100%;width:${pct}%;background:${verdictColor};border-radius:6px;transition:width 0.3s;"></div>
                <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:${pct > 60 ? '#fff' : 'var(--ies-gray-600)'};">
                  ${calc.formatPct(s.serviceLevel)} SLA
                </span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

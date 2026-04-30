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
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260429-tc1';
import { renderCmDrillbackChip, bindCmDrillback } from '../../shared/cm-drillback.js?v=20260430-am-p5fix12';
import { RunStateTracker } from '../../shared/run-state.js?v=20260419-uE';
import { downloadXLSX } from '../../shared/export.js?v=20260418-sM';
import { markDirty as guardMarkDirty, markClean as guardMarkClean } from '../../shared/unsaved-guard.js?v=20260418-sM';
import * as calc from './calc.js?v=20260427-s15';
import * as api from './api.js?v=20260430-pm-g12';
import { createChart } from '../../shared/cdn-wrappers/chart-wrapper.js?v=20260418-sK';
import { showConfirm } from '../../shared/confirm-modal.js';

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'setup' | 'map' | 'results' | 'comparison'} */
let activeView = 'setup';

/** @type {'facilities' | 'demand' | 'modemix' | 'service'} */
let activeSection = 'facilities';

// ============================================================
// CHROME v3 — top-ribbon phase + section structure (2026-04-28 EVE)
// ============================================================
const NO_GROUPS = [
  { key: 'inputs',     label: 'Inputs',     description: 'Demand & facilities' },
  { key: 'parameters', label: 'Parameters', description: 'Modes, rates, service' },
  { key: 'run',        label: 'Run',        description: 'Numbers & map' },
  { key: 'compare',    label: 'Compare',    description: 'k-sweep & sensitivity' },
];
const NO_SECTIONS = [
  { key: 'demand',     label: '\u{1F4CD} Demand',       group: 'inputs' },
  { key: 'facilities', label: '\u{1F3ED} Facilities',   group: 'inputs' },
  { key: 'modemix',    label: '\u{1F69B} Mode Mix',     group: 'parameters' },
  { key: 'rates',      label: '\u{1F4B2} Rate Card',    group: 'parameters' },
  { key: 'service',    label: '⏱ Service',         group: 'parameters' },
  { key: 'results',    label: '\u{1F4C8} Numbers',      group: 'run', viewKey: 'results' },
  { key: 'map',        label: '\u{1F5FA} Map',          group: 'run', viewKey: 'map' },
];
let _noSidebarOpen = false;
let _noKpiRefreshTimer = null;


/** @type {import('./types.js?v=20260418-sM').Facility[]} */
let facilities = [];

/**
 * Phase 4 (volumes-as-nucleus, 2026-04-29) — currently active channel filter
 * for the Demand Points table. null = show all. Set via the chip strip above
 * the table.
 * @type {string|null}
 */
let _demandChannelFilter = null;

/** Minimal HTML-escape for user-supplied strings. */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
/** Escape for HTML attribute values (covers double-quote contexts). */
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

/** @type {import('./types.js?v=20260418-sM').DemandPoint[]} */
let demands = [];

/** @type {import('./types.js?v=20260418-sM').ModeMix} */
let modeMix = { tlPct: 30, ltlPct: 40, parcelPct: 30 };

/**
 * Phase 4 of volumes-as-nucleus (2026-04-29) — per-channel modeMix overrides.
 * Map from channelKey -> ModeMix. When a demand point's channelKey matches a
 * key in this map, the engine uses that channel's modeMix instead of the
 * project-level `modeMix`. Empty map = single-mode-mix legacy behavior.
 *
 * Built from a small editor on the Parameters page; rebuilt automatically
 * when channels appear / disappear from demand points.
 *
 * @type {Object<string, import('./types.js?v=20260418-sM').ModeMix>}
 */
let channelModes = {};

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
/** Metadata about the most recent optimization run (algo + combo count + reason). */
let _optimizationMeta = null;
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
let activeParentDealId = null;
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
  const btn = rootEl.querySelector('[data-tc-primary][data-tc-action="netopt-run"]');
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

  // 2026-04-30 (G12): CM -> NetOpt cross-tool handoff. Mirrors the COG
  // pattern above and the WSC consumer in tools/warehouse-sizing/ui.js.
  // Both paths set activeParentCmId so the drillback chips on byChannel
  // rows can render and handleSaveNetopt persists the linkage.
  bus.on('cm:push-to-netopt', (payload) => {
    openEditor(null);
    applyCmHandoff(payload);
  });
  try {
    const pending = sessionStorage.getItem('cm_pending_netopt_push');
    if (pending) {
      const payload = JSON.parse(pending);
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('cm_pending_netopt_push');
        openEditor(null);
        applyCmHandoff(payload);
        bus.emit('netopt:mounted');
        return;
      }
      sessionStorage.removeItem('cm_pending_netopt_push');
    }
  } catch (e) { console.warn('[NetOpt] Failed to consume CM handoff:', e); }

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
/**
 * Apply CM -> NetOpt handoff. Sets parent_cost_model_id / parent_deal_id
 * trackers so handleSaveNetopt persists them on save and the drillback
 * chips on byChannel rows render. Optionally seeds the per-channel modes
 * editor with channel keys + names from CM's channels[].
 * @param {{ parent_cost_model_id?: any, parent_deal_id?: any, channelSeed?: Array<{channelKey:string, name:string}> }} payload
 */
function applyCmHandoff(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.parent_cost_model_id != null) {
    activeParentCmId = payload.parent_cost_model_id;
  }
  if (payload.parent_deal_id != null) {
    activeParentDealId = payload.parent_deal_id;
  }
  // Seed the per-channel modes editor so each channel from CM appears as
  // a row even before any demand point is tagged. Engine routing reads
  // channelModes[k] in assignDemand/evaluateScenario.
  if (Array.isArray(payload.channelSeed) && payload.channelSeed.length > 0) {
    for (const c of payload.channelSeed) {
      if (!c || !c.channelKey) continue;
      if (!channelModes[c.channelKey]) {
        channelModes[c.channelKey] = {
          tlPct: modeMix.tlPct,
          ltlPct: modeMix.ltlPct,
          parcelPct: modeMix.parcelPct,
        };
      }
    }
  }
  markDirty();
  if (rootEl) {
    _refreshTopChrome?.();
    refreshNoHeaderKpis?.();
  }
  console.log('[NetOpt] Received CM handoff, parent_cm_id=' + activeParentCmId);
}

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
  // 2026-04-25 PM (Brock walkthrough): land on step 1 (Demand Points), not step 2 (Facilities).
  // Demand drives every downstream step; Facilities are candidates that depend on demand placement.
  activeSection = 'demand';
  const d = savedRow?.config_data || {};
  // 2026-04-21 audit fix: new configs start EMPTY. Demo network available
  // via the "Load Sample Network" button on the Facilities section so users
  // can still reach it intentionally. Prior behavior auto-loaded 5 DCs + 10
  // demand points on every "New Config".
  // 2026-04-27 — Normalize on load. Saved scenarios accumulated several
  // shape variants over time (active/perUnit instead of isOpen/variableCost,
  // facilities saved without lat/lng, demands saved as `volume` not
  // `annualDemand`). normalizeFacility/normalizeDemand back-fill those so
  // legacy rows stop tripping the Run validator.
  facilities = (d.facilities && d.facilities.length) ? d.facilities.map(f => calc.normalizeFacility({ ...f })) : [];
  demands = (d.demands && d.demands.length) ? d.demands.map(x => calc.normalizeDemand({ ...x })) : [];
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
  activeParentDealId = savedRow?.parent_deal_id || null;
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
  renderContentView();
  refreshNoHeaderKpis();
  // Back-button binding lives in bindShellEvents() now (CM Chrome v3 ripple).
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
  refreshNoSaveStateChip();
  _refreshTopChrome();
  refreshNoHeaderKpis({ debounce: true });
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
      // 2026-04-30 (G12): persist CM linkage. saveConfig on the api side
      // promotes these to the top-level columns so reload picks them up
      // via savedRow.parent_cost_model_id.
      parent_cost_model_id: activeParentCmId,
      parent_deal_id: activeParentDealId,
    };
    const saved = await api.saveConfig(payload);
    activeConfigId = saved?.id || activeConfigId;
    _configName = saved?.name || name;
    isDirty = false;
    guardMarkClean('netopt');
    rootEl.innerHTML = renderShell();
    bindShellEvents();
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
  bus.clear('cm:push-to-netopt'); // G12: free the CM handoff listener
  runState.reset();
  rootEl = null;
  bus.emit('netopt:unmounted');
}

// ============================================================
// SHELL
// ============================================================

// ============================================================
// PHASE STATE (2026-04-27 EVE — stepper-driven wizard redesign)
// ============================================================
// The shell collapsed THREE redundant nav surfaces (top tab strip + chip
// strip + sidebar) into ONE primary nav: a horizontal phase stepper.
// activeView and activeSection are kept as the underlying state — the
// phase stepper just maps clicks to (view, section) tuples.
//
// Phase mapping:
//   inputs     → activeView 'setup' + activeSection 'demand' | 'facilities'
//   parameters → activeView 'setup' + activeSection 'modemix' | 'service'
//   run        → activeView 'results' (map + KPIs + table on one canvas)
//   compare    → activeView 'comparison'
//
// Existing call sites that set activeView/activeSection directly keep
// working — the derived phase auto-follows.
/** @returns {'inputs'|'parameters'|'run'|'compare'} */
function currentPhase() {
  if (activeView === 'comparison') return 'compare';
  if (activeView === 'results' || activeView === 'map') return 'run';
  // Setup view splits into Inputs vs Parameters by section.
  if (activeSection === 'modemix' || activeSection === 'rates' || activeSection === 'service') return 'parameters';
  return 'inputs';
}
/** Set the phase and seed activeView/activeSection appropriately. */
function setPhase(phase) {
  switch (phase) {
    case 'inputs':
      activeView = 'setup';
      if (activeSection !== 'demand' && activeSection !== 'facilities') {
        activeSection = (demands.length === 0) ? 'demand' : 'facilities';
      }
      break;
    case 'parameters':
      activeView = 'setup';
      if (activeSection !== 'modemix' && activeSection !== 'service') {
        activeSection = 'modemix';
      }
      break;
    case 'run':
      activeView = 'results';
      break;
    case 'compare':
      activeView = 'comparison';
      break;
  }
}

function renderShell() {
  // CM Chrome v3 ripple, step 2 — chrome HTML+CSS lives in
  // shared/tool-chrome.js. NetOpt now passes opts in and consumes the
  // returned shell HTML.
  return renderToolChrome(_buildChromeOpts());
}

/**
 * Build the opts object the shared primitive needs from current
 * NetOpt state. Centralised so renderShell, refreshToolChrome calls,
 * and refreshToolChromeActions all stay consistent.
 */
function _buildChromeOpts() {
  const activePhase = currentPhase();
  const activeKey = _activeNoSectionKey();
  const draft = !activeConfigId;
  const modified = !!activeConfigId && isDirty;
  const saveStateName = draft ? 'draft' : (modified ? 'modified' : 'saved');
  const saveStateTitle = draft
    ? 'Brand-new scenario — Save to capture an audit timestamp'
    : (modified ? 'Save to capture the latest changes' : 'Saved');

  const runStateClass = runState.state(runStateInputs());
  const isCompare = activePhase === 'compare';

  const actions = [
    { id: 'export-csv', label: '\u{1F4E5} Export', title: 'Export scenarios to XLSX' },
    isCompare ? { id: 'clear-scenarios', label: '\u{1F5D1} Clear', title: 'Clear all run scenarios' } : null,
    { id: 'netopt-save',
      label: activeConfigId ? '\u{1F4BE} Save' : '\u{1F4BE} Save Scenario',
      title: activeConfigId ? 'Update this scenario' : 'Save this scenario so you can reopen it later',
      primary: modified },
    { id: 'netopt-run',
      label: 'Run',
      icon: '▶',
      title: 'Run network optimizer (Cmd/Ctrl+Enter)',
      kind: 'primary',
      runState: runStateClass,
      cleanLabel: '✓ Results current',
      cleanTitle: 'Inputs unchanged since the last run — click to force a re-run.' },
  ].filter(Boolean);

  const sidebarFooter = activeParentCmId
    ? 'Linked to Cost Model #' + activeParentCmId
    : '';

  return {
    toolKey: 'netopt',
    groups: NO_GROUPS,
    sections: NO_SECTIONS,
    activePhase,
    activeSection: activeKey,
    sectionCompleteness: _noSectionCompleteness,
    saveState: { state: saveStateName, title: saveStateTitle },
    actions,
    showSidebar: _noSidebarOpen,
    sidebarHeader: 'All Sections',
    sidebarBody: renderNoGroupedNav(),
    sidebarFooter,
    bodyHtml: '<div class="hub-builder-form" id="no-content"></div>',
    backTitle: 'Back to scenarios',
    emptyPhaseHint: 'k-sweep + sensitivity in this phase — no sub-sections',
    fileInputs: '<input type="file" id="netopt-csv-upload" accept=".csv,text/csv" style="display:none;"/>',
  };
}

// ============================================================
// CHROME v3 helpers (2026-04-28 EVE)
// ============================================================
function _html(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function _attr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function _noSectionsByGroup() {
  const m = new Map();
  for (const g of NO_GROUPS) m.set(g.key, []);
  for (const s of NO_SECTIONS) {
    const arr = m.get(s.group);
    if (arr) arr.push(s);
  }
  return m;
}

function _activeNoSectionKey() {
  const phase = currentPhase();
  if (phase === 'run') return activeView === 'map' ? 'map' : 'results';
  if (phase === 'inputs') return (activeSection === 'facilities') ? 'facilities' : 'demand';
  if (phase === 'parameters') {
    if (activeSection === 'rates' || activeSection === 'service') return activeSection;
    return 'modemix';
  }
  return null;
}

function _noSectionCompleteness(key) {
  switch (key) {
    case 'demand':     return demands.length === 0 ? 'empty' : 'complete';
    case 'facilities': {
      if (facilities.length === 0) return 'empty';
      return facilities.some(f => f.isOpen) ? 'complete' : 'partial';
    }
    case 'modemix': {
      const sum = (modeMix && modeMix.tlPct || 0) + (modeMix && modeMix.ltlPct || 0) + (modeMix && modeMix.parcelPct || 0);
      return Math.abs(sum - 100) < 0.5 ? 'complete' : 'partial';
    }
    case 'rates':   return (rateCard && rateCard.tlPerMile) ? 'complete' : 'empty';
    case 'service': return (serviceConfig && serviceConfig.globalMaxDays) ? 'complete' : 'empty';
    case 'results': return activeScenario ? 'complete' : 'empty';
    case 'map':     return activeScenario ? 'complete' : 'empty';
    default: return 'empty';
  }
}

function renderNoGroupedNav() {
  const sectionsByGroup = _noSectionsByGroup();
  const activeKey = _activeNoSectionKey();
  return NO_GROUPS.map(g => {
    const items = sectionsByGroup.get(g.key) || [];
    const itemsHtml = items.length === 0
      ? '<div class="tc-nav-item" data-tc-section="__phase__:' + g.key + '"><span style="opacity:0.6;font-style:italic;">Open ' + _html(g.label) + '</span></div>'
      : items.map(s => '<div class="tc-nav-item ' + (activeKey === s.key ? 'active' : '') + '" data-tc-section="' + s.key + '"><span class="tc-nav-check ' + (_noSectionCompleteness(s.key) === 'complete' ? 'complete' : '') + '"></span><span>' + _html(s.label) + '</span></div>').join('');
    return '<div class="tc-nav-group"><div class="tc-nav-group-label">' + _html(g.label) + '</div>' + itemsHtml + '</div>';
  }).join('');
}

function navigateNoSection(key) {
  if (!key) return;
  if (key.startsWith('__phase__:')) {
    const phase = key.slice('__phase__:'.length);
    setPhase(/** @type {any} */ (phase));
    renderContentView();
    _refreshTopChrome();
    refreshNoHeaderKpis();
    return;
  }
  const sec = NO_SECTIONS.find(s => s.key === key);
  if (!sec) return;
  if (sec.group === 'run') {
    activeView = sec.viewKey || 'results';
  } else if (sec.group === 'inputs') {
    activeView = 'setup';
    activeSection = key;
  } else if (sec.group === 'parameters') {
    activeView = 'setup';
    activeSection = key;
  } else if (sec.group === 'compare') {
    activeView = 'comparison';
  }
  renderContentView();
  _refreshTopChrome();
  refreshNoHeaderKpis();
}

function _refreshTopChrome() {
  if (!rootEl) return;
  refreshToolChrome(rootEl, _buildChromeOpts());
  // Run-button class still lives on a tc-primary button — refresh its
  // class/state without rebuilding the entire actions rail.
  updateRunButtonState();
}

function refreshNoSaveStateChip() {
  if (!rootEl) return;
  refreshToolChrome(rootEl, _buildChromeOpts());
}

function formatNoSavedWhen() { return ''; }

function refreshNoHeaderKpis(opts) {
  if (opts && opts.debounce) {
    if (_noKpiRefreshTimer) clearTimeout(_noKpiRefreshTimer);
    _noKpiRefreshTimer = setTimeout(() => { _noKpiRefreshTimer = null; refreshNoHeaderKpis(); }, 200);
    return;
  }
  if (!rootEl) return;
  const kpis = computeNoHeaderKpis();
  refreshKpiStrip(rootEl, kpis.items);
}

function computeNoHeaderKpis() {
  const s = activeScenario;
  let optimalK = '—';
  let optimalKHint = 'Run a k-sweep on the Compare phase to find the cost-optimal facility count.';
  if (recommendedDCCount) {
    optimalK = String(recommendedDCCount);
    optimalKHint = 'Recommended DC count from the most recent k-sweep (kneedle-elbow).';
  } else if (s && Array.isArray(facilities)) {
    optimalK = String(facilities.filter(f => f.isOpen).length);
    optimalKHint = 'Open facilities count. Run k-sweep for a cost-optimal recommendation.';
  }

  if (!s) {
    return { items: [
      { label: 'Total Cost', value: '—', hint: 'Run a scenario to populate KPIs.' },
      { label: 'Lanes',      value: '—' },
      { label: 'Service %',  value: '—' },
      { label: 'Optimal K',  value: optimalK, hint: optimalKHint },
    ] };
  }
  let costLabel = '—';
  try { costLabel = calc.formatCurrency(s.totalCost, { compact: true }); } catch (_) {}
  const laneCount = Array.isArray(s.assignments) ? s.assignments.length : 0;
  const svcPct = (typeof s.serviceLevel === 'number') ? (s.serviceLevel.toFixed(1) + '%') : '—';
  return { items: [
    { label: 'Total Cost', value: costLabel, hint: 'Active scenario total cost (transport + facility) per year.' },
    { label: 'Lanes',      value: laneCount.toLocaleString(), hint: 'Demand-to-facility lanes evaluated in the active scenario.' },
    { label: 'Service %',  value: svcPct, hint: 'Lanes meeting their SLA window (≤ maxDays) as % of total.' },
    { label: 'Optimal K',  value: optimalK, hint: optimalKHint },
  ] };
}


function viewLabel(v) {
  const labels = { setup: 'Setup', map: 'Network Map', results: 'Results', comparison: 'Compare' };
  return labels[v] || v;
}

async function bindShellEvents() {
  if (!rootEl) return;
  // Reset bound-flag so re-renders (e.g. after sidebar toggle does a
  // full innerHTML replace) get re-bound. The primitive's idempotency
  // tag is per-rootEl; rootEl reference doesn't change but innerHTML
  // does, so we flip the flag here ourselves.
  rootEl.__tcBound = false;

  bindToolChromeEvents(rootEl, {
    onPhase: (target) => {
      if (!target || target === currentPhase()) return;
      setPhase(/** @type {any} */ (target));
      renderContentView();
      _refreshTopChrome();
      refreshNoHeaderKpis();
    },
    onSection: (key) => navigateNoSection(key),
    onSidebar: (kind) => {
      _noSidebarOpen = (kind === 'toggle') ? !_noSidebarOpen : false;
      // Surgical update of body data-attr — primitive owns the CSS.
      refreshToolChrome(rootEl, _buildChromeOpts());
    },
    onBack: async () => {
      if (isDirty && !(await showConfirm('You have unsaved changes. Leave anyway?'))) return;
      guardMarkClean('netopt');
      await renderLanding();
    },
    onAction: (id) => {
      if (id === 'netopt-run') {
        runScenario();
        markDirty();
        flashPrimaryAction(rootEl);
        return;
      }
      if (id === 'netopt-save') return handleSaveNetopt();
      if (id === 'export-csv') return exportToCSV();
      if (id === 'clear-scenarios') {
        scenarios = []; activeScenario = null; comparisonResults = null;
        markDirty(); renderContentView();
        _refreshTopChrome();
        refreshNoHeaderKpis();
      }
    },
    onPrimaryShortcut: () => {
      runScenario();
      markDirty();
      flashPrimaryAction(rootEl);
    },
  });
  // Phase 5.4 — cross-tool CM drillback chip delegation.
  bindCmDrillback(rootEl);

  // CSV file input lives at shell scope; re-bind after every renderShell.
  rootEl.querySelector('#netopt-csv-upload')?.addEventListener('change', handleCsvUpload);
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
  // 2026-04-28 EVE — in-canvas process-flow chip strip dropped (Brock
  // 2026-04-29 decision). Top-ribbon Row 1 phase tabs convey phase context.
  return;
}

/** @param {'inputs'|'parameters'|'run'|'compare'} phase */
function jumpToPhase(phase) {
  setPhase(phase);
  switch (phase) {
    case 'inputs':
    case 'parameters':
    case 'run':
    case 'compare':
      // setPhase already aligned activeView/activeSection.
      break;
  }
  // Sync the tool-frame view-tab buttons.
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === activeView);
  });
  renderContentView();
}

// ============================================================
// SIDEBAR
// ============================================================

function renderSidebar() {
  // 2026-04-27 EVE2 (NO-SCOPE-9): sidebar was removed from the shell in EVE1.
  // All former sidebar contents live in their phase content areas
  // (renderInputsPhase / renderParametersPhase / renderRunPhase /
  // renderComparePhase) or the header secondaryActions rail. The ~160-line
  // dead body that followed this comment was deleted in EVE2 — this is now
  // a true no-op kept only for backward compatibility with historical call
  // sites. Renderers should call renderContentView() (which calls
  // renderProcessFlow internally) instead of renderSidebar() directly.
  return;
  /* legacy body deleted 2026-04-27 EVE2 — see commit history */
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
    alert('Add demand points first. The optimizer needs demand to cluster against.\n\nTip: pick an industry preset from the Quick-seed bar above the Demand table to load a demo demand set.');
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
  const result = calc.evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig, { channelMixMap: channelModes });
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
  const result = calc.evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig, { channelMixMap: channelModes });
  scenarios.push(result);
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

// 2026-04-27 — Replaces the prior compareMultipleDCs + runExactSolver pair
// ("Compare DCs (k-sweep)" + "🧮 Exhaustive Search"). Single entry point;
// auto-picks the algorithm based on combinatorial size of the candidate set.
//
// User-visible benefit: one fewer decision to make. They click "🎯 Optimize
// Network", we tell them after which algorithm we used (provably-optimal
// brute force vs. multi-start heuristic) so the algorithmic detail is
// visible but no longer a *choice* the user has to make.
//
// @param {{ force?: 'heuristic' | 'exhaustive' }} [opts]
function optimizeNetwork(opts = {}) {
  if (demands.length === 0) {
    alert('Please add demand points first.');
    return;
  }
  const candidates = facilities.filter(f => f.isOpen !== false);
  if (candidates.length === 0) {
    alert('Please activate at least one facility candidate to consider in the optimization.');
    return;
  }
  // Estimate combinatorial size: sum of C(n, k) for k=1..min(maxDCsToTest, n)
  const n = candidates.length;
  const kCap = Math.min(maxDCsToTest, n);
  let totalCombos = 0;
  for (let k = 1; k <= kCap; k++) totalCombos += _binomial(n, k);
  const exhaustiveOK = totalCombos > 0 && totalCombos <= 10000;
  const algo = opts.force === 'heuristic'  ? 'heuristic'
             : opts.force === 'exhaustive' ? 'exhaustive'
             : (exhaustiveOK ? 'exhaustive' : 'heuristic');

  if (algo === 'exhaustive') {
    const result = calc.exactSolver(facilities, demands, maxDCsToTest, modeMix, rateCard, serviceConfig, { channelMixMap: channelModes });
    if (!result) {
      // Forced exhaustive but search space too large (>10,000 cap inside calc) —
      // transparently fall back to heuristic instead of erroring on the user.
      console.warn('[netopt] exhaustive solver returned null — falling back to heuristic');
      _runHeuristicOptimize(n, totalCombos, kCap, candidates, /*reasonOverride*/ 'exhaustive_too_large');
      return;
    }
    // exactSolver returns every C(n,k) combination across k=1..kCap. Reduce to
    // the BEST scenario per k so the comparison table reads as a clean
    // 1..kCap k-sweep — the same shape multiDCComparison produces — and the
    // "Recommended N DCs" panel correctly maps recommendedIdx → DC count.
    const bestPerK = new Map();
    for (const sc of result.scenarios) {
      // exactSolver names each scenario "${numFacs} DC" (calc.js evaluateScenario
      // call), so the open-DC count is parseable from the name. Fall back to
      // counting distinct facility ids in the assignments if the name format
      // ever changes.
      let openCount = 0;
      const m = /^(\d+)\s*DC/i.exec(String(sc.name || ""));
      if (m) openCount = parseInt(m[1], 10);
      if (!openCount && Array.isArray(sc.assignments)) {
        openCount = new Set(sc.assignments.map(a => a.facilityId).filter(Boolean)).size;
      }
      if (!openCount) continue;
      const prev = bestPerK.get(openCount);
      if (!prev || sc.totalCost < prev.totalCost) bestPerK.set(openCount, sc);
    }
    comparisonResults = [...bestPerK.keys()].sort((a, b) => a - b).map(k => bestPerK.get(k));
    _optimizationMeta = {
      algorithm: 'exhaustive',
      candidateCount: n,
      kCap,
      totalCombos,
      reason: 'tractable',
    };
  } else {
    _runHeuristicOptimize(n, totalCombos, kCap, candidates, exhaustiveOK ? 'forced' : 'too_large');
  }

  const rec = calc.recommendOptimalDCs(comparisonResults, serviceConfig);
  recommendedDCCount = rec.recommendedIdx;
  activeView = 'comparison';
  rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeView);
  });
  renderContentView();
}

function _runHeuristicOptimize(n, totalCombos, kCap, candidates, reason) {
  comparisonResults = calc.multiDCComparison(facilities, demands, modeMix, rateCard, serviceConfig, maxDCsToTest);
  _optimizationMeta = {
    algorithm: 'heuristic',
    candidateCount: n,
    kCap,
    totalCombos,
    reason, // 'forced' | 'too_large' | 'exhaustive_too_large'
  };
}

/** Compute C(n, k). Local copy because calc's binomialCoeff isn't exported. */
function _binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
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
  // 2026-04-27 EVE: phase-driven dispatcher (Option B stepper redesign).
  const phase = currentPhase();
  switch (phase) {
    case 'inputs':     renderInputsPhase(el);     break;
    case 'parameters': renderParametersPhase(el); break;
    case 'run':        renderRunPhase(el);        break;
    case 'compare':    renderComparePhase(el);    break;
  }
  renderProcessFlow();
  // Top chrome rows (phase counts, section pill dots) reflect content state —
  // refresh after every content render so dots/counts stay in lockstep.
  _refreshTopChrome();
  refreshNoHeaderKpis();
}

// ============================================================
// SUB-TAB / TOOLS HELPERS (2026-04-27 EVE — stepper redesign)
// ============================================================
// 2026-04-28 EVE — sub-tab strips removed from phase content. The new
// top-ribbon chrome's Row 2 section pills are now the SINGLE source of
// section nav across the tool. Sub-tab callsites below were inlined empty.
const renderSubTabStrip = () => '';

/** Quick-seed archetype bar shown above the Inputs phase content. */
function renderArchetypeSeedBar() {
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--ies-gray-50,#f9fafb);border:1px solid var(--ies-gray-200);border-radius:8px;margin-top:14px;flex-wrap:wrap;">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.4px;color:var(--ies-gray-500);text-transform:uppercase;">Quick-seed</span>
      ${calc.listArchetypes().map(a => `
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-archetype="${a.key}"
                style="font-size:11px;padding:4px 10px;${selectedArchetype === a.key ? 'border-color:var(--ies-blue);color:var(--ies-blue);' : ''}"
                title="${a.description || a.name}">${a.name}</button>
      `).join('')}
    </div>`;
}

// renderToolsPanel — DELETED 2026-04-27 EVE2 (NO-SCOPE-1/2/3/4/5/8).
// The right-rail Tools panel hosted five actions belonging on five different
// surfaces. They were re-allocated:
//   Find Optimal Locations   → Inputs · Facilities header (NO-SCOPE-1)
//   Balance Mode Mix         → Mode Mix sub-tab inline
//   Apply Market Rates       → Rate Card panel header (NO-SCOPE-4)
//   Upload Rate Card CSV     → Rate Card panel header (NO-SCOPE-5)
//   Optimize Network k-sweep → Compare phase header (NO-SCOPE-2)
//   Max DCs to test          → travels with Optimize Network (NO-SCOPE-3)

// ============================================================
// PHASE RENDERERS (2026-04-27 EVE)
// ============================================================
function renderInputsPhase(el) {
  if (activeSection !== 'demand' && activeSection !== 'facilities') activeSection = 'demand';
  el.innerHTML = '<div>' +
    (activeSection === 'demand' ? renderArchetypeSeedBar() : '') +
    '<div id="np-phase-inner" style="margin-top:6px;"></div></div>';
  const inner = el.querySelector('#np-phase-inner');
  if (activeSection === 'facilities') renderFacilities(inner);
  else                                renderDemand(inner);
  bindArchetypeButtons(el);
}

function renderParametersPhase(el) {
  if (!['modemix', 'rates', 'service'].includes(activeSection)) activeSection = 'modemix';
  el.innerHTML = '<div><div id="np-phase-inner" style="margin-top:6px;"></div></div>';
  const inner = el.querySelector('#np-phase-inner');
  if      (activeSection === 'service') renderServiceConfig(inner);
  else if (activeSection === 'rates')   renderRateCardPhase(inner);
  else                                  renderModeMix(inner);
}

function renderRunPhase(el) {
  if (activeView !== 'map' && activeView !== 'results') activeView = 'results';
  el.innerHTML = '<div style="display:flex;flex-direction:column;height:100%;"><div id="np-phase-inner" style="flex:1;min-height:0;"></div></div>';
  const inner = el.querySelector('#np-phase-inner');
  if (activeView === 'map') renderMap(inner);
  else                       renderResults(inner);
}

function renderComparePhase(el) {
  // 2026-04-27 EVE2 (NO-SCOPE-2 + NO-SCOPE-3): Optimize Network k-sweep is the
  // primary action of the Compare phase. 2026-04-28: outer padding dropped —
  // #no-content provides 20×24 form padding.
  el.innerHTML = `
    <div>
      <div class="hub-card" style="padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:280px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.4px;color:var(--ies-gray-500);text-transform:uppercase;">Run k-sweep</div>
          <div style="font-size:12px;color:var(--ies-gray-500);margin-top:3px;line-height:1.5;">Sweeps k from 1 to <em>Max DCs</em> and picks the best subset of candidates for each. Auto-uses exhaustive search when combinations ≤ 10,000 (provably optimal); otherwise multi-start heuristic.</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ies-gray-600);">
            Max DCs
            <input type="number" id="netopt-max-dcs" min="1" max="20" value="${maxDCsToTest}" style="width:60px;padding:5px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;text-align:right;"/>
          </label>
          <button class="hub-btn hub-btn-sm hub-btn-primary" data-action="optimize-network" style="font-size:12px;padding:6px 12px;font-weight:700;">🎯 Optimize Network</button>
        </div>
      </div>
      <div id="np-phase-inner"></div>
    </div>
  `;
  // Wire compare-header actions.
  el.querySelector('[data-action="optimize-network"]')?.addEventListener('click', () => {
    optimizeNetwork();
    markDirty();
  });
  el.querySelector('#netopt-max-dcs')?.addEventListener('change', (e) => {
    const val = parseInt(/** @type {HTMLInputElement} */ (e.target).value, 10) || 5;
    maxDCsToTest = Math.max(1, Math.min(20, val));
    comparisonResults = null;
    recommendedDCCount = null;
    /** @type {HTMLInputElement} */ (e.target).value = String(maxDCsToTest);
  });
  renderComparison(el.querySelector('#np-phase-inner'));
}

// ============================================================
// PHASE-LOCAL EVENT BINDERS
// ============================================================
function bindPhaseSubTabClicks(scope) {
  scope.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSection = /** @type {any} */ (btn.dataset.section);
      renderContentView();
    });
  });
}
function bindRunPhaseSubTabs(scope) {
  scope.querySelectorAll('[data-runsub]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeView = /** @type {any} */ (btn.dataset.runsub);
      renderContentView();
    });
  });
}
function bindArchetypeButtons(scope) {
  scope.querySelectorAll('[data-archetype]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = /** @type {HTMLElement} */ (btn).dataset.archetype;
      applyArchetype(key);
      markDirty();
    });
  });
}
// bindToolsPanelClicks — DELETED 2026-04-27 EVE2 (NO-SCOPE-8). Tools panel
// removed; per-section actions are now wired locally in their renderers.

// Legacy renderSetup retained for any caller still dispatching by section.
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
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Facility Network</h3>
        <div style="display:flex;gap:8px;">
          ${facilities.length === 0 && demands.length === 0 ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-load-sample" title="Seed 5 candidate DCs + 10 demand points so you can explore the optimizer without entering data.">Load Sample Network</button>` : ''}
          ${demands.length > 0
            ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-find-optimal-header" title="Weighted k-means on your demand → recommended DC metros. Adds candidate facilities to the list without opening them.">🎯 Find Optimal Locations</button>`
            : `<button class="hub-btn hub-btn-sm hub-btn-secondary" disabled title="Add demand points first — k-means needs demand to cluster against." style="opacity:0.55;cursor:not-allowed;">🎯 Find Optimal Locations</button>`}
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
          <div style="font-size:12px;color:var(--ies-gray-500);line-height:1.5;">Add candidate DCs one at a time with <b>+ Add Facility</b>, or click <b>Load Sample Network</b> to seed a 5-DC + 10-demand-point US example you can modify. To load demand from an industry preset first, switch to the <b>Demand</b> tab and pick one from the Quick-seed bar.</div>
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
    });
  });

  // Delete facility
  el.querySelectorAll('[data-fac-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (btn).dataset.facDelete);
      facilities.splice(idx, 1);
      markDirty();
      renderFacilities(el);
    });
  });

  // Add facility
  function _addBlankFacility() {
    const id = 'f' + Date.now();
    facilities.push({ id, name: 'New DC', city: '', state: '', lat: 39.8283, lng: -98.5795, capacity: 200000, fixedCost: 1000000, variableCost: 3.00, isOpen: true });
    markDirty();
    renderFacilities(el);
  }
  el.querySelector('#no-add-facility')?.addEventListener('click', _addBlankFacility);
  el.querySelector('#no-find-optimal-header')?.addEventListener('click', () => {
    findOptimalLocations();
    markDirty();
  });
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
    if (typeof window !== 'undefined' && window.__iesToast) {
      window.__iesToast(`Loaded sample network — ${facilities.length} DCs + ${demands.length} demand points`, 'success');
    }
  });
}

function renderDemand(el) {
  // Phase 4 — derive distinct channels currently on demand points + render
  // a filter chip strip. null filter = show everything. Empty-string channel
  // values are bucketed under "(unmapped)".
  const channelTotals = new Map(); // channelKey -> { units, points }
  for (const d of demands) {
    const k = (d.channelKey || '').trim();
    const cur = channelTotals.get(k) || { units: 0, points: 0 };
    cur.units += Number(d.annualDemand) || 0;
    cur.points += 1;
    channelTotals.set(k, cur);
  }
  const filteredDemands = _demandChannelFilter == null
    ? demands
    : demands.filter(d => (d.channelKey || '') === _demandChannelFilter);
  const totalDemand = filteredDemands.reduce((s, d) => s + (Number(d.annualDemand) || 0), 0);
  const channelChips = Array.from(channelTotals.entries()).map(([k, v]) => {
    const isActive = _demandChannelFilter === k;
    const label = k || '(unmapped)';
    const pct = demands.length > 0 ? Math.round(100 * v.points / demands.length) : 0;
    return `<button class="hub-btn hub-btn-sm ${isActive ? 'hub-btn-primary' : 'hub-btn-secondary'}" data-dem-chan-filter="${escapeAttr(k)}" title="${escapeAttr(label)} — ${v.points} points · ${v.units.toLocaleString()} units (${pct}%)">${escapeHtml(label)} <span style="opacity:.7;">${v.points}</span></button>`;
  }).join('');

  el.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Demand Points</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="no-add-demand">+ Add Point</button>
        </div>
      </div>
      ${channelTotals.size > 0 ? `
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 12px;font-size:12px;">
          <span style="color:var(--ies-gray-500);font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:11px;">Channel filter</span>
          <button class="hub-btn hub-btn-sm ${_demandChannelFilter == null ? 'hub-btn-primary' : 'hub-btn-secondary'}" data-dem-chan-filter-all="1" title="Show all channels">All <span style="opacity:.7;">${demands.length}</span></button>
          ${channelChips}
        </div>
      ` : ''}

      <div style="max-height:400px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:#fff;z-index:1;">
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">ZIP3</th>
              <th style="text-align:left;padding:8px 6px;font-weight:700;" title="Channel binding (Phase 4 of volumes-as-nucleus). Free text — filter chips above auto-derive from distinct values. Match the Cost Model channel.key for downstream mode-mix routing.">Channel</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lat</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Lng</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Annual Demand</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Max Days</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Wt (lbs)</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;" title="NMFC freight class for LTL costing — drives the class multiplier (50 dense → 0.65×; 500 light → 2.60×). 100 is baseline.">NMFC</th>
              <th style="text-align:left;padding:8px 6px;font-weight:700;" title="UN hazmat class (1.1 explosives → 9 misc). Blank = none. Drives ~12% TL premium and route restrictions.">Hazmat</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;" title="Annual demand distribution profile. Drives peak-month sizing.">Seasonality</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;" title="Order cadence. Drives LTL↔TL break-even — low frequency favors LTL even at higher per-mile rates.">Frequency</th>
              <th style="text-align:center;padding:8px 6px;font-weight:700;"></th>
            </tr>
          </thead>
          <tbody>
            ${filteredDemands.map((d) => {
              const i = demands.indexOf(d);  // stable original index for data-* handlers
              return `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${d.zip3 || '—'}</td>
                <td style="padding:6px;">
                  <input type="text" data-dem-channel="${i}" value="${escapeAttr(d.channelKey || '')}" placeholder="(unmapped)" maxlength="32" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;background:#fff;width:90px;" title="Free-text channel binding — match a Cost Model channel.key (e.g. dtc, b2b) when present." />
                </td>
                <td style="padding:6px;text-align:right;">${Number.isFinite(Number(d.lat)) ? Number(d.lat).toFixed(2) : '<span style="color:#dc2626;" title="Missing — re-add this row or set the city to auto-resolve">—</span>'}</td>
                <td style="padding:6px;text-align:right;">${Number.isFinite(Number(d.lng)) ? Number(d.lng).toFixed(2) : '<span style="color:#dc2626;" title="Missing — re-add this row or set the city to auto-resolve">—</span>'}</td>
                <td style="padding:6px;text-align:right;">${Number.isFinite(Number(d.annualDemand)) ? Number(d.annualDemand).toLocaleString() : '0'}</td>
                <td style="padding:6px;text-align:right;">${d.maxDays || 3}</td>
                <td style="padding:6px;text-align:right;">${d.avgWeight || 25}</td>
                <td style="padding:6px;text-align:right;">
                  <select data-dem-nmfc="${i}" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;background:#fff;">
                    ${calc.NMFC_CLASS_CODES.map(c => `<option value="${c}"${(d.nmfcClass || 100) === c ? ' selected' : ''}>${c}</option>`).join('')}
                  </select>
                </td>
                <td style="padding:6px;text-align:left;">
                  <select data-dem-hazmat-class="${i}" title="UN hazmat class (blank = none)" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;background:#fff;max-width:170px;">
                    <option value=""${!d.hazmatClass && !d.hazmat ? ' selected' : ''}>— none —</option>
                    ${calc.HAZMAT_CLASSES.map(c => `<option value="${c}"${(d.hazmatClass === c || (!d.hazmatClass && d.hazmat && c.startsWith('9 '))) ? ' selected' : ''}>${c}</option>`).join('')}
                  </select>
                </td>
                <td style="padding:6px;text-align:right;">
                  <select data-dem-seasonality="${i}" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;background:#fff;">
                    ${['uniform','holiday','spring','summer','back_to_school','custom'].map(s => `<option value="${s}"${(d.seasonality || 'uniform') === s ? ' selected' : ''}>${s.replace('_',' ')}</option>`).join('')}
                  </select>
                </td>
                <td style="padding:6px;text-align:right;">
                  <select data-dem-frequency="${i}" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;background:#fff;">
                    ${calc.FREQUENCY_OPTIONS.map(f => `<option value="${f}"${(d.frequency || 'weekly') === f ? ' selected' : ''}>${f}</option>`).join('')}
                  </select>
                </td>
                <td style="padding:6px;text-align:center;">
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-dem-delete="${i}" style="padding:4px 8px;">✕</button>
                </td>
              </tr>
            `;
            }).join('')}
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
    });
  });

  // Phase 4 (volumes-as-nucleus, 2026-04-29): per-demand channel binding.
  // Free-text input — match a Cost Model channel.key when downstream routing
  // matters; otherwise leave blank for "(unmapped)" bucket.
  el.querySelectorAll('[data-dem-channel]').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (input).dataset.demChannel);
      const v = String(/** @type {HTMLInputElement} */ (input).value || '').trim();
      if (demands[idx]) {
        demands[idx].channelKey = v;
        markDirty();
        renderDemand(el); // re-render so the chip strip totals refresh
      }
    });
  });

  // Phase 4 — channel filter chip strip handlers.
  el.querySelectorAll('[data-dem-chan-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = /** @type {HTMLElement} */ (btn).dataset.demChanFilter;
      // Toggle: clicking the active filter clears it.
      _demandChannelFilter = (_demandChannelFilter === k) ? null : (k || '');
      renderDemand(el);
    });
  });
  el.querySelectorAll('[data-dem-chan-filter-all]').forEach(btn => {
    btn.addEventListener('click', () => {
      _demandChannelFilter = null;
      renderDemand(el);
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

  // P2-1 — Per-demand hazmat class. UN class catalog dropdown (replaces binary
  // checkbox). Mirrors to legacy d.hazmat boolean for any consumer reading the
  // old field.
  el.querySelectorAll('[data-dem-hazmat-class]').forEach(select => {
    select.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (select).dataset.demHazmatClass);
      const v = /** @type {HTMLSelectElement} */ (select).value;
      if (!demands[idx]) return;
      demands[idx].hazmatClass = v || '';
      demands[idx].hazmat = !!v;
      markDirty();
    });
  });

  // Per-demand seasonality profile — drives peak-month sizing
  el.querySelectorAll('[data-dem-seasonality]').forEach(select => {
    select.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (select).dataset.demSeasonality);
      const v = /** @type {HTMLSelectElement} */ (select).value;
      if (demands[idx]) { demands[idx].seasonality = v; markDirty(); }
    });
  });

  // Per-demand frequency bucket — drives LTL↔TL break-even
  el.querySelectorAll('[data-dem-frequency]').forEach(select => {
    select.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (select).dataset.demFrequency);
      const v = /** @type {HTMLSelectElement} */ (select).value;
      if (demands[idx]) { demands[idx].frequency = v; markDirty(); }
    });
  });

  el.querySelector('#no-add-demand')?.addEventListener('click', () => {
    demands.push({ id: 'd' + Date.now(), zip3: '', lat: 39.83, lng: -98.58, annualDemand: 10000, maxDays: 3, avgWeight: 25, nmfcClass: 100, hazmat: false, seasonality: 'uniform', frequency: 'weekly' });
    markDirty();
    renderDemand(el);
  });
}

function renderModeMix(el) {
  // 2026-04-27 EVE2 (NO-SCOPE-6): Mode Mix is now mode-allocation only.
  // Rate Card moved to its own renderRateCardPhase sub-tab.
  el.innerHTML = `
    <div style="max-width:560px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;">
        <h3 class="text-section" style="margin:0;">Transportation Mode Mix</h3>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="balance-mode-mix" title="Auto-balance TL/LTL/Parcel mix to match average demand weight" style="font-size:11px;padding:5px 10px;">⚖ Balance Mode Mix</button>
      </div>

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

      <div style="font-size:12px;color:var(--ies-gray-500);line-height:1.5;">
        Per-lane TL / LTL / Parcel allocation. Rates that drive these costs live in the <b>Rate Card</b> sub-tab.
      </div>

      ${(() => {
        // Phase 4 of volumes-as-nucleus (2026-04-29) — Channel Modes editor.
        // Renders one sub-card per distinct channelKey found on demand points.
        // Sliders edit channelModes[k] which assignDemand reads at run time.
        const distinctChannels = Array.from(new Set(
          demands.map(d => (d.channelKey || '').trim()).filter(Boolean)
        )).sort();
        if (distinctChannels.length === 0) {
          return `
            <div class="hub-card" style="margin-top:20px;padding:14px 18px;background:var(--ies-gray-50);">
              <div style="font-size:13px;font-weight:700;margin-bottom:4px;">Channel-specific modes</div>
              <div style="font-size:12px;color:var(--ies-gray-500);line-height:1.5;">
                Tag demand points with a channel (Inputs &rarr; Demand Points &rarr; Channel column) to edit per-channel mode mixes here. DTC channels typically lean Parcel; B2B retail leans TL/LTL.
              </div>
            </div>`;
        }
        // Lazy-init: missing channel entries inherit the project modeMix.
        for (const k of distinctChannels) {
          if (!channelModes[k]) {
            channelModes[k] = { tlPct: modeMix.tlPct, ltlPct: modeMix.ltlPct, parcelPct: modeMix.parcelPct };
          }
        }
        const cards = distinctChannels.map(k => {
          const cm = channelModes[k];
          const total = (cm.tlPct || 0) + (cm.ltlPct || 0) + (cm.parcelPct || 0);
          return `
            <div class="hub-card" style="margin-top:12px;padding:14px 18px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;">
                <div style="font-size:13px;font-weight:700;display:inline-flex;align-items:center;">Channel: ${escapeHtml(k)}${renderCmDrillbackChip({ cmId: activeParentCmId, channelKey: k, channelName: k })}</div>
                <button class="hub-btn hub-btn-sm hub-btn-secondary" data-cm-reset="${escapeAttr(k)}" title="Reset this channel's mix to the project default" style="font-size:11px;padding:4px 8px;">&#x21bb; Reset to project mix</button>
              </div>
              <div style="display:flex;flex-direction:column;gap:14px;">
                <div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:13px;font-weight:600;">Truckload (TL)</span><span style="font-size:13px;font-weight:700;">${cm.tlPct}%</span></div>
                  <input type="range" min="0" max="100" value="${cm.tlPct}" data-cm-key="${escapeAttr(k)}" data-cm-mode="tlPct" style="width:100%;accent-color:var(--ies-blue);">
                </div>
                <div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:13px;font-weight:600;">Less-Than-Truckload (LTL)</span><span style="font-size:13px;font-weight:700;">${cm.ltlPct}%</span></div>
                  <input type="range" min="0" max="100" value="${cm.ltlPct}" data-cm-key="${escapeAttr(k)}" data-cm-mode="ltlPct" style="width:100%;accent-color:var(--ies-blue);">
                </div>
                <div>
                  <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:13px;font-weight:600;">Parcel</span><span style="font-size:13px;font-weight:700;">${cm.parcelPct}%</span></div>
                  <input type="range" min="0" max="100" value="${cm.parcelPct}" data-cm-key="${escapeAttr(k)}" data-cm-mode="parcelPct" style="width:100%;accent-color:var(--ies-blue);">
                </div>
              </div>
              <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--ies-gray-200);font-size:12px;font-weight:600;text-align:right;">
                Total: ${total}%
                ${total !== 100 ? '<span style="color:var(--ies-orange);margin-left:8px;">Must equal 100%</span>' : '<span style="color:#22c55e;margin-left:8px;">&#x2713;</span>'}
              </div>
            </div>`;
        }).join('');
        return `
          <div style="margin-top:24px;">
            <h3 class="text-section" style="margin:0 0 8px;">Channel-specific modes</h3>
            <div style="font-size:12px;color:var(--ies-gray-500);line-height:1.5;margin-bottom:8px;">
              Phase 4 of volumes-as-nucleus &mdash; per-channel modeMix overrides. assignDemand looks up each demand's channelKey and uses that channel's mix; demands without a channelKey fall back to the project mix above.
            </div>
            ${cards}
          </div>`;
      })()}
    </div>
  `;

  // Balance Mode Mix is a section-local action (was in the old Tools panel).
  el.querySelector('[data-action="balance-mode-mix"]')?.addEventListener('click', () => {
    balanceModeMix();
    markDirty();
  });

  // Bind project-level sliders (data-key on input, but skip the per-channel ones).
  el.querySelectorAll('input[type="range"][data-key]').forEach(input => {
    input.addEventListener('input', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.key;
      const val = parseInt(/** @type {HTMLInputElement} */ (e.target).value);
      modeMix[key] = val;
      markDirty();  // 2026-04-21 audit: was missing — Run button stayed
                    // "✓ Results current" after mix slider moved.
      renderModeMix(el);
    });
  });

  // Phase 4 — bind per-channel mode sliders.
  el.querySelectorAll('input[type="range"][data-cm-key]').forEach(input => {
    input.addEventListener('input', (e) => {
      const k = /** @type {HTMLInputElement} */ (e.target).dataset.cmKey;
      const mode = /** @type {HTMLInputElement} */ (e.target).dataset.cmMode;
      const val = parseInt(/** @type {HTMLInputElement} */ (e.target).value);
      if (!channelModes[k]) channelModes[k] = { tlPct: 0, ltlPct: 0, parcelPct: 0 };
      channelModes[k][mode] = val;
      markDirty();
      renderModeMix(el);
    });
  });

  // Phase 4 — Reset-to-project-mix per channel.
  el.querySelectorAll('[data-cm-reset]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const k = /** @type {HTMLElement} */ (e.currentTarget).dataset.cmReset;
      channelModes[k] = { tlPct: modeMix.tlPct, ltlPct: modeMix.ltlPct, parcelPct: modeMix.parcelPct };
      markDirty();
      renderModeMix(el);
    });
  });

}

function renderRateCardEditor() {
  const breaks = (rateCard.ltlWeightBreaks && rateCard.ltlWeightBreaks.length === 6)
    ? rateCard.ltlWeightBreaks
    : calc.DEFAULT_RATES.ltlWeightBreaks;
  const baseRow = (rateCard.ltlBreakRates && rateCard.ltlBreakRates.length === 6)
    ? rateCard.ltlBreakRates
    : (rateCard.ltlBreakRates && rateCard.ltlBreakRates.length === 5)
      ? [...rateCard.ltlBreakRates, calc.DEFAULT_RATES.ltlBreakRates[5]]  // legacy 5-break extends to 6
      : calc.DEFAULT_RATES.ltlBreakRates;
  const discountPct = Number.isFinite(rateCard.ltlDiscountPct) ? rateCard.ltlDiscountPct : calc.DEFAULT_RATES.ltlDiscountPct;
  const minCharge = Number.isFinite(rateCard.ltlMinCharge) ? rateCard.ltlMinCharge : calc.DEFAULT_RATES.ltlMinCharge;
  const regionMatrix = rateCard.ltlRegionMatrix || calc.DEFAULT_LTL_REGION_MATRIX;

  // Derived 18-class × 6-weight matrix from base row × NMFC multipliers.
  // Per-cell overrides (sparse map keyed `${classCode}-${weightBreakIdx}`) win
  // over the formula and skip the class multiplier — user-edited cells become
  // the final $/CWT rate for that (class, weight-break) pair.
  const overrides = rateCard.ltlClassMatrixOverrides || {};
  const derived = calc.deriveClassWeightMatrix(baseRow, undefined, overrides);

  const breakLabels = breaks.map((wb, i) => {
    const prev = i === 0 ? 0 : breaks[i - 1];
    return i === 0 ? `<${wb.toLocaleString()}` : `${prev.toLocaleString()}–${wb.toLocaleString()}`;
  });
  const tierNotes = ['min/short-zone', 'class-avg base', 'class-avg mid', 'LTL typical', 'heavy LTL', 'partial-TL crossover'];

  return `
    <h3 class="text-section" style="margin-bottom:8px;">Rate Card
      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="reset-rate-card" style="font-size:10px;padding:3px 8px;margin-left:10px;vertical-align:middle;">↻ Reset to defaults</button>
    </h3>

    <!-- Synthetic-tariff disclaimer banner -->
    <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#78350f;line-height:1.5;">
      <div style="font-weight:700;margin-bottom:4px;">⚠ Synthetic tariff — replace with contract rates before quoting</div>
      Defaults are calibrated to public LTL rate-base ranges (CzarLite-style: $20–$50/CWT class-100 base, 30–50% mid-shipper discount off published, 10–18% FSC). No real carrier rate base is freely published. Sources:
      <a href="https://hatfieldandassociates.com/which-ltl-rate-base-is-right-for-you-understanding-czarlite-carrier-tariffs-and-more/" target="_blank" rel="noopener" style="color:#78350f;text-decoration:underline;">Hatfield &amp; Associates</a> ·
      <a href="https://www.freightwisellc.com/2019-7-1-the-value-of-a-standardized-rate-base/" target="_blank" rel="noopener" style="color:#78350f;text-decoration:underline;">FreightWise</a> ·
      <a href="https://www.translogisticsinc.com/blog/ltl-jargon" target="_blank" rel="noopener" style="color:#78350f;text-decoration:underline;">Trans Logistics</a>.
    </div>

    <!-- Rate-card scalars -->
    <div class="hub-card" style="margin-bottom:16px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 20px;">
        ${renderInput('TL Rate per Mile', 'tlRatePerMile', rateCard.tlRatePerMile, '$')}
        ${renderInput('LTL Base Rate ($/CWT)', 'ltlBaseRate', rateCard.ltlBaseRate, '$')}
        ${renderInput('Fuel Surcharge', 'fuelSurcharge', (rateCard.fuelSurcharge * 100).toFixed(0), '%')}
        ${renderInput('Discount off Tariff', 'ltlDiscountPct', discountPct, '%')}
        ${renderInput('Min Charge', 'ltlMinCharge', minCharge, '$')}
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--ies-gray-500);line-height:1.5;">
        Discount applies to the tariff before FSC. Min Charge is the absolute floor per shipment (typical industry $90–$120). FSC is carrier-set; current public benchmark range is 10–18%.
      </div>
    </div>

    <!-- Class-100 base weight-break row (the canonical editable row; other classes derive from this) -->
    <h3 class="text-section" style="margin:18px 0 10px;">LTL Class-100 Base Tariff
      <span style="font-size:11px;font-weight:normal;color:var(--ies-gray-500);margin-left:8px;">$/CWT by weight tier — other classes derive via NMFC multipliers</span>
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
          ${breaks.map((wb, i) => `
            <tr>
              <td style="padding:6px 8px;"><strong>${breakLabels[i]}</strong></td>
              <td style="text-align:right;padding:6px 8px;">
                <span style="color:var(--ies-gray-400);">$</span>
                <input type="number" step="0.25" min="0" value="${baseRow[i]}" data-ltl-break-idx="${i}" style="width:75px;text-align:right;" />
              </td>
              <td style="color:var(--ies-gray-500);font-size:11px;">${tierNotes[i] || ''}</td>
            </tr>
          `).join('')}
          <tr>
            <td style="padding:6px 8px;color:var(--ies-gray-500);">≥ ${breaks.slice(-1)[0].toLocaleString()}</td>
            <td style="text-align:right;padding:6px 8px;color:var(--ies-gray-400);">— top tier rate —</td>
            <td style="color:var(--ies-gray-400);"></td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);">
        Rates cascade — engine uses the rate at or below shipment weight. Edit a row above to shift the entire 18-class derived matrix.
      </div>
    </div>

    <!-- Derived 18-class × 6-weight matrix (read-only preview) -->
    <details style="margin-top:14px;">
      <summary style="cursor:pointer;font-size:12px;color:var(--ies-gray-600);font-weight:600;padding:6px 0;">
        ▸ Show full 18-class derived matrix (108 cells, click any cell to override)
      </summary>
      <div class="hub-card" style="margin-top:8px;overflow-x:auto;">
        <table style="width:100%;font-size:11px;border-collapse:collapse;">
          <thead>
            <tr style="background:var(--ies-gray-50);">
              <th style="text-align:left;padding:5px 8px;border:1px solid var(--ies-gray-200);">NMFC Class</th>
              <th style="text-align:right;padding:5px 6px;border:1px solid var(--ies-gray-200);">Mult</th>
              ${breakLabels.map(l => `<th style="text-align:right;padding:5px 6px;border:1px solid var(--ies-gray-200);font-weight:600;">${l}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${calc.NMFC_CLASS_CODES.map(code => {
              const row = derived[code] || [];
              const mult = calc.NMFC_CLASS_MULTIPLIERS[code] ?? 1.0;
              const isBaseline = code === 100;
              return `<tr style="${isBaseline ? 'background:#eff6ff;font-weight:600;' : ''}">
                <td style="padding:4px 8px;border:1px solid var(--ies-gray-200);">${code}${isBaseline ? ' ★' : ''}</td>
                <td style="padding:4px 6px;border:1px solid var(--ies-gray-200);text-align:right;color:var(--ies-gray-500);">${mult.toFixed(2)}×</td>
                ${row.map((r, i) => {
                  const key = `${code}-${i}`;
                  const isOverride = Object.prototype.hasOwnProperty.call(overrides, key) && Number.isFinite(overrides[key]);
                  return `<td style="padding:2px 4px;border:1px solid var(--ies-gray-200);text-align:right;${isOverride ? 'background:#fef3c7;' : ''}">
                    <span style="display:inline-flex;align-items:center;gap:3px;justify-content:flex-end;">
                      <span style="font-size:10px;color:var(--ies-gray-500);">$</span>
                      <input type="number" step="0.01" min="0" value="${r.toFixed(2)}"
                        data-class-code="${code}" data-break-idx="${i}"
                        title="${isOverride ? 'Override — click ↺ to revert to formula' : 'Click to override this cell ($/CWT)'}"
                        style="width:54px;text-align:right;font-size:11px;padding:2px 4px;${isOverride ? 'font-weight:700;color:#92400e;' : ''}" />
                      ${isOverride ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="reset-class-cell" data-class-code="${code}" data-break-idx="${i}" style="font-size:9px;padding:1px 4px;line-height:1;" title="Reset to formula">↺</button>` : ''}
                    </span>
                  </td>`;
                }).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);">
          ★ baseline (class 100). Per-class rate = class-100 rate × NMFC multiplier. Edit the base tariff above to recalculate every cell, or override an individual cell directly (overridden cells show in <span style="background:#fef3c7;padding:0 4px;border-radius:2px;">amber</span> and skip the class multiplier — the override IS the final $/CWT rate). Click ↺ to revert a cell to the formula.
        </div>
      </div>
    </details>

    <!-- 5x5 region-pair multiplier matrix -->
    <h3 class="text-section" style="margin:18px 0 10px;">LTL Region-Pair Multipliers
      <span style="font-size:11px;font-weight:normal;color:var(--ies-gray-500);margin-left:8px;">5×5 origin → destination grid (US census super-regions)</span>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="reset-region-matrix" style="font-size:10px;padding:3px 8px;margin-left:10px;vertical-align:middle;">↻ Reset matrix</button>
    </h3>
    <div class="hub-card">
      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <thead>
          <tr style="background:var(--ies-gray-50);">
            <th style="text-align:left;padding:6px 8px;border:1px solid var(--ies-gray-200);">Origin ↓ / Dest →</th>
            ${calc.REGION_CODES.map(d => `<th style="text-align:center;padding:6px 8px;border:1px solid var(--ies-gray-200);font-weight:700;">${d}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${calc.REGION_CODES.map(o => `
            <tr>
              <td style="padding:6px 8px;border:1px solid var(--ies-gray-200);font-weight:700;background:var(--ies-gray-50);">${o}</td>
              ${calc.REGION_CODES.map(d => {
                const v = (regionMatrix[o] && Number.isFinite(regionMatrix[o][d])) ? regionMatrix[o][d] : 1.0;
                const isDiag = o === d;
                return `<td style="padding:4px 6px;border:1px solid var(--ies-gray-200);text-align:center;${isDiag ? 'background:#f0fdf4;' : ''}">
                  <input type="number" step="0.01" min="0" value="${v.toFixed(2)}" data-region-orig="${o}" data-region-dest="${d}" style="width:55px;text-align:right;font-size:11px;padding:2px 4px;" />
                </td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);line-height:1.5;">
        Diagonal (same-region, green) defaults to <b>0.95×</b> (intra-region density discount). Adjacent pairs <b>1.00×</b>. Cross-country pairs (NE↔W, NE↔SW, SE↔W) <b>1.18×</b> (long-haul interline premium).
        Origin/destination region is auto-derived from facility &amp; demand lat/lng using US census super-regions (NE, SE, MW, SW, W).
      </div>
    </div>

    <!-- NET-C1 — Lane Rate Overrides (sparse list applied OD-pair-first by resolveLaneRates) -->
    <h3 class="text-section" style="margin:18px 0 10px;">Lane Rate Overrides
      <span style="font-size:11px;font-weight:normal;color:var(--ies-gray-500);margin-left:8px;">${(rateCard.laneRates || []).length} lane${(rateCard.laneRates || []).length === 1 ? '' : 's'} overriding base card</span>
      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="add-lane-override" style="font-size:10px;padding:3px 8px;margin-left:10px;vertical-align:middle;">+ Add Lane Override</button>
    </h3>
    <div class="hub-card">
      <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:10px;line-height:1.5;">
        First matching row wins — put the most-specific entries (origin+destination IDs) above wildcard or region-only rows.
        Use <code style="background:var(--ies-gray-100);padding:1px 4px;border-radius:2px;">*</code> or leave blank to wildcard a key. Override fields ($/mi, $/CWT, FSC, Discount) are applied on top of the base rate card; blank = inherit.
      </div>
      ${(rateCard.laneRates || []).length === 0 ? `
        <div style="padding:18px;text-align:center;color:var(--ies-gray-400);font-size:12px;font-style:italic;border:1px dashed var(--ies-gray-200);border-radius:6px;">
          No lane overrides yet. Click "+ Add Lane Override" to define a custom rate for a specific OD pair, region pair, or any combination.
        </div>
      ` : `
        <table style="width:100%;font-size:11px;border-collapse:collapse;">
          <thead>
            <tr style="background:var(--ies-gray-50);">
              <th style="text-align:left;padding:6px;border:1px solid var(--ies-gray-200);">Origin ID</th>
              <th style="text-align:left;padding:6px;border:1px solid var(--ies-gray-200);">Dest ID</th>
              <th style="text-align:left;padding:6px;border:1px solid var(--ies-gray-200);">O Region</th>
              <th style="text-align:left;padding:6px;border:1px solid var(--ies-gray-200);">D Region</th>
              <th style="text-align:right;padding:6px;border:1px solid var(--ies-gray-200);">TL $/mi</th>
              <th style="text-align:right;padding:6px;border:1px solid var(--ies-gray-200);">LTL $/CWT</th>
              <th style="text-align:right;padding:6px;border:1px solid var(--ies-gray-200);">FSC %</th>
              <th style="text-align:right;padding:6px;border:1px solid var(--ies-gray-200);">Disc %</th>
              <th style="text-align:center;padding:6px;border:1px solid var(--ies-gray-200);"></th>
            </tr>
          </thead>
          <tbody>
            ${rateCard.laneRates.map((lr, i) => {
              const facOpts = ['<option value=""></option>', '<option value="*">*</option>'].concat(
                facilities.map(f => `<option value="${f.id}"${lr.originId === f.id ? ' selected' : ''}>${f.id} — ${f.name || f.city || ''}</option>`)
              ).join('');
              // NET-C1 — destId is typically a demand point (customer), but allow
              // facilities too for inter-DC override scenarios. Group as optgroups.
              const demOpts = demands.map(dd => `<option value="${dd.id}"${lr.destId === dd.id ? ' selected' : ''}>${dd.id}${dd.zip3 ? ` — ZIP ${dd.zip3}` : ''}</option>`).join('');
              const facDestOpts = facilities.map(f => `<option value="${f.id}"${lr.destId === f.id ? ' selected' : ''}>${f.id} — ${f.name || f.city || ''}</option>`).join('');
              const facOptsDest = `<option value=""></option><option value="*">*</option><optgroup label="Demand points">${demOpts}</optgroup><optgroup label="Facilities">${facDestOpts}</optgroup>`;
              const regOpts = ['<option value=""></option>', '<option value="*">*</option>'].concat(
                calc.REGION_CODES.map(r => `<option value="${r}"${lr.originRegion === r ? ' selected' : ''}>${r}</option>`)
              ).join('');
              const regOptsDest = ['<option value=""></option>', '<option value="*">*</option>'].concat(
                calc.REGION_CODES.map(r => `<option value="${r}"${lr.destRegion === r ? ' selected' : ''}>${r}</option>`)
              ).join('');
              return `<tr>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);">
                  <select data-lane-idx="${i}" data-lane-key="originId" style="width:100%;font-size:10px;padding:2px;">${facOpts}</select>
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);">
                  <select data-lane-idx="${i}" data-lane-key="destId" style="width:100%;font-size:10px;padding:2px;">${facOptsDest}</select>
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);">
                  <select data-lane-idx="${i}" data-lane-key="originRegion" style="width:100%;font-size:10px;padding:2px;">${regOpts}</select>
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);">
                  <select data-lane-idx="${i}" data-lane-key="destRegion" style="width:100%;font-size:10px;padding:2px;">${regOptsDest}</select>
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);text-align:right;">
                  <input type="number" step="0.05" min="0" value="${lr.tlRatePerMile != null ? lr.tlRatePerMile : ''}" data-lane-idx="${i}" data-lane-key="tlRatePerMile" placeholder="—" style="width:60px;font-size:11px;padding:2px 4px;text-align:right;">
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);text-align:right;">
                  <input type="number" step="0.50" min="0" value="${lr.ltlBaseRate != null ? lr.ltlBaseRate : ''}" data-lane-idx="${i}" data-lane-key="ltlBaseRate" placeholder="—" style="width:60px;font-size:11px;padding:2px 4px;text-align:right;">
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);text-align:right;">
                  <input type="number" step="0.5" min="0" max="100" value="${lr.fuelSurcharge != null ? (lr.fuelSurcharge * 100).toFixed(1) : ''}" data-lane-idx="${i}" data-lane-key="fuelSurcharge" placeholder="—" style="width:50px;font-size:11px;padding:2px 4px;text-align:right;">
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);text-align:right;">
                  <input type="number" step="1" min="0" max="100" value="${lr.ltlDiscountPct != null ? lr.ltlDiscountPct : ''}" data-lane-idx="${i}" data-lane-key="ltlDiscountPct" placeholder="—" style="width:50px;font-size:11px;padding:2px 4px;text-align:right;">
                </td>
                <td style="padding:3px 4px;border:1px solid var(--ies-gray-200);text-align:center;">
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="delete-lane" data-lane-idx="${i}" style="font-size:10px;padding:2px 6px;line-height:1;">✕</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}


// 2026-04-27 EVE2 (NO-SCOPE-6/4/5): Rate Card is now its own Parameters
// sub-tab. Apply Market Rates + Upload Rate Card CSV are inline section
// actions; previously they lived in the right-rail Tools panel (deleted).
function renderRateCardPhase(el) {
  el.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
        <div>
          <h3 class="text-section" style="margin:0;">Rate Card</h3>
          <div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">TL per-mile · LTL class-100 tariff + multipliers + 5×5 region matrix · lane overrides · parcel zones.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="apply-market-rates" title="Pull latest spot/contract rates from market data and apply to rate card" style="font-size:11px;padding:5px 10px;">💲 Apply Market Rates</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="upload-rates-csv" title="Upload a rate-card CSV (TL/LTL columns)" style="font-size:11px;padding:5px 10px;">📤 Upload Rate Card CSV</button>
        </div>
      </div>
      ${renderRateCardEditor()}
    </div>
  `;

  // Section actions
  el.querySelector('[data-action="apply-market-rates"]')?.addEventListener('click', () => {
    applyMarketRates();
    markDirty();
  });
  el.querySelector('[data-action="upload-rates-csv"]')?.addEventListener('click', () => {
    document.getElementById('netopt-csv-upload')?.click();
  });

  // Bind rate-card scalars (TL $/mi, LTL Base $/CWT, FSC %, Discount %, Min Charge $)
  el.querySelectorAll('input[data-rate]').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.rate;
      let val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (key === 'fuelSurcharge') val = val / 100;
      rateCard[key] = val;
      markDirty();
      // Re-render so derived matrix preview reflects the new base value.
      renderRateCardPhase(el);
    });
  });

  // Bind class-100 base row (6 weight breaks)
  el.querySelectorAll('input[data-ltl-break-idx]').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset.ltlBreakIdx);
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      // Normalize: scenarios saved with the legacy 5-break shape get extended to 6 on first edit.
      if (!Array.isArray(rateCard.ltlBreakRates) || rateCard.ltlBreakRates.length < 6) {
        rateCard.ltlBreakRates = [...calc.DEFAULT_RATES.ltlBreakRates];
        rateCard.ltlWeightBreaks = [...calc.DEFAULT_RATES.ltlWeightBreaks];
      }
      rateCard.ltlBreakRates[idx] = val;
      markDirty();
      renderRateCardPhase(el);
    });
  });

  // Bind per-cell class-matrix overrides (click any cell, type a $ value)
  // Storing on rateCard.ltlClassMatrixOverrides (sparse map keyed `${classCode}-${weightBreakIdx}`).
  // ltlCost() in calc.js consults this map and uses the override DIRECTLY as
  // the final $/CWT rate (skipping the class multiplier) when present.
  el.querySelectorAll('input[data-class-code][data-break-idx]').forEach(input => {
    input.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const code = parseInt(t.dataset.classCode, 10);
      const idx = parseInt(t.dataset.breakIdx, 10);
      const val = parseFloat(t.value);
      if (!Number.isFinite(val) || val < 0) return;
      if (!rateCard.ltlClassMatrixOverrides) rateCard.ltlClassMatrixOverrides = {};
      // If user typed exactly the formula value, treat it as a no-op (don't
      // create a phantom override that prevents recalculation when the base
      // row changes).
      const baseRow = rateCard.ltlBreakRates && rateCard.ltlBreakRates.length === 6
        ? rateCard.ltlBreakRates : calc.DEFAULT_RATES.ltlBreakRates;
      const mult = calc.NMFC_CLASS_MULTIPLIERS[code] ?? 1.0;
      const formula = +(baseRow[idx] * mult).toFixed(2);
      if (Math.abs(val - formula) < 0.005) {
        delete rateCard.ltlClassMatrixOverrides[`${code}-${idx}`];
      } else {
        rateCard.ltlClassMatrixOverrides[`${code}-${idx}`] = val;
      }
      markDirty();
      renderRateCardPhase(el);
    });
  });

  // Per-cell reset (only present on overridden cells)
  el.querySelectorAll('button[data-action="reset-class-cell"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.currentTarget);
      const code = t.dataset.classCode;
      const idx = t.dataset.breakIdx;
      if (rateCard.ltlClassMatrixOverrides) {
        delete rateCard.ltlClassMatrixOverrides[`${code}-${idx}`];
      }
      markDirty();
      renderRateCardPhase(el);
    });
  });

  // Bind 5x5 LTL region-pair matrix
  el.querySelectorAll('input[data-region-orig]').forEach(input => {
    input.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const orig = t.dataset.regionOrig;
      const dest = t.dataset.regionDest;
      const val = parseFloat(t.value);
      if (!Number.isFinite(val) || val < 0) return;
      if (!rateCard.ltlRegionMatrix) {
        rateCard.ltlRegionMatrix = JSON.parse(JSON.stringify(calc.DEFAULT_LTL_REGION_MATRIX));
      }
      rateCard.ltlRegionMatrix[orig] = rateCard.ltlRegionMatrix[orig] || {};
      rateCard.ltlRegionMatrix[orig][dest] = val;
      markDirty();
    });
  });

  // Reset region matrix to defaults
  el.querySelector('[data-action="reset-region-matrix"]')?.addEventListener('click', () => {
    rateCard.ltlRegionMatrix = JSON.parse(JSON.stringify(calc.DEFAULT_LTL_REGION_MATRIX));
    markDirty();
    renderRateCardPhase(el);
  });

  // Reset rate card to synthetic-tariff defaults
  el.querySelector('[data-action="reset-rate-card"]')?.addEventListener('click', async () => {
    if (!(await showConfirm('Reset all rate-card values to the synthetic-tariff defaults? This will overwrite TL/LTL/FSC/discount/min charge, the class-100 weight-break row, and the region matrix.'))) return;
    rateCard = { ...calc.DEFAULT_RATES, ltlRegionMatrix: JSON.parse(JSON.stringify(calc.DEFAULT_LTL_REGION_MATRIX)) };
    markDirty();
    renderRateCardPhase(el);
  });

  // ─────────────────────────────────────────────────────────────
  // NET-C1 Lane Rate Overrides — bindings
  // ─────────────────────────────────────────────────────────────
  el.querySelector('[data-action="add-lane-override"]')?.addEventListener('click', () => {
    if (!Array.isArray(rateCard.laneRates)) rateCard.laneRates = [];
    rateCard.laneRates.push({});
    markDirty();
    renderRateCardPhase(el);
  });

  el.querySelectorAll('button[data-action="delete-lane"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(/** @type {HTMLElement} */ (e.currentTarget).dataset.laneIdx, 10);
      if (Array.isArray(rateCard.laneRates) && idx >= 0 && idx < rateCard.laneRates.length) {
        rateCard.laneRates.splice(idx, 1);
        markDirty();
        renderRateCardPhase(el);
      }
    });
  });

  el.querySelectorAll('select[data-lane-idx]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const t = /** @type {HTMLSelectElement} */ (e.currentTarget);
      const idx = parseInt(t.dataset.laneIdx, 10);
      const key = t.dataset.laneKey;
      if (!Array.isArray(rateCard.laneRates) || !rateCard.laneRates[idx]) return;
      const v = t.value;
      if (v === '') {
        delete rateCard.laneRates[idx][key];
      } else {
        rateCard.laneRates[idx][key] = v;
      }
      markDirty();
    });
  });

  el.querySelectorAll('input[data-lane-idx]').forEach(input => {
    input.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.currentTarget);
      const idx = parseInt(t.dataset.laneIdx, 10);
      const key = t.dataset.laneKey;
      if (!Array.isArray(rateCard.laneRates) || !rateCard.laneRates[idx]) return;
      const raw = t.value.trim();
      if (raw === '') {
        delete rateCard.laneRates[idx][key];
      } else {
        const v = parseFloat(raw);
        if (!Number.isFinite(v) || v < 0) return;
        // FSC stored as fraction (0-1); other fields as raw values.
        rateCard.laneRates[idx][key] = (key === 'fuelSurcharge') ? (v / 100) : v;
      }
      markDirty();
      // Re-render header count chip.
      const header = el.querySelector('h3 + .hub-card');
      if (header) renderRateCardPhase(el);
    });
  });
}

/**
 * Rate-card editor — synthetic-tariff banner + scalar inputs (TL/LTL/FSC/discount/min charge)
 * + class-100 base weight-break row + collapsible 18-class derived matrix preview
 * + 5x5 region-pair multiplier grid.
 *
 * No real carrier rate base is published online (CzarLite is licensed; carrier tariffs are
 * proprietary). Defaults are calibrated to industry-typical ranges from public sources
 * cited in the banner. All values overrideable per scenario.
 */

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

  // NET-B5 reset — restore HOS defaults for the 6 transit-day opts only.
  el.querySelector('[data-action="reset-transit-opts"]')?.addEventListener('click', () => {
    serviceConfig.drivingHoursPerDay = 11;
    serviceConfig.onDutyHoursPerDay  = 14;
    serviceConfig.loadHours          = 2;
    serviceConfig.unloadHours        = 2;
    serviceConfig.intermediateStops  = 0;
    serviceConfig.dwellHoursPerStop  = 0;
    markDirty();
    renderServiceConfig(el);
  });
}

// ============================================================
// MAP VIEW
// ============================================================

function renderMap(el) {
  // Run scenario first to get assignments for flow lines
  if (!activeScenario) {
    const result = calc.evaluateScenario('Preview', facilities, demands, modeMix, rateCard, serviceConfig, { channelMixMap: channelModes });
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
          <div style="font-size:13px;color:var(--ies-gray-600);line-height:1.5;margin-bottom:14px;">The optimizer needs demand points before it can produce cost or service-level results. Either pick an industry preset from the Quick-seed bar in the <b>Inputs</b> phase, or open <b>Demand Points</b> and add them manually.</div>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="no-results-go-demand">Go to Demand Points</button>
        </div>`;
      el.querySelector('#no-results-go-demand')?.addEventListener('click', () => {
        activeSection = 'demand';
        activeView = 'setup';
        rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === activeView);
        });
        renderContentView();
      });
      return;
    }
    if (runBlockReason === 'no-open-facilities') {
      const total = facilities.length;
      const hint = total === 0
        ? 'You have no candidate facilities yet. Open <b>Inputs → Facilities</b> and click <b>🎯 Find Optimal Locations</b> to seed candidates from a k-means cluster of your demand, or add them manually.'
        : `You have ${total} facilit${total === 1 ? 'y' : 'ies'} on the list but none are <b>Active</b>. Tick the Active checkbox on at least one row in <b>Inputs → Facilities</b>, or click <b>🎯 Find Optimal Locations</b> in the Facilities header to add more candidates.`;
      el.innerHTML = `
        <div class="hub-card" style="padding:24px;background:#fffbeb;border:1px solid #fde68a;">
          <div style="display:inline-flex;align-items:center;gap:6px;background:#fef3c7;color:#92400e;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;margin-bottom:12px;">
            <span>⚠</span><span>Run blocked</span>
          </div>
          <div style="font-size:14px;font-weight:700;color:var(--ies-navy);margin-bottom:6px;">No active facilities to evaluate</div>
          <div style="font-size:13px;color:var(--ies-gray-600);line-height:1.5;margin-bottom:14px;">${hint}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="hub-btn hub-btn-sm hub-btn-primary" id="no-results-go-facilities" style="display:inline-flex;align-items:center;gap:6px;">→ Open Inputs · Facilities</button>
          </div>
        </div>`;
      el.querySelector('#no-results-go-facilities')?.addEventListener('click', () => {
        activeSection = 'facilities';
        activeView = 'setup';
        rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === activeView);
        });
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
        renderContentView();
      });
      el.querySelector('#no-results-go-fix-dem')?.addEventListener('click', () => {
        activeSection = 'demand'; activeView = 'setup';
        rootEl?.querySelectorAll('#no-view-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === activeView));
        renderContentView();
      });
      return;
    }
    el.innerHTML = `<div class="hub-card"><p class="text-body text-muted">Run a scenario first to see results here.</p></div>`;
    return;
  }

  const s = activeScenario;
  const slaColor = s.serviceLevel >= 95 ? '#22c55e' : s.serviceLevel >= 90 ? '#f59e0b' : '#ef4444';

  el.innerHTML = `
    <div>
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

      <!-- Cost Breakdown (unified stacked bar — 2026-04-25) -->
      ${costBreakdownBar(s.costBreakdown, s.totalCost)}

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

/**
 * Unified Cost Breakdown card with a single stacked horizontal bar.
 * Replaces the 3-card grid that made small slices (transport at 0.9%) read
 * as buried metrics rather than as part of one whole.
 *
 * Layout:
 *   - top row: dollar totals + percent for each bucket (3 columns)
 *   - middle: a single stacked bar with 3 segments (Facility / Transport / Handling)
 *   - bottom: legend dots + tooltip on Handling.
 *
 * 2026-04-25 — driven by Brock UX feedback ('should those three tiles be
 * combined into a singular graphic?').
 */
function costBreakdownBar(breakdown, total) {
  const fac = Number(breakdown.facility) || 0;
  const trn = Number(breakdown.transport) || 0;
  const hnd = Number(breakdown.handling) || 0;
  const safeTot = total > 0 ? total : (fac + trn + hnd) || 1;
  const facPct = (fac / safeTot) * 100;
  const trnPct = (trn / safeTot) * 100;
  const hndPct = (hnd / safeTot) * 100;
  const swatch = (color) => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px;vertical-align:middle;"></span>`;
  const COLOR_FAC = '#1d4ed8';   // navy
  const COLOR_TRN = '#0891b2';   // teal
  const COLOR_HND = '#f59e0b';   // amber
  const handlingTip = 'Handling = Σ (annualDemand × facility.variableCost) across all assigned demand. Variable cost is per-unit handling, set on each facility row (defaults $2.80–$4.00/unit on the demo network).';
  const cell = (label, amt, pct, color, tip) => `
    <div style="flex:1;padding:0 12px;border-left:1px solid var(--ies-gray-200);">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);margin-bottom:6px;">${swatch(color)}${label}${tip ? ` <span style=\"opacity:0.5;cursor:help;\" title=\"${tip.replace(/\"/g, '&quot;')}\">ⓘ</span>` : ''}</div>
      <div style="font-size:22px;font-weight:800;color:var(--ies-navy);line-height:1;">${calc.formatCurrency(amt, { compact: true })}</div>
      <div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">${pct.toFixed(1)}% of total</div>
    </div>`;
  return `
    <div class="hub-card" style="padding:18px;margin-bottom:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-500);letter-spacing:0.5px;">Cost Breakdown</div>
        <div style="font-size:12px;color:var(--ies-gray-500);">${calc.formatCurrency(safeTot, { compact: true })} total</div>
      </div>
      <div style="display:flex;align-items:flex-start;margin-bottom:14px;">
        <div style="flex:1;padding:0 12px 0 0;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ies-gray-400);margin-bottom:6px;">${swatch(COLOR_FAC)}Facility</div>
          <div style="font-size:22px;font-weight:800;color:var(--ies-navy);line-height:1;">${calc.formatCurrency(fac, { compact: true })}</div>
          <div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">${facPct.toFixed(1)}% of total</div>
        </div>
        ${cell('Transportation', trn, trnPct, COLOR_TRN)}
        ${cell('Handling', hnd, hndPct, COLOR_HND, handlingTip)}
      </div>
      <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--ies-gray-200);" title="Facility ${facPct.toFixed(1)}% • Transport ${trnPct.toFixed(1)}% • Handling ${hndPct.toFixed(1)}%">
        ${facPct > 0 ? `<div style="width:${facPct}%;background:${COLOR_FAC};"></div>` : ''}
        ${trnPct > 0 ? `<div style="width:${trnPct}%;background:${COLOR_TRN};"></div>` : ''}
        ${hndPct > 0 ? `<div style="width:${hndPct}%;background:${COLOR_HND};"></div>` : ''}
      </div>
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
        <p class="text-body text-muted">Set <b>Max DCs</b> above and run the k-sweep to populate this comparison. The optimizer auto-picks brute-force enumeration when the search space is small (provably optimal) and a multi-start heuristic otherwise.</p>
      </div>
    `;
    return;
  } else {
    renderScenarioComparison(el);
  }
}


/** Small chip describing how the most recent optimization was solved. */
function renderOptimizationChip(meta) {
  if (!meta) return '';
  const isExact = meta.algorithm === 'exhaustive';
  const bg = isExact ? '#dbeafe' : '#fef3c7';
  const fg = isExact ? '#1e40af' : '#92400e';
  const kCap = meta.kCap;
  const totalCombos = (meta.totalCombos || 0).toLocaleString();
  const label = isExact
    ? `Optimal · tried all ${totalCombos} combinations`
    : (meta.reason === 'too_large' || meta.reason === 'exhaustive_too_large'
        ? `Best found · heuristic (${totalCombos} combos exceeded the 10k exhaustive ceiling)`
        : `Best found · multi-start heuristic`);
  const title = isExact
    ? `Exhaustive enumeration: tried every C(n,k) subset for k=1..${kCap}, picked the lowest-cost one. Provably optimal within the candidate set.`
    : `Multi-start swap-improvement heuristic. Fast on large candidate sets but not guaranteed optimal.`;
  return `<span title="${title}" style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;background:${bg};color:${fg};">${label}</span>`;
}
function renderMultiDCComparison(el) {
  const rec = calc.recommendOptimalDCs(comparisonResults, serviceConfig);

  el.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <h3 class="text-section" style="margin:0;">DC Network Comparison (1-${_optimizationMeta?.kCap || comparisonResults.length} facilities)</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          ${_optimizationMeta ? renderOptimizationChip(_optimizationMeta) : ''}
          <span style="font-size:11px;color:var(--ies-gray-400);">${comparisonResults.length} scenario(s)</span>
        </div>
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
            ${(() => {
              // Pull SLA target from serviceConfig once so we can flag rows
              // that fall short. Falls back to the historical 95/90/below
              // gradient when no target is set.
              const slaTarget = Number(serviceConfig?.targetServicePct);
              const haveTarget = Number.isFinite(slaTarget) && slaTarget > 0;
              return comparisonResults.map((s, i) => {
                const baseline = comparisonResults[0].totalCost;
                const savings = baseline - s.totalCost;
                const isRecommended = i === rec.recommendedIdx;
                const failsSLA = haveTarget && Number(s.serviceLevel) < slaTarget - 1e-6;
                const rowBg = isRecommended ? '#f0fdf4' : (failsSLA ? '#fef9f9' : 'transparent');
                const rowOpacity = failsSLA && !isRecommended ? '0.65' : '1';
                const slLevel = Number(s.serviceLevel) || 0;
                const slColor = haveTarget
                  ? (slLevel >= slaTarget ? '#22c55e' : slLevel >= slaTarget - 5 ? '#f59e0b' : '#ef4444')
                  : (slLevel >= 95 ? '#22c55e' : slLevel >= 90 ? '#f59e0b' : '#ef4444');
                let statusBadge = '';
                if (isRecommended) {
                  statusBadge = `<span style="display:inline-block;padding:4px 12px;background:#22c55e;color:#fff;border-radius:12px;font-size:11px;font-weight:700;">RECOMMENDED</span>`;
                } else if (failsSLA) {
                  statusBadge = `<span title="Service level ${slLevel.toFixed(1)}% is below the ${slaTarget}% target — this network would not meet the SLA constraint and is excluded from the recommendation." style="display:inline-block;padding:4px 10px;background:#fee2e2;color:#991b1b;border-radius:12px;font-size:11px;font-weight:700;">✗ Below SLA</span>`;
                }
                return `
                <tr style="border-bottom:1px solid var(--ies-gray-200);background:${rowBg};opacity:${rowOpacity};">
                  <td style="padding:10px 8px;font-weight:700;color:var(--ies-navy);">${i + 1}</td>
                  <td style="padding:10px 8px;text-align:right;">${calc.formatMiles(s.avgDistance)}</td>
                  <td style="padding:10px 8px;text-align:right;">${calc.formatCurrency(s.costBreakdown.transport, { compact: true })}</td>
                  <td style="padding:10px 8px;text-align:right;">${s.assignments.length > 0 ? (s.assignments.reduce((sum, a) => sum + a.transitDays, 0) / s.assignments.length).toFixed(1) : '—'} days</td>
                  <td style="padding:10px 8px;text-align:right;font-weight:600;color:${slColor};">${calc.formatPct(s.serviceLevel)}</td>
                  <td style="padding:10px 8px;text-align:right;font-weight:700;${savings < 0 ? 'color:#ef4444;' : 'color:#22c55e;'}">${savings >= 0 ? '+' : ''}${calc.formatCurrency(savings, { compact: true })}</td>
                  <td style="padding:10px 8px;text-align:center;">${statusBadge}</td>
                </tr>
              `;
              }).join('');
            })()}
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

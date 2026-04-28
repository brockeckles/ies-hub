/**
 * IES Hub v3 — Fleet Modeler UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Tabs: Lanes, Configuration, Results, Map.
 *
 * @module tools/fleet-modeler/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sM';
import { state } from '../../shared/state.js?v=20260418-sM';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sM';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260429-tc2-most';
import { RunStateTracker } from '../../shared/run-state.js?v=20260419-uE';
import * as calc from './calc.js?v=20260426-s2';
import * as api from './api.js?v=20260418-sM';

// ============================================================
// CHROME v3 — phase + section structure (CM Chrome v3 ripple, step 3 redo)
// ============================================================
const FLEET_GROUPS = [
  { key: 'inputs',     label: 'Inputs',     description: 'Lane mix' },
  { key: 'parameters', label: 'Parameters', description: 'Vehicles, operating costs, rate deck' },
  { key: 'run',        label: 'Run',        description: 'Cost, comparison, sensitivity, map, feasibility' },
];
const FLEET_SECTIONS = [
  // parameters
  { key: 'vehicles',    label: '\u{1F69B} Vehicles',          group: 'parameters' },
  { key: 'operating',   label: '\u{1F4B0} Operating Costs',   group: 'parameters' },
  { key: 'ratedeck',    label: '\u{1F4CB} Rate Deck',         group: 'parameters' },
  // run
  { key: 'cost',        label: '\u{1F4B5} Cost',              group: 'run' },
  { key: 'comparison',  label: '⚖ Comparison',             group: 'run' },
  { key: 'sensitivity', label: '\u{1F4C8} Sensitivity',       group: 'run' },
  { key: 'map',         label: '\u{1F5FA} Route Map',         group: 'run' },
  { key: 'feasibility', label: '⏱ Feasibility',            group: 'run' },
];


// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'lanes' | 'config' | 'results' | 'map'} */
let activePhase = 'inputs';
let paramsSubTab = 'vehicles';
let runSubTab = 'cost';

/** @type {import('./types.js?v=20260418-sM').Lane[]} */
let lanes = [];

/** @type {import('./types.js?v=20260418-sM').VehicleSpec[]} */
let vehicles = calc.DEFAULT_VEHICLES.map(v => ({ ...v }));

/** @type {import('./types.js?v=20260418-sM').FleetConfig} */
let config = { ...calc.DEFAULT_CONFIG };

/** @type {import('./types.js?v=20260418-sM').FleetResult|null} */
let result = null;

/** @type {object|null} */
let mapInstance = null;

/**
 * Carrier rate deck loaded from ref_fleet_carrier_rates.
 * Stays as the raw row array; calc.indexCarrierDeck materialises a
 * vehicleType→rate map at run time.
 * @type {Array<import('./api.js?v=20260418-sM').CarrierRate>}
 */
let carrierRateDeck = [];

// FLE-F1 — sensitivity matrix range controls. Persisted on `config`-adjacent
// state so re-renders preserve user-tuned bounds.
let sensRange = { driverMin: 25, driverMax: 38, dieselMin: 3.25, dieselMax: 4.50, steps: 6 };

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Fleet Modeler.
 * @param {HTMLElement} el
 */
let activeScenarioId = null;
let activeParentCmId = null;

// Run-state tracker — flips the "Calculate Fleet" button between orange and
// the muted "✓ Results current" state based on whether inputs have changed
// since the last calculate.
const runState = new RunStateTracker();
function runStateInputs() {
  return { lanes, vehicles, config };
}
function updateRunButtonState() {
  if (!rootEl) return;
  const btn = rootEl.querySelector('[data-primary-action="fleet-run"]');
  if (!btn) return;
  const s = runState.state(runStateInputs());
  const isClean = s === 'clean';
  btn.classList.toggle('is-clean', isClean);
  btn.setAttribute('data-run-state', s);
  const iconSpan = btn.querySelector('.hub-run-icon');
  const labelSpan = btn.querySelector('span:not(.hub-run-icon):not(.hub-run-shortcut)');
  if (labelSpan) labelSpan.textContent = isClean ? '✓ Results current' : 'Calculate Fleet';
  if (iconSpan) iconSpan.style.display = isClean ? 'none' : '';
  btn.setAttribute('title', isClean
    ? 'Inputs unchanged since the last calculate — fleet results match the current lanes + config. Click to force a re-run.'
    : 'Run the analyzer (Cmd/Ctrl+Enter)');
}

export async function mount(el) {
  rootEl = el;

  // X11: Receive lanes from NetOpt (bus — for the in-session case)
  bus.on('netopt:push-to-fleet', (payload) => applyNetOptHandoff(payload));

  // Brock 2026-04-20: sessionStorage handoff for the NetOpt→Fleet nav case.
  // The bus emit from NetOpt fires before Fleet mounts, so without this
  // the payload was being silently dropped on tool-switch.
  try {
    const pending = sessionStorage.getItem('netopt_pending_push');
    if (pending) {
      const payload = JSON.parse(pending);
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('netopt_pending_push');
        applyNetOptHandoff(payload);
      } else {
        sessionStorage.removeItem('netopt_pending_push');
      }
    }
  } catch (e) { console.warn('[Fleet] Failed to consume NetOpt handoff:', e); }

  await renderLanding();
  bus.emit('fleet:mounted');
}

/**
 * Apply NetOpt push into the module-level lanes array. Shared by both
 * the in-session bus listener and the sessionStorage handoff path.
 */
function applyNetOptHandoff(payload) {
  const pushLanes = payload?.lanes;
  if (!Array.isArray(pushLanes) || pushLanes.length === 0) return;
  lanes = pushLanes.map(l => ({
    id: l.id || 'l' + Date.now() + Math.random(),
    origin: l.origin,
    destination: l.destination,
    weeklyShipments: l.weeklyShipments || 1,
    avgWeightLbs: l.avgWeightLbs || 5000,
    avgCubeFt3: l.avgCubeFt3 || 300,
    distanceMiles: l.distanceMiles || 200,
  }));
  if (typeof showToast === 'function') showToast(`Received ${lanes.length} lanes from Network Optimizer`, 'success');
  if (activePhase === 'inputs' && rootEl?.querySelector('#fm-content')) {
    renderLanes(rootEl.querySelector('#fm-content'));
  }
}

async function renderLanding() {
  if (!rootEl) return;
  await renderScenarioLanding(rootEl, {
    toolName: 'Fleet Modeler',
    toolKey: 'fleet',
    accent: 'var(--ies-teal)',
    list: () => api.listScenarios(),
    getId: (r) => r.id,
    getName: (r) => r.name || r.scenario_data?.name || 'Untitled fleet',
    getUpdated: (r) => r.updated_at || r.created_at,
    getParent: (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id || r.deal_id }),
    getSubtitle: (r) => {
      const d = r.scenario_data || {};
      const nLanes = (d.lanes || []).length;
      const nVeh = (d.vehicles || []).length;
      return nLanes ? `${nLanes} lanes · ${nVeh} vehicle types` : '';
    },
    onNew: () => openEditor(null),
    onOpen: (row) => openEditor(row),
    onDelete: async (row) => { await api.deleteScenario(row.id); },
    onCopy: async (row) => { await api.duplicateScenario(row.id); },
    onLink: async (row, cmId) => { await api.linkToCm(row.id, cmId); },
    onUnlink: async (row) => { await api.unlinkFromCm(row.id); },
    emptyStateHint: 'Size a private fleet from your lane network — vehicles, drivers, fuel, maintenance, ATRI benchmarks, and a 3-way comparison vs dedicated and common carrier.',
  });
}

function openEditor(savedRow) {
  if (!rootEl) return;
  const d = savedRow?.scenario_data || {};
  activePhase = 'inputs';
  paramsSubTab = 'vehicles';
  runSubTab = 'cost';
  // 2026-04-21 audit fix: lanes start EMPTY on new scenarios. Demo lanes
  // still accessible via the "Load Demo Data" button. vehicles catalog stays
  // pre-populated (day-cab / sleeper / box truck with ATRI rates) since it's
  // a reference list every scenario needs, not scenario-specific data.
  lanes = (d.lanes && d.lanes.length) ? d.lanes.map(l => ({ ...l })) : [];
  vehicles = (d.vehicles && d.vehicles.length) ? d.vehicles.map(v => ({ ...v })) : calc.DEFAULT_VEHICLES.map(v => ({ ...v }));
  config = { ...calc.DEFAULT_CONFIG, leaseMode: false, ...(d.config || {}) };
  result = d.result || null;
  activeScenarioId = savedRow?.id || null;
  activeParentCmId = savedRow?.parent_cost_model_id || null;
  // New editor session — reset run-state. If the saved row already has a
  // result, treat the loaded inputs as the clean baseline (saved result was
  // computed against saved inputs).
  runState.reset();
  if (result) runState.markClean(runStateInputs());

  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderContent();
  _refreshFleetKpis();

  rootEl.querySelector('[data-action="fleet-back"]')?.addEventListener('click', async () => {
    // 2026-04-21 audit: NetOpt already guarded its back button; Fleet didn't.
    // If inputs have diverged from the last successful Calculate, warn before
    // jumping to scenarios (user may have unsaved edits).
    const state = runState.state(runStateInputs());
    if (state === 'dirty' && result && !confirm('You have unsaved changes since the last calculate. Leave anyway?')) return;
    await renderLanding();
  });

  // Pull the carrier rate deck in the background; re-render Config if user
  // is already there when it arrives.
  (async () => {
    try {
      carrierRateDeck = await api.listCarrierRates();
    } catch (e) {
      carrierRateDeck = api.DEFAULT_CARRIER_RATES;
    }
    if (activePhase === 'parameters') renderContent();
  })();
}

/**
 * Cleanup.
 */
export function unmount() {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  bus.clear('netopt:push-to-fleet'); // free the NetOpt handoff listener
  runState.reset();
  rootEl = null;
  bus.emit('fleet:unmounted');
}

// ============================================================
// SHELL
// ============================================================

function renderShell() {
  // CM Chrome v3 ripple — chrome HTML+CSS lives in shared/tool-chrome.js.
  return renderToolChrome(_buildFleetChromeOpts());
}

/** Build chrome opts from current Fleet state. Fleet has no explicit
 *  isDirty flag — runState tracks input divergence, so 'modified' = saved
 *  scenario whose inputs have diverged since the last clean run. */
function _buildFleetChromeOpts() {
  const draft = !activeScenarioId;
  const isModifiedFromRunState = runState.state(runStateInputs()) === 'dirty';
  const modified = !!activeScenarioId && isModifiedFromRunState;
  const stateName = draft ? 'draft' : (modified ? 'modified' : 'saved');
  const stateTitle = draft
    ? 'Brand-new scenario — Save to capture an audit timestamp'
    : (modified ? 'Inputs have diverged since the last run — re-run + save to capture' : 'Saved');

  const runStateClass = runState.state(runStateInputs());

  const actions = [
    { id: 'fleet-save',
      label: activeScenarioId ? '\u{1F4BE} Save' : '\u{1F4BE} Save Scenario',
      title: activeScenarioId ? 'Update this scenario' : 'Save this scenario to open it again later',
      primary: modified },
    { id: 'fleet-run',
      label: 'Run',
      icon: '▶',
      title: 'Run fleet analyzer (Cmd/Ctrl+Enter)',
      kind: 'primary',
      runState: runStateClass,
      cleanLabel: '✓ Results current',
      cleanTitle: 'Inputs unchanged since the last run — fleet results match the current lanes + config. Click to force a re-run.' },
  ];

  const sidebarFooter = activeParentCmId
    ? 'Linked to Cost Model #' + activeParentCmId
    : '';

  const activeSection = _activeFleetSectionKey();

  return {
    toolKey: 'fleet',
    groups: FLEET_GROUPS,
    sections: FLEET_SECTIONS,
    activePhase,
    activeSection,
    sectionCompleteness: _fleetSectionCompleteness,
    saveState: { state: stateName, title: stateTitle },
    actions,
    showSidebar: false,
    showSidebarToggle: false,
    sidebarHeader: 'All Sections',
    sidebarBody: '',
    sidebarFooter,
    bodyHtml: '<div id="fm-content" style="overflow-y:auto;padding:24px;height:100%;"></div>',
    backTitle: 'Back to scenarios',
    emptyPhaseHint: activePhase === 'inputs' ? 'Single-canvas phase — switch to Parameters or Run for sub-views' : '',
  };
}

/** Map current phase + sub-tab state to the active section pill. */
function _activeFleetSectionKey() {
  if (activePhase === 'parameters') return paramsSubTab || 'vehicles';
  if (activePhase === 'run') return runSubTab || 'cost';
  return null; // inputs phase has no sub-sections
}

function _fleetSectionCompleteness(key) {
  // Parameters sub-sections always 'complete' (configured by default).
  if (key === 'vehicles' || key === 'operating' || key === 'ratedeck') return 'complete';
  // Run sub-sections require a result.
  if (['cost', 'comparison', 'sensitivity', 'map', 'feasibility'].includes(key)) {
    return result ? 'complete' : 'empty';
  }
  return 'empty';
}

/** Compute KPI strip values for Fleet's chrome. */
function _computeFleetKpis() {
  const items = [];
  let veh = '—', drv = '—', cost = '—', util = '—';
  if (result) {
    if (typeof result.totalVehicles === 'number') veh = String(result.totalVehicles);
    else if (Array.isArray(result.fleet)) veh = String(result.fleet.reduce((s, f) => s + (f.count || 0), 0));
    if (typeof result.totalDrivers === 'number') drv = String(result.totalDrivers);
    if (typeof result.totalAnnualCost === 'number') {
      const tc = result.totalAnnualCost;
      cost = tc >= 1e6 ? '$' + (tc / 1e6).toFixed(2) + 'M' :
             tc >= 1e3 ? '$' + (tc / 1e3).toFixed(0) + 'K' :
             '$' + tc.toFixed(0);
    } else if (typeof result.totalCost === 'number') {
      const tc = result.totalCost;
      cost = tc >= 1e6 ? '$' + (tc / 1e6).toFixed(2) + 'M' :
             tc >= 1e3 ? '$' + (tc / 1e3).toFixed(0) + 'K' :
             '$' + tc.toFixed(0);
    }
    if (typeof result.utilization === 'number') {
      util = (result.utilization * (result.utilization > 1 ? 1 : 100)).toFixed(0) + '%';
    } else if (typeof result.avgUtilizationPct === 'number') {
      util = result.avgUtilizationPct.toFixed(0) + '%';
    }
  }
  items.push({ label: 'Vehicles', value: veh, hint: 'Total fleet vehicle count from the most recent run.' });
  items.push({ label: 'Drivers', value: drv, hint: 'Required drivers (accounting for team-driving mode).' });
  items.push({ label: 'Total Cost', value: cost, hint: 'Annual fleet cost (vehicles + drivers + ops).' });
  items.push({ label: 'Utilization', value: util, hint: 'Average fleet utilization across the run.' });
  return items;
}

function _refreshFleetKpis() {
  if (!rootEl) return;
  refreshKpiStrip(rootEl, _computeFleetKpis());
}

// 2026-04-27 EVE2 (FLE-SCOPE-1): stepper status driven by current state.
function fleetPhaseStatus() {
  const inputsComplete = lanes.length > 0;
  const runComplete = !!result;
  return {
    inputs:     inputsComplete ? 'complete' : 'active',
    parameters: runComplete ? 'complete' : (inputsComplete ? 'active' : 'pending'),
    run:        runComplete ? 'complete' : (inputsComplete ? 'active' : 'pending'),
  };
}

function renderFleetStepper() {
  // CM Chrome v3 ripple — in-canvas phase stepper dropped. Stub kept so
  // existing call sites don't crash.
  return;
}

// 2026-04-27 EVE2 (FLE-SCOPE-8): HOS feasibility check that runs upstream
// of the Run button. If any lane fails, surface a warning chip near the
// header so the user notices BEFORE they trust the comparison numbers.
function renderHosFeasibilityChip() {
  if (!Array.isArray(lanes) || lanes.length === 0) return;
  const dailyHrs = Number(config.drivingHoursPerDay ?? 11) * (config.teamDriving ? 2 : 1);
  const days = Number(config.operatingDaysPerWeek ?? 5);
  const speed = Number(config.avgSpeedMph ?? 50);
  const budget = dailyHrs * days;
  const failing = lanes.filter(l => {
    const rtMiles = (Number(l.distanceMiles) || 0) * 2;
    const rtHrs = rtMiles / Math.max(1, speed);
    return rtHrs > budget;
  });
  if (failing.length === 0) {
    const stale = rootEl?.querySelector('#fm-hos-chip');
    if (stale) stale.remove();
    return;
  }
  const stepperEl = rootEl?.querySelector('#fm-process-flow');
  if (!stepperEl) return;
  const existing = rootEl.querySelector('#fm-hos-chip');
  if (existing) existing.remove();
  const chip = document.createElement('div');
  chip.id = 'fm-hos-chip';
  chip.style.cssText = 'background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:8px 14px;font-size:12px;line-height:1.5;display:flex;align-items:center;gap:10px;';
  chip.innerHTML = `<span style="font-weight:700;">⚠ HOS feasibility:</span> ${failing.length} of ${lanes.length} lane${failing.length===1?'':'s'} exceed${failing.length===1?'s':''} the ${budget.toFixed(0)}h weekly driving budget. The 3-way comparison will reflect this — open <b>Run · Feasibility</b> for details.`;
  stepperEl.parentNode.insertBefore(chip, stepperEl.nextSibling);
}

function bindShellEvents() {
  if (!rootEl) return;
  rootEl.__tcBound = false;

  bindToolChromeEvents(rootEl, {
    onPhase: (phase) => {
      if (!phase || phase === activePhase) return;
      activePhase = /** @type {any} */ (phase);
      // Default sub-tab when entering each phase.
      if (activePhase === 'parameters' && !paramsSubTab) paramsSubTab = 'vehicles';
      if (activePhase === 'run' && !runSubTab) runSubTab = 'cost';
      rootEl.innerHTML = renderShell();
      bindShellEvents();
      renderContent();
      _refreshFleetKpis();
    },
    onSection: (key) => {
      if (!key) return;
      const sec = FLEET_SECTIONS.find(s => s.key === key);
      if (!sec) return;
      if (sec.group === 'parameters') {
        activePhase = 'parameters';
        paramsSubTab = /** @type {any} */ (key);
      } else if (sec.group === 'run') {
        activePhase = 'run';
        runSubTab = /** @type {any} */ (key);
      }
      rootEl.innerHTML = renderShell();
      bindShellEvents();
      renderContent();
      _refreshFleetKpis();
    },
    onBack: async () => {
      const state = runState.state(runStateInputs());
      if (state === 'dirty' && result && !confirm('You have unsaved changes since the last calculate. Leave anyway?')) return;
      await renderLanding();
    },
    onAction: (id) => {
      if (id === 'fleet-save') return handleSaveFleet();
      if (id === 'fleet-run') {
        runFleetAnalysis();
        return;
      }
    },
    onPrimaryShortcut: () => {
      runFleetAnalysis();
    },
  });
}

/** Run the fleet analyzer + refresh chrome/KPIs/content after the new result. */
function runFleetAnalysis() {
  try {
    const deckMap = carrierRateDeck.length ? calc.indexCarrierDeck(carrierRateDeck) : undefined;
    result = calc.analyzeFleet(lanes, vehicles, config, deckMap);
    activePhase = 'run';
    if (!runSubTab) runSubTab = 'cost';
    runState.markClean(runStateInputs());
    updateRunButtonState();
    rootEl.innerHTML = renderShell();
    bindShellEvents();
    renderContent();
    _refreshFleetKpis();
    flashPrimaryAction(rootEl);
  } catch (err) {
    console.error('[Fleet] Run failed:', err);
    if (typeof showToast === 'function') showToast('Run failed: ' + (err.message || err), 'error');
  }
}

/** Save scenario via the chrome's onAction handler. */
async function handleSaveFleet() {
  try {
    const payload = { id: activeScenarioId || undefined, lanes, vehicles, config, result };
    const saved = await api.saveScenario(payload);
    activeScenarioId = saved?.id || activeScenarioId;
    if (typeof showToast === 'function') showToast('Saved.', 'success');
    refreshToolChrome(rootEl, _buildFleetChromeOpts());
  } catch (err) {
    console.error('[Fleet] Save failed:', err);
    if (typeof showToast === 'function') showToast('Save failed: ' + (err.message || err), 'error');
  }
}

function renderContent() {
  const el = rootEl?.querySelector('#fm-content');
  if (!el) return;
  updateRunButtonState();
  renderFleetStepper();
  renderHosFeasibilityChip();

  switch (activePhase) {
    case 'inputs':     renderLanes(el); break;
    case 'parameters': renderParametersPhase(el); break;
    case 'run':        renderRunPhase(el); break;
    default:           renderLanes(el);
  }
}

function renderParametersPhase(el) {
  el.innerHTML = '<div id="fm-params-inner"></div>';
  const inner = el.querySelector('#fm-params-inner');
  if      (paramsSubTab === 'operating') renderOperatingSubTab(inner);
  else if (paramsSubTab === 'ratedeck')  renderRateDeck(inner);
  else                                    renderVehiclesSubTab(inner);
}

function renderRunPhase(el) {
  if (!result) {
    el.innerHTML = `
      <div class="hub-card" style="padding:24px;text-align:center;">
        <div style="font-size:14px;color:var(--ies-gray-500);">No fleet calc yet. Add lanes (Inputs phase), tune assumptions (Parameters), then click <b>Run</b> in the header.</div>
      </div>
    `;
    return;
  }
    el.innerHTML = '<div id="fm-run-inner"></div>';
  const inner = el.querySelector('#fm-run-inner');
  if      (runSubTab === 'comparison')  renderComparisonSubTab(inner);
  else if (runSubTab === 'sensitivity') renderSensitivitySubTab(inner);
  else if (runSubTab === 'map')         renderMap(inner);
  else if (runSubTab === 'feasibility') renderFeasibilitySubTab(inner);
  else                                   renderCostSubTab(inner);
}

// ============================================================
// LANES TAB
// ============================================================

function renderLanes(el) {
  el.innerHTML = `
    <div style="max-width:1000px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Transportation Lanes</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-add-lane">+ Add Lane</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-load-demo">Load Demo Data</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-import-csv">⬆ Import CSV</button>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-export-csv">⬇ Export CSV</button>
        </div>
      </div>

      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:800px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Origin</th>
              <th style="text-align:left;padding:8px 6px;font-weight:700;">Destination</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Weekly Ships</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Wt (lbs)</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Avg Cube (ft³)</th>
              <th style="text-align:right;padding:8px 6px;font-weight:700;">Distance (mi)</th>
              <th style="text-align:center;padding:8px 6px;"></th>
            </tr>
          </thead>
          <tbody>
            ${lanes.map((l, i) => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${l.origin}</td>
                <td style="padding:6px;">${l.destination}</td>
                <td style="padding:6px;text-align:right;">${l.weeklyShipments}</td>
                <td style="padding:6px;text-align:right;">${l.avgWeightLbs.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${l.avgCubeFt3.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${l.distanceMiles}</td>
                <td style="padding:6px;text-align:center;">
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-lane-del="${i}" style="padding:4px 8px;">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <input type="file" id="fm-csv-input" accept=".csv" style="display:none;">

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          ${kpi('Total Lanes', String(lanes.length))}
          ${kpi('Weekly Shipments', lanes.reduce((s, l) => s + l.weeklyShipments, 0).toLocaleString())}
          ${kpi('Total Weekly Miles', lanes.reduce((s, l) => s + l.distanceMiles * l.weeklyShipments, 0).toLocaleString())}
        </div>
      </div>
    </div>
  `;

  el.querySelectorAll('[data-lane-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      lanes.splice(parseInt(/** @type {HTMLElement} */ (btn).dataset.laneDel), 1);
      renderLanes(el);
    });
  });

  el.querySelector('#fm-add-lane')?.addEventListener('click', () => {
    lanes.push({ id: 'l' + Date.now(), origin: 'Origin', destination: 'Destination', weeklyShipments: 5, avgWeightLbs: 20000, avgCubeFt3: 1500, distanceMiles: 200 });
    renderLanes(el);
  });

  el.querySelector('#fm-load-demo')?.addEventListener('click', () => {
    lanes = calc.DEMO_LANES.map(l => ({ ...l }));
    renderLanes(el);
  });

  el.querySelector('#fm-import-csv')?.addEventListener('click', () => {
    el.querySelector('#fm-csv-input')?.click();
  });

  el.querySelector('#fm-csv-input')?.addEventListener('change', (e) => {
    const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const csv = event.target?.result;
        const lines = String(csv).split('\n');
        const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
        lanes = [];
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const values = lines[i].split(',').map(v => v.trim());
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = values[idx]; });
          if (obj.origin && obj.destination) {
            lanes.push({
              id: 'l' + Date.now() + i,
              origin: obj.origin,
              destination: obj.destination,
              weeklyShipments: parseInt(obj.weekly_shipments) || 1,
              avgWeightLbs: parseFloat(obj.avg_weight_lbs) || parseFloat(obj.avg_weight) || 5000,
              avgCubeFt3: parseFloat(obj.avg_cube_ft3) || parseFloat(obj.avg_cube) || 300,
              distanceMiles: parseFloat(obj.distance_miles) || parseFloat(obj.distance) || 200,
            });
          }
        }
        renderLanes(el);
      } catch (err) {
        console.error('Error importing CSV:', err);
      }
    };
    reader.readAsText(file);
  });

  el.querySelector('#fm-export-csv')?.addEventListener('click', () => {
    const csv = ['origin,destination,weekly_shipments,avg_weight_lbs,avg_cube_ft3,distance_miles'];
    lanes.forEach(lane => {
      csv.push(`${lane.origin},${lane.destination},${lane.weeklyShipments},${lane.avgWeightLbs},${lane.avgCubeFt3},${lane.distanceMiles}`);
    });
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fleet-lanes.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ============================================================
// CONFIG TAB
// ============================================================

// 2026-04-27 EVE2 (FLE-SCOPE-2): Vehicles sub-tab — financing + vehicle specs.
function renderVehiclesSubTab(el) {
  el.innerHTML = `
    <div style="max-width:900px;">
      <h3 class="text-section" style="margin-bottom:16px;">Financing Mode</h3>
      <div class="hub-card" style="margin-bottom:20px;padding:16px;">
        <div style="display:flex;gap:24px;margin-bottom:16px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
            <input type="radio" name="fm-financing" value="purchase" ${!config.leaseMode ? 'checked' : ''} id="fm-financing-purchase">
            <span style="font-weight:600;">Purchase (Depreciation)</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
            <input type="radio" name="fm-financing" value="lease" ${config.leaseMode ? 'checked' : ''} id="fm-financing-lease">
            <span style="font-weight:600;">Lease (Monthly Payment)</span>
          </label>
        </div>
        <div style="padding:12px;background:var(--ies-gray-100);border-radius:6px;font-size:12px;color:var(--ies-gray-600);">
          ${!config.leaseMode
            ? 'Purchase: Straight-line depreciation over 5-7 years with 15% residual value'
            : 'Lease: Monthly rates vary by vehicle type (Dry Van $2,200-$2,800/mo)'}
        </div>
      </div>

      <h3 class="text-section" style="margin-bottom:16px;">Vehicle Specifications</h3>
      <div class="hub-card" style="padding:16px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:6px;font-weight:700;">Enabled</th>
              <th style="text-align:left;padding:6px;font-weight:700;">Vehicle</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Payload (lbs)</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Cube (ft³)</th>
              <th style="text-align:right;padding:6px;font-weight:700;">MPG</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Capital</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Insurance</th>
            </tr>
          </thead>
          <tbody>
            ${vehicles.map((v, i) => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);${v.enabled ? '' : 'opacity:0.5;'}">
                <td style="padding:6px;"><input type="checkbox" ${v.enabled ? 'checked' : ''} data-veh-toggle="${i}"></td>
                <td style="padding:6px;font-weight:600;">${v.name}</td>
                <td style="padding:6px;text-align:right;">${v.maxPayloadLbs.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${v.maxCubeFt3.toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${v.mpg}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(v.capitalCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${v.insuranceFactor}x</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  el.querySelectorAll('[data-veh-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(/** @type {HTMLElement} */ (cb).dataset.vehToggle);
      vehicles[idx].enabled = /** @type {HTMLInputElement} */ (cb).checked;
      updateRunButtonState();
      renderVehiclesSubTab(el);
    });
  });
  el.querySelectorAll('input[name="fm-financing"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      config.leaseMode = /** @type {HTMLInputElement} */ (e.target).value === 'lease';
      updateRunButtonState();
      renderVehiclesSubTab(el);
    });
  });
}

// 2026-04-27 EVE2 (FLE-SCOPE-2/6/7/9): Operating Costs sub-tab. Cost
// parameters sub-grouped into Driver / Fuel & Power / Vehicle / Overhead
// sections. Driver Pay Model gets its own labeled row. GXO Margin +
// Carrier Premium lifted into a separate Comparison block (they drive the
// 3-way verdict, not vehicle cost).
function renderOperatingSubTab(el) {
  el.innerHTML = `
    <div style="max-width:900px;">
      <h3 class="text-section" style="margin-bottom:12px;">Driver</h3>
      <div class="hub-card" style="padding:16px;margin-bottom:18px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;">
          ${cfgInput('Driver Wage', 'driverCostPerHr', config.driverCostPerHr, '$/hr')}
          ${cfgInput('Driver Benefits %', 'driverBenefitPct', config.driverBenefitPct ?? 35, '%')}
          ${cfgInput('Detention Hrs/Trip', 'detentionHoursPerTrip', config.detentionHoursPerTrip ?? 2, 'hrs')}
          ${cfgInput('Driving Hrs/Day', 'drivingHoursPerDay', config.drivingHoursPerDay, 'hrs')}
          ${cfgInput('Operating Days/Wk', 'operatingDaysPerWeek', config.operatingDaysPerWeek, 'days')}
          ${cfgInput('Avg Speed', 'avgSpeedMph', config.avgSpeedMph, 'mph')}
        </div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--ies-gray-200);display:flex;gap:18px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;font-weight:600;">
            <input type="checkbox" id="fm-team" ${config.teamDriving ? 'checked' : ''}>
            Team Driving (doubles daily hours, 2 drivers/vehicle)
          </label>
        </div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--ies-gray-200);display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <label style="font-size:13px;font-weight:600;">Driver Pay Model:</label>
          <select id="fm-driver-model" style="padding:6px 8px;border:1px solid var(--ies-gray-300);border-radius:6px;font-size:13px;font-weight:600;">
            <option value="hourly" ${(config.driverPayModel ?? 'hourly') === 'hourly' ? 'selected' : ''}>Hourly</option>
            <option value="perMile" ${(config.driverPayModel ?? 'hourly') === 'perMile' ? 'selected' : ''}>Per-Mile</option>
            <option value="percentage" ${(config.driverPayModel ?? 'hourly') === 'percentage' ? 'selected' : ''}>% of Revenue</option>
            <option value="hybrid" ${(config.driverPayModel ?? 'hourly') === 'hybrid' ? 'selected' : ''}>Hybrid</option>
          </select>
          <span style="font-size:11px;color:var(--ies-gray-500);">Drives how driver-cost rolls up against trips, miles, or revenue.</span>
        </div>
      </div>

      <h3 class="text-section" style="margin-bottom:12px;">Fuel &amp; Power</h3>
      <div class="hub-card" style="padding:16px;margin-bottom:18px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;">
          ${cfgInput('Diesel Price', 'dieselPricePerGal', config.dieselPricePerGal, '$/gal')}
          ${cfgInput('Tolls', 'tollsCostPerMi', config.tollsCostPerMi ?? 0.025, '$/mi')}
          ${cfgInput('Deadhead %', 'deadheadPct', config.deadheadPct ?? 15, '%')}
          ${cfgInput('Utilization', 'utilizationPct', config.utilizationPct, '%')}
        </div>
      </div>

      <h3 class="text-section" style="margin-bottom:12px;">Vehicle</h3>
      <div class="hub-card" style="padding:16px;margin-bottom:18px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;">
          ${cfgInput('Maintenance', 'maintenanceCostPerMi', config.maintenanceCostPerMi, '$/mi')}
          ${cfgInput('Tires', 'tiresCostPerMi', config.tiresCostPerMi ?? 0.04, '$/mi')}
          ${cfgInput('Depreciation', 'depreciationYears', config.depreciationYears, 'yrs')}
          ${cfgInput('Insurance Base', 'insuranceBasePerYear', config.insuranceBasePerYear, '$/yr')}
        </div>
      </div>

      <h3 class="text-section" style="margin-bottom:12px;">Overhead</h3>
      <div class="hub-card" style="padding:16px;margin-bottom:18px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;">
          ${cfgInput('Admin Overhead %', 'adminCostPct', config.adminCostPct ?? 8, '%')}
          ${cfgInput('Permits', 'permitsPerYear', config.permitsPerYear ?? 850, '$/yr')}
        </div>
      </div>

      <h3 class="text-section" style="margin-bottom:12px;">Comparison Knobs</h3>
      <div class="hub-card" style="padding:16px;border-left:3px solid var(--ies-blue);margin-bottom:18px;">
        <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:10px;line-height:1.5;">
          Tune the numbers used by the <b>3-way comparison</b> on the Run phase. These don't change vehicle costs — they re-weight the dedicated and common-carrier columns.
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;">
          ${cfgInput('GXO Margin', 'gxoMarginPct', config.gxoMarginPct, '%')}
          ${cfgInput('Carrier Premium', 'carrierPremiumPct', config.carrierPremiumPct, '%')}
        </div>
      </div>

      <div style="padding:14px;background:var(--ies-gray-50);border-radius:6px;font-size:12px;color:var(--ies-gray-600);">
        <strong>Carrier Rate Deck</strong> lives in its own sub-tab — switch to the <em>Rate Deck</em> tab above to edit base rate, fuel surcharge, min charge, and notes per vehicle class.
      </div>
    </div>
  `;
  el.querySelectorAll('input[data-cfg]').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.cfg;
      config[key] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      updateRunButtonState();
    });
  });
  el.querySelector('#fm-team')?.addEventListener('change', (e) => {
    config.teamDriving = /** @type {HTMLInputElement} */ (e.target).checked;
    updateRunButtonState();
  });
  el.querySelector('#fm-driver-model')?.addEventListener('change', (e) => {
    config.driverPayModel = /** @type {HTMLSelectElement} */ (e.target).value;
    updateRunButtonState();
  });
}

function renderConfig(el) {
  // Compat shim for any legacy callers — routes to Operating sub-tab.
  renderOperatingSubTab(el);
}

function cfgInput(label, key, value, unit) {
  return `
    <div style="display:flex;align-items:center;gap:8px;">
      <label style="font-size:13px;font-weight:600;flex:1;">${label}</label>
      <input type="number" value="${value}" data-cfg="${key}" step="0.01"
             style="width:90px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
      <span style="font-size:11px;color:var(--ies-gray-400);width:36px;">${unit}</span>
    </div>
  `;
}

// ============================================================
// RATE DECK TAB (FLE-A3)
// ============================================================

function renderRateDeck(el) {
  el.innerHTML = `
    <div style="max-width:1100px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <h3 class="text-section" style="margin:0 0 4px 0;">Common-Carrier Rate Deck</h3>
          <div style="font-size:12px;color:var(--ies-gray-500);">Edits save to <code>ref_fleet_carrier_rates</code> on blur. Effective rate = base × (1 + fuel surcharge). Used by the carrier column of the 3-way comparison.</div>
        </div>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-rd-add">+ Add Class</button>
      </div>
      <div class="hub-card" style="padding:16px;">
        ${carrierRateDeck.length === 0 ? `
          <div style="padding:14px;text-align:center;color:var(--ies-gray-400);font-size:12px;">Loading carrier rate deck…</div>
        ` : `
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:left;padding:6px;font-weight:700;">Vehicle Type</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Base Rate</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Fuel Surcharge</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Min Charge</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Effective</th>
                <th style="text-align:left;padding:6px;font-weight:700;">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${carrierRateDeck.map(rate => {
                const eff = (rate.base_rate_per_mile || 0) * (1 + (rate.fuel_surcharge_pct || 0));
                return `
                  <tr style="border-bottom:1px solid var(--ies-gray-200);">
                    <td style="padding:6px;font-weight:600;">${rate.display_name}<div style="font-size:10px;color:var(--ies-gray-400);font-weight:400;">${rate.vehicle_type}</div></td>
                    <td style="padding:6px;text-align:right;">
                      <input type="number" step="0.01" value="${rate.base_rate_per_mile}" data-rate-id="${rate.id}" data-rate-field="base_rate_per_mile"
                             style="width:80px;padding:4px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;text-align:right;">
                      <span style="font-size:10px;color:var(--ies-gray-400);">/mi</span>
                    </td>
                    <td style="padding:6px;text-align:right;">
                      <input type="number" step="0.01" value="${rate.fuel_surcharge_pct}" data-rate-id="${rate.id}" data-rate-field="fuel_surcharge_pct"
                             style="width:70px;padding:4px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;text-align:right;">
                    </td>
                    <td style="padding:6px;text-align:right;">
                      <input type="number" step="5" value="${rate.min_charge}" data-rate-id="${rate.id}" data-rate-field="min_charge"
                             style="width:70px;padding:4px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:12px;text-align:right;">
                    </td>
                    <td style="padding:6px;text-align:right;font-weight:600;color:var(--ies-blue);">$${eff.toFixed(2)}/mi</td>
                    <td style="padding:6px;font-size:11px;color:var(--ies-gray-500);"><input type="text" value="${(rate.notes || '').replace(/"/g, '&quot;')}" data-rate-id="${rate.id}" data-rate-field="notes" style="width:100%;padding:4px 6px;border:1px solid transparent;border-radius:4px;font-size:11px;background:transparent;"></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `;

  // Inline edits — same handler shape as Configuration tab
  el.querySelectorAll('[data-rate-id][data-rate-field]').forEach(input => {
    input.addEventListener('change', async (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      const id = parseInt(target.dataset.rateId);
      const field = target.dataset.rateField;
      let val = target.type === 'number' ? parseFloat(target.value) : target.value;
      if (target.type === 'number' && !Number.isFinite(val)) return;
      const row = carrierRateDeck.find(r => r.id === id);
      if (row) row[field] = val;
      renderRateDeck(el);
      if (id > 0) {
        try {
          await api.updateCarrierRate(id, { [field]: val });
          showToast(`Updated ${row?.display_name || 'rate'}`, 'success');
        } catch (err) {
          showToast(`Save failed: ${err.message || 'unknown'}`, 'error');
        }
      }
    });
  });
}

// ============================================================
// RESULTS TAB
// ============================================================

// 2026-04-27 EVE2 (FLE-SCOPE-5): Run-phase sub-tab renderers. Each calls
// renderResults(el) (which emits the full results page) then hides the
// blocks not relevant to that sub-tab via data-fm-section attrs sprinkled
// onto the result cards.
function renderCostSubTab(el) {
  renderResults(el);
  el.querySelectorAll('[data-fm-section]').forEach(node => {
    const section = node.getAttribute('data-fm-section');
    if (section && section !== 'cost') node.style.display = 'none';
  });
}

function renderComparisonSubTab(el) {
  renderResults(el);
  el.querySelectorAll('[data-fm-section]').forEach(node => {
    const section = node.getAttribute('data-fm-section');
    if (section && section !== 'comparison') node.style.display = 'none';
  });
  // FLE-SCOPE-10: Push to NetOpt button on the Comparison sub-tab.
  if (!el.querySelector('#fm-push-netopt')) {
    const headerRail = el.querySelector('[data-fm-section="comparison"] [style*="font-size:14px"]');
    const card = el.querySelector('[data-fm-section="comparison"]');
    if (card) {
      const btn = document.createElement('button');
      btn.id = 'fm-push-netopt';
      btn.className = 'hub-btn hub-btn-sm hub-btn-secondary';
      btn.style.cssText = 'margin:0 0 12px 0;font-size:11px;padding:5px 10px;';
      btn.title = 'Send the lane → annual-miles seed to Network Optimizer for downstream network design.';
      btn.textContent = '→ Send to NetOpt';
      btn.addEventListener('click', () => {
        try {
          const seed = lanes.map(l => ({
            name: `${l.origin || 'O'} → ${l.destination || 'D'}`,
            origin: l.origin,
            destination: l.destination,
            weeklyShipments: l.weeklyShipments,
            avgWeightLbs: l.avgWeightLbs,
            distanceMiles: l.distanceMiles,
          }));
          bus.emit('fleet:push-to-netopt', { source: 'fleet-modeler', lanes: seed, totalAnnualMiles: result?.totalAnnualMiles });
          showToast(`Sent ${seed.length} lanes to Network Optimizer`, 'success');
        } catch (err) {
          showToast(`Push failed: ${err.message || 'unknown'}`, 'error');
        }
      });
      card.insertBefore(btn, card.firstChild);
    }
  }
}

function renderSensitivitySubTab(el) {
  renderResults(el);
  el.querySelectorAll('[data-fm-section]').forEach(node => {
    const section = node.getAttribute('data-fm-section');
    if (section && section !== 'sensitivity') node.style.display = 'none';
  });
}

function renderFeasibilitySubTab(el) {
  renderResults(el);
  el.querySelectorAll('[data-fm-section]').forEach(node => {
    const section = node.getAttribute('data-fm-section');
    if (section && section !== 'feasibility') node.style.display = 'none';
  });
  // If no HOS issues, surface a friendly all-clear card.
  if (!el.querySelector('[data-fm-section="feasibility"]')) {
    const inner = el;
    const card = document.createElement('div');
    card.className = 'hub-card';
    card.style.cssText = 'padding:16px;background:#f0fdf4;border-left:4px solid #22c55e;margin-top:8px;';
    card.innerHTML = '<div style="font-size:13px;font-weight:700;color:#15803d;">✓ HOS Feasibility — all lanes within driving budget</div>';
    inner.appendChild(card);
  }
}

function renderResults(el) {
  if (!result) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Click "Calculate Fleet" to see results.</p></div>';
    return;
  }

  const r = result;
  const atriColor = { 'BELOW': '#22c55e', 'AT': '#f59e0b', 'ABOVE': '#ef4444' }[r.atriBenchmark.verdict];

  el.innerHTML = `
    <div style="max-width:1200px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 class="text-section" style="margin:0;">Results</h3>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="fm-results-export">⬇ Export XLSX</button>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="fm-results-push-cm" title="Stash fleet costs on the active cost-model scenario">→ Push to Cost Model</button>
        </div>
      </div>
      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Total Vehicles', String(r.totalVehicles))}
          ${kpi('Annual Miles', calc.formatMiles(r.totalAnnualMiles))}
          ${kpi('Annual Cost', calc.formatCurrency(r.totalAnnualCost, { compact: true }))}
          ${kpi('Cost/Mile', calc.formatCpm(r.avgCostPerMile))}
          ${kpi('ATRI Benchmark', r.atriBenchmark.verdict, atriColor)}
        </div>
      </div>

      <!-- Fleet Composition -->
      <div class="hub-card" data-fm-section="cost" style="padding:16px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Fleet Composition</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:left;padding:6px;font-weight:700;">Vehicle</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Units</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Annual Miles</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Fuel</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Driver</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Maint</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Depr</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Insurance</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Admin</th>
              <th style="text-align:right;padding:6px;font-weight:700;">Total</th>
              <th style="text-align:right;padding:6px;font-weight:700;">$/Mile</th>
            </tr>
          </thead>
          <tbody>
            ${r.fleetComposition.map(f => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);">
                <td style="padding:6px;font-weight:600;">${f.vehicleName}</td>
                <td style="padding:6px;text-align:right;">${f.unitsNeeded}</td>
                <td style="padding:6px;text-align:right;">${Math.round(f.annualMiles).toLocaleString()}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualFuelCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualDriverCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualMaintenanceCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualDepreciation, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualInsurance, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCurrency(f.annualAdminCost || 0, { compact: true })}</td>
                <td style="padding:6px;text-align:right;font-weight:700;">${calc.formatCurrency(f.totalAnnualCost, { compact: true })}</td>
                <td style="padding:6px;text-align:right;">${calc.formatCpm(f.costPerMile)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Cost Waterfall (fixed → variable → total) -->
      <div class="hub-card" data-fm-section="cost" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Annual Cost Waterfall</div>
        ${renderCostWaterfall(r.fleetComposition)}
      </div>

      <!-- 3-Way Comparison Cards -->
      <div class="hub-card" data-fm-section="comparison" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">3-Way Cost Comparison</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">
          ${renderComparisonCard('Private Fleet', r.comparison.private, r.comparison, 'var(--ies-blue)')}
          ${renderComparisonCard('Dedicated (GXO)', r.comparison.dedicated, r.comparison, '#8b5cf6')}
          ${renderComparisonCard('Common Carrier', r.comparison.carrier, r.comparison, '#ef4444')}
        </div>
      </div>

      <!-- FLE-D1: Side-by-side cost build-up across all three models -->
      ${renderCostBuildupCard(r)}

      <!-- ATRI Benchmark Table -->
      <div class="hub-card" data-fm-section="comparison" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">ATRI 2024 Benchmark Comparison</div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:2px solid var(--ies-gray-200);background:var(--ies-gray-100);">
                <th style="text-align:left;padding:8px;font-weight:700;">Category</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Your Fleet</th>
                <th style="text-align:right;padding:8px;font-weight:700;">ATRI 2024</th>
                <th style="text-align:right;padding:8px;font-weight:700;">Variance</th>
                <th style="text-align:center;padding:8px;font-weight:700;">Status</th>
              </tr>
            </thead>
            <tbody>
              ${renderAtriBenchmarkRow('Total CPM', r.atriBenchmark.modelCostPerMile, r.atriBenchmark.atriCostPerMile)}
              ${renderAtriBenchmarkRow('Fuel/Mi', r.atriBenchmark.modelCostPerMile * 0.26, 0.583)}
              ${renderAtriBenchmarkRow('Drivers/Mi', r.atriBenchmark.modelCostPerMile * 0.37, 0.827)}
              ${renderAtriBenchmarkRow('Vehicle/Mi', r.atriBenchmark.modelCostPerMile * 0.13, 0.296)}
              ${renderAtriBenchmarkRow('Insurance/Mi', r.atriBenchmark.modelCostPerMile * 0.06, 0.117)}
              ${renderAtriBenchmarkRow('Maintenance/Mi', r.atriBenchmark.modelCostPerMile * 0.08, 0.198)}
            </tbody>
          </table>
        </div>
      </div>

      <!-- FLE-C3: HOS feasibility warnings -->
      ${renderHosWarnings(r)}

      <!-- FLE-D4: Break-even miles chart -->
      ${renderBreakEvenCard(r)}

      <!-- Sensitivity Matrix -->
      ${renderSensitivityMatrixCard()}

      <!-- Volume Sensitivity -->
      ${renderVolumeSensitivityCard()}

      <!-- Lane Assignments -->
      <div class="hub-card" data-fm-section="cost" style="padding:16px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Lane Assignments</div>
        <div style="max-height:300px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead style="position:sticky;top:0;background:#fff;">
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:left;padding:6px;font-weight:700;">Lane</th>
                <th style="text-align:left;padding:6px;font-weight:700;">Vehicle</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Trips/Wk</th>
                <th style="text-align:right;padding:6px;font-weight:700;">RT Miles</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Annual Miles</th>
                <th style="text-align:right;padding:6px;font-weight:700;">Per Trip</th>
              </tr>
            </thead>
            <tbody>
              ${r.assignments.map(a => {
                const lane = lanes.find(l => l.id === a.laneId);
                return `
                  <tr style="border-bottom:1px solid var(--ies-gray-200);">
                    <td style="padding:6px;font-weight:600;">${lane ? lane.origin + ' → ' + lane.destination : a.laneId}</td>
                    <td style="padding:6px;">${a.vehicleName}</td>
                    <td style="padding:6px;text-align:right;">${a.tripsPerWeek}</td>
                    <td style="padding:6px;text-align:right;">${a.roundTripMiles.toLocaleString()}</td>
                    <td style="padding:6px;text-align:right;">${Math.round(a.annualMiles).toLocaleString()}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(a.perTripCost)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Bind export buttons + push-to-CM + sensitivity range inputs
  setTimeout(() => {
    el.querySelector('#fm-results-export')?.addEventListener('click', exportFleetXLSX);

    // FLE-G1 — push fleet results to active Cost Model scenario.
    el.querySelector('#fm-results-push-cm')?.addEventListener('click', async () => {
      if (!result) return;
      try {
        const payload = {
          source: 'fleet-modeler',
          scenarioId: activeScenarioId,
          totalAnnualCost: result.totalAnnualCost,
          totalAnnualMiles: result.totalAnnualMiles,
          avgCostPerMile: result.avgCostPerMile,
          comparison: result.comparison,
          breakEven: result.breakEven,
        };
        // Stash on the bus — cost-model listens on 'fleet:push'.
        bus.emit('fleet:push', payload);
        showToast('Fleet costs pushed to Cost Model bus', 'success');
      } catch (err) {
        showToast(`Push failed: ${err.message || 'unknown'}`, 'error');
      }
    });

    // FLE-F1 — sensitivity matrix range inputs trigger a re-render of the
    // Results tab (cheap; the matrix recomputes inside the helper).
    el.querySelectorAll('[data-sens-range]').forEach(input => {
      input.addEventListener('change', (e) => {
        const k = e.target.dataset.sensRange;
        const v = parseFloat(e.target.value);
        if (!Number.isFinite(v)) return;
        sensRange = { ...sensRange, [k]: v };
        // Sanity-clamp inverted bounds
        if (sensRange.driverMin >= sensRange.driverMax) sensRange.driverMax = sensRange.driverMin + 1;
        if (sensRange.dieselMin >= sensRange.dieselMax) sensRange.dieselMax = sensRange.dieselMin + 0.25;
        renderResults(el);
      });
    });
  }, 0);
}

function comparisonBar(label, amount, maxAmount, color) {
  const pct = maxAmount > 0 ? (amount / maxAmount) * 100 : 0;
  return `
    <div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:600;">${label}</span>
        <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(amount, { compact: true })}</span>
      </div>
      <div style="height:24px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:6px;"></div>
      </div>
    </div>
  `;
}

/**
 * Aggregate cost categories across the whole fleet and render as a horizontal
 * stacked waterfall (fuel → driver → maintenance → depreciation → insurance → admin → total).
 * @param {Array} fleetComposition
 */
function renderCostWaterfall(fleetComposition) {
  const totals = {
    fuel: 0, driver: 0, maintenance: 0, depreciation: 0, insurance: 0, admin: 0,
  };
  for (const f of fleetComposition) {
    totals.fuel += f.annualFuelCost || 0;
    totals.driver += f.annualDriverCost || 0;
    totals.maintenance += f.annualMaintenanceCost || 0;
    totals.depreciation += f.annualDepreciation || 0;
    totals.insurance += f.annualInsurance || 0;
    totals.admin += f.annualAdminCost || 0;
  }
  const grand = Object.values(totals).reduce((s, v) => s + v, 0);
  if (grand === 0) return '<div style="font-size:13px;color:var(--ies-gray-400);">No cost data</div>';

  const steps = [
    { label: 'Fuel',         value: totals.fuel,         color: '#dc2626', fixedVar: 'variable' },
    { label: 'Driver',       value: totals.driver,       color: '#2563eb', fixedVar: 'variable' },
    { label: 'Maintenance',  value: totals.maintenance,  color: '#f59e0b', fixedVar: 'variable' },
    { label: 'Depreciation', value: totals.depreciation, color: '#7c3aed', fixedVar: 'fixed' },
    { label: 'Insurance',    value: totals.insurance,    color: '#ec4899', fixedVar: 'fixed' },
    { label: 'Admin',        value: totals.admin,        color: '#6366f1', fixedVar: 'fixed' },
  ];

  const totalFixed = steps.filter(s => s.fixedVar === 'fixed').reduce((s, x) => s + x.value, 0);
  const totalVariable = steps.filter(s => s.fixedVar === 'variable').reduce((s, x) => s + x.value, 0);

  return `
    <div style="margin-bottom:14px;">
      <div style="display:flex;height:32px;border-radius:6px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--ies-gray-200);">
        ${steps.map(s => `
          <div style="flex:${s.value};background:${s.color};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;" title="${s.label}: ${calc.formatCurrency(s.value, { compact: true })}">
            ${s.value / grand > 0.08 ? `${Math.round((s.value / grand) * 100)}%` : ''}
          </div>
        `).join('')}
      </div>
      <div style="display:flex;gap:12px;margin-top:8px;font-size:11px;color:var(--ies-gray-600);flex-wrap:wrap;">
        ${steps.map(s => `
          <span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:10px;height:10px;background:${s.color};border-radius:2px;"></span>${s.label} ${calc.formatCurrency(s.value, { compact: true })}</span>
        `).join('')}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding-top:12px;border-top:1px solid var(--ies-gray-200);">
      <div><div style="font-size:11px;color:var(--ies-gray-500);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Fixed Cost</div><div style="font-size:18px;font-weight:800;color:#7c3aed;">${calc.formatCurrency(totalFixed, { compact: true })}</div></div>
      <div><div style="font-size:11px;color:var(--ies-gray-500);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Variable Cost</div><div style="font-size:18px;font-weight:800;color:#dc2626;">${calc.formatCurrency(totalVariable, { compact: true })}</div></div>
      <div><div style="font-size:11px;color:var(--ies-gray-500);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Total Cost</div><div style="font-size:18px;font-weight:800;color:var(--ies-navy);">${calc.formatCurrency(grand, { compact: true })}</div></div>
    </div>
  `;
}

function renderCostBuildupCard(r) {
  // Cost build-up rows. Private + Dedicated share fuel/maint/vehicle/ins/
  // driver/admin lines; Dedicated additionally surfaces a 25% markup-on-
  // driver line and an explicit margin row. Carrier uses a different
  // shape (Line-Haul / Fuel Surcharge / Min Charges) so we render its
  // value as a dash for the GXO-style rows and split it out instead.
  const pb = (r.comparison && r.comparison.privateBreakdown) || {};
  const db = (r.comparison && r.comparison.dedicatedBreakdown) || {};
  const cb = (r.comparison && r.comparison.carrierBreakdown) || {};
  const fmt = v => calc.formatCurrency(v || 0, { compact: true });
  const row = (label, p, d, c, hint) => `
    <tr style="border-bottom:1px solid var(--ies-gray-100);">
      <td style="padding:6px 8px;font-weight:600;color:var(--ies-gray-700);" title="${hint || ''}">${label}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${p == null ? '—' : fmt(p)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${d == null ? '—' : fmt(d)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${c == null ? '—' : fmt(c)}</td>
    </tr>`;

  return `
    <div class="hub-card" data-fm-section="cost" style="padding:20px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:700;">Annual Cost Build-Up — All Three Models</div>
        <div style="font-size:11px;color:var(--ies-gray-500);">Side-by-side. — = not applicable for that model.</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        <thead>
          <tr style="border-bottom:2px solid var(--ies-gray-200);background:var(--ies-gray-50);">
            <th style="padding:8px;text-align:left;font-weight:700;color:var(--ies-gray-500);">Cost Component</th>
            <th style="padding:8px;text-align:right;font-weight:700;color:var(--ies-blue);">Private</th>
            <th style="padding:8px;text-align:right;font-weight:700;color:#8b5cf6;">Dedicated (GXO)</th>
            <th style="padding:8px;text-align:right;font-weight:700;color:#ef4444;">Common Carrier</th>
          </tr>
        </thead>
        <tbody>
          ${row('Fuel', pb.fuel, db.fuel, null, 'Diesel × annual miles')}
          ${row('Maintenance', pb.maintenance, db.maintenance, null, 'Scheduled maint + repairs (tires/tolls broken out below)')}
          ${row('Tires', pb.tires, null, null, 'Replacement tire $/mi × annual miles')}
          ${row('Tolls', pb.tolls, null, null, 'Tolls $/mi × annual miles')}
          ${row('Permits', pb.permits, null, null, 'Annual licensing + permits per truck × units')}
          ${row('Vehicle (Depreciation)', pb.vehicle, db.vehicle, null, 'Annual depreciation / lease')}
          ${row('Insurance', pb.insurance, db.insurance, null, 'Liability + physical damage')}
          ${row('Driver Wages', pb.driver, db.driver, null, 'Base driver compensation')}
          ${row('Admin / Overhead', pb.admin, db.admin, null, 'Dispatch, fleet manager, back office')}
          ${row('Driver Markup (1.25×)', null, db.markup, null, 'Dedicated includes a 25% markup on driver cost (cost-plus pricing)')}
          ${row('GXO Margin', null, db.margin, null, 'Margin applied on top of cost-plus base')}
          ${row('Line-Haul', null, null, cb.lineHaul, '~70% of carrier billable spend')}
          ${row('Fuel Surcharge', null, null, cb.fuelSurcharge, '~18% of carrier billable spend')}
          ${row('Minimum Charges', null, null, cb.minCharges, '~12% of carrier billable spend (weekly min × 52)')}
          <tr style="border-top:2px solid var(--ies-gray-300);background:var(--ies-gray-50);font-weight:700;">
            <td style="padding:8px;">Total Annual</td>
            <td style="padding:8px;text-align:right;color:var(--ies-blue);">${fmt(r.comparison.private)}</td>
            <td style="padding:8px;text-align:right;color:#8b5cf6;">${fmt(r.comparison.dedicated)}</td>
            <td style="padding:8px;text-align:right;color:#ef4444;">${fmt(r.comparison.carrier)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderComparisonCard(label, amount, comparison, color) {
  const isLowest = amount === Math.min(comparison.private, comparison.dedicated, comparison.carrier);
  const variance = Math.max(comparison.private, comparison.dedicated, comparison.carrier) - amount;
  return `
    <div style="border:1px solid var(--ies-gray-200);border-radius:8px;padding:16px;${isLowest ? `background:linear-gradient(135deg,${color}08,${color}04);border-color:${color};` : ''} ">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:700;">${label}</div>
        ${isLowest ? `<div style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;">✓ LOWEST</div>` : ''}
      </div>
      <div style="font-size:20px;font-weight:800;color:${color};margin-bottom:12px;">${calc.formatCurrency(amount, { compact: true })}</div>
      <div style="font-size:12px;color:var(--ies-gray-600);line-height:1.6;margin-bottom:8px;">
        <div>Cost/Mile: <strong>${calc.formatCpm(amount / (result?.totalAnnualMiles || 1))}</strong></div>
      </div>
      ${isLowest ? `<div style="font-size:11px;color:${color};font-weight:600;">Saves ${calc.formatCurrency(variance, { compact: true })}</div>` : ''}
    </div>
  `;
}

function renderAtriBenchmarkRow(category, yourValue, atriBenchmark) {
  const variance = atriBenchmark > 0 ? ((yourValue - atriBenchmark) / atriBenchmark) * 100 : 0;
  let statusColor = '#22c55e'; // green
  let statusText = 'On Target';
  if (Math.abs(variance) > 25) {
    statusColor = '#ef4444'; // red
    statusText = variance > 0 ? 'Above' : 'Below';
  } else if (Math.abs(variance) > 10) {
    statusColor = '#f59e0b'; // yellow
    statusText = variance > 0 ? 'Above' : 'Below';
  }
  return `
    <tr style="border-bottom:1px solid var(--ies-gray-200);">
      <td style="padding:8px;font-weight:600;color:var(--ies-navy);">${category}</td>
      <td style="padding:8px;text-align:right;font-weight:600;">${calc.formatCpm(yourValue)}</td>
      <td style="padding:8px;text-align:right;">${calc.formatCpm(atriBenchmark)}</td>
      <td style="padding:8px;text-align:right;font-weight:600;color:${statusColor};">${variance > 0 ? '+' : ''}${variance.toFixed(1)}%</td>
      <td style="padding:8px;text-align:center;"><span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${statusColor}20;color:${statusColor};">${statusText}</span></td>
    </tr>
  `;
}

function renderSensitivityMatrixCard() {
  try {
    const matrix = calc.calcSensitivityMatrix(lanes, vehicles, config, sensRange);
    const driverRates = matrix.rowLabels;
    const dieselPrices = matrix.colLabels;

    const getCellColor = (cpm) => {
      if (cpm < 2.00) return '#22c55e'; // green
      if (cpm < 2.50) return '#fbbf24'; // yellow
      if (cpm < 3.00) return '#f97316'; // orange
      return '#ef4444'; // red
    };

    const rngInput = (key, val, step, min, max) => `<input type="number" data-sens-range="${key}" value="${val}" step="${step}" min="${min}" max="${max}" style="width:60px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:11px;text-align:right;">`;
    let tableHtml = `
      <div class="hub-card" data-fm-section="sensitivity" style="padding:20px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
          <div style="font-size:14px;font-weight:700;">Sensitivity Analysis: Driver Rate × Diesel Price</div>
          <div style="display:flex;gap:14px;font-size:11px;color:var(--ies-gray-600);align-items:center;flex-wrap:wrap;">
            <span>Driver $/hr ${rngInput('driverMin', sensRange.driverMin, 1, 10, 60)}–${rngInput('driverMax', sensRange.driverMax, 1, 10, 60)}</span>
            <span>Diesel $/gal ${rngInput('dieselMin', sensRange.dieselMin, 0.05, 1, 8)}–${rngInput('dieselMax', sensRange.dieselMax, 0.05, 1, 8)}</span>
            <span>Steps ${rngInput('steps', sensRange.steps, 1, 3, 10)}</span>
          </div>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead>
              <tr style="background:var(--ies-gray-100);border-bottom:2px solid var(--ies-gray-200);">
                <th style="padding:6px;text-align:center;font-weight:700;">Driver/Diesel</th>
    `;

    dieselPrices.forEach(price => {
      tableHtml += `<th style="padding:6px;text-align:center;font-weight:700;">${calc.formatCurrency(price, { compact: false }).replace('$', '')}</th>`;
    });

    tableHtml += `</tr></thead><tbody>`;

    matrix.matrix.forEach((row, rowIdx) => {
      tableHtml += `<tr><td style="padding:6px;text-align:center;font-weight:700;background:var(--ies-gray-100);">$${driverRates[rowIdx]}</td>`;
      row.forEach((cell, colIdx) => {
        const bgColor = getCellColor(cell.costPerMile);
        const isCurrent = cell.isCurrent;
        const borderStyle = isCurrent ? '2px solid var(--ies-navy)' : '1px solid var(--ies-gray-200)';
        tableHtml += `<td style="padding:6px;text-align:center;border:${borderStyle};background:${bgColor}15;font-weight:${isCurrent ? '700' : '500'};">${cell.costPerMile.toFixed(2)}</td>`;
      });
      tableHtml += `</tr>`;
    });

    tableHtml += `</tbody></table></div>
      <div style="margin-top:12px;font-size:11px;color:var(--ies-gray-600);">
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <span><span style="display:inline-block;width:12px;height:12px;background:#22c55e;margin-right:4px;"></span>Excellent &lt;$2.00/mi</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#fbbf24;margin-right:4px;"></span>Good $2.00-2.50/mi</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#f97316;margin-right:4px;"></span>Fair $2.50-3.00/mi</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#ef4444;margin-right:4px;"></span>High &gt;$3.00/mi</span>
        </div>
        <div style="margin-top:8px;"><strong>Current scenario</strong> shown with navy border.</div>
      </div>
    </div>`;
    return tableHtml;
  } catch (e) {
    console.error('Error rendering sensitivity matrix:', e);
    return '';
  }
}

function renderVolumeSensitivityCard() {
  try {
    const scenarios = calc.calcVolumeSensitivity(lanes, vehicles, config);
    return `
      <div class="hub-card" data-fm-section="sensitivity" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Volume Sensitivity Analysis</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--ies-gray-100);border-bottom:2px solid var(--ies-gray-200);">
              <th style="padding:8px;text-align:left;font-weight:700;">Scenario</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Vehicles</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Annual Cost</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Cost/Mile</th>
              <th style="padding:8px;text-align:right;font-weight:700;">Cost Variance</th>
            </tr>
          </thead>
          <tbody>
            ${scenarios.map(s => `
              <tr style="border-bottom:1px solid var(--ies-gray-200);${Math.abs(s.multiplier - 1.0) < 0.01 ? 'background:var(--ies-blue)08;' : ''}">
                <td style="padding:8px;font-weight:${Math.abs(s.multiplier - 1.0) < 0.01 ? '700' : '500'};">${s.scenario}</td>
                <td style="padding:8px;text-align:right;">${s.totalVehicles}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCurrency(s.totalAnnualCost, { compact: true })}</td>
                <td style="padding:8px;text-align:right;">${calc.formatCpm(s.costPerMile)}</td>
                <td style="padding:8px;text-align:right;${s.variance.cost < 0 ? 'color:#22c55e;' : 'color:#ef4444;'}">${s.variance.cost > 0 ? '+' : ''}${calc.formatCurrency(s.variance.cost, { compact: true })}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    console.error('Error rendering volume sensitivity:', e);
    return '';
  }
}

// FLE-C3 — surface HOS feasibility violations (lanes that don't fit
// the daily driving budget × operating days). Returns '' when feasible.
function renderHosWarnings(r) {
  const v = (r && r.hosViolations) || [];
  if (v.length === 0) return '';
  return `
    <div class="hub-card" data-fm-section="feasibility" style="padding:14px;margin-bottom:20px;border-left:4px solid #ef4444;background:#fef2f2;">
      <div style="font-size:13px;font-weight:700;color:#991b1b;margin-bottom:8px;">⚠ HOS Feasibility Warnings (${v.length})</div>
      <ul style="margin:0;padding-left:18px;font-size:12px;color:#7f1d1d;">
        ${v.map(x => {
          const lane = lanes.find(l => l.id === x.laneId);
          const laneStr = lane ? `${lane.origin} → ${lane.destination}` : x.laneId;
          return `<li><strong>${laneStr}</strong> (${x.vehicleName}) — ${x.message}</li>`;
        }).join('')}
      </ul>
      <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);">Add team driving, split the route, or relax operating-days/HOS daily limit to clear.</div>
    </div>
  `;
}

// FLE-D4 — Break-even mileage chart. Cost-per-mile vs annual miles, with
// crossover annotations between Private vs Dedicated and Private vs Carrier.
function renderBreakEvenCard(r) {
  const be = r.breakEven;
  if (!be) return '';
  const fmt = (v) => v == null ? 'No crossover (Private always wins on $/mi)' : Math.round(v).toLocaleString() + ' mi/yr';
  // Build a simple SVG plot of $/mi vs annual miles using sample x points
  const xMin = 50000;
  const xMax = Math.max(be.currentMiles * 1.5, 1500000);
  const samples = 30;
  const xs = Array.from({ length: samples }, (_, i) => xMin + (xMax - xMin) * (i / (samples - 1)));
  const privateAt = (m) => (be.privateFixed + be.privateVariableCpm * m) / m;
  const dedAt = () => be.dedicatedCpm;
  const carrAt = () => be.carrierCpm;
  const yMax = Math.max(privateAt(xMin), be.dedicatedCpm, be.carrierCpm) * 1.15;
  const yMin = Math.min(...xs.map(privateAt), be.dedicatedCpm, be.carrierCpm) * 0.85;
  const W = 560, H = 200, PADL = 50, PADB = 28, PADT = 12, PADR = 16;
  const xToPx = (x) => PADL + (W - PADL - PADR) * ((x - xMin) / (xMax - xMin));
  const yToPx = (y) => PADT + (H - PADT - PADB) * (1 - (y - yMin) / (yMax - yMin));
  const privPath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${xToPx(x).toFixed(1)},${yToPx(privateAt(x)).toFixed(1)}`).join(' ');
  const dedY = yToPx(be.dedicatedCpm);
  const carrY = yToPx(be.carrierCpm);
  const curX = xToPx(be.currentMiles);
  return `
    <div class="hub-card" data-fm-section="comparison" style="padding:20px;margin-bottom:20px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px;">Break-Even Miles — Private vs Dedicated vs Carrier</div>
      <div style="font-size:12px;color:var(--ies-gray-500);margin-bottom:12px;">Below break-even, Private's fixed costs dominate. Above break-even, Private wins on $/mi.</div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="background:var(--ies-gray-50);border-radius:6px;">
        <line x1="${PADL}" y1="${H - PADB}" x2="${W - PADR}" y2="${H - PADB}" stroke="var(--ies-gray-300)" stroke-width="1"/>
        <line x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${H - PADB}" stroke="var(--ies-gray-300)" stroke-width="1"/>
        <text x="${PADL - 6}" y="${PADT + 6}" font-size="10" text-anchor="end" fill="var(--ies-gray-500)">${yMax.toFixed(2)}</text>
        <text x="${PADL - 6}" y="${H - PADB - 2}" font-size="10" text-anchor="end" fill="var(--ies-gray-500)">${yMin.toFixed(2)}</text>
        <text x="${W / 2}" y="${H - 6}" font-size="10" text-anchor="middle" fill="var(--ies-gray-500)">Annual Miles</text>
        <text x="14" y="${H / 2}" font-size="10" text-anchor="middle" fill="var(--ies-gray-500)" transform="rotate(-90 14 ${H / 2})">$/mi</text>
        <line x1="${PADL}" y1="${dedY}" x2="${W - PADR}" y2="${dedY}" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="4 3"/>
        <line x1="${PADL}" y1="${carrY}" x2="${W - PADR}" y2="${carrY}" stroke="#ef4444" stroke-width="2" stroke-dasharray="4 3"/>
        <path d="${privPath}" fill="none" stroke="var(--ies-blue)" stroke-width="2.5"/>
        <line x1="${curX}" y1="${PADT}" x2="${curX}" y2="${H - PADB}" stroke="var(--ies-gray-400)" stroke-width="1" stroke-dasharray="2 2"/>
        <circle cx="${curX}" cy="${yToPx(privateAt(be.currentMiles))}" r="4" fill="var(--ies-blue)"/>
        <text x="${W - PADR - 4}" y="${dedY - 4}" font-size="10" text-anchor="end" fill="#8b5cf6" font-weight="700">Dedicated $${be.dedicatedCpm.toFixed(2)}/mi</text>
        <text x="${W - PADR - 4}" y="${carrY - 4}" font-size="10" text-anchor="end" fill="#ef4444" font-weight="700">Carrier $${be.carrierCpm.toFixed(2)}/mi</text>
        <text x="${PADL + 6}" y="${PADT + 14}" font-size="10" fill="var(--ies-blue)" font-weight="700">Private (curve) — fixed ÷ miles + variable</text>
      </svg>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px;font-size:12px;">
        <div><div style="color:var(--ies-gray-500);font-size:11px;font-weight:700;text-transform:uppercase;">Current Miles</div><div style="font-weight:700;">${Math.round(be.currentMiles).toLocaleString()}/yr</div></div>
        <div><div style="color:#8b5cf6;font-size:11px;font-weight:700;text-transform:uppercase;">Vs Dedicated Crossover</div><div style="font-weight:700;">${fmt(be.dedicatedCrossoverMiles)}</div></div>
        <div><div style="color:#ef4444;font-size:11px;font-weight:700;text-transform:uppercase;">Vs Carrier Crossover</div><div style="font-weight:700;">${fmt(be.carrierCrossoverMiles)}</div></div>
      </div>
    </div>
  `;
}

function exportFleetCSV() {
  if (!result) return;
  const csv = ['origin,destination,weekly_shipments,vehicle,trips_per_week,annual_miles,cost_per_trip'];
  result.assignments.forEach(a => {
    const lane = lanes.find(l => l.id === a.laneId);
    csv.push(`${lane?.origin || ''},${lane?.destination || ''},${lane?.weeklyShipments || ''},${a.vehicleName},${a.tripsPerWeek},${Math.round(a.annualMiles)},${a.perTripCost.toFixed(2)}`);
  });
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fleet-results.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * X9: Export fleet analysis to XLSX with multiple sheets:
 * - Lanes: input lanes
 * - Vehicles: vehicle specifications
 * - Fleet Composition: vehicle sizing and costs
 * - 3-Way Comparison: private vs dedicated vs carrier
 */
async function exportFleetXLSX() {
  if (!result) {
    showToast('No results to export', 'error');
    return;
  }

  try {
    // Dynamically import XLSX utilities
    const { downloadXLSX } = await import('../../shared/export.js?v=20260418-sM');

    // Prepare sheet data
    const sheets = [];

    // Sheet 1: Lanes
    sheets.push({
      name: 'Lanes',
      rows: lanes.map(l => ({
        'Origin': l.origin,
        'Destination': l.destination,
        'Weekly Shipments': l.weeklyShipments,
        'Avg Weight (lbs)': l.avgWeightLbs,
        'Avg Cube (ft³)': l.avgCubeFt3,
        'Distance (mi)': l.distanceMiles,
      })),
    });

    // Sheet 2: Vehicles
    sheets.push({
      name: 'Vehicles',
      rows: vehicles.map(v => ({
        'Vehicle': v.name,
        'Payload (lbs)': v.maxPayloadLbs,
        'Cube (ft³)': v.maxCubeFt3,
        'MPG': v.mpg,
        'Capital Cost': v.capitalCost,
        'Insurance Factor': v.insuranceFactor,
      })),
    });

    // Sheet 3: Fleet Composition
    sheets.push({
      name: 'Fleet Composition',
      rows: result.fleetComposition.map(f => ({
        'Vehicle': f.vehicleName,
        'Units': f.unitsNeeded,
        'Annual Miles': Math.round(f.annualMiles),
        'Fuel': f.annualFuelCost.toFixed(2),
        'Driver': f.annualDriverCost.toFixed(2),
        'Maintenance': f.annualMaintenanceCost.toFixed(2),
        'Depreciation': f.annualDepreciation.toFixed(2),
        'Insurance': f.annualInsurance.toFixed(2),
        'Admin': (f.annualAdminCost || 0).toFixed(2),
        'Total': f.totalAnnualCost.toFixed(2),
        '$/Mile': f.costPerMile.toFixed(3),
      })),
    });

    // Sheet 4: 3-Way Comparison
    sheets.push({
      name: '3-Way Comparison',
      rows: [
        { 'Model Type': 'Private Fleet', 'Annual Cost': result.comparison.private.toFixed(2), 'Cost/Mile': (result.comparison.private / result.totalAnnualMiles).toFixed(3) },
        { 'Model Type': 'Dedicated (GXO)', 'Annual Cost': result.comparison.dedicated.toFixed(2), 'Cost/Mile': (result.comparison.dedicated / result.totalAnnualMiles).toFixed(3) },
        { 'Model Type': 'Common Carrier', 'Annual Cost': result.comparison.carrier.toFixed(2), 'Cost/Mile': (result.comparison.carrier / result.totalAnnualMiles).toFixed(3) },
      ],
    });

    downloadXLSX({ filename: `fleet-analysis-${Date.now()}.xlsx`, sheets });
    showToast('Fleet analysis exported successfully', 'success');
  } catch (err) {
    console.error('Export error:', err);
    showToast('Export failed', 'error');
  }
}

function kpi(label, value, color) {
  return `
    <div style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}

// ============================================================
// MAP TAB
// ============================================================

function renderMap(el) {
  if (!result) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Calculate fleet first to see route map.</p></div>';
    return;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <h3 class="text-section" style="margin:0;">Route Map</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${lanes.length} lanes • ${result.totalVehicles} vehicles</span>
      </div>
      <div id="fm-map-container" style="flex:1;min-height:500px;border-radius:10px;border:1px solid var(--ies-gray-200);overflow:hidden;"></div>
      <div style="display:flex;gap:16px;margin-top:12px;font-size:11px;color:var(--ies-gray-400);">
        <span><span style="display:inline-block;width:20px;height:3px;background:var(--ies-blue);vertical-align:middle;"></span> Dry Van</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#22c55e;vertical-align:middle;"></span> Reefer</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#f59e0b;vertical-align:middle;"></span> Flatbed</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#8b5cf6;vertical-align:middle;"></span> Straight Truck</span>
        <span><span style="display:inline-block;width:20px;height:3px;background:#ec4899;vertical-align:middle;"></span> Sprinter</span>
      </div>
    </div>
  `;

  // setTimeout(100) so the flex layout settles before L.map(container)
  // measures height. rAF can fire before paint, leaving the container
  // at height=0 and the tile layer silently never requests tiles.
  setTimeout(() => { if (rootEl?.querySelector('#fm-map-container')) initFleetMap(); }, 100);
}

/** Lightweight static geocoder for top US cities — covers all demo lane endpoints. */
const CITY_GEO = {
  'Chicago, IL': [41.85, -87.65],
  'Indianapolis, IN': [39.77, -86.16],
  'St. Louis, MO': [38.63, -90.20],
  'Detroit, MI': [42.33, -83.05],
  'Milwaukee, WI': [43.04, -87.91],
  'Dallas, TX': [32.78, -96.80],
  'Houston, TX': [29.76, -95.37],
  'San Antonio, TX': [29.42, -98.49],
  'Atlanta, GA': [33.75, -84.39],
  'Nashville, TN': [36.16, -86.78],
  'Charlotte, NC': [35.23, -80.84],
  'Memphis, TN': [35.15, -90.05],
  'Columbus, OH': [39.96, -82.99],
  'Cleveland, OH': [41.50, -81.69],
  'Cincinnati, OH': [39.10, -84.51],
  'Philadelphia, PA': [39.95, -75.16],
  'New York, NY': [40.71, -74.01],
  'Boston, MA': [42.36, -71.06],
  'Miami, FL': [25.76, -80.19],
  'Tampa, FL': [27.95, -82.46],
  'Orlando, FL': [28.54, -81.38],
  'Phoenix, AZ': [33.45, -112.07],
  'Los Angeles, CA': [34.05, -118.24],
  'San Diego, CA': [32.72, -117.16],
  'San Francisco, CA': [37.77, -122.42],
  'Seattle, WA': [47.61, -122.33],
  'Portland, OR': [45.52, -122.68],
  'Denver, CO': [39.74, -104.99],
  'Salt Lake City, UT': [40.76, -111.89],
  'Las Vegas, NV': [36.17, -115.14],
  'Minneapolis, MN': [44.98, -93.27],
  'Kansas City, MO': [39.10, -94.58],
  'Oklahoma City, OK': [35.47, -97.52],
  'Savannah, GA': [32.08, -81.10],
};

const VEHICLE_COLORS = {
  'Dry Van': 'var(--ies-blue)',
  'Reefer': '#22c55e',
  'Flatbed': '#f59e0b',
  'Straight Truck': '#8b5cf6',
  'Sprinter': '#ec4899',
};

function initFleetMap() {
  const container = rootEl?.querySelector('#fm-map-container');
  if (!container) return;
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }

  if (typeof L === 'undefined') {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--ies-gray-400);">Map requires Leaflet.js</div>';
    return;
  }

  mapInstance = L.map(container).setView([39.8283, -98.5795], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap'
  }).addTo(mapInstance);

  const allPoints = [];
  let drawn = 0, skipped = 0;
  for (const lane of lanes) {
    const o = CITY_GEO[lane.origin];
    const d = CITY_GEO[lane.destination];
    if (!o || !d) { skipped++; continue; }
    drawn++;
    allPoints.push(o, d);
    const a = (result?.assignments || []).find(x => x.laneId === lane.id);
    const color = VEHICLE_COLORS[a?.vehicleName] || 'var(--ies-blue)';
    const weight = Math.max(1.5, Math.min(6, (lane.weeklyShipments || 1) / 5));
    const line = L.polyline([o, d], { color, weight, opacity: 0.7 }).addTo(mapInstance);
    line.bindPopup(`<strong>${lane.origin} → ${lane.destination}</strong><br>${lane.weeklyShipments}/wk · ${lane.distanceMiles} mi<br>Vehicle: ${a?.vehicleName || '—'}`);
    // Endpoint markers (small dots)
    [o, d].forEach((pt, idx) => {
      L.circleMarker(pt, { radius: 4, fillColor: color, color: '#fff', weight: 1.5, fillOpacity: 0.9 })
        .addTo(mapInstance)
        .bindTooltip(idx === 0 ? lane.origin : lane.destination);
    });
  }

  if (allPoints.length) mapInstance.fitBounds(allPoints, { padding: [30, 30] });

  if (skipped > 0) {
    const info = L.control({ position: 'topright' });
    info.onAdd = () => {
      const div = L.DomUtil.create('div', '');
      div.style.cssText = 'background:#fff;padding:8px 12px;border-radius:6px;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.15);';
      div.innerHTML = `<strong>${drawn}</strong> drawn · <strong>${skipped}</strong> lanes skipped (city not in geo table)`;
      return div;
    };
    info.addTo(mapInstance);
  }
}

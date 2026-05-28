/**
 * IES Hub v3 — Center of Gravity UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Tabs: Points, Analysis, Map, Sensitivity.
 *
 * @module tools/center-of-gravity/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sM';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260526-phaseAs1';
import { RunStateTracker } from '../../shared/run-state.js?v=20260419-uE';
import { downloadCSV } from '../../shared/export.js?v=20260418-sM';
import { markDirty as guardMarkDirty, markClean as guardMarkClean } from '../../shared/unsaved-guard.js?v=20260513-port29';
import * as calc from './calc.js?v=20260528-parcel7';
import * as api from './api.js?v=20260504-auth1';
import * as cmApi from '../cost-model/api.js?v=20260528-cogwriteback1';
import { showConfirm, showPrompt } from '../../shared/confirm-modal.js';

// ============================================================
// CHROME v3 — phase + section structure (CM Chrome v3 ripple, step 3 redo)
// ============================================================
const COG_GROUPS = [
  { key: 'inputs',     label: 'Inputs',     description: 'Demand points + seeds' },
  { key: 'parameters', label: 'Parameters', description: 'k, $/mi, capacity, candidates' },
  { key: 'run',        label: 'Run',        description: 'Numbers, map, sensitivity' },
];
const COG_SECTIONS = [
  { key: 'numbers',     label: '\u{1F4CA} Numbers',     group: 'run' },
  { key: 'map',         label: '\u{1F5FA} Map',         group: 'run' },
  { key: 'sensitivity', label: '\u{1F4C8} Sensitivity', group: 'run' },
  { key: 'compare',     label: '\u{2696}\u{FE0F} Compare',     group: 'run' },
];

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'points' | 'analysis' | 'map' | 'sensitivity'} */
// 2026-04-27 EVE2 (COG-SCOPE-1): activeTab replaced with phase + sub-tab.
//   activePhase: 'inputs' | 'parameters' | 'run'
//   runSubTab:   'numbers' | 'map' | 'sensitivity' (only meaningful when
//                activePhase === 'run')
let activePhase = 'inputs';
let runSubTab = 'numbers';

/** @type {import('./types.js?v=20260418-sP').WeightedPoint[]} */
let points = [];

/** @type {import('./types.js?v=20260418-sP').CogConfig} */
let config = { ...calc.DEFAULT_CONFIG };

/** @type {import('./types.js?v=20260418-sP').MultiCogResult|null} */
let cogResult = null;

/** @type {Array<{ k: number, totalWeightedDistance: number, estimatedCost: number, avgDistance: number }>|null} */
let sensitivityData = null;

/** @type {object|null} */
let mapInstance = null;

// 2026-05-28 C12 — points-table sort state. column = 'name' | 'lat' |
// 'lng' | 'weight' | 'type'; direction = 'asc' | 'desc'. null = original
// (insertion) order.
let _pointsSort = { column: null, direction: 'asc' };

// 2026-05-28 F8 — compare-scenarios state. comparedScenarioIds holds the
// (up to 2) other-scenario IDs the user picked in the Compare view.
// _savedScenariosCache is populated lazily when Compare is first viewed.
let comparedScenarioIds = [];
/** @type {Array<any>|null} */
let _savedScenariosCache = null;

// 2026-05-28 H1 — keyboard shortcut binding guard (document-level listener
// registered once per page-load to avoid double-firing on chrome re-renders).
let _kbShortcutsBound = false;

// 2026-05-28 C5 — undo-on-replace. Holds the previous points[] snapshot
// after archetype / upload / demo replace operations so the toast Undo
// button can restore. Cleared after 60s to avoid stale-state confusion.
/** @type {{ points: any[], at: number, source: string }|null} */
let _lastReplacedPoints = null;

// 2026-05-28 C5 — delegated-click guard for the Undo toast button.
let _undoDelegateBound = false;

// 2026-05-28 D13 — window-resize listener guard (single registration so
// repeated initCogMap calls don't stack listeners).
let _mapResizeListenerBound = false;

// 2026-05-28 C1 — pending upload state. Set after a file is parsed but
// before the user confirms the column mapping. Cleared on cancel or confirm.
/** @type {{ fileName: string, aoa: any[][], headerRow: string[]|null, mapping: object }|null} */
let _pendingUpload = null;

/**
 * Map overlay options — service-zone rings + heatmap toggles with
 * a user-editable radii list (comma-separated miles).
 */
let mapOptions = {
  zones: true,
  heat: true,
  labels: true,
  territories: false,
  pointLabels: false,
  basemap: 'voyager',   // 'voyager' | 'positron' | 'satellite'
  zoneRadiiMiles: [250, 500, 750],
};

// Run-state tracker — flips the header Run button to "✓ Results current"
// once a k-means run completes against a stable input set.
const runState = new RunStateTracker();
function runStateInputs() {
  return { points, config };
}
function updateRunButtonState() {
  if (!rootEl) return;
  // 2026-05-26 — fixed selector. Chrome renders data-tc-action via
  // shared/tool-chrome.js; data-primary-action was a stale legacy hook
  // and silently returned null, leaving the dirty/clean state stuck.
  const btn = rootEl.querySelector('[data-tc-action="cog-run"]');
  if (!btn) return;
  const s = runState.state(runStateInputs());
  const isClean = s === 'clean';
  btn.classList.toggle('is-clean', isClean);
  btn.setAttribute('data-run-state', s);
  const iconSpan = btn.querySelector('.hub-run-icon');
  const labelSpan = btn.querySelector('span:not(.hub-run-icon):not(.hub-run-shortcut)');
  // Stay aligned with the chrome's initial label ('Run'). Prior code flipped
  // to 'Find Optimal Location' on dirty but the selector bug meant it never
  // actually applied — and the empty-state messages referenced the unseen
  // label, confusing users.
  if (labelSpan) labelSpan.textContent = isClean ? '✓ Results current' : 'Run';
  if (iconSpan) iconSpan.style.display = isClean ? 'none' : '';
  btn.setAttribute('title', isClean
    ? 'Inputs unchanged since the last solve — k-means centers match the current points + config. Click to force a re-run.'
    : 'Run k-means (Cmd/Ctrl+Enter)');
}

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Center of Gravity tool.
 * @param {HTMLElement} el
 */
let activeScenarioId = null;
let activeParentCmId = null;
let isDirty = false;            // I-05 — track whether user has unsaved changes

// COG-F4 / COG-F2 — debounced auto-recalc + autosave timers.
// Auto-recalc fires only after the first manual run (so we don't surprise
// users who haven't asked for a result yet). Autosave fires only on
// already-saved scenarios (activeScenarioId set) — a brand-new scenario
// still demands a name via the prompt() flow on the first manual save.
let _autoRunTimer = null;
let _autoSaveTimer = null;
const AUTO_RUN_DELAY_MS = 600;
const AUTO_SAVE_DELAY_MS = 1500;
let _autoSaveInFlight = false;

export async function mount(el) {
  rootEl = el;
  await renderLanding();
}

async function renderLanding() {
  if (!rootEl) return;
  await renderScenarioLanding(rootEl, {
    toolName: 'Center of Gravity',
    toolKey: 'cog',
    accent: '#20c997',
    list: () => api.listScenarios(),
    getId: (r) => r.id,
    getName: (r) => r.name || r.scenario_data?.name || 'Untitled COG analysis',
    getUpdated: (r) => r.updated_at || r.created_at,
    getParent: (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id }),
    getSubtitle: (r) => {
      const d = r.scenario_data || {};
      const cfg = d.config || {};
      const nPoints = (d.points || []).length;
      const k = cfg.k || d.k;
      const result = d.result || null;
      const nCenters = result?.centers?.length || 0;
      // 2026-05-28 F2 — prepend Deal Context when present.
      const ctxParts = [];
      if (cfg.customerName) ctxParts.push(cfg.customerName);
      const indMatch = calc.INDUSTRY_OPTIONS.find(o => o.value && o.value === cfg.industry);
      if (indMatch) ctxParts.push(indMatch.label);
      const stageMatch = calc.DEAL_STAGES.find(o => o.value && o.value === cfg.dealStage);
      if (stageMatch) ctxParts.push(stageMatch.label);
      const ctxPrefix = ctxParts.length > 0 ? `${ctxParts.join(' · ')} — ` : '';
      // Prefer the most informative subtitle. Some scenarios are seeded with
      // results only (no points array) — for those, fall back to the result
      // shape rather than rendering "0 demand points" or empty.
      if (nPoints > 0) {
        return `${ctxPrefix}${nPoints} demand points${k ? ` · ${k}-DC analysis` : ''}`;
      }
      if (nCenters > 0) {
        const totalCost = Number(result?.totalCost) || 0;
        const costStr = totalCost > 0 ? ` · $${(totalCost / 1e6).toFixed(1)}M` : '';
        return `${ctxPrefix}${nCenters} center${nCenters === 1 ? '' : 's'} (results only)${costStr}`;
      }
      if (k) return `${ctxPrefix}${k}-DC analysis (no points yet)`;
      return ctxPrefix.slice(0, -3) || '';  // strip trailing ' — '
    },
    onNew: () => openEditor(null),
    onOpen: (row) => openEditor(row),
    onDelete: async (row) => { await api.deleteScenario(row.id); },
    onCopy: async (row) => { await api.duplicateScenario(row.id); },
    onLink: async (row, cmId) => { await api.linkToCm(row.id, cmId); },
    onUnlink: async (row) => { await api.unlinkFromCm(row.id); },
    emptyStateHint: 'Find optimal facility locations from weighted demand. Cluster, centroid solver, sensitivity vs k-DC count, and a service-zone map overlay.',
  });
}

function openEditor(savedRow) {
  if (!rootEl) return;
  const d = savedRow?.scenario_data || {};
  activePhase = 'inputs';
  runSubTab = 'numbers';
  // 2026-04-21 audit fix: new scenarios start EMPTY. Demo points still
  // reachable via the "Load Demo" button on the Points tab (seedDemo action)
  // and the Archetypes dropdown. Prior behavior auto-loaded 12 US metros
  // which confused users into thinking the tool was in demo mode.
  points = (d.points && d.points.length) ? d.points.map(p => ({ ...p })) : [];
  config = { ...calc.DEFAULT_CONFIG, ...(d.config || {}) };
  cogResult = d.result || null;
  sensitivityData = null;
  activeScenarioId = savedRow?.id || null;
  activeParentCmId = savedRow?.parent_cost_model_id || null;
  // I-05 — fresh open is clean; only run/edit/etc marks dirty.
  isDirty = false;
  _scenarioName = savedRow?.name || d.name || '';
  // If the saved scenario has a result that's missing downstream fields
  // (assignments + the per-center-weighted-distance shape renderAnalysis /
  // renderMap expect), rebuild it from points+config so the full Analysis
  // and Map tabs render instead of erroring silently. Covers scenarios
  // that were seeded via SQL with only a summary result payload.
  if (cogResult && points.length > 0 &&
      (!Array.isArray(cogResult.assignments) || !cogResult.assignments.length)) {
    try {
      const _solvePts = _pointsForSolve();
      cogResult = calc.kMeansCog(_solvePts, config.numCenters, config.maxIterations, config.kmeansRestarts ?? 10, (config.snapToCandidates ? (config.candidateFacilities || []).filter(c => c.locked) : []));
      if (config.snapToCandidates && (config.candidateFacilities || []).length > 0) {
        cogResult = calc.snapCentersToCandidates(cogResult, _solvePts, config.candidateFacilities);
      }
      calc.applyCapacityConstraints(cogResult, _solvePts, config.capacityPerDC ?? 0);
      _enrichCogResultWithCost(cogResult, _solvePts);
      calc.flagServiceViolations(cogResult, _solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
      sensitivityData = calc.sensitivityAnalysis(_solvePts, Math.max(config.numCenters, config.sensitivityMaxK ?? 8), config);
    } catch (err) {
      console.warn('[COG] Result rebuild from saved inputs failed; falling back to partial render:', err);
    }
  }
  // New editor session — drop the prior scenario's run-state baseline.
  // If the loaded scenario has a result, treat the loaded inputs as the
  // baseline (saved row's centers were computed against saved inputs).
  runState.reset();
  if (cogResult) runState.markClean(runStateInputs());

  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderContent();
}

/** I-05 — mark editor dirty + refresh the Save button state without a full re-render. */
let _scenarioName = '';
function markDirty() {
  // Run-state check runs regardless of isDirty short-circuit — a repeat edit
  // against a clean run still needs to flip the Run button back to orange.
  updateRunButtonState();
  // COG-F4 — schedule a debounced auto-recompute if there's already a result
  // on screen (don't surprise users who haven't run yet).
  scheduleAutoRun();
  // COG-F2 — schedule a debounced autosave for already-saved scenarios.
  scheduleAutoSave();
  if (isDirty) return;
  isDirty = true;
  guardMarkDirty('cog');
  updateHeaderSaveState();
}

/**
 * COG-F4 — recompute centers + sensitivity in place without a full re-render
 * of the editor shell. Mirrors the body of the `cog-run` click handler.
 */
function runOptimizeAndRender() {
  if (!rootEl) return;
  const _solvePts = _pointsForSolve();
  if (!_solvePts.length) return; // nothing to solve against
  cogResult = calc.kMeansCog(_solvePts, config.numCenters, config.maxIterations, config.kmeansRestarts ?? 10, (config.snapToCandidates ? (config.candidateFacilities || []).filter(c => c.locked) : []));
      if (config.snapToCandidates && (config.candidateFacilities || []).length > 0) {
        cogResult = calc.snapCentersToCandidates(cogResult, _solvePts, config.candidateFacilities);
      }
  calc.applyCapacityConstraints(cogResult, _solvePts, config.capacityPerDC ?? 0);
  _enrichCogResultWithCost(cogResult, _solvePts);
  calc.flagServiceViolations(cogResult, _solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
  sensitivityData = calc.sensitivityAnalysis(_solvePts, Math.max(config.numCenters, config.sensitivityMaxK ?? 8), config);
  runState.markClean(runStateInputs());
  updateRunButtonState();
  // Re-render content without flipping tabs out from under the user.
  renderContent();
}

/**
 * 2026-05-28 C5 — Stash current points[] before a replace so the user
 * can undo via toast. `source` is a human label for the disclosure.
 */
function _snapshotForUndo(source) {
  _lastReplacedPoints = {
    points: points.map(p => ({ ...p })),
    at: Date.now(),
    source,
  };
  // Auto-clear after 60s so we don't dangle stale state forever.
  setTimeout(() => {
    if (_lastReplacedPoints && (Date.now() - _lastReplacedPoints.at) >= 60000) {
      _lastReplacedPoints = null;
    }
  }, 60000);
}

/**
 * 2026-05-28 C5 — restore points[] from the undo slot. Called by the
 * Undo button on replace toasts.
 */
function _undoReplace() {
  if (!_lastReplacedPoints) return;
  points = _lastReplacedPoints.points;
  const source = _lastReplacedPoints.source;
  _lastReplacedPoints = null;
  markDirty();
  if (rootEl) {
    const inputsEl = rootEl.querySelector('#cog-content');
    if (inputsEl && activePhase === 'inputs') renderInputsPhase(inputsEl);
    else {
      rootEl.innerHTML = renderShell();
      bindShellEvents();
      renderContent();
    }
  }
  showToast(`Undid ${source} — restored ${points.length} point${points.length === 1 ? '' : 's'}.`, 'ok');
}

/**
 * COG-F4 — debounce auto-recalc. Fires only when a result is already on
 * screen so the first run remains explicit.
 */
function scheduleAutoRun() {
  if (!cogResult) return;
  if (_autoRunTimer) clearTimeout(_autoRunTimer);
  _autoRunTimer = setTimeout(() => {
    _autoRunTimer = null;
    try { runOptimizeAndRender(); } catch (err) { console.error('[COG] auto-recalc failed:', err); }
  }, AUTO_RUN_DELAY_MS);
}

/**
 * COG-F2 — debounced autosave. Fires only when activeScenarioId is set
 * (i.e., the scenario already has a name + DB row). Brand-new scenarios
 * still go through the showPrompt() flow on the first save.
 */
function scheduleAutoSave() {
  if (!activeScenarioId) return;
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    _autoSaveTimer = null;
    if (_autoSaveInFlight) return;
    _autoSaveInFlight = true;
    try {
      // Wait for any pending auto-run to settle so we save the freshest result.
      if (_autoRunTimer) {
        clearTimeout(_autoRunTimer);
        _autoRunTimer = null;
        try { runOptimizeAndRender(); } catch (_) { /* swallow */ }
      }
      const payload = {
        id: activeScenarioId,
        name: _scenarioName,
        points,
        config,
        result: cogResult,
      };
      await api.saveScenario(payload);
      isDirty = false;
      guardMarkClean('cog');
      updateHeaderSaveState();
    } catch (err) {
      // Silent failure on autosave — keep the dirty flag so the user can
      // still hit the manual Save button. Console-log for diagnostics.
      console.error('[COG] autosave failed:', err);
    } finally {
      _autoSaveInFlight = false;
    }
  }, AUTO_SAVE_DELAY_MS);
}
function updateHeaderSaveState() {
  if (!rootEl) return;
  const btn = rootEl.querySelector('[data-tc-action="cog-save"]');
  if (!btn) return;
  btn.removeAttribute('disabled');
  btn.textContent = isDirty ? (activeScenarioId ? '💾 Save' : '💾 Save Scenario') : (activeScenarioId ? '✓ Saved' : '💾 Save Scenario');
  btn.classList.toggle('hub-btn-primary', isDirty);
  btn.classList.toggle('hub-btn-secondary', !isDirty);
  // Also flip the Draft → Saved status chip in place without full re-render.
  const draftChip = rootEl.querySelector('.hub-status-chip.draft, .hub-status-chip.saved');
  if (draftChip) {
    draftChip.classList.toggle('saved', !!activeScenarioId);
    draftChip.classList.toggle('draft', !activeScenarioId);
    draftChip.textContent = activeScenarioId ? 'Saved' : 'Draft';
  }
}

/**
 * I-05 — persist the current editor state. For new scenarios, prompts
 * for a name; for existing, overwrites in place. Flips Draft → Saved
 * chip + primary-button state on success.
 */
async function handleSave() {
  try {
    let name = _scenarioName;
    if (!activeScenarioId) {
      // 2026-04-30 NIGHT: window.prompt suspends the renderer (same class as
      // native confirm) — use the async showPrompt modal instead.
      const defaultName = name || `COG ${new Date().toLocaleDateString()}`;
      const entered = await showPrompt('Name this scenario:', defaultName);
      if (entered === null) return;                          // user cancelled
      name = (entered || '').trim() || defaultName;
    }
    const payload = {
      id: activeScenarioId || undefined,
      name,
      points,
      config,
      result: cogResult,
    };
    const saved = await api.saveScenario(payload);
    activeScenarioId = saved?.id || activeScenarioId;
    _scenarioName = saved?.name || name;
    isDirty = false;
    guardMarkClean('cog');
    // Re-render shell so status chip + button classes come through cleanly.
    // 2026-05-26 — also re-bind chrome events. innerHTML replacement
    // doesn't kill the rootEl-level click delegate, but other paths
    // (onPhase, onSection) re-bind here, so do the same to stay
    // consistent and immune to future refactors that move listeners
    // off the rootEl itself.
    rootEl.innerHTML = renderShell();
    bindShellEvents();
    renderContent();
    showToast(`Saved "${_scenarioName}".`, 'ok');

    // 2026-05-28 G2 — CM writeback. When this COG scenario is linked to a
    // parent cost model (via activeParentCmId / parent_cost_model_id), push
    // the result summary into the CM's project_data under linkedCogFacts so
    // the CM can render "COG says $X/yr · Y% coverage · Z tons CO₂" without
    // re-running COG. Best-effort: writeback failure is non-blocking.
    if (activeParentCmId && cogResult) {
      try {
        // Compute the vs-current-state delta if available.
        let deltaVsCurrent = null;
        const csList = (config.currentStateDCs || []).filter(d => Number.isFinite(+d.lat) && Number.isFinite(+d.lng));
        if (csList.length > 0) {
          const solvePts = _pointsForSolve();
          const csMcr = calc.buildMcrFromDcList(csList, solvePts);
          if (csMcr) {
            const csCost = calc.estimateTransportCost(csMcr, solvePts, _resolveCpm(), config.unitsPerTruck || 25000, config.roundTripFactor ?? 2.0, config.roadFactor ?? 1.22);
            calc.flagServiceViolations(csMcr, solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
            const csCo2 = (csCost.totalTruckMiles || 0) * (config.co2KgPerTruckMile ?? 1.62) / 1000;
            const propCost = cogResult.totalCost || 0;
            const propCo2 = cogResult.co2Tons || 0;
            deltaVsCurrent = {
              currentNCenters: csList.length,
              currentCost: csCost.totalCost,
              currentCo2Tons: csCo2,
              currentCoveragePct: csMcr.serviceStats?.maxMiles > 0 ? csMcr.serviceStats.coveragePct : null,
              costDelta: csCost.totalCost - propCost,
              costDeltaPct: csCost.totalCost > 0 ? ((csCost.totalCost - propCost) / csCost.totalCost * 100) : 0,
              co2Delta: csCo2 - propCo2,
              co2DeltaPct: csCo2 > 0 ? ((csCo2 - propCo2) / csCo2 * 100) : 0,
              coverageDelta: (csMcr.serviceStats?.maxMiles > 0 && cogResult.serviceStats?.maxMiles > 0)
                ? (cogResult.serviceStats.coveragePct - csMcr.serviceStats.coveragePct)
                : null,
            };
          }
        }

        const cogFacts = {
          scenarioId: activeScenarioId,
          scenarioName: _scenarioName,
          customerName: config.customerName || '',
          industry: config.industry || '',
          dealStage: config.dealStage || '',
          nCenters: cogResult.centers.length,
          kRequested: config.numCenters,
          totalCost: cogResult.totalCost || 0,
          totalTruckMiles: cogResult.totalTruckMiles || 0,
          totalTruckloads: cogResult.totalTruckloads || 0,
          co2Tons: cogResult.co2Tons || 0,
          serviceCoveragePct: cogResult.serviceStats?.coveragePct ?? null,
          maxServiceMiles: config.maxServiceMiles || 0,
          peakUtilization: cogResult.capacityStats?.peakUtilization ?? null,
          capacityPerDC: config.capacityPerDC || 0,
          avgWeightedDistance: cogResult.totalWeightedDistance / Math.max(1, (points || []).reduce((s, p) => s + (p.weight || 0), 0)),
          params: {
            transportCostPerMile: config.transportCostPerMile,
            roadFactor: config.roadFactor ?? 1.22,
            roundTripFactor: config.roundTripFactor ?? 2.0,
            weightUnit: config.weightUnit || 'lb',
            unitsPerTruck: config.unitsPerTruck || 25000,
            fixedCostPerDC: config.fixedCostPerDC || 0,
          },
          centerSummaries: cogResult.centers.map((c, i) => ({
            label: c.candidateLabel || c.nearestCity || `Center ${i + 1}`,
            lat: c.lat, lng: c.lng,
            weight: c.totalWeight || 0,
            avgDistance: c.avgWeightedDistance || 0,
            cost: Array.isArray(cogResult.costByCluster) ? (cogResult.costByCluster[i] || 0) : 0,
          })),
          deltaVsCurrent,
        };
        await cmApi.applyCogWriteback(activeParentCmId, cogFacts);
        showToast(`COG facts written to Cost Model #${activeParentCmId}`, 'info');
      } catch (writebackErr) {
        console.warn('[COG] CM writeback failed (non-blocking):', writebackErr);
        showToast('COG saved, but CM writeback failed — see console.', 'warn');
      }
    }
  } catch (err) {
    console.error('[COG] save failed:', err);
    showToast(`Save failed: ${err.message || err}`, 'err');
  }
}

/**
 * Cleanup.
 */
export function unmount() {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  runState.reset();
  rootEl = null;
}

// ============================================================
// SHELL
// ============================================================

// 2026-05-28 B3 — single accessor for "what $/mi should we use right now".
// When modeMixEnabled is on, returns the mode-weighted effective rate;
// otherwise returns the legacy single transportCostPerMile. Used by all
// estimateTransportCost + sensitivityAnalysis call sites so flipping
// the mode toggle works without touching every caller.
function _resolveCpm() {
  if (config.modeMixEnabled) {
    // 2026-05-28 — use formula-adjusted variant so road×rt doesn't
    // double-count the parcel slice. See calc.effectiveCpmForFormula
    // docstring for the why.
    return calc.effectiveCpmForFormula(
      config.modeMix,
      config.modeRates,
      config.roadFactor ?? 1.22,
      config.roundTripFactor ?? 2.0,
    );
  }
  return config.transportCostPerMile;
}

// 2026-05-26 — Single source of cost truth. Stamp cost fields onto cogResult
// so chrome KPI, Analysis-tab tiles, and the per-row table all read the same
// numbers and all reflect the round-trip factor. Without this, kMeansCog
// alone produces no cost — chrome shows '—' and the per-row table runs its
// own one-way formula that disagrees with the Analysis-tab totals.
function _enrichCogResultWithCost(result, solvePts) {
  if (!result || !Array.isArray(result.centers)) return result;
  try {
    // 2026-05-28 27b — route through estimateBlendedCost which handles
    // legacy (modeMixEnabled=false) and parcel-aware (on) paths.
    const costEst = calc.estimateBlendedCost(result, solvePts, config);
    result.totalCost = costEst.totalCost;
    result.truckCost = costEst.truckCost;
    result.parcelCost = costEst.parcelCost;
    result.totalTruckloads = costEst.totalTruckloads;
    result.avgCostPerUnit = costEst.avgCostPerUnit;
    result.costByCluster = costEst.costByCluster;
    result.truckCostByCluster = costEst.truckCostByCluster;
    result.parcelCostByCluster = costEst.parcelCostByCluster;
    result.costByAssignment = costEst.costByAssignment;
    result.parcelDetails = costEst.parcelDetails;
    // CO₂ driven by TRUCK truck-miles only; parcel emissions are baked
    // into carrier rates and not exposed separately by FedEx/UPS.
    result.totalTruckMiles = costEst.totalTruckMiles;
    const co2Intensity = Math.max(0, +config.co2KgPerTruckMile || 1.62);
    result.co2Kg = (costEst.totalTruckMiles || 0) * co2Intensity;
    result.co2Tons = result.co2Kg / 1000;
  } catch (err) {
    console.warn('[COG] cost enrichment failed:', err);
  }
  return result;
}

function _pointsForSolve() {
  // H1: optionally winsorize point weights to a percentile cap before
  // running k-means / sensitivity. Mitigates a single mega-shipper
  // dominating the centroid in real customer data.
  // 2026-05-26 — also filter out type='excluded' rows (and any null-coord
  // rows defensively). These come from XLS uploads where the ZIP couldn't
  // be resolved or units were missing/invalid; they live in points[] so
  // the user can see them in the table, but they would NaN out the math.
  let live = points.filter(p => p.type !== 'excluded' && p.lat != null && p.lng != null);
  // 2026-05-26 — Exclude Alaska & Hawaii from the solve when the toggle is
  // on. AK lat ~51-71, lng ~-180 to -130. HI lat ~18-23, lng ~-161 to -154.
  // Use generous bounding boxes; cleaner than testing each point against
  // every state polygon. PR (lat ~18, lng -67) is in the HI box's longitude
  // but VERY different latitude, so guard separately.
  if (config.excludeOffshore) {
    live = live.filter(p => {
      const inAK = (p.lat >= 51 && p.lat <= 72) && (p.lng >= -180 && p.lng <= -130);
      const inHI = (p.lat >= 18 && p.lat <= 23) && (p.lng >= -161 && p.lng <= -154);
      return !inAK && !inHI;
    });
  }
  if (config.outlierCapEnabled) {
    return calc.capWeightsByPercentile(live, config.outlierCapPercentile || 95);
  }
  return live;
}

function renderShell() {
  // CM Chrome v3 ripple — chrome HTML+CSS lives in shared/tool-chrome.js.
  return renderToolChrome(_buildCogChromeOpts());
}

/** Build chrome opts from current CoG state. */
function _buildCogChromeOpts() {
  const draft = !activeScenarioId;
  const modified = !!activeScenarioId && isDirty;
  const stateName = draft ? 'draft' : (modified ? 'modified' : 'saved');
  const stateTitle = draft
    ? 'Brand-new scenario — Save to capture an audit timestamp'
    : (modified ? 'Save to capture the latest changes' : 'Saved');

  const runStateClass = runState.state(runStateInputs());

  const actions = [
    { id: 'cog-save',
      label: activeScenarioId ? '\u{1F4BE} Save' : '\u{1F4BE} Save Scenario',
      title: activeScenarioId ? 'Update this scenario' : 'Save this scenario to open it again later',
      primary: modified },
    { id: 'cog-run',
      label: 'Run',
      icon: '▶',
      title: 'Run k-means center-of-gravity (Cmd/Ctrl+Enter)',
      kind: 'primary',
      runState: runStateClass,
      cleanLabel: '✓ Results current',
      cleanTitle: 'Inputs unchanged since the last solve — click to force a re-run.' },
  ];

  const sidebarFooter = activeParentCmId
    ? 'Linked to Cost Model #' + activeParentCmId
    : '';

  // Active section: only meaningful in run phase (mirrors runSubTab).
  const activeSection = activePhase === 'run' ? runSubTab : null;

  return {
    toolKey: 'cog',
    groups: COG_GROUPS,
    sections: COG_SECTIONS,
    activePhase,
    activeSection,
    sectionCompleteness: _cogSectionCompleteness,
    saveState: { state: stateName, title: stateTitle },
    actions,
    showSidebar: false,
    showSidebarToggle: false,
    sidebarHeader: 'All Sections',
    sidebarBody: '',
    sidebarFooter,
    bodyHtml: '<div id="cog-content" style="overflow-y:auto;padding:24px;height:100%;"></div>',
    backTitle: 'Back to scenarios',
    emptyPhaseHint: activePhase === 'run' ? '' : 'Single-canvas phase — switch to Run for sub-views',
  };
}

function _cogSectionCompleteness(key) {
  if (key === 'numbers' || key === 'map' || key === 'sensitivity') {
    return cogResult ? 'complete' : 'empty';
  }
  return 'empty';
}

/** Compute KPI strip values for the CoG chrome. */
function _computeCogKpis() {
  const items = [];
  // Centers (k from current config; "result" k after a run)
  const k = (cogResult && cogResult.centers ? cogResult.centers.length : (config?.numCenters || 0));
  items.push({
    label: 'Centers',
    value: k > 0 ? String(k) : '—',
    hint: cogResult ? 'Optimal centers from the most recent solve.' : 'Configured k — run to compute optimal centers.',
  });
  items.push({
    label: 'Demand Pts',
    value: points.length > 0 ? String(points.length) : '—',
    hint: 'Demand points in the input set.',
  });
  // Total weighted cost — from cogResult if available.
  let totalCostStr = '—';
  if (cogResult && typeof cogResult.totalCost === 'number') {
    const tc = cogResult.totalCost;
    if (tc >= 1e6) totalCostStr = '$' + (tc / 1e6).toFixed(2) + 'M';
    else if (tc >= 1e3) totalCostStr = '$' + (tc / 1e3).toFixed(0) + 'K';
    else totalCostStr = '$' + tc.toFixed(0);
  }
  items.push({
    label: 'Weighted Cost',
    value: totalCostStr,
    hint: 'Sum of weighted distances × $/mi from the most recent solve.',
  });
  // Recommended k from sensitivity.
  let recK = '—';
  if (Array.isArray(sensitivityData) && sensitivityData.length > 0) {
    const flagged = sensitivityData.find(d => d.isRecommended) || sensitivityData.find(d => d.recommended);
    if (flagged) recK = String(flagged.k);
    else {
      const min = sensitivityData.reduce((m, d) => (m == null || (d.totalCost != null && d.totalCost < m.totalCost)) ? d : m, null);
      if (min) recK = String(min.k);
    }
  }
  items.push({
    label: 'Recommended k',
    value: recK,
    hint: 'k value with the lowest weighted-cost from the sensitivity sweep.',
  });
  // 2026-05-28 — Service coverage KPI (B7). Only meaningful when
  // maxServiceMiles is set; otherwise show '—'.
  let svcStr = '—';
  let svcHint = 'Set Max service mi in Parameters to flag out-of-SLA assignments.';
  if (cogResult && cogResult.serviceStats && cogResult.serviceStats.maxMiles > 0) {
    const pct = cogResult.serviceStats.coveragePct;
    svcStr = `${pct.toFixed(1)}%`;
    svcHint = `Share of demand weight within ${cogResult.serviceStats.maxMiles} road-mi of its assigned DC. ${cogResult.serviceStats.outCount} of ${cogResult.serviceStats.outCount + cogResult.serviceStats.coveredCount} points out of SLA.`;
  }
  items.push({
    label: 'Service Coverage',
    value: svcStr,
    hint: svcHint,
  });
  // 2026-05-28 — Peak utilization KPI (B6). Only meaningful when
  // capacityPerDC > 0; otherwise show '—'.
  let utilStr = '—';
  let utilHint = 'Set Capacity / DC in Parameters to track utilization.';
  if (cogResult && cogResult.capacityStats && cogResult.capacityStats.capacityPerDC > 0) {
    const pk = cogResult.capacityStats.peakUtilization;
    utilStr = `${pk.toFixed(0)}%`;
    if (cogResult.capacityStats.stillOver) utilStr += ' ⚠';
    utilHint = `Peak cluster utilization against ${cogResult.capacityStats.capacityPerDC.toLocaleString()} cap. ${cogResult.capacityStats.reassignmentCount} reassignments walked.${cogResult.capacityStats.stillOver ? ' STILL OVER — raise k or cap.' : ''}`;
  }
  items.push({
    label: 'Peak Util',
    value: utilStr,
    hint: utilHint,
  });
  // 2026-05-28 B20 — Annual CO₂ KPI. Reads cogResult.co2Tons stamped by
  // _enrichCogResultWithCost; falls back to '—' when no result.
  let co2Str = '—';
  let co2Hint = 'CO₂ tons/yr from total truck-miles × emissions intensity (Parameters → CO₂ kg/truck-mi).';
  if (cogResult && typeof cogResult.co2Tons === 'number' && cogResult.co2Tons >= 0) {
    const t = cogResult.co2Tons;
    if (t >= 1000) co2Str = (t / 1000).toFixed(1) + ' kt';
    else if (t >= 1) co2Str = t.toFixed(0) + ' t';
    else co2Str = (t * 1000).toFixed(0) + ' kg';
    co2Hint = `${(cogResult.totalTruckMiles || 0).toLocaleString(undefined, {maximumFractionDigits:0})} truck-mi × ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi`;
  }
  items.push({
    label: 'Annual CO₂',
    value: co2Str,
    hint: co2Hint,
  });
  return items;
}

function _refreshCogKpis() {
  if (!rootEl) return;
  refreshKpiStrip(rootEl, _computeCogKpis());
}

// 2026-04-27 EVE2 (COG-SCOPE-1): phase status driven by current state.
function cogPhaseStatus() {
  const inputsComplete = points.length > 0;
  const runComplete = !!cogResult;
  return {
    inputs:     inputsComplete ? 'complete' : 'active',
    parameters: runComplete ? 'complete' : (inputsComplete ? 'active' : 'pending'),
    run:        runComplete ? 'complete' : (inputsComplete ? 'active' : 'pending'),
  };
}

function renderCogStepper() {
  // CM Chrome v3 ripple — in-canvas phase stepper dropped. Stub kept so
  // existing call sites don't crash.
  return;
}

async function bindShellEvents() {
  if (!rootEl) return;
  rootEl.__tcBound = false;

  bindToolChromeEvents(rootEl, {
    onPhase: (phase) => {
      if (!phase || phase === activePhase) return;
      activePhase = /** @type {any} */ (phase);
      // Default sub-tab on phase change to run → numbers.
      if (activePhase === 'run' && !runSubTab) runSubTab = 'numbers';
      rootEl.innerHTML = renderShell();
      bindShellEvents();
      renderContent();
      _refreshCogKpis();
    },
    onSection: (key) => {
      if (!key) return;
      // CoG sections only exist in the run phase (numbers/map/sensitivity).
      const sec = COG_SECTIONS.find(s => s.key === key);
      if (!sec) return;
      activePhase = sec.group;
      runSubTab = key;
      rootEl.innerHTML = renderShell();
      bindShellEvents();
      renderContent();
      _refreshCogKpis();
    },
    onBack: async () => {
      if (isDirty && !(await showConfirm('You have unsaved changes. Leave anyway?'))) return;
      guardMarkClean('cog');
      await renderLanding();
    },
    onAction: (id) => {
      if (id === 'cog-save') return handleSave();
      if (id === 'cog-run') {
        // 2026-05-28 H7 — show 'Solving…' on the Run button before the
        // sync solve kicks off. requestAnimationFrame yields one paint
        // so the user sees the spinner-ish state on big datasets. For
        // <1000 points it's basically instant.
        const runBtn = rootEl?.querySelector('[data-tc-action="cog-run"]');
        const labelSpan = runBtn?.querySelector('span:not(.hub-run-icon):not(.hub-run-shortcut)');
        const prevLabel = labelSpan?.textContent;
        if (labelSpan) labelSpan.textContent = '⏳ Solving…';
        if (runBtn) /** @type {HTMLElement} */ (runBtn).setAttribute('aria-busy', 'true');
        requestAnimationFrame(() => {
          try {
            const _solvePts = _pointsForSolve();
            cogResult = calc.kMeansCog(_solvePts, config.numCenters, config.maxIterations, config.kmeansRestarts ?? 10, (config.snapToCandidates ? (config.candidateFacilities || []).filter(c => c.locked) : []));
            if (config.snapToCandidates && (config.candidateFacilities || []).length > 0) {
              cogResult = calc.snapCentersToCandidates(cogResult, _solvePts, config.candidateFacilities);
            }
            calc.applyCapacityConstraints(cogResult, _solvePts, config.capacityPerDC ?? 0);
            _enrichCogResultWithCost(cogResult, _solvePts);
            calc.flagServiceViolations(cogResult, _solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
            sensitivityData = calc.sensitivityAnalysis(_solvePts, Math.max(config.numCenters, config.sensitivityMaxK ?? 8), config);
            activePhase = 'run';
            runSubTab = 'numbers';
            runState.markClean(runStateInputs());
            markDirty();
            updateRunButtonState();
            rootEl.innerHTML = renderShell();
            bindShellEvents();
            renderContent();
            _refreshCogKpis();
            flashPrimaryAction(rootEl);
          } catch (err) {
            console.error('[COG] run failed:', err);
            showToast(`Run failed: ${err.message || err}`, 'err');
            // Restore the prior button label on failure.
            if (labelSpan && prevLabel != null) labelSpan.textContent = prevLabel;
            if (runBtn) runBtn.removeAttribute('aria-busy');
          }
        });
        return;
      }
    },
    onPrimaryShortcut: () => {
      // Re-use onAction's cog-run path to avoid duplicating run logic.
      const handlers = { onAction: (id) => {} };
      // Direct dispatch.
      const fakeEvent = new Event('click');
      const btn = rootEl?.querySelector('[data-tc-action="cog-run"]');
      if (btn) btn.dispatchEvent(fakeEvent);
    },
  });

  // 2026-05-28 H1 — keyboard shortcuts. Single document-level listener,
  // gated so it only fires when COG is the active tool + no input is
  // focused (don't hijack typing into a textarea). Wired via a guard
  // flag so we don't double-register on re-bind.
  if (!_kbShortcutsBound) {
    _kbShortcutsBound = true;
    document.addEventListener('keydown', (e) => {
      if (!rootEl || !document.body.contains(rootEl)) return;
      // Ignore when typing into an input / textarea / select.
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      // Ignore meta combos — Cmd+Enter is handled by the chrome primary
      // shortcut; Cmd+S we don't want to swallow.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = (e.key || '').toLowerCase();
      const phaseMap = { '1': 'inputs', '2': 'parameters', '3': 'run' };
      const subTabMap = { n: 'numbers', m: 'map', v: 'sensitivity', c: 'compare' };
      if (phaseMap[k]) {
        e.preventDefault();
        activePhase = /** @type {any} */ (phaseMap[k]);
        if (activePhase === 'run' && !runSubTab) runSubTab = 'numbers';
        rootEl.innerHTML = renderShell();
        bindShellEvents();
        renderContent();
        _refreshCogKpis();
      } else if (subTabMap[k] && activePhase === 'run') {
        e.preventDefault();
        runSubTab = subTabMap[k];
        rootEl.innerHTML = renderShell();
        bindShellEvents();
        renderContent();
        _refreshCogKpis();
      } else if (k === 'a' && activePhase === 'inputs') {
        e.preventDefault();
        // Add an empty point (matches the Blank button on Seeders).
        points.push({ id: 'p' + Date.now(), name: 'New Point', lat: 39.83, lng: -98.58, weight: 10000, type: 'demand' });
        markDirty();
        const inputsEl = rootEl.querySelector('#cog-content');
        if (inputsEl) renderInputsPhase(inputsEl);
      } else if (k === 's') {
        e.preventDefault();
        handleSave();
      } else if (k === 'e' && cogResult) {
        e.preventDefault();
        exportCogAnalysis();
      } else if (k === 'p' && cogResult) {
        e.preventDefault();
        openPrintView();
      } else if (k === '?') {
        e.preventDefault();
        showToast('Shortcuts: 1/2/3 = Inputs/Parameters/Run · N/M/V/C = Numbers/Map/Sensitivity/Compare · A = add point · S = save · E = export CSV · P = print/PDF · Cmd+Enter = Run', 'info');
      }
    });
  }

  // 2026-05-28 C5 — delegated handler for the Undo button in replace toasts.
  // The toast is rendered outside rootEl by shared/toast.js so we attach
  // at document level once.
  if (!_undoDelegateBound) {
    _undoDelegateBound = true;
    document.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t && t.matches && t.matches('[data-cog-undo]')) {
        e.preventDefault();
        _undoReplace();
        // Remove the toast that contained the button.
        const toast = t.closest('.hub-toast, .toast, .ies-toast') || t.parentElement;
        if (toast && toast.parentElement) toast.parentElement.removeChild(toast);
      }
    });
  }

  // Note: run-phase sub-tabs (Numbers/Map/Sensitivity) now live in chrome
  // Row 2 as section pills — onSection handler above routes those clicks.
}

function renderContent() {
  const el = rootEl?.querySelector('#cog-content');
  if (!el) return;

  // 2026-04-27 EVE2 (COG-SCOPE-1/2/3): phase-driven dispatch. Inputs is the
  // pure points surface; Parameters holds Analysis Config + Candidate
  // Facilities (lifted off the old Demand Points tab); Run hosts Numbers /
  // Map / Sensitivity sub-tabs over a single solve.
  switch (activePhase) {
    case 'inputs':     renderInputsPhase(el); break;
    case 'parameters': renderParametersPhase(el); break;
    case 'run':        renderRunPhase(el); break;
    default:           renderInputsPhase(el);
  }
  renderCogStepper();
}

// ============================================================
// POINTS TAB
// ============================================================

/** 2026-05-28 C1 — column-mapping wizard helpers. See commit message. */
function _autoDetectMapping(aoa, headerRow) {
  const mapping = {};
  if (!aoa || aoa.length === 0) return mapping;
  const dataRows = aoa.slice(headerRow ? 1 : 0).slice(0, 20);
  const ncol = Math.max(...dataRows.map(r => r ? r.length : 0));
  const colStats = Array.from({ length: ncol }, (_, ci) => {
    let zip5 = 0, zip3 = 0, lat = 0, lng = 0, num = 0, txt = 0, n = 0;
    for (const row of dataRows) {
      if (!row || row[ci] == null || row[ci] === '') continue;
      n++;
      const s = String(row[ci]).trim();
      if (/^\d{5}$/.test(s)) zip5++;
      else if (/^\d{3,4}$/.test(s)) zip3++;
      const f = parseFloat(s.replace(/[,$\s]/g, ''));
      if (Number.isFinite(f)) {
        num++;
        if (f >= -90 && f <= 90 && /\./.test(s)) lat++;
        if (f >= -180 && f <= 180 && /\./.test(s)) lng++;
      } else { txt++; }
    }
    return { ci, n, zip5, zip3, lat, lng, num, txt };
  });
  const headerHint = (i) => {
    if (!headerRow || !headerRow[i]) return null;
    const h = headerRow[i].toLowerCase();
    if (/(^|_| )zip(_| |$)?|postal/.test(h)) return /3/.test(h) ? 'zip3' : 'zip5';
    if (/(^|_| )(lat|latitude)(_| |$)/.test(h)) return 'lat';
    if (/(^|_| )(lng|lon|longitude)(_| |$)/.test(h)) return 'lng';
    if (/(^|_| )city(_| |$)/.test(h)) return 'city';
    if (/(^|_| )state(_| |$)/.test(h)) return 'state';
    if (/(^|_| )(units|volume|demand|qty|quantity|annual)/.test(h)) return 'units';
    if (/(^|_| )(name|label|customer|location)/.test(h)) return 'name';
    return null;
  };
  for (let i = 0; i < ncol; i++) {
    const h = headerHint(i);
    if (h) mapping[i] = h;
  }
  for (let i = 0; i < ncol; i++) {
    if (mapping[i]) continue;
    const s = colStats[i];
    if (s.n === 0) continue;
    if (s.zip5 / s.n > 0.7 && !Object.values(mapping).includes('zip5')) mapping[i] = 'zip5';
    else if (s.zip3 / s.n > 0.7 && !Object.values(mapping).includes('zip5') && !Object.values(mapping).includes('zip3')) mapping[i] = 'zip3';
    else if (s.lat / s.n > 0.7 && !Object.values(mapping).includes('lat')) mapping[i] = 'lat';
    else if (s.lng / s.n > 0.7 && !Object.values(mapping).includes('lng')) mapping[i] = 'lng';
  }
  for (let i = ncol - 1; i >= 0; i--) {
    if (mapping[i]) continue;
    if (colStats[i].num / Math.max(1, colStats[i].n) > 0.7) {
      mapping[i] = 'units';
      break;
    }
  }
  return mapping;
}

function renderUploadWizard(container) {
  if (!_pendingUpload || !container) return;
  const pu = _pendingUpload;
  const aoa = pu.aoa;
  const ncol = Math.max(...aoa.slice(0, 5).map(r => r ? r.length : 0));
  const previewRows = aoa.slice(pu.headerRow ? 1 : 0).slice(0, 5);
  if (!pu.mapping || Object.keys(pu.mapping).length === 0) {
    pu.mapping = _autoDetectMapping(aoa, pu.headerRow);
  }
  const ROLES = [
    { value: '',          label: 'Ignore' },
    { value: 'zip5',      label: 'ZIP (5-digit)' },
    { value: 'zip3',      label: 'ZIP (3-digit)' },
    { value: 'city',      label: 'City' },
    { value: 'state',     label: 'State' },
    { value: 'cityState', label: 'City, State (combined)' },
    { value: 'lat',       label: 'Latitude' },
    { value: 'lng',       label: 'Longitude' },
    { value: 'name',      label: 'Name / Label' },
    { value: 'units',     label: 'Units (demand)' },
  ];
  const mapping = pu.mapping;
  const hasUnits = Object.values(mapping).includes('units');
  const hasLatLng = Object.values(mapping).includes('lat') && Object.values(mapping).includes('lng');
  const hasZip5 = Object.values(mapping).includes('zip5');
  const hasZip3 = Object.values(mapping).includes('zip3');
  const hasCityState = (Object.values(mapping).includes('city') && Object.values(mapping).includes('state'))
    || Object.values(mapping).includes('cityState');
  const hasLocation = hasLatLng || hasZip5 || hasZip3 || hasCityState;
  const valid = hasUnits && hasLocation;
  const statusMsg = valid
    ? `<span style="color:#15803d;font-weight:600;">✓ Ready to load — ${previewRows.length} rows previewed, ${aoa.length - (pu.headerRow ? 1 : 0)} total</span>`
    : `<span style="color:#b91c1c;font-weight:600;">⚠ Need a Units column AND a location path (Lat+Lng, ZIP, or City+State)</span>`;
  container.style.display = 'block';
  container.innerHTML = `
    <div class="hub-card" style="margin-top:10px;padding:14px 16px;background:#fffbeb;border-left:3px solid #f59e0b;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#92400e;">Column mapping for "${pu.fileName}"</div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">${aoa.length} data row${aoa.length === 1 ? '' : 's'} · ${ncol} column${ncol === 1 ? '' : 's'}. Assign each column a role.</div>
        </div>
        <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="cog-wiz-has-header" ${pu.headerRow ? 'checked' : ''} style="cursor:pointer;">
          Row 1 is a header
        </label>
      </div>
      <div style="overflow-x:auto;margin-bottom:10px;">
        <table style="border-collapse:collapse;font-size:12px;width:100%;min-width:480px;">
          <thead>
            <tr style="background:#fde68a;">
              ${Array.from({ length: ncol }, (_, i) => `
                <th style="padding:6px 8px;text-align:left;border:1px solid #fcd34d;font-weight:700;min-width:120px;">
                  <div style="font-size:10px;color:#78350f;letter-spacing:0.3px;text-transform:uppercase;margin-bottom:2px;">Col ${String.fromCharCode(65 + i)}${pu.headerRow ? ' · ' + (pu.headerRow[i] || '') : ''}</div>
                  <select data-wiz-col="${i}" style="width:100%;padding:4px 6px;border:1px solid #d97706;border-radius:4px;font-size:12px;font-weight:600;background:#fff;">
                    ${ROLES.map(r => `<option value="${r.value}"${(mapping[i] || '') === r.value ? ' selected' : ''}>${r.label}</option>`).join('')}
                  </select>
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            ${previewRows.map(row => `
              <tr>
                ${Array.from({ length: ncol }, (_, i) => `
                  <td style="padding:5px 8px;border:1px solid #fde68a;background:#fff;color:var(--ies-gray-700);font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:11px;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${row && row[i] != null ? String(row[i]).replace(/</g, '&lt;') : ''}</td>
                `).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div style="font-size:12px;">${statusMsg}</div>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-wiz-cancel">Cancel</button>
          ${points.length > 0 ? `
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-wiz-append" ${valid ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}
                    title="Add these rows to your existing ${points.length} points (no replace)">+ Append</button>
          ` : ''}
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="cog-wiz-confirm" ${valid ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}
                  title="${points.length > 0 ? 'Replace all ' + points.length + ' existing points' : 'Load these rows'}">
            ${points.length > 0 ? '↺ Replace' : 'Confirm & Load'}
          </button>
        </div>
      </div>
    </div>
  `;
  container.querySelectorAll('[data-wiz-col]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(/** @type {HTMLElement} */ (e.target).dataset.wizCol, 10);
      pu.mapping[idx] = /** @type {HTMLSelectElement} */ (e.target).value;
      renderUploadWizard(container);
    });
  });
  container.querySelector('#cog-wiz-has-header')?.addEventListener('change', (e) => {
    const checked = /** @type {HTMLInputElement} */ (e.target).checked;
    pu.headerRow = checked ? (pu.aoa[0] || []).map(v => String(v || '')) : null;
    renderUploadWizard(container);
  });
  container.querySelector('#cog-wiz-cancel')?.addEventListener('click', () => {
    _pendingUpload = null;
    const inputsEl = rootEl?.querySelector('#cog-content');
    if (inputsEl) renderInputsPhase(inputsEl);
  });
  container.querySelector('#cog-wiz-confirm')?.addEventListener('click', async () => {
    if (!valid) return;
    await _commitPendingUpload('replace');
  });
  container.querySelector('#cog-wiz-append')?.addEventListener('click', async () => {
    if (!valid) return;
    await _commitPendingUpload('append');
  });
}

async function _commitPendingUpload(mode = 'replace') {
  if (!_pendingUpload) return;
  const pu = _pendingUpload;
  const mapping = pu.mapping;
  const dataRows = pu.aoa.slice(pu.headerRow ? 1 : 0);
  const roleCol = {};
  for (const [ci, role] of Object.entries(mapping)) {
    if (role) roleCol[role] = parseInt(ci, 10);
  }
  const loaded = [];
  const excluded = [];
  for (const row of dataRows) {
    if (!row || row.length === 0 || row.every(c => c === '' || c == null)) continue;
    let hit = null;
    let locDesc = '';
    if ('lat' in roleCol && 'lng' in roleCol) {
      const la = parseFloat(String(row[roleCol.lat] ?? '').replace(/[,$\s]/g, ''));
      const ln = parseFloat(String(row[roleCol.lng] ?? '').replace(/[,$\s]/g, ''));
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        hit = { name: `${la.toFixed(3)}, ${ln.toFixed(3)}`, lat: la, lng: ln };
        locDesc = hit.name;
      } else { locDesc = `lat="${row[roleCol.lat]}" lng="${row[roleCol.lng]}"`; }
    }
    if (!hit && 'zip5' in roleCol) {
      const raw = String(row[roleCol.zip5] ?? '').trim().replace(/[^0-9]/g, '').padStart(5, '0').slice(-5);
      locDesc = `ZIP ${raw}`;
      if (/^\d{5}$/.test(raw)) hit = calc.lookupLocation(raw);
    }
    if (!hit && 'zip3' in roleCol) {
      const raw = String(row[roleCol.zip3] ?? '').trim().replace(/[^0-9]/g, '').padStart(3, '0').slice(-3);
      locDesc = `ZIP3 ${raw}`;
      if (/^\d{3}$/.test(raw)) hit = calc.lookupLocation(raw);
    }
    if (!hit && 'cityState' in roleCol) {
      const v = String(row[roleCol.cityState] ?? '').trim();
      locDesc = v;
      if (v) hit = calc.lookupLocation(v);
    }
    if (!hit && 'city' in roleCol) {
      const c = String(row[roleCol.city] ?? '').trim();
      const s = 'state' in roleCol ? String(row[roleCol.state] ?? '').trim() : '';
      locDesc = s ? `${c}, ${s}` : c;
      if (c) hit = calc.lookupLocation(locDesc);
    }
    const unitsRaw = Number(String(row[roleCol.units] ?? '').replace(/[,$\s]/g, ''));
    const validUnits = Number.isFinite(unitsRaw) && unitsRaw > 0;
    const nameField = 'name' in roleCol ? String(row[roleCol.name] ?? '').trim() : '';
    if (!hit || !validUnits) {
      const reason = !hit ? 'no location match' : 'missing / invalid units';
      excluded.push({
        id: 'px' + Date.now() + '_' + (loaded.length + excluded.length),
        name: nameField || (locDesc ? `${locDesc} — excluded (${reason})` : `Row excluded (${reason})`),
        lat: null, lng: null,
        weight: validUnits ? Math.max(1, Math.round(unitsRaw)) : 0,
        type: 'excluded',
      });
      continue;
    }
    loaded.push({
      id: 'p' + Date.now() + '_' + loaded.length,
      name: nameField || `${hit.name}`,
      lat: hit.lat, lng: hit.lng,
      weight: Math.max(1, Math.round(unitsRaw)),
      type: 'demand',
    });
  }
  const allUpload = [...loaded, ...excluded];
  if (allUpload.length === 0) {
    showToast(`Nothing loaded — every row blank/unparseable.`, 'err');
    _pendingUpload = null;
    const inputsEl = rootEl?.querySelector('#cog-content');
    if (inputsEl) renderInputsPhase(inputsEl);
    return;
  }
  if (mode === 'append' && points.length > 0) {
    // Append: keep existing + add new. No confirm needed (Append is the
    // intentional pick from the wizard buttons), but still snapshot for undo.
    _snapshotForUndo(`Append "${pu.fileName}"`);
    // De-duplicate id collisions between existing + new (every id has a
    // Date.now() suffix so collisions are astronomically unlikely, but the
    // safer floor is to re-id incoming).
    const reIded = allUpload.map((p, i) => ({ ...p, id: 'p' + Date.now() + '_app_' + i }));
    points = [...points, ...reIded];
  } else {
    if (points.length > 0) {
      const ok = await showConfirm(`Replace ${points.length} existing point${points.length === 1 ? '' : 's'} with ${allUpload.length} from "${pu.fileName}" (${loaded.length} active, ${excluded.length} excluded)?`);
      if (!ok) {
        _pendingUpload = null;
        const inputsEl = rootEl?.querySelector('#cog-content');
        if (inputsEl) renderInputsPhase(inputsEl);
        return;
      }
      _snapshotForUndo(`Upload "${pu.fileName}"`);
    }
    points = allUpload;
  }
  _pendingUpload = null;
  markDirty();
  const inputsEl = rootEl?.querySelector('#cog-content');
  if (inputsEl) renderInputsPhase(inputsEl);
  const tail = excluded.length > 0 ? ` — ${excluded.length} excluded (visible in table)` : '';
  const verb = mode === 'append' ? 'Appended' : 'Loaded';
  if (_lastReplacedPoints) {
    showToast(`${verb} ${loaded.length} active point${loaded.length === 1 ? '' : 's'} from ${pu.fileName}${tail}. <button data-cog-undo style="margin-left:8px;text-decoration:underline;background:none;border:none;color:inherit;cursor:pointer;font-weight:700;">Undo</button>`, excluded.length > 0 ? 'warn' : 'ok', { html: true });
  } else {
    showToast(`${verb} ${loaded.length} active point${loaded.length === 1 ? '' : 's'} from ${pu.fileName}${tail}.`, excluded.length > 0 ? 'warn' : 'ok');
  }
}

function renderInputsPhase(el) {
  // 2026-04-27 EVE2 (COG-SCOPE-1/2/5): pure Inputs surface — seeders +
  // add-point row + points table + KPI bar. Analysis Configuration and
  // Candidate Facilities moved to renderParametersPhase below.
  const totalWeight = points.reduce((s, p) => s + p.weight, 0);

  // COG-SCOPE-5: tighten the seeder hierarchy. All three seed mechanisms
  // (Apply Archetype + Load Demo + Add Point) sit in one Seeders card so
  // the user reads the full menu at a glance.
  el.innerHTML = `
    <div>
      <!-- 2026-05-28 F2 — Deal Context card. Lives at the top so every
           scenario starts with customer/industry/deal-stage metadata. -->
      <div class="hub-card" style="margin-bottom:16px;padding:14px 16px;border-left:3px solid #0047AB;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:12px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);">Deal Context</div>
          <div style="font-size:11px;color:var(--ies-gray-400);">Captured on the scenario · shows up in the landing list</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Customer</label>
            <input type="text" id="cog-customer" value="${(config.customerName || '').replace(/"/g, '&quot;')}" placeholder="e.g. Wayfair, Acme Industries"
                   style="width:100%;padding:7px 9px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Industry</label>
            <select id="cog-industry" style="width:100%;padding:6px 9px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
              ${calc.INDUSTRY_OPTIONS.map(o => `<option value="${o.value}"${(config.industry || '') === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Deal Stage</label>
            <select id="cog-deal-stage" style="width:100%;padding:6px 9px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
              ${calc.DEAL_STAGES.map(o => `<option value="${o.value}"${(config.dealStage || '') === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="margin-top:10px;">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Notes</label>
          <textarea id="cog-notes" rows="2" placeholder="Open assumptions, customer constraints, anything the analyst should know on reopen…"
                    style="width:100%;padding:7px 9px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;resize:vertical;">${(config.notes || '').replace(/</g, '&lt;')}</textarea>
        </div>
      </div>

      <!-- Seeders card -->
      <div class="hub-card" style="margin-bottom:16px;padding:14px 16px;border-left:3px solid #20c997;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin-bottom:10px;">Seed demand points</div>
        <div style="display:grid;grid-template-columns:1fr;gap:10px;">
          <!-- Add a single point via city/ZIP lookup -->
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <div style="font-size:11px;font-weight:600;color:var(--ies-gray-500);width:90px;flex-shrink:0;">Add one</div>
            <input list="cog-city-list" id="cog-lookup-input" placeholder="City, ST or 3-/5-digit ZIP (e.g. Atlanta, GA or 30303)"
                   style="flex:1;min-width:240px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;" />
            <input type="number" id="cog-lookup-weight" placeholder="Weight" min="1" step="100" value="10000"
                   title="Demand weight (units, shipments, pallets, orders)"
                   style="width:110px;padding:8px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;text-align:right;" />
            <button class="hub-btn hub-btn-sm hub-btn-primary" id="cog-lookup-add" title="Look up the location and add it as a demand point">+ Add</button>
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-add-point" title="Add an empty point (manual lat/lng entry in the table)">Blank</button>
          </div>
          <div id="cog-lookup-feedback" style="font-size:11px;color:var(--ies-gray-400);padding-left:100px;"></div>

          <!-- Bulk-seed via archetype or demo fixture -->
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--ies-gray-200);padding-top:10px;">
            <div style="font-size:11px;font-weight:600;color:var(--ies-gray-500);width:90px;flex-shrink:0;">Bulk seed</div>
            <select id="cog-archetype-select" title="Apply a pre-built demand distribution when customer data is sparse" style="flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
              <option value="">— Pick an archetype —</option>
              ${Object.entries(calc.COG_ARCHETYPES).map(([k, a]) => `
                <option value="${k}">${a.name}</option>
              `).join('')}
            </select>
            <input type="number" id="cog-archetype-volume" placeholder="Total units (optional)" title="Optional: override the archetype's default total annual volume" style="width:170px;padding:7px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;" />
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-load-archetype" title="Pick an archetype from the dropdown first" disabled style="opacity:0.5;cursor:not-allowed;">Apply Archetype</button>
            <span style="width:1px;height:18px;background:var(--ies-gray-200);"></span>
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-load-demo" title="Load a 10-point US demo fixture so you can explore the tool without entering data">Load Demo</button>
          </div>
          <div id="cog-archetype-desc" style="font-size:12px;color:var(--ies-gray-500);display:none;padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;margin-left:100px;"></div>

          <!-- 2026-05-26 — bulk demand from an Excel / CSV file. Two
               columns: 5-digit ZIP + units. Header row auto-detected. -->
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--ies-gray-200);padding-top:10px;">
            <div style="font-size:11px;font-weight:600;color:var(--ies-gray-500);width:90px;flex-shrink:0;">Upload</div>
            <input type="file" id="cog-xlsx-input" accept=".xlsx,.xls,.csv" style="display:none;" />
            <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-xlsx-pick" title="Choose an Excel (.xlsx, .xls) or CSV file with two columns: 5-digit ZIP and units">📂 Upload XLS / XLSX / CSV</button>
            <span id="cog-xlsx-filename" style="font-size:12px;color:var(--ies-gray-500);font-style:italic;"></span>
            <span style="flex:1;font-size:11px;color:var(--ies-gray-400);text-align:right;">
              Two columns: <strong>5-digit ZIP</strong>, <strong>units</strong>. Header row OK.
            </span>
          </div>
          <div id="cog-xlsx-feedback" style="font-size:11px;color:var(--ies-gray-400);padding-left:100px;display:none;"></div>
          <div id="cog-upload-wizard" style="${_pendingUpload ? '' : 'display:none;'}"></div>

          <datalist id="cog-city-list">
            ${calc.CITY_CENTROIDS.map(c => `<option value="${c.name}, ${c.state}"></option>`).join('')}
          </datalist>
        </div>
      </div>

      <!-- Points table -->
      <div class="hub-card" style="padding:14px 16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <h3 class="text-section" style="margin:0;">Weighted Demand Points</h3>
          <span style="font-size:12px;color:var(--ies-gray-500);">${points.length} point${points.length === 1 ? '' : 's'}</span>
        </div>
        ${points.length === 0 ? `
          <div style="padding:24px;text-align:center;color:var(--ies-gray-400);font-size:12px;border:1px dashed var(--ies-gray-300);border-radius:6px;">No points yet — use the seeders above to add a few.</div>
        ` : `
          <div style="max-height:400px;overflow-y:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead style="position:sticky;top:0;background:#fff;">
                <tr style="border-bottom:2px solid var(--ies-gray-200);">
                  <th style="text-align:left;padding:8px 6px;font-weight:700;cursor:pointer;user-select:none;" data-sort="name" title="Click to sort by name">Name${_pointsSort.column === 'name' ? (_pointsSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>
                  <th style="text-align:right;padding:8px 6px;font-weight:700;cursor:pointer;user-select:none;" data-sort="lat" title="Click to sort by latitude">Lat${_pointsSort.column === 'lat' ? (_pointsSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>
                  <th style="text-align:right;padding:8px 6px;font-weight:700;cursor:pointer;user-select:none;" data-sort="lng" title="Click to sort by longitude">Lng${_pointsSort.column === 'lng' ? (_pointsSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>
                  <th style="text-align:right;padding:8px 6px;font-weight:700;cursor:pointer;user-select:none;" data-sort="weight" title="Click to sort by weight">Weight${_pointsSort.column === 'weight' ? (_pointsSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>
                  <th style="text-align:center;padding:8px 6px;font-weight:700;cursor:pointer;user-select:none;" data-sort="type" title="Click to sort by type">Type${_pointsSort.column === 'type' ? (_pointsSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>
                  <th style="text-align:center;padding:8px 6px;"></th>
                </tr>
              </thead>
              <tbody>
                ${(() => {
                  // 2026-05-28 C12 — sortable view. Keep the original index
                  // for delete-by-index handling (points.splice). When sort
                  // is active, sort a shallow copy + keep the original
                  // index on each row.
                  const rows = points.map((p, i) => ({ p, i }));
                  if (_pointsSort.column) {
                    const col = _pointsSort.column;
                    const dir = _pointsSort.direction === 'desc' ? -1 : 1;
                    rows.sort((a, b) => {
                      const av = a.p[col]; const bv = b.p[col];
                      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
                      return String(av || '').localeCompare(String(bv || '')) * dir;
                    });
                  }
                  return rows.map(({ p, i }) => {
                  const exc = p.type === 'excluded';
                  const badgeBg = exc ? '#fee2e2'
                    : p.type === 'demand' ? '#dbeafe'
                    : p.type === 'supply' ? '#dcfce7' : '#fef3c7';
                  const badgeFg = exc ? '#b91c1c'
                    : p.type === 'demand' ? '#1d4ed8'
                    : p.type === 'supply' ? '#15803d' : '#92400e';
                  const rowStyle = `border-bottom:1px solid var(--ies-gray-200);${exc ? 'background:#fafafa;color:var(--ies-gray-500);' : ''}`;
                  const nameStyle = `padding:6px;font-weight:600;${exc ? 'text-decoration:line-through;' : ''}`;
                  const ll = (v) => (v == null || Number.isNaN(v)) ? '<span style="color:var(--ies-gray-400);">—</span>' : v.toFixed(2);
                  return `
                  <tr style="${rowStyle}">
                    <td style="${nameStyle}" title="${exc ? 'Excluded from the solve. Edit the source file and re-upload, or delete this row.' : ''}">${p.name || p.id}</td>
                    <td style="padding:6px;text-align:right;">${ll(p.lat)}</td>
                    <td style="padding:6px;text-align:right;">${ll(p.lng)}</td>
                    <td style="padding:6px;text-align:right;">${(p.weight || 0).toLocaleString()}</td>
                    <td style="padding:6px;text-align:center;">
                      <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:${badgeBg};color:${badgeFg};">${p.type}</span>
                    </td>
                    <td style="padding:6px;text-align:center;display:flex;gap:4px;justify-content:center;">
                      ${exc ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-pt-retry="${i}" title="Look up a corrected ZIP and re-resolve this row" style="padding:4px 8px;">↻</button>` : ''}
                      <button class="hub-btn hub-btn-sm hub-btn-secondary" data-pt-del="${i}" style="padding:4px 8px;">✕</button>
                    </td>
                  </tr>`;
                }).join('');
                })()}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <div class="hub-card" style="margin-top:20px;background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 20px;">
        <div style="display:flex;gap:32px;align-items:center;">
          ${(() => {
            const activeCount = points.filter(p => p.type !== 'excluded').length;
            const excludedCount = points.length - activeCount;
            return excludedCount > 0
              ? kpi('Points', `${activeCount} active · ${excludedCount} excluded`)
              : kpi('Points', String(activeCount));
          })()}
          ${kpi('Total Weight', totalWeight.toLocaleString())}
          ${kpi('Centers (k)', String(config.numCenters))}
        </div>
      </div>
    </div>
  `;

  // Delete point
  el.querySelectorAll('[data-pt-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      points.splice(parseInt(/** @type {HTMLElement} */ (btn).dataset.ptDel), 1);
      markDirty();
      renderInputsPhase(el);
    });
  });
  // 2026-05-28 C8 — retry excluded row with a corrected ZIP/city.
  el.querySelectorAll('[data-pt-retry]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(/** @type {HTMLElement} */ (btn).dataset.ptRetry, 10);
      const row = points[idx];
      if (!row) return;
      const corrected = await showPrompt(`Re-resolve "${row.name || 'this row'}" — enter a city, state, or ZIP:`, '');
      if (!corrected) return;
      const hit = calc.lookupLocation(corrected.trim());
      if (!hit) {
        showToast(`"${corrected}" didn't match a known city or ZIP.`, 'warn');
        return;
      }
      points[idx] = {
        ...row,
        name: hit.name,
        lat: hit.lat,
        lng: hit.lng,
        type: 'demand',
        weight: row.weight && row.weight > 0 ? row.weight : 10000,
      };
      markDirty();
      renderInputsPhase(el);
      showToast(`Resolved to ${hit.name}.`, 'ok');
    });
  });

  // 2026-05-28 C12 — clickable sort headers. Same column twice flips
  // direction; third click clears the sort (back to insertion order).
  el.querySelectorAll('[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = /** @type {HTMLElement} */ (th).dataset.sort;
      if (_pointsSort.column === col) {
        if (_pointsSort.direction === 'asc') _pointsSort.direction = 'desc';
        else _pointsSort = { column: null, direction: 'asc' };
      } else {
        _pointsSort = { column: col, direction: 'asc' };
      }
      renderInputsPhase(el);
    });
  });

  el.querySelector('#cog-add-point')?.addEventListener('click', () => {
    points.push({ id: 'p' + Date.now(), name: 'New Point', lat: 39.83, lng: -98.58, weight: 10000, type: 'demand' });
    markDirty();
    renderInputsPhase(el);
  });

  el.querySelector('#cog-load-demo')?.addEventListener('click', () => {
    if (points.length > 0) _snapshotForUndo('Load Demo');
    points = calc.DEMO_POINTS.map(p => ({ ...p }));
    markDirty();
    renderInputsPhase(el);
    if (_lastReplacedPoints) {
      showToast(`Loaded ${points.length} demo points. <button data-cog-undo style="margin-left:8px;text-decoration:underline;background:none;border:none;color:inherit;cursor:pointer;font-weight:700;">Undo</button>`, 'ok', { html: true });
    } else {
      showToast(`Loaded ${points.length} demo points.`, 'ok');
    }
  });

  // 2026-05-26 — XLS / XLSX / CSV upload. Two columns: 5-digit ZIP + units.
  // Parses with the globally-loaded SheetJS (already in index.html for
  // exports). Auto-detects a header row, looks up each ZIP via
  // calc.lookupLocation, pushes one demand point per resolved row.
  // Mirrors the archetype loader's confirm-replace pattern.
  const xlsxBtn = el.querySelector('#cog-xlsx-pick');
  const xlsxInput = /** @type {HTMLInputElement|null} */ (el.querySelector('#cog-xlsx-input'));
  const xlsxName = el.querySelector('#cog-xlsx-filename');
  const xlsxFb = el.querySelector('#cog-xlsx-feedback');
  const showFeedback = (msg, level) => {
    if (!xlsxFb) return;
    xlsxFb.style.display = 'block';
    xlsxFb.textContent = msg;
    xlsxFb.style.color = level === 'err' ? 'var(--ies-red)'
      : level === 'warn' ? '#a16207'
      : 'var(--ies-gray-500)';
  };
  xlsxBtn?.addEventListener('click', () => { xlsxInput?.click(); });
  xlsxInput?.addEventListener('change', async (evt) => {
    const file = /** @type {HTMLInputElement} */ (evt.target)?.files?.[0];
    if (!file) return;
    if (xlsxName) xlsxName.textContent = file.name;
    showFeedback('Reading…', 'info');
    // 2026-05-28 C1 — parse + open the wizard instead of resolving inline.
    const XLSX_ = /** @type {any} */ (typeof window !== 'undefined' ? window.XLSX : null);
    if (!XLSX_ || !XLSX_.read) {
      showFeedback('Spreadsheet parser not loaded — refresh and retry.', 'err');
      return;
    }
    let bufW;
    try { bufW = await file.arrayBuffer(); } catch (err) { showFeedback(`Read failed: ${err?.message || err}`, 'err'); return; }
    let aoaW;
    try {
      const wbW = XLSX_.read(bufW, { type: 'array' });
      const sn = wbW.SheetNames[0];
      if (!sn) { showFeedback('File has no sheets.', 'err'); return; }
      aoaW = XLSX_.utils.sheet_to_json(wbW.Sheets[sn], { header: 1, defval: '', blankrows: false });
    } catch (err) { showFeedback(`Parse failed: ${err?.message || err}`, 'err'); return; }
    if (!Array.isArray(aoaW) || aoaW.length === 0) { showFeedback('File is empty.', 'err'); return; }
    const looksLikeData = /^\s*\d{1,5}\s*$/.test(String(aoaW[0]?.[0] ?? '')) || (typeof aoaW[0]?.[0] === 'number');
    const headerRowW = looksLikeData ? null : (aoaW[0] || []).map(v => String(v || ''));
    _pendingUpload = { fileName: file.name, aoa: aoaW, headerRow: headerRowW, mapping: {} };
    if (xlsxInput) xlsxInput.value = '';
    if (xlsxFb) xlsxFb.style.display = 'none';
    const wizEl = el.querySelector('#cog-upload-wizard');
    if (wizEl) renderUploadWizard(/** @type {HTMLElement} */ (wizEl));
    return;  // wizard owns the rest of the flow
    // ────── legacy inline-resolution path below (unreachable, kept one
    // commit for diff readability) ──────

    // SheetJS lives at window.XLSX — same global the exports use.
    const XLSX = /** @type {any} */ (typeof window !== 'undefined' ? window.XLSX : null);
    if (!XLSX || !XLSX.read) {
      showFeedback('Spreadsheet parser not loaded — refresh the page and try again.', 'err');
      showToast('Spreadsheet library missing — hard refresh and retry.', 'err');
      return;
    }

    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (err) {
      showFeedback(`Failed to read file: ${err?.message || err}`, 'err');
      return;
    }

    let aoa;
    try {
      const wb = XLSX.read(buffer, { type: 'array' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) {
        showFeedback('The file has no sheets.', 'err');
        return;
      }
      aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
    } catch (err) {
      showFeedback(`Failed to parse file: ${err?.message || err}`, 'err');
      return;
    }

    if (!Array.isArray(aoa) || aoa.length === 0) {
      showFeedback('The file is empty.', 'err');
      return;
    }

    // Header-row auto-detect: if the first row's first cell isn't a
    // numeric / ZIP-looking value, treat it as a header and skip it.
    const looksLikeZip = (v) => /^\s*\d{1,5}\s*$/.test(String(v ?? ''));
    const dataRows = looksLikeZip(aoa[0]?.[0]) ? aoa : aoa.slice(1);

    const loaded = [];
    const excluded = [];  // surfaced in points table as type='excluded'
    const skipped = { badZip: 0, noMatch: 0, badUnits: 0, blank: 0 };
    for (const row of dataRows) {
      if (!row || row.length === 0 || (row[0] === '' && row[1] === '')) { skipped.blank++; continue; }
      // Normalize ZIP: 5-digit string, left-pad if Excel stripped leading zeros.
      const rawZip = String(row[0] ?? '').trim();
      if (!rawZip) { skipped.badZip++; continue; }
      const zip = rawZip.replace(/[^0-9]/g, '').padStart(5, '0').slice(-5);
      if (!/^\d{5}$/.test(zip)) { skipped.badZip++; continue; }
      const unitsRaw = Number(String(row[1] ?? '').replace(/[,$\s]/g, ''));
      const validUnits = Number.isFinite(unitsRaw) && unitsRaw > 0;
      const hit = calc.lookupLocation(zip);
      // 2026-05-26 — instead of silently dropping no-match / bad-units
      // rows, surface them in the points table as type='excluded' so
      // the user can see exactly what didn't make it.
      if (!hit || !validUnits) {
        const reason = !hit ? 'no ZIP match' : 'missing / invalid units';
        if (!hit) skipped.noMatch++; else skipped.badUnits++;
        excluded.push({
          id: 'px' + Date.now() + '_' + (loaded.length + excluded.length),
          name: `ZIP ${zip} — excluded (${reason})`,
          lat: null,
          lng: null,
          weight: validUnits ? Math.max(1, Math.round(unitsRaw)) : 0,
          type: 'excluded',
        });
        continue;
      }
      loaded.push({
        id: 'p' + Date.now() + '_' + loaded.length,
        name: `${hit.name} (${zip})`,
        lat: hit.lat,
        lng: hit.lng,
        weight: Math.max(1, Math.round(unitsRaw)),
        type: 'demand',
      });
    }

    const allUpload = [...loaded, ...excluded];
    if (allUpload.length === 0) {
      const reason = skipped.badZip ? `${skipped.badZip} bad ZIP${skipped.badZip === 1 ? '' : 's'}`
        : 'no usable rows (all blank or unparseable)';
      showFeedback(`Nothing loaded — ${reason}.`, 'err');
      // Reset the input so the same file can be re-picked after fixing it.
      if (xlsxInput) xlsxInput.value = '';
      return;
    }

    if (points.length > 0) {
      const ok = await showConfirm(`Replace ${points.length} existing point${points.length === 1 ? '' : 's'} with ${allUpload.length} from "${file.name}" (${loaded.length} active, ${excluded.length} excluded)?`);
      if (!ok) {
        showFeedback('Cancelled — existing points kept.', 'info');
        if (xlsxInput) xlsxInput.value = '';
        return;
      }
      _snapshotForUndo(`Upload "${file.name}"`);
    }
    points = allUpload;
    markDirty();
    renderInputsPhase(el);
    const tailParts = [];
    if (excluded.length > 0) tailParts.push(`${excluded.length} excluded (visible in table)`);
    if (skipped.badZip > 0) tailParts.push(`${skipped.badZip} bad ZIP dropped`);
    if (skipped.blank > 0) tailParts.push(`${skipped.blank} blank dropped`);
    const tail = tailParts.length ? ` — ${tailParts.join(', ')}` : '';
    showToast(`Loaded ${loaded.length} active point${loaded.length === 1 ? '' : 's'} from ${file.name}${tail}.`, excluded.length > 0 ? 'warn' : 'ok');
    // Reset so re-uploading the same file fires the change event again.
    if (xlsxInput) xlsxInput.value = '';
  });

  // City/state/ZIP lookup → resolve and append a point.
  const lookupInput  = /** @type {HTMLInputElement|null} */ (el.querySelector('#cog-lookup-input'));
  const lookupWeight = /** @type {HTMLInputElement|null} */ (el.querySelector('#cog-lookup-weight'));
  const lookupFb     = el.querySelector('#cog-lookup-feedback');
  const commitLookup = () => {
    if (!lookupInput) return;
    const q = lookupInput.value.trim();
    if (!q) {
      if (lookupFb) lookupFb.textContent = 'Enter a city, state, or ZIP.';
      return;
    }
    const hit = calc.lookupLocation(q);
    if (!hit) {
      if (lookupFb) {
        lookupFb.textContent = `"${q}" didn't match a known city or ZIP. Try a major US metro (${calc.CITY_CENTROIDS[0].name}, ${calc.CITY_CENTROIDS[0].state}…) or a 3-digit ZIP.`;
        lookupFb.style.color = 'var(--ies-red)';
      }
      return;
    }
    const weight = Math.max(1, parseInt(lookupWeight?.value || '10000', 10) || 10000);
    points.push({ id: 'p' + Date.now(), name: hit.name, lat: hit.lat, lng: hit.lng, weight, type: 'demand' });
    markDirty();
    renderInputsPhase(el);
  };
  el.querySelector('#cog-lookup-add')?.addEventListener('click', commitLookup);
  lookupInput?.addEventListener('keydown', (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === 'Enter') {
      e.preventDefault();
      commitLookup();
    }
  });

  // Archetype seeder
  const archSelect = /** @type {HTMLSelectElement|null} */ (el.querySelector('#cog-archetype-select'));
  const archDesc = el.querySelector('#cog-archetype-desc');
  const archVolInput = /** @type {HTMLInputElement|null} */ (el.querySelector('#cog-archetype-volume'));
  archSelect?.addEventListener('change', () => {
    const key = archSelect.value;
    const a = calc.COG_ARCHETYPES[key];
    const applyBtn = /** @type {HTMLButtonElement|null} */ (el.querySelector('#cog-load-archetype'));
    if (applyBtn) {
      applyBtn.disabled = !key;
      applyBtn.style.opacity = key ? '1' : '0.5';
      applyBtn.style.cursor = key ? 'pointer' : 'not-allowed';
      applyBtn.title = key ? `Generate demand points from the ${a?.name || ''} archetype` : 'Pick an archetype from the dropdown first';
    }
    if (a && archDesc) {
      archDesc.style.display = 'block';
      archDesc.innerHTML = `<strong>${a.name}</strong> — ${a.desc} <span style="color:var(--ies-gray-400);">Default volume: ${a.defaultTotalUnits.toLocaleString()} units</span>`;
      if (archVolInput) archVolInput.placeholder = a.defaultTotalUnits.toLocaleString();
    } else if (archDesc) {
      archDesc.style.display = 'none';
    }
  });

  // 2026-05-28 F2 — Deal Context bindings.
  el.querySelector('#cog-customer')?.addEventListener('change', (e) => {
    config.customerName = /** @type {HTMLInputElement} */ (e.target).value.trim();
    markDirty();
  });
  el.querySelector('#cog-industry')?.addEventListener('change', (e) => {
    config.industry = /** @type {HTMLSelectElement} */ (e.target).value;
    markDirty();
  });
  el.querySelector('#cog-deal-stage')?.addEventListener('change', (e) => {
    config.dealStage = /** @type {HTMLSelectElement} */ (e.target).value;
    markDirty();
  });
  el.querySelector('#cog-notes')?.addEventListener('change', (e) => {
    config.notes = /** @type {HTMLTextAreaElement} */ (e.target).value;
    markDirty();
  });

  el.querySelector('#cog-load-archetype')?.addEventListener('click', async () => {
    if (!archSelect?.value) {
      showToast('Pick an archetype from the dropdown first.', 'warn');
      return;
    }
    const totalUnits = archVolInput?.value ? parseInt(archVolInput.value, 10) : 0;
    const generated = calc.generateArchetypePoints(archSelect.value, totalUnits || undefined);
    if (!generated.length) {
      showToast('Archetype generated 0 points — check the selection.', 'warn');
      return;
    }
    if (points.length > 0 && !(await showConfirm(`Replace ${points.length} existing point${points.length === 1 ? '' : 's'} with ${generated.length} archetype-generated points?`))) return;
    if (points.length > 0) _snapshotForUndo('Apply Archetype');
    points = generated;
    markDirty();
    renderInputsPhase(el);
    if (_lastReplacedPoints) {
      showToast(`Loaded ${generated.length} demand points from ${calc.COG_ARCHETYPES[archSelect.value].name}. <button data-cog-undo style="margin-left:8px;text-decoration:underline;background:none;border:none;color:inherit;cursor:pointer;font-weight:700;">Undo</button>`, 'ok', { html: true });
    } else {
      showToast(`Loaded ${generated.length} demand points from ${calc.COG_ARCHETYPES[archSelect.value].name}.`, 'ok');
    }
  });

  // 2026-05-28 C1 — re-render the wizard if a pending upload survived a
  // phase switch (rare but possible if user clicked away mid-mapping).
  if (_pendingUpload) {
    const wizEl = el.querySelector('#cog-upload-wizard');
    if (wizEl) renderUploadWizard(/** @type {HTMLElement} */ (wizEl));
  }
}

function renderParametersPhase(el) {
  // 2026-04-27 EVE2 (COG-SCOPE-2/6): Analysis Configuration + Candidate
  // Facilities cards lifted off the old Demand Points tab. "Number of
  // Nodes / Facilities" renamed to "Centers (k)".
  const wmeta = calc.getWeightUnitMeta(config.weightUnit || 'lb');
  el.innerHTML = `
    <div>
      <!-- Analysis Configuration (COG-SCOPE-2 lift) -->
      <div class="hub-card" style="margin-bottom:20px;padding:16px;border-left:3px solid var(--ies-blue);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:12px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-400);">Analysis Configuration</div>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-reset-defaults" title="Reset every Parameters knob to its default value (k=1, $2.85/mi, rt=2.0, road=1.22, no SLA, no capacity, mode mix off…). Preserves Deal Context, points, and Current State.">↺ Reset defaults</button>
        </div>
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">Centers (k):</label>
            <input type="number" value="${config.numCenters}" min="1" max="20" id="cog-k"
                   style="width:70px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:14px;font-weight:700;text-align:center;color:var(--ies-blue);">
            <span style="font-size:11px;color:var(--ies-gray-400);">How many DC locations to optimize for</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Unit your demand 'weight' values are in. Math doesn't care which unit you pick — capacity below must use the same one. Drives label text everywhere weight appears.">Weight Unit:</label>
            <select id="cog-weight-unit" style="padding:7px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;">
              ${calc.WEIGHT_UNIT_OPTIONS.map(u => `<option value="${u.value}"${(config.weightUnit||'lb')===u.value?' selected':''}>${u.label}</option>`).join('')}
            </select>
            <span style="font-size:11px;color:var(--ies-gray-400);" title="The Truck $/mi rate is per truck-mile regardless of weight unit. Weight Unit only changes how demand totals are bucketed into truckloads via the capacity below.">Cost rate is per truck-mile · weight unit drives demand → truckloads</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">Truck $/mi:</label>
            <input type="number" value="${config.transportCostPerMile}" step="0.01" id="cog-cpm"
                   style="width:80px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">Per-truck rate (e.g. $2.85/mi for 53-ft van)</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">${wmeta.short.charAt(0).toUpperCase()+wmeta.short.slice(1)} / Truck:</label>
            <input type="number" value="${config.unitsPerTruck || 25000}" step="${wmeta.step}" min="1" id="cog-cap"
                   style="width:90px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">Avg payload (${wmeta.short}) per truckload</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">Max Iterations:</label>
            <input type="number" value="${config.maxIterations || 100}" min="10" max="500" step="10" id="cog-iter"
                   style="width:80px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Maximum k explored on the Sensitivity tab. Each k from 1..N gets its own solve. Default 8 covers typical network ranges; bump to 12-20 for big-network deep dives at the cost of slower Run.">Sensitivity max k:</label>
            <input type="number" value="${config.sensitivityMaxK ?? 8}" min="2" max="20" step="1" id="cog-sens-max"
                   style="width:70px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">range 2-20 · default 8 · linear runtime cost</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Multiplier applied to one-way distance to account for the empty return leg. 2.0 = full round trip (no backhaul revenue). 1.5-1.8 if your network has reliable backhaul matches. Threaded through Analysis totals + Sensitivity + per-row table.">Round-trip:</label>
            <input type="number" value="${config.roundTripFactor ?? 2.0}" step="0.1" min="1.0" max="3.0" id="cog-rt-factor"
                   style="width:70px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">2.0 = full round trip · 1.5-1.8 with backhaul</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Multiplier converting great-circle (haversine) distance into estimated road miles. Continental US average is 1.20-1.25. Mountain west runs 1.30+, plains 1.15. Set to 1.0 to revert to legacy great-circle math.">Road factor:</label>
            <input type="number" value="${config.roadFactor ?? 1.22}" step="0.01" min="1.0" max="1.5" id="cog-road-factor"
                   style="width:70px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">1.22 = US avg · 1.30 = mountain · 1.15 = plains · 1.00 = great-circle</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="CO₂ emissions intensity per truck-mile. Default 1.62 kg/mi = EPA SmartWay 2024 US Class 8 average. Range 1.30 (new diesel / hybrid fleets) to 2.10 (older or refrigerated). Set to 0 to hide emissions output.">CO₂ kg/truck-mi:</label>
            <input type="number" value="${config.co2KgPerTruckMile ?? 1.62}" step="0.01" min="0" max="3.0" id="cog-co2"
                   style="width:80px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">1.62 = US Class 8 avg · 1.30 = new diesel · 2.10 = refrigerated</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Service-level constraint. Demand points whose road-distance to the assigned DC exceeds this threshold get flagged out-of-service in the Analysis table and on the map. Doesn't change k-means math — it answers the 'can we hit 95% next-day' question. 0 = disabled.">Max service mi:</label>
            <input type="number" value="${config.maxServiceMiles ?? 0}" step="50" min="0" max="3000" id="cog-max-service"
                   style="width:80px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">0 = off · 250 = same-day parcel · 500 = next-day TL · 800 = 2-day LTL</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Capacity ceiling per DC (in your weight unit / yr). Post-solve, any cluster over cap reassigns its farthest demand to the nearest under-cap cluster until everyone fits or all clusters are full. 0 = disabled (k-means assignment kept as-is).">Capacity / DC:</label>
            <input type="number" value="${config.capacityPerDC ?? 0}" step="100000" min="0" id="cog-capacity"
                   style="width:120px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">0 = off · ${(calc.getWeightUnitMeta(config.weightUnit || 'lb').short || 'units')}/yr · typical 1.5M small / 5M med / 15M large</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;" title="When ON, demand points whose lat/lng falls inside AK (51-72°N, -180 to -130°W) or HI (18-23°N, -161 to -154°W) bounding boxes are dropped before solving. Prevents a single offshore customer from dragging the centroid into the Pacific.">
              <input type="checkbox" id="cog-exclude-offshore" ${config.excludeOffshore ? 'checked' : ''} style="cursor:pointer;">
              Exclude AK &amp; HI from solve
            </label>
            <span style="font-size:11px;color:var(--ies-gray-400);">Keeps offshore demand visible in the points table but out of the k-means math</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;">Fixed $ / DC / yr:</label>
            <input type="number" value="${config.fixedCostPerDC || 0}" step="50000" min="0" id="cog-fixed-cost"
                   title="Annual fully-loaded fixed cost per DC (rent + labor + IT + depreciation). Set to a non-zero value (e.g. $1,500,000) to model a true U-curve on the Sensitivity tab. Leave at 0 for a transport-only curve."
                   style="width:120px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">0 = transport only · >0 = real U-curve (e.g. $1.5M)</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="cog-outlier-toggle" ${config.outlierCapEnabled ? 'checked' : ''}
                     style="cursor:pointer;">
              Cap outlier weights at
            </label>
            <input type="number" value="${config.outlierCapPercentile || 95}" min="80" max="99" step="1" id="cog-outlier-percentile"
                   ${config.outlierCapEnabled ? '' : 'disabled'}
                   title="Winsorize: any point heavier than the Nth-percentile weight is clipped DOWN to that cap before solving."
                   style="width:60px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;${config.outlierCapEnabled ? '' : 'opacity:0.5;'}">
            <span style="font-size:11px;color:var(--ies-gray-400);">th percentile · prevents one mega-account from owning the centroid</span>
          </div>
        </div>
      </div>

      <!-- 2026-05-28 B3 — Mode mix (TL / LTL / parcel). -->
      <div class="hub-card" style="margin-bottom:20px;padding:16px;border-left:3px solid #7c3aed;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-400);">Mode Mix <span style="font-weight:500;text-transform:none;letter-spacing:0;color:var(--ies-gray-300);">(optional)</span></div>
            <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">Blend TL / LTL / parcel rates instead of a single \$/mi. Real networks rarely run 100% TL — applying a flat TL rate to a parcel-heavy customer understates cost by 30-50%.</div>
          </div>
          <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;" title="When ON, the cost engine uses the mode-weighted effective rate instead of the single \$/mi knob. The Truck \$/mi input on Analysis Configuration is ignored while this is on.">
            <input type="checkbox" id="cog-modemix-toggle" ${config.modeMixEnabled ? 'checked' : ''} style="cursor:pointer;">
            Use mode mix
          </label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:10px 16px;font-size:12px;${config.modeMixEnabled ? '' : 'opacity:0.55;'}">
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">TL share</label>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="number" value="${config.modeMix?.tlPct ?? 100}" min="0" max="100" step="5" id="cog-modemix-tl-pct" ${config.modeMixEnabled ? '' : 'disabled'}
                     style="width:64px;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="color:var(--ies-gray-500);">% @ \$</span>
              <input type="number" value="${(config.modeRates?.tlPerMile ?? 2.85).toFixed(2)}" min="0" step="0.05" id="cog-moderates-tl" ${config.modeMixEnabled ? '' : 'disabled'}
                     style="width:64px;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="color:var(--ies-gray-500);">/mi</span>
            </div>
            <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">Truckload — \$2.50-3.20 spot</div>
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">LTL share</label>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="number" value="${config.modeMix?.ltlPct ?? 0}" min="0" max="100" step="5" id="cog-modemix-ltl-pct" ${config.modeMixEnabled ? '' : 'disabled'}
                     style="width:64px;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="color:var(--ies-gray-500);">% @ \$</span>
              <input type="number" value="${(config.modeRates?.ltlPerMile ?? 4.20).toFixed(2)}" min="0" step="0.05" id="cog-moderates-ltl" ${config.modeMixEnabled ? '' : 'disabled'}
                     style="width:64px;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="color:var(--ies-gray-500);">/mi</span>
            </div>
            <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">Less-than-truckload — \$3.80-4.60 effective</div>
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Parcel share</label>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="number" value="${config.modeMix?.parcelPct ?? 0}" min="0" max="100" step="5" id="cog-modemix-parcel-pct" ${config.modeMixEnabled ? '' : 'disabled'}
                     style="width:64px;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <span style="color:var(--ies-gray-500);">%</span>
              <span style="font-size:10px;color:var(--ies-gray-400);margin-left:6px;">→ Parcel Engine card below</span>
            </div>
            <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">Per-package zone-priced (UPS/FedEx) — not \$/mi</div>
          </div>
        </div>
        ${(() => {
          const sum = (config.modeMix?.tlPct || 0) + (config.modeMix?.ltlPct || 0) + (config.modeMix?.parcelPct || 0);
          const natural = calc.effectiveCpm(config.modeMix || {}, config.modeRates || {});
          const formula = calc.effectiveCpmForFormula(config.modeMix || {}, config.modeRates || {}, config.roadFactor ?? 1.22, config.roundTripFactor ?? 2.0);
          const hasParcel = (config.modeMix?.parcelPct || 0) > 0;
          if (!config.modeMixEnabled) return `<div style="font-size:11px;color:var(--ies-gray-400);margin-top:10px;font-style:italic;">Mode mix is off — Analysis uses the single Truck \$/mi knob (\$${(config.transportCostPerMile || 0).toFixed(2)}).</div>`;
          if (sum === 0) return `<div style="font-size:11px;color:#b91c1c;margin-top:10px;font-weight:600;">Shares sum to 0 — set at least one mode > 0 to compute cost.</div>`;
          if (Math.abs(sum - 100) > 0.5) return `<div style="font-size:11px;color:#a16207;margin-top:10px;">Shares sum to ${sum}% (will be normalized to 100%) · natural blended <strong>\$${natural.toFixed(2)}/mi</strong>${hasParcel ? ` · engine uses <strong>\$${formula.toFixed(2)}/mi</strong> (parcel bypasses road×rt)` : ''}</div>`;
          return `<div style="font-size:11px;color:#15803d;margin-top:10px;font-weight:600;">Natural blended: \$${natural.toFixed(2)}/mi${hasParcel ? ` · <span style="font-weight:600;">Engine uses \$${formula.toFixed(2)}/mi</span> <span style="font-weight:500;color:var(--ies-gray-500);">(parcel bypasses road×rt — see note below)</span>` : ''}</div>`;
        })()}
        ${config.modeMixEnabled && (config.modeMix?.parcelPct || 0) > 0 ? `
          <div style="font-size:10px;color:var(--ies-gray-500);margin-top:8px;line-height:1.5;border-top:1px dashed var(--ies-gray-200);padding-top:8px;">
            <strong>Parcel cost:</strong> computed by the Parcel Engine below — per-package, zone-priced, using FedEx Ground 2026 published list rates with fuel + residential + contract-discount adjustments. The earlier bypass-hack is gone; this is first-principles math.
          </div>
        ` : ''}
      </div>

      <!-- 2026-05-28 27c — Parcel Engine card. Only when mode mix on AND parcel > 0. -->
      ${config.modeMixEnabled && (config.modeMix?.parcelPct || 0) > 0 ? `
        <div class="hub-card" style="margin-bottom:20px;padding:16px;border-left:3px solid #be185d;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
            <div>
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#9d174d;">Parcel Engine</div>
              <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">Per-package zone-priced cost via 2026 carrier list rates. Active when Mode Mix parcel share > 0.</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px 16px;font-size:12px;">
            <div>
              <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Carrier</label>
              <select id="cog-parcel-carrier" style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;">
                ${Object.entries(calc.PARCEL_CARRIER_LABELS).map(([key, label]) => `
                  <option value="${key}"${(config.parcelCarrier || 'fedex_ground') === key ? ' selected' : ''}>${label}</option>
                `).join('')}
              </select>
              <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">USPS limit 70 lb · UPS/FedEx 150 lb · service levels in next commit</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Avg pkg weight (lb)</label>
              <input type="number" value="${config.parcelAvgPackageWeightLb ?? 5}" min="0.1" step="0.5" id="cog-parcel-avg-weight"
                     style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">DTC apparel 1-3 · consumer 5-10 · large 30+</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Residential %</label>
              <input type="number" value="${((config.parcelResidentialShare ?? 0.5) * 100).toFixed(0)}" min="0" max="100" step="5" id="cog-parcel-residential"
                     style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">Pure DTC ≈ 95% · B2B ≈ 5%</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Fuel surcharge %</label>
              <input type="number" value="${config.parcelFuelPct ?? 25}" min="0" max="50" step="0.5" id="cog-parcel-fuel"
                     style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">Currently 25-26% (May 2026)</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Contract discount %</label>
              <input type="number" value="${config.parcelContractDiscountPct ?? 0}" min="0" max="80" step="1" id="cog-parcel-discount"
                     style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">Most shippers negotiate 30-60% off list</div>
            </div>
          </div>

          <!-- 2026-05-28 29 — Service mix row -->
          <div style="margin-top:14px;border-top:1px dashed var(--ies-gray-200);padding-top:10px;">
            <div style="font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:6px;">Service mix (% of packages)</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px;">
              ${calc.SERVICE_LEVELS.map(svc => `
                <div>
                  <label style="display:block;font-size:10px;font-weight:600;color:var(--ies-gray-500);margin-bottom:2px;">${svc.label} <span style="color:var(--ies-gray-300);">×${svc.multiplier.toFixed(2)}</span></label>
                  <div style="display:flex;align-items:center;gap:4px;">
                    <input type="number" value="${(config.parcelServiceMix && config.parcelServiceMix[svc.key]) ?? (svc.key === 'ground' ? 100 : 0)}" min="0" max="100" step="5"
                           data-cog-parcel-svc="${svc.key}"
                           style="width:100%;padding:5px 7px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
                    <span style="font-size:11px;color:var(--ies-gray-500);">%</span>
                  </div>
                </div>
              `).join('')}
            </div>
            ${(() => {
              const mult = calc.serviceMixMultiplier(config.parcelServiceMix);
              const sum = calc.SERVICE_LEVELS.reduce((s, svc) => s + (Math.max(0, +(config.parcelServiceMix?.[svc.key]) || 0)), 0);
              if (sum === 0) return `<div style="font-size:11px;color:#b91c1c;margin-top:8px;font-weight:600;">Service shares sum to 0 — set at least one to compute cost.</div>`;
              if (Math.abs(sum - 100) > 0.5) return `<div style="font-size:11px;color:#a16207;margin-top:8px;">Shares sum to ${sum}% (normalized to 100%) · effective multiplier <strong>×${mult.toFixed(2)}</strong></div>`;
              return `<div style="font-size:11px;color:#15803d;margin-top:8px;font-weight:600;">Service-blend multiplier: <strong>×${mult.toFixed(2)}</strong> applied on top of carrier Ground rates</div>`;
            })()}
          </div>
          ${(() => {
            const sampleW = config.parcelAvgPackageWeightLb ?? 5;
            const r = calc.parcelCostPerPackage({
              weight: sampleW, distanceMi: 800,
              fuelPct: config.parcelFuelPct ?? 25,
              residentialShare: config.parcelResidentialShare ?? 0.5,
              discountPct: config.parcelContractDiscountPct ?? 0,
              carrier: config.parcelCarrier || 'fedex_ground',
              serviceMix: config.parcelServiceMix,
            });
            return `<div style="font-size:11px;color:var(--ies-gray-500);margin-top:10px;border-top:1px dashed var(--ies-gray-200);padding-top:8px;line-height:1.5;">
              <strong>Sample at current settings:</strong> ${sampleW} lb pkg @ Zone ${r.zone} (≈800 mi) = <strong>\$${r.cost.toFixed(2)}/pkg</strong> · base \$${r.baseGround.toFixed(2)} (Ground) × ${r.svcMult.toFixed(2)} (svc mix) = \$${r.base.toFixed(2)} + fuel \$${r.fuelAdd.toFixed(2)} − discount \$${r.discount.toFixed(2)} + residential \$${r.residAdd.toFixed(2)}
            </div>`;
          })()}
        </div>
      ` : ''}

      <!-- 2026-05-28 E2 — Current State DCs for the vs-current benchmark. -->
      <div class="hub-card" style="margin-bottom:20px;padding:16px;border-left:3px solid #92400e;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-400);">Current State <span style="font-weight:500;text-transform:none;letter-spacing:0;color:var(--ies-gray-300);">(optional)</span></div>
            <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">The customer's existing DC footprint. When set, Analysis renders a side-by-side Current vs Proposed benchmark card with cost / coverage / CO₂ deltas.</div>
          </div>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-currentstate-copy-candidates" title="One-click: use the candidate facility list above as the current-state DCs (handy when the customer's existing sites are also in your candidate pool)" ${(config.candidateFacilities || []).length === 0 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Use my candidates</button>
        </div>
        <textarea id="cog-currentstate-list" rows="3"
                  placeholder="One per line — Label, Lat, Lng &#10;Examples: &#10;Memphis DC, 35.1495, -90.0490 &#10;Reno DC, 39.5296, -119.8138"
                  style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-family:monospace;line-height:1.5;">${(config.currentStateDCs || []).map(c => `${c.label || ''}, ${c.lat}, ${c.lng}`).join('\n')}</textarea>
        <div id="cog-currentstate-feedback" style="font-size:11px;color:var(--ies-gray-400);margin-top:4px;">${(config.currentStateDCs || []).length ? `${(config.currentStateDCs || []).length} current-state DC${(config.currentStateDCs || []).length === 1 ? '' : 's'} loaded — benchmark card will appear on Analysis after Run` : 'No current state yet — paste lines above to enable the vs-current benchmark.'}</div>
      </div>

      <!-- Candidate Facilities (COG-B2 — snap k-means centers to a fixed list) -->
      <div class="hub-card" style="margin-bottom:20px;padding:16px;border-left:3px solid var(--ies-blue-light, #60a5fa);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-400);">Candidate Facilities <span style="font-weight:500;text-transform:none;letter-spacing:0;color:var(--ies-gray-300);">(optional)</span></div>
            <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">Snap solver centers to a fixed list of available sites (existing GXO buildings, REIT inventory, M&amp;A targets) instead of free lat/lng centroids.</div>
          </div>
          <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;" title="When ON, k-means runs as usual then each center is moved to the nearest candidate facility from the list below.">
            <input type="checkbox" id="cog-snap-toggle" ${config.snapToCandidates ? 'checked' : ''} style="cursor:pointer;">
            Snap solver centers to candidates
          </label>
        </div>
        <textarea id="cog-candidate-list" rows="4"
                  placeholder="One per line — Label, Lat, Lng (prefix * to lock) &#10;Examples: &#10;*Memphis DC, 35.1495, -90.0490 &#10;DFW DC, 32.7767, -96.7970 &#10;LAX DC, 33.9425, -118.4081"
                  style="width:100%;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-family:monospace;line-height:1.5;${config.snapToCandidates ? '' : 'opacity:0.55;'}"
                  ${config.snapToCandidates ? '' : 'disabled'}>${(config.candidateFacilities || []).map(c => `${c.locked ? '*' : ''}${c.label || ''}, ${c.lat}, ${c.lng}`).join('\n')}</textarea>
        <div id="cog-candidate-feedback" style="font-size:11px;color:var(--ies-gray-400);margin-top:4px;">${(config.candidateFacilities || []).length ? `${(config.candidateFacilities || []).length} candidate site(s) loaded` : 'No candidates yet — paste lines above when you want to constrain the solver.'}</div>
      </div>
    </div>
  `;

  // Bind config inputs (lifted from old renderPoints).
  el.querySelector('#cog-k')?.addEventListener('change', (e) => {
    config.numCenters = Math.max(1, Math.min(20, parseInt(/** @type {HTMLInputElement} */ (e.target).value) || 1));
    markDirty();
  });
  el.querySelector('#cog-cpm')?.addEventListener('change', (e) => {
    config.transportCostPerMile = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 2.85;
    markDirty();
  });
  // 2026-05-26 — Round-trip factor input.
  el.querySelector('#cog-rt-factor')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.roundTripFactor = (Number.isFinite(v) && v > 0) ? v : 2.0;
    markDirty();
  });
  // 2026-05-28 — Road-factor input.
  el.querySelector('#cog-road-factor')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.roadFactor = (Number.isFinite(v) && v >= 1.0) ? v : 1.22;
    markDirty();
  });
  // 2026-05-28 — CO₂ intensity input (B20 emissions output).
  el.querySelector('#cog-co2')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.co2KgPerTruckMile = (Number.isFinite(v) && v >= 0) ? v : 1.62;
    markDirty();
  });
  // 2026-05-28 — Max service miles input (B7 service-level constraint).
  el.querySelector('#cog-max-service')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.maxServiceMiles = (Number.isFinite(v) && v >= 0) ? v : 0;
    markDirty();
  });
  // 2026-05-28 — Capacity per DC input (B6 capacity constraint).
  el.querySelector('#cog-capacity')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.capacityPerDC = (Number.isFinite(v) && v >= 0) ? v : 0;
    markDirty();
  });
  // 2026-05-26 — Exclude Alaska & Hawaii checkbox.
  el.querySelector('#cog-exclude-offshore')?.addEventListener('change', (e) => {
    config.excludeOffshore = /** @type {HTMLInputElement} */ (e.target).checked;
    markDirty();
  });
  el.querySelector('#cog-weight-unit')?.addEventListener('change', (e) => {
    const v = /** @type {HTMLSelectElement} */ (e.target).value || 'lb';
    config.weightUnit = v;
    const meta = calc.getWeightUnitMeta(v);
    const cur = config.unitsPerTruck;
    const wasOnAnyDefault = calc.WEIGHT_UNIT_OPTIONS.some(u => u.defaultCap === cur);
    if (wasOnAnyDefault) config.unitsPerTruck = meta.defaultCap;
    markDirty();
    renderParametersPhase(el);
  });
  el.querySelector('#cog-cap')?.addEventListener('change', (e) => {
    config.unitsPerTruck = Math.max(1, parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 25000);
    markDirty();
  });
  el.querySelector('#cog-iter')?.addEventListener('change', (e) => {
    config.maxIterations = Math.max(10, Math.min(500, parseInt(/** @type {HTMLInputElement} */ (e.target).value) || 100));
    markDirty();
  });
  // 2026-05-28 B17 — sensitivity max k.
  el.querySelector('#cog-sens-max')?.addEventListener('change', (e) => {
    const v = parseInt(/** @type {HTMLInputElement} */ (e.target).value, 10);
    config.sensitivityMaxK = Math.max(2, Math.min(20, Number.isFinite(v) ? v : 8));
    markDirty();
  });
  // 2026-05-28 H3 — reset Parameters to defaults. Preserves Deal Context
  // (customer/industry/stage/notes), points, and Current State DCs —
  // because losing the deal metadata + the customer-supplied dataset on a
  // configuration reset would be hostile.
  el.querySelector('#cog-reset-defaults')?.addEventListener('click', async () => {
    const ok = await showConfirm('Reset all Parameters to defaults? This preserves Deal Context, demand points, and Current State DCs.');
    if (!ok) return;
    const preserve = {
      customerName: config.customerName,
      industry: config.industry,
      dealStage: config.dealStage,
      notes: config.notes,
      currentStateDCs: config.currentStateDCs,
    };
    config = { ...calc.DEFAULT_CONFIG, ...preserve };
    markDirty();
    renderParametersPhase(el);
    showToast('Parameters reset to defaults.', 'ok');
  });
  el.querySelector('#cog-fixed-cost')?.addEventListener('change', (e) => {
    config.fixedCostPerDC = Math.max(0, parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0);
    markDirty();
  });
  el.querySelector('#cog-outlier-toggle')?.addEventListener('change', (e) => {
    config.outlierCapEnabled = /** @type {HTMLInputElement} */ (e.target).checked;
    markDirty();
    renderParametersPhase(el);
  });
  el.querySelector('#cog-outlier-percentile')?.addEventListener('change', (e) => {
    const v = parseInt(/** @type {HTMLInputElement} */ (e.target).value);
    config.outlierCapPercentile = Math.max(80, Math.min(99, isFinite(v) ? v : 95));
    markDirty();
  });

  // 2026-05-28 B3 — Mode mix handlers.
  el.querySelector('#cog-modemix-toggle')?.addEventListener('change', (e) => {
    config.modeMixEnabled = /** @type {HTMLInputElement} */ (e.target).checked;
    markDirty();
    renderParametersPhase(el);
  });
  const bindModePct = (id, key) => {
    el.querySelector(id)?.addEventListener('change', (e) => {
      const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
      config.modeMix = config.modeMix || { tlPct: 100, ltlPct: 0, parcelPct: 0 };
      config.modeMix[key] = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
      markDirty();
      renderParametersPhase(el);
    });
  };
  bindModePct('#cog-modemix-tl-pct', 'tlPct');
  bindModePct('#cog-modemix-ltl-pct', 'ltlPct');
  bindModePct('#cog-modemix-parcel-pct', 'parcelPct');
  const bindModeRate = (id, key) => {
    el.querySelector(id)?.addEventListener('change', (e) => {
      const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
      config.modeRates = config.modeRates || { tlPerMile: 2.85, ltlPerMile: 4.20, parcelPerMile: 28.00 };
      config.modeRates[key] = Math.max(0, Number.isFinite(v) ? v : 0);
      markDirty();
      renderParametersPhase(el);
    });
  };
  bindModeRate('#cog-moderates-tl', 'tlPerMile');
  bindModeRate('#cog-moderates-ltl', 'ltlPerMile');
  bindModeRate('#cog-moderates-parcel', 'parcelPerMile');

  // 2026-05-28 27c — Parcel Engine bindings.
  el.querySelector('#cog-parcel-carrier')?.addEventListener('change', (e) => {
    config.parcelCarrier = /** @type {HTMLSelectElement} */ (e.target).value || 'fedex_ground';
    markDirty(); renderParametersPhase(el);
  });
  el.querySelector('#cog-parcel-avg-weight')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.parcelAvgPackageWeightLb = Math.max(0.1, Number.isFinite(v) ? v : 5);
    markDirty(); renderParametersPhase(el);
  });
  el.querySelector('#cog-parcel-residential')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.parcelResidentialShare = Math.max(0, Math.min(1, (Number.isFinite(v) ? v : 50) / 100));
    markDirty(); renderParametersPhase(el);
  });
  el.querySelector('#cog-parcel-fuel')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.parcelFuelPct = Math.max(0, Number.isFinite(v) ? v : 25);
    markDirty(); renderParametersPhase(el);
  });
  el.querySelector('#cog-parcel-discount')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.parcelContractDiscountPct = Math.max(0, Math.min(80, Number.isFinite(v) ? v : 0));
    markDirty(); renderParametersPhase(el);
  });
  // 2026-05-28 29 — Parcel service-mix bindings.
  el.querySelectorAll('[data-cog-parcel-svc]').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = /** @type {HTMLElement} */ (e.target).dataset.cogParcelSvc;
      const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
      config.parcelServiceMix = config.parcelServiceMix || { ground: 100, threeDay: 0, twoDay: 0, overnight: 0 };
      config.parcelServiceMix[key] = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
      markDirty(); renderParametersPhase(el);
    });
  });

  // 2026-05-28 E2 — Current state handlers.
  el.querySelector('#cog-currentstate-list')?.addEventListener('change', (e) => {
    const raw = /** @type {HTMLTextAreaElement} */ (e.target).value || '';
    const parsed = [];
    raw.split(/\r?\n/).forEach(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const parts = t.split(',').map(s => s.trim());
      let label, lat, lng;
      if (parts.length >= 3) {
        label = parts.slice(0, parts.length - 2).join(', ');
        lat = parseFloat(parts[parts.length - 2]);
        lng = parseFloat(parts[parts.length - 1]);
      } else if (parts.length === 2) {
        lat = parseFloat(parts[0]);
        lng = parseFloat(parts[1]);
      }
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        parsed.push({ label: label || `Site ${parsed.length + 1}`, lat, lng });
      }
    });
    config.currentStateDCs = parsed;
    const fb = el.querySelector('#cog-currentstate-feedback');
    if (fb) {
      fb.textContent = parsed.length
        ? `${parsed.length} current-state DC${parsed.length === 1 ? '' : 's'} loaded — benchmark card will appear on Analysis after Run`
        : 'No valid lines parsed — format: Label, Lat, Lng (one per line)';
    }
    markDirty();
  });
  el.querySelector('#cog-currentstate-copy-candidates')?.addEventListener('click', () => {
    const cands = config.candidateFacilities || [];
    if (cands.length === 0) {
      showToast('No candidate facilities to copy from.', 'warn');
      return;
    }
    config.currentStateDCs = cands.map(c => ({ label: c.label, lat: c.lat, lng: c.lng }));
    markDirty();
    renderParametersPhase(el);
    showToast(`Copied ${cands.length} candidate site${cands.length === 1 ? '' : 's'} as current state.`, 'ok');
  });

  el.querySelector('#cog-snap-toggle')?.addEventListener('change', (e) => {
    config.snapToCandidates = /** @type {HTMLInputElement} */ (e.target).checked;
    markDirty();
    renderParametersPhase(el);
  });
  el.querySelector('#cog-candidate-list')?.addEventListener('change', (e) => {
    const raw = /** @type {HTMLTextAreaElement} */ (e.target).value || '';
    const parsed = [];
    raw.split(/\r?\n/).forEach(line => {
      let t = line.trim();
      if (!t || t.startsWith('#')) return;
      // 2026-05-28 B9 — leading '*' marks the candidate as LOCKED.
      let locked = false;
      if (t.startsWith('*')) { locked = true; t = t.slice(1).trim(); }
      const parts = t.split(',').map(s => s.trim());
      let label, lat, lng;
      if (parts.length >= 3) {
        label = parts.slice(0, parts.length - 2).join(', ');
        lat = parseFloat(parts[parts.length - 2]);
        lng = parseFloat(parts[parts.length - 1]);
      } else if (parts.length === 2) {
        lat = parseFloat(parts[0]);
        lng = parseFloat(parts[1]);
      }
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        parsed.push({ label: label || `Site ${parsed.length + 1}`, lat, lng, locked });
      }
    });
    config.candidateFacilities = parsed;
    const fb = el.querySelector('#cog-candidate-feedback');
    if (fb) {
      const lockedCount = parsed.filter(c => c.locked).length;
      fb.textContent = parsed.length
        ? `${parsed.length} candidate site${parsed.length === 1 ? '' : 's'} loaded${lockedCount > 0 ? ` · ${lockedCount} locked (★)` : ''}`
        : 'No valid lines parsed — format: Label, Lat, Lng (one per line) · prefix with * to lock';
    }
    markDirty();
  });
}

function renderRunPhase(el) {
  // 2026-04-27 EVE2 (COG-SCOPE-3/4): one phase, three views over a single
  // solve. Header KPI strip surfaces Recommended k (from sensitivityData)
  // alongside the existing centers/cost summary.
  // COG-SCOPE-4: Recommended k tile when sensitivity has a recommendation.
  let recK = null;
  if (Array.isArray(sensitivityData) && sensitivityData.length > 0) {
    // Look for the entry flagged as the recommended elbow / U-curve minimum.
    const flagged = sensitivityData.find(d => d.isRecommended) || sensitivityData.find(d => d.recommended);
    if (flagged) recK = flagged.k;
    else {
      // Fallback: the entry with the lowest totalCost.
      const min = sensitivityData.reduce((m, d) => (m == null || (d.totalCost != null && d.totalCost < m.totalCost)) ? d : m, null);
      if (min) recK = min.k;
    }
  }

  el.innerHTML = `
    <div>
      <!-- Sub-tabs moved to chrome Row 2 (CM Chrome v3 ripple) -->

      ${cogResult && recK != null ? (() => {
        // 2026-05-28 H8 — escalate when the user's current k differs from
        // the sensitivity-recommended k.
        const currentK = cogResult.centers.length;
        const matches = currentK === recK;
        const accent = matches ? '#22c55e' : '#f59e0b';
        const accentDark = matches ? '#059669' : '#b45309';
        const bgGrad = matches ? 'linear-gradient(135deg,#f0fdf4,#f0f9ff)' : 'linear-gradient(135deg,#fffbeb,#fef3c7)';
        return `
        <div class="hub-card" style="background:${bgGrad};border:1px solid ${accent};padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.4px;color:${accentDark};text-transform:uppercase;">Recommended</div>
            <div style="font-size:30px;font-weight:800;color:${accentDark};line-height:1;">${recK}</div>
            <div style="font-size:10px;color:${accentDark};font-weight:600;">${recK === 1 ? 'DC' : 'DCs'}</div>
          </div>
          <div style="font-size:12px;color:var(--ies-gray-600);flex:1;line-height:1.45;">
            ${matches ? `
              We tested networks from <strong>1 to ${(Array.isArray(sensitivityData) ? sensitivityData.length : 0)} DCs</strong> against your current demand and parameters. <strong>${recK} ${recK === 1 ? 'DC' : 'DCs'}</strong> gave the lowest total cost — matches your current selection. Open the <b>Sensitivity</b> tab to see the curve.
            ` : `
              We tested networks from <strong>1 to ${(Array.isArray(sensitivityData) ? sensitivityData.length : 0)} DCs</strong>. You're currently running <strong>${currentK} ${currentK === 1 ? 'DC' : 'DCs'}</strong>, but <strong>${recK} ${recK === 1 ? 'DC' : 'DCs'}</strong> gave the lowest total cost. <button data-cog-jump-k="${recK}" style="background:none;border:none;color:${accentDark};text-decoration:underline;cursor:pointer;font-weight:700;padding:0;font-size:12px;">Switch to k=${recK} and re-run →</button>
            `}
          </div>
        </div>
      `; })() : ''}

      <div id="cog-run-inner"></div>
    </div>
  `;

  // 2026-05-28 H8 — wire the 'Switch to k=N and re-run' link in the
  // Recommended-k banner. Updates config.numCenters + triggers the same
  // run path as the chrome Run button.
  el.querySelectorAll('[data-cog-jump-k]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = parseInt(/** @type {HTMLElement} */ (btn).dataset.cogJumpK, 10);
      if (!Number.isFinite(target) || target < 1) return;
      config.numCenters = target;
      markDirty();
      // Re-run via the same code path the chrome Run button uses.
      const runBtn = rootEl?.querySelector('[data-tc-action="cog-run"]');
      if (runBtn) /** @type {HTMLElement} */ (runBtn).click();
    });
  });

  const inner = el.querySelector('#cog-run-inner');
  if (runSubTab === 'map')         renderMap(inner);
  else if (runSubTab === 'sensitivity') renderSensitivity(inner);
  else if (runSubTab === 'compare') renderCompare(inner);
  else                              renderAnalysis(inner);
}

// ============================================================
// ANALYSIS TAB
// ============================================================

function renderAnalysis(el) {
  if (!cogResult) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Click <strong>Run</strong> in the toolbar above to see results.</p></div>';
    return;
  }
  // Guard against partial saved results (e.g., seeded via SQL with summary
  // fields only). estimateTransportCost reads cogResult.assignments.filter —
  // without a guard the whole render would throw and the content area would
  // be left empty.
  const hasAssignments = Array.isArray(cogResult.assignments) && cogResult.assignments.length > 0;
  if (!hasAssignments) {
    el.innerHTML = `
      <div class="hub-card" style="max-width:900px;border-left:3px solid var(--ies-orange);">
        <h3 class="text-section" style="margin-top:0;">Results Preview</h3>
        <p class="text-body">This scenario has summary results but lacks the per-point assignments needed for the full analysis view. Click the <strong>Run</strong> button in the toolbar above to rebuild the full solve from the current points + config.</p>
        ${(cogResult.centers || []).length > 0 ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--ies-gray-200);">
            <div class="text-subtitle">Seeded Centers (${cogResult.centers.length})</div>
            ${cogResult.centers.map((c, i) => `
              <div style="margin-top:6px;font-size:13px;">
                Center ${i + 1}: ${c.lat?.toFixed(3)}, ${c.lng?.toFixed(3)}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
    return;
  }

  // 2026-05-28 30 — read engine source of truth instead of recomputing.
  // estimateTransportCost ignores mode-mix/parcel; cogResult has the
  // proper blended numbers stamped by _enrichCogResultWithCost.
  const costEst = {
    totalCost: cogResult.totalCost ?? 0,
    avgCostPerUnit: cogResult.avgCostPerUnit ?? 0,
    totalTruckloads: cogResult.totalTruckloads ?? 0,
    totalTruckMiles: cogResult.totalTruckMiles ?? 0,
  };

  el.innerHTML = `
    <div>
      ${(() => {
        // 2026-05-28 E2 — Vs-current-state benchmark card. Only renders when
        // a current-state DC list is set + we have a cogResult to compare.
        const csList = (config.currentStateDCs || []).filter(d => Number.isFinite(+d.lat) && Number.isFinite(+d.lng));
        if (csList.length === 0) return '';
        const solvePts = _pointsForSolve();
        if (solvePts.length === 0) return '';
        const csMcr = calc.buildMcrFromDcList(csList, solvePts);
        if (!csMcr) return '';
        // Run the same math on the current-state network.
        const csCost = calc.estimateTransportCost(csMcr, solvePts, _resolveCpm(), config.unitsPerTruck || 25000, config.roundTripFactor ?? 2.0, config.roadFactor ?? 1.22);
        calc.flagServiceViolations(csMcr, solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
        const csCo2 = (csCost.totalTruckMiles || 0) * (config.co2KgPerTruckMile ?? 1.62) / 1000;
        const csAvgDist = csMcr.totalWeightedDistance / Math.max(1, solvePts.reduce((s, p) => s + (p.weight || 0), 0));

        // Proposed-state numbers from cogResult (already enriched).
        const propCost = cogResult.totalCost || 0;
        const propCo2 = cogResult.co2Tons || 0;
        const propCoverage = cogResult.serviceStats?.maxMiles > 0 ? cogResult.serviceStats.coveragePct : null;
        const csCoverage = csMcr.serviceStats?.maxMiles > 0 ? csMcr.serviceStats.coveragePct : null;
        const propAvgDist = cogResult.totalWeightedDistance / Math.max(1, solvePts.reduce((s, p) => s + (p.weight || 0), 0));

        const dCost = csCost.totalCost - propCost;
        const dCostPct = csCost.totalCost > 0 ? ((dCost / csCost.totalCost) * 100) : 0;
        const dCo2 = csCo2 - propCo2;
        const dCo2Pct = csCo2 > 0 ? ((dCo2 / csCo2) * 100) : 0;
        const dCoverage = (csCoverage != null && propCoverage != null) ? (propCoverage - csCoverage) : null;
        const dAvgDist = csAvgDist - propAvgDist;

        const goodColor = '#15803d';  // green = savings / improvement
        const badColor = '#b91c1c';   // red = worse
        const sign = (n) => n > 0 ? '+' : '';
        const cell = (val, color) => `<div style="font-weight:700;color:${color || 'var(--ies-gray-800)'};">${val}</div>`;
        const deltaCell = (val, isGood, isNeutral) => {
          const c = isNeutral ? 'var(--ies-gray-500)' : (isGood ? goodColor : badColor);
          return `<div style="font-weight:700;color:${c};">${val}</div>`;
        };

        return `
          <div class="hub-card" style="margin-bottom:20px;padding:18px 20px;background:linear-gradient(135deg,#fffbeb,#f0fdf4);border-left:5px solid #15803d;">
            <div style="font-size:13px;font-weight:700;color:#15803d;margin-bottom:6px;">Network Benchmark — Current State vs Proposed</div>
            <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:12px;">Same demand, same cost rates, same SLA threshold. Differences come from where the DCs sit.</div>
            <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:8px 16px;font-size:13px;align-items:baseline;">
              <div style="font-weight:700;color:var(--ies-gray-500);font-size:11px;text-transform:uppercase;">Metric</div>
              <div style="font-weight:700;color:var(--ies-gray-500);font-size:11px;text-transform:uppercase;text-align:right;">Current (${csList.length} DC${csList.length === 1 ? '' : 's'})</div>
              <div style="font-weight:700;color:var(--ies-gray-500);font-size:11px;text-transform:uppercase;text-align:right;">Proposed (${cogResult.centers.length} DC${cogResult.centers.length === 1 ? '' : 's'})</div>
              <div style="font-weight:700;color:var(--ies-gray-500);font-size:11px;text-transform:uppercase;text-align:right;">Delta</div>

              <div style="color:var(--ies-gray-600);">Centers</div>
              <div style="text-align:right;">${cell(csList.length)}</div>
              <div style="text-align:right;">${cell(cogResult.centers.length)}</div>
              <div style="text-align:right;">${deltaCell((cogResult.centers.length - csList.length > 0 ? '+' : '') + (cogResult.centers.length - csList.length), null, true)}</div>

              <div style="color:var(--ies-gray-600);">Annual transport cost</div>
              <div style="text-align:right;">${cell(calc.formatCurrency(csCost.totalCost, { compact: true }))}</div>
              <div style="text-align:right;">${cell(calc.formatCurrency(propCost, { compact: true }))}</div>
              <div style="text-align:right;">${deltaCell(`${sign(-dCost)}${calc.formatCurrency(Math.abs(dCost), { compact: true })} (${sign(-dCostPct)}${Math.abs(dCostPct).toFixed(1)}%)`, dCost > 0)}</div>

              ${(csCoverage != null && propCoverage != null) ? `
                <div style="color:var(--ies-gray-600);">Service coverage (${config.maxServiceMiles} mi)</div>
                <div style="text-align:right;">${cell(csCoverage.toFixed(1) + '%')}</div>
                <div style="text-align:right;">${cell(propCoverage.toFixed(1) + '%')}</div>
                <div style="text-align:right;">${deltaCell(`${sign(dCoverage)}${dCoverage.toFixed(1)}pp`, dCoverage > 0)}</div>
              ` : ''}

              <div style="color:var(--ies-gray-600);">Annual CO₂ (tons)</div>
              <div style="text-align:right;">${cell(csCo2.toLocaleString(undefined, { maximumFractionDigits: 0 }))}</div>
              <div style="text-align:right;">${cell(propCo2.toLocaleString(undefined, { maximumFractionDigits: 0 }))}</div>
              <div style="text-align:right;">${deltaCell(`${sign(-dCo2)}${Math.abs(dCo2).toLocaleString(undefined, { maximumFractionDigits: 0 })} t (${sign(-dCo2Pct)}${Math.abs(dCo2Pct).toFixed(1)}%)`, dCo2 > 0)}</div>

              <div style="color:var(--ies-gray-600);">Avg weighted distance</div>
              <div style="text-align:right;">${cell(calc.formatMiles(csAvgDist))}</div>
              <div style="text-align:right;">${cell(calc.formatMiles(propAvgDist))}</div>
              <div style="text-align:right;">${deltaCell(`${sign(-dAvgDist)}${calc.formatMiles(Math.abs(dAvgDist))}`, dAvgDist > 0)}</div>
            </div>
          </div>
        `;
      })()}

      <!-- Action Bar -->
      <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center;">
        <h3 class="text-section" style="margin:0;flex:1;">Analysis Results</h3>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-print-pdf" style="display:flex;align-items:center;gap:6px;" title="Open a print-friendly snapshot in a new tab — use your browser's Print > Save as PDF">
          <span>🖨️ Print / PDF</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-export-csv" style="display:flex;align-items:center;gap:6px;">
          <span>↓ Export CSV</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-export-geojson" style="display:flex;align-items:center;gap:6px;" title="GeoJSON file with centers + assignments — opens directly in QGIS, kepler.gl, or any GIS tool">
          <span>↓ Export GeoJSON</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-push-netopt" style="display:flex;align-items:center;gap:6px;">
          <span>Send to NetOpt →</span>
        </button>
      </div>

      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Centers Found', String(cogResult.centers.length))}
          ${kpi('Iterations', String(cogResult.iterations))}
          ${kpi('Annual Truckloads', Math.round(costEst.totalTruckloads || 0).toLocaleString())}
          ${kpi('Est. Transport Cost', calc.formatCurrency(costEst.totalCost, { compact: true }))}
          ${kpi('Avg Cost/Unit', calc.formatCurrency(costEst.avgCostPerUnit))}
        </div>
      </div>

      <!-- 2026-05-26 — Transparent cost breakdown. Shows every multiplier in
           the transport-cost formula so the math is auditable on-screen.
           Helps users sanity-check the result against their own back-of-envelope
           and catch unit-of-measure mismatches early. -->
      ${(() => {
        const totalWeight = points.filter(p => p.type !== 'excluded' && p.lat != null).reduce((s, p) => s + (p.weight || 0), 0);
        const capacity = Math.max(1, config.unitsPerTruck || 25000);
        const trucks = totalWeight / capacity;
        const totalGcMi = cogResult.assignments.reduce((s, a) => {
          const pt = points.find(p => p.id === a.pointId);
          const w = pt?.weight || 0;
          return s + (w / capacity) * a.distanceToCenter;
        }, 0);
        // 2026-05-28 — surface road-factor before round-trip so the path
        // is great-circle → road → round-trip. Matches estimateTransportCost.
        const road = Math.max(1, +config.roadFactor || 1.22);
        const totalLoadedMi = totalGcMi * road;
        const rt = Math.max(1, +config.roundTripFactor || 2.0);
        const totalMi = totalLoadedMi * rt;
        // 2026-05-28 — use formula-adjusted cpm so the breakdown total
        // matches what the engine computes (parcel slice bypasses road×rt).
        const cpm = config.modeMixEnabled
          ? calc.effectiveCpmForFormula(config.modeMix, config.modeRates, config.roadFactor ?? 1.22, config.roundTripFactor ?? 2.0)
          : (config.transportCostPerMile || 0);
        const unitLabel = (calc.getWeightUnitMeta(config.weightUnit || 'lb').short || 'units');
        const fmtNum = (n) => Math.round(n).toLocaleString();
        return `
        <div class="hub-card" style="margin-bottom:20px;padding:14px 18px;background:#f8fafc;border-left:4px solid #475569;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:var(--ies-gray-500);margin-bottom:10px;">How this cost was calculated</div>
          <div style="display:grid;grid-template-columns:auto 1fr auto;gap:6px 18px;font-size:13px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;align-items:baseline;">
            <span style="color:var(--ies-gray-500);">Annual demand</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">${fmtNum(totalWeight)} ${unitLabel}</span>
            <span style="color:var(--ies-gray-500);">÷ ${fmtNum(capacity)} ${unitLabel} per truckload</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">= ${fmtNum(trucks)} truckloads/yr</span>
            <span style="color:var(--ies-gray-500);">× weighted avg distance to assigned DC</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">= ${fmtNum(totalGcMi)} great-circle mi/yr</span>
            <span style="color:var(--ies-gray-500);">× ${road.toFixed(2)} road factor (great-circle → road)</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">= ${fmtNum(totalLoadedMi)} loaded road-mi/yr</span>
            <span style="color:var(--ies-gray-500);">× ${rt.toFixed(1)} round-trip factor</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">= ${fmtNum(totalMi)} total truck-mi/yr</span>
            ${config.modeMixEnabled ? `
              <span style="color:var(--ies-gray-500);grid-column:1 / 4;border-top:1px dashed var(--ies-gray-200);padding-top:6px;margin-top:4px;"></span>
              <span style="color:var(--ies-gray-500);">Mode mix: TL ${config.modeMix.tlPct}% @ $${(config.modeRates.tlPerMile || 0).toFixed(2)} · LTL ${config.modeMix.ltlPct}% @ $${(config.modeRates.ltlPerMile || 0).toFixed(2)} · Parcel ${config.modeMix.parcelPct}% @ $${(config.modeRates.parcelPerMile || 0).toFixed(2)}</span>
              <span></span>
              <span style="text-align:right;font-weight:600;">= $${cpm.toFixed(2)} blended /mi</span>
            ` : ''}
            <span style="color:var(--ies-gray-500);">× $${cpm.toFixed(2)} per loaded mile</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">= ${calc.formatCurrency(totalMi * cpm, { compact: true })}/yr ${cogResult.parcelDetails ? ' <em style="color:var(--ies-gray-400);font-weight:500;">(TL+LTL only)</em>' : ''}</span>
            ${cogResult.parcelDetails ? `
              <span style="color:var(--ies-gray-500);grid-column:1 / 4;border-top:1px dashed var(--ies-gray-200);padding-top:6px;margin-top:4px;"></span>
              <span style="color:var(--ies-gray-500);">Parcel: ${fmtNum(cogResult.parcelDetails.totalPackages)} pkgs × $${(cogResult.parcelCost / Math.max(1, cogResult.parcelDetails.totalPackages)).toFixed(2)} avg</span>
              <span style="font-size:10px;color:var(--ies-gray-400);">${Object.entries(cogResult.parcelDetails.byZone).filter(([_, n]) => n > 0).map(([z, n]) => 'Z' + z + ':' + Math.round(n / cogResult.parcelDetails.totalPackages * 100) + '%').join(' · ')}</span>
              <span style="text-align:right;font-weight:600;">= ${calc.formatCurrency(cogResult.parcelCost, { compact: true })}/yr</span>
              <span style="color:var(--ies-gray-500);grid-column:1 / 4;border-top:1px solid var(--ies-gray-300);padding-top:6px;margin-top:4px;"></span>
              <span style="color:var(--ies-gray-700);font-weight:700;">TOTAL transport cost</span>
              <span></span>
              <span style="text-align:right;font-weight:800;color:var(--ies-blue);">= ${calc.formatCurrency(cogResult.totalCost, { compact: true })}/yr</span>
            ` : ''}
            <span style="color:var(--ies-gray-500);grid-column:1 / 4;border-top:1px dashed var(--ies-gray-200);padding-top:6px;margin-top:4px;"></span>
            <span style="color:var(--ies-gray-500);">CO₂: ${fmtNum(totalMi)} truck-mi × ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi ${cogResult.parcelDetails ? '<em>(truck only; parcel CO₂ embedded in carrier rate)</em>' : ''}</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">= ${(totalMi * (config.co2KgPerTruckMile ?? 1.62) / 1000).toFixed(0).toLocaleString()} tons CO₂/yr</span>
          </div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:10px;line-height:1.4;">
            <strong>Sanity check:</strong> ${calc.formatCurrency(totalMi * cpm / Math.max(1, trucks), { compact: true })} per truckload &middot;
            ${cpm.toFixed(2)} × ${rt.toFixed(1)} = $${(cpm * rt).toFixed(2)} per truck-mile all-in (loaded + empty).
            If this looks off, adjust <strong>$/mi</strong>, <strong>round-trip factor</strong>, or <strong>${unitLabel}/truck</strong> in <a href="#" data-cog-jump="parameters" style="color:var(--ies-blue);text-decoration:underline;">Parameters</a>.
          </div>
        </div>`;
      })()}

      <!-- Center Details -->
      ${cogResult.centers.map((c, i) => {
        // 2026-05-28 E1 — per-cluster cost. cogResult.costByCluster is
        // populated by _enrichCogResultWithCost; fall back to inline calc
        // if a saved result is missing it. Shows the cost share each
        // center contributes to the total transport bill.
        const clusterCost = Array.isArray(cogResult.costByCluster) ? cogResult.costByCluster[i] : null;
        const totalClusterCost = Array.isArray(cogResult.costByCluster) ? cogResult.costByCluster.reduce((s, x) => s + x, 0) : 0;
        const costShare = (totalClusterCost > 0 && clusterCost != null) ? (clusterCost / totalClusterCost * 100) : null;
        return `
        <div class="hub-card" style="margin-bottom:16px;border-left:4px solid ${clusterColor(i)};">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
            <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${clusterColor(i)};"></span>
            <span style="font-size:14px;font-weight:700;">Center ${i + 1}: ${c.nearestCity}</span>
            ${c.locked ? `<span title="This center is locked — k-means kept it pinned at this candidate site through every iteration." style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;background:#fef3c7;color:#92400e;letter-spacing:0.4px;">★ LOCKED${c.candidateLabel ? ' → ' + c.candidateLabel : ''}</span>` : (c.candidateLabel ? `<span title="K-means picked this from your candidate list. Free centroid was ${calc.formatLatLng(c.snappedFromLat, c.snappedFromLng)}." style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;background:#dbeafe;color:#1d4ed8;letter-spacing:0.4px;">SNAPPED → ${c.candidateLabel}</span>` : '')}
          </div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px;font-size:13px;">
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Location</span>
              <div style="font-weight:600;">${calc.formatLatLng(c.lat, c.lng)}</div>
            </div>
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Assigned Weight</span>
              <div style="font-weight:600;">${c.totalWeight.toLocaleString()}${(() => {
                const cap = cogResult.capacityStats;
                if (!cap || cap.capacityPerDC <= 0 || !cap.perCluster[i]) return '';
                const u = cap.perCluster[i].utilization;
                const over = cap.perCluster[i].overWeight > 0;
                const color = over ? '#b91c1c' : (u > 90 ? '#d97706' : 'var(--ies-gray-400)');
                return ` <span style="font-size:11px;font-weight:700;color:${color};">${u.toFixed(0)}%${over ? ' OVER' : ''}</span>`;
              })()}</div>
            </div>
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Avg Weighted Dist</span>
              <div style="font-weight:600;">${calc.formatMiles(c.avgWeightedDistance)}</div>
            </div>
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Max Distance</span>
              <div style="font-weight:600;">${calc.formatMiles(c.maxDistance)}</div>
            </div>
            <div>
              <span style="color:var(--ies-gray-400);font-size:11px;text-transform:uppercase;">Annual Cost</span>
              <div style="font-weight:600;color:${clusterColor(i)};">${clusterCost != null ? calc.formatCurrency(clusterCost, { compact: true }) : '—'}</div>
              ${costShare != null ? `<div style="font-size:11px;color:var(--ies-gray-400);">${costShare.toFixed(0)}% of total</div>` : ''}
            </div>
          </div>
        </div>
      `;}).join('')}

      ${(cogResult.capacityStats && cogResult.capacityStats.capacityPerDC > 0 && cogResult.capacityStats.stillOver) ? `
        <div class="hub-card" style="margin-bottom:16px;padding:14px 18px;background:#fef2f2;border-left:4px solid #b91c1c;">
          <div style="font-size:13px;font-weight:700;color:#b91c1c;margin-bottom:4px;">Capacity overflow — solution not feasible</div>
          <div style="font-size:12px;color:#7f1d1d;line-height:1.5;">
            Every cluster hit the ${cogResult.capacityStats.capacityPerDC.toLocaleString()} cap and there's still
            <strong>${cogResult.capacityStats.totalOverflow.toLocaleString()}</strong> in overflow weight.
            The reassignment walk made ${cogResult.capacityStats.reassignmentCount} moves before stalling.
            Options: raise <strong>Centers (k)</strong>, increase <strong>Capacity / DC</strong>, or accept the overflow as a third-party / overflow-DC plug.
            Adjust in <a href="#" data-cog-jump="parameters" style="color:#b91c1c;text-decoration:underline;">Parameters</a>.
          </div>
        </div>
      ` : ''}
      ${(cogResult.serviceStats && cogResult.serviceStats.maxMiles > 0 && cogResult.serviceStats.outCount > 0) ? `
        <div class="hub-card" style="margin-bottom:16px;padding:14px 18px;background:#fef2f2;border-left:4px solid #b91c1c;">
          <div style="font-size:13px;font-weight:700;color:#b91c1c;margin-bottom:4px;">Service-level violations</div>
          <div style="font-size:12px;color:#7f1d1d;line-height:1.5;">
            <strong>${cogResult.serviceStats.outCount}</strong> of ${cogResult.serviceStats.outCount + cogResult.serviceStats.coveredCount} demand points
            (<strong>${(100 - cogResult.serviceStats.coveragePct).toFixed(1)}%</strong> of weight) exceed the
            <strong>${cogResult.serviceStats.maxMiles} road-mi</strong> SLA threshold.
            They're highlighted in red in the Assignment Table below.
            Options: add a DC to the candidate list near the violations, raise <strong>Centers (k)</strong>,
            or relax the threshold in <a href="#" data-cog-jump="parameters" style="color:#b91c1c;text-decoration:underline;">Parameters</a>.
          </div>
        </div>
      ` : ''}

      <!-- Assignment Table -->
      <div class="hub-card" style="padding:16px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px;">Point Assignments</div>
        <div style="max-height:300px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead style="position:sticky;top:0;background:#fff;">
              <tr style="border-bottom:2px solid var(--ies-gray-200);">
                <th style="text-align:center;padding:6px;">Cluster</th>
                <th style="text-align:left;padding:6px;">Point</th>
                <th style="text-align:right;padding:6px;">Weight</th>
                <th style="text-align:right;padding:6px;">Distance</th>
                <th style="text-align:right;padding:6px;">Transport Cost</th>
              </tr>
            </thead>
            <tbody>
              ${cogResult.assignments.map(a => {
                const pt = points.find(p => p.id === a.pointId);
                // 2026-05-28 30 — read engine source of truth via
                // cogResult.costByAssignment. Per-row was overstating
                // by ~5x when mode mix was on because the inline formula
                // ignored the parcel split. Now matches totalCost exactly.
                const cbaRow = Array.isArray(cogResult.costByAssignment)
                  ? cogResult.costByAssignment.find(x => x.pointId === a.pointId)
                  : null;
                const cost = cbaRow ? cbaRow.totalCost : 0;
                const outBadge = a.outOfService
                  ? `<span title="Road distance ${Math.round(a.driveRoadMi || 0)} mi > ${cogResult.serviceStats?.maxMiles || 0} mi SLA" style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:700;background:#fee2e2;color:#b91c1c;letter-spacing:0.4px;">OUT</span>`
                  : '';
                return `
                  <tr style="border-bottom:1px solid var(--ies-gray-200);${a.outOfService ? 'background:#fff5f5;' : ''}">
                    <td style="padding:6px;text-align:center;">
                      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${clusterColor(a.clusterId)};"></span>
                    </td>
                    <td style="padding:6px;font-weight:600;">${pt?.name || a.pointId}${outBadge}</td>
                    <td style="padding:6px;text-align:right;">${(pt?.weight || 0).toLocaleString()}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatMiles(a.distanceToCenter)}</td>
                    <td style="padding:6px;text-align:right;">${calc.formatCurrency(cost, { compact: true })}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Bind CSV export
  el.querySelector('#cog-export-csv')?.addEventListener('click', () => {
    exportCogAnalysis();
  });

  // Bind GeoJSON export (F1 — open in any GIS tool)
  el.querySelector('#cog-export-geojson')?.addEventListener('click', () => {
    exportCogGeoJSON();
  });

  // Bind NetOpt push
  el.querySelector('#cog-push-netopt')?.addEventListener('click', () => {
    pushToNetOpt();
  });

  // 2026-05-28 F4 — Print/PDF view.
  el.querySelector('#cog-print-pdf')?.addEventListener('click', () => {
    openPrintView();
  });

  // 2026-05-28 — wire the data-cog-jump links in the "How this cost was
  // calculated" panel. Previously the "Parameters" link emitted href="#"
  // with no handler, so clicks did nothing. Now they switch phase.
  el.querySelectorAll('[data-cog-jump]').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      const target = /** @type {HTMLElement} */ (link).dataset.cogJump;
      if (target !== 'inputs' && target !== 'parameters' && target !== 'run') return;
      activePhase = /** @type {any} */ (target);
      if (target === 'run' && !runSubTab) runSubTab = 'numbers';
      if (!rootEl) return;
      rootEl.innerHTML = renderShell();
      bindShellEvents();
      renderContent();
      _refreshCogKpis();
    });
  });
}

// ============================================================
// COMPARE TAB (F8 — 2026-05-28)
// ============================================================

/**
 * Extract a normalized metrics bag from a saved scenario row. Pulls
 * directly from saved result + config; falls back to '—' / null for
 * scenarios that pre-date the relevant commits. Handles both the active
 * scenario (passed as a fake row with scenario_data assembled inline)
 * and any saved row coming from api.listScenarios.
 */
function _cogMetricsFromSavedRow(row) {
  const d = row?.scenario_data || {};
  const cfg = d.config || {};
  const result = d.result || null;
  return {
    label: row?.name || cfg.customerName || 'Untitled',
    customer: cfg.customerName || '',
    industry: cfg.industry || '',
    dealStage: cfg.dealStage || '',
    nPoints: (d.points || []).length,
    nCenters: result?.centers?.length || 0,
    k: cfg.numCenters || cfg.k || 0,
    totalCost: typeof result?.totalCost === 'number' ? result.totalCost : null,
    co2Tons: typeof result?.co2Tons === 'number' ? result.co2Tons : null,
    coveragePct: typeof result?.serviceStats?.coveragePct === 'number' ? result.serviceStats.coveragePct : null,
    maxServiceMiles: cfg.maxServiceMiles || 0,
    peakUtil: typeof result?.capacityStats?.peakUtilization === 'number' ? result.capacityStats.peakUtilization : null,
    capacityPerDC: cfg.capacityPerDC || 0,
    avgDistance: result && typeof result.totalWeightedDistance === 'number' && (d.points || []).length > 0
      ? result.totalWeightedDistance / Math.max(1, d.points.reduce((s, p) => s + (p.weight || 0), 0))
      : null,
    transportCostPerMile: cfg.transportCostPerMile ?? null,
    roadFactor: cfg.roadFactor ?? null,
    roundTripFactor: cfg.roundTripFactor ?? null,
  };
}

function renderCompare(el) {
  // Lazy-load the saved-scenarios list on first view.
  if (_savedScenariosCache === null) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Loading saved scenarios…</p></div>';
    api.listScenarios().then(list => {
      _savedScenariosCache = Array.isArray(list) ? list : [];
      renderCompare(el);  // re-render with data
    }).catch(err => {
      console.error('[COG] listScenarios failed:', err);
      _savedScenariosCache = [];
      el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Failed to load saved scenarios.</p></div>';
    });
    return;
  }

  // Build the active-scenario metrics row from in-memory state.
  const activeRow = {
    id: activeScenarioId,
    name: _scenarioName || '(Current edit — not yet saved)',
    scenario_data: { points, config, result: cogResult },
  };
  const activeMetrics = _cogMetricsFromSavedRow(activeRow);

  // Picker options — all saved scenarios except the active one.
  const otherScenarios = _savedScenariosCache.filter(r => r.id !== activeScenarioId);

  // Resolve compared scenarios from IDs, dropping any that no longer exist.
  const compared = comparedScenarioIds
    .map(id => _savedScenariosCache.find(r => r.id === id))
    .filter(Boolean);
  const comparedMetrics = compared.map(_cogMetricsFromSavedRow);

  // Helper: render one column header.
  const colHeader = (m, ix) => {
    const ctxParts = [m.customer, m.industry, m.dealStage].filter(Boolean);
    return `<div style="font-weight:700;font-size:12px;line-height:1.35;">
        ${m.label}
        ${ctxParts.length ? `<div style="font-weight:500;font-size:10px;color:var(--ies-gray-400);margin-top:2px;">${ctxParts.join(' · ')}</div>` : ''}
      </div>`;
  };

  // Helper: render metric value or '—'.
  const valCell = (v, fmt) => v == null ? '<span style="color:var(--ies-gray-300);">—</span>' : fmt(v);
  const fmtCost = v => calc.formatCurrency(v, { compact: true });
  const fmtPct = v => v.toFixed(1) + '%';
  const fmtTons = v => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' t';
  const fmtMi = v => calc.formatMiles(v);
  const fmtNum = v => String(v);

  const cols = [activeMetrics, ...comparedMetrics];
  const gridCols = `2fr ${cols.map(() => '1fr').join(' ')}`;

  el.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <h3 class="text-section" style="margin:0;">Compare Scenarios</h3>
        <span style="font-size:12px;color:var(--ies-gray-400);">Active scenario vs up to 2 saved scenarios</span>
      </div>

      <div class="hub-card" style="padding:14px 16px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:var(--ies-gray-500);margin-bottom:8px;">Pick scenarios to compare</div>
        ${otherScenarios.length === 0 ? `
          <div style="font-size:12px;color:var(--ies-gray-400);font-style:italic;">No other saved scenarios yet — save more scenarios to compare them here.</div>
        ` : `
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            ${[0, 1].map(slot => `
              <label style="font-size:11px;font-weight:600;color:var(--ies-gray-500);">Slot ${slot + 1}:</label>
              <select data-compare-slot="${slot}" style="flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
                <option value="">— None —</option>
                ${otherScenarios.map(r => `<option value="${r.id}"${comparedScenarioIds[slot] === r.id ? ' selected' : ''}>${(r.name || 'Untitled').replace(/</g, '&lt;')}</option>`).join('')}
              </select>
            `).join('')}
            ${comparedScenarioIds.length > 0 ? `
              <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-compare-clear">Clear</button>
            ` : ''}
          </div>
        `}
      </div>

      ${comparedMetrics.length === 0 ? `
        <div class="hub-card" style="padding:14px 16px;">
          <p class="text-body text-muted" style="margin:0;font-size:12px;">Pick at least one scenario above to see a side-by-side comparison.</p>
        </div>
      ` : `
        <div class="hub-card" style="padding:16px 18px;">
          <div style="display:grid;grid-template-columns:${gridCols};gap:8px 18px;font-size:13px;align-items:baseline;">
            <div style="font-weight:700;color:var(--ies-gray-500);font-size:11px;text-transform:uppercase;">Metric</div>
            ${cols.map((m, i) => `<div style="text-align:right;">${colHeader(m, i)}</div>`).join('')}

            ${[
              ['Centers (k)',          (m) => valCell(m.nCenters || m.k, fmtNum)],
              ['Demand points',        (m) => valCell(m.nPoints, fmtNum)],
              ['Annual transport cost',(m) => valCell(m.totalCost, fmtCost)],
              ['Service coverage',     (m) => valCell(m.coveragePct, fmtPct)],
              ['Peak DC utilization',  (m) => valCell(m.peakUtil, fmtPct)],
              ['Annual CO₂',           (m) => valCell(m.co2Tons, fmtTons)],
              ['Avg weighted distance',(m) => valCell(m.avgDistance, fmtMi)],
              ['$/mi',                 (m) => valCell(m.transportCostPerMile, v => '$' + v.toFixed(2))],
              ['Road factor',          (m) => valCell(m.roadFactor, v => v.toFixed(2))],
              ['Round-trip',           (m) => valCell(m.roundTripFactor, v => v.toFixed(1))],
            ].map(([label, fn]) => `
              <div style="color:var(--ies-gray-600);">${label}</div>
              ${cols.map(m => `<div style="text-align:right;font-weight:600;">${fn(m)}</div>`).join('')}
            `).join('')}
          </div>
          <div style="font-size:11px;color:var(--ies-gray-400);margin-top:14px;line-height:1.5;border-top:1px dashed var(--ies-gray-200);padding-top:10px;">
            Values come from each scenario's saved result + config. Scenarios saved before today's commits may show '—' for newer metrics (CO₂, coverage, peak utilization) — re-Run those scenarios to populate.
          </div>
        </div>
      `}
    </div>
  `;

  // Wire picker selects.
  el.querySelectorAll('[data-compare-slot]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const slot = parseInt(/** @type {HTMLElement} */ (e.target).dataset.compareSlot, 10);
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      // Maintain comparedScenarioIds with slot stability:
      const next = [...comparedScenarioIds];
      next[slot] = v || undefined;
      comparedScenarioIds = next.filter(Boolean);
      renderCompare(el);
    });
  });
  el.querySelector('#cog-compare-clear')?.addEventListener('click', () => {
    comparedScenarioIds = [];
    renderCompare(el);
  });
}

// ============================================================
// MAP TAB
// ============================================================

function renderMap(el) {
  if (!cogResult) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Run analysis first to see the map.</p></div>';
    return;
  }
  // Guard against partial saved results — map-draw reads cogResult.assignments
  // to draw center↔point lines. If missing, we'd throw during initLeafletMap.
  const hasAssignments = Array.isArray(cogResult.assignments) && cogResult.assignments.length > 0;
  if (!hasAssignments) {
    el.innerHTML = `
      <div class="hub-card" style="max-width:900px;border-left:3px solid var(--ies-orange);">
        <h3 class="text-section" style="margin-top:0;">Map Preview Unavailable</h3>
        <p class="text-body">This scenario's saved result lacks per-point assignments, so the flow-line map can't be drawn. Click the <strong>Run</strong> button in the toolbar above to rebuild the full solve and see the map.</p>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
        <h3 class="text-section" style="margin:0;">Center of Gravity Map</h3>
        <span style="font-size:11px;color:var(--ies-gray-400);">${points.length} points • ${cogResult.centers.length} center(s)</span>
        <div style="margin-left:auto;display:flex;gap:10px;align-items:center;">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-cog-toggle="zones" ${mapOptions.zones ? 'checked' : ''} style="margin:0;"> Service zones
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;">
            <input type="checkbox" data-cog-toggle="heat" ${mapOptions.heat ? 'checked' : ''} style="margin:0;"> Heatmap
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;" title="Show 'C1 Memphis' tooltips above each centroid">
            <input type="checkbox" data-cog-toggle="labels" ${mapOptions.labels !== false ? 'checked' : ''} style="margin:0;"> Center labels
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;" title="Voronoi-style service territories — each cell is colored by the nearest center (haversine grid, ~60x40 cells)">
            <input type="checkbox" data-cog-toggle="territories" ${mapOptions.territories ? 'checked' : ''} style="margin:0;"> Territories
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;" title="Show demand-point names directly on the map (otherwise visible only on hover)">
            <input type="checkbox" data-cog-toggle="pointLabels" ${mapOptions.pointLabels ? 'checked' : ''} style="margin:0;"> Point labels
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ies-gray-600);" title="Switch basemap. Voyager = labeled streets (default). Positron = clean light. Satellite = imagery for site context.">
            Basemap:
            <select data-cog-toggle="basemap" style="padding:2px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:11px;">
              <option value="voyager" ${mapOptions.basemap === 'voyager' ? 'selected' : ''}>Voyager</option>
              <option value="positron" ${mapOptions.basemap === 'positron' ? 'selected' : ''}>Positron</option>
              <option value="satellite" ${mapOptions.basemap === 'satellite' ? 'selected' : ''}>Satellite</option>
            </select>
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ies-gray-600);">
            Radii:
            <input type="text" data-cog-toggle="radii" value="${mapOptions.zoneRadiiMiles.join(',')}"
                   style="width:100px;padding:2px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;font-size:11px;" title="Comma-separated service ring radii in miles">
          </label>
        </div>
      </div>
      <div id="cog-map-container" style="flex:1;min-height:500px;border-radius:10px;border:1px solid var(--ies-gray-200);overflow:hidden;"></div>
      <div style="display:flex;gap:16px;margin-top:12px;font-size:11px;color:var(--ies-gray-400);flex-wrap:wrap;">
        ${cogResult.centers.map((_, i) => `
          <span><span style="display:inline-block;width:14px;height:14px;background:${clusterColor(i)};border-radius:50%;vertical-align:middle;border:2px solid #fff;box-shadow:0 0 0 1px ${clusterColor(i)};"></span> Center ${i + 1}: ${(cogResult.centers[i].nearestCity || '').split('(')[0].trim()}</span>
        `).join('')}
        ${mapOptions.zones ? `<span style="opacity:0.8;">Rings: ${mapOptions.zoneRadiiMiles.join(' / ')} mi</span>` : ''}
        ${mapOptions.territories ? `<span style="opacity:0.8;">Territories: haversine-nearest grid</span>` : ''}
      </div>
    </div>
  `;

  // Wire toggles — only re-init the leaflet map (NOT the whole panel) so
  // the controls keep focus and we don't get into a render loop.
  el.querySelectorAll('[data-cog-toggle]').forEach(input => {
    input.addEventListener('change', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const key = target.dataset.cogToggle;
      if (key === 'radii') {
        const raw = /** @type {HTMLInputElement} */ (target).value;
        const parsed = raw.split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n) && n > 0);
        mapOptions.zoneRadiiMiles = parsed.length ? parsed : [250, 500, 750];
      } else if (key === 'basemap') {
        mapOptions.basemap = /** @type {HTMLSelectElement} */ (target).value || 'voyager';
      } else {
        mapOptions[key] = /** @type {HTMLInputElement} */ (target).checked;
      }
      initCogMap();
    });
  });

  // Init the map. The element has `flex:1` + `min-height:500px` on the
  // container so it's sized as soon as it's in the DOM — no need to
  // wait. If initCogMap does hit a zero-height snapshot on first paint
  // we fall back to a short retry.
  initCogMap();
  if (!mapInstance) {
    setTimeout(() => { if (!mapInstance) initCogMap(); }, 100);
  }
}

function _ensureCogStyleInjected() {
  if (document.getElementById('cog-style-inline')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'cog-style-inline';
  styleEl.textContent = `
.leaflet-tooltip.cog-center-label {
  background: rgba(255,255,255,0.95);
  border: 1px solid #0a1628;
  border-radius: 6px;
  padding: 3px 7px;
  font-size: 11px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.18);
  white-space: nowrap;
}
.leaflet-tooltip.cog-center-label::before { display: none; }
.leaflet-tooltip.cog-pt-label {
  background: rgba(255,255,255,0.85);
  border: none;
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 10px;
  color: #0a1628;
  font-weight: 600;
  box-shadow: none;
  white-space: nowrap;
}
.leaflet-tooltip.cog-pt-label::before { display: none; }
  `;
  document.head.appendChild(styleEl);
}

function initCogMap() {
  _ensureCogStyleInjected();
  const container = rootEl?.querySelector('#cog-map-container');
  if (!container || !cogResult) return;
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }

  if (typeof L === 'undefined') {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--ies-gray-400);">Map requires Leaflet.js</div>';
    return;
  }

  // 2026-05-28 D12 — compute bbox before map init so we don't get the
  // zoom-4 continental-US flash before fitBounds kicks in.
  const _allPtsForInit = [
    ...points.filter(p => p.lat != null && p.lng != null).map(p => [p.lat, p.lng]),
    ...cogResult.centers.map(c => [c.lat, c.lng]),
  ];
  if (_allPtsForInit.length > 0) {
    const initBounds = L.latLngBounds(_allPtsForInit);
    mapInstance = L.map(container, { zoomSnap: 0.25 }).fitBounds(initBounds, { padding: [30, 30], animate: false });
  } else {
    mapInstance = L.map(container).setView([39.8283, -98.5795], 4);
  }
  // E1 fix (2026-04-25 EVE): CartoDB Voyager replaces OSM raw tiles. Voyager
  // has stronger state-boundary contrast and clearer city labels at zoom 4-6
  // (the typical CoG-result zoom band) which makes the result legible during
  // customer presentations. Falls back to OSM if cartocdn fails to load.
  // 2026-05-28 D7 — basemap select. CARTO Voyager (default), Positron
  // (clean light), or Esri WorldImagery (satellite). Falls back to
  // Voyager when an unknown value is in state.
  const BASEMAPS = {
    voyager: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      attr: '&copy; <a href="https://carto.com/attributions">CARTO</a> · OpenStreetMap',
      sub: 'abcd',
    },
    positron: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attr: '&copy; <a href="https://carto.com/attributions">CARTO</a> · OpenStreetMap',
      sub: 'abcd',
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attr: '&copy; Esri · Maxar · Earthstar Geographics',
      sub: '',
    },
  };
  const bmKey = BASEMAPS[mapOptions.basemap] ? mapOptions.basemap : 'voyager';
  const bm = BASEMAPS[bmKey];
  L.tileLayer(bm.url, { maxZoom: 19, subdomains: bm.sub, attribution: bm.attr }).addTo(mapInstance);

  // 2026-05-28 D10 — scale bar. Standard cartographic element. Imperial
  // first (US default) with metric secondary. Bottom-left.
  L.control.scale({ imperial: true, metric: true, maxWidth: 180, position: 'bottomleft' }).addTo(mapInstance);

  // 2026-05-28 D11 — north arrow / compass. Bottom-right, away from the
  // scale bar. Pure SVG so we don't pull a new dep. Static (north is up on
  // a Web Mercator basemap at any non-rotated zoom — Leaflet doesn't
  // rotate, so a fixed glyph is correct).
  const NorthArrow = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'cog-north-arrow');
      div.style.cssText = 'background:rgba(255,255,255,0.92);border:1px solid #475569;border-radius:6px;padding:4px 6px;box-shadow:0 1px 4px rgba(0,0,0,0.15);';
      div.innerHTML = '<svg width="28" height="32" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg" aria-label="North">'
        + '<polygon points="14,2 22,22 14,18 6,22" fill="#ef4444" stroke="#0a1628" stroke-width="1"/>'
        + '<text x="14" y="30" text-anchor="middle" font-size="10" font-weight="700" fill="#0a1628">N</text>'
        + '</svg>';
      return div;
    }
  });
  new NorthArrow().addTo(mapInstance);

  // 2026-05-28 D2 — Voronoi-style service territories. Renders a
  // 60x40 grid of small translucent rectangles, each colored by its
  // nearest center (haversine). Toggle via data-cog-toggle="territories".
  // Drawn UNDER heatmap + zones + markers so the layering reads correctly.
  if (mapOptions.territories && cogResult.centers.length > 0) {
    const allPts = [...points.filter(p => p.lat != null).map(p => [p.lat, p.lng]),
                    ...cogResult.centers.map(c => [c.lat, c.lng])];
    if (allPts.length > 0) {
      const lats = allPts.map(p => p[0]);
      const lngs = allPts.map(p => p[1]);
      const padLat = Math.max(0.5, (Math.max(...lats) - Math.min(...lats)) * 0.08);
      const padLng = Math.max(0.5, (Math.max(...lngs) - Math.min(...lngs)) * 0.08);
      const minLat = Math.min(...lats) - padLat;
      const maxLat = Math.max(...lats) + padLat;
      const minLng = Math.min(...lngs) - padLng;
      const maxLng = Math.max(...lngs) + padLng;
      const NLAT = 40, NLNG = 60;
      const dLat = (maxLat - minLat) / NLAT;
      const dLng = (maxLng - minLng) / NLNG;
      for (let i = 0; i < NLAT; i++) {
        for (let j = 0; j < NLNG; j++) {
          const cLat = minLat + (i + 0.5) * dLat;
          const cLng = minLng + (j + 0.5) * dLng;
          // Find nearest center by haversine.
          let bestK = 0;
          let bestD = Infinity;
          for (let k = 0; k < cogResult.centers.length; k++) {
            const cc = cogResult.centers[k];
            const d = calc.haversine(cLat, cLng, cc.lat, cc.lng);
            if (d < bestD) { bestD = d; bestK = k; }
          }
          const color = clusterColor(bestK);
          L.rectangle(
            [[minLat + i * dLat, minLng + j * dLng], [minLat + (i + 1) * dLat, minLng + (j + 1) * dLng]],
            { color: color, weight: 0, fillColor: color, fillOpacity: 0.10, interactive: false }
          ).addTo(mapInstance);
        }
      }
    }
  }

  // Heatmap layer (drawn first so it sits under markers).
  // We weight each demand point and overlay a soft halo whose radius
  // scales with weight relative to the max in the dataset.
  if (mapOptions.heat) {
    const maxWeight = Math.max(1, ...points.map(p => p.weight || 0));
    points.forEach(pt => {
      const w = pt.weight || 0;
      if (w <= 0) return;
      const norm = w / maxWeight;
      // Halo radius in metres: 80km at max weight, 12km at min meaningful weight
      const haloMetres = 12000 + norm * 68000;
      L.circle([pt.lat, pt.lng], {
        radius: haloMetres,
        color: '#ff5630',
        weight: 0,
        fillColor: '#ff5630',
        fillOpacity: 0.10 + norm * 0.20,    // 0.10 → 0.30
        interactive: false,
      }).addTo(mapInstance);
    });
  }

  // Service zones — translucent rings around each center at the
  // configured radii. Sits under the cluster lines so they read clearly.
  if (mapOptions.zones && Array.isArray(mapOptions.zoneRadiiMiles)) {
    cogResult.centers.forEach((c, i) => {
      const color = clusterColor(i);
      mapOptions.zoneRadiiMiles.forEach((mi, ringIdx) => {
        L.circle([c.lat, c.lng], {
          radius: mi * 1609.34,                           // miles → metres
          color,
          weight: 1,
          opacity: 0.5,
          fillColor: color,
          fillOpacity: 0.04 + (mapOptions.zoneRadiiMiles.length - ringIdx) * 0.02,
          dashArray: ringIdx > 0 ? '4 4' : null,
          interactive: false,
        }).addTo(mapInstance);
      });
    });
  }

  // Demand points colored by cluster
  cogResult.assignments.forEach(a => {
    const pt = points.find(p => p.id === a.pointId);
    if (!pt) return;
    const color = clusterColor(a.clusterId);
    const size = Math.max(4, Math.min(10, pt.weight / 10000));
    // 2026-05-28 B7 — out-of-service points get a red ring outline so
    // they pop against the cluster color.
    const ringColor = a.outOfService ? '#b91c1c' : color;
    const ringWeight = a.outOfService ? 3 : 1;
    const marker = L.circleMarker([pt.lat, pt.lng], {
      radius: size, fillColor: color, color: ringColor, weight: ringWeight, fillOpacity: 0.7,
    }).addTo(mapInstance);
    const outNote = a.outOfService ? `<br><strong style="color:#b91c1c;">OUT of SLA</strong> (${Math.round(a.driveRoadMi || 0)} road-mi > ${cogResult.serviceStats?.maxMiles || 0} mi)` : '';
    marker.bindPopup(`<strong>${pt.name || pt.id}</strong><br>Weight: ${pt.weight.toLocaleString()}<br>Cluster: ${a.clusterId + 1}<br>Distance: ${calc.formatMiles(a.distanceToCenter)}${outNote}`);
    // 2026-05-28 D14 — permanent labels above each demand point when toggled.
    if (mapOptions.pointLabels) {
      marker.bindTooltip(pt.name || pt.id, { permanent: true, direction: 'top', offset: [0, -4], className: 'cog-pt-label', opacity: 0.85 });
    }

    // Line to center
    const center = cogResult.centers[a.clusterId];
    if (center) {
      L.polyline([[pt.lat, pt.lng], [center.lat, center.lng]], {
        color, weight: 1, opacity: 0.3,
      }).addTo(mapInstance);
    }
  });

  // Center markers (star-like — larger with border) + permanent label
  // E3/E4 — labels read at print resolution and on screenshot exports.
  // 2026-05-28 D6 — center markers now use the cluster color (matches
  // the assignment-line + demand-point coloring) instead of all-red.
  cogResult.centers.forEach((c, i) => {
    const centerColor = clusterColor(i);
    const marker = L.circleMarker([c.lat, c.lng], {
      radius: 14, fillColor: centerColor, color: '#fff', weight: 3, fillOpacity: 0.95,
    }).addTo(mapInstance);
    marker.bindPopup(`<strong>Center ${i + 1}</strong><br>${c.nearestCity}<br>Location: ${calc.formatLatLng(c.lat, c.lng)}<br>Avg Distance: ${calc.formatMiles(c.avgWeightedDistance)}`);
    if (mapOptions.labels !== false) {
      marker.bindTooltip(
        `<span style="font-weight:700;color:#0a1628;">C${i + 1}</span> <span style="color:#475569;">${c.nearestCity}</span>`,
        { permanent: true, direction: 'top', offset: [0, -10], className: 'cog-center-label', opacity: 0.95 }
      );
    }
  });

  // Fit bounds
  const allPts = [...points.map(p => [p.lat, p.lng]), ...cogResult.centers.map(c => [c.lat, c.lng])];
  if (allPts.length > 0) mapInstance.fitBounds(allPts, { padding: [30, 30] });

  // 2026-05-28 D13 — window resize listener. Map was previously stuck
  // at initial dimensions after a window resize. invalidateSize tells
  // Leaflet to re-measure its container and re-render tiles.
  if (!_mapResizeListenerBound) {
    _mapResizeListenerBound = true;
    let _resizeTimer = null;
    window.addEventListener('resize', () => {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        if (mapInstance) {
          try { mapInstance.invalidateSize(true); } catch (_) { /* swallow */ }
        }
      }, 150);
    });
  }
}

// ============================================================
// SENSITIVITY TAB
// ============================================================

function renderSensitivity(el) {
  if (!sensitivityData) {
    el.innerHTML = '<div class="hub-card"><p class="text-body text-muted">Run analysis first to see sensitivity data.</p></div>';
    return;
  }

  const hasFixedCost = (config.fixedCostPerDC || 0) > 0;
  const maxCost = Math.max(...sensitivityData.map(d => d.totalCost));
  const minCost = Math.min(...sensitivityData.map(d => d.totalCost));
  const costRange = maxCost - minCost;
  // In U-curve mode the minimum is the cost-optimal k (whichever bar is shortest).
  const minIdx = sensitivityData.findIndex(d => d.totalCost === minCost);
  const optimalK = sensitivityData[minIdx]?.k ?? sensitivityData[sensitivityData.length - 1].k;
  // Whether the cost-optimal k is at an interior bar (true U-shape) or at a
  // boundary (k=1 because fixed cost dominates, or k=max because fixed cost
  // is too low to ever offset the next DC). Drives whether the ★ marker
  // shows on the chart and what copy the legend / disclosure uses.
  const hasInteriorMin = hasFixedCost && minIdx > 0 && minIdx < sensitivityData.length - 1;

  // Network summary
  const optimal = sensitivityData[sensitivityData.length - 1];
  const baseline = sensitivityData[0];
  const savings = baseline.estimatedCost - optimal.estimatedCost;
  const savingsPct = baseline.estimatedCost > 0 ? (savings / baseline.estimatedCost * 100).toFixed(1) : 0;

  // 2026-05-28 B15 — Cost-driver tornado. Quick multi-variable
  // sensitivity at the current k, using estimateTransportCost so the
  // numbers stay consistent with everything else on the tab.
  const tornado = calc.tornadoSensitivity(cogResult, points, config);

  el.innerHTML = `
    <div>
      <h3 class="text-section" style="margin-bottom:16px;">Sensitivity Analysis</h3>

      ${tornado.length > 0 ? (() => {
        const baselineCost = tornado[0]?.baselineCost || 0;
        // Chart span: min/max across all driver low/high, with the
        // baseline always visible (handles asymmetric swings).
        const lows = tornado.map(t => t.lowCost);
        const highs = tornado.map(t => t.highCost);
        const xMin = Math.min(baselineCost, ...lows);
        const xMax = Math.max(baselineCost, ...highs);
        const xRange = Math.max(1, xMax - xMin);
        const padPct = 0.08;
        const xPlotMin = xMin - xRange * padPct;
        const xPlotMax = xMax + xRange * padPct;
        const xPlotRange = xPlotMax - xPlotMin;
        const W = 720, H = Math.max(180, 40 + tornado.length * 38);
        const labelW = 160;
        const chartW = W - labelW - 20;
        const xScale = (v) => labelW + ((v - xPlotMin) / xPlotRange) * chartW;
        const baselineX = xScale(baselineCost);
        const fmtCost = (v) => calc.formatCurrency(v, { compact: true });

        return `
        <div class="hub-card" style="padding:18px 20px;margin-bottom:20px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Cost-driver tornado (current k = ${cogResult.centers.length})</div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:14px;">
            Each bar sweeps one driver to its low/high band while holding others at baseline. Bars sorted by absolute cost swing. Vertical dashed line = baseline total cost (${fmtCost(baselineCost)}).
          </div>
          <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="overflow:visible;">
            <!-- Baseline vertical line -->
            <line x1="${baselineX}" y1="20" x2="${baselineX}" y2="${H - 30}" stroke="#475569" stroke-dasharray="4 3" stroke-width="1.5"/>
            <text x="${baselineX}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#475569" font-weight="600">${fmtCost(baselineCost)}</text>

            <!-- Bars -->
            ${tornado.map((t, i) => {
              const y = 30 + i * 38;
              const xLow = xScale(t.lowCost);
              const xHigh = xScale(t.highCost);
              const left = Math.min(xLow, xHigh);
              const w = Math.max(2, Math.abs(xHigh - xLow));
              const fmtVal = (v) => {
                if (t.key === 'transportCostPerMile') return '$' + v.toFixed(2);
                if (t.key === 'roundTripFactor') return v.toFixed(2) + 'x';
                if (t.key === 'roadFactor') return v.toFixed(2);
                if (t.key === 'demandTotal') return v.toFixed(0) + '%';
                return String(v.toFixed(2));
              };
              return `
                <text x="${labelW - 10}" y="${y + 13}" text-anchor="end" font-size="12" fill="var(--ies-gray-700)" font-weight="600">${t.label}</text>
                <text x="${labelW - 10}" y="${y + 26}" text-anchor="end" font-size="10" fill="var(--ies-gray-400)">±${t.deltaPct}%</text>
                <rect x="${left}" y="${y}" width="${w}" height="20" fill="${t.lowCost < t.highCost ? '#3b82f6' : '#f97316'}" rx="3" opacity="0.85"/>
                <text x="${xLow}" y="${y + 13}" text-anchor="${xLow < baselineX ? 'end' : 'start'}" font-size="10" fill="var(--ies-gray-700)" font-weight="600" dx="${xLow < baselineX ? -4 : 4}">${fmtCost(t.lowCost)}</text>
                <text x="${xHigh}" y="${y + 13}" text-anchor="${xHigh > baselineX ? 'start' : 'end'}" font-size="10" fill="var(--ies-gray-700)" font-weight="600" dx="${xHigh > baselineX ? 4 : -4}">${fmtCost(t.highCost)}</text>
                <text x="${(xLow + xHigh) / 2}" y="${y + 33}" text-anchor="middle" font-size="9" fill="var(--ies-gray-400)">${fmtVal(t.lowVal)} → ${fmtVal(t.highVal)}</text>
              `;
            }).join('')}
          </svg>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:10px;line-height:1.5;border-top:1px dashed var(--ies-gray-200);padding-top:8px;">
            <strong>Reading this:</strong> Drivers near the top swing cost the most — focus contract-negotiation effort there. Drivers near the bottom are largely fixed — don't overthink them. Bars colored blue when low &lt; high (cost rises with the driver), orange when reversed.
          </div>
        </div>
      `;
      })() : ''}

      <h4 style="font-size:14px;font-weight:700;margin-bottom:12px;color:var(--ies-gray-700);">Cost vs. Number of Centers</h4>

      <!-- Network Summary -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;background:linear-gradient(135deg,#f0fdf4,#f0fdf4);border-left:4px solid #22c55e;">
        <div style="font-size:13px;font-weight:700;color:#15803d;margin-bottom:8px;">Optimal Network Summary</div>
        <div style="font-size:13px;line-height:1.6;color:#166534;">
          Optimal network of <strong>${cogResult.centers.length}</strong> facilit${cogResult.centers.length === 1 ? 'y' : 'ies'} reduces
          avg distance to <strong>${cogResult.centers[0] ? calc.formatMiles(cogResult.centers.reduce((s, c) => s + c.avgWeightedDistance, 0) / cogResult.centers.length) : 'N/A'}</strong>
          per facility, with total annual transport cost of <strong>${calc.formatCurrency(cogResult.totalCost ?? 0)}</strong>.
          Compared to single facility: <strong>${savingsPct}%</strong> savings.
        </div>
      </div>

      <!-- Cost Curve Chart (SVG) -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Cost Curve: Number of Centers vs. Annual Transport Cost</div>
        <svg width="100%" height="280" style="background:var(--ies-gray-50);border-radius:8px;">
          <!-- Grid lines -->
          ${sensitivityData.map((_, i) => {
            const chartW = Math.max(sensitivityData.length * 60, 300);
            const x = 60 + (i / (sensitivityData.length - 1)) * chartW;
            return `<line x1="${x}" y1="30" x2="${x}" y2="240" stroke="var(--ies-gray-200)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
          }).join('')}
          <line x1="50" y1="240" x2="${50 + Math.max(sensitivityData.length * 60, 300)}" y2="240" stroke="var(--ies-gray-400)" stroke-width="2"/>
          <line x1="50" y1="30" x2="50" y2="240" stroke="var(--ies-gray-400)" stroke-width="2"/>

          <!-- Bars: stacked Transport (blue) + Facility (orange) when fixed cost > 0;
               single-color bars in transport-only mode. Bar height ∝ (totalCost - minCost),
               so on a U-curve the lowest bar = the optimum and the kneedle ★ lands on it. -->
          ${sensitivityData.map((d, i) => {
            const chartW = Math.max(sensitivityData.length * 60, 300);
            const barW = Math.max(40, chartW / sensitivityData.length - 12);
            const x = 50 + (i + 0.5) / sensitivityData.length * chartW;
            const totalH = costRange > 0 ? ((d.totalCost - minCost) / costRange) * 190 : 10;
            const transportH = d.totalCost > 0 ? totalH * (d.transportCost / d.totalCost) : totalH;
            const facilityH = totalH - transportH;
            const yTotal = 240 - totalH;
            const yTransport = 240 - transportH; // transport sits at the bottom
            const isCurrent = d.k === config.numCenters;
            const isElbow = d.isElbow === true;
            const stroke = isElbow ? 'stroke="#ea580c" stroke-width="2"' : '';
            if (hasFixedCost) {
              const transportColor = isCurrent ? '#1d4ed8' : '#3b82f6';
              const facilityColor = isCurrent ? '#c2410c' : '#fb923c';
              return `
                <rect x="${x - barW/2}" y="${yTransport}" width="${barW}" height="${transportH}" fill="${transportColor}" rx="0"/>
                <rect x="${x - barW/2}" y="${yTotal}" width="${barW}" height="${facilityH}" fill="${facilityColor}" rx="4" ${stroke}/>
                ${isElbow ? `<text x="${x}" y="${yTotal - 8}" text-anchor="middle" font-size="14" fill="#16a34a" font-weight="700">★</text>` : ''}
                <text x="${x}" y="260" text-anchor="middle" font-size="12" font-weight="700" fill="var(--ies-gray-600)">k=${d.k}</text>
              `;
            } else {
              const color = isElbow ? '#f97316' : isCurrent ? '#2563eb' : '#93c5fd';
              return `
                <rect x="${x - barW/2}" y="${yTotal}" width="${barW}" height="${totalH}" fill="${color}" rx="4" ${stroke}/>
                ${isElbow ? `<text x="${x}" y="${yTotal - 8}" text-anchor="middle" font-size="14" fill="#f97316">★</text>` : ''}
                <text x="${x}" y="260" text-anchor="middle" font-size="12" font-weight="700" fill="var(--ies-gray-600)">k=${d.k}</text>
              `;
            }
          }).join('')}

          <!-- Y-axis labels -->
          <text x="40" y="250" text-anchor="end" font-size="11" fill="var(--ies-gray-400)">$0</text>
          <text x="40" y="135" text-anchor="end" font-size="11" fill="var(--ies-gray-400)">${calc.formatCurrency(minCost + costRange/2, { compact: true })}</text>
          <text x="40" y="35" text-anchor="end" font-size="11" fill="var(--ies-gray-400)">${calc.formatCurrency(maxCost, { compact: true })}</text>
        </svg>
        <div style="font-size:11px;color:var(--ies-gray-400);margin-top:8px;">
          ${hasFixedCost ? `
            <span style="margin-right:16px;"><strong style="color:#1d4ed8;">Blue</strong> = transport cost</span>
            <span style="margin-right:16px;"><strong style="color:#fb923c;">Orange</strong> = facility fixed cost (${calc.formatCurrency(config.fixedCostPerDC, { compact: true })}/yr × k)</span>
            ${hasInteriorMin
              ? `<span><strong style="color:#16a34a;">★</strong> = cost-optimal k = ${optimalK} (interior minimum of the U-curve)</span>`
              : `<span><strong style="color:var(--ies-gray-600);">Cost-optimal k = ${optimalK}</strong> — boundary minimum (no interior U-shape at this fixed cost)</span>`}
          ` : `
            <span style="margin-right:16px;"><strong style="color:var(--ies-gray-600);">Blue bar</strong> = current selection (k=${config.numCenters})</span>
            <span><strong style="color:#f97316;">Orange bar ★</strong> = knee point (max curvature on cost curve)</span>
          `}
        </div>
      </div>

      <!-- Cost breakdown -->
      <div class="hub-card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Estimated Annual Transport Cost by Number of Centers</div>
        ${sensitivityData.map((d, i) => {
          const pct = maxCost > 0 ? (d.estimatedCost / maxCost) * 100 : 0;
          const isCurrent = d.k === config.numCenters;
          return `
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:${isCurrent ? '700' : '600'};">
                  k = ${d.k} ${isCurrent ? ' ← current' : ''}
                </span>
                <span style="font-size:13px;font-weight:700;">${calc.formatCurrency(d.estimatedCost, { compact: true })}</span>
              </div>
              <div style="height:24px;border-radius:6px;background:var(--ies-gray-200);overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${isCurrent ? 'var(--ies-blue)' : 'var(--ies-gray-400)'};border-radius:6px;"></div>
              </div>
              <div style="font-size:11px;color:var(--ies-gray-400);margin-top:2px;">
                Avg distance: ${calc.formatMiles(d.avgDistance)}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="hub-card" style="padding:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="text-align:center;padding:8px;font-weight:700;">k</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Total Weighted Distance</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Est. Annual Cost</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Avg Distance</th>
              <th style="text-align:right;padding:8px;font-weight:700;">Marginal Savings</th>
            </tr>
          </thead>
          <tbody>
            ${sensitivityData.map((d, i) => {
              const prev = i > 0 ? sensitivityData[i - 1].estimatedCost : d.estimatedCost;
              const savings = prev - d.estimatedCost;
              return `
                <tr style="border-bottom:1px solid var(--ies-gray-200);${d.k === config.numCenters ? 'background:#f0f9ff;' : ''}">
                  <td style="padding:8px;text-align:center;font-weight:700;">${d.k}</td>
                  <td style="padding:8px;text-align:right;">${Math.round(d.totalWeightedDistance).toLocaleString()}</td>
                  <td style="padding:8px;text-align:right;font-weight:600;">${calc.formatCurrency(d.estimatedCost, { compact: true })}</td>
                  <td style="padding:8px;text-align:right;">${calc.formatMiles(d.avgDistance)}</td>
                  <td style="padding:8px;text-align:right;color:${savings > 0 ? '#22c55e' : '#6b7280'};">${i > 0 ? calc.formatCurrency(savings, { compact: true }) : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      ${hasFixedCost ? `
        <div class="hub-card" style="margin-top:16px;background:${hasInteriorMin ? '#f0fdf4' : '#fffbeb'};border-color:${hasInteriorMin ? '#22c55e' : '#f59e0b'};">
          <div style="font-size:13px;font-weight:600;color:${hasInteriorMin ? '#15803d' : '#92400e'};margin-bottom:6px;">How to read this curve — ${hasInteriorMin ? 'true U-curve mode' : 'fixed-cost dominates'}</div>
          <div style="font-size:13px;color:${hasInteriorMin ? '#166534' : '#78350f'};line-height:1.6;">
            Each bar is a <strong>stack</strong>: blue = outbound transport cost, orange = facility fixed cost (k × ${calc.formatCurrency(config.fixedCostPerDC, { compact: true })}/yr). Stack height = total annual cost.
            <br/><br/>
            ${hasInteriorMin
              ? `The green <strong>★</strong> marks the cost-optimal k = <strong>${optimalK}</strong> — the bar with the lowest total. Adding more DCs past k=${optimalK} costs more in fixed overhead than it saves in transport; using fewer DCs costs more in transport than it saves in fixed cost.`
              : `The total-cost minimum sits at <strong>k = ${optimalK}</strong> (boundary). At this fixed-cost level, every additional DC adds more fixed overhead than it removes in transport savings — so the optimum is to consolidate. Lower the <strong>Fixed $ / DC / yr</strong> input to surface an interior U-curve optimum.`}
            <br/><br/>
            Tweak the <strong>Fixed $ / DC / yr</strong> input on the Demand Points tab to test sensitivity. Higher fixed cost → optimum shifts left (fewer DCs); lower fixed cost → optimum shifts right (more DCs).
          </div>
        </div>
      ` : `
        <div class="hub-card" style="margin-top:16px;background:#fffbeb;border-color:#f59e0b;">
          <div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:6px;">How to read this curve</div>
          <div style="font-size:13px;color:#78350f;line-height:1.6;">
            This chart plots <strong>outbound transport cost only</strong> — facility fixed cost (rent, labor, IT, depreciation) is <strong>not</strong> modeled here. Because there is no fixed-cost term, the curve is monotonically non-increasing in k: more centers can only reduce or hold transport cost, never raise it.
            <br/><br/>
            The orange ★ marks the <strong>knee</strong> &mdash; the point of maximum curvature on the normalized cost curve, computed via the kneedle algorithm (Satopaa et al. 2011). It is the natural "diminishing returns" inflection, <em>not</em> a true total-cost minimum.
            <br/><br/>
            <strong>Tip:</strong> Set <strong>Fixed $ / DC / yr</strong> on the Demand Points tab (e.g. $1,500,000) to switch this chart into a true U-curve and let the kneedle find the cost-optimal k for you.
          </div>
        </div>
      `}
    </div>
  `;
}

// ============================================================
// EXPORT / INTEGRATION
// ============================================================

/**
 * Export current analysis to CSV.
 * Three sections: Summary (6 KPIs), Optimal Centers, Demand Points & Assignments.
 * F1 (P0) — CSV Export
 */
function exportCogAnalysis() {
  if (!cogResult) {
    showToast('No analysis results to export', 'warning');
    return;
  }

  // 2026-05-28 30 — use engine source of truth.
  const costEst = {
    totalCost: cogResult.totalCost ?? 0,
    avgCostPerUnit: cogResult.avgCostPerUnit ?? 0,
    totalTruckloads: cogResult.totalTruckloads ?? 0,
    totalTruckMiles: cogResult.totalTruckMiles ?? 0,
  };
  const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `cog-analysis-${now}.csv`;

  // Build CSV sections
  const sections = [];

  // Section 1: Summary KPIs
  sections.push('SUMMARY');
  sections.push('Metric,Value');
  sections.push(`Number of Centers,${cogResult.centers.length}`);
  sections.push(`Total Demand Weight,"${points.reduce((s, p) => s + p.weight, 0).toLocaleString()}"`);
  sections.push(`Estimated Annual Transport Cost,"${calc.formatCurrency(costEst.totalCost).replace(/[$,]/g, '')}"`);
  sections.push(`Average Cost per Unit,"${calc.formatCurrency(costEst.avgCostPerUnit).replace(/[$,]/g, '')}"`);
  sections.push(`K-means Iterations,${cogResult.iterations}`);
  sections.push(`Transport Cost per Mile,$${config.transportCostPerMile}`);
  sections.push('');

  // Section 2: Optimal Centers
  sections.push('OPTIMAL CENTERS');
  sections.push('Center,Latitude,Longitude,Nearest City,Assigned Weight,Avg Weighted Distance (mi),Max Distance (mi)');
  cogResult.centers.forEach((c, i) => {
    sections.push(`Center ${i + 1},"${c.lat.toFixed(4)}","${c.lng.toFixed(4)}","${c.nearestCity}","${c.totalWeight.toLocaleString()}","${c.avgWeightedDistance.toFixed(2)}","${c.maxDistance.toFixed(2)}"`);
  });
  sections.push('');

  // Section 3: Demand Points & Assignments
  sections.push('DEMAND POINTS & ASSIGNMENTS');
  sections.push('Name,Latitude,Longitude,Weight,Assigned To Center,Distance to Center (mi),Transport Cost');
  cogResult.assignments.forEach(a => {
    const pt = points.find(p => p.id === a.pointId);
    // 2026-05-28 30 — read from engine source of truth.
    const cbaRow = Array.isArray(cogResult.costByAssignment)
      ? cogResult.costByAssignment.find(x => x.pointId === a.pointId)
      : null;
    const cost = cbaRow ? cbaRow.totalCost : 0;
    if (pt) {
      sections.push(`"${pt.name || pt.id}","${pt.lat.toFixed(4)}","${pt.lng.toFixed(4)}","${pt.weight}","Center ${a.clusterId + 1}","${a.distanceToCenter.toFixed(2)}","${cost.toFixed(2)}"`);
    }
  });

  const csvContent = sections.join('\n');
  downloadCSV(csvContent, filename);
  showToast('Analysis exported successfully', 'success');
}

/**
 * Export current analysis to GeoJSON FeatureCollection.
 * Includes optimal centers as Point features, demand points as Point features
 * with cluster + cost metadata, and center↔demand lines as LineString features.
 * F1 — opens directly in QGIS, kepler.gl, Mapbox, ArcGIS, etc.
 */
function exportCogGeoJSON() {
  if (!cogResult) {
    showToast('No analysis results to export', 'warning');
    return;
  }

  const capacity = Math.max(1, config.unitsPerTruck || 25000);
  const features = [];

  // Centers (red star points)
  cogResult.centers.forEach((c, i) => {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: {
        kind: 'center',
        cluster_id: i,
        label: `Center ${i + 1}`,
        nearest_city: c.nearestCity,
        assigned_weight: c.totalWeight,
        avg_weighted_distance_mi: Number(c.avgWeightedDistance.toFixed(2)),
        max_distance_mi: Number(c.maxDistance.toFixed(2)),
      },
    });
  });

  // Demand points + center↔point lines
  // 2026-05-28 — pull rt + road factors so per-row annual_transport_cost
  // matches the on-screen Analysis-tab totals. (Same fix as CSV export.)
  const rt = Math.max(1, +config.roundTripFactor || 2.0);
  const road = Math.max(1, +config.roadFactor || 1.22);
  cogResult.assignments.forEach(a => {
    const pt = points.find(p => p.id === a.pointId);
    if (!pt) return;
    const truckloads = (pt.weight || 0) / capacity;
    // 2026-05-28 30 — engine source of truth.
    const cbaRow = Array.isArray(cogResult.costByAssignment)
      ? cogResult.costByAssignment.find(x => x.pointId === a.pointId)
      : null;
    const cost = cbaRow ? cbaRow.totalCost : (a.distanceToCenter * road * truckloads * config.transportCostPerMile * rt);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] },
      properties: {
        kind: 'demand_point',
        name: pt.name || pt.id,
        cluster_id: a.clusterId,
        weight: pt.weight,
        distance_to_center_mi: Number(a.distanceToCenter.toFixed(2)),
        annual_transport_cost: Number(cost.toFixed(2)),
      },
    });
    const center = cogResult.centers[a.clusterId];
    if (center) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[pt.lng, pt.lat], [center.lng, center.lat]],
        },
        properties: {
          kind: 'assignment_line',
          cluster_id: a.clusterId,
          point_name: pt.name || pt.id,
          distance_mi: Number(a.distanceToCenter.toFixed(2)),
        },
      });
    }
  });

  const fc = {
    type: 'FeatureCollection',
    properties: {
      generated: new Date().toISOString(),
      n_centers: cogResult.centers.length,
      n_demand_points: points.length,
      transport_cost_per_mile: config.transportCostPerMile,
      units_per_truck: capacity,
    },
    features,
  };

  const now = new Date().toISOString().split('T')[0];
  const filename = `cog-analysis-${now}.geojson`;
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  showToast('GeoJSON exported successfully', 'success');
}

/**
 * 2026-05-28 F4 — Open a print-friendly snapshot of the current Analysis
 * in a new tab. User uses their browser's native Print > Save as PDF to
 * generate a shareable PDF without any external library.
 *
 * The print HTML is self-contained — inline styles, no JS — so it
 * survives the popup's blank-document boot and doesn't depend on any
 * loaded modules.
 */
function openPrintView() {
  if (!cogResult) {
    showToast('Run the analysis first.', 'warn');
    return;
  }
  const win = window.open('', '_blank', 'width=900,height=1100');
  if (!win) {
    showToast('Popup blocked — allow popups for this site to print.', 'err');
    return;
  }
  const solvePts = _pointsForSolve();
  // 2026-05-28 30 — engine source of truth.
  const costEst = {
    totalCost: cogResult.totalCost ?? 0,
    avgCostPerUnit: cogResult.avgCostPerUnit ?? 0,
    totalTruckloads: cogResult.totalTruckloads ?? 0,
    totalTruckMiles: cogResult.totalTruckMiles ?? 0,
  };
  const today = new Date().toISOString().split('T')[0];
  const ctxParts = [config.customerName, (calc.INDUSTRY_OPTIONS.find(o => o.value === config.industry) || {}).label, (calc.DEAL_STAGES.find(o => o.value === config.dealStage) || {}).label].filter(Boolean);
  const ctxLine = ctxParts.length ? ctxParts.join(' · ') : 'Untitled scenario';
  const scenarioName = _scenarioName || '(unsaved)';
  const fmtMoney = (v) => '$' + (v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtMi = (v) => Math.round(v).toLocaleString() + ' mi';
  const co2 = cogResult.co2Tons || 0;
  const co2Str = co2 >= 1000 ? (co2 / 1000).toFixed(1) + ' kt' : co2 >= 1 ? co2.toFixed(0) + ' t' : (co2 * 1000).toFixed(0) + ' kg';
  const coverage = cogResult.serviceStats?.maxMiles > 0 ? cogResult.serviceStats.coveragePct.toFixed(1) + '%' : 'n/a';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>COG Analysis — ${scenarioName.replace(/</g, '&lt;')} — ${today}</title>
<style>
  @page { size: letter portrait; margin: 0.5in; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #0a1628; background: #fff; margin: 0; padding: 0; font-size: 12px; line-height: 1.4; }
  .doc { max-width: 7.5in; margin: 0 auto; padding: 16px 0; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #0a1628; }
  h2 { font-size: 14px; margin: 18px 0 8px; color: #0a1628; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
  .meta { color: #475569; font-size: 11px; margin-bottom: 16px; }
  .kpi-strip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 16px; background: linear-gradient(135deg, #0a1628, #0d1f3c); color: #fff; padding: 12px 16px; border-radius: 6px; }
  .kpi { font-size: 11px; }
  .kpi-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; opacity: 0.7; }
  .kpi-value { font-size: 18px; font-weight: 800; line-height: 1.1; margin-top: 2px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
  thead { background: #f1f5f9; }
  th { text-align: left; padding: 6px 8px; font-weight: 700; border: 1px solid #cbd5e1; }
  td { padding: 5px 8px; border: 1px solid #e2e8f0; }
  .right { text-align: right; }
  .center-card { padding: 10px 12px; margin-bottom: 8px; border: 1px solid #e2e8f0; border-radius: 4px; page-break-inside: avoid; }
  .center-card-head { font-weight: 700; font-size: 12px; margin-bottom: 6px; }
  .center-card-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; font-size: 10px; }
  .center-card-grid .lbl { color: #475569; font-size: 9px; text-transform: uppercase; }
  .center-card-grid .val { font-weight: 700; }
  .breakdown { background: #f8fafc; border-left: 3px solid #475569; padding: 10px 14px; margin-bottom: 12px; font-family: 'SFMono-Regular', Consolas, Menlo, monospace; font-size: 10px; line-height: 1.6; }
  .footer { margin-top: 16px; font-size: 9px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  .toolbar { padding: 8px 16px; background: #f1f5f9; border-bottom: 1px solid #cbd5e1; display: flex; gap: 8px; align-items: center; font-size: 11px; }
  .toolbar button { padding: 5px 12px; font-size: 11px; border: 1px solid #475569; background: #fff; border-radius: 4px; cursor: pointer; }
  @media print { .toolbar { display: none; } body { background: #fff; } }
</style>
</head><body>
<div class="toolbar">
  <strong>Print preview — use your browser's Print menu to Save as PDF.</strong>
  <button onclick="window.print()" style="margin-left:auto;">🖨️ Print now</button>
  <button onclick="window.close()">Close</button>
</div>
<div class="doc">
  <h1>${scenarioName.replace(/</g, '&lt;')}</h1>
  <div class="meta">${ctxLine.replace(/</g, '&lt;')} · Center of Gravity analysis · ${today}</div>

  <div class="kpi-strip">
    <div class="kpi"><div class="kpi-label">Centers</div><div class="kpi-value">${cogResult.centers.length}</div></div>
    <div class="kpi"><div class="kpi-label">Truckloads/yr</div><div class="kpi-value">${Math.round(costEst.totalTruckloads || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="kpi-label">Annual cost</div><div class="kpi-value">${fmtMoney(costEst.totalCost)}</div></div>
    <div class="kpi"><div class="kpi-label">CO₂/yr</div><div class="kpi-value">${co2Str}</div></div>
    <div class="kpi"><div class="kpi-label">Coverage</div><div class="kpi-value">${coverage}</div></div>
  </div>

  <h2>Cost calculation</h2>
  <div class="breakdown">
    ${solvePts.length} active demand points × ${(config.unitsPerTruck || 25000).toLocaleString()} ${(calc.getWeightUnitMeta(config.weightUnit || 'lb').short || 'units')}/truck<br/>
    ${Math.round(costEst.totalTruckloads || 0).toLocaleString()} truckloads × weighted avg distance × ${(config.roadFactor ?? 1.22).toFixed(2)} road × ${(config.roundTripFactor ?? 2.0).toFixed(1)} round-trip<br/>
    = ${Math.round(costEst.totalTruckMiles || 0).toLocaleString()} truck-mi/yr × $${(_resolveCpm() || 0).toFixed(2)}/mi<br/>
    = <strong>${fmtMoney(costEst.totalCost)}/yr</strong> · CO₂ at ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi = <strong>${co2Str}/yr</strong>
  </div>

  <h2>Recommended centers</h2>
  ${cogResult.centers.map((c, i) => `
    <div class="center-card">
      <div class="center-card-head">Center ${i + 1}: ${(c.nearestCity || '').replace(/</g, '&lt;')}${c.candidateLabel ? ` (snapped → ${c.candidateLabel.replace(/</g, '&lt;')})` : ''}</div>
      <div class="center-card-grid">
        <div><div class="lbl">Location</div><div class="val">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}</div></div>
        <div><div class="lbl">Assigned weight</div><div class="val">${(c.totalWeight || 0).toLocaleString()}</div></div>
        <div><div class="lbl">Avg distance</div><div class="val">${fmtMi(c.avgWeightedDistance)}</div></div>
        <div><div class="lbl">Annual cost</div><div class="val">${fmtMoney(Array.isArray(cogResult.costByCluster) ? cogResult.costByCluster[i] : 0)}</div></div>
      </div>
    </div>
  `).join('')}

  <h2>Demand point assignments</h2>
  <table>
    <thead><tr>
      <th>Point</th><th class="right">Lat</th><th class="right">Lng</th><th class="right">Weight</th><th class="right">Cluster</th><th class="right">Distance</th>
    </tr></thead>
    <tbody>
      ${cogResult.assignments.map(a => {
        const pt = points.find(p => p.id === a.pointId);
        if (!pt) return '';
        return `<tr>
          <td>${(pt.name || pt.id).replace(/</g, '&lt;')}${a.outOfService ? ' <strong style="color:#b91c1c;">[OUT]</strong>' : ''}</td>
          <td class="right">${pt.lat.toFixed(3)}</td>
          <td class="right">${pt.lng.toFixed(3)}</td>
          <td class="right">${(pt.weight || 0).toLocaleString()}</td>
          <td class="right">${a.clusterId + 1}</td>
          <td class="right">${fmtMi(a.distanceToCenter)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>

  <div class="footer">Generated by IES Hub · Center of Gravity · ${today}</div>
</div>
</body></html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

/**
 * Push optimal centers to Network Optimizer as candidate facilities.
 * X11 (P1) — Push to NetOpt
 * Emits cog:push-to-netopt event with candidate facility data.
 */
function pushToNetOpt() {
  if (!cogResult) {
    showToast('No analysis results to push', 'warning');
    return;
  }

  // 2026-05-28 G1 — deep handoff. Previously sent only
  // {name, lat, lng, annualDemand} per center; NetOpt had to reconstruct
  // every cost knob from scratch. Now we send the full state so the
  // receiver can hit the ground running.
  const candidates = cogResult.centers.map((c, i) => ({
    name: `Center ${i + 1} (${c.nearestCity})`,
    lat: c.lat,
    lng: c.lng,
    annualDemand: c.totalWeight,
    // 2026-05-28 — propagate capacity + fixed cost. NetOpt was defaulting
    // to capacity=200,000 / fixedCost=$1M regardless of what COG set.
    capacity: (config.capacityPerDC ?? 0) > 0 ? config.capacityPerDC : c.totalWeight,
    fixedCost: (config.fixedCostPerDC ?? 0) > 0 ? config.fixedCostPerDC : 1000000,
    // 2026-05-28 — when the candidate was snapped to a known site, pass
    // the label so NetOpt's facility list shows the real site name.
    candidateLabel: c.candidateLabel || null,
  }));

  // Demand points — actual solve set (post-exclude, post-cap). NetOpt's
  // demand shape uses zip3 + annualDemand; we set zip3 = '' since COG
  // tracks lat/lng + name only. NetOpt's normalizeDemand handles the rest.
  const solvePts = _pointsForSolve();
  const demandPoints = solvePts.map(p => ({
    name: p.name || p.id,
    lat: p.lat,
    lng: p.lng,
    annualDemand: p.weight || 0,
  }));

  const params = {
    transportCostPerMile: config.transportCostPerMile,
    roundTripFactor: config.roundTripFactor ?? 2.0,
    roadFactor: config.roadFactor ?? 1.22,
    maxServiceMiles: config.maxServiceMiles ?? 0,
    capacityPerDC: config.capacityPerDC ?? 0,
    fixedCostPerDC: config.fixedCostPerDC ?? 0,
    weightUnit: config.weightUnit || 'lb',
    unitsPerTruck: config.unitsPerTruck || 25000,
  };

  const origin = {
    scenarioId: activeScenarioId || null,
    scenarioName: _scenarioName || null,
    sourceLabel: 'Center of Gravity',
    pushedAt: Date.now(),
    // Result fingerprint so a saved NetOpt config can later detect drift
    // ("the COG that fed me has been re-run — do you want to re-pull?").
    cogResultStamp: {
      k: cogResult.centers.length,
      totalCost: cogResult.totalCost || 0,
      restartsUsed: cogResult.numRestarts || 1,
    },
  };

  const payload = { candidates, demandPoints, params, origin, at: Date.now() };
  try { sessionStorage.setItem('cog_pending_push', JSON.stringify(payload)); } catch {}
  bus.emit('cog:push-to-netopt', payload);
  const demandNote = demandPoints.length > 0 ? ` + ${demandPoints.length} demand point${demandPoints.length === 1 ? '' : 's'}` : '';
  showToast(`Pushed ${candidates.length} center(s)${demandNote} to Network Optimizer`, 'success');
  window.location.hash = '#designtools/network-opt';
}

// ============================================================
// HELPERS
// ============================================================

const CLUSTER_COLORS = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];

function clusterColor(idx) {
  return CLUSTER_COLORS[idx % CLUSTER_COLORS.length];
}

function kpi(label, value, color) {
  return `
    <div style="border-right:1px solid rgba(255,255,255,.15);padding-right:24px;">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;opacity:0.6;">${label}</span>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${value}</div>
    </div>
  `;
}

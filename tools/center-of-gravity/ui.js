/**
 * IES Hub v3 — Center of Gravity UI
 * Analyzer-pattern layout: top tab bar + full-width content.
 * Tabs: Points, Analysis, Map, Sensitivity.
 *
 * @module tools/center-of-gravity/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260703-p33';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260703-ls1';
import { RunStateTracker } from '../../shared/run-state.js?v=20260419-uE';
import { downloadCSV } from '../../shared/export.js?v=20260702-p1m1';
import { markDirty as guardMarkDirty, markClean as guardMarkClean } from '../../shared/unsaved-guard.js?v=20260703-p34';
import * as calc from './calc.js?v=20260702-p14a';
import * as api from './api.js?v=20260504-auth1';
import * as cmApi from '../cost-model/api.js?v=20260703-p33';
import { showConfirm, showPrompt } from '../../shared/confirm-modal.js?v=20260601-prompt2';
import { escapeHtml } from '../../shared/escape.js?v=20260702-sec2';

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
  parcelZones: false,
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

// 2026-06-01 — teardown for body-level overlays created by initCogMap.
// The center markers are appended to document.body via position:fixed so
// they bypass map-container clipping. That means navigating away from
// the COG editor leaves them floating over whatever the user sees next
// (e.g., the scenarios list). Call this from any unmount path.
function _cleanupCogBodyOverlays() {
  document.querySelectorAll('.cog-center-fixed-overlay').forEach(n => n.remove());
  // Also remove any stale diagnostic chrome from earlier sessions.
  document.getElementById('cog-marker-test-overlay')?.remove();
  document.getElementById('cog-marker-status-chip')?.remove();
}

export async function mount(el) {
  rootEl = el;
  // Defensive: clear any overlays left over from a previous mount cycle.
  _cleanupCogBodyOverlays();
  await renderLanding();
}

async function renderLanding() {
  if (!rootEl) return;
  _cleanupCogBodyOverlays();
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
  if (cogResult && points.length > 0) {
    try {
      const _solvePts = _pointsForSolve();
      const needFullRebuild = !Array.isArray(cogResult.assignments) || !cogResult.assignments.length;
      if (needFullRebuild) {
        // Saved row had only a summary — solve from scratch.
        cogResult = calc.kMeansCog(_solvePts, config.numCenters, config.maxIterations, config.kmeansRestarts ?? 10, (config.snapToCandidates ? (config.candidateFacilities || []).filter(c => c.locked) : []));
        if (config.snapToCandidates && (config.candidateFacilities || []).length > 0) {
          cogResult = calc.snapCentersToCandidates(cogResult, _solvePts, config.candidateFacilities);
        }
      }
      // 2026-05-29 — ALWAYS re-stamp capacity/cost/service on a loaded
      // result, even when assignments are present. Saved scenarios from
      // before today's commits carry stale totalCost (truck-only or pre-
      // mode-mix) and lack serviceStats/capacityStats/co2Tons. Without
      // this, the chrome KPI strip shows '$39K / blank / blank / blank'
      // while the Numbers tab re-runs the engine and shows the correct
      // blended cost. Re-stamping here keeps every surface aligned with
      // current engine math.
      calc.applyCapacityConstraints(cogResult, _solvePts, config.capacityPerDC ?? 0);
      _enrichCogResultWithCost(cogResult, _solvePts);
      calc.flagServiceViolations(cogResult, _solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
      sensitivityData = calc.sensitivityAnalysis(_solvePts, Math.max(config.numCenters, config.sensitivityMaxK ?? 8), config);
    } catch (err) {
      console.warn('[COG] Result re-enrichment from saved inputs failed; falling back to partial render:', err);
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
 * UX0-4 (2026-07-03) — Auto (recommended) k. When config.kAuto is on, run
 * the sensitivity sweep FIRST and adopt its recommended k before solving,
 * instead of solving at a stale k and telling the user to run again.
 * Returns the sweep so callers can reuse it (avoids a duplicate sweep).
 * @param {Array} solvePts
 * @returns {Array|null} sensitivity results when auto ran, else null
 */
function _resolveAutoK(solvePts) {
  if (!config.kAuto) return null;
  const sweep = calc.sensitivityAnalysis(solvePts, Math.max(config.numCenters, config.sensitivityMaxK ?? 8), config);
  const rec = (sweep || []).find(d => d.isRecommended) || (sweep || []).find(d => d.recommended);
  if (rec && rec.k >= 1) config.numCenters = rec.k;
  return sweep;
}

/**
 * COG-F4 — recompute centers + sensitivity in place without a full re-render
 * of the editor shell. Mirrors the body of the `cog-run` click handler.
 */
function runOptimizeAndRender() {
  if (!rootEl) return;
  const _solvePts = _pointsForSolve();
  if (!_solvePts.length) return; // nothing to solve against
  const _autoSweep = _resolveAutoK(_solvePts);
  cogResult = calc.kMeansCog(_solvePts, config.numCenters, config.maxIterations, config.kmeansRestarts ?? 10, (config.snapToCandidates ? (config.candidateFacilities || []).filter(c => c.locked) : []));
      if (config.snapToCandidates && (config.candidateFacilities || []).length > 0) {
        cogResult = calc.snapCentersToCandidates(cogResult, _solvePts, config.candidateFacilities);
      }
  calc.applyCapacityConstraints(cogResult, _solvePts, config.capacityPerDC ?? 0);
  _enrichCogResultWithCost(cogResult, _solvePts);
  calc.flagServiceViolations(cogResult, _solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
  sensitivityData = _autoSweep || calc.sensitivityAnalysis(_solvePts, Math.max(config.numCenters, config.sensitivityMaxK ?? 8), config);
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
            const csCost = calc.estimateBlendedCost(csMcr, solvePts, config);
            calc.flagServiceViolations(csMcr, solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
            const csCo2 = ((csCost.totalTruckMiles || 0) * (config.co2KgPerTruckMile ?? 1.62) + (csCost.parcelDetails?.totalPackages || 0) * (+config.parcelCo2KgPerPkg || 0.5)) / 1000; // 2026-06-10: truck + parcel, symmetric with proposed-side co2Tons
            const propCost = cogResult.totalCost || 0;
            const propCo2 = cogResult.co2Tons || 0;
            const totalWtForDelta = solvePts.reduce((sW, p) => sW + (p.weight || 0), 0);
            deltaVsCurrent = {
              currentNCenters: csList.length,
              currentCost: csCost.totalCost,
              currentCostPerUnit: totalWtForDelta > 0 ? csCost.totalCost / totalWtForDelta : 0,
              proposedCostPerUnit: totalWtForDelta > 0 ? (cogResult.totalCost || 0) / totalWtForDelta : 0,
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
          avgCostPerUnit: cogResult.avgCostPerUnit || 0,
          co2Tons: cogResult.co2Tons || 0,
          serviceCoveragePct: cogResult.serviceStats?.coveragePct ?? null,
          maxServiceMiles: config.maxServiceMiles || 0,
          peakUtilization: cogResult.capacityStats?.peakUtilization ?? null,
          capacityPerDC: config.capacityPerDC || 0,
          // 2026-05-29 E3 — multi-year horizon for downstream CM Year-1
          // → Year-N transport cost line. Empty when horizon=1.
          horizon: (() => {
            const h = Math.max(1, +config.analysisHorizonYears || 1);
            if (h <= 1) return null;
            const proj = calc.multiYearCostProjection(cogResult.totalCost || 0, config);
            return {
              years: h,
              annualGrowthPct: +config.annualGrowthPct || 0,
              annualEscalationPct: +config.annualEscalationPct || 0,
              discountRatePct: +config.discountRatePct || 0,
              totalCost: proj.totalCost,
              totalNpv: proj.totalNpv,
              yearCosts: proj.years.map(y => ({ year: y.year, cost: y.cost, cumulative: y.cumulative, npv: y.npv })),
            };
          })(),
          // Phase 2c (2026-06-10): canonical solve-set denominator — was raw
          // unscaled excluded-inclusive points, drifting from the benchmark
          // card whenever scale factor / exclusions were active.
          avgWeightedDistance: calc.deriveCogDisplayMetrics(cogResult, config, _pointsForSolve()).avgWeightedDistanceMi ?? 0,
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
            // 2026-05-29 — per-cluster parcel + truck split so CM can
            // show "Memphis: $1.2M truck / $4.3M parcel" not just total.
            truckCost: Array.isArray(cogResult.truckCostByCluster) ? (cogResult.truckCostByCluster[i] || 0) : 0,
            parcelCost: Array.isArray(cogResult.parcelCostByCluster) ? (cogResult.parcelCostByCluster[i] || 0) : 0,
          })),
          // 2026-05-29 — parcel slice on totals (commits 27-40). When the
          // scenario uses the parcel engine, CM gets the truck / parcel
          // split + carrier + zone distribution + total packages so a
          // parcel-heavy customer's CM panel can render apples-to-apples
          // against pure-TL deals without re-running COG.
          truckCost: cogResult.truckCost || 0,
          parcelCost: cogResult.parcelCost || 0,
          parcelDetails: cogResult.parcelDetails || null,
          parcelParams: cogResult.parcelDetails ? {
            modeMixEnabled: !!config.modeMixEnabled,
            modeMix: config.modeMix || null,
            parcelCarrier: config.parcelCarrier || null,
            parcelAvgPackageWeightLb: config.parcelAvgPackageWeightLb ?? null,
            parcelFuelPct: config.parcelFuelPct ?? null,
            parcelContractDiscountPct: config.parcelContractDiscountPct ?? null,
            parcelResidentialShare: config.parcelResidentialShare ?? null,
            parcelServiceMix: config.parcelServiceMix || null,
            parcelDimMultiplier: config.parcelDimMultiplier ?? null,
            parcelAccessorialsPerPkg: config.parcelAccessorialsPerPkg ?? null,
            parcelDiscountTiers: Array.isArray(config.parcelDiscountTiers) ? config.parcelDiscountTiers : [],
          } : null,
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
  // 2026-06-10 (Brock live report + assessment COG #13): the C1/C2 center
  // badges are body-level fixed-position overlays — they bypass the map
  // container entirely, so without this they float over whatever tool the
  // user navigates to next. _cleanupCogBodyOverlays' own docstring says
  // "call this from any unmount path"; unmount was the one path that didn't.
  _cleanupCogBodyOverlays();
  // Pending debounce timers fire post-unmount otherwise (auto-save could
  // write whatever state the NEXT tool has mutated by then).
  if (_autoRunTimer) { clearTimeout(_autoRunTimer); _autoRunTimer = null; }
  if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
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
    const truckCo2Kg = (costEst.totalTruckMiles || 0) * co2Intensity;
    // 2026-05-29 — parcel slice CO₂. Default 0.5 kg/pkg = EPA SmartWay
    // average for ground parcel (FedEx ~0.46, UPS ~0.55). Surfaced in
    // both the truck KPI and a separate parcelCo2Tons field so downstream
    // (CM writeback, print) can show truck/parcel split.
    const parcelPkgs = result.parcelDetails?.totalPackages || 0;
    const parcelKgPerPkg = +config.parcelCo2KgPerPkg || 0.5;
    const parcelCo2Kg = parcelPkgs * parcelKgPerPkg;
    result.co2Kg = truckCo2Kg + parcelCo2Kg;
    result.co2Tons = result.co2Kg / 1000;
    result.truckCo2Tons = truckCo2Kg / 1000;
    result.parcelCo2Tons = parcelCo2Kg / 1000;
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
  // 2026-05-29 — apply demandScaleFactor uniformly. Spread to keep the
  // original points[] untouched — important because the points table
  // displays raw input values.
  const scale = Math.max(0.001, +config.demandScaleFactor || 1.0);
  let live = points.filter(p => p.type !== 'excluded' && p.lat != null && p.lng != null);
  if (scale !== 1.0) live = live.map(p => ({ ...p, weight: (p.weight || 0) * scale }));
  // 2026-05-26 — Exclude Alaska & Hawaii from the solve when the toggle is
  // on. AK lat ~51-71, lng ~-180 to -130. HI lat ~18-23, lng ~-161 to -154.
  // Use generous bounding boxes; cleaner than testing each point against
  // every state polygon. PR (lat ~18, lng -67) is in the HI box's longitude
  // but VERY different latitude, so guard separately.
  if (config.excludeOffshore) {
    live = live.filter(p => {
      const inAK = (p.lat >= 51 && p.lat <= 72) && (p.lng >= -180 && p.lng <= -130);
      const inHI = (p.lat >= 18 && p.lat <= 23) && (p.lng >= -161 && p.lng <= -154);
      // 2026-05-29 — Puerto Rico bounding box. Single PR customer would
      // drag the centroid east into the Atlantic.
      const inPR = (p.lat >= 17.5 && p.lat <= 18.7) && (p.lng >= -67.5 && p.lng <= -65.3);
      return !inAK && !inHI && !inPR;
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
  // maxServiceMiles is set. 2026-05-29 — hide entirely when not
  // configured (was rendering '—' which read as 'broken').
  if (cogResult && cogResult.serviceStats && cogResult.serviceStats.maxMiles > 0) {
    const pct = cogResult.serviceStats.coveragePct;
    items.push({
      label: 'Service Coverage',
      value: `${pct.toFixed(1)}%`,
      hint: `Share of demand weight within ${cogResult.serviceStats.maxMiles} road-mi of its assigned DC. ${cogResult.serviceStats.outCount} of ${cogResult.serviceStats.outCount + cogResult.serviceStats.coveredCount} points out of SLA.`,
    });
  }
  // 2026-05-28 — Peak utilization KPI (B6). Only meaningful when
  // capacityPerDC > 0. Hidden otherwise (was '—').
  if (cogResult && cogResult.capacityStats && cogResult.capacityStats.capacityPerDC > 0) {
    const pk = cogResult.capacityStats.peakUtilization;
    let utilStr = `${pk.toFixed(0)}%`;
    if (cogResult.capacityStats.stillOver) utilStr += ' ⚠';
    items.push({
      label: 'Peak Util',
      value: utilStr,
      hint: `Peak cluster utilization against ${cogResult.capacityStats.capacityPerDC.toLocaleString()} cap. ${cogResult.capacityStats.reassignmentCount} reassignments walked.${cogResult.capacityStats.stillOver ? ' STILL OVER — raise k or cap.' : ''}`,
    });
  }
  // 2026-05-28 B20 — Annual CO₂ KPI. 2026-05-29 — extended to include
  // parcel emissions (was truck-only, which reported 0 for pure-parcel
  // networks). Parcel CO₂ ≈ 0.5 kg/pkg ground (EPA SmartWay benchmarks
  // FedEx Ground at ~0.46 kg/pkg, UPS Ground ~0.55 kg/pkg average). The
  // KPI sums truck + parcel slices.
  let co2Str = '—';
  let co2Hint = 'CO₂ tons/yr from total truck-miles × emissions intensity.';
  if (cogResult && typeof cogResult.co2Tons === 'number' && cogResult.co2Tons >= 0) {
    // 2026-06-10 assessment fix: co2Tons ALREADY includes the parcel slice
    // (enrichment sums truck + parcel since 2026-05-29). The KPI previously
    // re-added parcel on top — double-counting it and mislabeling the
    // parcel-inclusive total as "Truck". Read the split fields instead.
    const truckCo2 = cogResult.truckCo2Tons ?? (cogResult.co2Tons || 0);
    const parcelPkgs = cogResult.parcelDetails?.totalPackages || 0;
    const parcelKgPerPkg = +config.parcelCo2KgPerPkg || 0.5;
    const parcelCo2 = cogResult.parcelCo2Tons ?? ((parcelPkgs * parcelKgPerPkg) / 1000);
    const t = cogResult.co2Tons || (truckCo2 + parcelCo2);
    if (t >= 1000) co2Str = (t / 1000).toFixed(1) + ' kt';
    else if (t >= 1) co2Str = t.toFixed(0) + ' t';
    else co2Str = (t * 1000).toFixed(0) + ' kg';
    co2Hint = `Truck: ${truckCo2.toFixed(0)} t (${(cogResult.totalTruckMiles || 0).toLocaleString(undefined, {maximumFractionDigits:0})} mi × ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi)`;
    if (parcelPkgs > 0) {
      co2Hint += ` · Parcel: ${parcelCo2.toFixed(0)} t (${parcelPkgs.toLocaleString(undefined, {maximumFractionDigits:0})} pkgs × ${parcelKgPerPkg.toFixed(2)} kg/pkg)`;
    }
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
            const _autoSweep = _resolveAutoK(_solvePts);
            cogResult = calc.kMeansCog(_solvePts, config.numCenters, config.maxIterations, config.kmeansRestarts ?? 10, (config.snapToCandidates ? (config.candidateFacilities || []).filter(c => c.locked) : []));
            if (config.snapToCandidates && (config.candidateFacilities || []).length > 0) {
              cogResult = calc.snapCentersToCandidates(cogResult, _solvePts, config.candidateFacilities);
            }
            calc.applyCapacityConstraints(cogResult, _solvePts, config.capacityPerDC ?? 0);
            _enrichCogResultWithCost(cogResult, _solvePts);
            calc.flagServiceViolations(cogResult, _solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
            sensitivityData = _autoSweep || calc.sensitivityAnalysis(_solvePts, Math.max(config.numCenters, config.sensitivityMaxK ?? 8), config);
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
      } else if (k === 'd' && cogResult) {
        e.preventDefault();
        openPptxExport();
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

  // 2026-06-11 (Brock live report #2): the C1/C2 center badges + locked-city
  // chips are position:fixed BODY-level overlays (mapfix5 design — they
  // bypass all container clipping on purpose). The 2026-06-10 fix tore them
  // down on unmount()/renderLanding(), but intra-tool navigation (Inputs ↔
  // Parameters ↔ Run sub-tabs) only swaps #cog-content — the overlays kept
  // floating over the new section at their last viewport coordinates.
  // Wipe them on EVERY content dispatch; the map path recreates them via
  // initCogMap (which self-cleans first, so the double-remove is harmless).
  _cleanupCogBodyOverlays();

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
    // 2026-05-28 32 — per-point parcel hints.
    if (/(pkg|package).*(weight|wt|lb)|avg.*wt|avg.*weight|pkg.*lb/.test(h)) return 'avgPkgWeight';
    if (/parcel.*share|parcel.*pct|parcel.*%|share.*parcel|%.*parcel/.test(h)) return 'parcelShare';
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
    { value: '',              label: 'Ignore' },
    { value: 'zip5',          label: 'ZIP (5-digit)' },
    { value: 'zip3',          label: 'ZIP (3-digit)' },
    { value: 'city',          label: 'City' },
    { value: 'state',         label: 'State' },
    { value: 'cityState',     label: 'City, State (combined)' },
    { value: 'lat',           label: 'Latitude' },
    { value: 'lng',           label: 'Longitude' },
    { value: 'name',          label: 'Name / Label' },
    { value: 'units',         label: 'Units (demand)' },
    { value: 'avgPkgWeight',  label: 'Avg pkg weight (lb)' },
    { value: 'parcelShare',   label: 'Parcel share %' },
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
    // 2026-05-28 32 — capture per-point parcel overrides when mapped.
    const ptAvgPkgWt = 'avgPkgWeight' in roleCol
      ? parseFloat(String(row[roleCol.avgPkgWeight] ?? '').replace(/[,$\s]/g, ''))
      : null;
    const ptParcelShare = 'parcelShare' in roleCol
      ? parseFloat(String(row[roleCol.parcelShare] ?? '').replace(/[,%\s]/g, ''))
      : null;
    const ptOverrides = {};
    if (Number.isFinite(ptAvgPkgWt) && ptAvgPkgWt > 0) ptOverrides.avgPackageWeightLb = ptAvgPkgWt;
    if (Number.isFinite(ptParcelShare)) ptOverrides.parcelSharePct = Math.max(0, Math.min(100, ptParcelShare));

    loaded.push({
      id: 'p' + Date.now() + '_' + loaded.length,
      name: nameField || `${hit.name}`,
      lat: hit.lat, lng: hit.lng,
      weight: Math.max(1, Math.round(unitsRaw)),
      type: 'demand',
      ...ptOverrides,
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
                  ${points.some(p => p.parcelSharePct != null || p.avgPackageWeightLb != null) ? `
                    <th style="text-align:center;padding:8px 6px;font-weight:700;cursor:pointer;user-select:none;" data-sort="parcelSharePct" title="Per-point parcel overrides: 'share% / avg-lb'. '—' means this point uses the scenario default. Click to sort by parcel share.">Parcel${_pointsSort.column === 'parcelSharePct' ? (_pointsSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>
                  ` : ''}
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
                  const hasOverrides = points.some(pp => pp.parcelSharePct != null || pp.avgPackageWeightLb != null);
                  const shareStr = p.parcelSharePct != null ? (Math.round(p.parcelSharePct) + '%') : '—';
                  const wtStr = p.avgPackageWeightLb != null ? ((+p.avgPackageWeightLb).toFixed(1) + 'lb') : '—';
                  const parcelCellHtml = hasOverrides ? (
                    '<td style="padding:6px;text-align:center;font-family:\'SFMono-Regular\',Consolas,Menlo,monospace;font-size:12px;color:var(--ies-gray-600);">' +
                    '<span title="Parcel share / avg package weight (override; \'—\' uses scenario default)">' + shareStr + ' / ' + wtStr + '</span>' +
                    '</td>'
                  ) : '';
                  return `
                  <tr style="${rowStyle}">
                    <td style="${nameStyle}" title="${exc ? 'Excluded from the solve. Edit the source file and re-upload, or delete this row.' : ''}">${escapeHtml(p.name || p.id)}</td>
                    <td style="padding:6px;text-align:right;">${ll(p.lat)}</td>
                    <td style="padding:6px;text-align:right;">${ll(p.lng)}</td>
                    <td style="padding:6px;text-align:right;">${(p.weight || 0).toLocaleString()}</td>
                    ${parcelCellHtml}
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
            <input type="number" value="${config.numCenters}" min="1" max="20" id="cog-k" ${config.kAuto ? 'disabled' : ''}
                   style="width:70px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:14px;font-weight:700;text-align:center;color:var(--ies-blue);${config.kAuto ? 'opacity:.55;' : ''}">
            <label style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px;cursor:pointer;" title="Solve k from the sensitivity sweep's recommended elbow instead of a fixed count. Uncheck to pin k manually.">
              <input type="checkbox" id="cog-k-auto" ${config.kAuto ? 'checked' : ''} style="cursor:pointer;">
              Auto (recommended)
            </label>
            <span style="font-size:11px;color:var(--ies-gray-400);">${config.kAuto ? 'k adopts the sweep recommendation on Run' : 'How many DC locations to optimize for'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Unit your demand 'weight' values are in. Math doesn't care which unit you pick — capacity below must use the same one. Drives label text everywhere weight appears.">Weight Unit:</label>
            <select id="cog-weight-unit" style="padding:7px 10px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;">
              ${calc.WEIGHT_UNIT_OPTIONS.map(u => `<option value="${u.value}"${(config.weightUnit||'lb')===u.value?' selected':''}>${u.label}</option>`).join('')}
            </select>
            <span style="font-size:11px;color:var(--ies-gray-400);" title="The Truck $/mi rate is per truck-mile regardless of weight unit. Weight Unit only changes how demand totals are bucketed into truckloads via the capacity below.">Cost rate is per truck-mile · weight unit drives demand → truckloads</span>
          </div>
          <!-- 2026-05-29 — Demand scaling factor. Lets the user dial
               sample data up to realistic customer volume without
               re-uploading. Applied uniformly across every point in
               _pointsForSolve, so flows through k-means + cost +
               parcel + CO₂ + sensitivity. -->
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;font-weight:600;" title="Multiplies every demand-point weight uniformly before the solve. Use to dial sample data up to realistic customer volume (e.g. 100x), or to model 'what if customer is 5x our size'. 1.0 = no change. Does not modify the underlying points table.">Demand × :</label>
            <input type="number" value="${config.demandScaleFactor ?? 1.0}" step="0.1" min="0.001" max="10000" id="cog-demand-scale"
                   style="width:90px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;color:var(--ies-blue);">
            <span style="font-size:11px;color:var(--ies-gray-400);">1.0 = no scale · 100 = 100× current · sample data → real volume</span>
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
          <!-- UX0-4 (2026-07-03): Planning horizon inputs. E3 shipped 2026-05-29
               with change-handlers + Analysis projection table but the inputs
               themselves were never rendered — the Analysis footnote pointed at
               a section that didn't exist. -->
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;" data-cog-horizon-group>
            <label style="font-size:13px;font-weight:600;" title="Multi-year planning horizon. 1 = single-year analysis (no projection table). 2-10 years adds a growth/escalation/NPV projection to the Analysis tab.">Horizon (yrs):</label>
            <input type="number" value="${config.analysisHorizonYears ?? 1}" min="1" max="10" step="1" id="cog-horizon-years"
                   style="width:60px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <label style="font-size:13px;font-weight:600;" title="Annual demand growth applied to transport cost in out-years.">Growth %/yr:</label>
            <input type="number" value="${config.annualGrowthPct ?? 5}" step="0.5" id="cog-annual-growth"
                   style="width:65px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <label style="font-size:13px;font-weight:600;" title="Annual cost escalation (rate inflation) applied in out-years.">Escalation %/yr:</label>
            <input type="number" value="${config.annualEscalationPct ?? 3}" step="0.5" min="0" id="cog-annual-escalation"
                   style="width:65px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <label style="font-size:13px;font-weight:600;" title="Discount rate for NPV of the multi-year cost stream. Use the customer WACC.">Discount %:</label>
            <input type="number" value="${config.discountRatePct ?? 8}" step="0.5" min="0" id="cog-discount-rate"
                   style="width:65px;padding:8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
            <span style="font-size:11px;color:var(--ies-gray-400);">Horizon 1 = single-year · 2+ adds the projection + NPV table on Analysis</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;" title="When ON, demand points whose lat/lng falls inside AK (51-72°N, -180 to -130°W), HI (18-23°N, -161 to -154°W), or PR (17.5-18.7°N, -67.5 to -65.3°W) bounding boxes are dropped before solving. Prevents a single offshore customer from dragging the centroid offshore.">
              <input type="checkbox" id="cog-exclude-offshore" ${config.excludeOffshore ? 'checked' : ''} style="cursor:pointer;">
              Exclude AK · HI · PR from solve
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
            <div>
              <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">DIM weight ×</label>
              <input type="number" value="${config.parcelDimMultiplier ?? 1.0}" min="1.0" max="3.0" step="0.05" id="cog-parcel-dim"
                     style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">1.0 dense · 1.2 mixed DTC · 2.0+ light/large</div>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:600;color:var(--ies-gray-500);margin-bottom:3px;">Accessorials \$/pkg avg</label>
              <input type="number" value="${config.parcelAccessorialsPerPkg ?? 0}" min="0" step="0.25" id="cog-parcel-accessorials"
                     style="width:100%;padding:6px 8px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;font-weight:600;text-align:right;">
              <div style="font-size:10px;color:var(--ies-gray-400);margin-top:2px;">DAS + oversize + hazmat avg · \$0-10 typical DTC</div>
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
          <!-- 2026-05-28 39 — Discount tier editor. -->
          <div style="margin-top:14px;border-top:1px dashed var(--ies-gray-200);padding-top:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
              <div style="font-size:11px;font-weight:600;color:var(--ies-gray-500);">Discount tiers (weight-banded) <span style="font-weight:400;color:var(--ies-gray-400);">— overrides the flat Contract discount above when set</span></div>
              <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-parcel-tier-add" title="Add a weight band">+ band</button>
            </div>
            <div id="cog-parcel-tier-list" style="display:flex;flex-direction:column;gap:6px;">
              ${(config.parcelDiscountTiers || []).length === 0 ? `
                <div style="font-size:11px;color:var(--ies-gray-400);font-style:italic;">No tiers set — engine uses the flat Contract discount % above. Click '+ band' to add weight-banded tiers (e.g., 0-5 lb @ 35%, 5+ lb @ 40%).</div>
              ` : (config.parcelDiscountTiers || []).map((t, ti) => `
                <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
                  <span style="color:var(--ies-gray-500);width:60px;">Above</span>
                  <input type="number" data-cog-tier-min="${ti}" value="${+t.minWeightLb || 0}" min="0" step="1"
                         style="width:70px;padding:5px 7px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:12px;font-weight:600;text-align:right;">
                  <span style="color:var(--ies-gray-500);">lb →</span>
                  <input type="number" data-cog-tier-pct="${ti}" value="${+t.discountPct || 0}" min="0" max="80" step="1"
                         style="width:70px;padding:5px 7px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:12px;font-weight:600;text-align:right;">
                  <span style="color:var(--ies-gray-500);">% off list</span>
                  <button class="hub-btn hub-btn-sm hub-btn-secondary" data-cog-tier-del="${ti}" style="padding:3px 7px;">✕</button>
                </div>
              `).join('')}
            </div>
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
              dimMultiplier: config.parcelDimMultiplier ?? 1.0,
              accessorialsPerPkg: config.parcelAccessorialsPerPkg ?? 0,
              discountTiers: config.parcelDiscountTiers,
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
    config.kAuto = false; // manual k pins the count (UX0-4)
    markDirty();
  });
  el.querySelector('#cog-k-auto')?.addEventListener('change', (e) => {
    config.kAuto = /** @type {HTMLInputElement} */ (e.target).checked;
    markDirty();
    renderContent(); // reflect disabled state on the k input
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
  // 2026-05-29 E3 — Planning horizon inputs.
  el.querySelector('#cog-horizon-years')?.addEventListener('change', (e) => {
    const v = parseInt(/** @type {HTMLInputElement} */ (e.target).value, 10);
    config.analysisHorizonYears = Math.max(1, Math.min(10, Number.isFinite(v) ? v : 1));
    markDirty();
  });
  el.querySelector('#cog-annual-growth')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.annualGrowthPct = Number.isFinite(v) ? v : 5;
    markDirty();
  });
  el.querySelector('#cog-annual-escalation')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.annualEscalationPct = Math.max(0, Number.isFinite(v) ? v : 3);
    markDirty();
  });
  el.querySelector('#cog-discount-rate')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.discountRatePct = Math.max(0, Number.isFinite(v) ? v : 8);
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
  el.querySelector('#cog-demand-scale')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.demandScaleFactor = Math.max(0.001, Math.min(10000, Number.isFinite(v) ? v : 1.0));
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
  el.querySelector('#cog-parcel-dim')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.parcelDimMultiplier = Math.max(1.0, Math.min(3.0, Number.isFinite(v) ? v : 1.0));
    markDirty(); renderParametersPhase(el);
  });
  el.querySelector('#cog-parcel-accessorials')?.addEventListener('change', (e) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
    config.parcelAccessorialsPerPkg = Math.max(0, Number.isFinite(v) ? v : 0);
    markDirty(); renderParametersPhase(el);
  });

  // 2026-05-28 39 — Discount tier editor bindings.
  el.querySelector('#cog-parcel-tier-add')?.addEventListener('click', () => {
    config.parcelDiscountTiers = config.parcelDiscountTiers || [];
    const last = config.parcelDiscountTiers[config.parcelDiscountTiers.length - 1];
    const nextMin = last ? (+last.minWeightLb + 5) : 0;
    config.parcelDiscountTiers.push({ minWeightLb: nextMin, discountPct: 30 });
    markDirty(); renderParametersPhase(el);
  });
  el.querySelectorAll('[data-cog-tier-min]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const ti = parseInt(/** @type {HTMLElement} */ (e.target).dataset.cogTierMin, 10);
      const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
      if (config.parcelDiscountTiers && config.parcelDiscountTiers[ti]) {
        config.parcelDiscountTiers[ti].minWeightLb = Math.max(0, Number.isFinite(v) ? v : 0);
        markDirty(); renderParametersPhase(el);
      }
    });
  });
  el.querySelectorAll('[data-cog-tier-pct]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const ti = parseInt(/** @type {HTMLElement} */ (e.target).dataset.cogTierPct, 10);
      const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
      if (config.parcelDiscountTiers && config.parcelDiscountTiers[ti]) {
        config.parcelDiscountTiers[ti].discountPct = Math.max(0, Math.min(80, Number.isFinite(v) ? v : 0));
        markDirty(); renderParametersPhase(el);
      }
    });
  });
  el.querySelectorAll('[data-cog-tier-del]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const ti = parseInt(/** @type {HTMLElement} */ (e.target).dataset.cogTierDel, 10);
      if (config.parcelDiscountTiers) {
        config.parcelDiscountTiers.splice(ti, 1);
        markDirty(); renderParametersPhase(el);
      }
    });
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
        // Run the same math on the current-state network. 2026-05-29 —
        // route through estimateBlendedCost so parcel scenarios produce
        // apples-to-apples numbers (was estimateTransportCost = truck-
        // only, which understated current-state cost in parcel-heavy
        // networks — the proposed side already uses blended math via
        // cogResult enrichment).
        const csCost = calc.estimateBlendedCost(csMcr, solvePts, config);
        calc.flagServiceViolations(csMcr, solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
        const csCo2 = ((csCost.totalTruckMiles || 0) * (config.co2KgPerTruckMile ?? 1.62) + (csCost.parcelDetails?.totalPackages || 0) * (+config.parcelCo2KgPerPkg || 0.5)) / 1000; // 2026-06-10: truck + parcel, symmetric with proposed-side co2Tons
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

              ${(() => {
                // 2026-05-29 F13 — landed cost per unit. The TCO number
                // SDs actually present to customers. Computed against
                // active demand weight (excludes type='excluded' rows).
                const totalWt = solvePts.reduce((s2, p) => s2 + (p.weight || 0), 0);
                if (totalWt <= 0) return '';
                const csPerUnit = csCost.totalCost / totalWt;
                const propPerUnit = propCost / totalWt;
                const dPerUnit = csPerUnit - propPerUnit;
                const wtUnit = (calc.getWeightUnitMeta(config.weightUnit || 'lb').short || 'unit');
                const fmtU = v => '\$' + v.toFixed(4);
                return `
                  <div style="color:var(--ies-gray-600);">Landed cost / ${wtUnit}</div>
                  <div style="text-align:right;">${cell(fmtU(csPerUnit))}</div>
                  <div style="text-align:right;">${cell(fmtU(propPerUnit))}</div>
                  <div style="text-align:right;">${deltaCell(`${sign(-dPerUnit)}${fmtU(Math.abs(dPerUnit))} (${sign(-dPerUnit / Math.max(0.0001, csPerUnit) * 100)}${Math.abs(dPerUnit / Math.max(0.0001, csPerUnit) * 100).toFixed(1)}%)`, dPerUnit > 0)}</div>
                `;
              })()}
            </div>
          </div>
        `;
      })()}

      <!-- Action Bar -->
      <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center;">
        <h3 class="text-section" style="margin:0;flex:1;">Analysis Results</h3>
        <button class="hub-btn hub-btn-sm hub-btn-primary" id="cog-generate-deck" style="display:flex;align-items:center;gap:6px;" title="Generate a 6-slide PowerPoint deck — Title, Executive Summary, Map, Cost Breakdown, Sensitivity, Assumptions (keyboard: D)">
          <span>📊 Generate Deck</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-print-pdf" style="display:flex;align-items:center;gap:6px;" title="Open a print-friendly snapshot in a new tab — use your browser's Print > Save as PDF">
          <span>🖨️ Print / PDF</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-export-csv" style="display:flex;align-items:center;gap:6px;">
          <span>↓ Export CSV</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-export-shipment-csv" style="display:flex;align-items:center;gap:6px;" title="Per-shipment audit trail: every assignment with distance, zone, truck cost, parcel cost, total. Useful for contract negotiation.">
          <span>↓ Per-shipment</span>
        </button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cog-export-geojson" style="display:flex;align-items:center;gap:6px;" title="GeoJSON file with centers + assignments — opens directly in QGIS, kepler.gl, or any GIS tool">
          <span>↓ Export GeoJSON</span>
        </button>
        <!-- UX0-5 (2026-07-03): Send-to-NetOpt hidden — NetOpt shelved
             (decision #9). Receive side never honored mode mix / weights
             (P4-2), so the handoff silently understated parcel-heavy
             networks. Handler left in place for reversal. -->
      </div>

      <!-- KPI Bar -->
      <div class="hub-card" style="background:linear-gradient(135deg,#0a1628,#0d1f3c);color:#fff;padding:16px 24px;margin-bottom:20px;">
        <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          ${kpi('Centers Found', String(cogResult.centers.length))}
          ${kpi('Iterations', String(cogResult.iterations))}
          ${(cogResult.parcelDetails && (cogResult.parcelDetails.totalPackages || 0) > 0)
            ? kpi('Annual Packages', Math.round(cogResult.parcelDetails.totalPackages || 0).toLocaleString())
            : kpi('Annual Truckloads', Math.round(costEst.totalTruckloads || 0).toLocaleString())}
          ${(cogResult.parcelDetails && (cogResult.parcelDetails.totalPackages || 0) > 0) && (costEst.totalTruckloads || 0) > 0
            ? kpi('Annual Truckloads', Math.round(costEst.totalTruckloads || 0).toLocaleString())
            : ''}
          ${kpi('Est. Transport Cost', calc.formatCurrency(costEst.totalCost, { compact: true }))}
          ${kpi('Avg Cost/Unit', calc.formatCurrency(costEst.avgCostPerUnit))}
        </div>
      </div>

      <!-- 2026-05-29 — Data sanity check. When trans cost / point / year
           falls below industry typical (~\$5K for parcel, ~\$2K for TL),
           the data is almost certainly off (wrong weight unit, partial-
           year sample, etc.). Surfaces the diagnosis with the actual
           numbers driving the result. -->
      ${(() => {
        const solvePts = _pointsForSolve();
        if (solvePts.length === 0) return '';
        const totalWt = solvePts.reduce((sum, p) => sum + (p.weight || 0), 0);
        const total = costEst.totalCost || 0;
        const costPerPoint = total / Math.max(1, solvePts.length);
        const costPerUnit = total / Math.max(1, totalWt);
        const wtUnit = (calc.getWeightUnitMeta(config.weightUnit || 'lb').short || 'units');
        const isParcel = !!cogResult.parcelDetails;
        const TYPICAL_LOW = isParcel ? 5000 : 2000;  // \$/point/yr lower bound
        const lowFlag = costPerPoint < TYPICAL_LOW;
        const pkgsPerPoint = isParcel && cogResult.parcelDetails ? (cogResult.parcelDetails.totalPackages / Math.max(1, solvePts.length)) : null;
        return `
          <div class="hub-card" style="padding:14px 18px;margin-bottom:20px;background:${lowFlag ? '#fef3c7' : '#f0fdf4'};border-left:4px solid ${lowFlag ? '#f59e0b' : '#22c55e'};">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
              <span style="font-size:14px;">${lowFlag ? '⚠' : '✓'}</span>
              <strong style="font-size:13px;color:${lowFlag ? '#78350f' : '#15803d'};">Data sanity check</strong>
              ${lowFlag ? '<span style="font-size:11px;color:#78350f;">Cost-per-point is below industry typical — likely a data-setup issue.</span>' : ''}
            </div>
            <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:8px 14px;font-size:11px;font-variant-numeric:tabular-nums;">
              <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Demand points</div><div style="font-weight:700;font-size:13px;">${solvePts.length.toLocaleString()}</div></div>
              <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Total demand</div><div style="font-weight:700;font-size:13px;">${totalWt.toLocaleString(undefined, {maximumFractionDigits:0})} ${wtUnit}${(config.demandScaleFactor && config.demandScaleFactor !== 1.0) ? ` <span style="color:var(--ies-blue);font-size:10px;">(×${config.demandScaleFactor})</span>` : ''}</div></div>
              <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Avg / point</div><div style="font-weight:700;font-size:13px;">${(totalWt/Math.max(1,solvePts.length)).toLocaleString(undefined, {maximumFractionDigits:0})} ${wtUnit}</div></div>
              <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Cost / point / yr</div><div style="font-weight:700;font-size:13px;color:${lowFlag ? '#b91c1c' : '#0a1628'};">${calc.formatCurrency(costPerPoint)}</div></div>
              <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Cost / ${wtUnit}</div><div style="font-weight:700;font-size:13px;">$${costPerUnit.toFixed(4)}</div></div>
              ${pkgsPerPoint != null ? `
                <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Pkgs / point / yr</div><div style="font-weight:700;font-size:13px;">${Math.round(pkgsPerPoint).toLocaleString()}</div></div>
                <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Total packages / yr</div><div style="font-weight:700;font-size:13px;">${Math.round(cogResult.parcelDetails.totalPackages || 0).toLocaleString()}</div></div>
                <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Avg \$ / pkg</div><div style="font-weight:700;font-size:13px;">${(cogResult.parcelDetails.totalPackages > 0 ? (cogResult.parcelCost / cogResult.parcelDetails.totalPackages) : 0).toFixed(2)}</div></div>
                <div><div style="font-size:9px;text-transform:uppercase;color:var(--ies-gray-500);">Avg pkg weight</div><div style="font-weight:700;font-size:13px;">${(config.parcelAvgPackageWeightLb || 5)} lb</div></div>
              ` : ''}
            </div>
            ${lowFlag ? `
              <div style="background:rgba(245,158,11,0.15);padding:8px 12px;border-radius:4px;margin-top:10px;font-size:11px;color:#78350f;line-height:1.5;">
                <strong>Typical \$/point/yr for ${isParcel ? 'parcel' : 'TL/LTL'} networks runs ${isParcel ? '\$5K-50K' : '\$2K-20K'}.</strong> Your scenario shows <strong>${calc.formatCurrency(costPerPoint)}</strong>. Common causes:
                <ul style="margin:4px 0 0 18px;padding:0;">
                  <li>Weight column is in tons / cwt / pallets but tool reads it as ${wtUnit} (convert in Inputs, or change Weight unit selector).</li>
                  <li>Demand is monthly / partial-year instead of annual — multiply by 12 (or the right factor) before loading.</li>
                  ${isParcel ? '<li>parcelAvgPackageWeightLb (currently ' + (config.parcelAvgPackageWeightLb || 5) + ' lb) is too high — at this avg, ' + Math.round(pkgsPerPoint) + ' pkgs / point / yr is unrealistic for DTC.</li>' : ''}
                  <li>Weights are sample values (per-shipment, not annual totals) — normalize before loading.</li>
                </ul>
              </div>
            ` : ''}
          </div>
        `;
      })()}

      <!-- 2026-05-29 E3 — Multi-year cost timeline. Only rendered when
           horizon > 1; defaults to 1 = back-compat hidden. RFP-grade
           output: year-by-year projection + cumulative + NPV. -->
      ${(() => {
        const horizon = Math.max(1, +config.analysisHorizonYears || 1);
        if (horizon <= 1) return '';
        const proj = calc.multiYearCostProjection(costEst.totalCost || 0, config);
        const growth = +config.annualGrowthPct || 0;
        const escalation = +config.annualEscalationPct || 0;
        const discount = +config.discountRatePct || 0;
        const W = 720, H = 200;
        const padL = 60, padR = 20, padT = 20, padB = 30;
        const chartW = W - padL - padR;
        const chartH = H - padT - padB;
        const maxCost = Math.max(...proj.years.map(y => y.cost));
        const xStep = chartW / Math.max(1, proj.years.length - 1);
        const yScale = v => padT + chartH - (v / Math.max(1, maxCost)) * chartH;
        const pts = proj.years.map((y, i) => `${padL + i * xStep},${yScale(y.cost)}`).join(' ');
        return `
          <div class="hub-card" style="padding:18px 22px;margin-bottom:20px;background:linear-gradient(135deg,#fffbeb,#f0fdf4);border-left:4px solid #15803d;">
            <div style="display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;margin-bottom:6px;">
              <div style="font-size:14px;font-weight:700;color:#15803d;">${horizon}-year cost timeline</div>
              <div style="font-size:11px;color:var(--ies-gray-500);">${growth >= 0 ? '+' : ''}${growth}% growth/yr · +${escalation}% escalation/yr · ${discount}% discount</div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px 24px;font-size:12px;margin-bottom:14px;">
              <div><div style="font-size:10px;text-transform:uppercase;color:var(--ies-gray-500);letter-spacing:0.3px;">${horizon}-yr cumulative</div><div style="font-size:18px;font-weight:800;color:#0a1628;font-variant-numeric:tabular-nums;">${calc.formatCurrency(proj.totalCost, { compact: true })}</div></div>
              <div><div style="font-size:10px;text-transform:uppercase;color:var(--ies-gray-500);letter-spacing:0.3px;">${horizon}-yr NPV</div><div style="font-size:18px;font-weight:800;color:#15803d;font-variant-numeric:tabular-nums;">${calc.formatCurrency(proj.totalNpv, { compact: true })}</div></div>
              <div><div style="font-size:10px;text-transform:uppercase;color:var(--ies-gray-500);letter-spacing:0.3px;">Y${horizon} annual</div><div style="font-size:18px;font-weight:800;color:#0a1628;font-variant-numeric:tabular-nums;">${calc.formatCurrency(proj.years[proj.years.length - 1].cost, { compact: true })}</div></div>
            </div>
            <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" style="background:rgba(255,255,255,0.6);border-radius:6px;">
              <!-- y-axis line -->
              <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" stroke="var(--ies-gray-400)" stroke-width="1"/>
              <line x1="${padL}" y1="${padT + chartH}" x2="${padL + chartW}" y2="${padT + chartH}" stroke="var(--ies-gray-400)" stroke-width="1"/>
              <!-- bars -->
              ${proj.years.map((y, i) => {
                const x = padL + i * xStep;
                const barW = Math.max(20, xStep * 0.6);
                const yTop = yScale(y.cost);
                const h = (padT + chartH) - yTop;
                return `
                  <rect x="${x - barW/2}" y="${yTop}" width="${barW}" height="${h}" fill="#22c55e" opacity="0.7" rx="3"/>
                  <text x="${x}" y="${yTop - 4}" text-anchor="middle" font-size="10" fill="var(--ies-gray-700)" font-weight="700">${calc.formatCurrency(y.cost, { compact: true })}</text>
                  <text x="${x}" y="${padT + chartH + 18}" text-anchor="middle" font-size="11" fill="var(--ies-gray-600)" font-weight="600">Y${y.year}</text>
                `;
              }).join('')}
            </svg>
            <table style="width:100%;font-size:11px;margin-top:14px;border-collapse:collapse;font-variant-numeric:tabular-nums;">
              <thead><tr style="background:rgba(0,0,0,0.04);">
                <th style="padding:6px 8px;text-align:left;font-weight:700;">Year</th>
                <th style="padding:6px 8px;text-align:right;font-weight:700;">Annual cost</th>
                <th style="padding:6px 8px;text-align:right;font-weight:700;">Cumulative</th>
                <th style="padding:6px 8px;text-align:right;font-weight:700;">Discounted (PV)</th>
              </tr></thead>
              <tbody>
                ${proj.years.map(y => `
                  <tr>
                    <td style="padding:5px 8px;font-weight:600;">Year ${y.year}</td>
                    <td style="padding:5px 8px;text-align:right;">${calc.formatCurrency(y.cost)}</td>
                    <td style="padding:5px 8px;text-align:right;color:var(--ies-gray-600);">${calc.formatCurrency(y.cumulative)}</td>
                    <td style="padding:5px 8px;text-align:right;color:#15803d;font-weight:600;">${calc.formatCurrency(y.npv)}</td>
                  </tr>
                `).join('')}
                <tr style="border-top:2px solid var(--ies-gray-300);font-weight:700;">
                  <td style="padding:6px 8px;">${horizon}-yr total</td>
                  <td style="padding:6px 8px;"></td>
                  <td style="padding:6px 8px;text-align:right;">${calc.formatCurrency(proj.totalCost)}</td>
                  <td style="padding:6px 8px;text-align:right;color:#15803d;">${calc.formatCurrency(proj.totalNpv)}</td>
                </tr>
              </tbody>
            </table>
            <div style="font-size:10px;color:var(--ies-gray-400);margin-top:8px;line-height:1.5;">
              Tune the horizon, growth, escalation, and discount rate in <em>Parameters → Planning horizon</em>. NPV uses the customer WACC as the discount rate.
            </div>
          </div>
      ` ;
      })()}

      <!-- 2026-05-26 — Transparent cost breakdown. Shows every multiplier in
           the transport-cost formula so the math is auditable on-screen.
           Helps users sanity-check the result against their own back-of-envelope
           and catch unit-of-measure mismatches early. -->
      ${(() => {
        // Phase 2c (2026-06-10, assessment COG #6): the audit-trail chain now
        // mirrors the engine — SOLVE-set points (scaled, excluded out) and,
        // when parcel is on, per-point TRUCK-SHARE weights (engine prices
        // truckCost from weight × (1 − parcelShare); the panel previously
        // built truckloads/miles from 100% of demand, so its own arithmetic
        // didn't multiply out to the truckCost it displayed, and totalMi was
        // overstated by 1/(1−parcelShare)).
        const panelPts = _pointsForSolve();
        const panelById = new Map(panelPts.map(p => [p.id, p]));
        const parcelOnPanel = !!cogResult.parcelDetails;
        const mixSum = Math.max(1, (+config.modeMix?.tlPct || 0) + (+config.modeMix?.ltlPct || 0) + (+config.modeMix?.parcelPct || 0));
        const defParcelShare = (parcelOnPanel && config.modeMixEnabled) ? (Math.max(0, +config.modeMix?.parcelPct || 0) / mixSum) : 0;
        const truckShareFor = (pt) => {
          if (!parcelOnPanel) return 1;
          const ps = (pt && pt.parcelSharePct != null && Number.isFinite(+pt.parcelSharePct))
            ? Math.max(0, Math.min(100, +pt.parcelSharePct)) / 100
            : defParcelShare;
          return 1 - ps;
        };
        const totalWeight = panelPts.reduce((s, p) => s + (p.weight || 0), 0);
        const truckWeight = panelPts.reduce((s, p) => s + (p.weight || 0) * truckShareFor(p), 0);
        const capacity = Math.max(1, config.unitsPerTruck || 25000);
        const trucks = truckWeight / capacity;
        const totalGcMi = cogResult.assignments.reduce((s, a) => {
          const pt = panelById.get(a.pointId);
          const w = (pt?.weight || 0) * truckShareFor(pt);
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
            <span style="color:var(--ies-gray-500);">Annual demand (solve set)</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">${fmtNum(totalWeight)} ${unitLabel}</span>
            ${parcelOnPanel ? `
              <span style="color:var(--ies-gray-500);">− parcel share (scenario ${Math.round(defParcelShare * 100)}% + per-point overrides)</span>
              <span></span>
              <span style="text-align:right;font-weight:600;">= ${fmtNum(truckWeight)} ${unitLabel} truck-share</span>
            ` : ''}
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
            <span style="text-align:right;font-weight:600;">= ${calc.formatCurrency(cogResult.parcelDetails ? (cogResult.truckCost || 0) : (totalMi * cpm), { compact: true })}/yr ${cogResult.parcelDetails ? ' <em style="color:var(--ies-gray-400);font-weight:500;">(TL+LTL only)</em>' : ''}</span>
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
            <span style="color:var(--ies-gray-500);">CO₂ (truck): ${fmtNum(totalMi)} truck-mi × ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi</span>
            <span></span>
            <span style="text-align:right;font-weight:600;">= ${(totalMi * (config.co2KgPerTruckMile ?? 1.62) / 1000).toFixed(0).toLocaleString()} t/yr</span>
            ${parcelOnPanel ? `
              <span style="color:var(--ies-gray-500);">CO₂ (parcel): ${fmtNum(cogResult.parcelDetails.totalPackages)} pkgs × ${(+config.parcelCo2KgPerPkg || 0.5).toFixed(2)} kg/pkg</span>
              <span></span>
              <span style="text-align:right;font-weight:600;">= ${(((cogResult.parcelDetails.totalPackages || 0) * (+config.parcelCo2KgPerPkg || 0.5)) / 1000).toFixed(0).toLocaleString()} t/yr</span>
            ` : ''}
          </div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:10px;line-height:1.4;">
            <strong>Sanity check:</strong> ${calc.formatCurrency(totalMi * cpm / Math.max(1, trucks), { compact: true })} per truckload &middot;
            ${cpm.toFixed(2)} × ${rt.toFixed(1)} = $${(cpm * rt).toFixed(2)} per truck-mile all-in (loaded + empty).
            If this looks off, adjust <strong>$/mi</strong>, <strong>round-trip factor</strong>, or <strong>${unitLabel}/truck</strong> in <a href="#" data-cog-jump="parameters" style="color:var(--ies-blue);text-decoration:underline;">Parameters</a>.
          </div>
        </div>`;
      })()}

      ${cogResult.parcelDetails && Array.isArray(cogResult.costByAssignment) ? (() => {
        // 2026-05-28 34 — Per-DC zone distribution. Headline visual for
        // parcel COG: where do packages land relative to each DC's
        // shipping zone bands?
        const ZONE_COLORS = {
          2: '#15803d', // green = same-day-ish
          3: '#22c55e', // light green
          4: '#84cc16', // yellow-green
          5: '#eab308', // amber
          6: '#f97316', // orange
          7: '#ef4444', // red
          8: '#b91c1c', // dark red
        };
        const perCluster = cogResult.centers.map((_, ci) => {
          const z = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
          let total = 0;
          for (const cba of cogResult.costByAssignment) {
            if (cba.clusterId === ci && cba.zone && cba.pkgCount > 0) {
              z[cba.zone] += cba.pkgCount;
              total += cba.pkgCount;
            }
          }
          return { z, total };
        });
        const grandTotal = perCluster.reduce((s, x) => s + x.total, 0);
        if (grandTotal === 0) return '';
        return `
        <div class="hub-card" style="margin-bottom:20px;padding:18px 20px;background:linear-gradient(135deg,#fdf4ff,#fce7f3);border-left:4px solid #be185d;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
            <div>
              <div style="font-size:14px;font-weight:700;color:#9d174d;">Parcel Zone Distribution by DC</div>
              <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">${(grandTotal).toLocaleString(undefined, {maximumFractionDigits: 0})} packages/yr across ${cogResult.centers.length} center${cogResult.centers.length === 1 ? '' : 's'}. Lower zones = cheaper + faster.</div>
            </div>
            <div style="display:flex;gap:6px;font-size:10px;color:var(--ies-gray-500);align-items:center;">
              ${[2,3,4,5,6,7,8].map(z => '<span style="display:inline-flex;align-items:center;gap:3px;"><span style="width:10px;height:10px;border-radius:2px;background:' + ZONE_COLORS[z] + ';"></span>Z' + z + '</span>').join('')}
            </div>
          </div>
          <div style="display:grid;grid-template-columns:140px 1fr 80px;gap:6px 12px;font-size:11px;align-items:center;">
            ${perCluster.map((row, ci) => {
              const center = cogResult.centers[ci];
              if (row.total === 0) {
                return `
                  <div style="font-weight:600;color:var(--ies-gray-600);">${(center.nearestCity || ('Center ' + (ci+1))).split('(')[0].trim()}</div>
                  <div style="height:20px;background:var(--ies-gray-100);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--ies-gray-400);">no parcel here</div>
                  <div style="text-align:right;color:var(--ies-gray-400);">0 pkg</div>
                `;
              }
              return `
                <div style="font-weight:600;color:var(--ies-gray-600);">${(center.nearestCity || ('Center ' + (ci+1))).split('(')[0].trim()}</div>
                <div style="height:20px;border-radius:4px;overflow:hidden;display:flex;background:var(--ies-gray-100);">
                  ${[2,3,4,5,6,7,8].map(z => {
                    const pct = row.z[z] / row.total * 100;
                    if (pct === 0) return '';
                    return '<div style="width:' + pct.toFixed(1) + '%;background:' + ZONE_COLORS[z] + ';" title="Z' + z + ': ' + Math.round(row.z[z]) + ' pkg (' + pct.toFixed(1) + '%)"></div>';
                  }).join('')}
                </div>
                <div style="text-align:right;font-weight:600;">${Math.round(row.total).toLocaleString()} pkg</div>
              `;
            }).join('')}
          </div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:10px;border-top:1px dashed var(--ies-gray-300);padding-top:8px;line-height:1.5;">
            <strong>Reading this:</strong> a DC that lights up green (Z2-3) and yellow (Z4) is well-positioned for its parcel demand. Heavy orange/red (Z6-8) means packages travel longer zones — higher cost AND slower delivery. The 'why Memphis beats LA' chart.
          </div>
        </div>
      `;})() : ''}

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
                    <td style="padding:6px;font-weight:600;">${escapeHtml(pt?.name || a.pointId)}${outBadge}</td>
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

  // 2026-05-28 36 — Per-shipment audit CSV.
  el.querySelector('#cog-export-shipment-csv')?.addEventListener('click', () => {
    exportCogPerShipment();
  });

  // Bind NetOpt push
  el.querySelector('#cog-push-netopt')?.addEventListener('click', () => {
    pushToNetOpt();
  });

  // 2026-05-28 F4 — Print/PDF view.
  el.querySelector('#cog-print-pdf')?.addEventListener('click', () => {
    openPrintView();
  });

  // F3 — PowerPoint deck export.
  el.querySelector('#cog-generate-deck')?.addEventListener('click', () => {
    openPptxExport();
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
    // Phase 2c (2026-06-10): denominator approximates the saved scenario's
    // SOLVE set — excluded rows out, its own demandScaleFactor applied —
    // matching what its engine actually costed (was raw saved weight).
    avgDistance: (() => {
      if (!result || typeof result.totalWeightedDistance !== 'number' || !(d.points || []).length) return null;
      const scale = +cfg.demandScaleFactor > 0 ? +cfg.demandScaleFactor : 1;
      const w = d.points.filter(p => p && p.type !== 'excluded' && p.lat != null)
        .reduce((s, p) => s + (p.weight || 0), 0) * scale;
      return w > 0 ? result.totalWeightedDistance / w : null;
    })(),
    transportCostPerMile: cfg.transportCostPerMile ?? null,
    roadFactor: cfg.roadFactor ?? null,
    roundTripFactor: cfg.roundTripFactor ?? null,
    // 2026-05-29 F13 — landed cost per unit. The TCO metric SDs present.
    avgCostPerUnit: typeof result?.avgCostPerUnit === 'number' ? result.avgCostPerUnit
      : (() => { // Phase 2c: same solve-set approximation as avgDistance above
        if (typeof result?.totalCost !== 'number' || !(d.points || []).length) return null;
        const scale = +cfg.demandScaleFactor > 0 ? +cfg.demandScaleFactor : 1;
        const w = d.points.filter(p => p && p.type !== 'excluded' && p.lat != null)
          .reduce((s, p) => s + (p.weight || 0), 0) * scale;
        return w > 0 ? result.totalCost / w : null;
      })(),
    // 2026-05-29 — parcel metrics. Pre-parcel scenarios store these as
    // null; the Compare table hides parcel rows when no scenario in
    // the cols set has parcelDetails.
    truckCost: typeof result?.truckCost === 'number' ? result.truckCost : null,
    parcelCost: typeof result?.parcelCost === 'number' ? result.parcelCost : null,
    parcelPackages: result?.parcelDetails?.totalPackages ?? null,
    parcelCarrier: result?.parcelDetails?.carrier ?? null,
    parcelAvgWeight: result?.parcelDetails?.avgWeight ?? null,
    parcelFuelPct: result?.parcelDetails?.fuelPct ?? null,
    parcelDominantZone: (() => {
      const bz = result?.parcelDetails?.byZone;
      if (!bz) return null;
      let max = -1, zone = null;
      for (const k of Object.keys(bz)) { if (bz[k] > max) { max = bz[k]; zone = +k; } }
      return zone;
    })(),
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
                ${otherScenarios.map(r => `<option value="${r.id}"${comparedScenarioIds[slot] === r.id ? ' selected' : ''}>${escapeHtml(r.name || 'Untitled')}</option>`).join('')}
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

            ${(() => {
              const anyParcel = cols.some(m => m.parcelCost != null && m.parcelCost > 0);
              const fmtZone = z => z == null ? null : 'Z' + z;
              const baseRows = [
                ['Centers (k)',          (m) => valCell(m.nCenters || m.k, fmtNum)],
                ['Demand points',        (m) => valCell(m.nPoints, fmtNum)],
                ['Annual transport cost',(m) => valCell(m.totalCost, fmtCost)],
              ];
              const parcelRows = anyParcel ? [
                ['  ↳ Truck (TL+LTL)',   (m) => valCell(m.truckCost, fmtCost)],
                ['  ↳ Parcel',           (m) => valCell(m.parcelCost, fmtCost)],
                ['  ↳ Parcel share',     (m) => m.totalCost > 0 && m.parcelCost != null ? fmtPct(m.parcelCost / m.totalCost * 100) : '<span style=\"color:var(--ies-gray-300);\">—</span>'],
                ['Annual packages',      (m) => valCell(m.parcelPackages, v => Math.round(v).toLocaleString())],
                ['Parcel carrier',       (m) => m.parcelCarrier ? (m.parcelCarrier || '').replace(/_/g, ' ') : '<span style=\"color:var(--ies-gray-300);\">—</span>'],
                ['Avg pkg weight',       (m) => valCell(m.parcelAvgWeight, v => v.toFixed(1) + ' lb')],
                ['Dominant zone',        (m) => valCell(m.parcelDominantZone, fmtZone)],
              ] : [];
              const tailRows = [
                ['Landed cost / unit',   (m) => valCell(m.avgCostPerUnit, v => '$' + v.toFixed(4))],
                ['Service coverage',     (m) => valCell(m.coveragePct, fmtPct)],
                ['Peak DC utilization',  (m) => valCell(m.peakUtil, fmtPct)],
                ['Annual CO₂',           (m) => valCell(m.co2Tons, fmtTons)],
                ['Avg weighted distance',(m) => valCell(m.avgDistance, fmtMi)],
                ['$/mi',                 (m) => valCell(m.transportCostPerMile, v => '$' + v.toFixed(2))],
                ['Road factor',          (m) => valCell(m.roadFactor, v => v.toFixed(2))],
                ['Round-trip',           (m) => valCell(m.roundTripFactor, v => v.toFixed(1))],
              ];
              return [...baseRows, ...parcelRows, ...tailRows].map(([label, fn]) => `
                <div style="color:var(--ies-gray-600);${label.startsWith('  ') ? 'padding-left:14px;font-size:11px;color:var(--ies-gray-500);' : ''}">${label.replace(/^  ↳ /, '↳ ')}</div>
                ${cols.map(m => `<div style="text-align:right;font-weight:600;${label.startsWith('  ') ? 'font-size:11px;' : ''}">${fn(m)}</div>`).join('')}
              `).join('');
            })()}
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
  // Remove any leftover diagnostic overlays from earlier sessions.
  document.getElementById('cog-marker-test-overlay')?.remove();
  document.getElementById('cog-marker-status-chip')?.remove();
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
        ${cogResult.centers.some(c => !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) ? `
          <div style="width:100%;font-size:11px;background:#fee2e2;color:#991b1b;padding:6px 10px;border-radius:4px;margin-top:4px;">
            <strong>⚠ Invalid center coordinates</strong> — re-run the solve to recompute.
          </div>
        ` : ''}
        <!-- Center Locations — collapsible. Renders a 1-line summary by
             default; click to expand the full per-center detail with
             lat/lng + avg drive + total weight + zoom-to button. -->
        <details style="width:100%;margin-top:6px;">
          <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-weight:600;color:#0a1628;user-select:none;">
            <span style="font-size:11px;color:#64748b;">▸</span>
            <span style="text-transform:uppercase;letter-spacing:0.04em;font-size:11px;color:#64748b;">Center Locations</span>
            ${cogResult.centers.map((c, i) => `
              <span style="display:inline-flex;align-items:center;gap:5px;">
                <span style="width:12px;height:12px;border-radius:50%;background:${clusterColor(i)};border:1.5px solid #0a1628;"></span>
                <span>C${i + 1}${c.nearestCity ? ' · ' + c.nearestCity.split('(')[0].trim() : ''}</span>
              </span>
            `).join('')}
          </summary>
          <div style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 6px 6px;padding:10px 14px;">
            ${cogResult.centers.map((c, i) => {
              const color = clusterColor(i);
              const valid = Number.isFinite(c.lat) && Number.isFinite(c.lng);
              return `
                <div style="display:flex;align-items:center;gap:14px;padding:6px 0;${i < cogResult.centers.length - 1 ? 'border-bottom:1px solid #e2e8f0;' : ''}">
                  <div style="flex:none;width:32px;height:32px;border-radius:50%;background:${color};border:2.5px solid #0a1628;display:flex;align-items:center;justify-content:center;color:#ffffff;font-weight:800;font-size:13px;">C${i + 1}</div>
                  <div style="flex:1;">
                    <div style="font-size:13px;font-weight:700;color:#0a1628;">${c.nearestCity || `Center ${i + 1}`}</div>
                    <div style="font-size:11px;color:#475569;font-family:monospace;">
                      ${valid ? `${c.lat.toFixed(4)}°, ${c.lng.toFixed(4)}°` : `<span style="color:#b91c1c;font-weight:700;">INVALID COORDS (${c.lat}, ${c.lng})</span>`}
                      ${c.avgWeightedDistance != null ? ` · avg drive ${calc.formatMiles(c.avgWeightedDistance)}` : ''}
                      ${c.totalWeight != null ? ` · ${Math.round(c.totalWeight).toLocaleString()} total weight` : ''}
                    </div>
                  </div>
                  <button type="button" data-cog-action="zoom-centers" style="flex:none;font-size:11px;font-weight:700;padding:5px 10px;border:1.5px solid #0a1628;background:#fff;color:#0a1628;border-radius:5px;cursor:pointer;">Zoom to →</button>
                </div>
              `;
            }).join('')}
          </div>
        </details>
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
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ies-gray-600);cursor:pointer;" title="FedEx/UPS parcel zone boundary rings (Z2-Z6 at 150/300/600/1000/1400 mi) — colored green→red so you can see at a glance which destinations land in which zone">
            <input type="checkbox" data-cog-toggle="parcelZones" ${mapOptions.parcelZones ? 'checked' : ''} style="margin:0;"> Parcel zones
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
        ${mapOptions.parcelZones ? `<span style="opacity:0.8;">Parcel zones: Z2(150) / Z3(300) / Z4(600) / Z5(1000) / Z6(1400) / Z7(1800) mi</span>` : ''}
      </div>
    </div>
  `;

  // 2026-05-29 — Zoom-to-centers fallback: when the user can't find the
  // center marker (e.g. obscured by heatmap or scrolled off), this link
  // pans + zooms Leaflet to fit just the centers.
  el.querySelector('[data-cog-action="zoom-centers"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!mapInstance) return;
    const valid = cogResult.centers.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
    if (!valid.length) { showToast('No valid centers to zoom to', 'warn'); return; }
    if (valid.length === 1) {
      mapInstance.setView([valid[0].lat, valid[0].lng], 7);
    } else {
      mapInstance.fitBounds(valid.map(c => [c.lat, c.lng]), { padding: [80, 80] });
    }
  });

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

function _setChipStatus(msg) {
  const chip = document.getElementById('cog-marker-status-chip');
  if (chip) chip.textContent = 'mapfix10 · ' + msg;
}
function initCogMap() {
  _setChipStatus('initCogMap start');
  try {
    _initCogMapBody();
    _setChipStatus('initCogMap done');
  } catch (err) {
    // Surface to console — silently degrade rather than crash the tab.
    console.error('[COG initCogMap] threw:', err);
  }
}
function _initCogMapBody() {
  _setChipStatus('step 1: style injected');
  _ensureCogStyleInjected();
  const container = rootEl?.querySelector('#cog-map-container');
  if (!container || !cogResult) return;
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }

  _setChipStatus('step 2: container + L check');
  if (typeof L === 'undefined') {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--ies-gray-400);">Map requires Leaflet.js</div>';
    return;
  }

  // 2026-05-28 D12 — compute bbox before map init so we don't get the
  // zoom-4 continental-US flash before fitBounds kicks in.
  const _allPtsForInit = [
    ...points.filter(p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng)).map(p => [+p.lat, +p.lng]),
    ...cogResult.centers.filter(c => c && Number.isFinite(+c.lat) && Number.isFinite(+c.lng)).map(c => [+c.lat, +c.lng]),
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
  _setChipStatus('step 3: map created, adding tiles');
  L.tileLayer(bm.url, { maxZoom: 19, subdomains: bm.sub, attribution: bm.attr }).addTo(mapInstance);

  _setChipStatus('step 4: tiles done');
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
  _setChipStatus('step 5: pre-heat');
  if (mapOptions.heat) {
    const maxWeight = Math.max(1, ...points.map(p => p.weight || 0));
    points.forEach(pt => {
      const w = pt.weight || 0;
      if (w <= 0) return;
      // 2026-06-01 mapfix10 — skip points with missing/null coords.
      // Leaflet's L.latLng([null, X]) returns null (typeof null === 'object'
      // breaks its array-form parser), and then _project() does null.lng
      // and the entire initCogMap aborts. Filter defensively here.
      if (pt.lat == null || pt.lng == null || !Number.isFinite(+pt.lat) || !Number.isFinite(+pt.lng)) return;
      const norm = w / maxWeight;
      const haloMetres = 12000 + norm * 68000;
      L.circle([pt.lat, pt.lng], {
        radius: haloMetres,
        color: '#ff5630',
        weight: 0,
        fillColor: '#ff5630',
        fillOpacity: 0.10 + norm * 0.20,
        interactive: false,
      }).addTo(mapInstance);
    });
  }

  _setChipStatus('step 6: post-heat');
  // Service zones — translucent rings around each center at the
  // configured radii. Sits under the cluster lines so they read clearly.
  if (mapOptions.zones && Array.isArray(mapOptions.zoneRadiiMiles)) {
    cogResult.centers.forEach((c, i) => {
      if (!Number.isFinite(+c.lat) || !Number.isFinite(+c.lng)) return; // mapfix10 class: bad coord must not abort map init
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

  // 2026-05-28 35 — FedEx/UPS parcel zone rings. Concentric rings around
  // each center at the standard zone boundaries (Z2-Z6 at 150/300/600/
  // 1000/1400 mi). Colored green→red so it's instantly visible which
  // destinations land in which zone. Drawn AFTER service-zone rings so
  // it sits on top.
  if (mapOptions.parcelZones) {
    const PARCEL_ZONE_BANDS = [
      { mi: 150,  color: '#15803d', label: 'Z2' },
      { mi: 300,  color: '#22c55e', label: 'Z3' },
      { mi: 600,  color: '#84cc16', label: 'Z4' },
      { mi: 1000, color: '#eab308', label: 'Z5' },
      { mi: 1400, color: '#f97316', label: 'Z6' },
      { mi: 1800, color: '#ef4444', label: 'Z7' },
    ];
    cogResult.centers.forEach((c) => {
      if (!Number.isFinite(+c.lat) || !Number.isFinite(+c.lng)) return; // mapfix10 class guard
      PARCEL_ZONE_BANDS.forEach((band) => {
        L.circle([c.lat, c.lng], {
          radius: band.mi * 1609.34,
          color: band.color,
          weight: 1.5,
          opacity: 0.65,
          fillOpacity: 0,
          dashArray: '6 4',
          interactive: false,
        }).addTo(mapInstance);
      });
    });
  }

  _setChipStatus('step 7: pre-demand');
  // Demand points colored by cluster
  let _linesDrawn = 0;
  let _linesSkipped = 0;
  cogResult.assignments.forEach(a => {
    const pt = points.find(p => p.id === a.pointId);
    if (!pt) return;
    // Skip points with missing coords (see mapfix10 heatmap comment).
    if (pt.lat == null || pt.lng == null || !Number.isFinite(+pt.lat) || !Number.isFinite(+pt.lng)) return;
    const color = clusterColor(a.clusterId);
    // 2026-05-29 — bumped min radius 4→7 + base scale 10000→6000 so
    // even small-weight points are visible at continental zoom.
    const size = Math.max(7, Math.min(12, pt.weight / 6000));
    // 2026-05-28 B7 — out-of-service points get a red ring outline so
    // they pop against the cluster color.
    const ringColor = a.outOfService ? '#b91c1c' : '#ffffff';
    const ringWeight = a.outOfService ? 3 : 1.5;
    // Demand points in their own pane above zone rings (z=500 < cog-
    // demand z=550 < cog-centers z=650) so they aren't occluded.
    if (!mapInstance.getPane('cog-demand')) {
      mapInstance.createPane('cog-demand');
      mapInstance.getPane('cog-demand').style.zIndex = 550;
    }
    const marker = L.circleMarker([pt.lat, pt.lng], {
      radius: size, fillColor: color, color: ringColor, weight: ringWeight, fillOpacity: 0.9, pane: 'cog-demand',
    }).addTo(mapInstance);
    const outNote = a.outOfService ? `<br><strong style="color:#b91c1c;">OUT of SLA</strong> (${Math.round(a.driveRoadMi || 0)} road-mi > ${cogResult.serviceStats?.maxMiles || 0} mi)` : '';
    marker.bindPopup(`<strong>${escapeHtml(pt.name || pt.id)}</strong><br>Weight: ${pt.weight.toLocaleString()}<br>Cluster: ${a.clusterId + 1}<br>Distance: ${calc.formatMiles(a.distanceToCenter)}${outNote}`);
    // 2026-05-28 D14 — permanent labels above each demand point when toggled.
    if (mapOptions.pointLabels) {
      marker.bindTooltip(escapeHtml(pt.name || pt.id), { permanent: true, direction: 'top', offset: [0, -4], className: 'cog-pt-label', opacity: 0.85 });
    }

    // Line to center
    const center = cogResult.centers[a.clusterId];
    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
      L.polyline([[pt.lat, pt.lng], [center.lat, center.lng]], {
        color, weight: 1, opacity: 0.35,
      }).addTo(mapInstance);
      _linesDrawn++;
    } else {
      _linesSkipped++;
    }
  });
  _setChipStatus('step 8: demand done (' + _linesDrawn + ' lines)');
  console.log('[COG map] assignment lines:', _linesDrawn, 'drawn,', _linesSkipped, 'skipped (invalid center)');

  // Center markers (star-like — larger with border) + permanent label
  // E3/E4 — labels read at print resolution and on screenshot exports.
  // 2026-05-28 D6 — center markers now use the cluster color (matches
  // the assignment-line + demand-point coloring) instead of all-red.
  // 2026-05-29 v3 — Center markers now use L.marker + L.divIcon (HTML
  // DOM node) instead of circleMarker (SVG). DivIcons render as real
  // DOM elements layered above the entire Leaflet map container, so
  // they're guaranteed visible regardless of SVG pane z-order, tile
  // overlay opacity, or heatmap canvas layer. The HTML content uses
  // CSS box-shadow for the halo effect.
  console.log('[COG map] drawing', cogResult.centers.length, 'center(s):',
    cogResult.centers.map((c, i) => ({
      i, lat: c.lat, lng: c.lng, valid: Number.isFinite(c.lat) && Number.isFinite(c.lng),
      city: c.nearestCity, weight: c.totalWeight,
    })));
  // 2026-06-01 mapfix4 — Center marker is now a plain DOM overlay div
  // appended directly to the map container (#cog-map-container), positioned
  // via map.latLngToContainerPoint() and updated on move/zoom. This
  // completely bypasses Leaflet's pane / SVG / canvas / marker-icon
  // rendering — the previous five attempts (circleMarker→pane→halo→
  // crosshair→divIcon) all relied on the Leaflet marker system, which
  // for reasons we never fully isolated was not putting visible pixels
  // on screen in Brock's scenario. A plain div appended as the LAST
  // child of the container is at the top of DOM stacking order and
  // is always visible.
  _setChipStatus('step 9: pre-centers');
  // 2026-06-01 mapfix5 — Center markers as position:fixed overlays
  // appended to document.body. Positioned via the union of
  // map.latLngToContainerPoint + container.getBoundingClientRect, so
  // they sit in VIEWPORT coordinates. position:fixed bypasses the map
  // container's overflow:hidden, all Leaflet panes, and any other
  // ancestor clipping. They cannot be hidden by anything. Updated on
  // every map move + window scroll/resize.
  // First: clean up any overlays from a previous initCogMap call.
  document.querySelectorAll('.cog-center-fixed-overlay').forEach(n => n.remove());
  const _centerOverlays = [];
  cogResult.centers.forEach((c, i) => {
    const centerColor = clusterColor(i);
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
      console.warn('[COG map] center', i, 'invalid coords — skipping', c);
      return;
    }
    // Geographic crosshair (Leaflet SVG, scales with zoom).
    const crossArm = 0.6;
    L.polyline([[c.lat - crossArm, c.lng], [c.lat + crossArm, c.lng]], {
      color: '#0a1628', weight: 3, opacity: 0.85,
    }).addTo(mapInstance);
    L.polyline([[c.lat, c.lng - crossArm], [c.lat, c.lng + crossArm]], {
      color: '#0a1628', weight: 3, opacity: 0.85,
    }).addTo(mapInstance);
    // Build the fixed-position overlay element.
    const overlay = document.createElement('div');
    overlay.className = 'cog-center-fixed-overlay';
    overlay.setAttribute('data-center-idx', String(i));
    const labelText = (mapOptions.labels !== false && c.nearestCity)
      ? c.nearestCity.split('(')[0].trim()
      : '';
    overlay.innerHTML = `
      ${labelText ? `<div style="
        position: absolute; left: 50%; bottom: 52px;
        transform: translateX(-50%);
        white-space: nowrap;
        background: rgba(255,255,255,0.97); border: 1.5px solid #0a1628;
        border-radius: 5px; padding: 3px 8px;
        font-size: 12px; font-weight: 700; color: #0a1628;
        box-shadow: 0 2px 6px rgba(0,0,0,0.25);
        pointer-events: none;
      ">★ ${labelText}</div>` : ''}
      <div style="
        width: 44px; height: 44px; border-radius: 50%;
        background: ${centerColor};
        border: 4px solid #0a1628;
        box-shadow: 0 0 0 6px rgba(255,255,255,0.97), 0 4px 14px rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
        color: #ffffff; font-weight: 800; font-size: 17px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        cursor: pointer;
        pointer-events: auto;
      ">C${i + 1}</div>
    `;
    overlay.style.cssText = `
      position: fixed; width: 44px; height: 44px;
      left: -100px; top: -100px;
      z-index: 999999;
      pointer-events: none;
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target.tagName !== 'DIV' || e.target.parentNode !== overlay) return;
      L.popup()
        .setLatLng([c.lat, c.lng])
        .setContent(`<strong>Center ${i + 1}</strong><br>${c.nearestCity}<br>Location: ${calc.formatLatLng(c.lat, c.lng)}<br>Avg Distance: ${calc.formatMiles(c.avgWeightedDistance)}`)
        .openOn(mapInstance);
    });
    overlay.dataset.hubOverlay = '1'; // P3-4: swept by the router on navigation (orphaned-overlay class)
    document.body.appendChild(overlay);
    _centerOverlays.push({ overlay, c });
  });
  _setChipStatus('step 10: centers built (' + _centerOverlays.length + ' overlays)');
  // Position overlays in VIEWPORT coords via container bounding rect +
  // map.latLngToContainerPoint. Re-run on map events + window
  // scroll/resize. Also: hide the overlay if the computed viewport
  // position is outside the map container's visible area.
  const _updateCenterOverlayPositions = () => {
    if (!mapInstance || !container || !container.isConnected) return;
    const rect = container.getBoundingClientRect();
    _centerOverlays.forEach(({ overlay, c }) => {
      try {
        const pt = mapInstance.latLngToContainerPoint([c.lat, c.lng]);
        const vx = rect.left + pt.x;
        const vy = rect.top + pt.y;
        const inside = pt.x >= -20 && pt.y >= -20 &&
                       pt.x <= rect.width + 20 && pt.y <= rect.height + 20;
        if (inside) {
          overlay.style.left = (vx - 22) + 'px';
          overlay.style.top  = (vy - 22) + 'px';
          overlay.style.visibility = 'visible';
        } else {
          overlay.style.visibility = 'hidden';
        }
      } catch (err) {
        console.warn('[COG marker] position update failed:', err);
      }
    });
  };
  _updateCenterOverlayPositions();
  mapInstance.on('move zoom moveend zoomend viewreset', _updateCenterOverlayPositions);
  if (!window._cogMarkerScrollBound) {
    window._cogMarkerScrollBound = true;
    window.addEventListener('scroll', () => {
      if (window._cogMarkerScrollUpdater) window._cogMarkerScrollUpdater();
    }, { passive: true });
    window.addEventListener('resize', () => {
      if (window._cogMarkerScrollUpdater) window._cogMarkerScrollUpdater();
    });
  }
  window._cogMarkerScrollUpdater = _updateCenterOverlayPositions;
  // Surface a status chip showing the latest computed viewport coords
  // so we can SEE where the marker SHOULD be even if styling fails.
  // Replaces the existing chip if any.
  // Defer initial positioning until Leaflet finishes container sizing.
  requestAnimationFrame(() => {
    try { _updateCenterOverlayPositions(); } catch (e) { console.error('[COG marker] update failed:', e); }
    setTimeout(() => {
      try { _updateCenterOverlayPositions(); } catch (e) { console.error('[COG marker] delayed update failed:', e); }
    }, 250);
  });

  // Fit bounds
  const allPts = [
    ...points.filter(p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng)).map(p => [+p.lat, +p.lng]),
    ...cogResult.centers.filter(c => c && Number.isFinite(+c.lat) && Number.isFinite(+c.lng)).map(c => [+c.lat, +c.lng]),
  ];
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
  const tornado = calc.tornadoSensitivity(cogResult, _pointsForSolve(), config); // Phase 2c: solve set, not raw points — baseline ties to the KPI strip

  el.innerHTML = `
    <div>
      <h3 class="text-section" style="margin-bottom:16px;">Sensitivity Analysis</h3>

      ${tornado.length > 0 ? (() => {
        const baselineCost = tornado[0]?.baselineCost || 0;
        // Chart span: min/max across all driver low/high, with the
        // baseline always visible (handles asymmetric swings).
        // 2026-06-01 mapfix5 — Outlier-tolerant scale. When one driver's
        // swing is 20-60x bigger than all others (parcel-share's typical
        // case: dropping parcel% can multiply blended cost when truck
        // rates dominate), a global min/max scale crushes every other
        // row to invisible widths at the baseline tick. Fix: compute the
        // chart range from rows whose endpoints are within 5x of baseline.
        // Bars whose endpoints exceed that range get RENDERED CLIPPED
        // at chart edge + chevron indicator + value annotation, so the
        // chart is readable for all rows AND the outlier is clearly
        // flagged with its real value.
        const allEndpoints = tornado.flatMap(t => [t.lowCost, t.highCost]);
        // "Primary" endpoints are within 5x of baseline. If baseline is 0
        // (degenerate), fall back to all endpoints.
        const primaryEndpoints = baselineCost > 0
          ? allEndpoints.filter(v => v < baselineCost * 5 && v > baselineCost / 5)
          : allEndpoints;
        const primaryLow  = primaryEndpoints.length ? Math.min(baselineCost, ...primaryEndpoints) : Math.min(baselineCost, ...allEndpoints);
        const primaryHigh = primaryEndpoints.length ? Math.max(baselineCost, ...primaryEndpoints) : Math.max(baselineCost, ...allEndpoints);
        // Widen by 8% so endpoint labels don't crash the axis edge.
        const pad = (primaryHigh - primaryLow) * 0.08;
        const xMin = primaryLow - pad;
        const xMax = primaryHigh + pad;
        const xRange = Math.max(1, xMax - xMin);
        // 2026-05-29 — reserve fixed pixel padding on each side of the
        // chart area for the value labels ("$10.2M") which sit outside
        // the bar end. 8% of range fails when one driver dominates the
        // swing — the label of the biggest bar overflows the card.
        const W = 760, H = Math.max(220, 60 + tornado.length * 60);
        const labelW = 160;
        const labelPadPx = 90;
        const chartW = W - labelW - 20 - labelPadPx;
        // Map xMin..xMax into [labelW + labelPadPx, labelW + labelPadPx + chartW].
        const xPlotMin = xMin;
        const xPlotMax = xMax;
        const xPlotRange = Math.max(1, xPlotMax - xPlotMin);
        const xScale = (v) => labelW + labelPadPx + ((v - xPlotMin) / xPlotRange) * chartW;
        const baselineX = xScale(baselineCost);
        const fmtCost = (v) => calc.formatCurrency(v, { compact: true });

        return `
        <div class="hub-card" style="padding:18px 20px;margin-bottom:20px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Cost-driver tornado (current k = ${cogResult.centers.length})</div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:14px;">
            Each bar sweeps one driver to its low/high band while holding others at baseline. Bars sorted by absolute cost swing. Vertical dashed line = baseline total cost (${fmtCost(baselineCost)}).
          </div>
          <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
            <!-- Baseline vertical line -->
            <line x1="${baselineX}" y1="20" x2="${baselineX}" y2="${H - 30}" stroke="#475569" stroke-dasharray="4 3" stroke-width="1.5"/>
            <text x="${baselineX}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#475569" font-weight="600">${fmtCost(baselineCost)}</text>

            <!-- Bars -->
            ${tornado.map((t, i) => {
              const y = 30 + i * 60;
              // 2026-06-01 mapfix5 — clip bars at chart edges; outliers get
              // a chevron + actual-value annotation at the clipped edge.
              const chartRightEdge = labelW + labelPadPx + chartW;
              const chartLeftEdge = labelW + labelPadPx;
              const _rawXLow = xScale(t.lowCost);
              const _rawXHigh = xScale(t.highCost);
              const xLow = Math.max(chartLeftEdge, Math.min(chartRightEdge, _rawXLow));
              const xHigh = Math.max(chartLeftEdge, Math.min(chartRightEdge, _rawXHigh));
              const lowClipped  = _rawXLow > chartRightEdge + 0.5 || _rawXLow < chartLeftEdge - 0.5;
              const highClipped = _rawXHigh > chartRightEdge + 0.5 || _rawXHigh < chartLeftEdge - 0.5;
              const left = Math.min(xLow, xHigh);
              const w = Math.max(2, Math.abs(xHigh - xLow));
              const fmtVal = (v) => {
                if (t.key === 'transportCostPerMile') return '$' + v.toFixed(2);
                if (t.key === 'roundTripFactor') return v.toFixed(2) + 'x';
                if (t.key === 'roadFactor') return v.toFixed(2);
                if (t.key === 'demandTotal') return v.toFixed(0) + '%';
                // 2026-05-29 — parcel drivers need their own units so the
                // little number under each bar reads as "55% → 75%" not
                // "55.00 → 75.00" (ambiguous, looked like noise).
                if (t.key === 'parcelPct') return v.toFixed(0) + '%';
                if (t.key === 'parcelFuelPct') return v.toFixed(0) + '%';
                if (t.key === 'parcelContractDiscountPct') return v.toFixed(0) + '%';
                if (t.key === 'parcelDimMultiplier') return v.toFixed(2) + '×';
                if (t.key === 'parcelAccessorialsPerPkg') return '$' + v.toFixed(2);
                return String(v.toFixed(2));
              };
              return `
                <!-- 2026-05-29 — row header: driver name, then a
                     second line carrying both ±deltaPct% AND the swing
                     dollars. Previously the swing label sat under each
                     bar, where all of them clustered around the baseline
                     and overlapped one another. -->
                <text x="${labelW - 10}" y="${y + 10}" text-anchor="end" font-size="12" fill="var(--ies-gray-700)" font-weight="700">${t.label}</text>
                <text x="${labelW - 10}" y="${y + 24}" text-anchor="end" font-size="10" fill="var(--ies-gray-500)">±${t.deltaPct}% · swing ${fmtCost(t.swing)}</text>
                ${(() => {
                  // 2026-05-29 — split the bar into two color segments
                  // around the baseline: blue for the cost-below-baseline
                  // portion, orange for the cost-above. Reads as 'driver
                  // value in that direction makes cost go this way'.
                  // Bars where the entire range is on one side of
                  // baseline render as a single color (e.g. parcel share
                  // that only ever increases cost = all orange).
                  const left = Math.min(xLow, xHigh);
                  const right = Math.max(xLow, xHigh);
                  const blueRight = Math.min(right, baselineX);
                  const blueW = Math.max(0, blueRight - left);
                  const orangeLeft = Math.max(left, baselineX);
                  const orangeW = Math.max(0, right - orangeLeft);
                  let segs = '';
                  if (blueW > 0) segs += '<rect x="' + left + '" y="' + y + '" width="' + blueW + '" height="20" fill="#3b82f6" opacity="0.85"/>';
                  if (orangeW > 0) segs += '<rect x="' + orangeLeft + '" y="' + y + '" width="' + orangeW + '" height="20" fill="#f97316" opacity="0.85"/>';
                  return segs;
                })()}
                <!-- endpoint tick caps -->
                <line x1="${xLow}" y1="${y - 3}" x2="${xLow}" y2="${y + 23}" stroke="var(--ies-gray-700)" stroke-width="1.5"/>
                <line x1="${xHigh}" y1="${y - 3}" x2="${xHigh}" y2="${y + 23}" stroke="var(--ies-gray-700)" stroke-width="1.5"/>
                ${(() => {
                  // 2026-05-29 — narrow-bar fallback. When the bar is
                  // less than ~40px wide (swing tiny relative to chart
                  // scale, e.g. round-trip factor in a parcel-heavy
                  // scenario), the two end labels overlap into garbled
                  // text. Replace with a single centered annotation
                  // above the bar.
                  const barPxW = Math.abs(xHigh - xLow);
                  if (barPxW < 40) {
                    const midX = (xLow + xHigh) / 2;
                    return `
                      <line x1="${midX}" y1="${y + 20}" x2="${midX}" y2="${y + 28}" stroke="#475569" stroke-width="1.2"/>
                      <text x="${midX}" y="${y + 40}" text-anchor="middle" font-size="11" fill="#0a1628" font-weight="700">at ${fmtVal(t.lowVal)} → ${fmtVal(t.highVal)}</text>
                    `;
                  }
                  // Wide bar — smart endpoint label placement. If the
                  // outward-pointing label would clip past the chart
                  // edge, flip it to inside the bar so it stays visible.
                  // Inside labels render WHITE WITH DARK STROKE on both
                  // lines so they remain legible against the orange/blue
                  // bar fill.
                  const chartRight = labelW + labelPadPx + chartW;
                  const chartLeft  = labelW + labelPadPx;
                  const estLabelW = 64; // rough px for 'cost $XXM'
                  // 2026-06-01 mapfix7 — endpoint labels rendered BELOW
                  // the bar (dark text on the card background) with a
                  // small vertical leader tick from the bar bottom down
                  // to the label area. Eliminates the white-on-stroke
                  // contrast problems with inside-bar labels.
                  // Bar height is 20px (y..y+20). Labels sit at y+34/y+47.
                  const renderEnd = (xPt, val, cost, clipped) => {
                    const wantOutsideRight = xPt >= baselineX;
                    const estLabelW = 72;
                    const wouldClipRight = wantOutsideRight && (xPt + estLabelW > chartRight);
                    const wouldClipLeft  = !wantOutsideRight && (xPt - estLabelW < chartLeft);
                    const flipInward = wouldClipRight || wouldClipLeft || clipped;
                    const anchor = flipInward
                      ? (wantOutsideRight ? 'end' : 'start')
                      : (wantOutsideRight ? 'start' : 'end');
                    const dx = flipInward ? (wantOutsideRight ? -4 : 4) : (wantOutsideRight ? 4 : -4);
                    const chevron = clipped
                      ? `<polygon points="${wantOutsideRight
                          ? `${xPt - 14},${y + 3} ${xPt - 2},${y + 11} ${xPt - 14},${y + 19}`
                          : `${xPt + 14},${y + 3} ${xPt + 2},${y + 11} ${xPt + 14},${y + 19}`}" fill="#0a1628" stroke="#fff" stroke-width="1"/>`
                      : '';
                    return `
                      ${chevron}
                      <line x1="${xPt}" y1="${y + 20}" x2="${xPt}" y2="${y + 28}" stroke="#475569" stroke-width="1.2"/>
                      <text x="${xPt}" y="${y + 38}" text-anchor="${anchor}" font-size="10" fill="#475569" dx="${dx}">at ${val}</text>
                      <text x="${xPt}" y="${y + 50}" text-anchor="${anchor}" font-size="11" fill="#0a1628" font-weight="700" dx="${dx}">${cost}</text>
                    `;
                  };
                  return renderEnd(xLow, fmtVal(t.lowVal), fmtCost(t.lowCost), lowClipped)
                    + renderEnd(xHigh, fmtVal(t.highVal), fmtCost(t.highCost), highClipped);
                })()}
              `;
            }).join('')}
          </svg>
          ${(() => {
            // Surface a warning when the parcel-share driver shows
            // cost rising as parcel-share decreases. In a typical 3PL
            // setup parcel costs MORE per pound than TL, so lowering
            // parcel-share should LOWER total cost. If the chart shows
            // the opposite, parcel cost per pound is unrealistically
            // low — almost always a data-setup issue.
            const parcelRow = tornado.find(r => r.key === 'parcelPct');
            if (!parcelRow) return '';
            // 'low driver value (parcel-share 75%)' should produce a
            // LOWER cost than baseline if parcel is the expensive mode.
            // When lowCost > baselineCost, the math is counterintuitive.
            if (parcelRow.lowCost <= parcelRow.baselineCost + 1) return '';
            const parcelAvgWt = config.parcelAvgPackageWeightLb || 5;
            const unitsTruck = config.unitsPerTruck || 25000;
            return `
              <div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:10px 14px;margin-top:14px;font-size:11px;color:#78350f;line-height:1.55;border-radius:0 4px 4px 0;">
                <strong>⚠ Counterintuitive result on Parcel share of mix.</strong> The chart says reducing parcel share <em>raises</em> total cost — but parcel typically costs more per pound than TL, so this usually goes the other way. Almost always a data-setup issue:
                <ul style="margin:6px 0 0 18px;padding:0;">
                  <li><strong>Avg package weight</strong> currently set to <strong>${parcelAvgWt} lb</strong> — if this is too high (e.g. 500 lb), per-package parcel cost is artificially low, making parcel look cheaper than TL. Realistic DTC parcel is 1-50 lb.</li>
                  <li><strong>Units per truck</strong> currently set to <strong>${unitsTruck.toLocaleString()}</strong> — must be in the SAME unit as the demand-point weight column (typically pounds).</li>
                  <li>Verify the weight column in your input data is in pounds (not tons, not shipments-per-year).</li>
                </ul>
              </div>
            `;
          })()}
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:10px;line-height:1.55;border-top:1px dashed var(--ies-gray-200);padding-top:10px;">
            <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
              <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:18px;height:11px;background:#3b82f6;border-radius:2px;opacity:0.85;"></span><strong style="color:var(--ies-gray-700);">Blue</strong> — total cost <em>below</em> baseline (favorable direction of this driver)</span>
              <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:18px;height:11px;background:#f97316;border-radius:2px;opacity:0.85;"></span><strong style="color:var(--ies-gray-700);">Orange</strong> — total cost <em>above</em> baseline (unfavorable direction)</span>
            </div>
            <strong>Reading the rows:</strong> Drivers near the top swing cost the most — focus negotiation effort there. Drivers near the bottom are largely fixed.<br/>
            <strong>Reading each bar:</strong> The vertical dashed line is the baseline cost. Each end of the bar has a tick + label ("at <em>driver value</em>" / "cost <em>\$X</em>") — the cost AT that driver value, not a change. An all-orange bar means every sweep value raises cost above baseline.
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
 * 2026-05-28 36 — Per-shipment cost CSV. Every assignment with full
 * cost breakdown — auditable trail for contract negotiation. Rows
 * include: pointId, name, lat, lng, cluster, distance (one-way),
 * road distance (one-way × roadFactor), zone, pkg count, parcel cost,
 * truck cost, total cost.
 */
function exportCogPerShipment() {
  if (!cogResult || !Array.isArray(cogResult.assignments)) {
    showToast('No analysis results to export', 'warning');
    return;
  }
  const road = Math.max(1, +(config.roadFactor ?? 1.22));
  const now = new Date().toISOString().split('T')[0];
  const filename = `cog-per-shipment-${now}.csv`;
  const lines = [];
  lines.push('# Per-shipment audit CSV — generated by IES Hub COG');
  lines.push(`# Scenario: ${(_scenarioName || '(unsaved)').replace(/,/g, ' ')}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(`# Mode mix on: ${config.modeMixEnabled ? 'yes' : 'no'}`);
  lines.push(`# Carrier: ${config.parcelCarrier || 'fedex_ground'}`);
  lines.push('');
  lines.push('point_id,name,lat,lng,cluster,one_way_mi,road_mi,zone,weight,pkg_count,parcel_cost_usd,truck_cost_usd,total_cost_usd,out_of_sla');
  for (const a of cogResult.assignments) {
    const pt = points.find(p => p.id === a.pointId);
    const cba = Array.isArray(cogResult.costByAssignment) ? cogResult.costByAssignment.find(x => x.pointId === a.pointId) : null;
    const oneWay = a.distanceToCenter || 0;
    const roadMi = oneWay * road;
    const zone = cba?.zone ?? '';
    const pkgs = cba?.pkgCount ?? 0;
    const truckCost = cba?.truckCost ?? 0;
    const parcelCost = cba?.parcelCost ?? 0;
    const totalCost = cba?.totalCost ?? 0;
    const outOfSla = a.outOfService ? '1' : '0';
    const name = (pt?.name || a.pointId).replace(/"/g, "'");
    lines.push([
      `"${a.pointId}"`,
      `"${name}"`,
      pt?.lat != null ? pt.lat.toFixed(4) : '',
      pt?.lng != null ? pt.lng.toFixed(4) : '',
      a.clusterId + 1,
      oneWay.toFixed(2),
      roadMi.toFixed(2),
      zone,
      pt?.weight ?? '',
      pkgs.toFixed(2),
      parcelCost.toFixed(2),
      truckCost.toFixed(2),
      totalCost.toFixed(2),
      outOfSla,
    ].join(','));
  }
  const csv = lines.join('\n');
  downloadCSV(csv, filename);
  showToast(`Exported ${cogResult.assignments.length} per-shipment rows.`, 'success');
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
 * F3 — PowerPoint deck export. Lazy-loads PptxGenJS from CDN on first
 * use so initial page load isn't impacted. Produces a 6-slide deck:
 *   1. Title — customer + deal context
 *   2. Executive Summary — KPIs + vs-current delta + recommendation
 *   3. Map — US bbox with native shapes (cannot fail; no image deps)
 *   4. Cost Breakdown — per-cluster table + truck/parcel split
 *   5. Sensitivity — k-curve line chart + cost-driver tornado bar chart
 *   6. Assumptions & Recommendation — two-column
 *
 * Palette: dark navy (0A1628), amber (F59E0B), ice blue (CADCFC).
 */
let _pptxLoadPromise = null;
function _ensurePptxLoaded() {
  if (typeof window !== 'undefined' && window.PptxGenJS) return Promise.resolve();
  if (_pptxLoadPromise) return _pptxLoadPromise;
  _pptxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
    s.async = true;
    s.onload = () => {
      if (window.PptxGenJS || window.pptxgen) resolve();
      else reject(new Error('PptxGenJS loaded but global not found'));
    };
    s.onerror = () => reject(new Error('Failed to load PptxGenJS from CDN'));
    document.head.appendChild(s);
  });
  return _pptxLoadPromise;
}

async function openPptxExport() {
  if (!cogResult) { showToast('Run the analysis first.', 'warning'); return; }
  showToast('Generating PowerPoint deck...', 'info');
  try {
    await _ensurePptxLoaded();
    const PptxGenJSCtor = window.PptxGenJS || window.pptxgen;
    const pres = new PptxGenJSCtor();
    pres.layout = 'LAYOUT_WIDE'; // 13.3" x 7.5"
    pres.author = 'GXO IES Solutions Design';
    pres.company = 'GXO Logistics';
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const customerName = (config.customerName || '').trim();
    const industryLabel = (calc.INDUSTRY_OPTIONS.find(o => o.value === config.industry) || {}).label || '';
    const stageLabel = (calc.DEAL_STAGES.find(o => o.value === config.dealStage) || {}).label || '';
    const scenName = _scenarioName || 'Untitled scenario';
    pres.title = `COG ${customerName ? customerName + ' — ' : ''}${dateStr}`;

    // Palette
    const C = {
      navy: '0A1628', navySoft: '0D1F3C', amber: 'F59E0B',
      ice: 'CADCFC', white: 'FFFFFF', gray100: 'F8FAFC',
      gray200: 'E2E8F0', gray400: '94A3B8', gray500: '64748B',
      gray700: '334155', good: '16A34A', bad: 'DC2626',
    };
    const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString();
    const fmtMoneyCompact = (v) => {
      const n = Math.abs(v || 0);
      if (n >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
      if (n >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
      return '$' + Math.round(v || 0);
    };
    const fmtPct = (v, dp = 1) => (v == null ? '—' : v.toFixed(dp) + '%');
    const fmtNum = (v) => (v == null ? '—' : Math.round(v).toLocaleString());

    // Pull data
    const numCenters = cogResult.centers.length;
    const totalCost = cogResult.totalCost || 0;
    const truckCost = cogResult.truckCost || 0;
    const parcelCost = cogResult.parcelCost || 0;
    const parcelOn = parcelCost > 0;
    const co2Tons = cogResult.co2Tons || 0;
    const coverage = cogResult.serviceStats?.maxMiles > 0 ? cogResult.serviceStats.coveragePct : null;
    // Phase 2c (2026-06-10): solve-set weight, matching the engine + KPI strip
    const totalDemand = _pointsForSolve().reduce((s, p) => s + (p.weight || 0), 0);
    const costPerUnit = totalDemand > 0 ? totalCost / totalDemand : 0;
    const co2Display = co2Tons >= 1000 ? (co2Tons / 1000).toFixed(1) + ' kt' : co2Tons.toFixed(0) + ' t';

    // vs-current-state benchmark (re-computed inline; matches Network Benchmark)
    let vsCurrent = null;
    try {
      const csList = (config.currentStateDCs || []).filter(d => Number.isFinite(+d.lat) && Number.isFinite(+d.lng));
      if (csList.length > 0) {
        const solvePts = _pointsForSolve();
        const csMcr = calc.buildMcrFromDcList(csList, solvePts);
        if (csMcr) {
          const csCost = calc.estimateBlendedCost(csMcr, solvePts, config);
          calc.flagServiceViolations(csMcr, solvePts, config.maxServiceMiles ?? 0, config.roadFactor ?? 1.22);
          const csCo2 = ((csCost.totalTruckMiles || 0) * (config.co2KgPerTruckMile ?? 1.62) + (csCost.parcelDetails?.totalPackages || 0) * (+config.parcelCo2KgPerPkg || 0.5)) / 1000; // 2026-06-10: truck + parcel, symmetric with proposed-side co2Tons
          vsCurrent = {
            n: csList.length,
            cost: csCost.totalCost,
            co2Tons: csCo2,
            coverage: csMcr.serviceStats?.maxMiles > 0 ? csMcr.serviceStats.coveragePct : null,
            costDelta: totalCost - csCost.totalCost,
            costDeltaPct: csCost.totalCost > 0 ? ((totalCost - csCost.totalCost) / csCost.totalCost * 100) : 0,
            co2Delta: co2Tons - csCo2,
          };
        }
      }
    } catch (e) { console.warn('[F3] vs-current calc failed:', e); }

    // ============================================================
    // Slide 1: Title
    // ============================================================
    let s = pres.addSlide();
    s.background = { color: C.navy };
    // Top accent strip
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 13.3, h: 0.18, fill: { color: C.amber }, line: { color: C.amber } });
    // GXO IES wordmark top-left
    s.addText('GXO IES · Solutions Design', { x: 0.6, y: 0.5, w: 6, h: 0.4, fontSize: 12, fontFace: 'Calibri', color: C.amber, bold: true, charSpacing: 4 });
    // Date top-right
    s.addText(dateStr, { x: 7, y: 0.5, w: 5.7, h: 0.4, fontSize: 12, fontFace: 'Calibri', color: C.ice, align: 'right' });

    // Customer name (huge centered)
    const customerHeadline = customerName || scenName;
    s.addText(customerHeadline, { x: 0.6, y: 2.0, w: 12.1, h: 1.5, fontSize: 54, fontFace: 'Calibri', color: C.white, bold: true, align: 'center', valign: 'middle' });
    // Subtitle
    s.addText('Center of Gravity Analysis', { x: 0.6, y: 3.5, w: 12.1, h: 0.55, fontSize: 26, fontFace: 'Calibri', color: C.ice, align: 'center' });
    // Context line
    const ctxBits = [industryLabel, stageLabel, customerName ? null : `Scenario: ${scenName}`].filter(Boolean);
    if (ctxBits.length) {
      s.addText(ctxBits.join('   ·   '), { x: 0.6, y: 4.15, w: 12.1, h: 0.4, fontSize: 14, fontFace: 'Calibri', color: C.ice, align: 'center' });
    }
    // Headline KPIs at bottom of title
    s.addText([
      { text: String(numCenters), options: { fontSize: 44, color: C.amber, bold: true, breakLine: true } },
      { text: numCenters === 1 ? 'distribution center' : 'distribution centers', options: { fontSize: 12, color: C.ice } },
    ], { x: 1.5, y: 5.4, w: 3, h: 1.3, fontFace: 'Calibri', align: 'center', valign: 'top', margin: 0 });
    s.addText([
      { text: fmtMoneyCompact(totalCost), options: { fontSize: 44, color: C.amber, bold: true, breakLine: true } },
      { text: 'annual network cost', options: { fontSize: 12, color: C.ice } },
    ], { x: 5.15, y: 5.4, w: 3, h: 1.3, fontFace: 'Calibri', align: 'center', valign: 'top', margin: 0 });
    s.addText([
      { text: coverage != null ? fmtPct(coverage, 0) : co2Display, options: { fontSize: 44, color: C.amber, bold: true, breakLine: true } },
      { text: coverage != null ? 'within service SLA' : 'annual CO\u2082', options: { fontSize: 12, color: C.ice } },
    ], { x: 8.8, y: 5.4, w: 3, h: 1.3, fontFace: 'Calibri', align: 'center', valign: 'top', margin: 0 });
    // Bottom accent strip
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 7.32, w: 13.3, h: 0.18, fill: { color: C.amber }, line: { color: C.amber } });

    // ============================================================
    // Slide 2: Executive Summary
    // ============================================================
    s = pres.addSlide();
    s.background = { color: C.white };
    // Header bar
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 13.3, h: 0.85, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText('Executive Summary', { x: 0.6, y: 0.18, w: 8, h: 0.5, fontSize: 22, fontFace: 'Calibri', color: C.white, bold: true });
    s.addText(customerHeadline + (industryLabel ? '  ·  ' + industryLabel : ''), { x: 0.6, y: 0.5, w: 12.1, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.ice });

    // 4 KPI cards across the top
    const kpiCards = [
      { label: 'Distribution Centers', value: String(numCenters), sub: numCenters === 1 ? 'single-DC network' : `${numCenters} DCs in solution` },
      { label: 'Annual Network Cost', value: fmtMoneyCompact(totalCost), sub: `${fmtMoney(costPerUnit)} per unit` },
      { label: 'Service Coverage', value: coverage != null ? fmtPct(coverage, 0) : 'n/a', sub: coverage != null ? `within ${cogResult.serviceStats?.maxMiles || 0}-mi SLA` : 'no SLA defined' },
      { label: 'Annual CO\u2082', value: co2Display, sub: `truck ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi + parcel ${(+config.parcelCo2KgPerPkg || 0.5).toFixed(2)} kg/pkg` },
    ];
    kpiCards.forEach((k, i) => {
      const x = 0.6 + i * 3.1;
      // Card background
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.2, w: 2.9, h: 1.7, fill: { color: C.gray100 }, line: { color: C.gray200, width: 1 } });
      // Accent bar (left side)
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.2, w: 0.08, h: 1.7, fill: { color: C.amber }, line: { color: C.amber } });
      // Label
      s.addText(k.label, { x: x + 0.22, y: 1.32, w: 2.6, h: 0.3, fontSize: 10, fontFace: 'Calibri', color: C.gray500, bold: true, charSpacing: 2, margin: 0 });
      // Value (big)
      s.addText(k.value, { x: x + 0.22, y: 1.62, w: 2.6, h: 0.85, fontSize: 36, fontFace: 'Calibri', color: C.navy, bold: true, margin: 0 });
      // Sub
      s.addText(k.sub, { x: x + 0.22, y: 2.5, w: 2.6, h: 0.32, fontSize: 10, fontFace: 'Calibri', color: C.gray500, margin: 0 });
    });

    // vs-Current panel (if available)
    if (vsCurrent) {
      const goodCost = vsCurrent.costDelta < 0;
      s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 3.1, w: 12.1, h: 1.7, fill: { color: C.white }, line: { color: C.navy, width: 1.5 } });
      s.addText('vs. Current State Network', { x: 0.8, y: 3.2, w: 6, h: 0.36, fontSize: 12, fontFace: 'Calibri', color: C.navy, bold: true, charSpacing: 3 });
      s.addText(`Benchmarked against ${vsCurrent.n} current DC${vsCurrent.n === 1 ? '' : 's'}`, { x: 0.8, y: 3.5, w: 6, h: 0.3, fontSize: 10, fontFace: 'Calibri', color: C.gray500 });
      // Three delta KPIs
      const deltas = [
        { label: 'Cost Δ', value: (vsCurrent.costDelta >= 0 ? '+' : '') + fmtMoneyCompact(vsCurrent.costDelta), sub: (vsCurrent.costDelta >= 0 ? '+' : '') + vsCurrent.costDeltaPct.toFixed(1) + '%', color: Math.abs(vsCurrent.costDelta) < 100 ? C.navy : (goodCost ? C.good : C.bad) },
        { label: 'CO\u2082 Δ', value: (vsCurrent.co2Delta >= 0 ? '+' : '') + Math.round(vsCurrent.co2Delta).toLocaleString() + ' t', sub: vsCurrent.co2Tons > 0 ? ((vsCurrent.co2Delta / vsCurrent.co2Tons * 100).toFixed(0) + '%') : '—', color: Math.abs(vsCurrent.co2Delta) < 1 ? C.navy : (vsCurrent.co2Delta < 0 ? C.good : C.bad) },
        { label: 'Network', value: numCenters + ' vs ' + vsCurrent.n, sub: numCenters < vsCurrent.n ? 'consolidation' : (numCenters > vsCurrent.n ? 'expansion' : 'same footprint'), color: C.navy },
      ];
      deltas.forEach((d, i) => {
        const dx = 7.0 + i * 1.85;
        s.addText(d.label, { x: dx, y: 3.2, w: 1.7, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.gray500, bold: true, charSpacing: 2, margin: 0 });
        s.addText(d.value, { x: dx, y: 3.5, w: 1.7, h: 0.7, fontSize: 26, fontFace: 'Calibri', color: d.color, bold: true, margin: 0 });
        s.addText(d.sub, { x: dx, y: 4.2, w: 1.7, h: 0.3, fontSize: 10, fontFace: 'Calibri', color: C.gray500, margin: 0 });
      });
    }

    // Recommendation block
    const recoY = vsCurrent ? 5.0 : 3.3;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: recoY, w: 12.1, h: 2.0, fill: { color: C.navy }, line: { color: C.navy } });
    s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: recoY, w: 0.12, h: 2.0, fill: { color: C.amber }, line: { color: C.amber } });
    s.addText('RECOMMENDATION', { x: 0.95, y: recoY + 0.15, w: 6, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.amber, bold: true, charSpacing: 4 });
    const primaryCity = cogResult.centers[0]?.nearestCity?.split('(')[0].trim() || 'the centroid location';
    const recoLines = [];
    if (numCenters === 1) {
      recoLines.push(`Operate a single distribution center in ${primaryCity} to serve ${fmtNum(points.length)} demand points totaling ${fmtNum(totalDemand)} weight units.`);
    } else {
      const cities = cogResult.centers.map(c => c.nearestCity?.split('(')[0].trim()).filter(Boolean).slice(0, 4).join(', ');
      recoLines.push(`Operate ${numCenters} distribution centers across ${cities || 'the recommended footprint'} to serve ${fmtNum(points.length)} demand points.`);
    }
    if (vsCurrent && vsCurrent.costDelta < 0) {
      recoLines.push(`Saves ${fmtMoneyCompact(Math.abs(vsCurrent.costDelta))} per year (${Math.abs(vsCurrent.costDeltaPct).toFixed(1)}%) vs the current ${vsCurrent.n}-DC network.`);
    } else if (vsCurrent && vsCurrent.costDelta > 0) {
      recoLines.push(`Adds ${fmtMoneyCompact(Math.abs(vsCurrent.costDelta))} per year (${vsCurrent.costDeltaPct.toFixed(1)}%) vs current — value is in service/CO\u2082 not pure cost.`);
    }
    recoLines.push(`Annual landed cost ${fmtMoney(costPerUnit)} per unit at ${fmtNum(totalDemand)} units of demand.`);
    s.addText(recoLines.join('\n'), { x: 0.95, y: recoY + 0.5, w: 11.6, h: 1.4, fontSize: 14, fontFace: 'Calibri', color: C.white, valign: 'top', paraSpaceAfter: 6 });

    // Slide 2 footer
    s.addText(`Scenario: ${scenName}  ·  Generated ${dateStr}`, { x: 0.6, y: 7.1, w: 12.1, h: 0.25, fontSize: 9, fontFace: 'Calibri', color: C.gray400 });

    // ============================================================
    // Slide 3: Map
    // ============================================================
    s = pres.addSlide();
    s.background = { color: C.white };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 13.3, h: 0.85, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText('Network Map', { x: 0.6, y: 0.18, w: 8, h: 0.5, fontSize: 22, fontFace: 'Calibri', color: C.white, bold: true });
    s.addText(`${numCenters} center${numCenters === 1 ? '' : 's'}  ·  ${fmtNum(points.length)} demand points`, { x: 0.6, y: 0.5, w: 12.1, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.ice });

    // Map bbox: continental US — lng -125 to -65, lat 24 to 50
    const mapX = 0.6, mapY = 1.15, mapW = 12.1, mapH = 5.85;
    const lngL = -125, lngR = -65, latT = 50, latB = 24;
    const project = (lat, lng) => ({
      x: mapX + ((lng - lngL) / (lngR - lngL)) * mapW,
      y: mapY + ((latT - lat) / (latT - latB)) * mapH,
    });
    // Map background
    s.addShape(pres.shapes.RECTANGLE, { x: mapX, y: mapY, w: mapW, h: mapH, fill: { color: C.gray100 }, line: { color: C.gray200, width: 1 } });
    // Crude US continent shape — a single rounded rect to suggest land mass
    // (don't try to draw the actual outline — keeps the slide editable)
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: mapX + 0.6, y: mapY + 0.5, w: mapW - 1.2, h: mapH - 1.0, fill: { color: 'EDF2F7' }, line: { color: 'CBD5E1', width: 1 }, rectRadius: 0.15 });
    // Labels for region (rough)
    s.addText('UNITED STATES', { x: mapX + 4, y: mapY + 2.5, w: 4.5, h: 0.4, fontSize: 14, fontFace: 'Calibri', color: 'B0BEC5', bold: true, align: 'center', charSpacing: 8 });

    // Demand points — sampled for visual cleanliness (max 400 dots)
    const validPts = points.filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && +p.lat >= latB && +p.lat <= latT && +p.lng >= lngL && +p.lng <= lngR);
    const maxDots = 400;
    const step = Math.max(1, Math.ceil(validPts.length / maxDots));
    const sampledPts = validPts.filter((_, i) => i % step === 0);
    sampledPts.forEach(pt => {
      const { x: px, y: py } = project(+pt.lat, +pt.lng);
      s.addShape(pres.shapes.OVAL, { x: px - 0.04, y: py - 0.04, w: 0.08, h: 0.08, fill: { color: 'F87171', transparency: 50 }, line: { color: 'F87171', width: 0 } });
    });

    // Service zones for each center
    const validCenters = cogResult.centers.filter(c => Number.isFinite(+c.lat) && Number.isFinite(+c.lng));
    const clusterColors = ['0047AB', '22C55E', 'F59E0B', '8B5CF6', 'EC4899', '06B6D4', 'EF4444', '14B8A6'];
    validCenters.forEach((c, i) => {
      const { x: cx, y: cy } = project(+c.lat, +c.lng);
      const color = clusterColors[i % clusterColors.length];
      // Service zone ring — 500 mi at this projection (~7.25 lat degrees, varies but use lat for approx)
      const ringDeg = 500 / 69; // ~7.25 deg
      const ringPx = (ringDeg / (latT - latB)) * mapH;
      s.addShape(pres.shapes.OVAL, { x: cx - ringPx, y: cy - ringPx, w: ringPx * 2, h: ringPx * 2, fill: { color: color, transparency: 92 }, line: { color: color, width: 1, dashType: 'dash' } });
    });
    // Centers (drawn on top of zones)
    validCenters.forEach((c, i) => {
      const { x: cx, y: cy } = project(+c.lat, +c.lng);
      const color = clusterColors[i % clusterColors.length];
      // Halo
      s.addShape(pres.shapes.OVAL, { x: cx - 0.22, y: cy - 0.22, w: 0.44, h: 0.44, fill: { color: C.white }, line: { color: C.white } });
      // Center dot
      s.addShape(pres.shapes.OVAL, { x: cx - 0.18, y: cy - 0.18, w: 0.36, h: 0.36, fill: { color: color }, line: { color: C.navy, width: 2 } });
      // Label
      s.addText('C' + (i + 1), { x: cx - 0.18, y: cy - 0.18, w: 0.36, h: 0.36, fontSize: 11, fontFace: 'Calibri', color: C.white, bold: true, align: 'center', valign: 'middle', margin: 0 });
      // City label below
      const city = c.nearestCity?.split('(')[0].trim();
      if (city) {
        s.addText(city, { x: cx - 1.0, y: cy + 0.22, w: 2.0, h: 0.3, fontSize: 10, fontFace: 'Calibri', color: C.navy, bold: true, align: 'center', margin: 0 });
      }
    });

    // Legend
    s.addShape(pres.shapes.RECTANGLE, { x: mapX + 0.15, y: mapY + mapH - 0.65, w: 4.2, h: 0.5, fill: { color: C.white, transparency: 10 }, line: { color: C.gray200, width: 1 } });
    s.addShape(pres.shapes.OVAL, { x: mapX + 0.3, y: mapY + mapH - 0.5, w: 0.18, h: 0.18, fill: { color: clusterColors[0] }, line: { color: C.navy, width: 1.5 } });
    s.addText('Distribution center', { x: mapX + 0.55, y: mapY + mapH - 0.55, w: 1.6, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.gray700, margin: 0 });
    s.addShape(pres.shapes.OVAL, { x: mapX + 2.2, y: mapY + mapH - 0.5, w: 0.1, h: 0.1, fill: { color: 'F87171' }, line: { color: 'F87171' } });
    s.addText('Demand point (sampled)', { x: mapX + 2.4, y: mapY + mapH - 0.55, w: 1.9, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.gray700, margin: 0 });

    s.addText('Approximate positions. Ring = 500-mi service zone.', { x: mapX, y: mapY + mapH + 0.05, w: mapW, h: 0.25, fontSize: 8, fontFace: 'Calibri', color: C.gray400, italic: true });

    // ============================================================
    // Slide 4: Cost Breakdown
    // ============================================================
    s = pres.addSlide();
    s.background = { color: C.white };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 13.3, h: 0.85, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText('Cost Breakdown', { x: 0.6, y: 0.18, w: 8, h: 0.5, fontSize: 22, fontFace: 'Calibri', color: C.white, bold: true });
    s.addText(`Annual: ${fmtMoneyCompact(totalCost)}  ·  $${costPerUnit.toFixed(2)}/unit`, { x: 0.6, y: 0.5, w: 12.1, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.ice });

    // Per-cluster table
    const tableHead = [
      { text: '#', options: { bold: true, color: C.white, fill: { color: C.navy }, align: 'center' } },
      { text: 'Center', options: { bold: true, color: C.white, fill: { color: C.navy } } },
      { text: 'Demand', options: { bold: true, color: C.white, fill: { color: C.navy }, align: 'right' } },
      { text: '% of total', options: { bold: true, color: C.white, fill: { color: C.navy }, align: 'right' } },
      { text: 'Avg distance', options: { bold: true, color: C.white, fill: { color: C.navy }, align: 'right' } },
      { text: 'Annual cost', options: { bold: true, color: C.white, fill: { color: C.navy }, align: 'right' } },
    ];
    const totalWtForTable = cogResult.centers.reduce((sm, c) => sm + (c.totalWeight || 0), 0) || 1;
    const tableBody = cogResult.centers.map((c, i) => {
      const cost = Array.isArray(cogResult.costByCluster) ? (cogResult.costByCluster[i] || 0) : 0;
      const pct = (c.totalWeight || 0) / totalWtForTable * 100;
      return [
        { text: 'C' + (i + 1), options: { bold: true, color: clusterColors[i % clusterColors.length], align: 'center' } },
        { text: c.nearestCity || 'Center ' + (i + 1), options: { color: C.navy } },
        { text: fmtNum(c.totalWeight), options: { align: 'right', color: C.navy } },
        { text: pct.toFixed(1) + '%', options: { align: 'right', color: C.gray500 } },
        { text: Math.round(c.avgWeightedDistance || 0) + ' mi', options: { align: 'right', color: C.gray500 } },
        { text: fmtMoneyCompact(cost), options: { align: 'right', color: C.navy, bold: true } },
      ];
    });
    s.addTable([tableHead, ...tableBody], {
      x: 0.6, y: 1.15, w: 12.1, h: Math.min(3.5, 0.4 + cogResult.centers.length * 0.35),
      colW: [0.7, 4.0, 2.0, 1.6, 2.0, 1.8],
      fontSize: 11, fontFace: 'Calibri', border: { type: 'solid', pt: 0.5, color: C.gray200 },
    });

    // Truck vs Parcel split (if parcel engine)
    const splitY = Math.min(5.0, 1.5 + cogResult.centers.length * 0.35 + 0.4);
    if (parcelOn && totalCost > 0) {
      s.addText('Mode mix', { x: 0.6, y: splitY, w: 6, h: 0.3, fontSize: 12, fontFace: 'Calibri', color: C.gray500, bold: true, charSpacing: 3 });
      const barY = splitY + 0.4;
      const barW = 12.1;
      const truckShare = Math.max(0, Math.min(1, truckCost / totalCost));
      const parcelShare = Math.max(0, Math.min(1, parcelCost / totalCost));
      s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: barY, w: barW * truckShare, h: 0.55, fill: { color: '3B82F6' }, line: { color: '3B82F6' } });
      s.addShape(pres.shapes.RECTANGLE, { x: 0.6 + barW * truckShare, y: barY, w: barW * parcelShare, h: 0.55, fill: { color: C.amber }, line: { color: C.amber } });
      // Labels on bar
      if (truckShare > 0.08) s.addText(`TRUCK  ${(truckShare * 100).toFixed(0)}%  ${fmtMoneyCompact(truckCost)}`, { x: 0.6, y: barY, w: barW * truckShare, h: 0.55, fontSize: 11, fontFace: 'Calibri', color: C.white, bold: true, align: 'center', valign: 'middle', margin: 0 });
      if (parcelShare > 0.08) s.addText(`PARCEL  ${(parcelShare * 100).toFixed(0)}%  ${fmtMoneyCompact(parcelCost)}`, { x: 0.6 + barW * truckShare, y: barY, w: barW * parcelShare, h: 0.55, fontSize: 11, fontFace: 'Calibri', color: C.white, bold: true, align: 'center', valign: 'middle', margin: 0 });
    }

    // ============================================================
    // Slide 5: Sensitivity
    // ============================================================
    s = pres.addSlide();
    s.background = { color: C.white };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 13.3, h: 0.85, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText('Sensitivity Analysis', { x: 0.6, y: 0.18, w: 8, h: 0.5, fontSize: 22, fontFace: 'Calibri', color: C.white, bold: true });
    s.addText('How does cost respond to network size and to changes in key drivers?', { x: 0.6, y: 0.5, w: 12.1, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.ice });

    // Left: k vs cost line chart
    if (Array.isArray(sensitivityData) && sensitivityData.length > 0) {
      s.addText('Network size vs annual cost', { x: 0.6, y: 1.1, w: 6, h: 0.3, fontSize: 12, fontFace: 'Calibri', color: C.gray500, bold: true, charSpacing: 3 });
      const kLabels = sensitivityData.map(d => String(d.k));
      const kValues = sensitivityData.map(d => Math.round(d.totalCost || 0));
      s.addChart(pres.charts.LINE, [{ name: 'Annual cost', labels: kLabels, values: kValues }], {
        x: 0.6, y: 1.5, w: 6.0, h: 5.0,
        chartColors: [C.amber],
        chartArea: { fill: { color: C.white } },
        catAxisLabelColor: C.gray500, catAxisLabelFontSize: 10,
        valAxisLabelColor: C.gray500, valAxisLabelFontSize: 10,
        valGridLine: { color: C.gray200, size: 0.5 },
        catGridLine: { style: 'none' },
        lineSize: 3, lineSmooth: true,
        showValue: false, showLegend: false,
        valAxisLabelFormatCode: '$#,##0,K',
        catAxisTitle: 'Number of DCs (k)', catAxisTitleColor: C.gray700, catAxisTitleFontSize: 10, showCatAxisTitle: true,
        valAxisTitle: 'Annual cost', valAxisTitleColor: C.gray700, valAxisTitleFontSize: 10, showValAxisTitle: true,
      });
      // Recommended-k callout
      const recRow = sensitivityData.find(d => d.isRecommended || d.recommended);
      if (recRow) {
        s.addText(`Recommended k = ${recRow.k}  ·  ${fmtMoneyCompact(recRow.totalCost)}/yr`, { x: 0.6, y: 6.55, w: 6.0, h: 0.3, fontSize: 10, fontFace: 'Calibri', color: C.navy, bold: true, align: 'center' });
      }
    } else {
      s.addText('Sensitivity data not available — run analysis with multiple k values.', { x: 0.6, y: 2.5, w: 6.0, h: 0.5, fontSize: 12, fontFace: 'Calibri', color: C.gray500, italic: true });
    }

    // Right: Cost-driver tornado as horizontal bar chart
    try {
      const tornado = calc.tornadoSensitivity(cogResult, _pointsForSolve(), config); // Phase 2c: solve set
      if (Array.isArray(tornado) && tornado.length > 0) {
        s.addText('Cost-driver tornado', { x: 6.9, y: 1.1, w: 6, h: 0.3, fontSize: 12, fontFace: 'Calibri', color: C.gray500, bold: true, charSpacing: 3 });
        // Take top 6 drivers by absolute swing
        const top = tornado.slice(0, 6);
        const labels = top.map(d => d.label);
        const swings = top.map(d => Math.round(d.swing || 0));
        s.addChart(pres.charts.BAR, [{ name: 'Cost swing ($)', labels, values: swings }], {
          x: 6.9, y: 1.5, w: 6.0, h: 5.0,
          barDir: 'bar',
          chartColors: [C.navy],
          chartArea: { fill: { color: C.white } },
          catAxisLabelColor: C.gray700, catAxisLabelFontSize: 10,
          valAxisLabelColor: C.gray500, valAxisLabelFontSize: 9,
          valGridLine: { color: C.gray200, size: 0.5 },
          catGridLine: { style: 'none' },
          showValue: true, dataLabelColor: C.navy, dataLabelFontSize: 9,
          dataLabelPosition: 'outEnd', dataLabelFormatCode: '$#,##0,K',
          showLegend: false,
          valAxisLabelFormatCode: '$#,##0,K',
        });
        s.addText('Each bar shows the cost swing when that driver varies \u00b1 its range.', { x: 6.9, y: 6.55, w: 6.0, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.gray400, italic: true, align: 'center' });
      }
    } catch (e) {
      console.warn('[F3] tornado calc failed:', e);
    }

    // ============================================================
    // Slide 6: Assumptions & Recommendation
    // ============================================================
    s = pres.addSlide();
    s.background = { color: C.white };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 13.3, h: 0.85, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText('Assumptions & Next Steps', { x: 0.6, y: 0.18, w: 8, h: 0.5, fontSize: 22, fontFace: 'Calibri', color: C.white, bold: true });
    s.addText('Key parameters driving this analysis. Adjust to model alternatives.', { x: 0.6, y: 0.5, w: 12.1, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.ice });

    // Left column — Assumptions table
    const assumpRows = [
      ['Demand points', fmtNum(points.length)],
      ['Total demand', fmtNum(totalDemand) + ' ' + (config.weightUnit || 'lb')],
      ['Cost / mile', '$' + (config.transportCostPerMile || 2.85).toFixed(2)],
      ['Road factor', (config.roadFactor ?? 1.22).toFixed(2) + ' × great-circle'],
      ['Round-trip factor', (config.roundTripFactor ?? 2.0).toFixed(2) + 'x'],
      ['Units / truck', fmtNum(config.unitsPerTruck || 25000)],
      ['Fixed cost / DC', '$' + Math.round(config.fixedCostPerDC || 0).toLocaleString() + '/yr'],
    ];
    if (parcelOn) {
      assumpRows.push(['Parcel share', (config.modeMix?.parcelPct ?? 0) + '%']);
      assumpRows.push(['Avg pkg weight', (config.parcelAvgPackageWeightLb ?? 5) + ' lb']);
      assumpRows.push(['Parcel carrier', config.parcelCarrier || 'fedex']);
      if (config.parcelContractDiscountPct) assumpRows.push(['Contract discount', config.parcelContractDiscountPct + '%']);
    }
    if (config.maxServiceMiles > 0) assumpRows.push(['Service SLA', config.maxServiceMiles + ' mi']);
    assumpRows.push(['CO\u2082 / truck-mile', (config.co2KgPerTruckMile ?? 1.62).toFixed(2) + ' kg']);

    s.addText('ASSUMPTIONS', { x: 0.6, y: 1.1, w: 6, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.gray500, bold: true, charSpacing: 4 });
    const assumpTable = assumpRows.map(([k, v]) => [
      { text: k, options: { color: C.gray700, fontSize: 11, valign: 'middle' } },
      { text: v, options: { color: C.navy, fontSize: 11, bold: true, align: 'right', valign: 'middle' } },
    ]);
    s.addTable(assumpTable, {
      x: 0.6, y: 1.45, w: 6.0, colW: [3.6, 2.4],
      fontFace: 'Calibri', border: { type: 'solid', pt: 0.5, color: C.gray200 }, rowH: 0.32,
    });

    // Right column — Next Steps
    s.addText('NEXT STEPS', { x: 7.0, y: 1.1, w: 6, h: 0.3, fontSize: 11, fontFace: 'Calibri', color: C.gray500, bold: true, charSpacing: 4 });
    const nextSteps = [
      { text: 'Validate the demand data — confirm point counts, weight units, and any excluded geographies.', options: { bullet: true, breakLine: true, color: C.navy } },
      { text: 'Walk the recommended footprint with operations — labor, real estate availability, lease cost.', options: { bullet: true, breakLine: true, color: C.navy } },
      { text: 'Tune cost-per-mile and round-trip factor against the customer\u2019s actual carrier rates.', options: { bullet: true, breakLine: true, color: C.navy } },
      { text: 'Run sensitivity on growth — model 1, 3, and 5-yr horizons if growth > 5% / yr.', options: { bullet: true, breakLine: true, color: C.navy } },
      { text: 'Compare against a current-state benchmark — load the current DC list under Parameters.', options: { bullet: true, color: C.navy } },
    ];
    s.addText(nextSteps, { x: 7.0, y: 1.45, w: 6.0, h: 4.5, fontSize: 12, fontFace: 'Calibri', paraSpaceAfter: 8 });

    // Footer
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 7.05, w: 13.3, h: 0.45, fill: { color: C.gray100 }, line: { color: C.gray100 } });
    s.addText('GXO IES Solutions Design  ·  Center of Gravity Engine v3', { x: 0.6, y: 7.13, w: 6, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.gray500 });
    s.addText(`${customerHeadline}  ·  ${dateStr}`, { x: 6.7, y: 7.13, w: 6.0, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.gray500, align: 'right' });

    // Save
    const safeCustomer = (customerName || 'scenario').replace(/[^a-z0-9-]+/gi, '-').slice(0, 40);
    const fname = `cog-${safeCustomer}-${today.toISOString().split('T')[0]}.pptx`;
    await pres.writeFile({ fileName: fname });
    showToast(`Deck downloaded: ${fname}`, 'success');
  } catch (err) {
    console.error('[F3 pptx] failed:', err);
    showToast(`Deck export failed: ${err.message || err}`, 'error');
  }
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

  <div class="kpi-strip" style="grid-template-columns:repeat(6, 1fr);">
    <div class="kpi"><div class="kpi-label">Centers</div><div class="kpi-value">${cogResult.centers.length}</div></div>
    <div class="kpi"><div class="kpi-label">Truckloads/yr</div><div class="kpi-value">${Math.round(costEst.totalTruckloads || 0).toLocaleString()}</div></div>
    <div class="kpi"><div class="kpi-label">Annual cost</div><div class="kpi-value">${fmtMoney(costEst.totalCost)}</div></div>
    <div class="kpi"><div class="kpi-label">Cost / unit</div><div class="kpi-value">$${(costEst.avgCostPerUnit || 0).toFixed(4)}</div></div>
    <div class="kpi"><div class="kpi-label">CO₂/yr</div><div class="kpi-value">${co2Str}</div></div>
    <div class="kpi"><div class="kpi-label">Coverage</div><div class="kpi-value">${coverage}</div></div>
  </div>
  ${cogResult.parcelDetails ? `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;background:#f1f5f9;border-left:3px solid #14b8a6;padding:10px 14px;border-radius:4px;font-size:11px;">
      <div><div style="font-size:9px;text-transform:uppercase;color:#475569;letter-spacing:0.3px;">Truck (TL+LTL)</div><div style="font-size:15px;font-weight:800;color:#0a1628;font-variant-numeric:tabular-nums;">${fmtMoney(cogResult.truckCost || 0)}<span style="font-size:10px;font-weight:500;color:#64748b;"> &nbsp;${costEst.totalCost > 0 ? ((cogResult.truckCost || 0) / costEst.totalCost * 100).toFixed(0) : 0}%</span></div></div>
      <div><div style="font-size:9px;text-transform:uppercase;color:#475569;letter-spacing:0.3px;">Parcel</div><div style="font-size:15px;font-weight:800;color:#0a1628;font-variant-numeric:tabular-nums;">${fmtMoney(cogResult.parcelCost || 0)}<span style="font-size:10px;font-weight:500;color:#64748b;"> &nbsp;${costEst.totalCost > 0 ? ((cogResult.parcelCost || 0) / costEst.totalCost * 100).toFixed(0) : 0}%</span></div></div>
      <div><div style="font-size:9px;text-transform:uppercase;color:#475569;letter-spacing:0.3px;">Packages/yr</div><div style="font-size:15px;font-weight:800;color:#0a1628;font-variant-numeric:tabular-nums;">${Math.round(cogResult.parcelDetails.totalPackages || 0).toLocaleString()}<span style="font-size:10px;font-weight:500;color:#64748b;"> &nbsp;${(cogResult.parcelDetails.carrier || '').replace(/_/g, ' ')}</span></div></div>
    </div>
  ` : ''}

  <h2>Cost calculation</h2>
  ${cogResult.parcelDetails ? `
    <div class="breakdown">
      <strong>Truck slice (TL+LTL):</strong><br/>
      ${Math.round(costEst.totalTruckloads || 0).toLocaleString()} truckloads × weighted avg distance × ${(config.roadFactor ?? 1.22).toFixed(2)} road × ${(config.roundTripFactor ?? 2.0).toFixed(1)} round-trip<br/>
      = ${Math.round(costEst.totalTruckMiles || 0).toLocaleString()} truck-mi/yr × $${(_resolveCpm() || 0).toFixed(2)}/mi (blended)<br/>
      = <strong>${fmtMoney(cogResult.truckCost || 0)}/yr</strong><br/>
      <br/>
      <strong>Parcel slice (${(cogResult.parcelDetails.carrier || '').replace(/_/g, ' ')}):</strong><br/>
      ${Math.round(cogResult.parcelDetails.totalPackages || 0).toLocaleString()} pkgs/yr × zone-priced rate (avg ${(cogResult.parcelDetails.avgWeight || 0).toFixed(1)} lb)<br/>
      + ${(cogResult.parcelDetails.fuelPct || 0).toFixed(0)}% fuel · ${(cogResult.parcelDetails.residentialShare * 100 || 0).toFixed(0)}% residential${(cogResult.parcelDetails.discountPct || 0) > 0 ? ` · −${(cogResult.parcelDetails.discountPct || 0).toFixed(0)}% contract discount` : ''}<br/>
      = <strong>${fmtMoney(cogResult.parcelCost || 0)}/yr</strong> (avg $${cogResult.parcelDetails.totalPackages > 0 ? ((cogResult.parcelCost || 0) / cogResult.parcelDetails.totalPackages).toFixed(2) : '0.00'}/pkg)<br/>
      <br/>
      <strong>Total: ${fmtMoney(costEst.totalCost)}/yr</strong> · CO₂ (truck ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi + parcel ${(+config.parcelCo2KgPerPkg || 0.5).toFixed(2)} kg/pkg) = <strong>${co2Str}/yr</strong>
    </div>
    <h2>Parcel zone distribution</h2>
    <table>
      <thead><tr><th>Zone</th><th class="right">Range (miles)</th><th class="right">Packages</th><th class="right">% of total</th></tr></thead>
      <tbody>
        ${[
          { z: 2, lo: 0,    hi: 150 },
          { z: 3, lo: 151,  hi: 300 },
          { z: 4, lo: 301,  hi: 600 },
          { z: 5, lo: 601,  hi: 1000 },
          { z: 6, lo: 1001, hi: 1400 },
          { z: 7, lo: 1401, hi: 1800 },
          { z: 8, lo: 1801, hi: 999999 },
        ].map(b => {
          const n = (cogResult.parcelDetails.byZone || {})[b.z] || 0;
          const tot = cogResult.parcelDetails.totalPackages || 0;
          const pct = tot > 0 ? (n / tot * 100) : 0;
          if (n <= 0) return '';
          const range = b.hi >= 999999 ? `${b.lo.toLocaleString()}+` : `${b.lo.toLocaleString()}–${b.hi.toLocaleString()}`;
          return `<tr><td>Z${b.z}</td><td class="right">${range}</td><td class="right">${Math.round(n).toLocaleString()}</td><td class="right">${pct.toFixed(1)}%</td></tr>`;
        }).join('')}
      </tbody>
    </table>
  ` : `
    <div class="breakdown">
      ${solvePts.length} active demand points × ${(config.unitsPerTruck || 25000).toLocaleString()} ${(calc.getWeightUnitMeta(config.weightUnit || 'lb').short || 'units')}/truck<br/>
      ${Math.round(costEst.totalTruckloads || 0).toLocaleString()} truckloads × weighted avg distance × ${(config.roadFactor ?? 1.22).toFixed(2)} road × ${(config.roundTripFactor ?? 2.0).toFixed(1)} round-trip<br/>
      = ${Math.round(costEst.totalTruckMiles || 0).toLocaleString()} truck-mi/yr × $${(_resolveCpm() || 0).toFixed(2)}/mi<br/>
      = <strong>${fmtMoney(costEst.totalCost)}/yr</strong> · CO₂ at ${(config.co2KgPerTruckMile ?? 1.62).toFixed(2)} kg/mi = <strong>${co2Str}/yr</strong>
    </div>
  `}

  ${(() => {
    const horizon = Math.max(1, +config.analysisHorizonYears || 1);
    if (horizon <= 1) return '';
    const proj = calc.multiYearCostProjection(costEst.totalCost || 0, config);
    const growth = +config.annualGrowthPct || 0;
    const escalation = +config.annualEscalationPct || 0;
    const discount = +config.discountRatePct || 0;
    return `
      <h2>${horizon}-year cost projection</h2>
      <div class="breakdown" style="background:linear-gradient(135deg,#fffbeb,#f0fdf4);border-left-color:#15803d;">
        <strong>${horizon}-yr cumulative:</strong> ${fmtMoney(proj.totalCost)} ·
        <strong>${horizon}-yr NPV @ ${discount}%:</strong> ${fmtMoney(proj.totalNpv)} ·
        <strong>Year-${horizon} annual:</strong> ${fmtMoney(proj.years[proj.years.length - 1].cost)}<br/>
        Assumptions: ${growth >= 0 ? '+' : ''}${growth}% volume growth/yr · +${escalation}% rate escalation/yr · ${discount}% discount (WACC)
      </div>
      <table>
        <thead><tr><th>Year</th><th class="right">Annual cost</th><th class="right">Cumulative</th><th class="right">Discounted (PV)</th></tr></thead>
        <tbody>
          ${proj.years.map(y => `<tr><td>Year ${y.year}</td><td class="right">${fmtMoney(y.cost)}</td><td class="right">${fmtMoney(y.cumulative)}</td><td class="right">${fmtMoney(y.npv)}</td></tr>`).join('')}
          <tr style="border-top:2px solid #475569;font-weight:700;background:#f1f5f9;"><td>${horizon}-yr total</td><td class="right"></td><td class="right">${fmtMoney(proj.totalCost)}</td><td class="right">${fmtMoney(proj.totalNpv)}</td></tr>
        </tbody>
      </table>
    `;
  })()}

  <h2>Recommended centers</h2>
  ${cogResult.centers.map((c, i) => {
    const tCost = Array.isArray(cogResult.truckCostByCluster) ? cogResult.truckCostByCluster[i] : 0;
    const pCost = Array.isArray(cogResult.parcelCostByCluster) ? cogResult.parcelCostByCluster[i] : 0;
    const tot = Array.isArray(cogResult.costByCluster) ? cogResult.costByCluster[i] : 0;
    return `
    <div class="center-card">
      <div class="center-card-head">Center ${i + 1}: ${(c.nearestCity || '').replace(/</g, '&lt;')}${c.candidateLabel ? ` (snapped → ${c.candidateLabel.replace(/</g, '&lt;')})` : ''}</div>
      <div class="center-card-grid">
        <div><div class="lbl">Location</div><div class="val">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}</div></div>
        <div><div class="lbl">Assigned weight</div><div class="val">${(c.totalWeight || 0).toLocaleString()}</div></div>
        <div><div class="lbl">Avg distance</div><div class="val">${fmtMi(c.avgWeightedDistance)}</div></div>
        <div><div class="lbl">Annual cost</div><div class="val">${fmtMoney(tot)}</div></div>
      </div>
      ${cogResult.parcelDetails ? `
        <div class="center-card-grid" style="margin-top:6px;border-top:1px dashed #cbd5e1;padding-top:6px;">
          <div><div class="lbl">Truck cost</div><div class="val">${fmtMoney(tCost)}</div></div>
          <div><div class="lbl">Parcel cost</div><div class="val">${fmtMoney(pCost)}</div></div>
          <div><div class="lbl">Parcel share</div><div class="val">${tot > 0 ? (pCost / tot * 100).toFixed(0) : 0}%</div></div>
          <div><div class="lbl">$ / unit</div><div class="val">$${c.totalWeight > 0 ? (tot / c.totalWeight).toFixed(3) : '0.000'}</div></div>
        </div>
      ` : ''}
    </div>
  `;
  }).join('')}

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
          <td>${escapeHtml(pt.name || pt.id)}${a.outOfService ? ' <strong style="color:#b91c1c;">[OUT]</strong>' : ''}</td>
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
    // 2026-05-29 — per-point parcel overrides (commit 31). Forward so
    // NetOpt's parcel engine sees the same mixed-channel routing COG used.
    avgPackageWeightLb: (p.avgPackageWeightLb != null && Number.isFinite(+p.avgPackageWeightLb)) ? +p.avgPackageWeightLb : null,
    parcelSharePct: (p.parcelSharePct != null && Number.isFinite(+p.parcelSharePct)) ? +p.parcelSharePct : null,
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
    // 2026-05-29 — mode mix (B3) + parcel engine knobs. NetOpt's blended
    // cost calc needs these to reproduce COG's cost; without them parcel-
    // heavy customers land in NetOpt with pure-TL math + 30-50% under-
    // statement.
    modeMixEnabled: !!config.modeMixEnabled,
    modeMix: config.modeMix || { tlPct: 100, ltlPct: 0, parcelPct: 0 },
    modeRates: config.modeRates || { tlPerMile: 2.85, ltlPerMile: 4.20, parcelPerMile: 28.00 },
    parcelCarrier: config.parcelCarrier || 'fedex_ground',
    parcelAvgPackageWeightLb: config.parcelAvgPackageWeightLb ?? 5,
    parcelResidentialShare: config.parcelResidentialShare ?? 0.5,
    parcelFuelPct: config.parcelFuelPct ?? 25,
    parcelContractDiscountPct: config.parcelContractDiscountPct ?? 0,
    parcelServiceMix: config.parcelServiceMix || { ground: 100, threeDay: 0, twoDay: 0, overnight: 0 },
    parcelDimMultiplier: config.parcelDimMultiplier ?? 1.0,
    parcelAccessorialsPerPkg: config.parcelAccessorialsPerPkg ?? 0,
    parcelDiscountTiers: Array.isArray(config.parcelDiscountTiers) ? config.parcelDiscountTiers : [],
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
      truckCost: cogResult.truckCost || 0,
      parcelCost: cogResult.parcelCost || 0,
      restartsUsed: cogResult.numRestarts || 1,
    },
    // 2026-05-29 — parcel snapshot. NetOpt receives the parcel cost split,
    // total package count, zone distribution, and carrier so its UI can
    // honor what COG already solved instead of re-running zone math.
    parcelDetails: cogResult.parcelDetails || null,
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

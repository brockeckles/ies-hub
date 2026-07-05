/**
 * IES Hub v3 — Warehouse Sizing Calculator UI
 * Builder-pattern layout: config panel on left, capacity dashboard + visualizations on right.
 * Views: Dashboard / 2D Plan / Elevation / 3D. UX-2 Quick tier (2026-07-04)
 * shows Quick Size panel + Dashboard + 3D; Plan/Elevation are the IE bench
 * behind the Engineering toggle. 3D is the keeper (Brock) — beef-up thread open.
 *
 * @module tools/warehouse-sizing/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260705-u1a';
import { showToast } from '../../shared/toast.js?v=20260705-u1a';
import { renderToolChrome, refreshToolChrome, refreshToolChromeActions, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260705-u1a';
import * as calc from './calc.js?v=20260703-ux0';
import * as api from './api.js?v=20260703-dc2';
import * as cmApi from '../cost-model/api.js?v=20260704-cmp1';
import { renderCmDrillbackChip, bindCmDrillback } from '../../shared/cm-drillback.js?v=20260430-am-p5fix12';
import { showConfirm } from '../../shared/confirm-modal.js?v=20260705-u1a';
import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';
import { render3DView, disposeScene3d } from './ui-3d.js?v=20260705-u3b';
import { markDirty as guardMarkDirty, markClean as guardMarkClean } from '../../shared/unsaved-guard.js?v=20260703-p34';
import { renderConfigHtml, renderQuickConfigHtml, bindConfigEvents } from './ui-config.js?v=20260705-u3a';
import { renderPlan, drawPlan, hitCorner } from './ui-plan.js?v=20260705-u3d';
import { renderDashboard } from './ui-dashboard.js?v=20260705-u3a';
import { renderBasisView, resetBasisState } from './ui-basis.js?v=20260705-u3d';
import { pinWscFactors } from './factors-calc.js?v=20260704-n2a';
import { renderElevation, drawElevation, shuffledBayLevelOrder } from './ui-elevation.js?v=20260702-p1b';
import { pushToCm, handleCmPush, createDefaultFacility, createDefaultZones, createDefaultVolumes } from './ui-cm-bridge.js?v=20260702-p1b';
import { wscExtraStyles } from './ui-styles.js?v=20260705-u3a';
import { bindShellEvents } from './ui-shell-events.js?v=20260705-u3d';
import * as tierSvc from '../../shared/tier.js?v=20260704-ux2a';

// ============================================================
// CHROME v3 — phase + section structure (CM Chrome v3 ripple, step 3 redo)
// ============================================================
const WSC_GROUPS = [
  { key: 'design', label: 'Design', description: '4-view warehouse sizing canvas' },
];
const WSC_SECTIONS = [
  // N1 (2026-07-04) — Design Basis: data-first ingest + profiler, the first
  // slice of the WSC re-founding (North Star doc). Engineering tier only for
  // now; becomes the Quick tier's front door at N3 (media-selection pivot).
  { key: 'basis',     label: 'Design Basis',   group: 'design' },
  { key: 'dashboard', label: 'Dashboard',      group: 'design' },
  { key: 'plan',      label: '2D — Plan',      group: 'design' },
  { key: 'elevation', label: '2D — Elevation', group: 'design' },
  { key: '3d',        label: '3D View',        group: 'design' },
];

// UX-2 WSC Quick Size (2026-07-04) — consumer tier: Quick Size panel +
// Dashboard numbers + the 3D walkthrough (the keeper — design-process
// critical per Brock; enhancement thread open). Plan/Elevation = IE bench.
const WSC_QUICK_SECTIONS = WSC_SECTIONS.filter(s => s.key === 'dashboard' || s.key === '3d');
function _wscQuickChrome() { return tierSvc.getTier('wsc') === 'quick'; }

/** UX-2 — flip Quick ⇄ Engineering (CM/COG/MOST pattern; persists per
 *  user). Plan/Elevation are Engineering-only, so land on Dashboard when
 *  hiding them. */
function handleWscTierToggle() {
  const toQuick = !_wscQuickChrome();
  tierSvc.setTier('wsc', toQuick ? 'quick' : 'engineering');
  if (toQuick && (activeView === 'plan' || activeView === 'elevation' || activeView === 'basis')) activeView = 'dashboard';
  if (!rootEl) return;
  rootEl.innerHTML = renderShell();
  bindShellEvents(_makeShellEventsCtx());
  renderConfigPanel();
  renderContentView();
  _refreshWscKpis();
}

// ============================================================
// STATE
// ============================================================

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {'dashboard' | 'elevation' | '3d'} */
let activeView = 'dashboard';

/** @type {import('./types.js?v=20260418-sL').FacilityConfig} */
let facility = createDefaultFacility();

/** @type {import('./types.js?v=20260418-sL').ZoneConfig} */
let zones = createDefaultZones();

/** @type {import('./types.js?v=20260418-sL').VolumeInputs} */
let volumes = createDefaultVolumes();

/** N1 (2026-07-04) — DesignProfile from the Design Basis section (data or
 *  sparse mode). Persisted inside config_data.profile; null = no basis yet.
 *  @type {import('./types.js?v=20260418-sL').DesignProfile|null} */
let profile = null;

/** N2 (2026-07-04) — WSC factor catalog pinned to this scenario at first
 *  save (CM House-Assumptions governance). null = pins on next save.
 *  @type {{pinnedAt: string, rows: Object[]}|null} */
let pinnedFactors = null;

/** N3 (2026-07-04) — engineered media plan (media-calc.js), persisted when
 *  the analyst clicks Apply. null = design still on asserted/preset mix.
 *  @type {Object|null} */
let mediaPlan = null;

/** N4 (2026-07-04) — throughput-derived dynamics plan (dynamics-calc.js):
 *  docks, staging, MHE/aisles. Persisted on Apply.
 *  @type {Object|null} */
let dynamicsPlan = null;

/** N5 (2026-07-04) — layout synthesis + compliance plan (layout-calc.js):
 *  grid-fit, standards checklist, flow pattern. Persisted on Apply.
 *  @type {Object|null} */
let layoutPlan = null;

/** @type {boolean} */
let isDirty = false;

/** 2D-plan edit mode: when true, user can drag Office / Ship Staging / Forward Pick. */
let _wscDrawerOpen = true;
// Phase D (2026-05-05) — multi-angle Elevation view switcher.
// 'side' = building cross-section along the long edge (current/legacy behavior).
// 'shelving' = zoomed single shelving bay showing uprights + decks + cartons.
/** @type {'side' | 'shelving'} */
let _wscElevView = 'side';
let _planEditMode = false;
/** Rect registry populated each drawPlan() — keyed by zoneId → {x,y,w,h} in canvas px. */
let _planZoneRects = {};
/** Active drag state: { zoneId, startCanvasX, startCanvasY, origOverrideFt, pxPerFt, X0, Y0, Wpx, Hpx } */
let _planDrag = null;
// Phase A.A9 (2026-05-26) — live cursor position during a drag, in canvas px.
// Set by the drag pointermove handler in ui-shell-events.js so drawPlan can
// render a floating W × H callout near the cursor. Cleared on pointerup.
/** @type {{x:number, y:number}|null} */
let _planDragCursorPx = null;
// Phase A.A13 (2026-05-26) — id of the zone the cursor is currently
// hovering. Set by planHoverUpdate(), read by drawPlan's hover-outline
// pass. Lives at module scope so it survives the ctx rebuild between
// hover-handler runs.
/** @type {string|null} */
let _planHoveredZone = null;

/** @type {'landing' | 'editor'} — landing shows saved scenarios; editor is the design surface */
let viewMode = 'landing';

/**
 * 2026-05-12 — CM origin context.
 *
 * When WSC is launched from a Cost Model via "Size with Calculator", the CM
 * stamps `sessionStorage.wsc_origin_cm` with { cmId, cmName, at }. The mount
 * path reads it into `_originCm`; while truthy, the back button routes back
 * to `#designtools/cost-model` (label: "Back to <CM name>") instead of the
 * WSC scenarios landing. When no linked scenario is found for that CM and
 * the editor opens with a blank-seeded facility, `_seededFromCm` is set so
 * the editor body renders an amber banner "New scenario seeded from CM —
 * Save to link."
 *
 * @type {{ cmId: number|string|null, cmName: string, at: number }|null}
 */
let _originCm = null;
let _embedOpts = {};
let _seededFromCm = false;

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Warehouse Sizing Calculator.
 * @param {HTMLElement} el
 */
// 2026-06-10: unsubscriber for our cm:push-to-wsc bus handler (see unmount).
let _offCmPush = null;

export async function mount(el, opts = {}) {
  rootEl = el;
  // 2026-05-12 — `opts.embed` is set by shared/tool-slideover.js to
  // 'slideover' when WSC is mounted inside a CM-launched slide-over panel.
  // In that mode the chrome back-arrow closes the panel via the helper
  // instead of changing routes (which would yank the user out of CM).
  _embedOpts = opts && typeof opts === 'object' ? opts : {};
  // Reset the shell-bound flag + tool-chrome bound flag so subsequent
  // mount() calls (e.g., user returns to WSC after visiting another tool)
  // get a fresh set of listeners rather than reusing stale ones bound to
  // the previous mount's closures.
  if (el) { el.__wscShellBound = false; el.__tcBound = false; }
  activeView = 'dashboard';
  facility = createDefaultFacility();
  zones = createDefaultZones();
  volumes = createDefaultVolumes();
  viewMode = 'landing';

  // Listen for CM → WSC push — when CM asks to open a specific scenario,
  // jump straight to the editor with that config loaded.
  _offCmPush = bus.on('cm:push-to-wsc', async (data) => {
    viewMode = 'editor';
    // The earlier implementation assumed the editor shell already existed;
    // when this listener fires during a CM→WSC "Size with Calculator" click,
    // we're still on the landing view — openEditor builds the shell first,
    // then handleCmPush applies the payload values.
    openEditor(null);
    handleCmPush(data, _makeCmCtx());
  });

  // Brock 2026-04-20 — CM→WSC sessionStorage handoff (mirror of the
  // wsc_pending_push pattern the other direction). The bus.emit from CM's
  // launch-wsc fires BEFORE WSC mounts, so the event is lost; picking it
  // up from sessionStorage here is the reliable path.
  //
  // 2026-05-12 — Enhanced: also reads `wsc_origin_cm` (cmName/cmId/ts) and
  // looks up the most-recently-updated linked WSC scenario for that CM. If a
  // linked scenario exists, open it directly (so user lands on their prior
  // work, not a blank canvas). If none, open the editor blank-seeded from
  // the CM payload and set `_seededFromCm` so the body renders a banner.
  try {
    // Read origin marker first — it controls back-button label/routing
    // regardless of whether a linked scenario is found below.
    const originRaw = sessionStorage.getItem('wsc_origin_cm');
    if (originRaw) {
      try {
        const o = JSON.parse(originRaw);
        if (o && typeof o.at === 'number' && (Date.now() - o.at) < 60000) {
          _originCm = o;
        } else {
          sessionStorage.removeItem('wsc_origin_cm'); // stale
        }
      } catch { sessionStorage.removeItem('wsc_origin_cm'); }
    }

    const pending = sessionStorage.getItem('cm_pending_push');
    if (pending) {
      const payload = JSON.parse(pending);
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('cm_pending_push');
        viewMode = 'editor';

        // Look up the most-recently-updated linked WSC scenario for this CM.
        // If found, open it so the user sees their prior sizing work refreshed
        // with the latest CM volumes. If none, open blank-seeded and surface
        // a "New scenario" banner so the user knows their click started fresh.
        let linkedRow = null;
        const cmId = payload?.parent_cost_model_id;
        if (cmId != null) {
          try {
            const linked = await cmApi.listLinkedDesignScenarios(cmId);
            const mostRecent = linked?.wsc?.[0];
            if (mostRecent?.id != null) {
              linkedRow = await api.getConfig(mostRecent.id);
            }
          } catch (lookupErr) {
            console.warn('[WSC] linked-scenario lookup failed; opening blank:', lookupErr);
          }
        }

        if (linkedRow) {
          openEditor(linkedRow);
          // Refresh selected fields from the live CM payload so the linked
          // scenario reflects the current volumes/clearHeight/sqft.
          handleCmPush(payload, _makeCmCtx());
        } else {
          _seededFromCm = true;
          openEditor(null);
          handleCmPush(payload, _makeCmCtx());
        }
        return;
      }
      sessionStorage.removeItem('cm_pending_push'); // stale — discard
    }
  } catch (e) {
    console.warn('[WSC] Failed to consume CM push handoff:', e);
  }

  await renderLanding();
}

async function renderLanding() {
  if (!rootEl) return;
  await renderScenarioLanding(rootEl, {
    toolName: 'Warehouse Sizing',
    toolKey: 'wsc',
    accent: '#0047AB',
    list: () => api.listConfigs(),
    getId: (r) => r.id,
    getName: (r) => r.name || r.config_data?.name || 'Untitled facility',
    getUpdated: (r) => r.updated_at || r.created_at,
    getParent: (r) => ({ cmId: r.parent_cost_model_id, dealId: r.parent_deal_id }),
    getSubtitle: (r) => {
      const d = r.config_data || {};
      const sqft = d.totalSqft ? `${(d.totalSqft / 1000).toFixed(0)}K sf` : null;
      const city = d.city || d.state || d.name;
      return [sqft, city].filter(Boolean).join(' · ');
    },
    onNew: () => openEditor(null),
    onOpen: (row) => openEditor(row),
    onDelete: async (row) => { await api.deleteConfig(row.id); },
    onCopy: async (row) => {
      const clone = { ...row };
      delete clone.id; delete clone.created_at; delete clone.updated_at;
      clone.name = (clone.name || 'Facility') + ' (Copy)';
      await api.saveConfig(clone);
    },
    onLink: async (row, cmId) => { await api.linkToCm(row.id, cmId); },
    onUnlink: async (row) => { await api.unlinkFromCm(row.id); },
    emptyStateHint: 'Size a facility from peak pallets, SKU count, turn rate, and clearance height. Every scenario you save can be linked back to a cost model or deal.',
  });
}

/** Open the editor, optionally pre-loading a saved scenario. */
function openEditor(savedRow) {
  if (!rootEl) return;
  viewMode = 'editor';
  if (savedRow) {
    const data = savedRow.config_data || savedRow;
    facility = { ...createDefaultFacility(), ...data, id: savedRow.id, parent_cost_model_id: savedRow.parent_cost_model_id || null };
    profile = data.profile || null;   // N1 — design basis rides config_data
    pinnedFactors = data.pinnedFactors || null;  // N2 — legacy scenarios pin on next save
    mediaPlan = data.mediaPlan || null;           // N3 — engineered media plan
    dynamicsPlan = data.dynamicsPlan || null;     // N4 — dynamics plan
    layoutPlan = data.layoutPlan || null;         // N5 — layout/compliance plan
    resetBasisState();
    zones = { ...createDefaultZones(), ...(data.zones || {}) };
    volumes = { ...createDefaultVolumes(), ...(data.volumes || {}) };
    // Phase A migration (2026-05-05): if a legacy facility has buildingDimsOverride
    // engaged (= user typed in W/D explicitly), migrate it to constraint mode so
    // the rendering keeps using the user's dims. Facilities saved without the
    // override stay in design mode (the default).
    if (!data.sizingMode && facility.buildingDimsOverride) {
      facility.sizingMode = 'constraint';
    }
  } else {
    facility = createDefaultFacility();
    profile = null;                   // N1 — fresh scenario, no basis yet
    pinnedFactors = null;             // N2 — pins at first save
    mediaPlan = null;                 // N3 — no engineered plan yet
    dynamicsPlan = null;              // N4 — no dynamics plan yet
    layoutPlan = null;                // N5 — no layout plan yet
    resetBasisState();
    zones = createDefaultZones();
    volumes = createDefaultVolumes();
  }
  rootEl.innerHTML = renderShell();
  bindShellEvents(_makeShellEventsCtx());
  renderConfigPanel();
  renderContentView();
  _refreshWscKpis();
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  // 2026-06-10 (assessment WSC #8): bus.clear() nuked ALL subscribers to the
  // event globally; unsubscribe only our own handler.
  if (typeof _offCmPush === 'function') { _offCmPush(); _offCmPush = null; }
  disposeScene3d();
  rootEl = null;
  _embedOpts = {};
}

// ============================================================
// SHELL
// ============================================================

function renderWscPhaseStepper() {
  // CM Chrome v3 ripple — in-canvas phase stepper dropped. Top-ribbon Row 1
  // section pills convey view context. Stub kept so existing call sites
  // don't crash.
  return;
}

function renderShell() {
  // CM Chrome v3 ripple — chrome HTML+CSS lives in shared/tool-chrome.js.
  return renderToolChrome(_buildWscChromeOpts()) + wscExtraStyles();
}

/** Build chrome opts from current WSC state. */
/** Mark the doc dirty and refresh chrome on the clean→dirty transition so the
 *  save chip flips "Saved" → "Modified" in real time. Pre-fix: every isDirty=true
 *  site only re-rendered KPIs / content / config — the chrome (where the chip
 *  lives) stayed stale until a section change or save. */
/** P3-3 (2026-07-03): all dirty-clears route through here so the hub-level
 *  unsaved-guard (hash-nav / tab-close prompt) stays in sync. */
function _clearDirty() { isDirty = false; guardMarkClean('wsc'); }

function _markDirty() {
  const wasClean = !isDirty;
  isDirty = true;
  guardMarkDirty('wsc');
  // Refresh ONLY the actions rail (save chip + buttons) — full refreshToolChrome
  // re-renders the sidebar mid-keystroke and destroys input focus (the
  // CM-INPUT-FOCUS-LOSS class of bug). The actions rail has no inputs.
  if (wasClean && facility.id && rootEl) {
    refreshToolChromeActions(rootEl, _buildWscChromeOpts());
  }
}

function _buildWscChromeOpts() {
  const draft = !facility.id;
  const modified = !!facility.id && isDirty;
  const stateName = draft ? 'draft' : (modified ? 'modified' : 'saved');
  const stateTitle = draft
    ? 'Brand-new design — Save to capture an audit timestamp'
    : (modified ? 'Save to capture the latest changes' : 'Saved');

  const _quick = _wscQuickChrome();
  const actions = [
    { id: 'wsc-tier',
      label: _quick ? 'Engineering' : 'Quick',
      title: _quick ? 'Switch to Engineering mode — full stepped Configure panel + 2D Plan/Elevation IE bench'
                    : 'Switch to Quick mode — five inputs, Dashboard + 3D' },
    { id: 'wsc-save',
      label: facility.id ? 'Save' : 'Save Design',
      title: facility.id ? 'Update this design' : 'Save this design so you can reopen it later',
      primary: modified },
    { id: 'push-to-cm',
      label: 'Use in Cost Model →',
      kind: 'primary',
      icon: '⇨',
      title: 'Push this design into a Cost Model (Cmd/Ctrl+Enter)' },
  ];

  const sidebarFooter = facility.parent_cost_model_id
    ? 'Linked to Cost Model #' + facility.parent_cost_model_id
    : '';

  return {
    toolKey: 'wsc',
    groups: WSC_GROUPS,
    sections: _quick ? WSC_QUICK_SECTIONS : WSC_SECTIONS,
    activePhase: 'design',
    activeSection: activeView,
    sectionCompleteness: () => 'complete',
    saveState: { state: stateName, title: stateTitle },
    actions,
    showSidebar: _wscDrawerOpen,
    sidebarHeader: _quick ? 'Quick Size' : 'Configure',
    sidebarBody: '<div id="wsc-config">' + (_quick ? renderQuickConfigHtml : renderConfigHtml)(_makeConfigCtx()) + '</div>',
    sidebarFooter,
    // Drawer-toggle pill — labeled, sits at the start of Row 2 so it's
    // discoverable next to the section pills (instead of relying on the
    // generic ☰ icon way over in Row 1).
    row2Prefix: (
      '<button class="tc-row2-toggle' + (_wscDrawerOpen ? ' tc-row2-toggle--active' : '') + '" data-tc-sidebar="toggle" title="' +
      (_wscDrawerOpen ? 'Hide configure panel' : 'Show configure panel') + '">' +
      '<span class="tc-row2-toggle__icon">⚙</span>' +
      '<span>' + (_wscDrawerOpen ? 'Hide Configure' : 'Configure') + '</span>' +
      '</button>' +
      '<div class="tc-row2-divider"></div>'
    ),
    bodyHtml: (
      // 2026-05-12 — When the editor was seeded from a CM with no prior linked
      // scenario, render a dismissible amber banner above the content area so
      // the user knows their click started a new scenario (vs. resumed an
      // existing one). Clicking the X clears `_seededFromCm` and re-renders.
      (_seededFromCm && _originCm
        ? '<div id="wsc-cm-banner" style="display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fef3c7;border-bottom:1px solid #f59e0b;font-size:13px;color:#78350f;flex-shrink:0;">'
          + '<span style="font-size:16px;">✨</span>'
          + '<span><strong>New scenario</strong> seeded from Cost Model: <strong>'
          + escapeHtml(_originCm.cmName || 'Cost Model')
          + '</strong> — Save to link this scenario back to the CM.</span>'
          + '<button data-wsc-cm-banner-dismiss type="button" style="margin-left:auto;background:none;border:none;color:#78350f;cursor:pointer;font-size:18px;padding:0 4px;line-height:1;" title="Dismiss">×</button>'
          + '</div>'
        : ''
      )
      + '<div id="wsc-content" style="overflow-y:auto;padding:24px;flex:1;min-height:0;"></div>'
    ),
    backTitle: _originCm ? ('Back to ' + (_originCm.cmName || 'Cost Model')) : 'Back to scenarios',
  };
}

/** Compute KPI strip values for the WSC chrome.
 *  Real-time math from calc.computeStorage(facility, zones) — not stored
 *  on facility.* (an early version of this function tried that and got
 *  empty values because storage size is computed, not configured). */
/** Refresh KPI strip from current WSC state. Cheap to call. KPI compute
 *  lives in calc.computeWscKpis — extracted 2026-05-14 (autonomous session). */
function _refreshWscKpis() {
  if (!rootEl) return;
  refreshKpiStrip(rootEl, calc.computeWscKpis({ facility, zones, volumes }));
}

/** WSC-specific styles — the Configure-panel inputs were rendering with
 *  browser-default <input>/<select> styling (heavy black borders) which
 *  clashed with the hub's lighter aesthetic. This stylesheet makes them
 *  match hub-input + cm-form-label patterns. */

/**
 * Build the ctx payload that ui-shell-events.js consumes. Live getters preserve
 * outer-scope-read semantics for state that mutates between event binding (mount
 * time, idempotent) and event firing (later, possibly after multiple section
 * changes). Setters write back to the closure-private `let` bindings so the
 * extracted handlers can flip activeView, isDirty, viewMode, etc.
 */
function _makeShellEventsCtx() {
  return {
    rootEl,
    WSC_SECTIONS,
    // Live object refs — mutated in place (no setter needed)
    get facility() { return facility; },
    get zones() { return zones; },
    // Read-only refs
    get _embedOpts() { return _embedOpts; },
    get _planMeta() { return _planMeta; },
    get _planZoneRects() { return _planZoneRects; },
    // Primitive state — get/set
    get activeView() { return activeView; },
    set activeView(v) { activeView = v; },
    get _wscDrawerOpen() { return _wscDrawerOpen; },
    set _wscDrawerOpen(v) { _wscDrawerOpen = v; },
    get isDirty() { return isDirty; },
    set isDirty(v) { if (v) _markDirty(); else _clearDirty(); },
    get _originCm() { return _originCm; },
    set _originCm(v) { _originCm = v; },
    get _seededFromCm() { return _seededFromCm; },
    set _seededFromCm(v) { _seededFromCm = v; },
    get viewMode() { return viewMode; },
    set viewMode(v) { viewMode = v; },
    get _wscElevView() { return _wscElevView; },
    set _wscElevView(v) { _wscElevView = v; },
    get _planEditMode() { return _planEditMode; },
    set _planEditMode(v) { _planEditMode = v; },
    get _planDrag() { return _planDrag; },
    set _planDrag(v) { _planDrag = v; },
    get _planDragCursorPx() { return _planDragCursorPx; },
    set _planDragCursorPx(v) { _planDragCursorPx = v; },
    // Local renderer + helper refs
    renderShell,
    renderConfigPanel,
    renderContentView,
    refreshWscKpis: _refreshWscKpis,
    buildWscChromeOpts: _buildWscChromeOpts,
    makeCmCtx: _makeCmCtx,
    makePlanCtx: _makePlanCtx,
    handleSaveWsc,
    handleWscTierToggle,
    renderLanding,
    markDirty: _markDirty,
    canvasMouseCoords,
  };
}

/**
 * Canvas mouse coord helper — converts a pointer event into canvas-space px
 * (accounting for CSS scaling between the canvas's intrinsic width=900 and
 * the rendered width).
 */
function canvasMouseCoords(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    offsetX: (evt.clientX - rect.left) * scaleX,
    offsetY: (evt.clientY - rect.top)  * scaleY,
  };
}

// ============================================================
// CONFIG PANEL (LEFT SIDEBAR)
// ============================================================

/**
 * Debounce helper: delays execution until ms has passed without new calls.
 * @param {Function} fn
 * @param {number} [ms=100]
 * @returns {Function}
 */
function debounceRender(fn, ms = 100) {
  let timeoutId = null;
  return function debounced(...args) {
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, ms);
  };
}

/** Save the current design — extracted so the chrome's onAction handler can dispatch. */
async function handleSaveWsc() {
  try {
    // N2 — pin the org factor catalog at first save (CM House-Assumptions
    // pattern). Best-effort: an unreachable catalog never blocks a save.
    if (!pinnedFactors) {
      try {
        const live = await api.fetchWscFactors();
        if (live.length > 0) pinnedFactors = pinWscFactors(live);
      } catch (_) { /* pin on a later save instead */ }
    }
    const saved = await api.saveConfig({ ...facility, zones, volumes, profile, pinnedFactors, mediaPlan, dynamicsPlan, layoutPlan });
    facility.id = saved.id || saved[0]?.id || facility.id;
    _clearDirty();
    showToast(`Saved "${facility.name || 'Untitled'}"`, 'success');
    refreshToolChrome(rootEl, _buildWscChromeOpts());
    _refreshWscKpis();

    // ── Phase 4 of WSC redesign (2026-05-04) — WSC → CM writeback ──
    // When this scenario is linked to a parent cost model, push the sized
    // output back into the CM's project_data under `linkedWscFacts` so the
    // CM can surface "WSC says X SF / Y dock doors / Z shelving locations"
    // without re-running the WSC engine. Best-effort: if the writeback
    // fails (e.g., CM was deleted, RLS blocks), the WSC save still succeeded
    // and we just toast a non-blocking warning.
    if (facility.parent_cost_model_id) {
      try {
        const sized = calc.sizeFacility(toSizingInputs());
        const wscFacts = {
          scenarioId: facility.id,
          scenarioName: facility.name || 'Untitled',
          totalSf:    sized.totalSqft     || 0,
          requiredSf: sized.requirementsDriven?.totalSfRequired || 0,
          suggestedDims: {
            longFt:  sized.requirementsDriven?.suggestedLongFt  || 0,
            shortFt: sized.requirementsDriven?.suggestedShortFt || 0,
          },
          dock: {
            totalDoors:    sized.dock?.totalDoors    || 0,
            inboundDoors:  sized.dock?.inboundDoors  || 0,
            outboundDoors: sized.dock?.outboundDoors || 0,
            sfRequired:    sized.dockRequirement?.dockSfRequired || 0,
          },
          positions: {
            fullPallet:     sized.positions?.fullPalletPositions   || 0,
            cartonOnPallet: sized.positions?.cartonPalletPositions || 0,
            grossPositions: sized.positions?.grossPositions        || 0,
          },
          shelving: {
            locationsRequired: sized.locations?.shelving?.locationsRequired || 0,
            mode:              sized.locations?.shelving?.mode              || 'tie',
            demandLocations:   sized.locations?.shelving?.demandLocations   || 0,
            skuMinLocations:   sized.locations?.shelving?.skuMinLocations   || 0,
          },
          unitLoad: sized.unitLoad ? {
            palletType:        sized.unitLoad.palletType,
            bayWidthFt:        sized.unitLoad.bayWidthFt,
            palletLevelHeightFt: sized.unitLoad.palletLevelHeightFt,
          } : null,
          cartonProfile: sized.cartonProfile ? {
            cartonsPerPallet: sized.cartonProfile.cartonsPerPallet,
            cartonsPerShelf:  sized.cartonProfile.cartonsPerShelf,
            orientation:      sized.cartonProfile.orientation,
          } : null,
          buildingDims: {
            width:    facility.buildingWidth  || 0,
            depth:    facility.buildingDepth  || 0,
            override: !!facility.buildingDimsOverride,
          },
        };
        await cmApi.applyWscWriteback(facility.parent_cost_model_id, wscFacts);
        showToast(`WSC facts written to Cost Model #${facility.parent_cost_model_id}`, 'info');
      } catch (writebackErr) {
        console.warn('[WSC] CM writeback failed (non-blocking):', writebackErr);
        showToast('WSC saved, but CM writeback failed — see console.', 'warning');
      }
    }
  } catch (err) {
    console.error('[WSC] Save failed:', err);
    showToast('Save failed: ' + (err.message || err), 'error');
  }
}

function renderConfigPanel() {
  // CM Chrome v3 ripple — the WSC config panel now lives inside the chrome's
  // collapsible left drawer. The tier picks the panel: Quick Size (5
  // inputs) vs the full stepped Configure (ui-config.js).
  // the HTML; this function targets whichever element holds it (id=wsc-config
  // wrapper inside the chrome's .tc-sidebar__body) and binds the events.
  const panel = rootEl?.querySelector('#wsc-config');
  if (!panel) return;
  const ctx = _makeConfigCtx();
  panel.innerHTML = (_wscQuickChrome() ? renderQuickConfigHtml : renderConfigHtml)(ctx);
  bindConfigEvents(panel, ctx);
}

/** Build the ctx payload that ui-config.js consumes. Getters keep state reads
 *  LIVE (matches outer-scope-read semantics for state that may mutate between
 *  render + later handler firing). Setters & helpers route through ui.js so the
 *  config module can stay state-mutation-free. */
function _makeConfigCtx() {
  return {
    get facility() { return facility; },
    get zones() { return zones; },
    get volumes() { return volumes; },
    get viewMode() { return viewMode; },
    get isDirty() { return isDirty; },
    rootEl,
    setDirty(v) { if (v) _markDirty(); else { _clearDirty(); } },
    resetState() {
      facility = createDefaultFacility();
      zones = createDefaultZones();
      volumes = createDefaultVolumes();
      _clearDirty();
    },
    refreshKpis: _refreshWscKpis,
    refreshContent: renderContentView,
    refreshConfig: renderConfigPanel,
    refreshLanding: renderLanding,
    copySummary: copySummaryToClipboard,
    toSizingInputs,
    debounceRender,
    handleCmPush: (p) => handleCmPush(p, _makeCmCtx()),
    handleSaveWsc,
    createDefaultFacility,
    createDefaultZones,
    createDefaultVolumes,
  };
}

/** Build the ctx payload that ui-plan.js consumes. Live getters preserve
 *  outer-scope-read semantics for state that may mutate between render and
 *  deferred drag handlers. */
function _makePlanCtx() {
  return {
    get facility() { return facility; },
    get zones() { return zones; },
    get volumes() { return volumes; },
    get rootEl() { return rootEl; },
    get _planEditMode() { return _planEditMode; },
    get _planZoneRects() { return _planZoneRects; },
    resetPlanZoneRects() { _planZoneRects = {}; },
    get _planMeta() { return _planMeta; },
    set _planMeta(v) { _planMeta = v; },
    // Phase A.A9 — drag state read by drawPlan to render a live W × H
    // dimension callout near the cursor during a move/resize.
    get _planDrag() { return _planDrag; },
    get _planDragCursorPx() { return _planDragCursorPx; },
    // Phase A.A10/A11/A13 — hovered-zone state, set by planHoverUpdate
    // and read by drawPlan's hover-outline pass.
    get _planHoveredZone() { return _planHoveredZone; },
    set _planHoveredZone(v) { _planHoveredZone = v; },
    renderFacility: _renderFacility,
    toSizingInputs,
    canvasMouseCoords,
    drawDimH,
    drawDimV,
  };
}

/** Build the ctx payload that ui-dashboard.js consumes. Read-only. */
function _makeDashboardCtx() {
  return {
    get facility() { return facility; },
    get zones() { return zones; },
    get volumes() { return volumes; },
    renderFacility: _renderFacility,
    toSizingInputs,
  };
}

/** Build the ctx payload that ui-cm-bridge.js consumes. State mutates via
 *  property writes (live through getters); reassignments not used here. */
function _makeCmCtx() {
  return {
    get facility() { return facility; },
    get zones() { return zones; },
    get volumes() { return volumes; },
    toSizingInputs,
    refreshKpis: _refreshWscKpis,
    refreshConfig: renderConfigPanel,
    refreshContent: renderContentView,
  };
}

/** Build the ctx payload that ui-elevation.js consumes. Read-only. */
function _makeElevationCtx() {
  return {
    get facility() { return facility; },
    get zones() { return zones; },
    get volumes() { return volumes; },
    get rootEl() { return rootEl; },
    get _wscElevView() { return _wscElevView; },
    renderFacility: _renderFacility,
    toSizingInputs,
    drawDimH,
    drawDimV,
  };
}

/** Build the WSC config-panel HTML. Phase 2 redesign (2026-05-04) — restructured
 *  into a 5-step IE-correct flow: Volume → Unit Load → Carton → Storage Allocation
 *  → Derived Facility. Pre-Phase-2 the panel mixed building dims, pallet dims,
 *  volumes, allocation, and derived outputs in a flat list; user could configure
 *  dock doors before the engine knew the volume profile. New flow runs critical
 *  path top-to-bottom: demand drives unit load drives storage strategy drives
 *  footprint. Building dims become a derived output with an Override toggle for
 *  fixed-site scenarios. */
/**
 * Phase A (2026-05-05): mode-aware facility shape for renderers.
 *
 * In Design mode, renderers should draw the engine's sized footprint exactly
 * (no empty-building visual). orientFacility() and elevationParams() resolve
 * dims via facility.buildingWidth/buildingDepth → totalSqft fallback. In design
 * mode we may have stale/leftover user W/D from a prior session; this helper
 * synthesizes a facility shape with buildingWidth/Depth set to the suggested
 * footprint so renderers consume the IE-correct dims regardless.
 *
 * In Constraint mode, returns facility as-is — user W/D is the constraint and
 * orientFacility consumes them directly.
 *
 * @param {*} facility
 * @param {*} sized — output of calc.sizeFacility(toSizingInputs())
 * @returns {*} facility shape suitable for renderer consumption
 */
function _renderFacility(facility, sized) {
  const mode = facility?.sizingMode || 'design';
  if (mode !== 'design') return facility;
  const r = sized?.requirementsDriven;
  if (!r || !(r.suggestedLongFt > 0) || !(r.suggestedShortFt > 0)) return facility;
  return { ...facility, buildingWidth: r.suggestedLongFt, buildingDepth: r.suggestedShortFt };
}

/** True when the user has entered enough volume data to compute a meaningful SF recommendation. */
function hasMeaningfulVolumes(v) {
  if (!v) return false;
  const pallets = v.totalPallets || 0;
  const skus = v.totalSKUs || 0;
  const daily = (v.avgDailyInbound || 0) + (v.avgDailyOutbound || 0);
  return pallets > 0 || skus > 0 || daily > 0;
}

/** Non-blocking success/error toast (bottom-right, 4s). */
/**
 * Vertical quick-start presets — adjust facility scale, storage allocation,
 * and dock config to a typical baseline for the chosen vertical. Users can
 * still tune any field after applying.
 * @param {string} preset
 */
/** Copy an English summary of the current config to the clipboard. */
function copySummaryToClipboard() {
  const dock = zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const totalDoors = dock.inboundDoors + dock.outboundDoors;
  const summary = [
    `Warehouse Sizing — ${facility.name || 'Untitled'}`,
    `Total SF: ${facility.totalSqft.toLocaleString()}`,
    `Building: ${facility.buildingWidth} × ${facility.buildingDepth} ft, clear ${facility.clearHeight} ft`,
    `Storage: ${facility.storageType}, aisle ${facility.aisleWidth || ''} ft`,
    `Dock: ${dock.inboundDoors} inbound + ${dock.outboundDoors} outbound = ${totalDoors} doors`,
    `Storage Allocation: ${zones.storageAllocation?.fullPallet || 0}% pallet · ${zones.storageAllocation?.cartonOnPallet || 0}% carton-on-pallet · ${zones.storageAllocation?.cartonOnShelving || 0}% carton-on-shelving`,
    `Volumes: peak ${(zones.peakUnitsPerDay || 0).toLocaleString()}/day · avg ${(zones.avgUnitsPerDay || 0).toLocaleString()}/day`,
  ].join('\n');
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(summary).then(
      () => showToast('Summary copied to clipboard', 'success'),
      () => showToast('Clipboard write failed', 'error'),
    );
  } else {
    showToast('Clipboard not available', 'error');
  }
}

// ============================================================
// CONTENT VIEW RENDERING
// ============================================================

function renderContentView() {
  const container = rootEl?.querySelector('#wsc-content');
  if (!container) return;
  // 2026-04-28 — keep phase stepper status in sync with activeView.
  renderWscPhaseStepper();

  // Clean up 3D scene if switching away
  if (activeView !== '3d') {
    disposeScene3d();
  }

  switch (activeView) {
    case 'basis': renderBasisView(container, {
      getProfile: () => profile,
      setProfile: (p) => { profile = p; _markDirty(); },
      // N2 — factor pinning (drift badge + explicit adopt)
      getPinnedFactors: () => pinnedFactors,
      adoptFactors: (live) => { pinnedFactors = pinWscFactors(live); _markDirty(); },
      fetchFactors: () => api.fetchWscFactors(),
      // N3 — engineered media plan: Apply persists the plan AND flips the
      // design's storage mix from asserted to derived (mix stays editable —
      // Configure still owns the field; this just changes its default).
      getMediaPlan: () => mediaPlan,
      applyMediaPlan: (plan) => {
        mediaPlan = plan;
        if (plan?.allocation) {
          zones.storageAllocation = {
            fullPallet: plan.allocation.fullPallet,
            cartonOnPallet: plan.allocation.cartonOnPallet,
            cartonOnShelving: plan.allocation.cartonOnShelving,
          };
        }
        _markDirty();
        renderConfigPanel();   // Configure shows the new mix immediately
        _refreshWscKpis();
      },
      // N4 — dynamics plan: Apply derives dock doors, staging SF, and the
      // governing storage aisle from throughput + the media plan.
      getDynamicsPlan: () => dynamicsPlan,
      getVolumes: () => volumes,
      getFacility: () => facility,
      getZones: () => zones,
      applyDynamicsPlan: (plan) => {
        dynamicsPlan = plan;
        if (plan?.docks) {
          zones.dockConfig = {
            ...(zones.dockConfig || {}),
            sided: (zones.dockConfig && zones.dockConfig.sided) || 'two',
            inboundDoors: plan.docks.inbound.doors,
            outboundDoors: plan.docks.outbound.doors,
          };
        }
        if (plan?.staging) {
          zones.receiveStagingSqft = plan.staging.inbound.sqft;
          zones.shipStagingSqft = plan.staging.outbound.sqft;
        }
        if (plan?.mhe?.governingAisleFt > 0) facility.aisleWidth = plan.mhe.governingAisleFt;
        _markDirty();
        renderConfigPanel();
        _refreshWscKpis();
      },
      // N5 — layout/compliance plan: Apply writes the recommended grid and
      // conservatively raises flue space to the governing standard's minimum.
      getLayoutPlan: () => layoutPlan,
      // N6 — sized snapshot for the Design Basis doc's reconciliation table.
      computeSized: () => { try { return calc.sizeFacility(toSizingInputs()); } catch (_) { return null; } },
      applyLayoutPlan: (plan) => {
        layoutPlan = plan;
        if (plan?.gridFit?.recommended?.spanFt > 0 && plan.gridFit.recommended.spanFt !== plan.gridFit.spanXFt) {
          facility.columnSpacingX = plan.gridFit.recommended.spanFt;
        }
        const flueMin = plan?.flueStandard === 'NFPA' ? 6 : 3;
        facility.flueSpace = Math.max(Number(facility.flueSpace) || 0, flueMin);
        _markDirty();
        renderConfigPanel();
        _refreshWscKpis();
      },
      rerender: renderContentView,
      toast: showToast,
    }); break;
    case 'dashboard': container.innerHTML = renderDashboard(_makeDashboardCtx()); break;
    case 'plan':
      container.innerHTML = renderPlan(_makePlanCtx());
      requestAnimationFrame(() => drawPlan(_makePlanCtx()));
      break;
    case 'elevation':
      container.innerHTML = renderElevation(_makeElevationCtx());
      requestAnimationFrame(() => drawElevation(_makeElevationCtx()));
      break;
    case '3d': render3DView(container, {
      get facility() { return facility; },
      get zones() { return zones; },
      get volumes() { return volumes; },
      rootEl,
      toSizingInputs,
      renderFacility: _renderFacility,
      shuffledBayLevelOrder,
      // N7 — the 3D scene renders the ENGINEERED design when plans exist:
      // media plan → per-family rack runs, dynamics plan → aisles/staging.
      getMediaPlan: () => mediaPlan,
      getDynamicsPlan: () => dynamicsPlan,
    }); break;
  }
}

/** Canvas geometry stash used by drag handlers to convert mouse → feet. */
let _planMeta = null;

/**
 * Convert the UI's (facility, zones, volumes) state into SizingInputs for
 * the calc.sizeFacility engine. Thin wrapper over the pure transform
 * `calc.formStateToInputs` — the wrapper preserves closure-scope access to
 * the WSC ui.js state vars (`facility`, `zones`, `volumes`) so the 11
 * existing call sites and the five `_make*Ctx()` factories that hand the
 * function off to by-view modules need no edits.
 *
 * Extraction 2026-05-14 (autonomous session). Body moved verbatim into
 * calc.js so it can be unit-tested directly and so ui.js drops below 1K LOC.
 *
 * @returns {import('./calc.js?v=20260703-ux0').SizingInputs}
 */
function toSizingInputs() {
  return calc.formStateToInputs({ facility, zones, volumes });
}

// ============================================================
// ELEVATION VIEW (Canvas 2D)
// ============================================================


function drawDimV(ctx, x, y1, y2, label) {
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, y1); ctx.lineTo(x + 4, y1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, y2); ctx.lineTo(x + 4, y2); ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.font = '10px Montserrat';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 8, (y1 + y2) / 2 + 4);
}

function drawDimH(ctx, x1, x2, y, label) {
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x2, y - 4); ctx.lineTo(x2, y + 4); ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.font = '10px Montserrat';
  ctx.textAlign = 'center';
  ctx.fillText(label, (x1 + x2) / 2, y - 8);
}



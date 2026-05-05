/**
 * IES Hub v3 — Warehouse Sizing Calculator UI
 * Builder-pattern layout: config panel on left, capacity dashboard + visualizations on right.
 * 3-way view toggle: Dashboard / Elevation / 3D.
 *
 * @module tools/warehouse-sizing/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import { state } from '../../shared/state.js?v=20260418-sL';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sL';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260430-na-dot';
import * as calc from './calc.js?v=20260504-phase2';
import * as api from './api.js?v=20260418-sL';
import * as cmApi from '../cost-model/api.js?v=20260504-auth1';
import { renderCmDrillbackChip, bindCmDrillback } from '../../shared/cm-drillback.js?v=20260430-am-p5fix12';
import { showConfirm } from '../../shared/confirm-modal.js';

// ============================================================
// CHROME v3 — phase + section structure (CM Chrome v3 ripple, step 3 redo)
// ============================================================
const WSC_GROUPS = [
  { key: 'design', label: 'Design', description: '4-view warehouse sizing canvas' },
];
const WSC_SECTIONS = [
  { key: 'dashboard', label: 'Dashboard',      group: 'design' },
  { key: 'plan',      label: '2D — Plan',      group: 'design' },
  { key: 'elevation', label: '2D — Elevation', group: 'design' },
  { key: '3d',        label: '3D View',        group: 'design' },
];


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

/** @type {boolean} */
let isDirty = false;

/** @type {{ dispose?: () => void } | null} */
let scene3d = null;

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

/** @type {'landing' | 'editor'} — landing shows saved scenarios; editor is the design surface */
let viewMode = 'landing';

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Warehouse Sizing Calculator.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
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
  bus.on('cm:push-to-wsc', async (data) => {
    viewMode = 'editor';
    // The earlier implementation assumed the editor shell already existed;
    // when this listener fires during a CM→WSC "Size with Calculator" click,
    // we're still on the landing view — openEditor builds the shell first,
    // then handleCmPush applies the payload values.
    openEditor(null);
    handleCmPush(data);
  });

  // Brock 2026-04-20 — CM→WSC sessionStorage handoff (mirror of the
  // wsc_pending_push pattern the other direction). The bus.emit from CM's
  // launch-wsc fires BEFORE WSC mounts, so the event is lost; picking it
  // up from sessionStorage here is the reliable path.
  try {
    const pending = sessionStorage.getItem('cm_pending_push');
    if (pending) {
      const payload = JSON.parse(pending);
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('cm_pending_push');
        viewMode = 'editor';
        openEditor(null);
        handleCmPush(payload);
        bus.emit('wsc:mounted');
        return;
      }
      sessionStorage.removeItem('cm_pending_push'); // stale — discard
    }
  } catch (e) {
    console.warn('[WSC] Failed to consume CM push handoff:', e);
  }

  await renderLanding();
  bus.emit('wsc:mounted');
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
    zones = createDefaultZones();
    volumes = createDefaultVolumes();
  }
  rootEl.innerHTML = renderShell();
  bindShellEvents();
  renderConfigPanel();
  renderContentView();
  _refreshWscKpis();
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  bus.clear('cm:push-to-wsc');
  if (scene3d?.dispose) scene3d.dispose();
  scene3d = null;
  rootEl = null;
  bus.emit('wsc:unmounted');
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
  return renderToolChrome(_buildWscChromeOpts()) + _wscExtraStyles();
}

/** Build chrome opts from current WSC state. */
function _buildWscChromeOpts() {
  const draft = !facility.id;
  const modified = !!facility.id && isDirty;
  const stateName = draft ? 'draft' : (modified ? 'modified' : 'saved');
  const stateTitle = draft
    ? 'Brand-new design — Save to capture an audit timestamp'
    : (modified ? 'Save to capture the latest changes' : 'Saved');

  const actions = [
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
    sections: WSC_SECTIONS,
    activePhase: 'design',
    activeSection: activeView,
    sectionCompleteness: () => 'complete',
    saveState: { state: stateName, title: stateTitle },
    actions,
    showSidebar: _wscDrawerOpen,
    sidebarHeader: 'Configure',
    sidebarBody: '<div id="wsc-config">' + _renderWscConfigHtml() + '</div>',
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
    bodyHtml: '<div id="wsc-content" style="overflow-y:auto;padding:24px;height:100%;"></div>',
    backTitle: 'Back to scenarios',
  };
}

/** Compute KPI strip values for the WSC chrome.
 *  Real-time math from calc.computeStorage(facility, zones) — not stored
 *  on facility.* (an early version of this function tried that and got
 *  empty values because storage size is computed, not configured). */
function _computeWscKpis() {
  const items = [];
  // Total SF — Phase D (2026-05-05) mode-aware. In Design mode, the engine's
  // sized output IS the answer (no user-entered W/D); in Constraint mode,
  // user-entered W×D is the constraint and the chip should show that. Pre-D,
  // this read facility.buildingWidth × buildingDepth even in Design mode,
  // showing stale user-entered dims that disagree with the rendered footprint.
  let sized = null;
  try { sized = calc.sizeFacility(toSizingInputs()); } catch {}
  const mode = facility?.sizingMode || 'design';
  const w = +facility?.buildingWidth || 0;
  const d = +facility?.buildingDepth || 0;
  const userBuiltSf = (w > 0 && d > 0) ? (w * d) : 0;
  const sizedSf = sized?.totalSqft || 0;
  const totalSf = mode === 'constraint'
    ? (userBuiltSf > 0 ? userBuiltSf : sizedSf)
    : sizedSf;
  items.push({
    label: mode === 'constraint' ? 'Built SF' : 'Sized SF',
    value: totalSf > 0 ? (totalSf / 1000).toFixed(0) + 'K' : '—',
    hint: mode === 'constraint'
      ? `Existing-building footprint (${w} × ${d} ft).`
      : 'Engine-sized facility footprint (sum of storage + dock + zones + circulation).',
  });
  // Dock Doors — zones.dockConfig (NOT facility.*).
  const inb = zones?.dockConfig?.inboundDoors || 0;
  const out = zones?.dockConfig?.outboundDoors || 0;
  items.push({
    label: 'Dock Doors',
    value: (inb + out) > 0 ? String(inb + out) : '—',
    hint: `${inb} inbound + ${out} outbound`,
  });
  // Rack Positions — use sized engine (grossPositions = honeycomb + surge
  // applied) so the chrome strip agrees with the Dashboard breakdown and
  // the 3D HUD. Falls back to computeStorage geometric capacity only when
  // the sizing engine has nothing to size against.
  let rackPos = 0;
  let utilPct = null;
  try {
    const sized = calc.sizeFacility(toSizingInputs());
    rackPos = sized?.positions?.grossPositions || 0;
    utilPct = sized?.utilization?.utilizationPct ?? null;
    if (rackPos === 0) {
      const storage = calc.computeStorage(facility, zones);
      rackPos = storage.totalPalletPositions || 0;
    }
  } catch (_) {}
  items.push({
    label: 'Rack Positions',
    value: rackPos > 0 ? (rackPos >= 1000 ? (rackPos / 1000).toFixed(1) + 'K' : String(rackPos)) : '—',
    hint: 'Designed positions + honeycomb + surge buffer (from sizeFacility). Matches Dashboard Gross Positions.',
  });
  items.push({
    label: 'Utilization',
    value: (typeof utilPct === 'number' && utilPct > 0) ? utilPct.toFixed(1) + '%' : '—',
    hint: 'Average inventory positions / designed positions. Healthy band 70-90%.',
  });
  return items;
}

/** Refresh KPI strip from current WSC state. Cheap to call. */
function _refreshWscKpis() {
  if (!rootEl) return;
  refreshKpiStrip(rootEl, _computeWscKpis());
}

/** WSC-specific styles — the Configure-panel inputs were rendering with
 *  browser-default <input>/<select> styling (heavy black borders) which
 *  clashed with the hub's lighter aesthetic. This stylesheet makes them
 *  match hub-input + cm-form-label patterns. */
function _wscExtraStyles() {
  return `
    <style>
      /* WSC-scoped sidebar widen — Phase 4 cosmetic. The chrome's default
         240px sidebar was tight for some Configure inputs (5-digit Pallet
         Positions / Total SKUs, 3-decimal cartonsPerPalletOverride, etc.).
         Bump to 350px while the WSC is mounted; reverts on unmount because
         the inline <style> tag goes with the WSC HTML. Tool-chrome.js'
         transition rule animates the change cleanly. */
      .tool-chrome-shell .tc-sidebar {
        flex: 0 0 350px !important;
        width: 350px !important;
      }

      /* Section grouping inside the Configure drawer. */
      .wsc-config-section {
        padding: 16px;
        border-bottom: 1px solid var(--ies-gray-100);
      }
      .wsc-config-section:last-child { border-bottom: 0; }
      .wsc-config-section h4,
      .wsc-config-title {
        margin: 0 0 12px 0;
        font-size: 11px;
        font-weight: 700;
        color: var(--ies-gray-500);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      /* Two-column row of fields. */
      .wsc-config-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 8px;
      }
      .wsc-config-row:last-child { margin-bottom: 0; }

      /* Single field — label + input stacked. */
      .wsc-config-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .wsc-config-field > label {
        font-size: 11px;
        font-weight: 600;
        color: var(--ies-gray-500);
        line-height: 1.3;
        cursor: default;
      }

      /* Inputs + selects — match the hub-input aesthetic without forcing
         the wsc-config-field markup to add the .hub-input class to every
         element. (240+ inputs in renderConfigPanel — class-by-class
         migration would be a massive diff.) */
      .wsc-config-field > input,
      .wsc-config-field > select {
        font-family: 'Montserrat', sans-serif;
        font-size: 13px;
        font-weight: 600;
        color: var(--ies-navy);
        background: #fff;
        border: 1px solid var(--ies-gray-200);
        border-radius: 6px;
        padding: 7px 10px;
        height: 34px;
        width: 100%;
        box-sizing: border-box;
        transition: border-color 0.12s ease, box-shadow 0.12s ease;
      }
      .wsc-config-field > input:focus,
      .wsc-config-field > select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.10);
      }
      .wsc-config-field > input::placeholder {
        color: var(--ies-gray-400);
        font-weight: 500;
      }
      /* Number inputs — tabular numerals for clean alignment. */
      .wsc-config-field > input[type="number"] {
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      /* Range inputs (storage allocation sliders). */
      .wsc-config-field > input[type="range"] {
        height: auto;
        padding: 0;
        border: none;
        background: transparent;
      }

      /* P0-2: 3D RenderedFacts HUD — fixed top-right overlay on the 3D canvas. */
      .wsc-3d-hud {
        position: absolute;
        top: 12px;
        right: 12px;
        max-width: 280px;
        padding: 12px 14px;
        background: rgba(15, 23, 42, 0.86);
        color: #f8fafc;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.45;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(4px);
        pointer-events: none;
        z-index: 10;
      }
      .wsc-3d-hud-title {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #cbd5e1;
        margin: 0 0 8px 0;
      }
      .wsc-3d-hud-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 2px 0;
      }
      .wsc-3d-hud-row strong {
        font-weight: 700;
      }
      .wsc-3d-hud-divider {
        border-top: 1px solid rgba(148, 163, 184, 0.35);
        margin: 6px 0;
      }
      .wsc-3d-hud-status {
        margin-top: 8px;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        text-align: center;
      }
      .wsc-3d-hud-status--on    { background: rgba(34, 197, 94, 0.22);  color: #bbf7d0; }
      .wsc-3d-hud-status--under { background: rgba(245, 158, 11, 0.25); color: #fde68a; }
      .wsc-3d-hud-status--over  { background: rgba(59, 130, 246, 0.25); color: #bfdbfe; }
      .wsc-3d-hud-meta {
        font-size: 10px;
        color: #94a3b8;
        margin-top: 6px;
      }
    </style>
  `;
}

async function bindShellEvents() {
  if (!rootEl) return;
  // Idempotent — pre-fix this rebinds chrome + 2 click + 4 pointer
  // listeners on EVERY section navigation (each onSection rebuilds the
  // shell HTML and recalls bindShellEvents). Stale listeners stack:
  // after N navigations the back-arrow fired onBack N+1 times → N+1
  // showConfirm modals. Cancel removed only the topmost. Now we bind
  // once per mount; mount() resets the flag on re-entry.
  if (rootEl.__wscShellBound) return;
  rootEl.__wscShellBound = true;

  bindToolChromeEvents(rootEl, {
    onPhase: () => {
      // WSC is single-phase; phase tab clicks no-op.
    },
    onSection: (key) => {
      if (!key || !WSC_SECTIONS.find(s => s.key === key)) return;
      activeView = /** @type {any} */ (key);
      // Re-render the shell to refresh chrome + content for the new view.
      // (renderShell + renderConfigPanel + renderContentView is the legacy
      // pattern; preserve it here.)
      rootEl.innerHTML = renderShell();
      bindShellEvents();
      renderConfigPanel();
      renderContentView();
      _refreshWscKpis();
    },
    onSidebar: (kind) => {
      _wscDrawerOpen = (kind === 'toggle') ? !_wscDrawerOpen : false;
      // Flip the data-sidebar-open attribute (CSS handles the width
      // transition) and refresh ONLY row2Prefix + the chrome's mode flag —
      // sidebarBody is intentionally OMITTED so in-progress text input
      // inside the panel is preserved.
      const body = rootEl?.querySelector('.tc-body');
      if (body) body.dataset.sidebarOpen = _wscDrawerOpen ? 'true' : 'false';
      // Re-render the Configure pill so its label/active class reflect
      // the new state. We pass an opts subset that includes row2Prefix
      // (refreshed) but omits sidebarBody.
      const opts = _buildWscChromeOpts();
      delete opts.sidebarBody;
      refreshToolChrome(rootEl, opts);
    },
    onBack: async () => {
      if (isDirty && !(await showConfirm('Unsaved changes. Leave for the scenarios list?'))) return;
      isDirty = false;
      viewMode = 'landing';
      await renderLanding();
    },
    onAction: (id) => {
      if (id === 'push-to-cm') {
        const btn = rootEl.querySelector('[data-tc-primary]');
        pushToCm();
        flashPrimaryAction(rootEl);
        return;
      }
      if (id === 'wsc-save') return handleSaveWsc();
    },
    onPrimaryShortcut: () => {
      pushToCm();
      flashPrimaryAction(rootEl);
    },
  });
  // Phase 5.4 — cross-tool CM drillback chip delegation.
  bindCmDrillback(rootEl);

  // Phase D (2026-05-05) — Elevation view-switcher delegation. The elevation
  // canvas re-renders on every renderContentView, so delegated on rootEl.
  rootEl?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-wsc-elev-view]');
    if (!btn) return;
    const view = btn.getAttribute('data-wsc-elev-view');
    if (view !== 'side' && view !== 'shelving') return;
    if (_wscElevView === view) return;
    _wscElevView = view;
    renderContentView();
  });

  // Root-level delegation for data-wsc-action (toggle-edit-layout, reset-layout).
  // Using delegation per the event-delegation-pattern memory — renderPlan's
  // innerHTML rewrite would otherwise drop any per-element listener.
  rootEl?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-wsc-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-wsc-action');
    if (action === 'toggle-edit-layout') {
      _planEditMode = !_planEditMode;
      renderContentView();
    } else if (action === 'reset-layout') {
      zones.layoutOverrides = {};
      isDirty = true;
      renderContentView();
    } else if (action === 'apply-shrink-suggestion') {
      // Resize the building to the suggested dims surfaced in the over-built
      // banner. Width comes from the col-allocation math; depth is preserved
      // (master segment plan unchanged). Refresh the Configure side panel
      // too so its Width/Depth inputs reflect the applied dims (without it
      // the inputs cache the original facility values).
      const w = +btn.getAttribute('data-suggested-width') || 0;
      const d = +btn.getAttribute('data-suggested-depth') || 0;
      if (w > 0) facility.buildingWidth = w;
      if (d > 0) facility.buildingDepth = d;
      isDirty = true;
      renderConfigPanel();
      renderContentView();
    } else if (action === 'apply-required-dims') {
      // Phase 2 redesign: Required-vs-Built panel "Apply suggested dims" button.
      // Maps long → buildingWidth (canonical dock-on-long-edge convention) and
      // short → buildingDepth. Engages buildingDimsOverride so the user's
      // applied dims are visibly the locked override (otherwise the next
      // re-render would show the dims as derived again).
      const longFt  = +btn.getAttribute('data-long')  || 0;
      const shortFt = +btn.getAttribute('data-short') || 0;
      if (longFt > 0)  facility.buildingWidth  = longFt;
      if (shortFt > 0) facility.buildingDepth  = shortFt;
      facility.buildingDimsOverride = true;
      isDirty = true;
      renderConfigPanel();
      renderContentView();
    }
  });

  // Canvas pointer events for edit-mode dragging. Delegated on rootEl for the
  // same reason — the canvas is recreated on every plan re-render.
  rootEl?.addEventListener('pointerdown', (e) => {
    if (!_planEditMode) return;
    const canvas = /** @type {HTMLCanvasElement} */ (e.target);
    if (!canvas || canvas.id !== 'wsc-plan-canvas' || !_planMeta) return;
    const { X0, Y0, pxPerFt } = _planMeta;
    const { offsetX, offsetY } = canvasMouseCoords(canvas, e);
    const order = ['office', 'forwardPick', 'shipStaging'];
    // Resize-corner hit-test wins over body-move (handles take priority)
    let hit = null;
    let mode = 'move';
    let corner = null;
    for (const id of order) {
      const r = _planZoneRects[id];
      if (!r) continue;
      const c = _hitCorner(r, offsetX, offsetY);
      if (c) { hit = id; mode = 'resize'; corner = c; break; }
    }
    if (!hit) {
      for (const id of order) {
        const r = _planZoneRects[id];
        if (!r) continue;
        if (offsetX >= r.x && offsetX <= r.x + r.w && offsetY >= r.y && offsetY <= r.y + r.h) {
          hit = id;
          break;
        }
      }
    }
    if (!hit) return;
    e.preventDefault();
    const r = _planZoneRects[hit];
    const curOverride = zones.layoutOverrides?.[hit] || {};
    const curXFt = (curOverride.x !== undefined) ? curOverride.x : (r.x - X0) / pxPerFt;
    const curYFt = (curOverride.y !== undefined) ? curOverride.y : (r.y - Y0) / pxPerFt;
    const curWFt = (curOverride.w !== undefined) ? curOverride.w : r.w / pxPerFt;
    const curHFt = (curOverride.h !== undefined) ? curOverride.h : r.h / pxPerFt;
    _planDrag = {
      zoneId: hit,
      mode,                  // 'move' | 'resize'
      corner,                // 'tl' | 'tr' | 'bl' | 'br' | null
      startMouseXPx: offsetX,
      startMouseYPx: offsetY,
      origXFt: curXFt,
      origYFt: curYFt,
      origWFt: curWFt,
      origHFt: curHFt,
      pxPerFt,
    };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = mode === 'resize' ? 'nwse-resize' : 'grabbing';
  });

  rootEl?.addEventListener('pointermove', (e) => {
    if (!_planDrag || !_planEditMode) return;
    const canvas = /** @type {HTMLCanvasElement} */ (e.target);
    if (!canvas || canvas.id !== 'wsc-plan-canvas') return;
    const { offsetX, offsetY } = canvasMouseCoords(canvas, e);
    const dxFt = (offsetX - _planDrag.startMouseXPx) / _planDrag.pxPerFt;
    const dyFt = (offsetY - _planDrag.startMouseYPx) / _planDrag.pxPerFt;
    const snap = 5;
    if (!zones.layoutOverrides) zones.layoutOverrides = {};
    const cur = zones.layoutOverrides[_planDrag.zoneId] || {};
    if (_planDrag.mode === 'resize') {
      // Translate corner-drag into x/y/w/h deltas
      let newX = _planDrag.origXFt;
      let newY = _planDrag.origYFt;
      let newW = _planDrag.origWFt;
      let newH = _planDrag.origHFt;
      const c = _planDrag.corner;
      if (c === 'br') { newW = _planDrag.origWFt + dxFt; newH = _planDrag.origHFt + dyFt; }
      else if (c === 'tr') { newW = _planDrag.origWFt + dxFt; newY = _planDrag.origYFt + dyFt; newH = _planDrag.origHFt - dyFt; }
      else if (c === 'bl') { newX = _planDrag.origXFt + dxFt; newW = _planDrag.origWFt - dxFt; newH = _planDrag.origHFt + dyFt; }
      else if (c === 'tl') { newX = _planDrag.origXFt + dxFt; newW = _planDrag.origWFt - dxFt; newY = _planDrag.origYFt + dyFt; newH = _planDrag.origHFt - dyFt; }
      // Snap and clamp to a reasonable minimum (10 ft per side)
      newX = Math.round(newX / snap) * snap;
      newY = Math.round(newY / snap) * snap;
      newW = Math.max(10, Math.round(newW / snap) * snap);
      newH = Math.max(10, Math.round(newH / snap) * snap);
      zones.layoutOverrides[_planDrag.zoneId] = { ...cur, x: newX, y: newY, w: newW, h: newH };
    } else {
      // Move mode — only update x/y, preserve any existing w/h override
      const newXFt = Math.round((_planDrag.origXFt + dxFt) / snap) * snap;
      const newYFt = Math.round((_planDrag.origYFt + dyFt) / snap) * snap;
      zones.layoutOverrides[_planDrag.zoneId] = { ...cur, x: newXFt, y: newYFt };
    }
    drawPlan();
  });

  const finishDrag = () => {
    if (!_planDrag) return;
    const canvas = rootEl?.querySelector('#wsc-plan-canvas');
    if (canvas) canvas.style.cursor = 'grab';
    _planDrag = null;
    isDirty = true;
  };
  rootEl?.addEventListener('pointerup', finishDrag);
  rootEl?.addEventListener('pointercancel', finishDrag);
  rootEl?.addEventListener('pointerleave', finishDrag);

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
    const saved = await api.saveConfig({ ...facility, zones, volumes });
    facility.id = saved.id || saved[0]?.id || facility.id;
    isDirty = false;
    bus.emit('wsc:saved', { id: facility.id });
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
  // collapsible left drawer. _renderWscConfigHtml() returns the HTML; this
  // function targets whichever element holds it (id=wsc-config wrapper inside
  // the chrome's .tc-sidebar__body).
  const panel = rootEl?.querySelector('#wsc-config');
  if (!panel) return;
  panel.innerHTML = _renderWscConfigHtml();
  bindConfigEvents(panel);
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

function _renderWscConfigHtml() {
  // Compute sized once — used by Step 1 readout, Step 5 derived outputs, and CTA banner.
  let sized = null;
  try { sized = calc.sizeFacility(toSizingInputs()); } catch {}
  const sizedSqft = sized?.totalSqft || 0;
  const mode = facility.sizingMode || 'design';

  return `
    <!-- ──────────────────────────────────────────────────────────────────
         SIZING MODE — Phase A (2026-05-05). Foundation toggle that drives
         the whole tool: Design = inventory drives building (engine answer
         is the single output, W/D hidden); Constraint = user W×D is a
         hard constraint (rendering uses user dims, dashboard surfaces gap).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section" style="margin-bottom:14px;padding:10px 12px;background:linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%);border-radius:6px;border:1px solid var(--ies-gray-200);">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ies-gray-500);margin-bottom:6px;">Sizing Mode</div>
      <div role="radiogroup" aria-label="Sizing mode" style="display:flex;gap:6px;">
        <button type="button" role="radio" aria-checked="${mode === 'design'}" data-wsc-mode="design"
                title="Inventory drives building dimensions. The engine sizes the facility from your peak units / mix / dock throughput. The 2D/3D rendering uses the sized footprint exactly. Use this for greenfield design or when you don't yet have a candidate building."
                style="flex:1;padding:8px 10px;font-size:12px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${mode === 'design' ? 'var(--ies-blue,#0047AB)' : 'var(--ies-gray-200)'};background:${mode === 'design' ? 'var(--ies-blue,#0047AB)' : '#fff'};color:${mode === 'design' ? '#fff' : 'var(--ies-gray-700)'};transition:all .12s;">
          Design
          <div style="font-size:10px;font-weight:500;margin-top:2px;color:${mode === 'design' ? 'rgba(255,255,255,.85)' : 'var(--ies-gray-500)'};">Inventory → building</div>
        </button>
        <button type="button" role="radio" aria-checked="${mode === 'constraint'}" data-wsc-mode="constraint"
                title="Building W×D is a hard constraint (existing site or candidate). Tool computes the required footprint from inventory and shows the gap vs your entered building. Rendering uses your W×D; empty space surfaces as 'capacity slack'."
                style="flex:1;padding:8px 10px;font-size:12px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${mode === 'constraint' ? 'var(--ies-blue,#0047AB)' : 'var(--ies-gray-200)'};background:${mode === 'constraint' ? 'var(--ies-blue,#0047AB)' : '#fff'};color:${mode === 'constraint' ? '#fff' : 'var(--ies-gray-700)'};transition:all .12s;">
          Constraint
          <div style="font-size:10px;font-weight:500;margin-top:2px;color:${mode === 'constraint' ? 'rgba(255,255,255,.85)' : 'var(--ies-gray-500)'};">Building → fit check</div>
        </button>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 1 — Demand & Inventory Profile (Phase B redesign 2026-05-05).
         Primary-input toggle picks driving UOM (throughput vs on-hand pallets);
         non-active path becomes a derived read-only tile. ABC velocity tier
         inputs (A/B/C %) drive forward-pick demand and slotting tilt.
         Inv Turns + Total SKUs no longer surfaced in UI (data fields preserved
         on the model for back-compat with legacy heuristic paths).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="1">
      <div class="wsc-step-header" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="wsc-step-num" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,#0047AB);color:#fff;font-size:11px;font-weight:700;">1</span>
        <span class="wsc-step-title" style="font-size:13px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--ies-gray-700);">Demand &amp; Inventory Profile</span>
        ${facility.parent_cost_model_id ? `<button class="hub-btn hub-btn-ghost hub-btn-sm" data-action="wsc-pull-from-cm" title="Re-pull volume defaults from the linked Cost Model." style="font-weight:500;margin-left:auto;">↻ Pull from CM</button>` : ''}
      </div>
      <div class="wsc-config-field" style="margin-bottom:10px;">
        <label>Facility Name</label>
        <input value="${facility.name}" data-fac="name" />
      </div>

      <!-- Primary-input toggle (Phase B locked decision) -->
      ${(() => {
        const pri = facility.primaryInventoryInput || 'throughput';
        return `
          <div style="margin-bottom:10px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:4px;">Drive sizing from</div>
            <div role="radiogroup" aria-label="Primary inventory input" style="display:flex;gap:6px;">
              <button type="button" role="radio" aria-checked="${pri === 'throughput'}" data-wsc-primary="throughput"
                title="Enter annual or daily outbound + DOH. Tool derives on-hand units / pallets. Most natural for greenfield sizing — you usually know your throughput before you have a slotting study."
                style="flex:1;padding:6px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${pri === 'throughput' ? 'var(--ies-blue,#0047AB)' : 'var(--ies-gray-200)'};background:${pri === 'throughput' ? 'var(--ies-blue,#0047AB)' : '#fff'};color:${pri === 'throughput' ? '#fff' : 'var(--ies-gray-700)'};">Throughput</button>
              <button type="button" role="radio" aria-checked="${pri === 'pallets'}" data-wsc-primary="pallets"
                title="Enter on-hand pallet positions directly. Tool derives implied throughput. Use this when you already have an engineered pallet count from a slotting study."
                style="flex:1;padding:6px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${pri === 'pallets' ? 'var(--ies-blue,#0047AB)' : 'var(--ies-gray-200)'};background:${pri === 'pallets' ? 'var(--ies-blue,#0047AB)' : '#fff'};color:${pri === 'pallets' ? '#fff' : 'var(--ies-gray-700)'};">Pallet Positions</button>
            </div>
          </div>
        `;
      })()}

      ${(() => {
        const pri = facility.primaryInventoryInput || 'throughput';
        const doh = +volumes.daysOnHand || 30;
        const peakMult = +volumes.peakMultiplier || 1.3;
        const annualOut = +volumes.annualOutboundUnits || 0;
        const cartonProf = sized?.cartonProfile;
        const cppActual = (cartonProf?.cartonsPerPallet) || (zones.productDimensions?.cartonsPerPallet) || 12;
        const ucActual = (zones.productDimensions?.unitsPerCartonPallet) || 6;
        const unitsPerPallet = cppActual * ucActual;

        if (pri === 'throughput') {
          // Primary inputs: annual outbound, DOH, peak. Compute on-hand units + pallets.
          const peakOnHandUnits = (annualOut > 0 && doh > 0)
            ? Math.round((annualOut / 365) * doh * peakMult)
            : 0;
          const peakOnHandPallets = (peakOnHandUnits > 0 && unitsPerPallet > 0)
            ? Math.ceil(peakOnHandUnits / unitsPerPallet)
            : 0;
          return `
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="Annual outbound throughput in units. Drives the on-hand inventory derivation: peak on-hand = (annual / 365) × DOH × peak factor.">Annual Outbound <span style="color:var(--ies-gray-500);font-weight:400;">(units)</span></label><input type="number" value="${volumes.annualOutboundUnits || 0}" data-vol="annualOutboundUnits" /></div>
              <div class="wsc-config-field"><label title="Days On Hand target — drives the throughput → on-hand inventory conversion. Default 30 days. Tier-A SKUs typically run 7-15 DOH; Tier-C 60-90.">DOH (days)</label><input type="number" value="${doh}" step="1" data-vol="daysOnHand" /></div>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="Peak vs avg-day demand multiplier. Default 1.3. Drives both the peak on-hand units and the dock peak throughput.">Peak Factor</label><input type="number" value="${peakMult}" step="0.1" data-vol="peakMultiplier" /></div>
              <div class="wsc-config-field"><label title="Average inbound pallets/day — drives dock throughput sizing.">Daily Inbound <span style="color:var(--ies-gray-500);font-weight:400;">(pallets/day)</span></label><input type="number" value="${volumes.avgDailyInbound}" data-vol="avgDailyInbound" /></div>
            </div>
            <div style="margin-top:10px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
              <div style="font-weight:700;margin-bottom:4px;color:var(--ies-gray-500);text-transform:uppercase;font-size:10px;">Derived on-hand inventory</div>
              <div>Peak units on-hand: <strong>${peakOnHandUnits.toLocaleString()}</strong> (annual ÷ 365 × DOH × peak)</div>
              <div>Peak pallets on-hand: <strong>${peakOnHandPallets.toLocaleString()}</strong> <span style="color:var(--ies-gray-500);">(at ${unitsPerPallet} units/pallet from Carton Profile)</span></div>
            </div>
          `;
        }
        // Pallet-driven mode
        const totalPallets = +volumes.totalPallets || 0;
        const onHandUnits = totalPallets * unitsPerPallet;
        const impliedAnnualOut = (totalPallets > 0 && doh > 0 && peakMult > 0)
          ? Math.round((onHandUnits / peakMult / doh) * 365)
          : 0;
        return `
          <div class="wsc-config-row">
            <div class="wsc-config-field"><label title="Total pallet positions on-hand at peak inventory. From a slotting study or engineered count. Engine sizes storage directly to this value (peak-units × mix derivation is bypassed).">Pallet Positions <span style="color:var(--ies-gray-500);font-weight:400;">(on-hand)</span></label><input type="number" value="${totalPallets}" data-vol="totalPallets" /></div>
            <div class="wsc-config-field"><label title="Days On Hand — used to back into the implied throughput.">DOH (days)</label><input type="number" value="${doh}" step="1" data-vol="daysOnHand" /></div>
          </div>
          <div class="wsc-config-row">
            <div class="wsc-config-field"><label title="Peak vs avg-day demand multiplier. Drives the implied annual throughput.">Peak Factor</label><input type="number" value="${peakMult}" step="0.1" data-vol="peakMultiplier" /></div>
            <div class="wsc-config-field"><label title="Average inbound pallets/day — drives dock throughput sizing.">Daily Inbound <span style="color:var(--ies-gray-500);font-weight:400;">(pallets/day)</span></label><input type="number" value="${volumes.avgDailyInbound}" data-vol="avgDailyInbound" /></div>
          </div>
          <div style="margin-top:10px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
            <div style="font-weight:700;margin-bottom:4px;color:var(--ies-gray-500);text-transform:uppercase;font-size:10px;">Derived throughput</div>
            <div>Peak units on-hand: <strong>${onHandUnits.toLocaleString()}</strong> <span style="color:var(--ies-gray-500);">(at ${unitsPerPallet} units/pallet)</span></div>
            <div>Implied annual outbound: <strong>${impliedAnnualOut.toLocaleString()}</strong> units <span style="color:var(--ies-gray-500);">(on-hand ÷ peak ÷ DOH × 365)</span></div>
          </div>
        `;
      })()}

      <!-- ABC velocity tiers -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">ABC velocity tiers <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ies-gray-400);">(% of SKUs by velocity — Pareto default 20/30/50)</span></div>
        ${(() => {
          const a = +facility.velocityTierAPct || 0;
          const b = +facility.velocityTierBPct || 0;
          const c = +facility.velocityTierCPct || 0;
          const total = Math.round((a + b + c) * 10) / 10;
          const ok = total === 100;
          const pillBg = ok ? '#dcfce7' : '#fef3c7';
          const pillCol = ok ? '#166534' : '#92400e';
          const pillTxt = ok ? `${total}% ✓` : `${total}% ⚠ ≠100`;
          return `
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="A-velocity SKUs (fast-movers, ~20% of SKUs drive ~80% of picks). Drives forward-pick demand and replenishment frequency.">A %</label><input type="number" min="0" max="100" value="${a}" data-fac="velocityTierAPct" /></div>
              <div class="wsc-config-field"><label title="B-velocity SKUs (medium movers).">B %</label><input type="number" min="0" max="100" value="${b}" data-fac="velocityTierBPct" /></div>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="C-velocity SKUs (slow movers — typical reserve storage candidates).">C %</label><input type="number" min="0" max="100" value="${c}" data-fac="velocityTierCPct" /></div>
              <div class="wsc-config-field" style="display:flex;align-items:flex-end;justify-content:flex-end;">
                <span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:${pillBg};color:${pillCol};font-size:11px;font-weight:700;letter-spacing:.02em;">Total: ${pillTxt}</span>
              </div>
            </div>
          `;
        })()}
      </div>

      <!-- Slotting % (Reserve / Case Pick / Each Pick) — Phase C (2026-05-05)
           moved from old Step 4 into Step 1, since slotting % is tightly
           coupled to the ABC velocity tiers above (A SKUs feed Each Pick,
           C SKUs feed Reserve, etc.). Numeric inputs + sum-validation pill. -->
      ${(() => {
        const fp = +zones.storageAllocation?.fullPallet || 0;
        const cp = +zones.storageAllocation?.cartonOnPallet || 0;
        const cs = +zones.storageAllocation?.cartonOnShelving || 0;
        const total = Math.round((fp + cp + cs) * 10) / 10;
        const ok = total === 100;
        const pillBg = ok ? '#dcfce7' : '#fef3c7';
        const pillCol = ok ? '#166534' : '#92400e';
        const pillTxt = ok ? `${total}% ✓` : `${total}% ⚠ ≠100`;
        return `
          <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
              <span>Storage type mix <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ies-gray-400);">(% of on-hand inventory by storage pattern)</span></span>
              <span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:${pillBg};color:${pillCol};font-size:11px;font-weight:700;letter-spacing:.02em;">Total: ${pillTxt}</span>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="Reserve / Full Pallet — units stored as full pallet loads in selective rack. Highest density, bulk movement; typical for slower-moving / case-pick reserve.">Reserve <span style="color:var(--ies-gray-500);font-weight:400;">(Full Pallet) %</span></label><input type="number" min="0" max="100" value="${fp}" data-alloc="fullPallet" /></div>
              <div class="wsc-config-field"><label title="Case Pick / Carton-on-Pallet — pallets staged in pick face for case-quantity pull. Mid-density; typical for B-velocity SKUs needing case-level access.">Case Pick <span style="color:var(--ies-gray-500);font-weight:400;">(Carton-on-Pallet) %</span></label><input type="number" min="0" max="100" value="${cp}" data-alloc="cartonOnPallet" /></div>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label title="Each Pick / Carton Shelving — cartons in shelf locations for unit-level picking. Lowest density, highest pick velocity; typical for A-velocity SKUs and split-case forward.">Each Pick <span style="color:var(--ies-gray-500);font-weight:400;">(Carton Shelving) %</span></label><input type="number" min="0" max="100" value="${cs}" data-alloc="cartonOnShelving" /></div>
              <div class="wsc-config-field"></div>
            </div>
          </div>
        `;
      })()}

      <!-- SKU breadth by zone — Phase C: lifted from old Step 4 into Step 1
           (drives min-locations + sku-bound mode for shelving sizing). -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">SKU breadth by zone <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ies-gray-400);">(0 = derive heuristic)</span></div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="Number of distinct SKUs in the full-pallet zone. Sets a floor on minimum locations (one face per SKU). 0 = derive from positions × 0.1.">FP SKUs</label><input type="number" value="${facility.fullPalletSkus ?? 0}" data-fac="fullPalletSkus" /></div>
          <div class="wsc-config-field"><label title="SKUs in the carton-on-pallet zone.">CP SKUs</label><input type="number" value="${facility.cartonPalletSkus ?? 0}" data-fac="cartonPalletSkus" /></div>
        </div>
        <div class="wsc-config-field" style="margin-top:8px;">
          <label title="SKUs in the shelving zone — each SKU minimally needs 1 shelf face. When SKUs × 1 face > demand-driven cartons, locations become sku-bound.">Shelving SKUs</label>
          <input type="number" value="${facility.shelvingSkus ?? 0}" data-fac="shelvingSkus" />
        </div>
        ${(() => {
          const sh = sized?.locations?.shelving;
          if (!sh) return '';
          const modeColor = sh.mode === 'sku-bound' ? 'var(--ies-orange,#f97316)' : 'var(--ies-gray-700)';
          return `
            <div style="margin-top:8px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
              <div style="font-weight:700;margin-bottom:4px;color:var(--ies-gray-500);text-transform:uppercase;font-size:10px;">Shelving locations</div>
              <div>Demand-side: <strong>${sh.demandLocations.toLocaleString()}</strong> · SKU-side: <strong>${sh.skuMinLocations.toLocaleString()}</strong></div>
              <div>Required (× honeycomb × surge): <strong>${sh.locationsRequired.toLocaleString()}</strong> in <strong>${sh.baysRequired.toLocaleString()}</strong> bays</div>
              <div>Mode: <strong style="color:${modeColor};">${sh.mode}</strong></div>
            </div>
          `;
        })()}
      </div>

      <!-- Per-channel allocation overrides — Phase C: lifted from old Step 4
           into Step 1 (Phase 4 Layer B per-channel slotting overrides). -->
      ${(() => {
        const chans = Array.isArray(zones.channelMixes) ? zones.channelMixes : [];
        if (chans.length === 0) return '';
        const facAlloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
        const rows = chans.map(c => {
          const a = (c.storageAllocation && typeof c.storageAllocation === 'object') ? c.storageAllocation : null;
          const fp = a ? a.fullPallet : facAlloc.fullPallet;
          const cp = a ? a.cartonOnPallet : facAlloc.cartonOnPallet;
          const cs = a ? a.cartonOnShelving : facAlloc.cartonOnShelving;
          const total = (Number(fp) || 0) + (Number(cp) || 0) + (Number(cs) || 0);
          const totalOk = total === 100;
          const isOverridden = !!a;
          return `
            <div class="wsc-channel-alloc-row" data-channel-key="${escapeAttr(c.channelKey)}" style="display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--ies-gray-100);">
              <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;">
                <span>${escapeHtml(c.name || c.channelKey)} ${isOverridden ? '<span style="color:var(--ies-blue);font-weight:700;" title="Channel override active">●</span>' : '<span style="color:var(--ies-gray-400);" title="Inheriting facility allocation">○</span>'}</span>
                <span style="color:${totalOk ? 'var(--ies-gray-500)' : 'var(--ies-orange)'};">${total}%${totalOk ? '' : ' ⚠'}</span>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr) auto;gap:4px;">
                <input type="number" min="0" max="100" value="${fp}" data-channel-alloc="fullPallet" data-channel-key="${escapeAttr(c.channelKey)}" title="Full Pallet %" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;" />
                <input type="number" min="0" max="100" value="${cp}" data-channel-alloc="cartonOnPallet" data-channel-key="${escapeAttr(c.channelKey)}" title="Carton on Pallet %" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;" />
                <input type="number" min="0" max="100" value="${cs}" data-channel-alloc="cartonOnShelving" data-channel-key="${escapeAttr(c.channelKey)}" title="Carton Shelving %" style="font-size:11px;padding:3px 6px;border:1px solid var(--ies-gray-200);border-radius:4px;" />
                ${isOverridden ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-channel-alloc-reset="${escapeAttr(c.channelKey)}" title="Reset this channel to inherit the facility-level allocation" style="font-size:10px;padding:2px 6px;">↻</button>` : '<span></span>'}
              </div>
            </div>`;
        }).join('');
        return `
          <details class="wsc-channel-allocs" style="margin-top:14px;border-top:1px solid var(--ies-gray-200);padding-top:8px;" open>
            <summary style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);cursor:pointer;">Per-channel allocation overrides</summary>
            <div style="display:flex;flex-direction:column;gap:0;margin-top:6px;font-size:11px;color:var(--ies-gray-600);">
              <div style="font-size:10px;color:var(--ies-gray-400);font-weight:500;text-transform:none;letter-spacing:0;line-height:1.4;padding-bottom:4px;">Reserve / Case Pick / Each Pick — must sum to 100. ● = overridden, ○ = inheriting facility allocation.</div>
              ${rows}
            </div>
          </details>`;
      })()}

      <!-- Operating days/yr + Daily Outbound (pallets/day) — kept in Step 1
           with the volume profile; both feed downstream metrics. -->
      <div class="wsc-config-row" style="margin-top:10px;">
        <div class="wsc-config-field"><label title="Operating days per year — used downstream by DIOH metric.">Operating Days/Yr</label><input type="number" value="${zones.operatingDaysPerYear || 250}" data-inv="operatingDaysPerYear" /></div>
        <div class="wsc-config-field"><label title="Average outbound pallets/day — drives dock throughput sizing.">Daily Outbound <span style="color:var(--ies-gray-500);font-weight:400;">(pallets/day)</span></label><input type="number" value="${volumes.avgDailyOutbound}" data-vol="avgDailyOutbound" /></div>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 2 — Unit Load & Carton (Phase C 2026-05-05: merged previous
         Step 2 "Unit Load Pallet" + Step 3 "Carton Profile" into a single
         step covering pallet + carton physical dimensions and the two
         computed readouts (bay/rack/level + ti×hi/cartons-per-shelf).
         Legacy product-dimensions sub-section dropped from the UI surface
         (data fields preserved on zones.productDimensions for back-compat).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="2">
      <div class="wsc-step-header" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="wsc-step-num" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,#0047AB);color:#fff;font-size:11px;font-weight:700;">2</span>
        <span class="wsc-step-title" style="font-size:13px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--ies-gray-700);">Unit Load &amp; Carton</span>
      </div>

      <!-- Pallet -->
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Pallet</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field">
          <label title="Pallet type drives default L×W. GMA / CHEP = 48×40. Euro = 1200×800mm. Custom uses the L/W fields below.">Pallet Type</label>
          <select data-fac="palletType">
            ${['GMA','CHEP','Euro','EuroHalf','Custom'].map(t =>
              `<option value="${t}"${(facility.palletType || 'GMA') === t ? ' selected' : ''}>${t}</option>`
            ).join('')}
          </select>
        </div>
        <div class="wsc-config-field"><label>Clear Ht (ft)</label><input type="number" value="${facility.clearHeight}" step="1" data-fac="clearHeight" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Pallet Length (in)</label><input type="number" value="${facility.palletWidth ?? 48}" data-fac="palletWidth" /></div>
        <div class="wsc-config-field"><label>Pallet Width (in)</label><input type="number" value="${facility.palletDepth ?? 40}" data-fac="palletDepth" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Load Height (in)</label><input type="number" value="${facility.palletHeight ?? 54}" data-fac="palletHeight" /></div>
        <div class="wsc-config-field"><label>Beam Ht (in)</label><input type="number" value="${facility.beamHeight ?? 5}" data-fac="beamHeight" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Flue Space (in)</label><input type="number" value="${facility.flueSpace ?? 3}" data-fac="flueSpace" /></div>
        <div class="wsc-config-field"><label>Sprinkler Clear (in)</label><input type="number" value="${facility.topClearance ?? 36}" data-fac="topClearance" /></div>
      </div>
      ${(() => {
        const u = sized?.unitLoad;
        if (!u) return '';
        return `
          <div style="margin-top:8px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
            <div style="font-weight:700;margin-bottom:4px;color:var(--ies-gray-500);text-transform:uppercase;font-size:10px;">Computed unit load</div>
            <div>Bay width (2 pallets per crossbeam): <strong>${u.bayWidthFt.toFixed(2)} ft</strong> (${u.bayWidthIn}")</div>
            <div>Rack depth (single / back-to-back): <strong>${u.rackDepthSingleFt.toFixed(2)} ft / ${u.rackDepthBackToBackFt.toFixed(2)} ft</strong></div>
            <div>Level pitch: <strong>${u.palletLevelHeightFt.toFixed(2)} ft</strong> · Levels at 30 ft clear: <strong>${u.palletLevelsAt30FtClear}</strong></div>
          </div>
        `;
      })()}

      <!-- Carton -->
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-top:14px;margin-bottom:6px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">Carton</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Carton L (in)</label><input type="number" value="${facility.cartonLengthIn ?? 12}" step="0.5" data-fac="cartonLengthIn" /></div>
        <div class="wsc-config-field"><label>Carton W (in)</label><input type="number" value="${facility.cartonWidthIn ?? 9}" step="0.5" data-fac="cartonWidthIn" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Carton H (in)</label><input type="number" value="${facility.cartonHeightIn ?? 12}" step="0.5" data-fac="cartonHeightIn" /></div>
        <div class="wsc-config-field">
          <label title="L-along-rack: long edge of carton sits parallel to the rack run. W-along-rack: short edge along rack run. Affects cartons-per-shelf math.">Orientation</label>
          <select data-fac="cartonOrientation">
            <option value="L-along-rack"${(facility.cartonOrientation || 'L-along-rack') === 'L-along-rack' ? ' selected' : ''}>L along rack</option>
            <option value="W-along-rack"${facility.cartonOrientation === 'W-along-rack' ? ' selected' : ''}>W along rack</option>
          </select>
        </div>
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label title="Override ti×hi-derived cartons-per-pallet. Use 0 to let the engine compute from carton + pallet dims (typical). Set > 0 if you have a slotting study with a specific case-pack.">Cartons/Pallet Override <span style="color:var(--ies-gray-500);font-weight:400;">(0 = derive)</span></label>
        <input type="number" value="${facility.cartonsPerPalletOverride ?? 0}" data-fac="cartonsPerPalletOverride" />
      </div>
      ${(() => {
        const c = sized?.cartonProfile;
        if (!c) return '';
        const tag = c.cartonsPerPalletOverride ? ' (override)' : ' (ti×hi derived)';
        return `
          <div style="margin-top:8px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
            <div style="font-weight:700;margin-bottom:4px;color:var(--ies-gray-500);text-transform:uppercase;font-size:10px;">Computed carton profile</div>
            <div>ti × hi: <strong>${c.ti} × ${c.hi}</strong> — Cartons/Pallet: <strong>${c.cartonsPerPallet}</strong>${tag}</div>
            <div>Cartons/Shelf: <strong>${c.cartonsPerShelf}</strong> (${c.cartonsPerShelfAcross} across × ${c.cartonsPerShelfDeep} deep, ${c.orientation})</div>
            <div>Shelf level pitch: <strong>${c.shelfLevelHeightFt.toFixed(2)} ft</strong> · Levels in 84": <strong>${c.shelfLevelsAt84In}</strong></div>
          </div>
        `;
      })()}
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 3 — Operating Strategy (Phase C 2026-05-05).
         The "how" of physical rack/MHE/pick design, separate from "what"
         (slotting %, which moved to Step 1). Storage Type drives default
         aisle width; bottom-beam toggles drive rack-level rendering;
         Forward Pick is a velocity-driven slotting decision (paired with
         the A-velocity tier from Step 1).
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="3">
      <div class="wsc-step-header" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="wsc-step-num" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,#0047AB);color:#fff;font-size:11px;font-weight:700;">3</span>
        <span class="wsc-step-title" style="font-size:13px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--ies-gray-700);">Operating Strategy</span>
      </div>

      <div class="wsc-config-row">
        <div class="wsc-config-field">
          <label title="Storage type drives aisle width default and rack design. Single-deep selective is most flexible; double-deep / drive-in / push-back trade flexibility for density.">Storage Type</label>
          <select data-fac="storageType">
            ${['single', 'double', 'bulk', 'carton', 'mix'].map(s =>
              `<option value="${s}"${facility.storageType === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="wsc-config-field"><label title="Aisle clear width in feet. Counterbalance ~12 ft, reach ~10 ft, VNA ~6 ft. Drives the module width = 2×rack-depth + aisle.">Aisle Width (ft)</label><input type="number" value="${facility.aisleWidth || calc.AISLE_WIDTHS[facility.storageType] || 12}" step="0.5" data-fac="aisleWidth" /></div>
      </div>

      <!-- Bottom-beam toggles per zone — drive 3D rendering (rack levels w/ vs w/o ground beam) -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Bottom-beam <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ies-gray-400);">(off = pallet on slab)</span></div>
        <div class="wsc-config-field" style="margin-bottom:6px;">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;">
            <input type="checkbox" data-fac-bool="bottomBeamFp" ${facility.bottomBeamFp ? 'checked' : ''} style="margin:0;" />
            <span>Full-Pallet zone (default off)</span>
          </label>
        </div>
        <div class="wsc-config-field" style="margin-bottom:6px;">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;">
            <input type="checkbox" data-fac-bool="bottomBeamCp" ${facility.bottomBeamCp ? 'checked' : ''} style="margin:0;" />
            <span>Carton-Pallet zone (default on for wire-deck case-pick)</span>
          </label>
        </div>
        <div class="wsc-config-field">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;">
            <input type="checkbox" data-fac-bool="bottomBeamShelving" ${facility.bottomBeamShelving ? 'checked' : ''} style="margin:0;" />
            <span>Shelving zone (default off — has own deck)</span>
          </label>
        </div>
      </div>

      <!-- Forward Pick — pairs with A-velocity tier from Step 1 -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Forward Pick <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ies-gray-400);">(velocity-driven slotting)</span></div>
        <div class="wsc-config-field" style="margin-bottom:6px;">
          <label style="display:flex;align-items:center;gap:6px;font-weight:500;font-size:12px;">
            <input type="checkbox" ${zones.forwardPick?.enabled ? 'checked' : ''} data-fwd="enabled" style="margin:0;" />
            <span>Enable Forward Pick area</span>
          </label>
        </div>
        ${zones.forwardPick?.enabled ? `
          <div class="wsc-config-row">
            <div class="wsc-config-field">
              <label title="Pick type drives sf-per-active-face. Carton Flow ~12 sf, Light Case ~14 sf, Heavy Case ~45 sf (pallet-style face).">Pick Type</label>
              <select data-fwd="type">
                <option value="carton_flow"${zones.forwardPick?.type === 'carton_flow' ? ' selected' : ''}>Carton Flow</option>
                <option value="light_case"${zones.forwardPick?.type === 'light_case' ? ' selected' : ''}>Light Case</option>
                <option value="heavy_case"${zones.forwardPick?.type === 'heavy_case' ? ' selected' : ''}>Heavy Case</option>
              </select>
            </div>
            <div class="wsc-config-field"><label title="Total SKUs eligible for forward-pick assignment. The A-velocity tier % from Step 1 determines how many of these get an active pick face.">SKU count</label><input type="number" value="${zones.forwardPick?.skuCount || 2000}" data-fwd="skuCount" /></div>
          </div>
          <div class="wsc-config-row">
            <div class="wsc-config-field"><label title="DOH held in the forward-pick area before replenishment from reserve. Lower = more frequent reps; higher = bigger forward area.">Days Inventory (DOH)</label><input type="number" value="${zones.forwardPick?.daysInventory || 3}" step="0.5" data-fwd="daysInventory" /></div>
            <div class="wsc-config-field"><label title="Outbound units/day flowing through the forward-pick area. Used by some downstream metrics; doesn't drive area sizing directly (active-face count does).">Outbound (units/day)</label><input type="number" value="${zones.forwardPick?.outboundUnitsPerDay || 5000}" data-fwd="outboundUnitsPerDay" /></div>
          </div>
          <div style="margin-top:8px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
            <div style="font-weight:700;margin-bottom:4px;color:var(--ies-gray-500);text-transform:uppercase;font-size:10px;">Active-face derivation</div>
            ${(() => {
              const skus = +zones.forwardPick?.skuCount || 0;
              const aPct = +facility.velocityTierAPct || 20;
              const activeFaces = Math.ceil(skus * aPct / 100);
              return `<div>Active faces = SKU count × A-velocity % = <strong>${skus.toLocaleString()}</strong> × <strong>${aPct}%</strong> = <strong>${activeFaces.toLocaleString()}</strong> faces</div>`;
            })()}
          </div>
        ` : ''}
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 4 — Dock & Support (Phase C 2026-05-05 — lifted from old
         Advanced collapsible). Peak-throughput-driven dock door derivation
         (Phase 1 helper) + explicit door overrides + optional zones (VAS,
         Returns, Chargeback, Charging, Repack/VAS, Other) + custom zones.
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="4">
      <div class="wsc-step-header" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="wsc-step-num" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-blue,#0047AB);color:#fff;font-size:11px;font-weight:700;">4</span>
        <span class="wsc-step-title" style="font-size:13px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--ies-gray-700);">Dock &amp; Support</span>
      </div>

      <!-- Dock throughput parameters (peak-throughput-driven derivation) -->
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Dock throughput parameters</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Pallets per truck — 26 with stack, 30 floor-loaded.">Pallets/Truck</label><input type="number" value="${facility.palletsPerTruck ?? 26}" data-fac="palletsPerTruck" /></div>
        <div class="wsc-config-field"><label title="Hours each truck occupies a door (live unload + stage).">Dwell Hrs/Truck</label><input type="number" value="${facility.dwellHoursPerTruck ?? 1.5}" step="0.25" data-fac="dwellHoursPerTruck" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Operating shift hours per day. 16 = 2-shift, 24 = round-clock.">Shift Hours/Day</label><input type="number" value="${facility.shiftHoursPerDay ?? 16}" data-fac="shiftHoursPerDay" /></div>
        <div class="wsc-config-field"><label title="Dock surge buffer fraction. 0.20 = 20% buffer on derived door count.">Dock Surge</label><input type="number" value="${facility.surgePctDock ?? 0.20}" step="0.05" data-fac="surgePctDock" /></div>
      </div>

      <!-- Dock layout + explicit door overrides -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Dock layout &amp; overrides</div>
        <div class="wsc-config-field" style="margin-bottom:8px;">
          <label title="Single-sided = inbound + outbound on the same dock face. Two-sided = inbound on one wall, outbound on the opposite wall — uses 2× as much wall but separates flows.">Dock Layout</label>
          <select data-dock="sided">
            <option value="single"${zones.dockConfig?.sided === 'single' ? ' selected' : ''}>Single-Sided</option>
            <option value="two"${zones.dockConfig?.sided === 'two' ? ' selected' : ''}>Two-Sided</option>
          </select>
        </div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="If > 0, engine uses this explicit count instead of deriving from peak throughput.">Inbound Doors <span style="color:var(--ies-gray-500);font-weight:400;">(explicit)</span></label><input type="number" value="${zones.dockConfig?.inboundDoors || 10}" data-dock="inboundDoors" /></div>
          <div class="wsc-config-field"><label title="If > 0, engine uses this explicit count instead of deriving from peak throughput.">Outbound Doors <span style="color:var(--ies-gray-500);font-weight:400;">(explicit)</span></label><input type="number" value="${zones.dockConfig?.outboundDoors || 12}" data-dock="outboundDoors" /></div>
        </div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="Pallets per door per hour throughput rate. Drives the legacy door-utilization metric.">Pallets/Hr/Door</label><input type="number" value="${zones.dockConfig?.palletsPerDockHour || 12}" step="1" data-dock="palletsPerDockHour" /></div>
          <div class="wsc-config-field"><label title="Legacy operating hours/day for door-utilization metric.">Operating Hrs <span style="color:var(--ies-gray-500);font-weight:400;">(legacy)</span></label><input type="number" value="${zones.dockConfig?.dockOperatingHours || 10}" step="0.5" data-dock="dockOperatingHours" /></div>
        </div>
      </div>

      <!-- Optional zones (VAS / Returns / Chargeback) -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Optional zones</div>
        <div class="wsc-config-field" style="margin-bottom:8px;">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" ${zones.optionalZones?.vas?.enabled ? 'checked' : ''} data-opt="vas-enabled" style="margin:0;" />
            <span>VAS</span>
          </label>
        </div>
        <div class="wsc-config-row single-col" id="wsc-opt-vas-row" style="display:${zones.optionalZones?.vas?.enabled ? 'grid' : 'none'};">
          <div class="wsc-config-field"><label>VAS SF</label><input type="number" value="${zones.optionalZones?.vas?.sqft || 0}" data-opt="vas-sqft" /></div>
        </div>
        <div class="wsc-config-field" style="margin-bottom:8px;">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" ${zones.optionalZones?.returns?.enabled ? 'checked' : ''} data-opt="returns-enabled" style="margin:0;" />
            <span>Returns</span>
          </label>
        </div>
        <div class="wsc-config-row single-col" id="wsc-opt-returns-row" style="display:${zones.optionalZones?.returns?.enabled ? 'grid' : 'none'};">
          <div class="wsc-config-field"><label>Returns SF</label><input type="number" value="${zones.optionalZones?.returns?.sqft || 0}" data-opt="returns-sqft" /></div>
        </div>
        <div class="wsc-config-field" style="margin-bottom:8px;">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" ${zones.optionalZones?.chargeback?.enabled ? 'checked' : ''} data-opt="chargeback-enabled" style="margin:0;" />
            <span>Chargeback</span>
          </label>
        </div>
        <div class="wsc-config-row single-col" id="wsc-opt-chargeback-row" style="display:${zones.optionalZones?.chargeback?.enabled ? 'grid' : 'none'};">
          <div class="wsc-config-field"><label>Chargeback SF</label><input type="number" value="${zones.optionalZones?.chargeback?.sqft || 0}" data-opt="chargeback-sqft" /></div>
        </div>
        <div class="wsc-config-row">
          <div class="wsc-config-field"><label title="Battery charging / equipment maintenance area.">Charging SF</label><input type="number" value="${zones.chargingSqft || 0}" data-zone="chargingSqft" /></div>
          <div class="wsc-config-field"><label title="Repack / value-add area inside the warehouse footprint.">Repack/VAS SF</label><input type="number" value="${zones.repackSqft || 0}" data-zone="repackSqft" /></div>
        </div>
        <div class="wsc-config-field" style="margin-top:8px;">
          <label>Other SF</label>
          <input type="number" value="${zones.otherSqft || 0}" data-zone="otherSqft" />
        </div>
      </div>

      <!-- Custom zones -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px solid var(--ies-gray-100);">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Custom zones</div>
        <div id="wsc-custom-zones-list" style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px;">
          ${(zones.customZones || []).map((z, i) => `
            <div style="display:flex; gap:4px; align-items:center;">
              <input type="text" value="${z.name}" data-custom-name="${i}" placeholder="Zone name" style="flex:1; padding:4px 6px; border:1px solid var(--ies-gray-200); border-radius:4px; font-size:11px;" />
              <input type="number" value="${z.sqft}" data-custom-sqft="${i}" min="0" placeholder="SF" style="width:80px; padding:4px 6px; border:1px solid var(--ies-gray-200); border-radius:4px; font-size:11px;" />
              <button data-custom-remove="${i}" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:18px; padding:0; line-height:1;">×</button>
            </div>
          `).join('')}
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="wsc-add-custom-zone" style="width:100%;">+ Add Custom Zone</button>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────────
         STEP 5 — Sized Facility (Design mode) / Capacity Check (Constraint mode).
         Phase A (2026-05-05): mode-aware title + content. Design = single
         answer (engine output); Constraint = required vs entered W×D with
         explicit gap row. The misleading "Built (current): X SF at Y ft"
         label that mixed sized output with user dims under one label is gone.
         ────────────────────────────────────────────────────────────────── -->
    <div class="wsc-config-section wsc-step" data-step="5">
      <div class="wsc-step-header" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="wsc-step-num" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--ies-gray-500);color:#fff;font-size:11px;font-weight:700;">5</span>
        <span class="wsc-step-title" style="font-size:13px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--ies-gray-700);">${mode === 'constraint' ? 'Capacity Check' : 'Sized Facility'}</span>
      </div>
      ${(() => {
        if (!sized) return `<div style="font-size:11px;color:var(--ies-gray-500);">Sizing unavailable — fill in Steps 1-4.</div>`;
        const r = sized.requirementsDriven || {};
        const requiredBlock = `
          <div style="padding:10px 12px;background:var(--ies-gray-50);border-radius:6px;font-size:12px;color:var(--ies-gray-700);margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Storage</span><strong>${r.storageSf?.toLocaleString() || 0} sf</strong></div>
            <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Dock (peak-throughput driven)</span><strong>${r.dockSf?.toLocaleString() || 0} sf</strong></div>
            <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Office</span><strong>${r.officeSf?.toLocaleString() || 0} sf</strong></div>
            <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Staging</span><strong>${r.stagingSf?.toLocaleString() || 0} sf</strong></div>
            ${r.additionalSf > 0 ? `<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Additional</span><strong>${r.additionalSf.toLocaleString()} sf</strong></div>` : ''}
            <div style="display:flex;justify-content:space-between;padding:2px 0;color:var(--ies-gray-500);"><span>+ Circulation buffer (10%)</span><strong>${r.circulationSf?.toLocaleString() || 0} sf</strong></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0 2px;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:var(--ies-blue,#0047AB);"><span>${mode === 'constraint' ? 'Required' : 'Sized Total'}</span><strong>${r.totalSfRequired?.toLocaleString() || 0} sf</strong></div>
            ${mode === 'design' ? `<div style="display:flex;justify-content:space-between;padding:2px 0;color:var(--ies-gray-500);font-size:11px;"><span>Suggested footprint (1.5:1)</span><strong>${r.suggestedLongFt || 0} × ${r.suggestedShortFt || 0} ft</strong></div>` : ''}
          </div>
        `;
        if (mode === 'design') return requiredBlock;
        // Constraint mode — show user dims + capacity gap row.
        const builtSf = (Number(facility.buildingWidth) || 0) * (Number(facility.buildingDepth) || 0);
        const haveBuilt = builtSf > 0;
        const required = r.totalSfRequired || 0;
        const deltaSf = haveBuilt ? builtSf - required : 0;
        const deltaPct = (haveBuilt && required > 0) ? Math.round((deltaSf / required) * 1000) / 10 : 0;
        const gapColor = !haveBuilt ? 'var(--ies-gray-500)' : Math.abs(deltaPct) <= 5 ? 'var(--ies-green,#10b981)' : deltaSf > 0 ? 'var(--ies-blue,#0047AB)' : 'var(--ies-orange,#f97316)';
        const gapLabel = !haveBuilt ? 'Enter building dims to compute gap' : Math.abs(deltaPct) <= 5 ? `Within ±5% — fits` : deltaSf > 0 ? `+${deltaPct}% slack` : `${deltaPct}% short`;
        return `
          ${requiredBlock}
          <div style="padding:10px 12px;background:#fff;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:12px;color:var(--ies-gray-700);margin-bottom:8px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:4px;">Existing building</div>
            <div class="wsc-config-row" style="margin-bottom:6px;">
              <div class="wsc-config-field"><label>Width (ft)</label><input type="number" value="${facility.buildingWidth || 0}" data-fac="buildingWidth" /></div>
              <div class="wsc-config-field"><label>Depth (ft)</label><input type="number" value="${facility.buildingDepth || 0}" data-fac="buildingDepth" /></div>
            </div>
            <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Footprint area</span><strong>${haveBuilt ? builtSf.toLocaleString() + ' sf' : '—'}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0 2px;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:${gapColor};"><span>Gap</span><strong>${haveBuilt ? (deltaSf >= 0 ? '+' : '') + deltaSf.toLocaleString() + ' sf · ' : ''}${gapLabel}</strong></div>
          </div>
          <div style="border-top:1px dashed var(--ies-gray-300);padding-top:8px;margin-top:4px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ies-gray-500);margin-bottom:6px;">Constraint dims</div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label>Col Spacing (ft)</label><input type="number" value="${facility.columnSpacingX || 50}" data-fac="columnSpacingX" /></div>
              <div class="wsc-config-field"><label>Office SF</label><input type="number" value="${zones.officeSqft}" data-zone="officeSqft" /></div>
            </div>
            <div class="wsc-config-row">
              <div class="wsc-config-field"><label>Recv Staging SF</label><input type="number" value="${zones.receiveStagingSqft}" data-zone="receiveStagingSqft" /></div>
              <div class="wsc-config-field"><label>Ship Staging SF</label><input type="number" value="${zones.shipStagingSqft}" data-zone="shipStagingSqft" /></div>
            </div>
          </div>
        `;
      })()}
    </div>

  `;
}


function bindConfigEvents(panel) {
  const debouncedRender = debounceRender(renderContentView, 100);

  // Facility fields (with input debounce for live update)
  panel.querySelectorAll('[data-fac]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fac;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      facility[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Phase 2 redesign — boolean facility toggles (bottom-beam, override).
  // Re-renders the Configure panel itself when toggled because the override
  // toggle hides/shows the dims editor.
  panel.querySelectorAll('[data-fac-bool]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.facBool;
      facility[field] = !!(/** @type {HTMLInputElement} */ (e.target)).checked;
      isDirty = true;
      // Override toggle re-renders the panel (to flip dim editor visibility);
      // bottom-beam toggles only re-render the content view.
      if (field === 'buildingDimsOverride') renderConfigPanel();
      renderContentView();
    });
  });

  // Phase A redesign (2026-05-05) — Sizing Mode toggle (Design / Constraint).
  // Re-renders both the Configure panel (Step 5 changes shape) and the content
  // view (rendering swaps to mode-aware footprint). Phase E fix: also refresh
  // the chrome KPI strip so the mode-aware chip label (Sized SF / Built SF)
  // doesn't stay stale on mode toggle.
  panel.querySelectorAll('[data-wsc-mode]').forEach(btn => {
    btn.addEventListener('click', e => {
      const next = /** @type {HTMLElement} */ (e.currentTarget).dataset.wscMode;
      if (next !== 'design' && next !== 'constraint') return;
      if (facility.sizingMode === next) return;
      facility.sizingMode = next;
      // Keep buildingDimsOverride coherent with the new mode for any code
      // path still consulting the legacy boolean. Constraint = override on;
      // design = override off.
      facility.buildingDimsOverride = (next === 'constraint');
      isDirty = true;
      renderConfigPanel();
      renderContentView();
      _refreshWscKpis();
    });
  });

  // Phase B redesign (2026-05-05) — Primary inventory input toggle
  // (Throughput / Pallet Positions). Re-renders the panel because Step 1
  // inputs swap between throughput and pallet primary fields. Phase E fix:
  // also refresh KPI strip — when primary-input toggles, the engine-derived
  // peakUnits source changes, which can shift the sized total.
  panel.querySelectorAll('[data-wsc-primary]').forEach(btn => {
    btn.addEventListener('click', e => {
      const next = /** @type {HTMLElement} */ (e.currentTarget).dataset.wscPrimary;
      if (next !== 'throughput' && next !== 'pallets') return;
      if ((facility.primaryInventoryInput || 'throughput') === next) return;
      facility.primaryInventoryInput = next;
      isDirty = true;
      renderConfigPanel();
      renderContentView();
      _refreshWscKpis();
    });
  });

  // Zone fields (with input debounce for live update)
  panel.querySelectorAll('[data-zone]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.zone;
      zones[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Volume fields (with input debounce for live update)
  panel.querySelectorAll('[data-vol]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.vol;
      volumes[field] = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Storage allocation inputs — facility-level (legacy single mix).
  // Phase B redesign (2026-05-05): replaced sliders with numeric inputs +
  // sum-validation pill. Handler now re-renders the Configure panel so the
  // pill updates and the per-channel "inheriting" rows reflect new facility
  // defaults (fixes a Phase 2 bug where inheriting channels didn't refresh
  // when facility-level allocation changed).
  panel.querySelectorAll('input[data-alloc]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.alloc;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!zones.storageAllocation) zones.storageAllocation = { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
      zones.storageAllocation[field] = val;
      isDirty = true;
      renderConfigPanel();
      renderContentView();
    });
  });

  // Phase 4 Layer B (volumes-as-nucleus, 2026-04-29) — per-channel
  // storageAllocation override inputs. First write to a channel auto-promotes
  // it from "inheriting facility" to "explicit override" (storageAllocation
  // populated on the channel mix). Reset (↻) wipes the override.
  panel.querySelectorAll('input[data-channel-alloc]').forEach(input => {
    input.addEventListener('change', e => {
      const tgt = /** @type {HTMLInputElement} */ (e.target);
      const field = tgt.dataset.channelAlloc;
      const k = tgt.dataset.channelKey;
      const val = parseFloat(tgt.value) || 0;
      const facAlloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
      if (!Array.isArray(zones.channelMixes)) return;
      const mix = zones.channelMixes.find(m => m.channelKey === k);
      if (!mix) return;
      if (!mix.storageAllocation) {
        // Promote to override — seed from facility default.
        mix.storageAllocation = {
          fullPallet: facAlloc.fullPallet || 0,
          cartonOnPallet: facAlloc.cartonOnPallet || 0,
          cartonOnShelving: facAlloc.cartonOnShelving || 0,
        };
      }
      mix.storageAllocation[field] = val;
      isDirty = true;
      renderConfigPanel();
      renderContentView();
    });
  });
  panel.querySelectorAll('[data-channel-alloc-reset]').forEach(btn => {
    btn.addEventListener('click', e => {
      const k = /** @type {HTMLElement} */ (e.currentTarget).dataset.channelAllocReset;
      if (!Array.isArray(zones.channelMixes)) return;
      const mix = zones.channelMixes.find(m => m.channelKey === k);
      if (!mix) return;
      delete mix.storageAllocation;
      isDirty = true;
      renderConfigPanel();
      renderContentView();
    });
  });

  // Product dimension fields (with input debounce for live update)
  panel.querySelectorAll('[data-prod]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.prod;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!zones.productDimensions) zones.productDimensions = { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 };
      zones.productDimensions[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Dock configuration fields (with input debounce for live update)
  panel.querySelectorAll('[data-dock]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.dock;
      const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
      if (!zones.dockConfig) zones.dockConfig = { sided: 'single', inboundDoors: 10, outboundDoors: 12, palletsPerDockHour: 12, dockOperatingHours: 10 };
      zones.dockConfig[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Inventory parameters (with input debounce for live update)
  panel.querySelectorAll('[data-inv]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.inv;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      zones[field] = val;
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Forward pick fields. Phase B (2026-05-05): the legacy display-toggle path
  // relied on #wsc-fwd-opts / #wsc-fwd-params / #wsc-fwd-outbound DOM ids that
  // disappeared when Forward Pick was lifted into Step 4 with conditional
  // template-literal rendering. Now: when 'enabled' toggles, re-render the
  // Configure panel so the sub-block flips visibility correctly.
  panel.querySelectorAll('[data-fwd]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fwd;
      if (!zones.forwardPick) zones.forwardPick = { enabled: false, type: 'carton_flow', skuCount: 2000, daysInventory: 3, outboundUnitsPerDay: 5000 };
      if (field === 'enabled') {
        zones.forwardPick[field] = /** @type {HTMLInputElement} */ (e.target).checked;
      } else {
        const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
        zones.forwardPick[field] = val;
      }
      isDirty = true;
    };
    input.addEventListener('change', (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fwd;
      handleChange(e);
      // Toggling enabled flips the conditional sub-block; re-render the panel.
      if (field === 'enabled') renderConfigPanel();
      renderContentView();
    });
    // Keep input-event live update for non-enabled fields (text/number).
    if (input.type !== 'checkbox') {
      input.addEventListener('input', (e) => {
        handleChange(e);
        debouncedRender();
      });
    }
  });

  // Optional zone fields (with input debounce for live update)
  panel.querySelectorAll('[data-opt]').forEach(input => {
    const handleChange = (e) => {
      const key = /** @type {HTMLInputElement} */ (e.target).dataset.opt;
      if (!zones.optionalZones) zones.optionalZones = { vas: { enabled: false, sqft: 0 }, returns: { enabled: false, sqft: 0 }, chargeback: { enabled: false, sqft: 0 } };
      if (key.endsWith('-enabled')) {
        const zone = key.replace('-enabled', '');
        zones.optionalZones[zone].enabled = /** @type {HTMLInputElement} */ (e.target).checked;
        const sqftDiv = panel.querySelector(`#wsc-opt-${zone}-row`);
        if (sqftDiv) sqftDiv.style.display = zones.optionalZones[zone].enabled ? 'grid' : 'none';
      } else if (key.endsWith('-sqft')) {
        const zone = key.replace('-sqft', '');
        zones.optionalZones[zone].sqft = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  // Custom zone management (with input debounce for live update)
  panel.querySelectorAll('[data-custom-name], [data-custom-sqft]').forEach(input => {
    const handleChange = (e) => {
      const idx = parseInt(/** @type {HTMLInputElement} */ (e.target).dataset.customName || /** @type {HTMLInputElement} */ (e.target).dataset.customSqft);
      if (!zones.customZones) zones.customZones = [];
      if (e.target.dataset.customName !== undefined) {
        zones.customZones[idx].name = /** @type {HTMLInputElement} */ (e.target).value;
      } else {
        zones.customZones[idx].sqft = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      }
      isDirty = true;
    };
    input.addEventListener('input', (e) => {
      handleChange(e);
      debouncedRender();
    });
    input.addEventListener('change', (e) => {
      handleChange(e);
      renderContentView();
    });
  });

  panel.querySelectorAll('[data-custom-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const idx = parseInt(/** @type {HTMLElement} */ (e.target).dataset.customRemove);
      if (zones.customZones) zones.customZones.splice(idx, 1);
      isDirty = true;
      renderConfigPanel();
      renderContentView();
    });
  });

  panel.querySelector('[data-action="wsc-add-custom-zone"]')?.addEventListener('click', () => {
    if (!zones.customZones) zones.customZones = [];
    zones.customZones.push({ name: `Custom Zone ${zones.customZones.length + 1}`, sqft: 2000 });
    isDirty = true;
    renderConfigPanel();
    renderContentView();
  });

  // Phase 4 of volumes-as-nucleus (Layer A, 2026-04-29): Pull-from-CM button.
  // Re-fetches the linked cost model and re-runs the channel-aware payload
  // builder, then applies it through handleCmPush so volumes (and zones'
  // peakUnitsPerDay) refresh in place.
  panel.querySelector('[data-action="wsc-pull-from-cm"]')?.addEventListener('click', async () => {
    const cmId = facility.parent_cost_model_id;
    if (!cmId) {
      showToast('No linked Cost Model on this scenario.', 'error');
      return;
    }
    try {
      const row = await cmApi.getModel(cmId);
      const cmModel = (row && row.model_data) ? row.model_data : row;
      if (!cmModel) {
        showToast('Could not load linked Cost Model.', 'error');
        return;
      }
      // backfillChannelsFromLegacy ensures synthetic channels exist on legacy models.
      try { cmApi.backfillChannelsFromLegacy(cmModel); } catch {}
      const payload = cmApi.buildWscLaunchPayload(cmModel);
      handleCmPush(payload);
      isDirty = true;
      showToast('Pulled volume defaults from Cost Model.', 'success');
    } catch (e) {
      console.warn('[WSC] Pull from CM failed:', e);
      showToast('Pull from CM failed - see console.', 'error');
    }
  });

  // Toolbar
  panel.querySelector('[data-action="wsc-new"]')?.addEventListener('click', async () => {
    if (isDirty && !(await showConfirm('Unsaved changes. Start new?'))) return;
    facility = createDefaultFacility();
    zones = createDefaultZones();
    volumes = createDefaultVolumes();
    isDirty = false;
    renderConfigPanel();
    renderContentView();
  });

  // 2026-04-27 EVE: wsc-back delegated on rootEl. The button now lives in
  // tool-frame.js's top header strip (outside #wsc-config), so a panel-scoped
  // listener never fired. Delegated on root so any data-action="wsc-back"
  // click — wherever it lives in the tool DOM — routes here.
  rootEl?.addEventListener('click', async (e) => {
    if (!(/** @type {HTMLElement} */ (e.target))?.closest?.('[data-action="wsc-back"]')) return;
    if (isDirty && !(await showConfirm('Unsaved changes. Leave for the scenarios list?'))) return;
    isDirty = false;
    viewMode = 'landing';
    await renderLanding();
  });

  // Copy-summary button
  panel.querySelector('[data-action="wsc-copy-summary"]')?.addEventListener('click', () => {
    copySummaryToClipboard();
  });

  panel.querySelector('[data-action="wsc-save"]')?.addEventListener('click', async (e) => {
    // Phase 4 (2026-05-04): delegate to handleSaveWsc so the WSC→CM writeback
    // path runs from this button too. Pre-Phase-4 this had its own inline
    // save that bypassed the writeback logic, so saves from the side-panel
    // legacy save button silently skipped the CM update.
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await handleSaveWsc();
      btn.textContent = '✓ Saved';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    } catch (err) {
      console.error('[WSC] Save failed:', err);
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // 2026-04-21 audit: legacy `[data-action="wsc-load"]` prompt()-based loader
  // removed — scenario loading now flows through the standard scenarioLanding
  // shell (← Scenarios button at top of config panel). Handler block deleted
  // rather than left as dead code.
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
      () => showWscToast('Summary copied to clipboard', 'success'),
      () => showWscToast('Clipboard write failed', 'error'),
    );
  } else {
    showWscToast('Clipboard not available', 'error');
  }
}

function showWscToast(message, level) {
  const color = level === 'error' ? '#dc2626' : level === 'info' ? '#2563eb' : '#16a34a';
  const bg    = level === 'error' ? '#fef2f2' : level === 'info' ? '#eff6ff' : '#f0fdf4';
  const existing = document.getElementById('wsc-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'wsc-toast';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;padding:12px 16px;border-radius:8px;border:1px solid ${color};background:${bg};color:${color};font-size:13px;font-weight:600;z-index:9999;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,.12);`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
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
  if (activeView !== '3d' && scene3d) {
    scene3d.dispose();
    scene3d = null;
  }

  switch (activeView) {
    case 'dashboard': container.innerHTML = renderDashboard(); break;
    case 'plan':
      container.innerHTML = renderPlan();
      requestAnimationFrame(() => drawPlan());
      break;
    case 'elevation':
      container.innerHTML = renderElevation();
      requestAnimationFrame(() => drawElevation());
      break;
    case '3d': render3DView(container); break;
  }
}

// ============================================================
// 2D PLAN VIEW (Top-down floorplan)
// ============================================================

function renderPlan() {
  const storage = calc.computeStorage(facility, zones);
  const overrideKeys = Object.keys(zones.layoutOverrides || {});
  const editing = !!_planEditMode;

  // Shrink-suggestion CTA — when the building is over-built (current dims
  // hold significantly more rack capacity than the entered inventory needs),
  // surface a one-click "right-size" banner above the canvas. Mirrors the
  // canvas's widthFt/depthFt computation so banner/canvas always agree.
  // Phase A (2026-05-05): Constraint-mode only. In Design mode the rendering
  // already equals the sized footprint, so a "shrink" suggestion would loop.
  let shrinkSuggestion = { recommended: false };
  if ((facility.sizingMode || 'design') === 'constraint') try {
    const _sizedForCta = calc.sizeFacility(toSizingInputs());
    const _orientUser = calc.orientFacility(facility);
    const _userFits = (_orientUser.longFt * _orientUser.shortFt) >= _sizedForCta.totalSqft * 0.98 && !_orientUser.derived;
    // Only recommend a shrink when the user-entered dims actually fit the
    // inventory. If the building is too small, the engine falls back to
    // showing derived 1.5:1 dims on the canvas — recommending another
    // shrink against those derived dims would be a feedback cycle.
    const _wFt = _userFits ? _orientUser.longFt  : 0;
    const _dFt = _userFits ? _orientUser.shortFt : 0;
    if (_wFt > 0 && _dFt > 0) {
      const _aisleFt     = facility.aisleWidth || calc.AISLE_WIDTHS[facility.storageType] || 12;
      const _rackDepthFt = calc.rackDepthFt(facility.storageType, facility);
      const _moduleFt    = 2 * _rackDepthFt + _aisleFt;
      const _sideMargin  = 6;
      const _modulesFit  = Math.floor((_wFt - 2 * _sideMargin) / _moduleFt);
      const _totalCols   = Math.max(0, _modulesFit * 2);
      // Master plan: same as the 2D plan rack-run (depth - 8ft top - 8ft bot margins).
      const _runFt = Math.max(0, _dFt - 16);
      const _xa    = calc.crossAisleLayoutFt(_runFt);
      const _segs  = Array.from({ length: _xa.segmentCount }, () => _xa.segmentLenFt);
      const _alloc = calc.allocateRackColsByTarget({
        totalCols: _totalCols,
        segmentLensFt: _segs,
        palletLevels:   _sizedForCta.rackLevels  || 5,
        shelvingLevels: _sizedForCta.shelfLevels || 5,
        fullPalletTarget:   +_sizedForCta.positions?.fullPalletGrossPositions   || 0,
        cartonPalletTarget: +_sizedForCta.positions?.cartonPalletGrossPositions || 0,
        shelvingTarget:     +_sizedForCta.positions?.shelvingGrossPositions     || 0,
      });
      const _used = _alloc.fullPalletCols + _alloc.cartonPalletCols + _alloc.shelvingCols;
      shrinkSuggestion = calc.suggestedBuildingDimensions({
        totalCols: _totalCols, usedCols: _used,
        moduleFt: _moduleFt, sideMarginFt: _sideMargin,
        currentWidthFt: _wFt, currentDepthFt: _dFt,
        // Honor total facility SF so suggested width holds dock + office +
        // staging + forward-pick too, not just the rack columns.
        minTotalSqft: _sizedForCta.totalSqft,
      });
    }
  } catch (e) {
    console.warn('[WSC] shrink suggestion failed:', e);
  }

  // Phase D (2026-05-05) — Capacity-status strip above the canvas (Constraint
  // mode only). Mirrors the Dashboard Capacity Check panel: shows
  // Required vs Existing + Gap with color-coded status chip. Renders
  // unconditionally when in Constraint mode with user dims set; the older
  // shrink-suggestion CTA below still fires only on significant over-build.
  let capacityStatus = null;
  if ((facility.sizingMode || 'design') === 'constraint') {
    try {
      const _sizedCs = calc.sizeFacility(toSizingInputs());
      const _required = _sizedCs?.requirementsDriven?.totalSfRequired || _sizedCs?.totalSqft || 0;
      const _builtSf = (+facility.buildingWidth || 0) * (+facility.buildingDepth || 0);
      if (_required > 0 && _builtSf > 0) {
        const _delta = _builtSf - _required;
        const _pct = Math.round((_delta / _required) * 1000) / 10;
        const _status = Math.abs(_pct) <= 5 ? 'on-target' : _delta > 0 ? 'slack' : 'short';
        capacityStatus = {
          required: _required,
          built: _builtSf,
          delta: _delta,
          pct: _pct,
          status: _status,
        };
      }
    } catch (e) { /* swallow */ }
  }

  return `
    <div class="hub-card">
      ${capacityStatus ? `
        <div style="margin-bottom:var(--sp-2);padding:8px 14px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:12px;background:${capacityStatus.status === 'on-target' ? '#ecfdf5' : capacityStatus.status === 'slack' ? '#eff6ff' : '#fff7ed'};border:1px solid ${capacityStatus.status === 'on-target' ? '#a7f3d0' : capacityStatus.status === 'slack' ? '#bfdbfe' : '#fed7aa'};">
          <span style="font-size:14px;line-height:1;">${capacityStatus.status === 'on-target' ? '✓' : capacityStatus.status === 'slack' ? '◭' : '⚠'}</span>
          <span style="flex:1;line-height:1.5;color:${capacityStatus.status === 'on-target' ? '#065f46' : capacityStatus.status === 'slack' ? '#1e3a8a' : '#9a3412'};">
            <strong>${capacityStatus.status === 'on-target' ? 'On target' : capacityStatus.status === 'slack' ? `Capacity slack: +${capacityStatus.pct}%` : `Inventory short: ${capacityStatus.pct}%`}</strong>
            — Required <strong>${capacityStatus.required.toLocaleString()} sf</strong> · Existing <strong>${capacityStatus.built.toLocaleString()} sf</strong> · Gap <strong>${capacityStatus.delta >= 0 ? '+' : ''}${capacityStatus.delta.toLocaleString()} sf</strong>
          </span>
        </div>
      ` : ''}
      ${shrinkSuggestion.recommended ? `
        <div style="margin-bottom:var(--sp-2); padding:10px 14px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; font-size:12px; display:flex; align-items:center; gap:12px;">
          <span style="font-size:16px;line-height:1;">📐</span>
          <span style="flex:1;line-height:1.5;">
            <strong style="color:#1e3a8a;">Building over-sized by ${shrinkSuggestion.oversizePct}%</strong>
            for the entered inventory. Right-size to
            <strong>${shrinkSuggestion.suggestedWidthFt.toLocaleString()} × ${shrinkSuggestion.suggestedDepthFt.toLocaleString()} ft</strong>
            <span style="color:var(--ies-gray-500);">(currently ${shrinkSuggestion.currentWidthFt.toLocaleString()} × ${shrinkSuggestion.currentDepthFt.toLocaleString()} ft)</span>?
          </span>
          <button class="hub-btn-primary" data-wsc-action="apply-shrink-suggestion"
                  data-suggested-width="${shrinkSuggestion.suggestedWidthFt}"
                  data-suggested-depth="${shrinkSuggestion.suggestedDepthFt}"
                  style="font-size:12px;padding:5px 14px;flex:none;">
            Apply
          </button>
        </div>
      ` : ''}
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom: var(--sp-2);gap:12px;flex-wrap:wrap;">
        <h3 class="text-subtitle" style="margin:0;">Floorplan (Top-Down)</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="text-caption text-muted">Scale: 1 px ≈ ${Math.max(1, Math.round(Math.sqrt((facility.totalSqft || 0) * 1.5) / 800))} ft</span>
          ${overrideKeys.length > 0 ? `
            <button class="hub-btn-link" data-wsc-action="reset-layout" title="Discard manual repositions and revert to auto-layout">
              ↺ Reset Layout (${overrideKeys.length})
            </button>
          ` : ''}
          <button class="${editing ? 'hub-btn-primary' : 'hub-btn-secondary'}" data-wsc-action="toggle-edit-layout" style="font-size:12px;padding:4px 10px;" title="Drag Office, Ship Staging, and Forward Pick to manually reposition them">
            ${editing ? '✓ Done Editing' : '✎ Edit Layout'}
          </button>
        </div>
      </div>
      <div style="position:relative;">
        <canvas id="wsc-plan-canvas" width="900" height="520" style="width:100%; border:1px solid var(--ies-gray-200); border-radius:6px; background:#fff; ${editing ? 'cursor: grab;' : ''}"></canvas>
        ${editing ? `
          <div style="margin-top:8px;padding:8px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:12px;color:#1e3a8a;">
            <strong>Edit mode:</strong> drag Office, Ship Staging, or Forward Pick zones to reposition them. Snaps to 5 ft. Save the model to persist.
          </div>
        ` : ''}
      </div>
      <div style="margin-top:var(--sp-3); display:flex; flex-wrap:wrap; gap:14px; font-size:11px; color:var(--ies-gray-500);">
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#ea580c;border:1px solid #9a3412;border-radius:2px;"></span>Full Pallet Rack</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#f59e0b;border:1px solid #b45309;border-radius:2px;"></span>Carton on Pallet</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#0d9488;border:1px solid #0f766e;border-radius:2px;"></span>Carton Shelving</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#ede9fe;border:1px solid #7c3aed;border-radius:2px;"></span>Forward Pick</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#ecfdf5;border:1px solid #16a34a;border-radius:2px;"></span>Receive Staging</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#fffbeb;border:1px solid #d97706;border-radius:2px;"></span>Ship Staging</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#f5f3ff;border:1px solid #8b5cf6;border-radius:2px;"></span>Office</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#fecaca;border:1px solid #7f1d1d;border-radius:2px;"></span>Outbound Door</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;background:#bfdbfe;border:1px solid #1d4ed8;border-radius:2px;"></span>Inbound Door</span>
      </div>
    </div>
  `;
}

function drawPlan() {
  const canvas = rootEl?.querySelector('#wsc-plan-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Pull sized facility numbers so this view agrees with the dashboard.
  const sized = calc.sizeFacility(toSizingInputs());
  // Phase A: route elevation params through mode-aware facility shape.
  const elev = calc.elevationParams(_renderFacility(facility, sized));
  // Brock 2026-04-20: floorplan scale uses sized SF (the computed answer)
  // when the user hasn't set an Existing/Target SF constraint. This way
  // the 2D view renders as soon as peak units / storage inputs are
  // populated, without requiring the user to first guess a total SF.
  const totalSqft = facility.totalSqft || sized.totalSqft || 0;
  if (totalSqft <= 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Enter peak units + storage inputs — the tool will size the floorplan.', cw / 2, ch / 2);
    return;
  }

  // Building dimensions (ft) — Phase A (2026-05-05): mode-aware via
  // _renderFacility helper. Design mode → engine's suggested footprint
  // (no empty-building visual). Constraint mode → user W×D (empty space
  // surfaces as capacity slack; dashboard shows gap %).
  //
  // WSC-O1 (2026-05-04): single source of truth for orientation lives in
  // calc.orientFacility() — Plan / Elevation / 3D all consume it. Convention:
  // dock-on-long-edge, longFt rendered horizontal, shortFt vertical.
  let _orient = calc.orientFacility(_renderFacility(facility, sized));
  if (!(_orient.longFt > 0 && _orient.shortFt > 0)) {
    _orient = calc.orientFacility({ totalSqft });
  }
  const widthFt = _orient.longFt;
  const depthFt = _orient.shortFt;

  // Fit-to-canvas with padding for dimension labels
  const padX = 60, padY = 60;
  const usableW = cw - padX * 2;
  const usableH = ch - padY * 2;
  const pxPerFt = Math.min(usableW / widthFt, usableH / depthFt);

  const Wpx = widthFt * pxPerFt;
  const Hpx = depthFt * pxPerFt;
  const X0  = (cw - Wpx) / 2;
  const Y0  = (ch - Hpx) / 2;

  // ---------- Outer shell ----------
  ctx.fillStyle = '#fafafa';
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 2;
  ctx.fillRect(X0, Y0, Wpx, Hpx);
  ctx.strokeRect(X0, Y0, Wpx, Hpx);

  // ---------- Layout convention (top-down view) ----------
  //   Top edge      = back of building (single-sided) or inbound dock face (two-sided)
  //   Bottom edge   = dock face (where trucks pull up)
  //   Strip just inside dock face (bottom)  = Ship Staging  (sized.shipStagingSqft)
  //   Strip just below back-wall (top)      = Receive Staging (sized.recvStagingSqft)
  //   Front-left corner of storage area     = Office (full-height block; rack loop skips this X range)
  //   Storage racks fill the rest of the interior between recv + ship strips
  const twoSidedLayout = (zones.dockConfig?.sided === 'two');
  const shipFrac  = Math.min(0.30, (sized.shipStagingSqft / Math.max(1, sized.totalSqft)));
  const recvFrac  = Math.min(0.18, (sized.recvStagingSqft / Math.max(1, sized.totalSqft)));

  const shipHpx  = Math.max(20, shipFrac  * Hpx);
  // Two-sided dock requires a visible receive-staging strip inboard of the
  // top dock face, even when the engine returned zero (e.g., user hasn't
  // entered an inbound volume yet). Force a minimum of 20px in that case so
  // the top wall visually communicates its dual-use staging function.
  const recvHpx  = twoSidedLayout
    ? Math.max(20, recvFrac > 0 ? recvFrac * Hpx : shipHpx * 0.8)
    : (recvFrac > 0.01 ? Math.max(16, recvFrac * Hpx) : 0);

  const storageY = Y0 + recvHpx;
  const storageH = Hpx - recvHpx - shipHpx;

  // Reset the rect registry each redraw — overlay hit-testing reads from it.
  _planZoneRects = {};

  // Resolve a zone's rendered top-left + dimensions, honoring manual layout
  // overrides when edit mode has captured one. Overrides are stored in
  // building-relative feet so they survive resolution changes.
  // Shape: { x, y, w, h } — w/h are optional; falls back to autoWPx/autoHPx
  // when omitted. Move-drag writes x/y; resize-drag writes w/h.
  const applyOverride = (zoneId, autoXPx, autoYPx, autoWPx, autoHPx) => {
    const o = zones.layoutOverrides?.[zoneId];
    if (!o) return { x: autoXPx, y: autoYPx, w: autoWPx, h: autoHPx };
    const x = (o.x !== undefined && o.x !== null) ? X0 + o.x * pxPerFt : autoXPx;
    const y = (o.y !== undefined && o.y !== null) ? Y0 + o.y * pxPerFt : autoYPx;
    const w = (o.w !== undefined && o.w !== null && autoWPx !== undefined) ? Math.max(20, o.w * pxPerFt) : autoWPx;
    const h = (o.h !== undefined && o.h !== null && autoHPx !== undefined) ? Math.max(20, o.h * pxPerFt) : autoHPx;
    return { x, y, w, h };
  };

  // Office: dimension as a near-square footprint based on actual sqft.
  // Placed in the front-left corner of the storage area, abutting the ship
  // staging strip below it. Rack loop will skip this X range.
  const officeSideFt = Math.sqrt(Math.max(1, sized.officeSqft));
  const _officeAutoW = Math.min(Wpx * 0.35, officeSideFt * pxPerFt);
  const _officeAutoH = Math.min(storageH * 0.75, officeSideFt * pxPerFt);
  const _officeAutoX = X0 + 4;
  const _officeAutoY = storageY + storageH - _officeAutoH;
  const _officePos   = applyOverride('office', _officeAutoX, _officeAutoY, _officeAutoW, _officeAutoH);
  const officeX      = _officePos.x;
  const officeY      = _officePos.y;
  const officeWpx    = _officePos.w;
  const officeHpx    = _officePos.h;
  const officeRightX = officeX + officeWpx + 4 * pxPerFt; // small clearance gap
  _planZoneRects.office = { x: officeX, y: officeY, w: officeWpx, h: officeHpx };

  // ---------- Storage rack rows ----------
  // Back-to-back rack pairs with aisles between them.
  const rackDepthFt = elev.rackDepthFt || 4.3;
  const aisleFt     = (facility.aisleWidth || elev.aisleWidth || 12);
  const moduleFt    = (2 * rackDepthFt) + aisleFt;
  const rackPx      = rackDepthFt * pxPerFt;
  const aislePx     = aisleFt * pxPerFt;
  const modulePx    = moduleFt * pxPerFt;
  const sideMarginPx = Math.max(8, 6 * pxPerFt);

  // Light storage background fills the storage zone
  ctx.fillStyle = '#f0f7ff';
  ctx.fillRect(X0 + 2, storageY, Wpx - 4, storageH);

  // Forward Pick Area: takes a strip along the FRONT of storage (between
  // racks and ship staging) when enabled. Rack loop will shorten its
  // racksBottom to clear the FP strip.
  const fpEnabled = !!zones.forwardPick?.enabled;
  const fpSqft    = fpEnabled ? Math.max(2000, Math.min(30000, (zones.forwardPick.skuCount || 2000) * 6)) : 0;
  // Visual strip height: scale FP sqft to footprint width × strip height
  const fpStripFt = fpEnabled ? Math.min(60, Math.max(20, fpSqft / Math.max(1, widthFt - (officeWpx / pxPerFt + 8)))) : 0;
  const _fpAutoStripPx = fpStripFt * pxPerFt;
  const _fpAutoY  = storageY + storageH - _fpAutoStripPx;
  const _fpAutoX  = officeX + officeWpx + 2;
  const _fpAutoW  = X0 + Wpx - 2 - _fpAutoX;
  const _fpPos    = applyOverride('forwardPick', _fpAutoX, _fpAutoY, _fpAutoW, _fpAutoStripPx);
  const fpY       = _fpPos.y;
  const fpX       = _fpPos.x;
  const fpW       = _fpPos.w;
  const fpStripPx = _fpPos.h;
  if (fpEnabled) {
    _planZoneRects.forwardPick = { x: fpX, y: fpY, w: fpW, h: fpStripPx };
  }

  // First pass: count rack columns available, then size per-type via the
  // shared target-driven helper (see calc.allocateRackColsByTarget). This
  // matches the 3D scene's allocation, so 2D plan zone widths agree with
  // the 3D HUD's per-type counts. Pre-fix this used inventory mix
  // percentages, which over-fills shelving by ~6× because shelving bays
  // are 1.4× denser and shelving levels typically exceed pallet levels.
  let totalCols = 0;
  {
    let mxScan = X0 + sideMarginPx;
    while (mxScan + 2 * rackPx + aislePx < X0 + Wpx - sideMarginPx) {
      totalCols += 2;
      mxScan += modulePx;
    }
  }
  const _2dPalletLevels   = sized.rackLevels  || 5;
  const _2dShelvingLevels = sized.shelfLevels || 5;
  const _2dPlanFullRunFt  = ((storageY + storageH - 8 * pxPerFt) - (storageY + 8 * pxPerFt)) / pxPerFt;
  const _2dPlanXa         = calc.crossAisleLayoutFt(_2dPlanFullRunFt);
  const _2dPlanSegLensFt  = Array.from(
    { length: _2dPlanXa.segmentCount },
    () => _2dPlanXa.segmentLenFt,
  );
  const _alloc2D = calc.allocateRackColsByTarget({
    totalCols,
    segmentLensFt: _2dPlanSegLensFt,
    palletLevels:   _2dPalletLevels,
    shelvingLevels: _2dShelvingLevels,
    fullPalletTarget:   +sized.positions?.fullPalletGrossPositions   || 0,
    cartonPalletTarget: +sized.positions?.cartonPalletGrossPositions || 0,
    shelvingTarget:     +sized.positions?.shelvingGrossPositions     || 0,
    // Phase F (2026-05-05) — Design mode pads leftover cols across types
    // so the rack zone is visually full (eliminates the empty-floor strip
    // on the right that surfaced in Brock's Phase E walkthrough).
    // Constraint mode keeps target-only allocation so leftover-as-slack
    // can be visualized + drive the shrink-CTA.
    fillMode: (facility.sizingMode || 'design') === 'design' ? 'fill' : 'target',
  });
  const fullPalletCols   = _alloc2D.fullPalletCols;
  const cartonPalletCols = _alloc2D.cartonPalletCols;
  const shelvingCols     = _alloc2D.shelvingCols;

  // Storage type styles: orange = full pallet, amber = carton on pallet,
  // teal = carton shelving (drawn as shorter, denser blocks).
  const TYPES = [
    { count: fullPalletCols,   fill: '#ea580c', stroke: '#9a3412', label: 'Full Pallet'      },
    { count: cartonPalletCols, fill: '#f59e0b', stroke: '#b45309', label: 'Carton on Pallet' },
    { count: shelvingCols,     fill: '#0d9488', stroke: '#0f766e', label: 'Carton Shelving'  },
  ];

  // Rack loop — coloured by storage type, shortened around office and FP.
  ctx.lineWidth = 1;
  // ─────────────────────────────────────────────────────────────────
  // Master cross-aisle plan: compute ONCE for the full building rack run
  // (uninterrupted by office / forward-pick), then every column intersects
  // its own [racksTop, racksBottom] window with the same set of master
  // segment Y-positions. This guarantees cross-aisles ALIGN across all
  // storage zones — full-pallet, carton-on-pallet, and shelving columns
  // share the same horizontal cross-aisle bands. (Pre-fix each column ran
  // crossAisleLayoutFt independently against its own truncated length, so
  // adjacent columns produced different segment counts and the cross-aisles
  // jagged at zone boundaries.)
  // ─────────────────────────────────────────────────────────────────
  const _planRacksTopFull    = storageY + 8 * pxPerFt;
  const _planRacksBottomFull = storageY + storageH - 8 * pxPerFt;
  const _planFullRunFt       = (_planRacksBottomFull - _planRacksTopFull) / pxPerFt;
  const _planXaMaster        = calc.crossAisleLayoutFt(_planFullRunFt);
  const _planSegPx           = Math.max(8, _planXaMaster.segmentLenFt * pxPerFt);
  const _planCrossPx         = _planXaMaster.crossAisleClearFt * pxPerFt;
  /** Master segment Y-bands (each {yStart, yEnd} in canvas px). Shared by every column. */
  const _planMasterSegments = [];
  {
    let cy = _planRacksTopFull;
    for (let s = 0; s < _planXaMaster.segmentCount; s++) {
      _planMasterSegments.push({ yStart: cy, yEnd: cy + _planSegPx });
      cy += _planSegPx + _planCrossPx;
    }
  }

  let mx = X0 + sideMarginPx;
  let colIdx = 0;
  let typeIdx = 0;
  let typeUsed = 0;
  while (mx + 2 * rackPx + aislePx < X0 + Wpx - sideMarginPx) {
    // Advance to next type bucket if we've drawn all of the current one
    while (typeIdx < TYPES.length && typeUsed >= TYPES[typeIdx].count) {
      typeIdx++;
      typeUsed = 0;
    }
    // Stop placing once every type's col budget is spent — leftover
    // cols become empty floor (over-built building) instead of silently
    // wrapping to shelving like pre-fix did.
    if (typeIdx >= TYPES.length) break;
    const t = TYPES[typeIdx];
    ctx.fillStyle   = t.fill;
    ctx.strokeStyle = t.stroke;

    const racksTop = _planRacksTopFull;
    let racksBottom = _planRacksBottomFull;

    // Shorten over office
    const colLeft  = mx;
    const colRight = mx + 2 * rackPx + 2;
    const overlapsOfficeX = colRight > officeX && colLeft < officeRightX;
    if (overlapsOfficeX) {
      racksBottom = Math.min(racksBottom, officeY - 4 * pxPerFt);
    }
    // Shorten over forward-pick strip (front-right of storage)
    const overlapsFpX = fpEnabled && colRight > fpX && colLeft < (fpX + fpW);
    if (overlapsFpX) {
      racksBottom = Math.min(racksBottom, fpY - 4 * pxPerFt);
    }

    const racksH = Math.max(0, racksBottom - racksTop);
    if (racksH > 0) {
      const drawSegment = (yTop, segH) => {
        if (segH <= 0) return;
        if (t.label === 'Carton Shelving') {
          // Shelving — denser short stacks inside the segment
          const sub = Math.max(8, segH / 3);
          for (let s = 0; s < 3; s++) {
            const segY = yTop + s * sub;
            ctx.fillRect(mx, segY, rackPx, sub * 0.7);
            ctx.strokeRect(mx, segY, rackPx, sub * 0.7);
            ctx.fillRect(mx + rackPx + 2, segY, rackPx, sub * 0.7);
            ctx.strokeRect(mx + rackPx + 2, segY, rackPx, sub * 0.7);
          }
        } else {
          ctx.fillRect(mx, yTop, rackPx, segH);
          ctx.strokeRect(mx, yTop, rackPx, segH);
          ctx.fillRect(mx + rackPx + 2, yTop, rackPx, segH);
          ctx.strokeRect(mx + rackPx + 2, yTop, rackPx, segH);
        }
      };

      // Intersect each master segment with this column's [racksTop, racksBottom]
      // window. Cross-aisles stay aligned across the whole building; columns
      // truncated by office / forward-pick simply lose their tail segments.
      for (const mseg of _planMasterSegments) {
        const segTop    = Math.max(mseg.yStart, racksTop);
        const segBottom = Math.min(mseg.yEnd,   racksBottom);
        const segH      = segBottom - segTop;
        if (segH > 0) drawSegment(segTop, segH);
      }
    }
    typeUsed += 2;
    colIdx += 2;
    mx += modulePx;
  }

  // ---------- Forward Pick Area (front strip of storage, when enabled) ----------
  if (fpEnabled && fpW > 80 && fpStripPx > 12) {
    ctx.fillStyle = '#ede9fe';
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 1;
    ctx.fillRect(fpX, fpY, fpW, fpStripPx);
    ctx.strokeRect(fpX, fpY, fpW, fpStripPx);
    // Carton-flow lane lines
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 0.5;
    for (let x = fpX + 4; x < fpX + fpW - 4; x += Math.max(8, 4 * pxPerFt)) {
      ctx.beginPath();
      ctx.moveTo(x, fpY + 4);
      ctx.lineTo(x, fpY + fpStripPx - 4);
      ctx.stroke();
    }
    ctx.fillStyle = '#5b21b6';
    ctx.font = 'bold 11px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Forward Pick  ·  ${(zones.forwardPick.type || 'carton flow').replace('_', ' ')}`, fpX + fpW / 2, fpY + fpStripPx / 2 + 4);
  }

  // Storage label (top of storage zone, right-aligned to clear the office)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 12px Montserrat, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(
    `Storage  ·  ${calc.formatSqft(sized.storageSqft)}  ·  ${totalCols} rack rows  ·  ${aisleFt} ft aisles`,
    X0 + Wpx - sideMarginPx,
    storageY + 14,
  );
  ctx.textAlign = 'left'; // restore

  // ---------- Receive Staging strip (top wall) ----------
  // In two-sided mode this strip doubles as the inboard staging for the
  // top dock face (inbound doors drawn at Y0 - 6). In single-sided mode it
  // represents back-wall receive staging when the engine sized one.
  if (recvHpx > 0) {
    ctx.fillStyle = '#ecfdf5';
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 1;
    ctx.fillRect(X0 + 2, Y0 + 2, Wpx - 4, recvHpx - 2);
    ctx.strokeRect(X0 + 2, Y0 + 2, Wpx - 4, recvHpx - 2);
    ctx.fillStyle = '#166534';
    ctx.font = 'bold 11px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    const recvSqft = sized.recvStagingSqft || 0;
    const label = recvSqft > 0
      ? `Receive Staging  ·  ${calc.formatSqft(recvSqft)}`
      : 'Receive Staging';
    ctx.fillText(label, X0 + Wpx / 2, Y0 + recvHpx / 2 + 4);
  }

  // ---------- Ship Staging strip (bottom, dock face, skipping office column) ----------
  // Office column reaches down to the dock face, so ship staging fills the
  // remaining width to the right of it.
  const _shipAutoX = officeX + officeWpx + 2;
  const _shipAutoY = Y0 + Hpx - shipHpx;
  const _shipAutoW = X0 + Wpx - 2 - _shipAutoX;
  const _shipAutoH = shipHpx - 2;
  const _shipPos   = applyOverride('shipStaging', _shipAutoX, _shipAutoY, _shipAutoW, _shipAutoH);
  const shipX      = _shipPos.x;
  const shipY      = _shipPos.y;
  const shipW      = _shipPos.w;
  const shipDrawH  = _shipPos.h;
  ctx.fillStyle = '#fffbeb';
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 1;
  ctx.fillRect(shipX, shipY, shipW, shipDrawH);
  ctx.strokeRect(shipX, shipY, shipW, shipDrawH);
  ctx.fillStyle = '#92400e';
  ctx.font = 'bold 11px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  if (shipW > 100) {
    ctx.fillText(`Ship Staging  ·  ${calc.formatSqft(sized.shipStagingSqft)}`, shipX + shipW / 2, shipY + shipDrawH / 2 + 4);
  }
  _planZoneRects.shipStaging = { x: shipX, y: shipY, w: shipW, h: shipDrawH };

  // ---------- Office (front-left corner, full block from storage down to dock face) ----------
  ctx.fillStyle = '#f5f3ff';
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 1;
  // Single tall block from officeY down to the dock face (covers part of storage zone + ship-staging zone)
  const officeBlockH = (Y0 + Hpx) - officeY - 4;
  ctx.fillRect(officeX, officeY, officeWpx, officeBlockH);
  ctx.strokeRect(officeX, officeY, officeWpx, officeBlockH);
  ctx.fillStyle = '#5b21b6';
  ctx.font = 'bold 11px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  if (officeWpx > 50 && officeBlockH > 28) {
    ctx.fillText('Office', officeX + officeWpx / 2, officeY + officeBlockH / 2 - 4);
    ctx.fillStyle = '#6b21a8';
    ctx.font = '10px Montserrat, sans-serif';
    ctx.fillText(`${calc.formatSqft(sized.officeSqft)}`, officeX + officeWpx / 2, officeY + officeBlockH / 2 + 12);
  }

  // ---------- Dock doors at bottom edge, aligned with ship staging ----------
  // Use the sized engine's door count so this view agrees with the KPI bar.
  const totalDoors = sized.dock.totalDoors || 0;
  const inboundDoors = sized.dock.inboundDoors || 0;
  const outboundDoors = sized.dock.outboundDoors || 0;
  const twoSided = (zones.dockConfig?.sided === 'two');

  function drawDoorRow(count, yTop, label, color, labelAbove, xStart, xEnd) {
    if (count <= 0) return;
    // Door visual size + spacing are anchored to the real 12-ft on-center
    // standard. We keep tiny absolute floors so doors stay visible at very
    // low zoom, but don't enforce a 10-px floor that would push a real
    // door bank wider than the building wall when pxPerFt is small (e.g.,
    // a 1000ft building rendered at ~0.5 px/ft would otherwise force
    // 18-ft on-centers and trim 8+ doors from the demo).
    const doorWPx   = Math.max(3, 8 * pxPerFt);
    const minSpcPx  = Math.max(4, 12 * pxPerFt);
    // Hard bounds: a door is drawn from cx - doorWPx/2 to cx + doorWPx/2, so
    // the door center must stay inside [xStart + doorWPx/2, xEnd - doorWPx/2]
    // to keep the geometry inside the building rectangle. (Pre-fix: a centering
    // fallback could push doors past the wall when count × minSpc > span.)
    const halfDoor = doorWPx / 2;
    const edgeMargin = Math.max(halfDoor, doorWPx * 1.5);
    const spanStart = xStart + edgeMargin;
    const spanEnd   = xEnd   - edgeMargin;
    const span      = Math.max(0, spanEnd - spanStart);

    // Max doors that physically fit at minimum 12 ft on-center. If the user
    // entered more doors than the wall can hold, render the max that fits and
    // emit a small "+N more" annotation rather than overflowing the wall.
    const maxFit = span > 0
      ? Math.max(1, Math.floor(span / minSpcPx) + 1)
      : 1;
    const drawCount = Math.min(count, maxFit);
    const overflow  = Math.max(0, count - drawCount);

    // Even distribution across the span (drawCount-1 gaps fill the span).
    // Spacing never drops below the 12-ft floor and the distribution stays
    // strictly within [spanStart, spanEnd].
    const rawSpc = drawCount > 1 ? span / (drawCount - 1) : 0;
    const spc = drawCount > 1 ? Math.max(minSpcPx, rawSpc) : 0;
    const neededSpan = (drawCount - 1) * spc;
    // Center the bank within the span when there's slack, but clamp so cx
    // never crosses spanStart or spanEnd.
    let firstX = drawCount === 1
      ? (spanStart + spanEnd) / 2
      : spanStart + Math.max(0, (span - neededSpan) / 2);
    // Belt-and-braces clamp — first/last door fully inside the wall.
    if (firstX < spanStart) firstX = spanStart;
    if (firstX + neededSpan > spanEnd) firstX = spanEnd - neededSpan;

    ctx.fillStyle = color;
    ctx.strokeStyle = '#7f1d1d';
    ctx.lineWidth = 1;
    for (let i = 0; i < drawCount; i++) {
      const cx = firstX + i * spc;
      ctx.fillRect(cx - halfDoor, yTop, doorWPx, 12);
      ctx.strokeRect(cx - halfDoor, yTop, doorWPx, 12);
    }
    ctx.fillStyle = '#7f1d1d';
    ctx.font = 'bold 10px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    const labelTxt = overflow > 0 ? `${label} (+${overflow} won't fit)` : label;
    ctx.fillText(labelTxt, (xStart + xEnd) / 2, yTop + (labelAbove ? -6 : 28));
  }

  if (twoSided) {
    // Two-sided: outbound along the full bottom wall, inbound along the full top wall.
    drawDoorRow(outboundDoors, Y0 + Hpx - 6, `${outboundDoors} Outbound Doors`, '#fecaca', false, X0, X0 + Wpx);
    drawDoorRow(inboundDoors,  Y0 - 6,        `${inboundDoors} Inbound Doors`,  '#bfdbfe', true,  X0, X0 + Wpx);
  } else if (inboundDoors > 0 && outboundDoors > 0) {
    // Single-sided: bank inbound on the LEFT half and outbound on the RIGHT half
    // of the bottom wall. Mirrors how real ops separate I/O on one dock face.
    const mid = X0 + Wpx / 2;
    const gap = Math.max(8 * pxPerFt, 60); // ≥ 8 ft visual gap between banks
    drawDoorRow(inboundDoors,  Y0 + Hpx - 6, `${inboundDoors} Inbound`,  '#bfdbfe', false, X0,         mid - gap / 2);
    drawDoorRow(outboundDoors, Y0 + Hpx - 6, `${outboundDoors} Outbound`, '#fecaca', false, mid + gap / 2, X0 + Wpx);
  } else {
    // Edge case: only one type of door — distribute across the full wall.
    drawDoorRow(totalDoors, Y0 + Hpx - 6, `${totalDoors} Dock Doors`, '#fecaca', false, X0, X0 + Wpx);
  }

  // ---------- Building dimension labels ----------
  ctx.fillStyle = '#374151';
  ctx.font = '11px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${widthFt.toLocaleString()} ft`, X0 + Wpx / 2, Y0 + Hpx + 44);
  ctx.save();
  ctx.translate(X0 - 22, Y0 + Hpx / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${depthFt.toLocaleString()} ft`, 0, 0);
  ctx.restore();

  // Compass / orientation
  ctx.fillStyle = '#6b7280';
  ctx.font = '10px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(twoSided ? '▲ INBOUND DOCK' : '▲ BACK', X0 + 4, Y0 - 22);
  ctx.fillText(twoSided ? '▼ OUTBOUND DOCK' : '▼ DOCK FACE', X0 + 4, Y0 + Hpx + 22);

  // Title block (top-left, outside building)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 13px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(facility.name || 'Facility', 12, 22);
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Montserrat, sans-serif';
  ctx.fillText(
    `${calc.formatSqft(sized.totalSqft)} sized  ·  clear ht ${facility.clearHeight || 0} ft`,
    12, 38,
  );

  // Stash canvas metadata for pointer-event handlers (edit mode).
  _planMeta = { X0, Y0, Wpx, Hpx, pxPerFt, canvasEl: canvas };

  // Edit-mode overlay: draw a dashed selection frame around each draggable
  // zone so the user sees what can be moved.
  if (_planEditMode) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    for (const [id, r] of Object.entries(_planZoneRects)) {
      ctx.strokeStyle = id === 'office' ? '#8b5cf6'
                      : id === 'shipStaging' ? '#d97706'
                      : '#7c3aed';
      ctx.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    }
    ctx.restore();

    // Corner resize handles — draw small filled squares at the 4 corners of
    // each draggable zone. Click within HANDLE_PX of a corner initiates a
    // resize; clicks inside the body still initiate a move.
    ctx.save();
    for (const [id, r] of Object.entries(_planZoneRects)) {
      const color = id === 'office' ? '#8b5cf6'
                  : id === 'shipStaging' ? '#d97706'
                  : '#7c3aed';
      ctx.fillStyle = color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      const corners = [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x, y: r.y + r.h },
        { x: r.x + r.w, y: r.y + r.h },
      ];
      for (const c of corners) {
        ctx.fillRect(c.x - 4, c.y - 4, 8, 8);
        ctx.strokeRect(c.x - 4, c.y - 4, 8, 8);
      }
    }
    ctx.restore();
  }
}

/** Pixel radius around a corner that counts as a resize handle hit. */
const WSC_RESIZE_HANDLE_PX = 10;

/** Return which corner (if any) of a zone rect `r` the mouse is over. */
function _hitCorner(r, mx, my) {
  const corners = [
    { id: 'tl', x: r.x,       y: r.y },
    { id: 'tr', x: r.x + r.w, y: r.y },
    { id: 'bl', x: r.x,       y: r.y + r.h },
    { id: 'br', x: r.x + r.w, y: r.y + r.h },
  ];
  for (const c of corners) {
    if (Math.abs(mx - c.x) <= WSC_RESIZE_HANDLE_PX && Math.abs(my - c.y) <= WSC_RESIZE_HANDLE_PX) return c.id;
  }
  return null;
}

/** Canvas geometry stash used by drag handlers to convert mouse → feet. */
let _planMeta = null;

// ============================================================
// DASHBOARD VIEW
// ============================================================

/**
 * Convert the UI's (facility, zones, volumes) state into SizingInputs
 * for the v2-equivalent calc.sizeFacility engine.
 * @returns {import('./calc.js?v=20260419-uC').SizingInputs}
 */
function toSizingInputs() {
  const alloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
  const prod = zones.productDimensions || {};
  const dock = zones.dockConfig || {};
  const fp = zones.forwardPick || null;
  const opt = zones.optionalZones || {};
  const aisleMap = { 12: 'wide', 10: 'narrow', 6: 'vna' };
  const aisleType = aisleMap[Math.round(facility.aisleWidth || 0)] || 'narrow';

  const optionalZones = [];
  if (opt.vas?.enabled) optionalZones.push({ label: 'VAS / Kitting', sqft: opt.vas.sqft || 0 });
  if (opt.returns?.enabled) optionalZones.push({ label: 'Returns / QC', sqft: opt.returns.sqft || 0 });
  if (opt.chargeback?.enabled) optionalZones.push({ label: 'Chargeback', sqft: opt.chargeback.sqft || 0 });
  if (zones.chargingSqft > 0) optionalZones.push({ label: 'Charging / Maint.', sqft: zones.chargingSqft });
  if (zones.repackSqft > 0) optionalZones.push({ label: 'Repack', sqft: zones.repackSqft });

  // Phase B redesign (2026-05-05) — primary-input toggle. When the user is
  // driving from throughput AND has entered annual outbound + DOH, derive
  // peak on-hand units from the formula: peak = (annual / 365) × DOH × peak.
  // Otherwise fall back to the direct zones.peakUnitsPerDay input (legacy
  // behavior + pallet-driven mode). Engine output unchanged for any saved
  // scenario where annualOutboundUnits = 0 (the default).
  const primaryInput = facility.primaryInventoryInput || 'throughput';
  const peakMult = +volumes.peakMultiplier || 1.3;
  const annualOut = +volumes.annualOutboundUnits || 0;
  const doh = +volumes.daysOnHand || 30;
  const peakUnitsFromThroughput = (annualOut > 0 && doh > 0)
    ? Math.round((annualOut / 365) * doh * peakMult)
    : 0;
  const useThroughputDerivation = primaryInput === 'throughput' && peakUnitsFromThroughput > 0;
  const effectivePeakUnits = useThroughputDerivation
    ? peakUnitsFromThroughput
    : (zones.peakUnitsPerDay || 500000);
  // Avg follows the same source. When throughput-driven and avg-day demand
  // can be inferred (annual / 365), use that × DOH for avg on-hand. Else
  // fall back to direct zones.avgUnitsPerDay.
  const avgUnitsFromThroughput = (annualOut > 0 && doh > 0)
    ? Math.round((annualOut / 365) * doh)
    : 0;
  const effectiveAvgUnits = useThroughputDerivation
    ? avgUnitsFromThroughput
    : (zones.avgUnitsPerDay || 350000);

  return {
    peakUnits: effectivePeakUnits,
    avgUnits: effectiveAvgUnits,
    // WSC-B6 (2026-04-25): prefer the explicit dailyOutbound field; only
    // fall back to (avgUnitsPerDay × operatingDays) when blank. The legacy
    // path stuffed avgUnits *as on-hand* into outboundUnitsYr which was
    // dimensionally wrong; sizingEngine doesn't use outboundUnitsYr for
    // sizing anyway, but keep it for downstream callers.
    outboundUnitsYr: zones.outboundUnitsPerDay && zones.outboundUnitsPerDay > 0
      ? zones.outboundUnitsPerDay * (zones.operatingDaysPerYear || 250)
      : (zones.avgUnitsPerDay || 0) * (zones.operatingDaysPerYear || 250),
    operatingDaysYr: zones.operatingDaysPerYear || 250,
    fullPalletPct: (alloc.fullPallet || 0) / 100,
    cartonOnPalletPct: (alloc.cartonOnPallet || 0) / 100,
    cartonOnShelvingPct: (alloc.cartonOnShelving || 0) / 100,
    unitsPerPallet: prod.unitsPerPallet || 48,
    unitsPerCartonPal: prod.unitsPerCartonPallet || 6,
    cartonsPerPallet: prod.cartonsPerPallet || 12,
    unitsPerCartonShelv: prod.unitsPerCartonShelving || 6,
    cartonsPerLocation: prod.cartonsPerLocation || 4,
    clearHeightFt: facility.clearHeight || 36,
    loadHeightIn: facility.palletHeight || 48,
    sprinklerClearanceIn: facility.topClearance || 18,
    storeType: facility.storageType || 'single',
    aisleType,
    bulkDepth: 4,
    stackHi: 3,
    mixRackPct: 0.70,
    honeycombPct: 10,
    surgePct: 20,
    inPalletsDay: volumes.avgDailyInbound || 200,
    outPalletsDay: volumes.avgDailyOutbound || 200,
    palletsPerDoorHour: dock.palletsPerDockHour || 20,
    dockHours: dock.dockOperatingHours || 8,
    dockConfig: dock.sided === 'two' ? 'two' : 'one',
    // WSC-B10 (2026-04-25): wire dock-wall feasibility validator.
    // Dock face = the longer of buildingWidth/buildingDepth (assume the dock
    // sits on the longer wall). For two-sided layouts, doors split across
    // opposing walls so each face needs only half — the validator already
    // accounts for total door count vs available, so we provide raw face-length.
    // Subtract 40 ft for corner walls + fire egress + columns.
    availableWallFt: (() => {
      const bw = facility.buildingWidth || 0;
      const bd = facility.buildingDepth || 0;
      if (!bw || !bd) return 0;             // dimensions blank → constraint disabled
      const sided = (zones.dockConfig && zones.dockConfig.sided) || 'single';
      const longestWall = Math.max(bw, bd);
      const usable = Math.max(0, longestWall - 40);
      // Two-sided uses TWO walls of equal length, so total available is 2× usable.
      return sided === 'two' ? usable * 2 : usable;
    })(),
    // Honor explicit dock counts the user typed in the Dock Configuration panel.
    // Engine still computes a derived value for comparison.
    inboundDoorsOverride: Number(dock.inboundDoors) || 0,
    outboundDoorsOverride: Number(dock.outboundDoors) || 0,
    // Honor explicit pallet position count when user provides it on Volume Requirements.
    // This is how high-throughput / engineered-inventory facilities should be sized
    // (otherwise the engine derives positions from peakUnits × mix, which under-sizes
    // when peakUnits is entered as throughput rather than on-hand inventory).
    totalPalletsOverride: Number(volumes.totalPallets) || 0,
    officePct: (facility.totalSqft && zones.officeSqft)
      ? Math.max(0.02, Math.min(0.15, zones.officeSqft / facility.totalSqft))
      : 0.05,
    forwardPick: fp && fp.enabled ? {
      enabled: true,
      skus: fp.skuCount || 0,
      // Phase B redesign (2026-05-05) — A-velocity SKU share drives forward-pick
      // demand. Default 20% is the legacy hardcoded audit default, so existing
      // scenarios produce identical sized output. When user tunes A% (e.g. 15%
      // or 30%), forward-pick area scales accordingly.
      activePickPct: Number.isFinite(+facility.velocityTierAPct) && +facility.velocityTierAPct >= 0
        ? +facility.velocityTierAPct
        : 20,
      pickType: fp.type === 'heavy_case' ? 'pallet' : 'carton',
      daysInventory: fp.daysInventory || 3,
    } : null,
    optionalZones,
    customZones: (zones.customZones || []).map(z => ({ label: z.name || 'Custom', sqft: z.sqft || 0 })),
    // ── Phase 2 redesign (2026-05-04): IE-correct unit-load + carton + SKU + dock fields ──
    // All optional. When omitted, sizeFacility falls back to legacy behavior.
    palletType: facility.palletType || 'GMA',
    palletLengthIn: facility.palletWidth || 0,    // legacy facility.palletWidth = pallet length along beam
    palletWidthIn: facility.palletDepth || 0,     // legacy facility.palletDepth = pallet width into rack
    cartonLengthIn: facility.cartonLengthIn || 12,
    cartonWidthIn:  facility.cartonWidthIn  || 9,
    cartonHeightIn: facility.cartonHeightIn || 12,
    cartonOrientation: facility.cartonOrientation || 'L-along-rack',
    cartonsPerPalletOverride: Number(facility.cartonsPerPalletOverride) || 0,
    fullPalletSkus:   Number(facility.fullPalletSkus)   || 0,
    cartonPalletSkus: Number(facility.cartonPalletSkus) || 0,
    shelvingSkus:     Number(facility.shelvingSkus)     || 0,
    bottomBeamFp: !!facility.bottomBeamFp,
    bottomBeamCp: !!facility.bottomBeamCp,
    bottomBeamShelving: !!facility.bottomBeamShelving,
    topBeam: !!facility.topBeam,
    palletsPerTruck:    Number(facility.palletsPerTruck)    || 26,
    dwellHoursPerTruck: Number(facility.dwellHoursPerTruck) || 1.5,
    shiftHoursPerDay:   Number(facility.shiftHoursPerDay)   || 16,
    surgePctDock: facility.surgePctDock != null ? Number(facility.surgePctDock) : 0.20,
  };
}

function renderDashboard() {
  const storage = calc.computeStorage(facility, zones);
  const summary = calc.computeCapacitySummary(facility, zones, volumes);
  // WSC-A1: collapse facility.dockDoors -> zones.dockConfig as the single
  // source of truth. facility.dockDoors used to be a separate field that
  // could drift from zones.dockConfig (which the door-allocation UI actually
  // edits). Derive total doors from zones every render.
  const _dockCfg = zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const _totalDoors = (_dockCfg.inboundDoors || 0) + (_dockCfg.outboundDoors || 0) || (facility.dockDoors || 0);
  const dock = calc.dockUtilization(_totalDoors, volumes.avgDailyInbound, volumes.avgDailyOutbound, volumes.peakMultiplier);
  const dockAnalysis = calc.calcDockAnalysis(facility, zones, volumes);
  // WSC-A5 (2026-04-25): calcStorageByType produced fake "positions" for
  // carton-on-shelving (treated 1 shelf location as 1 pallet position).
  // Dashboard now reads sized.positions.shelvingPositions (loc) directly,
  // so this call is dead. Removed.
  const dioh = calc.calcDIOH(zones);
  const fwdPick = calc.calcForwardPick(zones);
  const correctedSf = calc.calcSuggestedSF(facility, zones, volumes);
  const zoneBD = calc.zoneBreakdown(zones);

  // v2-equivalent volume-first sizing (the engine we actually trust).
  const sized = calc.sizeFacility(toSizingInputs());

  // Phase A: route elevation params through mode-aware facility shape.
  const elev = calc.elevationParams(_renderFacility(facility, sized));

  // Phase 4 Layer B (volumes-as-nucleus, 2026-04-29): per-channel positions
  // breakdown for display. Same pallet-vs-carton math as sizeFacility but
  // split per-channel using each channel's storageAllocation override (or
  // the facility-level allocation as fallback). Empty when zones.channelMixes
  // is unset — falls back to the legacy single-row display.
  let byChannel = [];
  try {
    const cbt = calc.calcStorageByType(facility, zones);
    if (Array.isArray(cbt.byChannel)) byChannel = cbt.byChannel;
  } catch (_) {}

  return `
    <!-- KPI Bar — Sized Facility (v2-equivalent volume-first engine) -->
    <div class="hub-kpi-bar mb-6">
      <div class="hub-kpi-item"><div class="hub-kpi-label">Sized Total SF</div><div class="hub-kpi-value" title="Sum of pallet storage + carton shelving + dock + staging + zones + office, computed from peak units / mix / dock throughput. v2-equivalent engine.">${calc.formatSqft(sized.totalSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Storage SF</div><div class="hub-kpi-value">${calc.formatSqft(sized.storageSqft)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Gross Positions</div><div class="hub-kpi-value" title="Designed positions + ${sized.utilization.designed > 0 ? Math.round((sized.positions.surgePositions / sized.utilization.designed) * 100) : 0}% surge buffer">${sized.positions.grossPositions.toLocaleString()}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Rack Levels</div><div class="hub-kpi-value">${sized.rackLevels}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">SF / Position</div><div class="hub-kpi-value" title="Total facility SF / gross positions. Lower = denser. Selective racking 8-12; VNA 5-8; Drive-in 3-5.">${sized.sfPerPosition.toFixed(1)}</div></div>
      <div class="hub-kpi-item"><div class="hub-kpi-label">Dock Doors</div><div class="hub-kpi-value" title="${sized.dock.inboundDoors} in${sized.dock.inboundDoorsExplicit ? ' (explicit)' : ` (derived; throughput suggests ${sized.dock.inboundDoorsDerived})`} + ${sized.dock.outboundDoors} out${sized.dock.outboundDoorsExplicit ? ' (explicit)' : ` (derived; throughput suggests ${sized.dock.outboundDoorsDerived})`}${(sized.dock.inboundDoorsExplicit || sized.dock.outboundDoorsExplicit) ? '' : ', +25% surge buffer'}">${sized.dock.totalDoors}</div></div>
    </div>

    <!-- Phase A redesign (2026-05-05) — Sized Facility / Capacity Check panel.
         Mode-aware: Design mode shows the engine's sized footprint as the
         single answer (no Built column, no Apply button — the engine answer
         IS the answer). Constraint mode keeps the two-column Required vs
         Built layout with status chip and the right-size button. The
         pre-Phase-A panel always showed both columns and an Apply button,
         which created the "two competing sizes" confusion. -->
    ${(() => {
      const r = sized.requirementsDriven;
      if (!r || !r.totalSfRequired) return '';
      const _mode = facility.sizingMode || 'design';

      // Design mode — single column. Engine answer = footprint.
      if (_mode === 'design') {
        return `
          <div class="hub-card mb-6" style="border-left:4px solid var(--ies-blue,#0047AB);padding:16px 20px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div>
                <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ies-gray-700);">Sized Facility</div>
                <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">Design mode — engine sizes the building from inventory + dock throughput. Switch to Constraint mode in the Configure panel to evaluate an existing W×D.</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;font-weight:700;">Sized total</div>
                <div style="font-size:18px;font-weight:800;color:var(--ies-blue,#0047AB);">${r.totalSfRequired.toLocaleString()} sf</div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
              <div>
                <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Critical-path SF</div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Storage</span><strong>${r.storageSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Dock <span style="color:var(--ies-gray-400);">(peak-throughput driven)</span></span><strong>${r.dockSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Office</span><strong>${r.officeSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Staging</span><strong>${r.stagingSf.toLocaleString()} sf</strong></div>
                ${r.additionalSf > 0 ? `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Additional</span><strong>${r.additionalSf.toLocaleString()} sf</strong></div>` : ''}
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:var(--ies-gray-500);"><span>+ Circulation buffer (10%)</span><strong>${r.circulationSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:var(--ies-blue,#0047AB);"><span>Total</span><strong>${r.totalSfRequired.toLocaleString()} sf</strong></div>
              </div>
              <div>
                <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Footprint</div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Long edge × Short edge</span><strong>${r.suggestedLongFt} × ${r.suggestedShortFt} ft</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;color:var(--ies-gray-500);"><span>Aspect ratio</span><strong>1.5 : 1</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:var(--ies-gray-500);"><span>Convention</span><strong>Dock on long edge</strong></div>
                <div style="margin-top:10px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-600);line-height:1.5;">
                  The 2D plan and 3D scene render this footprint exactly. No empty-building visual — what you see equals the engineered answer.
                </div>
              </div>
            </div>
          </div>
        `;
      }

      // Constraint mode — Required vs Existing with status chip + right-size CTA.
      const builtSf = (facility.buildingWidth || 0) * (facility.buildingDepth || 0);
      const haveBuilt = builtSf > 0;
      const deltaSf = haveBuilt ? builtSf - r.totalSfRequired : 0;
      const deltaPct = (haveBuilt && r.totalSfRequired > 0) ? Math.round((deltaSf / r.totalSfRequired) * 1000) / 10 : 0;
      const status = !haveBuilt ? 'unbuilt' : Math.abs(deltaPct) <= 5 ? 'on-target' : deltaPct > 5 ? 'slack' : 'short';
      const statusColor = status === 'on-target' ? 'var(--ies-green,#10b981)' : status === 'slack' ? 'var(--ies-blue,#0047AB)' : status === 'short' ? 'var(--ies-orange,#f97316)' : 'var(--ies-gray-500)';
      const statusLabel = status === 'on-target' ? '✓ On target (within 5%)' : status === 'slack' ? `+${deltaPct}% capacity slack` : status === 'short' ? `${deltaPct}% short` : 'Enter building dims';
      const canApply = r.suggestedLongFt > 0 && r.suggestedShortFt > 0;
      return `
        <div class="hub-card mb-6" style="border-left:4px solid ${statusColor};padding:16px 20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <div>
              <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ies-gray-700);">Capacity Check</div>
              <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">Constraint mode — your building is fixed. Tool shows whether your inventory fits, and by how much.</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;font-weight:700;">Status</div>
              <div style="font-size:14px;font-weight:700;color:${statusColor};">${statusLabel}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
            <div>
              <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Required (computed)</div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Storage</span><strong>${r.storageSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Dock <span style="color:var(--ies-gray-400);">(peak-throughput driven)</span></span><strong>${r.dockSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Office</span><strong>${r.officeSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Staging</span><strong>${r.stagingSf.toLocaleString()} sf</strong></div>
              ${r.additionalSf > 0 ? `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Additional</span><strong>${r.additionalSf.toLocaleString()} sf</strong></div>` : ''}
              <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:var(--ies-gray-500);"><span>+ Circulation buffer (10%)</span><strong>${r.circulationSf.toLocaleString()} sf</strong></div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:var(--ies-blue,#0047AB);"><span>Total Required</span><strong>${r.totalSfRequired.toLocaleString()} sf</strong></div>
              <div style="font-size:11px;color:var(--ies-gray-500);margin-top:4px;">Suggested footprint: <strong>${r.suggestedLongFt} × ${r.suggestedShortFt} ft</strong> (1.5:1)</div>
            </div>
            <div>
              <div style="font-size:11px;color:var(--ies-gray-500);text-transform:uppercase;font-weight:700;margin-bottom:6px;">Existing building</div>
              ${haveBuilt ? `
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Width × Depth</span><strong>${facility.buildingWidth} × ${facility.buildingDepth} ft</strong></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span>Footprint area</span><strong>${builtSf.toLocaleString()} sf</strong></div>
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--ies-gray-200);margin-top:6px;font-weight:700;color:${statusColor};"><span>Gap</span><strong>${deltaSf >= 0 ? '+' : ''}${deltaSf.toLocaleString()} sf (${deltaPct >= 0 ? '+' : ''}${deltaPct}%)</strong></div>
              ` : `
                <div style="font-size:11px;color:var(--ies-gray-500);font-style:italic;padding:8px 0;">No building dims set. Enter Width / Depth in Step 5, or click Apply suggested dims to use the engineered footprint as a starting point.</div>
              `}
              ${canApply ? `
                <div style="margin-top:12px;display:flex;gap:8px;">
                  <button class="hub-btn hub-btn-primary hub-btn-sm" data-wsc-action="apply-required-dims" data-long="${r.suggestedLongFt}" data-short="${r.suggestedShortFt}" style="flex:1;">${haveBuilt && status !== 'on-target' ? 'Right-size to suggested' : 'Apply suggested dims'}</button>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    })()}

    <!-- Sized Facility Recommendation Card -->
    <div class="hub-card mb-6" style="border-left:4px solid var(--ies-blue);padding:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <div class="text-section" style="margin:0;">${calc.formatSqft(sized.totalSqft)} Facility — ${calc.labelForStoreType(sized.storageDetail.storeType)}</div>
          <div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">${escapeHtml(sized.storageDetail.layoutDescription)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:var(--ies-gray-400);text-transform:uppercase;font-weight:700;">SF / Position</div>
          <div style="font-size:20px;font-weight:800;">${sized.sfPerPosition.toFixed(1)}</div>
        </div>
      </div>

      <table class="cm-grid-table" style="font-size:13px;width:100%;">
        <tbody>
          <tr><td colspan="2" style="padding-top:8px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;">Inventory → Positions</td></tr>
          ${sized.positions.palletPositionsOverridden ? `
            <tr><td title="Total pallet positions you entered on Volume Requirements. Replaces the peakUnits × mix derivation (peak-derived FP + CP rows are not used downstream when an override is engaged).">
              <strong>Total Pallets (entered)</strong>
              <span style="color:var(--ies-gray-400);font-size:11px;display:block;line-height:1.5;">
                Split by mix: Full Pallet ${Math.round((sized.meta.normalisedMix.fullPalletPct / Math.max(0.0001, sized.meta.normalisedMix.fullPalletPct + sized.meta.normalisedMix.cartonOnPalletPct)) * 100)}% / Carton on Pallet ${Math.round((sized.meta.normalisedMix.cartonOnPalletPct / Math.max(0.0001, sized.meta.normalisedMix.fullPalletPct + sized.meta.normalisedMix.cartonOnPalletPct)) * 100)}%
              </span>
            </td><td class="cm-num"><strong>${sized.positions.palletPositionsNeeded.toLocaleString()}</strong> pos</td></tr>
            <tr><td>Carton Shelving (${Math.round(sized.meta.normalisedMix.cartonOnShelvingPct * 100)}%)</td><td class="cm-num">${sized.positions.shelvingPositions.toLocaleString()} loc</td></tr>
          ` : `
            <tr><td>Full Pallet (${Math.round(sized.meta.normalisedMix.fullPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.fullPalletPositions.toLocaleString()} pos</td></tr>
            <tr><td>Carton on Pallet (${Math.round(sized.meta.normalisedMix.cartonOnPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.cartonPalletPositions.toLocaleString()} pos</td></tr>
            <tr><td>Carton Shelving (${Math.round(sized.meta.normalisedMix.cartonOnShelvingPct * 100)}%)</td><td class="cm-num">${sized.positions.shelvingPositions.toLocaleString()} loc</td></tr>
          `}
          <tr style="border-top:1px dashed var(--ies-gray-200);"><td title="Pallet inventory + shelving locations going into the engine before buffers."><strong>Subtotal: Inventory positions</strong></td><td class="cm-num"><strong>${(sized.positions.palletPositionsNeeded + sized.positions.shelvingPositions).toLocaleString()}</strong></td></tr>
          <tr><td title="Honeycomb buffer = empty positions reserved for inbound/outbound flux + slotting flexibility. Applied to pallet + shelving sides at the same rate.">+ Honeycomb buffer (${Math.round((sized.positions.honeycombFactor - 1) * 100)}%)</td><td class="cm-num">${(sized.positions.designedPositions - sized.positions.palletPositionsNeeded - sized.positions.shelvingPositions).toLocaleString()} pos</td></tr>
          <tr><td><strong>Designed positions</strong></td><td class="cm-num"><strong>${sized.positions.designedPositions.toLocaleString()} pos</strong></td></tr>
          <tr><td title="Surge buffer = additional positions for seasonal peaks above the engineered design.">+ Surge buffer (${Math.round((sized.positions.surgeFactor - 1) * 100)}%)</td><td class="cm-num">${sized.positions.surgePositions.toLocaleString()} pos</td></tr>
          <tr style="border-top:2px solid var(--ies-blue);"><td><strong>Gross Positions</strong></td><td class="cm-num"><strong>${sized.positions.grossPositions.toLocaleString()}</strong></td></tr>

          ${byChannel.length > 0 ? `
            <tr><td colspan="2" style="padding-top:14px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;" title="Phase 4 Layer B (volumes-as-nucleus): positions sized per-channel using each channel's storageAllocation override (falls back to facility allocation when no override).">Inventory → Positions by Channel</td></tr>
            ${byChannel.map(c => `
              <tr>
                <td style="padding-left:8px;">${escapeHtml(c.name)}${renderCmDrillbackChip({ cmId: facility.parent_cost_model_id, channelKey: c.channelKey, channelName: c.name })}</td>
                <td class="cm-num">
                  <span title="Full pallet positions">${c.fullPalletPositions.toLocaleString()} fp</span>
                  <span style="color:var(--ies-gray-400);"> · </span>
                  <span title="Carton-on-pallet positions">${c.cartonOnPalletPositions.toLocaleString()} cp</span>
                  <span style="color:var(--ies-gray-400);"> · </span>
                  <span title="Carton-on-shelving locations">${c.cartonOnShelvingLocations.toLocaleString()} cs</span>
                </td>
              </tr>
            `).join('')}
          ` : ''}

          <tr><td colspan="2" style="padding-top:14px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;">Zone Breakdown</td></tr>
          ${sized.zoneBreakdown.map(z => `
            <tr><td>${escapeHtml(z.label)}</td><td class="cm-num">${calc.formatSqft(z.sqft)} <span style="color:var(--ies-gray-400);font-size:11px;">${z.pct}%</span></td></tr>
          `).join('')}
          <tr style="border-top:2px solid var(--ies-blue);"><td><strong>Total Facility</strong></td><td class="cm-num"><strong>${calc.formatSqft(sized.totalSqft)}</strong></td></tr>
        </tbody>
      </table>

      ${sized.utilization.warning === 'high_util' ? `
        <div style="margin-top:12px;padding:10px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#92400e;font-size:12px;">
          ⚠ <strong>High Utilization (${sized.utilization.utilizationPct}%)</strong> — limited operational flexibility for receiving surges and seasonal peaks. Consider increasing facility size or reducing peak inventory assumptions.
        </div>
      ` : sized.utilization.warning === 'low_util' ? `
        <div style="margin-top:12px;padding:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;color:#9a3412;font-size:12px;">
          ⚠ <strong>Low Utilization (${sized.utilization.utilizationPct}%)</strong> — gap between average (${sized.utilization.avg.toLocaleString()}) and peak (${sized.utilization.peak.toLocaleString()}) is significant. Verify the facility is sized for the right scenario.
        </div>
      ` : ''}

      ${!sized.dock.dockWallOk ? `
        <div style="margin-top:8px;padding:10px;background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;color:#991b1b;font-size:12px;">
          ⚠ <strong>Dock Wall Constraint:</strong> required ${sized.dock.dockWallRequiredFt} ft for ${sized.dock.totalDoors} doors at 12' on-center spacing exceeds available wall length (${sized.dock.dockWallAvailableFt} ft). Consider a second dock face or fewer doors.
        </div>
      ` : ''}

    </div>

    <!-- Capacity Analysis (vs sized requirement) -->
    <div style="font-size:11px;color:var(--ies-gray-500);margin-bottom:8px;text-transform:uppercase;font-weight:700;">Capacity Analysis</div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
      <!-- Capacity Utilization — tied to sizing engine -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Capacity Utilization</div>
        ${renderUtilBar('Storage SF vs Existing',
          facility.totalSqft > 0 ? Math.round((sized.storageSqft / facility.totalSqft) * 100) : 0,
          { mode: 'cap', tooltip: 'Sized storage SF / facility.totalSqft. >95% means storage alone consumes all available SF — no room for staging, dock, office.' })}
        ${renderUtilBar('Sized SF vs Existing',
          facility.totalSqft > 0 ? Math.round((sized.totalSqft / facility.totalSqft) * 100) : 0,
          { mode: 'cap', tooltip: 'Sized total SF / facility.totalSqft. >100% means the engineered facility does not fit in the existing footprint.' })}
        ${renderUtilBar('Pallet Position Util',
          sized.utilization.utilizationPct,
          { mode: 'band', tooltip: 'Average inventory positions / designed positions. Healthy band 70-90%. Below 70% = over-built; above 90% = no slack for receiving surges or seasonal peaks. (WSC-D4 fix: was inverted as cap-mode.)' })}
        ${renderUtilBar('Cubic Utilization',
          summary.cubicUtilizationPct,
          { mode: 'cap', tooltip: 'Pallet cube (positions × bay W × rack D × level H) / building cube (storage SF × usable Ht). High % = dense vertical use.' })}
      </div>

      <!-- Capacity Reconciliation — bridge the two ways the tool counts positions (WSC-A4) -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Capacity Reconciliation</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td title="What the building geometrically holds, given building width × depth × clear height × storage type × aisle width. Bounded by physics, not demand.">Geom Capacity (max)</td>
                <td class="cm-num" style="color:var(--ies-blue);font-weight:700;">${storage.totalPalletPositions.toLocaleString()}</td></tr>
            <tr><td title="What the customer's inventory NEEDS, derived from peak units × storage mix ÷ units-per-pallet, plus honeycomb buffer.">Designed (need)</td>
                <td class="cm-num" style="font-weight:700;">${sized.utilization.designed.toLocaleString()}</td></tr>
            <tr><td title="Designed positions / Geometric capacity. Low = building is over-sized for inventory; >100% = building cannot physically hold the engineered position count.">Geom Util</td>
                <td class="cm-num" style="color:${storage.totalPalletPositions > 0 && (sized.utilization.designed / storage.totalPalletPositions) > 1 ? 'var(--ies-red)' : 'inherit'};">
                  ${storage.totalPalletPositions > 0 ? Math.round((sized.utilization.designed / storage.totalPalletPositions) * 100) + '%' : '—'}
                </td></tr>
            <tr><td colspan="2" style="padding-top:8px;font-size:11px;color:var(--ies-gray-500);font-style:italic;">
              Geometric capacity is what the building can hold. Designed positions are what the customer needs. Two different lenses on the same facility.
            </td></tr>
          </tbody>
        </table>
      </div>

      <!-- Zone Allocation — same breakdown as Sized Facility -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Zone Allocation</div>
        <div style="display:flex; height:24px; border-radius:4px; overflow:hidden; margin-bottom:12px;">
          ${sized.zoneBreakdown.map((z, i) => {
            const palette = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];
            return `<div style="width:${z.pct}%;background:${palette[i % palette.length]};" title="${escapeHtml(z.label)}"></div>`;
          }).join('')}
        </div>
        <div style="font-size:13px;">
          ${sized.zoneBreakdown.map((z, i) => {
            const palette = ['#0047AB', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];
            return `
              <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:${palette[i % palette.length]};font-weight:600;">${escapeHtml(z.label)}</span>
                <span style="font-weight:700;">${calc.formatSqft(z.sqft)} <span style="color:var(--ies-gray-400);font-weight:400;font-size:11px;">${z.pct}%</span></span>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Dock Analysis — tied to sizing engine so numbers match the KPI bar -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Dock Analysis</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Inbound Doors ${sized.dock.inboundDoorsExplicit ? '<span style="font-size:10px;background:#dbeafe;color:#1e3a8a;padding:1px 5px;border-radius:3px;margin-left:4px;">EXPLICIT</span>' : `<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:3px;margin-left:4px;" title="Throughput-derived. Set explicit count in Dock Configuration to override.">DERIVED</span>`}</td><td class="cm-num" style="color:var(--ies-blue);">${sized.dock.inboundDoors}${!sized.dock.inboundDoorsExplicit ? ` <span style="font-size:11px;color:var(--ies-gray-500);font-weight:400;">(throughput suggests ${sized.dock.inboundDoorsDerived})</span>` : ''}</td></tr>
            <tr><td>Outbound Doors ${sized.dock.outboundDoorsExplicit ? '<span style="font-size:10px;background:#dbeafe;color:#1e3a8a;padding:1px 5px;border-radius:3px;margin-left:4px;">EXPLICIT</span>' : `<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:3px;margin-left:4px;" title="Throughput-derived. Set explicit count in Dock Configuration to override.">DERIVED</span>`}</td><td class="cm-num" style="color:var(--ies-blue);">${sized.dock.outboundDoors}${!sized.dock.outboundDoorsExplicit ? ` <span style="font-size:11px;color:var(--ies-gray-500);font-weight:400;">(throughput suggests ${sized.dock.outboundDoorsDerived})</span>` : ''}</td></tr>
            <tr><td>Total Doors${(sized.dock.inboundDoorsExplicit || sized.dock.outboundDoorsExplicit) ? '' : ' (incl. 25% surge)'}</td><td class="cm-num" style="font-weight:700;">${sized.dock.totalDoors}</td></tr>
            <tr><td>Dock Wall Required</td><td class="cm-num" style="color:${sized.dock.dockWallOk ? 'var(--ies-green)' : 'var(--ies-red)'};">${sized.dock.dockWallRequiredFt} ft${sized.dock.dockWallOk ? '' : ` > ${sized.dock.dockWallAvailableFt} ft avail`}</td></tr>
            <tr><td>Dock Staging SF</td><td class="cm-num">${calc.formatSqft(sized.dockSqft || 0)}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Rack & Aisle Geometry (WSC-C1: renamed from "Rack Geometry" — IE-standard term) -->
      <div class="hub-card">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
          <div class="text-subtitle" style="margin:0;">Rack &amp; Aisle Geometry</div>
          ${storage.geometryIsHeuristic
            ? `<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:3px;" title="Building Width × Depth not set — geometry assumes a 1.5:1 rectangle from total SF. Set Width / Depth on the Building card for measured geometry.">HEURISTIC</span>`
            : `<span style="font-size:10px;background:#dcfce7;color:#166534;padding:2px 6px;border-radius:3px;" title="Geometry computed from facility.buildingWidth × buildingDepth.">MEASURED</span>`
          }
        </div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Rack Levels</td><td class="cm-num" style="font-weight:700;" title="Bounded [2, 7]. Formula: floor((clearHt × 12 − sprinkler_clearance) / (load_height + 10\")).">${storage.rackLevels}</td></tr>
            <tr><td>Level Height</td><td class="cm-num">${calc.formatFt(storage.positionHeight)}</td></tr>
            <tr><td>Top of Steel</td><td class="cm-num">${calc.formatFt(calc.topOfSteelFt(storage.rackLevels))}</td></tr>
            <tr><td>Usable Height</td><td class="cm-num">${calc.formatFt(storage.usableHeight)}</td></tr>
            <tr><td>Sprinkler Clearance</td><td class="cm-num">${calc.formatFt(elev.topClearanceFt)}</td></tr>
            <tr><td>Bay Width</td><td class="cm-num">${calc.formatFt(storage.bayWidth)}</td></tr>
            <tr><td>Rack Depth</td><td class="cm-num">${calc.formatFt(storage.bayDepth)}</td></tr>
            <tr><td>Aisle Width</td><td class="cm-num" title="${facility.aisleWidth ? 'User-set' : 'Default for ' + facility.storageType}">${calc.formatFt(elev.aisleWidth)}</td></tr>
            <tr><td>Aisle Count</td><td class="cm-num" title="${storage.geometryIsHeuristic ? 'Estimated from total SF assuming 1.5:1 aspect ratio.' : 'floor(buildingWidth / aisleModuleWidth) where module = rack-depth + aisle + rack-depth.'}">${storage.aisleCount}</td></tr>
            <tr><td>Bays/Aisle</td><td class="cm-num" title="${storage.geometryIsHeuristic ? 'Estimated from total SF.' : 'floor((buildingDepth − dockSetback) / bayWidth). 30 ft reserved at dock face.'}">${storage.bayCountPerAisle}</td></tr>
            <tr><td>Total Geom Positions</td><td class="cm-num" title="aisleCount × 2 sides × bays × levels${facility.storageType === 'double' ? ' × 2 (double-deep)' : ''}. Compare to Sized Gross Positions above to spot capacity gaps.">${storage.totalPalletPositions.toLocaleString()}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Inventory Metrics -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Inventory Metrics</div>
        <table class="cm-grid-table" style="font-size:13px;">
          <tbody>
            <tr><td>Peak Units/Day</td><td class="cm-num">${(zones.peakUnitsPerDay || 500000).toLocaleString()}</td></tr>
            <tr><td>Avg Units/Day</td><td class="cm-num">${(zones.avgUnitsPerDay || 350000).toLocaleString()}</td></tr>
            <tr><td>Operating Days/Yr</td><td class="cm-num">${(zones.operatingDaysPerYear || 250)}</td></tr>
            <tr><td title="Days Inventory On-Hand = avgUnits / dailyOutbound. Typical 3PL DC: 30-90 days; high-turn retail: 10-30 days; DTC ecomm: 60-120 days. Sources: zones.outboundUnitsPerDay → outboundUnitsYr/operatingDays → forwardPick.outboundUnitsPerDay (legacy).">DIOH (Days)</td><td class="cm-num">${dioh.toFixed(1)}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Forward Pick -->
      <div class="hub-card">
        <div class="text-subtitle mb-4">Forward Pick Area</div>
        ${zones.forwardPick?.enabled ? `
          <table class="cm-grid-table" style="font-size:13px;">
            <tbody>
              <tr><td>Pick Type</td><td class="cm-num">${(zones.forwardPick.type || 'carton_flow').replace('_', ' ')}</td></tr>
              <tr><td>SKU Count</td><td class="cm-num">${(zones.forwardPick.skuCount || 0).toLocaleString()}</td></tr>
              <tr><td>Days Inventory</td><td class="cm-num">${(zones.forwardPick.daysInventory || 0).toFixed(1)}</td></tr>
              <tr><td>Forward Pick SF</td><td class="cm-num">${calc.formatSqft(fwdPick)}</td></tr>
            </tbody>
          </table>
        ` : `
          <div style="padding:12px; text-align:center; color:var(--ies-gray-400); font-size:13px;">
            Forward pick not enabled
          </div>
        `}
      </div>

      <!-- WSC-D5 (2026-04-25): "Size Recommendation" card removed. It duplicated the Zone Allocation
           card (both rendered sized.zoneBreakdown). The Sized Facility Recommendation card at the top
           of the dashboard is the canonical "single source" summary; the Zone Allocation card here adds
           the visualization. Two breakdowns of the same numbers was three places to keep in sync. -->
    </div>
  `;
}

/**
 * Render a labeled utilization bar.
 *
 * @param {string} label
 * @param {number} pct
 * @param {Object} [opts]
 * @param {'cap'|'band'|'hi'} [opts.mode='cap'] — color semantics:
 *   - 'cap' (default): higher is worse. > 95 red, > 80 orange, else green.
 *     Use for "% of available space consumed" metrics.
 *   - 'band': healthy band of 70-90%. < 60 / > 95 red, 60-70 / 90-95 orange,
 *     70-90 green. Use for utilization that should sit in an operational
 *     sweet spot (Pallet Position Util — too low = over-built, too high =
 *     no slack for surges).
 *   - 'hi': higher is better (rare; left for parity).
 * @param {string} [opts.tooltip]
 * @returns {string}
 */
function renderUtilBar(label, pct, opts = {}) {
  const mode = opts.mode || 'cap';
  let color;
  if (mode === 'band') {
    if (pct < 60 || pct > 95) color = 'var(--ies-red)';
    else if (pct < 70 || pct > 90) color = 'var(--ies-orange)';
    else color = 'var(--ies-green)';
  } else if (mode === 'hi') {
    if (pct < 50) color = 'var(--ies-red)';
    else if (pct < 70) color = 'var(--ies-orange)';
    else color = 'var(--ies-green)';
  } else {
    // 'cap' (default)
    color = pct > 95 ? 'var(--ies-red)' : pct > 80 ? 'var(--ies-orange)' : 'var(--ies-green)';
  }
  const tip = opts.tooltip ? `title="${opts.tooltip}"` : '';
  return `
    <div style="margin-bottom:12px;" ${tip}>
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:2px;">
        <span style="font-weight:600;">${label}</span>
        <span style="font-weight:700; color:${color};">${calc.formatPct(pct)}</span>
      </div>
      <div class="wsc-util-bar">
        <div class="wsc-util-fill" style="width:${Math.min(100, pct)}%; background:${color};"></div>
      </div>
    </div>
  `;
}

// ============================================================
// ELEVATION VIEW (Canvas 2D)
// ============================================================

function renderElevation() {
  // Phase A: route elevation params through mode-aware facility shape.
  let _sizedEl = null;
  try { _sizedEl = calc.sizeFacility(toSizingInputs()); } catch {}
  const elev = calc.elevationParams(_renderFacility(facility, _sizedEl), zones);
  const view = _wscElevView || 'side';
  const c = _sizedEl?.cartonProfile;

  return `
    <div class="hub-card">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:var(--sp-2);gap:12px;flex-wrap:wrap;">
        <h3 class="text-subtitle" style="margin:0;">${view === 'shelving' ? 'Shelving Bay Detail' : 'Building Cross-Section'}</h3>
        <div role="radiogroup" aria-label="Elevation view" style="display:flex;gap:4px;">
          <button type="button" role="radio" aria-checked="${view === 'side'}" data-wsc-elev-view="side"
            title="Building cross-section along the long edge — shows multiple aisles, rack levels, and clear height."
            style="padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${view === 'side' ? 'var(--ies-blue,#0047AB)' : 'var(--ies-gray-200)'};background:${view === 'side' ? 'var(--ies-blue,#0047AB)' : '#fff'};color:${view === 'side' ? '#fff' : 'var(--ies-gray-700)'};">Side</button>
          <button type="button" role="radio" aria-checked="${view === 'shelving'}" data-wsc-elev-view="shelving"
            title="Zoomed view of a single shelving bay — shows uprights, shelf decks, and carton fill from Step 3 carton profile."
            style="padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer;border:1px solid ${view === 'shelving' ? 'var(--ies-blue,#0047AB)' : 'var(--ies-gray-200)'};background:${view === 'shelving' ? 'var(--ies-blue,#0047AB)' : '#fff'};color:${view === 'shelving' ? '#fff' : 'var(--ies-gray-700)'};">Shelving Bay</button>
        </div>
      </div>
      <canvas id="wsc-elevation-canvas" width="900" height="450" style="width:100%; border:1px solid var(--ies-gray-200); border-radius:6px; background:#fff;"></canvas>
      <div style="font-size:11px; color:var(--ies-gray-400); margin-top:8px;">
        ${view === 'shelving' && c
          ? `${c.cartonsPerShelfAcross} × ${c.cartonsPerShelfDeep} cartons/shelf · ${c.shelfLevelsAt84In} levels at ${c.shelfLevelHeightFt.toFixed(2)} ft pitch · ${c.cartonsPerShelf} cartons/bay/level`
          : `${facility.storageType.charAt(0).toUpperCase() + facility.storageType.slice(1)}-deep racking · ${elev.rackLevels} levels · ${calc.formatFt(elev.aisleWidth)} aisles · ${calc.formatFt(facility.clearHeight)} clear height`}
      </div>
    </div>
  `;
}

// Deferred: call after DOM is rendered
function drawElevation() {
  const canvas = rootEl?.querySelector('#wsc-elevation-canvas');
  if (!canvas) return;
  const ctx = /** @type {HTMLCanvasElement} */ (canvas).getContext('2d');
  if (!ctx) return;

  // Phase A: route elevation params through mode-aware facility shape.
  let _sizedDe = null;
  try { _sizedDe = calc.sizeFacility(toSizingInputs()); } catch {}

  // Phase D (2026-05-05) — branch on _wscElevView. 'shelving' renders a
  // single zoomed shelving bay (uprights + decks + cartons from sized
  // cartonProfile); 'side' falls through to the legacy cross-section.
  if ((_wscElevView || 'side') === 'shelving') {
    drawShelvingBayDetail(ctx, canvas.width, canvas.height, _sizedDe);
    return;
  }

  const w = canvas.width;
  const h = canvas.height;
  const pad = { l: 60, r: 100, t: 40, b: 60 };
  const drawW = w - pad.l - pad.r;
  const drawH = h - pad.t - pad.b;
  const elev = calc.elevationParams(_renderFacility(facility, _sizedDe));
  const exteriorGrade = -4;
  const maxH = elev.clearHeight + 5;
  const scaleX = drawW / (elev.buildingWidth || 1);
  const scaleY = drawH / (maxH - exteriorGrade);

  const toX = (ft) => pad.l + ft * scaleX;
  const toY = (ft) => pad.t + (maxH - ft) * scaleY;

  ctx.clearRect(0, 0, w, h);

  // Exterior grade
  ctx.fillStyle = '#e8e4d8';
  ctx.fillRect(0, toY(0), w, toY(exteriorGrade) - toY(0));

  // Building outline
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.strokeRect(toX(0), toY(elev.clearHeight), drawW, toY(0) - toY(elev.clearHeight));

  // Floor slab
  ctx.fillStyle = '#ccc';
  ctx.fillRect(toX(0), toY(0), drawW, 3);

  // Roof
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(elev.clearHeight));
  ctx.lineTo(toX(elev.buildingWidth / 2), toY(elev.clearHeight + 3));
  ctx.lineTo(toX(elev.buildingWidth), toY(elev.clearHeight));
  ctx.closePath();
  ctx.fillStyle = '#8B4513';
  ctx.fill();

  // Racks
  const levels = elev.rackLevels;
  const posH = elev.positionHeight;
  const rackD = elev.rackDepthFt;
  const aisleW = elev.aisleWidth;
  const moduleW = rackD + aisleW + rackD;
  const startX = 10; // offset from wall

  let x = startX;
  while (x + moduleW < elev.buildingWidth - 10) {
    // Left rack
    drawRackProfile(ctx, toX, toY, x, rackD, levels, posH, elev.storageType);
    // Right rack
    drawRackProfile(ctx, toX, toY, x + rackD + aisleW, rackD, levels, posH, elev.storageType);
    // Aisle label
    ctx.fillStyle = '#0047AB';
    ctx.font = '10px Montserrat';
    ctx.textAlign = 'center';
    ctx.fillText(`${aisleW}'`, toX(x + rackD + aisleW / 2), toY(0) + 14);
    x += moduleW + 2;
  }

  // Dock platform
  ctx.fillStyle = '#999';
  ctx.fillRect(toX(-5), toY(0), toX(0) - toX(-5), toY(-4) - toY(0));
  ctx.fillStyle = '#333';
  ctx.font = '10px Montserrat';
  ctx.textAlign = 'center';
  ctx.fillText('Dock', toX(-2.5), toY(-2));

  // Right-side dimension: clear height
  drawDimV(ctx, toX(elev.buildingWidth) + 20, toY(elev.clearHeight), toY(0), `${elev.clearHeight}' Clear`);
  // TOS
  const tos = calc.topOfSteelFt(levels);
  if (levels > 0) {
    drawDimV(ctx, toX(elev.buildingWidth) + 50, toY(tos), toY(0), `${tos.toFixed(1)}' TOS`);
  }

  // Bottom dimension: building width
  drawDimH(ctx, toX(0), toX(elev.buildingWidth), toY(0) + 40, `${Math.round(elev.buildingWidth)}' Width`);
}

/**
 * Phase D (2026-05-05) — Shelving Bay Detail elevation view.
 * Zoomed-in render of one shelving bay showing uprights + shelf decks +
 * cartons placed at fillPct, with dimension labels. Pulls geometry from
 * sized.cartonProfile (Phase 1 helper computeCartonProfile output).
 *
 * Brock's original complaint #8b (2026-05-05 IE reassessment): "the
 * elevation view also doesn't show the elevations effectively... should
 * it possibly show it from various angles to identify what the shelving
 * looks like too?". This view directly addresses that — the side cross-
 * section view shows shelving as compressed stripes (not legible at
 * building scale); this view zooms to a single bay so deck spacing,
 * carton dims, and grid arrangement are visible.
 */
function drawShelvingBayDetail(ctx, w, h, sized) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, w, h);

  const c = sized?.cartonProfile;
  if (!c) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Carton profile unavailable — fill in Step 2 (Unit Load & Carton).', w / 2, h / 2);
    return;
  }

  // Bay geometry from carton profile + unit load
  const u = sized?.unitLoad;
  const bayWidthFt = (u?.bayWidthFt) || 9.0;
  const rackDepthFt = (u?.rackDepthSingleFt) || 4.0;
  const levels = c.shelfLevelsAt84In || 7;
  const levelHeightFt = c.shelfLevelHeightFt || 1.0;
  const totalHeightFt = levels * levelHeightFt;

  // Cartons-per-shelf grid
  const cAcross = c.cartonsPerShelfAcross || 3;
  const cDeep = c.cartonsPerShelfDeep || 2;
  const cartonLin = (+facility.cartonLengthIn || 12) / 12;  // ft
  const cartonWin = (+facility.cartonWidthIn || 9) / 12;
  const cartonHin = (+facility.cartonHeightIn || 12) / 12;

  // Layout: bay shown front-on. Horizontal = bay width (ft); vertical = total
  // shelving height. Add ~50% horizontal margin for dimension labels, ~30% vert.
  const pad = { l: 80, r: 200, t: 40, b: 60 };
  const drawW = w - pad.l - pad.r;
  const drawH = h - pad.t - pad.b;
  const scaleX = drawW / bayWidthFt;
  const scaleY = drawH / Math.max(totalHeightFt + 0.5, 1);
  const scale = Math.min(scaleX, scaleY);
  // Center the bay in the canvas
  const bayPx = bayWidthFt * scale;
  const heightPx = totalHeightFt * scale;
  const x0 = pad.l + (drawW - bayPx) / 2;
  const y0 = pad.t + (drawH - heightPx) / 2;
  const toX = (ft) => x0 + ft * scale;
  const toY = (ft) => y0 + heightPx - (ft * scale);  // ground at y0+heightPx

  // Floor / slab
  ctx.fillStyle = '#d1d5db';
  ctx.fillRect(toX(-0.5), toY(0), bayPx + scale * 1.0, 4);

  // Uprights (left + right of bay) — 0.12 ft × totalHeight
  const uprightWidthFt = 0.12;
  ctx.fillStyle = '#6b7280';
  ctx.fillRect(toX(0), toY(totalHeightFt), uprightWidthFt * scale, heightPx);
  ctx.fillRect(toX(bayWidthFt - uprightWidthFt), toY(totalHeightFt), uprightWidthFt * scale, heightPx);

  // Shelf decks (one per level) + cartons
  const cartonW = cartonLin * scale;  // along the bay run
  const cartonH = cartonHin * scale;  // vertical
  const deckThickFt = 0.04;
  ctx.font = '9px Montserrat, sans-serif';
  for (let lvl = 0; lvl < levels; lvl++) {
    const yLevelFt = lvl * levelHeightFt;
    // Deck slab
    ctx.fillStyle = '#9ca3af';
    ctx.fillRect(toX(0), toY(yLevelFt + deckThickFt), bayPx, deckThickFt * scale);

    // Cartons across the bay run (cAcross slots, each cartonLin wide)
    // Center them horizontally in the bay
    const totalCartonRunFt = cAcross * cartonLin;
    const startX = (bayWidthFt - totalCartonRunFt) / 2;
    for (let i = 0; i < cAcross; i++) {
      const cx = startX + i * cartonLin;
      const cy = yLevelFt + deckThickFt;
      // Carton box (corrugated brown)
      ctx.fillStyle = '#b88a52';
      ctx.fillRect(toX(cx), toY(cy + cartonHin), cartonW * 0.96, cartonH);
      // Carton outline
      ctx.strokeStyle = '#7a5a36';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(toX(cx), toY(cy + cartonHin), cartonW * 0.96, cartonH);
    }

    // Level label
    ctx.fillStyle = '#374151';
    ctx.textAlign = 'right';
    ctx.fillText(`L${lvl + 1}`, toX(0) - 6, toY(yLevelFt + levelHeightFt / 2) + 3);
  }

  // Top frame
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(toX(0), toY(totalHeightFt), bayPx, deckThickFt * scale);

  // Dimension lines + labels
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.font = '11px Montserrat, sans-serif';
  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';

  // Bottom: bay width
  drawDimH(ctx, toX(0), toX(bayWidthFt), toY(0) + 36, `${bayWidthFt.toFixed(2)} ft bay`);

  // Right: total height
  drawDimV(ctx, toX(bayWidthFt) + 16, toY(totalHeightFt), toY(0), `${totalHeightFt.toFixed(2)} ft total`);
  // Right: level pitch (one level)
  drawDimV(ctx, toX(bayWidthFt) + 60, toY(levelHeightFt), toY(0), `${levelHeightFt.toFixed(2)} ft pitch`);

  // Right info panel
  const infoX = toX(bayWidthFt) + 100;
  const infoY = pad.t;
  ctx.font = '10px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#6b7280';
  ctx.fillText('CARTON', infoX, infoY);
  ctx.fillStyle = '#111827';
  ctx.fillText(`${(+facility.cartonLengthIn || 12).toFixed(0)}" × ${(+facility.cartonWidthIn || 9).toFixed(0)}" × ${(+facility.cartonHeightIn || 12).toFixed(0)}"`, infoX, infoY + 12);
  ctx.fillStyle = '#6b7280';
  ctx.fillText('PER SHELF', infoX, infoY + 30);
  ctx.fillStyle = '#111827';
  ctx.fillText(`${cAcross} across × ${cDeep} deep = ${c.cartonsPerShelf} cartons`, infoX, infoY + 42);
  ctx.fillStyle = '#6b7280';
  ctx.fillText('PER BAY', infoX, infoY + 60);
  ctx.fillStyle = '#111827';
  ctx.fillText(`${levels} levels × ${c.cartonsPerShelf} = ${levels * c.cartonsPerShelf} cartons`, infoX, infoY + 72);
  ctx.fillStyle = '#6b7280';
  ctx.fillText('ORIENTATION', infoX, infoY + 90);
  ctx.fillStyle = '#111827';
  ctx.fillText(c.orientation || 'L-along-rack', infoX, infoY + 102);
}

function drawRackProfile(ctx, toX, toY, xFt, depthFt, levels, posH, storageType) {
  if (levels <= 0) return;

  // Uprights
  ctx.strokeStyle = '#ff6600';
  ctx.lineWidth = 2;
  const totalH = levels * posH;

  // Front upright
  ctx.beginPath();
  ctx.moveTo(toX(xFt), toY(0));
  ctx.lineTo(toX(xFt), toY(totalH));
  ctx.stroke();

  // Back upright
  ctx.beginPath();
  ctx.moveTo(toX(xFt + depthFt), toY(0));
  ctx.lineTo(toX(xFt + depthFt), toY(totalH));
  ctx.stroke();

  // If double-deep, middle upright
  if (storageType === 'double') {
    ctx.beginPath();
    ctx.moveTo(toX(xFt + depthFt / 2), toY(0));
    ctx.lineTo(toX(xFt + depthFt / 2), toY(totalH));
    ctx.stroke();
  }

  // Beams per level
  ctx.strokeStyle = '#ff8800';
  ctx.lineWidth = 1.5;
  for (let l = 1; l <= levels; l++) {
    const y = l * posH;
    ctx.beginPath();
    ctx.moveTo(toX(xFt), toY(y));
    ctx.lineTo(toX(xFt + depthFt), toY(y));
    ctx.stroke();
  }

  // Pallets (blue boxes)
  ctx.fillStyle = 'rgba(0,71,171,0.15)';
  for (let l = 0; l < levels; l++) {
    const baseY = l * posH;
    const palletH = posH * 0.8;
    ctx.fillRect(toX(xFt + 0.2), toY(baseY + palletH), toX(xFt + depthFt - 0.2) - toX(xFt + 0.2), toY(baseY) - toY(baseY + palletH));
  }
}

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

// ============================================================
// 3D VIEW (Three.js)
// ============================================================

function render3DView(container) {
  // Dispose prior scene before clobbering DOM, so re-renders triggered by
  // data-field commits don't leak WebGL contexts or leave the old animate
  // loop spinning against a detached canvas. (Was a latent leak; surfaced
  // by the P0-2 HUD work because the HUD is recomputed on every rebuild.)
  if (scene3d) {
    try { scene3d.dispose(); } catch (_) {}
    scene3d = null;
  }
  const sized = calc.sizeFacility(toSizingInputs());
  // Phase A: header dims read from mode-aware facility shape so they match
  // the rendered geometry (Design = sized footprint; Constraint = user W×D).
  const _hdrFac = _renderFacility(facility, sized);
  container.innerHTML = `
    <div class="hub-card" style="padding:16px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
        <h3 class="text-subtitle" style="margin:0;">3D Walkthrough</h3>
        <span class="text-caption text-muted">
          ${calc.formatSqft(sized.totalSqft)} sized  ·  ${_hdrFac.buildingWidth || '—'} × ${_hdrFac.buildingDepth || '—'} ft  ·  clear ht ${facility.clearHeight || 0} ft  ·  ${sized.dock.totalDoors} dock doors
        </span>
      </div>
      <div id="wsc-3d-container" style="position:relative; width:100%; height:520px; background:#e9eef5; border-radius:6px; overflow:hidden;">
        <div id="wsc-3d-hud" class="wsc-3d-hud" aria-live="polite"></div>
      </div>
      <div style="font-size:11px; color:var(--ies-gray-500); margin-top:8px;">
        Drag to orbit  ·  Scroll to zoom  ·  Racks shown at 50% opacity for floor visibility  ·  HUD shows achieved vs sized target
      </div>
    </div>
  `;

  // Defer 3D scene build so the flex layout settles first.
  setTimeout(() => build3DScene(), 80);
}

/**
 * Render the achieved-vs-target HUD overlay shown in the top-right corner of
 * the 3D canvas. P0-2 from the 2026-05-04 WSC deep audit (Lens I — data
 * fidelity). `facts` is the output of calc.rollupRenderedFacts(); the second
 * arg is the per-type rack-level context so the HUD can show "5 lvls" etc.
 */
function renderRenderedFactsHud(facts, ctx = {}) {
  if (!facts) return '';
  const { byType = {}, totalPositions = 0, totalColumns = 0, totalSegments = 0, targets = {}, deltaPct = 0, status = 'on_target' } = facts;
  const palletLv = +ctx.palletLevels || 0;
  const shelvLv  = +ctx.shelvingLevels || 0;

  const fmt = (n) => (Number(n) || 0).toLocaleString();
  const fmtDelta = (d) => {
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}%`;
  };
  // Phase F.2 (2026-05-05) — mode-aware status copy. In Design mode the
  // rack zone pads to fill the engineered footprint (Phase F.1 fillMode
  // 'fill'), so "over-built" mis-frames an intentional design choice.
  // Reframe as "Padded to fill footprint" with a neutral status chip.
  const _hudMode = ctx.sizingMode || 'design';
  const statusLabel = status === 'on_target' ? 'On target (within 5%)'
    : status === 'under_built' ? 'Under-built — footprint too small'
    : (_hudMode === 'design' ? 'Padded to fill footprint' : 'Over-built — building above sized need');
  const statusClass = status === 'on_target' ? 'wsc-3d-hud-status--on'
    : status === 'under_built' ? 'wsc-3d-hud-status--under'
    : (_hudMode === 'design' ? 'wsc-3d-hud-status--on' : 'wsc-3d-hud-status--over');

  const rowFor = (label, key, levelsLabel) => {
    const b = byType[key] || { columns: 0, positions: 0 };
    const tgt = targets[key] || 0;
    const tgtTxt = tgt > 0 ? ` / ${fmt(tgt)}` : '';
    return `
      <div class="wsc-3d-hud-row">
        <span>${label}${levelsLabel ? ` <span class="wsc-3d-hud-meta" style="display:inline">(${levelsLabel})</span>` : ''}</span>
        <span>${fmt(b.positions)}${tgtTxt}</span>
      </div>`;
  };

  // Phase 2 redesign — surface shelving demand-bound vs sku-bound mode tag
  // + cartons-per-pallet + cartons-per-shelf when sized is passed in.
  const sized = ctx.sized || null;
  const shelvingDetail = (() => {
    if (!sized?.locations?.shelving) return '';
    const sh = sized.locations.shelving;
    const cp = sized.cartonProfile || {};
    const modeColor = sh.mode === 'sku-bound'
      ? 'color:#fb923c;'
      : sh.mode === 'demand-bound'
      ? 'color:#34d399;'
      : 'color:#94a3b8;';
    return `
      <div class="wsc-3d-hud-divider"></div>
      <div class="wsc-3d-hud-meta" style="font-weight:700;color:#e2e8f0;letter-spacing:.04em;text-transform:uppercase;font-size:9.5px;margin-bottom:2px;">Shelving detail</div>
      <div class="wsc-3d-hud-row"><span>Mode</span><strong style="${modeColor}">${sh.mode}</strong></div>
      <div class="wsc-3d-hud-row"><span>Locations required</span><strong>${fmt(sh.locationsRequired)}</strong></div>
      <div class="wsc-3d-hud-row"><span>Demand · SKU floor</span><strong>${fmt(sh.demandLocations)} · ${fmt(sh.skuMinLocations)}</strong></div>
      ${cp.cartonsPerPallet ? `<div class="wsc-3d-hud-row"><span>Cartons/pallet · /shelf</span><strong>${fmt(cp.cartonsPerPallet)} · ${fmt(cp.cartonsPerShelf)}</strong></div>` : ''}
    `;
  })();

  return `
    <div class="wsc-3d-hud-title">Achieved · live</div>
    <div class="wsc-3d-hud-row"><span>Total positions</span><strong>${fmt(totalPositions)}${targets.total > 0 ? ` / ${fmt(targets.total)}` : ''}</strong></div>
    ${targets.total > 0 ? `<div class="wsc-3d-hud-row"><span>Delta</span><strong>${fmtDelta(deltaPct)}</strong></div>` : ''}
    <div class="wsc-3d-hud-divider"></div>
    ${rowFor('Full pallet', 'fullPallet', palletLv ? `${palletLv} lvls` : '')}
    ${rowFor('Carton on pallet', 'cartonPallet', palletLv ? `${palletLv} lvls` : '')}
    ${rowFor('Shelving', 'shelving', shelvLv ? `${shelvLv} lvls` : '')}
    ${shelvingDetail}
    <div class="wsc-3d-hud-divider"></div>
    <div class="wsc-3d-hud-meta">${fmt(totalColumns)} rack pairs &middot; ${fmt(totalSegments)} segments</div>
    ${targets.total > 0 ? `<div class="wsc-3d-hud-status ${statusClass}">${statusLabel}</div>` : ''}
  `;
}

// ─────────────────────────────────────────────────────────────────────
// Procedural concrete-floor texture (P1-5 2026-05-04). Generated as a
// CanvasTexture so we don't depend on external image assets. Warm gray
// base + subtle noise + faint scratches reads as polished concrete.
// ─────────────────────────────────────────────────────────────────────
let _wsc3dFloorTexture = null;
function _wscGetFloorTexture(THREE) {
  if (_wsc3dFloorTexture) return _wsc3dFloorTexture;
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  // Base — warm light gray concrete
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#d6d3d1');
  grad.addColorStop(0.5, '#c8c5c2');
  grad.addColorStop(1, '#d2cfcc');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Speckle noise — small dots at varying alpha
  for (let i = 0; i < 1800; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = Math.random() * 0.18;
    const shade = Math.random() < 0.5 ? '0,0,0' : '255,255,255';
    ctx.fillStyle = `rgba(${shade},${a})`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  // Faint scratches — short diagonal lines
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 6 + Math.random() * 18;
    const ang = Math.random() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // Joint lines at quarter marks (suggests slab pours)
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1;
  for (let q of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(q * size, 0); ctx.lineTo(q * size, size); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, q * size); ctx.lineTo(size, q * size); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  _wsc3dFloorTexture = tex;
  return tex;
}

function build3DScene() {
  const el = rootEl?.querySelector('#wsc-3d-container');
  if (!el) return;

  try {
    const THREE = /** @type {any} */ (window).THREE;
    if (!THREE) {
      el.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ies-gray-400);">Three.js not loaded. 3D view unavailable.</div>';
      return;
    }

    const width  = el.clientWidth || 800;
    const height = el.clientHeight || 520;

    const scene = new THREE.Scene();
    // Subtle gradient sky-ish background (was flat #e9eef5).
    scene.background = new THREE.Color('#dde4ee');
    scene.fog = new THREE.Fog(0xdde4ee, 600, 2400);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // P1-5: enable soft shadow mapping. Without shadows the rectilinear
    // rack masses had no visual depth — the "racks shown at 50% opacity"
    // crutch was a workaround for that.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    el.appendChild(renderer.domElement);

    // ---------- Lighting ----------
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(180, 320, 200);
    dirLight.castShadow = true;
    // Configure shadow camera frustum to cover the building
    const shadowSpan = 600;
    dirLight.shadow.camera.left   = -shadowSpan;
    dirLight.shadow.camera.right  =  shadowSpan;
    dirLight.shadow.camera.top    =  shadowSpan;
    dirLight.shadow.camera.bottom = -shadowSpan;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far  = 1500;
    dirLight.shadow.mapSize.width  = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);
    scene.add(dirLight.target);

    // Cool sky-fill (no shadow) to lift dark sides
    const fillLight = new THREE.DirectionalLight(0xb6c8e3, 0.30);
    fillLight.position.set(-160, 120, -180);
    scene.add(fillLight);

    // Subtle hemisphere light for ambient color variation
    scene.add(new THREE.HemisphereLight(0xe7eef7, 0.0, 0.25));

    // ---------- Geometry inputs ----------
    // WSC-O1 (2026-05-04): always map longFt -> world X axis (left-to-right
    // on screen, facing camera at default azimuth) and shortFt -> world Z
    // axis (depth into screen). orientFacility() pins the dock-on-long-edge
    // convention shared with the Plan view + Elevation.
    //
    // Phase A (2026-05-05): mode-aware footprint. Design mode renders the
    // sized footprint exactly (no empty-building visual); Constraint mode
    // renders the user's W×D and lets rack-allocation downstream cap to
    // inventory need (leftover floor = capacity slack).
    // Phase A (2026-05-05): mode-aware footprint via _renderFacility helper.
    // Design mode → engine's suggested long/short. Constraint mode → user W×D
    // (with a fallback to sized totalSqft when user hasn't entered dims yet).
    let _sized3d = null;
    try { _sized3d = calc.sizeFacility(toSizingInputs()); } catch {}
    const _facFor3d = _renderFacility(facility, _sized3d);
    let _orient3d = calc.orientFacility(_facFor3d);
    if (!(_orient3d.longFt > 0 && _orient3d.shortFt > 0)) {
      const sT = (_sized3d && _sized3d.totalSqft) || 0;
      _orient3d = calc.orientFacility({ totalSqft: sT });
    }
    const bwFt = _orient3d.longFt  || 500;       // long edge -> X axis
    const bdFt = _orient3d.shortFt || 300;       // short edge -> Z axis
    const ch   = facility.clearHeight || 32;
    const scale = 0.5;                          // 1 ft = 0.5 units

    const W = bwFt * scale;
    const D = bdFt * scale;
    const H = ch * scale;

    // ---------- Floor: textured concrete + safety stripes + aisle striping ----------
    // P1-5: concrete floor with procedural texture. Receives shadows so the
    // racks/pallets cast soft contact shadows that read as physical depth.
    const floorTex = _wscGetFloorTexture(THREE);
    floorTex.repeat.set(Math.max(2, bwFt / 60), Math.max(2, bdFt / 60));
    const floorGeo = new THREE.BoxGeometry(W, 0.4, D);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      color: 0xe8e4df,
      roughness: 0.92,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Yellow safety stripe along the dock face (front, -Z edge).
    // Width = dock-face-width minus safety setback; visual cue you'd see
    // painted on the slab in a real DC.
    const stripeWFt = 6;          // 6 ft wide painted strip
    const stripeOffsetFt = 12;    // offset from front wall
    const stripeGeo = new THREE.BoxGeometry(W * 0.96, 0.05, stripeWFt * scale);
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6 });
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    stripe.position.set(0, 0.06, -D / 2 + (stripeOffsetFt + stripeWFt / 2) * scale);
    stripe.receiveShadow = true;
    scene.add(stripe);

    // ---------- Building shell: tilt-up perimeter panels + truss roof line ----------
    // P1-5: replace edges-only wireframe with light-gray flat panels around
    // the perimeter (suggests precast tilt-up or insulated metal panel) and
    // add a dark line at the roof apex to suggest exposed truss/joist.
    const wallH = H;
    const wallThk = 1.2;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.85, metalness: 0.0 });
    // Long walls (run along X, +/-Z faces)
    const longWallGeo = new THREE.BoxGeometry(W, wallH, wallThk);
    const wN = new THREE.Mesh(longWallGeo, wallMat); wN.position.set(0, wallH / 2,  D / 2 - wallThk / 2); wN.receiveShadow = true; scene.add(wN);
    const wS = new THREE.Mesh(longWallGeo, wallMat); wS.position.set(0, wallH / 2, -D / 2 + wallThk / 2); wS.receiveShadow = true; scene.add(wS);
    // Short walls (run along Z, +/-X faces)
    const shortWallGeo = new THREE.BoxGeometry(wallThk, wallH, D);
    const wE = new THREE.Mesh(shortWallGeo, wallMat); wE.position.set( W / 2 - wallThk / 2, wallH / 2, 0); wE.receiveShadow = true; scene.add(wE);
    const wW = new THREE.Mesh(shortWallGeo, wallMat); wW.position.set(-W / 2 + wallThk / 2, wallH / 2, 0); wW.receiveShadow = true; scene.add(wW);
    // Reveal joint lines on the long walls every ~30 ft
    const jointMat = new THREE.LineBasicMaterial({ color: 0xb1b6bd });
    for (let panelX = -W / 2 + 30 * scale; panelX < W / 2 - 1; panelX += 30 * scale) {
      const a1 = [ panelX, 0,  D / 2 - wallThk / 2 - 0.05];
      const b1 = [ panelX, wallH,  D / 2 - wallThk / 2 - 0.05];
      const g1 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a1), new THREE.Vector3(...b1)]);
      scene.add(new THREE.Line(g1, jointMat));
      const a2 = [ panelX, 0, -D / 2 + wallThk / 2 + 0.05];
      const b2 = [ panelX, wallH, -D / 2 + wallThk / 2 + 0.05];
      const g2 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a2), new THREE.Vector3(...b2)]);
      scene.add(new THREE.Line(g2, jointMat));
    }
    // Roof apex line (suggests exposed truss/joist)
    const roofLineMat = new THREE.LineBasicMaterial({ color: 0x6b7280 });
    const roofPts = [
      new THREE.Vector3(-W / 2, wallH + 0.05,  0),
      new THREE.Vector3( W / 2, wallH + 0.05,  0),
    ];
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(roofPts), roofLineMat));

    // ---------- Storage geometry inputs ----------
    const sized = calc.sizeFacility(toSizingInputs());
    // Phase A: route elevation params through mode-aware facility shape so the
    // 3D scene uses the same dock-on-long-edge dims as the 2D plan + dashboard.
    const elev = calc.elevationParams(_renderFacility(facility, sized));

    const rackDepthFt = elev.rackDepthFt || 4.3;
    const aisleFt     = facility.aisleWidth || elev.aisleWidth || 12;
    const rackHeightFt= calc.topOfSteelFt(elev.rackLevels || 5);
    const moduleFt    = (2 * rackDepthFt) + aisleFt;

    const rackDepthU  = rackDepthFt * scale;
    const moduleU     = moduleFt * scale;
    const rackHeightU = rackHeightFt * scale;

    // Reserve front (-Z, dock face) and back (+Z) margins for staging
    const stagingFt = 30;
    const stagingU  = stagingFt * scale;
    const rackZStart = -D / 2 + stagingU;
    const rackZEnd   =  D / 2 - stagingU;

    // Soft volume materials (lower opacity now that uprights/beams/pallets
    // do the heavy visual lifting). The colored box hints "this zone is
    // full-pallet vs carton-pallet vs shelving" — structure makes it read
    // as a real rack.
    // Rack-type colored volumes: low opacity so the structural detail
    // (uprights + beams + pallets at correct front-face positions) carries
    // the visual reading. depthWrite:false prevents the colored volumes
    // from masking the InstancedMesh structural elements behind them.
    const matFullPallet   = new THREE.MeshStandardMaterial({ color: 0xea580c, transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.7 });
    const matCartonPallet = new THREE.MeshStandardMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.7 });
    const matShelving     = new THREE.MeshStandardMaterial({ color: 0x0d9488, transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.7 });
    // Steel structural color for uprights + beams (instanced).
    const matSteel = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.55, metalness: 0.45 });
    // Wood pallet color (instanced).
    const matPallet = new THREE.MeshStandardMaterial({ color: 0x9a6b3f, roughness: 0.78, metalness: 0.0 });
    // Corrugated carton color for shelving (instanced).
    const matCarton = new THREE.MeshStandardMaterial({ color: 0xb88a52, roughness: 0.92, metalness: 0.0 });
    // Light steel for shelf decks (instanced) — slightly brighter than upright steel
    // so the discrete shelves read clearly against the dim teal volume.
    const matShelfDeck = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6, metalness: 0.4 });

    // Office footprint
    const officeFt = Math.sqrt(Math.max(1, sized.officeSqft));
    const officeU  = officeFt * scale;
    const officeX0 = -W / 2 + 2;
    const officeX1 = officeX0 + officeU;
    const officeZ0 = -D / 2 + stagingU;
    const officeZ1 = officeZ0 + officeU;

    // Forward Pick footprint
    const fpEnabled3D = !!zones.forwardPick?.enabled;
    const fpDepthFt   = fpEnabled3D ? Math.min(60, Math.max(20, (zones.forwardPick?.daysInventory || 3) * 8 + 16)) : 0;
    const fpDepthU    = fpDepthFt * scale;
    const fpZ0        = rackZStart;
    const fpZ1        = fpZ0 + fpDepthU;
    const fpX0        = officeX1 + 2;
    const fpX1        = W / 2 - 2;

    // Count columns available across the building footprint.
    let totalCols = 0;
    {
      let mxScan = -W / 2 + 6 * scale;
      while (mxScan + 2 * rackDepthU + (aisleFt * scale) < W / 2 - 6 * scale) {
        totalCols += 2;
        mxScan += moduleU;
      }
    }
    const palletLevels   = sized.rackLevels  || 5;
    const shelvingLevels = sized.shelfLevels || 5;
    // Target-driven col allocation. Pre-fix this used inventory-unit mix
    // percentages (mix.fullPalletPct etc.), which over-fills shelving by
    // ~6× on typical buildings because shelving bays are 1.4× denser than
    // pallet bays AND shelving levels usually exceed pallet levels — so a
    // 15% inventory-unit share routes to ~25% of POSITIONS at a 15% col
    // allocation. New helper sizes cols to per-type GROSS targets so
    // rendered counts ≈ engine-derived targets; leftover cols become
    // empty floor (visual signature of an over-built building).
    const _3dPlanFullRunFt = (rackZEnd - rackZStart) / scale;
    const _3dPlanXa        = calc.crossAisleLayoutFt(_3dPlanFullRunFt);
    const _3dPlanSegLensFt = Array.from(
      { length: _3dPlanXa.segmentCount },
      () => _3dPlanXa.segmentLenFt,
    );
    const _alloc3D = calc.allocateRackColsByTarget({
      totalCols,
      segmentLensFt: _3dPlanSegLensFt,
      palletLevels,
      shelvingLevels,
      fullPalletTarget:   +sized.positions?.fullPalletGrossPositions   || 0,
      cartonPalletTarget: +sized.positions?.cartonPalletGrossPositions || 0,
      shelvingTarget:     +sized.positions?.shelvingGrossPositions     || 0,
      // Phase F (2026-05-05) — Design mode pads leftover cols across types
      // (matches the 2D plan logic). Constraint mode = target-only.
      fillMode: (facility.sizingMode || 'design') === 'design' ? 'fill' : 'target',
    });
    const fullPalletCols   = _alloc3D.fullPalletCols;
    const cartonPalletCols = _alloc3D.cartonPalletCols;
    const shelvingCols     = _alloc3D.shelvingCols;
    // Phase 3 redesign (2026-05-04): structuralBayWidthFt = upright-to-upright
    // spacing (real selective rack: 9 ft for GMA, 2 pallets per crossbeam).
    // bayWidthFt = position-width convention (4.33 ft = single pallet position),
    // kept for placedRacks → rackPairCapacity → HUD math so HUD position counts
    // stay consistent. The two values are semantically distinct: structuralBayWidthFt
    // governs how often we instance uprights and how long each beam is; bayWidthFt
    // governs how positions are counted. For shelving they're equal (3 ft).
    const _structuralPalletBay = (sized?.unitLoad?.bayWidthFt) || (calc.PALLET_BAY_WIDTH_FT * 2);
    const _structuralShelvingBay = (sized?.cartonProfile?.shelfBayWidthFt) || calc.SHELVING_BAY_WIDTH_FT;
    const TYPES = [
      { typeKey: 'fullPallet',   count: fullPalletCols,   mat: matFullPallet,   heightU: rackHeightU,        kind: 'pallet',   levels: palletLevels,   bayWidthFt: calc.PALLET_BAY_WIDTH_FT,   structuralBayWidthFt: _structuralPalletBay },
      { typeKey: 'cartonPallet', count: cartonPalletCols, mat: matCartonPallet, heightU: rackHeightU * 0.85, kind: 'pallet',   levels: palletLevels,   bayWidthFt: calc.PALLET_BAY_WIDTH_FT,   structuralBayWidthFt: _structuralPalletBay },
      { typeKey: 'shelving',     count: shelvingCols,     mat: matShelving,     heightU: 6.5 * scale,         kind: 'shelving', levels: shelvingLevels, bayWidthFt: calc.SHELVING_BAY_WIDTH_FT, structuralBayWidthFt: _structuralShelvingBay },
    ];

    /** @type {Array<{typeKey:string,colKey:number,segmentLenFt:number,levels:number,bayWidthFt:number}>} */
    const placedRacks = [];

    // ─────────────────────────────────────────────────────────────────
    // Two-pass placement:
    //  Pass 1: walk the building footprint, emit (colored volume per segment,
    //          placedRacks record). Tracks segment metadata for instancing.
    //  Pass 2: build InstancedMesh of uprights + beams + pallets in one go.
    // ─────────────────────────────────────────────────────────────────
    /** @type {Array<{t:any, mx:number, segCenter:number, segLenU:number, side:number, levels:number, bayWidthFt:number, fillPct:number}>} */
    const segmentMeta = [];

    // ─────────────────────────────────────────────────────────────────
    // Master cross-aisle plan (3D): same pattern as the 2D plan view —
    // compute ONCE for the full rack run (rackZStart → rackZEnd) and
    // share segment Z-bands across every column. Cross-aisles align
    // through the entire building instead of jagging at zone boundaries.
    // ─────────────────────────────────────────────────────────────────
    const _3dFullRunFt    = (rackZEnd - rackZStart) / scale;
    const _3dXaMaster     = calc.crossAisleLayoutFt(_3dFullRunFt);
    const _3dSegLenU      = _3dXaMaster.segmentLenFt * scale;
    const _3dGapU         = _3dXaMaster.crossAisleClearFt * scale;
    /** Master segment Z-bands shared by every column (each {z0, z1} in world units). */
    const _3dMasterSegments = [];
    {
      let cz = rackZStart;
      for (let s = 0; s < _3dXaMaster.segmentCount; s++) {
        _3dMasterSegments.push({ z0: cz, z1: cz + _3dSegLenU });
        cz += _3dSegLenU + _3dGapU;
      }
    }

    let mx = -W / 2 + 6 * scale;
    let typeIdx = 0;
    let typeUsed = 0;
    while (mx + 2 * rackDepthU + (aisleFt * scale) < W / 2 - 6 * scale) {
      while (typeIdx < TYPES.length && typeUsed >= TYPES[typeIdx].count) {
        typeIdx++;
        typeUsed = 0;
      }
      // Stop placing once every type's col budget is spent — leftover
      // cols become empty floor (over-built building). Pre-fix this
      // clamped to the last type and silently expanded shelving until
      // the building was full.
      if (typeIdx >= TYPES.length) break;
      const t = TYPES[typeIdx];

      const colLeft  = mx;
      const colRight = mx + 2 * rackDepthU + 0.5;
      const overlapsOfficeX = colRight > officeX0 && colLeft < officeX1;
      const overlapsFpX     = fpEnabled3D && colRight > fpX0 && colLeft < fpX1;

      let thisZStart = rackZStart;
      const thisZEnd = rackZEnd;
      if (overlapsOfficeX) thisZStart = Math.max(thisZStart, officeZ1 + 2);
      if (overlapsFpX)     thisZStart = Math.max(thisZStart, fpZ1 + 2);
      const thisLen = Math.max(0, thisZEnd - thisZStart);

      if (thisLen > 4) {
        // Intersect each master segment with this column's [thisZStart, thisZEnd]
        // window. Truncated columns simply drop the master segments that don't fit.
        for (const mseg of _3dMasterSegments) {
          const segZ0Eff = Math.max(mseg.z0, thisZStart);
          const segZ1Eff = Math.min(mseg.z1, thisZEnd);
          const segLenU  = segZ1Eff - segZ0Eff;
          if (segLenU <= 4) continue;
          const segCenter = segZ0Eff + segLenU / 2;

          // Soft colored volume per rack pair
          const rackGeo = new THREE.BoxGeometry(rackDepthU, t.heightU, segLenU);
          const r1 = new THREE.Mesh(rackGeo, t.mat);
          r1.position.set(mx + rackDepthU / 2, t.heightU / 2, segCenter);
          r1.castShadow = true;
          scene.add(r1);
          const r2 = new THREE.Mesh(rackGeo, t.mat);
          r2.position.set(mx + rackDepthU + 0.5 + rackDepthU / 2, t.heightU / 2, segCenter);
          r2.castShadow = true;
          scene.add(r2);

          // Record both faces for instanced uprights + beams + pallets.
          // fillPct sets how many bays render a pallet (front-of-aisle
          // shows occupancy without saturating the canvas).
          //
          // Phase F.3.1 (2026-05-05) — fix Brock's "why is a big percentage
          // of the racking empty?" callout. Pre-fix: fillPct = utilizationPct
          // / 100 with 30% floor clamp. utilizationPct collapses to ~10% on
          // the totalPalletsOverride path because designedPositions honors
          // the override (65k) but avgPositions still derives from
          // avgUnits/unitsPerPallet (~900 equivalent), giving a 1.4% ratio
          // → clamped to 30% floor → 70% of bays drawn empty. That made the
          // 3D scene read as a chronically under-loaded warehouse, which is
          // a calc bug surfacing as a visualization disaster.
          //
          // New behavior: in Design mode, fillPct = designedPositions /
          // grossPositions (typically 0.80–0.85 because gross = designed ×
          // surge factor). This is the IE-correct "operating fill" — every
          // engineered position is shown occupied, the surge buffer is
          // shown empty. In Constraint mode, fall through to legacy
          // utilizationPct behavior so genuinely under-loaded buildings
          // still surface as empty bays.
          let utilFrac;
          const _modeForFill = facility.sizingMode || 'design';
          if (_modeForFill === 'design') {
            const designedP = +sized.positions?.designedPositions || 0;
            const grossP    = +sized.positions?.grossPositions    || 0;
            const ratio = (grossP > 0) ? designedP / grossP : 0.83;
            utilFrac = Math.max(0.50, Math.min(0.95, ratio));
          } else {
            utilFrac = Math.max(0.30, Math.min(0.95, (sized.utilization?.utilizationPct || 75) / 100));
          }
          // Side A's aisle-facing front sits at mx (left edge of the
          // back-to-back pair). intoRackDir +1 → rack extends to +X.
          // Side B's front sits at the right edge of the pair, extending
          // back into -X. faceX retained as rack-volume center for the
          // soft colored mesh; frontFaceX is the actual structural face
          // where uprights, beams, and pallets attach.
          segmentMeta.push({
            t, mx, segCenter, segLenU,
            side: 'A',
            faceX: mx + rackDepthU / 2,
            frontFaceX: mx,
            intoRackDir: +1,
            levels: t.levels,
            bayWidthFt: t.bayWidthFt,
            structuralBayWidthFt: t.structuralBayWidthFt,
            rackDepthU: rackDepthU,
            heightU: t.heightU,
            fillPct: utilFrac,
          });
          segmentMeta.push({
            t, mx, segCenter, segLenU,
            side: 'B',
            faceX: mx + rackDepthU + 0.5 + rackDepthU / 2,
            frontFaceX: mx + 2 * rackDepthU + 0.5,
            intoRackDir: -1,
            levels: t.levels,
            bayWidthFt: t.bayWidthFt,
            structuralBayWidthFt: t.structuralBayWidthFt,
            rackDepthU: rackDepthU,
            heightU: t.heightU,
            fillPct: utilFrac,
          });

          placedRacks.push({
            typeKey: t.typeKey,
            colKey: mx,
            segmentLenFt: segLenU / scale,
            levels: t.levels,
            bayWidthFt: t.bayWidthFt,
          });
        }
      }
      typeUsed += 2;
      mx += moduleU;
    }

    // ─────────────────────────────────────────────────────────────────
    // Instanced structural detail (uprights + horizontal members + load).
    // Pallet and shelving racks have different scale + load shapes:
    //   • PALLET: ~28 ft tall, 4.33 ft bays, 6 levels, beam + 4 ft pallet
    //   • SHELVING: 6.5 ft tall, 3 ft bays, 7 levels, shelf deck + small carton
    // Mixing them in one loop (pre-fix behavior) put 4 ft pallet boxes into
    // 0.93 ft shelving level slots — the boxes overlapped 4+ levels of
    // shelving and visually merged into horizontal stripes. Splitting by
    // kind keeps each kind's geometry sized correctly.
    // One InstancedMesh per kind-kind → at most 6 extra draw calls total.
    // ─────────────────────────────────────────────────────────────────
    /** @type {Array<typeof segmentMeta[number]>} */
    const palletMeta = [];
    /** @type {Array<typeof segmentMeta[number]>} */
    const shelvingMeta = [];
    for (const m of segmentMeta) {
      if (m && m.t && m.t.kind === 'shelving') shelvingMeta.push(m);
      else palletMeta.push(m);
    }

    // ── Pallet structural detail (uprights + beams + pallets) ──────────
    // Phase 3 redesign (2026-05-04) — IE-correct selective rack:
    //   • Uprights bracket PAIRS of pallets — instanced every structuralBayWidthFt
    //     (9 ft for GMA), not every position-width (4.33 ft). Each upright frame
    //     sits at the bay boundary; pallets sit between them at quarter-points.
    //   • Beams come from sized.rackingStructure[zoneKey].beamRowHeightsFt which
    //     drops the orphan top beam (real selective rack: top pallet load has
    //     nothing above it; beam at level N is structurally pointless) and
    //     respects per-zone bottom-beam toggle (FP off / CP on by default).
    //   • Pallets render TWO per bay — side-by-side along the 9 ft beam at
    //     quarter-points (so each pallet is at bayCenter ± 2.25 ft along Z).
    //     Real selective rack: 2 × 48" pallet + 12" inter/outboard clearances
    //     = 108" beam clear.
    const _rackingStruct = sized?.rackingStructure || {};
    let totalUprights = 0, totalBeams = 0, totalPallets = 0;
    for (const m of palletMeta) {
      const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
      const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
      // Uprights: bays + 1 vertical posts at each bay boundary, TWO per
      // boundary (front-of-aisle + back-of-rack).
      totalUprights += (baysPerFace + 1) * 2;
      // Beams: one per level boundary that the engine says to instance.
      // Default (no bottom beam, no top beam): N-1 beams for N levels.
      // With bottom beam:                     N beams for N levels.
      const rs = _rackingStruct[m.t.typeKey];
      const beamsThisFace = rs
        ? Math.max(0, m.levels - 1 + (rs.bottomBeam ? 1 : 0) + (rs.topBeam ? 1 : 0))
        : Math.max(0, m.levels - 1);
      totalBeams += beamsThisFace;
      // Pallets: bays × 2 (per bay) × levels × fillPct
      totalPallets += Math.floor(baysPerFace * 2 * m.levels * m.fillPct);
    }

    if (totalUprights > 0) {
      const uprightW = 0.18, uprightDepthSlice = 0.18;
      const uprightGeo = new THREE.BoxGeometry(uprightW, 1, uprightDepthSlice);
      const uprightMesh = new THREE.InstancedMesh(uprightGeo, matSteel, totalUprights);
      uprightMesh.castShadow = true;
      uprightMesh.receiveShadow = false;
      const dummy = new THREE.Object3D();
      let ui = 0;
      for (const m of palletMeta) {
        const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
        const bayU = sBay * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const frontX = m.frontFaceX;
        const backX  = m.frontFaceX + m.intoRackDir * m.rackDepthU;
        for (let b = 0; b <= baysPerFace; b++) {
          const z = segZ0 + b * bayU;
          dummy.position.set(frontX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          uprightMesh.setMatrixAt(ui++, dummy.matrix);
          dummy.position.set(backX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          uprightMesh.setMatrixAt(ui++, dummy.matrix);
        }
      }
      uprightMesh.instanceMatrix.needsUpdate = true;
      scene.add(uprightMesh);
    }

    if (totalBeams > 0) {
      const beamGeo = new THREE.BoxGeometry(0.45, 0.18, 1);
      const beamMesh = new THREE.InstancedMesh(beamGeo, matSteel, totalBeams);
      beamMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      let bi = 0;
      for (const m of palletMeta) {
        const beamX = m.frontFaceX + m.intoRackDir * 0.25;
        const levelHeightU = m.heightU / m.levels;
        const rs = _rackingStruct[m.t.typeKey];
        // Build the list of level-boundary indices to instance beams at:
        //   Default (no bottom, no top): k = 1..N-1 (between each level pair)
        //   Bottom beam on:              also include 0 (floor beam)
        //   Top beam on:                 also include N (orphan above top — legacy compat only)
        /** @type {number[]} */
        const levelIndicesForBeams = [];
        if (rs && rs.bottomBeam) levelIndicesForBeams.push(0);
        for (let k = 1; k <= m.levels - 1; k++) levelIndicesForBeams.push(k);
        if (rs && rs.topBeam) levelIndicesForBeams.push(m.levels);
        for (const k of levelIndicesForBeams) {
          const yU = levelHeightU * k;
          dummy.position.set(beamX, yU, m.segCenter);
          dummy.scale.set(1, 1, m.segLenU);
          dummy.updateMatrix();
          beamMesh.setMatrixAt(bi++, dummy.matrix);
        }
      }
      beamMesh.instanceMatrix.needsUpdate = true;
      scene.add(beamMesh);
    }

    if (totalPallets > 0) {
      // Pallet+load: real GMA dimensions. 40" deep into rack × 60" load
      // height × 48" wide along rack run. In feet: 3.33 X-depth × 5.0 Y-height
      // × 4.0 Z-width. (Phase 3 bumped Y from 4.0 → 5.0 to match real load
      // height; the level pitch the rendering anchors at is heightU/N which
      // accommodates 5 ft + clearance.)
      const palletDepthU = 3.33 * scale; // X — into rack
      const palletLoadU  = 4.5  * scale; // Y — loaded pallet height (slightly under level pitch)
      const palletWidthU = 4.0  * scale; // Z — parallel to rack run
      const palletGeo = new THREE.BoxGeometry(palletDepthU, palletLoadU, palletWidthU);
      const palletMesh = new THREE.InstancedMesh(palletGeo, matPallet, totalPallets);
      palletMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      // 2 pallets per bay positioned at quarter-points along Z.
      // For a 9 ft bay: pallet centers at bayCenter ± 2.25 ft (= 0.25 × bayU
      // and 0.75 × bayU from segZ0 + b × bayU).
      const _zFractionsInBay = [0.25, 0.75];
      let pi = 0;
      for (const m of palletMeta) {
        const sBay = m.structuralBayWidthFt || calc.PALLET_BAY_WIDTH_FT * 2;
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / sBay));
        if (baysPerFace === 0) continue;
        const bayU = sBay * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const fillBays = Math.floor(baysPerFace * m.fillPct);
        const palletCenterX = m.frontFaceX + m.intoRackDir * (palletDepthU / 2);
        const levelHeightU  = m.heightU / m.levels;
        for (let lv = 0; lv < m.levels; lv++) {
          const beamY = levelHeightU * lv;
          const yU = beamY + palletLoadU / 2 + 0.05;
          for (let b = 0; b < fillBays; b++) {
            const bayBaseZ = segZ0 + b * bayU;
            for (const zFrac of _zFractionsInBay) {
              const z = bayBaseZ + zFrac * bayU;
              dummy.position.set(palletCenterX, yU, z);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();
              palletMesh.setMatrixAt(pi++, dummy.matrix);
            }
          }
        }
      }
      palletMesh.instanceMatrix.needsUpdate = true;
      scene.add(palletMesh);
    }

    // ── Shelving structural detail (short uprights + shelf decks + cartons) ──
    // Shelving units are ~6.5 ft tall, 3 ft bays, 7 levels. Decks are
    // continuous horizontal planes (wire-mesh shelf, not single beam) and
    // cartons are small boxes (~12"×8"×18") that sit on the shelf deck —
    // not 48" pallets. Pre-fix shelving racks reused the pallet upright
    // logic but loaded with 4-ft pallet geometry that overlapped 4+
    // levels and merged into stripes.
    // Phase 3 redesign (2026-05-04): carton geometry + grid count comes from
    // sized.cartonProfile (real ti×hi math) rather than hardcoded 2×2.
    // cartonsPerShelfAcross × cartonsPerShelfDeep are computed at the user's
    // chosen orientation (L-along-rack vs W-along-rack) against shelf bay
    // width × deck depth. Default 12×9×12 carton on 36" bay × 24" deep deck
    // L-along-rack: 3 across × 2 deep = 6 cartons/shelf.
    const _cartonProfile = sized?.cartonProfile || {};
    const _cartonAcross = Math.max(1, +_cartonProfile.cartonsPerShelfAcross || 2);
    const _cartonDeep   = Math.max(1, +_cartonProfile.cartonsPerShelfDeep   || 2);
    const _cartonsPerShelfBay = _cartonAcross * _cartonDeep;
    let totalShUprights = 0, totalShDecks = 0, totalShCartons = 0;
    for (const m of shelvingMeta) {
      const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / m.bayWidthFt));
      totalShUprights += (baysPerFace + 1) * 2;
      // One deck per level per face (faces share the deck thickness but
      // are visually distinct because uprights split them at the aisle).
      totalShDecks += m.levels;
      // Cartons: bays × levels × fillPct × cartonsPerShelfBay.
      totalShCartons += Math.floor(baysPerFace * m.levels * m.fillPct) * _cartonsPerShelfBay;
    }

    if (totalShUprights > 0) {
      const uprightGeo = new THREE.BoxGeometry(0.12, 1, 0.12);
      const shUprightMesh = new THREE.InstancedMesh(uprightGeo, matSteel, totalShUprights);
      shUprightMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      let si = 0;
      for (const m of shelvingMeta) {
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / m.bayWidthFt));
        const bayU = m.bayWidthFt * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const frontX = m.frontFaceX;
        const backX  = m.frontFaceX + m.intoRackDir * m.rackDepthU;
        for (let b = 0; b <= baysPerFace; b++) {
          const z = segZ0 + b * bayU;
          dummy.position.set(frontX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          shUprightMesh.setMatrixAt(si++, dummy.matrix);
          dummy.position.set(backX, m.heightU / 2, z);
          dummy.scale.set(1, m.heightU, 1);
          dummy.updateMatrix();
          shUprightMesh.setMatrixAt(si++, dummy.matrix);
        }
      }
      shUprightMesh.instanceMatrix.needsUpdate = true;
      scene.add(shUprightMesh);
    }

    if (totalShDecks > 0) {
      // Shelf deck: spans the FULL rack depth (front face → back face) and
      // the FULL segment length, ~½" thick. Default unit; scaled per-
      // instance to (rackDepthU + 0.04, 1, segLenU).
      const deckGeo = new THREE.BoxGeometry(1, 0.04, 1);
      const shDeckMesh = new THREE.InstancedMesh(deckGeo, matShelfDeck, totalShDecks);
      shDeckMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      let di = 0;
      for (const m of shelvingMeta) {
        // Deck X: midway between front and back uprights, centered in
        // the rack depth (frontFaceX → frontFaceX + intoRackDir * rackDepthU).
        const deckX = m.frontFaceX + m.intoRackDir * (m.rackDepthU / 2);
        const deckXU = m.rackDepthU + 0.04;
        for (let lv = 1; lv <= m.levels; lv++) {
          const yU = (m.heightU / m.levels) * lv;
          dummy.position.set(deckX, yU, m.segCenter);
          dummy.scale.set(deckXU, 1, m.segLenU);
          dummy.updateMatrix();
          shDeckMesh.setMatrixAt(di++, dummy.matrix);
        }
      }
      shDeckMesh.instanceMatrix.needsUpdate = true;
      scene.add(shDeckMesh);
    }

    if (totalShCartons > 0) {
      // Phase 3 redesign — carton geometry sized from cartonProfile dims
      // and laid out on the shelf in cartonsPerShelfAcross × cartonsPerShelfDeep
      // grid (depends on user's L/W-along-rack orientation choice).
      // L-along-rack default: 3 across × 2 deep = 6 cartons/shelf for 12×9×12
      // carton on 36"-bay × 24"-deck shelving.
      const cartonLIn = +_cartonProfile.cartonLengthIn || 12;
      const cartonWIn = +_cartonProfile.cartonWidthIn  || 9;
      const cartonHIn = +_cartonProfile.cartonHeightIn || 12;
      const orientation = _cartonProfile.orientation || 'L-along-rack';
      // Map carton dims to (X = into rack, Y = up, Z = along rack run) per orientation.
      // L-along-rack: long edge along rack run (Z), short edge into rack (X).
      // W-along-rack: short edge along rack run (Z), long edge into rack (X).
      const cartonZIn = orientation === 'L-along-rack' ? cartonLIn : cartonWIn;
      const cartonXIn = orientation === 'L-along-rack' ? cartonWIn : cartonLIn;
      const cartonZU = (cartonZIn / 12) * scale;
      const cartonXU = (cartonXIn / 12) * scale;
      const cartonYU = (cartonHIn / 12) * scale;
      const cartonGeo = new THREE.BoxGeometry(cartonXU, cartonYU, cartonZU);
      const shCartonMesh = new THREE.InstancedMesh(cartonGeo, matCarton, totalShCartons);
      shCartonMesh.castShadow = true;
      const dummy = new THREE.Object3D();
      // Grid layout within each shelf bay: cartonsPerShelfAcross along Z
      // (rack run), cartonsPerShelfDeep along X (into rack). Cartons start
      // from the aisle face and extend back into the rack at cartonXU spacing.
      const acrossN = _cartonAcross;
      const deepN   = _cartonDeep;
      let ci = 0;
      for (const m of shelvingMeta) {
        const baysPerFace = Math.max(0, Math.floor((m.segLenU / scale) / m.bayWidthFt));
        if (baysPerFace === 0) continue;
        const bayU = m.bayWidthFt * scale;
        const segZ0 = m.segCenter - m.segLenU / 2;
        const fillBays = Math.floor(baysPerFace * m.fillPct);
        const levelHeightU = m.heightU / m.levels;
        // Center the across-grid in the bay; center deep-grid against the rack depth.
        const acrossSpacing = bayU / acrossN;
        const deepSpacing = m.rackDepthU / Math.max(1, deepN);
        for (let lv = 0; lv < m.levels; lv++) {
          const deckY = levelHeightU * lv;
          const yU = deckY + cartonYU / 2 + 0.04;
          for (let b = 0; b < fillBays; b++) {
            const bayBaseZ = segZ0 + b * bayU;
            for (let a = 0; a < acrossN; a++) {
              const z = bayBaseZ + (a + 0.5) * acrossSpacing;
              for (let d = 0; d < deepN; d++) {
                // X position: from aisle face, step back by deepSpacing,
                // centered within each step. d=0 → closest to aisle.
                const cartonCenterX = m.frontFaceX + m.intoRackDir * ((d + 0.5) * deepSpacing);
                dummy.position.set(cartonCenterX, yU, z);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                shCartonMesh.setMatrixAt(ci++, dummy.matrix);
              }
            }
          }
        }
      }
      shCartonMesh.instanceMatrix.needsUpdate = true;
      scene.add(shCartonMesh);
    }

    // Forward Pick block: medium-height carton-flow strip across the front
    if (fpEnabled3D && fpX1 > fpX0 + 4 && fpDepthU > 4) {
      const fpW = fpX1 - fpX0;
      const fpH = 10 * scale;
      const fpGeo = new THREE.BoxGeometry(fpW, fpH, fpDepthU);
      const fpMat = new THREE.MeshStandardMaterial({ color: 0x7c3aed, transparent: true, opacity: 0.5, roughness: 0.6 });
      const fpMesh = new THREE.Mesh(fpGeo, fpMat);
      fpMesh.position.set((fpX0 + fpX1) / 2, fpH / 2, (fpZ0 + fpZ1) / 2);
      fpMesh.castShadow = true;
      scene.add(fpMesh);
    }

    // ---------- Dock doors ----------
    const twoSided3D = (zones.dockConfig?.sided === 'two');
    const inDoors  = sized.dock.inboundDoors || 0;
    const outDoors = sized.dock.outboundDoors || 0;
    const totalDoors = sized.dock.totalDoors || 0;
    const doorWU = 8 * scale;
    const doorHU = 9 * scale;
    const outboundMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.7 });
    const inboundMat  = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.7 });

    function placeDoors(count, zEdge, mat) {
      if (count <= 0) return;
      const usableW = W - 12 * scale * 2;
      const spacing = usableW / (count + 1);
      for (let i = 0; i < count; i++) {
        const dx = -W / 2 + 12 * scale + spacing * (i + 1) - doorWU / 2;
        const door = new THREE.Mesh(
          new THREE.BoxGeometry(doorWU, doorHU, 0.6),
          mat,
        );
        door.position.set(dx + doorWU / 2, doorHU / 2, zEdge);
        door.castShadow = true;
        scene.add(door);
      }
    }

    if (twoSided3D) {
      placeDoors(outDoors, -D / 2 + 0.1, outboundMat);
      placeDoors(inDoors,   D / 2 - 0.1, inboundMat);
    } else if (totalDoors > 0) {
      placeDoors(totalDoors, -D / 2 + 0.1, outboundMat);
    }

    // ---------- Office cube ----------
    if (sized.officeSqft > 0) {
      const oW = officeU, oD = officeU, oH = 12 * scale;
      const officeMesh = new THREE.Mesh(
        new THREE.BoxGeometry(oW, oH, oD),
        new THREE.MeshStandardMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.55, roughness: 0.6 }),
      );
      officeMesh.position.set(officeX0 + oW / 2, oH / 2, officeZ0 + oD / 2);
      officeMesh.castShadow = true;
      scene.add(officeMesh);
    }

    // ---------- Camera + OrbitControls ----------
    // Iso-style 3/4 view from front-right-above, looking at the building center.
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    const dist0 = Math.max(W, D) * 1.4;
    const camTheta = (3 * Math.PI) / 4;
    const camPhi   = Math.PI / 4;
    camera.position.set(
      dist0 * Math.cos(camPhi) * Math.sin(camTheta),
      dist0 * Math.sin(camPhi),
      dist0 * Math.cos(camPhi) * Math.cos(camTheta),
    );
    camera.lookAt(0, H * 0.4, 0);

    // P1-5: replace the previous custom orbit math with THREE.OrbitControls
    // (loaded from jsdelivr in index.html). Adds smooth damping, pan with
    // right-click, native zoom, sane azimuth bounds. Falls back to a tiny
    // shim if OrbitControls failed to load (network blip).
    let controls = null;
    if (typeof THREE.OrbitControls === 'function') {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.target.set(0, H * 0.4, 0);
      controls.minDistance = Math.max(W, D) * 0.30;
      controls.maxDistance = Math.max(W, D) * 4.0;
      controls.maxPolarAngle = Math.PI / 2 - 0.05;
      controls.update();
    } else {
      // Fallback to a minimal manual handler if OrbitControls didn't load.
      let isDragging = false, lastX = 0, lastY = 0, theta = camTheta, phi = camPhi, dist = dist0;
      function applyCamera() {
        camera.position.set(
          dist * Math.cos(phi) * Math.sin(theta),
          dist * Math.sin(phi),
          dist * Math.cos(phi) * Math.cos(theta),
        );
        camera.lookAt(0, H * 0.4, 0);
      }
      renderer.domElement.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
      window.addEventListener('mouseup',   () => { isDragging = false; });
      renderer.domElement.addEventListener('mousemove', e => {
        if (!isDragging) return;
        theta -= (e.clientX - lastX) * 0.006;
        phi    = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, phi + (e.clientY - lastY) * 0.006));
        lastX = e.clientX; lastY = e.clientY;
        applyCamera();
      });
      renderer.domElement.addEventListener('wheel', e => {
        dist = Math.max(W * 0.5, Math.min(W * 5, dist + e.deltaY * 0.6));
        applyCamera();
        e.preventDefault();
      }, { passive: false });
    }

    // Animate. Capture a local "alive" flag so the loop stops as soon as
    // dispose() is called (e.g. on re-render from a data-field commit).
    let alive = true;
    function animate() {
      if (!rootEl || !alive) return;
      requestAnimationFrame(animate);
      if (controls) controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // ------------------------------------------------------------
    // P0-2: RenderedFacts HUD — paint achieved vs sized counts in the
    // top-right corner of the 3D canvas. Updates every time
    // renderContentView() rebuilds the scene (which fires on any
    // facility/zones/volumes mutation), so counts are always live.
    // ------------------------------------------------------------
    try {
      const facts = calc.rollupRenderedFacts(placedRacks, sized);
      const hud = el.querySelector('#wsc-3d-hud');
      // Phase F.2 (2026-05-05) — pass sizing mode into HUD so the status
      // copy can reframe "Over-built" (which now reads as a bug) into
      // "Padded to footprint" (intentional Phase F.1 fill behavior) when
      // in Design mode.
      if (hud) hud.innerHTML = renderRenderedFactsHud(facts, { palletLevels, shelvingLevels, sized, sizingMode: facility.sizingMode || 'design' });
    } catch (hudErr) {
      console.warn('[WSC] HUD render failed:', hudErr);
    }

    scene3d = {
      dispose() {
        alive = false;
        if (controls && typeof controls.dispose === 'function') controls.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
  } catch (err) {
    console.warn('[WSC] 3D rendering failed:', err);
    el.innerHTML = '<div style="padding:40px; text-align:center; color:var(--ies-gray-400);">3D rendering failed. Check console.</div>';
  }
}


// ============================================================
// WSC ↔ CM INTEGRATION
// ============================================================

function pushToCm() {
  const dock = zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const totalDoors = (dock.inboundDoors || 0) + (dock.outboundDoors || 0);
  // Brock 2026-04-20: push the SIZED total SF (tool's computed answer), not
  // facility.totalSqft (which is the Existing/Target constraint). Falls back
  // to facility.totalSqft if sizing failed or is zero, so a user with only
  // an "existing" value can still push it.
  let sized = null;
  try { sized = calc.sizeFacility(toSizingInputs()); } catch {}
  const sizedSqft = (sized && sized.totalSqft) || 0;
  const effectiveTotalSqft = sizedSqft > 0 ? Math.round(sizedSqft) : (facility.totalSqft || 0);
  // WSC-J1 (2026-04-25): payload expanded from 5 fields to 13. CM uses the
  // additional fields to seed facility geometry, dock split, and pallet
  // positions for the equipment line — it no longer has to re-derive them.
  /** @type {import('./types.js?v=20260418-sL').WscToCmPayload} */
  const payload = {
    totalSqft: effectiveTotalSqft,
    storageSqft: (sized && sized.storageSqft) ? Math.round(sized.storageSqft) : 0,
    clearHeight: facility.clearHeight || 0,
    buildingWidth: facility.buildingWidth || 0,
    buildingDepth: facility.buildingDepth || 0,
    dockDoors: totalDoors,
    inboundDoors: dock.inboundDoors || 0,
    outboundDoors: dock.outboundDoors || 0,
    officeSqft: zones.officeSqft || 0,
    stagingSqft: (zones.receiveStagingSqft || 0) + (zones.shipStagingSqft || 0),
    palletPositions: (sized && sized.positions && sized.positions.grossPositions) || 0,
    sfPerPosition: (sized && sized.sfPerPosition) || 0,
    peakUnitsPerDay: zones.peakUnitsPerDay || 0,
  };
  // Also stash in sessionStorage so CM can pick it up on mount if it isn't
  // already mounted (bus event would be lost). CM clears the stash after consuming.
  try {
    sessionStorage.setItem('wsc_pending_push', JSON.stringify({ ...payload, at: Date.now() }));
  } catch {}
  bus.emit('wsc:push-to-cm', payload);
  console.log('[WSC] Pushed facility data to Cost Model:', payload);
  // Navigate to Cost Model Builder
  window.location.hash = 'designtools/cost-model';
}

/**
 * Handle CM → WSC push (e.g., "Size with Calculator" from CM).
 * @param {import('./types.js?v=20260418-sL').CmToWscPayload} payload
 */
function handleCmPush(payload) {
  // Brock 2026-04-20: Existing/Target SF field was removed from the UI —
  // the sizer is the single source of truth. We still stash CM's totalSqft
  // on facility so a scenario saved from CM doesn't drop the field, but
  // the editor no longer surfaces it. Clear height still drives the
  // elevation view, so keep that.
  if (payload.clearHeight) facility.clearHeight = payload.clearHeight;
  if (payload.totalSqft) facility.totalSqft = payload.totalSqft;
  // 2026-04-30 (G10): persist parent linkage from CM. Without this, the
  // "Linked to Cost Model #..." sidebar footer + Phase 5.4 drillback chips
  // can't render because facility.parent_cost_model_id stays null.
  if (payload.parent_cost_model_id != null) {
    facility.parent_cost_model_id = payload.parent_cost_model_id;
  }
  if (payload.parent_deal_id != null) {
    facility.parent_deal_id = payload.parent_deal_id;
  }
  // Phase 4 of volumes-as-nucleus (Layer A, 2026-04-29): payload now
  // optionally carries channel-derived volume fields. Each is additive —
  // we only overwrite the local volumes when the payload value is positive,
  // so launching from CM with partial data never wipes WSC's defaults.
  if (Number(payload.totalPallets)     > 0) volumes.totalPallets     = Number(payload.totalPallets);
  if (Number(payload.avgDailyInbound)  > 0) volumes.avgDailyInbound  = Number(payload.avgDailyInbound);
  if (Number(payload.avgDailyOutbound) > 0) volumes.avgDailyOutbound = Number(payload.avgDailyOutbound);
  if (Number(payload.peakMultiplier)   > 0) volumes.peakMultiplier   = Number(payload.peakMultiplier);
  if (Number(payload.inventoryTurns)   > 0) volumes.inventoryTurns   = Number(payload.inventoryTurns);
  if (Number(payload.totalSKUs)        > 0) volumes.totalSKUs        = Number(payload.totalSKUs);
  // peakUnitsPerDay lives on `zones`, not `volumes` — it drives the storage
  // on-hand inventory sizing which is in the zones state object.
  if (Number(payload.peakUnitsPerDay)  > 0) zones.peakUnitsPerDay    = Number(payload.peakUnitsPerDay);
  // Phase 4 Layer B (volumes-as-nucleus, 2026-04-29): per-channel mix for
  // storage-media split. Replace wholesale rather than merge — channels are
  // the source of truth from CM at the moment of push.
  if (Array.isArray(payload.channelMixes) && payload.channelMixes.length > 0) {
    zones.channelMixes = payload.channelMixes.map(m => ({
      channelKey: m.channelKey,
      name: m.name || m.channelKey,
      peakUnitsPerDay: Number(m.peakUnitsPerDay) || 0,
      ...(m.storageAllocation ? { storageAllocation: { ...m.storageAllocation } } : {}),
    }));
  }
  renderConfigPanel();
  renderContentView();
  _refreshWscKpis();
  console.log('[WSC] Received facility data from Cost Model:', payload);
}

// ============================================================
// HELPERS
// ============================================================

function createDefaultFacility() {
  return {
    id: null,
    name: 'New Facility',
    // Brock 2026-04-20: totalSqft is the tool's OUTPUT (computed by
    // sizeFacility from peak units / storage / clear ht etc.). Starting
    // at 0 prevents the UI from pretending 150K is a real constraint;
    // the "Match Sized" button puts the computed value in the field
    // when the user wants it as an explicit target.
    totalSqft: 0,
    clearHeight: 32,
    // Brock 2026-04-20: zero defaults let the plan renderer derive a
    // landscape footprint from sized SF (1.5:1). User can still type
    // specific values to override; the renderer auto-swaps if they
    // yield portrait orientation.
    buildingWidth: 0,
    buildingDepth: 0,
    columnSpacingX: 50,
    columnSpacingY: 50,
    storageType: 'single',
    aisleWidth: null,
    palletWidth: 48,
    palletDepth: 40,
    palletHeight: 54,
    beamHeight: 5,
    flueSpace: 3,
    topClearance: 36,
    // ── Phase 2 redesign (2026-05-04) — IE-correct unit-load + carton + SKU + dock fields ──
    // All optional. When omitted, sizeFacility falls back to legacy behavior so
    // existing scenarios load unchanged. The Configure side panel surfaces them
    // as primary inputs in Step 1-4 of the new stepped flow.
    palletType: 'GMA',           // GMA | CHEP | Euro | EuroHalf | Custom
    cartonLengthIn: 12,
    cartonWidthIn: 9,
    cartonHeightIn: 12,
    cartonOrientation: 'L-along-rack',  // L-along-rack | W-along-rack
    cartonsPerPalletOverride: 0,        // > 0 to bypass ti×hi (e.g., from slotting study)
    fullPalletSkus: 0,           // 0 = derive heuristic from positions
    cartonPalletSkus: 0,
    shelvingSkus: 0,
    bottomBeamFp: false,         // distribution default = pallet on slab
    bottomBeamCp: true,          // case-pick zone often wire-decked → bottom beam
    bottomBeamShelving: false,   // shelving has its own deck per level
    topBeam: false,              // legacy compat — orphan beam above top level (real selective: never)
    palletsPerTruck: 26,         // TL load: 26 with stack, 30 floor-loaded
    dwellHoursPerTruck: 1.5,     // live-unload door-occupied time
    shiftHoursPerDay: 16,        // 2-shift default
    surgePctDock: 0.20,          // dock surge buffer
    // Step 5 Override toggle — when false, building dims display as derived;
    // when true, exposes editable Width/Depth inputs (legacy behavior).
    buildingDimsOverride: false,
    // Phase A redesign (2026-05-05) — explicit sizing mode. 'design' = engine
    // answer is the only footprint (W/D inputs hidden, rendering uses sized
    // dims). 'constraint' = user W×D is a hard constraint (W/D first-class
    // inputs, rendering uses user dims, dashboard shows the capacity gap).
    // Replaces the buildingDimsOverride boolean for new facilities; legacy
    // facilities with buildingDimsOverride=true migrate to 'constraint' on load.
    sizingMode: 'design',
    // Phase B redesign (2026-05-05) — ABC velocity tier slotting.
    // Pareto default: A=20% / B=30% / C=50%. A% replaces the legacy
    // hardcoded 20% activePickPct in the forward-pick demand calc, so new
    // scenarios still produce identical sized output until user tunes A%.
    // For legacy scenarios, openEditor's migration block also sets these
    // defaults — engine output unchanged because A=20% matches legacy.
    velocityTierAPct: 20,
    velocityTierBPct: 30,
    velocityTierCPct: 50,
    // Phase B redesign — primary inventory input toggle. 'throughput' is the
    // IE-natural default (user enters annual/daily outbound + DOH + peak;
    // on-hand pallets derive). 'pallets' = user enters on-hand pallet
    // positions directly. The non-primary path renders as a derived tile.
    primaryInventoryInput: 'throughput',
  };
}

function createDefaultZones() {
  return {
    officeSqft: 5000,
    receiveStagingSqft: 10000,
    shipStagingSqft: 10000,
    chargingSqft: 2000,
    repackSqft: 3000,
    otherSqft: 0,
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
    dockConfig: { sided: 'single', inboundDoors: 10, outboundDoors: 12, palletsPerDockHour: 12, dockOperatingHours: 10 },
    productDimensions: { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 },
    forwardPick: { enabled: false, type: 'carton_flow', skuCount: 2000, daysInventory: 3, outboundUnitsPerDay: 5000 },
    optionalZones: { vas: { enabled: false, sqft: 0 }, returns: { enabled: false, sqft: 0 }, chargeback: { enabled: false, sqft: 0 } },
    customZones: [],
    peakUnitsPerDay: 500000,
    avgUnitsPerDay: 350000,
    operatingDaysPerYear: 250,
  };
}

function createDefaultVolumes() {
  // Sized to roughly match the default 150K sqft facility (so Recommended SF
  // lands in the same ballpark as Total SF on a fresh model). 60K pallets/yr
  // at 12 turns = 5K on-hand × 20 sqft/position ≈ 100K sqft reserve, plus
  // 3K SKUs × 2 sqft pick + 1.3x support uplift + dock staging ≈ 140K sqft
  // — matches the 150K facility with modest headroom. Replace with real
  // project numbers as you go.
  return {
    totalPallets: 60000,
    totalSKUs: 3000,
    inventoryTurns: 12,
    avgDailyInbound: 250,
    avgDailyOutbound: 290,
    peakMultiplier: 1.3,
    // Phase B redesign (2026-05-05) — annual outbound + DOH replace the
    // legacy throughput-as-implicit input. When primaryInventoryInput is
    // 'throughput' (default), these drive on-hand units = (annualOutboundUnits
    // / 365) × daysOnHand × peakMultiplier. 0 = fall back to direct
    // peakUnitsPerDay input on zones (legacy behavior).
    annualOutboundUnits: 0,
    daysOnHand: 30,
  };
}

/** Minimal HTML-escape for user-supplied strings in the dashboard. */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Escape for HTML attribute values (covers double-quote contexts).
 * Phase 4 Layer B (volumes-as-nucleus, 2026-04-29) — added because the new
 * per-channel allocation editor and dashboard byChannel rows write
 * channelKey into data-* attribute values.
 */
function escapeAttr(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

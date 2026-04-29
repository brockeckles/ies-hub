/**
 * IES Hub v3 — Warehouse Sizing Calculator UI
 * Builder-pattern layout: config panel on left, capacity dashboard + visualizations on right.
 * 3-way view toggle: Dashboard / Elevation / 3D.
 *
 * @module tools/warehouse-sizing/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sL';
import { state } from '../../shared/state.js?v=20260418-sL';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sL';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260429-wsc-aesthetic';
import * as calc from './calc.js?v=20260425-s11';
import * as api from './api.js?v=20260418-sL';
import * as cmApi from '../cost-model/api.js?v=20260429-vol12';

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
  // Total SF — width × depth when both are set, otherwise facility.totalSqft.
  const w = +facility?.buildingWidth || 0;
  const d = +facility?.buildingDepth || 0;
  const totalSf = (w > 0 && d > 0) ? (w * d) : (facility?.totalSqft || 0);
  items.push({
    label: 'Total SF',
    value: totalSf > 0 ? (totalSf / 1000).toFixed(0) + 'K' : '—',
    hint: 'Building footprint (width × depth, or totalSqft if dims not set).',
  });
  // Dock Doors — zones.dockConfig (NOT facility.*).
  const inb = zones?.dockConfig?.inboundDoors || 0;
  const out = zones?.dockConfig?.outboundDoors || 0;
  items.push({
    label: 'Dock Doors',
    value: (inb + out) > 0 ? String(inb + out) : '—',
    hint: `${inb} inbound + ${out} outbound`,
  });
  // Rack Positions — derived from computeStorage().
  let rackPos = 0;
  let utilFrac = null;
  try {
    const storage = calc.computeStorage(facility, zones);
    rackPos = storage.totalPalletPositions || 0;
    utilFrac = storage.storageUtilization;
  } catch (_) {}
  items.push({
    label: 'Rack Positions',
    value: rackPos > 0 ? (rackPos >= 1000 ? (rackPos / 1000).toFixed(1) + 'K' : String(rackPos)) : '—',
    hint: 'aisleCount × 2 sides × bays × levels (from computeStorage).',
  });
  items.push({
    label: 'Utilization',
    value: (typeof utilFrac === 'number' && utilFrac > 0) ? (utilFrac * 100).toFixed(1) + '%' : '—',
    hint: 'Storage SF / total facility footprint.',
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
    </style>
  `;
}

function bindShellEvents() {
  if (!rootEl) return;
  rootEl.__tcBound = false;

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
      if (isDirty && !confirm('Unsaved changes. Leave for the scenarios list?')) return;
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

/** Build the WSC config-panel HTML. The Save/New/Copy toolbar that used to
 *  sit at the top is now redundant with the chrome's actions rail — dropped. */
function _renderWscConfigHtml() {
  return `
    <!-- Building -->
    <!-- Brock 2026-04-20: Total SF is the tool's OUTPUT, not an input.
         The sizing engine computes it from peak units, storage type,
         clear height, aisle width, etc. The editable "Existing / Target
         SF" field below is now explicitly a CONSTRAINT (e.g., leasing
         an existing 750K-SF building and want to know if the plan
         fits), not the driver. -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Building</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Facility Name</label>
        <input value="${facility.name}" data-fac="name" />
      </div>
      ${(() => {
        // Brock 2026-04-20: Sized Total SF is the tool's primary output.
        // Existing/Target SF + utilization % were removed — not necessary
        // or useful when the sizer drives the answer.
        let sizedSqft = 0;
        try { sizedSqft = calc.sizeFacility(toSizingInputs()).totalSqft || 0; } catch {}
        return `
          <div class="wsc-config-field" style="margin-bottom:8px;">
            <label title="Total facility SF computed by the sizing engine — sum of storage + staging + dock + office. This is the tool's answer to 'how big should this facility be?'">Sized Total SF (computed)</label>
            <div style="padding:6px 10px;background:var(--ies-gray-50);border-radius:6px;font-weight:700;color:var(--ies-blue,#0047AB);">
              ${calc.formatSqft(sizedSqft)}
            </div>
          </div>
        `;
      })()}
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Clear Ht (ft)</label><input type="number" value="${facility.clearHeight}" step="1" data-fac="clearHeight" /></div>
        <div class="wsc-config-field">
          <label>Storage Type</label>
          <select data-fac="storageType">
            ${['single', 'double', 'bulk', 'carton', 'mix'].map(s =>
              `<option value="${s}"${facility.storageType === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Width (ft)</label><input type="number" value="${facility.buildingWidth}" data-fac="buildingWidth" /></div>
        <div class="wsc-config-field"><label>Depth (ft)</label><input type="number" value="${facility.buildingDepth}" data-fac="buildingDepth" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Aisle Width (ft)</label><input type="number" value="${facility.aisleWidth || calc.AISLE_WIDTHS[facility.storageType] || 12}" step="0.5" data-fac="aisleWidth" /></div>
        <div class="wsc-config-field"><label>Col Spacing (ft)</label><input type="number" value="${facility.columnSpacingX || 50}" data-fac="columnSpacingX" /></div>
      </div>
    </div>

    <!-- Pallet Dims -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Pallet Dimensions (in)</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Width</label><input type="number" value="${facility.palletWidth ?? 48}" data-fac="palletWidth" /></div>
        <div class="wsc-config-field"><label>Depth</label><input type="number" value="${facility.palletDepth ?? 40}" data-fac="palletDepth" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Load Height</label><input type="number" value="${facility.palletHeight ?? 54}" data-fac="palletHeight" /></div>
        <div class="wsc-config-field"><label>Beam Ht</label><input type="number" value="${facility.beamHeight ?? 5}" data-fac="beamHeight" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Flue Space</label><input type="number" value="${facility.flueSpace ?? 3}" data-fac="flueSpace" /></div>
        <div class="wsc-config-field"><label>Top Clear</label><input type="number" value="${facility.topClearance ?? 36}" data-fac="topClearance" /></div>
      </div>
    </div>

    <!-- Zones -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Zone Allocation (SF)</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Office</label><input type="number" value="${zones.officeSqft}" data-zone="officeSqft" /></div>
        <div class="wsc-config-field"><label>Recv Staging</label><input type="number" value="${zones.receiveStagingSqft}" data-zone="receiveStagingSqft" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Ship Staging</label><input type="number" value="${zones.shipStagingSqft}" data-zone="shipStagingSqft" /></div>
        <div class="wsc-config-field"><label>Charging</label><input type="number" value="${zones.chargingSqft}" data-zone="chargingSqft" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Repack/VAS</label><input type="number" value="${zones.repackSqft}" data-zone="repackSqft" /></div>
        <div class="wsc-config-field"><label>Other</label><input type="number" value="${zones.otherSqft || 0}" data-zone="otherSqft" /></div>
      </div>
    </div>

    <!-- Volumes -->
    <div class="wsc-config-section">
      <div class="wsc-config-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Volume Requirements</span>
        ${facility.parent_cost_model_id ? `<button class="hub-btn hub-btn-ghost hub-btn-sm" data-action="wsc-pull-from-cm" title="Re-pull volume defaults from the linked Cost Model. Aggregates across all channels in the cost model's Volumes &amp; Profile page." style="font-weight:500;">↻ Pull from CM</button>` : ''}
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="On-hand pallet positions at peak inventory. If > 0, overrides the units×mix derivation — use this when you have an engineered pallet count from a slotting study or an inventory snapshot.">Pallet Positions <span style="color:var(--ies-gray-500);font-weight:400;">(on-hand)</span></label><input type="number" value="${volumes.totalPallets}" data-vol="totalPallets" /></div>
        <div class="wsc-config-field"><label>Total SKUs</label><input type="number" value="${volumes.totalSKUs}" data-vol="totalSKUs" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Inv Turns/Yr</label><input type="number" value="${volumes.inventoryTurns}" step="1" data-vol="inventoryTurns" /></div>
        <div class="wsc-config-field"><label>Peak Multiplier</label><input type="number" value="${volumes.peakMultiplier}" step="0.1" data-vol="peakMultiplier" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Average inbound pallets/day — drives dock throughput sizing when explicit door counts are blank.">Daily Inbound <span style="color:var(--ies-gray-500);font-weight:400;">(pallets/day)</span></label><input type="number" value="${volumes.avgDailyInbound}" data-vol="avgDailyInbound" /></div>
        <div class="wsc-config-field"><label title="Average outbound pallets/day — drives dock throughput sizing when explicit door counts are blank.">Daily Outbound <span style="color:var(--ies-gray-500);font-weight:400;">(pallets/day)</span></label><input type="number" value="${volumes.avgDailyOutbound}" data-vol="avgDailyOutbound" /></div>
      </div>
    </div>

    <!-- Storage Type Allocation -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Storage Type Allocation (%)</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Full Pallet: <span id="wsc-alloc-fp" style="font-weight:700;">${(zones.storageAllocation?.fullPallet || 60)}%</span></label>
        <input type="range" min="0" max="100" value="${zones.storageAllocation?.fullPallet || 60}" data-alloc="fullPallet" style="width:100%;" />
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Carton on Pallet: <span id="wsc-alloc-cp" style="font-weight:700;">${(zones.storageAllocation?.cartonOnPallet || 30)}%</span></label>
        <input type="range" min="0" max="100" value="${zones.storageAllocation?.cartonOnPallet || 30}" data-alloc="cartonOnPallet" style="width:100%;" />
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Carton on Shelving: <span id="wsc-alloc-cs" style="font-weight:700;">${(zones.storageAllocation?.cartonOnShelving || 10)}%</span></label>
        <input type="range" min="0" max="100" value="${zones.storageAllocation?.cartonOnShelving || 10}" data-alloc="cartonOnShelving" style="width:100%;" />
      </div>
      ${(() => {
        // Phase 4 Layer B (volumes-as-nucleus, 2026-04-29): per-channel
        // storageAllocation overrides. Each channel inherits the facility-
        // level allocation above unless explicitly overridden. Inputs
        // accept whole-number percentages; render only when channelMixes
        // is populated (i.e. WSC was launched / pulled from a CM with
        // channels).
        const chans = Array.isArray(zones.channelMixes) ? zones.channelMixes : [];
        if (chans.length === 0) return '';
        const facAlloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
        const rows = chans.map(c => {
          const a = (c.storageAllocation && typeof c.storageAllocation === 'object')
            ? c.storageAllocation
            : null;
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
              <div style="font-size:10px;color:var(--ies-gray-400);font-weight:500;text-transform:none;letter-spacing:0;line-height:1.4;padding-bottom:4px;">FP / CP / CS — must sum to 100. ● = overridden, ○ = inheriting facility allocation.</div>
              ${rows}
            </div>
          </details>`;
      })()}
    </div>

    <!-- Product Dimensions -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Product Dimensions</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Units/Pallet</label><input type="number" value="${zones.productDimensions?.unitsPerPallet || 48}" data-prod="unitsPerPallet" /></div>
        <div class="wsc-config-field"><label>Cartons/Pallet</label><input type="number" value="${zones.productDimensions?.cartonsPerPallet || 12}" data-prod="cartonsPerPallet" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Units/Carton</label><input type="number" value="${zones.productDimensions?.unitsPerCartonPallet || 6}" data-prod="unitsPerCartonPallet" /></div>
        <div class="wsc-config-field"><label>Units/Shelf</label><input type="number" value="${zones.productDimensions?.unitsPerCartonShelving || 6}" data-prod="unitsPerCartonShelving" /></div>
      </div>
    </div>

    <!-- Dock Configuration -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Dock Configuration</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label>Dock Layout</label>
        <select data-dock="sided">
          <option value="single"${zones.dockConfig?.sided === 'single' ? ' selected' : ''}>Single-Sided</option>
          <option value="two"${zones.dockConfig?.sided === 'two' ? ' selected' : ''}>Two-Sided</option>
        </select>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="If > 0, engine uses this explicit count. If 0, engine derives from Daily Inbound × Pallets/Hr × Operating Hrs + 25% surge buffer.">Inbound Doors <span style="color:var(--ies-gray-500);font-weight:400;">(explicit)</span></label><input type="number" value="${zones.dockConfig?.inboundDoors || 10}" data-dock="inboundDoors" /></div>
        <div class="wsc-config-field"><label title="If > 0, engine uses this explicit count. If 0, engine derives from Daily Outbound × Pallets/Hr × Operating Hrs + 25% surge buffer.">Outbound Doors <span style="color:var(--ies-gray-500);font-weight:400;">(explicit)</span></label><input type="number" value="${zones.dockConfig?.outboundDoors || 12}" data-dock="outboundDoors" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label>Pallets/Hr/Door</label><input type="number" value="${zones.dockConfig?.palletsPerDockHour || 12}" step="1" data-dock="palletsPerDockHour" /></div>
        <div class="wsc-config-field"><label>Operating Hrs</label><input type="number" value="${zones.dockConfig?.dockOperatingHours || 10}" step="0.5" data-dock="dockOperatingHours" /></div>
      </div>
    </div>

    <!-- Inventory (WSC-B3 2026-04-25: explicit unit-based section with daily outbound for DIOH) -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Inventory</div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Peak units ON-HAND in inventory at any one time. NOT throughput. The sizing engine converts this to pallet positions via the storage mix and units/pallet ratios. If you have an engineered pallet count, use the Pallet Positions field above instead.">Peak Units On-Hand</label><input type="number" value="${zones.peakUnitsPerDay || 500000}" data-inv="peakUnitsPerDay" /></div>
        <div class="wsc-config-field"><label title="Average units ON-HAND in inventory. Drives DIOH and utilization warning band.">Avg Units On-Hand</label><input type="number" value="${zones.avgUnitsPerDay || 350000}" data-inv="avgUnitsPerDay" /></div>
      </div>
      <div class="wsc-config-row">
        <div class="wsc-config-field"><label title="Operating days per year — used to convert annual outbound volumes to daily.">Operating Days/Yr</label><input type="number" value="${zones.operatingDaysPerYear || 250}" data-inv="operatingDaysPerYear" /></div>
        <div class="wsc-config-field"><label title="Daily outbound units — primary driver of DIOH. If 0, the engine derives from outboundUnitsYr / operatingDays, then falls back to forwardPick.outboundUnitsPerDay.">Daily Outbound (units)</label><input type="number" value="${zones.outboundUnitsPerDay || 0}" data-inv="outboundUnitsPerDay" /></div>
      </div>
      <!-- Derivation summary: shows the user how units → pallet positions math runs -->
      ${(() => {
        const alloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
        const prod = zones.productDimensions || {};
        const peak = zones.peakUnitsPerDay || 500000;
        const upp = prod.unitsPerPallet || 48;
        const ucp = prod.unitsPerCartonPallet || 6;
        const cpp = prod.cartonsPerPallet || 12;
        const ucs = prod.unitsPerCartonShelving || 6;
        const cpl = prod.cartonsPerLocation || 4;
        const fpUnits = Math.round(peak * (alloc.fullPallet || 0) / 100);
        const cpUnits = Math.round(peak * (alloc.cartonOnPallet || 0) / 100);
        const csUnits = Math.round(peak * (alloc.cartonOnShelving || 0) / 100);
        const fpPos = upp > 0 ? Math.ceil(fpUnits / upp) : 0;
        const cpPos = (ucp > 0 && cpp > 0) ? Math.ceil(cpUnits / ucp / cpp) : 0;
        const csLoc = (ucs > 0 && cpl > 0) ? Math.ceil(csUnits / ucs / cpl) : 0;
        return `
          <div style="margin-top:10px;padding:8px 10px;background:var(--ies-gray-50);border-radius:4px;font-size:11px;color:var(--ies-gray-700);">
            <div style="font-weight:700;margin-bottom:4px;color:var(--ies-gray-500);text-transform:uppercase;font-size:10px;">Units → Positions derivation</div>
            <div>Full Pallet: ${peak.toLocaleString()} × ${alloc.fullPallet||0}% / ${upp} = <strong>${fpPos.toLocaleString()} pos</strong></div>
            <div>Carton/Pallet: ${peak.toLocaleString()} × ${alloc.cartonOnPallet||0}% / ${ucp} / ${cpp} = <strong>${cpPos.toLocaleString()} pos</strong></div>
            <div>Carton/Shelving: ${peak.toLocaleString()} × ${alloc.cartonOnShelving||0}% / ${ucs} / ${cpl} = <strong>${csLoc.toLocaleString()} loc</strong></div>
          </div>
        `;
      })()}
    </div>

    <!-- Forward Pick -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Forward Pick Area</div>
      <div class="wsc-config-field" style="margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" ${zones.forwardPick?.enabled ? 'checked' : ''} data-fwd="enabled" style="margin:0;" />
          <span>Enable Forward Pick</span>
        </label>
      </div>
      <div class="wsc-config-field" style="margin-bottom:8px; display:${zones.forwardPick?.enabled ? 'block' : 'none'};" id="wsc-fwd-opts">
        <label>Pick Type</label>
        <select data-fwd="type">
          <option value="carton_flow"${zones.forwardPick?.type === 'carton_flow' ? ' selected' : ''}>Carton Flow</option>
          <option value="light_case"${zones.forwardPick?.type === 'light_case' ? ' selected' : ''}>Light Case</option>
          <option value="heavy_case"${zones.forwardPick?.type === 'heavy_case' ? ' selected' : ''}>Heavy Case</option>
        </select>
      </div>
      <div class="wsc-config-row" style="display:${zones.forwardPick?.enabled ? 'grid' : 'none'};" id="wsc-fwd-params">
        <div class="wsc-config-field"><label>SKU Count</label><input type="number" value="${zones.forwardPick?.skuCount || 2000}" data-fwd="skuCount" /></div>
        <div class="wsc-config-field"><label>Days Inventory</label><input type="number" value="${zones.forwardPick?.daysInventory || 3}" step="0.5" data-fwd="daysInventory" /></div>
      </div>
      <div class="wsc-config-field" style="display:${zones.forwardPick?.enabled ? 'block' : 'none'}; margin-top:8px;" id="wsc-fwd-outbound">
        <label>Outbound Units/Day</label>
        <input type="number" value="${zones.forwardPick?.outboundUnitsPerDay || 5000}" data-fwd="outboundUnitsPerDay" />
      </div>
    </div>

    <!-- Optional Zones -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Optional Zones</div>
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
    </div>

    <!-- Custom Zones -->
    <div class="wsc-config-section">
      <div class="wsc-config-title">Custom Zones</div>
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

  // Storage allocation sliders — facility-level (legacy single mix).
  // Use a strict CSS selector to avoid accidentally matching the per-channel
  // [data-channel-alloc] inputs added in Phase 4 Layer B (those have a
  // different attribute name).
  panel.querySelectorAll('input[data-alloc]').forEach(input => {
    input.addEventListener('change', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.alloc;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      if (!zones.storageAllocation) zones.storageAllocation = { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
      zones.storageAllocation[field] = val;
      // Update display label
      const label = panel.querySelector(`#wsc-alloc-${field.slice(0, 2)}`);
      if (label) label.textContent = val + '%';
      isDirty = true;
      renderContentView();
    });
    input.addEventListener('input', e => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.alloc;
      const val = parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0;
      const label = panel.querySelector(`#wsc-alloc-${field.slice(0, 2)}`);
      if (label) label.textContent = val + '%';
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

  // Forward pick fields (with input debounce for live update)
  panel.querySelectorAll('[data-fwd]').forEach(input => {
    const handleChange = (e) => {
      const field = /** @type {HTMLInputElement} */ (e.target).dataset.fwd;
      if (!zones.forwardPick) zones.forwardPick = { enabled: false, type: 'carton_flow', skuCount: 2000, daysInventory: 3, outboundUnitsPerDay: 5000 };
      if (field === 'enabled') {
        zones.forwardPick[field] = /** @type {HTMLInputElement} */ (e.target).checked;
        const opts = panel.querySelector('#wsc-fwd-opts');
        const params = panel.querySelector('#wsc-fwd-params');
        const outbound = panel.querySelector('#wsc-fwd-outbound');
        if (opts) opts.style.display = zones.forwardPick.enabled ? 'block' : 'none';
        if (params) params.style.display = zones.forwardPick.enabled ? 'grid' : 'none';
        if (outbound) outbound.style.display = zones.forwardPick.enabled ? 'block' : 'none';
      } else {
        const val = input.type === 'number' ? parseFloat(/** @type {HTMLInputElement} */ (e.target).value) || 0 : /** @type {HTMLInputElement} */ (e.target).value;
        zones.forwardPick[field] = val;
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
  panel.querySelector('[data-action="wsc-new"]')?.addEventListener('click', () => {
    if (isDirty && !confirm('Unsaved changes. Start new?')) return;
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
    if (isDirty && !confirm('Unsaved changes. Leave for the scenarios list?')) return;
    isDirty = false;
    viewMode = 'landing';
    await renderLanding();
  });

  // Copy-summary button
  panel.querySelector('[data-action="wsc-copy-summary"]')?.addEventListener('click', () => {
    copySummaryToClipboard();
  });

  panel.querySelector('[data-action="wsc-save"]')?.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const saved = await api.saveConfig({ ...facility, zones, volumes });
      facility.id = saved.id || saved[0]?.id || facility.id;
      isDirty = false;
      bus.emit('wsc:saved', { id: facility.id });
      btn.textContent = '✓ Saved';
      showWscToast(`Saved "${facility.name || 'Untitled'}"`, 'success');
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    } catch (err) {
      console.error('[WSC] Save failed:', err);
      btn.textContent = orig;
      btn.disabled = false;
      showWscToast('Save failed: ' + err.message, 'error');
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
  return `
    <div class="hub-card">
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
  const elev = calc.elevationParams(facility);
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

  // Building dimensions (ft) — derive from sized SF when either input is
  // missing OR the user-entered footprint can't fit the sized facility
  // (prevents the "300×500 = 150K but sized = 578K" rendering where
  // storage blocks overflow the canvas).
  //
  // Brock 2026-04-20: also ensure LANDSCAPE orientation — warehouses
  // conventionally have the dock face on the long edge, so we always
  // render widthFt (horizontal) >= depthFt (vertical). Stops the
  // "weird portrait building" issue when the user's saved values
  // have depth > width.
  let widthFt  = Number(facility.buildingWidth)  || 0;
  let depthFt  = Number(facility.buildingDepth)  || 0;
  const footprintFits = widthFt > 0 && depthFt > 0 && (widthFt * depthFt) >= totalSqft * 0.98;
  if (!footprintFits) {
    // Derive 1.5:1 landscape footprint from sized SF.
    widthFt  = Math.round(Math.sqrt(totalSqft * 1.5));
    depthFt  = Math.round(totalSqft / Math.max(1, widthFt));
  }
  // Enforce landscape: swap if user input was portrait.
  if (widthFt < depthFt) [widthFt, depthFt] = [depthFt, widthFt];

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

  // First pass: count rack columns to allocate by storage mix.
  let totalCols = 0;
  {
    let mxScan = X0 + sideMarginPx;
    while (mxScan + 2 * rackPx + aislePx < X0 + Wpx - sideMarginPx) {
      totalCols += 2;
      mxScan += modulePx;
    }
  }
  const mix = sized.meta?.normalisedMix || { fullPalletPct: 0.6, cartonOnPalletPct: 0.3, cartonOnShelvingPct: 0.1 };
  const fullPalletCols = Math.round(totalCols * mix.fullPalletPct);
  const cartonPalletCols = Math.round(totalCols * mix.cartonOnPalletPct);
  // Remainder = shelving (catches rounding)
  const shelvingCols = Math.max(0, totalCols - fullPalletCols - cartonPalletCols);

  // Storage type styles: orange = full pallet, amber = carton on pallet,
  // teal = carton shelving (drawn as shorter, denser blocks).
  const TYPES = [
    { count: fullPalletCols,   fill: '#ea580c', stroke: '#9a3412', label: 'Full Pallet'      },
    { count: cartonPalletCols, fill: '#f59e0b', stroke: '#b45309', label: 'Carton on Pallet' },
    { count: shelvingCols,     fill: '#0d9488', stroke: '#0f766e', label: 'Carton Shelving'  },
  ];

  // Rack loop — coloured by storage type, shortened around office and FP.
  ctx.lineWidth = 1;
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
    const t = TYPES[Math.min(typeIdx, TYPES.length - 1)];
    ctx.fillStyle   = t.fill;
    ctx.strokeStyle = t.stroke;

    const racksTop = storageY + 8 * pxPerFt;
    let racksBottom = storageY + storageH - 8 * pxPerFt;

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
      // Cross-aisle insertion: split long racking runs with ~10 ft cross-aisles
      // every ~200 ft so forklifts can navigate between rack rows. Mirrors
      // real-world warehouse layout (OSHA/NFPA egress + turn-around practice).
      const crossAisleFt = 10; // typical cross-aisle clear width
      const segmentLenFt = 200; // typical spacing between cross-aisles
      const rackRunLenFt = racksH / pxPerFt;
      // Only split when the run is long enough for at least one cross-aisle.
      const segmentCount = rackRunLenFt > segmentLenFt + crossAisleFt
        ? Math.max(1, Math.ceil(rackRunLenFt / (segmentLenFt + crossAisleFt)))
        : 1;
      const crossAislePx = crossAisleFt * pxPerFt;
      // Even segment heights so cross-aisles land at predictable positions.
      const totalCrossAislePx = (segmentCount - 1) * crossAislePx;
      const perSegmentPx = Math.max(8, (racksH - totalCrossAislePx) / segmentCount);

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

      let segY = racksTop;
      for (let s = 0; s < segmentCount; s++) {
        drawSegment(segY, perSegmentPx);
        segY += perSegmentPx + crossAislePx;
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
    const doorWPx   = Math.max(6, 8 * pxPerFt);   // 8 ft door
    const minSpcPx  = Math.max(10, 12 * pxPerFt); // 12 ft on-center floor (real warehouse standard)
    // Distribute doors evenly across the given span. Leave an edge margin
    // equal to one door width so the first/last door isn't flush to the
    // corner (building corner columns, sprinkler risers, etc.).
    const edgeMargin = doorWPx * 1.5;
    const spanStart = xStart + edgeMargin;
    const spanEnd   = xEnd   - edgeMargin;
    const span      = Math.max(0, spanEnd - spanStart);
    // Spacing stretches to fill the span, but never drops below the 12-ft floor.
    const rawSpc = count > 1 ? span / (count - 1) : 0;
    const spc = Math.max(minSpcPx, rawSpc);
    // If doors at minimum spacing exceed the span, fall back to centering.
    const neededSpan = (count - 1) * spc;
    const firstX = neededSpan > span
      ? xStart + (xEnd - xStart - neededSpan) / 2
      : spanStart;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#7f1d1d';
    ctx.lineWidth = 1;
    for (let i = 0; i < count; i++) {
      const cx = firstX + i * spc;
      ctx.fillRect(cx - doorWPx / 2, yTop, doorWPx, 12);
      ctx.strokeRect(cx - doorWPx / 2, yTop, doorWPx, 12);
    }
    ctx.fillStyle = '#7f1d1d';
    ctx.font = 'bold 10px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, (xStart + xEnd) / 2, yTop + (labelAbove ? -6 : 28));
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

  return {
    peakUnits: zones.peakUnitsPerDay || 500000,
    avgUnits: zones.avgUnitsPerDay || 350000,
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
      activePickPct: 20,                    // audit default — full UI for this is in B-series
      pickType: fp.type === 'heavy_case' ? 'pallet' : 'carton',
      daysInventory: fp.daysInventory || 3,
    } : null,
    optionalZones,
    customZones: (zones.customZones || []).map(z => ({ label: z.name || 'Custom', sqft: z.sqft || 0 })),
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
  const elev = calc.elevationParams(facility);

  // v2-equivalent volume-first sizing (the engine we actually trust).
  const sized = calc.sizeFacility(toSizingInputs());

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
          <tr><td>Full Pallet (${Math.round(sized.meta.normalisedMix.fullPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.fullPalletPositions.toLocaleString()} pos</td></tr>
          <tr><td>Carton on Pallet (${Math.round(sized.meta.normalisedMix.cartonOnPalletPct * 100)}%)</td><td class="cm-num">${sized.positions.cartonPalletPositions.toLocaleString()} pos</td></tr>
          <tr><td>Carton Shelving (${Math.round(sized.meta.normalisedMix.cartonOnShelvingPct * 100)}%)</td><td class="cm-num">${sized.positions.shelvingPositions.toLocaleString()} loc</td></tr>
          <tr><td><strong>Designed (post-honeycomb)</strong></td><td class="cm-num"><strong>${sized.utilization.designed.toLocaleString()} pos</strong></td></tr>
          <tr><td>+ Surge buffer</td><td class="cm-num">${sized.positions.surgePositions.toLocaleString()} pos</td></tr>
          <tr style="border-top:2px solid var(--ies-blue);"><td><strong>Gross Positions</strong></td><td class="cm-num"><strong>${sized.positions.grossPositions.toLocaleString()}</strong></td></tr>

          ${byChannel.length > 0 ? `
            <tr><td colspan="2" style="padding-top:14px;font-weight:700;color:var(--ies-blue);font-size:11px;text-transform:uppercase;" title="Phase 4 Layer B (volumes-as-nucleus): positions sized per-channel using each channel's storageAllocation override (falls back to facility allocation when no override).">Inventory → Positions by Channel</td></tr>
            ${byChannel.map(c => `
              <tr>
                <td style="padding-left:8px;">${escapeHtml(c.name)}</td>
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
  const elev = calc.elevationParams(facility, zones);

  return `
    <div class="hub-card">
      <div class="text-subtitle mb-4">Building Cross-Section (Elevation View)</div>
      <canvas id="wsc-elevation-canvas" width="900" height="450" style="width:100%; border:1px solid var(--ies-gray-200); border-radius:6px; background:#fff;"></canvas>
      <div style="font-size:11px; color:var(--ies-gray-400); margin-top:8px;">
        ${facility.storageType.charAt(0).toUpperCase() + facility.storageType.slice(1)}-deep racking ·
        ${elev.rackLevels} levels ·
        ${calc.formatFt(elev.aisleWidth)} aisles ·
        ${calc.formatFt(facility.clearHeight)} clear height
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

  const w = canvas.width;
  const h = canvas.height;
  const pad = { l: 60, r: 100, t: 40, b: 60 };
  const drawW = w - pad.l - pad.r;
  const drawH = h - pad.t - pad.b;

  const elev = calc.elevationParams(facility);
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
  const sized = calc.sizeFacility(toSizingInputs());
  container.innerHTML = `
    <div class="hub-card" style="padding:16px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
        <h3 class="text-subtitle" style="margin:0;">3D Walkthrough</h3>
        <span class="text-caption text-muted">
          ${calc.formatSqft(sized.totalSqft)} sized  ·  ${facility.buildingWidth || '—'} × ${facility.buildingDepth || '—'} ft  ·  clear ht ${facility.clearHeight || 0} ft  ·  ${sized.dock.totalDoors} dock doors
        </span>
      </div>
      <div id="wsc-3d-container" style="width:100%; height:520px; background:#e9eef5; border-radius:6px; overflow:hidden;"></div>
      <div style="font-size:11px; color:var(--ies-gray-500); margin-top:8px;">
        Drag to orbit  ·  Scroll to zoom  ·  Racks shown at 50% opacity for floor visibility
      </div>
    </div>
  `;

  // Defer 3D scene build so the flex layout settles first.
  setTimeout(() => build3DScene(), 80);
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
    scene.background = new THREE.Color('#e9eef5');

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    // ---------- Lighting ----------
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(120, 200, 120);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xb6c8e3, 0.25);
    fillLight.position.set(-120, 80, -120);
    scene.add(fillLight);

    // ---------- Geometry inputs ----------
    const bw = facility.buildingWidth  || 300;  // X axis
    const bd = facility.buildingDepth  || 500;  // Z axis (depth into screen)
    const ch = facility.clearHeight    || 32;
    const scale = 0.5;                          // 1 ft = 0.5 units

    const W = bw * scale;
    const D = bd * scale;
    const H = ch * scale;

    // ---------- Floor with grid ----------
    const floorGeo = new THREE.BoxGeometry(W, 0.4, D);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xd6d3d1 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.2;
    scene.add(floor);

    const grid = new THREE.GridHelper(Math.max(W, D), 20, 0x9ca3af, 0xcbd5e1);
    grid.position.y = 0.05;
    scene.add(grid);

    // ---------- Wall frame (edges only — keep interior visible) ----------
    const wallGeo = new THREE.BoxGeometry(W, H, D);
    const edges = new THREE.EdgesGeometry(wallGeo);
    const edgeLine = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x4b5563, linewidth: 2 }));
    edgeLine.position.set(0, H / 2, 0);
    scene.add(edgeLine);

    // ---------- Rack rows (orange, semi-transparent so we can see through) ----------
    const elev = calc.elevationParams(facility);
    const sized = calc.sizeFacility(toSizingInputs());

    const rackDepthFt = elev.rackDepthFt || 4.3;
    const aisleFt     = facility.aisleWidth || elev.aisleWidth || 12;
    const rackHeightFt= calc.topOfSteelFt(elev.rackLevels || 5);
    const moduleFt    = (2 * rackDepthFt) + aisleFt;

    const rackDepthU  = rackDepthFt * scale;
    const moduleU     = moduleFt * scale;
    const rackHeightU = rackHeightFt * scale;

    // Reserve front (-Z, dock face) and back (+Z) margins for staging
    const stagingFt = 30;            // 30 ft staging strip front + back
    const stagingU  = stagingFt * scale;
    const rackZStart = -D / 2 + stagingU;
    const rackZEnd   =  D / 2 - stagingU;
    const rackLengthU= Math.max(0, rackZEnd - rackZStart);

    // Storage-type materials: pallet vs shelving render at different heights.
    const matFullPallet   = new THREE.MeshStandardMaterial({ color: 0xea580c, transparent: true, opacity: 0.6 });
    const matCartonPallet = new THREE.MeshStandardMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.6 });
    const matShelving     = new THREE.MeshStandardMaterial({ color: 0x0d9488, transparent: true, opacity: 0.65 });
    const wirePallet      = new THREE.LineBasicMaterial({ color: 0x9a3412 });
    const wireShelving    = new THREE.LineBasicMaterial({ color: 0x0f766e });

    // Office footprint — computed up-front so racks can avoid it.
    const officeFt = Math.sqrt(Math.max(1, sized.officeSqft));
    const officeU  = officeFt * scale;
    const officeX0 = -W / 2 + 2;
    const officeX1 = officeX0 + officeU;
    const officeZ0 = -D / 2 + stagingU;                        // front edge of storage zone
    const officeZ1 = officeZ0 + officeU;

    // Forward Pick footprint — strip across the front of storage (zStart..zStart+fpDepth)
    const fpEnabled3D = !!zones.forwardPick?.enabled;
    const fpDepthFt   = fpEnabled3D ? Math.min(60, Math.max(20, (zones.forwardPick?.daysInventory || 3) * 8 + 16)) : 0;
    const fpDepthU    = fpDepthFt * scale;
    const fpZ0        = rackZStart;                            // matches storage front
    const fpZ1        = fpZ0 + fpDepthU;
    const fpX0        = officeX1 + 2;                          // right of office
    const fpX1        = W / 2 - 2;

    // Count columns to allocate by storage mix
    let totalCols = 0;
    {
      let mxScan = -W / 2 + 6 * scale;
      while (mxScan + 2 * rackDepthU + (aisleFt * scale) < W / 2 - 6 * scale) {
        totalCols += 2;
        mxScan += moduleU;
      }
    }
    const mix = sized.meta?.normalisedMix || { fullPalletPct: 0.6, cartonOnPalletPct: 0.3, cartonOnShelvingPct: 0.1 };
    const fullPalletCols   = Math.round(totalCols * mix.fullPalletPct);
    const cartonPalletCols = Math.round(totalCols * mix.cartonOnPalletPct);
    const shelvingCols     = Math.max(0, totalCols - fullPalletCols - cartonPalletCols);
    const TYPES = [
      { count: fullPalletCols,   mat: matFullPallet,   wire: wirePallet,   heightU: rackHeightU,        kind: 'pallet' },
      { count: cartonPalletCols, mat: matCartonPallet, wire: wirePallet,   heightU: rackHeightU * 0.85, kind: 'pallet' },
      { count: shelvingCols,     mat: matShelving,     wire: wireShelving, heightU: 6.5 * scale,         kind: 'shelving' },
    ];

    let mx = -W / 2 + 6 * scale;
    let typeIdx = 0;
    let typeUsed = 0;
    while (mx + 2 * rackDepthU + (aisleFt * scale) < W / 2 - 6 * scale) {
      while (typeIdx < TYPES.length && typeUsed >= TYPES[typeIdx].count) {
        typeIdx++;
        typeUsed = 0;
      }
      const t = TYPES[Math.min(typeIdx, TYPES.length - 1)];

      const colLeft  = mx;
      const colRight = mx + 2 * rackDepthU + 0.5;
      const overlapsOfficeX = colRight > officeX0 && colLeft < officeX1;
      const overlapsFpX     = fpEnabled3D && colRight > fpX0 && colLeft < fpX1;

      // Z-extent: shorten if column overlaps office (stops behind office)
      // OR if it overlaps the forward-pick strip (stops behind FP).
      let thisZStart = rackZStart;
      const thisZEnd = rackZEnd;
      if (overlapsOfficeX) thisZStart = Math.max(thisZStart, officeZ1 + 2);
      if (overlapsFpX)     thisZStart = Math.max(thisZStart, fpZ1 + 2);
      const thisLen = Math.max(0, thisZEnd - thisZStart);

      if (thisLen > 4) {
        const zCenter = (thisZStart + thisZEnd) / 2;
        const rackGeo = new THREE.BoxGeometry(rackDepthU, t.heightU, thisLen);
        const r1 = new THREE.Mesh(rackGeo, t.mat);
        r1.position.set(mx + rackDepthU / 2, t.heightU / 2, zCenter);
        scene.add(r1);
        const r2 = new THREE.Mesh(rackGeo, t.mat);
        r2.position.set(mx + rackDepthU + 0.5 + rackDepthU / 2, t.heightU / 2, zCenter);
        scene.add(r2);
        const wf1 = new THREE.LineSegments(new THREE.EdgesGeometry(rackGeo), t.wire);
        wf1.position.copy(r1.position);
        scene.add(wf1);
        const wf2 = new THREE.LineSegments(new THREE.EdgesGeometry(rackGeo), t.wire);
        wf2.position.copy(r2.position);
        scene.add(wf2);
      }
      typeUsed += 2;
      mx += moduleU;
    }

    // Forward Pick block: medium-height carton-flow strip across the front
    if (fpEnabled3D && fpX1 > fpX0 + 4 && fpDepthU > 4) {
      const fpW = fpX1 - fpX0;
      const fpH = 10 * scale; // 10 ft pick-module height
      const fpGeo = new THREE.BoxGeometry(fpW, fpH, fpDepthU);
      const fpMat = new THREE.MeshStandardMaterial({ color: 0x7c3aed, transparent: true, opacity: 0.5 });
      const fpMesh = new THREE.Mesh(fpGeo, fpMat);
      fpMesh.position.set((fpX0 + fpX1) / 2, fpH / 2, (fpZ0 + fpZ1) / 2);
      scene.add(fpMesh);
      const fpEdges = new THREE.LineSegments(new THREE.EdgesGeometry(fpGeo), new THREE.LineBasicMaterial({ color: 0x5b21b6 }));
      fpEdges.position.copy(fpMesh.position);
      scene.add(fpEdges);
    }

    // ---------- Dock doors ----------
    // Single-sided: all doors on front (-Z) wall.
    // Two-sided: outbound on front (-Z), inbound on back (+Z).
    const twoSided3D = (zones.dockConfig?.sided === 'two');
    const inDoors  = sized.dock.inboundDoors || 0;
    const outDoors = sized.dock.outboundDoors || 0;
    const totalDoors = sized.dock.totalDoors || 0;
    const doorWU = 8 * scale;
    const doorHU = 9 * scale;
    const outboundMat = new THREE.MeshStandardMaterial({ color: 0x1f2937 });
    const inboundMat  = new THREE.MeshStandardMaterial({ color: 0x1d4ed8 });

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
        scene.add(door);
      }
    }

    if (twoSided3D) {
      placeDoors(outDoors, -D / 2 + 0.1, outboundMat);
      placeDoors(inDoors,   D / 2 - 0.1, inboundMat);
    } else if (totalDoors > 0) {
      // Combined I/O on the front wall
      placeDoors(totalDoors, -D / 2 + 0.1, outboundMat);
    }

    // ---------- Office cube (front-left corner — already reserved by rack loop) ----------
    if (sized.officeSqft > 0) {
      const oW = officeU;             // computed above
      const oD = officeU;
      const oH = 12 * scale;          // 12 ft office ceiling
      const officeMesh = new THREE.Mesh(
        new THREE.BoxGeometry(oW, oH, oD),
        new THREE.MeshStandardMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.55 }),
      );
      officeMesh.position.set(officeX0 + oW / 2, oH / 2, officeZ0 + oD / 2);
      scene.add(officeMesh);
      const oEdges = new THREE.LineSegments(new THREE.EdgesGeometry(officeMesh.geometry), new THREE.LineBasicMaterial({ color: 0x5b21b6 }));
      oEdges.position.copy(officeMesh.position);
      scene.add(oEdges);
    }

    // ---------- Camera ----------
    // Iso-style 3/4 view from front-right-above, looking at the building center
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    const dist0 = Math.max(W, D) * 1.4;
    // Position camera so the dock face (-Z in our model) is toward the user.
    // Iso-style 3/4 view from front-right-above looking back at the building.
    let theta = (3 * Math.PI) / 4;   // 135° — puts camera at +X, -Z (front-right)
    let phi   = Math.PI / 4;          // 45° elevation
    let dist  = dist0;
    function applyCamera() {
      camera.position.set(
        dist * Math.cos(phi) * Math.sin(theta),
        dist * Math.sin(phi),
        dist * Math.cos(phi) * Math.cos(theta),
      );
      camera.lookAt(0, H * 0.4, 0);
    }
    applyCamera();

    // Orbit controls (manual)
    let isDragging = false, lastX = 0, lastY = 0;
    renderer.domElement.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener('mouseup',   () => { isDragging = false; });
    renderer.domElement.addEventListener('mousemove', e => {
      if (!isDragging) return;
      theta -= (e.clientX - lastX) * 0.006;
      phi    = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, phi + (e.clientY - lastY) * 0.006));
      lastX  = e.clientX;
      lastY  = e.clientY;
      applyCamera();
    });
    renderer.domElement.addEventListener('wheel', e => {
      dist = Math.max(W * 0.5, Math.min(W * 5, dist + e.deltaY * 0.6));
      applyCamera();
      e.preventDefault();
    }, { passive: false });

    // Animate
    function animate() {
      if (!rootEl) return;
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    scene3d = {
      dispose() {
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

/**
 * IES Hub v3 — Warehouse Sizing Calculator UI
 * Builder-pattern layout: config panel on left, capacity dashboard + visualizations on right.
 * 3-way view toggle: Dashboard / Elevation / 3D.
 *
 * @module tools/warehouse-sizing/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import { renderScenarioLanding } from '../../shared/scenario-landing.js?v=20260418-sM';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { renderToolChrome, refreshToolChrome, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260430-na-dot';
import * as calc from './calc.js?v=20260512-slideover3';
import * as api from './api.js?v=20260418-sL';
import * as cmApi from '../cost-model/api.js?v=20260512-cm-wsc-dimfix';
import { renderCmDrillbackChip, bindCmDrillback } from '../../shared/cm-drillback.js?v=20260430-am-p5fix12';
import { showConfirm } from '../../shared/confirm-modal.js';
import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260511-port12';
import { render3DView, disposeScene3d } from './ui-3d.js?v=20260513-3dextract2';
import { renderConfigHtml, bindConfigEvents } from './ui-config.js?v=20260513-cfgextract4';
import { renderPlan, drawPlan, hitCorner } from './ui-plan.js?v=20260513-planextract';

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
          handleCmPush(payload);
        } else {
          _seededFromCm = true;
          openEditor(null);
          handleCmPush(payload);
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
    sidebarBody: '<div id="wsc-config">' + renderConfigHtml(_makeConfigCtx()) + '</div>',
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
      // 2026-05-12 — When WSC was launched from a Cost Model, the back button
      // returns to that CM rather than the WSC scenarios list. Without this
      // the user gets dumped on a list of all their facilities, losing context.
      const goingToCm = !!_originCm;
      // 2026-05-12 (slide-over polish) — if WSC is mounted inside a CM
      // slide-over panel, "back to CM" just means "close the panel" — the
      // CM is already rendered behind it and a route change would yank the
      // user out of it. Use the close callback the slide-over provided.
      const inSlideover = _embedOpts?.embed === 'slideover' && typeof _embedOpts.onCloseRequest === 'function';
      const dirtyPrompt = (goingToCm || inSlideover)
        ? 'Unsaved changes. Leave and return to the Cost Model?'
        : 'Unsaved changes. Leave for the scenarios list?';
      if (isDirty && !(await showConfirm(dirtyPrompt))) return;
      isDirty = false;
      if (inSlideover) {
        try { sessionStorage.removeItem('wsc_origin_cm'); } catch {}
        _originCm = null;
        _seededFromCm = false;
        _embedOpts.onCloseRequest();
        return;
      }
      if (goingToCm) {
        try { sessionStorage.removeItem('wsc_origin_cm'); } catch {}
        _originCm = null;
        _seededFromCm = false;
        window.location.hash = '#designtools/cost-model';
        return;
      }
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

  // 2026-05-12 — CM-seeded banner dismiss handler. Single delegate at rootEl,
  // refreshes the chrome (which drops the banner element) without re-rendering
  // the content view (preserves any in-progress text input).
  rootEl?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-wsc-cm-banner-dismiss]');
    if (!btn) return;
    _seededFromCm = false;
    refreshToolChrome(rootEl, _buildWscChromeOpts());
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
      const c = hitCorner(r, offsetX, offsetY);
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
    drawPlan(_makePlanCtx());
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
  // collapsible left drawer. renderConfigHtml() (from ui-config.js) returns
  // the HTML; this function targets whichever element holds it (id=wsc-config
  // wrapper inside the chrome's .tc-sidebar__body) and binds the events.
  const panel = rootEl?.querySelector('#wsc-config');
  if (!panel) return;
  const ctx = _makeConfigCtx();
  panel.innerHTML = renderConfigHtml(ctx);
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
    setDirty(v) { isDirty = v; },
    resetState() {
      facility = createDefaultFacility();
      zones = createDefaultZones();
      volumes = createDefaultVolumes();
      isDirty = false;
    },
    refreshKpis: _refreshWscKpis,
    refreshContent: renderContentView,
    refreshConfig: renderConfigPanel,
    refreshLanding: renderLanding,
    copySummary: copySummaryToClipboard,
    toSizingInputs,
    debounceRender,
    handleCmPush,
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
    renderFacility: _renderFacility,
    toSizingInputs,
    canvasMouseCoords,
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
    case 'dashboard': container.innerHTML = renderDashboard(); break;
    case 'plan':
      container.innerHTML = renderPlan(_makePlanCtx());
      requestAnimationFrame(() => drawPlan(_makePlanCtx()));
      break;
    case 'elevation':
      container.innerHTML = renderElevation();
      requestAnimationFrame(() => drawElevation());
      break;
    case '3d': render3DView(container, {
      get facility() { return facility; },
      get zones() { return zones; },
      get volumes() { return volumes; },
      rootEl,
      toSizingInputs,
      renderFacility: _renderFacility,
      shuffledBayLevelOrder: _shuffledBayLevelOrder,
    }); break;
  }
}

/** Canvas geometry stash used by drag handlers to convert mouse → feet. */
let _planMeta = null;

// ============================================================
// DASHBOARD VIEW
// ============================================================

/**
 * Convert the UI's (facility, zones, volumes) state into SizingInputs
 * for the v2-equivalent calc.sizeFacility engine.
 * @returns {import('./calc.js?v=20260512-slideover3').SizingInputs}
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
  // Brock 2026-05-08: was `(zones.peakUnitsPerDay || 500000)` — 500K phantom
  // peak units leaked in whenever the field was 0, producing 118K SF residual
  // even when the user had cleared every input. `??` honors user-typed 0;
  // saved scenarios that predate this field default to 0 (engine sizes 0 SF).
  const effectivePeakUnits = useThroughputDerivation
    ? peakUnitsFromThroughput
    : (zones.peakUnitsPerDay ?? 0);
  // Avg follows the same source. When throughput-driven and avg-day demand
  // can be inferred (annual / 365), use that × DOH for avg on-hand. Else
  // fall back to direct zones.avgUnitsPerDay.
  const avgUnitsFromThroughput = (annualOut > 0 && doh > 0)
    ? Math.round((annualOut / 365) * doh)
    : 0;
  const effectiveAvgUnits = useThroughputDerivation
    ? avgUnitsFromThroughput
    : (zones.avgUnitsPerDay ?? 0);

  return {
    peakUnits: effectivePeakUnits,
    avgUnits: effectiveAvgUnits,
    // WSC-B6 (2026-04-25): prefer the explicit dailyOutbound field; only
    // fall back to (avgUnitsPerDay × operatingDays) when blank. The legacy
    // path stuffed avgUnits *as on-hand* into outboundUnitsYr which was
    // dimensionally wrong; sizingEngine doesn't use outboundUnitsYr for
    // sizing anyway, but keep it for downstream callers.
    // Brock 2026-05-08: operatingDays falls back to 0 (was 250). Engine
    // doesn't size off outboundUnitsYr; downstream callers should handle 0
    // explicitly. Honor user-typed 0.
    outboundUnitsYr: zones.outboundUnitsPerDay && zones.outboundUnitsPerDay > 0
      ? zones.outboundUnitsPerDay * (zones.operatingDaysPerYear ?? 0)
      : (zones.avgUnitsPerDay ?? 0) * (zones.operatingDaysPerYear ?? 0),
    operatingDaysYr: zones.operatingDaysPerYear ?? 0,
    fullPalletPct: (alloc.fullPallet || 0) / 100,
    cartonOnPalletPct: (alloc.cartonOnPallet || 0) / 100,
    cartonOnShelvingPct: (alloc.cartonOnShelving || 0) / 100,
    // Brock 2026-05-08: was `|| 48 / 6 / 12 / 6 / 4` — substituted demo
    // conversions whenever the user had a 0/blank product profile, producing
    // pallet-position counts on a phantom inventory. `??` honors typed 0;
    // engine math guards against divide-by-zero and produces 0 positions.
    unitsPerPallet: prod.unitsPerPallet ?? 0,
    unitsPerCartonPal: prod.unitsPerCartonPallet ?? 0,
    cartonsPerPallet: prod.cartonsPerPallet ?? 0,
    unitsPerCartonShelv: prod.unitsPerCartonShelving ?? 0,
    cartonsPerLocation: prod.cartonsPerLocation ?? 0,
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
    // Brock 2026-05-08: was `|| 200 / 200 / 20 / 8` — phantom dock throughput
    // forced 4 minimum doors × 1500 SF = 6,000+ SF dock + 540 SF staging
    // even on a blank scenario. `??` honors typed 0.
    inPalletsDay: volumes.avgDailyInbound ?? 0,
    outPalletsDay: volumes.avgDailyOutbound ?? 0,
    palletsPerDoorHour: dock.palletsPerDockHour ?? 0,
    dockHours: dock.dockOperatingHours ?? 0,
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
    // Brock 2026-05-08 (consolidation): symmetric shelving-locations override.
    // When user enters a shelving count from a slotting study, engine bypasses
    // the peakUnits × shelvingMix derivation and uses this directly. Closes the
    // wart where pre-consolidation 'pallets mode' silently produced 0 shelving
    // when throughput was blank.
    totalShelvingLocationsOverride: Number(volumes.totalShelvingLocations) || 0,
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
      const statusColor = status === 'on-target' ? 'var(--ies-green,#10b981)' : status === 'slack' ? 'var(--ies-blue,#0047AB)' : status === 'short' ? 'var(--ies-orange, #ff3a00)' : 'var(--ies-gray-500)';
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
 * Phase F.3.3 (2026-05-05) — Stable pseudorandom shuffle of (bay, level)
 * coordinate pairs so empty rack positions distribute throughout the
 * zone instead of clustering at the back of every column.
 *
 * Brock callout: "would it be possible to randomly mix in the open
 * positions within the racking - it looks more realistic". Pre-fix the
 * placement loop placed pallets in bays 0..fillBays-1 at every level —
 * the last bays of each face were always empty (deterministic block
 * pattern). Now we shuffle all (bay, level) pairs and take the first
 * `fillCount` for placement. The shuffle is seeded by face coordinates,
 * so the pattern is stable across re-renders (no flickering when the
 * scene rebuilds on input change).
 *
 * Mulberry32 PRNG — fast, decent distribution, deterministic from seed.
 *
 * @param {number} baysPerFace
 * @param {number} levels
 * @param {number} seed
 * @returns {Array<[number, number]>} array of [bayIdx, levelIdx] tuples
 */
function _shuffledBayLevelOrder(baysPerFace, levels, seed) {
  const arr = [];
  for (let lv = 0; lv < levels; lv++) {
    for (let b = 0; b < baysPerFace; b++) {
      arr.push([b, lv]);
    }
  }
  let s = (seed | 0) >>> 0;
  function rand() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Fisher-Yates with seeded PRNG.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
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

  // Bay geometry. Phase F.4 follow-up (2026-05-05) — Brock callout:
  // "elevation for shelving bay... why wouldn't the tool put more cartons
  // per level given the diagram? lots of unutilized space." Pre-fix the
  // diagram pulled bayWidthFt from unitLoad (= 9 ft pallet bay), but
  // shelving uses a much smaller bay (3 ft typical). With a 9 ft canvas
  // showing 3 cartons of 12" each, the cartons only filled 3 ft of the
  // 9 ft bay — looked like wasted space. Now reads from cartonProfile's
  // shelfBayWidthFt (default 3 ft) so the diagram matches the engine math.
  const u = sized?.unitLoad;
  const bayWidthFt = (+c.shelfBayWidthFt > 0 ? +c.shelfBayWidthFt : 3.0);
  const rackDepthFt = (u?.rackDepthSingleFt) || 4.0;
  const levels = c.shelfLevelsAt84In || 7;
  const levelHeightFt = c.shelfLevelHeightFt || 1.0;
  const totalHeightFt = levels * levelHeightFt;

  // Cartons-per-shelf grid. Phase F.7 (2026-05-05) — Brock callout: "the
  // carton orientation drop-down doesn't actually change anything. it
  // re-renders, but the layout is the same." Pre-fix `cartonLin` was always
  // cartonLengthIn / 12 regardless of orientation — so when user flipped
  // L-along-rack → W-along-rack, cAcross changed (3 → 4) but each carton
  // box was still drawn 12" wide along the rack, overflowing the bay.
  // Now: along-rack dim is orientation-aware (cartonLength when L, cartonWidth
  // when W), so the boxes shrink/grow to match the orientation actually
  // selected, and the count × box-width fills the bay cleanly.
  const cAcross = c.cartonsPerShelfAcross || 3;
  const cDeep = c.cartonsPerShelfDeep || 2;
  const orientation = c.orientation || 'L-along-rack';
  const cartonLengthFt = (+facility.cartonLengthIn || 12) / 12;
  const cartonWidthFt  = (+facility.cartonWidthIn  || 9) / 12;
  const cartonHin      = (+facility.cartonHeightIn || 12) / 12;
  // Orientation-aware along-rack width per carton (drawn horizontally in this view).
  const cartonAlongRackFt = (orientation === 'L-along-rack') ? cartonLengthFt : cartonWidthFt;

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
  const cartonW = cartonAlongRackFt * scale;  // along the bay run (orientation-aware)
  const cartonH = cartonHin * scale;  // vertical
  const deckThickFt = 0.04;
  ctx.font = '9px Montserrat, sans-serif';
  for (let lvl = 0; lvl < levels; lvl++) {
    const yLevelFt = lvl * levelHeightFt;
    // Deck slab
    ctx.fillStyle = '#9ca3af';
    ctx.fillRect(toX(0), toY(yLevelFt + deckThickFt), bayPx, deckThickFt * scale);

    // Cartons across the bay run (cAcross slots, each cartonAlongRackFt wide).
    // Center them horizontally in the bay.
    const totalCartonRunFt = cAcross * cartonAlongRackFt;
    const startX = (bayWidthFt - totalCartonRunFt) / 2;
    for (let i = 0; i < cAcross; i++) {
      const cx = startX + i * cartonAlongRackFt;
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
  // 2026-05-12 — DOH is the missing third coordinate from the dimensional fix
  // in cost-model/api.js. payload.totalPallets is now on-hand positions
  // (annualPalletsInbound × DOH/365); WSC's throughput-driven derivation
  // also uses volumes.daysOnHand, so propagate it here so the field stays
  // consistent with the override path.
  if (Number(payload.daysOnHand)       > 0) volumes.daysOnHand        = Number(payload.daysOnHand);
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
  // Brock 2026-05-08: zones defaults zeroed to match the createDefaultFacility
  // cleanup from 2026-04-20. Pre-fix, opening "+ New Scenario" pre-filled the
  // form with seed data (5K office, 10K staging, 500K peak units/day, 10
  // inbound + 12 outbound dock doors, etc.) intended to make the demo render
  // a populated facility. Combined with || fallbacks in toSizingInputs, this
  // also produced a phantom 118,368 SF residual that couldn't be cleared by
  // zeroing inputs. Defaults that survive: dimensionless ratios on
  // storageAllocation (need to sum to 100), dockConfig.sided structural
  // toggle, forwardPick disabled flag + structural type, optionalZones
  // disabled flags. Everything numeric is 0/blank.
  return {
    officeSqft: 0,
    receiveStagingSqft: 0,
    shipStagingSqft: 0,
    chargingSqft: 0,
    repackSqft: 0,
    otherSqft: 0,
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
    dockConfig: { sided: 'single', inboundDoors: 0, outboundDoors: 0, palletsPerDockHour: 0, dockOperatingHours: 0 },
    productDimensions: { unitsPerPallet: 0, unitsPerCartonPallet: 0, cartonsPerPallet: 0, unitsPerCartonShelving: 0, cartonsPerLocation: 0 },
    forwardPick: { enabled: false, type: 'carton_flow', skuCount: 0, daysInventory: 0, outboundUnitsPerDay: 0 },
    optionalZones: { vas: { enabled: false, sqft: 0 }, returns: { enabled: false, sqft: 0 }, chargeback: { enabled: false, sqft: 0 } },
    customZones: [],
    peakUnitsPerDay: 0,
    avgUnitsPerDay: 0,
    operatingDaysPerYear: 0,
  };
}

function createDefaultVolumes() {
  // Brock 2026-05-08: volumes defaults zeroed (was: 60K pallets / 3K SKUs /
  // 250 inbound / 290 outbound / 12 turns / 1.3 peak — sized to match the
  // legacy 150K sqft demo facility). Real project numbers should replace
  // these fields explicitly. Structural defaults preserved: peakMultiplier
  // and daysOnHand have engineering-meaningful baseline values (1.3 peak
  // factor + 30-day on-hand) that survive blank-form sizing because they
  // are dimensionless ratios applied only when other inputs are non-zero.
  return {
    totalPallets: 0,
    // Brock 2026-05-08 (consolidation): shelving-locations override.
    // Mirrors totalPallets — when set, engine bypasses peakUnits × shelvingMix
    // derivation and uses this directly.
    totalShelvingLocations: 0,
    totalSKUs: 0,
    inventoryTurns: 0,
    avgDailyInbound: 0,
    avgDailyOutbound: 0,
    peakMultiplier: 1.3,
    annualOutboundUnits: 0,
    daysOnHand: 30,
  };
}



/**
 * Escape for HTML attribute values (covers double-quote contexts).
 * Phase 4 Layer B (volumes-as-nucleus, 2026-04-29) — added because the new
 * per-channel allocation editor and dashboard byChannel rows write
 * channelKey into data-* attribute values.
 */


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
import { renderToolChrome, refreshToolChrome, refreshToolChromeActions, refreshKpiStrip, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260430-na-dot';
import * as calc from './calc.js?v=20260514-fsi1';
import * as api from './api.js?v=20260418-sL';
import * as cmApi from '../cost-model/api.js?v=20260512-cm-wsc-dimfix';
import { renderCmDrillbackChip, bindCmDrillback } from '../../shared/cm-drillback.js?v=20260430-am-p5fix12';
import { showConfirm } from '../../shared/confirm-modal.js';
import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260511-port12';
import { render3DView, disposeScene3d } from './ui-3d.js?v=20260513-3dextract2';
import { renderConfigHtml, bindConfigEvents } from './ui-config.js?v=20260513-cfgextract4';
import { renderPlan, drawPlan, hitCorner } from './ui-plan.js?v=20260513-planextract';
import { renderDashboard } from './ui-dashboard.js?v=20260513-dashextract';
import { renderElevation, drawElevation, shuffledBayLevelOrder } from './ui-elevation.js?v=20260513-elevextract';
import { pushToCm, handleCmPush, createDefaultFacility, createDefaultZones, createDefaultVolumes } from './ui-cm-bridge.js?v=20260513-cmextract';
import { wscExtraStyles } from './ui-styles.js?v=20260513-stylesextract';

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
  return renderToolChrome(_buildWscChromeOpts()) + wscExtraStyles();
}

/** Build chrome opts from current WSC state. */
/** Mark the doc dirty and refresh chrome on the clean→dirty transition so the
 *  save chip flips "Saved" → "Modified" in real time. Pre-fix: every isDirty=true
 *  site only re-rendered KPIs / content / config — the chrome (where the chip
 *  lives) stayed stale until a section change or save. */
function _markDirty() {
  const wasClean = !isDirty;
  isDirty = true;
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
        pushToCm(_makeCmCtx());
        flashPrimaryAction(rootEl);
        return;
      }
      if (id === 'wsc-save') return handleSaveWsc();
    },
    onPrimaryShortcut: () => {
      pushToCm(_makeCmCtx());
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
      _markDirty();
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
      _markDirty();
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
      _markDirty();
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
    _markDirty();
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
    setDirty(v) { if (v) _markDirty(); else { isDirty = false; } },
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
 * @returns {import('./calc.js?v=20260514-fsi1').SizingInputs}
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



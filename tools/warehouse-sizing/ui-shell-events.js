/**
 * IES Hub v3 — Warehouse Sizing — Shell event bindings (extracted from ui.js 2026-05-14)
 *
 * Slice 8 of WSC ui.js extraction: lifts the 263-LOC `bindShellEvents`
 * routine out of ui.js. Wires up:
 *   - Tool-chrome events (section nav, sidebar toggle, back, primary action)
 *   - Cross-tool CM drillback chip delegation
 *   - Elevation view-switcher delegation
 *   - CM-seeded banner dismiss delegation
 *   - data-wsc-action delegation (toggle-edit-layout / reset-layout /
 *     apply-shrink-suggestion / apply-required-dims)
 *   - Canvas pointer events for plan edit-mode drag/resize
 *
 * Idempotency contract preserved: `rootEl.__wscShellBound` flag prevents
 * re-binding on every section navigation. Caller resets the flag on remount.
 *
 * Exports:
 *   bindShellEvents(sctx)  — wires every shell listener once per mount.
 *
 * sctx shape:
 *   rootEl, WSC_SECTIONS,                                // direct refs
 *   facility, zones,                                     // live objects (mutated in place)
 *   get/set activeView, _wscDrawerOpen, isDirty,         // primitive state with setters
 *           _originCm, _seededFromCm, viewMode,
 *           _wscElevView, _planEditMode, _planDrag,
 *   get _embedOpts, _planMeta, _planZoneRects,           // read-only refs
 *   renderShell, renderConfigPanel, renderContentView,   // local renderers
 *   refreshWscKpis, buildWscChromeOpts,
 *   makeCmCtx, makePlanCtx,
 *   handleSaveWsc, renderLanding,
 *   markDirty, canvasMouseCoords
 *
 * @module tools/warehouse-sizing/ui-shell-events
 */

import { refreshToolChrome, bindToolChromeEvents, flashPrimaryAction } from '../../shared/tool-chrome.js?v=20260705-u1a';
import { bindCmDrillback } from '../../shared/cm-drillback.js?v=20260430-am-p5fix12';
import { showConfirm } from '../../shared/confirm-modal.js?v=20260705-u1a';
import { drawPlan, hitCorner, planHoverUpdate, cycleGridMode, toggleLayer, getMeasureMode, toggleMeasureMode, exitMeasureMode, addMeasurePoint, clearMeasurements, setMeasureCursor } from './ui-plan.js?v=20260703-ux0';
import { pushToCm } from './ui-cm-bridge.js?v=20260702-p1b';

/**
 * Bind all shell-level event listeners for the Warehouse Sizing tool. Safe
 * to call multiple times — the `rootEl.__wscShellBound` guard ensures only
 * the first call wires anything. The caller (mount) is responsible for
 * resetting the flag when re-entering the editor.
 *
 * @param {Object} sctx — see module-level docstring for shape.
 */
export async function bindShellEvents(sctx) {
  const { rootEl, WSC_SECTIONS } = sctx;
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
      sctx.activeView = /** @type {any} */ (key);
      // Re-render the shell to refresh chrome + content for the new view.
      // (renderShell + renderConfigPanel + renderContentView is the legacy
      // pattern; preserve it here.)
      rootEl.innerHTML = sctx.renderShell();
      bindShellEvents(sctx);
      sctx.renderConfigPanel();
      sctx.renderContentView();
      sctx.refreshWscKpis();
    },
    onSidebar: (kind) => {
      const newOpen = (kind === 'toggle') ? !sctx._wscDrawerOpen : false;
      sctx._wscDrawerOpen = newOpen;
      // Flip the data-sidebar-open attribute (CSS handles the width
      // transition) and refresh ONLY row2Prefix + the chrome's mode flag —
      // sidebarBody is intentionally OMITTED so in-progress text input
      // inside the panel is preserved.
      const body = rootEl?.querySelector('.tc-body');
      if (body) body.dataset.sidebarOpen = newOpen ? 'true' : 'false';
      // Re-render the Configure pill so its label/active class reflect
      // the new state. We pass an opts subset that includes row2Prefix
      // (refreshed) but omits sidebarBody.
      const opts = sctx.buildWscChromeOpts();
      delete opts.sidebarBody;
      refreshToolChrome(rootEl, opts);
    },
    onBack: async () => {
      // 2026-05-12 — When WSC was launched from a Cost Model, the back button
      // returns to that CM rather than the WSC scenarios list. Without this
      // the user gets dumped on a list of all their facilities, losing context.
      const goingToCm = !!sctx._originCm;
      // 2026-05-12 (slide-over polish) — if WSC is mounted inside a CM
      // slide-over panel, "back to CM" just means "close the panel" — the
      // CM is already rendered behind it and a route change would yank the
      // user out of it. Use the close callback the slide-over provided.
      const embedOpts = sctx._embedOpts;
      const inSlideover = embedOpts?.embed === 'slideover' && typeof embedOpts.onCloseRequest === 'function';
      const dirtyPrompt = (goingToCm || inSlideover)
        ? 'Unsaved changes. Leave and return to the Cost Model?'
        : 'Unsaved changes. Leave for the scenarios list?';
      if (sctx.isDirty && !(await showConfirm(dirtyPrompt))) return;
      sctx.isDirty = false;
      if (inSlideover) {
        try { sessionStorage.removeItem('wsc_origin_cm'); } catch {}
        sctx._originCm = null;
        sctx._seededFromCm = false;
        embedOpts.onCloseRequest();
        return;
      }
      if (goingToCm) {
        try { sessionStorage.removeItem('wsc_origin_cm'); } catch {}
        sctx._originCm = null;
        sctx._seededFromCm = false;
        window.location.hash = '#designtools/cost-model';
        return;
      }
      sctx.viewMode = 'landing';
      await sctx.renderLanding();
    },
    onAction: (id) => {
      if (id === 'push-to-cm') {
        pushToCm(sctx.makeCmCtx());
        flashPrimaryAction(rootEl);
        return;
      }
      if (id === 'wsc-save') return sctx.handleSaveWsc();
      if (id === 'wsc-tier') return sctx.handleWscTierToggle();
    },
    onPrimaryShortcut: () => {
      pushToCm(sctx.makeCmCtx());
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
    if (sctx._wscElevView === view) return;
    sctx._wscElevView = view;
    sctx.renderContentView();
  });

  // 2026-05-12 — CM-seeded banner dismiss handler. Single delegate at rootEl,
  // refreshes the chrome (which drops the banner element) without re-rendering
  // the content view (preserves any in-progress text input).
  rootEl?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-wsc-cm-banner-dismiss]');
    if (!btn) return;
    sctx._seededFromCm = false;
    refreshToolChrome(rootEl, sctx.buildWscChromeOpts());
  });

  // Root-level delegation for data-wsc-action (toggle-edit-layout, reset-layout).
  // Using delegation per the event-delegation-pattern memory — renderPlan's
  // innerHTML rewrite would otherwise drop any per-element listener.
  rootEl?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-wsc-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-wsc-action');
    if (action === 'toggle-edit-layout') {
      sctx._planEditMode = !sctx._planEditMode;
      // Phase B.B17 — turning on edit mode exits measure mode so the
      // canvas isn't owned by two modes at once.
      if (sctx._planEditMode) exitMeasureMode();
      sctx.renderContentView();
    } else if (action === 'toggle-measure') {
      // Phase B.B17 (2026-05-26) — measure-tool toggle. Mutually
      // exclusive with edit-layout mode.
      toggleMeasureMode();
      if (getMeasureMode()) sctx._planEditMode = false;
      sctx.renderContentView();
    } else if (action === 'clear-measurements') {
      // Phase B.B17 — drop all committed measurements + any pending
      // anchor. Re-render the canvas so they disappear and refresh
      // the chrome so the Clear button label updates.
      clearMeasurements();
      sctx.renderContentView();
    } else if (action === 'cycle-grid') {
      // Phase A.A6 (2026-05-26) — grid modulus cycle. State lives in
      // ui-plan.js (UI-only, not persisted). Re-render content so the
      // button label updates AND drawPlan picks up the new mode.
      cycleGridMode();
      sctx.renderContentView();
    } else if (action === 'reset-layout') {
      sctx.zones.layoutOverrides = {};
      sctx.markDirty();
      sctx.renderContentView();
    } else if (action === 'apply-shrink-suggestion') {
      // Resize the building to the suggested dims surfaced in the over-built
      // banner. Width comes from the col-allocation math; depth is preserved
      // (master segment plan unchanged). Refresh the Configure side panel
      // too so its Width/Depth inputs reflect the applied dims (without it
      // the inputs cache the original facility values).
      const w = +btn.getAttribute('data-suggested-width') || 0;
      const d = +btn.getAttribute('data-suggested-depth') || 0;
      if (w > 0) sctx.facility.buildingWidth = w;
      if (d > 0) sctx.facility.buildingDepth = d;
      sctx.markDirty();
      sctx.renderConfigPanel();
      sctx.renderContentView();
    } else if (action === 'apply-required-dims') {
      // Phase 2 redesign: Required-vs-Built panel "Apply suggested dims" button.
      // Maps long → buildingWidth (canonical dock-on-long-edge convention) and
      // short → buildingDepth. Engages buildingDimsOverride so the user's
      // applied dims are visibly the locked override (otherwise the next
      // re-render would show the dims as derived again).
      const longFt  = +btn.getAttribute('data-long')  || 0;
      const shortFt = +btn.getAttribute('data-short') || 0;
      if (longFt > 0)  sctx.facility.buildingWidth  = longFt;
      if (shortFt > 0) sctx.facility.buildingDepth  = shortFt;
      sctx.facility.buildingDimsOverride = true;
      sctx.markDirty();
      sctx.renderConfigPanel();
      sctx.renderContentView();
    }
  });

  // Phase B.B14 (2026-05-26) — Layer visibility toggles delegate on a
  // separate attribute so they live in their own pill group cleanly
  // (the data-wsc-action listener above early-returns when the click
  // doesn't have that attribute).
  rootEl?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-wsc-layer-toggle]');
    if (!btn) return;
    const name = btn.getAttribute('data-wsc-layer-toggle');
    if (!name) return;
    toggleLayer(name);
    sctx.renderContentView();
  });

  // Phase B.B17 (2026-05-26) — Measure-mode pointerdown. Click 1 sets
  // anchor; click 2 commits the dimension line. Runs only when measure
  // mode is active; otherwise the existing edit-mode handler below has
  // a clean shot at the event.
  rootEl?.addEventListener('pointerdown', (e) => {
    if (!getMeasureMode()) return;
    const canvas = /** @type {HTMLCanvasElement} */ (e.target);
    if (!canvas || canvas.id !== 'wsc-plan-canvas' || !sctx._planMeta) return;
    e.preventDefault();
    const { X0, Y0, pxPerFt } = sctx._planMeta;
    const { offsetX, offsetY } = sctx.canvasMouseCoords(canvas, e);
    const xFt = (offsetX - X0) / pxPerFt;
    const yFt = (offsetY - Y0) / pxPerFt;
    const result = addMeasurePoint({ xFt, yFt });
    if (result === 'commit') {
      // Newly committed line — re-render so the Clear button count
      // updates in the chrome AND drawPlan repaints with the new line.
      sctx.renderContentView();
    } else {
      // Anchor set — repaint canvas so the start tick appears immediately
      // even before the next mousemove.
      try { drawPlan(sctx.makePlanCtx()); } catch {}
    }
  });

  // Canvas pointer events for edit-mode dragging. Delegated on rootEl for the
  // same reason — the canvas is recreated on every plan re-render.
  rootEl?.addEventListener('pointerdown', (e) => {
    if (!sctx._planEditMode) return;
    const canvas = /** @type {HTMLCanvasElement} */ (e.target);
    if (!canvas || canvas.id !== 'wsc-plan-canvas' || !sctx._planMeta) return;
    const { X0, Y0, pxPerFt } = sctx._planMeta;
    const { offsetX, offsetY } = sctx.canvasMouseCoords(canvas, e);
    const order = ['office', 'forwardPick', 'shipStaging'];
    // Resize-corner hit-test wins over body-move (handles take priority)
    let hit = null;
    let mode = 'move';
    let corner = null;
    for (const id of order) {
      const r = sctx._planZoneRects[id];
      if (!r) continue;
      const c = hitCorner(r, offsetX, offsetY);
      if (c) { hit = id; mode = 'resize'; corner = c; break; }
    }
    if (!hit) {
      for (const id of order) {
        const r = sctx._planZoneRects[id];
        if (!r) continue;
        if (offsetX >= r.x && offsetX <= r.x + r.w && offsetY >= r.y && offsetY <= r.y + r.h) {
          hit = id;
          break;
        }
      }
    }
    if (!hit) return;
    e.preventDefault();
    const r = sctx._planZoneRects[hit];
    const curOverride = sctx.zones.layoutOverrides?.[hit] || {};
    const curXFt = (curOverride.x !== undefined) ? curOverride.x : (r.x - X0) / pxPerFt;
    const curYFt = (curOverride.y !== undefined) ? curOverride.y : (r.y - Y0) / pxPerFt;
    const curWFt = (curOverride.w !== undefined) ? curOverride.w : r.w / pxPerFt;
    const curHFt = (curOverride.h !== undefined) ? curOverride.h : r.h / pxPerFt;
    sctx._planDrag = {
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

  // Phase A.A10/A11/A13 (2026-05-26) — always-on hover handler. Updates
  // the status bar coords, the canvas cursor, and the hovered-zone highlight
  // outline. Skips when a drag is in progress (the drag handler below
  // already owns the canvas in that case).
  rootEl?.addEventListener('pointermove', (e) => {
    if (sctx._planDrag) return;
    const canvas = /** @type {HTMLCanvasElement} */ (e.target);
    if (!canvas || canvas.id !== 'wsc-plan-canvas' || !sctx._planMeta) return;
    const { offsetX, offsetY } = sctx.canvasMouseCoords(canvas, e);
    // Phase B.B17 (2026-05-26) — measure-tool preview cursor update.
    // When measure mode + anchor is set, repaint on every move so the
    // preview line tracks the cursor. Cheap because drawPlan caches
    // sizing output and the canvas is 900×520.
    if (getMeasureMode()) {
      setMeasureCursor({ xPx: offsetX, yPx: offsetY });
      // Always repaint when measure mode is on — even without an
      // anchor, the cursor coords matter for the status bar (the
      // existing planHoverUpdate handles that below).
      drawPlan(sctx.makePlanCtx());
    }
    const changed = planHoverUpdate(sctx.makePlanCtx(), { offsetX, offsetY });
    if (changed) drawPlan(sctx.makePlanCtx());
  });

  // Drag pointermove (existing) — applies layoutOverrides on active drag.
  rootEl?.addEventListener('pointermove', (e) => {
    if (!sctx._planDrag || !sctx._planEditMode) return;
    const canvas = /** @type {HTMLCanvasElement} */ (e.target);
    if (!canvas || canvas.id !== 'wsc-plan-canvas') return;
    const { offsetX, offsetY } = sctx.canvasMouseCoords(canvas, e);
    const drag = sctx._planDrag;
    const dxFt = (offsetX - drag.startMouseXPx) / drag.pxPerFt;
    const dyFt = (offsetY - drag.startMouseYPx) / drag.pxPerFt;
    const snap = 5;
    if (!sctx.zones.layoutOverrides) sctx.zones.layoutOverrides = {};
    const cur = sctx.zones.layoutOverrides[drag.zoneId] || {};
    if (drag.mode === 'resize') {
      // Translate corner-drag into x/y/w/h deltas
      let newX = drag.origXFt;
      let newY = drag.origYFt;
      let newW = drag.origWFt;
      let newH = drag.origHFt;
      const c = drag.corner;
      if (c === 'br') { newW = drag.origWFt + dxFt; newH = drag.origHFt + dyFt; }
      else if (c === 'tr') { newW = drag.origWFt + dxFt; newY = drag.origYFt + dyFt; newH = drag.origHFt - dyFt; }
      else if (c === 'bl') { newX = drag.origXFt + dxFt; newW = drag.origWFt - dxFt; newH = drag.origHFt + dyFt; }
      else if (c === 'tl') { newX = drag.origXFt + dxFt; newW = drag.origWFt - dxFt; newY = drag.origYFt + dyFt; newH = drag.origHFt - dyFt; }
      // Snap and clamp to a reasonable minimum (10 ft per side)
      newX = Math.round(newX / snap) * snap;
      newY = Math.round(newY / snap) * snap;
      newW = Math.max(10, Math.round(newW / snap) * snap);
      newH = Math.max(10, Math.round(newH / snap) * snap);
      sctx.zones.layoutOverrides[drag.zoneId] = { ...cur, x: newX, y: newY, w: newW, h: newH };
    } else {
      // Move mode — only update x/y, preserve any existing w/h override
      const newXFt = Math.round((drag.origXFt + dxFt) / snap) * snap;
      const newYFt = Math.round((drag.origYFt + dyFt) / snap) * snap;
      sctx.zones.layoutOverrides[drag.zoneId] = { ...cur, x: newXFt, y: newYFt };
    }
    // Phase A.A9 (2026-05-26) — stash cursor position so drawPlan can
    // render the live W × H callout next to the pointer.
    sctx._planDragCursorPx = { x: offsetX, y: offsetY };
    drawPlan(sctx.makePlanCtx());
  });

  const finishDrag = () => {
    if (!sctx._planDrag) return;
    const canvas = rootEl?.querySelector('#wsc-plan-canvas');
    if (canvas) canvas.style.cursor = 'grab';
    sctx._planDrag = null;
    // Phase A.A9 — clear the cursor-position stash + repaint so the
    // floating W × H callout disappears now that the drag is done.
    sctx._planDragCursorPx = null;
    try { drawPlan(sctx.makePlanCtx()); } catch {}
    sctx.markDirty();
    // 2026-05-14 — when the drag was a resize, the layoutOverride feeds back
    // into the engine via formStateToInputs. Repaint the KPI chrome strip so
    // the Sized SF / Dock / Util values reflect the new engine output. Cheap
    // (computeWscKpis is pure and fast).
    try { sctx.refreshWscKpis?.(); } catch {}
  };
  rootEl?.addEventListener('pointerup', finishDrag);
  rootEl?.addEventListener('pointercancel', finishDrag);
  rootEl?.addEventListener('pointerleave', finishDrag);

  // Phase B.B17 (2026-05-26) — Document-level keyboard shortcuts for
  // the Measure tool. 'M' toggles the mode, 'Esc' exits it. Bound on
  // document so it works whether or not the canvas has focus. Guarded
  // with a flag so we don't re-bind on every renderContentView (this
  // bindShellEvents call is idempotent — see Phase 1 note above —
  // but document-level listeners would still stack).
  if (!document.__wscMeasureKeysBound) {
    document.__wscMeasureKeysBound = true;
    document.addEventListener('keydown', (e) => {
      // Skip when the user is typing in a form field — we don't want
      // 'M' inside a text input to flip the measure tool.
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.target && e.target.isContentEditable) return;
      // Also bail if any modifier is held — leave system shortcuts alone.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Only act when the WSC plan canvas is in the DOM — keeps the
      // shortcut from firing on other tools' pages.
      if (!document.querySelector('#wsc-plan-canvas')) return;
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleMeasureMode();
        if (getMeasureMode()) sctx._planEditMode = false;
        sctx.renderContentView();
      } else if (e.key === 'Escape' && getMeasureMode()) {
        e.preventDefault();
        exitMeasureMode();
        sctx.renderContentView();
      }
    });
  }
}

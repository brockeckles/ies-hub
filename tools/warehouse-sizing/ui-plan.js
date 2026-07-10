/**
 * IES Hub v3 — Warehouse Sizing — 2D Plan View (extracted from ui.js 2026-05-13)
 *
 * Slice 3 of 7: the top-down floorplan canvas. Owns:
 *   - renderPlan(ctx)   exported. Renders the canvas + writes pctx._planZoneRects.
 *   - drawPlan(pctx)         private. The big canvas paint pass (~680 LOC).
 *   - hitCorner()       private. Pointer-hit math for the drag-to-resize edit mode.
 *
 * Drag-handling event listeners (pointerdown/move/up) live in ui.js's
 * bindShellEvents — they need pctx.rootEl-level delegation and access to module
 * state. This module is render-only.
 *
 * ctx shape:
 *   { pctx.facility, pctx.zones, pctx.volumes, pctx.rootEl, pctx._planEditMode, pctx._planZoneRects,  // getters
 *     pctx.resetPlanZoneRects(),                                              // setter (clears the rect registry)
 *     pctx.renderFacility(pctx.facility, sized), pctx.toSizingInputs(),                 // helpers
 *     pctx.canvasMouseCoords(canvas, evt), pctx.drawDimH(...), pctx.drawDimV(...) }     // shared draw helpers
 *
 * @module tools/warehouse-sizing/ui-plan
 */

import * as calc from './calc.js?v=20260703-ux0';
import { icon } from '../../shared/icons.js?v=20260710-r2';

// Phase A.A6 (2026-05-26) — Foot-snap grid overlay state. Module-level
// because it's a UI preference (not part of the persisted facility model).
// Cycle order: off → 10' → 5' → 2' → off. 10' is the default since it reads
// cleanly at typical Wayfair-scale (~800 ft) building scales.
/** @type {'off'|'10ft'|'5ft'|'2ft'} */
let _gridMode = '10ft';
const _GRID_CYCLE = ['off', '10ft', '5ft', '2ft'];
const _GRID_LABEL = { off: 'Off', '10ft': "10'", '5ft': "5'", '2ft': "2'" };
export function getGridMode() { return _gridMode; }
export function cycleGridMode() {
  const i = _GRID_CYCLE.indexOf(_gridMode);
  _gridMode = _GRID_CYCLE[(i + 1) % _GRID_CYCLE.length];
  return _gridMode;
}

// Phase B.B14 (2026-05-26) — Layer visibility flags. Each toggle hides/shows
// one class of canvas chrome. State is module-local (UI preference, not
// persisted with the model). Default = everything on. Pairs nicely with the
// existing grid cycle (which has its own state above).
const _layers = {
  columns: true,     // structural column bubbles + lead-in ticks
  hatch:   true,     // ANSI31/dots hatch overlays on non-rack zones
  labels:  true,     // in-zone text labels ("Office", "Ship Staging", etc.)
  doors:   true,     // dock door rendering
};
export function getLayer(name) { return _layers[name] !== false; }
export function toggleLayer(name) {
  if (!(name in _layers)) return false;
  _layers[name] = !_layers[name];
  return _layers[name];
}

// Phase B.B17 (2026-05-26 evening) — Measure tool. CAD-style click-click
// dimensioning on the 2D plan canvas. Points stored in feet so they
// survive zoom/resize. Live preview rendered while an anchor is set.
//   _measureMode    — toggle: button or 'M' keyboard shortcut
//   _measureAnchor  — { xFt, yFt } first click of a pending measurement
//   _measureCursor  — { xPx, yPx } stored each pointermove for preview
//   _measureLines   — committed measurements, rendered persistently
let _measureMode = false;
/** @type {{xFt:number, yFt:number}|null} */
let _measureAnchor = null;
/** @type {{xPx:number, yPx:number}|null} */
let _measureCursor = null;
/** @type {Array<{aFt:{xFt:number,yFt:number}, bFt:{xFt:number,yFt:number}}>} */
const _measureLines = [];
export function getMeasureMode() { return _measureMode; }
export function isMeasureModeActive() { return _measureMode; }
export function toggleMeasureMode() {
  _measureMode = !_measureMode;
  // Leaving the mode also clears any pending anchor + preview
  if (!_measureMode) { _measureAnchor = null; _measureCursor = null; }
  return _measureMode;
}
export function exitMeasureMode() {
  _measureMode = false;
  _measureAnchor = null;
  _measureCursor = null;
}
export function setMeasureCursor(px) {
  // px = {xPx, yPx} or null
  _measureCursor = px || null;
}
/** Click-handler entry. First click sets anchor; second commits a line. */
export function addMeasurePoint(pt /* {xFt, yFt} */) {
  if (!_measureMode || !pt) return false;
  if (!_measureAnchor) {
    _measureAnchor = { xFt: pt.xFt, yFt: pt.yFt };
    return 'anchor';
  }
  // Reject degenerate (same point — likely an accidental double click)
  const dx = pt.xFt - _measureAnchor.xFt;
  const dy = pt.yFt - _measureAnchor.yFt;
  if (Math.hypot(dx, dy) < 0.5) {
    _measureAnchor = null;
    return false;
  }
  _measureLines.push({ aFt: _measureAnchor, bFt: { xFt: pt.xFt, yFt: pt.yFt } });
  _measureAnchor = null;
  return 'commit';
}
export function hasMeasurements() { return _measureLines.length > 0 || !!_measureAnchor; }
export function measurementCount() { return _measureLines.length; }
export function clearMeasurements() {
  _measureLines.length = 0;
  _measureAnchor = null;
  _measureCursor = null;
}

export function renderPlan(pctx) {
  const storage = calc.computeStorage(pctx.facility, pctx.zones);
  const overrideKeys = Object.keys(pctx.zones.layoutOverrides || {});
  const editing = !!pctx._planEditMode;

  // Shrink-suggestion CTA — when the building is over-built (current dims
  // hold significantly more rack capacity than the entered inventory needs),
  // surface a one-click "right-size" banner above the canvas. Mirrors the
  // canvas's widthFt/depthFt computation so banner/canvas always agree.
  // Phase A (2026-05-05): Constraint-mode only. In Design mode the rendering
  // already equals the sized footprint, so a "shrink" suggestion would loop.
  let shrinkSuggestion = { recommended: false };
  if ((pctx.facility.sizingMode || 'design') === 'constraint') try {
    const _sizedForCta = calc.sizeFacility(pctx.toSizingInputs());
    const _orientUser = calc.orientFacility(pctx.facility);
    const _userFits = (_orientUser.longFt * _orientUser.shortFt) >= _sizedForCta.totalSqft * 0.98 && !_orientUser.derived;
    // Only recommend a shrink when the user-entered dims actually fit the
    // inventory. If the building is too small, the engine falls back to
    // showing derived 1.5:1 dims on the canvas — recommending another
    // shrink against those derived dims would be a feedback cycle.
    const _wFt = _userFits ? _orientUser.longFt  : 0;
    const _dFt = _userFits ? _orientUser.shortFt : 0;
    if (_wFt > 0 && _dFt > 0) {
      const _aisleFt     = pctx.facility.aisleWidth || calc.AISLE_WIDTHS[pctx.facility.storageType] || 12;
      const _rackDepthFt = calc.rackDepthFt(pctx.facility.storageType, pctx.facility);
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
        // Honor total pctx.facility SF so suggested width holds dock + office +
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
  if ((pctx.facility.sizingMode || 'design') === 'constraint') {
    try {
      const _sizedCs = calc.sizeFacility(pctx.toSizingInputs());
      const _required = _sizedCs?.requirementsDriven?.totalSfRequired || _sizedCs?.totalSqft || 0;
      const _builtSf = (+pctx.facility.buildingWidth || 0) * (+pctx.facility.buildingDepth || 0);
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
        <div style="margin-bottom:var(--sp-2);padding:8px 14px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:12px;background:${capacityStatus.status === 'on-target' ? '#ecfdf5' : capacityStatus.status === 'slack' ? 'var(--c-info-soft)' : '#fff7ed'};border:1px solid ${capacityStatus.status === 'on-target' ? '#a7f3d0' : capacityStatus.status === 'slack' ? 'var(--c-info-border)' : '#fed7aa'};">
          <span style="font-size:14px;line-height:1;">${capacityStatus.status === 'on-target' ? '✓' : capacityStatus.status === 'slack' ? '◭' : '⚠'}</span>
          <span style="flex:1;line-height:1.5;color:${capacityStatus.status === 'on-target' ? '#065f46' : capacityStatus.status === 'slack' ? 'var(--c-info-deep)' : '#9a3412'};">
            <strong>${capacityStatus.status === 'on-target' ? 'On target' : capacityStatus.status === 'slack' ? `Capacity slack: +${capacityStatus.pct}%` : `Inventory short: ${capacityStatus.pct}%`}</strong>
            — Required <strong>${capacityStatus.required.toLocaleString()} sf</strong> · Existing <strong>${capacityStatus.built.toLocaleString()} sf</strong> · Gap <strong>${capacityStatus.delta >= 0 ? '+' : ''}${capacityStatus.delta.toLocaleString()} sf</strong>
          </span>
        </div>
      ` : ''}
      ${shrinkSuggestion.recommended ? `
        <div style="margin-bottom:var(--sp-2); padding:10px 14px; background:var(--c-info-soft); border:1px solid var(--c-info-border); border-radius:6px; font-size:12px; display:flex; align-items:center; gap:12px;">
          <span style="line-height:1;">${icon('ruler', { size: 16 })}</span>
          <span style="flex:1;line-height:1.5;">
            <strong style="color:var(--c-info-deep);">Building over-sized by ${shrinkSuggestion.oversizePct}%</strong>
            for the entered inventory. Right-size to
            <strong>${shrinkSuggestion.suggestedWidthFt.toLocaleString()} × ${shrinkSuggestion.suggestedDepthFt.toLocaleString()} ft</strong>
            <span class="u-muted">(currently ${shrinkSuggestion.currentWidthFt.toLocaleString()} × ${shrinkSuggestion.currentDepthFt.toLocaleString()} ft)</span>?
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
        <h3 class="text-subtitle u-m0">Floorplan (Top-Down)</h3>
        <div class="u-row">
          <span class="text-caption text-muted">Scale: 1 px ≈ ${Math.max(1, Math.round(Math.sqrt((pctx.facility.totalSqft || 0) * 1.5) / 800))} ft</span>
          ${overrideKeys.length > 0 ? `
            <button class="hub-btn-link" data-wsc-action="reset-layout" title="Discard manual repositions and revert to auto-layout">
              ↺ Reset Layout (${overrideKeys.length})
            </button>
          ` : ''}
          <button class="hub-btn-secondary" data-wsc-action="cycle-grid" style="font-size:12px;padding:4px 10px;" title="Toggle the foot-snap grid overlay (cycles Off → 10' → 5' → 2'). Phase A.A6.">
            Grid: ${_GRID_LABEL[_gridMode]}
          </button>
          <!-- Phase B.B14 (2026-05-26) — Layer visibility toggles. -->
          <span style="display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--ies-gray-100, #f3f4f6);border:1px solid var(--ies-gray-200);border-radius:4px;">
            <span class="text-caption text-muted" style="padding:0 6px;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;">Layers</span>
            <button data-wsc-layer-toggle="columns" title="Toggle structural column grid bubbles" style="font-size:11px;padding:2px 8px;border:0;background:${_layers.columns ? 'var(--ies-navy)' : 'transparent'};color:${_layers.columns ? '#fff' : 'var(--ies-gray-600)'};border-radius:3px;cursor:pointer;font-weight:600;">Cols</button>
            <button data-wsc-layer-toggle="hatch" title="Toggle ANSI hatch patterns on non-rack zones" style="font-size:11px;padding:2px 8px;border:0;background:${_layers.hatch ? 'var(--ies-navy)' : 'transparent'};color:${_layers.hatch ? '#fff' : 'var(--ies-gray-600)'};border-radius:3px;cursor:pointer;font-weight:600;">Hatch</button>
            <button data-wsc-layer-toggle="labels" title="Toggle in-zone text labels" style="font-size:11px;padding:2px 8px;border:0;background:${_layers.labels ? 'var(--ies-navy)' : 'transparent'};color:${_layers.labels ? '#fff' : 'var(--ies-gray-600)'};border-radius:3px;cursor:pointer;font-weight:600;">Labels</button>
            <button data-wsc-layer-toggle="doors" title="Toggle dock door rendering" style="font-size:11px;padding:2px 8px;border:0;background:${_layers.doors ? 'var(--ies-navy)' : 'transparent'};color:${_layers.doors ? '#fff' : 'var(--ies-gray-600)'};border-radius:3px;cursor:pointer;font-weight:600;">Doors</button>
          </span>
          <!-- Phase B.B17 (2026-05-26) — Measure tool. M keyboard shortcut also toggles. -->
          <button class="${_measureMode ? 'hub-btn-primary' : 'hub-btn-secondary'}" data-wsc-action="toggle-measure" style="font-size:12px;padding:4px 10px;" title="Measure distances on the floorplan. Click two points to lay a dimension line in feet. Press M to toggle, Esc to exit.">
            ${_measureMode ? '✓ Measuring' : `${icon('ruler')} Measure`}
          </button>
          ${_measureLines.length > 0 ? `
            <button class="hub-btn-link" data-wsc-action="clear-measurements" style="font-size:12px;padding:4px 8px;" title="Remove all dimension lines from the floorplan">
              ✕ Clear (${_measureLines.length})
            </button>
          ` : ''}
          <button class="${editing ? 'hub-btn-primary' : 'hub-btn-secondary'}" data-wsc-action="toggle-edit-layout" style="font-size:12px;padding:4px 10px;" title="Drag Office, Ship Staging, and Forward Pick to manually reposition them">
            ${editing ? '✓ Done Editing' : `${icon('edit')} Edit Layout`}
          </button>
        </div>
      </div>
      <div style="position:relative;">
        <canvas id="wsc-plan-canvas" width="900" height="520" style="width:100%; border:1px solid var(--ies-gray-200); border-radius:6px; background:#fff; cursor: default;"></canvas>
        <!-- Phase A.A10 (2026-05-26) — AutoCAD-style status strip: live
             cursor coords + hovered-zone summary. Empty by default; the
             hover handler in ui-shell-events fills it via planHoverUpdate. -->
        <div id="wsc-plan-statusbar" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:6px;padding:4px 10px;background:var(--ies-gray-100, #f3f4f6);border:1px solid var(--ies-gray-200);border-radius:4px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-variant-numeric:tabular-nums;font-size:11px;color:var(--ies-gray-700);min-height:22px;">
          <span data-statusbar-coords style="white-space:nowrap;">X: ----  Y: ----  ft</span>
          <span data-statusbar-selection style="flex:1;text-align:right;color:var(--ies-gray-500);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Hover a zone…</span>
        </div>
        ${editing ? `
          <div style="margin-top:8px;padding:8px 12px;background:var(--c-info-soft);border:1px solid var(--c-info-border);border-radius:6px;font-size:12px;color:var(--c-info-deep);">
            <strong>Edit mode:</strong> drag Office, Ship Staging, or Forward Pick zones to reposition them. Snaps to 5 ft. Save the model to persist.
          </div>
        ` : ''}
        ${_measureMode ? `
          <div style="margin-top:8px;padding:8px 12px;background:var(--c-warn-bg);border:1px solid #fcd34d;border-radius:6px;font-size:12px;color:#78350f;">
            <strong>${icon('ruler')} Measure mode:</strong> click two points to lay a dimension line. Distance shown in feet. Press <strong>M</strong> to toggle off, <strong>Esc</strong> to exit.
          </div>
        ` : ''}
      </div>
      <div style="margin-top:var(--sp-3); display:flex; flex-wrap:wrap; gap:14px; font-size:11px; color:var(--ies-gray-500);">
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:#ea580c;border:1px solid #9a3412;border-radius:2px;"></span>Full Pallet Rack</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:var(--c-warn);border:1px solid var(--c-warn-deep);border-radius:2px;"></span>Carton on Pallet</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:#0d9488;border:1px solid #0f766e;border-radius:2px;"></span>Carton Shelving</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:#ede9fe;border:1px solid var(--c-purple);border-radius:2px;"></span>Forward Pick</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:#ecfdf5;border:1px solid var(--c-success);border-radius:2px;"></span>Receive Staging</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:var(--c-warn-soft);border:1px solid var(--c-warn-strong);border-radius:2px;"></span>Ship Staging</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:#f5f3ff;border:1px solid var(--c-purple-bright);border-radius:2px;"></span>Office</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:var(--c-danger-border);border:1px solid #7f1d1d;border-radius:2px;"></span>Outbound Door</span>
        <span class="u-inline-row"><span style="display:inline-block;width:12px;height:12px;background:var(--c-info-border);border:1px solid var(--c-info-strong);border-radius:2px;"></span>Inbound Door</span>
      </div>
    </div>
  `;
}

/**
 * P3-2 (2026-07-03) — guarded entry point. drawPlan is the exact rAF paint
 * path that historically blanked the canvas on a single thrown error (the
 * columnRanges ReferenceError, the null-coord heatmap abort). The guard
 * paints an in-canvas banner instead of dying silently, and rethrows to a
 * console.error so the global error-net / devtools still see it. Callers
 * with empty catch blocks stay safe — the banner is drawn before rethrow.
 */
export function drawPlan(pctx) {
  try {
    _drawPlanUnsafe(pctx);
  } catch (err) {
    console.error('[WSC] drawPlan failed:', err);
    try {
      const canvas = pctx.rootEl?.querySelector('#wsc-plan-canvas');
      const ctx = canvas && canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fef2f2';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#991b1b';
        ctx.font = '600 14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('2D Plan failed to render — see console for details.', canvas.width / 2, canvas.height / 2 - 10);
        ctx.font = '400 12px system-ui, sans-serif';
        ctx.fillText(String(err?.message || err).slice(0, 120), canvas.width / 2, canvas.height / 2 + 12);
      }
    } catch { /* banner is best-effort */ }
  }
}

function _drawPlanUnsafe(pctx) {
  const canvas = pctx.rootEl?.querySelector('#wsc-plan-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Pull sized pctx.facility numbers so this view agrees with the dashboard.
  const sized = calc.sizeFacility(pctx.toSizingInputs());
  // Phase A: route elevation params through mode-aware pctx.facility shape.
  const elev = calc.elevationParams(pctx.renderFacility(pctx.facility, sized));
  // Brock 2026-04-20: floorplan scale uses sized SF (the computed answer)
  // when the user hasn't set an Existing/Target SF constraint. This way
  // the 2D view renders as soon as peak units / storage inputs are
  // populated, without requiring the user to first guess a total SF.
  const totalSqft = pctx.facility.totalSqft || sized.totalSqft || 0;
  if (totalSqft <= 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Enter peak units + storage inputs — the tool will size the floorplan.', cw / 2, ch / 2);
    return;
  }

  // Building dimensions (ft) — Phase A (2026-05-05): mode-aware via
  // pctx.renderFacility helper. Design mode → engine's suggested footprint
  // (no empty-building visual). Constraint mode → user W×D (empty space
  // surfaces as capacity slack; dashboard shows gap %).
  //
  // WSC-O1 (2026-05-04): single source of truth for orientation lives in
  // calc.orientFacility() — Plan / Elevation / 3D all consume it. Convention:
  // dock-on-long-edge, longFt rendered horizontal, shortFt vertical.
  let _orient = calc.orientFacility(pctx.renderFacility(pctx.facility, sized));
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
  const twoSidedLayout = (pctx.zones.dockConfig?.sided === 'two');
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
  pctx.resetPlanZoneRects();

  // Resolve a zone's rendered top-left + dimensions, honoring manual layout
  // overrides when edit mode has captured one. Overrides are stored in
  // building-relative feet so they survive resolution changes.
  // Shape: { x, y, w, h } — w/h are optional; falls back to autoWPx/autoHPx
  // when omitted. Move-drag writes x/y; resize-drag writes w/h.
  const applyOverride = (zoneId, autoXPx, autoYPx, autoWPx, autoHPx) => {
    const o = pctx.zones.layoutOverrides?.[zoneId];
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
  pctx._planZoneRects.office = { x: officeX, y: officeY, w: officeWpx, h: officeHpx };

  // ---------- Storage rack rows ----------
  // Back-to-back rack pairs with aisles between them.
  const rackDepthFt = elev.rackDepthFt || 4.3;
  const aisleFt     = (pctx.facility.aisleWidth || elev.aisleWidth || 12);
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
  const fpEnabled = !!pctx.zones.forwardPick?.enabled;
  const fpSqft    = fpEnabled ? Math.max(2000, Math.min(30000, (pctx.zones.forwardPick.skuCount || 2000) * 6)) : 0;
  // Visual strip height: scale FP sqft to footprint width × strip height
  // Min 30 ft (was 20) so the FP strip renders thick enough to grab in edit mode.
  const fpStripFt = fpEnabled ? Math.min(60, Math.max(30, fpSqft / Math.max(1, widthFt - (officeWpx / pxPerFt + 8)))) : 0;
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
    pctx._planZoneRects.forwardPick = { x: fpX, y: fpY, w: fpW, h: fpStripPx };
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
    fillMode: (pctx.facility.sizingMode || 'design') === 'design' ? 'fill' : 'target',
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
  // storage pctx.zones — full-pallet, carton-on-pallet, and shelving columns
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
  // Phase F.4 (2026-05-05) — Brock callout: "is it possible to put in labels
  // for the storage types in 2D". Track per-type X-extent during the rack
  // loop so we can label each zone at its horizontal center after the loop.
  const _zoneXExtents = TYPES.map(() => ({ minX: Infinity, maxX: -Infinity }));
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
          // Phase F.10 (2026-05-05) — IE-correct 2D rack rendering. Pre-fix
          // the pallet rack zone drew as a single solid rectangle per
          // segment per side ("two parallel orange stripes"). Now it shows
          // per-bay structural detail to match the Phase 3 3D treatment:
          //   • Outer rectangle (rack-pair outline) — light fill so individual
          //     bays read against it
          //   • Vertical bay-divider tick lines every PALLET_BAY_WIDTH_FT
          //     suggesting upright posts
          //   • Per-bay pallet "occupancy ticks" (small horizontal marks)
          //     at fillPct so 2D plan reads same density as 3D scene
          const bayWidthFt = (calc.PALLET_BAY_WIDTH_FT || 9);
          const bayPxPlan = Math.max(2, bayWidthFt * pxPerFt);
          // Rack-pair outline: lighter fill, darker stroke
          ctx.fillRect(mx, yTop, rackPx, segH);
          ctx.fillRect(mx + rackPx + 2, yTop, rackPx, segH);
          // Stroke outline
          ctx.strokeRect(mx, yTop, rackPx, segH);
          ctx.strokeRect(mx + rackPx + 2, yTop, rackPx, segH);
          // Bay-divider tick lines (vertical posts) — only draw if the
          // bay width is wide enough to be readable.
          if (bayPxPlan > 4) {
            ctx.save();
            ctx.strokeStyle = t.stroke;
            ctx.lineWidth = 0.5;
            ctx.globalAlpha = 0.55;
            for (let bayY = yTop + bayPxPlan; bayY < yTop + segH - 1; bayY += bayPxPlan) {
              // Left rack of pair
              ctx.beginPath();
              ctx.moveTo(mx + 1, bayY);
              ctx.lineTo(mx + rackPx - 1, bayY);
              ctx.stroke();
              // Right rack of pair
              ctx.beginPath();
              ctx.moveTo(mx + rackPx + 3, bayY);
              ctx.lineTo(mx + 2 * rackPx + 1, bayY);
              ctx.stroke();
            }
            ctx.restore();
          }
        }
      };

      // Build per-column vertical ranges where racks can live. Start with
      // the full rack zone, then subtract office + FP carve-outs that this
      // column overlaps. Office sits in the bottom-left corner so it just
      // truncates the bottom. FP at the default bottom position behaves
      // the same — but a user-dragged mid-building FP SPLITS the column
      // into above-FP and below-FP ranges (2026-05-14 Phase 1 of
      // "drag changes the design"). Fix 2026-05-26: prior commit
      // referenced columnRanges in the loop below without defining it,
      // throwing ReferenceError mid-render and leaving the 2D Plan canvas
      // blank for any scenario with rack columns.
      const columnRanges = [];
      {
        const carves = [];
        if (overlapsOfficeX) carves.push({ top: officeY - 4 * pxPerFt, bot: _planRacksBottomFull + 1 });
        if (overlapsFpX)     carves.push({ top: fpY - 4 * pxPerFt, bot: fpY + fpStripPx + 4 * pxPerFt });
        carves.sort((a, b) => a.top - b.top);
        let cur = racksTop;
        for (const c of carves) {
          if (c.top > cur) columnRanges.push({ top: cur, bot: Math.min(c.top, _planRacksBottomFull) });
          cur = Math.max(cur, c.bot);
        }
        if (cur < _planRacksBottomFull) columnRanges.push({ top: cur, bot: _planRacksBottomFull });
      }

      // Intersect each master segment with EACH of this column's ranges.
      // Cross-aisles stay aligned across the whole building; columns
      // truncated by office / FP simply lose their tail segments in each
      // affected range.
      for (const cr of columnRanges) {
        for (const mseg of _planMasterSegments) {
          const segTop    = Math.max(mseg.yStart, cr.top);
          const segBottom = Math.min(mseg.yEnd,   cr.bot);
          const segH      = segBottom - segTop;
          if (segH > 0) drawSegment(segTop, segH);
        }
      }
    }
    // Track per-type X-extent for the post-loop zone labels.
    if (typeIdx < _zoneXExtents.length) {
      const ex = _zoneXExtents[typeIdx];
      ex.minX = Math.min(ex.minX, mx);
      ex.maxX = Math.max(ex.maxX, mx + 2 * rackPx + aislePx);
    }
    typeUsed += 2;
    colIdx += 2;
    mx += modulePx;
  }

  // ---------- Phase F.11 (2026-05-06) — labeled cross-aisle strips ----------
  // Brock's parked Phase F backlog: "render circulation buffer explicitly
  // as labeled cross-aisles instead of consuming it as padding." Pre-F.11
  // the cross-aisles existed only as invisible gaps between rack segments —
  // a real IE artifact (NFPA-required egress + forklift turn-around) but
  // visually indistinguishable from "dead space" or "rendering bug."
  //
  // Now: each cross-aisle band gets a light-gray fill + dashed stroke +
  // "◀  CROSS-AISLE  ▶" label centered in the band. Reads at-a-glance as
  // engineered circulation, not as a bug.
  //
  // Engine source of truth: calc.circulationLayoutFt (Phase F.11 helper).
  // Master Y-bands already computed above as `_planMasterSegments`; the
  // gaps between them ARE the cross-aisles. We don't need to re-derive
  // positions, just paint them.
  const _planRackLeftX  = X0 + sideMarginPx;
  const _planRackRightX = X0 + Wpx - sideMarginPx;
  if (_planMasterSegments.length > 1) {
    ctx.save();
    for (let i = 0; i < _planMasterSegments.length - 1; i++) {
      const yTop = _planMasterSegments[i].yEnd;
      const yBottom = _planMasterSegments[i + 1].yStart;
      const bandH = yBottom - yTop;
      if (bandH <= 0) continue;
      // Light-gray strip
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(_planRackLeftX, yTop, _planRackRightX - _planRackLeftX, bandH);
      // Dashed top + bottom edges suggesting aisle striping
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(_planRackLeftX, yTop + 1);
      ctx.lineTo(_planRackRightX, yTop + 1);
      ctx.moveTo(_planRackLeftX, yBottom - 1);
      ctx.lineTo(_planRackRightX, yBottom - 1);
      ctx.stroke();
      ctx.setLineDash([]);
      // Label centered in band — only if band is tall enough to read
      if (bandH > 8) {
        const cy = yTop + bandH / 2;
        const cx = (_planRackLeftX + _planRackRightX) / 2;
        ctx.fillStyle = '#4b5563';
        ctx.font = 'bold 9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('◀  CROSS-AISLE  ▶', cx, cy + 3);
      }
    }
    ctx.restore();
  }

  // ---------- Per-zone labels (F.4 fix) ----------
  // Render each zone's name at its horizontal center, just below the top
  // dim line. Skip pctx.zones that didn't render any cols (extents stay at
  // Infinity / -Infinity).
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < TYPES.length; i++) {
    const ex = _zoneXExtents[i];
    if (!Number.isFinite(ex.minX) || !Number.isFinite(ex.maxX)) continue;
    if (ex.maxX - ex.minX < 60) continue; // too narrow to label readably
    const cx = (ex.minX + ex.maxX) / 2;
    // Pill background for legibility against the orange/teal racks
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    const labelTxt = TYPES[i].label;
    const padX2 = 6;
    const lblW = ctx.measureText(labelTxt).width + padX2 * 2;
    const lblH = 16;
    ctx.fillRect(cx - lblW / 2, storageY + 30 - lblH + 4, lblW, lblH);
    ctx.strokeStyle = TYPES[i].stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - lblW / 2, storageY + 30 - lblH + 4, lblW, lblH);
    ctx.fillStyle = TYPES[i].stroke;
    ctx.fillText(labelTxt, cx, storageY + 30);
  }
  ctx.textAlign = 'left';

  // ---------- Forward Pick Area (front strip of storage, when enabled) ----------
  if (fpEnabled && fpW > 80 && fpStripPx > 12) {
    ctx.fillStyle = '#ede9fe';
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 1;
    ctx.fillRect(fpX, fpY, fpW, fpStripPx);
    ctx.strokeRect(fpX, fpY, fpW, fpStripPx);
    if (_layers.hatch) drawHatch(ctx, 'ansi31', fpX, fpY, fpW, fpStripPx, '#7c3aed');
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
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    if (_layers.labels) ctx.fillText(`Forward Pick  ·  ${(pctx.zones.forwardPick.type || 'carton flow').replace('_', ' ')}`, fpX + fpW / 2, fpY + fpStripPx / 2 + 4);
  }

  // Storage label (top of storage zone, right-aligned to clear the office)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 12px Inter, sans-serif';
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
    ctx.font = 'bold 11px Inter, sans-serif';
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
  if (_layers.hatch) drawHatch(ctx, 'dots', shipX, shipY, shipW, shipDrawH, '#92400e');
  ctx.strokeRect(shipX, shipY, shipW, shipDrawH);
  ctx.fillStyle = '#92400e';
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  if (shipW > 100) {
    // If user corner-resized this zone, label should reflect drawn w*h, not
    // the engine's sized.shipStagingSqft (Brock 2026-05-14 — "SF should reflect
    // what I drew"). Move-only overrides keep the sized number; only w/h
    // overrides flip the label to the drawn area.
    const _o = pctx.zones.layoutOverrides?.shipStaging;
    const _resized = !!_o && (_o.w !== undefined || _o.h !== undefined);
    const _drawnSqft = Math.round((shipW * shipDrawH) / Math.max(1e-6, pxPerFt * pxPerFt));
    const _labelSqft = _resized ? _drawnSqft : sized.shipStagingSqft;
    if (_layers.labels) ctx.fillText(`Ship Staging  ·  ${calc.formatSqft(_labelSqft)}`, shipX + shipW / 2, shipY + shipDrawH / 2 + 4);
  }
  pctx._planZoneRects.shipStaging = { x: shipX, y: shipY, w: shipW, h: shipDrawH };

  // ---------- Office (front-left corner, full block from storage down to dock face) ----------
  ctx.fillStyle = '#f5f3ff';
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 1;
  // Single tall block from officeY down to the dock face (covers part of storage zone + ship-staging zone)
  const officeBlockH = (Y0 + Hpx) - officeY - 4;
  ctx.fillRect(officeX, officeY, officeWpx, officeBlockH);
  ctx.strokeRect(officeX, officeY, officeWpx, officeBlockH);
  if (_layers.hatch) drawHatch(ctx, 'ansi31', officeX, officeY, officeWpx, officeBlockH, '#6b21a8');
  ctx.fillStyle = '#5b21b6';
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  if (_layers.labels && officeWpx > 50 && officeBlockH > 28) {
    ctx.fillText('Office', officeX + officeWpx / 2, officeY + officeBlockH / 2 - 4);
    ctx.fillStyle = '#6b21a8';
    ctx.font = '10px Inter, sans-serif';
    // Resize-aware label (Brock 2026-05-14). Uses hit-rect w*h, which is
    // what the user dragged. officeBlockH is the visual stretched-to-dock-face
    // height — not the user-chosen size, so we deliberately use officeHpx.
    const _oOff = pctx.zones.layoutOverrides?.office;
    const _resizedOff = !!_oOff && (_oOff.w !== undefined || _oOff.h !== undefined);
    const _drawnOff = Math.round((officeWpx * officeHpx) / Math.max(1e-6, pxPerFt * pxPerFt));
    const _labelOff = _resizedOff ? _drawnOff : sized.officeSqft;
    ctx.fillText(`${calc.formatSqft(_labelOff)}`, officeX + officeWpx / 2, officeY + officeBlockH / 2 + 12);
  }

  // ---------- Dock doors at bottom edge, aligned with ship staging ----------
  // Use the sized engine's door count so this view agrees with the KPI bar.
  // Phase B.B14 — door rendering wrapped in if (_layers.doors) so the
  // Layers toggle can hide doors entirely. twoSided is declared BEFORE
  // the guard so the building-dimension-labels block below can still read
  // it (decides INBOUND DOCK / OUTBOUND DOCK vs BACK / DOCK FACE labels).
  const totalDoors = sized.dock.totalDoors || 0;
  const inboundDoors = sized.dock.inboundDoors || 0;
  const outboundDoors = sized.dock.outboundDoors || 0;
  const twoSided = (pctx.zones.dockConfig?.sided === 'two');
  if (_layers.doors) {

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
    ctx.font = 'bold 10px Inter, sans-serif';
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
    // Phase F.4 (2026-05-05) — Brock callout: "office in 2D is shown going in
    // front of the dock doors. Typically, if the office is in a corner of the
    // pctx.facility, then there aren't any dock doors there." Clamp inbound xStart
    // past the office right edge so doors skip the office X-range.
    const mid = X0 + Wpx / 2;
    const gap = Math.max(8 * pxPerFt, 60); // ≥ 8 ft visual gap between banks
    const inboundStart = Math.max(X0, officeRightX);
    drawDoorRow(inboundDoors,  Y0 + Hpx - 6, `${inboundDoors} Inbound`,  '#bfdbfe', false, inboundStart, mid - gap / 2);
    drawDoorRow(outboundDoors, Y0 + Hpx - 6, `${outboundDoors} Outbound`, '#fecaca', false, mid + gap / 2, X0 + Wpx);
  } else {
    // Edge case: only one type of door — distribute across the full wall.
    drawDoorRow(totalDoors, Y0 + Hpx - 6, `${totalDoors} Dock Doors`, '#fecaca', false, X0, X0 + Wpx);
  }
  }  // end if (_layers.doors)

  // ---------- Building dimension labels ----------
  ctx.fillStyle = '#374151';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${widthFt.toLocaleString()} ft`, X0 + Wpx / 2, Y0 + Hpx + 44);
  ctx.save();
  ctx.translate(X0 - 22, Y0 + Hpx / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${depthFt.toLocaleString()} ft`, 0, 0);
  ctx.restore();

  // Compass / orientation. Phase F.4 (2026-05-05) — moved the top label
  // INSIDE the building (was Y0-22, overlapped the title block "clear ht
  // 36 ft" line at canvas Y=38). Bottom label stays just below dock face.
  ctx.fillStyle = '#6b7280';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(twoSided ? '▲ INBOUND DOCK' : '▲ BACK', X0 + 6, Y0 + 14);
  ctx.fillText(twoSided ? '▼ OUTBOUND DOCK' : '▼ DOCK FACE', X0 + 4, Y0 + Hpx + 22);

  // Title block (top-left, outside building)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 13px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(pctx.facility.name || 'Facility', 12, 22);
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Inter, sans-serif';
  ctx.fillText(
    `${calc.formatSqft(sized.totalSqft)} sized  ·  clear ht ${pctx.facility.clearHeight || 0} ft`,
    12, 38,
  );

  // Stash canvas metadata for pointer-event handlers (edit mode).
  pctx._planMeta = { X0, Y0, Wpx, Hpx, pxPerFt, canvasEl: canvas };

  // Edit-mode overlay: draw a dashed selection frame around each draggable
  // zone so the user sees what can be moved.
  if (pctx._planEditMode) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    for (const [id, r] of Object.entries(pctx._planZoneRects)) {
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
    for (const [id, r] of Object.entries(pctx._planZoneRects)) {
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

  // ---------- Phase A.A6 (2026-05-26) — Foot-snap grid overlay ----------
  // Subtle grid lines drawn on top of zone fills so the user can read
  // distances off the drawing. Minor lines at the chosen modulus, slightly
  // heavier lines every 50 ft. Off by default for the smallest modulus
  // (2 ft) at very-zoomed-out scales to avoid visual noise.
  if (_gridMode !== 'off') {
    const minorFt = _gridMode === '2ft' ? 2 : (_gridMode === '5ft' ? 5 : 10);
    const majorFt = 50;
    // Suppress 2' grid when pxPerFt is too small — would render as a solid
    // grey wash. Threshold tuned for ~1 px per 2 ft visibility.
    const minorPx = minorFt * pxPerFt;
    if (minorPx >= 1.5) {
      ctx.save();
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.05)';
      // Minor vertical lines
      for (let f = minorFt; f < widthFt; f += minorFt) {
        if (f % majorFt === 0) continue;
        const xp = X0 + f * pxPerFt;
        ctx.beginPath(); ctx.moveTo(xp, Y0); ctx.lineTo(xp, Y0 + Hpx); ctx.stroke();
      }
      // Minor horizontal lines
      for (let f = minorFt; f < depthFt; f += minorFt) {
        if (f % majorFt === 0) continue;
        const yp = Y0 + f * pxPerFt;
        ctx.beginPath(); ctx.moveTo(X0, yp); ctx.lineTo(X0 + Wpx, yp); ctx.stroke();
      }
      // Major lines every 50 ft (slightly darker)
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      for (let f = majorFt; f < widthFt; f += majorFt) {
        const xp = X0 + f * pxPerFt;
        ctx.beginPath(); ctx.moveTo(xp, Y0); ctx.lineTo(xp, Y0 + Hpx); ctx.stroke();
      }
      for (let f = majorFt; f < depthFt; f += majorFt) {
        const yp = Y0 + f * pxPerFt;
        ctx.beginPath(); ctx.moveTo(X0, yp); ctx.lineTo(X0 + Wpx, yp); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---------- Phase A.A8 (2026-05-26) — Column grid bubbles ----------
  // Structural column grid at facility.columnSpacingX × columnSpacingY
  // (default 50' × 50'). Bubbles drawn in the canvas margin: letters along
  // the top edge (N-S column lines: A, B, C, ...), numerals along the left
  // edge (E-W column lines: 1, 2, 3, ...). Classic ANSI D engineering
  // drawing convention — turns the plan from "a picture of a building"
  // into "a sheet you could mark up." Hidden when bubbles would overlap
  // (column spacing × pxPerFt < bubble diameter + breathing room).
  // Phase B.B14 — also hidden when the Layers > Cols toggle is off.
  if (_layers.columns) {
    const colX = +pctx.facility.columnSpacingX || 50;
    const colY = +pctx.facility.columnSpacingY || 50;
    const bubbleR = 9;
    const minPxBetween = bubbleR * 2 + 4;
    const stepXPx = colX * pxPerFt;
    const stepYPx = colY * pxPerFt;
    if (stepXPx >= minPxBetween && stepYPx >= minPxBetween) {
      ctx.save();
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // X-axis (letters along the top of the building)
      let letterIdx = 0;
      for (let f = 0; f <= widthFt + 0.5; f += colX) {
        const xp = X0 + f * pxPerFt;
        const yp = Y0 - 18;
        // Lead-in tick
        ctx.strokeStyle = 'rgba(0,0,0,0.30)';
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(xp, Y0 - 8); ctx.lineTo(xp, Y0); ctx.stroke();
        // Bubble
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#1f2937';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(xp, yp, bubbleR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        // Label
        ctx.fillStyle = '#1f2937';
        ctx.fillText(_columnBubbleLetter(letterIdx), xp, yp + 0.5);
        letterIdx++;
        // Don't draw past a reasonable count; AA after Z is fine.
        if (letterIdx > 100) break;
      }
      // Y-axis (numerals along the left of the building)
      let numIdx = 0;
      for (let f = 0; f <= depthFt + 0.5; f += colY) {
        const xp = X0 - 18;
        const yp = Y0 + f * pxPerFt;
        ctx.strokeStyle = 'rgba(0,0,0,0.30)';
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(X0 - 8, yp); ctx.lineTo(X0, yp); ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#1f2937';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(xp, yp, bubbleR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#1f2937';
        ctx.fillText(String(numIdx + 1), xp, yp + 0.5);
        numIdx++;
        if (numIdx > 100) break;
      }
      ctx.restore();
    }
  }

  // ---------- Phase A.A13 (2026-05-26) — Hover outline ----------
  // 1-px highlight outline on the currently hovered zone so the user sees
  // what their click would land on before they commit. State is set by the
  // planHoverUpdate() handler in ui-shell-events.js; we just paint it here.
  const hoveredId = pctx._planHoveredZone;
  if (hoveredId && pctx._planZoneRects?.[hoveredId]) {
    const r = pctx._planZoneRects[hoveredId];
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.restore();
  }

  // ---------- Phase A.A9 (2026-05-26) — Live dim callout during drag ----------
  // While a drag is active, draw a floating label next to the cursor with
  // the zone's current W × H in feet. Updates every pointer-move (called by
  // the drag handler in ui-shell-events.js). Disappears on pointer-up
  // (handler clears _planDragCursorPx + redraws). Reads zone dims from the
  // already-applied layoutOverride via _planZoneRects.
  if (pctx._planDrag && pctx._planDragCursorPx && pctx._planZoneRects) {
    const drag = pctx._planDrag;
    const cur  = pctx._planDragCursorPx;
    const r    = pctx._planZoneRects[drag.zoneId];
    if (r) {
      const wFt = Math.round(r.w / pxPerFt);
      const hFt = Math.round(r.h / pxPerFt);
      const sqft = (wFt * hFt).toLocaleString();
      const text = `${wFt} × ${hFt} ft  ·  ${sqft} sf`;
      ctx.save();
      ctx.font = 'bold 11px Inter, sans-serif';
      const padX = 8;
      const padY = 5;
      const metrics = ctx.measureText(text);
      const boxW = metrics.width + padX * 2;
      const boxH = 11 + padY * 2;
      // Position the callout above-right of the cursor by default; flip
      // left/below if it would clip the canvas edge.
      let bx = cur.x + 14;
      let by = cur.y - boxH - 10;
      if (bx + boxW > cw - 4) bx = cur.x - boxW - 14;
      if (by < 4) by = cur.y + 14;
      // Backing pill
      ctx.fillStyle = 'rgba(31,41,55,0.92)';
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1;
      const rad = 4;
      ctx.beginPath();
      ctx.moveTo(bx + rad, by);
      ctx.lineTo(bx + boxW - rad, by);
      ctx.quadraticCurveTo(bx + boxW, by, bx + boxW, by + rad);
      ctx.lineTo(bx + boxW, by + boxH - rad);
      ctx.quadraticCurveTo(bx + boxW, by + boxH, bx + boxW - rad, by + boxH);
      ctx.lineTo(bx + rad, by + boxH);
      ctx.quadraticCurveTo(bx, by + boxH, bx, by + boxH - rad);
      ctx.lineTo(bx, by + rad);
      ctx.quadraticCurveTo(bx, by, bx + rad, by);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Label
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(text, bx + padX, by + padY);
      ctx.restore();
    }
  }

  // ---------- Phase A.A7 (2026-05-26) — Scale bar + north arrow ----------
  // CAD-convention chrome that turns the floorplan from a sketch into a
  // drawing. Scale bar in bottom-right uses alternating filled / empty
  // segments at a "nice" foot increment chosen from pxPerFt so it always
  // reads as a sensible round number (50/100/200/500 ft). North arrow in
  // the top-right is a simple triangle + "N" label. Both rendered last so
  // they overlay any zone graphics underneath.
  drawScaleBar(ctx, cw, ch, pxPerFt);
  drawNorthArrow(ctx, cw, ch);

  // Phase B.B17 (2026-05-26) — Measurement overlay. Rendered last so
  // dimension lines and labels always sit on top of zone graphics.
  drawMeasurements(ctx, X0, Y0, pxPerFt, cw, ch);
}

/**
 * Phase B.B17 (2026-05-26) — Render committed measurements + live preview.
 *
 * Dimension line styling: white core with dark outline (reads on any zone
 * background), tick marks at each endpoint, distance label centered on the
 * line with a white pill backing. While measure-mode is active and an
 * anchor point has been set, a dashed preview line follows the cursor.
 *
 * Points are stored in feet (xFt, yFt) so they survive canvas resize.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} X0      Building origin offset (px) — top-left of building
 * @param {number} Y0      Building origin offset (px)
 * @param {number} pxPerFt Pixels per foot
 * @param {number} cw      Canvas width (px) — for off-canvas clamping
 * @param {number} ch      Canvas height (px)
 */
function drawMeasurements(ctx, X0, Y0, pxPerFt, cw, ch) {
  const hasCommitted = _measureLines.length > 0;
  const hasPreview = _measureMode && _measureAnchor && _measureCursor;
  if (!hasCommitted && !hasPreview) return;

  // Stash for drawDimensionLine — used to convert px distance → ft label
  _lastDrawPxPerFt = pxPerFt;

  ctx.save();

  // ---- Committed measurements ----
  for (const m of _measureLines) {
    const ax = X0 + m.aFt.xFt * pxPerFt;
    const ay = Y0 + m.aFt.yFt * pxPerFt;
    const bx = X0 + m.bFt.xFt * pxPerFt;
    const by = Y0 + m.bFt.yFt * pxPerFt;
    drawDimensionLine(ctx, ax, ay, bx, by, false);
  }

  // ---- Live preview (anchor → cursor) ----
  if (hasPreview) {
    const ax = X0 + _measureAnchor.xFt * pxPerFt;
    const ay = Y0 + _measureAnchor.yFt * pxPerFt;
    const bx = _measureCursor.xPx;
    const by = _measureCursor.yPx;
    // Convert cursor back to ft for the label so it shows the live distance
    drawDimensionLine(ctx, ax, ay, bx, by, true);
  }

  ctx.restore();
}

/**
 * Paint a single dimension line — dark outline + light core, end ticks,
 * pill-backed distance label centered on the line.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} ax pixel coords (start)
 * @param {number} ay
 * @param {number} bx pixel coords (end)
 * @param {number} by
 * @param {boolean} dashed True for live preview (anchor → cursor)
 */
function drawDimensionLine(ctx, ax, ay, bx, by, dashed) {
  // The pxPerFt used to make this measurement is implicit — we need to
  // pull it from the caller. Easier to re-derive distance from canvas
  // px / the pctx.pxPerFt we received. But we already received the
  // committed point in ft, so distance is just Euclidean in ft via the
  // stored aFt/bFt. For preview we use the cursor px → ft conversion
  // done by drawMeasurements. Simplest: compute the px distance here
  // and convert using the stored module-level pxPerFt-of-last-draw.
  // But the only safe way is to pass it in. drawMeasurements has it,
  // so we'll just stash it on the function for the next call. For now
  // we read pxPerFt from a private cache set by drawMeasurements.
  const distPx = Math.hypot(bx - ax, by - ay);
  const distFt = distPx / _lastDrawPxPerFt;

  // Dark outline (drop shadow for legibility on any color zone)
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.setLineDash(dashed ? [6, 4] : []);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();

  // Light core line
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = dashed ? '#fbbf24' : '#fef3c7';
  ctx.setLineDash(dashed ? [6, 4] : []);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);

  // End ticks — perpendicular to the line, 6px each side of endpoint
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len * 6;  // perpendicular vector
  const py = dx / len * 6;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fef3c7';
  for (const [tx, ty] of [[ax, ay], [bx, by]]) {
    ctx.beginPath();
    ctx.moveTo(tx - px, ty - py);
    ctx.lineTo(tx + px, ty + py);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.6)';
  for (const [tx, ty] of [[ax, ay], [bx, by]]) {
    ctx.beginPath();
    ctx.moveTo(tx - px, ty - py);
    ctx.lineTo(tx + px, ty + py);
    ctx.stroke();
  }

  // Distance label — pill backing, centered on midpoint, offset slightly
  // along the perpendicular so the label doesn't sit directly on the line.
  const midX = (ax + bx) / 2;
  const midY = (ay + by) / 2;
  const offX = -dy / len * 10;
  const offY = dx / len * 10;
  const labelX = midX + offX;
  const labelY = midY + offY;
  const labelText = `${distFt.toFixed(distFt < 10 ? 1 : 0)} ft`;
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textW = ctx.measureText(labelText).width;
  const padX = 6, padY = 3;
  const boxW = textW + padX * 2;
  const boxH = 14 + padY * 2;
  ctx.fillStyle = dashed ? 'rgba(251, 191, 36, 0.95)' : 'rgba(254, 243, 199, 0.95)';
  ctx.strokeStyle = dashed ? '#b45309' : '#92400e';
  ctx.lineWidth = 1;
  const rad = 4;
  const bx0 = labelX - boxW / 2;
  const by0 = labelY - boxH / 2;
  ctx.beginPath();
  ctx.moveTo(bx0 + rad, by0);
  ctx.lineTo(bx0 + boxW - rad, by0);
  ctx.quadraticCurveTo(bx0 + boxW, by0, bx0 + boxW, by0 + rad);
  ctx.lineTo(bx0 + boxW, by0 + boxH - rad);
  ctx.quadraticCurveTo(bx0 + boxW, by0 + boxH, bx0 + boxW - rad, by0 + boxH);
  ctx.lineTo(bx0 + rad, by0 + boxH);
  ctx.quadraticCurveTo(bx0, by0 + boxH, bx0, by0 + boxH - rad);
  ctx.lineTo(bx0, by0 + rad);
  ctx.quadraticCurveTo(bx0, by0, bx0 + rad, by0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#451a03';
  ctx.fillText(labelText, labelX, labelY);
}

// Cache the pxPerFt of the most recent drawPlan call so drawDimensionLine
// can convert pixel distances back to feet for its label. drawMeasurements
// sets it on each invocation.
let _lastDrawPxPerFt = 1;

/**
 * Graphic scale bar — bottom-right corner of the canvas. Picks a "nice"
 * unit length (the largest of [50, 100, 200, 500] feet that fits in ~140
 * canvas pixels) then draws four equal segments, alternating filled and
 * empty, with tick labels at each boundary. Classic survey-style scale.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cw  canvas width  in px
 * @param {number} ch  canvas height in px
 * @param {number} pxPerFt  current drawing scale (one foot = N canvas px)
 */
function drawScaleBar(ctx, cw, ch, pxPerFt) {
  if (!(pxPerFt > 0)) return;
  // Pick a nice unit length so the full bar is roughly 120–180 px wide.
  const CHOICES = [10, 20, 50, 100, 200, 500, 1000];
  const targetBarPx = 160;
  let unitFt = CHOICES[0];
  for (const c of CHOICES) {
    if (c * pxPerFt * 4 <= targetBarPx * 1.5) unitFt = c;
  }
  const segPx = unitFt * pxPerFt;
  const totalPx = segPx * 4;
  const totalFt = unitFt * 4;
  const padding = 16;
  const barH = 8;
  const x0 = cw - padding - totalPx;
  const y0 = ch - padding - barH - 14; // leave room for labels below
  // Background pill so the bar reads against any underlying zone.
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(x0 - 6, y0 - 4, totalPx + 12, barH + 22);
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x0 - 6, y0 - 4, totalPx + 12, barH + 22);
  // Alternating filled/empty segments.
  for (let i = 0; i < 4; i++) {
    const sx = x0 + i * segPx;
    ctx.fillStyle = (i % 2 === 0) ? '#1f2937' : '#ffffff';
    ctx.fillRect(sx, y0, segPx, barH);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, y0, segPx, barH);
  }
  // Tick labels — 0, 1×, 2×, 3×, 4×.
  ctx.fillStyle = '#1f2937';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const sx = x0 + i * segPx;
    const ft = i * unitFt;
    ctx.fillText(`${ft}`, sx, y0 + barH + 1);
  }
  // Unit suffix at the far right.
  ctx.textAlign = 'left';
  ctx.fillText('ft', x0 + totalPx + 2, y0 + barH + 1);
  // Scale ratio text above the bar (e.g., "0 — 200 ft").
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.font = '9px Inter, sans-serif';
  ctx.fillStyle = '#6b7280';
  ctx.fillText(`SCALE  0 — ${totalFt} ft`, x0, y0 - 1);
  ctx.restore();
}

/**
 * North arrow — top-right corner of the canvas. WSC convention is north-up
 * (top of canvas = north), matching the orientFacility() / dock-on-bottom
 * layout shared with the 3D view. Simple equilateral triangle + "N" label.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cw
 * @param {number} ch
 */
function drawNorthArrow(ctx, cw, ch) {
  const padding = 16;
  const r = 18;                              // arrow half-height
  const cx = cw - padding - r;
  const cy = padding + r + 2;
  ctx.save();
  // Background circle so it reads against any underlying graphic.
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  // Arrow triangle (filled black pointing up, white pointing down — classic
  // surveyor's compass-rose half-shading).
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.45, cy + r);
  ctx.lineTo(cx, cy + r * 0.4);
  ctx.closePath();
  ctx.fillStyle = '#1f2937';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx - r * 0.45, cy + r);
  ctx.lineTo(cx, cy + r * 0.4);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  // "N" label below the arrow.
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('N', cx, cy + r + 3);
  ctx.restore();
}

/**
 * Phase A.A10 / A.A11 / A.A13 (2026-05-26) — shared hover handler for the
 * 2D plan canvas. Called from ui-shell-events.js's always-on pointermove.
 *
 * Updates three things in one pass (all share the same hit-test):
 *   1. The status bar's cursor-coord + zone-summary text (A10)
 *   2. The canvas cursor (move / nwse-resize / ns-resize / ew-resize) (A11)
 *   3. The hovered zone id on pctx — drawPlan reads this to draw a 1px
 *      highlight outline on the hovered zone (A13)
 *
 * Returns true if the hovered zone changed (so caller can redraw).
 *
 * @param {object} pctx   Plan context (same shape as drawPlan's)
 * @param {{offsetX:number, offsetY:number}} mouse
 * @returns {boolean} whether _planHoveredZone changed
 */
export function planHoverUpdate(pctx, mouse) {
  const canvas = pctx.rootEl?.querySelector('#wsc-plan-canvas');
  const statusBar = pctx.rootEl?.querySelector('#wsc-plan-statusbar');
  const meta = pctx._planMeta;
  if (!canvas || !meta) return false;

  // Convert mouse → building feet (origin at top-left corner of the drawn
  // building rectangle). Coords outside the building still render in the
  // status bar so users see they're "outside" the model.
  const xFt = (mouse.offsetX - meta.X0) / meta.pxPerFt;
  const yFt = (mouse.offsetY - meta.Y0) / meta.pxPerFt;

  // Hit-test against _planZoneRects (populated each drawPlan pass).
  let hovered = null;
  const ZONE_LABELS = {
    office:        'Office',
    shipStaging:   'Ship Staging',
    recvStaging:   'Receive Staging',
    forwardPick:   'Forward Pick',
  };
  for (const [id, r] of Object.entries(pctx._planZoneRects || {})) {
    if (mouse.offsetX >= r.x && mouse.offsetX <= r.x + r.w
      && mouse.offsetY >= r.y && mouse.offsetY <= r.y + r.h) {
      hovered = { id, rect: r };
      break;
    }
  }

  // ---- A11: cursor selection ----
  // Editable zones get a corner-resize cursor when within the handle radius,
  // a move cursor when inside the body, default cursor otherwise.
  let cursor = 'default';
  if (pctx._planEditMode && hovered) {
    const hit = hitCorner(hovered.rect, mouse.offsetX, mouse.offsetY);
    if (hit === 'tl' || hit === 'br') cursor = 'nwse-resize';
    else if (hit === 'tr' || hit === 'bl') cursor = 'nesw-resize';
    else cursor = 'move';
  } else if (hovered) {
    cursor = 'pointer';
  }
  canvas.style.cursor = cursor;

  // ---- A10: status bar text ----
  if (statusBar) {
    const coordsEl = statusBar.querySelector('[data-statusbar-coords]');
    const selEl    = statusBar.querySelector('[data-statusbar-selection]');
    if (coordsEl) {
      coordsEl.textContent = `X: ${xFt.toFixed(0).padStart(4, ' ')}  Y: ${yFt.toFixed(0).padStart(4, ' ')}  ft`;
    }
    if (selEl) {
      if (hovered) {
        const wFt = hovered.rect.w / meta.pxPerFt;
        const hFt = hovered.rect.h / meta.pxPerFt;
        const sqft = Math.round(wFt * hFt);
        const label = ZONE_LABELS[hovered.id] || hovered.id;
        selEl.style.color = 'var(--ies-gray-800)';
        selEl.textContent = `${label}  ·  ${Math.round(wFt)} × ${Math.round(hFt)} ft  ·  ${sqft.toLocaleString()} sf`;
      } else {
        selEl.style.color = 'var(--ies-gray-500)';
        selEl.textContent = 'Hover a zone…';
      }
    }
  }

  // ---- A13: hovered-zone state for next redraw ----
  const prev = pctx._planHoveredZone;
  const nextId = hovered?.id || null;
  pctx._planHoveredZone = nextId;
  return prev !== nextId;
}

/**
 * Phase B.B16 (2026-05-26) — ANSI-style hatch overlay for non-rack zones.
 * Draws a thin pattern on top of a zone fill so each zone reads with the
 * CAD convention for its function: ANSI31 (diagonal stripes) on enclosed
 * spaces like Office; DOTS on loose-material spaces like staging strips.
 * The base fillRect already painted the color — this overlays texture.
 *
 * Kept subtle (alpha 0.18) so it doesn't fight the color coding.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {'ansi31'|'dots'} kind
 * @param {number} x  zone left in canvas px
 * @param {number} y  zone top  in canvas px
 * @param {number} w  zone width
 * @param {number} h  zone height
 * @param {string} color  stroke / dot color (hex)
 */
function drawHatch(ctx, kind, x, y, w, h, color) {
  if (w < 12 || h < 12) return;                       // too small to read
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalAlpha = 0.18;
  if (kind === 'ansi31') {
    // Diagonal stripes, 45° angle, 6 px spacing.
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.6;
    const spacing = 6;
    // Cover the rect's diagonal extent so stripes fill corner-to-corner.
    const span = w + h;
    for (let i = -h; i < span; i += spacing) {
      ctx.beginPath();
      ctx.moveTo(x + i,         y);
      ctx.lineTo(x + i + h,     y + h);
      ctx.stroke();
    }
  } else if (kind === 'dots') {
    // Loose-aggregate dots — staggered 7 px grid.
    ctx.fillStyle = color;
    const step = 7;
    for (let row = 0; row * step < h; row++) {
      const offset = (row % 2 === 0) ? 0 : step / 2;
      for (let col = 0; col * step + offset < w; col++) {
        ctx.beginPath();
        ctx.arc(x + col * step + offset, y + row * step, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/**
 * Phase A.A8 helper — convert 0-based column index to an A/B/C/AA-style
 * label. Architectural-CAD convention: skip I and O so they don't read as
 * 1 or 0 in pen-weight scans.
 *
 * @param {number} i  0-based column index
 * @returns {string}
 */
function _columnBubbleLetter(i) {
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // skips I and O
  const base = LETTERS.length;
  let s = '';
  let n = i;
  do {
    s = LETTERS[n % base] + s;
    n = Math.floor(n / base) - 1;
  } while (n >= 0);
  return s;
}

/** Pixel radius around a corner that counts as a resize handle hit. */
const WSC_RESIZE_HANDLE_PX = 10;

/** Return which corner (if any) of a zone rect `r` the mouse is over. */
export function hitCorner(r, mx, my) {
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

// ============================================================
// DASHBOARD VIEW
// ============================================================

/**
 * Convert the UI's (pctx.facility, pctx.zones, pctx.volumes) state into SizingInputs
 * for the v2-equivalent calc.sizeFacility engine.
 * @returns {import('./calc.js?v=20260703-ux0').SizingInputs}
 */

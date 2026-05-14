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

import * as calc from './calc.js?v=20260514-fsi1';

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
          <span class="text-caption text-muted">Scale: 1 px ≈ ${Math.max(1, Math.round(Math.sqrt((pctx.facility.totalSqft || 0) * 1.5) / 800))} ft</span>
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
            <strong>Edit mode:</strong> drag Office, Ship Staging, or Forward Pick pctx.zones to reposition them. Snaps to 5 ft. Save the model to persist.
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

export function drawPlan(pctx) {
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
    ctx.font = '13px Montserrat, sans-serif';
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
        ctx.font = 'bold 9px Montserrat, sans-serif';
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
  ctx.font = 'bold 11px Montserrat, sans-serif';
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
    ctx.fillText(`Forward Pick  ·  ${(pctx.zones.forwardPick.type || 'carton flow').replace('_', ' ')}`, fpX + fpW / 2, fpY + fpStripPx / 2 + 4);
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
  pctx._planZoneRects.shipStaging = { x: shipX, y: shipY, w: shipW, h: shipDrawH };

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
  const twoSided = (pctx.zones.dockConfig?.sided === 'two');

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

  // Compass / orientation. Phase F.4 (2026-05-05) — moved the top label
  // INSIDE the building (was Y0-22, overlapped the title block "clear ht
  // 36 ft" line at canvas Y=38). Bottom label stays just below dock face.
  ctx.fillStyle = '#6b7280';
  ctx.font = '10px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(twoSided ? '▲ INBOUND DOCK' : '▲ BACK', X0 + 6, Y0 + 14);
  ctx.fillText(twoSided ? '▼ OUTBOUND DOCK' : '▼ DOCK FACE', X0 + 4, Y0 + Hpx + 22);

  // Title block (top-left, outside building)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 13px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(pctx.facility.name || 'Facility', 12, 22);
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Montserrat, sans-serif';
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
 * @returns {import('./calc.js?v=20260514-fsi1').SizingInputs}
 */

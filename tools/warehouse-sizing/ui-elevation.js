/**
 * IES Hub v3 — Warehouse Sizing — 2D Elevation view (extracted from ui.js 2026-05-13)
 *
 * Slice 5 of 7: side-view canvas drawing for both the rack-on-side view
 * and the shelving-bay-detail close-up.
 *
 * Exports:
 *   renderElevation(ectx)           — mounts canvas + kicks off drawElevation.
 *   shuffledBayLevelOrder(...)      — was _shuffledBayLevelOrder; ui.js imports
 *                                     for the 3D ctx since ui-3d.js needs it too.
 *
 * Private: drawElevation, drawShelvingBayDetail, drawRackProfile.
 *
 * ectx (named ectx not ctx — drawElevation body already uses `const ctx =
 * canvas.getContext('2d')` for the canvas 2D context):
 *   { facility, zones, volumes, rootEl, _wscElevView,  // getters
 *     renderFacility(fac, sized), toSizingInputs(),    // helpers
 *     drawDimH(...), drawDimV(...) }                   // dim-label drawers
 *
 * @module tools/warehouse-sizing/ui-elevation
 */

import * as calc from './calc.js?v=20260703-ux0';

export function renderElevation(ectx) {
  // Phase A: route elevation params through mode-aware ectx.facility shape.
  let _sizedEl = null;
  try { _sizedEl = calc.sizeFacility(ectx.toSizingInputs()); } catch {}
  const elev = calc.elevationParams(ectx.renderFacility(ectx.facility, _sizedEl), ectx.zones);
  const view = ectx._wscElevView || 'side';
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
          : `${ectx.facility.storageType.charAt(0).toUpperCase() + ectx.facility.storageType.slice(1)}-deep racking · ${elev.rackLevels} levels · ${calc.formatFt(elev.aisleWidth)} aisles · ${calc.formatFt(ectx.facility.clearHeight)} clear height`}
      </div>
    </div>
  `;
}

// Deferred: call after DOM is rendered
export function drawElevation(ectx) {
  const canvas = ectx.rootEl?.querySelector('#wsc-elevation-canvas');
  if (!canvas) return;
  const ctx = /** @type {HTMLCanvasElement} */ (canvas).getContext('2d');
  if (!ctx) return;

  // Phase A: route elevation params through mode-aware ectx.facility shape.
  let _sizedDe = null;
  try { _sizedDe = calc.sizeFacility(ectx.toSizingInputs()); } catch {}

  // Phase D (2026-05-05) — branch on ectx._wscElevView. 'shelving' renders a
  // single zoomed shelving bay (uprights + decks + cartons from sized
  // cartonProfile); 'side' falls through to the legacy cross-section.
  if ((ectx._wscElevView || 'side') === 'shelving') {
    drawShelvingBayDetail(ctx, canvas.width, canvas.height, _sizedDe);
    return;
  }

  const w = canvas.width;
  const h = canvas.height;
  const pad = { l: 60, r: 100, t: 40, b: 60 };
  const drawW = w - pad.l - pad.r;
  const drawH = h - pad.t - pad.b;
  const elev = calc.elevationParams(ectx.renderFacility(ectx.facility, _sizedDe));
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
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${aisleW}'`, toX(x + rackD + aisleW / 2), toY(0) + 14);
    x += moduleW + 2;
  }

  // Dock platform
  ctx.fillStyle = '#999';
  ctx.fillRect(toX(-5), toY(0), toX(0) - toX(-5), toY(-4) - toY(0));
  ctx.fillStyle = '#333';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Dock', toX(-2.5), toY(-2));

  // Right-side dimension: clear height
  ectx.drawDimV(ctx, toX(elev.buildingWidth) + 20, toY(elev.clearHeight), toY(0), `${elev.clearHeight}' Clear`);
  // TOS
  const tos = calc.topOfSteelFt(levels);
  if (levels > 0) {
    ectx.drawDimV(ctx, toX(elev.buildingWidth) + 50, toY(tos), toY(0), `${tos.toFixed(1)}' TOS`);
  }

  // Bottom dimension: building width
  ectx.drawDimH(ctx, toX(0), toX(elev.buildingWidth), toY(0) + 40, `${Math.round(elev.buildingWidth)}' Width`);
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
export function shuffledBayLevelOrder(baysPerFace, levels, seed) {
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
    ctx.font = '13px Inter, sans-serif';
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
  const cartonLengthFt = (+ectx.facility.cartonLengthIn || 12) / 12;
  const cartonWidthFt  = (+ectx.facility.cartonWidthIn  || 9) / 12;
  const cartonHin      = (+ectx.facility.cartonHeightIn || 12) / 12;
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
  ctx.font = '9px Inter, sans-serif';
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
  ctx.font = '11px Inter, sans-serif';
  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';

  // Bottom: bay width
  ectx.drawDimH(ctx, toX(0), toX(bayWidthFt), toY(0) + 36, `${bayWidthFt.toFixed(2)} ft bay`);

  // Right: total height
  ectx.drawDimV(ctx, toX(bayWidthFt) + 16, toY(totalHeightFt), toY(0), `${totalHeightFt.toFixed(2)} ft total`);
  // Right: level pitch (one level)
  ectx.drawDimV(ctx, toX(bayWidthFt) + 60, toY(levelHeightFt), toY(0), `${levelHeightFt.toFixed(2)} ft pitch`);

  // Right info panel
  const infoX = toX(bayWidthFt) + 100;
  const infoY = pad.t;
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#6b7280';
  ctx.fillText('CARTON', infoX, infoY);
  ctx.fillStyle = '#111827';
  ctx.fillText(`${(+ectx.facility.cartonLengthIn || 12).toFixed(0)}" × ${(+ectx.facility.cartonWidthIn || 9).toFixed(0)}" × ${(+ectx.facility.cartonHeightIn || 12).toFixed(0)}"`, infoX, infoY + 12);
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

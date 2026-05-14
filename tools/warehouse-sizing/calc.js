/**
 * IES Hub v3 — Warehouse Sizing Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 * Tested with Vitest in Node.js environment.
 *
 * @module tools/warehouse-sizing/calc
 */

// ============================================================
// CONSTANTS & DEFAULTS
// ============================================================

/** Default pallet dimensions in inches */
export const DEFAULTS = {
  palletWidth: 48,
  palletDepth: 40,
  palletHeight: 54,
  beamHeight: 5,
  flueSpace: 3,
  topClearance: 36,
};

/** Default aisle widths by storage type (in feet) */
export const AISLE_WIDTHS = {
  single: 12,
  double: 12,
  bulk: 10,
  carton: 8,
  mix: 11,
};

/** Dock door throughput capacity (pallets/door/day) */
export const DOOR_CAPACITY_PER_DAY = 40;

/** Dock staging area per door in square feet (door + apron + stage lane).
 *  WSC-B1 (2026-04-25): bumped 700 -> 1500. v2 used 1500-2500; 700 was an
 *  understatement that produced unrealistically tight dock SF. 1500 is the
 *  low end of v2's range and matches industry rule-of-thumb for cross-dock
 *  + stage zone per door.
 */
export const DOCK_SF_PER_DOOR = 1500;

/** Support area uplift factor for suggested sqft heuristic */
export const SUPPORT_AREA_UPLIFT = 0.25;

// ============================================================
// STORAGE POSITION CALCULATIONS
// ============================================================

/**
 * Compute the height of a single rack level in feet.
 * @param {Object} [dims]
 * @param {number} [dims.palletHeight] — load height in inches
 * @param {number} [dims.beamHeight] — beam height in inches
 * @param {number} [dims.flueSpace] — flue space in inches
 * @returns {number} level height in feet
 */
export function positionHeightFt(dims = {}) {
  const ph = dims.palletHeight ?? DEFAULTS.palletHeight;
  const bh = dims.beamHeight ?? DEFAULTS.beamHeight;
  const fs = dims.flueSpace ?? DEFAULTS.flueSpace;
  return (ph + bh + fs) / 12;
}

/**
 * Compute usable storage height in feet (clear height minus top clearance).
 * @param {number} clearHeight — building clear height in feet
 * @param {number} [topClearanceIn] — sprinkler clearance in inches
 * @returns {number} usable height in feet
 */
export function usableHeightFt(clearHeight, topClearanceIn) {
  const tc = (topClearanceIn ?? DEFAULTS.topClearance) / 12;
  return Math.max(0, (clearHeight || 0) - tc);
}

/**
 * Compute how many rack levels fit within usable height.
 * @param {number} clearHeight — feet
 * @param {Object} [dims] — pallet dimensions
 * @returns {number} integer rack levels
 */
export function rackLevels(clearHeight, dims = {}) {
  const usable = usableHeightFt(clearHeight, dims.topClearance);
  const levelH = positionHeightFt(dims);
  return levelH > 0 ? Math.floor(usable / levelH) : 0;
}

/**
 * Compute top-of-steel height in feet (rack levels × position height).
 * @param {number} levels
 * @param {Object} [dims]
 * @returns {number}
 */
export function topOfSteelFt(levels, dims = {}) {
  return levels * positionHeightFt(dims);
}

// ============================================================
// ORIENTATION (canonical dock-on-long-edge convention)
// ============================================================

/**
 * Resolve a facility's two-axis footprint into a normalized
 * `{ longFt, shortFt }` pair under the canonical dock-on-long-edge
 * convention used throughout WSC.
 *
 * **Why this exists.** Before WSC-O1 (2026-05-04) the engine, the 2D
 * plan canvas, the elevation canvas, and the 3D Three.js scene each
 * had their own private convention for "which axis is the long one."
 * The plan view force-swapped to landscape (ui.js:1484); the 3D scene
 * mapped raw `buildingWidth -> X axis` with no swap; the elevation
 * mapped raw `buildingWidth -> horizontal section axis`. With portrait
 * inputs (W < D) the three views disagreed on building orientation,
 * the same physical facility rendered 90 degrees rotated between Plan
 * and 3D.
 *
 * **Convention pinned 2026-05-04 (WSC-O1).** Aisles run perpendicular
 * to the dock face, dock sits on the long edge of the building. This
 * matches standard 3PL practice: trucks pull up on the long wall,
 * aisles extend back from the dock into the depth of the building.
 * The calc engine already implemented this convention internally
 * (computeStorage uses `Math.max(W, D)` as its `storageWidth`, the
 * aisle-count axis). What was missing was a single source of truth
 * the rendering surfaces could consume so they all draw the same
 * orientation.
 *
 * **Outputs.** `longFt` is always >= `shortFt`. When the user has
 * supplied only one of width/depth (or neither), this function
 * derives a 1.5:1 landscape footprint from `facility.totalSqft`,
 * matching drawPlan's heuristic at ui.js:1480. When neither dim
 * nor totalSqft is set, both fields return 0.
 *
 * **Convention semantics for consumers:**
 *   Plan view: render longFt horizontal, shortFt vertical, dock face on bottom edge.
 *   Elevation: section cut runs along longFt (horizontal axis of the section drawing).
 *   3D scene: longFt -> world X axis, shortFt -> world Z axis, default camera azimuth frames the long edge.
 *
 * @param {{ buildingWidth?: number, buildingDepth?: number, totalSqft?: number }} facility
 * @returns {{ longFt: number, shortFt: number, derived: boolean }}
 *   `derived` is true when the dimensions came from a totalSqft fallback,
 *   false when the user supplied a real footprint.
 */
export function orientFacility(facility = {}) {
  const wIn = +facility.buildingWidth || 0;
  const dIn = +facility.buildingDepth || 0;
  if (wIn > 0 && dIn > 0) {
    return {
      longFt: Math.max(wIn, dIn),
      shortFt: Math.min(wIn, dIn),
      derived: false,
    };
  }
  // Single-dim or no-dim fallback: derive a 1.5:1 landscape from totalSqft.
  const sqft = +facility.totalSqft || 0;
  if (sqft <= 0) {
    return { longFt: 0, shortFt: 0, derived: true };
  }
  const longFt = Math.round(Math.sqrt(sqft * 1.5));
  const shortFt = longFt > 0 ? Math.round(sqft / longFt) : 0;
  return { longFt, shortFt, derived: true };
}

// ============================================================
// CROSS-AISLE LAYOUT (canonical NFPA / IFC egress rule of thumb)
// ============================================================

/**
 * Default cross-aisle spacing and clear-width by sprinkler / truck class.
 *
 * **Why this exists.** Pre-WSC-X1 (2026-05-04) cross-aisles were a 2D-only
 * visual flourish: drawPlan hardcoded `crossAisleFt = 10, segmentLenFt = 200`
 * locally; the 3D scene didn't render them at all (continuous racks from
 * staging to staging — code-violating in any U.S. jurisdiction); the calc
 * engine applied a flat `STORAGE_LOSS_FACTOR = 1.20` covering "cross-aisles,
 * columns, fire lanes" with no spacing math. Three different mental models.
 *
 * **Convention pinned 2026-05-04 (WSC-X1).** Cross-aisles are transverse
 * aisles that break rack runs into segments so forklifts can turn around
 * and so egress travel distance stays under code. Default: 200 ft segment
 * length (sprinklered, matching IFC Ch.10 max), 10 ft clear width
 * (counterbalance and reach-truck friendly). Future-extensible by
 * sprinkler type and truck class.
 *
 * Defaults (inputs all optional):
 *   sprinklerType = 'ESFR' | 'standard' | 'none' (default 'ESFR')
 *     - 'ESFR'     : 250 ft target between cross-aisles (extended-egress allowed)
 *     - 'standard' : 200 ft (IFC Ch.10 sprinklered max)
 *     - 'none'     : 150 ft (IFC Ch.10 unsprinklered max)
 *   truckClass = 'counterbalance' | 'reach' | 'turret' | 'walkie' (default 'counterbalance')
 *     - 'counterbalance' : 12 ft clear cross-aisle (90-deg turn with load)
 *     - 'reach'          : 10 ft clear
 *     - 'turret'         : 8 ft clear
 *     - 'walkie'         : 8 ft clear
 *
 * @param {{ sprinklerType?: string, truckClass?: string }} [opts]
 * @returns {{ targetSpacingFt: number, clearFt: number, sprinklerType: string, truckClass: string }}
 */
export function crossAisleDefaults(opts = {}) {
  const sprinklerType = opts.sprinklerType || 'ESFR';
  const truckClass = opts.truckClass || 'counterbalance';
  const targetSpacingFt = sprinklerType === 'none' ? 150
    : sprinklerType === 'standard' ? 200
    : 250; // ESFR
  const clearFt = truckClass === 'counterbalance' ? 12
    : truckClass === 'reach' ? 10
    : 8; // turret / walkie / unknown
  return { targetSpacingFt, clearFt, sprinklerType, truckClass };
}

/**
 * Compute a cross-aisle layout for a rack run of length `rackRunLenFt`.
 * Returns segment count, length per segment, and total cross-aisle
 * length consumed. When the run is too short to need a cross-aisle
 * (≤ targetSpacing + clear), returns a single segment with no cross-aisles.
 *
 * Used by:
 *   - drawPlan (ui.js) to render cross-aisle gaps in 2D rack rows
 *   - build3DScene (ui.js) to break rack BoxGeometry into segments
 *   - computeStorage (this file, future) to subtract cross-aisle SF from
 *     achieved position count instead of relying on flat STORAGE_LOSS_FACTOR
 *
 * @param {number} rackRunLenFt — length of a continuous rack aisle in feet
 * @param {{ sprinklerType?: string, truckClass?: string }} [opts]
 * @returns {{
 *   segmentCount: number,
 *   segmentLenFt: number,
 *   crossAisleClearFt: number,
 *   totalCrossAisleFt: number,
 *   targetSpacingFt: number
 * }}
 */
export function crossAisleLayoutFt(rackRunLenFt, opts = {}) {
  const len = Math.max(0, +rackRunLenFt || 0);
  const { targetSpacingFt, clearFt } = crossAisleDefaults(opts);
  if (len <= targetSpacingFt + clearFt) {
    return {
      segmentCount: 1,
      segmentLenFt: len,
      crossAisleClearFt: clearFt,
      totalCrossAisleFt: 0,
      targetSpacingFt,
    };
  }
  const segmentCount = Math.max(1, Math.ceil(len / (targetSpacingFt + clearFt)));
  const totalCrossAisleFt = (segmentCount - 1) * clearFt;
  const segmentLenFt = (len - totalCrossAisleFt) / segmentCount;
  return {
    segmentCount,
    segmentLenFt,
    crossAisleClearFt: clearFt,
    totalCrossAisleFt,
    targetSpacingFt,
  };
}

/**
 * Phase F.11 (2026-05-06) — Render the building's circulation buffer as a
 * concrete, labeled set of cross-aisles + side fire lanes instead of leaving
 * it implicit in the engine's flat 10% circulation factor.
 *
 * **Why this exists.** Pre-F.11, the WSC engine accounted for circulation by
 * inflating `requirementsDriven.totalSfRequired` by a flat 10% factor. The
 * extra footprint then turned into either empty floor (Constraint mode) or
 * extra rack pairs (Design mode `fillMode='fill'` padding). Cross-aisles
 * existed only as gaps between rack segments — invisible to the user, who
 * read them as either bugs or "wasted space." Brock's parked Phase F backlog
 * called this out as the "biggest IE-correctness lift."
 *
 * **What this returns.** A complete circulation-strip layout that the 2D
 * plan canvas + 3D scene can render directly:
 *
 *   - `crossAisles[]` — Y/Z bands BETWEEN rack segments (NFPA-driven, from
 *     `crossAisleLayoutFt`). Each band has `posFt` (centerline position
 *     along the rack run) and `widthFt` (clear width). Renderer paints a
 *     light-gray strip + "CROSS-AISLE" label + travel-direction arrows.
 *
 *   - `sideFireLanes[]` — narrow strips along the LEFT and RIGHT perimeter
 *     of the rack zone (between rack and building wall). Sized to the
 *     `sideMarginFt` already reserved by the rack-placement loop. Renderer
 *     paints a light-gray strip + "FIRE LANE" label.
 *
 *   - `circulationSf` — total square feet visible-circulation accounts for
 *     (cross-aisles × full rack-zone width + 2 × side-fire-lane × rack-run-len).
 *
 *   - `circulationPct` — visible circulation as % of `storageSqft` for HUD.
 *
 *   - `crossAisleSf`, `sideFireLaneSf` — sub-totals for diagnostics.
 *
 * Pure helper. Renderer-agnostic. Same outputs feed 2D canvas + 3D scene
 * so the two views agree on cross-aisle positions.
 *
 * @param {{
 *   rackRunLenFt: number,        // length of the storage run along long edge (after staging)
 *   rackZoneWidthFt: number,     // width of the rack zone along short edge (between side fire lanes)
 *   sideMarginFt?: number,       // 6 ft default — width of left + right fire lanes
 *   storageSqft?: number,        // for circulationPct denominator
 *   sprinklerType?: string,
 *   truckClass?: string,
 * }} opts
 * @returns {{
 *   crossAisles: Array<{ posFt: number, widthFt: number }>,
 *   sideFireLanes: Array<{ side: 'left'|'right', widthFt: number }>,
 *   circulationSf: number,
 *   crossAisleSf: number,
 *   sideFireLaneSf: number,
 *   circulationPct: number,
 *   targetSpacingFt: number,
 *   crossAisleClearFt: number,
 *   sideMarginFt: number,
 * }}
 */
export function circulationLayoutFt(opts = {}) {
  const rackRunLenFt = Math.max(0, +opts.rackRunLenFt || 0);
  const rackZoneWidthFt = Math.max(0, +opts.rackZoneWidthFt || 0);
  const sideMarginFt = opts.sideMarginFt != null ? Math.max(0, +opts.sideMarginFt) : 6;
  const storageSqft = Math.max(0, +opts.storageSqft || 0);

  // Step 1: NFPA cross-aisle layout drives the egress-required cross-aisles.
  const xa = crossAisleLayoutFt(rackRunLenFt, opts);
  const segmentCount = Math.max(1, +xa.segmentCount || 1);
  const clearFt = +xa.crossAisleClearFt || 0;
  const segLenFt = +xa.segmentLenFt || 0;

  /** @type {Array<{ posFt:number, widthFt:number }>} */
  const crossAisles = [];
  // Cross-aisle centerlines: between consecutive segments. With S segments
  // there are (S-1) cross-aisles. posFt = distance along the rack run from
  // the rack-zone start to the cross-aisle centerline.
  let runFt = 0;
  for (let i = 0; i < segmentCount - 1; i++) {
    runFt += segLenFt; // end of segment i
    const posFt = runFt + clearFt / 2;
    crossAisles.push({ posFt, widthFt: clearFt });
    runFt += clearFt;  // skip the cross-aisle band
  }

  // Step 2: side fire lanes (LEFT + RIGHT perimeter strips).
  /** @type {Array<{ side:'left'|'right', widthFt:number }>} */
  const sideFireLanes = sideMarginFt > 0
    ? [
        { side: 'left',  widthFt: sideMarginFt },
        { side: 'right', widthFt: sideMarginFt },
      ]
    : [];

  // Step 3: aggregate SF.
  const crossAisleSf = (segmentCount - 1) * clearFt * rackZoneWidthFt;
  const sideFireLaneSf = sideFireLanes.length * sideMarginFt * rackRunLenFt;
  const circulationSf = crossAisleSf + sideFireLaneSf;
  const circulationPct = storageSqft > 0
    ? Math.round((circulationSf / storageSqft) * 1000) / 10
    : 0;

  return {
    crossAisles,
    sideFireLanes,
    circulationSf,
    crossAisleSf,
    sideFireLaneSf,
    circulationPct,
    targetSpacingFt: +xa.targetSpacingFt || 0,
    crossAisleClearFt: clearFt,
    sideMarginFt,
  };
}

/**
 * Phase F.11 (2026-05-06) — Compute IE-correct structural parameters for
 * Forward Pick rendering. Pre-F.11, the FP zone in 3D was a flat 10-ft
 * purple box with no internal detail — read as a placeholder, not a real
 * pick area. Brock's parked Phase F backlog called for "structural detail
 * polish."
 *
 * **What this returns.** Geometry the 3D scene needs to draw a real
 * forward-pick area: number of active pick faces, lane count, rack-style
 * structural levels, and a few derived dimensions:
 *
 *   - `activeFaces` — `round(skuCount × velocityTierAPct / 100)`. The SKUs
 *     that get a dedicated forward-pick face (rest are picked from reserve).
 *
 *   - `levels` — number of horizontal load levels in the FP zone:
 *     - 'carton_flow' : 3 levels (2 pick + 1 replen)
 *     - 'light_case'  : 4 levels (taller shelves, all pickable)
 *     - 'heavy_case'  : 4 levels (2 pick at bottom + 2 reserve pallets above)
 *
 *   - `pickLevels` — number of levels actually pickable (not replen/reserve).
 *
 *   - `bayWidthFt` — pick-face width along the building width:
 *     - 'carton_flow' : 4 ft (standard carton-flow lane)
 *     - 'light_case'  : 3 ft (standard shelving bay)
 *     - 'heavy_case'  : 4.33 ft (selective rack, GMA pallet)
 *
 *   - `levelHeightFt` — vertical pitch between levels.
 *
 *   - `totalHeightFt` — total height of the FP rack structure (= levels × pitch).
 *
 *   - `bays` — number of bays that fit along the FP zone width (= floor(fpWidthFt / bayWidthFt)).
 *
 *   - `cartonsPerFace` — visual replen depth for renderer (capped 1..6).
 *
 * Pure helper. Renderer-agnostic. UI computes the fp footprint dimensions
 * and passes them in; calc returns the structural decomposition.
 *
 * @param {{
 *   type?: 'carton_flow'|'light_case'|'heavy_case',
 *   skuCount?: number,
 *   velocityTierAPct?: number,
 *   daysInventory?: number,
 *   fpWidthFt?: number,
 *   fpDepthFt?: number,
 * }} opts
 * @returns {{
 *   type: string,
 *   activeFaces: number,
 *   levels: number,
 *   pickLevels: number,
 *   bayWidthFt: number,
 *   levelHeightFt: number,
 *   totalHeightFt: number,
 *   bays: number,
 *   cartonsPerFace: number,
 * }}
 */
export function forwardPickStructure(opts = {}) {
  const type = (opts.type === 'light_case' || opts.type === 'heavy_case')
    ? opts.type
    : 'carton_flow';
  const skuCount = Math.max(0, +opts.skuCount || 0);
  const velocityTierAPct = Math.max(0, Math.min(100, +opts.velocityTierAPct || 0));
  const daysInventory = Math.max(0, +opts.daysInventory || 0);
  const fpWidthFt = Math.max(0, +opts.fpWidthFt || 0);

  // Per-type geometry constants (industry standard FP designs).
  const TYPE_PARAMS = {
    carton_flow: { levels: 3, pickLevels: 2, bayWidthFt: 4,    levelHeightFt: 3.5 },
    light_case:  { levels: 4, pickLevels: 4, bayWidthFt: 3,    levelHeightFt: 2.0 },
    heavy_case:  { levels: 4, pickLevels: 2, bayWidthFt: 4.33, levelHeightFt: 4.5 },
  };
  const p = TYPE_PARAMS[type];

  const activeFaces = Math.round(skuCount * velocityTierAPct / 100);
  const bays = fpWidthFt > 0 ? Math.max(0, Math.floor(fpWidthFt / p.bayWidthFt)) : 0;
  const totalHeightFt = p.levels * p.levelHeightFt;
  // Replen-depth heuristic (visual): 1 carton minimum, scaled by daysInventory.
  // Capped so the renderer doesn't try to draw a 30-deep stack.
  const cartonsPerFace = Math.max(1, Math.min(6, Math.round(daysInventory)));

  return {
    type,
    activeFaces,
    levels: p.levels,
    pickLevels: p.pickLevels,
    bayWidthFt: p.bayWidthFt,
    levelHeightFt: p.levelHeightFt,
    totalHeightFt,
    bays,
    cartonsPerFace,
  };
}

// ============================================================
// 3D RENDERED FACTS — achieved-vs-target accounting (P0-2)
// ============================================================
// Brock's complaint (audit doc Lens I): "we don't have a count of the
// locations by storage type actually achieved in the rendering, these
// counts should be dynamic to capture any tweaks the user makes."
//
// The 3D rack-placement loop knows exactly how many rack pairs and segments
// it painted, but never reports back. Dashboard reads `sized.positions.*`
// (engine-derived target) and the 3D scene quietly under-fills when the
// footprint is too small — discrepancy invisible.
//
// `rackPairCapacity` converts one placed segment of one rack pair into
// position count. `rollupRenderedFacts` aggregates an array of segment
// records (one per Mesh placed in build3DScene) into a {byType, totals,
// vs target} struct that can be painted as a HUD over the canvas.

/** Standard pallet bay width in feet (52 inches incl. flue). */
export const PALLET_BAY_WIDTH_FT = 4.33;
/** Standard shelving bay width in feet (36 inches). */
export const SHELVING_BAY_WIDTH_FT = 3;

/**
 * Capacity of a single placed rack pair (2 rack faces sharing one aisle)
 * for one segment of length `segmentLenFt`. Each face holds bays packed
 * along its length; each bay holds 1 selective pallet (or 1 shelf
 * location for shelving) per level.
 *
 * @param {{ segmentLenFt:number, levels:number, bayWidthFt?:number }} opts
 * @returns {{ baysPerFace:number, baysTotal:number, positions:number }}
 */
export function rackPairCapacity(opts = {}) {
  const len = +opts.segmentLenFt;
  const lv  = +opts.levels;
  const bw  = +opts.bayWidthFt > 0 ? +opts.bayWidthFt : PALLET_BAY_WIDTH_FT;
  if (!(len > 0) || !(lv > 0)) return { baysPerFace: 0, baysTotal: 0, positions: 0 };
  const baysPerFace = Math.floor(len / bw);
  const baysTotal = baysPerFace * 2;
  return { baysPerFace, baysTotal, positions: baysTotal * lv };
}

/**
 * Roll up the geometry actually placed by the 3D scene into achieved counts
 * by storage type, with a delta vs the engine's sized target.
 *
 * Each entry in `placedRacks` represents ONE rack-pair x ONE cross-aisle
 * segment that was painted as Mesh objects. Caller pushes one record per
 * BoxGeometry pair drawn:
 *   {
 *     typeKey: 'fullPallet' | 'cartonPallet' | 'shelving',
 *     colKey:  number,           // unique per rack-pair (mx index)
 *     segmentLenFt: number,      // segment length post cross-aisle split
 *     levels:  number,           // rack levels (or shelf levels) for this type
 *     bayWidthFt?: number,       // optional override (4.33 pallet / 3 shelving)
 *   }
 *
 * @param {Array} placedRacks
 * @param {{ positions?: Object }} sized — output of sizeFacility (for targets)
 * @returns {{
 *   byType: Record<string,{columns:number,segments:number,bays:number,positions:number}>,
 *   totalColumns:number,
 *   totalSegments:number,
 *   totalBays:number,
 *   totalPositions:number,
 *   targets: { fullPallet:number, cartonPallet:number, shelving:number, total:number },
 *   deltaPct: number,
 *   status: 'on_target' | 'under_built' | 'over_built'
 * }}
 */
export function rollupRenderedFacts(placedRacks, sized = {}) {
  /** @type {Record<string,{columns:number,segments:number,bays:number,positions:number}>} */
  const byType = {
    fullPallet:   { columns: 0, segments: 0, bays: 0, positions: 0 },
    cartonPallet: { columns: 0, segments: 0, bays: 0, positions: 0 },
    shelving:     { columns: 0, segments: 0, bays: 0, positions: 0 },
  };
  /** @type {Record<string,Set<number>>} */
  const colSeen = { fullPallet: new Set(), cartonPallet: new Set(), shelving: new Set() };
  for (const r of (placedRacks || [])) {
    const bucket = byType[r?.typeKey];
    if (!bucket) continue;
    const cap = rackPairCapacity({
      segmentLenFt: r.segmentLenFt,
      levels: r.levels,
      bayWidthFt: r.bayWidthFt,
    });
    bucket.segments += 1;
    bucket.bays += cap.baysTotal;
    bucket.positions += cap.positions;
    if (r.colKey != null) colSeen[r.typeKey].add(r.colKey);
  }
  byType.fullPallet.columns   = colSeen.fullPallet.size;
  byType.cartonPallet.columns = colSeen.cartonPallet.size;
  byType.shelving.columns     = colSeen.shelving.size;

  const totalPositions = byType.fullPallet.positions + byType.cartonPallet.positions + byType.shelving.positions;
  const totalSegments  = byType.fullPallet.segments + byType.cartonPallet.segments + byType.shelving.segments;
  const totalBays      = byType.fullPallet.bays + byType.cartonPallet.bays + byType.shelving.bays;
  const totalColumns   = byType.fullPallet.columns + byType.cartonPallet.columns + byType.shelving.columns;

  // Targets: prefer per-type GROSS positions (honeycomb + surge applied,
  // sums to grossPositions) so per-row achieved/target comparisons are
  // dimensionally consistent with the total. Falls back to RAW per-type
  // values for older sized payloads that don't carry the gross fields.
  const positionsT = sized?.positions || {};
  const _hasGross = (positionsT.fullPalletGrossPositions != null);
  const targets = _hasGross ? {
    fullPallet:   +positionsT.fullPalletGrossPositions   || 0,
    cartonPallet: +positionsT.cartonPalletGrossPositions || 0,
    shelving:     +positionsT.shelvingGrossPositions     || 0,
    total:        +positionsT.grossPositions             || 0,
  } : {
    fullPallet:   +positionsT.fullPalletPositions   || 0,
    cartonPallet: +positionsT.cartonPalletPositions || 0,
    shelving:     +positionsT.shelvingPositions     || 0,
    total:        +positionsT.grossPositions        || 0,
  };
  // If grossPositions is zero (engine had no input), fall back to summing
  // designed type counts so the HUD still has a denominator.
  if (targets.total === 0) {
    targets.total = targets.fullPallet + targets.cartonPallet + targets.shelving;
  }

  const deltaPct = targets.total > 0
    ? Math.round(((totalPositions - targets.total) / targets.total) * 1000) / 10
    : 0;
  /** @type {'on_target'|'under_built'|'over_built'} */
  let status = 'on_target';
  if (targets.total > 0) {
    if (totalPositions < targets.total * 0.95) status = 'under_built';
    else if (totalPositions > targets.total * 1.05) status = 'over_built';
  }

  return {
    byType,
    totalColumns,
    totalSegments,
    totalBays,
    totalPositions,
    targets,
    deltaPct,
    status,
  };
}

/**
 * Decide how many rack-pair "col faces" to allocate per storage type so the
 * 3D scene's rendered position counts match the engine's per-type GROSS
 * targets (instead of being driven by inventory-unit mix percentages, which
 * massively over-fills shelving because shelving bays are 1.4× denser than
 * pallet bays and shelving levels typically exceed pallet levels).
 *
 * Each module placed in the rack-placement loop adds ONE back-to-back rack
 * pair = 2 col faces = 2 to `totalCols`. So col counts are always even and
 * pair count = cols / 2.
 *
 * @param {{
 *   totalCols: number,                  // available col faces (always even)
 *   segmentLensFt: number[],            // master plan segment lengths (after cross-aisle splits)
 *   palletLevels: number,
 *   shelvingLevels: number,
 *   fullPalletTarget: number,           // sized.positions.fullPalletGrossPositions
 *   cartonPalletTarget: number,         // sized.positions.cartonPalletGrossPositions
 *   shelvingTarget: number,             // sized.positions.shelvingGrossPositions
 * }} opts
 * @returns {{
 *   fullPalletCols: number,             // even — share of totalCols routed to FP
 *   cartonPalletCols: number,           // even
 *   shelvingCols: number,               // even
 *   unusedCols: number,                 // even — leftover (over-built building)
 *   palletPosPerPair: number,           // diagnostic — positions a single FP/CP rack-pair holds across all master segments
 *   shelvingPosPerPair: number,         // diagnostic
 *   mode: 'over_built' | 'under_built' | 'exact_fit',
 * }}
 */
export function allocateRackColsByTarget(opts = {}) {
  const totalColFaces = Math.max(0, +opts.totalCols || 0);
  const segs = Array.isArray(opts.segmentLensFt) ? opts.segmentLensFt : [];
  const palletLevels   = Math.max(1, +opts.palletLevels   || 5);
  const shelvingLevels = Math.max(1, +opts.shelvingLevels || 5);
  const fpTarget = Math.max(0, +opts.fullPalletTarget   || 0);
  const cpTarget = Math.max(0, +opts.cartonPalletTarget || 0);
  const shTarget = Math.max(0, +opts.shelvingTarget     || 0);
  // Phase F (2026-05-05) — fillMode option. Default 'target' = legacy
  // break-on-per-type-exhaustion behavior (Constraint mode + shrink-CTA
  // need leftover-as-slack to fire the right-size suggestion). New 'fill'
  // mode pads remaining unused pairs proportionally across the three
  // types so the rack zone is visually full. Used by Design mode where
  // leftover floor reads as a bug, not engineered slack.
  const fillMode = (opts.fillMode === 'fill') ? 'fill' : 'target';

  // Positions a single back-to-back rack-pair holds across every master segment.
  // (rackPairCapacity per segment, summed.)
  let palletPosPerPair = 0;
  let shelvingPosPerPair = 0;
  for (const segLen of segs) {
    if (!(segLen > 0)) continue;
    palletPosPerPair   += Math.floor(segLen / PALLET_BAY_WIDTH_FT)   * 2 * palletLevels;
    shelvingPosPerPair += Math.floor(segLen / SHELVING_BAY_WIDTH_FT) * 2 * shelvingLevels;
  }

  const totalPairs = Math.floor(totalColFaces / 2);

  // Pairs that get closest to each target (round-to-nearest beats ceil
  // because per-pair capacity is coarse — one shelving pair can hold
  // thousands of positions, so ceil systematically overshoots small
  // targets like a 4k shelving budget). If a non-zero target rounds to
  // zero pairs we floor at 1 so the type still shows up in the scene.
  function _pairsFor(target, posPerPair) {
    if (!(posPerPair > 0) || !(target > 0)) return 0;
    return Math.max(1, Math.round(target / posPerPair));
  }
  let fpPairs = _pairsFor(fpTarget, palletPosPerPair);
  let cpPairs = _pairsFor(cpTarget, palletPosPerPair);
  let shPairs = _pairsFor(shTarget, shelvingPosPerPair);

  const wantPairs = fpPairs + cpPairs + shPairs;

  /** @type {'over_built'|'under_built'|'exact_fit'} */
  let mode;
  if (wantPairs > totalPairs) {
    // Building can't hold the desired capacity — scale per-type pair
    // counts proportionally so they fit. Rendered HUD will show
    // 'under_built' status and the user knows to grow the building.
    mode = 'under_built';
    if (wantPairs > 0) {
      fpPairs = Math.floor(fpPairs * totalPairs / wantPairs);
      cpPairs = Math.floor(cpPairs * totalPairs / wantPairs);
      shPairs = Math.max(0, totalPairs - fpPairs - cpPairs);
    } else {
      fpPairs = cpPairs = shPairs = 0;
    }
  } else if (wantPairs === totalPairs) {
    mode = 'exact_fit';
  } else {
    mode = 'over_built';
  }

  // Phase F (2026-05-05) — pad-to-fill in 'fill' mode. After the target-
  // driven allocation, if leftover pairs exist (mode === 'over_built'),
  // distribute them ONE PAIR AT A TIME to whichever type has the lowest
  // achievement percentage relative to its target. This greedy approach
  // ensures all three types converge toward equal achievement-% rather
  // than over-padding the largest target while leaving shelving short.
  // (Phase F.1's first-cut proportional-to-target padding under-served
  // shelving because shelvingPosPerPair >> palletPosPerPair, making
  // shelving's "fair share" of leftover pairs round to ~0.)
  if (fillMode === 'fill' && mode === 'over_built') {
    let leftover = totalPairs - (fpPairs + cpPairs + shPairs);
    while (leftover > 0) {
      // Achievement % per type. Use Infinity for zero-target types so
      // they never win the leftover pair (no need to over-allocate types
      // the engine deemed unnecessary).
      const fpAch = fpTarget > 0 ? (fpPairs * palletPosPerPair) / fpTarget : Infinity;
      const cpAch = cpTarget > 0 ? (cpPairs * palletPosPerPair) / cpTarget : Infinity;
      const shAch = shTarget > 0 ? (shPairs * shelvingPosPerPair) / shTarget : Infinity;
      // Assign next pair to the lowest-achievement type. Ties broken by
      // largest target (FP > CP > Shelving in typical 3PL profiles).
      const min = Math.min(fpAch, cpAch, shAch);
      if (!Number.isFinite(min)) break; // all targets zero — bail
      if (fpAch === min) fpPairs += 1;
      else if (cpAch === min) cpPairs += 1;
      else shPairs += 1;
      leftover -= 1;
    }
    if (totalPairs - (fpPairs + cpPairs + shPairs) === 0) mode = 'exact_fit';
  }

  const unusedPairs = Math.max(0, totalPairs - fpPairs - cpPairs - shPairs);

  return {
    fullPalletCols:   fpPairs * 2,
    cartonPalletCols: cpPairs * 2,
    shelvingCols:     shPairs * 2,
    unusedCols:       unusedPairs * 2,
    palletPosPerPair,
    shelvingPosPerPair,
    mode,
  };
}

/**
 * Suggest a smaller building footprint that just-fits the inventory when the
 * current footprint is over-built. Used by the 2D plan over-built CTA banner.
 *
 * Holds depth fixed (master segment plan unchanged) and shrinks width to the
 * minimum that holds `usedCols / 2` rack-pair modules + side margins + a
 * small safety pad (so the allocator doesn't trim by 1 due to fence-post).
 *
 * @param {{
 *   totalCols: number,         // current building's totalCols (face units)
 *   usedCols: number,          // cols actually placed (sum of fp+cp+sh from allocateRackColsByTarget)
 *   moduleFt: number,          // 2 * rackDepthFt + aisleFt
 *   sideMarginFt?: number,     // 6 ft default
 *   safetyPadFt?: number,      // 6 ft default
 *   currentWidthFt: number,
 *   currentDepthFt: number,
 *   minOversizePctToRecommend?: number,  // suppress recommendation under this delta (default 5%)
 * }} opts
 * @returns {{
 *   recommended: boolean,
 *   currentWidthFt?: number, suggestedWidthFt?: number,
 *   currentDepthFt?: number, suggestedDepthFt?: number,
 *   oversizePct?: number,
 * }}
 */
export function suggestedBuildingDimensions(opts = {}) {
  const totalCols = +opts.totalCols || 0;
  const usedCols  = +opts.usedCols  || 0;
  const moduleFt  = +opts.moduleFt  || 0;
  const sideMarginFt = opts.sideMarginFt != null ? +opts.sideMarginFt : 6;
  const safetyPadFt  = opts.safetyPadFt  != null ? +opts.safetyPadFt  : 6;
  const currentWidthFt = +opts.currentWidthFt || 0;
  const currentDepthFt = +opts.currentDepthFt || 0;
  const minPct = opts.minOversizePctToRecommend != null ? +opts.minOversizePctToRecommend : 5;

  if (totalCols <= 0 || usedCols >= totalCols || moduleFt <= 0 || currentWidthFt <= 0) {
    return { recommended: false };
  }
  const usedPairs = Math.ceil(usedCols / 2);
  const rackWidthFt = Math.max(0, usedPairs * moduleFt + 2 * sideMarginFt + safetyPadFt);
  // Building must also hold the non-storage zones (dock, office, staging,
  // forward-pick, etc.) — pre-fix the suggestion only counted rack-col
  // width, leaving the building under-sized for total SF on dock-heavy
  // demos. minTotalSqft caller passes sized.totalSqft so the suggestion
  // honors the full facility footprint with depth held fixed.
  const minTotalSqft = +opts.minTotalSqft || 0;
  const totalSqftWidthFt = (minTotalSqft > 0 && opts.currentDepthFt > 0)
    ? Math.ceil(minTotalSqft / +opts.currentDepthFt)
    : 0;
  const minWidthFt = Math.max(rackWidthFt, totalSqftWidthFt);
  // Round up to a clean 10-ft increment.
  const suggestedWidthFt = Math.ceil(minWidthFt / 10) * 10;
  if (suggestedWidthFt >= currentWidthFt) return { recommended: false };
  const oversizePct = Math.round(((currentWidthFt - suggestedWidthFt) / currentWidthFt) * 100);
  return {
    recommended: oversizePct >= minPct,
    currentWidthFt,
    suggestedWidthFt,
    currentDepthFt,
    suggestedDepthFt: currentDepthFt,
    oversizePct,
  };
}

// ============================================================
// IE-CORRECT UNIT LOAD + CARTON + SHELVING + RACKING + DOCK
// ============================================================
// Phase 1 of the WSC redesign (2026-05-04). Six pure helpers that
// model warehouse sizing from a real industrial-engineering / AutoCAD
// perspective:
//
//   1. computeUnitLoad         — pallet-driven bay width / rack depth / level pitch
//   2. computeCartonProfile    — ti×hi cartons-per-pallet + cartons-per-shelf
//   3. computeShelvingLocations — demand-bound vs sku-bound (max wins)
//   4. computeRackingStructure — beam rows w/ no-top-beam + bottom-beam toggle
//   5. computeDockRequirement  — door count from peak truck arrivals × dwell
//   6. computeRequiredFacilitySF — full critical-path facility SF aggregation
//
// All ADDITIVE — no existing exports were modified. sizeFacility wires
// the helpers in additively so sized.unitLoad, sized.cartonProfile,
// sized.locations, sized.rackingStructure, sized.dockRequirement, and
// sized.requirementsDriven appear on the result alongside the legacy
// fields. UI / rendering are not touched in Phase 1.

/**
 * Standard pallet type catalog. Dimensions in inches.
 *
 * GMA (48×40)  — North American grocery / consumer goods standard. Most common.
 * CHEP (48×40) — pooled rental, dimensionally identical to GMA, blue color.
 * Euro (1200×800mm = ~47.2×31.5 in) — European standard.
 * EuroHalf (800×600mm) — half-Euro pallet.
 * Custom — user-supplied dimensions (palletL/palletW must be provided).
 */
export const PALLET_TYPES = {
  GMA:      { palletLengthIn: 48,   palletWidthIn: 40 },
  CHEP:     { palletLengthIn: 48,   palletWidthIn: 40 },
  Euro:     { palletLengthIn: 47.2, palletWidthIn: 31.5 },
  EuroHalf: { palletLengthIn: 31.5, palletWidthIn: 23.6 },
};

/**
 * Per-pallet inter-pallet + outboard clearance budget for selective rack
 * (in inches). Real selective rack: 4" outboard between upright and pallet
 * on each side + 4" between adjacent pallets in the same bay = 12" total
 * across a 2-pallet bay.
 *
 * Source: Steel King / Ridg-U-Rak / Mecalux selective-rack handbook
 * conventions. Common production specs are 4", 6", and 8" depending on
 * stock-keeping practices; 4" is tight but workable for tight-tolerance
 * GMA pallets.
 */
export const PALLET_BAY_INTERIOR_CLEARANCE_IN = 12;

/**
 * Standard front overhang of a pallet beyond the upright face (inches).
 * The pallet sits with its leading edge proud of the upright by 3" so
 * forklift forks can engage cleanly without striking steel.
 */
export const PALLET_FRONT_OVERHANG_IN = 3;

/**
 * Standard flue space between back-to-back rack rows (inches). Required
 * for sprinkler in-rack flow path on pallet rack > 25 ft tall.
 */
export const BACK_TO_BACK_FLUE_IN = 6;

/**
 * Beam-to-load vertical clearance (inches). The space between the top of
 * a stored pallet load and the underside of the beam at the next level up.
 * 6" is the IE convention for selective rack; tighter (3-4") is possible
 * with disciplined operators but raises beam-strike risk.
 */
export const BEAM_TO_LOAD_CLEARANCE_IN = 6;

/**
 * Beam structural height (inches). Typical 4" or 5" step-beam. 5" is the
 * IE conservative default for capacity-loaded rack.
 */
export const BEAM_HEIGHT_IN = 5;

/**
 * Compute unit-load (pallet) geometry from pallet dimensions and load
 * profile. This is the IE-correct selective-rack bay sizing — bay width
 * holds 2 pallets per crossbeam (real selective convention), not 1 per
 * bay as the legacy `PALLET_BAY_WIDTH_FT = 4.33` constant implied (4.33 ft
 * = single-pallet half-bay).
 *
 * **Bay width math.** 2 × pallet length (along beam) + interior clearance
 * budget (4" outboard each side + 4" between pallets = 12" total).
 *   GMA 48×40:  2 × 48 + 12 = 108 in = 9.00 ft
 *   Euro 47.2×31.5: 2 × 47.2 + 12 = 106.4 in = 8.87 ft
 *
 * **Rack depth math.** Pallet width (perpendicular to beam) plus 6" flue
 * (back-to-back sprinkler clearance) plus 3" front overhang each side.
 *   Single-deep: pallet_width + 6" overhang (front + back face) — 40 + 6 = 46 in
 *   Back-to-back pair: 2 × single-deep + flue = 2 × 46 + 6 = 98 in = 8.17 ft
 *
 * **Level pitch math.** Load height + pallet base + beam height + clearance.
 *   GMA 60" load + 6" pallet + 5" beam + 6" clearance = 77 in = 6.42 ft per level.
 *
 * @param {{
 *   palletType?: 'GMA'|'CHEP'|'Euro'|'EuroHalf'|'Custom',
 *   palletLengthIn?: number,    // override; required when palletType='Custom'
 *   palletWidthIn?: number,     // override; required when palletType='Custom'
 *   loadHeightIn?: number,      // height of the load above the pallet base (default 60")
 *   palletHeightIn?: number,    // pallet base thickness (default 6")
 *   maxGrossWeightLb?: number,  // informational, drives MHE class downstream (default 2000)
 *   beamHeightIn?: number,      // override structural beam height (default 5")
 *   beamToLoadClearanceIn?: number, // override (default 6")
 *   flueIn?: number,            // back-to-back flue (default 6")
 *   bayClearanceIn?: number,    // override (default 12 = 4+4+4)
 * }} [opts]
 * @returns {{
 *   palletType: string,
 *   palletLengthIn: number,
 *   palletWidthIn: number,
 *   loadHeightIn: number,
 *   palletHeightIn: number,
 *   bayWidthFt: number,            // 2-pallet bay (real selective)
 *   bayWidthIn: number,
 *   palletsPerBay: 2,              // always 2 for selective; 1 for narrow / VNA single-pallet
 *   rackDepthSingleFt: number,     // one-side rack row depth
 *   rackDepthBackToBackFt: number, // both rows + flue
 *   palletLevelHeightFt: number,   // vertical pitch per level
 *   palletLevelsAt30FtClear: number, // floor-cap at 30' clear (typical Class III)
 *   maxGrossWeightLb: number,
 * }}
 */
export function computeUnitLoad(opts = {}) {
  const palletType = opts.palletType || 'GMA';
  let palletLengthIn = +opts.palletLengthIn || 0;
  let palletWidthIn  = +opts.palletWidthIn  || 0;
  if (palletLengthIn <= 0 || palletWidthIn <= 0) {
    const preset = PALLET_TYPES[palletType];
    if (preset) {
      if (palletLengthIn <= 0) palletLengthIn = preset.palletLengthIn;
      if (palletWidthIn  <= 0) palletWidthIn  = preset.palletWidthIn;
    }
  }
  if (palletLengthIn <= 0) palletLengthIn = PALLET_TYPES.GMA.palletLengthIn;
  if (palletWidthIn  <= 0) palletWidthIn  = PALLET_TYPES.GMA.palletWidthIn;

  const loadHeightIn   = +opts.loadHeightIn   > 0 ? +opts.loadHeightIn   : 60;
  const palletHeightIn = +opts.palletHeightIn > 0 ? +opts.palletHeightIn : 6;
  const beamHeightIn   = +opts.beamHeightIn   > 0 ? +opts.beamHeightIn   : BEAM_HEIGHT_IN;
  const beamClearIn    = +opts.beamToLoadClearanceIn > 0 ? +opts.beamToLoadClearanceIn : BEAM_TO_LOAD_CLEARANCE_IN;
  const flueIn         = +opts.flueIn > 0 ? +opts.flueIn : BACK_TO_BACK_FLUE_IN;
  const bayClearIn     = +opts.bayClearanceIn > 0 ? +opts.bayClearanceIn : PALLET_BAY_INTERIOR_CLEARANCE_IN;
  const maxGrossWeightLb = +opts.maxGrossWeightLb > 0 ? +opts.maxGrossWeightLb : 2000;

  const bayWidthIn = 2 * palletLengthIn + bayClearIn;
  const bayWidthFt = bayWidthIn / 12;
  const rackDepthSingleFt = (palletWidthIn + 2 * PALLET_FRONT_OVERHANG_IN) / 12;
  const rackDepthBackToBackFt = 2 * rackDepthSingleFt + flueIn / 12;
  const palletLevelHeightFt = (loadHeightIn + palletHeightIn + beamHeightIn + beamClearIn) / 12;
  const palletLevelsAt30FtClear = palletLevelHeightFt > 0
    ? Math.max(1, Math.floor(30 / palletLevelHeightFt))
    : 0;

  return {
    palletType,
    palletLengthIn,
    palletWidthIn,
    loadHeightIn,
    palletHeightIn,
    bayWidthFt,
    bayWidthIn,
    palletsPerBay: 2,
    rackDepthSingleFt,
    rackDepthBackToBackFt,
    palletLevelHeightFt,
    palletLevelsAt30FtClear,
    maxGrossWeightLb,
  };
}

/**
 * Compute carton profile from carton dimensions and a unit-load reference.
 * Returns ti×hi cartons-per-pallet and cartons-per-shelf at the chosen
 * orientation.
 *
 * **ti×hi math.** ti = floor(palletL / cartonL) × floor(palletW / cartonW)
 * (cartons that tile the pallet footprint in one layer); hi = floor(loadHeight
 * / cartonH) (layers stacked to load height). cartons-per-pallet = ti × hi.
 *
 *   12×9×12 carton on GMA 48×40 with 60" load:
 *     ti = floor(48/12) × floor(40/9) = 4 × 4 = 16
 *     hi = floor(60/12) = 5
 *     cartons-per-pallet = 80
 *
 * **Cartons-per-shelf.** Depends on shelving bay dimensions and orientation.
 *   L-along-rack: floor(bay_width_in / carton_L) × floor(deck_depth_in / carton_W)
 *   W-along-rack: floor(bay_width_in / carton_W) × floor(deck_depth_in / carton_L)
 *
 * **Shelf level pitch.** Carton height + 2" clearance.
 *   12" carton → 14" pitch → 6 levels in 84" of usable shelf height.
 *
 * @param {{
 *   cartonLengthIn?: number,        // default 12
 *   cartonWidthIn?: number,         // default 9
 *   cartonHeightIn?: number,        // default 12
 *   palletLengthIn?: number,        // for ti — defaults from unitLoad.palletLengthIn or 48
 *   palletWidthIn?: number,         // for ti — defaults from unitLoad.palletWidthIn or 40
 *   loadHeightIn?: number,          // for hi — defaults from unitLoad.loadHeightIn or 60
 *   shelfBayWidthFt?: number,       // default 3 (36 in)
 *   shelfDeckDepthIn?: number,      // default 24 (industry standard for case-pick shelving)
 *   orientation?: 'L-along-rack'|'W-along-rack',
 *   shelfClearanceIn?: number,      // beam-to-carton vertical clearance (default 2)
 *   cartonsPerPalletOverride?: number,  // user-engineered override (e.g., from slotting study)
 * }} [opts]
 * @returns {{
 *   cartonLengthIn: number,
 *   cartonWidthIn: number,
 *   cartonHeightIn: number,
 *   palletLengthIn: number,
 *   palletWidthIn: number,
 *   loadHeightIn: number,
 *   ti: number,                 // cartons per pallet layer
 *   hi: number,                 // pallet layers
 *   cartonsPerPallet: number,
 *   cartonsPerPalletOverride: boolean,
 *   orientation: 'L-along-rack'|'W-along-rack',
 *   shelfBayWidthFt: number,
 *   shelfDeckDepthIn: number,
 *   cartonsPerShelfAcross: number,  // along bay width
 *   cartonsPerShelfDeep: number,    // along deck depth
 *   cartonsPerShelf: number,
 *   shelfLevelHeightFt: number,
 *   shelfLevelsAt84In: number,      // levels that fit in 84" of usable shelf height
 * }}
 */
export function computeCartonProfile(opts = {}) {
  const cartonLengthIn = +opts.cartonLengthIn > 0 ? +opts.cartonLengthIn : 12;
  const cartonWidthIn  = +opts.cartonWidthIn  > 0 ? +opts.cartonWidthIn  : 9;
  const cartonHeightIn = +opts.cartonHeightIn > 0 ? +opts.cartonHeightIn : 12;
  const palletLengthIn = +opts.palletLengthIn > 0 ? +opts.palletLengthIn : 48;
  const palletWidthIn  = +opts.palletWidthIn  > 0 ? +opts.palletWidthIn  : 40;
  const loadHeightIn   = +opts.loadHeightIn   > 0 ? +opts.loadHeightIn   : 60;
  const shelfBayWidthFt = +opts.shelfBayWidthFt > 0 ? +opts.shelfBayWidthFt : 3;
  const shelfDeckDepthIn = +opts.shelfDeckDepthIn > 0 ? +opts.shelfDeckDepthIn : 24;
  const orientation = opts.orientation === 'W-along-rack' ? 'W-along-rack' : 'L-along-rack';
  const shelfClearanceIn = +opts.shelfClearanceIn > 0 ? +opts.shelfClearanceIn : 2;
  const overrideRaw = +opts.cartonsPerPalletOverride;
  const useOverride = overrideRaw > 0;

  // ti×hi
  const ti = Math.max(0,
    Math.floor(palletLengthIn / cartonLengthIn) *
    Math.floor(palletWidthIn  / cartonWidthIn));
  const hi = Math.max(0, Math.floor(loadHeightIn / cartonHeightIn));
  const cartonsPerPalletDerived = ti * hi;
  const cartonsPerPallet = useOverride ? Math.round(overrideRaw) : cartonsPerPalletDerived;

  // Cartons-per-shelf (orientation-aware)
  const bayWidthIn = shelfBayWidthFt * 12;
  let acrossLenIn, deepLenIn;
  if (orientation === 'L-along-rack') {
    acrossLenIn = cartonLengthIn;
    deepLenIn   = cartonWidthIn;
  } else {
    acrossLenIn = cartonWidthIn;
    deepLenIn   = cartonLengthIn;
  }
  const cartonsPerShelfAcross = acrossLenIn > 0 ? Math.floor(bayWidthIn / acrossLenIn) : 0;
  const cartonsPerShelfDeep   = deepLenIn   > 0 ? Math.floor(shelfDeckDepthIn / deepLenIn) : 0;
  const cartonsPerShelf = cartonsPerShelfAcross * cartonsPerShelfDeep;

  // Shelf level pitch
  const shelfLevelHeightFt = (cartonHeightIn + shelfClearanceIn) / 12;
  const shelfLevelsAt84In = shelfLevelHeightFt > 0
    ? Math.max(1, Math.floor(84 / (shelfLevelHeightFt * 12)))
    : 0;

  return {
    cartonLengthIn,
    cartonWidthIn,
    cartonHeightIn,
    palletLengthIn,
    palletWidthIn,
    loadHeightIn,
    ti,
    hi,
    cartonsPerPallet,
    cartonsPerPalletOverride: useOverride,
    orientation,
    shelfBayWidthFt,
    shelfDeckDepthIn,
    cartonsPerShelfAcross,
    cartonsPerShelfDeep,
    cartonsPerShelf,
    shelfLevelHeightFt,
    shelfLevelsAt84In,
  };
}

/**
 * Compute required shelving locations as the maximum of demand-side
 * (cartons / cartons-per-shelf) and SKU-side (one face per SKU).
 *
 * **Why two-sided.** Today's engine treats shelving capacity as a count
 * of "positions" derived from total_pallets × shelving_mix%, which is
 * dimensionally meaningless: a pallet ≠ a shelf location. Real shelving
 * sizing accounts for BOTH:
 *   - Cube demand: how many cartons does the inventory hold? Each shelf
 *     location holds N cartons; required locations = cartons / N.
 *   - SKU breadth: how many distinct SKUs need a forward-pick face?
 *     Each SKU minimally needs 1 face (more if velocity/replenishment
 *     warrant). Required locations >= SKU count.
 * The binding constraint is whichever is larger.
 *
 * @param {{
 *   totalPallets: number,           // gross pallet inventory (post override + buffers)
 *   shelvingMixPct: number,         // 0-1 fraction of pallets diverted to shelving
 *   cartonsPerPallet: number,       // from computeCartonProfile
 *   cartonsPerShelf: number,        // from computeCartonProfile
 *   shelvingSkus: number,           // SKU count assigned to shelving zone
 *   shelfLevels?: number,           // for bays-required derivation (default 6)
 *   honeycombPct?: number,          // 0-1 (default 0.10)
 *   surgePct?: number,              // 0-1 (default 0.20)
 * }} opts
 * @returns {{
 *   demandCartons: number,
 *   demandLocations: number,
 *   skuMinLocations: number,
 *   locationsRaw: number,           // max(demand, sku) before buffers
 *   locationsRequired: number,      // raw × (1 + honeycomb) × (1 + surge), rounded up
 *   baysRequired: number,
 *   shelfLevels: number,
 *   mode: 'demand-bound'|'sku-bound'|'tie',
 * }}
 */
export function computeShelvingLocations(opts = {}) {
  const totalPallets    = Math.max(0, +opts.totalPallets    || 0);
  const shelvingMixPct  = Math.max(0, +opts.shelvingMixPct  || 0);
  const cartonsPerPallet = Math.max(0, +opts.cartonsPerPallet || 0);
  const cartonsPerShelf  = Math.max(0, +opts.cartonsPerShelf  || 0);
  const shelvingSkus    = Math.max(0, Math.round(+opts.shelvingSkus || 0));
  const shelfLevels     = Math.max(1, Math.round(+opts.shelfLevels  || 6));
  const honeycombPct    = opts.honeycombPct != null ? +opts.honeycombPct : 0.10;
  const surgePct        = opts.surgePct     != null ? +opts.surgePct     : 0.20;

  const demandCartons = totalPallets * shelvingMixPct * cartonsPerPallet;
  const demandLocations = cartonsPerShelf > 0 ? demandCartons / cartonsPerShelf : 0;
  const skuMinLocations = shelvingSkus;

  /** @type {'demand-bound'|'sku-bound'|'tie'} */
  let mode;
  if (demandLocations > skuMinLocations) mode = 'demand-bound';
  else if (skuMinLocations > demandLocations) mode = 'sku-bound';
  else mode = 'tie';

  const locationsRaw = Math.max(demandLocations, skuMinLocations);
  const buffered = locationsRaw * (1 + honeycombPct) * (1 + surgePct);
  const locationsRequired = Math.ceil(buffered);
  const baysRequired = Math.ceil(locationsRequired / shelfLevels);

  return {
    demandCartons: Math.round(demandCartons),
    demandLocations: Math.round(demandLocations),
    skuMinLocations,
    locationsRaw: Math.round(locationsRaw),
    locationsRequired,
    baysRequired,
    shelfLevels,
    mode,
  };
}

/**
 * Compute the row of beam heights (Y coordinates) at which crossbeams
 * should be instanced for a rack of `levels` pallet positions.
 *
 * **Real selective-rack convention.**
 *   - The beam at the BOTTOM of level k (k = 1..N) supports level k's pallet.
 *   - The beam ABOVE the top level is structurally pointless — the top
 *     pallet load has nothing above it. Today's engine instances N+1 beams
 *     for N levels; this fix drops the orphan top beam.
 *   - The bottom beam (at floor level) is OPTIONAL. Distribution default
 *     is bottom pallet on slab (no beam, saves cost). Wire-decked rack for
 *     case-pick or pick-modules where ergonomics raise the bottom level
 *     do carry a bottom beam — toggle exposed here.
 *
 * Returns beam Y heights (feet, measured from floor) and a count.
 *
 * @param {{
 *   levels: number,                 // number of pallet (or shelf) levels
 *   levelHeightFt: number,          // vertical pitch per level
 *   bottomBeam?: boolean,           // include floor beam (default false)
 *   topBeam?: boolean,              // include orphan top beam (default false; set true only for legacy compat)
 * }} opts
 * @returns {{
 *   beamRowHeightsFt: number[],     // sorted ascending; instance one beam pair per height
 *   beamCount: number,
 *   bottomBeam: boolean,
 *   topBeam: boolean,
 *   topOfSteelFt: number,           // top of highest stored load
 * }}
 */
export function computeRackingStructure(opts = {}) {
  const levels = Math.max(0, Math.round(+opts.levels || 0));
  const levelHeightFt = Math.max(0, +opts.levelHeightFt || 0);
  const bottomBeam = !!opts.bottomBeam;
  const topBeam = !!opts.topBeam;

  if (levels <= 0 || levelHeightFt <= 0) {
    return {
      beamRowHeightsFt: [],
      beamCount: 0,
      bottomBeam,
      topBeam,
      topOfSteelFt: 0,
    };
  }

  /** @type {number[]} */
  const heights = [];
  // Floor beam (level 1's bottom) — optional.
  if (bottomBeam) heights.push(0);
  // Beams between levels: at the bottom of level k (k = 2..N), i.e. at
  // height (k-1) * levelHeightFt. These support pallet k from below.
  for (let k = 2; k <= levels; k++) {
    heights.push((k - 1) * levelHeightFt);
  }
  // Orphan top beam — only if explicitly requested (legacy compat).
  if (topBeam) heights.push(levels * levelHeightFt);

  return {
    beamRowHeightsFt: heights,
    beamCount: heights.length,
    bottomBeam,
    topBeam,
    topOfSteelFt: levels * levelHeightFt,
  };
}

/**
 * Compute dock door requirement from peak-day truck arrivals × dwell time.
 *
 * **Math.** Trucks per peak day = peak_throughput_pallets / pallets_per_truck.
 * Each truck occupies one door for `dwellHoursPerTruck`. Door capacity per
 * shift = `shiftHoursPerDay`. So doors required = trucks × dwell / shift.
 * Surge buffer applies on top.
 *
 *   Example: 5,000 pallets/peak-day, 26 pallets/truck, 1.5h dwell, 16h shift, 20% surge:
 *     trucks/peak = 5000 / 26 = 192.3
 *     doorsRequired = 192.3 × 1.5 / 16 = 18.0
 *     doorsBySurge = ceil(18.0 × 1.20) = 22
 *
 * @param {{
 *   peakThroughputPalletsPerDay: number,  // (in + out) at peak
 *   palletsPerTruck?: number,             // default 26 (TL with floor stack); 30 for pallet floor-load
 *   dwellHoursPerTruck?: number,          // default 1.5 (live unload + stage)
 *   shiftHoursPerDay?: number,            // default 16 (2 shifts)
 *   surgePct?: number,                    // default 0.20
 *   sfPerDoor?: number,                   // default DOCK_SF_PER_DOOR (1500)
 * }} opts
 * @returns {{
 *   peakThroughputPalletsPerDay: number,
 *   trucksPerPeakDay: number,
 *   palletsPerTruck: number,
 *   dwellHoursPerTruck: number,
 *   shiftHoursPerDay: number,
 *   doorsRequiredRaw: number,             // un-rounded
 *   doorsRequired: number,                // ceil
 *   doorsBySurge: number,                 // ceil with surge applied
 *   dockSfRequired: number,
 * }}
 */
export function computeDockRequirement(opts = {}) {
  const peakThroughput = Math.max(0, +opts.peakThroughputPalletsPerDay || 0);
  const palletsPerTruck = +opts.palletsPerTruck > 0 ? +opts.palletsPerTruck : 26;
  const dwellHours = +opts.dwellHoursPerTruck > 0 ? +opts.dwellHoursPerTruck : 1.5;
  const shiftHours = +opts.shiftHoursPerDay > 0 ? +opts.shiftHoursPerDay : 16;
  const surgePct = opts.surgePct != null ? +opts.surgePct : 0.20;
  const sfPerDoor = +opts.sfPerDoor > 0 ? +opts.sfPerDoor : DOCK_SF_PER_DOOR;

  const trucksPerPeakDay = palletsPerTruck > 0 ? peakThroughput / palletsPerTruck : 0;
  const doorsRequiredRaw = shiftHours > 0 ? trucksPerPeakDay * dwellHours / shiftHours : 0;
  const doorsRequired = Math.ceil(doorsRequiredRaw);
  const doorsBySurge = Math.ceil(doorsRequired * (1 + surgePct));
  const dockSfRequired = doorsBySurge * sfPerDoor;

  return {
    peakThroughputPalletsPerDay: peakThroughput,
    trucksPerPeakDay: Math.round(trucksPerPeakDay * 10) / 10,
    palletsPerTruck,
    dwellHoursPerTruck: dwellHours,
    shiftHoursPerDay: shiftHours,
    doorsRequiredRaw: Math.round(doorsRequiredRaw * 10) / 10,
    doorsRequired,
    doorsBySurge,
    dockSfRequired,
  };
}

/**
 * Compute total required facility square footage from the requirements-side
 * components: storage + dock + office + staging + circulation buffer.
 * Returns a suggested 1.5:1 building footprint that holds the required SF.
 *
 * This is the requirements-driven footprint. Compare against an
 * already-supplied building footprint to decide whether the building is
 * over-built (suggest shrink) or under-built (suggest grow).
 *
 * @param {{
 *   storageSf: number,
 *   dockSf: number,
 *   officeSf: number,
 *   stagingSf: number,
 *   additionalSf?: number,        // forward pick, VAS, returns, custom
 *   circulationPct?: number,      // default 0.10 (10% buffer for column + main aisle + truck court)
 *   targetRatio?: number,         // long:short — default 1.5
 * }} opts
 * @returns {{
 *   storageSf: number,
 *   dockSf: number,
 *   officeSf: number,
 *   stagingSf: number,
 *   additionalSf: number,
 *   circulationSf: number,
 *   totalSfRequired: number,
 *   suggestedLongFt: number,
 *   suggestedShortFt: number,
 *   targetRatio: number,
 * }}
 */
export function computeRequiredFacilitySF(opts = {}) {
  const storageSf    = Math.max(0, +opts.storageSf    || 0);
  const dockSf       = Math.max(0, +opts.dockSf       || 0);
  const officeSf     = Math.max(0, +opts.officeSf     || 0);
  const stagingSf    = Math.max(0, +opts.stagingSf    || 0);
  const additionalSf = Math.max(0, +opts.additionalSf || 0);
  const circulationPct = opts.circulationPct != null ? +opts.circulationPct : 0.10;
  const targetRatio    = +opts.targetRatio    > 0 ? +opts.targetRatio    : 1.5;

  const subtotal = storageSf + dockSf + officeSf + stagingSf + additionalSf;
  const circulationSf = Math.ceil(subtotal * circulationPct);
  const totalSfRequired = subtotal + circulationSf;
  const suggestedLongFt = totalSfRequired > 0 ? Math.ceil(Math.sqrt(totalSfRequired * targetRatio) / 10) * 10 : 0;
  const suggestedShortFt = (suggestedLongFt > 0 && totalSfRequired > 0)
    ? Math.ceil((totalSfRequired / suggestedLongFt) / 10) * 10
    : 0;

  return {
    storageSf,
    dockSf,
    officeSf,
    stagingSf,
    additionalSf,
    circulationSf,
    totalSfRequired,
    suggestedLongFt,
    suggestedShortFt,
    targetRatio,
  };
}

// ============================================================
// BAY & AISLE GEOMETRY
// ============================================================

/**
 * Compute bay width in feet (pallet width + flue space per position).
 * @param {Object} [dims]
 * @returns {number}
 */
export function bayWidthFt(dims = {}) {
  const pw = dims.palletWidth ?? DEFAULTS.palletWidth;
  const fs = dims.flueSpace ?? DEFAULTS.flueSpace;
  return (pw + fs) / 12;
}

/**
 * Compute rack depth in feet for one side.
 * @param {'single' | 'double'} [type='single']
 * @param {Object} [dims]
 * @returns {number}
 */
export function rackDepthFt(type = 'single', dims = {}) {
  const pd = (dims.palletDepth ?? DEFAULTS.palletDepth) / 12;
  return type === 'double' ? pd * 2 + 0.5 : pd; // 0.5ft gap between back-to-back
}

/**
 * Compute aisle module width: rack + aisle + rack.
 * @param {'single' | 'double' | 'bulk' | 'carton' | 'mix'} storageType
 * @param {number} [customAisle] — override aisle width in feet
 * @param {Object} [dims]
 * @returns {number} feet
 */
export function aisleModuleWidth(storageType, customAisle, dims = {}) {
  const aisle = customAisle || AISLE_WIDTHS[storageType] || 12;
  const rackType = storageType === 'double' ? 'double' : 'single';
  const rd = rackDepthFt(rackType, dims);
  return rd + aisle + rd;
}

// ============================================================
// STORAGE CAPACITY
// ============================================================

/**
 * Compute the full storage calculation from facility and zone config.
 *
 * WSC-A2 / A3 / B2 (2026-04-25) — building dimensions DRIVE the calc:
 *  - When facility.buildingWidth and buildingDepth are set, the storage
 *    rectangle is bounded by those dimensions (minus dock face clearance).
 *  - Rack levels use the canonical v2 formula `sizingRackLevels` (load-height +
 *    sprinkler clearance aware, bounded [2,7]) — same engine as sizeFacility.
 *  - Aisle count = floor(storageWidth / aisleModuleWidth) where module
 *    incorporates rack type (single/double depth) AND user-specified aisle
 *    width — so 6 ft VNA aisles produce ~2x more positions than 12 ft wide.
 *  - When dims aren't set, fall back to the prior sqrt(SF*1.5) heuristic but
 *    flag in the return that geometry is heuristic.
 *
 * The result of this function and `sizeFacility` reconcile to the same numbers
 * when fed equivalent inputs (canonical level formula, same aisle module).
 *
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @returns {import('./types.js?v=20260418-sL').StorageCalcResult}
 */
export function computeStorage(facility, zones) {
  const totalSqft = facility.totalSqft || 0;
  const clearH = facility.clearHeight || 0;
  const widthIn = +facility.buildingWidth || 0;
  const depthIn = +facility.buildingDepth || 0;
  const st = facility.storageType || 'single';

  // Non-storage area
  const nonStorage = (zones.officeSqft || 0) + (zones.receiveStagingSqft || 0) +
    (zones.shipStagingSqft || 0) + (zones.chargingSqft || 0) +
    (zones.repackSqft || 0) + (zones.otherSqft || 0);

  // Total facility footprint: prefer width × depth when both set, fall back
  // to facility.totalSqft. When BOTH are set and disagree, the dimensions
  // win — they're the physical constraint.
  const dimsTotal = (widthIn > 0 && depthIn > 0) ? widthIn * depthIn : 0;
  const totalForStorage = dimsTotal > 0 ? dimsTotal : totalSqft;
  const storageSqft = Math.max(0, totalForStorage - nonStorage);

  // Pallet dimensions
  const dims = {
    palletWidth: facility.palletWidth,
    palletDepth: facility.palletDepth,
    palletHeight: facility.palletHeight,
    beamHeight: facility.beamHeight,
    flueSpace: facility.flueSpace,
    topClearance: facility.topClearance,
  };

  // Canonical rack levels (matches sizeFacility — load-height + sprinkler aware)
  const levels = sizingRackLevels(
    clearH,
    facility.palletHeight ?? DEFAULTS.palletHeight,
    facility.topClearance ?? DEFAULTS.topClearance,
  );
  const posH = positionHeightFt(dims);
  const usable = usableHeightFt(clearH, dims.topClearance);

  // Bay width and aisle module — drive geometry-bounded position count
  const bw = bayWidthFt(dims);
  const moduleW = aisleModuleWidth(st, facility.aisleWidth, dims);
  const bd = rackDepthFt(st === 'double' ? 'double' : 'single', dims);

  // Storage rectangle: when buildingWidth set, use it (minus dock-side
  // clearance — assume the long dim is the storage width). When BOTH
  // dims are set, use the LONGER as storage width (warehouses orient
  // racks across the long axis to maximize aisle count).
  let storageWidth = 0;
  let storageDepth = 0;
  let geometryIsHeuristic = false;
  if (widthIn > 0 && depthIn > 0) {
    storageWidth = Math.max(widthIn, depthIn);
    // Reserve ~30 ft along the dock face (12 ft door + 18 ft staging)
    // before storage starts. This is approximate — the sizing engine
    // computes precise dock+staging SF in zone breakdown.
    const dockSetback = 30;
    const usableDepth = Math.max(0, Math.min(widthIn, depthIn) - dockSetback);
    storageDepth = usableDepth;
  } else {
    // Heuristic fallback: assume 1.5:1 aspect ratio
    storageWidth = Math.sqrt(storageSqft * 1.5);
    storageDepth = storageWidth > 0 ? storageSqft / storageWidth : 0;
    geometryIsHeuristic = true;
  }

  const aisleCount = moduleW > 0 ? Math.floor(storageWidth / moduleW) : 0;
  const bayCount = bw > 0 ? Math.floor(storageDepth / bw) : 0;

  // Positions per bay = levels × (1 single | 2 double)
  const depthMultiplier = st === 'double' ? 2 : 1;
  const posPerBay = levels * depthMultiplier;
  const totalPositions = aisleCount * 2 * bayCount * posPerBay;

  return {
    rackLevels: levels,
    palletPositionsPerBay: posPerBay,
    bayWidth: bw,
    bayDepth: bd,
    aisleCount,
    bayCountPerAisle: bayCount,
    totalPalletPositions: totalPositions,
    storageSqft,
    storageUtilization: totalForStorage > 0 ? storageSqft / totalForStorage : 0,
    usableHeight: usable,
    positionHeight: posH,
    geometryIsHeuristic,
  };
}

// ============================================================
// CAPACITY SUMMARY
// ============================================================

/**
 * Build a full capacity summary combining storage calc with volume inputs.
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @param {import('./types.js?v=20260418-sL').VolumeInputs} volumes
 * @returns {import('./types.js?v=20260418-sL').CapacitySummary}
 */
export function computeCapacitySummary(facility, zones, volumes) {
  const storage = computeStorage(facility, zones);
  const totalSqft = facility.totalSqft || 0;
  const nonStorageSqft = totalSqft - storage.storageSqft;
  const cubicFt = storage.storageSqft * storage.usableHeight;
  const palletCubic = storage.totalPalletPositions * positionHeightFt() * bayWidthFt() * rackDepthFt('single');
  const cubicUtil = cubicFt > 0 ? (palletCubic / cubicFt) * 100 : 0;
  const needed = volumes.totalPallets || 0;
  const capacityUtil = storage.totalPalletPositions > 0 ? (needed / storage.totalPalletPositions) * 100 : 0;

  const dailyPallets = (volumes.avgDailyInbound || 0) + (volumes.avgDailyOutbound || 0);
  const peakDaily = dailyPallets * (volumes.peakMultiplier || 1.3);
  const dock = zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const totalDoors = dock.inboundDoors + dock.outboundDoors;
  const dockUtil = totalDoors > 0
    ? (peakDaily / (totalDoors * DOOR_CAPACITY_PER_DAY)) * 100
    : 0;

  const suggested = suggestedSqft(volumes);

  return {
    totalSqft,
    storageSqft: storage.storageSqft,
    nonStorageSqft,
    storageUtilizationPct: totalSqft > 0 ? (storage.storageSqft / totalSqft) * 100 : 0,
    totalPalletPositions: storage.totalPalletPositions,
    rackLevels: storage.rackLevels,
    cubicFtStorage: cubicFt,
    cubicUtilizationPct: cubicUtil,
    palletPositionsNeeded: needed,
    capacityUtilizationPct: capacityUtil,
    dockDoorUtilization: dockUtil,
    suggestedSqft: suggested,
  };
}

// ============================================================
// SUGGESTED SQFT HEURISTIC
// ============================================================

/**
 * Heuristic-based sqft recommendation.
 * Formula: (pallets / turns) × 20 sqft/position + SKU pick area + 25% support uplift
 * Recalibrated from v2 (was 30× inflated). Corrected 2026-04-05.
 *
 * @param {import('./types.js?v=20260418-sL').VolumeInputs} volumes
 * @returns {number} suggested total sqft
 */
export function suggestedSqft(volumes) {
  const pallets = volumes.totalPallets || 0;
  const turns = volumes.inventoryTurns || 18;
  const skus = volumes.totalSKUs || 0;

  // Reserve storage: pallets / turns × 20 sqft per position
  const reserveSqft = (pallets / Math.max(1, turns)) * 20;

  // Pick area: ~2 sqft per active SKU pick face
  const pickSqft = skus * 2;

  // Base storage area
  const baseSqft = reserveSqft + pickSqft;

  // Add support area uplift (staging, office, charging, etc.)
  return Math.round(baseSqft * (1 + SUPPORT_AREA_UPLIFT));
}

// ============================================================
// DOCK UTILIZATION
// ============================================================

/**
 * Compute dock door utilization metrics.
 * @param {number} dockDoors
 * @param {number} dailyInbound — pallets/day
 * @param {number} dailyOutbound — pallets/day
 * @param {number} [peakMultiplier=1.3]
 * @returns {{ avgUtil: number, peakUtil: number, doorsNeeded: number }}
 */
export function dockUtilization(dockDoors, dailyInbound, dailyOutbound, peakMultiplier = 1.3) {
  const doors = Math.max(1, dockDoors || 1);
  const daily = (dailyInbound || 0) + (dailyOutbound || 0);
  const peak = daily * peakMultiplier;
  const totalCapacity = doors * DOOR_CAPACITY_PER_DAY;

  return {
    avgUtil: totalCapacity > 0 ? (daily / totalCapacity) * 100 : 0,
    peakUtil: totalCapacity > 0 ? (peak / totalCapacity) * 100 : 0,
    doorsNeeded: Math.ceil(peak / DOOR_CAPACITY_PER_DAY),
  };
}

// ============================================================
// ZONE ALLOCATION
// ============================================================

/**
 * Compute non-storage zone allocation breakdown.
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @returns {{ total: number, breakdown: Array<{ label: string, sqft: number, pct: number }> }}
 */
export function zoneBreakdown(zones) {
  const items = [
    { label: 'Office / Mezzanine', sqft: zones.officeSqft || 0 },
    { label: 'Receive Staging', sqft: zones.receiveStagingSqft || 0 },
    { label: 'Ship Staging', sqft: zones.shipStagingSqft || 0 },
    { label: 'Battery Charging', sqft: zones.chargingSqft || 0 },
    { label: 'Repack / VAS', sqft: zones.repackSqft || 0 },
    { label: 'Other', sqft: zones.otherSqft || 0 },
  ].filter(z => z.sqft > 0);

  const total = items.reduce((s, z) => s + z.sqft, 0);
  return {
    total,
    breakdown: items.map(z => ({ ...z, pct: total > 0 ? (z.sqft / total) * 100 : 0 })),
  };
}

// ============================================================
// ELEVATION VIEW DATA (pure — no Canvas)
// ============================================================

/**
 * Compute parameters needed for elevation cross-section rendering.
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @returns {import('./types.js?v=20260418-sL').ElevationParams}
 */
export function elevationParams(facility, zones) {
  const dims = {
    palletWidth: facility.palletWidth,
    palletDepth: facility.palletDepth,
    palletHeight: facility.palletHeight,
    beamHeight: facility.beamHeight,
    flueSpace: facility.flueSpace,
    topClearance: facility.topClearance,
  };

  const st = facility.storageType || 'single';
  const levels = rackLevels(facility.clearHeight || 0, dims);
  const dock = zones?.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const totalDoors = dock.inboundDoors + dock.outboundDoors;

  // WSC-O1 (2026-05-04): elevation section runs along the LONG axis of the
  // building (canonical dock-on-long-edge convention). Pre-O1 this consumed
  // raw buildingWidth, which produced the wrong section dimension on portrait
  // inputs (W < D). orientFacility() returns longFt regardless of which user
  // input held the long value.
  const orient = orientFacility(facility);
  return {
    buildingWidth: orient.longFt,        // back-compat field name; semantically = section axis (long)
    longFt: orient.longFt,
    shortFt: orient.shortFt,
    clearHeight: facility.clearHeight || 0,
    rackLevels: levels,
    positionHeight: positionHeightFt(dims),
    topClearanceFt: (facility.topClearance ?? DEFAULTS.topClearance) / 12,
    storageType: st,
    aisleWidth: facility.aisleWidth || AISLE_WIDTHS[st] || 12,
    rackDepthFt: rackDepthFt(st === 'double' ? 'double' : 'single', dims),
    dockDoors: totalDoors,
  };
}

// ============================================================
// STORAGE TYPE ALLOCATION
// ============================================================

/**
 * Calculate storage positions by type — REAL math, not naive allocation.
 *
 * WSC-A5 (2026-04-25): the prior implementation pretended carton-on-shelving
 * had pallet "positions" by multiplying geometric capacity by allocation
 * percentage. That is dimensionally wrong: shelving holds *carton locations*,
 * not pallets. A 10% shelving allocation in a 100K-pos building does NOT mean
 * 10K shelving positions — it means a shelving footprint sized for 10% of
 * peak units, which translates via cartonsPerLocation into a different
 * (and generally smaller) location count.
 *
 * This implementation delegates to the unit-based derivation that
 * sizeFacility uses: peakUnits × allocation% / unitsPerPallet (or per
 * carton hierarchy for shelving). Returns BOTH counts and units consumed
 * so callers can present the right denomination.
 *
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @returns {{ fullPalletPositions: number, cartonOnPalletPositions: number, cartonOnShelvingLocations: number, totalPositions: number }}
 */
export function calcStorageByType(facility, zones) {
  const facAlloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
  const prod = zones.productDimensions || {};
  const peakUnits = zones.peakUnitsPerDay || 0;

  // Phase 4 Layer B (volumes-as-nucleus, 2026-04-29): when channelMixes are
  // present, run the sizing math per-channel using each channel's
  // storageAllocation override (or the facility-level alloc as fallback) and
  // sum the positions. The channel total may not exactly equal `peakUnits`
  // (rounding + the channels list omits zero-peak channels) so we use the
  // sum of channel peakUnitsPerDay as the basis. Falls through to legacy
  // single-mix path when channelMixes is absent or empty.
  const channelMixes = Array.isArray(zones.channelMixes) ? zones.channelMixes : [];
  const useChannels = channelMixes.length > 0
    && channelMixes.some(m => Number(m?.peakUnitsPerDay) > 0);

  const upp = prod.unitsPerPallet || 48;
  const ucp = prod.unitsPerCartonPallet || 6;
  const cpp = prod.cartonsPerPallet || 12;
  const ucs = prod.unitsPerCartonShelving || 6;
  const cpl = prod.cartonsPerLocation || 4;

  /**
   * Compute positions for one allocation × peak-units bucket.
   * @returns {{fullPalletPositions:number, cartonOnPalletPositions:number, cartonOnShelvingLocations:number}}
   */
  const positionsFor = (alloc, peak) => {
    const fpUnits = Math.round(peak * (alloc.fullPallet || 0) / 100);
    const cpUnits = Math.round(peak * (alloc.cartonOnPallet || 0) / 100);
    const csUnits = Math.round(peak * (alloc.cartonOnShelving || 0) / 100);
    return {
      fullPalletPositions: upp > 0 ? Math.ceil(fpUnits / upp) : 0,
      cartonOnPalletPositions: (ucp > 0 && cpp > 0) ? Math.ceil(cpUnits / ucp / cpp) : 0,
      cartonOnShelvingLocations: (ucs > 0 && cpl > 0) ? Math.ceil(csUnits / ucs / cpl) : 0,
    };
  };

  if (useChannels) {
    let fpPos = 0, cpPos = 0, csPos = 0;
    /** @type {Array<{channelKey:string, name:string, peakUnitsPerDay:number, fullPalletPositions:number, cartonOnPalletPositions:number, cartonOnShelvingLocations:number}>} */
    const byChannel = [];
    for (const m of channelMixes) {
      const peak = Number(m.peakUnitsPerDay) || 0;
      if (peak <= 0) continue;
      const alloc = (m.storageAllocation && typeof m.storageAllocation === 'object')
        ? m.storageAllocation
        : facAlloc;
      const pos = positionsFor(alloc, peak);
      fpPos += pos.fullPalletPositions;
      cpPos += pos.cartonOnPalletPositions;
      csPos += pos.cartonOnShelvingLocations;
      byChannel.push({
        channelKey: m.channelKey,
        name: m.name || m.channelKey,
        peakUnitsPerDay: peak,
        ...pos,
      });
    }
    return {
      fullPalletPositions: fpPos,
      cartonOnPalletPositions: cpPos,
      cartonOnShelvingLocations: csPos,
      totalPositions: fpPos + cpPos + csPos,
      byChannel,
    };
  }

  // Legacy single-mix path.
  const pos = positionsFor(facAlloc, peakUnits);
  return {
    fullPalletPositions: pos.fullPalletPositions,
    cartonOnPalletPositions: pos.cartonOnPalletPositions,
    cartonOnShelvingLocations: pos.cartonOnShelvingLocations,
    // Note: total mixes pallet positions + shelf locations. They are
    // different units of capacity — present them separately when displaying.
    totalPositions: pos.fullPalletPositions + pos.cartonOnPalletPositions + pos.cartonOnShelvingLocations,
  };
}

// ============================================================
// DOCK ANALYSIS
// ============================================================

/**
 * Calculate dock door requirements and utilization.
 * Formula: (inbound + outbound) × 1.25 buffer × DOCK_SF_PER_DOOR × (1.15 if two-sided)
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @param {import('./types.js?v=20260418-sL').VolumeInputs} volumes
 * @returns {{ inboundDoorsNeeded: number, outboundDoorsNeeded: number, inboundUtilization: number, outboundUtilization: number, dockSqft: number }}
 */
export function calcDockAnalysis(facility, zones, volumes) {
  const dock = zones.dockConfig || { sided: 'single', inboundDoors: 10, outboundDoors: 12, palletsPerDockHour: 12, dockOperatingHours: 10 };
  const peak = volumes.peakMultiplier || 1.3;
  const avg = volumes.avgDailyInbound || 0;
  const out = volumes.avgDailyOutbound || 0;

  const peakInbound = avg * peak;
  const peakOutbound = out * peak;

  const capacity = dock.palletsPerDockHour * dock.dockOperatingHours;
  const inboundDoorsNeeded = Math.ceil(peakInbound / capacity);
  const outboundDoorsNeeded = Math.ceil(peakOutbound / capacity);

  const inboundUtilization = capacity > 0 ? (peakInbound / capacity) * 100 : 0;
  const outboundUtilization = capacity > 0 ? (peakOutbound / capacity) * 100 : 0;

  // Dock SF: (inbound + outbound) × 1.25 buffer × DOCK_SF_PER_DOOR (1500) × (1.15 if two-sided)
  const totalDoors = dock.inboundDoors + dock.outboundDoors;
  const bufferMultiplier = 1.25;
  const twoSidedMultiplier = dock.sided === 'two' ? 1.15 : 1.0;
  const dockSqft = Math.round(totalDoors * bufferMultiplier * DOCK_SF_PER_DOOR * twoSidedMultiplier);

  return {
    inboundDoorsNeeded,
    outboundDoorsNeeded,
    inboundUtilization,
    outboundUtilization,
    dockSqft,
  };
}

// ============================================================
// INVENTORY METRICS
// ============================================================

/**
 * Calculate Days Inventory On Hand (DIOH) for forward pick sizing.
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @returns {number} DIOH in days
 */
export function calcDIOH(zones) {
  // DIOH = Days of Inventory On-Hand = total on-hand units ÷ daily outbound.
  // Typical 3PL DC: 30–90 days; high-turn retail: 10–30 days.
  //
  // Fix history (2026-04-20): prior formula was
  //   (avgUnitsPerDay × forwardPick.daysInventory) / forwardPick.outboundUnitsPerDay
  // which multiplied in the forward-pick days-of-cover (a local FP sizing
  // concept) and divided by the FP-local daily outbound, producing 210 days
  // on defaults. Forward-pick days-of-cover and facility-level DIOH are
  // different metrics — don't conflate them.
  //
  // Daily outbound priority:
  //   1. zones.outboundUnitsPerDay (explicit field)
  //   2. zones.outboundUnitsYr / operatingDaysPerYear (derived)
  //   3. zones.forwardPick.outboundUnitsPerDay (legacy fallback)
  //
  // On-hand priority:
  //   1. zones.avgUnits (explicit on-hand total, preferred)
  //   2. zones.avgUnitsPerDay (historical field — treated as on-hand total
  //      because that's how sizeFacility consumes it; label says "per day"
  //      but the engine treats it as total for storage sizing).
  const onHand = (zones.avgUnits && zones.avgUnits > 0)
    ? zones.avgUnits
    : (zones.avgUnitsPerDay || 0);
  if (onHand <= 0) return 0;

  let daily = 0;
  if (zones.outboundUnitsPerDay && zones.outboundUnitsPerDay > 0) {
    daily = zones.outboundUnitsPerDay;
  } else if (zones.outboundUnitsYr && zones.outboundUnitsYr > 0) {
    const days = zones.operatingDaysPerYear || 250;
    daily = zones.outboundUnitsYr / Math.max(1, days);
  } else {
    const pick = zones.forwardPick || {};
    daily = pick.outboundUnitsPerDay || 0;
  }
  if (daily <= 0) return 0;

  return onHand / daily;
}

/**
 * Calculate forward pick area sqft.
 *
 * Legacy formula (SKUs × DIOH × units_per_carton × module_sqft) produced
 * dimensional-analysis errors — result scales as SKUs × days × units, which
 * blew up to tens of millions of sqft for realistic demos. Replaced with the
 * industry-standard shape used by the v3 sizing engine (sizeFacility):
 *
 *   facings = SKUs × activePickPct        (one slot per actively-picked SKU)
 *   slot_multiplier = ceil(daysInventory / standardLaneDays)  (cap at 5x)
 *   sqft = facings × slot_multiplier × moduleSqft
 *
 * A 2,000-SKU / 3-day / carton-flow forward pick now sizes at ~19K sqft
 * (vs. 46M under the old formula) — matches the sized.zoneBreakdown row
 * that the Size Recommendation card already shows.
 *
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @returns {number} forward pick area in sqft
 */
export function calcForwardPick(zones) {
  const pick = zones.forwardPick || {
    enabled: false, type: 'carton_flow', skuCount: 2000,
    daysInventory: 3, outboundUnitsPerDay: 5000, activePickPct: 100,
  };

  if (!pick.enabled) return 0;

  // Module size by pick type
  const modulesByType = {
    carton_flow: 9.5,    // sqft per carton flow module (industry avg)
    light_case:  8,       // sqft per light case module
    heavy_case:  12,      // sqft per heavy case module
    pallet:      45,      // sqft per pallet location (drive-through / pallet flow)
  };
  const moduleSqft = modulesByType[pick.type] || 9.5;

  // Active faces = SKUs that actually get a forward-pick slot. When
  // activePickPct isn't provided (legacy configs) assume 100%.
  const activePct = pick.activePickPct != null ? pick.activePickPct : 100;
  const activeFaces = Math.ceil((pick.skuCount || 0) * activePct / 100);

  // Deeper flow lanes (holding more than one standard lane's worth of
  // inventory) consume extra sqft. Cap at 5x to prevent runaway sizing for
  // unusual daysInventory inputs.
  const standardLaneDays = 3;
  const slotMultiplier = Math.min(
    5,
    Math.max(1, Math.ceil((pick.daysInventory || standardLaneDays) / standardLaneDays)),
  );

  return Math.round(activeFaces * slotMultiplier * moduleSqft);
}

/**
 * Sum optional and custom zone sqft.
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @returns {number} total optional zones sqft
 */
export function calcOptionalZones(zones) {
  let total = 0;

  const opt = zones.optionalZones || {};
  if (opt.vas?.enabled) total += opt.vas.sqft || 0;
  if (opt.returns?.enabled) total += opt.returns.sqft || 0;
  if (opt.chargeback?.enabled) total += opt.chargeback.sqft || 0;

  const custom = zones.customZones || [];
  for (let i = 0; i < custom.length; i++) {
    total += custom[i].sqft || 0;
  }

  return total;
}

/**
 * Calculate corrected suggested sqft including all zones.
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @param {import('./types.js?v=20260418-sL').VolumeInputs} volumes
 * @returns {number} corrected suggested sqft
 */
export function calcSuggestedSF(facility, zones, volumes) {
  const base = suggestedSqft(volumes);
  const dock = calcDockAnalysis(facility, zones, volumes);
  const fwd = calcForwardPick(zones);
  const opt = calcOptionalZones(zones);

  return Math.round(base + dock.dockSqft + fwd + opt);
}

// ============================================================
// FORMATTING HELPERS
// ============================================================

/**
 * Format square footage.
 * @param {number} sqft
 * @returns {string}
 */
export function formatSqft(sqft) {
  if (!sqft || sqft <= 0) return '0 SF';
  return Math.round(sqft).toLocaleString() + ' SF';
}

// Display formatting — delegated to shared/format.js (S16, was duplicated
// across 4 tool calc.js files; consolidated 2026-05-11).
export { formatPct, formatFt } from '../../shared/format.js';


// ============================================================
// VOLUME-FIRST FACILITY SIZING (v2 calcWarehouse port)
// ============================================================
// Customer flow: "I have N peak units / inventory mix / inbound/outbound
// pallets per day — how big a building do I need?". Outputs a fully-sized
// facility: positions, zone-by-zone SF, dock doors, recommendation parts.
//
// NO DOM, NO side effects. UI formats the textual recommendation.
// All numeric outputs are integers (rounded conservatively to be safe to print).
// ============================================================

/**
 * Defaults aligned with v2 calcWarehouse's UI defaults so a blank input set
 * produces a recognisable mid-sized 3PL warehouse (~500k SF).
 */
export const SIZING_DEFAULTS = {
  // Inventory
  peakUnits: 500000,
  avgUnits: 350000,
  outboundUnitsYr: 0,
  operatingDaysYr: 250,
  // Mix (must sum to 1.0; helper normalises if not)
  fullPalletPct: 0.60,
  cartonOnPalletPct: 0.30,
  cartonOnShelvingPct: 0.10,
  // Product conversions
  unitsPerPallet: 48,
  unitsPerCartonPal: 6,
  cartonsPerPallet: 12,
  unitsPerCartonShelv: 6,
  cartonsPerLocation: 4,
  // Building
  clearHeightFt: 36,
  loadHeightIn: 48,
  sprinklerClearanceIn: 18,
  // Storage geometry
  storeType: 'single',
  aisleType: 'narrow',     // wide=12, narrow=10, vna=6
  bulkDepth: 4,
  stackHi: 3,
  mixRackPct: 0.70,
  // Buffers
  honeycombPct: 10,
  surgePct: 20,
  // Dock
  inPalletsDay: 200,
  outPalletsDay: 200,
  palletsPerDoorHour: 20,
  dockHours: 8,
  dockConfig: 'one',       // 'one' | 'two'
  availableWallFt: 0,      // 0 = constraint not enforced
  // Optional explicit overrides — if > 0, engine uses these instead of deriving from throughput
  inboundDoorsOverride: 0,
  outboundDoorsOverride: 0,
  // Optional explicit pallet position count — if > 0, bypasses units→pallets derivation
  // Use this when the user has an engineered pallet count from a slotting study
  totalPalletsOverride: 0,
  // Brock 2026-05-08 (consolidation): symmetric override for shelving locations.
  // If > 0, bypasses peakUnits × cartonOnShelvingPct ÷ ucShelv ÷ cartonsPerLocation
  // derivation. Drives carton-on-shelving zone directly.
  totalShelvingLocationsOverride: 0,
  // Other zones
  officePct: 0.05,
  forwardPick: null,       // see ForwardPickInputs
  optionalZones: [],       // [{ label, sqft }]
  customZones: [],         // [{ label, sqft }]
  // ── Phase 1 redesign (2026-05-04): IE-correct unit-load + carton + SKU + dock inputs ──
  // All optional. When omitted, Phase 1 falls back to legacy behavior so
  // existing tests + UI don't break. Phase 2 will surface these in the
  // Configure side panel as the primary input flow.
  palletType: 'GMA',           // 'GMA' | 'CHEP' | 'Euro' | 'EuroHalf' | 'Custom'
  palletLengthIn: 0,           // override; required when palletType='Custom'
  palletWidthIn: 0,            // override; required when palletType='Custom'
  // Carton profile (single global carton; per-channel override deferred to Phase 5)
  cartonLengthIn: 12,
  cartonWidthIn: 9,
  cartonHeightIn: 12,
  cartonOrientation: 'L-along-rack',  // 'L-along-rack' | 'W-along-rack'
  cartonsPerPalletOverride: 0,        // > 0 to bypass ti×hi derivation (e.g., from slotting study)
  // SKU counts per zone — drive minimum-location math. Default 0 = derive
  // from positions via heuristic (FP_SKUs = round(positions/10), etc.).
  fullPalletSkus: 0,
  cartonPalletSkus: 0,
  shelvingSkus: 0,
  // Bottom-beam toggles per zone. Distribution default for FP is no bottom
  // beam (pallet on slab — saves cost); CP gets a bottom beam to support
  // wire-decked case-pick or pick-module ergonomics; shelving has its own
  // deck per level so the toggle is moot.
  bottomBeamFp: false,
  bottomBeamCp: true,
  bottomBeamShelving: false,
  topBeam: false,              // legacy compat — orphan beam above top level (real selective: never)
  // Dock requirement inputs (peak throughput → door count)
  palletsPerTruck: 26,         // TL pallet load — 30 floor-loaded, 26 with stack
  dwellHoursPerTruck: 1.5,     // live unload + stage (door occupied time)
  shiftHoursPerDay: 16,        // 2-shift default
  surgePctDock: 0.20,          // dock-specific surge buffer (separate from inventory surge)
};

/**
 * Aisle width by aisle type, feet.
 */
export const SIZING_AISLE_WIDTHS = { wide: 12, narrow: 10, vna: 6 };

/** Position geometry constants (preserved from v2). */
const POSITION_WIDTH_FT = 4.33;   // 52 inches
const STORAGE_LOSS_FACTOR = 1.20; // cross-aisles, columns, fire lanes

/**
 * @typedef {Object} SizingInputs
 * @property {number} [peakUnits]
 * @property {number} [avgUnits]
 * @property {number} [outboundUnitsYr]
 * @property {number} [operatingDaysYr]
 * @property {number} [fullPalletPct]
 * @property {number} [cartonOnPalletPct]
 * @property {number} [cartonOnShelvingPct]
 * @property {number} [unitsPerPallet]
 * @property {number} [unitsPerCartonPal]
 * @property {number} [cartonsPerPallet]
 * @property {number} [unitsPerCartonShelv]
 * @property {number} [cartonsPerLocation]
 * @property {number} [clearHeightFt]
 * @property {number} [loadHeightIn]
 * @property {number} [sprinklerClearanceIn]
 * @property {'single'|'double'|'bulk'|'carton'|'mix'} [storeType]
 * @property {'wide'|'narrow'|'vna'} [aisleType]
 * @property {number} [bulkDepth]
 * @property {number} [stackHi]
 * @property {number} [mixRackPct]
 * @property {number} [honeycombPct]
 * @property {number} [surgePct]
 * @property {number} [inPalletsDay]
 * @property {number} [outPalletsDay]
 * @property {number} [palletsPerDoorHour]
 * @property {number} [dockHours]
 * @property {'one'|'two'} [dockConfig]
 * @property {number} [availableWallFt]
 * @property {number} [officePct]
 * @property {ForwardPickInputs|null} [forwardPick]
 * @property {Array<{label:string,sqft:number}>} [optionalZones]
 * @property {Array<{label:string,sqft:number}>} [customZones]
 */

/**
 * @typedef {Object} ForwardPickInputs
 * @property {boolean} enabled
 * @property {number} skus
 * @property {number} activePickPct  — 0–100
 * @property {'pallet'|'carton'} pickType
 * @property {number} daysInventory
 */

/**
 * @typedef {Object} SizedFacility
 * @property {number} totalSqft
 * @property {number} storageSqft
 * @property {number} palletStorageSqft
 * @property {number} shelvingStorageSqft
 * @property {number} dockSqft
 * @property {number} recvStagingSqft
 * @property {number} shipStagingSqft
 * @property {number} officeSqft
 * @property {number} additionalSqft
 * @property {Array<{label:string,sqft:number}>} additionalItems
 * @property {{ fullPalletPositions:number, cartonPalletPositions:number, shelvingPositions:number, designedPositions:number, surgePositions:number, grossPositions:number, floorPositions:number }} positions
 * @property {number} rackLevels
 * @property {number} shelfLevels
 * @property {number} sfPerFloorPos
 * @property {number} sfPerPosition
 * @property {{ inboundDoors:number, outboundDoors:number, totalDoors:number, withSurgeBuffer:number, dockWallOk:boolean, dockWallRequiredFt:number, dockWallAvailableFt:number }} dock
 * @property {{ peak:number, avg:number, designed:number, utilizationPct:number, warning:'high_util'|'low_util'|null }} utilization
 * @property {Array<{label:string,sqft:number,pct:number}>} zoneBreakdown
 * @property {{ storeType:string, layoutDescription:string }} storageDetail
 * @property {{ inputs:SizingInputs, normalisedMix:{fullPalletPct:number,cartonOnPalletPct:number,cartonOnShelvingPct:number}, mixWasNormalised:boolean }} meta
 */

/**
 * Normalise a storage mix so the three percentages sum to 1.0.
 * Returns the original mix if already valid (or sums to 0 — caller handles).
 * @param {{fullPalletPct:number,cartonOnPalletPct:number,cartonOnShelvingPct:number}} mix
 * @returns {{normalised:{fullPalletPct:number,cartonOnPalletPct:number,cartonOnShelvingPct:number}, changed:boolean}}
 */
export function normaliseStorageMix(mix) {
  const fp = +mix.fullPalletPct || 0;
  const cp = +mix.cartonOnPalletPct || 0;
  const cs = +mix.cartonOnShelvingPct || 0;
  const sum = fp + cp + cs;
  if (sum === 0 || Math.abs(sum - 1) < 1e-6) {
    return { normalised: { fullPalletPct: fp, cartonOnPalletPct: cp, cartonOnShelvingPct: cs }, changed: false };
  }
  return {
    normalised: { fullPalletPct: fp / sum, cartonOnPalletPct: cp / sum, cartonOnShelvingPct: cs / sum },
    changed: true,
  };
}

/**
 * How many rack levels fit given clear height and load height
 * (ported from v2: tier = loadHeight + 10", usable = clearHeight*12 - sprinkler).
 * Bounded [2, 7].
 * @param {number} clearHeightFt
 * @param {number} loadHeightIn
 * @param {number} sprinklerClearanceIn
 * @returns {number}
 */
export function sizingRackLevels(clearHeightFt, loadHeightIn, sprinklerClearanceIn) {
  const ch = +clearHeightFt || 0;
  const lh = +loadHeightIn || SIZING_DEFAULTS.loadHeightIn;
  const sc = +sprinklerClearanceIn || SIZING_DEFAULTS.sprinklerClearanceIn;
  const tier = lh + 10;
  const usable = ch * 12 - sc;
  if (tier <= 0) return 0;
  return Math.min(7, Math.max(2, Math.floor(usable / tier)));
}

/**
 * Compute SF per floor position for a given storage type and aisle config.
 * Does NOT include rack-level multiplication.
 * @param {{storeType:string, aisleType:string, bulkDepth:number, stackHi:number}} cfg
 * @returns {{ sfPerFloorPos:number, moduleDescription:string }}
 */
export function sfPerFloorPositionFor(cfg) {
  const aisleW = SIZING_AISLE_WIDTHS[cfg.aisleType] || 10;
  const st = cfg.storeType;

  if (st === 'single' || st === 'carton' || st === 'mix') {
    const moduleDepth = 8.5 + aisleW;
    return {
      sfPerFloorPos: Math.ceil((moduleDepth / 2) * POSITION_WIDTH_FT * STORAGE_LOSS_FACTOR),
      moduleDescription: `8.5 ft back-to-back rack + ${aisleW} ft aisle = ${moduleDepth} ft module`,
    };
  }

  if (st === 'double') {
    const ddDepth = 16.5 + aisleW;
    return {
      sfPerFloorPos: Math.ceil((ddDepth / 4) * POSITION_WIDTH_FT * STORAGE_LOSS_FACTOR),
      moduleDescription: `16.5 ft double-deep + ${aisleW} ft aisle = ${ddDepth} ft module`,
    };
  }

  if (st === 'bulk') {
    const bulkAisle = 12;
    const rowDepth = (cfg.bulkDepth || 4) * 4;
    const moduleDepth = 2 * rowDepth + bulkAisle;
    const posPerCol = 2 * (cfg.bulkDepth || 4) * (cfg.stackHi || 3);
    return {
      sfPerFloorPos: Math.ceil((moduleDepth * POSITION_WIDTH_FT * STORAGE_LOSS_FACTOR) / posPerCol),
      moduleDescription: `${cfg.bulkDepth}-deep × ${cfg.stackHi}-high bulk + 12 ft aisle`,
    };
  }

  // Fallback: single-deep selective
  return sfPerFloorPositionFor({ ...cfg, storeType: 'single' });
}

/**
 * Convert the UI's (facility, zones, volumes) state objects into a fully-
 * baked {@link SizingInputs} payload for {@link sizeFacility}.
 *
 * Pure transform — no DOM access, no module-level state, no side effects.
 * Extracted from `tools/warehouse-sizing/ui.js` 2026-05-14 so that the
 * form→engine mapping can be unit-tested directly and so the WSC ui.js
 * stays below 1K LOC.
 *
 * Behavior preserved exactly: every `??` / `||` fallback in the original
 * body is copied verbatim. Each commented Brock-decision marker is retained
 * so future code archaeology still finds the rationale.
 *
 * @param {{ facility?: object, zones?: object, volumes?: object }} state
 * @returns {SizingInputs}
 */
export function formStateToInputs({ facility = {}, zones = {}, volumes = {} } = {}) {
  const alloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };
  const prod = zones.productDimensions || {};
  const dock = zones.dockConfig || {};
  const fp = zones.forwardPick || null;
  const opt = zones.optionalZones || {};
  // Phase 1 of "drag changes the design" (2026-05-14): when the user
  // corner-resizes a zone in the 2D plan view, the layoutOverride captures
  // w/h in building-relative feet. Pass them through as SF overrides so the
  // engine uses the drawn area instead of its formula-derived value. Move-only
  // overrides (just x/y) stay cosmetic — only w+h trigger the engine path.
  const _lo = zones.layoutOverrides || {};
  const _resizedSqft = (key) => {
    const o = _lo[key];
    if (!o || o.w === undefined || o.h === undefined) return 0;
    const wFt = Math.max(0, +o.w || 0);
    const hFt = Math.max(0, +o.h || 0);
    return Math.round(wFt * hFt);
  };
  const officeSqftOverride       = _resizedSqft('office');
  const shipStagingSqftOverride  = _resizedSqft('shipStaging');
  const recvStagingSqftOverride  = _resizedSqft('recvStaging');
  const forwardPickSqftOverride  = _resizedSqft('forwardPick');
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
      // 2026-05-14: drag-resize override. When > 0, sizeFacility uses it
      // instead of (activeFaces × sfPerLoc).
      sqftOverride: forwardPickSqftOverride,
    } : null,
    optionalZones,
    customZones: (zones.customZones || []).map(z => ({ label: z.name || 'Custom', sqft: z.sqft || 0 })),
    // 2026-05-14: drag-resize SF overrides (Phase 1 of "drag changes the design").
    // Engine prefers these over its formula-derived sqft when > 0.
    officeSqftOverride,
    shipStagingSqftOverride,
    recvStagingSqftOverride,
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

/**
 * Build the four-item KPI strip shown in the WSC chrome (Total/Built SF,
 * Dock Doors, Rack Positions, Utilization). Pure — takes form state, calls
 * sizeFacility + computeStorage internally, returns plain {label, value, hint}
 * tuples ready for refreshKpiStrip.
 *
 * Extraction 2026-05-14: body moved verbatim from tools/warehouse-sizing/ui.js
 * (function _computeWscKpis) so ui.js loses ~65 LOC and the SF mode logic can
 * be unit-tested without a DOM.
 *
 * @param {{ facility?: object, zones?: object, volumes?: object }} state
 * @returns {Array<{ label: string, value: string, hint: string }>}
 */
export function computeWscKpis({ facility = {}, zones = {}, volumes = {} } = {}) {
  const items = [];

  // Total SF — Phase D (2026-05-05) mode-aware. In Design mode the engine's
  // sized output IS the answer (no user-entered W/D); in Constraint mode the
  // user-entered W×D is the constraint and the chip should show that.
  let sized = null;
  try { sized = sizeFacility(formStateToInputs({ facility, zones, volumes })); } catch {}
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
  if (sized) {
    rackPos = sized?.positions?.grossPositions || 0;
    utilPct = sized?.utilization?.utilizationPct ?? null;
  }
  if (rackPos === 0) {
    try {
      const storage = computeStorage(facility, zones);
      rackPos = storage.totalPalletPositions || 0;
    } catch {}
  }
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

/**
 * Volume-first facility sizing — top-level entry point. Ported from v2's
 * `calcWarehouse` (lines 1297-1808 in v2 warehouse-sizing.js) with browser
 * specifics removed.
 *
 * @param {SizingInputs} userInputs
 * @returns {SizedFacility}
 */
export function sizeFacility(userInputs = {}) {
  const i = { ...SIZING_DEFAULTS, ...userInputs };

  // Normalise mix
  const { normalised: mix, changed: mixChanged } = normaliseStorageMix({
    fullPalletPct: i.fullPalletPct,
    cartonOnPalletPct: i.cartonOnPalletPct,
    cartonOnShelvingPct: i.cartonOnShelvingPct,
  });

  // Rack levels
  const levels = sizingRackLevels(i.clearHeightFt, i.loadHeightIn, i.sprinklerClearanceIn);

  // ── Inventory → Positions ──
  const fpUnits = Math.round((i.peakUnits || 0) * mix.fullPalletPct);
  const fullPalletPositions = i.unitsPerPallet > 0
    ? Math.ceil(fpUnits / i.unitsPerPallet) : 0;

  const cpUnits = Math.round((i.peakUnits || 0) * mix.cartonOnPalletPct);
  const cpCartons = i.unitsPerCartonPal > 0
    ? Math.ceil(cpUnits / i.unitsPerCartonPal) : 0;
  const cartonPalletPositions = i.cartonsPerPallet > 0
    ? Math.ceil(cpCartons / i.cartonsPerPallet) : 0;

  const csUnits = Math.round((i.peakUnits || 0) * mix.cartonOnShelvingPct);
  const csCartons = i.unitsPerCartonShelv > 0
    ? Math.ceil(csUnits / i.unitsPerCartonShelv) : 0;
  const shelvingDerived = i.cartonsPerLocation > 0
    ? Math.ceil(csCartons / i.cartonsPerLocation) : 0;

  // If caller supplied an engineered pallet-position count, honour it directly
  // (from a slotting study, inventory snapshot, etc.) rather than re-deriving
  // from peakUnits × mix. This is the cleanest way to size to a known inventory.
  const palletPositionsNeeded = (i.totalPalletsOverride && i.totalPalletsOverride > 0)
    ? Math.round(i.totalPalletsOverride)
    : (fullPalletPositions + cartonPalletPositions);
  const palletPositionsExplicit = !!(i.totalPalletsOverride && i.totalPalletsOverride > 0);

  // Brock 2026-05-08 (consolidation): symmetric override for shelving locations.
  // Pre-fix the engine had a pallet-positions override but no shelving-locations
  // override — so the legacy 'pallets' UI mode silently left shelving at 0
  // when the user hadn't entered throughput. With the unified form (throughput
  // + override inputs side-by-side), users can pin pallets, shelving, both,
  // or neither — engine picks override when present, derives otherwise.
  const shelvingPositions = (i.totalShelvingLocationsOverride && i.totalShelvingLocationsOverride > 0)
    ? Math.round(i.totalShelvingLocationsOverride)
    : shelvingDerived;
  const shelvingPositionsExplicit = !!(i.totalShelvingLocationsOverride && i.totalShelvingLocationsOverride > 0);

  // Honeycomb buffer — still applies (even explicit pallet counts need honeycomb loss baked in)
  const buf = 1 + (i.honeycombPct || 0) / 100;
  const grossPalletPositions = Math.ceil(palletPositionsNeeded * buf);
  const grossShelvingPositions = Math.ceil(shelvingPositions * buf);

  const designedPositions = grossPalletPositions + grossShelvingPositions;
  const surgePositions = Math.ceil(designedPositions * (i.surgePct || 0) / 100);
  const grossPositions = designedPositions + surgePositions;

  // ── Pallet Storage SF ──
  let palletStorageSqft = 0;
  let floorPositions = 0;
  let sfPerFloorPos = 0;
  let layoutDescription = '';
  const aisleW = SIZING_AISLE_WIDTHS[i.aisleType] || 10;

  if (grossPalletPositions > 0) {
    if (i.storeType === 'mix') {
      const rackPositions = Math.ceil(grossPalletPositions * (i.mixRackPct || 0));
      const bulkPositions = grossPalletPositions - rackPositions;
      const rackGeo = sfPerFloorPositionFor({ ...i, storeType: 'single' });
      const bulkGeo = sfPerFloorPositionFor({ ...i, storeType: 'bulk' });
      const rackFloor = Math.ceil(rackPositions / Math.max(1, levels));
      const rackSF = rackFloor * rackGeo.sfPerFloorPos;
      const bulkSF = Math.ceil(bulkPositions * bulkGeo.sfPerFloorPos);
      palletStorageSqft = rackSF + bulkSF;
      floorPositions = rackFloor + Math.ceil(bulkPositions / Math.max(1, (i.stackHi || 1) * (i.bulkDepth || 1)));
      sfPerFloorPos = rackPositions > 0 ? rackGeo.sfPerFloorPos : bulkGeo.sfPerFloorPos;
      layoutDescription = `Mixed: ${Math.round(i.mixRackPct * 100)}% rack (${rackPositions.toLocaleString()} pos → ${rackSF.toLocaleString()} SF) + ${100 - Math.round(i.mixRackPct * 100)}% bulk (${bulkPositions.toLocaleString()} pos → ${bulkSF.toLocaleString()} SF)`;
    } else {
      const geo = sfPerFloorPositionFor(i);
      sfPerFloorPos = geo.sfPerFloorPos;
      if (i.storeType === 'bulk') {
        // Bulk doesn't divide by rack levels — every position is a floor pallet
        floorPositions = grossPalletPositions;
        palletStorageSqft = Math.ceil(grossPalletPositions * sfPerFloorPos);
      } else {
        floorPositions = Math.ceil(grossPalletPositions / Math.max(1, levels));
        palletStorageSqft = floorPositions * sfPerFloorPos;
      }
      layoutDescription = `${labelForStoreType(i.storeType)} — ${geo.moduleDescription}, ${levels} levels`;
    }
  }

  // ── Carton Shelving SF (always, even if storeType !== carton) ──
  let shelvingStorageSqft = 0;
  const shelfLevels = Math.min(7, Math.max(3, Math.floor(((i.clearHeightFt || 0) - 1) / 5)));
  if (grossShelvingPositions > 0) {
    const shelfModule = 9.5;        // 4.5 ft back-to-back + 5 ft aisle
    const shelfBay = 3;             // 36" bay
    const shelfSfPerFloor = Math.ceil((shelfModule / 2) * shelfBay * STORAGE_LOSS_FACTOR);
    const shelfFloor = Math.ceil(grossShelvingPositions / shelfLevels);
    shelvingStorageSqft = shelfFloor * shelfSfPerFloor;
  }

  const storageSqft = palletStorageSqft + shelvingStorageSqft;

  // ── Dock Sizing ──
  // Brock 2026-05-08: legacy `Math.max(2, ...)` floor forced minimum 2 doors
  // per direction even with 0 throughput, producing 7,500 SF dock SF on a
  // blank scenario. The legacy floor was a relic from when dock-doors were
  // a structural constraint (every building has at least 2 doors); but for
  // the engine this disagreed with Phase 1's `computeDockRequirement` which
  // correctly returns 0 doors at 0 throughput. Drop the floor so the legacy
  // path agrees with Phase 1; downstream UI can still display "min 2 doors
  // recommended" as a soft guideline rather than an engine-mandated floor.
  //
  // 2026-05-12 (dock wart fix): the prior `Math.max(1, ...)` divisor floor
  // produced explosive door counts when a user had entered daily throughput
  // (in/outPalletsDay > 0) but not dock capacity (palletsPerDoorHour=0,
  // dockHours=0). With both fallbacks engaging, dockDivisor=1, so derived
  // doors ≈ daily-pallets — e.g., 200 in / 207 out → 407 raw doors, surge
  // → 509 doors, × 1500 SF = 763,500 SF of "dock." Match Phase 1's
  // computeDockRequirement pattern: zero capacity inputs → zero derived
  // doors (no inference). User-supplied overrides still win via the
  // explicit-doors branch below.
  const hasValidDockCapacity = i.palletsPerDoorHour > 0 && i.dockHours > 0;
  const dockDivisor = hasValidDockCapacity ? i.palletsPerDoorHour * i.dockHours : 0;
  const inDerived = dockDivisor > 0 ? Math.ceil((i.inPalletsDay || 0) / dockDivisor) : 0;
  const outDerived = dockDivisor > 0 ? Math.ceil((i.outPalletsDay || 0) / dockDivisor) : 0;
  // Honor explicit user-supplied door counts when provided. When the user has
  // told us "I want 28 inbound + 28 outbound", the sizing engine should NOT
  // re-derive from throughput and quietly give them 8 doors.
  const inboundOverride = (i.inboundDoorsOverride && i.inboundDoorsOverride > 0) ? Math.round(i.inboundDoorsOverride) : 0;
  const outboundOverride = (i.outboundDoorsOverride && i.outboundDoorsOverride > 0) ? Math.round(i.outboundDoorsOverride) : 0;
  const inboundDoors = inboundOverride > 0 ? inboundOverride : inDerived;
  const outboundDoors = outboundOverride > 0 ? outboundOverride : outDerived;
  const doorsAreExplicit = inboundOverride > 0 || outboundOverride > 0;
  // Surge buffer applies only to the derived path. Explicit counts are
  // the user's engineered answer — no implicit 25% inflation on top.
  const withSurgeBuffer = doorsAreExplicit
    ? (inboundDoors + outboundDoors)
    : Math.ceil((inboundDoors + outboundDoors) * 1.25);

  let dockSqft = withSurgeBuffer * DOCK_SF_PER_DOOR;
  if (i.dockConfig === 'two') dockSqft = Math.ceil(dockSqft * 1.15);

  const dockWallRequiredFt = withSurgeBuffer * 12;        // 12 ft on-center standard
  const dockWallOk = !i.availableWallFt || i.availableWallFt <= 0
    ? true
    : dockWallRequiredFt <= i.availableWallFt;

  // ── Receiving / Shipping Staging ──
  const stagingFactor = i.dockConfig === 'two' ? 1.25 : 1.0;
  const recvStagingSqft = (i.recvStagingSqftOverride > 0)
    ? Math.round(i.recvStagingSqftOverride)
    : Math.ceil((i.inPalletsDay || 0) * 0.15 * 18 * stagingFactor);
  const shipStagingSqft = (i.shipStagingSqftOverride > 0)
    ? Math.round(i.shipStagingSqftOverride)
    : Math.ceil((i.outPalletsDay || 0) * 0.15 * 18 * stagingFactor);

  // ── Additional Zones ──
  const additionalItems = [];
  let additionalSqft = 0;

  // Forward pick area. Drag-resize override (2026-05-14) wins when > 0.
  if (i.forwardPick && i.forwardPick.enabled) {
    const fp = i.forwardPick;
    const activeFaces = Math.ceil((fp.skus || 0) * (fp.activePickPct || 0) / 100);
    const sfPerLoc = fp.pickType === 'pallet' ? 45 : 12;
    const fwdSqftDerived = activeFaces * sfPerLoc;
    const fwdSqft = (fp.sqftOverride > 0) ? Math.round(fp.sqftOverride) : fwdSqftDerived;
    additionalItems.push({ label: 'Forward Pick', sqft: fwdSqft });
    additionalSqft += fwdSqft;
  }

  // Optional zones (already-summed labels + sf passed in)
  for (const zone of (i.optionalZones || [])) {
    if (zone && zone.sqft > 0) {
      additionalItems.push({ label: zone.label, sqft: zone.sqft });
      additionalSqft += zone.sqft;
    }
  }

  // Custom zones
  for (const zone of (i.customZones || [])) {
    if (zone && zone.sqft > 0) {
      additionalItems.push({ label: zone.label || 'Custom Zone', sqft: zone.sqft });
      additionalSqft += zone.sqft;
    }
  }

  // ── Operational + Office ──
  const warehouseOpSqft = storageSqft + dockSqft + recvStagingSqft + shipStagingSqft + additionalSqft;
  const officeSqft = (i.officeSqftOverride > 0)
    ? Math.round(i.officeSqftOverride)
    : Math.ceil(warehouseOpSqft * (i.officePct || 0));
  const totalSqft = warehouseOpSqft + officeSqft;

  // ── Avg Utilization (for the warning band) ──
  // Phase F.10 (2026-05-05) — Brock callout (deferred from F.3.1): when
  // totalPalletsOverride engages, designedPositions honors the override
  // (e.g. Wayfair Memphis FC 65k pallets) but avgPositions still derived
  // from avgUnits / unitsPerPallet (~900 unit-equivalents on Wayfair),
  // collapsing utilizationPct to ~1.4% → renderer clamped to 30% floor →
  // 70% of bays drew empty (resolved visually in F.3.1 + F.3.3 + F.8 +
  // F.9). This fix corrects the underlying calc so the chrome KPI's
  // "Utilization 10%" stops misleading: when override engages, scale
  // avgPositions proportionally from the override using the avgUnits
  // /peakUnits ratio (typical 0.6–0.8). Result: utilizationPct ≈ 60–80%
  // matching real DC operating utilization.
  const _useOverride = palletPositionsExplicit && i.totalPalletsOverride > 0;
  const _peakRefUnits = (i.peakUnits || 0);
  const _avgRefUnits = (i.avgUnits || 0);
  const _avgPeakRatio = _peakRefUnits > 0
    ? Math.max(0.1, Math.min(1.0, _avgRefUnits / _peakRefUnits))
    : 0.7;
  const avgPositions = _useOverride
    ? Math.ceil(i.totalPalletsOverride * _avgPeakRatio)
    : Math.ceil(
      ((i.avgUnits || 0) * mix.fullPalletPct / Math.max(1, i.unitsPerPallet)) +
      ((i.avgUnits || 0) * mix.cartonOnPalletPct / Math.max(1, i.unitsPerCartonPal) / Math.max(1, i.cartonsPerPallet)) +
      ((i.avgUnits || 0) * mix.cartonOnShelvingPct / Math.max(1, i.unitsPerCartonShelv) / Math.max(1, i.cartonsPerLocation))
    );
  const utilizationPct = designedPositions > 0
    ? Math.min(100, Math.round((avgPositions / designedPositions) * 100))
    : 0;
  /** @type {'high_util'|'low_util'|null} */
  let warning = null;
  if (utilizationPct > 85) warning = 'high_util';
  else if (utilizationPct < 70) warning = 'low_util';

  // ── Zone Breakdown ──
  const zoneBreakdown = [
    { label: 'Storage', sqft: storageSqft },
    { label: 'Dock Area', sqft: dockSqft },
    { label: 'Recv Staging', sqft: recvStagingSqft },
    { label: 'Ship Staging', sqft: shipStagingSqft },
    { label: 'Office', sqft: officeSqft },
    ...additionalItems,
  ].filter(z => z.sqft > 0).map(z => ({
    ...z,
    pct: totalSqft > 0 ? Math.round((z.sqft / totalSqft) * 100) : 0,
  }));

  // ============================================================
  // Phase 1 redesign — IE-correct unit-load / carton / SKU / dock helpers
  // ============================================================
  // All ADDITIVE: existing fields above this block are unchanged.
  // The new helpers + sized fields surface real selective-rack bay sizing
  // (2 pallets per crossbeam), ti×hi cartons-per-pallet, two-sided shelving
  // location math (demand-bound vs sku-bound), top-beam-off + bottom-beam
  // toggle racking structure, peak-throughput-driven dock door count, and
  // a requirements-driven facility footprint suggestion. Phase 2 will
  // surface these in the UI; Phase 3 will use them in the 3D rendering.

  const _unitLoad = computeUnitLoad({
    palletType: i.palletType,
    palletLengthIn: i.palletLengthIn,
    palletWidthIn: i.palletWidthIn,
    loadHeightIn: i.loadHeightIn,
  });

  const _cartonProfile = computeCartonProfile({
    cartonLengthIn: i.cartonLengthIn,
    cartonWidthIn: i.cartonWidthIn,
    cartonHeightIn: i.cartonHeightIn,
    palletLengthIn: _unitLoad.palletLengthIn,
    palletWidthIn:  _unitLoad.palletWidthIn,
    loadHeightIn:   _unitLoad.loadHeightIn,
    shelfBayWidthFt: SHELVING_BAY_WIDTH_FT,
    orientation: i.cartonOrientation,
    cartonsPerPalletOverride: i.cartonsPerPalletOverride,
  });

  // Derive SKU heuristics when user hasn't supplied counts. These are
  // back-of-envelope defaults used only as fallbacks; real sizing should
  // collect SKU counts as primary inputs in Phase 2.
  const _fpSkus  = +i.fullPalletSkus   > 0 ? Math.round(+i.fullPalletSkus)   : Math.max(0, Math.round(fullPalletPositions   / 10));
  const _cpSkus  = +i.cartonPalletSkus > 0 ? Math.round(+i.cartonPalletSkus) : Math.max(0, Math.round(cartonPalletPositions /  5));
  const _shSkus  = +i.shelvingSkus     > 0 ? Math.round(+i.shelvingSkus)     : Math.max(0, Math.round(shelvingPositions     *  4));

  // Total palletized-equivalent inventory: when override engaged, that's
  // the user's declared count; otherwise derive from peakUnits. Used as
  // the basis for shelving demand-side carton math.
  const _totalPalletsForShelving = palletPositionsExplicit
    ? Math.round(i.totalPalletsOverride)
    : Math.ceil((+i.peakUnits || 0) / Math.max(1, +i.unitsPerPallet || 1));

  const _shelvingLocationsDerived = computeShelvingLocations({
    totalPallets: _totalPalletsForShelving,
    shelvingMixPct: mix.cartonOnShelvingPct,
    cartonsPerPallet: _cartonProfile.cartonsPerPallet,
    cartonsPerShelf:  _cartonProfile.cartonsPerShelf,
    shelvingSkus: _shSkus,
    shelfLevels,
    honeycombPct: (i.honeycombPct || 0) / 100,
    surgePct:     (i.surgePct || 0) / 100,
  });

  // Brock 2026-05-08 (consolidation): override the Phase 1 shelving rollup
  // when totalShelvingLocationsOverride engaged. Caller's slotting-study
  // count replaces both demand-bound and sku-bound paths; mode tag flips
  // to 'override'. Keeps the buffered grossLocations symmetry by applying
  // the same honeycomb + surge buffers the demand-bound path uses.
  const _shelvingLocations = shelvingPositionsExplicit
    ? (() => {
        const base = Math.round(i.totalShelvingLocationsOverride);
        const buf = 1 + ((i.honeycombPct || 0) / 100);
        const surge = 1 + ((i.surgePct || 0) / 100);
        const grossLocations = Math.ceil(base * buf);
        return {
          ..._shelvingLocationsDerived,
          locationsRequired: base,
          grossLocations,
          surgeLocations: Math.ceil(grossLocations * surge),
          mode: 'override',
          explicit: true,
        };
      })()
    : { ..._shelvingLocationsDerived, explicit: false };

  // Per-zone racking structure (beam row heights, no top beam, bottom beam
  // toggleable per zone). Shelving uses the carton-profile shelf level
  // height; pallet zones use the unit-load pallet level height.
  const _rackingStructure = {
    fullPallet: computeRackingStructure({
      levels,
      levelHeightFt: _unitLoad.palletLevelHeightFt,
      bottomBeam: !!i.bottomBeamFp,
      topBeam: !!i.topBeam,
    }),
    cartonOnPallet: computeRackingStructure({
      levels,
      levelHeightFt: _unitLoad.palletLevelHeightFt,
      bottomBeam: !!i.bottomBeamCp,
      topBeam: !!i.topBeam,
    }),
    shelving: computeRackingStructure({
      levels: shelfLevels,
      levelHeightFt: _cartonProfile.shelfLevelHeightFt,
      bottomBeam: !!i.bottomBeamShelving,
      topBeam: !!i.topBeam,
    }),
  };

  // Dock requirement: peak day throughput in pallets = inbound + outbound
  // (already represents peak — the legacy engine applies a 25% surge buffer
  // on top of avg, so these are effectively peak-day numbers). New helper
  // applies its own surgePctDock buffer.
  const _dockRequirement = computeDockRequirement({
    peakThroughputPalletsPerDay: (+i.inPalletsDay || 0) + (+i.outPalletsDay || 0),
    palletsPerTruck:    i.palletsPerTruck,
    dwellHoursPerTruck: i.dwellHoursPerTruck,
    shiftHoursPerDay:   i.shiftHoursPerDay,
    surgePct:           i.surgePctDock,
    sfPerDoor:          DOCK_SF_PER_DOOR,
  });

  // Requirements-driven facility footprint: aggregate the components and
  // suggest a 1.5:1 building. Compare against the user's facility dims to
  // decide over-built vs under-built (Phase 2 banner will consume this).
  const _requirementsDriven = computeRequiredFacilitySF({
    storageSf:    storageSqft,
    dockSf:       _dockRequirement.dockSfRequired,
    officeSf:     officeSqft,
    stagingSf:    recvStagingSqft + shipStagingSqft,
    additionalSf: additionalSqft,
    circulationPct: 0.10,
    targetRatio: 1.5,
  });

  // Locations rollup: full pallet + carton-on-pallet + shelving with
  // demand vs sku-bound mode tagging.
  const _locations = {
    fullPallet: {
      positions: fullPalletPositions,
      grossPositions: 0,                 // populated below from positions block
      skuMinLocations: _fpSkus,
      locationsRequired: Math.max(fullPalletPositions, _fpSkus),
      mode: fullPalletPositions >= _fpSkus ? 'demand-bound' : 'sku-bound',
    },
    cartonOnPallet: {
      positions: cartonPalletPositions,
      grossPositions: 0,                 // populated below
      skuMinLocations: _cpSkus,
      locationsRequired: Math.max(cartonPalletPositions, _cpSkus),
      mode: cartonPalletPositions >= _cpSkus ? 'demand-bound' : 'sku-bound',
    },
    shelving: _shelvingLocations,
  };

  // Phase F.3.2 (2026-05-05) — reconcile FIND-1 sized-total drift. Pre-fix
  // sized.totalSqft (legacy v2-equivalent: warehouseOpSqft + officeSqft, no
  // circulation buffer, legacy dock-SF formula with 1.25 surge) drifted
  // ~1.2% from sized.requirementsDriven.totalSfRequired (Phase 1 IE-correct:
  // storage + office + staging + additional + Phase 1 dock SF + 10%
  // circulation, 1.20 surge). Two numbers on the same dashboard reading
  // "the sized total" was a real Phase E walkthrough finding. Now totalSqft
  // returns the requirementsDriven aggregate, so every consumer (KPI strip,
  // dashboard panel, 2D plan, 3D scene, chrome chip) sees one consistent
  // number. The local `totalSqft` legacy value is preserved as
  // `legacyTotalSqft` in the result for any downstream that needs the
  // pre-fix bookkeeping (none observed currently — flagged for follow-up
  // if anything is found to depend on it).
  const reconciledTotalSqft = (_requirementsDriven && +_requirementsDriven.totalSfRequired > 0)
    ? +_requirementsDriven.totalSfRequired
    : totalSqft;

  return {
    totalSqft: reconciledTotalSqft,
    legacyTotalSqft: totalSqft,
    storageSqft,
    palletStorageSqft,
    shelvingStorageSqft,
    dockSqft,
    recvStagingSqft,
    shipStagingSqft,
    officeSqft,
    additionalSqft,
    additionalItems,
    positions: (() => {
      // Per-type gross positions: distribute the post-honeycomb +
      // post-surge total across the three storage types so per-row
      // breakdowns in the HUD + Dashboard always sum to gross.
      // Pallet side honors totalPalletsOverride (when engaged the
      // override replaces fp+cp at the engine's pallet budget; mix
      // between fp and cp follows the user's mix percentages).
      const _buf = 1 + (i.honeycombPct || 0) / 100;
      const _surgeF = 1 + (i.surgePct || 0) / 100;
      // Distribute the canonical grossPositions across pallet vs shelving
      // sides by their raw shares so fp + cp + shelving sums EXACTLY to
      // grossPositions (no rounding drift).
      const _denomAll = palletPositionsNeeded + shelvingPositions;
      const _palletShare = _denomAll > 0 ? palletPositionsNeeded / _denomAll : 1;
      const _palletGross = Math.round(grossPositions * _palletShare);
      const _shelvingGross = grossPositions - _palletGross;
      // Mix between fp and cp inside the pallet budget — follow user
      // mix percentages when override engaged (otherwise raw fp+cp ratio).
      let _fpShareOfPallet;
      if (palletPositionsExplicit) {
        const _denom = (mix.fullPalletPct || 0) + (mix.cartonOnPalletPct || 0);
        _fpShareOfPallet = _denom > 0 ? (mix.fullPalletPct || 0) / _denom : 0.5;
      } else {
        const _fpcpRaw = fullPalletPositions + cartonPalletPositions;
        _fpShareOfPallet = _fpcpRaw > 0 ? fullPalletPositions / _fpcpRaw : 0.5;
      }
      const fullPalletGrossPositions = Math.round(_palletGross * _fpShareOfPallet);
      const cartonPalletGrossPositions = _palletGross - fullPalletGrossPositions;
      const shelvingGrossPositions = _shelvingGross;
      return {
        fullPalletPositions,
        cartonPalletPositions,
        shelvingPositions,
        // Per-type gross (honeycomb + surge applied) — sums to grossPositions.
        // Used by the 3D RenderedFacts HUD + Dashboard breakdown so per-row
        // numbers visibly add up to the total.
        fullPalletGrossPositions,
        cartonPalletGrossPositions,
        shelvingGrossPositions,
        // Subtotals used by the Dashboard breakdown to make math transparent.
        palletPositionsNeeded,           // raw pallet inventory (fp+cp or override)
        palletPositionsOverridden: palletPositionsExplicit,
        grossPalletPositions,            // post-honeycomb (no surge)
        grossShelvingPositions,          // post-honeycomb (no surge)
        designedPositions,
        surgePositions,
        grossPositions,
        floorPositions,
        // Multipliers — surfaced so UI can show "× X% honeycomb" etc.
        honeycombFactor: _buf,
        surgeFactor: _surgeF,
      };
    })(),
    rackLevels: levels,
    shelfLevels,
    sfPerFloorPos,
    sfPerPosition: grossPositions > 0 ? Math.round((totalSqft / grossPositions) * 10) / 10 : 0,
    dock: {
      inboundDoors,
      outboundDoors,
      totalDoors: withSurgeBuffer,
      withSurgeBuffer,
      dockWallOk,
      dockWallRequiredFt,
      dockWallAvailableFt: i.availableWallFt || 0,
      // Provenance — UI can badge values as "explicit" vs "derived from throughput"
      inboundDoorsExplicit: inboundOverride > 0,
      outboundDoorsExplicit: outboundOverride > 0,
      inboundDoorsDerived: inDerived,
      outboundDoorsDerived: outDerived,
    },
    utilization: {
      peak: i.peakUnits || 0,
      avg: i.avgUnits || 0,
      designed: designedPositions,
      utilizationPct,
      warning,
    },
    zoneBreakdown,
    storageDetail: { storeType: i.storeType, layoutDescription },
    // ── Phase 1 redesign — additive sized fields ──
    // All driven by the six new helpers (computeUnitLoad, computeCartonProfile,
    // computeShelvingLocations, computeRackingStructure, computeDockRequirement,
    // computeRequiredFacilitySF). Existing fields above are unchanged.
    unitLoad: _unitLoad,
    cartonProfile: _cartonProfile,
    locations: _locations,
    rackingStructure: _rackingStructure,
    dockRequirement: _dockRequirement,
    requirementsDriven: _requirementsDriven,
    meta: {
      inputs: i,
      normalisedMix: mix,
      mixWasNormalised: mixChanged,
    },
  };
}

/** Human-readable label for storeType. */
export function labelForStoreType(t) {
  return ({
    single: 'Single-Deep Selective',
    double: 'Double-Deep',
    bulk: 'Bulk Floor',
    carton: 'Carton Flow / Shelving',
    mix: 'Mixed Rack + Bulk',
  })[t] || t;
}

// ============================================================
// runScenario — calc-as-service wrapper (port-readiness S10)
// ============================================================
//
// Standardized entry point for external callers (HTTP / MCP / AI
// agents). Wraps sizeFacility in the canonical
// { ok, version, result, errors } contract. Never throws — bad input
// returns ok=false with an explanatory errors array.
//
// WSC's validation surface is small because SIZING_DEFAULTS merges
// into any partial input. The wrapper still rejects clearly broken
// numeric inputs (negative dimensions, non-finite values) so callers
// see a hard error rather than a quietly-normalized 0.
export const ENGINE_VERSION = '1.0.0';

/**
 * Run a Warehouse Sizing scenario.
 * @param {{
 *   peakUnits?: number,
 *   skuCount?: number,
 *   clearHeightFt?: number,
 *   fullPalletPct?: number,
 *   cartonOnPalletPct?: number,
 *   cartonOnShelvingPct?: number,
 *   palletPositionsOverride?: number,
 *   shelvingLocationsOverride?: number,
 *   annualOutboundUnits?: number,
 *   peakDays?: number,
 *   daysOnHand?: number,
 *   [k: string]: any,
 * }} params
 * @returns {{ ok: boolean, version: string, result: any, errors: string[] }}
 */
export function runScenario(params) {
  if (params == null || typeof params !== 'object') params = {};
  const errors = [];

  // Reject obvious garbage: negative volumes, non-finite scalars where supplied.
  const numericFields = [
    'peakUnits', 'skuCount', 'clearHeightFt',
    'fullPalletPct', 'cartonOnPalletPct', 'cartonOnShelvingPct',
    'palletPositionsOverride', 'shelvingLocationsOverride',
    'annualOutboundUnits', 'peakDays', 'daysOnHand',
    'unitsPerPallet', 'cartonsPerPallet', 'unitsPerCartonPal',
    'unitsPerCartonShelv', 'cartonsPerLocation',
  ];
  for (const k of numericFields) {
    const v = params[k];
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      errors.push(`${k} must be a finite number when provided`);
    } else if (n < 0) {
      errors.push(`${k} must be non-negative when provided`);
    }
  }

  if (errors.length) return { ok: false, version: ENGINE_VERSION, result: null, errors };

  try {
    const result = sizeFacility(params);
    return { ok: true, version: ENGINE_VERSION, result, errors: [] };
  } catch (e) {
    return { ok: false, version: ENGINE_VERSION, result: null, errors: [e?.message || String(e)] };
  }
}

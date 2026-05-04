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

  const positionsT = sized?.positions || {};
  const targets = {
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

/**
 * Format a percentage.
 * @param {number} pct
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatPct(pct, decimals = 1) {
  return (pct || 0).toFixed(decimals) + '%';
}

/**
 * Format height in feet.
 * @param {number} ft
 * @returns {string}
 */
export function formatFt(ft) {
  return (ft || 0).toFixed(1) + ' ft';
}

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
  // Other zones
  officePct: 0.05,
  forwardPick: null,       // see ForwardPickInputs
  optionalZones: [],       // [{ label, sqft }]
  customZones: [],         // [{ label, sqft }]
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
  const shelvingPositions = i.cartonsPerLocation > 0
    ? Math.ceil(csCartons / i.cartonsPerLocation) : 0;

  // If caller supplied an engineered pallet-position count, honour it directly
  // (from a slotting study, inventory snapshot, etc.) rather than re-deriving
  // from peakUnits × mix. This is the cleanest way to size to a known inventory.
  const palletPositionsNeeded = (i.totalPalletsOverride && i.totalPalletsOverride > 0)
    ? Math.round(i.totalPalletsOverride)
    : (fullPalletPositions + cartonPalletPositions);
  const palletPositionsExplicit = !!(i.totalPalletsOverride && i.totalPalletsOverride > 0);

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
  const dockDivisor = Math.max(1, i.palletsPerDoorHour) * Math.max(1, i.dockHours);
  const inDerived = Math.max(2, Math.ceil((i.inPalletsDay || 0) / dockDivisor));
  const outDerived = Math.max(2, Math.ceil((i.outPalletsDay || 0) / dockDivisor));
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
  const recvStagingSqft = Math.ceil((i.inPalletsDay || 0) * 0.15 * 18 * stagingFactor);
  const shipStagingSqft = Math.ceil((i.outPalletsDay || 0) * 0.15 * 18 * stagingFactor);

  // ── Additional Zones ──
  const additionalItems = [];
  let additionalSqft = 0;

  // Forward pick area
  if (i.forwardPick && i.forwardPick.enabled) {
    const fp = i.forwardPick;
    const activeFaces = Math.ceil((fp.skus || 0) * (fp.activePickPct || 0) / 100);
    const sfPerLoc = fp.pickType === 'pallet' ? 45 : 12;
    const fwdSqft = activeFaces * sfPerLoc;
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
  const officeSqft = Math.ceil(warehouseOpSqft * (i.officePct || 0));
  const totalSqft = warehouseOpSqft + officeSqft;

  // ── Avg Utilization (for the warning band) ──
  const avgPositions = Math.ceil(
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

  return {
    totalSqft,
    storageSqft,
    palletStorageSqft,
    shelvingStorageSqft,
    dockSqft,
    recvStagingSqft,
    shipStagingSqft,
    officeSqft,
    additionalSqft,
    additionalItems,
    positions: {
      fullPalletPositions,
      cartonPalletPositions,
      shelvingPositions,
      designedPositions,
      surgePositions,
      grossPositions,
      floorPositions,
    },
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

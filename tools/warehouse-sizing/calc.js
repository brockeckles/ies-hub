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
 * @param {import('./types.js?v=20260417-pb').FacilityConfig} facility
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
 * @returns {import('./types.js?v=20260417-pb').StorageCalcResult}
 */
export function computeStorage(facility, zones) {
  const totalSqft = facility.totalSqft || 0;
  const clearH = facility.clearHeight || 0;
  const width = facility.buildingWidth || Math.sqrt(totalSqft * 1.5);
  const depth = facility.buildingDepth || (totalSqft / (width || 1));
  const st = facility.storageType || 'single';

  // Non-storage area
  const nonStorage = (zones.officeSqft || 0) + (zones.receiveStagingSqft || 0) +
    (zones.shipStagingSqft || 0) + (zones.chargingSqft || 0) +
    (zones.repackSqft || 0) + (zones.otherSqft || 0);
  const storageSqft = Math.max(0, totalSqft - nonStorage);

  // Dimensions
  const dims = {
    palletWidth: facility.palletWidth,
    palletDepth: facility.palletDepth,
    palletHeight: facility.palletHeight,
    beamHeight: facility.beamHeight,
    flueSpace: facility.flueSpace,
    topClearance: facility.topClearance,
  };

  const levels = rackLevels(clearH, dims);
  const posH = positionHeightFt(dims);
  const usable = usableHeightFt(clearH, dims.topClearance);
  const bw = bayWidthFt(dims);
  const aisle = facility.aisleWidth || AISLE_WIDTHS[st] || 12;
  const moduleW = aisleModuleWidth(st, facility.aisleWidth, dims);

  // How many aisle modules fit in the storage width?
  const storageWidth = Math.sqrt(storageSqft * 1.5);
  const aisleCount = moduleW > 0 ? Math.floor(storageWidth / moduleW) : 0;

  // How many bays fit along depth?
  const storageDepth = aisleCount > 0 ? storageSqft / storageWidth : 0;
  const bayCount = bw > 0 ? Math.floor(storageDepth / bw) : 0;

  // Positions: aisles × 2 sides × bays × levels
  const depthMultiplier = st === 'double' ? 2 : 1;
  const posPerBay = levels * depthMultiplier;
  const totalPositions = aisleCount * 2 * bayCount * posPerBay;

  const bd = rackDepthFt(st === 'double' ? 'double' : 'single', dims);

  return {
    rackLevels: levels,
    palletPositionsPerBay: posPerBay,
    bayWidth: bw,
    bayDepth: bd,
    aisleCount,
    bayCountPerAisle: bayCount,
    totalPalletPositions: totalPositions,
    storageSqft,
    storageUtilization: totalSqft > 0 ? storageSqft / totalSqft : 0,
    usableHeight: usable,
    positionHeight: posH,
  };
}

// ============================================================
// CAPACITY SUMMARY
// ============================================================

/**
 * Build a full capacity summary combining storage calc with volume inputs.
 * @param {import('./types.js?v=20260417-pb').FacilityConfig} facility
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
 * @param {import('./types.js?v=20260417-pb').VolumeInputs} volumes
 * @returns {import('./types.js?v=20260417-pb').CapacitySummary}
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
  const dockUtil = (facility.dockDoors || 0) > 0
    ? (peakDaily / ((facility.dockDoors || 1) * DOOR_CAPACITY_PER_DAY)) * 100
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
 * @param {import('./types.js?v=20260417-pb').VolumeInputs} volumes
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
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
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
 * @param {import('./types.js?v=20260417-pb').FacilityConfig} facility
 * @returns {import('./types.js?v=20260417-pb').ElevationParams}
 */
export function elevationParams(facility) {
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

  return {
    buildingWidth: facility.buildingWidth || Math.sqrt((facility.totalSqft || 0) * 1.5),
    clearHeight: facility.clearHeight || 0,
    rackLevels: levels,
    positionHeight: positionHeightFt(dims),
    topClearanceFt: (facility.topClearance ?? DEFAULTS.topClearance) / 12,
    storageType: st,
    aisleWidth: facility.aisleWidth || AISLE_WIDTHS[st] || 12,
    rackDepthFt: rackDepthFt(st === 'double' ? 'double' : 'single', dims),
    dockDoors: facility.dockDoors || 0,
  };
}

// ============================================================
// STORAGE TYPE ALLOCATION
// ============================================================

/**
 * Calculate storage positions by type based on allocation percentages.
 * @param {import('./types.js?v=20260417-pb').FacilityConfig} facility
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
 * @returns {{ fullPalletPositions: number, cartonOnPalletPositions: number, cartonOnShelvingPositions: number, totalPositions: number }}
 */
export function calcStorageByType(facility, zones) {
  const storage = computeStorage(facility, zones);
  const totalPos = storage.totalPalletPositions;
  const alloc = zones.storageAllocation || { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 };

  const fullPalletPct = (alloc.fullPallet || 0) / 100;
  const cartonOnPalletPct = (alloc.cartonOnPallet || 0) / 100;
  const cartonOnShelvingPct = (alloc.cartonOnShelving || 0) / 100;

  return {
    fullPalletPositions: Math.round(totalPos * fullPalletPct),
    cartonOnPalletPositions: Math.round(totalPos * cartonOnPalletPct),
    cartonOnShelvingPositions: Math.round(totalPos * cartonOnShelvingPct),
    totalPositions: totalPos,
  };
}

// ============================================================
// DOCK ANALYSIS
// ============================================================

/**
 * Calculate dock door requirements and utilization.
 * @param {import('./types.js?v=20260417-pb').FacilityConfig} facility
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
 * @param {import('./types.js?v=20260417-pb').VolumeInputs} volumes
 * @returns {{ inboundDoorsNeeded: number, outboundDoorsNeeded: number, inboundUtilization: number, outboundUtilization: number, dockSqft: number }}
 */
export function calcDockAnalysis(facility, zones, volumes) {
  const dock = zones.dockConfig || { sided: 'single', inboundDoors: 10, outboundDoors: 12, palletsPerDockHour: 12, dockOperatingHours: 10 };
  const prod = zones.productDimensions || { unitsPerPallet: 48 };
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

  const totalDoors = (dock.sided === 'two')
    ? Math.max(dock.inboundDoors, dock.outboundDoors) * 2
    : Math.max(dock.inboundDoors, dock.outboundDoors);
  const dockSqft = totalDoors * 200; // 200 sqft per door (staging area)

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
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
 * @returns {number} DIOH in days
 */
export function calcDIOH(zones) {
  const pick = zones.forwardPick || { enabled: false, daysInventory: 3, outboundUnitsPerDay: 5000 };
  const avg = zones.avgUnitsPerDay || 350000;

  if (pick.outboundUnitsPerDay <= 0) return 0;
  return (avg * pick.daysInventory) / pick.outboundUnitsPerDay;
}

/**
 * Calculate forward pick area sqft.
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
 * @returns {number} forward pick area in sqft
 */
export function calcForwardPick(zones) {
  const pick = zones.forwardPick || { enabled: false, type: 'carton_flow', skuCount: 2000, daysInventory: 3, outboundUnitsPerDay: 5000 };

  if (!pick.enabled) return 0;

  const dioh = calcDIOH(zones);
  const prod = zones.productDimensions || { unitsPerCartonShelving: 6 };

  // Carton flow facings = SKUs × DIOH × units per carton
  const facings = pick.skuCount * dioh * (prod.unitsPerCartonShelving || 6);

  // Module size by type
  const modulesByType = {
    carton_flow: 9.5,    // sqft per carton flow module
    light_case: 8,       // sqft per light case module
    heavy_case: 12,      // sqft per heavy case module
  };
  const moduleSqft = modulesByType[pick.type] || 9.5;

  return Math.round(facings * moduleSqft);
}

/**
 * Sum optional and custom zone sqft.
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
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
 * @param {import('./types.js?v=20260417-pb').FacilityConfig} facility
 * @param {import('./types.js?v=20260417-pb').ZoneConfig} zones
 * @param {import('./types.js?v=20260417-pb').VolumeInputs} volumes
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

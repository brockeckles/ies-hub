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

/** Dock staging area per door in square feet (door + apron + stage lane) */
export const DOCK_SF_PER_DOOR = 700;

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
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
 * @returns {import('./types.js?v=20260418-sL').StorageCalcResult}
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

  return {
    buildingWidth: facility.buildingWidth || Math.sqrt((facility.totalSqft || 0) * 1.5),
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
 * Calculate storage positions by type based on allocation percentages.
 * @param {import('./types.js?v=20260418-sL').FacilityConfig} facility
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
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
 * Formula: (inbound + outbound) × 1.25 buffer × 700 SF/door × (1.15 if two-sided)
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

  // Dock SF: (inbound + outbound) × 1.25 buffer × 700 SF/door × (1.15 if two-sided)
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
  const pick = zones.forwardPick || { enabled: false, daysInventory: 3, outboundUnitsPerDay: 5000 };
  const avg = zones.avgUnitsPerDay || 350000;

  if (pick.outboundUnitsPerDay <= 0) return 0;
  return (avg * pick.daysInventory) / pick.outboundUnitsPerDay;
}

/**
 * Calculate forward pick area sqft.
 * @param {import('./types.js?v=20260418-sL').ZoneConfig} zones
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

  const palletPositionsNeeded = fullPalletPositions + cartonPalletPositions;

  // Honeycomb buffer
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
  const inboundDoors = Math.max(2, Math.ceil((i.inPalletsDay || 0) / dockDivisor));
  const outboundDoors = Math.max(2, Math.ceil((i.outPalletsDay || 0) / dockDivisor));
  const withSurgeBuffer = Math.ceil((inboundDoors + outboundDoors) * 1.25);

  let dockSqft = withSurgeBuffer * 700;
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

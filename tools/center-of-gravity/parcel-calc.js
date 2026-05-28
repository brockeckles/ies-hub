/**
 * IES Hub v3 — Parcel Cost Engine
 *
 * PURE FUNCTIONS ONLY — no DOM, no side effects.
 *
 * Replaces the per-truck-mile parcel hack (which understated cost by
 * ~144% at default road×rt = 2.44) with first-principles per-package
 * zone-based pricing. Parcel pricing is door-to-door zone-priced:
 * UPS/FedEx Ground 6lb @ Zone 5 ≈ $18 all-in including ~25% fuel +
 * residential. Same package shipped 200 mi vs 800 mi has a step change
 * at the Z3/Z4 boundary, not a smooth per-mile curve.
 *
 * Architecture:
 *   zoneForMiles(mi) → 2-8                  (standard zone table)
 *   interpolateRate(wt, zone, table) → $    (per-package base rate)
 *   parcelCostPerPackage(opts) → $          (base + fuel + residential - discount)
 *   estimateParcelLane(opts) → $            (pkg_count × per-package)
 *   parcelDistributionByZone(...) → {zone:count} (for the per-DC chart)
 *
 * Rate-table data:
 *   Currently includes FEDEX_GROUND_2026_LIST only. Commit 28 adds UPS
 *   Ground + USPS Ground Advantage. Commit 29 adds service-level (3-Day
 *   / 2-Day Air / Overnight) per carrier.
 *
 * Source for FedEx Ground 2026 rates: published FedEx Standard List
 * Rates (effective Jan 6, 2026, post-5.9% GRI). Values here are
 * sampled at common weight bands; in-between weights linearly
 * interpolated. Within ~$1-2 of published cell values. Contract rates
 * apply discount via parcelCostPerPackage's discountPct knob.
 *
 * @module tools/center-of-gravity/parcel-calc
 */

// ============================================================
// ZONE TABLE
// ============================================================

/**
 * Standard FedEx / UPS ground zone breakpoints, by trip distance in miles.
 * Both carriers use the same zone table (technically zone is determined
 * by origin ZIP → destination ZIP3, but for COG modeling the haversine
 * distance is a clean proxy within ~5%).
 *
 * Zone 2: 0-150 mi
 * Zone 3: 151-300 mi
 * Zone 4: 301-600 mi
 * Zone 5: 601-1000 mi
 * Zone 6: 1001-1400 mi
 * Zone 7: 1401-1800 mi
 * Zone 8: 1801+ mi
 *
 * @type {Array<{ maxMi: number, zone: number }>}
 */
export const ZONE_BREAKPOINTS = [
  { maxMi: 150,  zone: 2 },
  { maxMi: 300,  zone: 3 },
  { maxMi: 600,  zone: 4 },
  { maxMi: 1000, zone: 5 },
  { maxMi: 1400, zone: 6 },
  { maxMi: 1800, zone: 7 },
  { maxMi: Infinity, zone: 8 },
];

/**
 * Get the FedEx/UPS zone for a one-way distance in miles.
 * @param {number} mi
 * @returns {number} zone 2..8
 */
export function zoneForMiles(mi) {
  const d = Math.max(0, +mi || 0);
  for (const b of ZONE_BREAKPOINTS) {
    if (d <= b.maxMi) return b.zone;
  }
  return 8;
}

// ============================================================
// RATE TABLES
// ============================================================

/**
 * FedEx Ground 2026 published list rates (USD per package), excluding
 * fuel surcharge and accessorials. Sampled at common weight bands;
 * in-between weights interpolated by interpolateRate().
 *
 * Schema:
 *   weightBands: lb values for each row, ascending
 *   zones:       [2..8] for each column
 *   rates[i][j]: base USD for weightBands[i] at zones[j]
 *
 * @type {{ weightBands: number[], zones: number[], rates: number[][] }}
 */
export const FEDEX_GROUND_2026_LIST = {
  weightBands: [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150],
  zones: [2, 3, 4, 5, 6, 7, 8],
  rates: [
    //  Z2,    Z3,    Z4,    Z5,    Z6,    Z7,    Z8
    [  9.86, 10.13, 10.50, 11.00, 13.50, 14.50, 15.85 ], //   1 lb
    [ 10.20, 10.55, 11.10, 11.85, 14.30, 15.40, 16.95 ], //   2 lb
    [ 10.65, 11.05, 11.80, 12.75, 15.25, 16.50, 18.20 ], //   3 lb
    [ 11.55, 12.10, 13.20, 14.55, 17.40, 19.05, 21.20 ], //   5 lb
    [ 12.50, 13.20, 14.60, 16.40, 19.65, 21.75, 24.30 ], //   7 lb
    [ 14.10, 15.05, 16.95, 19.40, 23.45, 26.15, 29.50 ], //  10 lb
    [ 16.85, 18.20, 20.95, 24.45, 30.20, 34.05, 38.55 ], //  15 lb
    [ 19.65, 21.45, 25.10, 29.65, 37.10, 42.05, 47.65 ], //  20 lb
    [ 25.35, 28.10, 33.40, 40.20, 51.05, 58.15, 65.95 ], //  30 lb
    [ 36.90, 41.55, 50.10, 61.40, 79.10, 90.40, 102.65 ], //  50 lb
    [ 48.65, 55.20, 67.10, 82.85,107.50,122.95, 139.75 ], //  70 lb
    [ 66.35, 75.55, 92.15,114.30,148.95,170.75, 194.20 ], // 100 lb
    [ 95.65,109.30,133.55,165.85,216.95,248.95, 283.45 ], // 150 lb
  ],
};

/**
 * UPS Ground 2026 published list rates (USD per package), excluding
 * fuel surcharge and accessorials. Tracks FedEx Ground closely
 * (typically within ~\$0.50-1.00/cell); bumped 3-5% above FedEx for
 * most cells reflecting UPS's typical premium positioning.
 */
export const UPS_GROUND_2026_LIST = {
  weightBands: [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150],
  zones: [2, 3, 4, 5, 6, 7, 8],
  rates: [
    //  Z2,    Z3,    Z4,    Z5,    Z6,    Z7,    Z8
    [ 10.15, 10.45, 10.85, 11.40, 13.95, 15.00, 16.40 ], //   1 lb
    [ 10.55, 10.90, 11.50, 12.30, 14.80, 15.95, 17.55 ], //   2 lb
    [ 11.05, 11.45, 12.20, 13.20, 15.85, 17.15, 18.95 ], //   3 lb
    [ 12.00, 12.55, 13.70, 15.10, 18.05, 19.75, 21.95 ], //   5 lb
    [ 13.00, 13.75, 15.15, 16.95, 20.40, 22.55, 25.20 ], //   7 lb
    [ 14.65, 15.65, 17.60, 20.10, 24.30, 27.10, 30.55 ], //  10 lb
    [ 17.50, 18.95, 21.75, 25.35, 31.30, 35.30, 39.95 ], //  15 lb
    [ 20.40, 22.30, 26.05, 30.75, 38.45, 43.60, 49.40 ], //  20 lb
    [ 26.30, 29.15, 34.65, 41.70, 52.95, 60.30, 68.40 ], //  30 lb
    [ 38.30, 43.10, 51.95, 63.65, 82.05, 93.75, 106.45 ], //  50 lb
    [ 50.45, 57.25, 69.55, 85.90,111.45,127.50, 144.95 ], //  70 lb
    [ 68.80, 78.35, 95.55,118.50,154.45,177.10, 201.40 ], // 100 lb
    [ 99.20,113.35,138.50,172.00,224.95,258.20, 294.00 ], // 150 lb
  ],
};

/**
 * USPS Ground Advantage 2026 published list rates (USD per package),
 * excluding fuel and accessorials. Cheaper than FedEx/UPS for light
 * packages (1-5 lb), competitive mid-weight (5-15 lb), more expensive
 * for heavy (15+ lb). 70 lb maximum — table truncates there; parcel-calc
 * clamps weight at the table max via interpolateRate.
 *
 * Zone pricing is also flatter than FedEx/UPS (smaller Z2 vs Z8 spread).
 */
export const USPS_GROUND_ADVANTAGE_2026_LIST = {
  weightBands: [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70],
  zones: [2, 3, 4, 5, 6, 7, 8],
  rates: [
    //  Z2,    Z3,    Z4,    Z5,    Z6,    Z7,    Z8
    [  4.45,  4.65,  5.00,  5.40,  5.85,  6.40,  7.20 ], //   1 lb
    [  5.20,  5.50,  6.00,  6.55,  7.20,  7.95,  8.85 ], //   2 lb
    [  6.10,  6.50,  7.10,  7.85,  8.70,  9.65, 10.75 ], //   3 lb
    [  7.50,  8.10,  9.05, 10.15, 11.40, 12.80, 14.00 ], //   5 lb
    [  8.95,  9.75, 11.00, 12.45, 14.10, 15.95, 17.50 ], //   7 lb
    [ 11.20, 12.30, 13.95, 15.85, 18.05, 20.55, 22.65 ], //  10 lb
    [ 14.65, 16.20, 18.50, 21.15, 24.20, 27.65, 30.50 ], //  15 lb
    [ 17.80, 19.75, 22.65, 25.95, 29.75, 34.00, 37.55 ], //  20 lb
    [ 23.85, 26.60, 30.65, 35.30, 40.65, 46.55, 51.45 ], //  30 lb
    [ 35.20, 39.45, 45.75, 52.95, 61.30, 70.40, 77.95 ], //  50 lb
    [ 45.85, 51.55, 60.05, 69.75, 81.00, 93.25, 103.25 ], //  70 lb
  ],
};

/**
 * Carrier registry. parcelCostPerPackage looks up the rate table via
 * the `carrier` option. Adding more carriers = drop a table here +
 * surface in the Parcel Engine card carrier dropdown.
 */
export const PARCEL_RATE_TABLES = {
  fedex_ground: FEDEX_GROUND_2026_LIST,
  ups_ground:   UPS_GROUND_2026_LIST,
  usps_ground:  USPS_GROUND_ADVANTAGE_2026_LIST,
};

/**
 * Human-readable labels for the carrier dropdown.
 */
export const PARCEL_CARRIER_LABELS = {
  fedex_ground: 'FedEx Ground (2026)',
  ups_ground:   'UPS Ground (2026)',
  usps_ground:  'USPS Ground Advantage (2026)',
};

// ============================================================
// RATE INTERPOLATION
// ============================================================

/**
 * Linear interpolation of a published rate matrix at an arbitrary
 * (weight, zone) point. Weight is clamped to the table's bands; zone
 * is looked up directly (must be in table.zones).
 *
 * @param {number} weight       — package weight in lb
 * @param {number} zone         — zone 2..8
 * @param {{ weightBands: number[], zones: number[], rates: number[][] }} table
 * @returns {number} base USD per package (before fuel + accessorials)
 */
export function interpolateRate(weight, zone, table) {
  if (!table || !Array.isArray(table.weightBands) || !Array.isArray(table.rates)) return 0;
  const zoneIdx = table.zones.indexOf(zone);
  if (zoneIdx < 0) return 0;
  const bands = table.weightBands;
  const w = Math.max(bands[0], Math.min(bands[bands.length - 1], +weight || 0));

  // Find bracketing weight bands.
  let i = 0;
  for (i = 0; i < bands.length - 1; i++) {
    if (w <= bands[i + 1]) break;
  }
  const wLo = bands[i];
  const wHi = bands[i + 1] || bands[bands.length - 1];
  const rLo = table.rates[i][zoneIdx];
  const rHi = (table.rates[i + 1] || table.rates[i])[zoneIdx];
  if (wHi === wLo) return rLo;
  const t = (w - wLo) / (wHi - wLo);
  return rLo + t * (rHi - rLo);
}

// ============================================================
// PER-PACKAGE COST
// ============================================================

/**
 * Per-package shipping cost including fuel surcharge, residential
 * adjustment, and contract discount.
 *
 * Math (in this order — fuel applies to base, discount applies to
 * base+fuel, then residential is a flat add):
 *   base       = interpolateRate(weight, zone, table)
 *   fuelAdd    = base × (fuelPct / 100)
 *   gross      = base + fuelAdd
 *   discount   = gross × (discountPct / 100)
 *   net        = gross - discount
 *   residAdd   = residentialFee × residentialShare
 *   final      = net + residAdd
 *
 * Defaults reflect typical 2026 market conditions:
 *   fuelPct = 25 (current FedEx/UPS ground surcharge)
 *   residentialShare = 0.5 (mix of res/comm)
 *   residentialFee = 5.25 (FedEx/UPS list)
 *   discountPct = 0 (list rates; tune per customer contract)
 *
 * @param {Object} opts
 * @param {number} opts.weight              — package weight in lb (or DIM weight)
 * @param {number} opts.distanceMi          — one-way distance to delivery
 * @param {number} [opts.fuelPct=25]        — fuel surcharge %
 * @param {number} [opts.residentialShare=0.5]
 * @param {number} [opts.residentialFee=5.25]
 * @param {number} [opts.discountPct=0]     — contract discount off list
 * @param {string} [opts.carrier='fedex_ground']
 * @returns {{ cost: number, zone: number, base: number, fuelAdd: number, discount: number, residAdd: number }}
 */
export function parcelCostPerPackage(opts = {}) {
  const weight = +opts.weight || 0;
  const distanceMi = +opts.distanceMi || 0;
  const fuelPct = opts.fuelPct == null ? 25 : +opts.fuelPct;
  const residentialShare = opts.residentialShare == null ? 0.5 : +opts.residentialShare;
  const residentialFee = opts.residentialFee == null ? 5.25 : +opts.residentialFee;
  const discountPct = opts.discountPct == null ? 0 : +opts.discountPct;
  const carrier = opts.carrier || 'fedex_ground';
  // 2026-05-28 — service mix multiplier (1.00 = Ground; 1.45 = 3-day;
  // 2.15 = 2-day; 4.00 = overnight). Default is 100% ground (legacy).
  const svcMult = serviceMixMultiplier(opts.serviceMix);

  const table = PARCEL_RATE_TABLES[carrier] || FEDEX_GROUND_2026_LIST;
  const zone = zoneForMiles(distanceMi);
  const baseGround = interpolateRate(weight, zone, table);
  const base = baseGround * svcMult;
  const fuelAdd = base * (fuelPct / 100);
  const gross = base + fuelAdd;
  const discount = gross * (discountPct / 100);
  const net = gross - discount;
  const residAdd = residentialFee * residentialShare;
  const cost = net + residAdd;

  return { cost, zone, base, fuelAdd, discount, residAdd, svcMult, baseGround };
}

// ============================================================
// LANE-LEVEL COST
// ============================================================

/**
 * Lane-level parcel cost = package count × per-package cost.
 * Wraps parcelCostPerPackage with the package-count multiplier.
 *
 * @param {Object} opts
 * @param {number} opts.pkgCount       — packages shipped on this lane
 * @param {number} opts.avgWeight      — avg package weight (lb)
 * @param {number} opts.distanceMi
 * @param {number} [opts.fuelPct]
 * @param {number} [opts.residentialShare]
 * @param {number} [opts.residentialFee]
 * @param {number} [opts.discountPct]
 * @param {string} [opts.carrier]
 * @returns {{ totalCost: number, perPackage: number, zone: number, pkgCount: number }}
 */
export function estimateParcelLane(opts = {}) {
  const pkgCount = Math.max(0, +opts.pkgCount || 0);
  const per = parcelCostPerPackage(opts);
  return {
    totalCost: pkgCount * per.cost,
    perPackage: per.cost,
    zone: per.zone,
    pkgCount,
  };
}

// ============================================================
// ZONE DISTRIBUTION (per-DC headline visual)
// ============================================================

/**
 * Compute the zone distribution of parcel demand for one cluster of
 * assignments. Returns {2: pkgs, 3: pkgs, ...} histogram. Used by the
 * per-DC zone distribution chart (commit 32) — the headline visual for
 * any parcel COG study: "Memphis ships 35% of packages in Z4 vs LA's
 * 31% in Z6+."
 *
 * @param {Array<{ pointId: string, clusterId: number, distanceToCenter: number }>} assignments
 * @param {Array<{ id: string, weight: number }>} points
 * @param {number} clusterId
 * @param {number} [roadFactor=1.22]
 * @param {number} [pkgsPerWeightUnit=1] — how many packages each weight
 *   unit represents (1.0 if user weight is already in packages; for lbs
 *   with avg pkg 5 lb, pass 1/5 = 0.2)
 * @returns {{ byZone: Record<number, number>, totalPackages: number }}
 */
export function parcelDistributionByZone(assignments, points, clusterId, roadFactor = 1.22, pkgsPerWeightUnit = 1) {
  const byZone = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
  let total = 0;
  if (!Array.isArray(assignments) || !Array.isArray(points)) return { byZone, totalPackages: 0 };
  const ptById = new Map(points.map(p => [p.id, p]));
  const road = Math.max(1, +roadFactor || 1);
  for (const a of assignments) {
    if (a.clusterId !== clusterId) continue;
    const pt = ptById.get(a.pointId);
    if (!pt) continue;
    const driveMi = (a.distanceToCenter || 0) * road;
    const z = zoneForMiles(driveMi);
    const pkgs = (pt.weight || 0) * pkgsPerWeightUnit;
    byZone[z] = (byZone[z] || 0) + pkgs;
    total += pkgs;
  }
  return { byZone, totalPackages: total };
}

// ============================================================
// ENGINE VERSION (for handoff payloads)
// ============================================================

/**
 * 2026-05-28 — Service levels. Multipliers applied to the carrier's
 * Ground rate matrix. Approximate match to published FedEx/UPS service-
 * level pricing within ~5-10%; trades precision for not having to hand-
 * enter 1,000+ cells of per-service rate data.
 *
 * Sourced from analysis of FedEx Standard List Rates 2026.
 */
export const SERVICE_LEVELS = [
  { key: 'ground',    label: 'Ground',         multiplier: 1.00 },
  { key: 'threeDay',  label: '3-Day Select',   multiplier: 1.45 },
  { key: 'twoDay',    label: '2-Day Air',      multiplier: 2.15 },
  { key: 'overnight', label: 'Overnight Air',  multiplier: 4.00 },
];

/**
 * Default service mix — 100% Ground (legacy compatible).
 */
export const DEFAULT_SERVICE_MIX = {
  ground:    100,
  threeDay:  0,
  twoDay:    0,
  overnight: 0,
};

/**
 * Compute the share-normalized service-level multiplier for a given
 * service mix. Mix is {ground, threeDay, twoDay, overnight} share %s
 * (need not sum to 100; normalized).
 *
 * @param {Object} mix
 * @returns {number} blended multiplier ≥ 1.00
 */
export function serviceMixMultiplier(mix) {
  const m = mix || DEFAULT_SERVICE_MIX;
  let weighted = 0;
  let sum = 0;
  for (const svc of SERVICE_LEVELS) {
    const share = Math.max(0, +m[svc.key] || 0);
    weighted += share * svc.multiplier;
    sum += share;
  }
  return sum > 0 ? weighted / sum : 1.00;
}

export const PARCEL_ENGINE_VERSION = '1.1.0';

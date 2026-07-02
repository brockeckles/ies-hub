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
// SHARED PRIMITIVES (P1-4, 2026-07-02)
// ============================================================
// Zone table, published 2026 carrier rate tables, and the rate
// interpolator moved to shared/transport-rates.js so COG, NetOpt, and
// Fleet price the same lane identically. Re-exported here so every
// existing consumer of parcel-calc keeps working unchanged.

import {
  ZONE_BREAKPOINTS,
  zoneForMiles,
  FEDEX_GROUND_2026_LIST,
  UPS_GROUND_2026_LIST,
  USPS_GROUND_ADVANTAGE_2026_LIST,
  PARCEL_RATE_TABLES,
  PARCEL_CARRIER_LABELS,
  interpolateRate,
  DEFAULT_ROAD_FACTOR,
} from '../../shared/transport-rates.js?v=20260702-p14a';

export {
  ZONE_BREAKPOINTS,
  zoneForMiles,
  FEDEX_GROUND_2026_LIST,
  UPS_GROUND_2026_LIST,
  USPS_GROUND_ADVANTAGE_2026_LIST,
  PARCEL_RATE_TABLES,
  PARCEL_CARRIER_LABELS,
  interpolateRate,
};

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
  // 2026-05-28 37 — Dimensional weight. Carriers bill on max(actual,
  // volumetric). Multiplier 1.0 = no DIM impact; 1.2 = typical mixed DTC;
  // 1.5-2.5 = light/large items (furniture, exercise gear).
  const dimMult = opts.dimMultiplier == null ? 1.0 : Math.max(1.0, +opts.dimMultiplier);
  const billWeight = weight * dimMult;
  // 2026-05-28 38 — accessorials (DAS, oversize, hazmat surcharge avg).
  const accessorials = Math.max(0, +opts.accessorialsPerPkg || 0);
  const distanceMi = +opts.distanceMi || 0;
  const fuelPct = opts.fuelPct == null ? 25 : +opts.fuelPct;
  const residentialShare = opts.residentialShare == null ? 0.5 : +opts.residentialShare;
  const residentialFee = opts.residentialFee == null ? 5.25 : +opts.residentialFee;
  // 2026-05-28 39 — discount tier resolution. When discountTiers is a
  // non-empty array, look up the matching band for billWeight; else use
  // flat discountPct.
  const flatDisc = opts.discountPct == null ? 0 : +opts.discountPct;
  const tiers = Array.isArray(opts.discountTiers) ? opts.discountTiers : [];
  let discountPct = flatDisc;
  if (tiers.length > 0) {
    // tiers is [{ minWeightLb, discountPct }]; pick highest minWeightLb
    // ≤ billWeight (we use bill weight so DIM-heavy packages get the
    // higher-weight tier discount, matching how carriers bill).
    const sorted = [...tiers].sort((a, b) => (+a.minWeightLb || 0) - (+b.minWeightLb || 0));
    let matched = null;
    for (const t of sorted) {
      if ((opts.weight || 0) * (opts.dimMultiplier == null ? 1 : +opts.dimMultiplier) >= (+t.minWeightLb || 0)) matched = t;
    }
    if (matched) discountPct = +matched.discountPct || 0;
  }
  const carrier = opts.carrier || 'fedex_ground';
  // 2026-05-28 — service mix multiplier (1.00 = Ground; 1.45 = 3-day;
  // 2.15 = 2-day; 4.00 = overnight). Default is 100% ground (legacy).
  const svcMult = serviceMixMultiplier(opts.serviceMix);

  const table = PARCEL_RATE_TABLES[carrier] || FEDEX_GROUND_2026_LIST;
  const zone = zoneForMiles(distanceMi);
  const baseGround = interpolateRate(billWeight, zone, table);
  const base = baseGround * svcMult;
  const fuelAdd = base * (fuelPct / 100);
  const gross = base + fuelAdd;
  const discount = gross * (discountPct / 100);
  const net = gross - discount;
  const residAdd = residentialFee * residentialShare;
  const cost = net + residAdd + accessorials;

  return { cost, zone, base, fuelAdd, discount, residAdd, accessorials, svcMult, baseGround, billWeight };
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
 * @param {number} [roadFactor=DEFAULT_ROAD_FACTOR] — shared/transport-rates.js
 * @param {number} [pkgsPerWeightUnit=1] — how many packages each weight
 *   unit represents (1.0 if user weight is already in packages; for lbs
 *   with avg pkg 5 lb, pass 1/5 = 0.2)
 * @returns {{ byZone: Record<number, number>, totalPackages: number }}
 */
export function parcelDistributionByZone(assignments, points, clusterId, roadFactor = DEFAULT_ROAD_FACTOR, pkgsPerWeightUnit = 1) {
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

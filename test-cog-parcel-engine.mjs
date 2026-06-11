// test-cog-parcel-engine.mjs — first regression net for the COG parcel
// engine (2026-06-10 assessment High #4: "the entire heavy month is
// untested"). The parcel rewrite (zone-priced per-shipment math, DIM,
// discount tiers, service mix) carried the customer-facing numbers with
// zero coverage — Brock caught its three real bugs by hand. These asserts
// pin the engine's documented contracts.
//
// Run:  node test-cog-parcel-engine.mjs

import {
  zoneForMiles,
  interpolateRate,
  parcelCostPerPackage,
  serviceMixMultiplier,
  DEFAULT_SERVICE_MIX,
  FEDEX_GROUND_2026_LIST,
  PARCEL_RATE_TABLES,
} from './tools/center-of-gravity/parcel-calc.js';
import { packageCountFromWeight, estimateBlendedCost } from './tools/center-of-gravity/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function near(a, b, eps = 1e-6, msg = '') { if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── zone model ──────────────────────────────────────────────────────────────
t('zoneForMiles: monotone non-decreasing across the band edges', () => {
  let prev = 0;
  for (const mi of [0, 50, 150, 151, 300, 301, 600, 601, 1000, 1001, 1400, 1401, 1800, 1801, 3000]) {
    const z = zoneForMiles(mi);
    assert(z >= prev, `zone must not decrease: ${mi} mi → Z${z} after Z${prev}`);
    prev = z;
  }
  assert(zoneForMiles(0) >= 1 && zoneForMiles(3000) <= 9, 'zones within sane range');
});

// ── rate interpolation ──────────────────────────────────────────────────────
t('interpolateRate: exact at band edges, between-bands strictly between', () => {
  const tbl = FEDEX_GROUND_2026_LIST;
  const z = tbl.zones[2];
  const b = tbl.weightBands;
  near(interpolateRate(b[1], z, tbl), tbl.rates[1][2], 1e-9, 'exact at band');
  const mid = (b[1] + b[2]) / 2;
  const r = interpolateRate(mid, z, tbl);
  const lo = Math.min(tbl.rates[1][2], tbl.rates[2][2]);
  const hi = Math.max(tbl.rates[1][2], tbl.rates[2][2]);
  assert(r >= lo && r <= hi, `midpoint rate ${r} must lie within [${lo}, ${hi}]`);
});

t('interpolateRate: weight clamped to table bounds (no extrapolation)', () => {
  const tbl = FEDEX_GROUND_2026_LIST;
  const z = tbl.zones[0];
  near(interpolateRate(-5, z, tbl), tbl.rates[0][0], 1e-9, 'below-range clamps to first band');
  const last = tbl.weightBands.length - 1;
  near(interpolateRate(99_999, z, tbl), tbl.rates[last][0], 1e-9, 'above-range clamps to last band');
});

// ── per-package cost composition ────────────────────────────────────────────
t('parcelCostPerPackage: documented order — fuel on base, discount on gross, resid flat', () => {
  const opts = { weight: 10, distanceMi: 700, fuelPct: 20, discountPct: 30, residentialShare: 1, residentialFee: 5.25, carrier: 'fedex_ground' };
  const r = parcelCostPerPackage(opts);
  near(r.fuelAdd, r.base * 0.20, 1e-6, 'fuel = base × 20%');
  near(r.discount, (r.base + r.fuelAdd) * 0.30, 1e-6, 'discount = gross × 30%');
  near(r.residAdd, 5.25, 1e-6, 'residential flat add at share=1');
  near(r.cost, r.base + r.fuelAdd - r.discount + r.residAdd, 1e-6, 'final composition');
});

t('DIM multiplier raises billable weight (never lowers it)', () => {
  const base = parcelCostPerPackage({ weight: 8, distanceMi: 700, fuelPct: 0, residentialShare: 0 });
  const dim = parcelCostPerPackage({ weight: 8, distanceMi: 700, fuelPct: 0, residentialShare: 0, dimMultiplier: 1.5 });
  const dimDown = parcelCostPerPackage({ weight: 8, distanceMi: 700, fuelPct: 0, residentialShare: 0, dimMultiplier: 0.5 });
  assert(dim.cost >= base.cost, 'DIM 1.5 must not be cheaper');
  near(dimDown.cost, base.cost, 1e-9, 'DIM < 1 clamps to 1.0 (cannot bill below actual)');
});

t('discount tiers: heaviest qualifying tier wins over flat discount', () => {
  const tiers = [
    { minWeightLb: 0, discountPct: 10 },
    { minWeightLb: 5, discountPct: 25 },
    { minWeightLb: 20, discountPct: 40 },
  ];
  const r10 = parcelCostPerPackage({ weight: 10, distanceMi: 700, fuelPct: 0, residentialShare: 0, discountTiers: tiers, discountPct: 99 });
  near(r10.discount, r10.base * 0.25, 1e-6, '10-lb pkg lands in the 5-lb tier (25%), flat 99% ignored');
  const r25 = parcelCostPerPackage({ weight: 25, distanceMi: 700, fuelPct: 0, residentialShare: 0, discountTiers: tiers });
  near(r25.discount, r25.base * 0.40, 1e-6, '25-lb pkg lands in the 20-lb tier');
});

// ── service mix + package counts ────────────────────────────────────────────
t('serviceMixMultiplier: pure ground = 1.0; faster service strictly dearer', () => {
  near(serviceMixMultiplier({ ground: 100, threeDay: 0, twoDay: 0, overnight: 0 }), 1.0, 1e-9);
  const mixed = serviceMixMultiplier({ ground: 50, threeDay: 0, twoDay: 30, overnight: 20 });
  assert(mixed > 1.0, `expedited mix must multiply above 1.0, got ${mixed}`);
  assert(serviceMixMultiplier(DEFAULT_SERVICE_MIX) >= 1.0, 'default mix sane');
});

t('packageCountFromWeight: lb path + explicit ratio override', () => {
  near(packageCountFromWeight(1000, 'lb', 10), 100, 1e-6, '1,000 lb @ 10 lb/pkg');
  near(packageCountFromWeight(1000, 'lb', 10, 0.5), 500, 1e-6, 'override ratio wins');
  near(packageCountFromWeight(0, 'lb', 10), 0, 1e-9, 'zero weight → zero pkgs');
});

// ── blended engine mass-conservation (the bug class Brock caught by hand) ──
t('estimateBlendedCost: Σ per-assignment costs === engine totals (truck + parcel)', () => {
  const points = [
    { id: 'p1', lat: 40.7, lng: -74.0, weight: 400_000 },
    { id: 'p2', lat: 41.9, lng: -87.6, weight: 300_000 },
    { id: 'p3', lat: 33.7, lng: -84.4, weight: 300_000 },
  ];
  const mcr = {
    centers: [{ lat: 39.96, lng: -82.99 }],
    assignments: points.map(p => ({ pointId: p.id, clusterId: 0, distanceToCenter: 400 })),
  };
  const config = {
    modeMixEnabled: true,
    modeMix: { tlPct: 70, ltlPct: 0, parcelPct: 30 },
    modeRates: { tlPerMile: 2.85, ltlPerMile: 3.6, parcelPerMile: 4.2 },
    transportCostPerMile: 2.85,
    unitsPerTruck: 25_000, roadFactor: 1.22, roundTripFactor: 2.0,
    weightUnit: 'lb', avgPackageWeightLb: 8,
  };
  const r = estimateBlendedCost(mcr, points, config);
  assert(r.totalCost > 0, 'engine produced a cost');
  near(r.truckCost + r.parcelCost, r.totalCost, 1, 'truck + parcel === total');
  if (Array.isArray(r.costByAssignment) && r.costByAssignment.length) {
    const sum = r.costByAssignment.reduce((s, a) => s + (a.totalCost ?? 0), 0);
    near(sum, r.totalCost, Math.max(1, r.totalCost * 0.001), 'Σ per-assignment === engine total');
  }
  assert(r.parcelDetails && r.parcelDetails.totalPackages > 0, 'parcel details populated when parcel share on');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

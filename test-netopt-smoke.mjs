// test-netopt-smoke.mjs — Engine smoke test for Network Optimization (port-readiness)
// No network, no DOM. Run:  node test-netopt-smoke.mjs

import {
  DEFAULT_RATES,
  DEFAULT_SERVICE,
  NMFC_CLASS_MULTIPLIERS,
  SEASONALITY_PROFILES,
  nmfcMultiplier,
  monthlySharesForProfile,
  blendedLaneCost,
  assignDemand,
} from './tools/network-opt/calc.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}
function approx(label, actual, expected, tol = 0.5) {
  ok(`${label} (got ${actual}, expected ~${expected})`, Math.abs(actual - expected) < tol);
}

console.log('NetOpt engine smoke');

// --- blendedLaneCost ---
{
  const r = blendedLaneCost(500, 30000, { tlPct: 100, ltlPct: 0, parcelPct: 0 });
  ok('blendedLaneCost returns object with 4 cost keys',
     r && typeof r === 'object' && 'tlCost' in r && 'ltlCost' in r && 'parcelCost' in r && 'blendedCost' in r);
  ok('TL-only blend is non-negative', r.blendedCost >= 0);
  ok('TL-only blend equals tlCost', Math.abs(r.blendedCost - r.tlCost) < 1e-6);

  const ltlR = blendedLaneCost(500, 1000, { tlPct: 0, ltlPct: 100, parcelPct: 0 });
  ok('LTL-only blend equals ltlCost', Math.abs(ltlR.blendedCost - ltlR.ltlCost) < 1e-6);
  ok('LTL cost > 0 for non-zero shipment', ltlR.ltlCost > 0);

  const pclR = blendedLaneCost(500, 30, { tlPct: 0, ltlPct: 0, parcelPct: 100 });
  ok('Parcel-only blend equals parcelCost', Math.abs(pclR.blendedCost - pclR.parcelCost) < 1e-6);

  const zero = blendedLaneCost(0, 1000, { tlPct: 100, ltlPct: 0, parcelPct: 0 });
  ok('zero-mile lane returns all-zero costs', zero.blendedCost === 0 && zero.tlCost === 0);
}

// --- nmfcMultiplier ---
ok('class 50 multiplier < class 100', nmfcMultiplier(50) < nmfcMultiplier(100));
ok('class 100 multiplier < class 200', nmfcMultiplier(100) < nmfcMultiplier(200));
ok('class 250 multiplier < class 500', nmfcMultiplier(250) < nmfcMultiplier(500));
ok('null class returns 1.0 fallback', nmfcMultiplier(null) === 1.0);
ok('99999 class snaps to nearest known (500)', nmfcMultiplier(99999) === NMFC_CLASS_MULTIPLIERS[500]);

// --- monthly seasonality shares (return percentages — sum ~100) ---
for (const key of Object.keys(SEASONALITY_PROFILES)) {
  const shares = monthlySharesForProfile(key);
  const sum = shares.reduce((s, v) => s + v, 0);
  approx(`profile "${key}" sums to ~100%`, sum, 100, 1.0);
  ok(`profile "${key}" has 12 months`, shares.length === 12);
}

// --- assignDemand ---
{
  // Two facilities: Memphis + Phoenix. Two demand points: Atlanta + LAX.
  // Each demand should pick its nearer facility.
  const facilities = [
    { id: 'F-MEM', lat: 35.1, lng: -90.0, isOpen: true, capacity: 1e9 },
    { id: 'F-PHX', lat: 33.5, lng: -112.0, isOpen: true, capacity: 1e9 },
  ];
  const demands = [
    { id: 'D-ATL', lat: 33.7, lng: -84.4, annualDemand: 1e6, avgWeight: 1000 },
    { id: 'D-LAX', lat: 34.0, lng: -118.2, annualDemand: 1e6, avgWeight: 1000 },
  ];
  const modeMix = { tlPct: 70, ltlPct: 30, parcelPct: 0 };
  const result = assignDemand(facilities, demands, modeMix);
  ok('assignDemand returns array', Array.isArray(result));
  ok('assignDemand returns one row per demand', result.length === demands.length);
  const atl = result.find(a => a.demandId === 'D-ATL');
  const lax = result.find(a => a.demandId === 'D-LAX');
  ok('Atlanta routes to Memphis (closer)', atl && atl.facilityId === 'F-MEM');
  ok('LAX routes to Phoenix (closer)', lax && lax.facilityId === 'F-PHX');
  ok('every assignment has a finite distanceMiles', result.every(a => Number.isFinite(a.distanceMiles)));
  ok('every assignment has a finite transitDays', result.every(a => Number.isFinite(a.transitDays)));
}

// --- assignDemand: locked-closed facility is skipped ---
{
  const facilities = [
    { id: 'F-NEAR', lat: 41.8, lng: -87.6, isOpen: true, capacity: 1e9 },
    { id: 'F-FAR',  lat: 40.0, lng: -90.0, isOpen: true, capacity: 1e9 },
  ];
  const demands = [{ id: 'D', lat: 41.5, lng: -87.0, annualDemand: 1e5, avgWeight: 1000 }];
  // Lock the near facility closed → demand must go to F-FAR.
  const sc = { ...DEFAULT_SERVICE, lockedClosedIds: ['F-NEAR'] };
  const result = assignDemand(facilities, demands, { tlPct: 100, ltlPct: 0, parcelPct: 0 }, DEFAULT_RATES, sc);
  ok('lockedClosed facility excluded from ranking', result[0] && result[0].facilityId === 'F-FAR');
}

// --- assignDemand: empty inputs ---
ok('empty facilities → empty result', assignDemand([], [{ id: 'd', lat: 33, lng: -84, annualDemand: 100 }], { tlPct: 100, ltlPct: 0, parcelPct: 0 }).length === 0);
ok('empty demands → empty result', assignDemand([{ id: 'f', lat: 35, lng: -90, isOpen: true }], [], { tlPct: 100, ltlPct: 0, parcelPct: 0 }).length === 0);

console.log(`\nNetOpt smoke: ${passed}/${passed + failed} passed${failed ? ', failures:' : ''}`);
fails.forEach(f => console.log(`  - ${f}`));
process.exit(failed ? 1 : 0);

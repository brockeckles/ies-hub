// test-cog-smoke.mjs — Engine smoke test for Center of Gravity (port-readiness)
// No network, no DOM. Run:  node test-cog-smoke.mjs

import {
  DEFAULT_CONFIG,
  WEIGHT_UNIT_OPTIONS,
  getWeightUnitMeta,
  haversine,
  computeCog,
  kMeansCog,
  estimateTransportCost,
  sensitivityAnalysis,
  capWeightsByPercentile,
  CITY_CENTROIDS,
  findNearestCity,
} from './tools/center-of-gravity/calc.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}
function approx(label, a, e, tol = 1.0) {
  ok(`${label} (got ${a}, expected ~${e})`, Math.abs(a - e) < tol);
}

console.log('Center of Gravity engine smoke');

// --- haversine ---
{
  // Memphis (35.15, -90.05) to Atlanta (33.75, -84.40) is ~340 miles.
  const d = haversine(35.15, -90.05, 33.75, -84.40);
  approx('Memphis→Atlanta ~340 miles', d, 340, 30);
  ok('haversine is symmetric',
     Math.abs(haversine(35.15, -90.05, 33.75, -84.40) - haversine(33.75, -84.40, 35.15, -90.05)) < 1e-9);
  ok('haversine(p,p) === 0', haversine(40, -90, 40, -90) === 0);
}

// --- computeCog: 3 demand points (Chicago / NYC / LA equally weighted) ---
{
  const points = [
    { id: 'CHI', lat: 41.8, lng: -87.6, weight: 100 },
    { id: 'NYC', lat: 40.7, lng: -74.0, weight: 100 },
    { id: 'LAX', lat: 34.0, lng: -118.2, weight: 100 },
  ];
  const r = computeCog(points);
  ok('computeCog returns lat/lng/totalWeight', Number.isFinite(r.lat) && Number.isFinite(r.lng) && r.totalWeight === 300);
  // Geometric centroid should land roughly in central/southwestern US.
  ok('cog lat between min and max input lats', r.lat >= 34 && r.lat <= 42);
  ok('cog lng between min and max input lngs', r.lng >= -118.5 && r.lng <= -73.5);
  ok('avgWeightedDistance is non-negative', r.avgWeightedDistance >= 0);
  ok('nearestCity is a string', typeof r.nearestCity === 'string');
}

// --- computeCog: weighted (heavy CHI pulls COG north) ---
{
  const balanced = computeCog([
    { id: 'CHI', lat: 41.8, lng: -87.6, weight: 100 },
    { id: 'DAL', lat: 32.8, lng: -96.8, weight: 100 },
  ]);
  const chiHeavy = computeCog([
    { id: 'CHI', lat: 41.8, lng: -87.6, weight: 1000 },
    { id: 'DAL', lat: 32.8, lng: -96.8, weight: 100 },
  ]);
  ok('Heavier Chicago weight pulls COG north', chiHeavy.lat > balanced.lat);
}

// --- computeCog: empty + all-zero weights ---
{
  const empty = computeCog([]);
  ok('empty point set returns 0/0/0', empty.lat === 0 && empty.lng === 0 && empty.totalWeight === 0);

  const zeros = computeCog([
    { id: 'A', lat: 40, lng: -90, weight: 0 },
    { id: 'B', lat: 30, lng: -100, weight: 0 },
  ]);
  ok('all-zero weights falls back to geometric centroid (avg)', Math.abs(zeros.lat - 35) < 1e-6 && Math.abs(zeros.lng - -95) < 1e-6);
  ok('zero-weight fallback flags unweightedFallback=true', zeros.unweightedFallback === true);
}

// --- kMeansCog ---
{
  const points = [
    { id: 'a', lat: 40, lng: -120, weight: 100 },  // West cluster
    { id: 'b', lat: 41, lng: -119, weight: 100 },
    { id: 'c', lat: 42, lng: -121, weight: 100 },
    { id: 'd', lat: 40, lng: -80, weight: 100 },   // East cluster
    { id: 'e', lat: 41, lng: -79, weight: 100 },
    { id: 'f', lat: 42, lng: -81, weight: 100 },
  ];
  const r = kMeansCog(points, 2, 100);
  ok('kMeansCog returns k centers', r.centers.length === 2);
  ok('kMeansCog assigns every point', r.assignments.length === points.length);
  ok('every assignment has a clusterId in [0,k)', r.assignments.every(a => a.clusterId >= 0 && a.clusterId < 2));
  // The two centers should split East-West: one ≈ -120, one ≈ -80.
  const lngs = r.centers.map(c => c.lng).sort((a, b) => a - b);
  ok('two-cluster lngs split East-West', lngs[0] < -100 && lngs[1] > -100);
  ok('k clamps to point count when k > N', kMeansCog(points, 999, 10).centers.length === points.length);
  ok('k=0 returns empty result', kMeansCog(points, 0).centers.length === 0);
}

// --- estimateTransportCost ---
{
  const points = [
    { id: 'a', lat: 41.8, lng: -87.6, weight: 50000 },
    { id: 'b', lat: 33.0, lng: -97.0, weight: 50000 },
  ];
  const cogResult = kMeansCog(points, 1, 100);
  const cost = estimateTransportCost(cogResult, points, 2.85, 25000);
  ok('estimateTransportCost returns totalCost > 0', cost.totalCost > 0);
  ok('avgCostPerUnit is positive', cost.avgCostPerUnit > 0);
  ok('totalTruckloads = totalWeight/capacity = 100000/25000 = 4', Math.abs(cost.totalTruckloads - 4) < 1e-6);
}

// --- sensitivityAnalysis: more centers should reduce avgWeightedDistance ---
{
  const points = Array.from({ length: 20 }, (_, i) => ({
    id: 'p' + i,
    lat: 35 + Math.random() * 10,
    lng: -100 + Math.random() * 30,
    weight: 1000 + Math.random() * 1000,
  }));
  const sens = sensitivityAnalysis(points, 3);
  ok('sensitivity returns 3 rows (k=1..3)', sens.length === 3);
  // Adding centers should monotonically reduce total weighted distance (or stay equal).
  let monotonic = true;
  for (let i = 1; i < sens.length; i++) if (sens[i].totalWeightedDistance > sens[i-1].totalWeightedDistance + 1e-3) monotonic = false;
  ok('totalWeightedDistance is monotone non-increasing as k grows', monotonic);
}

// --- capWeightsByPercentile ---
{
  const pts = [
    { id: 'a', lat: 40, lng: -90, weight: 1 },
    { id: 'b', lat: 40, lng: -90, weight: 1 },
    { id: 'c', lat: 40, lng: -90, weight: 1 },
    { id: 'd', lat: 40, lng: -90, weight: 100 },
  ];
  const capped = capWeightsByPercentile(pts, 75);
  ok('cap returns same length', capped.length === 4);
  ok('outlier weight is reduced', capped[3].weight < 100);
}

// --- findNearestCity ---
{
  const c = findNearestCity(41.8, -87.6);  // Chicago
  ok('findNearestCity returns a string name', typeof c === 'string' && c.length > 0);
}

ok('WEIGHT_UNIT_OPTIONS includes pallets / units / lbs etc.', WEIGHT_UNIT_OPTIONS.length >= 3);
ok('CITY_CENTROIDS has at least 50 cities', CITY_CENTROIDS.length >= 50);

console.log(`\nCOG smoke: ${passed}/${passed + failed} passed${failed ? ', failures:' : ''}`);
fails.forEach(f => console.log(`  - ${f}`));
process.exit(failed ? 1 : 0);

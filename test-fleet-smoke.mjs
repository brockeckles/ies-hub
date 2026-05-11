// test-fleet-smoke.mjs — Engine smoke test for Fleet Modeler (port-readiness)
// No network, no DOM. Run:  node test-fleet-smoke.mjs

import {
  DEFAULT_VEHICLES,
  ATRI_2024_CPM,
  bestFitVehicle,
  tripsPerWeek,
  roundTripHours,
  assignLanes,
  computeFleetComposition,
  analyzeFleet,
  computeAtriBenchmark,
  calcBreakEven,
} from './tools/fleet-modeler/calc.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

console.log('Fleet Modeler engine smoke');

// --- bestFitVehicle (uses maxPayloadLbs/maxCubeFt3) ---
{
  const v = bestFitVehicle(2000, 100);
  ok('bestFitVehicle returns a vehicle for small payload', v && v.maxPayloadLbs >= 2000);
  const big = bestFitVehicle(40000, 2500);
  ok('bestFitVehicle picks something big enough for full TL', big && big.maxPayloadLbs >= 40000);
  const tooBig = bestFitVehicle(999999, 999999);
  // Falls back to largest enabled vehicle rather than returning null when all candidates fail.
  ok('bestFitVehicle returns the largest vehicle as fallback', tooBig && tooBig.maxPayloadLbs === 48000);
}

// --- tripsPerWeek (semantics: returns 0 if no shipments; returns shipments if no weight; trips per cap otherwise) ---
{
  ok('tripsPerWeek: zero shipments returns 0', tripsPerWeek(0, 100, 50000) === 0);
  ok('tripsPerWeek: zero weight returns shipments as-is', tripsPerWeek(100, 0, 50000) === 100);
  ok('tripsPerWeek caps trips when payload < shipment weight (1 trip/ship)',
     tripsPerWeek(100, 1000, 500) === 100);
ok('tripsPerWeek packs shipments into trips when payload covers many',
     tripsPerWeek(100, 500, 2000) === 25);
}

// --- roundTripHours ---
ok('500-mi RT at 50 mph = 20 hours', Math.abs(roundTripHours(500, 50) - 20) < 0.01);
ok('default speed of 50 used when omitted', Math.abs(roundTripHours(250) - 10) < 0.01);
ok('zero miles = zero hours', roundTripHours(0) === 0);

// --- assignLanes ---
{
  const lanes = [
    { id: 'L1', origin: 'Memphis', dest: 'Atlanta', distanceMiles: 380, weeklyShipments: 10, avgWeightLbs: 25000, avgCubeFt3: 1500 },
    { id: 'L2', origin: 'Phoenix', dest: 'LA',       distanceMiles: 370, weeklyShipments: 5,  avgWeightLbs: 5000,  avgCubeFt3: 200 },
  ];
  const assignments = assignLanes(lanes);
  ok('assignLanes returns array', Array.isArray(assignments));
  ok('one assignment per lane', assignments.length === lanes.length);
  ok('each assignment names a vehicle (has vehicleId)', assignments.every(a => a.vehicleId));
  ok('each assignment computes trips/week >= 0', assignments.every(a => a.tripsPerWeek >= 0));
  ok('each assignment computes annualMiles > 0', assignments.every(a => a.annualMiles > 0));
}

// --- computeFleetComposition ---
{
  const lanes = [
    { id: 'L1', origin: 'A', dest: 'B', distanceMiles: 380, weeklyShipments: 10, avgWeightLbs: 25000, avgCubeFt3: 1500 },
  ];
  const assignments = assignLanes(lanes);
  const comp = computeFleetComposition(assignments);
  ok('fleet composition is an array', Array.isArray(comp));
  ok('composition reports unitsNeeded for each vehicle group', comp.every(g => Number.isFinite(g.unitsNeeded)));
  ok('composition reports annualMiles per group', comp.every(g => Number.isFinite(g.annualMiles) && g.annualMiles > 0));
}

// --- analyzeFleet (top-level) ---
{
  const lanes = [
    { id: 'L1', origin: 'X', dest: 'Y', distanceMiles: 300, weeklyShipments: 8, avgWeightLbs: 20000, avgCubeFt3: 1000 },
  ];
  const result = analyzeFleet(lanes);
  ok('analyzeFleet returns top-level totals', Number.isFinite(result.totalVehicles) && result.totalVehicles >= 1);
  ok('analyzeFleet reports totalAnnualMiles > 0', result.totalAnnualMiles > 0);
  ok('analyzeFleet reports totalAnnualCost > 0', result.totalAnnualCost > 0);
  ok('analyzeFleet returns 3-way comparison', result.comparison &&
     Number.isFinite(result.comparison.private) &&
     Number.isFinite(result.comparison.dedicated) &&
     Number.isFinite(result.comparison.carrier));
  ok('avgCostPerMile is positive when miles > 0', result.avgCostPerMile > 0);
}

// --- ATRI benchmark ---
{
  const b = computeAtriBenchmark(2.10);
  ok('ATRI benchmark returns deltaPct (model > baseline ⇒ positive)', b && b.deltaPct > 0);
  const b2 = computeAtriBenchmark(1.80);
  ok('ATRI delta: model < baseline ⇒ negative', b2.deltaPct < 0);
}

// --- Break-even ---
{
  const be = calcBreakEven({ privateCost: 600000, dedicatedCost: 720000, carrierCost: 700000, totalAnnualMiles: 350000 });
  ok('breakEven returns object', be && typeof be === 'object');
}

ok('ATRI_2024_CPM is the documented $1.946 baseline', Math.abs(ATRI_2024_CPM - 1.946) < 1e-6);
ok('DEFAULT_VEHICLES has 5 ATRI-style classes', DEFAULT_VEHICLES.length === 5);

console.log(`\nFleet smoke: ${passed}/${passed + failed} passed${failed ? ', failures:' : ''}`);
fails.forEach(f => console.log(`  - ${f}`));
process.exit(failed ? 1 : 0);

// test-netopt-shipment-model.mjs — regression net for 2026-06-10 High #6:
// "NetOpt transport cost has incoherent units."
//
// Pre-fix: annual transport = blendedCost × (annualDemand / 52) — a per-
// shipment cost times a number that was neither shipments nor weight. The
// frequency machinery (FREQUENCY_PER_WEEK / freqPerWeekForBucket) existed
// for exactly this and was never consumed; pushToFleet read annualDemand/52
// as WEEKLY SHIPMENTS under a contradictory interpretation; runScenario
// summed a nonexistent `a.cost` field and always returned totalCost = 0.
//
// Post-fix shipment-build model:
//   shipmentsPerYear = freqPerWeek(frequency) × 52
//   shipmentWeight   = avgWeight ?? unitsPerShipment × lbsPerUnit ?? 25
//   TL leg           = ceil(weight / tlCapacityLbs) trucks × lane TL cost
//   parcel leg       = ceil(weight / pkgWeight) packages × per-pkg cost
//   annualTransport  = Σ blendedCost × shipmentsPerYear
//
// Run:  node test-netopt-shipment-model.mjs

import {
  DEFAULT_RATES,
  shipmentsPerYearForDemand,
  shipmentProfileForDemand,
  blendedLaneCost,
  tlCost,
  parcelCost,
  evaluateScenario,
  runScenario,
} from './tools/network-opt/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function near(a, b, eps = 0.5, msg = '') {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const TL_ONLY = { tlPct: 100, ltlPct: 0, parcelPct: 0 };
const PCL_ONLY = { tlPct: 0, ltlPct: 0, parcelPct: 100 };

// ── shipment cadence ────────────────────────────────────────────────────────
t('shipmentsPerYear: weekly=52, biweekly=26, daily=260, explicit wins', () => {
  near(shipmentsPerYearForDemand({ frequency: 'weekly' }), 52);
  near(shipmentsPerYearForDemand({ frequency: 'biweekly' }), 26);
  near(shipmentsPerYearForDemand({ frequency: 'daily' }), 260);
  near(shipmentsPerYearForDemand({}), 52, 0.5, 'default = weekly');
  near(shipmentsPerYearForDemand({ frequency: 'monthly', shipmentsPerWeek: 3 }), 156, 0.5, 'explicit shipmentsPerWeek wins');
});

t('shipment profile: weight resolution order (avgWeight > lbsPerUnit > 25)', () => {
  const d = { annualDemand: 520_000, frequency: 'weekly' };
  const p1 = shipmentProfileForDemand({ ...d, avgWeight: 40_000 });
  near(p1.unitsPerShipment, 10_000); near(p1.shipmentWeightLbs, 40_000);
  assert(p1.weightSource === 'avgWeight', 'explicit avgWeight wins');
  const p2 = shipmentProfileForDemand(d, { lbsPerUnit: 4 });
  near(p2.shipmentWeightLbs, 40_000, 0.5, 'derived = 10,000 units × 4 lbs');
  assert(p2.weightSource === 'lbsPerUnit', 'lbsPerUnit path');
  const p3 = shipmentProfileForDemand(d);
  near(p3.shipmentWeightLbs, 25, 0.5, 'legacy fallback');
  assert(p3.weightSource === 'fallback25', 'fallback flagged for sanity card');
});

// ── hand-computed TL lane ───────────────────────────────────────────────────
// 1,000 mi East→East lane (no regional surcharge): 1,000 × 2.85 × 1.12 = $3,192/truck
t('TL leg: hand-computed single-truck lane', () => {
  const c = blendedLaneCost(1000, 40_000, TL_ONLY, DEFAULT_RATES, -80, -85, 40, 35);
  near(c.tlCost, 3_192, 0.5, '1 truck × $3,192');
  assert(c.trucksPerShipment === 1, 'one dry van for 40K lbs');
  near(c.blendedCost, 3_192, 0.5);
});

t('TL leg: 90K-lb shipment takes 2 trucks (weight-honest)', () => {
  const c = blendedLaneCost(1000, 90_000, TL_ONLY, DEFAULT_RATES, -80, -85, 40, 35);
  assert(c.trucksPerShipment === 2, `expected 2 trucks, got ${c.trucksPerShipment}`);
  near(c.tlCost, 6_384, 0.5, '2 × $3,192');
});

t('parcel leg: 500-lb shipment splits into 20 × 25-lb packages', () => {
  const c = blendedLaneCost(1000, 500, PCL_ONLY, DEFAULT_RATES, -80, -85, 40, 35);
  assert(c.pkgsPerShipment === 20, `expected 20 pkgs, got ${c.pkgsPerShipment}`);
  const perPkg = parcelCost(25, 1000, DEFAULT_RATES.parcelZoneRates, DEFAULT_RATES.fuelSurcharge);
  near(c.parcelCost, perPkg * 20, 0.5, '20 × per-package cost');
});

// ── annual rollup: cadence drives cost ──────────────────────────────────────
function oneLaneScenario(frequency, avgWeight = 40_000) {
  const facilities = [{ id: 'f1', name: 'Columbus DC', lat: 39.96, lng: -82.99, fixedCost: 0, variableCost: 0, isOpen: true }];
  const demands = [{ id: 'd1', zip3: '100', lat: 40.71, lng: -74.00, annualDemand: 520_000, avgWeight, frequency, maxDays: 5 }];
  return evaluateScenario('lane', facilities, demands, TL_ONLY, DEFAULT_RATES, { globalMaxDays: 5 });
}

t('annual transport = blendedCost × shipmentsPerYear (weekly lane)', () => {
  const s = oneLaneScenario('weekly');
  const a = s.assignments[0];
  near(a.shipmentsPerYear, 52);
  near(a.annualTransportCost, a.blendedCost * 52, 0.5, 'per-lane rollup');
  near(s.costBreakdown.transport, a.annualTransportCost, 0.5, 'scenario rollup = Σ lanes');
  near(s.totalCost, s.costBreakdown.transport, 0.5, 'no facility/handling cost in fixture');
});

t('frequency is a real lever: biweekly consolidation halves a fixed-weight TL lane', () => {
  const weekly = oneLaneScenario('weekly');
  const biweekly = oneLaneScenario('biweekly');
  const daily = oneLaneScenario('daily');
  near(biweekly.totalCost, weekly.totalCost / 2, 1, 'half the shipments, same per-shipment cost');
  near(daily.totalCost, weekly.totalCost * 5, 1, '5× the shipments');
  assert(daily.totalCost > weekly.totalCost && weekly.totalCost > biweekly.totalCost, 'monotone in cadence');
});

t('old-formula divergence is material (the bug was real)', () => {
  const s = oneLaneScenario('weekly');
  const a = s.assignments[0];
  const oldFormula = a.blendedCost * (520_000 / 52); // pre-fix math
  assert(Math.abs(oldFormula - a.annualTransportCost) / a.annualTransportCost > 10,
    'pre-fix number should differ by >10× on this lane — if not, this test fixture lost its teeth');
});

// ── runScenario wrapper honesty ─────────────────────────────────────────────
t('runScenario: totalCost real and ties to evaluateScenario (was always 0)', () => {
  const facilities = [{ id: 'f1', name: 'Columbus DC', lat: 39.96, lng: -82.99, fixedCost: 250_000, variableCost: 0.1, isOpen: true }];
  const demands = [{ id: 'd1', zip3: '100', lat: 40.71, lng: -74.00, annualDemand: 520_000, avgWeight: 40_000, frequency: 'weekly', maxDays: 5 }];
  const r = runScenario({ facilities, demands, modeMix: TL_ONLY, serviceConfig: { globalMaxDays: 5 } });
  assert(r.ok, 'wrapper ok');
  assert(r.result.totalCost > 0, 'totalCost must be non-zero');
  const direct = evaluateScenario('direct', facilities, demands, TL_ONLY, DEFAULT_RATES, { globalMaxDays: 5 });
  near(r.result.totalCost, direct.totalCost, 0.5, 'wrapper === engine');
  near(r.result.costBreakdown.facility, 250_000, 0.5, 'facility fixed cost present');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

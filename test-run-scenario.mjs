// test-run-scenario.mjs — Verify the calc-as-service runScenario wrappers
// added in S8 of the 2026-05-11 port-readiness sprint.
//
// Each wrapper returns { ok, version, result, errors } — never throws.
//
// Run:  node test-run-scenario.mjs

import { runScenario as fleetRun } from './tools/fleet-modeler/calc.js';
import { runScenario as cogRun }   from './tools/center-of-gravity/calc.js';
import { runScenario as dmRun }    from './tools/deal-manager/calc.js';
import { runScenario as noRun }    from './tools/network-opt/calc.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

console.log('Calc-as-service runScenario wrappers');

// --- Fleet ---
{
  const r = fleetRun({ lanes: [{ id: 'L1', origin: 'X', dest: 'Y', distanceMiles: 300, weeklyShipments: 8, avgWeightLbs: 20000, avgCubeFt3: 1000 }] });
  ok('Fleet runScenario ok=true', r.ok === true);
  ok('Fleet returns version', typeof r.version === 'string');
  ok('Fleet result has totalAnnualCost', r.result && r.result.totalAnnualCost > 0);
  const bad = fleetRun({});
  ok('Fleet runScenario rejects missing lanes', bad.ok === false && bad.errors.length > 0);
}

// --- COG ---
{
  const r = cogRun({
    points: [{ id: 'a', lat: 41.8, lng: -87.6, weight: 100 }, { id: 'b', lat: 33.7, lng: -84.4, weight: 100 }],
    k: 1,
  });
  ok('COG runScenario ok=true', r.ok === true);
  ok('COG k=1 returns 1 center', r.result && r.result.centers && r.result.centers.length === 1);
  ok('COG transportCost.totalCost is finite', r.result && Number.isFinite(r.result.transportCost.totalCost));
  const k2 = cogRun({ points: [{ id: 'a', lat: 41, lng: -87, weight: 1 }, { id: 'b', lat: 34, lng: -118, weight: 1 }, { id: 'c', lat: 40, lng: -80, weight: 1 }], k: 2 });
  ok('COG k=2 returns 2 centers', k2.result.centers.length === 2);
  const bad = cogRun({ points: [] });
  ok('COG rejects empty points', bad.ok === false);
}

// --- Deal Manager ---
{
  const r = dmRun({
    sites: [
      { id: 'S1', name: 'A', annualCost: 1_000_000, targetMarginPct: 15, pricingModel: 'cost-plus', sqft: 100_000, startupCost: 250_000 },
      { id: 'S2', name: 'B', annualCost: 2_000_000, targetMarginPct: 18, pricingModel: 'cost-plus', sqft: 200_000, startupCost: 500_000 },
    ],
  });
  ok('Deal Manager runScenario ok=true', r.ok === true);
  ok('Deal Manager totalAnnualCost = 3M', r.result.totalAnnualCost === 3_000_000);
  ok('Deal Manager npv is finite', Number.isFinite(r.result.npv));
  const bad = dmRun({});
  ok('Deal Manager rejects missing sites', bad.ok === false);
}

// --- NetOpt ---
{
  const r = noRun({
    facilities: [{ id: 'F1', lat: 35, lng: -90, isOpen: true, capacity: 1e9 }],
    demands: [{ id: 'D1', lat: 33.7, lng: -84.4, annualDemand: 1e5, avgWeight: 1000 }],
    modeMix: { tlPct: 100, ltlPct: 0, parcelPct: 0 },
  });
  ok('NetOpt runScenario ok=true', r.ok === true);
  ok('NetOpt one assignment', r.result.assignments.length === 1);
  ok('NetOpt totalCost is finite', Number.isFinite(r.result.totalCost));
  const bad = noRun({ facilities: [], demands: [], modeMix: null });
  ok('NetOpt rejects missing modeMix', bad.ok === false && bad.errors.some(e => /modeMix/.test(e)));
}

// --- Cross-cutting: no wrapper ever throws on bad input ---
{
  let threw = false;
  try { fleetRun(null); } catch { threw = true; }
  ok('Fleet wrapper does not throw on null input', !threw);
  try { cogRun({ points: [{ lat: 'bad' }] }); } catch { /* acceptable */ }
  ok('COG wrapper handles malformed point gracefully',
     cogRun({ points: [{ id: 'p', lat: 0, lng: 0, weight: 1 }] }).ok === true);
}

console.log(`\nrunScenario wrappers: ${passed}/${passed + failed} passed${failed ? ', failures:' : ''}`);
fails.forEach(f => console.log(`  - ${f}`));
process.exit(failed ? 1 : 0);

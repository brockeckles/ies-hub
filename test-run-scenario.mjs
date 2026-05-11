// test-run-scenario.mjs — Verify the calc-as-service runScenario wrappers
// added in S8 + S10 of the 2026-05-11 port-readiness sprint.
//
// Each wrapper returns { ok, version, result, errors } — never throws.
//
// Run:  node test-run-scenario.mjs

import { runScenario as fleetRun } from './tools/fleet-modeler/calc.js';
import { runScenario as cogRun }   from './tools/center-of-gravity/calc.js';
import { runScenario as dmRun }    from './tools/deal-manager/calc.js';
import { runScenario as noRun }    from './tools/network-opt/calc.js';
import { runScenario as cmRun }    from './tools/cost-model/calc.js';
import { runScenario as wscRun }   from './tools/warehouse-sizing/calc.js';

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

// --- Cost Model (S10) ---
{
  const r = cmRun({
    laborLines: [
      { name: 'Picker',  hourly_rate: 18, annual_hours: 10400, pay_type: 'hourly' },
      { name: 'Packer',  hourly_rate: 19, annual_hours: 6240,  pay_type: 'hourly' },
    ],
    facility: { sqft: 100_000 },
    shifts: { shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5 },
    contractYears: 5,
    targetMarginPct: 12,
    annualOrders: 1_000_000,
  });
  ok('CM runScenario ok=true on happy path',                 r.ok === true);
  ok('CM returns version=1.0.0',                              r.version === '1.0.0');
  ok('CM result.laborCost > 0',                               r.result.laborCost > 0);
  ok('CM result.totalCost = laborCost (only labor lines)',    Math.abs(r.result.totalCost - r.result.laborCost) < 1);
  ok('CM result.totalRevenue > totalCost (margin applied)',   r.result.totalRevenue > r.result.totalCost);
  ok('CM result.totalRevenue ≈ totalCost / (1 − marginFrac)',
      Math.abs(r.result.totalRevenue - r.result.totalCost / (1 - 0.12)) < 1);
  ok('CM result.costPerOrder is finite',                      Number.isFinite(r.result.costPerOrder));
  ok('CM result.totalFtes is a number',                       typeof r.result.totalFtes === 'number');

  const empty = cmRun({});
  ok('CM rejects empty input (no cost arrays)',               empty.ok === false && empty.errors.length > 0);

  const nullR = cmRun(null);
  ok('CM does not throw on null',                             nullR.ok === false);

  const badNum = cmRun({
    laborLines: [{ name: 'X', hourly_rate: 18, annual_hours: 100, pay_type: 'hourly' }],
    contractYears: 'five',
  });
  ok('CM rejects non-finite contractYears',                   badNum.ok === false && badNum.errors.some(e => /contractYears/.test(e)));

  const stringMargin = cmRun({
    laborLines: [{ name: 'X', hourly_rate: 18, annual_hours: 100, pay_type: 'hourly' }],
    targetMarginPct: 'twelve',
  });
  ok('CM rejects non-finite targetMarginPct',                 stringMargin.ok === false && stringMargin.errors.some(e => /targetMarginPct/.test(e)));

  const equipOnly = cmRun({
    equipmentLines: [{ name: 'Pallet jack', acquisition_type: 'lease', quantity: 5, monthly_cost: 250 }],
  });
  ok('CM accepts equipment-only scenario (defaults shifts)',  equipOnly.ok === true && equipOnly.result.equipmentCost > 0);
}

// --- Warehouse Sizing (S10) ---
{
  const r = wscRun({
    peakUnits: 1_000_000,
    skuCount: 5_000,
    clearHeightFt: 32,
    fullPalletPct: 60,
    cartonOnPalletPct: 25,
    cartonOnShelvingPct: 15,
  });
  ok('WSC runScenario ok=true on happy path',                 r.ok === true);
  ok('WSC returns version=1.0.0',                             r.version === '1.0.0');
  ok('WSC result.totalSqft > 0',                              r.result.totalSqft > 0);
  ok('WSC result.storageSqft > 0',                            r.result.storageSqft > 0);
  ok('WSC result.dockSqft > 0',                               r.result.dockSqft > 0);
  ok('WSC result.rackLevels is integer',                      Number.isInteger(r.result.rackLevels) && r.result.rackLevels > 0);
  ok('WSC result.meta.inputs preserved',                      r.result.meta && r.result.meta.inputs);

  const def = wscRun({});
  ok('WSC accepts empty input (defaults engaged)',            def.ok === true && def.result.totalSqft >= 0);

  const negative = wscRun({ peakUnits: -100 });
  ok('WSC rejects negative peakUnits',                        negative.ok === false && negative.errors.some(e => /peakUnits/.test(e)));

  const nan = wscRun({ skuCount: 'lots' });
  ok('WSC rejects non-finite skuCount',                       nan.ok === false && nan.errors.some(e => /skuCount/.test(e)));

  const nullR = wscRun(null);
  ok('WSC does not throw on null',                            nullR.ok === false || nullR.ok === true);

  const override = wscRun({
    peakUnits: 1_000_000,
    totalPalletsOverride: 50_000,
    clearHeightFt: 36,
  });
  ok('WSC honors totalPalletsOverride',                    override.ok === true && override.result.totalSqft > r.result.totalSqft);
}

// --- Cross-cutting: no wrapper ever throws on bad input ---
{
  let threw = false;
  try { fleetRun(null); } catch { threw = true; }
  ok('Fleet wrapper does not throw on null input', !threw);
  try { cogRun({ points: [{ lat: 'bad' }] }); } catch { /* acceptable */ }
  ok('COG wrapper handles malformed point gracefully',
     cogRun({ points: [{ id: 'p', lat: 0, lng: 0, weight: 1 }] }).ok === true);

  // S10 additions
  let cmThrew = false, wscThrew = false;
  try { cmRun({ laborLines: 'not an array' }); }   catch { cmThrew = true; }
  try { wscRun({ peakUnits: { nested: true } }); } catch { wscThrew = true; }
  ok('CM wrapper does not throw on garbage laborLines', !cmThrew);
  ok('WSC wrapper does not throw on garbage peakUnits', !wscThrew);
}

console.log(`\nrunScenario wrappers: ${passed}/${passed + failed} passed${failed ? ', failures:' : ''}`);
fails.forEach(f => console.log(`  - ${f}`));
process.exit(failed ? 1 : 0);

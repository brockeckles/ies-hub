// test-cog-display-metrics.mjs — locks the Phase 2c canonical display
// contract (2026-06-10 assessment, COG findings #2/#11): one solve-set
// denominator for avg distance + cost/unit, engine-field preference, and
// CO₂ split fallbacks. Every display surface (CM writeback, Compare drawer,
// deck, benchmark card) routes through deriveCogDisplayMetrics or mirrors
// its denominator; this test pins the helper they share.
//
// Run:  node test-cog-display-metrics.mjs

import { deriveCogDisplayMetrics } from './tools/center-of-gravity/calc.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); } }
function near(a, b, eps = 1e-6, msg = '') { if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b}, got ${a}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const SOLVE_PTS = [
  { id: 'a', weight: 60_000 },
  { id: 'b', weight: 40_000 },
];
const CONFIG = { co2KgPerTruckMile: 1.62, parcelCo2KgPerPkg: 0.5 };

t('canonical denominators: solve weight drives avg distance + cost/unit', () => {
  const m = deriveCogDisplayMetrics(
    { totalWeightedDistance: 25_000_000, totalCost: 1_000_000 },
    CONFIG, SOLVE_PTS,
  );
  near(m.totalSolveWeight, 100_000);
  near(m.avgWeightedDistanceMi, 250, 1e-6, '25M wt-mi / 100K wt');
  near(m.costPerUnit, 10, 1e-6, '$1M / 100K units (fallback path)');
});

t('engine avgCostPerUnit (F13) wins over the fallback division', () => {
  const m = deriveCogDisplayMetrics(
    { totalWeightedDistance: 1, totalCost: 1_000_000, avgCostPerUnit: 9.42 },
    CONFIG, SOLVE_PTS,
  );
  near(m.costPerUnit, 9.42, 1e-9, 'engine per-unit must be preferred');
});

t('CO₂: enrichment split fields preferred; total never re-adds parcel', () => {
  const m = deriveCogDisplayMetrics(
    { co2Tons: 120, truckCo2Tons: 95, parcelCo2Tons: 25, parcelDetails: { totalPackages: 50_000 } },
    CONFIG, SOLVE_PTS,
  );
  near(m.co2Tons, 120); near(m.truckCo2Tons, 95); near(m.parcelCo2Tons, 25);
  near(m.truckCo2Tons + m.parcelCo2Tons, m.co2Tons, 1e-6, 'split must sum to total');
});

t('CO₂ fallback derivation for older saved results (no enrichment fields)', () => {
  const m = deriveCogDisplayMetrics(
    { totalTruckMiles: 1_000_000, parcelDetails: { totalPackages: 80_000 } },
    CONFIG, SOLVE_PTS,
  );
  near(m.truckCo2Tons, 1620, 0.5, '1M mi × 1.62 kg/mi');
  near(m.parcelCo2Tons, 40, 0.5, '80K pkgs × 0.5 kg');
  near(m.co2Tons, 1660, 0.5, 'derived total = truck + parcel');
});

t('null-safety: empty solve set yields null ratios, zero CO₂, no throws', () => {
  const m = deriveCogDisplayMetrics({}, {}, []);
  assert(m.avgWeightedDistanceMi === null, 'avg distance null on empty set');
  assert(m.costPerUnit === null, 'cost/unit null on empty set');
  near(m.co2Tons, 0); near(m.totalSolveWeight, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

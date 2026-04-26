// test-wsc-sizing.mjs — regression tests for I-06 (WSC honor explicit dock config + pallet override)
import { sizeFacility, calcDIOH } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Test: explicit door overrides bypass throughput derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    inPalletsDay: 50,       // would derive to 2 (the minimum) from throughput
    outPalletsDay: 50,
    inboundDoorsOverride: 28,
    outboundDoorsOverride: 28,
  });
  t('explicit inbound honored', r.dock.inboundDoors === 28);
  t('explicit outbound honored', r.dock.outboundDoors === 28);
  t('explicit total has no surge buffer', r.dock.totalDoors === 56);
  t('explicit provenance flag set', r.dock.inboundDoorsExplicit === true && r.dock.outboundDoorsExplicit === true);
  t('derived value still reported', r.dock.inboundDoorsDerived === 2);
}

// ── Test: missing overrides fall back to throughput derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    inPalletsDay: 1200,     // 1200 / (20 × 8) = 7.5 → 8
    outPalletsDay: 1200,
    palletsPerDoorHour: 20,
    dockHours: 8,
  });
  t('derived inbound from throughput', r.dock.inboundDoors === 8);
  t('derived outbound from throughput', r.dock.outboundDoors === 8);
  t('derived total includes 25% surge', r.dock.totalDoors === 20);
  t('derived provenance flag false', r.dock.inboundDoorsExplicit === false);
}

// ── Test: partial override (inbound only) ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    inPalletsDay: 200,
    outPalletsDay: 200,
    inboundDoorsOverride: 15,
    // outboundDoorsOverride intentionally omitted
  });
  t('partial inbound override honored', r.dock.inboundDoors === 15);
  t('partial outbound still derived', r.dock.outboundDoors === 2); // 200/160 → ceil = 2
  t('partial skips surge buffer', r.dock.totalDoors === 17);       // no surge
  t('partial inbound explicit flag true', r.dock.inboundDoorsExplicit === true);
  t('partial outbound explicit flag false', r.dock.outboundDoorsExplicit === false);
}

// ── Test: totalPalletsOverride bypasses units→pallets derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,       // would derive ~6250 full-pallet positions
    totalPalletsOverride: 80000,
  });
  // 80000 × 1.1 (honeycomb) = 88000 gross pallet positions
  t('totalPalletsOverride > 0 used as positions', r.positions.grossPositions > 80000);
  t('totalPalletsOverride drives large storage SF', r.storageSqft > 500000);
}

// ── Test: zero override falls back to units derivation ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    totalPalletsOverride: 0,
  });
  // 500000 × 0.60 / 48 = 6250 full-pallet positions + some cartons
  t('zero pallet override falls back to unit derivation', r.positions.grossPositions < 20000);
}

// ── Test: high-throughput Wayfair-like case (regression for I-06 under-sizing) ──
{
  const r = sizeFacility({
    peakUnits: 1000000,
    totalPalletsOverride: 80000,     // engineered pallet count
    inboundDoorsOverride: 28,
    outboundDoorsOverride: 28,
    dockConfig: 'two',
    clearHeightFt: 36,
  });
  // Should produce a warehouse closer to 700K SF, NOT 91K SF
  t('Wayfair-like sizes to 400K+ SF (not 91K)', r.totalSqft > 400000, `got ${r.totalSqft}`);
  t('Wayfair-like honors 56 explicit doors', r.dock.totalDoors === 56);
}

// ── DIOH formula: on-hand ÷ daily outbound, not FP-days-of-cover multiplied in ──
{
  // Typical 3PL: 350K units on-hand, 5K/day outbound = 70 days.
  const dioh = calcDIOH({
    avgUnits: 350000,
    outboundUnitsPerDay: 5000,
  });
  t('DIOH direct: 350K on-hand / 5K daily = 70 days', Math.round(dioh) === 70, `got ${dioh}`);
}
{
  // Derive daily from annual + operating days.
  const dioh = calcDIOH({
    avgUnits: 500000,
    outboundUnitsYr: 2_000_000,
    operatingDaysPerYear: 250,
  });
  // daily = 2M / 250 = 8000; DIOH = 500K / 8K = 62.5
  t('DIOH derived-daily: 500K / (2M/250) = 62.5', Math.abs(dioh - 62.5) < 0.1, `got ${dioh}`);
}
{
  // Legacy zones (avgUnitsPerDay as on-hand proxy, forwardPick.outboundUnitsPerDay):
  // prior bug returned (avg × daysInventory) / outbound = (350K × 3) / 5K = 210
  const dioh = calcDIOH({
    avgUnitsPerDay: 350000,
    forwardPick: { daysInventory: 3, outboundUnitsPerDay: 5000 },
  });
  t('DIOH legacy shape: avgUnitsPerDay/(FP outbound) = 70 (not 210)', Math.round(dioh) === 70, `got ${dioh}`);
}
{
  // Missing inputs return 0 rather than NaN or Infinity.
  t('DIOH empty input = 0', calcDIOH({}) === 0);
  t('DIOH no daily = 0', calcDIOH({ avgUnits: 100000 }) === 0);
  t('DIOH no on-hand = 0', calcDIOH({ outboundUnitsPerDay: 5000 }) === 0);
}
{
  // Realistic Wayfair-like: 1.5M on-hand, 15K daily = 100 days (typical DTC ecomm)
  const dioh = calcDIOH({
    avgUnits: 1_500_000,
    outboundUnitsPerDay: 15_000,
  });
  t('DIOH DTC ecomm: 1.5M / 15K = 100 days', Math.round(dioh) === 100, `got ${dioh}`);
}


// ============================================================
// WSC-A2 / A3 / B2 (2026-04-25) — building dimensions drive storage geometry
// ============================================================
import { computeStorage } from './tools/warehouse-sizing/calc.js';

{
  // Heuristic fallback: no buildingWidth/Depth → flagged heuristic
  const r = computeStorage(
    { totalSqft: 500000, clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A2 heuristic flag set when no dims', r.geometryIsHeuristic === true);
  t('A2 heuristic still produces positions', r.totalPalletPositions > 0);
}
{
  // With dims: HEURISTIC flag clears, dims drive geometry
  const r = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A2 measured flag when dims set', r.geometryIsHeuristic === false);
  t('A2 storage SF reflects dims × dims − non-storage',
    r.storageSqft === 800 * 625 - 25000,
    `expected ${800*625 - 25000} got ${r.storageSqft}`);
}
{
  // Aisle width drives module count: 6 ft VNA gives more positions than 12 ft wide
  const wide = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 12,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  const vna = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 6,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('B2 VNA produces > wide aisles',
    vna.aisleCount > wide.aisleCount,
    `wide=${wide.aisleCount} vna=${vna.aisleCount}`);
  t('B2 VNA produces > wide positions',
    vna.totalPalletPositions > wide.totalPalletPositions);
}
{
  // Double-deep produces ~2x positions of single in same footprint
  const single = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  const dbl = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'double', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A3 double > single positions in same footprint',
    dbl.totalPalletPositions > single.totalPalletPositions,
    `single=${single.totalPalletPositions} double=${dbl.totalPalletPositions}`);
}
{
  // Rack levels canonical formula: 36 ft clear + 48" load + 18" sprinkler →
  // floor((36*12 - 18) / (48+10)) = floor(414/58) = 7, capped at 7
  const r = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 36, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A3 canonical levels match v2 formula', r.rackLevels === 7,
    `got ${r.rackLevels}`);
}
{
  // Lower clear height → fewer levels, bounded ≥ 2
  const low = computeStorage(
    { totalSqft: 500000, buildingWidth: 800, buildingDepth: 625,
      clearHeight: 16, storageType: 'single', aisleWidth: 10,
      palletHeight: 48, topClearance: 18 },
    { officeSqft: 25000 }
  );
  t('A3 low clear height → bounded levels',
    low.rackLevels >= 2 && low.rackLevels <= 7,
    `got ${low.rackLevels}`);
}

console.log(`\n\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// test-wsc-sizing.mjs — regression tests for I-06 (WSC honor explicit dock config + pallet override)
import { sizeFacility } from './tools/warehouse-sizing/calc.js';

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

console.log(`\n\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

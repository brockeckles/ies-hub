// test-wsc-empty-state.mjs — locks Brock 2026-05-08 contract: a brand-new
// "+ New Scenario" with all inputs at 0 produces totalSqft = 0.
//
// History: pre-fix, opening "+ New Scenario" pre-filled the form with seed
// data (5K office, 10K staging, 500K peak units/day, 10 inbound + 12
// outbound dock doors, 60K pallets, 250 daily inbound, etc.) intended to
// make the demo look populated. Worse: even after the user cleared every
// field to 0, toSizingInputs's `||` fallback substituted phantom values
// (500K peak units, 200 pallets/day, etc.) because `||` treats user-typed
// 0 as falsy. End-to-end residual: 118,368 SF that couldn't be cleared by
// any input. This test pins both halves of that contract:
//   1. Engine accepts literal zeros and produces 0 SF.
//   2. Dock-doors floor at 0 (was floored at 2 in the legacy path).
//   3. Phase 1 + legacy paths agree at zero (totalSqft === legacyTotalSqft).

import { sizeFacility } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Test: literal-zero inputs produce zero facility ──
{
  const r = sizeFacility({
    peakUnits: 0,
    avgUnits: 0,
    inPalletsDay: 0,
    outPalletsDay: 0,
    palletsPerDoorHour: 0,
    dockHours: 0,
    inboundDoorsOverride: 0,
    outboundDoorsOverride: 0,
    totalPalletsOverride: 0,
    fullPalletPct: 0,
    cartonOnPalletPct: 0,
    cartonOnShelvingPct: 0,
    unitsPerPallet: 0,
    unitsPerCartonPal: 0,
    cartonsPerPallet: 0,
    unitsPerCartonShelv: 0,
    cartonsPerLocation: 0,
    optionalZones: [],
    customZones: [],
    forwardPick: null,
  });

  t('totalSqft === 0',          r.totalSqft === 0,          `got ${r.totalSqft}`);
  t('legacyTotalSqft === 0',    r.legacyTotalSqft === 0,    `got ${r.legacyTotalSqft}`);
  t('storageSqft === 0',        r.storageSqft === 0,        `got ${r.storageSqft}`);
  t('palletStorageSqft === 0',  r.palletStorageSqft === 0,  `got ${r.palletStorageSqft}`);
  t('shelvingStorageSqft === 0',r.shelvingStorageSqft === 0,`got ${r.shelvingStorageSqft}`);
  t('dockSqft === 0',           r.dockSqft === 0,           `got ${r.dockSqft}`);
  t('recvStagingSqft === 0',    r.recvStagingSqft === 0,    `got ${r.recvStagingSqft}`);
  t('shipStagingSqft === 0',    r.shipStagingSqft === 0,    `got ${r.shipStagingSqft}`);
  t('officeSqft === 0',         r.officeSqft === 0,         `got ${r.officeSqft}`);
  t('additionalSqft === 0',     r.additionalSqft === 0,     `got ${r.additionalSqft}`);
  t('grossPositions === 0',     r.positions?.grossPositions === 0, `got ${r.positions?.grossPositions}`);
  t('inboundDoors === 0',       r.dock.inboundDoors === 0,  `got ${r.dock.inboundDoors}`);
  t('outboundDoors === 0',      r.dock.outboundDoors === 0, `got ${r.dock.outboundDoors}`);
  t('legacy ↔ Phase 1 agree',   r.totalSqft === r.legacyTotalSqft);
}

// ── Test: peakUnits drives storage but no dock; isolated input change ──
{
  const r = sizeFacility({
    peakUnits: 500000,
    avgUnits: 0,
    inPalletsDay: 0,            // no dock throughput → 0 dock SF
    outPalletsDay: 0,
    palletsPerDoorHour: 0,
    dockHours: 0,
    inboundDoorsOverride: 0,
    outboundDoorsOverride: 0,
    totalPalletsOverride: 0,
    fullPalletPct: 0.60,
    cartonOnPalletPct: 0.30,
    cartonOnShelvingPct: 0.10,
    unitsPerPallet: 48,
    unitsPerCartonPal: 6,
    cartonsPerPallet: 12,
    unitsPerCartonShelv: 6,
    cartonsPerLocation: 4,
    clearHeightFt: 32,
    loadHeightIn: 54,
    sprinklerClearanceIn: 36,
    storeType: 'single',
    aisleType: 'narrow',
    optionalZones: [],
    customZones: [],
    forwardPick: null,
  });

  t('storage > 0 when peakUnits > 0',  r.storageSqft > 0,        `got ${r.storageSqft}`);
  t('dock === 0 when no throughput',   r.dockSqft === 0,         `got ${r.dockSqft}`);
  t('staging === 0 when no throughput',r.recvStagingSqft === 0 && r.shipStagingSqft === 0);
  t('positions > 0 when peak > 0',     r.positions?.grossPositions > 0);
}

// ── Test: dock-only inputs produce dock SF without phantom storage ──
{
  const r = sizeFacility({
    peakUnits: 0,
    avgUnits: 0,
    inPalletsDay: 1000,
    outPalletsDay: 1000,
    palletsPerDoorHour: 20,
    dockHours: 8,
    inboundDoorsOverride: 0,
    outboundDoorsOverride: 0,
    totalPalletsOverride: 0,
    fullPalletPct: 0.60,
    cartonOnPalletPct: 0.30,
    cartonOnShelvingPct: 0.10,
    unitsPerPallet: 48,
    unitsPerCartonPal: 6,
    cartonsPerPallet: 12,
    unitsPerCartonShelv: 6,
    cartonsPerLocation: 4,
    optionalZones: [],
    customZones: [],
    forwardPick: null,
  });

  t('storage === 0 when no inventory', r.storageSqft === 0,  `got ${r.storageSqft}`);
  t('dock > 0 when throughput > 0',    r.dockSqft > 0,       `got ${r.dockSqft}`);
  t('staging > 0 when throughput > 0', r.recvStagingSqft > 0 && r.shipStagingSqft > 0);
  t('positions === 0 with no inventory', r.positions?.grossPositions === 0);
}

console.log(`\n\ntest-wsc-empty-state: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

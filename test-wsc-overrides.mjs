// test-wsc-overrides.mjs — locks Brock 2026-05-08 consolidation contract:
// throughput inputs and storage-count overrides coexist in one form.
// Engine logic: per-field, override > 0 wins over derived, otherwise derive.
//
// Pre-fix the engine had two separate paths driven by primaryInventoryInput
// ('throughput' vs 'pallets'). This test class pins the unified semantics:
//   1. Pure throughput → engine derives both pallets and shelving.
//   2. Pallet override only → uses override for pallets, throughput for shelving.
//   3. Shelving override only → uses throughput for pallets, override for shelving.
//   4. Both overrides → engine uses both directly, throughput is ignored for sizing
//      (still drives dock + staging from inPalletsDay/outPalletsDay).
//   5. Neither → derived from throughput.
//   6. Override only with NO throughput → produces shelving-only / pallets-only
//      facility (the case that pre-fix 'pallets mode' silently broke for shelving).

import { sizeFacility } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const baseInputs = {
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
};

// ── Test 1: throughput-only — engine derives pallets AND shelving ──
{
  const r = sizeFacility({
    ...baseInputs,
    peakUnits: 500000,
    inPalletsDay: 200,
    outPalletsDay: 200,
    palletsPerDoorHour: 20,
    dockHours: 8,
    totalPalletsOverride: 0,
    totalShelvingLocationsOverride: 0,
  });
  t('throughput-only: pallet positions derived (>0)', (r.positions?.fullPalletPositions + r.positions?.cartonPalletPositions) > 0, `got fp=${r.positions?.fullPalletPositions} cp=${r.positions?.cartonPalletPositions}`);
  t('throughput-only: shelving locations derived (>0)', r.locations?.shelving?.locationsRequired > 0, `got ${r.locations?.shelving?.locationsRequired}`);
  t('throughput-only: pallets NOT explicit', r.locations?.fullPallet && !r.locations?.fullPallet?.explicit !== false /* mode tag */);
  t('throughput-only: shelving mode != override', r.locations?.shelving?.mode !== 'override');
  t('throughput-only: shelving NOT explicit', r.locations?.shelving?.explicit === false);
}

// ── Test 2: pallet override only — pallets uses override, shelving still derives ──
{
  const r = sizeFacility({
    ...baseInputs,
    peakUnits: 500000,
    inPalletsDay: 200,
    outPalletsDay: 200,
    palletsPerDoorHour: 20,
    dockHours: 8,
    totalPalletsOverride: 50000,
    totalShelvingLocationsOverride: 0,
  });
  t('pallet-override: storage > 0',                 r.storageSqft > 0, `got ${r.storageSqft}`);
  t('pallet-override: shelving derived from throughput', r.locations?.shelving?.locationsRequired > 0);
  t('pallet-override: shelving mode != override',   r.locations?.shelving?.mode !== 'override');
  t('pallet-override: shelving explicit=false',     r.locations?.shelving?.explicit === false);
}

// ── Test 3: shelving override only — pallets derive, shelving uses override ──
{
  const r = sizeFacility({
    ...baseInputs,
    peakUnits: 500000,
    inPalletsDay: 200,
    outPalletsDay: 200,
    palletsPerDoorHour: 20,
    dockHours: 8,
    totalPalletsOverride: 0,
    totalShelvingLocationsOverride: 8000,
  });
  t('shelving-override: pallets derived',           (r.positions?.fullPalletPositions + r.positions?.cartonPalletPositions) > 0);
  t('shelving-override: shelving locationsRequired = 8000', r.locations?.shelving?.locationsRequired === 8000, `got ${r.locations?.shelving?.locationsRequired}`);
  t('shelving-override: shelving mode = override',  r.locations?.shelving?.mode === 'override', `got ${r.locations?.shelving?.mode}`);
  t('shelving-override: shelving explicit=true',    r.locations?.shelving?.explicit === true);
  t('shelving-override: shelvingPositions in positions block reflects override', r.positions?.shelvingPositions === 8000, `got ${r.positions?.shelvingPositions}`);
}

// ── Test 4: both overrides — both honored, throughput ignored for storage sizing ──
{
  const r = sizeFacility({
    ...baseInputs,
    peakUnits: 500000,
    inPalletsDay: 200,
    outPalletsDay: 200,
    palletsPerDoorHour: 20,
    dockHours: 8,
    totalPalletsOverride: 50000,
    totalShelvingLocationsOverride: 8000,
  });
  t('both-override: shelving locationsRequired = 8000', r.locations?.shelving?.locationsRequired === 8000);
  t('both-override: shelving mode = override',           r.locations?.shelving?.mode === 'override');
  t('both-override: dockSqft > 0 from throughput',       r.dockSqft > 0, `got ${r.dockSqft}`);
}

// ── Test 5: shelving override with NO throughput — pallets-only-shelving facility ──
// This is the case that pre-consolidation 'pallets mode' silently broke:
// user enters 0 throughput + only a shelving count, expects shelving-only facility.
{
  const r = sizeFacility({
    ...baseInputs,
    peakUnits: 0,
    inPalletsDay: 0,
    outPalletsDay: 0,
    palletsPerDoorHour: 0,
    dockHours: 0,
    totalPalletsOverride: 0,
    totalShelvingLocationsOverride: 5000,
  });
  t('shelv-only: storage > 0 (shelving SF)',        r.storageSqft > 0, `got ${r.storageSqft}`);
  t('shelv-only: shelvingStorageSqft > 0',          r.shelvingStorageSqft > 0);
  t('shelv-only: pallet storage = 0',               r.palletStorageSqft === 0);
  t('shelv-only: dock = 0 (no throughput)',         r.dockSqft === 0);
  t('shelv-only: shelvingPositions = 5000',         r.positions?.shelvingPositions === 5000);
  t('shelv-only: explicit=true',                    r.locations?.shelving?.explicit === true);
}

// ── Test 6: pallet override with NO throughput — pallets-only facility ──
{
  const r = sizeFacility({
    ...baseInputs,
    peakUnits: 0,
    inPalletsDay: 0,
    outPalletsDay: 0,
    palletsPerDoorHour: 0,
    dockHours: 0,
    totalPalletsOverride: 30000,
    totalShelvingLocationsOverride: 0,
  });
  t('pal-only: storage > 0',                        r.storageSqft > 0);
  t('pal-only: palletStorageSqft > 0',              r.palletStorageSqft > 0);
  t('pal-only: shelvingStorageSqft = 0',            r.shelvingStorageSqft === 0);
  t('pal-only: dock = 0',                           r.dockSqft === 0);
  t('pal-only: shelvingPositions = 0',              r.positions?.shelvingPositions === 0);
}

// ── Test 7: blank scenario (no throughput, no override) — still produces 0 SF ──
// (Backstop the empty-state contract from test-wsc-empty-state.mjs.)
{
  const r = sizeFacility({
    ...baseInputs,
    peakUnits: 0,
    inPalletsDay: 0,
    outPalletsDay: 0,
    palletsPerDoorHour: 0,
    dockHours: 0,
    totalPalletsOverride: 0,
    totalShelvingLocationsOverride: 0,
  });
  t('blank: totalSqft = 0',                         r.totalSqft === 0, `got ${r.totalSqft}`);
  t('blank: storageSqft = 0',                       r.storageSqft === 0);
  t('blank: shelvingPositions = 0',                 r.positions?.shelvingPositions === 0);
}

console.log(`\n\ntest-wsc-overrides: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

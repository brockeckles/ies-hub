// test-wsc-dock-asymmetric-zero.mjs — Brock 2026-05-12 dock-wart contract.
//
// History: prior code floored the dock divisor at 1 via
//   `dockDivisor = Math.max(1, palletsPerDoorHour) * Math.max(1, dockHours)`
// which only saved you from divide-by-zero. The "asymmetric" case — user
// types daily throughput (in/outPalletsDay > 0) but leaves dock capacity
// blank (palletsPerDoorHour=0, dockHours=0) — produced explosive door
// counts: 200/207 daily pallets → 407 raw doors → 509 surge doors →
// 763,500 SF of "dock." This test pins the new contract: zero capacity
// inputs → zero derived doors. Matches Phase 1 computeDockRequirement.
//
// Explicit user overrides (inboundDoorsOverride / outboundDoorsOverride)
// still win — those represent an engineered answer, not blank inputs.

import { sizeFacility } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const baseInputs = {
  peakUnits: 0, avgUnits: 0,
  inboundDoorsOverride: 0, outboundDoorsOverride: 0,
  totalPalletsOverride: 0,
  fullPalletPct: 0, cartonOnPalletPct: 0, cartonOnShelvingPct: 0,
  unitsPerPallet: 0, unitsPerCartonPal: 0, cartonsPerPallet: 0,
  unitsPerCartonShelv: 0, cartonsPerLocation: 0,
  optionalZones: [], customZones: [], forwardPick: null,
};

// ── Bug repro: throughput entered, capacity blank → must NOT blow up ──
{
  const r = sizeFacility({
    ...baseInputs,
    inPalletsDay: 200, outPalletsDay: 207,
    palletsPerDoorHour: 0, dockHours: 0,
  });
  t('asymmetric (200/207, capacity=0): inboundDoors === 0',  r.dock.inboundDoors === 0,  `got ${r.dock.inboundDoors}`);
  t('asymmetric (200/207, capacity=0): outboundDoors === 0', r.dock.outboundDoors === 0, `got ${r.dock.outboundDoors}`);
  t('asymmetric (200/207, capacity=0): dockSqft === 0',      r.dockSqft === 0,           `got ${r.dockSqft}`);
}

// ── Higher throughput, still capacity=0 → still zero ──
{
  const r = sizeFacility({
    ...baseInputs,
    inPalletsDay: 5000, outPalletsDay: 5000,
    palletsPerDoorHour: 0, dockHours: 0,
  });
  t('asymmetric (5000/5000, capacity=0): dockSqft === 0', r.dockSqft === 0, `got ${r.dockSqft}`);
}

// ── Half-asymmetric: palletsPerDoorHour=0 but dockHours>0 → still zero ──
{
  const r = sizeFacility({
    ...baseInputs,
    inPalletsDay: 1000, outPalletsDay: 1000,
    palletsPerDoorHour: 0, dockHours: 8,
  });
  t('half-asymmetric (palletsPerDoorHour=0): dockSqft === 0', r.dockSqft === 0, `got ${r.dockSqft}`);
}

// ── Half-asymmetric: palletsPerDoorHour>0 but dockHours=0 → still zero ──
{
  const r = sizeFacility({
    ...baseInputs,
    inPalletsDay: 1000, outPalletsDay: 1000,
    palletsPerDoorHour: 20, dockHours: 0,
  });
  t('half-asymmetric (dockHours=0): dockSqft === 0', r.dockSqft === 0, `got ${r.dockSqft}`);
}

// ── Sanity preserved: valid capacity inputs still drive sizing ──
{
  const r = sizeFacility({
    ...baseInputs,
    inPalletsDay: 1000, outPalletsDay: 1000,
    palletsPerDoorHour: 20, dockHours: 8,
  });
  // 1000 / (20*8) = 6.25 → ceil 7 per side. 7+7=14, surge ceil(14*1.25)=18.
  // 18 * 1500 = 27,000.
  t('valid capacity (20*8): inboundDoors === 7',  r.dock.inboundDoors === 7,  `got ${r.dock.inboundDoors}`);
  t('valid capacity (20*8): outboundDoors === 7', r.dock.outboundDoors === 7, `got ${r.dock.outboundDoors}`);
  t('valid capacity (20*8): dockSqft === 27,000', r.dockSqft === 27000,       `got ${r.dockSqft}`);
}

// ── Explicit overrides still win even when capacity is blank ──
// Brock's intent: user-supplied door counts are an engineered answer that
// should be honored regardless of whether capacity inputs are also filled in.
{
  const r = sizeFacility({
    ...baseInputs,
    inPalletsDay: 0, outPalletsDay: 0,
    palletsPerDoorHour: 0, dockHours: 0,
    inboundDoorsOverride: 10, outboundDoorsOverride: 12,
  });
  t('override+capacity=0: inboundDoors === 10',  r.dock.inboundDoors === 10,  `got ${r.dock.inboundDoors}`);
  t('override+capacity=0: outboundDoors === 12', r.dock.outboundDoors === 12, `got ${r.dock.outboundDoors}`);
  // Explicit doors: no 1.25 surge multiplier. 22 * 1500 = 33,000.
  t('override+capacity=0: dockSqft === 33,000',  r.dockSqft === 33000,         `got ${r.dockSqft}`);
}

console.log(`\n\ntest-wsc-dock-asymmetric-zero: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

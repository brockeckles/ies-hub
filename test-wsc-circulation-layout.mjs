// test-wsc-circulation-layout.mjs — Phase F.11 (2026-05-06)
// circulationLayoutFt — labeled cross-aisles + side fire lanes for WSC rendering.
import { circulationLayoutFt, crossAisleLayoutFt } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Tiny building — no cross-aisles needed (run < spacing+clear) ──
{
  const r = circulationLayoutFt({ rackRunLenFt: 100, rackZoneWidthFt: 200, sideMarginFt: 6 });
  t('tiny building: 0 cross-aisles', r.crossAisles.length === 0);
  t('tiny building: 2 side fire lanes', r.sideFireLanes.length === 2);
  t('tiny building: side margin = 6', r.sideMarginFt === 6);
  t('tiny building: cross-aisle SF = 0', r.crossAisleSf === 0);
  t('tiny building: side fire-lane SF = 12 × 100 = 1200', r.sideFireLaneSf === 1200);
}

// ── Medium building — exactly at NFPA threshold ──
{
  const xa = crossAisleLayoutFt(300);
  const r = circulationLayoutFt({ rackRunLenFt: 300, rackZoneWidthFt: 400, sideMarginFt: 6 });
  t('medium: cross-aisle count = (segmentCount - 1)', r.crossAisles.length === xa.segmentCount - 1);
  t('medium: cross-aisle clear matches NFPA layout', r.crossAisleClearFt === xa.crossAisleClearFt);
  t('medium: targetSpacingFt propagates', r.targetSpacingFt === xa.targetSpacingFt);
}

// ── Wayfair-scale building — 1 cross-aisle (rackRunLen ~= 690 ft, ESFR 250 ft target + 12 ft clear) ──
{
  const r = circulationLayoutFt({ rackRunLenFt: 690, rackZoneWidthFt: 980, sideMarginFt: 6, storageSqft: 600000 });
  t('Wayfair: cross-aisles >= 1', r.crossAisles.length >= 1);
  t('Wayfair: cross-aisle posFt monotonic', r.crossAisles.every((ca, i) => i === 0 || ca.posFt > r.crossAisles[i-1].posFt));
  t('Wayfair: each cross-aisle has 12 ft clear', r.crossAisles.every(ca => ca.widthFt === 12));
  t('Wayfair: circulationSf = crossAisleSf + sideFireLaneSf', r.circulationSf === r.crossAisleSf + r.sideFireLaneSf);
  t('Wayfair: circulationPct > 0', r.circulationPct > 0);
}

// ── Large building — multiple cross-aisles ──
{
  const r = circulationLayoutFt({ rackRunLenFt: 1500, rackZoneWidthFt: 600, sideMarginFt: 6 });
  t('large: at least 4 cross-aisles', r.crossAisles.length >= 4);
  t('large: cross-aisle posFt strictly inside [0, run]', r.crossAisles.every(ca => ca.posFt > 0 && ca.posFt < 1500));
  t('large: cross-aisle SF = (count) × clear × zoneWidth', r.crossAisleSf === r.crossAisles.length * 12 * 600);
}

// ── Side margin = 0 → no fire lanes ──
{
  const r = circulationLayoutFt({ rackRunLenFt: 500, rackZoneWidthFt: 200, sideMarginFt: 0 });
  t('zero margin: 0 fire lanes', r.sideFireLanes.length === 0);
  t('zero margin: sideFireLaneSf = 0', r.sideFireLaneSf === 0);
}

// ── Defaults (sideMarginFt missing) → 6 ft ──
{
  const r = circulationLayoutFt({ rackRunLenFt: 200, rackZoneWidthFt: 100 });
  t('default sideMargin = 6 ft', r.sideMarginFt === 6);
  t('default sideMargin: 2 fire lanes', r.sideFireLanes.length === 2);
}

// ── Sprinkler-type pass-through ──
{
  const rEsfr = circulationLayoutFt({ rackRunLenFt: 800, rackZoneWidthFt: 300, sprinklerType: 'ESFR' });
  const rNone = circulationLayoutFt({ rackRunLenFt: 800, rackZoneWidthFt: 300, sprinklerType: 'none' });
  t('ESFR target spacing = 250 ft', rEsfr.targetSpacingFt === 250);
  t('unsprinklered target spacing = 150 ft', rNone.targetSpacingFt === 150);
  t('unsprinklered has more cross-aisles', rNone.crossAisles.length > rEsfr.crossAisles.length);
}

// ── Truck-class pass-through ──
{
  const rCB = circulationLayoutFt({ rackRunLenFt: 800, rackZoneWidthFt: 300, truckClass: 'counterbalance' });
  const rTU = circulationLayoutFt({ rackRunLenFt: 800, rackZoneWidthFt: 300, truckClass: 'turret' });
  t('counterbalance clear = 12 ft', rCB.crossAisleClearFt === 12);
  t('turret clear = 8 ft', rTU.crossAisleClearFt === 8);
  t('different clear → different cross-aisle widthFt', rCB.crossAisles[0].widthFt !== rTU.crossAisles[0].widthFt);
}

// ── circulationPct rounding ──
{
  const r = circulationLayoutFt({ rackRunLenFt: 690, rackZoneWidthFt: 980, sideMarginFt: 6, storageSqft: 100000 });
  // expect circulationPct = round((sf / 100000) * 1000) / 10, single decimal
  const expected = Math.round((r.circulationSf / 100000) * 1000) / 10;
  t('circulationPct rounds to 1 decimal', Math.abs(r.circulationPct - expected) < 1e-9);
}

// ── Empty input → zero outputs (defensive) ──
{
  const r = circulationLayoutFt({});
  t('empty: 0 cross-aisles', r.crossAisles.length === 0);
  t('empty: 0 SF', r.circulationSf === 0);
  t('empty: 0 pct', r.circulationPct === 0);
}

// ── Storage SF missing → pct still 0 even if SF > 0 (defensive) ──
{
  const r = circulationLayoutFt({ rackRunLenFt: 800, rackZoneWidthFt: 300, sideMarginFt: 6 });
  t('no storageSqft → pct=0', r.circulationPct === 0);
  t('SF still computed', r.circulationSf > 0);
}

console.log(`\n\ntest-wsc-circulation-layout: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

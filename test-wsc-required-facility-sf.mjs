// test-wsc-required-facility-sf.mjs — Phase 1 redesign coverage for computeRequiredFacilitySF.
// Validates additive aggregation, circulation buffer, suggested-dim derivation
// at target ratio, edge cases (zero inputs, extreme ratios).
import { computeRequiredFacilitySF } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.5) => Math.abs(a - b) < eps;

// ── Wayfair Memphis FC profile ──
{
  const r = computeRequiredFacilitySF({
    storageSf:    553581,
    dockSf:       34500,
    officeSf:     31355,
    stagingSf:    13500,
    additionalSf: 0,
    circulationPct: 0.10,
    targetRatio: 1.5,
  });
  // subtotal = 632,936
  t('wayfair subtotal sums right', r.storageSf + r.dockSf + r.officeSf + r.stagingSf + r.additionalSf === 632936);
  // circulation = ceil(632936 × 0.10) = 63,294
  t('wayfair circulation = 63,294', r.circulationSf === 63294);
  // total = 696,230
  t('wayfair totalSfRequired = 696,230', r.totalSfRequired === 696230);
  // suggested long = ceil(sqrt(696230 × 1.5) / 10) × 10 = ceil(1021.9 / 10) × 10 = 1030
  t('wayfair suggestedLongFt = 1030', r.suggestedLongFt === 1030);
  // suggested short = ceil((696230 / 1030) / 10) × 10 = ceil(675.95/10)*10 = 680
  t('wayfair suggestedShortFt = 680', r.suggestedShortFt === 680);
  t('wayfair targetRatio = 1.5', r.targetRatio === 1.5);
}

// ── Tiny facility (10K SF) ──
{
  const r = computeRequiredFacilitySF({
    storageSf: 8000,
    dockSf:    1000,
    officeSf:  500,
    stagingSf: 500,
  });
  // subtotal 10,000; circ 1,000; total 11,000
  t('tiny circulation = 1000', r.circulationSf === 1000);
  t('tiny total = 11000', r.totalSfRequired === 11000);
  // sqrt(11000 × 1.5) = 128.5; /10 = 12.85; ceil = 13; × 10 = 130
  t('tiny suggestedLongFt = 130', r.suggestedLongFt === 130);
}

// ── Zero inputs → zero everything ──
{
  const r = computeRequiredFacilitySF({});
  t('zero storage', r.storageSf === 0);
  t('zero total', r.totalSfRequired === 0);
  t('zero suggestedLong', r.suggestedLongFt === 0);
  t('zero suggestedShort', r.suggestedShortFt === 0);
}

// ── 1:1 ratio (square building) ──
{
  const r = computeRequiredFacilitySF({
    storageSf: 90000,
    dockSf:    9000,
    officeSf:  900,
    stagingSf: 100,
    targetRatio: 1.0,
  });
  // subtotal 100,000; circ 10,000; total 110,000
  // sqrt(110000) = 331.66; /10=33.17; ceil=34; ×10 = 340
  t('1:1 ratio suggestedLong = 340', r.suggestedLongFt === 340);
  // 110000/340 = 323.5; /10=32.35; ceil=33; ×10 = 330
  t('1:1 ratio suggestedShort = 330', r.suggestedShortFt === 330);
}

// ── 2:1 ratio (long shallow building) ──
{
  const r = computeRequiredFacilitySF({
    storageSf: 100000,
    targetRatio: 2.0,
  });
  // subtotal 100K; circ 10K; total 110K
  // sqrt(110000 × 2) = 469.04; /10 = 46.9; ceil = 47; ×10 = 470
  t('2:1 ratio suggestedLong = 470', r.suggestedLongFt === 470);
  // 110000/470 = 234.04; /10=23.4; ceil=24; ×10 = 240
  t('2:1 ratio suggestedShort = 240', r.suggestedShortFt === 240);
  // Long/short ≈ 470/240 = 1.96 (close to 2.0 target after rounding)
  t('2:1 actual ratio close to target', r.suggestedLongFt / r.suggestedShortFt > 1.8);
}

// ── Custom circulation 15% ──
{
  const r = computeRequiredFacilitySF({
    storageSf: 100000,
    circulationPct: 0.15,
  });
  // 100000 × 0.15 = 15,000 circ; total 115,000
  t('15% circ', r.circulationSf === 15000);
  t('15% circ total', r.totalSfRequired === 115000);
}

// ── Zero circulation buffer ──
{
  const r = computeRequiredFacilitySF({
    storageSf: 100000,
    circulationPct: 0,
  });
  t('0% circ', r.circulationSf === 0);
  t('0% circ total = subtotal', r.totalSfRequired === 100000);
}

// ── Default circulation = 10% ──
{
  const r = computeRequiredFacilitySF({ storageSf: 100000 });
  t('default 10% circ', r.circulationSf === 10000);
}

// ── Default target ratio = 1.5 ──
{
  const r = computeRequiredFacilitySF({ storageSf: 100000 });
  t('default ratio = 1.5', r.targetRatio === 1.5);
}

// ── Additional SF (forward pick + VAS + custom zones) ──
{
  const r = computeRequiredFacilitySF({
    storageSf:    50000,
    dockSf:       5000,
    officeSf:     2000,
    stagingSf:    1000,
    additionalSf: 12000,        // forward pick + VAS + returns
  });
  // subtotal = 70,000; circ = 7,000; total = 77,000
  t('with additional total = 77,000', r.totalSfRequired === 77000);
  t('with additional sf preserved in output', r.additionalSf === 12000);
}

// ── Negative inputs clamp to 0 ──
{
  const r = computeRequiredFacilitySF({
    storageSf: -1000,
    dockSf: -500,
  });
  t('negative storage clamps to 0', r.storageSf === 0);
  t('negative dock clamps to 0', r.dockSf === 0);
}

// ── Suggested dims always 10ft increments ──
{
  const r = computeRequiredFacilitySF({ storageSf: 99999 });
  t('suggestedLong divisible by 10', r.suggestedLongFt % 10 === 0);
  t('suggestedShort divisible by 10', r.suggestedShortFt % 10 === 0);
}

console.log(`\n\ntest-wsc-required-facility-sf: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

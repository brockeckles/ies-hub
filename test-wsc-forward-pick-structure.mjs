// test-wsc-forward-pick-structure.mjs — Phase F.11 (2026-05-06)
// forwardPickStructure — IE-correct rendering parameters for FP zones.
import { forwardPickStructure } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Default carton_flow ──
{
  const r = forwardPickStructure({ skuCount: 2000, velocityTierAPct: 20, daysInventory: 3, fpWidthFt: 100 });
  t('default type = carton_flow', r.type === 'carton_flow');
  t('carton_flow levels = 3', r.levels === 3);
  t('carton_flow pickLevels = 2', r.pickLevels === 2);
  t('carton_flow bayWidth = 4 ft', r.bayWidthFt === 4);
  t('carton_flow levelHeight = 3.5 ft', r.levelHeightFt === 3.5);
  t('carton_flow totalHeight = 10.5 ft', r.totalHeightFt === 10.5);
  t('activeFaces = 2000 × 20% = 400', r.activeFaces === 400);
  t('bays = floor(100 / 4) = 25', r.bays === 25);
  t('cartonsPerFace = 3 (= daysInventory)', r.cartonsPerFace === 3);
}

// ── light_case ──
{
  const r = forwardPickStructure({ type: 'light_case', skuCount: 5000, velocityTierAPct: 20, daysInventory: 5, fpWidthFt: 90 });
  t('light_case levels = 4', r.levels === 4);
  t('light_case pickLevels = 4', r.pickLevels === 4);
  t('light_case bayWidth = 3 ft', r.bayWidthFt === 3);
  t('light_case levelHeight = 2 ft', r.levelHeightFt === 2);
  t('light_case totalHeight = 8 ft', r.totalHeightFt === 8);
  t('light_case activeFaces = 5000 × 20% = 1000', r.activeFaces === 1000);
  t('light_case bays = floor(90 / 3) = 30', r.bays === 30);
}

// ── heavy_case ──
{
  const r = forwardPickStructure({ type: 'heavy_case', skuCount: 1000, velocityTierAPct: 25, daysInventory: 7, fpWidthFt: 50 });
  t('heavy_case levels = 4', r.levels === 4);
  t('heavy_case pickLevels = 2', r.pickLevels === 2);
  t('heavy_case bayWidth = 4.33 ft', r.bayWidthFt === 4.33);
  t('heavy_case levelHeight = 4.5 ft', r.levelHeightFt === 4.5);
  t('heavy_case totalHeight = 18 ft', r.totalHeightFt === 18);
  t('heavy_case activeFaces = 1000 × 25% = 250', r.activeFaces === 250);
  t('heavy_case bays = floor(50 / 4.33) = 11', r.bays === 11);
}

// ── Unknown type defaults to carton_flow ──
{
  const r = forwardPickStructure({ type: 'wat_no', skuCount: 100, velocityTierAPct: 50, fpWidthFt: 40 });
  t('unknown type → carton_flow', r.type === 'carton_flow');
  t('unknown type uses carton_flow geometry', r.bayWidthFt === 4 && r.levels === 3);
}

// ── Edge cases ──
{
  const r = forwardPickStructure({ skuCount: 0, velocityTierAPct: 20, fpWidthFt: 0 });
  t('zero SKUs → 0 active faces', r.activeFaces === 0);
  t('zero fpWidth → 0 bays', r.bays === 0);
}

// ── velocityTierAPct clamped to [0, 100] ──
{
  const rNeg = forwardPickStructure({ skuCount: 100, velocityTierAPct: -50, fpWidthFt: 40 });
  const rOver = forwardPickStructure({ skuCount: 100, velocityTierAPct: 250, fpWidthFt: 40 });
  t('negative velocity → 0 faces', rNeg.activeFaces === 0);
  t('over-100 velocity clamped → 100 faces', rOver.activeFaces === 100);
}

// ── cartonsPerFace clamped to [1, 6] ──
{
  const rZero = forwardPickStructure({ skuCount: 100, velocityTierAPct: 20, daysInventory: 0, fpWidthFt: 40 });
  const rTen = forwardPickStructure({ skuCount: 100, velocityTierAPct: 20, daysInventory: 30, fpWidthFt: 40 });
  t('zero DOH → cartonsPerFace = 1 (floor)', rZero.cartonsPerFace === 1);
  t('30 DOH → cartonsPerFace = 6 (ceiling)', rTen.cartonsPerFace === 6);
}

// ── Activity face calc rounds to nearest int ──
{
  const r = forwardPickStructure({ skuCount: 1234, velocityTierAPct: 20, fpWidthFt: 40 });
  t('faces = round(1234 × 0.20) = 247', r.activeFaces === 247);
}

console.log(`\n\ntest-wsc-forward-pick-structure: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

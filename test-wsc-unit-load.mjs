// test-wsc-unit-load.mjs — Phase 1 redesign coverage for computeUnitLoad.
// Validates IE-correct selective-rack bay sizing (2 pallets per crossbeam),
// rack depth (single + back-to-back), and level pitch.
import {
  computeUnitLoad,
  PALLET_TYPES,
  PALLET_BAY_INTERIOR_CLEARANCE_IN,
  BACK_TO_BACK_FLUE_IN,
  BEAM_HEIGHT_IN,
  BEAM_TO_LOAD_CLEARANCE_IN,
} from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.001) => Math.abs(a - b) < eps;

// ── GMA pallet (48 × 40) ──
{
  const u = computeUnitLoad({ palletType: 'GMA' });
  t('GMA palletLengthIn', u.palletLengthIn === 48);
  t('GMA palletWidthIn',  u.palletWidthIn === 40);
  // Bay width = 2*48 + 12 = 108 in = 9.0 ft
  t('GMA bayWidthIn = 108', u.bayWidthIn === 108);
  t('GMA bayWidthFt = 9.0', close(u.bayWidthFt, 9.0));
  // 2 pallets per bay always
  t('GMA palletsPerBay = 2', u.palletsPerBay === 2);
  // Rack depth single = (40 + 6) / 12 = 3.833 ft
  t('GMA rackDepthSingleFt', close(u.rackDepthSingleFt, (40 + 6) / 12));
  // Back-to-back = 2 * single + 6/12 = 8.167 ft
  t('GMA rackDepthBackToBackFt', close(u.rackDepthBackToBackFt, (2 * (40 + 6) + 6) / 12));
}

// ── CHEP pallet (48 × 40, identical to GMA) ──
{
  const u = computeUnitLoad({ palletType: 'CHEP' });
  t('CHEP same dims as GMA', u.palletLengthIn === 48 && u.palletWidthIn === 40);
  t('CHEP bayWidthFt = 9.0', close(u.bayWidthFt, 9.0));
}

// ── Euro pallet (1200 × 800 mm = 47.244 × 31.496 in) ──
{
  const u = computeUnitLoad({ palletType: 'Euro' });
  t('Euro palletLengthIn ≈ 47.2', close(u.palletLengthIn, 47.2));
  t('Euro palletWidthIn ≈ 31.5',  close(u.palletWidthIn, 31.5));
  // Bay = 2 * 47.2 + 12 = 106.4 in = 8.867 ft
  t('Euro bayWidthFt ≈ 8.87', close(u.bayWidthFt, 106.4 / 12));
}

// ── EuroHalf pallet (800 × 600 mm = 31.5 × 23.6 in) ──
{
  const u = computeUnitLoad({ palletType: 'EuroHalf' });
  t('EuroHalf bayWidthFt', close(u.bayWidthFt, (2 * 31.5 + 12) / 12));
}

// ── Custom pallet ──
{
  const u = computeUnitLoad({ palletType: 'Custom', palletLengthIn: 60, palletWidthIn: 42 });
  t('Custom palletLengthIn = 60', u.palletLengthIn === 60);
  t('Custom palletWidthIn = 42',  u.palletWidthIn === 42);
  t('Custom bayWidthIn = 132',    u.bayWidthIn === 132);
}

// ── Custom missing dims falls back to GMA ──
{
  const u = computeUnitLoad({ palletType: 'Custom' });
  t('Custom missing dims → GMA palletLengthIn', u.palletLengthIn === 48);
  t('Custom missing dims → GMA palletWidthIn',  u.palletWidthIn === 40);
}

// ── Level pitch math ──
{
  // Default: load 60 + base 6 + beam 5 + clearance 6 = 77 in = 6.417 ft
  const u = computeUnitLoad({ loadHeightIn: 60 });
  t('default level pitch = 6.42 ft', close(u.palletLevelHeightFt, 77 / 12));
  // 30 ft clear / 6.42 = 4.67 → floor = 4 levels
  t('default levels at 30ft = 4', u.palletLevelsAt30FtClear === 4);
}

// ── Custom load height shrinks pitch ──
{
  const u = computeUnitLoad({ loadHeightIn: 48 });
  // 48 + 6 + 5 + 6 = 65 in = 5.417 ft → 30/5.417 = 5.54 → 5 levels
  t('48" load level pitch', close(u.palletLevelHeightFt, 65 / 12));
  t('48" load levels at 30ft = 5', u.palletLevelsAt30FtClear === 5);
}

// ── Tall load reduces levels ──
{
  const u = computeUnitLoad({ loadHeightIn: 84 });
  // 84 + 6 + 5 + 6 = 101 in = 8.42 ft → 30/8.42 = 3.56 → 3 levels
  t('84" load levels at 30ft = 3', u.palletLevelsAt30FtClear === 3);
}

// ── Override beam + flue + clearance ──
{
  const u = computeUnitLoad({
    palletLengthIn: 48,
    palletWidthIn: 40,
    loadHeightIn: 60,
    beamHeightIn: 4,
    beamToLoadClearanceIn: 4,
    flueIn: 8,
    bayClearanceIn: 16,
  });
  // bay = 2*48 + 16 = 112 in
  t('overridden bayWidthIn = 112', u.bayWidthIn === 112);
  // pitch = 60 + 6 + 4 + 4 = 74 in
  t('overridden pitch = 74"/12', close(u.palletLevelHeightFt, 74 / 12));
  // back-to-back = 2 * (40+6) + 8 = 100 in / 12
  t('overridden b2b depth', close(u.rackDepthBackToBackFt, 100 / 12));
}

// ── Default invocation (no opts) is GMA-equivalent ──
{
  const u = computeUnitLoad();
  t('default = GMA bay 9.0', close(u.bayWidthFt, 9.0));
  t('default palletType = GMA', u.palletType === 'GMA');
  t('default maxGrossWeightLb = 2000', u.maxGrossWeightLb === 2000);
}

// ── Explicit weight passes through ──
{
  const u = computeUnitLoad({ maxGrossWeightLb: 3500 });
  t('weight override', u.maxGrossWeightLb === 3500);
}

// ── Constants exported sanity ──
{
  t('PALLET_TYPES.GMA', PALLET_TYPES.GMA && PALLET_TYPES.GMA.palletLengthIn === 48);
  t('PALLET_BAY_INTERIOR_CLEARANCE_IN = 12', PALLET_BAY_INTERIOR_CLEARANCE_IN === 12);
  t('BACK_TO_BACK_FLUE_IN = 6', BACK_TO_BACK_FLUE_IN === 6);
  t('BEAM_HEIGHT_IN = 5', BEAM_HEIGHT_IN === 5);
  t('BEAM_TO_LOAD_CLEARANCE_IN = 6', BEAM_TO_LOAD_CLEARANCE_IN === 6);
}

console.log(`\n\ntest-wsc-unit-load: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

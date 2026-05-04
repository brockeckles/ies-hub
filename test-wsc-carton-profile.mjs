// test-wsc-carton-profile.mjs — Phase 1 redesign coverage for computeCartonProfile.
// Validates ti×hi cartons-per-pallet, orientation-aware cartons-per-shelf,
// shelf level pitch, and carton-per-pallet override path.
import { computeCartonProfile } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const close = (a, b, eps = 0.001) => Math.abs(a - b) < eps;

// ── Default carton (12×9×12) on default pallet (48×40×60 load) ──
{
  const c = computeCartonProfile({ loadHeightIn: 60 });
  // ti = floor(48/12) × floor(40/9) = 4 × 4 = 16
  t('default ti = 16', c.ti === 16);
  // hi = floor(60/12) = 5
  t('default hi = 5', c.hi === 5);
  // cartonsPerPallet = 80
  t('default cartonsPerPallet = 80', c.cartonsPerPallet === 80);
  t('default override flag false', c.cartonsPerPalletOverride === false);
}

// ── Cartons-per-shelf default L-along-rack (3ft bay × 24" deck) ──
{
  const c = computeCartonProfile({});
  // bay 36" / 12" = 3 across; deck 24" / 9" = 2 deep; total = 6
  t('L-along across = 3', c.cartonsPerShelfAcross === 3);
  t('L-along deep = 2',   c.cartonsPerShelfDeep === 2);
  t('L-along total = 6',  c.cartonsPerShelf === 6);
  t('orientation default = L-along-rack', c.orientation === 'L-along-rack');
}

// ── Cartons-per-shelf W-along-rack ──
{
  const c = computeCartonProfile({ orientation: 'W-along-rack' });
  // bay 36" / 9" = 4 across; deck 24" / 12" = 2 deep; total = 8
  t('W-along across = 4', c.cartonsPerShelfAcross === 4);
  t('W-along deep = 2',   c.cartonsPerShelfDeep === 2);
  t('W-along total = 8',  c.cartonsPerShelf === 8);
}

// ── Override cartons-per-pallet ──
{
  const c = computeCartonProfile({ cartonsPerPalletOverride: 50 });
  t('override cartonsPerPallet = 50', c.cartonsPerPallet === 50);
  t('override flag true', c.cartonsPerPalletOverride === true);
  // ti × hi unaffected (still computed)
  t('ti still computed under override', c.ti === 16);
}

// ── Custom carton — small 6×6×6 ──
{
  const c = computeCartonProfile({
    cartonLengthIn: 6, cartonWidthIn: 6, cartonHeightIn: 6,
    palletLengthIn: 48, palletWidthIn: 40, loadHeightIn: 60,
  });
  // ti = floor(48/6) × floor(40/6) = 8 × 6 = 48
  // hi = floor(60/6) = 10
  // cpp = 480
  t('6³ ti = 48', c.ti === 48);
  t('6³ hi = 10', c.hi === 10);
  t('6³ cartonsPerPallet = 480', c.cartonsPerPallet === 480);
  // L-along: bay 36/6=6, deck 24/6=4, total 24
  t('6³ cartonsPerShelf = 24', c.cartonsPerShelf === 24);
}

// ── Custom carton — large 18×12×18 ──
{
  const c = computeCartonProfile({
    cartonLengthIn: 18, cartonWidthIn: 12, cartonHeightIn: 18,
    palletLengthIn: 48, palletWidthIn: 40, loadHeightIn: 60,
  });
  // ti = floor(48/18) × floor(40/12) = 2 × 3 = 6
  // hi = floor(60/18) = 3
  // cpp = 18
  t('18×12×18 ti = 6',  c.ti === 6);
  t('18×12×18 hi = 3',  c.hi === 3);
  t('18×12×18 cpp = 18', c.cartonsPerPallet === 18);
  // L-along: bay 36/18=2, deck 24/12=2, total 4
  t('18×12×18 cartonsPerShelf L-along = 4', c.cartonsPerShelf === 4);
}

// ── Carton too big for pallet (zero cartons fit) ──
{
  const c = computeCartonProfile({
    cartonLengthIn: 50, cartonWidthIn: 50, cartonHeightIn: 50,
    palletLengthIn: 48, palletWidthIn: 40, loadHeightIn: 60,
  });
  // ti = floor(48/50) × floor(40/50) = 0 × 0 = 0
  t('oversize carton ti = 0', c.ti === 0);
  t('oversize carton cpp = 0', c.cartonsPerPallet === 0);
}

// ── Shelf level pitch ──
{
  // Default 12" carton + 2" clearance = 14" pitch
  const c = computeCartonProfile({});
  t('shelfLevelHeightFt default 14"/12', close(c.shelfLevelHeightFt, 14 / 12));
  // 84" usable / 14" = 6 levels
  t('shelfLevelsAt84In default = 6', c.shelfLevelsAt84In === 6);
}

// ── Tall carton reduces shelf levels ──
{
  const c = computeCartonProfile({ cartonHeightIn: 24 });
  // 24" + 2" = 26" pitch → 84/26 = 3.23 → 3 levels
  t('24" carton shelfLevelsAt84In = 3', c.shelfLevelsAt84In === 3);
}

// ── Short carton increases shelf levels ──
{
  const c = computeCartonProfile({ cartonHeightIn: 6 });
  // 6 + 2 = 8" pitch → 84/8 = 10 levels
  t('6" carton shelfLevelsAt84In = 10', c.shelfLevelsAt84In === 10);
}

// ── Larger shelf bay (4 ft = 48") yields more cartons across ──
{
  const c = computeCartonProfile({ shelfBayWidthFt: 4 });
  // bay 48"/12" = 4 across; deck 24"/9" = 2 deep; total = 8
  t('4ft shelf bay across = 4', c.cartonsPerShelfAcross === 4);
  t('4ft shelf bay total = 8',  c.cartonsPerShelf === 8);
}

// ── Deeper deck (30") yields more cartons deep ──
{
  const c = computeCartonProfile({ shelfDeckDepthIn: 30 });
  // deck 30"/9" = 3 deep; bay 36/12 = 3 across; total = 9
  t('30" deck deep = 3', c.cartonsPerShelfDeep === 3);
  t('30" deck total = 9', c.cartonsPerShelf === 9);
}

// ── Default invocation: no opts ──
// Helper defaults: cartonL=12, cartonW=9, cartonH=12, palletL=48, palletW=40, loadH=60.
// ti = floor(48/12) × floor(40/9) = 4×4 = 16; hi = floor(60/12) = 5; cpp = 80.
// (Note: the sizeFacility wiring path uses SIZING_DEFAULTS.loadHeightIn=48, which yields cpp=64.
//  Direct invocation here uses the helper's own default of 60.)
{
  const c = computeCartonProfile();
  t('no-arg cpp = 80 (loadHeight=60)', c.cartonsPerPallet === 80);
  t('no-arg ti = 16', c.ti === 16);
  t('no-arg hi = 5',  c.hi === 5);
}

console.log(`\n\ntest-wsc-carton-profile: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

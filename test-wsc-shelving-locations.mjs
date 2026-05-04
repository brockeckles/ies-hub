// test-wsc-shelving-locations.mjs — Phase 1 redesign coverage for computeShelvingLocations.
// Validates demand-bound vs sku-bound mode tagging, max() selection of binding
// constraint, honeycomb + surge buffer math, bays-required derivation.
import { computeShelvingLocations } from './tools/warehouse-sizing/calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Demand-bound: 65,000 pallets × 15% × 64 cartons/pallet = 624,000 cartons / 6 per shelf = 104,000 locations
//    SKU floor 5,000 << demand 104,000 → demand-bound ──
{
  const r = computeShelvingLocations({
    totalPallets: 65000,
    shelvingMixPct: 0.15,
    cartonsPerPallet: 64,
    cartonsPerShelf: 6,
    shelvingSkus: 5000,
    shelfLevels: 7,
    honeycombPct: 0.10,
    surgePct: 0.20,
  });
  t('demand-bound demandCartons = 624,000', r.demandCartons === 624000);
  t('demand-bound demandLocations = 104,000', r.demandLocations === 104000);
  t('demand-bound skuMinLocations = 5,000', r.skuMinLocations === 5000);
  t('demand-bound mode tag', r.mode === 'demand-bound');
  t('demand-bound locationsRaw = 104,000', r.locationsRaw === 104000);
  // 104000 × 1.10 × 1.20 = 137,280 (ceil)
  t('demand-bound locationsRequired = 137,280', r.locationsRequired === 137280);
  // baysRequired = ceil(137280 / 7) = 19,612
  t('demand-bound baysRequired = 19,612', r.baysRequired === 19612);
}

// ── SKU-bound: very small carton demand vs huge SKU breadth (slow movers) ──
{
  const r = computeShelvingLocations({
    totalPallets: 1000,
    shelvingMixPct: 0.05,         // 50 pallets-equivalent
    cartonsPerPallet: 64,         // 3,200 cartons demand
    cartonsPerShelf: 8,           // 400 demand locations
    shelvingSkus: 2000,           // 2,000 SKU floor
    shelfLevels: 6,
    honeycombPct: 0.10,
    surgePct: 0.20,
  });
  t('sku-bound demandLocations = 400', r.demandLocations === 400);
  t('sku-bound skuMinLocations = 2,000', r.skuMinLocations === 2000);
  t('sku-bound mode tag', r.mode === 'sku-bound');
  t('sku-bound locationsRaw = 2,000 (SKU wins)', r.locationsRaw === 2000);
  // 2000 × 1.10 × 1.20 = 2,640 (ceil)
  t('sku-bound locationsRequired = 2,640', r.locationsRequired === 2640);
  // baysRequired = ceil(2640 / 6) = 440
  t('sku-bound baysRequired = 440', r.baysRequired === 440);
}

// ── Tie: demand exactly equals SKU min ──
{
  const r = computeShelvingLocations({
    totalPallets: 100,
    shelvingMixPct: 0.10,         // 10 pallets-equivalent
    cartonsPerPallet: 8,          // 80 cartons demand
    cartonsPerShelf: 1,           // 80 demand locations
    shelvingSkus: 80,             // tie
    shelfLevels: 4,
    honeycombPct: 0,
    surgePct: 0,
  });
  t('tie demandLocations = 80', r.demandLocations === 80);
  t('tie skuMinLocations = 80', r.skuMinLocations === 80);
  t('tie mode tag', r.mode === 'tie');
  t('tie locationsRaw = 80', r.locationsRaw === 80);
  t('tie no buffers → locationsRequired = 80', r.locationsRequired === 80);
  // baysRequired = ceil(80/4) = 20
  t('tie baysRequired = 20', r.baysRequired === 20);
}

// ── Zero pallets (empty system) ──
{
  const r = computeShelvingLocations({
    totalPallets: 0,
    shelvingMixPct: 0.15,
    cartonsPerPallet: 64,
    cartonsPerShelf: 6,
    shelvingSkus: 0,
    shelfLevels: 7,
  });
  t('empty demandCartons = 0', r.demandCartons === 0);
  t('empty demandLocations = 0', r.demandLocations === 0);
  t('empty locationsRequired = 0', r.locationsRequired === 0);
  t('empty baysRequired = 0', r.baysRequired === 0);
  t('empty mode = tie', r.mode === 'tie');
}

// ── Zero shelving mix (no shelving zone) ──
{
  const r = computeShelvingLocations({
    totalPallets: 50000,
    shelvingMixPct: 0,
    cartonsPerPallet: 64,
    cartonsPerShelf: 6,
    shelvingSkus: 0,
    shelfLevels: 7,
  });
  t('zero mix demandCartons = 0', r.demandCartons === 0);
  t('zero mix locationsRequired = 0', r.locationsRequired === 0);
}

// ── Zero cartonsPerShelf (mis-configured) ──
{
  const r = computeShelvingLocations({
    totalPallets: 50000,
    shelvingMixPct: 0.15,
    cartonsPerPallet: 64,
    cartonsPerShelf: 0,           // bad config
    shelvingSkus: 1000,
    shelfLevels: 7,
  });
  // Demand math degrades to 0; SKU floor takes over.
  t('zero cartonsPerShelf falls back to SKU min', r.locationsRaw === 1000);
  t('zero cartonsPerShelf mode = sku-bound', r.mode === 'sku-bound');
}

// ── Honeycomb-only (no surge) ──
{
  const r = computeShelvingLocations({
    totalPallets: 1000,
    shelvingMixPct: 0.10,
    cartonsPerPallet: 10,
    cartonsPerShelf: 1,
    shelvingSkus: 0,
    shelfLevels: 5,
    honeycombPct: 0.10,
    surgePct: 0,
  });
  // 1000 × 0.10 × 10 = 1000 cartons / 1 = 1000 locations
  // × 1.10 = 1100
  t('honeycomb-only buffer applied', r.locationsRequired === 1100);
}

// ── Surge-only (no honeycomb) ──
{
  const r = computeShelvingLocations({
    totalPallets: 1000,
    shelvingMixPct: 0.10,
    cartonsPerPallet: 10,
    cartonsPerShelf: 1,
    shelvingSkus: 0,
    shelfLevels: 5,
    honeycombPct: 0,
    surgePct: 0.20,
  });
  // 1000 × 1.20 = 1200
  t('surge-only buffer applied', r.locationsRequired === 1200);
}

// ── Both buffers compound multiplicatively, not additively ──
{
  const r = computeShelvingLocations({
    totalPallets: 1000,
    shelvingMixPct: 0.10,
    cartonsPerPallet: 10,
    cartonsPerShelf: 1,
    shelvingSkus: 0,
    shelfLevels: 5,
    honeycombPct: 0.10,
    surgePct: 0.20,
  });
  // 1000 × 1.10 × 1.20 = 1320 (NOT 1000 × 1.30 = 1300)
  t('compound buffers multiply', r.locationsRequired === 1320);
}

// ── Default honeycomb / surge when omitted ──
{
  const r = computeShelvingLocations({
    totalPallets: 1000,
    shelvingMixPct: 0.10,
    cartonsPerPallet: 10,
    cartonsPerShelf: 1,
    shelvingSkus: 0,
    shelfLevels: 5,
  });
  // Defaults: honeycomb 0.10, surge 0.20 → 1000 × 1.10 × 1.20 = 1320
  t('default buffers = 10% + 20%', r.locationsRequired === 1320);
}

// ── Default shelfLevels = 6 when omitted ──
{
  const r = computeShelvingLocations({
    totalPallets: 100,
    shelvingMixPct: 0.10,
    cartonsPerPallet: 6,
    cartonsPerShelf: 1,
    shelvingSkus: 0,
  });
  t('default shelfLevels = 6', r.shelfLevels === 6);
}

// ── Negative inputs clamped to zero ──
{
  const r = computeShelvingLocations({
    totalPallets: -100,
    shelvingMixPct: -0.05,
    cartonsPerPallet: -10,
    cartonsPerShelf: -2,
    shelvingSkus: -50,
    shelfLevels: -3,
  });
  t('negative inputs clamp to 0', r.demandLocations === 0 && r.skuMinLocations === 0);
  t('negative shelfLevels clamps to 1', r.shelfLevels === 1);
}

console.log(`\n\ntest-wsc-shelving-locations: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

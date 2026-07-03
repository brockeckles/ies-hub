/**
 * UX0-2 (2026-07-03) — WSC phantom defaults + dead throughput path.
 * (1) Display chip (calcStorageByType) and engine agree: no conversions = 0
 *     positions (chip used to invent 48/6/12/6/4 while the engine sized 0).
 * (2) Unit-conversion inputs are back in the UI so the inventory path is
 *     configurable at all.
 * (3) No || N phantom fallbacks left on dock/dashboard display paths.
 */
import { calcStorageByType } from './tools/warehouse-sizing/calc.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

t('chip agrees with engine: empty productDimensions → 0 positions', () => {
  const r = calcStorageByType({ clearHeight: 32 }, {
    peakUnitsPerDay: 100000,
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
  });
  if (r.totalPositions !== 0) throw new Error(`got ${r.totalPositions} on phantom conversions`);
});

t('chip still sizes correctly with real conversions', () => {
  const r = calcStorageByType({ clearHeight: 32 }, {
    peakUnitsPerDay: 100000,
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
    productDimensions: { unitsPerPallet: 48, unitsPerCartonPallet: 6, cartonsPerPallet: 12, unitsPerCartonShelving: 6, cartonsPerLocation: 4 },
  });
  // 100k × 60% / 48 = 1250 full-pallet positions
  if (r.fullPalletPositions !== 1250) throw new Error(`got ${r.fullPalletPositions}`);
});

const cfg = readFileSync('./tools/warehouse-sizing/ui-config.js', 'utf8');
const dash = readFileSync('./tools/warehouse-sizing/ui-dashboard.js', 'utf8');

t('all 5 unit-conversion inputs rendered (data-prod)', () =>
  ['unitsPerPallet', 'unitsPerCartonPallet', 'cartonsPerPallet', 'unitsPerCartonShelving', 'cartonsPerLocation']
    .every(f => cfg.includes(`data-prod="${f}"`)));

t('dock inputs have no || 10/12 phantom fallbacks', () => {
  if (/dockConfig\?\.\w+ \|\| 1[02]/.test(cfg)) throw new Error('phantom dock fallback still present');
  return /dockConfig\?\.inboundDoors \?\? 0/.test(cfg);
});

t('lazy-init seed is zeros, not 48/6/12/6/4', () =>
  !/productDimensions = \{ unitsPerPallet: 48/.test(cfg));

t('dashboard Peak Units/Day no longer invents 500000', () =>
  !dash.includes('peakUnitsPerDay || 500000'));

console.log(`test-ux0-wsc-honesty: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

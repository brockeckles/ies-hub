// test-netopt-ratecard-contract.mjs — P1-1 guard (2026-07-02 assessment).
// (A) Contract: every rateCard key the UI writes must be a key the engine
//     reads. The original bug: UI wrote tlPerMile/ltlPerLb/parcelPerLb,
//     engine read tlRatePerMile/ltlBreakRates/parcelZoneRates — silent no-op.
// (B) Unit tests for calc.normalizeRateCard (legacy-key migration + units).
// No network, no DOM. Run:  node test-netopt-ratecard-contract.mjs

import { readFileSync } from 'node:fs';
import {
  DEFAULT_RATES,
  PARCEL_WEIGHT_BRACKETS,
  normalizeRateCard,
  tlCost,
} from './tools/network-opt/calc.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

console.log('NetOpt rate-card contract');

// --- (A) static contract: UI writes ⊆ engine reads ------------------------
{
  const uiSrc = readFileSync(new URL('./tools/network-opt/ui.js', import.meta.url), 'utf8');
  // Keys the engine reads: everything in DEFAULT_RATES plus documented
  // option keys consulted by ltlCost/resolveLaneRates and UI-managed extras.
  const engineRead = new Set([
    ...Object.keys(DEFAULT_RATES),
    'breakRates', 'weightBreaks', 'nmfcClass', 'originRegion', 'destRegion',
    'ltlRegionMatrix', 'ltlClassMatrixOverrides', 'laneRates',
  ]);
  // Legacy keys are allowed to be STAGED but must pass through normalizeRateCard.
  const legacy = new Set(['tlPerMile', 'ltlPerLb', 'parcelPerLb']);

  const written = new Set();
  for (const m of uiSrc.matchAll(/rateCard\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) written.add(m[1]);
  // Fields bound via renderInput('Label', 'key', ...) land in rateCard[key] = val
  for (const m of uiSrc.matchAll(/renderInput\('[^']*',\s*'([\w$]+)'/g)) written.add(m[1]);

  const offenders = [...written].filter(k => !engineRead.has(k) && !legacy.has(k));
  ok(`every UI-written rateCard key is engine-read (offenders: ${offenders.join(',') || 'none'})`,
     offenders.length === 0);
  ok('phantom keys are not written directly to rateCard anymore',
     !/rateCard\.(tlPerMile|ltlPerLb|parcelPerLb)\s*=(?!=)/.test(uiSrc));
  ok('stepper completeness keys off tlRatePerMile',
     /case 'rates':.*tlRatePerMile/.test(uiSrc));
  ok('CSV path normalizes staged legacy keys',
     /normalizeRateCard\(\{ \.\.\.rateCard, \.\.\.staged \}\)/.test(uiSrc));
  ok('saved-scenario load path normalizes rateCard',
     /rateCard = calc\.normalizeRateCard\(d\.rateCard/.test(uiSrc));
}

// --- (B) normalizeRateCard units ------------------------------------------
{
  // TL: direct rename
  const c1 = normalizeRateCard({ ...DEFAULT_RATES, tlPerMile: 2.25 });
  ok('tlPerMile -> tlRatePerMile', c1.tlRatePerMile === 2.25 && !('tlPerMile' in c1));
  ok('normalized TL rate reaches tlCost', Math.abs(tlCost(1000, c1.tlRatePerMile, 0) - 2250) < 1e-6);

  // LTL: $/lb heuristic (<2) -> $/CWT, curve anchored at 1,000-lb break
  const c2 = normalizeRateCard({ ...DEFAULT_RATES, ltlPerLb: 0.15 });
  ok('ltlPerLb 0.15 -> 15 $/CWT at 1,000-lb break', Math.abs(c2.ltlBreakRates[1] - 15) < 0.01);
  ok('LTL curve shape preserved',
     Math.abs(c2.ltlBreakRates[0] / c2.ltlBreakRates[1] - DEFAULT_RATES.ltlBreakRates[0] / DEFAULT_RATES.ltlBreakRates[1]) < 0.01);
  ok('ltlBaseRate follows', Math.abs(c2.ltlBaseRate - 15) < 0.01);

  // LTL: values >= 2 already $/CWT
  const c3 = normalizeRateCard({ ...DEFAULT_RATES, ltlPerLb: 18.5 });
  ok('ltlPerLb 18.5 treated as $/CWT', Math.abs(c3.ltlBreakRates[1] - 18.5) < 0.01);

  // Parcel: reference cell (Zone 5, 25 lb) == rate x 25
  const c4 = normalizeRateCard({ ...DEFAULT_RATES, parcelPerLb: 2.0 });
  ok('parcelPerLb 2.0 -> Zone-5/25-lb cell = 50', Math.abs(c4.parcelZoneRates[3][3] - 2.0 * PARCEL_WEIGHT_BRACKETS[3]) < 0.01);
  ok('parcel matrix scaled uniformly',
     Math.abs(c4.parcelZoneRates[0][0] / DEFAULT_RATES.parcelZoneRates[0][0] - c4.parcelZoneRates[6][5] / DEFAULT_RATES.parcelZoneRates[6][5]) < 0.01);

  // Clean card: no-op
  const clean = normalizeRateCard({ ...DEFAULT_RATES });
  ok('clean card no-op', clean.tlRatePerMile === DEFAULT_RATES.tlRatePerMile
     && JSON.stringify(clean.ltlBreakRates) === JSON.stringify(DEFAULT_RATES.ltlBreakRates)
     && JSON.stringify(clean.parcelZoneRates) === JSON.stringify(DEFAULT_RATES.parcelZoneRates));

  // All three legacy keys at once
  const c5 = normalizeRateCard({ ...DEFAULT_RATES, tlPerMile: 3.1, ltlPerLb: 0.2, parcelPerLb: 1.5 });
  ok('all three legacy keys migrate together',
     c5.tlRatePerMile === 3.1 && Math.abs(c5.ltlBreakRates[1] - 20) < 0.01
     && Math.abs(c5.parcelZoneRates[3][3] - 37.5) < 0.01
     && !('tlPerMile' in c5) && !('ltlPerLb' in c5) && !('parcelPerLb' in c5));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('FAILED:', fails.join(' | ')); process.exit(1); }

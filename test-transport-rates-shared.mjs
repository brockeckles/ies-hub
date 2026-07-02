/**
 * P1-4 (2026-07-02) — shared transport-rates contract + cross-tool parity.
 *
 * Guards the "same lane, three answers" class: COG, NetOpt, and Fleet
 * must all price off shared/transport-rates.js primitives. If a tool
 * re-introduces a local zone table / rate matrix / road factor, a test
 * here should break.
 */
// Import shared via the SAME ?v= specifier the tools use — ES modules key
// on full URL incl. query, so a bare import would be a second instance and
// the === identity checks below would false-fail. Extract it from source.
import { readFileSync } from 'node:fs';
const pcSrcForSpec = readFileSync('./tools/center-of-gravity/parcel-calc.js', 'utf8');
const specMatch = pcSrcForSpec.match(/from '(\.\.\/\.\.\/shared\/transport-rates\.js[^']*)'/);
if (!specMatch) { console.error('  ✗ parcel-calc no longer imports shared/transport-rates.js'); process.exit(1); }
const tr = await import(specMatch[1].replace('../../', './'));
import * as cog from './tools/center-of-gravity/calc.js';
import * as pc from './tools/center-of-gravity/parcel-calc.js';
import * as net from './tools/network-opt/calc.js';
import * as fleet from './tools/fleet-modeler/calc.js';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`  ✗ ${name}`); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// --- zone table parity -------------------------------------------------
// NetOpt's old local table was shifted one bracket early (100 mi → Z3).
const zoneSamples = [0, 25, 50, 100, 150, 151, 300, 301, 500, 600, 601, 999, 1000, 1001, 1400, 1401, 1799, 1800, 1801, 2600];
t('NetOpt parcelZone === shared zoneForMiles at every breakpoint edge',
  zoneSamples.every(mi => net.parcelZone(mi) === tr.zoneForMiles(mi)));
t('COG re-export zoneForMiles is the shared function', pc.zoneForMiles === tr.zoneForMiles && cog.zoneForMiles === tr.zoneForMiles);
t('100 mi is Zone 2 (old NetOpt table said 3)', net.parcelZone(100) === 2);

// --- published tables are the single source ---------------------------
t('COG rate tables are the shared objects (no local copy)',
  pc.FEDEX_GROUND_2026_LIST === tr.FEDEX_GROUND_2026_LIST
  && pc.UPS_GROUND_2026_LIST === tr.UPS_GROUND_2026_LIST
  && pc.USPS_GROUND_ADVANTAGE_2026_LIST === tr.USPS_GROUND_ADVANTAGE_2026_LIST
  && pc.PARCEL_RATE_TABLES === tr.PARCEL_RATE_TABLES);
t('interpolateRate single-sourced', pc.interpolateRate === tr.interpolateRate);

// --- NetOpt default matrix derived from the published FedEx table -----
{
  const m = net.DEFAULT_RATES.parcelZoneRates;
  t('NetOpt matrix shape preserved (7 zones × 6 brackets)', m.length === 7 && m.every(r => r.length === 6));
  let allMatch = true;
  const zones = [2, 3, 4, 5, 6, 7, 8];
  zones.forEach((z, zi) => tr.PARCEL_WEIGHT_BRACKETS.forEach((w, wi) => {
    if (!near(m[zi][wi], +tr.interpolateRate(w, z, tr.FEDEX_GROUND_2026_LIST).toFixed(2), 0.005)) allMatch = false;
  }));
  t('every NetOpt default cell equals published FedEx interpolation', allMatch);
  t('Zone-5/25-lb normalizeRateCard anchor cell intact at [3][3]',
    near(m[3][3], +tr.interpolateRate(25, 5, tr.FEDEX_GROUND_2026_LIST).toFixed(2), 0.005));
}

// --- normalizeRateCard still anchors on the new matrix ----------------
{
  const c = net.normalizeRateCard({ parcelPerLb: 2.0 });
  t('parcelPerLb 2.0 → Zone-5/25-lb cell = 50 on published-derived matrix',
    near(c.parcelZoneRates[3][3], 50, 0.01));
}

// --- road factor -------------------------------------------------------
t('shared road factor is 1.22', tr.DEFAULT_ROAD_FACTOR === 1.22);
t('COG config road factor comes from shared', cog.DEFAULT_CONFIG.roadFactor === tr.DEFAULT_ROAD_FACTOR);
t('NetOpt rate card now carries the shared road factor', net.DEFAULT_RATES.roadFactor === tr.DEFAULT_ROAD_FACTOR);
{
  // TL-only lane: cost must reflect road miles (gc × 1.22), not gc miles.
  const gc = 1000, wt = 40000;
  const r = net.blendedLaneCost(gc, wt, { tlPct: 100, ltlPct: 0, parcelPct: 0 });
  const expected = net.tlCost(tr.roadMiles(gc), net.DEFAULT_RATES.tlRatePerMile, net.DEFAULT_RATES.fuelSurcharge);
  t('NetOpt TL lane priced at road miles (was great-circle, ~18% under)', near(r.tlCost, expected, 0.01));
  const off = net.blendedLaneCost(gc, wt, { tlPct: 100, ltlPct: 0, parcelPct: 0 }, { ...net.DEFAULT_RATES, roadFactor: 1 });
  t('roadFactor:1 override restores great-circle pricing', near(off.tlCost, net.tlCost(gc, net.DEFAULT_RATES.tlRatePerMile, net.DEFAULT_RATES.fuelSurcharge), 0.01));
  t('zero-mile lane still short-circuits to $0', net.blendedLaneCost(0, wt, { tlPct: 100, ltlPct: 0, parcelPct: 0 }).blendedCost === 0);
}

// --- parcel zoning off road miles (COG parity) -------------------------
{
  // 130 gc mi → 158.6 road mi → Zone 3 (COG zones off road miles too).
  const rc = { ...net.DEFAULT_RATES };
  const r = net.blendedLaneCost(130, 25, { tlPct: 0, ltlPct: 0, parcelPct: 100 }, rc);
  const zone = tr.zoneForMiles(tr.roadMiles(130));
  t('parcel leg zones off road miles', zone === 3 && r.parcelCost > 0);
}

// --- same-lane parcel parity: NetOpt base vs COG published base --------
{
  // One 25-lb package, 500 gc miles. NetOpt: matrix cell × (1+fuel).
  // COG list-rate path: interpolateRate at same zone × (1+fuelPct/100).
  const roadMi = tr.roadMiles(500);
  const zone = tr.zoneForMiles(roadMi);
  const netCost = net.parcelCost(25, roadMi); // matrix lookup + 12% fuel
  const cogBase = tr.interpolateRate(25 * 1.2, zone, tr.FEDEX_GROUND_2026_LIST); // netopt applies 1.2 billable uplift
  // netopt brackets are floors (>= bracket), so 30 lb bills the 25-lb cell:
  const netBase = net.DEFAULT_RATES.parcelZoneRates[zone - 2][3];
  t('NetOpt parcel base cell = published FedEx rate at that zone/bracket',
    near(netBase, +tr.interpolateRate(25, zone, tr.FEDEX_GROUND_2026_LIST).toFixed(2), 0.005) && netCost > netBase);
}

// --- Fleet ties to shared contract TL ----------------------------------
t('Fleet dry-van benchmark = shared TL × common-carrier premium (3.50)',
  near(fleet.FALLBACK_CARRIER_RATES['dry-van'].base_rate_per_mile,
       +(tr.DEFAULT_TL_RATE_PER_MILE * tr.COMMON_CARRIER_PREMIUM).toFixed(2), 1e-9));
t('shared contract TL rate matches COG transportCostPerMile',
  cog.DEFAULT_CONFIG.transportCostPerMile === tr.DEFAULT_TL_RATE_PER_MILE
  && net.DEFAULT_RATES.tlRatePerMile === tr.DEFAULT_TL_RATE_PER_MILE);

// --- no local copies left ----------------------------------------------
{
  const netSrc = readFileSync('./tools/network-opt/calc.js', 'utf8');
  t('NetOpt no longer hardcodes the old synthetic Zone-2 row', !netSrc.includes('[8.50, 11.20, 14.80'));
  t('NetOpt no longer hardcodes the shifted 50-mi Zone-2 branch', !netSrc.includes('if (miles <= 50) return 2'));
  const pcSrc = readFileSync('./tools/center-of-gravity/parcel-calc.js', 'utf8');
  t('parcel-calc no longer defines its own FedEx table', !pcSrc.includes('weightBands: [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150]'));
}

console.log(`test-transport-rates-shared: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);

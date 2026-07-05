/**
 * IES Hub v3 — WSC dynamics engine (N4, 2026-07-04)
 *
 * Docks, staging, and aisles become THROUGHPUT-DERIVED conclusions:
 *
 *   MHE fleet   ← media plan (N3) + clear height   → aisle widths
 *   Dock doors  ← peak-day pallet flow ÷ (door rate × arrival window) × safety
 *                 cross-checked against the legacy dwell-based method
 *                 (calc.js computeDockRequirement) — divergence is flagged,
 *                 and the sqft-ratio rule of thumb prints as SANITY ONLY.
 *   Staging SF  ← dwell-driven: pallets/day × dwell days × footprint ÷ density,
 *                 floored at 510 sqft/door. Dwell is the dominant sensitivity.
 *
 * All rates/factors come from the pinned N2 catalog with seed fallbacks;
 * every output carries rationale + factor citations.
 *
 * Pure module — zero DOM. Tested by test-wsc-dynamics.mjs.
 *
 * @module tools/warehouse-sizing/dynamics-calc
 */

import { wscFactorValue } from './factors-calc.js?v=20260704-n2a';
import { computeDockRequirement } from './calc.js?v=20260703-ux0';

const GMA_PALLET_FOOTPRINT_SQFT = (48 * 40) / 144; // 13.33

const DEFAULTS = {
  doorRatePalletized: { min: 20, max: 35 },       // plt/door-hr
  mulcahySafety: 1.25,
  minSqftPerDoor: 510,
  netDensityFactor: 0.5,
  doorPerSqftSanity: { min: 5000, max: 10000 },
  aisles: {
    counterbalance: { min: 12, max: 13 }, reach: { min: 8, max: 10 },
    double_deep_reach: { min: 9, max: 10 }, vna_turret_clear_in: 66,
    order_picker: { min: 4, max: 5 },
  },
};

const _mid = (band) => (band && band.min != null && band.max != null) ? (band.min + band.max) / 2 : null;
function _factor(pinned, code, fallback) {
  const v = wscFactorValue(pinned, code);
  return v == null ? fallback : v;
}

// ============================================================
// MHE SELECTION — media families + clear height → fleet + aisles
// ============================================================

/**
 * N4 MHE-selection logic (v1, documented for Brock's review):
 *   - Reach truck = default storage truck (selective / push-back / flow /
 *     drive-in lane entry). Aisle = reach band.
 *   - Double-deep in plan → double-deep reach (pantograph), its wider band
 *     governs those aisles.
 *   - Counterbalance always present for trailer/dock work (never governs
 *     storage aisles).
 *   - Shelving band in plan → order picker at 4–5 ft pick aisles.
 *   - VNA/turret = ADVISORY ONLY when clear ≥ 35 ft and selective-family
 *     positions ≥ 50% of the portfolio (density upside up to +50%, but
 *     requires F-min defined-traffic floor — an engineering commitment,
 *     not a default).
 *
 * @param {Object} args — { mediaPlan, clearHeightFt, pinnedFactors }
 * @returns {{ fleet: Object[], governingAisleFt: number, vnaAdvisory: string|null, citations: string[] }}
 */
export function selectMhe({ mediaPlan, clearHeightFt = 32, pinnedFactors = null } = {}) {
  const aisles = _factor(pinnedFactors, 'wsc.aisle.widths_by_mhe_ft', DEFAULTS.aisles);
  const families = new Set((mediaPlan?.bands || []).map(b => b.family));
  const hasShelving = !!mediaPlan?.shelving;
  const fleet = [];

  const reachAisle = _mid(aisles.reach) ?? 9;
  const ddAisle = _mid(aisles.double_deep_reach) ?? 9.5;
  const cbAisle = _mid(aisles.counterbalance) ?? 12.5;
  const opAisle = _mid(aisles.order_picker) ?? 4.5;

  const storageFamilies = [...families].filter(f => f !== 'double_deep');
  if (storageFamilies.length > 0 || families.size === 0) {
    fleet.push({
      type: 'reach', label: 'Reach truck', role: 'storage put-away / retrieval',
      servesFamilies: storageFamilies.length ? storageFamilies : ['selective'],
      aisleFt: reachAisle,
      rationale: `Default storage truck for ${storageFamilies.join(', ') || 'selective'} — ${aisles.reach.min}–${aisles.reach.max} ft aisles (planned at ${reachAisle} ft midpoint)`,
    });
  }
  if (families.has('double_deep')) {
    fleet.push({
      type: 'double_deep_reach', label: 'Double-deep reach', role: 'double-deep lanes',
      servesFamilies: ['double_deep'], aisleFt: ddAisle,
      rationale: `Pantograph reach for 2-deep lanes — ${aisles.double_deep_reach.min}–${aisles.double_deep_reach.max} ft aisles (planned ${ddAisle} ft)`,
    });
  }
  fleet.push({
    type: 'counterbalance', label: 'Counterbalance (dock)', role: 'trailer load/unload + yard',
    servesFamilies: [], aisleFt: cbAisle,
    rationale: `Dock ops — ${aisles.counterbalance.min}–${aisles.counterbalance.max} ft maneuvering (does not govern storage aisles)`,
  });
  if (hasShelving) {
    fleet.push({
      type: 'order_picker', label: 'Order picker', role: 'shelving / bin picking',
      servesFamilies: ['shelving'], aisleFt: opAisle,
      rationale: `Shelving band pick aisles ${aisles.order_picker.min}–${aisles.order_picker.max} ft (planned ${opAisle} ft)`,
    });
  }

  // Storage aisle that governs the layout = widest truck that works storage.
  const storageTrucks = fleet.filter(f => f.type !== 'counterbalance' && f.type !== 'order_picker');
  const governingAisleFt = storageTrucks.length ? Math.max(...storageTrucks.map(f => f.aisleFt)) : reachAisle;

  // VNA advisory
  let vnaAdvisory = null;
  const bands = mediaPlan?.bands || [];
  const totalPos = bands.reduce((s, b) => s + b.positions, 0);
  const selectivePos = bands.filter(b => b.family === 'selective' || b.family === 'double_deep')
    .reduce((s, b) => s + b.positions, 0);
  if (clearHeightFt >= 35 && totalPos > 0 && selectivePos / totalPos >= 0.5) {
    const gain = _factor(pinnedFactors, 'wsc.aisle.narrow_aisle_storage_gain_pct', { vna_max: 50 });
    vnaAdvisory = `Clear height ${clearHeightFt} ft with ${Math.round((selectivePos / totalPos) * 100)}% selective-class positions — ` +
      `VNA/turret at ${aisles.vna_turret_clear_in}" aisles could add up to ${gain.vna_max}% storage density. ` +
      `Requires F-min defined-traffic floor spec (ACI 360) — flag for engineering study, not a default.`;
  }

  return {
    fleet, governingAisleFt, vnaAdvisory,
    citations: ['wsc.aisle.widths_by_mhe_ft'].concat(vnaAdvisory ? ['wsc.aisle.narrow_aisle_storage_gain_pct'] : []),
  };
}

// ============================================================
// DOCKS — rate-based method + legacy dwell cross-check
// ============================================================

/**
 * Rate-based door count: pallets/day ÷ (door rate × arrival window) × safety.
 * @returns {{ doors: number, doorsRaw: number, rateUsed: number, ... }}
 */
export function computeDoorsRateMethod({ palletsPerDay, arrivalWindowHrs = 8, doorRate = null, safetyFactor = DEFAULTS.mulcahySafety } = {}) {
  const rate = _mid(doorRate) ?? _mid(DEFAULTS.doorRatePalletized);
  const raw = palletsPerDay > 0 && arrivalWindowHrs > 0 ? (palletsPerDay / (rate * arrivalWindowHrs)) * safetyFactor : 0;
  return { doors: Math.ceil(raw), doorsRaw: Math.round(raw * 100) / 100, rateUsed: rate, arrivalWindowHrs, safetyFactor };
}

// ============================================================
// STAGING — dwell-driven with per-door floor
// ============================================================

export function computeStagingSf({ palletsPerDay, dwellDays = 1, doors = 0, palletFootprintSqft = GMA_PALLET_FOOTPRINT_SQFT, netDensityFactor = DEFAULTS.netDensityFactor, minSqftPerDoor = DEFAULTS.minSqftPerDoor } = {}) {
  const stagedPallets = Math.max(0, palletsPerDay) * Math.max(0, dwellDays);
  const dwellSqft = stagedPallets * palletFootprintSqft / (netDensityFactor || 0.5);
  const floorSqft = doors * minSqftPerDoor;
  const sqft = Math.ceil(Math.max(dwellSqft, floorSqft));
  return {
    sqft, stagedPallets: Math.round(stagedPallets), dwellSqft: Math.ceil(dwellSqft), floorSqft,
    governedBy: dwellSqft >= floorSqft ? 'dwell' : 'door floor',
    dwellSensitive: dwellDays > 1,
  };
}

// ============================================================
// ORCHESTRATOR
// ============================================================

/**
 * @param {Object} args
 * @param {Object|null} args.profile — DesignProfile (N1)
 * @param {Object|null} args.mediaPlan — MediaPlan (N3)
 * @param {Object} args.volumes — WSC volumes (avgDailyInbound/Outbound in pallets/day, peakMultiplier, daysOnHand)
 * @param {Object} args.facility — WSC facility (clearHeight, totalSqft)
 * @param {{rows: Object[]}|null} [args.pinnedFactors]
 * @param {{ dwellDaysIn?: number, dwellDaysOut?: number, arrivalWindowHrs?: number }} [args.policy]
 * @returns {Object|null} DynamicsPlan
 */
export function computeDynamics({ profile = null, mediaPlan = null, volumes = {}, facility = {}, pinnedFactors = null, policy = {} } = {}) {
  const gaps = [];
  const peak = Number(volumes.peakMultiplier) > 0 ? Number(volumes.peakMultiplier) : (profile?.peak?.peakFactor || 1.3);

  // ── Daily pallet flow (design day = peak) ──
  let outPerDay = Number(volumes.avgDailyOutbound) > 0 ? Number(volumes.avgDailyOutbound) : null;
  let inPerDay = Number(volumes.avgDailyInbound) > 0 ? Number(volumes.avgDailyInbound) : null;
  let flowProvenance = 'asserted';
  if (outPerDay == null) {
    const onHand = profile?.volumes?.onHandPallets ?? (Number(volumes.totalPallets) > 0 ? Number(volumes.totalPallets) : null);
    const doh = Number(volumes.daysOnHand) > 0 ? Number(volumes.daysOnHand) : 30;
    if (onHand > 0) {
      outPerDay = onHand / doh;           // inventory flow balance: stock ÷ days-of-holding
      flowProvenance = 'estimated';
      gaps.push({ code: 'FLOW_ESTIMATED', severity: 'warn',
        message: `Daily outbound estimated from on-hand ÷ ${doh} DOH (${Math.round(outPerDay)} plt/day) — enter real daily flows for a defendable dock count.` });
    }
  }
  if (outPerDay == null) return null;     // nothing to derive from
  if (inPerDay == null) {
    inPerDay = outPerDay;                 // steady-state flow balance
    if (flowProvenance === 'asserted') gaps.push({ code: 'INBOUND_BALANCED', severity: 'info',
      message: 'Inbound assumed = outbound (steady-state flow balance).' });
  }
  const peakIn = inPerDay * peak;
  const peakOut = outPerDay * peak;

  // ── Factors ──
  const doorRate = _factor(pinnedFactors, 'wsc.dock.palletized_pallets_per_door_hr', DEFAULTS.doorRatePalletized);
  const safety = Number(_factor(pinnedFactors, 'wsc.dock.mulcahy_safety_factor', DEFAULTS.mulcahySafety));
  const minPerDoor = Number(_factor(pinnedFactors, 'wsc.staging.min_sqft_per_door', DEFAULTS.minSqftPerDoor));
  const netDensity = Number(_factor(pinnedFactors, 'wsc.staging.net_density_factor', DEFAULTS.netDensityFactor));
  const sanity = _factor(pinnedFactors, 'wsc.dock.door_per_sqft_sanity', DEFAULTS.doorPerSqftSanity);
  const usedFallback = !pinnedFactors || !(pinnedFactors.rows || []).length;
  if (usedFallback) gaps.push({ code: 'FACTORS_UNPINNED', severity: 'info',
    message: 'Factor catalog not pinned — dynamics used seed defaults; save the scenario to pin.' });

  const arrivalWindowHrs = Number(policy.arrivalWindowHrs) > 0 ? Number(policy.arrivalWindowHrs) : 8;
  const dwellIn = Number(policy.dwellDaysIn) >= 0 ? Number(policy.dwellDaysIn) : 1;
  const dwellOut = Number(policy.dwellDaysOut) >= 0 ? Number(policy.dwellDaysOut) : 0.5;

  // ── Docks: rate method (primary) + dwell method (cross-check) ──
  const inbound = computeDoorsRateMethod({ palletsPerDay: peakIn, arrivalWindowHrs, doorRate, safetyFactor: safety });
  const outbound = computeDoorsRateMethod({ palletsPerDay: peakOut, arrivalWindowHrs, doorRate, safetyFactor: safety });
  const dwellCheck = computeDockRequirement({ peakThroughputPalletsPerDay: peakIn + peakOut, shiftHoursPerDay: arrivalWindowHrs * 2 });
  const totalDoors = inbound.doors + outbound.doors;
  const methodsDiverge = dwellCheck.doorsBySurge > 0 && Math.abs(totalDoors - dwellCheck.doorsBySurge) / dwellCheck.doorsBySurge > 0.5;
  if (methodsDiverge) gaps.push({ code: 'DOCK_METHODS_DIVERGE', severity: 'warn',
    message: `Rate method (${totalDoors} doors) vs dwell method (${dwellCheck.doorsBySurge}) differ >50% — review arrival window & truck size before defending.` });

  // ── Sanity ratio (print, never design) ──
  let sanityNote = null;
  const sqft = Number(facility.totalSqft) > 0 ? Number(facility.totalSqft) : null;
  if (sqft && totalDoors > 0) {
    const ratio = Math.round(sqft / totalDoors);
    const inBand = ratio >= sanity.min && ratio <= sanity.max;
    sanityNote = `1 door per ${ratio.toLocaleString()} sqft — ${inBand ? 'inside' : 'OUTSIDE'} the ${sanity.min.toLocaleString()}–${sanity.max.toLocaleString()} sqft/door rule-of-thumb band (sanity check only; throughput math governs).`;
    if (!inBand) gaps.push({ code: 'DOOR_RATIO_OUTSIDE_BAND', severity: 'info', message: sanityNote });
  }

  // ── Staging ──
  const stagingIn = computeStagingSf({ palletsPerDay: peakIn, dwellDays: dwellIn, doors: inbound.doors, netDensityFactor: netDensity, minSqftPerDoor: minPerDoor });
  const stagingOut = computeStagingSf({ palletsPerDay: peakOut, dwellDays: dwellOut, doors: outbound.doors, netDensityFactor: netDensity, minSqftPerDoor: minPerDoor });
  if (dwellIn >= 2) gaps.push({ code: 'DWELL_DOMINANT', severity: 'warn',
    message: `Inbound dwell of ${dwellIn} days multiplies staging ${Math.round(dwellIn / 0.5)}× vs same-shift clearance — validate dwell with ops before defending ${stagingIn.sqft.toLocaleString()} sqft.` });

  // ── MHE ──
  const mhe = selectMhe({ mediaPlan, clearHeightFt: Number(facility.clearHeight) || 32, pinnedFactors });
  if (!mediaPlan) gaps.push({ code: 'NO_MEDIA_PLAN', severity: 'info',
    message: 'No media plan yet — MHE defaulted to reach + counterbalance; run Media Selection first for a defendable fleet.' });

  return {
    engine: 'wsc-dynamics-v1',
    createdAt: new Date().toISOString().slice(0, 10),
    provenance: flowProvenance === 'asserted' && !usedFallback ? 'derived' : 'estimated',
    policy: { arrivalWindowHrs, dwellDaysIn: dwellIn, dwellDaysOut: dwellOut },
    flow: { inPerDay: Math.round(inPerDay), outPerDay: Math.round(outPerDay), peakFactor: peak,
            peakIn: Math.round(peakIn), peakOut: Math.round(peakOut), provenance: flowProvenance },
    docks: {
      inbound, outbound, totalDoors,
      dwellCheck: { doors: dwellCheck.doorsBySurge, trucksPerPeakDay: dwellCheck.trucksPerPeakDay },
      methodsDiverge, sanityNote,
      rationale: `${Math.round(peakIn).toLocaleString()} in + ${Math.round(peakOut).toLocaleString()} out peak plt/day ÷ (${inbound.rateUsed} plt/door-hr × ${arrivalWindowHrs} hr window) × ${safety} safety → ${inbound.doors} in / ${outbound.doors} out`,
    },
    staging: { inbound: stagingIn, outbound: stagingOut, totalSqft: stagingIn.sqft + stagingOut.sqft },
    mhe,
    gaps,
    citations: ['wsc.dock.palletized_pallets_per_door_hr', 'wsc.dock.mulcahy_safety_factor',
      'wsc.dock.door_per_sqft_sanity', 'wsc.staging.min_sqft_per_door', 'wsc.staging.net_density_factor']
      .concat(mhe.citations),
  };
}

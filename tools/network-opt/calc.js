/**
 * IES Hub v3 — Network Optimization Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 *
 * @module tools/network-opt/calc
 */

// ============================================================
// CONSTANTS
// ============================================================

/** Earth radius in miles for Haversine */
const EARTH_RADIUS_MI = 3959;

/** Default rate card.
 *
 * SYNTHETIC TARIFF — calibrated to public LTL rate-base ranges (CzarLite-style:
 * $20–$50/CWT base for standard LTL, weight-break thresholds at 500/1k/2k/5k/10k/20k lb,
 * 30–50% mid-shipper discount off published, 10–18% FSC). Replace with contract rates
 * before quoting. Sources: Hatfield & Associates, Trans Logistics, FreightWise. */
export const DEFAULT_RATES = {
  tlRatePerMile: 2.85,
  ltlBaseRate: 18.50, // $/CWT
  // Weight breaks for the class-100 baseline row. Other classes derive via NMFC_CLASS_MULTIPLIERS.
  ltlWeightBreaks: [500, 1000, 2000, 5000, 10000, 20000],
  ltlBreakRates:   [22.00, 18.50, 15.00, 12.50, 10.00, 8.50],
  // Discount % off published tariff (typical mid-size shipper: 30-50%; large: 50-70%).
  ltlDiscountPct: 50,
  // Minimum charge floor per shipment (typical industry $90-$120 absolute minimum).
  ltlMinCharge: 110,
  parcelZoneRates: [
    // Zones 2-8, weight brackets: 1lb, 5lb, 10lb, 25lb, 50lb, 70lb
    [8.50, 11.20, 14.80, 22.50, 35.00, 45.00],   // Zone 2
    [9.80, 13.50, 17.20, 26.00, 40.00, 52.00],   // Zone 3
    [11.20, 15.80, 20.50, 31.00, 48.00, 62.00],  // Zone 4
    [13.50, 18.20, 24.00, 36.50, 56.00, 72.00],  // Zone 5
    [15.80, 21.50, 28.50, 43.00, 66.00, 85.00],  // Zone 6
    [18.50, 25.00, 33.00, 50.00, 77.00, 99.00],  // Zone 7
    [22.00, 29.50, 39.00, 59.00, 91.00, 117.00], // Zone 8
  ],
  fuelSurcharge: 0.12,
  // NET-C1 — Per-lane rate overrides. Each entry shadows the global rates
  // for a specific origin→destination pair when both keys match. Use facility
  // ids, demand-point ids, region codes, or '*' wildcards. First match wins.
  /** @type {Array<{
   *    originId?: string|null, destId?: string|null,
   *    originRegion?: string, destRegion?: string,
   *    tlRatePerMile?: number, ltlMinCharge?: number,
   *    ltlDiscountPct?: number, fuelSurcharge?: number, parcelZoneOverride?: number
   *  }>} */
  laneRates: [],
};

export const PARCEL_WEIGHT_BRACKETS = [1, 5, 10, 25, 50, 70];

/** Default service config */
export const DEFAULT_SERVICE = {
  targetServicePct: 95,
  globalMaxDays: 3,
  truckSpeedMph: 50,
  hardConstraint: false,
  // Hard constraints (B-series; ignored if empty / null)
  /** @type {string[]} */ lockedOpenIds: [],
  /** @type {string[]} */ lockedClosedIds: [],
  /** @type {number|null} */ maxDistanceMiles: null,
  // NET-B5 — transit-day model opts. Picked up by estimateTransitDays via
  // the (miles, speedMph, opts) signature when serviceConfig is forwarded as
  // opts. Defaults match HOS §395.3 (11hr drive, 14hr on-duty, 2hr load+unload).
  drivingHoursPerDay: 11,
  onDutyHoursPerDay: 14,
  loadHours: 2,
  unloadHours: 2,
  dwellHoursPerStop: 0,
  intermediateStops: 0,
};

/**
 * NMFC freight-class multipliers vs class 100 baseline.
 * Standard 18 classes per ANSI/NMFTA. Lower class = denser freight = lower rate.
 * Multipliers are typical industry curves (LTL 101 reference) and feed
 * `ltlCost(weight, miles, { nmfcClass })`.
 */
export const NMFC_CLASS_MULTIPLIERS = {
  50:  0.65,
  55:  0.72,
  60:  0.78,
  65:  0.85,
  70:  0.92,
  77.5: 0.97,
  85:  1.00,
  92.5: 1.05,
  100: 1.00,   // baseline
  110: 1.10,
  125: 1.20,
  150: 1.35,
  175: 1.50,
  200: 1.65,
  250: 1.85,
  300: 2.05,
  400: 2.30,
  500: 2.60,
};

/** All allowed NMFC class codes, sorted ascending — useful for UI selects. */
export const NMFC_CLASS_CODES = Object.keys(NMFC_CLASS_MULTIPLIERS).map(Number).sort((a, b) => a - b);

/**
 * Seasonality profile catalog for NET-C3.
 * Each profile is a 12-element monthlyShare array (% of annual demand) summing to ~100.
 * Drives peak-month inventory and capacity sizing in NetOpt facility runs.
 * Months are Jan→Dec (index 0 = Jan).
 */
export const SEASONALITY_PROFILES = {
  uniform:        [8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.37],
  holiday:        [5.0,  5.0,  5.5,  6.0,  6.5,  7.0,  7.5,  8.5,  9.5, 12.0, 14.0, 13.5],
  spring:         [5.5,  6.5,  9.0, 12.0, 14.0, 12.5, 10.0,  8.5,  7.5,  6.0,  4.5,  4.0],
  summer:         [4.5,  5.0,  6.0,  7.5,  9.5, 12.5, 13.5, 12.5, 10.0,  8.0,  6.0,  5.0],
  back_to_school: [5.0,  5.0,  5.5,  6.0,  6.5,  8.0, 11.5, 14.5, 11.5,  9.0,  9.0,  8.5],
};

/** Profile keys exposed to the UI seasonality selector (custom is added inline). */
export const SEASONALITY_PROFILE_KEYS = Object.keys(SEASONALITY_PROFILES);

/** Resolve a seasonality profile key (or 'custom') to a 12-element monthly share array. */
export function monthlySharesForProfile(profile, customShare) {
  if (profile === 'custom' && Array.isArray(customShare) && customShare.length === 12) return customShare;
  return SEASONALITY_PROFILES[profile] || SEASONALITY_PROFILES.uniform;
}

/**
 * Return the share-of-annual-demand (in %) for ONE month of a seasonality profile.
 * monthIdx is clamped to 0..11 (Jan..Dec).
 */
export function monthlyShareAtIdx(profile, monthIdx, customShare) {
  const arr = monthlySharesForProfile(profile, customShare);
  const i = Math.min(11, Math.max(0, Math.round(Number(monthIdx) || 0)));
  return arr[i];
}

/**
 * Legacy alias — returns the 12-element ARRAY for a profile. Despite the
 * singular name, this does NOT take a monthIdx; passing a number as the 2nd
 * arg is silently ignored. Use `monthlyShareAtIdx` for single-month lookup,
 * or `monthlySharesForProfile` for the explicit array contract.
 * @deprecated 2026-04-26 — name was confusing; kept as alias for compat.
 */
export function monthlyShareForProfile(profile, customShare) {
  return monthlySharesForProfile(profile, customShare);
}

/**
 * Frequency bucket → average shipments per week. Drives the LTL↔TL break-even
 * (low frequency favors LTL even at higher per-mile rates because cubic utilization is poor).
 */
export const FREQUENCY_PER_WEEK = {
  daily:    5.0,
  weekly:   1.0,
  biweekly: 0.5,
  monthly:  0.23,   // ~1/4.33
  irregular: 0.1,
};

export const FREQUENCY_OPTIONS = ['daily', 'weekly', 'biweekly', 'monthly', 'irregular'];

/** Resolve a frequency label/explicit weekly count → numeric shipments per week. */
export function freqPerWeekForBucket(frequency, explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return FREQUENCY_PER_WEEK[frequency] ?? 1.0;
}

/** UN hazmat classes 1-9 — surfaced in the demand-point table when hazmat=true. */
export const HAZMAT_CLASSES = [
  '1.1 Explosives',
  '1.4 Explosives (low hazard)',
  '2.1 Flammable Gas',
  '2.2 Non-Flammable Gas',
  '2.3 Toxic Gas',
  '3 Flammable Liquid',
  '4.1 Flammable Solid',
  '4.2 Spontaneously Combustible',
  '4.3 Dangerous When Wet',
  '5.1 Oxidizer',
  '5.2 Organic Peroxide',
  '6.1 Toxic',
  '6.2 Infectious',
  '7 Radioactive',
  '8 Corrosive',
  '9 Misc.',
];

/** Look up an NMFC multiplier; falls back to 1.0 (class 100) when unrecognised. */
export function nmfcMultiplier(classCode) {
  if (classCode == null || classCode === '') return 1.0;
  const exact = NMFC_CLASS_MULTIPLIERS[classCode];
  if (exact != null) return exact;
  // Round to nearest valid class
  const codes = NMFC_CLASS_CODES;
  const closest = codes.reduce((acc, c) => Math.abs(c - classCode) < Math.abs(acc - classCode) ? c : acc, codes[0]);
  return NMFC_CLASS_MULTIPLIERS[closest] || 1.0;
}

/**
 * Regional LTL rate multipliers by census region pair.
 * - Same region              → 0.95 (intra-region density discount)
 * - Adjacent region          → 1.00 (baseline)
 * - Cross-country (W↔E)      → 1.18 (long-haul interline premium)
 * Regions: 'NE', 'SE', 'MW', 'SW', 'W' (5 census super-regions).
 */
export const LTL_REGION_MULTIPLIERS = {
  same: 0.95,
  adjacent: 1.00,
  cross: 1.18,
};

/** Region codes in canonical UI / matrix order. */
export const REGION_CODES = ['NE', 'SE', 'MW', 'SW', 'W'];

/**
 * Default 5x5 region-pair multiplier matrix. Symmetric by design but stored
 * as a full grid so users can override individual lanes (e.g., NE→W premium
 * vs W→NE backhaul). Indexed by [origin][dest] using REGION_CODES order.
 *
 * Default values derived from the same/adjacent/cross buckets above and
 * REGION_ADJACENCY (NE-SE-MW-SW-W chain). Editable per-cell in the rate-card UI.
 */
export const DEFAULT_LTL_REGION_MATRIX = {
  NE: { NE: 0.95, SE: 1.00, MW: 1.00, SW: 1.18, W: 1.18 },
  SE: { NE: 1.00, SE: 0.95, MW: 1.00, SW: 1.00, W: 1.18 },
  MW: { NE: 1.00, SE: 1.00, MW: 0.95, SW: 1.00, W: 1.00 },
  SW: { NE: 1.18, SE: 1.00, MW: 1.00, SW: 0.95, W: 1.00 },
  W:  { NE: 1.18, SE: 1.18, MW: 1.00, SW: 1.00, W: 0.95 },
};

const REGION_ADJACENCY = {
  NE: ['NE', 'SE', 'MW'],
  SE: ['SE', 'NE', 'MW', 'SW'],
  MW: ['MW', 'NE', 'SE', 'SW', 'W'],
  SW: ['SW', 'SE', 'MW', 'W'],
  W:  ['W', 'MW', 'SW'],
};

/**
 * Census super-region from longitude/latitude. Coarse but useful for
 * LTL rate stratification when explicit region tags aren't provided.
 * @param {number} lat
 * @param {number} lng
 * @returns {'NE'|'SE'|'MW'|'SW'|'W'}
 */
export function regionForCoord(lat, lng) {
  if (lng <= -115) return 'W';
  if (lng <= -100) return lat >= 36 ? 'MW' : 'SW';
  if (lng <= -85) return lat >= 38 ? 'MW' : 'SE';
  // East of -85: split on lat for NE vs SE
  return lat >= 38 ? 'NE' : 'SE';
}

/**
 * Multiplier for an LTL lane between two regions.
 * @param {string} originRegion
 * @param {string} destRegion
 * @param {Object<string,Object<string,number>>} [matrix] — optional 5x5 override
 */
export function regionPairMultiplier(originRegion, destRegion, matrix) {
  if (!originRegion || !destRegion) return LTL_REGION_MULTIPLIERS.adjacent;
  if (matrix && matrix[originRegion] && Number.isFinite(matrix[originRegion][destRegion])) {
    return matrix[originRegion][destRegion];
  }
  if (originRegion === destRegion) return LTL_REGION_MULTIPLIERS.same;
  const adj = REGION_ADJACENCY[originRegion] || [];
  return adj.includes(destRegion) ? LTL_REGION_MULTIPLIERS.adjacent : LTL_REGION_MULTIPLIERS.cross;
}

/**
 * Derive the full 18-class × 6-weight-break tariff matrix from the class-100
 * baseline row + NMFC class multipliers. Returns an object keyed by class code,
 * each value an array of $/CWT rates aligned to ltlWeightBreaks.
 *
 * @param {number[]} baseRow — class-100 $/CWT rates aligned to ltlWeightBreaks
 * @param {Object<number,number>} [multipliers] — defaults to NMFC_CLASS_MULTIPLIERS
 * @returns {Object<string,number[]>}
 */
export function deriveClassWeightMatrix(baseRow, multipliers = NMFC_CLASS_MULTIPLIERS, overrides = null) {
  const out = {};
  for (const code of NMFC_CLASS_CODES) {
    const mult = multipliers[code] ?? 1.0;
    out[code] = baseRow.map((r, i) => {
      const ov = overrides && overrides[`${code}-${i}`];
      if (Number.isFinite(ov) && ov >= 0) return +(+ov).toFixed(2);
      return +(r * mult).toFixed(2);
    });
  }
  return out;
}

// ============================================================
// DISTANCE & TRANSIT
// ============================================================

/**
 * Haversine distance between two lat/lng points.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in miles
 */
export function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Estimate transit days from distance and truck speed.
 *
 * NET-B5 (2026-04-26) — previously rounded `driving_hours / 11` which
 * assumed pure driving with no load/unload/dwell/rest interruptions.
 * Real-world FTL transit always includes:
 *   • Load time at origin     ~2 hrs
 *   • Unload time at dest     ~2 hrs
 *   • Mandatory 30-min rest after 8 hrs driving (HOS §395.3(a)(3)(ii))
 *   • Optional intermediate dwell at stops  (set per-lane)
 * The HOS day is also bounded by the 14-hour on-duty window, not just
 * 11 driving hrs — so total wall-clock per day is 14, not 11.
 *
 * @param {number} miles
 * @param {number} [speedMph=50]
 * @param {object} [opts]
 * @param {number} [opts.drivingHoursPerDay=11] — HOS §395.3(a)(3)(i)
 * @param {number} [opts.onDutyHoursPerDay=14]  — HOS §395.3(a)(2) wall-clock window
 * @param {number} [opts.loadHours=2]
 * @param {number} [opts.unloadHours=2]
 * @param {number} [opts.dwellHoursPerStop=0]   — extra dwell at intermediate stops
 * @param {number} [opts.intermediateStops=0]
 * @returns {number} transit days (rounded up to whole days)
 */
export function estimateTransitDays(miles, speedMphOrOpts = 50, opts = {}) {
  if (!Number.isFinite(miles) || miles <= 0) return 0;

  // Polymorphic 2nd arg: accept either a numeric speedMph (legacy) or an
  // opts object (new, intuitive). Also defends against null/undefined and
  // non-numeric speedMph values that previously yielded NaN transit days.
  let speedMph;
  if (speedMphOrOpts && typeof speedMphOrOpts === 'object' && !Array.isArray(speedMphOrOpts)) {
    // (miles, opts)
    opts = speedMphOrOpts;
    speedMph = 50;
  } else {
    const n = Number(speedMphOrOpts);
    speedMph = (Number.isFinite(n) && n > 0) ? n : 50;
  }

  // Backwards-compat: old signature was (miles, speedMph, hoursPerDay).
  // If a number was passed where opts goes, treat it as drivingHoursPerDay.
  if (typeof opts === 'number') opts = { drivingHoursPerDay: opts };
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) opts = {};

  const drivingPerDay = Math.max(1, Number(opts.drivingHoursPerDay) || 11);
  const onDutyPerDay  = Math.max(drivingPerDay, Number(opts.onDutyHoursPerDay) || 14);
  const loadHrs       = opts.loadHours == null ? 2 : Math.max(0, Number(opts.loadHours) || 0);
  const unloadHrs     = opts.unloadHours == null ? 2 : Math.max(0, Number(opts.unloadHours) || 0);
  const dwellPerStop  = Math.max(0, Number(opts.dwellHoursPerStop) || 0);
  const stops         = Math.max(0, Number(opts.intermediateStops) || 0);

  const drivingHours = miles / speedMph;
  // 30-min mandatory rest break after every 8 cumulative driving hours.
  const restBreakHours = 0.5 * Math.floor(drivingHours / 8);
  const wallClockHours = drivingHours + restBreakHours + loadHrs + unloadHrs + (dwellPerStop * stops);

  // Multi-day: each day caps at on-duty wall clock (14 hrs).
  // (drivingPerDay is the floor for onDutyPerDay above, ensuring on-duty
  // can't drop below the driving limit.)
  return Math.ceil(wallClockHours / onDutyPerDay);
}

/**
 * Determine parcel zone from distance (simplified USPS zone model).
 * @param {number} miles
 * @returns {number} zone 2-8
 */
export function parcelZone(miles) {
  if (miles <= 50) return 2;
  if (miles <= 150) return 3;
  if (miles <= 300) return 4;
  if (miles <= 600) return 5;
  if (miles <= 1000) return 6;
  if (miles <= 1400) return 7;
  return 8;
}

// ============================================================
// TRANSPORTATION COSTING
// ============================================================

/**
 * NET-C1 — Resolve effective rate card for a specific OD pair by overlaying
 * any matching lane-override entries on top of the base rate card. First
 * matching `laneRates` row wins (so put the most-specific entries first).
 * A row matches when ALL of its present keys equal the supplied values:
 *   - originId / destId       — exact id match (or '*' wildcard, or null=any)
 *   - originRegion / destRegion — region-code match
 *
 * @param {object} rateCard
 * @param {object} ctx — {originId?, destId?, originRegion?, destRegion?}
 * @returns {object} merged rate card with overrides applied
 */
export function resolveLaneRates(rateCard, ctx = {}) {
  if (!rateCard || !Array.isArray(rateCard.laneRates) || rateCard.laneRates.length === 0) {
    return rateCard || {};
  }
  const wild = v => v === '*' || v == null;
  const match = (a, b) => wild(a) || wild(b) || a === b;
  const lane = rateCard.laneRates.find(r =>
    match(r.originId, ctx.originId) &&
    match(r.destId, ctx.destId) &&
    match(r.originRegion, ctx.originRegion) &&
    match(r.destRegion, ctx.destRegion)
  );
  if (!lane) return rateCard;
  // Strip the matcher fields so they don't leak into downstream rate
  // consumers; keep only the actual rate-override fields.
  const { originId: _a, destId: _b, originRegion: _c, destRegion: _d, ...overrides } = lane;
  return { ...rateCard, ...overrides, _laneOverrideApplied: true, _laneOverrideKey: `${ctx.originId || '*'}→${ctx.destId || '*'}` };
}

/**
 * Compute TL (truckload) cost for a lane.
 * @param {number} miles
 * @param {number} [ratePerMile]
 * @param {number} [fuelSurcharge]
 * @param {number} [originLng] — for regional imbalance surcharge (East >-95 vs West <-95)
 * @param {number} [destLng]
 * @returns {number}
 */
export function tlCost(miles, ratePerMile = DEFAULT_RATES.tlRatePerMile, fuelSurcharge = DEFAULT_RATES.fuelSurcharge, originLng, destLng) {
  let baseCost = miles * ratePerMile * (1 + fuelSurcharge);

  // Regional imbalance surcharge: East->West gets 20% premium; West->East gets 5% discount
  if (originLng !== undefined && destLng !== undefined) {
    const originIsEast = originLng > -95;
    const destIsEast = destLng > -95;

    if (originIsEast && !destIsEast) {
      // East to West: 20% surcharge
      baseCost *= 1.20;
    } else if (!originIsEast && destIsEast) {
      // West to East: 5% discount
      baseCost *= 0.95;
    }
  }

  return baseCost;
}

/**
 * Compute LTL cost for a shipment.
 *
 * Supports NMFC freight class (multiplier vs class 100) and regional
 * multipliers (same/adjacent/cross-region). When origin+dest
 * region codes aren't provided, the regional layer is a no-op.
 *
 * @param {number} weight — lbs
 * @param {number} miles — for minimum charge calculation
 * @param {Object} [rates]
 * @param {number[]} [rates.weightBreaks]
 * @param {number[]} [rates.breakRates] — $/CWT at each break
 * @param {number} [rates.fuelSurcharge]
 * @param {number} [rates.nmfcClass] — freight class (50–500); default 100
 * @param {string} [rates.originRegion] — 'NE'|'SE'|'MW'|'SW'|'W'
 * @param {string} [rates.destRegion]
 * @returns {number}
 */
export function ltlCost(weight, miles, rates = {}) {
  const breaks = rates.ltlWeightBreaks || rates.weightBreaks || DEFAULT_RATES.ltlWeightBreaks;
  const bRates = rates.ltlBreakRates || rates.breakRates || DEFAULT_RATES.ltlBreakRates;
  const fsc = rates.fuelSurcharge ?? DEFAULT_RATES.fuelSurcharge;
  const discountPct = Number.isFinite(rates.ltlDiscountPct) ? rates.ltlDiscountPct : DEFAULT_RATES.ltlDiscountPct;
  const minCharge = Number.isFinite(rates.ltlMinCharge) ? rates.ltlMinCharge : DEFAULT_RATES.ltlMinCharge;

  // Find applicable CWT rate from weight breaks
  let breakIdx = 0;
  let ratePerCwt = bRates[0] || 18.50;
  for (let i = 0; i < breaks.length; i++) {
    if (weight >= breaks[i]) { ratePerCwt = bRates[i]; breakIdx = i; }
  }

  const cwt = Math.max(1, weight) / 100;
  const classCode = Number.isFinite(rates.nmfcClass) ? rates.nmfcClass : 100;
  let base;
  // Per-cell override: if user overrode the (class, weight-break) cell, use it
  // directly and SKIP the class multiplier (override is the final per-CWT rate).
  const ov = rates.ltlClassMatrixOverrides && rates.ltlClassMatrixOverrides[`${classCode}-${breakIdx}`];
  if (Number.isFinite(ov) && ov >= 0) {
    base = cwt * (+ov);
  } else {
    base = cwt * ratePerCwt;
    // NMFC freight-class multiplier (B2)
    base *= nmfcMultiplier(rates.nmfcClass);
  }

  // Distance adjustment (longer = higher, simplified)
  const distFactor = miles > 500 ? 1.15 : miles > 250 ? 1.08 : 1.0;

  // Regional LTL multiplier (B3) — consults editable 5x5 matrix if provided.
  const regionMult = regionPairMultiplier(rates.originRegion, rates.destRegion, rates.ltlRegionMatrix);

  // Tariff cost before discount / FSC
  let charge = base * distFactor * regionMult;

  // Apply discount off published tariff (industry typical 30-70%)
  charge *= (1 - Math.max(0, Math.min(95, discountPct)) / 100);

  // Apply fuel surcharge (carrier-driven, indexed weekly off DOE diesel)
  charge *= (1 + fsc);

  // Enforce minimum charge floor
  return Math.max(minCharge, charge);
}

/**
 * Compute parcel cost for a shipment, using dimensional weight.
 * Billable weight = max(actual weight, dimensionalWeight).
 * Since L×W×H not provided, we estimate from avgWeight using density heuristic:
 * cube ft ≈ weight / 10, so dim weight = cube ft × 166 = weight / 10 × 166 = weight × 16.6
 * (This assumes 10 lbs per cubic foot; FedEx/UPS use 166 as the divisor)
 *
 * @param {number} weight — lbs (actual weight)
 * @param {number} miles — to determine zone
 * @param {number[][]} [zoneRates] — zone × weight bracket rates
 * @param {number} [fuelSurcharge]
 * @returns {number}
 */
export function parcelCost(weight, miles, zoneRates = DEFAULT_RATES.parcelZoneRates, fuelSurcharge = DEFAULT_RATES.fuelSurcharge) {
  // Estimate dimensional weight using density heuristic
  // Assume 1 cubic foot per 10 lbs; dim weight = (weight/10) × 166 ≈ weight × 16.6
  const estimatedDimWeight = weight * 16.6 / 166; // Simplifies to weight / 10, then × 166 = weight (worst case)
  // Conservative: assume one dimension is small, so dim weight is moderate
  const billableWeight = Math.max(weight, weight * 1.2); // Roughly 20% uplift for buoyant items

  const zone = parcelZone(miles);
  const zoneIdx = Math.max(0, Math.min(zone - 2, zoneRates.length - 1));
  const brackets = PARCEL_WEIGHT_BRACKETS;

  // Find weight bracket based on billable weight
  let bracketIdx = 0;
  for (let i = 0; i < brackets.length; i++) {
    if (billableWeight >= brackets[i]) bracketIdx = i;
  }

  const base = zoneRates[zoneIdx]?.[bracketIdx] || 15;
  return base * (1 + fuelSurcharge);
}

/**
 * Compute blended transportation cost based on mode mix.
 * @param {number} miles
 * @param {number} avgWeight — lbs per shipment
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @param {number} [originLng] — for regional TL surcharge
 * @param {number} [destLng]
 * @returns {{ tlCost: number, ltlCost: number, parcelCost: number, blendedCost: number }}
 */
export function blendedLaneCost(miles, avgWeight, modeMix, rateCard = DEFAULT_RATES, originLng, destLng, originLat, destLat, nmfcClass, ctx) {
  // NET-C1 — apply per-lane overrides if a matching row exists. ctx is
  // optional + shapes to { originId, destId } from the caller. When omitted
  // the rate card flows through unchanged (backwards compat).
  if (ctx && rateCard && Array.isArray(rateCard.laneRates) && rateCard.laneRates.length) {
    rateCard = resolveLaneRates(rateCard, ctx);
  }
  // E4/E5 fix (2026-04-25 EVE): same-facility / same-ZIP lanes have no transport cost.
  // Previously LTL & Parcel still produced their minimum-bracket charge against a 0-mile lane,
  // which surfaced as $6 LTL / $25 Parcel / $11 blended on Lane Assignments — dimensionally wrong.
  if (!isFinite(miles) || miles <= 0) {
    return { tlCost: 0, ltlCost: 0, parcelCost: 0, blendedCost: 0 };
  }
  const tl = tlCost(miles, rateCard.tlRatePerMile, rateCard.fuelSurcharge, originLng, destLng);

  // Derive regions from coords if not already on rateCard
  const originRegion = rateCard.originRegion
    || (originLat != null && originLng != null ? regionForCoord(originLat, originLng) : undefined);
  const destRegion = rateCard.destRegion
    || (destLat != null && destLng != null ? regionForCoord(destLat, destLng) : undefined);

  const ltl = ltlCost(avgWeight, miles, {
    ...rateCard,
    nmfcClass: nmfcClass ?? rateCard.nmfcClass,
    originRegion,
    destRegion,
  });

  const pcl = parcelCost(avgWeight, miles, rateCard.parcelZoneRates, rateCard.fuelSurcharge);

  const tlPct = (modeMix.tlPct || 0) / 100;
  const ltlPct = (modeMix.ltlPct || 0) / 100;
  const parcelPct = (modeMix.parcelPct || 0) / 100;

  const blended = tl * tlPct + ltl * ltlPct + pcl * parcelPct;

  return { tlCost: tl, ltlCost: ltl, parcelCost: pcl, blendedCost: blended };
}

// ============================================================
// DEMAND ASSIGNMENT (GREEDY NEAREST-FACILITY)
// ============================================================

/**
 * Assign each demand point to nearest open facility.
 *
 * Phase 4 of volumes-as-nucleus (2026-04-29): when `opts.channelMixMap` is
 * provided, per-demand mode resolution looks up the demand's channelKey in
 * the map and uses that channel's modeMix. Falls back to the project-level
 * `modeMix` argument when the channel isn't mapped or the demand has no
 * channelKey. Backwards-compat: callers that don't pass opts behave exactly
 * as before.
 *
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @param {import('./types.js?v=20260418-sM').ServiceConfig} [serviceConfig]
 * @param {Object} [opts]
 * @param {Object<string, import('./types.js?v=20260418-sM').ModeMix>} [opts.channelMixMap]
 *   Map from demand.channelKey -> modeMix override. Demands without a matching
 *   key fall back to the project modeMix.
 * @returns {import('./types.js?v=20260418-sM').LaneCost[]}
 */
export function assignDemand(facilities, demands, modeMix, rateCard = DEFAULT_RATES, serviceConfig = DEFAULT_SERVICE, opts = {}) {
  // Hard-constraint enforcement: lockedClosed wins over isOpen + lockedOpen.
  const lockedClosed = new Set(serviceConfig.lockedClosedIds || []);
  const lockedOpen = new Set(serviceConfig.lockedOpenIds || []);
  // Open facilities must also have FINITE lat/lng — a NaN-coord facility
  // would corrupt the haversine sort (NaN comparisons are unstable, so the
  // bad facility can end up "best" and propagate NaN distance + $0 transport
  // through the rest of the pipeline). Bug-fix 2026-04-25: filter those out
  // here rather than masking later. validateScenarioInputs() surfaces them
  // to the user up-front; this is the defensive belt-and-suspenders pass.
  const openFacilities = facilities.filter(f =>
    !lockedClosed.has(f.id) &&
    (lockedOpen.has(f.id) || f.isOpen !== false) &&
    Number.isFinite(Number(f.lat)) && Number.isFinite(Number(f.lng))
  );
  // Demands likewise must have finite lat/lng — without coords there's no
  // distance to compute and the assignment is meaningless.
  const validDemands = demands.filter(d =>
    Number.isFinite(Number(d.lat)) && Number.isFinite(Number(d.lng))
  );
  if (openFacilities.length === 0 || validDemands.length === 0) return [];

  const maxDist = serviceConfig.maxDistanceMiles;

  /** @type {Map<string, number>} */
  const facilityLoad = new Map();
  openFacilities.forEach(f => facilityLoad.set(f.id, 0));

  return validDemands.map(d => {
    const dLat = Number(d.lat);
    const dLng = Number(d.lng);
    const dDemand = Number(d.annualDemand) || 0;
    // Sort facilities by distance, penalising SLA violators / capacity over.
    // Hard distance constraint short-circuits to a separate bucket.
    const ranked = openFacilities.map(f => {
      const fLat = Number(f.lat);
      const fLng = Number(f.lng);
      const dist = haversine(fLat, fLng, dLat, dLng);
      // NET-B5 — forward the full serviceConfig so estimateTransitDays can
      // pick up driving/on-duty/load/unload/dwell/stops opts. Backwards-compat
      // safe: a stale config without those keys falls through to defaults.
      const transit = estimateTransitDays(dist, serviceConfig.truckSpeedMph, serviceConfig);
      const maxDays = d.maxDays || serviceConfig.globalMaxDays;
      const slaPenalty = transit > maxDays ? 1e6 : 0;
      const fCap = Number(f.capacity) || 0;
      const capacityPenalty = fCap && (facilityLoad.get(f.id) || 0) >= fCap ? 1e8 : 0;
      // Hard distance constraint: penalise so we still pick the closest if no facility qualifies
      const distancePenalty = (maxDist != null && dist > maxDist) ? 1e7 : 0;
      // Defensive: if dist is somehow NaN despite the input filter, push it
      // to the bottom of the ranking instead of letting it sort unstably.
      const safeDist = Number.isFinite(dist) ? dist : 1e9;
      return { facility: f, dist: safeDist, transit, penalty: safeDist + slaPenalty + capacityPenalty + distancePenalty };
    }).sort((a, b) => a.penalty - b.penalty);

    const best = ranked[0];
    // NET-C1 — pass OD context so resolveLaneRates can apply matching overrides.
    const fLatN = Number(best.facility.lat), fLngN = Number(best.facility.lng);
    const laneCtx = {
      originId: best.facility.id,
      destId:   d.id,
      originRegion: regionForCoord(fLatN, fLngN),
      destRegion:   regionForCoord(dLat, dLng),
    };
    // Phase 4 — resolve effective modeMix from channel override map when present.
    const channelMixMap = opts.channelMixMap || null;
    const effectiveMix = (channelMixMap && d.channelKey && channelMixMap[d.channelKey])
      ? channelMixMap[d.channelKey]
      : modeMix;
    const costs = blendedLaneCost(
      best.dist,
      d.avgWeight || 25,
      effectiveMix,
      rateCard,
      fLngN,
      dLng,
      fLatN,
      dLat,
      d.nmfcClass,
      laneCtx
    );
    const maxDays = d.maxDays || serviceConfig.globalMaxDays;

    // Track facility load
    facilityLoad.set(best.facility.id, (facilityLoad.get(best.facility.id) || 0) + dDemand);

    return {
      facilityId: best.facility.id,
      demandId: d.id,
      distanceMiles: best.dist,
      transitDays: best.transit,
      ...costs,
      meetsSlA: best.transit <= maxDays,
      withinMaxDistance: maxDist == null || best.dist <= maxDist,
    };
  });
}

// ============================================================
// SCENARIO ANALYSIS
// ============================================================

/**
 * Evaluate a network scenario.
 * @param {string} name
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @param {import('./types.js?v=20260418-sM').ServiceConfig} [serviceConfig]
 * @returns {import('./types.js?v=20260418-sM').ScenarioResult}
 */
export function evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig, opts = {}) {
  // Phase 4 — pass channelMixMap (if any) through to assignDemand.
  const assignments = assignDemand(facilities, demands, modeMix, rateCard, serviceConfig, opts);

  // 2026-04-25 hardening: coerce every numeric field to Number to handle
  // form-input strings ("85000") + saved-config edge cases. The prior
  // `(d.annualDemand || 0)` returned the original string in arithmetic
  // (which JS coerces correctly *most* of the time), but produced 0 when
  // the field was an empty string. Same pattern fixed for variableCost,
  // fixedCost, blendedCost, and distanceMiles.
  const totalTransport = assignments.reduce((s, a) => {
    const blended = Number(a.blendedCost) || 0;
    const dem = demands.find(d => d.id === a.demandId);
    const annual = Number(dem?.annualDemand) || 0;
    return s + blended * (annual / 52);
  }, 0);
  const totalFacility = facilities.filter(f => f.isOpen !== false).reduce((s, f) => s + (Number(f.fixedCost) || 0), 0);
  const totalHandling = demands.reduce((s, d) => {
    const asg = assignments.find(a => a.demandId === d.id);
    const fac = asg ? facilities.find(f => f.id === asg.facilityId) : null;
    const annual = Number(d.annualDemand) || 0;
    const vc = Number(fac?.variableCost) || 0;
    return s + annual * vc;
  }, 0);

  const totalDemand = demands.reduce((s, d) => s + (Number(d.annualDemand) || 0), 0);
  const totalCost = totalFacility + totalTransport + totalHandling;
  // Avg distance: average of finite distances only — guards against a single
  // bad assignment poisoning the average to NaN.
  const finiteDists = assignments.map(a => Number(a.distanceMiles)).filter(x => Number.isFinite(x));
  const avgDist = finiteDists.length > 0
    ? finiteDists.reduce((s, x) => s + x, 0) / finiteDists.length
    : 0;
  const slaMet = assignments.filter(a => a.meetsSlA).length;

  return {
    name,
    totalCost,
    totalDemand,
    avgCostPerUnit: totalDemand > 0 ? totalCost / totalDemand : 0,
    avgDistance: avgDist,
    slaMet,
    slaTotal: assignments.length,
    serviceLevel: assignments.length > 0 ? (slaMet / assignments.length) * 100 : 0,
    assignments,
    costBreakdown: { facility: totalFacility, transport: totalTransport, handling: totalHandling },
  };
}

/**
 * Compare multiple scenarios.
 * @param {import('./types.js?v=20260418-sM').ScenarioResult[]} scenarios
 * @returns {Array<import('./types.js?v=20260418-sM').ScenarioResult & { verdict: string, deltaPct: number }>}
 */
export function compareScenarios(scenarios) {
  if (!scenarios.length) return [];

  const bestCost = Math.min(...scenarios.map(s => s.totalCost));
  const bestService = Math.max(...scenarios.map(s => s.serviceLevel));

  return scenarios.map(s => {
    const deltaPct = bestCost > 0 ? ((s.totalCost - bestCost) / bestCost) * 100 : 0;
    let verdict = 'VIABLE';
    if (s.totalCost === bestCost) verdict = 'BEST COST';
    if (s.serviceLevel === bestService && s.serviceLevel > 0) verdict = verdict === 'BEST COST' ? 'OPTIMAL' : 'BEST SERVICE';
    if (s.serviceLevel < 90) verdict = 'SERVICE RISK';

    return { ...s, verdict, deltaPct };
  });
}

// ============================================================
// DEMO DATA GENERATOR
// ============================================================

/** Business archetype demand patterns */
const ARCHETYPES = {
  'dtc-ecom-east': { name: 'DTC E-Commerce', modeMix: { tlPct: 5, ltlPct: 15, parcelPct: 80 }, maxDays: 2, baseVolume: 50000 },
  'cpg-nationwide': { name: 'CPG Big Box Nationwide', modeMix: { tlPct: 60, ltlPct: 30, parcelPct: 10 }, maxDays: 5, baseVolume: 200000 },
  'industrial-mro': { name: 'Industrial / MRO', modeMix: { tlPct: 40, ltlPct: 50, parcelPct: 10 }, maxDays: 5, baseVolume: 75000 },
  'food-bev': { name: 'Food & Beverage', modeMix: { tlPct: 70, ltlPct: 25, parcelPct: 5 }, maxDays: 2, baseVolume: 150000 },
  'healthcare': { name: 'Healthcare / Pharma', modeMix: { tlPct: 20, ltlPct: 40, parcelPct: 40 }, maxDays: 1, baseVolume: 30000 },
};

/**
 * Get available archetype names.
 * @returns {Array<{ key: string, name: string }>}
 */
export function listArchetypes() {
  return Object.entries(ARCHETYPES).map(([key, v]) => ({ key, name: v.name }));
}

/**
 * Get archetype details.
 * @param {string} key
 * @returns {typeof ARCHETYPES[keyof typeof ARCHETYPES] | null}
 */
export function getArchetype(key) {
  return ARCHETYPES[key] || null;
}

// ============================================================
// MULTI-DC COMPARISON & OPTIMIZATION
// ============================================================

/**
 * Generate all combinations of k items from array (for exhaustive enumeration).
 * @param {any[]} arr
 * @param {number} k
 * @returns {any[][]}
 */
function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const results = [];
  function combine(start, chosen) {
    if (chosen.length === k) {
      results.push(chosen.slice());
      return;
    }
    for (let i = start; i <= arr.length - (k - chosen.length); i++) {
      chosen.push(arr[i]);
      combine(i + 1, chosen);
      chosen.pop();
    }
  }
  combine(0, []);
  return results;
}

/**
 * Exhaustive enumeration: enumerate all combinations of candidate facility locations.
 * Finds the best solution by brute force. Not an LP/MIP optimum — combinatorial only.
 * Returns null if search space is too large (>10,000 combinations).
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @param {number} maxFacilities — max number of DCs to test
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @param {import('./types.js?v=20260418-sM').ServiceConfig} [serviceConfig]
 * @returns {{scenarios: import('./types.js?v=20260418-sM').ScenarioResult[], optimal: import('./types.js?v=20260418-sM').ScenarioResult|null} | null}
 */
export function exactSolver(facilities, demands, maxFacilities, modeMix, rateCard = DEFAULT_RATES, serviceConfig = DEFAULT_SERVICE, opts = {}) {
  const openCandidates = facilities.filter(f => f.isOpen !== false);
  if (openCandidates.length === 0) return null;

  // Check if search space is tractable
  // Rough estimate: sum of C(n, k) for k=1..min(maxFacilities, n)
  let totalCombos = 0;
  for (let k = 1; k <= Math.min(maxFacilities, openCandidates.length); k++) {
    totalCombos += binomialCoeff(openCandidates.length, k);
    if (totalCombos > 10000) return null; // Too large
  }

  const scenarios = [];
  let optimal = null;

  // Try all subsets from 1 to maxFacilities facilities
  for (let numFacs = 1; numFacs <= Math.min(maxFacilities, openCandidates.length); numFacs++) {
    const combos = getCombinations(openCandidates, numFacs);

    for (const combo of combos) {
      // Create a scenario with this combination of facilities open, others closed
      const facConfig = facilities.map(f =>
        combo.find(c => c.id === f.id) ? { ...f, isOpen: true } : { ...f, isOpen: false }
      );
      const result = evaluateScenario(`${numFacs} DC`, facConfig, demands, modeMix, rateCard, serviceConfig, opts);
      scenarios.push(result);

      if (!optimal || result.totalCost < optimal.totalCost) {
        optimal = result;
      }
    }
  }

  return { scenarios, optimal };
}

/**
 * Binomial coefficient C(n, k).
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
function binomialCoeff(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Compute weighted-geographic centroid of demand points.
 * Weights by annualDemand.
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @returns {{lat: number, lng: number} | null}
 */
function computeDemandCentroid(demands) {
  if (!demands.length) return null;
  const totalDemand = demands.reduce((s, d) => s + (d.annualDemand || 1), 0);
  if (totalDemand === 0) return null;

  const weightedLat = demands.reduce((s, d) => s + d.lat * (d.annualDemand || 1), 0) / totalDemand;
  const weightedLng = demands.reduce((s, d) => s + d.lng * (d.annualDemand || 1), 0) / totalDemand;
  return { lat: weightedLat, lng: weightedLng };
}

/**
 * Heuristic facility location: centroid-init + facility-swap improvement.
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @param {number} k — number of facilities to open
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @param {import('./types.js?v=20260418-sM').ServiceConfig} [serviceConfig]
 * @returns {string[]} — array of facility IDs
 */
function optimizeWithHeuristic(facilities, demands, k, modeMix, rateCard = DEFAULT_RATES, serviceConfig = DEFAULT_SERVICE) {
  if (demands.length === 0) {
    // Fallback: pick k cheapest facilities by fixed cost
    const sorted = [...facilities].sort((a, b) => (a.fixedCost || 0) - (b.fixedCost || 0));
    return sorted.slice(0, k).map(f => f.id);
  }

  const openFacs = facilities.filter(f => f.isOpen !== false);
  if (openFacs.length === 0) return [];
  if (k >= openFacs.length) return openFacs.map(f => f.id);

  // NET-A2 — when the candidate set is small enough, enumerate all C(n,k)
  // combinations exhaustively. Beats local search on tractable instances.
  const exhaustiveCombos = binomialCoeff(openFacs.length, k);
  if (exhaustiveCombos > 0 && exhaustiveCombos <= 1500) {
    let bestIds = openFacs.slice(0, k).map(f => f.id);
    let bestCost = Infinity;
    const combos = getCombinations(openFacs, k);
    for (const combo of combos) {
      const ids = new Set(combo.map(f => f.id));
      const facConfig = facilities.map(f => ({ ...f, isOpen: ids.has(f.id) }));
      const r = evaluateScenario('exhaustive', facConfig, demands, modeMix, rateCard, serviceConfig);
      if (r.totalCost < bestCost) {
        bestCost = r.totalCost;
        bestIds = combo.map(f => f.id);
      }
    }
    return bestIds;
  }

  // NET-A2 — multi-start local search for larger candidate sets.
  // Three distinct seed strategies feed swap-improvement; we keep the best.
  const centroid = computeDemandCentroid(demands);
  /** @type {Set<string>[]} */
  const seeds = [];

  // Seed 1: closest-to-demand-centroid (the classic init)
  if (centroid) {
    const byDistToCentroid = openFacs.map(f => ({
      id: f.id,
      score: haversine(f.lat, f.lng, centroid.lat, centroid.lng),
    })).sort((a, b) => a.score - b.score);
    seeds.push(new Set(byDistToCentroid.slice(0, k).map(s => s.id)));
  }

  // Seed 2: greedy-add by marginal cost reduction. Start empty; iteratively
  // add the candidate that most reduces total cost. This is the
  // standard greedy heuristic for facility location and tends to land in
  // a different basin than centroid-init.
  {
    const chosen = new Set();
    const remaining = openFacs.map(f => f.id);
    let bestSetCost = Infinity;
    for (let i = 0; i < k; i++) {
      let bestAddId = null;
      let bestAddCost = Infinity;
      for (const candId of remaining) {
        const test = new Set(chosen);
        test.add(candId);
        const facConfig = facilities.map(f => ({ ...f, isOpen: test.has(f.id) }));
        const r = evaluateScenario('greedy-add', facConfig, demands, modeMix, rateCard, serviceConfig);
        if (r.totalCost < bestAddCost) {
          bestAddCost = r.totalCost;
          bestAddId = candId;
        }
      }
      if (bestAddId == null) break;
      chosen.add(bestAddId);
      bestSetCost = bestAddCost;
      const idx = remaining.indexOf(bestAddId);
      if (idx >= 0) remaining.splice(idx, 1);
    }
    if (chosen.size === k) seeds.push(chosen);
  }

  // Seed 3: cheapest-by-fixed-cost (the historical fallback). Useful when
  // fixed costs dominate transport — keeps multi-start from converging to
  // a single basin.
  {
    const sorted = [...openFacs].sort((a, b) => (a.fixedCost || 0) - (b.fixedCost || 0));
    seeds.push(new Set(sorted.slice(0, k).map(f => f.id)));
  }

  // De-duplicate seeds (sets with identical members).
  const seenKeys = new Set();
  /** @type {Set<string>[]} */
  const dedupedSeeds = [];
  for (const seed of seeds) {
    const key = Array.from(seed).sort().join('|');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    dedupedSeeds.push(seed);
  }

  // Swap-improve every seed; keep the best result.
  let bestIds = null;
  let bestCost = Infinity;
  for (const seed of dedupedSeeds) {
    const improved = swapImprove(seed, facilities, openFacs, demands, modeMix, rateCard, serviceConfig);
    const facConfig = facilities.map(f => ({ ...f, isOpen: improved.has(f.id) }));
    const r = evaluateScenario('multi-start', facConfig, demands, modeMix, rateCard, serviceConfig);
    if (r.totalCost < bestCost) {
      bestCost = r.totalCost;
      bestIds = Array.from(improved);
    }
  }

  return bestIds || Array.from(dedupedSeeds[0] || new Set());
}

/**
 * NET-A2 — extracted swap-improvement local search. Iterates k * (n-k)
 * candidate swaps; first-improvement strategy with a 20-iter budget.
 * @param {Set<string>} seed
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').Facility[]} openFacs
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} rateCard
 * @param {import('./types.js?v=20260418-sM').ServiceConfig} serviceConfig
 * @returns {Set<string>}
 */
function swapImprove(seed, facilities, openFacs, demands, modeMix, rateCard, serviceConfig) {
  let openSet = new Set(seed);
  for (let iter = 0; iter < 20; iter++) {
    let improved = false;
    for (const openId of openSet) {
      for (const candidate of openFacs) {
        if (openSet.has(candidate.id)) continue;
        const testSet = new Set(openSet);
        testSet.delete(openId);
        testSet.add(candidate.id);
        const testFacs = facilities.map(f => ({ ...f, isOpen: testSet.has(f.id) }));
        const currentFacs = facilities.map(f => ({ ...f, isOpen: openSet.has(f.id) }));
        const testResult = evaluateScenario('test', testFacs, demands, modeMix, rateCard, serviceConfig);
        const currentResult = evaluateScenario('current', currentFacs, demands, modeMix, rateCard, serviceConfig);
        if (testResult.totalCost < currentResult.totalCost) {
          openSet = testSet;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return openSet;
}

/**
 * Run optimization for k=1 through maxDCs, return array of results.
 * Uses heuristic facility selection instead of greedy fixed-cost.
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @param {import('./types.js?v=20260418-sM').ServiceConfig} [serviceConfig]
 * @param {number} [maxDCs=5]
 * @returns {import('./types.js?v=20260418-sM').ScenarioResult[]}
 */
export function multiDCComparison(facilities, demands, modeMix, rateCard = DEFAULT_RATES, serviceConfig = DEFAULT_SERVICE, maxDCs = 5) {
  const results = [];
  const openFacs = facilities.filter(f => f.isOpen !== false);
  const maxK = Math.min(maxDCs, openFacs.length);

  for (let k = 1; k <= maxK; k++) {
    // Use heuristic facility selection with centroid init + swap improvement
    const selectedIds = optimizeWithHeuristic(facilities, demands, k, modeMix, rateCard, serviceConfig);
    const facConfig = facilities.map(f =>
      selectedIds.includes(f.id) ? { ...f, isOpen: true } : { ...f, isOpen: false }
    );
    const result = evaluateScenario(`${k} DC${k === 1 ? '' : 's'}`, facConfig, demands, modeMix, rateCard, serviceConfig);
    results.push(result);
  }

  return results;
}

/**
 * Recommend optimal DC count via the kneedle algorithm (Satopaa et al. 2011).
 *
 * Replaces the prior 8%-step-improvement scan, which would terminate as soon
 * as it found ANY step exceeding 8% — biasing toward the smallest k that
 * showed material savings rather than the true inflection. Kneedle fits the
 * "elbow" by finding the point furthest below the chord between the endpoint
 * scenarios on the cost-vs-k curve.
 *
 * Generalized to handle U-shapes: NetOpt's totalCost includes facility cost
 * (grows with k) + transport (shrinks with k) + handling, so the curve has
 * a real minimum, not just diminishing returns. For monotonic curves the
 * kneedle marks the elbow; for U-curves it marks the point closest to the
 * cost-optimal k (which is also the point furthest below the chord).
 *
 * Falls back to picking the absolute lowest-total-cost scenario when the
 * curve is too linear for a meaningful inflection (max chord-distance below
 * the MIN_KNEE_GAP threshold).
 *
 * @param {import('./types.js?v=20260418-sM').ScenarioResult[]} comparisonResults
 * @returns {{recommendedIdx: number, recommendation: string, savings: number, savingsPct: number}}
 */
export function recommendOptimalDCs(comparisonResults, serviceConfig) {
  if (!comparisonResults || comparisonResults.length === 0) {
    return { recommendedIdx: 0, recommendation: 'No scenarios available.', savings: 0, savingsPct: 0, slaConstrained: false };
  }
  if (comparisonResults.length === 1) {
    return { recommendedIdx: 0, recommendation: 'Only one scenario evaluated — add more facility candidates to compare k-DC alternatives.', savings: 0, savingsPct: 0, slaConstrained: false };
  }

  // 2026-04-27 — SLA-aware recommendation. Without this, the recommender
  // happily recommended 1 DC even when its service level was below target,
  // because adding DCs typically adds fixed cost faster than transport
  // savings reduce, so the cost-only optimum is k=1. The user expects
  // "optimal" = the cheapest network that ALSO meets the SLA target.
  const targetSLA = Number(serviceConfig?.targetServicePct);
  const haveTarget = Number.isFinite(targetSLA) && targetSLA > 0;
  const meetsSLA = (r) => !haveTarget || (Number(r.serviceLevel) >= targetSLA - 1e-6);

  // Filter to scenarios that meet the SLA target; if none qualify, fall back
  // to the full set with a warning narrative so the user sees a recommendation
  // either way (best-effort) rather than a dead-end empty card.
  const qualified = comparisonResults.filter(meetsSLA);
  const allFailSLA = haveTarget && qualified.length === 0;
  const candidates = allFailSLA ? comparisonResults : qualified;

  // Within the candidate set, pick the kneedle inflection if real; otherwise
  // pick the cheapest. Map back to comparisonResults indices.
  const ys = candidates.map(r => r.totalCost);
  const N = ys.length;
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = (yMax - yMin) || 1;

  let bestIdxInCandidates = 0;
  let usedKneedle = false;
  if (N >= 2) {
    const MIN_KNEE_GAP = 0.05;
    const yn = ys.map(y => (y - yMin) / yRange);
    const yStart = yn[0];
    const yEnd = yn[N - 1];
    let bestDist = -Infinity, bestIdx = 0;
    for (let i = 0; i < N; i++) {
      const xn = i / (N - 1);
      const chordY = yStart + xn * (yEnd - yStart);
      const dist = chordY - yn[i];
      if (dist > bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestDist > MIN_KNEE_GAP && bestIdx > 0 && bestIdx < N - 1) {
      bestIdxInCandidates = bestIdx;
      usedKneedle = true;
    } else {
      bestIdxInCandidates = ys.indexOf(yMin);
    }
  }
  const recScenario = candidates[bestIdxInCandidates];
  const recommendedIdx = comparisonResults.indexOf(recScenario);

  const baselineCost = comparisonResults[0].totalCost;
  const savings = baselineCost - recScenario.totalCost;
  const savingsPct = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;

  let narrative;
  const dcCount = recommendedIdx + 1;
  const lvl = (Number(recScenario.serviceLevel) || 0).toFixed(1);
  if (allFailSLA) {
    narrative = `No network in this comparison meets the ${targetSLA}% service-level target. Showing the best-effort option (${dcCount} DC${dcCount === 1 ? '' : 's'}, ${lvl}% service). Add more candidate facilities, raise capacity, or relax max transit days.`;
  } else if (haveTarget && qualified.length < comparisonResults.length) {
    const skippedCount = comparisonResults.length - qualified.length;
    if (usedKneedle) {
      narrative = `${dcCount} DC${dcCount === 1 ? '' : 's'} is the inflection point among networks meeting the ${targetSLA}% SLA target — the best balance of transport savings against added facility cost. (${skippedCount} smaller network${skippedCount === 1 ? '' : 's'} skipped because they fall short of the SLA.)`;
    } else {
      narrative = `${dcCount} DC${dcCount === 1 ? '' : 's'} is the cheapest network that meets the ${targetSLA}% SLA target. (${skippedCount} smaller network${skippedCount === 1 ? '' : 's'} skipped because they fall short of the SLA.)`;
    }
  } else if (recommendedIdx === 0) {
    narrative = 'Single DC is the lowest-cost scenario evaluated and meets the SLA target; adding facilities only adds net cost in this comparison.';
  } else if (recommendedIdx === comparisonResults.length - 1 && !usedKneedle) {
    narrative = `${dcCount} DCs is the cheapest evaluated, but the curve is still trending down — extend "Max DCs to test" to confirm the true minimum.`;
  } else if (usedKneedle) {
    narrative = `${dcCount} DCs is the inflection point on the cost-vs-DC-count curve — the best balance of transport savings against added facility cost.`;
  } else {
    narrative = `${dcCount} DCs is the lowest-cost scenario evaluated; the curve is near-linear so the elbow isn't sharp.`;
  }

  return {
    recommendedIdx,
    recommendation: narrative,
    savings,
    savingsPct,
    slaConstrained: haveTarget,
    slaTarget: haveTarget ? targetSLA : null,
    slaMet: meetsSLA(recScenario),
    slaSkipped: haveTarget ? (comparisonResults.length - qualified.length) : 0,
    allFailSLA,
  };
}

/**
 * Compute LTL cost with distance-based multiplier and CWT pricing.
 * @param {number} distance — miles
 * @param {number} weight — lbs
 * @param {string} freightClass — e.g., '85', '100', '125' (NMFC class)
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @returns {number}
 */
export function calcLTLCost(distance, weight, freightClass, rateCard = DEFAULT_RATES) {
  // Simplified: use base rate with distance factor and freight class adjustment
  const distanceFactor = distance > 500 ? 1.15 : distance > 250 ? 1.08 : 1.0;
  const classMultiplier = {
    '50': 0.75, '55': 0.85, '60': 0.95, '70': 1.05, '85': 1.15, '100': 1.30, '125': 1.50,
  }[freightClass] || 1.15;

  const cwt = Math.max(1, weight) / 100;
  const baseRate = rateCard.ltlBaseRate || 18.50;
  return cwt * baseRate * classMultiplier * distanceFactor * (1 + (rateCard.fuelSurcharge || 0.12));
}

/**
 * Compute parcel cost with zone-based rate card lookup and weight-tiered pricing.
 * @param {number} distance — miles
 * @param {number} weight — lbs
 * @param {string} carrier — e.g., 'ups', 'fedex', 'usps'
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @returns {number}
 */
export function calcParcelCost(distance, weight, carrier, rateCard = DEFAULT_RATES) {
  const zone = parcelZone(distance);
  const zoneIdx = Math.max(0, Math.min(zone - 2, rateCard.parcelZoneRates.length - 1));
  const brackets = PARCEL_WEIGHT_BRACKETS;

  // Find weight bracket
  let bracketIdx = 0;
  for (let i = 0; i < brackets.length; i++) {
    if (weight >= brackets[i]) bracketIdx = i;
  }

  // Carrier adjustment
  const carrierMult = { ups: 1.0, fedex: 1.05, usps: 0.95 }[carrier.toLowerCase()] || 1.0;
  const base = rateCard.parcelZoneRates[zoneIdx]?.[bracketIdx] || 15;
  return base * carrierMult * (1 + (rateCard.fuelSurcharge || 0.12));
}

// ============================================================
// FORMATTING
// ============================================================

/**
 * @param {number} val
 * @param {Object} [opts]
 * @param {boolean} [opts.compact]
 * @returns {string}
 */
export function formatCurrency(val, opts = {}) {
  if (opts.compact) {
    if (Math.abs(val) >= 1e6) return '$' + (val / 1e6).toFixed(1) + 'M';
    if (Math.abs(val) >= 1e3) return '$' + (val / 1e3).toFixed(0) + 'K';
  }
  return '$' + (val || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** @param {number} miles @returns {string} */
export function formatMiles(miles) {
  return Math.round(miles).toLocaleString() + ' mi';
}

/** @param {number} pct @returns {string} */
export function formatPct(pct) {
  return (pct || 0).toFixed(1) + '%';
}

// ============================================================
// FIND OPTIMAL LOCATIONS — weighted k-means on demand
// ============================================================
// Restores the v2 "Auto-Recommend Facilities" capability that was dropped
// in the v2→v3 port. Answers: given my demand, where SHOULD I put DCs?
// (vs the existing exactSolver which answers: given my facility candidates,
// which SUBSET should I open?).

/**
 * Compact US metro candidate table for facility recommendations. 30 top
 * logistics-relevant metros covering every major demand cluster. Keeps
 * NetOpt standalone — no cross-tool imports.
 * @type {Array<{ name:string, state:string, lat:number, lng:number }>}
 */
const CANDIDATE_METROS = [
  { name: 'New York',     state: 'NY', lat: 40.7128, lng: -74.0060 },
  { name: 'Los Angeles',  state: 'CA', lat: 34.0522, lng: -118.2437 },
  { name: 'Chicago',      state: 'IL', lat: 41.8781, lng: -87.6298 },
  { name: 'Houston',      state: 'TX', lat: 29.7604, lng: -95.3698 },
  { name: 'Dallas',       state: 'TX', lat: 32.7767, lng: -96.7970 },
  { name: 'Atlanta',      state: 'GA', lat: 33.7490, lng: -84.3880 },
  { name: 'Memphis',      state: 'TN', lat: 35.1495, lng: -90.0490 },
  { name: 'Louisville',   state: 'KY', lat: 38.2527, lng: -85.7585 },
  { name: 'Columbus',     state: 'OH', lat: 39.9612, lng: -82.9988 },
  { name: 'Indianapolis', state: 'IN', lat: 39.7684, lng: -86.1581 },
  { name: 'Kansas City',  state: 'MO', lat: 39.0997, lng: -94.5786 },
  { name: 'St. Louis',    state: 'MO', lat: 38.6270, lng: -90.1994 },
  { name: 'Denver',       state: 'CO', lat: 39.7392, lng: -104.9903 },
  { name: 'Phoenix',      state: 'AZ', lat: 33.4484, lng: -112.0740 },
  { name: 'Las Vegas',    state: 'NV', lat: 36.1699, lng: -115.1398 },
  { name: 'Salt Lake City', state: 'UT', lat: 40.7608, lng: -111.8910 },
  { name: 'Seattle',      state: 'WA', lat: 47.6062, lng: -122.3321 },
  { name: 'Portland',     state: 'OR', lat: 45.5152, lng: -122.6784 },
  { name: 'San Francisco',state: 'CA', lat: 37.7749, lng: -122.4194 },
  { name: 'Riverside',    state: 'CA', lat: 33.9806, lng: -117.3755 },
  { name: 'Miami',        state: 'FL', lat: 25.7617, lng: -80.1918 },
  { name: 'Orlando',      state: 'FL', lat: 28.5383, lng: -81.3792 },
  { name: 'Jacksonville', state: 'FL', lat: 30.3322, lng: -81.6557 },
  { name: 'Charlotte',    state: 'NC', lat: 35.2271, lng: -80.8431 },
  { name: 'Nashville',    state: 'TN', lat: 36.1627, lng: -86.7816 },
  { name: 'Philadelphia', state: 'PA', lat: 39.9526, lng: -75.1652 },
  { name: 'Boston',       state: 'MA', lat: 42.3601, lng: -71.0589 },
  { name: 'Harrisburg',   state: 'PA', lat: 40.2732, lng: -76.8867 },
  { name: 'Reno',         state: 'NV', lat: 39.5296, lng: -119.8138 },
  { name: 'Baltimore',    state: 'MD', lat: 39.2904, lng: -76.6122 },
  { name: 'Allentown',    state: 'PA', lat: 40.6084, lng: -75.4902 },
  { name: 'Edison',       state: 'NJ', lat: 40.5187, lng: -74.4121 },
  { name: 'Lehigh Valley',state: 'PA', lat: 40.6259, lng: -75.4686 },
  { name: 'Cincinnati',   state: 'OH', lat: 39.1031, lng: -84.5120 },
  { name: 'Detroit',      state: 'MI', lat: 42.3314, lng: -83.0458 },
  { name: 'Minneapolis',  state: 'MN', lat: 44.9778, lng: -93.2650 },
  { name: 'Tampa',        state: 'FL', lat: 27.9506, lng: -82.4572 },
  { name: 'San Antonio',  state: 'TX', lat: 29.4241, lng: -98.4936 },
  { name: 'Austin',       state: 'TX', lat: 30.2672, lng: -97.7431 },
  { name: 'Pittsburgh',   state: 'PA', lat: 40.4406, lng: -79.9959 },
  { name: 'Cleveland',    state: 'OH', lat: 41.4993, lng: -81.6944 },
];

/**
 * 2026-04-27 — Lookup map (city,state → {lat,lng}) for normalizing legacy
 * facility/demand rows that were saved without lat/lng. Built from
 * CANDIDATE_METROS at module load. Case-insensitive on city + state.
 */
const _CITY_LATLNG = (() => {
  const map = new Map();
  for (const m of CANDIDATE_METROS) {
    const key = `${m.name.toLowerCase()}|${(m.state || '').toLowerCase()}`;
    map.set(key, { lat: m.lat, lng: m.lng });
    // Also index by city alone (last write wins) so partial matches resolve
    map.set(m.name.toLowerCase(), { lat: m.lat, lng: m.lng });
  }
  return map;
})();

/**
 * Look up lat/lng by city + optional state. Returns null if not in the
 * candidate metro set. Case-insensitive.
 * @param {string} city
 * @param {string} [state]
 * @returns {{ lat:number, lng:number } | null}
 */
export function lookupCityLatLng(city, state) {
  if (!city) return null;
  const c = String(city).trim().toLowerCase();
  if (!c) return null;
  const s = String(state || '').trim().toLowerCase();
  return _CITY_LATLNG.get(`${c}|${s}`) || _CITY_LATLNG.get(c) || null;
}

/**
 * 2026-04-27 — Normalize a facility loaded from a saved scenario. Maps
 * legacy field names (active/perUnit/costPerUnit) to current schema
 * (isOpen/variableCost), and back-fills lat/lng by city/state lookup
 * when missing. Mutates the input. Returns the same object for chaining.
 *
 * Bug-fix context: NetOpt's saved-scenario JSON drift accumulated several
 * facility shapes over the project's life. Some users loaded scenarios
 * where facilities lacked lat/lng entirely (no input field on the table
 * to fix in-app), so Run Scenario errored "Facility X is missing valid
 * lat/lng coordinates" with no recourse short of re-creating the facility.
 *
 * @param {any} f
 * @returns {any}
 */
export function normalizeFacility(f) {
  if (!f || typeof f !== 'object') return f;
  // Field-name aliases
  if (f.isOpen === undefined) {
    if (typeof f.active === 'boolean') f.isOpen = f.active;
    else if (f.status === 'Active' || f.status === 'Open') f.isOpen = true;
    else if (f.status === 'Candidate' || f.status === 'Closed') f.isOpen = false;
    else f.isOpen = true;
  }
  if (f.variableCost === undefined) {
    if (Number.isFinite(Number(f.perUnit)))     f.variableCost = Number(f.perUnit);
    else if (Number.isFinite(Number(f.costPerUnit))) f.variableCost = Number(f.costPerUnit);
    else if (Number.isFinite(Number(f.varCost)))     f.variableCost = Number(f.varCost);
  }
  // Back-fill lat/lng by city/state when missing
  const latN = Number(f.lat), lngN = Number(f.lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    const hit = lookupCityLatLng(f.city, f.state);
    if (hit) {
      f.lat = hit.lat;
      f.lng = hit.lng;
    }
  }
  return f;
}

/**
 * 2026-04-27 — Demand counterpart of normalizeFacility. Maps legacy
 * `volume` → `annualDemand`, back-fills lat/lng by zip3 (no-op if not
 * resolvable; user can pick the row and re-add) or by city, and ensures
 * a numeric annualDemand exists.
 *
 * @param {any} d
 * @returns {any}
 */
export function normalizeDemand(d) {
  if (!d || typeof d !== 'object') return d;
  if (d.annualDemand === undefined) {
    if (Number.isFinite(Number(d.volume))) d.annualDemand = Number(d.volume);
    else if (Number.isFinite(Number(d.demand))) d.annualDemand = Number(d.demand);
  }
  // Treat the rare 'zip' alias as zip3
  if (!d.zip3 && d.zip) d.zip3 = d.zip;
  // Back-fill lat/lng from city if available (rare in demand rows but cheap)
  const latN = Number(d.lat), lngN = Number(d.lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    if (d.city) {
      const hit = lookupCityLatLng(d.city, d.state);
      if (hit) { d.lat = hit.lat; d.lng = hit.lng; }
    }
  }
  return d;
}


/**
 * Find the nearest candidate metro to a lat/lng point.
 * @param {number} lat
 * @param {number} lng
 * @returns {{ name:string, state:string, lat:number, lng:number, distanceMi:number }}
 */
function nearestMetro(lat, lng) {
  let best = CANDIDATE_METROS[0];
  let bestDist = haversine(lat, lng, best.lat, best.lng);
  for (let i = 1; i < CANDIDATE_METROS.length; i++) {
    const c = CANDIDATE_METROS[i];
    const d = haversine(lat, lng, c.lat, c.lng);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return { ...best, distanceMi: bestDist };
}

/**
 * Deterministic k-means++ initialization using distance² weighting.
 * Picks highest-weight point first, then each subsequent center is the
 * point that maximizes (min distance to existing center)² × weight.
 * Deterministic so the same demand set always yields the same seeds.
 * @param {Array<{ lat:number, lng:number, weight:number }>} points
 * @param {number} k
 * @returns {Array<{ lat:number, lng:number }>}
 */
function seedCenters(points, k) {
  if (points.length === 0 || k <= 0) return [];
  if (k >= points.length) return points.map(p => ({ lat: p.lat, lng: p.lng }));
  // First center: highest-weight point (deterministic).
  const sorted = [...points].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const centers = [{ lat: sorted[0].lat, lng: sorted[0].lng }];
  while (centers.length < k) {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let minDist = Infinity;
      for (const c of centers) {
        const d = haversine(p.lat, p.lng, c.lat, c.lng);
        if (d < minDist) minDist = d;
      }
      // distance² × weight prioritizes far-away heavy clusters
      const score = minDist * minDist * (p.weight || 1);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    centers.push({ lat: points[bestIdx].lat, lng: points[bestIdx].lng });
  }
  return centers;
}

/**
 * Run a weighted k-means on demand points. Each demand contributes its
 * weight (volume) to the cluster centroid. Returns cluster centers +
 * per-cluster demand sums.
 *
 * @param {Array<{ lat:number, lng:number, weight:number, id?:string }>} points
 * @param {number} k
 * @param {number} [maxIter=50]
 * @returns {Array<{ lat:number, lng:number, totalWeight:number, memberCount:number }>}
 */
function weightedKMeans(points, k, maxIter = 50) {
  const pts = (points || []).filter(p =>
    Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length === 0 || k <= 0) return [];
  const K = Math.min(k, pts.length);
  let centers = seedCenters(pts, K);
  let assignments = new Array(pts.length).fill(-1);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    // Assign
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = haversine(pts[i].lat, pts[i].lng, centers[c].lat, centers[c].lng);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed && iter > 0) break;
    // Re-compute weighted centroids
    for (let c = 0; c < centers.length; c++) {
      let sumW = 0, sumLat = 0, sumLng = 0, count = 0;
      for (let i = 0; i < pts.length; i++) {
        if (assignments[i] !== c) continue;
        const w = pts[i].weight || 0;
        sumW += w;
        sumLat += pts[i].lat * w;
        sumLng += pts[i].lng * w;
        count += 1;
      }
      if (sumW > 0) centers[c] = { lat: sumLat / sumW, lng: sumLng / sumW };
    }
  }
  // Build result with per-cluster stats
  return centers.map((c, idx) => {
    let totalWeight = 0, memberCount = 0;
    for (let i = 0; i < pts.length; i++) {
      if (assignments[i] !== idx) continue;
      totalWeight += (pts[i].weight || 0);
      memberCount += 1;
    }
    return { lat: c.lat, lng: c.lng, totalWeight, memberCount };
  });
}

/**
 * Recommend k facility locations based on demand clustering. Each cluster
 * center is mapped to its nearest real metro (from CANDIDATE_METROS);
 * duplicates are deduplicated + fallback metros picked from a ranked list.
 *
 * This is the v3 replacement for v2's `netoptAutoRecommendFacilities()`.
 *
 * @param {Array<{ lat:number, lng:number, volume?:number, weight?:number, id?:string }>} demands
 * @param {number} k — number of facilities to recommend
 * @param {Object} [opts]
 * @param {Array<string>} [opts.excludeCities] — city names already in use
 * @returns {Array<{ id:string, name:string, city:string, state:string, lat:number, lng:number,
 *                   clusterWeight:number, clusterSize:number, distanceToMetroMi:number }>}
 */
export function findOptimalLocations(demands, k, opts = {}) {
  const exclude = new Set((opts.excludeCities || []).map(s => s.toLowerCase().trim()));
  const points = (demands || [])
    .filter(d => Number.isFinite(d.lat) && Number.isFinite(d.lng))
    .map(d => ({
      id: d.id, lat: d.lat, lng: d.lng,
      weight: Number(d.weight) || Number(d.volume) || 1,
    }));
  if (points.length === 0 || k <= 0) return [];
  const kBounded = Math.max(1, Math.min(k, points.length, CANDIDATE_METROS.length));

  const clusters = weightedKMeans(points, kBounded);
  const usedMetros = new Set();
  const recommendations = [];
  for (const cl of clusters) {
    // Find nearest metro not already used (so two close clusters don't collapse to same city)
    let best = null, bestDist = Infinity;
    for (const metro of CANDIDATE_METROS) {
      const key = `${metro.name.toLowerCase()},${metro.state.toLowerCase()}`;
      if (usedMetros.has(key)) continue;
      if (exclude.has(`${metro.name.toLowerCase()}, ${metro.state.toLowerCase()}`)) continue;
      if (exclude.has(metro.name.toLowerCase())) continue;
      const d = haversine(cl.lat, cl.lng, metro.lat, metro.lng);
      if (d < bestDist) { bestDist = d; best = metro; }
    }
    if (!best) continue;
    const key = `${best.name.toLowerCase()},${best.state.toLowerCase()}`;
    usedMetros.add(key);
    recommendations.push({
      id: `fac-rec-${Date.now()}-${recommendations.length}`,
      name: `${best.name} DC`,
      city: best.name,
      state: best.state,
      lat: best.lat,
      lng: best.lng,
      clusterWeight: Math.round(cl.totalWeight),
      clusterSize: cl.memberCount,
      distanceToMetroMi: +bestDist.toFixed(1),
    });
  }
  return recommendations;
}


/**
 * Pre-flight validator for Run Scenario. Checks that every input numeric
 * field actually parses to a finite number — surfaces specific issues so
 * the user can fix them rather than seeing NaN/0 in results.
 *
 * Bug-fix 2026-04-25: prior runs would silently absorb bad inputs (a single
 * facility with a blank lat would produce NaN avg distance + $0 transport
 * + $0 handling because of NaN-comparison instability in the assignment
 * sort). Now we refuse to run and tell the user which row is broken.
 *
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateScenarioInputs(facilities, demands) {
  const errors = [];
  const warnings = [];
  const openFacs = (facilities || []).filter(f => f.isOpen !== false);
  if (openFacs.length === 0) errors.push('No facilities are activated. Open at least one DC before running.');
  if (!demands || demands.length === 0) errors.push('No demand points loaded. Add demand or pick an Archetype.');
  for (const f of openFacs) {
    const label = f.name || f.id || '(unnamed facility)';
    if (!Number.isFinite(Number(f.lat)) || !Number.isFinite(Number(f.lng))) {
      errors.push(`Facility "${label}" is missing valid lat/lng coordinates.`);
    }
    if (!Number.isFinite(Number(f.fixedCost))) warnings.push(`Facility "${label}" has no fixed cost — facility cost will be $0.`);
    if (!Number.isFinite(Number(f.variableCost))) warnings.push(`Facility "${label}" has no variable cost — handling cost contribution will be $0.`);
  }
  for (const d of (demands || [])) {
    const label = d.zip3 ? `zip3 ${d.zip3}` : (d.id || '(unnamed demand)');
    if (!Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lng))) {
      errors.push(`Demand "${label}" is missing valid lat/lng coordinates.`);
    }
    if (!Number.isFinite(Number(d.annualDemand)) || Number(d.annualDemand) <= 0) {
      warnings.push(`Demand "${label}" has no annual volume — it will not contribute to transport or handling cost.`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

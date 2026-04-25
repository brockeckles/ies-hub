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

/** Default rate card */
export const DEFAULT_RATES = {
  tlRatePerMile: 2.85,
  ltlBaseRate: 18.50, // $/CWT
  ltlWeightBreaks: [500, 1000, 2000, 5000, 10000],
  ltlBreakRates: [22.00, 18.50, 15.00, 12.50, 10.00],
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
 */
export function regionPairMultiplier(originRegion, destRegion) {
  if (!originRegion || !destRegion) return LTL_REGION_MULTIPLIERS.adjacent;
  if (originRegion === destRegion) return LTL_REGION_MULTIPLIERS.same;
  const adj = REGION_ADJACENCY[originRegion] || [];
  return adj.includes(destRegion) ? LTL_REGION_MULTIPLIERS.adjacent : LTL_REGION_MULTIPLIERS.cross;
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
 * @param {number} miles
 * @param {number} [speedMph=50]
 * @param {number} [hoursPerDay=11] — HOS driving hours
 * @returns {number} transit days (rounded up)
 */
export function estimateTransitDays(miles, speedMph = 50, hoursPerDay = 11) {
  if (miles <= 0) return 0;
  const drivingHours = miles / Math.max(1, speedMph);
  return Math.ceil(drivingHours / hoursPerDay);
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
  const breaks = rates.weightBreaks || DEFAULT_RATES.ltlWeightBreaks;
  const bRates = rates.breakRates || DEFAULT_RATES.ltlBreakRates;
  const fsc = rates.fuelSurcharge ?? DEFAULT_RATES.fuelSurcharge;

  // Find applicable CWT rate from weight breaks
  let ratePerCwt = bRates[0] || 18.50;
  for (let i = 0; i < breaks.length; i++) {
    if (weight >= breaks[i]) ratePerCwt = bRates[i];
  }

  const cwt = Math.max(1, weight) / 100;
  let base = cwt * ratePerCwt;

  // NMFC freight-class multiplier (B2)
  base *= nmfcMultiplier(rates.nmfcClass);

  // Distance adjustment (longer = higher, simplified)
  const distFactor = miles > 500 ? 1.15 : miles > 250 ? 1.08 : 1.0;

  // Regional LTL multiplier (B3)
  const regionMult = regionPairMultiplier(rates.originRegion, rates.destRegion);

  return base * distFactor * regionMult * (1 + fsc);
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
export function blendedLaneCost(miles, avgWeight, modeMix, rateCard = DEFAULT_RATES, originLng, destLng, originLat, destLat, nmfcClass) {
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
 * @param {import('./types.js?v=20260418-sM').Facility[]} facilities
 * @param {import('./types.js?v=20260418-sM').DemandPoint[]} demands
 * @param {import('./types.js?v=20260418-sM').ModeMix} modeMix
 * @param {import('./types.js?v=20260418-sM').RateCard} [rateCard]
 * @param {import('./types.js?v=20260418-sM').ServiceConfig} [serviceConfig]
 * @returns {import('./types.js?v=20260418-sM').LaneCost[]}
 */
export function assignDemand(facilities, demands, modeMix, rateCard = DEFAULT_RATES, serviceConfig = DEFAULT_SERVICE) {
  // Hard-constraint enforcement: lockedClosed wins over isOpen + lockedOpen.
  const lockedClosed = new Set(serviceConfig.lockedClosedIds || []);
  const lockedOpen = new Set(serviceConfig.lockedOpenIds || []);
  const openFacilities = facilities.filter(f =>
    !lockedClosed.has(f.id) && (lockedOpen.has(f.id) || f.isOpen !== false)
  );
  if (openFacilities.length === 0 || demands.length === 0) return [];

  const maxDist = serviceConfig.maxDistanceMiles;

  /** @type {Map<string, number>} */
  const facilityLoad = new Map();
  openFacilities.forEach(f => facilityLoad.set(f.id, 0));

  return demands.map(d => {
    // Sort facilities by distance, penalising SLA violators / capacity over.
    // Hard distance constraint short-circuits to a separate bucket.
    const ranked = openFacilities.map(f => {
      const dist = haversine(f.lat, f.lng, d.lat, d.lng);
      const transit = estimateTransitDays(dist, serviceConfig.truckSpeedMph);
      const maxDays = d.maxDays || serviceConfig.globalMaxDays;
      const slaPenalty = transit > maxDays ? 1e6 : 0;
      const capacityPenalty = f.capacity && (facilityLoad.get(f.id) || 0) >= f.capacity ? 1e8 : 0;
      // Hard distance constraint: penalise so we still pick the closest if no facility qualifies
      const distancePenalty = (maxDist != null && dist > maxDist) ? 1e7 : 0;
      return { facility: f, dist, transit, penalty: dist + slaPenalty + capacityPenalty + distancePenalty };
    }).sort((a, b) => a.penalty - b.penalty);

    const best = ranked[0];
    const costs = blendedLaneCost(
      best.dist,
      d.avgWeight || 25,
      modeMix,
      rateCard,
      best.facility.lng,
      d.lng,
      best.facility.lat,
      d.lat,
      d.nmfcClass
    );
    const maxDays = d.maxDays || serviceConfig.globalMaxDays;

    // Track facility load
    facilityLoad.set(best.facility.id, (facilityLoad.get(best.facility.id) || 0) + d.annualDemand);

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
export function evaluateScenario(name, facilities, demands, modeMix, rateCard, serviceConfig) {
  const assignments = assignDemand(facilities, demands, modeMix, rateCard, serviceConfig);

  const totalTransport = assignments.reduce((s, a) => s + a.blendedCost * ((demands.find(d => d.id === a.demandId)?.annualDemand || 0) / 52), 0); // weekly cost × 52 approximation
  const totalFacility = facilities.filter(f => f.isOpen !== false).reduce((s, f) => s + (f.fixedCost || 0), 0);
  const totalHandling = demands.reduce((s, d) => {
    const fac = facilities.find(f => f.id === assignments.find(a => a.demandId === d.id)?.facilityId);
    return s + (d.annualDemand || 0) * (fac?.variableCost || 0);
  }, 0);

  const totalDemand = demands.reduce((s, d) => s + (d.annualDemand || 0), 0);
  const totalCost = totalFacility + totalTransport + totalHandling;
  const avgDist = assignments.length > 0
    ? assignments.reduce((s, a) => s + a.distanceMiles, 0) / assignments.length
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
    if (s.serviceLevel < 90) verdict = 'SLA RISK';

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
export function exactSolver(facilities, demands, maxFacilities, modeMix, rateCard = DEFAULT_RATES, serviceConfig = DEFAULT_SERVICE) {
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
      const result = evaluateScenario(`${numFacs} DC`, facConfig, demands, modeMix, rateCard, serviceConfig);
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

  // Step 1: Compute demand centroid
  const centroid = computeDemandCentroid(demands);
  if (!centroid) {
    // Fallback if centroid is null
    const sorted = [...openFacs].sort((a, b) => (a.fixedCost || 0) - (b.fixedCost || 0));
    return sorted.slice(0, k).map(f => f.id);
  }

  // Step 2: Initialize with k facilities closest to centroid
  const byDistToCentroid = openFacs.map(f => ({
    id: f.id,
    dist: haversine(f.lat, f.lng, centroid.lat, centroid.lng),
  })).sort((a, b) => a.dist - b.dist);

  let openSet = new Set(byDistToCentroid.slice(0, k).map(f => f.id));

  // Step 3: Facility-swap improvement (20 iterations)
  for (let iter = 0; iter < 20; iter++) {
    let improved = false;

    for (const openId of openSet) {
      const openFac = facilities.find(f => f.id === openId);
      if (!openFac) continue;

      for (const candidate of openFacs) {
        if (openSet.has(candidate.id)) continue; // Already open

        // Try swapping openId with candidate
        const testSet = new Set(openSet);
        testSet.delete(openId);
        testSet.add(candidate.id);

        // Evaluate both scenarios
        const testFacs = facilities.map(f => ({ ...f, isOpen: testSet.has(f.id) }));
        const currentFacs = facilities.map(f => ({ ...f, isOpen: openSet.has(f.id) }));

        const testResult = evaluateScenario('test', testFacs, demands, modeMix, rateCard, serviceConfig);
        const currentResult = evaluateScenario('current', currentFacs, demands, modeMix, rateCard, serviceConfig);

        if (testResult.totalCost < currentResult.totalCost) {
          openSet = testSet;
          improved = true;
          break; // Restart loop
        }
      }
      if (improved) break;
    }

    if (!improved) break; // No improvement found, stop early
  }

  return Array.from(openSet);
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
export function recommendOptimalDCs(comparisonResults) {
  if (!comparisonResults || comparisonResults.length === 0) {
    return { recommendedIdx: 0, recommendation: 'No scenarios available.', savings: 0, savingsPct: 0 };
  }
  if (comparisonResults.length === 1) {
    return { recommendedIdx: 0, recommendation: 'Only one scenario evaluated — add more facility candidates to compare k-DC alternatives.', savings: 0, savingsPct: 0 };
  }

  const MIN_KNEE_GAP = 0.05;
  const ys = comparisonResults.map(r => r.totalCost);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = (yMax - yMin) || 1;
  const N = ys.length;
  // Normalize x to [0,1] across the indices, y to [0,1] across cost range.
  const xn = ys.map((_, i) => i / (N - 1));
  const yn = ys.map(y => (y - yMin) / yRange);
  const yStart = yn[0];
  const yEnd = yn[N - 1];

  let bestIdx = 0;
  let bestDist = -Infinity;
  for (let i = 0; i < N; i++) {
    // Chord from (0, yStart) to (1, yEnd); below-chord distance at i:
    const chordY = yStart + xn[i] * (yEnd - yStart);
    const dist = chordY - yn[i];
    if (dist > bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  // Choose recommendation: kneedle if it's a real inflection AND not at an
  // endpoint; otherwise pick the cheapest k.
  let recommendedIdx;
  let usedKneedle;
  if (bestDist > MIN_KNEE_GAP && bestIdx > 0 && bestIdx < N - 1) {
    recommendedIdx = bestIdx;
    usedKneedle = true;
  } else {
    recommendedIdx = ys.indexOf(yMin);
    usedKneedle = false;
  }

  const baselineCost = comparisonResults[0].totalCost;
  const rec = comparisonResults[recommendedIdx];
  const savings = baselineCost - rec.totalCost;
  const savingsPct = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;

  let narrative;
  if (recommendedIdx === 0) {
    narrative = 'Single DC is the lowest-cost scenario evaluated; adding facilities only adds net cost in this comparison.';
  } else if (recommendedIdx === N - 1 && !usedKneedle) {
    narrative = `${recommendedIdx + 1} DCs is the cheapest evaluated, but the curve is still trending down — extend "Max DCs to test" to confirm the true minimum.`;
  } else if (usedKneedle) {
    narrative = `${recommendedIdx + 1} DCs is the inflection point on the cost-vs-DC-count curve — the best balance of transport savings against added facility cost.`;
  } else {
    narrative = `${recommendedIdx + 1} DCs is the lowest-cost scenario evaluated; the curve is near-linear so the elbow isn't sharp.`;
  }

  return {
    recommendedIdx,
    recommendation: narrative,
    savings,
    savingsPct,
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
];

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

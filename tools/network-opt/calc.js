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
};

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
 * @returns {number}
 */
export function tlCost(miles, ratePerMile = DEFAULT_RATES.tlRatePerMile, fuelSurcharge = DEFAULT_RATES.fuelSurcharge) {
  return miles * ratePerMile * (1 + fuelSurcharge);
}

/**
 * Compute LTL cost for a shipment.
 * @param {number} weight — lbs
 * @param {number} miles — for minimum charge calculation
 * @param {Object} [rates]
 * @param {number[]} [rates.weightBreaks]
 * @param {number[]} [rates.breakRates] — $/CWT at each break
 * @param {number} [rates.fuelSurcharge]
 * @returns {number}
 */
export function ltlCost(weight, miles, rates = {}) {
  const breaks = rates.weightBreaks || DEFAULT_RATES.ltlWeightBreaks;
  const bRates = rates.breakRates || DEFAULT_RATES.ltlBreakRates;
  const fsc = rates.fuelSurcharge ?? DEFAULT_RATES.fuelSurcharge;

  // Find applicable rate
  let ratePerCwt = bRates[0] || 18.50;
  for (let i = 0; i < breaks.length; i++) {
    if (weight >= breaks[i]) ratePerCwt = bRates[i];
  }

  const cwt = Math.max(1, weight) / 100;
  const base = cwt * ratePerCwt;

  // Distance adjustment (longer = higher, simplified)
  const distFactor = miles > 500 ? 1.15 : miles > 250 ? 1.08 : 1.0;

  return base * distFactor * (1 + fsc);
}

/**
 * Compute parcel cost for a shipment.
 * @param {number} weight — lbs
 * @param {number} miles — to determine zone
 * @param {number[][]} [zoneRates] — zone × weight bracket rates
 * @param {number} [fuelSurcharge]
 * @returns {number}
 */
export function parcelCost(weight, miles, zoneRates = DEFAULT_RATES.parcelZoneRates, fuelSurcharge = DEFAULT_RATES.fuelSurcharge) {
  const zone = parcelZone(miles);
  const zoneIdx = Math.max(0, Math.min(zone - 2, zoneRates.length - 1));
  const brackets = PARCEL_WEIGHT_BRACKETS;

  // Find weight bracket
  let bracketIdx = 0;
  for (let i = 0; i < brackets.length; i++) {
    if (weight >= brackets[i]) bracketIdx = i;
  }

  const base = zoneRates[zoneIdx]?.[bracketIdx] || 15;
  return base * (1 + fuelSurcharge);
}

/**
 * Compute blended transportation cost based on mode mix.
 * @param {number} miles
 * @param {number} avgWeight — lbs per shipment
 * @param {import('./types.js').ModeMix} modeMix
 * @param {import('./types.js').RateCard} [rateCard]
 * @returns {{ tlCost: number, ltlCost: number, parcelCost: number, blendedCost: number }}
 */
export function blendedLaneCost(miles, avgWeight, modeMix, rateCard = DEFAULT_RATES) {
  const tl = tlCost(miles, rateCard.tlRatePerMile, rateCard.fuelSurcharge);
  const ltl = ltlCost(avgWeight, miles, rateCard);
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
 * @param {import('./types.js').Facility[]} facilities
 * @param {import('./types.js').DemandPoint[]} demands
 * @param {import('./types.js').ModeMix} modeMix
 * @param {import('./types.js').RateCard} [rateCard]
 * @param {import('./types.js').ServiceConfig} [serviceConfig]
 * @returns {import('./types.js').LaneCost[]}
 */
export function assignDemand(facilities, demands, modeMix, rateCard = DEFAULT_RATES, serviceConfig = DEFAULT_SERVICE) {
  const openFacilities = facilities.filter(f => f.isOpen !== false);
  if (openFacilities.length === 0 || demands.length === 0) return [];

  /** @type {Map<string, number>} */
  const facilityLoad = new Map();
  openFacilities.forEach(f => facilityLoad.set(f.id, 0));

  return demands.map(d => {
    // Sort facilities by distance, penalizing SLA violators
    const ranked = openFacilities.map(f => {
      const dist = haversine(f.lat, f.lng, d.lat, d.lng);
      const transit = estimateTransitDays(dist, serviceConfig.truckSpeedMph);
      const maxDays = d.maxDays || serviceConfig.globalMaxDays;
      const slaPenalty = transit > maxDays ? 1e6 : 0;
      const capacityPenalty = f.capacity && (facilityLoad.get(f.id) || 0) >= f.capacity ? 1e8 : 0;
      return { facility: f, dist, transit, penalty: dist + slaPenalty + capacityPenalty };
    }).sort((a, b) => a.penalty - b.penalty);

    const best = ranked[0];
    const costs = blendedLaneCost(best.dist, d.avgWeight || 25, modeMix, rateCard);
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
    };
  });
}

// ============================================================
// SCENARIO ANALYSIS
// ============================================================

/**
 * Evaluate a network scenario.
 * @param {string} name
 * @param {import('./types.js').Facility[]} facilities
 * @param {import('./types.js').DemandPoint[]} demands
 * @param {import('./types.js').ModeMix} modeMix
 * @param {import('./types.js').RateCard} [rateCard]
 * @param {import('./types.js').ServiceConfig} [serviceConfig]
 * @returns {import('./types.js').ScenarioResult}
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
 * @param {import('./types.js').ScenarioResult[]} scenarios
 * @returns {Array<import('./types.js').ScenarioResult & { verdict: string, deltaPct: number }>}
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
  'dtc-ecom-east': { name: 'DTC E-Commerce (East Coast)', modeMix: { tlPct: 5, ltlPct: 15, parcelPct: 80 }, maxDays: 2, baseVolume: 50000 },
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

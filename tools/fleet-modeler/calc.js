/**
 * IES Hub v3 — Fleet Modeler Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 *
 * Fleet sizing, per-vehicle costing, lane assignment, 3-way comparison,
 * and ATRI benchmark analysis.
 *
 * @module tools/fleet-modeler/calc
 */

// ============================================================
// VEHICLE SPECS (ATRI 2024 benchmarks)
// ============================================================

/** @type {import('./types.js').VehicleSpec[]} */
export const DEFAULT_VEHICLES = [
  { id: 'dry-van', name: 'Dry Van (53ft)', maxPayloadLbs: 45000, maxCubeFt3: 3500, mpg: 6.5, capitalCost: 130000, insuranceFactor: 1.0, fuelSurchargePerMi: 0, enabled: true },
  { id: 'reefer', name: 'Reefer (53ft)', maxPayloadLbs: 42000, maxCubeFt3: 2800, mpg: 5.5, capitalCost: 165000, insuranceFactor: 1.2, fuelSurchargePerMi: 0.08, enabled: true },
  { id: 'flatbed', name: 'Flatbed (48ft)', maxPayloadLbs: 48000, maxCubeFt3: 0, mpg: 6.0, capitalCost: 110000, insuranceFactor: 1.15, fuelSurchargePerMi: 0, enabled: true },
  { id: 'straight', name: 'Straight Truck (26ft)', maxPayloadLbs: 20000, maxCubeFt3: 1600, mpg: 7.0, capitalCost: 75000, insuranceFactor: 0.75, fuelSurchargePerMi: 0, enabled: true },
  { id: 'sprinter', name: 'Sprinter Van', maxPayloadLbs: 3500, maxCubeFt3: 400, mpg: 14.0, capitalCost: 48000, insuranceFactor: 0.5, fuelSurchargePerMi: 0, enabled: true },
];

/** @type {import('./types.js').FleetConfig} */
export const DEFAULT_CONFIG = {
  dieselPricePerGal: 3.85,
  driverCostPerHr: 28.00,
  avgSpeedMph: 50,
  drivingHoursPerDay: 11,
  operatingDaysPerWeek: 5,
  operatingWeeksPerYear: 52,
  utilizationPct: 85,
  maintenanceCostPerMi: 0.18,
  insuranceBasePerYear: 12000,
  depreciationYears: 7,
  teamDriving: false,
  gxoMarginPct: 12,
  carrierPremiumPct: 25,
};

/** ATRI 2024 average operating cost per mile for truckload */
export const ATRI_2024_CPM = 1.946;

// ============================================================
// LANE ASSIGNMENT
// ============================================================

/**
 * Find the best-fit vehicle for a lane based on weight and cube.
 * Picks the smallest vehicle that can handle the load.
 * @param {number} weightLbs
 * @param {number} cubeFt3
 * @param {import('./types.js').VehicleSpec[]} vehicles
 * @returns {import('./types.js').VehicleSpec|null}
 */
export function bestFitVehicle(weightLbs, cubeFt3, vehicles = DEFAULT_VEHICLES) {
  const enabled = vehicles.filter(v => v.enabled);
  if (enabled.length === 0) return null;

  // Filter vehicles that can handle weight AND cube (cube 0 means no cube constraint)
  const candidates = enabled.filter(v => {
    const weightOk = v.maxPayloadLbs >= weightLbs;
    const cubeOk = cubeFt3 <= 0 || v.maxCubeFt3 <= 0 || v.maxCubeFt3 >= cubeFt3;
    return weightOk && cubeOk;
  });

  if (candidates.length === 0) {
    // Fallback: return largest vehicle
    return enabled.reduce((a, b) => a.maxPayloadLbs >= b.maxPayloadLbs ? a : b);
  }

  // Pick smallest adequate vehicle (by payload capacity)
  return candidates.reduce((a, b) => a.maxPayloadLbs <= b.maxPayloadLbs ? a : b);
}

/**
 * Compute trips needed per week for a lane.
 * @param {number} weeklyShipments
 * @param {number} avgWeightLbs — per shipment
 * @param {number} vehiclePayloadLbs
 * @returns {number}
 */
export function tripsPerWeek(weeklyShipments, avgWeightLbs, vehiclePayloadLbs) {
  if (weeklyShipments <= 0) return 0;
  if (avgWeightLbs <= 0) return weeklyShipments; // 1 trip per shipment
  const shipmentsPerTrip = Math.max(1, Math.floor(vehiclePayloadLbs / Math.max(1, avgWeightLbs)));
  return Math.ceil(weeklyShipments / shipmentsPerTrip);
}

/**
 * Round-trip driving hours.
 * @param {number} distanceMiles — one-way
 * @param {number} speedMph
 * @returns {number}
 */
export function roundTripHours(distanceMiles, speedMph = 50) {
  return (distanceMiles * 2) / Math.max(1, speedMph);
}

/**
 * Assign all lanes to vehicles and compute per-lane costs.
 * @param {import('./types.js').Lane[]} lanes
 * @param {import('./types.js').VehicleSpec[]} vehicles
 * @param {import('./types.js').FleetConfig} config
 * @returns {import('./types.js').LaneAssignment[]}
 */
export function assignLanes(lanes, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  return lanes.map(lane => {
    const vehicle = bestFitVehicle(lane.avgWeightLbs, lane.avgCubeFt3, vehicles) || vehicles[0];
    const trips = tripsPerWeek(lane.weeklyShipments, lane.avgWeightLbs, vehicle.maxPayloadLbs);
    const rtMiles = lane.distanceMiles * 2;
    const rtHours = roundTripHours(lane.distanceMiles, config.avgSpeedMph);

    const annualTrips = trips * config.operatingWeeksPerYear;
    const annMiles = annualTrips * rtMiles;

    const fuelCostPerMi = config.dieselPricePerGal / Math.max(1, vehicle.mpg) + (vehicle.fuelSurchargePerMi || 0);
    const annFuel = annMiles * fuelCostPerMi;
    const annDriver = annualTrips * rtHours * config.driverCostPerHr;
    const annMaint = annMiles * config.maintenanceCostPerMi;

    const perTrip = annualTrips > 0 ? (annFuel + annDriver + annMaint) / annualTrips : 0;

    return {
      laneId: lane.id,
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      tripsPerWeek: trips,
      roundTripMiles: rtMiles,
      roundTripHours: rtHours,
      annualMiles: annMiles,
      annualFuelCost: annFuel,
      annualDriverCost: annDriver,
      annualMaintenanceCost: annMaint,
      perTripCost: perTrip,
    };
  });
}

// ============================================================
// FLEET SIZING
// ============================================================

/**
 * Compute available annual driving hours per vehicle.
 * @param {import('./types.js').FleetConfig} config
 * @returns {number}
 */
export function annualDrivingHoursPerVehicle(config = DEFAULT_CONFIG) {
  const dailyHours = config.teamDriving ? config.drivingHoursPerDay * 2 : config.drivingHoursPerDay;
  const annualDays = config.operatingDaysPerWeek * config.operatingWeeksPerYear;
  return dailyHours * annualDays * (config.utilizationPct / 100);
}

/**
 * Compute fleet composition from lane assignments.
 * @param {import('./types.js').LaneAssignment[]} assignments
 * @param {import('./types.js').VehicleSpec[]} vehicles
 * @param {import('./types.js').FleetConfig} config
 * @returns {import('./types.js').FleetSummary[]}
 */
export function computeFleetComposition(assignments, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  const availHours = annualDrivingHoursPerVehicle(config);

  // Group assignments by vehicle type
  /** @type {Map<string, import('./types.js').LaneAssignment[]>} */
  const groups = new Map();
  assignments.forEach(a => {
    if (!groups.has(a.vehicleId)) groups.set(a.vehicleId, []);
    groups.get(a.vehicleId).push(a);
  });

  return Array.from(groups.entries()).map(([vehicleId, laneAssignments]) => {
    const vehicle = vehicles.find(v => v.id === vehicleId) || vehicles[0];
    const totalAnnualHours = laneAssignments.reduce((s, a) => {
      const annualTrips = a.tripsPerWeek * config.operatingWeeksPerYear;
      return s + annualTrips * a.roundTripHours;
    }, 0);

    const unitsNeeded = Math.max(1, Math.ceil(totalAnnualHours / Math.max(1, availHours)));
    const annMiles = laneAssignments.reduce((s, a) => s + a.annualMiles, 0);
    const annFuel = laneAssignments.reduce((s, a) => s + a.annualFuelCost, 0);
    const annDriver = laneAssignments.reduce((s, a) => s + a.annualDriverCost, 0);
    const annMaint = laneAssignments.reduce((s, a) => s + a.annualMaintenanceCost, 0);
    const annDepr = (vehicle.capitalCost / Math.max(1, config.depreciationYears)) * unitsNeeded;
    const annIns = config.insuranceBasePerYear * vehicle.insuranceFactor * unitsNeeded;

    const totalCost = annFuel + annDriver + annMaint + annDepr + annIns;

    return {
      vehicleId,
      vehicleName: vehicle.name,
      unitsNeeded,
      annualMiles: annMiles,
      annualFuelCost: annFuel,
      annualDriverCost: annDriver,
      annualMaintenanceCost: annMaint,
      annualDepreciation: annDepr,
      annualInsurance: annIns,
      totalAnnualCost: totalCost,
      costPerMile: annMiles > 0 ? totalCost / annMiles : 0,
    };
  });
}

// ============================================================
// FULL FLEET ANALYSIS
// ============================================================

/**
 * Run full fleet analysis: assign lanes, size fleet, compare costs.
 * @param {import('./types.js').Lane[]} lanes
 * @param {import('./types.js').VehicleSpec[]} vehicles
 * @param {import('./types.js').FleetConfig} config
 * @returns {import('./types.js').FleetResult}
 */
export function analyzeFleet(lanes, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  const assignments = assignLanes(lanes, vehicles, config);
  const fleetComposition = computeFleetComposition(assignments, vehicles, config);

  const totalVehicles = fleetComposition.reduce((s, f) => s + f.unitsNeeded, 0);
  const totalAnnualMiles = fleetComposition.reduce((s, f) => s + f.annualMiles, 0);
  const totalAnnualCost = fleetComposition.reduce((s, f) => s + f.totalAnnualCost, 0);
  const avgCostPerMile = totalAnnualMiles > 0 ? totalAnnualCost / totalAnnualMiles : 0;

  // 3-way comparison
  const privateCost = totalAnnualCost;
  const gxoMargin = config.gxoMarginPct ?? 12;
  const carrierPremium = config.carrierPremiumPct ?? 25;
  const dedicatedCost = privateCost * (1 + gxoMargin / 100);
  const carrierCost = privateCost * (1 + carrierPremium / 100);

  // ATRI benchmark
  const atriBenchmark = computeAtriBenchmark(avgCostPerMile);

  return {
    assignments,
    fleetComposition,
    totalVehicles,
    totalAnnualMiles,
    totalAnnualCost,
    avgCostPerMile,
    comparison: { private: privateCost, dedicated: dedicatedCost, carrier: carrierCost },
    atriBenchmark,
  };
}

/**
 * Compare model cost per mile to ATRI 2024 benchmark.
 * @param {number} modelCpm
 * @returns {import('./types.js').AtriBenchmark}
 */
export function computeAtriBenchmark(modelCpm) {
  const delta = ATRI_2024_CPM > 0 ? ((modelCpm - ATRI_2024_CPM) / ATRI_2024_CPM) * 100 : 0;
  let verdict = /** @type {'BELOW' | 'AT' | 'ABOVE'} */ ('AT');
  if (delta < -5) verdict = 'BELOW';
  else if (delta > 5) verdict = 'ABOVE';
  return { atriCostPerMile: ATRI_2024_CPM, modelCostPerMile: modelCpm, deltaPct: delta, verdict };
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js').Lane[]} */
export const DEMO_LANES = [
  { id: 'l1', origin: 'Chicago, IL', destination: 'Indianapolis, IN', weeklyShipments: 12, avgWeightLbs: 32000, avgCubeFt3: 2200, distanceMiles: 182 },
  { id: 'l2', origin: 'Chicago, IL', destination: 'St. Louis, MO', weeklyShipments: 8, avgWeightLbs: 38000, avgCubeFt3: 2800, distanceMiles: 297 },
  { id: 'l3', origin: 'Chicago, IL', destination: 'Detroit, MI', weeklyShipments: 10, avgWeightLbs: 28000, avgCubeFt3: 2000, distanceMiles: 282 },
  { id: 'l4', origin: 'Chicago, IL', destination: 'Milwaukee, WI', weeklyShipments: 15, avgWeightLbs: 8000, avgCubeFt3: 800, distanceMiles: 92 },
  { id: 'l5', origin: 'Dallas, TX', destination: 'Houston, TX', weeklyShipments: 20, avgWeightLbs: 2500, avgCubeFt3: 300, distanceMiles: 239 },
  { id: 'l6', origin: 'Dallas, TX', destination: 'San Antonio, TX', weeklyShipments: 6, avgWeightLbs: 42000, avgCubeFt3: 3000, distanceMiles: 274 },
  { id: 'l7', origin: 'Atlanta, GA', destination: 'Nashville, TN', weeklyShipments: 8, avgWeightLbs: 35000, avgCubeFt3: 2500, distanceMiles: 249 },
  { id: 'l8', origin: 'Atlanta, GA', destination: 'Charlotte, NC', weeklyShipments: 10, avgWeightLbs: 15000, avgCubeFt3: 1200, distanceMiles: 244 },
];

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

/** @param {number} cpm @returns {string} */
export function formatCpm(cpm) {
  return '$' + cpm.toFixed(3) + '/mi';
}

/** @param {number} pct @returns {string} */
export function formatPct(pct) {
  return (pct || 0).toFixed(1) + '%';
}

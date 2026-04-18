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

/** @type {import('./types.js?v=20260418-sM').VehicleSpec[]} */
export const DEFAULT_VEHICLES = [
  { id: 'dry-van', name: 'Dry Van (53ft)', maxPayloadLbs: 45000, maxCubeFt3: 3500, mpg: 6.5, capitalCost: 130000, insuranceFactor: 1.0, fuelSurchargePerMi: 0, enabled: true },
  { id: 'reefer', name: 'Reefer (53ft)', maxPayloadLbs: 42000, maxCubeFt3: 2800, mpg: 5.5, capitalCost: 165000, insuranceFactor: 1.2, fuelSurchargePerMi: 0.08, enabled: true },
  { id: 'flatbed', name: 'Flatbed (48ft)', maxPayloadLbs: 48000, maxCubeFt3: 0, mpg: 6.0, capitalCost: 110000, insuranceFactor: 1.15, fuelSurchargePerMi: 0, enabled: true },
  { id: 'straight', name: 'Straight Truck (26ft)', maxPayloadLbs: 20000, maxCubeFt3: 1600, mpg: 7.0, capitalCost: 75000, insuranceFactor: 0.75, fuelSurchargePerMi: 0, enabled: true },
  { id: 'sprinter', name: 'Sprinter Van', maxPayloadLbs: 3500, maxCubeFt3: 400, mpg: 14.0, capitalCost: 48000, insuranceFactor: 0.5, fuelSurchargePerMi: 0, enabled: true },
];

/** @type {import('./types.js?v=20260418-sM').FleetConfig} */
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
  leaseMode: false,
  adminCostPct: 8,
  driverBenefitPct: 35,
  driverPayModel: 'hourly',
  driverPerMileRate: 0.60,
  driverPercentageOfRevenue: 0,
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
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @returns {import('./types.js?v=20260418-sM').VehicleSpec|null}
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
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {import('./types.js?v=20260418-sM').LaneAssignment[]}
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

    // B2: Apply driver benefits multiplier to base wage
    const driverBenefitMultiplier = 1 + (config.driverBenefitPct ?? 35) / 100;
    const annDriver = annualTrips * rtHours * config.driverCostPerHr * driverBenefitMultiplier;
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
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {number}
 */
export function annualDrivingHoursPerVehicle(config = DEFAULT_CONFIG) {
  const dailyHours = config.teamDriving ? config.drivingHoursPerDay * 2 : config.drivingHoursPerDay;
  const annualDays = config.operatingDaysPerWeek * config.operatingWeeksPerYear;
  return dailyHours * annualDays * (config.utilizationPct / 100);
}

/**
 * Compute fleet composition from lane assignments.
 * @param {import('./types.js?v=20260418-sM').LaneAssignment[]} assignments
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {import('./types.js?v=20260418-sM').FleetSummary[]}
 */
export function computeFleetComposition(assignments, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  const availHours = annualDrivingHoursPerVehicle(config);

  // Group assignments by vehicle type
  /** @type {Map<string, import('./types.js?v=20260418-sM').LaneAssignment[]>} */
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
    // Vehicle cost — purchase (depreciation) vs lease (monthly rate).
    // config.leaseMode: false = purchase (straight-line depreciation with residual),
    //                   true  = lease (monthly rate × 12 × units).
    const residualPct = 0.15;
    const LEASE_MONTHLY_RATES = { 'dry-van': 2200, 'reefer': 2800, 'flatbed': 2000, 'straight': 1500, 'sprinter': 800 };
    let annVehicle;
    if (config.leaseMode) {
      const monthly = LEASE_MONTHLY_RATES[vehicleId] || 2200;
      annVehicle = monthly * 12 * unitsNeeded;
    } else {
      const residual = vehicle.capitalCost * residualPct;
      annVehicle = ((vehicle.capitalCost - residual) / Math.max(1, config.depreciationYears)) * unitsNeeded;
    }
    const annDepr = annVehicle; // kept as legacy field name for downstream consumers
    const annIns = config.insuranceBasePerYear * vehicle.insuranceFactor * unitsNeeded;

    // B1: Apply admin overhead cost as % of subtotal
    const subtotal = annFuel + annDriver + annMaint + annDepr + annIns;
    const adminCostPct = config.adminCostPct ?? 8;
    const annAdmin = subtotal * (adminCostPct / 100);

    const totalCost = subtotal + annAdmin;

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
      annualAdminCost: annAdmin,
      totalAnnualCost: totalCost,
      costPerMile: annMiles > 0 ? totalCost / annMiles : 0,
    };
  });
}

// ============================================================
// FULL FLEET ANALYSIS
// ============================================================

/**
 * Core analysis: size fleet from assignments (no comparison logic).
 * Extracted to avoid circular dependency with calcDedicatedFleet/calcCommonCarrier.
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {{ assignments: import('./types.js?v=20260418-sM').LaneAssignment[], fleetComposition: import('./types.js?v=20260418-sM').FleetSummary[], totalVehicles: number, totalAnnualMiles: number, totalAnnualCost: number, avgCostPerMile: number }}
 */
export function analyzeFleetCore(lanes, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  const assignments = assignLanes(lanes, vehicles, config);
  const fleetComposition = computeFleetComposition(assignments, vehicles, config);

  const totalVehicles = fleetComposition.reduce((s, f) => s + f.unitsNeeded, 0);
  const totalAnnualMiles = fleetComposition.reduce((s, f) => s + f.annualMiles, 0);
  const totalAnnualCost = fleetComposition.reduce((s, f) => s + f.totalAnnualCost, 0);
  const avgCostPerMile = totalAnnualMiles > 0 ? totalAnnualCost / totalAnnualMiles : 0;

  return {
    assignments,
    fleetComposition,
    totalVehicles,
    totalAnnualMiles,
    totalAnnualCost,
    avgCostPerMile,
  };
}

/**
 * Run full fleet analysis: assign lanes, size fleet, compare costs.
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {import('./types.js?v=20260418-sM').FleetResult}
 */
export function analyzeFleet(lanes, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG, rateDeck) {
  const core = analyzeFleetCore(lanes, vehicles, config);

  // A2: Use real 3-way comparison (dedicated + carrier functions already exist)
  const privateCost = core.totalAnnualCost;
  const dedicatedResult = calcDedicatedFleet(lanes, vehicles, config);
  const carrierResult = calcCommonCarrier(lanes, config, rateDeck);

  // ATRI benchmark
  const atriBenchmark = computeAtriBenchmark(core.avgCostPerMile);

  return {
    assignments: core.assignments,
    fleetComposition: core.fleetComposition,
    totalVehicles: core.totalVehicles,
    totalAnnualMiles: core.totalAnnualMiles,
    totalAnnualCost: core.totalAnnualCost,
    avgCostPerMile: core.avgCostPerMile,
    comparison: { private: privateCost, dedicated: dedicatedResult.totalAnnual, carrier: carrierResult.totalAnnual },
    atriBenchmark,
  };
}

/**
 * Compare model cost per mile to ATRI 2024 benchmark.
 * @param {number} modelCpm
 * @returns {import('./types.js?v=20260418-sM').AtriBenchmark}
 */
export function computeAtriBenchmark(modelCpm) {
  const delta = ATRI_2024_CPM > 0 ? ((modelCpm - ATRI_2024_CPM) / ATRI_2024_CPM) * 100 : 0;
  let verdict = /** @type {'BELOW' | 'AT' | 'ABOVE'} */ ('AT');
  if (delta < -5) verdict = 'BELOW';
  else if (delta > 5) verdict = 'ABOVE';
  return { atriCostPerMile: ATRI_2024_CPM, modelCostPerMile: modelCpm, deltaPct: delta, verdict };
}

// ============================================================
// SENSITIVITY ANALYSIS
// ============================================================

/**
 * Generate 6×6 sensitivity matrix (driver rates × diesel prices).
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {import('./types.js?v=20260418-sM').SensitivityMatrix}
 */
export function calcSensitivityMatrix(lanes, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  // Driver rates: $25–$38/hr in 6 steps
  const driverRates = [25, 28, 30, 32, 35, 38];
  // Diesel prices: $3.25–$4.50/gal in 6 steps
  const dieselPrices = [3.25, 3.50, 3.75, 4.00, 4.25, 4.50];

  // Current scenario indices for highlighting
  const currentDriverIdx = driverRates.findIndex(r => Math.abs(r - config.driverCostPerHr) < 0.5) ||
    driverRates.reduce((near, r, i) => Math.abs(r - config.driverCostPerHr) < Math.abs(driverRates[near] - config.driverCostPerHr) ? i : near, 0);
  const currentDieselIdx = dieselPrices.findIndex(p => Math.abs(p - config.dieselPricePerGal) < 0.1) ||
    dieselPrices.reduce((near, p, i) => Math.abs(p - config.dieselPricePerGal) < Math.abs(dieselPrices[near] - config.dieselPricePerGal) ? i : near, 0);

  const matrix = driverRates.map((driverRate, rowIdx) => {
    return dieselPrices.map((dieselPrice, colIdx) => {
      // Temporarily override config
      const tempConfig = { ...config, driverCostPerHr: driverRate, dieselPricePerGal: dieselPrice };
      const result = analyzeFleet(lanes, vehicles, tempConfig);
      return {
        driverRate,
        dieselPrice,
        costPerMile: result.avgCostPerMile,
        isCurrent: rowIdx === currentDriverIdx && colIdx === currentDieselIdx,
      };
    });
  });

  return {
    rowLabels: driverRates,
    colLabels: dieselPrices,
    matrix,
    currentRow: currentDriverIdx,
    currentCol: currentDieselIdx,
  };
}

/**
 * Calculate dedicated fleet (GXO) cost model.
 * Cost-plus: (fuel + maint + vehicle + insurance + driver cost × 1.25 + admin) × (1 + margin).
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {{ totalAnnual: number, perMile: number, breakdown: object }}
 */
export function calcDedicatedFleet(lanes, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  const core = analyzeFleetCore(lanes, vehicles, config);
  const composition = core.fleetComposition;

  let totalFuel = 0, totalMaint = 0, totalVehicle = 0, totalInsurance = 0, totalDriver = 0, totalAdmin = 0;

  composition.forEach(f => {
    totalFuel += f.annualFuelCost;
    totalMaint += f.annualMaintenanceCost;
    totalVehicle += f.annualDepreciation;
    totalInsurance += f.annualInsurance;
    totalDriver += f.annualDriverCost;
    totalAdmin += f.annualAdminCost || 0;
  });

  // GXO cost-plus: apply 1.25 markup to driver cost, then add margin
  const margin = config.gxoMarginPct ?? 12;
  const baseCost = totalFuel + totalMaint + totalVehicle + totalInsurance + (totalDriver * 1.25) + totalAdmin;
  const totalAnnual = baseCost * (1 + margin / 100);

  return {
    totalAnnual,
    perMile: core.totalAnnualMiles > 0 ? totalAnnual / core.totalAnnualMiles : 0,
    breakdown: { fuel: totalFuel, maintenance: totalMaint, vehicle: totalVehicle, insurance: totalInsurance, driver: totalDriver, admin: totalAdmin },
  };
}

/**
 * Hardcoded fallback carrier rates ($/mi) — used only when no rate
 * deck is supplied. The UI prefers the editable rate deck pulled from
 * ref_fleet_carrier_rates (api.listCarrierRates).
 */
export const FALLBACK_CARRIER_RATES = {
  'dry-van': { base_rate_per_mile: 3.50, fuel_surcharge_pct: 0.18, min_charge: 350 },
  'reefer':  { base_rate_per_mile: 4.00, fuel_surcharge_pct: 0.20, min_charge: 450 },
  'flatbed': { base_rate_per_mile: 3.80, fuel_surcharge_pct: 0.18, min_charge: 425 },
  'straight':{ base_rate_per_mile: 2.80, fuel_surcharge_pct: 0.15, min_charge: 175 },
  'sprinter':{ base_rate_per_mile: 2.20, fuel_surcharge_pct: 0.12, min_charge: 95 },
};

/**
 * Build a vehicleType → rate map from a CarrierRate[] (matches the
 * shape of ref_fleet_carrier_rates rows). Handy when you want to pass
 * the deck downstream.
 * @param {Array<{vehicle_type:string, base_rate_per_mile:number, fuel_surcharge_pct:number, min_charge:number}>} deck
 */
export function indexCarrierDeck(deck) {
  const out = {};
  for (const row of (deck || [])) {
    if (!row?.vehicle_type) continue;
    out[row.vehicle_type] = {
      base_rate_per_mile: Number(row.base_rate_per_mile) || 0,
      fuel_surcharge_pct: Number(row.fuel_surcharge_pct) || 0,
      min_charge: Number(row.min_charge) || 0,
    };
  }
  return out;
}

/**
 * Calculate common carrier benchmark cost.
 * Per-lane: distance × rate/mi × (1 + fuel surcharge); weekly billable
 * floor enforced by min_charge × 52.
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @param {Object<string,{base_rate_per_mile:number,fuel_surcharge_pct:number,min_charge:number}>} [rateDeck]
 *   Optional vehicleType → rate map (use indexCarrierDeck on the
 *   supabase rows). Falls back to FALLBACK_CARRIER_RATES.
 * @returns {{ totalAnnual: number, perMile: number, lanes: object[] }}
 */
export function calcCommonCarrier(lanes, config = DEFAULT_CONFIG, rateDeck = FALLBACK_CARRIER_RATES) {
  const assignments = assignLanes(lanes, DEFAULT_VEHICLES, config);
  let totalAnnual = 0;
  let totalMiles = 0;

  const laneDetails = assignments.map(a => {
    const rates = rateDeck[a.vehicleId] || rateDeck['dry-van'] || FALLBACK_CARRIER_RATES['dry-van'];
    const baseRate = Number(rates.base_rate_per_mile) || 3.50;
    const fsc = Number(rates.fuel_surcharge_pct) || 0;
    const minCharge = Number(rates.min_charge) || 0;
    const effectiveRate = baseRate * (1 + fsc);

    // Weekly billable: max(distance × rate, min_charge); annual = ×52
    const lane = lanes.find(l => l.id === a.laneId);
    const milesPerShipment = lane?.distanceMiles || 0;
    const weeklyShipments = lane?.weeklyShipments || 0;
    const weeklyMiles = weeklyShipments * milesPerShipment;
    const weeklyMileCost = weeklyMiles * effectiveRate;
    const weeklyMinFloor = weeklyShipments * minCharge;
    const weeklyBillable = Math.max(weeklyMileCost, weeklyMinFloor);
    const annualCost = weeklyBillable * 52;

    totalAnnual += annualCost;
    totalMiles += a.annualMiles;
    return {
      laneId: a.laneId,
      vehicle: a.vehicleName,
      rate: effectiveRate,
      annualMiles: a.annualMiles,
      annualCost,
      minChargeApplied: weeklyMinFloor > weeklyMileCost,
    };
  });

  return {
    totalAnnual,
    perMile: totalMiles > 0 ? totalAnnual / totalMiles : 0,
    lanes: laneDetails,
  };
}

/**
 * Calculate purchase vs lease financing comparison.
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {{ purchase: object, lease: object }}
 */
export function calcFinancingComparison(vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  const depYears = config.depreciationYears || 7;
  const residualPct = 0.15;

  // Purchase mode: straight-line depreciation
  const purchaseDetail = vehicles.map(v => {
    const residual = v.capitalCost * residualPct;
    const annualDepreciation = (v.capitalCost - residual) / depYears;
    return {
      vehicleId: v.id,
      name: v.name,
      capitalCost: v.capitalCost,
      usefulLife: depYears,
      residualValue: residual,
      annualDepreciation,
    };
  });

  // Lease mode: standard monthly rates
  const leaseMonthlyRates = {
    'dry-van': 2200,
    'reefer': 2800,
    'flatbed': 2000,
    'straight': 1500,
    'sprinter': 800,
  };

  const leaseDetail = vehicles.map(v => {
    const monthly = leaseMonthlyRates[v.id] || 2200;
    const annual = monthly * 12;
    return {
      vehicleId: v.id,
      name: v.name,
      monthlyRate: monthly,
      annualLeaseCost: annual,
    };
  });

  return {
    purchase: purchaseDetail,
    lease: leaseDetail,
  };
}

/**
 * Calculate fleet cost under base ±20% volume scenarios.
 * @param {import('./types.js?v=20260418-sM').Lane[]} lanes
 * @param {import('./types.js?v=20260418-sM').VehicleSpec[]} vehicles
 * @param {import('./types.js?v=20260418-sM').FleetConfig} config
 * @returns {import('./types.js?v=20260418-sM').VolumeSensitivity[]}
 */
export function calcVolumeSensitivity(lanes, vehicles = DEFAULT_VEHICLES, config = DEFAULT_CONFIG) {
  const scenarios = [
    { label: '-20% Volume', multiplier: 0.8 },
    { label: '-10% Volume', multiplier: 0.9 },
    { label: 'Base Case', multiplier: 1.0 },
    { label: '+10% Volume', multiplier: 1.1 },
    { label: '+20% Volume', multiplier: 1.2 },
  ];

  return scenarios.map(s => {
    // Scale shipment volumes
    const scaledLanes = lanes.map(l => ({
      ...l,
      weeklyShipments: Math.ceil(l.weeklyShipments * s.multiplier),
    }));

    const result = analyzeFleet(scaledLanes, vehicles, config);
    return {
      scenario: s.label,
      multiplier: s.multiplier,
      totalVehicles: result.totalVehicles,
      totalAnnualCost: result.totalAnnualCost,
      costPerMile: result.avgCostPerMile,
      variance: {
        vehicles: result.totalVehicles - analyzeFleet(lanes, vehicles, config).totalVehicles,
        cost: result.totalAnnualCost - analyzeFleet(lanes, vehicles, config).totalAnnualCost,
      },
    };
  });
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js?v=20260418-sM').Lane[]} */
export const DEMO_LANES = [
  // Curated for ATRI 2024 OTR target of $1.946/mi
  // Adjusted to land Private CPM within ±10% ($1.75–$2.14/mi)
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

/**
 * IES Hub v3 — Fleet Modeler Types
 * JSDoc typedefs for lanes, vehicles, fleet sizing, and cost comparison.
 *
 * @module tools/fleet-modeler/types
 */

/**
 * @typedef {Object} VehicleSpec
 * @property {string} id
 * @property {string} name — e.g. 'Dry Van 53ft'
 * @property {number} maxPayloadLbs
 * @property {number} maxCubeFt3
 * @property {number} mpg — miles per gallon
 * @property {number} capitalCost — purchase price
 * @property {number} insuranceFactor — multiplier (1.0 = base)
 * @property {number} [fuelSurchargePerMi] — extra $/mi (e.g. reefer)
 * @property {boolean} enabled — user can toggle
 */

/**
 * @typedef {Object} Lane
 * @property {string} id
 * @property {string} origin
 * @property {string} destination
 * @property {number} weeklyShipments
 * @property {number} avgWeightLbs
 * @property {number} avgCubeFt3
 * @property {number} distanceMiles
 * @property {string} [deliveryWindow] — e.g. 'Next Day', '2-Day'
 */

/**
 * @typedef {Object} FleetConfig
 * @property {number} dieselPricePerGal — $/gal
 * @property {number} driverCostPerHr — $/hr loaded
 * @property {number} avgSpeedMph
 * @property {number} drivingHoursPerDay — HOS limit
 * @property {number} operatingDaysPerWeek
 * @property {number} operatingWeeksPerYear
 * @property {number} utilizationPct — % of available time trucks are loaded
 * @property {number} maintenanceCostPerMi — $/mi
 * @property {number} insuranceBasePerYear — base annual insurance per truck
 * @property {number} depreciationYears — years to depreciate
 * @property {boolean} teamDriving — doubles daily driving hours
 * @property {number} [gxoMarginPct] — margin for dedicated fleet comparison (default 12)
 * @property {number} [carrierPremiumPct] — premium for common carrier vs private (default 25)
 */

/**
 * @typedef {Object} LaneAssignment
 * @property {string} laneId
 * @property {string} vehicleId
 * @property {string} vehicleName
 * @property {number} tripsPerWeek — shipments / trips needed
 * @property {number} roundTripMiles
 * @property {number} roundTripHours
 * @property {number} annualMiles
 * @property {number} annualFuelCost
 * @property {number} annualDriverCost
 * @property {number} annualMaintenanceCost
 * @property {number} perTripCost
 */

/**
 * @typedef {Object} FleetSummary
 * @property {string} vehicleId
 * @property {string} vehicleName
 * @property {number} unitsNeeded
 * @property {number} annualMiles
 * @property {number} annualFuelCost
 * @property {number} annualDriverCost
 * @property {number} annualMaintenanceCost
 * @property {number} annualDepreciation
 * @property {number} annualInsurance
 * @property {number} totalAnnualCost
 * @property {number} costPerMile
 */

/**
 * @typedef {Object} FleetResult
 * @property {LaneAssignment[]} assignments
 * @property {FleetSummary[]} fleetComposition
 * @property {number} totalVehicles
 * @property {number} totalAnnualMiles
 * @property {number} totalAnnualCost
 * @property {number} avgCostPerMile
 * @property {{ private: number, dedicated: number, carrier: number }} comparison
 * @property {AtriBenchmark} atriBenchmark
 */

/**
 * @typedef {Object} AtriBenchmark
 * @property {number} atriCostPerMile — ATRI 2024 average $/mi
 * @property {number} modelCostPerMile
 * @property {number} deltaPct
 * @property {'BELOW' | 'AT' | 'ABOVE'} verdict
 */

export {};

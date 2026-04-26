/**
 * IES Hub v3 — Network Optimization Types
 * JSDoc typedefs for facilities, demand points, lanes, costing, and scenarios.
 *
 * @module tools/network-opt/types
 */

/**
 * @typedef {Object} Facility
 * @property {string} id
 * @property {string} name
 * @property {number} lat
 * @property {number} lng
 * @property {string} [city]
 * @property {string} [state]
 * @property {string} [zip]
 * @property {number} [capacity] — max annual units
 * @property {number} [fixedCost] — annual fixed cost
 * @property {number} [variableCost] — $/unit handled
 * @property {boolean} [isOpen] — whether facility is active in scenario
 */

/**
 * @typedef {Object} DemandPoint
 * @property {string} id
 * @property {string} [zip3] — 3-digit ZIP
 * @property {number} lat
 * @property {number} lng
 * @property {number} annualDemand — units/year
 * @property {number} [maxDays] — SLA transit time (default 3)
 * @property {'TL' | 'LTL' | 'Parcel' | 'Mixed'} [mode]
 * @property {number} [avgWeight] — lbs per shipment
 *
 * NET-C3 extensions (2026-04-26):
 * @property {boolean} [hazmat] — UN-classified hazmat shipment (drives ~12% TL premium, restricts route choices, requires placards/training)
 * @property {string}  [hazmatClass] — UN class (1.1 explosives → 9 misc); blank = none
 * @property {('uniform'|'holiday'|'spring'|'summer'|'back_to_school'|'custom')} [seasonality] — peak-month profile; default 'uniform'
 * @property {number[]} [monthlyShare] — 12-element % distribution (sums to 100); used when seasonality='custom'
 * @property {('daily'|'weekly'|'biweekly'|'monthly'|'irregular')} [frequency] — order cadence; drives LTL vs TL break-even
 * @property {number} [freqPerWeek] — explicit weekly shipment count (overrides frequency bucket if set)
 */

/**
 * @typedef {Object} ModeMix
 * @property {number} tlPct — % truckload
 * @property {number} ltlPct — % less-than-truckload
 * @property {number} parcelPct — % parcel
 */

/**
 * @typedef {Object} RateCard
 * @property {number} tlRatePerMile — $/mile for TL
 * @property {number} ltlBaseRate — base LTL rate per CWT
 * @property {number[]} ltlWeightBreaks — weight breakpoints in lbs
 * @property {number[]} ltlBreakRates — rate per CWT at each break
 * @property {number[][]} parcelZoneRates — zone × weight bracket rates
 * @property {number} fuelSurcharge — % surcharge
 */

/**
 * @typedef {Object} ServiceConfig
 * @property {number} targetServicePct — % of demand meeting SLA (e.g., 95)
 * @property {number} globalMaxDays — default max transit days
 * @property {number} truckSpeedMph — average truck speed
 * @property {boolean} hardConstraint — fail scenario if below target
 */

/**
 * @typedef {Object} LaneCost
 * @property {string} facilityId
 * @property {string} demandId
 * @property {number} distanceMiles
 * @property {number} transitDays
 * @property {number} tlCost
 * @property {number} ltlCost
 * @property {number} parcelCost
 * @property {number} blendedCost — weighted by mode mix
 * @property {boolean} meetsSlA
 */

/**
 * @typedef {Object} ScenarioResult
 * @property {string} name
 * @property {number} totalCost
 * @property {number} totalDemand
 * @property {number} avgCostPerUnit
 * @property {number} avgDistance
 * @property {number} slaMet — count meeting SLA
 * @property {number} slaTotal
 * @property {number} serviceLevel — slaMet / slaTotal × 100
 * @property {LaneCost[]} assignments
 * @property {{ facility: number, transport: number, handling: number }} costBreakdown
 */

/**
 * @typedef {Object} NetworkConfig
 * @property {string} [id]
 * @property {string} name
 * @property {Facility[]} facilities
 * @property {DemandPoint[]} demands
 * @property {ModeMix} modeMix
 * @property {RateCard} rateCard
 * @property {ServiceConfig} serviceConfig
 */

export {};

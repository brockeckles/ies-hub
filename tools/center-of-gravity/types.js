/**
 * IES Hub v3 — Center of Gravity Types
 * JSDoc typedefs for demand-weighted facility location analysis.
 *
 * @module tools/center-of-gravity/types
 */

/**
 * @typedef {Object} WeightedPoint
 * @property {string} id
 * @property {string} [name] — city/location label
 * @property {number} lat
 * @property {number} lng
 * @property {number} weight — demand volume, revenue, or other weighting factor
 * @property {'demand' | 'supply' | 'facility'} type
 */

/**
 * @typedef {Object} CogResult
 * @property {number} lat — center of gravity latitude
 * @property {number} lng — center of gravity longitude
 * @property {number} totalWeight — sum of all weights
 * @property {number} avgWeightedDistance — avg distance weighted by demand
 * @property {number} maxDistance — farthest point from COG
 * @property {string} nearestCity — closest major city to COG
 */

/**
 * @typedef {Object} MultiCogResult
 * @property {CogResult[]} centers — one per cluster
 * @property {ClusterAssignment[]} assignments
 * @property {number} totalWeightedDistance
 * @property {number} iterations — k-means iterations used
 */

/**
 * @typedef {Object} ClusterAssignment
 * @property {string} pointId
 * @property {number} clusterId — index into centers[]
 * @property {number} distanceToCenter — miles
 */

/**
 * @typedef {Object} CogConfig
 * @property {number} numCenters — k for k-means (1-5)
 * @property {number} maxIterations — convergence limit
 * @property {boolean} includeSupply — include supply points in weighting
 * @property {number} [transportCostPerMile] — truck $/mi for cost estimation
 * @property {number} [unitsPerTruck] — converts weight to truckloads (default 25,000 lbs)
 * @property {number} [fixedCostPerDC] — annual $/year fixed cost per facility (rent+labor+IT+depreciation). 0 = transport-only model. >0 = real U-curve.
 */

/**
 * @typedef {Object} CogScenario
 * @property {string} [id]
 * @property {string} name
 * @property {WeightedPoint[]} points
 * @property {CogConfig} config
 * @property {MultiCogResult} [result]
 */

/**
 * @typedef {Object} MajorCity
 * @property {string} name
 * @property {string} state
 * @property {number} lat
 * @property {number} lng
 */

export {};

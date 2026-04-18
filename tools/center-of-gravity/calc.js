/**
 * IES Hub v3 — Center of Gravity Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects, no browser globals.
 *
 * Weighted center-of-gravity analysis with k-means clustering
 * for multi-facility location optimization.
 *
 * @module tools/center-of-gravity/calc
 */

// ============================================================
// CONSTANTS
// ============================================================

const EARTH_RADIUS_MI = 3959;

/** @type {import('./types.js?v=20260418-sI').CogConfig} */
export const DEFAULT_CONFIG = {
  numCenters: 1,
  maxIterations: 100,
  includeSupply: false,
  transportCostPerMile: 2.85,
};

/** @type {import('./types.js?v=20260418-sI').MajorCity[]} */
export const MAJOR_CITIES = [
  { name: 'New York', state: 'NY', lat: 40.7128, lng: -74.0060 },
  { name: 'Los Angeles', state: 'CA', lat: 34.0522, lng: -118.2437 },
  { name: 'Chicago', state: 'IL', lat: 41.8781, lng: -87.6298 },
  { name: 'Houston', state: 'TX', lat: 29.7604, lng: -95.3698 },
  { name: 'Phoenix', state: 'AZ', lat: 33.4484, lng: -112.0740 },
  { name: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.7970 },
  { name: 'Atlanta', state: 'GA', lat: 33.7490, lng: -84.3880 },
  { name: 'Philadelphia', state: 'PA', lat: 39.9526, lng: -75.1652 },
  { name: 'Denver', state: 'CO', lat: 39.7392, lng: -104.9903 },
  { name: 'Seattle', state: 'WA', lat: 47.6062, lng: -122.3321 },
  { name: 'Nashville', state: 'TN', lat: 36.1627, lng: -86.7816 },
  { name: 'Indianapolis', state: 'IN', lat: 39.7684, lng: -86.1581 },
  { name: 'Columbus', state: 'OH', lat: 39.9612, lng: -82.9988 },
  { name: 'Memphis', state: 'TN', lat: 35.1495, lng: -90.0490 },
  { name: 'Kansas City', state: 'MO', lat: 39.0997, lng: -94.5786 },
  { name: 'Charlotte', state: 'NC', lat: 35.2271, lng: -80.8431 },
  { name: 'Minneapolis', state: 'MN', lat: 44.9778, lng: -93.2650 },
  { name: 'St. Louis', state: 'MO', lat: 38.6270, lng: -90.1994 },
  { name: 'Edison', state: 'NJ', lat: 40.5187, lng: -74.4121 },
  { name: 'Reno', state: 'NV', lat: 39.5296, lng: -119.8138 },
];

// ============================================================
// DISTANCE
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

// ============================================================
// SINGLE CENTER OF GRAVITY
// ============================================================

/**
 * Compute weighted center of gravity for a set of points.
 * Uses demand-weighted centroid formula.
 * @param {import('./types.js?v=20260418-sI').WeightedPoint[]} points
 * @returns {import('./types.js?v=20260418-sI').CogResult}
 */
export function computeCog(points) {
  if (points.length === 0) {
    return { lat: 0, lng: 0, totalWeight: 0, avgWeightedDistance: 0, maxDistance: 0, nearestCity: '' };
  }

  const totalWeight = points.reduce((s, p) => s + Math.max(0, p.weight), 0);
  if (totalWeight === 0) {
    // Unweighted centroid
    const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
    return { lat, lng, totalWeight: 0, avgWeightedDistance: 0, maxDistance: 0, nearestCity: findNearestCity(lat, lng) };
  }

  const lat = points.reduce((s, p) => s + p.lat * p.weight, 0) / totalWeight;
  const lng = points.reduce((s, p) => s + p.lng * p.weight, 0) / totalWeight;

  // Compute distances from COG
  const distances = points.map(p => ({
    dist: haversine(lat, lng, p.lat, p.lng),
    weight: p.weight,
  }));
  const weightedDistSum = distances.reduce((s, d) => s + d.dist * d.weight, 0);
  const avgWeightedDistance = totalWeight > 0 ? weightedDistSum / totalWeight : 0;
  const maxDistance = Math.max(0, ...distances.map(d => d.dist));
  const nearestCity = findNearestCity(lat, lng);

  return { lat, lng, totalWeight, avgWeightedDistance, maxDistance, nearestCity };
}

/**
 * Find nearest major city to a lat/lng point.
 * @param {number} lat
 * @param {number} lng
 * @returns {string}
 */
export function findNearestCity(lat, lng) {
  if (MAJOR_CITIES.length === 0) return '';
  let best = MAJOR_CITIES[0];
  let bestDist = Infinity;

  for (const city of MAJOR_CITIES) {
    const d = haversine(lat, lng, city.lat, city.lng);
    if (d < bestDist) { bestDist = d; best = city; }
  }

  return `${best.name}, ${best.state}`;
}

// ============================================================
// K-MEANS CLUSTERING (multi-facility)
// ============================================================

/**
 * Run weighted k-means clustering to find optimal locations for k facilities.
 * @param {import('./types.js?v=20260418-sI').WeightedPoint[]} points
 * @param {number} k — number of centers
 * @param {number} [maxIter=100]
 * @returns {import('./types.js?v=20260418-sI').MultiCogResult}
 */
export function kMeansCog(points, k = 1, maxIter = 100) {
  if (points.length === 0 || k <= 0) {
    return { centers: [], assignments: [], totalWeightedDistance: 0, iterations: 0 };
  }

  k = Math.min(k, points.length);

  // Initialize centers using k-means++ seeding
  let centers = kMeansPlusPlusInit(points, k);
  let assignments = [];
  let iter = 0;

  for (iter = 0; iter < maxIter; iter++) {
    // Assign points to nearest center
    const newAssignments = points.map(p => {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = haversine(p.lat, p.lng, centers[i].lat, centers[i].lng);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return { pointId: p.id, clusterId: bestIdx, distanceToCenter: bestDist };
    });

    // Check convergence
    const converged = assignments.length > 0 && newAssignments.every((a, i) => a.clusterId === assignments[i].clusterId);
    assignments = newAssignments;

    if (converged) break;

    // Recompute centers as weighted centroids of assigned points
    centers = centers.map((_, ci) => {
      const clusterPoints = points.filter((_, pi) => assignments[pi].clusterId === ci);
      if (clusterPoints.length === 0) return centers[ci]; // Keep empty cluster center

      const cog = computeCog(clusterPoints);
      return { lat: cog.lat, lng: cog.lng };
    });
  }

  // Build full CogResult for each center
  const centerResults = centers.map((c, ci) => {
    const clusterPoints = points.filter((_, pi) => assignments[pi].clusterId === ci);
    return computeCog(clusterPoints);
  });

  const totalWeightedDistance = assignments.reduce((s, a) => {
    const pt = points.find(p => p.id === a.pointId);
    return s + a.distanceToCenter * (pt?.weight || 0);
  }, 0);

  return { centers: centerResults, assignments, totalWeightedDistance, iterations: iter };
}

/**
 * K-means++ initialization: pick first center randomly, subsequent centers
 * with probability proportional to squared distance from nearest existing center.
 * @param {import('./types.js?v=20260418-sI').WeightedPoint[]} points
 * @param {number} k
 * @returns {{ lat: number, lng: number }[]}
 */
export function kMeansPlusPlusInit(points, k) {
  if (points.length === 0) return [];
  if (k >= points.length) return points.map(p => ({ lat: p.lat, lng: p.lng }));

  const centers = [];

  // First center: highest-weight point (deterministic for reproducibility)
  const sorted = [...points].sort((a, b) => b.weight - a.weight);
  centers.push({ lat: sorted[0].lat, lng: sorted[0].lng });

  // Subsequent centers: pick point farthest from nearest center (deterministic variant)
  while (centers.length < k) {
    let bestIdx = 0;
    let bestMinDist = -1;

    for (let i = 0; i < points.length; i++) {
      const minDist = Math.min(...centers.map(c => haversine(points[i].lat, points[i].lng, c.lat, c.lng)));
      const weighted = minDist * points[i].weight;
      if (weighted > bestMinDist) { bestMinDist = weighted; bestIdx = i; }
    }

    centers.push({ lat: points[bestIdx].lat, lng: points[bestIdx].lng });
  }

  return centers;
}

// ============================================================
// COST ESTIMATION
// ============================================================

/**
 * Estimate total annual transportation cost from COG analysis.
 * @param {import('./types.js?v=20260418-sI').MultiCogResult} cogResult
 * @param {import('./types.js?v=20260418-sI').WeightedPoint[]} points
 * @param {number} [costPerMile=2.85]
 * @returns {{ totalCost: number, avgCostPerUnit: number, costByCluster: number[] }}
 */
export function estimateTransportCost(cogResult, points, costPerMile = 2.85) {
  const costByCluster = cogResult.centers.map((_, ci) => {
    return cogResult.assignments
      .filter(a => a.clusterId === ci)
      .reduce((s, a) => {
        const pt = points.find(p => p.id === a.pointId);
        return s + a.distanceToCenter * (pt?.weight || 0) * costPerMile;
      }, 0);
  });

  const totalCost = costByCluster.reduce((s, c) => s + c, 0);
  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  const avgCostPerUnit = totalWeight > 0 ? totalCost / totalWeight : 0;

  return { totalCost, avgCostPerUnit, costByCluster };
}

// ============================================================
// SENSITIVITY (vary number of centers)
// ============================================================

/**
 * Run COG analysis for k = 1..maxK and return cost curve.
 * @param {import('./types.js?v=20260418-sI').WeightedPoint[]} points
 * @param {number} maxK
 * @param {number} [costPerMile=2.85]
 * @param {number} [maxIter=100]
 * @returns {Array<{ k: number, totalWeightedDistance: number, estimatedCost: number, avgDistance: number }>}
 */
export function sensitivityAnalysis(points, maxK = 5, costPerMile = 2.85, maxIter = 100) {
  const results = [];
  const effectiveMaxK = Math.min(maxK, points.length);

  for (let k = 1; k <= effectiveMaxK; k++) {
    const cogResult = kMeansCog(points, k, maxIter);
    const cost = estimateTransportCost(cogResult, points, costPerMile);
    const totalWeight = points.reduce((s, p) => s + p.weight, 0);
    const avgDist = totalWeight > 0 ? cogResult.totalWeightedDistance / totalWeight : 0;

    results.push({
      k,
      totalWeightedDistance: cogResult.totalWeightedDistance,
      estimatedCost: cost.totalCost,
      avgDistance: avgDist,
    });
  }

  return results;
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js?v=20260418-sI').WeightedPoint[]} */
export const DEMO_POINTS = [
  { id: 'p1', name: 'New York Metro', lat: 40.7128, lng: -74.0060, weight: 85000, type: 'demand' },
  { id: 'p2', name: 'Los Angeles', lat: 34.0522, lng: -118.2437, weight: 72000, type: 'demand' },
  { id: 'p3', name: 'Chicago', lat: 41.8781, lng: -87.6298, weight: 55000, type: 'demand' },
  { id: 'p4', name: 'Houston', lat: 29.7604, lng: -95.3698, weight: 48000, type: 'demand' },
  { id: 'p5', name: 'Phoenix', lat: 33.4484, lng: -112.0740, weight: 32000, type: 'demand' },
  { id: 'p6', name: 'Atlanta', lat: 33.7490, lng: -84.3880, weight: 42000, type: 'demand' },
  { id: 'p7', name: 'Dallas', lat: 32.7767, lng: -96.7970, weight: 38000, type: 'demand' },
  { id: 'p8', name: 'Miami', lat: 25.7617, lng: -80.1918, weight: 35000, type: 'demand' },
  { id: 'p9', name: 'Seattle', lat: 47.6062, lng: -122.3321, weight: 28000, type: 'demand' },
  { id: 'p10', name: 'Philadelphia', lat: 39.9526, lng: -75.1652, weight: 40000, type: 'demand' },
  { id: 'p11', name: 'Boston', lat: 42.3601, lng: -71.0589, weight: 36000, type: 'demand' },
  { id: 'p12', name: 'Denver', lat: 39.7392, lng: -104.9903, weight: 26000, type: 'demand' },
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

/** @param {number} lat @param {number} lng @returns {string} */
export function formatLatLng(lat, lng) {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

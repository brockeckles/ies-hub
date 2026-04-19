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

/** @type {import('./types.js?v=20260418-sP').CogConfig} */
export const DEFAULT_CONFIG = {
  numCenters: 1,
  maxIterations: 100,
  includeSupply: false,
  transportCostPerMile: 2.85,
  // Truck capacity used to convert "weight × distance" into truckloads × distance.
  // Default 25,000 lbs (a typical 53-ft dry van payload). If users enter weight
  // in pallets, set to 26 (pallets per truck). If orders, set to a typical
  // orders-per-truck number for the operation.
  unitsPerTruck: 25000,
};

/** @type {import('./types.js?v=20260418-sP').MajorCity[]} */
export const MAJOR_CITIES = [
  // Top 50 US Metro Areas + Secondary/Tertiary Hubs (109 total)
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
  // Additional Metros 21-50
  { name: 'Austin', state: 'TX', lat: 30.2672, lng: -97.7431 },
  { name: 'Portland', state: 'OR', lat: 45.5152, lng: -122.6784 },
  { name: 'Las Vegas', state: 'NV', lat: 36.1699, lng: -115.1398 },
  { name: 'Miami', state: 'FL', lat: 25.7617, lng: -80.1918 },
  { name: 'Boston', state: 'MA', lat: 42.3601, lng: -71.0589 },
  { name: 'San Francisco', state: 'CA', lat: 37.7749, lng: -122.4194 },
  { name: 'Phoenix', state: 'AZ', lat: 33.4484, lng: -112.0740 },
  { name: 'San Diego', state: 'CA', lat: 32.7157, lng: -117.1611 },
  { name: 'Tampa', state: 'FL', lat: 27.9506, lng: -82.4572 },
  { name: 'Orlando', state: 'FL', lat: 28.5421, lng: -81.3723 },
  { name: 'Phoenix-Mesa', state: 'AZ', lat: 33.3157, lng: -111.8910 },
  { name: 'Sacramento', state: 'CA', lat: 38.5816, lng: -121.4944 },
  { name: 'San Antonio', state: 'TX', lat: 29.4241, lng: -98.4936 },
  { name: 'Louisville', state: 'KY', lat: 38.2527, lng: -85.7585 },
  { name: 'Baltimore', state: 'MD', lat: 39.2904, lng: -76.6122 },
  { name: 'Milwaukee', state: 'WI', lat: 43.0389, lng: -87.9065 },
  { name: 'Albuquerque', state: 'NM', lat: 35.0844, lng: -106.6504 },
  { name: 'Tucson', state: 'AZ', lat: 32.2226, lng: -110.9747 },
  { name: 'Fresno', state: 'CA', lat: 36.7469, lng: -119.7726 },
  { name: 'Mesa', state: 'AZ', lat: 33.4152, lng: -111.8313 },
  { name: 'Sacramento', state: 'CA', lat: 38.5816, lng: -121.4944 },
  { name: 'Atlanta-Sandy Springs', state: 'GA', lat: 33.7490, lng: -84.3880 },
  { name: 'Long Beach', state: 'CA', lat: 33.7701, lng: -118.1937 },
  { name: 'Kansas City-Overland Park', state: 'KS', lat: 39.0997, lng: -94.5786 },
  { name: 'Mesa-Chandler', state: 'AZ', lat: 33.3157, lng: -111.8910 },
  { name: 'Virginia Beach', state: 'VA', lat: 36.8529, lng: -75.9780 },
  { name: 'Atlanta-Marietta', state: 'GA', lat: 33.9425, lng: -84.2577 },
  { name: 'New Orleans', state: 'LA', lat: 29.9511, lng: -90.2623 },
  { name: 'Pittsburgh', state: 'PA', lat: 40.4406, lng: -79.9959 },
  { name: 'Cincinnati', state: 'OH', lat: 39.1014, lng: -84.5124 },
  // Secondary/Tertiary Hubs 51-109
  { name: 'Cleveland', state: 'OH', lat: 41.4993, lng: -81.6944 },
  { name: 'Detroit', state: 'MI', lat: 42.3314, lng: -83.0458 },
  { name: 'Grand Prairie', state: 'TX', lat: 32.7555, lng: -97.0022 },
  { name: 'Irving', state: 'TX', lat: 32.8343, lng: -96.9289 },
  { name: 'Arlington', state: 'TX', lat: 32.7357, lng: -97.1081 },
  { name: 'Plano', state: 'TX', lat: 33.0198, lng: -96.6989 },
  { name: 'Garland', state: 'TX', lat: 32.9126, lng: -96.6348 },
  { name: 'Corpus Christi', state: 'TX', lat: 27.5794, lng: -97.3964 },
  { name: 'Lexington', state: 'KY', lat: 38.0297, lng: -84.4745 },
  { name: 'Knoxville', state: 'TN', lat: 35.9606, lng: -83.9207 },
  { name: 'Chattanooga', state: 'TN', lat: 35.0456, lng: -85.2672 },
  { name: 'Greenville', state: 'SC', lat: 34.8526, lng: -82.3940 },
  { name: 'Raleigh', state: 'NC', lat: 35.7796, lng: -78.6382 },
  { name: 'Greensboro', state: 'NC', lat: 36.0726, lng: -79.7920 },
  { name: 'Winston-Salem', state: 'NC', lat: 36.0999, lng: -80.2442 },
  { name: 'Charlotte-Concord', state: 'NC', lat: 35.2271, lng: -80.8431 },
  { name: 'Jacksonville', state: 'FL', lat: 30.3322, lng: -81.6557 },
  { name: 'Fort Lauderdale', state: 'FL', lat: 26.1224, lng: -80.1373 },
  { name: 'West Palm Beach', state: 'FL', lat: 26.7153, lng: -80.0534 },
  { name: 'Tampa-St. Petersburg', state: 'FL', lat: 27.7682, lng: -82.6403 },
  { name: 'Birmingham', state: 'AL', lat: 33.6487, lng: -86.8104 },
  { name: 'Mobile', state: 'AL', lat: 30.6954, lng: -88.0398 },
  { name: 'Little Rock', state: 'AR', lat: 34.7465, lng: -92.2896 },
  { name: 'Jackson', state: 'MS', lat: 32.2988, lng: -90.1848 },
  { name: 'Baton Rouge', state: 'LA', lat: 30.4515, lng: -91.1871 },
  { name: 'Oklahoma City', state: 'OK', lat: 35.4676, lng: -97.5164 },
  { name: 'Tulsa', state: 'OK', lat: 36.1539, lng: -95.9928 },
  { name: 'Wichita', state: 'KS', lat: 37.6872, lng: -97.3301 },
  { name: 'Des Moines', state: 'IA', lat: 41.5868, lng: -93.6250 },
  { name: 'Cedar Rapids', state: 'IA', lat: 42.0066, lng: -91.6647 },
  { name: 'Omaha', state: 'NE', lat: 41.2565, lng: -95.9345 },
  { name: 'Lincoln', state: 'NE', lat: 40.8258, lng: -96.6852 },
  { name: 'St. Paul', state: 'MN', lat: 44.9537, lng: -93.0900 },
  { name: 'Rochester', state: 'MN', lat: 44.0065, lng: -92.4669 },
  { name: 'Milwaukee-Waukesha', state: 'WI', lat: 43.0389, lng: -87.9065 },
  { name: 'Madison', state: 'WI', lat: 43.0731, lng: -89.4012 },
  { name: 'Green Bay', state: 'WI', lat: 44.5149, lng: -88.0133 },
  { name: 'Rockford', state: 'IL', lat: 42.2711, lng: -89.0935 },
  { name: 'Springfield', state: 'IL', lat: 39.7817, lng: -89.6501 },
  { name: 'Peoria', state: 'IL', lat: 40.6937, lng: -89.5894 },
  { name: 'Detroit-Flint', state: 'MI', lat: 42.7335, lng: -83.6143 },
  { name: 'Grand Rapids', state: 'MI', lat: 42.9633, lng: -85.6681 },
  { name: 'Kalamazoo', state: 'MI', lat: 42.2917, lng: -85.5872 },
  { name: 'Lansing', state: 'MI', lat: 42.7335, lng: -84.5555 },
  { name: 'Cleveland-Akron', state: 'OH', lat: 41.4993, lng: -81.6944 },
  { name: 'Columbus-Hilliard', state: 'OH', lat: 39.9612, lng: -82.9988 },
  { name: 'Dayton', state: 'OH', lat: 39.7589, lng: -84.1916 },
  { name: 'Toledo', state: 'OH', lat: 41.6639, lng: -83.5235 },
  { name: 'Pittsburgh-Weirton', state: 'PA', lat: 40.4406, lng: -79.9959 },
  { name: 'Philadelphia-Trenton', state: 'PA', lat: 39.9526, lng: -75.1652 },
  { name: 'Buffalo', state: 'NY', lat: 42.8864, lng: -78.8784 },
  { name: 'Rochester', state: 'NY', lat: 43.1566, lng: -77.6088 },
  { name: 'Syracuse', state: 'NY', lat: 43.0481, lng: -76.1474 },
  { name: 'Albany', state: 'NY', lat: 42.6526, lng: -73.7562 },
  { name: 'Hartford', state: 'CT', lat: 41.7658, lng: -72.6734 },
  { name: 'Providence', state: 'RI', lat: 41.8240, lng: -71.4128 },
  { name: 'Boston-Worcester', state: 'MA', lat: 42.3601, lng: -71.0589 },
  { name: 'Portland', state: 'ME', lat: 43.6591, lng: -70.2568 },
  { name: 'Burlington', state: 'VT', lat: 44.4759, lng: -73.2121 },
  { name: 'Montpelier', state: 'VT', lat: 44.2601, lng: -72.5754 },
  { name: 'New Haven', state: 'CT', lat: 41.3083, lng: -72.9279 },
  { name: 'Springfield', state: 'MA', lat: 42.1015, lng: -72.5898 },
  { name: 'Bridgeport', state: 'CT', lat: 41.1825, lng: -73.1974 },
  { name: 'Stockton', state: 'CA', lat: 37.9577, lng: -121.2908 },
  { name: 'Modesto', state: 'CA', lat: 37.6687, lng: -121.0093 },
  { name: 'Visalia', state: 'CA', lat: 36.3305, lng: -119.2921 },
  { name: 'Bakersfield', state: 'CA', lat: 35.3733, lng: -119.0187 },
  { name: 'Santa Ana', state: 'CA', lat: 33.7455, lng: -117.8677 },
  { name: 'Anaheim', state: 'CA', lat: 33.8353, lng: -117.9145 },
  { name: 'Riverside', state: 'CA', lat: 33.9425, lng: -117.3550 },
  { name: 'San Bernardino', state: 'CA', lat: 34.1083, lng: -117.2898 },
  { name: 'Chandler', state: 'AZ', lat: 33.2999, lng: -111.8456 },
  { name: 'Scottsdale', state: 'AZ', lat: 33.4942, lng: -111.9261 },
  { name: 'Glendale', state: 'AZ', lat: 33.6390, lng: -112.1857 },
  { name: 'Henderson', state: 'NV', lat: 35.9757, lng: -115.0169 },
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
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @returns {import('./types.js?v=20260418-sP').CogResult}
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
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} k — number of centers
 * @param {number} [maxIter=100]
 * @returns {import('./types.js?v=20260418-sP').MultiCogResult}
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
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
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
// OUTLIER HANDLING
// ============================================================

/**
 * Winsorize demand weights at a given percentile (e.g., 95th).
 * Returns a new array with capped weights; preserves all other properties.
 * Caps outliers without removing them — maintains point count for sensitivity analysis.
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} [percentile=95]
 * @returns {import('./types.js?v=20260418-sP').WeightedPoint[]}
 */
export function capWeightsByPercentile(points, percentile = 95) {
  if (points.length === 0) return [];

  const sorted = [...points].map(p => p.weight).sort((a, b) => a - b);
  const idx = Math.ceil((percentile / 100) * sorted.length) - 1;
  const cap = sorted[Math.max(0, idx)];

  return points.map(p => ({
    ...p,
    weight: Math.min(p.weight, cap),
  }));
}

// ============================================================
// COST ESTIMATION
// ============================================================

/**
 * Estimate total annual transportation cost from COG analysis.
 *
 * Formula: for each point, truckloads_per_year = weight / unitsPerTruck;
 * annual cost for that point = truckloads × distance × costPerMile.
 *
 * The previous formula multiplied `weight × distance × costPerMile` directly,
 * which treated every unit as riding alone — produced numbers 4-5 orders of
 * magnitude too large. See the 2026-04-18 SME walkthrough where a 12-point
 * demo returned $1.4B in annual transport cost.
 *
 * @param {import('./types.js?v=20260418-sP').MultiCogResult} cogResult
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} [costPerMile=2.85]
 * @param {number} [unitsPerTruck=25000]
 * @returns {{ totalCost: number, avgCostPerUnit: number, costByCluster: number[], totalTruckloads: number }}
 */
export function estimateTransportCost(cogResult, points, costPerMile = 2.85, unitsPerTruck = 25000) {
  const capacity = Math.max(1, unitsPerTruck || 1); // guard against /0
  const costByCluster = cogResult.centers.map((_, ci) => {
    return cogResult.assignments
      .filter(a => a.clusterId === ci)
      .reduce((s, a) => {
        const pt = points.find(p => p.id === a.pointId);
        const w = pt?.weight || 0;
        const truckloads = w / capacity;
        return s + truckloads * a.distanceToCenter * costPerMile;
      }, 0);
  });

  const totalCost = costByCluster.reduce((s, c) => s + c, 0);
  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  const avgCostPerUnit = totalWeight > 0 ? totalCost / totalWeight : 0;
  const totalTruckloads = totalWeight / capacity;

  return { totalCost, avgCostPerUnit, costByCluster, totalTruckloads };
}

// ============================================================
// SENSITIVITY (vary number of centers)
// ============================================================

/**
 * Run COG analysis for k = 1..maxK and return cost curve.
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} maxK
 * @param {number} [costPerMile=2.85]
 * @param {number} [maxIter=100]
 * @returns {Array<{ k: number, totalWeightedDistance: number, estimatedCost: number, avgDistance: number, isElbow?: boolean }>}
 */
export function sensitivityAnalysis(points, maxK = 5, costPerMile = 2.85, maxIter = 100, unitsPerTruck = 25000) {
  const results = [];
  const effectiveMaxK = Math.min(maxK, points.length);

  for (let k = 1; k <= effectiveMaxK; k++) {
    const cogResult = kMeansCog(points, k, maxIter);
    const cost = estimateTransportCost(cogResult, points, costPerMile, unitsPerTruck);
    const totalWeight = points.reduce((s, p) => s + p.weight, 0);
    const avgDist = totalWeight > 0 ? cogResult.totalWeightedDistance / totalWeight : 0;

    results.push({
      k,
      totalWeightedDistance: cogResult.totalWeightedDistance,
      estimatedCost: cost.totalCost,
      avgDistance: avgDist,
    });
  }

  // Detect elbow: find the point where incremental improvement drops below
  // the threshold below. 5% is the industry-standard knee heuristic for
  // k-means/facility-siting elbow detection (Thorndike 1953, applied
  // throughout supply-chain textbooks). transport cost per mile + units
  // per truck are already user-editable inputs on the Config tab.
  const ELBOW_THRESHOLD = 0.05;
  if (results.length >= 2) {
    const baseCost = results[0].estimatedCost;
    for (let i = 1; i < results.length; i++) {
      const improvement = (results[i - 1].estimatedCost - results[i].estimatedCost) / baseCost;
      if (improvement < ELBOW_THRESHOLD) {
        results[i - 1].isElbow = true;
        break;
      }
    }
  }

  return results;
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js?v=20260418-sP').WeightedPoint[]} */
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

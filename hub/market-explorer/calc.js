/**
 * IES Hub v3 — Market Explorer Calculation Engine
 * PURE FUNCTIONS ONLY — no DOM, no side effects.
 * @module hub/market-explorer/calc
 */

// ============================================================
// DEMO MARKET DATA — 20 major US logistics markets
// ============================================================

export const DEMO_MARKETS = [
  { id: 'mem', name: 'Memphis, TN', region: 'Southeast', lat: 35.1495, lng: -90.0490, laborScore: 72, avgWage: 17.25, unemploymentRate: 4.2, warehouseRate: 5.80, availabilityPct: 6.8, freightIndex: 92, activeDeals: 3, verticals: ['Retail', 'E-Commerce'], gxoPresence: 'active' },
  { id: 'ind', name: 'Indianapolis, IN', region: 'Midwest', lat: 39.7684, lng: -86.1581, laborScore: 68, avgWage: 17.50, unemploymentRate: 3.8, warehouseRate: 5.20, availabilityPct: 5.5, freightIndex: 88, activeDeals: 2, verticals: ['Automotive', 'Retail'], gxoPresence: 'active' },
  { id: 'chi', name: 'Chicago, IL', region: 'Midwest', lat: 41.8781, lng: -87.6298, laborScore: 58, avgWage: 19.75, unemploymentRate: 5.1, warehouseRate: 7.40, availabilityPct: 4.2, freightIndex: 95, activeDeals: 4, verticals: ['F&B', 'Retail', 'E-Commerce'], gxoPresence: 'active' },
  { id: 'dal', name: 'Dallas-Fort Worth, TX', region: 'Southwest', lat: 32.7767, lng: -96.7970, laborScore: 65, avgWage: 17.00, unemploymentRate: 3.9, warehouseRate: 5.90, availabilityPct: 7.1, freightIndex: 85, activeDeals: 2, verticals: ['Retail', 'Technology'], gxoPresence: 'active' },
  { id: 'atl', name: 'Atlanta, GA', region: 'Southeast', lat: 33.7490, lng: -84.3880, laborScore: 62, avgWage: 17.80, unemploymentRate: 4.0, warehouseRate: 6.10, availabilityPct: 5.8, freightIndex: 90, activeDeals: 3, verticals: ['E-Commerce', 'CPG'], gxoPresence: 'active' },
  { id: 'lax', name: 'Los Angeles, CA', region: 'West', lat: 33.9425, lng: -118.2551, laborScore: 45, avgWage: 21.50, unemploymentRate: 5.8, warehouseRate: 14.20, availabilityPct: 2.1, freightIndex: 105, activeDeals: 2, verticals: ['Retail', 'Fashion'], gxoPresence: 'active' },
  { id: 'njy', name: 'Northern NJ / NYC Metro', region: 'Northeast', lat: 40.7128, lng: -74.0060, laborScore: 42, avgWage: 22.00, unemploymentRate: 5.5, warehouseRate: 12.50, availabilityPct: 3.0, freightIndex: 110, activeDeals: 1, verticals: ['Pharma', 'Fashion'], gxoPresence: 'active' },
  { id: 'col', name: 'Columbus, OH', region: 'Midwest', lat: 39.9612, lng: -82.9988, laborScore: 70, avgWage: 17.00, unemploymentRate: 3.6, warehouseRate: 4.80, availabilityPct: 6.5, freightIndex: 82, activeDeals: 1, verticals: ['Retail', 'E-Commerce'], gxoPresence: 'active' },
  { id: 'leh', name: 'Lehigh Valley, PA', region: 'Northeast', lat: 40.6023, lng: -75.4714, laborScore: 55, avgWage: 18.50, unemploymentRate: 4.3, warehouseRate: 7.80, availabilityPct: 4.0, freightIndex: 98, activeDeals: 1, verticals: ['E-Commerce', 'CPG'], gxoPresence: 'active' },
  { id: 'sav', name: 'Savannah, GA', region: 'Southeast', lat: 32.0809, lng: -81.0912, laborScore: 74, avgWage: 16.00, unemploymentRate: 3.5, warehouseRate: 4.50, availabilityPct: 8.2, freightIndex: 80, activeDeals: 0, verticals: ['Retail', 'F&B'], gxoPresence: 'target' },
  { id: 'lou', name: 'Louisville, KY', region: 'Southeast', lat: 38.2527, lng: -85.7585, laborScore: 71, avgWage: 16.50, unemploymentRate: 3.7, warehouseRate: 4.60, availabilityPct: 7.0, freightIndex: 84, activeDeals: 1, verticals: ['E-Commerce', 'Healthcare'], gxoPresence: 'active' },
  { id: 'pho', name: 'Phoenix, AZ', region: 'Southwest', lat: 33.4484, lng: -112.0740, laborScore: 60, avgWage: 17.25, unemploymentRate: 4.1, warehouseRate: 6.50, availabilityPct: 6.0, freightIndex: 88, activeDeals: 0, verticals: ['Technology', 'Retail'], gxoPresence: 'target' },
  { id: 'cin', name: 'Cincinnati, OH', region: 'Midwest', lat: 39.1031, lng: -84.5120, laborScore: 69, avgWage: 16.80, unemploymentRate: 3.8, warehouseRate: 4.90, availabilityPct: 6.2, freightIndex: 83, activeDeals: 1, verticals: ['CPG', 'Retail'], gxoPresence: 'active' },
  { id: 'rvs', name: 'Riverside / Inland Empire, CA', region: 'West', lat: 33.9806, lng: -117.3755, laborScore: 50, avgWage: 19.00, unemploymentRate: 5.2, warehouseRate: 10.80, availabilityPct: 3.5, freightIndex: 102, activeDeals: 2, verticals: ['E-Commerce', 'Retail'], gxoPresence: 'active' },
  { id: 'nas', name: 'Nashville, TN', region: 'Southeast', lat: 36.1627, lng: -86.7816, laborScore: 64, avgWage: 17.00, unemploymentRate: 3.4, warehouseRate: 5.40, availabilityPct: 5.5, freightIndex: 86, activeDeals: 0, verticals: ['Healthcare', 'Automotive'], gxoPresence: 'target' },
  { id: 'hou', name: 'Houston, TX', region: 'Southwest', lat: 29.7604, lng: -95.3698, laborScore: 63, avgWage: 17.50, unemploymentRate: 4.5, warehouseRate: 6.20, availabilityPct: 6.8, freightIndex: 87, activeDeals: 1, verticals: ['Energy', 'Industrial'], gxoPresence: 'active' },
  { id: 'kci', name: 'Kansas City, MO', region: 'Midwest', lat: 39.0997, lng: -94.5786, laborScore: 73, avgWage: 16.25, unemploymentRate: 3.3, warehouseRate: 4.40, availabilityPct: 7.5, freightIndex: 79, activeDeals: 0, verticals: ['F&B', 'Automotive'], gxoPresence: 'target' },
  { id: 'rno', name: 'Reno, NV', region: 'West', lat: 39.5296, lng: -119.8138, laborScore: 56, avgWage: 18.00, unemploymentRate: 4.0, warehouseRate: 7.00, availabilityPct: 5.0, freightIndex: 94, activeDeals: 1, verticals: ['E-Commerce', 'Technology'], gxoPresence: 'active' },
  { id: 'cha', name: 'Charlotte, NC', region: 'Southeast', lat: 35.2271, lng: -80.8431, laborScore: 66, avgWage: 17.00, unemploymentRate: 3.6, warehouseRate: 5.30, availabilityPct: 6.0, freightIndex: 85, activeDeals: 0, verticals: ['Retail', 'F&B'], gxoPresence: 'target' },
  { id: 'sea', name: 'Seattle-Tacoma, WA', region: 'West', lat: 47.6062, lng: -122.3321, laborScore: 48, avgWage: 21.00, unemploymentRate: 4.8, warehouseRate: 10.20, availabilityPct: 3.2, freightIndex: 100, activeDeals: 1, verticals: ['Technology', 'E-Commerce'], gxoPresence: 'active' },
];

// ============================================================
// STATISTICS
// ============================================================

/** @param {import('./types.js?v=20260417-mD').MarketData[]} markets */
export function computeStats(markets) {
  if (!markets.length) return { totalMarkets: 0, avgLaborScore: 0, avgWage: 0, avgWarehouseRate: 0, marketsWithDeals: 0 };
  const n = markets.length;
  return {
    totalMarkets: n,
    avgLaborScore: Math.round(markets.reduce((s, m) => s + m.laborScore, 0) / n),
    avgWage: +(markets.reduce((s, m) => s + m.avgWage, 0) / n).toFixed(2),
    avgWarehouseRate: +(markets.reduce((s, m) => s + m.warehouseRate, 0) / n).toFixed(2),
    marketsWithDeals: markets.filter(m => m.activeDeals > 0).length,
  };
}

// ============================================================
// FILTERS & SORTING
// ============================================================

export function filterByRegion(markets, region) {
  if (!region || region === 'all') return markets;
  return markets.filter(m => m.region === region);
}

export function filterByPresence(markets, presence) {
  if (!presence || presence === 'all') return markets;
  return markets.filter(m => m.gxoPresence === presence);
}

export function filterByVertical(markets, vertical) {
  if (!vertical || vertical === 'all') return markets;
  return markets.filter(m => m.verticals.includes(vertical));
}

export function searchMarkets(markets, query) {
  if (!query) return markets;
  const q = query.toLowerCase();
  return markets.filter(m =>
    m.name.toLowerCase().includes(q) ||
    m.region.toLowerCase().includes(q) ||
    m.verticals.some(v => v.toLowerCase().includes(q))
  );
}

export function sortMarkets(markets, field, asc = true) {
  const dir = asc ? 1 : -1;
  return [...markets].sort((a, b) => {
    const va = a[field] ?? 0;
    const vb = b[field] ?? 0;
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
}

// ============================================================
// COMPUTED METRICS
// ============================================================

export function uniqueRegions(markets) {
  return [...new Set(markets.map(m => m.region))].sort();
}

export function uniqueVerticals(markets) {
  return [...new Set(markets.flatMap(m => m.verticals))].sort();
}

export function topMarketsByLabor(markets, n = 5) {
  return [...markets].sort((a, b) => b.laborScore - a.laborScore).slice(0, n);
}

export function topMarketsByRate(markets, n = 5) {
  return [...markets].sort((a, b) => a.warehouseRate - b.warehouseRate).slice(0, n);
}

// ============================================================
// FORMATTING
// ============================================================

export function presenceBadge(presence) {
  switch (presence) {
    case 'active': return '<span class="hub-badge hub-badge-green">Active</span>';
    case 'target': return '<span class="hub-badge hub-badge-blue">Target</span>';
    default: return '<span class="hub-badge">None</span>';
  }
}

export function scoreBadge(score) {
  if (score >= 70) return `<span style="color: var(--ies-green); font-weight: 600;">${score}</span>`;
  if (score >= 50) return `<span style="color: var(--ies-orange); font-weight: 600;">${score}</span>`;
  return `<span style="color: var(--ies-red); font-weight: 600;">${score}</span>`;
}

export function fmt$(val) {
  return '$' + Number(val).toFixed(2);
}

export function fmtPct(val) {
  return Number(val).toFixed(1) + '%';
}

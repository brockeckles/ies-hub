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

// 2026-05-28 — Parcel cost engine (separate module). Local import so
// the symbols are available INSIDE calc.js (estimateBlendedCost uses
// estimateParcelLane); paired with the named re-export so external
// callers can still reach them via calc.*.
import {
  ZONE_BREAKPOINTS,
  zoneForMiles,
  FEDEX_GROUND_2026_LIST,
  UPS_GROUND_2026_LIST,
  USPS_GROUND_ADVANTAGE_2026_LIST,
  PARCEL_RATE_TABLES,
  PARCEL_CARRIER_LABELS,
  SERVICE_LEVELS,
  DEFAULT_SERVICE_MIX,
  serviceMixMultiplier,
  interpolateRate,
  parcelCostPerPackage,
  estimateParcelLane,
  parcelDistributionByZone,
  PARCEL_ENGINE_VERSION,
} from './parcel-calc.js?v=20260702-p14a';

// P1-4 (2026-07-02) — road factor single-sourced in shared/transport-rates.js
import { DEFAULT_ROAD_FACTOR, DEFAULT_TL_RATE_PER_MILE } from '../../shared/transport-rates.js?v=20260702-p14a';

export {
  ZONE_BREAKPOINTS,
  zoneForMiles,
  FEDEX_GROUND_2026_LIST,
  UPS_GROUND_2026_LIST,
  USPS_GROUND_ADVANTAGE_2026_LIST,
  PARCEL_RATE_TABLES,
  PARCEL_CARRIER_LABELS,
  SERVICE_LEVELS,
  DEFAULT_SERVICE_MIX,
  serviceMixMultiplier,
  interpolateRate,
  parcelCostPerPackage,
  estimateParcelLane,
  parcelDistributionByZone,
  PARCEL_ENGINE_VERSION,
};

/** @type {import('./types.js?v=20260418-sP').CogConfig} */
export const DEFAULT_CONFIG = {
  numCenters: 1,
  // UX0-4 (2026-07-03): solve k from the sensitivity sweep's recommendation
  // by default — the old fixed k=1 guaranteed a run-again loop even though
  // the sweep already knew the recommended k. Manual k edits switch it off.
  kAuto: true,
  maxIterations: 100,
  includeSupply: false,
  transportCostPerMile: DEFAULT_TL_RATE_PER_MILE,
  // 2026-05-26 — Round-trip factor. The k-means + cost formula compute
  // one-way distance from each demand point to its assigned center; real
  // carriers price for the round trip (loaded outbound + empty/backhaul
  // return). 2.0 = full round trip (no backhaul recovery). 1.5-1.8 if you
  // model partial backhaul revenue. Multiplied through estimateTransportCost
  // and sensitivityAnalysis.
  roundTripFactor: 2.0,
  // 2026-05-26 — Exclude Alaska & Hawaii from the solve. When TRUE, points
  // whose lat/lng falls inside the AK or HI bounding boxes are dropped at
  // _pointsForSolve time so a single AK customer doesn't drag the centroid
  // toward the Pacific Northwest. Default OFF (preserves prior behavior).
  excludeOffshore: false,
  // Truck capacity used to convert "weight × distance" into truckloads × distance.
  // Default 25,000 lbs (a typical 53-ft dry van payload). If users enter weight
  // in pallets, set to 26 (pallets per truck). If orders, set to a typical
  // orders-per-truck number for the operation.
  unitsPerTruck: 25000,
  // Annual fully-loaded fixed cost per DC (rent + labor + IT + depreciation).
  // 0 = transport-only model (legacy behavior); >0 = true U-curve where
  // sensitivityAnalysis adds k * fixedCostPerDC to the total cost.
  fixedCostPerDC: 0,
  // H1 fix (2026-04-25 EVE): outlier weight capping. Default OFF — when ON,
  // demand weights are winsorized at the configured percentile before k-means
  // and sensitivity analysis. Defends the COG from being dragged toward a
  // single big-volume customer (~30%+ of network volume).
  outlierCapEnabled: false,
  outlierCapPercentile: 95,
  // CM-PRC-1 sibling: weight unit governs label text on the truck-capacity
  // input + demand-point table column. Math is unit-agnostic — user weights
  // and capacity must agree. Supported: lb, cwt, pallets, units, cases,
  // orders, revenue.
  weightUnit: 'lb',
  // UX-2 COG Setup (2026-07-04) — which freight-profile preset the Quick
  // Setup select shows. '' = none/custom. Applying a preset patches the
  // SAME config keys the Engineering Parameters cards edit (mode mix,
  // rates, parcel knobs) — this key is bookkeeping for the select only,
  // never read by the engines.
  freightPreset: '',
  // 2026-05-29 — Demand scaling factor. Multiplies every point's weight
  // uniformly before the solve. Lets SDs dial sample data up to a
  // realistic customer scale without re-uploading (e.g. 'what if this
  // customer is 100x our sample size?'). Default 1.0 = passthrough.
  // Applied in _pointsForSolve so every downstream consumer (k-means,
  // cost, parcel, CO₂, sensitivity, tornado) honors the scaled values.
  demandScaleFactor: 1.0,
  // COG-B2: candidate facility list. When `snapToCandidates` is on, k-means
  // centers get snapped to the closest candidate after solve — turning the
  // free centroid into a constrained pick from a known site list (existing
  // GXO buildings, REIT inventory, M&A targets). Empty list = behaves like
  // before (free centroid).
  /** @type {Array<{ label?: string, lat: number, lng: number }>} */
  candidateFacilities: [],
  snapToCandidates: false,
  // 2026-05-28 — E2 current-state DC list. When non-empty, Analysis
  // renders a side-by-side benchmark card (Current vs Proposed vs Delta)
  // covering cost / coverage / CO₂ / avg distance. The biggest single
  // story-telling unlock for RFP pitches — "this saves $X / +Y pp / -Z t".
  /** @type {Array<{ label?: string, lat: number, lng: number }>} */
  currentStateDCs: [],
  // 2026-05-28 — F2 deal context. Captured at the top of Inputs so every
  // scenario carries the customer/industry/deal-stage metadata SDs need
  // for reports. Persisted alongside points + result in scenario_data.
  customerName: '',
  industry: '',
  dealStage: '',
  notes: '',
  // 2026-05-28 — Mode mix (B3). When enabled, cost uses the
  // mode-weighted effective $/mi instead of the single transportCostPerMile
  // knob. Real networks blend TL / LTL / parcel; applying a flat TL rate
  // to a parcel-heavy customer understates cost by 30-50%. Defaults are
  // 100/0/0 (pure TL) so existing scenarios behave identically until the
  // toggle is flipped.
  modeMixEnabled: false,
  modeMix: { tlPct: 100, ltlPct: 0, parcelPct: 0 },
  // Per-mode effective rates — TL flat per-truck-mi, LTL/parcel are
  // effective rates that fold in consolidation overhead / zone surcharges.
  // Industry rules-of-thumb (2026):
  //   TL spot     $2.50-$3.20/mi
  //   LTL         $3.80-$4.80/mi effective
  //   Parcel ground $25-$65/mi effective — wide range because parcel is
  //     fundamentally per-package (weight × zone), not per-mile.
  //     Reference points: UPS/FedEx Ground 6lb @ Z5 ≈ $18 all-in
  //     (after 25% fuel + residential); 3,000 packages per sortable
  //     trailer = $54k/trailer over an 800 mi Z5 trip = $67/mi. With
  //     COG's default unitsPerTruck=25,000 lbs and 5-lb packages,
  //     the right effective rate to reverse-engineer typical DTC parcel
  //     spend is closer to $40-50/mi. We default to $28 — sized for a
  //     parcel-specific unitsPerTruck (~3,000 pkgs per trailer); users
  //     on the lb-default should bump higher. Earlier placeholder of
  //     $8.50 was 3-5x too low (caught by Brock 2026-05-28).
  modeRates: { tlPerMile: DEFAULT_TL_RATE_PER_MILE, ltlPerMile: 4.20, parcelPerMile: 28.00 },
  // 2026-05-28 27b — Parcel engine knobs. Active when modeMixEnabled=true
  // and modeMix.parcelPct > 0. Parcel slice routes through parcel-calc's
  // zone-priced math; modeRates.parcelPerMile becomes display-only legacy.
  parcelCarrier: 'fedex_ground',
  parcelAvgPackageWeightLb: 5,
  parcelResidentialShare: 0.5,
  parcelFuelPct: 25,
  parcelContractDiscountPct: 0,
  // 2026-05-28 — Service mix: {ground, threeDay, twoDay, overnight}
  // share %s. Default 100% ground (legacy compatible).
  parcelServiceMix: { ground: 100, threeDay: 0, twoDay: 0, overnight: 0 },
  // 2026-05-29 — explicit packages-per-weight-unit override. When
  // the user has data in a unit where the auto-conversion can't be
  // determined (e.g. 'revenue' = \$ value), they can set this to the
  // packages-per-unit ratio directly. Empty = auto from weightUnit.
  parcelPackagesPerUnit: null,
  // 2026-05-28 37 — Dimensional weight multiplier. 1.0 = no DIM impact;
  // 1.2 = typical mixed DTC; 1.5-2.5 = light/large items (furniture).
  parcelDimMultiplier: 1.0,
  // 2026-05-28 38 — Avg accessorials per package (DAS + oversize +
  // hazmat). User-computed weighted average. Defaults to \$0.
  parcelAccessorialsPerPkg: 0,
  // 2026-05-28 39 — Discount tiers (weight-banded). Empty = use the
  // flat parcelContractDiscountPct. Tiers override when populated.
  // Each entry: { minWeightLb, discountPct } — band runs from
  // minWeightLb up to the next band's min (open-ended for the last band).
  parcelDiscountTiers: [],
  // 2026-05-28 — CO₂ emissions intensity (B20). kg CO₂ per truck-mile.
  // Default 1.62 = EPA SmartWay 2024 US heavy-duty diesel Class 8 average.
  // Range 1.30 (new fleets) to 2.10 (older / refrigerated). Threaded
  // through estimateTransportCost; surfaced as a new chrome KPI + a row
  // in the breakdown panel. CSRD / SECR / Scope 3 customer RFPs want
  // this number; without it, the COG output is a non-starter for major
  // 2026 deals.
  co2KgPerTruckMile: 1.62,
  // 2026-05-28 — B17 sensitivity range. Maximum k explored on the
  // Sensitivity tab. Was hardcoded to Math.max(numCenters, 5) which made
  // 'how would a 12-DC network compare' impossible to test without
  // bumping numCenters. Default 8 covers typical network-design ranges;
  // user can crank to 20 for big-network deep dives.
  sensitivityMaxK: 8,
  // 2026-05-29 E3 — Multi-year planning horizon. SDs need 3-5 year
  // cost projections for customer pitches (current single-year output
  // is fine for directional RFI but breaks at RFP+). Cost projects
  // forward as:
  //   costY[n] = baseCost × (1 + growth/100)^n × (1 + escalation/100)^n
  // where growth = annual demand growth and escalation = annual rate
  // escalation (truck+parcel surcharges + inflation on labor / fuel).
  // NPV at the given discount rate optional. Defaults to 1-year for
  // back-compat with all existing scenarios.
  analysisHorizonYears: 1,
  annualGrowthPct: 5,
  annualEscalationPct: 3,
  discountRatePct: 8,
  // 2026-05-28 — DC capacity ceiling (B6). When > 0, post-solve walks
  // demand from overflowing clusters to nearest under-capacity cluster
  // until everyone is within cap or every cluster is full. 0 = disabled
  // (no capacity check, k-means assignment kept as-is). Units match
  // weightUnit. Typical: 1.5M lbs/yr small DC, 5M med, 15M large.
  capacityPerDC: 0,
  // 2026-05-28 — service-level constraint (B7). Threshold in road-miles
  // above which an assignment is flagged 'out of service'. Doesn't change
  // the k-means math — just surfaces violations so SDs can answer the
  // #1 RFP question ('Can we hit 95% next-day?'). Common: 250 same-day
  // parcel · 500 next-day TL · 800 2-day LTL · 0 = disabled.
  maxServiceMiles: 0,
  // 2026-05-28 — road-mile multiplier. Haversine returns great-circle
  // distance; carriers pay for road miles. Continental US ratio averages
  // 1.20-1.25 (1.30+ in mountain west, 1.15 in plains). For a defensible
  // RFP number this should typically be 1.20-1.25. Set to 1.0 to recover
  // legacy great-circle behavior. Threaded through estimateTransportCost
  // + sensitivityAnalysis. Future: regional override (mountain / plains).
  roadFactor: DEFAULT_ROAD_FACTOR,
  // 2026-05-28 — k-means restart count. k-means is local-optimum-prone;
  // running N restarts with different seeds and keeping the lowest-cost
  // solution is the standard defense. Restart #0 uses the deterministic
  // highest-weight init (preserves the legacy single-run answer); restarts
  // #1..N-1 use a seeded PRNG so results stay reproducible per input set.
  // Default 10 is industry-standard. Set to 1 to recover legacy behavior.
  kmeansRestarts: 10,
};

// 2026-05-28 F2 — deal-context dropdown values. Kept short and
// 3PL-relevant; user can pick 'Other' (empty) and write a free-text note.
export const INDUSTRY_OPTIONS = [
  { value: '',                 label: '— Select —' },
  { value: 'dtc_ecom',         label: 'DTC E-Commerce' },
  { value: 'retail',           label: 'Retail / Big Box' },
  { value: 'cpg_grocery',      label: 'CPG / Grocery' },
  { value: 'industrial_mro',   label: 'Industrial / MRO' },
  { value: 'food_bev',         label: 'Food & Beverage' },
  { value: 'healthcare_pharma',label: 'Healthcare / Pharma' },
  { value: 'auto_aftermarket', label: 'Auto / Aftermarket' },
  { value: 'tech_electronics', label: 'Tech / Electronics' },
  { value: 'apparel_lifestyle',label: 'Apparel / Lifestyle' },
  { value: 'b2b_dist',         label: 'B2B Distribution' },
  { value: 'other',            label: 'Other' },
];

export const DEAL_STAGES = [
  { value: '',         label: '— Select —' },
  { value: 'discovery',label: 'Discovery / Pre-RFI' },
  { value: 'rfi',      label: 'RFI' },
  { value: 'rfp',      label: 'RFP' },
  { value: 'pricing',  label: 'Pricing' },
  { value: 'contract', label: 'Contract Negotiation' },
  { value: 'pilot',    label: 'Pilot' },
  { value: 'won',      label: 'Won — In Implementation' },
  { value: 'lost',     label: 'Lost / On Hold' },
  { value: 'internal', label: 'Internal / Scenario Sketch' },
];

// ============================================================
// UX-2 COG Setup (2026-07-04) — FREIGHT-PROFILE PRESETS
// ============================================================
// Each preset is a PATCH of DEFAULT_CONFIG keys (pinned by
// test-ux2-cog-setup.mjs — a preset may never introduce a key the
// Engineering Parameters surface doesn't already own). Rate anchors reuse
// the 2026 rules-of-thumb documented on DEFAULT_CONFIG.modeRates above.
export const FREIGHT_PROFILE_PRESETS = {
  pure_tl: {
    label: 'Retail replenishment — pure TL',
    summary: '100% truckload, single $/mi rate. Big-box, grocery, CPG store replenishment.',
    patch: {
      modeMixEnabled: false,
      modeMix: { tlPct: 100, ltlPct: 0, parcelPct: 0 },
    },
  },
  tl_ltl_blend: {
    label: 'Wholesale B2B — TL + LTL blend',
    summary: '70% TL / 30% LTL effective blend. Distributors, MRO, aftermarket, pharma wholesale.',
    patch: {
      modeMixEnabled: true,
      modeMix: { tlPct: 70, ltlPct: 30, parcelPct: 0 },
    },
  },
  dtc_parcel: {
    label: 'DTC E-Commerce — parcel-heavy',
    summary: '80% parcel via zone-priced engine (5 lb avg, 85% residential), 15% TL / 5% LTL inbound-transfer slice.',
    patch: {
      modeMixEnabled: true,
      modeMix: { tlPct: 15, ltlPct: 5, parcelPct: 80 },
      parcelCarrier: 'fedex_ground',
      parcelAvgPackageWeightLb: 5,
      parcelResidentialShare: 0.85,
      parcelFuelPct: 25,
      parcelServiceMix: { ground: 90, threeDay: 5, twoDay: 5, overnight: 0 },
    },
  },
  food_bev_reefer: {
    label: 'Food & Beverage — refrigerated TL',
    summary: '100% TL with reefer emissions intensity (2.10 kg CO\u2082/mi, EPA SmartWay refrigerated band).',
    patch: {
      modeMixEnabled: false,
      modeMix: { tlPct: 100, ltlPct: 0, parcelPct: 0 },
      co2KgPerTruckMile: 2.10,
    },
  },
};

// Deal-industry → suggested preset (assessment §6 D3: "freight-profile
// presets wired to the deal's industry"). Returns a FREIGHT_PROFILE_PRESETS
// key or null when there is no defensible default (Other / unset).
export function freightPresetForIndustry(industry) {
  switch (String(industry || '')) {
    case 'dtc_ecom':
    case 'apparel_lifestyle':
    case 'tech_electronics':  return 'dtc_parcel';
    case 'retail':
    case 'cpg_grocery':       return 'pure_tl';
    case 'food_bev':          return 'food_bev_reefer';
    case 'b2b_dist':
    case 'industrial_mro':
    case 'auto_aftermarket':
    case 'healthcare_pharma': return 'tl_ltl_blend';
    default:                  return null;
  }
}

/**
 * Apply a freight-profile preset to a config. Pure — returns a NEW config;
 * nested patch objects replace wholesale (a preset states its full mode
 * mix / service mix, never a partial). Unknown key → config unchanged.
 * @param {object} config
 * @param {string} key — FREIGHT_PROFILE_PRESETS key
 */
export function applyFreightPreset(config, key) {
  const preset = FREIGHT_PROFILE_PRESETS[key];
  if (!preset) return { ...config };
  const next = { ...config, freightPreset: key };
  for (const [k, v] of Object.entries(preset.patch)) {
    next[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...v } : v;
  }
  return next;
}

// CoG weight-unit metadata — drives label text + step sizes in the UI.
export const WEIGHT_UNIT_OPTIONS = [
  { value: 'lb',       label: 'Pounds (lb)',     short: 'lbs',     defaultCap: 25000, step: 100,    rateUnit: 'lb-mi'      },
  { value: 'cwt',      label: 'Hundredweight (cwt)', short: 'cwt', defaultCap: 250,   step: 1,      rateUnit: 'cwt-mi'     },
  { value: 'pallets',  label: 'Pallets',         short: 'pallets', defaultCap: 26,    step: 1,      rateUnit: 'pallet-mi'  },
  { value: 'units',    label: 'Units',           short: 'units',   defaultCap: 5000,  step: 100,    rateUnit: 'unit-mi'    },
  { value: 'cases',    label: 'Cases',           short: 'cases',   defaultCap: 1500,  step: 50,     rateUnit: 'case-mi'    },
  { value: 'orders',   label: 'Orders',          short: 'orders',  defaultCap: 250,   step: 10,     rateUnit: 'order-mi'   },
  { value: 'revenue',  label: 'Revenue ($)',     short: '$',       defaultCap: 50000, step: 1000,   rateUnit: '$-mi'       },
];

export function getWeightUnitMeta(unit) {
  return WEIGHT_UNIT_OPTIONS.find(u => u.value === unit) || WEIGHT_UNIT_OPTIONS[0];
}

/** @type {import('./types.js?v=20260418-sP').MajorCity[]} */
export const MAJOR_CITIES = [
  // Top 50 US Metro Areas + Secondary/Tertiary Hubs (109 cities). Used by findNearestCity
  // for snap-to-metro labeling on COG results. (Punchlist B1 — covers the v2 NET_CITIES coverage gap.)
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
    // A4 fix (2026-04-25 EVE): unweighted-fallback was silent. We now flag
    // the result with `unweightedFallback: true` so the UI can show a
    // warning banner and console.warn so anyone running with devtools open
    // sees the degradation immediately.
    console.warn('[CoG] All demand-point weights are zero — falling back to geometric centroid. Add nonzero weights for true center-of-gravity.');
    const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
    return { lat, lng, totalWeight: 0, avgWeightedDistance: 0, maxDistance: 0, nearestCity: findNearestCity(lat, lng), unweightedFallback: true };
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
  // P2-sweep fix (2026-04-22): weighted max-distance. The unweighted version
  // reports "worst-case miles to ANY demand point" which can be dominated by
  // a tiny-volume outlier; the weighted version reports the worst-case among
  // points carrying meaningful share of demand. Both useful — surface both so
  // callers can pick the right one.
  const maxWeightedDistance = Math.max(0, ...distances.filter(d => d.weight > 0).map(d => d.dist));
  const nearestCity = findNearestCity(lat, lng);

  return { lat, lng, totalWeight, avgWeightedDistance, maxDistance, maxWeightedDistance, nearestCity };
}

/**
 * Find nearest major city to a lat/lng point. When the nearest city is
 * farther than `warnThresholdMi` (default 50), appends the distance in
 * parens — e.g. "Fargo, ND (72 mi)" — so the caller can tell the COG
 * result isn't landing in a real metro.
 * @param {number} lat
 * @param {number} lng
 * @param {number} [warnThresholdMi]
 * @returns {string}
 */
export function findNearestCity(lat, lng, warnThresholdMi = 50) {
  const pool = _dedupedMajorCities();
  if (pool.length === 0) return '';
  let best = pool[0];
  let bestDist = Infinity;

  for (const city of pool) {
    const d = haversine(lat, lng, city.lat, city.lng);
    if (d < bestDist) { bestDist = d; best = city; }
  }

  const label = `${best.name}, ${best.state}`;
  if (Number.isFinite(warnThresholdMi) && bestDist > warnThresholdMi) {
    return `${label} (${Math.round(bestDist)} mi)`;
  }
  return label;
}

// Cache for the deduplicated city pool (computed once per session).
let _majorCitiesDeduped = null;

/**
 * Returns MAJOR_CITIES with exact-coord duplicates removed. The raw list
 * includes metro variants like "Phoenix" + "Phoenix-Mesa" sharing coords;
 * these inflate findNearestCity's loop by 10 iterations + produce
 * inconsistent labels (first-match-wins order matters). Dedupe keeps the
 * first entry for each unique lat/lng pair — simpler, more predictable.
 */
function _dedupedMajorCities() {
  if (_majorCitiesDeduped) return _majorCitiesDeduped;
  const seen = new Set();
  const out = [];
  for (const c of MAJOR_CITIES) {
    const key = `${Number(c.lat).toFixed(4)},${Number(c.lng).toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  _majorCitiesDeduped = out;
  return out;
}

// ============================================================
// K-MEANS CLUSTERING (multi-facility)
// ============================================================

/**
 * Run weighted k-means clustering to find optimal locations for k facilities.
 * Runs `numRestarts` independent k-means trials and returns the lowest-cost
 * solution. Restart #0 uses the deterministic highest-weight init (legacy
 * behavior); restarts #1..N-1 use a seeded-PRNG k-means++ init so results
 * stay reproducible per input set while escaping local optima.
 *
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} k — number of centers
 * @param {number} [maxIter=100]
 * @param {number} [numRestarts=10] — set to 1 to recover legacy single-run behavior
 * @returns {import('./types.js?v=20260418-sP').MultiCogResult}
 */
export function kMeansCog(points, k = 1, maxIter = 100, numRestarts = 10, fixedCenters = []) {
  if (points.length === 0 || k <= 0) {
    return { centers: [], assignments: [], totalWeightedDistance: 0, iterations: 0, numRestarts: 0, lockedCount: 0 };
  }
  k = Math.min(k, points.length);
  const restarts = Math.max(1, Math.floor(numRestarts) || 1);
  // 2026-05-28 B9 — locked / required centers. fixedCenters list is
  // pre-seeded as the first N centers and never moved during iteration.
  const fixed = Array.isArray(fixedCenters) ? fixedCenters.filter(c => Number.isFinite(+c.lat) && Number.isFinite(+c.lng)) : [];
  const lockedCount = Math.min(fixed.length, k);
  if (lockedCount > 0 && k < lockedCount) k = lockedCount;

  // Seed the PRNG from a stable hash of the input — deterministic per
  // points/k pair, varies between datasets.
  const baseSeed = _pointsHash(points) ^ (k * 2654435761);

  let best = null;
  for (let r = 0; r < restarts; r++) {
    let initCenters;
    if (lockedCount > 0) {
      const lockedInits = fixed.slice(0, lockedCount).map(c => ({ lat: +c.lat, lng: +c.lng }));
      const remaining = k - lockedCount;
      let freeInits = [];
      if (remaining > 0) {
        freeInits = r === 0
          ? kMeansPlusPlusInit(points, remaining)
          : kMeansPlusPlusInitSeeded(points, remaining, _mulberry32((baseSeed + r * 0x9E3779B9) >>> 0));
      }
      initCenters = [...lockedInits, ...freeInits];
    } else {
      initCenters = r === 0
        ? kMeansPlusPlusInit(points, k)
        : kMeansPlusPlusInitSeeded(points, k, _mulberry32((baseSeed + r * 0x9E3779B9) >>> 0));
    }
    const trial = _kMeansSingleRun(points, k, maxIter, initCenters, lockedCount);
    if (!best || trial.totalWeightedDistance < best.totalWeightedDistance) best = trial;
  }
  best.numRestarts = restarts;
  best.lockedCount = lockedCount;
  return best;
}

/**
 * Single k-means run from a given set of initial centers. Pure inner loop —
 * the orchestrator above wraps this in multi-restart.
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} k
 * @param {number} maxIter
 * @param {{ lat: number, lng: number }[]} initCenters
 * @returns {import('./types.js?v=20260418-sP').MultiCogResult}
 */
function _kMeansSingleRun(points, k, maxIter, initCenters, lockedCount = 0) {
  let centers = initCenters.map(c => ({ lat: c.lat, lng: c.lng }));
  let assignments = [];
  let iter = 0;
  // P2-sweep fix (2026-04-22): centroid-delta convergence. The assignment-
  // only check stops only when every point's cluster is stable, but skips
  // the early-exit opportunity when centers have barely moved — common on
  // near-collinear point sets. Adding a small-movement threshold (1 mile
  // max per-center shift) lets k-means exit up to 10-20x faster on
  // well-separated demand with minimal accuracy loss.
  const CENTROID_DELTA_TOL_MI = 1.0;
  let prevCenters = null;

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

    // Check convergence — assignment stability OR centroid drift below tolerance
    const assignStable = assignments.length > 0 &&
      newAssignments.every((a, i) => a.clusterId === assignments[i].clusterId);
    const centroidStable = prevCenters &&
      centers.every((c, i) => haversine(c.lat, c.lng, prevCenters[i].lat, prevCenters[i].lng) < CENTROID_DELTA_TOL_MI);
    assignments = newAssignments;

    if (assignStable || centroidStable) break;

    // Recompute centers as weighted centroids of assigned points.
    // 2026-05-28 B9 — locked indices ([0, lockedCount)) skip the recompute.
    prevCenters = centers.map(c => ({ lat: c.lat, lng: c.lng }));
    centers = centers.map((_, ci) => {
      if (ci < lockedCount) return centers[ci]; // locked — never moves
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
 * COG-B2 — Snap each k-means center to the nearest user-supplied candidate
 * facility. Used when the analyst already has a fixed list of available
 * sites (existing 3PL footprint, M&A targets, REIT inventory) and wants
 * the optimizer to pick *from that list* rather than reporting a free-form
 * lat/lng. Returns a NEW MultiCogResult with centers swapped to candidates
 * and assignments / distances recomputed.
 *
 * @param {import('./types.js?v=20260418-sP').MultiCogResult} mcr — output of kMeansCog
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {Array<{ label?: string, lat: number, lng: number }>} candidates
 * @returns {import('./types.js?v=20260418-sP').MultiCogResult}
 */
export function snapCentersToCandidates(mcr, points, candidates) {
  const cleaned = (candidates || []).filter(c => Number.isFinite(+c.lat) && Number.isFinite(+c.lng));
  if (!mcr || !mcr.centers || mcr.centers.length === 0 || cleaned.length === 0) return mcr;

  // Pick one candidate per center, picking the closest unused candidate
  // first. If candidates < centers, allow reuse so we still return k
  // centers. If candidates > centers, drop the rest.
  // 2026-05-28 B9 — locked centers ([0, lockedCount)) skip the snap.
  const lockedCount = mcr.lockedCount || 0;
  const used = new Set();
  // Reserve locked candidates so free centers don't snap onto them.
  for (let lci = 0; lci < lockedCount; lci++) {
    const lc = mcr.centers[lci];
    if (!lc) continue;
    for (let i = 0; i < cleaned.length; i++) {
      if (Math.abs(+cleaned[i].lat - lc.lat) < 1e-6 && Math.abs(+cleaned[i].lng - lc.lng) < 1e-6) {
        used.add(i);
        break;
      }
    }
  }
  const snappedCenters = mcr.centers.map((c, ci) => {
    if (ci < lockedCount) {
      const match = cleaned.find(cd => Math.abs(+cd.lat - c.lat) < 1e-6 && Math.abs(+cd.lng - c.lng) < 1e-6);
      return { ...c, candidateLabel: (match && match.label) ? match.label : (c.nearestCity || `Locked ${ci + 1}`), locked: true };
    }
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < cleaned.length; i++) {
      if (used.has(i) && cleaned.length >= mcr.centers.length) continue;
      const d = haversine(c.lat, c.lng, +cleaned[i].lat, +cleaned[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx === -1) return c;
    used.add(bestIdx);
    const cand = cleaned[bestIdx];
    return { ...c, lat: +cand.lat, lng: +cand.lng, candidateLabel: cand.label || `Candidate ${bestIdx + 1}`, snappedFromLat: c.lat, snappedFromLng: c.lng };
  });

  // Recompute assignments + cluster KPIs against the snapped centers.
  const assignments = points.map(p => {
    let bestIdx = 0; let bestDist = Infinity;
    for (let i = 0; i < snappedCenters.length; i++) {
      const d = haversine(p.lat, p.lng, snappedCenters[i].lat, snappedCenters[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return { pointId: p.id, clusterId: bestIdx, distanceToCenter: bestDist };
  });

  // Refresh per-center KPIs (avg/max distance) using the snapped points.
  const refreshedCenters = snappedCenters.map((c, ci) => {
    const clusterPoints = points.filter((_, pi) => assignments[pi].clusterId === ci);
    if (clusterPoints.length === 0) return { ...c, totalWeight: 0, avgWeightedDistance: 0, maxDistance: 0, nearestCity: c.candidateLabel || findNearestCity(c.lat, c.lng) };
    const totalWeight = clusterPoints.reduce((s, p) => s + Math.max(0, p.weight), 0);
    const distances = clusterPoints.map(p => ({ dist: haversine(c.lat, c.lng, p.lat, p.lng), weight: p.weight }));
    const weightedDistSum = distances.reduce((s, d) => s + d.dist * d.weight, 0);
    const avgWeightedDistance = totalWeight > 0 ? weightedDistSum / totalWeight : 0;
    const maxDistance = Math.max(0, ...distances.map(d => d.dist));
    const maxWeightedDistance = Math.max(0, ...distances.filter(d => d.weight > 0).map(d => d.dist));
    return { ...c, totalWeight, avgWeightedDistance, maxDistance, maxWeightedDistance, nearestCity: c.candidateLabel || findNearestCity(c.lat, c.lng) };
  });

  const totalWeightedDistance = assignments.reduce((s, a) => {
    const pt = points.find(p => p.id === a.pointId);
    return s + a.distanceToCenter * (pt?.weight || 0);
  }, 0);

  return {
    centers: refreshedCenters,
    assignments,
    totalWeightedDistance,
    iterations: mcr.iterations,
    snappedToCandidates: true,
    lockedCount: mcr.lockedCount || 0,
  };
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

  // P2-sweep fix (2026-04-22): use distance² × weight for subsequent seeds.
  // The original `minDist × weight` under-weights far-away heavy clusters —
  // standard k-means++ uses squared distance so the seed prefers geometric
  // spread. Combining with weight keeps the importance-sampling bias toward
  // high-demand points but no longer penalizes far outliers.
  while (centers.length < k) {
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < points.length; i++) {
      const minDist = Math.min(...centers.map(c => haversine(points[i].lat, points[i].lng, c.lat, c.lng)));
      const score = minDist * minDist * (points[i].weight || 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    centers.push({ lat: points[bestIdx].lat, lng: points[bestIdx].lng });
  }

  return centers;
}

// ============================================================
// MULTI-RESTART HELPERS (2026-05-28)
// ============================================================

/**
 * Stable hash of a points array — deterministic seed for the multi-restart
 * PRNG. Order-independent: sums per-point hash contributions so the same
 * point set in different order produces the same seed.
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @returns {number}
 */
function _pointsHash(points) {
  let h = 2166136261 >>> 0;  // FNV-1a basis
  for (const p of points) {
    // Combine lat / lng / weight into 32-bit chunks.
    const a = Math.floor((p.lat || 0) * 10000);
    const b = Math.floor((p.lng || 0) * 10000);
    const c = Math.floor(p.weight || 0);
    h = ((h ^ a) * 16777619) >>> 0;
    h = ((h ^ b) * 16777619) >>> 0;
    h = ((h ^ c) * 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32 PRNG — small, fast, well-behaved 32-bit generator.
 * @param {number} seed
 * @returns {() => number} — returns floats in [0, 1)
 */
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * k-means++ initialization driven by a supplied PRNG. First center is
 * picked with weighted-random selection (probability ∝ weight) instead
 * of always taking the heaviest point — that's what escapes the local
 * optimum the deterministic init falls into.
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} k
 * @param {() => number} rng
 * @returns {{ lat: number, lng: number }[]}
 */
export function kMeansPlusPlusInitSeeded(points, k, rng) {
  if (points.length === 0) return [];
  if (k >= points.length) return points.map(p => ({ lat: p.lat, lng: p.lng }));

  const centers = [];

  // First center: weighted-random pick (probability ∝ weight) using `rng`.
  const totalW = points.reduce((s, p) => s + Math.max(0, p.weight || 0), 0);
  let firstIdx = 0;
  if (totalW > 0) {
    let r = rng() * totalW;
    for (let i = 0; i < points.length; i++) {
      r -= Math.max(0, points[i].weight || 0);
      if (r <= 0) { firstIdx = i; break; }
    }
  } else {
    firstIdx = Math.floor(rng() * points.length);
  }
  centers.push({ lat: points[firstIdx].lat, lng: points[firstIdx].lng });

  // Subsequent centers: weighted-random by (distance² × weight). Standard
  // k-means++ sampling, not deterministic max-pick, so different restarts
  // explore different seedings.
  while (centers.length < k) {
    const scores = points.map(p => {
      const minDist = Math.min(...centers.map(c => haversine(p.lat, p.lng, c.lat, c.lng)));
      return minDist * minDist * Math.max(0, p.weight || 0);
    });
    const totalScore = scores.reduce((s, x) => s + x, 0);
    let pickIdx = 0;
    if (totalScore > 0) {
      let r = rng() * totalScore;
      for (let i = 0; i < scores.length; i++) {
        r -= scores[i];
        if (r <= 0) { pickIdx = i; break; }
      }
    } else {
      pickIdx = Math.floor(rng() * points.length);
    }
    centers.push({ lat: points[pickIdx].lat, lng: points[pickIdx].lng });
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
// MODE-MIX (B3 — 2026-05-28)
// ============================================================

/**
 * Compute the effective $/truck-mi from a mode mix + per-mode rates.
 * Mode shares are normalized to sum to 100 (so 70/30/0 and 70/30 both work).
 * @param {{ tlPct?: number, ltlPct?: number, parcelPct?: number }} modeMix
 * @param {{ tlPerMile?: number, ltlPerMile?: number, parcelPerMile?: number }} modeRates
 * @returns {number}
 */
export function effectiveCpm(modeMix, modeRates) {
  const tlPct     = Math.max(0, +modeMix?.tlPct     || 0);
  const ltlPct    = Math.max(0, +modeMix?.ltlPct    || 0);
  const parcelPct = Math.max(0, +modeMix?.parcelPct || 0);
  const sum = tlPct + ltlPct + parcelPct;
  if (sum <= 0) return 0;
  const tlR     = +modeRates?.tlPerMile     || 0;
  const ltlR    = +modeRates?.ltlPerMile    || 0;
  const parcelR = +modeRates?.parcelPerMile || 0;
  return (tlPct * tlR + ltlPct * ltlR + parcelPct * parcelR) / sum;
}

/**
 * 2026-05-28 — Formula-adjusted blended $/mi. Same shape as effectiveCpm
 * but pre-divides the PARCEL portion by road × rt so that when the
 * standard cost formula multiplies by road × rt later, the parcel side
 * cancels back to its raw all-in rate (no road/rt applied).
 *
 * Why: parcel pricing is door-to-door zone-priced (UPS/FedEx 6lb @ Z5 ≈
 * $18 all-in including ~25% fuel + residential). The road-factor
 * (great-circle → road) and round-trip multipliers exist because TL/LTL
 * pay per-loaded-mile and have to account for empty backhaul; neither
 * physically applies to a parcel shipment. Brock caught this 2026-05-28
 * — the original effectiveCpm overstated parcel cost by road × rt ≈ 2.44×.
 *
 * Math:
 *   nonParcel = (tlPct × tlRate + ltlPct × ltlRate) / sum    ← gets road×rt
 *   parcel    = (parcelPct × parcelRate) / sum               ← bypasses road×rt
 *   formula_cpm = nonParcel + parcel / (road × rt)
 *
 * Then in the standard formula: truckloads × dist × formula_cpm × road × rt
 *   = truckloads × dist × (nonParcel × road × rt + parcel)
 *   = correct mode-aware total.
 *
 * Known limitation: tornadoSensitivity holds cpm at baseline while
 * sweeping road/rt; with the bypass, the parcel slice of cpm depends
 * on baseline road/rt, so road/rt-row swings on the tornado are slightly
 * understated when parcel share > 0. For 100% TL/LTL the tornado is
 * exact. Acceptable for v1; address if SDs hit it.
 *
 * @param {{ tlPct?: number, ltlPct?: number, parcelPct?: number }} modeMix
 * @param {{ tlPerMile?: number, ltlPerMile?: number, parcelPerMile?: number }} modeRates
 * @param {number} [roadFactor=1.22]
 * @param {number} [rt=2.0]
 * @returns {number}
 */
export function effectiveCpmForFormula(modeMix, modeRates, roadFactor = DEFAULT_ROAD_FACTOR, rt = 2.0) {
  const tlPct     = Math.max(0, +modeMix?.tlPct     || 0);
  const ltlPct    = Math.max(0, +modeMix?.ltlPct    || 0);
  const parcelPct = Math.max(0, +modeMix?.parcelPct || 0);
  const sum = tlPct + ltlPct + parcelPct;
  if (sum <= 0) return 0;
  const tlR     = +modeRates?.tlPerMile     || 0;
  const ltlR    = +modeRates?.ltlPerMile    || 0;
  const parcelR = +modeRates?.parcelPerMile || 0;
  const road = Math.max(1, +roadFactor || 1);
  const rtF  = Math.max(1, +rt || 1);
  return (tlPct * tlR + ltlPct * ltlR) / sum
       + (parcelPct * parcelR) / (sum * road * rtF);
}

// ============================================================
// SERVICE-LEVEL FLAGGING (B7 — 2026-05-28)
// ============================================================

/**
 * Mutates `mcr.assignments` in place to add per-assignment fields:
 *   - driveRoadMi: distanceToCenter * roadFactor (one-way road miles)
 *   - outOfService: true when driveRoadMi exceeds maxMiles
 * Returns aggregate coverage stats so the UI can render a single KPI.
 *
 * maxMiles <= 0 disables the check (everyone is in service).
 *
 * @param {import('./types.js?v=20260418-sP').MultiCogResult} mcr
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} maxMiles
 * @param {number} roadFactor
 * @returns {{ maxMiles: number, coveredWeight: number, outWeight: number, coveragePct: number, coveredCount: number, outCount: number }}
 */
export function flagServiceViolations(mcr, points, maxMiles = 0, roadFactor = DEFAULT_ROAD_FACTOR) {
  const stats = { maxMiles: maxMiles || 0, coveredWeight: 0, outWeight: 0, coveragePct: 100, coveredCount: 0, outCount: 0 };
  if (!mcr || !Array.isArray(mcr.assignments)) return stats;
  const road = Math.max(1, +roadFactor || 1);
  const disabled = !(maxMiles > 0);
  for (const a of mcr.assignments) {
    const driveMi = (a.distanceToCenter || 0) * road;
    a.driveRoadMi = driveMi;
    a.outOfService = disabled ? false : (driveMi > maxMiles);
    const pt = points.find(p => p.id === a.pointId);
    const w = pt?.weight || 0;
    if (a.outOfService) { stats.outWeight += w; stats.outCount += 1; }
    else { stats.coveredWeight += w; stats.coveredCount += 1; }
  }
  const totalW = stats.coveredWeight + stats.outWeight;
  stats.coveragePct = totalW > 0 ? (stats.coveredWeight / totalW * 100) : 100;
  // Stamp summary on the result so renderAnalysis / chrome KPI can pull it.
  mcr.serviceStats = stats;
  return stats;
}

// ============================================================
// CAPACITY CONSTRAINTS (B6 — 2026-05-28)
// ============================================================

/**
 * Post-solve capacity walk. Mutates `mcr.assignments` in place to move
 * demand from over-capacity clusters to nearest under-capacity clusters
 * until everyone is within cap (or no under-cap cluster exists, in which
 * case `stillOver` is true). Stamps mcr.capacityStats with utilization
 * per cluster + aggregate. capacityPerDC <= 0 disables the walk and just
 * reports utilization at 0 cap (so UI can show '— no cap' state).
 *
 * Algorithm: while any cluster exceeds cap and iter < 50, take the worst-
 * overflowing cluster's farthest-assigned point (by haversine — most
 * expensive to keep) and reassign it to the nearest under-cap cluster.
 *
 * @param {import('./types.js?v=20260418-sP').MultiCogResult} mcr
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} capacityPerDC
 * @returns {{ capacityPerDC: number, perCluster: Array<{assignedWeight:number, utilization:number, overWeight:number}>, totalOverflow:number, reassignmentCount:number, stillOver:boolean, peakUtilization:number }}
 */
export function applyCapacityConstraints(mcr, points, capacityPerDC = 0) {
  const k = mcr?.centers?.length || 0;
  const stats = { capacityPerDC: capacityPerDC || 0, perCluster: [], totalOverflow: 0, reassignmentCount: 0, stillOver: false, peakUtilization: 0 };
  if (!mcr || !Array.isArray(mcr.assignments) || k === 0) {
    mcr && (mcr.capacityStats = stats);
    return stats;
  }
  // Build weight + index per assignment for fast iteration.
  const ptById = new Map(points.map(p => [p.id, p]));
  // Re-init cluster weights from current assignments.
  const clusterWeight = new Array(k).fill(0);
  for (const a of mcr.assignments) {
    const w = ptById.get(a.pointId)?.weight || 0;
    clusterWeight[a.clusterId] += w;
  }
  const cap = capacityPerDC > 0 ? capacityPerDC : Infinity;
  let iter = 0;
  const MAX_ITER = 50;
  while (cap !== Infinity && iter < MAX_ITER) {
    // Find worst overflower.
    let worstCi = -1;
    let worstOver = 0;
    for (let i = 0; i < k; i++) {
      const over = clusterWeight[i] - cap;
      if (over > worstOver) { worstOver = over; worstCi = i; }
    }
    if (worstCi < 0) break;  // no overflow
    // Within the worst cluster, take the farthest-assigned point (by haversine).
    let farIdx = -1;
    let farDist = -1;
    for (let i = 0; i < mcr.assignments.length; i++) {
      if (mcr.assignments[i].clusterId !== worstCi) continue;
      if (mcr.assignments[i].distanceToCenter > farDist) { farDist = mcr.assignments[i].distanceToCenter; farIdx = i; }
    }
    if (farIdx < 0) break;
    // Find the nearest under-cap cluster for that point.
    const pt = ptById.get(mcr.assignments[farIdx].pointId);
    if (!pt) break;
    let destCi = -1;
    let destDist = Infinity;
    for (let i = 0; i < k; i++) {
      if (i === worstCi) continue;
      if (clusterWeight[i] >= cap) continue;
      const d = haversine(pt.lat, pt.lng, mcr.centers[i].lat, mcr.centers[i].lng);
      if (d < destDist) { destDist = d; destCi = i; }
    }
    if (destCi < 0) { stats.stillOver = true; break; }  // every cluster full
    // Reassign.
    clusterWeight[worstCi] -= (pt.weight || 0);
    clusterWeight[destCi] += (pt.weight || 0);
    mcr.assignments[farIdx].clusterId = destCi;
    mcr.assignments[farIdx].distanceToCenter = destDist;
    mcr.assignments[farIdx].reassigned = true;
    stats.reassignmentCount += 1;
    iter += 1;
  }
  // Compute final per-cluster stats.
  let total = 0;
  for (let i = 0; i < k; i++) {
    const w = clusterWeight[i];
    const over = cap === Infinity ? 0 : Math.max(0, w - cap);
    const util = cap === Infinity ? 0 : (w / cap * 100);
    stats.perCluster.push({ assignedWeight: w, utilization: util, overWeight: over });
    total += over;
    if (util > stats.peakUtilization) stats.peakUtilization = util;
  }
  stats.totalOverflow = total;
  // Refresh per-center summary fields since assignments may have moved.
  for (let ci = 0; ci < k; ci++) {
    const clusterPoints = points.filter(p => {
      const aIdx = mcr.assignments.findIndex(a => a.pointId === p.id);
      return aIdx >= 0 && mcr.assignments[aIdx].clusterId === ci;
    });
    if (clusterPoints.length === 0) {
      mcr.centers[ci].totalWeight = 0;
      continue;
    }
    const tw = clusterPoints.reduce((s, p) => s + Math.max(0, p.weight || 0), 0);
    const distances = clusterPoints.map(p => ({ dist: haversine(mcr.centers[ci].lat, mcr.centers[ci].lng, p.lat, p.lng), weight: p.weight || 0 }));
    const wdSum = distances.reduce((s, d) => s + d.dist * d.weight, 0);
    mcr.centers[ci].totalWeight = tw;
    mcr.centers[ci].avgWeightedDistance = tw > 0 ? wdSum / tw : 0;
    mcr.centers[ci].maxDistance = Math.max(0, ...distances.map(d => d.dist));
  }
  // Recompute totalWeightedDistance.
  mcr.totalWeightedDistance = mcr.assignments.reduce((s, a) => {
    const p = ptById.get(a.pointId);
    return s + a.distanceToCenter * (p?.weight || 0);
  }, 0);
  mcr.capacityStats = stats;
  return stats;
}

// ============================================================
// NETWORK-FROM-DC-LIST (E2 benchmark — 2026-05-28)
// ============================================================

/**
 * Build a MultiCogResult-shaped object from a fixed list of DCs. Each
 * demand point gets assigned to its nearest DC by haversine. Per-center
 * KPIs (totalWeight, avgWeightedDistance, maxDistance) are computed so
 * the result drops straight into estimateTransportCost + flagServiceViolations.
 *
 * Used by the vs-current-state benchmark on the Analysis tab — you can
 * pass a customer's existing DCs through the same math the optimizer ran
 * on the proposed network, then diff the outputs.
 *
 * @param {Array<{ label?: string, lat: number, lng: number }>} dcs
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @returns {import('./types.js?v=20260418-sP').MultiCogResult|null}
 */
export function buildMcrFromDcList(dcs, points) {
  const live = (points || []).filter(p => p && p.type !== 'excluded' && p.lat != null && p.lng != null);
  const cleaned = (dcs || []).filter(d => Number.isFinite(+d.lat) && Number.isFinite(+d.lng));
  if (cleaned.length === 0 || live.length === 0) return null;

  // Assign each point to nearest DC.
  const assignments = live.map(p => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < cleaned.length; i++) {
      const d = haversine(p.lat, p.lng, +cleaned[i].lat, +cleaned[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return { pointId: p.id, clusterId: bestIdx, distanceToCenter: bestDist };
  });

  // Build per-center summary.
  const centers = cleaned.map((dc, ci) => {
    const clusterPts = live.filter((_, pi) => assignments[pi].clusterId === ci);
    if (clusterPts.length === 0) {
      return {
        lat: +dc.lat, lng: +dc.lng,
        totalWeight: 0, avgWeightedDistance: 0, maxDistance: 0,
        nearestCity: dc.label || findNearestCity(+dc.lat, +dc.lng),
        candidateLabel: dc.label || null,
      };
    }
    const tw = clusterPts.reduce((s, p) => s + Math.max(0, p.weight || 0), 0);
    const dists = clusterPts.map(p => ({ dist: haversine(+dc.lat, +dc.lng, p.lat, p.lng), weight: p.weight || 0 }));
    const wdSum = dists.reduce((s, d) => s + d.dist * d.weight, 0);
    return {
      lat: +dc.lat, lng: +dc.lng,
      totalWeight: tw,
      avgWeightedDistance: tw > 0 ? wdSum / tw : 0,
      maxDistance: Math.max(0, ...dists.map(d => d.dist)),
      nearestCity: dc.label || findNearestCity(+dc.lat, +dc.lng),
      candidateLabel: dc.label || null,
    };
  });

  const totalWeightedDistance = assignments.reduce((s, a) => {
    const p = live.find(x => x.id === a.pointId);
    return s + a.distanceToCenter * (p?.weight || 0);
  }, 0);

  return { centers, assignments, totalWeightedDistance, iterations: 0, isCurrentState: true };
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
export function estimateTransportCost(cogResult, points, costPerMile = DEFAULT_TL_RATE_PER_MILE, unitsPerTruck = 25000, roundTripFactor = 2.0, roadFactor = DEFAULT_ROAD_FACTOR) {
  const capacity = Math.max(1, unitsPerTruck || 1); // guard against /0
  // 2026-05-26 — Round-trip factor. Distances in cogResult.assignments are
  // one-way; carrier pricing includes the return leg. Default 2.0 = full
  // round-trip (no backhaul recovery). Conservative inputs (1.5-1.8) can
  // be used if a network has reliable backhaul revenue.
  const rt = Math.max(1, +roundTripFactor || 1);
  // 2026-05-28 — Road-mile factor. Haversine returns great-circle;
  // carriers pay for road miles. Default 1.22 = continental US average.
  // Set to 1.0 to recover legacy great-circle math.
  const road = Math.max(1, +roadFactor || 1);
  const costByCluster = cogResult.centers.map((_, ci) => {
    return cogResult.assignments
      .filter(a => a.clusterId === ci)
      .reduce((s, a) => {
        const pt = points.find(p => p.id === a.pointId);
        const w = pt?.weight || 0;
        const truckloads = w / capacity;
        return s + truckloads * a.distanceToCenter * road * costPerMile * rt;
      }, 0);
  });

  const totalCost = costByCluster.reduce((s, c) => s + c, 0);
  // 2026-05-28 — exclude type='excluded' / null-coord rows from the
  // denominator. They live in points[] so the user can see them in the
  // table, but they contribute zero to numerator (filtered by the
  // assignments loop above). Including them in the denominator made
  // avgCostPerUnit and totalTruckloads read systematically low when an
  // upload had unresolved rows.
  const activeWeight = points.reduce((s, p) => {
    if (p && p.type !== 'excluded' && p.lat != null && p.lng != null) {
      return s + (p.weight || 0);
    }
    return s;
  }, 0);
  const avgCostPerUnit = activeWeight > 0 ? totalCost / activeWeight : 0;
  const totalTruckloads = activeWeight / capacity;

  // 2026-05-28 B20 — total truck-miles (rt + road already baked in via
  // costByCluster math). Reconstruct from totalCost / cpm when cpm > 0;
  // when cpm is 0, derive directly from the per-leg loop. Simpler: sum
  // truckloads × distance × road × rt across assignments.
  const totalTruckMiles = cogResult.centers.reduce((sum, _, ci) => {
    return sum + cogResult.assignments
      .filter(a => a.clusterId === ci)
      .reduce((s, a) => {
        const pt = points.find(p => p.id === a.pointId);
        const w = pt?.weight || 0;
        return s + (w / capacity) * a.distanceToCenter * road * rt;
      }, 0);
  }, 0);

  return { totalCost, avgCostPerUnit, costByCluster, totalTruckloads, totalTruckMiles };
}

// ============================================================
// TORNADO SENSITIVITY (multi-variable, B15 — 2026-05-28)
// ============================================================

/**
 * Multi-variable tornado sensitivity. For each driver in `drivers`,
 * sweeps its value to (baseline * (1 - delta)) and (baseline * (1 + delta)),
 * recomputes totalCost using estimateTransportCost on the supplied
 * cogResult, and returns one row per driver with low / high / swing.
 * Rows are returned sorted by absolute swing descending — same shape
 * a tornado chart expects.
 *
 * Drivers default to the cost-relevant config knobs; caller can override
 * by passing a subset. demandTotal sweeps by scaling all point weights
 * uniformly — the only driver that mutates input shape; others just
 * change scalar config values.
 *
 * @param {import('./types.js?v=20260418-sP').MultiCogResult} mcr
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {Object} cfg — baseline config (transportCostPerMile, roadFactor, etc.)
 * @param {Array<{ key: string, label: string, baseline: number, deltaPct: number }>} [drivers]
 * @returns {Array<{ key: string, label: string, baseline: number, deltaPct: number, lowVal: number, highVal: number, lowCost: number, highCost: number, baselineCost: number, swing: number }>}
 */
export function tornadoSensitivity(mcr, points, cfg, drivers) {
  if (!mcr || !Array.isArray(mcr.centers) || !Array.isArray(mcr.assignments)) return [];
  const liveCfg = cfg || {};
  // 2026-05-29 — parcel-aware tornado. When the scenario uses the parcel
  // engine, route cost through estimateBlendedCost so per-package zone-
  // priced math participates in the swing. Previously the tornado held
  // the parcel cost constant (it used estimateTransportCost only), which
  // dramatically understated the cost-impact of fuel %, contract %, DIM,
  // accessorials, and parcel-share swings — i.e. all the levers a parcel-
  // heavy customer actually negotiates.
  const parcelOn = !!liveCfg.modeMixEnabled && (liveCfg.modeMix?.parcelPct || 0) > 0;

  // Helper: cost at supplied param overrides. When parcel-on, runs
  // estimateBlendedCost with a shallow-merged config; otherwise legacy
  // estimateTransportCost path (preserves pre-parcel behavior).
  function costAt(overrides) {
    const pts = overrides.points || points;
    if (parcelOn) {
      const overlay = { ...liveCfg };
      if (overrides.cpm != null) overlay.transportCostPerMile = overrides.cpm;
      if (overrides.rt != null)  overlay.roundTripFactor = overrides.rt;
      if (overrides.road != null) overlay.roadFactor = overrides.road;
      if (overrides.cap != null) overlay.unitsPerTruck = overrides.cap;
      if (overrides.fuelPct != null) overlay.parcelFuelPct = overrides.fuelPct;
      if (overrides.discountPct != null) overlay.parcelContractDiscountPct = overrides.discountPct;
      if (overrides.dimMultiplier != null) overlay.parcelDimMultiplier = overrides.dimMultiplier;
      if (overrides.accessorialsPerPkg != null) overlay.parcelAccessorialsPerPkg = overrides.accessorialsPerPkg;
      if (overrides.parcelPct != null) {
        const m = liveCfg.modeMix || { tlPct: 100, ltlPct: 0, parcelPct: 0 };
        const otherShare = Math.max(0, 100 - overrides.parcelPct);
        const tlOrig = Math.max(0, +m.tlPct || 0);
        const ltlOrig = Math.max(0, +m.ltlPct || 0);
        const denom = tlOrig + ltlOrig;
        // Hold the TL:LTL ratio constant while sweeping parcel share.
        const tlNew = denom > 0 ? (otherShare * (tlOrig / denom)) : otherShare;
        const ltlNew = denom > 0 ? (otherShare * (ltlOrig / denom)) : 0;
        overlay.modeMix = { tlPct: tlNew, ltlPct: ltlNew, parcelPct: overrides.parcelPct };
      }
      const r = estimateBlendedCost(mcr, pts, overlay);
      return r.totalCost || 0;
    }
    const cpm = overrides.cpm != null ? overrides.cpm : liveCfg.transportCostPerMile;
    const rt  = overrides.rt  != null ? overrides.rt  : (liveCfg.roundTripFactor ?? 2.0);
    const road = overrides.road != null ? overrides.road : (liveCfg.roadFactor ?? DEFAULT_ROAD_FACTOR);
    const cap = overrides.cap != null ? overrides.cap : (liveCfg.unitsPerTruck || 25000);
    return estimateTransportCost(mcr, pts, cpm, cap, rt, road).totalCost;
  }

  const baselineCost = costAt({});

  // Default driver set — parcel scenarios get additional drivers for the
  // knobs that actually move parcel cost. Truck-only scenarios keep the
  // original 4-driver set (back-compat).
  const baseCpm = +liveCfg.transportCostPerMile || 0;
  const baseRoad = +(liveCfg.roadFactor ?? DEFAULT_ROAD_FACTOR);
  const baseRt = +(liveCfg.roundTripFactor ?? 2.0);
  let allDrivers = drivers;
  if (!allDrivers) {
    allDrivers = [
      { key: 'transportCostPerMile', label: '$/mi',              baseline: baseCpm, deltaPct: 20 },
      { key: 'roundTripFactor',      label: 'Round-trip factor', baseline: baseRt,  deltaPct: 15 },
      { key: 'roadFactor',           label: 'Road factor',       baseline: baseRoad,deltaPct: 10 },
      { key: 'demandTotal',          label: 'Total demand',      baseline: 100,     deltaPct: 20 },
    ];
    if (parcelOn) {
      const baseFuel = liveCfg.parcelFuelPct == null ? 25 : +liveCfg.parcelFuelPct;
      const baseDisc = liveCfg.parcelContractDiscountPct == null ? 0 : +liveCfg.parcelContractDiscountPct;
      const baseDim  = liveCfg.parcelDimMultiplier == null ? 1.0 : +liveCfg.parcelDimMultiplier;
      const baseAcc  = liveCfg.parcelAccessorialsPerPkg == null ? 0 : +liveCfg.parcelAccessorialsPerPkg;
      const baseParcelPct = +(liveCfg.modeMix?.parcelPct || 0);
      allDrivers.push({ key: 'parcelFuelPct',           label: 'Parcel fuel %',         baseline: baseFuel,      deltaPct: 30 });
      allDrivers.push({ key: 'parcelPct',               label: 'Parcel share of mix',   baseline: baseParcelPct, deltaPct: 25 });
      if (baseDisc > 0) {
        allDrivers.push({ key: 'parcelContractDiscountPct', label: 'Parcel contract discount %', baseline: baseDisc, deltaPct: 25 });
      }
      if (baseDim > 1) {
        allDrivers.push({ key: 'parcelDimMultiplier', label: 'DIM weight multiplier', baseline: baseDim, deltaPct: 15 });
      }
      if (baseAcc > 0) {
        allDrivers.push({ key: 'parcelAccessorialsPerPkg', label: 'Parcel accessorials $/pkg', baseline: baseAcc, deltaPct: 30 });
      }
    }
  }

  const out = [];
  for (const d of allDrivers) {
    const lowVal = d.baseline * (1 - d.deltaPct / 100);
    const highVal = d.baseline * (1 + d.deltaPct / 100);
    let lowCost, highCost;
    if (d.key === 'demandTotal') {
      const lowFactor = 1 - d.deltaPct / 100;
      const highFactor = 1 + d.deltaPct / 100;
      const lowPts = points.map(p => ({ ...p, weight: (p.weight || 0) * lowFactor }));
      const highPts = points.map(p => ({ ...p, weight: (p.weight || 0) * highFactor }));
      lowCost = costAt({ points: lowPts });
      highCost = costAt({ points: highPts });
    } else if (d.key === 'transportCostPerMile') {
      lowCost = costAt({ cpm: lowVal });
      highCost = costAt({ cpm: highVal });
    } else if (d.key === 'roundTripFactor') {
      lowCost = costAt({ rt: lowVal });
      highCost = costAt({ rt: highVal });
    } else if (d.key === 'roadFactor') {
      lowCost = costAt({ road: lowVal });
      highCost = costAt({ road: highVal });
    } else if (d.key === 'parcelFuelPct') {
      lowCost = costAt({ fuelPct: lowVal });
      highCost = costAt({ fuelPct: highVal });
    } else if (d.key === 'parcelContractDiscountPct') {
      lowCost = costAt({ discountPct: Math.max(0, lowVal) });
      highCost = costAt({ discountPct: Math.max(0, highVal) });
    } else if (d.key === 'parcelDimMultiplier') {
      lowCost = costAt({ dimMultiplier: Math.max(1, lowVal) });
      highCost = costAt({ dimMultiplier: Math.max(1, highVal) });
    } else if (d.key === 'parcelAccessorialsPerPkg') {
      lowCost = costAt({ accessorialsPerPkg: Math.max(0, lowVal) });
      highCost = costAt({ accessorialsPerPkg: Math.max(0, highVal) });
    } else if (d.key === 'parcelPct') {
      lowCost = costAt({ parcelPct: Math.max(0, Math.min(100, lowVal)) });
      highCost = costAt({ parcelPct: Math.max(0, Math.min(100, highVal)) });
    } else {
      lowCost = baselineCost;
      highCost = baselineCost;
    }
    out.push({
      key: d.key,
      label: d.label,
      baseline: d.baseline,
      deltaPct: d.deltaPct,
      lowVal, highVal,
      lowCost, highCost,
      baselineCost,
      swing: Math.abs(highCost - lowCost),
    });
  }

  out.sort((a, b) => b.swing - a.swing);
  return out;
}

// ============================================================
// BLENDED COST (TL + LTL via per-mile + parcel via per-package)
// ============================================================

/**
 * Orchestration helper — when mode-mix is off, behaves identically to
 * estimateTransportCost (passthrough). When on, splits each point's
 * weight by mode share. TL+LTL slice routes through estimateTransportCost
 * at the (TL+LTL)-only blended \$/mi. Parcel slice routes through
 * estimateParcelLane per assignment (proper per-package zone math).
 *
 * @param {import('./types.js?v=20260418-sP').MultiCogResult} cogResult
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {Object} config
 * @returns {Object}
 */
export function estimateBlendedCost(cogResult, points, config) {
  const cfg = config || {};
  const unitsPerTruck = cfg.unitsPerTruck || 25000;
  const rt = cfg.roundTripFactor ?? 2.0;
  const road = cfg.roadFactor ?? DEFAULT_ROAD_FACTOR;

  if (!cfg.modeMixEnabled) {
    const r = estimateTransportCost(cogResult, points, cfg.transportCostPerMile, unitsPerTruck, rt, road);
    // 2026-05-28 30 — per-assignment cost array for UI display.
    const cbaOff = (cogResult.assignments || []).map(a => {
      const pt = points.find(p => p.id === a.pointId);
      const w = pt?.weight || 0;
      const tl = (w / unitsPerTruck) * (a.distanceToCenter || 0) * road * (cfg.transportCostPerMile || 0) * rt;
      return { pointId: a.pointId, clusterId: a.clusterId, truckCost: tl, parcelCost: 0, totalCost: tl, zone: null, pkgCount: 0 };
    });
    return {
      totalCost: r.totalCost,
      truckCost: r.totalCost,
      parcelCost: 0,
      costByCluster: r.costByCluster,
      truckCostByCluster: r.costByCluster,
      parcelCostByCluster: r.costByCluster.map(() => 0),
      costByAssignment: cbaOff,
      totalTruckloads: r.totalTruckloads,
      totalTruckMiles: r.totalTruckMiles,
      avgCostPerUnit: r.avgCostPerUnit,
      parcelDetails: null,
    };
  }

  const mix = cfg.modeMix || { tlPct: 100, ltlPct: 0, parcelPct: 0 };
  const sum = Math.max(0, +mix.tlPct || 0) + Math.max(0, +mix.ltlPct || 0) + Math.max(0, +mix.parcelPct || 0);
  if (sum <= 0) {
    return {
      totalCost: 0, truckCost: 0, parcelCost: 0,
      costByCluster: cogResult.centers.map(() => 0),
      truckCostByCluster: cogResult.centers.map(() => 0),
      parcelCostByCluster: cogResult.centers.map(() => 0),
      totalTruckloads: 0, totalTruckMiles: 0, avgCostPerUnit: 0,
      parcelDetails: null,
    };
  }
  const parcelShare = (Math.max(0, +mix.parcelPct || 0)) / sum;
  const nonParcelShare = 1 - parcelShare;

  const tlPct = Math.max(0, +mix.tlPct || 0);
  const ltlPct = Math.max(0, +mix.ltlPct || 0);
  const rates = cfg.modeRates || {};
  const tlR = +rates.tlPerMile || 0;
  const ltlR = +rates.ltlPerMile || 0;
  const nonParcelCpm = (tlPct + ltlPct) > 0 ? (tlPct * tlR + ltlPct * ltlR) / (tlPct + ltlPct) : 0;

  // 2026-05-28 31 — per-point parcel-share + avg-pkg-weight overrides.
  // Each demand point can override the scenario-level parcelPct via
  // point.parcelSharePct, and the scenario-level avgPackageWeightLb via
  // point.avgPackageWeightLb. This lets mixed-channel networks (B2B 100%
  // TL + DTC 100% parcel) model accurately, with per-shipment zone-priced
  // parcel rates.

  const defaultAvgWeight = +cfg.parcelAvgPackageWeightLb || 5;
  const fuelPct = cfg.parcelFuelPct == null ? 25 : +cfg.parcelFuelPct;
  const residentialShare = cfg.parcelResidentialShare == null ? 0.5 : +cfg.parcelResidentialShare;
  const discountPct = cfg.parcelContractDiscountPct == null ? 0 : +cfg.parcelContractDiscountPct;
  const carrier = cfg.parcelCarrier || 'fedex_ground';

  const parcelCostByCluster = cogResult.centers.map(() => 0);
  const truckCostByCluster  = cogResult.centers.map(() => 0);
  const byZone = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
  let totalParcelPkgs = 0;
  let totalParcelCost = 0;
  let totalTruckMilesAcc = 0;
  let totalTruckloadsAcc = 0;

  const perAssignmentParcel = [];
  const perAssignmentTruck = [];

  if (Array.isArray(cogResult.assignments)) {
    for (const a of cogResult.assignments) {
      const pt = points.find(p => p.id === a.pointId);
      if (!pt) {
        perAssignmentParcel.push({ cost: 0, zone: null, pkgCount: 0 });
        perAssignmentTruck.push(0);
        continue;
      }
      // Per-point overrides — fall back to scenario defaults when unset.
      const ptParcelShare = (pt.parcelSharePct != null && Number.isFinite(+pt.parcelSharePct))
        ? Math.max(0, Math.min(100, +pt.parcelSharePct)) / 100
        : parcelShare;
      const ptNonParcelShare = 1 - ptParcelShare;
      const ptAvgWeight = (pt.avgPackageWeightLb != null && Number.isFinite(+pt.avgPackageWeightLb) && +pt.avgPackageWeightLb > 0)
        ? +pt.avgPackageWeightLb
        : defaultAvgWeight;
      const driveMi = (a.distanceToCenter || 0) * road;

      // Truck slice — point-specific share.
      let truckCost = 0;
      if (ptNonParcelShare > 0 && nonParcelCpm > 0) {
        const wTruck = (pt.weight || 0) * ptNonParcelShare;
        const tl = wTruck / unitsPerTruck;
        truckCost = tl * (a.distanceToCenter || 0) * nonParcelCpm * road * rt;
        truckCostByCluster[a.clusterId] = (truckCostByCluster[a.clusterId] || 0) + truckCost;
        totalTruckMilesAcc += tl * (a.distanceToCenter || 0) * road * rt;
        totalTruckloadsAcc += tl;
      }
      perAssignmentTruck.push(truckCost);

      // Parcel slice — point-specific share + weight.
      if (ptParcelShare > 0 && ptAvgWeight > 0) {
        const parcelWeight = (pt.weight || 0) * ptParcelShare;
        // 2026-05-29 — unit-aware pkgCount. For count units (units,
        // orders, cases, pallets) each weight = 1 package. For lb,
        // divide by avg pkg weight. cwt × 100 before dividing.
        const pkgCount = packageCountFromWeight(parcelWeight, cfg.weightUnit || 'lb', ptAvgWeight, cfg.parcelPackagesPerUnit);
        const lane = estimateParcelLane({
          pkgCount, avgWeight: ptAvgWeight, distanceMi: driveMi,
          fuelPct, residentialShare, discountPct, carrier,
          serviceMix: cfg.parcelServiceMix,
          dimMultiplier: cfg.parcelDimMultiplier ?? 1.0,
          accessorialsPerPkg: cfg.parcelAccessorialsPerPkg ?? 0,
          discountTiers: cfg.parcelDiscountTiers,
        });
        parcelCostByCluster[a.clusterId] = (parcelCostByCluster[a.clusterId] || 0) + lane.totalCost;
        byZone[lane.zone] = (byZone[lane.zone] || 0) + pkgCount;
        totalParcelPkgs += pkgCount;
        totalParcelCost += lane.totalCost;
        perAssignmentParcel.push({ cost: lane.totalCost, zone: lane.zone, pkgCount });
      } else {
        perAssignmentParcel.push({ cost: 0, zone: null, pkgCount: 0 });
      }
    }
  }

  // Synthetic truckResult shape (downstream consumers expect this shape).
  const totalTruckCost = truckCostByCluster.reduce((s, x) => s + x, 0);
  const truckResult = {
    totalCost: totalTruckCost,
    costByCluster: truckCostByCluster,
    totalTruckloads: totalTruckloadsAcc,
    totalTruckMiles: totalTruckMilesAcc,
    avgCostPerUnit: 0,
  };

  const costByAssignment = (cogResult.assignments || []).map((a, i) => ({
    pointId: a.pointId,
    clusterId: a.clusterId,
    truckCost: perAssignmentTruck[i] || 0,
    parcelCost: perAssignmentParcel[i]?.cost || 0,
    totalCost: (perAssignmentTruck[i] || 0) + (perAssignmentParcel[i]?.cost || 0),
    zone: perAssignmentParcel[i]?.zone || null,
    pkgCount: perAssignmentParcel[i]?.pkgCount || 0,
  }));

  const totalCost = truckResult.totalCost + totalParcelCost;
  const activeWeight = points.reduce((s, p) => {
    if (p && p.type !== 'excluded' && p.lat != null && p.lng != null) return s + (p.weight || 0);
    return s;
  }, 0);
  const avgCostPerUnit = activeWeight > 0 ? totalCost / activeWeight : 0;
  const costByCluster = cogResult.centers.map((_, ci) => (truckResult.costByCluster[ci] || 0) + (parcelCostByCluster[ci] || 0));

  return {
    totalCost,
    truckCost: truckResult.totalCost,
    parcelCost: totalParcelCost,
    costByCluster,
    truckCostByCluster: truckResult.costByCluster,
    parcelCostByCluster,
    costByAssignment,
    totalTruckloads: truckResult.totalTruckloads,
    totalTruckMiles: truckResult.totalTruckMiles,
    avgCostPerUnit,
    parcelDetails: parcelShare > 0 ? {
      totalPackages: totalParcelPkgs,
      byZone, avgWeight: defaultAvgWeight, carrier,
      fuelPct, residentialShare, discountPct,
    } : null,
  };
}

// ============================================================
// UNIT-AWARE PACKAGE COUNT (2026-05-29)
// ============================================================

/**
 * Convert a demand-weight number into a package count. The original
 * parcel math assumed weight was always in pounds — pkgCount = weight /
 * avgPkgWeightLb. That's wrong for non-lb weight units:
 *   - 'units' / 'orders' / 'cases' / 'pallets' are COUNT units. Each one
 *     IS a package (or a parent-of-packages). Dividing by avgPkgWeightLb
 *     undercounts by a factor of ~5x at default settings.
 *   - 'cwt' is hundredweight (100 lb), so convert × 100 before dividing.
 *   - 'lb' is the legacy path: divide by avgPkgWeightLb.
 *   - 'revenue' has no mass relationship — user must override via
 *     parcelPackagesPerUnit, otherwise we assume 1:1.
 *
 * @param {number} weight — raw demand weight
 * @param {string} weightUnit — 'lb' | 'cwt' | 'pallets' | 'units' | 'cases' | 'orders' | 'revenue'
 * @param {number} avgPkgWeightLb — average package weight in lb
 * @param {number} [overrideRatio] — explicit packages-per-weight-unit override
 * @returns {number}
 */
export function packageCountFromWeight(weight, weightUnit, avgPkgWeightLb, overrideRatio) {
  const w = +weight || 0;
  if (w <= 0) return 0;
  if (Number.isFinite(+overrideRatio) && +overrideRatio > 0) {
    return w * +overrideRatio;
  }
  const apw = Math.max(0.1, +avgPkgWeightLb || 5);
  switch (weightUnit) {
    case 'lb':       return w / apw;
    case 'cwt':      return (w * 100) / apw;
    case 'pallets':  return w;
    case 'units':    return w;
    case 'cases':    return w;
    case 'orders':   return w;
    case 'revenue':  return w;
    default:         return w / apw;
  }
}

// ============================================================
// MULTI-YEAR PROJECTION (E3 — 2026-05-29)
// ============================================================

/**
 * Project baseline cost forward over the planning horizon.
 *
 * Year-n cost = baseCost × (1 + growth/100)^n × (1 + escalation/100)^n
 * (compounded jointly because volume + rate both compound on the same
 * base; a customer adding 5% volume each year while rates escalate 3%
 * lands at 1.08^n × base.)
 *
 * NPV discounts each future year back to year 1 at discountRatePct.
 *
 * @param {number} baseCost — Year-1 annual cost (e.g., cogResult.totalCost)
 * @param {Object} cfg — { analysisHorizonYears, annualGrowthPct, annualEscalationPct, discountRatePct }
 * @returns {{ years: Array<{year:number, cost:number, cumulative:number, npv:number}>, totalCost: number, totalNpv: number }}
 */
export function multiYearCostProjection(baseCost, cfg) {
  const horizon = Math.max(1, Math.min(20, +cfg?.analysisHorizonYears || 1));
  const growth = +cfg?.annualGrowthPct || 0;
  const escalation = +cfg?.annualEscalationPct || 0;
  const discount = +cfg?.discountRatePct || 0;
  const base = +baseCost || 0;

  const years = [];
  let cumulative = 0;
  let totalNpv = 0;
  for (let n = 0; n < horizon; n++) {
    const growthMult = Math.pow(1 + growth / 100, n);
    const escMult = Math.pow(1 + escalation / 100, n);
    const cost = base * growthMult * escMult;
    cumulative += cost;
    // NPV: year-1 cost is NOT discounted (occurs now); year-n is
    // discounted n-1 periods.
    const npvFactor = Math.pow(1 + discount / 100, n);
    const npv = cost / npvFactor;
    totalNpv += npv;
    years.push({ year: n + 1, cost, cumulative, npv });
  }
  return { years, totalCost: cumulative, totalNpv };
}

// ============================================================
// SENSITIVITY (vary number of centers)
// ============================================================

/**
 * Run COG analysis for k = 1..maxK and return a cost curve.
 *
 * If `fixedCostPerDC` > 0, each row's `totalCost` includes a
 * `k * fixedCostPerDC` facility term, producing a real U-curve with a true
 * cost-optimum k. If `fixedCostPerDC` = 0, the curve is transport-only and
 * monotonically non-increasing in k (legacy behavior).
 *
 * Each row exposes `transportCost`, `facilityCost`, `totalCost` so the UI
 * can render a stacked breakdown. `estimatedCost` is aliased to `totalCost`
 * for back-compat with existing chart code.
 *
 * @param {import('./types.js?v=20260418-sP').WeightedPoint[]} points
 * @param {number} maxK
 * @param {number} [costPerMile=2.85]
 * @param {number} [maxIter=100]
 * @param {number} [unitsPerTruck=25000]
 * @param {number} [fixedCostPerDC=0]  Annual fixed cost per facility ($/year).
 * @returns {Array<{ k: number, totalWeightedDistance: number, transportCost: number, facilityCost: number, totalCost: number, estimatedCost: number, avgDistance: number, isElbow?: boolean, isRecommended?: boolean }>}
 */
export function sensitivityAnalysis(points, maxK = 5, configOrCpm = DEFAULT_TL_RATE_PER_MILE, maxIter = 100, unitsPerTruck = 25000, fixedCostPerDC = 0, roundTripFactor = 2.0, roadFactor = DEFAULT_ROAD_FACTOR) {
  // 2026-05-28 — accept config object (new, parcel-aware) or scalar cpm (legacy).
  const isConfig = configOrCpm != null && typeof configOrCpm === 'object';
  const cfg = isConfig ? configOrCpm : {
    transportCostPerMile: configOrCpm,
    unitsPerTruck, roundTripFactor, roadFactor, modeMixEnabled: false,
  };
  const fixedTermBase = isConfig
    ? (Math.max(0, Number(cfg.fixedCostPerDC) || 0))
    : (Math.max(0, Number(fixedCostPerDC) || 0));
  const innerMaxIter = isConfig ? (cfg.maxIterations || 100) : maxIter;
  const innerRestarts = isConfig ? (cfg.kmeansRestarts ?? 10) : 10;

  const results = [];
  const effectiveMaxK = Math.min(maxK, points.length);
  const fixedTerm = fixedTermBase;

  for (let k = 1; k <= effectiveMaxK; k++) {
    const cogResult = kMeansCog(points, k, innerMaxIter, innerRestarts);
    const cost = estimateBlendedCost(cogResult, points, cfg);
    const totalWeight = points.reduce((s, p) => s + p.weight, 0);
    const avgDist = totalWeight > 0 ? cogResult.totalWeightedDistance / totalWeight : 0;
    const transportCost = cost.totalCost;
    const facilityCost = k * fixedTerm;
    const totalCost = transportCost + facilityCost;

    results.push({
      k,
      totalWeightedDistance: cogResult.totalWeightedDistance,
      transportCost,
      facilityCost,
      totalCost,
      estimatedCost: totalCost, // back-compat alias
      avgDistance: avgDist,
    });
  }

  // Detect knee point on the cost curve via the kneedle algorithm
  // (Satopaa et al. 2011): normalize x and y to [0,1], then find the point
  // furthest below the chord from (xMin, yStart) to (xMax, yEnd).
  //
  // Generalized form: works for monotonic-decreasing curves (transport-only,
  // fixedCostPerDC = 0) AND U-shaped curves (fixedCostPerDC > 0). For a
  // U-curve the chord from yStart to yEnd cuts above the dip, and the point
  // of maximum below-chord distance is the cost-optimal k. For a monotonic
  // curve the same calculation finds the elbow / max-curvature point.
  //
  // Guard: require the max chord-distance to exceed MIN_KNEE_GAP so a
  // near-linear curve doesn't get a meaningless flag.
  const MIN_KNEE_GAP = 0.05;
  if (results.length >= 3) {
    const N = results.length;
    const xMin = results[0].k;
    const xMax = results[N - 1].k;
    const ys = results.map(r => r.totalCost);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const xRange = (xMax - xMin) || 1;
    const yRange = (yMax - yMin) || 1;
    const yStart = (results[0].totalCost - yMin) / yRange;
    const yEnd = (results[N - 1].totalCost - yMin) / yRange;
    let bestIdx = -1;
    let bestDist = -Infinity;
    for (let i = 0; i < N; i++) {
      const xn = (results[i].k - xMin) / xRange;
      const yn = (results[i].totalCost - yMin) / yRange;
      // Chord at xn: y = yStart + xn * (yEnd - yStart). Below-chord distance:
      const chordY = yStart + xn * (yEnd - yStart);
      const dist = chordY - yn;
      if (dist > bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    // Mark the optimum only when it represents a meaningful pick:
    //   - Transport-only (fixedCostPerDC = 0): the curve is monotonically
    //     non-increasing, so the kneedle elbow is the diminishing-returns
    //     inflection — the canonical "knee" interpretation.
    //   - U-curve mode (fixedCostPerDC > 0): the curve has a real total-cost
    //     minimum. Use the GLOBAL MINIMUM directly rather than the kneedle —
    //     kneedle picks the point of maximum curvature, which on an
    //     asymmetric U sits one bar past the trough and would mis-direct
    //     the user. Only mark when the minimum is at an interior point;
    //     when fixed cost dominates and the optimum is k=1 (boundary),
    //     the marker is suppressed (the legend chip explains why).
    const hasFixedCostMode = fixedTerm > 0;
    const minIdxGlobal = ys.indexOf(yMin);
    const minIsInterior = minIdxGlobal > 0 && minIdxGlobal < N - 1;
    if (hasFixedCostMode) {
      if (minIsInterior) {
        results[minIdxGlobal].isElbow = true;
        results[minIdxGlobal].isRecommended = true; // 2026-06-10: consumers read isRecommended; isElbow kept for back-compat
      }
    } else {
      if (bestIdx > 0 && bestIdx < N - 1 && bestDist > MIN_KNEE_GAP) {
        results[bestIdx].isElbow = true;
        results[bestIdx].isRecommended = true; // 2026-06-10: consumers read isRecommended; isElbow kept for back-compat
      }
    }
  }

  return results;
}

// ============================================================
// DEMO DATA
// ============================================================

// ============================================================
// DEMAND ARCHETYPES
// ============================================================
// Pre-built demand distributions for common 3PL verticals. Analysts use these
// when customer data is sparse — pick an archetype and the tool generates a
// realistic set of weighted demand points so the COG solver has something to
// chew on. Weights are the archetype-specific unit share per metro; they
// scale to the user's total annual volume when the archetype is loaded.
//
// Regions: NE, SE, MW, SW, W — standard US Census divisions collapsed to 5.

/**
 * Master city/metro lookup table — used by archetype generator AND by the
 * Add-Point city/state typeahead. Expanded beyond the archetype anchor set
 * to cover the top ~125 US metros so analysts can quickly drop in major
 * demand centers by name.
 *
 * Each entry: { name, state, lat, lng, region }. When the Add-Point search
 * matches, lat/lng auto-populate. Name is shown first, then ", ST".
 */
export const CITY_CENTROIDS = [
  // Northeast
  { name: 'New York Metro',   state: 'NY', lat: 40.7128, lng: -74.0060, region: 'NE' },
  { name: 'Albany',           state: 'NY', lat: 42.6526, lng: -73.7562, region: 'NE' },
  { name: 'Buffalo',          state: 'NY', lat: 42.8864, lng: -78.8784, region: 'NE' },
  { name: 'Rochester',        state: 'NY', lat: 43.1566, lng: -77.6088, region: 'NE' },
  { name: 'Syracuse',         state: 'NY', lat: 43.0481, lng: -76.1474, region: 'NE' },
  { name: 'Philadelphia',     state: 'PA', lat: 39.9526, lng: -75.1652, region: 'NE' },
  { name: 'Pittsburgh',       state: 'PA', lat: 40.4406, lng: -79.9959, region: 'NE' },
  { name: 'Harrisburg',       state: 'PA', lat: 40.2732, lng: -76.8867, region: 'NE' },
  { name: 'Allentown',        state: 'PA', lat: 40.6084, lng: -75.4902, region: 'NE' },
  { name: 'Boston',           state: 'MA', lat: 42.3601, lng: -71.0589, region: 'NE' },
  { name: 'Worcester',        state: 'MA', lat: 42.2626, lng: -71.8023, region: 'NE' },
  { name: 'Springfield',      state: 'MA', lat: 42.1015, lng: -72.5898, region: 'NE' },
  { name: 'Providence',       state: 'RI', lat: 41.8240, lng: -71.4128, region: 'NE' },
  { name: 'Hartford',         state: 'CT', lat: 41.7658, lng: -72.6734, region: 'NE' },
  { name: 'New Haven',        state: 'CT', lat: 41.3083, lng: -72.9279, region: 'NE' },
  { name: 'Newark',           state: 'NJ', lat: 40.7357, lng: -74.1724, region: 'NE' },
  { name: 'Jersey City',      state: 'NJ', lat: 40.7178, lng: -74.0431, region: 'NE' },
  { name: 'Baltimore',        state: 'MD', lat: 39.2904, lng: -76.6122, region: 'NE' },
  { name: 'Washington DC',    state: 'DC', lat: 38.9072, lng: -77.0369, region: 'NE' },
  { name: 'Richmond',         state: 'VA', lat: 37.5407, lng: -77.4360, region: 'NE' },
  { name: 'Virginia Beach',   state: 'VA', lat: 36.8529, lng: -75.9780, region: 'NE' },
  { name: 'Portland',         state: 'ME', lat: 43.6591, lng: -70.2568, region: 'NE' },
  { name: 'Manchester',       state: 'NH', lat: 42.9956, lng: -71.4548, region: 'NE' },
  { name: 'Burlington',       state: 'VT', lat: 44.4759, lng: -73.2121, region: 'NE' },
  { name: 'Wilmington',       state: 'DE', lat: 39.7391, lng: -75.5398, region: 'NE' },
  // Southeast
  { name: 'Atlanta',          state: 'GA', lat: 33.7490, lng: -84.3880, region: 'SE' },
  { name: 'Savannah',         state: 'GA', lat: 32.0809, lng: -81.0912, region: 'SE' },
  { name: 'Miami',            state: 'FL', lat: 25.7617, lng: -80.1918, region: 'SE' },
  { name: 'Tampa',            state: 'FL', lat: 27.9506, lng: -82.4572, region: 'SE' },
  { name: 'Orlando',          state: 'FL', lat: 28.5383, lng: -81.3792, region: 'SE' },
  { name: 'Jacksonville',     state: 'FL', lat: 30.3322, lng: -81.6557, region: 'SE' },
  { name: 'Fort Lauderdale',  state: 'FL', lat: 26.1224, lng: -80.1373, region: 'SE' },
  { name: 'St. Petersburg',   state: 'FL', lat: 27.7676, lng: -82.6403, region: 'SE' },
  { name: 'Tallahassee',      state: 'FL', lat: 30.4383, lng: -84.2807, region: 'SE' },
  { name: 'Charlotte',        state: 'NC', lat: 35.2271, lng: -80.8431, region: 'SE' },
  { name: 'Raleigh',          state: 'NC', lat: 35.7796, lng: -78.6382, region: 'SE' },
  { name: 'Greensboro',       state: 'NC', lat: 36.0726, lng: -79.7920, region: 'SE' },
  { name: 'Durham',           state: 'NC', lat: 35.9940, lng: -78.8986, region: 'SE' },
  { name: 'Columbia',         state: 'SC', lat: 34.0007, lng: -81.0348, region: 'SE' },
  { name: 'Charleston',       state: 'SC', lat: 32.7765, lng: -79.9311, region: 'SE' },
  { name: 'Greenville',       state: 'SC', lat: 34.8526, lng: -82.3940, region: 'SE' },
  { name: 'Nashville',        state: 'TN', lat: 36.1627, lng: -86.7816, region: 'SE' },
  { name: 'Memphis',          state: 'TN', lat: 35.1495, lng: -90.0490, region: 'SE' },
  { name: 'Knoxville',        state: 'TN', lat: 35.9606, lng: -83.9207, region: 'SE' },
  { name: 'Chattanooga',      state: 'TN', lat: 35.0456, lng: -85.3097, region: 'SE' },
  { name: 'Louisville',       state: 'KY', lat: 38.2527, lng: -85.7585, region: 'SE' },
  { name: 'Lexington',        state: 'KY', lat: 38.0406, lng: -84.5037, region: 'SE' },
  { name: 'Birmingham',       state: 'AL', lat: 33.5186, lng: -86.8104, region: 'SE' },
  { name: 'Huntsville',       state: 'AL', lat: 34.7304, lng: -86.5861, region: 'SE' },
  { name: 'Mobile',           state: 'AL', lat: 30.6954, lng: -88.0399, region: 'SE' },
  { name: 'Montgomery',       state: 'AL', lat: 32.3792, lng: -86.3077, region: 'SE' },
  { name: 'New Orleans',      state: 'LA', lat: 29.9511, lng: -90.0715, region: 'SE' },
  { name: 'Baton Rouge',      state: 'LA', lat: 30.4515, lng: -91.1871, region: 'SE' },
  { name: 'Shreveport',       state: 'LA', lat: 32.5252, lng: -93.7502, region: 'SE' },
  { name: 'Jackson',          state: 'MS', lat: 32.2988, lng: -90.1848, region: 'SE' },
  { name: 'Little Rock',      state: 'AR', lat: 34.7465, lng: -92.2896, region: 'SE' },
  // Midwest
  { name: 'Chicago',          state: 'IL', lat: 41.8781, lng: -87.6298, region: 'MW' },
  { name: 'Rockford',         state: 'IL', lat: 42.2711, lng: -89.0940, region: 'MW' },
  { name: 'Peoria',           state: 'IL', lat: 40.6936, lng: -89.5890, region: 'MW' },
  { name: 'Springfield',      state: 'IL', lat: 39.7817, lng: -89.6501, region: 'MW' },
  { name: 'Detroit',          state: 'MI', lat: 42.3314, lng: -83.0458, region: 'MW' },
  { name: 'Grand Rapids',     state: 'MI', lat: 42.9634, lng: -85.6681, region: 'MW' },
  { name: 'Lansing',          state: 'MI', lat: 42.7325, lng: -84.5555, region: 'MW' },
  { name: 'Flint',            state: 'MI', lat: 43.0125, lng: -83.6875, region: 'MW' },
  { name: 'Minneapolis',      state: 'MN', lat: 44.9778, lng: -93.2650, region: 'MW' },
  { name: 'St. Paul',         state: 'MN', lat: 44.9537, lng: -93.0900, region: 'MW' },
  { name: 'Duluth',           state: 'MN', lat: 46.7867, lng: -92.1005, region: 'MW' },
  { name: 'St. Louis',        state: 'MO', lat: 38.6270, lng: -90.1994, region: 'MW' },
  { name: 'Kansas City',      state: 'MO', lat: 39.0997, lng: -94.5786, region: 'MW' },
  { name: 'Springfield',      state: 'MO', lat: 37.2089, lng: -93.2923, region: 'MW' },
  { name: 'Indianapolis',     state: 'IN', lat: 39.7684, lng: -86.1581, region: 'MW' },
  { name: 'Fort Wayne',       state: 'IN', lat: 41.0793, lng: -85.1394, region: 'MW' },
  { name: 'Evansville',       state: 'IN', lat: 37.9716, lng: -87.5711, region: 'MW' },
  { name: 'Columbus',         state: 'OH', lat: 39.9612, lng: -82.9988, region: 'MW' },
  { name: 'Cincinnati',       state: 'OH', lat: 39.1031, lng: -84.5120, region: 'MW' },
  { name: 'Cleveland',        state: 'OH', lat: 41.4993, lng: -81.6944, region: 'MW' },
  { name: 'Toledo',           state: 'OH', lat: 41.6528, lng: -83.5379, region: 'MW' },
  { name: 'Akron',            state: 'OH', lat: 41.0814, lng: -81.5190, region: 'MW' },
  { name: 'Dayton',           state: 'OH', lat: 39.7589, lng: -84.1916, region: 'MW' },
  { name: 'Milwaukee',        state: 'WI', lat: 43.0389, lng: -87.9065, region: 'MW' },
  { name: 'Madison',          state: 'WI', lat: 43.0731, lng: -89.4012, region: 'MW' },
  { name: 'Green Bay',        state: 'WI', lat: 44.5192, lng: -88.0198, region: 'MW' },
  { name: 'Des Moines',       state: 'IA', lat: 41.5868, lng: -93.6250, region: 'MW' },
  { name: 'Cedar Rapids',     state: 'IA', lat: 41.9779, lng: -91.6656, region: 'MW' },
  { name: 'Omaha',            state: 'NE', lat: 41.2565, lng: -95.9345, region: 'MW' },
  { name: 'Lincoln',          state: 'NE', lat: 40.8136, lng: -96.7026, region: 'MW' },
  { name: 'Wichita',          state: 'KS', lat: 37.6872, lng: -97.3301, region: 'MW' },
  { name: 'Topeka',           state: 'KS', lat: 39.0489, lng: -95.6775, region: 'MW' },
  { name: 'Fargo',            state: 'ND', lat: 46.8772, lng: -96.7898, region: 'MW' },
  { name: 'Sioux Falls',      state: 'SD', lat: 43.5460, lng: -96.7313, region: 'MW' },
  // Southwest
  { name: 'Houston',          state: 'TX', lat: 29.7604, lng: -95.3698, region: 'SW' },
  { name: 'Dallas',           state: 'TX', lat: 32.7767, lng: -96.7970, region: 'SW' },
  { name: 'Fort Worth',       state: 'TX', lat: 32.7555, lng: -97.3308, region: 'SW' },
  { name: 'Austin',           state: 'TX', lat: 30.2672, lng: -97.7431, region: 'SW' },
  { name: 'San Antonio',      state: 'TX', lat: 29.4241, lng: -98.4936, region: 'SW' },
  { name: 'El Paso',          state: 'TX', lat: 31.7619, lng: -106.4850, region: 'SW' },
  { name: 'Corpus Christi',   state: 'TX', lat: 27.8006, lng: -97.3964, region: 'SW' },
  { name: 'Lubbock',          state: 'TX', lat: 33.5779, lng: -101.8552, region: 'SW' },
  { name: 'Laredo',           state: 'TX', lat: 27.5306, lng: -99.4803, region: 'SW' },
  { name: 'Amarillo',         state: 'TX', lat: 35.2220, lng: -101.8313, region: 'SW' },
  { name: 'Phoenix',          state: 'AZ', lat: 33.4484, lng: -112.0740, region: 'SW' },
  { name: 'Tucson',           state: 'AZ', lat: 32.2226, lng: -110.9747, region: 'SW' },
  { name: 'Albuquerque',      state: 'NM', lat: 35.0844, lng: -106.6504, region: 'SW' },
  { name: 'Santa Fe',         state: 'NM', lat: 35.6870, lng: -105.9378, region: 'SW' },
  { name: 'Oklahoma City',    state: 'OK', lat: 35.4676, lng: -97.5164, region: 'SW' },
  { name: 'Tulsa',            state: 'OK', lat: 36.1540, lng: -95.9928, region: 'SW' },
  // West
  { name: 'Los Angeles',      state: 'CA', lat: 34.0522, lng: -118.2437, region: 'W'  },
  { name: 'San Francisco',    state: 'CA', lat: 37.7749, lng: -122.4194, region: 'W'  },
  { name: 'San Diego',        state: 'CA', lat: 32.7157, lng: -117.1611, region: 'W'  },
  { name: 'San Jose',         state: 'CA', lat: 37.3382, lng: -121.8863, region: 'W'  },
  { name: 'Oakland',          state: 'CA', lat: 37.8044, lng: -122.2712, region: 'W'  },
  { name: 'Sacramento',       state: 'CA', lat: 38.5816, lng: -121.4944, region: 'W'  },
  { name: 'Fresno',           state: 'CA', lat: 36.7378, lng: -119.7871, region: 'W'  },
  { name: 'Long Beach',       state: 'CA', lat: 33.7701, lng: -118.1937, region: 'W'  },
  { name: 'Bakersfield',      state: 'CA', lat: 35.3733, lng: -119.0187, region: 'W'  },
  { name: 'Riverside',        state: 'CA', lat: 33.9806, lng: -117.3755, region: 'W'  },
  { name: 'Anaheim',          state: 'CA', lat: 33.8366, lng: -117.9143, region: 'W'  },
  { name: 'Stockton',         state: 'CA', lat: 37.9577, lng: -121.2908, region: 'W'  },
  { name: 'Seattle',          state: 'WA', lat: 47.6062, lng: -122.3321, region: 'W'  },
  { name: 'Tacoma',           state: 'WA', lat: 47.2529, lng: -122.4443, region: 'W'  },
  { name: 'Spokane',          state: 'WA', lat: 47.6588, lng: -117.4260, region: 'W'  },
  { name: 'Portland',         state: 'OR', lat: 45.5152, lng: -122.6784, region: 'W'  },
  { name: 'Eugene',           state: 'OR', lat: 44.0521, lng: -123.0868, region: 'W'  },
  { name: 'Salem',            state: 'OR', lat: 44.9429, lng: -123.0351, region: 'W'  },
  { name: 'Denver',           state: 'CO', lat: 39.7392, lng: -104.9903, region: 'W'  },
  { name: 'Colorado Springs', state: 'CO', lat: 38.8339, lng: -104.8214, region: 'W'  },
  { name: 'Boulder',          state: 'CO', lat: 40.0150, lng: -105.2705, region: 'W'  },
  { name: 'Salt Lake City',   state: 'UT', lat: 40.7608, lng: -111.8910, region: 'W'  },
  { name: 'Las Vegas',        state: 'NV', lat: 36.1699, lng: -115.1398, region: 'W'  },
  { name: 'Reno',             state: 'NV', lat: 39.5296, lng: -119.8138, region: 'W'  },
  { name: 'Boise',            state: 'ID', lat: 43.6150, lng: -116.2023, region: 'W'  },
  { name: 'Billings',         state: 'MT', lat: 45.7833, lng: -108.5007, region: 'W'  },
  { name: 'Honolulu',         state: 'HI', lat: 21.3069, lng: -157.8583, region: 'W'  },
  { name: 'Anchorage',        state: 'AK', lat: 61.2181, lng: -149.9003, region: 'W'  },
];

/**
 * ZIP3 centroid seed. Covers the most common US ZIP3 prefixes (a ZIP3 is the
 * first three digits of a ZIP5 and maps to a Sectional Center Facility /
 * region). Used for ZIP3-and-ZIP5 lookup in the Add-Point form.
 * Value: [lat, lng, "CityName, ST"]
 *
 * This is a ~200-entry subset chosen to cover the major population centers;
 * less-populated ZIP3s fall back to the ARCHETYPE_METROS approximation.
 */
export const ZIP3_CENTROIDS = {
  // Northeast
  '100': [40.7128, -74.0060, 'New York, NY'], '101': [40.7128, -74.0060, 'New York, NY'],
  '102': [40.7128, -74.0060, 'New York, NY'], '103': [40.6501, -74.0884, 'Staten Island, NY'],
  '104': [40.8448, -73.8648, 'Bronx, NY'],    '105': [40.9126, -73.7872, 'Yonkers, NY'],
  '106': [41.0534, -73.5387, 'White Plains, NY'], '107': [41.0687, -73.7140, 'Scarsdale, NY'],
  '108': [41.0912, -73.7629, 'Elmsford, NY'], '109': [41.0562, -73.7949, 'Tarrytown, NY'],
  '110': [40.7282, -73.7949, 'Queens, NY'],   '111': [40.7282, -73.7949, 'Queens, NY'],
  '112': [40.6782, -73.9442, 'Brooklyn, NY'], '113': [40.7282, -73.7949, 'Queens, NY'],
  '114': [40.7282, -73.7949, 'Queens, NY'],   '115': [40.7891, -73.1350, 'Hempstead, NY'],
  '116': [40.6576, -73.5107, 'Far Rockaway, NY'], '117': [40.8891, -72.5493, 'Hauppauge, NY'],
  '118': [40.8891, -72.5493, 'Hauppauge, NY'],'119': [40.8891, -72.5493, 'Hauppauge, NY'],
  '120': [42.6526, -73.7562, 'Albany, NY'],   '121': [42.6526, -73.7562, 'Albany, NY'],
  '122': [42.8142, -73.9396, 'Schenectady, NY'], '123': [42.6526, -73.7562, 'Albany, NY'],
  '124': [42.0987, -75.9180, 'Binghamton, NY'], '125': [41.5050, -74.0104, 'Poughkeepsie, NY'],
  '126': [41.5050, -74.0104, 'Poughkeepsie, NY'], '127': [41.7003, -74.7538, 'Monticello, NY'],
  '128': [43.3009, -73.6437, 'Glens Falls, NY'], '129': [44.6995, -73.4529, 'Plattsburgh, NY'],
  '130': [43.0481, -76.1474, 'Syracuse, NY'], '131': [43.0481, -76.1474, 'Syracuse, NY'],
  '132': [43.0481, -76.1474, 'Syracuse, NY'], '133': [43.2105, -75.4557, 'Utica, NY'],
  '134': [43.1566, -77.6088, 'Rochester, NY'],'135': [43.1566, -77.6088, 'Rochester, NY'],
  '136': [43.1566, -77.6088, 'Rochester, NY'],'137': [42.0987, -76.8261, 'Elmira, NY'],
  '138': [43.0842, -78.1875, 'Batavia, NY'],  '139': [43.0842, -78.1875, 'Batavia, NY'],
  '140': [42.8864, -78.8784, 'Buffalo, NY'],  '141': [42.8864, -78.8784, 'Buffalo, NY'],
  '142': [42.8864, -78.8784, 'Buffalo, NY'],  '143': [43.0962, -79.0377, 'Niagara Falls, NY'],
  '144': [43.1566, -77.6088, 'Rochester, NY'],'145': [43.1566, -77.6088, 'Rochester, NY'],
  '146': [43.1566, -77.6088, 'Rochester, NY'],'147': [42.0987, -75.9180, 'Binghamton, NY'],
  '148': [42.0987, -76.0050, 'Elmira, NY'],   '149': [42.4440, -76.5019, 'Ithaca, NY'],
  '150': [40.4406, -79.9959, 'Pittsburgh, PA'],'151': [40.4406, -79.9959, 'Pittsburgh, PA'],
  '152': [40.4406, -79.9959, 'Pittsburgh, PA'],'153': [40.4406, -79.9959, 'Pittsburgh, PA'],
  '154': [40.4406, -79.9959, 'Pittsburgh, PA'],'155': [40.3201, -78.9194, 'Johnstown, PA'],
  '156': [40.3201, -78.9194, 'Johnstown, PA'],'157': [40.5187, -78.3947, 'Altoona, PA'],
  '158': [40.5187, -78.3947, 'Altoona, PA'],  '159': [41.1621, -80.0886, 'New Castle, PA'],
  '160': [41.4090, -79.8293, 'Oil City, PA'], '161': [41.4090, -79.8293, 'Oil City, PA'],
  '162': [41.4090, -79.8293, 'Oil City, PA'], '163': [41.2551, -79.1522, 'Clarion, PA'],
  '164': [42.1292, -80.0851, 'Erie, PA'],     '165': [42.1292, -80.0851, 'Erie, PA'],
  '166': [40.7934, -77.8600, 'State College, PA'], '167': [41.6612, -77.2944, 'Williamsport, PA'],
  '168': [41.1304, -78.7503, 'DuBois, PA'],   '169': [41.2459, -76.8386, 'Williamsport, PA'],
  '170': [40.2732, -76.8867, 'Harrisburg, PA'],'171': [40.2732, -76.8867, 'Harrisburg, PA'],
  '172': [40.2732, -76.8867, 'Harrisburg, PA'],'173': [40.0379, -76.3055, 'Lancaster, PA'],
  '174': [40.0379, -76.3055, 'Lancaster, PA'],'175': [39.9626, -76.7277, 'York, PA'],
  '176': [39.9626, -76.7277, 'York, PA'],     '177': [41.2459, -75.8813, 'Wilkes-Barre, PA'],
  '178': [41.2459, -75.8813, 'Wilkes-Barre, PA'],'179': [40.6084, -75.4902, 'Allentown, PA'],
  '180': [40.6084, -75.4902, 'Allentown, PA'],'181': [40.6084, -75.4902, 'Allentown, PA'],
  '182': [41.4090, -75.6624, 'Scranton, PA'], '183': [41.4090, -75.6624, 'Scranton, PA'],
  '184': [41.4090, -75.6624, 'Scranton, PA'], '185': [41.4090, -75.6624, 'Scranton, PA'],
  '186': [41.4090, -75.6624, 'Scranton, PA'], '187': [41.4090, -75.6624, 'Scranton, PA'],
  '188': [41.4090, -75.6624, 'Scranton, PA'], '189': [40.0063, -75.3177, 'Paoli, PA'],
  '190': [39.9526, -75.1652, 'Philadelphia, PA'],'191': [39.9526, -75.1652, 'Philadelphia, PA'],
  '192': [39.9526, -75.1652, 'Philadelphia, PA'],'193': [40.0063, -75.3177, 'Paoli, PA'],
  '194': [40.2415, -75.2832, 'Fort Washington, PA'], '195': [40.3356, -75.9269, 'Reading, PA'],
  '196': [40.3356, -75.9269, 'Reading, PA'],  '197': [39.7391, -75.5398, 'Wilmington, DE'],
  '198': [39.7391, -75.5398, 'Wilmington, DE'],'199': [39.7391, -75.5398, 'Wilmington, DE'],
  '200': [38.9072, -77.0369, 'Washington, DC'],'201': [38.9072, -77.0369, 'Washington, DC'],
  '202': [38.9072, -77.0369, 'Washington, DC'],'203': [38.9072, -77.0369, 'Washington, DC'],
  '204': [38.9072, -77.0369, 'Washington, DC'],'205': [38.9072, -77.0369, 'Washington, DC'],
  '206': [39.0840, -76.8084, 'Silver Spring, MD'], '207': [39.0840, -76.8084, 'Silver Spring, MD'],
  '208': [39.0840, -76.8084, 'Silver Spring, MD'], '209': [39.0840, -76.8084, 'Silver Spring, MD'],
  '210': [39.2904, -76.6122, 'Baltimore, MD'],'211': [39.2904, -76.6122, 'Baltimore, MD'],
  '212': [39.2904, -76.6122, 'Baltimore, MD'],'214': [38.9784, -76.4922, 'Annapolis, MD'],
  '215': [39.6418, -77.7200, 'Hagerstown, MD'],'216': [38.7849, -75.8191, 'Salisbury, MD'],
  '217': [39.4143, -77.4105, 'Frederick, MD'],'218': [38.7849, -75.8191, 'Salisbury, MD'],
  '219': [38.9784, -76.4922, 'Annapolis, MD'],
  // Boston area
  '020': [42.3601, -71.0589, 'Boston, MA'],   '021': [42.3601, -71.0589, 'Boston, MA'],
  '022': [42.3601, -71.0589, 'Boston, MA'],   '023': [42.0834, -71.0184, 'Brockton, MA'],
  '024': [42.0834, -71.0184, 'Brockton, MA'], '025': [41.6688, -70.2962, 'Cape Cod, MA'],
  '026': [41.6688, -70.2962, 'Cape Cod, MA'], '027': [41.8240, -71.4128, 'Providence, RI'],
  '028': [41.8240, -71.4128, 'Providence, RI'],'029': [41.8240, -71.4128, 'Providence, RI'],
  '060': [41.7658, -72.6734, 'Hartford, CT'], '061': [41.7658, -72.6734, 'Hartford, CT'],
  '062': [41.5815, -72.7505, 'Meriden, CT'],  '063': [41.3083, -72.9279, 'New Haven, CT'],
  '064': [41.3083, -72.9279, 'New Haven, CT'],'065': [41.1865, -73.1952, 'Bridgeport, CT'],
  '066': [41.1865, -73.1952, 'Bridgeport, CT'],'067': [41.5623, -73.0515, 'Waterbury, CT'],
  '068': [41.1865, -73.1952, 'Bridgeport, CT'],'069': [41.0534, -73.5387, 'Stamford, CT'],
  // NJ
  '070': [40.7357, -74.1724, 'Newark, NJ'],   '071': [40.7357, -74.1724, 'Newark, NJ'],
  '072': [40.9168, -74.1718, 'Paterson, NJ'], '073': [40.7357, -74.1724, 'Newark, NJ'],
  '074': [40.9168, -74.1718, 'Paterson, NJ'], '075': [40.9168, -74.1718, 'Paterson, NJ'],
  '076': [40.9168, -74.1718, 'Paterson, NJ'], '077': [40.3573, -74.6672, 'Princeton, NJ'],
  '078': [40.7357, -74.1724, 'Newark, NJ'],   '079': [40.7357, -74.1724, 'Newark, NJ'],
  '080': [39.9259, -75.1196, 'Camden, NJ'],   '081': [39.9259, -75.1196, 'Camden, NJ'],
  '082': [39.3643, -74.4229, 'Atlantic City, NJ'], '083': [39.3643, -74.4229, 'Atlantic City, NJ'],
  '084': [39.3643, -74.4229, 'Atlantic City, NJ'], '085': [40.2206, -74.7597, 'Trenton, NJ'],
  '086': [40.2206, -74.7597, 'Trenton, NJ'],  '087': [40.2206, -74.7597, 'Trenton, NJ'],
  '088': [40.4862, -74.4518, 'New Brunswick, NJ'], '089': [40.4862, -74.4518, 'New Brunswick, NJ'],
  // Virginia
  '220': [38.8816, -77.0910, 'Arlington, VA'],'221': [38.8051, -77.0470, 'Alexandria, VA'],
  '222': [38.8462, -77.3064, 'Fairfax, VA'],  '223': [38.8462, -77.3064, 'Fairfax, VA'],
  '224': [38.4496, -78.8689, 'Harrisonburg, VA'], '225': [38.8462, -77.3064, 'Fairfax, VA'],
  '226': [37.2710, -79.9414, 'Roanoke, VA'],  '227': [38.0293, -78.4767, 'Charlottesville, VA'],
  '228': [37.2710, -79.9414, 'Roanoke, VA'],  '229': [38.0293, -78.4767, 'Charlottesville, VA'],
  '230': [37.5407, -77.4360, 'Richmond, VA'], '231': [37.5407, -77.4360, 'Richmond, VA'],
  '232': [37.5407, -77.4360, 'Richmond, VA'], '233': [36.8529, -75.9780, 'Virginia Beach, VA'],
  '234': [36.8529, -75.9780, 'Virginia Beach, VA'], '235': [36.8529, -75.9780, 'Virginia Beach, VA'],
  '236': [36.8529, -75.9780, 'Virginia Beach, VA'], '237': [36.8529, -75.9780, 'Virginia Beach, VA'],
  '238': [37.5407, -77.4360, 'Richmond, VA'], '239': [37.5407, -77.4360, 'Richmond, VA'],
  '240': [37.2710, -79.9414, 'Roanoke, VA'],  '241': [37.2710, -79.9414, 'Roanoke, VA'],
  '242': [36.6002, -82.1709, 'Bristol, VA'],  '243': [37.2710, -79.9414, 'Roanoke, VA'],
  '244': [38.0293, -78.4767, 'Charlottesville, VA'], '245': [37.4138, -79.1422, 'Lynchburg, VA'],
  '246': [37.2710, -79.9414, 'Roanoke, VA'],
  // Carolinas
  '270': [36.0726, -79.7920, 'Greensboro, NC'],'271': [36.0726, -79.7920, 'Greensboro, NC'],
  '272': [36.0999, -80.2442, 'Winston-Salem, NC'], '273': [36.0999, -80.2442, 'Winston-Salem, NC'],
  '274': [36.0999, -80.2442, 'Winston-Salem, NC'], '275': [35.7796, -78.6382, 'Raleigh, NC'],
  '276': [35.7796, -78.6382, 'Raleigh, NC'],  '277': [35.9940, -78.8986, 'Durham, NC'],
  '278': [35.6127, -77.3664, 'Rocky Mount, NC'],'279': [35.6127, -77.3664, 'Rocky Mount, NC'],
  '280': [35.2271, -80.8431, 'Charlotte, NC'],'281': [35.2271, -80.8431, 'Charlotte, NC'],
  '282': [35.2271, -80.8431, 'Charlotte, NC'],'283': [34.2257, -77.9447, 'Wilmington, NC'],
  '284': [34.2257, -77.9447, 'Wilmington, NC'],'285': [35.5951, -82.5515, 'Asheville, NC'],
  '286': [35.5951, -82.5515, 'Asheville, NC'],'287': [35.5951, -82.5515, 'Asheville, NC'],
  '288': [35.5951, -82.5515, 'Asheville, NC'],'289': [35.5951, -82.5515, 'Asheville, NC'],
  '290': [34.0007, -81.0348, 'Columbia, SC'], '291': [34.0007, -81.0348, 'Columbia, SC'],
  '292': [34.0007, -81.0348, 'Columbia, SC'], '293': [34.8526, -82.3940, 'Greenville, SC'],
  '294': [32.7765, -79.9311, 'Charleston, SC'],'295': [34.8526, -82.3940, 'Greenville, SC'],
  '296': [34.8526, -82.3940, 'Greenville, SC'],'297': [35.7796, -78.6382, 'Raleigh, NC'],
  '298': [32.0809, -81.0912, 'Savannah, GA'], '299': [32.0809, -81.0912, 'Savannah, GA'],
  // Georgia
  '300': [33.7490, -84.3880, 'Atlanta, GA'],  '301': [33.7490, -84.3880, 'Atlanta, GA'],
  '302': [33.7490, -84.3880, 'Atlanta, GA'],  '303': [33.7490, -84.3880, 'Atlanta, GA'],
  '304': [32.0809, -81.0912, 'Savannah, GA'], '305': [33.7490, -84.3880, 'Atlanta, GA'],
  '306': [32.4609, -84.9877, 'Columbus, GA'], '307': [33.7490, -84.3880, 'Atlanta, GA'],
  '308': [32.8407, -83.6324, 'Macon, GA'],    '309': [32.8407, -83.6324, 'Macon, GA'],
  '310': [32.0809, -81.0912, 'Savannah, GA'], '311': [32.0809, -81.0912, 'Savannah, GA'],
  '312': [32.8407, -83.6324, 'Macon, GA'],    '313': [32.4609, -84.9877, 'Columbus, GA'],
  '314': [32.4609, -84.9877, 'Columbus, GA'], '315': [32.4609, -84.9877, 'Columbus, GA'],
  '316': [31.5785, -84.1557, 'Albany, GA'],   '317': [31.5785, -84.1557, 'Albany, GA'],
  '318': [33.7490, -84.3880, 'Atlanta, GA'],  '319': [33.7490, -84.3880, 'Atlanta, GA'],
  // Florida
  '320': [30.3322, -81.6557, 'Jacksonville, FL'], '321': [28.5383, -81.3792, 'Orlando, FL'],
  '322': [30.3322, -81.6557, 'Jacksonville, FL'], '323': [30.4383, -84.2807, 'Tallahassee, FL'],
  '324': [30.4383, -84.2807, 'Tallahassee, FL'], '325': [30.1588, -85.6602, 'Panama City, FL'],
  '326': [29.6516, -82.3248, 'Gainesville, FL'], '327': [28.5383, -81.3792, 'Orlando, FL'],
  '328': [28.5383, -81.3792, 'Orlando, FL'],  '329': [28.0836, -80.6081, 'Melbourne, FL'],
  '330': [25.7617, -80.1918, 'Miami, FL'],    '331': [25.7617, -80.1918, 'Miami, FL'],
  '332': [25.7617, -80.1918, 'Miami, FL'],    '333': [26.1224, -80.1373, 'Fort Lauderdale, FL'],
  '334': [26.7153, -80.0534, 'West Palm Beach, FL'], '335': [27.9506, -82.4572, 'Tampa, FL'],
  '336': [27.9506, -82.4572, 'Tampa, FL'],    '337': [27.9506, -82.4572, 'Tampa, FL'],
  '338': [28.0395, -81.9498, 'Lakeland, FL'], '339': [26.1420, -81.7948, 'Naples, FL'],
  // Alabama/Mississippi/Tennessee
  '350': [33.5186, -86.8104, 'Birmingham, AL'],'351': [33.5186, -86.8104, 'Birmingham, AL'],
  '352': [33.5186, -86.8104, 'Birmingham, AL'],'354': [32.3792, -86.3077, 'Montgomery, AL'],
  '355': [33.5186, -86.8104, 'Birmingham, AL'],'356': [34.7304, -86.5861, 'Huntsville, AL'],
  '357': [34.7304, -86.5861, 'Huntsville, AL'],'358': [34.7304, -86.5861, 'Huntsville, AL'],
  '359': [33.2098, -87.5692, 'Tuscaloosa, AL'],'360': [32.3792, -86.3077, 'Montgomery, AL'],
  '361': [32.3792, -86.3077, 'Montgomery, AL'],'362': [33.2098, -87.5692, 'Tuscaloosa, AL'],
  '363': [31.3271, -85.8555, 'Dothan, AL'],   '364': [32.3792, -86.3077, 'Montgomery, AL'],
  '365': [30.6954, -88.0399, 'Mobile, AL'],   '366': [30.6954, -88.0399, 'Mobile, AL'],
  '367': [32.3792, -86.3077, 'Montgomery, AL'],'368': [33.5186, -86.8104, 'Birmingham, AL'],
  '369': [33.2098, -87.5692, 'Tuscaloosa, AL'],'370': [36.1627, -86.7816, 'Nashville, TN'],
  '371': [36.1627, -86.7816, 'Nashville, TN'],'372': [36.1627, -86.7816, 'Nashville, TN'],
  '373': [35.0456, -85.3097, 'Chattanooga, TN'],'374': [35.0456, -85.3097, 'Chattanooga, TN'],
  '375': [35.9606, -83.9207, 'Knoxville, TN'],'376': [36.5484, -82.5618, 'Kingsport, TN'],
  '377': [35.9606, -83.9207, 'Knoxville, TN'],'378': [35.9606, -83.9207, 'Knoxville, TN'],
  '379': [35.9606, -83.9207, 'Knoxville, TN'],'380': [35.1495, -90.0490, 'Memphis, TN'],
  '381': [35.1495, -90.0490, 'Memphis, TN'],  '382': [35.1495, -90.0490, 'Memphis, TN'],
  '383': [35.6145, -88.8139, 'Jackson, TN'],  '384': [35.1495, -90.0490, 'Memphis, TN'],
  '385': [35.1495, -90.0490, 'Memphis, TN'],
  // Kentucky/Indiana
  '400': [38.2527, -85.7585, 'Louisville, KY'],'401': [38.2527, -85.7585, 'Louisville, KY'],
  '402': [38.2527, -85.7585, 'Louisville, KY'],'403': [38.0406, -84.5037, 'Lexington, KY'],
  '404': [38.0406, -84.5037, 'Lexington, KY'],'405': [38.0406, -84.5037, 'Lexington, KY'],
  '406': [38.0406, -84.5037, 'Lexington, KY'],'407': [37.8393, -84.2700, 'Winchester, KY'],
  '408': [37.8393, -84.2700, 'Winchester, KY'],'409': [38.0406, -84.5037, 'Lexington, KY'],
  '410': [39.1031, -84.5120, 'Cincinnati, OH'],'411': [39.1031, -84.5120, 'Cincinnati, OH'],
  '412': [39.1031, -84.5120, 'Cincinnati, OH'],'413': [39.1031, -84.5120, 'Cincinnati, OH'],
  '414': [39.9612, -82.9988, 'Columbus, OH'], '415': [39.9612, -82.9988, 'Columbus, OH'],
  '416': [39.9612, -82.9988, 'Columbus, OH'], '417': [39.9612, -82.9988, 'Columbus, OH'],
  '418': [39.9612, -82.9988, 'Columbus, OH'], '419': [41.6528, -83.5379, 'Toledo, OH'],
  '420': [41.6528, -83.5379, 'Toledo, OH'],   '421': [41.6528, -83.5379, 'Toledo, OH'],
  '422': [41.4993, -81.6944, 'Cleveland, OH'],'423': [41.4993, -81.6944, 'Cleveland, OH'],
  '424': [41.4993, -81.6944, 'Cleveland, OH'],'425': [41.0814, -81.5190, 'Akron, OH'],
  '426': [41.0814, -81.5190, 'Akron, OH'],    '427': [41.0998, -80.6495, 'Youngstown, OH'],
  '428': [41.0814, -81.5190, 'Akron, OH'],    '429': [39.7589, -84.1916, 'Dayton, OH'],
  '430': [39.9612, -82.9988, 'Columbus, OH'], '431': [39.9612, -82.9988, 'Columbus, OH'],
  '432': [39.9612, -82.9988, 'Columbus, OH'], '433': [39.9612, -82.9988, 'Columbus, OH'],
  '434': [39.9612, -82.9988, 'Columbus, OH'], '435': [39.9612, -82.9988, 'Columbus, OH'],
  '436': [39.9612, -82.9988, 'Columbus, OH'], '437': [39.9612, -82.9988, 'Columbus, OH'],
  '438': [41.4993, -81.6944, 'Cleveland, OH'],'439': [41.4993, -81.6944, 'Cleveland, OH'],
  '440': [41.4993, -81.6944, 'Cleveland, OH'],'441': [41.4993, -81.6944, 'Cleveland, OH'],
  '442': [41.4993, -81.6944, 'Cleveland, OH'],'443': [41.4993, -81.6944, 'Cleveland, OH'],
  '444': [41.0998, -80.6495, 'Youngstown, OH'],'445': [41.0998, -80.6495, 'Youngstown, OH'],
  '446': [41.0998, -80.6495, 'Youngstown, OH'],'447': [39.7589, -84.1916, 'Dayton, OH'],
  '448': [39.7589, -84.1916, 'Dayton, OH'],   '449': [39.7589, -84.1916, 'Dayton, OH'],
  '450': [39.1031, -84.5120, 'Cincinnati, OH'],'451': [39.1031, -84.5120, 'Cincinnati, OH'],
  '452': [39.1031, -84.5120, 'Cincinnati, OH'],'453': [39.7589, -84.1916, 'Dayton, OH'],
  '454': [39.7589, -84.1916, 'Dayton, OH'],   '455': [39.7589, -84.1916, 'Dayton, OH'],
  '456': [39.7589, -84.1916, 'Dayton, OH'],   '457': [39.9612, -82.9988, 'Columbus, OH'],
  '458': [41.6528, -83.5379, 'Toledo, OH'],   '459': [41.6528, -83.5379, 'Toledo, OH'],
  '460': [39.7684, -86.1581, 'Indianapolis, IN'], '461': [39.7684, -86.1581, 'Indianapolis, IN'],
  '462': [39.7684, -86.1581, 'Indianapolis, IN'], '463': [41.5868, -87.3464, 'Gary, IN'],
  '464': [41.5868, -87.3464, 'Gary, IN'],     '465': [41.6764, -86.2520, 'South Bend, IN'],
  '466': [41.6764, -86.2520, 'South Bend, IN'],'467': [41.0793, -85.1394, 'Fort Wayne, IN'],
  '468': [41.0793, -85.1394, 'Fort Wayne, IN'],'469': [39.7684, -86.1581, 'Indianapolis, IN'],
  '470': [39.1654, -86.5264, 'Bloomington, IN'], '471': [38.2527, -85.7585, 'Louisville, KY'],
  '472': [39.1654, -86.5264, 'Bloomington, IN'], '473': [39.9334, -85.0049, 'Muncie, IN'],
  '474': [39.9334, -85.0049, 'Muncie, IN'],   '475': [38.3365, -86.9378, 'Tell City, IN'],
  '476': [37.9716, -87.5711, 'Evansville, IN'],'477': [37.9716, -87.5711, 'Evansville, IN'],
  '478': [37.9716, -87.5711, 'Evansville, IN'],'479': [40.4167, -86.8753, 'Lafayette, IN'],
  // Michigan
  '480': [42.3314, -83.0458, 'Detroit, MI'],  '481': [42.3314, -83.0458, 'Detroit, MI'],
  '482': [42.3314, -83.0458, 'Detroit, MI'],  '483': [42.7325, -84.5555, 'Lansing, MI'],
  '484': [43.0125, -83.6875, 'Flint, MI'],    '485': [43.0125, -83.6875, 'Flint, MI'],
  '486': [43.0125, -83.6875, 'Flint, MI'],    '487': [43.4195, -83.9508, 'Saginaw, MI'],
  '488': [42.7325, -84.5555, 'Lansing, MI'],  '489': [42.7325, -84.5555, 'Lansing, MI'],
  '490': [42.2917, -85.5872, 'Kalamazoo, MI'],'491': [42.2917, -85.5872, 'Kalamazoo, MI'],
  '492': [42.9634, -85.6681, 'Grand Rapids, MI'], '493': [42.9634, -85.6681, 'Grand Rapids, MI'],
  '494': [42.9634, -85.6681, 'Grand Rapids, MI'], '495': [42.9634, -85.6681, 'Grand Rapids, MI'],
  '496': [44.7631, -85.6206, 'Traverse City, MI'], '497': [44.7631, -85.6206, 'Traverse City, MI'],
  '498': [46.5436, -87.3954, 'Marquette, MI'],'499': [46.5436, -87.3954, 'Marquette, MI'],
  // Illinois
  '600': [41.8781, -87.6298, 'Chicago, IL'],  '601': [41.8781, -87.6298, 'Chicago, IL'],
  '602': [41.8781, -87.6298, 'Chicago, IL'],  '603': [41.8781, -87.6298, 'Chicago, IL'],
  '604': [41.8781, -87.6298, 'Chicago, IL'],  '605': [41.8781, -87.6298, 'Chicago, IL'],
  '606': [41.8781, -87.6298, 'Chicago, IL'],  '607': [41.8781, -87.6298, 'Chicago, IL'],
  '608': [41.8781, -87.6298, 'Chicago, IL'],  '609': [41.7606, -88.3201, 'Aurora, IL'],
  '610': [42.2711, -89.0940, 'Rockford, IL'], '611': [42.2711, -89.0940, 'Rockford, IL'],
  '612': [41.5067, -90.5151, 'Rock Island, IL'], '613': [40.6936, -89.5890, 'Peoria, IL'],
  '614': [40.6936, -89.5890, 'Peoria, IL'],   '615': [40.6936, -89.5890, 'Peoria, IL'],
  '616': [40.6936, -89.5890, 'Peoria, IL'],   '617': [40.1164, -88.2434, 'Champaign, IL'],
  '618': [40.1164, -88.2434, 'Champaign, IL'],'619': [40.4842, -88.9937, 'Bloomington, IL'],
  '620': [38.6270, -90.1994, 'St. Louis, MO'],'622': [38.6270, -90.1994, 'St. Louis, MO'],
  '623': [39.7817, -89.6501, 'Springfield, IL'], '624': [39.1030, -88.5417, 'Effingham, IL'],
  '625': [39.7817, -89.6501, 'Springfield, IL'], '626': [39.7817, -89.6501, 'Springfield, IL'],
  '627': [39.7817, -89.6501, 'Springfield, IL'], '628': [38.6270, -90.1994, 'St. Louis, MO'],
  '629': [37.7272, -89.2167, 'Carbondale, IL'],
  // Missouri
  '630': [38.6270, -90.1994, 'St. Louis, MO'],'631': [38.6270, -90.1994, 'St. Louis, MO'],
  '633': [38.6270, -90.1994, 'St. Louis, MO'],'634': [37.1898, -93.2923, 'Springfield, MO'],
  '635': [37.1898, -93.2923, 'Springfield, MO'],'636': [37.3058, -89.5181, 'Cape Girardeau, MO'],
  '637': [37.3058, -89.5181, 'Cape Girardeau, MO'],'638': [37.3058, -89.5181, 'Cape Girardeau, MO'],
  '639': [37.3058, -89.5181, 'Cape Girardeau, MO'],'640': [39.0997, -94.5786, 'Kansas City, MO'],
  '641': [39.0997, -94.5786, 'Kansas City, MO'],'644': [39.0997, -94.5786, 'Kansas City, MO'],
  '645': [39.0997, -94.5786, 'Kansas City, MO'],'646': [39.7767, -94.8467, 'St. Joseph, MO'],
  '647': [39.0997, -94.5786, 'Kansas City, MO'],'648': [37.1898, -93.2923, 'Springfield, MO'],
  '649': [37.1898, -93.2923, 'Springfield, MO'],'650': [38.5767, -92.1735, 'Jefferson City, MO'],
  '651': [38.5767, -92.1735, 'Jefferson City, MO'],'652': [38.9517, -92.3341, 'Columbia, MO'],
  '653': [38.9517, -92.3341, 'Columbia, MO'], '654': [37.1898, -93.2923, 'Springfield, MO'],
  '655': [37.1898, -93.2923, 'Springfield, MO'],'656': [37.1898, -93.2923, 'Springfield, MO'],
  '657': [37.1898, -93.2923, 'Springfield, MO'],'658': [37.1898, -93.2923, 'Springfield, MO'],
  // Kansas
  '660': [39.0997, -94.5786, 'Kansas City, MO'],'661': [39.0997, -94.5786, 'Kansas City, MO'],
  '662': [39.0997, -94.5786, 'Kansas City, MO'],'664': [39.0489, -95.6775, 'Topeka, KS'],
  '665': [39.0489, -95.6775, 'Topeka, KS'],   '666': [39.0489, -95.6775, 'Topeka, KS'],
  '667': [38.9717, -95.2353, 'Lawrence, KS'], '668': [39.0489, -95.6775, 'Topeka, KS'],
  '669': [39.0489, -95.6775, 'Topeka, KS'],   '670': [37.6872, -97.3301, 'Wichita, KS'],
  '671': [37.6872, -97.3301, 'Wichita, KS'],  '672': [37.6872, -97.3301, 'Wichita, KS'],
  '673': [37.0842, -94.5133, 'Joplin, MO'],   '674': [39.0483, -97.8833, 'Salina, KS'],
  '675': [38.0608, -97.9298, 'Hutchinson, KS'],'676': [37.7528, -100.0171, 'Dodge City, KS'],
  '677': [39.3842, -101.0479, 'Colby, KS'],   '678': [38.3706, -98.7648, 'Great Bend, KS'],
  '679': [38.3706, -98.7648, 'Great Bend, KS'],
  // Texas
  '750': [32.7767, -96.7970, 'Dallas, TX'],   '751': [32.7767, -96.7970, 'Dallas, TX'],
  '752': [32.7767, -96.7970, 'Dallas, TX'],   '753': [32.7767, -96.7970, 'Dallas, TX'],
  '754': [32.7767, -96.7970, 'Dallas, TX'],   '755': [32.7767, -96.7970, 'Dallas, TX'],
  '756': [32.3513, -95.3011, 'Tyler, TX'],    '757': [32.3513, -95.3011, 'Tyler, TX'],
  '758': [31.5493, -97.1467, 'Waco, TX'],     '759': [32.3513, -95.3011, 'Tyler, TX'],
  '760': [32.7555, -97.3308, 'Fort Worth, TX'],'761': [32.7555, -97.3308, 'Fort Worth, TX'],
  '762': [32.7555, -97.3308, 'Fort Worth, TX'],'763': [32.7555, -97.3308, 'Fort Worth, TX'],
  '764': [32.7555, -97.3308, 'Fort Worth, TX'],'765': [31.5493, -97.1467, 'Waco, TX'],
  '766': [31.5493, -97.1467, 'Waco, TX'],     '767': [31.5493, -97.1467, 'Waco, TX'],
  '768': [31.4638, -100.4370, 'San Angelo, TX'],'769': [31.8457, -102.3676, 'Midland, TX'],
  '770': [29.7604, -95.3698, 'Houston, TX'],  '771': [29.7604, -95.3698, 'Houston, TX'],
  '772': [29.7604, -95.3698, 'Houston, TX'],  '773': [29.7604, -95.3698, 'Houston, TX'],
  '774': [29.7604, -95.3698, 'Houston, TX'],  '775': [29.7604, -95.3698, 'Houston, TX'],
  '776': [30.0802, -94.1266, 'Beaumont, TX'], '777': [30.0802, -94.1266, 'Beaumont, TX'],
  '778': [30.6280, -96.3344, 'College Station, TX'], '779': [28.8052, -97.0036, 'Victoria, TX'],
  '780': [29.4241, -98.4936, 'San Antonio, TX'], '781': [29.4241, -98.4936, 'San Antonio, TX'],
  '782': [29.4241, -98.4936, 'San Antonio, TX'], '783': [27.8006, -97.3964, 'Corpus Christi, TX'],
  '784': [27.8006, -97.3964, 'Corpus Christi, TX'], '785': [26.3017, -98.1633, 'McAllen, TX'],
  '786': [30.2672, -97.7431, 'Austin, TX'],   '787': [30.2672, -97.7431, 'Austin, TX'],
  '788': [27.5306, -99.4803, 'Laredo, TX'],   '789': [30.2672, -97.7431, 'Austin, TX'],
  '790': [35.2220, -101.8313, 'Amarillo, TX'],'791': [35.2220, -101.8313, 'Amarillo, TX'],
  '792': [33.5779, -101.8552, 'Lubbock, TX'], '793': [33.5779, -101.8552, 'Lubbock, TX'],
  '794': [33.5779, -101.8552, 'Lubbock, TX'], '795': [32.4487, -99.7331, 'Abilene, TX'],
  '796': [32.4487, -99.7331, 'Abilene, TX'],  '797': [31.8457, -102.3676, 'Midland, TX'],
  '798': [31.7619, -106.4850, 'El Paso, TX'], '799': [31.7619, -106.4850, 'El Paso, TX'],
  // California
  '900': [34.0522, -118.2437, 'Los Angeles, CA'], '901': [34.0522, -118.2437, 'Los Angeles, CA'],
  '902': [34.0522, -118.2437, 'Los Angeles, CA'], '903': [34.0522, -118.2437, 'Los Angeles, CA'],
  '904': [34.0522, -118.2437, 'Los Angeles, CA'], '905': [33.7701, -118.1937, 'Long Beach, CA'],
  '906': [33.7701, -118.1937, 'Long Beach, CA'], '907': [33.7701, -118.1937, 'Long Beach, CA'],
  '908': [33.7701, -118.1937, 'Long Beach, CA'], '910': [34.1478, -118.1445, 'Pasadena, CA'],
  '911': [34.1478, -118.1445, 'Pasadena, CA'], '912': [34.1478, -118.1445, 'Pasadena, CA'],
  '913': [34.1866, -118.4483, 'Van Nuys, CA'],'914': [34.1866, -118.4483, 'Van Nuys, CA'],
  '915': [34.1866, -118.4483, 'Van Nuys, CA'],'916': [34.1866, -118.4483, 'Van Nuys, CA'],
  '917': [33.7701, -118.1937, 'Long Beach, CA'], '918': [33.7701, -118.1937, 'Long Beach, CA'],
  '919': [32.7157, -117.1611, 'San Diego, CA'],'920': [32.7157, -117.1611, 'San Diego, CA'],
  '921': [32.7157, -117.1611, 'San Diego, CA'],'922': [33.7455, -117.8677, 'Santa Ana, CA'],
  '923': [34.1083, -117.2898, 'San Bernardino, CA'], '924': [34.1083, -117.2898, 'San Bernardino, CA'],
  '925': [33.9533, -117.3962, 'Riverside, CA'],'926': [33.9533, -117.3962, 'Riverside, CA'],
  '927': [33.9533, -117.3962, 'Riverside, CA'],'928': [33.9533, -117.3962, 'Riverside, CA'],
  '929': [34.4208, -119.6982, 'Santa Barbara, CA'], '930': [34.4208, -119.6982, 'Santa Barbara, CA'],
  '931': [34.4208, -119.6982, 'Santa Barbara, CA'], '932': [35.3733, -119.0187, 'Bakersfield, CA'],
  '933': [35.3733, -119.0187, 'Bakersfield, CA'],'934': [34.4208, -119.6982, 'Santa Barbara, CA'],
  '935': [36.7378, -119.7871, 'Fresno, CA'],  '936': [36.7378, -119.7871, 'Fresno, CA'],
  '937': [36.7378, -119.7871, 'Fresno, CA'],  '938': [36.7378, -119.7871, 'Fresno, CA'],
  '939': [36.6002, -121.8947, 'Monterey, CA'],'940': [37.7749, -122.4194, 'San Francisco, CA'],
  '941': [37.7749, -122.4194, 'San Francisco, CA'], '943': [37.4419, -122.1430, 'Palo Alto, CA'],
  '944': [37.4419, -122.1430, 'Palo Alto, CA'],'945': [37.8044, -122.2712, 'Oakland, CA'],
  '946': [37.8044, -122.2712, 'Oakland, CA'], '947': [37.8044, -122.2712, 'Oakland, CA'],
  '948': [37.8044, -122.2712, 'Oakland, CA'], '949': [38.1041, -122.2566, 'Vallejo, CA'],
  '950': [37.3382, -121.8863, 'San Jose, CA'],'951': [37.3382, -121.8863, 'San Jose, CA'],
  '952': [37.9577, -121.2908, 'Stockton, CA'],'953': [37.9577, -121.2908, 'Stockton, CA'],
  '954': [38.4404, -122.7144, 'Santa Rosa, CA'],'955': [40.8021, -124.1637, 'Eureka, CA'],
  '956': [38.5816, -121.4944, 'Sacramento, CA'], '957': [38.5816, -121.4944, 'Sacramento, CA'],
  '958': [38.5816, -121.4944, 'Sacramento, CA'], '959': [39.7285, -121.8375, 'Chico, CA'],
  '960': [40.5865, -122.3917, 'Redding, CA'], '961': [39.5296, -119.8138, 'Reno, NV'],
  // Washington/Oregon
  '970': [45.5152, -122.6784, 'Portland, OR'],'971': [45.5152, -122.6784, 'Portland, OR'],
  '972': [45.5152, -122.6784, 'Portland, OR'],'973': [44.9429, -123.0351, 'Salem, OR'],
  '974': [44.0521, -123.0868, 'Eugene, OR'],  '975': [42.3265, -122.8756, 'Medford, OR'],
  '976': [42.3265, -122.8756, 'Medford, OR'], '977': [44.0582, -121.3153, 'Bend, OR'],
  '978': [44.0582, -121.3153, 'Bend, OR'],    '979': [42.3265, -122.8756, 'Medford, OR'],
  '980': [47.6062, -122.3321, 'Seattle, WA'], '981': [47.6062, -122.3321, 'Seattle, WA'],
  '982': [47.6062, -122.3321, 'Seattle, WA'], '983': [47.6062, -122.3321, 'Seattle, WA'],
  '984': [47.2529, -122.4443, 'Tacoma, WA'],  '985': [47.0379, -122.9007, 'Olympia, WA'],
  '986': [46.9965, -120.5478, 'Yakima, WA'],  '988': [47.6588, -117.4260, 'Spokane, WA'],
  '989': [47.6588, -117.4260, 'Spokane, WA'], '990': [47.6588, -117.4260, 'Spokane, WA'],
  '991': [47.6588, -117.4260, 'Spokane, WA'], '992': [46.9965, -120.5478, 'Yakima, WA'],
  '993': [46.2087, -119.1199, 'Pasco, WA'],   '994': [47.6588, -117.4260, 'Spokane, WA'],
  // Denver/Utah/Nevada
  '800': [39.7392, -104.9903, 'Denver, CO'],  '801': [39.7392, -104.9903, 'Denver, CO'],
  '802': [39.7392, -104.9903, 'Denver, CO'],  '803': [40.0150, -105.2705, 'Boulder, CO'],
  '804': [40.0150, -105.2705, 'Boulder, CO'], '805': [39.7392, -104.9903, 'Denver, CO'],
  '806': [39.7392, -104.9903, 'Denver, CO'],  '807': [38.2544, -104.6091, 'Pueblo, CO'],
  '808': [38.8339, -104.8214, 'Colorado Springs, CO'], '809': [38.8339, -104.8214, 'Colorado Springs, CO'],
  '810': [38.0638, -103.2286, 'La Junta, CO'],'811': [39.5501, -105.7821, 'Frisco, CO'],
  '812': [37.2753, -107.8801, 'Durango, CO'], '813': [39.0639, -108.5506, 'Grand Junction, CO'],
  '814': [39.0639, -108.5506, 'Grand Junction, CO'], '815': [39.6295, -106.0527, 'Vail, CO'],
  '816': [40.5853, -105.0844, 'Fort Collins, CO'], '820': [41.1400, -104.8202, 'Cheyenne, WY'],
  '821': [42.8666, -106.3131, 'Casper, WY'],  '822': [44.2619, -105.5008, 'Gillette, WY'],
  '828': [44.2619, -105.5008, 'Gillette, WY'],'830': [41.5868, -109.2029, 'Rock Springs, WY'],
  '831': [43.0760, -108.3801, 'Riverton, WY'],'832': [43.6150, -116.2023, 'Boise, ID'],
  '833': [43.6150, -116.2023, 'Boise, ID'],   '835': [43.8231, -111.7924, 'Rexburg, ID'],
  '836': [43.6150, -116.2023, 'Boise, ID'],   '837': [43.6150, -116.2023, 'Boise, ID'],
  '838': [47.6588, -117.4260, 'Spokane, WA'], '840': [40.7608, -111.8910, 'Salt Lake City, UT'],
  '841': [40.7608, -111.8910, 'Salt Lake City, UT'], '842': [40.7608, -111.8910, 'Salt Lake City, UT'],
  '843': [41.2230, -111.9738, 'Ogden, UT'],   '844': [41.2230, -111.9738, 'Ogden, UT'],
  '845': [40.2338, -111.6585, 'Provo, UT'],   '846': [40.2338, -111.6585, 'Provo, UT'],
  '847': [37.0965, -113.5684, 'St. George, UT'], '850': [33.4484, -112.0740, 'Phoenix, AZ'],
  '851': [33.4484, -112.0740, 'Phoenix, AZ'], '852': [33.4484, -112.0740, 'Phoenix, AZ'],
  '853': [33.4484, -112.0740, 'Phoenix, AZ'], '854': [33.4484, -112.0740, 'Phoenix, AZ'],
  '855': [32.2226, -110.9747, 'Tucson, AZ'],  '856': [32.2226, -110.9747, 'Tucson, AZ'],
  '857': [32.2226, -110.9747, 'Tucson, AZ'],  '859': [35.1983, -111.6513, 'Flagstaff, AZ'],
  '860': [35.1983, -111.6513, 'Flagstaff, AZ'],'863': [33.4484, -112.0740, 'Phoenix, AZ'],
  '864': [34.4848, -114.3225, 'Lake Havasu City, AZ'], '865': [35.0844, -106.6504, 'Albuquerque, NM'],
  '870': [35.0844, -106.6504, 'Albuquerque, NM'], '871': [35.0844, -106.6504, 'Albuquerque, NM'],
  '872': [35.0844, -106.6504, 'Albuquerque, NM'], '873': [35.6870, -105.9378, 'Santa Fe, NM'],
  '874': [35.6870, -105.9378, 'Santa Fe, NM'],'875': [35.0844, -106.6504, 'Albuquerque, NM'],
  '877': [33.4200, -104.5230, 'Roswell, NM'], '878': [33.4200, -104.5230, 'Roswell, NM'],
  '880': [32.3199, -106.7637, 'Las Cruces, NM'], '881': [32.3199, -106.7637, 'Las Cruces, NM'],
  '882': [32.3199, -106.7637, 'Las Cruces, NM'], '883': [32.3199, -106.7637, 'Las Cruces, NM'],
  '884': [35.5280, -108.7426, 'Gallup, NM'],  '889': [36.1699, -115.1398, 'Las Vegas, NV'],
  '890': [36.1699, -115.1398, 'Las Vegas, NV'], '891': [36.1699, -115.1398, 'Las Vegas, NV'],
  '893': [39.1638, -119.7674, 'Carson City, NV'], '894': [39.5296, -119.8138, 'Reno, NV'],
  '895': [39.5296, -119.8138, 'Reno, NV'],    '897': [39.5296, -119.8138, 'Reno, NV'],
  '898': [40.7324, -114.0402, 'Elko, NV'],

  // 2026-05-26 — 279-entry backfill closing prior gaps in MA/NH/ME/VT/WV/IA/WI/MN/LA/OK
  //                NE/SD/ND/MT/MS/AR/AK/HI/PR/VI plus scattered single-state holes (AL/CA/FL/ID/IL/KS/MD/MO/NM/NV/WA/WY/AZ).
  //                Centroids are regional SCF / largest-city approximations.
  '005': [18.4655, -66.1057, 'San Juan, PR'], '006': [18.4655, -66.1057, 'San Juan, PR'],
  '007': [18.4655, -66.1057, 'San Juan, PR'], '008': [18.4655, -66.1057, 'San Juan, PR'],
  '009': [18.4655, -66.1057, 'San Juan, PR'], '010': [42.1015, -72.5898, 'Springfield, MA'],
  '011': [42.1015, -72.5898, 'Springfield, MA'], '012': [42.4501, -73.2454, 'Pittsfield, MA'],
  '013': [42.5876, -72.5995, 'Greenfield, MA'], '014': [42.2626, -71.8023, 'Worcester, MA'],
  '015': [42.2626, -71.8023, 'Worcester, MA'], '016': [42.2626, -71.8023, 'Worcester, MA'],
  '017': [42.2793, -71.4162, 'Framingham, MA'], '018': [42.4793, -71.1523, 'Woburn, MA'],
  '019': [42.4668, -70.9495, 'Lynn, MA'], '030': [42.9956, -71.4548, 'Manchester, NH'],
  '031': [42.9956, -71.4548, 'Manchester, NH'], '032': [42.9956, -71.4548, 'Manchester, NH'],
  '033': [43.2081, -71.5376, 'Concord, NH'], '034': [42.9956, -71.4548, 'Manchester, NH'],
  '035': [43.757, -71.6884, 'Plymouth, NH'], '036': [42.9336, -72.2789, 'Keene, NH'],
  '037': [43.6423, -72.2518, 'Lebanon, NH'], '038': [43.1979, -70.8737, 'Dover, NH'],
  '039': [43.0717, -70.7626, 'Portsmouth, NH'], '040': [43.6591, -70.2568, 'Portland, ME'],
  '041': [43.6591, -70.2568, 'Portland, ME'], '042': [43.6591, -70.2568, 'Portland, ME'],
  '043': [44.0979, -70.2312, 'Auburn, ME'], '044': [44.8016, -68.7712, 'Bangor, ME'],
  '045': [44.8016, -68.7712, 'Bangor, ME'], '046': [44.5588, -69.6336, 'Waterville, ME'],
  '047': [44.5588, -69.6336, 'Waterville, ME'], '048': [44.3106, -69.7795, 'Augusta, ME'],
  '049': [44.3106, -69.7795, 'Augusta, ME'], '050': [43.6492, -72.3258, 'White River Junction, VT'],
  '051': [43.1342, -72.4434, 'Bellows Falls, VT'], '052': [42.8781, -73.1968, 'Bennington, VT'],
  '053': [42.8509, -72.5579, 'Brattleboro, VT'], '054': [44.4759, -73.2121, 'Burlington, VT'],
  '055': [44.4759, -73.2121, 'Burlington, VT'], '056': [44.2601, -72.5754, 'Montpelier, VT'],
  '057': [44.4194, -72.0181, 'St. Johnsbury, VT'], '058': [44.4194, -72.0181, 'St. Johnsbury, VT'],
  '059': [42.8509, -72.5579, 'Brattleboro, VT'], '213': [39.4143, -77.4105, 'Frederick, MD'],
  '247': [37.7782, -81.1881, 'Beckley, WV'], '248': [37.8013, -80.4459, 'Lewisburg, WV'],
  '249': [37.7782, -81.1881, 'Beckley, WV'], '250': [38.3498, -81.6326, 'Charleston, WV'],
  '251': [38.3498, -81.6326, 'Charleston, WV'], '252': [38.3498, -81.6326, 'Charleston, WV'],
  '253': [38.4192, -82.4452, 'Huntington, WV'], '254': [39.4561, -77.9636, 'Martinsburg, WV'],
  '255': [38.4192, -82.4452, 'Huntington, WV'], '256': [37.8013, -80.4459, 'Lewisburg, WV'],
  '257': [37.2698, -81.2223, 'Bluefield, WV'], '258': [37.7782, -81.1881, 'Beckley, WV'],
  '259': [37.2698, -81.2223, 'Bluefield, WV'], '260': [40.0639, -80.7209, 'Wheeling, WV'],
  '261': [39.2667, -81.5615, 'Parkersburg, WV'], '262': [38.9928, -80.232, 'Buckhannon, WV'],
  '263': [39.2806, -80.3445, 'Clarksburg, WV'], '264': [39.2806, -80.3445, 'Clarksburg, WV'],
  '265': [39.6295, -79.9559, 'Morgantown, WV'], '266': [39.6295, -79.9559, 'Morgantown, WV'],
  '267': [39.009, -79.1239, 'Petersburg, WV'], '268': [39.6295, -79.9559, 'Morgantown, WV'],
  '340': [29.6516, -82.3248, 'Gainesville, FL'], '341': [27.4467, -80.3256, 'Fort Pierce, FL'],
  '342': [27.4467, -80.3256, 'Fort Pierce, FL'], '343': [27.4467, -80.3256, 'Fort Pierce, FL'],
  '344': [27.4467, -80.3256, 'Fort Pierce, FL'], '345': [27.4467, -80.3256, 'Fort Pierce, FL'],
  '346': [27.4467, -80.3256, 'Fort Pierce, FL'], '347': [27.4467, -80.3256, 'Fort Pierce, FL'],
  '348': [27.4467, -80.3256, 'Fort Pierce, FL'], '349': [27.4467, -80.3256, 'Fort Pierce, FL'],
  '353': [33.5186, -86.8104, 'Birmingham, AL'], '386': [33.749, -90.729, 'Clarksdale, MS'],
  '387': [33.4988, -90.1795, 'Greenville, MS'], '388': [34.2632, -88.7034, 'Tupelo, MS'],
  '389': [33.7951, -89.647, 'Grenada, MS'], '390': [32.2988, -90.1848, 'Jackson, MS'],
  '391': [32.2988, -90.1848, 'Jackson, MS'], '392': [32.2988, -90.1848, 'Jackson, MS'],
  '393': [32.3643, -88.7037, 'Meridian, MS'], '394': [31.3074, -89.3173, 'Hattiesburg, MS'],
  '395': [30.4113, -89.0928, 'Gulfport, MS'], '396': [31.5994, -91.5403, 'Natchez, MS'],
  '397': [33.4504, -88.8184, 'Columbus, MS'], '398': [32.5093, -92.1193, 'Monroe, LA'],
  '399': [33.749, -84.388, 'Atlanta, GA'], '500': [41.5868, -93.625, 'Des Moines, IA'],
  '501': [41.5868, -93.625, 'Des Moines, IA'], '502': [41.5868, -93.625, 'Des Moines, IA'],
  '503': [41.5868, -93.625, 'Des Moines, IA'], '504': [41.5868, -93.625, 'Des Moines, IA'],
  '505': [41.6611, -91.5302, 'Iowa City, IA'], '506': [41.6611, -91.5302, 'Iowa City, IA'],
  '507': [41.6611, -91.5302, 'Iowa City, IA'], '508': [41.0381, -92.4109, 'Ottumwa, IA'],
  '509': [41.0381, -92.4109, 'Ottumwa, IA'], '510': [42.4963, -96.4049, 'Sioux City, IA'],
  '511': [42.4963, -96.4049, 'Sioux City, IA'], '512': [42.4963, -96.4049, 'Sioux City, IA'],
  '513': [42.5006, -94.168, 'Fort Dodge, IA'], '514': [42.5006, -94.168, 'Fort Dodge, IA'],
  '515': [43.1547, -93.201, 'Mason City, IA'], '516': [43.1547, -93.201, 'Mason City, IA'],
  '517': [43.1547, -93.201, 'Mason City, IA'], '518': [43.418, -94.9978, 'Spencer, IA'],
  '519': [43.418, -94.9978, 'Spencer, IA'], '520': [42.5008, -90.6645, 'Dubuque, IA'],
  '521': [42.5008, -90.6645, 'Dubuque, IA'], '522': [41.9779, -91.6656, 'Cedar Rapids, IA'],
  '523': [41.9779, -91.6656, 'Cedar Rapids, IA'], '524': [41.6611, -91.5302, 'Iowa City, IA'],
  '525': [41.0381, -92.4109, 'Ottumwa, IA'], '526': [40.7392, -91.1129, 'Burlington, IA'],
  '527': [41.5236, -90.5776, 'Davenport, IA'], '528': [41.5236, -90.5776, 'Davenport, IA'],
  '530': [43.0389, -87.9065, 'Milwaukee, WI'], '531': [43.0389, -87.9065, 'Milwaukee, WI'],
  '532': [43.0389, -87.9065, 'Milwaukee, WI'], '533': [43.0389, -87.9065, 'Milwaukee, WI'],
  '534': [42.7261, -87.7829, 'Racine, WI'], '535': [43.0731, -89.4012, 'Madison, WI'],
  '536': [43.5391, -89.4629, 'Portage, WI'], '537': [43.0731, -89.4012, 'Madison, WI'],
  '538': [43.5391, -89.4629, 'Portage, WI'], '539': [43.7844, -88.7879, 'Oshkosh, WI'],
  '540': [44.5191, -88.0198, 'Green Bay, WI'], '541': [44.5191, -88.0198, 'Green Bay, WI'],
  '542': [44.5191, -88.0198, 'Green Bay, WI'], '543': [43.7844, -88.7879, 'Oshkosh, WI'],
  '544': [44.5191, -88.0198, 'Green Bay, WI'], '545': [45.5586, -88.0598, 'Rhinelander, WI'],
  '546': [44.7942, -91.4985, 'Eau Claire, WI'], '547': [44.7942, -91.4985, 'Eau Claire, WI'],
  '548': [44.9591, -89.6301, 'Wausau, WI'], '549': [44.9591, -89.6301, 'Wausau, WI'],
  '550': [44.9778, -93.265, 'Minneapolis, MN'], '551': [44.9537, -93.09, 'St. Paul, MN'],
  '552': [44.9778, -93.265, 'Minneapolis, MN'], '553': [44.9778, -93.265, 'Minneapolis, MN'],
  '554': [44.9778, -93.265, 'Minneapolis, MN'], '555': [44.9778, -93.265, 'Minneapolis, MN'],
  '556': [46.7867, -92.1005, 'Duluth, MN'], '557': [46.7867, -92.1005, 'Duluth, MN'],
  '558': [46.7867, -92.1005, 'Duluth, MN'], '559': [44.0121, -92.4802, 'Rochester, MN'],
  '560': [43.6663, -93.3613, 'Albert Lea, MN'], '561': [44.0121, -92.4802, 'Rochester, MN'],
  '562': [44.1636, -94.0007, 'Mankato, MN'], '563': [45.5579, -94.1632, 'St. Cloud, MN'],
  '564': [45.5579, -94.1632, 'St. Cloud, MN'], '565': [46.3527, -94.2008, 'Brainerd, MN'],
  '566': [47.0526, -95.8419, 'Park Rapids, MN'], '567': [46.8772, -96.7898, 'Moorhead, MN'],
  '570': [43.546, -96.7313, 'Sioux Falls, SD'], '571': [43.546, -96.7313, 'Sioux Falls, SD'],
  '572': [44.3683, -98.2143, 'Huron, SD'], '573': [43.7294, -98.0298, 'Mitchell, SD'],
  '574': [45.4647, -98.4865, 'Aberdeen, SD'], '575': [45.4647, -98.4865, 'Aberdeen, SD'],
  '576': [45.4647, -98.4865, 'Aberdeen, SD'], '577': [44.0805, -103.231, 'Rapid City, SD'],
  '580': [46.8772, -96.7898, 'Fargo, ND'], '581': [46.8772, -96.7898, 'Fargo, ND'],
  '582': [47.9253, -97.0329, 'Grand Forks, ND'], '583': [47.9253, -97.0329, 'Grand Forks, ND'],
  '584': [47.4719, -99.1502, 'Devils Lake, ND'], '585': [46.8083, -100.7837, 'Bismarck, ND'],
  '586': [46.8083, -100.7837, 'Bismarck, ND'], '587': [46.8083, -100.7837, 'Bismarck, ND'],
  '588': [48.233, -101.296, 'Minot, ND'], '590': [45.7833, -108.5007, 'Billings, MT'],
  '591': [45.7833, -108.5007, 'Billings, MT'], '592': [47.0527, -109.4543, 'Lewistown, MT'],
  '593': [47.5053, -111.3008, 'Great Falls, MT'], '594': [46.5891, -112.0391, 'Helena, MT'],
  '595': [47.5053, -111.3008, 'Great Falls, MT'], '596': [48.2026, -114.3137, 'Kalispell, MT'],
  '597': [46.8721, -113.994, 'Missoula, MT'], '598': [45.677, -111.0429, 'Bozeman, MT'],
  '599': [45.7833, -108.5007, 'Billings, MT'], '621': [38.627, -90.1994, 'St. Louis, MO'],
  '632': [39.7095, -91.91, 'Hannibal, MO'], '642': [39.7676, -94.8467, 'St. Joseph, MO'],
  '643': [39.7676, -94.8467, 'St. Joseph, MO'], '663': [38.8403, -97.6114, 'Salina, KS'],
  '680': [41.2565, -95.9345, 'Omaha, NE'], '681': [41.2565, -95.9345, 'Omaha, NE'],
  '682': [41.2565, -95.9345, 'Omaha, NE'], '683': [40.8136, -96.7026, 'Lincoln, NE'],
  '684': [40.8136, -96.7026, 'Lincoln, NE'], '685': [40.8136, -96.7026, 'Lincoln, NE'],
  '686': [40.6939, -89.589, 'Norfolk, NE'], '687': [42.0286, -97.417, 'Norfolk, NE'],
  '688': [40.9264, -98.342, 'Grand Island, NE'], '689': [40.9264, -98.342, 'Grand Island, NE'],
  '690': [41.137, -100.7654, 'North Platte, NE'], '691': [41.137, -100.7654, 'North Platte, NE'],
  '692': [42.0853, -102.874, 'Alliance, NE'], '693': [41.8666, -103.6672, 'Scottsbluff, NE'],
  '700': [29.9511, -90.0715, 'New Orleans, LA'], '701': [29.9511, -90.0715, 'New Orleans, LA'],
  '702': [29.9511, -90.0715, 'New Orleans, LA'], '703': [29.7035, -90.3879, 'Houma, LA'],
  '704': [30.0211, -90.4063, 'LaPlace, LA'], '705': [30.2241, -92.0198, 'Lafayette, LA'],
  '706': [30.2241, -92.0198, 'Lafayette, LA'], '707': [30.4515, -91.1871, 'Baton Rouge, LA'],
  '708': [30.4515, -91.1871, 'Baton Rouge, LA'], '709': [30.2266, -93.2174, 'Lake Charles, LA'],
  '710': [32.5093, -92.1193, 'Monroe, LA'], '711': [32.5093, -92.1193, 'Monroe, LA'],
  '712': [32.5252, -93.7502, 'Shreveport, LA'], '713': [32.5252, -93.7502, 'Shreveport, LA'],
  '714': [31.1801, -92.4451, 'Alexandria, LA'], '716': [33.749, -92.4421, 'Pine Bluff, AR'],
  '717': [33.6056, -92.0793, 'Camden, AR'], '718': [33.4504, -93.9929, 'Texarkana, AR'],
  '719': [34.5043, -93.0552, 'Hot Springs, AR'], '720': [34.7465, -92.2896, 'Little Rock, AR'],
  '721': [34.7465, -92.2896, 'Little Rock, AR'], '722': [34.7465, -92.2896, 'Little Rock, AR'],
  '723': [34.7445, -92.407, 'West Memphis, AR'], '724': [35.8423, -90.7043, 'Jonesboro, AR'],
  '725': [35.7717, -91.771, 'Batesville, AR'], '726': [35.4677, -94.3641, 'Harrison, AR'],
  '727': [36.0625, -94.1574, 'Fayetteville, AR'], '728': [35.3859, -94.3985, 'Fort Smith, AR'],
  '729': [35.483, -93.4671, 'Russellville, AR'], '730': [35.4676, -97.5164, 'Oklahoma City, OK'],
  '731': [35.4676, -97.5164, 'Oklahoma City, OK'], '732': [35.4676, -97.5164, 'Oklahoma City, OK'],
  '733': [35.4676, -97.5164, 'Oklahoma City, OK'], '734': [34.6087, -98.3903, 'Lawton, OK'],
  '735': [34.6087, -98.3903, 'Lawton, OK'], '736': [35.5395, -98.6679, 'Clinton, OK'],
  '737': [36.2614, -99.6395, 'Woodward, OK'], '738': [36.7281, -101.8554, 'Guymon, OK'],
  '739': [36.407, -97.8784, 'Enid, OK'], '740': [36.154, -95.9928, 'Tulsa, OK'],
  '741': [36.154, -95.9928, 'Tulsa, OK'], '742': [36.154, -95.9928, 'Tulsa, OK'],
  '743': [36.154, -95.9928, 'Tulsa, OK'], '744': [35.7479, -95.3697, 'Muskogee, OK'],
  '745': [34.9261, -95.7697, 'McAlester, OK'], '746': [36.7059, -97.0758, 'Ponca City, OK'],
  '747': [33.9137, -98.4934, 'Wichita Falls, TX'], '748': [34.0184, -97.15, 'Durant, OK'],
  '749': [34.9803, -94.7299, 'Poteau, OK'], '823': [42.8666, -106.3131, 'Casper, WY'],
  '824': [42.8666, -106.3131, 'Casper, WY'], '825': [43.076, -107.2903, 'Riverton, WY'],
  '826': [44.2839, -105.506, 'Gillette, WY'], '827': [44.7972, -106.9559, 'Sheridan, WY'],
  '829': [41.3114, -105.5911, 'Laramie, WY'], '834': [42.563, -114.4609, 'Twin Falls, ID'],
  '858': [32.2226, -110.9747, 'Tucson, AZ'], '861': [34.54, -112.4685, 'Prescott, AZ'],
  '862': [33.4484, -112.074, 'Phoenix, AZ'], '876': [35.687, -105.9378, 'Santa Fe, NM'],
  '879': [35.0844, -106.6504, 'Albuquerque, NM'], '892': [36.1699, -115.1398, 'Las Vegas, NV'],
  '896': [39.5296, -119.8138, 'Reno, NV'], '909': [34.1064, -117.5931, 'San Bernardino, CA'],
  '942': [38.5816, -121.4944, 'Sacramento, CA'], '967': [21.3099, -157.8581, 'Honolulu, HI'],
  '968': [21.3099, -157.8581, 'Honolulu, HI'], '987': [47.6588, -117.426, 'Spokane, WA'],
  '995': [61.2181, -149.9003, 'Anchorage, AK'], '996': [61.2181, -149.9003, 'Anchorage, AK'],
  '997': [64.8378, -147.7164, 'Fairbanks, AK'], '998': [58.3019, -134.4197, 'Juneau, AK'],
  '999': [61.2181, -149.9003, 'Anchorage, AK'],
};

/**
 * Resolve a user-entered location query into { name, lat, lng } — or null if
 * no match. Accepts:
 *   - "City, ST"       → exact/case-insensitive city match
 *   - "City"           → first city match (ignoring state)
 *   - 3-digit ZIP (e.g. "100", "904")       → ZIP3 centroid
 *   - 5-digit ZIP (e.g. "10001")           → first 3 digits → ZIP3 centroid
 * @param {string} q
 * @returns {{name:string, lat:number, lng:number}|null}
 */
export function lookupLocation(q) {
  if (!q) return null;
  const raw = String(q).trim();
  if (!raw) return null;

  // Numeric path: ZIP5 or ZIP3
  if (/^\d{3,5}$/.test(raw)) {
    const z3 = raw.slice(0, 3).padStart(3, '0');
    const hit = ZIP3_CENTROIDS[z3];
    if (hit) return { name: `${hit[2]} (ZIP ${raw})`, lat: hit[0], lng: hit[1] };
    return null;
  }

  // "City, ST" or just "City"
  const parts = raw.split(',').map(s => s.trim());
  const cityQ = parts[0].toLowerCase();
  const stateQ = parts[1] ? parts[1].toUpperCase() : null;

  // Exact + state match first, then city-only fallback.
  const stateExact = stateQ
    ? CITY_CENTROIDS.find(c => c.name.toLowerCase() === cityQ && c.state === stateQ)
    : null;
  if (stateExact) return { name: `${stateExact.name}, ${stateExact.state}`, lat: stateExact.lat, lng: stateExact.lng };

  const cityExact = CITY_CENTROIDS.find(c => c.name.toLowerCase() === cityQ);
  if (cityExact) return { name: `${cityExact.name}, ${cityExact.state}`, lat: cityExact.lat, lng: cityExact.lng };

  // Partial-match fallback (starts-with)
  const starts = CITY_CENTROIDS.find(c => c.name.toLowerCase().startsWith(cityQ) && (!stateQ || c.state === stateQ));
  if (starts) return { name: `${starts.name}, ${starts.state}`, lat: starts.lat, lng: starts.lng };

  return null;
}

/**
 * Anchor-metro set used by the archetype weight generator. Must remain a
 * subset of CITY_CENTROIDS so the two tables stay consistent; filtered at
 * load time (rather than hardcoded) to prevent drift.
 */
const _ARCHETYPE_ANCHOR_NAMES = new Set([
  'New York Metro','Philadelphia','Boston','Washington DC','Pittsburgh','Baltimore',
  'Atlanta','Miami','Tampa','Charlotte','Nashville','Orlando','Jacksonville','Raleigh','Memphis',
  'Chicago','Detroit','Minneapolis','St. Louis','Kansas City','Indianapolis','Columbus','Cincinnati','Cleveland',
  'Houston','Dallas','Austin','San Antonio','Phoenix',
  'Los Angeles','San Francisco','San Diego','Sacramento','Seattle','Portland','Denver','Salt Lake City','Las Vegas',
]);
const ARCHETYPE_METROS = CITY_CENTROIDS.filter(m =>
  _ARCHETYPE_ANCHOR_NAMES.has(m.name) &&
  // Prefer the canonical state per anchor — Portland=OR, Columbus=OH, Springfield=all skipped,
  // so de-dupe by anchor name taking the first match (CITY_CENTROIDS is ordered by region).
  m === CITY_CENTROIDS.find(c => c.name === m.name)
);

/**
 * Archetype catalog. Each entry specifies region weights plus a small boost
 * for anchor metros characteristic of that vertical. Total unit volume gets
 * distributed across ARCHETYPE_METROS according to the effective weight.
 * @type {Record<string, {name:string, desc:string, regionWeights:Record<string,number>, anchorBoost?:Record<string,number>, defaultTotalUnits:number}>}
 */
export const COG_ARCHETYPES = {
  dtc_national: {
    name: 'DTC E-Commerce — National',
    desc: 'Population-weighted parcel distribution across major metros.',
    regionWeights: { NE: 1.3, SE: 1.0, MW: 0.9, SW: 0.8, W: 1.1 },
    anchorBoost: { 'New York Metro': 1.4, 'Los Angeles': 1.4, 'Chicago': 1.2, 'Atlanta': 1.2 },
    defaultTotalUnits: 5_000_000,
  },
  dtc_east: {
    name: 'DTC E-Commerce — East Coast Heavy',
    desc: 'Concentrated in the BosWash corridor + Southeast.',
    regionWeights: { NE: 2.2, SE: 1.2, MW: 0.5, SW: 0.3, W: 0.4 },
    anchorBoost: { 'New York Metro': 1.6, 'Boston': 1.3, 'Philadelphia': 1.2, 'Atlanta': 1.2 },
    defaultTotalUnits: 4_000_000,
  },
  dtc_west: {
    name: 'DTC E-Commerce — West Coast Heavy',
    desc: 'Concentrated in CA / WA / OR markets.',
    regionWeights: { NE: 0.5, SE: 0.4, MW: 0.3, SW: 0.6, W: 2.5 },
    anchorBoost: { 'Los Angeles': 1.8, 'San Francisco': 1.4, 'Seattle': 1.3, 'San Diego': 1.1 },
    defaultTotalUnits: 3_500_000,
  },
  retail_bigbox: {
    name: 'Retail — Big Box (Walmart/Target/Costco)',
    desc: 'Distribution centers that feed big-box retailers nationwide.',
    regionWeights: { NE: 0.9, SE: 1.2, MW: 1.1, SW: 1.0, W: 0.8 },
    anchorBoost: { 'Dallas': 1.3, 'Atlanta': 1.3, 'Memphis': 1.2, 'Chicago': 1.2 },
    defaultTotalUnits: 12_000_000,
  },
  grocery: {
    name: 'CPG → Grocery Chains',
    desc: 'Kroger / Publix / Albertsons DC flows.',
    regionWeights: { NE: 1.0, SE: 1.1, MW: 1.2, SW: 0.8, W: 0.9 },
    anchorBoost: { 'Cincinnati': 1.3, 'Atlanta': 1.2, 'Chicago': 1.2, 'Denver': 1.1 },
    defaultTotalUnits: 10_000_000,
  },
  industrial_mro: {
    name: 'Industrial / MRO Distribution',
    desc: 'Manufacturing-belt heavy B2B industrial distribution.',
    regionWeights: { NE: 0.8, SE: 0.7, MW: 1.8, SW: 0.6, W: 0.5 },
    anchorBoost: { 'Detroit': 1.5, 'Chicago': 1.4, 'Cleveland': 1.3, 'Pittsburgh': 1.2 },
    defaultTotalUnits: 2_500_000,
  },
  food_bev: {
    name: 'Food & Beverage',
    desc: 'Cold-chain sensitive distribution; population-weighted.',
    regionWeights: { NE: 1.2, SE: 1.1, MW: 1.0, SW: 0.8, W: 1.0 },
    anchorBoost: { 'Los Angeles': 1.3, 'Chicago': 1.2, 'Atlanta': 1.1 },
    defaultTotalUnits: 6_000_000,
  },
  healthcare: {
    name: 'Healthcare / Pharma',
    desc: 'Hospital + pharmacy distribution, metro-dense.',
    regionWeights: { NE: 1.4, SE: 1.0, MW: 0.9, SW: 0.7, W: 1.0 },
    anchorBoost: { 'Boston': 1.4, 'Philadelphia': 1.2, 'Nashville': 1.2, 'New York Metro': 1.3 },
    defaultTotalUnits: 3_000_000,
  },
  auto_parts: {
    name: 'Auto Parts / Aftermarket',
    desc: 'Broad distribution weighted by vehicle density.',
    regionWeights: { NE: 0.9, SE: 1.2, MW: 1.1, SW: 1.0, W: 0.9 },
    anchorBoost: { 'Dallas': 1.3, 'Atlanta': 1.2, 'Detroit': 1.2, 'Phoenix': 1.1 },
    defaultTotalUnits: 4_500_000,
  },
  tech_bto: {
    name: 'Build-to-Order / Tech / Electronics',
    desc: 'Tech hubs + major metros with parcel-heavy mix.',
    regionWeights: { NE: 1.1, SE: 0.7, MW: 0.6, SW: 0.8, W: 1.6 },
    anchorBoost: { 'San Francisco': 1.6, 'Seattle': 1.4, 'Austin': 1.3, 'Los Angeles': 1.2 },
    defaultTotalUnits: 2_000_000,
  },
};

/**
 * Generate a set of demand points from an archetype + total volume.
 * @param {string} archetypeKey key in COG_ARCHETYPES
 * @param {number} [totalUnits] total annual volume; falls back to archetype default
 * @returns {import('./types.js?v=20260418-sP').WeightedPoint[]}
 */
export function generateArchetypePoints(archetypeKey, totalUnits) {
  const arch = COG_ARCHETYPES[archetypeKey];
  if (!arch) return [];
  const total = totalUnits > 0 ? totalUnits : arch.defaultTotalUnits;
  // Compute raw weight per metro = regionWeight × anchorBoost (default 1).
  const raw = ARCHETYPE_METROS.map(m => {
    const rw = arch.regionWeights[m.region] || 1;
    const ab = (arch.anchorBoost && arch.anchorBoost[m.name]) || 1;
    return { metro: m, w: rw * ab };
  });
  const sumW = raw.reduce((s, r) => s + r.w, 0) || 1;
  // Scale to total units, round to whole units, preserve stable IDs.
  return raw
    .map((r, i) => ({
      id: `arch-${archetypeKey}-${i}`,
      name: r.metro.name,
      lat: r.metro.lat,
      lng: r.metro.lng,
      weight: Math.round((r.w / sumW) * total),
      type: /** @type {any} */ ('demand'),
    }))
    .filter(p => p.weight > 0);
}

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

// ============================================================
// runScenario — calc-as-service wrapper (port-readiness S8)
// ============================================================
//
// Standardized entry point for external callers (HTTP / MCP / AI agents).
// Computes COG (k=1) or k-means clusters (k>=2) + transport cost estimate.
export const ENGINE_VERSION = '1.0.0';

/**
 * Run a Center of Gravity scenario.
 * @param {{
 *   points: Array<{ id: string, lat: number, lng: number, weight: number }>,
 *   k?: number,
 *   maxIter?: number,
 *   costPerMile?: number,
 *   unitsPerTruck?: number,
 * }} params
 * @returns {{ ok: boolean, version: string, result: any, errors: string[] }}
 */
export function runScenario(params) {
  if (params == null || typeof params !== 'object') params = {};
  const errors = [];
  if (!Array.isArray(params.points)) errors.push('points must be an array');
  else if (params.points.length === 0) errors.push('points must be non-empty');
  if (params.k != null && (!Number.isFinite(params.k) || params.k < 1)) errors.push('k must be a positive integer when provided');
  if (errors.length) return { ok: false, version: ENGINE_VERSION, result: null, errors };
  const k = Math.max(1, Math.min(Number(params.k) || 1, params.points.length));
  const cogResult = k === 1 ? {
    centers: [computeCog(params.points)],
    assignments: params.points.map(p => ({
      pointId: p.id, clusterId: 0,
      distanceToCenter: haversine(p.lat, p.lng,
        params.points.length ? computeCog(params.points).lat : 0,
        params.points.length ? computeCog(params.points).lng : 0)
    })),
    iterations: 0,
    totalWeightedDistance: 0,
  } : kMeansCog(params.points, k, Number(params.maxIter) || 100);
  const cost = estimateTransportCost(
    cogResult,
    params.points,
    Number(params.costPerMile) || DEFAULT_TL_RATE_PER_MILE,
    Number(params.unitsPerTruck) || 25000
  );
  return { ok: true, version: ENGINE_VERSION, result: { ...cogResult, transportCost: cost }, errors: [] };
}

/**
 * 2026-06-10 Phase 2c (ground-up assessment) — canonical display metrics.
 * The assessment found the same quantity computed with DIFFERENT
 * denominators across surfaces: CM writeback + Compare divided weighted
 * distance by raw/unscaled/excluded-inclusive weight, the deck divided cost
 * by raw weight, the benchmark card by the scaled solve weight. One helper,
 * one denominator: the SOLVE set (excluded rows out, demand scale applied) —
 * the same population the engine costs. Every display surface routes here.
 *
 * @param {Object} result — enriched cogResult (or a saved scenario's result)
 * @param {Object} config — scenario config (CO₂ intensities, etc.)
 * @param {Array}  solvePts — the solve-set points (excluded out, scale applied)
 * @returns {{ totalSolveWeight:number, totalCost:number,
 *   avgWeightedDistanceMi:number|null, costPerUnit:number|null,
 *   co2Tons:number, truckCo2Tons:number, parcelCo2Tons:number }}
 */
export function deriveCogDisplayMetrics(result, config, solvePts) {
  const pts = Array.isArray(solvePts) ? solvePts : [];
  const totalSolveWeight = pts.reduce((s, p) => s + (+p?.weight || 0), 0);
  const totalCost = +result?.totalCost || 0;
  const avgWeightedDistanceMi =
    (totalSolveWeight > 0 && Number.isFinite(+result?.totalWeightedDistance))
      ? result.totalWeightedDistance / totalSolveWeight
      : null;
  // Prefer the engine's own per-unit figure (F13) — fall back to the
  // canonical division only when reading older saved results.
  const costPerUnit = Number.isFinite(+result?.avgCostPerUnit)
    ? +result.avgCostPerUnit
    : (totalSolveWeight > 0 && totalCost > 0 ? totalCost / totalSolveWeight : null);
  const truckCo2Tons = Number.isFinite(+result?.truckCo2Tons)
    ? +result.truckCo2Tons
    : ((+result?.totalTruckMiles || 0) * (Math.max(0, +config?.co2KgPerTruckMile || 1.62))) / 1000;
  const parcelCo2Tons = Number.isFinite(+result?.parcelCo2Tons)
    ? +result.parcelCo2Tons
    : ((result?.parcelDetails?.totalPackages || 0) * (+config?.parcelCo2KgPerPkg || 0.5)) / 1000;
  const co2Tons = Number.isFinite(+result?.co2Tons) ? +result.co2Tons : truckCo2Tons + parcelCo2Tons;
  return { totalSolveWeight, totalCost, avgWeightedDistanceMi, costPerUnit, co2Tons, truckCo2Tons, parcelCo2Tons };
}


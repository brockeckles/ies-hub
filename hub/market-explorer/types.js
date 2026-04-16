/**
 * IES Hub v3 — Market Explorer Type Definitions
 * @module hub/market-explorer/types
 */

/**
 * @typedef {Object} MarketData
 * @property {string} id
 * @property {string} name — MSA / market name
 * @property {string} region — geographic region
 * @property {number} lat
 * @property {number} lng
 * @property {number} laborScore — 0-100 labor availability index
 * @property {number} avgWage — average hourly warehouse wage
 * @property {number} unemploymentRate — %
 * @property {number} warehouseRate — $/sqft/yr industrial real estate
 * @property {number} availabilityPct — % vacant industrial space
 * @property {number} freightIndex — normalized freight cost index
 * @property {number} activeDeals — count of active deals in market
 * @property {string[]} verticals — primary verticals
 * @property {string} gxoPresence — 'active' | 'target' | 'none'
 */

/**
 * @typedef {Object} MarketStats
 * @property {number} totalMarkets
 * @property {number} avgLaborScore
 * @property {number} avgWage
 * @property {number} avgWarehouseRate
 * @property {number} marketsWithDeals
 */

/**
 * @typedef {Object} MarketAlert
 * @property {string} type — 'labor' | 'freight' | 'competitor' | 'tariff'
 * @property {string} market
 * @property {string} message
 * @property {string} severity — 'info' | 'warning' | 'critical'
 * @property {string} date
 */

export {};

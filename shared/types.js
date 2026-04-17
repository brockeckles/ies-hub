/**
 * IES Hub v3 — Global Type Definitions
 * JSDoc typedefs shared across all tools and modules.
 *
 * Import this file for type hints:
 *   /** @typedef {import('../shared/types.js?v=20260417-p2').CostModel} CostModel *​/
 *
 * @module shared/types
 */

// ---- User & Auth ----

/**
 * @typedef {Object} HubUser
 * @property {boolean} authenticated
 * @property {string} [email]
 * @property {'admin'|'user'|'viewer'} [role]
 */

// ---- Navigation ----

/**
 * @typedef {Object} NavState
 * @property {string} section — current sidebar section key
 * @property {string|null} tool — active design tool key (null if not in design tools)
 */

// ---- Cost Model ----

/**
 * @typedef {Object} CostModel
 * @property {number} [id]
 * @property {string} name
 * @property {number} [opportunity_id]
 * @property {ProjectDetails} projectDetails
 * @property {LaborLine[]} directLabor
 * @property {LaborLine[]} indirectLabor
 * @property {EquipmentLine[]} equipment
 * @property {OverheadLine[]} overhead
 * @property {VASLine[]} vas
 * @property {Object} summary
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} ProjectDetails
 * @property {string} clientName
 * @property {string} facilityLocation
 * @property {number} facilitySize
 * @property {number} operatingHours
 * @property {number} annualVolume
 * @property {string} volumeUnit
 * @property {number} contractTerm
 * @property {number} [startupCost]
 * @property {number} [managementFee]
 * @property {number} [targetMargin]
 */

/**
 * @typedef {Object} LaborLine
 * @property {string} role
 * @property {number} headcount
 * @property {number} rate
 * @property {number} annual_hours
 * @property {number} [burden_pct]
 * @property {number} [benefits]
 * @property {number} [shift_differential]
 * @property {number} [ot_pct]
 * @property {number} [bonus_pct]
 */

/**
 * @typedef {Object} EquipmentLine
 * @property {string} name
 * @property {number} qty
 * @property {number} unit_cost
 * @property {'purchase'|'lease'} ownership
 * @property {number} [useful_life]
 * @property {number} [lease_monthly]
 * @property {number} [maintenance_pct]
 */

/**
 * @typedef {Object} OverheadLine
 * @property {string} category
 * @property {number} amount
 * @property {'monthly'|'annual'} cost_type
 * @property {string} [notes]
 */

/**
 * @typedef {Object} VASLine
 * @property {string} service
 * @property {number} [rate]
 * @property {number} [volume]
 * @property {number} [total_cost]
 */

// ---- Warehouse Sizing ----

/**
 * @typedef {Object} FacilityConfig
 * @property {number} length
 * @property {number} width
 * @property {number} clearHeight
 * @property {number} dockDoors
 * @property {number} [aisleWidth]
 * @property {string} [rackingType]
 */

// ---- Fleet Modeler ----

/**
 * @typedef {Object} FleetVehicle
 * @property {string} type
 * @property {number} count
 * @property {number} costPerMile
 * @property {number} [avgMilesPerDay]
 * @property {'owned'|'leased'|'contracted'} ownership
 */

// ---- Deal / Opportunity ----

/**
 * @typedef {Object} Opportunity
 * @property {number} id
 * @property {string} name
 * @property {string} client
 * @property {string} stage — DOS stage key
 * @property {number} [estimatedRevenue]
 * @property {string} [owner]
 * @property {string} [created_at]
 */

/**
 * @typedef {Object} DOSStage
 * @property {string} key
 * @property {string} name
 * @property {number} order
 * @property {string[]} templateKeys
 */

// ---- Validation ----

/**
 * @typedef {Object} ValidationWarning
 * @property {'info'|'warning'|'error'} level
 * @property {string} area — which section (e.g. 'labor', 'equipment')
 * @property {string} message
 */

export {};

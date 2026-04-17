/**
 * IES Hub v3 — Warehouse Sizing Calculator Types
 * JSDoc typedefs for facility config, storage zones, capacity calcs, and 3D scene.
 *
 * @module tools/warehouse-sizing/types
 */

// ============================================================
// FACILITY CONFIGURATION
// ============================================================

/**
 * @typedef {Object} FacilityConfig
 * @property {string} [id]
 * @property {string} name
 * @property {number} totalSqft — total building square footage
 * @property {number} clearHeight — clear height in feet
 * @property {number} buildingWidth — building width in feet
 * @property {number} buildingDepth — building depth in feet
 * @property {number} dockDoors — total dock doors
 * @property {number} columnSpacingX — column spacing along width (ft)
 * @property {number} columnSpacingY — column spacing along depth (ft)
 * @property {'single' | 'double' | 'bulk' | 'carton' | 'mix'} storageType
 * @property {number} [aisleWidth] — in feet (default varies by storage type)
 * @property {number} [palletWidth] — standard pallet width in inches (default 48)
 * @property {number} [palletDepth] — standard pallet depth in inches (default 40)
 * @property {number} [palletHeight] — pallet load height in inches (default 54)
 * @property {number} [beamHeight] — beam height in inches (default 5)
 * @property {number} [flueSpace] — flue space between pallets in inches (default 3)
 * @property {number} [topClearance] — sprinkler clearance at top in inches (default 36)
 */

/**
 * @typedef {Object} StorageAllocation
 * @property {number} fullPallet — percentage full pallet storage (0-100)
 * @property {number} cartonOnPallet — percentage carton-on-pallet (0-100)
 * @property {number} cartonOnShelving — percentage carton-on-shelving (0-100)
 */

/**
 * @typedef {Object} DockConfig
 * @property {'single' | 'two'} sided — single-sided (combined doors) or two-sided (separate inbound/outbound)
 * @property {number} inboundDoors — number of inbound dock doors
 * @property {number} outboundDoors — number of outbound dock doors
 * @property {number} palletsPerDockHour — throughput capacity per dock door per hour
 * @property {number} dockOperatingHours — hours per day dock operates
 */

/**
 * @typedef {Object} ProductDimensions
 * @property {number} unitsPerPallet — standard units per full pallet
 * @property {number} unitsPerCartonPallet — units per carton on pallet
 * @property {number} cartonsPerPallet — number of cartons per full pallet
 * @property {number} unitsPerCartonShelving — units per carton in shelving
 * @property {number} cartonsPerLocation — cartons per shelving location
 */

/**
 * @typedef {Object} ForwardPickConfig
 * @property {boolean} enabled — whether forward pick area is included
 * @property {'carton_flow' | 'light_case' | 'heavy_case'} type — pick type determines sqft/module
 * @property {number} skuCount — number of SKUs in forward pick
 * @property {number} daysInventory — days of inventory maintained in forward pick (DIOH)
 * @property {number} outboundUnitsPerDay — daily outbound units
 */

/**
 * @typedef {Object} OptionalZone
 * @property {boolean} enabled
 * @property {number} sqft
 */

/**
 * @typedef {Object} CustomZone
 * @property {string} name
 * @property {number} sqft
 */

/**
 * @typedef {Object} ZoneConfig
 * @property {number} officeSqft — office / mezzanine area
 * @property {number} receiveStagingSqft — receiving staging area
 * @property {number} shipStagingSqft — shipping staging area
 * @property {number} chargingSqft — battery charging area
 * @property {number} repackSqft — repack / VAS area
 * @property {number} [otherSqft] — misc non-storage area
 * @property {import('./types.js?v=20260417-pa').StorageAllocation} [storageAllocation] — mix of storage types
 * @property {import('./types.js?v=20260417-pa').DockConfig} [dockConfig] — dock configuration
 * @property {import('./types.js?v=20260417-pa').ProductDimensions} [productDimensions] — product sizing
 * @property {import('./types.js?v=20260417-pa').ForwardPickConfig} [forwardPick] — forward pick area config
 * @property {{ vas: OptionalZone, returns: OptionalZone, chargeback: OptionalZone }} [optionalZones] — optional functional zones
 * @property {import('./types.js?v=20260417-pa').CustomZone[]} [customZones] — user-defined zones
 * @property {number} [peakUnitsPerDay] — peak daily unit throughput
 * @property {number} [avgUnitsPerDay] — average daily unit throughput
 * @property {number} [operatingDaysPerYear] — annual operating days
 */

/**
 * @typedef {Object} VolumeInputs
 * @property {number} totalPallets — total pallet positions needed
 * @property {number} [totalSKUs] — number of SKUs
 * @property {number} [inventoryTurns] — annual inventory turns
 * @property {number} [avgDailyInbound] — pallets/day inbound
 * @property {number} [avgDailyOutbound] — pallets/day outbound
 * @property {number} [peakMultiplier] — peak vs. average ratio (default 1.3)
 */

// ============================================================
// CALCULATION RESULTS
// ============================================================

/**
 * @typedef {Object} StorageCalcResult
 * @property {number} rackLevels — number of rack levels that fit
 * @property {number} palletPositionsPerBay — positions per single bay
 * @property {number} bayWidth — width of one bay in feet
 * @property {number} bayDepth — depth of one bay in feet
 * @property {number} aisleCount — number of aisles
 * @property {number} bayCountPerAisle — bays per aisle side
 * @property {number} totalPalletPositions — total capacity
 * @property {number} storageSqft — net storage floor area
 * @property {number} storageUtilization — storageSqft / totalSqft
 * @property {number} usableHeight — clear height minus top clearance
 * @property {number} positionHeight — single level height (pallet + beam + flue)
 */

/**
 * @typedef {Object} CapacitySummary
 * @property {number} totalSqft
 * @property {number} storageSqft
 * @property {number} nonStorageSqft
 * @property {number} storageUtilizationPct — storage as % of total
 * @property {number} totalPalletPositions
 * @property {number} rackLevels
 * @property {number} cubicFtStorage — storageSqft × usableHeight
 * @property {number} cubicUtilizationPct
 * @property {number} palletPositionsNeeded
 * @property {number} capacityUtilizationPct — needed / available
 * @property {number} dockDoorUtilization — daily pallets / (doors × capacity/door)
 * @property {number} suggestedSqft — heuristic-based recommended sqft
 */

/**
 * @typedef {Object} ElevationParams
 * @property {number} buildingWidth
 * @property {number} clearHeight
 * @property {number} rackLevels
 * @property {number} positionHeight — height per level in feet
 * @property {number} topClearanceFt
 * @property {'single' | 'double' | 'bulk' | 'carton' | 'mix'} storageType
 * @property {number} aisleWidth
 * @property {number} rackDepthFt — depth of one rack in feet
 * @property {number} dockDoors
 */

// ============================================================
// INTEGRATION (WSC ↔ CM)
// ============================================================

/**
 * Payload emitted on bus 'wsc:push-to-cm' event.
 * @typedef {Object} WscToCmPayload
 * @property {number} totalSqft
 * @property {number} clearHeight
 * @property {number} dockDoors
 * @property {number} officeSqft
 * @property {number} stagingSqft — receive + ship staging
 */

/**
 * Payload received on bus 'cm:push-to-wsc' event.
 * @typedef {Object} CmToWscPayload
 * @property {number} [clearHeight]
 * @property {number} [totalSqft]
 */

export {};

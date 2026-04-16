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
 * @typedef {Object} ZoneConfig
 * @property {number} officeSqft — office / mezzanine area
 * @property {number} receiveStagingSqft — receiving staging area
 * @property {number} shipStagingSqft — shipping staging area
 * @property {number} chargingSqft — battery charging area
 * @property {number} repackSqft — repack / VAS area
 * @property {number} [otherSqft] — misc non-storage area
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

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
 * @property {'design' | 'constraint'} [sizingMode] — Phase A (2026-05-05): explicit
 *   sizing mode. 'design' = inventory drives building dims (engine answer is the
 *   single output); 'constraint' = user W×D is a constraint, tool answers the
 *   capacity gap. Replaces the buildingDimsOverride checkbox semantics.
 *   Default 'design'. Legacy facilities with buildingDimsOverride=true migrate
 *   to 'constraint' on load; all others to 'design'.
 * @property {number} [velocityTierAPct] — Phase B (2026-05-05): A-velocity
 *   SKU share (% of total SKUs, 0–100). Drives forward-pick demand and reserve
 *   slotting tilt. Default for new facilities: 20% (Pareto). Legacy facilities
 *   without a value also default to 20% — engine output is unchanged because
 *   the existing forward-pick code path used activePickPct=20 as a hardcoded
 *   audit default.
 * @property {number} [velocityTierBPct] — B-velocity SKU share. Default 30%.
 * @property {number} [velocityTierCPct] — C-velocity SKU share. Default 50%.
 *   A+B+C should sum to 100 but are normalized at calc time if they don't.
 * @property {'throughput' | 'pallets'} [primaryInventoryInput] — Phase B
 *   (2026-05-05): which inventory UOM the user is driving from in Step 1.
 *   'throughput' (default) = user enters annual/daily outbound + DOH + peak,
 *   on-hand pallets/units derive. 'pallets' = user enters on-hand pallet
 *   positions directly, throughput derives. The non-active path renders as
 *   a read-only computed tile.
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
 * @property {import('./types.js?v=20260418-sL').StorageAllocation} [storageAllocation] — mix of storage types
 * @property {import('./types.js?v=20260418-sL').DockConfig} [dockConfig] — dock configuration
 * @property {import('./types.js?v=20260418-sL').ProductDimensions} [productDimensions] — product sizing
 * @property {import('./types.js?v=20260418-sL').ForwardPickConfig} [forwardPick] — forward pick area config
 * @property {{ vas: OptionalZone, returns: OptionalZone, chargeback: OptionalZone }} [optionalZones] — optional functional zones
 * @property {import('./types.js?v=20260418-sL').CustomZone[]} [customZones] — user-defined zones
 * @property {number} [peakUnitsPerDay] — peak daily unit throughput
 * @property {number} [avgUnitsPerDay] — average daily unit throughput
 * @property {number} [operatingDaysPerYear] — annual operating days
 */

/**
 * @typedef {Object} VolumeInputs
 * @property {number} totalPallets — total pallet positions needed
 * @property {number} [totalSKUs] — number of SKUs (legacy; not surfaced in Phase B UI)
 * @property {number} [inventoryTurns] — annual inventory turns (legacy; not surfaced in Phase B UI; kept on the data model for back-compat with legacy heuristic suggestedSqft)
 * @property {number} [avgDailyInbound] — pallets/day inbound
 * @property {number} [avgDailyOutbound] — pallets/day outbound
 * @property {number} [peakMultiplier] — peak vs. average ratio (default 1.3)
 * @property {number} [annualOutboundUnits] — Phase B (2026-05-05): annual
 *   throughput in units. Used in throughput-driven primary input mode to
 *   derive peak on-hand units = annual / 365 × DOH × peak. 0 = use legacy
 *   peakUnitsPerDay/totalPallets as direct inputs.
 * @property {number} [daysOnHand] — Phase B target Days On Hand. Default 30.
 *   Drives the throughput → on-hand units conversion.
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
 *
 * WSC-J1 (2026-04-25): expanded from 5 fields to 13. CM now receives the
 * geometry, dock split, storage capacity, and inventory drivers WSC has
 * already engineered, so CM doesn't have to re-guess them in its facility
 * section. CM-side handler treats every field as additive — only writes
 * if WSC has a positive value, never clears CM's existing data.
 *
 * @typedef {Object} WscToCmPayload
 * @property {number} totalSqft        — sized total SF (engineered, not existing)
 * @property {number} storageSqft      — storage-only SF (subset of totalSqft)
 * @property {number} clearHeight
 * @property {number} buildingWidth    — feet
 * @property {number} buildingDepth    — feet
 * @property {number} dockDoors        — total (in + out)
 * @property {number} inboundDoors
 * @property {number} outboundDoors
 * @property {number} officeSqft
 * @property {number} stagingSqft      — receive + ship staging
 * @property {number} palletPositions  — gross positions (designed + surge)
 * @property {number} sfPerPosition
 * @property {number} peakUnitsPerDay  — peak inventory on-hand (drives sizing)
 */

/**
 * Payload received on bus 'cm:push-to-wsc' event.
 *
 * Phase 4 of volumes-as-nucleus (Layer A, 2026-04-29): expanded from 2
 * fields to 9. CM now seeds WSC's volume inputs from cost-model channels[]
 * so WSC users don't have to re-key pallets/daily-throughput/peak when
 * launching from a linked cost model. Every field is optional + additive —
 * WSC overwrites local volumes only when the payload value is positive.
 *
 * @typedef {Object} CmToWscPayload
 * @property {number} [clearHeight]
 * @property {number} [totalSqft]
 * @property {number} [totalPallets]      — annual aggregate inbound pallets across channels
 * @property {number} [avgDailyInbound]   — inbound pallets per operating day
 * @property {number} [avgDailyOutbound]  — outbound pallets per operating day
 * @property {number} [peakMultiplier]    — max peakSurgeFactor across channels (e.g. 1.5×)
 * @property {number} [peakUnitsPerDay]   — physical units on peak day across channels
 * @property {number} [inventoryTurns]    — turns/yr (defaults 12 when unset; no channel field for this yet)
 * @property {number} [totalSKUs]         — best-effort SKU count (carries through if CM had it)
 * @property {ChannelMix[]} [channelMixes] — Phase 4 Layer B (volumes-as-nucleus, 2026-04-29):
 *   per-channel breakdown of peakUnitsPerDay so WSC can size storage zones
 *   per-channel. When present, calcStorageByType sums per-channel positions
 *   using each channel's storageAllocation override (or the facility-level
 *   allocation as fallback). Empty/absent = single-mix legacy behavior.
 */

/**
 * Phase 4 Layer B (2026-04-29): per-channel snapshot for storage sizing.
 *
 * @typedef {Object} ChannelMix
 * @property {string} channelKey
 * @property {string} name
 * @property {number} peakUnitsPerDay — channel's peak-day units (drives sizing)
 * @property {StorageAllocation} [storageAllocation] — optional per-channel
 *   override of the facility-level storage mix. When absent, the channel
 *   inherits zones.storageAllocation.
 */

export {};

// ============================================================
// N1 (2026-07-04) — DESIGN BASIS PROFILE (WSC re-founding, North Star doc)
// ============================================================

/**
 * @typedef {Object} DataGap
 * @property {string} code — stable machine code (e.g. 'TIHI_MISSING')
 * @property {'error'|'warn'|'info'} severity — error = blocks design-readiness
 * @property {string} message — human sentence, printed in the Design Basis doc
 * @property {number} [count]
 */

/**
 * @typedef {Object} DesignProfile
 * The unified output of BOTH ingest modes (Brock 2026-07-04: rich data and
 * sparse RFP aggregates are first-class peers). Fields are null when the
 * mode/data can't produce them; provenance says how each was obtained:
 * 'derived' (computed from customer rows), 'asserted' (user-entered
 * aggregate), 'estimated' (defaulted — always paired with a DataGap).
 *
 * @property {'data'|'sparse'} mode
 * @property {number|null} skuCount
 * @property {Object|null} velocityBands — { A|B|C: { skuCount, skuPct, linePct, skus[]|null } } (ABC by pick lines)
 * @property {Object|null} cubeMovement — { A|B|C: { cubePct }, skuCoveragePct } second axis; data mode only
 * @property {Object|null} depthOfHolding — { avgPalletsPerSku, p50, p90, skusMeasured, distribution[]|null }
 * @property {Object|null} tiHi — { avgCasesPerPallet, skusWithData, skusMissing }
 * @property {Object|null} peak — { weeksObserved, avgWeeklyLines, peakWeeklyLines, peakFactor, basis }
 * @property {Object|null} volumes — { observedUnits, observedLines, annualOutboundUnits, onHandPallets }
 * @property {DataGap[]} dataGaps
 * @property {Object<string,'derived'|'asserted'|'estimated'>} provenance
 * @property {Object} [sources] — per-slot { fileName, rows, skipped } metadata (data mode)
 */

/**
 * IES Hub v3 — Warehouse Sizing — CM bridge (extracted from ui.js 2026-05-13)
 *
 * Slice 6 of 7: cross-tool integration between WSC and the parent Cost Model.
 *
 * Exports:
 *   pushToCm(ctx)                  — emits 'wsc:push-to-cm' event with the
 *                                    sized facility's totals + dock config.
 *                                    Called from bindShellEvents handlers.
 *   handleCmPush(payload, ctx)     — receives a payload from CM (Size with
 *                                    Calculator handoff) and applies values
 *                                    to facility/zones/volumes via property
 *                                    mutation (live through ctx getters).
 *                                    Triggers refreshKpis/Config/Content.
 *   createDefaultFacility()        — pure factory; default WSC facility.
 *   createDefaultZones()           — pure factory; default zone configuration.
 *   createDefaultVolumes()         — pure factory; default volume profile.
 *
 * ctx (for pushToCm + handleCmPush):
 *   { facility, zones, volumes,             // getters (live reads)
 *     toSizingInputs(),                     // builds SizingInputs from state
 *     refreshKpis(), refreshConfig(),
 *     refreshContent() }
 *
 * @module tools/warehouse-sizing/ui-cm-bridge
 */

import * as calc from './calc.js?v=20260514-kpis1';
import { bus } from '../../shared/event-bus.js?v=20260418-sK';

// ============================================================
// WSC ↔ CM INTEGRATION
// ============================================================

export function pushToCm(ctx) {
  const dock = ctx.zones.dockConfig || { inboundDoors: 10, outboundDoors: 12 };
  const totalDoors = (dock.inboundDoors || 0) + (dock.outboundDoors || 0);
  // Brock 2026-04-20: push the SIZED total SF (tool's computed answer), not
  // ctx.facility.totalSqft (which is the Existing/Target constraint). Falls back
  // to ctx.facility.totalSqft if sizing failed or is zero, so a user with only
  // an "existing" value can still push it.
  let sized = null;
  try { sized = calc.sizeFacility(ctx.toSizingInputs()); } catch {}
  const sizedSqft = (sized && sized.totalSqft) || 0;
  const effectiveTotalSqft = sizedSqft > 0 ? Math.round(sizedSqft) : (ctx.facility.totalSqft || 0);
  // WSC-J1 (2026-04-25): payload expanded from 5 fields to 13. CM uses the
  // additional fields to seed ctx.facility geometry, dock split, and pallet
  // positions for the equipment line — it no longer has to re-derive them.
  /** @type {import('./types.js?v=20260418-sL').WscToCmPayload} */
  const payload = {
    totalSqft: effectiveTotalSqft,
    storageSqft: (sized && sized.storageSqft) ? Math.round(sized.storageSqft) : 0,
    clearHeight: ctx.facility.clearHeight || 0,
    buildingWidth: ctx.facility.buildingWidth || 0,
    buildingDepth: ctx.facility.buildingDepth || 0,
    dockDoors: totalDoors,
    inboundDoors: dock.inboundDoors || 0,
    outboundDoors: dock.outboundDoors || 0,
    officeSqft: ctx.zones.officeSqft || 0,
    stagingSqft: (ctx.zones.receiveStagingSqft || 0) + (ctx.zones.shipStagingSqft || 0),
    palletPositions: (sized && sized.positions && sized.positions.grossPositions) || 0,
    sfPerPosition: (sized && sized.sfPerPosition) || 0,
    peakUnitsPerDay: ctx.zones.peakUnitsPerDay || 0,
  };
  // Also stash in sessionStorage so CM can pick it up on mount if it isn't
  // already mounted (bus event would be lost). CM clears the stash after consuming.
  try {
    sessionStorage.setItem('wsc_pending_push', JSON.stringify({ ...payload, at: Date.now() }));
  } catch {}
  bus.emit('wsc:push-to-cm', payload);
  // Navigate to Cost Model Builder
  window.location.hash = 'designtools/cost-model';
}

/**
 * Handle CM → WSC push (e.g., "Size with Calculator" from CM).
 * @param {import('./types.js?v=20260418-sL').CmToWscPayload} payload
 */
export function handleCmPush(payload, ctx) {
  // Brock 2026-04-20: Existing/Target SF field was removed from the UI —
  // the sizer is the single source of truth. We still stash CM's totalSqft
  // on ctx.facility so a scenario saved from CM doesn't drop the field, but
  // the editor no longer surfaces it. Clear height still drives the
  // elevation view, so keep that.
  if (payload.clearHeight) ctx.facility.clearHeight = payload.clearHeight;
  if (payload.totalSqft) ctx.facility.totalSqft = payload.totalSqft;
  // 2026-04-30 (G10): persist parent linkage from CM. Without this, the
  // "Linked to Cost Model #..." sidebar footer + Phase 5.4 drillback chips
  // can't render because ctx.facility.parent_cost_model_id stays null.
  if (payload.parent_cost_model_id != null) {
    ctx.facility.parent_cost_model_id = payload.parent_cost_model_id;
  }
  if (payload.parent_deal_id != null) {
    ctx.facility.parent_deal_id = payload.parent_deal_id;
  }
  // Phase 4 of ctx.volumes-as-nucleus (Layer A, 2026-04-29): payload now
  // optionally carries channel-derived volume fields. Each is additive —
  // we only overwrite the local ctx.volumes when the payload value is positive,
  // so launching from CM with partial data never wipes WSC's defaults.
  if (Number(payload.totalPallets)     > 0) ctx.volumes.totalPallets     = Number(payload.totalPallets);
  if (Number(payload.avgDailyInbound)  > 0) ctx.volumes.avgDailyInbound  = Number(payload.avgDailyInbound);
  if (Number(payload.avgDailyOutbound) > 0) ctx.volumes.avgDailyOutbound = Number(payload.avgDailyOutbound);
  if (Number(payload.peakMultiplier)   > 0) ctx.volumes.peakMultiplier   = Number(payload.peakMultiplier);
  if (Number(payload.inventoryTurns)   > 0) ctx.volumes.inventoryTurns   = Number(payload.inventoryTurns);
  if (Number(payload.totalSKUs)        > 0) ctx.volumes.totalSKUs        = Number(payload.totalSKUs);
  // 2026-05-12 — DOH is the missing third coordinate from the dimensional fix
  // in cost-model/api.js. payload.totalPallets is now on-hand positions
  // (annualPalletsInbound × DOH/365); WSC's throughput-driven derivation
  // also uses ctx.volumes.daysOnHand, so propagate it here so the field stays
  // consistent with the override path.
  if (Number(payload.daysOnHand)       > 0) ctx.volumes.daysOnHand        = Number(payload.daysOnHand);
  // peakUnitsPerDay lives on `ctx.zones`, not `ctx.volumes` — it drives the storage
  // on-hand inventory sizing which is in the ctx.zones state object.
  if (Number(payload.peakUnitsPerDay)  > 0) ctx.zones.peakUnitsPerDay    = Number(payload.peakUnitsPerDay);
  // Phase 4 Layer B (ctx.volumes-as-nucleus, 2026-04-29): per-channel mix for
  // storage-media split. Replace wholesale rather than merge — channels are
  // the source of truth from CM at the moment of push.
  if (Array.isArray(payload.channelMixes) && payload.channelMixes.length > 0) {
    ctx.zones.channelMixes = payload.channelMixes.map(m => ({
      channelKey: m.channelKey,
      name: m.name || m.channelKey,
      peakUnitsPerDay: Number(m.peakUnitsPerDay) || 0,
      ...(m.storageAllocation ? { storageAllocation: { ...m.storageAllocation } } : {}),
    }));
  }
  ctx.refreshConfig();
  ctx.refreshContent();
  ctx.refreshKpis();
}

// ============================================================
// HELPERS
// ============================================================

export function createDefaultFacility() {
  return {
    id: null,
    name: 'New Facility',
    // Brock 2026-04-20: totalSqft is the tool's OUTPUT (computed by
    // sizeFacility from peak units / storage / clear ht etc.). Starting
    // at 0 prevents the UI from pretending 150K is a real constraint;
    // the "Match Sized" button puts the computed value in the field
    // when the user wants it as an explicit target.
    totalSqft: 0,
    clearHeight: 32,
    // Brock 2026-04-20: zero defaults let the plan renderer derive a
    // landscape footprint from sized SF (1.5:1). User can still type
    // specific values to override; the renderer auto-swaps if they
    // yield portrait orientation.
    buildingWidth: 0,
    buildingDepth: 0,
    columnSpacingX: 50,
    columnSpacingY: 50,
    storageType: 'single',
    aisleWidth: null,
    palletWidth: 48,
    palletDepth: 40,
    palletHeight: 54,
    beamHeight: 5,
    flueSpace: 3,
    topClearance: 36,
    // ── Phase 2 redesign (2026-05-04) — IE-correct unit-load + carton + SKU + dock fields ──
    // All optional. When omitted, sizeFacility falls back to legacy behavior so
    // existing scenarios load unchanged. The Configure side panel surfaces them
    // as primary inputs in Step 1-4 of the new stepped flow.
    palletType: 'GMA',           // GMA | CHEP | Euro | EuroHalf | Custom
    cartonLengthIn: 12,
    cartonWidthIn: 9,
    cartonHeightIn: 12,
    cartonOrientation: 'L-along-rack',  // L-along-rack | W-along-rack
    cartonsPerPalletOverride: 0,        // > 0 to bypass ti×hi (e.g., from slotting study)
    fullPalletSkus: 0,           // 0 = derive heuristic from positions
    cartonPalletSkus: 0,
    shelvingSkus: 0,
    bottomBeamFp: false,         // distribution default = pallet on slab
    bottomBeamCp: true,          // case-pick zone often wire-decked → bottom beam
    bottomBeamShelving: false,   // shelving has its own deck per level
    topBeam: false,              // legacy compat — orphan beam above top level (real selective: never)
    palletsPerTruck: 26,         // TL load: 26 with stack, 30 floor-loaded
    dwellHoursPerTruck: 1.5,     // live-unload door-occupied time
    shiftHoursPerDay: 16,        // 2-shift default
    surgePctDock: 0.20,          // dock surge buffer
    // Step 5 Override toggle — when false, building dims display as derived;
    // when true, exposes editable Width/Depth inputs (legacy behavior).
    buildingDimsOverride: false,
    // Phase A redesign (2026-05-05) — explicit sizing mode. 'design' = engine
    // answer is the only footprint (W/D inputs hidden, rendering uses sized
    // dims). 'constraint' = user W×D is a hard constraint (W/D first-class
    // inputs, rendering uses user dims, dashboard shows the capacity gap).
    // Replaces the buildingDimsOverride boolean for new facilities; legacy
    // facilities with buildingDimsOverride=true migrate to 'constraint' on load.
    sizingMode: 'design',
    // Phase B redesign (2026-05-05) — ABC velocity tier slotting.
    // Pareto default: A=20% / B=30% / C=50%. A% replaces the legacy
    // hardcoded 20% activePickPct in the forward-pick demand calc, so new
    // scenarios still produce identical sized output until user tunes A%.
    // For legacy scenarios, openEditor's migration block also sets these
    // defaults — engine output unchanged because A=20% matches legacy.
    velocityTierAPct: 20,
    velocityTierBPct: 30,
    velocityTierCPct: 50,
    // Phase B redesign — primary inventory input toggle. 'throughput' is the
    // IE-natural default (user enters annual/daily outbound + DOH + peak;
    // on-hand pallets derive). 'pallets' = user enters on-hand pallet
    // positions directly. The non-primary path renders as a derived tile.
    primaryInventoryInput: 'throughput',
  };
}

export function createDefaultZones() {
  // Brock 2026-05-08: ctx.zones defaults zeroed to match the createDefaultFacility
  // cleanup from 2026-04-20. Pre-fix, opening "+ New Scenario" pre-filled the
  // form with seed data (5K office, 10K staging, 500K peak units/day, 10
  // inbound + 12 outbound dock doors, etc.) intended to make the demo render
  // a populated ctx.facility. Combined with || fallbacks in ctx.toSizingInputs, this
  // also produced a phantom 118,368 SF residual that couldn't be cleared by
  // zeroing inputs. Defaults that survive: dimensionless ratios on
  // storageAllocation (need to sum to 100), dockConfig.sided structural
  // toggle, forwardPick disabled flag + structural type, optionalZones
  // disabled flags. Everything numeric is 0/blank.
  return {
    officeSqft: 0,
    receiveStagingSqft: 0,
    shipStagingSqft: 0,
    chargingSqft: 0,
    repackSqft: 0,
    otherSqft: 0,
    storageAllocation: { fullPallet: 60, cartonOnPallet: 30, cartonOnShelving: 10 },
    dockConfig: { sided: 'single', inboundDoors: 0, outboundDoors: 0, palletsPerDockHour: 0, dockOperatingHours: 0 },
    productDimensions: { unitsPerPallet: 0, unitsPerCartonPallet: 0, cartonsPerPallet: 0, unitsPerCartonShelving: 0, cartonsPerLocation: 0 },
    forwardPick: { enabled: false, type: 'carton_flow', skuCount: 0, daysInventory: 0, outboundUnitsPerDay: 0 },
    optionalZones: { vas: { enabled: false, sqft: 0 }, returns: { enabled: false, sqft: 0 }, chargeback: { enabled: false, sqft: 0 } },
    customZones: [],
    peakUnitsPerDay: 0,
    avgUnitsPerDay: 0,
    operatingDaysPerYear: 0,
  };
}

export function createDefaultVolumes() {
  // Brock 2026-05-08: ctx.volumes defaults zeroed (was: 60K pallets / 3K SKUs /
  // 250 inbound / 290 outbound / 12 turns / 1.3 peak — sized to match the
  // legacy 150K sqft demo ctx.facility). Real project numbers should replace
  // these fields explicitly. Structural defaults preserved: peakMultiplier
  // and daysOnHand have engineering-meaningful baseline values (1.3 peak
  // factor + 30-day on-hand) that survive blank-form sizing because they
  // are dimensionless ratios applied only when other inputs are non-zero.
  return {
    totalPallets: 0,
    // Brock 2026-05-08 (consolidation): shelving-locations override.
    // Mirrors totalPallets — when set, engine bypasses peakUnits × shelvingMix
    // derivation and uses this directly.
    totalShelvingLocations: 0,
    totalSKUs: 0,
    inventoryTurns: 0,
    avgDailyInbound: 0,
    avgDailyOutbound: 0,
    peakMultiplier: 1.3,
    annualOutboundUnits: 0,
    daysOnHand: 30,
  };
}



/**
 * Escape for HTML attribute values (covers double-quote contexts).
 * Phase 4 Layer B (ctx.volumes-as-nucleus, 2026-04-29) — added because the new
 * per-channel allocation editor and dashboard byChannel rows write
 * channelKey into data-* attribute values.
 */


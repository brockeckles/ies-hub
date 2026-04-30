/**
 * IES Hub v3 — Cost Model Types
 * JSDoc typedefs for all 13 sections of the Cost Model Builder.
 *
 * @module tools/cost-model/types
 */

// ---- Project Details (Section 1: Setup) ----

/**
 * @typedef {Object} ProjectDetails
 * @property {string} [name]
 * @property {string} [clientName]
 * @property {string} [market] — market_id (UUID)
 * @property {string} [environment] — DEPRECATED conflated field; new code should use storageEnvironment + vertical (R12, 2026-04-30)
 * @property {string} [storageEnvironment] — climate: 'ambient' | 'refrigerated' | 'freezer' | 'temperature_controlled'
 * @property {string} [vertical] — industry: 'ecommerce' | 'retail' | 'food_beverage' | 'industrial' | 'pharmaceutical' | 'automotive' | 'consumer_goods' | 'other'
 * @property {string} [facilityLocation]
 * @property {number} [contractTerm] — years
 */

// ---- Volumes & Profile (Section 2) ----
//
// PHASE 1 (volumes-as-nucleus redesign, 2026-04-29): The Volumes & Profile
// section is being restructured around a channel-segmented nucleus pattern.
// See `project_volumes_nucleus_redesign.md` in auto-memory for the full
// architecture. Phase 1 introduces `model.channels[]` as the canonical shape.
// Legacy `volumeLines`, `orderProfile`, and `seasonalityProfile` stay in saved
// jsonb for backward compat for one cycle while load-time migration converts
// them into channels[]. After Phase 3 calc-layer migration, they go away.

/**
 * Legacy shape — DEPRECATED. Kept for load-time migration into channels[].
 * Phase 3 migrates all calc consumers off this and Phase 4+ drops it from save.
 *
 * @typedef {Object} VolumeLine
 * @property {string} name — activity name (e.g. 'Pallets Received', 'Orders Packed')
 * @property {number} volume — annual volume
 * @property {string} uom — 'pallet' | 'case' | 'each' | 'order' | 'line'
 * @property {boolean} [isOutboundPrimary] — starred line for unit cost metrics
 */

/**
 * Legacy shape — DEPRECATED. Folded into Channel.conversions in the
 * volumes-as-nucleus redesign. Kept for load-time migration only.
 *
 * @typedef {Object} OrderProfile
 * @property {number} [linesPerOrder]
 * @property {number} [unitsPerLine]
 * @property {number} [avgOrderWeight]
 * @property {string} [weightUnit] — 'lbs' | 'kg'
 */

/**
 * UOM conversion factors that translate the channel's primary volume into
 * every other UOM downstream calc may need. Edited by the designer; seeded
 * from the channel archetype catalog when a channel is first added.
 *
 * @typedef {Object} UomConversionFactors
 * @property {number} unitsPerCase
 * @property {number} casesPerPallet
 * @property {number} linesPerOrder
 * @property {number} unitsPerLine
 * @property {number} weightPerUnit
 * @property {('lbs'|'kg')} weightUnit
 */

/**
 * Structural assumptions that interpret the channel's primary volume into
 * operating volumes (returns, inbound, peak day). Per-channel because these
 * differ materially across DTC vs B2B vs reverse logistics.
 *
 * Note: workingDaysPerYear is NOT here — it lives on facility.opDaysPerYear
 * because it's a building calendar property shared across channels.
 *
 * @typedef {Object} StructuralAssumptions
 * @property {number} returnsPercent — % of channel outbound that returns (0–100)
 * @property {number} inboundOutboundRatio — IB:OB unit ratio (e.g. 1.05 = 5% more inbound than outbound)
 * @property {number} peakSurgeFactor — peak day vs daily-avg multiplier (e.g. 1.6, 2.0, 3.0)
 */

/**
 * Per-channel monthly seasonality. Same shape as the legacy global
 * `model.seasonalityProfile` — moved into the channel block so DTC and B2B
 * can carry independent seasonal patterns.
 *
 * @typedef {Object} ChannelSeasonality
 * @property {string} preset — 'flat' | 'ecom_holiday_peak' | 'cold_chain_food' | 'apparel_2_peak' | 'custom'
 * @property {number[]} monthly_shares — 12 values (% per month, should sum to 100)
 */

/**
 * The single canonical volume input for a channel. All other UOMs and all
 * operating volumes derive from this × conversions × assumptions.
 *
 * @typedef {Object} PrimaryVolume
 * @property {number} value — annual volume in the chosen UOM
 * @property {('units'|'cases'|'pallets'|'orders'|'lines')} uom
 * @property {('outbound'|'inbound'|'returns'|'transfer'|'custom')} activity
 * @property {boolean} [autoDerived] — true when this primary is auto-computed (e.g. reverse-logistics from Σ outbound × returns%)
 * @property {('manual'|'wsc'|'netopt'|'imported')} [source]
 * @property {string} [sourceRef] — id/ref of source scenario when imported
 */

/**
 * Designer-pinned authoritative figure overriding a derived volume. Lets a
 * designer pin (e.g.) "Annual Pallets" to an RFP-stated figure that doesn't
 * match `primary ÷ unitsPerCase ÷ casesPerPallet`. Variance vs derived is
 * shown in UI as a badge on the row.
 *
 * @typedef {Object} DerivedVolumeOverride
 * @property {('cases'|'pallets'|'orders'|'lines'|'dailyAvg'|'peakDay'|'returns'|'inbound')} key
 * @property {number} pinnedValue
 * @property {string} [note] — optional rationale
 * @property {string} [pinnedAt] — ISO timestamp
 */

/**
 * One operating profile that lives in the warehouse. Channels are the top
 * dimension of the cost model: each channel carries its own primary volume,
 * conversions, assumptions, and seasonality. A single-channel deal defaults
 * to one channel; multi-channel deals (DTC + B2B + reverse) get a tab strip.
 *
 * @typedef {Object} Channel
 * @property {string} key — stable identifier (e.g. 'dtc-ecom', 'b2b-retail', 'reverse')
 * @property {string} name — display name (editable)
 * @property {string} [archetypeId] — fk to master_channel_archetypes (null for fully-custom channels)
 * @property {string} [color] — visual accent for tabs/badges
 * @property {number} sortOrder
 * @property {boolean} [hidden]
 * @property {PrimaryVolume} primary
 * @property {UomConversionFactors} conversions
 * @property {StructuralAssumptions} assumptions
 * @property {ChannelSeasonality} seasonality
 * @property {DerivedVolumeOverride[]} [overrides]
 * @property {Object} [archetypeSnapshot] — JSON snapshot of archetype seed at time of selection (so archetype edits don't silently mutate channels)
 */

/**
 * Mix-entry mode. 'byVolume' (default) — channels independently entered, mix
 * % is read-only computed. 'byMix' — total volume + mix bar drives per-channel
 * primaries, which are derived. Toggling between modes never destroys data.
 *
 * @typedef {Object} ChannelMixState
 * @property {('byVolume'|'byMix')} mode
 * @property {number} [totalVolume] — only meaningful in byMix
 * @property {('units'|'cases'|'pallets'|'orders'|'lines')} [totalUom] — only meaningful in byMix
 * @property {Array<{channelKey: string, pct: number}>} [allocations] — only meaningful in byMix
 */

/**
 * Master-data archetype seeding a channel block. Lives in master_channel_archetypes
 * Supabase table. Hub admins manage; designers select when adding a channel.
 *
 * @typedef {Object} ChannelArchetype
 * @property {string} id — uuid
 * @property {string} name
 * @property {string} description
 * @property {UomConversionFactors} defaultConversions
 * @property {StructuralAssumptions} defaultAssumptions
 * @property {string} defaultSeasonalityPreset
 * @property {boolean} [autoDerivedReturns] — true for reverse-logistics archetype: primary auto-computes from Σ outbound × returns%
 * @property {number} sortOrder
 * @property {boolean} isActive
 */

// ---- Facility (Section 4) ----

/**
 * @typedef {Object} FacilityConfig
 * @property {number} totalSqft
 * @property {number} [clearHeight] — feet
 * @property {number} [dockDoors]
 * @property {number} [opDaysPerYear] — operating calendar; shared across channels
 * @property {Object} [rateOverrides] — per-key overrides for facility cost calc
 */

// ---- Shifts (Section 5) ----

/**
 * @typedef {Object} ShiftConfig
 * @property {number} shiftsPerDay
 * @property {number} hoursPerShift
 * @property {number} daysPerWeek
 * @property {number} [weeksPerYear] — default 52
 * @property {number} [shift2Premium] — % premium for 2nd shift
 * @property {number} [shift3Premium] — % premium for 3rd shift
 * @property {number} [absenceAllowancePct] — % absence allowance
 */

// ---- Labor (Section 6) ----

/**
 * @typedef {Object} DirectLaborLine
 * @property {string} activity_name
 * @property {string} [most_template_name]
 * @property {string} [most_template_id]
 * @property {number} volume
 * @property {number} base_uph — units per hour
 * @property {number} [adjusted_uph]
 * @property {number} annual_hours
 * @property {number} hourly_rate
 * @property {number} [burden_pct] — employer burden %
 * @property {number} [benefits_per_hour]
 * @property {string} [uom]
 * @property {string} [complexity_tier] — 'low' | 'medium' | 'high'
 * @property {string} [volume_line_id]
 * @property {string} [mhe_equipment_id]
 * @property {string} [it_equipment_id]
 * @property {string} [pricing_bucket]
 * @property {boolean} [auto_calculated]
 */

/**
 * @typedef {Object} IndirectLaborLine
 * @property {string} role_name
 * @property {number} headcount
 * @property {number} hourly_rate
 * @property {number} [burden_pct]
 * @property {number} [annual_hours] — computed: headcount × operatingHours
 * @property {number} [annual_cost]
 * @property {string} [pricing_bucket]
 */

// ---- Equipment (Section 7) ----

/**
 * @typedef {Object} EquipmentLine
 * @property {string} equipment_name
 * @property {string} [category] — 'MHE' | 'IT' | 'Racking' | 'Dock' | 'Charging' | 'Office' | 'Security' | 'Conveyor'
 * @property {('owned_mhe'|'rented_mhe'|'it_equipment'|'owned_facility')} [line_type]
 *   Peak-capacity classification (2026-04-22 Phase 2a). Derived from `category`
 *   on legacy projects via adapter in api.js. Phases 2b+ surface financing UI
 *   switches + auto-gen split on this value:
 *     owned_mhe      — permanent MHE fleet sized to steady-state max-shift HC
 *     rented_mhe     — short-term peak-only rental (opex, seasonal_months)
 *     it_equipment   — RF/printers/AP/switches, always owned, sized to PEAK HC
 *     owned_facility — racking/dock/charging/office/security/conveyor
 *   Phase 2a is non-breaking — no math change, field is additive.
 * @property {number[]} [seasonal_months] — 1-12. Used by rented_mhe lines in
 *   Phase 2b+ to flag which months the rental is active. Derived from the MLV
 *   peak-vs-steady delta when auto-gen fills this.
 * @property {number} quantity
 * @property {'lease'|'purchase'|'service'} [acquisition_type]
 * @property {number} [monthly_cost] — lease/service monthly
 * @property {number} [acquisition_cost] — purchase unit cost
 * @property {number} [monthly_maintenance]
 * @property {number} [amort_years] — amortization period for purchases
 * @property {string} [driven_by]
 * @property {string} [pricing_bucket]
 */

// ---- Overhead (Section 8) ----

/**
 * @typedef {Object} OverheadLine
 * @property {string} category
 * @property {string} [description]
 * @property {number} [monthly_cost] — if cost_type='monthly'
 * @property {number} [annual_cost] — if cost_type='annual'
 * @property {'monthly'|'annual'} cost_type
 * @property {string} [pricing_bucket]
 */

// ---- VAS (Section 9) ----

/**
 * @typedef {Object} VASLine
 * @property {string} service
 * @property {number} [rate]
 * @property {number} [volume]
 * @property {number} [total_cost] — override: if set, use instead of rate×volume
 * @property {string} [pricing_bucket]
 */

// ---- Financial (Section 10) ----

/**
 * @typedef {Object} FinancialConfig
 * @property {number} [targetMargin] — %
 * @property {number} [volumeGrowth] — annual % growth
 * @property {number} [laborEscalation] — annual % escalation
 * @property {number} [annualEscalation] — general cost escalation %
 * @property {number} [discountRate] — % for NPV/MIRR
 * @property {number} [reinvestRate] — % for MIRR
 * @property {number} [managementFee] — monthly fixed fee
 * @property {Object} [thresholds] — { grossMargin, ebitda, ebit, roic, mirr, payback }
 */

// ---- Start-Up / Capital (Section 11) ----

/**
 * @typedef {Object} StartupLine
 * @property {string} description
 * @property {number} one_time_cost
 * @property {number} [annual_amort] — computed: one_time_cost / contractTerm
 * @property {number} [monthly_amort]
 * @property {string} [pricing_bucket]
 */

// ---- Pricing (Section 12) ----

/**
 * @typedef {Object} PricingBucket
 * @property {string} id — slug (e.g. 'mgmt_fee', 'storage', 'inbound')
 * @property {string} name
 * @property {'fixed'|'variable'} type
 * @property {string} uom — e.g. 'month', 'pallet', 'case', 'each', 'order'
 * @property {string} [volumeDriver] — which volume line drives this bucket
 */

// ---- Summary / Projections ----

/**
 * @typedef {Object} CostSummary
 * @property {number} laborCost
 * @property {number} facilityCost
 * @property {number} equipmentCost
 * @property {number} overheadCost
 * @property {number} vasCost
 * @property {number} startupAmort
 * @property {number} totalCost
 * @property {number} totalRevenue
 * @property {number} totalFtes
 * @property {number} costPerOrder
 * @property {number} equipmentCapital
 * @property {number} equipmentAmort
 * @property {number} startupCapital
 */

/**
 * @typedef {Object} YearlyProjection
 * @property {number} year
 * @property {number} orders
 * @property {number} labor
 * @property {number} facility
 * @property {number} equipment
 * @property {number} overhead
 * @property {number} vas
 * @property {number} startup
 * @property {number} totalCost
 * @property {number} revenue
 * @property {number} grossProfit
 * @property {number} ebitda
 * @property {number} ebit
 * @property {number} depreciation
 * @property {number} taxes
 * @property {number} netIncome
 * @property {number} capex
 * @property {number} workingCapitalChange
 * @property {number} operatingCashFlow
 * @property {number} freeCashFlow
 * @property {number} [learningMult]
 */

/**
 * @typedef {Object} FinancialMetrics
 * @property {number} grossMarginPct
 * @property {number} ebitdaMarginPct
 * @property {number} ebitMarginPct
 * @property {number} roicPct
 * @property {number} mirrPct
 * @property {number} npv
 * @property {number} paybackMonths
 * @property {number} revenuePerFte
 * @property {number} contribPerOrder
 * @property {number} opLeveragePct
 * @property {number} contractValue
 * @property {number} totalInvestment
 */

/**
 * @typedef {Object} ValidationWarning
 * @property {'info'|'warning'|'error'} level
 * @property {string} area
 * @property {string} message
 */

/**
 * Full cost model project data structure.
 *
 * Volumes-as-nucleus redesign (Phase 1, 2026-04-29):
 *   - `channels[]` is the canonical shape going forward.
 *   - `volumeLines`, `orderProfile`, `seasonalityProfile` are DEPRECATED;
 *     load-time migration converts them into channels[]. Saved on jsonb
 *     for one cycle of backward compat; dropped after Phase 3.
 *
 * @typedef {Object} CostModelData
 * @property {number} [id]
 * @property {ProjectDetails} projectDetails
 * @property {Channel[]} [channels] — canonical Volumes & Profile state (Phase 1+)
 * @property {ChannelMixState} [channelMix] — mix-mode state (Phase 1+)
 * @property {VolumeLine[]} [volumeLines] — DEPRECATED, kept for migration
 * @property {OrderProfile} [orderProfile] — DEPRECATED, kept for migration
 * @property {ChannelSeasonality} [seasonalityProfile] — DEPRECATED, kept for migration
 * @property {FacilityConfig} facility
 * @property {ShiftConfig} shifts
 * @property {DirectLaborLine[]} laborLines
 * @property {IndirectLaborLine[]} indirectLaborLines
 * @property {EquipmentLine[]} equipmentLines
 * @property {OverheadLine[]} overheadLines
 * @property {VASLine[]} vasLines
 * @property {FinancialConfig} financial
 * @property {StartupLine[]} startupLines
 * @property {PricingBucket[]} pricingBuckets
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

// ---- Reference Data ----

/**
 * @typedef {Object} FacilityRate
 * @property {string} market_id
 * @property {number} lease_rate_psf_yr
 * @property {number} cam_rate_psf_yr
 * @property {number} tax_rate_psf_yr
 * @property {number} insurance_rate_psf_yr
 */

/**
 * @typedef {Object} UtilityRate
 * @property {string} market_id
 * @property {number} avg_monthly_per_sqft
 */

/**
 * @typedef {Object} LaborRate
 * @property {string} market_id
 * @property {string} role_name
 * @property {string} [role_category] — 'Direct' | 'Indirect' | 'Management'
 * @property {number} hourly_rate
 * @property {number} [burden_pct]
 * @property {number} [benefits_per_hour]
 * @property {number} [annual_escalation_pct]
 */

/**
 * @typedef {Object} EquipmentRef
 * @property {string} equipment_name
 * @property {string} category
 * @property {number} [purchase_cost]
 * @property {number} [lease_monthly]
 * @property {number} [maintenance_monthly]
 * @property {number} [annual_escalation_pct]
 */

export {};

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
 * @property {string} [environment] — e.g. 'ecommerce', 'retail', 'food', 'industrial'
 * @property {string} [facilityLocation]
 * @property {number} [contractTerm] — years
 */

// ---- Volumes (Section 2) ----

/**
 * @typedef {Object} VolumeLine
 * @property {string} name — activity name (e.g. 'Pallets Received', 'Orders Packed')
 * @property {number} volume — annual volume
 * @property {string} uom — 'pallet' | 'case' | 'each' | 'order' | 'line'
 * @property {boolean} [isOutboundPrimary] — starred line for unit cost metrics
 */

// ---- Order Profile (Section 3) ----

/**
 * @typedef {Object} OrderProfile
 * @property {number} [linesPerOrder]
 * @property {number} [unitsPerLine]
 * @property {number} [avgOrderWeight]
 * @property {string} [weightUnit] — 'lbs' | 'kg'
 */

// ---- Facility (Section 4) ----

/**
 * @typedef {Object} FacilityConfig
 * @property {number} totalSqft
 * @property {number} [clearHeight] — feet
 * @property {number} [dockDoors]
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
 * @typedef {Object} CostModelData
 * @property {number} [id]
 * @property {ProjectDetails} projectDetails
 * @property {VolumeLine[]} volumeLines
 * @property {OrderProfile} orderProfile
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

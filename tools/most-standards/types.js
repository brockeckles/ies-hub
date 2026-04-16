/**
 * IES Hub v3 — MOST Labor Standards Types
 * JSDoc typedefs for templates, elements, allowances, analyses, and workflows.
 *
 * @module tools/most-standards/types
 */

// ============================================================
// CORE ENTITIES — match Supabase ref tables
// ============================================================

/**
 * @typedef {Object} MostTemplate
 * @property {string} id — UUID
 * @property {string} name — e.g., "Case Pick - Manual"
 * @property {string} process_area — Receiving | Putaway | Picking | Packing | Shipping | Inventory
 * @property {string} labor_category — manual | mhe | hybrid
 * @property {string} [description]
 * @property {string} uom — pallet | case | each | order | line
 * @property {number} tmu_total — sum of element TMUs
 * @property {number} base_uph — 100,000 / tmu_total
 * @property {number} [element_count]
 * @property {boolean} [is_active]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} MostElement
 * @property {string} id — UUID
 * @property {string} template_id — FK → MostTemplate
 * @property {number} sequence — display order (1-based)
 * @property {string} description — e.g., "Walk to pick location"
 * @property {string} most_sequence — MOST sequence model code (e.g., "A6 B6 G1 A1 B0 P3 A0")
 * @property {number} tmu — time measurement units for this element
 * @property {boolean} [is_variable] — true if element varies with complexity/distance
 * @property {string} [variable_driver] — e.g., "distance", "weight", "sku_count"
 * @property {number} [variable_min] — min TMU value when variable
 * @property {number} [variable_max] — max TMU value when variable
 * @property {string} [notes]
 */

/**
 * @typedef {Object} AllowanceProfile
 * @property {string} id — UUID
 * @property {string} name — e.g., "Standard Warehouse", "Cold Storage"
 * @property {number} personal_pct — Personal allowance %
 * @property {number} fatigue_pct — Fatigue allowance %
 * @property {number} delay_pct — Delay allowance %
 * @property {number} total_pfd_pct — personal + fatigue + delay
 * @property {string} [description]
 */

// ============================================================
// ANALYSIS TYPES
// ============================================================

/**
 * A single activity line in a Quick Labor Analysis.
 * @typedef {Object} AnalysisLine
 * @property {string} id — client-side UUID
 * @property {string} [template_id] — FK → MostTemplate (null if manual entry)
 * @property {string} activity_name
 * @property {string} process_area
 * @property {string} labor_category — manual | mhe | hybrid
 * @property {string} uom
 * @property {number} base_uph — from template or manual
 * @property {number} adjusted_uph — after PFD allowance
 * @property {number} daily_volume
 * @property {number} hours_per_day — daily_volume / adjusted_uph
 * @property {number} fte — hours_per_day / shift_hours
 * @property {number} headcount — Math.ceil(fte)
 * @property {number} hourly_rate
 * @property {number} daily_cost — hours_per_day × hourly_rate
 */

/**
 * Quick Labor Analysis summary.
 * @typedef {Object} AnalysisSummary
 * @property {number} totalFtes
 * @property {number} totalHeadcount
 * @property {number} totalHoursPerDay
 * @property {number} dailyCost
 * @property {number} annualCost — dailyCost × operatingDays
 * @property {number} operatingDays
 * @property {{ manual: number, mhe: number, hybrid: number }} ftesByCategory
 * @property {{ manual: number, mhe: number, hybrid: number }} hoursByCategory
 */

/**
 * Saved analysis configuration.
 * @typedef {Object} LaborAnalysis
 * @property {string} [id] — UUID (null if unsaved)
 * @property {string} name
 * @property {string} [allowance_profile_id]
 * @property {number} pfd_pct — applied PFD percentage
 * @property {number} shift_hours — hours per shift (e.g., 8 or 10)
 * @property {number} operating_days — annual operating days (e.g., 260)
 * @property {number} hourly_rate — default hourly rate
 * @property {AnalysisLine[]} lines
 * @property {string} [created_at]
 */

// ============================================================
// WORKFLOW COMPOSER
// ============================================================

/**
 * A step in a workflow pipeline.
 * @typedef {Object} WorkflowStep
 * @property {string} id — client-side UUID
 * @property {string} [template_id]
 * @property {string} step_name
 * @property {string} process_area
 * @property {string} labor_category
 * @property {number} base_uph
 * @property {number} adjusted_uph — after PFD
 * @property {number} volume_ratio — fraction of total volume flowing through this step (0–1)
 * @property {number} daily_volume — target_volume × volume_ratio
 * @property {number} hours_per_day
 * @property {number} fte
 */

/**
 * Full workflow configuration.
 * @typedef {Object} Workflow
 * @property {string} [id]
 * @property {string} name
 * @property {number} target_volume_per_day
 * @property {number} shift_hours
 * @property {number} pfd_pct
 * @property {WorkflowStep[]} steps
 */

/**
 * Workflow analysis result.
 * @typedef {Object} WorkflowResult
 * @property {number} bottleneckUph — lowest adjusted_uph among steps
 * @property {string} bottleneckStep — name of the bottleneck step
 * @property {number} totalFtes
 * @property {number} totalHoursPerDay
 * @property {{ manual: number, mhe: number, hybrid: number }} ftesByCategory
 */

// ============================================================
// INTEGRATION (MOST → CM)
// ============================================================

/**
 * Payload emitted on bus 'most:push-to-cm' event.
 * @typedef {Object} MostToCmPayload
 * @property {Array<{ activity_name: string, process_area: string, labor_category: string, annual_hours: number, base_uph: number, volume: number, hourly_rate: number, burden_pct: number, most_template_id: string, most_template_name: string }>} laborLines
 * @property {number} operatingDays
 * @property {number} shiftHours
 */

export {};

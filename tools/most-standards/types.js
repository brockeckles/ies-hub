/**
 * IES Hub v3 — MOST Labor Standards Types
 * JSDoc typedefs for templates, elements, allowances, analyses, and workflows.
 *
 * Aligned with actual Supabase schema as of 2026-04-17:
 *   ref_most_templates: id bigint, activity_name, process_area, labor_category,
 *                       equipment_type, pick_method, uom, units_per_hour_base,
 *                       total_tmu_base, wms_transaction, description, notes,
 *                       is_active, created_at, updated_at
 *   ref_most_elements:  id bigint, template_id bigint (FK), sequence_order,
 *                       sequence_type, element_name, most_sequence, tmu_value,
 *                       is_variable, variable_driver, variable_formula, notes
 *
 * LEGACY ALIAS NOTE: many code paths still read tpl.name / tpl.base_uph /
 * tpl.tmu_total / el.sequence / el.description / el.tmu. Accessor helpers in
 * tools/cost-model/ui.js (mostTplName, mostTplUph, mostTplTmu, mostElSeq,
 * mostElName, mostElTmu) bridge both shapes for robustness. Prefer the real
 * column names in new code.
 *
 * @module tools/most-standards/types
 */

// ============================================================
// CORE ENTITIES — match Supabase ref tables verbatim
// ============================================================

/**
 * @typedef {Object} MostTemplate
 * @property {number} id — bigint primary key
 * @property {string} activity_name — e.g., "Receive & Check-in Cases"
 * @property {string} process_area — Receiving | Putaway | Replenishment | Picking | Packing | Shipping | Inventory | Returns | VAS
 * @property {string} labor_category — manual | mhe | hybrid
 * @property {string} [equipment_type] — MHE or device assumed by the template (optional)
 * @property {string} [pick_method] — discrete | batch | wave | zone (optional)
 * @property {string} uom — pallet | case | each | order | line
 * @property {number} units_per_hour_base — base UPH before PFD
 * @property {number} total_tmu_base — sum of element TMUs
 * @property {string} [wms_transaction] — associated BY WMS screen/transaction
 * @property {string} [description]
 * @property {string} [notes]
 * @property {boolean} [is_active]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} MostElement
 * @property {number} id — bigint primary key
 * @property {number} template_id — FK → MostTemplate.id
 * @property {number} sequence_order — display order (1-based)
 * @property {string} [sequence_type] — GET | PUT | VERIFY | MOVE | etc. (optional categorization)
 * @property {string} element_name — e.g., "Walk to pick location"
 * @property {string} [most_sequence] — MOST sequence model code (e.g., "A6 B6 G1 A1 B0 P3 A0")
 * @property {number} tmu_value — time measurement units for this element
 * @property {boolean} [is_variable] — true if element varies with complexity/distance
 * @property {string} [variable_driver] — e.g., "distance", "weight", "sku_count"
 * @property {string} [variable_formula] — optional formula for variable TMU
 * @property {number} [freq_per_cycle] — occurrences per work cycle (default 1.0; drives B3 frequency-weighted totals)
 * @property {string} [notes]
 */

/**
 * @typedef {Object} AllowanceProfile
 * @property {number} id — bigint primary key
 * @property {string} profile_name — e.g., "Standard Ambient Warehouse", "Cold Storage"
 * @property {number} personal_pct — Personal allowance %
 * @property {number} fatigue_pct — Fatigue allowance %
 * @property {number} delay_pct — Delay allowance %
 * @property {number} [total_pfd_pct] — personal + fatigue + delay (denormalized; recomputed on save)
 * @property {string} [environment_type] — 'ambient' | 'cold' | 'frozen'
 * @property {string} [notes]
 * @property {boolean} [is_default]
 */

// ============================================================
// ANALYSIS TYPES
// ============================================================

/**
 * A single activity line in a Quick Labor Analysis.
 * @typedef {Object} AnalysisLine
 * @property {string} id — client-side UUID
 * @property {number|string} [template_id] — FK → MostTemplate (null if manual entry)
 * @property {string} activity_name
 * @property {string} process_area
 * @property {string} labor_category — manual | mhe | hybrid
 * @property {string} uom
 * @property {number} base_uph — from template (units_per_hour_base) or manual
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
 * @property {number} [allowance_profile_id]
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
 * @property {number|string} [template_id]
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
 * @property {Array<{ activity_name: string, process_area: string, labor_category: string, annual_hours: number, base_uph: number, volume: number, hourly_rate: number, burden_pct: number, most_template_id: number|string, most_template_name: string, wms_transaction?: string, equipment_type?: string, pick_method?: string }>} laborLines
 * @property {number} operatingDays
 * @property {number} shiftHours
 */

// ============================================================
// SCHEMA ACCESSOR HELPERS — bridge v2 names to v3 schema
// ============================================================

/**
 * Get template activity_name (v3 schema).
 * @param {MostTemplate} tpl
 * @returns {string}
 */
export function getMostTplName(tpl) {
  return tpl?.activity_name || '';
}

/**
 * Get template base UPH (v3: units_per_hour_base).
 * @param {MostTemplate} tpl
 * @returns {number}
 */
export function getMostTplBaseUph(tpl) {
  return tpl?.units_per_hour_base || 0;
}

/**
 * Get template total TMU (v3: total_tmu_base).
 * @param {MostTemplate} tpl
 * @returns {number}
 */
export function getMostTplTmuTotal(tpl) {
  return tpl?.total_tmu_base || 0;
}

/**
 * Get element name (v3: element_name).
 * @param {MostElement} el
 * @returns {string}
 */
export function getMostElName(el) {
  return el?.element_name || '';
}

/**
 * Get element sequence order (v3: sequence_order).
 * @param {MostElement} el
 * @returns {number}
 */
export function getMostElSequence(el) {
  return el?.sequence_order || 0;
}

/**
 * Get element TMU value (v3: tmu_value).
 * @param {MostElement} el
 * @returns {number}
 */
export function getMostElTmu(el) {
  return el?.tmu_value || 0;
}

export {};

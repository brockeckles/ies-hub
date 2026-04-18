/**
 * IES Hub v3 — Deal Manager (Multi-Site Analyzer) Types
 * JSDoc typedefs for deals, sites, DOS stages, financials, and artifacts.
 *
 * @module tools/deal-manager/types
 */

// ============================================================
// DEAL ENTITY
// ============================================================

/**
 * @typedef {Object} Deal
 * @property {string} [id]
 * @property {string} dealName
 * @property {string} clientName
 * @property {string} dealOwner
 * @property {'draft' | 'in_progress' | 'proposal_sent' | 'won' | 'lost'} status
 * @property {string} [notes]
 * @property {number} [contractTermYears]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

// ============================================================
// SITE (linked cost model)
// ============================================================

/**
 * @typedef {Object} Site
 * @property {string} id
 * @property {string} name
 * @property {string} [market] — e.g. 'Southeast', 'Midwest'
 * @property {string} [environment] — e.g. 'Ambient', 'Cold Chain', 'E-Commerce'
 * @property {number} sqft
 * @property {number} annualCost
 * @property {number} targetMarginPct
 * @property {number} [startupCost]
 * @property {string} [pricingModel] — 'cost-plus', 'transactional', 'hybrid'
 * @property {CostBreakdown} [costBreakdown]
 * @property {number} [annualVolume]
 * @property {string} [costModelId] — link to Cost Model Builder for this site
 */

/**
 * @typedef {Object} CostBreakdown
 * @property {number} labor
 * @property {number} facility
 * @property {number} equipment
 * @property {number} overhead
 * @property {number} vas
 * @property {number} transportation
 */

// ============================================================
// FINANCIALS
// ============================================================

/**
 * @typedef {Object} DealFinancials
 * @property {number} totalAnnualCost
 * @property {number} totalAnnualRevenue
 * @property {number} grossMarginPct
 * @property {number} ebitdaPct
 * @property {number} totalStartupCost
 * @property {number} npv
 * @property {number} paybackMonths
 * @property {number} irr
 * @property {number} totalSqft
 * @property {number} costPerSqft
 * @property {number} revenuePerSqft
 * @property {SiteFinancials[]} bySite
 */

/**
 * @typedef {Object} SiteFinancials
 * @property {string} siteId
 * @property {string} siteName
 * @property {number} annualCost
 * @property {number} annualRevenue
 * @property {number} grossMarginPct
 * @property {number} costPerSqft
 */

/**
 * @typedef {Object} MultiYearRow
 * @property {number} year
 * @property {number} revenue
 * @property {number} cost
 * @property {number} grossProfit
 * @property {number} ebitda
 * @property {number} cumulativeCashFlow
 */

// ============================================================
// DOS STAGES
// ============================================================

/**
 * @typedef {Object} DosStage
 * @property {number} stageNumber — 1-6
 * @property {string} stageName
 * @property {DosElement[]} elements
 */

/**
 * @typedef {Object} DosElement
 * @property {string} id
 * @property {string} name
 * @property {string} elementType
 * @property {string} workstream
 * @property {string} [description]
 * @property {'not_started' | 'in_progress' | 'complete' | 'blocked' | 'na' | 'skipped'} status
 * @property {string} [assignedTo]
 * @property {string} [dueDate]
 */

/**
 * @typedef {Object} StageProgress
 * @property {number} stageNumber
 * @property {string} stageName
 * @property {number} total
 * @property {number} completed
 * @property {number} inProgress
 * @property {number} blocked
 * @property {number} pct — completion percentage
 */

// ============================================================
// ARTIFACTS
// ============================================================

/**
 * @typedef {Object} DealArtifact
 * @property {string} id
 * @property {string} dealId
 * @property {'cost_model' | 'netopt_scenario' | 'fleet_scenario' | 'cog_scenario' | 'document'} artifactType
 * @property {string} artifactId
 * @property {string} [artifactName]
 * @property {string} [created_at]
 */

// ============================================================
// HOURS TRACKING
// ============================================================

/**
 * @typedef {Object} HoursEntry
 * @property {string} [id]
 * @property {string} opportunity_id
 * @property {string} week_start — ISO date (YYYY-MM-DD)
 * @property {string} hours_type — Sales Design, Engineering, Deal Mgmt, Site Visit, Customer Meeting, Internal Review, Documentation, Other
 * @property {number} hours
 * @property {string} [resource]
 * @property {'forecast' | 'actual'} category
 * @property {string} [notes]
 */

// ============================================================
// TASKS
// ============================================================

/**
 * @typedef {Object} Task
 * @property {string} [id]
 * @property {string} opportunity_id
 * @property {string} title
 * @property {string} [description]
 * @property {'todo' | 'in_progress' | 'done' | 'blocked'} status
 * @property {'low' | 'medium' | 'high' | 'critical'} priority
 * @property {string} [due_date]
 * @property {number} [estimated_hours]
 * @property {number} [actual_hours]
 * @property {string} [assignee]
 * @property {number} [dos_stage_number]
 * @property {string} [dos_stage_name]
 * @property {number} [sort_order]
 */

// ============================================================
// WEEKLY UPDATES
// ============================================================

/**
 * @typedef {Object} WeeklyUpdate
 * @property {string} [id]
 * @property {string} opportunity_id
 * @property {string} update_date — ISO date (YYYY-MM-DD)
 * @property {string} [author]
 * @property {string} body
 * @property {string} [next_steps]
 * @property {string} [blockers]
 */

// ============================================================
// HOURS SUMMARY
// ============================================================

/**
 * @typedef {Object} HoursSummary
 * @property {number} totalForecast
 * @property {number} totalActual
 * @property {number} delta
 * @property {number} percentUtilized
 * @property {Array<{ type: string, forecast: number, actual: number }>} byWorkType
 * @property {Array<{ week: string, forecast: number, actual: number, delta: number }>} byWeek
 */

// ============================================================
// TASK PROGRESS
// ============================================================

/**
 * @typedef {Object} TaskProgress
 * @property {number} dosStageNumber
 * @property {string} dosStageName
 * @property {number} total
 * @property {number} done
 * @property {number} inProgress
 * @property {number} blocked
 */

/**
 * @typedef {Object} TaskSummary
 * @property {number} total
 * @property {number} done
 * @property {number} inProgress
 * @property {number} blocked
 * @property {number} percentComplete
 * @property {Array<TaskProgress>} byStage
 * @property {Array<{ priority: string, count: number }>} byPriority
 */

export {};

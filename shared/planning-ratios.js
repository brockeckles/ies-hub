/**
 * IES Hub v3 — Planning Ratios Helper
 *
 * Pure helpers for resolving ref_planning_ratios rows against a project's
 * context (vertical / environment / automation / market tier) and overrides.
 *
 * Complements the existing ref_design_heuristics system (26-row analyst-
 * facing knobs). This module covers the richer engineering-defaults catalog
 * (142+ rows, 17 categories) with applicability filters and SCD versioning.
 *
 * Design goals:
 *  - Pure (no DOM, no Supabase, no CDN globals) — calc-safe.
 *  - No mutation of inputs.
 *  - Deterministic given the same (catalog, overrides, context).
 *
 * @module shared/planning-ratios
 */

/**
 * @typedef {Object} PlanningRatio
 * @property {number} id
 * @property {string} category_code
 * @property {string} ratio_code
 * @property {string} display_name
 * @property {string} value_type      scalar|percent|psf|per_sf_1k|per_unit|array|lookup|tiered
 * @property {number|null} numeric_value
 * @property {string|null} value_unit
 * @property {*} value_jsonb
 * @property {string|null} vertical
 * @property {string|null} environment_type
 * @property {string|null} automation_level
 * @property {string|null} market_tier
 * @property {string} source
 * @property {string|null} source_detail
 * @property {string|null} source_date      YYYY-MM-DD
 * @property {string} effective_date
 * @property {string} effective_end_date
 * @property {number} sort_order
 * @property {string|null} notes
 * @property {boolean} is_active
 */

/**
 * @typedef {Object} RatioContext
 * @property {string} [vertical]
 * @property {string} [environment_type]
 * @property {string} [automation_level]
 * @property {string} [market_tier]
 * @property {string|Date} [asOf]          defaults to today
 */

/**
 * @typedef {Object} RatioOverride
 * @property {number|string} value
 * @property {string} [note]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} ResolvedRatio
 * @property {*} value                         numeric, string, array, or structured jsonb
 * @property {'override'|'default'|'missing'} source
 * @property {PlanningRatio|null} def          the catalog row that was matched (if any)
 * @property {RatioOverride|null} [override]   the override payload (if source='override')
 */

/**
 * Resolve one ratio given a catalog + overrides + project context.
 * Applicability scoring: vertical (8) > environment_type (4) > automation_level (2) > market_tier (1).
 * A row with NULL in any of those dimensions is "applies to all" for that dimension (neutral; no score).
 * A row with a non-NULL filter is disqualified if the project context doesn't match.
 * Highest score wins; ties broken by lowest id (most-recent addition first would be highest id — we prefer stable).
 *
 * @param {string} code
 * @param {RatioContext} context
 * @param {PlanningRatio[]} catalog
 * @param {Object<string, RatioOverride>} overrides
 * @returns {ResolvedRatio}
 */
export function lookupRatio(code, context, catalog, overrides) {
  const ctx = context || {};
  const ov = (overrides || {})[code];

  const def = findBestCatalogRow(code, ctx, catalog || []);

  // Override wins if it has a usable value
  if (ov && ov.value !== null && ov.value !== undefined && ov.value !== '') {
    return { value: coerceValue(ov.value, def), source: 'override', def, override: ov };
  }

  if (!def) return { value: null, source: 'missing', def: null };

  const value =
    def.value_type === 'array' || def.value_type === 'lookup' || def.value_type === 'tiered'
      ? def.value_jsonb
      : def.numeric_value;
  return { value, source: 'default', def };
}

/**
 * Convenience: return just the value (coerced to number when scalar-ish) with
 * a fallback for "missing" or null. Use when calc only cares about the value.
 *
 * @param {string} code
 * @param {RatioContext} context
 * @param {PlanningRatio[]} catalog
 * @param {Object} overrides
 * @param {*} [fallback]
 * @returns {*}
 */
export function ratioValue(code, context, catalog, overrides, fallback = null) {
  const { value } = lookupRatio(code, context, catalog, overrides);
  if (value === null || value === undefined) return fallback;
  return value;
}

/**
 * Pre-compute all ratios for a given context. Returns a map keyed by
 * ratio_code with the full ResolvedRatio for each. Handy when a single calc
 * function needs many ratios and we want to avoid repeated list scans.
 *
 * @param {PlanningRatio[]} catalog
 * @param {Object} overrides
 * @param {RatioContext} context
 * @returns {Object<string, ResolvedRatio>}
 */
export function resolvePlanningRatios(catalog, overrides, context) {
  const out = {};
  const seen = new Set();
  for (const r of catalog || []) {
    if (seen.has(r.ratio_code)) continue;
    seen.add(r.ratio_code);
    out[r.ratio_code] = lookupRatio(r.ratio_code, context, catalog, overrides);
  }
  return out;
}

/**
 * Count overrides that are set. Used by the UI status chip ("3 overrides").
 * @param {Object} overrides
 * @returns {number}
 */
export function countRatioOverrides(overrides) {
  const o = overrides || {};
  let n = 0;
  for (const key of Object.keys(o)) {
    const ov = o[key];
    if (ov && ov.value !== null && ov.value !== undefined && ov.value !== '') n += 1;
  }
  return n;
}

/**
 * Stale source detection. A ratio is "needs refresh" if its source_date is
 * before the threshold. Threshold is 2022-01-01 by default.
 * @param {PlanningRatio} row
 * @param {string} [thresholdIso]  default '2022-01-01'
 * @returns {boolean}
 */
export function isStale(row, thresholdIso) {
  if (!row || !row.source_date) return false;
  const threshold = new Date(thresholdIso || '2022-01-01');
  const d = new Date(row.source_date);
  if (Number.isNaN(d.getTime())) return false;
  return d < threshold;
}

/**
 * Per-project staleness check: a row is "stale for this project" only if the
 * catalog says it's stale AND the project's override payload doesn't carry a
 * `reviewed_at` marker for that ratio_code. 2026-04-21 PM addition — lets an
 * analyst acknowledge "yes I've audited this pre-2022 value for this deal"
 * without mutating the catalog. The marker is scoped to the project (stored
 * in planningRatioOverrides[ratio_code].reviewed_at) so other projects still
 * see the stale chip until they've been reviewed individually.
 *
 * @param {PlanningRatio} row
 * @param {Object<string, RatioOverride>} overrides
 * @param {string} [thresholdIso]
 * @returns {boolean}
 */
export function isStaleForProject(row, overrides, thresholdIso) {
  if (!isStale(row, thresholdIso)) return false;
  const ov = overrides && overrides[row.ratio_code];
  return !(ov && ov.reviewed_at);
}

/**
 * Mark a ratio as reviewed on a project — returns a NEW overrides object with
 * reviewed_at stamped. Value is preserved (if any); a row with no override
 * still gets a review marker so it drops off the stale list.
 *
 * @param {Object<string, RatioOverride>} overrides
 * @param {string} ratioCode
 * @param {string} [isoNow]
 * @returns {Object<string, RatioOverride>}
 */
export function markRatioReviewed(overrides, ratioCode, isoNow) {
  const now = isoNow || new Date().toISOString();
  const prev = (overrides && overrides[ratioCode]) || {};
  return {
    ...(overrides || {}),
    [ratioCode]: { ...prev, reviewed_at: now },
  };
}

/**
 * Count rows that are stale AND not yet reviewed on this project.
 * @param {PlanningRatio[]} catalog
 * @param {Object<string, RatioOverride>} overrides
 * @returns {number}
 */
export function countStaleUnreviewed(catalog, overrides) {
  let n = 0;
  for (const row of catalog || []) {
    if (isStaleForProject(row, overrides)) n += 1;
  }
  return n;
}

/**
 * Group rows by category_code for UI rendering. Returns an ordered array of
 * {category, rows[]} preserving category sort_order and row sort_order within.
 *
 * @param {PlanningRatio[]} catalog
 * @param {Array<{code: string, display_name: string, sort_order: number}>} categories
 * @returns {Array<{category: Object, rows: PlanningRatio[]}>}
 */
export function groupByCategory(catalog, categories) {
  const byCat = new Map();
  for (const r of catalog || []) {
    if (!byCat.has(r.category_code)) byCat.set(r.category_code, []);
    byCat.get(r.category_code).push(r);
  }
  const catList = (categories || [])
    .slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  return catList.map(cat => ({
    category: cat,
    rows: (byCat.get(cat.code) || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  }));
}

// ============================================================
// INTERNAL
// ============================================================

/**
 * Find the most-specific catalog row applicable to the project's context.
 */
function findBestCatalogRow(code, ctx, catalog) {
  const asOf = ctx.asOf ? new Date(ctx.asOf) : new Date();

  const matches = [];
  for (const r of catalog) {
    if (r.ratio_code !== code) continue;
    if (r.is_active === false) continue;
    if (r.effective_date && new Date(r.effective_date) > asOf) continue;
    if (r.effective_end_date && new Date(r.effective_end_date) < asOf) continue;

    let score = 0;
    let ok = true;
    if (r.vertical != null) {
      if (r.vertical === ctx.vertical) score += 8;
      else { ok = false; }
    }
    if (r.environment_type != null) {
      if (r.environment_type === ctx.environment_type) score += 4;
      else { ok = false; }
    }
    if (r.automation_level != null) {
      if (r.automation_level === ctx.automation_level) score += 2;
      else { ok = false; }
    }
    if (r.market_tier != null) {
      if (r.market_tier === ctx.market_tier) score += 1;
      else { ok = false; }
    }
    if (!ok) continue;
    matches.push({ r, score });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tiebreak: prefer lower id (more established seed rows)
    return (a.r.id || 0) - (b.r.id || 0);
  });
  return matches[0].r;
}

/**
 * Coerce an override value into the type the catalog row expects. Overrides
 * come in from UI as strings; scalar/percent/psf/per_unit should parse to
 * numbers. Structured types (array/lookup/tiered) pass through.
 */
function coerceValue(rawValue, def) {
  if (!def) return rawValue;
  const structured = def.value_type === 'array' || def.value_type === 'lookup' || def.value_type === 'tiered';
  if (structured) return rawValue;
  if (typeof rawValue === 'number') return rawValue;
  const n = Number(rawValue);
  return Number.isFinite(n) ? n : rawValue;
}

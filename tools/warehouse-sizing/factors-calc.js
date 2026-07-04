/**
 * IES Hub v3 — WSC design-factor pinning (N2, 2026-07-04)
 *
 * The catalog (ref_planning_ratios, wsc_* categories) is org-wide guidance;
 * each scenario PINS the factors at first save (config_data.pinnedFactors)
 * and never silently changes. Later catalog edits surface as drift; analysts
 * adopt by explicit action. Mirrors CM House Assumptions (Brock 2026-07-04:
 * same governance).
 *
 * Pure module — zero DOM, zero imports. Tested by test-wsc-factors.mjs.
 *
 * @module tools/warehouse-sizing/factors-calc
 */

/**
 * Snapshot live catalog rows into the project-pinnable shape.
 * @param {Object[]} rows — live ref_planning_ratios rows (wsc_* categories)
 * @param {string} [asOf] — pin date (YYYY-MM-DD); defaults to today
 * @returns {{ pinnedAt: string, rows: Object[] }}
 */
export function pinWscFactors(rows, asOf) {
  const clean = (rows || []).map(r => ({
    category_code: r.category_code ?? null,
    ratio_code:    r.ratio_code ?? null,
    display_name:  r.display_name ?? null,
    value_type:    r.value_type ?? null,
    numeric_value: r.numeric_value == null ? null : Number(r.numeric_value),
    value_unit:    r.value_unit ?? null,
    value_jsonb:   r.value_jsonb ?? null,
    source:        r.source ?? null,
    source_detail: r.source_detail ?? null,
    source_date:   r.source_date ?? null,
    sort_order:    r.sort_order ?? 100,
  }));
  clean.sort((a, b) => (a.category_code || '').localeCompare(b.category_code || '')
    || (a.sort_order - b.sort_order));
  return { pinnedAt: asOf || new Date().toISOString().slice(0, 10), rows: clean };
}

/** Stable value equality across numeric + jsonb shapes. */
function _valueEq(a, b) {
  const na = a.numeric_value == null ? null : Number(a.numeric_value);
  const nb = b.numeric_value == null ? null : Number(b.numeric_value);
  if (na !== nb) return false;
  return JSON.stringify(a.value_jsonb ?? null) === JSON.stringify(b.value_jsonb ?? null);
}

/**
 * Compare pinned factors against the live catalog.
 * @param {{ rows: Object[] }} pinned
 * @param {Object[]} currentRows — live rows
 * @returns {{ rows: Object[], anyDrift: boolean }} each row gains
 *   { current, changed, missing }; catalog rows the pin has never seen
 *   are returned in `added`.
 */
export function wscFactorsDrift(pinned, currentRows) {
  const cur = new Map((currentRows || []).map(r => [r.ratio_code, r]));
  const seen = new Set();
  const rows = (pinned?.rows || []).map(r => {
    seen.add(r.ratio_code);
    const c = cur.get(r.ratio_code) || null;
    const changed = !!c && !_valueEq(r, c);
    return { ...r, current: c, changed, missing: !c };
  });
  const added = (currentRows || []).filter(r => !seen.has(r.ratio_code));
  return { rows, added, anyDrift: rows.some(r => r.changed || r.missing) || added.length > 0 };
}

/**
 * Read one pinned factor's effective value.
 * @param {{ rows: Object[] }|null} pinned
 * @param {string} code — ratio_code
 * @returns {number|Object|null} numeric_value if scalar/percent, else value_jsonb
 */
export function wscFactorValue(pinned, code) {
  const r = (pinned?.rows || []).find(x => x.ratio_code === code);
  if (!r) return null;
  return r.numeric_value != null ? r.numeric_value : (r.value_jsonb ?? null);
}

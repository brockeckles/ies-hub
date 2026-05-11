/**
 * shared/format.js — canonical display-formatting helpers.
 *
 * Consolidates 4 copies of formatCurrency, 5 copies of formatPct,
 * and one-offs (formatNumber / formatMiles / formatMonths / formatCpm /
 * formatFt) that were duplicated across tools/{cost-model,network-opt,
 * fleet-modeler,deal-manager,warehouse-sizing}/calc.js.
 *
 * Created 2026-05-11 (S16) to close out the assessment's "consolidate 4
 * toast helpers" Week-2 hardening note + the parked TODO on
 * cost-model/calc.js#formatNumber ("A future Phase 2 should hoist the
 * trio out to shared/format.js"). Each tool's calc.js now re-exports
 * from this module rather than carrying its own copy, so all consumer
 * call sites (`calc.formatCurrency(...)` etc.) keep working unchanged.
 *
 * All functions are pure, defensive against null/NaN/undefined, and
 * return '—' or 'N/A' for non-finite input rather than throwing or
 * producing 'NaN%'.
 */

/**
 * Format a number as USD currency.
 *
 * @param {number} value — raw dollar amount
 * @param {object} [opts]
 * @param {boolean} [opts.compact] — collapse to "$1.5M" / "$250K" for
 *   readability in dashboards / chart tooltips
 * @param {number} [opts.decimals] — force a specific decimal count.
 *   When omitted, defaults to 0 for whole-dollar amounts (≥$1) and
 *   2 for sub-dollar amounts (cents / rate-per-unit displays).
 * @returns {string}
 *
 * Examples:
 *   formatCurrency(1234567)                    → "$1,234,567"
 *   formatCurrency(1234567, { compact: true }) → "$1.2M"
 *   formatCurrency(0.50)                       → "$0.50"
 *   formatCurrency(NaN)                        → "—"
 */
export function formatCurrency(value, opts = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (opts.compact) {
    if (Math.abs(value) >= 1_000_000) return '$' + (value / 1_000_000).toFixed(1) + 'M';
    if (Math.abs(value) >= 1_000)     return '$' + (value / 1_000).toFixed(0) + 'K';
  }
  const decimals = opts.decimals ?? (Math.abs(value) >= 1 ? 0 : 2);
  return '$' + value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a raw percentage value as "X.X%".
 *
 * @param {number} value — raw percent (e.g. 12.5 for 12.5%, NOT 0.125)
 * @param {number} [decimals=1] — fractional digits to display
 * @returns {string}
 *
 * Examples:
 *   formatPct(12.5)       → "12.5%"
 *   formatPct(12.5, 0)    → "13%"
 *   formatPct(null)       → "—"
 *   formatPct(NaN)        → "—"
 */
export function formatPct(value, decimals = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(decimals) + '%';
}

/**
 * Format a plain number with thousands separators (en-US locale).
 * Use for read-only displays of headcount, square footage, hours,
 * units, throughput. NOT for input values (HTML <input type="number">
 * won't accept comma-separated text).
 *
 * @param {number} value
 * @param {number} [decimals=0]
 * @returns {string}
 *
 * Examples:
 *   formatNumber(7323691)  → "7,323,691"
 *   formatNumber(134.2, 1) → "134.2"
 *   formatNumber(NaN)      → "—"
 */
export function formatNumber(value, decimals = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format mileage as "12,345 mi" (rounded to integer).
 * Used by Fleet Modeler + NetOpt for transit distance displays.
 *
 * @param {number} miles
 * @returns {string}
 */
export function formatMiles(miles) {
  if (miles == null || !Number.isFinite(miles)) return '—';
  return Math.round(miles).toLocaleString() + ' mi';
}

/**
 * Format a duration in months as "X.X mo" (under a year) or "X.X yr".
 * Used by Deal Manager for payback / cycle-time displays. Returns
 * 'N/A' for non-finite or non-positive input (the deal-manager
 * convention; preserved for back-compat).
 *
 * @param {number} months
 * @returns {string}
 */
export function formatMonths(months) {
  if (!Number.isFinite(months) || months <= 0) return 'N/A';
  if (months < 12) return months.toFixed(1) + ' mo';
  return (months / 12).toFixed(1) + ' yr';
}

/**
 * Format cost-per-mile as "$1.234/mi" (3 decimals).
 * Used by Fleet Modeler.
 *
 * @param {number} cpm
 * @returns {string}
 */
export function formatCpm(cpm) {
  if (cpm == null || !Number.isFinite(cpm)) return '—';
  return '$' + cpm.toFixed(3) + '/mi';
}

/**
 * Format a measurement in feet as "X.X ft" (1 decimal).
 * Used by Warehouse Sizing for clear-height / rack-height displays.
 *
 * @param {number} ft
 * @returns {string}
 */
export function formatFt(ft) {
  if (ft == null || !Number.isFinite(ft)) return '—';
  return ft.toFixed(1) + ' ft';
}

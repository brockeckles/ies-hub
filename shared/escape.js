/**
 * shared/escape.js — canonical HTML-escape helpers.
 *
 * Consolidates the 8 copies of escapeHtml/escapeAttr that lived in
 * tools/{network-opt,cost-model,warehouse-sizing,deal-manager}/ui.js +
 * hub/{admin,deal-management}/ui.js. All bodies were functionally
 * equivalent (escape `&`, `<`, `>`, `"`, `'` to their HTML entities)
 * with stylistic variation (regex-lookup vs replaceAll vs chained
 * .replace). This module is the single source of truth.
 *
 * Created 2026-05-11 (S17). The shared/ helpers that live in
 * shared/{tour,tool-frame,mfa-ui}.js are left alone for now — their
 * consumers each carry their own cache-bust chain, and the assessment
 * doesn't flag duplication inside shared/ as load-bearing.
 *
 * `shared/feedback-fab.js` keeps its own narrower escapeAttr (escapes
 * only `"` and `<`) — that's deliberate, not duplication.
 *
 * Both functions are pure and null-safe: passing null/undefined
 * returns an empty string rather than the literal 'null' / 'undefined'.
 */

/**
 * Escape a value for safe insertion into HTML text content.
 *
 * @param {*} s
 * @returns {string}
 *
 * Examples:
 *   escapeHtml('Tom & Jerry')        → "Tom &amp; Jerry"
 *   escapeHtml('<script>alert(1)')   → "&lt;script&gt;alert(1)"
 *   escapeHtml(null)                 → ""
 */
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * Escape a value for safe insertion into a double-quoted HTML
 * attribute. Currently identical to escapeHtml (covers both
 * `"`-quoted and `'`-quoted attribute contexts), but kept as a
 * distinct export so future divergence (e.g., attribute-specific
 * minimal escaping for size-critical templates) doesn't need to
 * touch every call site.
 *
 * @param {*} s
 * @returns {string}
 */
export function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * Resolve a value to a safe absolute http(s) URL for use in an href, or
 * return '' if it is not a plain web link. Blocks javascript:, data:,
 * vbscript:, file:, and any other scheme — the isRealLink() path-only
 * guards used by the intel feeds do NOT check scheme, so a feed row with
 * `source_url: "javascript:..."` would otherwise become a live href.
 *
 * Added 2026-07-02 (Phase 0 security) alongside the feed-XSS escaping.
 *
 * @param {*} s
 * @returns {string}  the normalized http(s) URL, or '' if unsafe/invalid
 */
export function safeHttpUrl(s) {
  if (s == null) return '';
  try {
    const base = (typeof window !== 'undefined' && window.location) ? window.location.href : undefined;
    const u = new URL(String(s), base);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch { /* not a parseable URL */ }
  return '';
}

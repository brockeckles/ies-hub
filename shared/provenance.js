/**
 * IES Hub — Value Provenance Grammar (S7c, 2026-07-28).
 *
 * ONE visual language for where a number came from, replacing the six local
 * dialects that had grown across the Hub (derived-volumes pills, reverse
 * auto-derive pill, heuristic chips, source badges, What-If badges,
 * house-guidance drift styling). Brock-approved from the concept mockup.
 *
 * The state model (Excel/banker convention, adapted):
 *   manual    — user-entered. NO decoration; the quiet default.
 *   derived   — system-computed, overridable. ƒ glyph + subtle blue tint.
 *               NOT gray: gray reads as "disabled" and these are the most
 *               load-bearing numbers on the page.
 *   override  — user-pinned over a derived value. Amber; variance vs the
 *               CURRENT derived value always visible; one-click reset path.
 *   linked    — pulled from another tool (WSC / MOST / NetOpt). Green ⇄.
 *
 * Rules (do not dilute):
 *   1. Never encode state by color alone — glyph + tooltip travel with it.
 *   2. Overridden values show BOTH numbers: pinned prominent, current
 *      derived as the ghost line. Upstream drift then surfaces for free.
 *   3. The default page stays SILENT. The ƒ treatment belongs on
 *      OVERRIDABLE derived values and linked values only — purely-computed
 *      display figures (KPI strips, P&L rows) keep the provenance
 *      inspector and stay undecorated. ~80% of a cost-model page is
 *      derived; decorate all of it and the signal dies.
 *
 * Pure render helpers — no DOM, no state; safe for the pure suite.
 * Styles ship as a <style> string appended once per mounted surface
 * (same pattern as tool-chrome/shell-d style blocks).
 *
 * @module shared/provenance
 */

import { escapeHtml, escapeAttr } from './escape.js?v=20260702-sec2';

/** Valid provenance states. Manual deliberately renders nothing. */
export const PROV_STATES = ['manual', 'derived', 'override', 'linked'];

/**
 * The ƒ glyph marking a system-derived, overridable value.
 * @param {string} [title] — tooltip; pass the formula when you have it.
 * @returns {string}
 */
export function fxGlyph(title) {
  return '<span class="hub-fx" title="'
    + escapeAttr(title || 'System-derived — click override to pin your own value')
    + '">ƒ</span>';
}

/**
 * Provenance pill.
 * @param {'derived'|'override'|'linked'} state
 * @param {string} label — e.g. 'override +8.3%', '⇄ WSC'
 * @param {string} [title] — tooltip
 * @returns {string} '' for manual/unknown states (manual is undecorated BY RULE)
 */
export function provPill(state, label, title) {
  if (state !== 'derived' && state !== 'override' && state !== 'linked') return '';
  const glyph = state === 'override' ? '⚑ ' : (state === 'linked' ? '⇄ ' : '');
  return '<span class="hub-prov-pill hub-prov-pill--' + state + '"'
    + (title ? ' title="' + escapeAttr(title) + '"' : '') + '>'
    + glyph + escapeHtml(label) + '</span>';
}

/**
 * Ghost line rendered under a pinned value showing the CURRENT derived
 * value — rule 2 of the grammar. Keeps drift visible: when upstream inputs
 * move, this line moves while the pinned number holds still.
 * @param {string} derivedText — pre-formatted derived value
 * @param {string} [title]
 * @returns {string}
 */
export function ghostDerived(derivedText, title) {
  return '<span class="hub-prov-ghost" title="'
    + escapeAttr(title || 'What the system derives from current inputs — the pinned value above overrides it')
    + '">ƒ ' + escapeHtml(derivedText) + ' derived</span>';
}

/**
 * Class string for an <input> carrying a non-manual state.
 * @param {'derived'|'override'} state
 * @returns {string} '' for anything else
 */
export function provInputClass(state) {
  if (state === 'derived') return 'hub-in--derived';
  if (state === 'override') return 'hub-in--override';
  return '';
}

/**
 * One style block for the whole grammar. Append once per mounted surface;
 * the id lets callers guard against double-injection if they care.
 * @returns {string}
 */
export function provenanceStyles() {
  return '<style id="hub-prov-styles">'
    + '.hub-fx{font-family:Georgia,serif;font-style:italic;font-size:0.92em;color:var(--ies-blue,#0047AB);opacity:.75;margin-right:3px;cursor:help;}'
    + '.hub-prov-pill{display:inline-flex;align-items:center;gap:4px;padding:1.5px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.03em;white-space:nowrap;}'
    + '.hub-prov-pill--derived{background:rgba(0,71,171,.07);color:var(--ies-blue,#0047AB);border:1px solid rgba(0,71,171,.20);}'
    + '.hub-prov-pill--override{background:rgba(217,119,6,.10);color:var(--c-warn-strong,#b45309);border:1px solid rgba(217,119,6,.30);text-transform:none;}'
    + '.hub-prov-pill--linked{background:rgba(21,128,61,.08);color:#0e7a4e;border:1px solid rgba(21,128,61,.25);}'
    + '.hub-prov-ghost{display:block;font-size:10px;color:var(--ies-gray-400,#a8a29e);font-weight:500;font-variant-numeric:tabular-nums;cursor:help;}'
    + '.hub-val--override{color:var(--c-warn-strong,#b45309);}'
    + '.hub-in--derived{border-color:rgba(0,71,171,.35)!important;background:rgba(0,71,171,.03)!important;}'
    + '.hub-in--override{border-color:rgba(217,119,6,.30)!important;background:rgba(217,119,6,.10)!important;}'
    + '.hub-prov-row--override{background:rgba(217,119,6,.03);}'
    + '</style>';
}

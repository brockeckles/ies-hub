/**
 * IES Hub v3 — shared/print-fonts.js (R3, 2026-07-10)
 *
 * Print-surface typography for popup documents (COG print view, WSC Design
 * Basis). Popups opened via window.open('') + document.write are separate
 * documents — they do NOT inherit css/hub.css, so the Editorial @font-face
 * set (R0: self-hosted Inter + Source Serif 4) must be inlined into the
 * popup's <style> with ABSOLUTE font URLs (about:blank inherits the
 * opener's base URL, but absolute is deterministic across browsers).
 *
 * Pure: no DOM/state at module scope; node-safe (location guarded) so
 * basis-doc.js stays importable by the test suite.
 *
 * Usage:
 *   import { printFontCss, FONT_UI, FONT_DISPLAY } from '../../shared/print-fonts.js';
 *   const html = `<style>${printFontCss()} body{font-family:${FONT_UI};} h1{font-family:${FONT_DISPLAY};}</style>`;
 */

/** Editorial stacks — keep in sync with css/hub.css --font-ui / --font-display. */
export const FONT_UI = "'Inter', -apple-system, 'Segoe UI', sans-serif";
export const FONT_DISPLAY = "'Source Serif 4', Georgia, serif";
export const FONT_MONO = "'SFMono-Regular', ui-monospace, Consolas, Menlo, monospace";

const FACES = [
  ['Inter', 400, 'inter-latin-400-normal.woff2'],
  ['Inter', 500, 'inter-latin-500-normal.woff2'],
  ['Inter', 600, 'inter-latin-600-normal.woff2'],
  ['Inter', 700, 'inter-latin-700-normal.woff2'],
  ['Source Serif 4', 600, 'source-serif-4-latin-600-normal.woff2'],
  ['Source Serif 4', 700, 'source-serif-4-latin-700-normal.woff2'],
];

/**
 * @font-face block for print popups.
 * @param {string} [base] Base URL to resolve assets/fonts/ against.
 *   Defaults to the current page (hash stripped by URL resolution).
 *   Falls back to relative paths when no location exists (node tests).
 */
export function printFontCss(base) {
  const origin = base ?? (typeof location !== 'undefined' ? location.href : '');
  const href = (file) => {
    const rel = `assets/fonts/${file}`;
    try { return origin ? new URL(rel, origin).href : rel; } catch { return rel; }
  };
  return FACES.map(([fam, w, file]) =>
    `@font-face { font-family: '${fam}'; font-style: normal; font-weight: ${w}; font-display: swap; src: url('${href(file)}') format('woff2'); }`
  ).join('\n');
}

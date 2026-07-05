/**
 * IES Hub v3 — Warehouse Sizing — WSC-specific styles (extracted from ui.js 2026-05-13)
 *
 * Slice 7 of 7: ~420 LOC of CSS as a tagged-template-string return value.
 * Pure function — no state reads, no inputs, no side effects. Returns the
 * `<style>...</style>` block that ui.js's renderShell injects into the DOM.
 *
 * Why a function vs static export? Historical: the styles formerly read
 * runtime CSS vars; current version is fully static but the call signature
 * is preserved for any future themed-style work.
 *
 * @module tools/warehouse-sizing/ui-styles
 */

export function wscExtraStyles() {
  return `
    <style>
      /* U3 migration classes (2026-07-05) — extracted repeated inline styles.
         Values byte-identical to the inline originals. */
      .wsc-kv-plain { display: flex; justify-content: space-between; padding: 2px 0; }
      .wsc-muted-reg { color: var(--ies-gray-500); font-weight: 400; }
      .wsc-subsection { margin-top: 14px; padding-top: 8px; border-top: 1px solid var(--ies-gray-100); }
      .wsc-microlabel { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ies-gray-500); margin-bottom: 6px; }
      .wsc-microlabel-b { font-weight: 700; margin-bottom: 4px; color: var(--ies-gray-500); text-transform: uppercase; font-size: 10px; }
      .wsc-label-soft { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--ies-gray-400); }
      .wsc-section-title { font-size: 13px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; color: var(--ies-gray-700); }
      .wsc-rule-top { border-top: 1px solid var(--ies-gray-100); }
      .wsc-note { margin-top: 8px; padding: 8px 10px; background: var(--ies-gray-50); border-radius: 4px; font-size: 11px; color: var(--ies-gray-700); }
      .wsc-stat { font-size: 16px; font-weight: 700; }
      .wsc-card-title { font-size: 12px; font-weight: 700; margin-bottom: 8px; }
      /* WSC-scoped sidebar widen — Phase 4 cosmetic. The chrome's default
         240px sidebar was tight for some Configure inputs (5-digit Pallet
         Positions / Total SKUs, 3-decimal cartonsPerPalletOverride, etc.).
         Bump to 350px while the WSC is mounted; reverts on unmount because
         the inline <style> tag goes with the WSC HTML. Tool-chrome.js'
         transition rule animates the change cleanly. */
      .tool-chrome-shell .tc-sidebar {
        flex: 0 0 350px !important;
        width: 350px !important;
      }

      /* Section grouping inside the Configure drawer. */
      .wsc-config-section {
        padding: 16px;
        border-bottom: 1px solid var(--ies-gray-100);
      }
      .wsc-config-section:last-child { border-bottom: 0; }
      .wsc-config-section h4,
      .wsc-config-title {
        margin: 0 0 12px 0;
        font-size: 11px;
        font-weight: 700;
        color: var(--ies-gray-500);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      /* Two-column row of fields. */
      .wsc-config-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 8px;
      }
      .wsc-config-row:last-child { margin-bottom: 0; }

      /* Single field — label + input stacked. */
      .wsc-config-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .wsc-config-field > label {
        font-size: 11px;
        font-weight: 600;
        color: var(--ies-gray-500);
        line-height: 1.3;
        cursor: default;
      }

      /* Inputs + selects — match the hub-input aesthetic without forcing
         the wsc-config-field markup to add the .hub-input class to every
         element. (240+ inputs in renderConfigPanel — class-by-class
         migration would be a massive diff.) */
      .wsc-config-field > input,
      .wsc-config-field > select {
        font-family: 'Montserrat', sans-serif;
        font-size: 13px;
        font-weight: 600;
        color: var(--ies-navy);
        background: #fff;
        border: 1px solid var(--ies-gray-200);
        border-radius: 6px;
        padding: 7px 10px;
        height: 34px;
        width: 100%;
        box-sizing: border-box;
        transition: border-color 0.12s ease, box-shadow 0.12s ease;
      }
      .wsc-config-field > input:focus,
      .wsc-config-field > select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.10);
      }
      .wsc-config-field > input::placeholder {
        color: var(--ies-gray-400);
        font-weight: 500;
      }
      /* Number inputs — tabular numerals for clean alignment. */
      .wsc-config-field > input[type="number"] {
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      /* Range inputs (storage allocation sliders). */
      .wsc-config-field > input[type="range"] {
        height: auto;
        padding: 0;
        border: none;
        background: transparent;
      }

      /* P0-2: 3D RenderedFacts HUD — fixed top-right overlay on the 3D canvas. */
      .wsc-3d-hud {
        position: absolute;
        top: 12px;
        right: 12px;
        max-width: 280px;
        padding: 12px 14px;
        background: rgba(15, 23, 42, 0.86);
        color: #f8fafc;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.45;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(4px);
        pointer-events: none;
        z-index: 10;
      }
      .wsc-3d-hud-title {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #cbd5e1;
        margin: 0 0 8px 0;
      }
      .wsc-3d-hud-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 2px 0;
      }
      .wsc-3d-hud-row strong {
        font-weight: 700;
      }
      .wsc-3d-hud-divider {
        border-top: 1px solid rgba(148, 163, 184, 0.35);
        margin: 6px 0;
      }
      .wsc-3d-hud-status {
        margin-top: 8px;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        text-align: center;
      }
      .wsc-3d-hud-status--on    { background: rgba(34, 197, 94, 0.22);  color: #bbf7d0; }
      .wsc-3d-hud-status--under { background: rgba(245, 158, 11, 0.25); color: #fde68a; }
      .wsc-3d-hud-status--over  { background: rgba(59, 130, 246, 0.25); color: #bfdbfe; }
      .wsc-3d-hud-meta {
        font-size: 10px;
        color: #94a3b8;
        margin-top: 6px;
      }
    </style>
  `;
}

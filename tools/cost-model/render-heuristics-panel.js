/**
 * IES Hub v3 — Cost Model: Heuristics Panel renderer
 *
 * Pure renderer (no DOM, no module-level state). Returns the HTML string
 * for the "Heuristics" sidebar panel that surfaces engineering design
 * guidance on the current model + summary.
 *
 * Extracted from `cost-model/ui.js` 2026-05-11 (S14) as part of the
 * port-readiness sprint. Original was a top-level function in ui.js
 * with zero module-level state references — natural candidate for
 * relocation.
 *
 * @module tools/cost-model/render-heuristics-panel
 */

/**
 * @param {object} state — the cost-model state object (`model`)
 * @param {object} summary — output of `calc.computeSummary(state)`
 * @param {object} calc — the cost-model calc namespace (for generateHeuristics)
 * @returns {string} HTML
 */
export function renderHeuristicsPanel(state, summary, calc) {
  const checks = calc.generateHeuristics(state, summary);
  if (!checks || checks.length === 0) {
    return '<div style="padding: 12px; background: var(--ies-gray-50); border-radius: 6px; font-size: 13px; color: var(--ies-gray-500);">Enter project parameters to see design guidance.</div>';
  }

  return checks.map(check => {
    const icon = check.type === 'ok' ? '✓' : check.type === 'warn' ? '⚠' : 'ℹ';
    const bg = check.type === 'ok' ? 'rgba(32,201,151,0.06)' : check.type === 'warn' ? 'rgba(255,193,7,0.06)' : 'rgba(0,71,171,0.06)';
    const borderColor = check.type === 'ok' ? 'rgba(32,201,151,0.3)' : check.type === 'warn' ? 'rgba(255,193,7,0.3)' : 'rgba(0,71,171,0.3)';
    const color = check.type === 'ok' ? '#0d9668' : check.type === 'warn' ? '#ff9800' : '#0047AB';

    return `
      <div style="padding: 12px; background: ${bg}; border-left: 3px solid ${borderColor}; border-radius: 4px; font-size: 13px;">
        <div style="display: flex; gap: 8px; margin-bottom: 4px;">
          <span style="color: ${color}; font-weight: 700; font-size: 16px;">${icon}</span>
          <div style="font-weight: 600; color: var(--ies-navy); flex: 1;">${check.title}</div>
        </div>
        <div style="font-size: 12px; color: var(--ies-gray-600); margin-left: 24px;">${check.detail}</div>
      </div>
    `;
  }).join('');
}

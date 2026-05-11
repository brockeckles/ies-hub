/**
 * IES Hub v3 — Cost Model: Labor Sensitivity Card renderer
 *
 * Pure renderer (no DOM, no module-level state). Returns the HTML string
 * for the Monte-Carlo sensitivity card on the Summary section. Driven by
 * per-line `performance_variance_pct` settings; runs 1,000 trials and
 * surfaces P10 / P50 / P90 / stddev.
 *
 * Extracted from `cost-model/ui.js` 2026-05-11 (S14) as part of the
 * port-readiness sprint. Original was a top-level function that reached
 * into 3 module-level state references; this version takes everything
 * as a single options bag.
 *
 * @module tools/cost-model/render-sensitivity-card
 */

/**
 * @param {{
 *   laborLines: any[],
 *   lastCalcHeuristics: any,
 *   marketLaborProfile: any,
 *   scenarios: { mulberry32: Function, simulateLaborVariance: Function },
 * }} opts
 * @returns {string} HTML — empty string if nothing to render
 */
export function renderSensitivityCard(opts) {
  const { laborLines, lastCalcHeuristics, marketLaborProfile, scenarios } = opts || {};
  const lines = laborLines || [];
  const withVar = lines.filter(l => Number(l.performance_variance_pct) > 0);
  if (withVar.length === 0 || !lastCalcHeuristics) return '';
  // Seed from a hash of the current labor config so the output is stable
  // until inputs change. Stakeholder-friendly.
  const seedStr = JSON.stringify(lines.map(l => [l.id, l.hourly_rate, l.annual_hours, l.performance_variance_pct, l.employment_type]));
  let seed = 1;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rng = scenarios.mulberry32(seed);
  const result = scenarios.simulateLaborVariance(lines, lastCalcHeuristics, marketLaborProfile, 1000, rng);
  if (!result || result.nTrials === 0) return '';

  const fmt = n => (n == null ? '—' : (
    Math.abs(n) >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' :
    Math.abs(n) >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' :
    '$' + n.toFixed(0)
  ));
  const band = result.p90 - result.p10;
  const bandPct = result.p50 !== 0 ? (band / result.p50 * 100) : 0;

  return `
    <div class="hub-card mb-4" style="border-left:4px solid #7c3aed;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div>
          <div style="font-size:14px;font-weight:700;">Labor Cost Sensitivity</div>
          <div style="font-size:11px;color:var(--ies-gray-500);">${result.nTrials.toLocaleString()} Monte-Carlo trials · ${withVar.length} of ${lines.length} lines have variance set</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:var(--ies-gray-500);">80% band width</div>
          <div style="font-size:14px;font-weight:700;">${fmt(band)} (${bandPct.toFixed(1)}%)</div>
        </div>
      </div>
      <div class="hub-kpi-bar" style="grid-template-columns:repeat(4, 1fr);">
        <div class="hub-kpi-item">
          <div class="hub-kpi-label" style="color:#059669;">P10 (optimistic)</div>
          <div class="hub-kpi-value">${fmt(result.p10)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label">P50 (median)</div>
          <div class="hub-kpi-value">${fmt(result.p50)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label" style="color:#dc2626;">P90 (pessimistic)</div>
          <div class="hub-kpi-value">${fmt(result.p90)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label">StdDev</div>
          <div class="hub-kpi-value">${fmt(result.stddev)}</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);">
        Each trial draws an independent Gaussian productivity shock per labor line. Positive shock = more productive → fewer hours. Set <strong>performance_variance_pct</strong> per line in the Labor section to tune.
      </div>
    </div>
  `;
}

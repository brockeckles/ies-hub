/**
 * cost-model/review-doc.js — M7: Review mode document face (2026-07-13).
 *
 * Concept C's "living proposal" demoted to a print-grade document behind
 * the D shell's Review / Client-safe mode pills (the signed-off Concept D
 * disposition). Same architecture as the WSC N6 Design Basis:
 *   buildReviewModel()  — pure assembly from the computeAll seam + model
 *   renderReviewHtml()  — popup document (window.open + document.write),
 *                         printFontCss inlined, Print/Save-as-PDF button.
 *
 * Two faces from one model:
 *   Review      — internal: P&L Y1/Y3/Y5 + %rev, rate card with rate
 *                 sources, assumptions register (the defendability chain).
 *   Client-safe — external: letterhead, engagement meta, rate card ONLY.
 *                 No costs, no margins, no assumptions, no derivation
 *                 notes (GXO-external framing: internal economics walled
 *                 off; nothing to strip because nothing internal renders).
 *
 * PURE MODULE — no cmState import, node-safe, fully testable.
 *
 * @module tools/cost-model/review-doc
 */

import { escapeHtml as esc } from '../../shared/escape.js?v=20260702-sec2';
import { printFontCss, FONT_UI, FONT_DISPLAY } from '../../shared/print-fonts.js?v=20260710-r3';

// ─── Formatting ───────────────────────────────────────────────────────────

function money(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return '$' + Math.round(v / 1e3).toLocaleString() + 'K';
  return '$' + (abs >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
}

function rate(v, uom) {
  if (!Number.isFinite(v)) return '—';
  const unit = uom === 'month' ? 'mo' : (uom || 'unit');
  return (v >= 1000 ? '$' + Math.round(v).toLocaleString() : '$' + v.toFixed(2)) + ' / ' + unit;
}

function count(v) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(Math.round(v));
}

function pctOf(part, whole) {
  return (Number.isFinite(part) && Number.isFinite(whole) && whole > 0)
    ? ((part / whole) * 100).toFixed(1) + '%' : '—';
}

// ─── Build ────────────────────────────────────────────────────────────────

/**
 * @param {Object} p
 * @param {Object} p.c — computeAll result slice:
 *   { projections, summary, calcHeur, pricingSnapshot, orders,
 *     outboundUomLabel, contractYears }
 * @param {Object} p.model — CM model (projectDetails, laborLines, facility…)
 * @param {Object} [p.extras] — { facilityRateRow, marketLaborProfile,
 *   heuristicOverrides, scenarioLabel, scenarioStatus, marketCity }
 * @returns {Object} review model (see renderReviewHtml)
 */
export function buildReviewModel({ c, model, extras = {} }) {
  const pd = model?.projectDetails || {};
  const projections = c?.projections || [];
  const years = Math.max(1, c?.contractYears || projections.length || 5);
  const pick = (y) => projections[Math.min(y, projections.length) - 1] || {};
  // Y1 / mid / final — degrade gracefully on short terms (3-yr: Y1/Y2/Y3).
  const yrIdx = years >= 5 ? [1, 3, 5] : (years >= 3 ? [1, 2, 3] : [1, 1, years]);
  const [pA, pB, pC] = yrIdx.map(pick);
  const rev1 = pA.revenue;

  const row = (label, key, opts = {}) => ({
    label,
    y: yrIdx.map(y => money(pick(y)[key])),
    pct: pctOf(pA[key], rev1),
    ...opts,
  });
  const gm = (p) => (Number.isFinite(p.revenue) && p.revenue > 0 && Number.isFinite(p.totalCost))
    ? (((p.revenue - p.totalCost) / p.revenue) * 100).toFixed(1) + '%' : '—';
  const target = Number(c?.calcHeur?.targetMarginPct);
  const gm1 = (Number.isFinite(pA.revenue) && pA.revenue > 0) ? ((pA.revenue - pA.totalCost) / pA.revenue) * 100 : NaN;

  const pl = {
    yearLabels: yrIdx.map(y => 'Y' + y),
    rows: [
      row('Revenue', 'revenue', { grp: true }),
      row('Direct + indirect labor', 'labor', { grp: true }),
      row('Facility & occupancy', 'facility', { grp: true }),
      row('Equipment & automation', 'equipment', { grp: true }),
      row('Overhead', 'overhead', { grp: true }),
      row('VAS (pass-through)', 'vas', { grp: true }),
      row('Start-up amortization', 'startup', { grp: true }),
    ],
    total: { label: 'Total operating cost', y: yrIdx.map(y => money(pick(y).totalCost)), pct: pctOf(pA.totalCost, rev1) },
    gm: {
      label: 'Gross margin', y: [gm(pA), gm(pB), gm(pC)],
      target: Number.isFinite(target)
        ? (Number.isFinite(gm1)
          ? (gm1 >= target ? `meets ${target.toFixed(1)}% target` : `target ${target.toFixed(1)}% · ${(gm1 - target).toFixed(1)} pts`)
          : `target ${target.toFixed(1)}%`)
        : '',
    },
  };

  const buckets = (c?.pricingSnapshot?.buckets || []).map(b => {
    const vol = Number(b.annualVolume) || 0;
    const val = (Number(b.rate) || 0) * vol;
    return {
      name: b.name || '(unnamed)', uom: b.uom || 'unit',
      rate: rate(Number(b.rate), b.uom),
      volume: count(vol) + (b.uom === 'month' ? ' mo' : ''),
      value: money(val),
      source: (b._rateSource === 'override' || b.overrideRate != null) ? 'override' : 'derived',
      _val: val,
    };
  });
  const rateCard = {
    buckets,
    totalValue: money(buckets.reduce((s, b) => s + b._val, 0)),
    blended: (Number.isFinite(rev1) && Number(c?.orders) > 0)
      ? rate(rev1 / c.orders, (c.outboundUomLabel || 'unit')) : null,
  };

  // Assumptions register — the defendability chain.
  const ov = extras.heuristicOverrides || {};
  const lines = model?.laborLines || [];
  const most = lines.filter(l => l.most_template_id).length;
  const wageSrc = extras.marketLaborProfile
    ? { source: `ref_labor_rates · ${extras.marketCity || 'market'} · pinned`, status: 'SOURCED' }
    : { source: 'model inputs (no market profile loaded)', status: 'ASSUMPTION' };
  const fr = extras.facilityRateRow;
  const heur = (key, label, unit) => {
    const overridden = ov[key] != null && ov[key] !== '';
    const v = Number(c?.calcHeur?.[label]);
    return { overridden, v, unit };
  };
  const vol = heur('annual_volume_growth_pct', 'volGrowthPct', '%/yr');
  const lab = heur('labor_escalation_pct', 'laborEscPct', '%/yr');
  const cost = heur('cost_escalation_pct', 'costEscPct', '%/yr');
  const assumptions = [
    { label: 'Wage basis', value: '—', ...wageSrc },
    // m7c walk find — real column is lease_rate_psf_yr (the sqft name only
    // ever existed in a test fixture); a 0/absent rate must NOT print as
    // "$0.00 · SOURCED" — degrade honestly.
    (fr && Number(fr.lease_rate_psf_yr) > 0)
      ? { label: 'Lease rate', value: '$' + Number(fr.lease_rate_psf_yr).toFixed(2) + '/SF·yr',
          source: `ref_facility_rates · ${extras.marketCity || 'market'}`, status: 'SOURCED' }
      : { label: 'Lease rate', value: '—', source: fr ? 'market row has no lease rate' : 'no market rate row', status: 'ASSUMPTION' },
    { label: 'Labor standards', value: `${most} of ${lines.length} direct lines`,
      source: most ? 'MOST engineered standards' : 'manual estimates',
      status: lines.length === 0 ? 'ASSUMPTION' : (most === lines.length ? 'ENGINEERED' : (most > 0 ? 'PARTIAL' : 'NEEDS STANDARD')) },
    { label: 'Volume growth', value: (Number.isFinite(vol.v) ? vol.v.toFixed(1) : '—') + '%/yr',
      source: vol.overridden ? 'analyst override' : 'heuristics catalog', status: vol.overridden ? 'ASSUMPTION' : 'SOURCED' },
    { label: 'Labor escalation', value: (Number.isFinite(lab.v) ? lab.v.toFixed(1) : '—') + '%/yr',
      source: lab.overridden ? 'analyst override' : 'heuristics catalog', status: lab.overridden ? 'ASSUMPTION' : 'SOURCED' },
    { label: 'Cost escalation', value: (Number.isFinite(cost.v) ? cost.v.toFixed(1) : '—') + '%/yr',
      source: cost.overridden ? 'analyst override' : 'heuristics catalog', status: cost.overridden ? 'ASSUMPTION' : 'SOURCED' },
    { label: 'Target margin', value: Number.isFinite(target) ? target.toFixed(1) + '%' : '—',
      source: 'Financial → margin components', status: 'DECISION' },
  ];

  const status = String(extras.scenarioStatus || 'draft').toUpperCase();
  return {
    title: 'Cost Model & Pricing Basis',
    dealLine: [pd.name, pd.clientName].filter(Boolean).join(' — ') || 'Untitled model',
    classification: 'COMMERCIAL-IN-CONFIDENCE · ' + (extras.scenarioLabel ? esc0(extras.scenarioLabel) + ' · ' : '') + status,
    clientName: pd.clientName || 'Client',
    meta: [
      ['Term', years + ' years'],
      ['Facility', model?.facility?.totalSqft ? count(Number(model.facility.totalSqft)) + ' SF' : '—'],
      // m7b — marketCity only: pd.market is a UUID and must never print.
      ['Market', extras.marketCity || '—'],
      ['Volume Y1', (Number(c?.orders) > 0 ? count(c.orders) + ' ' + (c.outboundUomLabel || 'unit') + 's' : '—')],
    ],
    generatedAt: new Date().toLocaleString(),
    pl, rateCard, assumptions,
  };
}

/** Local pre-escape for values embedded into other strings pre-render. */
function esc0(s) { return String(s); }

// ─── Render ───────────────────────────────────────────────────────────────

/**
 * @param {Object} m — buildReviewModel result
 * @param {{clientSafe?: boolean}} [opts]
 * @returns {string} full popup document HTML
 */
export function renderReviewHtml(m, opts = {}) {
  const clientSafe = !!opts.clientSafe;

  const stmt = (head, rows) => `<table class="stmt"><thead><tr>${head.map(h =>
    `<th${h.num ? ' class="num"' : ''}>${esc(h.t)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

  const plHtml = clientSafe ? '' : `
    <h2><span class="no">1</span> Operating P&amp;L — ${esc(m.pl.yearLabels.join(' / '))}</h2>
    ${stmt(
      [{ t: 'Line' }, ...m.pl.yearLabels.map(y => ({ t: y, num: true })), { t: '% rev (Y1)', num: true }],
      m.pl.rows.map(r => `<tr class="grp"><td>${esc(r.label)}</td>${r.y.map(v => `<td class="num">${esc(v)}</td>`).join('')}<td class="num">${esc(r.pct)}</td></tr>`).join('')
      + `<tr class="total"><td>${esc(m.pl.total.label)}</td>${m.pl.total.y.map(v => `<td class="num">${esc(v)}</td>`).join('')}<td class="num">${esc(m.pl.total.pct)}</td></tr>`
      + `<tr class="gm"><td>${esc(m.pl.gm.label)}</td>${m.pl.gm.y.map(v => `<td class="num">${esc(v)}</td>`).join('')}<td class="num tgt">${esc(m.pl.gm.target)}</td></tr>`
    )}`;

  const rcNo = clientSafe ? '1' : '2';
  const rcHead = [{ t: 'Service bucket' }, { t: 'UOM' }, { t: 'Rate', num: true }, { t: 'Est. annual volume', num: true }, { t: 'Annual value', num: true }];
  if (!clientSafe) rcHead.push({ t: 'Rate source' });
  const rcRows = m.rateCard.buckets.map(b =>
    `<tr><td>${esc(b.name)}</td><td>${esc(b.uom)}</td><td class="num">${esc(b.rate)}</td><td class="num">${esc(b.volume)}</td><td class="num">${esc(b.value)}</td>${clientSafe ? '' : `<td class="${b.source === 'override' ? 'warn' : 'cite'}">${esc(b.source)}</td>`}</tr>`).join('')
    + `<tr class="total"><td>Total contracted value (Y1)</td><td></td><td class="num">${m.rateCard.blended ? esc('blended ' + m.rateCard.blended) : ''}</td><td></td><td class="num">${esc(m.rateCard.totalValue)}</td>${clientSafe ? '' : '<td></td>'}</tr>`;
  const rcNote = clientSafe
    ? 'Rates apply per the governing agreement. Volumes shown are Year-1 planning estimates.'
    : 'Rates derive from assigned cost + target margin by bucket. Approval freezes this card with its rate & heuristic snapshots.';
  const rcHtml = `
    <h2><span class="no">${rcNo}</span> Rate card</h2>
    ${stmt(rcHead, rcRows)}
    <p class="note">${esc(rcNote)}</p>`;

  const asmHtml = clientSafe ? '' : `
    <h2><span class="no">3</span> Assumptions register</h2>
    ${stmt(
      [{ t: 'Assumption' }, { t: 'Value' }, { t: 'Source' }, { t: 'Status' }],
      m.assumptions.map(a => `<tr><td>${esc(a.label)}</td><td class="num">${esc(a.value)}</td><td class="cite">${esc(a.source)}</td><td class="st st-${esc(String(a.status).toLowerCase().replace(/[^a-z]/g, ''))}">${esc(a.status)}</td></tr>`).join('')
    )}`;

  const cls = clientSafe ? 'PREPARED FOR ' + String(m.clientName).toUpperCase() : m.classification;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(m.title)} — ${esc(m.dealLine)}</title>
<style>
  ${printFontCss()}
  body { font: 12.5px/1.5 ${FONT_UI}; color: #1c1917; margin: 40px 52px; max-width: 860px; }
  .letterhead { display: flex; justify-content: space-between; border-bottom: 3px solid #ff3a00; padding-bottom: 8px; margin-bottom: 18px; }
  .letterhead .co { font-weight: 700; letter-spacing: .06em; font-size: 11px; }
  .letterhead .co i { color: #ff3a00; font-style: normal; }
  .letterhead .cls { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; color: #78716c; }
  h1 { font-family: ${FONT_DISPLAY}; font-size: 25px; margin: 0 0 2px; letter-spacing: -.01em; }
  .sub { color: #57534e; font-size: 13px; margin-bottom: 10px; }
  .meta-row { display: flex; gap: 18px; font-size: 11px; color: #57534e; border-top: 1px solid #e7e5e4; border-bottom: 1px solid #e7e5e4; padding: 7px 0; margin-bottom: 20px; flex-wrap: wrap; }
  .meta-row b { color: #1c1917; }
  h2 { font-family: ${FONT_DISPLAY}; font-size: 15.5px; margin: 26px 0 8px; display: flex; align-items: center; gap: 8px; }
  h2 .no { width: 19px; height: 19px; border-radius: 50%; background: #1c1917; color: #fff; font-family: ${FONT_UI}; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
  table.stmt { width: 100%; border-collapse: collapse; font-size: 12px; }
  .stmt th { text-align: left; font-size: 9.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #a8a29e; padding: 5px 8px; border-bottom: 1.5px solid #1c1917; }
  .stmt th.num { text-align: right; }
  .stmt td { padding: 6px 8px; border-bottom: 1px solid #f0efee; font-variant-numeric: tabular-nums; }
  .stmt td.num { text-align: right; }
  .stmt tr.total td { font-weight: 700; border-top: 1.5px solid #1c1917; border-bottom: none; }
  .stmt tr.gm td { font-weight: 700; color: #15803d; }
  .stmt td.tgt { font-size: 10px; color: #b45309; font-weight: 600; }
  .stmt td.cite { font-size: 10.5px; color: #1d4ed8; text-align: right; }
  .stmt td.warn { font-size: 10.5px; color: #b45309; text-align: right; font-weight: 700; }
  .stmt td.st { font-weight: 700; font-size: 10px; letter-spacing: .04em; }
  .st-sourced, .st-engineered { color: #15803d; } .st-partial { color: #b45309; }
  .st-assumption, .st-needsstandard { color: #b45309; } .st-decision { color: #1d4ed8; }
  p.note { font-size: 10.5px; color: #78716c; margin: 6px 0 0; }
  .foot { margin-top: 30px; border-top: 1px solid #e7e5e4; padding-top: 8px; font-size: 9.5px; color: #a8a29e; display: flex; justify-content: space-between; }
  .print-btn { position: fixed; top: 14px; right: 14px; background: #ff3a00; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font: 600 12px ${FONT_UI}; cursor: pointer; }
  @media print { .print-btn { display: none; } body { margin: 0; } }
</style></head><body>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <div class="letterhead"><span class="co">GXO <i>·</i> IES SOLUTIONS DESIGN</span><span class="cls">${esc(cls)}</span></div>
  <h1>${esc(m.title)}</h1>
  <div class="sub">${esc(m.dealLine)}</div>
  <div class="meta-row">${m.meta.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div>
  ${plHtml}
  ${rcHtml}
  ${asmHtml}
  <div class="foot"><span>Generated ${esc(m.generatedAt)} · IES Intelligence Hub</span><span>${esc(cls)}</span></div>
</body></html>`;
}

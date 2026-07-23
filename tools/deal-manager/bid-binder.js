/**
 * tools/deal-manager/bid-binder.js — S3-P2-b: Bid Binder (2026-07-23).
 *
 * Print-HTML→PDF "bid binder" generated from a deal's bid-of-record
 * snapshot payload (buildBidSnapshotPayload in ./calc.js, schema_version 1).
 * Two faces from one payload:
 *
 *   customer — client-safe presentation: deal/client identity, per-site
 *              footprint, exec summary, value prop. NO internal economics
 *              (costs, margins, grade/score) and NO manifest checklist.
 *              Estimated figures are marked (engine-first honesty).
 *   elt      — full internal economics for ELT approval: Σ★ Y1
 *              revenue/cost/margin (estimate + heuristic flags), grade +
 *              score, bid coverage, manifest checklist, manual checks.
 *
 * When payload.manifest.pct < 100 the binder is a DRAFT — a fixed diagonal
 * watermark band (screen AND print) plus a "missing items" page listing
 * incomplete required manifest items, in BOTH variants: a draft binder is
 * an internal review copy by definition.
 *
 * Pattern: cost-model/review-doc.js — pure model builder + renderer that
 * returns a complete self-contained <!doctype html> string. The popup
 * document never loads css/hub.css, so styles are inline RAW HEX only
 * (no var(--…) tokens). Deterministic: generatedAt is caller-supplied
 * or omitted — never clock-read here.
 *
 * PURE MODULE — no DOM, no I/O, node-safe, fully testable.
 *
 * @module tools/deal-manager/bid-binder
 */

import { escapeHtml as esc } from '../../shared/escape.js?v=20260702-sec2';
import { printFontCss, FONT_UI, FONT_DISPLAY } from '../../shared/print-fonts.js?v=20260710-r3';

// ─── Formatting (local — mirror review-doc.js conventions; locale pinned) ──

function money(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return '$' + Math.round(v / 1e3).toLocaleString('en-US') + 'K';
  return '$' + (abs >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
}

function pct(v) {
  return Number.isFinite(v) ? v.toFixed(1) + '%' : '—';
}

function sqftText(v) {
  return (Number.isFinite(v) && v > 0) ? Math.round(v).toLocaleString('en-US') + ' SF' : '—';
}

function titleCase(s) {
  const t = String(s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—';
}

/** Manual-check labels (deal_bid_meta.manual_checks keys → prose). */
const MANUAL_CHECK_LABELS = {
  'commercial-review': 'Commercial review signed off',
  'ops-review': 'Ops review signed off',
  'client-deck': 'Client deck prepared',
};

// ─── Build ────────────────────────────────────────────────────────────────

/**
 * Assemble the binder model from a bid-snapshot payload. Pure and
 * deterministic — no clock reads; generatedAt is caller-supplied or null
 * (null → the generated-at line is omitted from the rendered footer).
 *
 * @param {{
 *   payload: object,             // buildBidSnapshotPayload(...).payload (schema_version 1)
 *   variant?: 'customer'|'elt',
 *   generatedAt?: string|null,   // preformatted display string, or null to omit
 * }} p
 * @returns {object} BinderModel — see the return literal below
 */
export function buildBinderModel({ payload, variant = 'customer', generatedAt = null } = {}) {
  const pl = (payload && typeof payload === 'object') ? payload : {};
  const isElt = variant === 'elt';
  const deal = pl.deal || {};
  const manifest = pl.manifest || {};
  const totals = pl.totals || {};
  const siteList = Array.isArray(pl.sites) ? pl.sites : [];
  const items = Array.isArray(manifest.items) ? manifest.items : [];

  const dealName = (typeof deal.name === 'string' && deal.name.trim()) ? deal.name.trim() : 'Untitled deal';
  const clientName = (typeof deal.client === 'string' && deal.client.trim()) ? deal.client.trim() : 'Client';
  const manifestPct = Number.isFinite(Number(manifest.pct)) ? Number(manifest.pct) : 0;
  const draft = manifestPct < 100;

  // ── Per-site rows — economics only assembled on the ELT face, so the
  //    customer model physically cannot leak them into a render.
  const sites = siteList.map((s, i) => {
    const estimated = s?.revenue_source === 'estimate';
    const row = {
      name: (typeof s?.name === 'string' && s.name.trim()) ? s.name.trim() : `Site ${i + 1}`,
      statusText: titleCase(s?.status || 'proposed'),
      sqft: Number.isFinite(Number(s?.sqft)) ? Number(s.sqft) : null,
      sqftText: sqftText(Number(s?.sqft)),
      estimated,
    };
    if (isElt) {
      row.scenarioText = [s?.star_model_name, s?.star_scenario_label].filter(Boolean).join(' · ') || '—';
      row.revenueText = money(Number(s?.y1_revenue));
      row.costText = money(Number(s?.y1_cost));
      row.marginText = pct(Number(s?.y1_margin_pct));
      row.sourceText = s?.revenue_source === 'cm-engine' ? 'CM engine' : (estimated ? 'estimate' : '—');
    }
    return row;
  });
  const totalSqft = sites.reduce((sum, r) => sum + (Number.isFinite(r.sqft) ? r.sqft : 0), 0);
  const anyEstimate = sites.some(r => r.estimated) || !!totals.rollup_is_estimate || !!totals.any_heuristic_star;

  // ── ELT-only internal economics ──
  const coverage = totals.bid_coverage || {};
  const coverageText = `${Number(coverage.starred) || 0} of ${Number(coverage.active) || 0} active sites ★`;
  const eltTotals = isElt ? {
    revenueText: money(Number(totals.y1_revenue)),
    costText: money(Number(totals.y1_cost)),
    marginText: pct(Number(totals.y1_margin_pct)),
    fromStars: !!totals.rollup_from_stars,
    isEstimate: !!totals.rollup_is_estimate,
    anyHeuristicStar: !!totals.any_heuristic_star,
    coverageText,
    grade: (typeof totals.grade === 'string' && totals.grade) ? totals.grade : '—',
    scoreText: Number.isFinite(Number(totals.score)) && totals.score != null
      ? Number(totals.score).toFixed(0) + ' / 100' : '—',
  } : null;

  // ── Manifest checklist (ELT) + missing required items (both when draft) ──
  const checklist = isElt ? items.map(it => ({
    label: it?.label || it?.key || '(item)',
    group: it?.group || '—',
    status: it?.status || 'missing',
    required: !!it?.required,
    detail: it?.detail || '',
  })) : null;

  const missingItems = draft
    ? items.filter(it => it?.required && it?.status !== 'done').map(it => ({
        label: it?.label || it?.key || '(item)',
        group: it?.group || '—',
        status: it?.status || 'missing',
        detail: it?.detail || '',
      }))
    : [];

  const checks = (pl.manual_checks && typeof pl.manual_checks === 'object') ? pl.manual_checks : {};
  const manualChecks = isElt
    ? Object.keys(MANUAL_CHECK_LABELS).concat(
        Object.keys(checks).filter(k => !(k in MANUAL_CHECK_LABELS))
      ).map(k => ({ label: MANUAL_CHECK_LABELS[k] || k, done: checks[k] === true }))
    : null;

  // ── Meta strip ──
  const meta = [
    ['Client', clientName],
    ['Sites', String(sites.length)],
    ['Total footprint', sqftText(totalSqft)],
    ['Bid due', manifest.due_date || '—'],
  ];
  if (isElt) {
    meta.push(['Manifest', `${manifestPct}% · ${Number(manifest.required_done) || 0}/${Number(manifest.required_total) || 0} required done`]);
    meta.push(['Coverage', coverageText]);
  }

  return {
    variant: isElt ? 'elt' : 'customer',
    draft,
    manifestPct,
    title: isElt ? 'Bid Binder — ELT Approval' : 'Solution Proposal',
    dealLine: `${dealName} — ${clientName}`,
    clientName,
    classification: isElt
      ? ('GXO INTERNAL — ELT APPROVAL' + (draft ? ' · DRAFT' : ''))
      : ('PREPARED FOR ' + clientName.toUpperCase() + (draft ? ' · DRAFT' : '')),
    generatedAt: (typeof generatedAt === 'string' && generatedAt) ? generatedAt : null,
    meta,
    sites,
    totalSqftText: sqftText(totalSqft),
    anyEstimate,
    totals: eltTotals,
    execSummary: (typeof pl.exec_summary === 'string' && pl.exec_summary.trim()) ? pl.exec_summary.trim() : '',
    valueProp: (typeof pl.strategy?.value_prop === 'string' && pl.strategy.value_prop.trim())
      ? pl.strategy.value_prop.trim() : null,
    checklist,
    manualChecks,
    missingItems,
  };
}

// ─── Render ───────────────────────────────────────────────────────────────

const STATUS_MARK = { done: '✓', partial: '◐', missing: '✗' };

/**
 * Render the binder as a complete, self-contained popup document. The
 * variant is read from the model — customer models carry no internal
 * economics, so the client-safe wall is structural, not conditional CSS.
 *
 * @param {object} m — buildBinderModel result
 * @returns {string} full '<!doctype html>' popup document
 */
export function renderBinderHtml(m) {
  const isElt = m.variant === 'elt';
  let sectionNo = 0;
  const h2 = (label) => `<h2><span class="no">${++sectionNo}</span> ${esc(label)}</h2>`;

  // ── Sites table (columns differ by face) ──
  const estMark = (r) => r.estimated ? ' <span class="est">est.</span>' : '';
  const siteRows = m.sites.length
    ? m.sites.map(r => isElt
        ? `<tr><td>${esc(r.name)}</td><td>${esc(r.statusText)}</td><td>${esc(r.scenarioText)}</td><td class="num">${esc(r.sqftText)}</td><td class="num">${esc(r.revenueText)}${estMark(r)}</td><td class="num">${esc(r.costText)}</td><td class="num">${esc(r.marginText)}</td><td class="cite">${esc(r.sourceText)}</td></tr>`
        : `<tr><td>${esc(r.name)}${estMark(r)}</td><td>${esc(r.statusText)}</td><td class="num">${esc(r.sqftText)}</td></tr>`)
      .join('')
    : `<tr><td colspan="${isElt ? 8 : 3}" class="empty">No sites on record</td></tr>`;
  const siteHead = isElt
    ? '<th>Site</th><th>Status</th><th>★ Scenario</th><th class="num">Sq Ft</th><th class="num">Y1 Revenue</th><th class="num">Y1 Cost</th><th class="num">Y1 Margin</th><th>Source</th>'
    : '<th>Site</th><th>Status</th><th class="num">Space</th>';
  const siteTotal = isElt
    ? `<tr class="total"><td>Total</td><td></td><td></td><td class="num">${esc(m.totalSqftText)}</td><td class="num">${esc(m.totals.revenueText)}</td><td class="num">${esc(m.totals.costText)}</td><td class="num">${esc(m.totals.marginText)}</td><td></td></tr>`
    : `<tr class="total"><td>Total</td><td></td><td class="num">${esc(m.totalSqftText)}</td></tr>`;
  const estNote = m.anyEstimate
    ? `<p class="note">Figures marked <span class="est">est.</span> are planning estimates pending engineered pricing.</p>`
    : '';

  // ── ELT: Σ★ economics ──
  const econHtml = isElt ? `
    ${h2('Deal economics (Σ★, Year 1)')}
    <div class="kpis">
      <div class="kpi"><div class="k">Y1 Revenue</div><div class="v">${esc(m.totals.revenueText)}</div></div>
      <div class="kpi"><div class="k">Y1 Cost</div><div class="v">${esc(m.totals.costText)}</div></div>
      <div class="kpi"><div class="k">Y1 Margin</div><div class="v">${esc(m.totals.marginText)}</div></div>
      <div class="kpi"><div class="k">Grade</div><div class="v">${esc(m.totals.grade)}</div></div>
      <div class="kpi"><div class="k">Score</div><div class="v">${esc(m.totals.scoreText)}</div></div>
    </div>
    <p class="note">${esc(m.totals.fromStars ? 'Rolled up from ★ scenarios · ' + m.totals.coverageText : 'Deal-level figures (no ★ rollup) · ' + m.totals.coverageText)}${
      m.totals.isEstimate || m.totals.anyHeuristicStar
        ? esc(' · includes heuristic estimates — not fully engine-priced') : ''}</p>` : '';

  // ── Narrative ──
  const execHtml = `
    ${h2('Executive summary')}
    ${m.execSummary ? `<p class="prose">${esc(m.execSummary)}</p>` : `<p class="note">No executive summary drafted.</p>`}`;
  const vpHtml = m.valueProp ? `
    ${h2('Why GXO — value proposition')}
    <p class="prose">${esc(m.valueProp)}</p>` : '';

  // ── ELT: manifest checklist + manual checks ──
  const checklistHtml = isElt ? `
    ${h2('Bid manifest checklist')}
    <table class="stmt"><thead><tr><th>Item</th><th>Group</th><th>Status</th><th>Detail</th><th>Req</th></tr></thead><tbody>
    ${m.checklist.map(it => `<tr><td>${esc(it.label)}</td><td>${esc(it.group)}</td><td class="st st-${esc(it.status)}">${esc(STATUS_MARK[it.status] || '?')} ${esc(it.status)}</td><td class="cite">${esc(it.detail)}</td><td>${it.required ? 'required' : 'optional'}</td></tr>`).join('')}
    </tbody></table>` : '';
  const checksHtml = isElt ? `
    ${h2('Manual checks')}
    <table class="stmt"><tbody>
    ${m.manualChecks.map(c => `<tr><td class="st ${c.done ? 'st-done' : 'st-missing'}">${c.done ? '✓' : '✗'}</td><td>${esc(c.label)}</td></tr>`).join('')}
    </tbody></table>` : '';

  // ── Draft: missing-items page (both faces — a draft is internal by definition) ──
  const missingHtml = m.draft ? `
    <div class="missing-page">
      <h2 class="warn-head">DRAFT — missing items (${esc(String(m.manifestPct))}% complete)</h2>
      <p class="note">This binder was generated before the bid manifest reached 100%. The following required items are incomplete. Do not distribute externally.</p>
      <table class="stmt"><thead><tr><th>Item</th><th>Group</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      ${m.missingItems.length
        ? m.missingItems.map(it => `<tr><td>${esc(it.label)}</td><td>${esc(it.group)}</td><td class="st st-${esc(it.status)}">${esc(STATUS_MARK[it.status] || '?')} ${esc(it.status)}</td><td class="cite">${esc(it.detail)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="empty">Required items complete — optional items outstanding</td></tr>'}
      </tbody></table>
    </div>` : '';

  const wmHtml = m.draft ? '<div class="wm" aria-hidden="true">DRAFT</div>' : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(m.title)} — ${esc(m.dealLine)}</title>
<style>
  ${printFontCss()}
  @page { size: letter portrait; margin: 0.5in; }
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
  .stmt td.cite { font-size: 10.5px; color: #57534e; }
  .stmt td.empty { color: #a8a29e; font-style: italic; }
  .stmt td.st { font-weight: 700; font-size: 10px; letter-spacing: .04em; white-space: nowrap; }
  .st-done { color: #15803d; } .st-partial { color: #b45309; } .st-missing { color: #b91c1c; }
  .est { font-size: 9.5px; font-weight: 700; color: #b45309; letter-spacing: .04em; }
  .kpis { display: flex; gap: 12px; flex-wrap: wrap; margin: 4px 0 6px; }
  .kpi { border: 1px solid #e7e5e4; border-radius: 8px; padding: 8px 14px; min-width: 108px; }
  .kpi .k { font-size: 9.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #a8a29e; }
  .kpi .v { font-family: ${FONT_DISPLAY}; font-size: 19px; font-weight: 700; }
  p.prose { font-size: 12.5px; white-space: pre-wrap; margin: 6px 0 0; }
  p.note { font-size: 10.5px; color: #78716c; margin: 6px 0 0; }
  .missing-page { page-break-before: always; margin-top: 34px; border: 2px solid #b91c1c; border-radius: 10px; padding: 14px 18px; }
  .missing-page .warn-head { color: #b91c1c; margin-top: 0; }
  .foot { margin-top: 30px; border-top: 1px solid #e7e5e4; padding-top: 8px; font-size: 9.5px; color: #a8a29e; display: flex; justify-content: space-between; }
  .print-btn { position: fixed; top: 14px; right: 14px; background: #ff3a00; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font: 600 12px ${FONT_UI}; cursor: pointer; }
  .wm { position: fixed; top: 42%; left: -12%; right: -12%; transform: rotate(-22deg); text-align: center; font: 900 110px/1 ${FONT_DISPLAY}; letter-spacing: .22em; color: rgba(185, 28, 28, .13); border-top: 4px solid rgba(185, 28, 28, .13); border-bottom: 4px solid rgba(185, 28, 28, .13); padding: 18px 0; pointer-events: none; z-index: 999; }
  @media print {
    .print-btn { display: none; }
    body { margin: 0; }
    .wm { display: block; position: fixed; }
  }
</style></head><body>
  ${wmHtml}
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <div class="letterhead"><span class="co">GXO <i>·</i> IES SOLUTIONS DESIGN</span><span class="cls">${esc(m.classification)}</span></div>
  <h1>${esc(m.title)}</h1>
  <div class="sub">${esc(m.dealLine)}</div>
  <div class="meta-row">${m.meta.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div>
  ${econHtml}
  ${h2(isElt ? 'Sites & site economics' : 'Proposed sites & footprint')}
  <table class="stmt"><thead><tr>${siteHead}</tr></thead><tbody>${siteRows}${siteTotal}</tbody></table>
  ${estNote}
  ${execHtml}
  ${vpHtml}
  ${checklistHtml}
  ${checksHtml}
  ${missingHtml}
  <div class="foot"><span>${m.generatedAt ? 'Generated ' + esc(m.generatedAt) + ' · ' : ''}IES Intelligence Hub · Bid of record</span><span>${esc(m.classification)}</span></div>
</body></html>`;
}

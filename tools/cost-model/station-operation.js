/**
 * cost-model/station-operation.js — M5-Operation: flow-as-face (2026-07-13).
 *
 * The Operation station's face under the Concept-D shell: the operational
 * flow IS the labor model. Area cards (direct labor lines binned by the
 * OFP registry classifier + indirect forced to 'support') → a labor-lines
 * table for the selected area (MOST pills, inline UPH edit that rides the
 * existing data-array commit machinery → live rail) → drill-in detail via
 * the existing Labor V2 detail pane. Signed-off design authority:
 * Desktop/cm-ux-concepts/concept-d-blended.html (Operation canvas).
 *
 * PURE RENDER + AGGREGATION. No DOM, no events, no cmState import — ui.js
 * assembles entry bags (idx, areaKey, fte, cost, mostLabel, …) from calc
 * helpers and the OFP classifier, this module aggregates + renders HTML.
 * All events ride ui.js's existing container delegation (data-labor-select,
 * data-op-area, data-array commits). Classic shell renders the untouched
 * Labor V2 master-detail — this face is D-shell only.
 *
 * @module tools/cost-model/station-operation
 */

import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';

// ─── Formatting (module-local; node-safe) ─────────────────────────────────

function fmtMoney(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + Math.round(v);
}

function fmtCount(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(Math.round(v));
}

function fmtFte(v) {
  if (!Number.isFinite(v)) return '—';
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

// ─── Aggregation ──────────────────────────────────────────────────────────

/**
 * Bin labor entries into flow areas, in flow order.
 *
 * @param {Array} entries — one bag per labor line:
 *   { idx, areaKey, isIndirect?, fte, cost, hasStandard }
 *   (direct: areaKey from ofpClassifyAreaFromLine; indirect: 'support')
 * @param {Array} registry — ordered area metas from ofpRegistry():
 *   { key, label, color, displayMode, sortOrder, hidden? }
 * @returns {{ areas: Array, mostBackedPct: number|null,
 *             totalFte: number, totalCost: number, directCount: number }}
 *   areas: non-empty areas in flow order (main by sortOrder, then wide),
 *   each { key, label, color, displayMode, fte, cost, count, mostCount,
 *          manualCount, isIndirect }.
 *   mostBackedPct: cost-weighted share of DIRECT labor cost on a MOST
 *   standard (null when there is no direct cost yet).
 */
export function aggregateAreas(entries, registry) {
  const byKey = new Map();
  for (const a of registry || []) {
    byKey.set(a.key, {
      key: a.key, label: a.label, color: a.color || '#64748B',
      displayMode: a.displayMode || 'main', sortOrder: a.sortOrder || 0,
      fte: 0, cost: 0, count: 0, mostCount: 0, manualCount: 0, isIndirect: false,
    });
  }
  let directCost = 0, mostCost = 0, totalFte = 0, totalCost = 0, directCount = 0;
  for (const e of entries || []) {
    const slot = byKey.get(e.areaKey) || byKey.get('unclassified');
    if (!slot) continue;
    slot.fte += e.fte || 0;
    slot.cost += e.cost || 0;
    slot.count += 1;
    totalFte += e.fte || 0;
    totalCost += e.cost || 0;
    if (e.isIndirect) {
      slot.isIndirect = true;
    } else {
      directCount += 1;
      directCost += e.cost || 0;
      if (e.hasStandard) { slot.mostCount += 1; mostCost += e.cost || 0; }
      else slot.manualCount += 1;
    }
  }
  const areas = [...byKey.values()]
    .filter(a => a.count > 0)
    .sort((a, b) => {
      const am = a.displayMode === 'main' ? 0 : 1;
      const bm = b.displayMode === 'main' ? 0 : 1;
      return am !== bm ? am - bm : (a.sortOrder - b.sortOrder);
    });
  return {
    areas,
    mostBackedPct: directCost > 0 ? (mostCost / directCost) * 100 : null,
    totalFte, totalCost, directCount,
  };
}

// ─── Renderers ────────────────────────────────────────────────────────────

/**
 * The Operational Flow strip: one card per non-empty area, arrows between
 * main-flow areas, MOST-backed pill in the card header. Cards carry
 * data-op-area for ui.js's selection delegation.
 */
export function renderFlowStrip(agg, selectedKey) {
  const { areas, mostBackedPct } = agg;
  if (!areas.length) {
    return '<div class="hub-card cmop-card"><div class="cmop-hd"><h3>Operational Flow</h3></div>'
      + '<div class="cmop-empty">No labor lines yet — add one below, or pull volumes in first. '
      + 'Lines bin into flow areas automatically by activity name.</div></div>';
  }
  const cards = areas.map((a, i) => {
    const sel = a.key === selectedKey;
    const prevMain = i > 0 && areas[i - 1].displayMode === 'main';
    const conn = (a.displayMode === 'main' && prevMain)
      ? '<div class="cmop-conn" aria-hidden="true">→</div>' : '';
    const dot = a.isIndirect ? ''
      : '<span class="cmop-std ' + (a.manualCount === 0 ? 'cmop-std--g' : 'cmop-std--w') + '"'
        + ' title="' + (a.manualCount === 0
          ? 'All ' + a.mostCount + ' line(s) on a MOST standard'
          : a.manualCount + ' of ' + a.count + ' line(s) manual estimate') + '"></span>';
    return conn
      + '<button type="button" class="cmop-area' + (sel ? ' cmop-area--sel' : '') + '"'
      + ' data-op-area="' + escapeAttr(a.key) + '" style="--cmop-accent:' + escapeAttr(a.color) + '"'
      + ' title="' + escapeAttr(a.label + ' — ' + a.count + ' line(s). Click to open; the inspector follows.') + '">'
      + '<span class="cmop-an">' + escapeHtml(a.label) + '</span>'
      + '<span class="cmop-fte">' + fmtFte(a.fte) + ' <small>' + (a.isIndirect ? 'HC' : 'FTE') + '</small></span>'
      + '<span class="cmop-cost">' + fmtMoney(a.cost) + '/yr</span>'
      + dot + '</button>';
  }).join('');
  const pill = mostBackedPct == null ? ''
    : '<span class="cmop-pill cmop-pill--most" title="Share of direct labor cost driven by a MOST engineered standard (cost-weighted)">'
      + 'MOST-backed ' + mostBackedPct.toFixed(0) + '%</span>';
  return '<div class="hub-card cmop-card">'
    + '<div class="cmop-hd"><h3>Operational Flow</h3>'
    + '<span class="cmop-hint">click an area — the inspector follows</span>'
    + '<span class="cmop-hdright">' + pill + '</span></div>'
    + '<div class="cmop-flow">' + cards + '</div></div>';
}

/**
 * Labor-lines table for the selected area (direct areas only — indirect
 * keeps its dense editable table). Rows carry data-labor-select so the
 * existing selection delegation works; the UPH cell is a live input on
 * the existing data-array commit machinery (edit → model → recompute →
 * rail). headerActions: HTML injected into the card header (ui.js passes
 * the existing + Add / PF&D buttons).
 */
export function renderLinesTable(entries, selectedIdx, opts = {}) {
  const areaLabel = opts.areaLabel || 'Area';
  const rows = (entries || []).map(e => {
    const sel = e.idx === selectedIdx;
    const std = e.mostLabel
      ? '<span class="cmop-pill cmop-pill--most">' + escapeHtml(e.mostLabel) + '</span>'
      : '<span class="cmop-pill cmop-pill--manual" title="No MOST standard — UPH is a manual estimate">Manual est.</span>';
    return '<tr class="' + (sel ? 'cmop-row--sel' : '') + '" data-labor-select="' + escapeAttr(String(e.idx)) + '" title="Click to drill in">'
      + '<td><b>' + escapeHtml(e.name || '(unnamed activity)') + '</b></td>'
      + '<td>' + std + '</td>'
      + '<td class="hub-num"><input class="hub-input hub-num cmop-uph" type="number" step="1" min="0"'
      + ' value="' + escapeAttr(String(e.uph || 0)) + '"'
      + ' data-array="laborLines" data-idx="' + escapeAttr(String(e.idx)) + '" data-field="base_uph" data-type="number"'
      + ' title="Base UPH — edit and watch the rail" /></td>'
      + '<td class="hub-num">' + fmtCount(e.volume) + '</td>'
      + '<td class="hub-num">' + fmtFte(e.fte) + '</td>'
      + '<td class="hub-num">' + fmtMoney(e.cost) + '</td></tr>';
  }).join('');
  const totFte = (entries || []).reduce((s, e) => s + (e.fte || 0), 0);
  const totCost = (entries || []).reduce((s, e) => s + (e.cost || 0), 0);
  const body = rows || '<tr><td colspan="6" class="cmop-empty">No lines in this area yet. '
    + 'Click <b>+ Line</b> to add one — it lands here when its activity name matches this area.</td></tr>';
  return '<div class="hub-card cmop-card">'
    + '<div class="cmop-hd"><h3>' + escapeHtml(areaLabel) + ' — labor lines</h3>'
    + '<span class="cmop-hint">edit UPH · watch the rail</span>'
    + '<span class="cmop-hdright">' + (opts.headerActions || '') + '</span></div>'
    + '<table class="cmop-lines"><thead><tr>'
    + '<th>Line</th><th>Standard</th><th class="hub-num">UPH</th>'
    + '<th class="hub-num">Volume</th><th class="hub-num">FTE</th><th class="hub-num">$/yr</th>'
    + '</tr></thead><tbody>' + body + '</tbody>'
    + (rows ? '<tfoot><tr><td colspan="4">Total — ' + escapeHtml(areaLabel) + '</td>'
      + '<td class="hub-num">' + fmtFte(totFte) + '</td>'
      + '<td class="hub-num">' + fmtMoney(totCost) + '</td></tr></tfoot>' : '')
    + '</table></div>';
}

/** Scoped styles for the Operation face (.cmop-*). */
export function operationStyles() {
  return '<style>' +
  '.cmop-card{margin-bottom:14px;}' +
  '.cmop-hd{display:flex;align-items:center;gap:8px;padding:11px 15px;border-bottom:1px solid var(--ies-gray-100,#f5f5f4);}' +
  '.cmop-hd h3{font-size:12.5px;font-weight:600;margin:0;}' +
  '.cmop-hint{color:var(--ies-gray-400,#a8a29e);font-size:11px;}' +
  '.cmop-hdright{margin-left:auto;display:flex;gap:6px;align-items:center;}' +
  '.cmop-flow{display:flex;align-items:stretch;overflow-x:auto;padding:13px 15px;gap:0;}' +
  '.cmop-area{min-width:118px;border:1.5px solid var(--ies-gray-200,#e7e5e4);border-radius:10px;padding:8px 11px;background:var(--ies-gray-50,#fafaf9);position:relative;cursor:pointer;text-align:left;flex:none;border-top:3px solid var(--cmop-accent,#64748B);}' +
  '.cmop-area:hover{border-color:var(--ies-orange,#ff3a00);background:var(--c-brand-soft,#fff1ec);}' +
  '.cmop-area--sel{border-color:var(--ies-orange,#ff3a00);background:var(--c-brand-soft,#fff1ec);box-shadow:0 0 0 3px rgba(255,58,0,.1);}' +
  '.cmop-an{display:block;font-size:11px;font-weight:700;color:var(--ies-gray-800,#292524);}' +
  '.cmop-fte{display:block;font-family:var(--font-display,Georgia,serif);font-size:16px;font-weight:700;margin:1px 0;color:var(--ies-gray-900,#1c1917);}' +
  '.cmop-fte small{font-family:inherit;font-size:9px;font-weight:600;color:var(--ies-gray-400,#a8a29e);}' +
  '.cmop-cost{display:block;font-size:10px;color:var(--ies-gray-600,#57534e);font-variant-numeric:tabular-nums;}' +
  '.cmop-std{position:absolute;bottom:8px;right:8px;width:6px;height:6px;border-radius:50%;}' +
  '.cmop-std--g{background:var(--c-success-ink,#15803d);}' +
  '.cmop-std--w{background:var(--c-warn-ink,#b45309);}' +
  '.cmop-conn{display:grid;place-items:center;color:var(--ies-gray-300,#d6d3d1);padding:0 4px;font-size:13px;flex:none;}' +
  '.cmop-pill{font-size:10px;font-weight:600;border-radius:999px;padding:2px 8px;white-space:nowrap;}' +
  '.cmop-pill--most{background:var(--c-info-soft,#eff6ff);color:var(--c-info-ink,#1d4ed8);}' +
  '.cmop-pill--manual{background:var(--c-warn-soft,#fffbeb);color:var(--c-warn-ink,#b45309);}' +
  '.cmop-lines{width:100%;border-collapse:collapse;font-size:12.5px;}' +
  '.cmop-lines th{text-align:left;font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ies-gray-400,#a8a29e);padding:6px 12px;border-bottom:1px solid var(--ies-gray-200,#e7e5e4);}' +
  '.cmop-lines th.hub-num{text-align:right;}' +
  '.cmop-lines td{padding:7.5px 12px;border-bottom:1px solid var(--ies-gray-100,#f5f5f4);font-variant-numeric:tabular-nums;}' +
  '.cmop-lines td.hub-num{text-align:right;}' +
  '.cmop-lines tbody tr{cursor:pointer;}' +
  '.cmop-lines tbody tr:hover td{background:var(--ies-gray-50,#fafaf9);}' +
  '.cmop-lines tr.cmop-row--sel td{background:var(--c-brand-soft,#fff1ec);}' +
  '.cmop-lines tfoot td{font-weight:700;border-bottom:none;border-top:1px solid var(--ies-gray-200,#e7e5e4);}' +
  '.cmop-uph{width:64px;text-align:right;font-weight:600;}' +
  '.cmop-empty{padding:18px 15px;color:var(--ies-gray-400,#a8a29e);font-size:12px;}' +
  '.cmop-drill{margin-bottom:14px;grid-template-columns:1fr;}' + /* lone detail pane: kill the 300px master column; keeping .hub-master-detail preserves the :has() wide-layout opt-out */
  '.cmop-drill .hub-master-detail__detail{width:100%;max-width:none;}' +
  '</style>';
}

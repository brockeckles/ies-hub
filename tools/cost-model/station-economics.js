/**
 * cost-model/station-economics.js — M5-Economics: cost-stack strip (2026-07-13).
 *
 * The Economics station's orienting face under the Concept-D shell. The
 * station's four cost-block editors (Facility / Financial / Overhead /
 * Start-Up) are solid forms but land the user with zero orientation; this
 * strip heads all four with the same card grammar as the Operation face:
 * one card per cost block (Y1 $ + shape sub-line) plus the financial frame
 * (margin target, growth, escalation, term).
 *
 * ZERO NEW EVENT WIRING by design: every card carries data-tc-section (the
 * shared tool-chrome delegation navigates) and — for blocks with a rail
 * cell — data-cm-cell/data-cm-year (the CM-PROV-1 delegation opens the
 * rail inspector; ui.js's guard admits cells inside [data-eco-strip]).
 * Both delegations live on rootEl, so one click navigates AND inspects.
 *
 * PURE RENDER. ui.js assembles the values bag from the computeAll seam;
 * this module formats it. Classic shell never renders the strip.
 *
 * @module tools/cost-model/station-economics
 */

import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';

function fmtMoney(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + Math.round(v);
}

function fmtSqft(v) {
  if (!Number.isFinite(v) || v <= 0) return null;
  return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M SF' : Math.round(v / 1e3) + 'K SF';
}

/**
 * @param {Object} bag — assembled by ui.js from the memoized seam:
 *   { active: string (current section key),
 *     facility:  { cost, sqft },
 *     overhead:  { cost, lines },
 *     startup:   { amort, items, total },
 *     financial: { marginPct, volGrowthPct, costEscPct, years } }
 * @returns {string} strip HTML (call ecoStyles() alongside once per render)
 */
export function renderEcoStrip(bag) {
  const card = (nav, cell, label, value, sub) => {
    const on = bag.active === nav;
    return '<button type="button" class="cmeco-card' + (on ? ' cmeco-card--on' : '') + '"'
      + ' data-tc-section="' + escapeAttr(nav) + '"'
      + (cell ? ' data-cm-cell="' + escapeAttr(cell) + '" data-cm-year="1"' : '')
      + ' title="' + escapeAttr(label + (cell ? ' — click to edit; the inspector follows.' : ' — click to edit.')) + '">'
      + '<span class="cmeco-lb">' + escapeHtml(label) + '</span>'
      + '<span class="cmeco-v">' + escapeHtml(value) + '</span>'
      + (sub ? '<span class="cmeco-s">' + escapeHtml(sub) + '</span>' : '')
      + '</button>';
  };
  const f = bag.facility || {}, o = bag.overhead || {}, s = bag.startup || {}, fin = bag.financial || {};
  const sqft = fmtSqft(f.sqft);
  const finBits = [];
  if (Number.isFinite(fin.volGrowthPct)) finBits.push('vol +' + fin.volGrowthPct.toFixed(1) + '%/yr');
  if (Number.isFinite(fin.costEscPct)) finBits.push('esc ' + fin.costEscPct.toFixed(1) + '%/yr');
  if (Number.isFinite(fin.years)) finBits.push(fin.years + ' yr');
  return '<div class="cmeco-strip" data-eco-strip>'
    + '<div class="cmeco-hd"><span class="cmeco-k">ECONOMICS — COST STACK &amp; FRAME</span>'
    + '<span class="cmeco-hint">click a block to edit — the inspector follows</span>'
    + '<button type="button" class="cmeco-link" data-tc-section="summary">Multi-year P&amp;L →</button></div>'
    + '<div class="cmeco-cards">'
    + card('facility', 'facility', 'Facility & Occupancy',
        fmtMoney(f.cost) + '/yr', sqft || 'no footprint yet')
    + card('overhead', 'overhead', 'Overhead',
        fmtMoney(o.cost) + '/yr', (o.lines || 0) + ' line' + (o.lines === 1 ? '' : 's'))
    + card('startup', 'startup', 'Start-up',
        fmtMoney(s.amort) + '/yr amort', (s.items || 0) + ' item' + (s.items === 1 ? '' : 's')
          + (Number.isFinite(s.total) && s.total > 0 ? ' · ' + fmtMoney(s.total) + ' total' : ''))
    + card('financial', null, 'Financial frame',
        (Number.isFinite(fin.marginPct) ? fin.marginPct.toFixed(1) + '% target margin' : '— target margin'),
        finBits.join(' · '))
    + '</div></div>';
}

/** Scoped styles (.cmeco-*). */
export function ecoStyles() {
  return '<style>' +
  '.cmeco-strip{background:#fff;border:1px solid var(--ies-gray-200,#e7e5e4);border-radius:12px;margin-bottom:14px;}' +
  '.cmeco-hd{display:flex;align-items:center;gap:8px;padding:9px 15px;border-bottom:1px solid var(--ies-gray-100,#f5f5f4);}' +
  '.cmeco-k{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--ies-gray-400,#a8a29e);}' +
  '.cmeco-hint{color:var(--ies-gray-400,#a8a29e);font-size:11px;}' +
  '.cmeco-link{margin-left:auto;background:none;border:none;padding:0;font-size:11px;font-weight:600;color:var(--c-info-ink,#1d4ed8);cursor:pointer;}' +
  '.cmeco-link:hover{text-decoration:underline;}' +
  '.cmeco-cards{display:flex;gap:8px;overflow-x:auto;padding:11px 15px;}' +
  '.cmeco-card{flex:1;min-width:150px;border:1.5px solid var(--ies-gray-200,#e7e5e4);border-radius:10px;padding:8px 11px;background:var(--ies-gray-50,#fafaf9);cursor:pointer;text-align:left;}' +
  '.cmeco-card:hover{border-color:var(--ies-orange,#ff3a00);background:var(--c-brand-soft,#fff1ec);}' +
  '.cmeco-card--on{border-color:var(--ies-orange,#ff3a00);background:var(--c-brand-soft,#fff1ec);box-shadow:0 0 0 3px rgba(255,58,0,.1);}' +
  '.cmeco-lb{display:block;font-size:11px;font-weight:700;color:var(--ies-gray-800,#292524);}' +
  '.cmeco-v{display:block;font-family:var(--font-display,Georgia,serif);font-size:15px;font-weight:700;margin:1px 0;color:var(--ies-gray-900,#1c1917);font-variant-numeric:tabular-nums;}' +
  '.cmeco-s{display:block;font-size:10px;color:var(--ies-gray-600,#57534e);font-variant-numeric:tabular-nums;}' +
  '</style>';
}

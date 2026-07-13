/**
 * cost-model/station-price.js — M5-Price: rate-card strip (2026-07-13).
 *
 * The Price station's orienting face under the Concept-D shell, completing
 * the M5 causal walk (Volume → Operation → Economics → Price). One card
 * per pricing bucket — effective rate, Y1 revenue, derived/override source
 * — plus the revenue/margin frame. Heads all three Price sections
 * (pricingBuckets / pricing / scenarios).
 *
 * Same zero-new-wiring contract as the Economics strip: every card carries
 * data-tc-section (tool-chrome navigates to the Pricing Schedule) and
 * data-cm-cell="pb:<id>" (CM-PROV-1 opens bucket-level provenance in the
 * rail — new in M5-Price; buckets are the revenue atoms under
 * CM-authoritative pricing and never had cells before).
 *
 * PURE RENDER. ui.js assembles the bag from the memoized computeAll seam
 * (pricingSnapshot.buckets — enriched effective/recommended/override rates).
 *
 * @module tools/cost-model/station-price
 */

import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260702-sec2';

const MAX_BUCKET_CARDS = 6;

function fmtMoney(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return '$' + (abs >= 1e5 ? Math.round(v / 1e3) : (v / 1e3).toFixed(1)) + 'K';
  return '$' + (abs >= 100 ? Math.round(v) : v.toFixed(2));
}

function fmtRate(rate, uom) {
  if (!Number.isFinite(rate)) return '—';
  const unit = uom === 'month' ? 'mo' : (uom || 'unit');
  return fmtMoney(rate) + '/' + unit;
}

/**
 * @param {Object} bag — assembled by ui.js:
 *   { buckets: enriched pricingSnapshot buckets (rate, annualVolume,
 *              overrideRate, _rateSource, uom, name, id),
 *     revenue: Y1 revenue, gmPct, targetPct }
 */
export function renderPriceStrip(bag) {
  const buckets = Array.isArray(bag.buckets) ? bag.buckets : [];
  const shown = buckets.slice(0, MAX_BUCKET_CARDS);
  const extra = buckets.length - shown.length;

  let cards;
  if (!buckets.length) {
    cards = '<button type="button" class="cmpr-card cmpr-card--empty" data-tc-section="pricingBuckets"'
      + ' title="No pricing buckets yet — open the structure editor">'
      + '<span class="cmpr-lb">No buckets yet</span>'
      + '<span class="cmpr-s">Every cost line routes into a bucket — start with the 5-bucket template</span>'
      + '</button>';
  } else {
    cards = shown.map(b => {
      const rev = (Number(b.rate) || 0) * (Number(b.annualVolume) || 0);
      const isOverride = b._rateSource === 'override' || b.overrideRate != null;
      const src = isOverride
        ? '<span class="cmpr-pill cmpr-pill--ovr" title="Explicit rate override — recommended was '
          + escapeAttr(fmtRate(b.recommendedRate, b.uom)) + '">override</span>'
        : '<span class="cmpr-pill" title="Derived from assigned cost, grossed up to the target margin">derived</span>';
      return '<button type="button" class="cmpr-card" data-tc-section="pricing"'
        + ' data-cm-cell="pb:' + escapeAttr(String(b.id)) + '" data-cm-year="1"'
        + ' title="' + escapeAttr((b.name || 'Bucket') + ' — open the Pricing Schedule; the inspector follows.') + '">'
        + '<span class="cmpr-lb">' + escapeHtml(b.name || '(unnamed)') + src + '</span>'
        + '<span class="cmpr-v">' + escapeHtml(fmtRate(b.rate, b.uom)) + '</span>'
        + '<span class="cmpr-s">' + escapeHtml(fmtMoney(rev)) + '/yr revenue</span>'
        + '</button>';
    }).join('');
    if (extra > 0) {
      cards += '<button type="button" class="cmpr-card cmpr-card--more" data-tc-section="pricing"'
        + ' title="Open the full Pricing Schedule">+' + extra + ' more</button>';
    }
  }

  const gm = Number.isFinite(bag.gmPct) ? bag.gmPct.toFixed(1) + '%' : '—';
  const tgt = Number.isFinite(bag.targetPct)
    ? (bag.gmPct >= bag.targetPct ? 'meets ' + bag.targetPct.toFixed(1) + '% target'
       : (bag.gmPct - bag.targetPct).toFixed(1) + 'pp vs ' + bag.targetPct.toFixed(1) + '% target')
    : '';
  const frame = '<button type="button" class="cmpr-card cmpr-card--frame" data-tc-section="pricing"'
    + ' data-cm-cell="revenue" data-cm-year="1" title="Y1 revenue — click for provenance + pricing levers">'
    + '<span class="cmpr-lb">Revenue — Y1</span>'
    + '<span class="cmpr-v">' + escapeHtml(fmtMoney(bag.revenue)) + '</span>'
    + '<span class="cmpr-s">GM ' + escapeHtml(gm) + (tgt ? ' · ' + escapeHtml(tgt) : '') + '</span>'
    + '</button>';

  return '<div class="cmpr-strip" data-price-strip>'
    + '<div class="cmpr-hd"><span class="cmpr-k">PRICE — RATE CARD &amp; MARGIN</span>'
    + '<span class="cmpr-hint">click a bucket — the inspector follows</span>'
    + '<button type="button" class="cmpr-link" data-tc-section="pricingBuckets">Edit bucket structure →</button></div>'
    + '<div class="cmpr-cards">' + cards + frame + '</div></div>';
}

/** Scoped styles (.cmpr-*). */
export function priceStyles() {
  return '<style>' +
  '.cmpr-strip{background:#fff;border:1px solid var(--ies-gray-200,#e7e5e4);border-radius:12px;margin-bottom:14px;}' +
  '.cmpr-hd{display:flex;align-items:center;gap:8px;padding:9px 15px;border-bottom:1px solid var(--ies-gray-100,#f5f5f4);}' +
  '.cmpr-k{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--ies-gray-400,#a8a29e);}' +
  '.cmpr-hint{color:var(--ies-gray-400,#a8a29e);font-size:11px;}' +
  '.cmpr-link{margin-left:auto;background:none;border:none;padding:0;font-size:11px;font-weight:600;color:var(--c-info-ink,#1d4ed8);cursor:pointer;}' +
  '.cmpr-link:hover{text-decoration:underline;}' +
  '.cmpr-cards{display:flex;gap:8px;overflow-x:auto;padding:11px 15px;}' +
  '.cmpr-card{flex:1;min-width:138px;border:1.5px solid var(--ies-gray-200,#e7e5e4);border-radius:10px;padding:8px 11px;background:var(--ies-gray-50,#fafaf9);cursor:pointer;text-align:left;}' +
  '.cmpr-card:hover{border-color:var(--ies-orange,#ff3a00);background:var(--c-brand-soft,#fff1ec);}' +
  '.cmpr-card--frame{border-top:3px solid var(--ies-orange,#ff3a00);}' +
  '.cmpr-card--more{flex:0 0 auto;min-width:70px;display:grid;place-items:center;font-size:11.5px;font-weight:700;color:var(--ies-gray-600,#57534e);}' +
  '.cmpr-card--empty{flex:2;}' +
  '.cmpr-lb{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:var(--ies-gray-800,#292524);}' +
  '.cmpr-v{display:block;font-family:var(--font-display,Georgia,serif);font-size:15px;font-weight:700;margin:1px 0;color:var(--ies-gray-900,#1c1917);font-variant-numeric:tabular-nums;}' +
  '.cmpr-s{display:block;font-size:10px;color:var(--ies-gray-600,#57534e);font-variant-numeric:tabular-nums;}' +
  '.cmpr-pill{font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:8px;padding:1px 6px;background:var(--c-info-soft,#eff6ff);color:var(--c-info-ink,#1d4ed8);}' +
  '.cmpr-pill--ovr{background:var(--c-warn-soft,#fffbeb);color:var(--c-warn-ink,#b45309);}' +
  '</style>';
}

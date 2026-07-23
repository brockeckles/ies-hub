// test-p2b-binder-ui.mjs — S3-P2-b "Generate binder" UI layer (2026-07-23).
// Companion to test-p2b-binder-engine.mjs (pure buildBinderModel /
// renderBinderHtml pins — the other half of the seam).
//
// Pins (source — the run-tests parse pass covers module validity; the pure
// suite never imports UI modules):
//   1. Import: bid-binder.js pulled in with its own ?v pin (integrator's
//      pin-cascade owns everything else).
//   2. _openBinderDoc: _buildSubmitFields payload → buildBinderModel →
//      print popup (window.open + document.write + document.close), with
//      the popup-null (blocked) guard toasting a warning and aborting.
//   3. Buttons: Customer Presentation + ELT Approval, both
//      data-action="generate-binder" with data-variant, ALWAYS enabled
//      (no disabled attr), secondary style — NOT the primary submit style.
//   4. Captions: 100% vs DRAFT-watermark copy both present.
//   5. Provenance: real deals only (_isRealDealId gate is on the WRITE,
//      not the popup — demo deals still get the doc), routed through
//      api.recordBinderGenerated → createArtifact kind:'binder', fail-soft
//      .catch (binder already opened), latest snapshot id via ?? null.
//   6. Hygiene: delegated data-action branch beside submit-bid (bind-once),
//      no alert(), no inline onclick, no bid-snapshot write in the flow.
//
// Run:  node test-p2b-binder-ui.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const dmUi = read('./hub/deal-management/ui.js');
const dmApi = read('./hub/deal-management/api.js');

/** Extract a top-level function's source block by name (brace-matched). */
function fnBlock(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

// ============================================================
// 1. Import — pinned binder module
// ============================================================
{
  t('bid-binder import present + pinned',
    dmUi.includes("import * as binder from '../../tools/deal-manager/bid-binder.js?v=20260723-s5b'"));
}

// ============================================================
// 2. _openBinderDoc — popup flow
// ============================================================
{
  const h = fnBlock(dmUi, '_openBinderDoc');
  t('_openBinderDoc exists', !!h);
  t('payload assembled from the live tab data (shared builder)',
    /_buildSubmitFields\(d\)/.test(h));
  t('model built by the pure module (variant + generatedAt pass through)',
    /binder\.buildBinderModel\(\{/.test(h)
      && /payload: fields\.payload/.test(h)
      && /variant,/.test(h)
      && /generatedAt: new Date\(\)\.toISOString\(\)/.test(h));
  t('print popup: window.open blank target',
    h.includes("window.open('', '_blank')"));
  t('popup-blocked guard: null window → warning toast + abort',
    /if \(!win\) \{/.test(h) && /'warning'\);\s*return;/.test(h.replace(/\n\s*/g, ' ')));
  t('document.write of the pure renderer output',
    h.includes('win.document.write(binder.renderBinderHtml(model))'));
  t('document.close finishes the doc (print-ready)',
    h.includes('win.document.close()'));
  t('build/open failure is caught with an error toast',
    /catch \(err\)/.test(h) && /'error'\);/.test(h));
}

// ============================================================
// 3. Buttons — both variants, always enabled, secondary style
// ============================================================
{
  const section = fnBlock(dmUi, '_renderBidSubmitSection');
  const flat = section.replace(/\n\s*/g, ' ');
  t('Customer Presentation button wired (generate-binder / variant=customer)',
    /data-action="generate-binder" data-variant="customer"[^>]*>Customer Presentation<\/button>/.test(flat));
  t('ELT Approval button wired (generate-binder / variant=elt)',
    /data-action="generate-binder" data-variant="elt"[^>]*>ELT Approval<\/button>/.test(flat));
  t('binder buttons are ALWAYS enabled (no disabled attr)',
    !/data-action="generate-binder"[^>]*disabled/.test(flat));
  t('binder buttons use the secondary style, not the primary submit style',
    /hub-btn-secondary" data-action="generate-binder"/.test(flat)
      && !/hub-btn-primary" data-action="generate-binder"/.test(flat));
  t('binder row lives in the Bid of record card (renders after the gate)',
    section.indexOf('data-action="generate-binder"') > section.indexOf('data-action="submit-bid"'));
}

// ============================================================
// 4. Captions — 100% vs DRAFT copy
// ============================================================
{
  const section = fnBlock(dmUi, '_renderBidSubmitSection');
  t('caption at 100% exact',
    section.includes('Print-ready binder from the current bid package.'));
  t('caption below 100% exact (DRAFT watermark)',
    section.includes('Generates with a DRAFT watermark until the manifest reaches 100%.'));
  t('caption switches on the meter\'s own pct',
    /man\.pct >= 100\s*\?\s*'Print-ready binder/.test(section.replace(/\n\s*/g, ' ')));
}

// ============================================================
// 5. Provenance — demo gate on the WRITE only, fail-soft artifact
// ============================================================
{
  const h = fnBlock(dmUi, '_openBinderDoc');
  t('demo guard present in the flow',
    /_isRealDealId\(d\.id\)/.test(h));
  t('demo deals skip the write AFTER the doc opened (guard follows document.close)',
    h.indexOf('_isRealDealId') > h.indexOf('document.close()'));
  t('demo info toast exact',
    h.includes('Demo deal — binder opened; generation not recorded.'));
  t('write routed through api.recordBinderGenerated',
    /api\.recordBinderGenerated\(dealId, \{/.test(h));
  t('manifestPct read from the payload with ?? (not ||)',
    /fields\.payload\?\.manifest\?\.pct \?\? 0/.test(h));
  t('snapshotId: latest cached snapshot id, ?? null',
    /_bidSnapshotsByDeal\.get\(dealId\) \|\| \[\]\)\[0\]\?\.id \?\? null/.test(h));
  t('artifact write is fail-soft (.catch → console.warn, binder stays open)',
    /\.catch\(err => \{/.test(h) && /console\.warn/.test(h));
  t('success toast: variant label + conditional DRAFT suffix',
    h.includes('Binder generated — ${label}${pct < 100 ? \' (DRAFT)\' : \'\'}.')
      && /'success'\)/.test(h));
  t('surgical artifacts refresh: cache push + re-render only on artifacts tab',
    /getArtifacts\(dealId\)/.test(h)
      && /detailTab === 'artifacts'\) renderDetailContent\(\);/.test(h));
  t('binder flow never writes a bid snapshot',
    !/api\.submitBid/.test(h) && !/deal_bid_snapshots/.test(h));
}

// ============================================================
// 6. api.recordBinderGenerated — createArtifact kind:'binder'
// ============================================================
{
  // fnBlock's brace-matcher would stop at the destructured-params `{...}`,
  // so slice from the export instead (the p2a fetchWinLossCalibration move).
  const rbgStart = dmApi.indexOf('export async function recordBinderGenerated');
  const rbgEnd = dmApi.indexOf('export async function', rbgStart + 1);
  const f = rbgStart >= 0 ? dmApi.slice(rbgStart, rbgEnd > rbgStart ? rbgEnd : undefined) : '';
  t('recordBinderGenerated exists in dm api', !!f);
  t('routes through createArtifact (single audit row — no double-audit)',
    /return createArtifact\(dealId, \{/.test(f) && !/recordAudit/.test(f));
  t("artifact kind is 'binder'", /kind: 'binder'/.test(f));
  t('name template: variant label + DRAFT suffix below 100%',
    f.includes("`Bid binder — ${variant === 'elt' ? 'ELT Approval' : 'Customer Presentation'}${pct < 100 ? ' (DRAFT)' : ''}`"));
  t('ref encodes variant + pct + optional snapshot id',
    f.includes("`variant=${variant};pct=${pct}${snapshotId ? ';snap=' + snapshotId : ''}`"));
  t('manifestPct sanitized to a finite number (0 fallback)',
    /Number\.isFinite\(Number\(manifestPct\)\)/.test(f));
  t('recordBinderGenerated appears in the default export',
    /export default \{[\s\S]*recordBinderGenerated[\s\S]*\};/.test(dmApi));
  t('unknown-kind fallback keeps binder rows renderable in the artifacts table',
    /ARTIFACT_KINDS\[a\.kind\] \|\| \{/.test(dmUi));
}

// ============================================================
// 7. Hygiene — delegation branch, no alert(), no inline onclick
// ============================================================
{
  t('generate-binder wired via delegated data-action (bind-once branch)',
    dmUi.includes('target.closest(\'[data-action="generate-binder"]\')'));
  t('delegation branch calls _openBinderDoc with the button variant',
    /_openBinderDoc\(.*\.dataset\.variant \|\| 'customer'\);/.test(dmUi));
  t('branch sits beside the submit-bid handler (same delegated listener)',
    dmUi.indexOf('target.closest(\'[data-action="generate-binder"]\')')
      > dmUi.indexOf('target.closest(\'[data-action="submit-bid"]\')'));
  t('no inline onclick handlers in DM ui', !/onclick=/.test(dmUi));
  t('no alert() calls in DM ui', !/\balert\(/.test(dmUi));
  t('no alert() calls in DM api', !/\balert\(/.test(dmApi));
  t('caption interpolation stays escapeHtml\'d',
    /escapeHtml\(binderCaption\)/.test(dmUi));
}

console.log(`\ntest-p2b-binder-ui: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

// test-p2a-submit-ui.mjs — S3-P2-a "Mark as submitted" UI layer (2026-07-23).
// Companion to test-p2a-snapshot-engine.mjs (engine/api/migration pins).
//
// Pins (source — the run-tests parse pass covers module validity; the pure
// suite never imports UI modules):
//   1. Package tab gate: button enabled ONLY at manifest 100% (all required
//      items done), with the exact disabled-reason string.
//   2. Confirm-before-submit: _onSubmitBid awaits showConfirm (danger) BEFORE
//      api.submitBid; confirm copy names the immutable snapshot + re-submit.
//   3. Submitted state: SUBMITTED badge + "at submission · vN", compact
//      history when >1 snapshot, and the drift warning that makes
//      re-submission discoverable.
//   4. Snapshot fetch/caching: rides _hydrateDealDetail, lazy
//      _ensureBidSnapshots on Package-tab entry, header "Submitted" chip
//      patched in place (no layout shift wrapper).
//   5. Command Center: fetchWinLossCalibration gains the cheap fail-soft
//      deal_bid_snapshots read; the card's zero-outcome branch counts
//      submitted bids ("awaiting outcomes") while keeping the original
//      empty-state string and the outcomes rendering path.
//   6. Hygiene: delegated data-action wiring (no inline onclick), no
//      alert() calls, confirm-modal import copies the repo-standard pin.
//
// Run:  node test-p2a-submit-ui.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const dmUi = read('./hub/deal-management/ui.js');
const ccApi = read('./hub/command-center/api.js');
const ccUi = read('./hub/command-center/ui.js');

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
// 1. Package tab — 100% gate + disabled reason
// ============================================================
{
  const section = fnBlock(dmUi, '_renderBidSubmitSection');
  t('_renderBidSubmitSection exists', !!section);
  t('gate requires ALL required items done',
    /remaining === 0/.test(section) && /man\.requiredTotal > 0/.test(section));
  t('gate also pins pct === 100 (the meter\'s own number)',
    /man\.pct === 100/.test(section));
  t('remaining count is real (requiredTotal - requiredDone)',
    /requiredTotal.*-.*requiredDone/.test(section));
  t('disabled-reason string exact',
    section.includes('Complete the bid manifest to submit — ${remaining} required item(s) remaining.'));
  t('disabled reason is escapeHtml\'d',
    /escapeHtml\(`Complete the bid manifest to submit/.test(section));
  t('below 100% the button is disabled',
    /disabled[^>]*>Mark as submitted<\/button>/.test(section.replace(/\n\s*/g, ' ')));
  t('enabled button is the primary "Mark as submitted"',
    section.includes('data-action="submit-bid"') && section.includes('>Mark as submitted</button>'));
  t('section rendered at the bottom of the Package tab',
    /renderPackageTab[\s\S]*?_renderBidSubmitSection\(d, man\)/.test(dmUi));
}

// ============================================================
// 2. Confirm-before-submit (the friction point)
// ============================================================
{
  const h = fnBlock(dmUi, '_onSubmitBid');
  t('_onSubmitBid exists', !!h);
  t('handler re-checks the 100% gate before anything else',
    h.indexOf('requiredTotal') >= 0 && h.indexOf('requiredTotal') < h.indexOf('showConfirm'));
  t('showConfirm runs BEFORE api.submitBid',
    h.indexOf('showConfirm') >= 0 && h.indexOf('api.submitBid') >= 0
      && h.indexOf('showConfirm') < h.indexOf('api.submitBid'));
  t('confirm is awaited and cancel aborts',
    /await showConfirm/.test(h) && /if \(!ok\) return;/.test(h));
  t('confirm uses the danger variant', /danger: true/.test(h));
  t('confirm copy: leads with the question', h.includes('Mark this bid as submitted?'));
  t('confirm copy: immutable bid-of-record + Σ★/manifest interpolation',
    h.includes('This stamps an immutable bid-of-record snapshot (Σ★ ${_fmtSigmaStar(fields.y1_revenue)} · ${Number(fields.manifest_pct) || 0}% manifest) used to calibrate bid vs. outcome.'));
  t('confirm copy: re-submission is explicit',
    h.includes('You can submit again later if the bid changes — each submission is kept.'));
  t('success toast stamps the snapshot number',
    h.includes('Bid submitted — snapshot #${list.length} stamped.') && /'success'/.test(h));
  t('submit failure is caught with an error toast',
    /catch \(err\)/.test(h) && /'error'/.test(h));
  t('re-renders the detail view after submit (badge + header chip)',
    /renderDetail\(\)/.test(h));
  t('payload assembled from the live tab data (shared builder)',
    /_buildSubmitFields\(d\)/.test(h));
  const b = fnBlock(dmUi, '_buildSubmitFields');
  t('builder feeds buildBidSnapshotPayload the SAME manifest the meter uses',
    /_bidManifestFor\(d\)/.test(b) && /buildBidSnapshotPayload/.test(b));
  t('builder reuses the msa-row revenue join (engine-first pricing seam)',
    /_msaSitesByDeal\.get\(d\.id\)/.test(b) && /annualRevenue/.test(b));
  t('builder reads cached bid meta + raw strategy row',
    /_bidMetaByDeal\.get\(d\.id\)/.test(b) && /_strategyRowByDeal\.get\(d\.id\)/.test(b));
}

// ============================================================
// 3. Submitted state — badge, history, drift warning
// ============================================================
{
  const section = fnBlock(dmUi, '_renderBidSubmitSection');
  t('SUBMITTED badge uses success tokens',
    section.includes('>SUBMITTED</span>')
      && /var\(--c-success-bg\)/.test(section) && /var\(--c-success-ink\)/.test(section));
  t('latest line: date · Σ★ at submission · vN',
    section.includes('Submitted ${escapeHtml(_fmtSnapDate(latest.submitted_at))} · Σ★ ${_fmtSigmaStar(latest.y1_revenue)} at submission · v${snaps.length}'));
  t('history renders only when >1 snapshot', /snaps\.length > 1/.test(section));
  t('history rows: vN · date · manifest% · Σ★',
    section.includes('v${snaps.length - i} · ${escapeHtml(_fmtSnapDate(r.submitted_at))} · ${Number(r.manifest_pct) || 0}% manifest · Σ★ ${_fmtSigmaStar(r.y1_revenue)}'));
  t('drift warning string present (re-submission discoverability)',
    section.includes('Deal has changed since last submission'));
  t('drift warning is quiet (warn token, not a toast/alert)',
    /var\(--c-warn-deep\)/.test(section));
  const drift = fnBlock(dmUi, '_bidDriftedSince');
  t('drift compares CURRENT manifest pct vs latest snapshot',
    /manifest_pct/.test(drift));
  t('drift compares CURRENT Σ★ vs latest snapshot y1_revenue',
    /y1_revenue/.test(drift));
  t('drift uses the same builder as submit (consistent rounding)',
    /_buildSubmitFields\(d\)/.test(drift));
  t('no snapshot → no drift (fail-soft)', /if \(!latest\) return false;/.test(drift));
}

// ============================================================
// 4. Snapshot fetch / caching + header chip
// ============================================================
{
  t('snapshot caches declared (per-deal rows + loaded set)',
    /_bidSnapshotsByDeal = new Map\(\)/.test(dmUi) && /_bidSnapshotsLoaded = new Set\(\)/.test(dmUi));
  t('snapshots ride _hydrateDealDetail\'s Promise.all',
    /api\.listBidSnapshots\(dealId\),\s*\]\);/.test(dmUi.slice(dmUi.indexOf('async function _hydrateDealDetail'))));
  const ensure = fnBlock(dmUi, '_ensureBidSnapshots');
  t('_ensureBidSnapshots exists (Package-tab entry fail-soft path)', !!ensure);
  t('lazy fetch skips demo deals + already-loaded deals',
    /_bidSnapshotsLoaded\.has\(d\.id\)/.test(ensure) && /_isRealDealId\(d\.id\)/.test(ensure));
  t('Package tab entry triggers the lazy fetch',
    /case 'package':.*_ensureBidSnapshots\(\);/.test(dmUi));
  t('header chip wrapper always present (display:contents — no layout shift)',
    dmUi.includes('id="dm-submitted-chip" style="display:contents;"'));
  const chip = fnBlock(dmUi, '_submittedChipHtml');
  t('chip renders empty without snapshots', /if \(!snaps\.length\) return '';/.test(chip));
  t('chip labeled "Submitted" with success tokens',
    chip.includes('>Submitted</span>') && /var\(--c-success-bg\)/.test(chip));
  t('chip patched in place after async loads',
    /function _refreshSubmittedChip/.test(dmUi)
      && fnBlock(dmUi, '_ensureBidSnapshots').includes('_refreshSubmittedChip()'));
}

// ============================================================
// 5. Command Center — submit-side of the calibration loop
// ============================================================
{
  const f = ccApi.slice(ccApi.indexOf('export async function fetchWinLossCalibration'));
  t('cheap snapshot read: deal_id + submitted_at only',
    f.includes("db.fetchAll('deal_bid_snapshots', 'deal_id,submitted_at')"));
  t('snapshot read fails soft to []',
    /db\.fetchAll\('deal_bid_snapshots', 'deal_id,submitted_at'\)\.catch\(\(\) => \[\]\)/.test(f));
  t('bidsSubmitted counts DISTINCT deals', /new Set\(snapRows\.map\(s => s\.deal_id\)/.test(f));
  t('empty result carries the counts (zeros)',
    /bidsSubmitted: 0, snapshotCount: 0/.test(f));
  t('zero-outcome early return still surfaces the bid counts',
    /return \{ \.\.\.empty, bidsSubmitted, snapshotCount \};/.test(f));
  t('full result carries bidsSubmitted + snapshotCount',
    /bidsSubmitted, snapshotCount, topLossReasons/.test(f));

  const card = fnBlock(ccUi, 'renderWinLossCard');
  t('card: awaiting-outcomes branch string',
    card.includes('bid${bids === 1 ? \'\' : \'s\'} submitted — awaiting outcomes. Close a deal Won/Lost to complete the loop.'));
  t('card: header meta counts bids + outcomes in that branch',
    card.includes("bid${bids === 1 ? '' : 's'} submitted · ${wl.total} outcome${wl.total === 1 ? '' : 's'} recorded"));
  t('card: original zero-everything empty state kept verbatim',
    card.includes('No outcomes recorded yet — close a deal Won/Lost to start the calibration loop.'));
  t('card: outcomes rendering path untouched (win-rate KPI still renders)',
    card.includes('Win rate') && card.includes('Recent outcomes'));
  t('CC demo fallback untouched (DEMO_ACTIVITY still wired)',
    ccApi.includes('activity: DEMO_ACTIVITY'));
}

// ============================================================
// 6. Hygiene — delegation, no alert(), pinned import
// ============================================================
{
  t('button wired via delegated data-action (bind-once handler branch)',
    dmUi.includes('target.closest(\'[data-action="submit-bid"]\')'));
  t('no inline onclick handlers in DM ui', !/onclick=/.test(dmUi));
  t('no inline onclick handlers in CC ui', !/onclick=/.test(ccUi));
  t('no alert() calls in DM ui', !/\balert\(/.test(dmUi));
  t('no alert() calls in CC ui/api', !/\balert\(/.test(ccUi) && !/\balert\(/.test(ccApi));
  t('confirm-modal import copies the repo-standard pin',
    dmUi.includes("from '../../shared/confirm-modal.js?v=20260705-u1a'"));
  t('toast levels stay in the sanctioned set',
    !/showToast\([^)]*'info'\)/.test(fnBlock(dmUi, '_onSubmitBid')));
}

console.log(`\ntest-p2a-submit-ui: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

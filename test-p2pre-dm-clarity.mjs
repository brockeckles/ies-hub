// test-p2pre-dm-clarity.mjs — P2-a-prep: three Deal Management clarity fixes
// (Brock, after live use, 2026-07-23).
//
//   F1 Grade ⓘ popover on the DETAIL-header chip: api carries computeDealScore's
//      full breakdown (components/weights/thresholds) through as scoreDetail;
//      _gradeInfoHtml renders component rows + weighted total + thresholds +
//      the ★-basis caption; bind-once delegation (data-action branch + Esc).
//   F2 Sites-tab coverage banner names the actual gap sites and their fallback
//      basis instead of the engine-vocab count line ("non-dropped").
//   F3 "excluded from revenue roll-up (no ★ scenario)" footer; Total-sqft KPI
//      and Sites-tab total line flag estimate-based sq ft (est pill /
//      "(includes estimates)") without changing the totals math.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`); }
}

const uiSrc = readFileSync(new URL('./hub/deal-management/ui.js', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('./hub/deal-management/api.js', import.meta.url), 'utf8');

// ---------- F1 — grade breakdown reaches the deal object ----------
t('api: scoreDetail carries components/weights/thresholds',
  apiSrc.includes('scoreDetail = { components: sc.components, weights: sc.weights, thresholds: sc.thresholds }'));
t('api: scoreDetail rides the listRealDeals mapping',
  /score,\s*scoreNum,\s*scoreDetail,/.test(apiSrc));

// ---------- F1 — popover renders components + weights + thresholds ----------
const gi = uiSrc.indexOf('function _gradeInfoHtml');
t('ui: _gradeInfoHtml exists', gi > 0);
const giBody = gi > 0 ? uiSrc.slice(gi, uiSrc.indexOf('\n}', gi)) : '';
for (const comp of ['marginScore', 'ebitdaScore', 'paybackScore', 'npvScore']) {
  t(`popover reads component ${comp}`, giBody.includes(comp));
}
t('popover shows weight per row (score · ×NN%)', giBody.includes('×${wPct('));
t('popover labels all four components',
  ['Gross margin', 'EBITDA', 'Payback', 'NPV'].every(l => giBody.includes(`'${l}'`)));
t('popover shows weighted total + grade thresholds',
  giBody.includes('Score ${Number(d.scoreNum) || 0}') && giBody.includes('A≥') && giBody.includes('D≥'));
t('popover caption: ★-scenario basis with no-★ fallback note',
  giBody.includes("Scored from the deal's ★ scenarios")
  && giBody.includes('(no ★ yet — using all attached scenarios)')
  && giBody.includes('d.bidCoverage'));
t('popover values are Number-coerced / grade escaped',
  giBody.includes('Math.round(Number(val) || 0)') && giBody.includes('escapeHtml(String(d.score))'));

// ---------- F1 — wiring: detail header only, bind-once delegation ----------
t('detail header chip has the ⓘ affordance (scoreDetail-gated)',
  uiSrc.includes('data-action="toggle-grade-info"') && uiSrc.includes('${d.scoreDetail ? `<button data-action="toggle-grade-info"'));
t('popover markup is a hub-card, dismissible container',
  uiSrc.includes('id="dm-grade-pop"') && /id="dm-grade-pop" class="hub-card"/.test(uiSrc));
t('delegated click toggles + outside click dismisses (no per-render listeners)',
  uiSrc.includes(`target.closest('[data-action="toggle-grade-info"]')`)
  && uiSrc.includes(`!target.closest('#dm-grade-pop')`));
t('Esc closes the popover', /keydown[\s\S]{0,200}Escape[\s\S]{0,200}dm-grade-pop/.test(uiSrc));
t('pipeline-card chips untouched (no ⓘ there)',
  (uiSrc.match(/toggle-grade-info/g) || []).length <= 4); // header + click branch only

// ---------- F2 — banner names the gap sites ----------
const bi = uiSrc.indexOf('function _rollupGapBanner');
t('ui: _rollupGapBanner exists', bi > 0);
t('old engine-vocab banner is gone',
  !uiSrc.includes('Roll-up covers') && !uiSrc.includes('until every non-dropped site'));
t('Sites tab renders the builder output', uiSrc.includes('_rollupGapBanner(sites)'));

// Behavioral: slice the builder out and run it with an escapeHtml stub.
const bEnd = uiSrc.indexOf('\n}', bi);
let build = null;
try {
  build = new Function('escapeHtml', uiSrc.slice(bi, bEnd + 2) + '\nreturn _rollupGapBanner;')((x) => String(x));
} catch { /* pin below fails */ }
t('builder is extractable/pure', typeof build === 'function');
if (typeof build === 'function') {
  const dfw = { name: 'Dallas–Fort Worth', status: 'active', inBidModelId: null, sqftEstimate: 95000, modelCount: 0 };
  const s1 = { name: 'Louisville', status: 'active', inBidModelId: 'm1' };
  const s2 = { name: 'Reno', status: 'active', inBidModelId: 'm2' };
  const out = build([dfw, s1, s2]);
  t('gap banner: counts + plural verb', out.includes('2 of 3 sites have a ★ scenario.'));
  t('gap banner: names the gap site with its sq ft estimate',
    out.includes('Dallas–Fort Worth is using its') && out.includes('sq ft estimate'));
  t('gap banner: plain-language close',
    out.includes('until every active site has a starred design (or is removed from the bid)'));
  t('gap banner: singular verb when one site is starred',
    build([dfw, s1]).includes('1 of 2 sites has a ★ scenario.'));
  t('gap site with scenarios but no ★ says so',
    build([{ name: 'X', status: 'active', inBidModelId: null, sqftEstimate: 0, modelCount: 2 }, s1])
      .includes('X has no ★ scenario yet'));
  t('gap site with no scenarios says so',
    build([{ name: 'Y', status: 'active', inBidModelId: null, sqftEstimate: 0, modelCount: 0 }, s1])
      .includes('Y has no scenarios yet'));
  t('full coverage → no banner', build([s1, s2]) === '');
  t('dropped sites excluded from the gap list',
    build([{ ...dfw, status: 'dropped' }, s1, s2]) === '');
}

// ---------- F3 — sqft labels ----------
t('site-card footer: explicit exclusion reason',
  uiSrc.includes('— excluded from revenue roll-up (no ★ scenario)')
  && !uiSrc.includes("'— excluded from roll-up'"));
t('Total-sqft KPI: est pill when any contributing site uses its estimate',
  uiSrc.includes("_sqftIsEst(s)) ? _estPill(_SQFT_EST_TIP) : '')"));
t('Sites-tab total line: "(includes estimates)" suffix, same condition',
  uiSrc.includes("_sqftIsEst(s)) ? ' (includes estimates)' : ''"));
t('totals math unchanged (still sums every site sqft)',
  uiSrc.includes('sites.reduce((t, s) => t + (s.sqft || 0), 0)'));

console.log(`test-p2pre-dm-clarity: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

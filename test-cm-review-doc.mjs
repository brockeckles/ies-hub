// test-cm-review-doc.mjs — M7: Review mode document face (2026-07-13)
//
// Locks the review-doc contract:
//   1. buildReviewModel — P&L Y1/Y3/Y5 (graceful 3-yr degradation), GM vs
//      target text, rate card totals + blended, assumptions register
//      statuses (MOST coverage, override → analyst-override/ASSUMPTION,
//      sourced market rows).
//   2. renderReviewHtml — Review face has all three sections; CLIENT-SAFE
//      face contains NO internal economics AT ALL (no P&L, no margins, no
//      assumptions, no derivation note, no rate-source column) and carries
//      the PREPARED FOR banner. XSS escaping. Print affordances.
//
// Pure module. ?v= pin MUST match ui.js's import.
//
// Run: node test-cm-review-doc.mjs

const reviewDoc = await import('./tools/cost-model/review-doc.js?v=20260713-m7a');
const { buildReviewModel, renderReviewHtml } = reviewDoc;

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); process.stdout.write('F'); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

// ---- Fixture ----
function proj(y) {
  const g = Math.pow(1.03, y - 1);
  return { revenue: 11000000 * g, labor: 4650000 * g, facility: 1370000 * g,
    equipment: 1030000 * g, overhead: 732000 * g, vas: 0, startup: 44000,
    totalCost: 7860000 * g };
}
function makeC(years = 5) {
  return {
    projections: Array.from({ length: years }, (_, i) => proj(i + 1)),
    summary: { totalCost: 7860000 },
    calcHeur: { targetMarginPct: 12, volGrowthPct: 3, laborEscPct: 3.5, costEscPct: 3 },
    pricingSnapshot: { buckets: [
      { id: 'mf', name: 'Management Fee', type: 'fixed', uom: 'month', rate: 403000, annualVolume: 12, recommendedRate: 403000, overrideRate: null, _rateSource: 'recommended' },
      { id: 'st', name: 'Storage', type: 'variable', uom: 'pallet', rate: 45.22, annualVolume: 50833, recommendedRate: 40, overrideRate: 45.22, _rateSource: 'override' },
    ] },
    orders: 1400000, outboundUomLabel: 'order', contractYears: years,
  };
}
const MODEL = {
  projectDetails: { name: 'Hearthwood Columbus DC', clientName: 'Hearthwood Home Co.', market: 'mkt-cmh', contractTerm: 5 },
  facility: { totalSqft: 150000 },
  laborLines: [
    { activity_name: 'Pick', most_template_id: 7 },
    { activity_name: 'Pack', most_template_id: null },
  ],
};
const EXTRAS = {
  facilityRateRow: { market_id: 'mkt-cmh', lease_rate_sqft_yr: 6.85 },
  marketLaborProfile: { id: 1 },
  heuristicOverrides: { annual_volume_growth_pct: 4 },
  scenarioLabel: 'Baseline', scenarioStatus: 'approved', marketCity: 'Columbus, OH',
};

// ---- 1. build ----
t('P&L: Y1/Y3/Y5 columns on a 5-yr term; Y1/Y2/Y3 on a 3-yr term', () => {
  const m5 = buildReviewModel({ c: makeC(5), model: MODEL, extras: EXTRAS });
  assert(m5.pl.yearLabels.join(',') === 'Y1,Y3,Y5', `got ${m5.pl.yearLabels}`);
  const m3 = buildReviewModel({ c: makeC(3), model: MODEL, extras: EXTRAS });
  assert(m3.pl.yearLabels.join(',') === 'Y1,Y2,Y3', `3-yr degradation: got ${m3.pl.yearLabels}`);
});

t('P&L: revenue row, total, GM vs target text', () => {
  const m = buildReviewModel({ c: makeC(), model: MODEL, extras: EXTRAS });
  assert(m.pl.rows[0].label === 'Revenue' && m.pl.rows[0].y[0] === '$11.0M', 'revenue Y1');
  assert(m.pl.total.y[0] === '$7.86M', 'total Y1');
  // GM Y1 = (11.0-7.86)/11.0 = 28.5% ≥ 12% target
  assert(m.pl.gm.y[0].includes('%'), 'gm formatted');
  assert(m.pl.gm.target.includes('meets 12.0% target'), `target text: ${m.pl.gm.target}`);
});

t('rate card: per-bucket rows, override flag, total + blended', () => {
  const m = buildReviewModel({ c: makeC(), model: MODEL, extras: EXTRAS });
  const mf = m.rateCard.buckets.find(b => b.name === 'Management Fee');
  const st = m.rateCard.buckets.find(b => b.name === 'Storage');
  assert(mf.source === 'derived' && st.source === 'override', 'rate sources');
  assert(mf.rate.includes('/ mo'), 'fixed rate per month');
  assert(m.rateCard.totalValue.startsWith('$'), 'total value');
  assert(m.rateCard.blended && m.rateCard.blended.includes('/ order'), 'blended per primary uom');
});

t('assumptions register: MOST coverage, override → analyst, sourced rows', () => {
  const m = buildReviewModel({ c: makeC(), model: MODEL, extras: EXTRAS });
  const by = Object.fromEntries(m.assumptions.map(a => [a.label, a]));
  assert(by['Labor standards'].value === '1 of 2 direct lines' && by['Labor standards'].status === 'PARTIAL', 'MOST coverage');
  assert(by['Volume growth'].source === 'analyst override' && by['Volume growth'].status === 'ASSUMPTION', 'override flagged');
  assert(by['Labor escalation'].status === 'SOURCED', 'catalog value sourced');
  assert(by['Wage basis'].status === 'SOURCED', 'market labor profile → sourced');
  assert(by['Lease rate'].value === '$6.85/SF·yr' && by['Lease rate'].status === 'SOURCED', 'facility rate row');
});

t('assumptions: no profile / no lines degrade honestly', () => {
  const m = buildReviewModel({ c: makeC(), model: { ...MODEL, laborLines: [] },
    extras: { ...EXTRAS, marketLaborProfile: null, facilityRateRow: null } });
  const by = Object.fromEntries(m.assumptions.map(a => [a.label, a]));
  assert(by['Wage basis'].status === 'ASSUMPTION', 'no profile → assumption');
  assert(by['Lease rate'].status === 'ASSUMPTION', 'no rate row → assumption');
  assert(by['Labor standards'].status === 'ASSUMPTION', 'no lines → assumption');
});

// ---- 2. render ----
t('Review face: letterhead, all three sections, print affordances', () => {
  const m = buildReviewModel({ c: makeC(), model: MODEL, extras: EXTRAS });
  const html = renderReviewHtml(m, { clientSafe: false });
  assert(html.includes('IES SOLUTIONS DESIGN'), 'letterhead');
  assert(html.includes('COMMERCIAL-IN-CONFIDENCE'), 'classification');
  assert(html.includes('Operating P&amp;L') && html.includes('Rate card') && html.includes('Assumptions register'), 'three sections');
  assert(html.includes('Gross margin'), 'gm row');
  assert(html.includes('window.print()') && html.includes('@media print'), 'print affordances');
});

t('CLIENT-SAFE face: internal economics never render', () => {
  const m = buildReviewModel({ c: makeC(), model: MODEL, extras: EXTRAS });
  const html = renderReviewHtml(m, { clientSafe: true });
  assert(html.includes('PREPARED FOR HEARTHWOOD HOME CO.'), 'prepared-for banner');
  assert(html.includes('Rate card'), 'rate card present');
  for (const forbidden of ['Gross margin', 'Operating P&amp;L', 'Assumptions register',
    'target margin', 'assigned cost', 'override', 'derived', 'COMMERCIAL-IN-CONFIDENCE',
    'heuristics catalog', 'Total operating cost']) {
    assert(!html.includes(forbidden), `client-safe leaked internal economics: "${forbidden}"`);
  }
  assert(html.includes('Rates apply per the governing agreement'), 'client-facing rate note');
});

t('render escapes hostile names everywhere', () => {
  const hostileModel = { ...MODEL, projectDetails: { ...MODEL.projectDetails,
    name: '<img src=x onerror=alert(1)>', clientName: '<script>c</script>' } };
  const m = buildReviewModel({ c: makeC(), model: hostileModel, extras: EXTRAS });
  for (const cs of [false, true]) {
    const html = renderReviewHtml(m, { clientSafe: cs });
    assert(!html.includes('<img src=x') && !html.includes('<script>c'), `escaping (clientSafe=${cs})`);
  }
});

// ---- Summary ----
console.log('\n');
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(f); }
console.log(`test-cm-review-doc: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);

// test-wsc-basis-doc.mjs — N6 Design Basis document coverage (2026-07-04).
// Pins the 12-section contract, the assumptions register, reconciliation
// math, gap rollup, and HTML integrity (no undefined/NaN leakage).
import { buildDesignBasisModel, renderDesignBasisHtml } from './tools/warehouse-sizing/basis-doc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const fix = {
  facility: { name: 'Memphis DC', sizingMode: 'design', buildingWidth: 480, buildingDepth: 320, totalSqft: 153600, clearHeight: 32, aisleWidth: 9, storageType: 'mix' },
  zones: { dockConfig: { inboundDoors: 3, outboundDoors: 3 }, receiveStagingSqft: 10400, shipStagingSqft: 5200 },
  volumes: { annualOutboundUnits: 5000000, totalPallets: 9000, peakMultiplier: 1.3, daysOnHand: 30 },
  profile: {
    mode: 'sparse', skuCount: 1200,
    sources: null,
    velocityBands: { A: { skuCount: 240, skuPct: 20, linePct: 80 }, B: { skuCount: 360, skuPct: 30, linePct: 15 }, C: { skuCount: 600, skuPct: 50, linePct: 5 } },
    depthOfHolding: { avgPalletsPerSku: 7.5, p50: null, p90: null },
    tiHi: { avgCasesPerPallet: 55 },
    peak: { peakFactor: 1.35, basis: 'sparse' },
    volumes: { annualOutboundUnits: 5000000, onHandPallets: 9000 },
    dataGaps: [{ code: 'ABC_DEFAULTED', severity: 'info', message: 'ABC defaulted to Pareto.' }],
    provenance: { skuCount: 'asserted', velocityBands: 'estimated', depthOfHolding: 'derived', tiHi: 'asserted', peak: 'estimated', volumes: 'asserted' },
  },
  pinnedFactors: { pinnedAt: '2026-07-04', rows: [{ ratio_code: 'x', source: 'standard' }, { ratio_code: 'y', source: 'industry method' }, { ratio_code: 'z', source: 'industry method' }] },
  mediaPlan: {
    provenance: 'estimated', policy: { rotation: 'none' },
    bands: [{ bucket: '~7.5 avg (sparse)', skuCount: 1200, pallets: 9000, mediaLabel: 'Double-deep', family: 'double_deep', occupancyPct: 75, positions: 12000, costBand: { min: 960000, max: 1440000 }, rationale: 'r', citations: ['wsc.media.depth_to_media_map'] }],
    shelving: null,
    totals: { positions: 12000, pallets: 9000, costBand: { min: 960000, max: 1440000 }, mediaCount: 1 },
    allocation: { fullPallet: 100, cartonOnPallet: 0, cartonOnShelving: 0, rationale: 'alloc r' },
    gaps: [{ code: 'MEDIA_FROM_SPARSE', severity: 'warn', message: 'sparse media' }],
  },
  dynamicsPlan: {
    policy: { arrivalWindowHrs: 8, dwellDaysIn: 1, dwellDaysOut: 0.5 },
    flow: { inPerDay: 300, outPerDay: 300, peakFactor: 1.3, peakIn: 390, peakOut: 390, provenance: 'estimated' },
    docks: { inbound: { doors: 3 }, outbound: { doors: 3 }, totalDoors: 6, dwellCheck: { doors: 4, trucksPerPeakDay: 30 }, methodsDiverge: false, sanityNote: 'sanity', rationale: 'dock r' },
    staging: { inbound: { sqft: 10400, governedBy: 'dwell' }, outbound: { sqft: 5200, governedBy: 'dwell' }, totalSqft: 15600 },
    mhe: { fleet: [{ label: 'Reach truck', role: 'storage', aisleFt: 9, rationale: 'mhe r' }], governingAisleFt: 9, vnaAdvisory: null },
    gaps: [{ code: 'FLOW_ESTIMATED', severity: 'warn', message: 'flow est' }],
  },
  layoutPlan: {
    flueStandard: 'FM',
    gridFit: { rationale: 'grid r' },
    compliance: { checks: [{ label: 'Transverse flue', required: '≥ 3"', actual: '3"', status: 'PASS', citation: 'FM DS 8-9', note: null }], failCount: 0 },
    flow: { pattern: 'U-flow', advisory: 'u-flow adv' },
    gaps: [],
  },
  sized: { positions: { grossPositions: 11500 }, requirementsDriven: { totalSfRequired: 149468 } },
};

// ── model ──
{
  const m = buildDesignBasisModel(fix);
  t('title carries facility', m.title.includes('Memphis DC'));
  t('12 sections', m.sections.length === 12);
  const ids = m.sections.map(s => s.id);
  t('section order contract', JSON.stringify(ids) === JSON.stringify(
    ['scope', 'data', 'assumptions', 'volumes', 'profile', 'media', 'ops', 'equipment', 'dynamics', 'standards', 'reconciliation', 'gaps']));

  const reg = m.sections.find(s => s.id === 'assumptions').register;
  t('register has profile provenance rows', reg.filter(r => r.item.startsWith('Profile ·')).length === 6);
  t('register flags estimated', reg.some(r => r.basis === 'Estimated (default)'));
  t('register has flue decision', reg.some(r => r.item.includes('flue standard') && r.value === 'FM'));
  t('register has pinned catalog', reg.some(r => r.item === 'Factor catalog' && r.value.includes('3 factors pinned 2026-07-04')));
  t('register has dwell policy', reg.some(r => r.item.includes('dwell') && r.value === '1 / 0.5 days'));

  const recon = m.sections.find(s => s.id === 'reconciliation').recon;
  t('recon has 5 rows', recon.length === 5, `got ${recon.length}`);
  const pos = recon.find(r => r.item === 'Pallet positions');
  t('positions SHORT (11500 < 12000)', pos.status === 'SHORT' && pos.provided === 11500);
  t('doors OK (6 ≥ 6)', recon.find(r => r.item === 'Dock doors').status === 'OK');
  t('staging OK (15600 ≥ 15600)', recon.find(r => r.item === 'Staging sqft').status === 'OK');
  t('aisle OK (9 ≥ 9)', recon.find(r => r.item === 'Storage aisle (ft)').status === 'OK');
  t('building OK (153600 ≥ 149468)', recon.find(r => r.item === 'Building sqft').status === 'OK');

  const gaps = m.sections.find(s => s.id === 'gaps');
  t('gap rollup 3 items w/ origins', gaps.gaps.length === 3 && gaps.gaps.some(g => g.origin === 'Profile')
    && gaps.gaps.some(g => g.origin === 'Media') && gaps.gaps.some(g => g.origin === 'Dynamics'));
  t('exclusions present', gaps.exclusions.length === 3);

  const media = m.sections.find(s => s.id === 'media');
  t('media band carries rationale + citations', media.mediaBands[0].rationale === 'r' && media.mediaBands[0].citations.length === 1);
  const std = m.sections.find(s => s.id === 'standards');
  t('standards carries checks + factor sources', std.checks.length === 1 && std.factorSources.join(' ').includes('industry method × 2'));
}

// ── degenerate: bare scenario, nothing applied ──
{
  const m = buildDesignBasisModel({ facility: { name: 'Bare' }, zones: {}, volumes: {} });
  t('bare: still 12 sections', m.sections.length === 12);
  t('bare: register notes unpinned catalog', m.sections.find(s => s.id === 'assumptions').register.some(r => r.value.includes('NOT PINNED')));
  t('bare: empty recon', m.sections.find(s => s.id === 'reconciliation').recon.length === 0);
  t('bare: profile row says not built', m.sections.find(s => s.id === 'profile').rows[0][1] === 'not built');
  const html = renderDesignBasisHtml(m);
  t('bare html renders', html.includes('<h1>Design Basis — Bare</h1>'));
  t('bare html no undefined/NaN', !html.includes('undefined') && !html.includes('NaN'));
}

// ── html ──
{
  const html = renderDesignBasisHtml(buildDesignBasisModel(fix));
  t('html has print button', html.includes('Print / Save as PDF'));
  t('html has all 12 h2s', (html.match(/<h2>/g) || []).length === 12);
  t('html shows SHORT reconciliation row', html.includes('SHORT'));
  t('html cites FM DS 8-9', html.includes('FM DS 8-9'));
  t('html escapes + no undefined/NaN', !html.includes('undefined') && !html.includes('NaN'));
  t('html includes media rationale row', html.includes('↳ r'));
  t('html traceability strapline', html.includes('every value traces'));
  // R3 (2026-07-10): print surfaces carry the Editorial type system inline
  t('html inlines 6 @font-face rules (popup does not inherit hub.css)', (html.match(/@font-face/g) || []).length === 6);
  t('html body uses Inter stack', /body \{ font: 12px\/1\.45 'Inter'/.test(html));
  t('html headings use Source Serif 4', html.includes("h1 { font-family: 'Source Serif 4'"));
  t('html gap severity uses icon svg not emoji', !html.includes('⛔') && !html.includes('\u26D4'));
}

console.log(`\ntest-wsc-basis-doc: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

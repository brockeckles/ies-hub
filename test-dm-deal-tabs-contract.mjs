// test-dm-deal-tabs-contract.mjs — UX-1 D1p2 (2026-07-03)
// Contract test: the deal workspace tabs (Financials / Sensitivity / Compare
// in hub/deal-management) read specific fields off tools/deal-manager/calc.js
// results. The dc5 live walk caught f.marginPct (undefined — real field is
// grossMarginPct) blanking the Financials tab. Pin the shapes here.

import * as calc from './tools/deal-manager/calc.js';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } };

const sites = [
  { id: '1', name: 'Columbus DC', sqft: 420000, annualCost: 9_856_000, targetMarginPct: 12, startupCost: 1_200_000, pricingModel: 'cost-plus', annualVolume: 100000, costModelId: '1', inBid: true },
  { id: '2', name: 'Memphis FC', sqft: 392000, annualCost: 8_644_000, targetMarginPct: 11.8, startupCost: 900_000, pricingModel: 'cost-plus', annualVolume: 90000, costModelId: '2', inBid: false },
];

// computeSiteFinancials — fields the Financials table + Compare tab read
const f = calc.computeSiteFinancials(sites[0]);
for (const k of ['annualRevenue', 'annualCost', 'grossMarginPct', 'costPerSqft']) {
  check(`site fin has ${k}`, Number.isFinite(f[k]));
}
check('site fin margin sane', f.grossMarginPct > 0 && f.grossMarginPct < 100);
check('marginPct is NOT a field (dc5 bug)', !('marginPct' in f));

// computeDealFinancials — fields the KPI strip reads
const fin = calc.computeDealFinancials(sites, 5);
for (const k of ['totalAnnualRevenue', 'totalAnnualCost', 'grossMarginPct', 'ebitdaPct', 'npv', 'paybackMonths', 'irr', 'totalStartupCost']) {
  check(`deal fin has ${k}`, Number.isFinite(fin[k]));
}
check('deal revenue > cost at positive margin', fin.totalAnnualRevenue > fin.totalAnnualCost);

// calcDealSensitivity — fields the grid cells read
const sens = calc.calcDealSensitivity(sites, { years: 5 });
check('sens grid 5x5', sens.grid.length === 5 && sens.grid[0].length === 5);
const cell = sens.grid[2][2];
for (const k of ['ebitdaPct', 'x', 'y']) check(`sens cell has ${k}`, Number.isFinite(cell[k]));
check('sens cell has grade', typeof cell.grade === 'string' && cell.grade.length > 0);
check('sens center = baseline flex', cell.x === 0 && cell.y === 0);

// r4 walk fix (2026-07-10): margin-pts rows were a silent no-op for
// CM-priced sites (CM-authoritative revenue ignores targetMarginPct).
// Lock: (a) rows must VARY on the margin axis for CM-stamped sites,
// (b) base cell (0,0) matches the unshifted deal financials.
const cmSites = sites.map(s => ({ ...s, annualRevenue: s.annualCost * 1.13 }));
const sens2 = calc.calcDealSensitivity(cmSites, { years: 5 });
check('sens margin axis moves EBITDA for CM-priced sites', sens2.grid[0][2].ebitdaPct !== sens2.grid[4][2].ebitdaPct);
check('sens margin axis monotonic', sens2.grid[4][2].ebitdaPct > sens2.grid[0][2].ebitdaPct);
const baseFin = calc.computeDealFinancials(cmSites, 5);
check('sens base cell (0,0) unchanged by fix', Math.abs(sens2.grid[2][2].ebitdaPct - baseFin.ebitdaPct) < 1e-9);

// empty-sites guard (deal with no scenarios must not throw)
const empty = calc.computeDealFinancials([], 5);
check('empty sites → finite zeros', Number.isFinite(empty.totalAnnualRevenue));

console.log(`test-dm-deal-tabs-contract: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

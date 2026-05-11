// test-deal-manager-smoke.mjs — Engine smoke test for Multi-Site Analyzer (port-readiness)
// No network, no DOM. Run:  node test-deal-manager-smoke.mjs

import {
  EBITDA_OVERHEAD_PCT,
  DISCOUNT_RATE,
  DEFAULT_ESCALATION_PCT,
  DEFAULT_CONTRACT_YEARS,
  DEFAULT_PRICING_MARKUPS,
  DOS_STAGES,
  computeSiteFinancials,
  computeDealFinancials,
  computeNpv,
  computePaybackMonths,
  computeIrr,
  calcDealSensitivity,
  combineDeals,
} from './tools/deal-manager/calc.js';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}
function approx(label, a, e, tol = 0.5) {
  ok(`${label} (got ${a}, expected ~${e})`, Math.abs(a - e) < tol);
}

console.log('Multi-Site Analyzer engine smoke');

// --- computeSiteFinancials: cost-plus pricing ---
{
  const site = { id: 'S1', name: 'Test Site', annualCost: 1_000_000, targetMarginPct: 20, pricingModel: 'cost-plus', sqft: 100_000, annualVolume: 50000 };
  const f = computeSiteFinancials(site);
  // cost-plus with 20% target margin: rev = cost / (1 - 0.20) = 1.25M
  approx('cost-plus rev = cost/(1-margin)', f.annualRevenue, 1_250_000, 1);
  approx('grossMarginPct close to target (~20%)', f.grossMarginPct, 20, 0.01);
  approx('costPerSqft = annualCost/sqft', f.costPerSqft, 10, 0.01);
  approx('costPerVolume = annualCost/annualVolume', f.costPerVolume, 20, 0.01);
}

// --- computeSiteFinancials: per-volume rate overrides cost-plus ---
{
  const site = { id: 'S2', name: 'Site 2', annualCost: 1_000_000, perVolumeRate: 25, annualVolume: 50000 };
  const f = computeSiteFinancials(site);
  approx('perVolumeRate × volume = revenue', f.annualRevenue, 1_250_000, 1);
}

// --- computeSiteFinancials: zero-margin returns rev=cost ---
{
  const site = { id: 'S3', name: 'Site 3', annualCost: 500_000, targetMarginPct: 0, pricingModel: 'cost-plus', sqft: 50_000 };
  const f = computeSiteFinancials(site);
  approx('rev=cost when targetMarginPct=0', f.annualRevenue, 500_000, 1);
}

// --- computeDealFinancials: aggregates across multiple sites ---
{
  const sites = [
    { id: 'S1', name: 'A', annualCost: 1_000_000, targetMarginPct: 15, pricingModel: 'cost-plus', sqft: 100_000, annualVolume: 50000, startupCost: 250_000 },
    { id: 'S2', name: 'B', annualCost: 2_000_000, targetMarginPct: 18, pricingModel: 'cost-plus', sqft: 200_000, annualVolume: 100000, startupCost: 500_000 },
  ];
  const f = computeDealFinancials(sites, 5);
  ok('deal totals totalAnnualCost', f.totalAnnualCost === 3_000_000);
  ok('deal totalSqft sums', f.totalSqft === 300_000);
  ok('deal totalAnnualVolume sums', f.totalAnnualVolume === 150_000);
  ok('totalStartupCost sums', f.totalStartupCost === 750_000);
  ok('totalAnnualRevenue > totalAnnualCost when margin > 0', f.totalAnnualRevenue > f.totalAnnualCost);
  ok('ebitdaPct is finite', Number.isFinite(f.ebitdaPct));
  ok('npv is finite', Number.isFinite(f.npv));
  ok('payback months is finite', Number.isFinite(f.paybackMonths));
}

// --- computeDealFinancials: empty sites returns empty financials ---
{
  const f = computeDealFinancials([]);
  ok('empty sites → totalAnnualCost === 0', f.totalAnnualCost === 0);
  ok('empty sites → totalAnnualRevenue === 0', f.totalAnnualRevenue === 0);
}

// --- computeNpv: known closed-form check ---
{
  // Investment $1M, annual cash flow $300K, 5 years, discount 10%.
  // NPV = -1,000,000 + 300,000 × (1-1.10^-5)/0.10 ≈ -1M + 1,137,236 = ~137K
  const npv = computeNpv(1_000_000, 300_000, 5, 0.10);
  approx('NPV closed-form check', npv, 137236, 100);
  ok('NPV of $0 annual cashflow = -startup', computeNpv(500_000, 0, 5, 0.10) === -500_000);
}

// --- computePaybackMonths ---
{
  ok('payback $1M at $100K/yr = 120 months', computePaybackMonths(1_000_000, 100_000) === 120);
  ok('payback with zero cashflow = Infinity', computePaybackMonths(1_000_000, 0) === Infinity);
  ok('payback with negative cashflow = Infinity', computePaybackMonths(1_000_000, -50_000) === Infinity);
}

// --- computeIrr: positive cashflow exceeds discount rate ---
{
  const irr = computeIrr(1_000_000, 300_000, 5);
  ok('IRR is finite for positive cashflow', Number.isFinite(irr));
  ok('IRR > 0 when cashflow > 0', irr > 0);
}

// --- calcDealSensitivity ---
{
  const sites = [{ id: 'S1', name: 'A', annualCost: 1_000_000, targetMarginPct: 15, pricingModel: 'cost-plus', sqft: 100_000, annualVolume: 50000, startupCost: 200_000 }];
  const sens = calcDealSensitivity(sites, { xRange: [-5, 0, 5], yRange: [-1, 0, 1] });
  ok('sensitivity returns x/y axes + grid', sens.grid && Array.isArray(sens.grid));
  ok('grid is yRange × xRange', sens.grid.length === 3 && sens.grid[0].length === 3);
  ok('each grid cell has score + grade', sens.grid.flat().every(c => 'score' in c && 'grade' in c));
}

// --- combineDeals: roll-up of two deals ---
{
  const dealA = {
    dealName: 'A',
    sites: [{ id: 's1', name: 'Site A1', annualCost: 1_000_000, targetMarginPct: 15, pricingModel: 'cost-plus', sqft: 100_000, annualVolume: 50000 }],
  };
  const dealB = {
    dealName: 'B',
    sites: [{ id: 's2', name: 'Site B1', annualCost: 500_000, targetMarginPct: 18, pricingModel: 'cost-plus', sqft: 50_000, annualVolume: 25000 }],
  };
  const combined = combineDeals(dealA, dealB);
  ok('combined deal returns financials', combined && combined.financials);
  ok('combined totalAnnualCost = sum of inputs', combined.financials.totalAnnualCost === 1_500_000);
  ok('combined sites list', Array.isArray(combined.sites) && combined.sites.length === 2);
}

// --- combineDeals with cannibalization ---
{
  const dealA = { dealName: 'A', sites: [{ id: 's1', name: 'A1', annualCost: 1_000_000, targetMarginPct: 15, pricingModel: 'cost-plus', sqft: 100_000 }] };
  const dealB = { dealName: 'B', sites: [{ id: 's2', name: 'B1', annualCost: 1_000_000, targetMarginPct: 15, pricingModel: 'cost-plus', sqft: 100_000 }] };
  const combined = combineDeals(dealA, dealB, { cannibalizationPct: 10 });
  // Each site's cost reduced by 10% → combined = 1.0M + 0.9M + 0.9M = 1.8M total
  approx('10% cannibalization shrinks combined cost', combined.financials.totalAnnualCost, 1_800_000, 1);
}

// --- constants exposed ---
ok('DEFAULT_CONTRACT_YEARS = 5', DEFAULT_CONTRACT_YEARS === 5);
ok('DISCOUNT_RATE = 10%', DISCOUNT_RATE === 0.10);
ok('DOS_STAGES has 6 stages', DOS_STAGES.length === 6);
ok('DEFAULT_PRICING_MARKUPS keys include cost-plus & transactional',
   'cost-plus' in DEFAULT_PRICING_MARKUPS && 'transactional' in DEFAULT_PRICING_MARKUPS);

console.log(`\nDeal Manager smoke: ${passed}/${passed + failed} passed${failed ? ', failures:' : ''}`);
fails.forEach(f => console.log(`  - ${f}`));
process.exit(failed ? 1 : 0);

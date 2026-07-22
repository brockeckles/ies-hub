// test-cm-esc-schedules.mjs — Escalation Option B (Brock ruling 2026-07-22).
//
// Projections compound each model's OWN pinned houseAssumptions Y1–Y5
// schedule per category; the flat knobs are the fallback, so every pre-B
// model is byte-identical by construction. Locks:
//   1. Engine: schedule multiplier semantics (year-k rate applies moving
//      into year k+1; last rate reused past the schedule; all-equal
//      schedule == flat compounding EXACTLY; no schedule == flat path).
//   2. escalationSchedulesFromPinned row mapping (houseGuidanceSeeds
//      predicates: hourly wage / global capex / Facility / MHE).
//   3. buildProjectionParams gating: opt-in flag + per-category
//      resting-source rule (transient/override/snapshot → flat).
//   4. ui.js wiring: new models seed the flag; House card toggle action.

import { readFileSync } from 'node:fs';
import { buildYearlyProjections, pinHouseAssumptions } from './tools/cost-model/calc.js';
import { escalationSchedulesFromPinned, buildProjectionParams } from './tools/cost-model/calc.scenarios.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

const BASE = {
  years: 6, baseLaborCost: 1_000_000, baseFacilityCost: 500_000,
  baseEquipmentCost: 200_000, baseOverheadCost: 100_000, baseVasCost: 0,
  startupAmort: 0, startupCapital: 0, baseOrders: 100_000, marginPct: 0.12,
  laborEscPct: 0.03, costEscPct: 0.03, facilityEscPct: 0.03, equipmentEscPct: 0.03,
  uphYoyPct: 0, useMonthlyEngine: false,
};

// ── 1. Engine semantics ──
{
  const flat = buildYearlyProjections({ ...BASE });
  const equal = buildYearlyProjections({ ...BASE,
    escSchedules: { labor: [3, 3, 3, 3, 3], cost: [3, 3, 3, 3, 3], facility: [3, 3, 3, 3, 3], equipment: [3, 3, 3, 3, 3] } });
  const pf = flat.projections || flat;
  const pe = equal.projections || equal;
  t('all-equal schedule == flat compounding (every year, every category)',
    pf.every((y, i) => near(y.labor, pe[i].labor) && near(y.facility, pe[i].facility)
      && near(y.equipment, pe[i].equipment) && near(y.overhead, pe[i].overhead)),
    'diverged');

  const varying = buildYearlyProjections({ ...BASE,
    escSchedules: { labor: [5, 4, 3, 2, 1], cost: null, facility: null, equipment: null } });
  const pv = varying.projections || varying;
  // Year 3 labor multiplier = (1.05)(1.04); flat categories unchanged.
  t('varying labor schedule compounds year-by-year (Y3 = 1.05×1.04)',
    near(pv[2].labor, 1_000_000 * 1.05 * 1.04), `got ${pv[2].labor}`);
  t('null-schedule categories stay on the flat knob',
    near(pv[2].facility, 500_000 * Math.pow(1.03, 2)), `got ${pv[2].facility}`);
  // Year 6 (beyond the 5-rate schedule) reuses the Yr-5 rate.
  t('contract years past the schedule reuse the last rate',
    near(pv[5].labor, 1_000_000 * 1.05 * 1.04 * 1.03 * 1.02 * 1.01), `got ${pv[5].labor}`);
  t('Year 1 unchanged by construction (multiplier 1.0)',
    near(pv[0].labor, pf[0].labor));
  const none = buildYearlyProjections({ ...BASE, escSchedules: null });
  const pn = none.projections || none;
  t('escSchedules:null == omitted (zero-diff for pre-B models)',
    pf.every((y, i) => near(y.labor, pn[i].labor) && near(y.overhead, pn[i].overhead)));
}

// ── 2. Schedule builder row mapping ──
const ROWS = [
  { scope: 'labor_category', scope_key: 'hourly', metric: 'wage', year_1_pct: 4.5, year_2_pct: 4.0, year_3_pct: 3.5, year_4_pct: 3.0, year_5_pct: 3.0 },
  { scope: 'global', scope_key: null, metric: 'capex', year_1_pct: 3.0, year_2_pct: 2.5, year_3_pct: 2.5, year_4_pct: 2.0, year_5_pct: 2.0 },
  { scope: 'equipment_category', scope_key: 'Facility', metric: 'capex', year_1_pct: 3.5, year_2_pct: 3.5, year_3_pct: 3.0, year_4_pct: 3.0, year_5_pct: 2.5 },
  { scope: 'equipment_category', scope_key: 'MHE', metric: 'capex', year_1_pct: 3.5, year_2_pct: 3.0, year_3_pct: 3.0, year_4_pct: 2.5, year_5_pct: 2.5 },
];
{
  const pinned = pinHouseAssumptions(ROWS, '2026-07-22');
  const s = escalationSchedulesFromPinned(pinned);
  t('labor ← hourly wage row', JSON.stringify(s.labor) === JSON.stringify([4.5, 4, 3.5, 3, 3]));
  t('cost ← global capex row', JSON.stringify(s.cost) === JSON.stringify([3, 2.5, 2.5, 2, 2]));
  t('facility ← Facility capex row', s.facility[0] === 3.5 && s.facility[4] === 2.5);
  t('equipment ← MHE capex row', s.equipment[1] === 3.0 && s.equipment[4] === 2.5);
  t('no pinned rows → null', escalationSchedulesFromPinned({ rows: [] }) === null);
  const noMhe = escalationSchedulesFromPinned(pinHouseAssumptions(ROWS.slice(0, 3)));
  t('MHE missing → equipment falls back to global capex', noMhe.equipment[0] === 3.0);
}

// ── 3. buildProjectionParams gating ──
function params(financial, used) {
  return buildProjectionParams({
    model: { financial, houseAssumptions: pinHouseAssumptions(ROWS), laborLines: [] },
    summary: { laborCost: 1, facilityCost: 1, equipmentCost: 1, overheadCost: 1, vasCost: 0, startupAmort: 0, startupCapital: 0 },
    calcHeur: { targetMarginPct: 12, volGrowthPct: 0, laborEscPct: 3, costEscPct: 3, facilityEscPct: 3, equipmentEscPct: 3, uphYoyPct: 0, taxRatePct: 25, preGoLiveMonths: 0, dsoDays: 30, dpoDays: 30, laborPayableDays: 14, used: used || {} },
    contractYears: 5, orders: 1, pricingBuckets: [], refData: null,
  });
}
{
  t('flag off → no schedules (pre-B models untouched)',
    params({ useEscalationSchedules: false }).escSchedules == null);
  t('flag absent → no schedules',
    params({}).escSchedules == null);
  const on = params({ useEscalationSchedules: true });
  t('flag on + resting knobs → all four schedules ride',
    !!on.escSchedules && Array.isArray(on.escSchedules.labor) && Array.isArray(on.escSchedules.equipment));
  const wi = params({ useEscalationSchedules: true }, { labor_escalation_pct: 'transient' });
  t('What-If transient on labor → labor rides FLAT, others keep schedules',
    wi.escSchedules.labor === null && Array.isArray(wi.escSchedules.cost));
  const snap = params({ useEscalationSchedules: true }, { cost_escalation_pct: 'snapshot', labor_escalation_pct: 'override' });
  t('snapshot + override sources also win flat for their categories',
    snap.escSchedules.cost === null && snap.escSchedules.labor === null && Array.isArray(snap.escSchedules.facility));
}

// ── 4. ui.js wiring pins ──
{
  const ui = readFileSync(new URL('./tools/cost-model/ui.js', import.meta.url), 'utf8');
  t('new models seed useEscalationSchedules = true (inside seedDefaults)',
    /model\.financial\.useEscalationSchedules = true;/.test(ui));
  t('House card renders the schedule-state chip both ways',
    ui.includes('Y1–Y5 SCHEDULE ACTIVE') && ui.includes('FLAT Y1 ONLY'));
  t('toggle action wired (adopt + revert in one control)',
    ui.includes("case 'toggle-esc-schedule'") && ui.includes("data-action=\"toggle-esc-schedule\""));
  t('toggle refreshes KPIs (projections reprice immediately)',
    /case 'toggle-esc-schedule': \{[\s\S]{0,700}refreshHeaderKpis\(\);/.test(ui));
}

console.log(`\ntest-cm-esc-schedules: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

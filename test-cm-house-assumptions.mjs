// test-cm-house-assumptions.mjs — pricing_assumptions pinning (2026-06-12).
// Brock: corporate guidance is pinned per project at creation/first save;
// later guidance changes never alter an existing project (3% stays 3%
// even after corporate moves to 5%) unless explicitly adopted.

import * as calc from './tools/cost-model/calc.js';

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const ok = (typeof expected === 'number')
    ? Math.abs(actual - expected) < 1e-9 : actual === expected;
  if (ok) { passed++; } else { failed++; console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
}

const live2026 = [
  { scope: 'global', scope_key: null, metric: 'capex', year_1_pct: 3.0, year_2_pct: 3.0, year_3_pct: 3.0, year_4_pct: 3.0, year_5_pct: 3.0, effective_date: '2026-04-16', notes: 'baseline' },
  { scope: 'labor_category', scope_key: 'hourly', metric: 'wage', year_1_pct: 4.5, year_2_pct: 4.0, year_3_pct: 3.5, year_4_pct: 3.5, year_5_pct: 3.5, effective_date: '2026-04-16', notes: 'hourly' },
  { scope: 'equipment_category', scope_key: 'MHE', metric: 'capex', year_1_pct: 3.5, year_2_pct: 3.5, year_3_pct: 3.0, year_4_pct: 3.0, year_5_pct: 3.0, effective_date: '2026-04-16', notes: 'mhe' },
];

// 1. Pin shape
const pinned = calc.pinHouseAssumptions(live2026, '2026-06-12');
eq(pinned.pinnedAt, '2026-06-12', 'pin: pinnedAt');
eq(pinned.rows.length, 3, 'pin: row count');
eq(pinned.rows[1].year_1_pct, 4.5, 'pin: values copied');

// 2. Seeds: hourly wage Y1 → laborEscalation, global capex Y1 → annualEscalation
const seeds = calc.houseGuidanceSeeds(pinned);
eq(seeds.laborEscalation, 4.5, 'seed: laborEscalation from hourly wage Y1');
eq(seeds.annualEscalation, 3.0, 'seed: annualEscalation from global capex Y1');
eq(Object.keys(calc.houseGuidanceSeeds({ rows: [] })).length, 0, 'seed: empty pin → no seeds');

// 2b. W3 (2026-07-13, Brock ruling): per-category seeds — Facility row →
// facilityEscalation, MHE row → equipmentEscalation (global capex fallback).
eq(seeds.equipmentEscalation, 3.5, 'seed W3: equipmentEscalation from MHE capex Y1');
eq('facilityEscalation' in seeds, false, 'seed W3: no Facility row → no facility seed');
const pinnedFac = calc.pinHouseAssumptions([...live2026,
  { scope: 'equipment_category', scope_key: 'Facility', metric: 'capex', year_1_pct: 3.5, year_2_pct: 3.5, year_3_pct: 3.0, year_4_pct: 3.0, year_5_pct: 3.0, effective_date: '2026-04-16', notes: 'facility' },
], '2026-06-12');
eq(calc.houseGuidanceSeeds(pinnedFac).facilityEscalation, 3.5, 'seed W3: facilityEscalation from Facility construction Y1');
const pinnedNoMhe = calc.pinHouseAssumptions(live2026.filter(r => r.scope_key !== 'MHE'), '2026-06-12');
eq(calc.houseGuidanceSeeds(pinnedNoMhe).equipmentEscalation, 3.0, 'seed W3: no MHE row → equipment falls back to global capex');

// 3. THE core requirement: guidance moves 3%→5%, pinned project keeps 3%
const live2027 = live2026.map(r => r.scope === 'global'
  ? { ...r, year_1_pct: 5.0, year_2_pct: 5.0, effective_date: '2027-01-01' } : r);
eq(pinned.rows[0].year_1_pct, 3.0, 'immutability: pinned global capex still 3.0 after guidance → 5.0');
const drift = calc.houseAssumptionsDrift(pinned, live2027);
eq(drift.anyDrift, true, 'drift: detected when guidance changes');
const globalRow = drift.rows.find(r => r.scope === 'global');
eq(globalRow.changed, true, 'drift: global row flagged');
eq(globalRow.year_1_pct, 3.0, 'drift: row shows PINNED value');
eq(globalRow.current.year_1_pct, 5.0, 'drift: row carries current guidance for comparison');
eq(drift.rows.find(r => r.scope_key === 'hourly').changed, false, 'drift: unchanged rows not flagged');

// 4. No drift when guidance unchanged
eq(calc.houseAssumptionsDrift(pinned, live2026).anyDrift, false, 'no drift on identical guidance');

// 5. Missing row (guidance row deleted) counts as drift
eq(calc.houseAssumptionsDrift(pinned, live2026.slice(0, 2)).anyDrift, true, 'deleted guidance row → drift');

// 6. Adopt = re-pin: new pin reflects new guidance
const repinned = calc.pinHouseAssumptions(live2027, '2027-01-15');
eq(repinned.rows[0].year_1_pct, 5.0, 'adopt: re-pin picks up new guidance');
eq(calc.houseAssumptionsDrift(repinned, live2027).anyDrift, false, 'adopt: drift clears after re-pin');


// ---- UI relocation + clarity pass (2026-07-13, Brock UX callout) ----
// Source pins: the full table lives in the ASSUMPTIONS section; Setup
// carries only the compact pin/drift chip; rows are humanized, cells are
// signed percentages, and the two engine-feeding rows are badged.
import { readFileSync } from 'node:fs';
const uiSrc = readFileSync('./tools/cost-model/ui.js', 'utf8');

function pin(cond, label) { eq(!!cond, true, label); }

const setupBody = uiSrc.slice(uiSrc.indexOf('function renderSetup('), uiSrc.indexOf('function renderHouseGuidanceChip'));
pin(setupBody.includes('renderHouseGuidanceChip()'), 'Setup renders the compact chip');
pin(!setupBody.includes('renderHouseAssumptionsCard()'), 'Setup no longer renders the full table');

const asmIdx = uiSrc.indexOf('function renderAssumptions(');
const asmBody = uiSrc.slice(asmIdx, asmIdx + 12000);
pin(asmBody.includes('renderHouseAssumptionsCard()'), 'Assumptions section hosts the full table');

pin(uiSrc.includes("'labor_category|hourly|wage': 'Hourly wages'"), 'rows humanized (no raw scope/metric)');
pin(uiSrc.includes('seeds Labor Escalation') && uiSrc.includes('seeds Cost Escalation'), 'labor + cost seed rows are badged');
pin(uiSrc.includes('seeds Facility Escalation') && uiSrc.includes('seeds Equipment Escalation'), 'W3: facility + equipment seed rows are badged');
pin(uiSrc.includes('seeds.facilityEscalation') && uiSrc.includes('seeds.equipmentEscalation'), 'W3: ensureHouseAssumptions applies the per-category seeds');
pin(uiSrc.includes('EXPECTED YEAR-OVER-YEAR INCREASE'), 'column group states the unit in plain English');
pin(uiSrc.includes("(v > 0 ? '+' : v < 0 ? '\u2212' : '')") || /v > 0 \? '\+' : v < 0/.test(uiSrc), 'cells are signed percentages');
pin(uiSrc.includes("data-tc-section=\"assumptions\"") || uiSrc.includes("data-tc-section='assumptions'"), 'chip links to the Assumptions section');
pin(!uiSrc.includes('max-width:220px;">${escapeAttr(r.notes'), 'notes no longer truncate');

console.log(`test-cm-house-assumptions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

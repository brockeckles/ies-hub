// test-wsc-layout.mjs — N5 grid-fit + compliance coverage (2026-07-04).
import { computeGridFit, runComplianceChecks, flowPatternAdvisory, synthesizeLayout, RACK_UPRIGHT_WIDTH_IN }
  from './tools/warehouse-sizing/layout-calc.js';
import { pinWscFactors } from './tools/warehouse-sizing/factors-calc.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── grid-fit (GMA: bay 108" + 3" upright = 111" pitch) ──
{
  const g = computeGridFit({ facility: { columnSpacingX: 50, flueSpace: 3 } });
  t('GMA bay pitch 111', g.bayPitchIn === 111);
  // 50 ft: 600-12=588 usable ÷ 111 = 5 bays, slack 33"
  t('50 ft → 5 bays', g.baysPerModule === 5);
  t('50 ft slack 33"', g.slackIn === 33);
  t('no flue conflict at 33" slack', g.flueConflict === false);
  t('column buriable in b2b row', g.columnBuriable === true);
  // recommendation should find a span fitting 6 bays: 6×111+12 = 678" = 56.5 ft > 56 max → cannot fit 6.
  t('recommendation stays ≤ catalog max', !g.recommended || g.recommended.spanFt <= 56);
  t('recommendation never fewer bays', !g.recommended || g.recommended.baysPerModule >= 5);
  // research anchor: seven 96" bays ≈ 58 ft — our pitch math: 7 bays × 111 + 12 = 789" = 65.75 ft for GMA 108" bays.
  // For the literature's 96" bay (pitch 99): 7×99+12 = 705" = 58.75 ft ✓ order of magnitude
  const litFt = (7 * (96 + RACK_UPRIGHT_WIDTH_IN) + 12) / 12;
  t('literature 96" bay ≈ 58-59 ft for 7 bays', litFt > 58 && litFt < 60);
}
{
  // tight span: 28 ft → 336-12=324 ÷ 111 = 2 bays, slack 102? No: 324-222=102 → fine.
  // Force conflict: span where slack < flue. 38 ft: 456-12=444 ÷ 111 = 4 bays exactly 444 → slack 0 < 3 → conflict.
  const g = computeGridFit({ facility: { columnSpacingX: 38, flueSpace: 3 } });
  t('exact-fit span flags flue conflict', g.baysPerModule === 4 && g.slackIn === 0 && g.flueConflict === true);
  t('conflict noted in rationale', g.rationale.includes('CONFLICT'));
}

// ── compliance: FM default ──
{
  const c = runComplianceChecks({
    facility: { clearHeight: 32, flueSpace: 3, topClearance: 36, buildingWidth: 480, buildingDepth: 320, aisleWidth: 9 },
    zones: { dockConfig: { inboundDoors: 3, outboundDoors: 3 }, receiveStagingSqft: 10400, shipStagingSqft: 5200 },
    dynamicsPlan: { mhe: { governingAisleFt: 9, fleet: [{ label: 'Reach truck', aisleFt: 9 }] } },
  });
  t('FM is default standard', c.flueStandard === 'FM');
  const flue = c.checks.find(x => x.id === 'flue');
  t('FM flue 3" passes at 3"', flue.status === 'PASS');
  t('FM cites DS 8-9', flue.citation.includes('8-9'));
  const egress = c.checks.find(x => x.id === 'egress');
  // worst ≈ 320 + 240 = 560 > 400 → FAIL
  t('egress 560 > 400 FAIL', egress.status === 'FAIL' && egress.actual.includes('560'));
  t('egress limit 400 (clear 32 ≥ 24)', egress.required === '≤ 400 ft');
  const spr = c.checks.find(x => x.id === 'sprinkler');
  t('sprinkler 36 ≥ 18 PASS', spr.status === 'PASS');
  const aisle = c.checks.find(x => x.id === 'aisle');
  t('aisle 9 ≥ 9 PASS', aisle.status === 'PASS');
  const staging = c.checks.find(x => x.id === 'staging');
  t('staging 15,600 ≥ 6×510 PASS', staging.status === 'PASS');
  const esfr = c.checks.find(x => x.id === 'esfr');
  t('ESFR 32 ≤ 45 PASS', esfr.status === 'PASS');
  t('failCount 1 (egress only)', c.failCount === 1);
}

// ── compliance: NFPA toggle + longitudinal + low clear ──
{
  const c = runComplianceChecks({
    facility: { clearHeight: 32, flueSpace: 3, topClearance: 12, buildingWidth: 200, buildingDepth: 150 },
    zones: {},
    flueStandard: 'NFPA',
  });
  t('NFPA flue 3 < 6 FAIL', c.checks.find(x => x.id === 'flue').status === 'FAIL');
  // storage top ≈ 32 − 1 = 31 > 25 → longitudinal check appears + fails
  const lon = c.checks.find(x => x.id === 'flue-long');
  t('NFPA longitudinal required >25 ft storage', !!lon && lon.status === 'FAIL');
  t('sprinkler 12 < 18 FAIL', c.checks.find(x => x.id === 'sprinkler').status === 'FAIL');
  // egress: worst = 150+100 = 250 ≤ 400 (clear 32) → PASS
  t('egress 250 ≤ 400 PASS', c.checks.find(x => x.id === 'egress').status === 'PASS');
  t('aisle N/A without dynamics', c.checks.find(x => x.id === 'aisle').status === 'N/A');
}
{
  // clear < 24 → 250 limit
  const c = runComplianceChecks({ facility: { clearHeight: 22, buildingWidth: 400, buildingDepth: 300 }, zones: {} });
  const egress = c.checks.find(x => x.id === 'egress');
  t('clear 22 → 250 ft limit', egress.required === '≤ 250 ft');
  t('no dims → egress N/A', runComplianceChecks({ facility: {}, zones: {} }).checks.find(x => x.id === 'egress').status === 'N/A');
}

// ── pinned factor override (flue default via catalog) ──
{
  const pinned = pinWscFactors([
    { category_code: 'wsc_layout_compliance', ratio_code: 'wsc.flue.default_standard', value_jsonb: { default: 'NFPA', options: ['FM', 'NFPA'] }, sort_order: 10 },
  ]);
  const c = runComplianceChecks({ facility: { flueSpace: 6 }, zones: {}, pinnedFactors: pinned });
  t('catalog default standard honored (NFPA)', c.flueStandard === 'NFPA');
  t('explicit toggle beats catalog', runComplianceChecks({ facility: {}, zones: {}, flueStandard: 'FM', pinnedFactors: pinned }).flueStandard === 'FM');
}

// ── flow pattern ──
{
  t('single-sided → U-flow', flowPatternAdvisory({ dockConfig: { sided: 'single' } }).pattern === 'U-flow');
  t('two-sided → through-flow', flowPatternAdvisory({ dockConfig: { sided: 'two' } }).pattern === 'through-flow');
  t('U-flow mentions speed bay', flowPatternAdvisory({}).advisory.includes('speed bay'));
}

// ── orchestrator ──
{
  const plan = synthesizeLayout({
    facility: { columnSpacingX: 38, flueSpace: 3, clearHeight: 32, buildingWidth: 480, buildingDepth: 320 },
    zones: { dockConfig: { sided: 'single', inboundDoors: 3, outboundDoors: 3 }, receiveStagingSqft: 100, shipStagingSqft: 100 },
  });
  t('layout plan produced', plan.engine === 'wsc-layout-v1');
  t('GRID_FLUE_CONFLICT gap', plan.gaps.some(g => g.code === 'GRID_FLUE_CONFLICT'));
  t('COMPLIANCE_FAILS gap (egress + staging)', plan.gaps.some(g => g.code === 'COMPLIANCE_FAILS'));
  t('NO_DYNAMICS_PLAN info', plan.gaps.some(g => g.code === 'NO_DYNAMICS_PLAN'));
  t('flue standard rides plan', plan.flueStandard === 'FM');
  t('citations include egress + flues', plan.citations.includes('wsc.egress.s1_travel_ft') && plan.citations.includes('wsc.flue.fm_ds8_9'));
}

console.log(`\ntest-wsc-layout: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

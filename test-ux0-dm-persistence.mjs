/**
 * UX0-3 (2026-07-03) — DM persistence fixes (source wiring scans).
 * (1) Hub deal-management "Advance to Stage N" persists current_stage_id
 *     (was memory-only — X3 in the UX assessment).
 * (2) Multi-Site Analyzer link flow no longer mints 's-cm-*' site ids that
 *     mismatch the String(row.id) shape every handler expects.
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const dmApi = readFileSync('./hub/deal-management/api.js', 'utf8');
const dmUi = readFileSync('./hub/deal-management/ui.js', 'utf8');
const msaUi = readFileSync('./tools/deal-manager/ui.js', 'utf8');

t('api.advanceDealStage exists and writes current_stage_id', () =>
  /export async function advanceDealStage/.test(dmApi)
  && /update\(\{ current_stage_id: match\.id \}\)/.test(dmApi));

t('advanceDealStage exported in default bag', () =>
  /setDosElementStatus, advanceDealStage,/.test(dmApi));

t('advanceDealStage maps stage_number → stages.id (not raw number)', () =>
  /Number\(s\.stage_number\) === Number\(stageNumber\)/.test(dmApi));

t('advance-stage handler calls api.advanceDealStage for real deals', () =>
  /_isRealDealId\(selectedDeal\.id\)[\s\S]{0,200}api\.advanceDealStage/.test(dmUi));

t('advance-stage rolls back on failure', () =>
  /deal\.stage = prevStage;/.test(dmUi));

t("MSA link flow no longer mints 's-cm-' ids", () =>
  !msaUi.includes("id: 's-cm-'"));

t('MSA persisted-deal link rehydrates via api.listSites', () =>
  /sites = await api\.listSites\(activeDeal\.id\);/.test(msaUi));

console.log(`test-ux0-dm-persistence: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

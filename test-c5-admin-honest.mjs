// test-c5-admin-honest.mjs — C5 admin honesty + security pins (Wave C5, 2026-07-22)
//
// Pins the hub/admin cleanup via source scan (pure, no network, no DOM):
//   1. Demo fiction gone: DEMO_ESCALATIONS / DEMO_USERS / DEMO_AUDIT_LOG no
//      longer exist in calc.js, and ui.js renders none of them. The
//      Escalations tab is an honest empty state; the "Active Rules" KPI
//      (count of invented rules) is gone; the Records KPI derives from the
//      same live countMasterRecords fetch the cards use.
//   2. Dead api fns gone: the escalation_rules trio (table exists in ZERO
//      migrations), loadRefData, listUsers, updateUser, writeAuditEntry.
//   3. Stored-XSS sinks closed: master-data cell values and audit userName
//      pass through escapeHtml before innerHTML.
//   4. Typedefs match the real schema: role union admin|member, full_name.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + name); }
}

const uiSrc    = readFileSync(new URL('./hub/admin/ui.js', import.meta.url), 'utf8');
const apiSrc   = readFileSync(new URL('./hub/admin/api.js', import.meta.url), 'utf8');
const calcSrc  = readFileSync(new URL('./hub/admin/calc.js', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('./hub/admin/types.js', import.meta.url), 'utf8');

// ── 1. Demo fiction deleted ──────────────────────────────────────────────
check('calc: DEMO_ESCALATIONS export gone', !/export const DEMO_ESCALATIONS/.test(calcSrc));
check('calc: DEMO_USERS export gone',       !/export const DEMO_USERS/.test(calcSrc));
check('calc: DEMO_AUDIT_LOG export gone',   !/export const DEMO_AUDIT_LOG/.test(calcSrc));
check('ui: no calc.DEMO_* reference anywhere', !/calc\.DEMO_/.test(uiSrc));

// Escalations tab = honest empty state, not a fabricated rules list.
check('ui: escalations tab says no rules exist yet',
  uiSrc.includes('No escalation rules yet'));
check('ui: escalations tab points to the real home of escalation settings',
  /Deal Management/.test(uiSrc) && /CM knobs/.test(uiSrc));
check('ui: escalations tab keeps its tab button',
  /'tables', 'activity', 'escalations', 'audit'/.test(uiSrc));

// KPI strip: Active Rules tile removed; Records tile live, not hardcoded 0.
check('ui: "Active Rules" KPI tile gone', !uiSrc.includes("'Active Rules'"));
check('ui: Records KPI patched from live counts (shared fetch)',
  /getLiveCounts\(\)/.test(uiSrc) && /#admin-kpi-records/.test(uiSrc));
check('ui: Records KPI shows placeholder until counts land',
  /kpi\('Records', '…'/.test(uiSrc));
check('ui: card grid uses the same shared count fetch',
  /getLiveCounts\(true\)\.then\(counts/.test(uiSrc));
check('ui: only getLiveCounts calls countMasterRecords (single fetch path)',
  (uiSrc.match(/api\.countMasterRecords\(/g) || []).length === 1);
check('api: countMasterRecords still exported (KPI + cards depend on it)',
  /export async function countMasterRecords/.test(apiSrc));

// ── 2. Dead api fns deleted ──────────────────────────────────────────────
check('api: listEscalations gone',   !/export async function listEscalations/.test(apiSrc));
check('api: saveEscalation gone',    !/export async function saveEscalation/.test(apiSrc));
check('api: deleteEscalation gone',  !/export async function deleteEscalation/.test(apiSrc));
check('api: no escalation_rules query remains', !/from\('escalation_rules'\)/.test(apiSrc));
check('api: loadRefData gone',       !/export async function loadRefData/.test(apiSrc));
check('api: listUsers gone',         !/export async function listUsers/.test(apiSrc));
check('api: updateUser gone',        !/export async function updateUser/.test(apiSrc));
check('api: writeAuditEntry gone',   !/export async function writeAuditEntry/.test(apiSrc));

// Live surfaces preserved (Master Data / User Activity / Audit are DB-backed).
check('api: listMasterRecords preserved', /export async function listMasterRecords/.test(apiSrc));
check('api: saveMasterRecord preserved',  /export async function saveMasterRecord/.test(apiSrc));
check('api: deleteMasterRecord preserved',/export async function deleteMasterRecord/.test(apiSrc));
check('api: listAuditLog preserved',      /export async function listAuditLog/.test(apiSrc));
check('api: loadUserActivityInputs preserved', /export async function loadUserActivityInputs/.test(apiSrc));
check('api: inviteUser preserved',        /export async function inviteUser/.test(apiSrc));

// ── 3. Stored-XSS sinks escaped ──────────────────────────────────────────
check('ui: master-data text cells escape stored values',
  /display = \(val == null \|\| val === ''\) \? '—' : escapeHtml\(String\(val\)\)/.test(uiSrc));
check('ui: master-data non-numeric "number" values escaped too',
  /escapeHtml\(String\(val \?\? '—'\)\)/.test(uiSrc));
check('ui: audit userName escaped', /\$\{escapeHtml\(r\.userName\)\}/.test(uiSrc));
check('ui: escapeHtml imported from shared', /from '\.\.\/\.\.\/shared\/escape\.js\?v=/.test(uiSrc));

// ── 4. Typedefs match the real schema ────────────────────────────────────
check('types: role union is admin|member', /'admin' \| 'member'/.test(typesSrc));
check('types: legacy editor/viewer union gone', !/'editor' \| 'viewer'/.test(typesSrc));
check('types: full_name replaces displayName', /@property \{string\} full_name/.test(typesSrc) && !/@property \{string\} displayName/.test(typesSrc));

// ── 5. Env chip uses tokens where exact-value tokens exist ───────────────
check('ui: env chip prod colors use hub.css tokens',
  uiSrc.includes("'var(--c-success-bg)'") &&
  uiSrc.includes("'var(--c-success-ink)'") &&
  uiSrc.includes("'var(--c-success)'"));

console.log(`test-c5-admin-honest: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

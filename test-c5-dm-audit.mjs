// test-c5-dm-audit.mjs — C5 pin: every mutating fn in hub/deal-management/api.js
// writes an audit-log entry (recordAudit, fire-and-forget, post-mutation).
//
// C4's coverage report flagged 11 mutating fns with no audit trail; C5 wired
// them. This test slices each exported fn's body and pins the recordAudit
// call's table + action so a refactor can't silently drop the trail.
// Pre-C5 calls (set_site_in_bid / create_site / delete_site / deal_bid_meta
// 'update') are pinned too — their action strings are history, not vocab.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`); }
}

const src = readFileSync(new URL('./hub/deal-management/api.js', import.meta.url), 'utf8');

/** Body of `export async function <name>` up to the next export (or EOF). */
function fnBody(name) {
  const i = src.indexOf(`export async function ${name}`);
  if (i < 0) return '';
  const j = src.indexOf('\nexport ', i + 1);
  return src.slice(i, j > 0 ? j : src.length);
}

// C5 walk-fix (2026-07-22): audit_log.action carries a DB CHECK constraint
// (insert|update|delete|link|unlink). Descriptive verbs sent as `action`
// violated it and were SILENTLY dropped (fire-and-forget) since S1 — caught
// live when a ★ toggle recorded nothing. Actions are now enum verbs; the
// descriptive name rides in fields.op.
// [fnName, entity table, enum action, op (null = none)]
const PINS = [
  ['createDeal',          'deal_deals',          'insert', 'create_deal'],
  ['deleteDeal',          'deal_deals',          'delete', 'delete_deal'],
  ['saveStrategy',        'deal_strategy',       'update', null],
  ['createArtifact',      'deal_artifacts',      'insert', 'create_artifact'],
  ['deleteArtifact',      'deal_artifacts',      'delete', 'delete_artifact'],
  ['recordDealOutcome',   'deal_outcomes',       'insert', 'record_outcome'],
  ['updateSite',          'deal_sites',          'update', 'update_site'],
  ['assignModelToSite',   'cost_model_projects', 'update', 'assign_model_to_site'],
  ['setDosElementStatus', 'deal_dos_status',     'update', null],
  ['advanceDealStage',    'deal_deals',          'update', 'advance_stage'],
  ['setModelInBid',       'deal_sites',          'update', 'set_site_in_bid'],
  ['createSite',          'deal_sites',          'insert', 'create_site'],
  ['deleteSite',          'deal_sites',          'delete', 'delete_site'],
  ['saveBidMeta',         'deal_bid_meta',       'update', null],
];

const ENUM_ACTIONS = new Set(['insert', 'update', 'delete', 'link', 'unlink']);

for (const [fn, table, action, op] of PINS) {
  const body = fnBody(fn);
  t(`${fn}: fn exists`, body.length > 0);
  t(`${fn}: audits '${table}' / '${action}'${op ? ` (op ${op})` : ''}`,
    body.includes(`table: '${table}'`) && body.includes(`action: '${action}'`)
    && (!op || body.includes(`op: '${op}'`))
    && /recordAudit\(\{/.test(body));
}

// REGRESSION GUARD: every recordAudit action literal in the file must be an
// enum verb — anything else is silently rejected by audit_log_action_check.
{
  const bad = [...src.matchAll(/action:\s*'([^']+)'/g)]
    .map((m) => m[1]).filter((a) => !ENUM_ACTIONS.has(a));
  t(`all recordAudit actions are enum verbs (bad: ${bad.join(',') || 'none'})`, bad.length === 0);
}

// assignDesignToSite audits the tool's own table (variable), not a literal.
{
  const body = fnBody('assignDesignToSite');
  t('assignDesignToSite: audits resolved design table / update (op assign_design_to_site)',
    /recordAudit\(\{ table, /.test(body) && body.includes("action: 'update'")
    && body.includes("op: 'assign_design_to_site'"));
}

// Convention pins: audit calls are fire-and-forget (never awaited — the
// mutation must not block on the trail; recordAudit swallows its own errors).
t('no audit call is awaited', !/await recordAudit\(/.test(src));

console.log(`test-c5-dm-audit: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

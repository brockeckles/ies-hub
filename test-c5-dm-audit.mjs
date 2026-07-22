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

// [fnName, entity table, action]
const PINS = [
  // C5 additions
  ['createDeal',          'deal_deals',          'create_deal'],
  ['deleteDeal',          'deal_deals',          'delete_deal'],
  ['saveStrategy',        'deal_strategy',       'update'],
  ['createArtifact',      'deal_artifacts',      'create_artifact'],
  ['deleteArtifact',      'deal_artifacts',      'delete_artifact'],
  ['recordDealOutcome',   'deal_outcomes',       'record_outcome'],
  ['updateSite',          'deal_sites',          'update_site'],
  ['assignModelToSite',   'cost_model_projects', 'assign_model_to_site'],
  ['setDosElementStatus', 'deal_dos_status',     'update'],
  ['advanceDealStage',    'deal_deals',          'advance_stage'],
  // pre-C5 (kept as-is — action names are historical)
  ['setModelInBid',       'deal_sites',          'set_site_in_bid'],
  ['createSite',          'deal_sites',          'create_site'],
  ['deleteSite',          'deal_sites',          'delete_site'],
  ['saveBidMeta',         'deal_bid_meta',       'update'],
];

for (const [fn, table, action] of PINS) {
  const body = fnBody(fn);
  t(`${fn}: fn exists`, body.length > 0);
  t(`${fn}: audits '${table}' / '${action}'`,
    body.includes(`table: '${table}'`) && body.includes(`action: '${action}'`)
    && /recordAudit\(\{/.test(body));
}

// assignDesignToSite audits the tool's own table (variable), not a literal.
{
  const body = fnBody('assignDesignToSite');
  t('assignDesignToSite: audits resolved design table / assign_design_to_site',
    /recordAudit\(\{ table, /.test(body) && body.includes("action: 'assign_design_to_site'"));
}

// Convention pins: audit calls are fire-and-forget (never awaited — the
// mutation must not block on the trail; recordAudit swallows its own errors).
t('no audit call is awaited', !/await recordAudit\(/.test(src));

console.log(`test-c5-dm-audit: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

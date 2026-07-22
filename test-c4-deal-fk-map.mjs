// test-c4-deal-fk-map.mjs — pins the C4 deal-FK spelling map (Brock ruling
// 2026-07-22: DOCUMENT the tri-spelling, no renames, canonical `deal_id` for
// NEW tables only).
//
// Pins:
//   1. shared/deal-fk.js imports cleanly in bare node and DEAL_FK covers the
//      verified floor of tables with EXACTLY the audited spellings.
//   2. Per-table evidence: each map entry's primary api file actually uses
//      the mapped column against that table (source-text scan of the code
//      paths verified during the audit).
//   3. No api file couples a deal-FK spelling to a mapped table in a way
//      that CONTRADICTS the map (chain scan: .eq/.is after a literal
//      db.from('<table>'), plus db.insert/db.update/db.fetchAll windows).
//
// Run:  node test-c4-deal-fk-map.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { DEAL_FK, DEAL_FK_SPELLINGS, DEAL_FK_CANONICAL } from './shared/deal-fk.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ------------------------------------------------------------------
// 1. Map shape + hardcoded expected floor (audited 2026-07-22)
// ------------------------------------------------------------------
const EXPECTED = {
  cost_model_projects:  'deal_deals_id',
  wsc_facility_configs: 'parent_deal_id',
  netopt_configs:       'parent_deal_id',
  cog_scenarios:        'parent_deal_id',
  most_analyses:        'parent_deal_id',
  fleet_scenarios:      'parent_deal_id',
  cost_model_scenarios: 'deal_id',
  deal_sites:           'deal_id',
  deal_strategy:        'deal_id',
  deal_artifacts:       'deal_id',
  deal_dos_status:      'deal_id',
  deal_bid_meta:        'deal_id',
  deal_outcomes:        'deal_id',
};

t('DEAL_FK covers the audited floor with exact spellings', () => {
  for (const [table, col] of Object.entries(EXPECTED)) {
    assert(DEAL_FK[table] === col,
      `DEAL_FK.${table} = ${JSON.stringify(DEAL_FK[table])}, audit says '${col}'`);
  }
});

t('DEAL_FK has no unaudited entries (update EXPECTED when adding tables)', () => {
  for (const table of Object.keys(DEAL_FK)) {
    assert(EXPECTED[table] !== undefined,
      `DEAL_FK has entry '${table}' not in this test's audited floor — verify + add it here`);
  }
});

t('every DEAL_FK value is one of the three legal spellings', () => {
  for (const [table, col] of Object.entries(DEAL_FK)) {
    assert(DEAL_FK_SPELLINGS.includes(col), `DEAL_FK.${table} = '${col}' is not a legal spelling`);
  }
});

t('map is frozen and canonical spelling is deal_id', () => {
  assert(Object.isFrozen(DEAL_FK), 'DEAL_FK must be frozen');
  assert(DEAL_FK_CANONICAL === 'deal_id', 'canonical spelling for NEW tables is deal_id (ruled 2026-07-22)');
});

// ------------------------------------------------------------------
// 2. Per-table evidence — the primary api file uses the mapped column.
//    Each regex anchors a code path verified in the 2026-07-22 audit.
// ------------------------------------------------------------------
const EVIDENCE = {
  cost_model_projects: {
    file: './tools/cost-model/api.js',
    // saveProject/insert path stamps the CM deal spine.
    re: /payload\.deal_deals_id = dealId/,
  },
  cost_model_scenarios: {
    file: './tools/cost-model/api.js',
    // listScenarios filters cost_model_scenarios by deal_id.
    re: /from\('cost_model_scenarios'\)[\s\S]{0,300}?\.eq\('deal_id'/,
  },
  wsc_facility_configs: {
    file: './tools/warehouse-sizing/api.js',
    re: /payload\.parent_deal_id = _ctx\.id/,
  },
  netopt_configs: {
    file: './tools/network-opt/api.js',
    re: /payload\.parent_deal_id = config\.parent_deal_id \?\? _ctx\?\.id \?\? null/,
  },
  cog_scenarios: {
    file: './tools/center-of-gravity/api.js',
    re: /payload\.parent_deal_id = _ctx\.id/,
  },
  most_analyses: {
    file: './tools/most-standards/api.js',
    re: /payload\.parent_deal_id = _ctx\.id/,
  },
  fleet_scenarios: {
    file: './tools/fleet-modeler/api.js',
    re: /payload\.parent_deal_id = _ctx\.id/,
  },
  deal_sites: {
    file: './hub/deal-management/api.js',
    re: /from\('deal_sites'\)[\s\S]{0,300}?\.eq\('deal_id'/,
  },
  deal_strategy: {
    file: './hub/deal-management/api.js',
    re: /from\('deal_strategy'\)[\s\S]{0,300}?\.eq\('deal_id'/,
  },
  deal_artifacts: {
    file: './hub/deal-management/api.js',
    re: /from\('deal_artifacts'\)[\s\S]{0,300}?\.eq\('deal_id'/,
  },
  deal_dos_status: {
    file: './hub/deal-management/api.js',
    re: /from\('deal_dos_status'\)[\s\S]{0,300}?\.eq\('deal_id'/,
  },
  deal_bid_meta: {
    file: './hub/deal-management/api.js',
    re: /from\('deal_bid_meta'\)[\s\S]{0,300}?\.eq\('deal_id'/,
  },
  deal_outcomes: {
    file: './hub/deal-management/api.js',
    re: /from\('deal_outcomes'\)[\s\S]{0,300}?\.eq\('deal_id'/,
  },
};

t('every DEAL_FK table has an evidence spec in this test', () => {
  for (const table of Object.keys(DEAL_FK)) {
    assert(EVIDENCE[table], `no evidence spec for DEAL_FK table '${table}'`);
  }
});

for (const [table, spec] of Object.entries(EVIDENCE)) {
  t(`evidence: ${spec.file} uses ${DEAL_FK[table]} for ${table}`, () => {
    const src = read(spec.file);
    assert(spec.re.test(src),
      `expected ${spec.file} to match ${spec.re} (audited usage of '${DEAL_FK[table]}' for ${table})`);
  });
}

// Design-tool tables stamp parent_deal_id on the INSERT path only and must
// never touch the other two spellings in their own api file.
for (const table of ['wsc_facility_configs', 'cog_scenarios', 'most_analyses', 'fleet_scenarios', 'netopt_configs']) {
  const file = EVIDENCE[table].file;
  t(`purity: ${file} never uses deal_deals_id or bare deal_id`, () => {
    const src = read(file);
    assert(!/(?<![A-Za-z0-9_])deal_deals_id(?![A-Za-z0-9_])/.test(src),
      `${file} uses deal_deals_id — that spelling belongs to cost_model_projects only`);
    assert(!/(?<![A-Za-z0-9_$])deal_id(?![A-Za-z0-9_])/.test(src),
      `${file} uses bare deal_id — its table '${table}' maps to parent_deal_id`);
  });
}

// ------------------------------------------------------------------
// 3. Contradiction scan — no api file couples a spelling to a mapped
//    table that disagrees with DEAL_FK.
// ------------------------------------------------------------------
function listApiFiles() {
  const out = [];
  for (const root of ['tools', 'hub']) {
    const rootUrl = new URL(`./${root}/`, import.meta.url);
    for (const dir of readdirSync(rootUrl, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      try {
        readFileSync(new URL(`./${root}/${dir.name}/api.js`, import.meta.url));
        out.push(`./${root}/${dir.name}/api.js`);
      } catch { /* no api.js in this dir */ }
    }
  }
  return out;
}

const SPELLING_TOKEN = /(?<![A-Za-z0-9_])(deal_deals_id|parent_deal_id|deal_id)(?![A-Za-z0-9_])/g;

/**
 * Nearest preceding `.from(...)` call before index `i`. Returns the literal
 * table name, or null when out of range / the arg is a variable (e.g. the
 * generic grab(table) helper in hub/deal-management/api.js).
 */
function nearestFromTable(src, i) {
  const back = src.slice(Math.max(0, i - 600), i);
  const m = [...back.matchAll(/\.from\(\s*([^)\s,]+)\s*\)/g)];
  if (!m.length) return null;
  const arg = m[m.length - 1][1];
  const lit = arg.match(/^'([A-Za-z0-9_]+)'$/);
  return lit ? lit[1] : null; // variable arg → unknown table, skip
}

/** Span of the call whose opening paren is at src[open] (balanced parens). */
function callSpan(src, open) {
  let depth = 0;
  for (let j = open; j < src.length && j < open + 2000; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return src.slice(open, open + 400);
}

t('no api file contradicts DEAL_FK (filter-chain scan: .eq/.is)', () => {
  const files = listApiFiles();
  assert(files.length >= 10, `expected >=10 api files, found ${files.length}`);
  const errs = [];
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/\.(?:eq|is)\(\s*'(deal_deals_id|parent_deal_id|deal_id)'/g)) {
      const col = m[1];
      const table = nearestFromTable(src, m.index);
      if (!table || !(table in DEAL_FK)) continue;
      if (DEAL_FK[table] !== col) {
        errs.push(`${file}: .eq/.is('${col}') on from('${table}') but DEAL_FK says '${DEAL_FK[table]}'`);
      }
    }
  }
  assert(errs.length === 0, errs.join('\n  '));
});

t('no api file contradicts DEAL_FK (db.insert/update/fetchAll windows)', () => {
  const errs = [];
  for (const file of listApiFiles()) {
    const src = read(file);
    for (const m of src.matchAll(/db\.(?:insert|update|fetchAll)\(\s*'([A-Za-z0-9_]+)'/g)) {
      const table = m[1];
      if (!(table in DEAL_FK)) continue;
      const span = callSpan(src, src.indexOf('(', m.index + 3));
      for (const s of span.matchAll(SPELLING_TOKEN)) {
        if (s[1] !== DEAL_FK[table]) {
          errs.push(`${file}: db call on '${table}' carries '${s[1]}' but DEAL_FK says '${DEAL_FK[table]}'`);
        }
      }
    }
  }
  assert(errs.length === 0, errs.join('\n  '));
});

// ------------------------------------------------------------------
console.log(`\ntest-c4-deal-fk-map: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

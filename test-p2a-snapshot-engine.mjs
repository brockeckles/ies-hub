// test-p2a-snapshot-engine.mjs — S3-P2-a "Mark as submitted" engine layer
// (2026-07-23). The explicit submit action stamps an IMMUTABLE bid-of-record
// snapshot, closing the bid-vs-outcome calibration loop.
//
// Pins:
//   1. Migration 20260723120000_p2a_deal_bid_snapshots.sql — table shape,
//      APPEND-ONLY trigger (belt-and-braces vs service_role), NO
//      update/delete RLS policies, (deal_id, submitted_at desc) index, and
//      the deal_outcomes.bid_snapshot_id alter.
//   2. buildBidSnapshotPayload behavioral run on a synthetic
//      Hearthwood-shaped fixture (3 sites, 2 ★ — one engine-priced, one
//      heuristic — partial manifest): payload shape + hand-computed numbers,
//      determinism, null-safety, no-★ legacy fallback, purity (no clocks).
//   3. hub/deal-management/api.js source pins — submitBid insert + audit
//      enum/op, recordDealOutcome snapshot prefill precedence (explicit
//      caller values ALWAYS win), listBidSnapshots/latestBidSnapshot
//      fail-soft.
//   4. shared/deal-fk.js maps deal_bid_snapshots → deal_id (canonical
//      spelling for NEW tables, ruled 2026-07-22).
//
// Run:  node test-p2a-snapshot-engine.mjs

import { readFileSync } from 'node:fs';
import { buildBidSnapshotPayload, BID_SNAPSHOT_SCHEMA_VERSION } from './tools/deal-manager/calc.js';
import { computeBidManifest, computeStarRollup } from './hub/deal-management/calc.js?v=20260722-s3d';
import { DEAL_FK, DEAL_FK_CANONICAL } from './shared/deal-fk.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ============================================================
// 1. Migration pins
// ============================================================
{
  let sql = '';
  let exists = true;
  try { sql = read('./supabase/migrations/20260723120000_p2a_deal_bid_snapshots.sql'); }
  catch { exists = false; }
  t('migration file exists', exists);
  t('creates public.deal_bid_snapshots', /create table if not exists public\.deal_bid_snapshots/i.test(sql));
  t('deal FK is canonical deal_id → deal_deals cascade',
    /deal_id\s+uuid not null references public\.deal_deals\(id\) on delete cascade/i.test(sql));
  t('payload jsonb NOT NULL', /payload\s+jsonb not null/i.test(sql));
  t('submitted_by → auth.users on delete set null',
    /submitted_by\s+uuid.*references auth\.users\(id\) on delete set null/i.test(sql));
  t('index on (deal_id, submitted_at desc)',
    /create index if not exists \S+\s+on public\.deal_bid_snapshots \(deal_id, submitted_at desc\)/i.test(sql));
  t('RLS enabled', /alter table public\.deal_bid_snapshots enable row level security/i.test(sql));
  t('SELECT policy present', /create policy \S+ on public\.deal_bid_snapshots for select/i.test(sql));
  t('INSERT policy present', /create policy \S+ on public\.deal_bid_snapshots for insert/i.test(sql));
  t('NO update policy (append-only)', !/create policy \S+ on public\.deal_bid_snapshots for update/i.test(sql));
  t('NO delete policy (append-only)', !/create policy \S+ on public\.deal_bid_snapshots for delete/i.test(sql));
  t('append-only trigger fires BEFORE UPDATE OR DELETE',
    /before update or delete on public\.deal_bid_snapshots/i.test(sql));
  t('append-only trigger RAISEs (service_role bypasses RLS, not triggers)',
    /raise exception 'deal_bid_snapshots is append-only/i.test(sql));
  t('trigger function pins search_path (advisor 0011)',
    /_deal_bid_snapshots_append_only\(\)[\s\S]*?set search_path = ''/i.test(sql));
  t('deal_outcomes gains bid_snapshot_id (set null on snapshot delete)',
    /alter table public\.deal_outcomes\s+add column if not exists bid_snapshot_id uuid references public\.deal_bid_snapshots\(id\) on delete set null/i.test(sql));
  // Scoping mirrors deal_bid_meta: deal-owner/team/shared read, owner/admin insert.
  t('SELECT policy scoped through parent deal (deal_bid_meta style)',
    /for select using \(\s*exists \(select 1 from public\.deal_deals d where d\.id = deal_bid_snapshots\.deal_id/i.test(sql));
}

// ============================================================
// 2. buildBidSnapshotPayload — Hearthwood-shaped fixture
// ============================================================
const SITES = [
  { id: 's1', name: 'Hearthwood East',  status: 'proposed', inBidModelId: 101, sqft: 250000 },
  { id: 's2', name: 'Hearthwood West',  status: 'proposed', inBidModelId: 102, sqft: 180000 },
  { id: 's3', name: 'Hearthwood North', status: 'proposed', inBidModelId: null, sqft: 0 },
];
const MODELS = [
  { id: 101, name: 'Hearthwood East CM', scenario_label: 'Baseline',
    total_annual_revenue: 5000000, total_annual_cost: 4200000, target_margin_pct: 14,
    facility_sqft: 250000, site_id: 's1' },
  { id: 102, name: 'Hearthwood West CM', scenario_label: 'Aggressive',
    total_annual_revenue: 0, total_annual_cost: 2700000, target_margin_pct: 12,
    facility_sqft: 180000, site_id: 's2' },
  { id: 103, name: 'Orphan CM', scenario_label: 'Draft',
    total_annual_revenue: 0, total_annual_cost: 900000, target_margin_pct: 10,
    facility_sqft: 90000, site_id: null },
];
const META = { exec_summary: '', submission_due: '2026-08-01',
  manual_checks: { 'commercial-review': true } };
const MANIFEST = computeBidManifest({
  sites: SITES, models: MODELS,
  designs: { wsc: [{ site_id: 's1' }], most: [] },
  strategy: { value_prop: 'Win on flexibility' },
  meta: META,
});
const ROLLUP = computeStarRollup(SITES, new Map(MODELS.map(m => [String(m.id), m])),
  { revenue: 0, margin: 10 });
const DEAL = { id: 'deal-hw', name: 'Hearthwood', client: 'Hearthwood Brands',
  score: 'B', scoreNum: 78 };

const snap = buildBidSnapshotPayload({
  deal: DEAL, manifest: MANIFEST, rollup: ROLLUP, bidMeta: META,
  sites: SITES, models: MODELS, strategy: { value_prop: 'Win on flexibility' },
});

// Hand-computed expectations:
//   ★ s1 → engine rev 5,000,000; cost 4,200,000; margin 16.0
//   ★ s2 → heuristic rev 2,700,000/0.88 = 3,068,181.82; cost 2,700,000; margin 12.0
//   Σ★  → rev 8,068,181.82; cost 6,900,000; margin 14.5 (1285/8875 → 14.4789 → r1)
//   manifest → required score 4.5/7 → pct 64 (partial ★-coverage, partial
//   engine-priced, partial design-basis, done financials/strategy/commercial,
//   missing exec summary)
{
  t('manifest fixture is genuinely partial (pct 64)', MANIFEST.pct === 64,
    `pct=${MANIFEST.pct}`);
  t('manifest_pct mirrors manifest.pct', snap.manifest_pct === 64);
  t('y1_revenue = Σ★ engine-first revenue', snap.y1_revenue === 8068181.82,
    `got ${snap.y1_revenue}`);
  t('y1_cost = Σ★ cost', snap.y1_cost === 6900000, `got ${snap.y1_cost}`);
  t('y1_margin_pct blended to 1dp', snap.y1_margin_pct === 14.5, `got ${snap.y1_margin_pct}`);

  const p = snap.payload;
  t('schema_version pinned to 1', p.schema_version === 1 && BID_SNAPSHOT_SCHEMA_VERSION === 1);
  t('deal identity captured', p.deal.id === 'deal-hw' && p.deal.name === 'Hearthwood'
    && p.deal.client === 'Hearthwood Brands');

  t('manifest section: pct + required counts + due date',
    p.manifest.pct === 64 && p.manifest.required_done === 3
    && p.manifest.required_total === 7 && p.manifest.due_date === '2026-08-01');
  t('manifest items: all 10 frozen in order',
    Array.isArray(p.manifest.items) && p.manifest.items.length === 10
    && p.manifest.items.map(i => i.key).join(',') ===
      'star-coverage,engine-priced,design-basis,financials-ready,network-coverage,win-strategy,exec-summary,commercial-review,ops-review,client-deck');
  t('manifest items carry status/required/detail, drop UI-only fixTab',
    p.manifest.items.every(i => typeof i.status === 'string'
      && typeof i.required === 'boolean' && typeof i.detail === 'string'
      && !('fixTab' in i)));

  t('3 per-site rows', p.sites.length === 3);
  const [r1, r2, r3] = p.sites;
  t('s1 row: engine-priced ★ numbers', r1.site_id === 's1'
    && r1.star_model_id === 101 && r1.star_model_name === 'Hearthwood East CM'
    && r1.star_scenario_label === 'Baseline'
    && r1.y1_revenue === 5000000 && r1.y1_cost === 4200000 && r1.y1_margin_pct === 16
    && r1.sqft === 250000 && r1.revenue_source === 'cm-engine');
  t('s2 row: heuristic ★ (cost / (1 - margin))', r2.site_id === 's2'
    && r2.y1_revenue === 3068181.82 && r2.y1_cost === 2700000
    && r2.y1_margin_pct === 12 && r2.revenue_source === 'estimate');
  t('s3 row: ★-less site stays on record with null economics',
    r3.site_id === 's3' && r3.status === 'proposed' && r3.star_model_id === null
    && r3.y1_revenue === null && r3.y1_cost === null && r3.y1_margin_pct === null
    && r3.revenue_source === null);

  t('totals: Σ★ + est flags + coverage + grade/score',
    p.totals.y1_revenue === 8068181.82 && p.totals.y1_cost === 6900000
    && p.totals.y1_margin_pct === 14.5
    && p.totals.rollup_from_stars === true
    && p.totals.rollup_is_estimate === true      // s3 has no ★
    && p.totals.any_heuristic_star === true      // s2 is markup-priced
    && p.totals.bid_coverage.starred === 2 && p.totals.bid_coverage.active === 3
    && p.totals.grade === 'B' && p.totals.score === 78);

  t('exec_summary + manual_checks pass through from bidMeta',
    p.exec_summary === '' && p.manual_checks['commercial-review'] === true);
  t('strategy summary captured', p.strategy && p.strategy.value_prop === 'Win on flexibility');

  // Determinism — same inputs, byte-identical output (no clocks, no RNG).
  const again = buildBidSnapshotPayload({
    deal: DEAL, manifest: MANIFEST, rollup: ROLLUP, bidMeta: META,
    sites: SITES, models: MODELS, strategy: { value_prop: 'Win on flexibility' },
  });
  t('deterministic given inputs', JSON.stringify(again) === JSON.stringify(snap));
}

// Null-safety + legacy no-★ fallback.
{
  let threw = false, empty = null;
  try {
    empty = buildBidSnapshotPayload();
    buildBidSnapshotPayload({});
    buildBidSnapshotPayload({ deal: null, manifest: null, rollup: null, bidMeta: null, sites: null, models: null });
  } catch { threw = true; }
  t('all-null input never throws', !threw);
  t('empty input → pct 0, empty sites, schema still stamped',
    empty.manifest_pct === 0 && empty.payload.sites.length === 0
    && empty.payload.schema_version === 1 && empty.payload.strategy === null);

  const noStar = buildBidSnapshotPayload({
    sites: [{ id: 'x', name: 'X', status: 'proposed', inBidModelId: null }],
    models: [],
    rollup: { revenue: 1000000, margin: 20, rollupFromStars: false, rollupIsEstimate: false, anyHeuristicStar: false, bidCoverage: { starred: 0, active: 1 } },
  });
  t('no-★ deal falls back to legacy roll-up totals (cost derived)',
    noStar.y1_revenue === 1000000 && noStar.y1_margin_pct === 20
    && noStar.y1_cost === 800000
    && noStar.payload.totals.rollup_from_stars === false);
}

// Purity — the snapshot builder must never read a clock or RNG (timestamps
// are DB defaults so the payload stays deterministic).
{
  const src = read('./tools/deal-manager/calc.js');
  const start = src.indexOf('export function buildBidSnapshotPayload');
  t('buildBidSnapshotPayload exists in tools/deal-manager/calc.js', start > 0);
  const block = src.slice(start, src.indexOf('\n// ============', start));
  t('no Date.now / new Date / Math.random in the builder',
    !/Date\.now|new Date|Math\.random/.test(block));
}

// ============================================================
// 3. hub/deal-management/api.js source pins
// ============================================================
{
  const src = read('./hub/deal-management/api.js');

  const sb = src.slice(src.indexOf('export async function submitBid'),
                       src.indexOf('export async function listBidSnapshots'));
  t('submitBid exists', sb.length > 0);
  t('submitBid inserts into deal_bid_snapshots with canonical deal_id',
    /db\.insert\('deal_bid_snapshots',\s*\{\s*deal_id: dealId/.test(sb));
  t('submitBid audit uses enum action insert + descriptive op mark_submitted',
    /recordAudit\(\{ table: 'deal_bid_snapshots', id: row\?\.id, action: 'insert',\s*fields: \{ op: 'mark_submitted', deal_id: dealId, manifest_pct/.test(sb));
  t('submitBid requires a payload object',
    /snapshot payload required/.test(sb));

  const lbs = src.slice(src.indexOf('export async function listBidSnapshots'),
                        src.indexOf('export async function latestBidSnapshot'));
  t('listBidSnapshots newest-first', /\.order\('submitted_at', \{ ascending: false \}\)/.test(lbs));
  t('listBidSnapshots fail-soft []', /catch \(err\) \{[\s\S]*?return \[\];/.test(lbs));

  const lb = src.slice(src.indexOf('export async function latestBidSnapshot'),
                       src.indexOf('export default'));
  t('latestBidSnapshot limit(1) newest-first',
    /\.order\('submitted_at', \{ ascending: false \}\)\s*\.limit\(1\)/.test(lb));
  t('latestBidSnapshot single-or-null', /return \(data && data\[0\]\) \|\| null;/.test(lb));
  t('latestBidSnapshot fail-soft null', /catch \(err\) \{[\s\S]*?return null;/.test(lb));

  const rdo = src.slice(src.indexOf('export async function recordDealOutcome'),
                        src.indexOf('export async function getLatestDealOutcome'));
  t('recordDealOutcome reads the latest snapshot for prefill',
    /latestBidSnapshot\(dealId\)/.test(rdo));
  t('prefill precedence: snapshot fills ONLY null fields (explicit wins)',
    /if \(bidRev === null\) bidRev = num\(snap\.y1_revenue\);/.test(rdo)
    && /if \(bidCost === null\) bidCost = num\(snap\.y1_cost\);/.test(rdo)
    && /if \(bidMargin === null\) bidMargin = num\(snap\.y1_margin_pct\);/.test(rdo));
  t('outcome row links bid_snapshot_id', /bid_snapshot_id: bidSnapshotId,/.test(rdo));
  t('recordDealOutcome keeps its original audit shape',
    /recordAudit\(\{ table: 'deal_outcomes', id: row\?\.id, action: 'insert', fields: \{ op: 'record_outcome', deal_id: dealId, outcome: p\.outcome \} \}\)/.test(rdo));

  t('new fns exported on the default object',
    /submitBid, listBidSnapshots, latestBidSnapshot,\s*\};/.test(src));
}

// ============================================================
// 4. deal-fk map
// ============================================================
t('DEAL_FK maps deal_bid_snapshots → deal_id (canonical for NEW tables)',
  DEAL_FK.deal_bid_snapshots === 'deal_id' && DEAL_FK_CANONICAL === 'deal_id');

console.log(`\ntest-p2a-snapshot-engine: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

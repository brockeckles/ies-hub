// test-c3-search-honest.mjs — C3 UI-honesty pins (Wave C3, 2026-07-22)
//
// Pins three audit fixes via source scan (pure, no network, no DOM):
//   1. shared/search.js is HONEST + DYNAMIC: the docstring's "dynamic
//      Supabase" claim is backed by real deal_deals / deal_sites ilike
//      query paths, debounced, session-gated, routing to `deals?deal=<id>`.
//   2. hub/market-explorer no longer ships hardcoded deal-count literals —
//      counts derive live from deal_sites.market_id with an em-dash
//      fallback (never the old fabricated numbers).
//   3. Command Center ★ coverage chip reads as DEALS fully covered, not
//      sites.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + name); }
}

const searchSrc = readFileSync(new URL('./shared/search.js', import.meta.url), 'utf8');
const meCalcSrc = readFileSync(new URL('./hub/market-explorer/calc.js', import.meta.url), 'utf8');
const meApiSrc  = readFileSync(new URL('./hub/market-explorer/api.js', import.meta.url), 'utf8');
const meUiSrc   = readFileSync(new URL('./hub/market-explorer/ui.js', import.meta.url), 'utf8');
const ccUiSrc   = readFileSync(new URL('./hub/command-center/ui.js', import.meta.url), 'utf8');

// ── 1. Global search: docstring honesty + live query paths ──────────────
check('search: imports the shared supabase client', /from '\.\/supabase\.js\?v=/.test(searchSrc));
check('search: supabase pin matches repo standard (20260703-hw1)',
  searchSrc.includes("./supabase.js?v=20260703-hw1"));
check('search: queries deal_deals by name substring (ilike)',
  /from\('deal_deals'\)[\s\S]{0,200}\.ilike\('deal_name'/.test(searchSrc));
check('search: queries deal_sites by name substring (ilike)',
  /from\('deal_sites'\)[\s\S]{0,200}\.ilike\('name'/.test(searchSrc));
check('search: live lookups are limited (~8 each)',
  /LIVE_LIMIT\s*=\s*8/.test(searchSrc) && /\.limit\(LIVE_LIMIT\)/.test(searchSrc));
check('search: live lookups are debounced', /setTimeout\([\s\S]{0,80}LIVE_DEBOUNCE_MS\)/.test(searchSrc));
check('search: session-gated — no session skips live silently',
  /auth\.getSession\(\)/.test(searchSrc) && /if \(!sess \|\| !sess\.session\) return \[\]/.test(searchSrc));
check('search: deal results deep-link via deals?deal=<id>', searchSrc.includes('deals?deal=${encodeURIComponent('));
check('search: fail-soft — searchLive catch returns []', /catch \(err\) \{\s*\n\s*\/\/ Fail-soft[\s\S]{0,120}return \[\];/.test(searchSrc));
check('search: ilike pattern strips filter-breaking chars', /replace\(\/\[%_,\(\)\]\/g, ''\)/.test(searchSrc));
check('search: renders titles through escapeHtml', /_h\(r\.title\)/.test(searchSrc));

// Docstring honesty: if it claims dynamic/live Supabase search, the query
// code above must exist (checked), and the claim must be present — the old
// lie was claiming it without any dynamic path.
const docstring = searchSrc.slice(0, searchSrc.indexOf('*/'));
check('search docstring: claims live Deals + Sites (and code delivers)',
  /[Ll]ive|[Dd]ynamic/.test(docstring) && /Deals/.test(docstring) && /Sites/.test(docstring));
check('search docstring: documents fail-soft degradation', /[Ff]ail-soft/.test(docstring));

// ── 2. Market Explorer: hardcoded deal counts removed ───────────────────
check('ME calc: DEMO_MARKETS carries NO hardcoded activeDeals literals',
  !/activeDeals:\s*\d/.test(meCalcSrc));
check('ME ui/api: no hardcoded activeDeals literals anywhere',
  !/activeDeals:\s*\d/.test(meUiSrc) && !/activeDeals:\s*\d/.test(meApiSrc));
check('ME api: fetchDealCountsByMarket exists and reads deal_sites market_id',
  /export async function fetchDealCountsByMarket/.test(meApiSrc) &&
  /fetchAll\('deal_sites', 'id, deal_id, market_id'\)/.test(meApiSrc));
check('ME api: counts are distinct deals per market (Set)',
  /new Set\(\)/.test(meApiSrc) && /dealIds\.size/.test(meApiSrc));
check('ME api: session-gated — signed-out returns ok:false, not zeros',
  /getSession\(\)/.test(meApiSrc) && /return \{ ok: false, counts: \[\] \}/.test(meApiSrc));
check('ME ui: overlays live counts via fetchDealCountsByMarket',
  /api\.fetchDealCountsByMarket\(\)/.test(meUiSrc) && /_applyDealCounts/.test(meUiSrc));
check('ME ui: query failure falls back to em-dash, not numbers',
  meUiSrc.includes("m.activeDeals == null ? '—' : m.activeDeals"));
check('ME ui: Markets-with-Deals KPI gated on live counts',
  meUiSrc.includes("_dealCounts.ok ? String(stats.marketsWithDeals) : '—'"));
check('ME ui: LIVE banner no longer calls deal counts modeled',
  !meUiSrc.includes('and deal counts remain modeled estimates'));

// ── 3. Command Center ★ chip wording (deals, not sites) ─────────────────
check('CC: ★ chip says "deals fully covered"', ccUiSrc.includes('deals fully covered</span>'));
check('CC: old ambiguous "N/M covered" wording gone', !/\{Number\(cov\.total\)\} covered</.test(ccUiSrc));
check('CC: tooltip spells out the semantic',
  ccUiSrc.includes('title="Deals where every active site has a starred design"'));

console.log(`test-c3-search-honest: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

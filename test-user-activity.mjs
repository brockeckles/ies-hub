// test-user-activity.mjs — Slice 3.13 User Activity aggregation
//
// Pure-function tests for hub/admin/calc.js: summarizeUserActivity,
// activityKpis, humanRouteLabel, relativeAgo. No network, no DOM, no
// Supabase — the calc module does all the work, so the aggregation
// behavior is testable in isolation.
//
// Run: node test-user-activity.mjs

import * as calc from './hub/admin/calc.js';

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++; process.stdout.write('.');
  } catch (e) {
    fail++; process.stdout.write('F');
    failures.push({ name, err: e });
  }
}
const assert = (cond, msg = 'assertion failed') => { if (!cond) throw new Error(msg); };

// Fixtures ----------------------------------------------------------------
// Simulated "now" so relative-time assertions are stable across machines.
const NOW = Date.parse('2026-04-23T18:00:00Z');
const m = (min) => new Date(NOW - min * 60_000).toISOString();
const h = (hr)  => new Date(NOW - hr * 3_600_000).toISOString();
const d = (day) => new Date(NOW - day * 86_400_000).toISOString();

const profiles = [
  { id: 'u-brock',  email: 'brock@gxo.com',   display_name: 'Brock',       role: 'admin',  team_id: 'sd' },
  { id: 'u-sarah',  email: 'sarah@gxo.com',   display_name: 'Sarah',       role: 'member', team_id: 'sd' },
  { id: 'u-marcus', email: 'marcus@gxo.com',  display_name: 'Marcus',      role: 'member', team_id: 'sd' },
  { id: 'u-newbie', email: 'newbie@gxo.com',  display_name: 'Never Logged',role: 'member', team_id: 'sd' },
];

const events = [
  // Brock — active right now; 3 sessions, lots of page views
  { event: 'session_start', session_id: 's-b-3', route: 'overview',               user_id: 'u-brock',  created_at: m(3),  payload: {} },
  { event: 'page_view',     session_id: 's-b-3', route: 'designtools/cost-model', user_id: 'u-brock',  created_at: m(2),  payload: {} },
  { event: 'page_view',     session_id: 's-b-3', route: 'designtools/cost-model', user_id: 'u-brock',  created_at: m(1),  payload: {} },
  { event: 'session_start', session_id: 's-b-2', route: 'overview',               user_id: 'u-brock',  created_at: h(5),  payload: {} },
  { event: 'page_view',     session_id: 's-b-2', route: 'admin',                  user_id: 'u-brock',  created_at: h(5),  payload: {} },
  { event: 'session_end',   session_id: 's-b-2', route: 'admin',                  user_id: 'u-brock',  created_at: h(4),  payload: { duration_ms: 60 * 60_000 } }, // 60 min
  { event: 'session_start', session_id: 's-b-1', route: 'overview',               user_id: 'u-brock',  created_at: d(2),  payload: {} },
  { event: 'session_end',   session_id: 's-b-1', route: 'dealmanager',            user_id: 'u-brock',  created_at: d(2),  payload: { duration_ms: 30 * 60_000 } }, // 30 min
  // Sarah — logged in yesterday, one session
  { event: 'session_start', session_id: 's-s-1', route: 'overview',               user_id: 'u-sarah',  created_at: d(1),  payload: {} },
  { event: 'page_view',     session_id: 's-s-1', route: 'designtools/warehouse-sizing', user_id: 'u-sarah', created_at: d(1), payload: {} },
  { event: 'page_view',     session_id: 's-s-1', route: 'designtools/warehouse-sizing', user_id: 'u-sarah', created_at: d(1), payload: {} },
  { event: 'session_end',   session_id: 's-s-1', route: 'designtools/warehouse-sizing', user_id: 'u-sarah', created_at: d(1), payload: { duration_ms: 20 * 60_000 } }, // 20 min
  // Marcus — only an old (>7d) session → falls OUT of the default 7d window
  // (for this unit we still include it in fixtures to prove filtering by
  // caller is correct: summarize doesn't filter time itself, it only
  // aggregates what it's given — the API layer handles the gte() filter.)
  { event: 'session_start', session_id: 's-m-1', route: 'overview',               user_id: 'u-marcus', created_at: d(10), payload: {} },
  // Anonymous — someone hit the landing page pre-login
  { event: 'page_view',     session_id: 's-anon', route: 'overview',              user_id: null,       created_at: h(2),  payload: {} },
  { event: 'page_view',     session_id: 's-anon', route: 'overview',              user_id: null,       created_at: h(2),  payload: {} },
];

// ── summarizeUserActivity ───────────────────────────────────────────────
await test('per-user aggregation: Brock is online, 3 sessions, correct medians', async () => {
  const rows = calc.summarizeUserActivity(profiles, events, { now: NOW });
  const brock = rows.find(r => r.userId === 'u-brock');
  assert(brock, 'brock row must exist');
  assert(brock.onlineNow === true, 'brock should be online (last event 1 min ago)');
  assert(brock.sessionsInWindow === 3, `expected 3 sessions, got ${brock.sessionsInWindow}`);
  assert(brock.pageViewsInWindow === 3, `expected 3 page_views, got ${brock.pageViewsInWindow}`);
  // Two session_end payloads: 60 min and 30 min → median 45 min
  assert(brock.medianSessionMin === 45, `expected 45 min median, got ${brock.medianSessionMin}`);
  assert(brock.mostUsedRoute === 'designtools/cost-model', `expected cost-model most-used, got ${brock.mostUsedRoute}`);
});

await test('per-user aggregation: Sarah has one 20-min session', async () => {
  const rows = calc.summarizeUserActivity(profiles, events, { now: NOW });
  const s = rows.find(r => r.userId === 'u-sarah');
  assert(s.sessionsInWindow === 1, `expected 1 session, got ${s.sessionsInWindow}`);
  assert(s.pageViewsInWindow === 2, `expected 2 page_views, got ${s.pageViewsInWindow}`);
  assert(s.medianSessionMin === 20, `expected 20 min median, got ${s.medianSessionMin}`);
  assert(s.onlineNow === false, 'sarah should not be online (last event a day ago)');
});

await test('per-user aggregation: zero-events profile shows "never"', async () => {
  const rows = calc.summarizeUserActivity(profiles, events, { now: NOW });
  const nobody = rows.find(r => r.userId === 'u-newbie');
  assert(nobody, 'newbie row must exist');
  assert(nobody.lastLogin === null, 'lastLogin should be null for no-event user');
  assert(nobody.sessionsInWindow === 0, 'sessions should be 0');
  assert(nobody.onlineNow === false, 'should not be online');
});

await test('anonymous bucket appears when and only when null-user events exist', async () => {
  const rowsWithAnon = calc.summarizeUserActivity(profiles, events, { now: NOW });
  const anon = rowsWithAnon.find(r => r.userId === null);
  assert(anon, 'anon bucket must exist when null-user events present');
  assert(anon.pageViewsInWindow === 2, `expected 2 anon page_views, got ${anon.pageViewsInWindow}`);

  const attributedOnly = events.filter(e => e.user_id != null);
  const rowsNoAnon = calc.summarizeUserActivity(profiles, attributedOnly, { now: NOW });
  const anon2 = rowsNoAnon.find(r => r.userId === null);
  assert(!anon2, 'anon bucket should NOT appear when no null-user events');
});

await test('sort order: online pilots first, then by most recent activity', async () => {
  const rows = calc.summarizeUserActivity(profiles, events, { now: NOW });
  const realUsers = rows.filter(r => r.userId);
  assert(realUsers[0].userId === 'u-brock', 'Brock (online) should sort first');
  // Sarah (1d ago) beats Marcus (10d ago) beats newbie (never)
  const idxSarah = realUsers.findIndex(r => r.userId === 'u-sarah');
  const idxMarcus = realUsers.findIndex(r => r.userId === 'u-marcus');
  const idxNewbie = realUsers.findIndex(r => r.userId === 'u-newbie');
  assert(idxSarah < idxMarcus && idxMarcus < idxNewbie, `order must be brock→sarah→marcus→newbie; got ${realUsers.map(r => r.email).join(',')}`);
});

// ── activityKpis ────────────────────────────────────────────────────────
await test('activityKpis counts active window, online now, aggregate page views', async () => {
  const rows = calc.summarizeUserActivity(profiles, events, { now: NOW });
  const k = calc.activityKpis(rows);
  assert(k.totalPilots === 4, `expected 4 total pilots, got ${k.totalPilots}`);
  assert(k.activeWindow === 3, `expected 3 active (brock, sarah, marcus), got ${k.activeWindow}`);
  assert(k.onlineNow === 1, `expected 1 online, got ${k.onlineNow}`);
  assert(k.pageViews === 5, `expected 5 real-pilot page_views, got ${k.pageViews}`);
  // Median of medians: brock 45, sarah 20 → median 32.5
  assert(k.medianSessionMin === 32.5, `expected 32.5 min median-of-medians, got ${k.medianSessionMin}`);
});

await test('activityKpis handles empty input gracefully', async () => {
  const k = calc.activityKpis([]);
  assert(k.totalPilots === 0, 'empty → 0 total');
  assert(k.activeWindow === 0, 'empty → 0 active');
  assert(k.onlineNow === 0, 'empty → 0 online');
  assert(k.pageViews === 0, 'empty → 0 views');
  assert(k.medianSessionMin === null, 'empty → null median');
});

// ── humanRouteLabel ─────────────────────────────────────────────────────
await test('humanRouteLabel maps canonical routes and falls back for unknowns', async () => {
  assert(calc.humanRouteLabel('overview') === 'Home', 'overview → Home');
  assert(calc.humanRouteLabel('designtools/cost-model') === 'Cost Model Builder', 'cost-model full label');
  // Tab-suffix prefix match: should strip to the registered prefix
  assert(calc.humanRouteLabel('designtools/cost-model/p-l') === 'Cost Model Builder', 'prefix match on tab suffix');
  // Unknown route returns itself
  assert(calc.humanRouteLabel('no-such-route') === 'no-such-route', 'unknown → identity');
  assert(calc.humanRouteLabel('') === '—', 'empty → em-dash');
});

// ── relativeAgo ─────────────────────────────────────────────────────────
await test('relativeAgo formats across common ranges', async () => {
  assert(calc.relativeAgo(null) === '—', 'null → —');
  assert(calc.relativeAgo(m(0.5), NOW) === '30s ago', `30s: ${calc.relativeAgo(m(0.5), NOW)}`);
  assert(calc.relativeAgo(m(3), NOW) === '3m ago', '3m');
  assert(calc.relativeAgo(h(2), NOW) === '2h ago', '2h');
  assert(calc.relativeAgo(d(3), NOW) === '3d ago', '3d');
  // >7d → MM/DD
  const old = d(14);
  const out = calc.relativeAgo(old, NOW);
  assert(/^\d+\/\d+$/.test(out), `old format should be MM/DD, got ${out}`);
});

// ── Report ──────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name}\n    ${f.err.message}`);
}
console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

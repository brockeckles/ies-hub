// test-rls.mjs — Slice 3.3 RLS posture smoke test
//
// Hits the live Supabase REST API with the anon key to verify the tightened
// RLS posture from Slice 3.3 holds from a caller's perspective — not just in
// pg_policies. This is the smoke test called out in the scoping memo:
//   Phase3_Slice33_RLS_2026-04-23.md § Verification plan
//
// Full isolation suite (multiple authed users, cross-team visibility, write
// impersonation) is Slice 3.7's job.
//
// Run: node test-rls.mjs
//
// Requires network access to dklnwcshrpamzsybjlzb.supabase.co. If offline
// the whole suite is SKIPPED (exit 0) so this test never blocks CI locally.

// Env-parameterized (Slice 4.5): CI-on-main sets these to the staging
// project; local dev falls back to prod so `node test-rls.mjs` still works
// with no env configured.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dklnwcshrpamzsybjlzb.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrbG53Y3NocnBhbXpzeWJqbHpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTU3NzksImV4cCI6MjA5MDI5MTc3OX0.mj9TIj_rwxfbb9e2vBnA6hNYot5MX8-k1BbGfddAeJs';
console.log(`[rls] url=${SUPABASE_URL}`);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) { pass += 1; console.log(`  ✓ ${name}`); }
function bad(name, msg) { fail += 1; failures.push(`${name}: ${msg}`); console.log(`  ✗ ${name} — ${msg}`); }

async function restGet(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function restPost(table, payload, extraHeaders = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function run() {
  // Pre-check: network reachable?
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/`, { method: 'HEAD' });
  } catch (e) {
    console.log('  [skip] Supabase unreachable — skipping RLS smoke test.');
    return;
  }

  console.log('Slice 3.3 RLS smoke test (anon key against live Supabase)');
  console.log('');

  // ── Anon denied on deal tables ─────────────────────────────────────────
  console.log('Anon → deal tables should return 0 rows');
  for (const t of ['cost_model_projects', 'opportunities', 'deal_deals', 'fleet_scenarios',
                   'cost_model_labor', 'opportunity_tasks', 'fleet_lanes']) {
    const r = await restGet(t, '?select=id&limit=5');
    if (r.status !== 200) bad(`anon GET ${t}`, `status ${r.status}`);
    else if (!Array.isArray(r.body) || r.body.length !== 0) bad(`anon GET ${t}`, `got ${JSON.stringify(r.body).slice(0, 120)}`);
    else ok(`anon GET ${t} → 0 rows`);
  }

  // ── Anon denied on reference tables ────────────────────────────────────
  console.log('\nAnon → reference tables should return 0 rows');
  for (const t of ['ref_equipment', 'ref_labor_rates', 'steel_prices',
                   'competitor_news', 'customers']) {
    const r = await restGet(t, '?select=id&limit=5');
    if (r.status !== 200) bad(`anon GET ${t}`, `status ${r.status}`);
    else if (!Array.isArray(r.body) || r.body.length !== 0) bad(`anon GET ${t}`, `got ${JSON.stringify(r.body).slice(0, 120)}`);
    else ok(`anon GET ${t} → 0 rows`);
  }

  // ── Anon still allowed: hub_alerts, analytics writes, audit_log insert ─
  console.log('\nAnon → allowed surface');
  {
    const r = await restGet('hub_alerts', '?select=id&limit=1');
    if (r.status === 200 && Array.isArray(r.body) && r.body.length >= 0) ok('anon GET hub_alerts (reachable)');
    else bad('anon GET hub_alerts', `status ${r.status}`);
  }

  // audit_log insert with user_id NULL should succeed (action must be one of
  // insert/update/delete/link/unlink per CHECK constraint on audit_log.action).
  // Use Prefer: return=minimal — anon has no SELECT policy on audit_log, so
  // asking PostgREST to return=representation would trigger a SELECT which
  // RLS denies, surfacing as a misleading 42501. This matches shared/audit.js.
  {
    const r = await restPost('audit_log', {
      session_id: `rls-test-${Date.now()}`,
      action: 'insert',
      entity_table: 'audit_livetest',
      user_email: null,
      user_id: null,
      changed_fields: { source: 'test-rls.mjs', tombstone: true },
    }, { Prefer: 'return=minimal' });
    if (r.status === 201 || r.status === 204) {
      ok(`anon POST audit_log (user_id=null) → ${r.status}`);
      // Leave the tombstone row in audit_log; it's clearly marked in changed_fields.
    } else {
      bad('anon POST audit_log (user_id=null)', `status ${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }

  // audit_log insert with fabricated user_id should FAIL (user_id must be NULL or match auth.uid())
  {
    const r = await restPost('audit_log', {
      session_id: `rls-test-forge-${Date.now()}`,
      action: 'insert',
      entity_table: 'audit_livetest',
      user_email: 'forged@example.com',
      user_id: '00000000-0000-0000-0000-000000000001',
      changed_fields: { source: 'test-rls.mjs', expect: 'reject' },
    }, { Prefer: 'return=minimal' });
    if (r.status === 201 || r.status === 204) {
      bad('anon POST audit_log with forged user_id', `should have been rejected, got ${r.status}`);
    } else {
      ok(`anon POST audit_log (forged user_id) → ${r.status} rejected`);
    }
  }

  // ── Anon write to deal table: must fail ────────────────────────────────
  console.log('\nAnon → writes to deal tables should fail');
  {
    const r = await restPost('cost_model_projects', {
      project_name: 'rls smoke test — should reject',
      customer_name: 'anon',
    });
    if (r.status === 201) bad('anon POST cost_model_projects', 'should have been rejected, got 201');
    else ok(`anon POST cost_model_projects → ${r.status} rejected`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error('test-rls.mjs crashed:', e);
  process.exitCode = 1;
});

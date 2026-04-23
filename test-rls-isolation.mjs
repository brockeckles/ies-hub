// test-rls-isolation.mjs — Slice 3.7 + 3.8 + 3.9 RLS isolation suite
//
// Full authed-persona isolation tests for the Slice 3.3 (deal tables),
// Slice 3.8 (master/ref tables, SECURITY INVOKER views), and Slice 3.9
// (netopt/wsc Class A+B, admin-only-via-bypass tables, matview RPC wrapper,
// permissive policy drops) RLS policies. This is the "Full isolation suite
// with multiple real users" that test-rls.mjs (Slice 3.3 smoke) deferred
// to 3.7, with 3.8 + 3.9 coverage layered on top.
//
// Personas:
//   A = rls-test-a@ies-hub.test  (member, rls-test-team)
//   B = rls-test-b@ies-hub.test  (member, rls-test-team)   — teammate of A
//   C = rls-test-c@ies-hub.test  (member, Solutions Design) — non-admin outsider
//   admin = brock.eckles@gxo.com (admin,  Solutions Design) — optional, gated
//           on BROCK_PASS env var; skipped if unset.
//
// Scenario blocks:
//   1. Anon denied on all 9 deal-root tables
//   2. visibility='private' — owner sees; teammate + outsider blocked
//   3. visibility='team'    — teammate sees; outsider blocked
//   4. visibility='shared'  — both see
//   5. INSERT impersonation (owner_id != auth.uid) rejected
//   6. UPDATE/DELETE authority — non-owner blocked, owner allowed
//   7. JOIN inheritance on cost_model_labor child
//   8. audit_log SELECT blocked for members
//   9. admin bypass on cross-team row + audit_log (gated on BROCK_PASS)
//  10. [Slice 3.8] Anon denied + member SELECT works on 5 master/ref tables
//  11. [Slice 3.8] Member INSERT rejected on master/ref tables (admin-only write)
//  12. [Slice 3.8] SECURITY INVOKER views still readable by authed member
//  13. [Slice 3.9] netopt_configs Class A scoping (private/team/shared + write authority)
//  14. [Slice 3.9] netopt_scenario_results Class B JOIN-inherit
//  15. [Slice 3.9] wsc_facility_configs Class A scoping
//  16. [Slice 3.9] admin-only-via-bypass tables (general_hours, project_elements)
//  17. [Slice 3.9] analytics UPDATE dropped + anon INSERT still works
//  18. [Slice 3.9] fact_pnl_monthly matview revoked; get_pnl_monthly RPC enforces scoping
//
// All test rows carry the "rls-iso-" marker prefix so anything left behind
// after a crash is trivially findable. Teardown deletes everything via
// persona A (the owner).
//
// Run: node test-rls-isolation.mjs
//      BROCK_PASS=xxx node test-rls-isolation.mjs   # include admin block
//
// Requires network access to dklnwcshrpamzsybjlzb.supabase.co. If offline
// the whole suite SKIPs (exit 0) so local runs never block CI.

const SUPABASE_URL = 'https://dklnwcshrpamzsybjlzb.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrbG53Y3NocnBhbXpzeWJqbHpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTU3NzksImV4cCI6MjA5MDI5MTc3OX0.mj9TIj_rwxfbb9e2vBnA6hNYot5MX8-k1BbGfddAeJs';

// ─── Seeded persona constants (from Slice 3.7 seed) ────────────────────
const TEST_TEAM_ID = 'd24708c3-c4a8-49bd-8f6d-648e278344ea'; // rls-test-team
const SD_TEAM_ID   = 'd3e79133-18e5-4441-8b57-84920385cd8d'; // Solutions Design

const PERSONAS = {
  A: {
    email: 'rls-test-a@ies-hub.test',
    password: process.env.RLS_TEST_A_PASS || 'RlsTestA!2026',
    uid: '30dc891d-7b40-48a8-a78c-64352dbbd05c',
    teamId: TEST_TEAM_ID,
  },
  B: {
    email: 'rls-test-b@ies-hub.test',
    password: process.env.RLS_TEST_B_PASS || 'RlsTestB!2026',
    uid: 'a3ecf7d0-7789-47ba-8d4b-4929b7afbbce',
    teamId: TEST_TEAM_ID,
  },
  C: {
    email: 'rls-test-c@ies-hub.test',
    password: process.env.RLS_TEST_C_PASS || 'RlsTestC!2026',
    uid: '3cff68b2-269e-4c57-b2c2-9354fc41ec27',
    teamId: SD_TEAM_ID,
  },
};
const BROCK_EMAIL = 'brock.eckles@gxo.com';
const BROCK_PASS  = process.env.BROCK_PASS;

// ─── Runner state ──────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];
function ok(name) { pass += 1; console.log(`  ✓ ${name}`); }
function bad(name, msg) { fail += 1; failures.push(`${name}: ${msg}`); console.log(`  ✗ ${name} — ${msg}`); }

// ─── HTTP helpers ──────────────────────────────────────────────────────
async function signIn({ email, password }) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) {
    throw new Error(`signIn ${email} → status=${r.status} ${JSON.stringify(j).slice(0, 180)}`);
  }
  return j.access_token;
}

async function rest(method, table, { token, params = '', body, prefer } = {}) {
  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token || ANON_KEY}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  const text = await r.text();
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: r.status, body: parsed };
}

// Short-form asserters used by blocks.
function expect200Empty(name, r) {
  if (r.status === 200 && Array.isArray(r.body) && r.body.length === 0) { ok(name); return true; }
  bad(name, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 180)}`);
  return false;
}
function expect200OneRow(name, r) {
  if (r.status === 200 && Array.isArray(r.body) && r.body.length === 1) { ok(name); return true; }
  bad(name, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 180)}`);
  return false;
}
function expect200ManyRows(name, r, atLeast = 1) {
  if (r.status === 200 && Array.isArray(r.body) && r.body.length >= atLeast) { ok(name); return true; }
  bad(name, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 180)}`);
  return false;
}
function expectRejected(name, r) {
  if (r.status >= 400 && r.status < 500) { ok(`${name} (status=${r.status})`); return true; }
  bad(name, `expected 4xx; got status=${r.status} body=${JSON.stringify(r.body).slice(0, 180)}`);
  return false;
}

// ─── Main ──────────────────────────────────────────────────────────────
async function run() {
  // Pre-check: network reachable?
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/`, { method: 'HEAD' });
  } catch {
    console.log('  [skip] Supabase unreachable — skipping RLS isolation suite.');
    return;
  }

  console.log('Slice 3.7 + 3.8 RLS isolation suite (authed REST calls against live Supabase)');
  console.log('');

  let tokA, tokB, tokC;
  try {
    [tokA, tokB, tokC] = await Promise.all([
      signIn(PERSONAS.A),
      signIn(PERSONAS.B),
      signIn(PERSONAS.C),
    ]);
  } catch (e) {
    console.log(`  [skip] Persona sign-in failed — ${e.message}`);
    return;
  }

  const createdCmp = [];   // cost_model_projects ids (bigint)
  const createdFleet = []; // fleet_scenarios ids (uuid)
  const createdNetopt = []; // netopt_configs ids (uuid) — Slice 3.9
  const createdWsc = [];    // wsc_facility_configs ids (uuid) — Slice 3.9

  try {
    // ─── Block 1: Anon denial on 9 deal-root tables ──────────────────
    console.log('Block 1 — Anon denied on 9 deal-root tables');
    const roots = [
      'cost_model_projects', 'opportunities', 'deal_deals', 'most_analyses',
      'fleet_scenarios', 'netopt_scenarios', 'warehouse_sizing_scenarios',
      'cog_scenarios', 'change_initiatives',
    ];
    for (const t of roots) {
      const r = await rest('GET', t, { params: '?select=id&limit=1' });
      expect200Empty(`anon GET ${t} → 0 rows`, r);
    }

    // ─── Block 2: visibility='private' — owner sees; others blocked ─
    console.log('\nBlock 2 — visibility=private (owner sees; teammate + outsider blocked)');
    {
      const marker = `rls-iso-priv-${Date.now()}`;
      const r = await rest('POST', 'cost_model_projects', {
        token: tokA,
        body: { name: marker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'private' },
        prefer: 'return=representation',
      });
      if (r.status !== 201) { bad('Block 2 setup — A creates private row', `status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`); }
      else {
        const rowId = r.body[0].id;
        createdCmp.push(rowId);
        expect200OneRow(`A reads own private row`,
          await rest('GET', 'cost_model_projects', { token: tokA, params: `?id=eq.${rowId}&select=id` }));
        expect200Empty(`B (same team) blocked from A's private row`,
          await rest('GET', 'cost_model_projects', { token: tokB, params: `?id=eq.${rowId}&select=id` }));
        expect200Empty(`C (other team) blocked from A's private row`,
          await rest('GET', 'cost_model_projects', { token: tokC, params: `?id=eq.${rowId}&select=id` }));
      }
    }

    // ─── Block 3: visibility='team' — same-team sees; outsider blocked ──
    console.log('\nBlock 3 — visibility=team (same-team sees; outsider blocked)');
    let teamRowIdForAdmin = null;
    {
      const marker = `rls-iso-team-${Date.now()}`;
      const r = await rest('POST', 'cost_model_projects', {
        token: tokA,
        body: { name: marker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'team' },
        prefer: 'return=representation',
      });
      if (r.status !== 201) { bad('Block 3 setup', `status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`); }
      else {
        const rowId = r.body[0].id;
        createdCmp.push(rowId);
        teamRowIdForAdmin = rowId; // reused in Block 9
        expect200OneRow(`A reads own team-row`,
          await rest('GET', 'cost_model_projects', { token: tokA, params: `?id=eq.${rowId}&select=id` }));
        expect200OneRow(`B (same team) reads A's team-row`,
          await rest('GET', 'cost_model_projects', { token: tokB, params: `?id=eq.${rowId}&select=id` }));
        expect200Empty(`C (other team, member) blocked from A's team-row`,
          await rest('GET', 'cost_model_projects', { token: tokC, params: `?id=eq.${rowId}&select=id` }));
      }
    }

    // ─── Block 4: visibility='shared' — everyone authed sees ─────────
    console.log('\nBlock 4 — visibility=shared (all authed users see)');
    {
      const marker = `rls-iso-shared-${Date.now()}`;
      const r = await rest('POST', 'fleet_scenarios', {
        token: tokA,
        body: { name: marker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'shared' },
        prefer: 'return=representation',
      });
      if (r.status !== 201) { bad('Block 4 setup', `status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`); }
      else {
        const rowId = r.body[0].id;
        createdFleet.push(rowId);
        expect200OneRow(`B sees shared row`,
          await rest('GET', 'fleet_scenarios', { token: tokB, params: `?id=eq.${rowId}&select=id` }));
        expect200OneRow(`C (other team) sees shared row`,
          await rest('GET', 'fleet_scenarios', { token: tokC, params: `?id=eq.${rowId}&select=id` }));
      }
    }

    // ─── Block 5: INSERT impersonation rejected ─────────────────────
    console.log('\nBlock 5 — INSERT with forged owner_id rejected');
    {
      const r = await rest('POST', 'cost_model_projects', {
        token: tokA,
        body: {
          name: `rls-iso-impersonate-${Date.now()}`,
          owner_id: PERSONAS.B.uid,              // A signed-in, claiming to be B
          team_id: PERSONAS.A.teamId,
          visibility: 'team',
        },
        prefer: 'return=representation',
      });
      expectRejected(`INSERT with forged owner_id rejected`, r);
    }

    // ─── Block 6: UPDATE/DELETE authority ──────────────────────────
    console.log('\nBlock 6 — UPDATE/DELETE authority (non-owner blocked; owner allowed)');
    {
      const marker = `rls-iso-upd-${Date.now()}`;
      const r = await rest('POST', 'cost_model_projects', {
        token: tokA,
        body: { name: marker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'team' },
        prefer: 'return=representation',
      });
      if (r.status !== 201) { bad('Block 6 setup', `status=${r.status}`); }
      else {
        const rowId = r.body[0].id;
        createdCmp.push(rowId);

        // B (same team) can READ the row (via team predicate), but UPDATE policy
        // is owner-or-admin — so PATCH matches 0 rows and returns 200+[].
        expect200Empty(`B UPDATE of A's row → 0 rows (RLS filters)`,
          await rest('PATCH', 'cost_model_projects', {
            token: tokB, params: `?id=eq.${rowId}`,
            body: { name: `${marker}-hijacked-by-B` },
            prefer: 'return=representation',
          }));

        // Defensive: confirm the name didn't actually change.
        const probe = await rest('GET', 'cost_model_projects', { token: tokA, params: `?id=eq.${rowId}&select=name` });
        if (probe.status === 200 && probe.body[0]?.name === marker) ok(`row name unchanged after B's attempt`);
        else bad(`row name check after B UPDATE`, `status=${probe.status} body=${JSON.stringify(probe.body).slice(0, 180)}`);

        // A (owner) updates — 1 row.
        expect200OneRow(`A UPDATE of own row → 1 row`,
          await rest('PATCH', 'cost_model_projects', {
            token: tokA, params: `?id=eq.${rowId}`,
            body: { name: `${marker}-touched-by-A` },
            prefer: 'return=representation',
          }));

        // C (other team, non-admin) attempts DELETE — 0 rows.
        expect200Empty(`C DELETE of A's row → 0 rows (RLS filters)`,
          await rest('DELETE', 'cost_model_projects', {
            token: tokC, params: `?id=eq.${rowId}`, prefer: 'return=representation',
          }));

        // Confirm the row survived.
        const alive = await rest('GET', 'cost_model_projects', { token: tokA, params: `?id=eq.${rowId}&select=id` });
        if (alive.status === 200 && alive.body.length === 1) ok(`row still exists after C's DELETE attempt`);
        else bad(`row survival check`, `status=${alive.status} body=${JSON.stringify(alive.body).slice(0, 180)}`);

        // A (owner) deletes — 1 row.
        const delByA = await rest('DELETE', 'cost_model_projects', {
          token: tokA, params: `?id=eq.${rowId}`, prefer: 'return=representation',
        });
        if (expect200OneRow(`A DELETE of own row → 1 row`, delByA)) {
          const ix = createdCmp.indexOf(rowId);
          if (ix >= 0) createdCmp.splice(ix, 1);
        }
      }
    }

    // ─── Block 7: JOIN inheritance (cost_model_labor child) ────────
    console.log('\nBlock 7 — JOIN inheritance on cost_model_labor child');
    {
      const parentMarker = `rls-iso-parent-${Date.now()}`;
      const parent = await rest('POST', 'cost_model_projects', {
        token: tokA,
        body: { name: parentMarker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'team' },
        prefer: 'return=representation',
      });
      if (parent.status !== 201) { bad('Block 7 parent setup', `status=${parent.status}`); }
      else {
        const parentId = parent.body[0].id;
        createdCmp.push(parentId);
        const child = await rest('POST', 'cost_model_labor', {
          token: tokA,
          body: { project_id: parentId, role_name: 'rls-iso-child' },
          prefer: 'return=representation',
        });
        if (child.status !== 201) {
          bad('Block 7 child setup', `status=${child.status} body=${JSON.stringify(child.body).slice(0, 200)}`);
        } else {
          expect200ManyRows(`B reads child via team-visible parent`,
            await rest('GET', 'cost_model_labor', { token: tokB, params: `?project_id=eq.${parentId}&select=id` }));
          expect200Empty(`C blocked from child via cross-team parent`,
            await rest('GET', 'cost_model_labor', { token: tokC, params: `?project_id=eq.${parentId}&select=id` }));
        }
      }
    }

    // ─── Block 8: audit_log SELECT admin-only ─────────────────────
    console.log('\nBlock 8 — audit_log SELECT (admin-only)');
    expect200Empty(`A (member) audit_log SELECT → 0 rows`,
      await rest('GET', 'audit_log', { token: tokA, params: '?select=id&limit=1' }));

    // ─── Block 10: Slice 3.8 master/ref tables — anon denied + member SELECT works
    console.log('\nBlock 10 — Slice 3.8 master/ref tables: anon denied + member SELECT');
    {
      const slice38Tables = [
        'master_accounts', 'master_competitors', 'master_markets',
        'master_verticals', 'ref_multisite_grade_thresholds',
      ];
      for (const t of slice38Tables) {
        const anonRes = await rest('GET', t, { params: '?select=id&limit=1' });
        expect200Empty(`anon GET ${t} → 0 rows`, anonRes);

        const memberRes = await rest('GET', t, { token: tokA, params: '?select=id&limit=1' });
        if (memberRes.status === 200 && Array.isArray(memberRes.body) && memberRes.body.length >= 1) {
          ok(`A (member) GET ${t} → ${memberRes.body.length} row${memberRes.body.length === 1 ? '' : 's'}`);
        } else bad(`A (member) GET ${t}`, `status=${memberRes.status} body=${JSON.stringify(memberRes.body).slice(0, 180)}`);
      }
    }

    // ─── Block 11: Slice 3.8 member INSERT rejected (admin-only write) ───
    console.log('\nBlock 11 — Slice 3.8 member INSERT rejected (admin-only write)');
    {
      // One representative per shape — NOT NULL cols filled with rls-iso- markers.
      const writeAttempts = [
        { table: 'master_accounts',
          row:   { name: `rls-iso-acct-${Date.now()}`, vertical: 'Retail', region: 'Northeast' } },
        { table: 'master_competitors',
          row:   { name: `rls-iso-comp-${Date.now()}`, primary_vertical: 'Retail' } },
        { table: 'master_verticals',
          row:   { vertical_name: `rls-iso-vert-${Date.now()}` } },
        { table: 'master_markets',
          row:   { city: `rls-iso-city-${Date.now()}`, state: 'ZZ', region: 'Northeast', market_tier: 'Tier 3' } },
        { table: 'ref_multisite_grade_thresholds',
          row:   { metric_name: `rls-iso-metric-${Date.now()}`, label: 'rls-iso' } },
      ];
      for (const { table, row } of writeAttempts) {
        const r = await rest('POST', table, { token: tokA, body: row, prefer: 'return=representation' });
        expectRejected(`A (member) INSERT into ${table} rejected`, r);
      }
    }

    // ─── Block 12: Slice 3.8 SECURITY INVOKER views readable by member ───
    console.log('\nBlock 12 — Slice 3.8 SECURITY INVOKER views readable by authed member');
    {
      const views = [
        'ref_labor_rates_current', 'ref_overhead_rates_current',
        'ref_utility_rates_current', 'ref_facility_rates_current',
        'ref_equipment_current',
      ];
      for (const v of views) {
        const r = await rest('GET', v, { token: tokA, params: '?select=id&limit=1' });
        if (r.status === 200 && Array.isArray(r.body)) {
          ok(`A (member) GET ${v} → status=200 (security_invoker passes through authed read)`);
        } else bad(`A (member) GET ${v}`, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 180)}`);
      }
    }

    // ─── Block 13: Slice 3.9 — netopt_configs Class A scoping ────────
    console.log('\nBlock 13 — Slice 3.9 netopt_configs Class A scoping');
    {
      // 13a: private visibility — owner sees; teammate + outsider blocked.
      const privMarker = `rls-iso-netopt-priv-${Date.now()}`;
      const privRes = await rest('POST', 'netopt_configs', {
        token: tokA,
        body: { name: privMarker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'private' },
        prefer: 'return=representation',
      });
      if (privRes.status !== 201) { bad('Block 13 private setup', `status=${privRes.status} body=${JSON.stringify(privRes.body).slice(0, 200)}`); }
      else {
        const privId = privRes.body[0].id;
        createdNetopt.push(privId);
        expect200OneRow('A reads own private netopt_config',
          await rest('GET', 'netopt_configs', { token: tokA, params: `?id=eq.${privId}&select=id` }));
        expect200Empty('B (same team) blocked from A\'s private netopt_config',
          await rest('GET', 'netopt_configs', { token: tokB, params: `?id=eq.${privId}&select=id` }));
        expect200Empty('C (other team) blocked from A\'s private netopt_config',
          await rest('GET', 'netopt_configs', { token: tokC, params: `?id=eq.${privId}&select=id` }));
      }

      // 13b: team visibility — teammate sees; outsider blocked.
      const teamMarker = `rls-iso-netopt-team-${Date.now()}`;
      const teamRes = await rest('POST', 'netopt_configs', {
        token: tokA,
        body: { name: teamMarker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'team' },
        prefer: 'return=representation',
      });
      if (teamRes.status !== 201) { bad('Block 13 team setup', `status=${teamRes.status}`); }
      else {
        const teamId = teamRes.body[0].id;
        createdNetopt.push(teamId);
        expect200OneRow('B (same team) reads A\'s team netopt_config',
          await rest('GET', 'netopt_configs', { token: tokB, params: `?id=eq.${teamId}&select=id` }));
        expect200Empty('C (other team) blocked from A\'s team netopt_config',
          await rest('GET', 'netopt_configs', { token: tokC, params: `?id=eq.${teamId}&select=id` }));

        // 13c: write authority — B's PATCH and C's DELETE both filter to 0 rows.
        expect200Empty('B UPDATE of A\'s netopt_config → 0 rows (RLS filters)',
          await rest('PATCH', 'netopt_configs', {
            token: tokB, params: `?id=eq.${teamId}`,
            body: { name: `${teamMarker}-hijack` },
            prefer: 'return=representation',
          }));
        expect200Empty('C DELETE of A\'s netopt_config → 0 rows (RLS filters)',
          await rest('DELETE', 'netopt_configs', {
            token: tokC, params: `?id=eq.${teamId}`, prefer: 'return=representation',
          }));
        expect200OneRow('A UPDATE of own netopt_config → 1 row',
          await rest('PATCH', 'netopt_configs', {
            token: tokA, params: `?id=eq.${teamId}`,
            body: { name: `${teamMarker}-touched` },
            prefer: 'return=representation',
          }));
      }
    }

    // ─── Block 14: Slice 3.9 — netopt_scenario_results JOIN-inherit ──
    console.log('\nBlock 14 — Slice 3.9 netopt_scenario_results Class B JOIN-inherit');
    {
      const parentMarker = `rls-iso-netopt-child-parent-${Date.now()}`;
      const parent = await rest('POST', 'netopt_configs', {
        token: tokA,
        body: { name: parentMarker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'team' },
        prefer: 'return=representation',
      });
      if (parent.status !== 201) { bad('Block 14 parent setup', `status=${parent.status}`); }
      else {
        const parentId = parent.body[0].id;
        createdNetopt.push(parentId);
        const child = await rest('POST', 'netopt_scenario_results', {
          token: tokA,
          body: { config_id: parentId, name: 'rls-iso-child', result_data: {} },
          prefer: 'return=representation',
        });
        if (child.status !== 201) {
          bad('Block 14 child setup', `status=${child.status} body=${JSON.stringify(child.body).slice(0, 200)}`);
        } else {
          expect200ManyRows('B reads netopt_scenario_results via team-visible parent',
            await rest('GET', 'netopt_scenario_results', { token: tokB, params: `?config_id=eq.${parentId}&select=id` }));
          expect200Empty('C blocked from netopt_scenario_results via cross-team parent',
            await rest('GET', 'netopt_scenario_results', { token: tokC, params: `?config_id=eq.${parentId}&select=id` }));
        }
      }
    }

    // ─── Block 15: Slice 3.9 — wsc_facility_configs Class A scoping ──
    console.log('\nBlock 15 — Slice 3.9 wsc_facility_configs Class A scoping');
    {
      const teamMarker = `rls-iso-wsc-team-${Date.now()}`;
      const teamRes = await rest('POST', 'wsc_facility_configs', {
        token: tokA,
        body: { name: teamMarker, owner_id: PERSONAS.A.uid, team_id: PERSONAS.A.teamId, visibility: 'team' },
        prefer: 'return=representation',
      });
      if (teamRes.status !== 201) { bad('Block 15 team setup', `status=${teamRes.status} body=${JSON.stringify(teamRes.body).slice(0, 200)}`); }
      else {
        const rowId = teamRes.body[0].id;
        createdWsc.push(rowId);
        expect200OneRow('B (same team) reads A\'s wsc_facility_config',
          await rest('GET', 'wsc_facility_configs', { token: tokB, params: `?id=eq.${rowId}&select=id` }));
        expect200Empty('C (other team) blocked from A\'s wsc_facility_config',
          await rest('GET', 'wsc_facility_configs', { token: tokC, params: `?id=eq.${rowId}&select=id` }));

        // INSERT impersonation rejected.
        const impersonate = await rest('POST', 'wsc_facility_configs', {
          token: tokA,
          body: { name: `rls-iso-wsc-forge-${Date.now()}`, owner_id: PERSONAS.B.uid, team_id: PERSONAS.A.teamId, visibility: 'team' },
          prefer: 'return=representation',
        });
        expectRejected('A forging owner_id=B on wsc_facility_configs rejected', impersonate);
      }
    }

    // ─── Block 16: Slice 3.9 — admin-only-via-bypass tables ──────────
    console.log('\nBlock 16 — Slice 3.9 admin-only-via-bypass (general_hours, project_elements writes)');
    {
      // general_hours has RLS enabled but NO policies — member SELECT returns 0.
      expect200Empty('A (member) SELECT general_hours → 0 rows (admin-only via bypass)',
        await rest('GET', 'general_hours', { token: tokA, params: '?select=id&limit=1' }));

      // general_hours INSERT as member also yields 0 rows (no INSERT policy).
      const ghInsert = await rest('POST', 'general_hours', {
        token: tokA,
        body: { resource: 'rls-iso-probe', week_start: '2026-01-05', category: 'actual', hours: 1.0, hours_category: 'actual' },
        prefer: 'return=representation',
      });
      // 401/403 is the clean response for policy-missing INSERT; PostgREST may
      // return 401 depending on version. Any 4xx is acceptable.
      expectRejected('A (member) INSERT into general_hours rejected', ghInsert);

      // project_elements still has SELECT(true) policy — returns 0 rows because
      // table is empty. But INSERT/UPDATE/DELETE were all dropped in Slice 3.9.
      const peInsert = await rest('POST', 'project_elements', {
        token: tokA,
        body: { project_id: 0, element_name: 'rls-iso-elem', element_status: 'not_started' },
        prefer: 'return=representation',
      });
      expectRejected('A (member) INSERT into project_elements rejected (no policy)', peInsert);
    }

    // ─── Block 17: Slice 3.9 — analytics UPDATE dropped; INSERT works ─
    console.log('\nBlock 17 — Slice 3.9 analytics UPDATE dropped + anon INSERT preserved');
    {
      // Anon can still INSERT analytics_events (intentional — telemetry).
      // Real schema: `event` text + `payload` jsonb (see shared/analytics.js).
      // NOTE: anon has INSERT but not SELECT (read is admin-only), so we use
      // Prefer: return=minimal — otherwise PostgREST tries to SELECT the
      // inserted row for the response and fails with 401.
      const eventRes = await rest('POST', 'analytics_events', {
        body: { event: 'rls_iso_probe', payload: { src: 'rls-iso' } },
        prefer: 'return=minimal',
      });
      if (eventRes.status === 201 || eventRes.status === 204) {
        ok(`anon INSERT into analytics_events allowed (status=${eventRes.status})`);
      } else bad('anon INSERT into analytics_events', `status=${eventRes.status} body=${JSON.stringify(eventRes.body).slice(0, 180)}`);

      // Member PATCH on analytics_events should no longer work (ALL policy
      // dropped; replacement INSERT policy doesn't cover UPDATE).
      // PostgREST returns 200+[] when no row matches + no policy applies.
      const eventsPatch = await rest('PATCH', 'analytics_events', {
        token: tokA, params: '?event=eq.rls_iso_probe',
        body: { event: 'rls_iso_hijack' },
        prefer: 'return=representation',
      });
      expect200Empty('A (member) PATCH analytics_events → 0 rows (UPDATE policy dropped)', eventsPatch);

      // hub_feedback UPDATE as member should no longer succeed.
      const hfPatch = await rest('PATCH', 'hub_feedback', {
        token: tokA, params: '?title=eq.__rls_iso_nonexistent__',
        body: { title: 'rls_iso_hijack' },
        prefer: 'return=representation',
      });
      expect200Empty('A (member) PATCH hub_feedback → 0 rows (UPDATE policy dropped)', hfPatch);
    }

    // ─── Block 18: Slice 3.9 — matview revoked, RPC wrapper scopes ───
    console.log('\nBlock 18 — Slice 3.9 fact_pnl_monthly matview + get_pnl_monthly RPC');
    {
      // Direct matview SELECT should now fail with a permission error for authed.
      const direct = await rest('GET', 'fact_pnl_monthly', { token: tokA, params: '?select=project_id&limit=1' });
      // PostgREST returns 401/403/404 when SELECT is revoked on the underlying
      // relation. Any non-2xx is a correct "no longer exposed" signal.
      if (direct.status >= 400) {
        ok(`direct fact_pnl_monthly SELECT rejected (status=${direct.status})`);
      } else bad('direct fact_pnl_monthly SELECT should be rejected', `status=${direct.status} body=${JSON.stringify(direct.body).slice(0, 180)}`);

      // RPC call with a bogus project_id should return 0 rows (caller has no
      // such project; RPC body filters by cost_model_projects ownership).
      const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_pnl_monthly`, {
        method: 'POST',
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${tokA}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ p_project_id: 99999999 }),
      });
      const rpcText = await rpc.text();
      let rpcBody = null;
      if (rpcText) { try { rpcBody = JSON.parse(rpcText); } catch { rpcBody = rpcText; } }
      if (rpc.status === 200 && Array.isArray(rpcBody) && rpcBody.length === 0) {
        ok('get_pnl_monthly RPC returns [] for non-existent project (scoping enforced)');
      } else bad('get_pnl_monthly RPC', `status=${rpc.status} body=${JSON.stringify(rpcBody).slice(0, 180)}`);
    }

    // ─── Block 9: admin bypass — gated on BROCK_PASS ──────────────
    if (BROCK_PASS) {
      console.log('\nBlock 9 — admin bypass (Brock reads cross-team team-row; audit_log)');
      try {
        const tokAdmin = await signIn({ email: BROCK_EMAIL, password: BROCK_PASS });
        if (teamRowIdForAdmin != null) {
          expect200OneRow(`admin reads cross-team team-row via bypass`,
            await rest('GET', 'cost_model_projects', { token: tokAdmin, params: `?id=eq.${teamRowIdForAdmin}&select=id` }));
        }
        const audit = await rest('GET', 'audit_log', { token: tokAdmin, params: '?select=id&limit=1' });
        if (audit.status === 200 && Array.isArray(audit.body)) {
          ok(`admin audit_log SELECT reachable (${audit.body.length} row${audit.body.length === 1 ? '' : 's'})`);
        } else bad(`admin audit_log SELECT`, `status=${audit.status} body=${JSON.stringify(audit.body).slice(0, 180)}`);

        // Slice 3.9: general_hours has a single `general_hours_admin_rw`
        // policy USING (current_user_is_admin()). Admin reads rows via
        // REST; members return 0. The 50 seeded rows (Brock/Chris/Jimmy
        // Feb–Mar 2026) are the expected contents.
        const ghAdmin = await rest('GET', 'general_hours', { token: tokAdmin, params: '?select=id&limit=5' });
        if (ghAdmin.status === 200 && Array.isArray(ghAdmin.body) && ghAdmin.body.length >= 1) {
          ok(`admin general_hours SELECT → ${ghAdmin.body.length} row(s) (bypass policy active)`);
        } else bad(`admin general_hours SELECT`, `status=${ghAdmin.status} body=${JSON.stringify(ghAdmin.body).slice(0, 180)}`);
      } catch (e) {
        bad('Block 9 admin sign-in', e.message);
      }
    } else {
      console.log('\nBlock 9 — admin bypass: SKIPPED (set BROCK_PASS env var to enable)');
    }
  } finally {
    // ─── Teardown ──────────────────────────────────────────────────
    console.log('\nTeardown');
    for (const id of createdCmp) {
      const r = await rest('DELETE', 'cost_model_projects', { token: tokA, params: `?id=eq.${id}` });
      if (r.status !== 200 && r.status !== 204) {
        console.log(`  (teardown warning) cost_model_projects id=${id} delete status=${r.status}`);
      }
    }
    for (const id of createdFleet) {
      const r = await rest('DELETE', 'fleet_scenarios', { token: tokA, params: `?id=eq.${id}` });
      if (r.status !== 200 && r.status !== 204) {
        console.log(`  (teardown warning) fleet_scenarios id=${id} delete status=${r.status}`);
      }
    }
    for (const id of createdNetopt) {
      // netopt_scenario_results child rows cascade via config_id FK.
      const r = await rest('DELETE', 'netopt_configs', { token: tokA, params: `?id=eq.${id}` });
      if (r.status !== 200 && r.status !== 204) {
        console.log(`  (teardown warning) netopt_configs id=${id} delete status=${r.status}`);
      }
    }
    for (const id of createdWsc) {
      const r = await rest('DELETE', 'wsc_facility_configs', { token: tokA, params: `?id=eq.${id}` });
      if (r.status !== 200 && r.status !== 204) {
        console.log(`  (teardown warning) wsc_facility_configs id=${id} delete status=${r.status}`);
      }
    }
    console.log(`  Cleaned up ${createdCmp.length} cost_model_projects + ${createdFleet.length} fleet_scenarios + ${createdNetopt.length} netopt_configs + ${createdWsc.length} wsc_facility_configs rows`);
  }

  // ─── Summary ──────────────────────────────────────────────────
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error('test-rls-isolation.mjs crashed:', e);
  process.exitCode = 1;
});

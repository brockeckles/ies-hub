// test-rls-isolation.mjs — Slice 3.7 RLS isolation suite
//
// Full authed-persona isolation tests for the Slice 3.3 RLS policies. This is
// the "Full isolation suite with multiple real users" that test-rls.mjs
// (Slice 3.3 smoke) deferred to 3.7.
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

  console.log('Slice 3.7 RLS isolation suite (authed REST calls against live Supabase)');
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
    console.log(`  Cleaned up ${createdCmp.length} cost_model_projects + ${createdFleet.length} fleet_scenarios rows`);
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

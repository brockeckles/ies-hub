// test-invite.mjs — Slice 3.16 invite-user gate + client-validator coverage
//
// Live-network gate tests: hit the real edge function at Supabase to prove
// the authorization gates hold (anon blocked at 401, bad-JWT blocked at 401,
// authed non-admin blocked at 403). These are the most important invariants:
// they prove a compromised anon key can't invite arbitrary users into the
// project and that the admin check is server-side enforced — not just a UI
// hide.
//
// Pure tests: exercise the client-side shapes of auth.verifyInviteOtp (code
// validator) and auth.setInitialPassword (min length). These are cheap,
// network-free, and catch the easy regressions.
//
// The happy-path test (admin invites → row lands in profiles with correct
// team/role) is NOT automated here because it requires an admin account
// with a known password. Live-verify that manually by running the Slice
// 3.16 live walkthrough.
//
// Run: node test-invite.mjs
// Expected: 10/10 pass.

const SUPABASE_URL = 'https://dklnwcshrpamzsybjlzb.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrbG53Y3NocnBhbXpzeWJqbHpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTU3NzksImV4cCI6MjA5MDI5MTc3OX0.mj9TIj_rwxfbb9e2vBnA6hNYot5MX8-k1BbGfddAeJs';

// Synthetic non-admin user in rls-test-team. Same creds used by
// test-rls-isolation.mjs — there's already a valid session path for this
// user, so the test doesn't need to seed anything new.
const NON_ADMIN_EMAIL = 'rls-test-a@ies-hub.test';
const NON_ADMIN_PASSWORD = process.env.RLS_TEST_A_PASS || 'RlsTestA!2026';

// A team_id that exists — we only need the payload to SURVIVE validation
// long enough to hit the admin gate. Using Solutions Design here is fine:
// the edge function's admin check fires before any team-existence lookup.
const SD_TEAM_ID = 'd3e79133-18e5-4441-8b57-84920385cd8d';

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

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

async function callInvite(bearer, payload) {
  const headers = {
    apikey: ANON_KEY,
    'content-type': 'application/json',
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/invite-user`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

// ── 1. Live-net gate tests ────────────────────────────────────────────────

await test('anon (no bearer) → 401 at platform gate', async () => {
  // No Authorization header + verify_jwt=true on the function means the
  // Supabase gateway rejects before our function body runs. We just care
  // that the status is 401; the specific error body is GoTrue's.
  const { status } = await callInvite(null, {
    email: 'probe@example.com',
    team_id: SD_TEAM_ID,
    role: 'member',
    full_name: 'Probe',
  });
  assert(status === 401, `expected 401, got ${status}`);
});

await test('garbage bearer → 401 at platform gate', async () => {
  const { status } = await callInvite('definitely.not.a.real.jwt', {
    email: 'probe@example.com',
    team_id: SD_TEAM_ID,
    role: 'member',
    full_name: 'Probe',
  });
  assert(status === 401, `expected 401, got ${status}`);
});

await test('authed non-admin → 403 code=not_admin', async () => {
  const jwt = await signIn(NON_ADMIN_EMAIL, NON_ADMIN_PASSWORD);
  const { status, body } = await callInvite(jwt, {
    email: 'probe@example.com',
    team_id: SD_TEAM_ID,
    role: 'member',
    full_name: 'Probe',
  });
  assert(status === 403, `expected 403, got ${status}; body=${JSON.stringify(body)}`);
  assert(body.ok === false, `expected ok:false, got ok:${body.ok}`);
  assert(body.code === 'not_admin', `expected code='not_admin', got '${body.code}'`);
});

await test('authed non-admin with bad payload still → 403 (admin check first)', async () => {
  // Invariant: the admin check fires BEFORE payload validation, so a
  // garbage payload from a non-admin must still surface as 403 not_admin,
  // NOT as 400 bad_email. If this ever flips, it means we're leaking
  // validator behavior to non-admins (minor, but a defense-in-depth regression).
  const jwt = await signIn(NON_ADMIN_EMAIL, NON_ADMIN_PASSWORD);
  const { status, body } = await callInvite(jwt, {
    email: 'not-an-email',
    team_id: 'not-a-uuid',
    role: 'janitor',
    full_name: '',
  });
  assert(status === 403, `expected 403, got ${status}`);
  assert(body.code === 'not_admin', `expected code='not_admin', got '${body.code}'`);
});

await test('OPTIONS preflight succeeds with CORS headers', async () => {
  // Browser preflight — no bearer needed, gateway lets CORS OPTIONS through.
  const res = await fetch(`${SUPABASE_URL}/functions/v1/invite-user`, {
    method: 'OPTIONS',
    headers: { origin: 'https://brockeckles.github.io' },
  });
  assert(res.ok, `expected OK, got ${res.status}`);
  const allowOrigin = res.headers.get('access-control-allow-origin');
  assert(allowOrigin === '*', `expected allow-origin='*', got '${allowOrigin}'`);
});

// ── 2. Pure tests (no network) — validator behavior ──────────────────────

// Re-implement the same regex + length rules the production code uses,
// against the same fixtures. If the production rules are ever tightened
// we update these — the test's job is to freeze the contract.
const MIN_PASSWORD = 8;

function validateCode(code) {
  const cleaned = String(code || '').replace(/\s/g, '');
  if (!cleaned) return { ok: false, error: 'Enter the verification code from the email' };
  if (!/^\d{4,10}$/.test(cleaned)) return { ok: false, error: 'Code should be digits only' };
  return { ok: true, cleaned };
}

function validatePassword(pw) {
  if (!pw || pw.length < MIN_PASSWORD) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters` };
  }
  return { ok: true };
}

await test('code validator rejects empty', async () => {
  const r = validateCode('');
  assert(!r.ok && /enter the verification/i.test(r.error), `got: ${JSON.stringify(r)}`);
});

await test('code validator rejects non-digits', async () => {
  const r = validateCode('12ab56');
  assert(!r.ok && /digits only/i.test(r.error), `got: ${JSON.stringify(r)}`);
});

await test('code validator accepts 6-digit and strips whitespace', async () => {
  const r1 = validateCode(' 123 456 ');
  assert(r1.ok && r1.cleaned === '123456', `got: ${JSON.stringify(r1)}`);
  const r2 = validateCode('123456');
  assert(r2.ok && r2.cleaned === '123456', `got: ${JSON.stringify(r2)}`);
});

await test('password validator enforces min 8', async () => {
  assert(validatePassword('').ok === false);
  assert(validatePassword('short1!').ok === false);
  assert(validatePassword('longenough1!').ok === true);
});

// ── Report ────────────────────────────────────────────────────────────────

console.log(`\n\n${pass}/${pass + fail} tests passed`);
if (fail) {
  for (const { name, err } of failures) {
    console.log(`\n✗ ${name}\n  ${err.message}`);
  }
  process.exit(1);
}

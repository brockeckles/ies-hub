// test-signup-disabled.mjs — Slice 3.12 public-signup lockdown
//
// Hits the LIVE Supabase auth endpoint and asserts that anonymous signup is
// rejected at the project level. This is a network test by design — the
// whole invariant we want to protect is "the project-level 'Allow new user
// signups' toggle stays OFF." A mocked unit test couldn't catch a flipped
// dashboard setting, which is exactly the regression we're guarding against.
//
// Also sanity-checks that the password login endpoint still functions
// (it just rejects bad credentials as expected) so we know the lockdown
// only disables the signup path and not login.
//
// Run: node test-signup-disabled.mjs
//
// Expected output when toggle is OFF: 2/2 pass.
// If this fails with HTTP 200 on the signup probe → someone re-enabled
// public signups. Close the hole immediately.

// Env-parameterized (Slice 4.5): CI-on-main sets these to the staging
// project (staging had `disable_signup` toggled ON in Slice 4.3 so the
// invariant holds there too). Local dev defaults to prod so the manual
// `node test-signup-disabled.mjs` flow is unchanged.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dklnwcshrpamzsybjlzb.supabase.co';
// Same anon key that ships in shared/supabase.js — this is the exact
// capability a malicious actor has. If signup is closed for THIS key, it is
// closed for everyone anon. (Service-role key bypasses the toggle and is
// how admin.createUser still works; we do NOT test that here.)
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrbG53Y3NocnBhbXpzeWJqbHpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTU3NzksImV4cCI6MjA5MDI5MTc3OX0.mj9TIj_rwxfbb9e2vBnA6hNYot5MX8-k1BbGfddAeJs';
console.log(`[signup-disabled] url=${SUPABASE_URL}`);

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

// Generate a probe email that (a) routes to a real disposable inbox so
// Supabase's TLD filter doesn't fire a red-herring 400, and (b) is unique
// per run so we don't false-pass on a cached rate-limit response.
function probeEmail() {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `signup-probe-${nonce}@mailinator.com`;
}

await test('public signup is rejected (signup_disabled)', async () => {
  const email = probeEmail();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Totally-invalid-example-1!' }),
  });
  const body = await res.json().catch(() => ({}));
  // 422 is what GoTrue returns when DISABLE_SIGNUP=true.
  assert(
    res.status === 422,
    `expected HTTP 422 (signup disabled), got ${res.status}. body=${JSON.stringify(body)}`
  );
  assert(
    body.error_code === 'signup_disabled',
    `expected error_code='signup_disabled', got ${body.error_code}. If this reads 'over_email_send_rate_limit' or similar, the test is being rate-limited; re-run after a pause.`
  );
  // Defense in depth — if the above shape ever changes, catch any message
  // that unambiguously indicates signup was NOT accepted.
  assert(
    /not allowed|disabled/i.test(body.msg || ''),
    `msg should mention 'not allowed' or 'disabled'; got: ${body.msg}`
  );
});

await test('login endpoint still responds normally (not nuked by the toggle)', async () => {
  // Confirm the toggle only killed signup, not login. A healthy login
  // endpoint returns 400 with invalid_credentials for a bogus email. A
  // broken / misconfigured one would return 5xx or a different error.
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `does-not-exist-${Date.now()}@mailinator.com`,
        password: 'wrong',
      }),
    }
  );
  const body = await res.json().catch(() => ({}));
  assert(
    res.status === 400,
    `expected HTTP 400 for bad creds, got ${res.status}. body=${JSON.stringify(body)}`
  );
  assert(
    body.error_code === 'invalid_credentials',
    `expected error_code='invalid_credentials', got ${body.error_code}`
  );
});

// ─── Report ─────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name}\n    ${f.err.message}`);
}
console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

// test-audit.mjs — Slice 3.4 user_id wiring (shared/audit.js)
//
// Asserts recordAudit writes user_id + user_email under real auth,
// and writes nulls under code-mode / pre-bootstrap. The fire-and-forget
// contract is also locked in: a throwing db never propagates out.
//
// Run: node test-audit.mjs

// ─── Browser-global shims ────────────────────────────────────────────────
class StorageShim {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
}
globalThis.sessionStorage = new StorageShim();
globalThis.localStorage = new StorageShim();
globalThis.window = { localStorage: globalThis.localStorage };
if (!('navigator' in globalThis) || !globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test-audit-node' },
    writable: true,
    configurable: true,
  });
}
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => 't-' + Math.random().toString(36).slice(2) },
    writable: true,
    configurable: true,
  });
}

// ─── Fake supabase + db capture ──────────────────────────────────────────
// We capture every insert into audit_log so tests can assert the written
// row shape. Throwing the insert verifies the fire-and-forget contract.
let _lastInsert = null;
let _throwOnInsert = false;

function makeFakeSupabase() {
  let session = null;
  const listeners = new Set();
  function emit(evt, s) { for (const fn of listeners) fn(evt, s); }
  return {
    createClient() {
      return {
        auth: {
          async getSession() { return { data: { session }, error: null }; },
          async signInWithPassword({ email, password }) {
            if (password === 'bad') return { data: null, error: { message: 'Invalid login credentials' } };
            session = {
              access_token: 'tok',
              refresh_token: 'rt',
              user: { id: 'uid-' + email, email },
            };
            emit('SIGNED_IN', session);
            return { data: { session, user: session.user }, error: null };
          },
          async signOut() { session = null; emit('SIGNED_OUT', null); return { error: null }; },
          onAuthStateChange(fn) {
            listeners.add(fn);
            return { data: { subscription: { unsubscribe() { listeners.delete(fn); } } } };
          },
          __setSession(s) { session = s; },
        },
        from(table) {
          return {
            insert(row) {
              _lastInsert = { table, row };
              if (_throwOnInsert) throw new Error('simulated db failure');
              return {
                select() {
                  return { single: async () => ({ data: { id: 1, ...row }, error: null }) };
                },
              };
            },
          };
        },
      };
    },
  };
}
globalThis.supabase = makeFakeSupabase();

// ─── Runner ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  _lastInsert = null;
  _throwOnInsert = false;
  try { await fn(); pass++; process.stdout.write('.'); }
  catch (e) { fail++; process.stdout.write('F'); failures.push({ name, err: e }); }
}
const assert = (c, m = 'assert fail') => { if (!c) throw new Error(m); };

// ─── Load modules after globals are in place ─────────────────────────────
const { auth } = await import('./shared/auth.js?v=20260423-z3');
const { recordAudit } = await import('./shared/audit.js?v=20260423-y7');

async function resetAuth() {
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
  const { db } = await import('./shared/supabase.js?v=20260423-y1');
  const client = db.getClient();
  if (client?.auth?.__setSession) client.auth.__setSession(null);
  await auth.logout();
}

// ─── Tests ──────────────────────────────────────────────────────────────

await test('pre-bootstrap: user_id + user_email null', async () => {
  await resetAuth();
  await recordAudit({ table: 'cost_model_scenarios', id: 1, action: 'insert' });
  assert(_lastInsert, 'insert must fire');
  assert(_lastInsert.table === 'audit_log', 'target audit_log');
  assert(_lastInsert.row.user_id === null, 'user_id null when unauthed');
  assert(_lastInsert.row.user_email === null, 'user_email null when unauthed');
});

// code-mode test removed in Slice 3.5 — the path no longer exists. The
// pre-bootstrap null-identity case above now covers the same contract:
// when there's no Supabase session, recordAudit writes user_id=null.

await test('password mode: user_id + user_email populated', async () => {
  await resetAuth();
  await auth.bootstrapSession();
  const res = await auth.loginWithPassword('brock@gxo.com', 'secret');
  assert(res.ok, 'login must succeed');
  await recordAudit({ table: 'opportunities', id: 11, action: 'update', fields: { stage: 'Design' } });
  assert(_lastInsert.row.user_id === 'uid-brock@gxo.com', 'user_id must be auth.uid() — was ' + _lastInsert.row.user_id);
  assert(_lastInsert.row.user_email === 'brock@gxo.com', 'user_email mirrors session email');
  assert(_lastInsert.row.changed_fields?.stage === 'Design', 'changed_fields passes through');
});

await test('row shape: session_id + entity fields + user_agent preserved', async () => {
  await resetAuth();
  await auth.bootstrapSession();
  await auth.loginWithPassword('preserve@gxo.com', 'secret');
  await recordAudit({ table: 't', id: 'abc', action: 'delete' });
  const r = _lastInsert.row;
  assert(r.entity_table === 't');
  assert(r.entity_id === 'abc');
  assert(r.action === 'delete');
  assert(typeof r.session_id === 'string' && r.session_id.length > 0, 'session_id populated');
  assert(typeof r.user_agent === 'string', 'user_agent captured');
});

await test('fire-and-forget: db throw does not propagate', async () => {
  await resetAuth();
  _throwOnInsert = true;
  // If recordAudit leaks the error, this await will throw and fail the test.
  await recordAudit({ table: 'x', action: 'insert' });
  // We don't assert on _lastInsert content here — the whole point is the
  // caller's save path survives the audit failure.
});

await test('invalid input: no table or action skips insert silently', async () => {
  await resetAuth();
  await recordAudit({});
  assert(_lastInsert === null, 'must not insert on missing fields');
  await recordAudit({ table: 'x' });
  assert(_lastInsert === null, 'must not insert without action');
  await recordAudit({ action: 'insert' });
  assert(_lastInsert === null, 'must not insert without table');
});

// ─── Actor override (Slice 3.16 follow-up) ──────────────────────────────
// recordAudit accepts an optional `actor` to attribute a row to an
// identity captured BEFORE an async round-trip (e.g. an edge-fn invite).
// This pins the attribution so a transient auth event during the await
// cannot null out the user_id. See shared/audit.js currentIdentity().

await test('actor override: uses captured identity over live auth', async () => {
  await resetAuth();
  await auth.bootstrapSession();
  await auth.loginWithPassword('live@gxo.com', 'secret');
  // Now clear the in-memory session to simulate the race where
  // _currentUser goes momentarily null during a token refresh.
  await auth.logout();
  await recordAudit({
    table: 'profiles',
    id: 'invitee-uid',
    action: 'insert',
    fields: { email: 'invitee@gxo.com', invited: true },
    actor: { id: 'captured-admin-uid', email: 'captured-admin@gxo.com' },
  });
  assert(_lastInsert.row.user_id === 'captured-admin-uid', 'user_id uses actor.id — was ' + _lastInsert.row.user_id);
  assert(_lastInsert.row.user_email === 'captured-admin@gxo.com', 'user_email uses actor.email — was ' + _lastInsert.row.user_email);
  assert(_lastInsert.row.entity_id === 'invitee-uid', 'entity_id still the target');
});

await test('actor override: ignored when actor.id is missing', async () => {
  await resetAuth();
  await auth.bootstrapSession();
  await auth.loginWithPassword('fallback@gxo.com', 'secret');
  // actor without id → fall through to live auth identity
  await recordAudit({
    table: 'profiles',
    id: 'x',
    action: 'update',
    actor: { id: null, email: 'stale@gxo.com' },
  });
  assert(_lastInsert.row.user_id === 'uid-fallback@gxo.com', 'falls back to live auth when override.id missing — was ' + _lastInsert.row.user_id);
  assert(_lastInsert.row.user_email === 'fallback@gxo.com', 'falls back to live email too');
});

await test('post-logout: reverts to null user_id', async () => {
  await resetAuth();
  await auth.bootstrapSession();
  await auth.loginWithPassword('out@gxo.com', 'secret');
  await auth.logout();
  await recordAudit({ table: 'cost_model_projects', id: 2, action: 'update' });
  assert(_lastInsert.row.user_id === null, 'post-logout user_id must be null');
  assert(_lastInsert.row.user_email === null, 'post-logout user_email must be null');
});

// ─── Summary ────────────────────────────────────────────────────────────
console.log(`\n\n${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const { name, err } of failures) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack || err.message || err}`);
  }
  process.exit(1);
}

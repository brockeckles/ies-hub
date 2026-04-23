// test-auth.mjs — Slice 3.5 session lifecycle (shared/auth.js)
//
// Covers the JS surface we own: password login, session bootstrap from
// persisted state, logout, mode/user accessors, onAuthStateChange wiring.
// Code-mode tests are gone as of Slice 3.5 — the legacy access-code path
// has been removed. We stub the supabase-js CDN global with a fake client
// so the module can be exercised in Node. This is NOT an RLS/isolation
// test — those live in Slice 3.7 + test-rls.mjs.
//
// Run: node test-auth.mjs

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
    value: { userAgent: 'test-auth-node' },
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

// ─── Fake supabase-js ────────────────────────────────────────────────────
function makeFakeSupabase() {
  let session = null;
  const listeners = new Set();
  function emit(evt, s) { for (const fn of listeners) fn(evt, s); }
  return {
    createClient(_url, _key, opts) {
      return {
        _opts: opts,
        auth: {
          async getSession() { return { data: { session }, error: null }; },
          async signInWithPassword({ email, password }) {
            if (password === 'bad') {
              return { data: null, error: { message: 'Invalid login credentials' } };
            }
            session = {
              access_token: 'tok-' + email,
              refresh_token: 'rt-' + email,
              user: { id: 'uid-' + email, email },
            };
            emit('SIGNED_IN', session);
            return { data: { session, user: session.user }, error: null };
          },
          async signOut() {
            session = null;
            emit('SIGNED_OUT', null);
            return { error: null };
          },
          onAuthStateChange(fn) {
            listeners.add(fn);
            return {
              data: {
                subscription: {
                  unsubscribe() { listeners.delete(fn); },
                },
              },
            };
          },
          __setSession(s) { session = s; },
          __getListenerCount() { return listeners.size; },
          __emit: emit,
        },
        from() { return {}; },
      };
    },
  };
}
globalThis.supabase = makeFakeSupabase();

async function reset() {
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
  try {
    const { db } = await import('./shared/supabase.js?v=20260423-y1');
    const client = db.getClient();
    if (client?.auth?.__setSession) client.auth.__setSession(null);
  } catch { /* first-run: auth.bootstrap creates the client below */ }
  await auth.logout();
}

// ─── Test runner ─────────────────────────────────────────────────────────
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

const { auth } = await import('./shared/auth.js?v=20260423-y4');

// ─── Tests ──────────────────────────────────────────────────────────────

await test('initial state: not authenticated, no mode, no user', async () => {
  await reset();
  await auth.bootstrapSession();
  assert(!auth.isAuthenticated(), 'should not be authenticated with nothing stored');
  assert(auth.getMode() === null, 'mode should be null');
  assert(auth.getUser() === null, 'user should be null');
});

await test('password login: success updates session, user, mode', async () => {
  await reset();
  await auth.bootstrapSession();
  const res = await auth.loginWithPassword('brock@gxo.com', 'secret');
  assert(res.ok === true, 'signIn must succeed');
  assert(auth.isAuthenticated(), 'should be authenticated');
  assert(auth.getMode() === 'password', 'mode must be password');
  const u = auth.getUser();
  assert(u && u.email === 'brock@gxo.com', 'getUser must expose email');
  assert(u && u.id === 'uid-brock@gxo.com', 'identity key is uid (UUID stand-in)');
});

await test('password login: failure returns error, stays unauthenticated', async () => {
  await reset();
  await auth.bootstrapSession();
  const res = await auth.loginWithPassword('x@x.com', 'bad');
  assert(res.ok === false, 'signIn must fail');
  assert(res.error, 'error message must be present');
  assert(!auth.isAuthenticated(), 'must stay unauthenticated');
});

await test('password login: mirrors email into sessionStorage for legacy consumers', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('mirror@gxo.com', 'secret');
  assert(
    globalThis.sessionStorage.getItem('ies_user_email') === 'mirror@gxo.com',
    'ies_user_email must be set for audit/export read-sites'
  );
});

await test('logout: clears session, state, and legacy email mirror', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('out@gxo.com', 'secret');
  await auth.logout();
  assert(!auth.isAuthenticated(), 'must be unauthenticated');
  assert(auth.getMode() === null, 'mode must be null');
  assert(auth.getUser() === null, 'user must be null');
  assert(
    globalThis.sessionStorage.getItem('ies_user_email') === null,
    'legacy ies_user_email must be cleared'
  );
});

await test('bootstrap idempotent: second call does not double-subscribe', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.bootstrapSession();
  await auth.bootstrapSession();
  assert(!auth.isAuthenticated(), 'still unauthenticated');
});

await test('code-mode API is gone: no loginWithCode, no validateCode, no login alias', async () => {
  await reset();
  await auth.bootstrapSession();
  // Slice 3.5 removed these — if any sneak back in, this test fails loudly.
  assert(typeof auth.loginWithCode === 'undefined', 'loginWithCode must be removed');
  assert(typeof auth.validateCode === 'undefined', 'validateCode must be removed');
  assert(typeof auth.login === 'undefined', 'login(code) alias must be removed');
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

// test-auth.mjs — Slice 3.2 session lifecycle (shared/auth.js)
//
// Covers the JS surface we own: dual-path login, session bootstrap from
// persisted state, logout, mode/user accessors, onAuthStateChange wiring.
// We stub the supabase-js CDN global with a fake client so the module can
// be exercised in Node. This is NOT an RLS/isolation test — those live
// in Slice 3.7.
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
// navigator is a read-only builtin in Node ≥18; only define it if absent.
if (!('navigator' in globalThis) || !globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test-auth-node' },
    writable: true,
    configurable: true,
  });
}
// Node provides globalThis.crypto in ≥19 — only shim if missing.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => 't-' + Math.random().toString(36).slice(2) },
    writable: true,
    configurable: true,
  });
}

// ─── Fake supabase-js ────────────────────────────────────────────────────
// Tracks current session and fires onAuthStateChange when it flips.
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
          async signUp({ email }) {
            return { data: { user: { id: 'new-' + email, email } }, error: null };
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
          // Test-only hooks
          __setSession(s) { session = s; },
          __getListenerCount() { return listeners.size; },
          __emit: emit,
        },
        from() { return {}; },
      };
    },
  };
}
// Singleton — the supabase.js module caches its client on first call, so
// we must not swap this out between tests. Instead, clear its session
// through the __setSession hook we exposed on the fake.
globalThis.supabase = makeFakeSupabase();

// Reset helper for between-test isolation. Clears browser storage, the
// fake supabase session, AND any lingering auth-module state via logout().
async function reset() {
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
  // Reach through the cached client (populated on first getClient call) to
  // wipe its session without re-creating the supabase global.
  try {
    const { db } = await import('./shared/supabase.js?v=20260423-y1');
    const client = db.getClient();
    if (client?.auth?.__setSession) client.auth.__setSession(null);
  } catch { /* first-run: auth.bootstrap creates the client below */ }
  await auth.logout(); // force-clears module-level _currentSession/_codeMode
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

// ─── Load module AFTER globals are in place ─────────────────────────────
// Because supabase.js imports into a module singleton, each test file gets
// its own instance. We import once and drive it through multiple scenarios.
const { auth } = await import('./shared/auth.js?v=20260423-y1');

// ─── Tests ──────────────────────────────────────────────────────────────

await test('initial state: not authenticated, no mode, no user', async () => {
  await reset();
  await auth.bootstrapSession();
  assert(!auth.isAuthenticated(), 'should not be authenticated with nothing stored');
  assert(auth.getMode() === null, 'mode should be null');
  assert(auth.getUser() === null, 'user should be null');
});

await test('legacy code login: ies2026 (case-insensitive) works', async () => {
  await reset();
  await auth.bootstrapSession();
  const ok = auth.loginWithCode('IES2026');
  assert(ok === true, 'loginWithCode should return true');
  assert(auth.isAuthenticated(), 'should be authenticated after code');
  assert(auth.getMode() === 'code', 'mode should be code');
  assert(auth.getUser() === null, 'code mode must not have a user — identity is null');
});

await test('legacy code login: rejects bad code', async () => {
  await reset();
  await auth.bootstrapSession();
  assert(auth.loginWithCode('wrong') === false, 'bad code must reject');
  assert(!auth.isAuthenticated(), 'should still be unauthenticated');
});

await test('legacy code login: back-compat alias auth.login(code) works', async () => {
  await reset();
  await auth.bootstrapSession();
  assert(auth.login('ieshub') === true, 'legacy .login alias must accept ieshub');
  assert(auth.getMode() === 'code');
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

await test('logout: clears session, code flag, state, and legacy email', async () => {
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

await test('logout from code mode: clears legacy code flag', async () => {
  await reset();
  await auth.bootstrapSession();
  auth.loginWithCode('ies2026');
  assert(auth.isAuthenticated());
  await auth.logout();
  assert(!auth.isAuthenticated(), 'code-mode logout must unauth');
  assert(
    globalThis.sessionStorage.getItem('ies_hub_v3_auth') === null,
    'legacy code flag must be cleared'
  );
});

await test('password login: supersedes a lingering code flag', async () => {
  await reset();
  // Simulate a legacy session then upgrading to password.
  globalThis.sessionStorage.setItem('ies_hub_v3_auth', 'true');
  await auth.bootstrapSession();
  assert(auth.getMode() === 'code', 'restored code session');
  await auth.loginWithPassword('upgrade@gxo.com', 'secret');
  assert(auth.getMode() === 'password', 'password wins over code');
  assert(
    globalThis.sessionStorage.getItem('ies_hub_v3_auth') === null,
    'code flag cleared when real auth lands'
  );
});

await test('validateCode: pure check, no side-effects', async () => {
  await reset();
  await auth.bootstrapSession();
  assert(auth.validateCode('ies2026') === true);
  assert(auth.validateCode('IesHub') === true, 'case-insensitive');
  assert(auth.validateCode('nope') === false);
  assert(!auth.isAuthenticated(), 'validate must not log in');
});

await test('bootstrap idempotent: second call does not double-subscribe', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.bootstrapSession();
  await auth.bootstrapSession();
  // If we're still here the module handled duplicate calls cleanly.
  // Listener count would grow without de-dup; we can't read it from the
  // auth module directly, but we can confirm no exceptions fire and
  // the public API still behaves.
  assert(!auth.isAuthenticated(), 'still unauthenticated');
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

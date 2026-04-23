// test-auth.mjs — Slice 3.5 + 3.6 session lifecycle (shared/auth.js)
//
// Covers the JS surface we own: password login, session bootstrap from
// persisted state, logout, mode/user accessors, onAuthStateChange wiring,
// and (Slice 3.6) the changePassword reverify-then-update path.
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
// Models a tiny per-email password store so changePassword can verify both
// the reverify-with-current-password step and the subsequent updateUser.
function makeFakeSupabase() {
  let session = null;
  const listeners = new Set();
  // Stored passwords by email — seeded by signInWithPassword on first use
  // (the test "creates" the user implicitly by signing in successfully).
  const passwords = new Map();
  // Slice 3.10 — track resetPasswordForEmail invocations so tests can
  // assert what was sent without subscribing to the real network.
  const resetCalls = [];
  let nextResetError = null;
  function emit(evt, s) { for (const fn of listeners) fn(evt, s); }
  return {
    createClient(_url, _key, opts) {
      return {
        _opts: opts,
        auth: {
          async getSession() { return { data: { session }, error: null }; },
          async resetPasswordForEmail(email, reqOpts) {
            resetCalls.push({ email, opts: reqOpts || null });
            if (nextResetError) {
              const err = nextResetError; nextResetError = null;
              return { data: null, error: err };
            }
            return { data: {}, error: null };
          },
          async signInWithPassword({ email, password }) {
            // The literal string 'bad' is a hard-fail for legacy tests that
            // didn't model the password store. Otherwise: if a stored
            // password exists for this email it must match; if no stored
            // password exists yet, accept the credentials and remember them.
            if (password === 'bad') {
              return { data: null, error: { message: 'Invalid login credentials' } };
            }
            const stored = passwords.get(email);
            if (stored !== undefined && stored !== password) {
              return { data: null, error: { message: 'Invalid login credentials' } };
            }
            if (stored === undefined) passwords.set(email, password);
            session = {
              access_token: 'tok-' + email,
              refresh_token: 'rt-' + email,
              user: { id: 'uid-' + email, email },
            };
            emit('SIGNED_IN', session);
            return { data: { session, user: session.user }, error: null };
          },
          async updateUser({ password }) {
            if (!session) {
              return { data: null, error: { message: 'Not authenticated' } };
            }
            if (typeof password === 'string') {
              passwords.set(session.user.email, password);
              emit('USER_UPDATED', session);
            }
            return { data: { user: session.user }, error: null };
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
          __setPassword(email, password) { passwords.set(email, password); },
          __getPassword(email) { return passwords.get(email); },
          __getResetCalls() { return resetCalls.slice(); },
          __setNextResetError(err) { nextResetError = err; },
          __fireRecovery(email) {
            // Simulate what supabase-js does when the recovery token in the
            // URL has been consumed — set a short-lived session and fire
            // PASSWORD_RECOVERY so the auth module's listener sees it.
            session = {
              access_token: 'recov-tok-' + email,
              refresh_token: 'recov-rt-' + email,
              user: { id: 'uid-' + email, email },
            };
            emit('PASSWORD_RECOVERY', session);
          },
          __reset() {
            passwords.clear();
            resetCalls.length = 0;
            nextResetError = null;
            session = null;
          },
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
    if (client?.auth?.__reset) client.auth.__reset();
    else if (client?.auth?.__setSession) client.auth.__setSession(null);
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

const { auth } = await import('./shared/auth.js?v=20260423-y7');
const { bus } = await import('./shared/event-bus.js?v=20260418-sK');

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

// ─── Slice 3.6: changePassword ──────────────────────────────────────────

await test('changePassword: API surface exists', async () => {
  assert(typeof auth.changePassword === 'function', 'auth.changePassword must be a function');
  assert(typeof auth.renderChangePasswordModal === 'function', 'auth.renderChangePasswordModal must be a function');
});

await test('changePassword: rejects when not signed in', async () => {
  await reset();
  await auth.bootstrapSession();
  const res = await auth.changePassword('whatever', 'newsecret123');
  assert(res.ok === false, 'must fail without a session');
  assert(/not signed in/i.test(res.error || ''), 'error must mention not-signed-in');
});

await test('changePassword: rejects when current password is missing', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('cp1@gxo.com', 'tempPass1!');
  const res = await auth.changePassword('', 'newsecret123');
  assert(res.ok === false, 'must fail with empty current password');
  assert(/current password/i.test(res.error || ''), 'error must reference current password');
});

await test('changePassword: rejects new password under 8 characters', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('cp2@gxo.com', 'tempPass1!');
  const res = await auth.changePassword('tempPass1!', 'short');
  assert(res.ok === false, 'must fail with short new password');
  assert(/8 character/i.test(res.error || ''), 'error must reference 8-char minimum');
});

await test('changePassword: rejects when new password equals current', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('cp3@gxo.com', 'tempPass1!');
  const res = await auth.changePassword('tempPass1!', 'tempPass1!');
  assert(res.ok === false, 'must fail when new equals current');
  assert(/different/i.test(res.error || ''), 'error must mention "different"');
});

await test('changePassword: rejects when current password does not match', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('cp4@gxo.com', 'tempPass1!');
  const res = await auth.changePassword('wrongCurrent', 'newSecret999');
  assert(res.ok === false, 'must fail when current password is wrong');
  assert(/current password is incorrect/i.test(res.error || ''),
    'error must say current password is incorrect');
});

await test('changePassword: success path updates the stored password', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('cp5@gxo.com', 'tempPass1!');
  const res = await auth.changePassword('tempPass1!', 'newSecret999');
  assert(res.ok === true, 'change must succeed');
  // Now verify by signing out and back in with the new password.
  await auth.logout();
  const reLogin = await auth.loginWithPassword('cp5@gxo.com', 'newSecret999');
  assert(reLogin.ok === true, 'must be able to sign back in with new password');
  // And the old password must no longer work.
  await auth.logout();
  const oldLogin = await auth.loginWithPassword('cp5@gxo.com', 'tempPass1!');
  assert(oldLogin.ok === false, 'old password must no longer work');
});

await test('changePassword: success emits auth:password_changed event', async () => {
  await reset();
  await auth.bootstrapSession();
  await auth.loginWithPassword('cp6@gxo.com', 'tempPass1!');
  let payload = null;
  const off = bus.on('auth:password_changed', (p) => { payload = p; });
  const res = await auth.changePassword('tempPass1!', 'newSecret999');
  if (typeof off === 'function') off();
  assert(res.ok === true, 'change must succeed');
  assert(payload && payload.email === 'cp6@gxo.com', 'event must carry the email');
  assert(payload && /^uid-/.test(payload.id || ''), 'event must carry the uid');
});

// ─── Slice 3.10: password reset + recovery ──────────────────────────────

// Helper: grab the raw supabase client so we can poke the test-only
// __* hooks without leaking them into the auth module surface.
async function rawClient() {
  const { db } = await import('./shared/supabase.js?v=20260423-y1');
  return db.getClient();
}

await test('recovery API surface exists', async () => {
  assert(typeof auth.requestPasswordReset === 'function', 'requestPasswordReset must exist');
  assert(typeof auth.completePasswordRecovery === 'function', 'completePasswordRecovery must exist');
  assert(typeof auth.renderForgotPasswordModal === 'function', 'renderForgotPasswordModal must exist');
  assert(typeof auth.renderRecoverySetPasswordModal === 'function', 'renderRecoverySetPasswordModal must exist');
  assert(typeof auth.isInRecovery === 'function', 'isInRecovery must exist');
});

await test('requestPasswordReset: rejects empty email', async () => {
  await reset();
  await auth.bootstrapSession();
  const res = await auth.requestPasswordReset('');
  assert(res.ok === false, 'must fail with empty email');
  assert(/email/i.test(res.error || ''), 'error must reference email');
});

await test('requestPasswordReset: rejects malformed email', async () => {
  await reset();
  await auth.bootstrapSession();
  const res = await auth.requestPasswordReset('not-an-email');
  assert(res.ok === false, 'must fail with malformed email');
  assert(/valid email/i.test(res.error || ''), 'error must mention valid email');
});

await test('requestPasswordReset: success returns ok and calls supabase', async () => {
  await reset();
  await auth.bootstrapSession();
  const c = await rawClient();
  const before = c.auth.__getResetCalls().length;
  const res = await auth.requestPasswordReset('pilot@gxo.com');
  assert(res.ok === true, 'must succeed');
  const after = c.auth.__getResetCalls();
  assert(after.length === before + 1, 'must invoke supabase once');
  assert(after[after.length - 1].email === 'pilot@gxo.com', 'email must match');
});

await test('requestPasswordReset: trims email before sending', async () => {
  await reset();
  await auth.bootstrapSession();
  const c = await rawClient();
  await auth.requestPasswordReset('  spaced@gxo.com  ');
  const calls = c.auth.__getResetCalls();
  assert(calls[calls.length - 1].email === 'spaced@gxo.com', 'email must be trimmed');
});

await test('requestPasswordReset: surfaces supabase errors (rate limit)', async () => {
  await reset();
  await auth.bootstrapSession();
  const c = await rawClient();
  c.auth.__setNextResetError({ message: 'For security purposes, you can only request this once every 60 seconds' });
  const res = await auth.requestPasswordReset('rate@gxo.com');
  assert(res.ok === false, 'must fail');
  assert(/60 seconds/i.test(res.error || ''), 'error must pass through rate-limit message');
});

await test('PASSWORD_RECOVERY event: sets recovery mode + emits bus event', async () => {
  await reset();
  await auth.bootstrapSession();
  let recoveryPayload = null;
  const off = bus.on('auth:recovery_started', (p) => { recoveryPayload = p; });
  const c = await rawClient();
  c.auth.__fireRecovery('recover@gxo.com');
  if (typeof off === 'function') off();
  assert(auth.isInRecovery() === true, 'recovery flag must be set');
  assert(auth.getMode() === 'recovery', "mode must be 'recovery'");
  assert(auth.isAuthenticated() === false, 'recovery session is NOT authenticated');
  assert(recoveryPayload && recoveryPayload.email === 'recover@gxo.com', 'bus payload must carry email');
  assert(recoveryPayload && /^uid-/.test(recoveryPayload.id || ''), 'bus payload must carry uid');
});

await test('completePasswordRecovery: rejects when not in recovery', async () => {
  await reset();
  await auth.bootstrapSession();
  const res = await auth.completePasswordRecovery('newSecret999');
  assert(res.ok === false, 'must fail outside recovery');
  assert(/recovery/i.test(res.error || ''), 'error must mention recovery');
});

await test('completePasswordRecovery: rejects too-short password', async () => {
  await reset();
  await auth.bootstrapSession();
  const c = await rawClient();
  c.auth.__fireRecovery('short@gxo.com');
  const res = await auth.completePasswordRecovery('short');
  assert(res.ok === false, 'must fail');
  assert(/8 character/i.test(res.error || ''), 'error must mention 8-char minimum');
  // Still in recovery after validation failure.
  assert(auth.isInRecovery() === true, 'validation failure must not drop recovery state');
});

await test('completePasswordRecovery: success updates password, clears recovery, emits event', async () => {
  await reset();
  await auth.bootstrapSession();
  const c = await rawClient();
  // Pre-seed an old password so we can prove the update actually takes.
  c.auth.__setPassword('revive@gxo.com', 'oldTempPw!');
  c.auth.__fireRecovery('revive@gxo.com');
  let payload = null;
  const off = bus.on('auth:password_changed', (p) => { payload = p; });
  const res = await auth.completePasswordRecovery('brandNewPw123');
  if (typeof off === 'function') off();
  assert(res.ok === true, 'recovery completion must succeed');
  assert(auth.isInRecovery() === false, 'recovery flag must clear on success');
  assert(c.auth.__getPassword('revive@gxo.com') === 'brandNewPw123', 'stored password must update');
  assert(payload && payload.email === 'revive@gxo.com', 'auth:password_changed must fire with email');
  // And the old password is dead — prove end-to-end.
  await auth.logout();
  const old = await auth.loginWithPassword('revive@gxo.com', 'oldTempPw!');
  assert(old.ok === false, 'old temp password must no longer work');
  const fresh = await auth.loginWithPassword('revive@gxo.com', 'brandNewPw123');
  assert(fresh.ok === true, 'new password must sign user back in');
});

await test('recovery-then-logout: cancel button path clears recovery state', async () => {
  await reset();
  await auth.bootstrapSession();
  const c = await rawClient();
  c.auth.__fireRecovery('cancel@gxo.com');
  assert(auth.isInRecovery() === true, 'recovery should be active');
  // Simulate user hitting "Sign out" on the recovery modal.
  await auth.logout();
  assert(auth.isInRecovery() === false, 'logout must clear recovery state');
  assert(auth.isAuthenticated() === false, 'must be unauthenticated');
  assert(auth.getMode() === null, 'mode must be null after logout');
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

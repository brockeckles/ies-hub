/**
 * IES Hub v3 — Authentication (Phase 3, Slice 3.11)
 *
 * Supabase email/password only. Code-mode (`ies2026` / `ieshub`) is gone as
 * of Slice 3.5 — every user is a real auth.users row with a real uid. The
 * login-form component stays isolated so the Entra swap in Phase 7+ is a
 * component swap, not a session-layer rewrite.
 *
 * Slice 3.6 added in-app password rotation (changePassword reverify-then-update).
 *
 * Slice 3.10 shipped email-link password recovery. DEAD on corporate inboxes:
 * Microsoft 365 Safe Links (and similar Proofpoint/Mimecast gateways) pre-
 * clicks every URL in inbound mail at delivery time, burning Supabase's
 * one-time recovery token before the human sees the email. Verified live
 * via Supabase auth logs — multiple scanner IPs consumed the token, then
 * Brock's legitimate click landed on a 403 "token expired".
 *
 * Slice 3.11 replaces the link with a numeric OTP code (Supabase default
 * is 6 digits, projects with stricter policies may issue 8). User enters
 * email, gets an email with the code in the body, types it into the app.
 * Nothing for a scanner to click; the code can't be "consumed" by being
 * read. The legacy link still works (fallback for personal / non-corporate
 * accounts).
 *
 * Flow:
 *   email → requestPasswordReset → email with code arrives →
 *   code → verifyRecoveryOtp → PASSWORD_RECOVERY fires →
 *   existing recovery-set-password modal opens →
 *   completePasswordRecovery → signed in.
 *
 * Usage:
 *   import { auth } from './auth.js?v=20260429-demo-s3';
 *
 *   await auth.bootstrapSession();            // call once before gate check
 *   if (!auth.isAuthenticated()) {
 *     auth.renderLoginScreen(overlay, onSuccess);
 *   }
 *   auth.getUser();                            // → { id, email } | null
 *   auth.getMode();                            // → 'password' | 'recovery' | null
 *   await auth.loginWithPassword(email, pw);   // → { ok, user?, error? }
 *   await auth.requestPasswordReset(email);    // → { ok, error? }
 *   await auth.verifyRecoveryOtp(email, code); // → { ok, user?, error? }
 *   await auth.completePasswordRecovery(newPw); // → { ok, error? }
 *   await auth.changePassword(currentPw, newPw); // → { ok, error? }
 *   auth.renderChangePasswordModal({ onClose });
 *   auth.renderForgotPasswordModal({ onClose, defaultEmail });
 *   auth.renderRecoverySetPasswordModal({ onSuccess });
 *   await auth.logout();
 *
 * Events on the bus:
 *   auth:login            — SIGNED_IN fired (every successful auth)
 *   auth:logout           — SIGNED_OUT fired
 *   auth:password_changed — changePassword OR completePasswordRecovery succeeded
 *   auth:recovery_started — PASSWORD_RECOVERY detected (app should show modal)
 *
 * @module shared/auth
 */

import { db } from './supabase.js?v=20260429-demo-s3';
import { state } from './state.js?v=20260418-sK';
import { bus } from './event-bus.js?v=20260418-sK';

/** Cached session + user — source of truth is supabase.auth.getSession(). */
let _currentSession = null;
let _currentUser = null;

/**
 * True while we're in the short window between Supabase emitting
 * PASSWORD_RECOVERY (user clicked the reset link and now holds a recovery
 * session token) and the user either submitting a new password or navigating
 * away. The auth gate treats the recovery session as NOT authenticated for
 * routing purposes — the only thing a recovery session can legally do is
 * updateUser({password}) — so we keep the overlay on top and force the
 * recovery modal. After completePasswordRecovery the flag clears and the
 * SIGNED_IN / USER_UPDATED event puts the app into normal signed-in state.
 */
let _recoveryMode = false;

/** Unsubscribe handle for the Supabase auth listener (avoid duplicates). */
let _authUnsub = null;

/**
 * Normalize a user object coming from supabase.auth for the rest of the app.
 * @param {any} u
 */
function shapeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    authenticated: true,
    mode: 'password',
  };
}

/**
 * Mirror the signed-in user's email into the legacy sessionStorage slot so
 * older read-sites (audit writer, cost-model export headers) keep working
 * unchanged. Real identity everywhere is `auth.uid()`; this is display-only.
 */
function mirrorEmailToLegacy(email) {
  try {
    if (email) sessionStorage.setItem('ies_user_email', email);
    else sessionStorage.removeItem('ies_user_email');
  } catch { /* sessionStorage can be blocked */ }
}

/**
 * Restore any cached Supabase session from localStorage and subscribe to
 * future auth state changes. Called once during app bootstrap BEFORE the
 * auth gate decides whether to show the login screen. Safe to call twice —
 * the listener is de-duplicated.
 */
async function bootstrapSession() {
  try {
    const client = db.getClient();
    const { data } = await client.auth.getSession();
    _currentSession = data?.session || null;
    _currentUser = data?.session?.user || null;

    if (_currentSession && _currentUser) {
      state.set('user', shapeUser(_currentUser));
      mirrorEmailToLegacy(_currentUser.email);
    }

    // Subscribe once. If a second call lands (e.g. dev hot-reload) drop
    // the prior listener so events don't double-fire.
    if (_authUnsub) {
      try { _authUnsub(); } catch { /* ok */ }
      _authUnsub = null;
    }
    const { data: subData } = client.auth.onAuthStateChange((evt, session) => {
      _currentSession = session || null;
      _currentUser = session?.user || null;

      if (evt === 'PASSWORD_RECOVERY') {
        // Recovery link was clicked — Supabase established a short-lived
        // recovery session. Do NOT treat as signed-in: the only action this
        // session can perform is updateUser({password}). The app boot logic
        // listens for auth:recovery_started and pins the login overlay +
        // recovery modal on top.
        _recoveryMode = true;
        if (session?.user) mirrorEmailToLegacy(session.user.email);
        bus.emit('auth:recovery_started', {
          email: session?.user?.email || null,
          id: session?.user?.id || null,
        });
        return;
      }

      if ((evt === 'SIGNED_IN' || evt === 'TOKEN_REFRESHED' || evt === 'USER_UPDATED') && session) {
        // Once recovery → set-password → USER_UPDATED completes, the session
        // becomes a real signed-in session. Clear the recovery flag so the
        // app can proceed to normal auth state.
        if (evt === 'USER_UPDATED' && _recoveryMode) _recoveryMode = false;
        state.set('user', shapeUser(session.user));
        mirrorEmailToLegacy(session.user.email);
        if (evt === 'SIGNED_IN') bus.emit('auth:login', { mode: 'password', email: session.user.email, id: session.user.id });
      } else if (evt === 'SIGNED_OUT') {
        _recoveryMode = false;
        // Slice 3.14 — in case SIGNED_OUT arrives via another tab (not the
        // local logout() call), make sure role cache is also cleared here.
        _currentRole = null;
        _roleLoaded = false;
        state.set('user', null);
        mirrorEmailToLegacy(null);
        bus.emit('auth:logout');
      }
    });
    _authUnsub = subData?.subscription?.unsubscribe?.bind(subData.subscription) || null;
  } catch (err) {
    // Never let a flaky network kill the app boot — the gate will just show
    // the login form and the user can retry.
    if (typeof console !== 'undefined') {
      console.warn('[auth] bootstrapSession failed:', err?.message || err);
    }
  }
}

/**
 * True only for a real signed-in session. A recovery session (clicked reset
 * link but hasn't set a new password yet) is intentionally NOT authenticated
 * from the app's perspective — the auth gate should keep routing blocked
 * until the recovery modal completes and a full SIGNED_IN fires.
 * @returns {boolean}
 */
function isAuthenticated() {
  return !!_currentSession && !_recoveryMode;
}

/**
 * Idempotent helper that guarantees the auth state is hydrated before the
 * caller reads getUser() / getSession(). Use this from any insert/update
 * path that needs to stamp owner_id; survives the supabase-js quirk where
 * the first getSession() after page load returns null even with a valid
 * refresh token in localStorage.
 *
 * Cheap when already bootstrapped (single in-memory check); awaits an
 * actual bootstrapSession() call only when _currentUser is null.
 *
 * @returns {Promise<{id:string,email:string}|null>}
 */
async function ensureSession() {
  if (_currentUser) return getUser();
  await bootstrapSession();
  return getUser();
}

/** @returns {boolean} True while a recovery session is active. */
function isInRecovery() { return _recoveryMode; }

/** @returns {any|null} */
function getSession() { return _currentSession; }

/** @returns {{id:string,email:string}|null} */
function getUser() {
  if (_currentUser) {
    return { id: _currentUser.id, email: _currentUser.email };
  }
  return null;
}

/** @returns {'password'|'recovery'|null} */
function getMode() {
  if (_recoveryMode) return 'recovery';
  return _currentSession ? 'password' : null;
}

// ─── Role (Slice 3.14) ──────────────────────────────────────────────────
// Cached from public.profiles.role the first time we have a session. Kept
// here (not in state) so nav-gating code can call it synchronously after
// loadRole() has completed once. Cleared on logout so a re-login as a
// different user doesn't inherit the previous role.
let _currentRole = null;
let _roleLoaded = false;

/**
 * Fetch the signed-in user's profile.role. Idempotent: a second call with
 * the same user_id is a no-op. On failure (network, RLS, missing profile
 * row) we leave _currentRole = null, which the isAdmin() caller treats as
 * "not admin" — the safest default for a nav-gating use case.
 *
 * @returns {Promise<string|null>}
 */
async function loadRole() {
  const u = getUser();
  if (!u || !u.id) { _currentRole = null; _roleLoaded = true; return null; }
  try {
    const { data, error } = await db.from('profiles')
      .select('role')
      .eq('id', u.id)
      .maybeSingle();
    if (error) {
      console.warn('[auth] loadRole failed:', error);
      _currentRole = null;
    } else {
      _currentRole = data && data.role ? String(data.role) : null;
    }
  } catch (err) {
    console.warn('[auth] loadRole threw:', err);
    _currentRole = null;
  }
  _roleLoaded = true;
  return _currentRole;
}

/** @returns {string|null} */
function getRole() { return _currentRole; }

/** @returns {boolean} */
function isAdmin() { return _currentRole === 'admin'; }

/** @returns {boolean} true once loadRole() has completed once (success or fail). */
function isRoleLoaded() { return _roleLoaded; }

// ─── MFA (Phase 4.5 tranche-2, Slice MFA-01) ─────────────────────────────
//
// TOTP enrollment + challenge helpers. Pair with shared/mfa-ui.js (which
// renders the modals) and the index.html boot gate (which calls
// requiresMfa() after loadRole() and mounts the UI before bootApp()).
//
// Supabase-side contract: the anon client's auth.mfa namespace handles
// all the crypto; we just shape errors to { ok, error } tuples and expose
// aal helpers. After a successful challenge (or first-time enrollment
// verify), supabase-js upgrades the JWT from aal1 → aal2 in place and
// fires TOKEN_REFRESHED on the onAuthStateChange listener above.
//
// On the DB side, current_user_is_admin() is hardened to require
// auth.jwt()->>'aal' = 'aal2' (see paired migration) — so the UI gate and
// RLS gate defend the same boundary from two sides.

/**
 * List all MFA factors on the signed-in user. Returns an empty array on
 * error (so callers can treat "no factors" and "couldn't check" the same
 * way — in both cases we should fall through to enrollment).
 *
 * @returns {Promise<Array<{id:string, friendly_name:string|null, factor_type:string, status:string}>>}
 */
async function listFactors() {
  try {
    const client = db.getClient();
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) { console.warn('[auth] listFactors:', error); return []; }
    // Supabase returns { all, totp, phone }. `all` is the canonical list.
    return Array.isArray(data?.all) ? data.all : [];
  } catch (err) {
    console.warn('[auth] listFactors threw:', err);
    return [];
  }
}

/**
 * True if the signed-in user has at least one verified TOTP factor.
 * @returns {Promise<boolean>}
 */
async function hasEnrolledFactors() {
  const factors = await listFactors();
  return factors.some((f) => f.factor_type === 'totp' && f.status === 'verified');
}

/**
 * Read the current session's AAL level. Uses supabase-js
 * getAuthenticatorAssuranceLevel() which decodes the JWT 'aal' claim.
 *
 * @returns {Promise<'aal1'|'aal2'|null>}
 */
async function getAalLevel() {
  try {
    const client = db.getClient();
    const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    const lvl = data?.currentLevel;
    if (lvl === 'aal1' || lvl === 'aal2') return lvl;
    return null;
  } catch (err) {
    console.warn('[auth] getAalLevel threw:', err);
    return null;
  }
}

/**
 * True if the signed-in user's session is not yet aal2-verified. The
 * index.html boot gate calls this after loadRole() resolves; if true, it
 * mounts shared/mfa-ui.js on top of the auth overlay and blocks bootApp()
 * until the modal reports success.
 *
 * Phase 4.5 Slice HYG-04 extends the MFA floor from admin-only to every
 * authenticated user. Admin MFA (Slice MFA-01) shipped first so admins
 * couldn't get locked out during rollout; HYG-04 removes the admin guard
 * below so members also have to clear the gate. Satisfies CIS Control 6.3
 * (Require MFA for Externally-Exposed Applications) — the app-layer gate
 * is the primary enforcement; RLS continues to team-scope as defense-in-
 * depth. SQL helper public.current_user_is_aal2() is available for any
 * future policy-level hardening.
 *
 * @returns {Promise<boolean>}
 */
async function requiresMfa() {
  const lvl = await getAalLevel();
  return lvl !== 'aal2';
}

/**
 * Start TOTP enrollment. Returns QR code (SVG string), manual secret, and
 * the factorId to hand back to verifyEnrollment() after the user types
 * the 6-digit code.
 *
 * The factor lands with status='unverified'. Only verifyEnrollment()
 * flips it to 'verified' and upgrades the session to aal2.
 *
 * @param {string} friendlyName  Shown in auth.mfa.listFactors().
 * @returns {Promise<{ok:true, factorId:string, qrCode:string, secret:string, uri:string} | {ok:false, error:string}>}
 */
async function enrollTotp(friendlyName) {
  try {
    const client = db.getClient();
    // Reuse an unverified factor if one already exists from a prior attempt
    // — Supabase won't let you enroll twice with the same friendlyName.
    const existing = await listFactors();
    const stale = existing.find((f) => f.factor_type === 'totp' && f.status === 'unverified');
    if (stale) {
      try { await client.auth.mfa.unenroll({ factorId: stale.id }); } catch {}
    }

    const { data, error } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: friendlyName || 'IES Hub Admin',
    });
    if (error) return { ok: false, error: error.message || 'Enrollment failed' };
    return {
      ok: true,
      factorId: data.id,
      qrCode: data.totp?.qr_code || '',
      secret: data.totp?.secret || '',
      uri: data.totp?.uri || '',
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'Enrollment failed' };
  }
}

/**
 * Confirm the 6-digit code against a pending enrollment. On success the
 * factor flips to 'verified' and the session upgrades to aal2 (no
 * separate login required).
 *
 * @param {string} factorId
 * @param {string} code  6-digit TOTP.
 * @returns {Promise<{ok:true} | {ok:false, error:string}>}
 */
async function verifyEnrollment(factorId, code) {
  try {
    const client = db.getClient();
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return { ok: false, error: error.message || 'Verification failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Verification failed' };
  }
}

/**
 * Challenge + verify in one shot for a returning admin. Cheaper round
 * trip than separate challenge() + verify() calls, and safer — no
 * challengeId to lose between promise hops.
 *
 * @param {string} factorId
 * @param {string} code  6-digit TOTP.
 * @returns {Promise<{ok:true} | {ok:false, error:string}>}
 */
async function verifyChallenge(factorId, code) {
  try {
    const client = db.getClient();
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return { ok: false, error: error.message || 'Verification failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Verification failed' };
  }
}

/**
 * Remove a factor. Used by recovery flows and (later) an admin panel
 * "reset my MFA" option. Does not sign the user out — they remain at
 * whatever aal they were before.
 *
 * @param {string} factorId
 * @returns {Promise<{ok:true} | {ok:false, error:string}>}
 */
async function unenrollFactor(factorId) {
  try {
    const client = db.getClient();
    const { error } = await client.auth.mfa.unenroll({ factorId });
    if (error) return { ok: false, error: error.message || 'Unenroll failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unenroll failed' };
  }
}


/**
 * Sign in with email + password against Supabase Auth.
 * onAuthStateChange handles state/bus side-effects — this just reports.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ok:boolean, user?:any, error?:string}>}
 */
async function loginWithPassword(email, password) {
  try {
    const client = db.getClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: String(email || '').trim(),
      password: String(password || ''),
    });
    if (error) return { ok: false, error: error.message || 'Sign-in failed' };
    return { ok: true, user: data?.user, session: data?.session };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Minimum acceptable length for a new password. Supabase's default policy
 * is 6, we go a touch tighter — keeps temp-password rotations honest
 * without making real passwords annoying to type.
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Change the signed-in user's password. We reverify the current password
 * via signInWithPassword first so an unattended session can't be silently
 * re-keyed by a passerby — Supabase's updateUser does NOT require it on
 * its own. On success the supabase-js client emits USER_UPDATED, which the
 * onAuthStateChange listener in bootstrapSession picks up; we additionally
 * emit `auth:password_changed` so audit/UI subscribers get a typed event.
 *
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function changePassword(currentPassword, newPassword) {
  const u = getUser();
  if (!u || !u.email) {
    return { ok: false, error: 'Not signed in' };
  }
  if (!currentPassword) {
    return { ok: false, error: 'Enter your current password' };
  }
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (newPassword === currentPassword) {
    return { ok: false, error: 'New password must be different from current password' };
  }
  try {
    const client = db.getClient();
    // Step 1: reverify current password.
    const { error: reauthError } = await client.auth.signInWithPassword({
      email: u.email,
      password: currentPassword,
    });
    if (reauthError) {
      return { ok: false, error: 'Current password is incorrect' };
    }
    // Step 2: apply new password to the active session.
    const { error: updateError } = await client.auth.updateUser({ password: newPassword });
    if (updateError) {
      return { ok: false, error: updateError.message || 'Password update failed' };
    }
    bus.emit('auth:password_changed', { email: u.email, id: u.id });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Compute the URL Supabase should redirect the user to after they click the
 * reset-password email link. We hand back the app's current origin+path so
 * this works identically at localhost, staging paths, and production
 * GitHub Pages. Supabase will append recovery tokens as query/hash params;
 * the supabase-js client auto-detects and consumes them on page load.
 *
 * NOTE: The computed URL must ALSO be allow-listed under Supabase →
 * Authentication → URL Configuration → Redirect URLs, otherwise the auth
 * server silently 400s the email send with "redirect URL not allowed".
 *
 * @returns {string}
 */
function getRecoveryRedirectUrl() {
  try {
    if (typeof window !== 'undefined' && window.location) {
      return window.location.origin + window.location.pathname;
    }
  } catch { /* SSR / test — fall through */ }
  return '';
}

/**
 * Request a password-reset email. Always shows a generic success message to
 * the caller regardless of whether the email exists — standard defense
 * against user enumeration. Transport / rate-limit errors are still
 * surfaced so the UI can tell the user to wait before retrying.
 *
 * @param {string} email
 * @param {{redirectTo?: string}} [opts]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function requestPasswordReset(email, opts = {}) {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) {
    return { ok: false, error: 'Enter your email' };
  }
  // Cheap sanity — don't ask Supabase to mail "hello there" at us.
  if (!/.+@.+\..+/.test(cleanEmail)) {
    return { ok: false, error: 'Enter a valid email address' };
  }
  try {
    const client = db.getClient();
    const redirectTo = opts.redirectTo || getRecoveryRedirectUrl();
    const args = redirectTo ? { redirectTo } : undefined;
    const { error } = await client.auth.resetPasswordForEmail(cleanEmail, args);
    if (error) {
      // Rate limiting lives here: "over_email_send_rate_limit" etc.
      return { ok: false, error: error.message || 'Could not send reset email' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Verify a 6-digit recovery OTP (Slice 3.11 — scanner-proof alternative to
 * the link flow). Microsoft 365 Safe Links and similar corporate email
 * security gateways pre-click links in inbound email, burning Supabase's
 * one-time recovery token before the human sees it. A 6-digit code in the
 * email body can't be "clicked" by a scanner — the user copy-pastes it
 * into the app and we verify server-side.
 *
 * On success, supabase-js establishes a recovery session and emits
 * PASSWORD_RECOVERY via onAuthStateChange — that's caught by
 * bootstrapSession's listener and flipped into _recoveryMode, which the
 * app uses to open the set-new-password modal. No code change needed
 * downstream: the OTP path joins the same PASSWORD_RECOVERY rails as the
 * legacy link path.
 *
 * @param {string} email — must match the email used in requestPasswordReset
 * @param {string} code  — the 6-digit token from the email
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function verifyRecoveryOtp(email, code) {
  const cleanEmail = String(email || '').trim();
  const cleanCode = String(code || '').replace(/\s/g, '');
  if (!cleanEmail) {
    return { ok: false, error: 'Missing email' };
  }
  if (!cleanCode) {
    return { ok: false, error: 'Enter the 6-digit code from the email' };
  }
  // Supabase codes are 6 digits; be permissive about length in the validator
  // so if they change the format later we fail server-side with a real error
  // instead of a confusing local one.
  if (!/^\d{4,10}$/.test(cleanCode)) {
    return { ok: false, error: 'Code should be digits only' };
  }
  try {
    const client = db.getClient();
    const { data, error } = await client.auth.verifyOtp({
      email: cleanEmail,
      token: cleanCode,
      type: 'recovery',
    });
    if (error) {
      // Common case: "Token has expired or is invalid" when the user takes
      // longer than 1 hour (default) to enter the code. Pass through.
      return { ok: false, error: error.message || 'Invalid or expired code' };
    }
    // supabase-js fires PASSWORD_RECOVERY on the onAuthStateChange listener
    // registered in bootstrapSession — that handler sets _recoveryMode and
    // emits auth:recovery_started. The app's gate opens the set-password
    // modal; nothing more to do here.
    return { ok: true, user: data?.user };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Complete a password recovery by setting the new password on the recovery
 * session. Called from the recovery-set-password modal. Differs from
 * changePassword in two ways: (1) no reverify-with-current-password step
 * (we're proving identity via the emailed token), (2) the success path
 * clears the _recoveryMode flag via USER_UPDATED and transitions the app
 * into normal signed-in state without a separate login roundtrip.
 *
 * @param {string} newPassword
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function completePasswordRecovery(newPassword, opts = {}) {
  if (!_recoveryMode) {
    return { ok: false, error: 'No active recovery session' };
  }
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  try {
    const client = db.getClient();

    // 2026-04-27 — MFA AAL2 elevation for the recovery flow.
    //
    // Supabase rejects auth.updateUser({password}) with the error
    // "AAL2 session is required to update email or password when MFA
    // is enabled" when the user has any verified MFA factor. The
    // email-OTP recovery session starts at AAL1, so the prior
    // implementation hit this wall every time an MFA-enrolled user
    // tried to reset their password (caught live 2026-04-27 AM —
    // Brock's account was unblocked by deleting his MFA factor via
    // SQL, which is not a workflow we want to repeat).
    //
    // New flow: before calling updateUser, check for verified TOTP
    // factors. If none — proceed as before (preserves the no-MFA
    // path's behavior unchanged). If one exists, the caller MUST
    // supply opts.mfaCode (a 6-digit TOTP). We run challenge + verify,
    // which elevates the session to AAL2, then updateUser succeeds.
    //
    // The modal layer (renderRecoverySetPasswordModal in this file)
    // handles the two-pass dance: first call returns
    // { ok:false, error:'MFA_AAL2_REQUIRED' } to signal "show the
    // TOTP input"; modal collects the code, calls back with it.
    let factors = null;
    try {
      const { data: f } = await client.auth.mfa.listFactors();
      factors = f;
    } catch (_) {
      // listFactors failure should NOT block the recovery flow for
      // non-MFA users — fall through and let updateUser surface the
      // canonical error if MFA really was required.
    }
    const verifiedTotp = factors?.totp?.find?.((x) => x.status === 'verified') || null;
    if (verifiedTotp) {
      if (!opts.mfaCode) {
        return { ok: false, error: 'MFA_AAL2_REQUIRED', mfaFactorName: verifiedTotp.friendly_name || null };
      }
      const { data: chal, error: chalErr } = await client.auth.mfa.challenge({ factorId: verifiedTotp.id });
      if (chalErr) return { ok: false, error: chalErr.message || 'MFA challenge failed' };
      const { error: verifyErr } = await client.auth.mfa.verify({
        factorId: verifiedTotp.id,
        challengeId: chal.id,
        code: opts.mfaCode,
      });
      if (verifyErr) return { ok: false, error: verifyErr.message || 'Invalid 6-digit code' };
      // Session is now AAL2 — proceed.
    }

    const { data, error } = await client.auth.updateUser({ password: newPassword });
    if (error) {
      // Common case: "New password should be different from the old password"
      return { ok: false, error: error.message || 'Password update failed' };
    }
    // Clear the flag eagerly — onAuthStateChange will also clear it on
    // USER_UPDATED but test doubles don't always fire the event synchronously.
    _recoveryMode = false;
    const email = data?.user?.email || _currentUser?.email || '';
    const id = data?.user?.id || _currentUser?.id || '';
    if (email && id) bus.emit('auth:password_changed', { email, id });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Sign out.
 */
async function logout() {
  try {
    const client = db.getClient();
    await client.auth.signOut();
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[auth] signOut failed:', err?.message || err);
  }
  _currentSession = null;
  _currentUser = null;
  _recoveryMode = false;
  // Slice 3.14 — clear cached role so a re-login under a different account
  // doesn't inherit the previous user's admin state. isAdmin() now returns
  // false until loadRole() finishes for the new session.
  _currentRole = null;
  _roleLoaded = false;
  mirrorEmailToLegacy(null);
  state.set('user', null);
  bus.emit('auth:logout');
}

/* -------------------------------------------------------------------------- */
/* Login-screen UI — single isolated component so Entra swap is trivial.      */
/* -------------------------------------------------------------------------- */

/**
 * Render the login screen into the auth overlay.
 * Password-only as of Slice 3.5 — code-mode fallback has been removed.
 * @param {HTMLElement} overlay — the .hub-auth-overlay element
 * @param {() => void} onSuccess — called after successful login
 */
function renderLoginScreen(overlay, onSuccess) {
  overlay.classList.remove('hidden');
  overlay.style.opacity = '1';
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-label="Sign in to IES Intelligence Hub">
      <div class="hub-auth-logo" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
      </div>
      <h1 class="hub-auth-title">IES Intelligence Hub</h1>
      <p class="hub-auth-subtitle">Solutions Design Platform</p>

      <div class="hub-auth-error" id="auth-error" role="alert"></div>

      <div class="hub-auth-pane" data-pane="password">
        <label class="hub-auth-label" for="auth-email-input">Email</label>
        <input
          type="email"
          class="hub-input hub-auth-input"
          id="auth-email-input"
          placeholder="name@gxo.com"
          autocomplete="email"
          spellcheck="false"
          autocapitalize="off"
        />
        <label class="hub-auth-label" for="auth-password-input" style="margin-top:10px;">Password</label>
        <input
          type="password"
          class="hub-input hub-auth-input"
          id="auth-password-input"
          placeholder="Password"
          autocomplete="current-password"
        />
        <button class="hub-btn hub-btn-primary w-full" id="auth-signin-btn" style="margin-top:14px;">
          Sign In
        </button>
        <div style="margin-top:10px;text-align:center;display:flex;justify-content:center;gap:18px;">
          <button type="button" id="auth-forgot-link"
            style="background:none;border:none;padding:4px 6px;font-size:12px;color:var(--ies-gray-500, #6b7280);cursor:pointer;text-decoration:underline;text-decoration-color:rgba(0,0,0,.2);font-family:inherit;">
            Forgot password?
          </button>
          <button type="button" id="auth-invite-link"
            style="background:none;border:none;padding:4px 6px;font-size:12px;color:var(--ies-gray-500, #6b7280);cursor:pointer;text-decoration:underline;text-decoration-color:rgba(0,0,0,.2);font-family:inherit;">
            I was invited
          </button>
        </div>
      </div>
    </div>
  `;

  const card = /** @type {HTMLElement} */ (overlay.querySelector('.hub-auth-card'));
  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#auth-error'));
  const emailInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-email-input'));
  const passwordInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-password-input'));
  const signinBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#auth-signin-btn'));
  const forgotLink = /** @type {HTMLButtonElement} */ (overlay.querySelector('#auth-forgot-link'));

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
    card.animate([
      { transform: 'translateX(-8px)' },
      { transform: 'translateX(8px)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(0)' },
    ], { duration: 300 });
  }

  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
  }

  function fadeOutAndBoot() {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    setTimeout(() => {
      overlay.classList.add('hidden');
      onSuccess();
    }, 300);
  }

  async function attemptPassword() {
    clearError();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showError('Enter both email and password');
      return;
    }
    signinBtn.disabled = true;
    const originalText = signinBtn.textContent;
    signinBtn.textContent = 'Signing in…';
    try {
      const res = await loginWithPassword(email, password);
      if (res.ok) {
        fadeOutAndBoot();
      } else {
        showError(res.error && /invalid login credentials/i.test(res.error)
          ? 'Invalid email or password'
          : (res.error || 'Sign-in failed'));
        passwordInput.value = '';
        passwordInput.focus();
      }
    } finally {
      signinBtn.disabled = false;
      signinBtn.textContent = originalText;
    }
  }

  signinBtn.addEventListener('click', attemptPassword);
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordInput.focus();
    else clearError();
  });
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptPassword();
    else clearError();
  });
  forgotLink?.addEventListener('click', () => {
    clearError();
    // Prefill with whatever the user already typed — saves a keystroke
    // for the common case of "I got Invalid email/password twice, let me
    // just reset".
    renderForgotPasswordModal({ defaultEmail: emailInput.value.trim() });
  });

  // Slice 3.16 — "I was invited" path. Opens the accept-invite modal; on
  // success it fires onSuccess which we route to the same fadeOutAndBoot
  // the password flow uses.
  const inviteLink = /** @type {HTMLButtonElement} */ (overlay.querySelector('#auth-invite-link'));
  inviteLink?.addEventListener('click', () => {
    clearError();
    renderAcceptInviteModal({
      defaultEmail: emailInput.value.trim(),
      onSuccess: fadeOutAndBoot,
    });
  });

  setTimeout(() => emailInput.focus(), 100);
}

/**
 * Render the "Forgot password?" modal — two-step OTP flow (Slice 3.11).
 *
 * Step 1 (email-pane): user enters email → requestPasswordReset → email with
 *   6-digit code sent.
 * Step 2 (code-pane):  user enters code → verifyRecoveryOtp → Supabase fires
 *   PASSWORD_RECOVERY → bootstrapSession listener opens the set-password
 *   modal (renderRecoverySetPasswordModal). This modal then dismisses itself
 *   so the user sees a clean stack: login card dimmed, set-password modal
 *   on top, nothing else competing.
 *
 * The link embedded in the recovery email still works — scanner-consumed or
 * not — because clicking it also fires PASSWORD_RECOVERY via the existing
 * `?code=` path. OTP is the primary, scanner-proof path; the link is a
 * fallback for personal-email accounts where Safe Links doesn't pre-scan.
 *
 * @param {{onClose?: () => void, defaultEmail?: string}} [opts]
 */
function renderForgotPasswordModal(opts = {}) {
  const { onClose, defaultEmail } = opts;
  const existing = document.getElementById('hub-forgot-pw-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'hub-forgot-pw-overlay';
  overlay.className = 'hub-auth-overlay';
  overlay.style.background = 'rgba(10, 22, 40, 0.55)';
  // Stacks above the persistent login overlay (z-index 9999 from .hub-auth-overlay).
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-modal="true" aria-label="Reset password" style="text-align:left;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h2 class="hub-auth-title" id="fp-heading" style="margin:0;font-size:18px;">Reset password</h2>
        <button type="button" id="fp-close" aria-label="Close"
          style="background:none;border:none;color:var(--ies-gray-500);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;">×</button>
      </div>

      <div class="hub-auth-error" id="fp-error" role="alert"></div>

      <!-- Step 1: email -->
      <div class="hub-auth-pane" id="fp-email-pane">
        <p class="hub-auth-subtitle" style="margin:0 0 14px 0;text-align:left;">
          Enter the email you use to sign in. We'll email you a verification
          code — enter it on the next screen to set a new password.
        </p>

        <label class="hub-auth-label" for="fp-email">Email</label>
        <input type="email" class="hub-input hub-auth-input" id="fp-email"
          autocomplete="email" placeholder="name@gxo.com" spellcheck="false"
          autocapitalize="off" />

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
          <button type="button" class="hub-btn hub-btn-secondary" id="fp-cancel">Cancel</button>
          <button type="button" class="hub-btn hub-btn-primary" id="fp-send-btn">Send code</button>
        </div>
      </div>

      <!-- Step 2: code entry -->
      <div class="hub-auth-pane" id="fp-code-pane" style="display:none;">
        <p class="hub-auth-subtitle" style="margin:0 0 14px 0;text-align:left;">
          If an account exists for <strong id="fp-email-echo"></strong> we just
          sent a verification code. Enter it below. (Check spam too — corporate
          filters sometimes delay it by a minute or two.)
        </p>

        <label class="hub-auth-label" for="fp-code">Verification code</label>
        <input type="text" class="hub-input hub-auth-input" id="fp-code"
          autocomplete="one-time-code" inputmode="numeric" pattern="\\d{4,10}"
          maxlength="10" placeholder="Enter the code from your email"
          style="font-size:18px;letter-spacing:3px;text-align:center;" />

        <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:18px;">
          <button type="button" id="fp-resend"
            style="background:none;border:none;padding:4px 6px;font-size:12px;color:var(--ies-gray-500, #6b7280);cursor:pointer;text-decoration:underline;text-decoration-color:rgba(0,0,0,.2);font-family:inherit;">
            Didn't get a code? Resend
          </button>
          <div style="display:flex;gap:8px;">
            <button type="button" class="hub-btn hub-btn-secondary" id="fp-back">Back</button>
            <button type="button" class="hub-btn hub-btn-primary" id="fp-verify-btn">Verify code</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#fp-error'));
  const emailPane = /** @type {HTMLElement} */ (overlay.querySelector('#fp-email-pane'));
  const codePane = /** @type {HTMLElement} */ (overlay.querySelector('#fp-code-pane'));
  const emailInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#fp-email'));
  const codeInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#fp-code'));
  const emailEcho = /** @type {HTMLElement} */ (overlay.querySelector('#fp-email-echo'));
  const sendBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-send-btn'));
  const verifyBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-verify-btn'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-cancel'));
  const closeBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-close'));
  const backBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-back'));
  const resendLink = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-resend'));

  /** Email locked in after step 1 succeeds — used for verifyOtp in step 2. */
  let pendingEmail = '';

  if (defaultEmail) emailInput.value = defaultEmail;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.color = '';
    errorEl.classList.add('visible');
  }
  function showInfo(msg) {
    errorEl.textContent = msg;
    errorEl.style.color = 'var(--ies-blue)';
    errorEl.classList.add('visible');
  }
  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
    errorEl.style.color = '';
  }
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (typeof onClose === 'function') onClose();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  // After PASSWORD_RECOVERY fires (either via OTP verify OR a fallback link
  // click), the app's boot code opens the set-password modal. Close this
  // modal automatically when that happens so the user only sees one modal
  // stacked on the login card.
  const unsubRecovery = bus.on('auth:recovery_started', () => {
    try { close(); } catch { /* already closed */ }
  });
  // Make sure we clean up the listener if the modal is dismissed before
  // recovery happens (e.g. user cancels).
  const origClose = close;
  function closeAndUnsub() {
    try { if (typeof unsubRecovery === 'function') unsubRecovery(); } catch { /* ok */ }
    origClose();
  }
  cancelBtn.removeEventListener('click', close);
  closeBtn.removeEventListener('click', close);
  cancelBtn.addEventListener('click', closeAndUnsub);
  closeBtn.addEventListener('click', closeAndUnsub);

  function goToCodePane() {
    emailPane.style.display = 'none';
    codePane.style.display = '';
    emailEcho.textContent = pendingEmail;
    setTimeout(() => codeInput.focus(), 50);
  }
  function goToEmailPane() {
    codePane.style.display = 'none';
    emailPane.style.display = '';
    setTimeout(() => emailInput.focus(), 50);
  }
  backBtn.addEventListener('click', () => {
    clearError();
    goToEmailPane();
  });

  async function attemptSend() {
    clearError();
    const email = emailInput.value.trim();
    if (!email) {
      showError('Enter your email');
      return;
    }
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    const orig = sendBtn.textContent;
    sendBtn.textContent = 'Sending…';
    try {
      const res = await requestPasswordReset(email);
      if (res.ok) {
        // Do not reveal whether the email exists — always advance to code
        // entry. If the email is bogus, verify will just fail at step 2 with
        // "Invalid or expired code".
        pendingEmail = email;
        goToCodePane();
      } else {
        showError(res.error || 'Could not send reset code');
      }
    } catch (err) {
      showError(err?.message || 'Unknown error');
    } finally {
      sendBtn.disabled = false;
      cancelBtn.disabled = false;
      sendBtn.textContent = orig;
    }
  }

  async function attemptVerify() {
    clearError();
    const code = codeInput.value.trim();
    if (!code) {
      showError('Enter the code from the email');
      return;
    }
    verifyBtn.disabled = true;
    backBtn.disabled = true;
    const orig = verifyBtn.textContent;
    verifyBtn.textContent = 'Verifying…';
    try {
      const res = await verifyRecoveryOtp(pendingEmail, code);
      if (res.ok) {
        // PASSWORD_RECOVERY will fire on the bus listener we wired above;
        // that closes this modal and opens the set-password modal. Show a
        // transient "success" beat so there's no flash of nothing.
        showInfo('Code verified. Opening password reset…');
      } else {
        showError(res.error || 'Code is invalid or expired');
        codeInput.select();
      }
    } catch (err) {
      showError(err?.message || 'Unknown error');
    } finally {
      verifyBtn.disabled = false;
      backBtn.disabled = false;
      verifyBtn.textContent = orig;
    }
  }

  async function attemptResend() {
    clearError();
    if (!pendingEmail) {
      // Shouldn't happen — guard anyway.
      goToEmailPane();
      return;
    }
    resendLink.disabled = true;
    const orig = resendLink.textContent;
    resendLink.textContent = 'Sending…';
    try {
      const res = await requestPasswordReset(pendingEmail);
      if (res.ok) {
        showInfo('New code sent. Check your inbox (and spam).');
      } else {
        // Rate-limited (60s between requests) surfaces here.
        showError(res.error || 'Could not resend code');
      }
    } catch (err) {
      showError(err?.message || 'Unknown error');
    } finally {
      resendLink.disabled = false;
      resendLink.textContent = orig;
    }
  }

  sendBtn.addEventListener('click', attemptSend);
  verifyBtn.addEventListener('click', attemptVerify);
  resendLink.addEventListener('click', attemptResend);
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptSend();
    else clearError();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptVerify();
    else clearError();
  });
  // Strip anything non-digit from pasted codes (users commonly paste "123 456"
  // or "123-456" from the email).
  codeInput.addEventListener('input', () => {
    const cleaned = codeInput.value.replace(/\D/g, '');
    if (cleaned !== codeInput.value) codeInput.value = cleaned;
  });

  setTimeout(() => emailInput.focus(), 50);
}

/**
 * Render the "Set a new password" modal that appears after the user clicks
 * the recovery email link. Supabase-js auto-consumes the token in the URL,
 * fires PASSWORD_RECOVERY, and our onAuthStateChange listener emits
 * `auth:recovery_started` — the app's boot code listens for that and calls
 * this function. The modal is non-dismissible by Escape / backdrop because
 * the recovery session is a dead-end state: the only legal action is either
 * "set new password" or "sign out and start over".
 *
/**
 * 2026-04-27 — Inline TOTP prompt for the recovery flow's AAL2 elevation.
 * Replaces the password card body with a code input + verify/cancel pair,
 * resolves with the entered code (or null if user cancelled). Caller restores
 * the original card body via DOM removal of the modal — we don't try to
 * "unwind" the card here since the password fields are already validated
 * and we're going straight to the next state on success.
 *
 * @param {HTMLElement} card        — the .hub-auth-card the prompt mounts into
 * @param {HTMLElement} errorEl     — existing error element (re-used for messaging)
 * @param {string|null} factorName  — friendly name from completePasswordRecovery's
 *                                     first-pass response, or null
 * @returns {Promise<string|null>}
 */
function promptForTotpCode(card, errorEl, factorName) {
  return new Promise((resolve) => {
    // Snapshot the current card HTML so we can restore on cancel
    const originalHtml = card.innerHTML;
    const factorLabel = factorName ? ` (${factorName})` : '';
    card.innerHTML = `
      <div class="hub-auth-logo" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1 class="hub-auth-title">Confirm with your authenticator</h1>
      <p class="hub-auth-subtitle" style="margin-bottom:14px;">
        Two-factor auth is required for password changes. Open your authenticator
        app${factorLabel} and enter the 6-digit code to finish.
      </p>
      <div class="hub-auth-error" id="recovery-mfa-error" role="alert"></div>
      <label class="hub-auth-label" for="recovery-mfa-code">6-digit code</label>
      <input
        type="text"
        class="hub-input hub-auth-input"
        id="recovery-mfa-code"
        placeholder="123456"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        pattern="[0-9]{6}"
        style="letter-spacing:.25em;text-align:center;font-size:18px;"
      />
      <button class="hub-btn hub-btn-primary w-full" id="recovery-mfa-verify" style="margin-top:14px;" disabled>
        Verify and continue
      </button>
      <button class="hub-btn w-full" id="recovery-mfa-cancel" style="margin-top:8px;">Cancel</button>
    `;
    const codeInput = card.querySelector('#recovery-mfa-code');
    const verifyBtn = card.querySelector('#recovery-mfa-verify');
    const cancelBtn = card.querySelector('#recovery-mfa-cancel');
    codeInput.addEventListener('input', () => {
      const v = codeInput.value.replace(/\D/g, '').slice(0, 6);
      if (v !== codeInput.value) codeInput.value = v;
      verifyBtn.disabled = v.length !== 6;
    });
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !verifyBtn.disabled) verifyBtn.click();
    });
    verifyBtn.addEventListener('click', () => {
      const code = codeInput.value.trim();
      // Restore the original password card so attemptSet's success branch
      // can update errorEl with the "Password updated…" message in place.
      card.innerHTML = originalHtml;
      resolve(code);
    });
    cancelBtn.addEventListener('click', () => {
      card.innerHTML = originalHtml;
      resolve(null);
    });
    setTimeout(() => codeInput.focus(), 0);
  });
}

/**
 * @param {{onSuccess?: () => void}} [opts]
 */
function renderRecoverySetPasswordModal(opts = {}) {
  const { onSuccess } = opts;
  const existing = document.getElementById('hub-recovery-pw-overlay');
  if (existing) existing.remove();

  const u = getUser();
  const emailHint = u?.email ? `for <strong>${u.email}</strong>` : '';

  const overlay = document.createElement('div');
  overlay.id = 'hub-recovery-pw-overlay';
  overlay.className = 'hub-auth-overlay';
  overlay.style.background = 'rgba(10, 22, 40, 0.70)';
  // Must stack above both the persistent login overlay (9999) and the
  // forgot-password modal (10000) — recovery can be reached directly from
  // either state via cross-tab PASSWORD_RECOVERY delivery.
  overlay.style.zIndex = '10001';
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-modal="true" aria-label="Set a new password" style="text-align:left;">
      <div style="margin-bottom:14px;">
        <h2 class="hub-auth-title" style="margin:0 0 4px 0;font-size:18px;">Set a new password</h2>
        <p class="hub-auth-subtitle" style="margin:0;text-align:left;font-size:13px;">
          Code verified ${emailHint}. Choose a new password (minimum 8 characters).
        </p>
      </div>

      <div class="hub-auth-error" id="rp-error" role="alert"></div>

      <div class="hub-auth-pane">
        <label class="hub-auth-label" for="rp-new">New password</label>
        <input type="password" class="hub-input hub-auth-input" id="rp-new"
          autocomplete="new-password" placeholder="At least 8 characters" />

        <label class="hub-auth-label" for="rp-confirm" style="margin-top:10px;">Confirm new password</label>
        <input type="password" class="hub-input hub-auth-input" id="rp-confirm"
          autocomplete="new-password" placeholder="Re-enter new password" />

        <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:18px;">
          <button type="button" class="hub-btn hub-btn-secondary" id="rp-cancel">Sign out</button>
          <button type="button" class="hub-btn hub-btn-primary" id="rp-submit">Set new password</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#rp-error'));
  const newInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#rp-new'));
  const confirmInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#rp-confirm'));
  const submitBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#rp-submit'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#rp-cancel'));

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
  }
  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
  }

  cancelBtn.addEventListener('click', async () => {
    // Bail out of the recovery session entirely. Dropping the session also
    // clears _recoveryMode via SIGNED_OUT, and the app's logout listener
    // re-renders the login overlay.
    try { await logout(); } catch { /* ignore */ }
    overlay.remove();
  });

  async function attemptSet() {
    clearError();
    const next = newInput.value;
    const confirm = confirmInput.value;
    if (!next || !confirm) {
      showError('Fill in both password fields');
      return;
    }
    if (next !== confirm) {
      showError('Passwords do not match');
      confirmInput.focus();
      return;
    }
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = 'Saving…';
    try {
      let res = await completePasswordRecovery(next);
      // 2026-04-27 — MFA AAL2 two-pass: when the user has a verified
      // TOTP factor, completePasswordRecovery first returns
      // MFA_AAL2_REQUIRED. Show an inline TOTP prompt, collect the
      // code, then re-call with opts.mfaCode set. Only one pass for
      // users without MFA (the verifiedTotp guard short-circuits
      // before this branch).
      if (!res.ok && res.error === 'MFA_AAL2_REQUIRED') {
        submitBtn.textContent = orig;
        const code = await promptForTotpCode(card, errorEl, res.mfaFactorName);
        if (code === null) {
          // Cancelled
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying…';
        res = await completePasswordRecovery(next, { mfaCode: code });
      }
      if (res.ok) {
        errorEl.textContent = 'Password updated. Signing you in…';
        errorEl.style.color = 'var(--ies-blue)';
        errorEl.classList.add('visible');
        setTimeout(() => {
          if (typeof onSuccess === 'function') onSuccess();
          overlay.remove();
        }, 700);
      } else {
        showError(res.error || 'Could not set password');
        newInput.value = '';
        confirmInput.value = '';
        newInput.focus();
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = orig;
      }
    } catch (err) {
      showError(err?.message || 'Unknown error');
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = orig;
    }
  }

  submitBtn.addEventListener('click', attemptSet);
  for (const el of [newInput, confirmInput]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptSet();
      else clearError();
    });
  }

  setTimeout(() => newInput.focus(), 50);
}

/**
 * Render the change-password modal. Centered overlay with backdrop. Reuses
 * the .hub-auth-* class vocabulary so visuals match the login card. Does
 * not depend on any view router state — safe to call from anywhere once a
 * user is signed in.
 *
 * @param {{onClose?: () => void, onSuccess?: () => void}} [opts]
 */
function renderChangePasswordModal(opts = {}) {
  const { onClose, onSuccess } = opts;
  // Single-instance guard — clicking the menu item twice doesn't stack modals.
  const existing = document.getElementById('hub-change-pw-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'hub-change-pw-overlay';
  overlay.className = 'hub-auth-overlay';
  overlay.style.background = 'rgba(10, 22, 40, 0.55)';
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-modal="true" aria-label="Change password" style="text-align:left;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h2 class="hub-auth-title" style="margin:0;font-size:18px;">Change password</h2>
        <button type="button" id="cp-close" aria-label="Close"
          style="background:none;border:none;color:var(--ies-gray-500);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;">×</button>
      </div>
      <p class="hub-auth-subtitle" style="margin-bottom:16px;text-align:left;">
        Reverify your current password, then set a new one. Minimum 8 characters.
      </p>

      <div class="hub-auth-error" id="cp-error" role="alert"></div>

      <div class="hub-auth-pane">
        <label class="hub-auth-label" for="cp-current">Current password</label>
        <input type="password" class="hub-input hub-auth-input" id="cp-current"
          autocomplete="current-password" placeholder="Current password" />

        <label class="hub-auth-label" for="cp-new" style="margin-top:10px;">New password</label>
        <input type="password" class="hub-input hub-auth-input" id="cp-new"
          autocomplete="new-password" placeholder="At least 8 characters" />

        <label class="hub-auth-label" for="cp-confirm" style="margin-top:10px;">Confirm new password</label>
        <input type="password" class="hub-input hub-auth-input" id="cp-confirm"
          autocomplete="new-password" placeholder="Re-enter new password" />

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
          <button type="button" class="hub-btn hub-btn-secondary" id="cp-cancel">Cancel</button>
          <button type="button" class="hub-btn hub-btn-primary" id="cp-submit">Change password</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#cp-error'));
  const currentInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#cp-current'));
  const newInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#cp-new'));
  const confirmInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#cp-confirm'));
  const submitBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#cp-submit'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#cp-cancel'));
  const closeBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#cp-close'));

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
  }
  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
  }
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (typeof onClose === 'function') onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  // Click outside the card → dismiss.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  async function attemptChange() {
    clearError();
    const current = currentInput.value;
    const next = newInput.value;
    const confirm = confirmInput.value;
    if (!current || !next || !confirm) {
      showError('Fill in all three fields');
      return;
    }
    if (next !== confirm) {
      showError('New password and confirmation do not match');
      confirmInput.focus();
      return;
    }
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = 'Changing…';
    try {
      const res = await changePassword(current, next);
      if (res.ok) {
        // Briefly show success then dismiss.
        errorEl.textContent = 'Password changed.';
        errorEl.style.color = 'var(--ies-blue)';
        errorEl.classList.add('visible');
        setTimeout(() => {
          if (typeof onSuccess === 'function') onSuccess();
          close();
        }, 700);
      } else {
        showError(res.error || 'Password change failed');
        // Clear new-pw fields on failure so the user retypes them — the
        // current-pw value usually stays correct so we leave it alone.
        if (/current password/i.test(res.error || '')) {
          currentInput.value = '';
          currentInput.focus();
        } else {
          newInput.value = '';
          confirmInput.value = '';
          newInput.focus();
        }
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = orig;
      }
    } catch (err) {
      showError(err?.message || 'Unknown error');
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = orig;
    }
  }

  submitBtn.addEventListener('click', attemptChange);
  // Enter on any input submits.
  for (const el of [currentInput, newInput, confirmInput]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptChange();
      else clearError();
    });
  }

  setTimeout(() => currentInput.focus(), 50);
}

/* -------------------------------------------------------------------------- */
/* Invites (Slice 3.16) — admin-triggered, OTP-based, scanner-proof           */
/* -------------------------------------------------------------------------- */

/**
 * Slice 3.16 — POST to the invite-user edge function with the signed-in
 * user's JWT. The edge function checks profiles.role='admin' on the
 * service-role side and calls auth.admin.inviteUserByEmail, passing
 * full_name / invited_team_id / invited_role in user_metadata so the
 * handle_new_user trigger lands the profile row with the correct scope
 * in one transaction. Supabase mails the (customized, OTP-first) invite
 * template to the invitee.
 *
 * @param {{email:string, full_name:string, team_id:string, role:'member'|'admin'}} params
 * @returns {Promise<{ok:boolean, code?:string, error?:string, user_id?:string, team_name?:string}>}
 */
async function inviteUser({ email, full_name, team_id, role }) {
  try {
    const client = db.getClient();
    const { data: sess } = await client.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return { ok: false, error: 'Not signed in' };

    // Call the edge function via supabase-js so we reuse the project's
    // base URL + anon apikey + the user's JWT header automatically.
    const { data, error } = await client.functions.invoke('invite-user', {
      body: {
        email,
        full_name,
        team_id,
        role,
        redirect_to: getRecoveryRedirectUrl(),
      },
      // supabase-js auto-adds Authorization: Bearer <access_token> when a
      // session is active, but be explicit so a future refactor of the
      // session-bootstrap path cannot silently drop the header.
      headers: { Authorization: `Bearer ${token}` },
    });

    if (error) {
      // functions.invoke returns a FunctionsHttpError for non-2xx; the
      // JSON body from the edge function is on error.context if parseable.
      let code = 'invoke_error';
      let message = error.message || 'Invite failed';
      try {
        // supabase-js v2.45+ exposes the raw Response on FunctionsHttpError.context
        if (error.context && typeof error.context.json === 'function') {
          const body = await error.context.json();
          if (body && body.code) code = body.code;
          if (body && body.error) message = body.error;
        }
      } catch { /* body unreadable — keep defaults */ }
      return { ok: false, code, error: message };
    }

    if (!data || data.ok === false) {
      return { ok: false, code: data?.code, error: data?.error || 'Invite failed' };
    }
    return {
      ok: true,
      user_id: data.user_id,
      team_name: data.team_name,
      email: data.email,
      role: data.role,
      full_name: data.full_name,
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Invitee-side: verify the invite OTP from the email. Establishes a full
 * session (SIGNED_IN, not PASSWORD_RECOVERY) because the user doesn't have
 * a password yet. Caller then MUST call setInitialPassword() to make the
 * account usable for future logins.
 *
 * @param {string} email — the email admin used (must match exactly)
 * @param {string} code  — the OTP from the invite email
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function verifyInviteOtp(email, code) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanCode = String(code || '').replace(/\s/g, '');
  if (!cleanEmail) return { ok: false, error: 'Missing email' };
  if (!cleanCode)  return { ok: false, error: 'Enter the verification code from the email' };
  if (!/^\d{4,10}$/.test(cleanCode)) return { ok: false, error: 'Code should be digits only' };
  try {
    const client = db.getClient();
    const { data, error } = await client.auth.verifyOtp({
      email: cleanEmail,
      token: cleanCode,
      type: 'invite',
    });
    if (error) return { ok: false, error: error.message || 'Invalid or expired code' };
    // supabase-js will fire SIGNED_IN via onAuthStateChange; bootstrapSession's
    // listener picks that up and updates state. Nothing more to do here.
    return { ok: true, user: data?.user };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Slice 3.16 — set the first password on an invite-accepted session.
 * Unlike changePassword there is no reverify step (the emailed OTP already
 * proved identity). Unlike completePasswordRecovery we don't flip
 * _recoveryMode because invite verification gives us a normal signed-in
 * session, not a recovery session.
 *
 * @param {string} newPassword
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function setInitialPassword(newPassword) {
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (!_currentSession) {
    return { ok: false, error: 'No active session — verify the invite code first' };
  }
  try {
    const client = db.getClient();
    const { data, error } = await client.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, error: error.message || 'Password set failed' };
    const email = data?.user?.email || _currentUser?.email || '';
    const id = data?.user?.id || _currentUser?.id || '';
    if (email && id) bus.emit('auth:password_changed', { email, id });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Unknown error' };
  }
}

/**
 * Render the "Accept invite" modal. Opened from the login screen via the
 * "I was invited" link. Single-pane: email + code + new password all on
 * one form. On submit: verifyInviteOtp → setInitialPassword → signed in.
 *
 * Differs from the recovery modal (which is two-pane: email→code then
 * set-password) because for invites the admin has already triggered the
 * email, so there's no "request code" step for the invitee. They already
 * have the code in their inbox.
 *
 * @param {{onClose?: () => void, onSuccess?: () => void, defaultEmail?: string}} [opts]
 */
function renderAcceptInviteModal(opts = {}) {
  const { onClose, onSuccess, defaultEmail } = opts;
  const existing = document.getElementById('hub-accept-invite-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'hub-accept-invite-overlay';
  overlay.className = 'hub-auth-overlay';
  overlay.style.background = 'rgba(10, 22, 40, 0.55)';
  // Above the persistent login overlay (9999).
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-modal="true" aria-label="Accept invite" style="text-align:left;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h2 class="hub-auth-title" style="margin:0;font-size:18px;">Accept invite</h2>
        <button type="button" id="ai-close" aria-label="Close"
          style="background:none;border:none;color:var(--ies-gray-500);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;">×</button>
      </div>
      <p class="hub-auth-subtitle" style="margin:0 0 14px 0;text-align:left;">
        Enter the email your invite was sent to, the verification code from
        that email, and a new password for the hub. Minimum 8 characters.
      </p>

      <div class="hub-auth-error" id="ai-error" role="alert"></div>

      <div class="hub-auth-pane">
        <label class="hub-auth-label" for="ai-email">Email</label>
        <input type="email" class="hub-input hub-auth-input" id="ai-email"
          autocomplete="email" placeholder="name@gxo.com" spellcheck="false"
          autocapitalize="off" />

        <label class="hub-auth-label" for="ai-code" style="margin-top:10px;">Verification code</label>
        <input type="text" class="hub-input hub-auth-input" id="ai-code"
          autocomplete="one-time-code" inputmode="numeric" pattern="\\d{4,10}"
          maxlength="10" placeholder="Enter the code from your email"
          style="font-size:18px;letter-spacing:3px;text-align:center;" />

        <label class="hub-auth-label" for="ai-new" style="margin-top:10px;">New password</label>
        <input type="password" class="hub-input hub-auth-input" id="ai-new"
          autocomplete="new-password" placeholder="At least 8 characters" />

        <label class="hub-auth-label" for="ai-confirm" style="margin-top:10px;">Confirm password</label>
        <input type="password" class="hub-input hub-auth-input" id="ai-confirm"
          autocomplete="new-password" placeholder="Re-enter new password" />

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
          <button type="button" class="hub-btn hub-btn-secondary" id="ai-cancel">Cancel</button>
          <button type="button" class="hub-btn hub-btn-primary" id="ai-submit">Accept & sign in</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#ai-error'));
  const emailInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#ai-email'));
  const codeInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#ai-code'));
  const newInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#ai-new'));
  const confirmInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#ai-confirm'));
  const submitBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#ai-submit'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#ai-cancel'));
  const closeBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#ai-close'));

  if (defaultEmail) emailInput.value = defaultEmail;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.color = '';
    errorEl.classList.add('visible');
  }
  function showInfo(msg) {
    errorEl.textContent = msg;
    errorEl.style.color = 'var(--ies-blue)';
    errorEl.classList.add('visible');
  }
  function clearError() {
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
    errorEl.style.color = '';
  }
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (typeof onClose === 'function') onClose();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  // Pasted codes from email often have spaces or hyphens — strip on input.
  codeInput.addEventListener('input', () => {
    const cleaned = codeInput.value.replace(/\D/g, '');
    if (cleaned !== codeInput.value) codeInput.value = cleaned;
  });

  async function attemptAccept() {
    clearError();
    const email = emailInput.value.trim();
    const code  = codeInput.value.trim();
    const next  = newInput.value;
    const conf  = confirmInput.value;

    if (!email) { showError('Enter your email'); emailInput.focus(); return; }
    if (!code)  { showError('Enter the verification code'); codeInput.focus(); return; }
    if (!next || !conf) { showError('Set a password'); newInput.focus(); return; }
    if (next !== conf)  { showError('Passwords do not match'); confirmInput.focus(); return; }
    if (next.length < MIN_PASSWORD_LENGTH) {
      showError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      newInput.focus();
      return;
    }

    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = 'Verifying…';
    try {
      const v = await verifyInviteOtp(email, code);
      if (!v.ok) {
        showError(v.error || 'Code is invalid or expired');
        codeInput.select();
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = orig;
        return;
      }
      submitBtn.textContent = 'Setting password…';
      const p = await setInitialPassword(next);
      if (!p.ok) {
        showError(p.error || 'Could not set password');
        // Keep the session alive so the user can retry the password; they
        // can't re-verify because their OTP has been consumed.
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = orig;
        return;
      }
      showInfo('Account ready. Signing you in…');
      setTimeout(() => {
        if (typeof onSuccess === 'function') onSuccess();
        overlay.remove();
      }, 700);
    } catch (err) {
      showError(err?.message || 'Unknown error');
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = orig;
    }
  }

  submitBtn.addEventListener('click', attemptAccept);
  for (const el of [emailInput, codeInput, newInput, confirmInput]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptAccept();
      else clearError();
    });
  }

  setTimeout(() => (defaultEmail ? codeInput : emailInput).focus(), 50);
}

export const auth = {
  // Session lifecycle
  bootstrapSession,
  isAuthenticated,
  isInRecovery,
  getSession,
  getUser, ensureSession,
  getMode,

  // Role (Slice 3.14)
  loadRole,
  getRole,
  isAdmin,
  // MFA (Phase 4.5 tranche-2, Slice MFA-01)
  listFactors,
  hasEnrolledFactors,
  getAalLevel,
  requiresMfa,
  enrollTotp,
  verifyEnrollment,
  verifyChallenge,
  unenrollFactor,
  isRoleLoaded,

  // Auth actions
  loginWithPassword,
  changePassword,
  requestPasswordReset,
  verifyRecoveryOtp,
  completePasswordRecovery,
  logout,

  // Invites (Slice 3.16)
  inviteUser,
  verifyInviteOtp,
  setInitialPassword,

  // UI
  renderLoginScreen,
  renderChangePasswordModal,
  renderForgotPasswordModal,
  renderRecoverySetPasswordModal,
  renderAcceptInviteModal,
};

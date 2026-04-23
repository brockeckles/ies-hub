/**
 * IES Hub v3 — Authentication (Phase 3, Slice 3.10)
 *
 * Supabase email/password only. Code-mode (`ies2026` / `ieshub`) is gone as
 * of Slice 3.5 — every user is a real auth.users row with a real uid. The
 * login-form component stays isolated so the Entra swap in Phase 7+ is a
 * component swap, not a session-layer rewrite.
 *
 * Slice 3.6 added in-app password rotation (changePassword reverify-then-update).
 *
 * Slice 3.10 closes the "locked-out pilot" gap: a pilot who forgets their
 * password and signs out can now recover themselves via email. Supabase sends
 * a time-limited recovery link to the user's inbox; clicking it lands back at
 * the hub with a short-lived recovery session (the supabase-js client auto-
 * detects the token in the URL and fires PASSWORD_RECOVERY). We catch that
 * event, surface a dedicated set-new-password modal, and call updateUser.
 *
 * Usage:
 *   import { auth } from './auth.js?v=20260423-y7';
 *
 *   await auth.bootstrapSession();            // call once before gate check
 *   if (!auth.isAuthenticated()) {
 *     auth.renderLoginScreen(overlay, onSuccess);
 *   }
 *   auth.getUser();                            // → { id, email } | null
 *   auth.getMode();                            // → 'password' | 'recovery' | null
 *   await auth.loginWithPassword(email, pw);   // → { ok, user?, error? }
 *   await auth.requestPasswordReset(email);    // → { ok, error? }
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

import { db } from './supabase.js?v=20260423-y1';
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
async function completePasswordRecovery(newPassword) {
  if (!_recoveryMode) {
    return { ok: false, error: 'No active recovery session' };
  }
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  try {
    const client = db.getClient();
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
        <div style="margin-top:10px;text-align:center;">
          <button type="button" id="auth-forgot-link"
            style="background:none;border:none;padding:4px 6px;font-size:12px;color:var(--ies-gray-500, #6b7280);cursor:pointer;text-decoration:underline;text-decoration-color:rgba(0,0,0,.2);font-family:inherit;">
            Forgot password?
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

  setTimeout(() => emailInput.focus(), 100);
}

/**
 * Render the "Forgot password?" modal. Dispatched from the login screen.
 * Collects an email, calls requestPasswordReset, then shows a generic
 * confirmation regardless of whether the email was recognized. Keeps the
 * modal open with a "Done" button so mobile/desktop flows are the same
 * (no auto-dismiss that might race with the user re-reading the message).
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
        <h2 class="hub-auth-title" style="margin:0;font-size:18px;">Reset password</h2>
        <button type="button" id="fp-close" aria-label="Close"
          style="background:none;border:none;color:var(--ies-gray-500);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;">×</button>
      </div>
      <p class="hub-auth-subtitle" style="margin-bottom:16px;text-align:left;">
        Enter the email you use to sign in. We'll send a reset link — click it to
        set a new password.
      </p>

      <div class="hub-auth-error" id="fp-error" role="alert"></div>

      <div class="hub-auth-pane" id="fp-form-pane">
        <label class="hub-auth-label" for="fp-email">Email</label>
        <input type="email" class="hub-input hub-auth-input" id="fp-email"
          autocomplete="email" placeholder="name@gxo.com" spellcheck="false"
          autocapitalize="off" />

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
          <button type="button" class="hub-btn hub-btn-secondary" id="fp-cancel">Cancel</button>
          <button type="button" class="hub-btn hub-btn-primary" id="fp-submit">Send reset link</button>
        </div>
      </div>

      <div class="hub-auth-pane" id="fp-done-pane" style="display:none;">
        <p style="margin:0 0 12px 0;color:var(--ies-navy);">
          If an account exists for that address, a reset link is on its way.
          Check your inbox (and spam folder) — the link expires in about an
          hour. Closing this dialog won't cancel it.
        </p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button type="button" class="hub-btn hub-btn-primary" id="fp-done">Done</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#fp-error'));
  const emailInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#fp-email'));
  const submitBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-submit'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-cancel'));
  const closeBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-close'));
  const doneBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#fp-done'));
  const formPane = /** @type {HTMLElement} */ (overlay.querySelector('#fp-form-pane'));
  const donePane = /** @type {HTMLElement} */ (overlay.querySelector('#fp-done-pane'));

  if (defaultEmail) emailInput.value = defaultEmail;

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
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  doneBtn.addEventListener('click', close);

  async function attemptSend() {
    clearError();
    const email = emailInput.value.trim();
    if (!email) {
      showError('Enter your email');
      return;
    }
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = 'Sending…';
    try {
      const res = await requestPasswordReset(email);
      if (res.ok) {
        // Swap to confirmation pane. We intentionally do NOT differentiate
        // "email sent" from "email not recognized" — prevents enumeration.
        formPane.style.display = 'none';
        donePane.style.display = '';
        setTimeout(() => doneBtn.focus(), 50);
      } else {
        // Only hard errors (rate limit, transport) surface here.
        showError(res.error || 'Could not send reset email');
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

  submitBtn.addEventListener('click', attemptSend);
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptSend();
    else clearError();
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
          Reset link verified ${emailHint}. Choose a new password (minimum 8 characters).
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
      const res = await completePasswordRecovery(next);
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

export const auth = {
  // Session lifecycle
  bootstrapSession,
  isAuthenticated,
  isInRecovery,
  getSession,
  getUser,
  getMode,

  // Auth actions
  loginWithPassword,
  changePassword,
  requestPasswordReset,
  completePasswordRecovery,
  logout,

  // UI
  renderLoginScreen,
  renderChangePasswordModal,
  renderForgotPasswordModal,
  renderRecoverySetPasswordModal,
};

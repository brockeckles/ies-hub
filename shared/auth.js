/**
 * IES Hub v3 — Authentication (Phase 3, Slice 3.5)
 *
 * Supabase email/password only. Code-mode (`ies2026` / `ieshub`) is gone as
 * of Slice 3.5 — every user is a real auth.users row with a real uid. The
 * login-form component stays isolated so the Entra swap in Phase 7+ is a
 * component swap, not a session-layer rewrite.
 *
 * Usage:
 *   import { auth } from './auth.js?v=20260423-y4';
 *
 *   await auth.bootstrapSession();            // call once before gate check
 *   if (!auth.isAuthenticated()) {
 *     auth.renderLoginScreen(overlay, onSuccess);
 *   }
 *   auth.getUser();                            // → { id, email } | null
 *   auth.getMode();                            // → 'password' | null
 *   await auth.loginWithPassword(email, pw);   // → { ok, user?, error? }
 *   await auth.logout();
 *
 * @module shared/auth
 */

import { db } from './supabase.js?v=20260423-y1';
import { state } from './state.js?v=20260418-sK';
import { bus } from './event-bus.js?v=20260418-sK';

/** Cached session + user — source of truth is supabase.auth.getSession(). */
let _currentSession = null;
let _currentUser = null;

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

      if ((evt === 'SIGNED_IN' || evt === 'TOKEN_REFRESHED' || evt === 'USER_UPDATED') && session) {
        state.set('user', shapeUser(session.user));
        mirrorEmailToLegacy(session.user.email);
        if (evt === 'SIGNED_IN') bus.emit('auth:login', { mode: 'password', email: session.user.email, id: session.user.id });
      } else if (evt === 'SIGNED_OUT') {
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

/** @returns {boolean} */
function isAuthenticated() {
  return !!_currentSession;
}

/** @returns {any|null} */
function getSession() { return _currentSession; }

/** @returns {{id:string,email:string}|null} */
function getUser() {
  if (_currentUser) {
    return { id: _currentUser.id, email: _currentUser.email };
  }
  return null;
}

/** @returns {'password'|null} */
function getMode() {
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
      </div>
    </div>
  `;

  const card = /** @type {HTMLElement} */ (overlay.querySelector('.hub-auth-card'));
  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#auth-error'));
  const emailInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-email-input'));
  const passwordInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-password-input'));
  const signinBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#auth-signin-btn'));

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

  setTimeout(() => emailInput.focus(), 100);
}

export const auth = {
  // Session lifecycle
  bootstrapSession,
  isAuthenticated,
  getSession,
  getUser,
  getMode,

  // Auth actions
  loginWithPassword,
  logout,

  // UI
  renderLoginScreen,
};

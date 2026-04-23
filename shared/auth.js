/**
 * IES Hub v3 — Authentication (Phase 3, Slice 3.2)
 *
 * Dual-gate auth module that runs Supabase email/password as the
 * primary path and keeps the legacy access-code gate in parallel
 * until Slice 3.5 cuts the code off. Identity key is `auth.uid()`
 * (UUID) everywhere — email is display-only. When Entra lands in
 * Phase 7 the login-form component can swap out with zero churn
 * in the session/identity layer below it.
 *
 * Usage:
 *   import { auth } from './auth.js?v=20260423-y1';
 *
 *   await auth.bootstrapSession();            // call once before gate check
 *   if (!auth.isAuthenticated()) {
 *     auth.renderLoginScreen(overlay, onSuccess);
 *   }
 *   auth.getUser();                            // → { id, email } | null
 *   auth.getMode();                            // → 'password' | 'code' | null
 *   await auth.loginWithPassword(email, pw);   // → { ok, user?, error? }
 *   auth.loginWithCode('ies2026');             // → true | false (legacy)
 *   await auth.logout();
 *
 * @module shared/auth
 */

import { db } from './supabase.js?v=20260423-y1';
import { state } from './state.js?v=20260418-sK';
import { bus } from './event-bus.js?v=20260418-sK';

/** Legacy access codes (case-insensitive). Removed in Slice 3.5. */
const VALID_CODES = ['ies2026', 'ieshub'];

/** Sentinel key for legacy code-based sessions (removed in 3.5). */
const CODE_SESSION_KEY = 'ies_hub_v3_auth';

/** Cached session + user — source of truth is supabase.auth.getSession(). */
let _currentSession = null;
let _currentUser = null;

/** True when the user bypassed real auth via the legacy code. */
let _codeMode = false;

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
 *
 * Returns when the local session (if any) is loaded. Token refresh still
 * happens async in the background — we never block rendering on network.
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
    } else if (readCodeFlag()) {
      // No supabase session but the legacy code gate is set.
      _codeMode = true;
      state.set('user', { mode: 'code', authenticated: true });
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
        _codeMode = false; // real auth supersedes any lingering code flag
        clearCodeFlag();
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
    // Never let a flaky network kill the app boot — degrade to code-only.
    if (typeof console !== 'undefined') {
      console.warn('[auth] bootstrapSession failed, degrading to code-only:', err?.message || err);
    }
    if (readCodeFlag()) {
      _codeMode = true;
      state.set('user', { mode: 'code', authenticated: true });
    }
  }
}

/** @returns {boolean} */
function readCodeFlag() {
  try { return sessionStorage.getItem(CODE_SESSION_KEY) === 'true'; }
  catch { return false; }
}

function setCodeFlag() {
  try { sessionStorage.setItem(CODE_SESSION_KEY, 'true'); }
  catch { /* ok */ }
}

function clearCodeFlag() {
  try { sessionStorage.removeItem(CODE_SESSION_KEY); }
  catch { /* ok */ }
}

/**
 * True when the app should render past the login gate. A real Supabase
 * session counts; the legacy code flag also counts until Slice 3.5.
 * @returns {boolean}
 */
function isAuthenticated() {
  return !!_currentSession || _codeMode || readCodeFlag();
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

/** @returns {'password'|'code'|null} */
function getMode() {
  if (_currentSession) return 'password';
  if (_codeMode || readCodeFlag()) return 'code';
  return null;
}

/**
 * Primary path. Sign in with email + password against Supabase Auth.
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
 * Legacy path. Validate an access code and mark the session as
 * code-authenticated. No identity — user_id stays null for these.
 * Removed in Slice 3.5.
 * @param {string} code
 * @returns {boolean}
 */
function loginWithCode(code) {
  if (!VALID_CODES.includes(String(code || '').trim().toLowerCase())) return false;
  setCodeFlag();
  _codeMode = true;
  state.set('user', { mode: 'code', authenticated: true });
  bus.emit('auth:login', { mode: 'code' });
  return true;
}

/**
 * Back-compat alias for the old single-arg login(code) signature.
 * A handful of places still call `auth.login(code)`; keep them green.
 * @param {string} code
 * @returns {boolean}
 */
function login(code) { return loginWithCode(code); }

/** @param {string} code */
function validateCode(code) {
  return VALID_CODES.includes(String(code || '').trim().toLowerCase());
}

/**
 * Sign out of both paths. Safe to call from any state.
 */
async function logout() {
  try {
    const client = db.getClient();
    await client.auth.signOut();
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[auth] signOut failed:', err?.message || err);
  }
  clearCodeFlag();
  _codeMode = false;
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
 * Primary form: email + password. Secondary (collapsible) legacy code input.
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

      <!-- Primary: Supabase email + password -->
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
        <div class="hub-auth-footer" style="margin-top:12px;">
          <a href="#" class="hub-auth-link" id="auth-show-code">Use access code instead</a>
        </div>
      </div>

      <!-- Secondary: legacy access-code (Slice 3.5 removes this pane) -->
      <div class="hub-auth-pane hidden" data-pane="code">
        <label class="hub-auth-label" for="auth-code-input">Access code</label>
        <input
          type="password"
          class="hub-input hub-auth-input"
          id="auth-code-input"
          placeholder="Enter access code"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="hub-btn hub-btn-primary w-full" id="auth-code-btn" style="margin-top:14px;">
          Continue
        </button>
        <div class="hub-auth-footer" style="margin-top:12px;">
          <a href="#" class="hub-auth-link" id="auth-show-password">Use email & password instead</a>
        </div>
      </div>
    </div>
  `;

  const card = /** @type {HTMLElement} */ (overlay.querySelector('.hub-auth-card'));
  const errorEl = /** @type {HTMLElement} */ (overlay.querySelector('#auth-error'));
  const panePassword = /** @type {HTMLElement} */ (overlay.querySelector('[data-pane="password"]'));
  const paneCode = /** @type {HTMLElement} */ (overlay.querySelector('[data-pane="code"]'));
  const emailInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-email-input'));
  const passwordInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-password-input'));
  const codeInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-code-input'));
  const signinBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#auth-signin-btn'));
  const codeBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#auth-code-btn'));
  const showCode = overlay.querySelector('#auth-show-code');
  const showPassword = overlay.querySelector('#auth-show-password');

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
        // Generic message — don't disclose whether the email exists.
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

  function attemptCode() {
    clearError();
    const code = codeInput.value;
    if (loginWithCode(code)) {
      fadeOutAndBoot();
    } else {
      showError('Invalid access code');
      codeInput.value = '';
      codeInput.focus();
    }
  }

  signinBtn.addEventListener('click', attemptPassword);
  codeBtn.addEventListener('click', attemptCode);

  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordInput.focus();
    else clearError();
  });
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptPassword();
    else clearError();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptCode();
    else clearError();
  });

  showCode?.addEventListener('click', (e) => {
    e.preventDefault();
    panePassword.classList.add('hidden');
    paneCode.classList.remove('hidden');
    clearError();
    setTimeout(() => codeInput.focus(), 50);
  });
  showPassword?.addEventListener('click', (e) => {
    e.preventDefault();
    paneCode.classList.add('hidden');
    panePassword.classList.remove('hidden');
    clearError();
    setTimeout(() => emailInput.focus(), 50);
  });

  setTimeout(() => emailInput.focus(), 100);
}

/* -------------------------------------------------------------------------- */
/* Dev helpers (NOT in the public API — exposed via window for console use)   */
/* -------------------------------------------------------------------------- */

/**
 * Create a new user via supabase.auth.signUp. Used during Slice 3.2 dev
 * to provision a throwaway test account before Slice 3.5 invites pilots.
 * If email confirmation is enabled the returned user will be unconfirmed
 * until they click the link (or an admin confirms via SQL).
 * @param {string} email
 * @param {string} password
 */
async function __devSignup(email, password) {
  const client = db.getClient();
  return client.auth.signUp({
    email: String(email || '').trim(),
    password: String(password || ''),
  });
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
  loginWithCode,
  logout,

  // Legacy / back-compat
  login,          // alias of loginWithCode (older call sites)
  validateCode,   // code validator only (no side effects)

  // UI
  renderLoginScreen,

  // Dev-only
  __devSignup,
};

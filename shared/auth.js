/**
 * IES Hub v3 — Authentication
 * Access-code gate with session persistence.
 *
 * Usage:
 *   import { auth } from './auth.js?v=20260417-mC';
 *
 *   if (!auth.isAuthenticated()) {
 *     auth.showLoginScreen(onSuccess);
 *   }
 *
 * @module shared/auth
 */

import { state } from './state.js?v=20260417-mC';
import { bus } from './event-bus.js?v=20260417-mC';

/** Valid access codes (case-insensitive) */
const VALID_CODES = ['ies2026', 'ieshub'];

/** Session storage key */
const SESSION_KEY = 'ies_hub_v3_auth';

/**
 * Check if user has a valid session.
 * @returns {boolean}
 */
function isAuthenticated() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Validate an access code.
 * @param {string} code
 * @returns {boolean}
 */
function validateCode(code) {
  return VALID_CODES.includes(code.trim().toLowerCase());
}

/**
 * Authenticate with an access code.
 * @param {string} code
 * @returns {boolean} success
 */
function login(code) {
  if (validateCode(code)) {
    try {
      sessionStorage.setItem(SESSION_KEY, 'true');
    } catch { /* sessionStorage might be blocked */ }
    state.set('user', { authenticated: true });
    bus.emit('auth:login', { authenticated: true });
    return true;
  }
  return false;
}

/**
 * Log out and clear session.
 */
function logout() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch { /* ok */ }
  state.set('user', null);
  bus.emit('auth:logout');
}

/**
 * Render the login screen into the auth overlay.
 * @param {HTMLElement} overlay — the .hub-auth-overlay element
 * @param {() => void} onSuccess — called after successful login
 */
function renderLoginScreen(overlay, onSuccess) {
  overlay.innerHTML = `
    <div class="hub-auth-card">
      <div class="hub-auth-logo">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
      </div>
      <h1 class="hub-auth-title">IES Intelligence Hub</h1>
      <p class="hub-auth-subtitle">Solutions Design Platform</p>
      <div class="hub-auth-error" id="auth-error">Invalid access code</div>
      <input
        type="password"
        class="hub-input hub-auth-input"
        id="auth-code-input"
        placeholder="Enter access code"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="hub-btn hub-btn-primary w-full" id="auth-submit-btn">
        Sign In
      </button>
    </div>
  `;

  const input = /** @type {HTMLInputElement} */ (overlay.querySelector('#auth-code-input'));
  const submitBtn = overlay.querySelector('#auth-submit-btn');
  const errorEl = overlay.querySelector('#auth-error');

  function attempt() {
    const code = input.value;
    if (login(code)) {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s ease';
      setTimeout(() => {
        overlay.classList.add('hidden');
        onSuccess();
      }, 300);
    } else {
      errorEl.classList.add('visible');
      input.value = '';
      input.focus();
      // Shake animation
      overlay.querySelector('.hub-auth-card').animate([
        { transform: 'translateX(-8px)' },
        { transform: 'translateX(8px)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(0)' },
      ], { duration: 300 });
    }
  }

  submitBtn.addEventListener('click', attempt);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attempt();
    else errorEl.classList.remove('visible');
  });

  // Auto-focus
  setTimeout(() => input.focus(), 100);
}

export const auth = {
  isAuthenticated,
  validateCode,
  login,
  logout,
  renderLoginScreen,
};

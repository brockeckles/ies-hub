/**
 * IES Hub v3 — MFA UI (Phase 4.5 tranche-2, Slice MFA-01)
 *
 * Enrollment + challenge modals for TOTP-based MFA. Painted on top of the
 * auth overlay AFTER a password sign-in but BEFORE the app shell boots,
 * whenever the signed-in user's session AAL is not 'aal2' — Phase 4.5
 * Slice MFA-01 shipped the gate for admin-tier; Slice HYG-04 extended it
 * to every authenticated user. See `auth.requiresMfa()`.
 *
 * Two flows:
 *   - Enrollment:  user has no verified TOTP factor → walks through QR +
 *                  manual secret + 6-digit verify. On success, Supabase
 *                  upgrades the session to aal2.
 *   - Challenge:   user has a verified factor → 6-digit code prompt;
 *                  Supabase upgrades to aal2 on verify.
 *
 * `openMfaGate()` is the entry point called by the index.html boot gate —
 * it inspects factor state and picks the right modal.
 *
 * Both modals expose a "Sign out" escape so a user who can't complete MFA
 * (lost device, wrong account) can get back to the login screen rather
 * than being stuck.
 *
 * @module shared/mfa-ui
 */

import { auth } from './auth.js?v=20260424-hyg04';

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * Mount the correct MFA modal on top of `overlay`. Decides enrollment vs
 * challenge based on whether the user has a verified TOTP factor.
 *
 * @param {HTMLElement} overlay
 * @param {{ onPass: () => void, onLogout: () => void }} opts
 */
export async function openMfaGate(overlay, { onPass, onLogout }) {
  // Ensure overlay is visible and painted with a minimal host card so the
  // user sees something while we call listFactors().
  overlay.classList.remove('hidden');
  overlay.style.opacity = '1';
  overlay.innerHTML = mfaHostHtml('Verifying security…');

  let verifiedFactorId = null;
  try {
    const factors = await auth.listFactors();
    const verifiedTotp = factors.find(
      (f) => f.factor_type === 'totp' && f.status === 'verified'
    );
    verifiedFactorId = verifiedTotp ? verifiedTotp.id : null;
  } catch (err) {
    console.warn('[mfa-ui] listFactors failed:', err);
    overlay.innerHTML = mfaHostHtml('We could not check MFA status. Sign out and try again.', true);
    wireLogoutButton(overlay, onLogout);
    return;
  }

  if (verifiedFactorId) {
    renderChallengeModal(overlay, { factorId: verifiedFactorId, onPass, onLogout });
  } else {
    renderEnrollModal(overlay, { onPass, onLogout });
  }
}

// ─── Host card helper ────────────────────────────────────────────────────

function mfaHostHtml(statusText, showLogout = false) {
  return `
    <div class="hub-auth-card" role="dialog" aria-label="Two-factor authentication" style="max-width:440px;">
      <div class="hub-auth-logo" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1 class="hub-auth-title">Two-factor authentication</h1>
      <p class="hub-auth-subtitle" id="mfa-status" style="margin-bottom:18px;">${escapeHtml(statusText)}</p>
      ${showLogout ? `<button class="hub-btn w-full" id="mfa-logout-btn" style="margin-top:10px;">Sign out</button>` : ''}
    </div>
  `;
}

function wireLogoutButton(overlay, onLogout) {
  const btn = overlay.querySelector('#mfa-logout-btn');
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await auth.logout(); } catch {}
    onLogout();
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Enrollment modal ────────────────────────────────────────────────────

async function renderEnrollModal(overlay, { onPass, onLogout }) {
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-label="Set up two-factor authentication" style="max-width:460px;">
      <div class="hub-auth-logo" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1 class="hub-auth-title">Set up two-factor auth</h1>
      <p class="hub-auth-subtitle" style="margin-bottom:14px;">
        Two-factor authentication is required for this Hub. Scan the QR below with your
        authenticator app (Authy, 1Password, Google Authenticator, etc.)
        then enter the 6-digit code.
      </p>

      <div class="hub-auth-error" id="mfa-error" role="alert"></div>

      <div id="mfa-enroll-qr" style="display:flex;justify-content:center;align-items:center;background:#fff;border-radius:12px;padding:12px;margin:8px 0 12px;min-height:180px;">
        <span style="color:#6b7280;font-size:12px;">Generating secret…</span>
      </div>

      <details style="margin:0 0 14px;">
        <summary style="cursor:pointer;font-size:12px;color:var(--ies-gray-500, #6b7280);">Can't scan? Show secret instead</summary>
        <div style="margin-top:8px;font-family:ui-monospace,monospace;font-size:12px;padding:8px;background:rgba(0,0,0,.04);border-radius:6px;word-break:break-all;" id="mfa-enroll-secret"></div>
      </details>

      <label class="hub-auth-label" for="mfa-enroll-code">6-digit code from app</label>
      <input
        type="text"
        class="hub-input hub-auth-input"
        id="mfa-enroll-code"
        placeholder="123456"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        pattern="[0-9]{6}"
        style="letter-spacing:.25em;text-align:center;font-size:18px;"
      />

      <button class="hub-btn hub-btn-primary w-full" id="mfa-enroll-verify" style="margin-top:14px;" disabled>
        Verify and activate
      </button>
      <button class="hub-btn w-full" id="mfa-logout-btn" style="margin-top:8px;">Sign out</button>
    </div>
  `;

  const card = overlay.querySelector('.hub-auth-card');
  const errorEl = overlay.querySelector('#mfa-error');
  const qrHost = overlay.querySelector('#mfa-enroll-qr');
  const secretHost = overlay.querySelector('#mfa-enroll-secret');
  const codeInput = overlay.querySelector('#mfa-enroll-code');
  const verifyBtn = overlay.querySelector('#mfa-enroll-verify');

  wireLogoutButton(overlay, onLogout);

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
    card.animate([
      { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' },
      { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' },
      { transform: 'translateX(0)' },
    ], { duration: 300 });
  }
  function clearError() { errorEl.classList.remove('visible'); errorEl.textContent = ''; }

  // 1. Call enroll() and paint the QR.
  //    Supabase returns qr_code as a data URI (data:image/svg+xml;utf-8,<svg...>),
  //    NOT a raw SVG string — so we render it via <img src> rather than
  //    innerHTML, which would leak the URI prefix as visible text.
  let factorId = null;
  try {
    const res = await auth.enrollTotp('IES Hub');
    if (!res.ok) throw new Error(res.error || 'enroll failed');
    factorId = res.factorId;
    qrHost.innerHTML = '';
    if (res.qrCode) {
      const img = document.createElement('img');
      img.alt = 'TOTP QR code';
      img.src = res.qrCode;
      img.style.width = '200px';
      img.style.height = '200px';
      img.style.display = 'block';
      qrHost.appendChild(img);
    } else {
      qrHost.innerHTML = '<span style="color:#b91c1c;font-size:12px;">QR not returned</span>';
    }
    secretHost.textContent = res.secret || '(secret unavailable)';
  } catch (err) {
    qrHost.innerHTML = '<span style="color:#b91c1c;font-size:12px;">Could not start enrollment.</span>';
    showError(err?.message || 'Enrollment failed. Sign out and retry.');
    return;
  }

  // 2. Enable the verify button once a 6-digit code is present.
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
    codeInput.value = digits;
    verifyBtn.disabled = digits.length !== 6;
    clearError();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !verifyBtn.disabled) verifyBtn.click();
  });

  verifyBtn.addEventListener('click', async () => {
    clearError();
    const code = codeInput.value;
    verifyBtn.disabled = true;
    const orig = verifyBtn.textContent;
    verifyBtn.textContent = 'Verifying…';
    try {
      const res = await auth.verifyEnrollment(factorId, code);
      if (res.ok) {
        verifyBtn.textContent = 'Activated ✓';
        // Small delay so the user sees the success state.
        setTimeout(() => onPass(), 500);
      } else {
        verifyBtn.textContent = orig;
        verifyBtn.disabled = codeInput.value.length !== 6;
        showError(friendlyMfaError(res.error) || 'Incorrect code. Try again.');
        codeInput.select();
      }
    } catch (err) {
      verifyBtn.textContent = orig;
      verifyBtn.disabled = codeInput.value.length !== 6;
      showError(err?.message || 'Verification failed.');
    }
  });

  codeInput.focus();
}

// ─── Challenge modal ─────────────────────────────────────────────────────

function renderChallengeModal(overlay, { factorId, onPass, onLogout }) {
  overlay.innerHTML = `
    <div class="hub-auth-card" role="dialog" aria-label="Enter your authenticator code" style="max-width:420px;">
      <div class="hub-auth-logo" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1 class="hub-auth-title">Enter your code</h1>
      <p class="hub-auth-subtitle" style="margin-bottom:14px;">
        Open your authenticator app and enter the current 6-digit code.
      </p>

      <div class="hub-auth-error" id="mfa-error" role="alert"></div>

      <label class="hub-auth-label" for="mfa-challenge-code">6-digit code</label>
      <input
        type="text"
        class="hub-input hub-auth-input"
        id="mfa-challenge-code"
        placeholder="123456"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        pattern="[0-9]{6}"
        style="letter-spacing:.25em;text-align:center;font-size:18px;"
      />

      <button class="hub-btn hub-btn-primary w-full" id="mfa-challenge-verify" style="margin-top:14px;" disabled>
        Verify
      </button>
      <button class="hub-btn w-full" id="mfa-logout-btn" style="margin-top:8px;">Sign out</button>
    </div>
  `;

  const card = overlay.querySelector('.hub-auth-card');
  const errorEl = overlay.querySelector('#mfa-error');
  const codeInput = overlay.querySelector('#mfa-challenge-code');
  const verifyBtn = overlay.querySelector('#mfa-challenge-verify');

  wireLogoutButton(overlay, onLogout);

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
    card.animate([
      { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' },
      { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' },
      { transform: 'translateX(0)' },
    ], { duration: 300 });
  }
  function clearError() { errorEl.classList.remove('visible'); errorEl.textContent = ''; }

  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
    codeInput.value = digits;
    verifyBtn.disabled = digits.length !== 6;
    clearError();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !verifyBtn.disabled) verifyBtn.click();
  });

  verifyBtn.addEventListener('click', async () => {
    clearError();
    const code = codeInput.value;
    verifyBtn.disabled = true;
    const orig = verifyBtn.textContent;
    verifyBtn.textContent = 'Verifying…';
    try {
      const res = await auth.verifyChallenge(factorId, code);
      if (res.ok) {
        verifyBtn.textContent = 'Verified ✓';
        setTimeout(() => onPass(), 300);
      } else {
        verifyBtn.textContent = orig;
        verifyBtn.disabled = codeInput.value.length !== 6;
        showError(friendlyMfaError(res.error) || 'Incorrect code. Try again.');
        codeInput.select();
      }
    } catch (err) {
      verifyBtn.textContent = orig;
      verifyBtn.disabled = codeInput.value.length !== 6;
      showError(err?.message || 'Verification failed.');
    }
  });

  codeInput.focus();
}

// ─── Error formatting ────────────────────────────────────────────────────

function friendlyMfaError(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes('invalid totp') || s.includes('invalid code') || s.includes('mfa_verification_failed')) {
    return 'Incorrect code. Check the clock on your phone and try again.';
  }
  if (s.includes('expired')) return 'Code expired. Enter the newest 6-digit code.';
  return raw;
}

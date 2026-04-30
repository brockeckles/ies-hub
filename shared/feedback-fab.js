/**
 * IES Hub v3 — Feedback FAB
 *
 * Floating "Share feedback / Report issue" button that mounts globally on
 * every page. Click → opens an inline modal with a feedback form. Submit
 * inserts into hub_feedback (RLS allows anon + authenticated INSERT).
 *
 * Auto-captures the current route as the `section` field so triage knows
 * which page the user was on.
 *
 * Mount once from index.html after the app shell boots:
 *   import { mountFeedbackFab } from './shared/feedback-fab.js';
 *   mountFeedbackFab();
 *
 * @module shared/feedback-fab
 */

import { db } from './supabase.js?v=20260429-demo-s3';
import { showToast } from './toast.js?v=20260419-uC';

const FAB_ID = 'hub-feedback-fab';
const MODAL_ID = 'hub-feedback-modal';

let mounted = false;

export function mountFeedbackFab() {
  if (mounted) return;
  if (typeof document === 'undefined') return;
  mounted = true;

  const fab = document.createElement('button');
  fab.id = FAB_ID;
  fab.className = 'hub-feedback-fab';
  fab.type = 'button';
  fab.title = 'Share feedback or report an issue';
  fab.setAttribute('aria-label', 'Share feedback or report an issue');
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
    <span class="hub-feedback-fab__label">Feedback</span>
  `;
  fab.addEventListener('click', openModal);
  document.body.appendChild(fab);
}

function currentSection() {
  try {
    const h = (location.hash || '').replace(/^#/, '');
    return h || 'overview';
  } catch (_) { return ''; }
}

function currentUserEmail() {
  try {
    const e = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('ies_user_email') : null;
    return (e || '').trim();
  } catch (_) { return ''; }
}

function openModal() {
  // Don't double-open
  if (document.getElementById(MODAL_ID)) return;

  const section = currentSection();
  const email = currentUserEmail();

  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'hub-feedback-modal-overlay';
  overlay.innerHTML = `
    <div class="hub-feedback-modal" role="dialog" aria-modal="true" aria-labelledby="fb-modal-title">
      <div class="hub-feedback-modal__header">
        <h3 id="fb-modal-title">Share feedback / Report an issue</h3>
        <button class="hub-feedback-modal__close" data-fb-action="close" aria-label="Close">×</button>
      </div>
      <div class="hub-feedback-modal__body">
        <div class="hub-feedback-modal__row">
          <label>Type</label>
          <div class="hub-feedback-pills" role="radiogroup">
            <button type="button" class="hub-feedback-pill is-active" data-fb-type="question">Question</button>
            <button type="button" class="hub-feedback-pill" data-fb-type="enhancement">Idea</button>
            <button type="button" class="hub-feedback-pill" data-fb-type="bug">Bug</button>
            <button type="button" class="hub-feedback-pill" data-fb-type="general">General</button>
          </div>
        </div>
        <div class="hub-feedback-modal__row">
          <label for="fb-title">Title</label>
          <input id="fb-title" class="hub-input" type="text" maxlength="120"
                 placeholder="Short summary (e.g., 'Forecast vs actual mismatch in Hours card')" />
        </div>
        <div class="hub-feedback-modal__row">
          <label for="fb-desc">Details</label>
          <textarea id="fb-desc" class="hub-input" rows="4"
                    placeholder="What were you trying to do? What happened? What did you expect?"></textarea>
        </div>
        <div class="hub-feedback-modal__row hub-feedback-modal__row--inline">
          <div style="flex:1;">
            <label for="fb-priority">Priority</label>
            <select id="fb-priority" class="hub-input">
              <option value="nice_to_have">Nice to have</option>
              <option value="important" selected>Important</option>
              <option value="critical">Critical / blocker</option>
            </select>
          </div>
          <div style="flex:2;">
            <label for="fb-name">Your name / email <span class="hub-feedback-modal__hint">(optional)</span></label>
            <input id="fb-name" class="hub-input" type="text" value="${escapeAttr(email)}" placeholder="Anonymous" />
          </div>
        </div>
        <div class="hub-feedback-modal__row hub-feedback-modal__hint">
          Submitting from page: <code>#${escapeText(section)}</code>
        </div>
      </div>
      <div class="hub-feedback-modal__footer">
        <button type="button" class="hub-btn" data-fb-action="close">Cancel</button>
        <button type="button" class="hub-btn-primary" data-fb-action="submit">Submit</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let selectedType = 'question';

  overlay.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t === overlay) { close(); return; }
    if (t.dataset.fbAction === 'close') { close(); return; }
    const pill = t.closest('[data-fb-type]');
    if (pill instanceof HTMLElement) {
      overlay.querySelectorAll('[data-fb-type]').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');
      selectedType = pill.dataset.fbType || 'question';
      return;
    }
    if (t.dataset.fbAction === 'submit') {
      submit();
    }
  });

  // Esc to close
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  // Focus the title input
  setTimeout(() => overlay.querySelector('#fb-title')?.focus(), 30);

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  async function submit() {
    const title = (overlay.querySelector('#fb-title')?.value || '').trim();
    const description = (overlay.querySelector('#fb-desc')?.value || '').trim();
    const priority = overlay.querySelector('#fb-priority')?.value || 'nice_to_have';
    const submittedBy = (overlay.querySelector('#fb-name')?.value || '').trim() || 'Anonymous';

    if (!title) {
      showToast('Please enter a title for your feedback.', 'warning');
      overlay.querySelector('#fb-title')?.focus();
      return;
    }

    const submitBtn = overlay.querySelector('[data-fb-action="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
    }

    try {
      await db.insert('hub_feedback', {
        type: selectedType,
        title,
        description: description || null,
        section: section || null,
        submitted_by: submittedBy,
        priority,
        // status defaults to 'new'
        // upvotes defaults to '{}'
      });
      showToast('Thanks — feedback received.', 'success');
      close();
    } catch (err) {
      console.error('[feedback-fab] submit failed:', err);
      showToast('Submit failed: ' + (err?.message || err), 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      }
    }
  }
}

function escapeAttr(s) { return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escapeText(s) { return String(s ?? '').replace(/</g, '&lt;'); }

/**
 * IES Hub v3 — Shared Toast Notifications
 *
 * Non-blocking bottom-right toast replaces silent CRUD and blocking alert()
 * calls. Standardizes the toast UX across every tool.
 *
 * Usage:
 *   import { showToast } from './shared/toast.js?v=20260418-sA';
 *   showToast('Model saved', 'success');
 *   showToast('Save failed: invalid input', 'error');
 *
 * Or emit on the event bus (loose coupling for modules that should not
 * import shared/toast.js directly, e.g., engines running in isolation):
 *   bus.emit('toast:show', { message: 'Deck generated', level: 'success' });
 *
 * Levels: 'success' | 'error' | 'warning' | 'info'
 *
 * Toasts stack vertically bottom-right and auto-dismiss (success/info/warn:
 * 4s; error: 6s so the user has time to read it).
 *
 * @module shared/toast
 */

import { bus } from './event-bus.js?v=20260418-sA';

const STACK_ID = 'hub-toast-stack';
const MAX_TOASTS = 5;

const LEVEL_STYLES = {
  success: { bg: '#f0fdf4', border: '#16a34a', text: '#166534', icon: '✓' },
  error:   { bg: '#fef2f2', border: '#dc2626', text: '#991b1b', icon: '✕' },
  warning: { bg: '#fffbeb', border: '#d97706', text: '#92400e', icon: '!' },
  info:    { bg: '#eff6ff', border: '#2563eb', text: '#1e40af', icon: 'i' },
};

const DURATION = { success: 4000, info: 4000, warning: 5000, error: 6000 };

function ensureStack() {
  let stack = document.getElementById(STACK_ID);
  if (stack) return stack;
  stack = document.createElement('div');
  stack.id = STACK_ID;
  stack.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'display:flex',
    'flex-direction:column-reverse',
    'gap:8px',
    'z-index:9999',
    'pointer-events:none',
    'max-width:420px',
  ].join(';');
  document.body.appendChild(stack);
  return stack;
}

/**
 * Show a toast notification. Non-blocking, auto-dismisses.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} [level='success']
 * @param {{ duration?: number, dismissible?: boolean }} [opts]
 */
export function showToast(message, level = 'success', opts = {}) {
  if (typeof document === 'undefined' || !message) return;
  const style = LEVEL_STYLES[level] || LEVEL_STYLES.success;
  const stack = ensureStack();

  // Cap the stack so a runaway loop can't flood the screen.
  while (stack.children.length >= MAX_TOASTS) {
    stack.firstElementChild?.remove();
  }

  const el = document.createElement('div');
  el.className = 'hub-toast';
  el.setAttribute('role', level === 'error' ? 'alert' : 'status');
  el.style.cssText = [
    'display:flex',
    'align-items:flex-start',
    'gap:10px',
    'padding:12px 14px',
    'border-radius:8px',
    `border:1px solid ${style.border}`,
    `background:${style.bg}`,
    `color:${style.text}`,
    'font-size:13px',
    'font-weight:600',
    'line-height:1.4',
    'box-shadow:0 4px 12px rgba(0,0,0,.15)',
    'pointer-events:auto',
    'transform:translateX(0)',
    'transition:transform .2s ease, opacity .2s ease',
    'max-width:400px',
  ].join(';');

  const icon = document.createElement('span');
  icon.textContent = style.icon;
  icon.style.cssText = [
    'flex:0 0 auto',
    'width:20px',
    'height:20px',
    'border-radius:50%',
    `background:${style.border}`,
    'color:#fff',
    'font-size:12px',
    'font-weight:800',
    'display:flex',
    'align-items:center',
    'justify-content:center',
  ].join(';');

  const body = document.createElement('span');
  body.textContent = message;
  body.style.cssText = 'flex:1 1 auto;word-break:break-word;';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = [
    'flex:0 0 auto',
    'border:none',
    'background:transparent',
    `color:${style.text}`,
    'font-size:18px',
    'line-height:1',
    'cursor:pointer',
    'padding:0 4px',
    'opacity:.6',
  ].join(';');
  close.addEventListener('mouseenter', () => { close.style.opacity = '1'; });
  close.addEventListener('mouseleave', () => { close.style.opacity = '.6'; });
  close.addEventListener('click', () => dismiss(el));

  el.append(icon, body, close);
  stack.appendChild(el);

  const duration = opts.duration != null ? opts.duration : DURATION[level];
  if (duration > 0) {
    setTimeout(() => dismiss(el), duration);
  }

  return el;
}

function dismiss(el) {
  if (!el || !el.parentNode) return;
  el.style.opacity = '0';
  el.style.transform = 'translateX(40px)';
  setTimeout(() => { if (el.parentNode) el.remove(); }, 200);
}

/** Dismiss every toast currently on screen. */
export function clearToasts() {
  const stack = document.getElementById(STACK_ID);
  if (stack) stack.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Event bus bridge — modules that don't import this file directly can still
// trigger toasts by emitting 'toast:show' on the bus.
// ---------------------------------------------------------------------------

let _busWired = false;

function wireBus() {
  if (_busWired) return;
  _busWired = true;
  bus.on('toast:show', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    showToast(payload.message, payload.level || 'info', payload.opts || {});
  });
}

// Self-initialize — safe to call multiple times (guarded by _busWired).
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireBus, { once: true });
  } else {
    wireBus();
  }
}

// Default export for convenience.
export default { show: showToast, clear: clearToasts };

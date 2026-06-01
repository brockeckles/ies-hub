// shared/confirm-modal.js?v=20260601-prompt2 — non-blocking confirm/prompt dialogs.
// Replaces native window.confirm()/window.alert() which suspend the renderer
// (a problem for Chrome MCP automation and a minor problem for unloads).

/**
 * Show a non-blocking confirm modal. Resolves to true/false.
 * @param {string} message  prompt text (supports \n line breaks)
 * @param {{ okLabel?: string, cancelLabel?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, opts = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hub-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
    const okBg = opts.danger ? '#dc2626' : 'var(--ies-blue-600)';
    overlay.innerHTML = `
      <div style="background:white;border-radius: 10px;padding:24px;min-width:420px;max-width:90vw;">
        <div style="white-space:pre-line;font-size:14px;line-height:1.45;">${String(message).replace(/</g, '&lt;')}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="hub-btn" data-ans="0">${opts.cancelLabel || 'Cancel'}</button>
          <button type="button" class="hub-btn hub-btn-primary" data-ans="1" style="${opts.danger ? `background:${okBg};` : ''}">${opts.okLabel || 'Confirm'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    // 2026-06-01 — guard against double-fire AND make sure the document
    // keydown listener is always removed when done() runs (previously it
    // leaked when the user clicked OK/Cancel with the mouse).
    let settled = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector('[data-ans="0"]')?.addEventListener('click', (e) => { e.stopPropagation(); done(false); });
    overlay.querySelector('[data-ans="1"]')?.addEventListener('click', (e) => { e.stopPropagation(); done(true); });
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
  });
}

/**
 * Show a non-blocking prompt modal. Resolves to the string value or null if cancelled.
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string|null>}
 */
export function showPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hub-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
      <div style="background:white;border-radius: 10px;padding:24px;min-width:420px;max-width:90vw;">
        <div style="white-space:pre-line;font-size:14px;line-height:1.45;margin-bottom:12px;">${String(message).replace(/</g, '&lt;')}</div>
        <input type="text" class="hub-input" data-prompt-input style="width:100%;" />
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="hub-btn" data-ans="cancel">Cancel</button>
          <button type="button" class="hub-btn hub-btn-primary" data-ans="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('[data-prompt-input]');
    if (input) { input.value = defaultValue; setTimeout(() => input.focus(), 0); }
    // 2026-06-01 — settled flag guards against double-fire (e.g. user clicks
    // OK and immediately Enter); keydown listener uses capture so it always
    // wins against bubbling handlers on the page; explicit removeEventListener
    // in done() prevents the listener from leaking after mouse-click paths.
    let settled = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); done(input?.value ?? ''); }
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector('[data-ans="cancel"]')?.addEventListener('click', (e) => { e.stopPropagation(); done(null); });
    overlay.querySelector('[data-ans="ok"]')?.addEventListener('click', (e) => { e.stopPropagation(); done(input?.value ?? ''); });
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
    document.addEventListener('keydown', onKey, true);
  });
}

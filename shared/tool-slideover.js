/**
 * IES Hub v3 — Tool slide-over helper.
 *
 * Mounts a Design Tool's UI inside a right-side slide-over panel rooted in
 * the body, so CM-launched supporting tools (WSC, NetOpt, etc.) feel
 * "still in CM" rather than punting users to a separate route. The
 * underlying tool module is dynamically imported and its `mount(host)`
 * function is called with a panel-scoped host element — no change to the
 * tool's own contract.
 *
 * The browser route doesn't change. Closing the panel just removes it and
 * returns focus to whatever was visible behind. Esc + clicking the dimmed
 * overlay both close.
 *
 * Why a separate module: shared/tool-frame.js is intentionally tiny (just
 * the Cost Model phase stepper). Keep slide-over scaffolding here so it
 * can be imported independently by future callers without pulling in the
 * stepper.
 *
 * @module shared/tool-slideover
 */

const PANEL_ID = 'hub-tool-slideover';

/**
 * @typedef {Object} OpenSlideOverOpts
 * @property {string} toolPath         - module path including cache-bust query
 * @property {string} title            - shown in panel header
 * @property {string} [subtitle]       - secondary label rendered as a pill
 * @property {() => void} [onClose]    - fires after teardown
 */

/**
 * Open a Design Tool inside a slide-over panel.
 *
 * @param {OpenSlideOverOpts} opts
 * @returns {Promise<{ close: () => void }>}
 */
export async function openToolInSlideOver(opts) {
  const { toolPath, title, subtitle = 'slide-over from CM', onClose } = opts || {};
  if (!toolPath) throw new Error('openToolInSlideOver: toolPath required');

  // Tear down any prior slide-over before opening a new one.
  document.getElementById(PANEL_ID)?.remove();

  const overlay = document.createElement('div');
  overlay.id = PANEL_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title || 'Design tool');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9990',
    // Slight blue tint + lower opacity so the CM behind reads as
    // "still there, just paused" rather than dismissed.
    'background:rgba(15,23,42,0.38)',
    'backdrop-filter:blur(2px)',
    '-webkit-backdrop-filter:blur(2px)',
    'animation:hub-slideover-fade .18s ease',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:absolute',
    // Inset 14 px from all edges so CM peeks through and the panel reads
    // as a raised card hovering above the page.
    'top:14px', 'right:14px', 'bottom:14px',
    'width:min(calc(90vw - 14px), 1600px)',
    'background:#fff',
    'border-radius:14px',
    // Layered shadow: a wide soft drop + a tighter close shadow + a
    // hairline ring. The combination produces a real "lifted" feel
    // without looking gauzy.
    'box-shadow:0 24px 60px rgba(15,23,42,0.22), 0 6px 18px rgba(15,23,42,0.10), 0 0 0 1px rgba(15,23,42,0.06)',
    'display:flex', 'flex-direction:column',
    'overflow:hidden',
    'animation:hub-slideover-in .25s cubic-bezier(.2,.7,.3,1)',
  ].join(';');

  // Panel header with title + close button.
  const header = document.createElement('div');
  header.style.cssText = [
    'display:flex', 'align-items:center', 'justify-content:space-between',
    'gap:12px', 'padding:10px 20px',
    'background:#fff', 'border-bottom:1px solid var(--ies-gray-200, #e5e7eb)',
    'min-height:44px', 'flex-shrink:0',
  ].join(';');
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
      <strong style="font-size:14px;color:#1c1c1c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(title || 'Design tool')}</strong>
      ${subtitle ? `<span style="font-size:11px;color:var(--ies-gray-500, #6b7280);background:var(--ies-gray-100, #f3f4f6);padding:2px 8px;border-radius:999px;white-space:nowrap;flex-shrink:0;">${escapeHtml(subtitle)}</span>` : ''}
    </div>
    <button type="button" data-slideover-close aria-label="Close"
      style="background:none;border:none;font-size:22px;line-height:1;color:var(--ies-gray-500, #6b7280);cursor:pointer;padding:4px 10px;border-radius:6px;"
      onmouseover="this.style.background='var(--ies-gray-100, #f3f4f6)'"
      onmouseout="this.style.background='none'">×</button>
  `;

  // Host element for the tool's mount() output.
  const host = document.createElement('div');
  host.style.cssText = [
    'flex:1', 'overflow:auto',
    'background:var(--ies-gray-50, #f9fafb)',
    'position:relative',
  ].join(';');

  panel.appendChild(header);
  panel.appendChild(host);
  overlay.appendChild(panel);
  overlay.dataset.hubOverlay = '1'; // P3-4: swept by the router on navigation
  // P3-4: richer teardown than remove() — close() also unhooks the Esc
  // listener and fires onClose (which unmounts the embedded tool).
  overlay.__hubOverlayTeardown = () => close();
  document.body.appendChild(overlay);

  // Inject keyframes once (idempotent — the style tag has a fixed id).
  if (!document.getElementById('hub-slideover-keyframes')) {
    const style = document.createElement('style');
    style.id = 'hub-slideover-keyframes';
    style.textContent = `
      @keyframes hub-slideover-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes hub-slideover-in { from { transform: translateX(100%) } to { transform: translateX(0) } }
    `;
    document.head.appendChild(style);
  }

  // Wire close affordances: X button, overlay backdrop click, Esc key.
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
    try { onClose?.(); } catch (err) { console.warn('[slideover] onClose threw:', err); }
  }
  function escHandler(e) { if (e.key === 'Escape') close(); }
  header.querySelector('[data-slideover-close]')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', escHandler);

  // Dynamic import + mount the tool's UI into the host element.
  //
  // CRITICAL: `import(toolPath)` resolves the relative path against THIS
  // module's URL (shared/tool-slideover.js), not the page. So a caller
  // passing './tools/foo/ui.js' would get '/shared/tools/foo/ui.js' which
  // is a 404. Resolve against document.baseURI (the page's base URL) so
  // callers pass app-root-relative paths like './tools/warehouse-sizing/ui.js'.
  // Absolute URLs and protocol-relative URLs pass through unchanged.
  let resolvedToolPath;
  try {
    resolvedToolPath = new URL(toolPath, document.baseURI).href;
  } catch (urlErr) {
    resolvedToolPath = toolPath; // fall through to import; let it surface the error
  }
  // Any error thrown during import or mount is surfaced inline in the panel
  // so it doesn't silently dead-end on the user.
  try {
    const mod = await import(resolvedToolPath);
    if (typeof mod.mount === 'function') {
      // Pass embed metadata so the tool can adapt — e.g., wire its own
      // back-arrow to close the slide-over instead of route-navigating.
      // Tools that don't accept a 2nd arg ignore it (default param shape).
      await mod.mount(host, { embed: 'slideover', onCloseRequest: close });
    } else {
      host.innerHTML = `<div style="padding:24px;color:var(--ies-gray-600);">Tool module loaded but has no mount() export.</div>`;
    }
  } catch (err) {
    console.error('[slideover] failed to mount tool', err);
    host.innerHTML = `
      <div style="padding:24px;">
        <div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:14px 16px;font-size:13px;">
          <strong>Could not load tool.</strong><br>
          ${escapeHtml(String(err?.message || err))}
        </div>
      </div>
    `;
  }

  return { close };
}

/**
 * Close any open slide-over. No-op if none is mounted.
 */
export function closeToolSlideOver() {
  document.getElementById(PANEL_ID)?.remove();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

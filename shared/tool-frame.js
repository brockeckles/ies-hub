/**
 * IES Hub v3 — Tool Frame Helpers
 *
 * Shared primitives that every Design Tool uses so their top chrome
 * (back link + title + status chips + tab strip + primary run button)
 * renders identically. Domain inputs + visualization centers remain
 * tool-specific.
 *
 * Usage:
 *   import { renderToolHeader, renderInputGroup, bindPrimaryActionShortcut } from '../../shared/tool-frame.js?v=20260418-sK';
 *
 *   el.innerHTML = `
 *     <div class="hub-content-inner" style="padding:0;display:flex;flex-direction:column;height:100%;">
 *       ${renderToolHeader({
 *         toolName: 'Network Optimizer',
 *         toolKey: 'netopt',
 *         backAction: 'netopt-back',
 *         tabs: [...],
 *         activeTab: activeView,
 *         statusChips: [{ label: 'Stand-alone', kind: 'standalone' }],
 *         primaryAction: { label: 'Run Scenario', action: 'run', icon: '▶' },
 *       })}
 *       <div id="tool-body" style="flex:1;overflow:hidden;"></div>
 *     </div>
 *   `;
 *   bindPrimaryActionShortcut(el, 'run');
 *
 * @module shared/tool-frame
 */

/**
 * @typedef {Object} ToolTab
 * @property {string} key
 * @property {string} label
 * @property {string} [title]
 */

/**
 * @typedef {Object} StatusChip
 * @property {string} label
 * @property {'linked'|'standalone'|'saved'|'draft'|'default'} [kind]
 * @property {boolean} [dot]
 * @property {string} [title]
 */

/**
 * @typedef {Object} ActionBtn
 * @property {string} label
 * @property {string} action   data-action attribute value
 * @property {string} [icon]
 * @property {string} [title]
 * @property {boolean} [primary]
 * @property {'dirty'|'clean'} [state]   For primary Run buttons. 'clean' renders
 *   a muted outline "✓ Results current" variant — still clickable to force
 *   a re-run. 'dirty' (default) is the orange Run button. Tools pass 'clean'
 *   after a successful run when inputs haven't changed since, and flip back
 *   to 'dirty' on the next tracked input change.
 * @property {string} [cleanLabel]       Override for the clean-state label.
 *   Defaults to "✓ Results current".
 * @property {string} [cleanTitle]       Override for the clean-state tooltip.
 */

/**
 * @typedef {Object} ToolHeaderOpts
 * @property {string} toolName
 * @property {string} [toolKey]            short id used for data-tool attr
 * @property {string} [backAction]         data-action of the back button (default toolKey+'-back')
 * @property {string} [backLabel]          default "← Scenarios"
 * @property {ToolTab[]} [tabs]
 * @property {string} [activeTab]
 * @property {string} [tabsId]             DOM id for the tab strip (default toolKey+'-tabs')
 * @property {StatusChip[]} [statusChips]
 * @property {ActionBtn} [primaryAction]   "Run / Calculate / Optimize"
 * @property {ActionBtn[]} [secondaryActions]
 * @property {string} [shortcutLabel]      default "⌘↵"
 */

/**
 * Render the shared tool header.
 * @param {ToolHeaderOpts} opts
 * @returns {string}
 */
export function renderToolHeader(opts) {
  const {
    toolName,
    toolKey = '',
    backAction = (toolKey ? `${toolKey}-back` : 'tool-back'),
    backLabel = '← Scenarios',
    tabs = [],
    activeTab = '',
    tabsId = (toolKey ? `${toolKey}-tabs` : 'tool-tabs'),
    statusChips = [],
    primaryAction = null,
    secondaryActions = [],
    shortcutLabel = '⌘↵',
  } = opts || {};

  const tabsHtml = tabs.length === 0 ? '' : `
    <div class="hub-tab-strip" id="${tabsId}">
      ${tabs.map(t => `
        <button type="button"
                class="hub-tab-btn ${t.key === activeTab ? 'active' : ''}"
                data-tab="${t.key}"
                ${t.title ? `title="${escapeAttr(t.title)}"` : ''}>${escapeHtml(t.label)}</button>
      `).join('')}
    </div>`;

  const chipsHtml = statusChips.length === 0 ? '' : `
    <div class="hub-tool-status">
      ${statusChips.map(c => `
        <span class="hub-status-chip ${c.kind || 'default'} ${c.dot ? 'dot' : ''}"
              ${c.title ? `title="${escapeAttr(c.title)}"` : ''}>${escapeHtml(c.label)}</span>
      `).join('')}
    </div>`;

  // Inline children with no whitespace between spans. The template literal
  // whitespace would otherwise leak into the button's accessible name and
  // (depending on the platform) get spoken/copied as "▶\n  Run Scenario\n  ⌘↵".
  // Run-state (clean vs dirty): when state === 'clean', render a muted outline
  // "✓ Results current" variant — still clickable so the user can force a
  // re-run (Monte Carlo trials, just-want-to-be-sure flows). The default
  // 'dirty' state renders the standard orange Run button.
  const isClean = primaryAction && primaryAction.state === 'clean';
  const primaryLabel = isClean
    ? (primaryAction.cleanLabel || '✓ Results current')
    : primaryAction?.label;
  const primaryIcon = isClean ? '' : primaryAction?.icon;
  const primaryTitle = isClean
    ? (primaryAction.cleanTitle || `Inputs unchanged since last run. Click to re-run (${shortcutLabel}).`)
    : (primaryAction?.title || `Run (${shortcutLabel})`);
  const primaryClasses = ['hub-btn', 'hub-run-btn'];
  if (isClean) primaryClasses.push('is-clean');
  const primaryHtml = !primaryAction ? '' : (
    `<button type="button" class="${primaryClasses.join(' ')}" data-action="${primaryAction.action}" data-primary-action="${primaryAction.action}" data-run-state="${isClean ? 'clean' : 'dirty'}" title="${escapeAttr(primaryTitle)}">` +
    (primaryIcon ? `<span class="hub-run-icon">${escapeHtml(primaryIcon)}</span>` : '') +
    `<span>${escapeHtml(primaryLabel)}</span>` +
    `<span class="hub-run-shortcut">${escapeHtml(shortcutLabel)}</span>` +
    `</button>`
  );

  const secondariesHtml = secondaryActions.length === 0 ? '' : secondaryActions.map(a => `
    <button type="button"
            class="hub-btn hub-btn-sm ${a.primary ? 'hub-btn-primary' : 'hub-btn-secondary'}"
            data-action="${a.action}"
            ${a.title ? `title="${escapeAttr(a.title)}"` : ''}>
      ${a.icon ? `<span>${escapeHtml(a.icon)}</span> ` : ''}${escapeHtml(a.label)}
    </button>
  `).join('');

  const toolDataAttr = toolKey ? `data-tool="${toolKey}"` : '';

  return `
    <div class="hub-tool-header" ${toolDataAttr}>
      <button type="button" class="hub-btn hub-btn-sm hub-btn-secondary hub-tool-back"
              data-action="${backAction}" title="Back to saved scenarios">${escapeHtml(backLabel)}</button>
      <h2 class="hub-tool-title">${escapeHtml(toolName)}</h2>
      ${chipsHtml}
      ${tabsHtml}
      <div class="hub-action-rail">
        ${secondariesHtml}
        ${primaryHtml}
      </div>
    </div>`;
}

/**
 * Wrap a label + input control in a .hub-input-group. Helper for inline template literals.
 * @param {{label:string, control:string, help?:string, error?:string, id?:string}} opts
 * @returns {string}
 */
export function renderInputGroup(opts) {
  const { label, control, help = '', error = '', id = '' } = opts || {};
  return `
    <div class="hub-input-group" ${id ? `id="${id}"` : ''}>
      <label>${escapeHtml(label)}</label>
      ${control}
      ${help ? `<span class="hub-input-help">${escapeHtml(help)}</span>` : ''}
      ${error ? `<span class="hub-input-error">${escapeHtml(error)}</span>` : ''}
    </div>`;
}

/**
 * Render a KPI row for the results shelf.
 * @param {{label:string, value:string, hint?:string}[]} kpis
 * @param {{title?:string}} [opts]
 * @returns {string}
 */
export function renderResultsShelf(kpis, opts = {}) {
  const { title = 'Latest Run' } = opts;
  return `
    <div class="hub-results-shelf">
      <div class="hub-results-header">${escapeHtml(title)}</div>
      <div class="hub-results-kpis">
        ${kpis.map(k => `
          <div class="hub-results-kpi" ${k.hint ? `title="${escapeAttr(k.hint)}"` : ''}>
            <span class="kpi-label">${escapeHtml(k.label)}</span>
            <span class="kpi-value">${escapeHtml(k.value)}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
}

/**
 * Bind Cmd/Ctrl+Enter to fire the primary action in this tool root.
 * Also adds a short green flash when the action fires.
 *
 * @param {HTMLElement} rootEl
 * @param {string} action          The data-action value to click
 * @param {() => void} [onRun]     Optional callback instead of clicking
 */
export function bindPrimaryActionShortcut(rootEl, action, onRun) {
  if (!rootEl || !action) return;
  const handler = (e) => {
    if (!(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
    const btn = rootEl.querySelector(`[data-primary-action="${action}"]`) || rootEl.querySelector(`[data-action="${action}"]`);
    if (!btn) return;
    e.preventDefault();
    if (typeof onRun === 'function') onRun();
    else /** @type {HTMLButtonElement} */ (btn).click();
    flashRunButton(btn);
  };
  rootEl.addEventListener('keydown', handler);
  // Return the unbind function in case caller wants it
  return () => rootEl.removeEventListener('keydown', handler);
}

/**
 * Flash the green success ring on the run button (called automatically by the
 * shortcut binding; tools can call it explicitly after their run completes).
 * @param {Element|null} btn
 */
export function flashRunButton(btn) {
  if (!btn) return;
  btn.classList.remove('ran');
  // Force reflow so the animation restarts
  void /** @type {HTMLElement} */ (btn).offsetWidth;
  btn.classList.add('ran');
}

/** Minimal helpers. */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

export default { renderToolHeader, renderInputGroup, renderResultsShelf, bindPrimaryActionShortcut, flashRunButton };

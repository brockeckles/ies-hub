/**
 * IES Hub v3 — Shared Tool Chrome (CM Chrome v3 ripple, step 2)
 *
 * Two-tier top ribbon (Row 1 phase tabs + actions; Row 2 section pills +
 * slim KPI strip) + collapsible sidebar drawer. Extracted from the CM
 * chrome shipped 2026-04-28 EVE and the NetOpt chrome shipped
 * 2026-04-29 (commit 28204ea), based on the union of their needs.
 *
 * Pattern: pure render functions + event delegation. The tool keeps its
 * own state (activeSection, activePhase, isDirty, etc.) and calls
 * `renderToolChrome(opts)` to produce shell HTML, then
 * `bindToolChromeEvents(rootEl, handlers)` once per renderShell to wire
 * up all clicks via delegation. Surgical refreshes after state changes
 * use `refreshToolChrome(rootEl, opts)` — only rebuilds the phase tabs,
 * section pills, save chip, and KPI strip without touching content.
 *
 * @module shared/tool-chrome
 */

function _h(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function _a(s) { return _h(s); }

function _sectionsByGroup(groups, sections) {
  const m = new Map();
  for (const g of groups) m.set(g.key, []);
  for (const s of sections) {
    const arr = m.get(s.group);
    if (arr) arr.push(s);
  }
  return m;
}

function _phaseTabsHtml(opts) {
  const { groups, sections, activePhase, sectionCompleteness } = opts;
  const sectionsByGroup = _sectionsByGroup(groups, sections);
  return groups.map(g => {
    const items = sectionsByGroup.get(g.key) || [];
    const completes = items.filter(s => sectionCompleteness(s.key) === 'complete').length;
    const partials  = items.filter(s => sectionCompleteness(s.key) === 'partial').length;
    const total = items.length;
    const groupState = total === 0
      ? (g.key === activePhase ? 'partial' : 'empty')
      : (completes === total ? 'complete' : (completes + partials > 0 ? 'partial' : 'empty'));
    const isActive = g.key === activePhase;
    const countLabel = total === 0 ? '·' : (completes + '/' + total);
    return '<button class="tc-phase-tab' + (isActive ? ' tc-phase-tab--active' : '') + '" data-tc-phase="' + _a(g.key) + '" title="' + _a(g.description || '') + '">' +
      '<span class="tc-phase-tab__label">' + _h(g.label) + '</span>' +
      '<span class="tc-phase-tab__count tc-phase-tab__count--' + groupState + '">' + countLabel + '</span>' +
      '</button>';
  }).join('');
}

function _sectionPillsHtml(opts) {
  const { groups, sections, activePhase, activeSection, sectionCompleteness, emptyPhaseHint } = opts;
  const sectionsByGroup = _sectionsByGroup(groups, sections);
  const items = sectionsByGroup.get(activePhase) || [];
  if (items.length === 0) {
    const hint = (typeof emptyPhaseHint === 'string') ? emptyPhaseHint : 'No sub-sections in this phase';
    return hint ? '<span class="tc-section-pills__empty">' + _h(hint) + '</span>' : '';
  }
  return items.map(sec => {
    const c = sectionCompleteness(sec.key);
    const isActive = sec.key === activeSection;
    return '<button class="tc-section-pill' + (isActive ? ' tc-section-pill--active' : '') + '" data-tc-section="' + _a(sec.key) + '">' +
      '<span class="tc-section-pill__dot tc-section-pill__dot--' + c + '"></span>' +
      '<span class="tc-section-pill__label">' + _h(sec.label) + '</span>' +
      '</button>';
  }).join('');
}

function _saveStateChipHtml(saveState) {
  if (!saveState) return '';
  const state = saveState.state || 'draft';
  const label = state === 'draft' ? 'Draft' : (state === 'modified' ? 'Modified' : 'Saved');
  const whenHtml = saveState.when
    ? '<span class="tc-save-when" data-tc-save-when>' + _h(saveState.when) + '</span>'
    : '<span class="tc-save-when" data-tc-save-when style="display:none;"></span>';
  return '<span class="hub-status-chip dot ' + state + '" data-tc-save-chip data-tc-state="' + state + '" title="' + _a(saveState.title || 'Save state') + '">' + label + '</span>' + whenHtml;
}

function _actionButtonHtml(a) {
  if (!a || a.hidden) return '';
  if (a.kind === 'primary' || a.runState) {
    const isClean = a.runState === 'clean';
    const label = isClean ? (a.cleanLabel || '✓ Results current') : a.label;
    const icon = isClean ? '' : (a.icon ? '<span class="hub-run-icon">' + _h(a.icon) + '</span>' : '');
    const title = isClean ? (a.cleanTitle || 'Inputs unchanged since last run. Click to force a re-run.') : (a.title || '');
    return '<button class="hub-btn hub-run-btn ' + (isClean ? 'is-clean' : '') + '" data-tc-action="' + _a(a.id) + '" data-tc-primary data-run-state="' + (a.runState || 'dirty') + '" title="' + _a(title) + '">' +
      icon +
      '<span>' + _h(label) + '</span>' +
      '<span class="hub-run-shortcut">⌘↵</span>' +
      '</button>';
  }
  const cls = a.primary ? 'hub-btn hub-btn-primary hub-btn-sm' : 'hub-btn hub-btn-secondary hub-btn-sm';
  return '<button class="' + cls + '" data-tc-action="' + _a(a.id) + '" title="' + _a(a.title || '') + '">' +
    (a.icon ? _h(a.icon) + ' ' : '') + _h(a.label) +
    '</button>';
}

/**
 * Render the full tool chrome shell. Returns HTML string to set as
 * rootEl.innerHTML. Includes top ribbon, sidebar drawer, content area
 * placeholder, AND the chrome stylesheet.
 */
export function renderToolChrome(opts) {
  const {
    toolKey = 'tool',
    saveState = null,
    actions = [],
    showSidebar = false,
    sidebarHeader = 'All Sections',
    sidebarBody = '',
    sidebarFooter = '',
    bodyHtml = '<div class="hub-builder-form"></div>',
    showBackButton = true,
    backTitle = 'Back to scenarios',
    showSidebarToggle = true,
    bodyId = '',
    fileInputs = '',
  } = opts;

  const phaseTabs = _phaseTabsHtml(opts);
  const sectionPills = _sectionPillsHtml(opts);
  const saveChip = _saveStateChipHtml(saveState);
  const actionsHtml = actions.map(_actionButtonHtml).join('');

  const sidebarOpen = showSidebar ? 'true' : 'false';
  const bodyAttr = bodyId ? ' id="' + _a(bodyId) + '"' : '';

  const row2PrefixHtml = opts.row2Prefix || '';
  return (
    '<div class="hub-builder tool-chrome-shell" data-tool="' + _a(toolKey) + '" style="height: calc(100vh - 48px); display: flex; flex-direction: column;">' +
      '<header class="tc-top">' +
        '<div class="tc-top__row1">' +
          (showBackButton ? '<button class="tc-top__back hub-btn hub-btn-sm hub-btn-secondary" data-tc-back title="' + _a(backTitle) + '">←</button>' : '') +
          '<nav class="tc-phase-tabs">' + phaseTabs + '</nav>' +
          '<div class="tc-top__row1-spacer"></div>' +
          '<div class="tc-top__actions">' +
            saveChip +
            actionsHtml +
            (showSidebarToggle ? '<button class="tc-top__toggle" data-tc-sidebar="toggle" title="Show full section list">☰</button>' : '') +
          '</div>' +
        '</div>' +
        '<div class="tc-top__row2">' +
          row2PrefixHtml +
          '<nav class="tc-section-pills">' + sectionPills + '</nav>' +
          '<div class="tc-top__kpis" data-tc-kpis></div>' +
        '</div>' +
      '</header>' +
      '<div class="tc-body" data-sidebar-open="' + sidebarOpen + '">' +
        (showSidebarToggle ? (
          '<aside class="tc-sidebar">' +
            '<div class="tc-sidebar__header">' +
              '<span class="text-subtitle">' + _h(sidebarHeader) + '</span>' +
              '<button class="tc-sidebar__close" data-tc-sidebar="close" title="Hide">✕</button>' +
            '</div>' +
            '<nav class="tc-sidebar__body">' + sidebarBody + '</nav>' +
            (sidebarFooter ? '<div class="tc-sidebar__footer">' + sidebarFooter + '</div>' : '') +
          '</aside>'
        ) : '') +
        '<div class="hub-builder-content tc-content"' + bodyAttr + '>' +
          bodyHtml +
        '</div>' +
      '</div>' +
      fileInputs +
    '</div>' +
    _stylesheet()
  );
}

/**
 * Surgical refresh of phase tabs + section pills + save chip + sidebar
 * body + sidebar drawer toggle. Does NOT re-render content.
 */
export function refreshToolChrome(rootEl, opts) {
  if (!rootEl) return;

  const tabsEl = rootEl.querySelector('.tc-phase-tabs');
  if (tabsEl) tabsEl.innerHTML = _phaseTabsHtml(opts);

  const pillsEl = rootEl.querySelector('.tc-section-pills');
  if (pillsEl) pillsEl.innerHTML = _sectionPillsHtml(opts);

  // row2Prefix updates (e.g., WSC's Configure toggle pill state).
  if (opts.row2Prefix !== undefined) {
    const row2 = rootEl.querySelector('.tc-top__row2');
    if (row2) {
      // Replace any existing prefix node (the first child before .tc-section-pills).
      const pillsNav = row2.querySelector('.tc-section-pills');
      if (pillsNav) {
        // Remove any sibling nodes BEFORE the pills nav.
        while (pillsNav.previousSibling) row2.removeChild(pillsNav.previousSibling);
        if (opts.row2Prefix) {
          const tmp = document.createElement('div');
          tmp.innerHTML = opts.row2Prefix;
          while (tmp.firstChild) row2.insertBefore(tmp.firstChild, pillsNav);
        }
      }
    }
  }

  if (opts.saveState) {
    const chip = rootEl.querySelector('[data-tc-save-chip]');
    if (chip) {
      const state = opts.saveState.state || 'draft';
      chip.classList.remove('draft', 'modified', 'saved');
      chip.classList.add(state);
      chip.dataset.tcState = state;
      chip.textContent = state === 'draft' ? 'Draft' : (state === 'modified' ? 'Modified' : 'Saved');
      chip.title = opts.saveState.title || 'Save state';
    }
    const whenEl = rootEl.querySelector('[data-tc-save-when]');
    if (whenEl) {
      whenEl.textContent = opts.saveState.when || '';
      whenEl.style.display = opts.saveState.when ? '' : 'none';
    }
  }

  if (opts.sidebarBody !== undefined) {
    const body = rootEl.querySelector('.tc-sidebar__body');
    if (body) body.innerHTML = opts.sidebarBody;
  }

  if (typeof opts.showSidebar === 'boolean') {
    const bodyEl = rootEl.querySelector('.tc-body');
    if (bodyEl) bodyEl.dataset.sidebarOpen = opts.showSidebar ? 'true' : 'false';
  }
}

/**
 * Refresh just the action buttons rail. Use when only action state
 * (e.g. a primary Run button's clean/dirty class) changes.
 */
export function refreshToolChromeActions(rootEl, opts) {
  if (!rootEl) return;
  const railEl = rootEl.querySelector('.tc-top__actions');
  if (!railEl) return;
  const saveChip = _saveStateChipHtml(opts.saveState);
  const actionsHtml = (opts.actions || []).map(_actionButtonHtml).join('');
  const showSidebarToggle = opts.showSidebarToggle !== false;
  railEl.innerHTML = saveChip + actionsHtml +
    (showSidebarToggle ? '<button class="tc-top__toggle" data-tc-sidebar="toggle" title="Show full section list">☰</button>' : '');
}

/**
 * Render the KPI strip into [data-tc-kpis]. Items: [{label, value, hint?, key?}].
 *
 * Phase 5.2 (2026-04-29) — when an item carries a `key`, the chip becomes
 * a button with `data-cm-cell="<key>" data-cm-year="1"` so the consuming
 * tool's existing P&L cell-click delegation picks it up. Tools that don't
 * pass keys keep the legacy non-clickable span.
 */
export function refreshKpiStrip(rootEl, items) {
  if (!rootEl) return;
  const host = rootEl.querySelector('[data-tc-kpis]');
  if (!host) return;
  if (!items || items.length === 0) { host.innerHTML = ''; return; }
  host.innerHTML = items.map(it => {
    const tag = it.key ? 'button' : 'span';
    const clickable = it.key ? ' tc-kpi-chip--clickable' : '';
    const dataAttrs = it.key
      ? ` data-cm-cell="${_a(it.key)}" data-cm-year="1" type="button"`
      : '';
    return '<' + tag + ' class="tc-kpi-chip' + clickable + '"' + dataAttrs +
      (it.hint ? ' title="' + _a(it.hint) + '"' : '') + '>' +
      '<span class="tc-kpi-chip__label">' + _h(it.label) + '</span>' +
      '<span class="tc-kpi-chip__value">' + _h(it.value) + '</span>' +
      '</' + tag + '>';
  }).join('');
}

/**
 * Bind chrome events at the rootEl level via delegation. Idempotent.
 *
 * Handlers (all optional):
 *   onPhase(phaseKey)         — phase tab click
 *   onSection(sectionKey)     — section pill click
 *   onSidebar('toggle'|'close')
 *   onBack()
 *   onAction(actionId)        — any action button click
 *   onPrimaryShortcut(actionId) — Cmd/Ctrl+Enter
 */
export function bindToolChromeEvents(rootEl, handlers) {
  if (!rootEl || rootEl.__tcBound) return;
  rootEl.__tcBound = true;

  rootEl.addEventListener('click', e => {
    const phaseBtn = e.target.closest('[data-tc-phase]');
    if (phaseBtn && rootEl.contains(phaseBtn)) {
      handlers.onPhase && handlers.onPhase(phaseBtn.dataset.tcPhase);
      return;
    }
    const sectionBtn = e.target.closest('[data-tc-section]');
    if (sectionBtn && rootEl.contains(sectionBtn)) {
      handlers.onSection && handlers.onSection(sectionBtn.dataset.tcSection);
      return;
    }
    const sidebarBtn = e.target.closest('[data-tc-sidebar]');
    if (sidebarBtn && rootEl.contains(sidebarBtn)) {
      handlers.onSidebar && handlers.onSidebar(sidebarBtn.dataset.tcSidebar);
      return;
    }
    const backBtn = e.target.closest('[data-tc-back]');
    if (backBtn && rootEl.contains(backBtn)) {
      handlers.onBack && handlers.onBack();
      return;
    }
    const actionBtn = e.target.closest('[data-tc-action]');
    if (actionBtn && rootEl.contains(actionBtn)) {
      handlers.onAction && handlers.onAction(actionBtn.dataset.tcAction);
      return;
    }
  });

  if (handlers.onPrimaryShortcut) {
    const onKey = e => {
      if (!(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
      if (!document.contains(rootEl)) return;
      const primary = rootEl.querySelector('[data-tc-primary][data-tc-action]');
      if (!primary) return;
      e.preventDefault();
      handlers.onPrimaryShortcut(primary.dataset.tcAction);
    };
    document.addEventListener('keydown', onKey);
    rootEl.__tcShortcutHandler = onKey;
  }
}

/**
 * Brief flash on the primary action button after a Run fires.
 */
export function flashPrimaryAction(rootEl) {
  if (!rootEl) return;
  const btn = rootEl.querySelector('[data-tc-primary]');
  if (!btn) return;
  btn.classList.add('tc-flash');
  setTimeout(() => btn.classList.remove('tc-flash'), 520);
}

function _stylesheet() {
  return `
    <style data-tool-chrome>
      .tool-chrome-shell .tc-top {
        background: var(--ies-navy, #001f3f);
        color: #fff;
        flex: 0 0 auto;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .tool-chrome-shell .tc-top__row1 {
        display: flex; align-items: center; gap: 12px;
        padding: 8px 16px;
        min-height: 44px;
      }
      .tool-chrome-shell .tc-top__back { flex: 0 0 auto; }
      .tool-chrome-shell .tc-phase-tabs { display: flex; gap: 2px; flex: 0 0 auto; }
      .tool-chrome-shell .tc-phase-tab {
        background: transparent; border: none; cursor: pointer;
        color: rgba(255,255,255,0.7);
        padding: 7px 14px;
        border-radius: 4px;
        font-size: 12px; font-weight: 600;
        display: inline-flex; align-items: center; gap: 8px;
        transition: background 0.12s, color 0.12s;
      }
      .tool-chrome-shell .tc-phase-tab:hover { color: #fff; background: rgba(255,255,255,0.06); }
      .tool-chrome-shell .tc-phase-tab--active { color: #fff; background: rgba(255,255,255,0.14); }
      .tool-chrome-shell .tc-phase-tab__count {
        font-size: 9px; font-weight: 700;
        padding: 1px 6px; border-radius: 8px;
        background: rgba(255,255,255,0.16);
        color: rgba(255,255,255,0.85);
      }
      .tool-chrome-shell .tc-phase-tab__count--complete { background: var(--ies-green, #16a34a); color: #fff; }
      .tool-chrome-shell .tc-phase-tab__count--partial  { background: #f59e0b; color: #fff; }
      .tool-chrome-shell .tc-phase-tab__count--empty    { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.6); }
      .tool-chrome-shell .tc-top__row1-spacer { flex: 1 1 auto; min-width: 8px; }
      .tool-chrome-shell .tc-top__kpis {
        flex: 0 1 auto;
        display: flex; align-items: center; gap: 18px;
        color: rgba(255,255,255,0.85);
      }
      .tool-chrome-shell .tc-top__actions {
        flex: 0 0 auto;
        display: flex; align-items: center; gap: 6px;
      }
      .tool-chrome-shell .tc-top__toggle {
        background: transparent; border: 1px solid rgba(255,255,255,0.2); cursor: pointer;
        color: #fff;
        width: 30px; height: 28px;
        border-radius: 4px;
        font-size: 16px; line-height: 1;
        margin-left: 4px;
      }
      .tool-chrome-shell .tc-top__toggle:hover { background: rgba(255,255,255,0.08); }
      .tool-chrome-shell .tc-top__row2 {
        background: rgba(0,0,0,0.16);
        padding: 6px 16px;
        min-height: 38px;
        display: flex; align-items: center; gap: 16px;
      }
      .tool-chrome-shell .tc-row2-toggle {
        flex: 0 0 auto;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.18);
        cursor: pointer;
        color: #fff;
        padding: 5px 12px;
        border-radius: 16px;
        font-size: 11px; font-weight: 700;
        display: inline-flex; align-items: center; gap: 6px;
        margin-right: 12px;
        transition: background 0.12s, border-color 0.12s;
        white-space: nowrap;
      }
      .tool-chrome-shell .tc-row2-toggle:hover { background: rgba(255,255,255,0.14); border-color: rgba(255,255,255,0.32); }
      .tool-chrome-shell .tc-row2-toggle--active {
        background: #fff; color: var(--ies-navy, #001f3f); border-color: #fff;
      }
      .tool-chrome-shell .tc-row2-toggle__icon { font-size: 12px; line-height: 1; }
      .tool-chrome-shell .tc-row2-divider {
        width: 1px; height: 18px;
        background: rgba(255,255,255,0.16);
        margin: 0 8px 0 0;
        flex: 0 0 auto;
      }

      .tool-chrome-shell .tc-section-pills {
        flex: 1 1 auto; min-width: 0;
        display: flex; gap: 4px; flex-wrap: wrap;
      }
      .tool-chrome-shell .tc-section-pills__empty {
        font-size: 11px; color: rgba(255,255,255,0.55); font-style: italic;
      }
      .tool-chrome-shell .tc-section-pill {
        background: transparent; border: 1px solid transparent; cursor: pointer;
        color: rgba(255,255,255,0.7);
        padding: 5px 12px;
        border-radius: 16px;
        font-size: 11px; font-weight: 600;
        display: inline-flex; align-items: center; gap: 6px;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      .tool-chrome-shell .tc-section-pill:hover { color: #fff; background: rgba(255,255,255,0.08); }
      .tool-chrome-shell .tc-section-pill--active {
        color: var(--ies-navy, #001f3f);
        background: #fff;
        border-color: #fff;
      }
      .tool-chrome-shell .tc-section-pill__dot {
        width: 7px; height: 7px; border-radius: 50%;
        flex-shrink: 0;
      }
      .tool-chrome-shell .tc-section-pill__dot--complete { background: var(--ies-green, #16a34a); }
      .tool-chrome-shell .tc-section-pill__dot--partial  { background: #f59e0b; }
      .tool-chrome-shell .tc-section-pill__dot--empty    { background: rgba(255,255,255,0.25); }
      .tool-chrome-shell .tc-section-pill--active .tc-section-pill__dot--empty { background: rgba(0,0,0,0.18); }

      .tool-chrome-shell .tc-kpi-chip {
        display: inline-flex; flex-direction: column; align-items: flex-start;
        line-height: 1.1; white-space: nowrap;
      }
      .tool-chrome-shell .tc-kpi-chip__label {
        font-size: 9px; font-weight: 600;
        color: rgba(255,255,255,0.55);
        text-transform: uppercase; letter-spacing: 0.04em;
      }
      .tool-chrome-shell .tc-kpi-chip__value {
        font-size: 13px; font-weight: 700;
        color: #fff;
        margin-top: 1px;
      }
      /* Phase 5.2 — clickable KPI chip variant. Reset button defaults so
         the click target is a button styled identically to the span. */
      .tool-chrome-shell button.tc-kpi-chip {
        background: transparent; border: 0; padding: 2px 6px; margin: 0;
        cursor: pointer; font: inherit; color: inherit; text-align: left;
        border-radius: 4px;
        transition: background 0.12s ease;
      }
      .tool-chrome-shell button.tc-kpi-chip:hover {
        background: rgba(255,255,255,0.08);
      }
      .tool-chrome-shell button.tc-kpi-chip:focus-visible {
        outline: 2px solid rgba(255,255,255,0.6);
        outline-offset: 2px;
      }
      .tool-chrome-shell button.tc-kpi-chip.is-active {
        background: rgba(255,255,255,0.16);
      }

      .tool-chrome-shell .tc-body {
        flex: 1 1 auto; display: flex; min-height: 0;
        position: relative;
      }
      .tool-chrome-shell .tc-sidebar {
        flex: 0 0 240px; width: 240px;
        background: #fff;
        border-right: 1px solid var(--ies-gray-200);
        overflow-y: auto;
        transition: width 0.18s ease, flex-basis 0.18s ease;
      }
      .tool-chrome-shell .tc-body[data-sidebar-open="false"] .tc-sidebar {
        flex: 0 0 0; width: 0; overflow: hidden; border-right: 0;
      }
      .tool-chrome-shell .tc-sidebar__header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid var(--ies-gray-200);
      }
      .tool-chrome-shell .tc-sidebar__body { padding: 8px 0; }
      .tool-chrome-shell .tc-nav-group { margin-bottom: 4px; }
      .tool-chrome-shell .tc-nav-group-label {
        padding: 12px 16px 4px;
        font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
        color: var(--ies-gray-500); text-transform: uppercase;
      }
      .tool-chrome-shell .tc-nav-item {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 16px;
        cursor: pointer;
        font-size: 13px; font-weight: 600;
        color: var(--ies-gray-600);
        transition: all 0.15s ease;
        border-left: 3px solid transparent;
      }
      .tool-chrome-shell .tc-nav-item:hover { background: var(--ies-gray-50); color: var(--ies-navy); }
      .tool-chrome-shell .tc-nav-item.active { background: rgba(0,71,171,0.06); color: var(--ies-blue); border-left-color: var(--ies-blue); }
      .tool-chrome-shell .tc-nav-check {
        width: 14px; height: 14px;
        border-radius: 50%;
        border: 2px solid var(--ies-gray-300);
        flex-shrink: 0;
      }
      .tool-chrome-shell .tc-nav-check.complete {
        background: var(--ies-green, #16a34a);
        border-color: var(--ies-green, #16a34a);
      }
      .tool-chrome-shell .tc-sidebar__close {
        background: transparent; border: none; cursor: pointer;
        color: var(--ies-gray-500);
        font-size: 14px; line-height: 1; padding: 2px 6px;
      }
      .tool-chrome-shell .tc-sidebar__close:hover { color: var(--ies-navy); }
      .tool-chrome-shell .tc-sidebar__footer {
        padding: 10px 16px;
        border-top: 1px solid var(--ies-gray-200);
        font-size: 11px;
        color: var(--ies-gray-600);
      }

      .tool-chrome-shell .hub-builder-content {
        flex: 1 1 auto;
        overflow-y: auto;
        background: var(--ies-gray-50, #f8fafc);
      }

      .tool-chrome-shell .tc-save-when {
        font-size: 10px;
        color: rgba(255,255,255,0.55);
        margin-left: 2px;
        white-space: nowrap;
      }
      .tool-chrome-shell .tc-flash {
        animation: tc-flash-anim 480ms ease-out;
      }
      @keyframes tc-flash-anim {
        0%   { box-shadow: 0 0 0 0 rgba(22,163,74,0.55); }
        100% { box-shadow: 0 0 0 14px rgba(22,163,74,0); }
      }
    </style>
  `;
}

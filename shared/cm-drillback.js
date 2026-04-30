/**
 * IES Hub v3 — Cross-tool CM drillback chip
 *
 * Phase 5.4 of the volumes-as-nucleus redesign (2026-04-29). Provides a
 * compact "→ CM" affordance that downstream tools (WSC, NetOpt, OFP) can
 * render on their channel-bound outputs. Click navigates back to the
 * parent CM model and stashes a focus hint that CM consumes on mount to
 * scroll the Volumes & Profile section into view + activate the named
 * channel tab.
 *
 * @module shared/cm-drillback
 */

const STORAGE_KEY = 'ies-hub.cmDrillbackFocus';

/**
 * Render the chip HTML.
 *
 * @param {Object} opts
 * @param {string|number|null} opts.cmId       — Parent CM model ID. Required.
 * @param {string} [opts.channelKey]            — Channel key to focus on landing.
 * @param {string} [opts.channelName]           — Display name for the chip.
 * @param {string} [opts.label]                 — Override the default label.
 * @param {string} [opts.title]                 — Override the tooltip.
 * @returns {string} HTML for a clickable button. Empty string when cmId is missing.
 */
export function renderCmDrillbackChip(opts) {
  const cmId = opts && opts.cmId != null ? String(opts.cmId) : null;
  if (!cmId) return '';
  const channelKey  = opts.channelKey  || '';
  const channelName = opts.channelName || channelKey || '';
  const label = opts.label || (channelName ? `→ CM · ${channelName}` : `→ CM`);
  const title = opts.title || (channelName
    ? `Drill back to Cost Model #${cmId}, channel "${channelName}". Opens the parent model's Volumes & Profile section.`
    : `Drill back to Cost Model #${cmId}.`);
  return '<button type="button" class="cm-drillback-chip" '
    + `data-cm-drillback="${_a(cmId)}" data-cm-drillback-channel="${_a(channelKey)}" `
    + `title="${_a(title)}" aria-label="${_a(title)}" `
    + 'style="display:inline-flex;align-items:center;gap:3px;background:#eef2ff;color:#3730a3;'
    + 'border:1px solid #c7d2fe;border-radius:10px;padding:1px 8px;font-size:10px;font-weight:600;'
    + 'line-height:1.3;margin-left:6px;cursor:pointer;font-family:inherit;white-space:nowrap;">'
    + _h(label) + '</button>';
}

/**
 * Bind a single delegated click handler to `rootEl` that intercepts
 * `[data-cm-drillback]` clicks. Idempotent — calling twice on the same
 * element no-ops the second binding.
 *
 * @param {Element} rootEl
 */
export function bindCmDrillback(rootEl) {
  if (!rootEl || rootEl.__cmDrillbackBound) return;
  rootEl.__cmDrillbackBound = true;
  rootEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-cm-drillback]');
    if (!btn || !rootEl.contains(btn)) return;
    e.preventDefault();
    const cmId = btn.dataset.cmDrillback;
    const channelKey = btn.dataset.cmDrillbackChannel || '';
    if (!cmId) return;
    // Stash both hand-offs: cm_pending_open is the established CM-load
    // signal (read by mount()), cmDrillbackFocus is the channel/section
    // intent that mount() consumes immediately after the load completes.
    setFocusHint({ cmId, channelKey });
    try {
      sessionStorage.setItem('cm_pending_open', JSON.stringify({
        id: Number(cmId), at: Date.now(),
      }));
    } catch { /* storage may be disabled */ }
    // Router only registers `designtools/cost-model` (no /:id segment),
    // so navigate without the id; CM mount picks the project up via the
    // pending-open hand-off and then consumes the focus hint.
    window.location.hash = 'designtools/cost-model';
  });
}

/**
 * Persist a focus hint in sessionStorage. CM consumes it on mount.
 */
export function setFocusHint(hint) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      cmId: String(hint.cmId),
      channelKey: hint.channelKey || '',
      ts: Date.now(),
    }));
  } catch { /* storage may be disabled */ }
}

/**
 * Read + clear the focus hint. Returns null when none set or expired
 * (>60s old, prevents stale hints from sticking across sessions).
 */
export function consumeFocusHint() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const hint = JSON.parse(raw);
    sessionStorage.removeItem(STORAGE_KEY);
    if (!hint || !hint.ts || (Date.now() - hint.ts) > 60_000) return null;
    return hint;
  } catch {
    return null;
  }
}

// Compact HTML / attribute escapers — duplicated from each tool to keep
// this module dependency-free.
function _h(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _a(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

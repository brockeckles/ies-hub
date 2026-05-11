/**
 * IES Hub v3 — Cost Model OFP (Operational Flow Plan) helpers
 *
 * Pure stateless helpers extracted from cost-model/ui.js as part of the
 * port-readiness sprint (S20). Everything in this module is either a
 * canonical option list or a string-mapping function — no closure-state
 * reads, no model mutation. Safe to call from anywhere.
 *
 * The rest of the OFP cluster (renderOperationalFlow + its stateful
 * registry/move/reorder helpers + the modals) is still in ui.js and is
 * blocked on a state-layer decision before further carve-out.
 *
 * @module tools/cost-model/ofp-helpers
 */
import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260511-port12';

// ============================================================
// Canonical option lists (UI-bound dropdowns + label lookup)
// ============================================================

export const OFP_MHE_OPTIONS = [
  ['',                     'None'],
  ['reach_truck',          'Reach Truck'],
  ['sit_down_forklift',    'Sit-Down FL'],
  ['stand_up_forklift',    'Stand-Up FL'],
  ['order_picker',         'Order Picker'],
  ['walkie_rider',         'Walkie Rider'],
  ['pallet_jack',          'Pallet Jack'],
  ['electric_pallet_jack', 'Electric Pallet Jack'],
  ['turret_truck',         'Turret Truck'],
  ['amr',                  'AMR / Robot'],
  ['conveyor',             'Conveyor'],
  ['manual',               'Manual / Walk'],
];

export const OFP_IT_OPTIONS = [
  ['',                'None'],
  ['rf_scanner',      'RF Scanner'],
  ['voice_pick',      'Voice Pick'],
  ['wearable',        'Wearable'],
  ['tablet',          'Tablet'],
  ['vision_system',   'Vision System'],
  ['pick_to_light',   'Pick-to-Light'],
  ['pick_to_display', 'Pick-to-Display'],
];

// v0.3a — Canonical UoM set. Other surfaces in the model use line.uom
// as a free-text field; OFP standardizes around this list for the
// detail panel dropdowns. 'other' is the escape hatch for the rare
// case (parcel, fluid, bulk) without forcing every dropdown to enumerate.
export const OFP_UOMS = ['pallet', 'case', 'each', 'layer', 'other'];

// ============================================================
// MHE / IT icon catalog (24x24 viewBox, render at 14-18px)
// ============================================================
//
// Path content only — the wrapping <svg> is added by the renderer.
// Fuzzy match on lowercase, _-and-space-normalized strings so
// REACH_TRUCK / reach-truck / "Reach Truck" all map the same.

export const OFP_MHE_ICONS = {
  // Sit-down forklift — chunky body, mast right, 2 wheels
  forklift: '<rect x="3" y="13" width="10" height="5" rx="1" /><rect x="13" y="4" width="2.5" height="14" /><rect x="15.5" y="16" width="6" height="1.5" /><circle cx="6" cy="20" r="1.8" /><circle cx="11" cy="20" r="1.8" />',
  // Reach truck — narrower body, taller mast
  reach_truck: '<rect x="3" y="13" width="8" height="5" rx="1" /><rect x="11" y="2" width="2" height="16" /><rect x="13" y="16" width="7" height="1" /><circle cx="5.5" cy="20" r="1.6" /><circle cx="9" cy="20" r="1.6" />',
  // Electric pallet jack (EPJ) — low flat platform
  epj: '<rect x="4" y="16" width="15" height="3" rx="0.4" /><rect x="3" y="11" width="3.5" height="5" rx="0.4" /><circle cx="7" cy="20" r="1.3" /><circle cx="17" cy="20" r="1.3" />',
  // Order picker — tall vertical mast with operator basket
  order_picker: '<rect x="5" y="3" width="2.2" height="14" /><rect x="7.2" y="4" width="6" height="3.5" rx="0.4" /><rect x="3" y="16" width="10" height="3" rx="0.4" /><circle cx="5" cy="20" r="1.1" /><circle cx="11" cy="20" r="1.1" />',
  // Walkie pallet jack — angled operator handle
  walkie: '<rect x="3" y="16" width="13" height="3" rx="0.4" /><path d="M16 16 L20 6" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" /><circle cx="20" cy="5.5" r="1.4" /><circle cx="6" cy="20" r="1.3" /><circle cx="13" cy="20" r="1.3" />',
  // Turret / VNA — thin tall body
  turret: '<rect x="9" y="3" width="1.6" height="14" /><rect x="6" y="13" width="7.5" height="4" rx="0.4" /><circle cx="7.5" cy="19.5" r="1.4" /><circle cx="12" cy="19.5" r="1.4" />',
  // Pallet jack (manual) — like walkie but with vertical handle
  pallet_jack: '<rect x="3" y="16" width="13" height="3" rx="0.4" /><rect x="14" y="6" width="1.5" height="10" /><rect x="13" y="4.5" width="3.5" height="2" rx="0.5" /><circle cx="6" cy="20" r="1.3" /><circle cx="13" cy="20" r="1.3" />',
  // AMR — round robot with sensor eye
  amr: '<rect x="4" y="6" width="16" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.6" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><path d="M8 16 h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />',
  // Conveyor — rollers in a line with arrow
  conveyor: '<rect x="2" y="11" width="20" height="2" rx="0.5" /><circle cx="5" cy="12" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="12" cy="12" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="19" cy="12" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M15 6 L19 6 L17 4 M19 6 L17 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" />',
  // Manual / walk — person silhouette
  manual: '<circle cx="12" cy="5" r="2.4" /><path d="M12 8 v8 M9 11 l3 -2 l3 2 M10 21 l2 -5 l2 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />',
};

export const OFP_IT_ICONS = {
  // RF Scanner — handheld pistol-grip with screen
  rf_scanner: '<path d="M3 6 h13 v6 h-4 v6 h-4 v-6 H3 z" /><path d="M16 6 L20 3" stroke-width="1.6" stroke="currentColor" fill="none" stroke-linecap="round" /><rect x="5" y="8" width="9" height="2" rx="0.3" fill="#fff" />',
  // Voice pick — headset with mic
  voice: '<path d="M5 13 v-3 a7 7 0 0 1 14 0 v3" fill="none" stroke="currentColor" stroke-width="2" /><rect x="3" y="12" width="3.5" height="6" rx="0.6" /><rect x="17.5" y="12" width="3.5" height="6" rx="0.6" /><path d="M19 18 v2 a1 1 0 0 1 -1 1 h-3" stroke="currentColor" stroke-width="1.5" fill="none" />',
  // Vision system — camera with lens
  vision: '<rect x="3" y="7" width="18" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6" /><circle cx="12" cy="12.5" r="3" fill="none" stroke="currentColor" stroke-width="1.6" /><circle cx="12" cy="12.5" r="1.2" /><rect x="7" y="5" width="4" height="2" rx="0.4" />',
  // Tablet — rectangle with home button
  tablet: '<rect x="5" y="2" width="14" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="1.7" /><circle cx="12" cy="19" r="0.9" />',
  // Pick-to-Light — lightbulb cluster
  pick_to_light: '<circle cx="6" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5" /><circle cx="18" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5" /><circle cx="12" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="1.5" /><circle cx="6" cy="8" r="0.9" /><circle cx="18" cy="8" r="0.9" /><circle cx="12" cy="16" r="0.9" />',
  // Pick-to-Display — screen with arrow
  pick_to_display: '<rect x="3" y="5" width="18" height="13" rx="1" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M9 11 h6 M12 8 l3 3 l-3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" />',
  // Wearable — smartwatch face + band
  wearable: '<rect x="6" y="7" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M9 7 L10 3 H14 L15 7 M9 17 L10 21 H14 L15 17" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round" /><circle cx="12" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.2" />',
  // Manual / paper — clipboard
  manual: '<rect x="5" y="4" width="14" height="18" rx="1" fill="none" stroke="currentColor" stroke-width="1.6" /><rect x="9" y="2" width="6" height="3" rx="0.5" /><path d="M8 10 h8 M8 13 h8 M8 16 h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />',
};

// ============================================================
// Icon-key resolvers — fuzzy-match a type string to an icon key
// ============================================================

/**
 * Map an MHE type string (any casing/punctuation) to a key in
 * OFP_MHE_ICONS, or null if nothing matches.
 */
export function ofpMheIconKey(t) {
  if (!t) return null;
  const k = String(t).toLowerCase().replace(/[-\s]+/g, '_');
  if (k === 'none') return null;
  if (k.includes('amr') || k.includes('robot')) return 'amr';
  if (k.includes('conveyor')) return 'conveyor';
  if (k.includes('reach')) return 'reach_truck';
  if (k.includes('order') && k.includes('pick')) return 'order_picker';
  if (k.includes('order_picker')) return 'order_picker';
  if (k.includes('turret') || k.includes('vna') || k.includes('narrow')) return 'turret';
  if (k.includes('walkie') || k === 'wpt' || k.includes('walking')) return 'walkie';
  if (k.includes('epj') || (k.includes('electric') && k.includes('jack'))) return 'epj';
  if (k.includes('pallet_jack')) return 'pallet_jack';
  if (k.includes('forklift') || k.includes('sit_down') || k.includes('sitdown') || k.includes('counterbalance') || k.includes('stand_up') || k.includes('standup')) return 'forklift';
  if (k.includes('manual') || k.includes('walk')) return 'manual';
  return null;
}

/**
 * Map an IT-device type string (any casing/punctuation) to a key in
 * OFP_IT_ICONS, or null if nothing matches.
 */
export function ofpItIconKey(t) {
  if (!t) return null;
  const k = String(t).toLowerCase().replace(/[-\s]+/g, '_');
  if (k === 'none' || k === '') return null;
  if (k.includes('voice')) return 'voice';
  if (k.includes('vision') || k.includes('camera')) return 'vision';
  if (k.includes('wearable') || k.includes('watch')) return 'wearable';
  if (k.includes('pick_to_light') || (k.includes('light') && k.includes('pick'))) return 'pick_to_light';
  if (k.includes('pick_to_display') || (k.includes('display') && k.includes('pick'))) return 'pick_to_display';
  if (k.includes('tablet') || k.includes('rdt')) return 'tablet';
  if (k.includes('manual') || k.includes('paper')) return 'manual';
  if (k.includes('rf') || k.includes('scan')) return 'rf_scanner';
  return null;
}

// ============================================================
// Equipment label + badge renderers
// ============================================================

/**
 * Resolve a stored MHE/IT value (e.g. 'reach_truck') to its display
 * label ('Reach Truck'). Pulls from the canonical option lists. Falls
 * back to humanizing the snake_case value when not found.
 */
export function ofpEquipLabel(type, kind) {
  if (!type) return '';
  const options = kind === 'mhe' ? OFP_MHE_OPTIONS : OFP_IT_OPTIONS;
  const found = options.find(([v]) => v === type);
  if (found) return found[1];
  return String(type)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Build a pill-shaped badge: SVG icon + inline text label. data-tip
 * drives a CSS-only tooltip. Falls back to a monogram-only pill when
 * no icon matches the type.
 *
 * @param {string} type — stored value (e.g. 'reach_truck' or 'rf_scanner')
 * @param {'mhe'|'it'} kind — which catalog to pull from
 * @returns {string} — HTML string, '' when type is empty or 'none'
 */
export function ofpEquipBadge(type, kind /* 'mhe' | 'it' */) {
  if (!type || String(type).toLowerCase() === 'none') return '';
  const iconKey = kind === 'mhe' ? ofpMheIconKey(type) : ofpItIconKey(type);
  const palette = kind === 'mhe' ? OFP_MHE_ICONS : OFP_IT_ICONS;
  const className = kind === 'mhe' ? 'ofp-badge ofp-badge--mhe' : 'ofp-badge ofp-badge--it';
  const label = ofpEquipLabel(type, kind);
  const kindLabel = kind === 'mhe' ? 'Material Handling' : 'IT Device';
  const tip = `${kindLabel}: ${label}`;
  let iconHtml = '';
  if (iconKey && palette[iconKey]) {
    iconHtml = `<svg class="ofp-badge__icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none" aria-hidden="true">${palette[iconKey]}</svg>`;
  } else {
    // Monogram fallback when the type doesn't map to a known icon — a
    // 2-letter chip drawn into a square so the pill still has a visual
    // marker on the left.
    const mono = String(type).split(/[_\s-]+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().substring(0, 2) || '?';
    iconHtml = `<span class="ofp-badge__mono">${escapeHtml(mono)}</span>`;
  }
  return `<span class="${className}" data-tip="${escapeAttr(tip)}">${iconHtml}<span class="ofp-badge__label">${escapeHtml(label)}</span></span>`;
}

// ============================================================
// UoM accessors (input/output unit-of-measure with legacy fallback)
// ============================================================

/**
 * Read a labor line's input UoM, with backward-compat fallback to the
 * existing line.uom field when uom_in is unset on legacy models.
 */
export function ofpUomIn(line) {
  return (line?.uom_in || line?.uom || '').toLowerCase();
}

/**
 * Read a labor line's output UoM. Falls back to uom_in, then to the
 * legacy line.uom field.
 */
export function ofpUomOut(line) {
  return (line?.uom_out || line?.uom_in || line?.uom || '').toLowerCase();
}

// ============================================================
// Activity-name slugifier for flow-tag suggestions
// ============================================================

/**
 * Slugify an activity name into a flow-tag candidate.
 *
 * Example:
 *   "Outbound — Order Picking"  → "outbound-order"   (first 2 meaningful words)
 *   "VAS — kitting"             → "vas-kitting"
 *   ""                          → null
 *
 * Drops stopwords, punctuation, and short words; caps at 2 tokens / 24 chars.
 */
export function ofpSlugifyForFlow(name) {
  if (!name || typeof name !== 'string') return null;
  const STOP = new Set(['the','a','an','and','or','of','to','for','in','at','with','from','on','&']);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w))
    .slice(0, 2)
    .join('-')
    .substring(0, 24);
  return slug.length >= 2 ? slug : null;
}

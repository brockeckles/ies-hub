/**
 * IES Hub v3 — Cost Model Operational Flow registry (S22)
 *
 * Data + sort/move helpers for the per-cost-model Functional Area
 * registry (`model.ofpAreas`) and Flow Path registry (`model.ofpFlows`).
 * Extracted from cost-model/ui.js as part of the OFP cluster carve-out.
 *
 * The actual rendering (renderOperationalFlow + its sub-renderers + the
 * modals) is still in ui.js for now — see S23 for that follow-up.
 *
 * Contract:
 *   - Every function reads `model` from cmState (state.js). Mutations
 *     are in-place on model.ofpAreas / model.ofpFlows, so ui.js sees
 *     them via its local `let model` alias (they share the same object
 *     reference).
 *   - No DOM, no events, no rendering. Pure data layer.
 *
 * @module tools/cost-model/operational-flow-registry
 */
import { cmState } from './state.js?v=20260611-dirty1';

// ============================================================
// Default Functional Area catalog. This array is the SEED for new cost
// models — the actual runtime registry lives at model.ofpAreas (per-cost-
// model), which users can rename, recolor, edit keywords on, and add
// custom areas to. See ofpEnsureAreaRegistry() below for seeding logic.
//
// Each area has:
//   key:         stable id (matches line.flowLane override values)
//   label:       display name
//   color:       header stripe color
//   keywords:    activity_name keyword list for auto-classification
//   displayMode: 'main' (vertical column in the flow row) or 'wide' (full-width row below)
//   isProtected: if true, area cannot be deleted (unclassified is the
//                fallback bucket and the classifier needs it to exist)
//   sortOrder:   render order; main areas left-to-right, wide areas top-to-bottom
//
// Order in this seed matters — more specific keywords (e.g. "replenishment")
// should match before more generic ones (e.g. "ship"). The classifier
// lowercases activity_name + position role and tests each area's keywords
// in the order returned by ofpRegistry().
const _OFP_DEFAULT_AREAS = [
  { key: 'inbound',      label: 'Inbound',            color: '#0EA5E9', keywords: ['receiv', 'unload', 'dock', 'inbound', ' rx', 'gatehouse', 'putaway-prep', 'check-in', 'pallet build'], displayMode: 'main', isProtected: false, sortOrder: 0 },
  { key: 'storage',      label: 'Storage',            color: '#8B5CF6', keywords: ['putaway', 'put away', 'replen', 'replenish', 'storage', 'let-down', 'letdown', 'slot', 'cycle count', 'inventory move'], displayMode: 'main', isProtected: false, sortOrder: 1 },
  { key: 'outbound',     label: 'Outbound',           color: '#16A34A', keywords: ['pick', 'pack', 'stage', 'ship', 'load', 'dispatch', 'outbound', 'wave', 'consolidat', 'sort', 'manifest', 'palletiz'], displayMode: 'main', isProtected: false, sortOrder: 2 },
  { key: 'returnsVas',   label: 'Returns / VAS',      color: '#F59E0B', keywords: ['return', 'rtv', 'rework', 'kit', 'kitting', 'label', 'vas', 'value-add', 'value add', 'special', 'compliance', 'ticket', 'price'], displayMode: 'wide', isProtected: false, sortOrder: 3 },
  { key: 'support',      label: 'Support / Indirect', color: '#64748B', keywords: ['clean', 'janitor', 'supervisor', 'lead ', 'manager', 'admin', 'audit', 'cycle', 'inventory control', 'trainer', 'safety', 'qa', 'quality', 'security', ' im '], displayMode: 'wide', isProtected: false, sortOrder: 4 },
  { key: 'unclassified', label: 'Unclassified',       color: '#DC2626', keywords: [], displayMode: 'wide', isProtected: true,  sortOrder: 5 },
];

/**
 * Ensure model.ofpAreas exists. If absent or empty, deep-clone the
 * defaults into it so the registry is editable per-cost-model without
 * mutating the module-level seed.
 *
 * Backfills missing fields on legacy entries (e.g. saved before
 * displayMode was added). Always called at the top of OFP render
 * paths; safe to call repeatedly.
 */
export function ofpEnsureAreaRegistry() {
  const model = cmState.model;
  if (!Array.isArray(model.ofpAreas) || model.ofpAreas.length === 0) {
    model.ofpAreas = _OFP_DEFAULT_AREAS.map(a => ({ ...a, keywords: [...(a.keywords || [])] }));
    return;
  }
  model.ofpAreas.forEach((a, i) => {
    if (!a.displayMode) a.displayMode = 'main';
    if (typeof a.isProtected !== 'boolean') a.isProtected = a.key === 'unclassified';
    if (typeof a.sortOrder !== 'number') a.sortOrder = i;
    if (!Array.isArray(a.keywords)) a.keywords = [];
    if (typeof a.hidden !== 'boolean') a.hidden = false;
    // v0.10 — sub-areas (stackable functional sub-blocks within an area)
    if (!Array.isArray(a.subAreas)) a.subAreas = [];
    a.subAreas.forEach((sa, j) => {
      if (typeof sa.label !== 'string' || !sa.label) sa.label = sa.key;
      if (!Array.isArray(sa.keywords)) sa.keywords = [];
      if (typeof sa.sortOrder !== 'number') sa.sortOrder = j;
      if (typeof sa.hidden !== 'boolean') sa.hidden = false;
      if (!sa.color) sa.color = '#94A3B8';
    });
  });
  // Guarantee an unclassified entry exists — it's the classifier fallback.
  if (!model.ofpAreas.some(a => a.key === 'unclassified')) {
    const next = (model.ofpAreas.reduce((mx, a) => Math.max(mx, a.sortOrder || 0), 0)) + 1;
    model.ofpAreas.push({ key: 'unclassified', label: 'Unclassified', color: '#DC2626', keywords: [], displayMode: 'wide', isProtected: true, sortOrder: next });
  }
}

/**
 * Read the current Functional Area registry, sorted by sortOrder.
 */
export function ofpRegistry() {
  const model = cmState.model;
  ofpEnsureAreaRegistry();
  return [...model.ofpAreas].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

/**
 * Bin a labor line into one of the registered Functional Areas by
 * keyword match on activity_name + role. Indirect labor is forced to
 * 'support' (or 'unclassified' if support was deleted) by the caller;
 * this function classifies direct labor only.
 *
 * Resolution order:
 *   1. line.flowLane override wins IF it points to a registered area
 *   2. keyword match across the registry in sortOrder
 *   3. fallback to 'unclassified' (always present)
 */
export function ofpClassifyAreaFromLine(line) {
  if (!line) return 'unclassified';
  const registry = ofpRegistry();
  const keys = new Set(registry.map(a => a.key));
  if (line.flowLane && keys.has(line.flowLane)) return line.flowLane;
  const haystack = `${line.activity_name || ''} ${line.position || ''} ${line.role || ''} ${line.most_template || ''}`.toLowerCase();
  for (const area of registry) {
    if (area.key === 'unclassified') continue;
    for (const kw of (area.keywords || [])) {
      if (kw && haystack.includes(kw)) return area.key;
    }
  }
  return 'unclassified';
}

/**
 * v0.10 — Classify a labor line into a sub-area within its parent
 * Functional Area. Returns the sub-area key, or null if:
 *   - the line's parent area has no sub-areas defined
 *   - no sub-area's keywords match the line
 *
 * Resolution order:
 *   1. line.flowSubArea override wins IF it points to a registered sub-area
 *      within the line's parent area
 *   2. Keyword match across the parent's subAreas in sortOrder
 *   3. null (line renders in an "(other)" pile within the parent area)
 */
export function ofpClassifySubAreaFromLine(line, areaKey) {
  if (!line || !areaKey) return null;
  const area = ofpAreaMeta(areaKey);
  if (!area || !Array.isArray(area.subAreas) || area.subAreas.length === 0) return null;
  const subKeys = new Set(area.subAreas.map(sa => sa.key));
  if (line.flowSubArea && subKeys.has(line.flowSubArea)) return line.flowSubArea;
  const haystack = `${line.activity_name || ''} ${line.position || ''} ${line.role || ''} ${line.most_template || ''}`.toLowerCase();
  const sorted = [...area.subAreas].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  for (const sa of sorted) {
    for (const kw of (sa.keywords || [])) {
      if (kw && haystack.includes(kw)) return sa.key;
    }
  }
  return null;
}

/**
 * Area key → meta lookup (color, label, displayMode, etc.) from the
 * per-cost-model registry. Falls back to a synthetic gray entry for
 * unknown keys (shouldn't happen post-classifier-rewrite).
 */
export function ofpAreaMeta(key) {
  const model = cmState.model;
  ofpEnsureAreaRegistry();
  const found = model.ofpAreas.find(a => a.key === key);
  if (found) return found;
  return { key, label: key, color: '#64748B', keywords: [], displayMode: 'wide', isProtected: false, sortOrder: 999 };
}

// v0.3a — Path color palette. Flow tags are freeform strings (e.g.
// "full-pallet", "loose-case", "vas-kitting") that group labor lines
// flowing through the same operational journey across areas. Color is
// derived deterministically from the tag string so the same tag gets
// the same color every render. Untagged lines fall back to a neutral
// gray. The palette intentionally avoids the area colors (sky / purple /
// green / amber / slate / red) so flows are visually distinct from
// areas — both axes can be read at a glance.
const _OFP_FLOW_PALETTE = [
  '#2563EB', // blue
  '#DB2777', // pink
  '#059669', // emerald
  '#CA8A04', // yellow
  '#0891B2', // cyan
  '#BE185D', // rose
  '#6366F1', // indigo
  '#EA580C', // orange
];

/**
 * v0.4 — Per-cost-model Flow registry. Each flow has:
 *   tag:   stable id (matches line.path_tag — the persistence key)
 *   label: display name (defaults to tag; lets user rename without
 *          rewriting line.path_tag values across the cost model)
 *   color: optional hex override — when unset, falls back to deterministic
 *          hash from _OFP_FLOW_PALETTE for backward compat
 *
 * Lazy-seeded from existing line.path_tag values on first OFP render —
 * any tag that already appears on a line gets a registry entry so the
 * Manage Flows modal shows the full set.
 */
export function ofpEnsureFlowRegistry() {
  const model = cmState.model;
  if (!Array.isArray(model.ofpFlows)) model.ofpFlows = [];
  // Phase 4 (volumes-as-nucleus, 2026-04-29): each ofpFlow carries an
  // optional channelKey tying it to one of model.channels[]. Backfill auto-
  // matches existing flow tags to channel keys/names by case-insensitive
  // string contains so projects with conventionally-named flows ("DTC eCom",
  // "B2B Wholesale") get pre-tagged for free.
  const channels = Array.isArray(model.channels) ? model.channels : [];
  const matchChannel = (tagOrLabel) => {
    if (!tagOrLabel) return null;
    const haystack = String(tagOrLabel).toLowerCase();
    for (const c of channels) {
      if (!c || !c.key) continue;
      const k = String(c.key).toLowerCase();
      const n = String(c.name || '').toLowerCase();
      if (k && (haystack.includes(k) || k.includes(haystack))) return c.key;
      if (n && (haystack.includes(n) || n.includes(haystack))) return c.key;
    }
    return null;
  };
  // Backfill missing fields on legacy entries.
  model.ofpFlows.forEach((f, i) => {
    if (typeof f.label !== 'string' || !f.label) f.label = f.tag;
    if (typeof f.sortOrder !== 'number') f.sortOrder = i;
    if (typeof f.hidden !== 'boolean') f.hidden = false;
    // Only backfill channelKey when the flow doesn't already have one.
    // null is a valid "no channel" answer (designer chose unmapped).
    if (f.channelKey === undefined) {
      f.channelKey = matchChannel(f.tag) || matchChannel(f.label);
    }
  });
  // Lazy-add registry entries for tags that exist on lines but not in
  // the registry. Preserves user edits — only adds new ones.
  const known = new Set(model.ofpFlows.map(f => f.tag));
  const lineTags = new Set();
  for (const l of (model.laborLines || [])) {
    const t = (l?.path_tag || '').trim();
    if (t) lineTags.add(t);
  }
  for (const l of (model.indirectLaborLines || [])) {
    const t = (l?.path_tag || '').trim();
    if (t) lineTags.add(t);
  }
  for (const t of lineTags) {
    if (!known.has(t)) {
      const next = (model.ofpFlows.reduce((mx, f) => Math.max(mx, f.sortOrder || 0), -1)) + 1;
      model.ofpFlows.push({ tag: t, label: t, sortOrder: next, channelKey: matchChannel(t) });
    }
  }
}

export function ofpFlowRegistry() {
  const model = cmState.model;
  ofpEnsureFlowRegistry();
  return [...model.ofpFlows].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

// ============================================================
// v0.5 — Reorder helpers (areas + flows)
// ============================================================
//
// Both registries use sortOrder as the rank field. Public ops:
//   ofpReorderArea(srcKey, tgtKey, position) — drag/drop insertion
//   ofpMoveAreaUp(key) / ofpMoveAreaDown(key) — modal up/down buttons
//   plus _ofpReorderFlow / _ofpMoveFlowUp / _ofpMoveFlowDown
//
// All ops normalize sortOrder to dense 0..N-1 integers after each
// change so future swaps stay deterministic. Mutate model.ofpAreas /
// model.ofpFlows in place; caller is responsible for setting isDirty
// and re-rendering.

export function ofpNormalizeAreaSortOrder() {
  const model = cmState.model;
  ofpEnsureAreaRegistry();
  const list = [...model.ofpAreas].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  list.forEach((a, i) => { a.sortOrder = i; });
}

export function ofpNormalizeFlowSortOrder() {
  const model = cmState.model;
  ofpEnsureFlowRegistry();
  const list = [...model.ofpFlows].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  list.forEach((f, i) => { f.sortOrder = i; });
}

export function ofpReorderArea(srcKey, tgtKey, position /* 'before' | 'after' */) {
  const model = cmState.model;
  if (srcKey === tgtKey) return;
  ofpNormalizeAreaSortOrder();
  const sorted = [...model.ofpAreas].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const srcIdx = sorted.findIndex(a => a.key === srcKey);
  if (srcIdx === -1) return;
  const [item] = sorted.splice(srcIdx, 1);
  let tgtIdx = sorted.findIndex(a => a.key === tgtKey);
  if (tgtIdx === -1) return;
  if (position === 'after') tgtIdx++;
  sorted.splice(tgtIdx, 0, item);
  sorted.forEach((a, i) => { a.sortOrder = i; });
}

export function ofpReorderFlow(srcTag, tgtTag, position /* 'before' | 'after' */) {
  const model = cmState.model;
  if (srcTag === tgtTag) return;
  ofpNormalizeFlowSortOrder();
  const sorted = [...model.ofpFlows].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const srcIdx = sorted.findIndex(f => f.tag === srcTag);
  if (srcIdx === -1) return;
  const [item] = sorted.splice(srcIdx, 1);
  let tgtIdx = sorted.findIndex(f => f.tag === tgtTag);
  if (tgtIdx === -1) return;
  if (position === 'after') tgtIdx++;
  sorted.splice(tgtIdx, 0, item);
  sorted.forEach((f, i) => { f.sortOrder = i; });
}

// v0.10 — Sub-area reorder helpers (within parent only)
export function ofpNormalizeSubAreaSortOrder(areaKey) {
  const model = cmState.model;
  ofpEnsureAreaRegistry();
  const a = model.ofpAreas.find(x => x.key === areaKey);
  if (!a || !Array.isArray(a.subAreas)) return;
  const list = [...a.subAreas].sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0));
  list.forEach((sa, i) => { sa.sortOrder = i; });
}

export function ofpMoveSubAreaUp(areaKey, subKey) {
  const model = cmState.model;
  ofpNormalizeSubAreaSortOrder(areaKey);
  const a = model.ofpAreas.find(x => x.key === areaKey);
  if (!a) return;
  const sa = a.subAreas.find(x => x.key === subKey);
  if (!sa || sa.sortOrder === 0) return;
  const above = a.subAreas.find(x => x.sortOrder === sa.sortOrder - 1);
  if (above) { const t = sa.sortOrder; sa.sortOrder = above.sortOrder; above.sortOrder = t; }
}

export function ofpMoveSubAreaDown(areaKey, subKey) {
  const model = cmState.model;
  ofpNormalizeSubAreaSortOrder(areaKey);
  const a = model.ofpAreas.find(x => x.key === areaKey);
  if (!a) return;
  const max = a.subAreas.length - 1;
  const sa = a.subAreas.find(x => x.key === subKey);
  if (!sa || sa.sortOrder === max) return;
  const below = a.subAreas.find(x => x.sortOrder === sa.sortOrder + 1);
  if (below) { const t = sa.sortOrder; sa.sortOrder = below.sortOrder; below.sortOrder = t; }
}

export function ofpMoveAreaUp(key) {
  const model = cmState.model;
  ofpNormalizeAreaSortOrder();
  const a = model.ofpAreas.find(x => x.key === key);
  if (!a || a.sortOrder === 0) return;
  const above = model.ofpAreas.find(x => x.sortOrder === a.sortOrder - 1);
  if (above) { const t = a.sortOrder; a.sortOrder = above.sortOrder; above.sortOrder = t; }
}

export function ofpMoveAreaDown(key) {
  const model = cmState.model;
  ofpNormalizeAreaSortOrder();
  const max = model.ofpAreas.length - 1;
  const a = model.ofpAreas.find(x => x.key === key);
  if (!a || a.sortOrder === max) return;
  const below = model.ofpAreas.find(x => x.sortOrder === a.sortOrder + 1);
  if (below) { const t = a.sortOrder; a.sortOrder = below.sortOrder; below.sortOrder = t; }
}

export function ofpMoveFlowUp(tag) {
  const model = cmState.model;
  ofpNormalizeFlowSortOrder();
  const f = model.ofpFlows.find(x => x.tag === tag);
  if (!f || f.sortOrder === 0) return;
  const above = model.ofpFlows.find(x => x.sortOrder === f.sortOrder - 1);
  if (above) { const t = f.sortOrder; f.sortOrder = above.sortOrder; above.sortOrder = t; }
}

export function ofpMoveFlowDown(tag) {
  const model = cmState.model;
  ofpNormalizeFlowSortOrder();
  const max = model.ofpFlows.length - 1;
  const f = model.ofpFlows.find(x => x.tag === tag);
  if (!f || f.sortOrder === max) return;
  const below = model.ofpFlows.find(x => x.sortOrder === f.sortOrder + 1);
  if (below) { const t = f.sortOrder; f.sortOrder = below.sortOrder; below.sortOrder = t; }
}

/**
 * Look up a flow by tag. Returns null if not registered.
 */
export function ofpFlowMeta(tag) {
  const model = cmState.model;
  if (!tag) return null;
  ofpEnsureFlowRegistry();
  return model.ofpFlows.find(f => f.tag === tag) || null;
}

/**
 * Display label for a flow tag — falls back to the tag itself when no
 * label is set or the flow isn't registered.
 */
export function ofpFlowLabel(tag) {
  const model = cmState.model;
  const meta = ofpFlowMeta(tag);
  return (meta && meta.label) || tag || '';
}

/**
 * Resolve the color for a flow tag. Registry override wins; otherwise
 * deterministic hash into _OFP_FLOW_PALETTE so untagged or unregistered
 * flows still render a stable color.
 */
export function ofpFlowColor(tag) {
  if (!tag || !tag.trim()) return '#9CA3AF'; // neutral gray for untagged
  const meta = ofpFlowMeta(tag);
  if (meta && meta.color) return meta.color;
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash * 31) + tag.charCodeAt(i)) >>> 0;
  }
  return _OFP_FLOW_PALETTE[hash % _OFP_FLOW_PALETTE.length];
}

/**
 * Register a new tag (idempotent). Used by drag-to-connect and the
 * detail-panel "+ New flow..." sentinel so user-created tags get
 * promoted to first-class registry entries automatically.
 */
export function ofpRegisterFlow(tag, label) {
  const model = cmState.model;
  if (!tag) return;
  ofpEnsureFlowRegistry();
  if (!model.ofpFlows.some(f => f.tag === tag)) {
    model.ofpFlows.push({ tag, label: label || tag });
  }
}

// ============================================================
// Flow tag enumeration
// ============================================================

/**
 * Collect distinct path_tag values across direct + indirect labor lines
 * for autocomplete in the detail panel. Returns a sorted array; empty
 * tags are dropped.
 */
export function ofpAllFlowTags() {
  const model = cmState.model;
  // Registry is the source of truth (lazy-seeded from line tags on
  // every render). Returns sorted unique tags.
  return Array.from(new Set(ofpFlowRegistry().map(f => f.tag))).sort();
}

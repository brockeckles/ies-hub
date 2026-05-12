/**
 * IES Hub v3 — Cost Model Operational Flow sub-renderers (S23)
 *
 * Pure HTML producers extracted from cost-model/ui.js. Each function
 * takes its inputs explicitly and returns a template-literal HTML
 * string — no DOM mutation, no event binding, no model writes.
 *
 *   renderFlowGroupsForEntries — flow-tag stripes within an area
 *   renderOfpSubArea           — sub-area block within an area
 *   renderOfpArea              — full area card (main or wide)
 *   renderOfpNode              — single labor-line node card
 *
 * `renderOperationalFlow` (the entrypoint) and `_renderOfpFlowConnectors`
 * (DOM-mutating SVG painter) stay in ui.js for S24. So do the event
 * handlers and modals.
 *
 * State is read live from cmState (state.js). Each function aliases
 * `const model = cmState.model;` at entry so bodies are unchanged.
 *
 * @module tools/cost-model/operational-flow-render
 */
import { cmState } from './state.js?v=20260512-port24';
import {
  ofpAreaMeta as _ofpAreaMeta,
  ofpFlowLabel as _ofpFlowLabel,
  ofpFlowRegistry as _ofpFlowRegistry,
  ofpRegistry as _ofpRegistry,
  ofpClassifyAreaFromLine as _classifyAreaFromLine,
  ofpClassifySubAreaFromLine as _classifySubAreaFromLine,
  ofpFlowColor as _flowColor,
} from './operational-flow-registry.js?v=20260512-port24';
import {
  ofpEquipBadge as _ofpEquipBadge,
  ofpUomIn as _ofpUomIn,
  ofpUomOut as _ofpUomOut,
} from './ofp-helpers.js?v=20260511-port12';
import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260511-port12';
import * as calc from './calc.js?v=20260511-port16';
import ofpStyles from './operational-flow-styles.js?v=20260511-port4';

// v0.10 — Helper extracted from _renderOfpArea so we can reuse it for
// both top-level area bodies AND sub-area bodies (when an area has
// stackable sub-areas like Storage → Bulk / Rack / Forward Pick).
//
// Renders a list of entries grouped by flow (path_tag), with flow
// dividers between groups (skipped when only one untagged group exists).
export function renderFlowGroupsForEntries(entries, areaKey, opHrs, lc) {
  const model = cmState.model;
  if (!entries || entries.length === 0) return '';
  // Drop entries whose flow tag is hidden. Untagged entries are never hidden.
  const hiddenFlowTags = new Set((model.ofpFlows || []).filter(f => f.hidden).map(f => f.tag));
  const visibleEntries = entries.filter(e => {
    const t = (e.line.path_tag || '').trim();
    return !t || !hiddenFlowTags.has(t);
  });
  if (visibleEntries.length === 0) return '';
  // Group by path_tag. Untagged collected under '__untagged__'.
  const groups = new Map();
  for (const e of visibleEntries) {
    const tag = (e.line.path_tag || '').trim();
    const key = tag || '__untagged__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const skipDividers = groups.size === 1 && groups.has('__untagged__');
  const flowOrder = new Map(_ofpFlowRegistry().map((f, i) => [f.tag, i]));
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === '__untagged__') return 1;
    if (b === '__untagged__') return -1;
    const ai = flowOrder.has(a) ? flowOrder.get(a) : 9999;
    const bi = flowOrder.has(b) ? flowOrder.get(b) : 9999;
    return ai - bi;
  });
  const parts = [];
  for (const key of orderedKeys) {
    const group = groups.get(key);
    const isUntagged = key === '__untagged__';
    const tag = isUntagged ? '' : key;
    if (!skipDividers) {
      const labelText = isUntagged ? '(untagged)' : _ofpFlowLabel(tag);
      const handleHtml = isUntagged ? '' :
        `<span class="ofp-flow-divider__grip" aria-hidden="true">⋮⋮</span>`;
      const pencilHtml = isUntagged ? '' :
        `<button class="ofp-flow-divider__pencil" data-ofp-action="manage-flows" data-flow-tag="${escapeAttr(tag)}" title="Edit this Flow">✎</button>`;
      parts.push(`
        <div class="ofp-flow-divider"${isUntagged ? '' : ` data-flow-tag="${escapeAttr(tag)}" draggable="true" title="Drag to reorder this flow"`}>
          ${handleHtml}
          <span class="ofp-flow-divider__stripe" style="background:${_flowColor(tag)};"></span>
          <span class="ofp-flow-divider__label">${escapeHtml(labelText)}</span>
          ${pencilHtml}
          <span class="ofp-flow-divider__count">${group.length}</span>
        </div>
      `);
    }
    parts.push(group.map(e => renderOfpNode(e, areaKey, opHrs, lc)).join(''));
  }
  return parts.join('');
}

// v0.10 — Render a single sub-area block (mini-header + flow groups
// for the entries that bin into it).
export function renderOfpSubArea(areaKey, sa, entries, opHrs, lc) {
  const model = cmState.model;
  if (sa.hidden) return '';
  const totalFte = entries.reduce((s, e) => s + calc.fte(e.line, opHrs), 0);
  const bodyHtml = entries.length === 0
    ? `<div class="ofp-subarea__empty">No activities</div>`
    : renderFlowGroupsForEntries(entries, areaKey, opHrs, lc);
  return `
    <div class="ofp-subarea" data-area-key="${escapeAttr(areaKey)}" data-subarea-key="${escapeAttr(sa.key)}">
      <div class="ofp-subarea__header" style="border-left:3px solid ${sa.color};">
        <div class="ofp-subarea__title-row">
          <span class="ofp-subarea__title">${escapeHtml(sa.label)}</span>
          <button class="ofp-subarea__pencil" data-ofp-action="manage-areas" data-area-key="${escapeAttr(areaKey)}" data-subarea-key="${escapeAttr(sa.key)}" title="Edit this sub-area">✎</button>
        </div>
        <div class="ofp-subarea__meta">
          <span class="ofp-subarea__count">${entries.length}</span>
          <span class="ofp-subarea__fte">${totalFte.toFixed(1)} FTE</span>
          <button class="ofp-subarea__add" data-ofp-add-area="${escapeAttr(areaKey)}" data-ofp-add-subarea="${escapeAttr(sa.key)}" title="Add a new ${escapeAttr(sa.label)} activity">+</button>
        </div>
      </div>
      <div class="ofp-subarea__nodes">
        ${bodyHtml}
      </div>
    </div>
  `;
}

export function renderOfpArea(areaKey, entries, opHrs, lc, opts = {}) {
  const model = cmState.model;
  const meta = _ofpAreaMeta(areaKey);
  const wide = !!opts.wide;
  const warn = !!opts.warn;
  const totalFte = entries.reduce((s, e) => s + calc.fte(e.line, opHrs), 0);
  const widthClass = wide ? 'ofp-area--wide' : '';
  const warnClass = warn ? 'ofp-area--warn' : '';

  // v0.10 — Sub-areas: if the area has subAreas defined, bin entries
  // into sub-area buckets (with an "(other)" pile for entries that
  // don't classify into any sub-area). Wide areas DON'T support sub-
  // areas in v1 — wide rows are typically Returns/VAS, Support,
  // Unclassified, where horizontal stacking doesn't fit.
  const visibleSubs = (Array.isArray(meta.subAreas) ? meta.subAreas : [])
    .filter(sa => !sa.hidden)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const useSubAreas = !wide && visibleSubs.length > 0;

  let nodesHtml;
  if (entries.length === 0) {
    nodesHtml = `<div class="ofp-area__empty">No activities</div>`;
  } else if (wide) {
    // Wide row — flat layout, no flow groupings or sub-areas.
    const hiddenFlowTags = new Set((model.ofpFlows || []).filter(f => f.hidden).map(f => f.tag));
    const visibleEntries = entries.filter(e => {
      const t = (e.line.path_tag || '').trim();
      return !t || !hiddenFlowTags.has(t);
    });
    nodesHtml = visibleEntries.map(e => renderOfpNode(e, areaKey, opHrs, lc)).join('');
  } else if (useSubAreas) {
    // Bin entries into sub-area buckets.
    const subBuckets = new Map();
    for (const sa of visibleSubs) subBuckets.set(sa.key, []);
    const otherBucket = [];
    for (const e of entries) {
      const subKey = _classifySubAreaFromLine(e.line, areaKey);
      if (subKey && subBuckets.has(subKey)) {
        subBuckets.get(subKey).push(e);
      } else {
        otherBucket.push(e);
      }
    }
    const blocks = [];
    for (const sa of visibleSubs) {
      blocks.push(renderOfpSubArea(areaKey, sa, subBuckets.get(sa.key) || [], opHrs, lc));
    }
    if (otherBucket.length > 0) {
      const otherFlowHtml = renderFlowGroupsForEntries(otherBucket, areaKey, opHrs, lc);
      blocks.push(`
        <div class="ofp-subarea ofp-subarea--other" data-area-key="${escapeAttr(areaKey)}" data-subarea-key="__other__">
          <div class="ofp-subarea__header" style="border-left:3px dashed var(--ies-gray-300);">
            <div class="ofp-subarea__title-row">
              <span class="ofp-subarea__title ofp-subarea__title--other">(unassigned)</span>
            </div>
            <div class="ofp-subarea__meta">
              <span class="ofp-subarea__count">${otherBucket.length}</span>
              <span class="ofp-subarea__fte">${otherBucket.reduce((s, e) => s + calc.fte(e.line, opHrs), 0).toFixed(1)} FTE</span>
            </div>
          </div>
          <div class="ofp-subarea__nodes">${otherFlowHtml}</div>
        </div>
      `);
    }
    nodesHtml = blocks.join('');
  } else {
    // No sub-areas — render flow groups directly.
    nodesHtml = renderFlowGroupsForEntries(entries, areaKey, opHrs, lc);
    if (!nodesHtml) nodesHtml = `<div class="ofp-area__empty">No activities</div>`;
  }

  // Unclassified area doesn't get an "+ Add" button — adding into it would
  // be a no-op for a user (no canonical default activity name to seed with).
  const showAdd = areaKey !== 'unclassified' && !useSubAreas;

  return `
    <div class="ofp-area ${widthClass} ${warnClass}${useSubAreas ? ' ofp-area--has-subs' : ''}" data-ofp-area="${areaKey}">
      <div class="ofp-area__header" style="border-top:3px solid ${meta.color};">
        <div class="ofp-area__header-row">
          <div class="ofp-area__title-row" data-area-key="${escapeAttr(areaKey)}" draggable="${areaKey === 'unclassified' ? 'false' : 'true'}" title="${areaKey === 'unclassified' ? '' : 'Drag to reorder this Functional Area'}">
            <span class="ofp-area__grip" aria-hidden="true">⋮⋮</span>
            <div class="ofp-area__title">${escapeHtml(meta.label)}</div>
            <button class="ofp-area__title-pencil" data-ofp-action="manage-areas" data-area-key="${escapeAttr(areaKey)}" title="Edit this Functional Area">✎</button>
          </div>
          <div class="ofp-area__header-actions">
            <span class="ofp-area__count">${entries.length}</span>
            ${showAdd ? `<button class="ofp-add-btn" data-ofp-add-area="${areaKey}" title="Add a new ${escapeAttr(meta.label)} activity">+</button>` : ''}
          </div>
        </div>
        <div class="ofp-area__fte">${totalFte.toFixed(1)} FTE</div>
      </div>
      <div class="ofp-area__nodes ${wide ? 'ofp-area__nodes--row' : ''}${useSubAreas ? ' ofp-area__nodes--subs' : ''}">
        ${nodesHtml}
      </div>
    </div>
  `;
}

/**
 * Render a single node card. Card click → fires detail-panel open.
 * data-ofp-line="direct:5" or "indirect:2" tells the click handler which
 * array + index to look up.
 */
export function renderOfpNode(entry, areaKey, opHrs, lc) {
  const model = cmState.model;
  const l = entry.line;
  const arrayKind = entry.isDirect ? 'direct' : 'indirect';
  const fte = calc.fte(l, opHrs);
  const meta = _ofpAreaMeta(areaKey);
  const cost = entry.isDirect
    ? calc.directLineAnnualSimple(l, lc)
    : calc.indirectLineAnnualSimple(l, opHrs, lc);
  // 2026-04-30 (G6): indirect labor stores its name in role_name; direct
  // labor uses activity_name. Fall back through both so OFP cards don't
  // render as "(unnamed)" for auto-gen indirect roles.
  const name = l.activity_name || l.role_name || l.position || l.role || '(unnamed)';
  const role = l.position || l.role || (entry.isDirect ? '' : 'Indirect');
  const volume = Number(l.volume) || 0;
  const uph = Number(l.base_uph) || 0;
  const mhe = l.mhe_type && l.mhe_type !== 'none' ? l.mhe_type : '';
  const itDevice = l.it_device && l.it_device !== 'none' ? l.it_device : '';

  // v0.2 — cheap validation lints. Indirect labor exempt from the
  // "no volume / no UPH" lints (indirect roles are headcount-driven).
  // 2026-04-30 (G6): activity_name is a direct-labor field; for indirect
  // labor, the name lives in role_name. Lint each per its own field.
  const issues = [];
  const hasName = entry.isDirect
    ? (l.activity_name && l.activity_name.trim())
    : ((l.role_name && l.role_name.trim()) || (l.position && l.position.trim()));
  if (!hasName) issues.push(entry.isDirect ? 'Activity name is empty' : 'Role name is empty');
  if (!Number(l.hourly_rate) || Number(l.hourly_rate) <= 0) issues.push('Hourly rate is $0');
  if (entry.isDirect) {
    if (volume <= 0) issues.push('Volume is 0 (FTE math will collapse to 0)');
    if (uph <= 0) issues.push('UPH is 0 (no productivity defined)');
    if ((areaKey === 'outbound' || areaKey === 'storage') && !mhe) {
      const lower = (l.activity_name || '').toLowerCase();
      if (/pick|put|load|stage|pack|replen|let-?down/.test(lower)) {
        issues.push('Movement activity has no MHE assigned');
      }
    }
  }
  const issueChip = issues.length > 0
    ? `<span class="ofp-node__chip" draggable="false" title="${escapeAttr(issues.join(' • '))}">!</span>`
    : '';

  // v0.3a — UoM badge ("pallet" or "case → pallet" if transforming) and
  // flow tag pill (if set). Both render in the metrics row to keep the
  // card compact.
  const uomIn = _ofpUomIn(l);
  const uomOut = _ofpUomOut(l);
  const isTransform = uomIn && uomOut && uomIn !== uomOut;
  const uomBadge = uomIn
    ? `<span class="ofp-node__uom ${isTransform ? 'ofp-node__uom--transform' : ''}" title="${isTransform ? `Transformation: ${uomIn} → ${uomOut}` : `UoM: ${uomIn}`}">${escapeHtml(isTransform ? `${uomIn} → ${uomOut}` : uomIn)}</span>`
    : '';
  const flowTag = (l.path_tag || '').trim();
  const flowLabel = flowTag ? _ofpFlowLabel(flowTag) : '';
  // Phase 4 (volumes-as-nucleus, 2026-04-29): each flow may be tied to a
  // model.channels[] entry. When mapped, render a thin channel chip after
  // the flow pill so designers can see the OFP <-> Volumes & Profile link
  // at a glance. Tooltip extended with the channel binding for context.
  const flowEntry = flowTag ? (model.ofpFlows || []).find(f => f.tag === flowTag) : null;
  const flowChannelKey = flowEntry?.channelKey || '';
  const flowChannel = flowChannelKey
    ? (model.channels || []).find(c => c.key === flowChannelKey)
    : null;
  const channelChip = flowChannel
    ? `<span class="ofp-node__channel-chip" data-channel-key="${escapeAttr(flowChannel.key)}" title="Channel: ${escapeAttr(flowChannel.name || flowChannel.key)} (Phase 4: OFP flow tied to model.channels[]).">${escapeHtml(flowChannel.name || flowChannel.key)}</span>`
    : '';
  const flowTitle = flowTag
    ? `Flow: ${flowLabel}${flowLabel !== flowTag ? ` (${flowTag})` : ''}${flowChannel ? ` · Channel: ${flowChannel.name || flowChannel.key}` : ''}`
    : '';
  const flowPill = flowTag
    ? `<span class="ofp-node__flow-pill" data-flow-tag="${escapeAttr(flowTag)}" style="background:${_flowColor(flowTag)};" title="${escapeAttr(flowTitle)}">${escapeHtml(flowLabel)}</span>${channelChip}`
    : '';

  return `
    <div class="ofp-node ${entry.isDirect ? 'ofp-node--direct' : 'ofp-node--indirect'}" data-ofp-line="${arrayKind}:${entry.idx}" data-ofp-kind="${arrayKind}" data-ofp-idx="${entry.idx}" draggable="true" style="border-left:3px solid ${meta.color};" title="${escapeAttr(name)} — ${fte.toFixed(1)} FTE · ${calc.formatCurrency(cost, { compact: true })}/yr">
      <div class="ofp-node__top">
        <span class="ofp-node__grip" title="Drag to a different area to reassign">⋮⋮</span>
        <div class="ofp-node__name">${escapeHtml(name)}</div>
        <div class="ofp-node__top-actions">
          ${issueChip}
          <button class="ofp-node__del" draggable="false" data-ofp-del-kind="${arrayKind}" data-ofp-del-idx="${entry.idx}" data-ofp-del-name="${escapeAttr(name)}" title="Delete this activity">×</button>
        </div>
      </div>
      <div class="ofp-node__role">${escapeHtml(role || '—')}</div>
      <div class="ofp-node__metrics">
        <span class="ofp-node__fte">${fte.toFixed(1)} FTE</span>
        ${volume > 0 ? `<span class="ofp-node__vol">${volume.toLocaleString()}${uph > 0 ? `/${uph} UPH` : ''}</span>` : ''}
      </div>
      ${(uomBadge || flowPill) ? `<div class="ofp-node__pills">${flowPill}${uomBadge}</div>` : ''}
      ${mhe || itDevice ? `<div class="ofp-node__badges">${_ofpEquipBadge(mhe, 'mhe')}${_ofpEquipBadge(itDevice, 'it')}</div>` : ''}
    </div>
  `;
}


// ============================================================
// renderOperationalFlow (S24a) — top-level OFP entrypoint.
// Pure HTML. Wired to events + connectors + modals by ui.js.
// ============================================================

export function renderOperationalFlow() {
  const model = cmState.model;
  const directLines = model.laborLines || [];
  const indirectLines = model.indirectLaborLines || [];

  // Empty state — no labor lines at all
  if (directLines.length === 0 && indirectLines.length === 0) {
    return `
      <div class="cm-section-header">
        <div>
          <h2>Operational Flow <span class="hub-status-chip cm-chip-info cm-chip-xs">v0.4 · editable</span></h2>
          <div class="cm-section-desc">End-to-end view of the labor activities — Inbound through Outbound, with Returns/VAS and Support overlays. Auto-arranged from the Labor page.</div>
        </div>
      </div>
      <div class="cm-card" style="text-align:center;padding:48px 24px;">
        <div style="font-size:48px;line-height:1;margin-bottom:12px;opacity:0.4;">⇄</div>
        <div style="font-size:14px;font-weight:600;color:var(--ies-navy);margin-bottom:6px;">No labor lines yet</div>
        <div style="font-size:12px;color:var(--ies-gray-500);margin-bottom:16px;">Build labor lines on the Labor page and they'll auto-arrange into a process flow here.</div>
        <button class="hub-btn hub-btn-sm" data-action="ofp-go-to-labor">Go to Labor →</button>
      </div>
      ${ofpStyles()}
    `;
  }

  // Bin lines into areas using the per-cost-model registry. Areas
  // map keyspace is dynamic — every registered area gets a bucket,
  // even empty ones (so 'Areas Populated' KPI denominator is right).
  const registry = _ofpRegistry();
  const areasMap = {};
  for (const area of registry) areasMap[area.key] = [];
  directLines.forEach((l, idx) => {
    const ak = _classifyAreaFromLine(l);
    if (!areasMap[ak]) areasMap[ak] = [];
    areasMap[ak].push({ line: l, idx, isDirect: true });
  });
  // Indirect labor → 'support' if it exists, else 'unclassified'. The
  // user can delete the support area, so we can't blindly assume it.
  const indirectTargetKey = registry.some(a => a.key === 'support') ? 'support' : 'unclassified';
  indirectLines.forEach((l, idx) => {
    if (!areasMap[indirectTargetKey]) areasMap[indirectTargetKey] = [];
    areasMap[indirectTargetKey].push({ line: l, idx, isDirect: false });
  });

  // KPIs
  const opHrs = calc.operatingHours(model.shifts || {});
  const lc = model.laborCosting || {};
  const totalDirectFte = directLines.reduce((s, l) => s + calc.fte(l, opHrs), 0);
  const totalIndirectFte = indirectLines.reduce((s, l) => s + calc.fte(l, opHrs), 0);
  const totalFte = totalDirectFte + totalIndirectFte;
  const totalCost = directLines.reduce((s, l) => s + calc.directLineAnnualSimple(l, lc), 0)
                  + indirectLines.reduce((s, l) => s + calc.indirectLineAnnualSimple(l, opHrs, lc), 0);

  // v0.9 — Zoom level (persistent per cost model). Snap to nearest
  // discrete step so legacy odd values from manual edits normalize on
  // next render.
  const _OFP_ZOOM_STEPS = [0.75, 0.9, 1.0, 1.15, 1.3];
  const _ofpSnapZoom = (z) => {
    const n = Number(z);
    if (!isFinite(n) || n <= 0) return 1.0;
    return _OFP_ZOOM_STEPS.reduce((best, s) => Math.abs(s - n) < Math.abs(best - n) ? s : best, _OFP_ZOOM_STEPS[2]);
  };
  const zoomLevel = _ofpSnapZoom(model.ofpZoom);
  // Areas Populated denominator is the count of NON-unclassified areas
  // when unclassified itself is empty (the bucket is hidden in that
  // case so the headline ratio shouldn't include it).
  const unclassifiedCount = (areasMap['unclassified'] || []).length;
  const totalAreasPossible = unclassifiedCount > 0 ? registry.length : registry.length - 1;
  const populatedAreas = Object.values(areasMap).filter(arr => arr.length > 0).length;

  // Inter-area connector — direction only, no FTE label.
  // v0.5/v0.8 tried MAX-FTE then SUM-FTE; both are mathematically
  // ill-defined once areas are user-reorderable (same data renders
  // different numbers when columns swap). Brock's call: just show
  // direction. Each area's total FTE is already in its header above.
  const arrowSvg = (upstreamEntries, upstreamLabel, downstreamLabel) => {
    const tip = `${upstreamLabel} → ${downstreamLabel}`;
    return `
      <div class="ofp-connector" title="${escapeAttr(tip)}">
        <svg viewBox="0 0 60 32" width="60" height="32" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="ofp-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--ies-gray-400)"></path>
            </marker>
          </defs>
          <line x1="0" y1="20" x2="56" y2="20" stroke="var(--ies-gray-400)" stroke-width="2" marker-end="url(#ofp-arrowhead)"></line>
        </svg>
      </div>
    `;
  };

  // v0.6 — Hidden filter. Visible areas + flows only render on the
  // canvas. Hidden items show as restore-chips above the KPI strip.
  const hiddenAreas = registry.filter(a => a.hidden);
  const hiddenFlows = (model.ofpFlows || []).filter(f => f.hidden);
  const hiddenAreaKeys = new Set(hiddenAreas.map(a => a.key));

  // Build the main row dynamically — interleave area cards with
  // arrow connectors. arrowSvg takes the upstream area's entries to
  // pick the throughput proxy, so we pass that explicitly.
  const mainAreas = registry.filter(a => a.displayMode === 'main' && !hiddenAreaKeys.has(a.key));
  const wideAreas = registry.filter(a => a.displayMode !== 'main' && !hiddenAreaKeys.has(a.key));
  const mainRowParts = [];
  mainAreas.forEach((area, i) => {
    if (i > 0) {
      const prev = mainAreas[i - 1];
      mainRowParts.push(arrowSvg(areasMap[prev.key] || [], prev.label, area.label));
    }
    mainRowParts.push(renderOfpArea(area.key, areasMap[area.key] || [], opHrs, lc));
  });
  // Wide rows — only render if non-empty. Unclassified gets warn=true.
  const wideRowsHtml = wideAreas
    .filter(a => (areasMap[a.key] || []).length > 0)
    .map(a => `
      <div class="ofp-row ofp-row--secondary" style="margin-top:14px;">
        ${renderOfpArea(a.key, areasMap[a.key], opHrs, lc, { wide: true, warn: a.key === 'unclassified' })}
      </div>
    `).join('');

  // Hidden strip — only renders when at least one item is hidden.
  // Chips show area label / flow label; click restores. Plus a
  // 'Show all' button to clear every hidden flag in one go.
  const hiddenStripHtml = (hiddenAreas.length + hiddenFlows.length) === 0 ? '' : `
    <div class="ofp-hidden-strip">
      <span class="ofp-hidden-strip__label">Hidden:</span>
      ${hiddenAreas.map(a => `
        <button class="ofp-hidden-chip" data-restore-area="${escapeAttr(a.key)}" title="Show ${escapeAttr(a.label)} on canvas">
          <span class="ofp-hidden-chip__dot" style="background:${a.color};"></span>
          <span class="ofp-hidden-chip__name">${escapeHtml(a.label)}</span>
          <span class="ofp-hidden-chip__type">area</span>
          <span class="ofp-hidden-chip__icon">👁</span>
        </button>
      `).join('')}
      ${hiddenFlows.map(f => `
        <button class="ofp-hidden-chip ofp-hidden-chip--flow" data-restore-flow="${escapeAttr(f.tag)}" title="Show flow '${escapeAttr(f.label)}' on canvas">
          <span class="ofp-hidden-chip__dot" style="background:${_flowColor(f.tag)};"></span>
          <span class="ofp-hidden-chip__name">${escapeHtml(f.label)}</span>
          <span class="ofp-hidden-chip__type">flow</span>
          <span class="ofp-hidden-chip__icon">👁</span>
        </button>
      `).join('')}
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-ofp-action="show-all-hidden" style="margin-left:auto;" title="Restore all hidden areas and flows">Show all</button>
    </div>
  `;

  return `
    <div class="cm-section-header" style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
      <div>
        <h2>Operational Flow <span class="hub-status-chip cm-chip-info cm-chip-xs">v0.4 · editable</span></h2>
        <div class="cm-section-desc">End-to-end view of the labor activities. Auto-arranged from the Labor page by activity-keyword classification, then editable per cost model. Click any node to inspect; "Edit on Labor page" round-trips the change.</div>
      </div>
      <div class="ofp-section-actions">
        <div class="ofp-zoom-controls" title="Zoom canvas">
          <button class="ofp-zoom-btn" data-ofp-action="zoom-out" title="Zoom out (75% min)">−</button>
          <button class="ofp-zoom-pct" data-ofp-action="zoom-reset" title="Click to reset to 100%">${Math.round(zoomLevel * 100)}%</button>
          <button class="ofp-zoom-btn" data-ofp-action="zoom-in" title="Zoom in (130% max)">+</button>
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-ofp-action="manage-areas" title="Edit Functional Areas — rename, recolor, edit keywords, add custom areas">⚙ Manage Areas</button>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-ofp-action="manage-flows" title="Edit Flows — rename, recolor, add new flows">⚙ Manage Flows</button>
      </div>
    </div>

    ${hiddenStripHtml}

    <!-- v0.9 — Replaced 4-tile KPI strip with a thin warning banner that
         only renders when unclassifiedCount > 0. Total FTE / Cost / Areas
         Populated were duplicating data from the CM top toolbar; killing
         them reclaims ~80px of canvas real estate. -->
    ${unclassifiedCount > 0 ? `
      <div class="ofp-warn-banner" title="Activities did not match any area keyword. Rename the activity on Labor, or extend the keyword catalog in Manage Areas.">
        <span class="ofp-warn-banner__icon">⚠</span>
        <span class="ofp-warn-banner__msg"><strong>${unclassifiedCount}</strong> activit${unclassifiedCount === 1 ? 'y is' : 'ies are'} unclassified — open <button class="ofp-warn-banner__action" data-ofp-action="manage-areas">Manage Areas</button> to add classification keywords, or rename activities on the Labor page.</span>
      </div>
    ` : ''}

    <!-- v0.2.2 — Canvas reverts to full-width. Detail panel is now a
         modal overlay (see #ofp-detail-modal below), so the areas no
         longer have to share horizontal space with a side rail.
         v0.3a.4 — position:relative + the absolute-positioned SVG
         overlay below host the dotted same-flow connectors that get
         drawn after each render by _renderOfpFlowConnectors().
         v0.4 — main row + wide rows are now built dynamically from
         the per-cost-model area registry instead of hardcoded layout. -->
    <div class="cm-card ofp-canvas-card" style="padding:18px 18px 22px;position:relative;zoom:${zoomLevel};">
      <svg class="ofp-flow-overlay" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
      <div class="ofp-row ofp-row--main">
        ${mainRowParts.join('')}
      </div>
      ${wideRowsHtml}
    </div>

    <!-- Detail-panel modal (node click → editable drawer) -->
    <div id="ofp-detail-modal" class="ofp-detail-modal" style="display:none;">
      <div class="ofp-detail-modal__dialog" id="ofp-detail-panel"></div>
    </div>

    <!-- v0.4 — Manage Functional Areas modal. Populated on demand by
         _ofpOpenManageAreasModal(). Centered dialog, click-outside +
         Esc to close. -->
    <div id="ofp-areas-modal" class="ofp-detail-modal ofp-detail-modal--centered" style="display:none;">
      <div class="ofp-areas-modal__dialog" id="ofp-areas-panel"></div>
    </div>

    <!-- v0.4 — Manage Flows modal. Same UX pattern as Manage Areas. -->
    <div id="ofp-flows-modal" class="ofp-detail-modal ofp-detail-modal--centered" style="display:none;">
      <div class="ofp-areas-modal__dialog" id="ofp-flows-panel"></div>
    </div>

    ${ofpStyles()}
  `;
}

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
import { cmState } from './state.js?v=20260511-port23';
import {
  ofpAreaMeta as _ofpAreaMeta,
  ofpFlowLabel as _ofpFlowLabel,
  ofpFlowRegistry as _ofpFlowRegistry,
  ofpClassifySubAreaFromLine as _classifySubAreaFromLine,
  ofpFlowColor as _flowColor,
} from './operational-flow-registry.js?v=20260511-port23';
import {
  ofpEquipBadge as _ofpEquipBadge,
  ofpUomIn as _ofpUomIn,
  ofpUomOut as _ofpUomOut,
} from './ofp-helpers.js?v=20260511-port12';
import { escapeHtml, escapeAttr } from '../../shared/escape.js?v=20260511-port12';
import * as calc from './calc.js?v=20260511-port16';

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

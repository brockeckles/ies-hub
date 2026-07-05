/**
 * IES Hub v3 — Cost Model Operational Flow CSS
 *
 * The Operational Flow tab's full <style> block, extracted from
 * `cost-model/ui.js` 2026-05-11 as a port-readiness compactor. Pure —
 * returns an HTML <style>...</style> string. Imported and called by
 * `renderOperationalFlow()` to inline its CSS.
 *
 * No DOM, no state, no calc dependencies. Safe to extract.
 *
 * @module tools/cost-model/operational-flow-styles
 */

export function ofpStyles() {
  return `
    <style>
      .ofp-row { display: flex; align-items: stretch; gap: 0; }
      .ofp-row--main > .ofp-area { flex: 1 1 0; min-width: 0; }
      .ofp-row--secondary > .ofp-area { flex: 1 1 100%; }
      .ofp-connector { display: flex; flex-direction: column; align-items: center; padding-top: 56px; flex: 0 0 auto; width: 60px; }
      .ofp-connector__label { font-size: 9px; color: var(--ies-gray-500); font-weight: 600; margin-top: -2px; white-space: nowrap; }

      .ofp-area {
        display: flex; flex-direction: column;
        background: var(--ies-gray-50);
        border: 1px solid var(--ies-gray-200);
        border-radius: 6px;
        overflow: hidden;
      }
      .ofp-area--wide { width: 100%; }
      .ofp-area--warn { border-color: var(--c-danger); background: rgba(220, 38, 38, 0.04); }

      .ofp-area__header {
        padding: 8px 10px 10px;
        background: #fff;
        border-bottom: 1px solid var(--ies-gray-200);
      }
      .ofp-area__header-row {
        display: flex; justify-content: space-between; align-items: baseline;
      }
      .ofp-area__title {
        font-size: 12px; font-weight: 700; color: var(--ies-navy);
        text-transform: uppercase; letter-spacing: 0.04em;
      }
      .ofp-area__count {
        font-size: 11px; color: var(--ies-gray-500); font-weight: 600;
        background: var(--ies-gray-100); border-radius: 10px; padding: 1px 8px;
      }
      .ofp-area__fte {
        font-size: 11px; color: var(--ies-gray-500); margin-top: 3px;
      }
      .ofp-area__nodes {
        display: flex; flex-direction: column; gap: 6px;
        padding: 10px;
      }
      .ofp-area__nodes--row {
        flex-direction: row; flex-wrap: wrap;
      }
      .ofp-area__nodes--row > .ofp-node { flex: 0 0 calc((100% - 18px) / 4); }
      .ofp-area__empty {
        padding: 18px 8px; text-align: center; font-size: 11px; color: var(--ies-gray-400); font-style: italic;
      }

      .ofp-node {
        display: block; width: 100%; text-align: left;
        background: #fff; border: 1px solid var(--ies-gray-200); border-left-width: 3px;
        border-radius: 4px; padding: 8px 10px; cursor: pointer;
        transition: all 0.12s; font-family: inherit;
      }
      .ofp-node:hover { border-color: var(--ies-blue); box-shadow: 0 1px 4px rgba(0,71,171,0.10); transform: translateY(-1px); }
      .ofp-node--selected { border-color: var(--ies-blue); background: rgba(0,71,171,0.04); box-shadow: 0 0 0 2px rgba(0,71,171,0.15); }
      .ofp-node__name { font-size: 12px; font-weight: 700; color: var(--ies-navy); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ofp-node__role { font-size: 11px; color: var(--ies-gray-500); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ofp-node__metrics { display: flex; gap: 8px; margin-top: 4px; align-items: baseline; }
      .ofp-node__fte { font-size: 12px; font-weight: 700; color: var(--ies-blue); }
      .ofp-node__vol { font-size: 10px; color: var(--ies-gray-500); }
      .ofp-node__tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 3px; }
      .ofp-tag { font-size: 9px; font-weight: 600; color: var(--ies-gray-600); background: var(--ies-gray-100); border-radius: 3px; padding: 1px 5px; text-transform: uppercase; letter-spacing: 0.02em; }

      /* v0.14 — MHE / IT pill badges on node cards. Icon + inline
         label (full readable name), custom CSS tooltip on hover for
         additional context. Replaces the v0.3a icon-only chips. */
      .ofp-node__badges { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
      .ofp-badge {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 9px 3px 6px;
        border-radius: 12px;
        font-size: 10px; font-weight: 600;
        line-height: 1.2;
        cursor: help;
        transition: background 0.12s, box-shadow 0.12s;
        position: relative;
        white-space: nowrap;
        max-width: 100%;
      }
      .ofp-badge__icon {
        flex: 0 0 auto;
        display: block;
      }
      .ofp-badge__label {
        overflow: hidden; text-overflow: ellipsis;
      }
      .ofp-badge__mono {
        flex: 0 0 auto;
        font-size: 9px; font-weight: 800;
        letter-spacing: 0.02em;
        background: rgba(0, 0, 0, 0.08);
        border-radius: 3px;
        padding: 1px 4px;
      }
      .ofp-badge--mhe {
        background: rgba(124, 58, 237, 0.10);
        color: #6D28D9;
      }
      .ofp-badge--mhe:hover {
        background: rgba(124, 58, 237, 0.18);
        box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.30);
      }
      .ofp-badge--it {
        background: rgba(13, 148, 136, 0.10);
        color: #0F766E;
      }
      .ofp-badge--it:hover {
        background: rgba(13, 148, 136, 0.18);
        box-shadow: 0 0 0 1px rgba(13, 148, 136, 0.35);
      }

      /* v0.14 — Custom CSS tooltip: appears immediately on hover, not
         after the browser's ~700ms delay for native title attributes. */
      .ofp-badge[data-tip]:hover::after {
        content: attr(data-tip);
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%);
        background: var(--c-ink);
        color: #fff;
        font-size: 11px; font-weight: 500;
        padding: 6px 10px;
        border-radius: 5px;
        white-space: nowrap;
        z-index: 100;
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.30);
        pointer-events: none;
        animation: ofpTipIn 0.12s ease-out forwards;
      }
      .ofp-badge[data-tip]:hover::before {
        content: '';
        position: absolute;
        bottom: calc(100% + 3px);
        left: 50%;
        transform: translateX(-50%);
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-top: 5px solid var(--c-ink);
        z-index: 100;
        pointer-events: none;
        animation: ofpTipIn 0.12s ease-out forwards;
      }
      @keyframes ofpTipIn {
        from { opacity: 0; transform: translateX(-50%) translateY(4px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
      }

      /* v0.2.3 — Right-side drawer. Slides in from the right edge,
         full viewport height. Backdrop is semi-transparent so the
         canvas + the clicked node remain visible to the left. */
      .ofp-detail-modal {
        position: fixed; inset: 0;
        background: rgba(15, 23, 42, 0.32);
        display: flex; align-items: stretch; justify-content: flex-end;
        z-index: 1000;
        animation: ofpFadeIn 0.12s ease-out;
      }
      @keyframes ofpFadeIn { from { opacity: 0; } to { opacity: 1; } }
      .ofp-detail-modal__dialog {
        background: #fff;
        border-left: 1px solid var(--ies-gray-200);
        box-shadow: -8px 0 32px rgba(0,0,0,0.20);
        width: min(480px, 100%);
        height: 100vh;
        max-height: 100vh;
        overflow-y: auto;
        animation: ofpDrawerIn 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      @keyframes ofpDrawerIn {
        from { transform: translateX(100%); }
        to   { transform: translateX(0); }
      }
      /* In the drawer the field grid drops to 2 columns so labels +
         values stay readable at 480px width. */
      .ofp-detail-modal .ofp-detail-panel__grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px 16px;
        padding: 16px;
      }
      .ofp-detail-panel { display: block; }
      .ofp-detail-panel__header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 16px; border-bottom: 1px solid var(--ies-gray-200);
      }
      .ofp-detail-panel__area {
        font-size: 10px; font-weight: 700; color: var(--ies-gray-500);
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .ofp-detail-panel__name {
        font-size: 16px; font-weight: 700; color: var(--ies-navy); margin-top: 2px;
      }
      .ofp-detail-panel__grid {
        display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px 24px; padding: 16px;
      }
      .ofp-detail-panel__field-label { font-size: 10px; color: var(--ies-gray-500); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
      .ofp-detail-panel__field-value { font-size: 13px; color: var(--ies-navy); font-weight: 600; margin-top: 2px; }
      .ofp-detail-panel__footer {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 16px; border-top: 1px solid var(--ies-gray-200);
        background: var(--ies-gray-50);
      }

      /* v0.2 — area header actions row (count + add button) */
      .ofp-area__header-actions { display: flex; align-items: center; gap: 6px; }
      .ofp-add-btn {
        background: var(--ies-blue); color: #fff; border: none; border-radius: 4px;
        width: 22px; height: 22px; line-height: 1; font-size: 16px; font-weight: 700;
        cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center;
        transition: background 0.12s;
      }
      .ofp-add-btn:hover { background: var(--ies-navy, #1c1c1c); }

      /* v0.2 — node card top row (name + del/chip), delete button, validation chip */
      .ofp-node { position: relative; }
      .ofp-node__top { display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; }
      .ofp-node__top .ofp-node__name { flex: 1 1 auto; min-width: 0; }
      .ofp-node__top-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
      .ofp-node__grip {
        flex: 0 0 auto;
        font-size: 11px; line-height: 1; color: var(--ies-gray-300);
        cursor: grab; user-select: none;
        padding: 1px 2px; margin-right: 2px;
        letter-spacing: -1px;
        transition: color 0.12s;
      }
      .ofp-node:hover .ofp-node__grip { color: var(--ies-gray-500); }
      .ofp-node--dragging .ofp-node__grip { color: var(--ies-blue); }
      .ofp-node__del {
        background: transparent; border: none; color: var(--ies-gray-400);
        cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;
        opacity: 0; transition: opacity 0.12s, color 0.12s;
      }
      .ofp-node:hover .ofp-node__del { opacity: 1; }
      .ofp-node__del:hover { color: var(--c-danger); }
      .ofp-node__chip {
        display: inline-flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; border-radius: 50%;
        background: var(--c-warn); color: #fff;
        font-size: 11px; font-weight: 700; cursor: help;
      }

      /* v0.3a.4 — Dotted same-path connectors overlay. Sits behind
         cards in the stacking order so the lines read as connections
         between them, not as decorations on top. pointer-events:none
         so clicks/drags pass through to areas + cards beneath. */
      .ofp-flow-overlay {
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 1;
        overflow: visible;
      }
      .ofp-canvas-card .ofp-row { position: relative; z-index: 2; }
      .ofp-canvas-card .ofp-area { position: relative; z-index: 2; }

      /* v0.3a — path divider rows inside vertical areas */
      .ofp-flow-divider {
        display: flex; align-items: center; gap: 6px;
        font-size: 9px; font-weight: 700;
        color: var(--ies-gray-500);
        text-transform: uppercase; letter-spacing: 0.05em;
        padding: 6px 4px 3px;
        border-top: 1px solid var(--ies-gray-100);
        margin-top: 4px;
      }
      .ofp-flow-divider:first-child { border-top: 0; margin-top: 0; padding-top: 2px; }
      .ofp-flow-divider__stripe { width: 14px; height: 3px; border-radius: 2px; flex: 0 0 auto; }
      .ofp-flow-divider__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ofp-flow-divider__count { color: var(--ies-gray-400); font-weight: 600; }

      /* v0.3a — UoM badge + path-tag pill on the node card */
      .ofp-node__pills { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; align-items: center; }
      .ofp-node__flow-pill {
        font-size: 9px; font-weight: 700; color: #fff;
        padding: 1px 6px; border-radius: 8px;
        text-transform: uppercase; letter-spacing: 0.04em;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      /* Phase 4 — channel chip rendered alongside flow-pill when mapped */
      .ofp-node__channel-chip--clickable {
        background: transparent; border: 1px solid var(--ies-gray-300, #d1d5db);
        padding: 1px 6px;
      }
      .ofp-node__channel-chip--clickable:hover {
        background: var(--ies-gray-100, #f3f4f6);
        border-color: var(--ies-blue, #0047AB);
      }
      .ofp-node__channel-chip {
        font-size: 9px; font-weight: 600; color: var(--ies-gray-700);
        background: var(--ies-gray-50);
        border: 1px solid var(--ies-gray-200);
        padding: 1px 6px; border-radius: 8px;
        text-transform: none; letter-spacing: 0;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ofp-node__uom {
        font-size: 9px; font-weight: 700;
        color: var(--ies-gray-700); background: var(--ies-gray-100);
        padding: 1px 5px; border-radius: 3px;
        text-transform: uppercase; letter-spacing: 0.04em;
      }
      .ofp-node__uom--transform {
        color: #fff; background: var(--c-purple);
        text-transform: none; letter-spacing: 0;
      }

      /* v0.2 — drag-and-drop visual states */
      .ofp-node[draggable="true"] { cursor: grab; }
      .ofp-node[draggable="true"]:active { cursor: grabbing; }
      .ofp-node--dragging { opacity: 0.35; transform: scale(0.96); box-shadow: 0 4px 12px rgba(0,71,171,0.25); }
      /* v0.3a.1 — drop a card onto another card → connect both on same path */
      .ofp-node--droptarget {
        outline: 3px dashed var(--ies-blue);
        outline-offset: 2px;
        background: rgba(0, 71, 171, 0.22);
        box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.15);
        z-index: 5;
      }
      .ofp-node--droptarget::after {
        content: 'Same flow';
        position: absolute;
        top: -12px; right: 6px;
        background: var(--ies-blue); color: #fff;
        font-size: 10px; font-weight: 700;
        padding: 3px 8px; border-radius: 3px;
        text-transform: uppercase; letter-spacing: 0.05em;
        pointer-events: none;
        box-shadow: 0 4px 10px rgba(0,71,171,0.55);
      }
      .ofp-area--dragover {
        outline: 4px dashed var(--ies-blue);
        outline-offset: -4px;
        background: rgba(0, 71, 171, 0.22);
        box-shadow: 0 0 0 4px rgba(0, 71, 171, 0.15) inset;
        position: relative;
      }
      .ofp-area--dragover::after {
        content: 'Drop to reassign';
        position: absolute;
        top: 8px; right: 10px;
        background: var(--ies-blue); color: #fff;
        font-size: 11px; font-weight: 700;
        padding: 4px 10px; border-radius: 4px;
        text-transform: uppercase; letter-spacing: 0.05em;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,71,171,0.55);
      }

      /* v0.2 — editable detail panel inputs */
      .ofp-detail-panel__field { display: flex; flex-direction: column; gap: 4px; }
      .ofp-edit-input {
        font-size: 12px; padding: 5px 8px; border: 1px solid var(--ies-gray-200);
        border-radius: 4px; width: 100%;
      }
      .ofp-edit-input:focus { outline: none; border-color: var(--ies-blue); box-shadow: 0 0 0 2px rgba(0,71,171,0.15); }

      /* ========================================================
         v0.4 — Functional Area editing
         ======================================================== */

      /* Section actions row (top-right of OFP canvas) */
      .ofp-section-actions { display: flex; gap: 8px; flex-shrink: 0; }

      /* Inline pencil on each area title — hover-reveal */
      .ofp-area__title-row {
        display: inline-flex; align-items: center; gap: 4px;
        flex: 1 1 auto; min-width: 0;
      }
      .ofp-area__title-pencil {
        background: transparent; border: none; padding: 0;
        font-size: 11px; line-height: 1; cursor: pointer;
        color: var(--ies-gray-300);
        opacity: 0; transition: opacity 0.12s, color 0.12s;
      }
      .ofp-area:hover .ofp-area__title-pencil { opacity: 1; }
      .ofp-area__title-pencil:hover { color: var(--ies-blue); }

      /* Manage Areas centered modal — reuses .ofp-detail-modal backdrop
         but the dialog is centered (not slide-from-right like the detail
         drawer). The .ofp-detail-modal--centered modifier overrides
         alignment. */
      .ofp-detail-modal--centered { align-items: center; justify-content: center; }
      .ofp-areas-modal__dialog {
        background: #fff; border-radius: 8px;
        width: min(960px, 96vw); max-height: 86vh;
        display: flex; flex-direction: column;
        box-shadow: 0 24px 64px rgba(0,0,0,0.30);
        animation: ofpAreasModalIn 0.18s cubic-bezier(0.2,0.8,0.2,1);
      }
      @keyframes ofpAreasModalIn {
        from { transform: translateY(20px) scale(0.97); opacity: 0; }
        to   { transform: none; opacity: 1; }
      }
      .ofp-areas-mgr { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      .ofp-areas-mgr__header {
        display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--ies-gray-200);
        flex-shrink: 0;
      }
      .ofp-areas-mgr__title { font-size: 15px; font-weight: 700; color: var(--ies-navy); }
      .ofp-areas-mgr__sub {
        font-size: 11px; color: var(--ies-gray-500); margin-top: 2px;
        max-width: 640px; line-height: 1.45;
      }
      .ofp-areas-mgr__table-wrap {
        padding: 10px 18px; overflow-y: auto; flex: 1 1 auto; min-height: 0;
      }
      .ofp-area-mgr__table { width: 100%; border-collapse: collapse; }
      .ofp-area-mgr__table th {
        text-align: left; font-size: 9px; font-weight: 700; color: var(--ies-gray-500);
        text-transform: uppercase; letter-spacing: 0.04em;
        padding: 6px 8px; border-bottom: 1px solid var(--ies-gray-200);
        background: #fff; position: sticky; top: 0; z-index: 1;
      }
      .ofp-area-mgr__table td {
        padding: 8px; border-bottom: 1px solid var(--ies-gray-100);
        vertical-align: middle;
      }
      .ofp-area-mgr__row:hover { background: var(--ies-gray-50); }
      .ofp-area-mgr__color-input {
        width: 30px; height: 30px; padding: 0;
        border: 1px solid var(--ies-gray-200); border-radius: 4px;
        cursor: pointer; background: transparent;
      }
      .ofp-area-mgr__input {
        font-size: 12px; padding: 5px 8px;
        border: 1px solid var(--ies-gray-200); border-radius: 4px;
        width: 100%;
      }
      .ofp-area-mgr__chips {
        display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
        border: 1px solid var(--ies-gray-200); border-radius: 4px;
        padding: 4px 6px; background: #fff; min-height: 32px;
      }
      .ofp-area-mgr__chip {
        display: inline-flex; align-items: center; gap: 2px;
        font-size: 10px; font-weight: 600; color: var(--ies-navy);
        background: var(--ies-gray-100); border-radius: 3px;
        padding: 2px 4px 2px 7px;
        line-height: 1.4;
      }
      .ofp-area-mgr__chip-x {
        background: transparent; border: none; padding: 0 3px;
        font-size: 12px; line-height: 1; cursor: pointer;
        color: var(--ies-gray-500);
      }
      .ofp-area-mgr__chip-x:hover { color: var(--c-danger); }
      .ofp-area-mgr__chip-input {
        flex: 1 1 80px; min-width: 80px;
        border: none; outline: none; background: transparent;
        font-size: 11px; padding: 2px 4px;
      }
      .ofp-area-mgr__count-cell { text-align: center; font-weight: 700; color: var(--ies-gray-700); font-size: 13px; }
      .ofp-area-mgr__del {
        background: transparent; border: 1px solid var(--ies-gray-200);
        border-radius: 4px; width: 28px; height: 28px; padding: 0;
        cursor: pointer; font-size: 14px; color: var(--ies-gray-500); line-height: 1;
        transition: all 0.12s;
      }
      .ofp-area-mgr__del:hover:not(:disabled) {
        color: var(--c-danger); border-color: var(--c-danger); background: rgba(220,38,38,0.05);
      }
      .ofp-area-mgr__del:disabled { cursor: not-allowed; opacity: 0.4; }
      .ofp-area-mgr__badge {
        display: inline-block;
        font-size: 8px; font-weight: 700; letter-spacing: 0.05em;
        padding: 1px 5px; border-radius: 2px;
        margin-left: 6px; vertical-align: middle;
      }
      .ofp-area-mgr__badge--protected {
        background: rgba(220,38,38,0.10); color: var(--c-danger-strong);
      }
      .ofp-area-mgr__muted {
        font-size: 11px; color: var(--ies-gray-400); font-style: italic;
      }
      .ofp-areas-mgr__footer {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 18px; border-top: 1px solid var(--ies-gray-200);
        flex-shrink: 0;
        background: var(--ies-gray-50);
      }

      /* === v0.4 — Flow inline pencil (hover-reveal on flow dividers) === */
      .ofp-flow-divider { position: relative; }
      .ofp-flow-divider__pencil {
        background: transparent; border: none; padding: 0 4px;
        font-size: 10px; line-height: 1; cursor: pointer;
        color: var(--ies-gray-300);
        opacity: 0; transition: opacity 0.12s, color 0.12s;
        flex: 0 0 auto;
      }
      .ofp-flow-divider:hover .ofp-flow-divider__pencil { opacity: 1; }
      .ofp-flow-divider__pencil:hover { color: var(--ies-blue); }

      /* === v0.4 — Manage Flows modal — tag cell + auto chip + reset btn === */
      .ofp-flow-mgr__tag-cell {
        display: flex; align-items: center; gap: 6px;
      }
      .ofp-flow-mgr__tag {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        background: var(--ies-gray-100); color: var(--ies-gray-700);
        padding: 2px 6px; border-radius: 3px;
        max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ofp-flow-mgr__auto-chip {
        font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
        color: var(--ies-gray-500); background: var(--ies-gray-100);
        padding: 1px 5px; border-radius: 2px;
        text-transform: uppercase;
      }
      .ofp-flow-mgr__reset-color {
        background: transparent; border: 1px solid var(--ies-gray-200);
        border-radius: 3px; cursor: pointer;
        font-size: 11px; line-height: 1; padding: 2px 6px;
        color: var(--ies-gray-500);
        transition: all 0.12s;
      }
      .ofp-flow-mgr__reset-color:hover { color: var(--ies-blue); border-color: var(--ies-blue); }

      /* ========================================================
         v0.5 — Reorder handles + drop indicators
         ======================================================== */

      /* Canvas: area drag-handle. v0.7 — title-row IS the drag source;
         grip is just a visible cue. Always visible (was hover-reveal)
         and the whole title-row gets cursor:grab so the affordance is
         obvious — drag the title 'Inbound' itself to reorder. */
      .ofp-area__title-row {
        cursor: grab; user-select: none;
      }
      .ofp-area__title-row[draggable="false"] {
        cursor: default;
      }
      .ofp-area__title-row:active { cursor: grabbing; }
      .ofp-area__grip {
        flex: 0 0 auto;
        font-size: 13px; line-height: 1; letter-spacing: -1px;
        color: var(--ies-gray-400);
        user-select: none;
        padding: 1px 2px;
        opacity: 0.6; transition: opacity 0.12s, color 0.12s;
      }
      .ofp-area__title-row:hover .ofp-area__grip { opacity: 1; color: var(--ies-blue); }
      .ofp-area--reorder-dragging { opacity: 0.40; }
      .ofp-area--reorder-target-before {
        box-shadow: inset 7px 0 0 0 var(--ies-blue), 0 0 0 2px rgba(0, 71, 171, 0.30);
        background: rgba(0, 71, 171, 0.18);
      }
      .ofp-area--reorder-target-after {
        box-shadow: inset -7px 0 0 0 var(--ies-blue), 0 0 0 2px rgba(0, 71, 171, 0.30);
        background: rgba(0, 71, 171, 0.18);
      }

      /* Canvas: flow divider drag. v0.7 — whole divider band is the
         drag source; grip is a visible cue. */
      .ofp-flow-divider[draggable="true"] {
        cursor: grab; user-select: none;
      }
      .ofp-flow-divider[draggable="true"]:active { cursor: grabbing; }
      .ofp-flow-divider__grip {
        flex: 0 0 auto;
        font-size: 11px; line-height: 1; letter-spacing: -1px;
        color: var(--ies-gray-400);
        user-select: none;
        padding: 1px 2px; margin-right: 2px;
        opacity: 0.6; transition: opacity 0.12s, color 0.12s;
      }
      .ofp-flow-divider:hover .ofp-flow-divider__grip { opacity: 1; color: var(--ies-blue); }
      .ofp-flow-divider--reorder-dragging { opacity: 0.40; }
      .ofp-flow-divider--reorder-above {
        box-shadow: inset 0 4px 0 0 var(--ies-blue), 0 -1px 0 1px rgba(0, 71, 171, 0.20);
        background: rgba(0, 71, 171, 0.18);
      }
      .ofp-flow-divider--reorder-below {
        box-shadow: inset 0 -4px 0 0 var(--ies-blue), 0 1px 0 1px rgba(0, 71, 171, 0.20);
        background: rgba(0, 71, 171, 0.18);
      }

      /* Modal: drag-handle column + grip + up/down buttons */
      .ofp-mgr-row__handle-cell { width: 32px; padding-right: 4px !important; padding-left: 8px !important; }
      .ofp-mgr-row__grip {
        display: inline-block;
        font-size: 13px; line-height: 1; letter-spacing: -1px;
        color: var(--ies-gray-400);
        cursor: grab; user-select: none;
        padding: 4px 2px;
      }
      .ofp-mgr-row__grip:hover { color: var(--ies-blue); }
      .ofp-mgr-row__grip:active { cursor: grabbing; }
      .ofp-mgr-row__move-cell {
        text-align: center; white-space: nowrap;
      }
      .ofp-mgr-row__move {
        background: transparent; border: 1px solid var(--ies-gray-200);
        border-radius: 3px; width: 22px; height: 22px; padding: 0;
        cursor: pointer; font-size: 9px; line-height: 1;
        color: var(--ies-gray-500);
        display: inline-flex; align-items: center; justify-content: center;
        margin: 0 1px;
        transition: all 0.12s;
      }
      .ofp-mgr-row__move:hover:not(:disabled) {
        color: var(--ies-blue); border-color: var(--ies-blue);
      }
      .ofp-mgr-row__move:disabled { opacity: 0.3; cursor: not-allowed; }

      /* Modal: drop-target indicators on rows */
      .ofp-mgr-row--dragging { opacity: 0.40; }
      .ofp-mgr-row--drop-above td {
        box-shadow: inset 0 4px 0 0 var(--ies-blue);
        background: rgba(0, 71, 171, 0.10);
      }
      .ofp-mgr-row--drop-below td {
        box-shadow: inset 0 -4px 0 0 var(--ies-blue);
        background: rgba(0, 71, 171, 0.10);
      }

      /* ========================================================
         v0.9 — Warning banner (replaces KPI strip)
         ======================================================== */
      .ofp-warn-banner {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px;
        background: rgba(220, 38, 38, 0.06);
        border: 1px solid rgba(220, 38, 38, 0.30);
        border-radius: 6px;
        margin-bottom: 12px;
        font-size: 12px;
        color: var(--c-danger-ink);
      }
      .ofp-warn-banner__icon { font-size: 16px; line-height: 1; }
      .ofp-warn-banner__msg { flex: 1 1 auto; }
      .ofp-warn-banner__msg strong { color: var(--c-danger-strong); font-weight: 700; }
      .ofp-warn-banner__action {
        background: transparent;
        border: 1px solid rgba(220, 38, 38, 0.40);
        border-radius: 4px;
        padding: 1px 8px;
        font-size: 11px; font-weight: 600;
        color: var(--c-danger-strong);
        cursor: pointer;
        margin: 0 2px;
        transition: all 0.12s;
      }
      .ofp-warn-banner__action:hover {
        background: rgba(220, 38, 38, 0.12);
        border-color: var(--c-danger);
      }

      /* ========================================================
         v0.9 — Zoom controls
         ======================================================== */
      .ofp-zoom-controls {
        display: inline-flex; align-items: stretch;
        border: 1px solid var(--ies-gray-200);
        border-radius: 6px;
        background: #fff;
        overflow: hidden;
        flex-shrink: 0;
      }
      .ofp-zoom-btn {
        background: transparent; border: none;
        padding: 0 10px; height: 28px;
        font-size: 16px; font-weight: 700; line-height: 1;
        color: var(--ies-gray-700);
        cursor: pointer;
        transition: background 0.12s, color 0.12s;
      }
      .ofp-zoom-btn:hover:not(:disabled) {
        background: var(--ies-gray-100);
        color: var(--ies-blue);
      }
      .ofp-zoom-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .ofp-zoom-pct {
        background: transparent; border: none;
        border-left: 1px solid var(--ies-gray-200);
        border-right: 1px solid var(--ies-gray-200);
        padding: 0 8px; min-width: 48px;
        font-size: 11px; font-weight: 600;
        color: var(--ies-gray-700);
        cursor: pointer;
        transition: background 0.12s, color 0.12s;
      }
      .ofp-zoom-pct:hover {
        background: var(--ies-gray-100);
        color: var(--ies-blue);
      }

      /* ========================================================
         v0.6 — Show/hide toggle + Hidden chip strip
         ======================================================== */

      /* Modal: Visible toggle button */
      .ofp-mgr-row__visible-cell { text-align: center; }
      .ofp-mgr-row__visible {
        background: transparent;
        border: 1px solid var(--ies-gray-200);
        border-radius: 4px;
        width: 30px; height: 28px; padding: 0;
        cursor: pointer;
        font-size: 14px; line-height: 1;
        color: var(--ies-gray-700);
        transition: all 0.12s;
      }
      .ofp-mgr-row__visible:hover {
        border-color: var(--ies-blue);
        background: rgba(0, 71, 171, 0.05);
      }
      .ofp-mgr-row__visible--off {
        background: rgba(220, 38, 38, 0.06);
        border-color: rgba(220, 38, 38, 0.30);
      }
      .ofp-mgr-row--hidden { opacity: 0.55; }
      .ofp-mgr-row--hidden:hover { opacity: 1; }

      /* ========================================================
         v0.10 — Sub-area styling (canvas + modal)
         ======================================================== */

      /* Canvas: sub-area mini-block within parent area */
      .ofp-area--has-subs .ofp-area__nodes--subs {
        padding: 8px 8px 10px;
        gap: 8px;
      }
      .ofp-subarea {
        background: #fff;
        border: 1px solid var(--ies-gray-200);
        border-radius: 4px;
        margin-bottom: 6px;
      }
      .ofp-subarea:last-child { margin-bottom: 0; }
      .ofp-subarea__header {
        padding: 5px 7px 5px 9px;
        background: var(--ies-gray-50);
        border-bottom: 1px solid var(--ies-gray-100);
      }
      .ofp-subarea__title-row {
        display: flex; align-items: center; gap: 4px;
      }
      .ofp-subarea__title {
        font-size: 10px; font-weight: 700;
        color: var(--ies-navy);
        text-transform: uppercase; letter-spacing: 0.04em;
        flex: 1 1 auto; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ofp-subarea__title--other { color: var(--ies-gray-500); font-style: italic; text-transform: none; letter-spacing: 0; }
      .ofp-subarea__pencil {
        background: transparent; border: none; padding: 0 2px;
        font-size: 10px; line-height: 1; cursor: pointer;
        color: var(--ies-gray-300);
        opacity: 0; transition: opacity 0.12s, color 0.12s;
      }
      .ofp-subarea:hover .ofp-subarea__pencil { opacity: 1; }
      .ofp-subarea__pencil:hover { color: var(--ies-blue); }
      .ofp-subarea__meta {
        display: flex; align-items: center; gap: 6px;
        font-size: 9px; color: var(--ies-gray-500);
        margin-top: 2px;
      }
      .ofp-subarea__count {
        font-weight: 700;
        background: var(--ies-gray-100); border-radius: 8px;
        padding: 0 5px;
      }
      .ofp-subarea__fte { font-weight: 600; }
      .ofp-subarea__add {
        background: var(--ies-blue); color: #fff;
        border: none; border-radius: 3px;
        width: 18px; height: 18px; padding: 0;
        line-height: 1; font-size: 12px; font-weight: 700;
        cursor: pointer;
        margin-left: auto;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background 0.12s;
      }
      .ofp-subarea__add:hover { background: var(--ies-navy, #1c1c1c); }
      .ofp-subarea__nodes {
        display: flex; flex-direction: column; gap: 6px;
        padding: 8px;
      }
      .ofp-subarea__empty {
        padding: 12px 6px; text-align: center;
        font-size: 10px; color: var(--ies-gray-400); font-style: italic;
      }
      .ofp-subarea--other {
        background: var(--ies-gray-50);
      }
      .ofp-subarea--dragover {
        outline: 4px dashed var(--ies-blue);
        outline-offset: -4px;
        background: rgba(0, 71, 171, 0.22);
        box-shadow: 0 0 0 4px rgba(0, 71, 171, 0.15) inset;
        position: relative;
      }
      .ofp-subarea--dragover::after {
        content: 'Drop to assign';
        position: absolute;
        top: 6px; right: 8px;
        background: var(--ies-blue); color: #fff;
        font-size: 10px; font-weight: 700;
        padding: 3px 8px; border-radius: 4px;
        text-transform: uppercase; letter-spacing: 0.05em;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,71,171,0.55);
        z-index: 10;
      }
      .ofp-subarea--other.ofp-subarea--dragover::after {
        content: 'Drop to clear';
        background: var(--ies-gray-700, #334155);
        box-shadow: 0 4px 10px rgba(0,0,0,0.30);
      }

      /* Manage Areas modal — chevron expand button */
      .ofp-area-mgr__chevron {
        background: transparent; border: none; padding: 0;
        font-size: 10px; line-height: 1;
        color: var(--ies-gray-400);
        cursor: pointer;
        transition: transform 0.18s, color 0.12s;
        margin-left: 2px;
      }
      .ofp-area-mgr__chevron:hover { color: var(--ies-blue); }
      .ofp-area-mgr__chevron--open { transform: rotate(90deg); color: var(--ies-blue); }

      /* Manage Areas modal — sub-area row styling */
      .ofp-subarea-mgr__row { background: rgba(0, 71, 171, 0.02); }
      .ofp-subarea-mgr__row:hover { background: rgba(0, 71, 171, 0.05); }
      .ofp-subarea-mgr__row td { padding: 6px 8px; font-size: 11px; }
      .ofp-subarea-mgr__row .ofp-area-mgr__input {
        font-size: 11px; padding: 4px 6px;
      }
      .ofp-subarea-mgr__indent { width: 40px; }
      .ofp-subarea-mgr__indent::after {
        content: '↳';
        display: inline-block;
        margin-left: 16px;
        color: var(--ies-gray-300);
        font-size: 12px;
      }
      .ofp-subarea-mgr__add-row td {
        padding: 6px 8px 10px 50px !important;
        background: rgba(0, 71, 171, 0.02);
      }
      .ofp-subarea-mgr__add-btn {
        background: transparent;
        border: 1px dashed var(--ies-gray-300);
        border-radius: 4px;
        padding: 4px 12px;
        font-size: 11px; font-weight: 600;
        color: var(--ies-gray-600);
        cursor: pointer;
        transition: all 0.12s;
      }
      .ofp-subarea-mgr__add-btn:hover {
        border-color: var(--ies-blue);
        color: var(--ies-blue);
        background: rgba(0, 71, 171, 0.04);
      }

      /* Hidden strip — sits between section header and KPI strip */
      .ofp-hidden-strip {
        display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
        padding: 8px 12px;
        background: var(--ies-gray-50);
        border: 1px solid var(--ies-gray-200);
        border-radius: 6px;
        margin-bottom: 12px;
      }
      .ofp-hidden-strip__label {
        font-size: 10px; font-weight: 700;
        color: var(--ies-gray-500);
        text-transform: uppercase; letter-spacing: 0.04em;
        margin-right: 4px;
      }
      .ofp-hidden-chip {
        display: inline-flex; align-items: center; gap: 5px;
        background: #fff;
        border: 1px solid var(--ies-gray-200);
        border-radius: 12px;
        padding: 3px 9px 3px 7px;
        cursor: pointer;
        font-size: 11px; color: var(--ies-navy);
        transition: all 0.12s;
      }
      .ofp-hidden-chip:hover {
        border-color: var(--ies-blue);
        background: rgba(0, 71, 171, 0.04);
      }
      .ofp-hidden-chip__dot {
        width: 8px; height: 8px; border-radius: 50%;
        flex-shrink: 0;
      }
      .ofp-hidden-chip__name { font-weight: 600; }
      .ofp-hidden-chip__type {
        font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
        color: var(--ies-gray-400); text-transform: uppercase;
      }
      .ofp-hidden-chip--flow .ofp-hidden-chip__type { color: var(--ies-gray-500); }
      .ofp-hidden-chip__icon {
        font-size: 10px; opacity: 0.7;
      }
    </style>
  `;
}

export default ofpStyles;

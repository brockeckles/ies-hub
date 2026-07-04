/**
 * IES Hub v3 — WSC Design Basis section (N1, 2026-07-04)
 *
 * The ingest + profiling surface of the re-founded WSC. Two first-class
 * paths (Brock's call, 2026-07-04):
 *   - Data mode  : upload SKU master / inventory snapshot / order history
 *                  through a column-mapping wizard (COG C1 pattern,
 *                  generalized to three file types).
 *   - Sparse mode: RFP-summary aggregates via a short form.
 *
 * Both emit the same DesignProfile (profile-calc.js) with per-field
 * provenance. Nothing here writes to the DB — the profile rides the
 * scenario's normal Save path inside config_data.profile.
 *
 * @module tools/warehouse-sizing/ui-basis
 */

import {
  parseSkuMaster, parseInventory, parseOrders,
  computeProfile, computeSparseProfile, profileReadiness,
  autoDetectMapping, SKU_MASTER_ROLES, INVENTORY_ROLES, ORDER_ROLES,
} from './profile-calc.js?v=20260704-n1a';
import { wscFactorsDrift } from './factors-calc.js?v=20260704-n2a';

// ── Module state (session-scoped; raw rows never persisted) ──
/** Parsed datasets awaiting/backing the profile. */
let _data = { skus: null, inventory: null, orders: null };
/** Per-slot source metadata for the summary cards. */
let _sources = { skuMaster: null, inventory: null, orders: null };
/** Pending upload wizard: { slot, fileName, aoa, headerRow, mapping } */
let _pending = null;
/** N2 — live factor catalog cache (session): null = not fetched yet. */
let _liveFactors = null;

const SLOTS = [
  { key: 'skuMaster', label: 'SKU Master',         roles: SKU_MASTER_ROLES, hint: 'Item #, units/case, Ti×Hi, case dims' },
  { key: 'inventory', label: 'Inventory Snapshot', roles: INVENTORY_ROLES,  hint: 'SKU + on-hand units, cases, or pallets' },
  { key: 'orders',    label: 'Order History',      roles: ORDER_ROLES,      hint: 'Date, order #, SKU, qty — 12–24 months ideal' },
];

/** Reset session ingest state — called when the editor opens a scenario. */
export function resetBasisState() {
  _data = { skus: null, inventory: null, orders: null };
  _sources = { skuMaster: null, inventory: null, orders: null };
  _pending = null;
}

const PROV_CHIP = {
  derived:   ['#dcfce7', '#15803d', 'DERIVED'],
  asserted:  ['#dbeafe', '#1d4ed8', 'ASSERTED'],
  estimated: ['#fef3c7', '#b45309', 'ESTIMATED'],
};
function provChip(kind) {
  const [bg, fg, label] = PROV_CHIP[kind] || PROV_CHIP.estimated;
  return `<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:0.5px;background:${bg};color:${fg};vertical-align:middle;">${label}</span>`;
}
const fmt = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
const esc = (s) => String(s ?? '').replace(/</g, '&lt;');

// ============================================================
// RENDER
// ============================================================

/**
 * @param {HTMLElement} container
 * @param {Object} ctx — { getProfile, setProfile, markDirty, rerender }
 */
export function renderBasisView(container, ctx) {
  const profile = ctx.getProfile();
  const readiness = profileReadiness(profile);
  container.innerHTML = `
    <div style="max-width:1080px;">
      ${_renderHeader(profile, readiness)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;">
        ${_renderDataCard(profile)}
        ${_renderSparseCard(profile)}
      </div>
      <div id="wsc-basis-wizard" style="display:none;"></div>
      ${profile ? _renderProfileSummary(profile) : _renderEmptyState()}
      <div id="wsc-basis-factors"></div>
    </div>
  `;
  _bindEvents(container, ctx);
  if (_pending) _renderWizard(container.querySelector('#wsc-basis-wizard'), ctx);
  _renderFactorsCard(container.querySelector('#wsc-basis-factors'), ctx);
}

function _renderHeader(profile, readiness) {
  const barColor = readiness.score >= 85 ? '#15803d' : readiness.score >= 50 ? '#b45309' : '#9ca3af';
  return `
    <div class="hub-card" style="padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;">
        <div style="font-size:14px;font-weight:700;">Design Basis</div>
        <div style="font-size:12px;color:var(--ies-gray-500);margin-top:2px;">
          Every defendable number starts here — load customer data, or assert RFP-level aggregates and upgrade later.
        </div>
      </div>
      <div style="min-width:200px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:600;margin-bottom:3px;">
          <span>Profile readiness</span><span style="color:${barColor};">${readiness.label} · ${readiness.score}%</span>
        </div>
        <div style="height:6px;background:var(--ies-gray-100);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${readiness.score}%;background:${barColor};border-radius:3px;"></div>
        </div>
        ${profile ? `<div style="font-size:10px;color:var(--ies-gray-500);margin-top:3px;">Mode: ${profile.mode === 'data' ? 'customer data' : 'sparse / RFP'}</div>` : ''}
      </div>
    </div>
  `;
}

function _renderDataCard(profile) {
  return `
    <div class="hub-card" style="padding:14px 16px;${profile?.mode === 'data' ? 'border-left:3px solid #15803d;' : ''}">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
        Customer Data ${profile?.mode === 'data' ? '· active' : ''}
      </div>
      ${SLOTS.map(s => {
        const src = _sources[s.key];
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--ies-gray-100);">
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:600;">${s.label}
                ${src ? `<span style="color:#15803d;font-weight:700;"> ✓</span>` : ''}
              </div>
              <div style="font-size:10.5px;color:var(--ies-gray-500);">
                ${src ? `${esc(src.fileName)} · ${fmt(src.rows)} rows${src.skipped ? ` · ${src.skipped} skipped` : ''}` : s.hint}
              </div>
            </div>
            <button class="hub-btn hub-btn-sm hub-btn-secondary" data-basis-upload="${s.key}">${src ? 'Replace' : 'Upload'}</button>
            ${src ? `<button class="hub-btn hub-btn-sm hub-btn-secondary" data-basis-clear="${s.key}" title="Remove this dataset">✕</button>` : ''}
          </div>
        `;
      }).join('')}
      <div style="font-size:10.5px;color:var(--ies-gray-500);margin-top:8px;">
        XLSX / XLS / CSV. Any single file yields a partial profile; each added file derives more and asserts less.
      </div>
      <input type="file" id="wsc-basis-file" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>
  `;
}

function _renderSparseCard(profile) {
  const v = (profile?.mode === 'sparse') ? profile : null;
  const val = (x) => x == null ? '' : x;
  return `
    <div class="hub-card" style="padding:14px 16px;${v ? 'border-left:3px solid #1d4ed8;' : ''}">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
        Sparse / RFP Summary ${v ? '· active' : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;">
        ${[
          ['sp-skuCount', 'SKU count *', val(v?.skuCount)],
          ['sp-onHandPallets', 'On-hand pallets (peak)', val(v?.volumes?.onHandPallets)],
          ['sp-annualOutboundUnits', 'Annual outbound units', val(v?.volumes?.annualOutboundUnits)],
          ['sp-avgPalletsPerSku', 'Avg pallets per SKU', val(v?.provenance?.depthOfHolding === 'asserted' ? v?.depthOfHolding?.avgPalletsPerSku : '')],
          ['sp-avgCasesPerPallet', 'Avg cases per pallet (Ti×Hi)', val(v?.tiHi?.avgCasesPerPallet)],
          ['sp-peakFactor', 'Peak factor', val(v?.provenance?.peak === 'asserted' ? v?.peak?.peakFactor : '')],
        ].map(([id, label, value]) => `
          <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:block;">
            ${label}
            <input type="number" id="${id}" value="${value}" min="0" step="any"
                   style="display:block;width:100%;margin-top:3px;padding:5px 8px;border:1px solid var(--ies-gray-200);border-radius:5px;font-size:12px;">
          </label>
        `).join('')}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:8px;">
        <div style="font-size:10.5px;color:var(--ies-gray-500);">* required. Blank fields fall back to cited defaults and are flagged in the gap report.</div>
        <button class="hub-btn hub-btn-sm hub-btn-primary" id="wsc-basis-sparse-apply">Build Profile</button>
      </div>
    </div>
  `;
}

function _renderEmptyState() {
  return `
    <div class="hub-card" style="padding:22px;margin-top:14px;text-align:center;color:var(--ies-gray-500);font-size:12.5px;">
      No design basis yet. Upload customer data (left) or enter RFP aggregates (right) —
      the profile, its provenance, and a data-gap report will render here.
    </div>
  `;
}

function _renderProfileSummary(p) {
  const prov = p.provenance || {};
  const bands = p.velocityBands;
  const d = p.depthOfHolding;
  const gapIcon = { error: '⛔', warn: '⚠', info: 'ℹ' };
  const maxBucket = d?.distribution ? Math.max(1, ...d.distribution.map(b => b.skuCount)) : 1;
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:start;">

      <div class="hub-card" style="padding:14px 16px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px;">Velocity Profile ${provChip(prov.velocityBands)}</div>
        ${bands ? `
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="color:var(--ies-gray-500);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;">
              <th style="text-align:left;padding:3px 0;">Band</th><th style="text-align:right;">SKUs</th>
              <th style="text-align:right;">SKU %</th><th style="text-align:right;">Line %</th>
            </tr></thead>
            <tbody>
              ${['A', 'B', 'C'].map(k => `
                <tr style="border-top:1px solid var(--ies-gray-100);">
                  <td style="padding:5px 0;font-weight:700;">${k}</td>
                  <td style="text-align:right;">${fmt(bands[k].skuCount)}</td>
                  <td style="text-align:right;">${fmt(bands[k].skuPct, 1)}%</td>
                  <td style="text-align:right;">${fmt(bands[k].linePct, 1)}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${p.cubeMovement ? `
            <div style="font-size:10.5px;color:var(--ies-gray-500);margin-top:6px;">
              Cube movement ${provChip(prov.cubeMovement)} : A ${fmt(p.cubeMovement.A.cubePct, 1)}% ·
              B ${fmt(p.cubeMovement.B.cubePct, 1)}% · C ${fmt(p.cubeMovement.C.cubePct, 1)}% of shipped cube
            </div>` : ''}
        ` : '<div style="font-size:12px;color:var(--ies-gray-500);">Not available — needs order history (or ABC assertion in sparse mode).</div>'}
      </div>

      <div class="hub-card" style="padding:14px 16px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px;">Depth of Holding ${provChip(prov.depthOfHolding || prov.onHandPallets)}</div>
        ${d ? `
          <div style="display:flex;gap:16px;font-size:12px;margin-bottom:8px;">
            <div><span style="font-size:16px;font-weight:700;">${fmt(d.avgPalletsPerSku, 1)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">avg plt/SKU</span></div>
            ${d.p50 != null ? `<div><span style="font-size:16px;font-weight:700;">${fmt(d.p50, 1)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">median</span></div>` : ''}
            ${d.p90 != null ? `<div><span style="font-size:16px;font-weight:700;">${fmt(d.p90, 1)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">p90</span></div>` : ''}
            ${p.volumes?.onHandPallets != null ? `<div><span style="font-size:16px;font-weight:700;">${fmt(p.volumes.onHandPallets)}</span><br><span style="font-size:10px;color:var(--ies-gray-500);">total pallets</span></div>` : ''}
          </div>
          ${d.distribution ? `
            <div style="font-size:10px;color:var(--ies-gray-500);margin-bottom:3px;">SKUs by pallets-per-SKU (media-map buckets)</div>
            ${d.distribution.map(b => `
              <div style="display:flex;align-items:center;gap:6px;font-size:10.5px;margin:2px 0;">
                <span style="width:38px;color:var(--ies-gray-600);font-weight:600;">${b.bucket}</span>
                <div style="flex:1;height:9px;background:var(--ies-gray-100);border-radius:2px;overflow:hidden;">
                  <div style="height:100%;width:${(b.skuCount / maxBucket) * 100}%;background:#6366f1;border-radius:2px;"></div>
                </div>
                <span style="width:56px;text-align:right;color:var(--ies-gray-600);">${fmt(b.skuCount)} SKU</span>
              </div>
            `).join('')}` : '<div style="font-size:10.5px;color:var(--ies-gray-500);">No per-SKU distribution in sparse mode — upload an inventory snapshot to unlock it.</div>'}
        ` : '<div style="font-size:12px;color:var(--ies-gray-500);">Not available — needs an inventory snapshot or a pallets-per-SKU assertion.</div>'}
      </div>

      <div class="hub-card" style="padding:14px 16px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px;">Volumes & Peak</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          ${[
            ['SKU universe', fmt(p.skuCount), prov.skuCount],
            ['Annual outbound units', fmt(p.volumes?.annualOutboundUnits), prov.volumes],
            ['On-hand pallets', fmt(p.volumes?.onHandPallets), prov.onHandPallets || prov.volumes],
            ['Avg cases/pallet (Ti×Hi)', fmt(p.tiHi?.avgCasesPerPallet, 1), prov.tiHi],
            ['Peak factor', fmt(p.peak?.peakFactor, 2), prov.peak],
            p.peak?.weeksObserved != null ? ['Weeks observed', fmt(p.peak.weeksObserved), 'derived'] : null,
          ].filter(Boolean).map(([label, value, pv]) => `
            <tr style="border-top:1px solid var(--ies-gray-100);">
              <td style="padding:5px 0;color:var(--ies-gray-600);">${label}</td>
              <td style="text-align:right;font-weight:700;">${value}</td>
              <td style="text-align:right;width:78px;">${pv ? provChip(pv) : ''}</td>
            </tr>
          `).join('')}
        </table>
      </div>

      <div class="hub-card" style="padding:14px 16px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px;">Data Gap Report
          <span style="font-weight:400;color:var(--ies-gray-500);font-size:11px;">· ${p.dataGaps.length} item${p.dataGaps.length === 1 ? '' : 's'}</span>
        </div>
        ${p.dataGaps.length === 0
          ? '<div style="font-size:12px;color:#15803d;font-weight:600;">✓ No gaps — fully derived basis.</div>'
          : p.dataGaps.map(g => `
            <div style="display:flex;gap:7px;font-size:11.5px;padding:4px 0;border-top:1px solid var(--ies-gray-100);">
              <span>${gapIcon[g.severity] || 'ℹ'}</span>
              <span style="color:var(--ies-gray-700);">${esc(g.message)}</span>
            </div>
          `).join('')}
        <div style="font-size:10px;color:var(--ies-gray-500);margin-top:8px;">
          This report prints in the Design Basis document — gaps are disclosed, not hidden.
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// WIZARD (COG C1 pattern, three-file generalization)
// ============================================================

function _renderWizard(container, ctx) {
  if (!_pending || !container) return;
  const pu = _pending;
  const slot = SLOTS.find(s => s.key === pu.slot);
  const aoa = pu.aoa;
  const ncol = Math.max(...aoa.slice(0, 5).map(r => r ? r.length : 0));
  const previewRows = aoa.slice(pu.headerRow ? 1 : 0).slice(0, 5);
  if (!pu.mapping || Object.keys(pu.mapping).length === 0) {
    pu.mapping = pu.headerRow ? autoDetectMapping(pu.headerRow, slot.roles) : {};
  }
  const mapped = new Set(Object.values(pu.mapping).filter(Boolean));
  const needsSku = pu.slot !== 'orders' || true;
  const hasSku = mapped.has('sku');
  const hasQty = pu.slot === 'skuMaster' ? true
    : pu.slot === 'inventory' ? (mapped.has('onHandUnits') || mapped.has('onHandCases') || mapped.has('onHandPallets'))
    : (mapped.has('qtyUnits') || mapped.has('qtyCases'));
  const valid = hasSku && hasQty;
  const needMsg = pu.slot === 'skuMaster' ? 'a SKU column'
    : pu.slot === 'inventory' ? 'a SKU column AND an on-hand column'
    : 'a SKU column AND a qty column';
  const statusMsg = valid
    ? `<span style="color:#15803d;font-weight:600;">✓ Ready — ${aoa.length - (pu.headerRow ? 1 : 0)} data rows</span>`
    : `<span style="color:#b91c1c;font-weight:600;">⚠ Need ${needMsg}</span>`;
  container.style.display = 'block';
  container.innerHTML = `
    <div class="hub-card" style="margin-top:14px;padding:14px 16px;background:#fffbeb;border-left:3px solid #f59e0b;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#92400e;">
            ${slot.label} — column mapping for "${esc(pu.fileName)}"</div>
          <div style="font-size:11px;color:var(--ies-gray-500);margin-top:2px;">Assign each column a role. Auto-detected roles are pre-selected.</div>
        </div>
        <label style="font-size:11px;font-weight:600;color:var(--ies-gray-600);display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="wsc-wiz-has-header" ${pu.headerRow ? 'checked' : ''} style="cursor:pointer;">
          Row 1 is a header
        </label>
      </div>
      <div style="overflow-x:auto;margin-bottom:10px;">
        <table style="border-collapse:collapse;font-size:12px;width:100%;min-width:480px;">
          <thead><tr style="background:#fde68a;">
            ${Array.from({ length: ncol }, (_, i) => `
              <th style="padding:6px 8px;text-align:left;border:1px solid #fcd34d;font-weight:700;min-width:120px;">
                <div style="font-size:10px;color:#78350f;letter-spacing:0.3px;text-transform:uppercase;margin-bottom:2px;">Col ${String.fromCharCode(65 + i)}${pu.headerRow ? ' · ' + esc(pu.headerRow[i] || '') : ''}</div>
                <select data-basis-wiz-col="${i}" style="width:100%;padding:4px 6px;border:1px solid #d97706;border-radius:4px;font-size:12px;font-weight:600;background:#fff;">
                  ${slot.roles.map(r => `<option value="${r.value}"${(pu.mapping[i] || '') === r.value ? ' selected' : ''}>${r.label}</option>`).join('')}
                </select>
              </th>`).join('')}
          </tr></thead>
          <tbody>
            ${previewRows.map(row => `
              <tr>${Array.from({ length: ncol }, (_, i) => `
                <td style="padding:5px 8px;border:1px solid #fde68a;background:#fff;color:var(--ies-gray-700);font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:11px;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${row && row[i] != null ? esc(row[i]) : ''}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div style="font-size:12px;">${statusMsg}</div>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="wsc-wiz-cancel">Cancel</button>
          <button class="hub-btn hub-btn-sm hub-btn-primary" id="wsc-wiz-confirm" ${valid ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>Confirm & Profile</button>
        </div>
      </div>
    </div>
  `;
  container.querySelectorAll('[data-basis-wiz-col]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.basisWizCol, 10);
      pu.mapping[idx] = e.target.value;
      _renderWizard(container, ctx);
    });
  });
  container.querySelector('#wsc-wiz-has-header')?.addEventListener('change', (e) => {
    pu.headerRow = e.target.checked ? (pu.aoa[0] || []).map(v => String(v ?? '')) : null;
    pu.mapping = {};
    _renderWizard(container, ctx);
  });
  container.querySelector('#wsc-wiz-cancel')?.addEventListener('click', () => {
    _pending = null;
    container.style.display = 'none';
    container.innerHTML = '';
  });
  container.querySelector('#wsc-wiz-confirm')?.addEventListener('click', () => {
    if (!valid) return;
    _commitPending(ctx);
  });
}

function _commitPending(ctx) {
  const pu = _pending;
  if (!pu) return;
  const rows = pu.aoa.slice(pu.headerRow ? 1 : 0);
  let meta;
  if (pu.slot === 'skuMaster') {
    const r = parseSkuMaster(rows, pu.mapping);
    _data.skus = r.skus;
    meta = { fileName: pu.fileName, rows: r.rowCount, skipped: r.skipped };
  } else if (pu.slot === 'inventory') {
    const r = parseInventory(rows, pu.mapping);
    _data.inventory = r.inventory;
    meta = { fileName: pu.fileName, rows: r.rowCount, skipped: r.skipped };
  } else {
    const r = parseOrders(rows, pu.mapping);
    _data.orders = r.lines;
    meta = { fileName: pu.fileName, rows: r.rowCount, skipped: r.skipped };
  }
  _sources[pu.slot] = meta;
  _pending = null;
  _recomputeDataProfile(ctx);
}

function _recomputeDataProfile(ctx) {
  const profile = computeProfile({ skus: _data.skus, inventory: _data.inventory, orders: _data.orders });
  profile.sources = { ..._sources };
  ctx.setProfile(profile);
  ctx.rerender();
}

// ============================================================
// HOUSE FACTORS (N2) — pinned catalog + drift badge + explicit adopt
// ============================================================

const _SRC_CHIP = {
  'standard':        ['#dcfce7', '#15803d'],
  'industry method': ['#dbeafe', '#1d4ed8'],
  'vendor heuristic':['#fef3c7', '#b45309'],
  'IES assumption':  ['#f3e8ff', '#7e22ce'],
};
function _srcChip(source) {
  const [bg, fg] = _SRC_CHIP[source] || ['#f3f4f6', '#374151'];
  return `<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:0.4px;background:${bg};color:${fg};white-space:nowrap;">${esc(source || '?')}</span>`;
}
function _factorValueLabel(r) {
  if (r.numeric_value != null) return `${fmt(r.numeric_value, 2)}${r.value_unit ? ' ' + esc(r.value_unit) : ''}`;
  const j = r.value_jsonb;
  if (j && typeof j === 'object' && !Array.isArray(j) && 'min' in j && 'max' in j) {
    return `${fmt(j.min, 2)}–${fmt(j.max, 2)}${r.value_unit ? ' ' + esc(r.value_unit) : ''}`;
  }
  return '<span style="color:var(--ies-gray-500);">structured</span>';
}

async function _renderFactorsCard(el, ctx) {
  if (!el) return;
  const pinned = ctx.getPinnedFactors?.();
  el.innerHTML = `<div class="hub-card" style="padding:14px 16px;margin-top:14px;font-size:12px;color:var(--ies-gray-500);">Loading design-factor catalog…</div>`;
  if (_liveFactors === null) {
    try { _liveFactors = await ctx.fetchFactors(); }
    catch (_) { _liveFactors = []; }
  }
  const live = _liveFactors;
  if ((!live || live.length === 0) && !pinned) {
    el.innerHTML = `<div class="hub-card" style="padding:14px 16px;margin-top:14px;font-size:12px;color:var(--ies-gray-500);">Design-factor catalog unavailable (offline or empty) — factors pin at first save once reachable.</div>`;
    return;
  }
  const drift = pinned ? wscFactorsDrift(pinned, live) : null;
  const rows = pinned ? drift.rows : live.map(r => ({ ...r, changed: false, missing: false }));
  const byCat = {};
  for (const r of rows) (byCat[r.category_code] = byCat[r.category_code] || []).push(r);
  const CAT_LABEL = {
    wsc_media_selection: 'Media selection', wsc_dynamics: 'Dock / staging / aisles',
    wsc_layout_compliance: 'Layout & compliance', wsc_profile_defaults: 'Profile & height',
  };
  el.innerHTML = `
    <div class="hub-card" style="padding:14px 16px;margin-top:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:700;">Design Factors
          <span style="font-weight:400;color:var(--ies-gray-500);font-size:11px;">
            · ${pinned ? `pinned ${esc(pinned.pinnedAt)}` : 'not pinned yet — pins at first save'}</span>
          ${drift?.anyDrift ? '<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:#fee2e2;color:#b91c1c;">CATALOG MOVED</span>' : ''}
        </div>
        ${drift?.anyDrift ? '<button class="hub-btn hub-btn-sm hub-btn-secondary" id="wsc-factors-adopt" title="Re-pin this scenario to today\'s catalog. Nothing else about the design changes.">Adopt current catalog</button>' : ''}
      </div>
      ${Object.entries(byCat).map(([cat, list]) => `
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin:10px 0 2px;">${CAT_LABEL[cat] || esc(cat)}</div>
        ${list.map(r => `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--ies-gray-100);font-size:11.5px;">
            <span style="flex:1;" title="${esc(r.source_detail || '')}">${esc(r.display_name)}</span>
            ${_srcChip(r.source)}
            <span style="width:120px;text-align:right;font-weight:600;">${_factorValueLabel(r)}</span>
            ${r.changed ? `<span style="color:#b91c1c;font-size:10px;font-weight:700;" title="Catalog now: ${esc(_factorValueLabel(r.current).replace(/<[^>]*>/g, ''))}">Δ</span>` : r.missing ? '<span style="color:#b45309;font-size:10px;font-weight:700;" title="Removed from catalog">✕</span>' : '<span style="width:10px;"></span>'}
          </div>
        `).join('')}
      `).join('')}
      ${drift?.added?.length ? `<div style="font-size:10.5px;color:#b45309;margin-top:8px;">＋ ${drift.added.length} new factor(s) in the catalog since this scenario pinned — adopt to include.</div>` : ''}
      <div style="font-size:10px;color:var(--ies-gray-500);margin-top:8px;">
        Org-wide guidance pinned per scenario — catalog changes never silently alter a saved design. Sources cited per factor (hover names).
      </div>
    </div>
  `;
  el.querySelector('#wsc-factors-adopt')?.addEventListener('click', () => {
    ctx.adoptFactors(live);
    _renderFactorsCard(el, ctx);
    ctx.toast?.('Scenario re-pinned to the current factor catalog.', 'success');
  });
}

// ============================================================
// EVENTS
// ============================================================

function _bindEvents(container, ctx) {
  const fileInput = container.querySelector('#wsc-basis-file');

  container.querySelectorAll('[data-basis-upload]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.dataset.basisUpload;
      fileInput.dataset.slot = slot;
      fileInput.value = '';
      fileInput.click();
    });
  });

  container.querySelectorAll('[data-basis-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.dataset.basisClear;
      if (slot === 'skuMaster') _data.skus = null;
      if (slot === 'inventory') _data.inventory = null;
      if (slot === 'orders') _data.orders = null;
      _sources[slot] = null;
      if (_data.skus || _data.inventory || _data.orders) _recomputeDataProfile(ctx);
      else { ctx.setProfile(null); ctx.rerender(); }
    });
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const XLSX_ = typeof window !== 'undefined' ? window.XLSX : null;
    if (!XLSX_ || !XLSX_.read) {
      ctx.toast?.('Spreadsheet parser not loaded — refresh the page and retry.', 'error');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX_.read(buf, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX_.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      const dataRows = aoa.filter(r => r && r.some(c => c !== '' && c != null));
      if (dataRows.length === 0) { ctx.toast?.('File appears to be empty.', 'error'); return; }
      // Assume a header row when the first row is mostly non-numeric strings.
      const first = dataRows[0];
      const looksHeader = first.filter(c => c !== '' && isNaN(parseFloat(String(c).replace(/[,$\s]/g, '')))).length >= first.filter(c => c !== '').length / 2;
      _pending = {
        slot: fileInput.dataset.slot,
        fileName: file.name,
        aoa: dataRows,
        headerRow: looksHeader ? first.map(v => String(v ?? '')) : null,
        mapping: {},
      };
      _renderWizard(container.querySelector('#wsc-basis-wizard'), ctx);
    } catch (err) {
      ctx.toast?.(`Could not read "${file.name}": ${err.message}`, 'error');
    }
  });

  container.querySelector('#wsc-basis-sparse-apply')?.addEventListener('click', () => {
    const g = (id) => {
      const el = container.querySelector('#' + id);
      const n = parseFloat(el?.value);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const inputs = {
      skuCount: g('sp-skuCount'),
      onHandPallets: g('sp-onHandPallets'),
      annualOutboundUnits: g('sp-annualOutboundUnits'),
      avgPalletsPerSku: g('sp-avgPalletsPerSku'),
      avgCasesPerPallet: g('sp-avgCasesPerPallet'),
      peakFactor: g('sp-peakFactor'),
    };
    if (!inputs.skuCount) { ctx.toast?.('SKU count is required for a sparse profile.', 'error'); return; }
    const profile = computeSparseProfile(inputs);
    // Switching to sparse mode clears session file state (one active basis at a time).
    resetBasisState();
    ctx.setProfile(profile);
    ctx.rerender();
  });
}

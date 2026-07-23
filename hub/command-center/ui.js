/**
 * IES Hub v3 — Command Center UI
 * Full dashboard with live KPI tiles, Sector Pulse cards, Market Alerts,
 * recent activity, tool quick-launch, and platform health.
 * Queries Supabase for live data with demo fallback.
 *
 * @module hub/command-center/ui
 */

import * as api from './api.js?v=20260723-s5b';
import { escapeHtml, safeHttpUrl } from '../../shared/escape.js?v=20260702-sec2';
// C2 (2026-07-22): DOS_STAGES is the SINGLE canonical stage definition
// (names + colors) — the snapshot's stage bar derives from it instead of
// carrying its own duplicate arrays.
import { DOS_STAGES } from '../../tools/deal-manager/calc.js?v=20260723-s5a';

/** @type {HTMLElement|null} */
let rootEl = null;
let refreshTimer = null;
let liveData = null;

export async function mount(el) {
  rootEl = el;
  el.innerHTML = renderLoading();
  liveData = await api.fetchDashboardData();
  render();
  // Auto-refresh every 5 minutes
  refreshTimer = setInterval(async () => {
    liveData = await api.fetchDashboardData();
    render();
  }, 5 * 60 * 1000);
}

export function unmount() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  rootEl = null;
}

function renderLoading() {
  return `<div class="hub-content-inner" style="padding:24px;display:flex;align-items:center;justify-content:center;min-height:400px;">
    <div class="u-center"><div style="font-size:14px;color:var(--ies-gray-400);">Loading Command Center...</div></div>
  </div>`;
}

function render() {
  if (!rootEl || !liveData) return;
  const d = liveData;
  const now = new Date();
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  rootEl.innerHTML = `
    <style>
      .cc-kpi-tile:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,.08); border-color: var(--ies-gray-300); }
      .cc-kpi-tile:hover .cc-kpi-tooltip { opacity: 1; }
      .cc-intel-tab {
        font-size: 11px; font-weight: 700;
        padding: 4px 10px; border-radius: 999px;
        border: 1px solid var(--ies-gray-300);
        background: #fff; color: var(--ies-gray-700);
        cursor: pointer; text-transform: uppercase; letter-spacing: 0.04em;
        white-space: nowrap;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
      }
      .cc-intel-tab:hover { border-color: var(--ies-navy); color: var(--ies-navy); }
      .cc-intel-tab.active {
        background: var(--ies-navy); color: #fff; border-color: var(--ies-navy);
      }
      .cc-alert-banner { transition: filter .12s ease; }
      .cc-alert-banner:hover { filter: brightness(0.97); cursor: pointer; }
    </style>
    <div class="hub-content-inner" style="padding:24px;max-width:var(--content-max-width, 1400px);">

      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div>
          <h1 class="text-page u-mb-1">${greeting}</h1>
          <p style="font-size:13px;color:var(--ies-gray-400);margin:0;">${dateStr} — IES Intelligence Hub v3.0</p>
        </div>
        <div class="u-row">
          <span style="width:8px;height:8px;border-radius:50%;background:${d.supabaseConnected ? 'var(--ies-green)' : 'var(--ies-orange)'};"></span>
          <span class="u-cap u-faint">${d.supabaseConnected ? 'Live' : 'Demo'} Data</span>
          <span style="font-size:11px;color:var(--ies-gray-300);margin-left:4px;">Updated ${timeStr}</span>
          <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="refresh" style="margin-left:8px;padding:4px 10px;font-size:11px;">↻ Refresh</button>
        </div>
      </div>

      <!-- Inline alert banner — whole banner clickable -> jump to Alerts tab -->
      ${renderInlineAlertBanner(d.alerts)}

      <!-- Vital Signs — 6 KPI tiles, each clickable -> Market Explorer with drill-down -->
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:20px;">
        ${vitalSignTile('Diesel Price', '$' + d.kpis.dieselPrice.toFixed(2), '/gal', d.kpis.dieselTrend, '#dc2626', d.kpis.dieselChange, d.sparks?.diesel, 'marketmap?series=diesel', '26-week range')}
        ${vitalSignTile('Warehouse Wage', '$' + d.kpis.avgWage.toFixed(2), '/hr', d.kpis.wageTrend, '#7c3aed', d.kpis.wageChange, d.sparks?.wage, 'marketmap?series=wage', '12-month modeled')}
        ${vitalSignTile('Warehouse Rate', '$' + (d.kpis.avgWarehouseRate || 0).toFixed(2), '/sf/yr', d.kpis.warehouseRateTrend || 'neutral', '#2563eb', d.kpis.warehouseRateChange || '—', d.sparks?.warehouseRate, 'marketmap?series=realestate', '8-quarter modeled')}
        ${vitalSignTile('Freight Index', d.kpis.freightIndex.toFixed(0), '', d.kpis.freightTrend, '#ea580c', d.kpis.freightChange, d.sparks?.freight, 'marketmap?series=freight', '26-week range')}
        ${vitalSignTile('Steel Index', '$' + Math.round(d.kpis.steelPrice).toLocaleString(), (d.kpis.steelUnit || '/ton').replace('$/', '/'), d.kpis.steelTrend, '#0891b2', d.kpis.steelChange, d.sparks?.steel, 'marketmap?series=steel', '26-week CRU HRC')}
        ${vitalSignTile('RFP Signals', String(d.kpis.rfpSignalCount || 0), 'active', d.kpis.rfpSignalTrend || 'neutral', '#16a34a', d.kpis.rfpSignalChange || '—', d.sparks?.rfp, 'marketmap?series=rfp', '12-week cumulative')}
      </div>

      <!-- Two-column body: Signal Stream (2/3) + Right rail (1/3) -->
      <!-- Fixed grid-template-rows so both columns match height AND the
           Signal Stream scrolls internally instead of stretching the row
           to fit all 60 items. -->
      <div style="display:grid;grid-template-columns:2fr 1fr;grid-template-rows:min(75vh, 720px);gap:16px;align-items:stretch;">

        <!-- LEFT — Signal Stream (the unified intelligence feed; replaces Sector Pulse + Market Alerts) -->
        <!-- min-height:0 is the magic: without it, flex:1 on the inner body
             can't actually shrink below content height, defeating overflow:auto. -->
        <div class="hub-card" id="cc-signal-stream" style="padding:0;display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:0;">
          <div style="padding:14px 16px 0;border-bottom:1px solid var(--ies-gray-100);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <div class="u-13 u-bold">Signal Stream</div>
              <span class="u-cap u-faint">All market intelligence in one place</span>
            </div>
            <div style="display:flex;gap:4px;overflow-x:auto;padding-bottom:10px;">
              ${['all','alerts','competitor','accounts','tariff','rfp'].map((k, i) => `
                <button type="button" data-intel-tab="${k}" class="cc-intel-tab ${i === 0 ? 'active' : ''}">${labelForIntelTab(k)} <span style="opacity:.7;">(${(d.intel?.[k === 'all' ? 'all' : k] || []).length})</span></button>
              `).join('')}
            </div>
          </div>
          <div style="padding:8px 16px 16px;overflow-y:auto;flex:1;" id="cc-intel-body">
            ${renderIntelFeed(d.intel?.all || [], d.activity)}
          </div>
        </div>

        <!-- RIGHT rail — Pipeline Snapshot + RFP Signals (flex-grow, internal scroll) + Tool Shortcuts -->
        <div style="display:flex;flex-direction:column;gap:16px;height:100%;min-height:0;">
          ${renderPipelineSnapshot(d.pipeline)}
          ${renderWinLossCard(d.winLoss)}

          <div class="hub-card" id="cc-rfp-feed" style="padding:0;display:flex;flex-direction:column;overflow:hidden;flex:1 1 0;min-height:0;">
            <div style="padding:12px 14px 8px;font-size:13px;font-weight:700;border-bottom:1px solid var(--ies-gray-100);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
              RFP Signals
              <span style="font-size:10px;color:var(--ies-gray-400);font-weight:500;">${d.rfpSignals.length} active</span>
            </div>
            <div style="overflow-y:auto;flex:1;min-height:0;">
              ${renderRfpFeed(d.rfpSignals)}
            </div>
          </div>

          ${renderToolShortcuts()}
        </div>
      </div>
    </div>
  `;

  bindEvents();
}

/**
 * Vital Sign tile — KPI value + delta badge + inline sparkline.
 * Entire tile is an <a> linking to the Market Explorer drill-down for that
 * series; a small ↗ icon in the corner signals the affordance, and a
 * hover tooltip shows min/max + period.
 */
function vitalSignTile(label, value, unit, trend, color, change, sparkData, href, periodLabel) {
  const trendArrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
  const trendColor = trend === 'up' ? 'var(--ies-red)' : trend === 'down' ? 'var(--ies-green)' : 'var(--ies-gray-500)';
  // For RFP Signals (and other "more is good") we don't want red on uptick.
  const isCountKpi = unit === 'active';
  const finalTrendColor = isCountKpi
    ? (trend === 'up' ? 'var(--ies-green)' : trend === 'down' ? 'var(--ies-red)' : 'var(--ies-gray-500)')
    : trendColor;

  // Tooltip content — min/max + period for this KPI's sparkline data.
  let tipText = '';
  if (Array.isArray(sparkData) && sparkData.length >= 2) {
    const min = Math.min(...sparkData);
    const max = Math.max(...sparkData);
    const first = sparkData[0];
    const last = sparkData[sparkData.length - 1];
    const pct = first > 0 ? ((last - first) / first) * 100 : 0;
    const fmt = (n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));
    tipText = `${periodLabel || ''}: ${fmt(min)}–${fmt(max)}${pct ? ` · ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}`;
  }

  return `
    <a class="hub-card cc-kpi-tile" href="#${href || 'marketmap'}" data-kpi-tile="1" style="padding:12px 14px;display:flex;flex-direction:column;gap:6px;cursor:pointer;position:relative;text-decoration:none;color:inherit;transition:transform .12s ease, box-shadow .12s ease, border-color .12s ease;">
      <div style="position:absolute;top:8px;right:10px;color:var(--ies-gray-300);font-size:10px;pointer-events:none;">↗</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding-right:14px;">
        <span class="hub-kpi-tile__label" style="min-height:0;">${label}</span>
        <span style="font-size:11px;font-weight:800;color:${finalTrendColor};">${trendArrow}</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:4px;">
        <span style="font-size:22px;font-weight:800;color:${color};line-height:1;">${value}</span>
        ${unit ? `<span class="u-cap u-muted">${unit}</span>` : ''}
      </div>
      ${renderSparkline(sparkData, color)}
      <div style="font-size:10px;color:var(--ies-gray-500);margin-top:2px;">${change}</div>
      ${tipText ? `<div class="cc-kpi-tooltip" style="position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--ies-navy);color:#fff;padding:6px 10px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .15s ease;z-index:10;">${tipText}</div>` : ''}
    </a>
  `;
}

/** Inline SVG sparkline. Returns an empty string if no data. */
function renderSparkline(data, color) {
  if (!Array.isArray(data) || data.length < 2) return '';
  const w = 140, h = 28, pad = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // Fill polygon below the line.
  const fillPts = `${pad},${h - pad} ${pts} ${pad + (data.length - 1) * stepX},${h - pad}`;
  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:28px;display:block;" preserveAspectRatio="none">
      <polygon points="${fillPts}" fill="${color}" fill-opacity="0.10"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
  `;
}

/** Short stage labels for the snapshot's mini-bar, keyed by DOS stage number
 *  (abbreviations only — names + colors come from the canonical DOS_STAGES). */
const CC_STAGE_SHORT = { 1: 'Pre-Sales', 2: 'Qual', 3: 'Design', 4: 'Ops', 5: 'Exec', 6: 'Handover' };

/**
 * Pipeline Snapshot — active deal count + pipeline $ (est-badged when any
 * active deal's revenue is estimated) + total sites + grade distribution +
 * ★ coverage + stage distribution mini-bar. Static card inside an <a>: no
 * listeners, so bind-once delegation in bindEvents() is untouched.
 */
function renderPipelineSnapshot(p) {
  if (!p) return '';
  const totalDeals = p.activeDeals || 0;
  const stageNames = DOS_STAGES.map(s => CC_STAGE_SHORT[s.number] || s.name);
  const stageColors = DOS_STAGES.map(s => s.color);
  const counts = p.stageCounts || [];

  // Repo-standard amber est pill — Pipeline $ includes estimated revenue
  // (display-must-match-mechanism: badge what feeds the roll-up).
  const estPill = p.anyEstimate
    ? `<span title="Includes Σ★ roll-ups with partial coverage or heuristic pricing" style="font-size:10px;font-weight:700;color:var(--c-warn-deep);background:var(--c-warn-bg);border-radius:8px;padding:1px 6px;vertical-align:middle;margin-left:6px;">est</span>`
    : '';

  // Compact grade distribution — letter + count chips, one row. Letter color
  // mirrors the DM rule: A-grades success-green, everything else info-blue.
  const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'];
  const gc = p.gradeCounts || {};
  const gradeKeys = GRADE_ORDER.filter(g => Number(gc[g]) > 0)
    .concat(Object.keys(gc).filter(g => !GRADE_ORDER.includes(g) && Number(gc[g]) > 0).sort());
  const gradeChips = gradeKeys.map(g => `
    <span style="display:inline-flex;align-items:baseline;gap:2px;white-space:nowrap;">
      <span style="font-size:13px;font-weight:800;color:${g.startsWith('A') ? 'var(--c-success)' : 'var(--c-info)'};">${escapeHtml(g)}</span>
      <span style="font-size:11px;font-weight:700;color:var(--ies-gray-500);">×${Number(gc[g])}</span>
    </span>`).join('');

  // ★ coverage — deals whose every active site carries a ★ scenario.
  const cov = p.starCoverage;
  const covChip = cov && Number(cov.total) > 0
    ? `<span title="Deals where every active site has a starred design" style="font-size:11px;font-weight:700;color:var(--ies-gray-500);white-space:nowrap;flex-shrink:0;"><span style="color:var(--c-warn-strong);">★</span> ${Number(cov.covered) || 0}/${Number(cov.total)} deals fully covered</span>`
    : '';
  const detailRow = (gradeChips || covChip)
    ? `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0;">
        <span style="display:inline-flex;align-items:baseline;gap:10px;overflow:hidden;white-space:nowrap;">
          ${gradeChips ? `<span class="hub-kpi-tile__label" style="min-height:0;">Scores</span>${gradeChips}` : ''}
        </span>
        ${covChip}
      </div>`
    : '';

  return `
    <a href="#deals" class="hub-card" style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;text-decoration:none;color:inherit;cursor:pointer;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div class="u-13 u-bold">Pipeline Snapshot</div>
        <span style="font-size:11px;color:var(--c-info);font-weight:700;">Open Deal Mgmt →</span>
      </div>
      <div style="display:flex;gap:18px;align-items:flex-start;">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span class="hub-kpi-tile__label" style="min-height:0;">Active deals</span>
          <span class="hub-kpi-tile__value" style="font-size:24px;">${totalDeals}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span class="hub-kpi-tile__label" style="min-height:0;">Pipeline</span>
          <span class="hub-kpi-tile__value" style="font-size:20px;">$${(p.totalRevenue / 1e6).toFixed(0)}M${estPill}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span class="hub-kpi-tile__label" style="min-height:0;">Avg margin</span>
          <span class="hub-kpi-tile__value" style="font-size:20px;">${(p.avgMargin || 0).toFixed(1)}%</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span class="hub-kpi-tile__label" style="min-height:0;">Sites</span>
          <span class="hub-kpi-tile__value" style="font-size:20px;">${Number(p.totalSites) || 0}</span>
        </div>
      </div>
      ${detailRow}
      <div>
        <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--ies-gray-100);">
          ${counts.map((n, i) => n > 0 ? `<div style="flex:${n};background:${stageColors[i]};" title="${escapeHtml(DOS_STAGES[i]?.name || stageNames[i] || '')}: ${n}"></div>` : '').join('')}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9px;color:var(--ies-gray-400);font-weight:600;">
          ${stageNames.map((n, i) => `<span title="${escapeHtml(DOS_STAGES[i]?.name || n)}: ${counts[i] || 0}">${escapeHtml(n)}</span>`).join('')}
        </div>
      </div>
    </a>
  `;
}

/**
 * Win / Loss Calibration — the read surface for deal_outcomes (S3-P1).
 * KPI row (win rate + W-L-withdrawn counts), top loss reasons, top
 * competitors, and the 5 most recent outcomes. Every DB string is escaped
 * with escapeHtml — this panel class had a stored-XSS finding in the RFP
 * feed, so no interpolated deal/reason/competitor text goes in raw.
 * Static display card: no listeners, so the bind-once delegation in
 * bindEvents() is untouched.
 * @param {Object|null} wl — api.fetchWinLossCalibration() result
 */
function renderWinLossCard(wl) {
  if (!wl) return '';

  // P2-a (2026-07-23): the submit side of the loop is now visible. When bids
  // have been submitted (deal_bid_snapshots rows) but no outcomes exist yet,
  // the card counts them instead of claiming nothing has happened.
  const bids = Number(wl.bidsSubmitted) || 0;

  const header = `
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div class="u-13 u-bold">Win / Loss Calibration</div>
      <span style="font-size:11px;color:var(--ies-gray-400);font-weight:600;">${!wl.total && bids > 0
        ? `${bids} bid${bids === 1 ? '' : 's'} submitted · ${wl.total} outcome${wl.total === 1 ? '' : 's'} recorded`
        : `${wl.total} outcome${wl.total === 1 ? '' : 's'}`}</span>
    </div>`;

  if (!wl.total) {
    return `
    <div class="hub-card" style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
      ${header}
      <div style="font-size:13px;color:var(--ies-gray-500);line-height:1.5;">${bids > 0
        ? `${bids} bid${bids === 1 ? '' : 's'} submitted — awaiting outcomes. Close a deal Won/Lost to complete the loop.`
        : 'No outcomes recorded yet — close a deal Won/Lost to start the calibration loop.'}</div>
    </div>`;
  }

  // Outcome chip — green won / red lost / gray withdrawn+no_decision.
  const outcomeChip = (outcome) => {
    const o = String(outcome || '').toLowerCase();
    const cfg = o === 'won'
      ? { bg: 'var(--c-success-bg)', fg: 'var(--c-success-ink)', label: 'WON' }
      : o === 'lost'
        ? { bg: 'var(--c-danger-bg)', fg: 'var(--c-danger-ink)', label: 'LOST' }
        : { bg: 'var(--ies-gray-100)', fg: 'var(--ies-gray-600)', label: o === 'no_decision' ? 'NO DEC' : 'W/D' };
    return `<span style="font-size:10px;font-weight:800;padding:2px 7px;border-radius:3px;background:${cfg.bg};color:${cfg.fg};letter-spacing:.04em;white-space:nowrap;flex-shrink:0;">${cfg.label}</span>`;
  };

  const fmtDate = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
    catch { return ''; }
  };

  const compactRows = (title, rows) => {
    if (!rows.length) return '';
    return `
      <div style="min-width:0;flex:1;">
        <div style="font-size:10px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">${title}</div>
        ${rows.map(r => `
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:2px 0;min-width:0;">
            <span style="font-size:13px;color:var(--ies-gray-600);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.label)}</span>
            <span style="font-size:11px;font-weight:700;color:var(--ies-gray-500);flex-shrink:0;">×${r.n}</span>
          </div>`).join('')}
      </div>`;
  };

  const lossReasonRows = (wl.topLossReasons || []).map(r => ({ label: r.reason, n: r.n }));
  const competitorRows = (wl.topCompetitors || []).map(r => ({ label: r.competitor, n: r.n }));
  const midSection = (lossReasonRows.length || competitorRows.length)
    ? `<div style="display:flex;gap:14px;border-top:1px solid var(--ies-gray-100);padding-top:8px;">
        ${compactRows('Top loss reasons', lossReasonRows)}
        ${compactRows('Top competitors', competitorRows)}
      </div>`
    : '';

  const recentList = (wl.recent || []).map(r => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;min-width:0;">
      ${outcomeChip(r.outcome)}
      <span style="font-size:13px;font-weight:600;color:var(--ies-gray-700);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${escapeHtml(r.deal_name || 'Unknown deal')}</span>
      ${r.reason || r.competitor
        ? `<span style="font-size:11px;color:var(--ies-gray-500);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${escapeHtml([r.reason, r.competitor].filter(Boolean).join(' — '))}</span>`
        : ''}
      <span style="font-size:10px;color:var(--ies-gray-400);white-space:nowrap;flex-shrink:0;margin-left:auto;">${escapeHtml(fmtDate(r.created_at))}</span>
    </div>`).join('');

  return `
    <div class="hub-card" style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
      ${header}
      <div style="display:flex;gap:18px;align-items:flex-start;">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span class="hub-kpi-tile__label" style="min-height:0;">Win rate</span>
          <span class="hub-kpi-tile__value" style="font-size:24px;color:${wl.winRatePct >= 50 ? 'var(--c-success)' : 'var(--c-danger)'};">${wl.winRatePct}%</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span class="hub-kpi-tile__label" style="min-height:0;">W · L · W/D</span>
          <span class="hub-kpi-tile__value" style="font-size:20px;">
            <span style="color:var(--c-success);">${wl.wins}</span><span style="color:var(--ies-gray-300);"> · </span><span style="color:var(--c-danger);">${wl.losses}</span><span style="color:var(--ies-gray-300);"> · </span><span style="color:var(--ies-gray-500);">${wl.withdrawn}</span>
          </span>
        </div>
      </div>
      ${midSection}
      ${recentList ? `
      <div style="border-top:1px solid var(--ies-gray-100);padding-top:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">Recent outcomes</div>
        ${recentList}
      </div>` : ''}
    </div>
  `;
}

/** Tool Shortcuts — quick-launch into the most-used Design Tools. */
function renderToolShortcuts() {
  const tools = [
    { route: 'designtools/cost-model',       label: 'Cost Model Builder',         color: 'var(--ies-orange)' },
    { route: 'designtools/warehouse-sizing', label: 'Warehouse Sizing',           color: 'var(--ies-blue)' },
    { route: 'designtools/fleet-modeler',    label: 'Fleet Modeler',              color: 'var(--ies-teal)' },
  ];
  return `
    <div class="hub-card" style="padding:14px 16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;">Tool Shortcuts</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        ${tools.map(t => `
          <a href="#${t.route}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--ies-gray-50);text-decoration:none;color:inherit;cursor:pointer;font-size:12px;font-weight:600;color:var(--ies-gray-700);" onmouseover="this.style.background='var(--ies-gray-100)'" onmouseout="this.style.background='var(--ies-gray-50)'">
            <span style="width:6px;height:24px;border-radius:2px;background:${t.color};flex-shrink:0;"></span>
            ${t.label}
          </a>
        `).join('')}
      </div>
    </div>
  `;
}

function bindEvents() {
  // P3-1 listener stacking (2026-07-03): render() runs on mount AND on the
  // 5-minute auto-refresh interval AND on manual refresh — without a guard
  // this stacked one click + one keydown listener on rootEl per refresh
  // (288+ after a day-long session). Bind exactly once per mounted node;
  // the router hands us a fresh outlet node each mount, so the flag
  // resets naturally on remount.
  if (!rootEl || rootEl.__ccBound) return;
  rootEl.__ccBound = true;

  // Use event delegation for all clicks
  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Refresh button
    if (target.closest('[data-action="refresh"]')) {
      refreshNow();
      return;
    }

    // Top-alert headline click should open the article and NOT bubble up to
    // the banner's "show alerts" handler.
    if (target.closest('[data-stop-banner]')) {
      e.stopPropagation();
      return;
    }

    // Alert banner click → switch Signal Stream to Alerts tab + scroll into view
    if (target.closest('[data-action="show-alerts"]')) {
      switchIntelTab('alerts');
      const stream = rootEl.querySelector('#cc-signal-stream');
      if (stream) stream.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    // Intelligence Feed tab switch
    const intelTab = target.closest('[data-intel-tab]');
    if (intelTab) {
      switchIntelTab(/** @type {HTMLElement} */ (intelTab).dataset.intelTab);
      return;
    }
  });

  // Banner keyboard activation (Enter/Space when focused) for accessibility.
  rootEl.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('[data-action="show-alerts"]') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      switchIntelTab('alerts');
      const stream = rootEl.querySelector('#cc-signal-stream');
      if (stream) stream.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

/** Switch the Signal Stream's active category tab and re-render its body. */
function switchIntelTab(key) {
  if (!rootEl || !liveData) return;
  const tabs = rootEl.querySelectorAll('[data-intel-tab]');
  tabs.forEach(t => {
    const active = t.dataset.intelTab === key;
    t.classList.toggle('active', active);
    // 2026-04-29 polish: visual state lives entirely on .cc-intel-tab.active CSS rule;
    // strip the inline-style mutation that used to duplicate the rule values.
  });
  const body = rootEl.querySelector('#cc-intel-body');
  if (body && liveData.intel) {
    const items = liveData.intel[key] || [];
    body.innerHTML = renderIntelFeed(items, liveData.activity);
  }
}

async function refreshNow() {
  if (!rootEl) return;
  liveData = await api.fetchDashboardData();
  render();
}

// ===== COMPONENT HELPERS =====

function activityItem(title, desc, time, color) {
  return `
    <div style="display:flex;align-items:start;gap:10px;padding:8px 0;border-bottom:1px solid var(--ies-gray-100);">
      <span style="width:8px;height:8px;border-radius:50%;background:${color};margin-top:5px;flex-shrink:0;"></span>
      <div style="flex:1;">
        <div class="u-13 u-semibold">${title}</div>
        <div class="u-cap u-faint">${desc}</div>
      </div>
      <span style="font-size:11px;color:var(--ies-gray-300);white-space:nowrap;">${time}</span>
    </div>
  `;
}

/** Map an intel tab key to its display label. */
function labelForIntelTab(k) {
  return ({ all: 'All', competitor: 'Competitor', accounts: 'Accounts', tariff: 'Tariff', rfp: 'RFP' })[k] || k;
}

/**
 * Render the intelligence feed list. If there are no live items, falls back
 * to the curated activity stream.
 * @param {Array} items
 * @param {Array} fallbackActivity
 */
/** r4 walk fix (2026-07-10): ingested titles/details carry HTML entities
 *  (&nbsp;, &amp;, &#39; ...) from source feeds; escapeText re-escaped the
 *  ampersand so items rendered literal '&nbsp;'. Decode BEFORE escaping. */
function decodeFeedEntities(str) {
  return String(str ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 8 && c < 1114112 ? String.fromCodePoint(c) : m; })
    .replace(/&quot;/gi, '"').replace(/&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function renderIntelFeed(items, fallbackActivity) {
  if (!items || !items.length) {
    // 2026-06-10 (assessment hub #11): the fallback stream is curated sample
    // content — label it so it can't be mistaken for live activity.
    return `<div style="display:inline-flex;align-items:center;gap:6px;background:var(--c-warn-bg);color:var(--c-warn-ink);padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;margin-bottom:8px;">SAMPLE DATA — no live intelligence yet</div>`
      + (fallbackActivity || []).map(a => activityItem(a.title, a.description, a.time, a.color)).join('');
  }
  // Bare-domain guard — ingest pipeline sometimes stores the publisher home
  // page when it can't resolve the article URL. Only treat real article
  // paths as clickable to avoid sending users to a generic homepage.
  const isRealLink = (url) => {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.pathname && u.pathname !== '/' && u.pathname.length > 1;
    } catch { return false; }
  };
  // 2026-04-22 — when the ingest pipeline fails to populate source_url for a
  // news-style alert (Apr 20+ regression on hub_alerts), fall back to a Google
  // News search link so Brock can still click through to the article. Internal
  // pipeline items (stage reminders, deal deadlines) stay unlinked — a search
  // link for "NYC Micro-Fulfillment Center — exec review OVERDUE" would leak
  // internal content and isn't useful.
  const INTERNAL_PATTERNS = /\b(OVERDUE|exec.?review|ops.?review|(review|stage),?\s+due|TODAY|TODAY\b|\bstage\b|(\d+\s+days\s+away))/i;
  const looksInternal = (item) => {
    if ((item.source || '').toLowerCase().includes('ies pipeline')) return true;
    if (INTERNAL_PATTERNS.test(item.title || '')) return true;
    return false;
  };
  const googleNewsSearch = (title) => {
    // Strip trailing " — detail" so the query focuses on the headline noun
    const clean = String(title || '').split(/\s[—–-]\s/)[0].trim();
    if (!clean) return '';
    return `https://www.google.com/search?tbm=nws&q=${encodeURIComponent(clean)}`;
  };
  return items.slice(0, 25).map(item => {
    let href = isRealLink(item.source_url) ? safeHttpUrl(item.source_url) : '';
    let isFallback = false;
    if (!href && !looksInternal(item)) {
      href = googleNewsSearch(item.title);
      isFallback = !!href;
    }
    const clickable = !!href;
    const openTag = clickable
      ? `<a href="${href}" target="_blank" rel="noopener" style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--ies-gray-100);text-decoration:none;color:inherit;cursor:pointer;" onmouseover="this.style.background='var(--ies-gray-50)'" onmouseout="this.style.background='transparent'">`
      : `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--ies-gray-100);">`;
    const closeTag = clickable ? `</a>` : `</div>`;
    const linkIcon = clickable
      ? (isFallback
          ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-left:4px;"><title>Search for article (ingest missing URL)</title><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`
          : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-left:4px;"><title>Open article in new tab</title><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`)
      : '';
    const sourceLabel = item.source
      ? `<span style="font-size:10px;color:var(--ies-gray-400);margin-left:6px;">· ${escapeText(item.source)}</span>`
      : '';
    return `
      ${openTag}
        <span style="width:8px;height:8px;border-radius:50%;background:${severityDot(item.severity)};margin-top:5px;flex-shrink:0;"></span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
            <span style="font-size:11px;font-weight:800;color:${categoryColor(item.category)};text-transform:uppercase;letter-spacing:.04em;">${escapeText(item.category || '')}</span>
            <span style="font-size:13px;font-weight:600;color:${clickable ? 'var(--c-info-strong)' : 'var(--ies-gray-800)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeText(decodeFeedEntities(item.title))}</span>
            ${linkIcon}
          </div>
          ${item.detail ? `<div style="font-size:11px;color:var(--ies-gray-500);line-height:1.4;">${escapeText(decodeFeedEntities(item.detail)).slice(0, 180)}${sourceLabel}</div>` : (sourceLabel ? `<div style="font-size:11px;color:var(--ies-gray-500);line-height:1.4;">${sourceLabel}</div>` : '')}
        </div>
        <span style="font-size:10px;color:var(--ies-gray-400);white-space:nowrap;flex-shrink:0;">${item.relDate || ''}</span>
      ${closeTag}
    `;
  }).join('');
}

function categoryColor(cat) {
  return ({ Competitor: '#7c3aed', Accounts: '#0891b2', Tariff: '#d97706', RFP: '#16a34a' })[cat] || '#6b7280';
}

function escapeText(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Render the inline alert summary banner at the top of the page.
 * Aggregates by severity into a single strip with "X critical · Y high · Z medium".
 * @param {Array} alerts
 */
function renderInlineAlertBanner(alerts) {
  if (!alerts || !alerts.length) {
    return `<div style="margin:0 0 16px;padding:8px 14px;border-radius:8px;background:var(--c-success-soft);border:1px solid #86efac;color:var(--c-success-ink);font-size:12px;font-weight:600;display:flex;align-items:center;gap:10px;">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--c-success);color:#fff;font-weight:800;">✓</span>
      No active market alerts.
    </div>`;
  }
  const counts = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const a of alerts) {
    const s = (a.severity || 'info').toLowerCase();
    const bucket = s === 'critical' ? 'critical' : s === 'high' ? 'high' : (s === 'medium' || s === 'warning') ? 'medium' : 'info';
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  const hasCritical = counts.critical > 0;
  const bg = hasCritical ? '#fef2f2' : counts.high > 0 ? '#fff7ed' : '#eff6ff';
  const border = hasCritical ? '#fecaca' : counts.high > 0 ? '#fed7aa' : '#bfdbfe';
  const text = hasCritical ? '#991b1b' : counts.high > 0 ? '#9a3412' : '#1e40af';
  const parts = [];
  if (counts.critical) parts.push(`<strong>${counts.critical}</strong> critical`);
  if (counts.high) parts.push(`<strong>${counts.high}</strong> high`);
  if (counts.medium) parts.push(`<strong>${counts.medium}</strong> medium`);
  if (counts.info) parts.push(`<strong>${counts.info}</strong> info`);
  const summary = parts.join(' &middot; ');
  const top = alerts.slice(0, 1)[0];
  // 2026-04-22 — same fallback pattern as renderIntelFeed: if source_url is
  // missing and the alert isn't an internal pipeline reminder, link to Google
  // News search on the headline. Keeps the banner actionable when ingest
  // fails to populate URLs.
  const topInternal = top && (
    /ies pipeline/i.test(top.source || '') ||
    /\b(OVERDUE|exec.?review|ops.?review|(review|stage),?\s+due|TODAY|\bstage\b)/i.test(top.title || '')
  );
  let topUrl = top && top.source_url && top.source_url.length > 'https://'.length ? safeHttpUrl(top.source_url) : '';
  if (!topUrl && top && !topInternal && top.title) {
    const clean = String(top.title).split(/\s[—–-]\s/)[0].trim();
    if (clean) topUrl = `https://www.google.com/search?tbm=nws&q=${encodeURIComponent(clean)}`;
  }
  return `<div class="cc-alert-banner" data-action="show-alerts" role="button" tabindex="0" style="margin:0 0 16px;padding:10px 14px;border-radius:8px;background:${bg};border:1px solid ${border};color:${text};font-size:12px;font-weight:600;display:flex;align-items:center;gap:14px;">
    <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${hasCritical ? 'var(--c-danger)' : counts.high > 0 ? '#ea580c' : 'var(--c-info)'};color:#fff;font-weight:800;flex-shrink:0;">!</span>
    <span style="flex-shrink:0;">${alerts.length} active alert${alerts.length === 1 ? '' : 's'}</span>
    <span style="color:${text};opacity:.8;flex-shrink:0;">${summary}</span>
    ${top ? `<span style="margin-left:auto;color:${text};opacity:.9;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px;">Top:
      ${topUrl
        ? `<a href="${topUrl}" target="_blank" rel="noopener" data-stop-banner="1" style="color:${text};text-decoration:underline;font-weight:700;">${escapeText(top.title)} ↗</a>`
        : `<strong>${escapeText(top.title)}</strong>`} &middot; ${top.date || ''}</span>` : ''}
    <span style="font-size:10px;color:${text};opacity:.6;flex-shrink:0;">View all →</span>
  </div>`;
}

function severityDot(severity) {
  return { critical: '#dc2626', high: '#ea580c', warning: '#d97706', medium: '#d97706', info: '#2563eb', low: '#16a34a' }[severity] || '#9ca3af';
}

function renderRfpFeed(rfpSignals) {
  if (!rfpSignals || rfpSignals.length === 0) {
    return '<div style="padding:16px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No RFP signals available</div>';
  }
  // Color a signal_type chip based on its theme so the eye can scan categories.
  const signalColor = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('expansion') || t.includes('facility')) return { bg: 'rgba(22,163,74,.10)', fg: '#16a34a' };  // green — growth
    if (t.includes('leadership') || t.includes('change')) return { bg: 'rgba(37,99,235,.10)', fg: '#2563eb' };   // blue — people
    if (t.includes('cost') || t.includes('restructuring') || t.includes('10-k')) return { bg: 'rgba(217,119,6,.10)', fg: '#d97706' }; // amber — financial
    if (t.includes('m&a') || t.includes('acquisition')) return { bg: 'rgba(124,58,237,.10)', fg: '#7c3aed' };    // purple — M&A
    return { bg: 'rgba(107,114,128,.10)', fg: '#6b7280' };
  };
  const confidenceDots = (n) => {
    const filled = Math.max(0, Math.min(5, n || 0));
    const dots = [];
    for (let i = 0; i < 5; i++) {
      dots.push(`<span style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:2px;background:${i < filled ? 'var(--c-success)' : '#e5e7eb'};"></span>`);
    }
    return dots.join('');
  };

  return rfpSignals.map(rfp => {
    const sc = signalColor(rfp.signal);
    return `
    <div style="display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-bottom:1px solid var(--ies-gray-100);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
          <span style="font-size:13px;font-weight:700;color:var(--ies-gray-700);white-space:nowrap;">${rfp.company}</span>
          <span style="font-size:10px;color:var(--ies-gray-400);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rfp.vertical}</span>
        </div>
        <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:${sc.bg};color:${sc.fg};text-transform:uppercase;letter-spacing:0.3px;white-space:nowrap;flex-shrink:0;">${rfp.signal}</span>
      </div>
      ${rfp.detail ? `<div style="font-size:12px;color:var(--ies-gray-600);line-height:1.4;">${rfp.detail}</div>` : ''}
      <div style="display:flex;align-items:center;gap:12px;font-size:10px;color:var(--ies-gray-400);">
        ${rfp.timeline ? `<span>⏱ ${rfp.timeline}</span>` : ''}
        <span style="display:inline-flex;align-items:center;gap:4px;">Confidence ${confidenceDots(rfp.confidence)}</span>
        <span style="margin-left:auto;">${rfp.date}</span>
      </div>
    </div>`;
  }).join('');
}

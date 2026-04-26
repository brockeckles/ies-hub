/**
 * IES Hub v3 — Cost Model Builder UI
 * Builder-pattern layout: 220px sidebar nav + fluid content area.
 * Each section renders from state via template literals + innerHTML.
 *
 * @module tools/cost-model/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sK';
import { state } from '../../shared/state.js?v=20260418-sK';
import { downloadXLSX } from '../../shared/export.js?v=20260419-tC';
import { showToast } from '../../shared/toast.js?v=20260419-uC';
import { auth } from '../../shared/auth.js?v=20260424-hyg04';
import * as calc from './calc.js?v=20260426-s10';
import * as api from './api.js?v=20260426-s11';
import * as scenarios from './calc.scenarios.js?v=20260421-wA';
import * as monthlyCalc from './calc.monthly.js?v=20260422-xU';
import * as planningRatios from '../../shared/planning-ratios.js?v=20260421-wX';
import * as shiftPlannerCalc from './shift-planner.js?v=20260422-xX';
import * as shiftPlannerUi from './shift-planner-ui.js?v=20260422-xY';
// shift-archetypes module removed 2026-04-22 EVE along with the throughput-
// matrix archetype picker. Grid now seeds Even by default. File retained on
// disk but no longer imported; can be deleted in a future cleanup.

// ============================================================
// Non-blocking modal helpers (replace confirm/prompt/alert).
// Native dialogs freeze under the Claude-in-Chrome extension and are
// generally poor UX in SPAs; these return Promises the caller can await.
// ============================================================

/**
 * Show a non-blocking confirm modal. Resolves to true/false.
 * @param {string} message  prompt text (supports \n line breaks)
 * @param {{ okLabel?: string, cancelLabel?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
function showConfirm(message, opts = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hub-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
    const okBg = opts.danger ? '#dc2626' : 'var(--ies-blue-600)';
    overlay.innerHTML = `
      <div style="background:white;border-radius: 10px;padding:24px;min-width:420px;max-width:90vw;">
        <div style="white-space:pre-line;font-size:14px;line-height:1.45;">${String(message).replace(/</g, '&lt;')}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="hub-btn" data-ans="0">${opts.cancelLabel || 'Cancel'}</button>
          <button class="hub-btn-primary" data-ans="1" style="${opts.danger ? `background:${okBg};` : ''}">${opts.okLabel || 'Confirm'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-ans="0"]')?.addEventListener('click', () => done(false));
    overlay.querySelector('[data-ans="1"]')?.addEventListener('click', () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(false); }
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); done(true); }
    });
  });
}

/**
 * Show a non-blocking prompt modal. Resolves to the string value or null
 * if cancelled.
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string|null>}
 */
function showPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hub-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
      <div style="background:white;border-radius: 10px;padding:24px;min-width:480px;max-width:90vw;">
        <div style="white-space:pre-line;font-size:14px;line-height:1.45;margin-bottom:10px;">${String(message).replace(/</g, '&lt;')}</div>
        <input class="hub-input" data-prompt-input style="width:100%;font-size:14px;padding:6px 8px;" value="${String(defaultValue).replace(/"/g, '&quot;')}" />
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="hub-btn" data-ans="cancel">Cancel</button>
          <button class="hub-btn-primary" data-ans="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('[data-prompt-input]');
    setTimeout(() => input?.focus(), 20);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-ans="cancel"]')?.addEventListener('click', () => done(null));
    overlay.querySelector('[data-ans="ok"]')?.addEventListener('click', () => done(input?.value ?? ''));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(null); }
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); done(input?.value ?? ''); }
    });
  });
}

// ============================================================
// STATE — tool-local reactive state
// ============================================================

/** @type {import('./types.js?v=20260418-sK').CostModelData} */
let model = createEmptyModel();

/**
 * Seasonality profile presets (Brock 2026-04-22 PM). Each is a 12-element
 * array of monthly shares summing to 1.000. Used by the Seasonality Profile
 * card in Volumes & Profile. User-hand-edited shares flip preset to 'custom'.
 */
const SEASONALITY_PRESETS = {
  // Mirrors DEFAULT_FLAT_SEASONALITY in calc.js — 11 × 0.0833 + 1 × 0.0837 ≈ 1.000
  flat:              [0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0833, 0.0837],
  // Home-goods / big-box e-com: ~35% of volume lands in Q4, summer ramp Aug-Sep
  ecom_holiday_peak: [0.070, 0.068, 0.072, 0.070, 0.072, 0.070, 0.080, 0.080, 0.084, 0.100, 0.120, 0.114],
  // Cold-chain food: concentrated Thanksgiving + Christmas spikes; shoulders otherwise flat
  cold_chain_food:   [0.076, 0.076, 0.080, 0.080, 0.080, 0.080, 0.080, 0.080, 0.080, 0.080, 0.110, 0.098],
  // Apparel: two peaks — spring (Mar-Apr) + fall (Sep-Nov), quieter summer
  apparel_2peak:     [0.072, 0.066, 0.094, 0.098, 0.080, 0.072, 0.070, 0.080, 0.094, 0.092, 0.104, 0.078],
};
const SEASONALITY_PRESET_LABELS = {
  flat: 'Flat',
  ecom_holiday_peak: 'E-com Holiday Peak',
  cold_chain_food: 'Cold Chain Food',
  apparel_2peak: 'Apparel 2-Peak',
  custom: 'Custom',
};
/** Debounce timer for the seasonality per-month input re-render. */
let _seasonalityRerenderTimer = null;

/** @type {Object} */
let refData = {};

/** @type {string} */
let activeSection = 'setup';

/** @type {HTMLElement|null} */
let rootEl = null;

/** @type {boolean} */
let isDirty = false;

/** @type {string|null} ISO timestamp of the last successful save, OR the loaded model's updated_at. */
let lastSavedAt = null;
/** @type {string|null} Email of the user who performed the last save in this session. Null on fresh load. */
let lastSavedBy = null;

/**
 * CM-PROV-1 — Cell-level formula inspector context.
 * Stashed by renderSummary() each time it runs so the provenance panel can
 * rebuild its content without re-running buildYearlyProjections. Holds the
 * inputs needed to explain any P&L cell (escalation rates, base costs,
 * orders, calc heuristics).
 * @type {null | {
 *   projections: any[],
 *   summary: any,
 *   calcHeur: any,
 *   marginFrac: number,
 *   contractYears: number,
 *   baseOrders: number,
 *   computedAt: string,
 * }}
 */
let _lastProvenanceContext = null;
/** @type {{rowKey:string, year:number}|null} Tracks which cell the panel is currently explaining. */
let _activeProvCell = null;

/** @type {boolean} Track whether user has interacted — suppresses validation on fresh model */
let userHasInteracted = false;

/** @type {'landing' | 'editor'} Landing page (saved models) vs editor (builder). */
let viewMode = 'landing';

/** @type {Array<{id:number,name:string,client_name:string,market_id:string|null,updated_at:string}>} */
let savedModels = [];

/** @type {Array<{id:string,deal_name:string,client_name:string|null}>} */
let savedDeals = [];

// ============================================================
// DEMO FALLBACK DATA — used when Supabase ref tables unavailable
// ============================================================

const DEMO_MARKETS_FALLBACK = [
  { market_id: 'mem', name: 'Memphis, TN' },
  { market_id: 'ind', name: 'Indianapolis, IN' },
  { market_id: 'chi', name: 'Chicago, IL' },
  { market_id: 'dal', name: 'Dallas-Fort Worth, TX' },
  { market_id: 'atl', name: 'Atlanta, GA' },
  { market_id: 'lax', name: 'Los Angeles, CA' },
  { market_id: 'njy', name: 'Northern NJ / NYC Metro' },
  { market_id: 'col', name: 'Columbus, OH' },
  { market_id: 'leh', name: 'Lehigh Valley, PA' },
  { market_id: 'sav', name: 'Savannah, GA' },
  { market_id: 'lou', name: 'Louisville, KY' },
  { market_id: 'pho', name: 'Phoenix, AZ' },
  { market_id: 'cin', name: 'Cincinnati, OH' },
  { market_id: 'rvs', name: 'Riverside / Inland Empire, CA' },
  { market_id: 'nas', name: 'Nashville, TN' },
  { market_id: 'hou', name: 'Houston, TX' },
  { market_id: 'kci', name: 'Kansas City, MO' },
  { market_id: 'rno', name: 'Reno, NV' },
  { market_id: 'cha', name: 'Charlotte, NC' },
  { market_id: 'sea', name: 'Seattle-Tacoma, WA' },
];

// ============================================================
// STANDARD POSITION CATALOG (Brock 2026-04-21 pm)
// Role-based seed populated on new projects + on "Replace with
// Standard Roles" action. Sourced from Cost Model Planning
// Heuristics doc §2.1 (span-driven indirect) + §2.2 (volume-driven
// indirect) + synthesized BY-WMS direct roles.
// ============================================================

/** Standard role catalog — 14 direct + 29 indirect = 43 positions. */
const STANDARD_POSITIONS = [
  // ── DIRECT (4) ── Brock 2026-04-21 pm: key delineator is whether the
  // associate operates MHE (forklift / reach truck / order picker / etc).
  // Permanent non-MHE = Material Handler; temp non-MHE = Temp Material
  // Handler. Permanent MHE = Equipment Operator; temp MHE = Equipment Operator
  // (Temp) — 4th catalog entry added 2026-04-21 PM for clean reporting.
  { name: 'Equipment Operator',        category: 'direct', is_salaried: false, hourly_wage: 22.00, notes: 'Permanent associate operating MHE (forklift / reach truck / order picker / yard jockey / etc.).' },
  { name: 'Equipment Operator (Temp)', category: 'direct', is_salaried: false, hourly_wage: 22.00, temp_markup_pct: 38, employment_type: 'temp_agency', notes: 'Temp-agency MHE operator. 38% markup on base wage per heuristics §2.3. Catalog entry is distinct from the permanent Equipment Operator for roster reporting clarity.' },
  { name: 'Material Handler',          category: 'direct', is_salaried: false, hourly_wage: 18.00, notes: 'Permanent warehouse associate — non-MHE (receive / pick / pack / load / VAS / QC / cycle count).' },
  { name: 'Temp Material Handler',     category: 'direct', is_salaried: false, hourly_wage: 18.00, temp_markup_pct: 38, employment_type: 'temp_agency', notes: 'Temp-agency warehouse associate — non-MHE. 38% markup on base wage per heuristics §2.3 (contractual wage load).' },

  // ── INDIRECT — hourly leads + front-line support (heuristics §2.1) ──
  { name: 'Team Lead',                           category: 'indirect', is_salaried: false, hourly_wage: 22.00, notes: '1 : 15 direct FTE — front-line coordination' },
  { name: 'Line Lead',                           category: 'indirect', is_salaried: false, hourly_wage: 23.00, notes: '1 : 25 direct FTE — process-area lead' },
  { name: 'Inventory Team Lead',                 category: 'indirect', is_salaried: false, hourly_wage: 23.00, notes: '1 : 25 inventory FTE' },
  { name: 'Shipping/Receiving Team Lead',        category: 'indirect', is_salaried: false, hourly_wage: 23.00, notes: '1 : 25 dock FTE' },
  { name: 'QA Coordinator',                      category: 'indirect', is_salaried: false, hourly_wage: 24.00, notes: '1 : 25 direct FTE — process-support' },
  { name: 'CSR',                                 category: 'indirect', is_salaried: false, hourly_wage: 22.00, notes: '1 : 50 direct FTE — customer service rep' },
  { name: 'Senior CSR',                          category: 'indirect', is_salaried: false, hourly_wage: 28.00, notes: '1 : 50 direct FTE — escalation / account CSR' },
  { name: 'Security Guard',                      category: 'indirect', is_salaried: false, hourly_wage: 20.00, notes: '1 : 50 direct FTE — site security' },
  { name: 'Yard Spotter',                        category: 'indirect', is_salaried: false, hourly_wage: 22.00, notes: '≥25 daily trailer moves triggers the role (§2.2)' },

  // ── INDIRECT — salaried supervisors, managers, directors ────────────
  { name: 'Operations Supervisor',               category: 'indirect', is_salaried: true,  annual_salary: 65000, notes: '1 : 25 direct FTE — first-line salaried sup.' },
  { name: 'Inventory Control Supervisor',        category: 'indirect', is_salaried: true,  annual_salary: 70000, notes: '1 : 50 inventory FTE' },
  { name: 'Inventory Manager',                   category: 'indirect', is_salaried: true,  annual_salary: 85000, notes: '1 : 50 inventory FTE' },
  { name: 'QA Supervisor',                       category: 'indirect', is_salaried: true,  annual_salary: 75000, notes: '1 : 50 direct FTE' },
  { name: 'Safety Coordinator',                  category: 'indirect', is_salaried: true,  annual_salary: 72000, notes: '1 : 50 direct FTE' },
  { name: 'Operations Manager',                  category: 'indirect', is_salaried: true,  annual_salary: 95000, notes: '1 : 75 direct FTE — mid-level ops mgmt' },
  { name: 'Admin Ops Manager',                   category: 'indirect', is_salaried: true,  annual_salary: 85000, notes: '1 : 200 direct FTE' },
  { name: 'Asst Ops Manager',                    category: 'indirect', is_salaried: true,  annual_salary: 75000, notes: '1 : 200 direct FTE' },
  { name: 'Industrial Engineer',                 category: 'indirect', is_salaried: true,  annual_salary: 82000, notes: '1 : 200 direct FTE' },
  { name: 'HR-Admin',                            category: 'indirect', is_salaried: true,  annual_salary: 58000, notes: '1 : 200 direct FTE' },
  { name: 'Maintenance Engineer/Manager',        category: 'indirect', is_salaried: true,  annual_salary: 88000, notes: '1 : 200 direct FTE' },
  { name: 'QA Manager',                          category: 'indirect', is_salaried: true,  annual_salary: 90000, notes: '1 : 200 direct FTE' },
  { name: 'Safety Manager',                      category: 'indirect', is_salaried: true,  annual_salary: 90000, notes: '1 : 200 direct FTE' },
  { name: 'Senior Ops Manager',                  category: 'indirect', is_salaried: true,  annual_salary: 120000, notes: '1 : 200 direct FTE' },
  { name: 'Software Super User',                 category: 'indirect', is_salaried: true,  annual_salary: 65000, notes: '1 : 200 direct FTE' },
  { name: 'Operations Director',                 category: 'indirect', is_salaried: true,  annual_salary: 160000, notes: '1 : 400 direct FTE — multi-site or very large single-site' },

  // ── INDIRECT — volume-driven (heuristics §2.2) ──────────────────────
  { name: 'Retail Compliance Specialist',        category: 'indirect', is_salaried: true,  annual_salary: 62000, notes: '1 : 8-10 retail customers — routing guide + dock compliance' },
  { name: 'Wave Tasker',                         category: 'indirect', is_salaried: true,  annual_salary: 52000, notes: '1 per 2-shift 8K-order/day op' },
  { name: 'WMS/LMS Field Support',               category: 'indirect', is_salaried: true,  annual_salary: 70000, notes: '1 per 150 operators' },
  { name: 'Transportation Routing',              category: 'indirect', is_salaried: true,  annual_salary: 58000, notes: '≥100 distinct carrier lanes triggers' },
];

/** Bumps when STANDARD_POSITIONS changes enough to warrant re-seeding every
 *  existing project on next load. `shifts._catalogVersion` on each model
 *  gates whether auto-migration runs (see migrateLaborLinesToPositions).
 *  v2: removed legacy activity-named fallback loop.
 *  v3 (Brock 2026-04-21 pm): collapsed direct roles from 15 → 3 (Equipment
 *  Operator, Material Handler, Temp Material Handler) per Brock's direction
 *  that the key delineator is MHE vs non-MHE. Forces re-seed on every
 *  project so catalog aligns with the simpler taxonomy.
 *  v4 (2026-04-21 later pm): added Equipment Operator (Temp) as a 4th direct
 *  role — distinct catalog entry for temp MHE operators, mirroring the
 *  Material Handler / Temp Material Handler split so roster reports can
 *  differentiate cleanly. */
const CATALOG_VERSION = 4;

/** Keyword rules mapping a free-text activity/role name onto a standard role
 *  by category. First match wins. Regex-anchored so partial tokens (pick/load)
 *  don't over-match on multi-word position names. Used by the one-time
 *  auto-migration to preserve labor-line ↔ position linkage after catalog
 *  wipe. */
const ROLE_HINT_RULES = [
  // Direct (Brock 2026-04-21 pm): the distinction is MHE vs non-MHE.
  // Anything mentioning forklift / reach truck / order picker / yard jockey /
  // MHE / lift → Equipment Operator. Everything else → Material Handler.
  // Temp-agency override happens downstream in the migration — a matched MHE
  // line with employment_type=temp_agency resolves to Equipment Operator (Temp)
  // instead. A matched non-MHE temp line resolves to Temp Material Handler.
  //
  // 2026-04-21 PM expansion: added "load trailer", "load outbound/inbound",
  // "replen to reserve/forward" and pallet-move phrases so Wayfair-shaped
  // lines auto-match correctly. These activities inherently require MHE
  // (you can't load a trailer or replen to reserve by hand).
  [/\breach[\s-]?truck|\bvna\b|turret|\bforklift|\bsit[\s-]?down|counterbalance|\border[\s-]?picker|\bcherry[\s-]?picker|\byard\s*jockey|\bjockey|trailer\s+(?:move|load|unload)|(?:load|unload)\s+(?:outbound|inbound)?\s*(?:trailer|truck)|\breplen\w*\s*(?:to|->)\s*(?:reserve|forward|pick|rack)|\bput[\s-]?away\s*(?:to|->)?\s*(?:reserve|rack|pallet)|\bmhe\b|\blift\s*(?:truck|operator)|pallet\s*(?:move|movement)|\breserve\s+replen|\bfull\s*pallet\s*(?:pick|pull)/i,
    'direct', 'Equipment Operator'],
  // Catch-all for any other direct activity — Material Handler is the generic
  // non-MHE warehouse associate (Brock's delineator).
  [/\breceiv|\bput[\s-]?away|\breplen|\bpick|\bpack|\blabel|\bload|outbound|\bship|value[\s-]?added|\bvas\b|\bkit|assembly|\bcycle|\bcount|\baudit|\bqc\b|quality|\bmaterial\s*handler|generic|\bunload|\bstock|\btransfer/i,
    'direct', 'Material Handler'],

  // Indirect — hourly leads + front-line (test BEFORE mid/senior mgr to avoid
  // "team lead" matching "manager" first)
  [/\bteam\s*lead/i,                                      'indirect', 'Team Lead'],
  [/\bline\s*lead/i,                                      'indirect', 'Line Lead'],
  [/\binventory\s*team\s*lead/i,                          'indirect', 'Inventory Team Lead'],
  [/\bship(?:ping)?[\s\/]*receiv(?:ing)?\s*team\s*lead/i, 'indirect', 'Shipping/Receiving Team Lead'],
  [/\bqa\s*coord|quality\s*coord/i,                       'indirect', 'QA Coordinator'],
  [/\bsr\.?\s*csr|\bsenior\s*csr/i,                       'indirect', 'Senior CSR'],
  [/\bcsr\b|customer\s*service/i,                         'indirect', 'CSR'],
  [/\bsecurity\s*guard|\bguard\b/i,                       'indirect', 'Security Guard'],

  // Indirect — salaried supervisors + managers
  [/\binventory\s*control\s*sup|inv\.?\s*ctrl/i,          'indirect', 'Inventory Control Supervisor'],
  [/\binventory\s*mgr|inventory\s*manager/i,              'indirect', 'Inventory Manager'],
  [/\bqa\s*sup|quality\s*sup/i,                           'indirect', 'QA Supervisor'],
  [/\bqa\s*mgr|quality\s*manager/i,                       'indirect', 'QA Manager'],
  [/\bops?\s*sup|operations?\s*sup|supervis|\bcoach/i,    'indirect', 'Operations Supervisor'],
  [/\badmin\s*ops|ops\s*admin/i,                          'indirect', 'Admin Ops Manager'],
  [/\basst\s*ops|assistant\s*ops/i,                       'indirect', 'Asst Ops Manager'],
  [/\bindustrial\s*eng|\bie\b/i,                          'indirect', 'Industrial Engineer'],
  [/\bhr\b|human\s*resources/i,                           'indirect', 'HR-Admin'],
  [/\bmaint/i,                                            'indirect', 'Maintenance Engineer/Manager'],
  [/\bsafety\s*coord/i,                                   'indirect', 'Safety Coordinator'],
  [/\bsafety\s*mgr|safety\s*manager/i,                    'indirect', 'Safety Manager'],
  [/\bsenior\s*ops|sr\.?\s*ops/i,                         'indirect', 'Senior Ops Manager'],
  [/\bsoftware\s*super|super\s*user/i,                    'indirect', 'Software Super User'],
  [/operations?\s*director|\bops?\s*director/i,           'indirect', 'Operations Director'],
  [/operations?\s*manager|\bops?\s*manager|\bmanager/i,   'indirect', 'Operations Manager'],

  // Indirect — volume-driven
  [/retail\s*compliance/i,                                'indirect', 'Retail Compliance Specialist'],
  [/wave\s*task/i,                                        'indirect', 'Wave Tasker'],
  [/wms|lms|field\s*support/i,                            'indirect', 'WMS/LMS Field Support'],
  [/transportation|routing/i,                             'indirect', 'Transportation Routing'],
  [/yard\s*spotter/i,                                     'indirect', 'Yard Spotter'],
];

/** Return the STANDARD_POSITIONS entry best matching a free-text name by
 *  keyword rule. Filters by category so a "Supervisor" direct line doesn't
 *  accidentally match an indirect position. Null if no rule matches. */
function findStandardRoleByHint(name, category) {
  const needle = String(name || '');
  if (!needle.trim()) return null;
  for (const [re, cat, roleName] of ROLE_HINT_RULES) {
    if (cat !== category) continue;
    if (re.test(needle)) {
      const hit = STANDARD_POSITIONS.find(p => p.name === roleName);
      if (hit) return hit;
    }
  }
  return null;
}

/** Normalize STANDARD_POSITIONS into the on-model shape (with id + defaults).
 *  Respects optional `employment_type` + `temp_markup_pct` on the source
 *  entry (Temp Material Handler defaults to temp_agency + 38% markup). */
function materializeStandardPositions() {
  const makeId = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'pos_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  return STANDARD_POSITIONS.map(p => ({
    id: makeId(),
    name: p.name,
    category: p.category,
    employment_type: p.employment_type || 'permanent',
    hourly_wage: p.is_salaried ? 0 : (Number(p.hourly_wage) || 0),
    annual_salary: p.is_salaried ? (Number(p.annual_salary) || 0) : 0,
    is_salaried: !!p.is_salaried,
    temp_markup_pct: Number(p.temp_markup_pct) || 0,
    bonus_pct: null,
    // Per-position Benefit Load override (blank = inherit global total)
    benefit_load_pct: null,
    notes: p.notes || '',
  }));
}

// ============================================================
// SECTIONS — 13 nav sections
// ============================================================

const SECTIONS = [
  // Scope — who, what, where
  { key: 'setup',          label: 'Setup',              icon: 'settings',      group: 'scope' },
  { key: 'volumes',        label: 'Volumes & Profile',  icon: 'bar-chart',     group: 'scope' },
  // Structure — framework to build inside (physical + commercial)
  { key: 'facility',       label: 'Facility',           icon: 'home',          group: 'structure' },
  { key: 'shifts',         label: 'Labor Factors',      icon: 'clock',         group: 'structure' },
  { key: 'pricingBuckets', label: 'Pricing Buckets',    icon: 'layers',        group: 'structure' },
  { key: 'financial',      label: 'Financial',          icon: 'trending-up',   group: 'structure' },
  // Cost — the build itself
  { key: 'labor',          label: 'Labor',              icon: 'users',         group: 'cost' },
  { key: 'shiftPlanning',  label: 'Shift Planning',     icon: 'grid',          group: 'cost' },
  { key: 'equipment',      label: 'Equipment',          icon: 'truck',         group: 'cost' },
  { key: 'overhead',       label: 'Overhead',           icon: 'layers',        group: 'cost' },
  { key: 'vas',            label: 'VAS',                icon: 'star',          group: 'cost' },
  { key: 'startup',        label: 'Start-Up',           icon: 'zap',           group: 'cost' },
  { key: 'implementation', label: 'Implementation',     icon: 'flag',          group: 'cost' },
  // Output — what the model produces
  { key: 'summary',        label: 'Summary',            icon: 'pie-chart',     group: 'output' },
  { key: 'pricing',        label: 'Pricing',            icon: 'tag',           group: 'output' },
  { key: 'timeline',       label: 'Cashflow & P&L',           icon: 'calendar',      group: 'output' },
  { key: 'scenarios',      label: 'Scenarios',          icon: 'git-branch',    group: 'output' },
  // Analysis — iterate + governance
  { key: 'whatif',         label: 'What-If Studio',     icon: 'trending-up',   group: 'analysis' },
  { key: 'assumptions',    label: 'Assumptions',        icon: 'sliders',       group: 'analysis' },
  { key: 'linked',         label: 'Linked Designs',     icon: 'link',          group: 'analysis' },
];

/**
 * v2 UI — five-phase grouping. Follows the actual build flow: scope the
 * deal → stand up the framework (facility/shifts/buckets/financial) → build
 * the cost lines INTO those buckets → see the output → analyze + iterate.
 * When flag off, sidebar renders as the flat 19-item list.
 */
const SECTION_GROUPS = [
  { key: 'scope',      label: 'Scope',       description: 'Who, what, where' },
  { key: 'structure',  label: 'Structure',   description: 'Framework: facility, shifts, pricing buckets, financial' },
  { key: 'cost',       label: 'Cost',        description: 'The build: labor, equipment, overhead, VAS, startup' },
  { key: 'output',     label: 'Output',      description: 'Summary, pricing rates, cashflow & P&L, scenarios' },
  { key: 'analysis',   label: 'Analysis',    description: 'What-If, assumptions, links' },
];

// Phase 3 module-local state
let heuristicsCatalog = [];
let heuristicOverrides = {};
let dealScenarios = [];
let currentScenario = null;
let currentScenarioSnapshots = null;   // grouped { labor:[], facility:[], ..., heuristics:[] }
let currentRevisions = [];
let _lastCalcHeuristics = null;        // set by Summary calc; read by Timeline/Summary banners
let _lastProjections = null;           // yearly projections array from the most recent Summary/Timeline run — enables the M3 banner to show Y1 ramped margin alongside reference-basis
// Position-catalog notes redesign (Brock 2026-04-26): notes used to be a sliver
// inline <input> at the end of each row. Now they live in a per-row collapsible
// sub-row holding a real <textarea>. Track which rows are expanded via id Set
// so state survives section re-renders within the same view session.
const _expandedPositionIds = new Set();
// Phase 4c — cached market labor profile (set when project's market is known)
let currentMarketLaborProfile = null;
// Re-entry guards — prevent infinite render loops when the lazy loader fires
// a post-load renderSection() that then re-triggers bindSectionEvents →
// which sees the same "not loaded yet" state and schedules ANOTHER load.
let _scenariosLoadInFlight = false;
let _scenariosLoadedOnce = false;
let _heuristicsLoadInFlight = false;
// Phase 5b — What-If Studio transient overlay (preview-only; not persisted
// until user hits Apply). Highest-priority layer in resolveCalcHeuristics.
let whatIfTransient = {};
let _whatIfDebounce = null;
// Phase 6 — Planning Ratios catalog (ref_planning_ratios + ref_heuristic_categories).
// Separate from heuristicsCatalog above; this is the richer 142-rule engineering
// defaults catalog with applicability filters + SCD.
let planningRatiosCatalog = [];
let planningRatioCategories = [];
let planningRatioOverrides = {};
let _planningRatiosLoadInFlight = false;
/** UI-only: which category card is expanded. Null = all collapsed. */
let _planningRatioOpenCategory = null;

// v2 UI redesign (2026-04-19) — feature-flagged redesign of sidebar nav +
// Labor section. Flip off via `window.COST_MODEL_V2_UI = false` in console
// to compare against the old layout.
/** Groups the user has collapsed in the grouped sidebar. */
let _collapsedNavGroups = new Set();
/** Which Direct Labor line is currently selected in the master-detail view. */
let _selectedLaborIdx = 0;

/**
 * Indirect Labor seasonal-uplift sub-totals — computed inline via an IIFE
 * inside the tbody render and read by the <tfoot> template literal a few
 * rows later. Kept module-scope so the two spots don't have to re-run the
 * reduce. Cleared on each renderLabor call.
 */
let _indirectBreakdownCache = null;

/**
 * Snapshot of the Pricing Schedule's enriched buckets at the moment the
 * section last rendered. Feeds the override-audit listener so audit rows
 * include the recommended rate the user actually saw on screen — not
 * whatever the model happens to compute later. Cleared on each renderPricing.
 * @type {{ enriched: Array, bucketCosts: Record<string,number>, ts: number } | null}
 */
let _pricingAuditSnapshot = null;

/**
 * Monthly Labor View year scope — 0 = "All years", 1..N = that specific
 * contract year. Default Y1 because the intra-year seasonality pattern
 * is the primary signal; the full contract view conflates seasonality
 * with volume growth.
 */
let _mlvViewYear = 1;

function isCmV2UiOn() {
  return typeof window === 'undefined' || window.COST_MODEL_V2_UI !== false;
}

// ============================================================
// LIFECYCLE
// ============================================================

/**
 * Mount the Cost Model Builder.
 * @param {HTMLElement} el
 */
export async function mount(el) {
  rootEl = el;
  activeSection = 'setup';
  model = createEmptyModel();
  userHasInteracted = false;
  viewMode = 'landing';
  // Reset Phase 3/4 module state so a prior session's cache doesn't bleed in
  currentScenario = null;
  currentScenarioSnapshots = null;
  currentRevisions = [];
  dealScenarios = [];
  _scenariosLoadedOnce = false;
  _scenariosLoadInFlight = false;
  _heuristicsLoadInFlight = false;
  heuristicOverrides = {};
  currentMarketLaborProfile = null;
  // Phase 6 — planning ratios reset (catalog is shared across projects, don't
  // clear it; but overrides + open-category are per-project/session)
  planningRatioOverrides = {};
  _planningRatioOpenCategory = null;
  _planningRatiosLoadInFlight = false;
  // v2 UI — reset transient selection state
  _selectedLaborIdx = 0;
  _collapsedNavGroups = new Set();

  // Load reference data + saved models + saved deals + ref_periods in parallel
  try {
    const [rd, models, deals, periods] = await Promise.all([
      api.loadAllRefData().catch(() => ({})),
      api.listModels().catch(() => []),
      api.listDeals().catch(() => []),
      api.fetchRefPeriods().catch(() => []),
    ]);
    refData = { ...rd, periods };
    savedModels = models;
    savedDeals  = deals;
  } catch (err) {
    console.warn('[CM] Initial load failed:', err);
  }

  // Listen for cross-tool push events
  bus.on('most:push-to-cm', handleMostPush);
  bus.on('wsc:push-to-cm', handleWscPush);
  bus.on('netopt:push-to-cm', handleNetOptPush);

  // If WSC pushed data before we mounted, consume the sessionStorage handoff.
  // This skips the landing page and takes the user straight into the editor
  // with the WSC facility dimensions applied — the expected behavior of the
  // "Use in Cost Model →" button.
  try {
    const pending = sessionStorage.getItem('wsc_pending_push');
    if (pending) {
      const payload = JSON.parse(pending);
      // Only consume if recent (within 60s) — stale entries shouldn't hijack future opens
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('wsc_pending_push');
        // Switch to editor mode first, then apply
        model = createEmptyModel();
        isDirty = false;
        userHasInteracted = false;
        activeSection = 'facility';
        viewMode = 'editor';
        // Apply payload to the fresh model.
        // WSC-J1 (2026-04-25): WSC now sends 13 fields (was 5). CM stores them
        // additively on model.facility — every write is guarded by truthy check
        // so blank WSC values never clobber CM defaults.
        if (payload.totalSqft)        model.facility.totalSqft = payload.totalSqft;
        if (payload.storageSqft)      model.facility.storageSqft = payload.storageSqft;
        if (payload.clearHeight)      model.facility.clearHeight = payload.clearHeight;
        if (payload.buildingWidth)    model.facility.buildingWidth = payload.buildingWidth;
        if (payload.buildingDepth)    model.facility.buildingDepth = payload.buildingDepth;
        if (payload.dockDoors)        model.facility.dockDoors = payload.dockDoors;
        if (payload.inboundDoors)     model.facility.inboundDoors = payload.inboundDoors;
        if (payload.outboundDoors)    model.facility.outboundDoors = payload.outboundDoors;
        if (payload.officeSqft)       model.facility.officeSqft = payload.officeSqft;
        if (payload.stagingSqft)      model.facility.stagingSqft = payload.stagingSqft;
        if (payload.palletPositions)  model.facility.palletPositions = payload.palletPositions;
        if (payload.sfPerPosition)    model.facility.sfPerPosition = payload.sfPerPosition;
        if (payload.peakUnitsPerDay)  model.facility.peakUnitsPerDay = payload.peakUnitsPerDay;
        isDirty = true;
      } else {
        // Stale — discard
        sessionStorage.removeItem('wsc_pending_push');
      }
    }
  } catch (e) {
    console.warn('[CM] Failed to consume WSC push handoff:', e);
  }

  // Brock 2026-04-20 — MOST→CM sessionStorage handoff (mirror of WSC above).
  // Without this, clicking "Push to Cost Model →" on MOST silently dropped
  // the payload because CM wasn't mounted yet to hear the bus emit.
  try {
    const pending = sessionStorage.getItem('most_pending_push');
    if (pending) {
      const payload = JSON.parse(pending);
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('most_pending_push');
        // Make sure we're on the editor, not the landing page
        if (viewMode !== 'editor') {
          model = createEmptyModel();
          isDirty = false;
          userHasInteracted = false;
          viewMode = 'editor';
        }
        handleMostPush(payload);
      } else {
        sessionStorage.removeItem('most_pending_push');
      }
    }
  } catch (e) {
    console.warn('[CM] Failed to consume MOST push handoff:', e);
  }

  // Brock 2026-04-25 — NetOpt->CM sessionStorage handoff (mirror MOST/WSC).
  try {
    const pending = sessionStorage.getItem('netopt_pending_cm_push');
    if (pending) {
      const payload = JSON.parse(pending);
      if (payload && payload.at && (Date.now() - payload.at) < 60000) {
        sessionStorage.removeItem('netopt_pending_cm_push');
        if (viewMode !== 'editor') {
          model = createEmptyModel();
          isDirty = false;
          userHasInteracted = false;
          viewMode = 'editor';
        }
        handleNetOptPush(payload);
      } else {
        sessionStorage.removeItem('netopt_pending_cm_push');
      }
    }
  } catch (e) {
    console.warn('[CM] Failed to consume NetOpt push handoff:', e);
  }

  renderCurrentView();

  bus.emit('cm:mounted');
}

/** Render whichever view (landing vs editor) is active. Re-wires its events. */
function renderCurrentView() {
  if (!rootEl) return;
  if (viewMode === 'landing') {
    rootEl.innerHTML = renderLanding();
    wireLandingEvents();
  } else {
    rootEl.innerHTML = renderShell();
    wireEditorEvents();
  }
}

function wireLandingEvents() {
  if (!rootEl) return;
  rootEl.querySelector('#cm-create-new')?.addEventListener('click', () => {
    model = createEmptyModel();
    isDirty = false;
    userHasInteracted = false;
    activeSection = 'setup';
    viewMode = 'editor';
    renderCurrentView();
  });

  // Delete button on landing card — confirms, removes row from Supabase, re-renders.
  rootEl.querySelectorAll('[data-cm-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't trigger the card-open handler
      const id = Number(btn.getAttribute('data-cm-delete'));
      const name = btn.getAttribute('data-cm-name') || `Model #${id}`;
      if (!id) return;
      if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
      try {
        await api.deleteModel(id);
        savedModels = savedModels.filter(m => m.id !== id);
        renderCurrentView();
      } catch (err) {
        console.error('[CM] Delete failed:', err);
        showCmToast('Delete failed: ' + err.message, 'error');
      }
    });
  });

  // Duplicate button on landing card — clones row in Supabase, re-renders.
  rootEl.querySelectorAll('[data-cm-duplicate]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't trigger the card-open handler
      const id = Number(btn.getAttribute('data-cm-duplicate'));
      const name = btn.getAttribute('data-cm-name') || `Model #${id}`;
      if (!id) return;
      try {
        await api.duplicateModel(id);
        savedModels = await api.listModels();
        renderCurrentView();
        showCmToast(`Duplicated "${name}".`, 'success');
      } catch (err) {
        console.error('[CM] Duplicate failed:', err);
        showCmToast('Duplicate failed: ' + err.message, 'error');
      }
    });
  });

  rootEl.querySelectorAll('[data-cm-card]').forEach(card => {
    card.addEventListener('click', async () => {
      const id = Number(card.getAttribute('data-cm-card'));
      if (!id) return;
      try {
        const full = await api.getModel(id);
        if (!full) { showCmToast('Model not found — it may have been deleted.', 'error'); return; }
        // Load logic:
        //   (a) Modern rows: use project_data jsonb blob directly.
        //   (b) Legacy rows (no project_data): reconstruct a minimal model from flat columns
        //       so the user can still open / edit / re-save them. The next save populates
        //       project_data, upgrading the row in place.
        if (full.project_data) {
          model = { ...createEmptyModel(), ...full.project_data, id: full.id };
          // CM-SAVE-1 — Hydrate save-state from the loaded row's updated_at; clear by-user (set on next save).
          lastSavedAt = full.updated_at || full.created_at || null;
          lastSavedBy = null;
          // Belt-and-braces: hydrate any project_data fields that are missing or
          // empty from the row's flat columns. This covers rows where project_data
          // was seeded by a SQL UPDATE that didn't include every field, or where
          // project_data and the flat columns drifted out of sync. (I-03)
          if (!model.projectDetails) model.projectDetails = createEmptyModel().projectDetails;
          const pdHydrate = model.projectDetails;
          if (!pdHydrate.environment && full.environment_type) {
            pdHydrate.environment = String(full.environment_type).toLowerCase();
          }
          if (!pdHydrate.market && full.market_id) pdHydrate.market = full.market_id;
          if (!pdHydrate.clientName && full.client_name) pdHydrate.clientName = full.client_name;
          if (!pdHydrate.contractTerm && full.contract_term_years) pdHydrate.contractTerm = full.contract_term_years;
          if (!pdHydrate.dealId && full.deal_deals_id) pdHydrate.dealId = full.deal_deals_id;
          if (!pdHydrate.name && full.name) pdHydrate.name = full.name;
          // M1 (2026-04-21): project_data saved before the G&A/Mgmt split
          // wipes gaMargin + mgmtFeeMargin from the empty-model defaults via
          // shallow spread. Backfill from flat columns (preferred) or by
          // splitting the existing targetMargin 37.5/62.5.
          if (!model.financial) model.financial = createEmptyModel().financial;
          const fin = model.financial;
          const gaMissing  = fin.gaMargin == null || Number(fin.gaMargin) === 0;
          const mgmtMissing = fin.mgmtFeeMargin == null || Number(fin.mgmtFeeMargin) === 0;
          if (gaMissing) {
            fin.gaMargin = full.ga_margin_pct != null
              ? Number(full.ga_margin_pct)
              : Number((Number(fin.targetMargin || 16) * 0.375).toFixed(2));
          }
          if (mgmtMissing) {
            fin.mgmtFeeMargin = full.mgmt_fee_margin_pct != null
              ? Number(full.mgmt_fee_margin_pct)
              : Number((Number(fin.targetMargin || 16) * 0.625).toFixed(2));
          }
          // Keep targetMargin as the derived sum (authoritative downstream reader).
          fin.targetMargin = Number((Number(fin.gaMargin || 0) + Number(fin.mgmtFeeMargin || 0)).toFixed(2));
          // M2 (2026-04-21): pull SG&A overlay + contract type from flat columns
          if (fin.sgaOverlayPct == null && full.sga_overlay_pct != null) {
            fin.sgaOverlayPct = Number(full.sga_overlay_pct);
          }
          if (fin.sgaAppliesTo == null && full.sga_applies_to != null) {
            fin.sgaAppliesTo = full.sga_applies_to;
          }
          if (!model.projectDetails.contractType && full.contract_type) {
            model.projectDetails.contractType = full.contract_type;
          }
          // M5 (2026-04-21): tax rate from flat column if project_data doesn't carry it
          if (model.projectDetails.taxRate == null && full.tax_rate_pct != null) {
            model.projectDetails.taxRate = Number(full.tax_rate_pct);
          }
          // Expose loaded model for quick live-debug (read-only, side-effect free)
          try { window.__cmLoadedModel = model; } catch (_) {}
        } else {
          model = reconstructModelFromFlatRow(full);
          // CM-SAVE-1 — Hydrate save-state from the legacy row.
          lastSavedAt = full.updated_at || full.created_at || null;
          lastSavedBy = null;
          showCmToast('Legacy model loaded from summary fields. Save to upgrade to the new format.', 'info');
        }
        // Legacy models may have annual_hours=0 on lines with valid volume+uph; repair them.
        (model.laborLines || []).forEach(l => {
          if ((l.annual_hours || 0) === 0 && (l.volume || 0) > 0 && (l.base_uph || 0) > 0) {
            recomputeLineHours(l);
          }
        });
        // Brock 2026-04-20 — auto-migrate to position catalog. Clusters
        // existing labor lines by (activity, rate, employment_type) into
        // distinct positions and stamps position_id on each line.
        migrateLaborLinesToPositions(model);
        // Brock 2026-04-22 — Phase 2a: back-fill EquipmentLine.line_type from
        // legacy `category` field for projects saved before the peak-capacity
        // rewrite. Idempotent — only touches lines missing the new field.
        api.backfillEquipmentLineTypes(model);
        isDirty = false;
        userHasInteracted = false;
        activeSection = 'setup';
        viewMode = 'editor';
        // Reset Phase 3/4 module state for the newly loaded project
        currentScenario = null;
        currentScenarioSnapshots = null;
        currentRevisions = [];
        dealScenarios = [];
        _scenariosLoadedOnce = false;
        _scenariosLoadInFlight = false;
        heuristicOverrides = {};
        currentMarketLaborProfile = null;
        // Phase 6 — planning ratio overrides are per-project
        planningRatioOverrides = {};
        _planningRatioOpenCategory = null;
        // v2 UI — reset selection on load
        _selectedLaborIdx = 0;
        // Reset Linked Designs cache so the next view fetches fresh for the new model
        linkedDesigns = null;
        _linkedDesignsLoadInFlight = false;
        renderCurrentView();
        // CM-SAVE-1 — Chip is rendered by renderCurrentView; refresh to push the loaded timestamp.
        refreshSaveStateChip();
      } catch (err) {
        console.error('[CM] Load failed:', err);
        showCmToast('Load failed: ' + err.message, 'error');
      }
    });
  });

  // CM-LND-1 (2026-04-25): persist deal-group collapse state to localStorage
  // so users don't have to re-collapse on every navigation back to the landing.
  rootEl.querySelectorAll('details[data-cm-deal-group]').forEach(det => {
    det.addEventListener('toggle', () => {
      const key = det.getAttribute('data-cm-deal-group');
      let collapsed = {};
      try { collapsed = JSON.parse(localStorage.getItem('cm-deal-group-collapsed') || '{}'); } catch {}
      if (det.open) delete collapsed[key]; else collapsed[key] = true;
      try { localStorage.setItem('cm-deal-group-collapsed', JSON.stringify(collapsed)); } catch {}
    });
  });

  // CM-LND-2 (2026-04-26): drag-to-reassign — drop a card on a different
  // deal group's summary header to move it. Same-group drops are no-ops.
  // Persists via api.reassignModelToDeal (partial update — no project_data
  // round-trip). Confirms before persisting; toasts on result.
  let _cmDragInfo = null;
  rootEl.querySelectorAll('.cm-landing-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      const id = Number(card.getAttribute('data-cm-card'));
      const name = card.getAttribute('data-cm-name') || `Model #${id}`;
      const fromKey = card.closest('details[data-cm-deal-group]')?.getAttribute('data-cm-deal-group') || '__unassigned__';
      _cmDragInfo = { id, name, fromKey };
      card.classList.add('cm-landing-card--dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(id));
      } catch (_) {}
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('cm-landing-card--dragging');
      _cmDragInfo = null;
      rootEl.querySelectorAll('.cm-landing-group--dragover').forEach(el => el.classList.remove('cm-landing-group--dragover'));
    });
  });

  rootEl.querySelectorAll('details[data-cm-deal-group]').forEach(det => {
    const summary = det.querySelector('summary');
    if (!summary) return;
    const myKey = det.getAttribute('data-cm-deal-group');
    summary.addEventListener('dragover', (e) => {
      if (!_cmDragInfo) return;
      if (_cmDragInfo.fromKey === myKey) return; // self-drop is a no-op
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      summary.classList.add('cm-landing-group--dragover');
    });
    summary.addEventListener('dragleave', () => {
      summary.classList.remove('cm-landing-group--dragover');
    });
    summary.addEventListener('drop', async (e) => {
      e.preventDefault();
      summary.classList.remove('cm-landing-group--dragover');
      if (!_cmDragInfo) return;
      if (myKey === _cmDragInfo.fromKey) return;
      const targetDealId = myKey === '__unassigned__' ? null : myKey;
      const targetLabel = summary.querySelector('span')?.textContent?.trim() || (myKey === '__unassigned__' ? 'Unassigned' : myKey);
      const sourceName = _cmDragInfo.name;
      const movedId = _cmDragInfo.id;
      _cmDragInfo = null;
      const ok = await showConfirm(`Move "${sourceName}" to "${targetLabel}"?`, { okLabel: 'Move' });
      if (!ok) return;
      try {
        await api.reassignModelToDeal(movedId, targetDealId);
        savedModels = await api.listModels();
        renderCurrentView();
        showCmToast(`Moved "${sourceName}" to "${targetLabel}".`, 'success');
      } catch (err) {
        console.error('[CM-LND-2] Reassign failed:', err);
        showCmToast('Move failed: ' + (err && err.message ? err.message : err), 'error');
      }
    });
  });
}

/**
 * Build a minimal v3 model object from a row that has only the flat cost_model_projects
 * columns (no project_data jsonb). Covers rows created before the v3 persistence backfill.
 * @param {any} row
 * @returns {object}
 */
function reconstructModelFromFlatRow(row) {
  const empty = createEmptyModel();
  // Volume columns → volumeLines
  const volumeMap = [
    { name: 'Pallets Received',   uom: 'pallets', key: 'vol_pallets_received',   isOut: false },
    { name: 'Put-Away (Pallets)', uom: 'pallets', key: 'vol_pallets_putaway',    isOut: false },
    { name: 'Pallets Shipped',    uom: 'pallets', key: 'vol_pallets_shipped',    isOut: true  },
    { name: 'Cases Picked',       uom: 'cases',   key: 'vol_cases_picked',       isOut: false },
    { name: 'Eaches Picked',      uom: 'eaches',  key: 'vol_eaches_picked',      isOut: false },
    { name: 'Orders Packed',      uom: 'orders',  key: 'vol_orders_packed',      isOut: false },
    { name: 'Replenishments',     uom: 'moves',   key: 'vol_replenishments',     isOut: false },
    { name: 'Returns Processed',  uom: 'orders',  key: 'vol_returns_processed',  isOut: false },
    { name: 'VAS Units',          uom: 'eaches',  key: 'vol_vas_units',          isOut: false },
  ];
  const volumeLines = volumeMap
    .filter(v => Number(row[v.key] || 0) > 0)
    .map(v => ({ name: v.name, volume: Number(row[v.key]), uom: v.uom, isOutboundPrimary: v.isOut }));
  // If no volumes, keep starter volumes so the form isn't empty
  return {
    ...empty,
    id: row.id,
    projectDetails: {
      name: row.name || '',
      clientName: row.client_name || '',
      market: row.market_id || '',
      environment: row.environment_type || '',
      facilityLocation: '',
      contractTerm: row.contract_term_years || 5,
      dealId: row.deal_deals_id || null,
    },
    volumeLines: volumeLines.length ? volumeLines : empty.volumeLines,
    facility: { ...empty.facility, totalSqft: Number(row.facility_sqft || empty.facility.totalSqft) },
    shifts: {
      shiftsPerDay: row.shifts_per_day || empty.shifts.shiftsPerDay,
      hoursPerShift: Number(row.hours_per_shift || empty.shifts.hoursPerShift),
      daysPerWeek: row.days_per_week || empty.shifts.daysPerWeek,
      weeksPerYear: row.operating_weeks_per_year || empty.shifts.weeksPerYear,
    },
    financial: {
      ...empty.financial,
      // M1 (2026-04-21): G&A + Mgmt Fee are the source of truth; targetMargin
      // is the derived sum. Fall back to target_margin_pct with 37.5/62.5 split
      // for rows that haven't been migrated yet.
      gaMargin:      Number(row.ga_margin_pct      ?? (Number(row.target_margin_pct || 16) * 0.375).toFixed(2)),
      mgmtFeeMargin: Number(row.mgmt_fee_margin_pct ?? (Number(row.target_margin_pct || 16) * 0.625).toFixed(2)),
      targetMargin:  Number(row.target_margin_pct || empty.financial.targetMargin),
      annualEscalation: Number(row.labor_escalation_pct || empty.financial.annualEscalation),
      volumeGrowth: Number(row.annual_volume_growth_pct || empty.financial.volumeGrowth),
    },
    pricingBuckets: Array.isArray(row.pricing_buckets) && row.pricing_buckets.length
      ? row.pricing_buckets
      : empty.pricingBuckets,
  };
}

/**
 * Small non-blocking toast (replaces alert() which freezes the tab on our live URL).
 */
function showCmToast(message, level) {
  if (!rootEl) return;
  const color = level === 'error' ? '#dc2626' : level === 'info' ? '#2563eb' : '#16a34a';
  const bg = level === 'error' ? '#fef2f2' : level === 'info' ? '#eff6ff' : '#f0fdf4';
  const existing = document.getElementById('cm-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'cm-toast';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;padding:12px 16px;border-radius: 10px;border:1px solid ${color};background:${bg};color:${color};font-size:13px;font-weight:600;z-index:9999;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,.12);`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 5000);
}

function wireEditorEvents() {
  if (!rootEl) return;
  // Sidebar nav
  rootEl.querySelectorAll('.cm-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const key = item.dataset.section;
      if (key) navigateSection(key);
    });
  });
  // v2 — group headers toggle their children (full editor re-render
  // keeps handler wiring simple; groups collapse/expand at local speed)
  rootEl.querySelectorAll('[data-nav-group-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.navGroupToggle;
      if (_collapsedNavGroups.has(key)) _collapsedNavGroups.delete(key);
      else _collapsedNavGroups.add(key);
      renderCurrentView();
    });
  });
  // Toolbar
  rootEl.querySelector('#cm-back-btn')?.addEventListener('click', async () => {
    // Refresh saved-models list when returning to landing
    try { savedModels = await api.listModels(); } catch {}
    viewMode = 'landing';
    renderCurrentView();
  });
  rootEl.querySelector('#cm-new-btn')?.addEventListener('click', handleNew);
  rootEl.querySelector('#cm-save-btn')?.addEventListener('click', handleSave);
  rootEl.querySelector('#cm-load-btn')?.addEventListener('click', handleLoad);
  rootEl.querySelector('#cm-export-btn')?.addEventListener('click', handleExportExcel);

  // CM-PROV-1 — root-level click delegation for the P&L cell inspector.
  // Per feedback_event_delegation_pattern.md: bind at the stable root so
  // the listener survives every renderShell()/renderCurrentView() pass.
  // (The previous container-scoped binding was wiped any time renderShell
  // re-rendered the editor — e.g. nav-group toggle or async profile load.)
  rootEl.addEventListener('click', (e) => {
    if (activeSection !== 'summary') return;
    const cell = e.target.closest('[data-cm-cell]');
    if (!cell) return;
    if (!cell.closest('#cm-section-content')) return;
    const rowKey = cell.dataset.cmCell;
    const year = parseInt(cell.dataset.cmYear, 10);
    if (!rowKey || !Number.isFinite(year)) return;
    if (_activeProvCell && _activeProvCell.rowKey === rowKey && _activeProvCell.year === year) {
      closeProvenancePanel();
    } else {
      openProvenancePanel(rowKey, year);
    }
  });

  // Section content
  renderSection();
  updateValidation();

  // CM-NAV-1 (Brock 2026-04-26) — keyboard shortcuts. Mount-scoped: registers
  // a single document-level handler that no-ops when CM is unmounted.
  _initKeyboardShortcuts();

  // CM-INSP-1 (Brock 2026-04-26) — hover progressive disclosure on KPI tiles.
  // Idempotent + uses document-level delegation so it survives renderSection
  // re-builds without per-render re-binding.
  _initDisclose();
}

/**
 * Cleanup on unmount.
 */
export function unmount() {
  _teardownKeyboardShortcuts();
  _hideDisclose();
  bus.clear('most:push-to-cm');
  bus.clear('netopt:push-to-cm');
  bus.clear('wsc:push-to-cm');
  if (isDirty) {
    console.log('[CM] Unmounting with unsaved changes');
  }
  rootEl = null;
  bus.emit('cm:unmounted');
}

// ============================================================
// CM-NAV-1 — Keyboard Shortcuts (Brock 2026-04-26)
// ============================================================
//
// Lightweight global shortcuts scoped to the active CM mount. Skips when the
// user is typing in an input/textarea/select/contenteditable so we never
// hijack data entry. Pressing `?` opens an inline cheatsheet overlay.
//
// Shortcuts:
//   ?            — Show keyboard shortcut help
//   [   /   ]    — Previous / next CM section (sidebar order)
//   Cmd/Ctrl+S   — Save current model (preventDefault on browser default)
//   Cmd/Ctrl+K   — Jump-to-section quick search (focuses sidebar; future)
//   g s          — Go to Summary
//   g p          — Go to Pricing
//   g c          — Go to Cashflow & P&L
//   g w          — Go to What-If Studio
//   g f          — Go to Facility
//   g l          — Go to Labor
//   Esc          — Close help overlay (modal Esc handlers still own their scope)
//
// `g`-prefix chords clear themselves after 1.5 s. Help overlay is built on
// demand — no DOM cost when not invoked.

let _kbdGActive = false;
let _kbdGTimer = null;
let _kbdHandler = null;

function _isTypingInField(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.matches('input, textarea, select, [contenteditable="true"]')) return true;
  // Some hub-input wrappers use contenteditable on inner spans
  if (target.closest('[contenteditable="true"]')) return true;
  return false;
}

function _kbdResetGPrefix() {
  _kbdGActive = false;
  if (_kbdGTimer) { clearTimeout(_kbdGTimer); _kbdGTimer = null; }
}

function _initKeyboardShortcuts() {
  if (_kbdHandler) return; // idempotent
  _kbdHandler = (e) => {
    // Only when CM is actually mounted to a live DOM node
    if (!rootEl || !rootEl.isConnected) return;
    // Don't hijack typing
    if (_isTypingInField(e.target)) {
      // Allow Cmd/Ctrl+S to fall through even when in fields (save shortcut
      // is universally expected). All others bail.
      if (!((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S'))) return;
    }

    // Cmd/Ctrl+S → save (intercept browser default)
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      _kbdResetGPrefix();
      try { handleSave(); } catch (err) { console.warn('[CM] kbd save failed:', err); }
      return;
    }

    // Esc → close help overlay if open (other modals own their own Esc)
    if (e.key === 'Escape') {
      const help = document.getElementById('cm-kbd-help-overlay');
      if (help) { help.remove(); e.preventDefault(); return; }
      _kbdResetGPrefix();
      return;
    }

    // ? → help
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      _showKeyboardHelpOverlay();
      _kbdResetGPrefix();
      return;
    }

    // [ / ] → prev / next section
    if ((e.key === '[' || e.key === ']') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      _kbdResetGPrefix();
      const idx = SECTIONS.findIndex(s => s.key === activeSection);
      if (idx < 0) return;
      const nextIdx = e.key === ']' ? Math.min(idx + 1, SECTIONS.length - 1) : Math.max(idx - 1, 0);
      const target = SECTIONS[nextIdx];
      if (target && target.key !== activeSection) {
        navigateSection(target.key);
        _flashShortcutToast(target.label);
      }
      return;
    }

    // g + letter chord
    if (_kbdGActive) {
      const chord = e.key.toLowerCase();
      const map = {
        s: 'summary',
        p: 'pricing',
        c: 'timeline',  // 'c' for Cashflow & P&L (the renamed page)
        w: 'whatif',
        f: 'facility',
        l: 'labor',
      };
      if (map[chord]) {
        e.preventDefault();
        _kbdResetGPrefix();
        navigateSection(map[chord]);
        const sec = SECTIONS.find(x => x.key === map[chord]);
        if (sec) _flashShortcutToast(sec.label);
        return;
      }
      // Unknown chord — drop the prefix
      _kbdResetGPrefix();
      return;
    }
    if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      _kbdGActive = true;
      _flashShortcutToast('g…', { mini: true });
      _kbdGTimer = setTimeout(_kbdResetGPrefix, 1500);
      return;
    }
  };
  document.addEventListener('keydown', _kbdHandler);
}

function _teardownKeyboardShortcuts() {
  if (_kbdHandler) {
    document.removeEventListener('keydown', _kbdHandler);
    _kbdHandler = null;
  }
  _kbdResetGPrefix();
}

/**
 * Tiny non-blocking toast in the bottom-right that confirms a shortcut
 * landed (e.g. "→ Summary" or "g…"). Auto-fades after 800 ms (mini) /
 * 1200 ms (full).
 */
function _flashShortcutToast(label, opts = {}) {
  const mini = !!opts.mini;
  const id = 'cm-kbd-flash';
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 99999;
    background: rgba(15, 23, 42, 0.92); color: #fff;
    padding: 8px 14px; border-radius: 6px;
    font-size: 13px; font-weight: 500; font-family: inherit;
    box-shadow: 0 6px 24px rgba(0,0,0,0.18);
    pointer-events: none; opacity: 0; transform: translateY(4px);
    transition: opacity 0.12s ease, transform 0.12s ease;
  `;
  el.textContent = mini ? label : '→ ' + label;
  document.body.appendChild(el);
  // Force a tick before transitioning in
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  }, mini ? 700 : 1100);
}

/**
 * Render the cheatsheet overlay. Built on demand. Click outside or Esc closes.
 */
function _showKeyboardHelpOverlay() {
  document.getElementById('cm-kbd-help-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'cm-kbd-help-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(15,23,42,0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 99998; padding: 20px;
  `;
  const panel = document.createElement('div');
  panel.style.cssText = `
    background: #fff; border-radius: 10px;
    width: 100%; max-width: 540px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.22);
    font-family: inherit;
  `;
  const kbd = (k) => `<kbd style="display:inline-block;padding:2px 7px;border:1px solid #cbd5e1;border-bottom-width:2px;border-radius:4px;background:#f8fafc;color:#0f172a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;font-weight:600;">${k}</kbd>`;
  const row = (keys, desc) => `
    <div style="display:flex;align-items:center;gap:14px;padding:7px 0;border-bottom:1px dashed #e5e7eb;">
      <div style="flex:0 0 168px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">${keys}</div>
      <div style="flex:1;font-size:13px;color:#334155;">${desc}</div>
    </div>
  `;
  panel.innerHTML = `
    <div style="padding:18px 22px 12px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font-size:15px;font-weight:700;color:#0f172a;">Keyboard Shortcuts</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">Cost Model — press <kbd style="font-size:10px;padding:1px 5px;border:1px solid #cbd5e1;border-radius:3px;font-family:ui-monospace,Menlo,monospace;">?</kbd> any time to reopen</div>
      </div>
      <button id="cm-kbd-help-close" style="border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#64748b;padding:4px 8px;">×</button>
    </div>
    <div style="padding:8px 22px 18px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;margin:8px 0 4px;">Navigation</div>
      ${row(`${kbd('[')} ${kbd(']')}`, 'Previous / next section')}
      ${row(`${kbd('g')} ${kbd('s')}`, 'Go to <strong>Summary</strong>')}
      ${row(`${kbd('g')} ${kbd('p')}`, 'Go to <strong>Pricing</strong>')}
      ${row(`${kbd('g')} ${kbd('c')}`, 'Go to <strong>Cashflow &amp; P&amp;L</strong>')}
      ${row(`${kbd('g')} ${kbd('w')}`, 'Go to <strong>What-If Studio</strong>')}
      ${row(`${kbd('g')} ${kbd('f')}`, 'Go to <strong>Facility</strong>')}
      ${row(`${kbd('g')} ${kbd('l')}`, 'Go to <strong>Labor</strong>')}
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;margin:14px 0 4px;">Actions</div>
      ${row(`${kbd('⌘ / Ctrl')} ${kbd('S')}`, 'Save current model')}
      ${row(`${kbd('?')}`, 'Show this cheatsheet')}
      ${row(`${kbd('Esc')}`, 'Close cheatsheet / dismiss overlay')}
      <div style="margin-top:14px;padding:10px 12px;background:#f8fafc;border-radius:6px;font-size:11.5px;color:#475569;line-height:1.5;">
        Shortcuts are disabled while typing in inputs (except <kbd style="font-size:10px;padding:1px 5px;border:1px solid #cbd5e1;border-radius:3px;font-family:ui-monospace,Menlo,monospace;">⌘S</kbd>). The <kbd style="font-size:10px;padding:1px 5px;border:1px solid #cbd5e1;border-radius:3px;font-family:ui-monospace,Menlo,monospace;">g</kbd>-prefix waits 1.5 s for a follow-up letter.
      </div>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  panel.querySelector('#cm-kbd-help-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ============================================================
// CM-INSP-1 — Hover Progressive Disclosure (Brock 2026-04-26)
// ============================================================
//
// Sister of CM-PROV-1 (click-based P&L cell inspector). Adds a styled hover
// popover to the most prominent "result" affordances on Summary and the
// Cashflow & P&L page so users can see the underlying breakdown without
// committing to a click. Surface area is kept small on purpose: just the 5
// Summary KPI tiles and 4 Cashflow & P&L KPI tiles. Both surfaces use the
// same `data-cm-disclose="<key>"` attribute and the same hover handler.
//
// Why hover (vs. always-visible): KPI tiles are the demo's headline numbers
// — keeping the breakdown one mouse-distance away preserves the at-a-glance
// scan but lets a curious viewer say "where did $4.2M come from?" without
// breaking flow.

let _discloseShowTimer = null;
let _discloseHideTimer = null;
let _discloseEl = null;
let _discloseInited = false;

function _initDisclose() {
  if (_discloseInited) return;
  _discloseInited = true;
  // Delegate at document level so the handler survives renderSection()
  // re-builds. Filters by the [data-cm-disclose] attribute on enter target.
  document.addEventListener('mouseover', (e) => {
    if (!rootEl || !rootEl.isConnected) return;
    const tile = e.target instanceof Element ? e.target.closest('[data-cm-disclose]') : null;
    if (!tile) return;
    if (!rootEl.contains(tile)) return; // only CM-owned tiles
    if (_discloseHideTimer) { clearTimeout(_discloseHideTimer); _discloseHideTimer = null; }
    // Tiny delay so a fast pass-through doesn't pop the panel
    if (_discloseShowTimer) clearTimeout(_discloseShowTimer);
    _discloseShowTimer = setTimeout(() => _showDisclose(tile), 180);
  });
  document.addEventListener('mouseout', (e) => {
    const tile = e.target instanceof Element ? e.target.closest('[data-cm-disclose]') : null;
    if (!tile) return;
    if (_discloseShowTimer) { clearTimeout(_discloseShowTimer); _discloseShowTimer = null; }
    // Grace period so user can move into the popover (in case we add
    // interactive content later); for now just hide cleanly.
    if (_discloseHideTimer) clearTimeout(_discloseHideTimer);
    _discloseHideTimer = setTimeout(_hideDisclose, 100);
  });
  // Hide on scroll/resize — popover position would otherwise drift
  window.addEventListener('scroll', _hideDisclose, true);
  window.addEventListener('resize', _hideDisclose);
}

function _hideDisclose() {
  if (_discloseEl) { _discloseEl.remove(); _discloseEl = null; }
  if (_discloseShowTimer) { clearTimeout(_discloseShowTimer); _discloseShowTimer = null; }
  if (_discloseHideTimer) { clearTimeout(_discloseHideTimer); _discloseHideTimer = null; }
}

function _showDisclose(tile) {
  const key = tile.dataset.cmDisclose;
  const html = _buildDiscloseHTML(key);
  if (!html) { _hideDisclose(); return; }
  _hideDisclose(); // belt-and-suspenders cleanup
  const pop = document.createElement('div');
  pop.id = 'cm-disclose-popover';
  pop.className = 'cm-disclose-popover';
  pop.innerHTML = html;
  document.body.appendChild(pop);
  _discloseEl = pop;
  // Position above the tile, centered horizontally, with a small arrow.
  const tr = tile.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const margin = 10;
  let left = tr.left + tr.width / 2 - pr.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - pr.width - margin));
  let top = tr.top - pr.height - 12;
  let placement = 'above';
  if (top < margin) {
    // Not enough room above — flip below the tile
    top = tr.bottom + 12;
    placement = 'below';
  }
  pop.style.left = `${Math.round(left + window.scrollX)}px`;
  pop.style.top = `${Math.round(top + window.scrollY)}px`;
  pop.dataset.placement = placement;
  // Arrow: position the ::after via inline custom property so it points at
  // the tile's horizontal center even when the popover is clamped to viewport.
  const arrowX = tr.left + tr.width / 2 - left;
  pop.style.setProperty('--cm-disclose-arrow-x', `${Math.round(arrowX)}px`);
  // Fade in
  requestAnimationFrame(() => pop.classList.add('cm-disclose-popover--visible'));
}

const _fmt$ = (n) => {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};
const _fmtN = (n) => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';

function _discloseRow(label, value, hint) {
  return `
    <div class="cm-disclose-row">
      <div class="cm-disclose-row__label">${label}${hint ? `<span class="cm-disclose-row__hint">${hint}</span>` : ''}</div>
      <div class="cm-disclose-row__value">${value}</div>
    </div>`;
}
function _discloseHeader(title, formula) {
  return `
    <div class="cm-disclose-head">
      <div class="cm-disclose-title">${title}</div>
      ${formula ? `<div class="cm-disclose-formula">${formula}</div>` : ''}
    </div>`;
}
function _discloseFooter(text) {
  return `<div class="cm-disclose-foot">${text}</div>`;
}

/**
 * Build the popover HTML for a given data-cm-disclose key. Returns null
 * when there's no current calc context (e.g. user is viewing an empty model).
 */
function _buildDiscloseHTML(key) {
  const ctx = _lastProvenanceContext;
  // Summary tiles
  if (key && key.startsWith('summary-')) {
    if (!ctx) return null;
    const p1 = ctx.projections?.[0] || {};
    const s = ctx.summary || {};
    if (key === 'summary-y1-cost') {
      const total = p1.totalCost || 0;
      return _discloseHeader('Y1 Total Cost', 'Σ(direct labor + indirect labor + facility + equipment + overhead + VAS) + Σ(start-up amortization)') +
        _discloseRow('Labor', _fmt$(p1.labor), 'direct + indirect') +
        _discloseRow('Facility', _fmt$(p1.facility)) +
        _discloseRow('Equipment', _fmt$(p1.equipment)) +
        _discloseRow('Overhead', _fmt$(p1.overhead)) +
        _discloseRow('VAS', _fmt$(p1.vas)) +
        _discloseRow('Start-Up amort.', _fmt$(p1.startupAmort || s.startupAmort)) +
        `<div class="cm-disclose-total">${_discloseRow('Total', _fmt$(total))}</div>` +
        _discloseFooter('Year-1 figure includes the learning-curve uplift on labor. Click any cost row in the P&L below for the full formula.');
    }
    if (key === 'summary-y1-revenue') {
      const margin = ctx.marginFrac || 0;
      return _discloseHeader('Y1 Revenue', `cost ÷ (1 − margin)`) +
        _discloseRow('Y1 Cost', _fmt$(p1.totalCost)) +
        _discloseRow('Target Margin', `${(margin * 100).toFixed(1)}%`) +
        _discloseRow('Divisor (1 − margin)', `${(1 - margin).toFixed(3)}`) +
        `<div class="cm-disclose-total">${_discloseRow('Revenue', _fmt$(p1.revenue))}</div>` +
        _discloseFooter('Cost-plus build-up. Override per-bucket pricing in <strong>Pricing Buckets</strong> to deviate from the global target margin.');
    }
    if (key === 'summary-y1-cost-per-order') {
      const orders = p1.orders || ctx.baseOrders || 0;
      const cpo = orders > 0 ? p1.totalCost / orders : 0;
      return _discloseHeader('Cost / Unit (Y1)', 'Y1 Total Cost ÷ Y1 Outbound Volume') +
        _discloseRow('Y1 Total Cost', _fmt$(p1.totalCost)) +
        _discloseRow('Y1 Outbound Volume', _fmtN(orders), 'starred line on Volumes & Profile') +
        `<div class="cm-disclose-total">${_discloseRow('Per Unit', '$' + cpo.toFixed(2))}</div>` +
        _discloseFooter('Anchored to the outbound-primary volume line (the line with the ★ on Volumes & Profile). Change the star to re-base.');
    }
    if (key === 'summary-ftes') {
      return _discloseHeader('Total FTEs', 'Σ direct laborLines.fte + Σ indirectLaborLines.fte') +
        _discloseRow('Direct FTEs', (s.directFtes || 0).toFixed(1)) +
        _discloseRow('Indirect FTEs', (s.indirectFtes || 0).toFixed(1)) +
        `<div class="cm-disclose-total">${_discloseRow('Total', (s.totalFtes || 0).toFixed(1))}</div>` +
        _discloseFooter('FTE = annual_hours ÷ operating-hours. Operating-hours come from <strong>Labor Factors → Shift Structure</strong>.');
    }
    if (key === 'summary-capital') {
      return _discloseHeader('Total Capital', 'Equipment up-front + Start-Up up-front') +
        _discloseRow('Equipment Capital', _fmt$(s.equipmentCapital), 'purchased MHE / racking / IT') +
        _discloseRow('Start-Up Capital', _fmt$(s.startupCapital), 'one-time, not amortized into opex') +
        `<div class="cm-disclose-total">${_discloseRow('Total', _fmt$((s.equipmentCapital || 0) + (s.startupCapital || 0)))}</div>` +
        _discloseFooter('Hits Year-0 cash flow. Drives the −Investment leg of NPV / Payback below.');
    }
    return null;
  }
  // Cashflow & P&L tiles — read from the monthly bundle
  if (key && key.startsWith('cf-')) {
    const bundle = _lastMonthlyBundle;
    const cf = bundle?.cashflow;
    if (!cf || !cf.length) return null;
    const periods = bundle.periods || [];
    const byId = new Map(periods.map(p => [p.id, p]));
    const live = cf
      .map(r => ({ ...r, _p: byId.get(r.period_id) }))
      .filter(r => r._p && !r._p.is_pre_go_live);
    const totalRev = cf.reduce((sum, r) => sum + (r.revenue || 0), 0);
    const totalOpex = cf.reduce((sum, r) => sum + (r.opex || 0), 0);
    const lastCum = cf.length ? cf[cf.length - 1].cumulative_cash_flow || 0 : 0;
    if (key === 'cf-total-revenue') {
      // Show top 3 contributing months + tail
      const sorted = [...cf].sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 3);
      const rows = sorted.map(r => _discloseRow(byId.get(r.period_id)?.label || '—', _fmt$(r.revenue || 0))).join('');
      const otherCount = cf.length - sorted.length;
      const otherTotal = totalRev - sorted.reduce((s, r) => s + (r.revenue || 0), 0);
      return _discloseHeader('Total Revenue', 'Σ monthly revenue across the contract') +
        rows +
        (otherCount > 0 ? _discloseRow(`+ ${otherCount} other months`, _fmt$(otherTotal)) : '') +
        `<div class="cm-disclose-total">${_discloseRow('Total', _fmt$(totalRev))}</div>` +
        _discloseFooter('Driven by the Pricing Schedule × monthly volume × seasonality share.');
    }
    if (key === 'cf-total-opex') {
      const sorted = [...cf].sort((a, b) => (b.opex || 0) - (a.opex || 0)).slice(0, 3);
      const rows = sorted.map(r => _discloseRow(byId.get(r.period_id)?.label || '—', _fmt$(r.opex || 0))).join('');
      const otherCount = cf.length - sorted.length;
      const otherTotal = totalOpex - sorted.reduce((s, r) => s + (r.opex || 0), 0);
      return _discloseHeader('Total Opex', 'Σ monthly opex across the contract') +
        rows +
        (otherCount > 0 ? _discloseRow(`+ ${otherCount} other months`, _fmt$(otherTotal)) : '') +
        `<div class="cm-disclose-total">${_discloseRow('Total', _fmt$(totalOpex))}</div>` +
        _discloseFooter('Labor + facility + equipment + overhead + VAS, with monthly seasonality and ramp applied.');
    }
    if (key === 'cf-cum-fcf') {
      const investment = (live[0]?.cum_fcf ?? lastCum) - lastCum; // rough: not great
      // Better: pull from y0 marker if present
      const y0Investment = (cf[0] && cf[0].cumulative_cash_flow != null) ? -cf[0].cumulative_cash_flow : null;
      return _discloseHeader('Cumulative FCF', 'starts at −Total Investment (Y0); each month adds (operating cash flow − capex)') +
        (y0Investment != null ? _discloseRow('Y0 Investment', _fmt$(-y0Investment), 'equipment + start-up capital') : '') +
        _discloseRow('Σ Operating CF', _fmt$(cf.reduce((s, r) => s + (r.operating_cash_flow || 0), 0))) +
        _discloseRow('Σ CapEx', _fmt$(cf.reduce((s, r) => s + (r.capex || 0), 0)), 'replacement / refresh') +
        `<div class="cm-disclose-total">${_discloseRow('Ending Cum FCF', _fmt$(lastCum))}</div>` +
        _discloseFooter('Crosses zero at <strong>Payback Month</strong>. Heavy capex in late years can dip cum FCF temporarily.');
    }
    if (key === 'cf-payback') {
      const payback = cf.find(r => (r.cumulative_cash_flow || 0) >= 0 && !(byId.get(r.period_id)?.is_pre_go_live));
      const total = cf.length;
      const idx = payback ? cf.indexOf(payback) : -1;
      return _discloseHeader('Payback Month', 'first month Cumulative FCF ≥ 0') +
        _discloseRow('Month label', payback ? (byId.get(payback.period_id)?.label || '—') : 'Not reached') +
        _discloseRow('Month index', idx >= 0 ? `${idx + 1} of ${total}` : '—') +
        _discloseRow('Cum FCF at payback', payback ? _fmt$(payback.cumulative_cash_flow || 0) : '—') +
        _discloseFooter('Earlier payback = quicker recovery of up-front capital. Industry rule of thumb: payback ≤ 24 months for "good" 3PL deals.');
    }
    return null;
  }
  return null;
}

// ============================================================
// SHELL RENDERING
// ============================================================

/**
 * CM-SAVE-1 — Format the last-saved state for the toolbar chip.
 * Returns "—" when the model has never been saved (or is brand-new).
 */
function formatSaveStateChip() {
  if (!lastSavedAt) return 'Not yet saved';
  let when;
  try {
    const d = new Date(lastSavedAt);
    if (Number.isNaN(d.getTime())) return 'Saved';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    when = sameDay
      ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return 'Saved'; }
  const who = lastSavedBy ? ` by ${lastSavedBy.split('@')[0]}` : '';
  return `Saved ${when}${who}`;
}

/**
 * CM-SAVE-1 — Replace the chip's contents in place after a save / load.
 * Safe to call when the chip isn't mounted (no-op).
 */
function refreshSaveStateChip() {
  const chip = rootEl?.querySelector('#cm-save-state-chip');
  if (!chip) return;
  const text = formatSaveStateChip();
  chip.textContent = text;
  chip.title = lastSavedAt ? `Last saved ${new Date(lastSavedAt).toLocaleString()}` : 'Save the model to record an audit timestamp';
  chip.dataset.cmState = lastSavedAt ? 'saved' : 'unsaved';
}

// ============================================================
// CM-PROV-1 — Cell-level Formula Inspector
// ============================================================
// Click any P&L cell → side panel slides in from the right with the formula
// that produced the cell, the named inputs feeding it (with values), and the
// timestamp the projection was computed. Pattern lifted from Hebbia /
// Macabacus / OAK provenance UX. Highest-leverage CM UX investment per the
// 2026-04-26 market audit.

/**
 * Format helpers — kept tight & local so the panel HTML is readable.
 */
function _fmtMoney(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  try { return calc.formatCurrency(v, { compact: true }); }
  catch (_) { return '$' + Math.round(v).toLocaleString(); }
}
function _fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}
function _fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString();
}

/**
 * Build the provenance record for a single P&L cell.
 *
 * @param {string} rowKey  — one of: orders, revenue, labor, facility, equipment, vas,
 *                          cogs, grossProfit, sga, ebitda, depreciation, ebit,
 *                          taxes, netIncome, capex, workingCapitalChange,
 *                          freeCashFlow, cumFcf
 * @param {number} year    — 1-based year index
 * @returns {null | { label, formula, value, inputs:Array<{label,value,source}>, notes?:string }}
 */
function getCellProvenance(rowKey, year) {
  const ctx = _lastProvenanceContext;
  if (!ctx) return null;
  const idx = year - 1;
  const p = ctx.projections[idx];
  if (!p) return null;
  const ch = ctx.calcHeur || {};
  const s = ctx.summary || {};
  const mFrac = ctx.marginFrac;

  // Cumulative escalation factor for human display ("compounded 9.3% by Y4")
  const compound = (rate, n) => Math.pow(1 + rate, n - 1) - 1;
  const volMult = Math.pow(1 + (ch.volGrowthPct || 0) / 100, year - 1);
  const laborMult = Math.pow(1 + (ch.laborEscPct || 0) / 100, year - 1);
  const facilityMult = Math.pow(1 + ((ch.facilityEscPct ?? ch.costEscPct) || 0) / 100, year - 1);
  const equipmentMult = Math.pow(1 + ((ch.equipmentEscPct ?? ch.costEscPct) || 0) / 100, year - 1);
  const costMult = Math.pow(1 + (ch.costEscPct || 0) / 100, year - 1);

  switch (rowKey) {
    case 'orders':
      return {
        label: `Orders (Year ${year})`,
        formula: 'orders = baseOrders × (1 + volGrowth)^(year − 1)',
        value: p.orders,
        inputs: [
          { label: 'Base Orders (Y1)', value: _fmtNum(ctx.baseOrders), source: 'Volumes & Profile → starred outbound line' },
          { label: 'Volume Growth', value: ((ch.volGrowthPct || 0).toFixed(1) + '%/yr'), source: 'Heuristics' },
          { label: 'Cumulative growth', value: _fmtPct(compound((ch.volGrowthPct || 0) / 100, year)), source: `Compounded over ${year - 1} year(s)` },
        ],
      };

    case 'labor':
      return {
        label: `Labor Cost (Year ${year})`,
        formula: 'labor = baseLaborCost × (1 + laborEsc)^(yr−1) × (1 + volGrowth)^(yr−1)' + (year === 1 ? ' × (1 / yr1LearningFactor)' : ''),
        value: p.labor,
        inputs: [
          { label: 'Base Labor Cost', value: _fmtMoney(s.laborCost), source: 'Sum of laborLines + indirectLaborLines' },
          { label: 'Labor Escalation', value: ((ch.laborEscPct || 0).toFixed(1) + '%/yr'), source: 'Heuristics' },
          { label: 'Volume Growth', value: ((ch.volGrowthPct || 0).toFixed(1) + '%/yr'), source: 'Heuristics' },
          { label: 'Combined multiplier', value: (laborMult * volMult).toFixed(3) + '×', source: `Y${year} of ${ctx.contractYears}` },
          ...(year === 1 ? [{ label: 'Y1 Learning Curve', value: ((p.learningMult || 1).toFixed(3) + '×'), source: 'Weighted complexity_tier across labor lines' }] : []),
        ],
        notes: year === 1
          ? 'Year 1 includes a productivity ramp: new hires reach standard productivity over time. Higher complexity → bigger Y1 cost uplift.'
          : 'No learning-curve in Y2+: standard productivity is assumed.',
      };

    case 'facility':
      return {
        label: `Facility Cost (Year ${year})`,
        formula: 'facility = baseFacilityCost × (1 + facilityEsc)^(yr − 1)',
        value: p.facility,
        inputs: [
          { label: 'Base Facility Cost', value: _fmtMoney(s.facilityCost), source: 'Facility rent + utilities + TI amort + property tax' },
          { label: 'Facility Escalation', value: (((ch.facilityEscPct ?? ch.costEscPct) || 0).toFixed(1) + '%/yr'), source: ch.facilityEscPct != null ? 'Heuristics → Facility Esc' : 'Heuristics → Cost Esc (default)' },
          { label: 'Cumulative escalation', value: _fmtPct(compound(((ch.facilityEscPct ?? ch.costEscPct) || 0) / 100, year)), source: `Compounded over ${year - 1} year(s)` },
        ],
        notes: 'No volume escalator — facility cost is structurally fixed. Add square footage or change market rate to move the base.',
      };

    case 'equipment':
      return {
        label: `Equipment Cost (Year ${year})`,
        formula: 'equipment = baseEquipmentCost × (1 + equipmentEsc)^(yr − 1)',
        value: p.equipment,
        inputs: [
          { label: 'Base Equipment Cost', value: _fmtMoney(s.equipmentCost), source: 'Sum of equipmentLines (own + rent + IT + 3-way)' },
          { label: 'Equipment Escalation', value: (((ch.equipmentEscPct ?? ch.costEscPct) || 0).toFixed(1) + '%/yr'), source: ch.equipmentEscPct != null ? 'Heuristics → Equipment Esc' : 'Heuristics → Cost Esc (default)' },
          { label: 'Cumulative escalation', value: _fmtPct(compound(((ch.equipmentEscPct ?? ch.costEscPct) || 0) / 100, year)), source: `Compounded over ${year - 1} year(s)` },
        ],
      };

    case 'vas':
      return {
        label: `VAS (Pass-through) — Year ${year}`,
        formula: 'vas = baseVasCost × (1 + volGrowth)^(yr − 1)',
        value: p.vas,
        inputs: [
          { label: 'Base VAS Cost', value: _fmtMoney(s.vasCost), source: 'Sum of vasLines' },
          { label: 'Volume Growth', value: ((ch.volGrowthPct || 0).toFixed(1) + '%/yr'), source: 'Heuristics' },
          { label: 'Cumulative growth', value: _fmtPct(compound((ch.volGrowthPct || 0) / 100, year)), source: `Compounded over ${year - 1} year(s)` },
        ],
        notes: 'VAS scales with volume, not cost-of-living. No escalation rate applied.',
      };

    case 'overhead':
    case 'sga': {
      const v = p.sga ?? p.overhead;
      const inputs = [
        { label: 'Base Overhead Cost', value: _fmtMoney(s.overheadCost), source: 'Sum of overheadLines (annualized)' },
        { label: 'Cost Escalation', value: ((ch.costEscPct || 0).toFixed(1) + '%/yr'), source: 'Heuristics' },
        { label: 'Cumulative escalation', value: _fmtPct(compound((ch.costEscPct || 0) / 100, year)), source: `Compounded over ${year - 1} year(s)` },
      ];
      if (p.sgaOverlay && p.sgaOverlay > 0) {
        inputs.push({ label: 'SG&A Overlay', value: _fmtMoney(p.sgaOverlay), source: 'Financial → SG&A Overlay %' });
      }
      return {
        label: `Overhead / SG&A (Year ${year})`,
        formula: (p.sgaOverlay && p.sgaOverlay > 0)
          ? 'sga = sgaCategory + (revenue × sgaOverlayPct)\nsgaCategory = baseOverhead × (1 + costEsc)^(yr − 1)'
          : 'overhead = baseOverheadCost × (1 + costEsc)^(yr − 1)',
        value: v,
        inputs,
        notes: 'No volume scalar (audit 2026-04-21 removed an undocumented 30% volume-elasticity term).',
      };
    }

    case 'revenue':
      return {
        label: `Revenue (Year ${year})`,
        formula: 'revenue = totalCost ÷ (1 − targetMargin)\nbreakout: each category grossed up at the same margin',
        value: p.revenue,
        inputs: [
          { label: 'Total Cost (Y' + year + ')', value: _fmtMoney(p.totalCost), source: 'Labor + Facility + Equipment + Overhead + VAS + Startup' },
          { label: 'Target Margin', value: _fmtPct(mFrac, 2), source: 'Financial → Target Margin %' },
          { label: 'Implied Cost / Revenue', value: _fmtPct(p.revenue > 0 ? (p.totalCost / p.revenue) : 0), source: 'Year ' + year + ' P&L' },
          { label: 'Labor revenue', value: _fmtMoney(p.laborRevenue), source: 'labor ÷ (1 − margin)' },
          { label: 'Facility revenue', value: _fmtMoney(p.facilityRevenue), source: 'facility ÷ (1 − margin)' },
          { label: 'Equipment revenue', value: _fmtMoney(p.equipmentRevenue), source: 'equipment ÷ (1 − margin)' },
          { label: 'Overhead revenue', value: _fmtMoney(p.overheadRevenue), source: 'overhead ÷ (1 − margin)' },
          { label: 'VAS revenue', value: _fmtMoney(p.vasRevenue), source: 'vas ÷ (1 − margin)' },
        ],
        notes: 'Reference cost-plus pricing per Part I §3.2. Each category grossed up at the same margin, then summed.',
      };

    case 'cogs':
      return {
        label: `COGS (Year ${year})`,
        formula: 'cogs = labor + facility + equipment + vas',
        value: p.cogs ?? (p.labor + p.facility + p.equipment + p.vas),
        inputs: [
          { label: 'Labor', value: _fmtMoney(p.labor), source: 'Year ' + year + ' Labor row' },
          { label: 'Facility', value: _fmtMoney(p.facility), source: 'Year ' + year + ' Facility row' },
          { label: 'Equipment', value: _fmtMoney(p.equipment), source: 'Year ' + year + ' Equipment row' },
          { label: 'VAS', value: _fmtMoney(p.vas), source: 'Year ' + year + ' VAS row' },
        ],
        notes: 'Site-level direct costs. Excludes Overhead (SG&A), D&A, taxes.',
      };

    case 'grossProfit':
      return {
        label: `Gross Profit (Year ${year})`,
        formula: 'grossProfit = revenue − cogs',
        value: p.grossProfit,
        inputs: [
          { label: 'Revenue', value: _fmtMoney(p.revenue), source: 'Year ' + year + ' Revenue row' },
          { label: 'COGS', value: _fmtMoney(p.cogs ?? (p.labor + p.facility + p.equipment + p.vas)), source: 'Year ' + year + ' Total COGS row' },
          { label: 'GP %', value: _fmtPct(p.revenue > 0 ? p.grossProfit / p.revenue : 0), source: '' },
        ],
      };

    case 'ebitda':
      return {
        label: `EBITDA (Year ${year})`,
        formula: 'ebitda = grossProfit − sga',
        value: p.ebitda,
        inputs: [
          { label: 'Gross Profit', value: _fmtMoney(p.grossProfit), source: 'Year ' + year + ' GP row' },
          { label: 'SG&A', value: _fmtMoney(p.sga ?? p.overhead), source: 'Year ' + year + ' Overhead row' },
          { label: 'EBITDA %', value: _fmtPct(p.revenue > 0 ? p.ebitda / p.revenue : 0), source: '' },
        ],
      };

    case 'depreciation':
      return {
        label: `D&A (Year ${year})`,
        formula: 'depreciation = startupAmort  (constant across all years)',
        value: p.depreciation ?? p.startup,
        inputs: [
          { label: 'Startup Amort.', value: _fmtMoney(s.startupAmort), source: 'Sum of startupLines ÷ contract term' },
          { label: 'Contract Term', value: ctx.contractYears + ' yr', source: 'Project Details' },
        ],
        notes: 'Equipment capital is excluded (own_then_buy treatment). TI is folded into Facility cost via amortization.',
      };

    case 'ebit':
      return {
        label: `EBIT (Year ${year})`,
        formula: 'ebit = ebitda − depreciation',
        value: p.ebit,
        inputs: [
          { label: 'EBITDA', value: _fmtMoney(p.ebitda), source: 'Year ' + year + ' EBITDA row' },
          { label: 'D&A', value: _fmtMoney(p.depreciation ?? p.startup), source: 'Year ' + year + ' D&A row' },
        ],
      };

    case 'taxes':
      return {
        label: `Taxes (Year ${year})`,
        formula: 'taxes = max(0, ebit × taxRate)',
        value: p.taxes || 0,
        inputs: [
          { label: 'EBIT', value: _fmtMoney(p.ebit), source: 'Year ' + year + ' EBIT row' },
          { label: 'Tax Rate', value: ((ch.taxRatePct || 25).toFixed(1) + '%'), source: 'Heuristics → Tax Rate' },
        ],
        notes: 'Loss years zero out — no NOL carryforward modeled.',
      };

    case 'netIncome':
      return {
        label: `Net Income (Year ${year})`,
        formula: 'netIncome = ebit − taxes',
        value: p.netIncome,
        inputs: [
          { label: 'EBIT', value: _fmtMoney(p.ebit), source: 'Year ' + year + ' EBIT row' },
          { label: 'Taxes', value: _fmtMoney(p.taxes || 0), source: 'Year ' + year + ' Taxes row' },
          { label: 'NI %', value: _fmtPct(p.revenue > 0 ? p.netIncome / p.revenue : 0), source: '' },
        ],
      };

    case 'capex':
      return {
        label: `CapEx (Year ${year})`,
        formula: year === 1 ? 'capex_y1 = startupCapital  (Y2+ = 0)' : 'capex = 0  (no recurring CapEx in this model)',
        value: p.capex,
        inputs: [
          { label: 'Startup Capital', value: _fmtMoney(s.startupCapital), source: 'Sum of startupLines marked is_capital' },
          { label: 'Year', value: 'Y' + year + ' of ' + ctx.contractYears, source: '' },
        ],
        notes: year === 1 ? 'All startup capital hits Y0/Y1 cash flow.' : 'No replacement-CapEx modeled — assumes assets last the contract.',
      };

    case 'workingCapitalChange':
      return {
        label: `Δ Working Capital (Year ${year})`,
        formula: year === 1 ? 'ΔWC_Y1 = revenue × 8%' : 'ΔWC = revenue × volGrowth × 8%',
        value: p.workingCapitalChange,
        inputs: [
          { label: 'Revenue', value: _fmtMoney(p.revenue), source: 'Year ' + year + ' Revenue row' },
          { label: 'Volume Growth', value: ((ch.volGrowthPct || 0).toFixed(1) + '%/yr'), source: 'Heuristics' },
          { label: 'WC Proxy', value: '8% of revenue', source: 'Legacy yearly engine constant' },
        ],
        notes: 'Yearly engine uses an 8% revenue proxy. The monthly engine (when enabled) uses a defensible DSO/DPO/labor-accrual model instead.',
      };

    case 'freeCashFlow':
      return {
        label: `Free Cash Flow (Year ${year})`,
        formula: 'fcf = (ni + d&a − ΔWC) − capex',
        value: p.freeCashFlow,
        inputs: [
          { label: 'Net Income', value: _fmtMoney(p.netIncome), source: 'Year ' + year + ' NI row' },
          { label: 'D&A', value: _fmtMoney(p.depreciation ?? p.startup), source: 'Add-back (non-cash)' },
          { label: 'Δ Working Capital', value: _fmtMoney(p.workingCapitalChange), source: 'Year ' + year + ' ΔWC row (subtracted)' },
          { label: 'CapEx', value: _fmtMoney(p.capex), source: 'Year ' + year + ' CapEx row (subtracted)' },
          { label: 'Operating CF', value: _fmtMoney(p.operatingCashFlow), source: 'NI + D&A − ΔWC' },
        ],
      };

    case 'cumFcf':
      return {
        label: `Cumulative FCF (Year ${year})`,
        formula: 'cumFcf = Σ freeCashFlow from Y1 to Y' + year,
        value: p.cumFcf,
        inputs: [
          { label: 'This Year FCF', value: _fmtMoney(p.freeCashFlow), source: 'Year ' + year + ' FCF row' },
          { label: 'Prior Cum FCF', value: _fmtMoney(p.cumFcf - p.freeCashFlow), source: year > 1 ? `Year ${year - 1} Cum FCF` : 'Year 0 baseline (0)' },
        ],
        notes: 'Crossover from negative to positive marks the Payback point used in the Summary KPIs.',
      };
  }
  return null;
}

/** Render the panel HTML. Returns the inner content (panel container is in renderShell). */
function renderProvenancePanelInner() {
  if (!_activeProvCell) {
    return `<div style="padding:32px 16px;text-align:center;color:var(--ies-gray-500);font-size:13px;line-height:1.5;">
      <div style="font-size:14px;font-weight:600;color:var(--ies-gray-700);margin-bottom:8px;">Cell-level formula inspector</div>
      <div>Click any value in the P&L table to see the formula that produced it, the inputs feeding it, and how to change it.</div>
    </div>`;
  }
  const prov = getCellProvenance(_activeProvCell.rowKey, _activeProvCell.year);
  if (!prov) {
    return `<div style="padding:24px;color:var(--ies-gray-500);font-size:13px;">No provenance available for this cell.</div>`;
  }
  const computedAt = _lastProvenanceContext?.computedAt;
  const computedAtStr = computedAt ? new Date(computedAt).toLocaleString() : '—';

  return `
    <div style="padding:14px 16px;border-bottom:1px solid var(--ies-gray-200);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);font-weight:700;">Cell Inspector</div>
        <button id="cm-prov-close" class="hub-btn hub-btn-sm hub-btn-secondary" style="padding:2px 8px;font-size:11px;line-height:1.4;">Close ✕</button>
      </div>
      <div style="font-size:15px;font-weight:700;color:var(--ies-navy,#0F1B2E);margin-top:4px;">${prov.label}</div>
      <div style="font-size:22px;font-weight:700;color:var(--ies-blue,#0047AB);margin-top:6px;">${_fmtMoney(prov.value)}</div>
    </div>

    <div style="padding:14px 16px;border-bottom:1px solid var(--ies-gray-200);background:var(--ies-gray-50,#f9fafb);">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);font-weight:700;margin-bottom:6px;">Formula</div>
      <pre style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;background:#fff;border:1px solid var(--ies-gray-200);border-radius:4px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;color:var(--ies-gray-800,#1f2937);margin:0;">${prov.formula.replace(/</g, '&lt;')}</pre>
    </div>

    <div style="padding:14px 16px;${prov.notes ? 'border-bottom:1px solid var(--ies-gray-200);' : ''}">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);font-weight:700;margin-bottom:8px;">Inputs feeding this cell</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${prov.inputs.map(inp => `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;font-size:12.5px;line-height:1.4;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;color:var(--ies-gray-800,#1f2937);">${inp.label}</div>
              ${inp.source ? `<div style="font-size:11px;color:var(--ies-gray-500);">${inp.source}</div>` : ''}
            </div>
            <div style="font-weight:700;color:var(--ies-navy,#0F1B2E);font-variant-numeric:tabular-nums;white-space:nowrap;">${inp.value}</div>
          </div>
        `).join('')}
      </div>
    </div>

    ${prov.notes ? `<div style="padding:12px 16px;background:#fff7ed;border-bottom:1px solid var(--ies-gray-200);font-size:11.5px;line-height:1.5;color:var(--ies-gray-700,#374151);"><strong style="color:#9a3412;">Note:</strong> ${prov.notes}</div>` : ''}

    <div style="padding:10px 16px;font-size:10.5px;color:var(--ies-gray-500);line-height:1.4;">
      Computed ${computedAtStr}<br>
      Year ${_activeProvCell.year} of ${_lastProvenanceContext?.contractYears || '—'} · row key <code style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;background:var(--ies-gray-100);padding:1px 4px;border-radius:3px;">${_activeProvCell.rowKey}</code>
    </div>
  `;
}

/** Open the panel for a specific cell. */
function openProvenancePanel(rowKey, year) {
  _activeProvCell = { rowKey, year };
  refreshProvenancePanel();
}

/** Close the panel. */
function closeProvenancePanel() {
  _activeProvCell = null;
  refreshProvenancePanel();
}

/** Re-render panel contents. Safe to call when no panel exists in the DOM. */
function refreshProvenancePanel() {
  const panel = rootEl?.querySelector('#cm-provenance-panel');
  const inner = rootEl?.querySelector('#cm-provenance-panel-inner');
  if (!panel || !inner) return;
  inner.innerHTML = renderProvenancePanelInner();
  panel.dataset.cmOpen = _activeProvCell ? 'true' : 'false';
  panel.style.transform = _activeProvCell ? 'translateX(0)' : 'translateX(110%)';
  // Highlight the active cell
  rootEl.querySelectorAll('[data-cm-cell].is-active').forEach(el => el.classList.remove('is-active'));
  if (_activeProvCell) {
    const sel = `[data-cm-cell="${_activeProvCell.rowKey}"][data-cm-year="${_activeProvCell.year}"]`;
    rootEl.querySelector(sel)?.classList.add('is-active');
  }
  // Wire close button (rebuilt every time inner is rebuilt)
  rootEl.querySelector('#cm-prov-close')?.addEventListener('click', closeProvenancePanel);
}

function renderShell() {
  return `
    <div class="hub-builder" style="height: calc(100vh - 48px);">
      <!-- Builder Sidebar (220px) -->
      <div class="hub-builder-sidebar">
        <!-- Toolbar -->
        <div style="padding: 12px 16px; border-bottom: 1px solid var(--ies-gray-200);">
          <button class="hub-btn hub-btn-sm hub-btn-secondary" id="cm-back-btn" style="margin-bottom:8px;font-size:11px;">← All Models</button>
          <div class="text-subtitle" style="margin-bottom: 8px;">Cost Model Builder</div>
          <div class="flex gap-2" style="flex-wrap: wrap;">
            <button class="hub-btn hub-btn-primary hub-btn-sm" id="cm-new-btn">New</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-save-btn">Save</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-load-btn">Load</button>
            <button class="hub-btn hub-btn-secondary hub-btn-sm" id="cm-export-btn" title="Download as multi-sheet .xlsx">Export</button>
          </div>
          <!-- CM-SAVE-1 — Persistent save-state chip (audit-trail visibility) -->
          <div id="cm-save-state-chip" data-cm-state="unsaved"
               style="margin-top:8px;font-size:11px;color:var(--ies-gray-600,#4b5563);
                      background:var(--ies-gray-100,#f3f4f6);border:1px solid var(--ies-gray-200,#e5e7eb);
                      border-radius:4px;padding:4px 8px;display:inline-block;line-height:1.3;
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;"
               title="Save the model to record an audit timestamp">Not yet saved</div>
        </div>
        <!-- Section Nav -->
        <nav style="padding: 8px 0;">
          ${isCmV2UiOn() ? renderGroupedNav() : SECTIONS.map(s => `
            <div class="cm-nav-item${s.key === activeSection ? ' active' : ''}" data-section="${s.key}">
              <span class="cm-nav-check" id="cm-check-${s.key}"></span>
              <span class="cm-nav-label">${s.label}</span>
            </div>
          `).join('')}
        </nav>
        <!-- Validation -->
        <div id="cm-validation" style="padding: 8px 16px; border-top: 1px solid var(--ies-gray-200); font-size: 11px;"></div>
      </div>

      <!-- Content Area -->
      <div class="hub-builder-content" id="cm-content">
        <div class="hub-builder-form" id="cm-section-content">
          <!-- Section content renders here -->
        </div>
      </div>

      <!-- CM-PROV-1 — Cell-level formula inspector side panel -->
      <aside id="cm-provenance-panel"
             data-cm-open="false"
             style="position:fixed; top:48px; right:0; width:380px; max-width:92vw; height:calc(100vh - 48px);
                    background:#fff; border-left:1px solid var(--ies-gray-200,#e5e7eb);
                    box-shadow:-6px 0 16px rgba(15,27,46,0.08);
                    transform:translateX(110%); transition:transform 220ms ease;
                    z-index:1100; overflow-y:auto;">
        <div id="cm-provenance-panel-inner"></div>
      </aside>
    </div>

    <style>
      .cm-nav-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: var(--ies-gray-600);
        transition: all 0.15s ease;
        border-left: 3px solid transparent;
      }
      .cm-nav-item:hover { background: var(--ies-gray-50); color: var(--ies-navy); }
      .cm-nav-item.active { background: rgba(0,71,171,0.06); color: var(--ies-blue); border-left-color: var(--ies-blue); }
      .cm-nav-check {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 2px solid var(--ies-gray-300);
        flex-shrink: 0;
      }
      .cm-nav-check.complete {
        background: var(--ies-green);
        border-color: var(--ies-green);
        position: relative;
      }
      .cm-nav-check.complete::after {
        content: '';
        position: absolute;
        left: 4px;
        top: 1px;
        width: 4px;
        height: 8px;
        border: solid #fff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }

      /* CM-PROV-1 — clickable P&L cells + side-panel polish */
      [data-cm-cell] { cursor: pointer; transition: background-color 0.12s ease, outline 0.12s ease; }
      [data-cm-cell]:hover { background-color: rgba(0,71,171,0.06); }
      [data-cm-cell].is-active { outline: 2px solid var(--ies-blue,#0047AB); outline-offset: -2px; background-color: rgba(0,71,171,0.08); }

      .cm-form-group { margin-bottom: 20px; }
      .cm-form-label {
        display: block;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--ies-gray-500);
        margin-bottom: 6px;
      }
      .cm-form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      .cm-form-row-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 16px;
      }

      .cm-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 20px;
        padding-bottom: 12px;
        border-bottom: 2px solid var(--ies-gray-200);
      }
      .cm-section-title { font-size: 16px; font-weight: 700; color: var(--ies-navy); }
      .cm-section-desc { font-size: 13px; color: var(--ies-gray-500); margin-top: 4px; }

      .cm-grid-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .cm-grid-table th {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--ies-gray-500);
        text-align: left;
        padding: 8px 10px;
        border-bottom: 2px solid var(--ies-gray-200);
        white-space: nowrap;
      }
      .cm-grid-table td {
        padding: 6px 10px;
        border-bottom: 1px solid var(--ies-gray-100);
        vertical-align: middle;
      }
      .cm-grid-table input, .cm-grid-table select {
        padding: 6px 8px;
        border: 1px solid var(--ies-gray-200);
        border-radius: 4px;
        font-family: Montserrat, sans-serif;
        font-size: 13px;
        font-weight: 600;
      }
      .cm-grid-table input:focus, .cm-grid-table select:focus {
        outline: none;
        border-color: var(--ies-blue);
        box-shadow: 0 0 0 2px rgba(0,71,171,0.1);
      }
      .cm-num { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
      .cm-total-row td { font-weight: 700; border-top: 2px solid var(--ies-gray-300); background: var(--ies-gray-50); }

      .cm-add-row-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 8px;
        padding: 6px 12px;
        background: none;
        border: 1px dashed var(--ies-gray-300);
        border-radius: 6px;
        color: var(--ies-blue);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        font-family: Montserrat, sans-serif;
      }
      .cm-add-row-btn:hover { border-color: var(--ies-blue); background: rgba(0,71,171,0.04); }

      .cm-delete-btn {
        background: none;
        border: none;
        color: var(--ies-red);
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: Montserrat, sans-serif;
      }
      .cm-delete-btn:hover { background: rgba(220,53,69,0.08); }
    </style>
  `;
}

// ============================================================
// SECTION NAVIGATION
// ============================================================

function navigateSection(key) {
  activeSection = key;
  state.set('costModel.activeSection', key);

  // Update nav highlighting
  rootEl?.querySelectorAll('.cm-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === key);
  });

  renderSection();
  bus.emit('cm:section-changed', { section: key });
}

// ============================================================
// SECTION RENDERING — delegates to section-specific renderers
// ============================================================

function renderSection() {
  const container = rootEl?.querySelector('#cm-section-content');
  if (!container) return;

  const renderers = {
    setup: renderSetup,
    volumes: renderVolumes,
    orderProfile: renderOrderProfile,
    facility: renderFacility,
    shifts: renderShifts,
    shiftPlanning: renderShiftPlanning,
    pricingBuckets: renderPricingBuckets,
    labor: renderLabor,
    equipment: renderEquipment,
    overhead: renderOverhead,
    vas: renderVas,
    financial: renderFinancial,
    startup: renderStartup,
    implementation: renderImplementation,
    pricing: renderPricing,
    summary: renderSummary,
    timeline: renderTimeline,
    assumptions: renderAssumptions,
    scenarios: renderScenarios,
    whatif: renderWhatIfStudio,
    linked: renderLinkedDesigns,
  };

  const render = renderers[activeSection];
  if (render) {
    container.innerHTML = render();
    bindSectionEvents(activeSection, container);
    // Keep sidebar completion dots in lockstep with the section content —
    // add/delete row actions call renderSection() after mutating model, so
    // refreshing here covers the non-input mutation paths too.
    refreshNavCompletion();
  }
}

// ============================================================
// SECTION 1: SETUP
// ============================================================

/** Build a display label for a market row ("Chicago Metro, IL"). */
function marketLabel(m) {
  if (!m) return '';
  const name = m.name || m.market_name || m.abbr || (m.market_id || m.id);
  const state = m.state || '';
  return state ? `${name}, ${state}` : name;
}

/** Return "City, State" for the selected market id, or '' if no match. */
function deriveLocationString(marketId, markets) {
  if (!marketId || !Array.isArray(markets)) return '';
  const m = markets.find(x => (x.market_id || x.id) === marketId);
  return m ? marketLabel(m) : '';
}

// ============================================================
// v2 UI — Grouped sidebar nav renderer
// ============================================================

/**
 * Bucket the 18 nav sections into the 6 logical phases declared in
 * SECTION_GROUPS. Returns map keyed by group code → array of sections.
 */
function _sectionsByGroup() {
  const map = new Map();
  for (const g of SECTION_GROUPS) map.set(g.key, []);
  for (const s of SECTIONS) {
    if (!map.has(s.group)) map.set(s.group, []);
    map.get(s.group).push(s);
  }
  return map;
}

/**
 * Cheap per-section completion check. Returns 'complete' | 'partial' | 'empty'.
 * Today this is used to color a small dot next to each section and to roll
 * up into the group-header chip. Heuristic — not rigorous.
 */
function _sectionCompleteness(sectionKey) {
  const m = model || {};
  switch (sectionKey) {
    case 'setup': {
      const pd = m.projectDetails || {};
      const filled = ['name', 'clientName', 'market', 'environment', 'contractTerm']
        .filter(k => pd[k] !== null && pd[k] !== undefined && pd[k] !== '').length;
      if (filled === 5) return 'complete';
      if (filled === 0) return 'empty';
      return 'partial';
    }
    case 'volumes': {
      // Combined Volumes + Order Profile (Brock 2026-04-21 pm)
      const lines = m.volumeLines || [];
      const op = m.orderProfile || {};
      const hasVolumes = lines.length > 0;
      const hasStar = lines.some(v => v.isOutboundPrimary);
      const hasProfile = Boolean(op.linesPerOrder) && Boolean(op.unitsPerLine);
      if (!hasVolumes && !op.linesPerOrder && !op.unitsPerLine) return 'empty';
      return (hasVolumes && hasStar && hasProfile) ? 'complete' : 'partial';
    }
    case 'orderProfile':
      // Legacy route — nav entry removed but status queries may still hit it.
      return 'na';
    case 'facility':
      return (m.facility && m.facility.totalSqft > 0) ? 'complete' : 'empty';
    case 'shifts':
      return (m.shifts && m.shifts.shiftsPerDay > 0) ? 'complete' : 'empty';
    case 'shiftPlanning': {
      const a = m.shiftAllocation;
      if (!a || !a.matrix) return 'empty';
      const anyNonZero = Object.values(a.matrix || {}).some(row =>
        Array.isArray(row) && row.some(v => Number(v) > 0));
      if (!anyNonZero) return 'empty';
      return 'complete';
    }
    case 'labor':
      return (m.laborLines && m.laborLines.length > 0) ? 'complete' : 'empty';
    case 'equipment':
      return (m.equipmentLines && m.equipmentLines.length > 0) ? 'complete' : 'empty';
    case 'overhead':
      return (m.overheadLines && m.overheadLines.length > 0) ? 'complete' : 'empty';
    case 'vas':
      return (m.vasLines && m.vasLines.length > 0) ? 'complete' : 'empty';
    case 'startup': {
      // Start-Up / Capital: count any line with a nonzero cost. Blank rows
      // (auto-seeded placeholders with $0) don't count as "complete".
      const lines = m.startupLines || [];
      const hasReal = lines.some(l => (Number(l.one_time_cost) || 0) > 0 || (Number(l.amount) || 0) > 0);
      return hasReal ? 'complete' : (lines.length > 0 ? 'partial' : 'empty');
    }
    case 'financial':
      // NB: model writes `targetMargin` (see data-field="financial.targetMargin"
      // at line ~2106). Prior check read `targetMarginPct` — never true.
      return (m.financial && (m.financial.targetMargin || 0) > 0) ? 'complete' : 'empty';
    case 'pricingBuckets':
      return (m.pricingBuckets && m.pricingBuckets.length > 0) ? 'complete' : 'empty';
    case 'pricing':
      return (m.pricingBuckets && m.pricingBuckets.length > 0) ? 'complete' : 'empty';
    // Output / analysis sections are derived views — they have no "input"
    // to be complete. Return 'na' so the sidebar shows them as available,
    // not stuck empty. renderGroupedNav treats 'na' like 'complete' for
    // rollup purposes so the group counts aren't dragged down by views.
    case 'summary':
    case 'timeline':
    case 'scenarios':
    case 'whatif':
    case 'assumptions':
    case 'linked':
      return 'na';
    default:
      return 'empty';
  }
}

/**
 * Lightweight sidebar refresh — recomputes per-section completeness + group
 * rollups and mutates the existing DOM instead of re-rendering the whole nav.
 * Called from the field-change handler so that filling in a form flips the
 * check dot / group count immediately, without triggering a full section
 * re-render (which would blow away the user's focus and cursor position).
 */
function refreshNavCompletion() {
  if (!rootEl) return;
  const grouped = _sectionsByGroup();
  for (const g of SECTION_GROUPS) {
    const sections = grouped.get(g.key) || [];
    if (!sections.length) continue;
    let completeCount = 0;
    let inputSectionCount = 0;
    // 2026-04-21 live-walkthrough fix: OUTPUT group has 4 sections (Summary/
    // Pricing/Timeline/Scenarios) but only one has status != 'na' (pricing).
    // Previous logic showed "1/1" which read as a bug — user expects 4/4 when
    // everything is rendered. Fix: count derived-view sections as complete,
    // use the total section count as the denominator so the chip reflects
    // what the user sees in the list.
    let totalComplete = 0;
    for (const s of sections) {
      const status = _sectionCompleteness(s.key);
      if (status !== 'na') inputSectionCount += 1;
      if (status === 'complete') completeCount += 1;
      if (status === 'complete' || status === 'na') totalComplete += 1;
      // Per-section check dot — 'na' renders as complete (derived views).
      const check = rootEl.querySelector(`#cm-check-${s.key}`);
      if (check) check.classList.toggle('complete', status === 'complete' || status === 'na');
    }
    // Group-level rollup dot + count
    const groupEl = rootEl.querySelector(`[data-nav-group="${g.key}"]`);
    if (!groupEl) continue;
    const groupDot = inputSectionCount === 0                   ? 'complete'
                   : completeCount === inputSectionCount       ? 'complete'
                   : completeCount > 0                         ? 'partial'
                   : 'empty';
    const dot = groupEl.querySelector('.hub-completion-dot');
    if (dot) {
      dot.classList.remove('hub-completion-dot--complete', 'hub-completion-dot--partial', 'hub-completion-dot--empty');
      dot.classList.add(`hub-completion-dot--${groupDot}`);
    }
    const count = groupEl.querySelector('.hub-nav-group__count');
    if (count) {
      // Denominator = total sections in the group (input + derived).
      // Numerator  = sections that are complete OR 'na' (derived views
      // always count as rendered so they don't drag the count down).
      count.textContent = `${totalComplete}/${sections.length}`;
    }
  }
}

function renderGroupedNav() {
  const grouped = _sectionsByGroup();
  return SECTION_GROUPS.map(g => {
    const sections = grouped.get(g.key) || [];
    if (!sections.length) return '';
    const collapsed = _collapsedNavGroups.has(g.key);
    // 2026-04-21 audit: previously dropped derived views ('na') from the
    // denominator so OUTPUT (1 input + 3 derived) read "1/1" — misleading
    // when the user counts 4 items in the list. Now show total/total with
    // derived views counting as complete so the chip matches what's visible.
    const inputSections = sections.filter(s => _sectionCompleteness(s.key) !== 'na');
    const completeCount = inputSections.filter(s => _sectionCompleteness(s.key) === 'complete').length;
    const hasInputs = inputSections.length > 0;
    const totalComplete = sections.filter(s => {
      const st = _sectionCompleteness(s.key);
      return st === 'complete' || st === 'na';
    }).length;
    const groupDot = !hasInputs                           ? 'complete'
                    : completeCount === inputSections.length ? 'complete'
                    : completeCount > 0                   ? 'partial'
                    : 'empty';
    const countLabel = `${totalComplete}/${sections.length}`;
    return `
      <div class="hub-nav-group${collapsed ? ' is-collapsed' : ''}" data-nav-group="${g.key}">
        <button type="button" class="hub-nav-group__header" data-nav-group-toggle="${g.key}" title="${g.description}">
          <span class="hub-nav-group__caret">▾</span>
          <span>${g.label}</span>
          <span class="hub-completion-dot hub-completion-dot--${groupDot}"></span>
          ${countLabel ? `<span class="hub-nav-group__count">${countLabel}</span>` : ''}
        </button>
        <div class="hub-nav-group__items">
          ${sections.map(s => {
            const done = _sectionCompleteness(s.key);
            // 'na' renders as complete (green dot) — these are derived views
            const renderAsComplete = done === 'complete' || done === 'na';
            return `
              <div class="cm-nav-item${s.key === activeSection ? ' active' : ''}" data-section="${s.key}">
                <span class="cm-nav-check${renderAsComplete ? ' complete' : ''}" id="cm-check-${s.key}"></span>
                <span class="cm-nav-label">${s.label}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderSetup() {
  const pd = model.projectDetails;
  const markets = (refData.markets && refData.markets.length > 0) ? refData.markets : DEMO_MARKETS_FALLBACK;

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Project Setup</div>
        <div class="cm-section-desc">Define the project basics — client, market, environment, and contract term.</div>
      </div>
    </div>

    <div class="cm-narrow-form">
      <div class="hub-field hub-field--full">
        <label class="hub-field__label">Project Name</label>
        <input class="hub-input" id="cm-name" value="${pd.name || ''}" placeholder="e.g., Acme Ecommerce Fulfillment" data-field="projectDetails.name" />
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Client Name</label>
        <input class="hub-input" id="cm-client" value="${pd.clientName || ''}" placeholder="Client name" data-field="projectDetails.clientName" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Market</label>
        <select class="hub-input" id="cm-market" data-field="projectDetails.market">
          <option value="">Select market...</option>
          ${markets.map(m => {
            const id = m.market_id || m.id;
            const label = marketLabel(m);
            return `<option value="${id}"${id === pd.market ? ' selected' : ''}>${label}</option>`;
          }).join('')}
        </select>
        <div class="hub-field__hint">Drives city / state and facility rate lookup.</div>
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Environment</label>
        <select class="hub-input" id="cm-env" data-field="projectDetails.environment">
          <option value="">Select environment...</option>
          ${(() => {
            const options = [
              // Climate / facility classification
              { label: 'Ambient', value: 'ambient' },
              { label: 'Refrigerated', value: 'refrigerated' },
              { label: 'Freezer', value: 'freezer' },
              { label: 'Temperature Controlled', value: 'temperature_controlled' },
              // Vertical / customer type
              { label: 'Ecommerce', value: 'ecommerce' },
              { label: 'Retail', value: 'retail' },
              { label: 'Food & Beverage', value: 'food & beverage' },
              { label: 'Industrial', value: 'industrial' },
              { label: 'Pharmaceutical', value: 'pharmaceutical' },
              { label: 'Automotive', value: 'automotive' },
              { label: 'Consumer Goods', value: 'consumer goods' },
            ];
            const curLower = String(pd.environment || '').toLowerCase().trim();
            // Case-insensitive match so "Ambient" or "AMBIENT" from DB still selects
            return options.map(o =>
              `<option value="${o.value}"${curLower === o.value.toLowerCase() ? ' selected' : ''}>${o.label}</option>`
            ).join('');
          })()}
        </select>
      </div>
      <div class="hub-field">
        <label class="hub-field__label">City, State</label>
        <input class="hub-input" id="cm-location-display" value="${deriveLocationString(pd.market, markets) || pd.facilityLocation || ''}" placeholder="—" readonly style="background:var(--ies-gray-50);color:var(--ies-gray-500);" />
        <div class="hub-field__hint">Derived from selected market.</div>
      </div>

      <div class="hub-field">
        <label class="hub-field__label">Contract Term (Years)</label>
        <input class="hub-input" type="number" id="cm-term" value="${pd.contractTerm || 5}" min="1" max="20" step="1" data-field="projectDetails.contractTerm" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Link to Deal</label>
        <select class="hub-input" id="cm-deal" data-field="projectDetails.dealId">
          <option value="">— No linked deal —</option>
          ${savedDeals.map(d => {
            const label = d.deal_name + (d.client_name ? ` (${d.client_name})` : '');
            return `<option value="${d.id}"${d.id === pd.dealId ? ' selected' : ''}>${label}</option>`;
          }).join('')}
        </select>
        <div class="hub-field__hint">Optional. Links this cost model to a Deal Manager opportunity.</div>
      </div>
    </div>

    <!-- CM-SET-2 — Reference Data Status -->
    <div class="hub-card" style="margin-top:24px;padding:16px;border-left:3px solid var(--ies-blue);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-400);">Reference Data Status</div>
          <div style="font-size:12px;color:var(--ies-gray-500);margin-top:2px;">Counts of master data loaded from Supabase. The model can run on fallback defaults when these are empty, but seeded references unlock per-market facility / utility / labor rates and the equipment / overhead catalogs.</div>
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-cm-action="seed-default-refdata"
                title="Push the built-in industry defaults to Supabase: 20 markets, ~80 labor rate rows, 33 equipment catalog rows, 20 facility rate rows, 6 overhead categories. Existing rows are NOT overwritten — this only fills gaps. Idempotent.">⚡ Seed Defaults</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px;font-size:12px;">
        ${(() => {
          const cats = [
            ['Markets', refData.markets?.length || 0, 20],
            ['Labor rates', refData.laborRates?.length || 0, 60],
            ['Equipment catalog', refData.equipment?.length || 0, 33],
            ['Facility rates', refData.facilityRates?.length || 0, 20],
            ['Utility rates', refData.utilityRates?.length || 0, 20],
            ['Overhead rates', refData.overheadRates?.length || 0, 6],
            ['MOST templates', refData.mostTemplates?.length || 0, 30],
            ['Allowance profiles', refData.allowanceProfiles?.length || 0, 8],
          ];
          return cats.map(([label, count, target]) => {
            const pct = Math.min(100, Math.round((count / target) * 100));
            const ok = count >= target * 0.8;
            const empty = count === 0;
            const color = empty ? '#dc2626' : ok ? '#10b981' : '#d97706';
            return `
              <div style="border:1px solid var(--ies-gray-200);border-radius:6px;padding:8px 10px;">
                <div style="font-weight:700;color:${color};">${count}<span style="color:var(--ies-gray-400);font-weight:500;font-size:11px;"> / ${target} target</span></div>
                <div style="color:var(--ies-gray-500);">${label}</div>
                <div style="height:3px;background:var(--ies-gray-100);border-radius:2px;margin-top:4px;overflow:hidden;">
                  <div style="height:100%;width:${pct}%;background:${color};"></div>
                </div>
              </div>
            `;
          }).join('');
        })()}
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 2: VOLUMES
// ============================================================

// Brock 2026-04-21 pm: Volumes + Order Profile combined into a single
// "Volumes & Profile" page (both describe demand — how much + what shape).
function renderVolumes() {
  const lines = model.volumeLines || [];
  const op = model.orderProfile || {};
  // CM-VOL-1: derive daily-avg + peak-month tiles from primary outbound +
  // seasonality. Falls back gracefully when no primary set / no seasonality.
  const primaryLine = lines.find(l => l.isOutboundPrimary) || lines[0] || null;
  const annualVolume = primaryLine ? Number(primaryLine.volume) || 0 : 0;
  const opDaysPerYr = (model.facility && Number(model.facility.opDaysPerYear)) || 250;
  const dailyAvg = annualVolume > 0 && opDaysPerYr > 0 ? annualVolume / opDaysPerYr : 0;
  const sp = model.seasonalityProfile || {};
  const monthlyShares = Array.isArray(sp.monthly_shares) && sp.monthly_shares.length === 12
    ? sp.monthly_shares
    : SEASONALITY_PRESETS.flat;
  const peakIdx = monthlyShares.reduce((iMax, v, i, a) => v > a[iMax] ? i : iMax, 0);
  const peakShare = monthlyShares[peakIdx] || 0;
  const peakMonthVol = annualVolume * peakShare;
  const peakMonthLbl = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][peakIdx];
  const fmtN = (n) => n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? (n/1e3).toFixed(1) + 'K' : Math.round(n).toLocaleString();
  const primaryUom = primaryLine?.uom || 'units';
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Volumes &amp; Profile</div>
        <div class="cm-section-desc">Annual throughput (how much) and order shape (how it arrives). Both describe demand; together they drive labor hours, storage, and unit-cost metrics.</div>
      </div>
    </div>
    ${annualVolume > 0 ? `
    <div class="hub-kpi-bar mb-4">
      <div class="hub-kpi-item" title="Annual primary outbound volume / Operating days per year (${opDaysPerYr})">
        <div class="hub-kpi-label">Daily Avg</div>
        <div class="hub-kpi-value">${fmtN(dailyAvg)} <span style="font-size:11px;color:var(--ies-gray-500);font-weight:400;">${primaryUom}/day</span></div>
      </div>
      <div class="hub-kpi-item" title="Peak month volume — annual volume × the largest monthly share from the Seasonality Profile (${(peakShare*100).toFixed(1)}% in ${peakMonthLbl})">
        <div class="hub-kpi-label">Peak Month</div>
        <div class="hub-kpi-value">${fmtN(peakMonthVol)} <span style="font-size:11px;color:var(--ies-gray-500);font-weight:400;">${primaryUom} (${peakMonthLbl})</span></div>
      </div>
      <div class="hub-kpi-item" title="Peak / Daily-Avg ratio — uplift used by labor + dock + storage planning">
        <div class="hub-kpi-label">Peak Ratio</div>
        <div class="hub-kpi-value">${dailyAvg > 0 ? ((peakMonthVol / 21) / dailyAvg).toFixed(2) + 'x' : '—'}</div>
      </div>
    </div>
    ` : ''}

    <div class="hub-card mb-4">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;">
        <div class="text-subtitle" style="margin:0;">Annual Volumes</div>
        <span class="hub-field__hint">Star the primary outbound line for unit-cost metrics.</span>
      </div>
      <table class="cm-grid-table">
        <thead>
          <tr>
            <th style="width:30px;"></th>
            <th>Activity</th>
            <th>Annual Volume</th>
            <th>UOM</th>
            <th style="width:60px;"></th>
          </tr>
        </thead>
        <tbody id="cm-volume-rows">
          ${lines.map((l, i) => `
            <tr>
              <td><button class="cm-star-btn${l.isOutboundPrimary ? ' active' : ''}" data-idx="${i}" title="Set as primary outbound">&#9733;</button></td>
              <td>
                <div style="display:flex;align-items:center;gap:6px;">
                  <input value="${l.name || ''}" style="width:180px;" data-array="volumeLines" data-idx="${i}" data-field="name" />
                  ${l.source ? `<span class="cm-vol-src cm-vol-src--${l.source}" title="Volume source: ${l.source === 'wsc' ? 'pulled from Warehouse Sizing' : l.source === 'netopt' ? 'pulled from Network Optimizer' : 'manually entered'}">${l.source === 'wsc' ? 'WSC' : l.source === 'netopt' ? 'NETOPT' : 'MANUAL'}</span>` : ''}
                </div>
              </td>
              <td><input type="number" value="${l.volume || 0}" style="width:120px;" data-array="volumeLines" data-idx="${i}" data-field="volume" data-type="number" /></td>
              <td>
                <select style="width:90px;" data-array="volumeLines" data-idx="${i}" data-field="uom">
                  ${['pallets', 'cases', 'eaches', 'orders', 'lines', 'units'].map(u =>
                    `<option value="${u}"${l.uom === u ? ' selected' : ''}>${u}</option>`
                  ).join('')}
                </select>
              </td>
              <td><button class="cm-delete-btn" data-action="delete-volume" data-idx="${i}">Delete</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <button class="cm-add-row-btn" data-action="add-volume">+ Add Volume Line</button>
    </div>

    <div class="hub-card mb-4">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;">
        <div class="text-subtitle" style="margin:0;">Order Profile</div>
        <span class="hub-field__hint">Average order characteristics — drives UOM selection on pricing buckets and cost-per-unit math.</span>
      </div>
      <div class="cm-narrow-form" style="grid-template-columns:repeat(4, minmax(0, 1fr));">
        <div class="hub-field">
          <label class="hub-field__label">Lines Per Order</label>
          <input class="hub-input" type="number" value="${op.linesPerOrder || ''}" placeholder="e.g., 3.5" step="0.1" data-field="orderProfile.linesPerOrder" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label">Units Per Line</label>
          <input class="hub-input" type="number" value="${op.unitsPerLine || ''}" placeholder="e.g., 1.8" step="0.1" data-field="orderProfile.unitsPerLine" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label">Average Order Weight</label>
          <input class="hub-input" type="number" value="${op.avgOrderWeight || ''}" placeholder="e.g., 12.5" step="0.1" data-field="orderProfile.avgOrderWeight" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label">Weight Unit</label>
          <select class="hub-input" data-field="orderProfile.weightUnit">
            <option value="lbs"${op.weightUnit === 'lbs' || !op.weightUnit ? ' selected' : ''}>Pounds (lbs)</option>
            <option value="kg"${op.weightUnit === 'kg' ? ' selected' : ''}>Kilograms (kg)</option>
          </select>
        </div>
      </div>
    </div>

    ${renderSeasonalityProfileCard()}

    <style>
      .cm-star-btn { background: none; border: none; cursor: pointer; font-size: 18px; color: var(--ies-gray-300); }
      .cm-star-btn.active { color: var(--ies-orange); }
      .cm-star-btn:hover { color: var(--ies-orange); }
      /* CM-VOL-3 — volume-source chip */
      .cm-vol-src { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 9px; font-weight: 700; letter-spacing: 0.04em; }
      .cm-vol-src--wsc { background: rgba(32, 201, 151, 0.15); color: #117a55; border: 1px solid rgba(32,201,151,0.3); }
      .cm-vol-src--netopt { background: rgba(13, 110, 253, 0.12); color: #0c4ea2; border: 1px solid rgba(13,110,253,0.3); }
      .cm-vol-src--manual { background: rgba(108, 117, 125, 0.12); color: #495057; border: 1px solid rgba(108,117,125,0.3); }
      .cm-season-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 4px; margin-top: 12px; }
      .cm-season-cell { display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
      .cm-season-cell label { font-size: 10px; font-weight: 700; color: var(--ies-gray-500); text-align: center; text-transform: uppercase; }
      .cm-season-cell input { text-align: center; font-variant-numeric: tabular-nums; padding: 4px 2px; }
      .cm-season-cell--peak input { background: rgba(217,119,6,0.10); border-color: var(--ies-orange, #d97706); font-weight: 700; }
      .cm-season-summary { display: flex; align-items: center; gap: 18px; margin-top: 10px; font-size: 12px; color: var(--ies-gray-600); }
      .cm-season-summary__sum--bad { color: #dc2626; font-weight: 700; }
      .cm-season-summary__sum--good { color: #16a34a; font-weight: 700; }
    </style>
  `;
}

/**
 * Seasonality Profile editor card (2026-04-22 PM, Brock).
 *
 * Closes the gap identified during the Phase 2d live demo: the project-level
 * `model.seasonalityProfile` field was read in 5 places but never written by
 * the UI, forcing users into SQL to enable seasonality. This card exposes:
 *   - Preset dropdown (Flat / E-com Holiday / Cold Chain / Apparel 2-Peak)
 *   - 12 per-month % inputs with tabular-nums alignment
 *   - Σ summary + peak/avg ratio + validity badge
 *   - Apply-preset + Reset buttons
 *
 * Data flow: writes to model.seasonalityProfile.monthly_shares[]. That bubbles
 * downstream into MLV (non-flat FTE distribution) → syncSeasonalFlex CTA →
 * Phase 2d auto-gen rental siblings → monthly engine series → Summary Peak
 * Rentals annotation.
 */
function renderSeasonalityProfileCard() {
  const sp = model.seasonalityProfile || {};
  const shares = Array.isArray(sp.monthly_shares) && sp.monthly_shares.length === 12
    ? sp.monthly_shares.slice()
    : new Array(12).fill(1 / 12);
  const presetName = sp.preset || (Array.isArray(sp.monthly_shares) ? 'custom' : 'flat');
  const sumPct = shares.reduce((a, b) => a + (Number(b) || 0), 0) * 100;
  const sumValid = Math.abs(sumPct - 100) < 0.5;
  const peakMonth = shares.indexOf(Math.max(...shares));
  const avg = shares.reduce((a, b) => a + b, 0) / 12;
  const peakOverAvg = avg > 0 ? (shares[peakMonth] / avg) : 1;
  const MONTH_ABBR = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  const MONTH_FULL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `
    <div class="hub-card mb-4">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;gap:12px;flex-wrap:wrap;">
        <div class="text-subtitle" style="margin:0;">Seasonality Profile</div>
        <span class="hub-field__hint" style="flex:1;min-width:200px;">Monthly volume shares drive the MLV peak-vs-baseline derivation, sync-to-equipment flex, and Phase 2d rental auto-gen. Sums must equal 100%.</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;">
        <div class="hub-field" style="min-width:220px;">
          <label class="hub-field__label">Preset</label>
          <select class="hub-input" data-field="seasonalityProfile.preset" data-cm-action="seasonality-preset-change">
            <option value="flat"${presetName === 'flat' ? ' selected' : ''}>Flat (1/12 per month)</option>
            <option value="ecom_holiday_peak"${presetName === 'ecom_holiday_peak' ? ' selected' : ''}>E-com Holiday Peak (Q4 heavy)</option>
            <option value="cold_chain_food"${presetName === 'cold_chain_food' ? ' selected' : ''}>Cold Chain Food (Thanksgiving/Christmas)</option>
            <option value="apparel_2peak"${presetName === 'apparel_2peak' ? ' selected' : ''}>Apparel 2-Peak (spring + fall)</option>
            <option value="custom"${presetName === 'custom' ? ' selected' : ''}>Custom (hand-edited)</option>
          </select>
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="seasonality-reset" title="Reset to Flat (1/12 per month)">↺ Reset to Flat</button>
      </div>
      <div class="cm-season-grid">
        ${shares.map((v, i) => `
          <div class="cm-season-cell${i === peakMonth && shares[peakMonth] > 1/12 ? ' cm-season-cell--peak' : ''}" title="${MONTH_FULL[i]}">
            <label>${MONTH_ABBR[i]}</label>
            <input class="hub-input hub-num" type="number" min="0" max="100" step="0.1"
              value="${(Number(v) * 100).toFixed(1)}"
              data-cm-action="seasonality-month" data-idx="${i}"
              title="${MONTH_FULL[i]} share of annual volume" />
          </div>
        `).join('')}
      </div>
      <div class="cm-season-summary">
        <span>Σ <span class="${sumValid ? 'cm-season-summary__sum--good' : 'cm-season-summary__sum--bad'}">${sumPct.toFixed(1)}%</span>${sumValid ? ' ✓' : ' — must equal 100%'}</span>
        <span>Peak: <strong>${MONTH_FULL[peakMonth]}</strong> (${(shares[peakMonth] * 100).toFixed(1)}%)</span>
        <span>Peak / avg: <strong>${(peakOverAvg * 100).toFixed(0)}%</strong></span>
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 3: ORDER PROFILE (merged into Volumes 2026-04-21 pm — stub
// retained for the 'orderProfile' nav key in case legacy routes hit it)
// ============================================================

function renderOrderProfile() {
  // Delegate to combined Volumes renderer — both sections live there now.
  return renderVolumes();
}

// ============================================================
// SECTION 4: FACILITY
// ============================================================

function renderFacility() {
  const f = model.facility || {};
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Facility</div>
        <div class="cm-section-desc">Warehouse dimensions and infrastructure. Facility cost is calculated from market rates.</div>
      </div>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="launch-wsc">Size with Calculator →</button>
    </div>

    <div class="cm-narrow-form" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
      <div class="hub-field">
        <label class="hub-field__label">Total Square Footage</label>
        <input class="hub-input" type="number" value="${f.totalSqft || ''}" placeholder="e.g., 150000" step="1000" data-field="facility.totalSqft" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Clear Height (ft)</label>
        <input class="hub-input" type="number" value="${f.clearHeight || ''}" placeholder="e.g., 32" step="1" data-field="facility.clearHeight" data-type="number" />
      </div>
      <div class="hub-field">
        <label class="hub-field__label">Dock Doors</label>
        <input class="hub-input" type="number" value="${f.dockDoors || ''}" placeholder="e.g., 24" step="1" data-field="facility.dockDoors" data-type="number" />
      </div>
    </div>

    <!-- Design policy inputs — drive the Equipment auto-generator per
         Asset Defaults Guidance (2026-04-20). Automation level gates
         conveyor; security tier gates CCTV / access control / guard shack;
         fenced perimeter adds physical fencing as capital. -->
    <div class="hub-card mt-4">
      <div class="text-subtitle mb-3">Design Policy</div>
      <div class="cm-narrow-form" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
        <div class="hub-field">
          <label class="hub-field__label" title="Drives conveyor auto-add. None = manual. Low = minor aids (accordion conveyor). Medium = powered conveyor for pack/takeaway. High = full sortation + pick-to-light.">Automation Level</label>
          <select class="hub-input" data-field="facility.automationLevel">
            ${['none','low','medium','high'].map(v => `<option value="${v}"${(f.automationLevel || 'none') === v ? ' selected' : ''}>${v.charAt(0).toUpperCase() + v.slice(1)}</option>`).join('')}
          </select>
          <div class="hub-field__hint">Conveyor auto-adds at Medium/High.</div>
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Drives security auto-add. Tier 1 = alarm only. Tier 2 = + CCTV (TI). Tier 3 = + access control (TI; default). Tier 4 = + guard shack + gate (capital).">Security Tier</label>
          <select class="hub-input" data-field="facility.securityTier" data-type="number">
            ${[1,2,3,4].map(v => `<option value="${v}"${Number(f.securityTier ?? 3) === v ? ' selected' : ''}>Tier ${v}</option>`).join('')}
          </select>
          <div class="hub-field__hint">Default: 3 (CCTV + access control).</div>
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Linear feet of perimeter fencing. If > 0, auto-adds Capital fencing at ~$52/LF.">Fenced Perimeter (LF)</label>
          <input class="hub-input" type="number" value="${f.fencedPerimeterLf || 0}" placeholder="0" step="100" data-field="facility.fencedPerimeterLf" data-type="number" />
          <div class="hub-field__hint">0 = no fencing.</div>
        </div>
      </div>

      <!-- Security Tier comparison panel (Brock 2026-04-21 pm finance-review
           readiness). Shows exactly what each tier adds so reviewers don't
           have to flip the dropdown. Active tier highlighted. -->
      <details class="mt-3" style="border:1px solid var(--ies-gray-200);border-radius:6px;padding:0;">
        <summary style="padding:8px 12px;cursor:pointer;font-size:12px;font-weight:600;color:var(--ies-gray-700);background:var(--ies-gray-50);border-radius:6px 6px 0 0;user-select:none;">What changes at each Security Tier?</summary>
        <div style="padding:12px;">
          <div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:8px;font-size:11px;">
            ${[
              { tier: 1, name: 'Alarm + basics',       adds: ['Burglar alarm', 'Door controls ($75/door)', 'Overhead-door locks ($10/each)', 'Ramp-door mgmt ($300/door)', 'Signage + driver cages', 'C-TPAT baseline'], cost: '$7–12K base', financing: 'Capital' },
              { tier: 2, name: '+ CCTV',                adds: ['Camera head-end ($20K)', 'Cameras ($1,562/each)'], cost: '+$20K + $1.6K/cam', financing: 'TI' },
              { tier: 3, name: '+ Access control',      adds: ['Access control head-end ($20K)', 'Badge readers ($1,150/each)', 'Employee entrance ($2.5K)', 'Metal detectors ($5K)'], cost: '+$27K typical', financing: 'TI' },
              { tier: 4, name: '+ Guard-shack full',    adds: ['External guard shack ($43K)', 'Gate automation ($25K)'], cost: '+$68K', financing: 'Capital' },
            ].map(t => {
              const active = Number(f.securityTier ?? 3) === t.tier;
              return `
                <div style="padding:10px;border-radius:6px;border:${active ? '2px solid var(--ies-blue)' : '1px solid var(--ies-gray-200)'};background:${active ? '#ecf5ff' : '#fff'};">
                  <div style="font-weight:700;color:${active ? 'var(--ies-blue)' : 'var(--ies-gray-700)'};margin-bottom:4px;">Tier ${t.tier}${active ? ' ✓' : ''} — ${t.name}</div>
                  <ul style="margin:0;padding-left:14px;color:var(--ies-gray-600);line-height:1.45;">
                    ${t.adds.map(a => `<li>${a}</li>`).join('')}
                  </ul>
                  <div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--ies-gray-200);color:var(--ies-gray-500);">
                    <strong style="color:var(--ies-gray-700);">${t.cost}</strong> · ${t.financing}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <div style="margin-top:10px;font-size:11px;color:var(--ies-gray-500);font-style:italic;">
            Tiers are cumulative — Tier 3 includes Tier 2 includes Tier 1.
            Reference: Cost Model Planning Heuristics doc §3.6. Regulated verticals (pharma, hazmat) default to Tier 4; specialty retail to Tier 3; general warehousing can drop to Tier 2.
          </div>
        </div>
      </details>
    </div>

    ${renderFacilityOverridePanel()}
    ${renderFacilityCostCard()}
  `;
}

/**
 * CM-FAC-1 (2026-04-25): per-deal override panel for facility seed rates.
 * Lets users override the market lease+CAM+tax+insurance bundle, the utility
 * rate, and tack on a maintenance/repair %. All three fields are optional —
 * blank means "use the market seed". Stored on model.facility.overrides.
 */
function renderFacilityOverridePanel() {
  const ov = (model.facility && model.facility.overrides) || {};
  const _hasOv = (k) => ov[k] != null && Number.isFinite(Number(ov[k])) && Number(ov[k]) >= 0;
  const hasAny = ['ratePerSfYr','utilPerSfMo','maintPct'].some(_hasOv);
  return `
    <details class="hub-card mt-4" ${hasAny ? 'open' : ''} style="border:1px solid var(--ies-gray-200);">
      <summary style="cursor:pointer;font-weight:600;padding:4px 0;display:flex;align-items:center;justify-content:space-between;">
        <span>Override Market Rates ${hasAny ? '<span style="font-size:11px;color:#92400e;background:#fef3c7;padding:2px 6px;border-radius:3px;margin-left:6px;">Active</span>' : '<span style="font-size:11px;color:var(--ies-gray-500);font-weight:400;margin-left:6px;">— optional, per-deal adjustments</span>'}</span>
      </summary>
      <div style="padding-top:10px;">
        <div class="cm-narrow-form" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
          <div class="hub-field">
            <label class="hub-field__label" title="Replaces lease + CAM + tax + insurance combined ($/SF/Yr). Useful when you have a known all-in rent number.">Rent ($/SF/Yr)</label>
            <input class="hub-input" type="number" step="0.10" min="0" value="${_hasOv('ratePerSfYr') ? ov.ratePerSfYr : ''}" placeholder="market" data-field="facility.overrides.ratePerSfYr" data-type="number" />
            <div class="hub-field__hint">Blank = use market</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Replaces market utility rate ($/SF/Mo).">Utilities ($/SF/Mo)</label>
            <input class="hub-input" type="number" step="0.01" min="0" value="${_hasOv('utilPerSfMo') ? ov.utilPerSfMo : ''}" placeholder="market" data-field="facility.overrides.utilPerSfMo" data-type="number" />
            <div class="hub-field__hint">Blank = use market</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Maintenance/repair as % of base rent (industry typical 0.5–2%). Adds on top of base rent.">Maintenance %</label>
            <input class="hub-input" type="number" step="0.1" min="0" value="${_hasOv('maintPct') ? ov.maintPct : ''}" placeholder="0" data-field="facility.overrides.maintPct" data-type="number" />
            <div class="hub-field__hint">% of base rent</div>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;justify-content:flex-end;">
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="clear-facility-overrides" ${hasAny ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>Clear all overrides</button>
        </div>
      </div>
    </details>
  `;
}

function renderFacilityCostCard() {
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const tiAmort = calc.tiAmortAnnual(model.equipmentLines || [], model.projectDetails?.contractTerm || 5);
  const bd = calc.facilityCostBreakdown(model.facility || {}, fr, ur, { tiAmort });

  if (bd.total === 0 && !market) {
    return `<div class="hub-card mt-4" style="background: var(--ies-gray-50);"><p class="text-body text-muted">Select a market in Setup to see facility cost calculations.</p></div>`;
  }

  const sqft = (model.facility?.totalSqft || 0);
  const ovFlags = bd.overrideFlags || {};
  const amberCellStyle = 'background:#fef3c7;';
  // When rent override is active, collapse the four base-rent rows into a single Rent row.
  const baseRentRows = ovFlags.rent
    ? `<tr title="Override active — replaces lease + CAM + tax + insurance" style="${amberCellStyle}">
         <td>Rent (override)</td>
         <td class="cm-num">${sqft > 0 ? (bd.lease / sqft).toFixed(2) : '0.00'}</td>
         <td class="cm-num">${calc.formatCurrency(bd.lease)}</td>
       </tr>`
    : `<tr><td>Lease</td><td class="cm-num">${(fr?.lease_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.lease)}</td></tr>
       <tr><td>CAM</td><td class="cm-num">${(fr?.cam_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.cam)}</td></tr>
       <tr><td>Property Tax</td><td class="cm-num">${(fr?.tax_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.tax)}</td></tr>
       <tr><td>Insurance</td><td class="cm-num">${(fr?.insurance_rate_psf_yr || 0).toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.insurance)}</td></tr>`;
  const utilStyle = ovFlags.util ? `style="${amberCellStyle}"` : '';
  const utilLabel = ovFlags.util ? 'Utilities (override)' : 'Utilities';
  const utilPsf = ovFlags.util && sqft > 0 ? (bd.utility / sqft) : ((ur?.avg_monthly_per_sqft || 0) * 12);
  return `
    <div class="hub-card mt-4">
      <div class="text-subtitle mb-4">Annual Facility Cost Breakdown</div>
      <table class="cm-grid-table">
        <thead><tr><th>Component</th><th class="cm-num">$/PSF/Yr</th><th class="cm-num">Annual Cost</th></tr></thead>
        <tbody>
          ${baseRentRows}
          <tr ${utilStyle}><td>${utilLabel}</td><td class="cm-num">${utilPsf.toFixed(2)}</td><td class="cm-num">${calc.formatCurrency(bd.utility)}</td></tr>
          ${ovFlags.maint ? `<tr title="Maintenance/repair add-on (% of base rent)" style="${amberCellStyle}">
            <td>Maintenance (override)</td>
            <td class="cm-num">${sqft > 0 ? (bd.maintenance / sqft).toFixed(2) : '0.00'}</td>
            <td class="cm-num">${calc.formatCurrency(bd.maintenance)}</td>
          </tr>` : ''}
          ${bd.tiAmort > 0 ? `
            <tr title="TI (Tenant Improvement) items from Equipment — dock levelers, office build-out, CCTV, etc. — amortize through rent over the contract term per Asset Defaults Guidance.">
              <td>TI Amortization <span style="font-size:11px;color:var(--ies-gray-400);">(contract term)</span></td>
              <td class="cm-num">${((bd.tiAmort / ((model.facility?.totalSqft || 1))) || 0).toFixed(2)}</td>
              <td class="cm-num">${calc.formatCurrency(bd.tiAmort)}</td>
            </tr>
          ` : ''}
          <tr class="cm-total-row"><td>Total</td><td></td><td class="cm-num">${calc.formatCurrency(bd.total)}</td></tr>
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================
// SECTION 5: SHIFTS
// ============================================================

function renderShifts() {
  // Renamed Shifts → Labor Factors (Brock 2026-04-20). Section key stays
  // 'shifts' for persistence compatibility; only the label changes.
  const s = model.shifts || (model.shifts = {});
  const lc = model.laborCosting || (model.laborCosting = {});
  // Brock 2026-04-21 pm: PTO hours + Holiday hours are the primary inputs
  // (editable ints). Annual Paid Hours / FTE stays the constant 2,080.
  // Productive = 2,080 − PTO hrs − Holiday hrs.
  const paidHrs = calc.ANNUAL_PAID_HOURS_PER_FTE;
  const opHrs = paidHrs;
  const ptoHrs      = Math.max(0, Math.round(Number(s.ptoHoursPerYear     ?? 80)));
  const holidayHrs  = Math.max(0, Math.round(Number(s.holidayHoursPerYear ?? 64)));
  const productiveHrs = Math.max(0, paidHrs - ptoHrs - holidayHrs);
  // Legacy fractions for calc-layer compat (calc engine still consumes ptoPct)
  const ptoFrac     = ptoHrs / paidHrs;
  const holidayFrac = holidayHrs / paidHrs;
  // Keep legacy fields in sync so calc adapters + scenario snapshots stay valid
  s.ptoPct     = Math.round(ptoFrac     * 1000) / 10; // 1-decimal %
  s.holidayPct = Math.round(holidayFrac * 1000) / 10;
  // Seed Benefit Load buckets (Brock 2026-04-21 pm — segments the prior flat
  // Wage Load into Payroll Taxes / Workers Comp / Health & Welfare /
  // Retirement / Other Leave & Misc). Sum drives the calc engine via
  // `defaultBurdenPct`. If the project pre-dates buckets, preserve the legacy
  // total by proportionally scaling the standard splits.
  if (lc.benefitLoadPayrollTaxesPct == null
      && lc.benefitLoadWorkersCompPct == null
      && lc.benefitLoadHealthWelfarePct == null) {
    const legacyTotal = Number(lc.defaultBurdenPct);
    const STD = { taxes: 8.5, wc: 3.5, health: 10, retire: 4, other: 6 }; // sums to 32
    if (Number.isFinite(legacyTotal) && legacyTotal > 0 && Math.abs(legacyTotal - 32) > 0.5) {
      const scale = legacyTotal / 32;
      lc.benefitLoadPayrollTaxesPct  = Math.round(STD.taxes  * scale * 100) / 100;
      lc.benefitLoadWorkersCompPct   = Math.round(STD.wc     * scale * 100) / 100;
      lc.benefitLoadHealthWelfarePct = Math.round(STD.health * scale * 100) / 100;
      lc.benefitLoadRetirementPct    = Math.round(STD.retire * scale * 100) / 100;
      lc.benefitLoadOtherPct         = Math.round(STD.other  * scale * 100) / 100;
    } else {
      lc.benefitLoadPayrollTaxesPct  = STD.taxes;
      lc.benefitLoadWorkersCompPct   = STD.wc;
      lc.benefitLoadHealthWelfarePct = STD.health;
      lc.benefitLoadRetirementPct    = STD.retire;
      lc.benefitLoadOtherPct         = STD.other;
    }
  }
  const benefitLoadTotalPct = computeBenefitLoadTotal(lc);
  // Total drives calc.defaultBurdenPct — the value the calc engine consumes
  lc.defaultBurdenPct = Math.round(benefitLoadTotalPct * 100) / 100;
  const positions = Array.isArray(s.positions) ? s.positions : [];
  const directCount = positions.filter(p => p.category === 'direct').length;
  const indirectCount = positions.filter(p => p.category === 'indirect').length;

  const posRow = (p, i) => {
    const isExpanded = !!(p.id && _expandedPositionIds.has(p.id));
    const noteText = (p.notes || '').trim();
    const hasNote = noteText.length > 0;
    const previewLen = 28;
    const preview = hasNote
      ? (noteText.length > previewLen ? noteText.slice(0, previewLen) + '…' : noteText)
      : '+ Add note';
    const noteBtnLabel = hasNote
      ? `<span style="font-size:13px;line-height:1;">📝</span> <span class="cm-pos-note-preview">${_esc(preview)}</span>`
      : `<span class="cm-pos-note-empty">${_esc(preview)}</span>`;
    const chevron = isExpanded ? '▾' : '▸';
    const noteBtnTitle = hasNote
      ? 'Click to edit this position\'s notes'
      : 'Click to add notes for this position';
    const mainRow = `
    <tr${isExpanded ? ' class="cm-pos-row-expanded"' : ''}>
      <td><input class="hub-input" value="${_esc(p.name || '')}" data-array="shifts.positions" data-idx="${i}" data-field="name" /></td>
      <td>
        <select class="hub-input" data-array="shifts.positions" data-idx="${i}" data-field="category">
          <option value="direct"${(p.category || 'direct') === 'direct' ? ' selected' : ''}>Direct</option>
          <option value="indirect"${p.category === 'indirect' ? ' selected' : ''}>Indirect</option>
        </select>
      </td>
      <td>
        <select class="hub-input" data-array="shifts.positions" data-idx="${i}" data-field="employment_type">
          <option value="permanent"${(p.employment_type || 'permanent') === 'permanent' ? ' selected' : ''}>Permanent</option>
          <option value="temp_agency"${p.employment_type === 'temp_agency' ? ' selected' : ''}>Temp Agency</option>
          <option value="contractor"${p.employment_type === 'contractor' ? ' selected' : ''}>Contractor</option>
        </select>
      </td>
      <td class="cm-currency-cell">
        <span class="cm-currency-prefix">$</span>
        <input class="hub-input hub-num cm-currency-input" type="number" step="0.25" min="0" value="${p.hourly_wage || 0}" data-array="shifts.positions" data-idx="${i}" data-field="hourly_wage" data-type="number" title="Starting hourly wage (before benefits load)" ${p.is_salaried ? 'disabled title="Salaried position — uses Salary instead"' : ''} />
      </td>
      <td><input class="hub-input hub-num" type="number" step="1" min="0" max="100" value="${p.temp_markup_pct || 0}" data-array="shifts.positions" data-idx="${i}" data-field="temp_markup_pct" data-type="number" ${p.employment_type !== 'temp_agency' ? 'disabled title="Only applies to Temp Agency positions"' : 'title="Temp agency markup on top of the base wage"'} /></td>
      <td>
        <input type="checkbox" data-array="shifts.positions" data-idx="${i}" data-field="is_salaried" data-type="checkbox"${p.is_salaried ? ' checked' : ''} title="Salaried (uses annual_salary, not hourly_wage × hours)" />
      </td>
      <td class="cm-currency-cell">
        <span class="cm-currency-prefix">$</span>
        <input class="hub-input hub-num cm-currency-input" type="number" step="1000" min="0" value="${p.annual_salary || 0}" data-array="shifts.positions" data-idx="${i}" data-field="annual_salary" data-type="number" ${!p.is_salaried ? 'disabled title="Only applies when Salaried is checked"' : ''} />
      </td>
      <td><input class="hub-input hub-num" type="number" step="0.25" min="0" max="100" value="${p.bonus_pct ?? ''}" placeholder="${s.bonusPct ?? 5}" data-array="shifts.positions" data-idx="${i}" data-field="bonus_pct" data-type="number" title="Leave blank to inherit global bonus %" /></td>
      <td><input class="hub-input hub-num" type="number" step="0.25" min="0" max="100" value="${p.benefit_load_pct ?? ''}" placeholder="${(lc.defaultBurdenPct ?? 32).toFixed(1)}" data-array="shifts.positions" data-idx="${i}" data-field="benefit_load_pct" data-type="number" title="Per-position Benefit Load %. Blank = inherit global total from buckets above. Salaried roles often have higher load (health + retirement); hourly lower." /></td>
      <td>
        <button type="button"
                class="cm-pos-note-btn${hasNote ? ' cm-pos-note-btn--filled' : ' cm-pos-note-btn--empty'}${isExpanded ? ' cm-pos-note-btn--open' : ''}"
                data-action="toggle-position-notes" data-idx="${i}"
                title="${noteBtnTitle}">
          <span class="cm-pos-note-chev">${chevron}</span> ${noteBtnLabel}
        </button>
      </td>
      <td><button class="cm-delete-btn" data-action="delete-position" data-idx="${i}" title="Delete position">×</button></td>
    </tr>
  `;
    if (!isExpanded) return mainRow;
    const notesRow = `
    <tr class="cm-pos-notes-row">
      <td colspan="11" style="padding:0;background:var(--ies-gray-50, #f9fafb);">
        <div style="padding:12px 16px;border-top:1px dashed var(--ies-gray-200, #e5e7eb);">
          <label class="hub-field__label" style="display:block;margin-bottom:6px;font-size:12px;color:var(--ies-gray-600, #475569);">
            Notes — <strong>${_esc(p.name || 'Untitled position')}</strong>
            <span class="hub-field__hint" style="font-weight:400;margin-left:6px;">Free-form. Saves on focus loss.</span>
          </label>
          <textarea class="hub-input cm-pos-notes-textarea"
                    rows="3"
                    style="width:100%;min-height:64px;resize:vertical;font-family:inherit;font-size:13px;line-height:1.45;"
                    placeholder="e.g., 1 per 2-shift 8K-order/day op · backfilled by Group Leads · only on peak days"
                    data-array="shifts.positions" data-idx="${i}" data-field="notes"
                    data-field-commit="change">${_esc(p.notes || '')}</textarea>
        </div>
      </td>
    </tr>
  `;
    return mainRow + notesRow;
  };

  return `
    <div class="cm-wide-layout">
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Labor Factors</div>
        <div class="cm-section-desc">Global labor economics (PTO, holidays, benefit load, overtime, shift premiums) + the <strong>position catalog</strong> that drives per-activity rates in the Labor section. Change a position's wage here and every labor line using that position updates automatically.</div>
      </div>
    </div>

    <!-- Shift Structure — same card as on Shift Planning. Surfaced here too
         because these fields are the most fundamental labor-calc inputs: they
         define operating hrs/yr, which is the denominator for every FTE and
         every annual_hours rollup. Editing in either location updates the
         same model.shifts.* fields via data-field. (Brock 2026-04-22 EVE.) -->
    <div class="mb-4">
      ${shiftPlannerUi.renderStructureCard(model.shifts, { mount: 'labor' })}
    </div>

    <!-- Wage Factors (shift premiums, PTO, holiday hours) -->
    <!-- 2026-04-22 IA reshuffle: this card used to be called "Shift
         Structure" and held shifts/day + workweek pattern. Those fields
         moved to Shift Planner. What remains is pure wage-factor
         economics — premiums + paid-time-off hours that drive the
         Productive Hours tile. -->
    <div class="hub-card mb-4">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin:0 0 12px;gap:12px;">
        <div class="text-subtitle" style="margin:0;">Wage Factors</div>
        <span class="hub-field__hint">US FT reference: 2,080 paid hrs / FTE. PTO &amp; holiday hours subtract to give Productive.</span>
      </div>
      <!-- IA 2026-04-22: Shifts/Day + Workweek Pattern moved to Shift Planner
           under "Shift Structure" card. Labor Factors retains only labor
           COSTING: premiums, PTO, holiday, benefit load, OT, turnover,
           position catalog. -->
      <!-- Row 1: shift wage premiums -->
      <div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:12px;margin-bottom:12px;">
        <div class="hub-field">
          <label class="hub-field__label" title="Pay premium applied to 2nd-shift hours. Shift structure (shifts/day, workweek pattern) lives on Shift Planner.">2nd Shift Premium %</label>
          <input class="hub-input" type="number" value="${s.shift2Premium || 0}" min="0" max="50" step="0.5" data-field="shifts.shift2Premium" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Pay premium applied to 3rd-shift hours. Shift structure (shifts/day, workweek pattern) lives on Shift Planner.">3rd Shift Premium %</label>
          <input class="hub-input" type="number" value="${s.shift3Premium || 0}" min="0" max="50" step="0.5" data-field="shifts.shift3Premium" data-type="number" />
        </div>
        <div></div>
        <div></div>
      </div>
      <!-- Row 2: PTO + Holiday hours (the inputs that drive Productive) -->
      <div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:12px;margin-bottom:12px;">
        <div class="hub-field">
          <label class="hub-field__label" title="Paid Time Off (vacation + personal days) — hours per FTE per year. Default 80 = 10 days × 8 hrs. Typical 80-120. Editable per region/role. Subtracts from 2,080 paid hours → Productive.">PTO Hours / Year</label>
          <input class="hub-input" type="number" min="0" max="400" step="8" value="${ptoHrs}" data-field="shifts.ptoHoursPerYear" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Paid holidays — hours per FTE per year. Default 64 = 8 holidays × 8 hrs. Some regions observe more/fewer. Subtracts from 2,080 paid hours → Productive.">Holiday Hours / Year</label>
          <input class="hub-input" type="number" min="0" max="200" step="8" value="${holidayHrs}" data-field="shifts.holidayHoursPerYear" data-type="number" />
        </div>
        <div></div>
        <div></div>
      </div>
      <!-- Row 3: tiles with inline math -->
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:12px;">
        <div class="cm-opshours-card" style="margin:0;" title="US FT standard — 2,080 paid hrs/yr per FTE. Constant across all facility patterns (8×5×52, 4×10, 24/7-with-rotation all sum to 2,080).">
          <div class="cm-opshours-card__label">Annual Paid Hours / FTE</div>
          <div class="cm-opshours-card__value">${paidHrs.toLocaleString()}</div>
          <div class="cm-opshours-card__formula">US FT standard</div>
        </div>
        <div class="cm-opshours-card" style="margin:0;" title="2,080 − PTO hrs (${ptoHrs}) − Holiday hrs (${holidayHrs}) = ${productiveHrs}.">
          <div class="cm-opshours-card__label">Productive Hours / FTE</div>
          <div class="cm-opshours-card__value" style="color:var(--ies-blue);">${productiveHrs.toLocaleString()}</div>
          <div class="cm-opshours-card__formula">= 2,080 − ${ptoHrs} PTO − ${holidayHrs} Holiday</div>
        </div>
      </div>
    </div>

    <!-- Benefit Load + Global Economics -->
    <!-- Brock 2026-04-21 pm: Wage Load → Benefit Load (rename) + segmented
         into 5 buckets (Payroll Taxes / Workers Comp / Health & Welfare /
         Retirement / Other Leave & Misc). Total drives the calc engine.
         Year-scheduled schedule removed; per-position overrides live in
         the Position Catalog below.
         PTO + Holiday are now hour inputs (default 80 / 64). No
         Holiday Treatment dropdown — hours always subtract from 2,080. -->
    <div class="hub-card mb-4">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div>
          <div class="text-subtitle" style="margin:0;">Benefit Load %</div>
          <div class="hub-field__hint">Employer-side loaded costs on top of base wage. Buckets sum to the Total below. Per-position overrides live in the Position Catalog.</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding:6px 12px;background:var(--ies-gray-50);border:1px solid var(--ies-gray-200);border-radius:6px;">
          <span style="font-size:11px;text-transform:uppercase;color:var(--ies-gray-500);letter-spacing:0.5px;">Total Benefit Load</span>
          <strong style="font-size:16px;color:var(--ies-blue);">${benefitLoadTotalPct.toFixed(2)}%</strong>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5, minmax(0, 1fr));gap:12px;">
        <div class="hub-field">
          <label class="hub-field__label" title="FICA (7.65%) + FUTA + SUTA. Employer share of payroll taxes on base wage + OT + bonus.">Payroll Taxes %</label>
          <input class="hub-input" type="number" min="0" max="20" step="0.25" value="${lc.benefitLoadPayrollTaxesPct ?? 8.5}" data-field="laborCosting.benefitLoadPayrollTaxesPct" data-type="number" data-recompute-benefit-load="true" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Workers' compensation insurance. Varies by state + job risk class (warehouse typical 2.5-5%).">Workers Comp %</label>
          <input class="hub-input" type="number" min="0" max="15" step="0.25" value="${lc.benefitLoadWorkersCompPct ?? 3.5}" data-field="laborCosting.benefitLoadWorkersCompPct" data-type="number" data-recompute-benefit-load="true" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Medical + dental + vision + employer-paid life/LTD. Typical 8-12% for 3PL. Higher for salaried.">Health &amp; Welfare %</label>
          <input class="hub-input" type="number" min="0" max="25" step="0.25" value="${lc.benefitLoadHealthWelfarePct ?? 10}" data-field="laborCosting.benefitLoadHealthWelfarePct" data-type="number" data-recompute-benefit-load="true" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="401(k) match + profit sharing. Typical 3-6%. Often higher for salaried positions.">Retirement %</label>
          <input class="hub-input" type="number" min="0" max="15" step="0.25" value="${lc.benefitLoadRetirementPct ?? 4}" data-field="laborCosting.benefitLoadRetirementPct" data-type="number" data-recompute-benefit-load="true" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Paid sick accrual, bereavement, jury duty, EAP, tuition assistance, disability. Anything not PTO/holidays and not captured elsewhere.">Other Leave &amp; Misc %</label>
          <input class="hub-input" type="number" min="0" max="15" step="0.25" value="${lc.benefitLoadOtherPct ?? 6}" data-field="laborCosting.benefitLoadOtherPct" data-type="number" data-recompute-benefit-load="true" />
        </div>
      </div>
    </div>

    <!-- Labor Economics -->
    <!-- Brock 2026-04-21 pm: renamed from "Global Labor Economics" and
         trimmed. PTO + Holiday moved up into Shift Structure (they drive the
         Productive Hours tile). This card holds rate/productivity factors
         that feed cost math downstream but don't affect paid/productive hours. -->
    <div class="hub-card mb-4">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;">
        <div class="text-subtitle" style="margin:0;">Labor Economics</div>
        <span class="hub-field__hint">Rate + productivity factors. Per-position overrides live in the catalog below.</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:12px;">
        <div class="hub-field">
          <label class="hub-field__label" title="Planned bonus pay as % of base wage. Blend across all roles.">Bonus %</label>
          <input class="hub-input" type="number" min="0" max="50" step="0.25" value="${s.bonusPct ?? 5}" data-field="shifts.bonusPct" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Planned overtime hours as % of regular. Each OT hour costs 1.5×. Typical 3-8%. Hourly-nonexempt only — salary roles are exempt (doc §3.4).">Overtime %</label>
          <input class="hub-input" type="number" min="0" max="50" step="0.5" value="${lc.overtimePct ?? 5}" data-field="laborCosting.overtimePct" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="Annual % of workforce turning over — drives recruiting/onboarding cost. 3PL typical 40-80%.">Turnover %</label>
          <input class="hub-input" type="number" min="0" max="150" step="1" value="${lc.turnoverPct ?? 45}" data-field="laborCosting.turnoverPct" data-type="number" />
        </div>
        <div class="hub-field">
          <label class="hub-field__label" title="PF&amp;D haircut applied to UPH (not hours) per doc §2.1. Captures personal allowance, fatigue, delay, paid breaks, activity-switching. Reference 85%. Range 75-90%.">Direct Utilization %</label>
          <input class="hub-input" type="number" min="50" max="100" step="0.5" value="${s.directUtilization ?? 85}" data-field="shifts.directUtilization" data-type="number" />
        </div>
      </div>
    </div>

    <!-- Position Catalog -->
    <div class="hub-card mb-4">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div>
          <div class="text-subtitle" style="margin:0;">Position Catalog</div>
          <div class="hub-field__hint">Role-based catalog (${STANDARD_POSITIONS.length} standard roles from heuristics doc). Labor activities select from here. <strong>${directCount}</strong> direct · <strong>${indirectCount}</strong> indirect · <strong>${positions.length}</strong> total.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="replace-with-standard-positions" title="Wipe current positions and seed the 43-role standard catalog (Material Handler, Forklift Operator, Ops Supervisor, etc.). Existing labor lines will unlink from removed positions — re-select them from the dropdown.">↺ Replace with Standard Roles</button>
          <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="add-position">+ Add Position</button>
        </div>
      </div>
      <div class="cm-table-scroll">
        <table class="hub-datatable hub-datatable--dense">
          <thead>
            <tr>
              <th style="min-width:180px;">Position Name</th>
              <th style="width:100px;">Category</th>
              <th style="width:130px;">Employment</th>
              <th class="hub-num" style="width:100px;" title="Starting hourly wage (pre-benefit load)">Wage $/hr</th>
              <th class="hub-num" style="width:90px;" title="Temp-agency markup on base wage (only for Temp Agency positions)">Temp Mkup %</th>
              <th style="width:70px;text-align:center;" title="Salaried vs hourly">Salaried?</th>
              <th class="hub-num" style="width:120px;" title="Annual salary (salaried only)">Salary</th>
              <th class="hub-num" style="width:80px;" title="Position-specific bonus %. Blank = inherit global">Bonus %</th>
              <th class="hub-num" style="width:100px;" title="Per-position Benefit Load % override. Blank = inherit global total from buckets above. Salaried roles often have higher load (richer health + retirement); hourly lower.">Benefit Load %</th>
              <th>Notes</th>
              <th style="width:36px;"></th>
            </tr>
          </thead>
          <tbody>
            ${positions.length === 0
              ? `<tr><td colspan="11" style="text-align:center;padding:18px;color:var(--ies-gray-400);"><em>No positions yet. Click <strong>↺ Replace with Standard Roles</strong> to seed the ${STANDARD_POSITIONS.length}-role catalog, or <strong>+ Add Position</strong> to build manually.</em></td></tr>`
              : positions.map((p, i) => posRow(p, i)).join('')}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  `;
}

// ============================================================
// SECTIONS 6-13: Stub renderers (will be fully built out)
// ============================================================

/**
 * Recompute annual_hours from volume and base_uph for a labor line in place.
 * Mirrors v2 behavior where picking a MOST template or editing volume/UPH
 * drives Hrs/Yr = volume / base_uph (no PFD applied — shifts handle allowance elsewhere).
 * @param {any} line
 */
function recomputeLineHours(line) {
  const v = line.volume || 0;
  const u = line.base_uph || 0;
  line.annual_hours = u > 0 ? v / u : 0;
}

/**
 * Brock 2026-04-20 — Effective UPH per Labor Build-Up Logic doc §2.1:
 * base_uph × direct_utilization × (productivity_pct/100). This is the
 * "PF&D haircut on UPH" path the doc flags as the #1 hours-chain gap.
 *
 * Reads shifts.directUtilization as percent (85), defaults to 85; reads
 * line.productivity_pct (defaults 100 = no adjustment). Returns 0 for
 * lines without a base_uph so the UI can show em-dash.
 * @param {any} line
 * @returns {number}
 */
function effectiveUphForLine(line) {
  const baseUph = Number(line.base_uph) || 0;
  if (baseUph === 0) return 0;
  const s = model.shifts || {};
  const utilFrac = ((Number(s.directUtilization) || 85)) / 100;
  const prodFrac = ((Number(line.productivity_pct) || 100)) / 100;
  return baseUph * utilFrac * prodFrac;
}

/**
 * Brock 2026-04-20 — Labor position cell. Renders a dropdown backed by
 * the Labor Factors position catalog. Selecting a position pulls its
 * hourly_wage → line.hourly_rate, employment_type, and temp_markup.
 * Existing per-line rate stays as an override path (editable in the Rate
 * column); selecting "— None —" leaves position_id null.
 *
 * category filter: 'direct' shows direct positions; 'indirect' shows the
 * indirect subset. Keeps each dropdown lean.
 */
function renderPositionCell(line, idx, categoryFilter) {
  const positions = (model.shifts && model.shifts.positions) || [];
  const eligible = positions.filter(p => {
    if (categoryFilter === 'indirect') return p.category === 'indirect';
    return p.category !== 'indirect'; // 'direct' → anything not flagged indirect
  });
  const current = line.position_id || '';
  return `
    <select style="width:150px;font-size:11px;" data-whatif-position="${idx}" data-labor-kind="${categoryFilter}" title="Pick a role from the Position Catalog on Labor Factors. Rate pulls from the position.">
      <option value=""${current ? '' : ' selected'}>— Manual —</option>
      ${eligible.map(p => `
        <option value="${p.id}"${current === p.id ? ' selected' : ''}>
          ${_esc(p.name)}${p.employment_type === 'temp_agency' ? ' · Temp' : ''} · $${(p.hourly_wage || 0).toFixed(2)}
        </option>
      `).join('')}
    </select>
  `;
}

// ---- MOST schema accessors -------------------------------------------------
// ref_most_templates uses activity_name / units_per_hour_base / total_tmu_base
// (not the `name`/`base_uph`/`tmu_total` v3 types.js declared). These helpers
// read both shapes so we stay robust if the schema is normalized later.
const mostTplName = (t) => t?.activity_name || t?.name || t?.wms_transaction || '';
const mostTplUph  = (t) => Number(t?.units_per_hour_base || t?.base_uph || 0);
const mostTplTmu  = (t) => Number(t?.total_tmu_base || t?.tmu_total || 0);
// ref_most_elements uses sequence_order / element_name / tmu_value
const mostElSeq  = (e) => (e?.sequence_order ?? e?.sequence ?? 0);
const mostElName = (e) => e?.element_name || e?.description || '';
const mostElTmu  = (e) => Number(e?.tmu_value || e?.tmu || 0);

/**
 * Render the per-row MOST Template picker cell (v3 port of v2 _mostSelectHtml).
 * Groups templates by process_area in canonical warehouse-flow order.
 * When a template is assigned, shows:
 *  • ⓘ info button (view template details modal)
 *  • "Override" badge + ↺ reset button when line.base_uph diverges from template.base_uph
 * @param {any} line
 * @param {number} idx
 */
/**
 * Render the Volume cell for a direct-labor row.
 * Dropdown of volumeLines (by name) + a "Custom" option for ad-hoc values.
 * Selecting a line syncs line.volume to the chosen volumeLines[].volume
 * and stores the source index in line.volume_source_idx.
 */
function renderLaborVolumeCell(line, idx) {
  const volumes = model.volumeLines || [];
  const sourceIdx = (line.volume_source_idx !== undefined && line.volume_source_idx !== null && line.volume_source_idx !== '')
    ? String(line.volume_source_idx)
    : 'custom';
  const options = volumes.map((v, vi) => {
    const label = `${v.name || ('Vol #' + (vi + 1))} (${(v.volume || 0).toLocaleString()} ${v.uom || ''})`;
    return `<option value="${vi}"${String(vi) === sourceIdx ? ' selected' : ''}>${label}</option>`;
  }).join('');
  return `
    <div style="display:flex;flex-direction:column;gap:2px;">
      <select style="width:170px;font-size:11px;" data-labor-volume-source data-idx="${idx}">
        ${options}
        <option value="custom"${sourceIdx === 'custom' ? ' selected' : ''}>— Custom —</option>
      </select>
      ${sourceIdx === 'custom'
        ? `<input type="number" value="${line.volume || 0}" style="width:170px;font-size:11px;" data-array="laborLines" data-idx="${idx}" data-field="volume" data-type="number" placeholder="Volume" />`
        : `<div style="font-size:10px;color:var(--ies-gray-400);padding-left:4px;">= ${(line.volume || 0).toLocaleString()}</div>`}
    </div>
  `;
}

/**
 * Q4 (2026-04-20) — render a small provenance chip for lines generated by
 * `autoGenerateIndirectLabor`. The chip's visual state tells the user
 * WHERE the number came from at a glance:
 *   - blue "ℹ catalog" when value came from ref_planning_ratios
 *   - amber "ℹ override" when the project overrode the catalog default
 *   - gray "ℹ legacy" when no catalog lookup applied (hardcoded rule)
 *
 * Tooltip spells out the rule, the value used, the legacy fallback value
 * for comparison, and the source citation if available.
 *
 * Shape of line._heuristic (from calc.js):
 *   { code, label, value, source, legacy_value, source_detail, source_date, source_citation }
 *
 * @param {any} line — labor line (direct or indirect) with optional `_heuristic`
 * @returns {string} HTML
 */
function renderHeuristicChip(line) {
  const h = line?._heuristic;
  if (!h) return '';
  const source = h.source || 'legacy';
  const sourceLabel = source === 'catalog'  ? 'catalog'
                    : source === 'override' ? 'override'
                    : 'legacy';
  const sourceColor = source === 'catalog'  ? { bg: '#dbeafe', fg: '#1e40af', border: '#93c5fd' }
                    : source === 'override' ? { bg: '#fef3c7', fg: '#b45309', border: '#fcd34d' }
                    :                          { bg: '#f3f4f6', fg: '#6b7280', border: '#d1d5db' };
  // Build an informative tooltip. Newlines render as line breaks in
  // native `title` on most browsers — good enough for an inline chip.
  const lines = [];
  lines.push(`${h.label || h.code}`);
  lines.push(`Value used: ${h.value}${source !== 'legacy' ? ` (${source})` : ''}`);
  if (h.legacy_value != null && String(h.legacy_value) !== String(h.value)) {
    lines.push(`Legacy default: ${h.legacy_value}`);
  }
  if (h.source_citation) lines.push(`Source: ${h.source_citation}`);
  if (h.source_date) lines.push(`Dated: ${h.source_date}`);
  const tipText = lines.join(' · ');
  return `<span class="cm-heuristic-chip" style="display:inline-flex;align-items:center;gap:2px;background:${sourceColor.bg};color:${sourceColor.fg};border:1px solid ${sourceColor.border};border-radius:10px;padding:1px 6px;font-size:10px;font-weight:600;line-height:1.3;margin-left:6px;cursor:help;white-space:nowrap;" title="${escapeAttr(tipText)}" aria-label="${escapeAttr(tipText)}">ℹ ${sourceLabel}</span>`;
}

function renderMostCell(line, idx) {
  const templates = (refData.mostTemplates || []).filter(t => t.is_active !== false);
  const currentId = line.most_template_id || '';
  const currentTpl = currentId
    ? templates.find(t => String(t.id) === String(currentId))
    : null;
  const tplUph = currentTpl ? mostTplUph(currentTpl) : 0;
  const isOverridden = currentTpl
    && (line.base_uph || 0) > 0
    && tplUph > 0
    && Math.abs((line.base_uph || 0) - tplUph) > 0.5;

  // Group templates by process_area
  const groups = {};
  templates.forEach(t => {
    const area = t.process_area || 'Other';
    (groups[area] = groups[area] || []).push(t);
  });
  const areaOrder = ['Receiving', 'Putaway', 'Replenishment', 'Picking', 'Packing', 'Shipping', 'Inventory', 'Returns', 'VAS'];
  const sortedAreas = areaOrder.filter(k => groups[k])
    .concat(Object.keys(groups).filter(k => !areaOrder.includes(k)).sort());

  let optionsHtml = '<option value="">— Select —</option>';
  sortedAreas.forEach(area => {
    optionsHtml += `<optgroup label="${area}">`;
    groups[area].forEach(t => {
      const selected = String(t.id) === String(currentId) ? ' selected' : '';
      let name = mostTplName(t) || `Template ${t.id}`;
      if (name.length > 32) name = name.substring(0, 30) + '…';
      optionsHtml += `<option value="${t.id}"${selected}>${name}</option>`;
    });
    optionsHtml += '</optgroup>';
  });

  const hasTemplate = !!currentTpl;
  const infoBtn = hasTemplate
    ? `<button class="cm-most-icon" data-action="view-most-template" data-idx="${idx}" data-template-id="${currentTpl.id}" title="View template details" style="background:none;border:none;cursor:pointer;padding:2px 4px;color:var(--ies-blue,#0047AB);font-size:14px;">ⓘ</button>`
    : '';
  // When the row's UPH differs from the template's default UPH, style the select
  // with an amber border instead of a separate 'OVERRIDE' chip + orange reset
  // button stacked below. Hover the select to see the template UPH; click the
  // small ↺ to reset. Single row, quieter visual.
  const resetBtn = isOverridden
    ? `<button class="cm-most-icon cm-most-revert" data-action="reset-most-uph" data-idx="${idx}" title="Reset UPH to template default (${Math.round(tplUph)})" aria-label="Reset UPH to template default">↺</button>`
    : '';
  const selectStyle = isOverridden
    ? 'width:150px;font-size:11px;padding:4px 6px;border:1px solid #d97706;background:#fffbeb;'
    : 'width:150px;font-size:11px;padding:4px 6px;';
  const selectTitle = isOverridden
    ? `UPH overridden (template default: ${Math.round(tplUph)}). Click ↺ to reset.`
    : (hasTemplate ? `Template UPH: ${Math.round(tplUph)}` : 'Pick a MOST template to drive labor UPH');

  return `
    <div style="display:flex;align-items:center;gap:2px;">
      <select data-most-select data-idx="${idx}" style="${selectStyle}" title="${selectTitle}">${optionsHtml}</select>
      ${infoBtn}${resetBtn}
    </div>
  `;
}

// ============================================================
// SECTION 5b: SHIFT PLANNING (2026-04-22 — Brock day-1 MVP)
// ============================================================

// 2026-04-22 EVE (Brock): shift-archetypes catalog prefetch removed along with
// the throughput-matrix archetype picker. Grid now seeds Even by default via
// createEvenShiftAllocation in shift-planner-ui.js — no async catalog needed.

function renderShiftPlanning() {
  // Keep the allocation's shift count in sync with model.shifts.shiftsPerDay.
  // (Structure fields live on this same page — 2026-04-22 IA reshuffle — so
  // the resize triggers right after the user edits Shifts / Day inline.)
  shiftPlannerUi.syncAllocationToShifts(model);
  return shiftPlannerUi.renderShiftPlanningSection({ model });
}

function renderLabor() {
  if (isCmV2UiOn()) return renderLaborV2();
  return renderLaborV1();
}

function renderLaborV1() {
  const lines = model.laborLines || [];
  const opHrs = calc.operatingHours(model.shifts || {});
  const lc = model.laborCosting || (model.laborCosting = {});
  const totalDirect = lines.reduce((s, l) => s + calc.directLineAnnualSimple(l, lc), 0);
  const totalIndirect = (model.indirectLaborLines || []).reduce((s, l) => s + calc.indirectLineAnnualSimple(l, opHrs, lc), 0);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Labor</div>
        <div class="cm-section-desc">Direct labor (MOST-driven) and indirect/management labor. Cost factors below are global.</div>
      </div>
    </div>

    <!-- Brock 2026-04-20: collapsed to a read-only banner linking to Labor
         Factors. Burden/Benefits were double-counting; canonical lives on
         Labor Factors now. See renderLaborFactorsBanner. -->
    ${renderLaborFactorsBanner(lc, model.shifts)}

    <div style="display: flex; gap: 8px; margin: 16px 0;">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-indirect">Auto-Generate Indirect Labor</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="apply-pfd-haircut" title="Recompute annual_hours using effective UPH (base_uph × Direct Utilization × productivity_pct) per Labor Build-Up Logic doc §2.1. Corrects the ~15% under-staffing the doc identifies.">Apply PF&amp;D Haircut to Hours</button>
    </div>

    <div class="text-subtitle mb-2">Direct Labor <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;">— Pick a <strong>Position</strong> (rate / employment / markup pull from Labor Factors) · Volume from Volumes tab · MHE and IT/Device separate</span></div>
    <table class="cm-grid-table">
      <thead>
        <tr><th style="min-width:180px;">MOST Template</th><th>Activity</th><th style="min-width:150px;" title="Pick a role from the Labor Factors catalog. Rate/employment/markup pull from the position — edit those centrally.">Position</th><th>MHE</th><th>IT / Device</th><th>Volume</th><th>UPH</th><th>Hrs/Yr</th><th>FTE</th><th>Rate</th><th>Employment</th><th>Markup %</th><th title="Productivity variance for Monte Carlo sensitivity">Var %</th><th title="Activity complexity tier - drives the Year-1 learning-curve haircut. low=0.95, medium=0.85 (default), high=0.75. Read by calc.js learning multiplier.">Complexity</th><th class="cm-num">Annual Cost</th><th title="Monthly OT/absence seasonality">Seasonality</th><th></th></tr>
      </thead>
      <tbody>
        ${lines.map((l, i) => `
          <tr>
            <td>${renderMostCell(l, i)}</td>
            <td><input value="${l.activity_name || ''}" style="width:110px;" data-array="laborLines" data-idx="${i}" data-field="activity_name" /></td>
            <td>${renderPositionCell(l, i, 'direct')}</td>
            <td>
              <select style="width:95px;font-size:11px;" data-array="laborLines" data-idx="${i}" data-field="mhe_type" title="Material handling equipment (MHE) assigned to this activity">
                <option value=""${!l.mhe_type && !['reach_truck','sit_down_forklift','stand_up_forklift','order_picker','walkie_rider','pallet_jack','electric_pallet_jack','turret_truck','amr','conveyor','manual'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
                <option value="reach_truck"${(l.mhe_type === 'reach_truck' || l.equipment_type === 'reach_truck') ? ' selected' : ''}>Reach Truck</option>
                <option value="sit_down_forklift"${(l.mhe_type === 'sit_down_forklift' || l.equipment_type === 'sit_down_forklift') ? ' selected' : ''}>Sit-Down FL</option>
                <option value="stand_up_forklift"${(l.mhe_type === 'stand_up_forklift' || l.equipment_type === 'stand_up_forklift') ? ' selected' : ''}>Stand-Up FL</option>
                <option value="order_picker"${(l.mhe_type === 'order_picker' || l.equipment_type === 'order_picker') ? ' selected' : ''}>Order Picker</option>
                <option value="walkie_rider"${(l.mhe_type === 'walkie_rider' || l.equipment_type === 'walkie_rider') ? ' selected' : ''}>Walkie Rider</option>
                <option value="pallet_jack"${(l.mhe_type === 'pallet_jack' || l.equipment_type === 'pallet_jack') ? ' selected' : ''}>Pallet Jack</option>
                <option value="electric_pallet_jack"${(l.mhe_type === 'electric_pallet_jack' || l.equipment_type === 'electric_pallet_jack') ? ' selected' : ''}>Elec Pallet Jack</option>
                <option value="turret_truck"${(l.mhe_type === 'turret_truck' || l.equipment_type === 'turret_truck') ? ' selected' : ''}>Turret Truck</option>
                <option value="amr"${(l.mhe_type === 'amr' || l.equipment_type === 'amr') ? ' selected' : ''}>AMR/Robot</option>
                <option value="conveyor"${(l.mhe_type === 'conveyor' || l.equipment_type === 'conveyor') ? ' selected' : ''}>Conveyor</option>
                <option value="manual"${(l.mhe_type === 'manual' || l.equipment_type === 'manual') ? ' selected' : ''}>Manual / Walk</option>
              </select>
            </td>
            <td>
              <select style="width:95px;font-size:11px;" data-array="laborLines" data-idx="${i}" data-field="it_device" title="IT / scanning device assigned to this activity">
                <option value=""${!l.it_device && !['rf_scanner','voice_pick'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
                <option value="rf_scanner"${(l.it_device === 'rf_scanner' || l.equipment_type === 'rf_scanner') ? ' selected' : ''}>RF Scanner</option>
                <option value="voice_pick"${(l.it_device === 'voice_pick' || l.equipment_type === 'voice_pick') ? ' selected' : ''}>Voice Pick</option>
                <option value="wearable"${l.it_device === 'wearable' ? ' selected' : ''}>Wearable</option>
                <option value="tablet"${l.it_device === 'tablet' ? ' selected' : ''}>Tablet</option>
                <option value="vision_system"${l.it_device === 'vision_system' ? ' selected' : ''}>Vision System</option>
                <option value="pick_to_light"${l.it_device === 'pick_to_light' ? ' selected' : ''}>Pick-to-Light</option>
                <option value="pick_to_display"${l.it_device === 'pick_to_display' ? ' selected' : ''}>Pick-to-Display</option>
              </select>
            </td>
            <td>${renderLaborVolumeCell(l, i)}</td>
            <td><input type="number" value="${l.base_uph || 0}" style="width:55px;" data-array="laborLines" data-idx="${i}" data-field="base_uph" data-type="number" /></td>
            <td class="cm-num">${(l.annual_hours || 0).toLocaleString(undefined, {maximumFractionDigits:0})}</td>
            <td class="cm-num">${calc.fte(l, opHrs).toFixed(1)}</td>
            <td><input type="number" value="${l.hourly_rate || 0}" style="width:55px;" step="0.5" data-array="laborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
            <td>
              <select style="width:110px;" data-array="laborLines" data-idx="${i}" data-field="employment_type">
                <option value="permanent"${(l.employment_type || 'permanent') === 'permanent' ? ' selected' : ''}>Permanent</option>
                <option value="temp_agency"${l.employment_type === 'temp_agency' ? ' selected' : ''}>Temp Agency</option>
                <option value="contractor"${l.employment_type === 'contractor' ? ' selected' : ''}>Contractor</option>
              </select>
            </td>
            <td>
              <input type="number" value="${l.temp_agency_markup_pct || 0}" style="width:55px;" step="1" min="0" max="100"
                data-array="laborLines" data-idx="${i}" data-field="temp_agency_markup_pct" data-type="number"
                ${(l.employment_type || 'permanent') !== 'temp_agency' ? 'disabled title="Only applies to Temp Agency lines"' : ''} />
            </td>
            <td>
              <input type="number" value="${l.performance_variance_pct || 0}" style="width:50px;" step="1" min="0" max="50"
                data-array="laborLines" data-idx="${i}" data-field="performance_variance_pct" data-type="number"
                title="Productivity variance (% std dev) for the Monte Carlo sensitivity card" />
            </td>
            <td>
              <select style="width:95px;font-size:11px;" data-array="laborLines" data-idx="${i}" data-field="complexity_tier" title="Activity complexity tier - drives Year-1 learning-curve factor (low=0.95, medium=0.85, high=0.75)">
                <option value="low"${l.complexity_tier === 'low' ? ' selected' : ''}>Low</option>
                <option value="medium"${(l.complexity_tier || 'medium') === 'medium' ? ' selected' : ''}>Medium</option>
                <option value="high"${l.complexity_tier === 'high' ? ' selected' : ''}>High</option>
              </select>
            </td>
            <td class="cm-num">${calc.formatCurrency(calc.directLineAnnualSimple(l, lc))}</td>
            <td>
              <button class="hub-btn" style="padding:2px 6px;font-size:11px;" data-cm-action="edit-labor-seasonality" data-idx="${i}" title="Edit monthly OT/absence seasonality">
                ${(Array.isArray(l.monthly_overtime_profile) || Array.isArray(l.monthly_absence_profile)) ? '📊*' : '📊'}
              </button>
            </td>
            <td><button class="cm-delete-btn" data-action="delete-labor" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="13">Total Direct Labor</td><td class="cm-num">${calc.formatCurrency(totalDirect)}</td><td colspan="2"></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-labor">+ Add Labor Line</button>

    <div class="text-subtitle mb-2 mt-6">Indirect Labor <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;">— Burden % set in Labor Costing Factors above</span></div>
    <table class="cm-grid-table">
      <thead>
        <tr><th>Role</th><th>Headcount</th><th>Rate</th><th class="cm-num">Annual Cost</th><th></th></tr>
      </thead>
      <tbody>
        ${(model.indirectLaborLines || []).map((l, i) => `
          <tr>
            <td style="white-space:nowrap;">
              <input value="${l.role_name || ''}" style="width:140px;" data-array="indirectLaborLines" data-idx="${i}" data-field="role_name" />
              ${renderHeuristicChip(l)}
            </td>
            <td><input type="number" value="${l.headcount || 0}" style="width:50px;" data-array="indirectLaborLines" data-idx="${i}" data-field="headcount" data-type="number" /></td>
            <td><input type="number" value="${l.hourly_rate || 0}" style="width:60px;" step="0.5" data-array="indirectLaborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
            <td class="cm-num">${calc.formatCurrency(calc.indirectLineAnnualSimple(l, opHrs, lc))}</td>
            <td><button class="cm-delete-btn" data-action="delete-indirect" data-idx="${i}">Del</button></td>
          </tr>
        `).join('')}
        <tr class="cm-total-row"><td colspan="3">Total Indirect Labor</td><td class="cm-num">${calc.formatCurrency(totalIndirect)}</td><td></td></tr>
      </tbody>
    </table>
    <button class="cm-add-row-btn" data-action="add-indirect">+ Add Indirect Line</button>
  `;
}

// ============================================================
// v2 LABOR — master-detail layout
// ============================================================

/**
 * Short, human labels for employment types used in the compact master list.
 */
const EMPLOYMENT_CHIP = {
  permanent: { label: 'Permanent', variant: 'brand' },
  temp_agency: { label: 'Temp', variant: 'warn' },
  contractor: { label: 'Contractor', variant: 'info' },
};

function renderLaborV2() {
  const lines = model.laborLines || [];
  const opHrs = calc.operatingHours(model.shifts || {});
  const lc = model.laborCosting || (model.laborCosting = {});
  const totalDirect = lines.reduce((s, l) => s + calc.directLineAnnualSimple(l, lc), 0);
  const totalIndirect = (model.indirectLaborLines || []).reduce((s, l) => s + calc.indirectLineAnnualSimple(l, opHrs, lc), 0);
  const totalFtes = lines.reduce((s, l) => s + calc.fte(l, opHrs), 0);

  // Selected index — clamp and default sensibly
  if (lines.length === 0) _selectedLaborIdx = null;
  else if (_selectedLaborIdx === null || _selectedLaborIdx === undefined || _selectedLaborIdx >= lines.length) {
    _selectedLaborIdx = 0;
  }

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Labor</div>
        <div class="cm-section-desc">Direct labor (MOST-driven) + indirect/management labor. Cost factors apply across all rows.</div>
      </div>
    </div>

    ${renderLaborFactorsBanner(lc, model.shifts)}
    ${renderLaborKpiStripV2(lines.length, totalFtes, totalDirect, totalIndirect)}

    <!-- Master-detail for Direct Labor -->
    <div style="margin-top:24px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;gap:12px;flex-wrap:wrap;">
        <div>
          <h3 class="hub-section-heading" style="margin:0;">Direct Labor</h3>
          <div class="hub-field__hint">Volume sourced from Volumes tab · MOST template drives UPH</div>
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="apply-pfd-haircut" title="Recompute annual_hours using effective UPH (base_uph × Direct Utilization × productivity_pct) per Labor Build-Up Logic doc §2.1. Corrects the ~15% under-staffing the doc identifies.">Apply PF&amp;D Haircut to Hours</button>
      </div>

      <div class="hub-master-detail">
        ${renderLaborMasterPane(lines, opHrs, lc)}
        ${renderLaborDetailPane(lines, opHrs, lc)}
      </div>
    </div>

    <!-- Indirect Labor — keeps the dense table, which fits fine at 4 columns -->
    <div style="margin-top:28px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;">
        <div>
          <h3 class="hub-section-heading" style="margin:0;">Indirect / Management Labor</h3>
          <div class="hub-field__hint">Burden % set in Labor Costing Factors above${(model.indirectLaborLines || []).length > 0 ? ` · <span style="color:var(--ies-gray-500);">${(model.indirectLaborLines || []).length} rows auto-generated — click Regenerate to replace</span>` : ''}</div>
        </div>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-indirect">${(model.indirectLaborLines || []).length > 0 ? '↻ Regenerate' : '↺ Auto-Generate'}</button>
      </div>

      <div class="hub-card" style="padding:0;overflow:hidden;">
        <table class="hub-datatable hub-datatable--dense">
          <thead>
            <tr>
              <th>Role</th>
              <th style="width:160px;" title="Pull from Labor Factors position catalog (indirect category). Selecting a position cascades wage + employment + markup onto the row.">Position</th>
              <th class="hub-num" style="width:70px;">HC</th>
              <th class="hub-num" style="width:70px;">Rate</th>
              <th style="width:160px;">Pricing Bucket</th>
              <th class="hub-num" style="width:60px;" title="Extra headcount needed only during peak months (temps, seasonal backfill). 0 = no seasonal flex.">Peak HC</th>
              <th class="hub-num" style="width:58px;" title="How many months per year the peak headcount is active. Default 3 for Q4 ecomm peaks.">Peak Mo</th>
              <th class="hub-num" style="width:62px;" title="Temp-agency / short-term markup applied to seasonal headcount's labor cost. Typical 25-35%.">Peak %</th>
              <th class="hub-num" style="width:130px;">Annual Cost</th>
              <th style="width:44px;"></th>
            </tr>
          </thead>
          <tbody>
            ${(() => {
              // Compute indirect seasonal-uplift subtotals so the UI can
              // expose Baseline + Seasonal lines (matches Equipment pattern).
              const indirectBreakdown = (model.indirectLaborLines || []).reduce((acc, l) => {
                const bd = calc.indirectLineAnnualBreakdown(l, opHrs, lc);
                return { baseline: acc.baseline + bd.baseline, seasonal: acc.seasonal + bd.seasonal, total: acc.total + bd.total };
              }, { baseline: 0, seasonal: 0, total: 0 });
              _indirectBreakdownCache = indirectBreakdown; // see tfoot
              return '';
            })()}
            ${(model.indirectLaborLines || []).map((l, i) => {
              const buckets = model.pricingBuckets || [];
              const bd = calc.indirectLineAnnualBreakdown(l, opHrs, lc);
              return `
              <tr>
                <td style="white-space:nowrap;">
                  <input class="hub-input" style="width:calc(100% - 90px);display:inline-block;" value="${escapeAttr(l.role_name || '')}" data-array="indirectLaborLines" data-idx="${i}" data-field="role_name" />
                  ${renderHeuristicChip(l)}
                </td>
                <td>${renderPositionCell(l, i, 'indirect')}</td>
                <td><input class="hub-input hub-num" type="number" value="${l.headcount || 0}" data-array="indirectLaborLines" data-idx="${i}" data-field="headcount" data-type="number" /></td>
                <td><input class="hub-input hub-num" type="number" step="0.5" value="${l.hourly_rate || 0}" data-array="indirectLaborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" /></td>
                <td>
                  ${buckets.length === 0
                    ? `<span class="hub-chip hub-chip--danger">no buckets</span>`
                    : `<select class="hub-input" data-array="indirectLaborLines" data-idx="${i}" data-field="pricing_bucket">
                        <option value=""${!l.pricing_bucket ? ' selected' : ''}>— Unassigned —</option>
                        ${buckets.map(b => `<option value="${escapeAttr(b.id)}"${l.pricing_bucket === b.id ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
                       </select>`}
                </td>
                <td><input class="hub-input hub-num" type="number" min="0" step="1" value="${l.peak_only_hc || 0}" data-array="indirectLaborLines" data-idx="${i}" data-field="peak_only_hc" data-type="number" /></td>
                <td><input class="hub-input hub-num" type="number" min="0" max="12" step="1" value="${l.peak_months || 0}" data-array="indirectLaborLines" data-idx="${i}" data-field="peak_months" data-type="number" /></td>
                <td><input class="hub-input hub-num" type="number" min="0" max="100" step="1" value="${l.peak_markup_pct || 0}" data-array="indirectLaborLines" data-idx="${i}" data-field="peak_markup_pct" data-type="number" /></td>
                <td class="hub-num" style="font-weight:600;" title="${bd.seasonal > 0 ? `Baseline ${calc.formatCurrency(bd.baseline)} + Seasonal ${calc.formatCurrency(bd.seasonal)}` : 'Baseline only'}">
                  ${calc.formatCurrency(bd.total)}${bd.seasonal > 0 ? `<span style="display:block;font-size:10px;color:var(--ies-orange,#d97706);font-weight:600;">+${calc.formatCurrency(bd.seasonal, {compact:true})} peak</span>` : ''}
                </td>
                <td><button class="cm-delete-btn" data-action="delete-indirect" data-idx="${i}" aria-label="Delete">×</button></td>
              </tr>
            `;
            }).join('')}
            ${(model.indirectLaborLines || []).length === 0
              ? `<tr><td colspan="10" style="padding:24px;text-align:center;color:var(--ies-gray-400);font-size:12px;">No indirect labor yet. Click <strong>Auto-Generate</strong> above, or add a role manually.</td></tr>`
              : ''}
          </tbody>
          ${(model.indirectLaborLines || []).length > 0 ? `
            <tfoot>
              ${_indirectBreakdownCache && _indirectBreakdownCache.seasonal > 0 ? `
                <tr style="background:rgba(217,119,6,0.06);">
                  <td colspan="8" style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--ies-orange,#d97706);">↳ Seasonal Uplift (temp / short-term during peak months)</td>
                  <td class="hub-num" style="padding:8px 12px;font-weight:600;color:var(--ies-orange,#d97706);">+${calc.formatCurrency(_indirectBreakdownCache.seasonal)}</td>
                  <td></td>
                </tr>
                <tr>
                  <td colspan="8" style="padding:6px 12px;font-size:12px;color:var(--ies-gray-500);">Baseline year-round</td>
                  <td class="hub-num" style="padding:6px 12px;font-size:12px;color:var(--ies-gray-500);">${calc.formatCurrency(_indirectBreakdownCache.baseline)}</td>
                  <td></td>
                </tr>
              ` : ''}
              <tr style="background:var(--ies-gray-50);font-weight:700;">
                <td colspan="8" style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ies-gray-600);">Total Indirect${_indirectBreakdownCache && _indirectBreakdownCache.seasonal > 0 ? ' (baseline + seasonal)' : ''}</td>
                <td class="hub-num" style="padding:10px 12px;">${calc.formatCurrency(totalIndirect)}</td>
                <td></td>
              </tr>
            </tfoot>` : ''}
        </table>
      </div>
      <div style="margin-top:8px;"><button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="add-indirect">+ Add Indirect Role</button></div>
    </div>

    ${renderMonthlyLaborViewCard()}
  `;
}

// ============================================================
// Monthly Direct Labor View (Brock 2026-04-20)
// ============================================================

/**
 * Build a Monthly Direct Labor card that surfaces peak / avg / min FTE
 * across the contract term, per-MHE-type fleet counts implied by shift
 * structure, same for IT devices, and the seasonal indirect-staffing
 * implication. Appended below Indirect Labor in the Labor section.
 */
function renderMonthlyLaborViewCard() {
  const lines = model.laborLines || [];
  if (lines.length === 0) return '';
  const shifts = model.shifts || {};
  const annualOpHours = calc.operatingHours(shifts);
  const shiftsPerDay = Math.max(1, Math.floor(shifts.shiftsPerDay || 1));
  const contractYears = model.projectDetails?.contractTerm || 5;
  const fin = model.financial || {};
  const allPeriods = (refData?.periods || []).filter(p =>
    p.period_type === 'month' && p.period_index >= 0 && p.period_index < contractYears * 12
  );
  // Fallback: if periods table hasn't loaded yet, synthesize a simple axis
  // so the card renders with best-effort seasonality + growth.
  const periods = allPeriods.length > 0 ? allPeriods : (() => {
    const go = new Date(model.projectDetails?.goLiveDate || '2026-01-01');
    const out = [];
    for (let i = 0; i < contractYears * 12; i++) {
      const d = new Date(go.getFullYear(), go.getMonth() + i, 1);
      out.push({
        id: i, period_type: 'month', period_index: i,
        calendar_year: d.getFullYear(), calendar_month: d.getMonth() + 1,
        label: `M${i + 1}`, is_pre_go_live: false,
      });
    }
    return out;
  })();

  const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
    currentScenario, currentScenarioSnapshots, heuristicOverrides, fin, whatIfTransient,
  ), model);
  const view = monthlyCalc.computeMonthlyLaborView({
    laborLines: lines,
    periods,
    annualOpHours,
    shiftsPerDay,
    calcHeur,
    marketLaborProfile: currentMarketLaborProfile || null,
    ramp: null,
    seasonality: model.seasonalityProfile || null,
    volGrowthPct: calcHeur?.volGrowthPct || 0,
    indirectGenerator: calc.autoGenerateIndirectLabor,
    state: model,
  });

  const { summary, months } = view;
  const { direct, byMhe, byIt, indirect } = summary;

  // ── PER-YEAR SCOPE (Brock 2026-04-20) ─────────────────────────────
  // Flat 60-month sparkline conflated seasonality (intra-year) with
  // volume growth (year-over-year). Chart now defaults to a single year
  // so the J-D seasonality curve is legible. Year pills + "All" toggle.
  const nContractYears = Math.max(1, Math.ceil(months.length / 12));
  if (_mlvViewYear > nContractYears) _mlvViewYear = 1;
  const selectedYear = _mlvViewYear; // 0 = All, 1..N = that year
  const monthsInView = selectedYear === 0
    ? months
    : months.filter(m => Math.floor(m.period_index / 12) === selectedYear - 1);

  // Scoped peak / avg / min (replaces contract-wide numbers in KPI strip
  // when a single year is selected).
  let scopePeakFte = 0, scopePeakLabel = '';
  let scopeMinFte  = Number.POSITIVE_INFINITY, scopeMinLabel = '';
  let scopeSumFte  = 0;
  for (const m of monthsInView) {
    if (m.total_fte > scopePeakFte) { scopePeakFte = m.total_fte; scopePeakLabel = m.label; }
    if (m.total_fte < scopeMinFte)  { scopeMinFte  = m.total_fte; scopeMinLabel  = m.label; }
    scopeSumFte += m.total_fte;
  }
  if (!Number.isFinite(scopeMinFte)) scopeMinFte = 0;
  const scopeAvgFte = monthsInView.length > 0 ? scopeSumFte / monthsInView.length : 0;

  // Baseline band = min-month FTE in view. Seasonal wedge = total - baseline.
  // Bars are stacked: gray baseline on bottom (year-round FTE you need
  // regardless) + orange wedge on top (short-term flex during peak months).
  const baseline = scopeMinFte;
  const chartMax = Math.max(1, scopePeakFte);

  // Year pills — Y1..YN + "All". N based on labor lines' period coverage.
  const yearPills = nContractYears > 1 ? `
    <div class="cm-mlv-year-pills" role="tablist" aria-label="Contract year">
      ${Array.from({ length: nContractYears }, (_, i) => i + 1).map(y => `
        <button class="cm-mlv-year-pill${selectedYear === y ? ' is-active' : ''}" role="tab"
                aria-selected="${selectedYear === y}" data-action="set-mlv-year" data-idx="${y}"
                title="Year ${y} of the contract">Y${y}</button>
      `).join('')}
      <button class="cm-mlv-year-pill${selectedYear === 0 ? ' is-active' : ''}" role="tab"
              aria-selected="${selectedYear === 0}" data-action="set-mlv-year" data-idx="0"
              title="All ${nContractYears} contract years — useful for seeing year-over-year growth on top of seasonality">All</button>
    </div>
  ` : '';

  // Chart bars (stacked wedge + baseline).
  const chartBars = monthsInView.map(m => {
    const total  = m.total_fte;
    const wedge  = Math.max(0, total - baseline);
    const basePct  = chartMax > 0 ? (baseline / chartMax) * 100 : 0;
    const wedgePct = chartMax > 0 ? (wedge    / chartMax) * 100 : 0;
    const isPeak = Math.abs(total - scopePeakFte) < 1e-6 && wedge > 0;
    const tip = `${m.label}: ${total.toFixed(1)} FTE`
              + ` (baseline ${baseline.toFixed(1)}`
              + (wedge > 0 ? ` + ${wedge.toFixed(1)} flex` : '')
              + ')';
    return `
      <div class="cm-mlv-bar-col" title="${escapeAttr(tip)}">
        <div class="cm-mlv-bar-wedge${isPeak ? ' is-peak' : ''}" style="height:${wedgePct.toFixed(1)}%;"></div>
        <div class="cm-mlv-bar-base" style="height:${basePct.toFixed(1)}%;"></div>
      </div>
    `;
  }).join('');

  // X-axis labels — month abbreviations for single year, year markers for "All"
  const MONTH_ABBR = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  const xAxis = selectedYear === 0
    ? monthsInView.map(m => {
        // Only label every 12th month (first month of each contract year).
        const isYearStart = (m.period_index % 12) === 0;
        const yearLabel = isYearStart ? `Y${Math.floor(m.period_index / 12) + 1}` : '';
        return `<span class="cm-mlv-axis-label${isYearStart ? ' is-year-start' : ''}">${yearLabel}</span>`;
      }).join('')
    : monthsInView.map(m => {
        const abbr = MONTH_ABBR[(m.calendar_month - 1 + 12) % 12] || '';
        return `<span class="cm-mlv-axis-label">${abbr}</span>`;
      }).join('');

  // Per-type fleet table — one row per MHE type
  const typeRows = (types, labelFn) => {
    const entries = Object.entries(types);
    if (entries.length === 0) {
      return `<tr><td colspan="6" style="text-align:center;color:var(--ies-gray-400);padding:12px;font-size:12px;">No lines assigned to this equipment family.</td></tr>`;
    }
    return entries.map(([type, s]) => `
      <tr>
        <td><strong>${escapeHtml(labelFn ? labelFn(type) : type)}</strong></td>
        <td class="hub-num">${s.peakFte.toFixed(1)} <span style="color:var(--ies-gray-400);font-size:11px;">(${escapeHtml(s.peakMonthLabel)})</span></td>
        <td class="hub-num">${s.minFte.toFixed(1)} <span style="color:var(--ies-gray-400);font-size:11px;">(${escapeHtml(s.minMonthLabel)})</span></td>
        <td class="hub-num" style="font-weight:700;">${s.peakCount}</td>
        <td class="hub-num">${s.baselineCount}</td>
        <td class="hub-num">${s.seasonalCount > 0 ? `<span style="color:var(--ies-orange, #d97706);font-weight:600;">+${s.seasonalCount}</span>` : '—'}</td>
      </tr>
    `).join('');
  };
  const MHE_LABELS = {
    reach_truck: 'Reach Truck',
    sit_down_forklift: 'Sit-Down Forklift',
    stand_up_forklift: 'Stand-Up Forklift',
    order_picker: 'Order Picker',
    walkie_rider: 'Walkie Rider',
    pallet_jack: 'Pallet Jack',
    electric_pallet_jack: 'Electric Pallet Jack',
    turret_truck: 'Turret Truck',
    amr: 'AMR / Robot',
    conveyor: 'Conveyor',
  };
  const IT_LABELS = { rf_scanner: 'RF Scanner', voice_pick: 'Voice Pick' };

  // Aggregate seasonal flex across all types (drives the inline Sync CTA).
  const totalFlexMhe = Object.values(byMhe).reduce((s, t) => s + (t.seasonalCount || 0), 0);
  const totalFlexIt  = Object.values(byIt).reduce((s, t) => s + (t.seasonalCount || 0), 0);
  const totalFlexHc  = indirect?.seasonalHc || 0;
  const hasAnyFlex   = totalFlexMhe > 0 || totalFlexIt > 0 || totalFlexHc > 0;
  const flexParts = [];
  if (totalFlexMhe > 0) flexParts.push(`<strong>${totalFlexMhe}</strong> MHE unit${totalFlexMhe !== 1 ? 's' : ''}`);
  if (totalFlexIt > 0)  flexParts.push(`<strong>${totalFlexIt}</strong> IT device${totalFlexIt !== 1 ? 's' : ''}`);
  if (totalFlexHc > 0)  flexParts.push(`<strong>${totalFlexHc}</strong> indirect HC`);

  // Scope label for KPI sub-line ("Y1 monthly avg" vs "across 60 months")
  const scopeLbl = selectedYear === 0
    ? `across ${monthsInView.length} contract months`
    : `Y${selectedYear} — ${monthsInView.length} months`;
  const swingPct = scopeMinFte > 0
    ? `+${(((scopePeakFte / scopeMinFte) - 1) * 100).toFixed(0)}%`
    : '—';

  return `
    <div class="hub-card cm-mlv-card" style="margin-top:28px;padding:20px;">
      <div class="cm-mlv-header">
        <div class="cm-mlv-header__title">
          <h3 class="hub-section-heading" style="margin:0;">Monthly Labor View</h3>
          <div class="hub-field__hint">
            Seasonality of direct labor — how peak staffing swings above the year-round baseline.
            Use this to size peak MHE rentals and temp indirect staffing. Fleet counts derive from <strong>${shiftsPerDay}</strong>-shift ops.
          </div>
        </div>
        ${yearPills}
      </div>

      <!-- KPI strip — scoped to the currently selected year -->
      <div class="cm-mlv-kpi-strip">
        <div class="cm-mlv-kpi">
          <div class="cm-mlv-kpi-label">PEAK DIRECT FTE</div>
          <div class="cm-mlv-kpi-value" style="color:var(--ies-orange, #d97706);">${scopePeakFte.toFixed(1)}</div>
          <div class="cm-mlv-kpi-sub">${escapeHtml(scopePeakLabel)}</div>
        </div>
        <div class="cm-mlv-kpi">
          <div class="cm-mlv-kpi-label">AVG DIRECT FTE</div>
          <div class="cm-mlv-kpi-value">${scopeAvgFte.toFixed(1)}</div>
          <div class="cm-mlv-kpi-sub">${scopeLbl}</div>
        </div>
        <div class="cm-mlv-kpi">
          <div class="cm-mlv-kpi-label">BASELINE (MIN)</div>
          <div class="cm-mlv-kpi-value" style="color:var(--ies-blue, #0047AB);">${scopeMinFte.toFixed(1)}</div>
          <div class="cm-mlv-kpi-sub">${escapeHtml(scopeMinLabel)}</div>
        </div>
        <div class="cm-mlv-kpi">
          <div class="cm-mlv-kpi-label">PEAK → BASELINE Δ</div>
          <div class="cm-mlv-kpi-value">${(scopePeakFte - scopeMinFte).toFixed(1)}</div>
          <div class="cm-mlv-kpi-sub">${swingPct} swing</div>
        </div>
      </div>

      <!-- Seasonality chart: gray baseline + orange wedge above it -->
      <div class="cm-mlv-chart-wrap">
        <div class="cm-mlv-chart-legend">
          <span class="cm-mlv-legend-swatch cm-mlv-legend-swatch--wedge"></span>
          <span>Seasonal flex (peak uplift above baseline)</span>
          <span class="cm-mlv-legend-swatch cm-mlv-legend-swatch--base" style="margin-left:16px;"></span>
          <span>Baseline (year-round min-month FTE)</span>
        </div>
        <div class="cm-mlv-chart${selectedYear === 0 ? ' is-all-years' : ''}" role="img"
             aria-label="Monthly direct-labor FTE curve${selectedYear === 0 ? ' across the full contract' : ` for year ${selectedYear}`}">
          ${chartBars}
        </div>
        <div class="cm-mlv-chart-axis${selectedYear === 0 ? ' is-all-years' : ''}">
          ${xAxis}
        </div>
      </div>

      <!-- Inline Sync CTA — directly under the chart that surfaces the flex -->
      ${hasAnyFlex ? `
        <div class="cm-mlv-flex-cta">
          <div class="cm-mlv-flex-cta__text">
            <strong>Peak months</strong> need ${flexParts.join(', ')} above the year-round baseline.
            Sync these into Equipment (as peak-markup %) and Indirect Labor (as peak-only HC) so the P&L and pricing reflect the seasonal cost.
          </div>
          <button class="hub-btn hub-btn-primary hub-btn-sm cm-mlv-flex-cta__btn" data-action="sync-seasonal-flex"
                  title="Populate peak_markup_pct on matching Equipment lines (20% default) + peak_only_hc/peak_months/peak_markup_pct on matching Indirect lines (30% temp-agency default, 3 peak months). Non-destructive: leaves your baseline quantity/headcount alone.">
            ↻ Sync flex → Equipment / Indirect
          </button>
        </div>
      ` : `
        <div class="cm-mlv-flex-cta cm-mlv-flex-cta--empty">
          <div class="cm-mlv-flex-cta__text">
            No seasonal flex detected in ${selectedYear === 0 ? 'the full contract' : `Y${selectedYear}`}. Staffing is flat across all ${monthsInView.length} months — nothing to sync.
          </div>
        </div>
      `}

      <!-- MHE implications table -->
      <div style="margin-top:20px;">
        <div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin-bottom:6px;">MHE Fleet — implied by line-level assignments ÷ ${shiftsPerDay} shift${shiftsPerDay > 1 ? 's' : ''}</div>
        <div class="hub-card" style="padding:0;overflow:hidden;">
          <table class="hub-datatable hub-datatable--dense">
            <thead>
              <tr>
                <th>Type</th>
                <th class="hub-num">Peak FTE (month)</th>
                <th class="hub-num">Min FTE (month)</th>
                <th class="hub-num" title="Count needed at peak month">Peak Count</th>
                <th class="hub-num" title="Count needed year-round (min-month FTE)">Baseline</th>
                <th class="hub-num" title="Seasonal flex: candidate for short-term lease">Seasonal Flex</th>
              </tr>
            </thead>
            <tbody>
              ${typeRows(byMhe, t => MHE_LABELS[t] || t)}
            </tbody>
          </table>
        </div>
      </div>

      <!-- IT implications table -->
      <div style="margin-top:16px;">
        <div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin-bottom:6px;">IT / Device Fleet</div>
        <div class="hub-card" style="padding:0;overflow:hidden;">
          <table class="hub-datatable hub-datatable--dense">
            <thead>
              <tr>
                <th>Type</th>
                <th class="hub-num">Peak FTE (month)</th>
                <th class="hub-num">Min FTE (month)</th>
                <th class="hub-num">Peak Count</th>
                <th class="hub-num">Baseline</th>
                <th class="hub-num">Seasonal Flex</th>
              </tr>
            </thead>
            <tbody>
              ${typeRows(byIt, t => IT_LABELS[t] || t)}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Indirect implications -->
      ${indirect ? `
      <div style="margin-top:16px;">
        <div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-500);margin-bottom:6px;">Indirect Staffing — scaled with direct peak vs avg</div>
        <div class="hub-card" style="padding:14px 16px;background:var(--ies-gray-50);">
          <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:12px;margin-bottom:10px;">
            <div class="cm-mlv-kpi" style="background:#fff;">
              <div class="cm-mlv-kpi-label">PEAK INDIRECT HC</div>
              <div class="cm-mlv-kpi-value">${indirect.peakHc}</div>
              <div class="cm-mlv-kpi-sub">peak direct FTE assumption</div>
            </div>
            <div class="cm-mlv-kpi" style="background:#fff;">
              <div class="cm-mlv-kpi-label">AVG INDIRECT HC</div>
              <div class="cm-mlv-kpi-value">${indirect.avgHc}</div>
              <div class="cm-mlv-kpi-sub">avg direct FTE assumption</div>
            </div>
            <div class="cm-mlv-kpi" style="background:#fff;">
              <div class="cm-mlv-kpi-label">SEASONAL FLEX HC</div>
              <div class="cm-mlv-kpi-value" style="color:var(--ies-orange, #d97706);">${indirect.seasonalHc}</div>
              <div class="cm-mlv-kpi-sub">candidates for temp staffing</div>
            </div>
          </div>
          ${indirect.byRole && indirect.byRole.some(r => r.seasonalHc > 0) ? `
            <details style="margin-top:6px;">
              <summary style="cursor:pointer;font-size:12px;color:var(--ies-gray-600);">Breakdown by role</summary>
              <table class="hub-datatable hub-datatable--dense" style="margin-top:8px;">
                <thead><tr><th>Role</th><th class="hub-num">Peak HC</th><th class="hub-num">Avg HC</th><th class="hub-num">Δ Seasonal</th></tr></thead>
                <tbody>
                  ${indirect.byRole.map(r => `
                    <tr>
                      <td>${escapeHtml(r.role)}</td>
                      <td class="hub-num">${r.peakHc}</td>
                      <td class="hub-num">${r.avgHc}</td>
                      <td class="hub-num">${r.seasonalHc > 0 ? `<span style="color:var(--ies-orange, #d97706);font-weight:600;">+${r.seasonalHc}</span>` : '—'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </details>
          ` : ''}
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

/**
 * Read-only summary banner for Labor section — replaces the old "Global
 * Costing Factors" duplicate card. The editable source of truth lives on
 * Labor Factors (section key: 'shifts'). This banner just surfaces the
 * current values inline so the user doesn't have to navigate away to check.
 *
 * Brock 2026-04-21 pm: renamed Wage Load → Benefit Load. PTO/Holiday now
 * hours-based. Segmented buckets live on Labor Factors; this banner shows
 * the rolled-up total. Per-position overrides live in the Position Catalog.
 */
function renderLaborFactorsBanner(lc, shifts) {
  const s = shifts || {};
  const benefitLoad = lc?.defaultBurdenPct ?? 32;
  const ot          = lc?.overtimePct      ?? 5;
  const bonus       = s.bonusPct           ?? 5;
  const turnover    = lc?.turnoverPct      ?? 45;
  const ptoHrs      = Math.max(0, Math.round(Number(s.ptoHoursPerYear     ?? 80)));
  const holidayHrs  = Math.max(0, Math.round(Number(s.holidayHoursPerYear ?? 64)));
  const util        = s.directUtilization  ?? 85;
  const chip = (label, value, suffix = '%') => `
    <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#fff;border:1px solid var(--ies-gray-200);border-radius:999px;font-size:12px;line-height:1.2;">
      <span style="color:var(--ies-gray-500);">${label}</span>
      <span style="font-weight:600;color:var(--ies-gray-800);">${value}${suffix}</span>
    </span>`;
  return `
    <div class="hub-card" style="padding:12px 16px;background:var(--ies-gray-50);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:12px;color:var(--ies-gray-500);font-weight:500;">Global factors</span>
        ${chip('Benefit Load', Number(benefitLoad).toFixed(1))}
        ${chip('OT', ot)}
        ${chip('Bonus', bonus)}
        ${chip('Turnover', turnover)}
        ${chip('PTO', ptoHrs, ' hrs')}
        ${chip('Holiday', holidayHrs, ' hrs')}
        ${chip('Util', util)}
      </div>
      <button class="hub-btn hub-btn-secondary hub-btn-sm"
              data-action="goto-section" data-section="shifts"
              title="Edit these factors on the Labor Factors page">
        Edit in Labor Factors →
      </button>
    </div>
  `;
}

function renderLaborKpiStripV2(lineCount, totalFtes, totalDirect, totalIndirect) {
  return `
    <div class="hub-kpi-strip" style="margin-top:12px;">
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Direct Lines</div>
        <div class="hub-kpi-tile__value">${lineCount}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Total Direct FTEs</div>
        <div class="hub-kpi-tile__value">${totalFtes.toFixed(1)}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Direct Annual $</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">${calc.formatCurrency(totalDirect)}</div>
      </div>
      <div class="hub-kpi-tile">
        <div class="hub-kpi-tile__label">Indirect Annual $</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">${calc.formatCurrency(totalIndirect)}</div>
      </div>
    </div>
  `;
}

function renderLaborMasterPane(lines, opHrs, lc) {
  // Pre-compute total direct labor cost once so each master item can
  // render its share. Passed into renderLaborMasterItem so it doesn't
  // re-sum the array N times.
  const totalDirectCost = lines.reduce((s, l) => s + calc.directLineAnnualSimple(l, lc), 0);
  return `
    <div class="hub-master-detail__master">
      <div class="hub-master-detail__master-header">
        <span>Lines (${lines.length})</span>
        <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="add-labor" title="Add a new direct labor line">+ Add</button>
      </div>
      <div class="hub-master-detail__master-body">
        ${lines.length === 0
          ? `<div class="hub-master-detail__empty"><div style="font-size:28px;margin-bottom:8px;">👥</div>No direct labor lines yet.<br/><span style="color:var(--ies-gray-500);">Click <strong>+ Add</strong> to create one.</span></div>`
          : lines.map((l, i) => renderLaborMasterItem(l, i, opHrs, lc, totalDirectCost)).join('')}
      </div>
    </div>
  `;
}

/**
 * Build the Shift chip for a Direct Labor master-pane row. Shows how the
 * line relates to the Shift Planning matrix (explicit, split, or unset).
 *
 * Returns a chip HTML string, or '' when there's no signal to show.
 * Brock 2026-04-22 — day-1 MVP surface for Shift Planner on Direct Labor.
 */
function buildShiftChipForLine(l) {
  if (!l) return '';
  // Explicit override wins
  if (l.shift === 'floating' || l.shift === 'Floating') {
    return `<span class="hub-chip hub-chip--brand" title="Floating across shifts (no pin)">Floating</span>`;
  }
  const s = Number(l.shift);
  if (Number.isFinite(s) && s > 0) {
    return `<span class="hub-chip hub-chip--brand" title="Manually assigned to Shift ${s}">S${s}</span>`;
  }
  // Matrix-driven path: allocation exists AND the line maps to a function AND
  // that row has any non-zero cell → "Split".
  const alloc = model && model.shiftAllocation;
  if (!alloc || !alloc.matrix) return '';
  const fn = shiftPlannerCalc.deriveFunctionForLine(l);
  if (!fn) return '';
  const row = alloc.matrix[fn];
  if (!Array.isArray(row) || !row.some(v => Number(v) > 0)) return '';
  const tip = row.map((v, i) => `S${i + 1}: ${(Number(v) || 0).toFixed(0)}%`).join(' · ');
  return `<span class="hub-chip hub-chip--info" title="Split via Shift Planning matrix — ${escapeAttr(tip)}">Split</span>`;
}

function renderLaborMasterItem(l, i, opHrs, lc, totalDirectCost = 0) {
  const selected = i === _selectedLaborIdx;
  const emp = EMPLOYMENT_CHIP[l.employment_type || 'permanent'] || EMPLOYMENT_CHIP.permanent;
  const fte = calc.fte(l, opHrs);
  const annualCost = calc.directLineAnnualSimple(l, lc);
  const activityLabel = l.activity_name || '(unnamed activity)';
  const hasSeasonality = Array.isArray(l.monthly_overtime_profile) || Array.isArray(l.monthly_absence_profile);
  const hasVariance = (l.performance_variance_pct || 0) > 0;

  // NEW: share-of-total direct labor. Brock ask — helps the team focus on
  // the big activities driving labor. Shown as a compact pill + a thin
  // bar underneath the row so scanning the list surfaces outliers fast.
  const sharePct = totalDirectCost > 0 ? (annualCost / totalDirectCost) * 100 : 0;
  const shareStr = sharePct >= 10 ? `${sharePct.toFixed(0)}%` : `${sharePct.toFixed(1)}%`;
  // Color the share chip by magnitude: top-tier lines (>20% of total) get
  // a subtle blue highlight so eyes go there first.
  const shareVariant = sharePct >= 20 ? 'info' : 'neutral';

  // Bucket chip — shows which pricing bucket this line feeds
  const bucket = (model.pricingBuckets || []).find(b => b.id === l.pricing_bucket);
  const bucketChip = bucket
    ? `<span class="hub-chip hub-chip--neutral" title="Routes to pricing bucket: ${escapeAttr(bucket.name)}">📦 ${escapeHtml(bucket.name)}</span>`
    : `<span class="hub-chip hub-chip--danger" title="No pricing bucket assigned — this line's cost will orphan to Management Fee">⚠ no bucket</span>`;

  // Shift chip (2026-04-22 Brock) — surfaces how this line relates to the
  // Shift Planning matrix. Three states:
  //   explicit shift (S1/S2/S3/Floating) → brand chip, user manually pinned
  //   matrix-driven (allocation exists + line has a matchable function)   → info chip "Split"
  //   no matrix, no explicit shift                                         → nothing (clean)
  const shiftChip = buildShiftChipForLine(l);

  // Inline bar visualizing share — helps scan the list at a glance
  // without reading every percentage. Capped at 100% width.
  const barWidth = Math.min(100, Math.max(0, sharePct));
  const barColor = sharePct >= 20 ? 'var(--ies-blue, #0047AB)' : 'var(--ies-gray-300, #d1d5db)';

  return `
    <div class="hub-master-detail__item${selected ? ' is-selected' : ''}" data-labor-select="${i}" title="Click to edit">
      <div class="hub-master-detail__item-primary">
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(activityLabel)}</span>
        <span class="hub-master-detail__item-value">${calc.formatCurrency(annualCost)}</span>
      </div>
      <div class="hub-master-detail__item-secondary">
        <span class="hub-chip hub-chip--${emp.variant}">${emp.label}</span>
        <span class="hub-chip hub-chip--${shareVariant}" title="${shareStr} of total direct labor cost (${calc.formatCurrency(annualCost)} of ${calc.formatCurrency(totalDirectCost)})">${shareStr} of DL</span>
        ${bucketChip}
        ${shiftChip}
        <span>${fte.toFixed(1)} FTE · ${(l.base_uph || 0).toLocaleString()} UPH</span>
        ${hasSeasonality ? `<span class="hub-chip hub-chip--info" title="Has monthly OT/absence seasonality">📊</span>` : ''}
        ${hasVariance ? `<span class="hub-chip hub-chip--warn" title="Variance ±${l.performance_variance_pct}%">±${l.performance_variance_pct}%</span>` : ''}
      </div>
      <div class="cm-labor-share-bar" aria-hidden="true" title="${shareStr} of total direct labor">
        <div class="cm-labor-share-bar__fill" style="width:${barWidth.toFixed(2)}%; background:${barColor};"></div>
      </div>
    </div>
  `;
}

function renderLaborDetailPane(lines, opHrs, lc) {
  if (lines.length === 0) {
    return `
      <div class="hub-master-detail__detail">
        <div class="hub-master-detail__empty">
          <div style="font-size:14px;color:var(--ies-gray-600);margin-bottom:6px;">Nothing to edit yet.</div>
          Add a line from the panel on the left to start defining direct labor.
        </div>
      </div>
    `;
  }
  const i = _selectedLaborIdx;
  const l = lines[i];
  if (!l) return `<div class="hub-master-detail__detail"><div class="hub-master-detail__empty">Select a line on the left to edit.</div></div>`;

  const hourly = l.hourly_rate || 0;
  const fte = calc.fte(l, opHrs);
  const annualCost = calc.directLineAnnualSimple(l, lc);
  const empType = l.employment_type || 'permanent';
  const isTemp = empType === 'temp_agency';

  const buckets = model.pricingBuckets || [];

  return `
    <div class="hub-master-detail__detail">
      <div class="hub-master-detail__detail-header">
        <h3 class="hub-master-detail__detail-title">${escapeHtml(l.activity_name || `Line ${i + 1}`)}</h3>
        <div style="display:flex;gap:6px;">
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-cm-action="edit-labor-seasonality" data-idx="${i}" title="Edit monthly OT/absence seasonality">📊 Seasonality</button>
          <button class="cm-delete-btn" data-action="delete-labor" data-idx="${i}" title="Delete this line">Delete</button>
        </div>
      </div>

      <!-- Group 1: Activity + MOST (2-col) -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Activity</h4>
        <div class="hub-detail-grid hub-detail-grid--2col">
          <div class="hub-field">
            <label class="hub-field__label">Activity Name</label>
            <input class="hub-input" value="${escapeAttr(l.activity_name || '')}" data-array="laborLines" data-idx="${i}" data-field="activity_name" placeholder="e.g. Pick — case"/>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">MOST Template</label>
            ${renderMostCell(l, i)}
          </div>
        </div>
      </div>

      <!-- Group 2: Volume + UPH (4-col) -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Volume &amp; Productivity</h4>
        <div class="hub-detail-grid hub-detail-grid--4col">
          <div class="hub-field">
            <label class="hub-field__label">Volume Source</label>
            ${renderLaborVolumeCell(l, i)}
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Base UPH (raw MOST throughput, excludes PF&D)">Base UPH</label>
            <input class="hub-input hub-num" type="number" step="1" value="${l.base_uph || 0}" data-array="laborLines" data-idx="${i}" data-field="base_uph" data-type="number" />
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Effective UPH = Base UPH × Direct Utilization × productivity_pct per Labor Build-Up Logic doc §2.1. This is the throughput an operator actually delivers after PF&D.">Effective UPH</label>
            <div class="hub-detail-readonly" style="color:var(--ies-blue,#0047AB);">${effectiveUphForLine(l).toLocaleString(undefined, {maximumFractionDigits:1})}</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Volume ÷ Base UPH. Click 'Apply PF&D Haircut to Hours' above to divide by Effective UPH instead (adds ~15% hours to match reality).">Annual Hours</label>
            <div class="hub-detail-readonly">${(l.annual_hours || 0).toLocaleString(undefined, {maximumFractionDigits:0})}</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">FTEs</label>
            <div class="hub-detail-readonly">${fte.toFixed(2)}</div>
          </div>
        </div>
      </div>

      <!-- Group 3: Equipment (2-col) -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Equipment Assigned</h4>
        <div class="hub-detail-grid hub-detail-grid--2col">
          <div class="hub-field">
            <label class="hub-field__label">MHE</label>
            <select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="mhe_type" title="Material-handling equipment">
              <option value=""${!l.mhe_type && !['reach_truck','sit_down_forklift','stand_up_forklift','order_picker','walkie_rider','pallet_jack','electric_pallet_jack','turret_truck','amr','conveyor','manual'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
              <option value="reach_truck"${(l.mhe_type === 'reach_truck' || l.equipment_type === 'reach_truck') ? ' selected' : ''}>Reach Truck</option>
              <option value="sit_down_forklift"${(l.mhe_type === 'sit_down_forklift' || l.equipment_type === 'sit_down_forklift') ? ' selected' : ''}>Sit-Down FL</option>
              <option value="stand_up_forklift"${(l.mhe_type === 'stand_up_forklift' || l.equipment_type === 'stand_up_forklift') ? ' selected' : ''}>Stand-Up FL</option>
              <option value="order_picker"${(l.mhe_type === 'order_picker' || l.equipment_type === 'order_picker') ? ' selected' : ''}>Order Picker</option>
              <option value="walkie_rider"${(l.mhe_type === 'walkie_rider' || l.equipment_type === 'walkie_rider') ? ' selected' : ''}>Walkie Rider</option>
              <option value="pallet_jack"${(l.mhe_type === 'pallet_jack' || l.equipment_type === 'pallet_jack') ? ' selected' : ''}>Pallet Jack</option>
              <option value="electric_pallet_jack"${(l.mhe_type === 'electric_pallet_jack' || l.equipment_type === 'electric_pallet_jack') ? ' selected' : ''}>Elec Pallet Jack</option>
              <option value="turret_truck"${(l.mhe_type === 'turret_truck' || l.equipment_type === 'turret_truck') ? ' selected' : ''}>Turret Truck</option>
              <option value="amr"${(l.mhe_type === 'amr' || l.equipment_type === 'amr') ? ' selected' : ''}>AMR / Robot</option>
              <option value="conveyor"${(l.mhe_type === 'conveyor' || l.equipment_type === 'conveyor') ? ' selected' : ''}>Conveyor</option>
              <option value="manual"${(l.mhe_type === 'manual' || l.equipment_type === 'manual') ? ' selected' : ''}>Manual / Walk</option>
            </select>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">IT / Device</label>
            <select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="it_device" title="IT / scanning device">
              <option value=""${!l.it_device && !['rf_scanner','voice_pick'].includes(l.equipment_type) ? ' selected' : ''}>None</option>
              <option value="rf_scanner"${(l.it_device === 'rf_scanner' || l.equipment_type === 'rf_scanner') ? ' selected' : ''}>RF Scanner</option>
              <option value="voice_pick"${(l.it_device === 'voice_pick' || l.equipment_type === 'voice_pick') ? ' selected' : ''}>Voice Pick</option>
              <option value="wearable"${l.it_device === 'wearable' ? ' selected' : ''}>Wearable</option>
              <option value="tablet"${l.it_device === 'tablet' ? ' selected' : ''}>Tablet</option>
              <option value="vision_system"${l.it_device === 'vision_system' ? ' selected' : ''}>Vision System</option>
              <option value="pick_to_light"${l.it_device === 'pick_to_light' ? ' selected' : ''}>Pick-to-Light</option>
              <option value="pick_to_display"${l.it_device === 'pick_to_display' ? ' selected' : ''}>Pick-to-Display</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Group 3b: Position (Brock 2026-04-20) — primary lever. Pulls
           wage/employment/markup from the Labor Factors catalog so those
           fields become derived (still editable as per-line overrides). -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Position</h4>
        <div class="hub-detail-grid hub-detail-grid--2col">
          <div class="hub-field">
            <label class="hub-field__label" title="Select a role from the Labor Factors Position Catalog. Rate/employment/markup below will pull from the selected position.">Labor Position</label>
            ${renderPositionCell(l, i, 'direct')}
            <div class="hub-field__hint">Edit the catalog in <strong>Structure → Labor Factors</strong>.</div>
          </div>
          <div class="hub-field" style="align-self:flex-end;">
            ${l.position_id
              ? (() => {
                  const p = ((model.shifts && model.shifts.positions) || []).find(pp => pp.id === l.position_id);
                  return p ? `<div class="hub-field__hint"><strong>${escapeHtml(p.name)}</strong> · ${p.employment_type === 'temp_agency' ? 'Temp Agency' : p.employment_type === 'contractor' ? 'Contractor' : 'Permanent'} · $${(p.hourly_wage || 0).toFixed(2)}/hr${p.employment_type === 'temp_agency' ? ` · +${p.temp_markup_pct || 0}% mkup` : ''}</div>`
                         : `<div class="hub-field__hint" style="color:var(--ies-orange);">⚠ Linked position not found</div>`;
                })()
              : `<div class="hub-field__hint">No position selected — rate/employment below are used as-is.</div>`}
          </div>
        </div>
      </div>

      <!-- Group 4: Rate & Employment (4-col) — overrides of the Position attrs -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Rate &amp; Employment <span style="font-size:11px;font-weight:500;color:var(--ies-gray-400);">${l.position_id ? '(pulled from position · edit here to override)' : '(manual)'}</span></h4>
        <div class="hub-detail-grid hub-detail-grid--4col">
          <div class="hub-field">
            <label class="hub-field__label">Base Hourly Rate</label>
            <input class="hub-input hub-num" type="number" step="0.25" min="0" value="${hourly}" data-array="laborLines" data-idx="${i}" data-field="hourly_rate" data-type="number" />
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Employment Type</label>
            <select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="employment_type">
              <option value="permanent"${empType === 'permanent' ? ' selected' : ''}>Permanent</option>
              <option value="temp_agency"${empType === 'temp_agency' ? ' selected' : ''}>Temp Agency</option>
              <option value="contractor"${empType === 'contractor' ? ' selected' : ''}>Contractor</option>
            </select>
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Agency markup over base wage. Only applies to Temp Agency lines.">Temp Markup %</label>
            <input class="hub-input hub-num" type="number" step="1" min="0" max="100" value="${l.temp_agency_markup_pct || 0}" data-array="laborLines" data-idx="${i}" data-field="temp_agency_markup_pct" data-type="number" ${!isTemp ? 'disabled' : ''} />
            ${!isTemp ? '<div class="hub-field__hint">(Temp Agency only)</div>' : ''}
          </div>
          <div class="hub-field">
            <label class="hub-field__label" title="Productivity variance (% std dev) fed into the Monte Carlo sensitivity card in Summary.">Variance %</label>
            <input class="hub-input hub-num" type="number" step="1" min="0" max="50" value="${l.performance_variance_pct || 0}" data-array="laborLines" data-idx="${i}" data-field="performance_variance_pct" data-type="number" />
            <div class="hub-field__hint">Monte Carlo σ</div>
          </div>
        </div>
      </div>

      <!-- Group 5: Pricing Bucket (2-col) — the restored field -->
      <div class="hub-detail-group">
        <h4 class="hub-detail-group__title">Cost Routing</h4>
        <div class="hub-detail-grid hub-detail-grid--2col">
          <div class="hub-field">
            <label class="hub-field__label" title="Which pricing bucket this line's cost flows into. Defined in Structure → Pricing Buckets.">Pricing Bucket</label>
            ${buckets.length === 0
              ? `<div class="hub-field__error">No buckets defined. <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="jump-to-buckets" style="padding:2px 8px;font-size:11px;margin-left:6px;">Open Buckets →</button></div>`
              : `<select class="hub-input" data-array="laborLines" data-idx="${i}" data-field="pricing_bucket">
                   <option value=""${!l.pricing_bucket ? ' selected' : ''}>— Unassigned —</option>
                   ${buckets.map(b => `<option value="${escapeAttr(b.id)}"${l.pricing_bucket === b.id ? ' selected' : ''}>${escapeHtml(b.name)} (${b.type}/${b.uom})</option>`).join('')}
                 </select>`}
          </div>
          <div class="hub-field" style="align-self:flex-end;">
            ${l.pricing_bucket
              ? `<div class="hub-field__hint">Cost flows to rate card as part of the <strong>${escapeHtml((buckets.find(b => b.id === l.pricing_bucket) || {}).name || '')}</strong> bucket.</div>`
              : `<div class="hub-field__error">⚠ Unassigned costs are rolled into Management Fee. Pick a bucket above.</div>`}
          </div>
        </div>
      </div>

      <!-- Group 6: Calculated output (read-only callout) -->
      <div class="hub-detail-group hub-detail-readout" style="background:var(--ies-gray-50);padding:16px 18px;border-radius:10px;margin:0;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;">
          <div>
            <div class="hub-field__label" style="margin-bottom:4px;">Annual Cost (loaded)</div>
            <div style="font-size:20px;font-weight:800;color:var(--ies-blue);line-height:1.1;">${calc.formatCurrency(annualCost)}</div>
          </div>
          <div style="text-align:right;font-size:12px;color:var(--ies-gray-500);line-height:1.5;">
            <div>${fte.toFixed(2)} FTE · ${(l.annual_hours || 0).toLocaleString(undefined, {maximumFractionDigits:0})} hrs/yr</div>
            <div>Base rate $${hourly.toFixed(2)}/hr · burden applied</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/** Safe attribute-value escape (quotes + basic). */
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderEquipment() {
  const lines = model.equipmentLines || [];
  // Monthly Labor View supplies per-type FTE curves so each equipment
  // line with `peak_markup_pct` set can derive its monthly overflow.
  // Computed once here + re-used per-line; when MLV can't be built
  // (no labor lines / no periods), overflow is null → baseline-only cost.
  const mlv = _tryComputeMlvForEquipment();
  const shiftsPerDay = Math.max(1, Math.floor(model.shifts?.shiftsPerDay || 1));
  const overflowByLine = calc.equipmentOverflowByLine(lines, { mlv, shiftsPerDay });
  const breakdown = calc.totalEquipmentCostBreakdown(lines, { mlv, shiftsPerDay });
  const total = breakdown.total;
  const capital = calc.totalEquipmentCapital(lines);
  const lineCount = lines.length;
  const mheCount = lines.filter(l => l.category === 'MHE').reduce((s, l) => s + (parseInt(l.quantity) || 1), 0);
  const rackCount = lines.filter(l => l.category === 'Racking').length;

  // Equipment uses a table rather than master-detail because each row has
  // few enough fields to fit a dense grid legibly. Migrated to hub-datatable
  // primitives + KPI strip summary on top.
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Equipment</div>
        <div class="cm-section-desc">MHE, IT, racking, dock, and infrastructure equipment. Toggle lease vs purchase per line.</div>
      </div>
    </div>

    <!-- KPI strip — at-a-glance summary (primitives kit) -->
    ${lineCount > 0 ? `
      <div class="hub-kpi-strip mb-4">
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Lines</div>
          <div class="hub-kpi-tile__value">${lineCount}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">MHE Units</div>
          <div class="hub-kpi-tile__value">${mheCount}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Annual Operating</div>
          <div class="hub-kpi-tile__value">${calc.formatCurrency(total, {compact: true})}</div>
        </div>
        <div class="hub-kpi-tile">
          <div class="hub-kpi-tile__label">Capital</div>
          <div class="hub-kpi-tile__value">${calc.formatCurrency(capital, {compact: true})}</div>
        </div>
      </div>
    ` : ''}

    <div class="cm-section-toolbar">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-equipment"
              title="Generates a starting equipment list from your current volumes + labor + facility sqft. Rules:
• MHE — Reach Trucks (1 per 3 FTEs × 1.15 spare) + Order Pickers (1 per 5 FTEs)
• IT — RF Terminals (30% of FTEs), Label Printers (1 per 50 HC), WiFi APs (1 per 10K sqft)
• Racking — Selective Pallet Rack sized to avg pallets on-hand + 15% buffer (assumes 12 turns/yr)
• Dock — Hydraulic Levelers sized at 90 daily pallets per door
• Charging — 1 station per 6 electric forklifts
• Office — Build-out (120 sqft per indirect HC) + Break Room (15 sqft per total HC)
• Security — 1 camera system per 30K sqft (for ≥50K sqft facilities) + Access Control
• Conveyor — Belt conveyor linear ft (for ≥500K orders/yr)
All lines are editable after generation.">${(model.equipmentLines || []).length > 0 ? '↻ Regenerate Equipment' : '⚡ Auto-Generate Equipment'}</button>
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="open-equipment-catalog" title="Browse the GXO equipment reference catalog (33 items with specs, pricing, vendors)">📖 Browse Catalog</button>
      <span class="cm-section-toolbar__hint">${(model.equipmentLines || []).length > 0 ? `<b>${(model.equipmentLines || []).length} rows auto-generated</b> — click Regenerate to replace. ` : ''}Covers MHE · IT · Racking · Dock · Charging · Office · Security · Conveyor. Hover for sizing rules.</span>
    </div>

    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense cm-table-equipment">
        <thead>
          <tr>
            <th style="width:150px;">Equipment</th>
            <th style="width:135px;" title="Peak-capacity classification (2026-04-22 Phase 2a).
Owned MHE — permanent fleet, sized to steady-state HC
Rented MHE — short-term peak rental (Phase 2b+ seasonal opex)
IT Equipment — RF/printers/AP, always owned, sized to peak HC
Owned Facility — racking/dock/charging/office/security/conveyor">Line Type</th>
            <th style="width:100px;">Category</th>
            <th class="hub-num" style="width:54px;">Qty</th>
            <th style="width:100px;">Type</th>
            <th class="hub-num" style="width:80px;">$ / Mo</th>
            <th class="hub-num" style="width:88px;">Acq Cost</th>
            <th class="hub-num" style="width:82px;">Maint / Mo</th>
            <th class="hub-num" style="width:72px;">Amort Yrs</th>
            <th class="hub-num" style="width:68px;" title="Short-term rental premium applied to extras needed during peak months (from Monthly Labor View seasonal flex). 0 = no seasonal uplift.">Peak %</th>
            <th class="hub-num" style="width:96px;">Annual</th>
            <th class="cm-actions" style="width:36px;"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => {
            const overflow = overflowByLine[i];
            const lineBd = calc.equipLineAnnualBreakdown(l, overflow);
            const seasonalUnits = overflow ? overflow.reduce((s, u) => s + (u || 0), 0) : 0;
            const peakTooltip = overflow
              ? `MLV overflow this year: ${seasonalUnits} unit-months above baseline (${overflow.map((u, mi) => u > 0 ? `M${mi+1}:+${u}` : '').filter(Boolean).join(' ') || 'none'})`
              : 'No MLV match — set a peak markup to activate seasonal uplift when a matching MHE/IT line exists';
            return `
            <tr>
              <td><input class="hub-input" value="${l.equipment_name || ''}" data-array="equipmentLines" data-idx="${i}" data-field="equipment_name" /></td>
              <td>
                <select class="hub-input" data-array="equipmentLines" data-idx="${i}" data-field="line_type" title="Peak-capacity classification. Drives financing UI (Phase 2b) and auto-gen split (Phase 2d).">
                  <option value="owned_mhe"${l.line_type === 'owned_mhe' ? ' selected' : ''}>Owned MHE</option>
                  <option value="rented_mhe"${l.line_type === 'rented_mhe' ? ' selected' : ''}>Rented MHE</option>
                  <option value="it_equipment"${l.line_type === 'it_equipment' ? ' selected' : ''}>IT Equipment</option>
                  <option value="owned_facility"${l.line_type === 'owned_facility' ? ' selected' : ''}>Owned Facility</option>
                </select>
              </td>
              <td>
                <select class="hub-input" data-array="equipmentLines" data-idx="${i}" data-field="category">
                  ${['MHE', 'IT', 'Racking', 'Dock', 'Charging', 'Office', 'Security', 'Conveyor'].map(c =>
                    `<option value="${c}"${l.category === c ? ' selected' : ''}>${c}</option>`
                  ).join('')}
                </select>
              </td>
              <td><input class="hub-input hub-num" type="number" value="${l.quantity || 1}" data-array="equipmentLines" data-idx="${i}" data-field="quantity" data-type="number" /></td>
              ${(() => {
                // Phase 2b (2026-04-22): financing cells switch by line_type.
                //   owned_mhe / owned_facility — original UI, all 4 financing options
                //   rented_mhe                 — lease-locked, acq disabled, amort_years
                //                                repurposed as seasonal_months picker,
                //                                peak_markup_pct disabled
                //   it_equipment               — capital-locked, "Amort Yrs" title shifts
                //                                to "Refresh Cycle (yrs)"
                const lt = l.line_type || 'owned_facility';
                const norm = calc.normalizeAcqType ? calc.normalizeAcqType(l.acquisition_type) : (l.acquisition_type || 'lease');
                const isRented = lt === 'rented_mhe';
                const isIt = lt === 'it_equipment';
                const smStr = (() => {
                  // Normalize seasonal_months for display — array or missing → "10,11,12"
                  const mo = Array.isArray(l.seasonal_months) ? l.seasonal_months.filter(n => Number.isInteger(n) && n >= 1 && n <= 12) : null;
                  return (mo && mo.length) ? mo.join(',') : '10,11,12';
                })();
                const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const smTooltip = (() => {
                  const parsed = smStr.split(',').map(Number).filter(n => n >= 1 && n <= 12);
                  return parsed.length
                    ? `Peak rental active in: ${parsed.map(n => MONTH_ABBR[n-1]).join(', ')}`
                    : 'Enter peak months as comma-separated numbers 1-12 (defaults to 10,11,12 for Oct-Dec)';
                })();
                const renterDisabledStyle = 'style="background:var(--ies-gray-100,#f3f4f6);color:var(--ies-gray-400,#9ca3af);cursor:not-allowed;"';
                return `
                  <td>
                    ${isRented ? `
                      <select class="hub-input" disabled title="Rented MHE is opex-only — lease is the only option" ${renterDisabledStyle}>
                        <option selected>Rental</option>
                      </select>
                    ` : isIt ? `
                      <select class="hub-input" data-array="equipmentLines" data-idx="${i}" data-field="acquisition_type" data-equip-type-flip="${i}" title="IT Equipment is always capital (refresh-cycle amortized); change with care.">
                        <option value="capital" selected>Capital</option>
                        <option value="lease"${norm === 'lease' ? ' selected' : ''}>Lease</option>
                      </select>
                    ` : `
                      <select class="hub-input" data-array="equipmentLines" data-idx="${i}" data-field="acquisition_type" data-equip-type-flip="${i}" title="Capital = buy + depreciate; Lease = monthly operating lease; TI = built into facility (rolls into rent); Service = per-month managed service (no residual)">
                        <option value="capital"${norm === 'capital' ? ' selected' : ''}>Capital</option>
                        <option value="lease"${norm === 'lease'     ? ' selected' : ''}>Lease</option>
                        <option value="ti"${norm === 'ti'           ? ' selected' : ''}>TI</option>
                        <option value="service"${norm === 'service' ? ' selected' : ''}>Service</option>
                      </select>
                    `}
                  </td>
                  <td><input class="hub-input hub-num" type="number" value="${l.monthly_cost || 0}" data-array="equipmentLines" data-idx="${i}" data-field="monthly_cost" data-type="number" ${isRented ? 'title="Peak rental monthly rate per unit (default rates: reach $1,000 / walkie $650 / sit-down $2,500 / picker $900). Applied only in seasonal months."' : ''}/></td>
                  <td>
                    ${isRented ? `
                      <input class="hub-input hub-num" type="number" value="0" disabled ${renterDisabledStyle} title="Rentals have no acquisition cost" />
                    ` : `
                      <input class="hub-input hub-num" type="number" value="${l.acquisition_cost || 0}" data-array="equipmentLines" data-idx="${i}" data-field="acquisition_cost" data-type="number" ${(() => {
                        if ((norm === 'capital' || norm === 'ti') && (Number(l.acquisition_cost) || 0) <= 0) {
                          return `style="border-color: var(--ies-orange, #d97706); background: rgba(255,193,7,0.08);" title="$0 acquisition cost on a ${norm === 'capital' ? 'Capital' : 'TI'} line — set a unit cost or pull from the Equipment Catalog"`;
                        }
                        return '';
                      })()} />
                    `}
                  </td>
                  <td><input class="hub-input hub-num" type="number" value="${l.monthly_maintenance || 0}" data-array="equipmentLines" data-idx="${i}" data-field="monthly_maintenance" data-type="number" ${isRented ? 'title="Optional maintenance uplift per rental unit — typically bundled into the rental rate, so leave 0"' : ''}/></td>
                  <td>
                    ${isRented ? `
                      <input class="hub-input" type="text" value="${smStr}" data-array="equipmentLines" data-idx="${i}" data-field="seasonal_months" data-type="season-months" title="${escapeAttr(smTooltip)}" style="font-size:11px;text-align:center;" />
                    ` : isIt ? `
                      <input class="hub-input hub-num" type="number" value="${l.amort_years || 5}" data-array="equipmentLines" data-idx="${i}" data-field="amort_years" data-type="number" title="Refresh Cycle (yrs) — how often IT devices are replaced. Typical: 3 yrs RF/handhelds, 5 yrs printers/APs, 7 yrs switches." />
                    ` : `
                      <input class="hub-input hub-num" type="number" value="${l.amort_years || 5}" data-array="equipmentLines" data-idx="${i}" data-field="amort_years" data-type="number" />
                    `}
                  </td>
                  <td>
                    ${isRented ? `
                      <input class="hub-input hub-num" type="number" value="0" disabled ${renterDisabledStyle} title="Rented lines are 100% seasonal — no additional peak-% markup needed" />
                    ` : `
                      <input class="hub-input hub-num" type="number" min="0" max="100" step="1" value="${l.peak_markup_pct || 0}" data-array="equipmentLines" data-idx="${i}" data-field="peak_markup_pct" data-type="number" title="${escapeAttr(peakTooltip)}" />
                    `}
                  </td>
                `;
              })()}
              <td class="hub-num" title="${lineBd.seasonal > 0 ? `Baseline ${calc.formatCurrency(lineBd.baseline)} + Seasonal ${calc.formatCurrency(lineBd.seasonal)}` : 'Baseline only'}">
                ${calc.formatCurrency(calc.equipLineTableCost(l, overflow))}${lineBd.seasonal > 0 ? `<span style="display:block;font-size:10px;color:var(--ies-orange,#d97706);font-weight:600;">+${calc.formatCurrency(lineBd.seasonal, {compact:true})} peak</span>` : ''}
              </td>
              <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-equipment" data-idx="${i}" title="Delete row">×</button></td>
            </tr>
          `;}).join('')}
          ${lineCount === 0 ? `
            <tr><td colspan="12" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No equipment lines yet. Click Auto-Generate Equipment or Add Equipment Line to start.</td></tr>
          ` : ''}
          ${breakdown.seasonal > 0 ? `
            <tr style="background:rgba(217,119,6,0.06);">
              <td colspan="10" style="font-weight:600;color:var(--ies-orange,#d97706);">↳ Seasonal Uplift (short-term rental during peak)</td>
              <td class="hub-num" style="font-weight:600;color:var(--ies-orange,#d97706);">+${calc.formatCurrency(breakdown.seasonal)}</td>
              <td></td>
            </tr>
            <tr>
              <td colspan="10" style="font-weight:500;color:var(--ies-gray-500);font-size:12px;">Baseline year-round</td>
              <td class="hub-num" style="color:var(--ies-gray-500);font-size:12px;">${calc.formatCurrency(breakdown.baseline)}</td>
              <td></td>
            </tr>
          ` : ''}
          <tr class="cm-total-row"><td colspan="10">Operating Cost${breakdown.seasonal > 0 ? ' (baseline + seasonal)' : ''}</td><td class="hub-num">${calc.formatCurrency(total)}</td><td></td></tr>
          <tr><td colspan="10" style="font-weight:600; color: var(--ies-gray-500);">Capital Investment</td><td class="hub-num" style="font-weight:600;">${calc.formatCurrency(capital)}</td><td></td></tr>
          ${(() => {
            // EQ-3: surface IT vs non-IT capital split below the total so
            // buy-to-peak IT capex is distinct from MHE/racking purchases.
            const split = calc.equipmentCapitalByType(lines);
            if (split.total <= 0) return '';
            return `
              <tr style="font-size:11px;color:var(--ies-gray-500);">
                <td colspan="10" style="text-align:right;padding-right:8px;">↳ IT capex / non-IT capex</td>
                <td class="hub-num" title="EQ-3: IT equipment (RF terminals, printers, APs) capital split out from MHE/racking/conveyor capital. IT refresh cycles (3-7 yrs) differ from MHE life (10+ yrs), so deal modelers want this separated.">${calc.formatCurrency(split.itCapital, {compact:true})} / ${calc.formatCurrency(split.nonItCapital, {compact:true})}</td>
                <td></td>
              </tr>
            `;
          })()}
        </tbody>
      </table>
    </div>

    ${(() => {
      // EQ-1 + EQ-2: Own vs Rent vs Buy-to-Peak ROI compare panel.
      // Only renders when there are MHE lines with cost data — otherwise
      // the comparison is meaningless. Honors the contract term so the
      // 5-year default reflects real deal length.
      const mheLines = lines.filter(l => l && l.category === 'MHE');
      if (mheLines.length === 0) return '';
      const contractYrs = parseInt(model.projectDetails?.contractTerm) || 5;
      const peakOverflowByMHE = mheLines.map(line => {
        const idx = lines.indexOf(line);
        return overflowByLine[idx] || null;
      });
      const roi = calc.totalEquipment3WayRoi(lines, { peakOverflowByLine: lines.map((_, i) => overflowByLine[i]), years: contractYrs });
      // Wins/savings vs the worst alternative for headline framing.
      const ownVsRent = roi.rentYearRound - roi.ownYearRound;
      const buyToPeakVsOwn = roi.ownYearRound - roi.buyToPeak;
      const cheapestPretty = roi.cheapest === 'buy_to_peak' ? 'Buy-to-Peak' : roi.cheapest === 'own' ? 'Own Year-Round' : 'Rent Year-Round';
      const cheapestColor = roi.cheapest === 'buy_to_peak' ? '#0ea5e9' : roi.cheapest === 'own' ? '#10b981' : '#d97706';
      return `
      <div class="hub-card" style="margin-top:24px;border-left:4px solid ${cheapestColor};padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:12px;">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ies-gray-400);">MHE ROI · Own vs Rent vs Buy-to-Peak</div>
            <div style="font-size:13px;color:var(--ies-gray-500);margin-top:2px;">${roi.mheLineCount} MHE line(s) · ${contractYrs}-year horizon · cheapest: <strong style="color:${cheapestColor};">${cheapestPretty}</strong></div>
          </div>
          <div style="font-size:11px;color:var(--ies-gray-400);max-width:340px;text-align:right;line-height:1.5;">Own = capital ÷ amort + maint · Rent = $/mo × 12 × qty · Buy-to-Peak = own steady-state + rent peak overflow.</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
          <div style="border:2px solid ${roi.cheapest==='own'?'#10b981':'#e5e7eb'};border-radius:8px;padding:12px;background:${roi.cheapest==='own'?'rgba(16,185,129,0.05)':'#fff'};">
            <div style="font-size:11px;font-weight:700;color:#10b981;letter-spacing:0.5px;">OWN YEAR-ROUND</div>
            <div style="font-size:22px;font-weight:700;color:var(--ies-blue);margin-top:4px;">${calc.formatCurrency(roi.ownYearRound, {compact:true})}</div>
            <div style="font-size:11px;color:var(--ies-gray-500);margin-top:4px;">Capital amortized + maintenance over ${contractYrs} yr</div>
          </div>
          <div style="border:2px solid ${roi.cheapest==='rent'?'#d97706':'#e5e7eb'};border-radius:8px;padding:12px;background:${roi.cheapest==='rent'?'rgba(217,119,6,0.05)':'#fff'};">
            <div style="font-size:11px;font-weight:700;color:#d97706;letter-spacing:0.5px;">RENT YEAR-ROUND</div>
            <div style="font-size:22px;font-weight:700;color:var(--ies-blue);margin-top:4px;">${calc.formatCurrency(roi.rentYearRound, {compact:true})}</div>
            <div style="font-size:11px;color:var(--ies-gray-500);margin-top:4px;">Monthly rate × 12 × qty × ${contractYrs} yr</div>
          </div>
          <div style="border:2px solid ${roi.cheapest==='buy_to_peak'?'#0ea5e9':'#e5e7eb'};border-radius:8px;padding:12px;background:${roi.cheapest==='buy_to_peak'?'rgba(14,165,233,0.05)':'#fff'};">
            <div style="font-size:11px;font-weight:700;color:#0ea5e9;letter-spacing:0.5px;">BUY-TO-PEAK ✓</div>
            <div style="font-size:22px;font-weight:700;color:var(--ies-blue);margin-top:4px;">${calc.formatCurrency(roi.buyToPeak, {compact:true})}</div>
            <div style="font-size:11px;color:var(--ies-gray-500);margin-top:4px;">Own steady-state + rent peak overflow</div>
          </div>
        </div>

        <!-- EQ-2: per-line break-even table -->
        <div style="font-size:12px;font-weight:700;color:var(--ies-gray-500);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Per-Line Break-Even (Peak Months / yr where Rent wins)</div>
        <div style="overflow-x:auto;">
          <table class="hub-datatable hub-datatable--dense" style="width:100%;font-size:12px;">
            <thead>
              <tr>
                <th style="text-align:left;">Line</th>
                <th class="hub-num">Qty</th>
                <th class="hub-num" title="Per-unit cost of owning (capital ÷ amort_yrs + maintenance × 12)">Annual Own / Unit</th>
                <th class="hub-num" title="Monthly rental rate per unit (from $/Mo column or 1.5%/mo of acq cost as fallback)">Rent $/Mo / Unit</th>
                <th class="hub-num" title="Peak months/year at which renting matches the cost of owning. <0.5 = Always Rent · >12 = Always Own. Anything in-between = the buy-to-peak sweet spot.">Break-Even (mo/yr)</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              ${roi.perLine.map(({ line, roi: lr }) => {
                if (!lr) return '';
                const verdictPretty = lr.verdict === 'always_own' ? '🟢 Always Own' : lr.verdict === 'always_rent' ? '🟠 Always Rent' : lr.verdict === 'buy_to_peak' ? '🔵 Buy-to-Peak' : '⚪ Tied';
                const beStr = lr.breakEvenPeakMonths >= 12 ? '> 12' : lr.breakEvenPeakMonths < 0.5 ? '< 0.5' : lr.breakEvenPeakMonths.toFixed(1);
                return `
                  <tr>
                    <td>${escapeAttr(line.equipment_name || '(unnamed)')}</td>
                    <td class="hub-num">${lr.qtyBaseline}</td>
                    <td class="hub-num">${calc.formatCurrency(lr.annualOwnPerUnit, {compact:true})}</td>
                    <td class="hub-num">${calc.formatCurrency(lr.monthlyRentPerUnit, {compact:true})}</td>
                    <td class="hub-num"><strong>${beStr}</strong>${lr.peakMonths > 0 ? ` <span style="color:var(--ies-gray-400);font-size:10px;">(${lr.peakMonths} actual)</span>` : ''}</td>
                    <td>${verdictPretty}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        ${roi.cheapest === 'buy_to_peak' && buyToPeakVsOwn > 0 ? `
          <div style="margin-top:12px;padding:10px 12px;background:rgba(14,165,233,0.07);border-left:3px solid #0ea5e9;border-radius:4px;font-size:12px;color:var(--ies-blue);">
            <strong>Buy-to-Peak saves ${calc.formatCurrency(buyToPeakVsOwn, {compact:true})}</strong> over Own Year-Round across ${contractYrs} yr — own steady-state and rent the seasonal overflow only when peak labor demands it.
          </div>` : ''}
        ${roi.cheapest === 'own' && ownVsRent > 0 ? `
          <div style="margin-top:12px;padding:10px 12px;background:rgba(16,185,129,0.07);border-left:3px solid #10b981;border-radius:4px;font-size:12px;color:#065f46;">
            <strong>Own Year-Round saves ${calc.formatCurrency(ownVsRent, {compact:true})}</strong> over Rent Year-Round across ${contractYrs} yr — at this utilization, capital recovery beats short-term rental.
          </div>` : ''}
      </div>
    `;
    })()}

    <button class="cm-add-row-btn" data-action="add-equipment">+ Add Equipment Line</button>
  `;
}

/**
 * Sync MLV seasonal flex → Equipment + Indirect lines (Brock 2026-04-20).
 * Non-destructive: never touches line.quantity or line.headcount. Only sets
 * peak_markup_pct / peak_only_hc / peak_months — so the user's baseline
 * inputs are preserved.
 *
 * Default markup rates reflect standard short-term rental / temp-agency
 * premiums; the user can tune them per-line afterward. A default of 0 is
 * retained for lines where we can't find a match (leaves them baseline-
 * only). Shows a toast summarizing what was touched.
 */
function syncSeasonalFlex() {
  const mlv = _tryComputeMlvForEquipment();
  if (!mlv) {
    showToast('Cannot sync — populate Labor lines first', 'warn');
    return;
  }
  const shiftsPerDay = Math.max(1, Math.floor(model.shifts?.shiftsPerDay || 1));
  const byMhe = mlv.summary?.byMhe || {};
  const byIt = mlv.summary?.byIt || {};
  const indirectSum = mlv.summary?.indirect;
  const DEFAULT_EQUIP_MARKUP = 20;
  const DEFAULT_INDIRECT_MARKUP = 30;
  const DEFAULT_PEAK_MONTHS = 3;

  let equipTouched = 0;
  let indirectTouched = 0;

  // ── Equipment: set peak_markup_pct where the line matches a type with seasonal flex ──
  for (const line of (model.equipmentLines || [])) {
    const cat = (line.category || '').toLowerCase();
    const name = (line.equipment_name || '').toLowerCase();
    const mheType = line.mhe_type || '';
    const itDevice = line.it_device || '';

    let summary = null;
    if (mheType && byMhe[mheType]) summary = byMhe[mheType];
    else if (itDevice && byIt[itDevice]) summary = byIt[itDevice];
    else if (cat === 'mhe') {
      for (const key of Object.keys(byMhe)) {
        if (name.includes(key.replace(/_/g, ' ')) || name.includes(key)) { summary = byMhe[key]; break; }
      }
    } else if (cat === 'it') {
      for (const key of Object.keys(byIt)) {
        if (name.includes(key.replace(/_/g, ' ')) || name.includes(key)) { summary = byIt[key]; break; }
      }
    }
    if (summary && summary.seasonalCount > 0) {
      // Only set if not already user-configured (non-destructive)
      if (!line.peak_markup_pct || line.peak_markup_pct === 0) {
        line.peak_markup_pct = DEFAULT_EQUIP_MARKUP;
        equipTouched++;
      }
    }
  }

  // ── Indirect: set peak_only_hc + peak_months + peak_markup_pct per-role ──
  if (indirectSum && indirectSum.byRole && indirectSum.seasonalHc > 0) {
    const byRole = Object.fromEntries(indirectSum.byRole.map(r => [r.role, r]));
    for (const line of (model.indirectLaborLines || [])) {
      const roleMatch = byRole[line.role_name];
      if (roleMatch && roleMatch.seasonalHc > 0) {
        // Non-destructive: only fill if unset
        let changed = false;
        if (!line.peak_only_hc || line.peak_only_hc === 0) {
          line.peak_only_hc = roleMatch.seasonalHc;
          changed = true;
        }
        if (!line.peak_months || line.peak_months === 0) {
          line.peak_months = DEFAULT_PEAK_MONTHS;
          changed = true;
        }
        if (!line.peak_markup_pct || line.peak_markup_pct === 0) {
          line.peak_markup_pct = DEFAULT_INDIRECT_MARKUP;
          changed = true;
        }
        if (changed) indirectTouched++;
      }
    }
  }

  isDirty = true;
  refreshNavCompletion();
  renderSection();

  const parts = [];
  if (equipTouched > 0) parts.push(`${equipTouched} equipment line${equipTouched === 1 ? '' : 's'} (default ${DEFAULT_EQUIP_MARKUP}% markup)`);
  if (indirectTouched > 0) parts.push(`${indirectTouched} indirect role${indirectTouched === 1 ? '' : 's'} (${DEFAULT_PEAK_MONTHS} peak months, ${DEFAULT_INDIRECT_MARKUP}% markup)`);
  if (parts.length === 0) {
    showToast('Nothing to sync — lines already have seasonal settings or no matches found', 'info');
  } else {
    showToast(`Seasonal flex synced: ${parts.join(' + ')}. Tune per-line in Equipment / Indirect.`, 'success');
  }
}

/**
 * Build an MLV computation for the current model — used by Equipment +
 * Indirect renders to pull the seasonal FTE curve. Wraps computeMonthlyLaborView
 * with defensive fallbacks so it never throws if the caller's state is
 * partial (e.g., no labor lines, no periods loaded yet).
 *
 * @returns {Object|null} — full MLV result, or null when unbuildable.
 */
function _tryComputeMlvForEquipment() {
  try {
    const lines = model.laborLines || [];
    if (!lines.length) return null;
    const shifts = model.shifts || {};
    const annualOpHours = calc.operatingHours(shifts);
    const shiftsPerDay = Math.max(1, Math.floor(shifts.shiftsPerDay || 1));
    const contractYears = model.projectDetails?.contractTerm || 5;
    const fin = model.financial || {};
    let periods = (refData?.periods || []).filter(p =>
      p.period_type === 'month' && p.period_index >= 0 && p.period_index < contractYears * 12
    );
    if (periods.length === 0) {
      // Synthesize a simple axis if ref_periods hasn't loaded
      const go = new Date(model.projectDetails?.goLiveDate || '2026-01-01');
      periods = [];
      for (let i = 0; i < contractYears * 12; i++) {
        const d = new Date(go.getFullYear(), go.getMonth() + i, 1);
        periods.push({
          id: i, period_type: 'month', period_index: i,
          calendar_year: d.getFullYear(), calendar_month: d.getMonth() + 1,
          label: `M${i + 1}`, is_pre_go_live: false,
        });
      }
    }
    const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
      currentScenario, currentScenarioSnapshots, heuristicOverrides, fin, whatIfTransient,
    ), model);
    return monthlyCalc.computeMonthlyLaborView({
      laborLines: lines,
      periods, annualOpHours, shiftsPerDay,
      calcHeur,
      marketLaborProfile: currentMarketLaborProfile || null,
      ramp: null,
      seasonality: model.seasonalityProfile || null,
      volGrowthPct: calcHeur?.volGrowthPct || 0,
    });
  } catch (e) {
    console.warn('[CM] MLV build failed for equipment overflow:', e);
    return null;
  }
}

function renderOverhead() {
  const lines = model.overheadLines || [];
  const total = calc.totalOverheadCost(lines);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Overhead</div>
        <div class="cm-section-desc">Facility overhead, IT, insurance, and administrative costs.</div>
      </div>
    </div>

    <div class="cm-section-toolbar">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-overhead">${(model.overheadLines || []).length > 0 ? '↻ Regenerate Overhead' : '⚡ Auto-Generate Overhead'}</button>
      <span class="cm-section-toolbar__hint">${(model.overheadLines || []).length > 0 ? `<b>${(model.overheadLines || []).length} rows auto-generated</b> — click Regenerate to replace. ` : ''}One-click seed from facility sqft + headcount. All rows editable.</span>
    </div>

    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense cm-table-overhead">
        <thead>
          <tr>
            <th style="width:22%;">Category</th>
            <th style="width:36%;">Description</th>
            <th style="width:14%;">Cost Type</th>
            <th style="width:14%;">Amount</th>
            <th class="hub-num" style="width:12%;">Annual</th>
            <th class="cm-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => `
            <tr>
              <td><input class="hub-input" value="${l.category || ''}" data-array="overheadLines" data-idx="${i}" data-field="category" /></td>
              <td><input class="hub-input" value="${l.description || ''}" data-array="overheadLines" data-idx="${i}" data-field="description" /></td>
              <td>
                <select class="hub-input" data-array="overheadLines" data-idx="${i}" data-field="cost_type">
                  <option value="monthly"${l.cost_type === 'monthly' ? ' selected' : ''}>Monthly</option>
                  <option value="annual"${l.cost_type === 'annual' ? ' selected' : ''}>Annual</option>
                </select>
              </td>
              <td><input class="hub-input hub-num" type="number" value="${l.cost_type === 'monthly' ? (l.monthly_cost || 0) : (l.annual_cost || 0)}" data-array="overheadLines" data-idx="${i}" data-field="${l.cost_type === 'monthly' ? 'monthly_cost' : 'annual_cost'}" data-type="number" /></td>
              <td class="hub-num">${calc.formatCurrency(calc.overheadLineAnnual(l))}</td>
              <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-overhead" data-idx="${i}" title="Delete row">×</button></td>
            </tr>
          `).join('')}
          ${lines.length === 0 ? `
            <tr><td colspan="6" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No overhead lines yet. Click Auto-Generate or Add Overhead Line.</td></tr>
          ` : ''}
          <tr class="cm-total-row"><td colspan="4">Total Overhead</td><td class="hub-num">${calc.formatCurrency(total)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <button class="cm-add-row-btn" data-action="add-overhead">+ Add Overhead Line</button>
  `;
}

function renderVas() {
  const lines = model.vasLines || [];
  const total = calc.totalVasCost(lines);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Value-Added Services</div>
        <div class="cm-section-desc">Kitting, labeling, special packaging, and other VAS line items.</div>
      </div>
    </div>
    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense cm-table-vas">
        <thead>
          <tr>
            <th style="width:42%;">Service</th>
            <th style="width:18%;">Rate</th>
            <th style="width:20%;">Volume</th>
            <th class="hub-num" style="width:18%;">Annual Cost</th>
            <th class="cm-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => `
            <tr>
              <td><input class="hub-input" value="${l.service || ''}" data-array="vasLines" data-idx="${i}" data-field="service" /></td>
              <td><input class="hub-input hub-num" type="number" value="${l.rate || 0}" step="0.01" data-array="vasLines" data-idx="${i}" data-field="rate" data-type="number" /></td>
              <td><input class="hub-input hub-num" type="number" value="${l.volume || 0}" data-array="vasLines" data-idx="${i}" data-field="volume" data-type="number" /></td>
              <td class="hub-num">${calc.formatCurrency(calc.vasLineAnnual(l))}</td>
              <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-vas" data-idx="${i}" title="Delete row">×</button></td>
            </tr>
          `).join('')}
          ${lines.length === 0 ? `
            <tr><td colspan="5" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No VAS lines yet. Click Add VAS Line to start.</td></tr>
          ` : ''}
          <tr class="cm-total-row"><td colspan="3">Total VAS</td><td class="hub-num">${calc.formatCurrency(total)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <button class="cm-add-row-btn" data-action="add-vas">+ Add VAS Line</button>
  `;
}

function renderFinancial() {
  const f = model.financial || {};
  // M1 (2026-04-21): G&A + Mgmt Fee are the source of truth; targetMargin
  // is the derived sum, kept for downstream back-compat. Defaults: G&A 6.0,
  // Mgmt Fee 10.0 → Total 16.0.
  const ga  = Number(f.gaMargin  ?? (Number(f.targetMargin || 16) * 0.375).toFixed(2));
  const mgmt = Number(f.mgmtFeeMargin ?? (Number(f.targetMargin || 16) * 0.625).toFixed(2));
  const total = Number((ga + mgmt).toFixed(2));
  const grossUpFactor = (1 / (1 - total / 100)).toFixed(2);
  const contractType = model.projectDetails?.contractType || 'fixed_variable';
  const buckets = model.pricingBuckets || [];
  const storageBucket = buckets.find(b => /storage/i.test(b.name || b.id || ''));
  const mgmtFeeBucket = buckets.find(b => /mgmt|manage/i.test(b.name || b.id || ''));
  const autoBucket = storageBucket || mgmtFeeBucket || buckets[0];
  const autoLabel = autoBucket
    ? `Auto — routes to ${autoBucket.name}`
    : 'Auto — Storage bucket if available, otherwise Management Fee';

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Financial Assumptions</div>
        <div class="cm-section-desc">Margin build-up, growth rates, return targets, and how costs flow into pricing buckets. Revenue is calculated cost-plus: <strong>Revenue = Cost ÷ (1 − Total Margin)</strong>.</div>
      </div>
    </div>

    <div class="cm-fin-grid">

      <!-- ============== Card 1 — Margin & Pricing ============== -->
      <section class="cm-fin-section">
        <header class="cm-fin-section__header">
          <h3>Margin &amp; Pricing</h3>
          <p>The components that build revenue on top of cost, and how the deal is invoiced.</p>
        </header>

        <div class="hub-field hub-field--full">
          <label class="hub-field__label">Target Margin Components</label>
          <div class="cm-margin-split">
            <div class="cm-margin-split-field">
              <div class="cm-margin-split-sublabel" title="Corporate overhead layer that scales with the deal. Typical default 6%.">G&amp;A Margin (%)</div>
              <input class="hub-input" type="number" step="0.25" min="0" max="30" value="${ga}" data-field="financial.gaMargin" data-type="number" />
            </div>
            <div class="cm-margin-split-op">+</div>
            <div class="cm-margin-split-field">
              <div class="cm-margin-split-sublabel" title="Management fee margin layered on top of cost + G&A. Typical default 10%.">Mgmt Fee Margin (%)</div>
              <input class="hub-input" type="number" step="0.25" min="0" max="30" value="${mgmt}" data-field="financial.mgmtFeeMargin" data-type="number" />
            </div>
            <div class="cm-margin-split-op">=</div>
            <div class="cm-margin-split-total">
              <div class="cm-margin-split-sublabel">Total Margin</div>
              <div class="cm-margin-split-total-value">${total.toFixed(2)}%</div>
            </div>
          </div>
          <div class="hub-field__hint">Every $1 of cost generates <strong>$${grossUpFactor}</strong> of revenue. The Pricing Schedule shows each bucket\'s revenue broken into G&amp;A and management-fee components.</div>
        </div>

        <div class="hub-field hub-field--full" style="margin-top:14px;">
          <label class="hub-field__label">Contract Type</label>
          <select class="hub-input" data-field="projectDetails.contractType">
            <option value="fixed_variable"${contractType === 'fixed_variable' ? ' selected' : ''}>Fixed / Variable (standard bucketed pricing)</option>
            <option value="open_book"${contractType === 'open_book' ? ' selected' : ''}>Open Book (cost pass-through + declared margin)</option>
            <option value="unit_rate"${contractType === 'unit_rate' ? ' selected' : ''}>Unit Rate (per-unit rate-card emphasis)</option>
            <option value="split_month"${contractType === 'split_month' ? ' selected' : ''}>Split-Month Billing (fixed monthly fee + variable arrears)</option>
          </select>
          <div class="hub-field__hint">All four use the cost-plus formula above. They differ only in how the invoice is presented and when cash arrives. Split-Month divides the bill into a fixed management fee (paid net-15) and a variable transaction fee (paid net-30 from month-end).</div>
        </div>

        ${contractType === 'split_month' ? `
          <div class="hub-field hub-field--full cm-split-month-controls" style="margin-top:14px;">
            <div class="cm-split-month-header">
              <span class="cm-split-month-title">Split-Month Billing Configuration</span>
              <span class="cm-split-month-subtitle">The customer is invoiced in two cycles per month. Mix and DSO per stream determine the weighted-average DSO used in the cash-flow engine.</span>
            </div>
            <div class="cm-split-month-grid">
              <div class="hub-field">
                <label class="hub-field__label" title="Share of total revenue billed as a fixed monthly management fee at start-of-month. Covers overhead, management, facility. The remainder is billed as a variable transaction fee at month-end.">Fixed Fee (% of total revenue)</label>
                <input class="hub-input" type="number" step="5" min="0" max="100" value="${model.projectDetails?.splitBillingFixedPct != null ? model.projectDetails.splitBillingFixedPct : 40}" data-field="projectDetails.splitBillingFixedPct" data-type="number" />
                <div class="hub-field__hint">30–50% typical. Default 40%.</div>
              </div>
              <div class="hub-field">
                <label class="hub-field__label" title="Days Sales Outstanding for the fixed-fee stream. Short — billed day 1, collected net-15.">Fixed-Fee DSO (days)</label>
                <input class="hub-input" type="number" step="1" min="0" max="90" value="${model.projectDetails?.splitBillingFixedDsoDays != null ? model.projectDetails.splitBillingFixedDsoDays : 15}" data-field="projectDetails.splitBillingFixedDsoDays" data-type="number" />
                <div class="hub-field__hint">Default 15 days.</div>
              </div>
              <div class="hub-field">
                <label class="hub-field__label" title="DSO for the variable transaction-fee stream. Longer — billed day 30 (month-end), collected net-30 → ~60 days after service delivery.">Variable-Fee DSO (days)</label>
                <input class="hub-input" type="number" step="1" min="0" max="120" value="${model.projectDetails?.splitBillingVariableDsoDays != null ? model.projectDetails.splitBillingVariableDsoDays : 45}" data-field="projectDetails.splitBillingVariableDsoDays" data-type="number" />
                <div class="hub-field__hint">Default 45 days.</div>
              </div>
            </div>
            ${(() => {
              const fixedPct = Number(model.projectDetails?.splitBillingFixedPct ?? 40);
              const fixedDso = Number(model.projectDetails?.splitBillingFixedDsoDays ?? 15);
              const varDso   = Number(model.projectDetails?.splitBillingVariableDsoDays ?? 45);
              const weightedDso = (fixedPct / 100) * fixedDso + (1 - fixedPct / 100) * varDso;
              return `
                <div class="cm-split-month-weighted">
                  Weighted-average DSO applied to revenue: <strong>${weightedDso.toFixed(1)} days</strong>
                  (= ${fixedPct.toFixed(0)}% × ${fixedDso} + ${(100 - fixedPct).toFixed(0)}% × ${varDso})
                </div>
              `;
            })()}
          </div>
        ` : ''}
      </section>

      <!-- ============== Card 2 — Year-Over-Year Growth ============== -->
      <section class="cm-fin-section">
        <header class="cm-fin-section__header">
          <h3>Year-Over-Year Growth</h3>
          <p>Annual rates that compound across the multi-year P&amp;L.</p>
        </header>
        <div class="cm-fin-row cm-fin-row--3">
          <div class="hub-field">
            <label class="hub-field__label">Volume Growth (% / yr)</label>
            <input class="hub-input" type="number" value="${f.volumeGrowth || 3}" step="0.5" data-field="financial.volumeGrowth" data-type="number" />
            <div class="hub-field__hint">Applied to inbound, outbound, and storage volumes for years 2+.</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Labor Escalation (% / yr)</label>
            <input class="hub-input" type="number" value="${f.laborEscalation || 4}" step="0.5" data-field="financial.laborEscalation" data-type="number" />
            <div class="hub-field__hint">Annual wage inflation. Often higher than general cost escalation.</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Cost Escalation (% / yr)</label>
            <input class="hub-input" type="number" value="${f.annualEscalation || 3}" step="0.5" data-field="financial.annualEscalation" data-type="number" />
            <div class="hub-field__hint">Non-labor cost growth (utilities, materials, services).</div>
          </div>
        </div>
      </section>

      <!-- ============== Card 3 — Returns & Tax ============== -->
      <section class="cm-fin-section">
        <header class="cm-fin-section__header">
          <h3>Returns &amp; Tax</h3>
          <p>Inputs to NPV, MIRR, and after-tax cash-flow projections.</p>
        </header>
        <div class="cm-fin-row cm-fin-row--3">
          <div class="hub-field">
            <label class="hub-field__label">Discount Rate / WACC (%)</label>
            <input class="hub-input" type="number" value="${f.discountRate || 10}" step="0.5" data-field="financial.discountRate" data-type="number" />
            <div class="hub-field__hint">Used for NPV and MIRR. Typically 8–12% for 3PL contracts.</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Tax Rate (%)</label>
            <input class="hub-input" type="number" value="${model.projectDetails?.taxRate || 25}" step="0.5" min="0" max="50" data-field="projectDetails.taxRate" data-type="number" />
            <div class="hub-field__hint">Federal + state blend. Default 25%. Operating losses don\'t generate refunds.</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Reinvestment Rate (%)</label>
            <input class="hub-input" type="number" value="${f.reinvestRate || 8}" step="0.5" data-field="financial.reinvestRate" data-type="number" />
            <div class="hub-field__hint">Assumed return on reinvested cash. Used in MIRR calculation.</div>
          </div>
        </div>
      </section>

      <!-- ============== Card 4 — Cost Recovery ============== -->
      <section class="cm-fin-section">
        <header class="cm-fin-section__header">
          <h3>Cost Recovery</h3>
          <p>How specific cost categories are routed into the pricing buckets the customer sees.</p>
        </header>
        <div class="cm-fin-row cm-fin-row--2">
          <div class="hub-field">
            <label class="hub-field__label">SG&amp;A Overlay (% of net revenue)</label>
            <input class="hub-input" type="number" step="0.25" min="0" max="30" value="${f.sgaOverlayPct != null ? f.sgaOverlayPct : 0}" data-field="financial.sgaOverlayPct" data-type="number" />
            <div class="hub-field__hint">Optional flat overlay on net revenue, on top of any Overhead and start-up amortization rows. Leave at 0 unless your reference model requires it (4.5% is the typical reference value).</div>
          </div>
          <div class="hub-field">
            <label class="hub-field__label">Facility Cost Recovery</label>
            <select class="hub-input" data-field="financial.facilityBucketId">
              <option value=""${!f.facilityBucketId ? ' selected' : ''}>${autoLabel}</option>
              ${buckets.map(b =>
                `<option value="${b.id}"${f.facilityBucketId === b.id ? ' selected' : ''}>${b.name} (${b.type}/${b.uom})</option>`
              ).join('')}
            </select>
            <div class="hub-field__hint">Facility expenses (lease, CAM, utilities, maintenance) are recovered through one of your pricing buckets. The default routes them into Storage, since pallet positions are what occupy the building. Override only when a client contract requires a specific bucket.</div>
          </div>
        </div>
      </section>

    </div>
  `;
}

function renderStartup() {
  const lines = model.startupLines || [];
  const contractYears = model.projectDetails?.contractTerm || 5;
  const totalCapital = calc.totalStartupCapital(lines);
  const totalAmort = calc.totalStartupAmort(lines, contractYears);
  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Start-Up / Capital</div>
        <div class="cm-section-desc">One-time implementation costs amortized over the ${contractYears}-year contract term.</div>
      </div>
    </div>

    <div class="cm-section-toolbar">
      <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-gen-startup">${(model.startupLines || []).length > 0 ? '↻ Regenerate Start-Up Costs' : '⚡ Auto-Generate Start-Up Costs'}</button>
      <span class="cm-section-toolbar__hint">${(model.startupLines || []).length > 0 ? `<b>${(model.startupLines || []).length} rows auto-generated</b> — click Regenerate to replace. ` : ''}Generates typical 3PL implementation line items (PM, IT, training, travel).</span>
    </div>

    <div class="cm-table-scroll">
      <table class="hub-datatable hub-datatable--dense cm-table-startup">
        <thead>
          <tr>
            <th style="width:38%;">Description</th>
            <th class="hub-num" style="width:14%;">One-Time Cost</th>
            <th style="width:14%;" title="Capitalized = amortized over contract term + grossed up (standard). As-Incurred = zero-margin pass-through (reference Part I §9 sub-branch).">Billing</th>
            <th class="hub-num" style="width:12%;">Annual Amort</th>
            <th class="hub-num" style="width:12%;">Monthly Amort</th>
            <th class="cm-actions"></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => {
            const billingType = l.billing_type || 'capitalized';
            const isAsIncurred = billingType === 'as_incurred';
            // As-Incurred lines bypass amortization (pass-through at cost) — the
            // "Annual Amort" display becomes the one-time cost itself in Y1, 0 after.
            const amort = isAsIncurred ? 0 : (l.one_time_cost || 0) / Math.max(1, contractYears);
            return `
              <tr${isAsIncurred ? ' class="cm-startup-as-incurred"' : ''}>
                <td><input class="hub-input" value="${l.description || ''}" data-array="startupLines" data-idx="${i}" data-field="description" /></td>
                <td><input class="hub-input hub-num" type="number" value="${l.one_time_cost || 0}" data-array="startupLines" data-idx="${i}" data-field="one_time_cost" data-type="number" /></td>
                <td>
                  <select class="hub-input" data-array="startupLines" data-idx="${i}" data-field="billing_type" title="Capitalized = amortized + grossed up. As-Incurred = zero-margin pass-through (customer pays at cost).">
                    <option value="capitalized"${billingType === 'capitalized' ? ' selected' : ''}>Capitalized</option>
                    <option value="as_incurred"${isAsIncurred ? ' selected' : ''}>As-Incurred</option>
                  </select>
                </td>
                <td class="hub-num">${isAsIncurred ? '<span class="cm-as-inc-tag">pass-through</span>' : calc.formatCurrency(amort)}</td>
                <td class="hub-num">${isAsIncurred ? '—' : calc.formatCurrency(amort / 12)}</td>
                <td class="cm-actions"><button class="cm-delete-btn" data-action="delete-startup" data-idx="${i}" title="Delete row">×</button></td>
              </tr>
            `;
          }).join('')}
          ${lines.length === 0 ? `
            <tr><td colspan="5" style="text-align:center;color:var(--ies-gray-400);padding:24px;">No capital line items yet. Click Auto-Generate or Add Capital Item.</td></tr>
          ` : ''}
          <tr class="cm-total-row"><td>Total</td><td class="hub-num">${calc.formatCurrency(totalCapital)}</td><td class="hub-num">${calc.formatCurrency(totalAmort)}</td><td class="hub-num">${calc.formatCurrency(totalAmort / 12)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
    <button class="cm-add-row-btn" data-action="add-startup">+ Add Capital Item</button>
  `;
}

// ============================================================
// SECTION: PRICING BUCKETS (v2 — bucket taxonomy, defined BEFORE cost build)
// ============================================================

/**
 * Starter bucket template — 5 canonical 3PL buckets that cover the
 * typical rate card structure. Seeded when the user clicks "Apply
 * Starter Template" and the project has no existing buckets.
 */
const STARTER_PRICING_BUCKETS = [
  { id: 'mgmt_fee',  name: 'Management Fee',    type: 'fixed',    uom: 'month',  rate: 0,
    description: 'Monthly fixed fee covering overhead and management overhead allocation.' },
  { id: 'storage',   name: 'Storage',           type: 'variable', uom: 'pallet', rate: 0,
    description: 'Storage cost per pallet position per month. Pass-through of facility cost + storage-specific labor/equipment.' },
  { id: 'inbound',   name: 'Inbound Handling',  type: 'variable', uom: 'pallet', rate: 0,
    description: 'Receiving / put-away per inbound pallet. Includes dock, dock-staff, and inbound MHE costs.' },
  { id: 'pick_pack', name: 'Pick & Pack',       type: 'variable', uom: 'order',  rate: 0,
    description: 'Order fulfillment rate per outbound order. Primary pricing bucket for e-comm DTC.' },
  { id: 'vas',       name: 'Value-Added Svcs',  type: 'variable', uom: 'each',   rate: 0,
    description: 'Kitting, labeling, packaging, returns processing — charge per transaction.' },
];

const BUCKET_UOM_OPTIONS = [
  { value: 'month',    label: 'per month' },
  { value: 'pallet',   label: 'per pallet' },
  { value: 'order',    label: 'per order' },
  { value: 'each',     label: 'per unit / each' },
  { value: 'case',     label: 'per case' },
  { value: 'line',     label: 'per line' },
  { value: 'shipment', label: 'per shipment' },
  { value: 'cube',     label: 'per cube (ft³)' },
  { value: 'lb',       label: 'per pound' },
  { value: 'sqft',     label: 'per sqft / month' },
];

function renderPricingBuckets() {
  const buckets = model.pricingBuckets || [];
  const empty = buckets.length === 0;

  return `
    <div class="cm-wide-layout">
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Pricing Buckets</div>
        <div class="cm-section-desc">Define the pricing structure before you build cost lines. Every labor, equipment, overhead, VAS, and startup line routes into one of these buckets, which becomes a line on the customer's rate card.</div>
      </div>
    </div>

    ${empty ? `
      <div class="hub-card" style="margin-bottom:20px;padding:24px;background:var(--ies-gray-50);text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">🧱</div>
        <h3 style="margin:0 0 6px;font-size:16px;font-weight:700;">No pricing buckets yet</h3>
        <div style="color:var(--ies-gray-500);font-size:13px;margin-bottom:16px;max-width:560px;margin-left:auto;margin-right:auto;line-height:1.5;">
          Start with the standard 5-bucket template (Management Fee, Storage, Inbound, Pick &amp; Pack, VAS) — typical for most 3PL deals — or define your own from scratch. You can edit, rename, or add buckets at any time.
        </div>
        <div style="display:flex;gap:10px;justify-content:center;">
          <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="apply-bucket-starter">Apply Starter Template</button>
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="add-bucket">Add Empty Bucket</button>
        </div>
      </div>
    ` : `
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;gap:16px;">
        <div class="hub-field__hint" style="flex:1;max-width:640px;">
          <strong style="color:var(--ies-gray-700);">${buckets.length} bucket${buckets.length === 1 ? '' : 's'}.</strong>
          Each bucket has a pricing type (fixed / variable / cost-plus) and a UOM. Rates are computed in the Pricing step later — or you can set an explicit rate here to override the derivation.
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="auto-assign-buckets" title="Walk all cost lines and assign each one to the bucket suggested by its role / type. Existing assignments are kept.">↻ Auto-assign Lines</button>
          <button class="hub-btn hub-btn-secondary hub-btn-sm" data-action="apply-bucket-starter" title="Reset to the standard 5-bucket template (overwrites current buckets)">↺ Reset to Template</button>
          <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="add-bucket">+ Add Bucket</button>
        </div>
      </div>

      <div class="hub-card" style="padding:0;overflow:hidden;">
        <table class="hub-datatable">
          <thead>
            <tr>
              <th style="width:30%;">Name</th>
              <th style="width:140px;">Pricing Type</th>
              <th style="width:170px;">UOM</th>
              <th class="hub-num" style="width:140px;">Explicit Rate</th>
              <th>Description</th>
              <th style="width:40px;"></th>
            </tr>
          </thead>
          <tbody>
            ${buckets.map((b, i) => `
              <tr>
                <td>
                  <input class="hub-input" value="${escapeAttr(b.name || '')}" data-array="pricingBuckets" data-idx="${i}" data-field="name" placeholder="e.g. Pick &amp; Pack" />
                </td>
                <td>
                  <select class="hub-input" data-array="pricingBuckets" data-idx="${i}" data-field="type" title="Fixed = flat monthly; Variable = $ per unit of volume; Cost-Plus = pass-through with markup">
                    <option value="fixed"${(b.type || 'variable') === 'fixed' ? ' selected' : ''}>Fixed</option>
                    <option value="variable"${b.type === 'variable' ? ' selected' : ''}>Variable</option>
                    <option value="cost_plus"${b.type === 'cost_plus' ? ' selected' : ''}>Cost-Plus</option>
                  </select>
                </td>
                <td>
                  <select class="hub-input" data-array="pricingBuckets" data-idx="${i}" data-field="uom">
                    ${BUCKET_UOM_OPTIONS.map(o => `<option value="${o.value}"${(b.uom || 'order') === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
                  </select>
                </td>
                <td>
                  <input class="hub-input hub-num" type="number" step="0.01" min="0" value="${b.rate || 0}" data-array="pricingBuckets" data-idx="${i}" data-field="rate" data-type="number" placeholder="derived" title="Leave 0 to let the Pricing section derive the rate from assigned costs + target margin. Set a value here to lock an explicit rate." />
                </td>
                <td>
                  <input class="hub-input" value="${escapeAttr(b.description || '')}" data-array="pricingBuckets" data-idx="${i}" data-field="description" placeholder="optional note" />
                </td>
                <td style="text-align:center;">
                  <button class="cm-delete-btn" data-action="delete-bucket" data-idx="${i}" aria-label="Delete bucket" title="Delete bucket">×</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div style="margin-top:14px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius: 10px;font-size:12px;color:#1e3a8a;line-height:1.5;">
        <strong>What happens next:</strong> when you build Labor, Equipment, Overhead, VAS, or Startup lines, each line picks one of these buckets to route its cost into. Buckets with no assigned lines are allowed — they'll just show $0 in the Pricing section. Missing a bucket? Add it here, then go back and re-assign the line.
      </div>
    `}
    </div>
  `;
}

function renderPricing() {
  // CM-VAR-1: hydrate variance display prefs on legacy models that pre-date
  // the uiPrefs namespace. Cheap defensive default — runs every render but
  // only mutates when the keys are missing.
  if (!model.uiPrefs) model.uiPrefs = {};
  if (model.uiPrefs.varianceMode !== 'pct' && model.uiPrefs.varianceMode !== 'abs' && model.uiPrefs.varianceMode !== 'both') {
    model.uiPrefs.varianceMode = 'both';
  }
  if (typeof model.uiPrefs.varianceSeparateColumn !== 'boolean') {
    model.uiPrefs.varianceSeparateColumn = false;
  }
  const _varMode = model.uiPrefs.varianceMode;
  const _varSep  = !!model.uiPrefs.varianceSeparateColumn && _varMode === 'both';
  const buckets = model.pricingBuckets || [];
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const opHrs = calc.operatingHours(model.shifts || {});
  const contractYears = model.projectDetails?.contractTerm || 5;
  // 2026-04-21 PM: ensure Y1 projections are populated so the M3 banner can
  // show the Y1-ramped actual margin alongside the reference-basis achieved.
  // ensureMonthlyBundle is cached — no-op on repeat renders in the same session.
  if (!_lastProjections) {
    try { ensureMonthlyBundle(); } catch (_) { /* best-effort */ }
  }
  const tiAmort = calc.tiAmortAnnual(model.equipmentLines || [], contractYears);
  const facilityCost = calc.totalFacilityCost(model.facility || {}, fr, ur, { tiAmort });

  // Prep startup lines with annual_amort
  const startupWithAmort = (model.startupLines || []).map(l => ({
    ...l,
    annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears),
  }));

  const bucketCosts = calc.computeBucketCosts({
    buckets,
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: startupWithAmort,
    facilityCost,
    operatingHours: opHrs,
    // I-01 edge: route facility cost to user-configured bucket. Falls through
    // to 'storage' → 'mgmt_fee' → first bucket → orphan. Orphans surface in
    // the table below as an explicit row so they don't silently vanish.
    facilityBucketId: model.financial?.facilityBucketId || null,
  });

  const targetMarginPct = (model.financial?.targetMargin || 0);
  const marginPct = targetMarginPct / 100;
  // Sum only real bucket costs — exclude meta keys ('_unassigned', '_facilityOrphan', '_facilityTarget')
  const totalCost = Object.entries(bucketCosts).reduce((s, [k, v]) => (typeof v === 'number' && !k.startsWith('_')) ? s + v : s, 0);
  // Reference-aligned gross-up: Revenue = Cost / (1 − m).
  const mFracGuarded = Math.min(0.999, Math.max(0, marginPct));
  const totalRecommendedRevenue = totalCost / (1 - mFracGuarded);

  // Single source of truth — enriched buckets carry recommendedRate +
  // overrideRate + effective rate, matching what the monthly engine reads.
  const enriched = calc.enrichBucketsWithDerivedRates({
    buckets, bucketCosts, marginPct, volumeLines: model.volumeLines || [],
  });
  const impact = calc.computeOverrideImpact(enriched);
  // Snapshot for the override-audit listener — see bindSectionEvents. The
  // audit row should report what the user SAW, not what gets recomputed
  // later, so we freeze the enrichment and the bucket-cost rollup here.
  _pricingAuditSnapshot = { enriched, bucketCosts, ts: Date.now() };

  // M3 reframed: achieved margin (from effective rates including overrides)
  // vs target. Only meaningful when at least one override is present.
  const achievedMarginFrac = calc.achievedMargin(impact.totalEffectiveRevenue, totalCost);
  const achievedMarginPct  = achievedMarginFrac * 100;
  const marginDeltaPP      = achievedMarginPct - targetMarginPct; // in pp
  const hasAnyOverride     = impact.overriddenBucketCount > 0;

  // 2026-04-21 PM: full computational reconciliation — pull Y1 ramped margin
  // from the cached projections when Summary has been rendered this session.
  // When it hasn't, we fall back to "labeling-only" mode (see-Summary link).
  // This gives the banner BOTH bases when data is available: reference-basis
  // (steady-state, no ramp) from the Pricing Schedule rollup AND Y1-actual
  // from the P&L engine (ramp + learning-curve haircut applied).
  const y1Proj = Array.isArray(_lastProjections) && _lastProjections.length ? _lastProjections[0] : null;
  const y1AchievedPct = y1Proj && y1Proj.revenue > 0
    ? ((y1Proj.ebit || (y1Proj.revenue - y1Proj.totalCost)) / y1Proj.revenue) * 100
    : null;
  const y1VsTargetPP = y1AchievedPct != null ? y1AchievedPct - targetMarginPct : null;
  // Thresholds: warn at 2pp shortfall, error at 5pp (per MD4 recommendation).
  const m3Level = !hasAnyOverride ? 'ok'
    : marginDeltaPP <= -5 ? 'error'
    : marginDeltaPP <= -2 ? 'warn'
    : 'ok';
  // UX nit #1: softer copy when delta is negative but within ±2pp tolerance
  // (banner stays green, but we don't want a triumphant ✓ on a -1.2pp day).
  const m3Copy = !hasAnyOverride
    ? 'No overrides — achieved margin equals target by construction'
    : m3Level === 'error' ? '⚠ Achieved margin well below target'
    : m3Level === 'warn' ? '⚠ Achieved margin below target'
    : marginDeltaPP < -0.1 ? `Within tolerance — achieved ${Math.abs(marginDeltaPP).toFixed(1)}pp below target`
    : marginDeltaPP > 0.1 ? `✓ Achieved margin above target (+${marginDeltaPP.toFixed(1)}pp)`
    : '✓ Achieved margin on target';

  // Override Implications Panel inputs: run the closed-form helper with the
  // current recommended/effective/cost baselines + project financial params.
  const startupCapital = calc.totalStartupCapital(model.startupLines || []);
  const fin = model.financial || {};
  const taxRatePct = Number(model.projectDetails?.taxRate ?? 25);
  const implications = calc.computeImplicationsImpact({
    totalOverrideDeltaY1: impact.totalOverrideDelta,
    baselineAnnualRevenue: impact.totalRecommendedRevenue,
    baselineAnnualCost: totalCost,
    startupCapital,
    years: Math.max(1, Math.min(10, Number(model.projectDetails?.contractTerm || 5))),
    volGrowthPct: Number(fin.volumeGrowth || 0),
    taxRatePct,
    discountRatePct: Number(fin.discountRate || 10),
  });

  const contractType = model.projectDetails?.contractType || 'fixed_variable';
  const contractTypeLabel = {
    fixed_variable: 'Fixed / Variable',
    open_book:      'Open Book',
    unit_rate:      'Unit Rate',
    split_month:    'Split-Month Billing',
  }[contractType] || 'Fixed / Variable';
  const splitFixedPct = Number(model.projectDetails?.splitBillingFixedPct ?? 40);
  const contractTypeDesc = {
    fixed_variable: `Recommended rates derived from cost + ${calc.formatPct(targetMarginPct, 1)} target margin. Override any rate inline; the Variance column and Summary banner surface the impact.`,
    open_book:      `Open Book — cost is passed through to the customer transparently with a declared ${calc.formatPct(targetMarginPct, 1)} margin on top. Recommended rates shown below are what would produce the stated margin if billed as fixed/variable; actual billing mechanic is line-item cost pass-through.`,
    unit_rate:      `Unit Rate contract — emphasis on per-unit rates below. Derived from cost + ${calc.formatPct(targetMarginPct, 1)} target margin (Revenue = Cost / (1 − margin)). Override any rate inline.`,
    split_month:    `Split-Month Billing — ${splitFixedPct.toFixed(0)}% of total revenue billed as fixed monthly management fee (start-of-month, net-15) and ${(100 - splitFixedPct).toFixed(0)}% billed as variable transaction fee (month-end, net-30). Recommended rates still derived from cost + ${calc.formatPct(targetMarginPct, 1)} target margin. The weighted-average DSO drives working-capital on the P&L — configure the split on the Financial section.`,
  }[contractType];
  return `
    <div class="cm-wide-layout">
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Pricing Schedule <span class="cm-contract-type-chip cm-contract-${contractType}">${contractTypeLabel}</span></div>
        <div class="cm-section-desc">${contractTypeDesc}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="hub-btn" data-cm-action="pricing-compare-scenarios"
                title="Side-by-side rate-card comparison — pick another scenario on this deal and see Recommended/Override/Effective rates aligned per bucket with Δ% deltas. Same engine as the Summary Compare modal but auto-scoped to pricing."
                ${(dealScenarios||[]).length < 2 ? 'disabled' : ''}>⇄ Compare Pricing</button>
      </div>
    </div>

    ${buckets.length === 0 ? `
      <div class="hub-card" style="padding:24px;text-align:center;background:var(--ies-gray-50);margin-bottom:16px;">
        <div style="font-size:28px;margin-bottom:6px;">🧱</div>
        <h3 style="margin:0 0 6px;font-size:16px;">No pricing buckets defined</h3>
        <div style="color:var(--ies-gray-500);font-size:13px;margin-bottom:14px;">Buckets are defined in <strong>Structure → Pricing Buckets</strong>. Without them the cost lines can't be allocated to a rate card.</div>
        <button class="hub-btn hub-btn-primary hub-btn-sm" data-action="jump-to-buckets">Open Pricing Buckets →</button>
      </div>
    ` : ''}

    ${buckets.length > 0 ? `
    <!-- M3 Achieved-vs-Target Margin banner (only when overrides present) -->
    <div class="cm-margin-banner cm-margin-${m3Level}">
      <div class="cm-margin-banner-main">
        <div class="cm-margin-banner-label">
          ${m3Copy}
          <div class="cm-margin-banner-basis">
            <span class="cm-margin-basis-chip" title="Pricing margin uses steady-state (reference) volumes and cost — the basis you set prices against. Summary tiles use Y1 P&L values which include ramp + learning-curve haircuts; those will read lower and are expected to reconcile to this banner by Y2-Y3 once the site is at steady state.">
              @ reference volumes
            </span>
            <span class="cm-margin-basis-compare">
              For Y1 P&L-basis (ramped) margin, see
              <a href="#" class="cm-margin-basis-link" data-cm-nav="summary">Summary → Financial Metrics</a>.
            </span>
          </div>
        </div>
        <div class="cm-margin-banner-nums">
          <span class="cm-margin-tile">
            <span class="cm-margin-tile-label">Target</span>
            <span class="cm-margin-tile-value">${targetMarginPct.toFixed(1)}%</span>
          </span>
          <span class="cm-margin-tile" title="Reference-basis: steady-state cost / volume × effective rates. Matches target by construction when no overrides; deviates by override variance otherwise. Pre-ramp, pre-learning-curve.">
            <span class="cm-margin-tile-label">Achieved (ref)</span>
            <span class="cm-margin-tile-value ${hasAnyOverride && marginDeltaPP < 0 ? 'cm-margin-value-down' : ''}">${achievedMarginPct.toFixed(1)}%</span>
          </span>
          ${y1AchievedPct != null ? `
            <span class="cm-margin-tile" title="Y1-only EBIT / Y1 Revenue, from the monthly engine (ramp + learning-curve haircuts included). This reconciles with the Summary → Financial Metrics 'EBIT Margin (contract)' tile's tooltip, which surfaces the Y1 basis alongside the contract-life aggregate. Y1 margin often reads higher than the contract-life aggregate when labor/facility escalation outpace volume growth; they converge in lighter-escalation deals by Y2-Y3.">
              <span class="cm-margin-tile-label">Y1 Actual (ramped)</span>
              <span class="cm-margin-tile-value ${y1VsTargetPP < -2 ? 'cm-margin-value-down' : y1VsTargetPP > 2 ? 'cm-margin-value-up' : ''}">${y1AchievedPct.toFixed(1)}%</span>
            </span>
          ` : ''}
          <span class="cm-margin-tile" title="Δ of reference-basis achieved vs target. Drives the banner severity (ok / warn / error). Y1 ramped will differ — see the Y1 Actual tile when populated.">
            <span class="cm-margin-tile-label">Δ vs target</span>
            <span class="cm-margin-tile-value ${marginDeltaPP < 0 ? 'cm-margin-value-down' : marginDeltaPP > 0 ? 'cm-margin-value-up' : ''}">${marginDeltaPP >= 0 ? '+' : ''}${marginDeltaPP.toFixed(1)}pp</span>
          </span>
          <span class="cm-margin-tile">
            <span class="cm-margin-tile-label">Overridden buckets</span>
            <span class="cm-margin-tile-value">${impact.overriddenBucketCount} / ${buckets.length}</span>
          </span>
          <span class="cm-margin-tile" title="Annual revenue delta at reference volumes. Actual Y1 impact is lower by the ramp-up factor; see Summary for Y1-basis numbers.">
            <span class="cm-margin-tile-label">Annual rev impact (ref)</span>
            <span class="cm-margin-tile-value ${impact.totalOverrideDelta < 0 ? 'cm-margin-value-down' : impact.totalOverrideDelta > 0 ? 'cm-margin-value-up' : ''}">${impact.totalOverrideDelta === 0 ? '—' : (impact.totalOverrideDelta >= 0 ? '+' : '') + calc.formatCurrency(impact.totalOverrideDelta, { compact: true })}</span>
          </span>
        </div>
      </div>
    </div>
    ` : ''}

    ${buckets.length > 0 && implications.hasOverrides ? `
    <!-- Override Implications Panel (medium scope: Y1 Rev / Y1 EBITDA / 5yr NPV / Payback shift) -->
    <div class="cm-implications-panel">
      <div class="cm-implications-title">
        Override Implications
        <span class="cm-implications-subtitle">Closed-form estimate of how the current overrides propagate through the P&amp;L. Exact numbers flow into Summary + Multi-Year P&amp;L.</span>
      </div>
      <div class="cm-implications-tiles">
        <!-- 2026-04-21 audit: merged "Y1 Revenue Δ" + "Y1 EBITDA Δ" into one
             tile. Revenue-side overrides flow 1:1 to EBITDA (no offsetting
             cost impact), so showing both as separate tiles produced identical
             values side-by-side — read as noise, not insight. Single tile
             with a dual-basis subtitle is cleaner. -->
        <div class="cm-impl-tile ${implications.y1RevDelta < 0 ? 'cm-impl-down' : implications.y1RevDelta > 0 ? 'cm-impl-up' : ''}">
          <div class="cm-impl-tile-label">Y1 Revenue &amp; EBITDA Δ</div>
          <div class="cm-impl-tile-value">${implications.y1RevDelta >= 0 ? '+' : ''}${calc.formatCurrency(implications.y1RevDelta, { compact: true })}</div>
          <div class="cm-impl-tile-sub">annual, @ current volumes · 1:1 revenue→EBITDA</div>
        </div>
        <div class="cm-impl-tile ${implications.fiveYrNpvDelta < 0 ? 'cm-impl-down' : implications.fiveYrNpvDelta > 0 ? 'cm-impl-up' : ''}">
          <div class="cm-impl-tile-label">Contract-Life NPV Δ</div>
          <div class="cm-impl-tile-value">${implications.fiveYrNpvDelta >= 0 ? '+' : ''}${calc.formatCurrency(implications.fiveYrNpvDelta, { compact: true })}</div>
          <div class="cm-impl-tile-sub">${model.projectDetails?.contractTerm || 5}-yr, after-tax, @ ${(Number(fin.discountRate || 10)).toFixed(1)}% discount</div>
        </div>
        <div class="cm-impl-tile ${implications.paybackShiftMonths > 0 ? 'cm-impl-down' : implications.paybackShiftMonths < 0 ? 'cm-impl-up' : ''}">
          <div class="cm-impl-tile-label">Payback Shift</div>
          <div class="cm-impl-tile-value">${Math.abs(implications.paybackShiftMonths) < 0.5 ? '—' : (implications.paybackShiftMonths > 0 ? '+' : '') + implications.paybackShiftMonths.toFixed(1) + ' mo'}</div>
          <div class="cm-impl-tile-sub">${startupCapital > 0 ? 'vs baseline payback schedule' : 'n/a (no startup capital)'}</div>
        </div>
      </div>
    </div>
    ` : ''}

    ${buckets.length > 0 ? `
    <!-- CM-VAR-1 (2026-04-26): Variance display toggle. Causal-style flexibility — pick how variance is rendered. Stored on model.uiPrefs so it travels with the model. -->
    <div class="cm-var-toggle-bar" role="toolbar" aria-label="Variance display options">
      <span class="cm-var-toggle-label">Variance display:</span>
      <div class="cm-var-toggle-group" role="group">
        <button type="button" class="cm-var-toggle-btn ${_varMode === 'pct' ? 'is-active' : ''}" data-action="set-var-mode" data-mode="pct" aria-pressed="${_varMode === 'pct'}" title="Show only the % delta vs recommended rate">% only</button>
        <button type="button" class="cm-var-toggle-btn ${_varMode === 'abs' ? 'is-active' : ''}" data-action="set-var-mode" data-mode="abs" aria-pressed="${_varMode === 'abs'}" title="Show only the annual $ revenue impact">$ only</button>
        <button type="button" class="cm-var-toggle-btn ${_varMode === 'both' ? 'is-active' : ''}" data-action="set-var-mode" data-mode="both" aria-pressed="${_varMode === 'both'}" title="Show both % and $ in the variance cell">% + $</button>
      </div>
      <label class="cm-var-toggle-sep ${_varMode === 'both' ? '' : 'is-disabled'}" title="${_varMode === 'both' ? 'Break $ into its own column for tighter scanning' : 'Available when display mode is % + $'}">
        <input type="checkbox" data-action="toggle-var-sep" ${_varSep ? 'checked' : ''} ${_varMode === 'both' ? '' : 'disabled'} />
        <span>Separate column for $</span>
      </label>
    </div>
    ` : ''}
    <table class="cm-grid-table cm-pricing-schedule">
      <thead>
        <tr>
          <th>Bucket</th>
          <th>Type</th>
          <th class="cm-num">Annual Cost</th>
          <th class="cm-num">Volume</th>
          <th class="cm-num" title="Recommended = Cost / (1 − target margin) / volume. This is what we'd propose to the customer.">Recommended Rate</th>
          <th class="cm-num" title="Override rate — leave blank to use recommended. Enter a value to reflect negotiation, competitive pressure, or strategic concession.">Override Rate</th>
          ${_varSep
            ? `<th class="cm-num" title="% delta of override vs recommended rate.">% Variance</th>
               <th class="cm-num" title="Annual revenue impact at the bucket's volume.">$ Variance</th>`
            : `<th class="cm-num" title="Variance of the override against the recommended rate — ${_varMode === 'pct' ? '% delta of the override.' : _varMode === 'abs' ? 'annual revenue impact at the bucket' + String.fromCharCode(0x2019) + 's volume.' : '% delta plus annual revenue impact at the bucket' + String.fromCharCode(0x2019) + 's volume.'}">${_varMode === 'pct' ? '% Variance' : _varMode === 'abs' ? '$ Variance' : 'Variance'}</th>`
          }
          <th style="width:80px;"></th>
        </tr>
      </thead>
      <tbody>
        ${enriched.map((b, idx) => {
          const cost = bucketCosts[b.id] || 0;
          const rec = Number(b.recommendedRate) || 0;
          const ovr = b._rateSource === 'override' ? Number(b.rate) : null;
          const vol = Number(b.annualVolume) || 0;
          const hasVol = vol > 0 || b.type === 'fixed';
          const uomSuffix = b.type === 'fixed' ? '/mo' : '/' + (b.uom || 'unit');
          const recDisplay = hasVol ? calc.formatCurrency(rec, { decimals: rec < 10 ? 4 : 2 }) : '—';
          const variancePerBucket = impact.perBucket.find(p => p.id === b.id) || { deltaAnnual: 0, deltaPct: 0, isOverridden: false };
          const vClass = variancePerBucket.deltaAnnual < 0 ? 'cm-variance-down' : variancePerBucket.deltaAnnual > 0 ? 'cm-variance-up' : '';
          const overrideIdx = (model.pricingBuckets || []).findIndex(pb => pb.id === b.id);
          const reasonValue = b.overrideReason || '';
          const reasonOptions = [
            'Customer counter-offer',
            'Competitive pressure',
            'Strategic concession',
            'Pricing error correction',
            'Market adjustment',
          ];
          return `
            <tr${variancePerBucket.isOverridden ? ' class="cm-row-overridden"' : ''}>
              <td>
                <div style="font-weight:600;">${b.name}</div>
                ${b._rateSource === 'override' ? `
                  <div class="cm-row-override-chip">OVERRIDE</div>
                  ${reasonValue ? `<div class="cm-row-override-reason" title="Override reason">${escapeHtml(reasonValue)}</div>` : ''}
                ` : ''}
              </td>
              <td><span class="hub-badge hub-badge-${b.type === 'fixed' ? 'info' : 'success'}">${b.type}</span></td>
              <td class="cm-num">${calc.formatCurrency(cost)}</td>
              <td class="cm-num">${hasVol ? (b.type === 'fixed' ? '12 mo' : vol.toLocaleString() + ' ' + (b.uom || '')) : '—'}</td>
              <td class="cm-num" style="color:var(--ies-gray-600);">${recDisplay}<span class="cm-uom-tick">${uomSuffix}</span></td>
              <td class="cm-num">
                <input type="number" step="0.01" min="0"
                  class="hub-input cm-override-input"
                  value="${ovr != null ? ovr : ''}"
                  placeholder="${hasVol ? rec.toFixed(rec < 10 ? 4 : 2) : '—'}"
                  data-array="pricingBuckets" data-idx="${overrideIdx}" data-field="rate" data-type="number"
                  title="Leave blank to use recommended rate. Enter a value to override." />
                ${variancePerBucket.isOverridden ? `
                  <select class="hub-input cm-override-reason-select"
                    data-array="pricingBuckets" data-idx="${overrideIdx}" data-field="overrideReason"
                    title="Document why this rate was overridden (for audit trail)">
                    <option value=""${!reasonValue ? ' selected' : ''}>— Reason —</option>
                    ${reasonOptions.map(r => `<option value="${escapeAttr(r)}"${reasonValue === r ? ' selected' : ''}>${r}</option>`).join('')}
                    ${reasonValue && !reasonOptions.includes(reasonValue) ? `<option value="${escapeAttr(reasonValue)}" selected>${escapeHtml(reasonValue)}</option>` : ''}
                  </select>
                ` : ''}
              </td>
              ${(() => {
                // CM-VAR-1: render variance cells per uiPrefs. When _varSep is on,
                // emit two cells (% then $); otherwise one cell formatted by mode.
                if (!variancePerBucket.isOverridden) {
                  return _varSep
                    ? `<td class="cm-num">—</td><td class="cm-num">—</td>`
                    : `<td class="cm-num">—</td>`;
                }
                const pctStr = `${variancePerBucket.deltaPct >= 0 ? '+' : ''}${(variancePerBucket.deltaPct * 100).toFixed(1)}%`;
                const absStr = `${variancePerBucket.deltaAnnual >= 0 ? '+' : ''}${calc.formatCurrency(variancePerBucket.deltaAnnual, { compact: true })}/yr`;
                if (_varSep) {
                  return `<td class="cm-num ${vClass}" style="font-weight:600;">${pctStr}</td>` +
                         `<td class="cm-num ${vClass}" style="font-weight:600;">${absStr}</td>`;
                }
                if (_varMode === 'pct') {
                  return `<td class="cm-num ${vClass}" style="font-weight:600;" title="${absStr}">${pctStr}</td>`;
                }
                if (_varMode === 'abs') {
                  return `<td class="cm-num ${vClass}" style="font-weight:600;" title="${pctStr}">${absStr}</td>`;
                }
                // 'both' (stacked, current default)
                return `<td class="cm-num ${vClass}" style="font-weight:600;">${pctStr}<div class="cm-variance-abs">${absStr}</div></td>`;
              })()}
              <td class="cm-num">
                ${variancePerBucket.isOverridden
                  ? `<button class="hub-btn hub-btn-xs hub-btn-ghost" data-action="reset-override" data-idx="${overrideIdx}" title="Clear override, revert to recommended">↺ Reset</button>`
                  : ''
                }
              </td>
            </tr>
          `;
        }).join('')}
        <tr class="cm-total-row">
          <td colspan="2">Total</td>
          <td class="cm-num">${calc.formatCurrency(totalCost)}</td>
          <td class="cm-num"></td>
          <td class="cm-num" style="color:var(--ies-gray-600);">${calc.formatCurrency(impact.totalRecommendedRevenue)}/yr</td>
          <td class="cm-num" style="font-weight:700;">${calc.formatCurrency(impact.totalEffectiveRevenue)}/yr</td>
          ${(() => {
            // CM-VAR-1 total row: aggregate % is delta vs recommended-revenue.
            const tDelta = impact.totalOverrideDelta;
            const tCls = tDelta < 0 ? 'cm-variance-down' : tDelta > 0 ? 'cm-variance-up' : '';
            const tRecRev = impact.totalRecommendedRevenue || 0;
            const totPct = tRecRev > 0 ? tDelta / tRecRev : 0;
            const tPctStr = tDelta === 0 ? '—' : `${totPct >= 0 ? '+' : ''}${(totPct * 100).toFixed(1)}%`;
            const tAbsStr = tDelta === 0 ? '—' : `${tDelta >= 0 ? '+' : ''}${calc.formatCurrency(tDelta, { compact: true })}/yr`;
            if (_varSep) {
              return `<td class="cm-num ${tCls}" style="font-weight:700;">${tPctStr}</td>` +
                     `<td class="cm-num ${tCls}" style="font-weight:700;">${tAbsStr}</td>`;
            }
            if (_varMode === 'pct') {
              return `<td class="cm-num ${tCls}" style="font-weight:700;" title="${tAbsStr}">${tPctStr}</td>`;
            }
            if (_varMode === 'abs') {
              return `<td class="cm-num ${tCls}" style="font-weight:700;" title="${tPctStr}">${tAbsStr}</td>`;
            }
            return `<td class="cm-num ${tCls}" style="font-weight:700;">${tDelta === 0 ? '—' : tPctStr + '<div class="cm-variance-abs">' + tAbsStr + '</div>'}</td>`;
          })()}
          <td></td>
        </tr>
      </tbody>
    </table>

    ${buckets.length > 0 ? (() => {
      // Customer Budget Summary (reference Part I §4 stacked display)
      // Each bucket shows: Cost → + G&A layer → + Mgmt Fee layer = Total Revenue
      // Mirrors the way 3PL pricing proposals decompose each line for the customer.
      const gaFrac   = (Number(model.financial?.gaMargin)  || 0) / 100;
      const mgmtFrac = (Number(model.financial?.mgmtFeeMargin) || 0) / 100;
      if (gaFrac + mgmtFrac <= 0) return '';
      let totGa = 0, totMgmt = 0, totRev = 0;
      const rows = enriched.map(b => {
        const cost = bucketCosts[b.id] || 0;
        const stack = calc.computeStackedRevenue({ cost, gaPct: gaFrac, mgmtPct: mgmtFrac });
        totGa   += stack.gaComponent;
        totMgmt += stack.mgmtComponent;
        totRev  += stack.totalRevenue;
        return `
          <tr>
            <td style="font-weight:600;">${b.name}</td>
            <td class="cm-num">${calc.formatCurrency(stack.cost)}</td>
            <td class="cm-num cm-stack-ga">+${calc.formatCurrency(stack.gaComponent)}</td>
            <td class="cm-num cm-stack-mgmt">+${calc.formatCurrency(stack.mgmtComponent)}</td>
            <td class="cm-num" style="font-weight:700;">${calc.formatCurrency(stack.totalRevenue)}</td>
          </tr>
        `;
      }).join('');
      return `
        <details class="cm-customer-budget" open>
          <summary>
            <span class="cm-cbs-title">Customer Budget Summary</span>
            <span class="cm-cbs-subtitle">Per-line stacked G&amp;A + Mgmt Fee decomposition (reference Part I §4) — the customer-facing view of how each bucket's recommended revenue is built up from cost.</span>
          </summary>
          <table class="cm-grid-table cm-stacked-budget">
            <thead>
              <tr>
                <th>Line</th>
                <th class="cm-num">Cost</th>
                <th class="cm-num cm-stack-ga-head">G&amp;A Layer<br><span class="cm-stack-pct">(${(gaFrac*100).toFixed(2)}%)</span></th>
                <th class="cm-num cm-stack-mgmt-head">Mgmt Fee Layer<br><span class="cm-stack-pct">(${(mgmtFrac*100).toFixed(2)}%)</span></th>
                <th class="cm-num">= Recommended Revenue</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr class="cm-total-row">
                <td>Total</td>
                <td class="cm-num">${calc.formatCurrency(totalCost)}</td>
                <td class="cm-num cm-stack-ga">+${calc.formatCurrency(totGa)}</td>
                <td class="cm-num cm-stack-mgmt">+${calc.formatCurrency(totMgmt)}</td>
                <td class="cm-num" style="font-weight:700;">${calc.formatCurrency(totRev)}</td>
              </tr>
            </tbody>
          </table>
          <div class="cm-cbs-formula">
            <span><strong>G&amp;A layer</strong> = Cost / ((1 − ${(gaFrac*100).toFixed(2)}%) / (1 − ${((gaFrac+mgmtFrac)*100).toFixed(2)}%)) − Cost</span>
            <span><strong>Mgmt Fee layer</strong> = (Cost + G&amp;A) × (1 / (1 − ${(mgmtFrac*100).toFixed(2)}%) − 1)</span>
            <span>Sum = Cost / (1 − ${((gaFrac+mgmtFrac)*100).toFixed(2)}%) (matches Recommended column above)</span>
          </div>
        </details>
      `;
    })() : ''}

    ${(() => {
      // Render orphan banners. Two distinct kinds of orphans:
      //   (a) facility-cost orphan — facility target bucket missing
      //   (b) line-cost orphan — lines with no pricing_bucket set
      const facilityTarget = bucketCosts['_facilityTarget'];
      const facilityOrphan = bucketCosts['_facilityOrphan'] || 0;
      const lineUnassigned = bucketCosts['_unassigned'] || 0;
      const facilityRoutedTo = facilityTarget && buckets.find(b => b.id === facilityTarget);
      const facilityNote = facilityCost > 0 && facilityRoutedTo
        ? `Facility cost (${calc.formatCurrency(facilityCost)}) routes to <b>${facilityRoutedTo.name}</b>.`
        : '';
      const facilityWarn = facilityOrphan > 0
        ? `<div style="font-size:13px;font-weight:600;color:var(--ies-red);">⚠ ${calc.formatCurrency(facilityOrphan)} facility cost has no target bucket — pick one in Setup → Financial.</div>`
        : '';
      const lineWarn = lineUnassigned > 0
        ? `<div style="font-size:13px;font-weight:600;color:var(--ies-orange);">${calc.formatCurrency(lineUnassigned)} in unassigned line costs rolled into Management Fee.</div><div style="font-size:12px;color:var(--ies-gray-500);margin-top:4px;">Assign pricing buckets to labor, equipment, overhead, and VAS lines to distribute costs accurately.</div>`
        : '';
      const noteRow = facilityNote
        ? `<div style="font-size:12px;color:var(--ies-gray-500);margin-top:6px;">${facilityNote}</div>`
        : '';
      if (!facilityWarn && !lineWarn && !facilityNote) return '';
      const borderColor = facilityOrphan > 0 ? 'var(--ies-red)' : 'var(--ies-orange)';
      return `<div class="hub-card mt-4" style="border-left:3px solid ${borderColor};background:rgba(255,193,7,0.06);">${facilityWarn}${lineWarn}${noteRow}</div>`;
    })()}

    <!-- I-01: Line → Bucket assignment table lets users review + reassign every line in one place -->
    ${renderBucketAssignments(buckets)}

    <style>
      .hub-badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.3px; }
      .hub-badge-info { background:rgba(0,71,171,0.1); color:var(--ies-blue); }
      .hub-badge-success { background:rgba(32,201,151,0.1); color:#0d9668; }
      .cm-rate-source { display:inline-block; margin-left:6px; padding:1px 6px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.3px; color:var(--ies-gray-500); background:var(--ies-gray-100); border-radius: 10px; cursor:help; }
      .cm-bucket-unassigned { background:rgba(255,193,7,0.1) !important; border-left:2px solid var(--ies-orange); }
      .cm-bucket-select { width:140px; font-size:12px; padding:3px 4px; }
      /* M3 achieved-vs-target margin banner */
      /* Startup "As-Incurred" row styling */
      .cm-startup-as-incurred { background:rgba(107,76,168,0.05); }
      .cm-startup-as-incurred td { color:var(--ies-gray-700); }
      .cm-as-inc-tag { display:inline-block; padding:1px 6px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.3px; color:#6d4ca8; background:rgba(107,76,168,0.12); border-radius:6px; }
      .cm-margin-banner { padding:14px 18px; margin-bottom:16px; border-radius: 10px; border:1px solid var(--ies-gray-200); background:#fff; }
      .cm-margin-banner.cm-margin-ok { border-left:3px solid var(--ies-green, #20c997); }
      .cm-margin-banner.cm-margin-warn { border-left:3px solid var(--ies-amber, #f59e0b); background:rgba(245,158,11,0.04); }
      .cm-margin-banner.cm-margin-error { border-left:3px solid var(--ies-red, #dc3545); background:rgba(220,53,69,0.05); }
      .cm-margin-banner-main { display:flex; flex-direction:column; gap:10px; }
      .cm-margin-banner-label { font-size:13px; font-weight:600; color:var(--ies-gray-700); }
      /* Basis disclosure row (2026-04-21 PM) — makes the reference-vs-Y1 reconciliation explicit
         right under the banner copy instead of burying it in a tooltip. */
      .cm-margin-banner-basis { display:flex; gap:10px; align-items:center; margin-top:4px; font-weight:400; flex-wrap:wrap; }
      .cm-margin-basis-chip { display:inline-block; padding:1px 8px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:var(--ies-gray-700); background:var(--ies-gray-100, #f3f4f6); border-radius:6px; cursor:help; }
      .cm-margin-basis-compare { font-size:11px; color:var(--ies-gray-500); }
      .cm-margin-basis-link { color:var(--ies-blue, #2563eb); text-decoration:underline; }
      .cm-margin-basis-link:hover { text-decoration:none; }
      .cm-margin-banner-nums { display:flex; gap:24px; flex-wrap:wrap; }
      .cm-margin-tile { display:flex; flex-direction:column; gap:2px; }
      .cm-margin-tile-label { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; color:var(--ies-gray-500); }
      .cm-margin-tile-value { font-size:20px; font-weight:700; color:var(--ies-gray-900); line-height:1.1; }
      .cm-margin-value-down { color:var(--ies-red, #dc3545); }
      .cm-margin-value-up { color:var(--ies-green, #0d9668); }
      /* Pricing Schedule 3-col */
      .cm-pricing-schedule .cm-override-input { width:110px; font-size:13px; padding:4px 6px; text-align:right; font-weight:600; }
      .cm-pricing-schedule .cm-override-input:placeholder-shown { font-weight:400; color:var(--ies-gray-500); }
      .cm-pricing-schedule .cm-row-overridden { background:rgba(245,158,11,0.06); }
      .cm-pricing-schedule .cm-row-override-chip { display:inline-block; margin-top:2px; padding:1px 6px; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:var(--ies-amber, #f59e0b); background:rgba(245,158,11,0.12); border-radius:6px; }
      .cm-pricing-schedule .cm-row-override-reason { margin-top:4px; font-size:10px; font-style:italic; color:var(--ies-gray-500); max-width:180px; line-height:1.3; }
      .cm-pricing-schedule .cm-override-reason-select { margin-top:4px; width:140px; font-size:10px; padding:2px 4px; text-align:left; font-weight:400; color:var(--ies-gray-700); }
      .cm-pricing-schedule .cm-variance-down { color:var(--ies-red, #dc3545); }
      .cm-pricing-schedule .cm-variance-up { color:var(--ies-green, #0d9668); }
      .cm-pricing-schedule .cm-variance-abs { font-size:11px; font-weight:500; color:var(--ies-gray-500); margin-top:2px; }
      .cm-pricing-schedule .cm-uom-tick { font-size:10px; color:var(--ies-gray-400); margin-left:2px; font-weight:400; }
      /* CM-VAR-1 — variance display toggle bar */
      .cm-var-toggle-bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:8px 12px; margin:0 0 10px; background:var(--ies-gray-50, #f8fafc); border:1px solid var(--ies-gray-200, #e5e7eb); border-radius:8px; font-size:12px; color:var(--ies-gray-700); }
      .cm-var-toggle-label { font-weight:600; color:var(--ies-gray-600); text-transform:uppercase; letter-spacing:0.4px; font-size:10px; }
      .cm-var-toggle-group { display:inline-flex; border:1px solid var(--ies-gray-300, #d1d5db); border-radius:6px; overflow:hidden; background:#fff; }
      .cm-var-toggle-btn { padding:4px 10px; font-size:12px; font-weight:600; color:var(--ies-gray-600); background:#fff; border:none; border-right:1px solid var(--ies-gray-200, #e5e7eb); cursor:pointer; transition:background 0.15s ease, color 0.15s ease; }
      .cm-var-toggle-btn:last-child { border-right:none; }
      .cm-var-toggle-btn:hover { background:var(--ies-gray-100, #f3f4f6); color:var(--ies-gray-900); }
      .cm-var-toggle-btn.is-active { background:var(--ies-blue, #2563eb); color:#fff; }
      .cm-var-toggle-btn.is-active:hover { background:var(--ies-blue, #2563eb); color:#fff; }
      .cm-var-toggle-sep { display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
      .cm-var-toggle-sep.is-disabled { opacity:0.5; cursor:not-allowed; }
      .cm-var-toggle-sep input[type="checkbox"] { accent-color:var(--ies-blue, #2563eb); cursor:inherit; }
      .hub-btn-xs { padding:2px 8px; font-size:11px; border-radius:4px; }
      .hub-btn-ghost { background:transparent; color:var(--ies-gray-600); border:1px solid var(--ies-gray-300); }
      .hub-btn-ghost:hover { background:var(--ies-gray-50); }
      /* Contract-type chip on Pricing Schedule header */
      .cm-contract-type-chip { display:inline-block; margin-left:10px; padding:2px 10px; border-radius:10px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; vertical-align:middle; }
      .cm-contract-type-chip.cm-contract-fixed_variable { background:rgba(0,71,171,0.1); color:var(--ies-blue); }
      .cm-contract-type-chip.cm-contract-open_book { background:rgba(107,76,168,0.12); color:#6d4ca8; }
      .cm-contract-type-chip.cm-contract-unit_rate { background:rgba(32,201,151,0.12); color:#0d9668; }
      .cm-contract-type-chip.cm-contract-split_month { background:rgba(245,158,11,0.14); color:#b45309; }
      /* Split-Month controls — visible on the Financial section only when the
         contract_type is split_month. Laid out as a 3-field grid with a
         derived-weighted-DSO line beneath. */
      .cm-split-month-controls { padding:14px 16px; margin-top:4px; border:1px solid rgba(245,158,11,0.25); border-left:3px solid #b45309; border-radius: 10px; background:rgba(245,158,11,0.03); }
      .cm-split-month-header { display:flex; flex-direction:column; gap:2px; margin-bottom:10px; }
      .cm-split-month-title { font-size:13px; font-weight:700; color:#b45309; letter-spacing:0.2px; }
      .cm-split-month-subtitle { font-size:11px; color:var(--ies-gray-500); font-weight:400; line-height:1.4; }
      .cm-split-month-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
      .cm-split-month-weighted { margin-top:8px; padding:8px 10px; font-size:12px; color:var(--ies-gray-700); background:#fff; border-radius:6px; border:1px dashed rgba(245,158,11,0.3); }
      .cm-split-month-weighted strong { color:#b45309; font-weight:700; }
      /* Planning Ratios audit banner (2026-04-21 PM) — surfaces stale catalog
         rules at the top of the section with two bulk-review actions. */
      .cm-audit-banner { display:flex; gap:14px; align-items:center; padding:10px 14px; margin-top:10px; background:#fef3c7; border-left:3px solid #d97706; border-radius:6px; }
      .cm-audit-banner-label { flex:1; font-size:12px; color:#78350f; line-height:1.4; }
      .cm-audit-banner-label strong { color:#92400e; }
      .cm-audit-banner-actions { display:flex; gap:6px; flex-shrink:0; }
      .hub-btn-sm { padding:4px 10px; font-size:11px; }
      /* Override Implications Panel */
      .cm-implications-panel { padding:14px 18px; margin-bottom:16px; border-radius: 10px; border:1px solid var(--ies-gray-200); background:#fff; }
      .cm-implications-title { font-size:13px; font-weight:600; color:var(--ies-gray-700); margin-bottom:10px; display:flex; flex-direction:column; gap:3px; }
      .cm-implications-subtitle { font-size:11px; font-weight:400; color:var(--ies-gray-500); }
      .cm-implications-tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; }
      .cm-impl-tile { padding:10px 14px; border:1px solid var(--ies-gray-200); border-radius:6px; background:var(--ies-gray-50); }
      .cm-impl-tile.cm-impl-up { border-left:3px solid var(--ies-green, #20c997); }
      .cm-impl-tile.cm-impl-down { border-left:3px solid var(--ies-red, #dc3545); }
      .cm-impl-tile-label { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; color:var(--ies-gray-500); margin-bottom:4px; }
      .cm-impl-tile-value { font-size:20px; font-weight:700; color:var(--ies-gray-900); line-height:1.1; }
      .cm-impl-tile.cm-impl-up .cm-impl-tile-value { color:var(--ies-green, #0d9668); }
      .cm-impl-tile.cm-impl-down .cm-impl-tile-value { color:var(--ies-red, #dc3545); }
      .cm-impl-tile-sub { font-size:10px; color:var(--ies-gray-500); margin-top:3px; line-height:1.3; }
      /* Customer Budget Summary (reference Part I §4 stacked G&A + Mgmt display) */
      .cm-customer-budget { margin-top:20px; border:1px solid var(--ies-gray-200); border-radius: 10px; background:#fff; padding:0; }
      .cm-customer-budget > summary { padding:14px 18px; cursor:pointer; list-style:none; display:flex; flex-direction:column; gap:4px; border-bottom:1px solid transparent; }
      .cm-customer-budget[open] > summary { border-bottom-color:var(--ies-gray-200); background:var(--ies-gray-50); }
      .cm-customer-budget > summary::-webkit-details-marker { display:none; }
      .cm-customer-budget > summary::before { content:'▸ '; color:var(--ies-gray-500); font-size:11px; margin-right:4px; }
      .cm-customer-budget[open] > summary::before { content:'▾ '; }
      .cm-cbs-title { font-size:14px; font-weight:600; color:var(--ies-gray-900); }
      .cm-cbs-subtitle { font-size:12px; color:var(--ies-gray-500); font-weight:400; line-height:1.4; }
      .cm-stacked-budget { margin:0; border:none; }
      .cm-stacked-budget th { background:var(--ies-gray-50); }
      .cm-stack-ga, .cm-stack-ga-head { color:#0a6b9e; }
      .cm-stack-mgmt, .cm-stack-mgmt-head { color:#6d4ca8; }
      .cm-stack-pct { font-size:10px; color:var(--ies-gray-500); font-weight:500; }
      .cm-cbs-formula { padding:10px 18px; font-size:11px; color:var(--ies-gray-500); background:var(--ies-gray-50); border-top:1px solid var(--ies-gray-200); display:flex; flex-direction:column; gap:4px; line-height:1.5; font-family: ui-monospace, SFMono-Regular, 'SF Mono', Consolas, monospace; }
    </style>
    </div>
  `;
}

/**
 * I-01 — compact table showing every cost line with its pricing_bucket
 * dropdown, grouped by source. Lets users reassign without digging
 * through the individual Labor/Equipment/Overhead grids.
 */
function renderBucketAssignments(buckets) {
  if (!buckets.length) return '';
  const groups = [
    { type: 'labor',     label: 'Direct Labor',   arrayName: 'laborLines',         nameField: 'activity_name', lines: model.laborLines || [] },
    { type: 'indirect',  label: 'Indirect Labor', arrayName: 'indirectLaborLines', nameField: 'role_name',     lines: model.indirectLaborLines || [] },
    { type: 'equipment', label: 'Equipment',      arrayName: 'equipmentLines',     nameField: 'equipment_name',lines: model.equipmentLines || [] },
    { type: 'overhead',  label: 'Overhead',       arrayName: 'overheadLines',      nameField: 'category',      lines: model.overheadLines || [] },
    { type: 'vas',       label: 'VAS',            arrayName: 'vasLines',           nameField: 'service',       lines: model.vasLines || [] },
    { type: 'startup',   label: 'Startup',        arrayName: 'startupLines',       nameField: 'description',   lines: model.startupLines || [] },
  ].filter(g => g.lines.length > 0);

  if (groups.length === 0) return '';

  const opts = (selectedId) => `
    <option value=""${!selectedId ? ' selected' : ''}>— Unassigned —</option>
    ${buckets.map(b => `<option value="${b.id}"${selectedId === b.id ? ' selected' : ''}>${b.name} (${b.type})</option>`).join('')}
  `;

  return `
    <div class="mt-6">
      <div class="text-subtitle mb-2">Line → Bucket Assignments <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;">— change where each cost line's dollars route for pricing</span></div>
      <table class="cm-grid-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Line</th>
            <th>Bucket</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map(g => g.lines.map((l, i) => {
            const label = l[g.nameField] || `(unnamed ${g.label.toLowerCase()} #${i + 1})`;
            const unassigned = !l.pricing_bucket;
            return `
              <tr${unassigned ? ' class="cm-bucket-unassigned"' : ''}>
                <td><span class="hub-badge hub-badge-${g.type === 'labor' || g.type === 'vas' ? 'success' : 'info'}">${g.label}</span></td>
                <td style="font-weight:500;">${label}</td>
                <td>
                  <select class="cm-bucket-select" style="min-width:200px;" title="${l.pricing_bucket ? (buckets.find(b => b.id === l.pricing_bucket)?.name || '') : 'Unassigned'}" data-array="${g.arrayName}" data-idx="${i}" data-field="pricing_bucket">
                    ${opts(l.pricing_bucket)}
                  </select>
                </td>
              </tr>
            `;
          }).join('')).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSummary() {
  const market = model.projectDetails?.market;
  const fr = (refData.facilityRates || []).find(r => r.market_id === market);
  const ur = (refData.utilityRates || []).find(r => r.market_id === market);
  const opHrs = calc.operatingHours(model.shifts || {});
  const outboundStar = (model.volumeLines || []).find(v => v.isOutboundPrimary);
  const orders = outboundStar?.volume || 0;
  // Human-readable UOM label for KPI tile ("Order" / "Each" / "Case" / "Unit").
  // Derived from the starred volume line's UOM so the tile re-labels when the
  // user changes the outbound-primary star on Volumes & Profile.
  const outboundUomLabel = formatUomSingular(outboundStar?.uom);
  const contractYears = model.projectDetails?.contractTerm || 5;
  const fin = model.financial || {};

  const summary = calc.computeSummary({
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: model.startupLines || [],
    facility: model.facility || {},
    shifts: model.shifts || {},
    facilityRate: fr,
    utilityRate: ur,
    contractYears,
    targetMarginPct: fin.targetMargin || 0,
    annualOrders: orders || 1,
  });

  // Phase 3 close-the-loop: resolve heuristics through the
  //   transient (Phase 5b) → approved-snapshot → override → project-column
  // chain so approved scenarios re-run against their FROZEN values and
  // the What-If Studio can preview-override without persisting.
  const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
    currentScenario,
    currentScenarioSnapshots,
    heuristicOverrides,
    fin,
    whatIfTransient,
  ), model);

  // Build multi-year projections
  const marginFrac = (calcHeur.targetMarginPct || 0) / 100;

  // I-02 FIX — derive missing bucket rates from assigned costs so new
  // models don't render $0 revenue until someone hand-wires bucket.rate.
  // I-01 FIX — also capture unassigned-cost rollup for the Summary banner.
  const pricingSnapshot = computePricingSnapshot(summary, marginFrac, opHrs, contractYears);
  const enrichedPricingBuckets = pricingSnapshot.buckets;
  const unassignedCost = pricingSnapshot.bucketCosts['_unassigned'] || 0;
  const unassignedCount = pricingSnapshot.unassignedCount;
  const projResult = calc.buildYearlyProjections({
    years: contractYears,
    baseLaborCost: summary.laborCost,
    baseFacilityCost: summary.facilityCost,
    baseEquipmentCost: summary.equipmentCost,
    baseOverheadCost: summary.overheadCost,
    baseVasCost: summary.vasCost,
    startupAmort: summary.startupAmort,
    startupCapital: summary.startupCapital,
    baseOrders: orders || 1,
    marginPct: marginFrac,
    volGrowthPct: calcHeur.volGrowthPct / 100,
    laborEscPct:  calcHeur.laborEscPct  / 100,
    costEscPct:   calcHeur.costEscPct   / 100,
    // 2026-04-21 audit: thread facility + equipment escalation separately so
    // the What-If Facility Escalation slider actually moves facility P&L.
    facilityEscPct:  calcHeur.facilityEscPct  / 100,
    equipmentEscPct: calcHeur.equipmentEscPct / 100,
    laborLines: model.laborLines || [],
    taxRatePct: calcHeur.taxRatePct,
    useMonthlyEngine: typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false,
    periods: (refData && refData.periods) || [],
    ramp: null,
    seasonality: model.seasonalityProfile || null,
    preGoLiveMonths: calcHeur.preGoLiveMonths,
    dsoDays:           calcHeur.dsoDays,
    dpoDays:           calcHeur.dpoDays,
    laborPayableDays:  calcHeur.laborPayableDays,
    startupLines: model.startupLines || [],
    pricingBuckets: enrichedPricingBuckets, // I-02: derived rates when unset
    project_id: model.id || 0,
    // M2 (2026-04-21): SG&A overlay (default 0 = no behavior change)
    sgaOverlayPct: Number(model.financial?.sgaOverlayPct) || 0,
    sgaAppliesTo: model.financial?.sgaAppliesTo || 'net_revenue',
    // Phase 4d — thread calc heuristics + market profile so the monthly
    // engine can compute per-line labor cost using Phase 4b profiles.
    _calcHeur: calcHeur,
    marketLaborProfile: currentMarketLaborProfile,
    // Year-scheduled wage load was removed 2026-04-21 pm per Brock — Benefit
    // Load is now a flat total (sum of 5 buckets) with per-position overrides.
    wageLoadByYear: null,
    // Diagnostic: carries which keys came from snapshot vs override vs default.
    _heuristicsSource: calcHeur.used,
  });
  _lastCalcHeuristics = calcHeur; // for the frozen-banner in Summary/Timeline
  // CM-PROV-1 — stash the inputs the cell-inspector panel needs to explain
  // any P&L cell. Refreshed every Summary render so heuristic / what-if
  // changes flow through immediately.
  _lastProvenanceContext = {
    projections: [], // populated below once `projections` is in scope
    summary,
    calcHeur,
    marginFrac,
    contractYears,
    baseOrders: orders || 1,
    computedAt: new Date().toISOString(),
  };
  // Stash the monthly bundle for save-time persistence
  if (projResult && projResult.monthlyBundle) _lastMonthlyBundle = projResult.monthlyBundle;
  const projections = projResult.projections || [];
  // CM-PROV-1 — finish wiring the provenance ctx now that projections exist.
  if (_lastProvenanceContext) _lastProvenanceContext.projections = projections;
  // Cache for cross-section reads (M3 banner on Pricing page reads Y1 margin
  // from this to surface ramp-adjusted actual alongside reference-basis).
  _lastProjections = projections;

  // Financial metrics — 2026-04-20 PM audit: MIRR/NPV/Payback now use FCF
  // (not grossProfit), ROIC uses NOPAT with a working-capital-inflated
  // invested-capital denominator, and EBIT/EBITDA are sourced from the new
  // monthly-engine COGS/SG&A split. taxRatePct + dso/dpo threaded through
  // so ROIC/NOPAT reconcile with the P&L's tax line and AR/AP carry.
  const metrics = calc.computeFinancialMetrics(projections, {
    startupCapital: summary.startupCapital,
    equipmentCapital: summary.equipmentCapital,
    annualDepreciation: (summary.equipmentAmort || 0) + (summary.startupAmort || 0),
    discountRatePct: fin.discountRate || 10,
    reinvestRatePct: fin.reinvestRate || 8,
    taxRatePct:  calcHeur.taxRatePct,
    dsoDays:     calcHeur.dsoDays,
    dpoDays:     calcHeur.dpoDays,
    totalFtes: summary.totalFtes,
    fixedCost: summary.facilityCost + summary.overheadCost + summary.startupAmort,
  });

  // Sensitivity data — use Year-1 projection as the base so the driver deltas
  // tie out to the P&L the user is looking at. Previously we used
  // steady-state (pre-escalation/pre-learning) base costs which produced
  // deltas that didn't reconcile with the Multi-Year P&L row the user was
  // reading immediately below.
  const p1 = projections[0] || {};
  const baseCosts = {
    labor:     p1.labor     ?? summary.laborCost,
    facility:  p1.facility  ?? summary.facilityCost,
    equipment: p1.equipment ?? summary.equipmentCost,
    overhead:  p1.overhead  ?? summary.overheadCost,
    vas:       p1.vas       ?? summary.vasCost,
    startup:   p1.startup   ?? summary.startupAmort,
  };
  const baseOrdersY1 = p1.orders || orders || 1;
  const lc = model.laborCosting || {};
  const sensi = calc.sensitivityTable(baseCosts, baseOrdersY1, undefined, {
    burdenPct:  lc.defaultBurdenPct ?? 30,
    benefitPct: lc.benefitLoadPct   ?? 15,
    marginPct:  (fin.targetMargin || 0),
    // 2026-04-20 PM audit: tie sensitivity baseline revenue to the Y1 P&L
    // row directly above. On projects with explicit pricing-bucket rates
    // (e.g. Wayfair), the P&L revenue is NOT cost × (1+margin), so the
    // Base-GP footnote used to contradict the P&L.
    baseRevenue: p1.revenue,
  });

  const pcts = summary.totalCost > 0 ? {
    labor: (summary.laborCost / summary.totalCost * 100).toFixed(0),
    facility: (summary.facilityCost / summary.totalCost * 100).toFixed(0),
    equipment: (summary.equipmentCost / summary.totalCost * 100).toFixed(0),
    overhead: (summary.overheadCost / summary.totalCost * 100).toFixed(0),
    vas: (summary.vasCost / summary.totalCost * 100).toFixed(0),
    startup: (summary.startupAmort / summary.totalCost * 100).toFixed(0),
  } : { labor: 0, facility: 0, equipment: 0, overhead: 0, vas: 0, startup: 0 };

  // Threshold defaults for metric coloring
  const thresholds = fin.thresholds || {
    grossMargin: 10, ebitda: 8, ebit: 5, roic: 15, mirr: 12, payback: contractYears * 12,
  };

  const frozenBannerSummary = renderFrozenBanner();

  // I-01 — unassigned cost warning banner. Shows on Summary (not just
  // Pricing) so users see the silent Management-Fee rollup as soon as
  // they land on the dashboard.
  const unassignedBanner = unassignedCost > 0 ? `
    <div class="hub-card mb-4" style="border-left: 3px solid var(--ies-orange); background: rgba(255,193,7,0.06); padding: 12px 16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-size:13px; font-weight:600; color: var(--ies-orange);">
            ${calc.formatCurrency(unassignedCost)} in unassigned costs — rolled into Management Fee
          </div>
          <div style="font-size:12px; color: var(--ies-gray-500); margin-top:2px;">
            ${unassignedCount} cost line${unassignedCount === 1 ? '' : 's'} ${unassignedCount === 1 ? 'is' : 'are'} missing a pricing bucket. New lines auto-assign a bucket now; fix older lines in the Pricing section.
          </div>
        </div>
        <button class="hub-btn" data-cm-action="go-pricing" style="white-space:nowrap;">Fix in Pricing →</button>
      </div>
    </div>
  ` : '';

  return `
    ${frozenBannerSummary}
    ${unassignedBanner}
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Summary Dashboard</div>
        <div class="cm-section-desc">Cost breakdown, financial metrics, multi-year P&L, and sensitivity analysis.</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="hub-btn" data-cm-action="summary-compare-scenarios" title="Side-by-side compare 2–4 scenarios on this deal — KPIs, pricing buckets, inputs" ${dealScenarios.length < 2 ? 'disabled' : ''}>
          ⇄ Compare Scenarios
        </button>
        <button class="hub-btn-primary" data-cm-action="export-scenario-xlsx" title="Export the active scenario as a 7-sheet Excel workbook">
          ⬇ Export Scenario XLSX
        </button>
      </div>
    </div>

    <!-- KPI Strip (primitives-kit, 5-tile override) — Year-1 figures so they
         tie out to the Multi-Year P&L's Y1 column immediately below. Prior
         version used steady-state summary.totalCost/totalRevenue which
         drifted from Y1 by ~3% (learning curve + escalation averaging),
         reading as an inconsistency on the Summary page. -->
    ${(() => {
      const p1 = projections[0] || {};
      const y1Cost    = p1.totalCost ?? summary.totalCost;
      const y1Revenue = p1.revenue   ?? summary.totalRevenue;
      const y1Orders  = p1.orders    || orders || 0;
      const y1CostPerOrder = y1Orders > 0 ? y1Cost / y1Orders : 0;
      return `
    <div class="hub-kpi-strip mb-4" style="grid-template-columns: repeat(5, minmax(0, 1fr));">
      <div class="hub-kpi-tile" data-cm-disclose="summary-y1-cost" title="Hover for breakdown · Year 1 total cost">
        <div class="hub-kpi-tile__label">Y1 Total Cost</div>
        <div class="hub-kpi-tile__value">${calc.formatCurrency(y1Cost, {compact: true})}</div>
      </div>
      <div class="hub-kpi-tile" data-cm-disclose="summary-y1-revenue" title="Hover for breakdown · Year 1 revenue at target margin">
        <div class="hub-kpi-tile__label">Y1 Revenue</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">${calc.formatCurrency(y1Revenue, {compact: true})}</div>
      </div>
      <div class="hub-kpi-tile" data-cm-disclose="summary-y1-cost-per-order" title="Hover for breakdown · Year 1 cost ÷ Year 1 ${outboundUomLabel.toLowerCase()}s">
        <div class="hub-kpi-tile__label">Cost / ${outboundUomLabel} (Y1)</div>
        <div class="hub-kpi-tile__value">${y1Orders > 0 ? calc.formatCurrency(y1CostPerOrder, {decimals: 2}) : '—'}</div>
      </div>
      <div class="hub-kpi-tile" data-cm-disclose="summary-ftes" title="Hover for breakdown · Direct + indirect FTEs">
        <div class="hub-kpi-tile__label">FTEs</div>
        <div class="hub-kpi-tile__value">${summary.totalFtes.toFixed(0)}</div>
      </div>
      <div class="hub-kpi-tile" data-cm-disclose="summary-capital" title="Hover for breakdown · Equipment + start-up capital">
        <div class="hub-kpi-tile__label">Capital</div>
        <div class="hub-kpi-tile__value">${calc.formatCurrency(summary.equipmentCapital + summary.startupCapital, {compact: true})}</div>
      </div>
    </div>
      `;
    })()}

    ${renderSensitivityCard()}

    <!-- Design Heuristics — moved up so they're the FIRST thing after KPIs (per v2 pattern) -->
    <div class="hub-card mb-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="text-subtitle" style="margin:0;">Design Heuristics & Benchmarks</div>
        <span style="font-size:11px;color:var(--ies-gray-400);">Pass/warn checks against industry norms</span>
      </div>
      <div id="cm-heuristics-panel" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        ${renderHeuristicsPanel(model, summary)}
      </div>
    </div>

    <!-- Cost Breakdown — stacked bar + legend (primitives-style).
         2026-04-21 audit: swapped the ad-hoc teal/amber/gray/red palette for
         a brand-aligned ramp anchored by ies-blue (Labor — biggest slice) and
         ies-orange (Start-Up — smallest, accent). Middle slices step down in
         blue/slate shades to stay on-brand at a glance. -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">Cost Breakdown</h3>
      <div class="cm-stacked-bar">
        <div style="width:${pcts.labor}%; background: var(--ies-blue, #0047AB);" title="Labor ${pcts.labor}%"></div>
        <div style="width:${pcts.facility}%; background: #2563eb;" title="Facility ${pcts.facility}%"></div>
        <div style="width:${pcts.equipment}%; background: #60a5fa;" title="Equipment ${pcts.equipment}%"></div>
        <div style="width:${pcts.overhead}%; background: #94a3b8;" title="Overhead ${pcts.overhead}%"></div>
        <div style="width:${pcts.vas}%; background: #cbd5e1;" title="VAS ${pcts.vas}%"></div>
        <div style="width:${pcts.startup}%; background: var(--ies-orange, #ff3a00);" title="Start-Up ${pcts.startup}%"></div>
      </div>
      <div class="cm-stacked-legend">
        ${(() => {
          // Phase 2e (2026-04-22): compute Peak Rentals sub-slice of Equipment
          // so the Summary cost breakdown explicitly surfaces seasonal rental
          // opex. The Equipment total already includes it; this just annotates.
          const rentalCost = calc.totalRentedMheCost(model.equipmentLines || []);
          return [
            { label: 'Labor', value: summary.laborCost, pct: pcts.labor, color: 'var(--ies-blue, #0047AB)' },
            { label: 'Facility', value: summary.facilityCost, pct: pcts.facility, color: '#2563eb' },
            { label: 'Equipment', value: summary.equipmentCost, pct: pcts.equipment, color: '#60a5fa',
              subAnnotation: rentalCost > 0
                ? `of which ${calc.formatCurrency(rentalCost, {compact: true})} peak rentals (Oct-Dec opex)`
                : null },
            { label: 'Overhead', value: summary.overheadCost, pct: pcts.overhead, color: '#94a3b8' },
            { label: 'VAS', value: summary.vasCost, pct: pcts.vas, color: '#cbd5e1' },
            { label: 'Start-Up', value: summary.startupAmort, pct: pcts.startup, color: 'var(--ies-orange, #ff3a00)' },
          ].map(c => `
            <div class="cm-stacked-legend__item">
              <span class="cm-stacked-legend__swatch" style="background:${c.color};"></span>
              <div>
                <div class="hub-field__label" style="text-transform:none; letter-spacing:0;">${c.label} <span style="color:var(--ies-gray-400);font-weight:500;">(${c.pct}%)</span></div>
                <div class="hub-num" style="font-size:14px; font-weight:700; text-align:left;">${calc.formatCurrency(c.value, {compact: true})}</div>
                ${c.subAnnotation ? `<div style="font-size:11px;font-style:italic;color:var(--ies-orange,#d97706);margin-top:2px;">${c.subAnnotation}</div>` : ''}
              </div>
            </div>
          `).join('');
        })()}
      </div>
    </div>

    <!-- Financial Metrics — primitives kpi-tile grid. Each tile carries an
         audit-trail tooltip so finance / pricing reviewers can see exactly
         how the number was derived without reading the code. -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">Financial Metrics</h3>
      <div class="cm-metrics-grid">
        ${(() => {
          // 2026-04-21 audit: the M3 banner tile on Pricing shows Y1 EBIT margin
          // (14.7% on Wayfair), while these tiles show 5-year contract-life
          // aggregate margins (10.4%). Both are correct; the labeling needed to
          // disambiguate so a Pricing team reviewer can reconcile at a glance.
          const y1Rev = Number(p1?.revenue || 0);
          const y1Gp  = Number(p1?.grossProfit || 0);
          const y1Ebitda = Number(p1?.ebitda || 0);
          const y1Ebit   = Number(p1?.ebit   || 0);
          const y1GpPct    = y1Rev > 0 ? (y1Gp     / y1Rev) * 100 : 0;
          const y1EbitdaPct= y1Rev > 0 ? (y1Ebitda / y1Rev) * 100 : 0;
          const y1EbitPct  = y1Rev > 0 ? (y1Ebit   / y1Rev) * 100 : 0;
          return `
        ${renderMetricCard('Gross Margin (contract)', calc.formatPct(metrics.grossMarginPct), metrics.grossMarginPct >= (thresholds.grossMargin || 10), `Contract-life (${contractYears}-yr) aggregate Gross Margin. Formula: Σ Revenue − Σ COGS, divided by Σ Revenue. COGS = Labor + Facility + Equipment + VAS pass-through. Y1 Gross Margin: ${y1GpPct.toFixed(1)}% — reconciles with the Pricing Schedule M3 banner's "Y1 Actual (ramped)" tile. Contract margin trends lower than Y1 when labor/facility escalation outpace volume growth.`)}
        ${renderMetricCard('EBITDA Margin (contract)', calc.formatPct(metrics.ebitdaMarginPct), metrics.ebitdaMarginPct >= (thresholds.ebitda || 8), `Contract-life (${contractYears}-yr) aggregate EBITDA Margin. EBITDA = GP − SG&A (Overhead + pre-live one-times). Y1 EBITDA Margin: ${y1EbitdaPct.toFixed(1)}%. Ties exactly to the EBITDA row in the P&L below. Pricing Schedule banner shows the reference-basis (steady-state) achieved margin, which reads higher until the site hits steady state.`)}
        ${renderMetricCard('EBIT Margin (contract)', calc.formatPct(metrics.ebitMarginPct), metrics.ebitMarginPct >= (thresholds.ebit || 5), `Contract-life (${contractYears}-yr) aggregate EBIT Margin. EBIT = EBITDA − D&A. Y1 EBIT Margin: ${y1EbitPct.toFixed(1)}% — this is the figure the Pricing M3 banner "Y1 Actual (ramped)" tile displays. Ties exactly to the EBIT row in the P&L below.`)}
          `;
        })()}
        ${renderMetricCard('ROIC', calc.formatPct(metrics.roicPct), metrics.roicPct >= (thresholds.roic || 15), `NOPAT / Invested Capital. NOPAT = avg annual EBIT × (1 − ${calcHeur.taxRatePct || 25}% tax) = $${((metrics.nopat||0)/1000).toFixed(0)}K. Invested Capital = $${(metrics.investedCapital/1000).toFixed(0)}K = Startup $${(summary.startupCapital/1000).toFixed(0)}K + Equipment $${(summary.equipmentCapital/1000).toFixed(0)}K + avg NWC $${((metrics.estimatedNwc||0)/1000).toFixed(0)}K (horizon-avg Revenue × DSO/365 − horizon-avg COGS × DPO/365).`)}
        ${renderMetricCard('MIRR', calc.formatPct(metrics.mirrPct), metrics.mirrPct >= (thresholds.mirr || 12), `Modified IRR of FCF series. Financing rate ${fin.discountRate || 10}%, reinvestment rate ${fin.reinvestRate || 8}%. Uses Y0 outflow of $${(metrics.totalInvestment/1000).toFixed(0)}K plus each year's Free Cash Flow.`)}
        ${renderMetricCard('NPV', calc.formatCurrency(metrics.npv, {compact: true}), metrics.npv > 0, `NPV of FCF series discounted at ${fin.discountRate || 10}%. Sums [−Total Investment $${(metrics.totalInvestment/1000).toFixed(0)}K at t=0] + Σ FCF_yr / (1+${(fin.discountRate||10)/100})^yr. Ties to the Cumulative FCF row in the P&L (Y5 value) when discount ≈ 0.`)}
        ${renderMetricCard('Payback', metrics.paybackMonths > 0 ? metrics.paybackMonths + ' mo' : '—', metrics.paybackMonths > 0 && metrics.paybackMonths <= (thresholds.payback || contractYears * 12), `Months until Cumulative FCF first turns positive. Starts at −Total Investment of $${(metrics.totalInvestment/1000).toFixed(0)}K at Y0; adds annual FCF each year. Assumes even monthly FCF within each year. Read Cum FCF row in P&L below to see the crossover.`)}
        ${renderMetricCard('Rev / FTE', calc.formatCurrency(metrics.revenuePerFte, {compact: true}), null, `Y1 Revenue $${((p1.revenue||0)/1000).toFixed(0)}K ÷ ${summary.totalFtes.toFixed(1)} total FTE. Industry benchmark ~$250K–$400K for fulfillment 3PL. Below benchmark may indicate labor-heavy deal structure.`)}
        ${renderMetricCard('GP / Order', calc.formatCurrency(metrics.contribPerOrder, {decimals: 2}), metrics.contribPerOrder > 0, `Y1 Gross Profit $${((p1.grossProfit||0)/1000).toFixed(0)}K ÷ Y1 Orders ${((p1.orders||orders||0)/1000).toFixed(0)}K. GP = Revenue − COGS (site-level direct costs only). Useful for unit-economics benchmarking across deals.`)}
        ${renderMetricCard('Op Leverage', calc.formatPct(metrics.opLeveragePct), null, `(Facility + Overhead + Start-Up Amort) ÷ Y1 Total Cost. Y1 fixed-ish costs: Facility $${((p1.facility||0)/1000).toFixed(0)}K + Overhead $${((p1.overhead||0)/1000).toFixed(0)}K + Startup Amort $${((p1.startup||0)/1000).toFixed(0)}K. Y1 Total Cost $${((p1.totalCost||0)/1000).toFixed(0)}K. Higher = more sensitive to volume swings (less ability to flex).`)}
        ${renderMetricCard('Contract Value', calc.formatCurrency(metrics.contractValue, {compact: true}), null, `Sum of Revenue across the ${contractYears}-year horizon = Total Contract Value (TCV). Horizon horizon average = $${((metrics.contractValue / Math.max(1, contractYears))/1000).toFixed(0)}K/yr.`)}
        ${renderMetricCard('Total Investment', calc.formatCurrency(metrics.totalInvestment, {compact: true}), null, `Startup capital $${(summary.startupCapital/1000).toFixed(0)}K + Equipment capital $${(summary.equipmentCapital/1000).toFixed(0)}K. EXCLUDES TI Upfront (rolled into facility rent via amortization). The Y0 outflow used as the anchor for MIRR/NPV/Payback.`)}
        ${(summary.tiUpfront || 0) > 0 ? renderMetricCard('TI Upfront', calc.formatCurrency(summary.tiUpfront, {compact: true}), null, `Tenant Improvement outlay at Y0 (dock levelers, office build-out, CCTV, access control, etc.) — per Asset Defaults Guidance, TI does NOT hit Total Investment or D&A. Instead it amortizes over the ${(model.projectDetails?.contractTerm || 5)}-year contract at $${(((summary.tiAmortAnnual)||0)/1000).toFixed(0)}K/yr and shows as a line in Facility Cost.`) : ''}
      </div>
    </div>

    <!-- Multi-Year P&L — standard accounting stack post-2026-04-20 audit:
         Revenue − COGS = GP − SG&A = EBITDA − D&A = EBIT − Tax = NI;
         CapEx + ΔWC yields FCF and running Cum FCF. Subtotal rows (COGS /
         SG&A / EBITDA / EBIT) are bolded with a subtle divider so finance
         reviewers can trace the stack line-by-line. -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">${contractYears}-Year P&L Projection</h3>
      <div class="cm-table-scroll">
        <table class="hub-datatable hub-datatable--dense">
          <thead>
            <tr>
              <th></th>
              ${projections.map(p => `<th class="hub-num">Year ${p.year}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr><td style="font-weight:600;">Orders</td>${projections.map(p => `<td class="hub-num" data-cm-cell="orders" data-cm-year="${p.year}" title="Click for formula details">${Math.round(p.orders).toLocaleString()}</td>`).join('')}</tr>
            <tr class="cm-pnl-row-revenue"><td style="font-weight:700; color:var(--ies-blue);">Revenue</td>${projections.map(p => `<td class="hub-num" style="font-weight:700; color:var(--ies-blue);" data-cm-cell="revenue" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.revenue, {compact: true})}</td>`).join('')}</tr>

            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">Labor</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="labor" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.labor, {compact: true})}</td>`).join('')}</tr>
            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">Facility</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="facility" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.facility, {compact: true})}</td>`).join('')}</tr>
            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">Equipment</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="equipment" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.equipment, {compact: true})}</td>`).join('')}</tr>
            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">VAS (Pass-through)</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="vas" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.vas, {compact: true})}</td>`).join('')}</tr>
            <tr style="border-top: 1px dashed var(--ies-gray-200);"><td style="font-weight:600;">Total COGS</td>${projections.map(p => `<td class="hub-num" style="font-weight:600;" data-cm-cell="cogs" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.cogs ?? (p.labor + p.facility + p.equipment + p.vas), {compact: true})}</td>`).join('')}</tr>
            <tr class="cm-pnl-row-total"><td style="font-weight:700;">Gross Profit</td>${projections.map(p => `<td class="hub-num" style="font-weight:700; color:${p.grossProfit >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};" data-cm-cell="grossProfit" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.grossProfit, {compact: true})}</td>`).join('')}</tr>

            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">Overhead (SG&A)</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="sga" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.sga ?? p.overhead, {compact: true})}</td>`).join('')}</tr>
            <tr style="border-top: 1px dashed var(--ies-gray-200);"><td style="font-weight:700;">EBITDA</td>${projections.map(p => `<td class="hub-num" style="font-weight:700;" data-cm-cell="ebitda" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.ebitda, {compact: true})}</td>`).join('')}</tr>

            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">Depreciation &amp; Amort.</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="depreciation" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.depreciation ?? p.startup, {compact: true})}</td>`).join('')}</tr>
            <tr style="border-top: 1px dashed var(--ies-gray-200);"><td style="font-weight:700;">EBIT</td>${projections.map(p => `<td class="hub-num" style="font-weight:700;" data-cm-cell="ebit" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.ebit, {compact: true})}</td>`).join('')}</tr>

            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">Taxes</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="taxes" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.taxes || 0, {compact: true})}</td>`).join('')}</tr>
            <tr style="border-top: 1px dashed var(--ies-gray-200);"><td style="font-weight:700;">Net Income</td>${projections.map(p => `<td class="hub-num" style="font-weight:700; color:${p.netIncome >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};" data-cm-cell="netIncome" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.netIncome, {compact: true})}</td>`).join('')}</tr>

            <tr class="cm-pnl-row-capex"><td style="padding-left:16px; color:var(--ies-gray-600);">CapEx</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="capex" data-cm-year="${p.year}" title="Click for formula details">${p.capex > 0 ? '(' + calc.formatCurrency(p.capex, {compact: true}) + ')' : '—'}</td>`).join('')}</tr>
            <tr><td style="padding-left:16px; color:var(--ies-gray-600);">Δ Working Capital</td>${projections.map(p => `<td class="hub-num" style="color:var(--ies-gray-600);" data-cm-cell="workingCapitalChange" data-cm-year="${p.year}" title="Click for formula details">${p.workingCapitalChange ? ((p.workingCapitalChange > 0 ? '(' : '') + calc.formatCurrency(Math.abs(p.workingCapitalChange), {compact: true}) + (p.workingCapitalChange > 0 ? ')' : '')) : '—'}</td>`).join('')}</tr>
            <tr style="border-top: 1px dashed var(--ies-gray-200);"><td style="font-weight:700;">Free Cash Flow</td>${projections.map(p => `<td class="hub-num" style="font-weight:700; color:${p.freeCashFlow >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};" data-cm-cell="freeCashFlow" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.freeCashFlow, {compact: true})}</td>`).join('')}</tr>
            <tr><td style="color:var(--ies-gray-500); font-size:12px;">Cumulative FCF</td>${projections.map(p => `<td class="hub-num" style="color:${(p.cumFcf||0) >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'}; font-size:12px;" data-cm-cell="cumFcf" data-cm-year="${p.year}" title="Click for formula details">${calc.formatCurrency(p.cumFcf || 0, {compact: true})}</td>`).join('')}</tr>
          </tbody>
        </table>
      </div>
      <div class="hub-field__hint mt-2" style="font-size:11px; color:var(--ies-gray-500);">
        Stack: <strong>Revenue − COGS = GP − SG&amp;A = EBITDA − D&amp;A = EBIT − Tax = Net Income.</strong>
        CapEx + ΔWorking Capital bridge NI to Free Cash Flow. Cum FCF turns positive at payback.
      </div>
    </div>

    <!-- Sensitivity Analysis — shows Δ Gross Profit (3PL P&L lens):
         +volume = +revenue and +cost, but net is positive because pricing
         is cost+margin. Coloring reflects that: green = good for the deal. -->
    <div class="hub-card mb-4">
      <h3 class="hub-section-heading">Sensitivity Analysis</h3>
      <div class="cm-table-scroll">
        <table class="hub-datatable hub-datatable--dense">
          <thead>
            <tr>
              <th>Driver</th>
              ${sensi[0]?.adjustments.map(a => `<th class="hub-num">${a.pct > 0 ? '+' : ''}${a.pct}%</th>`).join('') || ''}
            </tr>
          </thead>
          <tbody>
            ${sensi.map(driver => `
              <tr>
                <td style="font-weight:600;">${driver.label}</td>
                ${driver.adjustments.map(a => {
                  // ΔGP: positive = good (green) for the 3PL. Previously
                  // we showed ΔTotalCost which read backwards on Volume.
                  const isPos = a.gpDelta > 0;
                  const isNeg = a.gpDelta < 0;
                  const color = isPos ? 'var(--ies-green)' : isNeg ? 'var(--ies-red)' : 'inherit';
                  const sign  = isPos ? '+' : (isNeg ? '−' : '');
                  const mag   = Math.abs(a.gpDelta);
                  return `
                    <td class="hub-num" style="color:${color};" title="Scenario GP ${calc.formatCurrency(a.grossProfit, {compact: true})} · Revenue ${calc.formatCurrency(a.revenue, {compact: true})} · Cost ${calc.formatCurrency(a.totalCost, {compact: true})}">
                      <div>${calc.formatCurrency(a.grossProfit, {compact: true})}</div>
                      <div class="hub-field__hint" style="text-align:right;color:${color};">${sign}${calc.formatCurrency(mag, {compact: true})} GP</div>
                    </td>
                  `;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="hub-field__hint mt-2">
        Shown: scenario <strong>Gross Profit</strong> + ΔGP vs baseline. Green = better for the deal, red = worse. Base GP (Y1): ${calc.formatCurrency(((p1.revenue || 0) - (p1.totalCost || 0)), {compact: true})}. Hover any cell to see the underlying revenue / cost split.
      </div>
    </div>

    <!-- (Design Heuristics block moved to top of Summary, right after KPIs) -->
  `;
}

/**
 * Render a single metric card. `passes` semantics:
 *   true  → green (pass against threshold)
 *   false → red   (fail against threshold)
 *   null  → neutral (display-only metric, no judgment applied)
 * `tooltip` (optional) explains the underlying math — shown on native hover
 * so finance reviewers can audit how the number was derived without leaving
 * the page.
 * Migrated to primitives kit (hub-kpi-tile base + .cm-metric-card mod).
 */
function renderMetricCard(label, value, passes, tooltip) {
  const stateClass = passes === null ? 'is-neutral' : (passes ? 'is-pass' : 'is-fail');
  const titleAttr = tooltip ? ` title="${String(tooltip).replace(/"/g, '&quot;')}"` : '';
  return `
    <div class="hub-kpi-tile cm-metric-card ${stateClass}"${titleAttr}>
      <div class="hub-kpi-tile__label">${label}</div>
      <div class="hub-kpi-tile__value">${value}</div>
    </div>
  `;
}

/** Render heuristics panel with 10 benchmark checks */
function renderHeuristicsPanel(state, summary) {
  const checks = calc.generateHeuristics(state, summary);
  if (!checks || checks.length === 0) {
    return '<div style="padding: 12px; background: var(--ies-gray-50); border-radius: 6px; font-size: 13px; color: var(--ies-gray-500);">Enter project parameters to see design guidance.</div>';
  }

  return checks.map(check => {
    const icon = check.type === 'ok' ? '✓' : check.type === 'warn' ? '⚠' : 'ℹ';
    const bg = check.type === 'ok' ? 'rgba(32,201,151,0.06)' : check.type === 'warn' ? 'rgba(255,193,7,0.06)' : 'rgba(0,71,171,0.06)';
    const borderColor = check.type === 'ok' ? 'rgba(32,201,151,0.3)' : check.type === 'warn' ? 'rgba(255,193,7,0.3)' : 'rgba(0,71,171,0.3)';
    const color = check.type === 'ok' ? '#0d9668' : check.type === 'warn' ? '#ff9800' : '#0047AB';

    return `
      <div style="padding: 12px; background: ${bg}; border-left: 3px solid ${borderColor}; border-radius: 4px; font-size: 13px;">
        <div style="display: flex; gap: 8px; margin-bottom: 4px;">
          <span style="color: ${color}; font-weight: 700; font-size: 16px;">${icon}</span>
          <div style="font-weight: 600; color: var(--ies-navy); flex: 1;">${check.title}</div>
        </div>
        <div style="font-size: 12px; color: var(--ies-gray-600); margin-left: 24px;">${check.detail}</div>
      </div>
    `;
  }).join('');
}

// ============================================================
// EVENT BINDING — generic data-field system
// ============================================================

function bindSectionEvents(section, container) {
  // Section-specific event delegation — wired BEFORE the generic data-field
  // binder so delegated handlers can run without collision. Shift Planning
  // uses data-sp-cell / data-sp-action and does not use data-field.
  if (section === 'shiftPlanning') {
    shiftPlannerUi.bindShiftPlanningEvents(container, {
      model,
      toast: (msg) => { try { showToast(msg); } catch (_) {} },
      onModelChange: () => {
        isDirty = true;
        if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
        refreshNavCompletion();
        renderSection();
      },
    });
    // 2026-04-22 IA reshuffle — Shift Structure fields (shiftsPerDay /
    // hoursPerShift / daysPerWeek / weeksPerYear / workweekPattern) now
    // live on the Shift Planner page as data-field inputs. Fall through
    // to the generic binder below (no `return`) so those inputs get wired.
  }

  // Generic input binding: data-field="path.to.field"
  //
  // Event selection:
  //   - <select> / checkbox inputs → 'change'
  //   - Opt-in: any field carrying `data-field-commit="change"` → 'change'
  //   - Everything else → 'input' (live-updates the model on every keystroke)
  //
  // Why the opt-in: for fields whose `setNestedValue → shouldRerender` path
  // triggers a full `renderSection()` (which re-builds the section's innerHTML
  // and destroys the in-progress input), the 'input' event steals focus on
  // every keystroke, so the user can never type a multi-digit number like
  // "10" — the first keystroke commits "1" and focus is lost. The Shift
  // Structure fields (shifts.shiftsPerDay / hoursPerShift / daysPerWeek /
  // weeksPerYear) are explicitly marked with data-field-commit="change" so
  // they commit on blur/Enter and the user can type a full value. (Brock
  // 2026-04-22: "Shift Structure tile doesn't appear to do anything.")
  // CM-IMPL-1 (2026-04-26) — direct scalar dot-path inputs that don't
  // also carry data-field (e.g., implementationTimeline.goLiveWeek).
  // Wired before the generic [data-field] binder so we don't double-bind.
  container.querySelectorAll('[data-field-direct]:not([data-field])').forEach(input => {
    const event = input.tagName === 'SELECT' ? 'change'
                : input.type === 'checkbox' ? 'change'
                : 'change';
    input.addEventListener(event, () => {
      const path = input.dataset.fieldDirect;
      const parts = path.split('.');
      const last = parts.pop();
      const parent = parts.reduce((o, k) => { o[k] = o[k] || {}; return o[k]; }, model);
      const v = (input.dataset.type === 'number') ? (parseFloat(input.value) || 0) : input.value;
      parent[last] = v;
      isDirty = true;
      if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
      refreshNavCompletion();
    });
  });

  container.querySelectorAll('[data-field]').forEach(input => {
    const commit = input.dataset.fieldCommit;
    const event = input.tagName === 'SELECT' ? 'change'
                : input.type === 'checkbox' ? 'change'
                : commit === 'change' ? 'change'
                : 'input';
    input.addEventListener(event, (e) => {
      const field = input.dataset.field;
      const type = input.dataset.type;
      let val;
      if (type === 'checkbox' || input.type === 'checkbox') val = input.checked;
      else if (type === 'number') val = input.value === '' ? null : (parseFloat(input.value) || 0);
      else if (type === 'season-months') {
        // Phase 2b (2026-04-22): rented_mhe seasonal_months field. Parse the
        // comma-/whitespace-separated user input into an int[] 1-12. Invalid
        // entries silently dropped; empty → default [10,11,12]. Dedup + sort.
        const parsed = [];
        for (const tok of String(input.value || '').split(/[,\s]+/)) {
          if (!tok) continue;
          const n = Math.floor(Number(tok));
          if (Number.isFinite(n) && n >= 1 && n <= 12 && !parsed.includes(n)) parsed.push(n);
        }
        val = parsed.length ? parsed.sort((a, b) => a - b) : [10, 11, 12];
      }
      else val = input.value;

      // Handle direct scalar dot-path fields (data-field-direct="implementationTimeline.goLiveWeek")
      if (input.dataset.fieldDirect) {
        const path = input.dataset.fieldDirect;
        const parts = path.split('.');
        const last = parts.pop();
        const parent = parts.reduce((o, k) => { o[k] = o[k] || {}; return o[k]; }, model);
        parent[last] = (input.dataset.type === 'number') ? (parseFloat(input.value) || 0) : input.value;
        isDirty = true;
        if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
        refreshNavCompletion();
        return;
      }
      // Handle array fields (data-array + data-idx). data-array supports
      // dot-paths (e.g. "shifts.positions") so macro-section catalogs can
      // live alongside top-level arrays like laborLines.
      if (input.dataset.array) {
        const arrPath = input.dataset.array;
        let arr;
        if (arrPath.includes('.')) {
          arr = arrPath.split('.').reduce((o, k) => (o ? o[k] : undefined), model);
        } else {
          arr = model[arrPath];
        }
        const idx = parseInt(input.dataset.idx);
        // Scalar-array override (data-field="_direct"): the array holds raw
        // values, not objects. Auto-create if absent and pad with null out
        // to the requested idx so later indices can fill in sparsely. Used
        // by Labor Factors → Year-Scheduled Wage Load (Brock 2026-04-21).
        if (input.dataset.field === '_direct') {
          if (!Array.isArray(arr)) {
            const parts = arrPath.split('.');
            const last = parts.pop();
            const parent = parts.length
              ? parts.reduce((o, k) => { o[k] = o[k] || {}; return o[k]; }, model)
              : model;
            parent[last] = [];
            arr = parent[last];
          }
          while (arr.length <= idx) arr.push(null);
          arr[idx] = (val === '' || val === null) ? null : val;
          isDirty = true;
          if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
          refreshNavCompletion();
          return;
        }
        if (arr && arr[idx] !== undefined) {
          arr[idx][field] = val;
          // Labor: recompute annual_hours + re-render so Hrs/Yr, FTE, Annual Cost, override badge refresh
          if (input.dataset.array === 'laborLines' && (field === 'volume' || field === 'base_uph')) {
            recomputeLineHours(arr[idx]);
            isDirty = true;
            if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
            renderSection();
            return;
          }
          // Equipment: flipping acquisition_type (lease ↔ capital ↔ ti ↔ service)
          // auto-populates the appropriate cost field from the ref_equipment
          // catalog if the equipment_name matches, so the user doesn't see
          // a $0 cost after a flip. (Brock 2026-04-20: this is the "flip lease
          // to purchase and cost stays 0" bug from the catalog.)
          if (input.dataset.array === 'equipmentLines' && field === 'acquisition_type') {
            autoPopulateCostOnAcqTypeFlip(arr[idx], val).then((changed) => {
              isDirty = true;
              if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
              // Always re-render so the cost input reflects the pulled value
              // and the $0 warning styling clears.
              renderSection();
            });
            return;
          }
          // Equipment: flipping line_type re-renders so the financing cells
          // switch between owned-mhe / rented-mhe / it-equipment / owned-
          // facility layouts (Phase 2b, 2026-04-22). Also resets seasonal_months
          // to [10,11,12] default when a line becomes rented_mhe for the first
          // time so the user sees sensible defaults.
          if (input.dataset.array === 'equipmentLines' && field === 'line_type') {
            if (val === 'rented_mhe' && !Array.isArray(arr[idx].seasonal_months)) {
              arr[idx].seasonal_months = [10, 11, 12];
            }
            if (val === 'it_equipment' && (arr[idx].acquisition_type || 'lease') !== 'capital') {
              // IT lines are always capital — flip the financing type to match
              arr[idx].acquisition_type = 'capital';
            }
            isDirty = true;
            if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
            renderSection();
            return;
          }
          // Equipment: seasonal_months text input re-renders so the tooltip
          // refreshes with the human-readable month names.
          if (input.dataset.array === 'equipmentLines' && field === 'seasonal_months') {
            isDirty = true;
            if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
            renderSection();
            return;
          }
          // Startup: flipping billing_type (capitalized ↔ as_incurred) changes
          // row styling + amort display + pass-through tag. Re-render the
          // Start-Up table so the affordances match.
          if (input.dataset.array === 'startupLines' && field === 'billing_type') {
            isDirty = true;
            if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
            renderSection();
            return;
          }
        }
      } else {
        // Dot-path assignment
        setNestedValue(model, field, val);
        // M1 (2026-04-21): recompute derived targetMargin whenever a component
        // margin field changes, so every downstream consumer (calc engine,
        // Pricing Schedule, validateModel, What-If) sees the updated total.
        if (field === 'financial.gaMargin' || field === 'financial.mgmtFeeMargin') {
          syncDerivedTargetMargin();
        }
      }

      isDirty = true;
      if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
      // Benefit Load buckets: any edit should refresh the Total pill + the
      // underlying defaultBurdenPct the calc engine consumes. Re-render the
      // section so both update (cheap — Labor Factors is ~1 card + a table).
      if (input.dataset.recomputeBenefitLoad === 'true') {
        const lc = model.laborCosting || (model.laborCosting = {});
        lc.defaultBurdenPct = Math.round(computeBenefitLoadTotal(lc) * 100) / 100;
        refreshNavCompletion();
        renderSection();
        return;
      }
      // Refresh sidebar completion dots + group rollup so checkmarks update
      // live as the user fills fields — previously only updated on mount /
      // section navigation, so Order Profile / Financial / VAS / Start-Up /
      // Pricing Buckets never flipped green without navigating away first.
      refreshNavCompletion();
      // Re-render if the field affects calculated values
      if (shouldRerender(field)) renderSection();
    });
  });

  // MOST per-row template picker (data-most-select)
  // Position-catalog dropdown on Labor grid — picking a position pulls
  // wage / employment / markup from the catalog onto the line. Clearing
  // to "— Manual —" unlinks the position but leaves per-line rate intact.
  container.querySelectorAll('[data-whatif-position]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.whatifPosition);
      const kind = sel.dataset.laborKind || 'direct';
      const posId = sel.value || null;
      const positions = (model.shifts && model.shifts.positions) || [];
      const target = kind === 'indirect' ? (model.indirectLaborLines || []) : (model.laborLines || []);
      const line = target[idx];
      if (!line) return;
      line.position_id = posId;
      if (posId) {
        const p = positions.find(pp => pp.id === posId);
        if (p) {
          // Pull position attrs onto the line so existing calc paths
          // (which read line.hourly_rate / line.employment_type /
          // line.temp_agency_markup_pct / line.burden_pct) stay defensible.
          // Salaried roles pull annual_salary; hourly roles pull hourly_wage.
          if (p.is_salaried) {
            line.hourly_rate = 0;
            line.annual_salary = Number(p.annual_salary) || 0;
            line.pay_type = 'salary';
          } else {
            line.hourly_rate = Number(p.hourly_wage) || 0;
            line.pay_type = 'hourly';
          }
          line.employment_type = p.employment_type || 'permanent';
          if (p.employment_type === 'temp_agency') {
            line.temp_agency_markup_pct = Number(p.temp_markup_pct) || 0;
          }
          // Per-position Benefit Load override (Brock 2026-04-21 pm). Null =
          // inherit global; any number overrides burden_pct for this line.
          if (p.benefit_load_pct != null && p.benefit_load_pct !== '') {
            line.burden_pct = Number(p.benefit_load_pct) || 0;
          } else {
            // Clear per-line override so global (from buckets) applies
            line.burden_pct = null;
          }
          // Use the position name as the activity name hint if line was empty
          if (!line.activity_name) line.activity_name = p.name;
        }
      }
      isDirty = true;
      renderSection();
    });
  });

  container.querySelectorAll('[data-most-select]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx);
      applyMostTemplate(idx, sel.value);
    });
  });

  // v2 Labor — click a master-detail item to select it (updates detail pane)
  container.querySelectorAll('[data-labor-select]').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't hijack clicks on inputs/buttons/selects inside the item
      if (e.target.closest('input, button, select, textarea')) return;
      const idx = parseInt(item.dataset.laborSelect, 10);
      if (!Number.isNaN(idx) && idx !== _selectedLaborIdx) {
        _selectedLaborIdx = idx;
        renderSection();
      }
    });
  });

  // v2 Labor — up/down arrow keys on the master pane cycle selection
  // (ignored when focus is inside an input/select/textarea so typing isn't hijacked)
  if (section === 'labor' && isCmV2UiOn()) {
    const masterBody = container.querySelector('.hub-master-detail__master-body');
    if (masterBody) {
      // Make focusable so it can receive keydown
      masterBody.setAttribute('tabindex', '0');
      masterBody.addEventListener('keydown', (e) => {
        if (e.target !== masterBody) return; // only when pane itself is focused
        const lines = model.laborLines || [];
        if (!lines.length) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          _selectedLaborIdx = Math.min(lines.length - 1, (_selectedLaborIdx ?? -1) + 1);
          renderSection();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          _selectedLaborIdx = Math.max(0, (_selectedLaborIdx ?? 0) - 1);
          renderSection();
        } else if (e.key === 'Home') {
          e.preventDefault();
          _selectedLaborIdx = 0;
          renderSection();
        } else if (e.key === 'End') {
          e.preventDefault();
          _selectedLaborIdx = lines.length - 1;
          renderSection();
        }
      });
    }
  }

  // Pricing Schedule — override-audit listeners (2026-04-21).
  // Every commit of an override rate or an override reason fires a
  // fire-and-forget audit-log write. The generic data-field binder above
  // mutates model state on each keystroke; we attach a parallel `change`
  // listener here that runs on blur/commit so we don't flood audit_log
  // with one row per keystroke.
  if (section === 'pricing' && model?.id) {
    // Capture the pre-edit shape for every input/select so the audit row
    // can diff against what the user started with on this render.
    /** @type {Map<HTMLElement, number|null>} */
    const rateBefore = new Map();
    /** @type {Map<HTMLElement, string|null>} */
    const reasonBefore = new Map();
    container.querySelectorAll('.cm-override-input').forEach(input => {
      const idx = parseInt(input.dataset.idx);
      const bucket = (model.pricingBuckets || [])[idx];
      if (!bucket) return;
      const before = (input.defaultValue === '' || input.defaultValue == null)
        ? null
        : parseFloat(input.defaultValue);
      rateBefore.set(input, Number.isFinite(before) ? before : null);
    });
    container.querySelectorAll('.cm-override-reason-select').forEach(sel => {
      const idx = parseInt(sel.dataset.idx);
      const bucket = (model.pricingBuckets || [])[idx];
      if (!bucket) return;
      reasonBefore.set(sel, bucket.overrideReason || null);
    });
    container.querySelectorAll('.cm-override-input').forEach(input => {
      // 2026-04-21 PM (UX nit #3): maintain rateExplicitOverride flag on every
      // keystroke. Any non-blank value — including "0" — flags the bucket as
      // explicitly-overridden. A blank input clears the flag. Runs on 'input'
      // (per keystroke) so the flag is live before the change-fire audit write.
      input.addEventListener('input', () => {
        const idx = parseInt(input.dataset.idx);
        const bucket = (model.pricingBuckets || [])[idx];
        if (!bucket) return;
        bucket.rateExplicitOverride = input.value.trim() !== '';
      });
      input.addEventListener('change', () => {
        const idx = parseInt(input.dataset.idx);
        const bucket = (model.pricingBuckets || [])[idx];
        if (!bucket) return;
        const before = rateBefore.get(input);
        const after  = input.value === '' ? null : parseFloat(input.value);
        const afterN = Number.isFinite(after) ? after : null;
        const beforeN = before == null ? null : Number(before);
        if (beforeN === afterN) return; // no effective change
        const eb = (_pricingAuditSnapshot?.enriched || []).find(e => e.id === bucket.id);
        writeOverrideAuditEvent({
          action: 'price-override',
          bucket,
          oldRate: beforeN,
          newRate: afterN,
          recommendedRate: eb ? Number(eb.recommendedRate) || 0 : null,
          oldReason: bucket.overrideReason || null,
          newReason: bucket.overrideReason || null,
        });
        // Refresh the Pricing Schedule so the Variance column, OVERRIDE chip,
        // Reset button, M3 banner, and Override Implications tiles all reflect
        // the committed value live (the generic input handler doesn't re-render
        // because shouldRerender('rate') is false, for good reason — every
        // keystroke re-rendering the whole section would be janky).
        renderSection();
      });
    });
    container.querySelectorAll('.cm-override-reason-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx);
        const bucket = (model.pricingBuckets || [])[idx];
        if (!bucket) return;
        const before = reasonBefore.get(sel);
        const after  = sel.value || null;
        if (before === after) return;
        const eb = (_pricingAuditSnapshot?.enriched || []).find(e => e.id === bucket.id);
        writeOverrideAuditEvent({
          action: 'price-override-reason',
          bucket,
          oldRate: Number(bucket.rate) || null,
          newRate: Number(bucket.rate) || null,
          recommendedRate: eb ? Number(eb.recommendedRate) || 0 : null,
          oldReason: before,
          newReason: after,
        });
        // Re-render so the override-reason chip on the row reflects the new
        // reason immediately (chip rendering is driven by bucket.overrideReason).
        renderSection();
      });
    });
    // M3-banner "see Summary → Financial Metrics" link — jumps cleanly to
    // the Y1-basis margin view so finance reviewers can reconcile the two
    // denominators without hunting through the sidebar.
    container.querySelectorAll('[data-cm-nav]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const key = a.dataset.cmNav;
        if (key) navigateSection(key);
      });
    });
  }

  // Direct-labor Volume source picker — dropdown of volumeLines + "Custom".
  // Selecting a volume line syncs the labor line's volume to that line's value.
  container.querySelectorAll('[data-labor-volume-source]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx);
      const line = (model.laborLines || [])[idx];
      if (!line) return;
      const val = sel.value;
      if (val === 'custom' || val === '') {
        line.volume_source_idx = null; // user wants manual value
      } else {
        const srcIdx = parseInt(val);
        const src = (model.volumeLines || [])[srcIdx];
        if (src) {
          line.volume_source_idx = srcIdx;
          line.volume = src.volume || 0;
          recomputeLineHours(line);
        }
      }
      isDirty = true;
      if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
      renderSection();
    });
  });

  // Action buttons
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.idx);
      // Template-detail viewer needs the template id, not just the row idx
      if (action === 'view-most-template') {
        openMostTemplateDetail(btn.dataset.templateId);
        return;
      }
      handleAction(action, idx, btn);
    });
  });

  // Star buttons (volumes)
  container.querySelectorAll('.cm-star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      model.volumeLines.forEach((l, i) => l.isOutboundPrimary = i === idx);
      renderSection();
    });
  });

  // Phase 4b: per-row labor seasonality editor (monthly OT/absence)
  container.querySelectorAll('[data-cm-action="edit-labor-seasonality"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      openLaborSeasonalityModal(idx);
    });
  });

  // Brock 2026-04-22 PM — project-level Seasonality Profile editor
  // (new card in Volumes & Profile). Preset dropdown applies a canned
  // monthly_shares pattern; per-month inputs mutate the array and flip
  // preset to 'custom' so the user sees their hand-edits aren't reverted.
  container.querySelectorAll('[data-cm-action="seasonality-preset-change"]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const name = e.target.value;
      if (name === 'custom') return; // don't auto-apply anything when user picks custom
      const preset = SEASONALITY_PRESETS[name] || SEASONALITY_PRESETS.flat;
      model.seasonalityProfile = { preset: name, monthly_shares: preset.slice() };
      isDirty = true;
      renderSection();
      showToast(`Applied "${SEASONALITY_PRESET_LABELS[name]}" profile`, 'success');
    });
  });
  container.querySelectorAll('[data-cm-action="seasonality-month"]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      if (!(idx >= 0 && idx < 12)) return;
      if (!model.seasonalityProfile || !Array.isArray(model.seasonalityProfile.monthly_shares)) {
        model.seasonalityProfile = { preset: 'flat', monthly_shares: new Array(12).fill(1/12) };
      }
      const pct = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
      model.seasonalityProfile.monthly_shares[idx] = pct / 100;
      // Hand-edit flips preset to 'custom' so future preset changes don't
      // silently clobber the user's tweaks.
      model.seasonalityProfile.preset = 'custom';
      isDirty = true;
      // Debounced re-render so sum/peak summary updates without losing focus
      clearTimeout(_seasonalityRerenderTimer);
      _seasonalityRerenderTimer = setTimeout(() => renderSection(), 400);
    });
  });

  // Phase 5a: scenario xlsx export (on Summary)
  container.querySelector('[data-cm-action="export-scenario-xlsx"]')?.addEventListener('click', () => {
    exportScenarioToXlsx();
  });
  // CM-SCN-1: cross-section entry-point for Compare Scenarios on the Summary header.
  container.querySelector('[data-cm-action="summary-compare-scenarios"]')?.addEventListener('click', () => {
    if (!Array.isArray(dealScenarios) || dealScenarios.length < 2) {
      showToast('Need at least 2 scenarios on this deal to compare. Spawn a child from the Scenarios section first.', 'warning');
      return;
    }
    openCompareModal();
  });
  // CM-SET-2 — Seed default reference data into Supabase. Idempotent upsert
  // path: the api layer skips rows that already exist (matched by natural keys).
  container.querySelector('[data-cm-action="seed-default-refdata"]')?.addEventListener('click', async () => {
    if (!confirm('Seed default reference data into Supabase? Existing rows are kept; only missing rows are inserted.')) return;
    showToast('Seeding reference data — this may take a few seconds…', 'info');
    try {
      const result = await api.seedDefaultRefData();
      showToast(`Seeded: ${result.marketsAdded} markets, ${result.laborRatesAdded} labor rates, ${result.equipmentAdded} catalog items, ${result.facilityRatesAdded} facility rates, ${result.overheadRatesAdded} overhead rows.`, 'success');
      // Re-fetch + re-render so counts update.
      const rd = await api.loadAllRefData();
      refData = { ...rd, periods: refData.periods || [] };
      renderSection();
    } catch (err) {
      console.warn('[CM-SET-2] seedDefaultRefData failed:', err);
      showToast('Seed failed — see console for details.', 'error');
    }
  });
  // CM-PRC-3: focused Pricing comparison entry-point on the Pricing Schedule header.
  // Opens the same compare modal but pre-flags the pricing-buckets section so
  // the user lands directly in the rate-card view without scrolling past KPIs.
  container.querySelector('[data-cm-action="pricing-compare-scenarios"]')?.addEventListener('click', () => {
    if (!Array.isArray(dealScenarios) || dealScenarios.length < 2) {
      showToast('Need at least 2 scenarios on this deal to compare pricing. Spawn a child scenario first.', 'warning');
      return;
    }
    openCompareModal({ focus: 'pricing' });
  });

  // I-01: Summary "Fix in Pricing" shortcut
  container.querySelector('[data-cm-action="go-pricing"]')?.addEventListener('click', () => {
    navigateSection('pricing');
  });

  // --------------------------------------------------------------
  // Phase 5b: What-If Studio event wiring
  // --------------------------------------------------------------
  if (section === 'whatif') {
    const applySliderUpdate = (key, raw) => {
      const v = raw === '' ? '' : Number(raw);
      whatIfTransient = { ...whatIfTransient, [key]: v };
      // Mirror the slider and the number input together
      const slider = container.querySelector(`[data-whatif-slider="${key}"]`);
      const number = container.querySelector(`[data-whatif-number="${key}"]`);
      if (slider && String(slider.value) !== String(raw)) slider.value = raw;
      if (number && String(number.value) !== String(raw)) number.value = raw;
      // Debounce the full re-render (recompute is cheap but avoid churn on drag)
      if (_whatIfDebounce) clearTimeout(_whatIfDebounce);
      _whatIfDebounce = setTimeout(() => { _whatIfDebounce = null; renderSection(); }, 120);
    };

    container.querySelectorAll('[data-whatif-slider]').forEach(inp => {
      // input event fires during drag; change fires on release
      inp.addEventListener('change', () => applySliderUpdate(inp.dataset.whatifSlider, inp.value));
      // Mirror the number input DURING drag for responsiveness
      inp.addEventListener('input', () => {
        const key = inp.dataset.whatifSlider;
        const number = container.querySelector(`[data-whatif-number="${key}"]`);
        if (number) number.value = inp.value;
      });
    });
    container.querySelectorAll('[data-whatif-number]').forEach(inp => {
      inp.addEventListener('change', () => applySliderUpdate(inp.dataset.whatifNumber, inp.value));
    });

    container.querySelectorAll('[data-whatif-metric]').forEach(btn => {
      btn.addEventListener('click', () => {
        window._whatIfChartMetric = btn.dataset.whatifMetric;
        renderSection();
      });
    });

    container.querySelector('[data-cm-action="whatif-reset"]')?.addEventListener('click', async () => {
      const ok = await showConfirm('Reset all What-If sliders?\n\nThis discards the transient overlay and returns to your persisted assumptions.', { okLabel: 'Reset' });
      if (!ok) return;
      whatIfTransient = {};
      renderSection();
    });

    container.querySelector('[data-cm-action="whatif-apply"]')?.addEventListener('click', async () => {
      const keys = Object.keys(whatIfTransient).filter(k => whatIfTransient[k] !== '' && whatIfTransient[k] !== undefined);
      if (keys.length === 0) return;
      const msg = `Commit ${keys.length} What-If slider value${keys.length === 1 ? '' : 's'} as scenario overrides?\n\n` +
                  keys.map(k => `  • ${k} → ${whatIfTransient[k]}`).join('\n') +
                  `\n\nThis writes to heuristic_overrides on the project and affects every subsequent calc.`;
      const ok = await showConfirm(msg, { okLabel: 'Apply overrides' });
      if (!ok) return;
      // Merge transient into persistent overrides
      const merged = { ...heuristicOverrides };
      for (const k of keys) merged[k] = whatIfTransient[k];
      heuristicOverrides = merged;
      if (model?.id) {
        try { await api.saveHeuristicOverrides(model.id, heuristicOverrides); }
        catch (err) { showToast('Save failed: ' + (err?.message || err), 'error'); return; }
      } else {
        model.heuristicOverrides = heuristicOverrides;
      }
      whatIfTransient = {};
      showToast(`Applied ${keys.length} override${keys.length === 1 ? '' : 's'}`, 'success');
      renderSection();
    });
  }

  // Phase 4c/d: fire-and-forget market-profile load on Summary/Timeline open
  if (section === 'summary' || section === 'timeline') {
    ensureMarketLaborProfileLoaded().then(fresh => {
      // Only re-render on a truly fresh fetch to avoid an infinite loop.
      if (fresh) renderSection();
    });
  }

  // CM-PROV-1 — Click delegation now lives on rootEl in wireEditorEvents()
  // so it survives renderShell()/renderCurrentView() passes. Here we only
  // refresh the panel state on each Summary render (so active-cell outline
  // re-applies after innerHTML replacement) and close the panel when the
  // user navigates away from Summary.
  if (section === 'summary') {
    refreshProvenancePanel();
  } else if (_activeProvCell) {
    closeProvenancePanel();
  }

  // --------------------------------------------------------------
  // Phase 3: Assumptions section event wiring
  // --------------------------------------------------------------
  if (section === 'assumptions') {
    // First-open: lazy-load catalog + overrides, then re-render.
    // Guarded against re-entry so the post-load renderSection can't
    // trigger another load if the catalog happens to still be empty
    // (API error, no rows, etc.).
    if (heuristicsCatalog.length === 0 && !_heuristicsLoadInFlight) {
      _heuristicsLoadInFlight = true;
      ensureHeuristicsLoaded()
        .finally(() => { _heuristicsLoadInFlight = false; })
        .then(() => renderSection());
    }
    // Heuristic value input → merge into overrides jsonb
    container.querySelectorAll('[data-heuristic-input]').forEach(inp => {
      const evt = inp.tagName === 'SELECT' ? 'change' : 'change';
      inp.addEventListener(evt, async (e) => {
        const key = inp.dataset.heuristicInput;
        const raw = inp.value;
        const def = heuristicsCatalog.find(h => h.key === key);
        if (!def) return;
        const issue = scenarios.validateHeuristic(def, raw);
        if (issue) { console.warn('[CM] heuristic validation:', issue); return; }
        const value = def.data_type === 'enum' ? raw : (raw === '' ? null : Number(raw));
        const merged = { ...heuristicOverrides };
        if (value === null || value === undefined || value === '') delete merged[key];
        else merged[key] = value;
        heuristicOverrides = merged;
        // Persist if we have a saved project
        if (model?.id) {
          try {
            await api.saveHeuristicOverrides(model.id, heuristicOverrides);
            isDirty = false;
          } catch (err) {
            console.warn('[CM] saveHeuristicOverrides failed:', err);
          }
        } else {
          model.heuristicOverrides = heuristicOverrides;
          isDirty = true;
        }
        renderSection();
      });
    });
    // Reset-per-row + reset-all
    container.querySelectorAll('[data-cm-action="reset-heuristic"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.heuristicKey;
        const merged = { ...heuristicOverrides };
        delete merged[key];
        heuristicOverrides = merged;
        if (model?.id) {
          try { await api.saveHeuristicOverrides(model.id, heuristicOverrides); } catch (_) {}
        } else {
          model.heuristicOverrides = heuristicOverrides;
        }
        renderSection();
      });
    });
    container.querySelector('[data-cm-action="reset-all-heuristics"]')?.addEventListener('click', async () => {
      const ok = await showConfirm('Reset all heuristics on this scenario to standard defaults?', { okLabel: 'Reset' });
      if (!ok) return;
      heuristicOverrides = {};
      if (model?.id) {
        try { await api.saveHeuristicOverrides(model.id, heuristicOverrides); } catch (_) {}
      } else {
        model.heuristicOverrides = heuristicOverrides;
      }
      renderSection();
    });

    // --------------------------------------------------------------
    // Phase 6: Planning Ratios event wiring (ref_planning_ratios)
    // --------------------------------------------------------------
    if (isPlanningRatiosFlagOn()) {
      // Lazy-load once; then re-render so the catalog is visible.
      if (planningRatiosCatalog.length === 0 && !_planningRatiosLoadInFlight) {
        ensurePlanningRatiosLoaded().then(() => renderSection());
      }
      // Toggle category expand/collapse
      container.querySelectorAll('[data-pr-toggle-category]').forEach(btn => {
        btn.addEventListener('click', () => {
          const code = btn.dataset.prToggleCategory;
          _planningRatioOpenCategory = (_planningRatioOpenCategory === code) ? null : code;
          renderSection();
        });
      });
      // Planning-ratio value override
      container.querySelectorAll('[data-pr-input]').forEach(inp => {
        inp.addEventListener('change', async () => {
          const code = inp.dataset.prInput;
          const raw = inp.value;
          const merged = { ...planningRatioOverrides };
          if (raw === '' || raw === null || raw === undefined) {
            delete merged[code];
          } else {
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            merged[code] = { value: n, updated_at: new Date().toISOString() };
          }
          planningRatioOverrides = merged;
          if (model?.id) {
            try {
              await api.savePlanningRatioOverrides(model.id, planningRatioOverrides);
              isDirty = false;
            } catch (err) {
              console.warn('[CM] savePlanningRatioOverrides failed:', err);
            }
          } else {
            model.planningRatioOverrides = planningRatioOverrides;
            isDirty = true;
          }
          renderSection();
        });
      });
      // Reset single planning ratio
      container.querySelectorAll('[data-cm-action="reset-planning-ratio"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const code = btn.dataset.prCode;
          const merged = { ...planningRatioOverrides };
          delete merged[code];
          planningRatioOverrides = merged;
          if (model?.id) {
            try { await api.savePlanningRatioOverrides(model.id, planningRatioOverrides); } catch (_) {}
          } else {
            model.planningRatioOverrides = planningRatioOverrides;
          }
          renderSection();
        });
      });
      // 2026-04-21 PM — Mark-reviewed: stamp reviewed_at on a single ratio's
      // override payload so the stale chip goes green on this project only.
      container.querySelectorAll('[data-cm-action="mark-ratio-reviewed"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const code = btn.dataset.prCode;
          if (!code) return;
          planningRatioOverrides = planningRatios.markRatioReviewed(planningRatioOverrides, code);
          if (model?.id) {
            try { await api.savePlanningRatioOverrides(model.id, planningRatioOverrides); } catch (_) {}
          } else {
            model.planningRatioOverrides = planningRatioOverrides;
          }
          renderSection();
        });
      });
      // Bulk: mark every unreviewed-stale ratio as reviewed at once. Useful
      // when the analyst has done a pass through the numbers and wants the
      // audit banner to go quiet.
      container.querySelector('[data-cm-action="mark-all-stale-reviewed"]')?.addEventListener('click', async () => {
        const stale = (planningRatiosCatalog || []).filter(r =>
          planningRatios.isStaleForProject(r, planningRatioOverrides));
        if (stale.length === 0) return;
        const ok = await showConfirm(
          `Mark all ${stale.length} stale rule${stale.length === 1 ? '' : 's'} as reviewed for this project?\n\nThis does NOT change any values — it just clears the "needs refresh" chip on rows where you've audited the pre-2022 source. Each project tracks its own review state.`,
          { okLabel: 'Mark All Reviewed', danger: false }
        );
        if (!ok) return;
        let next = planningRatioOverrides;
        for (const r of stale) next = planningRatios.markRatioReviewed(next, r.ratio_code);
        planningRatioOverrides = next;
        if (model?.id) {
          try { await api.savePlanningRatioOverrides(model.id, planningRatioOverrides); } catch (_) {}
        } else {
          model.planningRatioOverrides = planningRatioOverrides;
        }
        showToast(`${stale.length} rule${stale.length === 1 ? '' : 's'} marked reviewed`, 'success');
        renderSection();
      });
      // Bulk: expand every category that contains a stale rule. UI-only —
      // just for navigation. Doesn't mutate overrides.
      container.querySelector('[data-cm-action="expand-all-stale-categories"]')?.addEventListener('click', () => {
        const categoriesWithStale = new Set();
        for (const r of planningRatiosCatalog || []) {
          if (planningRatios.isStaleForProject(r, planningRatioOverrides)) {
            categoriesWithStale.add(r.category_code);
          }
        }
        // UI state only supports ONE open category at a time (accordion-style).
        // Open the first stale category; the user can click through the others.
        if (categoriesWithStale.size > 0) {
          _planningRatioOpenCategory = Array.from(categoriesWithStale)[0];
          renderSection();
          showToast(`Expanded "${_planningRatioOpenCategory}". ${categoriesWithStale.size - 1} more categor${categoriesWithStale.size - 1 === 1 ? 'y' : 'ies'} have stale rows.`, 'info');
        }
      });
    }
  }

  // --------------------------------------------------------------
  // Phase 3: Scenarios section event wiring
  // --------------------------------------------------------------
  if (section === 'scenarios') {
    // Lazy-load once per section open. The previous implementation
    // checked (!currentScenario && dealScenarios.length === 0) and
    // triggered the loader on every render — which looped forever when
    // the project genuinely has no scenario record (load returns empty,
    // condition is still true, re-renders, re-fires load, ...).
    if (!_scenariosLoadedOnce && !_scenariosLoadInFlight) {
      _scenariosLoadInFlight = true;
      ensureScenariosLoaded()
        .finally(() => {
          _scenariosLoadInFlight = false;
          _scenariosLoadedOnce = true;
        })
        .then(() => renderSection());
    }
    // Field edits on current scenario
    container.querySelectorAll('[data-scenario-field]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const field = inp.dataset.scenarioField;
        if (!currentScenario) return;
        const patch = { id: currentScenario.id };
        if (field === 'label') patch.scenario_label = inp.value;
        if (field === 'description') patch.scenario_description = inp.value;
        try {
          currentScenario = await api.saveScenario(patch);
          await ensureScenariosLoaded();
          renderSection();
        } catch (err) { console.warn('[CM] save scenario field failed:', err); }
      });
    });

    const act = (name) => container.querySelector(`[data-cm-action="${name}"]`);

    act('scenario-save-header')?.addEventListener('click', () => {
      // Field changes auto-save on blur; this button is just a reassurance
      showToast('Scenario fields auto-save on change', 'success');
    });

    act('scenario-to-review')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      currentScenario = await api.saveScenario({ id: currentScenario.id, status: 'review' });
      renderSection();
    });
    act('scenario-to-draft')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      currentScenario = await api.saveScenario({ id: currentScenario.id, status: 'draft' });
      renderSection();
    });
    act('scenario-archive')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      const ok = await showConfirm('Archive this scenario?\n\nSnapshots are preserved; status moves to "archived".',
        { okLabel: 'Archive', danger: true });
      if (!ok) return;
      currentScenario = await api.archiveScenario(currentScenario.id);
      showToast('Scenario archived', 'success');
      renderSection();
    });
    act('scenario-approve')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      const ok = await showConfirm(
        'Approve this scenario?\n\nAll active rate cards (labor, facility, utility, overhead, equipment) and the heuristics catalog will be frozen as snapshots. You will no longer be able to edit this scenario — further changes will spawn a child scenario.',
        { okLabel: 'Approve + Freeze', danger: false }
      );
      if (!ok) return;
      try {
        const email = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ies_user_email') : null);
        const result = await api.approveScenarioRpc(currentScenario.id, email);
        console.log('[CM] approve result:', result);
        // Write a revision row via the client so the log captures this event
        try {
          const prev = await api.getLatestRevisionNumber(currentScenario.id);
          const row = scenarios.buildRevisionRow(
            currentScenario.id, prev, email,
            `Approved — ${result?.snap_labor || 0} labor + ${result?.snap_facility || 0} facility + ${result?.snap_heuristics || 0} heuristic snapshots frozen`,
            { overrides: heuristicOverrides },
            { snap_counts: result }
          );
          await api.writeRevision(row);
        } catch (revErr) { console.warn('[CM] writeRevision on approve failed:', revErr); }
        await ensureScenariosLoaded();
        renderSection();
      } catch (err) {
        console.error('[CM] approve failed:', err);
        showToast('Approval failed: ' + (err?.message || err), 'error');
      }
    });
    act('scenario-clone')?.addEventListener('click', async () => {
      if (!currentScenario) return;
      const label = await showPrompt('Label for the new child scenario?',
        (currentScenario.scenario_label || 'Scenario') + ' (child)');
      if (label === null) return;
      try {
        const { scenario: newScen, projectId: newProjId } = await api.cloneScenario(currentScenario.id, label.trim() || null);
        showToast(`Child scenario #${newScen.id} created on project #${newProjId}. Open it from the list below.`, 'success');
        await ensureScenariosLoaded();
        renderSection();
      } catch (err) {
        console.error('[CM] clone failed:', err);
        showToast('Clone failed: ' + (err?.message || err), 'error');
      }
    });
    act('scenario-init')?.addEventListener('click', async () => {
      if (!model?.id) {
        showToast('Save the project first, then initialize a scenario.', 'warning');
        return;
      }
      try {
        currentScenario = await api.saveScenario({
          project_id: model.id,
          deal_id: model?.projectDetails?.dealId || model?.deal_deals_id || null,
          scenario_label: model?.scenario_label || 'Baseline',
          is_baseline: true,
          status: 'draft',
        });
        await ensureScenariosLoaded();
        showToast('Scenario initialized', 'success');
        renderSection();
      } catch (err) { showToast('Init failed: ' + (err?.message || err), 'error'); }
    });
    act('scenarios-compare-picker')?.addEventListener('click', () => {
      openCompareModal();
    });
    container.querySelectorAll('[data-cm-action="scenario-open"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const projId = parseInt(btn.dataset.projectId);
        if (!projId) return;
        // Hand off to the existing open-model flow
        window.location.hash = `#/cost-model/${projId}`;
      });
    });
  }
}

/**
 * CM-SCN-1 (2026-04-26) — First-class scenario compare modal.
 *
 * Promotes scenario comparison from a thin delta grid (rows) to a wide
 * scenarios-as-columns view with three rolled-up sections:
 *   1. Headline KPIs (revenue / opex / ebitda / net income / capex / margin %)
 *   2. Pricing Schedule — effective rate per bucket, aligned by label
 *   3. Inputs — total HC, volume by UOM, building sqft, target margin
 *
 * Picks 2–4 scenarios. The first picked is treated as the comparison
 * baseline; other columns show value + Δ% (color-coded). Pricing pulls
 * `project_data.pricingBuckets[*].rate` (effective override) for each
 * scenario and falls back to recommendedRate when override absent.
 *
 * Entry points: "Compare scenarios →" button on Scenarios section AND on
 * the Summary section header (so it surfaces during demo walkthroughs).
 */
async function openCompareModal(opts = {}) {
  if (!Array.isArray(dealScenarios) || dealScenarios.length < 2) {
    showToast('Need at least 2 scenarios on this deal to compare.', 'warning');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'hub-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:white;border-radius:10px;padding:24px;width:1180px;max-width:95vw;max-height:92vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
        <div>
          <h3 style="margin:0;">Compare Scenarios</h3>
          <p class="cm-subtle" style="margin-top:4px;">Select 2–4 scenarios. First picked is the baseline; other columns show Δ% vs. baseline.</p>
        </div>
        <button class="hub-btn" data-close>×</button>
      </div>
      <div style="margin-top:12px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px 16px;max-height:200px;overflow:auto;border:1px solid var(--ies-gray-200);border-radius:6px;padding:8px 12px;">
        ${dealScenarios.map(sc => `
          <label style="display:flex;align-items:center;gap:8px;padding:4px 0;">
            <input type="checkbox" data-compare-id="${sc.id}" data-project-id="${sc.project_id}" ${sc.is_baseline ? 'checked' : ''} />
            <span style="flex:1;font-size:13px;">${sc.scenario_label}${sc.is_baseline ? ' ⭐' : ''}</span>
            <span class="hub-status-chip" style="background:${STATUS_COLORS[sc.status] || '#6b7280'};color:white;font-size:10px;">${sc.status}</span>
          </label>
        `).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button class="hub-btn" data-close>Cancel</button>
        <button class="hub-btn-primary" data-run-compare>Compare →</button>
      </div>
      <div id="cm-compare-result" style="margin-top:16px;"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => overlay.remove()));
  // CM-PRC-3 — when entry was the Pricing Schedule's "Compare Pricing" button,
  // pre-tick all scenarios + auto-run the compare and scroll to the pricing anchor.
  if (opts && opts.focus === 'pricing') {
    overlay.querySelectorAll('[data-compare-id]').forEach((el, i) => {
      // Pre-tick up to 4 scenarios. Already-checked stay checked.
      if (i < 4) /** @type {HTMLInputElement} */ (el).checked = true;
    });
    // Auto-run after the DOM settles so the result placeholder exists.
    setTimeout(() => {
      const runBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-run-compare]'));
      if (runBtn) {
        runBtn.click();
        // After the result re-renders (Promise.all on getModel), scroll to the anchor.
        setTimeout(() => {
          const anchor = overlay.querySelector('#cm-cmp-pricing-anchor');
          if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 600);
      }
    }, 60);
  }

  overlay.querySelector('[data-run-compare]').addEventListener('click', async () => {
    const picked = Array.from(overlay.querySelectorAll('[data-compare-id]:checked')).map(el => ({
      scenarioId: parseInt(el.dataset.compareId),
      projectId: parseInt(el.dataset.projectId),
    }));
    if (picked.length < 2 || picked.length > 4) {
      showToast('Pick 2–4 scenarios to compare.', 'warning');
      return;
    }
    const resultEl = overlay.querySelector('#cm-compare-result');
    resultEl.innerHTML = '<em>Loading scenarios…</em>';

    const bundles = await Promise.all(picked.map(async (p) => {
      const [monthly, proj] = await Promise.all([
        api.fetchMonthlyProjections(p.projectId).catch(() => []),
        api.getModel(p.projectId).catch(() => null),
      ]);
      const summary = (monthly || []).reduce((a, r) => {
        a.total_revenue += (r.revenue || 0);
        a.total_opex   += (r.opex || 0);
        a.ebitda       += (r.ebitda || 0);
        a.net_income   += (r.net_income || 0);
        a.capex        += (r.capex || 0);
        return a;
      }, { total_revenue: 0, total_opex: 0, ebitda: 0, net_income: 0, capex: 0 });
      summary.margin_pct = summary.total_revenue > 0 ? summary.ebitda / summary.total_revenue : 0;
      const sc = dealScenarios.find(s => s.id === p.scenarioId);
      const pdata = proj?.project_data || {};
      const laborLines = Array.isArray(pdata.laborLines) ? pdata.laborLines : [];
      const totalHC = laborLines.reduce((s, l) => s + (Number(l.fte) || 0), 0);
      const totalLaborCost = laborLines.reduce((s, l) => {
        const hrs = Number(l.annual_hours) || 0;
        const rate = Number(l.rate) || 0;
        return s + hrs * rate;
      }, 0);
      const avgCostPerHC = totalHC > 0 ? totalLaborCost / totalHC : 0;
      const volumeLines = Array.isArray(pdata.volumeLines) ? pdata.volumeLines : [];
      const volumeByUom = {};
      for (const vl of volumeLines) {
        const k = vl.uom || 'each';
        volumeByUom[k] = (volumeByUom[k] || 0) + (Number(vl.volume) || 0);
      }
      const sqft = Number(pdata?.facility?.totalSqft || pdata?.facility?.sqft || 0);
      const margin = Number(pdata?.financial?.targetMargin || 0);
      const buckets = Array.isArray(pdata.pricingBuckets) ? pdata.pricingBuckets : [];
      return {
        label: sc?.scenario_label || `#${p.scenarioId}`,
        status: sc?.status || 'unknown',
        is_baseline: !!sc?.is_baseline,
        scenarioId: p.scenarioId,
        projectId: p.projectId,
        summary,
        inputs: { totalHC, avgCostPerHC, volumeByUom, sqft, margin },
        buckets,
      };
    }));

    const fmtMoney = n => (n == null || !isFinite(n)) ? '—'
      : Math.abs(n) >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M'
      : Math.abs(n) >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K'
      : '$' + n.toFixed(0);
    const fmtNum = n => (n == null || !isFinite(n)) ? '—' : Math.abs(n) >= 1e6 ? (n/1e6).toFixed(2)+'M' : Math.abs(n) >= 1e3 ? (n/1e3).toFixed(1)+'K' : n.toFixed(0);
    const fmtRate = n => (n == null || !isFinite(n) || n === 0) ? '—' : '$' + n.toFixed(2);
    const fmtPct = n => (n == null || !isFinite(n)) ? '—' : (n*100).toFixed(1) + '%';
    const deltaCell = (val, base, opts={}) => {
      if (val == null || base == null || !isFinite(val) || !isFinite(base) || base === 0) return '';
      const d = (val - base) / Math.abs(base);
      if (Math.abs(d) < 0.005) return '';
      const arrow = d > 0 ? '↑' : '↓';
      const inv = !!opts.lowerIsBetter;
      const goodGreen = (d > 0) !== inv;
      const color = goodGreen ? 'var(--ies-green)' : 'var(--ies-red)';
      return `<span style="color:${color};font-size:11px;margin-left:4px;">${arrow}${(Math.abs(d)*100).toFixed(0)}%</span>`;
    };

    const baselineBuckets = bundles[0].buckets;
    const seenLabels = new Set();
    const orderedLabels = [];
    for (const b of baselineBuckets) {
      const lbl = b.label || b.name || `Bucket ${b.id}`;
      if (!seenLabels.has(lbl)) { seenLabels.add(lbl); orderedLabels.push({ label: lbl, uom: b.uom, type: b.type }); }
    }
    for (const bundle of bundles.slice(1)) {
      for (const b of bundle.buckets) {
        const lbl = b.label || b.name || `Bucket ${b.id}`;
        if (!seenLabels.has(lbl)) { seenLabels.add(lbl); orderedLabels.push({ label: lbl, uom: b.uom, type: b.type }); }
      }
    }
    const bucketRateForBundle = (bundle, lbl) => {
      const b = bundle.buckets.find(x => (x.label || x.name) === lbl);
      if (!b) return null;
      const override = Number(b.rate);
      if (isFinite(override) && override > 0) return override;
      const rec = Number(b.recommendedRate);
      return isFinite(rec) && rec > 0 ? rec : null;
    };

    const uomSet = new Set();
    bundles.forEach(b => Object.keys(b.inputs.volumeByUom).forEach(u => uomSet.add(u)));
    const uoms = Array.from(uomSet);

    const colCount = bundles.length;
    const colWidthPct = Math.floor(70 / colCount);

    const colHeaders = bundles.map((b, i) => `
      <th style="text-align:right;padding:8px;${i === 0 ? 'background:#fef3c7;' : ''}width:${colWidthPct}%;">
        <div style="font-weight:600;font-size:13px;">${b.label}${b.is_baseline ? ' ⭐' : ''}</div>
        <div style="font-size:10px;color:var(--ies-gray-500);font-weight:400;margin-top:2px;">
          <span class="hub-status-chip" style="background:${STATUS_COLORS[b.status] || '#6b7280'};color:white;font-size:9px;padding:1px 4px;">${b.status}</span>
          ${i === 0 ? '<span style="margin-left:6px;color:#92400e;">baseline</span>' : ''}
        </div>
      </th>
    `).join('');

    const kpiRow = (label, key, opts={}) => {
      const fmt = opts.fmt || fmtMoney;
      const base = bundles[0].summary[key];
      return `
        <tr>
          <td style="padding:6px 10px;">${label}</td>
          ${bundles.map((b, i) => `
            <td class="cm-num" style="padding:6px 10px;${i === 0 ? 'background:#fef3c7;' : ''}">
              ${fmt(b.summary[key])}${i > 0 ? deltaCell(b.summary[key], base, opts) : ''}
            </td>
          `).join('')}
        </tr>
      `;
    };

    const inputRow = (label, getter, opts={}) => {
      const fmt = opts.fmt || fmtNum;
      const base = getter(bundles[0]);
      return `
        <tr>
          <td style="padding:6px 10px;">${label}</td>
          ${bundles.map((b, i) => {
            const v = getter(b);
            return `
              <td class="cm-num" style="padding:6px 10px;${i === 0 ? 'background:#fef3c7;' : ''}">
                ${fmt(v)}${i > 0 ? deltaCell(v, base, opts) : ''}
              </td>
            `;
          }).join('')}
        </tr>
      `;
    };

    const bucketRow = (meta) => {
      const base = bucketRateForBundle(bundles[0], meta.label);
      return `
        <tr>
          <td style="padding:6px 10px;">
            ${meta.label}
            <span style="font-size:10px;color:var(--ies-gray-500);margin-left:6px;">${meta.type === 'fixed' ? 'fixed/mo' : '/'+meta.uom}</span>
          </td>
          ${bundles.map((b, i) => {
            const v = bucketRateForBundle(b, meta.label);
            return `
              <td class="cm-num" style="padding:6px 10px;${i === 0 ? 'background:#fef3c7;' : ''}">
                ${fmtRate(v)}${i > 0 ? deltaCell(v, base, { lowerIsBetter: false }) : ''}
              </td>
            `;
          }).join('')}
        </tr>
      `;
    };

    // Sanity-check: when scenarios produce identical surfaced metrics (no monthly
    // projections + identical inputs), the grid looks "broken" because every column
    // matches every other column. Surface an advisory banner so the user knows it's
    // an upstream save/Run issue, not the modal failing to differentiate.
    const allKpisZero = bundles.every(b =>
      b.summary.total_revenue === 0 && b.summary.total_opex === 0 &&
      b.summary.ebitda === 0 && b.summary.capex === 0
    );
    const inputsHash = (b) => JSON.stringify({
      hc: b.inputs.totalHC, sqft: b.inputs.sqft, margin: b.inputs.margin,
      vol: b.inputs.volumeByUom,
      buckets: (b.buckets || []).map(x => ({ l: x.label || x.name, r: x.rate, rec: x.recommendedRate })),
    });
    const baselineHash = inputsHash(bundles[0]);
    const allInputsIdentical = bundles.every(b => inputsHash(b) === baselineHash);
    const advisoryParts = [];
    if (allKpisZero) advisoryParts.push('No monthly projections found for any picked scenario — open each one and click <strong>Save</strong> (or run the calc) to generate revenue/opex/EBITDA before comparing.');
    if (allInputsIdentical && bundles.length >= 2) advisoryParts.push('Picked scenarios have <strong>identical inputs</strong> on volumes / pricing / labor / facility / margin. If you edited a scenario expecting a difference, confirm the edit landed in the right row and that you clicked Save.');
    const advisoryBanner = advisoryParts.length ? `
      <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#78350f;">
        <strong>⚠ Compare advisory:</strong>
        <ul style="margin:6px 0 0 18px;padding:0;">${advisoryParts.map(p => `<li style="margin:2px 0;">${p}</li>`).join('')}</ul>
      </div>
    ` : '';

    resultEl.innerHTML = `
      ${advisoryBanner}
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px;">
        <div class="cm-subtle">Δ% colors: green = better for the deal vs. baseline; red = worse. Lower-is-better metrics (opex, capex, cost/HC, sqft) invert. Pricing rates use the effective rate (override → recommended).</div>
        <div style="display:flex;gap:6px;">
          <button class="hub-btn" data-copy-table title="Copy the comparison as TSV (paste into Excel / Google Sheets / Slides)">Copy as table</button>
        </div>
      </div>
      <table class="cm-table cm-compare-table" style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px;width:30%;background:var(--ies-gray-50);">Metric</th>
            ${colHeaders}
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="${colCount + 1}" style="padding:10px 10px 4px;background:var(--ies-gray-50);font-size:11px;font-weight:600;letter-spacing:0.04em;color:var(--ies-gray-500);">HEADLINE KPIs (LIFE-OF-CONTRACT)</td></tr>
          ${kpiRow('Total Revenue', 'total_revenue')}
          ${kpiRow('Total Opex',    'total_opex',  { lowerIsBetter: true })}
          ${kpiRow('EBITDA',        'ebitda')}
          ${kpiRow('Net Income',    'net_income')}
          ${kpiRow('CapEx',         'capex',       { lowerIsBetter: true })}
          ${kpiRow('EBITDA Margin', 'margin_pct',  { fmt: fmtPct })}

          ${orderedLabels.length > 0 ? `
            <tr id="cm-cmp-pricing-anchor"><td colspan="${colCount + 1}" style="padding:10px 10px 4px;background:var(--ies-gray-50);font-size:11px;font-weight:600;letter-spacing:0.04em;color:var(--ies-gray-500);">PRICING SCHEDULE (EFFECTIVE RATE)</td></tr>
            ${orderedLabels.map(meta => bucketRow(meta)).join('')}
          ` : ''}

          <tr><td colspan="${colCount + 1}" style="padding:10px 10px 4px;background:var(--ies-gray-50);font-size:11px;font-weight:600;letter-spacing:0.04em;color:var(--ies-gray-500);">INPUTS</td></tr>
          ${inputRow('Total Headcount (FTE)', b => b.inputs.totalHC, { fmt: n => (n == null ? '—' : n.toFixed(1)) })}
          ${inputRow('Avg Cost / HC',         b => b.inputs.avgCostPerHC, { fmt: fmtMoney, lowerIsBetter: true })}
          ${uoms.map(u => inputRow(`Volume — ${u}`, b => b.inputs.volumeByUom[u] || 0)).join('')}
          ${inputRow('Building Sqft',         b => b.inputs.sqft, { lowerIsBetter: true })}
          ${inputRow('Target Margin',         b => b.inputs.margin / 100, { fmt: fmtPct })}
        </tbody>
      </table>
      <p class="cm-subtle" style="margin-top:8px;">Approved scenarios reflect frozen snapshots; draft/review scenarios reflect their current saved inputs. Open any scenario to drill in.</p>
    `;

    overlay.querySelector('[data-copy-table]')?.addEventListener('click', () => {
      const rows = [];
      rows.push(['Metric', ...bundles.map(b => b.label + (b.is_baseline ? ' (baseline)' : ''))]);
      const pushKpi = (label, key, opts={}) => {
        const fmt = opts.fmt || fmtMoney;
        rows.push([label, ...bundles.map(b => fmt(b.summary[key]).replace(/[↑↓]/g,''))]);
      };
      rows.push(['HEADLINE KPIs']);
      pushKpi('Total Revenue', 'total_revenue');
      pushKpi('Total Opex',    'total_opex');
      pushKpi('EBITDA',        'ebitda');
      pushKpi('Net Income',    'net_income');
      pushKpi('CapEx',         'capex');
      pushKpi('EBITDA Margin', 'margin_pct', { fmt: fmtPct });
      if (orderedLabels.length) {
        rows.push(['PRICING SCHEDULE (EFFECTIVE RATE)']);
        orderedLabels.forEach(m => {
          rows.push([`${m.label} (${m.type === 'fixed' ? 'fixed/mo' : '/'+m.uom})`,
            ...bundles.map(b => fmtRate(bucketRateForBundle(b, m.label)))]);
        });
      }
      rows.push(['INPUTS']);
      rows.push(['Total Headcount (FTE)', ...bundles.map(b => (b.inputs.totalHC || 0).toFixed(1))]);
      rows.push(['Avg Cost / HC',         ...bundles.map(b => fmtMoney(b.inputs.avgCostPerHC))]);
      uoms.forEach(u => rows.push([`Volume — ${u}`, ...bundles.map(b => fmtNum(b.inputs.volumeByUom[u] || 0))]));
      rows.push(['Building Sqft',         ...bundles.map(b => fmtNum(b.inputs.sqft))]);
      rows.push(['Target Margin',         ...bundles.map(b => fmtPct((b.inputs.margin || 0) / 100))]);
      const tsv = rows.map(r => r.join('\t')).join('\n');
      navigator.clipboard.writeText(tsv).then(() => {
        showToast('Compare table copied as TSV — paste into Excel / Sheets / Slides.', 'success');
      }).catch(err => {
        console.warn('[CM] copy compare TSV failed:', err);
        showToast('Copy failed — check console.', 'error');
      });
    });
  });
}

/**
 * Per-row monthly OT/absence seasonality editor (Phase 4b).
 * Opens a modal with two 12-column rows of percent inputs (one for OT,
 * one for absence). "Use Market Defaults" pulls from ref_labor_market_profiles
 * for the project's market.
 */
async function openLaborSeasonalityModal(idx) {
  const line = (model.laborLines || [])[idx];
  if (!line) return;
  const otProfile = Array.isArray(line.monthly_overtime_profile) ? [...line.monthly_overtime_profile] : null;
  const absProfile = Array.isArray(line.monthly_absence_profile) ? [...line.monthly_absence_profile] : null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtCell = (val) => (val === null || val === undefined) ? '' : (Number(val) * 100).toFixed(1);

  const overlay = document.createElement('div');
  overlay.className = 'hub-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:white;border-radius: 10px;padding:24px;min-width:780px;max-width:95vw;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <h3 style="margin:0;">Monthly OT / Absence Seasonality</h3>
          <p class="cm-subtle" style="margin-top:4px;">${line.activity_name || line.role_name || `Line #${idx+1}`} — values are percent (e.g. 5 means 5%)</p>
        </div>
        <button class="hub-btn" data-close>×</button>
      </div>
      <div style="margin-top:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <strong>Overtime % per month</strong>
          <button class="hub-btn" style="font-size:11px;" data-clear-ot>Clear (use project flat)</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px;">
          ${months.map((m, mi) => `
            <div>
              <label style="font-size:11px;color:#666;display:block;text-align:center;">${m}</label>
              <input type="number" step="0.5" min="0" max="200" data-ot-month="${mi}"
                value="${otProfile ? fmtCell(otProfile[mi]) : ''}"
                placeholder=""
                style="width:100%;text-align:right;padding:4px;" />
            </div>
          `).join('')}
        </div>
      </div>
      <div style="margin-top:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <strong>Absence % per month</strong>
          <button class="hub-btn" style="font-size:11px;" data-clear-abs>Clear (use project flat)</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px;">
          ${months.map((m, mi) => `
            <div>
              <label style="font-size:11px;color:#666;display:block;text-align:center;">${m}</label>
              <input type="number" step="0.5" min="0" max="100" data-abs-month="${mi}"
                value="${absProfile ? fmtCell(absProfile[mi]) : ''}"
                style="width:100%;text-align:right;padding:4px;" />
            </div>
          `).join('')}
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:16px;border-top:1px solid #eee;padding-top:12px;">
        <button class="hub-btn" data-use-market>Use Market Defaults</button>
        <div style="display:flex;gap:8px;">
          <button class="hub-btn" data-close>Cancel</button>
          <button class="hub-btn-primary" data-save>Save Seasonality</button>
        </div>
      </div>
      <div id="cm-seasonality-status" style="margin-top:8px;font-size:11px;color:#666;"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const status = overlay.querySelector('#cm-seasonality-status');
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => overlay.remove()));

  // Read inputs into 12-element fractional arrays. Empty cells = null
  // (means inherit). If ANY cell has a value, missing cells default to 0.
  const collect = (selectorPrefix) => {
    const arr = [];
    let hasAny = false;
    for (let m = 0; m < 12; m++) {
      const el = overlay.querySelector(`[${selectorPrefix}="${m}"]`);
      const v = el?.value?.trim();
      if (v === '' || v === undefined || v === null) { arr.push(null); }
      else { hasAny = true; arr.push(Number(v) / 100); }
    }
    if (!hasAny) return null;
    // Replace nulls with 0 so persisted profile is exactly 12 numerics
    return arr.map(x => x === null ? 0 : x);
  };

  overlay.querySelector('[data-clear-ot]')?.addEventListener('click', () => {
    overlay.querySelectorAll('[data-ot-month]').forEach(el => { el.value = ''; });
  });
  overlay.querySelector('[data-clear-abs]')?.addEventListener('click', () => {
    overlay.querySelectorAll('[data-abs-month]').forEach(el => { el.value = ''; });
  });

  overlay.querySelector('[data-use-market]')?.addEventListener('click', async () => {
    const market = model.projectDetails?.market;
    if (!market) { status.textContent = 'No market selected — pick one in Setup first.'; return; }
    status.textContent = 'Loading market profile…';
    try {
      const mp = await api.fetchLaborMarketProfile(market);
      if (!mp) { status.textContent = 'No labor market profile defined for this market.'; return; }
      const ot = Array.isArray(mp.peak_month_overtime_pct) ? mp.peak_month_overtime_pct : [];
      const abs = Array.isArray(mp.peak_month_absence_pct) ? mp.peak_month_absence_pct : [];
      for (let m = 0; m < 12; m++) {
        const otEl = overlay.querySelector(`[data-ot-month="${m}"]`);
        const absEl = overlay.querySelector(`[data-abs-month="${m}"]`);
        if (otEl && ot[m] !== undefined) otEl.value = (Number(ot[m]) * 100).toFixed(1);
        if (absEl && abs[m] !== undefined) absEl.value = (Number(abs[m]) * 100).toFixed(1);
      }
      status.textContent = `Loaded ${mp.notes || 'market defaults'} — turnover ${mp.turnover_pct_annual}%, temp premium ${mp.temp_cost_premium_pct}%. Click Save to persist to this line.`;
    } catch (e) { status.textContent = 'Load failed: ' + (e?.message || e); }
  });

  overlay.querySelector('[data-save]')?.addEventListener('click', async () => {
    const ot = collect('data-ot-month');
    const abs = collect('data-abs-month');
    const otIssue = scenarios.validateMonthlyProfile(ot);
    if (otIssue) { status.textContent = 'Overtime seasonality: ' + otIssue; return; }
    const absIssue = scenarios.validateMonthlyProfile(abs);
    if (absIssue) { status.textContent = 'Absence seasonality: ' + absIssue; return; }
    line.monthly_overtime_profile = ot;
    line.monthly_absence_profile = abs;
    if (line.id) {
      try {
        await api.saveLaborMonthlyProfile(line.id, {
          monthly_overtime_profile: ot,
          monthly_absence_profile: abs,
        });
      } catch (e) { status.textContent = 'Save failed: ' + (e?.message || e); return; }
    } else {
      isDirty = true;
    }
    overlay.remove();
    renderSection();
  });
}

// ============================================================
// PHASE 5b — WHAT-IF STUDIO (transient slider overlay + live KPI)
// ============================================================

/** Slider config — 11 high-leverage heuristics. */
const WHATIF_SLIDERS = [
  { key: 'tax_rate_pct',              label: 'Tax Rate',               group: 'Financial',    min: 0,  max: 50, step: 0.5, unit: '%' },
  { key: 'discount_rate_pct',         label: 'Discount Rate',          group: 'Financial',    min: 3,  max: 25, step: 0.25, unit: '%' },
  { key: 'target_margin_pct',         label: 'Target Margin',          group: 'Financial',    min: 0,  max: 30, step: 0.5, unit: '%' },
  // M4 (2026-04-21): Pricing Discount — uniform multiplier applied to every
  // bucket's effective rate. Simulates competitive-pressure negotiation
  // scenarios. −5% = "customer wins a 5% concession across all buckets."
  { key: 'pricing_discount_pct',      label: 'Pricing Discount',       group: 'Financial',    min: -15, max: 15, step: 0.5, unit: '%' },
  { key: 'annual_volume_growth_pct',  label: 'Volume Growth',          group: 'Financial',    min: -20, max: 30, step: 0.5, unit: '%' },
  { key: 'dso_days',                  label: 'DSO',                    group: 'WC',           min: 0,  max: 120, step: 1, unit: 'days' },
  { key: 'dpo_days',                  label: 'DPO',                    group: 'WC',           min: 0,  max: 120, step: 1, unit: 'days' },
  // Benefit Load removed 2026-04-21 PM (Brock live feedback): slider only
  // takes effect when per-line wage_load is unset. Post 2026-04-20 single-
  // source wage-load fix, most labor lines carry their own value so this
  // was silently quiet on real projects. Manage benefit load on the
  // Labor Factors card instead — it's a single source of truth now.
  { key: 'overtime_pct',              label: 'Overtime %',             group: 'Labor',        min: 0,  max: 30, step: 0.5, unit: '%' },
  { key: 'absence_allowance_pct',     label: 'Absence %',              group: 'Labor',        min: 0,  max: 25, step: 0.5, unit: '%' },
  // Brock 2026-04-20: direct-labor productivity (% to MOST engineered
  // standard). 100% = pure engineered. Typical trained op: 85–95%.
  // Flows to labor cost via a 1/prod multiplier on base_uph (lower UPH =
  // more hours = more $). Matches the MOST productivity_pct concept.
  { key: 'direct_labor_productivity_pct', label: 'Direct Labor Productivity', group: 'Labor', min: 70, max: 110, step: 0.5, unit: '%' },
  { key: 'labor_escalation_pct',      label: 'Labor Escalation / yr',  group: 'Escalation',   min: 0,  max: 15, step: 0.25, unit: '%' },
  { key: 'facility_escalation_pct',   label: 'Facility Escalation',    group: 'Escalation',   min: 0,  max: 15, step: 0.25, unit: '%' },
];

/**
 * Return the current effective value for a slider key, preferring transient
 * → override → catalog default.
 */
function whatIfCurrentValue(sliderKey) {
  if (Object.prototype.hasOwnProperty.call(whatIfTransient, sliderKey) && whatIfTransient[sliderKey] !== '') {
    return Number(whatIfTransient[sliderKey]);
  }
  if (Object.prototype.hasOwnProperty.call(heuristicOverrides, sliderKey) && heuristicOverrides[sliderKey] !== '' && heuristicOverrides[sliderKey] !== null) {
    return Number(heuristicOverrides[sliderKey]);
  }
  // 2026-04-21 audit: several sliders shadow project-level fields (target
  // margin, tax rate, DSO/DPO, volume growth, escalation). If no override /
  // transient is set, read the current project value so the slider reflects
  // live state rather than the catalog default (e.g. Wayfair targetMargin
  // 11.5% was rendering as catalog default 12%).
  const projectValue = _whatIfProjectFallback(sliderKey);
  if (projectValue != null) return projectValue;
  const def = (heuristicsCatalog || []).find(h => h.key === sliderKey);
  if (def?.default_value != null) return def.default_value;
  // Hard-coded fallback defaults for sliders that may not be in the catalog
  // (yet). Keeps the slider from rendering at 0 and zeroing out downstream
  // calcs on first load.
  return WHATIF_FALLBACK_DEFAULTS[sliderKey] ?? 0;
}

/**
 * Project-value fallback for sliders that shadow a project-level setting.
 * Returns a Number if the project carries that value, or null to defer to
 * the catalog default. Keeps the What-If Studio "baseline" equal to the
 * project's actual current state instead of a generic catalog figure.
 */
function _whatIfProjectFallback(sliderKey) {
  const fin = model?.financial || {};
  const pd  = model?.projectDetails || {};
  switch (sliderKey) {
    case 'target_margin_pct':
      return typeof fin.targetMargin === 'number' ? fin.targetMargin : null;
    case 'tax_rate_pct':
      return typeof pd.taxRate === 'number' ? pd.taxRate : null;
    case 'discount_rate_pct':
      return typeof fin.discountRate === 'number' ? fin.discountRate : null;
    case 'reinvest_rate_pct':
      return typeof fin.reinvestRate === 'number' ? fin.reinvestRate : null;
    case 'annual_volume_growth_pct':
      return typeof fin.volumeGrowth === 'number' ? fin.volumeGrowth : null;
    case 'labor_escalation_pct':
      return typeof fin.laborEscalation === 'number' ? fin.laborEscalation : null;
    case 'facility_escalation_pct':
      return typeof fin.facilityEscalation === 'number' ? fin.facilityEscalation : null;
    case 'dso_days':
      return typeof fin.dsoDays === 'number' ? fin.dsoDays : null;
    case 'dpo_days':
      return typeof fin.dpoDays === 'number' ? fin.dpoDays : null;
    default:
      return null;
  }
}

/** Fallback defaults for sliders not represented in the heuristics catalog. */
const WHATIF_FALLBACK_DEFAULTS = {
  direct_labor_productivity_pct: 100,  // 100% = pure MOST engineered (no drag)
  pricing_discount_pct: 0,             // M4: 0 = no discount (recommended rates)
};

/** Same, but as a display string so sliders + readouts stay consistent. */
function whatIfSource(sliderKey) {
  if (Object.prototype.hasOwnProperty.call(whatIfTransient, sliderKey) && whatIfTransient[sliderKey] !== '') return 'transient';
  if (Object.prototype.hasOwnProperty.call(heuristicOverrides, sliderKey) && heuristicOverrides[sliderKey] !== '' && heuristicOverrides[sliderKey] !== null) return 'override';
  return 'default';
}

/**
 * Build a what-if preview using the current model + a transient slider
 * overlay. When `overlay` is omitted, uses the live `whatIfTransient`. Pass
 * `{}` to get the baseline (no slider changes) for side-by-side delta
 * rendering.
 *
 * Returns an object mirroring the Summary KPI shape + NPV + baseline
 * annotations so the UI can compute deltas without re-entering this fn.
 *
 * Direct-Labor Productivity (Brock 2026-04-20): when the overlay contains
 * `direct_labor_productivity_pct` (or when it's resolved from overrides),
 * we scale labor UPH by (prod/100) — lower prod → lower effective UPH →
 * more hours for the same volume → higher labor cost. Applied to both the
 * monthly per-line path and the aggregate fallback.
 *
 * @param {Object} [overlay] — transient slider map. Defaults to whatIfTransient.
 */
function computeWhatIfPreview(overlay) {
  try {
    const ov = overlay === undefined ? whatIfTransient : (overlay || {});
    const market = model.projectDetails?.market;
    const fr = (refData.facilityRates || []).find(r => r.market_id === market);
    const ur = (refData.utilityRates || []).find(r => r.market_id === market);
    const opHrs = calc.operatingHours(model.shifts || {});
    const orders = (model.volumeLines || []).find(v => v.isOutboundPrimary)?.volume || 0;
    const contractYears = model.projectDetails?.contractTerm || 5;
    const fin = model.financial || {};
    const summary = calc.computeSummary({
      laborLines: model.laborLines || [],
      indirectLaborLines: model.indirectLaborLines || [],
      equipmentLines: model.equipmentLines || [],
      overheadLines: model.overheadLines || [],
      vasLines: model.vasLines || [],
      startupLines: model.startupLines || [],
      facility: model.facility || {},
      shifts: model.shifts || {},
      facilityRate: fr,
      utilityRate: ur,
      contractYears,
      targetMarginPct: fin.targetMargin || 0,
      annualOrders: orders || 1,
    });
    const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
      currentScenario, currentScenarioSnapshots, heuristicOverrides, fin, ov,
    ), model);
    const whatIfMarginFrac = (calcHeur.targetMarginPct || 0) / 100;

    // Direct Labor Productivity scaling. Pull from the overlay first, then
    // from heuristicOverrides, else default to 100 (no drag). Scale is
    // 100/prod: 90% prod → 1.111× hours → 1.111× labor cost.
    const dlProd = ov.direct_labor_productivity_pct != null && ov.direct_labor_productivity_pct !== ''
      ? Number(ov.direct_labor_productivity_pct)
      : (heuristicOverrides.direct_labor_productivity_pct != null && heuristicOverrides.direct_labor_productivity_pct !== ''
          ? Number(heuristicOverrides.direct_labor_productivity_pct)
          : 100);
    const dlProdClamped = Math.max(1, Math.min(150, Number.isFinite(dlProd) ? dlProd : 100));
    const laborHoursScale = 100 / dlProdClamped;  // 90 → 1.111, 100 → 1.0, 110 → 0.909

    // 2026-04-21 PM (Brock live feedback): Direct Labor Productivity was
    // scaling base_uph only, but the monthly engine reads `annual_hours`
    // directly via monthlyEffectiveHours — so the slider was silently dead
    // when the monthly engine was on (default). Fix: scale annual_hours
    // alongside base_uph so BOTH paths (per-line monthly and aggregate
    // yearly fallback) reflect productivity. 90% prod → 1.111× annual_hours
    // → 1.111× labor cost; 110% prod → 0.909× hours → 0.909× cost.
    // 2026-04-21 audit (Brock): Absence % slider was silently dead on
    // projects where labor lines carry a `monthly_absence_profile` (market
    // profile resolution). `monthlyAbsencePct` prefers the per-line profile
    // → market profile → calcHeur fallback, so the slider's calcHeur value
    // never reached the engine when profiles were set. Fix: when absence is
    // in the overlay, strip per-line profiles so calcHeur.absenceAllowancePct
    // becomes authoritative. Below we also clone the market profile with
    // absence_pct nulled to close the last hop.
    const absenceOverlayActive = ov.absence_allowance_pct != null && ov.absence_allowance_pct !== '';
    const scaledLaborLines = (model.laborLines || []).map(l => ({
      ...l,
      annual_hours: (l.annual_hours || 0) * laborHoursScale,  // THE one the monthly engine consumes
      base_uph: (l.base_uph || 0) / laborHoursScale,          // kept in sync for any UPH-reading downstream
      // If absence overlay active, strip per-line profile so calcHeur wins.
      ...(absenceOverlayActive ? { monthly_absence_profile: null } : {}),
    }));
    const scaledBaseLaborCost = summary.laborCost * laborHoursScale;
    // Clone market profile without absence array when the overlay is driving
    // absence. Same rationale as above — ensures calcHeur.absenceAllowancePct
    // is the effective monthly absence for every month in the preview.
    const whatIfMarketProfile = absenceOverlayActive && currentMarketLaborProfile
      ? { ...currentMarketLaborProfile, peak_month_absence_pct: null }
      : currentMarketLaborProfile;

    // When margin or volume sliders are active, re-derive bucket rates
    // from the overlay values — otherwise explicit rates on Wayfair-style
    // buckets pin revenue at baseline and the margin slider reads as dead.
    // For other sliders (DSO, tax rate, labor rate) the explicit rates
    // remain the defensible pricing and we leave them alone.
    const marginOverlayActive = ov.target_margin_pct != null && ov.target_margin_pct !== '';
    const volOverlayActive    = ov.annual_volume_growth_pct != null && ov.annual_volume_growth_pct !== '';
    // M4 (2026-04-21): pricing-discount slider — uniform multiplier on every
    // bucket's effective rate. Same machinery as per-bucket overrides.
    const pricingDiscountPct = ov.pricing_discount_pct != null && ov.pricing_discount_pct !== ''
      ? Number(ov.pricing_discount_pct) : 0;
    const pricingMult = 1 + pricingDiscountPct / 100;
    const whatIfBuckets = (marginOverlayActive || volOverlayActive)
      ? (() => {
          const cleared = (model.pricingBuckets || []).map(b => ({ ...b, rate: 0 }));
          const bucketCosts = calc.computeBucketCosts({
            buckets: cleared,
            laborLines: model.laborLines || [],
            indirectLaborLines: model.indirectLaborLines || [],
            equipmentLines: model.equipmentLines || [],
            overheadLines: model.overheadLines || [],
            vasLines: model.vasLines || [],
            startupLines: (model.startupLines || []).map(l => ({
              ...l,
              annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears),
            })),
            facilityCost: summary.facilityCost || 0,
            operatingHours: opHrs || 0,
            facilityBucketId: model.financial?.facilityBucketId || null,
          });
          return calc.enrichBucketsWithDerivedRates({
            buckets: cleared,
            bucketCosts,
            marginPct: whatIfMarginFrac || 0,
            volumeLines: model.volumeLines || [],
          });
        })()
      : buildEnrichedPricingBuckets(summary, whatIfMarginFrac, opHrs, contractYears);
    // Apply M4 pricing-discount multiplier AFTER enrichment so it layers on
    // both explicit and derived rates uniformly.
    const whatIfBucketsAfterDiscount = pricingMult === 1 ? whatIfBuckets
      : whatIfBuckets.map(b => ({ ...b, rate: (Number(b.rate) || 0) * pricingMult }));

    const projResult = calc.buildYearlyProjections({
      years: contractYears,
      baseLaborCost: scaledBaseLaborCost,
      baseFacilityCost: summary.facilityCost,
      baseEquipmentCost: summary.equipmentCost,
      baseOverheadCost: summary.overheadCost,
      baseVasCost: summary.vasCost,
      startupAmort: summary.startupAmort,
      startupCapital: summary.startupCapital,
      baseOrders: orders || 1,
      marginPct: whatIfMarginFrac,
      volGrowthPct: calcHeur.volGrowthPct / 100,
      laborEscPct:  calcHeur.laborEscPct  / 100,
      costEscPct:   calcHeur.costEscPct   / 100,
      facilityEscPct:  calcHeur.facilityEscPct  / 100,
      equipmentEscPct: calcHeur.equipmentEscPct / 100,
      laborLines: scaledLaborLines,
      taxRatePct: calcHeur.taxRatePct,
      useMonthlyEngine: typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false,
      periods: (refData && refData.periods) || [],
      ramp: null,
      seasonality: model.seasonalityProfile || null,
      preGoLiveMonths: calcHeur.preGoLiveMonths,
      dsoDays:           calcHeur.dsoDays,
      dpoDays:           calcHeur.dpoDays,
      laborPayableDays:  calcHeur.laborPayableDays,
      startupLines: model.startupLines || [],
      pricingBuckets: whatIfBucketsAfterDiscount,
      project_id: model.id || 0,
      _calcHeur: calcHeur,
      marketLaborProfile: whatIfMarketProfile,
      wageLoadByYear: null,
    });

    // Aggregate over the projection horizon
    const projections = projResult.projections || [];
    const totalRev = projections.reduce((s, y) => s + (y.revenue || 0), 0);
    const totalOpex = projections.reduce((s, y) => s + (y.totalCost || 0), 0);
    const totalEbitda = projections.reduce((s, y) => s + (y.ebitda || 0), 0);
    const totalNI = projections.reduce((s, y) => s + (y.netIncome || 0), 0);
    // Cum FCF — groupMonthlyToYearly now attaches a running `cumFcf` per year
    // (post 2026-04-20 PM audit). Previously this field was absent and the
    // KPI always read $0.
    const lastCumFcf = projections.length
      ? (projections[projections.length - 1].cumFcf ?? projections.reduce((s, y) => s + (y.freeCashFlow || 0), 0))
      : 0;

    // NPV — so the discount_rate_pct slider has a visible preview effect.
    // Uses the built-in computeFinancialMetrics (same path Summary uses).
    // Parity fix (2026-04-20 PM): pass equipmentCapital + annualDepreciation
    // + taxRatePct + dso/dpo so the What-If baseline NPV matches the Summary
    // NPV on the same project. Previously omitted, so the two screens read
    // different NPVs for the unchanged baseline scenario.
    const totalFtes = (model.laborLines || []).reduce((s, l) => {
      if (!opHrs || opHrs <= 0) return s;
      return s + ((l.annual_hours || 0) / opHrs);
    }, 0);
    let npv = 0;
    try {
      const metrics = calc.computeFinancialMetrics(projections, {
        startupCapital:   summary.startupCapital || 0,
        equipmentCapital: summary.equipmentCapital || 0,
        annualDepreciation: (summary.equipmentAmort || 0) + (summary.startupAmort || 0),
        discountRatePct: calcHeur.discountRatePct,
        reinvestRatePct: calcHeur.reinvestRatePct || 8,
        taxRatePct:      calcHeur.taxRatePct,
        dsoDays:         calcHeur.dsoDays,
        dpoDays:         calcHeur.dpoDays,
        totalFtes,
        fixedCost: (summary.facilityCost || 0) + (summary.overheadCost || 0) + (summary.startupAmort || 0),
      });
      npv = metrics.npv || 0;
    } catch (metricsErr) {
      // Metrics are defensive; a failure here shouldn't break the preview.
      console.warn('[CM] preview metrics computation failed:', metricsErr);
    }

    return {
      totalRev, totalOpex, totalEbitda, totalNI,
      ebitdaMargin: totalRev > 0 ? (totalEbitda / totalRev * 100) : 0,
      cumFcf: lastCumFcf,
      npv,
      // Expose per-year projections so the trajectory chart can render
      // baseline vs scenario lines without a second compute pass.
      projections,
      calcHeur,
    };
  } catch (err) {
    console.warn('[CM] what-if preview failed:', err);
    return null;
  }
}

/**
 * Per-slider isolated impact — re-runs the preview with an overlay that
 * contains ONLY this slider's transient value. Returns deltas across all
 * the financial-review metrics so the drivers panel can attribute movement
 * honestly: some sliders only move NPV (Discount Rate), some only move
 * working capital (DSO/DPO), some move NI/EBITDA/Margin. Caveat: ignores
 * interactions between sliders (superposition approx).
 */
function _computeWhatIfDriverImpacts(baseline) {
  if (!baseline) return {};
  const out = {};
  const activeKeys = Object.keys(whatIfTransient).filter(
    k => whatIfTransient[k] !== '' && whatIfTransient[k] !== undefined,
  );
  for (const key of activeKeys) {
    const iso = computeWhatIfPreview({ [key]: whatIfTransient[key] });
    if (!iso) continue;
    out[key] = {
      dNI:       iso.totalNI       - baseline.totalNI,
      dEbitda:   iso.totalEbitda   - baseline.totalEbitda,
      dRevenue:  iso.totalRev      - baseline.totalRev,
      dNPV:      (iso.npv ?? 0)    - (baseline.npv ?? 0),
      dCumFcf:   (iso.cumFcf ?? 0) - (baseline.cumFcf ?? 0),
      dMarginPp: iso.ebitdaMargin  - baseline.ebitdaMargin, // percentage points
    };
  }
  return out;
}

function renderWhatIfStudio() {
  // Lazy-load catalog so defaults render
  if (heuristicsCatalog.length === 0 && !_heuristicsLoadInFlight) {
    _heuristicsLoadInFlight = true;
    ensureHeuristicsLoaded()
      .finally(() => { _heuristicsLoadInFlight = false; })
      .then(() => renderSection());
  }
  // Compute BOTH baseline (empty overlay) and current-preview (with
  // transient overlay) so KPIs show Baseline | Scenario | Δ in-line.
  const preview = computeWhatIfPreview();
  const baseline = computeWhatIfPreview({});
  const impacts = _computeWhatIfDriverImpacts(baseline);

  const groups = new Map();
  for (const s of WHATIF_SLIDERS) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const activeCount = Object.keys(whatIfTransient).filter(k => whatIfTransient[k] !== '' && whatIfTransient[k] !== undefined).length;
  const contractYears = model.projectDetails?.contractTerm || 5;

  const fmt = n => (n == null ? '—' : (
    Math.abs(n) >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' :
    Math.abs(n) >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' :
    '$' + n.toFixed(0)
  ));
  const fmtShort = n => (n == null ? '—' : (
    Math.abs(n) >= 1e6 ? '$' + (n/1e6).toFixed(1) + 'M' :
    Math.abs(n) >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' :
    '$' + n.toFixed(0)
  ));
  const pctFmt = n => (n == null ? '—' : `${n.toFixed(1)}%`);
  const deltaColor = (delta, positiveIsGood) =>
    delta === 0 ? 'var(--ies-gray-400, #9ca3af)'
                : (delta > 0 ? (positiveIsGood ? '#16a34a' : '#dc2626') : (positiveIsGood ? '#dc2626' : '#16a34a'));

  // Per-slider impact chip: "→ +$120K NI" or "→ −0.4pp margin"
  const impactChip = (key) => {
    const imp = impacts[key];
    if (!imp) return '';
    const v = imp.dNI;
    if (Math.abs(v) < 1000) return '';
    const sign = v >= 0 ? '+' : '−';
    const color = v >= 0 ? '#16a34a' : '#dc2626';
    return `<span class="cm-whatif-impact-chip" style="color:${color};" title="Isolated impact if only this slider were changed (ignores interactions with other sliders)">→ ${sign}${fmtShort(Math.abs(v))} NI</span>`;
  };

  const sliderRow = s => {
    const val = whatIfCurrentValue(s.key);
    const src = whatIfSource(s.key);
    const srcBadge = src === 'transient'
      ? '<span class="hub-chip hub-chip--info" style="font-size:9px;padding:1px 6px;">live</span>'
      : src === 'override'
        ? '<span class="hub-chip hub-chip--warn" style="font-size:9px;padding:1px 6px;">override</span>'
        : '';
    return `
      <div class="cm-whatif-slider-row">
        <div class="cm-whatif-slider-row__header">
          <div class="cm-whatif-slider-row__label">
            <span>${s.label}</span>
            ${srcBadge}
            ${impactChip(s.key)}
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <input type="number" step="${s.step}" min="${s.min}" max="${s.max}" value="${val}"
              data-whatif-number="${s.key}" style="width:52px;font-size:12px;text-align:right;padding:2px 4px;" />
            <span style="font-size:11px;color:var(--ies-gray-400);min-width:24px;">${s.unit}</span>
          </div>
        </div>
        <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${val}"
          data-whatif-slider="${s.key}" style="width:100%;margin-top:2px;" />
      </div>
    `;
  };

  // 3-col KPI row: Baseline | Scenario | Δ
  const kpiRow = (label, cur, base, opts = {}) => {
    const f = opts.formatter || fmt;
    const curStr = cur == null ? '—' : f(cur);
    const baseStr = base == null ? '—' : f(base);
    const delta = (cur == null || base == null) ? null : (cur - base);
    const showDelta = delta != null && Math.abs(delta) >= 0.001 * Math.max(Math.abs(base || 0), 1);
    const sign = delta >= 0 ? '+' : '−';
    const pctChange = (delta != null && base !== 0) ? (delta / base) * 100 : null;
    const color = delta == null ? 'var(--ies-gray-400)' : deltaColor(delta, opts.positiveIsGood);
    return `
      <tr>
        <td class="cm-whatif-kpi-row__label">${label}</td>
        <td class="hub-num cm-whatif-kpi-row__baseline">${baseStr}</td>
        <td class="hub-num cm-whatif-kpi-row__scenario">${curStr}</td>
        <td class="hub-num cm-whatif-kpi-row__delta" style="color:${color};">
          ${showDelta
            ? `${sign}${f(Math.abs(delta))}${pctChange != null && Math.abs(pctChange) >= 0.1 ? ` <span style="color:var(--ies-gray-400);font-size:11px;font-weight:500;">(${sign}${Math.abs(pctChange).toFixed(1)}%)</span>` : ''}`
            : '—'}
        </td>
      </tr>
    `;
  };

  // Multi-year trajectory chart — two SVG polylines (baseline grey, scenario
  // colored). Metric key comes from window._whatIfChartMetric (user toggle).
  const chartMetric = (typeof window !== 'undefined' && window._whatIfChartMetric) || 'netIncome';
  const METRICS = {
    netIncome:    { label: 'Net Income',      pick: p => p.netIncome },
    ebitda:       { label: 'EBITDA',          pick: p => p.ebitda },
    revenue:      { label: 'Revenue',         pick: p => p.revenue },
    freeCashFlow: { label: 'Free Cash Flow',  pick: p => p.freeCashFlow ?? p.free_cash_flow },
    // 2026-04-21 PM: include NPV/cum-FCF as selectable chart metrics so
    // Discount Rate / DSO / DPO have a meaningful attribution surface.
    // NPV is horizon-aggregate (scalar), not per-year; the trajectory chart
    // still uses per-year metrics, but the driver bars switch to the scalar.
    // For the chart we plot the cumulative FCF discounted to NPV per-year,
    // which the baseline projections already expose via cumFcf × discount.
    // Simplification: for NPV metric, plot cumFcf trajectory as a proxy —
    // the scalar NPV shown in the KPI panel is the authoritative number.
    cumFcf:       { label: 'Cum Cash',        pick: p => p.cumFcf },
  };
  const metricDef = METRICS[chartMetric] || METRICS.netIncome;

  const trajectoryChart = (() => {
    const pBase = baseline?.projections || [];
    const pSce  = preview?.projections  || [];
    if (pBase.length < 2 || pSce.length < 2) return '';
    const basePts = pBase.map(metricDef.pick);
    const scePts  = pSce.map(metricDef.pick);
    const all = [...basePts, ...scePts];
    const maxV = Math.max(...all, 0);
    const minV = Math.min(...all, 0);
    const range = Math.max(1, maxV - minV);
    const W = 100, H = 100; // viewBox units; CSS scales to container
    const toXY = (v, i, n) => {
      const x = n > 1 ? (i / (n - 1)) * W : 0;
      const y = H - ((v - minV) / range) * H;
      return [x, y];
    };
    const toPoly = pts => pts.map((v, i) => toXY(v, i, pts.length).join(',')).join(' ');
    const baseline0 = minV <= 0 && maxV >= 0 ? (H - ((0 - minV) / range) * H) : null;
    const years = pBase.map((_, i) => `Y${i + 1}`);

    // 2026-04-21 PM (Brock feedback): Y-axis needs a title + tick labels so
    // reviewers can read scale without hovering. Compute 3-5 tick values
    // (max, zero-crossing if present, min, and a midpoint on each side of
    // zero where it fits) and render them as HTML outside the SVG — the SVG
    // uses preserveAspectRatio="none" which stretches any embedded <text>.
    const ticks = (() => {
      const out = [{ value: maxV, pct: 0 }];
      if (baseline0 != null) out.push({ value: 0, pct: baseline0 });
      out.push({ value: minV, pct: 100 });
      // Add a midpoint between max and zero (or max and min if no zero crossing)
      const upperMid = baseline0 != null
        ? { value: maxV / 2, pct: baseline0 / 2 }
        : null;
      if (upperMid && upperMid.pct > 8 && upperMid.pct < (baseline0 ?? 92) - 8) {
        out.splice(1, 0, upperMid);
      }
      return out;
    })();

    // Y-axis title: "{Metric Name} ($)" for currency metrics, just label otherwise.
    // All current metrics are currency so we keep "($)" unconditionally but the
    // code supports swapping in percent/other units if future metrics need it.
    const yAxisUnit = '$';
    const yAxisTitle = `${metricDef.label} (${yAxisUnit})`;

    return `
      <div class="cm-whatif-chart">
        <div class="cm-whatif-chart__header">
          <div class="cm-whatif-chart__title">
            <strong>${metricDef.label}</strong> over ${contractYears} years
            <span class="cm-whatif-chart__legend">
              <span class="cm-whatif-chart__swatch cm-whatif-chart__swatch--base"></span>baseline
              <span class="cm-whatif-chart__swatch cm-whatif-chart__swatch--sce" style="margin-left:10px;"></span>scenario
            </span>
          </div>
          <div class="cm-whatif-chart__metric-pills" role="tablist">
            ${Object.entries(METRICS).map(([k, m]) => `
              <button class="cm-whatif-chart__pill${chartMetric === k ? ' is-active' : ''}"
                data-whatif-metric="${k}" title="Chart ${m.label}">${m.label}</button>
            `).join('')}
          </div>
        </div>
        <div class="cm-whatif-chart__plot">
          <div class="cm-whatif-chart__yaxis-title" title="${metricDef.label} on the vertical axis, all values in ${yAxisUnit === '$' ? 'US dollars' : yAxisUnit}">${yAxisTitle}</div>
          <div class="cm-whatif-chart__yaxis-ticks" aria-hidden="true">
            ${ticks.map(t => `<div class="cm-whatif-chart__ytick" style="top:${t.pct.toFixed(1)}%;">${fmt(t.value)}</div>`).join('')}
          </div>
          <div class="cm-whatif-chart__canvas">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${metricDef.label} trajectory baseline vs scenario">
              ${ticks.map(t => `<line x1="0" x2="${W}" y1="${t.pct}" y2="${t.pct}" stroke="${t.value === 0 ? 'var(--ies-gray-300,#d1d5db)' : 'var(--ies-gray-100,#f3f4f6)'}" stroke-dasharray="${t.value === 0 ? '2 2' : '1 2'}" stroke-width="${t.value === 0 ? '0.3' : '0.25'}" vector-effect="non-scaling-stroke"/>`).join('')}
              <polyline points="${toPoly(basePts)}" fill="none" stroke="var(--ies-gray-400,#9ca3af)" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
              <polyline points="${toPoly(scePts)}" fill="none" stroke="var(--ies-blue,#0047AB)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
              ${scePts.map((v, i) => {
                const [x, y] = toXY(v, i, scePts.length);
                return `<circle cx="${x}" cy="${y}" r="1.1" fill="var(--ies-blue,#0047AB)" vector-effect="non-scaling-stroke"><title>Y${i+1}: ${fmt(v)} (baseline ${fmt(basePts[i])})</title></circle>`;
              }).join('')}
            </svg>
          </div>
        </div>
        <div class="cm-whatif-chart__xaxis-wrap">
          <div class="cm-whatif-chart__xaxis-title">Contract Year</div>
          <div class="cm-whatif-chart__xaxis">
            ${years.map(y => `<span>${y}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
  })();

  // Driver-impact horizontal bars — show every active slider with its
  // effect on the CURRENTLY-SELECTED chart metric (NI / EBITDA / Revenue /
  // Free Cash Flow / NPV). Previously filtered at |dNI| ≥ $1K which
  // silently dropped sliders like Discount Rate (moves NPV only), DSO/DPO
  // (move FCF timing), and direct-labor productivity (moves everything,
  // but was dead before today's fix). Now every active slider renders —
  // even a "—" row when the slider doesn't move the selected metric, so
  // the reviewer knows the input landed and can switch metrics to see
  // where the move actually shows up.
  const driverBars = (() => {
    // Map the chart metric to the corresponding delta field on impacts[key]
    const driverMetricMap = {
      netIncome:    { label: 'Net Income',     field: 'dNI',      kind: 'currency' },
      ebitda:       { label: 'EBITDA',         field: 'dEbitda',  kind: 'currency' },
      revenue:      { label: 'Revenue',        field: 'dRevenue', kind: 'currency' },
      freeCashFlow: { label: 'Free Cash Flow', field: 'dCumFcf',  kind: 'currency' },
      npv:          { label: 'NPV',            field: 'dNPV',     kind: 'currency' },
    };
    const dm = driverMetricMap[chartMetric] || driverMetricMap.netIncome;
    const fieldName = dm.field;

    const allActive = Object.entries(impacts)
      .map(([key, v]) => ({ key, ...v, slider: WHATIF_SLIDERS.find(s => s.key === key), delta: v[fieldName] || 0 }))
      .filter(r => r.slider)
      // Sort by |delta on selected metric| desc, then by any other delta so
      // sliders that move OTHER metrics still appear below the primary movers.
      .sort((a, b) => {
        const ad = Math.abs(a.delta), bd = Math.abs(b.delta);
        if (ad !== bd) return bd - ad;
        // Tiebreaker — total abs across all metrics
        const aOther = Math.abs(a.dNPV || 0) + Math.abs(a.dEbitda || 0) + Math.abs(a.dCumFcf || 0);
        const bOther = Math.abs(b.dNPV || 0) + Math.abs(b.dEbitda || 0) + Math.abs(b.dCumFcf || 0);
        return bOther - aOther;
      });

    if (allActive.length === 0) {
      return `<div class="cm-whatif-drivers-empty">
         <em>Move any slider in the Drivers panel to see which drivers contribute most to the scenario delta.</em>
       </div>`;
    }

    // Threshold: $100 (not $1K). At $100 we're below the visual noise floor
    // but still separate real movement from numerical-precision wiggle.
    const MIN_DELTA = 100;
    const maxAbs = Math.max(...allActive.map(r => Math.abs(r.delta) || 0), 1);

    return `
      <div class="cm-whatif-drivers">
        <div class="cm-whatif-drivers__hint">
          Isolated contribution to <strong>${dm.label}</strong> — each bar shows what that one slider would move on its own. Switch the chart metric above to re-attribute against another metric. Sliders marked "—" don't move the selected metric but may move others.
        </div>
        <div class="cm-whatif-drivers__rows">
          ${allActive.map(r => {
            const absDelta = Math.abs(r.delta);
            if (absDelta < MIN_DELTA) {
              // Slider is active but doesn't meaningfully move the selected
              // metric. Show a muted row + a hint about where it DID move
              // (if anywhere) so the reviewer can switch metrics.
              const movedOn = [];
              if (Math.abs(r.dNPV)      > MIN_DELTA && fieldName !== 'dNPV')      movedOn.push('NPV');
              if (Math.abs(r.dCumFcf)   > MIN_DELTA && fieldName !== 'dCumFcf')   movedOn.push('FCF');
              if (Math.abs(r.dEbitda)   > MIN_DELTA && fieldName !== 'dEbitda')   movedOn.push('EBITDA');
              if (Math.abs(r.dRevenue)  > MIN_DELTA && fieldName !== 'dRevenue')  movedOn.push('Revenue');
              if (Math.abs(r.dNI)       > MIN_DELTA && fieldName !== 'dNI')       movedOn.push('NI');
              const crossHint = movedOn.length
                ? `<span class="cm-whatif-drivers__crosshint" title="This slider doesn't move ${dm.label} but does move the metrics listed. Switch the chart metric above to see the effect.">moves ${movedOn.join(' · ')}</span>`
                : `<span class="cm-whatif-drivers__crosshint cm-whatif-drivers__crosshint--none" title="Slider is active but below the $100 materiality threshold on every metric.">no measurable effect</span>`;
              return `
                <div class="cm-whatif-drivers__row cm-whatif-drivers__row--muted">
                  <div class="cm-whatif-drivers__label">${r.slider.label}</div>
                  <div class="cm-whatif-drivers__bar-track"></div>
                  <div class="cm-whatif-drivers__value cm-whatif-drivers__value--muted">— ${crossHint}</div>
                </div>
              `;
            }
            const pct = maxAbs > 0 ? absDelta / maxAbs * 100 : 0;
            const isPos = r.delta > 0;
            const color = isPos ? '#16a34a' : '#dc2626';
            const sign = isPos ? '+' : '−';
            return `
              <div class="cm-whatif-drivers__row">
                <div class="cm-whatif-drivers__label">${r.slider.label}</div>
                <div class="cm-whatif-drivers__bar-track">
                  <div class="cm-whatif-drivers__bar${isPos ? ' is-pos' : ' is-neg'}" style="width:${pct.toFixed(1)}%;background:${color};"></div>
                </div>
                <div class="cm-whatif-drivers__value" style="color:${color};">${sign}${fmtShort(absDelta)}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  })();

  return `
    <div class="cm-wide-layout">
      <div class="cm-section-header">
        <div>
          <h2 style="margin:0;">What-If Studio
            ${activeCount > 0
              ? `<span class="hub-chip hub-chip--info" style="margin-left:8px;">${activeCount} live override${activeCount === 1 ? '' : 's'}</span>`
              : '<span class="hub-chip" style="margin-left:8px;">baseline</span>'}
          </h2>
          <p class="cm-subtle" style="margin:4px 0 0;">Drag sliders to preview how heuristic changes move the deal. Changes are <strong>transient</strong> — click Apply to commit as per-scenario overrides, or Reset to discard.</p>
        </div>
      </div>

      <div class="cm-whatif-layout">
        <!-- DRIVERS (left) -->
        <div class="hub-card cm-whatif-drivers-card">
          <div class="cm-whatif-drivers-card__header">
            <span class="cm-whatif-drivers-card__title">Drivers</span>
            <span class="cm-whatif-drivers-card__count">${WHATIF_SLIDERS.length} levers · ${activeCount} active</span>
          </div>
          ${Array.from(groups.entries()).map(([group, items]) => `
            <div class="cm-whatif-group">
              <div class="cm-whatif-group__title">${group}</div>
              ${items.map(sliderRow).join('')}
            </div>
          `).join('')}
          <div class="cm-whatif-actions">
            <button class="hub-btn" data-cm-action="whatif-reset" ${activeCount === 0 ? 'disabled' : ''}>Reset</button>
            <button class="hub-btn hub-btn-primary" data-cm-action="whatif-apply" ${activeCount === 0 ? 'disabled' : ''}>Apply as overrides</button>
          </div>
        </div>

        <!-- PREVIEW (right) -->
        <div class="cm-whatif-preview-pane">
          ${preview ? `
            <!-- 3-col KPI: Baseline | Scenario | Δ -->
            <div class="hub-card cm-whatif-preview-card">
              <div class="cm-whatif-preview-card__header">
                <span class="cm-whatif-preview-card__title">Live Preview</span>
                <span class="cm-whatif-preview-card__sub">Totals over ${contractYears}-year horizon</span>
              </div>
              <table class="cm-whatif-kpi-table">
                <thead>
                  <tr>
                    <th></th>
                    <th class="hub-num">Baseline</th>
                    <th class="hub-num">Scenario</th>
                    <th class="hub-num">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  ${kpiRow('Total Revenue', preview.totalRev, baseline?.totalRev, { positiveIsGood: true })}
                  ${kpiRow('Total Opex', preview.totalOpex, baseline?.totalOpex, { positiveIsGood: false })}
                  ${kpiRow('EBITDA', preview.totalEbitda, baseline?.totalEbitda, { positiveIsGood: true })}
                  ${kpiRow('EBITDA Margin', preview.ebitdaMargin, baseline?.ebitdaMargin, { positiveIsGood: true, formatter: pctFmt })}
                  ${kpiRow('Net Income', preview.totalNI, baseline?.totalNI, { positiveIsGood: true })}
                  ${kpiRow('NPV', preview.npv, baseline?.npv, { positiveIsGood: true })}
                  ${kpiRow('Cum FCF', preview.cumFcf, baseline?.cumFcf, { positiveIsGood: true })}
                </tbody>
              </table>
            </div>

            <!-- Multi-year trajectory -->
            <div class="hub-card cm-whatif-preview-card">
              ${trajectoryChart}
            </div>

            <!-- Driver impact bars -->
            <div class="hub-card cm-whatif-preview-card">
              <div class="cm-whatif-preview-card__header">
                <span class="cm-whatif-preview-card__title">Driver Impact</span>
                <span class="cm-whatif-preview-card__sub">What's moving the deal</span>
              </div>
              ${driverBars}
            </div>
          ` : `
            <div class="hub-card">
              <div style="text-align:center;padding:40px;color:var(--ies-gray-400);">
                <em>No preview available — populate Labor + Pricing sections first.</em>
              </div>
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}
// ============================================================
// LINKED DESIGNS — reverse-direction linkage from CM to design tools
// ============================================================

// Module-local cache for this render; async load kicks off on section enter.
let linkedDesigns = null; // { wsc:[], cog:[], netopt:[], fleet:[] }
let _linkedDesignsLoadInFlight = false;

// Local escape helper (CM ui.js has no shared escapeHtml import)
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Singular, title-cased label for a volume-line UOM. Used by Summary / Pricing
 * tiles that read "Cost / {UOM}" — the label needs to flip when the user
 * changes the outbound-primary star on Volumes & Profile.
 * @param {string|undefined|null} uom
 * @returns {string}
 */
function formatUomSingular(uom) {
  const raw = String(uom || '').toLowerCase().trim();
  if (!raw) return 'Order';
  // Exact matches (plurals + common variants)
  const map = {
    'order': 'Order', 'orders': 'Order',
    'each': 'Each', 'eaches': 'Each', 'unit': 'Unit', 'units': 'Unit',
    'case': 'Case', 'cases': 'Case',
    'pallet': 'Pallet', 'pallets': 'Pallet',
    'carton': 'Carton', 'cartons': 'Carton',
    'line': 'Line', 'lines': 'Line',
    'pick': 'Pick', 'picks': 'Pick',
    'sku': 'SKU', 'skus': 'SKU',
    'hour': 'Hour', 'hours': 'Hour',
    'trailer': 'Trailer', 'trailers': 'Trailer',
    'shipment': 'Shipment', 'shipments': 'Shipment',
  };
  if (map[raw]) return map[raw];
  // Fallback: strip trailing 's', title-case
  const singular = raw.endsWith('s') ? raw.slice(0, -1) : raw;
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

async function ensureLinkedDesignsLoaded() {
  if (!model?.id) return;
  if (linkedDesigns !== null) return;
  if (_linkedDesignsLoadInFlight) return;
  _linkedDesignsLoadInFlight = true;
  try {
    linkedDesigns = await api.listLinkedDesignScenarios(model.id);
  } catch (err) {
    console.warn('[CM] linked-designs load failed:', err);
    linkedDesigns = { wsc: [], cog: [], netopt: [], fleet: [] };
  } finally {
    _linkedDesignsLoadInFlight = false;
  }
}

function renderLinkedDesigns() {
  if (!model?.id) {
    return `
      <div class="cm-section-header">
        <div>
          <div class="cm-section-title">Linked Designs</div>
          <div class="cm-section-desc">Save this model before linking design scenarios.</div>
        </div>
      </div>`;
  }
  if (linkedDesigns === null) {
    ensureLinkedDesignsLoaded().then(() => renderSection());
    return `
      <div class="cm-section-header">
        <div>
          <div class="cm-section-title">Linked Designs</div>
          <div class="cm-section-desc">Loading linked design scenarios…</div>
        </div>
      </div>`;
  }
  const groups = [
    { key: 'wsc',    label: 'Warehouse Sizing',   icon: '🏭', route: 'designtools/warehouse-sizing' },
    { key: 'cog',    label: 'Center of Gravity',  icon: '📍', route: 'designtools/center-of-gravity' },
    { key: 'netopt', label: 'Network Optimizer',  icon: '🕸',  route: 'designtools/network-opt' },
    { key: 'fleet',  label: 'Fleet Modeler',      icon: '🚚', route: 'designtools/fleet-modeler' },
  ];
  const totalLinked = groups.reduce((s, g) => s + (linkedDesigns[g.key] || []).length, 0);

  return `
    <div class="cm-section-header">
      <div>
        <div class="cm-section-title">Linked Designs</div>
        <div class="cm-section-desc">Design scenarios pointing back at this Cost Model via <code>parent_cost_model_id</code>. Click a row to open the scenario in its tool.</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="hub-badge hub-badge-info">${totalLinked} linked</span>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="linked-refresh" title="Re-query linked scenarios">Refresh</button>
      </div>
    </div>

    ${totalLinked === 0 ? `
      <div class="hub-card" style="padding:24px;text-align:center;color:var(--ies-gray-500);font-size:13px;">
        No design scenarios linked to this Cost Model yet.<br>
        Open a design tool (WSC / COG / NetOpt / Fleet), save a scenario, and select this Cost Model as its parent.
      </div>
    ` : groups.map(g => {
      const rows = linkedDesigns[g.key] || [];
      if (rows.length === 0) return '';
      return `
        <div class="hub-card mt-4">
          <div class="text-subtitle mb-2">${g.icon} ${g.label} <span style="color:var(--ies-gray-400);font-weight:500;font-size:11px;">(${rows.length})</span></div>
          <table class="cm-grid-table" style="font-size:13px;">
            <thead>
              <tr><th>Scenario</th><th style="width:160px;">Last Updated</th><th style="width:90px;text-align:right;">Action</th></tr>
            </thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td style="font-weight:600;">${_esc(r.name)}</td>
                  <td style="color:var(--ies-gray-500);">${r.updated ? new Date(r.updated).toLocaleString() : '—'}</td>
                  <td style="text-align:right;"><a class="hub-btn hub-btn-sm hub-btn-secondary" href="#${g.route}?scenario=${encodeURIComponent(r.id)}" title="Open in ${g.label}" style="font-size:11px;padding:3px 8px;">Open →</a></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }).filter(Boolean).join('')}
  `;
}

// ============================================================
// PHASE 4e — SENSITIVITY (MONTE CARLO) CARD
// ============================================================

/**
 * Render the Monte-Carlo labor-cost sensitivity card for Summary.
 * Runs 1000 trials against the active labor lines + calcHeur. Only
 * renders when at least one labor line has performance_variance_pct > 0.
 * Uses a seeded RNG so repeated renders are stable within a session.
 */
function renderSensitivityCard() {
  const lines = model?.laborLines || [];
  const withVar = lines.filter(l => Number(l.performance_variance_pct) > 0);
  if (withVar.length === 0 || !_lastCalcHeuristics) return '';
  // Seed from a hash of the current labor config so the output is stable
  // until inputs change. Stakeholder-friendly.
  const seedStr = JSON.stringify(lines.map(l => [l.id, l.hourly_rate, l.annual_hours, l.performance_variance_pct, l.employment_type]));
  let seed = 1;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rng = scenarios.mulberry32(seed);
  const result = scenarios.simulateLaborVariance(lines, _lastCalcHeuristics, currentMarketLaborProfile, 1000, rng);
  if (!result || result.nTrials === 0) return '';

  const fmt = n => (n == null ? '—' : (
    Math.abs(n) >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' :
    Math.abs(n) >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' :
    '$' + n.toFixed(0)
  ));
  const band = result.p90 - result.p10;
  const bandPct = result.p50 !== 0 ? (band / result.p50 * 100) : 0;

  return `
    <div class="hub-card mb-4" style="border-left:4px solid #7c3aed;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div>
          <div style="font-size:14px;font-weight:700;">Labor Cost Sensitivity</div>
          <div style="font-size:11px;color:var(--ies-gray-500);">${result.nTrials.toLocaleString()} Monte-Carlo trials · ${withVar.length} of ${lines.length} lines have variance set</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:var(--ies-gray-500);">80% band width</div>
          <div style="font-size:14px;font-weight:700;">${fmt(band)} (${bandPct.toFixed(1)}%)</div>
        </div>
      </div>
      <div class="hub-kpi-bar" style="grid-template-columns:repeat(4, 1fr);">
        <div class="hub-kpi-item">
          <div class="hub-kpi-label" style="color:#059669;">P10 (optimistic)</div>
          <div class="hub-kpi-value">${fmt(result.p10)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label">P50 (median)</div>
          <div class="hub-kpi-value">${fmt(result.p50)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label" style="color:#dc2626;">P90 (pessimistic)</div>
          <div class="hub-kpi-value">${fmt(result.p90)}</div>
        </div>
        <div class="hub-kpi-item">
          <div class="hub-kpi-label">StdDev</div>
          <div class="hub-kpi-value">${fmt(result.stddev)}</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--ies-gray-500);">
        Each trial draws an independent Gaussian productivity shock per labor line. Positive shock = more productive → fewer hours. Set <strong>performance_variance_pct</strong> per line in the Labor section to tune.
      </div>
    </div>
  `;
}

// ============================================================
// PHASE 5a — SCENARIO XLSX EXPORT
// ============================================================

/**
 * Build the multi-sheet xlsx payload for the active scenario.
 * Pure function returning the sheet configuration; caller invokes
 * downloadXLSX. Kept here (not in calc.*) because it pulls from
 * module-local state (model, currentScenario, heuristics, etc.).
 *
 * @returns {{ filename: string, sheets: any[] }}
 */
function buildScenarioExportPayload() {
  const scen = currentScenario;
  const snaps = currentScenarioSnapshots;
  const isFrozen = !!(scen && scen.status === 'approved' && snaps);
  const bundle = _lastMonthlyBundle;
  const calcHeur = _lastCalcHeuristics;
  const proj = model?.projectDetails || {};
  const fin = model?.financial || {};
  const nameSlug = (proj.name || 'cost_model')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const today = new Date().toISOString().slice(0, 10);
  const filename = `cm_${nameSlug}_${scen?.scenario_label || 'draft'}_${today}.xlsx`.replace(/\s+/g, '_');

  // ----- Sheet 1: Overview -----
  const overviewRows = [
    { Field: 'Project Name',        Value: proj.name || '' },
    { Field: 'Client',              Value: proj.clientName || '' },
    { Field: 'Market',              Value: (refData.markets || []).find(m => m.id === proj.market)?.name || proj.market || '' },
    { Field: 'Environment',         Value: proj.environment || '' },
    { Field: 'Contract Term (yrs)', Value: proj.contractTerm || 5 },
    { Field: '',                    Value: '' },
    { Field: 'Scenario ID',         Value: scen?.id ?? '' },
    { Field: 'Scenario Label',      Value: scen?.scenario_label || 'draft' },
    { Field: 'Scenario Status',     Value: scen?.status || 'draft' },
    { Field: 'Is Baseline',         Value: scen?.is_baseline ? 'Yes' : 'No' },
    { Field: 'Parent Scenario ID',  Value: scen?.parent_scenario_id ?? '' },
    { Field: 'Approved At',         Value: scen?.approved_at || '' },
    { Field: 'Approved By',         Value: scen?.approved_by || '' },
    { Field: '',                    Value: '' },
    { Field: 'Reading Frozen Rates?', Value: isFrozen ? 'YES — ref_* snapshots' : 'No — live rate cards' },
    { Field: 'Exported At',         Value: new Date().toISOString() },
    { Field: 'Exported By',         Value: (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ies_user_email') : '') || '(anonymous)' },
  ];

  // ----- Sheet 2: KPI snapshot -----
  const kpiRows = [];
  if (bundle && Array.isArray(bundle.cashflow)) {
    const totalRev = bundle.cashflow.reduce((s, r) => s + (r.revenue || 0), 0);
    const totalOpex = bundle.cashflow.reduce((s, r) => s + (r.opex || 0), 0);
    const totalEbitda = bundle.cashflow.reduce((s, r) => s + (r.ebitda || 0), 0);
    const totalNI = bundle.cashflow.reduce((s, r) => s + (r.net_income || 0), 0);
    const totalCapex = bundle.cashflow.reduce((s, r) => s + (r.capex || 0), 0);
    const lastCFCF = bundle.cashflow.length > 0
      ? bundle.cashflow.reduce((_, r) => r.cumulative_cash_flow, 0)
      : 0;
    kpiRows.push({ Metric: 'Total Revenue',        Value: totalRev },
                 { Metric: 'Total Opex',           Value: totalOpex },
                 { Metric: 'Total EBITDA',         Value: totalEbitda },
                 { Metric: 'Total Net Income',     Value: totalNI },
                 { Metric: 'Total Capex',          Value: totalCapex },
                 { Metric: 'Ending Cumulative FCF', Value: lastCFCF },
                 { Metric: 'EBITDA Margin',        Value: totalRev > 0 ? (totalEbitda / totalRev * 100) : 0 });
  }

  // ----- Sheet 3: Monthly P&L (flat wide view) -----
  const monthlyRows = [];
  if (bundle && Array.isArray(bundle.cashflow)) {
    const periodById = new Map((bundle.periods || []).map(p => [p.id, p]));
    const revByPeriod = new Map(); const expByPeriod = new Map();
    for (const r of (bundle.revenue || [])) {
      if (!revByPeriod.has(r.period_id)) revByPeriod.set(r.period_id, 0);
      revByPeriod.set(r.period_id, revByPeriod.get(r.period_id) + (r.amount || 0));
    }
    for (const e of (bundle.expense || [])) {
      if (!expByPeriod.has(e.period_id)) expByPeriod.set(e.period_id, {});
      const m = expByPeriod.get(e.period_id);
      m[e.expense_line_code] = (m[e.expense_line_code] || 0) + (e.amount || 0);
    }
    for (const cf of bundle.cashflow) {
      const p = periodById.get(cf.period_id);
      const exp = expByPeriod.get(cf.period_id) || {};
      monthlyRows.push({
        Period:        p?.label || '',
        CalYear:       p?.calendar_year || '',
        CalMonth:      p?.calendar_month || '',
        PreGoLive:     p?.is_pre_go_live ? 'Yes' : 'No',
        Revenue:       cf.revenue || 0,
        LaborHourly:   exp.LABOR_HOURLY || 0,
        Facility:      exp.FACILITY || 0,
        Equipment:     exp.EQUIPMENT_LEASE || 0,
        Overhead:      exp.OVERHEAD || 0,
        VAS:           exp.VAS || 0,
        StartupAmort:  exp.STARTUP_AMORT || 0,
        Depreciation:  exp.DEPRECIATION || 0,
        Opex:          cf.opex || 0,
        GrossProfit:   cf.gross_profit || 0,
        EBITDA:        cf.ebitda || 0,
        EBIT:          cf.ebit || 0,
        Taxes:         cf.taxes || 0,
        NetIncome:     cf.net_income || 0,
        Capex:         cf.capex || 0,
        WC_Delta:      cf.working_capital_change || 0,
        OperatingCF:   cf.operating_cash_flow || 0,
        FreeCashFlow:  cf.free_cash_flow || 0,
        CumFCF:        cf.cumulative_cash_flow || 0,
      });
    }
  }

  // ----- Sheet 4: Labor Lines (per-line detail incl. Phase 4 profile) -----
  const fmt12 = (arr) => Array.isArray(arr) && arr.length === 12
    ? arr.map(v => (Number(v) * 100).toFixed(1)).join(', ')
    : '';
  const laborRows = (model?.laborLines || []).map((l, i) => ({
    '#':              i + 1,
    Activity:         l.activity_name || '',
    Volume:           l.volume || 0,
    BaseUPH:          l.base_uph || 0,
    AnnualHours:      l.annual_hours || 0,
    Rate:             l.hourly_rate || 0,
    Burden:           l.burden_pct || 0,
    Employment:       l.employment_type || 'permanent',
    TempMarkup:       l.temp_agency_markup_pct || 0,
    OT_Profile_Pct:   fmt12(l.monthly_overtime_profile),
    Absence_Profile_Pct: fmt12(l.monthly_absence_profile),
    MOST_Template:    l.most_template_name || '',
  }));

  // ----- Sheet 5: Assumptions (heuristics with Used From source) -----
  const assumptionRows = (heuristicsCatalog || []).map(h => {
    const eff = scenarios.heuristicEffective(h, heuristicOverrides);
    let usedFrom = 'default';
    if (isFrozen && Array.isArray(snaps?.heuristics)) {
      const snap = snaps.heuristics.find(s => s.key === h.key);
      if (snap) usedFrom = 'snapshot';
    } else if (heuristicOverrides && Object.prototype.hasOwnProperty.call(heuristicOverrides, h.key)
              && heuristicOverrides[h.key] !== '' && heuristicOverrides[h.key] !== null) {
      usedFrom = 'override';
    }
    return {
      Category:   HEURISTIC_CATEGORY_LABELS[h.category] || h.category,
      Key:        h.key,
      Label:      h.label,
      Default:    h.default_value ?? h.default_enum ?? '',
      Effective:  eff ?? '',
      UsedFrom:   usedFrom,
      Unit:       h.unit || '',
      Description: h.description || '',
    };
  });

  // ----- Sheet 6: Rate Snapshots (only when frozen) -----
  const snapshotRows = [];
  if (isFrozen) {
    for (const [cardType, rows] of Object.entries(snaps || {})) {
      for (const r of rows) {
        snapshotRows.push({
          CardType:    cardType,
          CardID:      r._rate_card_id || r.id || '',
          VersionHash: r._version_hash || '',
          CapturedAt:  r._captured_at || '',
          Name:        r.role_name || r.building_type || r.category || r.name || r.key || '',
          Rate:        r.hourly_rate || r.lease_rate_psf_yr || r.monthly_cost || r.purchase_cost || r.default_value || '',
          Notes:       r.notes || r.label || '',
        });
      }
    }
  }

  // ----- Sheet 7: Revisions -----
  const revisionRows = (currentRevisions || []).map(r => ({
    RevisionNumber: r.revision_number,
    ChangedAt:      r.changed_at,
    ChangedBy:      r.changed_by || '',
    Summary:        r.change_summary || '',
  }));

  return {
    filename,
    sheets: [
      { name: 'Overview',    rows: overviewRows,    columns: [
        { key: 'Field', label: 'Field' },
        { key: 'Value', label: 'Value' },
      ] },
      { name: 'KPIs',        rows: kpiRows, columns: [
        { key: 'Metric', label: 'Metric' },
        { key: 'Value',  label: 'Value', format: 'number', decimals: 0 },
      ] },
      { name: 'Monthly P&L', rows: monthlyRows },
      { name: 'Labor',       rows: laborRows },
      { name: 'Assumptions', rows: assumptionRows },
      { name: 'Snapshots',   rows: snapshotRows.length ? snapshotRows : [{ Note: 'No snapshots — scenario is not approved.' }] },
      { name: 'Revisions',   rows: revisionRows.length ? revisionRows : [{ Note: 'No revisions logged.' }] },
    ],
  };
}

/**
 * Export the active scenario as xlsx. Triggered from the Summary
 * "Export Scenario" button.
 */
async function exportScenarioToXlsx() {
  // Ensure heuristics + scenarios are loaded so export is complete
  await ensureHeuristicsLoaded();
  await ensureScenariosLoaded();
  const payload = buildScenarioExportPayload();
  if (!payload.sheets.some(s => (s.rows || []).length > 0)) {
    showToast('Nothing to export yet — open the Summary section first to build the monthly bundle.', 'warning');
    return;
  }
  try {
    downloadXLSX(payload);
    // Audit-log the export (fire-and-forget)
    if (currentScenario?.id) {
      try {
        const { recordAudit } = await import('../../shared/audit.js?v=20260423-y7');
        recordAudit({
          table: 'cost_model_scenarios',
          id: currentScenario.id,
          action: 'update',
          fields: { exported_at: new Date().toISOString(), format: 'xlsx' },
        }).catch(() => {});
      } catch (_) { /* ignore */ }
    }
  } catch (err) {
    console.error('[CM] export failed:', err);
    showToast('Export failed: ' + (err?.message || err), 'error');
  }
}

function shouldRerender(field) {
  return field.includes('shifts.') || field.includes('facility.') ||
         field === 'projectDetails.market' || field === 'projectDetails.contractTerm' ||
         field === 'financial.targetMargin' ||
         // M1 (2026-04-21): G&A / Mgmt Fee edits drive the derived total and
         // the Pricing Schedule gross-up; both fields trigger re-render.
         field === 'financial.gaMargin' || field === 'financial.mgmtFeeMargin' ||
         // M2 (2026-04-21): SG&A overlay affects Summary/P&L but not Pricing Schedule
         // cost rollup, so re-render is cheap + desirable for live preview.
         field === 'financial.sgaOverlayPct' ||
         // Contract type changes Pricing Schedule subtitle + banner +
         // un/reveals the Split-Month controls block on Financial section.
         field === 'projectDetails.contractType' ||
         // Split-Month billing fields — drive the weighted-DSO readout + engine
         field === 'projectDetails.splitBillingFixedPct' ||
         field === 'projectDetails.splitBillingFixedDsoDays' ||
         field === 'projectDetails.splitBillingVariableDsoDays' ||
         // M5 (2026-04-21): tax rate change re-renders P&L numbers in Summary
         field === 'projectDetails.taxRate' ||
         // I-01: reassigning a line's bucket shifts the rollup; Pricing tables must re-render.
         field === 'pricing_bucket';
}

/**
 * M1 (2026-04-21): whenever gaMargin or mgmtFeeMargin changes, recompute the
 * derived `financial.targetMargin` so every downstream consumer keeps working
 * without needing to know about the split. Called from the generic data-field
 * input handler.
 */
function syncDerivedTargetMargin() {
  const f = model.financial;
  if (!f) return;
  const ga = Number(f.gaMargin) || 0;
  const mgmt = Number(f.mgmtFeeMargin) || 0;
  f.targetMargin = Number((ga + mgmt).toFixed(2));
}

// ============================================================
// SPLIT-MONTH BILLING (2026-04-21)
// ============================================================
/**
 * When contract_type is 'split_month', the customer is invoiced in two cycles
 * per month (fixed monthly management fee early + variable transaction fee in
 * arrears). Each stream carries its own DSO; the engine sees a single
 * weighted-average DSO on the revenue side. This helper post-processes
 * calcHeur to inject that weighted DSO in place of the flat `dsoDays`.
 *
 * For other contract types, calcHeur is returned unchanged.
 *
 * @param {Object} calcHeur — output of scenarios.resolveCalcHeuristics
 * @param {Object} cmModel  — the current cost model (we read contract_type + split fields)
 * @returns {Object} calcHeur, either unchanged or with `dsoDays` overridden
 */
function applySplitMonthBilling(calcHeur, cmModel) {
  if (!calcHeur || !cmModel) return calcHeur;
  if (cmModel.projectDetails?.contractType !== 'split_month') return calcHeur;
  const fixedPct = Math.max(0, Math.min(100, Number(cmModel.projectDetails?.splitBillingFixedPct ?? 40))) / 100;
  const fixedDso = Math.max(0, Number(cmModel.projectDetails?.splitBillingFixedDsoDays ?? 15));
  const varDso   = Math.max(0, Number(cmModel.projectDetails?.splitBillingVariableDsoDays ?? 45));
  const weightedDso = fixedPct * fixedDso + (1 - fixedPct) * varDso;
  return {
    ...calcHeur,
    dsoDays: weightedDso,
    _splitMonthApplied: { fixedPct: fixedPct * 100, fixedDso, varDso, weightedDso },
  };
}

// ============================================================
// OVERRIDE AUDIT TRAIL (2026-04-21)
// ============================================================
// Every override mutation (rate set, rate cleared, reason changed) is
// written to public.audit_log via the shared recordAudit helper. Fires
// are best-effort — a flaky network must never block the pricing edit.
// Action values used:
//   - 'price-override'        — user set or changed a rate override
//   - 'price-override-reset'  — user cleared an override (via ↺ Reset)
//   - 'price-override-reason' — user changed the reason on an override
// Rows are keyed by (entity_table='cost_model_projects', entity_id=project id)
// so they group under the project in the Admin → Audit Log viewer.
/**
 * @param {{
 *   action: 'price-override'|'price-override-reset'|'price-override-reason',
 *   bucket: { id: string, name: string, type?: string, uom?: string },
 *   oldRate?: number|null, newRate?: number|null,
 *   recommendedRate?: number|null,
 *   oldReason?: string|null, newReason?: string|null,
 * }} ev
 */
function writeOverrideAuditEvent(ev) {
  if (!model?.id) return; // unsaved projects can't anchor an audit row
  if (!ev || !ev.bucket?.id) return;
  const toNum = v => v == null || v === '' ? null : Number(v);
  const oldR = toNum(ev.oldRate);
  const newR = toNum(ev.newRate);
  const rec  = toNum(ev.recommendedRate);
  const variancePct =
    rec != null && rec > 0 && newR != null
      ? (newR - rec) / rec
      : null;
  const fields = {
    bucket_id:        ev.bucket.id,
    bucket_name:      ev.bucket.name || '',
    bucket_type:      ev.bucket.type || null,
    uom:              ev.bucket.uom || null,
    old_rate:         oldR,
    new_rate:         newR,
    recommended_rate: rec,
    variance_pct:     variancePct,
    old_reason:       ev.oldReason || null,
    new_reason:       ev.newReason || null,
    delta_abs:        (oldR != null && newR != null) ? (newR - oldR) : null,
  };
  import('../../shared/audit.js?v=20260423-y7').then(mod => {
    mod.recordAudit({
      table:  'cost_model_projects',
      id:     model.id,
      action: ev.action,
      fields,
    }).catch(() => {});
  }).catch(() => {});
}

// ============================================================
// ACTIONS (add/delete rows)
// ============================================================

function handleAction(action, idx, btn) {
  switch (action) {
    case 'linked-refresh':
      // Force re-query of parent_cost_model_id across design-tool tables.
      linkedDesigns = null;
      ensureLinkedDesignsLoaded().then(() => renderSection());
      return;
    case 'add-volume':
      model.volumeLines.push({ name: '', volume: 0, uom: 'each', isOutboundPrimary: false });
      break;
    case 'delete-volume':
      model.volumeLines.splice(idx, 1);
      break;
    case 'add-labor':
      model.laborLines.push({ activity_name: '', volume: 0, base_uph: 0, annual_hours: 0, hourly_rate: 0, burden_pct: 30, employment_type: 'permanent', temp_agency_markup_pct: 0, performance_variance_pct: 0, pricing_bucket: defaultBucketFor('labor') });
      // v2 UI — select the newly added line so the detail pane opens to it
      _selectedLaborIdx = model.laborLines.length - 1;
      break;
    case 'delete-labor':
      model.laborLines.splice(idx, 1);
      // v2 UI — keep selected idx valid after removal
      if (_selectedLaborIdx !== null) {
        if (model.laborLines.length === 0) _selectedLaborIdx = null;
        else if (_selectedLaborIdx >= model.laborLines.length) _selectedLaborIdx = model.laborLines.length - 1;
      }
      break;
    // CM-IMPL-1 (2026-04-26) — Implementation phase / ramp actions
    case 'impl-add-phase': {
      if (!model.implementationTimeline) model.implementationTimeline = createEmptyModel().implementationTimeline;
      const phs = model.implementationTimeline.phases = model.implementationTimeline.phases || [];
      const lastEnd = phs.reduce((mx, p) => Math.max(mx, (p.startWeek || 0) + (p.durationWeeks || 0)), 0);
      phs.push({ id: `phase_${Date.now()}`, name: 'New Phase', startWeek: lastEnd, durationWeeks: 4, owner: '', color: '#64748b' });
      break;
    }
    case 'impl-delete-phase':
      if (model.implementationTimeline && Array.isArray(model.implementationTimeline.phases)) {
        model.implementationTimeline.phases.splice(idx, 1);
      }
      break;
    case 'impl-resize-ramps': {
      const it = model.implementationTimeline;
      if (!it) return;
      const target_n = Math.max(1, Math.min(24, Number(it.rampMonths) || 6));
      const reshape = (arr) => {
        const cur = (arr || []).map(v => Number(v) || 0);
        if (cur.length === target_n) return cur;
        if (cur.length === 0) return Array(target_n).fill(0).map((_, i) => Math.round(40 + (60 * (i + 1) / target_n)));
        const out = [];
        for (let i = 0; i < target_n; i++) {
          const srcIdx = (i / Math.max(1, target_n - 1)) * (cur.length - 1);
          const lo = Math.floor(srcIdx), hi = Math.ceil(srcIdx);
          const f = srcIdx - lo;
          out.push(Math.round(cur[lo] * (1 - f) + cur[hi] * f));
        }
        return out;
      };
      it.volumeRamp = reshape(it.volumeRamp);
      it.headcountRamp = reshape(it.headcountRamp);
      showToast(`Ramp curves resized to ${target_n} months.`, 'success');
      break;
    }
    case 'impl-reset-defaults':
      model.implementationTimeline = createEmptyModel().implementationTimeline;
      showToast('Implementation Timeline reset to defaults.', 'success');
      break;
    case 'add-indirect':
      model.indirectLaborLines.push({ role_name: '', headcount: 0, hourly_rate: 0, burden_pct: 30, pricing_bucket: defaultBucketFor('indirect') });
      break;
    case 'delete-indirect':
      model.indirectLaborLines.splice(idx, 1);
      break;
    case 'auto-gen-indirect': {
      // Phase 6 — pull span-of-control from the planning ratios catalog
      // when the flag is on and we have a loaded catalog. Otherwise calc
      // falls back to its legacy hardcoded divisors.
      const prMap = (isPlanningRatiosFlagOn() && planningRatiosCatalog.length)
        ? planningRatios.resolvePlanningRatios(planningRatiosCatalog, planningRatioOverrides, {
            vertical: (model.projectDetails && model.projectDetails.vertical) || null,
            environment_type: (model.projectDetails && model.projectDetails.environment) || null,
          })
        : null;
      const _priorIndirectCount = (model.indirectLaborLines || []).length;
      model.indirectLaborLines = calc.autoGenerateIndirectLabor(model, { planningRatiosMap: prMap });
      // I-01 — auto-gen paths also need default bucket assignment
      model.indirectLaborLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('indirect'); });
      showToast(
        _priorIndirectCount > 0
          ? `Regenerated Indirect Labor — replaced ${_priorIndirectCount} rows with ${model.indirectLaborLines.length} new.`
          : `Auto-generated ${model.indirectLaborLines.length} Indirect Labor rows.`,
        'success',
      );
      break;
    }
    case 'add-equipment':
      // Phase 2a (2026-04-22): new blank rows default to owned_mhe since the
      // default category is 'MHE'. Users re-classify via the Line Type column.
      model.equipmentLines.push({ equipment_name: '', category: 'MHE', line_type: 'owned_mhe', quantity: 1, acquisition_type: 'lease', monthly_cost: 0, acquisition_cost: 0, monthly_maintenance: 0, amort_years: 5, pricing_bucket: defaultBucketFor('equipment') });
      break;
    case 'seasonality-reset': {
      // Brock 2026-04-22 PM — resets the seasonality profile to flat 1/12.
      // Useful when a user loaded a preset and wants to start over.
      model.seasonalityProfile = { preset: 'flat', monthly_shares: new Array(12).fill(1/12) };
      isDirty = true;
      renderSection();
      showToast('Seasonality reset to flat (1/12 per month)', 'info');
      return;
    }
    case 'delete-equipment':
      model.equipmentLines.splice(idx, 1);
      break;
    case 'auto-gen-equipment': {
      // Brock 2026-04-20 — pass MLV so MHE counts use shift-math, not
      // the 1-per-3-total-FTE heuristic that over-sizes 3-shift ops.
      // Falls back cleanly when labor lines don't have mhe_type.
      const mlvForAutoGen = _tryComputeMlvForEquipment();
      const _priorEqCount = (model.equipmentLines || []).length;
      model.equipmentLines = calc.autoGenerateEquipment(model, { mlv: mlvForAutoGen });
      model.equipmentLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('equipment'); });
      showToast(
        _priorEqCount > 0
          ? `Regenerated Equipment — replaced ${_priorEqCount} rows with ${model.equipmentLines.length} new.`
          : `Auto-generated ${model.equipmentLines.length} Equipment rows.`,
        'success',
      );
      break;
    }
    case 'sync-seasonal-flex':
      syncSeasonalFlex();
      return; // syncSeasonalFlex handles its own renderSection + toast
    case 'set-mlv-year':
      // `idx` carries the year value (0 = All, 1..N = contract year)
      _mlvViewYear = Number.isFinite(idx) && idx >= 0 ? idx : 1;
      renderSection();
      return;
    case 'add-position': {
      if (!model.shifts) model.shifts = {};
      if (!Array.isArray(model.shifts.positions)) model.shifts.positions = [];
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'pos_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      model.shifts.positions.push({
        id, name: 'New Position', category: 'direct', employment_type: 'permanent',
        hourly_wage: 18.00, annual_salary: 0, temp_markup_pct: 0,
        bonus_pct: null, is_salaried: false, notes: '',
      });
      break;
    }
    case 'delete-position': {
      const positions = (model.shifts && model.shifts.positions) || [];
      if (positions[idx]) {
        const delId = positions[idx].id;
        // Unlink any labor lines pointing at this position
        (model.laborLines || []).forEach(l => { if (l.position_id === delId) l.position_id = null; });
        (model.indirectLaborLines || []).forEach(l => { if (l.position_id === delId) l.position_id = null; });
        if (delId) _expandedPositionIds.delete(delId);
        positions.splice(idx, 1);
      }
      break;
    }
    case 'toggle-position-notes': {
      // Brock 2026-04-26 — replaces the old sliver-width inline notes <input>
      // with a per-row collapsible textarea sub-row. Identity by position id
      // (uuid or fallback string) so state survives row reorders within the
      // session. Skip persisting through markDirty — UI-only state.
      const positions = (model.shifts && model.shifts.positions) || [];
      const pos = positions[idx];
      if (!pos) break;
      const pid = pos.id;
      if (!pid) break;
      if (_expandedPositionIds.has(pid)) _expandedPositionIds.delete(pid);
      else _expandedPositionIds.add(pid);
      renderSection();
      // Auto-focus the textarea if we just opened it
      if (_expandedPositionIds.has(pid)) {
        setTimeout(() => {
          const ta = rootEl?.querySelector(`textarea[data-array="shifts.positions"][data-idx="${idx}"][data-field="notes"]`);
          if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        }, 0);
      }
      return; // already re-rendered, skip the default markDirty branch
    }
    case 'replace-with-standard-positions': {
      // Brock 2026-04-21 pm: wipe the per-project catalog and seed the
      // 43-role standard catalog (Material Handler, Forklift Operator,
      // Ops Supervisor, etc.). Existing labor lines unlink from removed
      // positions — user reselects via dropdown.
      showConfirm(
        `Replace the current Position Catalog with the ${STANDARD_POSITIONS.length}-role standard set?\n\n` +
        `• All existing positions will be removed.\n` +
        `• Labor lines pointing at removed positions will become unlinked — you'll re-pick their role from the dropdown.\n` +
        `• Wages + salaries + benefit load overrides on your current positions will be lost.`,
        { okLabel: 'Replace', danger: true },
      ).then((ok) => {
        if (!ok) return;
        if (!model.shifts) model.shifts = {};
        model.shifts.positions = materializeStandardPositions();
        // Unlink every labor line — the old position_ids no longer exist
        (model.laborLines || []).forEach(l => { l.position_id = null; });
        (model.indirectLaborLines || []).forEach(l => { l.position_id = null; });
        isDirty = true;
        showToast(`Replaced catalog with ${STANDARD_POSITIONS.length} standard roles. Re-link labor lines via the Position dropdown in the Labor section.`, 'success');
        renderSection();
      });
      return;
    }
    case 'open-equipment-catalog':
      openEquipmentCatalog();
      return; // modal is async, don't re-render the section yet
    case 'goto-section': {
      // Used by the Labor section banner to jump to Labor Factors
      // (section key 'shifts'). See renderLaborFactorsBanner.
      const target = btn && btn.dataset && btn.dataset.section;
      if (target) navigateSection(target);
      return;
    }
    case 'apply-pfd-haircut': {
      // Brock 2026-04-20 — Labor Build-Up Logic doc §2.1/§5.2: the
      // hours-chain was missing the PF&D haircut on UPH. Applying it
      // sets annual_hours = volume / effectiveUPH, which surfaces the
      // ~15% additional hours the doc says you actually need.
      //
      // Opt-in action (not automatic) so existing projects can verify
      // the impact before committing.
      const s = model.shifts || {};
      const utilPct = Number(s.directUtilization) || 85;
      let updated = 0;
      let totalBefore = 0, totalAfter = 0;
      (model.laborLines || []).forEach(line => {
        const v = Number(line.volume) || 0;
        const base = Number(line.base_uph) || 0;
        if (v <= 0 || base <= 0) return;
        const eff = effectiveUphForLine(line);
        if (eff <= 0) return;
        totalBefore += line.annual_hours || 0;
        line.annual_hours = v / eff;
        totalAfter += line.annual_hours;
        updated++;
      });
      isDirty = true;
      const deltaHrs = totalAfter - totalBefore;
      const deltaPct = totalBefore > 0 ? (deltaHrs / totalBefore * 100) : 0;
      const fmtHrs = (n) => Math.round(n).toLocaleString('en-US');
      showToast(
        `Applied PF&D haircut (Direct Utilization ${utilPct}%) to ${updated} lines. Total hours ${fmtHrs(totalBefore)} → ${fmtHrs(totalAfter)} (+${deltaPct.toFixed(1)}%).`,
        'success'
      );
      renderSection();
      return;
    }
    case 'add-overhead':
      model.overheadLines.push({ category: '', description: '', cost_type: 'monthly', monthly_cost: 0, pricing_bucket: defaultBucketFor('overhead') });
      break;
    case 'delete-overhead':
      model.overheadLines.splice(idx, 1);
      break;
    case 'auto-gen-overhead': {
      const _priorOhCount = (model.overheadLines || []).length;
      model.overheadLines = calc.autoGenerateOverhead(model);
      model.overheadLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('overhead'); });
      showToast(
        _priorOhCount > 0
          ? `Regenerated Overhead — replaced ${_priorOhCount} rows with ${model.overheadLines.length} new.`
          : `Auto-generated ${model.overheadLines.length} Overhead rows.`,
        'success',
      );
      break;
    }
    case 'add-vas':
      model.vasLines.push({ service: '', rate: 0, volume: 0, pricing_bucket: defaultBucketFor('vas') });
      break;
    case 'delete-vas':
      model.vasLines.splice(idx, 1);
      break;
    case 'add-startup':
      model.startupLines.push({ description: '', one_time_cost: 0, pricing_bucket: defaultBucketFor('startup') });
      break;
    case 'delete-startup':
      model.startupLines.splice(idx, 1);
      break;
    case 'auto-gen-startup': {
      const _priorSuCount = (model.startupLines || []).length;
      model.startupLines = calc.autoGenerateStartup(model);
      model.startupLines.forEach(l => { if (!l.pricing_bucket) l.pricing_bucket = defaultBucketFor('startup'); });
      showToast(
        _priorSuCount > 0
          ? `Regenerated Start-Up — replaced ${_priorSuCount} rows with ${model.startupLines.length} new.`
          : `Auto-generated ${model.startupLines.length} Start-Up rows.`,
        'success',
      );
      break;
    }
    // Pricing Buckets (v2 — taxonomy editor in the Structure phase)
    case 'auto-assign-buckets': {
      // CM-PRC-1 — auto-assign pricing_bucket on every line that doesn't have one.
      const before = JSON.stringify({
        labor: (model.laborLines||[]).map(l=>l.pricing_bucket||null),
        ind:   (model.indirectLaborLines||[]).map(l=>l.pricing_bucket||null),
        eq:    (model.equipmentLines||[]).map(l=>l.pricing_bucket||null),
        ov:    (model.overheadLines||[]).map(l=>l.pricing_bucket||null),
        vas:   (model.vasLines||[]).map(l=>l.pricing_bucket||null),
        st:    (model.startupLines||[]).map(l=>l.pricing_bucket||null),
      });
      const out = calc.autoAssignBuckets(model, { overwrite: false });
      try { showToast(`Auto-assigned ${out.assigned} line${out.assigned===1?'':'s'} (${out.skipped} kept, ${out.unmatched} no match).`, out.assigned > 0 ? 'success' : 'info'); } catch {}
      markDirty();
      render();
      return;
    }
    case 'add-bucket': {
      model.pricingBuckets = model.pricingBuckets || [];
      // Generate a unique id slug
      const nextId = `bucket_${Date.now().toString(36).slice(-5)}`;
      model.pricingBuckets.push({
        id: nextId,
        name: '',
        type: 'variable',
        uom: 'order',
        rate: 0,
        description: '',
      });
      break;
    }
    case 'delete-bucket': {
      const removed = (model.pricingBuckets || [])[idx];
      model.pricingBuckets.splice(idx, 1);
      // Null out any lines that referenced this bucket so they show up as
      // unassigned in the Pricing section (better than silently re-pointing).
      const reassign = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const l of arr) {
          if (l && l.pricing_bucket === removed?.id) l.pricing_bucket = '';
        }
      };
      reassign(model.laborLines);
      reassign(model.indirectLaborLines);
      reassign(model.equipmentLines);
      reassign(model.overheadLines);
      reassign(model.vasLines);
      reassign(model.startupLines);
      // Clear financial.facilityBucketId if it pointed here
      if (model.financial && model.financial.facilityBucketId === removed?.id) {
        model.financial.facilityBucketId = '';
      }
      break;
    }
    case 'apply-bucket-starter': {
      // Clone the starter template so mutations don't bleed into the const
      model.pricingBuckets = STARTER_PRICING_BUCKETS.map(b => ({ ...b }));
      break;
    }
    case 'jump-to-buckets':
      navigateSection('pricingBuckets');
      return;
    case 'set-var-mode': {
      // CM-VAR-1: switch the Pricing Schedule variance display mode.
      const mode = btn?.dataset?.mode;
      if (mode !== 'pct' && mode !== 'abs' && mode !== 'both') return;
      if (!model.uiPrefs) model.uiPrefs = {};
      model.uiPrefs.varianceMode = mode;
      // Disable the separate-column flag when mode isn't 'both' (it has no meaning).
      if (mode !== 'both') model.uiPrefs.varianceSeparateColumn = false;
      break;
    }
    case 'toggle-var-sep': {
      // CM-VAR-1: flip the separate-column flag (only meaningful in 'both' mode).
      if (!model.uiPrefs) model.uiPrefs = {};
      model.uiPrefs.varianceSeparateColumn = !model.uiPrefs.varianceSeparateColumn;
      break;
    }
    case 'reset-override': {
      // Clear the override rate on a pricing bucket → reverts to recommended.
      // idx is the position in model.pricingBuckets. Set to null (matches the
      // "cleared input" shape that data-field binding produces) rather than 0,
      // so a future "$0 override for free services" edge case can distinguish
      // cleared (null/undefined) from explicit-zero (0).
      const b = (model.pricingBuckets || [])[idx];
      if (b) {
        // Capture the pre-reset shape BEFORE mutating so the audit row can
        // report what the user cleared. Fire-and-forget — audit failures
        // must never block the reset itself.
        const priorRate   = b.rate;
        const priorReason = b.overrideReason;
        const eb = (_pricingAuditSnapshot?.enriched || []).find(e => e.id === b.id);
        writeOverrideAuditEvent({
          action: 'price-override-reset',
          bucket: b,
          oldRate: priorRate,
          newRate: null,
          recommendedRate: eb ? Number(eb.recommendedRate) || 0 : null,
          oldReason: priorReason,
          newReason: null,
        });
        b.rate = null;
        b.overrideReason = null;
        // 2026-04-21 PM (UX nit #3): also clear the explicit-override flag,
        // otherwise a cleared rate=null with flag=true would still show as
        // overridden (a new $0 edge case introduced for free-tier services).
        b.rateExplicitOverride = false;
      }
      break;
    }
    case 'clear-facility-overrides': {
      // CM-FAC-1: wipe all per-deal facility overrides and re-render the section.
      if (model.facility) {
        delete model.facility.overrides;
      }
      markDirty();
      break;
    }
    case 'launch-wsc': {
      // Brock 2026-04-20: cross-tool linkage was broken in this direction.
      // The bus.emit was happening BEFORE the hash change to WSC, and WSC's
      // listener is registered inside its mount() — so the event arrived
      // before anyone was listening and was dropped. WSC→CM already uses a
      // sessionStorage handoff to survive the mount gap; mirror that here
      // so CM→WSC lands reliably.
      const payload = {
        clearHeight: model.facility?.clearHeight || 0,
        totalSqft:   model.facility?.totalSqft   || 0,
        at: Date.now(),
      };
      try { sessionStorage.setItem('cm_pending_push', JSON.stringify(payload)); } catch {}
      bus.emit('cm:push-to-wsc', payload); // still fire — WSC may already be mounted
      state.set('nav.tool', 'warehouse-sizing');
      window.location.hash = '#designtools/warehouse-sizing';
      return; // don't re-render
    }
    case 'reset-most-uph':
      resetMostUph(idx);
      return; // resetMostUph already re-renders
  }
  isDirty = true;
  renderSection();
}

// ============================================================
// MOST TEMPLATE → LABOR LINE INTEGRATION (per-row)
// ============================================================

/**
 * Apply (or clear) a MOST template to a specific labor line.
 * Fills most_template_id / most_template_name; auto-fills activity_name if blank,
 * base_uph if unset or still matching a previous template, uom if set on template,
 * process_area + labor_category when we have them. Then recomputes annual_hours.
 * @param {number} idx
 * @param {string} templateId — empty string clears the selection
 */
function applyMostTemplate(idx, templateId) {
  const line = model.laborLines?.[idx];
  if (!line) return;

  if (!templateId) {
    line.most_template_id = '';
    line.most_template_name = '';
    isDirty = true;
    renderSection();
    return;
  }

  const templates = refData.mostTemplates || [];
  const tpl = templates.find(t => String(t.id) === String(templateId));
  if (!tpl) return;

  // Was the previous base_uph the old template's default? If so, it's safe to
  // overwrite with the new template's default instead of treating it as a manual override.
  const prevTplId = line.most_template_id;
  const prevTpl = prevTplId ? templates.find(t => String(t.id) === String(prevTplId)) : null;
  const prevTplUph = prevTpl ? mostTplUph(prevTpl) : 0;
  const prevWasDefault = prevTpl
    && (line.base_uph || 0) > 0
    && prevTplUph > 0
    && Math.abs((line.base_uph || 0) - prevTplUph) <= 0.5;

  const tplName = mostTplName(tpl);
  const tplUph = mostTplUph(tpl);

  line.most_template_id = tpl.id;
  line.most_template_name = tplName;

  if (!line.activity_name) line.activity_name = tplName;
  if (tpl.process_area && !line.process_area) line.process_area = tpl.process_area;
  if (tpl.labor_category && !line.labor_category) line.labor_category = tpl.labor_category;
  if (tpl.uom && !line.uom) line.uom = tpl.uom;

  // Only overwrite base_uph when it's zero or was the previous template's default.
  if ((line.base_uph || 0) === 0 || prevWasDefault) {
    line.base_uph = tplUph;
  }

  recomputeLineHours(line);

  isDirty = true;
  if (!userHasInteracted) { userHasInteracted = true; updateValidation(); }
  renderSection();
}

/**
 * Reset a labor line's base_uph back to its MOST template default.
 * @param {number} idx
 */
function resetMostUph(idx) {
  const line = model.laborLines?.[idx];
  if (!line || !line.most_template_id) return;
  const tpl = (refData.mostTemplates || []).find(t => String(t.id) === String(line.most_template_id));
  if (!tpl) return;
  const uph = mostTplUph(tpl);
  if (uph <= 0) return; // don't wipe user's uph if template has no uph
  line.base_uph = uph;
  recomputeLineHours(line);
  isDirty = true;
  renderSection();
}

/**
 * Open a read-only modal showing template details and element breakdown.
 * Elements fetched lazily via api.fetchMostElements on first open for a template.
 * @param {string} templateId
 */
async function openMostTemplateDetail(templateId) {
  if (!rootEl || !templateId) return;
  const tpl = (refData.mostTemplates || []).find(t => String(t.id) === String(templateId));
  if (!tpl) return;

  rootEl.querySelector('#cm-most-detail-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'cm-most-detail-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';

  const header = `
    <div style="padding:20px 24px 12px 24px;border-bottom:1px solid var(--ies-gray-200);">
      <div style="display:flex;align-items:start;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:16px;font-weight:700;">MOST Template — ${mostTplName(tpl) || '—'}</div>
          <div style="font-size:12px;color:var(--ies-gray-400);margin-top:2px;">${tpl.process_area || '—'} · ${tpl.labor_category || '—'} · UOM: ${tpl.uom || '—'}${tpl.wms_transaction ? ` · ${tpl.wms_transaction}` : ''}</div>
        </div>
        <button id="cm-most-detail-close" class="hub-btn hub-btn-sm hub-btn-secondary">✕ Close</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px;">
        <div style="background:var(--ies-gray-50);border-radius:6px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;">Base UPH</div>
          <div style="font-size:22px;font-weight:700;color:var(--ies-blue,#0047AB);">${Math.round(mostTplUph(tpl)).toLocaleString()}</div>
        </div>
        <div style="background:var(--ies-gray-50);border-radius:6px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;">Total TMU</div>
          <div style="font-size:22px;font-weight:700;color:var(--ies-gray-700);">${Math.round(mostTplTmu(tpl)).toLocaleString()}</div>
        </div>
        <div style="background:var(--ies-gray-50);border-radius:6px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.5px;">Equipment</div>
          <div style="font-size:14px;font-weight:700;color:var(--ies-gray-700);margin-top:6px;">${tpl.equipment_type || '—'}</div>
        </div>
      </div>
      ${tpl.description ? `<div style="margin-top:12px;font-size:12px;color:var(--ies-gray-600);line-height:1.5;">${tpl.description}</div>` : ''}
    </div>
  `;

  modal.innerHTML = `
    <div style="background:#fff;border-radius: 10px;width:min(760px,92vw);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden;">
      ${header}
      <div id="cm-most-detail-body" style="flex:1;overflow-y:auto;padding:16px 20px;">
        <div style="text-align:center;color:var(--ies-gray-400);font-size:13px;padding:24px;">Loading elements…</div>
      </div>
    </div>
  `;
  rootEl.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#cm-most-detail-close')?.addEventListener('click', close);

  // Lazy-load elements
  const body = modal.querySelector('#cm-most-detail-body');
  try {
    const elements = await api.fetchMostElements(templateId);
    const sorted = (elements || []).slice().sort((a, b) => mostElSeq(a) - mostElSeq(b));
    if (sorted.length === 0) {
      body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--ies-gray-400);font-size:13px;">No MOST elements defined for this template yet.</div>`;
      return;
    }
    const totalTmu = sorted.reduce((s, e) => s + mostElTmu(e), 0);
    const rows = sorted.map((el, i) => `
      <tr style="${i % 2 ? 'background:var(--ies-gray-50);' : ''}">
        <td style="padding:6px 10px;color:var(--ies-gray-400);">${mostElSeq(el) || (i + 1)}</td>
        <td style="padding:6px 10px;font-weight:500;">${mostElName(el) || '—'}</td>
        <td style="padding:6px 10px;font-family:monospace;font-size:11px;color:var(--ies-gray-500);">${el.most_sequence || '—'}</td>
        <td style="padding:6px 10px;text-align:right;font-weight:600;">${mostElTmu(el) || 0}</td>
        <td style="padding:6px 10px;text-align:center;">${el.is_variable ? `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:11px;">${el.variable_driver || 'Yes'}</span>` : '<span style="color:var(--ies-gray-300);">—</span>'}</td>
      </tr>
    `).join('');
    body.innerHTML = `
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">MOST Element Breakdown (${sorted.length} steps)</div>
      <div style="border:1px solid var(--ies-gray-200);border-radius: 10px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="background:var(--ies-gray-50);">
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--ies-gray-400);">#</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--ies-gray-400);">Element</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--ies-gray-400);">MOST Sequence</th>
            <th style="padding:8px 10px;text-align:right;font-size:11px;color:var(--ies-gray-400);">TMU</th>
            <th style="padding:8px 10px;text-align:center;font-size:11px;color:var(--ies-gray-400);">Variable?</th>
          </tr></thead>
          <tbody>${rows}
            <tr style="background:var(--ies-gray-100);font-weight:700;">
              <td colspan="3" style="padding:8px 10px;text-align:right;">Total TMU</td>
              <td style="padding:8px 10px;text-align:right;">${totalTmu}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.warn('[CM] fetchMostElements failed:', err);
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#b91c1c;font-size:13px;">Could not load elements: ${err?.message || err}</div>`;
  }
}

// ============================================================
// EQUIPMENT CATALOG MODAL — browse ref_equipment and pick items
// ============================================================

/** @type {Array<any>} Cached after first fetch so re-open is instant. */
let catalogCache = null;

/**
 * Find a catalog entry by equipment_name. Returns null if no match.
 * Matching strategy (in order of precedence):
 *   1. Exact case-insensitive match
 *   2. Substring match either direction ("Reach Truck" ⊂ "Reach Truck 300\"")
 *   3. Significant-token overlap — rank by % of line's significant tokens
 *      found in the catalog name. "Sit-down Forklift" matches
 *      "Sit-Down Counterbalance Forklift" (both tokens found) and scores
 *      above "Reach Truck" (no overlap).
 * Loads the catalog lazily.
 */
async function findCatalogMatch(equipmentName) {
  if (!equipmentName) return null;
  if (!catalogCache) {
    try { catalogCache = await api.fetchEquipmentCatalog(); }
    catch (err) { console.warn('[CM] catalog fetch failed on flip:', err); catalogCache = []; }
  }
  const items = Array.isArray(catalogCache) ? catalogCache : [];
  const q = equipmentName.toLowerCase().trim();
  // 1. Exact match
  let hit = items.find(i => (i.name || '').toLowerCase().trim() === q);
  if (hit) return hit;
  // 2. Substring either direction
  hit = items.find(i => {
    const n = (i.name || '').toLowerCase();
    return n && (n.includes(q) || q.includes(n));
  });
  if (hit) return hit;
  // 3. Token-overlap — pick the catalog entry with the highest fraction of
  //    significant tokens matched. Filter out "fluff" words so common
  //    descriptors don't inflate false positives.
  const STOPWORDS = new Set(['the','a','an','and','or','of','in','for','to','with','per','unit','system','each','pack','mobile','portable']);
  const tokens = q.split(/[\s\-_,\/()]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const name = (item.name || '').toLowerCase();
    if (!name) continue;
    const hits = tokens.filter(t => name.includes(t)).length;
    const score = hits / tokens.length;
    // Require ≥50% token overlap so noise matches get rejected.
    if (score >= 0.5 && score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/**
 * When a user flips an equipment line's acquisition_type, auto-populate the
 * relevant cost field from the ref_equipment catalog (by name match), so
 * they don't end up with a $0 cost that silently breaks downstream math.
 *
 *   → capital : populate acquisition_cost from catalog.purchase_cost
 *   → lease   : populate monthly_cost from catalog.monthly_lease_cost
 *   → service : populate monthly_cost from catalog.monthly_lease_cost
 *               (service is a monthly fee like lease, with no residual)
 *   → ti      : populate acquisition_cost from catalog.purchase_cost
 *               (TI is a one-time upfront built into facility)
 *
 * Only sets a field if (a) we have a catalog match AND (b) the target field
 * is currently $0 or empty. If the user has already typed a custom cost, we
 * respect it.
 *
 * Returns `true` if any value was changed, `false` otherwise.
 */
async function autoPopulateCostOnAcqTypeFlip(line, newAcqType) {
  if (!line) return false;
  const match = await findCatalogMatch(line.equipment_name);
  if (!match) return false;

  let changed = false;
  const t = (newAcqType || '').toLowerCase();

  if (t === 'capital' || t === 'purchase' || t === 'ti') {
    const cost = Number(match.purchase_cost) || 0;
    if (cost > 0 && (!line.acquisition_cost || Number(line.acquisition_cost) <= 0)) {
      line.acquisition_cost = cost;
      changed = true;
    }
  }
  if (t === 'lease' || t === 'service') {
    const cost = Number(match.monthly_lease_cost) || 0;
    if (cost > 0 && (!line.monthly_cost || Number(line.monthly_cost) <= 0)) {
      line.monthly_cost = cost;
      changed = true;
    }
  }
  // Also refresh useful life from catalog on any flip to capital (affects amort).
  if ((t === 'capital' || t === 'purchase') && match.useful_life_years && !line.amort_years) {
    line.amort_years = Number(match.useful_life_years) || 5;
    changed = true;
  }
  return changed;
}

async function openEquipmentCatalog() {
  if (!rootEl) return;
  // Remove any existing modal
  rootEl.querySelector('#cm-eq-catalog-modal')?.remove();

  // Ensure catalog is loaded
  if (!catalogCache) {
    try {
      catalogCache = await api.fetchEquipmentCatalog();
    } catch (err) {
      console.warn('[CM] fetchEquipmentCatalog failed:', err);
      catalogCache = [];
    }
  }
  const items = Array.isArray(catalogCache) ? catalogCache : [];
  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean))).sort();

  const modal = document.createElement('div');
  modal.id = 'cm-eq-catalog-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';

  const renderRows = (query, cat) => {
    const q = (query || '').trim().toLowerCase();
    return items
      .filter(i => !cat || i.category === cat)
      .filter(i => !q || `${i.name} ${i.subcategory || ''} ${i.notes || ''}`.toLowerCase().includes(q))
      .map(i => `
        <tr data-eq-id="${i.id}" style="cursor:pointer;border-bottom:1px solid var(--ies-gray-100);">
          <td style="padding:8px 10px;">
            <div style="font-weight:600;font-size:13px;">${i.name}</div>
            ${i.subcategory ? `<div style="font-size:11px;color:var(--ies-gray-400);">${i.subcategory}</div>` : ''}
          </td>
          <td style="padding:8px 10px;"><span style="font-size:11px;padding:2px 8px;border-radius:12px;background:var(--ies-gray-100);color:var(--ies-gray-600);">${i.category || '—'}</span></td>
          <td style="padding:8px 10px;text-align:right;font-weight:600;">${i.monthly_lease_cost ? '$' + Number(i.monthly_lease_cost).toLocaleString() : '—'}</td>
          <td style="padding:8px 10px;text-align:right;font-weight:600;">${i.purchase_cost ? '$' + Number(i.purchase_cost).toLocaleString() : '—'}</td>
          <td style="padding:8px 10px;text-align:right;">${i.useful_life_years || '—'}</td>
          <td style="padding:8px 10px;font-size:11px;color:var(--ies-gray-500);max-width:280px;">${(i.capacity_description || '')}</td>
        </tr>
      `).join('') || `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--ies-gray-400);">No items match.</td></tr>`;
  };

  modal.innerHTML = `
    <div style="background:#fff;border-radius: 10px;width:min(960px,92vw);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.2);overflow:hidden;">
      <div style="padding:20px 24px 12px 24px;border-bottom:1px solid var(--ies-gray-200);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <div>
            <div style="font-size:16px;font-weight:700;">Equipment Catalog</div>
            <div style="font-size:12px;color:var(--ies-gray-400);">${items.length} items from the GXO reference catalog — click a row to add it as a new line.</div>
          </div>
          <button id="eq-close" class="hub-btn hub-btn-sm hub-btn-secondary" style="margin-left:auto;">✕ Close</button>
        </div>
        <div style="display:flex;gap:8px;">
          <input id="eq-search" class="hub-input" placeholder="Search name, subcategory, notes…" style="flex:1;font-size:13px;" />
          <select id="eq-cat" class="hub-select" style="width:160px;font-size:13px;">
            <option value="">All categories</option>
            ${categories.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--ies-gray-50);z-index:1;">
            <tr style="border-bottom:2px solid var(--ies-gray-200);">
              <th style="padding:10px;text-align:left;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Equipment</th>
              <th style="padding:10px;text-align:left;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Category</th>
              <th style="padding:10px;text-align:right;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Lease $/mo</th>
              <th style="padding:10px;text-align:right;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Purchase $</th>
              <th style="padding:10px;text-align:right;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Life (yrs)</th>
              <th style="padding:10px;text-align:left;font-size:11px;font-weight:700;color:var(--ies-gray-400);">Capacity / Notes</th>
            </tr>
          </thead>
          <tbody id="eq-tbody">${renderRows('', '')}</tbody>
        </table>
      </div>
    </div>
  `;
  rootEl.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#eq-close')?.addEventListener('click', close);

  const search = /** @type {HTMLInputElement} */ (modal.querySelector('#eq-search'));
  const catSel = /** @type {HTMLSelectElement} */ (modal.querySelector('#eq-cat'));
  const tbody  = modal.querySelector('#eq-tbody');
  const refresh = () => { if (tbody) tbody.innerHTML = renderRows(search.value, catSel.value); };
  search?.addEventListener('input', refresh);
  catSel?.addEventListener('change', refresh);

  // Row click → fill a new equipment line, close modal, re-render section
  modal.querySelector('#eq-tbody')?.addEventListener('click', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('[data-eq-id]');
    if (!row) return;
    const id = row.getAttribute('data-eq-id');
    const item = items.find(i => i.id === id);
    if (!item) return;
    // Map catalog fields → equipment line shape used by createEmptyModel & renderEquipment
    // Pick a sensible default acquisition type from the catalog shape:
    //   has_lease AND has_purchase → lease (user can flip; purchase cost is pre-populated)
    //   has_purchase only          → capital (build-to-buy items)
    //   has_lease only             → lease
    // Either way, we hydrate BOTH monthly_cost and acquisition_cost from the
    // catalog so a later type-flip finds the value already present.
    const hasLease    = Number(item.monthly_lease_cost) > 0;
    const hasPurchase = Number(item.purchase_cost) > 0;
    const defaultType = hasLease ? 'lease' : (hasPurchase ? 'capital' : 'lease');
    const newLine = {
      equipment_name: item.name || '',
      category: ['MHE','IT','Racking','Dock','Charging','Office','Security','Conveyor'].includes(item.category) ? item.category : 'MHE',
      quantity: 1,
      acquisition_type: defaultType,
      monthly_cost: Number(item.monthly_lease_cost) || 0,
      acquisition_cost: Number(item.purchase_cost) || 0,
      monthly_maintenance: Number(item.monthly_maintenance) || 0,
      amort_years: Number(item.useful_life_years) || 5,
      notes: item.capacity_description || '',
      pricing_bucket: defaultBucketFor('equipment'), // I-01 — don't silently roll into Management Fee
    };
    if (!Array.isArray(model.equipmentLines)) model.equipmentLines = [];
    model.equipmentLines.push(newLine);
    isDirty = true;
    close();
    renderSection();
    bus.emit('cm:equipment-added-from-catalog', { name: newLine.equipment_name });
  });

  // Focus search on open
  search?.focus();
}

// ============================================================
// TOOLBAR HANDLERS
// ============================================================

async function handleNew() {
  if (isDirty && !confirm('You have unsaved changes. Start a new model?')) return;
  model = createEmptyModel();
  isDirty = false;
  // CM-SAVE-1 — Reset save-state on a brand-new model.
  lastSavedAt = null;
  lastSavedBy = null;
  refreshSaveStateChip();
  activeSection = 'setup';
  navigateSection('setup');
}

async function handleSave() {
  try {
    if (model.id) {
      await api.updateModel(model.id, model);
    } else {
      const saved = await api.createModel(model);
      model.id = saved.id;
    }
    isDirty = false;
    // CM-SAVE-1 — Capture audit metadata for the toolbar chip.
    lastSavedAt = new Date().toISOString();
    try { lastSavedBy = auth.getUser()?.email || lastSavedBy || null; } catch { /* ignore — chip falls back to time-only */ }
    refreshSaveStateChip();
    bus.emit('cm:model-saved', { id: model.id });

    // Phase 1: if the monthly engine flag is on and we have the latest
    // projection bundle in memory, persist the monthly facts + refresh the
    // materialized view. Fire-and-forget so a flaky RPC never blocks save.
    if (typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false) {
      const bundle = _lastMonthlyBundle;
      if (bundle && model.id) {
        api.persistMonthlyFacts(model.id, bundle)
          .then(({ wrote }) => bus.emit('cm:monthly-facts-updated', { project_id: model.id, rows: wrote }))
          .catch(err => { console.warn('[CM] persistMonthlyFacts failed:', err); bus.emit('cm:pnl-refresh-failed', { project_id: model.id, error: err }); });
      }
    }
  } catch (err) {
    console.error('[CM] Save failed:', err);
    alert('Save failed: ' + err.message);
  }
}

/** Cached monthly bundle from the most recent buildYearlyProjections call. */
let _lastMonthlyBundle = null;
export function setLastMonthlyBundle(bundle) { _lastMonthlyBundle = bundle; }

/**
 * Build the monthly bundle on demand so sections other than Summary (notably
 * Timeline) can render without first requiring a Summary roundtrip. Reads the
 * current model/refData/heuristic chain the same way Summary does and caches
 * the result into `_lastMonthlyBundle`.
 */
function ensureMonthlyBundle() {
  if (_lastMonthlyBundle) return _lastMonthlyBundle;
  if (!model) return null;
  try {
    const market = model.projectDetails?.market;
    const fr = (refData.facilityRates || []).find(r => r.market_id === market);
    const ur = (refData.utilityRates || []).find(r => r.market_id === market);
    const opHrs = calc.operatingHours(model.shifts || {});
    const orders = (model.volumeLines || []).find(v => v.isOutboundPrimary)?.volume || 0;
    const contractYears = model.projectDetails?.contractTerm || 5;
    const fin = model.financial || {};
    const summary = calc.computeSummary({
      laborLines: model.laborLines || [],
      indirectLaborLines: model.indirectLaborLines || [],
      equipmentLines: model.equipmentLines || [],
      overheadLines: model.overheadLines || [],
      vasLines: model.vasLines || [],
      startupLines: model.startupLines || [],
      facility: model.facility || {},
      shifts: model.shifts || {},
      facilityRate: fr,
      utilityRate: ur,
      contractYears,
      targetMarginPct: fin.targetMargin || 0,
      annualOrders: orders || 1,
    });
    const calcHeur = applySplitMonthBilling(scenarios.resolveCalcHeuristics(
      currentScenario,
      currentScenarioSnapshots,
      heuristicOverrides,
      fin,
      whatIfTransient,
    ), model);
    const emBMarginFrac = (calcHeur.targetMarginPct || 0) / 100;
    const projResult = calc.buildYearlyProjections({
      years: contractYears,
      baseLaborCost: summary.laborCost,
      baseFacilityCost: summary.facilityCost,
      baseEquipmentCost: summary.equipmentCost,
      baseOverheadCost: summary.overheadCost,
      baseVasCost: summary.vasCost,
      startupAmort: summary.startupAmort,
      startupCapital: summary.startupCapital,
      baseOrders: orders || 1,
      marginPct: emBMarginFrac,
      volGrowthPct: calcHeur.volGrowthPct / 100,
      laborEscPct:  calcHeur.laborEscPct  / 100,
      costEscPct:   calcHeur.costEscPct   / 100,
      facilityEscPct:  calcHeur.facilityEscPct  / 100,
      equipmentEscPct: calcHeur.equipmentEscPct / 100,
      laborLines: model.laborLines || [],
      taxRatePct: calcHeur.taxRatePct,
      useMonthlyEngine: typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false,
      periods: (refData && refData.periods) || [],
      ramp: null,
      seasonality: model.seasonalityProfile || null,
      preGoLiveMonths: calcHeur.preGoLiveMonths,
      dsoDays:           calcHeur.dsoDays,
      dpoDays:           calcHeur.dpoDays,
      laborPayableDays:  calcHeur.laborPayableDays,
      startupLines: model.startupLines || [],
      pricingBuckets: buildEnrichedPricingBuckets(summary, emBMarginFrac, opHrs, contractYears),
      project_id: model.id || 0,
      _calcHeur: calcHeur,
      marketLaborProfile: currentMarketLaborProfile,
      wageLoadByYear: null,
      _heuristicsSource: calcHeur.used,
    });
    if (projResult && projResult.monthlyBundle) _lastMonthlyBundle = projResult.monthlyBundle;
    if (projResult && projResult.projections) _lastProjections = projResult.projections;
    if (calcHeur) _lastCalcHeuristics = calcHeur;
    return _lastMonthlyBundle;
  } catch (err) {
    console.warn('[CM] ensureMonthlyBundle failed:', err);
    return null;
  }
}

async function handleLoad() {
  // The Load button now returns to the landing page where models are shown as cards.
  // Refreshes the list so any newly-saved model appears.
  try { savedModels = await api.listModels(); } catch {}
  if (isDirty && !confirm('You have unsaved changes. Leave this model?')) return;
  viewMode = 'landing';
  renderCurrentView();
}

// ============================================================
// EXCEL EXPORT — multi-sheet .xlsx via SheetJS CDN (window.XLSX)
// ============================================================

function handleExportExcel() {
  if (!window.XLSX) {
    alert('Excel library not loaded. Refresh the page and try again.');
    return;
  }
  try {
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();
    const pd = model.projectDetails || {};

    // --- Compute summary (best-effort; if it fails we still export raw data) ---
    let summary = null;
    try {
      const outbound = (model.volumeLines || []).find(v => v.isOutboundPrimary);
      summary = calc.computeSummary({
        shifts: model.shifts,
        facility: model.facility,
        laborLines: model.laborLines || [],
        indirectLaborLines: model.indirectLaborLines || [],
        equipmentLines: model.equipmentLines || [],
        overheadLines: model.overheadLines || [],
        vasLines: model.vasLines || [],
        startupLines: model.startupLines || [],
        contractYears: pd.contractTerm || 5,
        targetMarginPct: (model.financial && model.financial.targetMargin) || 0,
        annualOrders: (outbound && outbound.volume) || 1,
        facilityRate: 0,
        utilityRate: 0,
      });
    } catch (err) {
      console.warn('[CM] computeSummary failed during export — skipping totals:', err);
    }

    // --- Sheet 1: Summary ---
    const rows = [
      ['IES Cost Model — Export'],
      ['Generated', new Date().toISOString()],
      [],
      ['Project Name',     pd.name || 'Untitled Model'],
      ['Client',           pd.clientName || '—'],
      ['Facility Location',pd.facilityLocation || '—'],
      ['Market',           pd.market || '—'],
      ['Environment',      pd.environment || '—'],
      ['Contract Term (yrs)', pd.contractTerm || 5],
    ];
    if (summary) {
      rows.push([]);
      rows.push(['— Annual Cost Summary —']);
      rows.push(['Labor Cost',       Math.round(summary.laborCost || 0)]);
      rows.push(['Facility Cost',    Math.round(summary.facilityCost || 0)]);
      rows.push(['Equipment Cost',   Math.round(summary.equipmentCost || 0)]);
      rows.push(['Overhead Cost',    Math.round(summary.overheadCost || 0)]);
      rows.push(['VAS Cost',         Math.round(summary.vasCost || 0)]);
      rows.push(['Startup Amortization', Math.round(summary.startupAmort || 0)]);
      rows.push(['Total Annual Cost',    Math.round(summary.totalCost || 0)]);
      rows.push(['Total Annual Revenue', Math.round(summary.totalRevenue || 0)]);
      rows.push(['Target Margin %',      (model.financial && model.financial.targetMargin) || 0]);
      rows.push(['Total FTEs',           (summary.totalFtes || 0).toFixed(1)]);
      rows.push(['Cost per Order',       +(summary.costPerOrder || 0).toFixed(2)]);
      rows.push(['Equipment Capital',    Math.round(summary.equipmentCapital || 0)]);
      rows.push(['Startup Capital',      Math.round(summary.startupCapital || 0)]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Summary');

    // --- Helper: append an object-array sheet, coping with empty lists ---
    const appendObjectSheet = (name, arr, fallbackHeader) => {
      if (!Array.isArray(arr) || arr.length === 0) {
        const ws = XLSX.utils.aoa_to_sheet([[...fallbackHeader], ['— no data —']]);
        XLSX.utils.book_append_sheet(wb, ws, name);
        return;
      }
      const ws = XLSX.utils.json_to_sheet(arr);
      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    // --- Sheets: Volumes / Labor (Direct, Indirect) / Equipment / Overhead / VAS / Startup / Pricing / Shifts ---
    appendObjectSheet('Volumes',       model.volumeLines || [],        ['name','volume','uom','isOutboundPrimary']);
    appendObjectSheet('Labor-Direct',  model.laborLines || [],         ['activity_name','process_area','volume','base_uph','hourly_rate','burden_pct']);
    appendObjectSheet('Labor-Indirect',model.indirectLaborLines || [], ['role','hourly_rate','ratio_to_direct','burden_pct']);
    appendObjectSheet('Equipment',     model.equipmentLines || [],     ['equipment_name','category','quantity','acquisition_type','monthly_lease','acquisition_cost','annual_maintenance','amortization_years']);
    appendObjectSheet('Overhead',      model.overheadLines || [],      ['category','annual_cost','driver','notes']);
    appendObjectSheet('VAS',           model.vasLines || [],           ['name','annual_cost']);
    appendObjectSheet('Startup',       model.startupLines || [],       ['category','amount','amortization_years']);
    appendObjectSheet('Pricing',       model.pricingBuckets || [],     ['id','name','type','uom','rate']);

    // --- Shifts block as a short sheet ---
    const s = model.shifts || {};
    const shiftsAOA = [
      ['Shifts per Day',      s.shiftsPerDay || 1],
      ['Hours per Shift',     s.hoursPerShift || 8],
      ['Days per Week',       s.daysPerWeek || 5],
      ['Weeks per Year',      s.weeksPerYear || 52],
      ['Facility Total Sqft', (model.facility && model.facility.totalSqft) || 0],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(shiftsAOA), 'Facility-Shifts');

    // --- Filename: CM_<projectName>_<yyyy-mm-dd>.xlsx, safe-chars only ---
    const safeName = (pd.name || 'Untitled_Model').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `CM_${safeName}_${dateStr}.xlsx`;
    XLSX.writeFile(wb, fileName);
    bus.emit('cm:model-exported', { fileName });
  } catch (err) {
    console.error('[CM] Excel export failed:', err);
    alert('Excel export failed: ' + (err.message || 'unknown error'));
  }
}

// ============================================================
// VALIDATION UI
// ============================================================

function updateValidation() {
  const el = rootEl?.querySelector('#cm-validation');
  if (!el) return;

  // Don't show validation errors until the user starts working, but once a
  // model is loaded with data, swap the onboarding copy for a quiet "saved"
  // signal — "Ready — enter project details to begin" on a fully-loaded
  // Wayfair build reads as stale instructions.
  if (!userHasInteracted) {
    const hasData = !!(model && (
      (model.projectDetails?.name) ||
      (Array.isArray(model.laborLines) && model.laborLines.length) ||
      (Array.isArray(model.pricingBuckets) && model.pricingBuckets.length)
    ));
    if (hasData) {
      el.innerHTML = '<span style="color: var(--ies-gray-500); font-weight: 500;">✓ Loaded — changes auto-validate on edit</span>';
    } else {
      el.innerHTML = '<span style="color: var(--ies-blue); font-weight: 600;">Ready — enter project details to begin</span>';
    }
    return;
  }

  const warnings = calc.validateModel(model);
  if (warnings.length === 0) {
    el.innerHTML = '<span style="color: var(--ies-green); font-weight: 600;">No issues found</span>';
    return;
  }

  const errors = warnings.filter(w => w.level === 'error').length;
  const warns = warnings.filter(w => w.level === 'warning').length;

  el.innerHTML = `
    <div style="color: ${errors > 0 ? 'var(--ies-red)' : 'var(--ies-yellow)'}; font-weight: 600;">
      ${errors > 0 ? `${errors} error${errors > 1 ? 's' : ''}` : ''}
      ${errors > 0 && warns > 0 ? ', ' : ''}
      ${warns > 0 ? `${warns} warning${warns > 1 ? 's' : ''}` : ''}
    </div>
  `;

  // Update section completion checks
  SECTIONS.forEach(s => {
    const check = rootEl?.querySelector(`#cm-check-${s.key}`);
    if (!check) return;
    const hasError = warnings.some(w => w.area === s.key && w.level === 'error');
    const hasData = sectionHasData(s.key);
    check.classList.toggle('complete', hasData && !hasError);
  });
}

function sectionHasData(key) {
  switch (key) {
    case 'setup': return !!(model.projectDetails?.name);
    case 'volumes': return model.volumeLines.length > 0;
    case 'facility': return (model.facility?.totalSqft || 0) > 0;
    case 'shifts': return true; // defaults always valid
    case 'labor': return model.laborLines.length > 0;
    case 'equipment': return model.equipmentLines.length > 0;
    case 'overhead': return model.overheadLines.length > 0;
    case 'financial': return (model.financial?.targetMargin || 0) > 0;
    default: return false;
  }
}

// ============================================================
// MOST → CM INTEGRATION
// ============================================================

/**
 * Handle incoming labor lines from MOST tool.
 * Merges or replaces CM laborLines with MOST-derived data.
 * @param {import('../most-standards/types.js?v=20260418-sK').MostToCmPayload} payload
 */
function handleMostPush(payload) {
  if (!payload?.laborLines?.length) return;

  // Replace any existing MOST-sourced lines (by template_id), keep manual ones
  const manualLines = model.laborLines.filter(l => !l.most_template_id);
  const mostLines = payload.laborLines.map(l => ({
    activity_name: l.activity_name || '',
    process_area: l.process_area || '',
    labor_category: l.labor_category || 'manual',
    volume: l.volume || 0,
    base_uph: l.base_uph || 0,
    annual_hours: l.annual_hours || 0,
    hourly_rate: l.hourly_rate || 0,
    burden_pct: l.burden_pct || 30,
    most_template_id: l.most_template_id || '',
    most_template_name: l.most_template_name || '',
  }));

  model.laborLines = [...manualLines, ...mostLines];
  isDirty = true;

  // Navigate to labor section to show the result
  navigateSection('labor');
  updateValidation();

  bus.emit('cm:labor-updated', { source: 'most', lineCount: mostLines.length });
  console.log(`[CM] Received ${mostLines.length} labor lines from MOST`);
}

// ============================================================
// WSC → CM INTEGRATION
// ============================================================

/**
 * Handle incoming facility data from Warehouse Sizing Calculator.
 * Populates CM facility section fields.
 * @param {import('../warehouse-sizing/types.js?v=20260418-sK').WscToCmPayload} payload
 */
function handleWscPush(payload) {
  if (!payload) return;

  // If WSC fired this while we were still on the landing view, enter the editor
  // with a fresh model first — otherwise navigateSection is a no-op.
  if (viewMode === 'landing') {
    model = createEmptyModel();
    isDirty = false;
    userHasInteracted = false;
    activeSection = 'facility';
    viewMode = 'editor';
  }

  model.facility = model.facility || {};
  // WSC-J1 (2026-04-25): mirror of the sessionStorage handoff branch above.
  if (payload.totalSqft)        model.facility.totalSqft = payload.totalSqft;
  if (payload.storageSqft)      model.facility.storageSqft = payload.storageSqft;
  if (payload.clearHeight)      model.facility.clearHeight = payload.clearHeight;
  if (payload.buildingWidth)    model.facility.buildingWidth = payload.buildingWidth;
  if (payload.buildingDepth)    model.facility.buildingDepth = payload.buildingDepth;
  if (payload.dockDoors)        model.facility.dockDoors = payload.dockDoors;
  if (payload.inboundDoors)     model.facility.inboundDoors = payload.inboundDoors;
  if (payload.outboundDoors)    model.facility.outboundDoors = payload.outboundDoors;
  if (payload.officeSqft)       model.facility.officeSqft = payload.officeSqft;
  if (payload.stagingSqft)      model.facility.stagingSqft = payload.stagingSqft;
  if (payload.palletPositions)  model.facility.palletPositions = payload.palletPositions;
  if (payload.sfPerPosition)    model.facility.sfPerPosition = payload.sfPerPosition;
  if (payload.peakUnitsPerDay)  model.facility.peakUnitsPerDay = payload.peakUnitsPerDay;

  isDirty = true;
  if (viewMode === 'editor') {
    navigateSection('facility');
    updateValidation();
  } else {
    renderCurrentView();
  }

  bus.emit('cm:facility-updated', { source: 'wsc' });
  console.log('[CM] Received facility data from WSC:', payload);
}

// ============================================================
// NetOpt -> CM INTEGRATION
// ============================================================

/**
 * Handle incoming network scenario from Network Optimizer.
 * Seeds Volumes (Outbound Orders) with totalAnnualDemand and stashes
 * transport / facility / handling cost benchmarks on the model so the
 * Cost Model author can validate their own bottom-up math against the
 * upstream network design.
 */
function handleNetOptPush(payload) {
  if (!payload) return;

  if (viewMode === 'landing') {
    model = createEmptyModel();
    isDirty = false;
    userHasInteracted = false;
    viewMode = 'editor';
  }

  const demand = Number(payload.totalAnnualDemand) || 0;
  if (demand > 0) {
    model.volumeLines = Array.isArray(model.volumeLines) ? model.volumeLines : [];
    const idx = model.volumeLines.findIndex(v => v.isOutboundPrimary);
    const seeded = {
      name: 'Outbound Orders (from NetOpt)',
      volume: demand,
      uom: 'order',
      isOutboundPrimary: true,
      source: 'netopt', // CM-VOL-3
    };
    if (idx >= 0) {
      model.volumeLines[idx] = { ...model.volumeLines[idx], ...seeded };
    } else {
      model.volumeLines = model.volumeLines.map(v => ({ ...v, isOutboundPrimary: false }));
      model.volumeLines.unshift(seeded);
    }
  }

  model.netoptBenchmark = {
    sourceScenario: payload.sourceScenario || 'NetOpt scenario',
    transportCost: Number(payload.transportCost) || 0,
    facilityCost:  Number(payload.facilityCost)  || 0,
    handlingCost:  Number(payload.handlingCost)  || 0,
    totalCost:     Number(payload.totalCost)     || 0,
    openFacilities: Number(payload.openFacilities) || 0,
    receivedAt: Date.now(),
  };

  isDirty = true;
  navigateSection('volumes');
  updateValidation();

  bus.emit('cm:netopt-applied', {
    source: 'netopt',
    demand,
    transportCost: model.netoptBenchmark.transportCost,
  });
  console.log('[CM] Received NetOpt scenario:', model.netoptBenchmark);
}

// ============================================================
// HELPERS
// ============================================================

// ============================================================
// LANDING PAGE — saved-scenarios grid + "+ Create New Model" CTA
// ============================================================

function renderLanding() {
  const count = savedModels.length;
  // ref_markets primary key is `id` (uuid) with a `name` column; the fallback shape
  // uses market_id/name. Build a lookup that works for either shape.
  const marketById = {};
  (refData.markets || DEMO_MARKETS_FALLBACK).forEach(m => {
    const key = m.market_id || m.id;
    const label = m.name || m.market_name || m.abbr || key;
    if (key) marketById[key] = label;
  });
  return `
    <div style="padding:32px;max-width:1280px;margin:0 auto;">
      <a href="#designtools" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ies-gray-500);text-decoration:none;margin-bottom:8px;" onmouseover="this.style.color='#ff3a00'" onmouseout="this.style.color='var(--ies-gray-500)'">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Design Tools
      </a>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
        <div>
          <h2 class="text-page" style="margin:0 0 4px 0;">Cost Model Builder</h2>
          <div style="font-size:13px;color:var(--ies-gray-400);">
            ${count === 0 ? 'Build a new pricing model from scratch.' : `${count} saved model${count === 1 ? '' : 's'} — pick one to continue, or start fresh.`}
          </div>
        </div>
        <button class="hub-btn hub-btn-primary" id="cm-create-new" style="font-weight:700;">+ Create New Model</button>
      </div>

      ${count === 0 ? `
        <div class="hub-card" style="padding:48px;text-align:center;border:2px dashed var(--ies-gray-200);">
          <div style="font-size:36px;margin-bottom:12px;">📊</div>
          <div style="font-size:16px;font-weight:700;margin-bottom:6px;">No saved models yet</div>
          <div style="font-size:13px;color:var(--ies-gray-400);margin-bottom:20px;">Start a pricing model to compute labor, equipment, overhead, and P&amp;L for a facility.</div>
          <button class="hub-btn hub-btn-primary" id="cm-create-new-alt" onclick="document.getElementById('cm-create-new').click()">+ Create New Model</button>
        </div>
      ` : (() => {
        // CM-LND-1 (2026-04-25): group saved models by linked deal so users
        // can collapse families of scenarios. Models with no deal id get
        // their own "Unassigned" group at the bottom. Collapse state is
        // persisted in localStorage so it survives navigation.
        const dealById = {};
        (savedDeals || []).forEach(d => { if (d?.id) dealById[d.id] = d; });
        const groups = new Map();
        for (const m of savedModels) {
          const key = m.deal_deals_id || '__unassigned__';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(m);
        }
        // Read collapse state
        let collapsed = {};
        try { collapsed = JSON.parse(localStorage.getItem('cm-deal-group-collapsed') || '{}'); } catch {}
        // Sort groups: real deals first (by deal_name), unassigned last
        const orderedKeys = [...groups.keys()].sort((a, b) => {
          if (a === '__unassigned__') return 1;
          if (b === '__unassigned__') return -1;
          const an = (dealById[a]?.deal_name || a).toLowerCase();
          const bn = (dealById[b]?.deal_name || b).toLowerCase();
          return an < bn ? -1 : an > bn ? 1 : 0;
        });
        const renderCard = (m) => {
          const updated = m.updated_at ? new Date(m.updated_at) : null;
          const updatedStr = updated ? updated.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
          const market = m.market_id ? (marketById[m.market_id] || m.market_id) : null;
          const safeName = (m.name || 'Untitled Model').replace(/"/g, '&quot;');
          return `
            <div class="hub-card cm-landing-card" data-cm-card="${m.id}" data-cm-name="${safeName}" draggable="true" style="padding:16px;cursor:pointer;transition:all 0.15s;border:1px solid var(--ies-gray-200);position:relative;">
              <button class="cm-landing-duplicate" data-cm-duplicate="${m.id}" data-cm-name="${safeName}" draggable="false"
                      title="Duplicate this model"
                      style="position:absolute;top:8px;right:36px;width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--ies-gray-300);cursor:pointer;border-radius:4px;font-size:13px;">
                ⎘
              </button>
              <button class="cm-landing-delete" data-cm-delete="${m.id}" data-cm-name="${safeName}" draggable="false"
                      title="Delete this model"
                      style="position:absolute;top:8px;right:8px;width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--ies-gray-300);cursor:pointer;border-radius:4px;font-size:14px;">
                ✕
              </button>
              <div style="font-size:14px;font-weight:700;margin-bottom:4px;color:var(--ies-navy);padding-right:24px;">${m.name || 'Untitled Model'}</div>
              <div style="font-size:12px;color:var(--ies-gray-500);margin-bottom:12px;">${m.client_name || '<span style=\"color:var(--ies-gray-300);\">No client</span>'}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
                ${market ? `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:var(--ies-gray-100);color:var(--ies-gray-600);">${market}</span>` : ''}
              </div>
              <div style="font-size:11px;color:var(--ies-gray-400);">Updated ${updatedStr}</div>
            </div>
          `;
        };
        return orderedKeys.map(key => {
          const items = groups.get(key) || [];
          const deal = dealById[key];
          const heading = key === '__unassigned__' ? 'Unassigned' : (deal?.deal_name || 'Untitled deal');
          const subtitle = key === '__unassigned__'
            ? 'Models not linked to a deal'
            : (deal?.client_name ? deal.client_name : '');
          const isOpen = !collapsed[key];
          return `
            <details data-cm-deal-group="${key}" ${isOpen ? 'open' : ''} style="margin-bottom:18px;">
              <summary style="cursor:pointer;padding:8px 12px;background:var(--ies-gray-50);border:1px solid var(--ies-gray-200);border-radius:8px;display:flex;align-items:center;justify-content:space-between;user-select:none;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-size:14px;font-weight:700;color:var(--ies-navy);">${heading}</span>
                  ${subtitle ? `<span style="font-size:12px;color:var(--ies-gray-500);">· ${subtitle}</span>` : ''}
                </div>
                <span style="font-size:11px;color:var(--ies-gray-500);background:var(--ies-gray-100);padding:2px 8px;border-radius:10px;">${items.length} model${items.length === 1 ? '' : 's'}</span>
              </summary>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-top:14px;">
                ${items.map(renderCard).join('')}
              </div>
            </details>
          `;
        }).join('');
      })()}
    </div>
    <style>
      .cm-landing-card:hover { border-color: var(--ies-blue) !important; box-shadow: 0 2px 8px rgba(0,71,171,0.08); transform: translateY(-1px); }
      .cm-landing-delete:hover { color: #e23d3d !important; background: rgba(226,61,61,0.08) !important; }
      .cm-landing-duplicate:hover { color: var(--ies-blue) !important; background: rgba(0,71,171,0.08) !important; }
      /* CM-LND-2 — drag-to-reassign visuals */
      .cm-landing-card[draggable="true"] { cursor: grab; }
      .cm-landing-card[draggable="true"]:active { cursor: grabbing; }
      .cm-landing-card.cm-landing-card--dragging { opacity: 0.4; }
      details[data-cm-deal-group] > summary.cm-landing-group--dragover {
        background: #eff6ff !important;
        border-color: var(--ies-blue) !important;
        box-shadow: 0 0 0 2px rgba(0,71,171,0.18) inset;
      }
      details[data-cm-deal-group] > summary.cm-landing-group--dragover::after {
        content: "Drop to move here";
        font-size: 11px;
        font-weight: 600;
        color: var(--ies-blue);
        margin-left: 12px;
      }
    </style>
  `;
}

/**
 * Brock 2026-04-20 — Labor Factors migration.
 *
 * Walks existing labor lines and creates a position catalog by clustering
 * on (activity_name, hourly_rate, employment_type). Assigns position_id to
 * each line. Idempotent: if positions already exist, only fills in missing
 * position_ids on any unmapped lines.
 *
 * Indirect labor lines also get positions (category = 'indirect') so the
 * Labor Factors catalog is comprehensive.
 */
function migrateLaborLinesToPositions(m) {
  if (!m) return;
  if (!m.shifts) m.shifts = {};
  // Brock 2026-04-21 pm: PTO + Holiday are primary hour-based inputs
  // (default 80 / 64). Legacy % fields migrate to hours if present; else
  // default. ptoPct + holidayPct are then derived (2080-based fractions)
  // for calc-layer compat — ui.js keeps them in sync on every render.
  const s = m.shifts;
  if (s.ptoHoursPerYear == null) {
    const legacyPct = Number(s.ptoPct);
    s.ptoHoursPerYear = (Number.isFinite(legacyPct) && legacyPct > 0)
      ? Math.round(legacyPct / 100 * 2080)
      : 80; // 10 days × 8 hrs
  }
  if (s.holidayHoursPerYear == null) {
    const legacyPct = Number(s.holidayPct);
    s.holidayHoursPerYear = (Number.isFinite(legacyPct) && legacyPct > 0)
      ? Math.round(legacyPct / 100 * 2080)
      : 64; // 8 holidays × 8 hrs
  }
  if (s.directUtilization == null) s.directUtilization = 85;
  // holidayTreatment retired — always reduce_hours. Legacy data can remain,
  // calc engine ignores it.

  if (!Array.isArray(m.shifts.positions)) m.shifts.positions = [];
  // Brock 2026-04-21 pm (sandbox confirmation): auto-migrate every project
  // to the 44-role standard catalog exactly once. Catalog version flag on
  // the shifts blob gates re-seeding so user edits stick on subsequent
  // loads. Existing labor lines keyword-match to the closest standard role
  // (Receive → Receiver, Each pick → Each Picker, etc.) so they stay linked
  // without the user having to re-pick.
  if (m.shifts._catalogVersion !== CATALOG_VERSION) {
    const seeded = materializeStandardPositions();
    m.shifts.positions = seeded;
    const matchByName = (name) => seeded.find(p => p.name === name) || null;

    for (const line of m.laborLines || []) {
      let hint = findStandardRoleByHint(line.activity_name || '', 'direct');
      // Temp-agency overrides (2026-04-21 PM, CATALOG_VERSION bump to 4):
      //   Material Handler + temp_agency → Temp Material Handler
      //   Equipment Operator + temp_agency → Equipment Operator (Temp)
      // Both temp variants carry their own 38% markup via catalog defaults.
      if (hint && line.employment_type === 'temp_agency') {
        if (hint.name === 'Material Handler') {
          hint = STANDARD_POSITIONS.find(p => p.name === 'Temp Material Handler') || hint;
        } else if (hint.name === 'Equipment Operator') {
          hint = STANDARD_POSITIONS.find(p => p.name === 'Equipment Operator (Temp)') || hint;
        }
      }
      const pos = hint ? matchByName(hint.name) : null;
      line.position_id = pos ? pos.id : null;
    }
    for (const line of m.indirectLaborLines || []) {
      const hint = findStandardRoleByHint(line.role || line.activity_name || '', 'indirect');
      const pos = hint ? matchByName(hint.name) : null;
      line.position_id = pos ? pos.id : null;
    }
    m.shifts._catalogVersion = CATALOG_VERSION;
  }
  // The legacy loops that auto-created activity-named positions for any
  // labor line with a null position_id have been removed (Brock 2026-04-21 pm).
  // After auto-migration, unmatched lines stay unlinked — user picks a role
  // from the Position dropdown on the Labor section. Creating activity-named
  // positions silently would re-introduce the mess we just cleaned up.
}

function createEmptyModel() {
  // Starter profile: representative mid-size 150k-sqft eComm DC. Replace values as you go.
  return {
    id: null,
    projectDetails: { name: '', clientName: '', market: '', environment: '', facilityLocation: '', contractTerm: 5, dealId: null },
    volumeLines: [
      { name: 'Receiving (Pallets)', volume: 15000, uom: 'pallets', isOutboundPrimary: false },
      { name: 'Put-Away',            volume: 15000, uom: 'pallets', isOutboundPrimary: false },
      { name: 'Orders Shipped',      volume: 80000, uom: 'orders',  isOutboundPrimary: true  },
      { name: 'Each Picks',          volume: 800000, uom: 'eaches', isOutboundPrimary: false },
      { name: 'Case Picks',          volume: 200000, uom: 'cases',  isOutboundPrimary: false },
    ],
    orderProfile: {},
    facility: { totalSqft: 150000 },
    shifts: {
      shiftsPerDay: 1, hoursPerShift: 8, daysPerWeek: 5, weeksPerYear: 52,
      // Brock 2026-04-21 pm: PTO + Holiday are now hour-based (editable ints).
      // ptoPct + holidayPct are derived at render time for calc-layer compat;
      // holidayTreatment is gone (always reduce_hours now).
      bonusPct: 5,
      ptoHoursPerYear: 80,      // 10 days × 8 hrs (editable)
      holidayHoursPerYear: 64,  // 8 holidays × 8 hrs (editable)
      directUtilization: 85,    // PF&D factor × 100. Applied to UPH per §2.1.
      // Legacy shadows kept for scenario snapshot / calc-layer compat
      ptoPct: 3.85,     // 80 / 2080
      holidayPct: 3.08, // 64 / 2080
      // Position catalog — seeded empty here to avoid TDZ on STANDARD_POSITIONS
      // at module-init time. migrateLaborLinesToPositions() seeds the 43-role
      // standard catalog on first mount when positions array is empty.
      positions: [],
    },
    // Labor lines seeded empty — users add activities and pick roles from
    // the standard Position Catalog (Brock 2026-04-21 pm).
    laborLines: [],
    indirectLaborLines: [],
    equipmentLines: [
      // Field names match renderEquipment DOM (monthly_cost / monthly_maintenance / amort_years).
      { equipment_name: 'Reach Truck',              category: 'MHE',     quantity: 4,    acquisition_type: 'lease',    monthly_cost: 850,  acquisition_cost: 0,     monthly_maintenance: 100, amort_years: 7,  notes: '' },
      { equipment_name: 'RF Scanners',              category: 'IT',      quantity: 15,   acquisition_type: 'lease',    monthly_cost: 45,   acquisition_cost: 0,     monthly_maintenance: 12,  amort_years: 5,  notes: '' },
      { equipment_name: 'Selective Pallet Racking', category: 'Racking', quantity: 3000, acquisition_type: 'purchase', monthly_cost: 0,    acquisition_cost: 95,    monthly_maintenance: 0,   amort_years: 15, notes: 'Position count' },
      { equipment_name: 'Dock Levelers',            category: 'Dock',    quantity: 20,   acquisition_type: 'purchase', monthly_cost: 0,    acquisition_cost: 4500,  monthly_maintenance: 21,  amort_years: 10, notes: '' },
      { equipment_name: 'WMS License',              category: 'IT',      quantity: 1,    acquisition_type: 'service',  monthly_cost: 8500, acquisition_cost: 0,     monthly_maintenance: 0,   amort_years: 5,  notes: 'Annual SaaS license' },
    ],
    overheadLines: [
      { category: 'Utilities',    annual_cost: 180000, driver: 'sqft',             notes: 'Electric + gas ($1.20/sqft)' },
      { category: 'Insurance',    annual_cost: 24000,  driver: 'fixed',            notes: '' },
      { category: 'Maintenance',  annual_cost: 60000,  driver: 'equipment value',  notes: '' },
      { category: 'Supplies',     annual_cost: 48000,  driver: 'per unit shipped', notes: 'Labels, tape, stretch wrap' },
    ],
    vasLines: [],
    financial: { gaMargin: 4.5, mgmtFeeMargin: 7.5, targetMargin: 12, volumeGrowth: 3, laborEscalation: 4, annualEscalation: 3, discountRate: 10, reinvestRate: 8 },
    laborCosting: {
      // Benefit Load buckets sum to defaultBurdenPct (Brock 2026-04-21 pm)
      benefitLoadPayrollTaxesPct:  8.5,
      benefitLoadWorkersCompPct:   3.5,
      benefitLoadHealthWelfarePct: 10,
      benefitLoadRetirementPct:    4,
      benefitLoadOtherPct:         6,
      defaultBurdenPct: 32, // sum of buckets — calc-engine consumer
      overtimePct: 5,
      turnoverPct: 45,
    },
    startupLines: [],
    // CM-IMPL-1 (2026-04-26) — Implementation Timeline. Default 16-wk
    // mobilization to go-live + 6-mo volume/headcount ramp curve.
    // Used by renderImplementation() and (in future) by the monthly engine
    // to derive ramp burn vs. steady-state cost. Keep simple shape so the
    // section can edit it without bespoke handlers.
    implementationTimeline: {
      goLiveWeek: 16,
      rampMonths: 6,
      phases: [
        { id: 'mobilization', name: 'Mobilization & Kickoff',     startWeek: 0,  durationWeeks: 2,  owner: 'PM',     color: '#0047AB' },
        { id: 'site_setup',   name: 'Site Setup & Fit-Out',       startWeek: 2,  durationWeeks: 6,  owner: 'Ops',    color: '#0891b2' },
        { id: 'it_cutover',   name: 'IT / WMS Cutover',           startWeek: 6,  durationWeeks: 4,  owner: 'IT',     color: '#7c3aed' },
        { id: 'training',     name: 'Hiring & Training',          startWeek: 10, durationWeeks: 4,  owner: 'HR',     color: '#d97706' },
        { id: 'go_live',      name: 'Go-Live & Stabilize',        startWeek: 14, durationWeeks: 4,  owner: 'Ops',    color: '#16a34a' },
        { id: 'ramp',         name: 'Volume Ramp to Steady-State', startWeek: 16, durationWeeks: 24, owner: 'Ops',    color: '#94a3b8' },
      ],
      // % of steady-state by month after go-live (idx 0 = month 1)
      volumeRamp:    [40, 60, 75, 85, 92, 100],
      headcountRamp: [55, 70, 85, 95, 100, 100],
    },
    pricingBuckets: [
      { id: 'mgmt_fee', name: 'Management Fee', type: 'fixed', uom: 'month' },
      { id: 'storage', name: 'Storage', type: 'variable', uom: 'pallet' },
      { id: 'inbound', name: 'Inbound Handling', type: 'variable', uom: 'pallet' },
      { id: 'pick_pack', name: 'Pick & Pack', type: 'variable', uom: 'order' },
      { id: 'each_pick', name: 'Each Pick', type: 'variable', uom: 'each' },
      { id: 'outbound', name: 'Outbound Handling', type: 'variable', uom: 'order' },
      { id: 'vas', name: 'VAS', type: 'variable', uom: 'each' },
      { id: 'case_pick', name: 'Case Pick', type: 'variable', uom: 'case' },
    ],
    // Shift Planning (2026-04-22 — Brock day-1 MVP). Null on new projects so
    // the section renders an empty matrix; lazy-created on first visit.
    shiftAllocation: null,
    // CM-VAR-1 (2026-04-26) — variance display preferences for the
    // Pricing Schedule. Travels with the model so colleagues opening the
    // same record see the same display. varianceMode: 'pct' | 'abs' | 'both'.
    uiPrefs: {
      varianceMode: 'both',
      varianceSeparateColumn: false,
    },
  };
}

/**
 * I-01 helper: pick a sensible default pricing_bucket for a new cost line
 * so it doesn't silently roll into Management Fee.
 *
 * Strategy by line type:
 *   - labor (direct):  prefer 'outbound', then first variable bucket, then first
 *   - indirect labor:  prefer 'mgmt_fee', then first fixed bucket, then first
 *   - equipment:       prefer 'mgmt_fee', then first fixed bucket, then first
 *   - overhead:        prefer 'mgmt_fee', then first fixed bucket, then first
 *   - vas:             prefer 'vas',      then first variable bucket, then first
 *   - startup:         prefer 'mgmt_fee', then first fixed bucket, then first
 *
 * Returns null when no buckets exist (caller should leave pricing_bucket unset).
 */
function defaultBucketFor(lineType) {
  const buckets = (model && model.pricingBuckets) || [];
  if (buckets.length === 0) return null;
  const byId = (id) => buckets.find(b => b.id === id);
  const firstOfType = (type) => buckets.find(b => b.type === type);
  const preference = {
    labor:    ['outbound', 'pick_pack', 'each_pick', 'case_pick'],
    indirect: ['mgmt_fee'],
    equipment:['mgmt_fee'],
    overhead: ['mgmt_fee'],
    vas:      ['vas'],
    startup:  ['mgmt_fee'],
  }[lineType] || ['mgmt_fee'];
  for (const id of preference) {
    if (byId(id)) return id;
  }
  // Fallbacks
  if (['labor', 'vas'].includes(lineType)) {
    return (firstOfType('variable') || buckets[0]).id;
  }
  return (firstOfType('fixed') || buckets[0]).id;
}

/**
 * I-02 helper: build a pricingBuckets array with rate + annualVolume
 * derived from the same cost rollup the Pricing Schedule UI shows.
 * Explicit bucket.rate values win; this is only the fallback so brand-new
 * models don't render $0 monthly revenue.
 *
 * @param {Object} summary — output of calc.computeSummary
 * @param {number} marginFrac — target margin as a 0-based fraction
 * @param {number} opHrs — operating hours per year
 * @param {number} contractYears — for startup amortization
 */
function buildEnrichedPricingBuckets(summary, marginFrac, opHrs, contractYears) {
  return computePricingSnapshot(summary, marginFrac, opHrs, contractYears).buckets;
}

/**
 * Sum the five Benefit Load buckets on `laborCosting` (Payroll Taxes,
 * Workers Comp, Health & Welfare, Retirement, Other Leave & Misc) into
 * a single Total Benefit Load %. The total is then written back to
 * `laborCosting.defaultBurdenPct` — the value every calc-engine call
 * consumes as the employer-side load. Brock 2026-04-21 pm — segments
 * the prior flat Wage Load into per-line-itemable buckets.
 */
function computeBenefitLoadTotal(lc) {
  if (!lc) return 0;
  return (
    (Number(lc.benefitLoadPayrollTaxesPct)  || 0) +
    (Number(lc.benefitLoadWorkersCompPct)   || 0) +
    (Number(lc.benefitLoadHealthWelfarePct) || 0) +
    (Number(lc.benefitLoadRetirementPct)    || 0) +
    (Number(lc.benefitLoadOtherPct)         || 0)
  );
}

/**
 * Full pricing snapshot for Summary — returns both the enriched buckets
 * (I-02) and the raw bucket costs including the '_unassigned' pseudo-bucket
 * (I-01 warning banner).
 */
function computePricingSnapshot(summary, marginFrac, opHrs, contractYears) {
  const startupWithAmort = (model.startupLines || []).map(l => ({
    ...l,
    annual_amort: (l.one_time_cost || 0) / Math.max(1, contractYears || 5),
  }));
  // Compute WITHOUT unassigned-rollup so we can see the real unassigned total.
  // The existing computeBucketCosts rolls unassigned into mgmt_fee — we want
  // the pre-rollup number for the banner, so we recompute from line data.
  const buckets = model.pricingBuckets || [];
  const bucketCosts = calc.computeBucketCosts({
    buckets,
    laborLines: model.laborLines || [],
    indirectLaborLines: model.indirectLaborLines || [],
    equipmentLines: model.equipmentLines || [],
    overheadLines: model.overheadLines || [],
    vasLines: model.vasLines || [],
    startupLines: startupWithAmort,
    facilityCost: summary.facilityCost || 0,
    operatingHours: opHrs || 0,
    facilityBucketId: model.financial?.facilityBucketId || null,
  });
  // Count lines that explicitly lack a pricing_bucket (what goes to _unassigned)
  const unassignedLines = [];
  const tally = (arr, type) => (arr || []).forEach(l => {
    if (!l.pricing_bucket) unassignedLines.push({ type, line: l });
  });
  tally(model.laborLines, 'labor');
  tally(model.indirectLaborLines, 'indirect');
  tally(model.equipmentLines, 'equipment');
  tally(model.overheadLines, 'overhead');
  tally(model.vasLines, 'vas');
  tally(model.startupLines, 'startup');

  const enrichedBuckets = calc.enrichBucketsWithDerivedRates({
    buckets,
    bucketCosts,
    marginPct: marginFrac || 0,
    volumeLines: model.volumeLines || [],
  });

  return {
    buckets: enrichedBuckets,
    bucketCosts,
    unassignedCount: unassignedLines.length,
    unassignedLines,
  };
}

function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// ============================================================
// SECTION 14: TIMELINE (Phase 1)
// ============================================================

/**
 * Monthly P&L + cumulative cash flow rendered from the monthly bundle.
 * When the flag is off or no bundle exists, shows a helpful empty state.
 */
// ============================================================
// IMPLEMENTATION TIMELINE (CM-IMPL-1, 2026-04-26)
// ============================================================
//
// Project-management view of the deal's stand-up: mobilization → site
// setup → IT cutover → training → go-live → volume ramp. Distinct from
// Cashflow & P&L (which shows post-go-live monthly $ flows). This section
// captures the WHEN of implementation: phase Gantt + ramp curves that
// scale steady-state FTE/volume into months 1-N after go-live.
//
// Model shape:
//   model.implementationTimeline = {
//     goLiveWeek:     number,           // week of contract start when ops go live
//     rampMonths:     number,           // months from go-live to steady-state
//     phases:         Array<{id, name, startWeek, durationWeeks, owner, color}>,
//     volumeRamp:     number[],         // % of steady-state by month
//     headcountRamp:  number[],         // % of steady-state FTE by month
//   }
//
// All edits flow through the standard data-array delegation handler so
// no bespoke wiring is needed beyond add/delete row buttons.

function renderImplementation() {
  // Lazy-init for legacy models that pre-date the section
  if (!model.implementationTimeline) {
    model.implementationTimeline = createEmptyModel().implementationTimeline;
  }
  const it = model.implementationTimeline;
  const phases = Array.isArray(it.phases) ? it.phases : [];
  const volumeRamp = Array.isArray(it.volumeRamp) ? it.volumeRamp : [];
  const headcountRamp = Array.isArray(it.headcountRamp) ? it.headcountRamp : [];

  // Compute total implementation timeline span (max end-week across all phases)
  const totalWeeks = phases.reduce((mx, ph) =>
    Math.max(mx, (Number(ph.startWeek) || 0) + (Number(ph.durationWeeks) || 0)), 0
  ) || 24;
  const goLiveWeek = Number(it.goLiveWeek) || 16;
  const rampMonths = Number(it.rampMonths) || volumeRamp.length || 6;

  // Pull steady-state metrics from current model so the ramp curves
  // have real $/FTE numbers to project against.
  const opHrs = calc.operatingHours(model.shifts || {});
  const lc = model.laborCosting || {};
  const totalFtes = (model.laborLines || []).reduce((s, l) => s + calc.fte(l, opHrs), 0);
  const steadyDirectCost = (model.laborLines || []).reduce((s, l) =>
    s + calc.directLineAnnualSimple(l, lc), 0);
  const steadyMonthlyCost = steadyDirectCost / 12;

  // Total implementation spend = sum of startupLines (one-time setup outlay)
  const totalImplSpend = (model.startupLines || []).reduce((s, l) =>
    s + (Number(l.cost) || Number(l.annual_cost) || 0), 0);

  // Build week-bar Gantt — week ticks every 4 weeks for readability
  const tickInterval = totalWeeks <= 16 ? 2 : 4;
  const ticks = [];
  for (let w = 0; w <= totalWeeks; w += tickInterval) ticks.push(w);
  if (ticks[ticks.length - 1] !== totalWeeks) ticks.push(totalWeeks);

  return `
    <div class="cm-section-header">
      <div class="cm-section-header__intro">
        <div>
          <h2>Implementation <span class="hub-status-chip cm-chip-info cm-chip-xs">project plan</span></h2>
          <div class="cm-section-desc">Phase plan + ramp curves from contract sign through steady-state. Volume / headcount ramp scales the steady-state numbers from <strong>Labor</strong> and <strong>Volumes</strong> across months 1-${rampMonths} after go-live.</div>
        </div>
      </div>
    </div>

    <!-- KPI strip -->
    <div class="hub-kpi-strip" style="margin-bottom:16px;">
      <div class="hub-kpi-tile" title="Calendar week of contract start when ops officially begin handling volume">
        <div class="hub-kpi-tile__label">Go-Live Week</div>
        <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">W${goLiveWeek}</div>
      </div>
      <div class="hub-kpi-tile" title="Months from go-live to steady-state operations">
        <div class="hub-kpi-tile__label">Ramp Period</div>
        <div class="hub-kpi-tile__value">${rampMonths} mo</div>
      </div>
      <div class="hub-kpi-tile" title="Total implementation phases on the plan">
        <div class="hub-kpi-tile__label">Phases</div>
        <div class="hub-kpi-tile__value">${phases.length}</div>
      </div>
      <div class="hub-kpi-tile" title="Sum of all start-up lines — one-time outlay before steady-state operations">
        <div class="hub-kpi-tile__label">Implementation Spend</div>
        <div class="hub-kpi-tile__value" style="color:var(--ies-orange,#d97706);">${calc.formatCurrency(totalImplSpend)}</div>
      </div>
    </div>

    <!-- Phase Gantt -->
    <div class="cm-card" style="margin-bottom:16px;">
      <div class="cm-section-header__intro" style="margin-bottom:12px;">
        <div>
          <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Phase Plan</h3>
          <div class="cm-subtle" style="font-size:12px;">Drag start week / duration in the table below to reshape. Bars below visualize the schedule.</div>
        </div>
        <div class="cm-section-header__actions">
          <button class="hub-btn hub-btn-sm" data-action="impl-add-phase" title="Add a new phase to the plan">+ Add Phase</button>
        </div>
      </div>

      <!-- Gantt visualization -->
      <div class="cm-impl-gantt" style="margin:8px 0 16px;">
        <div class="cm-impl-gantt__ruler">
          <div class="cm-impl-gantt__ruler-label">&nbsp;</div>
          <div class="cm-impl-gantt__ruler-track" style="position:relative;height:18px;border-bottom:1px solid var(--ies-gray-200);">
            ${ticks.map(w => `
              <div style="position:absolute;left:${(w / totalWeeks * 100).toFixed(2)}%;top:0;bottom:0;border-left:1px dashed var(--ies-gray-200);">
                <span style="position:absolute;top:0;left:2px;font-size:10px;color:var(--ies-gray-500);font-weight:600;">W${w}</span>
              </div>
            `).join('')}
            <div style="position:absolute;left:${(goLiveWeek / totalWeeks * 100).toFixed(2)}%;top:-4px;bottom:-4px;border-left:2px solid var(--ies-green,#16a34a);" title="Go-Live (W${goLiveWeek})">
              <span style="position:absolute;top:-14px;left:-26px;font-size:9px;font-weight:700;color:var(--ies-green,#16a34a);background:#fff;padding:1px 4px;border-radius:3px;border:1px solid var(--ies-green,#16a34a);white-space:nowrap;">GO-LIVE</span>
            </div>
          </div>
        </div>
        ${phases.map((ph, i) => {
          const startPct = (Number(ph.startWeek) || 0) / totalWeeks * 100;
          const widthPct = Math.max(0.5, (Number(ph.durationWeeks) || 0) / totalWeeks * 100);
          return `
            <div class="cm-impl-gantt__row">
              <div class="cm-impl-gantt__ruler-label" title="${escapeAttr(ph.name || '')}">${escapeHtml(ph.name || `Phase ${i + 1}`)}</div>
              <div class="cm-impl-gantt__ruler-track" style="position:relative;height:24px;">
                <div class="cm-impl-gantt__bar" style="position:absolute;left:${startPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;top:4px;bottom:4px;background:${ph.color || 'var(--ies-blue)'};border-radius:4px;display:flex;align-items:center;padding:0 6px;color:#fff;font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeAttr(ph.name)} — W${ph.startWeek} to W${(ph.startWeek || 0) + (ph.durationWeeks || 0)} (${ph.durationWeeks}w)${ph.owner ? ' · ' + ph.owner : ''}">
                  ${escapeHtml(ph.owner || '')} · ${ph.durationWeeks}w
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <!-- Editable phase table -->
      <table class="cm-table" style="width:100%;">
        <thead>
          <tr>
            <th style="width:32%;">Phase</th>
            <th style="width:13%;">Owner</th>
            <th style="width:13%;text-align:right;">Start Week</th>
            <th style="width:13%;text-align:right;">Duration (wk)</th>
            <th style="width:13%;text-align:right;">End Week</th>
            <th style="width:10%;">Color</th>
            <th style="width:6%;"></th>
          </tr>
        </thead>
        <tbody>
          ${phases.length === 0 ? `
            <tr><td colspan="7" class="cm-empty-state" style="text-align:center;padding:24px;color:var(--ies-gray-400);">No phases defined. Click <strong>+ Add Phase</strong> to start.</td></tr>
          ` : phases.map((ph, i) => {
            const endWeek = (Number(ph.startWeek) || 0) + (Number(ph.durationWeeks) || 0);
            return `
              <tr>
                <td><input class="hub-input" value="${escapeAttr(ph.name || '')}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="name" placeholder="Phase name" /></td>
                <td><input class="hub-input" value="${escapeAttr(ph.owner || '')}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="owner" placeholder="PM / IT / Ops" /></td>
                <td><input class="hub-input hub-num" type="number" min="0" step="1" value="${Number(ph.startWeek) || 0}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="startWeek" data-type="number" /></td>
                <td><input class="hub-input hub-num" type="number" min="0" step="1" value="${Number(ph.durationWeeks) || 0}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="durationWeeks" data-type="number" /></td>
                <td style="text-align:right;font-weight:600;color:var(--ies-gray-600);">W${endWeek}</td>
                <td><input type="color" value="${escapeAttr(ph.color || '#0047AB')}" data-array="implementationTimeline.phases" data-idx="${i}" data-field="color" style="width:36px;height:26px;padding:0;border:1px solid var(--ies-gray-200);border-radius:4px;cursor:pointer;" /></td>
                <td style="text-align:center;"><button class="cm-delete-btn" data-action="impl-delete-phase" data-idx="${i}" title="Delete phase">×</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>

    <!-- Ramp curves: 2-col grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">

      <!-- Volume Ramp -->
      <div class="cm-card">
        <div class="cm-section-header__intro" style="margin-bottom:8px;">
          <div>
            <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Volume Ramp</h3>
            <div class="cm-subtle" style="font-size:12px;">% of steady-state volume by month after go-live</div>
          </div>
        </div>
        ${renderImplRampTable('volumeRamp', volumeRamp, 'Volume')}
        ${renderImplRampSparkline(volumeRamp, '#0047AB')}
      </div>

      <!-- Headcount Ramp -->
      <div class="cm-card">
        <div class="cm-section-header__intro" style="margin-bottom:8px;">
          <div>
            <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Headcount Ramp</h3>
            <div class="cm-subtle" style="font-size:12px;">% of steady-state direct FTE by month after go-live</div>
          </div>
        </div>
        ${renderImplRampTable('headcountRamp', headcountRamp, 'FTE')}
        ${renderImplRampSparkline(headcountRamp, '#d97706')}
      </div>
    </div>

    <!-- Ramp Burn Estimate (read-only, derives from labor + ramp curves) -->
    <div class="cm-card">
      <div class="cm-section-header__intro" style="margin-bottom:8px;">
        <div>
          <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Ramp Burn Estimate <span class="hub-status-chip cm-chip-info cm-chip-xs">read-only</span></h3>
          <div class="cm-subtle" style="font-size:12px;">Direct labor cost during each ramp month — multiplies steady-state monthly direct labor (${calc.formatCurrency(steadyMonthlyCost)}) by the headcount ramp %. Steady-state baseline: <strong>${totalFtes.toFixed(1)} FTE</strong> · <strong>${calc.formatCurrency(steadyDirectCost)}</strong>/yr.</div>
        </div>
      </div>
      <table class="cm-table" style="width:100%;">
        <thead>
          <tr>
            <th>Month After Go-Live</th>
            <th style="text-align:right;">Headcount %</th>
            <th style="text-align:right;">Implied FTE</th>
            <th style="text-align:right;">Volume %</th>
            <th style="text-align:right;">Direct Labor Cost</th>
            <th style="text-align:right;">Δ vs steady-state</th>
          </tr>
        </thead>
        <tbody>
          ${headcountRamp.map((pct, i) => {
            const hcPct = Number(pct) || 0;
            const volPct = Number(volumeRamp[i]) || 0;
            const impliedFte = totalFtes * (hcPct / 100);
            const monthlyCost = steadyMonthlyCost * (hcPct / 100);
            const delta = monthlyCost - steadyMonthlyCost;
            const deltaColor = delta < 0 ? 'var(--ies-green,#16a34a)' : (delta > 0 ? 'var(--ies-red,#dc2626)' : 'var(--ies-gray-500)');
            return `
              <tr>
                <td><strong>Month ${i + 1}</strong></td>
                <td style="text-align:right;">${hcPct}%</td>
                <td style="text-align:right;">${impliedFte.toFixed(1)}</td>
                <td style="text-align:right;color:var(--ies-gray-500);">${volPct}%</td>
                <td style="text-align:right;font-weight:600;">${calc.formatCurrency(monthlyCost)}</td>
                <td style="text-align:right;color:${deltaColor};">${delta === 0 ? '—' : (delta > 0 ? '+' : '') + calc.formatCurrency(delta)}</td>
              </tr>
            `;
          }).join('')}
          <tr style="background:var(--ies-gray-50);font-weight:700;border-top:2px solid var(--ies-gray-200);">
            <td>Steady-state (Month ${headcountRamp.length + 1}+)</td>
            <td style="text-align:right;">100%</td>
            <td style="text-align:right;">${totalFtes.toFixed(1)}</td>
            <td style="text-align:right;color:var(--ies-gray-500);">100%</td>
            <td style="text-align:right;">${calc.formatCurrency(steadyMonthlyCost)}</td>
            <td style="text-align:right;color:var(--ies-gray-500);">baseline</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Settings strip -->
    <div class="cm-card" style="margin-top:16px;">
      <div class="cm-section-header__intro" style="margin-bottom:8px;">
        <div>
          <h3 style="margin:0;font-size:14px;font-weight:700;color:var(--ies-navy);">Settings</h3>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:14px;">
        <div class="hub-field">
          <label class="hub-field__label">Go-Live Week (W#)</label>
          <input class="hub-input hub-num" type="number" min="0" step="1" value="${goLiveWeek}" data-field-direct="implementationTimeline.goLiveWeek" data-type="number" />
          <div class="hub-field__hint">Week of contract start when operations begin.</div>
        </div>
        <div class="hub-field">
          <label class="hub-field__label">Ramp Period (months)</label>
          <input class="hub-input hub-num" type="number" min="1" max="24" step="1" value="${rampMonths}" data-field-direct="implementationTimeline.rampMonths" data-type="number" />
          <div class="hub-field__hint">Months from go-live to steady-state. Click <strong>Resize Ramps</strong> below if you change this.</div>
        </div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="impl-resize-ramps" title="Re-shape volume + headcount ramp arrays to match the Ramp Period above">Resize Ramp Curves</button>
        <button class="hub-btn hub-btn-sm hub-btn-secondary" data-action="impl-reset-defaults" title="Reset all phases + ramp curves to defaults">Reset to Defaults</button>
      </div>
    </div>
  `;
}

/**
 * Helper: render a one-row editable table for a ramp curve array.
 * Uses the _direct scalar-array pattern in the data-array handler.
 */
function renderImplRampTable(arrayKey, values, label) {
  return `
    <table class="cm-table" style="width:100%;">
      <thead>
        <tr>
          <th>${escapeHtml(label)} %</th>
          ${values.map((_, i) => `<th style="text-align:center;">M${i + 1}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>%</strong></td>
          ${values.map((v, i) => `
            <td style="text-align:center;">
              <input class="hub-input hub-num" type="number" min="0" max="200" step="5" value="${Number(v) || 0}"
                data-array="implementationTimeline.${arrayKey}" data-idx="${i}" data-field="_direct" data-type="number"
                style="width:56px;text-align:center;" />
            </td>
          `).join('')}
        </tr>
      </tbody>
    </table>
  `;
}

/**
 * Helper: render an inline SVG sparkline for a ramp curve. No
 * external chart library — this is a small visualization.
 */
function renderImplRampSparkline(values, color) {
  if (!values || values.length === 0) return '';
  const w = 240, h = 60, pad = 6;
  const maxVal = Math.max(100, ...values.map(v => Number(v) || 0));
  const stepX = (w - 2 * pad) / Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((Number(v) || 0) / maxVal) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // Steady-state reference line at 100%
  const ssY = h - pad - (100 / maxVal) * (h - 2 * pad);
  return `
    <div style="margin-top:8px;text-align:center;">
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;height:${h}px;" aria-hidden="true">
        <line x1="${pad}" y1="${ssY}" x2="${w - pad}" y2="${ssY}" stroke="var(--ies-gray-300)" stroke-dasharray="3,3" stroke-width="1" />
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
        ${values.map((v, i) => {
          const x = pad + i * stepX;
          const y = h - pad - ((Number(v) || 0) / maxVal) * (h - 2 * pad);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}" />`;
        }).join('')}
      </svg>
    </div>
  `;
}

function renderTimeline() {
  const flagOn = typeof window !== 'undefined' && window.COST_MODEL_MONTHLY_ENGINE !== false;
  const frozenBanner = renderFrozenBanner();

  if (!flagOn) {
    return `
      ${frozenBanner}
      <div class="cm-section">
        <h2 class="cm-section-title">Cashflow &amp; P&amp;L <span style="font-size:11px;color:var(--ies-gray-400);font-weight:500;margin-left:8px;">Legacy mode</span></h2>
        <div class="hub-card" style="background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:16px;">
          <strong>Monthly engine is disabled.</strong> Re-enable it in the browser console to view the cashflow projection:
          <code style="display:block;margin-top:8px;background:#fff;padding:8px;border-radius:4px;font-family:monospace;">window.COST_MODEL_MONTHLY_ENGINE = true;</code>
        </div>
      </div>
    `;
  }

  // Build the bundle on demand so Timeline works without a Summary round-trip.
  const bundle = ensureMonthlyBundle();

  if (!bundle || !bundle.cashflow || bundle.cashflow.length === 0) {
    return `
      <div class="cm-section">
        <h2 class="cm-section-title">Cashflow &amp; P&amp;L</h2>
        <div class="hub-card" style="padding:24px;text-align:center;color:var(--ies-gray-400);">
          Add labor, equipment, and pricing inputs to generate the monthly cashflow & P&L. Empty models have no data to render.
        </div>
      </div>
    `;
  }

  // Aggregate monthly cashflow for the Timeline table
  const periods = bundle.periods;
  const byId = new Map(periods.map(p => [p.id, p]));
  const rows = bundle.cashflow.map(cf => {
    const p = byId.get(cf.period_id);
    return {
      label: p?.label || '',
      period_index: p?.period_index ?? 0,
      is_pre_go_live: p?.is_pre_go_live ?? false,
      revenue: cf.revenue,
      opex: cf.opex,
      ebitda: cf.ebitda,
      net_income: cf.net_income,
      capex: cf.capex,
      ocf: cf.operating_cash_flow,
      fcf: cf.free_cash_flow,
      cum_fcf: cf.cumulative_cash_flow,
    };
  }).sort((a, b) => a.period_index - b.period_index);

  // Year-over-year totals for a quick summary strip
  const yearly = {};
  for (const r of rows) {
    if (r.is_pre_go_live) continue;
    const yr = Math.floor(r.period_index / 12) + 1;
    if (!yearly[yr]) yearly[yr] = { revenue: 0, opex: 0, net_income: 0, fcf: 0 };
    yearly[yr].revenue    += r.revenue;
    yearly[yr].opex       += r.opex;
    yearly[yr].net_income += r.net_income;
    yearly[yr].fcf        += r.fcf;
  }

  const fmt = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  };

  // Cumulative-cash-flow trend colors
  const payback = rows.find(r => r.cum_fcf >= 0 && !r.is_pre_go_live);

  const lastCumFcf = rows[rows.length - 1].cum_fcf;

  return `
    ${frozenBanner}
    <div class="cm-section">
      <div class="cm-timeline-meta">
        <h2 class="cm-timeline-meta__title">Cashflow &amp; P&amp;L</h2>
        <span class="cm-timeline-meta__hint">${rows.length} months · Phase 1 monthly engine</span>
      </div>

      <!-- KPI strip (primitives kit) — hover any tile for breakdown -->
      <div class="hub-kpi-strip mb-4">
        <div class="hub-kpi-tile" data-cm-disclose="cf-total-revenue" title="Hover for breakdown · Sum of all monthly revenue">
          <div class="hub-kpi-tile__label">Total Revenue</div>
          <div class="hub-kpi-tile__value hub-kpi-tile__value--brand">$${fmt(rows.reduce((s, r) => s + r.revenue, 0))}</div>
        </div>
        <div class="hub-kpi-tile" data-cm-disclose="cf-total-opex" title="Hover for breakdown · Sum of all monthly opex">
          <div class="hub-kpi-tile__label">Total Opex</div>
          <div class="hub-kpi-tile__value">$${fmt(rows.reduce((s, r) => s + r.opex, 0))}</div>
        </div>
        <div class="hub-kpi-tile" data-cm-disclose="cf-cum-fcf" title="Hover for breakdown · Cumulative free cash flow at end of contract">
          <div class="hub-kpi-tile__label">Cumulative FCF</div>
          <div class="hub-kpi-tile__value" style="color:${lastCumFcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(lastCumFcf)}</div>
        </div>
        <div class="hub-kpi-tile" data-cm-disclose="cf-payback" title="Hover for breakdown · First month cumulative FCF turns positive">
          <div class="hub-kpi-tile__label">Payback Month</div>
          <div class="hub-kpi-tile__value">${payback ? payback.label : '—'}</div>
        </div>
      </div>

      <!-- Year summary -->
      <div class="hub-card mb-4">
        <h3 class="hub-section-heading">Annual Roll-Up</h3>
        <table class="hub-datatable hub-datatable--dense">
          <thead><tr><th>Year</th><th class="hub-num">Revenue</th><th class="hub-num">Opex</th><th class="hub-num">Net Income</th><th class="hub-num">FCF</th></tr></thead>
          <tbody>
            ${Object.entries(yearly).map(([yr, y]) => `
              <tr>
                <td>Y${yr}</td>
                <td class="hub-num">$${fmt(y.revenue)}</td>
                <td class="hub-num">$${fmt(y.opex)}</td>
                <td class="hub-num">$${fmt(y.net_income)}</td>
                <td class="hub-num" style="color:${y.fcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(y.fcf)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Monthly cashflow table (first 24 months + cumulative) -->
      <div class="hub-card">
        <h3 class="hub-section-heading">Monthly Cashflow (first 24 months)</h3>
        <div class="cm-timeline-monthly-scroll">
          <table class="hub-datatable hub-datatable--dense">
            <thead>
              <tr>
                <th>Month</th>
                <th class="hub-num">Revenue</th>
                <th class="hub-num">Opex</th>
                <th class="hub-num">EBITDA</th>
                <th class="hub-num">Net Income</th>
                <th class="hub-num">CapEx</th>
                <th class="hub-num">FCF</th>
                <th class="hub-num">Cum FCF</th>
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 24).map(r => `
                <tr class="${r.is_pre_go_live ? 'cm-timeline-pre-go-live' : ''}">
                  <td style="font-weight:600;">${r.label}${r.is_pre_go_live ? ' <span class="cm-timeline-pre-go-live-tag">pre-live</span>' : ''}</td>
                  <td class="hub-num">$${fmt(r.revenue)}</td>
                  <td class="hub-num">$${fmt(r.opex)}</td>
                  <td class="hub-num">$${fmt(r.ebitda)}</td>
                  <td class="hub-num">$${fmt(r.net_income)}</td>
                  <td class="hub-num">${r.capex > 0 ? '$' + fmt(r.capex) : '—'}</td>
                  <td class="hub-num" style="color:${r.fcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(r.fcf)}</td>
                  <td class="hub-num" style="font-weight:700;color:${r.cum_fcf >= 0 ? 'var(--ies-green)' : 'var(--ies-red)'};">$${fmt(r.cum_fcf)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${rows.length > 24 ? `<div class="hub-field__hint mt-2">…${rows.length - 24} more months (full 60-month view coming in the Phase 5 assumption studio)</div>` : ''}
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 15: ASSUMPTIONS (Phase 3 — design heuristics catalog + overrides)
// ============================================================

/**
 * Lazy-load the heuristics catalog + override jsonb. Called from bindSectionEvents
 * when the Assumptions section is first opened so mount() stays fast.
 */
async function ensureHeuristicsLoaded() {
  if (heuristicsCatalog.length === 0) {
    try { heuristicsCatalog = await api.fetchDesignHeuristics(); }
    catch (e) { console.warn('[CM] ensureHeuristicsLoaded:', e); heuristicsCatalog = []; }
  }
  // Overrides come from the project jsonb; re-fetch from the active model on each call.
  const projectId = model?.id;
  if (projectId) {
    try {
      const p = await api.getModel(projectId);
      heuristicOverrides = p?.heuristic_overrides || {};
    } catch (_) { heuristicOverrides = {}; }
  } else {
    // Unsaved model — keep local overrides in the model itself
    heuristicOverrides = model?.heuristicOverrides || {};
  }
}

const HEURISTIC_CATEGORY_LABELS = {
  financial: 'Financial',
  working_capital: 'Working Capital',
  labor: 'Labor',
  ramp_seasonality: 'Ramp & Seasonality',
  ops_escalation: 'Operations & Escalation',
};

/**
 * Phase 6 — load the planning-ratios catalog + categories + per-project
 * overrides. Mirrors ensureHeuristicsLoaded(). Guarded against re-entry.
 */
async function ensurePlanningRatiosLoaded() {
  if (_planningRatiosLoadInFlight) return;
  _planningRatiosLoadInFlight = true;
  try {
    if (planningRatiosCatalog.length === 0 || planningRatioCategories.length === 0) {
      const [cats, rows] = await Promise.all([
        api.fetchPlanningRatioCategories().catch(() => []),
        api.fetchPlanningRatios().catch(() => []),
      ]);
      planningRatioCategories = cats || [];
      planningRatiosCatalog = rows || [];
    }
    const projectId = model?.id;
    if (projectId) {
      try {
        const p = await api.getModel(projectId);
        planningRatioOverrides = (p && p.planning_ratio_overrides) || {};
      } catch (_) { planningRatioOverrides = {}; }
    } else {
      planningRatioOverrides = (model && model.planningRatioOverrides) || {};
    }
  } finally {
    _planningRatiosLoadInFlight = false;
  }
}

/**
 * Feature flag — default ON. Set `window.COST_MODEL_PLANNING_RATIOS = false`
 * in console to hide the Planning Ratios sub-section without touching code.
 */
function isPlanningRatiosFlagOn() {
  return typeof window === 'undefined' || window.COST_MODEL_PLANNING_RATIOS !== false;
}

/**
 * Format a ratio's effective value for display. Coerces percent to "%" and
 * respects value_unit hints. Structured types (array/lookup/tiered) render
 * as a terse summary.
 */
function formatRatioValue(resolved) {
  if (!resolved || resolved.value === null || resolved.value === undefined) return '—';
  const { value, def } = resolved;
  if (def && (def.value_type === 'array' || def.value_type === 'lookup' || def.value_type === 'tiered')) {
    if (Array.isArray(value)) return `[${value.length} values]`;
    if (typeof value === 'object') return `{${Object.keys(value).length} keys}`;
    return String(value);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (def && def.value_type === 'percent') return `${(n * 100).toFixed(n >= 0.1 ? 1 : 2)}%`;
  if (def && def.value_type === 'psf') return `$${n.toFixed(3)}`;
  if (def && def.value_type === 'per_unit') return `$${n.toLocaleString()}`;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

/** Returns { value, isStructured } for editor rendering. */
function ratioEditorValue(code, def) {
  const ov = planningRatioOverrides[code];
  if (ov && ov.value !== null && ov.value !== undefined && ov.value !== '') return { value: ov.value, isStructured: false };
  if (!def) return { value: '', isStructured: false };
  if (def.value_type === 'array' || def.value_type === 'lookup' || def.value_type === 'tiered') {
    return { value: null, isStructured: true };
  }
  return { value: '', isStructured: false };
}

function renderAssumptions() {
  const cat = heuristicsCatalog;
  if (!cat || cat.length === 0) {
    return `
      <div class="cm-section-header">
        <h2>Assumptions</h2>
        <div class="cm-section-header__intro">
          <p class="cm-subtle">All design heuristics that shape this scenario's math.</p>
        </div>
      </div>
      <div class="cm-empty-state">Loading heuristics catalog…</div>
    `;
  }

  const overrideCount = scenarios.countOverrideChanges(cat, heuristicOverrides);
  const grouped = new Map();
  for (const h of cat) {
    if (!grouped.has(h.category)) grouped.set(h.category, []);
    grouped.get(h.category).push(h);
  }

  const fmtEffective = (h) => {
    const eff = scenarios.heuristicEffective(h, heuristicOverrides);
    if (eff === null || eff === undefined || eff === '') return '—';
    return String(eff);
  };
  const fmtDefault = (h) => {
    if (h.data_type === 'enum') return h.default_enum || '—';
    return h.default_value !== null && h.default_value !== undefined ? String(h.default_value) : '—';
  };
  const isOverride = (h) => {
    if (!Object.prototype.hasOwnProperty.call(heuristicOverrides, h.key)) return false;
    const v = heuristicOverrides[h.key];
    if (v === null || v === undefined || v === '') return false;
    const def_val = h.data_type === 'enum' ? h.default_enum : h.default_value;
    return String(v) !== String(def_val);
  };

  return `
    <div class="cm-section-header">
      <h2>Assumptions
        ${overrideCount > 0
          ? `<span class="hub-status-chip cm-chip-warn">${overrideCount} override${overrideCount === 1 ? '' : 's'}</span>`
          : `<span class="hub-status-chip cm-chip-info">all standard values</span>`}
      </h2>
      <div class="cm-section-header__intro">
        <p class="cm-subtle">Design heuristics drive the calc engine beyond the external rate cards. Defaults come from GXO/IES standards. Overrides are captured per scenario and frozen at approval time.</p>
        <div class="cm-section-header__actions">
          <button class="hub-btn hub-btn-sm" data-cm-action="reset-all-heuristics">↺ Reset all to defaults</button>
        </div>
      </div>
    </div>

    ${Array.from(grouped.entries()).map(([category, items]) => `
      <div class="cm-card">
        <h3>${HEURISTIC_CATEGORY_LABELS[category] || category}</h3>
        <table class="cm-table">
          <thead>
            <tr>
              <th>Heuristic</th>
              <th style="width:30%;">Description</th>
              <th class="cm-th-num" style="width:90px;">Default</th>
              <th class="cm-th-num" style="width:140px;">Your Value</th>
              <th class="cm-th-center" style="width:70px;">Reset</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(h => `
              <tr data-heuristic-key="${h.key}"${isOverride(h) ? ' class="cm-row--override"' : ''}>
                <td>
                  <div class="cm-cell-title">${h.label}</div>
                  <div class="cm-cell-meta">${h.key}${h.unit ? ` · ${h.unit}` : ''}</div>
                </td>
                <td class="cm-cell-notes">${h.description || ''}</td>
                <td class="cm-num">${fmtDefault(h)}</td>
                <td class="cm-num">
                  ${h.data_type === 'enum'
                    ? `<select class="hub-input" data-heuristic-input="${h.key}" style="width:130px;">
                         ${(Array.isArray(h.allowed_enums) ? h.allowed_enums : []).map(opt => `<option value="${opt}" ${String(heuristicOverrides[h.key] || h.default_enum) === String(opt) ? 'selected' : ''}>${opt}</option>`).join('')}
                       </select>`
                    : `<input class="hub-input" type="number" step="any" data-heuristic-input="${h.key}" value="${heuristicOverrides[h.key] !== undefined && heuristicOverrides[h.key] !== null ? heuristicOverrides[h.key] : ''}" placeholder="${fmtDefault(h)}" style="width:120px;text-align:right;" />`
                  }
                </td>
                <td style="text-align:center;">
                  ${isOverride(h) ? `<button class="hub-btn hub-btn-sm" data-cm-action="reset-heuristic" data-heuristic-key="${h.key}" title="Reset to default">↺</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('')}

    ${renderPlanningRatios()}
  `;
}

/**
 * Phase 6 — render the 142-rule Planning Ratios catalog as a collapsible
 * library below the 26-row Assumptions. Each category card expands to show
 * its rules with source + applicability + override. Feature-flagged.
 */
function renderPlanningRatios() {
  if (!isPlanningRatiosFlagOn()) return '';
  if (!planningRatiosCatalog.length) {
    return `
      <div class="cm-section-divider"></div>
      <div class="cm-card">
        <h3>Planning Ratios <span class="hub-status-chip cm-chip-info">Loading…</span></h3>
        <p class="cm-subtle">Engineering defaults catalog (spans of control, facility ratios, storage PSF, seasonality, …).</p>
      </div>
    `;
  }

  const ctx = {
    vertical: (model && model.projectDetails && model.projectDetails.vertical) || null,
    environment_type: (model && model.projectDetails && model.projectDetails.environment) || null,
    automation_level: null,
    market_tier: null,
  };
  const grouped = planningRatios.groupByCategory(planningRatiosCatalog, planningRatioCategories);
  const overrideCount = planningRatios.countRatioOverrides(planningRatioOverrides);
  // 2026-04-21 PM: count stale-unreviewed across all categories for the audit
  // banner. Once a row is marked reviewed on this project, it's excluded from
  // this count (even if the catalog source_date is still pre-2022).
  const staleUnreviewedCount = planningRatios.countStaleUnreviewed(planningRatiosCatalog, planningRatioOverrides);

  return `
    <div class="cm-section-divider"></div>
    <div class="cm-section-header">
      <h2>Planning Ratios
        ${overrideCount > 0
          ? `<span class="hub-status-chip cm-chip-warn">${overrideCount} override${overrideCount === 1 ? '' : 's'}</span>`
          : `<span class="hub-status-chip cm-chip-info">${planningRatiosCatalog.length} rules · ${planningRatioCategories.length} categories</span>`}
        ${staleUnreviewedCount > 0
          ? `<span class="hub-status-chip cm-chip-stale" title="${staleUnreviewedCount} rule${staleUnreviewedCount === 1 ? '' : 's'} with pre-2022 catalog source that haven't been audited on this project">${staleUnreviewedCount} need${staleUnreviewedCount === 1 ? 's' : ''} audit</span>`
          : ''}
      </h2>
      <div class="cm-section-header__intro">
        <p class="cm-subtle">Engineering defaults extracted from the reference 3PL cost model. Spans of control, space ratios, storage $/SF components, seasonality by vertical, asset loaded-cost factors. Override per-scenario; defaults apply to all projects otherwise.</p>
      </div>
      ${staleUnreviewedCount > 0 ? `
        <div class="cm-audit-banner">
          <div class="cm-audit-banner-label">
            <strong>${staleUnreviewedCount}</strong> rule${staleUnreviewedCount === 1 ? '' : 's'} cite a source dated before 2022. Audit the values for this deal, then click "Mark reviewed" on each row (or use the bulk action) to clear the flag.
          </div>
          <div class="cm-audit-banner-actions">
            <button class="hub-btn hub-btn-sm" data-cm-action="expand-all-stale-categories" title="Expand every category that contains a stale rule so you can review them inline.">Show all stale</button>
            <button class="hub-btn hub-btn-sm" data-cm-action="mark-all-stale-reviewed" title="Stamp every stale rule on this project as reviewed. Doesn't change any values; just clears the audit banner so the page reads clean once you've actually checked the numbers.">Mark all reviewed</button>
          </div>
        </div>
      ` : ''}
    </div>

    ${grouped.map(({ category, rows }) => {
      if (!rows.length) return '';
      const isOpen = _planningRatioOpenCategory === category.code;
      const resolvedList = rows.map(r => ({
        row: r,
        resolved: planningRatios.lookupRatio(r.ratio_code, ctx, planningRatiosCatalog, planningRatioOverrides),
      }));
      const overridesInCategory = resolvedList.filter(x => x.resolved.source === 'override').length;
      const staleCount = rows.filter(r => planningRatios.isStale(r)).length;
      return `
        <div class="cm-card cm-card--collapsible" data-open="${isOpen ? 'true' : 'false'}">
          <button class="cm-card-toggle" data-pr-toggle-category="${category.code}">
            <span class="cm-card-toggle__title">${escapeHtml(category.display_name)}</span>
            ${overridesInCategory > 0 ? `<span class="hub-status-chip cm-chip-warn">${overridesInCategory} override${overridesInCategory === 1 ? '' : 's'}</span>` : ''}
            ${staleCount > 0 ? `<span class="hub-status-chip cm-chip-stale" title="${staleCount} row(s) with pre-2022 source — audit recommended">${staleCount} stale</span>` : ''}
            <span class="cm-card-toggle__count">${rows.length} rule${rows.length === 1 ? '' : 's'}</span>
            <span class="cm-card-toggle__caret">${isOpen ? '▾' : '▸'}</span>
          </button>
          ${isOpen ? `
            ${category.description ? `<p class="cm-card-body__hint" style="padding:10px 16px 0;">${escapeHtml(category.description)}</p>` : ''}
            <table class="cm-table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th style="width:28%;">Notes</th>
                  <th class="cm-th-num" style="width:110px;">Default</th>
                  <th class="cm-th-num" style="width:150px;">Your Value</th>
                  <th style="width:160px;">Source</th>
                  <th class="cm-th-center" style="width:50px;"></th>
                </tr>
              </thead>
              <tbody>
                ${resolvedList.map(({ row: r, resolved }) => {
                  const structured = r.value_type === 'array' || r.value_type === 'lookup' || r.value_type === 'tiered';
                  const isOver = resolved.source === 'override';
                  // Per-project stale check — the user can "Mark reviewed" to
                  // quiet the chip on this project without changing the value
                  // (stored as `reviewed_at` on the override payload).
                  const stale = planningRatios.isStaleForProject(r, planningRatioOverrides);
                  const staleInCatalog = planningRatios.isStale(r);
                  const ov = planningRatioOverrides[r.ratio_code];
                  const reviewedAt = ov && ov.reviewed_at ? ov.reviewed_at : null;
                  const filters = [];
                  if (r.vertical) filters.push(`v: ${r.vertical}`);
                  if (r.environment_type) filters.push(`env: ${r.environment_type}`);
                  if (r.automation_level) filters.push(`auto: ${r.automation_level}`);
                  if (r.market_tier) filters.push(`tier: ${r.market_tier}`);
                  return `
                    <tr data-pr-row="${r.ratio_code}"${isOver ? ' class="cm-row--override"' : ''}>
                      <td>
                        <div class="cm-cell-title">${escapeHtml(r.display_name)}</div>
                        <div class="cm-cell-meta">${escapeHtml(r.ratio_code)}${r.value_unit ? ` · ${escapeHtml(r.value_unit)}` : ''}</div>
                        ${filters.length ? `<div class="cm-cell-filters">${filters.map(f => `<span>${escapeHtml(f)}</span>`).join('')}</div>` : ''}
                      </td>
                      <td class="cm-cell-notes">${escapeHtml(r.notes || '')}</td>
                      <td class="cm-num">${formatRatioValue({ value: r.value_type === 'array' || r.value_type === 'lookup' || r.value_type === 'tiered' ? r.value_jsonb : r.numeric_value, def: r })}</td>
                      <td class="cm-num">
                        ${structured
                          ? `<span style="font-size:11px;color:var(--ies-gray-400);">(structured)</span>`
                          : `<input class="hub-input" type="number" step="any" data-pr-input="${escapeHtml(r.ratio_code)}" value="${ov && ov.value !== undefined && ov.value !== null ? escapeHtml(String(ov.value)) : ''}" placeholder="${r.numeric_value != null ? r.numeric_value : ''}" style="width:130px;text-align:right;" />`}
                      </td>
                      <td class="cm-cell-source">
                        <div>${escapeHtml(r.source || '')}</div>
                        ${r.source_detail ? `<div class="cm-cell-source__detail">${escapeHtml(r.source_detail)}</div>` : ''}
                        ${stale
                          ? `<div style="margin-top:4px;"><span class="hub-status-chip cm-chip-stale cm-chip-xs" title="Source pre-2022 — recommend audit before trusting">needs refresh</span></div>`
                          : (staleInCatalog && reviewedAt ? `<div style="margin-top:4px;"><span class="hub-status-chip cm-chip-success cm-chip-xs" title="Pre-2022 catalog source, but marked reviewed on this project on ${escapeHtml(reviewedAt.slice(0,10))}">✓ audited</span></div>` : '')}
                      </td>
                      <td style="text-align:center;">
                        <div class="cm-row-actions">
                          ${isOver && !reviewedAt ? `<button class="hub-btn hub-btn-sm" data-cm-action="reset-planning-ratio" data-pr-code="${escapeHtml(r.ratio_code)}" title="Reset to default">↺</button>` : ''}
                          ${stale ? `<button class="hub-btn hub-btn-sm" data-cm-action="mark-ratio-reviewed" data-pr-code="${escapeHtml(r.ratio_code)}" title="Confirm you've audited this pre-2022 value for this deal." style="background:#d1fae5;color:#065f46;border-color:#a7f3d0;">✓ Mark reviewed</button>` : ''}
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          ` : ''}
        </div>
      `;
    }).join('')}
  `;
}

/** Tiny escape for user-displayed text pulled from the DB. */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ============================================================
// SECTION 16: SCENARIOS (Phase 3 — status + clone + approve + compare)
// ============================================================

/**
 * Phase 4c: fetch the market labor profile for the active market so the
 * monthly engine can apply per-market OT/absence defaults when a labor
 * line has no per-line profile set.
 *
 * @returns {Promise<boolean>} true if a FRESH fetch happened (caller may re-render)
 */
async function ensureMarketLaborProfileLoaded() {
  const marketId = model?.projectDetails?.market;
  if (!marketId) { currentMarketLaborProfile = null; return false; }
  if (currentMarketLaborProfile && currentMarketLaborProfile.market_id === marketId) return false;
  try {
    currentMarketLaborProfile = await api.fetchLaborMarketProfile(marketId);
    return true;
  } catch (_) { currentMarketLaborProfile = null; return false; }
}

async function ensureScenariosLoaded() {
  const projectId = model?.id;
  const dealId = model?.projectDetails?.dealId || model?.deal_deals_id;
  if (projectId) {
    try { currentScenario = await api.getScenarioByProject(projectId); }
    catch (_) { currentScenario = null; }
    if (currentScenario) {
      try { currentRevisions = await api.listRevisions(currentScenario.id); }
      catch (_) { currentRevisions = []; }
      // Phase 3 close-the-loop: pull snapshots so approved scenarios re-run
      // against their frozen heuristics/rates instead of the live ref_* tables.
      if (currentScenario.status === 'approved') {
        try {
          const grouped = await api.fetchSnapshots(currentScenario.id);
          currentScenarioSnapshots = grouped || null;
        } catch (_) { currentScenarioSnapshots = null; }
      } else {
        currentScenarioSnapshots = null;
      }
    } else {
      currentScenarioSnapshots = null;
    }
  }
  if (dealId) {
    try { dealScenarios = await api.listScenarios(dealId); }
    catch (_) { dealScenarios = []; }
  } else {
    dealScenarios = [];
  }
}

/** Returns HTML for the "Reading frozen rates" banner, or empty string. */
function renderFrozenBanner() {
  if (!currentScenario || currentScenario.status !== 'approved') return '';
  if (!currentScenarioSnapshots) return '';
  const ts = currentScenario.approved_at ? new Date(currentScenario.approved_at).toLocaleDateString() : '';
  const counts = Object.fromEntries(Object.entries(currentScenarioSnapshots).map(([k, v]) => [k, (v || []).length]));
  return `
    <div class="cm-card" style="background:#ecfdf5;border-left:4px solid #059669;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <strong style="color:#065f46;">Reading frozen rates</strong>
        <span style="font-size:12px;color:#065f46;">
          Approved ${ts}${currentScenario.approved_by ? ` · by ${currentScenario.approved_by}` : ''}
          · ${counts.labor || 0} labor · ${counts.facility || 0} facility · ${counts.heuristics || 0} heuristics frozen
        </span>
      </div>
      <div style="font-size:11px;color:#065f46;margin-top:4px;">
        Edits on this scenario spawn a child. To unfreeze, create a child scenario.
      </div>
    </div>
  `;
}

const STATUS_COLORS = {
  draft: '#6b7280',
  review: '#2563eb',
  approved: '#059669',
  archived: '#9ca3af',
};

function renderScenarios() {
  const s = currentScenario;
  const others = dealScenarios.filter(x => !s || x.id !== s.id);
  const statusColor = s ? (STATUS_COLORS[s.status] || '#6b7280') : '#6b7280';

  return `
    <div class="cm-section-header">
      <h2>Scenarios
        ${s ? `<span class="hub-status-chip" style="margin-left:8px;background:${statusColor};color:white;">${s.status}</span>` : ''}
      </h2>
      <p class="cm-subtle">Group alternative designs under one deal. Approve a scenario to freeze its rate cards + heuristics for reproducibility. Edits on approved scenarios create a child.</p>
    </div>

    ${s ? `
      <div class="cm-card" style="margin-top:12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="flex:1;">
            <label style="font-size:11px;color:var(--ies-gray-500);">SCENARIO LABEL</label>
            <input class="hub-input" data-scenario-field="label" value="${s.scenario_label || 'Baseline'}" style="font-size:16px;font-weight:600;margin-top:2px;" ${s.status === 'approved' ? 'disabled' : ''} />
            <div style="margin-top:6px;">
              <label style="font-size:11px;color:var(--ies-gray-500);">DESCRIPTION</label>
              <textarea class="hub-input" data-scenario-field="description" rows="2" style="margin-top:2px;width:100%;" ${s.status === 'approved' ? 'disabled' : ''}>${s.scenario_description || ''}</textarea>
            </div>
            ${s.is_baseline ? '<div style="margin-top:6px;font-size:11px;color:var(--ies-green);">⭐ Baseline scenario</div>' : ''}
            ${s.parent_scenario_id ? `<div style="font-size:11px;color:var(--ies-gray-500);">Child of scenario #${s.parent_scenario_id}</div>` : ''}
            ${s.approved_at ? `<div style="font-size:11px;color:var(--ies-gray-500);margin-top:4px;">Approved ${new Date(s.approved_at).toLocaleString()} · by ${s.approved_by || 'system'}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;min-width:180px;">
            ${s.status === 'draft' ? `
              <button class="hub-btn-primary" data-cm-action="scenario-save-header">Save</button>
              <button class="hub-btn" data-cm-action="scenario-to-review">Move to Review</button>
              <button class="hub-btn-primary" data-cm-action="scenario-approve" style="background:#059669;">Approve + Freeze Rates</button>
            ` : ''}
            ${s.status === 'review' ? `
              <button class="hub-btn-primary" data-cm-action="scenario-approve" style="background:#059669;">Approve + Freeze Rates</button>
              <button class="hub-btn" data-cm-action="scenario-to-draft">Back to Draft</button>
            ` : ''}
            ${s.status === 'approved' ? `
              <button class="hub-btn-primary" data-cm-action="scenario-clone">Edit → Spawn Child</button>
              <button class="hub-btn" data-cm-action="scenario-archive">Archive</button>
            ` : ''}
            ${s.status === 'archived' ? `
              <button class="hub-btn" data-cm-action="scenario-clone">Clone</button>
            ` : ''}
          </div>
        </div>
      </div>
    ` : `
      <div class="cm-card" style="margin-top:12px;background:#fef3c7;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong>No scenario record yet.</strong> This project was created before the Phase 3 migration.
            Click "Initialize scenario" to retroactively add a baseline scenario.
          </div>
          <button class="hub-btn-primary" data-cm-action="scenario-init">Initialize scenario</button>
        </div>
      </div>
    `}

    ${dealScenarios.length > 0 ? `
      <div class="cm-card" style="margin-top:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;">Sibling scenarios on this deal (${dealScenarios.length})</h3>
          <button class="hub-btn-primary" data-cm-action="scenarios-compare-picker" ${dealScenarios.length < 2 ? 'disabled title="Need at least 2 scenarios"' : ''} title="Side-by-side compare 2–4 scenarios — KPIs, pricing, inputs">⇄ Compare scenarios →</button>
        </div>
        <table class="cm-table" style="margin-top:12px;width:100%;">
          <thead>
            <tr>
              <th style="text-align:left;">Label</th>
              <th style="text-align:left;width:100px;">Status</th>
              <th style="text-align:left;width:120px;">Approved</th>
              <th style="text-align:right;width:90px;">Project #</th>
              <th style="width:100px;"></th>
            </tr>
          </thead>
          <tbody>
            ${dealScenarios.map(sc => `
              <tr>
                <td style="padding:6px 8px;">${sc.scenario_label}${sc.is_baseline ? ' ⭐' : ''}${s && sc.id === s.id ? ' <em style="color:var(--ies-gray-500);">(current)</em>' : ''}</td>
                <td><span class="hub-status-chip" style="background:${STATUS_COLORS[sc.status] || '#6b7280'};color:white;">${sc.status}</span></td>
                <td style="font-size:11px;color:var(--ies-gray-500);">${sc.approved_at ? new Date(sc.approved_at).toLocaleDateString() : '—'}</td>
                <td class="cm-num">${sc.project_id || '—'}</td>
                <td>${s && sc.id !== s.id ? `<button class="hub-btn" style="padding:2px 8px;font-size:11px;" data-cm-action="scenario-open" data-scenario-id="${sc.id}" data-project-id="${sc.project_id}">Open</button>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}

    ${currentRevisions.length > 0 ? `
      <div class="cm-card" style="margin-top:16px;">
        <h3 style="margin-top:0;">Revision log (${currentRevisions.length})</h3>
        <table class="cm-table" style="width:100%;">
          <thead>
            <tr>
              <th style="text-align:left;width:60px;">Rev</th>
              <th style="text-align:left;width:160px;">When</th>
              <th style="text-align:left;width:160px;">Who</th>
              <th style="text-align:left;">Summary</th>
            </tr>
          </thead>
          <tbody>
            ${currentRevisions.slice(0, 20).map(r => `
              <tr>
                <td><strong>#${r.revision_number}</strong></td>
                <td style="font-size:11px;">${new Date(r.changed_at).toLocaleString()}</td>
                <td style="font-size:11px;">${r.changed_by || '(anonymous)'}</td>
                <td>${r.change_summary || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}
  `;
}


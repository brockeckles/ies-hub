/**
 * IES Hub v3 — Deal Management API
 * Loads canonical DOS stages + activity templates from Supabase at runtime.
 * Keeps the UI decoupled from hardcoded stage/template data.
 *
 * @module hub/deal-management/api
 */

import { db } from '../../shared/supabase.js?v=20260703-hw1';
import { auth } from '../../shared/auth.js?v=20260705-u1a';
import { recordAudit } from '../../shared/audit.js?v=20260504-auth1';
// S1 (2026-07-22): Σ★ roll-up is pure — one formula shared with ui.js.
import { computeStarRollup } from './calc.js?v=20260722-s3d';
// S2 (2026-07-22, Brock ruling: wire the score): deal health grade from the
// same MSA engine the Financials tab runs, ★-preferred basis, per-★-model
// CM escalation knobs.
import { computeDealFinancials, computeDealScore, siteEscalationFromRow } from '../../tools/deal-manager/calc.js?v=20260723-s5a';

/**
 * Fetch the 6 canonical DOS stages.
 * Maps `stages.id` (DB primary key) → `stage_number` (1..6) for use as the
 * in-app stage identifier. UI code should use stage_number everywhere.
 *
 * @returns {Promise<Array<{ id: number, stage_number: number, stage_name: string }>>}
 */
export async function fetchStages() {
  try {
    const rows = await db.fetchAll('stages');
    return rows
      .filter(r => r.stage_number && r.stage_name)
      .sort((a, b) => a.stage_number - b.stage_number);
  } catch (err) {
    console.warn('[deal-mgmt] fetchStages failed', err);
    return [];
  }
}

/**
 * Fetch activity templates grouped by stage_number (1..6).
 * Returns an object { 1: [...], 2: [...], ... }. UI shapes each into
 * { id, name, required, status }.
 *
 * @returns {Promise<Record<number, Array<{id:string,name:string,required:boolean,status:string,workstream?:string,sort:number}>>>}
 */
export async function fetchActivityTemplates() {
  try {
    const [stages, rows] = await Promise.all([
      fetchStages(),
      db.fetchAll('stage_element_templates'),
    ]);
    const idToNumber = new Map(stages.map(s => [s.id, s.stage_number]));
    const out = {};
    for (const r of rows) {
      if (r.is_template === false) continue;
      const stageNum = idToNumber.get(r.stage_id);
      if (!stageNum) continue;
      if (!out[stageNum]) out[stageNum] = [];
      // Required heuristic: mark required when element_type is 'required' OR
      // responsible_workstream is present (every DOS element v2 treated as required
      // by default unless sort_order ≥ 80, which denotes optional/auxiliary).
      const required = r.element_type === 'required' || (r.sort_order != null && r.sort_order < 80);
      out[stageNum].push({
        id: `t${stageNum}-${r.id}`,
        name: r.element_name || 'Untitled activity',
        required,
        status: 'pending',
        workstream: r.responsible_workstream || null,
        sort: r.sort_order ?? 0,
      });
    }
    // Sort each stage's list by sort_order
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => a.sort - b.sort);
    }
    return out;
  } catch (err) {
    console.warn('[deal-mgmt] fetchActivityTemplates failed', err);
    return {};
  }
}

/**
 * Fetch live deals from `deal_deals` joined with the count + summary of attached
 * cost models (`cost_model_projects.deal_deals_id`). Result is consumed by the
 * Deal Management hub view to surface real deals alongside the demo set.
 *
 * Returned rows are shaped to be compatible with the hub view's deal renderer
 * (`{id, name, client, stage, sites, revenue, margin, owner, ...}`) so the
 * pipeline / list / detail screens can render them with no further transform.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listRealDeals() {
  try {
    // 2026-04-27 EVE: also fetch ref_markets so Site Details can render the
    // market NAME instead of the raw FK uuid. ref_markets is small (~20 rows
    // last we checked) and read-only ref data, so the extra round-trip is
    // cheap. .catch fallback keeps deals listing functional even if ref_markets
    // is gated by RLS or unreachable — sites just fall back to "—".
    const [deals, models, marketRows, stagesRows, siteRows] = await Promise.all([
      db.fetchAll('deal_deals', 'id, deal_name, client_name, deal_owner, status, current_stage_id, created_at, updated_at, est_annual_revenue, target_margin_pct, contract_term_years, target_go_live, industry_vertical, site_count'),
      // C4 (2026-07-22): the ★ basis is deal_sites.in_bid_model_id only —
      // the legacy mirrored boolean is fully retired (never read or written;
      // the column drops with this wave).
      db.fetchAll('cost_model_projects', 'id, name, scenario_label, client_name, market_id, facility_sqft, target_margin_pct, total_annual_cost, total_annual_revenue, startup_cost, pricing_model, heuristic_overrides, financial:project_data->financial, deal_deals_id, updated_at, site_id'),
      db.fetchAll('ref_markets', 'id, name').catch(() => []),
      db.fetchAll('stages', 'id, stage_number').catch(() => []),
      // S1 (2026-07-22, rulings #6/#7): first-class Site records. Sites are
      // no longer derived from a market_id|name string collapse — they are
      // real deal_sites rows seeded by the S1 migration from that exact key.
      db.fetchAll('deal_sites', 'id, deal_id, name, market_id, building, status, in_bid_model_id, sort_order, sqft_estimate, updated_at').catch(() => []),
    ]);
    const stagesByIdLocal = new Map();
    for (const r of stagesRows || []) {
      if (r && r.id != null) stagesByIdLocal.set(Number(r.id), Number(r.stage_number));
    }
    const marketNameById = new Map();
    for (const m of marketRows || []) {
      if (m && m.id) marketNameById.set(m.id, m.name || '');
    }
    const byDeal = new Map();
    for (const m of models || []) {
      const k = m.deal_deals_id;
      if (!k) continue;
      if (!byDeal.has(k)) byDeal.set(k, []);
      byDeal.get(k).push(m);
    }
    const sitesByDeal = new Map();
    for (const s of siteRows || []) {
      if (!s.deal_id) continue;
      if (!sitesByDeal.has(s.deal_id)) sitesByDeal.set(s.deal_id, []);
      sitesByDeal.get(s.deal_id).push(s);
    }
    return (deals || []).map(d => {
      const attached = byDeal.get(d.id) || [];
      const modelById = new Map(attached.map(m => [String(m.id), m]));
      // S1: sites are REAL rows. Each site's scenario group = models with
      // site_id === site.id; ★ authority = deal_sites.in_bid_model_id
      // (C4: the legacy mirrored boolean is retired — column drops this wave).
      const siteRowsForDeal = (sitesByDeal.get(d.id) || [])
        .sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9) || String(a.name).localeCompare(String(b.name)));
      const sites = siteRowsForDeal.map(s => {
        const group = attached.filter(m => String(m.site_id || '') === String(s.id));
        const starModel = s.in_bid_model_id != null ? modelById.get(String(s.in_bid_model_id)) : null;
        // sqft: ★ scenario's facility → biggest in group → manual estimate
        // (S2 residue: sqft_estimate covers ★-less / scenario-less sites).
        const sqft = starModel ? (Number(starModel.facility_sqft) || 0)
          : (group.reduce((mx, m) => Math.max(mx, Number(m.facility_sqft) || 0), 0)
             || Number(s.sqft_estimate) || 0);
        return {
          id: s.id,
          name: s.name || 'Unnamed Site',
          market: s.market_id ? (marketNameById.get(s.market_id) || s.market_id) : '—',
          marketId: s.market_id || null,
          building: s.building || null,
          status: s.status || 'proposed',
          sqft,
          type: '—',
          modelCount: group.length,
          inBidModelId: s.in_bid_model_id != null ? s.in_bid_model_id : null,
          sqftEstimate: Number(s.sqft_estimate) || 0,
          sqftIsEstimate: !starModel && group.every(m => !(Number(m.facility_sqft) > 0)) && Number(s.sqft_estimate) > 0,
        };
      });
      // Models not attached to any site → Unassigned bucket (migration
      // leftovers + future site-less saves). They keep working; they just
      // don't feed any site's roll-up.
      const unassigned = attached.filter(m => !m.site_id);
      // R6 (2026-04-29): prefer deal-level columns from the modal entry, fall
      // back to attached-model averages so older deals without the columns
      // still render meaningful values.
      const dealMargin = Number(d.target_margin_pct);
      const margins = attached.map(m => Number(m.target_margin_pct)).filter(n => Number.isFinite(n) && n > 0);
      const legacyMargin = Number.isFinite(dealMargin) && dealMargin > 0
        ? dealMargin
        : (margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0);
      // est_annual_revenue is stored in $M; convert to dollars for the rest of the UI.
      const dealRevenue = Number(d.est_annual_revenue);
      const totals = attached.map(m => Number(m.total_annual_cost)).filter(n => Number.isFinite(n) && n > 0);
      const legacyRevenue = Number.isFinite(dealRevenue) && dealRevenue > 0
        ? dealRevenue * 1e6
        : (totals.length ? totals.reduce((a, b) => a + b, 0) / (1 - (legacyMargin / 100 || 0.1)) : 0);
      // S1 roll-up (ruling #6): Σ of each site's ★ scenario when any ★
      // exists; the exact legacy heuristic above passes through otherwise
      // (byte-identical list/pipeline numbers for no-★ deals).
      // C2 (2026-07-22): anyHeuristicStar + siteSources are the roll-up's
      // pricing provenance — stamped through so the UI badges heuristic-priced
      // ★ rows exactly on first paint (ui.js also has an MSA-join fallback).
      const { revenue, margin, rollupFromStars, rollupIsEstimate, bidCoverage, anyHeuristicStar, siteSources } =
        computeStarRollup(sites, modelById, { revenue: legacyRevenue, margin: legacyMargin });
      // S2 (Brock ruling: wire computeDealScore). Basis mirrors the
      // Financials tab's _binderSites semantics: ★ scenarios when any exist,
      // else every attached model. Each entry escalates by its own CM knobs
      // (siteEscalationFromRow; null → engine default 3/3).
      const starIds2 = new Set(sites.map(s => (s.inBidModelId != null ? String(s.inBidModelId) : null)).filter(Boolean));
      const scoreBasis = (starIds2.size ? attached.filter(m => starIds2.has(String(m.id))) : attached)
        .map(m => ({
          id: String(m.id),
          name: m.name || '',
          sqft: Number(m.facility_sqft) || 0,
          annualCost: Number(m.total_annual_cost) || 0,
          targetMarginPct: Number(m.target_margin_pct) || 0,
          startupCost: Number(m.startup_cost) || 0,
          pricingModel: m.pricing_model || 'cost-plus',
          annualVolume: 0,
          annualRevenue: Number(m.total_annual_revenue) || 0,
          escalation: siteEscalationFromRow({ heuristic_overrides: m.heuristic_overrides, project_data: { financial: m.financial } }),
        }))
        .filter(s => s.annualCost > 0 || s.annualRevenue > 0);
      let score = '—', scoreNum = null, scoreDetail = null;
      if (scoreBasis.length) {
        const fin = computeDealFinancials(scoreBasis, Number(d.contract_term_years) || 5);
        const sc = computeDealScore(fin);
        score = sc.grade;
        scoreNum = sc.score;
        // P2pre F1 (2026-07-23): carry the full breakdown so the detail
        // header's grade ⓘ popover can explain the letter (components are
        // 0-100 normalized; weights/thresholds echo the calc's config).
        scoreDetail = { components: sc.components, weights: sc.weights, thresholds: sc.thresholds };
      }
      // 2026-04-29 (R6): deal_deals.current_stage_id is the stages.id (PK),
      // but the UI groups deals by stage_number (1..6). Map via stagesById.
      const stagesIdToNum = (typeof stagesByIdLocal === 'undefined') ? null : stagesByIdLocal;
      let stage = 1;
      if (d.current_stage_id != null && stagesIdToNum) {
        const sn = stagesIdToNum.get(Number(d.current_stage_id));
        if (sn) stage = sn;
      }
      return {
        id: d.id, // uuid — distinguishes real from demo (which use 'd1' etc.)
        name: d.deal_name || 'Untitled Deal',
        client: d.client_name || '—',
        stage,
        sites,
        unassignedModelIds: unassigned.map(m => m.id),
        bidCoverage,
        rollupIsEstimate,
        rollupFromStars,
        anyHeuristicStar,
        siteSources,
        revenue,
        margin,
        owner: d.deal_owner || '—',
        daysInStage: 0,
        score,
        scoreNum,
        scoreDetail,
        startDate: d.created_at ? d.created_at.slice(0, 10) : null,
        targetClose: d.target_go_live || null,
        contractTermYears: Number(d.contract_term_years) || 5,
        industryVertical: d.industry_vertical || null,
        // S2 demo build-out (2026-07-22): real Site records outrank the
        // manual site_count qualification estimate (pre-S1 precedence was
        // reversed — a stale column froze the display at its intake value).
        siteCount: sites.length || Number(d.site_count) || 0,
        isReal: true,
        models: attached.map(m => ({
          id: m.id,
          name: m.name,
          scenario_label: m.scenario_label,
          client_name: m.client_name,
          market_id: m.market_id,
          facility_sqft: m.facility_sqft,
          target_margin_pct: m.target_margin_pct,
          total_annual_cost: m.total_annual_cost,
          // C2: engine-stamped revenue rides the summary so ui provenance
          // checks don't need the MSA-row join fallback.
          total_annual_revenue: m.total_annual_revenue,
          updated_at: m.updated_at,
          site_id: m.site_id || null,
        })),
      };
    });
  } catch (err) {
    console.warn('[deal-mgmt] listRealDeals failed', err);
    return [];
  }
}

/**
 * Insert a new deal into deal_deals. Returns the inserted row.
 *
 * @param {{ deal_name:string, client_name:string, deal_owner?:string, status?:string }} payload
 * @returns {Promise<object|null>}
 */
export async function createDeal(payload) {
  try {
    // owner_id is now auto-stamped by db.insert (R7 — 2026-04-29 demo audit).
    // We still support callers passing it explicitly; the wrapper is a no-op
    // when owner_id is already on the record.
    const row = {
      deal_name: payload.deal_name || 'Untitled Deal',
      client_name: payload.client_name || '',
      deal_owner: payload.deal_owner || null,
      status: payload.status || 'Draft',
    };
    // R6 — forward qualification fields when present. Schema columns added
    // 2026-04-29: est_annual_revenue, target_margin_pct, contract_term_years,
    // target_go_live, industry_vertical, site_count, current_stage_id.
    if (payload.est_annual_revenue != null && payload.est_annual_revenue !== '') row.est_annual_revenue = Number(payload.est_annual_revenue);
    if (payload.target_margin_pct != null && payload.target_margin_pct !== '')   row.target_margin_pct  = Number(payload.target_margin_pct);
    if (payload.contract_term_years != null && payload.contract_term_years !== '') row.contract_term_years = Number(payload.contract_term_years);
    if (payload.target_go_live)     row.target_go_live     = payload.target_go_live;
    if (payload.industry_vertical)  row.industry_vertical  = payload.industry_vertical;
    if (payload.site_count != null && payload.site_count !== '') row.site_count = Number(payload.site_count);
    if (payload.current_stage_id != null && payload.current_stage_id !== '') {
      // 2026-04-29: deal_deals.current_stage_id is FK to stages.id (PK).
      // The modal sends stage_number (1..6), so look up the matching id.
      const stageNum = Number(payload.current_stage_id);
      try {
        const stages = await db.fetchAll('stages');
        const match = (stages || []).find(s => Number(s.stage_number) === stageNum);
        if (match) row.current_stage_id = match.id;
      } catch { /* if stages fetch fails, just skip stage assignment */ }
    }
    const inserted = await db.insert('deal_deals', row);
    recordAudit({ table: 'deal_deals', id: inserted?.id, action: 'insert', fields: { op: 'create_deal', name: row.deal_name } });
    return inserted;
  } catch (err) {
    console.error('[deal-mgmt] createDeal failed', err);
    throw err;
  }
}

/**
 * Delete a deal by id. Cost models linked via deal_deals_id are NOT deleted —
 * they get unlinked (deal_deals_id set to null) by a downstream cleanup or
 * stay attached as orphaned references depending on FK behavior. Caller
 * should warn the user before invoking.
 *
 * @param {string} id  deal_deals.id (uuid)
 */
export async function deleteDeal(id) {
  try {
    const { error } = await db.from('deal_deals').delete().eq('id', id);
    if (error) throw error;
    recordAudit({ table: 'deal_deals', id, action: 'delete', fields: { op: 'delete_deal' } });
    return true;
  } catch (err) {
    console.error('[deal-mgmt] deleteDeal failed', err);
    throw err;
  }
}

// ============================================================
// 2026-04-29 — Deal-detail persistence
// ============================================================
// Three concerns moved out of in-memory Maps in ui.js:
//   - Win Strategy (1:1 with deal)
//   - Linked Artifacts (N per deal)
//   - DOS element status (N per deal, per element)
//
// Schema lives in supabase/migrations/20260429120000_dm_persistence_*.sql.
// All three tables RLS-gate through the parent deal\'s owner / team / vis.
// ============================================================

/**
 * Fetch the strategy row for a deal. Returns null when no row exists yet —
 * the UI seeds defaults locally and saves on first edit.
 *
 * @param {string} dealId  deal_deals.id (uuid)
 */
export async function loadStrategy(dealId) {
  if (!dealId) return null;
  try {
    const { data, error } = await db.from('deal_strategy')
      .select('value_prop, risks, asks, differentiators, competitor_threats, updated_at')
      .eq('deal_id', dealId).maybeSingle();
    if (error) { console.warn('[deal-mgmt] loadStrategy failed', error); return null; }
    return data || null;
  } catch (err) {
    console.warn('[deal-mgmt] loadStrategy threw', err);
    return null;
  }
}

/**
 * Upsert the strategy row for a deal. Pass camelCase from the UI; this maps
 * to the snake_case DB columns.
 *
 * @param {string} dealId
 * @param {{ valueProp?:string, risks?:string[], asks?:string[],
 *           differentiators?:string[], competitorThreats?:string }} payload
 */
export async function saveStrategy(dealId, payload) {
  if (!dealId) throw new Error('saveStrategy: dealId required');
  const row = {
    deal_id: dealId,
    value_prop:         payload.valueProp ?? '',
    risks:              Array.isArray(payload.risks) ? payload.risks : [],
    asks:               Array.isArray(payload.asks) ? payload.asks : [],
    differentiators:    Array.isArray(payload.differentiators) ? payload.differentiators : [],
    competitor_threats: payload.competitorThreats ?? '',
  };
  // Upsert on the unique deal_id constraint.
  const { data, error } = await db.from('deal_strategy')
    .upsert(row, { onConflict: 'deal_id' }).select().single();
  if (error) { console.warn('[deal-mgmt] saveStrategy failed', error); throw error; }
  recordAudit({ table: 'deal_strategy', id: dealId, action: 'update', fields: { keys: Object.keys(payload) } });
  return data;
}

/**
 * List artifact rows for a deal.
 * @param {string} dealId
 */
export async function listArtifactsByDeal(dealId) {
  if (!dealId) return [];
  try {
    const { data, error } = await db.from('deal_artifacts')
      .select('id, kind, name, ref, model_id, created_at, updated_at')
      .eq('deal_id', dealId).order('created_at', { ascending: false });
    if (error) { console.warn('[deal-mgmt] listArtifactsByDeal failed', error); return []; }
    return data || [];
  } catch (err) {
    console.warn('[deal-mgmt] listArtifactsByDeal threw', err);
    return [];
  }
}

/**
 * Insert a new artifact row.
 * @param {string} dealId
 * @param {{ kind:string, name:string, ref?:string, model_id?:number|null }} payload
 */
export async function createArtifact(dealId, payload) {
  if (!dealId) throw new Error('createArtifact: dealId required');
  const row = {
    deal_id:  dealId,
    kind:     payload.kind || 'other',
    name:     payload.name || 'Untitled artifact',
    ref:      payload.ref || null,
    model_id: payload.model_id ?? null,
  };
  const { data, error } = await db.from('deal_artifacts')
    .insert(row).select().single();
  if (error) { console.warn('[deal-mgmt] createArtifact failed', error); throw error; }
  recordAudit({ table: 'deal_artifacts', id: data?.id, action: 'insert', fields: { op: 'create_artifact', deal_id: dealId, name: row.name } });
  return data;
}

/**
 * Delete an artifact by id (bigint).
 * @param {number} id
 */
export async function deleteArtifact(id) {
  if (!id) return false;
  const { error } = await db.from('deal_artifacts').delete().eq('id', id);
  if (error) { console.warn('[deal-mgmt] deleteArtifact failed', error); throw error; }
  recordAudit({ table: 'deal_artifacts', id, action: 'delete', fields: { op: 'delete_artifact' } });
  return true;
}

/**
 * Load DOS status overrides for a deal. Returns an object map
 * { element_id: status } so the UI can apply overrides on top of defaults.
 *
 * @param {string} dealId
 */
/**
 * UX-1 D1p2-A (2026-07-03): record a terminal deal outcome. owner_id is
 * auto-stamped by db.insert (R7); recorded_by mirrors it for the audit trail.
 * @param {string} dealId
 * @param {Object} p — { outcome, reason_category, reason_detail, competitor_won_to,
 *                       go_live_date, bid_y1_revenue, bid_y1_cost, bid_y1_margin_pct, notes }
 * @returns {Promise<Object>} inserted row
 */
export async function recordDealOutcome(dealId, p) {
  if (!dealId || !p?.outcome) throw new Error('recordDealOutcome: dealId + outcome required');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  // P2-a (2026-07-23): bid-of-record prefill. Explicit caller values ALWAYS
  // win; the latest immutable snapshot fills ONLY the missing bid_y1_*
  // fields — so calibration compares actuals against the bid as submitted,
  // not a reconstruction. bid_snapshot_id links the outcome to that frozen
  // row whenever one exists (fail-soft: no snapshot → nulls, exactly the
  // pre-P2a behavior).
  let bidRev = num(p.bid_y1_revenue);
  let bidCost = num(p.bid_y1_cost);
  let bidMargin = num(p.bid_y1_margin_pct);
  let bidSnapshotId = p.bid_snapshot_id || null;
  if (bidRev === null || bidCost === null || bidMargin === null || !bidSnapshotId) {
    const snap = await latestBidSnapshot(dealId);
    if (snap) {
      if (bidRev === null) bidRev = num(snap.y1_revenue);
      if (bidCost === null) bidCost = num(snap.y1_cost);
      if (bidMargin === null) bidMargin = num(snap.y1_margin_pct);
      if (!bidSnapshotId) bidSnapshotId = snap.id || null;
    }
  }
  const row = await db.insert('deal_outcomes', {
    deal_id: dealId,
    outcome: p.outcome,
    reason_category: p.reason_category || null,
    reason_detail: p.reason_detail || null,
    competitor_won_to: p.competitor_won_to || null,
    go_live_date: p.go_live_date || null,
    bid_y1_revenue: bidRev,
    bid_y1_cost: bidCost,
    bid_y1_margin_pct: bidMargin,
    bid_snapshot_id: bidSnapshotId,
    notes: p.notes || null,
  });
  recordAudit({ table: 'deal_outcomes', id: row?.id, action: 'insert', fields: { op: 'record_outcome', deal_id: dealId, outcome: p.outcome } });
  // Reflect the terminal state on the deal row itself so pipeline views agree.
  try { await db.update('deal_deals', dealId, { status: p.outcome }); } catch (err) {
    console.warn('[deal-mgmt] recordDealOutcome: status update failed', err);
  }
  return row;
}

/**
 * Latest outcome row for a deal (null when the deal is still open).
 * @param {string} dealId
 */
export async function getLatestDealOutcome(dealId) {
  try {
    const { data, error } = await db.from('deal_outcomes')
      .select('*')
      .eq('deal_id', dealId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  } catch (err) {
    console.warn('[deal-mgmt] getLatestDealOutcome failed', err);
    return null;
  }
}

/**
 * S1 (2026-07-22, rulings #6/#7): mark a scenario ★-in-bid FOR ITS SITE.
 * The ★ authority is deal_sites.in_bid_model_id — one UPDATE, exclusivity
 * enforced by the FK rather than app-side sibling-clearing over a string
 * key (the pre-S1 setModelInBid). C4 (2026-07-22): the legacy mirrored
 * boolean on cost_model_projects is fully retired — no writes remain and
 * the column drops with this wave.
 *
 * @param {string} dealId
 * @param {number|string} modelId — must be attached to a site on this deal
 */
export async function setModelInBid(dealId, modelId) {
  const { data, error } = await db.from('cost_model_projects')
    .select('id, name, site_id')
    .eq('deal_deals_id', dealId);
  if (error) throw error;
  const rows = data || [];
  const target = rows.find(r => String(r.id) === String(modelId));
  if (!target) throw new Error('setModelInBid: model not on this deal');
  if (!target.site_id) throw new Error('setModelInBid: model is Unassigned — attach it to a site first');
  // Authority: one UPDATE on the site row.
  await db.update('deal_sites', target.site_id, { in_bid_model_id: target.id });
  recordAudit({ table: 'deal_sites', id: target.site_id, action: 'update', fields: { op: 'set_site_in_bid', deal_deals_id: dealId, model_id: target.id } });
}

// ============================================================
// S1 — Site CRUD (2026-07-22, rulings #6/#7 + spec rulings s2)
// ============================================================

/**
 * Small read-only markets list for the Add/Edit Site modal.
 * @returns {Promise<Array<{id:string,name:string}>>}
 */
export async function listMarkets() {
  try {
    const rows = await db.fetchAll('ref_markets', 'id, name');
    return (rows || []).filter(r => r && r.id).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (err) {
    console.warn('[deal-mgmt] listMarkets failed', err);
    return [];
  }
}

/**
 * List Site rows for a deal, ordered by sort_order then name.
 * @param {string} dealId
 */
export async function listSitesByDeal(dealId) {
  if (!dealId) return [];
  try {
    const { data, error } = await db.from('deal_sites')
      .select('id, name, market_id, building, status, in_bid_model_id, sort_order, updated_at')
      .eq('deal_id', dealId)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('[deal-mgmt] listSitesByDeal failed', err);
    return [];
  }
}

/**
 * Create a Site record under a deal. This is the S1 "+ Add Site" — it
 * creates a deal_sites row, NOT a cost model (pre-S1 behavior).
 * @param {string} dealId
 * @param {{ name:string, market_id?:string|null, building?:string|null, status?:string }} payload
 */
export async function createSite(dealId, payload) {
  if (!dealId || !payload?.name) throw new Error('createSite: dealId + name required');
  const row = await db.insert('deal_sites', {
    deal_id: dealId,
    name: String(payload.name),
    market_id: payload.market_id || null,
    building: payload.building || null,
    status: payload.status || 'proposed',
    sqft_estimate: Number(payload.sqft_estimate) > 0 ? Math.round(Number(payload.sqft_estimate)) : null,
  });
  recordAudit({ table: 'deal_sites', id: row?.id, action: 'insert', fields: { op: 'create_site', deal_id: dealId } });
  return row;
}

/**
 * S2 residue: delete a Site record. FKs are on-delete-set-null, so attached
 * models/designs survive as Unassigned. The site row carries the ★ authority
 * (in_bid_model_id), so deleting it deletes the ★ with it — nothing to clear.
 * @param {string} siteId
 */
export async function deleteSite(siteId) {
  if (!siteId) throw new Error('deleteSite: siteId required');
  const { data, error } = await db.from('deal_sites')
    .select('id, deal_id, in_bid_model_id').eq('id', siteId).maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const { error: delErr } = await db.from('deal_sites').delete().eq('id', siteId);
  if (delErr) throw delErr;
  recordAudit({ table: 'deal_sites', id: siteId, action: 'delete', fields: { op: 'delete_site', deal_id: data.deal_id } });
  return true;
}

/**
 * Patch a Site (name / market_id / building / status / sort_order).
 * @param {string} siteId
 * @param {Object} patch
 */
export async function updateSite(siteId, patch) {
  if (!siteId) throw new Error('updateSite: siteId required');
  const allowed = {};
  for (const k of ['name', 'market_id', 'building', 'status', 'sort_order', 'sqft_estimate']) {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  }
  const updated = await db.update('deal_sites', siteId, allowed);
  recordAudit({ table: 'deal_sites', id: siteId, action: 'update', fields: { op: 'update_site', keys: Object.keys(allowed) } });
  return updated;
}

/**
 * Attach a cost model to a site (or detach with siteId=null → Unassigned).
 * Mirrors ★ hygiene: a model leaving a site that ★'d it clears that ★.
 * @param {number|string} modelId
 * @param {string|null} siteId
 */
export async function assignModelToSite(modelId, siteId) {
  if (modelId == null) throw new Error('assignModelToSite: modelId required');
  const { data, error } = await db.from('cost_model_projects')
    .select('id, site_id').eq('id', modelId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('assignModelToSite: model not found');
  const prevSite = data.site_id;
  await db.update('cost_model_projects', modelId, { site_id: siteId || null });
  if (prevSite && String(prevSite) !== String(siteId || '')) {
    // If this model was the previous site's ★, clear it there.
    const { data: prev } = await db.from('deal_sites')
      .select('id, in_bid_model_id').eq('id', prevSite).maybeSingle();
    if (prev && String(prev.in_bid_model_id) === String(modelId)) {
      await db.update('deal_sites', prevSite, { in_bid_model_id: null });
    }
  }
  recordAudit({ table: 'cost_model_projects', id: modelId, action: 'update', fields: { op: 'assign_model_to_site', site_id: siteId || null } });
  return true;
}

/**
 * Attach a design-tool scenario to a site (or detach with siteId=null).
 * @param {'wsc'|'most'|'cog'} tool
 * @param {string} scenarioId
 * @param {string|null} siteId
 */
export async function assignDesignToSite(tool, scenarioId, siteId) {
  const table = tool === 'wsc' ? 'wsc_facility_configs'
    : tool === 'most' ? 'most_analyses'
    : tool === 'cog' ? 'cog_scenarios' : null;
  if (!table || !scenarioId) throw new Error('assignDesignToSite: bad args');
  const updated = await db.update(table, scenarioId, { site_id: siteId || null });
  recordAudit({ table, id: scenarioId, action: 'update', fields: { op: 'assign_design_to_site', site_id: siteId || null } });
  return updated;
}

/**
 * UX-1 D1 phase 1 (2026-07-03): design-tool scenarios linked to a deal via
 * parent_deal_id (stamped by the D2 deal-context on save). Powers the
 * workflow rail's Size / Labor / Network counts + smart buttons.
 * @param {string} dealId
 * @returns {Promise<{wsc: any[], most: any[], cog: any[], netopt: any[], fleet: any[]}>}
 */
export async function listDesignScenariosByDeal(dealId) {
  if (!dealId) return { wsc: [], most: [], cog: [], netopt: [], fleet: [] };
  const grab = async (table) => {
    try {
      const { data, error } = await db.from(table)
        .select('id, name, updated_at, site_id')
        .eq('parent_deal_id', dealId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.warn(`[deal-mgmt] listDesignScenariosByDeal(${table}) failed`, err);
      return [];
    }
  };
  // S2 (2026-07-22, Brock ruling): NetOpt configs fold into the rail's
  // Network stage. Kept as its own select for the pinned literal; C1 added
  // netopt_configs.site_id, so the shape now matches grab().
  const grabNetopt = async () => {
    try {
      const { data, error } = await db.from('netopt_configs')
        .select('id, name, updated_at, site_id')
        .eq('parent_deal_id', dealId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.warn('[deal-mgmt] listDesignScenariosByDeal(netopt_configs) failed', err);
      return [];
    }
  };
  // C1 (2026-07-22, Brock ruling s3 — supersedes the s2 Fleet-off-rail
  // ruling): Fleet joins the Network stage. fleet_scenarios.site_id landed
  // with this wave, so the shared grab() shape applies (note: id is uuid,
  // unlike CM's bigints — callers must not Number() it).
  const [wsc, most, cog, netopt, fleet] = await Promise.all([
    grab('wsc_facility_configs'),
    grab('most_analyses'),
    grab('cog_scenarios'),
    grabNetopt(),
    grab('fleet_scenarios'),
  ]);
  return { wsc, most, cog, netopt, fleet };
}

export async function loadDosStatusByDeal(dealId) {
  if (!dealId) return {};
  try {
    const { data, error } = await db.from('deal_dos_status')
      .select('element_id, status').eq('deal_id', dealId);
    if (error) { console.warn('[deal-mgmt] loadDosStatusByDeal failed', error); return {}; }
    const out = {};
    for (const row of (data || [])) {
      if (row.element_id) out[row.element_id] = row.status;
    }
    return out;
  } catch (err) {
    console.warn('[deal-mgmt] loadDosStatusByDeal threw', err);
    return {};
  }
}

/**
 * Upsert a DOS element\'s status for a deal.
 * @param {string} dealId
 * @param {string} elementId
 * @param {'not-started'|'in-progress'|'complete'} status
 */
export async function setDosElementStatus(dealId, elementId, status) {
  if (!dealId || !elementId) throw new Error('setDosElementStatus: dealId + elementId required');
  const row = { deal_id: dealId, element_id: elementId, status };
  const { data, error } = await db.from('deal_dos_status')
    .upsert(row, { onConflict: 'deal_id,element_id' }).select().single();
  if (error) { console.warn('[deal-mgmt] setDosElementStatus failed', error); throw error; }
  recordAudit({ table: 'deal_dos_status', id: data?.id, action: 'update', fields: { deal_id: dealId, element_id: elementId, status } });
  return data;
}

/**
 * UX0-3 (2026-07-03): persist stage advancement. The "Advance to Stage N"
 * button mutated memory only — current_stage_id never updated, so every
 * reload reset the pipeline position (X3 in the 2026-07-03 UX assessment).
 * @param {string} dealId — deal_deals.id (uuid)
 * @param {number} stageNumber — 1..6 UI stage number (NOT stages.id)
 * @returns {Promise<Object>} updated row
 */
export async function advanceDealStage(dealId, stageNumber) {
  if (!dealId) throw new Error('advanceDealStage: dealId required');
  const stages = await db.fetchAll('stages');
  const match = (stages || []).find(s => Number(s.stage_number) === Number(stageNumber));
  if (!match) throw new Error(`advanceDealStage: no stages row for stage_number ${stageNumber}`);
  const { data, error } = await db.from('deal_deals')
    .update({ current_stage_id: match.id }).eq('id', dealId).select().single();
  if (error) { console.warn('[deal-mgmt] advanceDealStage failed', error); throw error; }
  recordAudit({ table: 'deal_deals', id: dealId, action: 'update', fields: { op: 'advance_stage', stage: Number(stageNumber) } });
  return data;
}

// ============================================================
// S3-P1 — Bid package meta (2026-07-22)
// ============================================================
// One row per deal in deal_bid_meta (deal_id uuid PK/FK):
//   exec_summary text default '', submission_due date | null,
//   manual_checks jsonb default {} (e.g. {'commercial-review': true}).
// Read is fail-soft null (loadStrategy pattern); save is a merge-upsert so a
// partial payload never blanks the other columns.
// ============================================================

/**
 * Fetch the bid-meta row for a deal. Returns null when no row exists yet —
 * the manifest treats a missing row as "nothing checked/written yet".
 *
 * @param {string} dealId  deal_deals.id (uuid)
 * @returns {Promise<{deal_id:string, exec_summary:string, submission_due:string|null,
 *                    manual_checks:Object, updated_at:string}|null>}
 */
export async function getBidMeta(dealId) {
  if (!dealId) return null;
  try {
    const { data, error } = await db.from('deal_bid_meta')
      .select('deal_id, exec_summary, submission_due, manual_checks, updated_at')
      .eq('deal_id', dealId).maybeSingle();
    if (error) { console.warn('[deal-mgmt] getBidMeta failed', error); return null; }
    return data || null;
  } catch (err) {
    console.warn('[deal-mgmt] getBidMeta threw', err);
    return null;
  }
}

/**
 * Upsert the bid-meta row for a deal. Pass camelCase from the UI; this maps
 * to the snake_case DB columns (execSummary → exec_summary, submissionDue →
 * submission_due, manualChecks → manual_checks).
 *
 * Only the keys the caller passed are changed: a bare upsert with partial
 * columns would null the others on first INSERT, so we read the existing row
 * first, merge the payload over it (defaults for a fresh row), and upsert the
 * full row on the deal_id conflict target.
 *
 * @param {string} dealId
 * @param {{ execSummary?:string, submissionDue?:string|null,
 *           manualChecks?:Object }} payload
 * @returns {Promise<Object>} the upserted row
 */
export async function saveBidMeta(dealId, payload = {}) {
  if (!dealId) throw new Error('saveBidMeta: dealId required');
  const existing = await getBidMeta(dealId);
  const row = {
    deal_id: dealId,
    exec_summary:   existing?.exec_summary ?? '',
    submission_due: existing?.submission_due ?? null,
    manual_checks:  existing?.manual_checks ?? {},
  };
  if ('execSummary' in payload)   row.exec_summary   = payload.execSummary ?? '';
  if ('submissionDue' in payload) row.submission_due = payload.submissionDue ?? null;
  if ('manualChecks' in payload)  row.manual_checks  = payload.manualChecks ?? {};
  const { data, error } = await db.from('deal_bid_meta')
    .upsert(row, { onConflict: 'deal_id' }).select().single();
  if (error) { console.warn('[deal-mgmt] saveBidMeta failed', error); throw error; }
  recordAudit({ table: 'deal_bid_meta', id: dealId, action: 'update', fields: { keys: Object.keys(payload) } });
  return data;
}

// ============================================================
// P2-a — Bid-of-record snapshots (2026-07-23)
// ============================================================
// "Mark as submitted" stamps ONE append-only deal_bid_snapshots row — the
// immutable bid of record. Fields + payload come from the pure engine
// (tools/deal-manager/calc.js buildBidSnapshotPayload); submitted_at /
// submitted_by are stamped by DB defaults. The table has no UPDATE/DELETE
// policies AND an append-only trigger, so these rows never change —
// recordDealOutcome prefills bid_y1_* from the latest one to close the
// bid-vs-outcome calibration loop.
// ============================================================

const _SNAPSHOT_COLS = 'id, deal_id, submitted_at, submitted_by, manifest_pct, y1_revenue, y1_cost, y1_margin_pct, payload, notes';

/**
 * Mark the deal's bid as submitted: insert an immutable snapshot row.
 *
 * @param {string} dealId
 * @param {{ manifest_pct?:number|null, y1_revenue?:number|null,
 *           y1_cost?:number|null, y1_margin_pct?:number|null,
 *           payload:Object, notes?:string|null }} snapshotFields
 *        — the buildBidSnapshotPayload output (+ optional notes)
 * @returns {Promise<Object>} the inserted row
 */
export async function submitBid(dealId, snapshotFields = {}) {
  if (!dealId) throw new Error('submitBid: dealId required');
  const f = snapshotFields || {};
  if (!f.payload || typeof f.payload !== 'object') {
    throw new Error('submitBid: snapshot payload required (buildBidSnapshotPayload output)');
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const row = await db.insert('deal_bid_snapshots', {
    deal_id: dealId,
    manifest_pct: num(f.manifest_pct),
    y1_revenue: num(f.y1_revenue),
    y1_cost: num(f.y1_cost),
    y1_margin_pct: num(f.y1_margin_pct),
    payload: f.payload,
    notes: f.notes || null,
  });
  recordAudit({ table: 'deal_bid_snapshots', id: row?.id, action: 'insert',
    fields: { op: 'mark_submitted', deal_id: dealId, manifest_pct: num(f.manifest_pct) } });
  return row;
}

/**
 * All snapshots for a deal, newest first. Fail-soft [] — a missing table /
 * RLS denial must never break the Package tab.
 * @param {string} dealId
 * @returns {Promise<Array<Object>>}
 */
export async function listBidSnapshots(dealId) {
  if (!dealId) return [];
  try {
    const { data, error } = await db.from('deal_bid_snapshots')
      .select(_SNAPSHOT_COLS)
      .eq('deal_id', dealId)
      .order('submitted_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('[deal-mgmt] listBidSnapshots failed', err);
    return [];
  }
}

/**
 * Latest snapshot for a deal — the current bid of record. Fail-soft null.
 * @param {string} dealId
 * @returns {Promise<Object|null>}
 */
export async function latestBidSnapshot(dealId) {
  if (!dealId) return null;
  try {
    const { data, error } = await db.from('deal_bid_snapshots')
      .select(_SNAPSHOT_COLS)
      .eq('deal_id', dealId)
      .order('submitted_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  } catch (err) {
    console.warn('[deal-mgmt] latestBidSnapshot failed', err);
    return null;
  }
}

export default { fetchStages, fetchActivityTemplates, listRealDeals, createDeal, deleteDeal,
  loadStrategy, saveStrategy,
  listArtifactsByDeal, createArtifact, deleteArtifact,
  loadDosStatusByDeal, setDosElementStatus, advanceDealStage,
  setModelInBid, listDesignScenariosByDeal, recordDealOutcome, getLatestDealOutcome,
  listSitesByDeal, createSite, updateSite, deleteSite, assignModelToSite, assignDesignToSite, listMarkets,
  getBidMeta, saveBidMeta,
  submitBid, listBidSnapshots, latestBidSnapshot,
};

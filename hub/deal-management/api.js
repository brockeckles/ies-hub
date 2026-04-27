/**
 * IES Hub v3 — Deal Management API
 * Loads canonical DOS stages + activity templates from Supabase at runtime.
 * Keeps the UI decoupled from hardcoded stage/template data.
 *
 * @module hub/deal-management/api
 */

import { db } from '../../shared/supabase.js?v=20260424-A1';

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
    const [deals, models] = await Promise.all([
      db.fetchAll('deal_deals', 'id, deal_name, client_name, deal_owner, status, current_stage_id, created_at, updated_at'),
      db.fetchAll('cost_model_projects', 'id, name, scenario_label, client_name, market_id, facility_sqft, target_margin_pct, total_annual_cost, deal_deals_id, updated_at'),
    ]);
    const byDeal = new Map();
    for (const m of models || []) {
      const k = m.deal_deals_id;
      if (!k) continue;
      if (!byDeal.has(k)) byDeal.set(k, []);
      byDeal.get(k).push(m);
    }
    return (deals || []).map(d => {
      const attached = byDeal.get(d.id) || [];
      // Roll a single per-site representative from each unique market_id (if set)
      // so the Sites tab has something to show. When models share a market_id /
      // name (4 scenarios for 1 site = the Wayfair Memphis FC case), they collapse
      // into a single site row.
      const sitesMap = new Map();
      for (const m of attached) {
        const k = `${m.market_id || ''}|${m.name || ''}`;
        if (!sitesMap.has(k)) {
          sitesMap.set(k, {
            name: m.name || 'Unnamed Site',
            market: m.market_id || '',
            sqft: Number(m.facility_sqft) || 0,
            type: '—',
            modelCount: 0,
          });
        }
        sitesMap.get(k).modelCount += 1;
      }
      const sites = [...sitesMap.values()];
      // Best-effort revenue/margin: average across attached models.
      const margins = attached.map(m => Number(m.target_margin_pct)).filter(n => Number.isFinite(n) && n > 0);
      const margin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
      const totals = attached.map(m => Number(m.total_annual_cost)).filter(n => Number.isFinite(n) && n > 0);
      const revenue = totals.length ? totals.reduce((a, b) => a + b, 0) / (1 - (margin / 100 || 0.1)) : 0;
      // Stage: deal_deals.current_stage_id is a bigint FK to stages.id; not the
      // 1..6 stage_number used by the hub. Default to 1 when unset; when set,
      // we'd need stages lookup — defer to a follow-up.
      const stage = 1;
      return {
        id: d.id, // uuid — distinguishes real from demo (which use 'd1' etc.)
        name: d.deal_name || 'Untitled Deal',
        client: d.client_name || '—',
        stage,
        sites,
        revenue,
        margin,
        owner: d.deal_owner || '—',
        daysInStage: 0,
        score: '—',
        startDate: d.created_at ? d.created_at.slice(0, 10) : null,
        targetClose: null,
        isReal: true,
        models: attached.map(m => ({
          id: m.id,
          name: m.name,
          scenario_label: m.scenario_label,
          client_name: m.client_name,
          market_id: m.market_id,
          facility_sqft: m.facility_sqft,
          target_margin_pct: m.target_margin_pct,
          updated_at: m.updated_at,
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
    const row = {
      deal_name: payload.deal_name || 'Untitled Deal',
      client_name: payload.client_name || '',
      deal_owner: payload.deal_owner || null,
      status: payload.status || 'Draft',
    };
    return await db.insert('deal_deals', row);
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
    return true;
  } catch (err) {
    console.error('[deal-mgmt] deleteDeal failed', err);
    throw err;
  }
}

export default { fetchStages, fetchActivityTemplates, listRealDeals, createDeal, deleteDeal };

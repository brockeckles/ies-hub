/**
 * IES Hub v3 — Deal Management API
 * Loads canonical DOS stages + activity templates from Supabase at runtime.
 * Keeps the UI decoupled from hardcoded stage/template data.
 *
 * @module hub/deal-management/api
 */

import { db } from '../../shared/supabase.js?v=20260418-sK';

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

export default { fetchStages, fetchActivityTemplates };

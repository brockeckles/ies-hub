/**
 * IES Hub v3 — Cost Model Phase 3 Scenarios + SCD + Heuristics Engine
 *
 * Pure functions only. No DOM, no Supabase, no browser globals.
 * Persistence helpers (approveScenario / cloneScenario / snapshot fetchers)
 * live in api.js.
 *
 * Concepts:
 *   - A *scenario* groups one project under a deal with a lifecycle status
 *     (draft / review / approved / archived). Approved scenarios freeze all
 *     ref_* rate-card rows + heuristic catalog values into cost_model_rate_snapshots.
 *   - *Heuristics* are internal modeling assumptions (DSO/DPO, benefit load,
 *     ramp weeks, escalation rates, etc.) that drive the math beyond the
 *     external rate cards. They live in ref_design_heuristics + per-project
 *     jsonb override.
 *
 * Acceptance criteria (from roadmap):
 *   1. An approved scenario recomputes identically 6 months later even if
 *      ref_labor_rates has drifted since approval.
 *   2. compareScenarios(a, b) returns aligned deltas on every major KPI.
 *   3. Editing an approved scenario spawns a child scenario (copy-on-write).
 *   4. Every save writes a revision row with author + change_summary.
 *
 * @module tools/cost-model/calc.scenarios
 */

// ============================================================
// TYPEDEFS
// ============================================================

/**
 * @typedef {Object} HeuristicDef
 * @property {string} key
 * @property {string} label
 * @property {string} category        financial / working_capital / labor / ramp_seasonality / ops_escalation
 * @property {'percent'|'number'|'integer'|'enum'|'currency'} data_type
 * @property {string|null} unit
 * @property {number|null} default_value
 * @property {string|null} default_enum
 * @property {string[]|null} allowed_enums
 * @property {number|null} min_value
 * @property {number|null} max_value
 * @property {number} sort_order
 */

/**
 * @typedef {Object} Scenario
 * @property {number} id
 * @property {string|null} deal_id
 * @property {number|null} project_id
 * @property {number|null} parent_scenario_id
 * @property {string} scenario_label
 * @property {string|null} scenario_description
 * @property {boolean} is_baseline
 * @property {'draft'|'review'|'approved'|'archived'} status
 * @property {string|null} approved_at
 * @property {string|null} approved_by
 */

/**
 * @typedef {Object} RateSnapshot
 * @property {number} scenario_id
 * @property {'labor'|'facility'|'utility'|'equipment'|'overhead'|'heuristics'|'pricing_assumptions'|'periods'} rate_card_type
 * @property {string} rate_card_id
 * @property {string} rate_card_version_hash
 * @property {Object} snapshot_json
 */

// ============================================================
// HEURISTICS — merge catalog + per-project overrides
// ============================================================

/**
 * Read the effective value for a single heuristic given the catalog row +
 * the project's override jsonb. Overrides win over defaults. For enum
 * heuristics the default_enum string is returned; for all other types the
 * numeric default_value is returned. Overrides are always returned as-is.
 *
 * @param {HeuristicDef} def
 * @param {Object} overrides    cost_model_projects.heuristic_overrides
 * @returns {number|string|null}
 */
export function heuristicEffective(def, overrides) {
  if (!def || !def.key) return null;
  const o = overrides || {};
  if (Object.prototype.hasOwnProperty.call(o, def.key) && o[def.key] !== null && o[def.key] !== undefined && o[def.key] !== '') {
    return o[def.key];
  }
  if (def.data_type === 'enum') return def.default_enum ?? null;
  return def.default_value ?? null;
}

/**
 * Validate an override value against its catalog definition. Returns an
 * issue string or null. Used by the Assumptions UI before writing.
 *
 * @param {HeuristicDef} def
 * @param {*} value
 * @returns {string|null}
 */
export function validateHeuristic(def, value) {
  if (!def) return 'unknown heuristic';
  if (value === null || value === undefined || value === '') return null;
  if (def.data_type === 'enum') {
    if (!Array.isArray(def.allowed_enums) || !def.allowed_enums.includes(value)) {
      return `value must be one of: ${(def.allowed_enums || []).join(', ')}`;
    }
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return 'value must be a number';
  if (def.data_type === 'integer' && !Number.isInteger(n)) return 'value must be an integer';
  if (def.min_value !== null && def.min_value !== undefined && n < def.min_value) return `value must be ≥ ${def.min_value}`;
  if (def.max_value !== null && def.max_value !== undefined && n > def.max_value) return `value must be ≤ ${def.max_value}`;
  return null;
}

/**
 * Build a flat { key: effective_value } map for calc consumption. Used by
 * the monthly engine adapter so downstream code doesn't need to know about
 * catalog vs override resolution.
 *
 * @param {HeuristicDef[]} catalog
 * @param {Object} overrides
 * @returns {Object<string, number|string>}
 */
export function resolveHeuristics(catalog, overrides) {
  const out = {};
  for (const def of catalog || []) {
    out[def.key] = heuristicEffective(def, overrides);
  }
  return out;
}

/**
 * Count how many overrides differ from their catalog default. Used by the
 * status chip ("3 overrides") and the revision diff.
 *
 * @param {HeuristicDef[]} catalog
 * @param {Object} overrides
 * @returns {number}
 */
export function countOverrideChanges(catalog, overrides) {
  const o = overrides || {};
  let n = 0;
  for (const def of catalog || []) {
    if (!Object.prototype.hasOwnProperty.call(o, def.key)) continue;
    if (o[def.key] === null || o[def.key] === undefined || o[def.key] === '') continue;
    const def_val = def.data_type === 'enum' ? def.default_enum : def.default_value;
    if (String(o[def.key]) !== String(def_val)) n += 1;
  }
  return n;
}

// ============================================================
// RATE-CARD HASHING
// ============================================================

/**
 * Deterministic rate-card hash. Client-side mirror of the Postgres
 * md5(col1 || '|' || col2 || ...) triggers, so we can show a version
 * badge in the UI without re-querying Supabase. Column order matches the
 * trigger definitions for each table.
 *
 * Returns an md5-looking string of the concatenated values. In the
 * browser we use SubtleCrypto when available; in Node tests we use
 * require('crypto'). Callers that don't care about exact md5 equality can
 * just use the returned string as an opaque identifier.
 *
 * @param {string} cardType    one of labor | facility | utility | overhead | equipment
 * @param {Object} row
 * @returns {string}           deterministic hash (32 hex chars when md5 available)
 */
export function computeRateCardHash(cardType, row) {
  const parts = selectHashColumns(cardType, row);
  const joined = parts.join('|');
  return md5Hex(joined);
}

/** Internal: pick the hash-relevant columns per table in trigger order. */
function selectHashColumns(cardType, row) {
  const r = row || {};
  const s = v => (v === null || v === undefined) ? '' : String(v);
  switch (cardType) {
    case 'labor':
      return [
        s(r.market_id),
        s(r.role_name),
        s(r.role_category),
        s(r.hourly_rate),
        s(r.burden_pct),
        s(r.benefits_per_hour),
        s(r.overtime_multiplier),
        s(r.shift_differential_pct),
        s(r.annual_hours),
        s(r.default_benefit_load_pct),
        s(r.default_bonus_pct),
        s(r.annual_escalation_pct),
        s(r.effective_date),
      ];
    case 'facility':
      return [
        s(r.market_id),
        s(r.building_type),
        s(r.lease_rate_psf_yr),
        s(r.cam_rate_psf_yr),
        s(r.tax_rate_psf_yr),
        s(r.insurance_rate_psf_yr),
        s(r.build_out_psf),
        s(r.clear_height_ft),
        s(r.dock_door_cost),
        s(r.effective_date),
      ];
    case 'utility':
      return [
        s(r.market_id),
        s(r.electricity_kwh),
        s(r.natural_gas_therm),
        s(r.water_per_kgal),
        s(r.trash_monthly),
        s(r.telecom_monthly),
        s(r.avg_monthly_per_sqft),
        s(r.effective_date),
      ];
    case 'overhead':
      return [
        s(r.category),
        s(r.description),
        s(r.monthly_cost),
        s(r.cost_type),
        s(r.per_unit),
        s(r.effective_date),
      ];
    case 'equipment':
      return [
        s(r.name),
        s(r.category),
        s(r.subcategory),
        s(r.purchase_cost),
        s(r.monthly_lease_cost),
        s(r.monthly_maintenance),
        s(r.useful_life_years),
        s(r.depreciation_method),
        s(r.annual_escalation_pct),
        s(r.effective_date),
      ];
    default:
      return [s(cardType), JSON.stringify(r)];
  }
}

/** Internal: md5 hex digest. Works in browser (SubtleCrypto) and Node. */
function md5Hex(s) {
  // Node path — use crypto if available
  try {
    if (typeof globalThis !== 'undefined' && globalThis.process && globalThis.process.versions?.node) {
      // eslint-disable-next-line
      const c = require('crypto');
      return c.createHash('md5').update(s).digest('hex');
    }
  } catch (_) { /* fall through */ }
  // Browser fallback — custom md5 (small, deterministic). Matches RFC 1321.
  return md5Fallback(s);
}

/**
 * Pure-JS md5 fallback for browsers without crypto. ~1.5kb but no deps.
 * Derived from public-domain implementation at https://github.com/blueimp/JavaScript-MD5
 * (credit: Sebastian Tschan, MIT licensed).
 */
function md5Fallback(s) {
  function toWords(str) {
    const u8 = new TextEncoder().encode(str);
    const words = new Array(((u8.length + 8) >> 6) * 16 + 16).fill(0);
    for (let i = 0; i < u8.length; i++) words[i >> 2] |= u8[i] << ((i & 3) << 3);
    words[u8.length >> 2] |= 0x80 << ((u8.length & 3) << 3);
    words[words.length - 2] = u8.length << 3;
    return words;
  }
  function add32(a, b) { return (a + b) & 0xffffffff; }
  function rol(x, n) { return (x << n) | (x >>> (32 - n)); }
  function cmn(q, a, b, x, s, t) { return add32(rol(add32(add32(a, q), add32(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }

  const x = toWords(s);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    a = ff(a, b, c, d, x[i],       7,  -680876936);
    d = ff(d, a, b, c, x[i + 1],  12,  -389564586);
    c = ff(c, d, a, b, x[i + 2],  17,   606105819);
    b = ff(b, c, d, a, x[i + 3],  22, -1044525330);
    a = ff(a, b, c, d, x[i + 4],   7,  -176418897);
    d = ff(d, a, b, c, x[i + 5],  12,  1200080426);
    c = ff(c, d, a, b, x[i + 6],  17, -1473231341);
    b = ff(b, c, d, a, x[i + 7],  22,   -45705983);
    a = ff(a, b, c, d, x[i + 8],   7,  1770035416);
    d = ff(d, a, b, c, x[i + 9],  12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17,      -42063);
    b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12],  7,  1804603682);
    d = ff(d, a, b, c, x[i + 13], 12,   -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15], 22,  1236535329);

    a = gg(a, b, c, d, x[i + 1],   5,  -165796510);
    d = gg(d, a, b, c, x[i + 6],   9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14,   643717713);
    b = gg(b, c, d, a, x[i],      20,  -373897302);
    a = gg(a, b, c, d, x[i + 5],   5,  -701558691);
    d = gg(d, a, b, c, x[i + 10],  9,    38016083);
    c = gg(c, d, a, b, x[i + 15], 14,  -660478335);
    b = gg(b, c, d, a, x[i + 4],  20,  -405537848);
    a = gg(a, b, c, d, x[i + 9],   5,   568446438);
    d = gg(d, a, b, c, x[i + 14],  9, -1019803690);
    c = gg(c, d, a, b, x[i + 3],  14,  -187363961);
    b = gg(b, c, d, a, x[i + 8],  20,  1163531501);
    a = gg(a, b, c, d, x[i + 13],  5, -1444681467);
    d = gg(d, a, b, c, x[i + 2],   9,   -51403784);
    c = gg(c, d, a, b, x[i + 7],  14,  1735328473);
    b = gg(b, c, d, a, x[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, x[i + 5],   4,     -378558);
    d = hh(d, a, b, c, x[i + 8],  11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16,  1839030562);
    b = hh(b, c, d, a, x[i + 14], 23,   -35309556);
    a = hh(a, b, c, d, x[i + 1],   4, -1530992060);
    d = hh(d, a, b, c, x[i + 4],  11,  1272893353);
    c = hh(c, d, a, b, x[i + 7],  16,  -155497632);
    b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13],  4,   681279174);
    d = hh(d, a, b, c, x[i],      11,  -358537222);
    c = hh(c, d, a, b, x[i + 3],  16,  -722521979);
    b = hh(b, c, d, a, x[i + 6],  23,    76029189);
    a = hh(a, b, c, d, x[i + 9],   4,  -640364487);
    d = hh(d, a, b, c, x[i + 12], 11,  -421815835);
    c = hh(c, d, a, b, x[i + 15], 16,   530742520);
    b = hh(b, c, d, a, x[i + 2],  23,  -995338651);

    a = ii(a, b, c, d, x[i],       6,  -198630844);
    d = ii(d, a, b, c, x[i + 7],  10,  1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5],  21,   -57434055);
    a = ii(a, b, c, d, x[i + 12],  6,  1700485571);
    d = ii(d, a, b, c, x[i + 3],  10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15,    -1051523);
    b = ii(b, c, d, a, x[i + 1],  21, -2054922799);
    a = ii(a, b, c, d, x[i + 8],   6,  1873313359);
    d = ii(d, a, b, c, x[i + 15], 10,   -30611744);
    c = ii(c, d, a, b, x[i + 6],  15, -1560198380);
    b = ii(b, c, d, a, x[i + 13], 21,  1309151649);
    a = ii(a, b, c, d, x[i + 4],   6,  -145523070);
    d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2],  15,   718787259);
    b = ii(b, c, d, a, x[i + 9],  21,  -343485551);

    a = add32(a, aa); b = add32(b, bb); c = add32(c, cc); d = add32(d, dd);
  }
  const hex = v => {
    let out = '';
    for (let j = 0; j < 4; j++) {
      const byte = (v >>> (j * 8)) & 0xff;
      out += ((byte >>> 4) & 0x0f).toString(16) + (byte & 0x0f).toString(16);
    }
    return out;
  };
  return hex(a) + hex(b) + hex(c) + hex(d);
}

// ============================================================
// SCENARIO RATE LOADING — frozen vs live
// ============================================================

/**
 * Decide whether to load rates from snapshots or live ref_* tables.
 * Called before calc runs. If the scenario is approved AND snapshots exist,
 * the calc engine MUST use snapshots — that's the whole point of Phase 3.
 *
 * @param {Scenario} scenario
 * @param {{ live: Object, snapshots: RateSnapshot[] }} payload
 * @returns {{ source: 'snapshot'|'live', rates: Object<string, Object[]> }}
 */
export function loadScenarioRates(scenario, payload) {
  const live = payload?.live || {};
  const snapshots = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
  const hasSnaps = snapshots.length > 0;
  const isApproved = scenario && scenario.status === 'approved';
  if (isApproved && hasSnaps) {
    return { source: 'snapshot', rates: groupSnapshotsByType(snapshots) };
  }
  return { source: 'live', rates: live };
}

/** Group a flat snapshot list into { labor: [...], facility: [...], ... }. */
function groupSnapshotsByType(snapshots) {
  const out = {};
  for (const s of snapshots) {
    const bucket = bucketForRateType(s.rate_card_type);
    if (!out[bucket]) out[bucket] = [];
    // Use the frozen JSON as the "row"; preserves every column the scenario
    // saw at approval time.
    const row = { ...(s.snapshot_json || {}) };
    row._version_hash = s.rate_card_version_hash;
    row._captured_at = s.captured_at;
    out[bucket].push(row);
  }
  return out;
}

function bucketForRateType(t) {
  switch (t) {
    case 'labor': return 'labor';
    case 'facility': return 'facility';
    case 'utility': return 'utility';
    case 'overhead': return 'overhead';
    case 'equipment': return 'equipment';
    case 'heuristics': return 'heuristics';
    default: return t;
  }
}

// ============================================================
// SCENARIO COMPARISON
// ============================================================

/**
 * Row-by-row delta between two scenario output bundles. Each bundle is the
 * return value of monthlyProjectionView() from calc.monthly.js plus an
 * aggregate summary built by the UI. The compare function returns a
 * normalized structure suitable for side-by-side rendering.
 *
 * @param {Object} a  { label, summary, monthly }
 * @param {Object} b  { label, summary, monthly }
 * @returns {Object}  { kpiDelta: {...}, monthlyDelta: [{...}] }
 */
export function compareScenarios(a, b) {
  const kpiKeys = [
    'total_revenue', 'total_opex', 'ebitda', 'ebit',
    'net_income', 'capex', 'npv', 'irr', 'payback_months',
  ];
  const aSum = a?.summary || {};
  const bSum = b?.summary || {};
  const kpiDelta = {};
  for (const k of kpiKeys) {
    const av = numOr0(aSum[k]);
    const bv = numOr0(bSum[k]);
    const diff = bv - av;
    const pct = av !== 0 ? (diff / Math.abs(av)) * 100 : null;
    kpiDelta[k] = { a: av, b: bv, diff, pct_change: pct };
  }
  const aMonthly = Array.isArray(a?.monthly) ? a.monthly : [];
  const bMonthly = Array.isArray(b?.monthly) ? b.monthly : [];
  const byIdx = new Map();
  for (const row of aMonthly) byIdx.set(row.period_index, { a: row, b: null });
  for (const row of bMonthly) {
    const cur = byIdx.get(row.period_index) || { a: null, b: null };
    cur.b = row;
    byIdx.set(row.period_index, cur);
  }
  const monthlyDelta = [];
  const indices = Array.from(byIdx.keys()).sort((x, y) => x - y);
  for (const idx of indices) {
    const { a: ra, b: rb } = byIdx.get(idx);
    monthlyDelta.push({
      period_index: idx,
      period_label: rb?.period_label || ra?.period_label || '',
      revenue:    deltaCell(ra?.revenue, rb?.revenue),
      opex:       deltaCell(ra?.opex, rb?.opex),
      ebitda:     deltaCell(ra?.ebitda, rb?.ebitda),
      net_income: deltaCell(ra?.net_income, rb?.net_income),
      free_cash_flow: deltaCell(ra?.free_cash_flow, rb?.free_cash_flow),
    });
  }
  return { kpiDelta, monthlyDelta };
}

function numOr0(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function deltaCell(a, b) {
  const av = numOr0(a), bv = numOr0(b);
  return { a: av, b: bv, diff: bv - av, pct_change: av !== 0 ? ((bv - av) / Math.abs(av)) * 100 : null };
}

// ============================================================
// LIFECYCLE PAYLOADS
// ============================================================

/**
 * Return the payload shape the UI should POST via api.approveScenario.
 * Keeping this pure lets the tests assert shape without touching Supabase.
 *
 * @param {number} scenarioId
 * @param {string|null} userEmail
 * @returns {{ p_scenario_id: number, p_user_email: string|null }}
 */
export function buildApprovalPayload(scenarioId, userEmail) {
  if (!scenarioId || !Number.isInteger(Number(scenarioId))) {
    throw new Error('buildApprovalPayload: scenarioId must be an integer');
  }
  return {
    p_scenario_id: Number(scenarioId),
    p_user_email: userEmail || null,
  };
}

/**
 * Given a source scenario, produce the "child scenario" header. The UI will
 * call this, insert the new scenario row (with parent_scenario_id), clone
 * the project + line rows, and re-link.
 *
 * @param {Scenario} source
 * @param {string|null} newLabel
 * @returns {Object}   partial cost_model_scenarios row
 */
export function spawnChildPayload(source, newLabel) {
  if (!source || !source.id) throw new Error('spawnChildPayload: source scenario required');
  return {
    deal_id: source.deal_id || null,
    parent_scenario_id: source.id,
    scenario_label: (newLabel && String(newLabel).trim()) || `${source.scenario_label || 'Scenario'} (child)`,
    is_baseline: false,
    status: 'draft',
  };
}

/**
 * Shape a revision row. The caller supplies inputs/outputs; this just
 * normalizes and adds a monotonic revision_number from the previous count.
 *
 * @param {number} scenarioId
 * @param {number} previousRevisionNumber
 * @param {string|null} changedBy
 * @param {string} summary
 * @param {Object} inputs
 * @param {Object} outputs
 * @returns {Object}
 */
export function buildRevisionRow(scenarioId, previousRevisionNumber, changedBy, summary, inputs, outputs) {
  if (!scenarioId) throw new Error('buildRevisionRow: scenarioId required');
  const next = Number.isInteger(previousRevisionNumber) ? previousRevisionNumber + 1 : 1;
  return {
    scenario_id: Number(scenarioId),
    revision_number: next,
    changed_by: changedBy || null,
    change_summary: summary || '(unspecified)',
    inputs_json: inputs || {},
    outputs_json: outputs || {},
  };
}

// ============================================================
// EFFECTIVE RATE LOOKUP (current vs superseded)
// ============================================================

/**
 * Build the heuristic map that the monthly calc engine should consume,
 * applying the full resolution chain:
 *
 *   approved-snapshot  →  project override jsonb  →  project column
 *
 * `snapshots` is the grouped output of loadScenarioRates (already filtered
 * for heuristics), `overrides` is the project's live heuristic_overrides
 * jsonb, and `projectCols` is an object carrying the legacy flat fields
 * (taxRate, dsoDays, etc.) — the last-resort defaults.
 *
 * Returns a record with the keys the calc layer expects, using canonical
 * units matching buildYearlyProjections (percent values are raw %, not
 * fractions — 25 means 25%).
 *
 * @param {Scenario|null} scenario
 * @param {{ heuristics?: Object[] }|null} snapshots  Output of loadScenarioRates
 * @param {Object|null} overrides                    project.heuristic_overrides
 * @param {Object} projectCols                       fallback bag
 * @returns {{
 *   taxRatePct: number, dsoDays: number, dpoDays: number,
 *   laborPayableDays: number, laborEscPct: number, costEscPct: number,
 *   equipmentEscPct: number, facilityEscPct: number,
 *   volGrowthPct: number, targetMarginPct: number,
 *   preGoLiveMonths: number, absenceAllowancePct: number,
 *   benefitLoadPct: number, overtimePct: number, bonusPct: number,
 *   shift2PremiumPct: number, shift3PremiumPct: number,
 *   rampWeeksLow: number, rampWeeksMed: number, rampWeeksHigh: number,
 *   unitsPerTruck: number, dockSfPerDoor: number, rackHoneycombPct: number,
 *   source: 'snapshot'|'override'|'default', used: Object<string, string>
 * }}
 */
export function resolveCalcHeuristics(scenario, snapshots, overrides, projectCols) {
  const heuristicsSnap = snapshots && Array.isArray(snapshots.heuristics) ? snapshots.heuristics : [];
  const o = overrides || {};
  const p = projectCols || {};
  const fromSnap = new Map();
  for (const row of heuristicsSnap) {
    // snapshot_json shape (from approve_scenario RPC):
    //   { key, label, category, default_value, default_enum, override, effective }
    if (!row || !row.key) continue;
    // prefer .effective (what was in force at approval); fall back to default_value
    let v = row.effective;
    if (v === undefined || v === null) v = row.default_value ?? row.default_enum;
    fromSnap.set(row.key, v);
  }
  const isApproved = scenario && scenario.status === 'approved' && fromSnap.size > 0;
  const used = {};
  function pick(key, fallback) {
    if (isApproved && fromSnap.has(key)) { used[key] = 'snapshot'; return fromSnap.get(key); }
    if (Object.prototype.hasOwnProperty.call(o, key) && o[key] !== null && o[key] !== undefined && o[key] !== '') {
      used[key] = 'override'; return o[key];
    }
    used[key] = 'default';
    return fallback;
  }
  const n = (x, d = 0) => { const v = Number(x); return Number.isFinite(v) ? v : d; };
  return {
    // Financial
    taxRatePct:           n(pick('tax_rate_pct',            p.taxRate           ?? 25),   25),
    targetMarginPct:      n(pick('target_margin_pct',       p.targetMargin      ?? 12),   12),
    volGrowthPct:         n(pick('annual_volume_growth_pct', p.volumeGrowth      ?? 0),   0),
    // Working Capital
    dsoDays:              n(pick('dso_days',                p.dsoDays           ?? 30),   30),
    dpoDays:              n(pick('dpo_days',                p.dpoDays           ?? 30),   30),
    laborPayableDays:     n(pick('labor_payable_days',      p.laborPayableDays  ?? 14),   14),
    preGoLiveMonths:      n(pick('pre_go_live_months',      p.preGoLiveMonths   ?? 0),    0),
    // Labor
    benefitLoadPct:       n(pick('benefit_load_pct',        p.benefitLoad       ?? 35),   35),
    bonusPct:             n(pick('bonus_pct',               p.bonus             ?? 0),    0),
    overtimePct:          n(pick('overtime_pct',            p.overtime          ?? 5),    5),
    absenceAllowancePct:  n(pick('absence_allowance_pct',   p.absenceAllowance  ?? 12),   12),
    shift2PremiumPct:     n(pick('shift_2_premium_pct',     p.shift2Premium     ?? 10),   10),
    shift3PremiumPct:     n(pick('shift_3_premium_pct',     p.shift3Premium     ?? 15),   15),
    laborEscPct:          n(pick('labor_escalation_pct',    p.laborEscalation   ?? 3),    3),
    // Ramp + Seasonality
    rampWeeksLow:         n(pick('ramp_weeks_low',          p.rampWeeksLow      ?? 2),    2),
    rampWeeksMed:         n(pick('ramp_weeks_med',          p.rampWeeksMed      ?? 4),    4),
    rampWeeksHigh:        n(pick('ramp_weeks_high',         p.rampWeeksHigh     ?? 8),    8),
    // Ops + Escalation
    equipmentEscPct:      n(pick('equipment_escalation_pct', p.equipmentEscalation ?? 3), 3),
    facilityEscPct:       n(pick('facility_escalation_pct',  p.facilityEscalation  ?? 3), 3),
    costEscPct:           n(pick('facility_escalation_pct',  p.annualEscalation    ?? 3), 3),
    unitsPerTruck:        n(pick('units_per_truck',          p.unitsPerTruck      ?? 25000), 25000),
    dockSfPerDoor:        n(pick('dock_sf_per_door',         p.dockSfPerDoor      ?? 700),   700),
    rackHoneycombPct:     n(pick('rack_honeycomb_pct',       p.rackHoneycomb      ?? 20),    20),
    // Meta
    source: isApproved ? 'snapshot' : (Object.keys(o).length ? 'mixed' : 'default'),
    used,
  };
}

// ============================================================
// PHASE 4b — MONTHLY LABOR PROFILES (OT + absence)
// ============================================================

/**
 * Resolve the OT% for a labor line in a specific calendar month.
 * Resolution chain:
 *   per-line monthly profile → market profile (Phase 4c) → project flat
 *
 * @param {{ monthly_overtime_profile?: number[]|null }} line
 * @param {number} monthIndex                   0-11 (0 = January)
 * @param {{ peak_month_overtime_pct?: number[]|null }|null} marketProfile
 * @param {number} fallbackPct                  project flat (e.g. 5 for 5%)
 * @returns {number}                             percent (e.g. 12 for 12%)
 */
export function monthlyOvertimePct(line, monthIndex, marketProfile, fallbackPct) {
  const m = ((Number(monthIndex) % 12) + 12) % 12;
  const fromLine = Array.isArray(line?.monthly_overtime_profile) && line.monthly_overtime_profile.length === 12
    ? line.monthly_overtime_profile[m]
    : null;
  if (fromLine !== null && fromLine !== undefined) {
    // Stored as fractions in the catalog convention (0-1) → return as percent for math layer
    return Number(fromLine) * 100;
  }
  const fromMarket = marketProfile && Array.isArray(marketProfile.peak_month_overtime_pct) && marketProfile.peak_month_overtime_pct.length === 12
    ? marketProfile.peak_month_overtime_pct[m]
    : null;
  if (fromMarket !== null && fromMarket !== undefined) {
    return Number(fromMarket) * 100;
  }
  return Number(fallbackPct) || 0;
}

/**
 * Resolve absence% for a labor line in a specific calendar month.
 * Same resolution chain as monthlyOvertimePct.
 *
 * @param {{ monthly_absence_profile?: number[]|null }} line
 * @param {number} monthIndex
 * @param {{ peak_month_absence_pct?: number[]|null }|null} marketProfile
 * @param {number} fallbackPct
 * @returns {number}
 */
export function monthlyAbsencePct(line, monthIndex, marketProfile, fallbackPct) {
  const m = ((Number(monthIndex) % 12) + 12) % 12;
  const fromLine = Array.isArray(line?.monthly_absence_profile) && line.monthly_absence_profile.length === 12
    ? line.monthly_absence_profile[m]
    : null;
  if (fromLine !== null && fromLine !== undefined) return Number(fromLine) * 100;
  const fromMarket = marketProfile && Array.isArray(marketProfile.peak_month_absence_pct) && marketProfile.peak_month_absence_pct.length === 12
    ? marketProfile.peak_month_absence_pct[m]
    : null;
  if (fromMarket !== null && fromMarket !== undefined) return Number(fromMarket) * 100;
  return Number(fallbackPct) || 0;
}

/**
 * Effective monthly hours for a labor line, accounting for OT and absence.
 * Base hours = annual_hours / 12. Then:
 *   effective = base × (1 + OT/100) × (1 - absence/100)
 *
 * @param {{ annual_hours?: number, monthly_overtime_profile?, monthly_absence_profile? }} line
 * @param {number} monthIndex                                    0-11
 * @param {{ overtimePct: number, absenceAllowancePct: number }} calcHeur   from resolveCalcHeuristics
 * @param {Object|null} marketProfile                            optional Phase 4c lookup
 * @returns {number}
 */
export function monthlyEffectiveHours(line, monthIndex, calcHeur, marketProfile) {
  const baseAnnual = Number(line?.annual_hours) || 0;
  if (baseAnnual === 0) return 0;
  const otPct = monthlyOvertimePct(line, monthIndex, marketProfile, calcHeur?.overtimePct ?? 0);
  const absPct = monthlyAbsencePct(line, monthIndex, marketProfile, calcHeur?.absenceAllowancePct ?? 0);
  const baseMonthly = baseAnnual / 12;
  return baseMonthly * (1 + otPct / 100) * (1 - absPct / 100);
}

/**
 * Sum monthlyEffectiveHours across all 12 months. Useful for proving
 * that the sum-of-monthly equals annual_hours when both OT and absence
 * profiles are flat at the project default.
 *
 * @param {Object} line
 * @param {Object} calcHeur
 * @param {Object|null} marketProfile
 * @returns {number}
 */
export function annualEffectiveHoursFromMonthly(line, calcHeur, marketProfile) {
  let total = 0;
  for (let m = 0; m < 12; m++) total += monthlyEffectiveHours(line, m, calcHeur, marketProfile);
  return total;
}

/**
 * Validate a 12-element profile array. Returns issue string or null.
 * Allows null (means "inherit"). When provided, must be exactly 12
 * non-negative numbers ≤ 2.0 (no individual month over 200% sanity check).
 *
 * @param {number[]|null|undefined} profile
 * @returns {string|null}
 */
export function validateMonthlyProfile(profile) {
  if (profile === null || profile === undefined) return null;
  if (!Array.isArray(profile)) return 'profile must be an array or null';
  if (profile.length !== 12) return `profile must have exactly 12 entries (got ${profile.length})`;
  for (let i = 0; i < 12; i++) {
    const v = Number(profile[i]);
    if (!Number.isFinite(v)) return `month ${i + 1} must be a number`;
    if (v < 0) return `month ${i + 1} cannot be negative`;
    if (v > 2.0) return `month ${i + 1} cannot exceed 2.0 (200%)`;
  }
  return null;
}

/**
 * Build a flat default profile (all-equal) — convenience for "use project
 * flat" → write [pct, pct, ..., pct] explicitly so users can edit.
 *
 * @param {number} fractionalPct  e.g. 0.05 for 5%
 * @returns {number[]}
 */
export function flatProfile(fractionalPct) {
  const v = Number(fractionalPct) || 0;
  return Array.from({ length: 12 }, () => v);
}

/**
 * Given a list of SCD rows, return only the "current" ones — those whose
 * effective_end_date is in the future AND have no superseded_by_id. Useful
 * in the UI when the caller has already fetched ref_labor_rates (without
 * relying on the ref_*_current views).
 *
 * @param {Object[]} rows
 * @param {Date}     asOf   optional as-of date; defaults to today
 * @returns {Object[]}
 */
export function filterCurrent(rows, asOf) {
  const today = asOf instanceof Date ? asOf : new Date();
  const todayStr = today.toISOString().slice(0, 10);
  return (rows || []).filter(r => {
    if (r.superseded_by_id) return false;
    const end = r.effective_end_date || '9999-12-31';
    return String(end) > todayStr;
  });
}

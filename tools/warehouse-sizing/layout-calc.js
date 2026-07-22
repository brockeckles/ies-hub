/**
 * IES Hub v3 — WSC layout synthesis + compliance engine (N5, 2026-07-04)
 *
 * Two jobs:
 *
 *  1. GRID-FIT — coordinate the column grid with the rack-bay pitch:
 *     bays per column module, leftover slack, column-burial verdict
 *     (columns land inside rack rows, not aisles), flue-conflict flag,
 *     and a recommended grid when the current one fights the racking.
 *     (Research-corrected: seven 96" bays + uprights ≈ 58 ft, NOT 56.)
 *
 *  2. COMPLIANCE CHECKLIST — the standards stack as CHECKED CONSTRAINTS,
 *     each PASS/FAIL/N-A with measured vs required and a citation:
 *     flue spaces (FM DS 8-9 net-3" default per Brock 2026-07-04, NFPA 13
 *     nominal-6" toggle), IBC S-1 egress travel (250 / 400 single-story
 *     ≥24 ft), OSHA/NFPA 18" sprinkler deflector clearance, aisle width vs
 *     the MHE-derived governing aisle (N4), ESFR ceiling-only limit, and
 *     staging-per-door floor.
 *
 *  Plus a U-flow vs through-flow advisory from the dock configuration.
 *
 * Pure module — zero DOM. Tested by test-wsc-layout.mjs.
 *
 * @module tools/warehouse-sizing/layout-calc
 */

import { wscFactorValue } from './factors-calc.js?v=20260704-n2a';
import { computeUnitLoad } from './calc.js?v=20260722-s2';

export const RACK_UPRIGHT_WIDTH_IN = 3;   // typical structural upright column width

const DEFAULTS = {
  grid: { min: 50, max: 56, speed_bay: 60 },
  flueFm: { transverse_net_in: 3, longitudinal_required: false },
  flueNfpa: { transverse_nominal_in: 6, longitudinal_required_above_ft: 25, longitudinal_nominal_in: 6 },
  egress: { sprinklered: 250, single_story_24ft_clear: 400 },
  deflectorClearanceIn: 18,
  esfr: { min: 40, max: 45 },
  minSqftPerDoor: 510,
};

function _factor(pinned, code, fallback) {
  const v = wscFactorValue(pinned, code);
  return v == null ? fallback : v;
}

// ============================================================
// GRID-FIT
// ============================================================

/**
 * Fit rack bays into the column grid.
 * Bay pitch = unit-load bay width + one upright (uprights shared between
 * bays; the module's closing upright is absorbed by the column line).
 *
 * @param {Object} args — { facility, pinnedFactors }
 * @returns {Object} gridFit
 */
export function computeGridFit({ facility = {}, pinnedFactors = null } = {}) {
  const grid = _factor(pinnedFactors, 'wsc.grid.column_spacing_ft', DEFAULTS.grid);
  const u = computeUnitLoad({
    palletType: facility.palletType,
    palletLengthIn: facility.palletWidth,   // engine convention: width = long side (48)
    palletWidthIn: facility.palletDepth,
    flueSpaceIn: facility.flueSpace,
  });
  const bayPitchIn = u.bayWidthIn + RACK_UPRIGHT_WIDTH_IN;
  const spanXFt = Number(facility.columnSpacingX) > 0 ? Number(facility.columnSpacingX) : 50;
  const spanXIn = spanXFt * 12;
  // Column occupies ~12" of the line; usable run between column faces:
  const usableIn = spanXIn - 12;
  const baysPerModule = Math.floor(usableIn / bayPitchIn);
  const slackIn = usableIn - baysPerModule * bayPitchIn;
  // Column burial: back-to-back rack row depth must swallow a ~12" column.
  const rowDepthFt = u.rackDepthBackToBackFt;
  const columnBuriable = rowDepthFt * 12 >= 12;
  // Flue conflict: slack < flue means the column line lands tight against
  // pallets with no room to preserve the transverse flue at the column.
  const flueIn = Number(facility.flueSpace) > 0 ? Number(facility.flueSpace) : 3;
  const flueConflict = slackIn < flueIn;

  // Recommended grid: smallest span in [grid.min..grid.max] (whole ft) that
  // fits one MORE bay than the current span at ≥ flue slack, else current.
  let recommended = null;
  for (let ft = Math.ceil(grid.min); ft <= Math.floor(grid.max); ft++) {
    const use = ft * 12 - 12;
    const n = Math.floor(use / bayPitchIn);
    const s = use - n * bayPitchIn;
    if (s >= flueIn && (recommended == null || n > recommended.baysPerModule
        || (n === recommended.baysPerModule && ft < recommended.spanFt))) {
      recommended = { spanFt: ft, baysPerModule: n, slackIn: Math.round(s * 10) / 10 };
    }
  }

  return {
    bayWidthIn: u.bayWidthIn,
    bayPitchIn,
    spanXFt,
    baysPerModule,
    slackIn: Math.round(slackIn * 10) / 10,
    columnBuriable,
    flueConflict,
    rowDepthFt: Math.round(rowDepthFt * 100) / 100,
    recommended,
    rationale: `${spanXFt} ft span − 12" column = ${Math.round(usableIn)}" usable ÷ ${bayPitchIn}" bay pitch ` +
      `(${u.bayWidthIn}" bay + ${RACK_UPRIGHT_WIDTH_IN}" upright) → ${baysPerModule} bays/module, ${Math.round(slackIn)}" slack` +
      `${flueConflict ? ' — CONFLICT: slack < flue at the column line' : ''}` +
      `${recommended && recommended.spanFt !== spanXFt ? ` · recommend ${recommended.spanFt} ft (${recommended.baysPerModule} bays, ${recommended.slackIn}" slack)` : ''}`,
    citations: ['wsc.grid.column_spacing_ft'],
  };
}

// ============================================================
// COMPLIANCE CHECKLIST
// ============================================================

const _check = (id, label, required, actual, pass, citation, note = null) => ({
  id, label, required, actual,
  status: pass === null ? 'N/A' : pass ? 'PASS' : 'FAIL',
  citation, note,
});

/**
 * Run the standards checklist against the current design.
 * @param {Object} args — { facility, zones, dynamicsPlan, flueStandard ('FM'|'NFPA'), pinnedFactors }
 * @returns {{ checks: Object[], failCount: number, flueStandard: string }}
 */
export function runComplianceChecks({ facility = {}, zones = {}, dynamicsPlan = null, flueStandard = null, pinnedFactors = null } = {}) {
  const checks = [];
  const clearFt = Number(facility.clearHeight) > 0 ? Number(facility.clearHeight) : 32;

  // ── Flue spaces (FM default per catalog / Brock decision) ──
  const flueDefault = _factor(pinnedFactors, 'wsc.flue.default_standard', { default: 'FM' });
  const std = flueStandard || flueDefault.default || 'FM';
  const flueIn = Number(facility.flueSpace) > 0 ? Number(facility.flueSpace) : 3;
  if (std === 'FM') {
    const fm = _factor(pinnedFactors, 'wsc.flue.fm_ds8_9', DEFAULTS.flueFm);
    checks.push(_check('flue', 'Transverse flue (FM DS 8-9, net)', `≥ ${fm.transverse_net_in}"`, `${flueIn}"`,
      flueIn >= fm.transverse_net_in, 'FM Global DS 8-9',
      'Longitudinal flue not required in double-row racks under FM.'));
  } else {
    const nfpa = _factor(pinnedFactors, 'wsc.flue.nfpa_13', DEFAULTS.flueNfpa);
    checks.push(_check('flue', 'Transverse flue (NFPA 13, nominal)', `≥ ${nfpa.transverse_nominal_in}"`, `${flueIn}"`,
      flueIn >= nfpa.transverse_nominal_in, 'NFPA 13'));
    // Longitudinal applies above 25 ft STORAGE height — approximate with top-of-storage.
    const storageTopFt = clearFt - (Number(facility.topClearance) || 36) / 12;
    if (storageTopFt > nfpa.longitudinal_required_above_ft) {
      checks.push(_check('flue-long', 'Longitudinal flue (NFPA 13 >25 ft storage)', `≥ ${nfpa.longitudinal_nominal_in}"`, 'not modeled',
        false, 'NFPA 13', 'Storage above 25 ft — double-row racks need a 6" longitudinal flue; add to rack rows.'));
    }
  }

  // ── IBC S-1 egress travel ──
  const egress = _factor(pinnedFactors, 'wsc.egress.s1_travel_ft', DEFAULTS.egress);
  const W = Number(facility.buildingWidth) > 0 ? Number(facility.buildingWidth) : null;
  const D = Number(facility.buildingDepth) > 0 ? Number(facility.buildingDepth) : null;
  if (W && D) {
    // Worst-case rectilinear travel with exits on the dock wall + far corners:
    // conservative planning estimate ≈ depth + half the width.
    const worstTravel = Math.round(D + W / 2);
    const limit = clearFt >= 24 ? egress.single_story_24ft_clear : egress.sprinklered;
    checks.push(_check('egress', 'Exit-access travel (IBC S-1, sprinklered)', `≤ ${limit} ft`, `~${worstTravel} ft (est.)`,
      worstTravel <= limit, 'IBC 2024 §1017.2' + (limit === 400 ? ' / §1017.2.2' : ''),
      limit === 400 ? 'Single-story ≥24 ft clear qualifies for the 400 ft allowance.'
        : 'Clear <24 ft — only the base 250 ft applies.'));
  } else {
    checks.push(_check('egress', 'Exit-access travel (IBC S-1)', `≤ ${egress.sprinklered}–${egress.single_story_24ft_clear} ft`, 'no building dims',
      null, 'IBC 2024 §1017.2', 'Size the building (Design mode) to evaluate.'));
  }

  // ── Sprinkler deflector clearance ──
  const deflector = Number(_factor(pinnedFactors, 'wsc.sprinkler.deflector_clearance_in', DEFAULTS.deflectorClearanceIn));
  const topClearIn = Number(facility.topClearance) > 0 ? Number(facility.topClearance) : 36;
  checks.push(_check('sprinkler', 'Clearance below sprinkler deflectors', `≥ ${deflector}"`, `${topClearIn}"`,
    topClearIn >= deflector, 'OSHA 1910.159 / NFPA 13'));

  // ── Aisle width vs MHE-derived governing aisle (N4) ──
  const governing = dynamicsPlan?.mhe?.governingAisleFt || null;
  const aisleFt = Number(facility.aisleWidth) > 0 ? Number(facility.aisleWidth) : null;
  if (governing && aisleFt) {
    checks.push(_check('aisle', 'Storage aisle vs MHE assumption', `≥ ${governing} ft (${dynamicsPlan.mhe.fleet.find(f => f.aisleFt === governing)?.label || 'governing truck'})`,
      `${aisleFt} ft`, aisleFt >= governing, 'wsc.aisle.widths_by_mhe_ft (catalog)'));
  } else {
    checks.push(_check('aisle', 'Storage aisle vs MHE assumption', 'run Dynamics (N4)', aisleFt ? `${aisleFt} ft` : 'default',
      null, 'wsc.aisle.widths_by_mhe_ft (catalog)', 'Apply a dynamics plan to derive the governing aisle.'));
  }

  // ── ESFR ceiling-only limit ──
  const esfr = _factor(pinnedFactors, 'wsc.height.esfr_ceiling_only_max_ft', DEFAULTS.esfr);
  checks.push(_check('esfr', 'ESFR ceiling-only protection', `clear ≤ ~${esfr.min}–${esfr.max} ft`, `${clearFt} ft`,
    clearFt <= esfr.max, 'NFPA 13 / OPSdesign',
    clearFt > esfr.min ? 'Approaching/exceeding ceiling-only limits — in-rack sprinklers change the rack cost model.' : null));

  // ── Staging floor per door (N4 cross-check) ──
  const minPerDoor = Number(_factor(pinnedFactors, 'wsc.staging.min_sqft_per_door', DEFAULTS.minSqftPerDoor));
  const doors = (zones.dockConfig?.inboundDoors || 0) + (zones.dockConfig?.outboundDoors || 0);
  const stagingSqft = (Number(zones.receiveStagingSqft) || 0) + (Number(zones.shipStagingSqft) || 0);
  if (doors > 0) {
    checks.push(_check('staging', 'Staging floor per dock door', `≥ ${minPerDoor} sqft/door × ${doors}`, `${stagingSqft.toLocaleString()} sqft`,
      stagingSqft >= minPerDoor * doors, 'wsc.staging.min_sqft_per_door (catalog)'));
  }

  return {
    checks,
    failCount: checks.filter(c => c.status === 'FAIL').length,
    flueStandard: std,
  };
}

// ============================================================
// FLOW-PATTERN ADVISORY
// ============================================================

/**
 * U-flow vs through-flow advisory from dock configuration.
 * @param {Object} zones
 * @returns {{ pattern: string, advisory: string }}
 */
export function flowPatternAdvisory(zones = {}) {
  const sided = zones.dockConfig?.sided || 'single';
  if (sided === 'two') {
    return {
      pattern: 'through-flow',
      advisory: 'Two-sided docks = through-flow. Justified when inbound and outbound peak simultaneously at high volume, unit profiles differ sharply (pallets in / parcels out), or the site has road access on two sides. Otherwise U-flow shares doors, yard, and MHE between waves — confirm the driver.',
    };
  }
  return {
    pattern: 'U-flow',
    advisory: 'Single-sided docks = U-flow (industry default): shared doors/yard/labor between inbound and outbound, fast movers slotted near docks, natural cross-dock adjacency. Add a 60 ft speed bay at the dock wall.',
  };
}

// ============================================================
// ORCHESTRATOR
// ============================================================

/**
 * @returns {Object} LayoutPlan — gridFit + compliance + flow pattern
 */
export function synthesizeLayout({ facility = {}, zones = {}, dynamicsPlan = null, flueStandard = null, pinnedFactors = null } = {}) {
  const gridFit = computeGridFit({ facility, pinnedFactors });
  const compliance = runComplianceChecks({ facility, zones, dynamicsPlan, flueStandard, pinnedFactors });
  const flow = flowPatternAdvisory(zones);
  const gaps = [];
  if (gridFit.flueConflict) gaps.push({ code: 'GRID_FLUE_CONFLICT', severity: 'warn',
    message: `Column-line slack (${gridFit.slackIn}") is below the flue requirement — shift the grid or shorten the module (${gridFit.rationale}).` });
  if (compliance.failCount > 0) gaps.push({ code: 'COMPLIANCE_FAILS', severity: 'warn',
    message: `${compliance.failCount} compliance check(s) failing — resolve before the Design Basis doc goes out.` });
  if (!dynamicsPlan) gaps.push({ code: 'NO_DYNAMICS_PLAN', severity: 'info',
    message: 'Aisle compliance is indeterminate until a dynamics plan is applied.' });
  return {
    engine: 'wsc-layout-v1',
    createdAt: new Date().toISOString().slice(0, 10),
    flueStandard: compliance.flueStandard,
    gridFit,
    compliance,
    flow,
    gaps,
    citations: gridFit.citations.concat(['wsc.flue.fm_ds8_9', 'wsc.flue.nfpa_13', 'wsc.egress.s1_travel_ft',
      'wsc.sprinkler.deflector_clearance_in', 'wsc.height.esfr_ceiling_only_max_ft']),
  };
}

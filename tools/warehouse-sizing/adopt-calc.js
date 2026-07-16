/**
 * IES Hub v3 — WSC Adopt-flow (W5 of the UX redesign, 2026-07-16)
 *
 * Concept D's fix for the three-Apply-buttons wart: under the station shell
 * each derivation card carries ONE Adopt bar. Adopting a stage applies its
 * FRESH derivation and re-derives every downstream stage that was already
 * adopted — derived output flows forward with one decision, and nothing
 * downstream is left silently stale.
 *
 * Staleness is DATA-DRIVEN: an adopted plan is compared against a freshly
 * computed preview on its material figures (planFingerprint). No new
 * persisted fields — pre-W5 scenarios get correct statuses by construction,
 * and the persistence contract is untouched.
 *
 * Pure module: no DOM, no state. ui-basis owns the policies and the apply
 * callbacks; this module owns fingerprints, statuses, and summaries.
 *
 * @module tools/warehouse-sizing/adopt-calc
 */

/** Derivation chain order — downstream stages re-derive on upstream adopt. */
export const ADOPT_CHAIN = ['media', 'dynamics', 'layout'];

/** Stages that re-derive when `kind` is adopted (already-adopted ones only). */
export const ADOPT_DOWNSTREAM = {
  media: ['dynamics', 'layout'],
  dynamics: ['layout'],
  layout: [],
};

/** Human labels for the Adopt button's forward arrow. */
export const ADOPT_BUTTON_LABEL = {
  media: 'Adopt → Flow & Building',
  dynamics: 'Adopt → Building',
  layout: 'Adopt',
};

/**
 * Material figures of a plan — the fields whose change makes an adopted
 * plan STALE. Deliberately excludes createdAt/gaps/rationale prose.
 * @returns {string|null} stable fingerprint, or null for a missing plan.
 */
export function planFingerprint(kind, plan) {
  if (!plan) return null;
  if (kind === 'media') {
    return JSON.stringify({
      pos: plan.totals?.positions ?? 0,
      alloc: plan.allocation
        ? [plan.allocation.fullPallet, plan.allocation.cartonOnPallet, plan.allocation.cartonOnShelving]
        : null,
      media: (plan.bands || []).map(b => b.mediaLabel || b.family || ''),
      shelving: !!plan.shelving,
      rotation: plan.policy?.rotation || 'none',
    });
  }
  if (kind === 'dynamics') {
    return JSON.stringify({
      in: plan.docks?.inbound?.doors ?? 0,
      out: plan.docks?.outbound?.doors ?? 0,
      staging: plan.staging?.totalSqft ?? 0,
      aisle: plan.mhe?.governingAisleFt ?? 0,
    });
  }
  if (kind === 'layout') {
    return JSON.stringify({
      flue: plan.flueStandard || '',
      span: plan.gridFit?.recommended?.spanFt ?? plan.gridFit?.spanXFt ?? 0,
      fails: plan.compliance?.failCount ?? 0,
    });
  }
  return null;
}

/**
 * Adoption status of one stage.
 *   'none'    — nothing derivable and nothing adopted (stage not reachable yet)
 *   'pending' — fresh derivation exists, nothing adopted yet
 *   'current' — adopted plan matches the fresh derivation
 *   'stale'   — adopted plan diverges from the fresh derivation (or the
 *               fresh derivation is no longer possible at all)
 */
export function adoptStatus(kind, applied, fresh) {
  if (!fresh) return applied ? 'stale' : 'none';
  if (!applied) return 'pending';
  return planFingerprint(kind, applied) === planFingerprint(kind, fresh) ? 'current' : 'stale';
}

/** One-line requirement summary for the Adopt bar ("what adopting sets"). */
export function adoptSummary(kind, plan) {
  if (!plan) return '';
  const n = (v) => Math.round(v || 0).toLocaleString();
  if (kind === 'media') {
    const top = (plan.bands || []).reduce((a, b) => (b.positions > (a?.positions || 0) ? b : a), null);
    return `${n(plan.totals?.positions)} positions · ${top?.mediaLabel || 'mixed media'}`
      + (plan.allocation ? ` · mix ${plan.allocation.fullPallet}/${plan.allocation.cartonOnPallet}/${plan.allocation.cartonOnShelving}` : '');
  }
  if (kind === 'dynamics') {
    const doors = (plan.docks?.inbound?.doors || 0) + (plan.docks?.outbound?.doors || 0);
    return `${doors} doors · ${n(plan.staging?.totalSqft)} sqft staging · ${plan.mhe?.governingAisleFt || 0} ft aisles`;
  }
  if (kind === 'layout') {
    return `${plan.flueStandard || ''} flues · ${plan.gridFit?.recommended?.spanFt ?? plan.gridFit?.spanXFt ?? 0} ft grid`
      + (plan.compliance?.failCount > 0 ? ` · ${plan.compliance.failCount} failing` : ' · all clear');
  }
  return '';
}

/**
 * Full adopt model for the three stages.
 * @param {{applied: Object, fresh: Object}} bags — {media, dynamics, layout} each.
 */
export function buildAdoptModel({ applied = {}, fresh = {} } = {}) {
  const stages = {};
  for (const kind of ADOPT_CHAIN) {
    const status = adoptStatus(kind, applied[kind], fresh[kind]);
    stages[kind] = {
      status,
      summary: adoptSummary(kind, fresh[kind] || applied[kind]),
      buttonLabel: ADOPT_BUTTON_LABEL[kind],
      downstream: ADOPT_DOWNSTREAM[kind],
    };
  }
  return {
    stages,
    anyStale: ADOPT_CHAIN.some(k => stages[k].status === 'stale'),
    anyPending: ADOPT_CHAIN.some(k => stages[k].status === 'pending'),
  };
}

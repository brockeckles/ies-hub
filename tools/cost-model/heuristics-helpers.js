/**
 * cost-model/heuristics-helpers.js — pure helpers around the scenario
 * heuristics resolution flow.
 *
 * Extracted from `cost-model/ui.js` 2026-05-11 (S18) so the new
 * header-kpis.js + what-if-preview.js modules can import them without
 * a circular dep back into ui.js. Both functions were already pure
 * (took cmModel as a param, no closure-state reads) — they just
 * happened to live in ui.js because the original implementation grew
 * up there.
 *
 * Call signatures and return shapes are unchanged. ui.js continues
 * to consume them at every existing call site by importing from here.
 */

/**
 * Compute the project-side fallback heuristics for a cost model.
 *
 * Returns the merged financial+laborCosting bag the scenarios runtime
 * uses when a heuristic value isn't otherwise overridden. Bug A fix:
 * Settings → Labor Factors → Overtime % maps onto the `overtime` key.
 *
 * @param {Object} [cmModel] — cost-model state (reads .financial, .laborCosting)
 * @returns {Object} merged fallback bag
 */
export function _heurProjectFallbacks(cmModel) {
  const fin = cmModel?.financial    || {};
  const lc  = cmModel?.laborCosting || {};
  return {
    ...fin,
    // Settings → Labor Factors → Overtime % (Bug A fix)
    overtime: lc.overtimePct ?? fin.overtime,
  };
}

/**
 * Apply split-month billing overrides onto a resolved calcHeur bag.
 *
 * When the cost model's contractType is `split_month`, the
 * weighted-average DSO is a blend of the fixed-pct and variable-pct
 * billing periods. This function rewrites `dsoDays` on the calcHeur
 * bag to that weighted value and records the breakdown on
 * `_splitMonthApplied` for diagnostic display. No-op for any other
 * contractType.
 *
 * @param {Object} calcHeur — resolved heuristics from scenarios.resolveCalcHeuristics
 * @param {Object} cmModel  — cost-model state (reads .projectDetails)
 * @returns {Object} maybe-overridden calcHeur (returns input unchanged if no-op)
 */
export function applySplitMonthBilling(calcHeur, cmModel) {
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

// test-bw-dm-rail-artifacts.mjs — BW (2026-07-23): DM walk-warts, two fixes.
//
// Fix 1 — rail hydration flash: renderWorkflowRail's Size / Labor / Network
//   counts read _designScenariosByDeal, which _hydrateDealDetail populates
//   async — first paint showed a false "0" and then flashed to the real
//   counts on the hydrate re-render. Pin: a loading predicate at the top of
//   the rail ('real deal AND cache not yet seeded' — demo deals never
//   hydrate, so a bare .has() would pin them on '—' forever), a muted '—'
//   count-pill path, and no bare unguarded count expression remaining. The
//   button emphasis mirrors it (no primary "Start … →" CTA flash), and the
//   dot receives railCount() output so it can't light falsely while loading.
//
// Fix 2 — binder artifact kind + Open routing: P2-b's recordBinderGenerated
//   writes deal_artifacts rows with kind:'binder', which rendered via the
//   grey unknown-kind fallback with a dead Open button. Pin: ARTIFACT_KINDS
//   gains a binder entry (label 'Bid Binder', route 'package'), and the
//   binder Open button emits data-detail-tab="package" (the delegated DM
//   tab-switch mechanism — same in-content pattern as the manifest fixTab
//   buttons) rather than data-artifact-open, which hash-navigates AWAY from
//   Deal Management. The total unknown-kind fallback stays intact.
//
// Run:  node test-bw-dm-rail-artifacts.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const dmUi = read('./hub/deal-management/ui.js');

/** Extract a top-level function's source block by name (brace-matched). */
function fnBlock(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

// ============================================================
// 1. Rail — loading predicate + '—' path (Fix 1)
// ============================================================
{
  const rail = fnBlock(dmUi, 'renderWorkflowRail');
  t('renderWorkflowRail exists', !!rail);
  t('loading predicate: real deal AND designs cache not yet seeded',
    rail.includes('const designsLoading = _isRealDealId(d.id) && !_designScenariosByDeal.has(d.id);'));
  t("predicate is demo-safe (guarded by _isRealDealId, not a bare .has() check)",
    !/designsLoading = !_designScenariosByDeal\.has/.test(rail));
  t("muted em-dash path: railCount renders '—' while loading",
    /const railCount = \(n\) => designsLoading \? '—' : n;/.test(rail));
  t('Size count goes through railCount', rail.includes('count: railCount(ds.wsc.length)'));
  t('Labor count goes through railCount', rail.includes('count: railCount(ds.most.length)'));
  t('Network count goes through railCount (cog + netopt + fleet)',
    rail.includes('count: railCount(ds.cog.length + (ds.netopt || []).length + (ds.fleet || []).length)'));
  t('no bare unguarded Size/Labor counts remain',
    !rail.includes('count: ds.wsc.length') && !rail.includes('count: ds.most.length'));
  t('no bare unguarded Network count remains',
    !rail.includes('count: ds.cog.length +'));
}

// ============================================================
// 2. Rail — dot + button emphasis mirror the loading state (Fix 1)
// ============================================================
{
  const rail = fnBlock(dmUi, 'renderWorkflowRail');
  t("dot keys off count > 0 (railCount's '—' is never > 0 → stays unlit while loading)",
    /const dot = \(n\) => .*n > 0 \? 'var\(--c-success\)' : 'var\(--ies-gray-200\)'/.test(rail)
      && rail.includes('dot(st.count)'));
  t('tool buttons hold the neutral secondary style while loading (no primary CTA flash)',
    rail.includes("${designsLoading || n ? 'hub-btn-secondary' : 'hub-btn-primary'}"));
  t("tool buttons hold the neutral 'Open →' label while loading",
    rail.includes("${designsLoading ? 'Open →' : smartLabel(n, noun)}"));
  t('Size / Labor / Network buttons all route through the loading-aware builder',
    rail.includes("toolBtn(ds.wsc.length, 'sizing', 'designtools/warehouse-sizing')")
      && rail.includes("toolBtn(ds.most.length, 'labor std', 'designtools/most-standards')")
      && rail.includes('toolBtn(n, \'network\', route)'));
  t('no extra plumbing: rail never CALLS hydration itself (the entry-path hydrate re-render flips it)',
    !/_hydrateDealDetail\(|_refreshDesignScenarios\(/.test(rail));
}

// ============================================================
// 3. ARTIFACT_KINDS — binder entry (Fix 2)
// ============================================================
{
  const kinds = dmUi.slice(dmUi.indexOf('const ARTIFACT_KINDS'),
    dmUi.indexOf('};', dmUi.indexOf('const ARTIFACT_KINDS')));
  t('ARTIFACT_KINDS has a binder entry', /\bbinder:\s*\{/.test(kinds));
  t("binder label is 'Bid Binder'", kinds.includes("label: 'Bid Binder'"));
  t("binder route is the Package detail tab", /binder:[^\n]*route: 'package'/.test(kinds));
  t('binder badge color is a hub-palette hex', /binder:[^\n]*color: '#7c3aed'/.test(kinds));
}

// ============================================================
// 4. Binder Open button — tab jump, not hash navigation (Fix 2)
// ============================================================
{
  const arts = fnBlock(dmUi, 'renderDealArtifacts');
  t('renderDealArtifacts exists', !!arts);
  // Strip // comment lines so prose mentioning the wrong attribute can't
  // satisfy (or trip) the markup pins below.
  const binderBranch = arts.slice(arts.indexOf("a.kind === 'binder'"),
    arts.indexOf("a.kind === 'cost_model'"))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  t('binder branch present and checked before the cost_model branches', !!binderBranch);
  t('binder Open button emits data-detail-tab="package" (fixTab in-content precedent)',
    binderBranch.includes('data-detail-tab="package"'));
  t('binder Open button does NOT use data-artifact-open (hash-navigates away from DM)',
    !binderBranch.includes('data-artifact-open'));
  t('delegated data-detail-tab handler is root-delegated (works from tab content, not just the tab strip)',
    dmUi.includes("target.closest('[data-detail-tab]')"));
  t('in-content precedent intact: manifest fixTab buttons use the same mechanism',
    dmUi.includes('data-detail-tab="${escapeAttr(item.fixTab)}"'));
}

// ============================================================
// 5. Fallback — unknown kinds still render (Fix 2 guard)
// ============================================================
{
  const arts = fnBlock(dmUi, 'renderDealArtifacts');
  t('unknown-kind fallback stays total (legacy deck/unknown rows still render)',
    arts.includes("ARTIFACT_KINDS[a.kind] || { label: a.kind, color: '#6b7280', route: '' }"));
  t('non-binder, non-cost-model kinds keep the data-artifact-open route',
    /:\s*`<button class="hub-btn hub-btn-sm hub-btn-secondary u-cap" data-artifact-open="\$\{escapeAttr\(kind\.route\)\}">Open →<\/button>`/.test(arts));
}

console.log(`\ntest-bw-dm-rail-artifacts: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

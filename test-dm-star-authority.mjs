// test-dm-star-authority.mjs — Wave C1 deal-spine completion (2026-07-22).
//
// Locks (source-string pins, test-dm-sites-s1 style):
//   1. ★-BASIS AUTHORITY: the merged deal tabs (Financials / Sensitivity /
//      Compare) get their ★ from deal_sites.in_bid_model_id — the ONE
//      authority — via tools/deal-manager/api.js listSites →
//      fetchDealStarIds → mapCmProjectToSite(row, starIds). C4 (2026-07-22):
//      the legacy mirrored boolean cost_model_projects.in_bid is fully
//      RETIRED — the C1→C3 write-only soak is over and the column drops
//      with this wave. A repo-wide scan proves ZERO in_bid references
//      (reads AND writes) under tools/ + hub/ + shared/; only the
//      deal_sites.in_bid_model_id authority remains.
//   2. RAIL (Brock ruling s3, supersedes the s2 Fleet-off-rail ruling):
//      fleet_scenarios joins listDesignScenariosByDeal and the rail's
//      Network stage count (COG + NetOpt + Fleet); routing keeps the
//      existing COG-wins behavior with a Fleet fallback only when Fleet
//      alone has scenarios.
//   3. ARTIFACT_KINDS: center_of_gravity added (label / route /
//      'cog:<id>' ref placeholder); the dead 'deck' kind removed
//      (tools/deck-generator never shipped); the renderer's unknown-kind
//      fallback stays total so legacy 'deck' rows still render.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── 1a. deal-tab ★ basis reads deal_sites ──
const msaApi = readFileSync(new URL('./tools/deal-manager/api.js', import.meta.url), 'utf8');
{
  t('listSites fetches the deal\'s deal_sites rows (★ authority)',
    msaApi.includes('fetchDealStarIds(dealId)') &&
    msaApi.includes("db.from('deal_sites')") &&
    msaApi.includes(".eq('deal_id', dealId)"));
  t('fetchDealStarIds derives the Set from in_bid_model_id',
    /fetchDealStarIds[\s\S]{0,600}in_bid_model_id/.test(msaApi));
  t('mapCmProjectToSite inBid derives from the starIds Set',
    msaApi.includes('inBid: starIds ? starIds.has(String(row.id)) : false'));
  t('mapCmProjectToSite no longer reads the mirrored boolean',
    !msaApi.includes('row.in_bid'));
  t('★-miss fails soft (empty Set keeps the tabs rendering)',
    /fetchDealStarIds[\s\S]{0,800}return new Set\(\);/.test(msaApi));
}

// ── 1b. hub api: authority-only, mirror fully retired (C4) ──
const hubApi = readFileSync(new URL('./hub/deal-management/api.js', import.meta.url), 'utf8');
{
  t('listRealDeals cost_model_projects select does NOT pull in_bid',
    hubApi.includes('deal_deals_id, updated_at, site_id') &&
    !hubApi.includes('updated_at, in_bid'));
  t('model summaries no longer carry the retired in_bid key',
    !hubApi.includes('in_bid: starIds'));
  t('setModelInBid selects without the mirrored column',
    hubApi.includes(".select('id, name, site_id')"));
  t('setModelInBid writes the authority only (no mirror sweep remains)',
    hubApi.includes("db.update('deal_sites', target.site_id, { in_bid_model_id: target.id })") &&
    !hubApi.includes('{ in_bid: false }') && !hubApi.includes('{ in_bid: true }'));
  t('assignModelToSite selects without the mirrored column',
    hubApi.includes(".select('id, site_id')"));
  t('assignModelToSite writes site_id only (no mirror payload)',
    hubApi.includes("db.update('cost_model_projects', modelId, { site_id: siteId || null });"));
}

// ── 1c. repo-wide: ZERO in_bid references (C4 — mirror retired) ──
// Walk every .js under tools/ + hub/ + shared/, strip comments, and require
// ZERO remaining `in_bid` occurrences — reads AND writes alike. Exempt:
//   · in_bid_model_id — the deal_sites ★ authority (stays; lookahead)
//   · set_site_in_bid — the audit action string (its leading underscore is
//     a word char, so the lookbehind skips it naturally)
{
  const ROOT = new URL('.', import.meta.url).pathname;
  const walk = (dir) => {
    let out = [];
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out = out.concat(walk(p));
      else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const files = ['tools', 'hub', 'shared'].flatMap(walk);
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')            // block comments
      .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');     // line comments (not ://)
    const re = /(?<![\w])in_bid(?!_model_id)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const ctx = src.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ');
      offenders.push(`${f}: …${ctx.trim()}…`);
    }
  }
  t('ZERO in_bid references repo-wide (mirror retired, column drops in C4)',
    offenders.length === 0, offenders.slice(0, 5).join(' | '));
}

// ── 2. rail: Fleet joins the Network stage ──
const hubUi = readFileSync(new URL('./hub/deal-management/ui.js', import.meta.url), 'utf8');
{
  t('listDesignScenariosByDeal grabs fleet_scenarios',
    hubApi.includes("grab('fleet_scenarios')") &&
    /return \{ wsc, most, cog, netopt, fleet \};/.test(hubApi));
  t('rail Network counts cog + netopt + fleet',
    hubUi.includes('ds.cog.length + (ds.netopt || []).length + (ds.fleet || []).length'));
  t('rail Network sub names all three tools',
    hubUi.includes('COG · Network Opt · Fleet'));
  t('routing keeps COG-wins; Fleet only when it alone has scenarios',
    hubUi.includes("'designtools/fleet-modeler'") &&
    hubUi.includes("? 'designtools/network-opt'"));
}

// ── 3. ARTIFACT_KINDS: + center_of_gravity, − deck ──
{
  const kinds = hubUi.slice(hubUi.indexOf('const ARTIFACT_KINDS'), hubUi.indexOf('};', hubUi.indexOf('const ARTIFACT_KINDS')));
  t('center_of_gravity kind exists (label + route)',
    kinds.includes('center_of_gravity') &&
    kinds.includes("label: 'Center of Gravity'") &&
    kinds.includes("route: 'designtools/center-of-gravity'"));
  t('dead deck kind removed (tools/deck-generator does not exist)',
    !kinds.includes('deck:') && !hubUi.includes("label: 'Generated Deck'"));
  t('cog:<id> ref format surfaced in the link-artifact placeholder',
    hubUi.includes('cog:4'));
  t('unknown-kind fallback stays total (legacy deck rows still render)',
    hubUi.includes("ARTIFACT_KINDS[a.kind] || { label: a.kind"));
}

console.log(`\ntest-dm-star-authority: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

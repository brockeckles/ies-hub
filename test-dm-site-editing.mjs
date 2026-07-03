/**
 * P2-1 (2026-07-03) — DM site editing (Brock's build-it-out call).
 * Pure mapper pins + schema-column verification + source wiring scans.
 */
import { siteToCmColumns, SITE_TO_CM_COLUMNS, NEW_SITE_DEFAULTS, computeDealFinancials } from './tools/deal-manager/calc.js';
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { if (fn() === false) throw new Error('returned false'); pass++; }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// ── mapper ────────────────────────────────────────────────────────────────
t('siteToCmColumns maps every editable field to its CM column', () => {
  const full = siteToCmColumns({
    name: 'Chicago DC', market: 'Midwest', environment: 'chilled', sqft: 350000,
    annualCost: 4200000, targetMarginPct: 16, startupCost: 600000,
    pricingModel: 'transactional', annualVolume: 2400000,
  });
  const want = {
    name: 'Chicago DC', client_name: 'Midwest', environment_type: 'chilled',
    facility_sqft: 350000, total_annual_cost: 4200000, target_margin_pct: 16,
    startup_cost: 600000, pricing_model: 'transactional', vol_pallets_received: 2400000,
  };
  if (JSON.stringify(full) !== JSON.stringify(want)) throw new Error('mapping drifted: ' + JSON.stringify(full));
});
t('mapper drops unknown keys and coerces formatted numbers', () => {
  const out = siteToCmColumns({ sqft: '250,000', junk: 'x', costModelId: '9' });
  if (out.facility_sqft !== 250000 || 'junk' in out || 'costModelId' in out) throw new Error(JSON.stringify(out));
});
t('NEW_SITE_DEFAULTS preserves the old ghost-site values (200k/2M/10/cost-plus)', () =>
  NEW_SITE_DEFAULTS.sqft === 200000 && NEW_SITE_DEFAULTS.annualCost === 2000000
  && NEW_SITE_DEFAULTS.targetMarginPct === 10 && NEW_SITE_DEFAULTS.pricingModel === 'cost-plus');
t('an edited site flows through computeDealFinancials (Compare no longer sees ghosts)', () => {
  const fin = computeDealFinancials([{ id: 's1', name: 'X', ...NEW_SITE_DEFAULTS, sqft: 100000, annualCost: 1000000 }], 5);
  if (!(fin.totalAnnualCost === 1000000 && fin.bySite.length === 1)) throw new Error('financials off');
});

// ── every mapped column exists in the migrations ─────────────────────────
t('every SITE_TO_CM_COLUMNS target column exists in cost_model_projects DDL', () => {
  const dir = './supabase/migrations';
  const ddl = readdirSync(dir).filter(f => f.endsWith('.sql'))
    .map(f => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
  const missing = Object.values(SITE_TO_CM_COLUMNS).filter(col => !new RegExp(`\\b${col}\\b`).test(ddl));
  if (missing.length) throw new Error('columns not found in migrations: ' + missing.join(', '));
});

// ── source wiring scans ───────────────────────────────────────────────────
{
  const ui = readFileSync('./tools/deal-manager/ui.js', 'utf8');
  const api = readFileSync('./tools/deal-manager/api.js', 'utf8');
  t('api gained createSite + updateSite through the pure mapper', () =>
    api.includes('export async function createSite') && api.includes('export async function updateSite')
    && api.split('siteToCmColumns(').length >= 3);
  t('Add Empty Site persists (api.createSite) instead of a memory ghost', () =>
    ui.includes('api.createSite(activeDeal.id'));
  t('unlink actually calls api.unlinkSite (previously zero call sites)', () =>
    ui.includes('await api.unlinkSite(siteId)'));
  t('site cards carry editable inputs wired to change-persist', () =>
    ui.includes('data-site-field="sqft"') && ui.includes('data-site-field="annualCost"')
    && ui.includes("api.updateSite(siteId, { [field]: value })"));
  t('failed saves roll back the optimistic edit', () =>
    ui.includes('site[field] = prev'));
  t('openDeal + edits hydrate activeDeal._sites; Compare fetches unhydrated deals', () =>
    ui.includes('activeDeal._sites = sites') && ui.includes('d._sites = await api.listSites(d.id)'));
  t('demo deal stays memory-only', () => ui.includes("String(activeDeal?.id) === 'demo-deal-1'"));
}

console.log(`test-dm-site-editing: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);

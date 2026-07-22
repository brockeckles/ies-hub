// test-netopt-deal-stamp.mjs — C1 deal-spine completion: NetOpt joins the
// spine (audit findings a+b, 2026-07-22).
//
// Locks (source-string pins, test-dm-sites-s1 style):
//   1. tools/network-opt/api.js imports shared/deal-context.js — a config
//      created directly in the tool (incl. the DM rail route) is stamped
//      from the hub-wide active deal, not only via the CM push handoff.
//   2. saveConfig stamps parent_cost_model_id / parent_deal_id / site_id on
//      the INSERT branch ONLY, with explicit-config-value-wins coalescing
//      (config value ?? deal-context ?? null).
//   3. The UPDATE branch never touches any of the three — an update that
//      omits them can no longer silently NULL an existing stamp
//      (updates-never-rebind). linkToCm/unlinkFromCm stay the explicit
//      rebind path for the CM linkage.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const src = readFileSync(new URL('./tools/network-opt/api.js', import.meta.url), 'utf8');

// ── 1. deal-context import ──
t('api.js imports shared/deal-context.js (pinned)',
  src.includes("import * as dealContext from '../../shared/deal-context.js?v="));

// ── 2. insert-only stamp block ──
const fnStart = src.indexOf('export async function saveConfig');
t('saveConfig exists', fnStart !== -1);
const fnEnd = src.indexOf('export async function', fnStart + 1);
const fn = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

t('stamp reads the hub-wide active deal context',
  fn.includes('const _ctx = dealContext.getActive();'));
t('parent_deal_id: config value ?? deal-context ?? null',
  fn.includes('payload.parent_deal_id = config.parent_deal_id ?? _ctx?.id ?? null;'));
t('site_id: config value ?? deal-context siteId ?? null (S1 site binding)',
  fn.includes('payload.site_id = config.site_id ?? _ctx?.siteId ?? null;'));
t('parent_cost_model_id: config value ?? null (no context fallback)',
  fn.includes('payload.parent_cost_model_id = config.parent_cost_model_id ?? null;'));

// Insert-only placement: the update branch returns BEFORE the stamp block,
// so the stamp can only ever apply to db.insert.
const updateAt = fn.indexOf("return db.update('netopt_configs', config.id, payload);");
const stampAt = fn.indexOf('const _ctx = dealContext.getActive();');
const insertAt = fn.indexOf("return db.insert('netopt_configs', payload);");
t('update branch returns before the stamp block',
  updateAt !== -1 && stampAt !== -1 && updateAt < stampAt);
t('stamp block sits before the insert',
  insertAt !== -1 && stampAt < insertAt);

// ── 3. update never rebinds ──
// Between function start and the update-branch return, none of the three
// spine columns may be assigned (payload literal or property write).
// Line comments are stripped so only real code counts.
const preUpdate = fn.slice(0, updateAt).replace(/\/\/[^\n]*/g, '');
t('update branch does not touch parent_deal_id', !preUpdate.includes('parent_deal_id'));
t('update branch does not touch site_id', !preUpdate.includes('site_id'));
t('update branch does not touch parent_cost_model_id', !preUpdate.includes('parent_cost_model_id'));

// linkToCm/unlinkFromCm remain the explicit rebind path for the CM linkage.
t('linkToCm is the explicit CM rebind path',
  src.includes("export async function linkToCm")
  && src.includes("db.update('netopt_configs', scenarioId, { parent_cost_model_id: cmId })"));
t('unlinkFromCm is the explicit CM unlink path',
  src.includes("export async function unlinkFromCm")
  && src.includes("db.update('netopt_configs', scenarioId, { parent_cost_model_id: null })"));

console.log(`\ntest-netopt-deal-stamp: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

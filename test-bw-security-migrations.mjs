// test-bw-security-migrations.mjs — Wave BW security migrations (2026-07-23).
// String-pins the two BW security migrations so future edits can't silently
// regress them:
//
//   1. 20260723160000_approve_scenario_ownership.sql — approve_scenario
//      (SECURITY DEFINER, previously ZERO ownership check) gains an
//      owner-or-admin gate BEFORE any snapshot write, keeps CREATE OR
//      REPLACE (never DROP — C6 fixed the ACLs and DROP resets them), keeps
//      SET search_path TO 'public', and hardens approved_by to prefer the
//      caller's JWT email over the spoofable p_user_email. Signature
//      unchanged (tools/cost-model/api.js approveScenarioRpc still passes
//      p_scenario_id + p_user_email).
//   2. 20260723160100_deal_outcomes_read_alignment.sql — deal_outcomes READ
//      aligned with deal_bid_snapshots (owner OR team OR shared OR admin,
//      traversed through the parent deal via deal_id); write policies
//      untouched by that file.
//
// Run:  node test-bw-security-migrations.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; process.stdout.write('.'); }
  else { fail++; console.error(`\n  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// Negative pins must not trip on prose in `-- comments` (e.g. "never DROP
// FUNCTION" in the migration header). Positive statement pins use the raw
// text; negative pins use the comment-stripped text.
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

// ============================================================
// 1. Migration 1 — approve_scenario ownership gate
// ============================================================
{
  let sql = '';
  let exists = true;
  try { sql = read('./supabase/migrations/20260723160000_approve_scenario_ownership.sql'); }
  catch { exists = false; }
  t('migration 1 file exists', exists);

  // ACL preservation: CREATE OR REPLACE, never DROP (C6 fixed the fn ACLs;
  // DROP+CREATE resets them to defaults — the prod ACL-drift class).
  t('uses CREATE OR REPLACE FUNCTION public.approve_scenario',
    /create or replace function public\.approve_scenario\s*\(/i.test(sql));
  t('NEVER drops the function (DROP resets C6 ACLs)',
    !/drop\s+function/i.test(stripComments(sql)));
  t('no GRANT/REVOKE restated (ACLs owned by C6, preserved by OR REPLACE)',
    !/^\s*(grant|revoke)\s/im.test(stripComments(sql)));

  // Signature unchanged — callers (approveScenarioRpc) pass these named args.
  t('signature unchanged: p_scenario_id bigint, p_user_email text DEFAULT NULL',
    /p_scenario_id\s+bigint\s*,\s*p_user_email\s+text\s+default\s+null/i.test(sql));

  // SECURITY DEFINER + search_path pin both kept (OR REPLACE without the SET
  // clause would silently drop the 20260423144107 pin).
  t('SECURITY DEFINER kept', /security definer/i.test(sql));
  t("SET search_path TO 'public' kept",
    /set search_path (to|=) 'public'/i.test(sql));

  // The gate: admin OR ownership-EXISTS on cost_model_projects.owner_id,
  // and it must run BEFORE the first snapshot INSERT (fail closed — no
  // writes for unauthorized callers).
  const gateIdx = sql.search(/current_user_is_admin\(\)/i);
  const ownIdx = sql.search(/exists\s*\(\s*select 1 from public\.cost_model_projects p\s+where p\.id = v_project_id\s+and p\.owner_id = auth\.uid\(\)/i);
  const firstInsertIdx = sql.search(/insert into public\.cost_model_rate_snapshots/i);
  t('gate: current_user_is_admin() arm present', gateIdx !== -1);
  t('gate: ownership EXISTS on cost_model_projects.owner_id = auth.uid()', ownIdx !== -1);
  t('gate runs BEFORE the first snapshot insert',
    firstInsertIdx !== -1 && gateIdx !== -1 && ownIdx !== -1
    && gateIdx < firstInsertIdx && ownIdx < firstInsertIdx);
  t("gate failure raises 'approve_scenario: not authorized for project %'",
    /raise exception 'approve_scenario: not authorized for project %'/i.test(sql));

  // approved_by hardening: JWT email beats spoofable p_user_email.
  t('approved_by prefers JWT email (spoof-hardened COALESCE chain)',
    /approved_by = coalesce\(auth\.jwt\(\)->>'email', p_user_email, approved_by, 'system'\)/i.test(sql));

  // Team visibility deliberately excluded from the gate (write-power ruling).
  t('gate has NO team-visibility arm (approval is owner/admin only)',
    !/current_user_team_id/i.test(sql));
}

// ============================================================
// 2. Migration 2 — deal_outcomes read alignment
// ============================================================
{
  let sql = '';
  let exists = true;
  try { sql = read('./supabase/migrations/20260723160100_deal_outcomes_read_alignment.sql'); }
  catch { exists = false; }
  t('migration 2 file exists', exists);

  // Drops the exact live prod policy name before recreating.
  t('drops exact old policy: deal_outcomes_read',
    /drop policy if exists deal_outcomes_read on public\.deal_outcomes/i.test(sql));
  t('recreates deal_outcomes_read FOR SELECT',
    /create policy deal_outcomes_read on public\.deal_outcomes for select/i.test(sql));

  // New expression mirrors deal_bid_snapshots_read: traversal through the
  // parent deal via the canonical deal_id FK, with all four arms.
  t('traverses parent deal via deal_outcomes.deal_id (deal_bid_snapshots shape)',
    /exists \(select 1 from public\.deal_deals d where d\.id = deal_outcomes\.deal_id/i.test(sql));
  t('owner arm: d.owner_id = auth.uid()', /d\.owner_id = auth\.uid\(\)/i.test(sql));
  t('team arm: visibility=team AND team_id = current_user_team_id()',
    /d\.visibility = 'team'::visibility_level and d\.team_id = current_user_team_id\(\)/i.test(sql));
  t('shared arm present', /d\.visibility = 'shared'::visibility_level/i.test(sql));
  t('admin arm present', /current_user_is_admin\(\)/i.test(sql));

  // Only READ is realigned — write policies stay owner-or-admin, untouched.
  t('does NOT touch the INSERT policy', !/for insert/i.test(stripComments(sql)));
  t('does NOT touch the UPDATE policy', !/for update/i.test(stripComments(sql)));
  t('does NOT touch the DELETE policy',
    !/for delete/i.test(stripComments(sql)));
}

console.log(`\ntest-bw-security-migrations: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

# Auth map — the identity-swap inventory (GCP transition prep)

> **Generated 2026-07-23 from the live prod `pg_policies` dump** (215 policy
> rows, 118 public tables). Regenerate on any schema/policy change — this is
> a snapshot, not a living contract. Staging is **assumed** identical to prod
> (C6 grant hygiene was applied to both DBs 2026-07-22); assumption, not a
> verified claim. Client-side enforcement of the seam described here:
> `test-auth-seam.mjs`.

This document answers one question: **what exactly has to be re-pointed when
identity moves off Supabase Auth to the corporate IdP (GCP Identity
Platform)?** Three surfaces: the RLS policies (server side), the two SQL
helper functions they lean on, and the client-side seam files.

---

## 1. RLS policy summary — tables × auth primitives

Legend for the primitives column:

| Token | Meaning |
|---|---|
| `uid` | `auth.uid()` — owner check (`owner_id = auth.uid()`, `id = auth.uid()`, `user_id = auth.uid()`) |
| `adm` | `current_user_is_admin()` — helper fn (profiles.role + **AAL2 JWT claim**, see §2) |
| `team` | `current_user_team_id()` — helper fn, with `visibility = 'team'` |
| `shared` | `visibility = 'shared'` escape hatch (no auth primitive — column value) |
| `parent` | primitives evaluated on the parent row via `EXISTS (SELECT … FROM <parent>)` |
| `TRUE` | `USING (true)` — open to the policy's role set |
| `len` | length/NOT-NULL sanity caps only (no identity check) |

Every policy in prod reduces to one of **six patterns**. No policy uses
`auth.jwt()` or `auth.role()` directly — the only JWT-claim dependency is
inside `current_user_is_admin()` (§2).

### Pattern A — owner-scoped parent tables (11 tables, 4 policies each, `TO authenticated`)

SELECT `uid OR (team AND visibility='team') OR visibility='shared' OR adm` ·
INSERT `owner_id = uid` · UPDATE/DELETE `uid OR adm`.

| Family | Tables |
|---|---|
| deal_* | `deal_deals` |
| cost_model_* | `cost_model_projects` |
| wsc_/sizing | `warehouse_sizing_scenarios`, `wsc_facility_configs` |
| cog | `cog_scenarios` |
| most_* | `most_analyses` |
| netopt_* | `netopt_configs`, `netopt_scenarios` |
| fleet_* | `fleet_scenarios` |
| change/opps | `change_initiatives`, `opportunities` |

### Pattern B — child tables, one `ALL` policy delegating to the parent row (21 tables, `TO authenticated`)

`EXISTS (SELECT 1 FROM <parent> WHERE parent.id = <fk> AND (uid OR team OR
shared OR adm))` — identical USING and CHECK.

| Family | Tables (→ parent) |
|---|---|
| cost_model_* | `cost_model_asset_instances`, `_cashflow_monthly`, `_depreciation_schedules`, `_equipment`, `_expense_monthly`, `_labor`, `_overhead`, `_revenue_monthly`, `_revisions`, `_scenarios`, `_summary`, `_vas`, `_volumes` (→ `cost_model_projects`); `cost_model_rate_snapshots` (two-hop: → `cost_model_scenarios` → `cost_model_projects`) |
| netopt_* | `netopt_scenario_results` (→ `netopt_configs`) |
| fleet_* | `fleet_lanes` (→ `fleet_scenarios`) |
| change_* | `change_activities`, `change_flowcharts` (→ `change_initiatives`) |
| opps | `opportunity_tasks`, `project_hours`, `project_updates` (→ `opportunities`) |

### Pattern C — deal_* child tables: Pattern A/B shapes but `TO public` (7 tables)

Same expressions as A/B (per-cmd policies, parent = `deal_deals`), **but the
role target is `{public}` instead of `{authenticated}`** — see anomalies §4.1.

- `deal_artifacts`, `deal_bid_meta`, `deal_dos_status`, `deal_sites`,
  `deal_strategy` — 4 policies each (SELECT includes team/shared via parent).
- `deal_bid_snapshots` — INSERT + SELECT only; **no UPDATE/DELETE policy on
  purpose** (append-only pattern of record; a BEFORE trigger blocks
  service_role too — AGENTS.md rule 6).
- `deal_outcomes` — 4 policies, but SELECT is `uid OR adm` only (no
  team/shared) — see anomalies §4.2.

### Pattern D — reference data: read-authed + admin-write (39 tables, `TO authenticated`)

SELECT `USING (true)` + one `ALL` policy `USING/CHECK current_user_is_admin()`.

| Family | Tables |
|---|---|
| master_* | `master_accounts`, `_channel_archetypes`, `_competitors`, `_cost_buckets`, `_escalation_rates`, `_markets`, `_sccs`, `_vehicle_types`, `_verticals` |
| ref_* | all 24 `ref_*` tables (`ref_allowance_profiles` … `ref_utility_rates`) |
| curated entities | `accounts`, `competitors`, `customers`, `pricing_assumptions`, `teams`, `verticals` |

### Pattern E — read-only market-intel/ingest tables (32 tables, SELECT `USING (true)` `TO authenticated`, no client write path)

`account_signals`, `ai_logistics_developments`, `automation_metrics`,
`automation_news`, `bts_cost_components`, `competitor_news`,
`construction_indices`, `freight_rates`, `fuel_prices`,
`industrial_real_estate`, `labor_markets`, `labor_summary`, `market_freight`,
`material_prices`, `pipeline_deals`, `pipeline_summary`, `port_status`,
`proposal_benchmarks`, `regulatory_updates`, `reshoring_activity`,
`reshoring_metrics`, `rfp_signals`, `stage_element_templates`, `stages`,
`steel_prices`, `tariff_developments`, `template_versions`, `union_activity`,
`utility_rates`, `vertical_spotlights`, `win_loss_factors`, `wms_updates`.

Writes arrive via edge functions / service_role (RLS bypass) — a
**service-role assumption**: these tables have no INSERT/UPDATE/DELETE
policies at all, so any writer must hold the service key.

### Pattern F — special cases

| Table | Shape |
|---|---|
| `profiles` | SELECT `id = uid OR team OR adm`; UPDATE `id = uid OR adm`. **No INSERT/DELETE policy** — row creation is a service-side concern (invite flow / trigger). Identity anchor: `id` = `auth.users.id`. |
| `audit_log` | INSERT `TO anon, authenticated` CHECK `user_id IS NULL OR user_id = auth.uid()`; SELECT admin-only. Fire-and-forget writes, so anon insert is tolerated by design. |
| `analytics_events` / `analytics_page_views` / `analytics_sessions` | INSERT `TO public` with **length caps only** (events also pin `user_id` to uid-or-null); SELECT admin-only. |
| `hub_feedback` | INSERT `TO anon, authenticated` with length caps only; SELECT authed `true`. |
| `hub_alerts` | SELECT `USING (true)` `TO anon, authenticated` — the only table readable signed-out. |
| `general_hours` | single `ALL` admin-only policy — non-admins have **no read access**. |

---

## 2. Primitives — what must be re-implemented against the corporate IdP JWT

Policy-level usage counts (of 215 policies): `current_user_is_admin()` 126 ·
`auth.uid()` 95 · `current_user_team_id()` 39 · `USING (true)` 73 ·
length-caps-only 4.

### `auth.uid()` (Supabase built-in)
Reads the `sub` claim of the request JWT. Every owner check in the schema is
`<owner col> = auth.uid()`. **Swap requirement:** the future IdP's JWT `sub`
must either equal the existing `auth.users.id` uuids or every `owner_id` /
`profiles.id` / `user_id` column gets migrated. This is the single largest
coupling in the system.

### `current_user_is_admin()` — `SECURITY DEFINER`, defined in `supabase/migrations/20260424171604_phase45_mfa_admin_gate.sql`
```sql
SELECT EXISTS (SELECT 1 FROM public.profiles
               WHERE id = auth.uid() AND role = 'admin')
AND (auth.jwt() ->> 'aal') = 'aal2';
```
Reads: `profiles.role` via `auth.uid()`, **plus the `aal` JWT claim** —
admin is only admin on an MFA-verified (AAL2) session. Used by 126 policies.
**Swap requirement:** the corporate IdP must surface an equivalent
MFA-assurance claim, or this function's AAL clause must be redefined against
whatever claim the new JWT carries. (The earlier aal1-tolerant version is in
`20260423123814_phase3_slice33_06_fix_profiles_recursion.sql`.)

### `current_user_team_id()` — `SECURITY DEFINER`, defined in `supabase/migrations/20260423123814_phase3_slice33_06_fix_profiles_recursion.sql`
```sql
SELECT team_id FROM public.profiles WHERE id = auth.uid()
```
Reads: `profiles.team_id` via `auth.uid()`. Used by 39 policies (team
visibility). Swap requirement: survives unchanged **iff** `auth.uid()`
mapping survives.

### Not used
No policy references `auth.jwt()` directly (only inside
`current_user_is_admin()`), none uses `auth.role()`, none references
`service_role` explicitly (service access = RLS bypass + the Pattern E
no-write-policy assumption + the `deal_bid_snapshots` trigger, which is the
one guard service_role cannot bypass).

---

## 3. Swap surface — client-side Supabase Auth API usage (the seam)

Survey 2026-07-23 (enforced by `test-auth-seam.mjs`): only four files touch
Supabase Auth. Everything else consumes `shared/auth.js` module exports.

### `shared/auth.js` — the seam. Concrete `client.auth.*` calls:

| Call | Purpose | Identity Platform mapping needed |
|---|---|---|
| `auth.getSession()` | session bootstrap + cached-session reads | session/token retrieval |
| `auth.onAuthStateChange(cb)` | drives login/logout/recovery UI + bus events | token/session listener |
| `auth.signInWithPassword({email,password})` | login **and** reauth-before-password-change | password sign-in (or SSO redirect) |
| `auth.signOut()` | logout | sign-out / token revocation |
| `auth.updateUser({password})` | password change, recovery set-password, invite accept (3 sites) | password update API |
| `auth.resetPasswordForEmail(email, opts)` | recovery email | password-reset flow |
| `auth.verifyOtp({email, token, type:'recovery'})` | recovery code verify | OOB-code verify |
| `auth.verifyOtp({email, token, type:'invite'})` | invite accept | invite/OOB-code verify |
| `auth.mfa.listFactors()` | factor inventory for the gate | MFA enrollment state |
| `auth.mfa.getAuthenticatorAssuranceLevel()` | AAL check (pairs with the SQL `aal` claim gate) | MFA-assurance claim |
| `auth.mfa.enroll({factorType:'totp', …})` | TOTP enrollment (QR + secret) | TOTP enrollment |
| `auth.mfa.challenge({factorId})` + `auth.mfa.verify({factorId, challengeId, code})` | recovery-path MFA step-up | MFA challenge/verify |
| `auth.mfa.challengeAndVerify({factorId, code})` | login challenge + enrollment verify | MFA challenge/verify |
| `auth.mfa.unenroll({factorId})` | stale/removed factor cleanup | factor removal |

### `shared/supabase.js` — client factory
Owns the auth **session config** passed to `createClient`: `persistSession`,
`autoRefreshToken`, `detectSessionInUrl`, per-env `storageKey`
(`ies_hub_v3_sb_session_<env>`), `localStorage` binding. Also lazy-imports
the seam for `ensureSession()` owner-stamping. Swap: replace with the new
SDK's session persistence config.

### TODO(seam) stragglers — direct `getClient().auth.getSession()` presence checks
- `shared/search.js` (live search: skip when signed out)
- `hub/market-explorer/api.js` (deal counts: don't render empty RLS reads as "0")

Both should route through `auth.getSession()` when next touched; allowlisted
with scope `getSession` in `test-auth-seam.mjs` so they cannot grow.

### Consumers (no direct auth — must keep working unchanged)
`index.html` boot gate, `shared/mfa-ui.js` (TOTP modals), `shared/audit.js`
(actor capture), `hub/admin/api.js`, `tools/*/api.js` — all call seam module
exports (`auth.getUser()`, `auth.listFactors()`, `auth.ensureSession()`, …).

### Server-side (out of the client seam, swap separately)
`supabase/functions/*` edge functions verify platform JWTs and (ingest) an
`x-ingest-secret` — server-side identity, excluded from the seam rule by
design; they get their own line item in the GCP move.

---

## 4. Anomalies — flagged, not fixed

1. **`deal_*` child tables target `{public}` roles; `deal_deals` targets
   `{authenticated}`.** (Also `deal_outcomes`, `deal_bid_snapshots`.) The
   expressions still gate on `auth.uid()` (NULL for anon → no rows), so this
   is not a live leak, but it is inconsistent with every other family and
   makes the policies' intent depend on grants rather than role targeting.
   Same for the `{public}` analytics INSERT policies.
2. **`deal_outcomes_read` is `uid OR adm` only** — no team/shared visibility,
   unlike every sibling `deal_*` read policy. Teammates who can see the deal
   cannot see its outcome. Possibly intentional (outcomes are sensitive);
   flagged because nothing documents it.
3. **73 `USING (true)` policies.** All are SELECT-only and role-scoped
   (`authenticated`, except `hub_alerts` which is deliberately
   anon-readable): patterns D/E. Open-by-design for signed-in users — but it
   means *any* corporate identity holder will see all reference + market
   intel data post-swap; confirm that is acceptable tenancy.
4. **Anon-writable tables**: `analytics_events`, `analytics_page_views`,
   `analytics_sessions`, `hub_feedback`, `audit_log` accept INSERT from
   `anon` (length caps / uid-or-null checks only) — spam/noise surface, no
   rate limiting at the policy layer.
5. **`profiles` has no INSERT/DELETE policy** — row lifecycle is implicit
   (service-side). Fine today; the IdP swap must own profile provisioning
   explicitly.
6. **`general_hours` is admin-only for ALL commands** — non-admins cannot
   read it; inconsistent with the otherwise read-authed admin-write family.
   Confirm intended.
7. **RLS-enabled-with-no-policies:** none live. The two candidates from the
   migration cross-check (`network_optimization_scenarios`,
   `vertical_spotlight_deals`) were dropped by
   `20260722230000_c4_retire_in_bid_and_dead_v2_tables.sql`. (Note: this
   check cannot be made from `pg_policies` alone — it used the migrations as
   the enable-RLS source; a table RLS-enabled outside migrations with zero
   policies would be invisible here.)
8. **Legacy policy names** on `stages`, `stage_element_templates`,
   `template_versions` ("Authenticated users can read …" vs the
   `<table>_<verb>` convention) — cosmetic, betrays a different-era origin;
   these three also have no write policies (service-role writes assumed).

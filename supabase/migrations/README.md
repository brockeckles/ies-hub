# `supabase/migrations/`

Canonical path for all schema changes to the IES Hub Supabase databases.

Established in **Phase 4 Slice 4.3** (2026-04-24) to replace the previous
practice of applying DDL via in-the-moment `execute_sql` MCP calls, which
accumulated untracked drift between prod and staging over Phases 1-3.

## The rule

> **No more in-the-moment `execute_sql` for schema changes. Every schema
> change lands as a migration file in this directory, reviewed in a PR,
> and applied via `scripts/apply-migration.sh`.**

This applies to:
- `CREATE TABLE` / `ALTER TABLE` / `DROP TABLE`
- RLS `CREATE POLICY` / `DROP POLICY` / `ALTER POLICY`
- `CREATE / REPLACE / DROP FUNCTION` (incl. trigger functions)
- `CREATE / DROP TRIGGER`
- Enum additions and other type-system changes
- `CREATE INDEX` / `DROP INDEX`
- Anything else that changes the shape of the database

This does **NOT** apply to:
- Data-only operations (seeding ref tables, backfills, one-off UPDATE/DELETE)
  — those are fine via `execute_sql` at the REPL, and don't need to be in
  migration files unless you want them re-runnable.
- Supabase dashboard settings (auth config, storage config, edge function
  deploys, project-level settings). Those are handled out-of-band and
  documented in the relevant slice's landing memory.

## File naming

```
YYYYMMDDHHMMSS_snake_case_description.sql
```

Example: `20260424144000_phase4_slice43_discipline_roundtrip_add.sql`

The `YYYYMMDDHHMMSS` prefix is the **version**. It must be unique and
monotonically increasing. `supabase db push` uses it as the sort key and
records it in `supabase_migrations.schema_migrations.version`.

## Contents of each file

Start every migration with a header comment block like:

```sql
-- =============================================================================
-- IES Hub — Phase N Slice X.Y — Short description
-- =============================================================================
-- Purpose: one paragraph
-- Author:  Brock + Claude (Cowork)
-- Created: YYYY-MM-DD
-- Rollback: <manual rollback SQL, or "see pair file YYYYMMDDHHMMSS_..._drop.sql">
-- =============================================================================
```

Always favor **idempotent DDL** when the change is safe to re-apply:

```sql
ALTER TABLE x ADD COLUMN IF NOT EXISTS y ...;
CREATE TABLE IF NOT EXISTS ...;
CREATE INDEX IF NOT EXISTS ...;
CREATE OR REPLACE FUNCTION ...;
DROP POLICY IF EXISTS ... ON ...; CREATE POLICY ...;
```

Idempotent migrations let us re-run against either environment without
caring whether they've already been applied, which is the whole point of
the `--include-all` flag on the apply script.

## How to apply

From repo root:

```
export STAGING_DB_URL="postgresql://postgres:<pw>@<host>:6543/postgres?pgbouncer=true&connection_limit=1"
export PROD_DB_URL="postgresql://postgres:<pw>@<host>:6543/postgres?pgbouncer=true&connection_limit=1"

scripts/apply-migration.sh
```

The script:
1. Lists pending migrations on STAGING, then applies them.
2. Prompts for explicit `yes` confirmation.
3. Lists pending migrations on PROD, then applies them.

Flags: `--staging-only` (stop after step 1), `--dry-run` (list only, no apply).

Connection URLs come from Supabase dashboard:
`Project Settings → Database → Connection string → URI tab`.
Use the **pooler** URL (the one with `:6543` and `pgbouncer=true`).

Both URLs together — never commit them to git. Put them in `.env.local`
or a password manager and `source` into the shell when you need them.

## Environment discipline

- **STAGING first, PROD second, always.** Never the reverse. The script
  enforces this; don't work around it.
- **If staging fails,** fix the migration file, delete the failed entry
  from `staging.supabase_migrations.schema_migrations` if needed, and
  re-apply. Prod has not been touched yet.
- **If prod fails but staging succeeded,** you have real drift. Write a
  follow-up migration that reconciles the two rather than patching prod
  directly.
- **Schema parity is the ledger parity invariant:**
  `SELECT md5(string_agg(version || '|' || name, ',' ORDER BY version))`
  over `supabase_migrations.schema_migrations` must return the same hash
  on both environments after any apply cycle.

## History

The migrations in this directory are the **full 105-entry ledger** from
the PROD project (Supabase ref `dklnwcshrpamzsybjlzb`), back-filled via
`supabase_migrations.schema_migrations.statements` on 2026-04-24 as part
of Slice 4.3. Byte-perfect to what was actually applied.

Entries prior to Slice 4.3 (pre-2026-04-24) predate this discipline; many
were applied via `execute_sql` calls that happened in the moment. They
are recorded here so that a fresh environment can replay them in order
and reach the same state, but the directory becomes the source of truth
only for changes from Slice 4.3 forward.

One known drift class remains: 73 columns that exist on prod but not on
staging (mostly on DOS-framework orphan tables: `stages`,
`stage_element_templates`, `template_versions`, `projects`, etc.), plus 2
type mismatches on `cost_model_projects.deal_id` and
`deal_artifacts.artifact_id`. See Slice 4.3 landing memory for details.
These are flagged for a dedicated drift-remediation slice, not hidden.

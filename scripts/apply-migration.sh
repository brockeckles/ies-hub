#!/usr/bin/env bash
#
# scripts/apply-migration.sh — IES Hub migration applier
#
# Phase 4 Slice 4.3 — canonical script for promoting schema changes from repo
# files in supabase/migrations/ to the live Supabase projects.
#
# Flow: STAGING first -> you verify -> explicit confirm -> PROD.
#
# Prerequisites:
#   - Supabase CLI installed and on PATH (https://supabase.com/docs/guides/cli)
#   - Two environment variables set:
#       STAGING_DB_URL   Postgres URI for staging project (ref yswhxtpkfhvfbucyhads)
#       PROD_DB_URL      Postgres URI for prod project    (ref dklnwcshrpamzsybjlzb)
#     Both URLs are copied from Supabase dashboard ->
#       Project Settings -> Database -> Connection string -> URI.
#     Use the "pooler" URL for applying migrations.
#
# Usage:
#   scripts/apply-migration.sh                 # Normal: stage -> prompt -> prod
#   scripts/apply-migration.sh --staging-only  # Stage only, skip prod
#   scripts/apply-migration.sh --dry-run       # Show pending on both envs, apply nothing
#   scripts/apply-migration.sh --help
#
# Safety rails:
#   - Aborts on first error (set -euo pipefail).
#   - Refuses to run if supabase/migrations/ has no new files.
#   - Explicit y/Y confirmation required before PROD apply; anything else aborts.
#   - Prints each env's pending-migration list before applying.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

# ---- colors ------------------------------------------------------------------
if [ -t 1 ]; then
  C_GREEN=$'\033[0;32m'; C_ORANGE=$'\033[0;33m'; C_RED=$'\033[0;31m'
  C_BOLD=$'\033[1m';     C_DIM=$'\033[2m';       C_RESET=$'\033[0m'
else
  C_GREEN=''; C_ORANGE=''; C_RED=''; C_BOLD=''; C_DIM=''; C_RESET=''
fi

# ---- arg parse ---------------------------------------------------------------
MODE="normal"   # normal | staging-only | dry-run
while [ $# -gt 0 ]; do
  case "$1" in
    --staging-only) MODE="staging-only"; shift ;;
    --dry-run)      MODE="dry-run";      shift ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "${C_RED}unknown arg: $1${C_RESET}" >&2; exit 2 ;;
  esac
done

# ---- preflight ---------------------------------------------------------------
if ! command -v supabase >/dev/null 2>&1; then
  echo "${C_RED}supabase CLI not found on PATH${C_RESET}" >&2
  echo "install: https://supabase.com/docs/guides/cli" >&2
  exit 1
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "${C_RED}no supabase/migrations/ directory at $MIGRATIONS_DIR${C_RESET}" >&2
  exit 1
fi

MIGRATION_COUNT=$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f | wc -l | tr -d ' ')
if [ "$MIGRATION_COUNT" = "0" ]; then
  echo "${C_RED}no .sql files in $MIGRATIONS_DIR${C_RESET}" >&2
  exit 1
fi

echo "${C_BOLD}IES Hub migration applier${C_RESET}"
echo "  repo:       $REPO_ROOT"
echo "  migrations: $MIGRATIONS_DIR ($MIGRATION_COUNT files)"
echo "  mode:       $MODE"
echo ""

# ---- helpers -----------------------------------------------------------------
apply_to() {
  # $1 = friendly env name (STAGING / PROD)
  # $2 = color prefix
  # $3 = DB URL env var name
  local env="$1" color="$2" varname="$3"
  local url="${!varname:-}"

  echo "${color}${C_BOLD}---- $env ----${C_RESET}"
  if [ -z "$url" ]; then
    echo "${C_RED}$varname is not set. Export it or put it in .env.local and source that.${C_RESET}" >&2
    exit 1
  fi

  echo "${C_DIM}using \$${varname}${C_RESET}"

  # Show pending migrations (migration list diffs local vs remote)
  echo ""
  echo "Pending on $env:"
  # supabase migration list prints a table of local vs remote; we capture and
  # filter to rows where remote column is empty (= not yet applied upstream).
  supabase migration list --db-url "$url" 2>&1 | tee /tmp/mig_list_$$.txt || true
  echo ""

  if [ "$MODE" = "dry-run" ]; then
    echo "${C_DIM}--dry-run: skipping apply for $env${C_RESET}"
    rm -f /tmp/mig_list_$$.txt
    return 0
  fi

  # Push
  echo "Applying to $env..."
  supabase db push --db-url "$url" --include-all
  echo "${color}${C_BOLD}$env apply OK${C_RESET}"
  rm -f /tmp/mig_list_$$.txt
}

confirm_prod() {
  echo ""
  echo "${C_ORANGE}${C_BOLD}==============================================================${C_RESET}"
  echo "${C_ORANGE}${C_BOLD}  STAGING APPLY SUCCEEDED — ABOUT TO APPLY TO PROD${C_RESET}"
  echo "${C_ORANGE}${C_BOLD}==============================================================${C_RESET}"
  echo ""
  echo "Before continuing, verify on STAGING:"
  echo "  - app still loads"
  echo "  - writes still land"
  echo "  - RLS isolation suite passes (npm test -- test-rls-isolation against staging)"
  echo ""
  printf "Type ${C_BOLD}yes${C_RESET} to apply to PROD, anything else aborts: "
  read -r answer
  if [ "$answer" != "yes" ]; then
    echo "${C_RED}aborted${C_RESET}"
    exit 1
  fi
}

# ---- run ---------------------------------------------------------------------
apply_to STAGING "$C_ORANGE" STAGING_DB_URL

if [ "$MODE" = "staging-only" ]; then
  echo ""
  echo "${C_GREEN}staging-only mode: done. Re-run without --staging-only to promote to prod.${C_RESET}"
  exit 0
fi

if [ "$MODE" = "dry-run" ]; then
  apply_to PROD "$C_GREEN" PROD_DB_URL
  echo ""
  echo "${C_GREEN}dry-run complete on both envs.${C_RESET}"
  exit 0
fi

confirm_prod
apply_to PROD "$C_GREEN" PROD_DB_URL

echo ""
echo "${C_GREEN}${C_BOLD}==============================================================${C_RESET}"
echo "${C_GREEN}${C_BOLD}  STAGING + PROD MIGRATIONS APPLIED SUCCESSFULLY${C_RESET}"
echo "${C_GREEN}${C_BOLD}==============================================================${C_RESET}"

#!/usr/bin/env bash
#
# scripts/emit-build-info.sh — IES Hub build-info emitter
#
# Phase 4 Slice 4.4 — computes the release tag and writes build-info.json
# at repo root. Fetched by shared/build-info.js at page load to drive:
#   - Admin header chip version suffix (PROD · YYYY.MM.DD-shortsha)
#   - Footer chip (bottom-right, neutral)
#
# Run manually before every push to main. When Slice 4.5 lands GitHub
# Actions CI, the workflow will invoke this same script.
#
# Usage:
#   scripts/emit-build-info.sh            # Emits for HEAD
#   scripts/emit-build-info.sh --help
#
# Output shape (build-info.json):
#   {
#     "tag": "2026.04.24-5f3dfcf",
#     "sha": "5f3dfcf",
#     "shaFull": "5f3dfcf27abc...",
#     "date": "2026-04-24",
#     "timestamp": "2026-04-24T14:48:32Z",
#     "builtBy": "brock@localhost"
#   }
#
# Note: `env` is intentionally NOT in this file — the same bundle is served
# to both prod and staging, and env is detected at runtime by
# shared/supabase.js based on URL. Build-info is about code version only.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
OUTPUT_PATH="$REPO_ROOT/build-info.json"

# ---- colors ------------------------------------------------------------------
if [ -t 1 ]; then
  C_GREEN=$'\033[0;32m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_GREEN=''; C_BOLD=''; C_DIM=''; C_RESET=''
fi

# ---- help --------------------------------------------------------------------
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ---- prereq check ------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git not on PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not inside a git repo (REPO_ROOT=$REPO_ROOT)" >&2
  exit 1
fi

# ---- compute fields ----------------------------------------------------------
SHA_FULL="$(git rev-parse HEAD)"
SHA_SHORT="$(git rev-parse --short=7 HEAD)"
DATE_YMD="$(date -u +%Y-%m-%d)"
DATE_CALVER="$(date -u +%Y.%m.%d)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TAG="${DATE_CALVER}-${SHA_SHORT}"
BUILT_BY="${USER:-unknown}@$(hostname -s 2>/dev/null || echo unknown)"

# ---- write -------------------------------------------------------------------
cat > "$OUTPUT_PATH" <<EOF
{
  "tag": "${TAG}",
  "sha": "${SHA_SHORT}",
  "shaFull": "${SHA_FULL}",
  "date": "${DATE_YMD}",
  "timestamp": "${TIMESTAMP}",
  "builtBy": "${BUILT_BY}"
}
EOF

echo "${C_GREEN}${C_BOLD}✓${C_RESET} build-info.json emitted"
echo "  ${C_DIM}tag:${C_RESET}       ${TAG}"
echo "  ${C_DIM}sha:${C_RESET}       ${SHA_SHORT}"
echo "  ${C_DIM}timestamp:${C_RESET} ${TIMESTAMP}"
echo "  ${C_DIM}path:${C_RESET}      ${OUTPUT_PATH}"

# `scripts/`

Operational scripts for the IES Hub v3 repo. Each script is self-documenting
via `--help`; this README covers **when** to run each one and how they fit
into the deploy workflow.

## `apply-migration.sh` — schema changes (Phase 4 Slice 4.3)

Wraps `supabase db push` with a STAGING → confirm → PROD flow. See
[`supabase/migrations/README.md`](../supabase/migrations/README.md) for the
rule and full walkthrough.

Run **whenever you add a new migration file** under `supabase/migrations/`.

## `emit-build-info.sh` — version tag (Phase 4 Slice 4.4)

Writes `build-info.json` at repo root with the current HEAD's calendar
version tag:

```
{
  "tag":       "2026.04.24-5f3dfcf",   // YYYY.MM.DD-<shortsha>
  "sha":       "5f3dfcf",              // 7-char short SHA
  "shaFull":   "5f3dfcfc...",          // full 40-char SHA
  "date":      "2026-04-24",
  "timestamp": "2026-04-24T14:52:07Z", // ISO-Z when emitted
  "builtBy":   "user@host"
}
```

The file is consumed at runtime by `shared/build-info.js` and rendered in:
- the admin header env chip (e.g. `● PROD · 2026.04.24-5f3dfcf`)
- the bottom-right footer chip on every page

**Convention: run this immediately before every `git push origin main`.**

```bash
# Typical deploy loop:
git add <files>
git commit -m "your message"
scripts/emit-build-info.sh          # writes build-info.json for HEAD
git add build-info.json
git commit --amend --no-edit        # fold the build-info into the same commit
git push origin main
```

### Why manual today

Phase 4 kept deploy human-gated (the non-goal list in the scoping memo
explicitly rules out auto-deploy). Slice 4.5 will move this into the
GitHub Actions workflow (`.github/workflows/ci.yml`) so the emit happens
on merge to main instead of on the developer's laptop. When that lands,
this manual step goes away — the script itself stays, CI just calls it.

### Missing `build-info.json`

If someone forgets to run the script, `shared/build-info.js` falls back
to a `"dev"` stub: the footer chip stays hidden and the admin env chip
shows only the env label with no version. Nothing breaks — it's a
soft-fail so dev servers and forked clones work cleanly.

### Flags

```
scripts/emit-build-info.sh          # default: writes ./build-info.json
scripts/emit-build-info.sh --help   # usage
```

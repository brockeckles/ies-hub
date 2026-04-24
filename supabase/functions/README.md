# Edge Functions — source of truth

This directory mirrors the edge functions deployed to the prod Supabase project
(`dklnwcshrpamzsybjlzb`). It exists so the rollback workflow in
`IES Hub/IT_Pitch/Rollback_Runbook.md §3.3` can recover a prior source revision
from git instead of depending on Supabase retaining old deployment bundles.

## First snapshot

All eight sources were pulled down from Supabase at **2026-04-24** during
Phase 4 Slice 4.7 closeout. Content exactly matches what's serving in prod at
that time.

| Slug               | Deployed version | verify_jwt | Purpose                                |
|--------------------|:---:|:---:|----------------------------------------|
| ingest-eia-diesel  | v1 | false | EIA weekly diesel → `fuel_prices`     |
| ingest-intel-feed  | v1 | false | Universal intel feed ingest           |
| ingest-bls-wages   | v1 | false | BLS OEWS wages → `labor_markets`      |
| ingest-news-feeds  | v4 | true  | Competitor / automation / tariff news |
| hub                | v5 | false | Static-hub passthrough                |
| analytics-narrate  | v1 | true  | Anthropic API proxy                   |
| ingest-labor-watch | v4 | false | Union/NLRB activity → `union_activity`|
| invite-user        | v1 | true  | Admin-gated pilot invites (Slice 3.16)|

## Staging parity — known gap

Staging (`yswhxtpkfhvfbucyhads`) currently runs **0 edge functions**. The
`test-invite` live-net suite is held out of CI until staging gets at least
`invite-user` deployed. Tracked in Phase 4 Slice 4.7 closeout notes.

## Redeploy

The Supabase CLI is not wired into this repo yet. For now, edge functions are
deployed from the Supabase dashboard (Edge Functions → Deploy). When the CLI
wiring lands, the flow becomes:

```bash
supabase functions deploy <slug> --project-ref <ref>
```

Any edit to a function here should be matched by a corresponding redeploy. The
SHA of the deployed bundle is visible in the dashboard under the function's
**Deployments** tab; mismatches between `git log supabase/functions/<slug>` and
the dashboard SHA mean the repo and the live function have drifted.

# Edge Functions — source of truth

This directory mirrors the edge functions deployed to the prod Supabase project
(`dklnwcshrpamzsybjlzb`). It exists so the rollback workflow in
`IES Hub/IT_Pitch/Rollback_Runbook.md §3.3` can recover a prior source revision
from git instead of depending on Supabase retaining old deployment bundles.

## Deployed functions (as of 2026-07-22, Wave C5)

Seven functions are deployed. `analytics-narrate` (Anthropic API proxy, listed
in the 2026-04-24 snapshot) is **no longer deployed** and has no source here.

| Slug               | verify_jwt | Auth gate | Purpose                                    |
|--------------------|:---:|:---:|--------------------------------------------------|
| ingest-eia-diesel  | false | Bearer (see below) | EIA weekly diesel → `fuel_prices`  |
| ingest-bls-wages   | false | Bearer (see below) | BLS OEWS wages → `labor_markets`   |
| ingest-labor-watch | false | Bearer (see below) | Union/NLRB activity → `union_activity` |
| ingest-news-feeds  | true  | platform JWT | Competitor / automation / tariff news    |
| ingest-intel-feed  | false | n/a — **RETIRED** | 410 Gone tombstone (see below)      |
| hub                | false | n/a — **RETIRED** | 410 Gone tombstone → GitHub Pages   |
| invite-user        | true  | platform JWT + admin role | Admin-gated pilot invites (Slice 3.16) |

### Retired: ingest-intel-feed (2026-07-22)

The universal intel ingest endpoint (POST `{ feed_type, data }` → service-role
inserts into ~20 tables, critical rows auto-spawning active `hub_alerts`
banners) ran with `verify_jwt=false`, no body auth, and CORS `*` — an
unauthenticated service-role write surface. The C4 mini-audit found zero
callers (its pg_cron job was unscheduled 2026-04-17; no frontend references),
so it was retired in place rather than auth-gated. `index.ts` is now a 410
Gone tombstone mirroring `hub`. Keep the slug deployed so stray callers get a
clear 410 instead of a 404; safe to delete from the dashboard once logs
confirm continued zero traffic.

### Auth gate on the live ingesters (C5, 2026-07-22)

`ingest-bls-wages`, `ingest-eia-diesel`, and `ingest-labor-watch` keep
`verify_jwt=false` (their pg_cron/pg_net callers have no user JWT) but now
require a Bearer token at the top of the handler:

```
Authorization: Bearer <token>
```

where `<token>` is resolved as:

1. `INGEST_SECRET` — if this Edge Function secret is set in the dashboard, it
   is the **only** accepted token; or, when it is not set,
2. the project **anon key** (`SUPABASE_ANON_KEY`, auto-injected into the edge
   runtime).

Wrong or missing token → `401 {"error":"unauthorized"}`. The gate fails
closed: if neither env var resolves, every request is rejected.

Consequences:

- **The pg_cron jobs must send the header.** Each `net.http_post` call that
  triggers these functions needs
  `headers := jsonb_build_object('Authorization', 'Bearer <anon key>')`
  (or the INGEST_SECRET value). Header-less cron invocations now get 401.
- **Hardening escalation path:** the anon key is public (it ships in the
  frontend), so this gate only stops header-less internet drive-bys —
  anonymous data poisoning of `labor_markets`/`fuel_prices` and fetch/prune
  storms via `ingest-labor-watch`. To fully harden with **zero redeploys**:
  set `INGEST_SECRET` in Edge Function secrets and update the cron jobs'
  Authorization header to match. The functions check `INGEST_SECRET` first,
  so the switch takes effect on the next invocation.

Also fixed in C5: `ingest-eia-diesel`'s manual-POST branch
(`{ report_date, price_per_gallon }`) now runs **before** the `EIA_API_KEY`
check, so keyless manual pushes work as the `config_needed` message promises.

## First snapshot (historical)

All eight sources were pulled down from Supabase at **2026-04-24** during
Phase 4 Slice 4.7 closeout, exactly matching prod at that time. Since then:
`analytics-narrate` was undeployed, `hub` and `ingest-intel-feed` became 410
tombstones, and the three live ingesters gained the auth gate above.

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

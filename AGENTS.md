# AGENTS.md — operating manual for working on IES Hub

This file is the entry point for coding agents and new contributors. IES Hub
is a vanilla-JS (ES modules, **no build step**) single-page app for the GXO
IES Solutions Design team — 7 design tools + 6 hub sections over a Supabase
backend (Postgres + Auth + RLS + edge functions), currently deployed to
GitHub Pages. Everything below is operational law earned over ~18 months of
shipping; the *why* behind most rules lives in [docs/gotchas.md](docs/gotchas.md).

Pointer map — read these before writing code:

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layout, 3-layer pattern, routing, shared layer, data model, conventions |
| [SECURITY.md](SECURITY.md) | Auth posture (TOTP/AAL2 gate), reporting, scope |
| [docs/gotchas.md](docs/gotchas.md) | Debugging scar tissue — traps that each cost a real session |
| [README.md](README.md) | Environments (prod/staging Supabase refs), test suite split, versioning |
| [OWNERS.md](OWNERS.md) | Ownership + escalation |
| [scripts/README.md](scripts/README.md) | When to run each operational script |
| [supabase/migrations/README.md](supabase/migrations/README.md) | Migration workflow, naming, staging→prod discipline |
| [supabase/functions/README.md](supabase/functions/README.md) | Edge functions: deployed set, auth gates, redeploy |

## The layering law

Every non-trivial tool/section follows `types.js` / `calc.js` / `api.js` /
`ui.js` (details in [ARCHITECTURE.md §3](ARCHITECTURE.md)). The one rule that
is never negotiable:

> **`calc.js` stays pure.** No DOM, no `window`/`document`, no clocks, no
> network, no Supabase. It must run under bare Node — that is what makes the
> pure test suite possible.

`api.js` is the only layer that imports `shared/supabase.js`. `ui.js` is the
only layer that touches the DOM. Enforced by convention, not tooling — so
enforce it yourself.

- **One bucket-cost path per pricing surface.** Every surface that prices
  pricing buckets — the price-strip tiles, the rate-card table, What-If, the
  override validator — must derive from `computeAll().pricingSnapshot`, or at
  minimum pass the resolved `laborOpts` bag into `computeBucketCosts`. Dropping
  `laborOpts` silently reprices labor by the effective-hours factor
  `(1 + OT×0.5) × (1 − absence)` (0.902 on house defaults), so two surfaces on
  the same screen quote different rates. This shipped for three weeks in the
  Price station and was caught by eye, not by tests
  (`test-cm-pricing-table-parity.mjs`). Never let a UI file assemble bucket
  costs as a second source of truth.

## Non-negotiable workflow rules

1. **Run `npm test` before every push.** That runs `scripts/run-tests.mjs`:
   an ES-module parse pass over every `.js` in `tools/`+`hub/`+`shared/`
   (catches errors the tests can't, since tests never import UI modules),
   then every pure `test-*.mjs`. Live-net tests (`test-rls.mjs`,
   `test-rls-isolation.mjs`, `test-invite.mjs`, …) are **excluded by
   default** — they hit real Supabase projects and default to prod. Only CI
   runs them, against staging. Do not run them casually.

2. **Cache-bust pins cascade transitively — use the script, never hand-pin.**
   Every script/import URL carries `?v=YYYYMMDD-sN`. Changed bytes behind an
   unchanged URL serve **stale from the Pages CDN for up to ~30 minutes**.
   Re-pinning a file changes its importers' bytes, which re-pins *their*
   importers, to fixpoint. On every commit that changes a `.js`/`.css` file:

   ```bash
   node scripts/pin-cascade.mjs --pin <YYYYMMDD-sN> --seed <changed-file> [--seed ...]
   ```

   Commit exactly the changed-file list it prints.

3. **Build-info beacon on every deploy, then verify it live.** Run
   `scripts/emit-build-info.sh` immediately before `git push origin main`
   and fold `build-info.json` into the commit (exact loop in
   [scripts/README.md](scripts/README.md)). After pushing, poll the live
   `build-info.json` until its `sha` matches HEAD (propagation 30 s–6 min).
   This is also the fallback when the GitHub Actions API is unreachable.

4. **Nothing is "shipped" until walked on the live URL.** Pure tests assert
   at the calc layer and never import UI modules — they miss UI parse
   errors, broken selectors, and CSS/DOM regressions. Do an actual clickable
   walkthrough of the changed surface on the deployed site, in a **fresh
   tab** (the SPA caches aggressively). This rule has been proven necessary
   three separate times; see docs/gotchas.md.

5. **Schema changes are migration files, applied to BOTH environments.**
   No ad-hoc DDL. Every schema change is a file under `supabase/migrations/`
   (naming + header conventions in its README), applied via
   `scripts/apply-migration.sh` — staging first, prod second, always. After
   any apply cycle, the migration-ledger hash must match on both DBs.

6. **Append-only tables need RLS *and* a trigger.** The pattern of record is
   `deal_bid_snapshots` (`supabase/migrations/20260723120000_p2a_deal_bid_snapshots.sql`):
   no UPDATE/DELETE policies **plus** a BEFORE UPDATE/DELETE trigger that
   raises. RLS alone is not enough — `service_role` bypasses RLS but not
   triggers. Copy that migration when building the next append-only table.

7. **Audit actions are enum verbs only.** `recordAudit({table, id, action,
   fields})` (`shared/audit.js`) — `action` MUST be one of
   `insert|update|delete|link|unlink`. The DB CHECK constraint
   (`20260418211208_x15_audit_log.sql`) rejects anything else, and because
   audit writes are fire-and-forget, off-enum actions are **silently
   dropped**. Put descriptive verbs in `fields.op`. Capture the actor before
   any `await` (see the JSDoc on `recordAudit` and docs/gotchas.md).

8. **Consult `shared/deal-fk.js` before any new deal-linked table or query.**
   The deal FK is spelled three ways across the schema (`deal_deals_id`,
   `parent_deal_id`, `deal_id`) — documented, deliberately *not* renamed.
   New tables MUST use `deal_id` (uuid REFERENCES `deal_deals(id)`) and be
   added to the map + the pinning test (`test-c4-deal-fk-map.mjs`) in the
   same change.

9. **Grep the schema before writing SQL or payload code.** Real column names
   and CHECK constraints live in `supabase/migrations/`; do not guess them.

10. **Auth touchpoints live only behind the `shared/auth.js` seam.** No file
    outside it (plus `shared/supabase.js` client config) may call Supabase
    Auth directly — enforced by `test-auth-seam.mjs`; identity inventory for
    the GCP swap in [docs/auth-map.md](docs/auth-map.md).

## Invariants that look like bugs

Do **not** "fix" any of the following. Each is intentional, ruled on by the
product owner, and most are pinned by `test-invariants-soundness.mjs` or a
dedicated regression test. If you believe one is wrong, raise it — don't
patch it.

- **Deal card margin is ★-weighted.** Weighted by starred scenarios, not a
  simple average.
- **Deal grade math** (`tools/deal-manager/calc.js`): margin ×35% ·
  EBITDA ×25% · payback ×20% · NPV ×20%; thresholds A≥90 B≥75 C≥60 D≥45.
  It is user-visible via the grade ⓘ popover — change the popover if you
  change the math, and vice versa.
- **Σ★ (deal revenue roll-up) is engine-first.** Computed from starred
  scenarios' engines at read time, never from stored figures
  (`test-dm-rollup-engine-first.mjs`).
- **Total SQFT and Σ★ have different inclusion rules — on purpose.** Total
  SQFT is *scope* (all sites, estimates included, marked with an "est"
  pill); Σ★ is *priced* (starred sites only). They are not supposed to
  reconcile.
- **★ on `deal_sites` is the sole authority for bid membership.** The old
  `in_bid` column was dropped from both DBs (2026-07-22); do not resurrect
  it.
- **`deal_bid_snapshots` is append-only by design.** Re-submission = new
  row; the trigger blocks UPDATE/DELETE even for `service_role`. For
  `deal_outcomes` bid prefill, explicit values always beat snapshot values.
  Snapshot payloads carry `schema_version` (`buildBidSnapshotPayload`,
  `tools/deal-manager/calc.js`) — bump it on any shape change.
- **`feedback_votes` is deliberately NOT append-only** (unlike
  `deal_bid_snapshots`): deletes ARE the un-vote. One row per
  (feedback item, user), enforced by a unique constraint; no UPDATE policy
  and no immutability trigger — do not "fix" this by adding one.
- **`approve_scenario` is owner/admin-gated (2026-07-23 ruling).** Approval
  is a write-power: team/shared visibility grants READ, never approval — do
  not add a team arm to the gate. Never DROP this fn (ACL drift); always
  CREATE OR REPLACE.
- **`deal_outcomes` reads through the parent deal's visibility** (aligned
  with siblings 2026-07-23); its WRITE policies stay row-owner-or-admin.
- **`paybackMonths === 0` is a sentinel** meaning "never recovers", not
  "instant payback". Zero-payback with startup cost scores 0 in the grade.
- **Cost Model landing is cold-start-gated.** A hard refresh shows the
  scenario landing; in-session re-entry keeps the editor. Both are expected.
- **CM deal-detach is an explicit confirmed modal** — not a silent action.
- **Market Explorer counts are not status-filtered** — deliberate.
- **Old WSC scenarios size bigger than new ones** — the Shell-W default
  changed; historical scenarios are not migrated.
- **Y1 learning-curve divergence is hidden in the UI** by owner ruling.
- **Ingest edge functions require dual auth**: a platform-valid Bearer
  (publishable key) *and* `x-ingest-secret`. Publishable-only gets 401.
  That's the gate working, not broken
  ([supabase/functions/README.md](supabase/functions/README.md)).
- **Monthly seasonality reads `getBlendedSeasonality(model)`, never
  `model.seasonalityProfile` directly (S7, 2026-07-28).** The blend is the
  volume-weighted mix of every outbound channel's curve; single-channel
  models pass through unchanged. The legacy field is a dual-write mirror of
  channels[0] only — reading it on a multi-channel model silently drops
  every other channel's curve (that was the pre-S7 bug). Same commit:
  channel Activity is outbound/returns ONLY (`normalizeChannelActivities`
  coerces stored inbound/transfer on load — they were cosmetic), and By-mix
  allocations are guarded to Σ=100% (`checkMixAllocations` /
  `normalizeMixAllocations` in calc.channels.js).
- **The channels→legacy dual-write is FULLY RETIRED (S7d, 2026-07-28).**
  `syncLegacyFromChannel` is deleted; channels[] is the sole volumes store.
  Labor lines source volumes via `line.volume_source = {channelKey, figure}`
  (resolved through `calc.channels.resolveVolumeSource`; saved
  `volume_source_idx` converts at hydrate via
  `api.migrateLaborVolumeSources`, numbers untouched). Sourcing is
  **copy-at-selection by ruling** — a sourced line holds its copied volume
  until the user clicks ↺ re-sync (drift shows as an amber chip; approved
  scenarios stay reproducible). Do NOT make it live-sync, and never
  reintroduce a legacy mirror or new readers of
  `volumeLines`/`orderProfile`/`seasonalityProfile` —
  `backfillChannelsFromLegacy` is the one-way legacy→channels hydration
  path for old saves.
- **Hearthwood is the canonical demo/walkthrough deal** (see
  `run_offline_hearthwood.mjs` and many tests). Known quirks in its live
  data (as of 2026-07): the Memphis site is a byte-copy of Columbus's model
  and reprices on first save — intended; the Dallas Spoke site is an
  estimate (no priced model). Don't "clean up" the demo data.

## How work is organized

- **Multi-agent by default, disjoint file scopes.** Work fans out to
  parallel agents only when their file sets don't overlap. The main thread
  is the **integrator** and owns all cross-agent residue (pin cascades,
  shared-file conflicts, doc updates).
- **Waves that share a file run sequentially**, never in parallel.
- **Agent self-reports are unverified.** The integrator verifies claimed
  work against `git diff` and (for DB work) against the actual database
  before believing it.
- **Live verification uses the Hearthwood demo deal**, checked DB→UI in a
  fresh tab.
- **Commit before running mutation probes.** DB probes against append-only
  or prod tables use self-rolling-back `DO` blocks (insert-ok /
  update-blocked / delete-blocked, zero residue).
- **Re-verify "unused" inventories by grep before destructive action.**
  Stale internal audits have been wrong before.
- **User-reported dead inputs are ~90% real bugs.** When a user asks how a
  number works, expose the engine breakdown in the UI (the grade ⓘ
  pattern), don't write prose docs.
- **One deal-wide home for a concept** beats per-line duplicates.

## Maintenance contract

> **This file and docs/gotchas.md are updated as part of every shipped
> wave. If you shipped behavior that future maintainers could misread, or
> learned a rule the hard way, record it here in the same commit.**

Do not put secrets, tokens, connection strings, or personal-account details
in this file or anywhere else in the repo. Supabase project refs and public
URLs are fine (already in [README.md](README.md)).

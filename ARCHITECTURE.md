# IES Hub — Architecture

This document is the orientation map for anyone picking up the IES Hub codebase.
Skim it before reading code; refer back to it when something doesn't fit your
mental model.

## 1. What the Hub is

A vanilla-JS (ES modules, no build step) single-page web app that gives the
IES Solutions Design team:

- 7 **design tools** for sizing and modeling 3PL solutions (Cost Model,
  Warehouse Sizing, MOST Labor Standards, Network Optimization, Center of
  Gravity, Fleet Modeler, Multi-Site Analyzer).
- 6 **hub sections** for the workflow around those tools (Command Center,
  Market Explorer, Deal Management, Training Wiki, Feedback, Admin, plus
  the Design Tools landing).
- A Supabase backend (Postgres + Auth + RLS) and a deck-generator service
  (PptxGenJS) reachable from Deal Management.

Authentication is hybrid — Supabase Auth with TOTP MFA enforced for all
roles. Admin-only routes are gated both at the nav layer and the route layer
(see `index.html` `applyAdminGating`).

Deployment is currently GitHub Pages; a port inside the GXO firewall is in
progress and motivates much of the discipline encoded below.

## 2. Top-level layout

```
.
├── index.html               # router + auth gate + 'designtools' landing inline
├── css/
│   └── hub.css              # single design-system stylesheet (~4.2K lines)
├── shared/                  # cross-tool primitives (auth, router, bus, etc.)
├── tools/
│   ├── cost-model/          # Cost Model Builder  (flagship)
│   ├── warehouse-sizing/    # WSC + 3D walkthrough
│   ├── most-standards/      # MOST Labor Standards
│   ├── network-opt/         # Network Optimization
│   ├── center-of-gravity/   # COG site selector
│   ├── fleet-modeler/       # Fleet Modeler
│   └── deal-manager/        # Multi-Site Analyzer
├── hub/
│   ├── command-center/      # KPIs, signals, alerts
│   ├── market-explorer/     # geographic market browser
│   ├── deal-management/     # deal pipeline (DOS stages)
│   ├── training-wiki/       # static documentation (51 articles, hardcoded)
│   ├── feedback/            # Ideas & Feedback (real, Supabase-backed)
│   ├── admin/               # user activity, audit, escalations, MFA
│   └── deck-generator/      # PptxGenJS service (no UI; invoked from deal-mgmt)
├── supabase/migrations/     # 120 SQL migrations
└── test-*.mjs               # pure Node ES-module test files
```

## 3. The 3-layer pattern

Every tool and every hub section that grew past trivial follows the same
4-file layout:

| File         | Purpose                                                      | Allowed dependencies         |
|--------------|--------------------------------------------------------------|------------------------------|
| `types.js`   | JSDoc typedefs only. No runtime code.                        | none                         |
| `calc.js`    | Pure functions. The engine.                                  | other `calc.js`, types       |
| `api.js`     | Supabase access. CRUD. Mapping DB rows ↔ runtime shapes.     | `shared/supabase.js`, calc   |
| `ui.js`      | DOM rendering. Event wiring. Template literals + innerHTML.  | calc, api, shared/*          |

The contract is enforced by convention, not tooling:

- `calc.js` must be pure (no DOM, no Supabase, no `window`/`document`,
  no console output other than debug). It must be safe to run from Node.
- `api.js` is the only layer that imports `shared/supabase.js`.
- `ui.js` is the only layer that touches the DOM.

For tools whose engine grew large (Cost Model), the calc layer splits into
satellite files: `calc.channels.js`, `calc.monthly.js`, `calc.scenarios.js`,
`shift-planner.js`. The same pattern is being extended to the UI layer as
of the 2026-05 port-readiness pass (see Section 7).

## 4. Routing & boot

`index.html` is the only HTML file. It contains:

1. Authentication overlay + `auth.bootstrapSession()`.
2. MFA gate (every user must pass aal2 before the app shell mounts).
3. Hash router (`shared/router.js`) registration for hub sections and design
   tools. Tool UIs are lazy-loaded via dynamic import.
4. Admin gating (a non-admin who deep-links to `#admin` is bounced to
   `#overview`).
5. The Design Tools landing page (categorized cards) — defined inline so it
   doesn't need its own module.
6. Global UX modules that self-wire on import: toast, feedback FAB,
   unsaved-changes guard, tour, analytics, MFA UI.

A route flow looks like:

```
hashchange  →  shared/router.js _onHashChange
            →  unmount previous tool (if any)
            →  dynamic import(`./tools/<tool>/ui.js?v=...`)
            →  module.mount(outletEl)
            →  bus.emit('nav:changed', {section, tool})
```

Tool `ui.js` modules export `mount(el)` and `unmount()`. They are responsible
for cleaning up listeners, intervals, and detached DOM on unmount.

## 5. Shared layer

`shared/` houses the primitives every tool reaches for. Keep these tight —
churn here ripples everywhere.

| Module                    | Role                                                          |
|---------------------------|---------------------------------------------------------------|
| `auth.js`                 | Supabase session, password / MFA / recovery flows, role gate. |
| `router.js`               | Hash router; lazy module loading; lifecycle.                  |
| `event-bus.js`            | Pub/sub for cross-tool events (use sparingly — see below).    |
| `supabase.js`             | The shared Supabase client + `getEnvLabel()`.                 |
| `toast.js`                | The canonical toast helper (use this; don't redefine).        |
| `confirm-modal.js`        | `showConfirm` / `showPrompt`. Use this; don't redefine.       |
| `tool-chrome.js`          | The shared tool header / tab strip / Run-button chrome.       |
| `tool-frame.js`           | Phase stepper for Cost Model.                                 |
| `tour.js`                 | Guided tours (per-tool tour configs live here).               |
| `analytics.js`            | Page-view + event tracking → Supabase `analytics_events`.     |
| `audit.js`                | Audit-trail writes → Supabase `audit_log`.                    |
| `feedback-fab.js`         | Floating "Ideas & Feedback" button.                           |
| `unsaved-guard.js`        | `beforeunload` guard wired by tools with dirty state.         |
| `run-state.js`            | Tracks dirty/clean for tools with explicit "Run" buttons.     |
| `planning-ratios.js`      | Cached pull of `ref_planning_ratios`. Used by CM.             |
| `scenario-landing.js`     | The "Scenarios" picker each tool shows on first mount.        |
| `search.js`               | Global Ctrl+K search index.                                   |
| `cm-drillback.js`         | sessionStorage handshake for CM → child-tool drill-back.      |
| `build-info.js`           | Reads `build-info.json` for the version chip.                 |
| `cdn-wrappers/*`          | Thin guards around Three.js / Leaflet / Chart.js / GLPK.      |

### State management

The Hub does not have a centralized reactive store. Each tool `ui.js` holds
its own module-level mutable state (`let model`, `let zones`, etc.) and
manually re-renders sections on change. A previous `shared/state.js`
attempt was removed 2026-05-11 because it was imported but unused — every
tool imported it without calling `state.get` or `state.subscribe`.

If reactivity becomes a real need, *commit* to a state layer and migrate
the module-level blobs into it. Don't ship a half-state again.

### Event bus

`shared/event-bus.js` is intentionally minimal. It is used for legitimate
cross-tool signals (e.g. `nav:changed`, `auth:login`, `cm:push-to-wsc`).
It is **not** a substitute for state — many emits in the codebase have
no subscribers and exist as historical noise. When in doubt, prefer
sessionStorage + a direct hash-change for cross-tool handoffs (see
`shared/cm-drillback.js`).

## 6. Data layer (Supabase)

120+ migrations under `supabase/migrations/`. The schema is RLS-gated; every
table that holds user-scoped data has policies enforcing per-user (or per-
role) access. Admin users bypass via `auth.users` metadata + the
`is_admin()` SQL helper.

Key tables:

| Table                       | Owner / purpose                                              |
|-----------------------------|--------------------------------------------------------------|
| `cost_model_projects`       | Cost Model scenarios; `project_data` holds the full model.   |
| `deal_deals`                | Deal pipeline rows (DOS stages).                             |
| `deal_artifacts`            | Generated artifacts per deal (decks, exports).               |
| `wsc_scenarios`             | Warehouse Sizing scenarios (standalone or linked to CM).     |
| `netopt_scenarios`          | Network Optimization scenarios.                              |
| `fleet_scenarios`           | Fleet Modeler scenarios.                                     |
| `cog_scenarios`             | Center of Gravity scenarios.                                 |
| `most_scenarios`            | MOST template library + analyses.                            |
| `multi_site_deals`          | Multi-Site Analyzer roll-ups.                                |
| `hub_feedback`              | Ideas & feedback entries.                                    |
| `wiki_*`                    | Training Wiki tables (currently unused — content is static). |
| `analytics_events`          | Page-view + event log.                                       |
| `audit_log`                 | Audit trail (login, mutation, deletion events).              |
| `ref_*`                     | Reference / lookup tables (markets, planning ratios, etc.).  |

## 7. Cost Model — the special case

Cost Model is the flagship. It is also the largest single body of code in
the repo, and its UI has historically grown as one file (`ui.js`). As of
2026-05-11, that file is being split along the natural seams identified in
the port-readiness audit:

- `operational-flow-ui.js` — the `renderOperationalFlow` 3.3K-line section.
- `sensitivity-ui.js` — `renderSensitivityCard`.
- `heuristics-ui.js` — `renderHeuristicsPanel`.
- `implementation-ui.js` — `renderImplementation`.

The calc side already split this way years ago (`calc.channels.js`,
`calc.monthly.js`, etc.). The UI side is following.

When adding a new Cost Model section, prefer creating a peer `*-ui.js`
module over extending `ui.js` further.

## 7.5 — Calc-as-service `runScenario` wrappers

As of 2026-05-11 (port-readiness S8), four design-tool engines expose a
standardized `runScenario(params)` export alongside their existing
function-level API:

| Tool                | Wrapper location                       |
|---------------------|----------------------------------------|
| Fleet Modeler       | `tools/fleet-modeler/calc.js`          |
| Center of Gravity   | `tools/center-of-gravity/calc.js`      |
| Multi-Site Analyzer | `tools/deal-manager/calc.js`           |
| Network Optimization| `tools/network-opt/calc.js`            |

Contract: `runScenario(params) -> { ok, version, result, errors }`. Never
throws. Validates input shape, then delegates to the existing engine
function. Each module also exports `ENGINE_VERSION` (a semver string).

This is the architectural prep work for the future calc-as-service /
MCP-server / AI-callable pattern. When Anthropic API access lands inside
the firewall, these wrappers become the cheap surface to expose. Until
then, they exist as a no-op layer (zero behavior change for the UI).

Cost Model and Warehouse Sizing do not yet have `runScenario` wrappers
because their inputs are far more complex (full multi-section CM model,
WSC throughput + override mode). Add when needed — design notes in the
2026-05-11 port-readiness assessment under "Position".

## 7.6 — Won-deal learning loop (`deal_outcomes`)

Migration `20260511180000_deal_outcomes_won_lost_loop.sql` adds a table to
capture won/lost outcomes + Y1 actuals per deal. Schema-first by design —
the capture UI ships later; for the first 6 months an admin user
populates rows manually via Supabase Studio or a thin form.

A `public.deal_outcomes_enriched` view pre-computes bid-vs-actual variance
percentages, which is the input shape the future calibration coach + the
benchmark library both consume.

## 8. Testing

Pure Node ES-module tests live at the repo root as `test-*.mjs`. They are
runnable individually (`node test-wsc-sizing.mjs`) or as a group
(`npm test` once the script is wired). They are PURE — no network, no DOM,
no Supabase (except a small handful that stub Supabase with self-skip
behavior if offline).

Coverage as of 2026-05-11 is heavy on Cost Model + WSC + Auth and light on
NetOpt / Fleet / COG / Deal Manager. Closing that gap is part of the port
readiness work.

Tests assert at the calc layer. No browser/DOM integration tests exist.

## 9. CSS

Single file `css/hub.css` (~4.2K lines). Opens with ~53 CSS custom properties
(spacing, color ramp, type sizes, radii) that should be used everywhere.

Inline `style="..."` attributes in template literals are pervasive across
tool UIs (~3.7K instances). This is a known debt; new code should prefer
classes from `hub.css` over inline styles wherever practical.

## 10. Build & deploy

No build step. ES modules load directly. Cache-busting is done via `?v=...`
query params on every `<script>` and `import` URL — bump the suffix when
you change a file, and the GitHub Pages CDN will serve fresh code.

`build-info.json` is updated by `scripts/emit-build-info.sh` and surfaces
as the version chip at the bottom-right of the live site.

## 11. Conventions

- **Numeric fallbacks:** use `??`, not `||`. The latter silently maps zero
  to a default; the former preserves zero. (Lesson learned the hard way —
  see `feedback_nullish_vs_or_for_numerics.md` in agent memory.)
- **No new `console.log`** in production paths. Use `console.warn` for
  recoverable surprises and `console.error` for genuine failures. Toast
  the user when something they did failed.
- **No `bus.emit` without a subscriber.** If you can't point at the
  listener, don't emit. The bus is not a metrics channel.
- **No duplicate helpers.** If you find yourself writing a `showConfirm`,
  `showPrompt`, `showToast`, or escape helper, look in `shared/` first.
- **Cache-bust everything you touch.** Any file whose contents changed
  needs its `?v=...` suffix bumped on the importer side.

## 12. Where to look first

| Question                                                  | File                                       |
|-----------------------------------------------------------|--------------------------------------------|
| How does login work?                                      | `shared/auth.js`                           |
| How does a hash change become a tool mount?               | `shared/router.js`, `index.html` bottom    |
| How is Cost Model navigated?                              | `tools/cost-model/ui.js` `renderGroupedNav`|
| What does WSC actually compute?                           | `tools/warehouse-sizing/calc.js`           |
| How does CM hand off to WSC / NetOpt?                     | `shared/cm-drillback.js`                   |
| Where are user roles defined?                             | `supabase/migrations/*role*`               |
| What's the latest cache-bust shipped?                     | `index.html` `<script>`/`import` tags      |


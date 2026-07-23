# Gotchas — debugging scar tissue

Each entry below cost at least one real debugging session. Read
[AGENTS.md](../AGENTS.md) for the workflow rules these feed into, and
[ARCHITECTURE.md](../ARCHITECTURE.md) for the structural context. When you
earn a new scar, add it here **in the same commit** that ships the fix
(that's the maintenance contract in AGENTS.md).

Format per entry: the trap → the symptom → the rule.

## Database & RLS

- **`audit_log_action_check` eats off-enum actions silently.** The CHECK
  constraint (`supabase/migrations/20260418211208_x15_audit_log.sql`)
  allows only `insert|update|delete|link|unlink`, and `recordAudit` is
  fire-and-forget — so every descriptive-verb audit write ("submitted",
  "starred", …) was dropped without error **for weeks** until a live
  walkthrough caught it. Rule: enum verbs only in `action`; descriptive
  verbs go in `fields.op`. A regression test pins this.
- **RLS does not stop `service_role`; triggers do.** An "append-only" table
  protected only by missing UPDATE/DELETE policies is still writable by
  service-role callers. Add a BEFORE UPDATE/DELETE trigger that raises —
  see `20260723120000_p2a_deal_bid_snapshots.sql` (prod-probed).
- **Audit actor: capture `auth.uid()` / `getUser()` BEFORE the first
  `await`.** The session can rotate mid-call; capturing after an awaited
  round-trip can null out attribution. `recordAudit` accepts an
  `entry.actor` override for exactly this (see `shared/audit.js` JSDoc).
- **`DROP TABLE` dependents differ per environment.** Prod had DOS
  functions that staging lacked; a blind `CASCADE` would have destroyed
  different things in each DB. Enumerate dependents per-DB first; never
  CASCADE blind.
- **Column drops need a client-refresh gate.** Live SPA sessions keep
  selecting the dropped column and start erroring. Sequence: ship client
  code that stops referencing the column, wait for sessions to cycle, then
  drop.
- **Sibling CTEs share one snapshot.** A write in one CTE is invisible to a
  sibling CTE in the same statement. Chain dependent writes, don't
  parallelize them in one statement.
- **`CATALOG_VERSION` bump force-reseeds reference data.** Seed migrations
  must stamp `pricing_bucket` or the reseed leaves rows unclassified.
- **Deal FK is spelled three ways.** `deal_deals_id` (cost_model_projects),
  `parent_deal_id` (five scenario tables), `deal_id` (canonical, all new
  tables). Documented — deliberately not renamed. Consult
  `shared/deal-fk.js` before touching anything deal-linked; it is pinned by
  `test-c4-deal-fk-map.mjs`.
- **Migration ledger parity is the invariant.** After any apply cycle, the
  md5 over `supabase_migrations.schema_migrations` must match on staging
  and prod (query in
  [supabase/migrations/README.md](../supabase/migrations/README.md)).

## Supabase edge functions & platform

- **`verify_jwt` rejects non-JWT Bearers BEFORE your code runs.** A private
  secret sent as the Bearer never reaches the handler. Private secrets ride
  custom headers (`x-ingest-secret`); the Bearer must be a platform-valid
  key. Hence the ingest cron jobs send BOTH headers (see
  [supabase/functions/README.md](../supabase/functions/README.md)).
- **The edge runtime injects the PUBLISHABLE key as `SUPABASE_ANON_KEY`** —
  not the legacy anon JWT. Code comparing Bearers against that env var is
  comparing against the publishable key.
- **Dashboard/tooling redeploys can flip `verify_jwt` back to TRUE.**
  Recheck the flag after every deploy of a function that needs it false.
- **Secret rotation for the ingesters** = update the dashboard secret + the
  three cron jobs' `x-ingest-secret` headers. No redeploy needed.
- **`ingest-labor-watch` can 504 to the caller while succeeding
  server-side** (~150 s of sequential RSS fetches vs the ~150 s gateway
  timeout). Harmless for cron; don't "fix" the 504 by re-running the
  ingest.

## Deploy & CDN

- **Changed bytes behind an unchanged `?v=` URL serve STALE from the Pages
  CDN for up to ~30 minutes.** This shipped a broken build that looked fine
  locally. Rule: never hand-pin; run `scripts/pin-cascade.mjs` so the pin
  change cascades transitively to every importer (see AGENTS.md rule 2).
- **Pure tests miss UI parse errors.** They never import `ui.js` modules.
  The parse pass in `scripts/run-tests.mjs` catches syntax-level breakage,
  but only a live clickable walkthrough catches the rest. Proven three
  times (stale-cache, silent audit CHECK, stale-CDN pins).
- **GitHub API can be proxy-blocked from sandboxes.** When you can't reach
  the Actions API, poll the live `build-info.json` instead — deploy
  propagation is 30 s–6 min.
- **Verify DB→UI state in a fresh tab.** The SPA caches per-session state;
  a stale tab will show you the world as it was.
- **Per-deal caches need bust-on-return-from-tool.** A tool that edits deal
  data must invalidate the deal-management cache on the way back, or the
  deal screen shows pre-edit numbers (the stale-designs-cache incident).

## DOM / UI

- **Bind listeners once per mount.** Re-running a render function inside
  one mount stacks duplicate listeners (every click fires N times). Re-bind
  after a container reshell, and tear down on unmount
  (`test-listener-stacking.mjs` pins the pattern).
- **Prefer surgical refresh over `innerHTML` re-render** — full re-render
  destroys input focus mid-typing.
- **`[hidden]` loses to `display:flex`.** A CSS rule setting display beats
  the hidden attribute; the element stays visible.
- **`flex: none` for fixed-size badges**; otherwise flexbox squashes them.
- **SVG in a grid cell needs `min-width: 0`** on the cell or it blows the
  track out.
- **HTML5 drag-and-drop needs `effectAllowed`** set or drops silently fail
  in some browsers.
- **Native `alert()`/`confirm()` freeze browser automation.** Use
  `shared/toast.js` and `shared/confirm-modal.js` — never the natives.
- **CSS `var()` can't reach canvas/Leaflet/SVG paint code.** Anything that
  paints outside CSS needs literal color values; alpha-concatenation
  (`color + '33'`) needs a literal hex to concatenate onto.
- **A dropdown `onchange` referencing a nonexistent method is a silent
  no-op.** No error, no effect. Verify the handler exists after renames.

## JavaScript / ESM

- **`??`, not `||`, for numeric fallbacks.** `||` silently maps 0 to the
  default (also in [ARCHITECTURE.md §11](../ARCHITECTURE.md)).
- **`db.rpc` already unwraps `.data`** (`shared/supabase.js`). Don't
  destructure `{ data }` from its result a second time — you'll get
  `undefined`.
- **Dynamic `import()` resolves against the MODULE's URL, not the page.**
  Relative specifiers in a shared module resolve from `shared/`, not from
  `index.html`.
- **`node --check` validates CommonJS only.** It passes files with
  ES-module-only errors. Validate ESM via
  `node --input-type=module --check` (what `run-tests.mjs` does) or a
  dynamic import.
- **Use the shared escape helpers.** `shared/escape.js` is the canonical
  `escapeHtml`/`escapeAttr` (it consolidated 8 per-module copies). Don't
  write a ninth.
- **Named imports over module-namespace imports** — keeps dead-code greps
  honest.
- **No backticks inside template-literal comments.** A backtick in a
  comment inside a template literal terminates the literal.
- **`setNestedValue` treats numeric path segments as array indices.**
  `"a.0.b"` builds an array at `a`, not an object with key `"0"`.

## Tooling & patch scripts

- **Python `'''`-heredocs close early on an inner `'''`.** Generated patch
  scripts that embed docstrings corrupt themselves. Always verify the diff
  size after any scripted edit, and make patch scripts idempotency-checked
  before re-running.
- **SQL built via `json.dumps` needs dollar-quoting** — embedded quotes in
  the JSON break naive string interpolation.
- **Live-net tests default to PROD.** Running `test-rls-isolation.mjs`
  locally wrote persona rows to production, and a mid-run kill skipped the
  teardown and leaked rows. The pure suite excludes them by default
  (`scripts/run-tests.mjs` header tells the full story); only CI runs them,
  against staging.
- **Sandbox/container filesystems are ephemeral.** `/tmp` does not persist
  between sessions and containers can restart mid-day — commit early. Some
  mounted-output filesystems can't unlink git lock files; run git from a
  native-filesystem clone.

## Testing

- **Run shared-state tests at the END of suites.** Some tests are
  ordering-sensitive; shared-module state mutated by earlier tests changes
  their outcome.
- **Each test file runs as its own child process** (see
  `scripts/run-tests.mjs`) so listeners and module state don't leak — keep
  it that way when adding runners.
- **Pin every hard-won invariant with a regression test.** The soundness
  invariants in AGENTS.md live in `test-invariants-soundness.mjs` and
  friends; when an incident here gets a rule, it should also get a test.

## Adjacent-surface traps (exports, email)

- **PptxGenJS corrupts decks with certain image/master-slide combos.**
  Check the deck-generator feedback notes before deck work.
- **Excel cell notes starting with `=` get parsed as formulas.** Lead with
  a space.
- **Corporate email scanners consume one-time links.** Magic links arrive
  pre-clicked and dead. Use OTP codes, not magic links, for anything sent
  to corporate mailboxes.

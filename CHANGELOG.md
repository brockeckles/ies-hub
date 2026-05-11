# IES Hub — Changelog

Notable shipped changes, newest first. Cache-bust suffix (`?v=...`) appears
in parentheses where relevant for quick reference.

## 2026-05-11 — Port-readiness sprint (in progress)

- **S3: bug fixes / token normalize.** Killed 4 token-fallback drift
  classes (`var(--ies-orange, #d97706|#f97316|#b8860b)` and
  `var(--ies-navy, #001f3f|#0F1B2E|#0a1628)`) — 30 fallbacks normalized to
  the canonical `#ff3a00` / `#1c1c1c` across 5 files. Consolidated 3
  local toast wrappers (`showCmToast` / `showWscToast` / `showNoToast`)
  into the single `shared/toast.js` import every tool already had. Deleted
  the byte-identical local `showConfirm`/`showPrompt` in cost-model/ui.js
  in favor of `shared/confirm-modal.js`. Cache-bust 20260511-port3.
- **S2: decisions.** Killed Change Management (route + nav + DEMO_INITIATIVES
  + working api.js that was never wired). Killed Deck Generator (engine,
  panel in Deal Management, PptxGenJS CDN, the v2-dtg-deckgen wiki article).
  Multi-Site Analyzer: removed Pipeline / Hours / Tasks / Updates workflow
  tabs (kept Summary / Sites / Financials / Sensitivity / Compare) — 732
  lines out of `tools/deal-manager/ui.js`. Trimmed 15 unused workflow API
  exports from `tools/deal-manager/api.js` (744 → 460 lines). Wiki content
  retained as-is (static). ARCHITECTURE.md + OWNERS.md aligned.
- **S1: docs.** Wrote `ARCHITECTURE.md`, `OWNERS.md`, `CHANGELOG.md`.
- **S1: cuts.** Dead module removal (`shared/record-actions.js`,
  `tools/cost-model/shift-archetypes.js`, 6 dead exports in
  `shared/tool-frame.js`). Kill of `shared/state.js` — imported by 7 tool
  UIs but read by zero call sites. 9 of 14 production `console.log`
  removed. JS LOC: 77,612 → 76,964. Pure suite 47/47 green.
  (`?v=20260511-port1`, commit `dd1708c`)

## 2026-05-08 — WSC consolidation

- Unified WSC throughput-mode + override-mode into a single form. New
  shelving override symmetric with pallets. Pure suite 523/523.
  (`?v=20260508-consolidate3`, commit `b046905`)
- Earlier same day: WSC empty-state fix — zeroed default zones + volumes,
  `||` → `??` on numeric fallbacks, dropped `Math.max(2, ...)` dock floor.
  (`?v=20260508-emptystate`, commit `3aca810`)

## 2026-05-06 — WSC Phase F.11 + F.12

- F.11: labeled cross-aisles + Forward Pick 3D structural detail.
- F.12: wall-visibility toggle + FP rendering polish. Pure suite 470/470.
  (`?v=20260506-phaseF12`, commit `d31e6db`)

## 2026-05-05 — President briefing deck + WSC IE reassessment

- 3-slide president briefing PPTX (dark GXO palette, hero stat win rate
  <15% → 25%). File: `IES Hub/IES_Hub_President_Briefing.pptx`.
- WSC reassessment phases A→E + polish F.1→F.10 shipped same day.
  Pure suite 406/406. (`?v=20260505-phaseF10`, commit `dccf72b`)

## 2026-05-04 — WSC redesign (Phases 1–4)

- Phase 1: IE-correct unit-load, carton, SKU, dock helpers (additive).
- Phase 2: UI restructure into 5-step IE-correct flow.
- Phase 3: IE-correct 3D rendering corrections (uprights every 9 ft, top
  beam drop, bottom-beam toggle, 2 pallets per bay, cartons from profile).
- Phase 4: WSC standalone-capable + WSC → CM writeback bus.

## 2026-04-30 — Hearthwood baseline sanity check + post-punchlist

- Offline 5-year P&L validation. 9 findings flagged. Workbook at
  `IES Hub/2026-04-30_hearthwood_baseline_pnl_sanity_check.xlsx`.
- Post-punchlist follow-ups: button consistency, racking install double-
  dip fix, OVERHEAD → COGS rename, yearly-rollup fallback, calc.monthly.js
  cache-bust. Commit `e0dc988`.

## 2026-04-29 — Volumes-as-nucleus Phase 5 + CM cross-tool drillback

- Five sub-phases shipped: P&L cells, KPI tiles, Indirect Labor +
  Overhead + Startup, Equipment, cross-tool drillback. New
  `shared/cm-drillback.js`. Commit `2d162aa`.

## 2026-04-29 (earlier) — Demo audit (R-tier)

- R5 NPV reconciliation, R8/R10/R13/R14, 27-call native confirm() sweep.
  Live-verified at HEAD `84182f2`. Closeout at
  `IES Hub/2026-04-29_eve_session_closeout.md`.

## 2026-04-24 — Phase 4.5 tranche-2 (MFA-01 + HYG-04)

- Post-login MFA gate extended to member tier. Satisfies CIS Control 6.3.

## 2026-04-22 — Equipment Peak (Phases 2a-2e) + Seasonality

- `line_type` enum (own/rented/IT), `rented_mhe` opex line, peak/steady
  split. Matrix-weighted peak via `autoGenerateEquipment`.

## 2026-04-17 — v3 Gap Audit

- 198 gaps catalogued (19 P0 / 67 P1). Subsequent sweeps closed the bulk.

## 2026-04 — v3 reach-completion

- Hub Deal Management → real-deals wiring (splice from DB).
- NetOpt — Optimize Network unified UX (merged Compare DCs + Exhaustive).
- NetOpt legacy JSON shape normalization (3 facility/demand variants).
- Shift Planner v1.3 — 172 tests; per-shift activeDays / DOW multipliers.

## 2026-04-05 — v3 cutover

- v1 monolith redirected to v3. v3 is sole production path.

---

*This changelog was seeded 2026-05-11 from the project memory index. Entries
prior to 2026-04 are summarized; full per-commit history is in `git log`.*

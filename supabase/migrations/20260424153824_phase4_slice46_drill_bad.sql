-- =============================================================================
-- IES Hub — Phase 4 Slice 4.6 — Rollback Drill, Part 1 of 2 (BAD MIGRATION)
-- =============================================================================
-- Purpose:  Deliberately-bad migration for the Slice 4.6 rollback drill.
--           Adds a nonsense column `rollback_drill_bad_column` to public.teams
--           with a NOT NULL DEFAULT 'BAD'. This is the "bad state" the drill
--           reverses via the paired rollback migration (..._drill_rollback.sql).
--
--           NOT applied to prod. Staging-only. After the drill's rollback
--           migration, staging returns to net-zero schema change from this pair.
--
-- Author:   Brock + Claude (Cowork)
-- Created:  2026-04-24
-- Scope:    Drill-only. Never run against prod. Ledger drift between envs
--           (2 extra rows on staging) is accepted and documented in the
--           Slice 4.6 landing memory.
--
-- Rollback: ALTER TABLE public.teams DROP COLUMN IF EXISTS rollback_drill_bad_column;
--           (see paired rollback migration file)
-- =============================================================================

ALTER TABLE public.teams
  ADD COLUMN rollback_drill_bad_column text NOT NULL DEFAULT 'BAD';

COMMENT ON COLUMN public.teams.rollback_drill_bad_column IS
  'Slice 4.6 drill marker. If you see this on prod, the drill leaked across envs. Drop immediately.';

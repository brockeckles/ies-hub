-- =============================================================================
-- IES Hub — Phase 4 Slice 4.6 — Rollback Drill, Part 2 of 2 (ROLLBACK)
-- =============================================================================
-- Purpose:  Reverse the Slice 4.6 drill's bad migration
--           (20260424153824_phase4_slice46_drill_bad.sql). Drops the
--           throwaway column added to public.teams. After this migration
--           runs, the drill is net-zero on staging and the rollback
--           runbook has live evidence it works end-to-end.
--
-- Author:   Brock + Claude (Cowork)
-- Created:  2026-04-24
-- Scope:    Staging-only. Same scope as the paired bad migration.
--
-- Rollback: ALTER TABLE public.teams
--             ADD COLUMN IF NOT EXISTS rollback_drill_bad_column text
--             NOT NULL DEFAULT 'BAD';
--           (would re-install the drill's bad state; only run in a new drill)
-- =============================================================================

ALTER TABLE public.teams
  DROP COLUMN IF EXISTS rollback_drill_bad_column;

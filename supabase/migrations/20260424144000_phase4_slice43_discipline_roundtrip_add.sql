-- =============================================================================
-- IES Hub — Phase 4 Slice 4.3 — Trivial Round-Trip, Part 1 of 2 (ADD)
-- =============================================================================
-- Purpose: Prove the migration-file discipline works end-to-end. Adds a
--          throwaway text column to public.teams so we can verify it landed
--          on staging first and then prod through the apply path. The paired
--          DROP migration (20260424144100_*_drop.sql) removes the column so
--          the net effect is zero.
--
-- Author:  Brock + Claude (Cowork)
-- Created: 2026-04-24
-- Scope:   Round-trip correctness check, not a schema change anyone cares about
--
-- Rollback: ALTER TABLE public.teams DROP COLUMN IF EXISTS test_discipline;
-- =============================================================================

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS test_discipline text;

COMMENT ON COLUMN public.teams.test_discipline IS
  'Slice 4.3 round-trip marker. Removed by paired drop migration. If you see this in prod, the drop half of the round-trip did not complete.';

-- =============================================================================
-- IES Hub — Phase 4 Slice 4.3 — Trivial Round-Trip, Part 2 of 2 (DROP)
-- =============================================================================
-- Purpose: Remove the throwaway column added in the paired ADD migration
--          (20260424144000). After this migration completes on both envs,
--          net schema change from the round-trip is zero.
--
-- Author:  Brock + Claude (Cowork)
-- Created: 2026-04-24
--
-- Rollback: ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS test_discipline text;
-- =============================================================================

ALTER TABLE public.teams
  DROP COLUMN IF EXISTS test_discipline;

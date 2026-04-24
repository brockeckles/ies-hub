-- =============================================================================
-- IES Hub — Phase 4 Slice 4.3 — Staging Hygiene Fold-In, Part 2
-- =============================================================================
-- Purpose: Add the second column the trigger path needs. Part 1 added
--          master_markets.ref_market_uuid; we discovered during the live-verify
--          probe that provision_market_intel ALSO writes to
--          ref_markets.master_market_id, which is on prod but missing on staging.
--          Both columns are required for the trigger to complete.
--
-- Author:  Brock + Claude (Cowork)
-- Created: 2026-04-24
-- Scope:   ref_markets.master_market_id column (schema drift, second half)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS means this is a no-op on prod.
--
-- Wider drift context (flagged for a future slice):
--   A schema diff run 2026-04-24 found 73 columns in prod that are missing
--   on staging, plus 2 type mismatches:
--     - cost_model_projects.deal_id  (prod=bigint  staging=uuid)
--     - deal_artifacts.artifact_id   (prod=text    staging=uuid)
--   The majority of the 73 are on DOS-framework orphan tables
--   (stages, stage_element_templates, template_versions, projects,
--    opportunity_tasks, deal_qualifications) that the Phase 3 RLS suite
--   does not touch. They are not breaking current workflows, but they ARE
--   real drift that should be reconciled in a dedicated slice. This
--   migration deliberately does NOT try to fix them -- scope for 4.3 is
--   the trigger path only.
--
-- Rollback: ALTER TABLE public.ref_markets DROP COLUMN IF EXISTS master_market_id;
-- =============================================================================

ALTER TABLE public.ref_markets
  ADD COLUMN IF NOT EXISTS master_market_id bigint NULL;

COMMENT ON COLUMN public.ref_markets.master_market_id IS
  'Back-link to master_markets.id populated by trg_provision_market_intel (provision_market_intel fn). Added via Slice 4.3 hygiene migration pt2 to resolve prod/staging drift.';

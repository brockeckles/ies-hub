-- =============================================================================
-- IES Hub — Wave BW (security) — deal_outcomes read alignment with sibling
-- deal-child tables
-- =============================================================================
-- Purpose: RULING (Brock, 2026-07-23): deal_outcomes read visibility must
--   align with its sibling deal-child tables. Live prod today has
--     deal_outcomes_read: ((owner_id = auth.uid()) OR current_user_is_admin())
--   i.e. owner-or-admin only — stricter than every sibling. The freshest
--   sibling, deal_bid_snapshots (20260723120000_p2a_deal_bid_snapshots.sql),
--   reads through the PARENT DEAL's owner/team/shared visibility:
--   owner OR (visibility='team' AND team_id = current_user_team_id())
--   OR visibility='shared' OR current_user_is_admin(). This migration
--   replaces the SELECT policy with that exact expression shape, traversing
--   public.deal_deals via deal_outcomes.deal_id (canonical spelling per
--   shared/deal-fk.js; uuid NOT NULL REFERENCES deal_deals(id)).
--
--   WRITE policies are deliberately UNTOUCHED: deal_outcomes_insert /
--   deal_outcomes_update / deal_outcomes_delete stay row-owner-or-admin
--   (owner_id = auth.uid() OR current_user_is_admin()). Only READ widens.
-- Author:  Brock + Claude (Cowork)
-- Created: 2026-07-23
-- Rollback:
--   drop policy if exists deal_outcomes_read on public.deal_outcomes;
--   create policy deal_outcomes_read on public.deal_outcomes for select
--     using (owner_id = auth.uid() or current_user_is_admin());
-- Idempotent: drop-if-exists + create.
-- =============================================================================

drop policy if exists deal_outcomes_read on public.deal_outcomes;
create policy deal_outcomes_read on public.deal_outcomes for select using (
  exists (select 1 from public.deal_deals d where d.id = deal_outcomes.deal_id and (
    d.owner_id = auth.uid()
    or (d.visibility = 'team'::visibility_level and d.team_id = current_user_team_id())
    or d.visibility = 'shared'::visibility_level
    or current_user_is_admin())));

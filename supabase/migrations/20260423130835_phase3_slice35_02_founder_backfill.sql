-- IES Hub — Phase 3 Slice 3.5 — Migration 02 (founder backfill)
-- Attribute the 24 legacy deal rows to Brock's real uid + Solutions Design team.
-- Visibility stays 'shared' (flipped in Slice 3.3) so the 4 pilots continue to
-- see them. This is the last piece before we can turn the default back to 'team'
-- for genuinely new work.

DO $outer$
DECLARE
  brock_uid uuid := 'db6d16c8-dfcd-4054-9b95-f2e1c304d7a9';
  sd_team_id uuid;
BEGIN
  SELECT id INTO sd_team_id FROM public.teams WHERE name = 'Solutions Design' LIMIT 1;

  UPDATE public.cost_model_projects        SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  UPDATE public.opportunities              SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  UPDATE public.deal_deals                 SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  UPDATE public.fleet_scenarios            SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  UPDATE public.netopt_scenarios           SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  UPDATE public.warehouse_sizing_scenarios SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  UPDATE public.cog_scenarios              SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  UPDATE public.change_initiatives         SET owner_id = brock_uid, team_id = sd_team_id WHERE owner_id IS NULL;
  -- most_analyses has 0 rows

  -- Seed the team's created_by now that we have a founder uid
  UPDATE public.teams SET created_by = brock_uid WHERE name = 'Solutions Design' AND created_by IS NULL;
END $outer$;
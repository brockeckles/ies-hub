-- IES Hub — Phase 3 Slice 3.1 — Migration 02 of 03
-- Add owner_id / team_id / visibility to the 9 root deal-sensitive tables,
-- and user_id to audit_log (closes X15). Additive; new rows default to
-- visibility='team'. Existing rows stay NULL until backfill (migration 03).

-- Table 1: cost_model_projects
ALTER TABLE public.cost_model_projects
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX cost_model_projects_owner_idx ON public.cost_model_projects(owner_id);
CREATE INDEX cost_model_projects_team_idx  ON public.cost_model_projects(team_id);
COMMENT ON COLUMN public.cost_model_projects.owner_id
  IS 'Canonical identity. Supersedes the legacy created_by text column (kept for display compat).';

-- Table 2: opportunities
ALTER TABLE public.opportunities
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX opportunities_owner_idx ON public.opportunities(owner_id);
CREATE INDEX opportunities_team_idx  ON public.opportunities(team_id);

-- Table 3: deal_deals
ALTER TABLE public.deal_deals
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX deal_deals_owner_idx ON public.deal_deals(owner_id);
CREATE INDEX deal_deals_team_idx  ON public.deal_deals(team_id);

-- Table 4: most_analyses (0 rows at migration time)
ALTER TABLE public.most_analyses
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX most_analyses_owner_idx ON public.most_analyses(owner_id);
CREATE INDEX most_analyses_team_idx  ON public.most_analyses(team_id);

-- Table 5: fleet_scenarios
ALTER TABLE public.fleet_scenarios
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX fleet_scenarios_owner_idx ON public.fleet_scenarios(owner_id);
CREATE INDEX fleet_scenarios_team_idx  ON public.fleet_scenarios(team_id);
COMMENT ON COLUMN public.fleet_scenarios.owner_id
  IS 'Canonical identity. Supersedes the legacy created_by text column (kept for display compat).';

-- Table 6: netopt_scenarios
ALTER TABLE public.netopt_scenarios
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX netopt_scenarios_owner_idx ON public.netopt_scenarios(owner_id);
CREATE INDEX netopt_scenarios_team_idx  ON public.netopt_scenarios(team_id);

-- Table 7: warehouse_sizing_scenarios
ALTER TABLE public.warehouse_sizing_scenarios
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX warehouse_sizing_scenarios_owner_idx ON public.warehouse_sizing_scenarios(owner_id);
CREATE INDEX warehouse_sizing_scenarios_team_idx  ON public.warehouse_sizing_scenarios(team_id);

-- Table 8: cog_scenarios
ALTER TABLE public.cog_scenarios
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX cog_scenarios_owner_idx ON public.cog_scenarios(owner_id);
CREATE INDEX cog_scenarios_team_idx  ON public.cog_scenarios(team_id);

-- Table 9: change_initiatives
ALTER TABLE public.change_initiatives
  ADD COLUMN owner_id   uuid                    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN team_id    uuid                    REFERENCES public.teams(id) ON DELETE SET NULL,
  ADD COLUMN visibility public.visibility_level NOT NULL DEFAULT 'team';
CREATE INDEX change_initiatives_owner_idx ON public.change_initiatives(owner_id);
CREATE INDEX change_initiatives_team_idx  ON public.change_initiatives(team_id);

-- audit_log.user_id (closes X15)
ALTER TABLE public.audit_log
  ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX audit_log_user_idx ON public.audit_log(user_id);
COMMENT ON COLUMN public.audit_log.user_id
  IS 'Canonical identity of the actor. Populated from auth.uid() when a session exists. user_email is retained for display.';
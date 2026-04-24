ALTER TABLE public.netopt_configs
  ADD COLUMN IF NOT EXISTS owner_id   UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS team_id    UUID REFERENCES public.teams(id),
  ADD COLUMN IF NOT EXISTS visibility public.visibility_level NOT NULL DEFAULT 'private';

UPDATE public.netopt_configs
SET owner_id   = 'db6d16c8-dfcd-4054-9b95-f2e1c304d7a9'::uuid,
    team_id    = 'd3e79133-18e5-4441-8b57-84920385cd8d'::uuid,
    visibility = 'team'
WHERE owner_id IS NULL;

DROP POLICY IF EXISTS netopt_configs_rw_authed ON public.netopt_configs;

CREATE POLICY netopt_configs_read ON public.netopt_configs
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR (visibility = 'team'::public.visibility_level AND team_id = public.current_user_team_id())
    OR visibility = 'shared'::public.visibility_level
    OR public.current_user_is_admin()
  );

CREATE POLICY netopt_configs_insert ON public.netopt_configs
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY netopt_configs_update ON public.netopt_configs
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.current_user_is_admin());

CREATE POLICY netopt_configs_delete ON public.netopt_configs
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin());

DROP POLICY IF EXISTS netopt_scenario_results_rw_authed ON public.netopt_scenario_results;

CREATE POLICY netopt_scenario_results_rw ON public.netopt_scenario_results
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.netopt_configs parent
      WHERE parent.id = netopt_scenario_results.config_id
        AND (
          parent.owner_id = auth.uid()
          OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
          OR parent.visibility = 'shared'::public.visibility_level
          OR public.current_user_is_admin()
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.netopt_configs parent
      WHERE parent.id = netopt_scenario_results.config_id
        AND (
          parent.owner_id = auth.uid()
          OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
          OR parent.visibility = 'shared'::public.visibility_level
          OR public.current_user_is_admin()
        )
    )
  );

ALTER TABLE public.wsc_facility_configs
  ADD COLUMN IF NOT EXISTS owner_id   UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS team_id    UUID REFERENCES public.teams(id),
  ADD COLUMN IF NOT EXISTS visibility public.visibility_level NOT NULL DEFAULT 'private';

UPDATE public.wsc_facility_configs
SET owner_id   = 'db6d16c8-dfcd-4054-9b95-f2e1c304d7a9'::uuid,
    team_id    = 'd3e79133-18e5-4441-8b57-84920385cd8d'::uuid,
    visibility = 'team'
WHERE owner_id IS NULL;

DROP POLICY IF EXISTS wsc_facility_configs_rw_authed ON public.wsc_facility_configs;

CREATE POLICY wsc_facility_configs_read ON public.wsc_facility_configs
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR (visibility = 'team'::public.visibility_level AND team_id = public.current_user_team_id())
    OR visibility = 'shared'::public.visibility_level
    OR public.current_user_is_admin()
  );

CREATE POLICY wsc_facility_configs_insert ON public.wsc_facility_configs
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY wsc_facility_configs_update ON public.wsc_facility_configs
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.current_user_is_admin());

CREATE POLICY wsc_facility_configs_delete ON public.wsc_facility_configs
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.current_user_is_admin());
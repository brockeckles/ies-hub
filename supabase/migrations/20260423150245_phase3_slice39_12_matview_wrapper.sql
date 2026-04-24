CREATE OR REPLACE FUNCTION public.get_pnl_monthly(p_project_id BIGINT)
RETURNS SETOF public.fact_pnl_monthly
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
STABLE
AS $$
  SELECT f.*
  FROM public.fact_pnl_monthly f
  WHERE f.project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM public.cost_model_projects p
      WHERE p.id = f.project_id
        AND (
          p.owner_id = auth.uid()
          OR (p.visibility = 'team'::public.visibility_level AND p.team_id = public.current_user_team_id())
          OR p.visibility = 'shared'::public.visibility_level
          OR public.current_user_is_admin()
        )
    )
  ORDER BY f.period_index ASC;
$$;

REVOKE ALL ON FUNCTION public.get_pnl_monthly(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pnl_monthly(BIGINT) TO authenticated;

REVOKE SELECT ON public.fact_pnl_monthly FROM anon, authenticated;
-- Backfill migration (2026-07-02) — source-of-truth for Phase 2/4 objects.
--
-- The 2026-07-02 assessment found that the Phase 2 asset-master tables, the
-- fact_labor/capital_monthly materialized views, and their scoped RPCs were
-- created directly on prod+staging but never captured in a committed
-- migration (repo HEAD 6b74758 stops at 20260611231500). This file records
-- the live definitions verbatim so the repo is the source of truth and an
-- IT reviewer / a fresh Cloud SQL rebuild gets the exact same schema + RLS.
--
-- It is written idempotently (IF NOT EXISTS / OR REPLACE) so it is a no-op on
-- the databases where these objects already exist, and creates them cleanly
-- on a fresh instance. Definitions captured from prod (dklnwcshrpamzsybjlzb).

-- ========================================================================
-- 1. cost_model_asset_instances
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.cost_model_asset_instances (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id          bigint  NOT NULL REFERENCES public.cost_model_projects(id) ON DELETE CASCADE,
  equipment_line_id   text,
  asset_ref_id        uuid    REFERENCES public.ref_equipment(id),
  name                text    NOT NULL,
  category            text,
  quantity            numeric NOT NULL DEFAULT 1,
  unit_cost           numeric NOT NULL DEFAULT 0,
  contingency_pct     numeric NOT NULL DEFAULT 0,
  freight_pct         numeric NOT NULL DEFAULT 0,
  tax_pct             numeric NOT NULL DEFAULT 0,
  allowances_pct      numeric NOT NULL DEFAULT 0,
  loaded_unit_cost    numeric,
  total_loaded_cost   numeric,
  financing_type      text    NOT NULL DEFAULT 'capital'
                        CHECK (financing_type = ANY (ARRAY['capital','lease','ti','service','pass_through'])),
  amort_method        text    NOT NULL DEFAULT 'straight_line'
                        CHECK (amort_method = ANY (ARRAY['straight_line','declining_balance'])),
  useful_life_months  integer NOT NULL DEFAULT 60,
  residual_value      numeric NOT NULL DEFAULT 0,
  go_live_period_id   bigint  REFERENCES public.ref_periods(id),
  retire_period_id    bigint  REFERENCES public.ref_periods(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_model_asset_instances_project_id_idx
  ON public.cost_model_asset_instances USING btree (project_id);

ALTER TABLE public.cost_model_asset_instances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_model_asset_instances_rw ON public.cost_model_asset_instances;
CREATE POLICY cost_model_asset_instances_rw ON public.cost_model_asset_instances
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cost_model_projects parent
    WHERE parent.id = cost_model_asset_instances.project_id
      AND (parent.owner_id = auth.uid()
        OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
        OR parent.visibility = 'shared'::public.visibility_level
        OR public.current_user_is_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cost_model_projects parent
    WHERE parent.id = cost_model_asset_instances.project_id
      AND (parent.owner_id = auth.uid()
        OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
        OR parent.visibility = 'shared'::public.visibility_level
        OR public.current_user_is_admin())));

-- ========================================================================
-- 2. cost_model_depreciation_schedules
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.cost_model_depreciation_schedules (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id                bigint  NOT NULL REFERENCES public.cost_model_projects(id) ON DELETE CASCADE,
  asset_instance_id         bigint  NOT NULL REFERENCES public.cost_model_asset_instances(id) ON DELETE CASCADE,
  period_id                 bigint  NOT NULL REFERENCES public.ref_periods(id),
  depreciation_amount       numeric NOT NULL DEFAULT 0,
  accumulated_depreciation  numeric NOT NULL DEFAULT 0,
  book_value                numeric NOT NULL DEFAULT 0,
  UNIQUE (asset_instance_id, period_id)
);
CREATE INDEX IF NOT EXISTS cost_model_depreciation_schedules_project_id_idx
  ON public.cost_model_depreciation_schedules USING btree (project_id);

ALTER TABLE public.cost_model_depreciation_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_model_depreciation_schedules_rw ON public.cost_model_depreciation_schedules;
CREATE POLICY cost_model_depreciation_schedules_rw ON public.cost_model_depreciation_schedules
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cost_model_projects parent
    WHERE parent.id = cost_model_depreciation_schedules.project_id
      AND (parent.owner_id = auth.uid()
        OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
        OR parent.visibility = 'shared'::public.visibility_level
        OR public.current_user_is_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cost_model_projects parent
    WHERE parent.id = cost_model_depreciation_schedules.project_id
      AND (parent.owner_id = auth.uid()
        OR (parent.visibility = 'team'::public.visibility_level AND parent.team_id = public.current_user_team_id())
        OR parent.visibility = 'shared'::public.visibility_level
        OR public.current_user_is_admin())));

-- ========================================================================
-- 3. fact_labor_monthly (materialized view) + scoped RPC
-- ========================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.fact_labor_monthly AS
 SELECT e.project_id, e.period_id, rp.period_index, rp.calendar_year, rp.calendar_month,
    e.expense_line_code, cl.role_name, cl.role_category, cl.shift_num, p.market_id,
    sum(e.amount) AS amount
   FROM public.cost_model_expense_monthly e
     JOIN public.ref_expense_lines el ON el.code = e.expense_line_code
     JOIN public.ref_periods rp ON rp.id = e.period_id
     JOIN public.cost_model_projects p ON p.id = e.project_id
     LEFT JOIN public.cost_model_labor cl ON e.source_line_table = 'cost_model_labor' AND e.source_line_id = cl.id
  WHERE e.expense_line_code = ANY (ARRAY['LABOR_HOURLY','LABOR_SALARY'])
  GROUP BY e.project_id, e.period_id, rp.period_index, rp.calendar_year, rp.calendar_month,
    e.expense_line_code, cl.role_name, cl.role_category, cl.shift_num, p.market_id;

-- MV is not directly selectable by app roles; access is only via the
-- SECURITY DEFINER wrapper below, which re-checks project ownership.
REVOKE SELECT ON public.fact_labor_monthly FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_labor_monthly(p_project_id bigint)
 RETURNS SETOF public.fact_labor_monthly
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select f.* from public.fact_labor_monthly f
  where f.project_id = p_project_id
    and exists (
      select 1 from public.cost_model_projects p
      where p.id = f.project_id
        and (p.owner_id = auth.uid()
          or (p.visibility = 'team'::public.visibility_level and p.team_id = public.current_user_team_id())
          or p.visibility = 'shared'::public.visibility_level
          or public.current_user_is_admin())
    )
  order by f.period_index asc;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_labor_monthly(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_labor_monthly(bigint) TO authenticated;

-- ========================================================================
-- 4. fact_capital_monthly (materialized view) + scoped RPC
-- ========================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.fact_capital_monthly AS
 SELECT d.project_id, d.period_id, rp.period_index, rp.calendar_year, rp.calendar_month,
    COALESCE(a.category, 'Uncategorized') AS asset_category, a.financing_type,
    sum(CASE WHEN d.period_id = a.go_live_period_id THEN a.total_loaded_cost ELSE 0::numeric END) AS capex,
    sum(d.depreciation_amount) AS depreciation,
    sum(d.book_value) AS book_value
   FROM public.cost_model_depreciation_schedules d
     JOIN public.cost_model_asset_instances a ON a.id = d.asset_instance_id
     JOIN public.ref_periods rp ON rp.id = d.period_id
  GROUP BY d.project_id, d.period_id, rp.period_index, rp.calendar_year, rp.calendar_month,
    (COALESCE(a.category, 'Uncategorized')), a.financing_type;

REVOKE SELECT ON public.fact_capital_monthly FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_capital_monthly(p_project_id bigint)
 RETURNS SETOF public.fact_capital_monthly
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select f.* from public.fact_capital_monthly f
  where f.project_id = p_project_id
    and exists (
      select 1 from public.cost_model_projects p
      where p.id = f.project_id
        and (p.owner_id = auth.uid()
          or (p.visibility = 'team'::public.visibility_level and p.team_id = public.current_user_team_id())
          or p.visibility = 'shared'::public.visibility_level
          or public.current_user_is_admin())
    )
  order by f.period_index asc;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_capital_monthly(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_capital_monthly(bigint) TO authenticated;

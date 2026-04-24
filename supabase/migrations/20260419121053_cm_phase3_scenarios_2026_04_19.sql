
-- =========================================================================
-- Phase 3 — Scenarios + SCD rate snapshots + Revision log
-- =========================================================================

-- ---------- 1. Scenarios table ----------
CREATE TABLE IF NOT EXISTS public.cost_model_scenarios (
  id                    bigserial PRIMARY KEY,
  deal_id               uuid REFERENCES public.deal_deals(id) ON DELETE SET NULL,
  project_id            bigint UNIQUE REFERENCES public.cost_model_projects(id) ON DELETE CASCADE,
  parent_scenario_id    bigint REFERENCES public.cost_model_scenarios(id) ON DELETE SET NULL,
  scenario_label        text NOT NULL DEFAULT 'Baseline',
  scenario_description  text,
  is_baseline           boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','review','approved','archived')),
  approved_at           timestamptz,
  approved_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cm_scenarios_deal    ON public.cost_model_scenarios(deal_id);
CREATE INDEX IF NOT EXISTS idx_cm_scenarios_project ON public.cost_model_scenarios(project_id);
CREATE INDEX IF NOT EXISTS idx_cm_scenarios_status  ON public.cost_model_scenarios(status);
CREATE INDEX IF NOT EXISTS idx_cm_scenarios_parent  ON public.cost_model_scenarios(parent_scenario_id);

ALTER TABLE public.cost_model_scenarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cm_scenarios_rw ON public.cost_model_scenarios;
CREATE POLICY cm_scenarios_rw ON public.cost_model_scenarios FOR ALL
  USING (true) WITH CHECK (true);

-- ---------- 2. Rate snapshots table ----------
CREATE TABLE IF NOT EXISTS public.cost_model_rate_snapshots (
  id                      bigserial PRIMARY KEY,
  scenario_id             bigint NOT NULL REFERENCES public.cost_model_scenarios(id) ON DELETE CASCADE,
  rate_card_type          text NOT NULL
                          CHECK (rate_card_type IN ('labor','facility','utility','equipment','overhead','pricing_assumptions','periods')),
  rate_card_id            text NOT NULL,
  rate_card_version_hash  text NOT NULL,
  snapshot_json           jsonb NOT NULL,
  captured_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, rate_card_type, rate_card_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_rate_snap_scen ON public.cost_model_rate_snapshots(scenario_id);
CREATE INDEX IF NOT EXISTS idx_cm_rate_snap_type ON public.cost_model_rate_snapshots(rate_card_type);

ALTER TABLE public.cost_model_rate_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cm_rate_snap_rw ON public.cost_model_rate_snapshots;
CREATE POLICY cm_rate_snap_rw ON public.cost_model_rate_snapshots FOR ALL
  USING (true) WITH CHECK (true);

-- ---------- 3. Revisions (append-only log) ----------
CREATE TABLE IF NOT EXISTS public.cost_model_revisions (
  id              bigserial PRIMARY KEY,
  scenario_id     bigint NOT NULL REFERENCES public.cost_model_scenarios(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      text,
  change_summary  text,
  inputs_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (scenario_id, revision_number)
);
CREATE INDEX IF NOT EXISTS idx_cm_rev_scen ON public.cost_model_revisions(scenario_id);
CREATE INDEX IF NOT EXISTS idx_cm_rev_at   ON public.cost_model_revisions(changed_at DESC);

ALTER TABLE public.cost_model_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cm_rev_rw ON public.cost_model_revisions;
CREATE POLICY cm_rev_rw ON public.cost_model_revisions FOR ALL
  USING (true) WITH CHECK (true);

-- ---------- 4. Add SCD + effective_date columns to rate tables ----------
-- ref_overhead_rates didn't have effective_date at all; add it.
ALTER TABLE public.ref_overhead_rates
  ADD COLUMN IF NOT EXISTS effective_date date DEFAULT CURRENT_DATE;

-- ref_equipment didn't have effective_date either; add it.
ALTER TABLE public.ref_equipment
  ADD COLUMN IF NOT EXISTS effective_date date DEFAULT CURRENT_DATE;

-- Now SCD cols on all 5 rate tables
ALTER TABLE public.ref_labor_rates
  ADD COLUMN IF NOT EXISTS effective_end_date date NOT NULL DEFAULT DATE '9999-12-31',
  ADD COLUMN IF NOT EXISTS version_hash text,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid REFERENCES public.ref_labor_rates(id) ON DELETE SET NULL;

ALTER TABLE public.ref_facility_rates
  ADD COLUMN IF NOT EXISTS effective_end_date date NOT NULL DEFAULT DATE '9999-12-31',
  ADD COLUMN IF NOT EXISTS version_hash text,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid REFERENCES public.ref_facility_rates(id) ON DELETE SET NULL;

ALTER TABLE public.ref_utility_rates
  ADD COLUMN IF NOT EXISTS effective_end_date date NOT NULL DEFAULT DATE '9999-12-31',
  ADD COLUMN IF NOT EXISTS version_hash text,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid REFERENCES public.ref_utility_rates(id) ON DELETE SET NULL;

ALTER TABLE public.ref_overhead_rates
  ADD COLUMN IF NOT EXISTS effective_end_date date NOT NULL DEFAULT DATE '9999-12-31',
  ADD COLUMN IF NOT EXISTS version_hash text,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid REFERENCES public.ref_overhead_rates(id) ON DELETE SET NULL;

ALTER TABLE public.ref_equipment
  ADD COLUMN IF NOT EXISTS effective_end_date date NOT NULL DEFAULT DATE '9999-12-31',
  ADD COLUMN IF NOT EXISTS version_hash text,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid REFERENCES public.ref_equipment(id) ON DELETE SET NULL;

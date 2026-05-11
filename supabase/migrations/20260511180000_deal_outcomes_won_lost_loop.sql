-- 2026-05-11 — Deal Outcomes (the "won-deal learning loop")
--
-- Captures what actually happened after a deal was bid: did we win, lose, or
-- withdraw? Why? What were the actuals vs. our estimate? Six months of this
-- data is the single most valuable input to the future calibration coach
-- and benchmark library.
--
-- One row per deal. Optional link back to the cost_model_projects row that
-- carried the estimate (when known); deal_deals link is required.
--
-- Schema-first: the UI to capture this can come later. For the first 6
-- months, an admin user populates rows manually via the Supabase studio or
-- a thin Admin form.
--
-- Owner: brockeckles@gmail.com (port-readiness sprint, S8).

CREATE TABLE IF NOT EXISTS public.deal_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Required: the deal this outcome describes.
  deal_id uuid NOT NULL REFERENCES public.deal_deals(id) ON DELETE CASCADE,

  -- Optional: the cost-model project that carried the estimate. Bigint to
  -- match cost_model_projects.id (BIGSERIAL). When set, the calibration
  -- coach can compare actuals to the project_data snapshot at bid time.
  cost_model_project_id bigint REFERENCES public.cost_model_projects(id) ON DELETE SET NULL,

  -- What happened.
  outcome text NOT NULL CHECK (outcome IN ('won','lost','withdrawn','no_decision')),

  -- Why it happened. reason_category is a structured bucket; reason_detail
  -- is free-text for the nuance.
  reason_category text CHECK (reason_category IN (
    'price','service_level','geography','incumbent_relationship',
    'capability_gap','timing','political','undisclosed','other'
  )),
  reason_detail text,

  -- For losses: who won, if known.
  competitor_won_to text,

  -- The won-deal learning loop. These columns are nullable because Y1
  -- actuals don't exist until the deal has been live for a year.
  go_live_date date,
  actual_y1_revenue numeric,
  actual_y1_cost numeric,
  actual_y1_margin_pct numeric,   -- redundant but cached for fast benchmark queries

  -- Variance vs. bid (signed). Nullable until populated.
  bid_y1_revenue numeric,
  bid_y1_cost numeric,
  bid_y1_margin_pct numeric,

  -- Lifecycle.
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Free-form notes (post-mortem highlights, lessons learned).
  notes text,

  -- For multi-tenancy / RLS — mirrors the owner_id pattern used elsewhere.
  owner_id uuid NOT NULL DEFAULT auth.uid()
);

-- Useful indices for the future calibration coach + benchmark library.
CREATE INDEX IF NOT EXISTS deal_outcomes_deal_id_idx ON public.deal_outcomes(deal_id);
CREATE INDEX IF NOT EXISTS deal_outcomes_cm_project_id_idx ON public.deal_outcomes(cost_model_project_id);
CREATE INDEX IF NOT EXISTS deal_outcomes_outcome_idx ON public.deal_outcomes(outcome);
CREATE INDEX IF NOT EXISTS deal_outcomes_owner_id_idx ON public.deal_outcomes(owner_id);
CREATE INDEX IF NOT EXISTS deal_outcomes_recorded_at_idx ON public.deal_outcomes(recorded_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public._deal_outcomes_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_outcomes_touch_updated_at ON public.deal_outcomes;
CREATE TRIGGER deal_outcomes_touch_updated_at
BEFORE UPDATE ON public.deal_outcomes
FOR EACH ROW EXECUTE FUNCTION public._deal_outcomes_touch_updated_at();

-- Audit columns: track who created and who last modified the row.
COMMENT ON TABLE public.deal_outcomes IS
  'Captured win/lose outcomes + Y1 actuals for the IES won-deal learning loop. Populated manually until the capture UI ships.';

-- RLS — pattern matches deal_artifacts / deal_strategy: owner or admin
-- can read/write; non-owners cannot see another team''s deal outcomes.
ALTER TABLE public.deal_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY deal_outcomes_read ON public.deal_outcomes FOR SELECT
USING (owner_id = auth.uid() OR current_user_is_admin());

CREATE POLICY deal_outcomes_insert ON public.deal_outcomes FOR INSERT
WITH CHECK (owner_id = auth.uid() OR current_user_is_admin());

CREATE POLICY deal_outcomes_update ON public.deal_outcomes FOR UPDATE
USING (owner_id = auth.uid() OR current_user_is_admin())
WITH CHECK (owner_id = auth.uid() OR current_user_is_admin());

CREATE POLICY deal_outcomes_delete ON public.deal_outcomes FOR DELETE
USING (owner_id = auth.uid() OR current_user_is_admin());

-- Convenience view for the future calibration coach: joins outcomes back to
-- the cost-model snapshot fields the coach will compare to actuals.
CREATE OR REPLACE VIEW public.deal_outcomes_enriched AS
SELECT
  o.id,
  o.deal_id,
  d.deal_name,
  o.cost_model_project_id,
  cm.name AS cost_model_name,
  o.outcome,
  o.reason_category,
  o.reason_detail,
  o.competitor_won_to,
  o.go_live_date,
  o.actual_y1_revenue,
  o.actual_y1_cost,
  o.actual_y1_margin_pct,
  o.bid_y1_revenue,
  o.bid_y1_cost,
  o.bid_y1_margin_pct,
  CASE WHEN o.bid_y1_cost > 0 AND o.actual_y1_cost IS NOT NULL
       THEN (o.actual_y1_cost - o.bid_y1_cost) / o.bid_y1_cost * 100
       ELSE NULL END                                     AS y1_cost_variance_pct,
  CASE WHEN o.bid_y1_revenue > 0 AND o.actual_y1_revenue IS NOT NULL
       THEN (o.actual_y1_revenue - o.bid_y1_revenue) / o.bid_y1_revenue * 100
       ELSE NULL END                                     AS y1_revenue_variance_pct,
  o.notes,
  o.recorded_at,
  o.recorded_by,
  o.updated_at
FROM public.deal_outcomes o
LEFT JOIN public.deal_deals d           ON d.id = o.deal_id
LEFT JOIN public.cost_model_projects cm ON cm.id = o.cost_model_project_id;

GRANT SELECT ON public.deal_outcomes_enriched TO authenticated;

COMMENT ON VIEW public.deal_outcomes_enriched IS
  'Outcomes joined to deal + cost-model names, with bid-vs-actual variance percentages pre-computed for the calibration coach + benchmark library.';

-- ============================================================
-- 2026-04-29 — Deal Management persistence
-- ============================================================
-- Brock 2026-04-29: move three concerns from in-memory Maps in
-- hub/deal-management/ui.js to durable storage:
--   1. Win Strategy (per-deal narrative + risks + asks + diffs)
--   2. Linked Artifacts (per-deal list of cost models, designs, etc.)
--   3. DOS element status (per-deal per-element progress)
--
-- RLS pattern mirrors deal_deals — every read/write must traverse
-- the parent deal's owner_id / team_id / visibility chain. Using
-- EXISTS(SELECT 1 FROM deal_deals WHERE id = deal_id AND <access>)
-- keeps the access logic in one place.
--
-- Out-of-band: dropped legacy public.deal_artifacts table (had 2
-- rows of stale demo data linked to public.opportunities, never
-- integrated with the current deal_deals system).
-- ============================================================

DROP TABLE IF EXISTS public.deal_artifacts CASCADE;

-- ---------- 1) deal_strategy (1:1 with deal_deals) ----------
CREATE TABLE IF NOT EXISTS public.deal_strategy (
  id                  bigserial PRIMARY KEY,
  deal_id             uuid NOT NULL UNIQUE
                      REFERENCES public.deal_deals(id) ON DELETE CASCADE,
  value_prop          text DEFAULT '',
  risks               jsonb NOT NULL DEFAULT '[]'::jsonb,
  asks                jsonb NOT NULL DEFAULT '[]'::jsonb,
  differentiators     jsonb NOT NULL DEFAULT '[]'::jsonb,
  competitor_threats  text DEFAULT '',
  updated_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_strategy ENABLE ROW LEVEL SECURITY;

CREATE POLICY deal_strategy_read ON public.deal_strategy FOR SELECT
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_strategy.deal_id
  AND (d.owner_id = auth.uid()
    OR (d.visibility = 'team'::visibility_level AND d.team_id = current_user_team_id())
    OR d.visibility = 'shared'::visibility_level OR current_user_is_admin())));
CREATE POLICY deal_strategy_insert ON public.deal_strategy FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_strategy.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));
CREATE POLICY deal_strategy_update ON public.deal_strategy FOR UPDATE
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_strategy.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())))
WITH CHECK (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_strategy.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));
CREATE POLICY deal_strategy_delete ON public.deal_strategy FOR DELETE
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_strategy.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));

-- ---------- 2) deal_artifacts (N per deal) ----------
CREATE TABLE public.deal_artifacts (
  id            bigserial PRIMARY KEY,
  deal_id       uuid NOT NULL REFERENCES public.deal_deals(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  name          text NOT NULL,
  ref           text,
  model_id      bigint,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_deal_artifacts_deal ON public.deal_artifacts(deal_id);
ALTER TABLE public.deal_artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY deal_artifacts_read ON public.deal_artifacts FOR SELECT
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_artifacts.deal_id
  AND (d.owner_id = auth.uid()
    OR (d.visibility = 'team'::visibility_level AND d.team_id = current_user_team_id())
    OR d.visibility = 'shared'::visibility_level OR current_user_is_admin())));
CREATE POLICY deal_artifacts_insert ON public.deal_artifacts FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_artifacts.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));
CREATE POLICY deal_artifacts_update ON public.deal_artifacts FOR UPDATE
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_artifacts.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())))
WITH CHECK (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_artifacts.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));
CREATE POLICY deal_artifacts_delete ON public.deal_artifacts FOR DELETE
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_artifacts.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));

-- ---------- 3) deal_dos_status (per-element, per-deal) ----------
CREATE TABLE IF NOT EXISTS public.deal_dos_status (
  id            bigserial PRIMARY KEY,
  deal_id       uuid NOT NULL REFERENCES public.deal_deals(id) ON DELETE CASCADE,
  element_id    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('not-started', 'in-progress', 'complete')),
  updated_by    uuid REFERENCES auth.users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, element_id)
);
CREATE INDEX idx_deal_dos_status_deal ON public.deal_dos_status(deal_id);
ALTER TABLE public.deal_dos_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY deal_dos_status_read ON public.deal_dos_status FOR SELECT
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_dos_status.deal_id
  AND (d.owner_id = auth.uid()
    OR (d.visibility = 'team'::visibility_level AND d.team_id = current_user_team_id())
    OR d.visibility = 'shared'::visibility_level OR current_user_is_admin())));
CREATE POLICY deal_dos_status_insert ON public.deal_dos_status FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_dos_status.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));
CREATE POLICY deal_dos_status_update ON public.deal_dos_status FOR UPDATE
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_dos_status.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())))
WITH CHECK (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_dos_status.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));
CREATE POLICY deal_dos_status_delete ON public.deal_dos_status FOR DELETE
USING (EXISTS (SELECT 1 FROM public.deal_deals d WHERE d.id = deal_dos_status.deal_id
  AND (d.owner_id = auth.uid() OR current_user_is_admin())));

-- ---------- 4) updated_at triggers ----------
CREATE OR REPLACE FUNCTION public._dm_persist_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = '';

DROP TRIGGER IF EXISTS deal_strategy_touch ON public.deal_strategy;
CREATE TRIGGER deal_strategy_touch BEFORE UPDATE ON public.deal_strategy
FOR EACH ROW EXECUTE FUNCTION public._dm_persist_touch_updated_at();

DROP TRIGGER IF EXISTS deal_artifacts_touch ON public.deal_artifacts;
CREATE TRIGGER deal_artifacts_touch BEFORE UPDATE ON public.deal_artifacts
FOR EACH ROW EXECUTE FUNCTION public._dm_persist_touch_updated_at();

DROP TRIGGER IF EXISTS deal_dos_status_touch ON public.deal_dos_status;
CREATE TRIGGER deal_dos_status_touch BEFORE UPDATE ON public.deal_dos_status
FOR EACH ROW EXECUTE FUNCTION public._dm_persist_touch_updated_at();

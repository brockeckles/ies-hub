-- Custom feature/usage events for v3 analytics. Pairs with existing
-- analytics_sessions + analytics_page_views (which v2 already wrote to).
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb,
  session_id text,
  session_started_at timestamptz,
  route text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON public.analytics_events(event);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON public.analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON public.analytics_events(created_at DESC);

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "analytics_events_public" ON public.analytics_events;
CREATE POLICY "analytics_events_public" ON public.analytics_events
  FOR ALL USING (true) WITH CHECK (true);

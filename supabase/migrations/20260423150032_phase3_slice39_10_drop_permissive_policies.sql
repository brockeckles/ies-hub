-- phase3_slice39_10_drop_permissive_policies
-- See migrations/phase3_slice39_10_drop_permissive_policies.sql for full commentary.

DROP POLICY IF EXISTS analytics_events_public ON public.analytics_events;
CREATE POLICY analytics_events_insert_anyone ON public.analytics_events
  FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY analytics_events_read_admin ON public.analytics_events
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

DROP POLICY IF EXISTS "Allow anonymous update on analytics_page_views" ON public.analytics_page_views;
DROP POLICY IF EXISTS "Allow anonymous update on analytics_sessions" ON public.analytics_sessions;
DROP POLICY IF EXISTS hub_feedback_update_authed ON public.hub_feedback;
DROP POLICY IF EXISTS general_hours_rw_authed ON public.general_hours;

DROP POLICY IF EXISTS "Authenticated users can delete project_elements" ON public.project_elements;
DROP POLICY IF EXISTS "Authenticated users can insert project_elements" ON public.project_elements;
DROP POLICY IF EXISTS "Authenticated users can update project_elements" ON public.project_elements;
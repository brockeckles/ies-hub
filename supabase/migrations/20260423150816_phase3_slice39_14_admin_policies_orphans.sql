CREATE POLICY general_hours_admin_rw ON public.general_hours
  FOR ALL TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());
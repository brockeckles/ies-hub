-- Phase 3 Slice 3.8 Migration 08 — enable RLS on 5 master/ref tables with Class A pattern
BEGIN;

DO $$
DECLARE
  t text;
  p text;
  slice38_tables text[] := ARRAY[
    'master_accounts','master_competitors','master_markets',
    'master_verticals','ref_multisite_grade_thresholds'
  ];
BEGIN
  FOREACH t IN ARRAY slice38_tables LOOP
    FOR p IN
      SELECT policyname FROM pg_policies
       WHERE schemaname='public' AND tablename=t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_read_authed', t
    );

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated ' ||
      'USING (public.current_user_is_admin()) ' ||
      'WITH CHECK (public.current_user_is_admin())',
      t || '_admin_write', t
    );
  END LOOP;
END $$;

COMMIT;
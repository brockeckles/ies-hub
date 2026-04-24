CREATE TABLE IF NOT EXISTS public.audit_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  entity_table text NOT NULL,
  entity_id text,
  action text NOT NULL CHECK (action IN ('insert','update','delete','link','unlink')),
  changed_fields jsonb,
  session_id text,
  user_email text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON public.audit_log(entity_table, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON public.audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_session_idx ON public.audit_log(session_id);
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='audit_log' AND policyname='read_all') THEN
    CREATE POLICY read_all ON public.audit_log FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='audit_log' AND policyname='insert_all') THEN
    CREATE POLICY insert_all ON public.audit_log FOR INSERT WITH CHECK (true);
  END IF;
END $$;
COMMENT ON TABLE public.audit_log IS
  'Immutable audit trail of mutations across all tools. entity_id is text to accommodate uuid/bigint/string-keyed tables. session_id ties rows from one browser session until we wire real user auth (X15 phase 2).';
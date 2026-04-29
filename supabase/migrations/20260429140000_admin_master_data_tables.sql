-- ============================================================
-- 2026-04-29 — Admin master data tables
-- ============================================================
-- Brock 2026-04-29: 'several Admin tables not mapped to hub contents,
-- e.g. customers + competitors. Plus need edit/add/delete on all.'
--
-- Create the 7 missing reference tables with simple schemas + RLS
-- (read for any authenticated user, write for admins only).
-- Seed accounts from deal_deals.client_name distinct values and
-- competitors from competitor_news.competitor distinct so first
-- view of the Admin tables shows real data.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL UNIQUE,
  vertical text,
  region text,
  revenue_tier text,
  priority_tier text CHECK (priority_tier IN ('A','B','C') OR priority_tier IS NULL),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  parent_company text,
  region_focus text,
  segment_focus text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.verticals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.master_cost_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  category text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.master_vehicle_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  capacity_lbs numeric,
  mpg numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.master_escalation_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  pct numeric NOT NULL,
  effective_year int,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.master_sccs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  category text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: read-all-authenticated, write-admins-only
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['accounts','competitors','verticals',
                                'master_cost_buckets','master_vehicle_types',
                                'master_escalation_rates','master_sccs'])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_write ON public.%I FOR ALL TO authenticated USING (current_user_is_admin()) WITH CHECK (current_user_is_admin())', t, t);
  END LOOP;
END $$;

-- updated_at triggers
CREATE OR REPLACE FUNCTION public._admin_master_touch()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = '';

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['accounts','competitors','verticals',
                                'master_cost_buckets','master_vehicle_types',
                                'master_escalation_rates','master_sccs'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public._admin_master_touch()', t, t);
  END LOOP;
END $$;

-- Seed: accounts from distinct deal_deals.client_name
INSERT INTO public.accounts (company_name, notes)
SELECT DISTINCT TRIM(client_name), 'auto-imported from deal_deals 2026-04-29'
FROM public.deal_deals
WHERE client_name IS NOT NULL AND TRIM(client_name) <> ''
ON CONFLICT (company_name) DO NOTHING;

-- Seed: competitors from distinct competitor_news.competitor
INSERT INTO public.competitors (name, notes)
SELECT DISTINCT TRIM(competitor), 'auto-imported from competitor_news 2026-04-29'
FROM public.competitor_news
WHERE competitor IS NOT NULL AND TRIM(competitor) <> ''
ON CONFLICT (name) DO NOTHING;

-- Seed: starter verticals (common 3PL segments)
INSERT INTO public.verticals (code, label, description) VALUES
  ('retail',     'Retail',         'Brick-and-mortar + omnichannel retail'),
  ('ecommerce',  'E-Commerce',     'Pure-play and DTC e-commerce'),
  ('cpg',        'CPG',            'Consumer packaged goods'),
  ('fnb',        'Food & Beverage','Cold chain, ambient, and beverage distribution'),
  ('automotive', 'Automotive',     'OEM aftermarket + dealer logistics'),
  ('apparel',    'Apparel',        'Apparel + fashion'),
  ('healthcare', 'Healthcare',     'Pharma, medical devices'),
  ('industrial', 'Industrial',     'Industrial / manufacturing'),
  ('technology', 'Technology',     'Tech, electronics'),
  ('pharma',     'Pharma',         'Pharmaceutical and biotech')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ref_fleet_carrier_rates (
  id bigserial PRIMARY KEY,
  vehicle_type text NOT NULL UNIQUE,
  display_name text NOT NULL,
  base_rate_per_mile numeric NOT NULL DEFAULT 3.00,
  fuel_surcharge_pct numeric NOT NULL DEFAULT 0.00,
  min_charge numeric NOT NULL DEFAULT 0.00,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.ref_fleet_carrier_rates (vehicle_type, display_name, base_rate_per_mile, fuel_surcharge_pct, min_charge, notes)
VALUES
  ('dry-van',  'Dry Van (53'')',     3.50, 0.18, 350, 'Standard contract carrier rate'),
  ('reefer',   'Refrigerated',        4.00, 0.20, 450, 'Includes temperature-control fuel premium'),
  ('flatbed',  'Flatbed',             3.80, 0.18, 425, 'Includes tarp + securement service'),
  ('straight', 'Straight Truck',      2.80, 0.15, 175, 'Local / regional dedicated lanes'),
  ('sprinter', 'Sprinter / Cargo Van',2.20, 0.12, 95,  'Expedite + same-day service tier')
ON CONFLICT (vehicle_type) DO NOTHING;

ALTER TABLE public.ref_fleet_carrier_rates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ref_fleet_carrier_rates' AND policyname='read_all') THEN
    CREATE POLICY read_all ON public.ref_fleet_carrier_rates FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ref_fleet_carrier_rates' AND policyname='write_all') THEN
    CREATE POLICY write_all ON public.ref_fleet_carrier_rates FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
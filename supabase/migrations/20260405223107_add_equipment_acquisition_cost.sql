
ALTER TABLE public.cost_model_equipment ADD COLUMN IF NOT EXISTS acquisition_cost numeric default 0;
ALTER TABLE public.cost_model_equipment ADD COLUMN IF NOT EXISTS lease_rate numeric default 0;
ALTER TABLE public.cost_model_equipment ADD COLUMN IF NOT EXISTS maintenance_cost numeric default 0;
ALTER TABLE public.cost_model_equipment ADD COLUMN IF NOT EXISTS pricing_bucket text;
NOTIFY pgrst, 'reload schema';

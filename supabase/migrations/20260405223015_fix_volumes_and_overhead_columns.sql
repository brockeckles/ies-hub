
-- Fix cost_model_volumes to match in-memory data shape
ALTER TABLE public.cost_model_volumes ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.cost_model_volumes ADD COLUMN IF NOT EXISTS process_area text;
ALTER TABLE public.cost_model_volumes ADD COLUMN IF NOT EXISTS daily_volume numeric default 0;

-- Fix cost_model_overhead to match in-memory data shape
ALTER TABLE public.cost_model_overhead ADD COLUMN IF NOT EXISTS scaling_driver text;
ALTER TABLE public.cost_model_overhead ADD COLUMN IF NOT EXISTS rate numeric default 0;
ALTER TABLE public.cost_model_overhead ADD COLUMN IF NOT EXISTS quantity numeric default 0;
ALTER TABLE public.cost_model_overhead ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.cost_model_overhead ADD COLUMN IF NOT EXISTS pricing_bucket text;

NOTIFY pgrst, 'reload schema';

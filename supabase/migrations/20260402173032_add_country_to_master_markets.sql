ALTER TABLE public.master_markets ADD COLUMN country text DEFAULT 'US' CHECK (country = ANY (ARRAY['US','CA','MX']));
UPDATE public.master_markets SET country = 'US' WHERE country IS NULL;
ALTER TABLE public.ref_most_elements
  ADD COLUMN IF NOT EXISTS freq_per_cycle numeric NOT NULL DEFAULT 1.0;
COMMENT ON COLUMN public.ref_most_elements.freq_per_cycle IS
  'Occurrence frequency per work cycle (0..N). Element TMU is multiplied by this when totalling. 1.0 = every cycle, 0.5 = every other cycle.';
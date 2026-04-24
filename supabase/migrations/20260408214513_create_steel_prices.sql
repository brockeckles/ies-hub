CREATE TABLE IF NOT EXISTS steel_prices (
  id bigserial PRIMARY KEY,
  index_name text NOT NULL,
  price numeric NOT NULL,
  unit text DEFAULT '$/ton',
  report_date date NOT NULL,
  wow_change numeric,
  mom_change numeric,
  source text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(index_name, report_date)
);
ALTER TABLE steel_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read steel_prices" ON steel_prices FOR SELECT USING (true);
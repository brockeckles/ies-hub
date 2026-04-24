
CREATE TABLE market_freight (
  id bigint generated always as identity primary key,
  market text NOT NULL,
  avg_outbound_rate_per_mile numeric(6,2),
  avg_inbound_rate_per_mile numeric(6,2),
  tl_capacity text,
  ltl_transit_days numeric(3,1),
  intermodal_available boolean DEFAULT false,
  nearest_port text,
  port_dwell_days numeric(4,1),
  top_lanes text[],
  notes text,
  as_of_date date DEFAULT CURRENT_DATE,
  source text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE market_freight ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON market_freight FOR SELECT USING (true);

-- Seed with per-market freight benchmarks for 10 map markets
INSERT INTO market_freight (market, avg_outbound_rate_per_mile, avg_inbound_rate_per_mile, tl_capacity, ltl_transit_days, intermodal_available, nearest_port, port_dwell_days, top_lanes, notes, as_of_date, source) VALUES
('Inland Empire, CA', 2.85, 1.95, 'Tight', 2.5, true, 'Los Angeles / Long Beach', 6.2, ARRAY['IE → Phoenix', 'IE → Las Vegas', 'IE → Dallas'], 'Highest outbound rates in the country due to trade imbalance; strong inbound from port dray', '2026-03-28', 'DAT / FreightWaves'),
('Phoenix', 2.15, 2.35, 'Balanced', 3.0, false, 'Los Angeles / Long Beach', 6.2, ARRAY['PHX → IE', 'PHX → Dallas', 'PHX → Tucson'], 'Growing market with improving carrier capacity; inbound rates higher than outbound due to consumption market dynamics', '2026-03-28', 'DAT / FreightWaves'),
('Dallas–Fort Worth', 2.08, 2.12, 'Loose', 2.0, true, 'Houston', 2.9, ARRAY['DFW → Houston', 'DFW → Atlanta', 'DFW → Chicago'], 'Major intermodal hub; balanced freight market with strong carrier availability. Laredo cross-border adds volume', '2026-03-28', 'DAT / FreightWaves'),
('Memphis', 1.95, 2.05, 'Loose', 1.5, true, 'Savannah', 3.8, ARRAY['MEM → Atlanta', 'MEM → Chicago', 'MEM → Dallas'], 'FedEx hub effect keeps carrier density high; strong intermodal via BNSF and UP', '2026-03-28', 'DAT / FreightWaves'),
('Chicago', 2.25, 2.10, 'Balanced', 1.5, true, 'Newark / NYNJ', 4.5, ARRAY['CHI → Atlanta', 'CHI → Dallas', 'CHI → Columbus'], 'Largest intermodal market in North America; seasonal tightness in Q4. Union activity can disrupt capacity', '2026-03-28', 'DAT / FreightWaves'),
('Indianapolis', 2.05, 2.15, 'Loose', 1.5, true, 'Savannah', 3.8, ARRAY['IND → Chicago', 'IND → Columbus', 'IND → Atlanta'], 'Crossroads of America — strong access to 65% of US population within 1-day drive', '2026-03-28', 'DAT / FreightWaves'),
('Atlanta', 2.18, 2.22, 'Balanced', 2.0, true, 'Savannah', 3.8, ARRAY['ATL → Dallas', 'ATL → Chicago', 'ATL → Savannah'], 'Southeast distribution hub; port dray from Savannah a major volume driver', '2026-03-28', 'DAT / FreightWaves'),
('Columbus, OH', 2.10, 2.20, 'Balanced', 1.5, true, 'Newark / NYNJ', 4.5, ARRAY['COL → Chicago', 'COL → Pittsburgh', 'COL → Indianapolis'], 'Growing e-commerce fulfillment hub; Rickenbacker intermodal terminal adds capacity', '2026-03-28', 'DAT / FreightWaves'),
('Savannah', 2.30, 1.85, 'Tight', 2.5, true, 'Savannah', 3.8, ARRAY['SAV → Atlanta', 'SAV → Charlotte', 'SAV → Jacksonville'], 'Port-adjacent market; outbound rates elevated due to container surge. Major chassis shortage risk', '2026-03-28', 'DAT / FreightWaves'),
('Central PA', 2.35, 2.05, 'Balanced', 1.5, true, 'Newark / NYNJ', 4.5, ARRAY['CPA → NYC/NJ', 'CPA → Philadelphia', 'CPA → Baltimore'], 'I-81 corridor dominates; strong Northeast population coverage. Winter weather disruptions in Q1', '2026-03-28', 'DAT / FreightWaves');

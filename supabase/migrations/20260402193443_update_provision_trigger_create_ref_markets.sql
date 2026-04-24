
CREATE OR REPLACE FUNCTION provision_market_intel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  market_key TEXT;
  new_ref_uuid UUID;
BEGIN
  -- Use city as the canonical key across intel tables
  market_key := NEW.city;

  -- Provision labor_markets stub (if not exists)
  IF NOT EXISTS (SELECT 1 FROM labor_markets WHERE msa = market_key) THEN
    INSERT INTO labor_markets (msa, avg_warehouse_wage, availability_status, availability_score, trend, avg_time_to_fill_days, turnover_rate, as_of_date, source)
    VALUES (market_key, 18.00, 'Moderate', 50, 'stable', 18, 45.00, CURRENT_DATE, 'Pending — baseline estimate');
  END IF;

  -- Provision industrial_real_estate stub (if not exists)
  IF NOT EXISTS (SELECT 1 FROM industrial_real_estate WHERE market = market_key) THEN
    INSERT INTO industrial_real_estate (market, quarter, lease_rate_psf, vacancy_rate, yoy_change, trend, source)
    VALUES (market_key, 'Q1 2026', 7.00, 7.00, 0.00, 'stable', 'Pending — baseline estimate');
  END IF;

  -- Provision market_freight stub (if not exists)
  IF NOT EXISTS (SELECT 1 FROM market_freight WHERE market = market_key) THEN
    INSERT INTO market_freight (market, avg_outbound_rate_per_mile, avg_inbound_rate_per_mile, tl_capacity, ltl_transit_days, intermodal_available, as_of_date, source)
    VALUES (market_key, 2.20, 2.10, 'Balanced', 3.0, false, CURRENT_DATE, 'Pending — baseline estimate');
  END IF;

  -- Provision ref_markets row for Cost Model rate lookups (if not exists)
  IF NEW.ref_market_uuid IS NULL THEN
    -- Check if a ref_markets row already exists for this city
    SELECT id INTO new_ref_uuid FROM ref_markets WHERE name = market_key OR name = (market_key || ', ' || NEW.state) LIMIT 1;
    IF new_ref_uuid IS NULL THEN
      INSERT INTO ref_markets (name, region, state, master_market_id)
      VALUES (market_key, NEW.region, NEW.state, NEW.id)
      RETURNING id INTO new_ref_uuid;
    ELSE
      -- Link existing ref_markets row
      UPDATE ref_markets SET master_market_id = NEW.id WHERE id = new_ref_uuid AND master_market_id IS NULL;
    END IF;
    NEW.ref_market_uuid := new_ref_uuid;
  END IF;

  -- Also set the labor_key and re_key on the master_markets row to match
  NEW.labor_key := COALESCE(NEW.labor_key, market_key);
  NEW.re_key := COALESCE(NEW.re_key, market_key);

  RETURN NEW;
END;
$$;

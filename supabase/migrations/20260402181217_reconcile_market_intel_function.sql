
-- Reconcile function: ensures every active market in master_markets has intel rows
-- Can be called manually or via a scheduled job
CREATE OR REPLACE FUNCTION reconcile_market_intel()
RETURNS TABLE(market_city TEXT, tables_provisioned TEXT[]) AS $$
DECLARE
  r RECORD;
  provisioned TEXT[];
BEGIN
  FOR r IN SELECT city FROM master_markets WHERE status = 'active' LOOP
    provisioned := ARRAY[]::TEXT[];

    IF NOT EXISTS (SELECT 1 FROM labor_markets WHERE msa = r.city) THEN
      INSERT INTO labor_markets (msa, avg_warehouse_wage, availability_status, availability_score, trend, avg_time_to_fill_days, turnover_rate, as_of_date, source)
      VALUES (r.city, 18.00, 'Moderate', 50, 'stable', 18, 45.00, CURRENT_DATE, 'Pending — baseline estimate');
      provisioned := provisioned || 'labor_markets';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM industrial_real_estate WHERE market = r.city) THEN
      INSERT INTO industrial_real_estate (market, quarter, lease_rate_psf, vacancy_rate, yoy_change, trend, source)
      VALUES (r.city, 'Q1 2026', 7.00, 7.00, 0.00, 'stable', 'Pending — baseline estimate');
      provisioned := provisioned || 'industrial_real_estate';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM market_freight WHERE market = r.city) THEN
      INSERT INTO market_freight (market, avg_outbound_rate_per_mile, avg_inbound_rate_per_mile, tl_capacity, ltl_transit_days, intermodal_available, as_of_date, source)
      VALUES (r.city, 2.20, 2.10, 'Balanced', 3.0, false, CURRENT_DATE, 'Pending — baseline estimate');
      provisioned := provisioned || 'market_freight';
    END IF;

    -- Ensure labor_key and re_key are set
    UPDATE master_markets SET labor_key = COALESCE(labor_key, city), re_key = COALESCE(re_key, city) WHERE city = r.city AND (labor_key IS NULL OR re_key IS NULL);

    IF array_length(provisioned, 1) > 0 THEN
      market_city := r.city;
      tables_provisioned := provisioned;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

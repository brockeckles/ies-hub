import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * BLS Wage Data Ingestion
 * Fetches Occupational Employment & Wage Statistics (OEWS) for warehouse workers
 * BLS Series IDs for "Laborers and Freight, Stock, and Material Movers, Hand" (SOC 53-7062)
 *
 * BLS API v2: https://api.bls.gov/publicAPI/v2/timeseries/data/
 * Free tier (v1, no key): 25 queries/day, 10 years of data
 * Registered (v2, with key): 500 queries/day
 */

// MSA-level OEWS series for SOC 53-7062 (warehouse labor)
// Format: OEUM{MSA_CODE}000000053706203 (03 = hourly mean wage)
const MSA_SERIES: Record<string, string> = {
  'Inland Empire, CA': 'OEUM004014000000053706203',    // Riverside-San Bernardino-Ontario
  'Dallas–Fort Worth': 'OEUM001924200000053706203',     // Dallas-Fort Worth-Arlington
  'Atlanta': 'OEUM001206000000053706203',                // Atlanta-Sandy Springs-Roswell
  'Chicago': 'OEUM001698200000053706203',                // Chicago-Naperville-Elgin
  'Memphis': 'OEUM003274000000053706203',                // Memphis
  'Central PA': 'OEUM002596000000053706203',             // Harrisburg-Carlisle
  'Columbus, OH': 'OEUM001818000000053706203',           // Columbus
  'Savannah': 'OEUM004260000000053706203',               // Savannah
  'Indianapolis': 'OEUM002690000000053706203',           // Indianapolis-Carmel-Anderson
  'Phoenix': 'OEUM003806000000053706203',                // Phoenix-Mesa-Scottsdale
};

// National series for warehouse workers
const NATIONAL_SERIES = 'OEUN000000000000053706203';

Deno.serve(async (req: Request) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const blsApiKey = Deno.env.get('BLS_API_KEY');

    // Support manual POST for direct wage data entry
    if (req.method === 'POST') {
      const body = await req.json();

      // Manual entry: { msa, avg_warehouse_wage, availability_status, availability_score, as_of_date }
      if (body.msa && body.avg_warehouse_wage) {
        const { data, error } = await supabase
          .from('labor_markets')
          .upsert({
            msa: body.msa,
            avg_warehouse_wage: body.avg_warehouse_wage,
            availability_status: body.availability_status || 'Moderate',
            availability_score: body.availability_score || 50,
            trend: body.trend || 'stable',
            avg_time_to_fill_days: body.avg_time_to_fill_days,
            turnover_rate: body.turnover_rate,
            as_of_date: body.as_of_date || new Date().toISOString().split('T')[0],
            source: body.source || 'Manual entry',
          }, { onConflict: 'msa,as_of_date' })
          .select();

        if (error) throw error;
        return new Response(JSON.stringify({ status: 'ok', upserted: data }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Batch entry: { records: [ { msa, avg_warehouse_wage, ... }, ... ] }
      if (body.records && Array.isArray(body.records)) {
        const records = body.records.map((r: any) => ({
          msa: r.msa,
          avg_warehouse_wage: r.avg_warehouse_wage,
          availability_status: r.availability_status || 'Moderate',
          availability_score: r.availability_score || 50,
          trend: r.trend || 'stable',
          avg_time_to_fill_days: r.avg_time_to_fill_days,
          turnover_rate: r.turnover_rate,
          as_of_date: r.as_of_date || new Date().toISOString().split('T')[0],
          source: r.source || 'BLS OEWS',
        }));

        const { data, error } = await supabase
          .from('labor_markets')
          .upsert(records, { onConflict: 'msa,as_of_date' })
          .select();

        if (error) throw error;
        return new Response(JSON.stringify({ status: 'ok', upserted: data?.length || 0 }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ── Auto-fetch from BLS API ──
    const apiVersion = blsApiKey ? 'v2' : 'v1';
    const blsUrl = `https://api.bls.gov/publicAPI/${apiVersion}/timeseries/data/`;
    const allSeries = [NATIONAL_SERIES, ...Object.values(MSA_SERIES)];

    const currentYear = new Date().getFullYear();
    const blsPayload: any = {
      seriesid: allSeries,
      startyear: String(currentYear - 1),
      endyear: String(currentYear),
    };
    if (blsApiKey) blsPayload.registrationkey = blsApiKey;

    const blsRes = await fetch(blsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blsPayload),
    });
    const blsData = await blsRes.json();

    if (blsData.status !== 'REQUEST_SUCCEEDED') {
      return new Response(JSON.stringify({
        status: 'bls_error',
        message: blsData.message || 'BLS API request failed',
        details: blsData,
        hint: !blsApiKey ? 'Set BLS_API_KEY for higher rate limits. Register free at https://data.bls.gov/registrationEngine/' : undefined
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let updated = 0;
    const msaLookup = Object.entries(MSA_SERIES).reduce((acc, [msa, series]) => {
      acc[series] = msa;
      return acc;
    }, {} as Record<string, string>);

    for (const series of blsData.Results?.series || []) {
      const seriesId = series.seriesID;
      const latestData = series.data?.[0]; // most recent period
      if (!latestData?.value) continue;

      const wage = parseFloat(latestData.value);
      if (isNaN(wage)) continue;

      const asOfDate = `${latestData.year}-${latestData.period.replace('M', '')}-01`;

      if (seriesId === NATIONAL_SERIES) {
        // Update national summary
        await supabase.from('labor_summary').upsert({
          metric_name: "Nat'l Avg Warehouse Wage",
          metric_value: wage,
          metric_unit: '/hr',
          as_of_date: asOfDate,
        }, { onConflict: 'metric_name,as_of_date' });
        updated++;
      } else {
        const msa = msaLookup[seriesId];
        if (!msa) continue;

        // Get existing record to preserve availability data
        const { data: existing } = await supabase
          .from('labor_markets')
          .select('availability_status, availability_score, trend, avg_time_to_fill_days, turnover_rate')
          .eq('msa', msa)
          .order('as_of_date', { ascending: false })
          .limit(1)
          .single();

        await supabase.from('labor_markets').upsert({
          msa,
          avg_warehouse_wage: wage,
          availability_status: existing?.availability_status || 'Moderate',
          availability_score: existing?.availability_score || 50,
          trend: existing?.trend || 'stable',
          avg_time_to_fill_days: existing?.avg_time_to_fill_days,
          turnover_rate: existing?.turnover_rate,
          as_of_date: asOfDate,
          source: 'BLS OEWS',
        }, { onConflict: 'msa,as_of_date' });
        updated++;
      }
    }

    return new Response(JSON.stringify({
      status: 'ok',
      api_version: apiVersion,
      series_fetched: blsData.Results?.series?.length || 0,
      records_updated: updated,
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});

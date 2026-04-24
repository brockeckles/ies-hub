import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// EIA Weekly Retail Gasoline and Diesel Prices API
// Series: PET.EMD_EPD2D_PTE_NUS_DPG.W (US No 2 Diesel Retail Prices, Weekly)
const EIA_API_URL = "https://api.eia.gov/v2/petroleum/pri/gasprice/data/";

Deno.serve(async (req: Request) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const eiaApiKey = Deno.env.get("EIA_API_KEY");

    if (!eiaApiKey) {
      // If no API key is set yet, return instructions
      return new Response(JSON.stringify({
        status: "config_needed",
        message: "Set EIA_API_KEY in Supabase Edge Function secrets. Get a free key at https://www.eia.gov/opendata/register.php",
        manual_mode: "You can also POST data directly to this function with { report_date, price_per_gallon }"
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Check if this is a manual data push
    if (req.method === "POST") {
      const body = await req.json();
      if (body.report_date && body.price_per_gallon) {
        // Manual insert mode
        const prevWeek = await supabase
          .from("fuel_prices")
          .select("price_per_gallon")
          .eq("fuel_type", "diesel")
          .order("report_date", { ascending: false })
          .limit(1)
          .single();

        const wow = prevWeek.data
          ? Number((body.price_per_gallon - prevWeek.data.price_per_gallon).toFixed(3))
          : null;

        const { data, error } = await supabase
          .from("fuel_prices")
          .upsert({
            report_date: body.report_date,
            fuel_type: "diesel",
            price_per_gallon: body.price_per_gallon,
            week_over_week_change: wow,
            source: "EIA"
          }, { onConflict: "report_date,fuel_type" })
          .select();

        if (error) throw error;
        return new Response(JSON.stringify({ status: "ok", inserted: data }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Auto-fetch from EIA API
    const params = new URLSearchParams({
      api_key: eiaApiKey,
      frequency: "weekly",
      "data[0]": "value",
      "facets[product][]": "EPD2D",
      "facets[duoarea][]": "NUS",
      sort: JSON.stringify([{ column: "period", direction: "desc" }]),
      offset: "0",
      length: "4"
    });

    const eiaRes = await fetch(`${EIA_API_URL}?${params}`);
    const eiaData = await eiaRes.json();

    if (!eiaData.response?.data?.length) {
      return new Response(JSON.stringify({ status: "no_data", raw: eiaData }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const records = eiaData.response.data;
    let inserted = 0;

    for (const record of records) {
      const reportDate = record.period;
      const price = parseFloat(record.value);

      if (!reportDate || isNaN(price)) continue;

      // Get previous week for WoW calc
      const prev = await supabase
        .from("fuel_prices")
        .select("price_per_gallon")
        .eq("fuel_type", "diesel")
        .lt("report_date", reportDate)
        .order("report_date", { ascending: false })
        .limit(1)
        .single();

      const wow = prev.data
        ? Number((price - prev.data.price_per_gallon).toFixed(3))
        : null;

      const { error } = await supabase
        .from("fuel_prices")
        .upsert({
          report_date: reportDate,
          fuel_type: "diesel",
          price_per_gallon: price,
          week_over_week_change: wow,
          source: "EIA"
        }, { onConflict: "report_date,fuel_type" });

      if (!error) inserted++;
    }

    return new Response(JSON.stringify({
      status: "ok",
      records_processed: records.length,
      records_inserted: inserted
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});

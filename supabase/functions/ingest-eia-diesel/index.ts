import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// EIA Weekly Retail Gasoline and Diesel Prices API
// Series: PET.EMD_EPD2D_PTE_NUS_DPG.W (US No 2 Diesel Retail Prices, Weekly)
const EIA_API_URL = "https://api.eia.gov/v2/petroleum/pri/gasprice/data/";

Deno.serve(async (req: Request) => {
  // ── Auth gate (C5, 2026-07-22) ──
  // verify_jwt=false (pg_cron/pg_net caller has no user JWT), which left this
  // open to header-less internet drive-bys — anonymous POSTs could upsert
  // arbitrary rows into fuel_prices. Require `Authorization: Bearer <key>`:
  // the anon-key gate stops header-less drive-bys; a dedicated INGEST_SECRET
  // dashboard env var is the hardening follow-up (set INGEST_SECRET + update
  // the cron job's header — no code redeploy needed).
  // C5b (2026-07-23): INGEST_SECRET rides the x-ingest-secret header, NOT the
  // Authorization Bearer — platform verify_jwt=true rejects a non-JWT Bearer
  // before code runs, so the Bearer must stay a valid key (publishable) and
  // the private secret travels alongside. Fallback (no INGEST_SECRET set):
  // Bearer must equal SUPABASE_ANON_KEY (the publishable key), as before.
  const ingestSecret = Deno.env.get("INGEST_SECRET");
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const xSecret = (req.headers.get("x-ingest-secret") || "").trim();
  const authorized = ingestSecret
    ? (xSecret === ingestSecret || bearer === ingestSecret)
    : (!!bearer && bearer === (Deno.env.get("SUPABASE_ANON_KEY") || ""));
  if (!authorized) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const eiaApiKey = Deno.env.get("EIA_API_KEY");

    // Check if this is a manual data push. This branch runs BEFORE the
    // EIA_API_KEY check (C5 fix): the config_needed message below promises
    // manual mode works, but the old ordering made it unreachable keyless.
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
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

    if (!eiaApiKey) {
      // No API key set and no manual payload: return instructions
      return new Response(JSON.stringify({
        status: "config_needed",
        message: "Set EIA_API_KEY in Supabase Edge Function secrets. Get a free key at https://www.eia.gov/opendata/register.php",
        manual_mode: "You can also POST data directly to this function with { report_date, price_per_gallon }"
      }), { headers: { "Content-Type": "application/json" } });
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

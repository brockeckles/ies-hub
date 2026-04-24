import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Universal intelligence feed ingestion endpoint.
 * Accepts POST with a feed_type and corresponding data.
 *
 * Supported feed_types:
 *   - competitor_news
 *   - account_signal
 *   - rfp_signal
 *   - automation_news
 *   - tariff_development
 *   - reshoring_activity
 *   - port_status
 *   - regulatory_update
 *   - hub_alert
 *   - labor_market
 *   - freight_rate
 *   - wms_update
 *   - ai_development
 *
 * Each feed_type maps to a specific table. The payload fields
 * should match the table columns.
 */

const FEED_TABLE_MAP: Record<string, string> = {
  competitor_news: "competitor_news",
  account_signal: "account_signals",
  rfp_signal: "rfp_signals",
  automation_news: "automation_news",
  tariff_development: "tariff_developments",
  reshoring_activity: "reshoring_activity",
  port_status: "port_status",
  regulatory_update: "regulatory_updates",
  hub_alert: "hub_alerts",
  labor_market: "labor_markets",
  freight_rate: "freight_rates",
  wms_update: "wms_updates",
  ai_development: "ai_logistics_developments",
  fuel_price: "fuel_prices",
  utility_rate: "utility_rates",
  material_price: "material_prices",
  real_estate: "industrial_real_estate",
  construction_index: "construction_indices",
  pipeline_deal: "pipeline_deals",
  pipeline_summary: "pipeline_summary",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // GET = return supported feed types + recent counts
    if (req.method === "GET") {
      const feedTypes = Object.keys(FEED_TABLE_MAP);
      return new Response(JSON.stringify({
        status: "ok",
        supported_feed_types: feedTypes,
        usage: "POST with { feed_type: '<type>', data: { ...fields } } or { feed_type: '<type>', data: [ {...}, {...} ] } for batch",
        docs_url: "https://dklnwcshrpamzsybjlzb.supabase.co/functions/v1/ingest-intel-feed"
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    const { feed_type, data } = body;

    if (!feed_type || !data) {
      return new Response(JSON.stringify({
        error: "Missing feed_type or data",
        supported_feed_types: Object.keys(FEED_TABLE_MAP)
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const tableName = FEED_TABLE_MAP[feed_type];
    if (!tableName) {
      return new Response(JSON.stringify({
        error: `Unknown feed_type: ${feed_type}`,
        supported_feed_types: Object.keys(FEED_TABLE_MAP)
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Support both single object and array batch
    const records = Array.isArray(data) ? data : [data];

    const { data: result, error } = await supabase
      .from(tableName)
      .insert(records)
      .select();

    if (error) {
      return new Response(JSON.stringify({
        error: error.message,
        details: error.details,
        hint: error.hint
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // If it's a high-severity item, auto-create a hub alert
    if (records.length === 1 && records[0].relevance === "critical" || records[0].impact === "critical") {
      const r = records[0];
      const alertTitle = r.headline || r.title || r.detail || "New critical intelligence";
      const domainMap: Record<string, string> = {
        competitor_news: "competitive",
        account_signal: "competitive",
        tariff_development: "macro_trade",
        port_status: "macro_trade",
        regulatory_update: "labor",
        automation_news: "automation_tech",
      };

      const alertDomain = domainMap[feed_type] || "market_cost";
      await supabase.from("hub_alerts").insert({
        domain: alertDomain,
        severity: "critical",
        title: alertTitle.substring(0, 200),
        summary: r.summary?.substring(0, 500) || null,
        source_table: tableName,
        is_active: true
      });
    }

    return new Response(JSON.stringify({
      status: "ok",
      feed_type,
      table: tableName,
      records_inserted: result?.length || 0,
      data: result
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
});

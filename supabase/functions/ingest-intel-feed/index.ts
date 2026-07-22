// Wave C5 (2026-07-22) — `ingest-intel-feed` retired in place.
//
// Previously: universal intel ingest — POST { feed_type, data } routed
// service-role inserts into ~20 tables via a feed_type map, and critical
// rows auto-spawned active hub_alerts banners. It was deployed with
// verify_jwt=false, no body auth, and CORS * — an unauthenticated
// service-role write surface open to the internet.
//
// The C4 mini-audit found ZERO callers: its pg_cron job was unscheduled
// 2026-04-17 and no frontend references exist. Retired rather than
// auth-gated. Mirrors the `hub` 410 tombstone: kept deployed under the
// same slug so any stray caller gets a clear 410 Gone instead of a 404.
// Safe to delete from the Supabase dashboard once logs confirm continued
// zero traffic. See supabase/functions/README.md.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "gone",
      message:
        "ingest-intel-feed retired 2026-07-22 — unauthenticated service-role ingest surface with zero callers; see supabase/functions/README.md in the ies-hub repo.",
    }) + "\n",
    {
      status: 410,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  )
);

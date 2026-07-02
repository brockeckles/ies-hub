// Phase 0 security (2026-07-02) — `analytics-narrate` retired in place.
//
// Previously: an unauthenticated-CORS (`Access-Control-Allow-Origin: *`)
// proxy that forwarded a client-supplied Anthropic API key to
// api.anthropic.com. The 2026-07-02 ground-up assessment flagged it as an
// orphaned relay: grep of the client (tools/, hub/, shared/) shows ZERO
// callers. Rather than leave an unused, unaudited proxy deployed ahead of the
// inside-firewall transition, it is neutralized to a 410 Gone tombstone
// (matching the `hub` function retirement pattern). Safe to delete from the
// Supabase dashboard once logs confirm no traffic.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() =>
  new Response(
    "Gone — the analytics-narrate endpoint has been retired for security review.\n",
    {
      status: 410,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  )
);

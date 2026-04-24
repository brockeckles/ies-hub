// Phase 4.5 Slice HYG-03 — legacy `hub` edge function retired in place.
//
// Previously: served an HTML snapshot from the public `hub` storage bucket.
// Current canonical hub URL: https://brockeckles.github.io/ies-hub/ (GitHub Pages).
// Bucket flipped private in the same slice; no back-end serving path remains.
//
// This function is kept deployed only so external callers that still hit
// /functions/v1/hub get a clear 410 Gone with a pointer instead of a 404 or
// a stale page. Safe to delete from the Supabase dashboard once logs confirm
// no traffic (recent logs already show zero hits; retained here as a 410 tombstone).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() =>
  new Response(
    "Gone — the /functions/v1/hub endpoint has been retired.\n" +
    "Use https://brockeckles.github.io/ies-hub/ instead.\n",
    {
      status: 410,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  )
);

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const STORAGE_URL = "https://dklnwcshrpamzsybjlzb.supabase.co/storage/v1/object/public/hub/index.html";

Deno.serve(async (_req: Request) => {
  try {
    const res = await fetch(STORAGE_URL, { headers: { 'Cache-Control': 'no-cache' } });
    const html = await res.text();
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return new Response("Error loading hub: " + e.message, { status: 500 });
  }
});

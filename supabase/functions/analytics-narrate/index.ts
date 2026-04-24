import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json();
    const apiKey = body.apiKey;
    const model = body.model || 'claude-sonnet-4-6';
    const system = body.system || '';
    const userMsg = body.user || '';
    const maxTokens = body.max_tokens || 2000;
    if (!apiKey) return new Response(JSON.stringify({ error: 'Missing apiKey in request body' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    if (!userMsg) return new Response(JSON.stringify({ error: 'Missing user message' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    const text = await resp.text();
    return new Response(text, { status: resp.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});

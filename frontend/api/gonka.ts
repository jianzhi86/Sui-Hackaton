/**
 * Vercel serverless function: proxies chat-completions calls to Gonka
 * Router. Exists because api.gonkarouter.io doesn't send CORS headers, so a
 * browser can't call it directly (confirmed live 2026-08-29 — Chrome blocks
 * the preflight), and because the API key must never reach the client
 * bundle. `GONKA_API_KEY`/`GONKA_BASE_URL` here are plain env vars (no
 * `VITE_` prefix) set in the Vercel project settings, not `.env` — Vite
 * only bundles `VITE_`-prefixed vars into client code, so keeping these
 * unprefixed is what keeps the key server-side.
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GONKA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GONKA_API_KEY is not configured on the server.' });
    return;
  }

  const baseUrl = process.env.GONKA_BASE_URL || 'https://api.gonkarouter.io/v1';
  const { model, messages, temperature } = req.body ?? {};

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // Without this, the router can silently re-route a request to a
        // different model on fallback while still labelling the response
        // with the model we asked for in some places — confirmed live: a
        // request for moonshotai/Kimi-K2.6 came back answered by
        // MiniMax-M2.7 with no indication in the body. This header keeps
        // the model that actually serves the request equal to the one we
        // asked for, which our two-model cross-check depends on.
        'X-Gonka-No-Fallback': 'true',
      },
      body: JSON.stringify({ model, messages, temperature }),
    });

    // The real per-request identifier is the X-Request-Id response header
    // (the "req-..." id), not the "devshard-..." value in the JSON body's
    // `id` field — that's the serving node's own inference id, shared
    // across many unrelated requests. Surface X-Request-Id in the body so
    // the client (which only sees this JSON, not raw response headers)
    // can use it for the on-chain Execution Hash cross-check.
    const requestId = upstream.headers.get('x-request-id');
    const devshardId = upstream.headers.get('x-devshard-id');
    const raw = await upstream.text();
    let data = raw;
    if (requestId) {
      try {
        const parsed = JSON.parse(raw);
        parsed.x_request_id = requestId;
        if (devshardId) parsed.x_devshard_id = devshardId;
        data = JSON.stringify(parsed);
      } catch {
        // Non-JSON upstream response (e.g. an error page) — forward as-is.
      }
    }
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach Gonka Router: ${String(err)}` });
  }
}

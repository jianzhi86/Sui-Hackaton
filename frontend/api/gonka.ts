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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature }),
    });

    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to reach Gonka Router: ${String(err)}` });
  }
}

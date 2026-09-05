import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only mirror of `api/gonka.ts` (the Vercel serverless function used in
 * production). Same reason it exists: api.gonkarouter.io doesn't send CORS
 * headers, so the browser can't call it directly, and the API key must
 * never reach client code. `vite dev` doesn't run Vercel functions, so this
 * middleware reimplements the same proxy for local development — both read
 * the same unprefixed (non-`VITE_`) `GONKA_API_KEY`/`GONKA_BASE_URL` env
 * vars, which Vite keeps out of the client bundle precisely because they
 * lack the `VITE_` prefix.
 */
function gonkaDevProxy(env: Record<string, string>): Plugin {
  return {
    name: 'gonka-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gonka', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const apiKey = env.GONKA_API_KEY;
        if (!apiKey) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'GONKA_API_KEY is not set in .env.' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { model, messages, temperature } = JSON.parse(body || '{}');
            const baseUrl = env.GONKA_BASE_URL || 'https://api.gonkarouter.io/v1';
            const upstream = await fetch(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                // See api/gonka.ts for why: without this, the router can
                // silently serve a different model than requested on
                // fallback, breaking the two-model cross-check.
                'X-Gonka-No-Fallback': 'true',
              },
              body: JSON.stringify({ model, messages, temperature }),
            });
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
                // Non-JSON upstream response — forward as-is.
              }
            }
            res.statusCode = upstream.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(data);
          } catch (err) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: `Failed to reach Gonka Router: ${String(err)}` }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), gonkaDevProxy(env)],
    server: {
      port: 5173,
    },
  };
});

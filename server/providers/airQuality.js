import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';

/**
 * Open-Meteo Air Quality proxy: keyless, CORS-open upstream — proxied anyway
 * so the fixed multi-city query is cached server-side (AQI moves slowly; no
 * point re-fetching the same ~42-point batch on every client poll) rather
 * than for CORS necessity. Forwards the client's exact query string and
 * caches the response keyed by it, single-flighted.
 *
 * @returns {import('vite').Plugin}
 */
export function airQualityProxy() {
  const TTL_MS = 15 * 60_000;
  const MAX_BYTES = 512 * 1024;
  const UPSTREAM_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';

  const mem = new Map(); // queryString -> { at: epochMs, body: unknown }
  const inflight = new Map();

  async function fetchUpstream(queryString) {
    const res = await fetch(`${UPSTREAM_BASE}?${queryString}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await readResponseJsonCapped(res, MAX_BYTES);
    return { at: Date.now(), body };
  }

  function install(middlewares) {
    middlewares.use('/api/air-quality', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      const queryString = String(req.url || '').split('?')[1] || '';
      if (!queryString) {
        sendJson(400, { error: 'missing query' });
        return;
      }
      try {
        const entry = mem.get(queryString);
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, entry.body);
          return;
        }
        const { promise } = coalesceProxyRequest(inflight, queryString, async () => {
          try {
            const fresh = await fetchUpstream(queryString);
            mem.set(queryString, fresh);
            return fresh;
          } catch (err) {
            console.warn('[air-quality-proxy] refresh failed — serving cache if any:', err?.message || err);
            return null;
          }
        });
        const fresh = await promise;
        if (fresh) {
          sendJson(200, fresh.body);
        } else if (entry) {
          sendJson(200, entry.body); // upstream down — stale beats empty
        } else {
          sendJson(502, { error: 'air quality fetch failed and no cache available' });
        }
      } catch (err) {
        console.warn('[air-quality-proxy] error:', err?.message || err);
        sendJson(500, { error: 'air quality proxy error' });
      }
    });
  }

  return {
    name: 'air-quality-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

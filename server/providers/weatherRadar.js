import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';

/**
 * RainViewer weather-radar proxy.
 *
 * GET /api/rainviewer — keyless upstream metadata (public/weather-maps.json),
 * cached in memory for 2 min (fresh radar frames land roughly every 10 min)
 * and single-flighted so concurrent requests share one upstream call.
 *
 * GET /api/rainviewer-tile?path=&z=&x=&y= — the actual tile images, also
 * proxied same-origin: RainViewer's tile CDN sends no CORS headers, so
 * Cesium's cross-origin WebGL texture upload fails every tile even though
 * the tile loads fine outside a browser. `path` is validated against the
 * exact shape RainViewer's own metadata hands back — this stays a narrow
 * proxy, not a general one.
 *
 * @returns {import('vite').Plugin}
 */
export function rainviewerProxy() {
  const METADATA_TTL_MS = 2 * 60_000;
  const METADATA_URL = 'https://api.rainviewer.com/public/weather-maps.json';
  const METADATA_MAX_BYTES = 256 * 1024;
  const TILE_TIMEOUT_MS = 15_000;

  let metadataCache = null; // { at: epochMs, body: object }
  const inflight = new Map();

  async function fetchMetadata() {
    const res = await fetch(METADATA_URL, { signal: AbortSignal.timeout(TILE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await readResponseJsonCapped(res, METADATA_MAX_BYTES);
    if (!body || typeof body !== 'object') throw new Error('malformed RainViewer response');
    return { at: Date.now(), body };
  }

  function install(middlewares) {
    middlewares.use('/api/rainviewer', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        const entry = metadataCache;
        if (entry && Date.now() - entry.at < METADATA_TTL_MS) {
          sendJson(200, entry.body);
          return;
        }
        const { promise } = coalesceProxyRequest(inflight, 'metadata', async () => {
          try {
            const fresh = await fetchMetadata();
            metadataCache = fresh;
            return fresh;
          } catch (err) {
            console.warn('[rainviewer-proxy] refresh failed — serving cache if any:', err?.message || err);
            return null;
          }
        });
        const fresh = await promise;
        if (fresh) {
          sendJson(200, fresh.body);
        } else if (entry) {
          sendJson(200, entry.body); // upstream down — stale beats empty
        } else {
          sendJson(502, { error: 'rainviewer fetch failed and no cache available' });
        }
      } catch (err) {
        console.warn('[rainviewer-proxy] error:', err?.message || err);
        sendJson(500, { error: 'rainviewer proxy error' });
      }
    });

    middlewares.use('/api/rainviewer-tile', async (req, res) => {
      try {
        const url = new URL(req.url || '', 'http://internal');
        const framePath = url.searchParams.get('path') || '';
        const z = url.searchParams.get('z') || '';
        const x = url.searchParams.get('x') || '';
        const y = url.searchParams.get('y') || '';
        if (
          !/^\/v2\/radar\/[A-Za-z0-9_-]+$/.test(framePath) ||
          !/^\d{1,2}$/.test(z) ||
          !/^\d{1,7}$/.test(x) ||
          !/^\d{1,7}$/.test(y)
        ) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('invalid tile request');
          return;
        }
        const upstream = `https://tilecache.rainviewer.com${framePath}/256/${z}/${x}/${y}/2/1_1.png`;
        const upstreamRes = await fetch(upstream, { signal: AbortSignal.timeout(TILE_TIMEOUT_MS) });
        if (!upstreamRes.ok) {
          res.writeHead(upstreamRes.status, { 'Content-Type': 'text/plain' });
          res.end(`upstream ${upstreamRes.status}`);
          return;
        }
        const buffer = Buffer.from(await upstreamRes.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': upstreamRes.headers.get('content-type') || 'image/png',
          // Past radar frames never change — safe to cache long in the browser.
          'Cache-Control': 'public, max-age=3600, immutable',
        });
        res.end(buffer);
      } catch (err) {
        console.warn('[rainviewer-proxy] tile error:', err?.message || err);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('rainviewer tile proxy error');
      }
    });
  }

  return {
    name: 'rainviewer-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

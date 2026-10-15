// routes/proxy.js — the proxy endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { fetch as undiciFetch } from 'undici';
import { makeProxyAgent } from '../net.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerProxyRoutes(app, { getConfig, patchConfig }) {
    // ── proxy detection ──────────────────────────────────────────────
    // Tries the common local proxy ports one by one and returns the addresses that actually get through
    // (no port is hard-coded as the one true answer)
    app.get('/api/proxy/detect', async (_req, res) => {
      const ports = [7890, 7891, 7897, 1080, 1081, 8118, 10809, 10808, 10090, 2080, 8889, 8888, 20171];
      const found = [];
      for (const port of ports) {
        const url = `http://127.0.0.1:${port}`;
        try {
          const agent = makeProxyAgent(url);
          // undici's own fetch, not the global one: `makeProxyAgent` builds an npm-undici ProxyAgent,
          // and a dispatcher only works with the fetch of its own generation. Measured under npm undici
          // 8.12.2, the global fetch with such an Agent never reaches the proxy (no CONNECT is sent at
          // all), while undici's own fetch works on 7 and 8 alike. See the longer note in socks.js.
          const r = await undiciFetch('https://api.ipify.org?format=json', {
            dispatcher: agent,
            signal: AbortSignal.timeout(3500),
          });
          if (r.ok) found.push(url);
        } catch {
          /* not a usable proxy, keep probing */
        }
      }
      res.json({ found, probed: ports.length });
    });
}

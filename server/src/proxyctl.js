// proxyctl.js — proxy core control (the RESTful API mihomo / Clash.Meta are compatible with)
//
// Goal: from the web UI, see the node list, see **each node's delay to one specific site**, and switch with one click.
// mihomo's /proxies/<node>/delay already accepts a url parameter, so "pick the fastest node for a given site"
// is something that can genuinely be done, not folklore.
//
// Note: this path only talks over the local loopback (the control endpoint defaults to 127.0.0.1), and netFetch
// always connects directly for loopback, so it can never be routed through the proxy we configured ourselves.
import { netFetch } from './net.js';

const COMMON_PORTS = [9090, 9790, 9097, 6170, 63333, 9091];
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';

function controlUrl(cfg) {
  const explicit = String(cfg?.proxy?.controlUrl ?? '').trim();
  return explicit.replace(/\/+$/, '');
}

function headers(cfg) {
  const secret = String(cfg?.proxy?.controlSecret ?? '').trim();
  return secret ? { authorization: `Bearer ${secret}`, accept: 'application/json' } : { accept: 'application/json' };
}

async function jget(url, cfg, timeout = 8000) {
  const res = await netFetch(url, { headers: headers(cfg), signal: AbortSignal.timeout(timeout) }, { cfg, mode: 'direct' });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 120)}` : ''}`);
  return JSON.parse(text);
}

/** Find a working control endpoint automatically */
export async function detectControl(cfg) {
  const explicit = controlUrl(cfg);
  if (explicit) {
    try {
      const v = await jget(`${explicit}/version`, cfg, 4000);
      return { ok: true, url: explicit, version: v.version ?? '?', meta: v.meta ?? false, probed: 1 };
    } catch (e) {
      return { ok: false, url: explicit, error: e.message, probed: 1 };
    }
  }
  const found = [];
  for (const port of COMMON_PORTS) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const v = await jget(`${url}/version`, cfg, 2500);
      found.push({ url, version: v.version ?? '?', meta: !!v.meta });
    } catch {
      /* not a control port, keep going */
    }
  }
  if (!found.length) return { ok: false, error: '未发现本机代理控制接口（mihomo / Clash 的 external-controller）', probed: COMMON_PORTS.length };
  return { ok: true, ...found[0], alternatives: found.slice(1), probed: COMMON_PORTS.length };
}

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']);

/** List the switchable groups */
export async function listGroups(cfg, control) {
  const url = control || controlUrl(cfg);
  if (!url) throw new Error('未配置控制接口 / no control URL');
  const data = await jget(`${url}/proxies`, cfg, 10000);
  const proxies = data.proxies ?? {};
  const groups = [];
  for (const [name, p] of Object.entries(proxies)) {
    if (!GROUP_TYPES.has(p.type)) continue;
    groups.push({
      name,
      type: p.type,
      now: p.now ?? null,
      nodes: (p.all ?? []).map((n) => ({
        name: n,
        type: proxies[n]?.type ?? '?',
        // `history` is the delay history the core keeps itself, so it can be shown directly
        lastDelay: (proxies[n]?.history ?? []).at(-1)?.delay ?? null,
        alive: (proxies[n]?.history ?? []).at(-1)?.delay > 0,
      })),
    });
  }
  return { url, groups };
}

/** One node's delay (a test URL can be given, which is what makes "pick a node per site" possible) */
export async function nodeDelay(cfg, control, node, testUrl, timeoutMs = 5000) {
  const url = control || controlUrl(cfg);
  const target = testUrl || DEFAULT_TEST_URL;
  const q = new URLSearchParams({ timeout: String(timeoutMs), url: target });
  try {
    const r = await jget(`${url}/proxies/${encodeURIComponent(node)}/delay?${q}`, cfg, timeoutMs + 4000);
    return { node, ok: true, delay: r.delay ?? null, testUrl: target };
  } catch (e) {
    return { node, ok: false, delay: null, error: e.message, testUrl: target };
  }
}

/** Every node's delay to one specific site */
export async function groupDelaysFor(cfg, control, group, nodeNames, testUrl, timeoutMs = 5000) {
  const names = nodeNames.slice(0, 40); // do not fire off too many at once
  const out = [];
  const concurrency = 5;
  for (let i = 0; i < names.length; i += concurrency) {
    const batch = names.slice(i, i + concurrency);
    out.push(...(await Promise.all(batch.map((n) => nodeDelay(cfg, control, n, testUrl, timeoutMs)))));
  }
  out.sort((a, b) => (a.ok ? a.delay : Infinity) - (b.ok ? b.delay : Infinity));
  return { group, testUrl: testUrl || DEFAULT_TEST_URL, results: out };
}

/** Switch a group's selected node */
export async function selectNode(cfg, control, group, node) {
  const url = control || controlUrl(cfg);
  const res = await netFetch(
    `${url}/proxies/${encodeURIComponent(group)}`,
    {
      method: 'PUT',
      headers: { ...headers(cfg), 'content-type': 'application/json' },
      body: JSON.stringify({ name: node }),
      signal: AbortSignal.timeout(8000),
    },
    { cfg, mode: 'direct' }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`切换失败 / switch failed: HTTP ${res.status}${t ? ` — ${t.slice(0, 120)}` : ''}`);
  }
  return { ok: true, group, node };
}

export { DEFAULT_TEST_URL };

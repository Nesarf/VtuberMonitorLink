// proxyctl.js — 代理内核控制（mihomo / Clash.Meta 兼容的 RESTful API）
//
// 目的：网页里能看到节点列表、看到**每个节点到某个具体站点**的延迟，并一键切换。
// mihomo 的 /proxies/<节点>/delay 本身就接受 url 参数，所以「按站点挑最快节点」
// 是可以真实做到的，不是玄学。
//
// 注意：这条链路只在本机回环上说话（控制接口默认 127.0.0.1），netFetch 对回环
// 永远直连，所以不会被自己配的代理绕进去。
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

/** 自动找一个能用的控制接口 / find a working control endpoint */
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
      /* 不是控制口，继续 */
    }
  }
  if (!found.length) return { ok: false, error: '未发现本机代理控制接口（mihomo / Clash 的 external-controller）', probed: COMMON_PORTS.length };
  return { ok: true, ...found[0], alternatives: found.slice(1), probed: COMMON_PORTS.length };
}

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']);

/** 列出可切换的组 / list switchable groups */
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
        // history 是内核自己记录的历史延迟，可直接展示
        lastDelay: (proxies[n]?.history ?? []).at(-1)?.delay ?? null,
        alive: (proxies[n]?.history ?? []).at(-1)?.delay > 0,
      })),
    });
  }
  return { url, groups };
}

/** 单个节点的延迟（可指定测试 URL，从而做到「按站点挑节点」） */
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

/** 全组节点对某个具体站点的延迟 / every node's delay to one site */
export async function groupDelaysFor(cfg, control, group, nodeNames, testUrl, timeoutMs = 5000) {
  const names = nodeNames.slice(0, 40); // 别一次打太多
  const out = [];
  const concurrency = 5;
  for (let i = 0; i < names.length; i += concurrency) {
    const batch = names.slice(i, i + concurrency);
    out.push(...(await Promise.all(batch.map((n) => nodeDelay(cfg, control, n, testUrl, timeoutMs)))));
  }
  out.sort((a, b) => (a.ok ? a.delay : Infinity) - (b.ok ? b.delay : Infinity));
  return { group, testUrl: testUrl || DEFAULT_TEST_URL, results: out };
}

/** 切换组当前节点 / switch a group's selected node */
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

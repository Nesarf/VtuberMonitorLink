// net.js — 网络层 / networking layer
// 背景（实测）：
//  1) Node 的 fetch 用 undici，**默认不读系统代理**；在直连被阻断的环境下所有抓取
//     都会 ECONNRESET / 连接超时，所以代理必须显式配置。
//  2) 但反过来，**有些站点走代理反而被拦**：bilibili 经代理访问会稳定返回
//     412 / -352（风控），直连才通。因此代理不能是全有全无的全局开关，
//     必须支持「按来源覆盖」。
//
// 于是本模块同时提供：
//   - applyProxy()      全局默认（undici 的 global dispatcher）
//   - netFetch()        显式指定 direct / proxy 的抓取
//   - playwrightProxy() 浏览器侧代理（支持按来源关闭）
import crypto from 'node:crypto';
import { Agent, ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { socksAgent, socksForPlaywright } from './socks.js';
import { decision as autoDecision } from './egress.js';

let appliedUrl = null;
let appliedMode = null;
let proxyAgent = null;
const directAgent = new Agent();

/** 当前生效的全局出口描述（null = 直连）/ currently applied global egress */
export function currentProxy() {
  return appliedUrl;
}

export function currentMode() {
  return appliedMode;
}

/** 配置里 Tor 的 SOCKS 地址 / the Tor SOCKS endpoint from config */
export function torSocksUrl(cfg) {
  return String(cfg?.proxy?.torSocks ?? '').trim() || 'socks5://127.0.0.1:9150';
}

/**
 * Tor 出口地址，可选**每次换一条链路**。
 *
 * 原理：Tor 的 IsolateSOCKSAuth（默认开）按 SOCKS 用户名隔离电路 ——
 * 用户名不同 → 电路不同 → 出口 IP 不同。实测（2026-09-12）：
 *   obs1:x → 192.42.116.48   obs2:x → 193.189.100.201   obs3:x → 45.84.107.174
 * 而不带用户名的重复请求三次都落在同一个出口（199.195.253.124）——
 * 也就是说**默认情况下整轮巡检都是同一张脸**，轮换才有意义。
 *
 * 注意：换出口不会改变「请求内容」这个更重要的信号，它只让「一次观察」不再
 * 全部挂在同一个出口上（配合取样，单次观察就不再指向「有人在盯整箱」）。
 */
export function torEgressUrl(cfg, { rotate = null, tag = null } = {}) {
  const base = torSocksUrl(cfg);
  const on = rotate ?? cfg?.observation?.rotateExit ?? false;
  if (!on) return base;
  const name = tag || `obs-${crypto.randomBytes(4).toString('hex')}`;
  // 用户名塞进 URL：socksConnector 会走用户名/密码认证那一步（Tor 只拿它做隔离）
  return base.replace(/^socks5:\/\//, `socks5://${name}:x@`);
}

function httpProxyUrl(cfg) {
  return cfg?.proxy?.enabled ? String(cfg.proxy.url ?? '').trim() : '';
}

/**
 * 按配置应用全局出口；重复调用同值则为空操作。
 * @returns {{applied: string|null, mode:'direct'|'http'|'tor', changed: boolean}}
 */
export async function applyProxy(cfg) {
  const mode = cfg?.proxy?.mode === 'tor' ? 'tor' : cfg?.proxy?.enabled ? 'http' : 'direct';
  const want = mode === 'http' ? httpProxyUrl(cfg) : mode === 'tor' ? torSocksUrl(cfg) : '';
  if (want === appliedUrl && mode === appliedMode) {
    return { applied: appliedUrl, mode, changed: false };
  }

  if (mode === 'tor') {
    setGlobalDispatcher(socksAgent(want));
  } else if (mode === 'http') {
    proxyAgent = new ProxyAgent(want);
    setGlobalDispatcher(proxyAgent);
  } else {
    setGlobalDispatcher(directAgent);
  }
  appliedUrl = mode === 'direct' ? null : want;
  appliedMode = mode;
  return { applied: appliedUrl, mode, changed: true };
}

/** 给 Playwright 的 launch/newContext 用的代理选项 / proxy option for Playwright */
export function playwrightProxy(cfg, mode) {
  if (mode === 'direct') return undefined;
  if (mode === 'tor' || (mode === undefined && cfg?.proxy?.mode === 'tor')) return socksForPlaywright(torSocksUrl(cfg));
  const want = httpProxyUrl(cfg);
  return want ? { server: want } : undefined;
}

/**
 * 解析一个来源/监视目标实际该走哪条路。
 * source.proxy: 'direct' | 'proxy' | 'tor' | 'auto' | undefined(自动，未探测过则跟随全局)
 *
 * 自动模式（默认）：按「等效延迟 = avg × (1 + 丢包 × 4)」打分，且带粘滞 ——
 * 见 egress.js。显式写了出口的来源永远优先（例如 B 站实测走代理反而 412，
 * 它的 proxy 是硬编码 'direct'，自动模式不许推翻这种实测结论）。
 * @returns {'direct'|'proxy'|'tor'}
 */
export function resolveProxyMode(cfg, subject) {
  const want = subject?.proxy;
  if (want === 'direct') return 'direct';
  if (want === 'tor') return 'tor';
  if (want === 'proxy') return 'proxy';

  // auto（或未指定）：先看有没有探测结论，没有就跟随全局配置
  if (want === 'auto' || want === undefined || want === null || want === '') {
    const d = autoDecision(cfg, subject);
    if (d && d.mode) return d.mode;
  }
  if (cfg?.proxy?.mode === 'tor') return 'tor';
  return cfg?.proxy?.enabled ? 'proxy' : 'direct';
}

/** 本机地址永远直连：把 127.0.0.1 丢给代理只会失败（本地 Ollama / mock 都是这样） */
function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
  } catch {
    return false;
  }
}

/** 按出口模式取 dispatcher / dispatcher for an egress mode */
export function dispatcherFor(cfg, mode, subject = null) {
  if (mode === 'tor') {
    // 观测模式下每次取用不同的 SOCKS 用户名 → 不同链路 → 不同出口。
    // 给 playwright 的 socksForPlaywright 也是同一条 URL，所以浏览器抓取同样受益。
    const rotate = !!cfg?.observation?.enabled && cfg?.observation?.rotateExit !== false;
    return socksAgent(torEgressUrl(cfg, { rotate, tag: subject ? `obs-${String(subject.id ?? subject.uid ?? 'x')}` : null }));
  }
  if (mode === 'proxy') {
    const want = httpProxyUrl(cfg);
    if (!want) throw new Error('该来源要求走代理，但代理未启用 / proxy required but not enabled');
    if (!proxyAgent || appliedUrl !== want || appliedMode !== 'http') {
      proxyAgent = new ProxyAgent(want);
      appliedUrl = want;
      appliedMode = 'http';
    }
    return proxyAgent;
  }
  return directAgent;
}

/**
 * 显式选择出口的 fetch。
 * @param {string} url
 * @param {object} opts  fetch 选项（dispatcher 会被覆盖）
 * @param {{cfg?:object, subject?:object, mode?:'direct'|'proxy'|'tor'}} sel
 */
export async function netFetch(url, opts = {}, sel = {}) {
  const mode = isLoopback(url) ? 'direct' : sel.mode ?? resolveProxyMode(sel.cfg, sel.subject);
  // subject 传下去是为了观测模式下的出口轮换（同一个来源固定同一条链路，
  // 不同来源分散到不同出口 —— 既不是「一个出口打全部」，也不是每次都换导致重连开销）
  return undiciFetch(url, { ...opts, dispatcher: dispatcherFor(sel.cfg, mode, sel.subject) });
}

/** 供需要自建 Agent 的场景（例如逐端口探测）使用 */
export function makeProxyAgent(url) {
  return new ProxyAgent(url);
}

export { directAgent };


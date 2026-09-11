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
export function dispatcherFor(cfg, mode) {
  if (mode === 'tor') return socksAgent(torSocksUrl(cfg));
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
  return undiciFetch(url, { ...opts, dispatcher: dispatcherFor(sel.cfg, mode) });
}

/** 供需要自建 Agent 的场景（例如逐端口探测）使用 */
export function makeProxyAgent(url) {
  return new ProxyAgent(url);
}

export { directAgent };


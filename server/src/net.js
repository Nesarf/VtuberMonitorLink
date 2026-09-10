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

let appliedUrl = null;
let proxyAgent = null;
const directAgent = new Agent();

/** 当前生效的全局代理 URL（null = 直连）/ currently applied global proxy */
export function currentProxy() {
  return appliedUrl;
}

/**
 * 按配置应用全局代理；重复调用同值则为空操作。
 * @returns {{applied: string|null, changed: boolean}}
 */
export async function applyProxy(cfg) {
  const want = cfg?.proxy?.enabled ? String(cfg.proxy.url ?? '').trim() : '';
  if (want === appliedUrl) return { applied: appliedUrl, changed: false };

  if (!want) {
    setGlobalDispatcher(directAgent);
    appliedUrl = null;
  } else {
    proxyAgent = new ProxyAgent(want);
    setGlobalDispatcher(proxyAgent);
    appliedUrl = want;
  }
  return { applied: appliedUrl, changed: true };
}

/** 给 Playwright 的 launch/newContext 用的代理选项 / proxy option for Playwright */
export function playwrightProxy(cfg, mode) {
  if (mode === 'direct') return undefined;
  const want = cfg?.proxy?.enabled ? String(cfg.proxy.url ?? '').trim() : '';
  return want ? { server: want } : undefined;
}

/**
 * 解析一个来源/监视目标实际该走哪条路。
 * source.proxy: 'direct' | 'proxy' | undefined(跟随全局)
 * @returns {'direct'|'proxy'}
 */
export function resolveProxyMode(cfg, subject) {
  const want = subject?.proxy;
  if (want === 'direct') return 'direct';
  if (want === 'proxy') return 'proxy';
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

/**
 * 显式选择出口的 fetch。
 * @param {string} url
 * @param {object} opts  fetch 选项（dispatcher 会被覆盖）
 * @param {{cfg?:object, subject?:object, mode?:'direct'|'proxy'}} sel
 */
export async function netFetch(url, opts = {}, sel = {}) {
  const mode = isLoopback(url) ? 'direct' : sel.mode ?? resolveProxyMode(sel.cfg, sel.subject);
  let dispatcher;
  if (mode === 'proxy') {
    const want = sel.cfg?.proxy?.enabled ? String(sel.cfg.proxy.url ?? '').trim() : '';
    if (!want) throw new Error('该来源要求走代理，但代理未启用 / proxy required but not enabled');
    if (!proxyAgent || appliedUrl !== want) {
      proxyAgent = new ProxyAgent(want);
      appliedUrl = want;
    }
    dispatcher = proxyAgent;
  } else {
    dispatcher = directAgent;
  }
  return undiciFetch(url, { ...opts, dispatcher });
}

/** 供需要自建 Agent 的场景（例如逐端口探测）使用 */
export function makeProxyAgent(url) {
  return new ProxyAgent(url);
}

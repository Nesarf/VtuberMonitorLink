// net.js — 网络层 / networking layer
// 背景（实测）：Node 的 fetch 用 undici，**默认不读系统代理**；
// 在直连被阻断的环境（如国内网络）下，所有抓取都会 ECONNRESET / 连接超时。
// 因此本工具把「代理」做成显式配置：设置后同时作用于
//   ① Node 侧抓取（undici ProxyAgent）
//   ② 浏览器渲染（Playwright 的 proxy 选项）
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';

let appliedUrl = null;

/** 当前生效的代理 URL（null = 直连）/ currently applied proxy */
export function currentProxy() {
  return appliedUrl;
}

/**
 * 按配置应用代理；重复调用同值则为空操作。
 * @returns {{applied: string|null, changed: boolean}}
 */
export async function applyProxy(cfg) {
  const want = cfg?.proxy?.enabled ? String(cfg.proxy.url ?? '').trim() : '';
  if (want === appliedUrl) return { applied: appliedUrl, changed: false };

  if (!want) {
    setGlobalDispatcher(new Agent());
    appliedUrl = null;
  } else {
    setGlobalDispatcher(new ProxyAgent(want));
    appliedUrl = want;
  }
  return { applied: appliedUrl, changed: true };
}

/** 给 Playwright 的 launch/newContext 用的代理选项 / proxy option for Playwright */
export function playwrightProxy(cfg) {
  const want = cfg?.proxy?.enabled ? String(cfg.proxy.url ?? '').trim() : '';
  return want ? { server: want } : undefined;
}

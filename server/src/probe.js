// probe.js — 站点连通性探测 / per-site reachability probing
//
// 网页里每个来源下方要显示「直连延迟、丢包」与「走代理延迟、丢包」，就是这里算的。
//
// 两种出口测的不是同一层，这一点必须诚实：
//   direct —— 对目标主机做 N 次 **TCP 握手**，取握手耗时当 RTT。
//             这是最接近 ping 的量，也能真实反映「这个站直连到底通不通」。
//   proxy  —— 通过本机代理发 N 次 **HTTP 请求**，取首字节时间（TTFB）。
//             因为 TCP 握手到代理 ≠ 能连上目标站，只有真发一次请求才说明问题。
//
// 两者的「丢包率」都是**失败次数 / 总次数**（超时、连不上、非 2xx/3xx 都算失败），
// 不是 ICMP 丢包 —— 界面上的措辞与提示都按这个来，不冒充 ping。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { netFetch } from './net.js';
import { resolveDir } from './config.js';
import { recordProbe } from './egress.js';

export const DEFAULT_SAMPLES = 3;
const DEFAULT_TIMEOUT = 6000;

/** 单次 TCP 握手耗时 */
function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    const sock = new net.Socket();
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      sock.destroy();
      resolve(ok ? { ok: true, ms } : { ok: false, ms, error });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code ?? e.message));
    try {
      sock.connect({ host, port });
    } catch (e) {
      done(false, e.message);
    }
  });
}

/** 单次 HTTP 首字节耗时（走哪个出口由 netFetch 决定） */
async function httpTtfb(url, cfg, mode, timeoutMs) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await netFetch(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          accept: '*/*',
          range: 'bytes=0-1023',
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      { cfg, mode }
    );
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // 只要首字节，正文立刻丢掉
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return res.status < 500 ? { ok: true, ms, status: res.status } : { ok: false, ms, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, ms, error: cause ? `${e.message}(${cause})` : e.message };
  }
}

function stats(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms);
  if (!ok.length) {
    return {
      ok: false,
      loss: 1,
      sent: samples.length,
      received: 0,
      min: null,
      avg: null,
      max: null,
      jitter: null,
      error: samples.find((s) => !s.ok)?.error ?? 'all failed',
    };
  }
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  const variance = ok.reduce((a, b) => a + (b - avg) ** 2, 0) / ok.length;
  return {
    ok: true,
    loss: (samples.length - ok.length) / samples.length,
    sent: samples.length,
    received: ok.length,
    min: Math.round(Math.min(...ok)),
    avg: Math.round(avg),
    max: Math.round(Math.max(...ok)),
    jitter: Math.round(Math.sqrt(variance)),
    error: samples.find((s) => !s.ok)?.error ?? null,
  };
}

function hostPortOf(url) {
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === 'http:' ? 80 : 443);
  return { host: u.hostname, port };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 测一个 URL 的两个出口。
 * @param {string} url
 * @param {{cfg:object, samples?:number, timeoutMs?:number|number, modes?:('direct'|'proxy')[]}} opts
 */
export async function probeUrl(url, opts = {}) {
  const { cfg } = opts;
  const samples = Math.max(1, Math.min(10, Number(opts.samples) || DEFAULT_SAMPLES));
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT;
  const modes = opts.modes ?? ['direct', 'proxy'];
  const { host, port } = hostPortOf(url);
  const out = {};

  if (modes.includes('direct')) {
    const s = [];
    for (let i = 0; i < samples; i++) {
      s.push(await tcpPing(host, port, timeoutMs));
      if (i < samples - 1) await sleep(150);
    }
    out.direct = { mode: 'direct', method: 'tcp-connect', host: `${host}:${port}`, ...stats(s) };
  }

  if (modes.includes('proxy')) {
    if (!cfg?.proxy?.enabled || !cfg?.proxy?.url) {
      out.proxy = { mode: 'proxy', method: 'http-ttfb', skipped: true, error: '代理未启用 / proxy not enabled' };
    } else {
      const s = [];
      for (let i = 0; i < samples; i++) {
        s.push(await httpTtfb(url, cfg, 'proxy', timeoutMs));
        if (i < samples - 1) await sleep(150);
      }
      out.proxy = { mode: 'proxy', method: 'http-ttfb', url, ...stats(s) };
    }
  }

  // Tor 出口：界面上每个来源都能把出口设成 Tor（Sources 页那个下拉里就有），
  // 但探测这边原先**没有这一档** —— 于是选了 Tor 的来源，测出来的却是直连/代理的数字，
  // 等于拿错出口的延迟去判断该用哪个出口。走 SOCKS 是 TCP 隧道，指标仍是「首字节时间」。
  if (modes.includes('tor')) {
    if (!cfg?.proxy?.torSocks) {
      out.tor = { mode: 'tor', method: 'socks-ttfb', skipped: true, error: '未配置 Tor SOCKS（设置 → 网络代理）' };
    } else {
      const s = [];
      for (let i = 0; i < samples; i++) {
        s.push(await httpTtfb(url, cfg, 'tor', timeoutMs));
        if (i < samples - 1) await sleep(150);
      }
      out.tor = { mode: 'tor', method: 'socks-ttfb', socks: cfg.proxy.torSocks, url, ...stats(s) };
    }
  }

  // 给出「哪个出口更合适」的结论，界面直接拿来提示。
  // 现在可能有 2~3 个出口（直连 / 代理 / Tor），所以改成「在所有测到的出口里挑最快的」，
  // 并把不通的那些说出来 —— 只对比两个出口的老写法在加了 Tor 之后会漏掉一路。
  const d = out.direct;
  const p = out.proxy;
  const tor = out.tor;
  const usable = [d, p, tor].filter((x) => x && x.ok && !x.skipped);
  const blocked = [d, p, tor].filter((x) => x && !x.ok && !x.skipped).map((x) => x.mode);
  let verdict = 'unknown';
  let hint = '';
  if (usable.length) {
    const best = usable.slice().sort((a, b) => a.avg - b.avg)[0];
    verdict = best.mode;
    const parts = usable.map((x) => `${x.mode} ${x.avg}ms`).join(' / ');
    hint = usable.length > 1 ? `${best.mode} 最快（${parts}）` : `${best.mode} 可用（${parts}）`;
    if (blocked.length) hint += `；${blocked.join(' / ')} 不通`;
  } else if (blocked.length) {
    verdict = 'none';
    hint = `${blocked.join(' / ')} 都不通`;
  } else if (d) {
    verdict = d.ok ? 'direct' : 'none';
    hint = d.ok ? '直连可用（其它出口未测）' : `直连不通：${d.error ?? '?'}`;
  } else if (p?.skipped) {
    verdict = 'unknown';
    hint = `代理未启用（${p.error}）`;
  } else if (tor?.skipped) {
    verdict = 'unknown';
    hint = `Tor 未配置（${tor.error}）`;
  }

  return { url, host, at: new Date().toISOString(), modes: out, verdict, hint };
}

// ───────────────────────────────────────── 缓存 / cache

function cachePath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'probe.json');
}

export function loadCache(cfg) {
  try {
    const f = cachePath(cfg);
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

export function saveCache(cfg, data) {
  try {
    const f = cachePath(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 1), 'utf8');
  } catch {
    /* ignore */
  }
}

export function updateCache(cfg, entries) {
  const cache = loadCache(cfg);
  for (const e of entries) cache[e.id] = e;
  saveCache(cfg, cache);
  // 探测结果同时喂给「自动出口」判定：这样每个站点都会自己长出最合适的出口
  try {
    for (const e of entries) recordProbe(cfg, { subject: e.subject ?? { id: e.id, name: e.name, url: e.url }, probe: e });
  } catch {
    // 判定失败不该让探测接口跟着失败
  }
  return cache;
}

/** 判断缓存是否还算新鲜 / is the cached result still fresh */
export function isFresh(entry, ttlMinutes = 30) {
  if (!entry?.at) return false;
  return Date.now() - Date.parse(entry.at) < ttlMinutes * 60_000;
}

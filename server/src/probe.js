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

  // 给出「哪个出口更合适」的结论，界面直接拿来提示
  const d = out.direct;
  const p = out.proxy;
  let verdict = 'unknown';
  let hint = '';
  if (d && p && !p.skipped) {
    if (d.ok && p.ok) {
      verdict = d.avg <= p.avg ? 'direct' : 'proxy';
      hint = verdict === 'direct' ? `直连更快（${d.avg}ms vs ${p.avg}ms）` : `代理更快（${p.avg}ms vs ${d.avg}ms）`;
    } else if (d.ok && !p.ok) {
      verdict = 'direct';
      hint = '直连可用，代理不通';
    } else if (!d.ok && p.ok) {
      verdict = 'proxy';
      hint = `直连不通（${d.error ?? '?'}），必须走代理`;
    } else {
      verdict = 'none';
      hint = '两个出口都不通';
    }
    if (d.ok && p.ok && d.loss > 0 && p.loss === 0) {
      verdict = 'proxy';
      hint = `直连丢包 ${Math.round(d.loss * 100)}%，代理稳定`;
    }
  } else if (d) {
    verdict = d.ok ? 'direct' : 'none';
    hint = d.ok ? '直连可用（代理未启用，未对比）' : `直连不通：${d.error ?? '?'}`;
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
  return cache;
}

/** 判断缓存是否还算新鲜 / is the cached result still fresh */
export function isFresh(entry, ttlMinutes = 30) {
  if (!entry?.at) return false;
  return Date.now() - Date.parse(entry.at) < ttlMinutes * 60_000;
}

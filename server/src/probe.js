// probe.js — per-site reachability probing
//
// The "direct latency and loss" and "proxy latency and loss" shown under every source in the web UI
// are computed here.
//
// The two egresses do not measure the same layer, and that has to be stated honestly:
//   direct —— N **TCP handshakes** to the target host, with the handshake time taken as the RTT.
//             This is the quantity closest to ping, and it also honestly reflects "can this site be
//             reached on a direct connection at all".
//   proxy  —— N **HTTP requests** through the local proxy, taking the time to first byte (TTFB).
//             Because a TCP handshake to the proxy does not equal reaching the target site, only
//             actually sending a request proves anything.
//
// The "loss rate" of both is **failures / total attempts** (timeouts, unreachable, non-2xx/3xx all
// count as failures), not ICMP loss —— the wording and hints in the UI follow that and do not pretend to be ping.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { netFetch } from './net.js';
import { resolveDir } from './config.js';
import { recordProbe } from './egress.js';

export const DEFAULT_SAMPLES = 3;
const DEFAULT_TIMEOUT = 6000;

/** Latency of a single TCP handshake */
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

/** Time to first byte of a single HTTP request (which egress is used is decided by netFetch) */
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
    // Only the first byte is wanted, so the body is dropped immediately
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
 * Probe both egresses of one URL.
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

  // Tor egress: in the UI every source can have its egress set to Tor (the dropdown on the Sources page has it),
  // but probing previously had **no such tier** —— so for a source set to Tor the numbers measured were the
  // direct/proxy ones, meaning the latency of the wrong egress was used to decide which egress to use.
  // Going over SOCKS is a TCP tunnel, but the metric is still "time to first byte".
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

  // Produce a "which egress fits better" conclusion that the UI can turn straight into a hint.
  // There can now be 2~3 egresses (direct / proxy / Tor), so this was changed to "pick the fastest of
  // every egress actually measured" and to name the ones that do not work —— the old two-way comparison
  // would miss one route once Tor was added.
  const d = out.direct;
  const p = out.proxy;
  const tor = out.tor;
  const usable = [d, p, tor].filter((x) => x && x.ok && !x.skipped);
  const blocked = [d, p, tor].filter((x) => x && !x.ok && !x.skipped).map((x) => x.mode);
  let verdict = 'unknown';
  // The hint is shown verbatim in the Sources page (a toast after "probe now" and the auto-egress
  // tooltip), so it is product copy and stays in the product's language — see docs/ENGLISH-LOGIC.md.
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

// ───────────────────────────────────────── cache

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
  // Probe results are fed to the "automatic egress" verdict too, so every site grows the most suitable egress on its own
  try {
    for (const e of entries) recordProbe(cfg, { subject: e.subject ?? { id: e.id, name: e.name, url: e.url }, probe: e });
  } catch {
    // A failed verdict must not make the probe endpoint fail along with it
  }
  return cache;
}

/** Is the cached result still fresh */
export function isFresh(entry, ttlMinutes = 30) {
  if (!entry?.at) return false;
  return Date.now() - Date.parse(entry.at) < ttlMinutes * 60_000;
}

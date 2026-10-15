// proxyctl.js — proxy core control (the RESTful API mihomo / Clash.Meta are compatible with)
//
// Goal: from the web UI, see the node list, see **each node's delay to one specific site**, and switch with one click.
// mihomo's /proxies/<node>/delay already accepts a url parameter, so "pick the fastest node for a given site"
// is something that can genuinely be done, not folklore.
//
// Note: this path only talks over the local loopback (the control endpoint defaults to 127.0.0.1), and netFetch
// always connects directly for loopback, so it can never be routed through the proxy we configured ourselves.
//
// ── why discovery was rewritten (measured on a real machine, 2026-10-15) ─────────────────────────────────────
//
// The first version probed six common ports and, finding nothing, said only that no local proxy control interface
// had been found. On this machine that message was both true and useless: the running core is a client's bundled
// mihomo, started with `-d "<the client's extra directory>"`, whose `config.yaml` has **no `external-controller`
// at all** - so no port would ever answer, and nothing told the user that the core had been found, where it was,
// or what to change. A client that manages its own core often ships with the controller off.
//
// So discovery now reads the running core's **own command line** (`-d <dir>`, `-f/--config <file>`), reads that
// file, and reports what it found there - including the case that matters most here: a core was found and its
// configuration does not expose a controller. The port scan stays as a fallback, and the diagnosis always says
// which of these happened rather than "not found", with a machine-readable `code` the caller can branch on.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { netFetch } from './net.js';

const run = promisify(execFile);

const COMMON_PORTS = [9090, 9790, 9097, 6170, 63333, 9091];
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';

/**
 * Where a running core keeps its configuration, from its own command line.
 *
 * `-d <dir>` is mihomo's working directory and `-f`/`--config` its file; both quoting styles appear in the wild
 * (`-d "C:\Program Files\..."`). With neither, mihomo's convention is that the working directory is the one the
 * executable sits in - which is exactly how the client on this machine starts it, so the fallback is not a
 * guess but the documented behaviour of the flag being absent.
 *
 * Exported because it is pure, and because the shape it parses is the part that goes wrong silently.
 */
export function coreConfigFromCommandLine(commandLine, executablePath = '') {
  const cmd = String(commandLine ?? '');
  const argOf = (flags) => {
    for (const flag of flags) {
      const m = new RegExp(`(?:^|\\s)${flag}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s]+))`).exec(cmd);
      const value = m?.[1] ?? m?.[2] ?? m?.[3];
      if (value) return value;
    }
    return '';
  };
  const file = argOf(['--config', '-f']);
  const dir = argOf(['-d', '--directory', '--dir']);
  if (file) return { file, dir: dir || path.dirname(file) };
  if (dir) return { file: path.join(dir, 'config.yaml'), dir };
  if (executablePath) return { file: path.join(path.dirname(executablePath), 'config.yaml'), dir: path.dirname(executablePath) };
  return { file: '', dir: '' };
}

/**
 * The control endpoint a core's configuration declares, or the reason it declares none.
 *
 * `external-controller` is `host:port` (mihomo also accepts a bare port in some versions); `0.0.0.0`/`::` is
 * mapped to loopback because that is the only address this app talks to. The secret is **reported as a boolean**:
 * it is a credential, it never leaves the process, and the caller only needs to know whether to send it.
 */
export function controllerFromConfig(text) {
  const source = String(text ?? '');
  if (source.trim() === '') return { ok: false, reason: 'empty' };
  let doc = null;
  try {
    doc = YAML.parse(source);
  } catch (e) {
    return { ok: false, reason: 'unparsable', detail: e.message.split('\n')[0] };
  }
  if (doc === null || doc === undefined) return { ok: false, reason: 'empty' };
  if (typeof doc !== 'object') {
    // A document that parses into a scalar has content this function cannot read a controller out of, and that is
    // not the same thing as an empty file. Measured on this machine: MAOMAOYUN keeps `config.yaml` as **340928
    // bytes of base64** - every byte printable, no newlines - and YAML reads that as one long string. Reporting it
    // as "empty" sends the user looking for a file that is not empty and cannot be edited as YAML, instead of at
    // the two things that would actually help: the client's own controller setting, or filling the address in by
    // hand. The byte count travels with the verdict so the message can say how much content there was.
    return { ok: false, reason: 'not-a-mapping', kind: typeof doc, bytes: source.length };
  }
  const raw = doc['external-controller'];
  const hasSecret = typeof doc.secret === 'string' && doc.secret.trim() !== '';
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: false, reason: 'no-external-controller', hasSecret };
  }
  const value = String(raw).trim();
  const withPort = /^\d+$/.test(value) ? `127.0.0.1:${value}` : value;
  const host = withPort.replace(/^\[([^\]]+)\]/, '$1').split(':')[0];
  const port = withPort.split(':').pop();
  const loopback = ['0.0.0.0', '::', '[::]', 'localhost', ''].includes(host) ? '127.0.0.1' : host;
  return { ok: true, url: `http://${loopback}:${port}`, host: loopback, port, hasSecret, declared: value };
}

/**
 * What to tell the user, given what discovery actually found, as `{ code, message }`.
 *
 * `code` is machine-readable and ASCII on purpose: the panel can branch on it later, and a test can assert the
 * *branch* rather than a substring of a sentence - which is how the first version of these assertions ended up
 * looking for Chinese text inside code (and being refused by the repository's English-only rule for the
 * engineering layer, correctly).
 */
export function controlDiagnosis({ cores = [], config = null, probed = [] } = {}) {
  const ports = probed.length ? probed.join(', ') : COMMON_PORTS.join(', ');
  if (!cores.length) {
    return {
      code: 'no-core',
      message:
        `未发现正在运行的本机代理核心（mihomo / Clash），已探测端口 ${ports}。` +
        '如果内核在别处运行，请在“设置 → 代理”里直接填控制接口地址（external-controller）与密钥。',
    };
  }
  const core = cores[0];
  if (config?.ok) {
    return {
      code: 'controller-silent',
      message: `发现代理核心 ${core.name}（配置 ${config.file}），它声明了控制接口 ${config.declared}，但该接口没有应答（已探测端口 ${ports}）。`,
    };
  }
  if (config?.reason === 'no-external-controller') {
    return {
      code: 'no-external-controller',
      message:
        `发现正在运行的代理核心 ${core.name}（配置 ${config.file}），但该配置里**没有 external-controller**，` +
        '所以没有任何端口可以应答 - 这是客户端自带内核的常见配置。两种修法：在该客户端的配置/设置里启用 external-controller，' +
        '或在“设置 → 代理”里手动填写控制接口地址与密钥。',
    };
  }
  if (config?.reason === 'unparsable') {
    return {
      code: 'config-unparsable',
      message: `发现代理核心 ${core.name}，配置文件 ${config.file} 无法解析（${config.detail}），无法从中读出控制接口。`,
    };
  }
  if (config?.reason === 'not-a-mapping') {
    return {
      code: 'config-not-yaml',
      message:
        `发现正在运行的代理核心 ${core.name}，配置文件 ${config.file} 里有 ${config.bytes} 字节内容，但它不是 YAML 配置` +
        `（解析出来是 ${config.kind}）—— 有些客户端把这个文件加密或编码保存，所以从里面读不到 external-controller。` +
        '两种修法：在该客户端自己的设置里查看/启用控制接口（external-controller），或在“设置 → 代理”里手动填写控制接口地址与密钥。',
    };
  }
  if (config?.reason === 'empty') {
    return {
      code: 'config-empty',
      message:
        `发现正在运行的代理核心 ${core.name}，但它的配置文件 ${config.file} 是空的（0 字节或只有空白）—— ` +
        '内核还没写出配置，或客户端把真正的配置存在别处。请在“设置 → 代理”里手动填写控制接口地址与密钥。',
    };
  }
  return {
    code: 'config-unreadable',
    message: `发现代理核心 ${core.name}，但读不到它的配置（${core.file || '未知路径'}）。请在“设置 → 代理”里手动填写控制接口地址与密钥。`,
  };
}

/** The control endpoint the configuration names explicitly, trailing slashes removed. */
function controlUrl(cfg) {
  const explicit = String(cfg?.proxy?.controlUrl ?? '').trim();
  return explicit.replace(/\/+$/, '');
}

/** The headers one control request carries; the secret is never logged and never leaves the process. */
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

/**
 * The proxy cores running on this machine, with the configuration file each one was started against.
 *
 * Windows-only and deliberately tolerant: no PowerShell (or a non-Windows host) means "no cores found", which the
 * diagnosis then reports as such. This is a user-triggered action (the panel's probe button), not a hot path, and
 * the command is bounded by a timeout so a wedged host cannot hang the request.
 */
async function runningCores() {
  if (process.platform !== 'win32') return [];
  let out = '';
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name LIKE '%mihomo%' OR Name LIKE '%clash%'\" | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
      ],
      { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    out = stdout;
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(out || '[]');
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((p) => p && p.Name)
    .map((p) => {
      const where = coreConfigFromCommandLine(p.CommandLine, p.ExecutablePath ?? '');
      return { name: p.Name, file: where.file, dir: where.dir };
    });
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
  if (found.length) return { ok: true, ...found[0], alternatives: found.slice(1), probed: COMMON_PORTS.length };

  // Nothing answered on the usual ports. Before saying "not found", look at the cores that are actually running:
  // their own configuration is the authoritative answer to "where would the controller be", and the case that
  // produced this code is a core that runs perfectly well with **no** external-controller declared at all.
  const cores = await runningCores();
  const core = cores[0];
  let config = null;
  if (core?.file) {
    let text = '';
    try {
      text = fs.readFileSync(core.file, 'utf8');
    } catch (e) {
      config = { ok: false, reason: 'unreadable', detail: e.message.split('\n')[0], file: core.file };
    }
    if (config === null) {
      config = { ...controllerFromConfig(text), file: core.file };
      // A declaration we can read is worth probing before giving up: the same core on a non-default port is the
      // other common shape, and one request settles it.
      if (config.ok) {
        try {
          const cfgWith = { ...(cfg ?? {}), proxy: { ...(cfg?.proxy ?? {}), controlUrl: config.url, controlSecret: config.hasSecret ? cfg?.proxy?.controlSecret : '' } };
          const v = await jget(`${config.url}/version`, cfgWith, 2500);
          return { ok: true, url: config.url, version: v.version ?? '?', meta: !!v.meta, probed: COMMON_PORTS.length, discoveredFrom: core.file };
        } catch (e) {
          config = { ...config, probeError: e.message };
        }
      }
    }
  }
  const diagnosis = controlDiagnosis({ cores, config, probed: COMMON_PORTS });
  return {
    ok: false,
    error: diagnosis.message,
    code: diagnosis.code,
    cores,
    config,
    probed: COMMON_PORTS.length,
  };
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

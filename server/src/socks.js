// socks.js — dependency-free SOCKS5 connector
//
// Why this has to be written by hand: undici's ProxyAgent **only supports http(s) proxies**, while Tor exposes
// SOCKS5 (Tor Browser defaults to 127.0.0.1:9150, a standalone tor to 9050).
// undici's Agent lets you pass a custom `connect`, so a SOCKS5 handshake is implemented here,
// the tunnelled socket is handed back, and everything else (TLS, HTTP, the proxy chain) is left to undici as usual.
//
// Supported: no auth / username-password auth; the target is sent as a domain name (atyp=3) for the proxy to resolve,
// so DNS never leaves this machine — which matters a lot for "anonymizing".
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { Agent } from 'undici';

const SOCKS_VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_UNACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV4 = 0x01;
const ATYP_IPV6 = 0x04;

function parseSocksUrl(url) {
  const u = new URL(String(url).includes('://') ? url : `socks5://${url}`);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port) || 1080,
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

/**
 * Build a connect function undici can use.
 * @param {{url:string}} opts e.g. { url: 'socks5://127.0.0.1:9150' }
 */
export function socksConnector(opts) {
  const proxy = parseSocksUrl(opts.url);

  return function connect(options, callback) {
    const targetHost = options.hostname ?? options.host;
    const targetPort = Number(options.port) || 443;
    if (!targetHost) return callback(new Error('socks: no target host'));

    // ⚠️ Once a custom connect is passed, **TLS becomes our job**.
    // undici's built-in connector does "https target -> tls.connect"; since we replaced it,
    // we have to add that step ourselves — skip it and the handshake still succeeds, but the plaintext request
    // gets written into port 443. The real symptom is `400 The plain HTTP request was sent to HTTPS port`,
    // while the probe endpoint only says "port is open, but the exit check failed", which looks like a Tor problem (we have been burned by this before).
    const wantsTls = options.protocol === 'https:' || options.secureEndpoint === true;
    const servername = options.servername ?? targetHost;

    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const fail = (msg) => {
      socket.destroy();
      callback(new Error(`socks5 ${stage}: ${msg}`));
    };

    socket.setTimeout(30000, () => fail('timeout'));
    socket.once('error', (e) => callback(e));

    const sendGreeting = () => {
      const methods = proxy.username ? [AUTH_NONE, AUTH_USERPASS] : [AUTH_NONE];
      socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));
    };

    const sendUserPass = () => {
      const u = Buffer.from(proxy.username, 'utf8');
      const p = Buffer.from(proxy.password, 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    };

    const sendConnect = () => {
      const host = Buffer.from(String(targetHost), 'utf8');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(targetPort, 0);
      socket.write(Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00, ATYP_DOMAIN, host.length]), host, port]));
    };

    socket.on('connect', sendGreeting);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === AUTH_UNACCEPTABLE) return fail('no acceptable auth method');
        if (method === AUTH_USERPASS) {
          stage = 'auth';
          sendUserPass();
          return;
        }
        stage = 'reply';
        sendConnect();
        return;
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ok = buf[1] === 0x00;
        buf = buf.subarray(2);
        if (!ok) return fail('username/password rejected');
        stage = 'reply';
        sendConnect();
        return;
      }

      if (stage === 'reply') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) {
          const reasons = {
            1: 'general failure',
            2: 'connection not allowed',
            3: 'network unreachable',
            4: 'host unreachable',
            5: 'connection refused',
            6: 'TTL expired',
            7: 'command not supported',
            8: 'address type not supported',
          };
          return fail(reasons[buf[1]] ?? `reply code ${buf[1]}`);
        }
        const atyp = buf[3];
        const need = atyp === ATYP_IPV4 ? 4 + 4 + 2 : atyp === ATYP_IPV6 ? 4 + 16 + 2 : 4 + 1 + buf[4] + 2;
        if (buf.length < need) return;
        // Handshake done: hand the socket back to undici (an https target must be wrapped in TLS first)
        stage = 'done';
        socket.removeAllListeners('data');
        socket.setTimeout(0);

        if (!wantsTls) return callback(null, socket);

        let tlsSocket;
        try {
          tlsSocket = tls.connect({ socket, servername, host: targetHost });
        } catch (e) {
          socket.destroy();
          return callback(e);
        }
        const tlsTimer = setTimeout(() => {
          tlsSocket.destroy();
          callback(new Error('socks5: TLS handshake timeout'));
        }, 30000);
        tlsSocket.once('error', (e) => {
          clearTimeout(tlsTimer);
          callback(e);
        });
        tlsSocket.once('secureConnect', () => {
          clearTimeout(tlsTimer);
          callback(null, tlsSocket);
        });
      }
    });
  };
}

const agents = new Map();

/** Get (and cache) an undici Agent that goes through SOCKS */
export function socksAgent(socksUrl) {
  const key = String(socksUrl);
  if (!agents.has(key)) agents.set(key, new Agent({ connect: socksConnector({ url: key }) }));
  return agents.get(key);
}

/** Playwright supports socks5:// natively, so it needs no handshake from us */
export function socksForPlaywright(socksUrl) {
  const p = parseSocksUrl(socksUrl);
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
  return { server: `socks5://${auth}${p.host}:${p.port}` };
}

/**
 * What arguments "one-click launch Tor" actually needs — extracted into a pure function so that its arguments can be asserted on.
 *
 * Why the exe cannot simply be spawned bare (the original implementation spawned it bare):
 *   1. Tor Browser's tor.exe **depends on its own torrc** (bridges, pluggable transports and the data directory all live there).
 *      Without that config it falls back to defaults: SocksPort 9050 (not the 9150 we configured), no bridges,
 *      and the data directory lands in %LOCALAPPDATA%\tor (i.e. the C: drive — this project has always kept the "never write to C:" rule).
 *   2. torrc-defaults has to be passed as `--defaults-torrc`: the command line only allows one `-f`, and
 *      passing two is rejected (Tor logs "Duplicate -f options" and reads only the last one — which means
 *      snowflake's ClientTransportPlugin is dropped entirely and the log says
 *      "there is no configured transport called snowflake").
 *   3. When Tor Browser exits it leaves `DisableNetwork 1` behind in torrc, and that has to be overridden explicitly,
 *      otherwise it starts up and never connects (it just sits at "Bootstrapped 0%" forever).
 */
export function torLaunchPlan({ exe, socksUrl, appRoot }) {
  if (!exe) return { ok: false, error: '没有配置 torExe' };
  const port = parseSocksUrl(socksUrl || 'socks5://127.0.0.1:9150').port;
  const dir = path.dirname(exe);
  const browserDir = path.resolve(dir, '..', '..'); // ...\Browser\TorBrowser\Tor → ...\Browser
  const dataDir = path.join(browserDir, 'TorBrowser', 'Data', 'Tor');
  const torrc = path.join(dataDir, 'torrc');
  const defaults = path.join(dataDir, 'torrc-defaults');

  if (fs.existsSync(torrc)) {
    const args = ['-f', torrc, '--SocksPort', String(port), '--DisableNetwork', '0'];
    if (fs.existsSync(defaults)) args.unshift('--defaults-torrc', defaults);
    return {
      ok: true,
      kind: 'tor-browser',
      cwd: browserDir,
      args,
      command: `${exe} ${args.join(' ')}`,
      note: '按 Tor Browser 自己的配置启动（含网桥与可插拔传输），并覆盖 DisableNetwork',
    };
  }

  // Standalone tor: point the data directory explicitly at the app directory so it does not write to the C: drive
  const own = appRoot ? path.join(appRoot, 'tor-data') : path.join(dir, 'tor-data');
  const args = ['--SocksPort', `127.0.0.1:${port}`, '--DataDirectory', own];
  return { ok: true, kind: 'standalone', cwd: dir, args, command: `${exe} ${args.join(' ')}`, note: `独立 tor，数据目录放在 ${own}（不写 C 盘）` };
}

/**
 * Is Tor's SOCKS port reachable at all (a plain TCP connect, 1~2 seconds per call).
 *
 * Use: ask once before observation mode starts — if it is down, skip the "sources that go through Tor this round"
 * instead of letting them fail one by one (a failure is recorded as a source fault and also triggers self-check noise).
 * A snowflake bridge is not always online; this kind of momentary disconnection has been seen in practice.
 */
export async function torPortOpen(socksUrl, { timeout = 1500 } = {}) {
  const p = parseSocksUrl(socksUrl || 'socks5://127.0.0.1:9150');
  return new Promise((resolve) => {
    const s = net.connect({ host: p.host, port: p.port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * Probe whether the SOCKS port works and confirm it really is Tor (by checking whether the exit IP is classified as Tor).
 * No third-party library involved; if it fails, report the failure honestly.
 */
export async function probeTor(cfg, socksUrl, { timeout = 12000 } = {}) {
  const url = socksUrl || 'socks5://127.0.0.1:9150';
  const p = parseSocksUrl(url);
  const reachable = await new Promise((resolve) => {
    const s = net.connect({ host: p.host, port: p.port });
    const done = (ok, err) => {
      s.destroy();
      resolve({ ok, err });
    };
    s.setTimeout(3000, () => done(false, 'connect timeout'));
    s.once('connect', () => done(true));
    s.once('error', (e) => done(false, e.code ?? e.message));
  });
  if (!reachable.ok) {
    return { ok: false, socks: `${p.host}:${p.port}`, error: `SOCKS 端口不可用（${reachable.err}）—— Tor 没在跑？` };
  }
  try {
    const res = await fetch('https://check.torproject.org/api/ip', {
      dispatcher: socksAgent(url),
      signal: AbortSignal.timeout(timeout),
    });
    const j = await res.json();
    return { ok: true, socks: `${p.host}:${p.port}`, isTor: !!j.IsTor, ip: j.IP ?? null };
  } catch (e) {
    return { ok: true, socks: `${p.host}:${p.port}`, isTor: null, ip: null, warning: `端口通，但出口检测失败：${e.message}` };
  }
}

export { parseSocksUrl };

// socks.js — 零依赖 SOCKS5 连接器 / dependency-free SOCKS5 connector
//
// 为什么必须自己写：undici 的 ProxyAgent **只支持 http(s) 代理**，而 Tor 暴露的是
// SOCKS5（Tor Browser 默认 127.0.0.1:9150，独立 tor 默认 9050）。
// undici 的 Agent 允许传自定义 `connect`，所以这里实现一个 SOCKS5 握手，
// 把隧道 socket 交回去，其余（TLS、HTTP、代理链）交给 undici 正常处理。
//
// 支持：无认证 / 用户名密码认证；目标地址用域名（atyp=3）交给代理解析，
// 这样 DNS 也不出本机 —— 对「无痕化」这点很重要。
import net from 'node:net';
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
 * 造一个 undici 能用的 connect 函数。
 * @param {{url:string}} opts 例如 { url: 'socks5://127.0.0.1:9150' }
 */
export function socksConnector(opts) {
  const proxy = parseSocksUrl(opts.url);

  return function connect(options, callback) {
    const targetHost = options.hostname ?? options.host;
    const targetPort = Number(options.port) || 443;
    if (!targetHost) return callback(new Error('socks: no target host'));

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
        // 握手完成，把 socket 交还给 undici
        stage = 'done';
        socket.removeAllListeners('data');
        socket.setTimeout(0);
        callback(null, socket);
      }
    });
  };
}

const agents = new Map();

/** 取（并缓存）一个走 SOCKS 的 undici Agent */
export function socksAgent(socksUrl) {
  const key = String(socksUrl);
  if (!agents.has(key)) agents.set(key, new Agent({ connect: socksConnector({ url: key }) }));
  return agents.get(key);
}

/** Playwright 原生支持 socks5://，不需要我们自己做握手 */
export function socksForPlaywright(socksUrl) {
  const p = parseSocksUrl(socksUrl);
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
  return { server: `socks5://${auth}${p.host}:${p.port}` };
}

/**
 * 探测 SOCKS 端口是否可用，并确认它确实是 Tor（看出口 IP 是否被判为 Tor）。
 * 不依赖任何第三方库；失败就如实报错。
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

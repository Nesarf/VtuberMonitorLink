// socks-test.mjs — SOCKS5 连接器的自检 / self-test for the hand-written SOCKS5 connector
//
// 为什么需要：这条路**以前只测到「端口不通」就结束了**（Tor 没起来时探测返回
// ECONNREFUSED，看起来像"功能正常，只是没开 Tor"）。于是 TLS 这一段从没被跑过，
// 而它恰恰是坏的：握手完成后我们把**裸 socket** 交给了 undici，
// 于是明文的 `GET /api/ip HTTP/1.1` 被发到目标 443 端口 —— 真实表现是
// `400 The plain HTTP request was sent to HTTPS port`，而 app 的探测只报
// 「端口通，但出口检测失败」，看起来像 Tor 的问题。
//
// 这里的判据不需要证书、不需要联网：起一个**假 SOCKS 服务**（转发到本地假目标），
// 然后看隧道里第一段字节到底是 TLS ClientHello（0x16）还是明文 HTTP。
import assert from 'node:assert/strict';
import net from 'node:net';
import { socksAgent, torLaunchPlan } from '../server/src/socks.js';

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

// ── 假 SOCKS5 服务：只实现无认证 + CONNECT，把连接**一律转发到假目标**
// （注意：不能真去连请求里的主机名 —— 那是个 .invalid 域名，连不上；
//   这里的假代理只负责把隧道对上，好让我们观察客户端到底往里写了什么）
function fakeSocks(targetPort) {
  const seen = [];
  const server = net.createServer((sock) => {
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    let upstream = null;
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2 + buf[1]) return;
        sock.write(Buffer.from([0x05, 0x00]));
        buf = buf.subarray(2 + buf[1]);
        stage = 'req';
      }
      if (stage === 'req') {
        if (buf.length < 7) return;
        const atyp = buf[3];
        let host;
        let port;
        let rest;
        if (atyp === 3) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString('utf8');
          port = buf.readUInt16BE(5 + len);
          rest = buf.subarray(5 + len + 2);
        } else {
          if (buf.length < 4 + 4 + 2) return;
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          port = buf.readUInt16BE(8);
          rest = buf.subarray(10);
        }
        seen.push({ atyp, host, port });
        // 先暂停客户端 socket：上游连上之前到达的字节会被 'data' 监听吃掉，
        // 那样明明握手成功了目标却收不到请求（我第一次写这个假服务就是这个坑）。
        sock.pause();
        upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          sock.pipe(upstream);
          upstream.pipe(sock);
          sock.resume();
        });
        upstream.on('error', () => sock.destroy());
        stage = 'pipe';
      }
    });
  });
  return { server, seen };
}

// ── 假目标：把收到的第一段字节记下来（客户端随后会因为我们不是真 TLS 而报错，无所谓）
function fakeOrigin() {
  const state = { first: null, raw: Buffer.alloc(0) };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', (chunk) => {
      state.first = chunk[0];
      state.raw = chunk;
      sock.destroy();
    });
  });
  return { server, state };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const origin = fakeOrigin();
const originPort = await listen(origin.server);
const socks = fakeSocks(originPort);
const socksPort = await listen(socks.server);
const agent = socksAgent(`socks5://127.0.0.1:${socksPort}`);

process.stdout.write('\nsocks: SOCKS5 连接器\n');

await t('握手时把**域名**交给代理解析（DNS 不出本机）', async () => {
  await fetch(`http://vml-test-host.invalid:${originPort}/x`, { dispatcher: agent, signal: AbortSignal.timeout(4000) }).catch(() => {});
  const last = socks.seen.at(-1);
  assert.ok(last, '假 SOCKS 服务没收到 CONNECT');
  assert.equal(last.atyp, 3, 'atyp 应为 3（域名），实际 ' + last.atyp);
  assert.equal(last.host, 'vml-test-host.invalid');
  assert.equal(last.port, originPort);
});

await t('http:// 目标：隧道里就是明文 HTTP', async () => {
  origin.state.first = null;
  let err = null;
  await fetch(`http://vml-test-host.invalid:${originPort}/x`, { dispatcher: agent, signal: AbortSignal.timeout(4000) }).catch((e) => {
    err = e;
  });
  assert.equal(origin.state.first, 0x47, '应以 "G"（GET）开头，实际字节 ' + origin.state.first + ' · fetch 错误: ' + (err ? err.message : '无'));
});

await t('https:// 目标：隧道里必须是 TLS ClientHello（0x16），不是明文 HTTP', async () => {
  origin.state.first = null;
  origin.state.raw = Buffer.alloc(0);
  await fetch(`https://vml-test-host.invalid:${originPort}/x`, { dispatcher: agent, signal: AbortSignal.timeout(4000) }).catch(() => {});
  assert.ok(origin.state.first !== null, '目标没收到任何字节');
  assert.equal(
    origin.state.first,
    0x16,
    '第一字节应为 0x16（TLS handshake），实际 ' +
      origin.state.first +
      ' —— 明文 ' +
      JSON.stringify(origin.state.raw.subarray(0, 20).toString('utf8')),
  );
});

// ── 真实 Tor 可选验证（有这个 SOCKS 端口时才跑）
const torUp = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 9150 });
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

if (torUp) {
  await t('真 Tor：经 SOCKS 出去，check.torproject.org 判为 Tor 出口', async () => {
    const res = await fetch('https://check.torproject.org/api/ip', {
      dispatcher: socksAgent('socks5://127.0.0.1:9150'),
      signal: AbortSignal.timeout(45000),
    });
    assert.equal(res.status, 200, 'HTTP ' + res.status);
    const j = await res.json();
    assert.equal(j.IsTor, true, JSON.stringify(j));
    assert.ok(j.IP, '应当有出口 IP');
    process.stdout.write('         出口: ' + j.IP + '\n');
  });
} else {
  process.stdout.write('  [skip] 真 Tor（127.0.0.1:9150 没在监听）\n');
}

// ── 「一键唤起 Tor」的参数构造（纯函数，离线可断言）
process.stdout.write('\nsocks: 唤起 Tor 的参数\n');

const TB_EXE = 'E:\\Tor Browser\\Browser\\TorBrowser\\Tor\\tor.exe';
const realPlan = torLaunchPlan({ exe: TB_EXE, socksUrl: 'socks5://127.0.0.1:9150', appRoot: 'E:\\VtuberMonitorLink\\dist\\VtuberMonitorLink\\app' });

await t('Tor Browser 布局：带 --defaults-torrc + 自己的 torrc，并覆盖 DisableNetwork', async () => {
  if (!realPlan.ok) {
    // 这台机器上没装 Tor Browser 时，用假布局验证逻辑本身
    const fake = torLaunchPlan({ exe: 'X:\\nope\\TorBrowser\\Tor\\tor.exe', socksUrl: 'socks5://127.0.0.1:9150' });
    assert.equal(fake.kind, 'standalone', '没有 torrc 时应退回独立 tor 分支');
    return;
  }
  assert.equal(realPlan.kind, 'tor-browser', JSON.stringify(realPlan));
  assert.ok(realPlan.args.includes('--defaults-torrc'), '必须用 --defaults-torrc（-f 传两个会被 Tor 拒）');
  assert.ok(realPlan.args.includes('-f'), '必须带 torrc');
  assert.ok(realPlan.args.includes('--DisableNetwork') && realPlan.args.includes('0'), '必须显式打开网络（Tor Browser 会在 torrc 里留 DisableNetwork 1）');
  assert.equal(realPlan.args[realPlan.args.indexOf('--SocksPort') + 1], '9150', '端口要跟配置一致');
  assert.ok(/Browser$/.test(realPlan.cwd), 'cwd 必须是 Browser 目录（可插拔传输用的是相对路径）: ' + realPlan.cwd);
});

await t('独立 tor：数据目录放在应用目录里，绝不写 C 盘', async () => {
  const plan = torLaunchPlan({ exe: 'X:\\tor\\tor.exe', socksUrl: 'socks5://127.0.0.1:9050', appRoot: 'E:\\App' });
  assert.equal(plan.kind, 'standalone');
  const dataDir = plan.args[plan.args.indexOf('--DataDirectory') + 1];
  assert.ok(dataDir && dataDir.startsWith('E:\\App'), '数据目录应在应用目录下，实际 ' + dataDir);
  assert.ok(!/^[Cc]:/.test(dataDir), '不许落 C 盘');
  assert.equal(plan.args[plan.args.indexOf('--SocksPort') + 1], '127.0.0.1:9050');
});

// ── 探测接口的 Tor 一档：把它指到假 SOCKS 上，验证真的走了 SOCKS
process.stdout.write('\nsocks: 探测的 Tor 出口\n');

await t('probeUrl(modes:[tor]) 会经 SOCKS 取首字节，并给出结论', async () => {
  const http = await import('node:http');
  const { probeUrl } = await import('../server/src/probe.js');

  // 假目标换成最小 HTTP 服务（探测只看首字节）
  const web = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const webPort = await listen(web);
  const relay = fakeSocks(webPort);
  const relayPort = await listen(relay.server);

  const cfg = { proxy: { torSocks: `socks5://127.0.0.1:${relayPort}` }, paths: {} };
  const r = await probeUrl(`http://vml-origin.invalid:${webPort}/`, { cfg, modes: ['tor'], samples: 1 });
  assert.equal(r.modes.tor?.method, 'socks-ttfb', JSON.stringify(r.modes.tor));
  assert.equal(r.modes.tor.ok, true, '经 SOCKS 应当能取到首字节: ' + JSON.stringify(r.modes.tor));
  assert.equal(r.verdict, 'tor', '唯一可用出口就是 tor，结论应为 tor（实际 ' + r.verdict + '）');
  assert.ok(relay.seen.length >= 1, '假 SOCKS 没收到 CONNECT');
  web.close();
  relay.server.close();
});

await t('没配 Tor 时如实标 skipped，而不是假装测过', async () => {
  const { probeUrl } = await import('../server/src/probe.js');
  const r = await probeUrl('http://example.invalid/', { cfg: { proxy: {} }, modes: ['tor'], samples: 1 });
  assert.equal(r.modes.tor.skipped, true);
  assert.match(r.modes.tor.error, /Tor/);
});

socks.server.close();
origin.server.close();
process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

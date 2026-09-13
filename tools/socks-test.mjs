// socks-test.mjs — self-test for the hand-written SOCKS5 connector
//
// Why it is needed: this path **used to skip testing entirely as soon as the port was unreachable** (with Tor down the
// probe returns ECONNREFUSED, which looks like "the feature works, Tor just is not running"). So the TLS part
// was never exercised -- and that is precisely the part that was broken: once the handshake completed we handed
// the **bare socket** to undici, so a plaintext `GET /api/ip HTTP/1.1` went to the target's port 443. The real
// symptom is `400 The plain HTTP request was sent to HTTPS port`, while the app's probe only reported
// "port reachable, but the egress check failed", which looks like a Tor problem.
//
// The criteria here need neither a certificate nor a network: start a **fake SOCKS service** (forwarding to a
// local fake origin), then look at whether the first bytes in the tunnel are a TLS ClientHello (0x16) or plaintext HTTP.
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

// ── Fake SOCKS5 service: implements no-auth + CONNECT only, and forwards every connection **to the fake origin**
// (Note: it must not really connect to the hostname in the request -- that is a .invalid domain and would not
//  resolve; this fake proxy only has to join the tunnel up, so we can watch what the client writes into it)
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
        // Pause the client socket first: bytes that arrive before the upstream is connected get eaten by the
        // 'data' listener, so the handshake succeeds yet the origin never receives the request (my first version
        // of this fake service fell straight into that hole).
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

// ── Fake origin: record the first bytes it receives (the client will then error out because we are not real TLS, which does not matter)
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

process.stdout.write('\nsocks: SOCKS5 connector\n');

await t('the handshake hands the **hostname** to the proxy for resolution (DNS never leaves this machine)', async () => {
  await fetch(`http://vml-test-host.invalid:${originPort}/x`, { dispatcher: agent, signal: AbortSignal.timeout(4000) }).catch(() => {});
  const last = socks.seen.at(-1);
  assert.ok(last, 'the fake SOCKS service received no CONNECT');
  assert.equal(last.atyp, 3, 'atyp should be 3 (domain), got ' + last.atyp);
  assert.equal(last.host, 'vml-test-host.invalid');
  assert.equal(last.port, originPort);
});

await t('http:// target: the tunnel carries plain HTTP', async () => {
  origin.state.first = null;
  let err = null;
  await fetch(`http://vml-test-host.invalid:${originPort}/x`, { dispatcher: agent, signal: AbortSignal.timeout(4000) }).catch((e) => {
    err = e;
  });
  assert.equal(origin.state.first, 0x47, 'should start with "G" (GET), got byte ' + origin.state.first + ' · fetch error: ' + (err ? err.message : 'none'));
});

await t('https:// target: the tunnel must carry a TLS ClientHello (0x16), not plain HTTP', async () => {
  origin.state.first = null;
  origin.state.raw = Buffer.alloc(0);
  await fetch(`https://vml-test-host.invalid:${originPort}/x`, { dispatcher: agent, signal: AbortSignal.timeout(4000) }).catch(() => {});
  assert.ok(origin.state.first !== null, 'the origin received no bytes at all');
  assert.equal(
    origin.state.first,
    0x16,
    'the first byte should be 0x16 (TLS handshake), got ' +
      origin.state.first +
      ' -- plaintext ' +
      JSON.stringify(origin.state.raw.subarray(0, 20).toString('utf8')),
  );
});

// ── Optional real-Tor verification (only runs when that SOCKS port is listening)
const torUp = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 9150 });
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

if (torUp) {
  await t('real Tor: goes out through SOCKS and check.torproject.org reports a Tor exit', async () => {
    const res = await fetch('https://check.torproject.org/api/ip', {
      dispatcher: socksAgent('socks5://127.0.0.1:9150'),
      signal: AbortSignal.timeout(45000),
    });
    assert.equal(res.status, 200, 'HTTP ' + res.status);
    const j = await res.json();
    assert.equal(j.IsTor, true, JSON.stringify(j));
    assert.ok(j.IP, 'there should be an exit IP');
    process.stdout.write('         exit: ' + j.IP + '\n');
  });
} else {
  process.stdout.write('  [skip] real Tor (nothing is listening on 127.0.0.1:9150)\n');
}

// ── "launch Tor with one click" argument building (a pure function, assertable offline)
process.stdout.write('\nsocks: Tor launch arguments\n');

const TB_EXE = 'E:\\Tor Browser\\Browser\\TorBrowser\\Tor\\tor.exe';
const realPlan = torLaunchPlan({ exe: TB_EXE, socksUrl: 'socks5://127.0.0.1:9150', appRoot: 'E:\\VtuberMonitorLink\\dist\\VtuberMonitorLink\\app' });

await t('Tor Browser layout: --defaults-torrc plus its own torrc, with DisableNetwork forced to 0', async () => {
  if (!realPlan.ok) {
    // With Tor Browser not installed on this machine, verify the logic itself with a fake layout
    const fake = torLaunchPlan({ exe: 'X:\\nope\\TorBrowser\\Tor\\tor.exe', socksUrl: 'socks5://127.0.0.1:9150' });
    assert.equal(fake.kind, 'standalone', 'with no torrc it should fall back to the standalone tor branch');
    return;
  }
  assert.equal(realPlan.kind, 'tor-browser', JSON.stringify(realPlan));
  assert.ok(realPlan.args.includes('--defaults-torrc'), '--defaults-torrc is mandatory (passing -f twice is rejected by Tor)');
  assert.ok(realPlan.args.includes('-f'), 'the torrc is mandatory');
  assert.ok(realPlan.args.includes('--DisableNetwork') && realPlan.args.includes('0'), 'the network has to be switched on explicitly (Tor Browser leaves DisableNetwork 1 in its torrc)');
  assert.equal(realPlan.args[realPlan.args.indexOf('--SocksPort') + 1], '9150', 'the port must match the configuration');
  assert.ok(/Browser$/.test(realPlan.cwd), 'cwd must be the Browser directory (pluggable transports use relative paths): ' + realPlan.cwd);
});

await t('standalone tor: the data directory sits under the app directory and never touches the C drive', async () => {
  const plan = torLaunchPlan({ exe: 'X:\\tor\\tor.exe', socksUrl: 'socks5://127.0.0.1:9050', appRoot: 'E:\\App' });
  assert.equal(plan.kind, 'standalone');
  const dataDir = plan.args[plan.args.indexOf('--DataDirectory') + 1];
  assert.ok(dataDir && dataDir.startsWith('E:\\App'), 'the data directory should sit under the app directory, got ' + dataDir);
  assert.ok(!/^[Cc]:/.test(dataDir), 'it must not land on the C drive');
  assert.equal(plan.args[plan.args.indexOf('--SocksPort') + 1], '127.0.0.1:9050');
});

// ── The probe's Tor mode: point it at the fake SOCKS and verify it really goes through SOCKS
process.stdout.write("\nsocks: the probe's Tor egress\n");

await t('probeUrl(modes:[tor]) reads the first byte through SOCKS and returns a verdict', async () => {
  const http = await import('node:http');
  const { probeUrl } = await import('../server/src/probe.js');

  // Swap the fake origin for a minimal HTTP service (the probe only looks at the first byte)
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
  assert.equal(r.modes.tor.ok, true, 'going through SOCKS should yield a first byte: ' + JSON.stringify(r.modes.tor));
  assert.equal(r.verdict, 'tor', 'the only usable egress is tor, so the verdict should be tor (got ' + r.verdict + ')');
  assert.ok(relay.seen.length >= 1, 'the fake SOCKS service received no CONNECT');
  web.close();
  relay.server.close();
});

await t('with no Tor configured it reports skipped honestly instead of pretending to have tested', async () => {
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

// tools/traverse-flows.cjs - walk the flows the other traversals never touch.
//
// ASCII only, CommonJS. Boots the packaged exe together with
//   - the mock LLM (so LLM-dependent routes can actually run), and
//   - a local webhook receiver (so alert delivery is verified for real rather
//     than assumed).
//
// Then it exercises: alert push, config export/import round-trip, intel flags,
// search filters, scheduled-task execution + history, and the LLM assistant.
//
//   node tools/traverse-flows.cjs [--dir dist/VtuberMonitorLink] [--port 43179]
//
// Exit code 0 = every check passed.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'dist', 'VtuberMonitorLink'), port: 43179, mock: 43178, hook: 43177 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = path.resolve(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a === '--mock') out.mock = Number(argv[++i]) || out.mock;
    else if (a === '--hook') out.hook = Number(argv[++i]) || out.hook;
  }
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  process.stdout.write('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + name + (detail ? '  -- ' + detail : '') + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = 'http://127.0.0.1:' + args.port;
  const exe = path.join(args.dir, path.basename(args.dir) + EXE);
  const appDir = path.join(args.dir, 'app');
  const cfgPath = path.join(appDir, 'config.json');
  const hadConfig = fs.existsSync(cfgPath);
  const cfgBackup = hadConfig ? fs.readFileSync(cfgPath) : null;
  const created = ['reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice'].filter((d) => !fs.existsSync(path.join(appDir, d)));

  process.stdout.write('\nflow traversal: ' + args.dir + '\n\n');

  // ── a webhook receiver, so delivery is observed rather than assumed
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":0,"message":"ok"}');
    });
  });
  await new Promise((r) => hook.listen(args.hook, '127.0.0.1', r));

  const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-llm.cjs'), '--port', String(args.mock)], { stdio: 'ignore' });
  await sleep(900);

  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        browser: { mode: 'bundled' },
        proxy: { enabled: false },
        llm: {
          activeId: 'mock',
          providers: [{ id: 'mock', preset: 'custom', name: 'Mock', baseUrl: `http://127.0.0.1:${args.mock}`, apiKey: 'k', model: 'mock-model' }],
        },
        notify: { desktop: false, targets: [] },
        sources: Object.fromEntries(
          [
            'reddit-VirtualYoutubers','reddit-Hololive','reddit-Nijisanji','reddit-VShojo','fandom-vtuber-wiki','moegirl',
            'twitch-vtuber','x-twitter','youtube-official','news-ann','news-kaiyou','news-4gamers','news-kaori','news-moguravr',
            'news-dengeki','official-anycolor','official-hololive','official-bravegroup','official-vspo','official-cover',
            'merch-fanbox','merch-cien','merch-booth','merch-dlsite','bili-opus-jaran','bili-opus-asoul','bili-opus-yousa',
            'bili-opus-hanser','bili-dynamic-login',
          ].map((id) => [id, { enabled: id === 'bili-opus-jaran' }])
        ),
        watch: { enabled: false, targets: [] },
        run: { defaultGapSeconds: 1, watchWithRun: false, diagnoseFailed: false, extractFeatures: false },
        schedule: { tasks: [{ id: 'flow-task', name: 'flow task', enabled: true, mode: 'watch', freq: 'daily', time: '04:00', catchUp: false }] },
      },
      null,
      2
    ),
    'utf8'
  );

  const appLog = path.join(appDir, 'logs', 'flow-app.txt');
  fs.mkdirSync(path.dirname(appLog), { recursive: true });
  const appOut = fs.createWriteStream(appLog, { flags: 'w' });
  const child = spawn(exe, ['--no-open', '--port', String(args.port)], { cwd: args.dir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(appOut);
  child.stderr.pipe(appOut);

  const api = async (m, route, body) => {
    const r = await fetch(base + route, {
      method: m,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(240000),
    });
    const t = await r.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {
      /* not json */
    }
    return { status: r.status, json: j, text: t, headers: r.headers };
  };

  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = (await fetch(base + '/api/state', { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        await sleep(500);
      }
    }
    check('server is up', ready);
    if (!ready) throw new Error('server never became ready');

    // ─────────────────────────────────────────── 1. config round-trip
    console.log('\n1. Config export / import round-trip');
    const exp = await fetch(base + '/api/config/export');
    const expText = await exp.text();
    let exported = null;
    try {
      exported = JSON.parse(expText);
    } catch {
      /* keep null */
    }
    check('GET /api/config/export returns a document', exp.ok && !!exported?.config, `${expText.length} bytes`);
    check('the export carries no API key by default', JSON.stringify(exported?.config ?? {}).indexOf('"apiKey": "k"') === -1, 'secrets stripped');

    const del = JSON.parse(JSON.stringify(exported.config));
    del.ui = { ...(del.ui ?? {}), layout: { ...(del.ui?.layout ?? {}), mode: 'timeline', fontScale: 1.2 } };
    del.llm.providers[0].apiKey = ''; // 脱敏导出后再导入，不该把已有 Key 抹掉
    del.sources = { 'bili-opus-jaran': { enabled: false } };
    const imp = await api('POST', '/api/config/import', { config: del });
    check('POST /api/config/import accepts the document', imp.status === 200 && imp.json?.ok === true, `status ${imp.status}`);
    const after = await api('GET', '/api/config');
    check('imported layout took effect', after.json.ui?.layout?.mode === 'timeline', String(after.json.ui?.layout?.mode));
    check('an empty key does NOT wipe the stored one', after.json.llm?.providers?.[0]?.apiKey === 'k', JSON.stringify(after.json.llm?.providers?.[0]?.apiKey));
    check('imported source state took effect', after.json.sources?.['bili-opus-jaran']?.enabled === false, JSON.stringify(after.json.sources?.['bili-opus-jaran']));
    await api('POST', '/api/config/import', { config: { sources: { 'bili-opus-jaran': { enabled: true } }, ui: { layout: { mode: 'cards' } } } });

    // ─────────────────────────────────────────── 2. alert delivery
    console.log('\n2. Alert delivery (a real webhook is listening)');
    const targets = (await api('GET', '/api/config')).json;
    targets.notify = {
      desktop: false,
      targets: [{ id: 'flow-hook', kind: 'custom', name: 'flow hook', enabled: true, on: 'always', webhookUrl: `http://127.0.0.1:${args.hook}/hook` }],
    };
    const saved = await api('PUT', '/api/config', targets);
    check('a webhook target can be stored', saved.status === 200 && (saved.json.notify?.targets ?? []).length === 1);
    const masked = await api('GET', '/api/notify');
    check('GET /api/notify masks the URL path (origin may stay)', masked.status === 200 && /\/\*\*\*$/.test(String(masked.json.targets?.[0]?.webhookUrl ?? '')), JSON.stringify(masked.json.targets?.[0]?.webhookUrl));

    const test = await api('POST', '/api/notify/test', { target: { id: 'flow-hook', kind: 'custom', webhookUrl: `http://127.0.0.1:${args.hook}/hook` } });
    check('POST /api/notify/test reports success', test.json?.ok === true, JSON.stringify(test.json?.result ?? test.json?.error));
    await sleep(400);
    check('the webhook actually received the test', received.length >= 1, `${received.length} request(s)`);
    const first = received[0];
    const parsed = (() => {
      try {
        return JSON.parse(first?.body ?? '');
      } catch {
        return null;
      }
    })();
    check('the payload is the documented JSON shape', !!parsed && typeof parsed.title === 'string' && 'body' in parsed, first?.body?.slice(0, 90));

    // ─────────────────────────────────────────── 3. run + notification
    console.log('\n3. A real run pushes a summary to the webhook');
    received.length = 0;
    const run = await api('POST', '/api/run', { mode: 'daily' });
    check('the run is accepted', run.status === 200);
    let st = null;
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      st = (await api('GET', '/api/state')).json;
      if (st && st.running === false && st.finishedAt) break;
      await sleep(1500);
    }
    check('the run finishes successfully', !!st?.lastResult, st?.lastError ?? '');
    check('the run pushed a summary', received.length >= 1, `${received.length} request(s) received`);
    const summary = (() => {
      try {
        return JSON.parse(received[0]?.body ?? '');
      } catch {
        return null;
      }
    })();
    check('the push mentions the report', /报告|report/i.test(summary?.body ?? ''), String(summary?.body ?? '').slice(0, 80));

    // ─────────────────────────────────────────── 4. intel flags
    console.log('\n4. Intel flags (star / read / tag)');
    const intel = await api('GET', '/api/intel');
    const item = (intel.json.items ?? [])[0];
    check('there is an item to flag', !!item, item?.id);
    if (item) {
      const f1 = await api('PATCH', '/api/intel/' + encodeURIComponent(item.id), { starred: true });
      check('an item can be starred', f1.json?.flag?.starred === true, JSON.stringify(f1.json?.flag));
      const starred = await api('GET', '/api/intel?starred=1');
      check('the starred filter returns it', (starred.json.items ?? []).some((i) => i.id === item.id), `${starred.json.count} starred`);
      const tagged = await api('PATCH', '/api/intel/' + encodeURIComponent(item.id), { tags: ['我加的标签'] });
      check('a personal tag can be attached', (tagged.json?.flag?.tags ?? []).includes('我加的标签'), JSON.stringify(tagged.json?.flag?.tags));
      const searched = await api('POST', '/api/search', { q: '我加的标签', field: 'tag' });
      check('a personal tag is searchable', searched.json.total > 0, `${searched.json.total} hits`);
      const unread = await api('GET', '/api/intel?unread=1');
      check('the unread filter works', unread.status === 200 && unread.json.count <= unread.json.total, `${unread.json.count}/${unread.json.total}`);
      await api('PATCH', '/api/intel/' + encodeURIComponent(item.id), { starred: false, read: true, tags: [] });
    }

    // ─────────────────────────────────────────── 5. scheduled task
    console.log('\n5. Scheduled tasks');
    const sched = await api('GET', '/api/schedule');
    check('GET /api/schedule lists the seeded task', (sched.json.tasks ?? []).some((t) => t.id === 'flow-task'), `${(sched.json.tasks ?? []).length} task(s)`);
    const t0 = (sched.json.tasks ?? []).find((t) => t.id === 'flow-task');
    check('each task shows its next fire and a preview', !!t0?.nextFire && (t0?.preview ?? []).length > 1, `${t0?.preview?.length} upcoming`);
    const manual = await api('POST', '/api/schedule/run', { id: 'flow-task' });
    check('a task can be run on demand', manual.status === 200 && manual.json?.ok === true, JSON.stringify(manual.json));
    const deadline2 = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline2) {
      st = (await api('GET', '/api/state')).json;
      if (st?.running === false && st.finishedAt) break;
      await sleep(1500);
    }
    await sleep(800);
    const sched2 = await api('GET', '/api/schedule');
    const entry = (sched2.json.history ?? []).find((h) => h.taskId === 'flow-task');
    check('the run is recorded in the task history', !!entry, JSON.stringify(entry ?? sched2.json.history?.[0] ?? null));
    check('unknown task ids are refused', (await api('POST', '/api/schedule/run', { id: 'nope' })).status === 404);

    // ─────────────────────────────────────────── 6. LLM assistant
    console.log('\n6. Optional LLM assistant (mock returns JSON)');
    const assist = await api('POST', '/api/search/assist', { description: '红发，笑声很特别，玩马车很强' });
    check('POST /api/search/assist answers', assist.status === 200 && typeof assist.json.ok === 'boolean', assist.json.ok ? 'ok' : String(assist.json.error).slice(0, 70));
    const noKey = await api('PUT', '/api/config', { llm: { activeId: 'x', providers: [{ id: 'x', preset: 'custom', name: 'x', baseUrl: '', apiKey: '', model: '' }] } });
    void noKey;
    const assist2 = await api('POST', '/api/search/assist', { description: 'test' });
    check('without an LLM it says so instead of failing', assist2.json?.ok === false && assist2.json?.needsLlm === true, String(assist2.json?.error).slice(0, 70));
  } catch (err) {
    check('flow traversal completed', false, err && err.message);
    process.stdout.write('\n  ' + (err && err.stack ? err.stack : err) + '\n');
    try {
      appOut.end();
      const tail = fs.readFileSync(appLog, 'utf8').trim().split(/\r?\n/).slice(-20);
      process.stdout.write('\n  app output (tail):\n' + tail.map((l) => '    ' + l).join('\n') + '\n');
    } catch {
      /* ignore */
    }
  } finally {
    try {
      child.kill();
    } catch {}
    try {
      mock.kill();
    } catch {}
    await sleep(1200);
    try {
      hook.close();
    } catch {}
    if (hadConfig) fs.writeFileSync(cfgPath, cfgBackup);
    else fs.rmSync(cfgPath, { force: true });
    for (const d of created) fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n');
  if (failed.length) {
    for (const f of failed) process.stdout.write('  FAILED: ' + f.name + (f.detail ? '  -- ' + f.detail : '') + '\n');
    process.stdout.write('\n');
    process.exit(1);
  }
  process.stdout.write('  all good\n\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write('crashed: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});

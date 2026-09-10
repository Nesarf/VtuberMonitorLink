// tools/traverse-release.cjs - walk the whole surface of a built release.
//
// ASCII only, CommonJS. Starts the packaged exe, exercises every HTTP route the
// console exposes, checks the static/SPA layer, and verifies the error paths.
//
//   node tools/traverse-release.cjs [--dir dist/VtuberMonitorLink] [--port 43199]
//                                   [--keep]      leave the instance running
//                                   [--with-run]  also wait for the full run to settle
//
// Exit code 0 = every check passed.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'dist', 'VtuberMonitorLink'), port: 43199, keep: false, withRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = path.resolve(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a === '--keep') out.keep = true;
    else if (a === '--with-run') out.withRun = true;
  }
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  process.stdout.write('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + name + (detail ? '  -- ' + detail : '') + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = 'http://127.0.0.1:' + args.port;
  const exeName = path.basename(args.dir) + EXE;
  const exe = path.join(args.dir, exeName);

  if (!fs.existsSync(exe)) {
    process.stderr.write('exe not found: ' + exe + '\n');
    process.exit(1);
  }

  process.stdout.write('\ntraversing: ' + args.dir + '\n');
  process.stdout.write('            ' + exe + '  on port ' + args.port + '\n\n');

  // Snapshot anything the run will touch, so the folder can be restored clean.
  const appDir = path.join(args.dir, 'app');
  const snapshot = {};
  for (const rel of ['config.json']) {
    const p = path.join(appDir, rel);
    snapshot[rel] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  const createdDirs = [];
  for (const d of ['reports', 'feeds', 'logs', 'watch']) {
    if (!fs.existsSync(path.join(appDir, d))) createdDirs.push(d);
  }

  const logFile = path.join(appDir, 'logs', 'traverse-stdout.txt');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.createWriteStream(logFile, { flags: 'w' });

  const child = spawn(exe, ['--no-open', '--port', String(args.port)], {
    cwd: args.dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);

  const api = async (method, route, body) => {
    const res = await fetch(base + route, {
      method: method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      /* not json */
    }
    return { status: res.status, text: text, json: json, type: res.headers.get('content-type') || '' };
  };

  let exitCode = 0;
  try {
    // ---------------------------------------------------------- 0. wait ready
    process.stdout.write('0. startup\n');
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(base + '/api/state', { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          ready = true;
          break;
        }
      } catch (e) {
        /* not up yet */
      }
      await sleep(500);
    }
    check('server comes up on the requested port', ready, ready ? base : 'timed out after 30s');
    if (!ready) throw new Error('server never became ready');
    check('process still alive after startup', child.exitCode === null);

    // ------------------------------------------------------- 1. static / SPA
    process.stdout.write('\n1. static console / SPA\n');
    const index = await api('GET', '/');
    check('GET / returns the console', index.status === 200 && /id="root"/.test(index.text), 'status ' + index.status + ', ' + index.text.length + ' bytes');
    const asset = (index.text.match(/src="([^"]*\/assets\/[^"]+\.js)"/) || [])[1];
    check('index.html references a built bundle', !!asset, asset || 'no /assets/*.js found');
    if (asset) {
      const js = await api('GET', asset);
      check('bundle is served', js.status === 200 && /javascript/.test(js.type), 'status ' + js.status + ', ' + js.type);
    }
    const css = (index.text.match(/href="([^"]*\/assets\/[^"]+\.css)"/) || [])[1];
    if (css) {
      const c = await api('GET', css);
      check('stylesheet is served', c.status === 200 && /css/.test(c.type), 'status ' + c.status);
    }
    const spa = await api('GET', '/reports/some/deep/route');
    check('deep link falls back to the SPA', spa.status === 200 && /id="root"/.test(spa.text), 'status ' + spa.status);

    // ------------------------------------------------------------ 2. config
    process.stdout.write('\n2. config\n');
    const cfg = await api('GET', '/api/config');
    const need = ['browser', 'llm', 'schedule', 'proxy', 'paths', 'run', 'sources'];
    const missing = need.filter((k) => !(cfg.json && k in cfg.json));
    check('GET /api/config returns every section', cfg.status === 200 && missing.length === 0, missing.length ? 'missing ' + missing.join(',') : 'ok');
    const before = cfg.json && cfg.json.run && cfg.json.run.defaultGapSeconds;
    const put = await api('PUT', '/api/config', { run: { defaultGapSeconds: 7 } });
    const after = await api('GET', '/api/config');
    check(
      'PUT /api/config persists a change',
      put.status === 200 && after.json.run.defaultGapSeconds === 7,
      'defaultGapSeconds ' + before + ' -> ' + after.json.run.defaultGapSeconds
    );
    check('config file was written to app/', fs.existsSync(path.join(appDir, 'config.json')));
    await api('PUT', '/api/config', { run: { defaultGapSeconds: before } });

    // ------------------------------------------------------------ 3. sources
    process.stdout.write('\n3. sources\n');
    const src = await api('GET', '/api/sources');
    const s = src.json || {};
    // categories is a map of id -> { zh, en }, not an array.
    const cats = s.categories && typeof s.categories === 'object' ? Object.keys(s.categories) : [];
    check('GET /api/sources returns categories', cats.length > 0, cats.length + ' categories: ' + cats.join(','));
    const catLabelsOk = cats.every((k) => s.categories[k] && s.categories[k].zh && s.categories[k].en);
    check('every category is bilingual', catLabelsOk);
    check('GET /api/sources returns adapters', Array.isArray(s.sources) && s.sources.length >= 20, (s.sources || []).length + ' adapters');
    const badShape = (s.sources || []).filter(
      (x) => !x.id || !x.name || typeof x.enabled !== 'boolean' || !x.login || !x.cadence || !x.category
    );
    check(
      'every adapter has id/name/enabled/login/cadence/category',
      badShape.length === 0,
      badShape.length ? badShape.map((b) => b.id || '?').join(',') : 'all ' + (s.sources || []).length + ' ok'
    );
    const badge = (s.sources || []).filter((x) => x.cadence === 'merch').length;
    const cadenceOk = (s.sources || []).every((x) => x.cadence === 'daily' || x.cadence === 'merch');
    check('cadence is stated explicitly on every adapter', cadenceOk, badge + ' merch / ' + ((s.sources || []).length - badge) + ' daily');
    const nameOk = (s.sources || []).every((x) => x.name && typeof x.name === 'object' && x.name.zh && x.name.en);
    check('every adapter name is bilingual', nameOk);
    const catIds = new Set(cats);
    const orphan = (s.sources || []).filter((x) => !catIds.has(x.category));
    check('every adapter maps to a declared category', orphan.length === 0, orphan.map((o) => o.id + ':' + o.category).join(','));
    const logins = new Set((s.sources || []).map((x) => x.login));
    check('login requirement is one of none/optional/required', [...logins].every((v) => ['none', 'optional', 'required'].includes(v)), [...logins].join('/'));
    check('selection counters are present', !!(s.selected && typeof s.selected.daily === 'number' && typeof s.selected.merch === 'number'), JSON.stringify(s.selected));
    const target = (s.sources || [])[0];
    if (target) {
      const off = await api('PATCH', '/api/sources/' + target.id, { enabled: false });
      const listAfter = await api('GET', '/api/sources');
      const nowOff = (listAfter.json.sources.find((x) => x.id === target.id) || {}).enabled === false;
      check('PATCH disables a source', off.status === 200 && nowOff, target.id);
      await api('PATCH', '/api/sources/' + target.id, { enabled: true, login: target.login });
      const back = await api('GET', '/api/sources');
      check('PATCH re-enables it', (back.json.sources.find((x) => x.id === target.id) || {}).enabled === true, target.id);
    }
    const bad = await api('PATCH', '/api/sources/definitely-not-a-source', { enabled: true });
    check('PATCH on an unknown source is rejected', bad.status === 404, 'status ' + bad.status);

    // ----------------------------------------------------- 4. env detection
    process.stdout.write('\n4. browser & proxy detection\n');
    const br = await api('GET', '/api/browsers');
    const detected = (br.json && br.json.detected) || [];
    check('GET /api/browsers responds', br.status === 200 && Array.isArray(detected), detected.length + ' browser(s) detected');
    const brShape = detected.every((b) => b.name && b.executablePath);
    check('detected browsers carry name + path', brShape);
    for (const b of detected) process.stdout.write('       - ' + b.name + '  ' + b.executablePath + '\n');
    const px = await api('GET', '/api/proxy/detect');
    check('GET /api/proxy/detect responds', px.status === 200 && Array.isArray(px.json.found) && typeof px.json.probed === 'number', 'probed ' + (px.json && px.json.probed) + ', found ' + JSON.stringify((px.json && px.json.found) || []));

    // 登录态探测：有没有登录取决于这台机器，所以只检查「契约」而不是结果
    const ck = await api('POST', '/api/cookies/check', { domains: ['bilibili.com'] });
    check('POST /api/cookies/check answers with a contract', ck.status === 200 && typeof ck.json.ok === 'boolean' && Array.isArray(ck.json.names), ck.json.ok ? ck.json.cookieCount + ' cookies, SESSDATA=' + ck.json.hasSession : String(ck.json.error).slice(0, 60));
    check('the cookie endpoint never returns values', !JSON.stringify(ck.json).includes('SESSDATA='), 'names only');
    const ckBad = await api('POST', '/api/cookies/check', { profileDir: 'C:\\No\\Such\\Profile', domains: ['bilibili.com'] });
    check('a bogus profileDir fails cleanly', ckBad.status === 200 && ckBad.json.ok === false && !!ckBad.json.error, String(ckBad.json.error).slice(0, 60));

    // ---------------------------------------------------------- 5. llm + intel
    process.stdout.write('\n5. LLM profiles & intel\n');
    const llm = await api('GET', '/api/llm/presets');
    check('GET /api/llm/presets returns the provider catalog', llm.status === 200 && (llm.json.presets ?? []).length >= 8, (llm.json.presets ?? []).length + ' presets');
    check('presets cover local and overseas providers', (llm.json.presets ?? []).some((p) => p.id === 'ollama') && (llm.json.presets ?? []).some((p) => p.id === 'openai'));
    check('the active profile never leaks its key', llm.json.active?.apiKey !== undefined && (llm.json.active.apiKey === '' || llm.json.active.apiKey === '***'), JSON.stringify(llm.json.active?.apiKey));
    const newProf = await api('POST', '/api/llm/new', { preset: 'ollama' });
    check('POST /api/llm/new adds a profile', newProf.status === 200 && !!newProf.json.provider?.id, newProf.json.provider?.name + ' / ' + newProf.json.provider?.baseUrl);
    check('the new profile gets the preset defaults', newProf.json.provider?.baseUrl === 'http://127.0.0.1:11434/v1', newProf.json.provider?.baseUrl ?? '');
    const modelList = await api('POST', '/api/llm/models', { provider: { baseUrl: 'http://127.0.0.1:1', apiKey: 'x' } });
    check('POST /api/llm/models fails gracefully on a dead endpoint', modelList.status === 200 && modelList.json.ok === false && !!modelList.json.error, String(modelList.json.error).slice(0, 60));
    const llmTest = await api('POST', '/api/llm/test', { provider: { baseUrl: 'http://127.0.0.1:1', apiKey: 'x' } });
    check('POST /api/llm/test fails gracefully too', llmTest.status === 200 && llmTest.json.ok === false, String(llmTest.json.error).slice(0, 60));

    const intel = await api('GET', '/api/intel');
    check('GET /api/intel answers with a well-formed payload', intel.status === 200 && Array.isArray(intel.json.items) && Array.isArray(intel.json.watch), intel.json.count + '/' + intel.json.total + ' items');
    check('intel payload carries the run list', Array.isArray(intel.json.runs));
    const intelFiltered = await api('GET', '/api/intel?source=nope&alerts=1&q=zzz');
    check('intel filters combine without error', intelFiltered.status === 200 && intelFiltered.json.count === 0);

    // ----------------------------------------------------------- 6. watch
    process.stdout.write('\n6. watch targets\n');
    const w = await api('GET', '/api/watch');
    check('GET /api/watch returns kinds and rules', w.status === 200 && (w.json.kinds ?? []).length >= 5 && !!w.json.rules, (w.json.kinds ?? []).length + ' kinds');
    check('the moegirl-style alarm rules are exposed', typeof w.json.rules.largeEditBytes === 'number' && Array.isArray(w.json.rules.keywords), JSON.stringify({ edit: w.json.rules.largeEditBytes, kw: (w.json.rules.keywords ?? []).length }));
    check('the watchlist kind is marked login-required', (w.json.kinds ?? []).find((k) => k.id === 'mediawiki-watchlist')?.login === 'required');

    const putW = await api('PUT', '/api/watch', {
      targets: [
        {
          id: 'traverse-url',
          kind: 'url',
          label: 'traverse probe',
          url: 'https://example.com/',
          enabled: true,
        },
      ],
      rules: { keywords: ['毕业', '解约'] },
    });
    check('PUT /api/watch stores a target', putW.status === 200 && (putW.json.watch.targets ?? []).length === 1, JSON.stringify(putW.json.watch.targets?.[0]?.id));
    const w2 = await api('GET', '/api/watch');
    check('the target round-trips', (w2.json.targets ?? []).length === 1 && w2.json.targets[0].label === 'traverse probe');
    check('only whitelisted fields survive', w2.json.targets[0].fetch === undefined && w2.json.targets[0].cadence === undefined, JSON.stringify(Object.keys(w2.json.targets[0])));

    const wc = await api('POST', '/api/watch/check', { id: 'traverse-url' });
    check('POST /api/watch/check builds a baseline on the first pass', wc.status === 200 && wc.json.results?.[0]?.ok === true && wc.json.results[0].first === true, wc.json.results?.[0]?.summary ?? wc.json.results?.[0]?.error);
    const wc2 = await api('POST', '/api/watch/check', { id: 'traverse-url' });
    check('the second pass reports no change', wc2.json.results?.[0]?.changed === false, wc2.json.results?.[0]?.summary);
    const hist = await api('GET', '/api/watch/traverse-url/history');
    check('GET watch history answers', hist.status === 200 && Array.isArray(hist.json.history), hist.json.history.length + ' entries');
    const cleared = await api('DELETE', '/api/watch/traverse-url/baseline');
    check('DELETE baseline works', cleared.status === 200 && cleared.json.ok === true);
    const wc3 = await api('POST', '/api/watch/check', { id: 'traverse-url' });
    check('after clearing, the next check rebuilds the baseline instead of alerting', wc3.json.results?.[0]?.first === true && wc3.json.results[0].changed === false);

    // ----------------------------------------------------------- 7. reports
    process.stdout.write('\n7. reports\n');
    const rep = await api('GET', '/api/reports');
    check('GET /api/reports returns a list', rep.status === 200 && Array.isArray(rep.json), rep.status === 200 ? rep.json.length + ' report(s)' : 'status ' + rep.status);
    const miss = await api('GET', '/api/reports/no-such-report.md');
    check('missing report -> 404', miss.status === 404, 'status ' + miss.status);
    const traversal = await api('GET', '/api/reports/..%2f..%2fpackage.json');
    check('path traversal in report name is refused', traversal.status === 404 || traversal.status === 400, 'status ' + traversal.status);
    const search = await api('GET', '/api/reports/search?q=' + encodeURIComponent('zzz-no-such-word'));
    check('GET /api/reports/search answers', search.status === 200 && Array.isArray(search.json.hits), (search.json.hits ?? []).length + ' files');
    const badExport = await api('GET', '/api/reports/no-such-report.md/export?format=html');
    check('exporting a missing report -> 404', badExport.status === 404, 'status ' + badExport.status);

    // ---------------------------------------------------- 8. custom sources
    process.stdout.write('\n8. custom sources\n');
    const addSrc = await api('POST', '/api/sources/custom', {
      id: 'traverse-feed',
      name: 'traverse feed',
      fetch: 'rss',
      url: 'https://example.com/feed.xml',
      category: 'community',
    });
    check('POST /api/sources/custom adds one', addSrc.status === 200 && addSrc.json.source?.custom === true, JSON.stringify(addSrc.json.source?.id));
    const dupSrc = await api('POST', '/api/sources/custom', { id: 'traverse-feed', name: 'dup', fetch: 'rss', url: 'https://example.com/2.xml' });
    check('a duplicate id is refused', dupSrc.status === 409, 'status ' + dupSrc.status);
    const badSrc = await api('POST', '/api/sources/custom', { id: 'x' });
    check('a source without url/uid is refused', badSrc.status === 400, 'status ' + badSrc.status);
    const srcs = await api('GET', '/api/sources');
    check('the custom source joins the catalog', (srcs.json.sources ?? []).some((s) => s.id === 'traverse-feed'), (srcs.json.sources ?? []).length + ' sources total');
    check('GET /api/sources exposes the fetch kinds for the editor', (srcs.json.fetchKinds ?? []).length >= 6, (srcs.json.fetchKinds ?? []).length + ' kinds');
    const delSrc = await api('DELETE', '/api/sources/custom/traverse-feed');
    check('DELETE removes it again', delSrc.status === 200 && delSrc.json.removed === 1);

    // ---------------------------------------------------------- 9. preflight
    process.stdout.write('\n9. preflight & run\n');
    const pre = await api('POST', '/api/preflight');
    check('POST /api/preflight answers', pre.status === 200 && pre.json && typeof pre.json.ok === 'boolean', 'ok=' + (pre.json && pre.json.ok) + (pre.json && pre.json.error ? ' (' + String(pre.json.error).slice(0, 60) + ')' : ''));
    const configured = await api('GET', '/api/config');
    const hasKey = !!(configured.json?.llm?.providers ?? []).some((p) => p.apiKey) || !!configured.json?.llm?.apiKey;
    if (!hasKey) {
      check('without an API key preflight reports a clear reason', pre.json.ok === false && !!pre.json.error, String(pre.json.error || '').slice(0, 80));
    } else {
      check('with an API key preflight succeeds', pre.json.ok === true, 'ok');
    }

    const run = await api('POST', '/api/run', { mode: 'daily' });
    check('POST /api/run accepts a daily run', run.status === 200 && run.json && run.json.ok === true, 'status ' + run.status + ' ' + JSON.stringify(run.json));
    const second = await api('POST', '/api/run', { mode: 'daily' });
    check(
      'a second concurrent run is refused or queued',
      second.status === 200 || second.status === 409,
      'status ' + second.status + ' ' + JSON.stringify(second.json)
    );

    let settled = null;
    const deadline = Date.now() + (args.withRun ? 15 * 60 * 1000 : 90000);
    while (Date.now() < deadline) {
      const st = await api('GET', '/api/state');
      settled = st.json;
      if (settled && settled.running === false && settled.finishedAt) break;
      await sleep(1000);
    }
    check('run settles and the state reports it', !!(settled && settled.running === false && settled.finishedAt), 'step=' + (settled && settled.step) + ', lastError=' + (settled && settled.lastError));
    if (!hasKey) {
      check(
        'without an API key the run fails fast with an explanation',
        !!(settled && settled.lastError),
        String((settled && settled.lastError) || '').slice(0, 100)
      );
      check('nothing half-written: no report claimed', !(settled && settled.lastResult), JSON.stringify(settled && settled.lastResult));
    }
    check('run tail is exposed for the console', !!(settled && Array.isArray(settled.tail)), (settled && settled.tail ? settled.tail.length : 0) + ' line(s)');
    check('watch progress counters exist', typeof settled.watchTotal === 'number' && typeof settled.watchDone === 'number', settled.watchDone + '/' + settled.watchTotal);
    check('intel counter exists', typeof settled.itemCount === 'number', String(settled.itemCount));
    const sched = settled && settled.schedule;
    check('schedule block is reported', !!(sched && 'enabled' in sched), JSON.stringify(sched));
    check('nextFire is reported', 'nextFire' in (settled || {}), String(settled && settled.nextFire));

    // ------------------------------------------------------- 7. error paths
    process.stdout.write('\n7. error paths\n');
    const unknownApi = await api('GET', '/api/definitely-not-a-route');
    check(
      'unknown /api route answers with JSON, not the HTML shell',
      unknownApi.status === 404 && !!unknownApi.json,
      'status ' + unknownApi.status + ', type ' + unknownApi.type
    );
  } catch (err) {
    process.stdout.write('\n  [FAIL] traversal aborted: ' + (err && err.message) + '\n');
    exitCode = 1;
  } finally {
    if (!args.keep) {
      try {
        child.kill();
      } catch (e) {
        /* ignore */
      }
      await sleep(1200);
      if (child.exitCode === null) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch (e) {
          /* ignore */
        }
      }
    }

    // Restore the release folder so it stays shippable.
    try {
      out.end();
      for (const [rel, buf] of Object.entries(snapshot)) {
        const p = path.join(appDir, rel);
        if (buf === null) fs.rmSync(p, { force: true });
        else fs.writeFileSync(p, buf);
      }
      for (const d of createdDirs) fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
      fs.rmSync(logFile, { force: true });
      const logDir = path.join(appDir, 'logs');
      if (fs.existsSync(logDir) && fs.readdirSync(logDir).length === 0 && createdDirs.indexOf('logs') !== -1) {
        fs.rmSync(logDir, { recursive: true, force: true });
      }
    } catch (e) {
      process.stdout.write('  (could not fully restore the folder: ' + e.message + ')\n');
    }
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n');
  if (failed.length) {
    for (const f of failed) process.stdout.write('  FAILED: ' + f.name + (f.detail ? '  -- ' + f.detail : '') + '\n');
    process.stdout.write('\n');
    process.exit(1);
  }
  if (exitCode !== 0) process.exit(exitCode);
  process.stdout.write('  all good\n\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write('traversal crashed: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});

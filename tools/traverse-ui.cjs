// tools/traverse-ui.cjs - drive the built console in a real browser.
//
// ASCII only, CommonJS. Loads the packaged console, walks all six pages, runs a
// real collection against a local mock LLM (so no API key is needed), then
// checks the intel stream, the watch history/diff view, the Markdown rendering
// and the export links. Fails on any console error, page error or failed API
// call.
//
//   node tools/traverse-ui.cjs [--dir dist/VtuberMonitorLink] [--port 43198]
//                              [--mock 43196] [--headed] [--keep]
//
// Requires `playwright` in the repo's node_modules and one usable browser
// (an installed Chrome/Edge/Opera, or Playwright's own Chromium).

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'dist', 'VtuberMonitorLink'), port: 43198, mock: 43196, headed: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = path.resolve(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a === '--mock') out.mock = Number(argv[++i]) || out.mock;
    else if (a === '--headed') out.headed = true;
    else if (a === '--keep') out.keep = true;
  }
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  process.stdout.write('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + name + (detail ? '  -- ' + detail : '') + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only these two sources stay on: one bilibili (direct, fast) and one wiki. */
const FAST_SOURCES = ['bili-opus-jaran', 'fandom-vtuber-wiki'];
const ALL_SOURCES = [
  'reddit-VirtualYoutubers', 'reddit-Hololive', 'reddit-Nijisanji', 'reddit-VShojo',
  'fandom-vtuber-wiki', 'moegirl', 'twitch-vtuber', 'x-twitter', 'youtube-official',
  'news-ann', 'news-kaiyou', 'news-4gamers', 'news-kaori', 'news-moguravr', 'news-dengeki',
  'official-anycolor', 'official-hololive', 'official-bravegroup', 'official-vspo', 'official-cover',
  'merch-fanbox', 'merch-cien', 'merch-booth', 'merch-dlsite',
  'bili-opus-jaran', 'bili-opus-asoul', 'bili-opus-yousa', 'bili-opus-hanser', 'bili-dynamic-login',
];

function seedConfig(mockPort) {
  const overrides = {};
  for (const id of ALL_SOURCES) overrides[id] = { enabled: FAST_SOURCES.includes(id) };
  return {
    browser: { mode: 'bundled', headless: true, waitMs: 4000, hardTimeoutMs: 90000 },
    llm: {
      activeId: 'mock',
      providers: [
        {
          id: 'mock',
          preset: 'custom',
          name: '本地 Mock（测试用）',
          baseUrl: `http://127.0.0.1:${mockPort}`,
          apiKey: 'mock-key-not-a-real-secret',
          model: 'mock-model',
          models: ['mock-model', 'mock-reasoner'],
          maxTokens: 2048,
          temperature: 0.2,
        },
      ],
    },
    proxy: { enabled: false, url: '' },
    run: { defaultGapSeconds: 1, watchWithRun: true },
    watch: {
      enabled: true,
      targets: [
        { id: 'watch-url-example', kind: 'url', label: 'example.com', url: 'https://example.com/', enabled: true },
        { id: 'watch-bili-jaran', kind: 'bili-opus', label: '嘉然动态', uid: '672328094', proxy: 'direct', enabled: true },
      ],
      rules: { largeEditBytes: 5000, largeDeleteBytes: 2000, keywords: ['毕业', '解约', '直播'] },
    },
    sources: overrides,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = 'http://127.0.0.1:' + args.port;
  const exe = path.join(args.dir, path.basename(args.dir) + EXE);

  let chromium;
  try {
    chromium = require(path.join(ROOT, 'node_modules', 'playwright')).chromium;
  } catch (e) {
    process.stderr.write('playwright is not installed in the repo; run npm install first\n');
    process.exit(1);
  }

  process.stdout.write('\nUI traversal: ' + args.dir + ' on port ' + args.port + '\n\n');

  const appDir = path.join(args.dir, 'app');
  const cfgPath = path.join(appDir, 'config.json');
  const hadConfig = fs.existsSync(cfgPath);
  const cfgBackup = hadConfig ? fs.readFileSync(cfgPath) : null;
  const createdDirs = ['reports', 'feeds', 'logs', 'watch'].filter((d) => !fs.existsSync(path.join(appDir, d)));

  // A mock OpenAI-compatible endpoint: lets the walk exercise a real run with
  // no API key anywhere near the release.
  const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-llm.cjs'), '--port', String(args.mock)], {
    stdio: 'ignore',
  });
  await sleep(900);
  fs.writeFileSync(cfgPath, JSON.stringify(seedConfig(args.mock), null, 2), 'utf8');

  // 把被测应用的输出收下来：出问题时能看到它的日志，而不是只看到一个断言不过
  const appLog = path.join(appDir, 'logs', 'traverse-app.txt');
  fs.mkdirSync(path.dirname(appLog), { recursive: true });
  const appOut = fs.createWriteStream(appLog, { flags: 'w' });
  const child = spawn(exe, ['--no-open', '--port', String(args.port)], { cwd: args.dir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(appOut);
  child.stderr.pipe(appOut);
  const restore = () => {
    try {
      if (hadConfig) fs.writeFileSync(cfgPath, cfgBackup);
      else fs.rmSync(cfgPath, { force: true });
      for (const d of createdDirs) fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  };

  let browser = null;
  const consoleErrors = [];
  const pageErrors = [];
  const badApi = [];
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(base + '/api/state', { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          ready = true;
          break;
        }
      } catch (e) {
        /* keep waiting */
      }
      await sleep(500);
    }
    if (!ready) {
      check('server is up', false, 'timed out');
      throw new Error('server never became ready');
    }
    check('server is up', true, base);

    const br = await (await fetch(base + '/api/browsers')).json();
    const detected = (br.detected || [])[0];
    const launchOpts = { headless: !args.headed, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (detected) launchOpts.executablePath = detected.executablePath;
    process.stdout.write('  using browser: ' + (detected ? detected.name : "Playwright's bundled Chromium") + '\n');

    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();

    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('response', (r) => {
      const u = r.url();
      if (u.indexOf(base + '/api/') === 0 && r.status() >= 400) badApi.push(r.status() + ' ' + u.replace(base, ''));
    });

    // ------------------------------------------------------------------ load
    process.stdout.write('\n1. load\n');
    await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
    const title = (await page.locator('h1').first().innerText()).trim();
    check('page mounts and shows the product title', title === "Vtuber's Monitor Link", title);

    const langBtn = page.locator('button.lang');
    if ((await page.locator('.sub').first().innerText()).indexOf('本地') === -1) {
      await langBtn.click();
      await page.waitForTimeout(300);
    }
    const tabs = await page.locator('nav.tabs button').allInnerTexts();
    check('seven navigation tabs render', tabs.length === 7, tabs.join(' | '));
    check('the new Intel and Watch tabs are present', tabs.includes('情报') && tabs.includes('监视'), tabs.join(' | '));

    const tab = (label) => page.locator('nav.tabs button', { hasText: label }).first();
    const mainText = () => page.locator('main').innerText();

    // ---------------------------------------------------------------- settings
    process.stdout.write('\n2. Settings: LLM profiles, theme, notify\n');
    await tab('设置').click();
    await page.waitForTimeout(700);
    let main = await mainText();
    for (const section of ['浏览器', 'LLM 分析', '网络代理', '定时', '界面']) {
      check('Settings has the ' + section + ' section', main.indexOf(section) !== -1);
    }
    const keyInput = page.locator('main input[type=password]').first();
    check('the API key field is masked', (await keyInput.count()) > 0);
    const keyVal = (await keyInput.count()) > 0 ? await keyInput.inputValue() : '';
    check('the seeded key is present but type=password', keyVal.length > 0, keyVal ? 'masked input has a value' : 'empty');
    const reveal = page.locator('main button', { hasText: '显示' }).first();
    if (await reveal.count()) {
      await reveal.click();
      await page.waitForTimeout(200);
      check('the key field can be revealed on demand', (await page.locator('main input[type=text]').count()) > 0);
      await page.locator('main button', { hasText: '隐藏' }).first().click();
    }
    const modelOptions = await page.locator('#vml-models option').count();
    check('the model datalist is populated', modelOptions > 0, modelOptions + ' options');
    const providerOptions = await page.locator('main select').first().locator('option').count();
    check('browser mode select works', providerOptions >= 3, providerOptions + ' options');
    check('theme selector is present', main.indexOf('主题') !== -1 && main.indexOf('桌面通知') !== -1);

    // --------------------------------------------------------------- sources
    process.stdout.write('\n3. Sources + custom source editor\n');
    await tab('来源').click();
    await page.waitForTimeout(800);
    const rows = await page.locator('main table tbody tr').count();
    check('Sources lists every adapter plus the target sources', rows >= 29, rows + ' rows');
    main = await mainText();
    check('the bilibili category is shown', main.indexOf('B 站') !== -1);
    check('the custom-source form is present', main.indexOf('自定义来源') !== -1);

    await page.locator('input[placeholder="my-feed"]').fill('ui-test-feed');
    await page.locator('input[placeholder="某某的博客"]').fill('UI 测试订阅');
    await page.locator('input[placeholder="https://example.com/feed.xml"]').fill('https://example.com/feed.xml');
    await page.locator('main button', { hasText: '新增自定义来源' }).click();
    await page.waitForTimeout(1200);
    main = await mainText();
    check('a custom source can be added from the UI', main.indexOf('ui-test-feed') !== -1);
    // 精确定位到那一行的删除按钮 —— 页面上还有其它「删除」（诊断文件、监视对象）
    const rowDel = page.locator('main table tbody tr', { hasText: 'ui-test-feed' }).locator('button', { hasText: '删除' }).first();
    if (await rowDel.count()) {
      await rowDel.click();
      await page.waitForTimeout(1500);
      // 用接口断言而不是页面文本：自检生成的诊断文件名里也带着来源 id
      const after = await (await fetch(base + '/api/sources')).json();
      const gone = !(after.sources ?? []).some((s) => s.id === 'ui-test-feed');
      check('and removed again', gone, gone ? 'gone from the catalog' : 'still present');
    } else {
      check('and removed again', false, 'no delete button on the custom source row');
    }

    // ----------------------------------------------------------------- watch
    process.stdout.write('\n4. Watch: targets, baseline, rules\n');
    await tab('监视').click();
    await page.waitForTimeout(800);
    main = await mainText();
    check('Watch page renders the seeded targets', main.indexOf('example.com') !== -1 && main.indexOf('嘉然动态') !== -1);
    check('the alarm-rules panel can be opened', (await page.locator('main button', { hasText: '告警规则' }).count()) > 0);
    await page.locator('main button', { hasText: '全部检查一次' }).click();
    await page.waitForTimeout(6000);
    const watchRows = await page.locator('main table tbody tr').count();
    check('both targets are listed', watchRows === 2, watchRows + ' rows');
    main = await mainText();
    const baselined = (main.match(/已建立|revid|粉丝|条/g) || []).length;
    check('baseline info shows up after a check', main.indexOf('尚未建立') === -1, baselined + ' baseline markers');
    const ruleBtn = page.locator('main button', { hasText: '告警规则' }).first();
    await ruleBtn.click();
    await page.waitForTimeout(400);
    main = await mainText();
    check('rule editor exposes thresholds and keywords', main.indexOf('大编辑阈值') !== -1 && main.indexOf('关键词') !== -1);
    await page.locator('main button', { hasText: '收起规则' }).first().click();

    // ------------------------------------------------------------------- intel
    process.stdout.write('\n5. Intel stream before the run\n');
    await tab('情报').click();
    await page.waitForTimeout(900);
    main = await mainText();
    check('Intel page renders', main.indexOf('情报卡片流') !== -1);
    check('and says there is nothing yet', main.indexOf('还没有情报') !== -1, main.split('\n').slice(0, 2).join(' / '));

    // --------------------------------------------------------------------- run
    process.stdout.write('\n6. Run for real against the mock LLM\n');
    await tab('运行').click();
    await page.waitForTimeout(600);
    check('the three run buttons are present', (await page.locator('main button').count()) >= 3);
    await page.locator('main button', { hasText: '立即运行' }).first().click();
    const deadline = Date.now() + 4 * 60 * 1000;
    let finished = false;
    while (Date.now() < deadline) {
      const st = await (await fetch(base + '/api/state')).json();
      if (st.running === false && st.finishedAt) {
        finished = true;
        break;
      }
      await sleep(2000);
    }
    check('the run finishes', finished);
    const st = await (await fetch(base + '/api/state')).json();
    check('the run succeeds', !!st.lastResult, st.lastError || JSON.stringify(st.lastResult));

    // ------------------------------------------------------ intel after a run
    process.stdout.write('\n7. Intel stream after the run\n');
    await tab('情报').click();
    await page.waitForTimeout(1500);
    const cards = await page.locator('main .card').count();
    check('the stream shows cards', cards > 0, cards + ' cards');
    main = await mainText();
    check('the bilibili source appears as a chip', main.indexOf('B站动态') !== -1 || main.indexOf('bilibili') !== -1);
    const thumbs = await page.locator('main .card .thumbs img').count();
    check('image thumbnails carry no-referrer (anti-hotlink)', thumbs === 0 || (await page.locator('main .card .thumbs img').first().getAttribute('referrerpolicy')) === 'no-referrer', thumbs + ' thumbnails');
    check('the watch digest block is shown', main.indexOf('监视变化摘要') !== -1 || main.indexOf('监视') !== -1);
    const filterSelect = page.locator('main select').first();
    const opts = await filterSelect.locator('option').count();
    check('the source filter is populated from the data', opts > 1, opts + ' options');

    // --------------------------------------------------------------- reports
    process.stdout.write('\n8. Reports: render, search, export\n');
    await tab('报告').click();
    await page.waitForTimeout(1000);
    const reportRows = await page.locator('main table.reportlist tbody tr').count();
    check('the run produced a report row', reportRows > 0, reportRows + ' rows');
    await page.locator('main table.reportlist tbody tr button.link').first().click();
    await page.waitForTimeout(1200);
    const rendered = await page.locator('main .md').count();
    check('the report renders as Markdown, not raw text', rendered > 0);
    const h2s = await page.locator('main .md h2').count();
    check('headings are rendered as real elements', h2s > 0, h2s + ' h2');
    const tables = await page.locator('main .md table').count();
    check('tables are rendered as real tables', tables > 0, tables + ' table(s)');
    const links = await page.locator('main .md a').count();
    check('links are clickable', links > 0, links + ' links');
    main = await mainText();
    check('raw Markdown is not shown in rendered mode', main.indexOf('## ') === -1);
    await page.locator('main button', { hasText: '原始 Markdown' }).click();
    await page.waitForTimeout(400);
    check('and the raw toggle works', (await page.locator('main pre.report').count()) > 0);
    await page.locator('main button', { hasText: '渲染视图' }).click();
    await page.waitForTimeout(300);

    const exportHref = await page.locator('main a', { hasText: '导出 HTML' }).first().getAttribute('href');
    check('the HTML export link points at the API', !!exportHref && exportHref.indexOf('/export?format=html') !== -1, exportHref || '');
    if (exportHref) {
      const r = await fetch(base + exportHref);
      const body = await r.text();
      check('the exported HTML downloads', r.ok && body.indexOf('<!doctype html>') === 0, body.length + ' bytes');
    }

    await page.locator('main input[placeholder*="搜"]').first().fill('B 站动态');
    await page.locator('main button', { hasText: '搜索' }).first().click();
    await page.waitForTimeout(1200);
    main = await mainText();
    check('full-text search over reports works', main.indexOf('处命中') !== -1 || main.indexOf('没有命中') !== -1, (main.match(/\d+ 处命中/) || ['no hits'])[0]);

    // ---------------------------------------------------------------- search
    process.stdout.write('\n9. Search: local keyword / tag / time filtering\n');
    const tabsNow = await page.locator('nav.tabs button').allInnerTexts();
    check('the Search tab was added', tabsNow.includes('检索'), tabsNow.join(' | '));
    await tab('检索').click();
    await page.waitForTimeout(1500);
    main = await mainText();
    check('Search page renders', main.indexOf('情报检索') !== -1);
    check('it states that no LLM is needed', main.indexOf('不需要 LLM') !== -1);

    // 拿一条真实条目里的词来搜（这次运行刚抓过 B 站动态）
    const corpus = await (await fetch(base + '/api/intel')).json();
    const sample = (corpus.items ?? []).find((i) => (i.text ?? '').length > 4);
    const term = sample ? String(sample.text).replace(/\[[^\]]+\]/g, '').trim().slice(0, 2) : '糖';
    await page.locator('main input').first().fill(term);
    await page.locator('main button', { hasText: '搜索' }).first().click();
    await page.waitForTimeout(1500);
    const hits = await page.locator('main .card').count();
    check('a keyword search returns cards', hits > 0, `${hits} cards for "${term}"`);

    // 直接打接口验证过滤语义
    const apiSearch = await (
      await fetch(base + '/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json();
    check('POST /api/search works with no query at all', Array.isArray(apiSearch.items) && typeof apiSearch.total === 'number', `${apiSearch.total} items in corpus`);
    check('facets are returned (tags / sources / categories / months)', !!apiSearch.facets?.tags && !!apiSearch.facets?.months, `${apiSearch.facets?.tags?.length ?? 0} tag facets`);

    const ranged = await (
      await fetch(base + '/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: '2000-01-01', to: '2000-12-31' }),
      })
    ).json();
    check('a time range with no data returns nothing, and says why', ranged.total === 0 && ranged.outsideTimeRange > 0, `${ranged.outsideTimeRange} excluded by the range`);
    const recent = await (
      await fetch(base + '/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) }),
      })
    ).json();
    check('a recent range still returns items (relative times were normalised)', recent.total > 0, `${recent.total} items in the last 7 days`);
    const bySource = await (
      await fetch(base + '/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'bili-opus-jaran' }),
      })
    ).json();
    check('filtering by source works', bySource.items.every((i) => i.sourceId === 'bili-opus-jaran') && bySource.total > 0, `${bySource.total} items`);
    const tagRes = await (await fetch(base + '/api/search/tags')).json();
    check('the tag vocabulary is exposed with aliases', (tagRes.vocabulary ?? []).some((v) => v.canon === '2434' && v.aliases.length > 0), `${(tagRes.vocabulary ?? []).length} tag groups`);
    check('auto tags were extracted from the corpus', (tagRes.auto ?? []).length > 0, `${(tagRes.auto ?? []).length} auto tags`);
    const aliasSearch = await (
      await fetch(base + '/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'ニジサンジ' }),
      })
    ).json();
    check('an alias query expands instead of erroring', Array.isArray(aliasSearch.expanded) && aliasSearch.expanded[0].length >= 1, JSON.stringify(aliasSearch.expanded?.[0] ?? []));

    main = await mainText();
    check('the optional identify helper is clearly marked as needing an LLM', main.indexOf('需要 LLM') !== -1);

    // ------------------------------------------- office export & features & tor
    process.stdout.write('\n10. Office export, feature extraction, Tor\n');
    const xlsx = await fetch(base + '/api/intel/export?format=xlsx');
    const xlsxBuf = Buffer.from(await xlsx.arrayBuffer());
    check('Excel export downloads', xlsx.ok && xlsxBuf.subarray(0, 2).toString('ascii') === 'PK', `${xlsxBuf.length} bytes, type ${xlsx.headers.get('content-type')}`);
    const docx = await fetch(base + '/api/intel/export?format=docx');
    const docxBuf = Buffer.from(await docx.arrayBuffer());
    check('Word export downloads', docx.ok && docxBuf.subarray(0, 2).toString('ascii') === 'PK', `${docxBuf.length} bytes`);
    const mdExp = await fetch(base + '/api/intel/export?format=md');
    const mdText = await mdExp.text();
    check('Markdown export downloads', mdExp.ok && mdText.length > 0, `${mdText.length} chars`);

    const featBefore = await (await fetch(base + '/api/features')).json();
    check('feature stats endpoint answers', typeof featBefore.extracted === 'number', `${featBefore.extracted} extracted`);
    const featRun = await (await fetch(base + '/api/features/extract', { method: 'POST' })).json();
    // 第二次调用应全部命中缓存（extracted=0/cached=N）—— 这正是想要的，别断言必须 >0
    check(
      'feature extraction answers and reuses its cache',
      featRun.ok === true && featRun.extracted + featRun.cached > 0,
      `extracted ${featRun.extracted}, cached ${featRun.cached}, err ${featRun.error ?? '-'}` 
    );
    check('extracted features become searchable tags', (featRun.stats?.names ?? []).some((n) => n.value === 'Mock Chan'), JSON.stringify((featRun.stats?.names ?? []).slice(0, 3)));

    // Tor：本机不一定在跑，所以只验契约与「不可用时如实报错」
    const tor = await (
      await fetch(base + '/api/proxy/tor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ socks: 'socks5://127.0.0.1:9150' }),
      })
    ).json();
    check('POST /api/proxy/tor answers a contract', typeof tor.ok === 'boolean' && !!tor.socks, tor.ok ? `isTor=${tor.isTor} ip=${tor.ip}` : String(tor.error).slice(0, 60));
    if (!tor.ok) check('Tor being down is reported clearly, not as a crash', /没在跑|不可用/.test(tor.error ?? ''), String(tor.error).slice(0, 70));
    const torStart = await (
      await fetch(base + '/api/proxy/tor/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exe: '' }),
      })
    ).json();
    check('starting Tor without a configured path is refused with guidance', !!torStart.error, String(torStart.error).slice(0, 60));

    // ---------------------------------------------------------------- hygiene
    process.stdout.write('\n11. runtime hygiene\n');
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('no failed /api call during the walk', badApi.length === 0, badApi.slice(0, 3).join(' | '));

    await context.close();
  } catch (err) {
    check('UI traversal completed', false, err && err.message);
    process.stdout.write('\n  ' + (err && err.stack ? err.stack : err) + '\n');
    // 失败时把页面侧的报错一并打出来，否则只能看到「某个断言没过」
    if (pageErrors.length) process.stdout.write('\n  页面异常:\n' + pageErrors.slice(0, 8).map((e) => '    ' + e).join('\n') + '\n');
    if (consoleErrors.length) process.stdout.write('\n  控制台错误:\n' + consoleErrors.slice(0, 8).map((e) => '    ' + e).join('\n') + '\n');
    if (badApi.length) process.stdout.write('\n  失败请求:\n' + badApi.slice(0, 8).map((e) => '    ' + e).join('\n') + '\n');
    try {
      appOut.end();
      const tail = fs.readFileSync(appLog, 'utf8').trim().split(/\r?\n/).slice(-25);
      process.stdout.write('\n  被测应用输出(末尾):\n' + tail.map((l) => '    ' + l).join('\n') + '\n');
      process.stdout.write('\n  被测应用是否还在: ' + (child.exitCode === null ? '在' : '已退出 exit=' + child.exitCode) + '\n');
    } catch {}
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        /* ignore */
      }
    }
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
    try {
      mock.kill();
    } catch (e) {
      /* ignore */
    }
    restore();
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

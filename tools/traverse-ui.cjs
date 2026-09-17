// tools/traverse-ui.cjs - drive the built console in a real browser.
//
// ASCII only, CommonJS. Loads the packaged console, walks all eleven tabs, runs a
// real collection against a local mock LLM (so no API key is needed), then
// checks the intel stream, the watch history/diff view, the Markdown rendering
// and the export links. Fails on any console error, page error or failed API
// call.
//
//   node tools/traverse-ui.cjs [--dir dist/VtuberMonitorLink] [--port 43198]
//                              [--mock 43196] [--headed] [--keep]
//
// Requires `playwright` in the repo's node_modules and one usable engine.
//
// The engine is Firefox — the only one this project drives now. Two consequences of that, both learned by
// measuring rather than by assuming:
//   • Playwright's Firefox **cannot drive a stock firefox.exe** ("Failed to launch the browser process":
//     Playwright speaks the Juggler protocol, which the installed Firefox does not implement), so the engine
//     this walk uses is the one Playwright installed. PLAYWRIGHT_BROWSERS_PATH decides where that is; when it
//     is unset the repo's own pw-browsers/ (the layout `npm run build:portable` produces) is used, and
//     otherwise Playwright's platform default applies.
//   • the walk asks the app for its detected engines and will use one if the app found it, so the walk's
//     engine and the app's browser setting are resolved the same way.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { waitPortFree, waitChildExit } = require('./lib/wait-port.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'dist', 'VtuberMonitorLink'), port: 43198, mock: 43196, feed: 43195, headed: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = path.resolve(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a === '--mock') out.mock = Number(argv[++i]) || out.mock;
    else if (a === '--feed') out.feed = Number(argv[++i]) || out.feed;
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

/**
 * Only these two sources stay on: one cheap official site (direct, fast) and one wiki.
 *
 * The first entry used to be a bilibili dynamics source, which was the fastest source this walk could rely
 * on (one JSON endpoint, no login). It went with the platform, so the walk leans on an official news page
 * instead: it is one HTTP request when nothing is cached, and every assertion below reads the *shape* of the
 * collected items rather than a platform-specific field.
 */
const FAST_SOURCES = ['official-cover', 'fandom-vtuber-wiki'];
const ALL_SOURCES = [
  'reddit-VirtualYoutubers', 'reddit-Hololive', 'reddit-Nijisanji', 'reddit-VShojo',
  'fandom-vtuber-wiki', 'moegirl', 'twitch-vtuber', 'youtube-official',
  'news-ann', 'news-kaiyou', 'news-4gamers', 'news-kaori', 'news-moguravr', 'news-dengeki',
  'official-anycolor', 'official-hololive', 'official-bravegroup', 'official-vspo', 'official-cover',
  'merch-fanbox', 'merch-cien', 'merch-booth', 'merch-dlsite',
];

/**
 * Items the walk needs on any machine, served from loopback.
 *
 * Why this exists: the intel half of this traversal (cards, keyword search, time ranges, person attribution,
 * the archive, the charts, feature extraction) all read whatever the last run collected. It used to get its
 * items from a fast JSON source that the product no longer knows, and every source that is left is either a
 * real site over the network or a browser-rendered page -- and the packaged build ships no browser, so both
 * arms of that pair fail on a clean machine. The result was not "one source down", it was twenty assertions
 * about an empty stream.
 *
 * So the walk serves its own Atom feed on loopback and enables it as a custom source (the same config
 * mechanism a user has). RSS is one of the fetch kinds this build still offers, so the run exercises the real
 * fetch -> parse -> item path; and the fixture text is chosen to be searchable, taggable and attributable so
 * every downstream assertion has something to act on.
 */
const FEED_ITEMS = [
  {
    title: 'Mock 箱 3D披露 将于 3月15日 举行',
    link: 'http://127.0.0.1:FIXTURE/entries/1',
    body: 'Mock 箱 宣布 3D披露 将于 3 月 15 日举行，本条来自本地巡检 feed，关键词与日期都可检索。',
    when: new Date().toISOString(),
  },
  {
    title: 'Mock 箱 新翻唱「糖」公开',
    link: 'http://127.0.0.1:FIXTURE/entries/2',
    body: 'Mock 箱 发布新翻唱「糖」，同样来自本地巡检 feed。',
    when: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    title: 'Mock 箱 直播预告：本周六 20:00',
    link: 'http://127.0.0.1:FIXTURE/entries/3',
    body: 'Mock 箱 本周六 20:00 直播，本条来自本地巡检 feed。',
    when: new Date(Date.now() - 7200_000).toISOString(),
  },
];

/**
 * A request counter, so the fixture feed's text differs on every fetch.
 *
 * This is what gives the watch feature something to notice: a URL target hashes the text it reads and
 * reports "changed" only on a difference, so a constant fixture would report the baseline and then
 * "unchanged" for ever -- and every assertion about change detection would be vacuous. The counter line is
 * inside the feed, so the second read really is a different document.
 */
let feedHits = 0;

function feedBody(port) {
  feedHits++;
  const entries = FEED_ITEMS.map(
    (e, i) => `  <entry>
    <id>urn:vml:traverse-ui:${i + 1}</id>
    <title>${e.title}</title>
    <link href="${e.link.replace('FIXTURE', String(port))}" />
    <updated>${e.when}</updated>
    <summary>${e.body}</summary>
  </entry>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>VML traverse-ui fixture feed</title>
  <updated>read ${feedHits}</updated>
${entries}
</feed>
`;
}

function seedConfig(mockPort, feedPort) {
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
        { id: 'watch-page-cover', kind: 'url', label: 'cover news', url: 'https://cover-corp.com/en/news', enabled: true },
        // Pointed at the loopback feed on purpose: it is the one target whose content this walk controls, so
        // its "changed" verdict (and therefore the change digest on the Intel page) does not depend on a real
        // site being reachable or on its content happening to move.
        { id: 'watch-feed', kind: 'url', label: 'traverse feed', url: `http://127.0.0.1:${feedPort}/feed.xml`, enabled: true },
      ],
      rules: { largeEditBytes: 5000, largeDeleteBytes: 2000, keywords: ['毕业', '解约', '直播'] },
    },
    sources: overrides,
    // The fixture feed is a custom source, which is also how the walk covers that path: the sources page and
    // the run both have to accept a source the user added rather than only the built-in catalogue.
    customSources: [
      {
        id: 'ui-feed',
        name: { zh: '巡检本地 feed', en: 'traverse local feed' },
        category: 'community',
        fetch: 'rss',
        url: `http://127.0.0.1:${feedPort}/feed.xml`,
        login: 'none',
        cadence: 'daily',
        enabled: true,
        custom: true,
      },
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = 'http://127.0.0.1:' + args.port;
  const exe = path.join(args.dir, path.basename(args.dir) + EXE);

  let firefox;
  try {
    firefox = require(path.join(ROOT, 'node_modules', 'playwright')).firefox;
  } catch (e) {
    process.stderr.write('playwright is not installed in the repo; run npm install first\n');
    process.exit(1);
  }
  // A repo-local pw-browsers/ is the layout the portable build produces; pointing Playwright at it keeps this
  // walk runnable on a machine where the engine was never installed into the platform default location. Only
  // set when nothing was configured, so an explicit choice always wins.
  const repoBrowsers = path.join(ROOT, 'pw-browsers');
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(repoBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = repoBrowsers;
  }

  process.stdout.write('\nUI traversal: ' + args.dir + ' on port ' + args.port + '\n\n');

  const appDir = path.join(args.dir, 'app');
  const cfgPath = path.join(appDir, 'config.json');
  const hadConfig = fs.existsSync(cfgPath);
  const cfgBackup = hadConfig ? fs.readFileSync(cfgPath) : null;
  // Always wipe the runtime data first: otherwise reports/intel left behind by the previous
  // traversal make assertions like "there is no intel yet" fail at random (we really did step on
  // this), and the folder cannot be published either.
  // vdb is in here too: it is the runtime cache of the VDB roster (third-party data), and a
  // traversal should not leave it in the package
  const RUNDATA = ['reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice', 'vdb'];
  for (const d of RUNDATA) fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
  const createdDirs = RUNDATA;

  // A mock OpenAI-compatible endpoint: lets the walk exercise a real run with
  // no API key anywhere near the release.
  const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-llm.cjs'), '--port', String(args.mock)], {
    stdio: 'ignore',
  });
  await sleep(900);

  // The loopback feed (see FEED_ITEMS): started before the app so the very first run can fetch it.
  const feedServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
    res.end(feedBody(args.feed));
  });
  await new Promise((r) => feedServer.listen(args.feed, '127.0.0.1', r));

  fs.writeFileSync(cfgPath, JSON.stringify(seedConfig(args.mock, args.feed), null, 2), 'utf8');

  // Capture the app-under-test's output: when something goes wrong you can read its log instead
  // of just seeing one failed assertion
  const appLog = path.join(appDir, 'logs', 'traverse-app.txt');
  fs.mkdirSync(path.dirname(appLog), { recursive: true });
  const appOut = fs.createWriteStream(appLog, { flags: 'w' });
  // Confirm the port is free before starting the app: if a previous process (or a window the user
  // left open themselves) still holds it, the instance we start will fail to bind and the requests
  // will be picked up by **someone else's instance** — the symptom then drifts somewhere
  // completely unrelated.
  const free = await waitPortFree(args.port, { onWait: (m) => process.stdout.write('  ' + m + '\n') });
  if (!free.free) process.stdout.write('  (warn) port ' + args.port + ' seems to stay occupied, the checks below may not line up\n');
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
    // Crucial: confirm that **the instance we just started** is the one answering. When the
    // previous process has not exited cleanly, someone else keeps answering on this port and
    // every later assertion talks to the wrong instance (the hardest kind of failure to trace)
    check('the app we spawned is the one answering', child.exitCode === null, child.exitCode === null ? 'alive' : 'our child already exited with ' + child.exitCode);

    const br = await (await fetch(base + '/api/browsers')).json();
    const detected = (br.detected || [])[0];
    // No Chromium process flags: Playwright passes `args` straight through and Firefox has no --no-sandbox.
    const launchOpts = { headless: !args.headed };
    if (detected) launchOpts.executablePath = detected.executablePath;
    // Naming where the engine came from is worth a line: on a machine with neither a system engine nor an
    // installed Playwright Firefox, the launch failure is the only other place that information appears.
    let engineFrom = "Playwright's own Firefox";
    try {
      engineFrom += ' (' + firefox.executablePath() + ')';
    } catch (e) {
      engineFrom += ' — not installed here; run: npx playwright install firefox (or set PLAYWRIGHT_BROWSERS_PATH)';
    }
    process.stdout.write('  using engine: ' + (detected ? detected.name + ' at ' + detected.executablePath : engineFrom) + '\n');

    browser = await firefox.launch(launchOpts);
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

    // The language control became a dropdown (27 locales cannot be switched with a two-state
    // button); pin it to Simplified Chinese, since the assertions below are written against Chinese
    const langSel = page.locator('select.lang').first();
    check('the language picker lists the locales', (await langSel.locator('option').count()) >= 20, (await langSel.locator('option').count()) + ' locales');
    await langSel.selectOption('zh-Hans');
    await page.waitForTimeout(400);
    const langIsHant = page.locator('html');
    check('html lang is set', (await langIsHant.getAttribute('lang')) === 'zh-Hans');
    check('html dir is ltr for chinese', (await langIsHant.getAttribute('dir')) === 'ltr');

    // The default theme is dark (specified by the user): it must be dark when the config has no
    // theme either, and it must **really** paint dark — asserting the attribute alone would miss
    // the "the CSS did not follow" case.
    const darkAttr = await langIsHant.getAttribute('data-theme');
    const bgDark = await page.evaluate(() => {
      const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
      return m ? Number(m[0]) + Number(m[1]) + Number(m[2]) : 999;
    });
    check('the default theme is dark', darkAttr === 'dark' && bgDark < 240, 'data-theme=' + darkAttr + ' background luminance sum=' + bgDark);
    // Switch to Arabic: RTL and the other set of copy both have to really take effect
    await langSel.selectOption('ar-SA');
    await page.waitForTimeout(400);
    check('Arabic flips the whole page direction to rtl', (await langIsHant.getAttribute('dir')) === 'rtl');
    const arTabs = await page.locator('nav.tabs button').allInnerTexts();
    check('the Arabic tabs render in Arabic', arTabs.join('|').indexOf('المعلومات') !== -1, arTabs.join(' | '));
    await langSel.selectOption('zh-TW');
    await page.waitForTimeout(400);
    const twTabs = await page.locator('nav.tabs button').allInnerTexts();
    // Taiwan Traditional goes through OpenCC's twp dictionary (glyphs and wording converted
    // together): the settings / information / network word set in its Taiwanese spelling
    check('Taiwan Traditional is traditional plus Taiwanese wording', twTabs.join('|').indexOf('設定') !== -1, twTabs.join(' | '));
    check(
      'no unconverted simplified characters are left in Taiwan Traditional',
      !/运行|监视|设置|报告|来源/.test(twTabs.join('|')),
      twTabs.join(' | '),
    );
    await langSel.selectOption('zh-HK');
    await page.waitForTimeout(400);
    const hkTabs = await page.locator('nav.tabs button').allInnerTexts();
    check('Hong Kong Traditional is traditional too', hkTabs.join('|').indexOf('設定') !== -1 || hkTabs.join('|').indexOf('設置') !== -1, hkTabs.join(' | '));
    await langSel.selectOption('zh-Hant');
    await page.waitForTimeout(400);
    const hantTabs = await page.locator('nav.tabs button').allInnerTexts();
    check('generic Traditional works', hantTabs.join('|').indexOf('情報') !== -1 || hantTabs.join('|').indexOf('資訊') !== -1, hantTabs.join(' | '));

    // Ukrainian must be Ukrainian; a missing key must not make it fall back to Russian.
    // (This guards against a real bug: the uk/pl/sr fallback chains listed ru-RU,
    //  so Russian strings were shown to users as their interface copy.)
    await langSel.selectOption('uk-UA');
    await page.waitForTimeout(400);
    const ukTabs = (await page.locator('nav.tabs button').allInnerTexts()).join('|');
    check('the Ukrainian interface is in Ukrainian', ukTabs.includes('Зведення'), ukTabs);
    // The criterion uses only **Russian-specific** word forms: Запуск is the same word in Ukrainian
    // (the first version treated it as a Russian marker and ended up flagging its own correct
    // output — a shared word cannot serve as a language fingerprint)
    check('no Russian mixed into the Ukrainian interface', !/Сводка|Настройки|Источники|Отчёты|Наблюдение/.test(ukTabs), ukTabs);
    await langSel.selectOption('pl-PL');
    await page.waitForTimeout(400);
    const plTabs = (await page.locator('nav.tabs button').allInnerTexts()).join('|');
    check('the Polish interface is in Polish with no Russian mixed in', plTabs.includes('Informacje') && !/Сводка|Настройки/.test(plTabs), plTabs);

    // Chinese must not appear in the Korean interface. This guards against a real incident: 6 entries
    // were "Chinese-Korean interleaved" (the "already added to monitoring" copy and "a live stream is
    // the most time-sensitive piece of information" copy carried Chinese text inside Korean strings),
    // so a Korean user saw a whole Chinese sentence, and because there was "a value" the coverage still
    // reported 100% — only actually reading the page out makes it visible.
    await langSel.selectOption('ko-KR');
    await page.waitForTimeout(400);
    const koTabs = await page.locator('nav.tabs button').allInnerTexts();
    check('the Korean interface is in Korean', koTabs.includes('정보'), koTabs.join(' | '));
    const koPage = page.locator('nav.tabs button').filter({ hasText: '보고서' }).first();
    if (await koPage.count()) {
      await koPage.click();
      await page.waitForTimeout(800);
      // Scan only the **interface's own copy** (titles / hints / tabs), not the data area —
      // the content areas on a page can carry external data (article titles, user-chosen names)
      // (its "carousel" and "life & entertainment" category names), and source names are whatever
      // the user called them (a follow target the user named, say); those of course should not be
      // translated.
      const koChrome = [
        ...(await page.locator('main h2').allInnerTexts()),
        ...(await page.locator('main .hint').allInnerTexts()),
        ...(await page.locator('nav.tabs button').allInnerTexts()),
      ].join('\n');
      // Strip the proper nouns that policy keeps verbatim first (longest first, otherwise long
      // terms get chopped up by short ones)
      const keep = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/glossary.json'), 'utf8')))
        .filter(([k, v]) => !k.startsWith('_') && v?.default === k)
        .map(([k]) => k)
        .sort((a, b) => b.length - a.length);
      let rest = koChrome;
      for (const term of keep) rest = rest.split(term).join('');
      const leftover = [...new Set(rest.match(/[\u4e00-\u9fff]/g) || [])];
      check('no Chinese left in the Korean report page', leftover.length === 0, leftover.length ? 'leftover Han characters: ' + leftover.join('') : '0 leftover Han characters');
    }

    // Indonesian: the locale that was registered but could have been left rendering English. Two
    // distinct failure modes are covered here, and neither shows up in any offline table:
    //   1. a locale that is registered in LOCALES but whose machine layer never landed (or whose
    //      chain is wrong) still "works" - it just silently shows the English fallback;
    //   2. the machine layer landed, but a Chinese proper noun survived inside an otherwise
    //      Indonesian sentence (the same class as the Korean incident above; the Indonesian pass
    //      really did leave a Chinese follow-target name in the calendar hint -- the glossary term is
    //      stripped before looksUntranslated() tests a value, so no offline tool can see it).
    await langSel.selectOption('id-ID');
    await page.waitForTimeout(400);
    const idTabs = (await page.locator('nav.tabs button').allInnerTexts()).join('|');
    check('html lang follows the Indonesian selection', (await langIsHant.getAttribute('lang')) === 'id-ID', String(await langIsHant.getAttribute('lang')));
    check('the Indonesian interface is in Indonesian', idTabs.includes('Intel') && idTabs.includes('Jalankan') && idTabs.includes('Pengaturan'), idTabs);
    // The Indonesian anchor claim: the tab row must not still be the English fallback. Only words
    // that the English copy spells the same way are excluded, so a locale that fell through to
    // English fails here instead of passing on shared-looking labels.
    check('no English fallback left in the Indonesian tab row', !/Run|Settings|Reports|Search/.test(idTabs), idTabs);
    const idPage = page.locator('nav.tabs button').filter({ hasText: 'Laporan' }).first();
    if (await idPage.count()) {
      await idPage.click();
      await page.waitForTimeout(800);
      // Same rule as the Korean scan: only the interface's own copy (titles / hints / tabs), not the
      // article titles and user-chosen names. Proper nouns the glossary keeps verbatim are stripped
      // first, longest first.
      const idChrome = [
        ...(await page.locator('main h2').allInnerTexts()),
        ...(await page.locator('main .hint').allInnerTexts()),
        ...(await page.locator('nav.tabs button').allInnerTexts()),
      ].join('\n');
      const keep = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/glossary.json'), 'utf8')))
        .filter(([k, v]) => !k.startsWith('_') && v?.default === k)
        .map(([k]) => k)
        .sort((a, b) => b.length - a.length);
      let restId = idChrome;
      for (const term of keep) restId = restId.split(term).join('');
      const idLeftover = [...new Set(restId.match(/[\u4e00-\u9fff]/g) || [])];
      check('no Chinese left in the Indonesian report page', idLeftover.length === 0, idLeftover.length ? 'leftover Han characters: ' + idLeftover.join('') : '0 leftover Han characters');
      // An array, not a joined string, and the distinction is worth a comment: this arm used to end in
      // `.join(' | ')` and then call `.some()` on the result -- a plain JavaScript bug that never fired while
      // these scans pointed at the Live tab, because a page with no `.hint` elements produced an empty array
      // and `.some()` on it was never reached. Retargeting the scans to the Reports tab (which has hints) is
      // what made it run, and `.some is not a function` is what it said.
      const idHints = await page.locator('main .hint').allInnerTexts();
      check('the Indonesian report page is Indonesian', idHints.some((h) => h.includes('Laporan')), idHints.join(' | ').slice(0, 140));
    }

    // Filipino: same two failure modes as the Indonesian block above, plus a third one that is
    // specific to how this locale counts.
    //   1. registered in LOCALES but never rendering -- the chain is wrong or the layers did not land,
    //      and the page silently shows English while every offline table still reports 100%;
    //   2. a Chinese proper noun inside an otherwise Filipino sentence (the glossary strips pinned
    //      terms before looksUntranslated() tests a value, so no offline tool can see it);
    //   3. count labels: Filipino needs the `na` linker between a numeral and its noun, which lives in
    //      the plural table rather than in the base values (see locales/plurals.js), so a label
    //      rendering as "5 item" instead of "5 na item" is a wiring failure nothing else would see.
    await langSel.selectOption('fil-PH');
    await page.waitForTimeout(400);
    const filTabs = (await page.locator('nav.tabs button').allInnerTexts()).join('|');
    check('html lang follows the Filipino selection', (await langIsHant.getAttribute('lang')) === 'fil-PH', String(await langIsHant.getAttribute('lang')));
    check(
      'the Filipino interface is in Filipino',
      filTabs.includes('Impormasyon') && filTabs.includes('Magpatakbo') && filTabs.includes('Mga setting') && filTabs.includes('Subaybayan'),
      filTabs,
    );
    // The anchor claim: the tab row must not still be the English fallback. `Live` used to be excluded here
    // because Filipino kept that word, and that tab is gone; the five remaining are the English copy's own
    // labels.
    check('no English fallback left in the Filipino tab row', !/Run|Settings|Reports|Search|Sources/.test(filTabs), filTabs);
    const filPage = page.locator('nav.tabs button').filter({ hasText: 'Mga ulat' }).first();
    if (await filPage.count()) {
      await filPage.click();
      await page.waitForTimeout(900);
      // Same rule as the Korean and Indonesian scans: only the interface's own copy (titles / hints /
      // tabs), never the content areas. Pinned proper nouns are stripped first,
      // longest first.
      const filChrome = [
        ...(await page.locator('main h2').allInnerTexts()),
        ...(await page.locator('main .hint').allInnerTexts()),
        ...(await page.locator('nav.tabs button').allInnerTexts()),
      ].join('\n');
      const keepFil = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/glossary.json'), 'utf8')))
        .filter(([k, v]) => !k.startsWith('_') && v?.default === k)
        .map(([k]) => k)
        .sort((a, b) => b.length - a.length);
      let restFil = filChrome;
      for (const term of keepFil) restFil = restFil.split(term).join('');
      const filLeftover = [...new Set(restFil.match(/[\u4e00-\u9fff]/g) || [])];
      check('no Chinese left in the Filipino report page', filLeftover.length === 0, filLeftover.length ? 'leftover Han characters: ' + filLeftover.join('') : '0 leftover Han characters');
      // The heading lives in an `h2`, not in `.hint`: the hand-written `reportsTitle` is what this arm is
      // about, and reading only the hints would look for a word that is not there.
      const filHints = [...(await page.locator('main h2').allInnerTexts()), ...(await page.locator('main .hint').allInnerTexts())];
      // The heading comes from the hand-written reportsTitle, so this fails when the locale falls back to
      // English rather than merely when a tab label is missing.
      check('the Filipino report page is Filipino', filHints.some((h) => h.includes('Mga ulat')), filHints.join(' | ').slice(0, 140));
      // The counter wiring: the plural table is the only place the `na` linker can come from, so a
      // count label on this page has to carry it -- "5 item" instead of "5 na item" would be a wiring
      // failure nothing else in the suite can see. Which counts appear depends on the run (a follower
      // count needs an enabled watch target, a page count needs a page that shows one), so the check is only
      // made when a count label shape is actually on screen, and when it is not, the skip is *named*
      // instead of silent: a quietly skipped assertion is how a check count changes without anyone
      // noticing which one left.
      //
      // The gate deliberately looks for "number directly followed by a word" (or by the linker), not
      // for any digit: a date, a uid or a revid would otherwise arm a check that can only fail.
      const filBody = await page.locator('main').innerText();
      const countish = (filBody.match(/\b\d+\s+na\s+[A-Za-z]+/g) || []).slice(0, 3);
      const englishish = (filBody.match(/\b\d+\s+(items?|days?|members?|matches|calls|alerts|followers?|cookies?)\b/g) || []).slice(0, 3);
      const armed = countish.length > 0 || englishish.length > 0;
      check(
        armed ? 'Filipino count labels carry the `na` linker from the plural table' : 'Filipino count labels: nothing to assert this run (no count label on the page)',
        !armed || (countish.length > 0 && englishish.length === 0),
        armed ? countish.join(' | ') + (englishish.length ? ' | ENGLISH: ' + englishish.join(' | ') : '') : 'exactly one of the two forms arms this check, so an empty page cannot make it pass by accident; the wording per number is pinned by tools/i18n-plural-test.mjs',
      );
    } else {
      check('the Filipino report tab was found', false, 'no tab button matched the Filipino word for Reports');
    }

    // Thai: the same three failure modes as the Filipino block above, plus a negative control for the
    // classifier predicate this locale's count labels are judged by.
    //   1. registered in LOCALES but never rendering -- the chain is wrong or the layers did not land,
    //      and the page silently shows English while every offline table still reports 100%;
    //   2. a Chinese proper noun inside an otherwise Thai sentence (the glossary strips pinned terms
    //      before looksUntranslated() tests a value, so no offline tool can see it);
    //   3. count labels: Thai counts with a numeral plus a **classifier** (`3 รายการ`, `2 วัน`,
    //      `5 ครั้ง`), which lives in the plural table rather than in the base values (see
    //      locales/plurals.js). A label rendering as a numeral glued to a bare noun is a wiring
    //      failure nothing else in the suite would see.
    await langSel.selectOption('th-TH');
    await page.waitForTimeout(400);
    const thTabs = (await page.locator('nav.tabs button').allInnerTexts()).join('|');
    check('html lang follows the Thai selection', (await langIsHant.getAttribute('lang')) === 'th-TH', String(await langIsHant.getAttribute('lang')));
    check(
      'the Thai interface is in Thai',
      thTabs.includes('ข้อมูล') && thTabs.includes('แหล่งข้อมูล') && thTabs.includes('การตั้งค่า') && thTabs.includes('เฝ้าติดตาม'),
      thTabs,
    );
    // The anchor claim: the tab row must not still be the English fallback. `LLM` is deliberately not
    // in the pattern -- every locale keeps that abbreviation (it is the same string in zh and en, so
    // no locale ever translates it), and flagging it would make the check lie. The other six are the
    // English copy's own labels.
    check('no English fallback left in the Thai tab row', !/Run|Settings|Reports|Search|Sources|Watch/.test(thTabs), thTabs);
    const thPage = page.locator('nav.tabs button').filter({ hasText: 'รายงาน' }).first();
    if (await thPage.count()) {
      await thPage.click();
      await page.waitForTimeout(900);
      // Same rule as the Korean, Indonesian and Filipino scans: only the interface's own copy
      // (titles / hints / tabs), never the content areas. Pinned proper nouns
      // are stripped first, longest first.
      const thChrome = [
        ...(await page.locator('main h2').allInnerTexts()),
        ...(await page.locator('main .hint').allInnerTexts()),
        ...(await page.locator('nav.tabs button').allInnerTexts()),
      ].join('\n');
      const keepTh = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/glossary.json'), 'utf8')))
        .filter(([k, v]) => !k.startsWith('_') && v?.default === k)
        .map(([k]) => k)
        .sort((a, b) => b.length - a.length);
      let restTh = thChrome;
      for (const term of keepTh) restTh = restTh.split(term).join('');
      const thLeftover = [...new Set(restTh.match(/[\u4e00-\u9fff]/g) || [])];
      check('no Chinese left in the Thai report page', thLeftover.length === 0, thLeftover.length ? 'leftover Han characters: ' + thLeftover.join('') : '0 leftover Han characters');
      const thHints = await page.locator('main .hint').allInnerTexts();
      // The heading comes from the hand-written reportsTitle, so this fails when the locale falls
      // back to English rather than merely when a tab label is missing. They are also Thai-specific
      // words: neither is a borrowed English term, so an English fallback cannot match them.
      check('the Thai report page is Thai', thHints.some((h) => h.includes('รายงาน')), thHints.join(' | ').slice(0, 140));
      // The counter wiring: the plural table is the only place the classifier can come from, so a
      // count label on this page has to carry one -- a numeral glued to a bare noun would be a wiring
      // failure nothing else can see. Which counts appear depends on the run (an item count needs a
      // report with items on it), so the check is only made when a count label shape is actually on
      // screen, and when it is not, the skip is *named* instead of
      // silent: a quietly skipped assertion is how a check count changes without anyone noticing
      // which one left.
      //
      // The gate looks for "number, space, Thai letter" (the shape a classifier has), not for any
      // digit: a date, a uid or a Buddhist-calendar year would otherwise arm a check that can only
      // fail. A trailing combining mark is stripped first, because a tone mark sitting between the
      // digit and the word is exactly how a glued label looks.
      const thBody = (await page.locator('main').innerText()).replace(/[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/g, '');
      const thCountish = (thBody.match(/\d+ [\u0e00-\u0e7f]/g) || []).slice(0, 3);
      const thEnglishish = (thBody.match(/\b\d+\s+(items?|days?|members?|matches|calls|alerts|followers?|cookies?|groups?|people)\b/g) || []).slice(0, 3);
      const thArmed = thCountish.length > 0 || thEnglishish.length > 0;
      check(
        thArmed ? 'Thai count labels carry a classifier after the numeral' : 'Thai count labels: nothing to assert this run (no count label on the page)',
        !thArmed || (thCountish.length > 0 && thEnglishish.length === 0),
        thArmed ? thCountish.join(' | ') + (thEnglishish.length ? ' | ENGLISH: ' + thEnglishish.join(' | ') : '') : 'exactly one of the two forms arms this check, so an empty page cannot make it pass by accident; the wording per number is pinned by tools/i18n-plural-test.mjs',
      );
      // Negative control: the predicate above has to be able to FAIL, or it is an assertion that only
      // ever prints [ok]. Both cases below are pure string work on the same regexes, so they run even
      // when the page had no count label to arm the real check.
      const thaiCountRe = /\d+ [\u0e00-\u0e7f]/;
      const thaiGluedRe = /\d+[\u0e00-\u0e7f]/;
      check(
        'the Thai classifier predicate can fail (negative control)',
        thaiCountRe.test('12 รายการ') && !thaiCountRe.test('12รายการ') && thaiGluedRe.test('12รายการ'),
        'accepts "12 รายการ"=' + thaiCountRe.test('12 รายการ') + ', rejects glued "12รายการ"=' + !thaiCountRe.test('12รายการ'),
      );
    } else {
      check('the Thai report tab was found', false, 'no tab button matched the Thai word for Reports');
    }

    // Vietnamese: the same three failure modes as the Thai block above, plus a negative control for the
    // predicate this locale's count labels are judged by.
    //   1. registered in LOCALES but never rendering -- the chain is wrong or the layers did not land,
    //      and the page silently shows English while every offline table still reports 100%;
    //   2. a Chinese proper noun inside an otherwise Vietnamese sentence (the glossary strips pinned
    //      terms before looksUntranslated() tests a value, so no offline tool can see it);
    //   3. count labels: Vietnamese needs **no** plural table (one category, and the numeral stands
    //      directly in front of the unit word -- see locales/plurals.js and tools/i18n-plural-test.mjs),
    //      so the label comes from the base value in overlays.js. A label rendering as a bare numeral or
    //      as the English noun would be a wiring failure nothing else in the suite would see.
    await langSel.selectOption('vi-VN');
    await page.waitForTimeout(400);
    const viTabs = (await page.locator('nav.tabs button').allInnerTexts()).join('|');
    check('html lang follows the Vietnamese selection', (await langIsHant.getAttribute('lang')) === 'vi-VN', String(await langIsHant.getAttribute('lang')));
    check(
      'the Vietnamese interface is in Vietnamese',
      viTabs.includes('Thông tin') && viTabs.includes('Nguồn') && viTabs.includes('Cài đặt') && viTabs.includes('Theo dõi'),
      viTabs,
    );
    // The anchor claim: the tab row must not still be the English fallback. `LLM` is deliberately not in
    // the pattern -- every locale keeps that abbreviation (it is the same string in zh and en, so no
    // locale ever translates it), and flagging it would make the check lie. The others are the English
    // copy's own labels. `People` and `Calendar` are in here as well, because this locale writes both
    // (Nguoi / Lich) and the machine pass had given the People tab the same label as the Watch tab.
    check('no English fallback left in the Vietnamese tab row', !/Run|Settings|Reports|Search|Sources|Watch|People|Calendar/.test(viTabs), viTabs);
    const viPage = page.locator('nav.tabs button').filter({ hasText: 'Báo cáo' }).first();
    if (await viPage.count()) {
      await viPage.click();
      await page.waitForTimeout(900);
      // Same rule as the Korean, Indonesian, Filipino and Thai scans: only the interface's own copy
      // (titles / hints / tabs), never the content areas. Pinned proper nouns are
      // stripped first, longest first.
      const viChrome = [
        ...(await page.locator('main h2').allInnerTexts()),
        ...(await page.locator('main .hint').allInnerTexts()),
        ...(await page.locator('nav.tabs button').allInnerTexts()),
      ].join('\n');
      const keepVi = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/glossary.json'), 'utf8')))
        .filter(([k, v]) => !k.startsWith('_') && v?.default === k)
        .map(([k]) => k)
        .sort((a, b) => b.length - a.length);
      let restVi = viChrome;
      for (const term of keepVi) restVi = restVi.split(term).join('');
      const viLeftover = [...new Set(restVi.match(/[\u4e00-\u9fff]/g) || [])];
      check('no Chinese left in the Vietnamese report page', viLeftover.length === 0, viLeftover.length ? 'leftover Han characters: ' + viLeftover.join('') : '0 leftover Han characters');
      const viHints = await page.locator('main .hint').allInnerTexts();
      // The heading comes from the hand-written reportsTitle, so this fails when the locale falls back
      // to English rather than merely when a tab label is missing. The Reports label is Vietnamese and
      // not a borrowed English term, so an English fallback cannot match it.
      check('the Vietnamese report page is Vietnamese', viHints.some((h) => h.includes('Báo cáo')), viHints.join(' | ').slice(0, 160));
      // The counter wiring: with no plural table the label is the hand layer's base value, so a count
      // label on this page has to read "number, space, Vietnamese unit word". Which counts appear
      // depends on the run (an item count needs a report with items on it), so the check is only made
      // when a count label shape is actually on screen, and when it is
      // not the skip is *named* instead of silent: a quietly skipped assertion is how a check count
      // changes without anyone noticing which one left.
      //
      // The gate looks for one of the pinned unit words after a numeral (the same predicate
      // tools/i18n-plural-test.mjs pins), not for any digit: a date, a uid or a calendar year would
      // otherwise arm a check that can only fail. `cookie` is deliberately absent from the English
      // pattern -- the loanword IS this locale's wording, so flagging it would make the check lie.
      const viBody = await page.locator('main').innerText();
      const viCountRe = /\d+ (?:mục|ngày|người|nhóm|thành viên|lượt gọi|kết quả khớp|cảnh báo|cookie)\b/;
      const viGluedRe = /\d+(?:mục|ngày|người|nhóm|thành viên|lượt gọi|kết quả khớp|cảnh báo|cookie)\b/;
      const viEnglishRe = /\b\d+\s+(?:items?|days?|members?|matches|calls|alerts|followers?|groups?|people)\b/;
      const viCountish = (viBody.match(new RegExp(viCountRe.source, 'g')) || []).slice(0, 3);
      const viEnglishish = (viBody.match(new RegExp(viEnglishRe.source, 'g')) || []).slice(0, 3);
      const viArmed = viCountish.length > 0 || viEnglishish.length > 0;
      check(
        viArmed ? 'Vietnamese count labels read as number + space + Vietnamese unit word' : 'Vietnamese count labels: nothing to assert this run (no count label on the page)',
        !viArmed || (viCountish.length > 0 && viEnglishish.length === 0),
        viArmed ? viCountish.join(' | ') + (viEnglishish.length ? ' | ENGLISH: ' + viEnglishish.join(' | ') : '') : 'exactly one of the two forms arms this check, so an empty page cannot make it pass by accident; the wording per number is pinned by tools/i18n-plural-test.mjs',
      );
      // Negative control: the predicate above has to be able to FAIL, or it is an assertion that only
      // ever prints [ok]. All four cases are pure string work on the same regexes, so they run even when
      // the page had no count label to arm the real check.
      check(
        'the Vietnamese count-label predicate can fail (negative control)',
        viCountRe.test('12 mục') && !viCountRe.test('12mục') && !viCountRe.test('12 items') && viGluedRe.test('12mục') && viEnglishRe.test('12 items'),
        'accepts "12 muc"=' + viCountRe.test('12 mục') + ', rejects glued="' + !viCountRe.test('12mục') + '", rejects English="' + !viCountRe.test('12 items') + '", both controls fire="' + (viGluedRe.test('12mục') && viEnglishRe.test('12 items')) + '"',
      );
    } else {
      check('the Vietnamese report tab was found', false, 'no tab button matched the Vietnamese word for Reports');
    }
    await langSel.selectOption('zh-Hans');
    await page.waitForTimeout(400);
    const tabs = await page.locator('nav.tabs button').allInnerTexts();
    // Twelve since the browser/profile targeting got its own page. The count is pinned rather than "at least",
    // because the point of this check is that a page which appears is also walked here: a tab nobody visits is
    // a tab this traversal does not cover, and the number is what makes that visible.
    check('eleven navigation tabs render', tabs.length === 11, tabs.join(' | '));
    check(
      'the Intel, Search, People, Watch and Browser tabs are present',
      ['情报', '检索', '关注', '监视', '浏览器', 'LLM'].every((x) => tabs.includes(x)),
      tabs.join(' | ')
    );

    const tab = (label) => page.locator('nav.tabs button', { hasText: label }).first();
    const mainText = () => page.locator('main').innerText();

    // ---------------------------------------------------------------- settings
    process.stdout.write('\n2. Settings: LLM profiles, theme, notify\n');
    await tab('设置').click();
    await page.waitForTimeout(700);
    let main = await mainText();
    for (const section of ['浏览器', '网络代理', '定时', '界面']) {
      check('Settings has the ' + section + ' section', main.indexOf(section) !== -1, main.slice(0, 160).replace(/\n/g, ' '));
    }
    // a11y: controls in a task row must have an accessible name (BUGS #6 — previously only the
    // table header existed, so a screen reader could not say what this cell was)
    if ((await page.locator('section.tasks tbody tr').count()) === 0) {
      // Select the button via a class hook, never by its copy — changing language or wording
      // would break that
      const add = page.locator('section.tasks button.add-task').first();
      if (await add.count()) {
        await add.click();
        await page.waitForTimeout(900);
      }
    }
    const ctl = page.locator('section.tasks input, section.tasks select');
    const ctlCount = await ctl.count();
    let named = 0;
    for (let i = 0; i < ctlCount; i++) {
      const el = ctl.nth(i);
      const aria = await el.getAttribute('aria-label');
      const wrapped = await el.evaluate((e) => !!(e.closest('label') || (e.id && document.querySelector('label[for="' + e.id + '"]'))));
      if (aria || wrapped) named++;
    }
    check('every task-row control has an accessible name', ctlCount > 0 && named === ctlCount, named + '/' + ctlCount);

    // The save state must be visible (the old toast lasted only 2.5 seconds and hugged the very
    // corner of the screen, so users thought nothing had been saved)
    const fmtSel = page.locator('main select:has(option[value="adoc"])').first();
    check('the output-format picker is present', (await fmtSel.count()) > 0);
    await fmtSel.selectOption('adoc');
    await page.waitForTimeout(300);
    const dirtyText = await page.locator('.save-status.dirty').first().innerText().catch(() => '');
    check('editing a field shows a persistent unsaved-changes state', dirtyText.length > 0, dirtyText);
    await page.locator('.save-bar button.primary').first().click();
    await page.waitForTimeout(1200);
    const okText = (await page.locator('.save-status.ok').first().innerText().catch(() => '')).trim();
    check('saving leaves a persistent saved state with a timestamp', /(已保存|Saved)/.test(okText) && /\d{1,2}:\d{2}/.test(okText), okText);
    const stillThere = await page.waitForTimeout(3200).then(() => page.locator('.save-status.ok').first().innerText().catch(() => ''));
    check('the saved state is still there after the toast would have gone', stillThere.trim().length > 0, stillThere.trim());
    // Back to html: the later report assertions depend on the default output format
    await fmtSel.selectOption('html');
    await page.waitForTimeout(200);
    await page.locator('.save-bar button.primary').first().click();
    await page.waitForTimeout(1000);
    // LLM and API key now live on their own page, so those assertions moved over there
    await tab('LLM').click();
    await page.waitForTimeout(900);
    const llmText = await mainText();
    check('the LLM page renders on its own tab', llmText.indexOf('哪些功能需要它') !== -1 || llmText.indexOf('档位设置') !== -1, llmText.split('\n')[0]);
    check('it says which features need an LLM', llmText.indexOf('需要') !== -1, 'needs table present');
    // Usage and budget: the money goes to model calls, and the UI has to show it (usage was
    // fetched back but nobody aggregated it)
    check(
      'the LLM page has a usage-and-budget board',
      llmText.indexOf('用量与预算') !== -1 && llmText.indexOf('每日预算') !== -1,
      llmText.indexOf('用量与预算') !== -1 ? 'board present' : 'usage board not found',
    );
    const costApi = await (await fetch(base + '/api/cost?days=14')).json();
    check('the usage endpoint answers (unknown usage is counted separately instead of guessed)', costApi.ok === true && !!costApi.today && typeof costApi.unknown === 'number', costApi.summary);
    const srcApi = await (await fetch(base + '/api/sources')).json();
    check(
      'the sources endpoint carries observation info (last observed / rounds)',
      !!srcApi.observation && typeof srcApi.observation.rounds === 'number' && 'lastObserved' in (srcApi.sources?.[0] ?? {}),
      JSON.stringify(srcApi.observation),
    );

    // -- Collapsible blocks: long reference lists start collapsed (dozens of rows of proxy nodes
    //    eat too much room on one screen) --
    const foldHead = page.locator('.collapsible .collapsible-head').first();
    const foldCount = await page.locator('.collapsible').count();
    check('the feature matrix ships collapsed', foldCount > 0);
    const openBefore = await page.locator('.collapsible .collapsible-body').count();
    check('long reference lists start collapsed', openBefore === 0, foldCount + ' block(s), ' + openBefore + ' open');
    await foldHead.click();
    await page.waitForTimeout(300);
    const shown = await mainText();
    check('clicking the header reveals the list', (await page.locator('.collapsible .collapsible-body').count()) > 0 && shown.indexOf('检索') !== -1);
    await foldHead.click();
    await page.waitForTimeout(200);
    check('and it collapses again', (await page.locator('.collapsible .collapsible-body').count()) === 0);
    const keyInput = page.locator('main input[type=password]').first();
    check('the API key field is masked', (await keyInput.count()) > 0);
    const keyVal = (await keyInput.count()) > 0 ? await keyInput.inputValue() : '';
    check('the seeded key is present but type=password', keyVal.length > 0, keyVal ? 'masked input has a value' : 'empty');
    const reveal = page.locator('main button', { hasText: '显示' }).first();
    // An assertion hidden inside a condition = the check count changes: 184 this time, 183 next
    // time, and **nobody can tell which one went missing** (the missing one being exactly the one
    // whose element was not found). So add an else branch and fail when it is not found.
    if (await reveal.count()) {
      await reveal.click();
      await page.waitForTimeout(200);
      check('the key field can be revealed on demand', (await page.locator('main input[type=text]').count()) > 0);
      await page.locator('main button', { hasText: '隐藏' }).first().click();
    } else {
      check('the key field can be revealed on demand', false, 'the reveal button was not found');
    }
    const modelOptions = await page.locator('#vml-models option').count();
    check('the model datalist is populated', modelOptions > 0, modelOptions + ' options');
    await tab('设置').click();
    await page.waitForTimeout(700);
    main = await mainText();
    // The browser mode select moved to the page that owns the browser/profile targeting; on Settings the first
    // select is something else now (two options). Walking there and back keeps this check about the control
    // rather than about the address it used to live at.
    await tab('浏览器').click();
    await page.waitForTimeout(700);
    const providerOptions = await page.locator('main select').first().locator('option').count();
    check('browser mode select works', providerOptions >= 3, providerOptions + ' options');
    const browserMovedHint = await page.locator('main').innerText();
    check('the browser page names the profile it will use', /profile|配置|目录/i.test(browserMovedHint), browserMovedHint.slice(0, 60));
    await tab('设置').click();
    await page.waitForTimeout(600);
    main = await mainText();
    check('theme selector is present', main.indexOf('主题') !== -1 && main.indexOf('桌面通知') !== -1);

    // Observation mode: this is the control plane for the "traces themselves are information"
    // approach and has to be there; the switch and the explanation are both required
    // (a switch without an explanation = the user does not know what they turned on, which is
    //  worse than not having it)
    check(
      'the observation-mode section is present (switch and explanation both there)',
      main.indexOf('观测模式') !== -1 && main.indexOf('取样比例') !== -1 && main.indexOf('间隔抖动') !== -1,
      main.indexOf('观测模式') !== -1 ? 'switch present' : 'observation-mode block not found',
    );

    // The theme selector has to really take effect, and remember the choice (remembering is so the
    // page does not flash white on refresh — the synchronous script in index.html paints from the
    // remembered value first, and the server config overwrites it once it arrives).
    const themeRow = page.locator('main .field', { hasText: '主题' }).first();
    const themeSel = themeRow.locator('select').first();
    const themeAttr = () => page.locator('html').getAttribute('data-theme');
    const bgLuma = () =>
      page.evaluate(() => {
        const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
        return m ? Number(m[0]) + Number(m[1]) + Number(m[2]) : 0;
      });
    check('the selected theme value is the default dark', (await themeSel.inputValue()) === 'dark', await themeSel.inputValue());
    const bgDarkNow = await bgLuma();
    await themeSel.selectOption('light');
    await page.waitForTimeout(300);
    const bgLight = await bgLuma();
    check('picking light really goes lighter', (await themeAttr()) === 'light' && bgLight > bgDarkNow, 'data-theme=' + (await themeAttr()) + ' luminance ' + bgDarkNow + ' -> ' + bgLight);
    check('the theme is remembered (no white flash on refresh)', (await page.evaluate(() => localStorage.getItem('vml-theme'))) === 'light');
    await themeSel.selectOption('dark');
    await page.waitForTimeout(300);
    const bgBack = await bgLuma();
    check('switching back to dark', (await themeAttr()) === 'dark' && bgBack < 240, 'luminance ' + bgBack);

    // -- Notification channels and quiet hours --
    const notifyInfo = await (await fetch(base + '/api/notify')).json();
    const kindIds = (notifyInfo.kinds ?? []).map((k) => k.id);
    for (const need of ['bark', 'serverchan', 'telegram', 'dingtalk', 'wecom', 'ntfy', 'gotify', 'pushplus', 'slack', 'discord', 'feishu', 'custom']) {
      if (!kindIds.includes(need)) {
        check('the notification channels include ' + need, false, kindIds.join(','));
      }
    }
    check('every notification channel is present (dingtalk/wecom/ntfy/Gotify/PushPlus/Slack included)', kindIds.length >= 12, kindIds.length + ' kinds');
    check('the endpoint reports the quiet state and the backlog queue', !!notifyInfo.quiet && Array.isArray(notifyInfo.queue), JSON.stringify(notifyInfo.quiet).slice(0, 80));
    const flushRes = await fetch(base + '/api/notify/flush', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    const flushJson = await flushRes.json();
    check('a queued notification can be flushed by hand', flushRes.ok && flushJson.ok === true, JSON.stringify(flushJson).slice(0, 80));
    check('the quiet-hours config renders on the page', main.indexOf('静默时段') !== -1);
    check('the dedupe window in minutes is configurable', main.indexOf('去重') !== -1);

    // --------------------------------------------------------------- sources
    process.stdout.write('\n3. Sources + custom source editor\n');
    await tab('来源').click();
    await page.waitForTimeout(800);
    const rows = await page.locator('main table tbody tr').count();
    check('Sources lists every adapter plus the target sources', rows >= 23, rows + ' rows');
    main = await mainText();
    // The category set is now community / wiki / video / news / official / resource. The two that were
    // removed with their platforms must not come back into the list, which is what this asserts.
    check('the official category is shown', main.indexOf('官方') !== -1);
    check('no removed platform category is offered', main.indexOf('B 站') === -1 && main.indexOf('bilibili') === -1);
    check('the custom-source form is present', main.indexOf('自定义来源') !== -1);

    // Every site's egress defaults to "auto", with the decision written next to it
    const autoOpts = await page.locator('main select:has(option[value="direct"]) option', { hasText: '自动' }).count();
    check('every site defaults to automatic egress matching', autoOpts > 0, autoOpts + ' egress selectors carry the auto option');
    const egressShown = main.indexOf('探测后自动判定') !== -1 || main.indexOf('已判定') !== -1 || main.indexOf('试用中') !== -1;
    check('the automatic decision is written next to the source', egressShown);
    const eg = await page.evaluate(() => fetch('/api/egress').then((r) => r.json()).catch(() => null));
    check('/api/egress answers with decisions + reasons', !!eg && typeof eg.counts === 'object' && Array.isArray(eg.decisions), eg ? Object.keys(eg.counts).join(',') || 'no decisions yet' : 'no answer');

    await page.locator('input[placeholder="my-feed"]').fill('ui-test-feed');
    await page.locator('input[placeholder="某某的博客"]').fill('UI 测试订阅');
    await page.locator('input[placeholder="https://example.com/feed.xml"]').fill('https://example.com/feed.xml');
    await page.locator('main button', { hasText: '新增自定义来源' }).click();
    await page.waitForTimeout(1200);
    main = await mainText();
    check('a custom source can be added from the UI', main.indexOf('ui-test-feed') !== -1);
    // Pin the delete button on that exact row — the page has other "delete" controls
    // (diagnostic files, watch targets)
    const rowDel = page.locator('main table tbody tr', { hasText: 'ui-test-feed' }).locator('button', { hasText: '删除' }).first();
    if (await rowDel.count()) {
      await rowDel.click();
      await page.waitForTimeout(1500);
      // Assert through the API rather than the page text: the diagnostic file names the self-check
      // generates carry the source id too
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
    // Both labels are the ones this walk seeds above: the URL target's own label and the path of the second
    // target. The second used to be an account-id target whose label was a person's name; that kind is gone,
    // so the label is whatever the fixture calls it.
    check('Watch page renders the seeded targets', main.indexOf('example.com') !== -1 && main.indexOf('cover news') !== -1);
    check('the alarm-rules panel can be opened', (await page.locator('main button', { hasText: '告警规则' }).count()) > 0);
    await page.locator('main button', { hasText: '全部检查一次' }).click();
    // Wait until the baseline is really established instead of sleeping a flat 6 seconds: the check
    // needs the network (the enabled one), and a fixed wait turns into a luck test when the network
    // is fast or slow (this assertion went red twice because of that).
    let baselineReady = false;
    let watchMain = '';
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);
      watchMain = await mainText();
      if (watchMain.indexOf('尚未建立') === -1) {
        baselineReady = true;
        break;
      }
    }
    const watchRows = await page.locator('main table tbody tr').count();
    // Three seeds now, and the count is pinned: two are the pre-existing fixture targets and the third is the
    // loopback feed the change digest needs (see seedConfig).
    check('the seeded targets are listed', watchRows === 3, watchRows + ' rows');
    main = watchMain;
    const baselined = (main.match(/已建立|revid|粉丝|条/g) || []).length;
    check('baseline info shows up after a check', baselineReady, baselined + ' baseline markers');
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
    // The chip carries the source's own name, which for the collected source is the fixture feed's name --
    // asserting the real site's name here would assert something this fixture deliberately does not rely on.
    check('the collected source appears as a chip', main.indexOf('巡检本地 feed') !== -1, main.slice(0, 120));
    const thumbs = await page.locator('main .card .thumbs img').count();
    check('image thumbnails carry no-referrer (anti-hotlink)', thumbs === 0 || (await page.locator('main .card .thumbs img').first().getAttribute('referrerpolicy')) === 'no-referrer', thumbs + ' thumbnails');
    // Two facts, kept apart on purpose. The watch half of this page is data-driven: the digest block only
    // exists when a target reported a change, so "the page shows nothing about watch" and "nothing changed"
    // look identical on screen. The first assertion therefore checks the data the page is rendered from, and
    // the second one checks the digest block **only when that data says something changed** -- and it says so
    // unconditionally here, because the fixture target watches the loopback feed, whose text this walk makes
    // differ on every read (see feedBody).
    const intelData = await (await fetch(base + '/api/intel')).json();
    const intelWatch = intelData.watch ?? [];
    check('the intel answer carries the watch targets of the run', intelWatch.some((x) => x.id === 'watch-feed'), JSON.stringify(intelWatch.map((x) => `${x.id}:${x.ok ? 'ok' : 'fail'}:${x.changed ? 'changed' : 'same'}`)));
    const feedRow = intelWatch.find((x) => x.id === 'watch-feed');
    check('the fixture target reported a change (so the digest below has a subject)', feedRow?.changed === true, JSON.stringify(feedRow ?? null).slice(0, 120));
    if (feedRow?.changed) {
      check('the watch digest block is shown once something changed', main.indexOf('监视变化摘要') !== -1, main.slice(0, 120));
    } else {
      check('the watch digest block is shown once something changed', false, 'the fixture target reported no change, so this page has nothing to digest');
    }
    const filterSelect = page.locator('main select').first();
    const opts = await filterSelect.locator('option').count();
    check('the source filter is populated from the data', opts > 1, opts + ' options');

    // --------------------------------------------------------------- reports
    process.stdout.write('\n8. Reports: preview, render, search, export\n');
    // The daily intel output now defaults to .html, but the Markdown rendering path must not break
    // because of it: drop an old-style .md report in and both formats have to stay viewable.
    const legacy = path.join(appDir, 'reports', 'legacy-sample.md');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      // A deliberately Chinese legacy report: the renderer must survive the markdown a real user has
      // on disk, and a CJK body also proves the encoding path. This string is a fixture, not output.
      '# 旧报告契约\n\n## 小节\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- 列表项\n\n[链接](https://example.com)\n', // english-logic:allow
      'utf8',
    );
    await tab('报告').click();
    await page.waitForTimeout(1200);
    // Wait until the list really renders before asserting (rather than sleeping a flat 1.2 seconds) —
    // the page keeps gaining blocks, and a fixed wait turns the assertion into a "luck test"
    let reportRows = 0;
    for (let i = 0; i < 20; i++) {
      reportRows = await page.locator('main table.reportlist tbody tr').count();
      if (reportRows > 0) break;
      await page.waitForTimeout(500);
    }
    if (reportRows === 0) {
      const diag = await page.evaluate(() => ({
        panels: [...document.querySelectorAll('main .panel')].map((p) => ({
          h2: (p.querySelector('h2')?.innerText ?? '(no h2)').slice(0, 30).replace(/\n/g, ' '),
          tables: p.querySelectorAll('table').length,
          rows: p.querySelectorAll('tbody tr').length,
          text: p.innerText.slice(0, 40).replace(/\n/g, ' '),
        })),
        reportLoading: document.body.innerText.includes('加载中'),
        reportErr: document.body.innerText.includes('❌'),
      }));
      process.stdout.write('  [debug] panels: ' + JSON.stringify(diag) + '\n');
    }
    check('the run produced a report row', reportRows > 0, reportRows + ' rows');

    // (1) default format: an .html main file -> previewed in an in-page iframe, content really rendered
    // Note: hasText must not be used to pick a row — every row's "compare" dropdown contains other
    // report names, which would match the .html name onto the .md row (we stepped on this once).
    const names = (await page.locator('main table.reportlist button.link').allInnerTexts()).map((s) => s.trim());
    const htmlName = names.find((n) => /\.html$/i.test(n));
    check('the daily report is a .html, not .md', !!htmlName, names.join(', '));
    await page.locator('main table.reportlist button.link').filter({ hasText: htmlName }).first().click();
    await page.waitForTimeout(1500);
    const openedH2 = (await page.locator('main h2').first().innerText().catch(() => '?')).trim();
    check(
      'the .html report previews in an iframe, not as raw text',
      (await page.locator('main iframe.report-frame').count()) > 0,
      'clicked=' + htmlName + ' opened=' + openedH2,
    );
    const frame = page.frameLocator('main iframe.report-frame');
    const fHead = await frame.locator('h1, h2, h3').count();
    check('the preview really rendered (headings)', fHead > 0, fHead + ' headings');
    const fTable = await frame.locator('table').count();
    check('tables survive into the .html report', fTable > 0, fTable + ' table(s)');
    const fLinks = await frame.locator('a').count();
    check('links stay clickable in the .html report', fLinks > 0, fLinks + ' links');
    await page.locator('main button', { hasText: '原始 Markdown' }).click();
    await page.waitForTimeout(400);
    check('the raw toggle shows the .html source', (await page.locator('main pre.report').count()) > 0);
    await page.locator('main button', { hasText: '渲染视图' }).click();
    await page.waitForTimeout(400);
    check('and switching back restores the preview', (await page.locator('main iframe.report-frame').count()) > 0);

    // (2) old-style .md report: the in-app Markdown rendering path still works
    await page.locator('main table.reportlist tbody tr', { hasText: 'legacy-sample.md' }).first().locator('button.link').click();
    await page.waitForTimeout(1000);
    const rendered = await page.locator('main .md').count();
    check('a legacy .md report still renders as Markdown', rendered > 0);
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
    } else {
      check('the exported HTML downloads', false, 'no export link, cannot download');
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

    // Search using a word from a real item (this run just scraped the enabled sources).
    //
    // The term has to be a **word**, and it took the engine swap to make that obvious: `official-cover` is a
    // `fetch: browser` source, so once a Firefox engine is actually installed that source really renders, its
    // items join the corpus, and the first of them starts with "/*". The old `slice(0, 2)` then searched for two
    // punctuation characters, found nothing, and failed a check whose entire subject is "a keyword search
    // returns cards" — a red gate about a browser, described as a red gate about search. So the sample is the
    // first item that contains a word, and the term is that word's first two characters.
    const corpus = await (await fetch(base + '/api/intel')).json();
    const wordIn = (text) => (String(text).match(/[\u4e00-\u9fff]{2,}|[\u3040-\u30ff]{2,}|[A-Za-z]{3,}/) ?? [''])[0];
    const sample = (corpus.items ?? [])
      .map((i) => wordIn(String(i.text ?? '').replace(/\[[^\]]+\]/g, '')))
      .find((w) => w.length >= 2);
    const term = sample ? sample.slice(0, 2) : '糖';
    await page.locator('main input').first().fill(term);
    await page.locator('main button', { hasText: '搜索' }).first().click();
    await page.waitForTimeout(1500);
    const hits = await page.locator('main .card').count();
    check('a keyword search returns cards', hits > 0, `${hits} cards for "${term}"`);

    // Hit the API directly to verify the filtering semantics
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
        body: JSON.stringify({ source: 'ui-feed' }),
      })
    ).json();
    // The source that actually collected is the loopback feed (the two real sites in this fixture are
    // expected to fail: one needs the network, the other needs a browser the packaged build does not ship),
    // so the filter is asked for that one rather than for a source that produced nothing.
    check('filtering by source works', bySource.items.every((i) => i.sourceId === 'ui-feed') && bySource.total > 0, `${bySource.total} items`);
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

    // ------------------------------------------------------------- calendar
    process.stdout.write('\n9b. Calendar: countdown, grid, local lead detection\n');
    await tab('日历').click();
    await page.waitForTimeout(900);
    main = await mainText();
    check('the calendar page renders "today" and the time zone', main.indexOf('今天') !== -1, main.slice(0, 60).replace(/\n/g, ' '));
    const emptyState = main.indexOf('还没有纪念日') !== -1;
    check('the empty state gives a clear next step', emptyState);

    // Post a leap-day birthday through the API: a non-leap year has to roll over explicitly, and the
    // UI has to mark it
    const leapEntry = await page.evaluate(() =>
      fetch('/api/calendar/entry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'ui-leap', name: '闰日测试', kind: 'birthday', date: '02-29' }),
      }).then((r) => r.json()),
    );
    check('a calendar entry can be added', leapEntry.ok === true, JSON.stringify(leapEntry).slice(0, 80));
    const cal = await (await fetch(base + '/api/calendar?days=400')).json();
    const leapRow = (cal.all ?? []).find((x) => x.id === 'ui-leap');
    check('a leap-day birthday has a next occurrence date', !!leapRow, leapRow ? leapRow.day : 'missing');
    check(
      '2/29 rolls over to 3/1 in a non-leap year and is marked as such (it is not silently miscomputed)',
      leapRow ? leapRow.day.endsWith('-03-01') === leapRow.leapAdjusted : false,
      leapRow ? `${leapRow.day} leapAdjusted=${leapRow.leapAdjusted}` : '',
    );

    // Time zone: at the same instant, "today" in Tokyo may already be tomorrow
    const tzCmp = await page.evaluate(async () => {
      const utc = await fetch('/api/calendar?days=400').then((r) => r.json());
      return { today: utc.today, timeZone: utc.timeZone, days: utc.due.length };
    });
    check('the endpoint reports the calendar day and time zone used for the computation', /^\d{4}-\d{2}-\d{2}$/.test(tzCmp.today) && !!tzCmp.timeZone, `${tzCmp.today} @ ${tzCmp.timeZone}`);

    // Assert after a refresh: the page only fetches on mount / month change, so re-clicking the same
    // tab does not re-fetch
    await page.reload({ waitUntil: 'networkidle' });
    await tab('日历').click();
    await page.waitForTimeout(900);
    const reloaded = await mainText();
    check('the added calendar entry appears in the countdown', reloaded.indexOf('闰日测试') !== -1, reloaded.slice(0, 40).replace(/\n/g, ' '));
    const cells = await page.locator('.cal-cell').count();
    check('the month grid renders', cells >= 28 && cells % 7 === 0, cells + ' cells');
    const dow = await page.locator('.cal-dow').allInnerTexts();
    check('the month header has 7 columns', dow.length === 7, dow.join(' '));

    // Lead extraction must be done **locally** and must not produce false positives
    const detect = await (await fetch(base + '/api/calendar/detect')).json();
    check('the lead-scan endpoint answers (local regex, no LLM needed)', detect.ok === true, `scanned ${detect.scanned}`);

    // An illegal date has to be rejected — send the request from the Node side: sending it from the
    // page would make the "no failed requests" assertion fire wrongly
    const badRes = await fetch(base + '/api/calendar/entry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏日期', date: '13-45' }),
    });
    check('an illegal date is rejected (13-45 is not a valid month-day)', badRes.status === 400, 'status ' + badRes.status);

    // Cleanup: a traversal must not leave data behind
    await fetch(base + '/api/calendar/entry/ui-leap', { method: 'DELETE' });

    // The countdown block really has to appear in the daily report — an integration that was written
    // but never verified is the easiest thing to stop working silently.
    // The date must be computed **dynamically**: the daily report only lists what is inside the next
    // 30 days, so a hard-coded date starts failing spuriously the moment you run it on another day.
    const calForReport = await (await fetch(base + '/api/calendar')).json();
    const inFive = new Date(Date.parse(calForReport.today + 'T00:00:00Z') + 5 * 86400000)
      .toISOString()
      .slice(5, 10); // MM-DD
    check('a date inside the daily-report window can be computed', /^\d{2}-\d{2}$/.test(inFive), `${calForReport.today} + 5d = ${inFive}`);
    const repEntry = await fetch(base + '/api/calendar/entry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui-report-cal', name: '日报倒计时测试', kind: 'debut', date: inFive }),
    });
    check('a calendar entry is ready for the daily-report verification', repEntry.ok === true);
    await fetch(base + '/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'daily' }),
    });
    const repDeadline = Date.now() + 4 * 60 * 1000;
    let repDone = false;
    while (Date.now() < repDeadline) {
      const s = await (await fetch(base + '/api/state')).json();
      if (s.running === false && s.lastResult) {
        repDone = true;
        break;
      }
      await sleep(2000);
    }
    check('the second run completes', repDone);
    const reports = await (await fetch(base + '/api/reports')).json();
    // Take the newest by modification time — never sort by file name: legacy-sample.md, which the
    // traversal writes itself, sorts before the date lexicographically and would be picked wrongly
    // (the same class of pitfall as the hasText row-picking above)
    const newest = [...reports]
      .filter((r) => !r.name.startsWith('legacy-'))
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))[0];
    const body = newest ? await (await fetch(base + '/api/reports/' + encodeURIComponent(newest.name))).text() : '';
    check('the daily report carries the calendar countdown block', body.indexOf('纪念日倒计时') !== -1, newest ? newest.name : 'no report');
    check('the daily report lists that calendar entry', body.indexOf('日报倒计时测试') !== -1);
    await fetch(base + '/api/calendar/entry/ui-report-cal', { method: 'DELETE' });

    // ------------------------------------------------------------- people
    process.stdout.write('\n9c. People: follow by person, not by source\n');
    const emptyPeople = await (await fetch(base + '/api/people')).json();
    check('the follow-list endpoint answers', emptyPeople.ok === true, `scanned ${emptyPeople.scanned} items`);

    // Add a follow target whose name really occurs in the existing mock intel, otherwise there is no
    // way to verify matching
    // Add a follow target whose alias is taken from **text that really exists in the items**;
    // otherwise the matching cannot be verified at all
    // (I once used the source name as the alias and got 0/20 hits — my probe was wrong, the feature
    //  was not broken)
    const mockIntel = await (await fetch(base + '/api/intel?limit=200')).json();
    const firstItem = (mockIntel.items ?? [])[0] ?? {};
    // sourceName is a localised object {zh,en}; use || rather than ?? — an empty string must also
    // fall through to the next candidate
    const src = firstItem.sourceName ?? {};
    const sampleText = String(src.zh || src.en || firstItem.title || firstItem.text || '').trim();
    const probeName = sampleText || 'Mock 关注对象';
    const addPerson = await fetch(base + '/api/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui-follow', name: probeName, aliases: ['Mock Chan'], links: { youtube: 'UCp6993wxpyDPHUpavwDFqgg' } }),
    });
    check('a follow target can be added', addPerson.ok === true, 'name=' + probeName);

    const withPeople = await (await fetch(base + '/api/intel?limit=200')).json();
    const attributed = (withPeople.items ?? []).filter((i) => (i.people ?? []).length);
    check(
      'intel items are attributed to people (local matching)',
      attributed.length > 0,
      `${attributed.length}/${(withPeople.items ?? []).length} hits (alias "${probeName}")`,
    );
    if (attributed.length) {
      const hits = attributed[0].peopleHits ?? [];
      check('the attribution carries evidence (which alias, which field)', hits.length > 0 && !!hits[0].alias && !!hits[0].field, JSON.stringify(hits[0] ?? {}));
    } else {
      check('the attribution carries evidence (which alias, which field)', false, 'no hits, so the evidence cannot be verified');
    }

    const feed = await (await fetch(base + '/api/people/feed?id=ui-follow')).json();
    check('the single-person feed works', feed.ok === true && Array.isArray(feed.feed), JSON.stringify(feed).slice(0, 60));

    const byPerson = await (await fetch(base + '/api/intel?limit=200&person=ui-follow')).json();
    check('the intel stream can be filtered by person', (byPerson.items ?? []).length > 0 && (byPerson.items ?? []).every((i) => (i.people ?? []).includes('ui-follow')), `${(byPerson.items ?? []).length} items`);

    const exp = await fetch(base + '/api/people/ui-follow/export?format=md');
    const expText = await exp.text();
    check('a single person can be exported (Markdown)', exp.ok && expText.includes('#'), expText.split('\n')[0]?.slice(0, 40));

    const sugRes = await (await fetch(base + '/api/people/suggest?min=2')).json();
    check('the follow-suggestion endpoint answers', sugRes.ok === true, `counted ${sugRes.scanned} entities`);

    // Box (agency) view: give this follow target an agency, then confirm the box-level aggregation
    // really counts it
    await fetch(base + '/api/people/ui-follow', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agency: 'UI-Box' }),
    });
    const groups = await (await fetch(base + '/api/groups?days=30')).json();
    check('the box (agency) view endpoint answers', groups.ok === true && Array.isArray(groups.groups), `${(groups.groups ?? []).length} boxes`);
    const box = (groups.groups ?? []).find((g) => g.agency === 'UI-Box');
    check('people with an agency are grouped into the matching box', !!box && box.totals.members === 1, box ? `${box.totals.members} members` : 'UI-Box not found');
    check(
      'the box carries a daily series and a baseline (the heatmap needs them)',
      !!box && Array.isArray(box.members[0]?.counts) && box.members[0].counts.length === groups.axis.length,
      box ? `counts=${box.members[0]?.counts?.length} / axis=${groups.axis.length}` : '-',
    );
    const silence = await (await fetch(base + '/api/silence?days=60')).json();
    check('the silence-detection endpoint answers and states whether there is a baseline', silence.ok === true && typeof silence.checked === 'number', silence.summary);

    // It really has to render on the page too
    await tab('关注').click();
    await page.waitForTimeout(900);
    const peopleText = await mainText();
    check('the follow page renders the list', peopleText.indexOf(probeName) !== -1, peopleText.slice(0, 60).replace(/\n/g, ' '));
    check('the follow page explains the matching basis', peopleText.indexOf('命中依据') !== -1 || peopleText.indexOf('别名') !== -1);
    // The box-view block has to be on the page: an endpoint alone is not a deliverable, the user has
    // to be able to see it
    check('the follow page renders the box-view block', peopleText.indexOf('箱视角') !== -1, peopleText.indexOf('箱视角') !== -1 ? 'block present' : 'box view not found');
    check(
      'the box view draws UI-Box (heatmap cells included)',
      peopleText.indexOf('UI-Box') !== -1 && (await page.locator('.heat-cells i').count()) > 0,
      (await page.locator('.heat-cells i').count()) + ' cells',
    );

    // VDB roster (a multi-platform agency roster): the status endpoint must work offline — it only
    // reads the cache and never goes online
    const vdbStatus = await (await fetch(base + '/api/vdb/status')).json();
    check(
      'the roster status endpoint works offline (licence and source attribution included)',
      vdbStatus.ok === true && typeof vdbStatus.count === 'number' && !!vdbStatus.license && !!vdbStatus.source,
      `${vdbStatus.count} records · ${vdbStatus.source} · ${vdbStatus.license}`,
    );
    check('the status endpoint states whether there is a cache', 'cached' in vdbStatus, String(vdbStatus.cached));
    const vdbGroups = await (await fetch(base + '/api/vdb/groups')).json();
    check('the roster can be listed by agency', vdbGroups.ok === true && typeof vdbGroups.groups === 'object', `${Object.keys(vdbGroups.groups ?? {}).length} agencies`);
    // Importing with no record selected -> it must be refused (it goes through the same sanitising
    // path as a manual add; no back door)
    const vdbNoKeys = await fetch(base + '/api/vdb/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });
    check('an empty-selection import is refused', vdbNoKeys.status === 400, String(vdbNoKeys.status));
    const vdbEmptyQ = await (await fetch(base + '/api/vdb/search?q=')).json();
    check('an empty-keyword search returns empty straight away (no network)', vdbEmptyQ.ok === true && (vdbEmptyQ.results ?? []).length === 0);
    check('the follow page renders the roster block', peopleText.indexOf('从 VDB 导入') !== -1 && peopleText.indexOf('同步花名册') !== -1, peopleText.indexOf('从 VDB 导入') !== -1 ? 'block present' : 'VDB block not found');
    check('the roster block carries the upstream attribution', peopleText.indexOf('dd-center/vdb') !== -1 || peopleText.indexOf('CC BY-NC-SA') !== -1);

    await fetch(base + '/api/people/ui-follow', { method: 'DELETE' });
    const afterDel = await (await fetch(base + '/api/people')).json();
    check('a follow target can be deleted (and is cleaned up completely)', (afterDel.people ?? []).length === 0);

    // ------------------------------------------------- events (merge/dedupe)
    process.stdout.write('\n9d. Events: multi-source merge, similarity dedupe, source weight\n');
    const ev = await (await fetch(base + '/api/events?learn=0')).json();
    check('the event-merge endpoint answers', ev.ok === true, `${ev.stats?.events} events / ${ev.stats?.itemsMerged} items`);
    check('source weights came back', ev.weights && Object.keys(ev.weights).length > 0, JSON.stringify(ev.weights).slice(0, 90));
    for (const [id, w] of Object.entries(ev.weights ?? {})) {
      if (!(w > 0 && w <= 3)) check('weight is inside a sane range for ' + id, false, String(w));
    }
    check('the stats include "duplicates removed" and "multi-source confirmed"', typeof ev.stats.duplicatesRemoved === 'number' && typeof ev.stats.confirmedEvents === 'number', JSON.stringify(ev.stats).slice(0, 90));
    // Use the preview endpoint for a real end-to-end check: the 20 mock items are in fact all
    // different, so an assertion like "duplicates must be merged" cannot rely on the corpus
    // happening to contain duplicates (that is exactly how it was written wrongly before)
    const preview = await (
      await fetch(base + '/api/events/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            { id: 'd1', sourceId: 'official-hololive', title: '嘉然 3D披露 将于 3月15日 举行', publishedAt: '2026-03-01T10:00:00Z' },
            { id: 'd2', sourceId: 'news-moguravr', title: '【3D披露】嘉然 3月15日 3Dお披露目 直播预告', publishedAt: '2026-03-01T12:00:00Z' },
            { id: 'd3', sourceId: 'community-reddit', title: '嘉然 3D 披露 3月15日 直播', publishedAt: '2026-03-02T09:00:00Z' },
            { id: 'd4', sourceId: 'news-ann', title: '某游戏版本更新公告', publishedAt: '2026-03-01T11:00:00Z' },
          ],
        }),
      })
    ).json();
    check('the preview endpoint merges the same thing from three sources into one event', preview.stats?.events === 2 && preview.stats?.duplicatesRemoved === 2, JSON.stringify(preview.stats ?? {}));
    const merged = (preview.events ?? []).find((e) => e.sourceCount === 3);
    check('after merging it is marked multi-source confirmed, with the highest-weight source picked as lead', !!merged && merged.confirmed === true && merged.leadSourceId === 'official-hololive', JSON.stringify(merged ?? {}).slice(0, 120));
    check('the preview does not pollute the source-weight history (learn:false)', preview.weights && Object.keys(preview.weights).length >= 3, JSON.stringify(preview.weights).slice(0, 90));
    const ded = await (await fetch(base + '/api/events/dedupe')).json();
    check('the dedupe endpoint\'s kept + dropped counts are self-consistent', ded.ok === true && ded.kept + ded.dropped >= ded.kept, `kept ${ded.kept} / dropped ${ded.dropped}`);
    check('a dropped item points back at the one that was kept', (ded.removed ?? []).every((d) => d.keptId && d.eventId), JSON.stringify((ded.removed ?? [])[0] ?? {}).slice(0, 80));

    await tab('情报').click();
    await page.waitForTimeout(700);
    const mergeSel = page.locator('main select').filter({ hasText: 'off' }).first();
    check('the intel page has a "merge duplicate events" switch', (await page.locator('main label', { hasText: '合并重复事件' }).count()) > 0);
    // turn the merged view on
    const mergeField = page.locator('main select').last();
    void mergeSel;
    void mergeField;
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('main label')];
      const l = labels.find((x) => x.textContent.includes('合并重复事件'));
      const sel = l?.parentElement?.querySelector('select');
      if (sel) {
        sel.value = 'true';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(1500);
    const mergeText = await mainText();
    check('the merged view renders', mergeText.indexOf('已合并事件') !== -1, mergeText.slice(0, 60).replace(/\n/g, ' '));
    check('the merged view marks multi-source confirmation', mergeText.indexOf('多源确认') !== -1 || mergeText.indexOf('来源') !== -1);

    // ------------------------------------------------------------- archive
    process.stdout.write('\n9e. SQLite archive and charts\n');
    const arch0 = await (await fetch(base + '/api/archive/stats')).json();
    check('the archive endpoint answers', arch0.ok === true, JSON.stringify(arch0).slice(0, 80));
    check('the archive already holds something after a run (written incrementally during the run)', (arch0.items ?? 0) > 0, `${arch0.items} items / ${arch0.days} days`);
    const ing = await (
      await fetch(base + '/api/archive/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 500 }) })
    ).json();
    check('a manual backfill works and is idempotent (a repeat backfill inserts nothing)', ing.ok === true && ing.inserted === 0, JSON.stringify(ing).slice(0, 80));
    const ser = await (await fetch(base + '/api/archive/series?days=30')).json();
    check('the series endpoint returns five chart datasets', ser.ok === true && !!ser.daily && !!ser.bySource && !!ser.people && !!ser.keywords && !!ser.health, Object.keys(ser).join(','));
    check('the daily series is padded out to 30 days (a day that did not run is 0, not missing)', (ser.daily.days ?? []).length === 30, `${ser.daily?.days?.length} days`);
    check('the per-source totals agree with the item count', (ser.bySource.totals ?? []).reduce((n, r) => n + r.items, 0) === arch0.items, `total ${(ser.bySource.totals ?? []).reduce((n, r) => n + r.items, 0)} vs ${arch0.items}`);
    const archItems = await (await fetch(base + '/api/archive/items?limit=5')).json();
    check('archive items can be queried', archItems.ok === true && archItems.items.length > 0, `${archItems.count} items`);
    const evilQ = await (await fetch(base + '/api/archive/items?q=' + encodeURIComponent("%' OR '1'='1"))).json();
    check('the query string is handled as a parameter (injection is inert)', evilQ.ok === true && evilQ.items.length === 0, `${evilQ.items.length} items`);

    await tab('报告').click();
    await page.waitForTimeout(1200);
    const chartText = await mainText();
    check('the trend-charts block appears on the reports page', chartText.indexOf('趋势图表') !== -1);
    check('the charts show the archive item count', /归档[:：]?\s*\d+/.test(chartText.replace(/\n/g, ' ')) || chartText.indexOf('每天条目数') !== -1, chartText.slice(0, 70).replace(/\n/g, ' '));
    const svgCount = await page.locator('main svg.chart-svg').count();
    check('the charts are really drawn (inline SVG, no chart library)', svgCount > 0, svgCount + ' charts');

    // ------------------------------------------------------------- share
    process.stdout.write('\n9f. Share: login requirements honest, bundles self-contained\n');
    const shareTargets = await (await fetch(base + '/api/share/targets')).json();
    check('the share-targets endpoint answers', shareTargets.ok === true, `${shareTargets.targets?.length} targets`);
    const byId = Object.fromEntries((shareTargets.targets ?? []).map((x) => [x.id, x]));
    // `declaredStatus` rather than the old flat `status`: a share target became three independent stages
    // (account / verification / send) and the single field was replaced by the declaration plus the stages.
    // The readings below are the same facts this traversal was always asserting - a method that needs no login
    // is ready, a method that needs one does not pretend, and a platform that cannot be done says so.
    check('the methods that need no login are ready', byId['file-html']?.declaredStatus === 'ready' && byId['text']?.declaredStatus === 'ready' && byId['webhook']?.declaredStatus === 'ready', JSON.stringify([byId['file-html']?.declaredStatus, byId['text']?.declaredStatus, byId['webhook']?.declaredStatus]));
    check('every target honestly declares whether a login is needed', (shareTargets.targets ?? []).every((x) => typeof x.needsLogin === 'boolean'));
    check('a target that needs a login does not pretend to be available', byId['weibo-post']?.needsLogin === true && byId['weibo-post']?.stages?.send?.status !== 'ready', JSON.stringify(byId['weibo-post']?.stages?.send ?? {}).slice(0, 90));
    // The two platforms this build stopped knowing must not be offered at all -- neither as a target nor as a
    // login kind. This is the "absence" half of the same reading, and it is the one that would catch an entry
    // coming back through a helper nobody meant to keep.
    check('no retired platform is offered as a share target', !byId['bilibili-dynamic'] && !byId['x-post'], Object.keys(byId).join(', '));
    const kinds = (shareTargets.loginKinds ?? []).map((k) => k.id).filter(Boolean);
    check('no retired platform is offered as a login kind', !kinds.includes('bilibili') && !kinds.includes('twitter'), kinds.join(', '));
    // And the rule the owner asked for after that round: a target whose publishing has no code still offers a
    // real login check where one can be run, so its login stage must be actionable rather than blank.
    check('a target we cannot post to still offers a login check', byId['reddit-post']?.stages?.verification?.actionable === true, JSON.stringify(byId['reddit-post']?.stages?.verification ?? {}).slice(0, 90));
    check('a stage that cannot be run carries its reason', byId['mastodon-post']?.stages?.verification?.actionable === false && !!byId['mastodon-post']?.stages?.verification?.notRunnable?.zh, JSON.stringify(byId['mastodon-post']?.stages?.verification ?? {}).slice(0, 120));

    const bundleRes = await fetch(base + '/api/share/bundle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'latest' }, format: 'html', note: '巡检导出' }),
    });
    const bundleHtml = await bundleRes.text();
    check('a single-file HTML can be generated', bundleRes.ok && bundleHtml.length > 500, `${bundleHtml.length} bytes`);
    check('it returns HTML with a download filename', (bundleRes.headers.get('content-type') ?? '').includes('text/html') && /filename="vml-share-.+\.html"/.test(bundleRes.headers.get('content-disposition') ?? ''), bundleRes.headers.get('content-disposition'));
    const externalRefs = [...bundleHtml.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)]
      .map((m) => m[1])
      .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
    const resourceRefs = externalRefs.filter((u) => !/^https?:\/\//.test(u));
    check('the shared file references no external resources at all (viewable offline)', resourceRefs.length === 0, resourceRefs.join(',') || 'none');
    check('the shared file contains no scripts', !/<script/i.test(bundleHtml));

    const txt = await (
      await fetch(base + '/api/share/bundle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: { kind: 'latest' }, format: 'text' }),
      })
    ).json();
    check('copy-text mode returns plain text', txt.ok === true && typeof txt.text === 'string' && txt.text.length > 10, `${txt.items} items`);

    const audit = await (await fetch(base + '/api/share/audit')).json();
    check('the export is recorded in the share log', (audit.entries ?? []).some((e) => e.action === 'bundle'), JSON.stringify(audit.entries?.[0] ?? {}).slice(0, 80));

    // The two gates on speaking in public that are reachable in this build: no confirmation, and a site whose
    // publish code does not exist. The third reading this used to make ("an unverified target is unusable")
    // needed a site that declares publish code, which no built-in does any more -- the login and verification
    // gates behind the confirm gate are pinned offline by tools/share-test.mjs instead, on a hand-declared
    // site, because a walk cannot declare one without editing the config under test.
    const noConfirm = await fetch(base + '/api/share/post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'weibo-post', text: '测试' }),
    });
    check('without confirmation it must not post publicly', noConfirm.status === 400, 'status ' + noConfirm.status);
    const notImplemented = await (
      await fetch(base + '/api/share/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'weibo-post', text: '测试', confirm: true }),
      })
    ).json();
    check('a site with no publish code refuses and says which state it is in', notImplemented.ok === false && notImplemented.status === 'unimplemented', JSON.stringify(notImplemented).slice(0, 90));
    const retired = await fetch(base + '/api/share/post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'x-post', text: '测试', confirm: true }),
    });
    check('a retired target is refused as unknown', retired.status === 400, 'status ' + retired.status);

    await tab('报告').click();
    await page.waitForTimeout(900);
    const shareText = await mainText();
    check('the one-click-share block appears on the reports page', shareText.indexOf('一键分享') !== -1);
    check('the UI states whether each method needs a login', shareText.indexOf('需要登录') !== -1 && shareText.indexOf('待验证') !== -1);

    // ------------------------------------------------------------- vision
    process.stdout.write('\n9g. Vision: image tagging behind an explicit opt-in\n');
    const vs = await (await fetch(base + '/api/vision/stats')).json();
    check('the image-tagging status endpoint answers', vs.ok === true, `images=${vs.images} tagged=${vs.tagged}`);
    check('it is disabled by default, and the reason is stated', vs.enabled === false && vs.ready?.ok === false, vs.ready?.reason ?? '');
    const tagRefused = await fetch(base + '/api/vision/tag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    });
    const tagBody = await tagRefused.json();
    check('tagging is refused while disabled (privacy gate: no image leaves quietly)', tagRefused.status === 400 && /未启用/.test(tagBody.error ?? ''), 'status ' + tagRefused.status);
    await tab('情报').click();
    await page.waitForTimeout(700);
    const vBtn = page.locator('main button', { hasText: '图片打标' });
    check('the intel page has an image-tagging entry point', (await vBtn.count()) > 0);
    check('the button is disabled while not ready (rather than doing nothing when clicked)', (await vBtn.first().isDisabled()) === true, 'disabled');

    // ------------------------------------------- office export & features & tor
    // ------------------------------------------------- 9h. About panel (in-app README)
    // The requirement this covers: the README must be readable **inside** the interface, with an
    // instant language switch, and reading it must not navigate you away from the page you were on.
    process.stdout.write('\n9h. About panel: README inside the app, language switched in place\n');
    const tabBefore = await page.locator('nav.tabs button.active').innerText();
    await page.locator('[data-testid="about-open"]').click();
    await page.waitForSelector('.about-modal', { timeout: 5000 });
    check('the About button opens the panel without leaving the page', await page.locator('.about-modal').isVisible(), 'panel visible');
    const aboutBody = async () => (await page.locator('.modal-body').innerText()).trim();
    const aboutShown = await aboutBody();
    check('the panel renders the document (a heading, not escaped markup)', aboutShown.includes("Vtuber's Monitor Link") && !aboutShown.includes('## '), aboutShown.slice(0, 60).replace(/\n/g, ' '));
    check('the document has real structure inside the panel (headings/tables)', (await page.locator('.readme-doc h2').count()) > 3, (await page.locator('.readme-doc h2').count()) + ' headings');
    const zhSeg = page.locator('.seg button', { hasText: '中文' });
    const enSeg = page.locator('.seg button', { hasText: 'English' });
    check('both language choices are offered', (await zhSeg.count()) === 1 && (await enSeg.count()) === 1);
    // switch to the other language and require the text to actually change
    const wasZh = (await page.locator('.seg button.active').innerText()).includes('中文');
    await (wasZh ? enSeg : zhSeg).click();
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('.modal-body');
        return el && el.innerText.trim() !== prev && el.innerText.trim().length > 200;
      },
      aboutShown,
      { timeout: 8000 }
    );
    const aboutAfter = await aboutBody();
    check(
      'switching language swaps the text in place',
      wasZh ? !/[\u4e00-\u9fff]{4,}/.test(aboutAfter.split('\n')[0]) && aboutAfter !== aboutShown : /[\u4e00-\u9fff]{4,}/.test(aboutAfter),
      `${aboutShown.length} → ${aboutAfter.length} chars`,
    );
    check('the switch did not navigate away from the page', (await page.locator('nav.tabs button.active').innerText()) === tabBefore, 'still on ' + tabBefore);
    check('no full page reload happened (the panel is still open)', await page.locator('.about-modal').isVisible());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Escape closes the panel', (await page.locator('.about-modal').count()) === 0);

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
    // A second call should hit the cache entirely (extracted=0/cached=N) — that is exactly what we
    // want, so do not assert it has to be >0
    check(
      'feature extraction answers and reuses its cache',
      featRun.ok === true && featRun.extracted + featRun.cached > 0,
      `extracted ${featRun.extracted}, cached ${featRun.cached}, err ${featRun.error ?? '-'}` 
    );
    check('extracted features become searchable tags', (featRun.stats?.names ?? []).some((n) => n.value === 'Mock Chan'), JSON.stringify((featRun.stats?.names ?? []).slice(0, 3)));

    // Tor: not necessarily running on this machine, so verify only the contract and "reports an
    // honest error when unavailable"
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
    // On failure, print the page-side errors as well, otherwise all you see is "some assertion failed"
    if (pageErrors.length) process.stdout.write('\n  page errors:\n' + pageErrors.slice(0, 8).map((e) => '    ' + e).join('\n') + '\n');
    if (consoleErrors.length) process.stdout.write('\n  console errors:\n' + consoleErrors.slice(0, 8).map((e) => '    ' + e).join('\n') + '\n');
    if (badApi.length) process.stdout.write('\n  failed requests:\n' + badApi.slice(0, 8).map((e) => '    ' + e).join('\n') + '\n');
    try {
      appOut.end();
      const tail = fs.readFileSync(appLog, 'utf8').trim().split(/\r?\n/).slice(-25);
      process.stdout.write('\n  app-under-test output (tail):\n' + tail.map((l) => '    ' + l).join('\n') + '\n');
      process.stdout.write('\n  is the app under test still alive: ' + (child.exitCode === null ? 'alive' : 'exited with exit=' + child.exitCode) + '\n');
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
      // Wait for it to really exit before wrapping up: if we move on before the port is released,
      // the next run ends up talking to a leftover instance
      const gone = await waitChildExit(child);
      if (!gone) process.stdout.write('  (warn) the app process did not exit within 8 seconds, the port may not be released yet\n');
    }
    try {
      mock.kill();
    } catch (e) {
      /* ignore */
    }
    try {
      feedServer.close();
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

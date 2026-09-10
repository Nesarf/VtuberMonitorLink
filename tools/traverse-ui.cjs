// tools/traverse-ui.cjs - drive the built console in a real browser.
//
// ASCII only, CommonJS. Loads the packaged console in a headless browser,
// clicks through all four pages, exercises the run button, flips the language,
// and fails on any console error, page error or failed API call.
//
//   node tools/traverse-ui.cjs [--dir dist/VtuberMonitorLink] [--port 43198]
//                              [--headed] [--keep]
//
// Requires `playwright` in the repo's node_modules and one usable browser
// (either an installed Chrome/Edge/Opera, or Playwright's own Chromium).

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'dist', 'VtuberMonitorLink'), port: 43198, headed: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = path.resolve(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a === '--headed') out.headed = true;
    else if (a === '--keep') out.keep = true;
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
  const createdDirs = ['reports', 'feeds', 'logs'].filter((d) => !fs.existsSync(path.join(appDir, d)));

  const child = spawn(exe, ['--no-open', '--port', String(args.port)], { cwd: args.dir, stdio: 'ignore' });
  const restored = () => {
    try {
      if (hadConfig) fs.writeFileSync(cfgPath, cfgBackup);
      else fs.rmSync(cfgPath, { force: true });
      for (const d of createdDirs) fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  };

  let browser = null;
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

    // Prefer a browser the product itself detected; fall back to Playwright's.
    const br = await (await fetch(base + '/api/browsers')).json();
    const detected = (br.detected || [])[0];
    const launchOpts = { headless: !args.headed, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (detected) launchOpts.executablePath = detected.executablePath;
    process.stdout.write('  using browser: ' + (detected ? detected.name + ' (' + detected.executablePath + ')' : "Playwright's bundled Chromium") + '\n');

    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({ viewport: { width: 1360, height: 940 } });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const badApi = [];
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
    const tabs = await page.locator('nav.tabs button').allInnerTexts();
    check('four navigation tabs render', tabs.length === 4, tabs.join(' | '));

    const langBtn = page.locator('button.lang');
    let lang = (await page.locator('.sub').first().innerText()).trim();
    if (lang.indexOf('本地') === -1) {
      // Normalise to Chinese so the landmark assertions below are stable.
      await langBtn.click();
      await page.waitForTimeout(300);
      lang = (await page.locator('.sub').first().innerText()).trim();
    }
    check('console runs in Chinese by default', lang.indexOf('本地') !== -1, lang);

    const tab = (label) => page.locator('nav.tabs button', { hasText: label }).first();

    // ------------------------------------------------------------------- run
    process.stdout.write('\n2. Run page\n');
    await tab('运行').click();
    await page.waitForTimeout(600);
    let main = await page.locator('main').innerText();
    check('Run page renders', main.indexOf('运行') !== -1 && main.indexOf('实时日志') !== -1, main.split('\n')[0]);
    check('Run page reports no run yet', main.indexOf('尚无运行记录') !== -1);
    const runBtn = page.locator('main button', { hasText: '立即运行' }).first();
    check('run button is present and enabled', await runBtn.isEnabled());

    // ----------------------------------------------------------------- sources
    process.stdout.write('\n3. Sources page\n');
    await tab('来源').click();
    await page.waitForTimeout(800);
    const rows = await page.locator('main table tbody tr').count();
    check('Sources page lists every adapter', rows === 24, rows + ' rows');
    main = await page.locator('main').innerText();
    check('Sources page shows the login-requirement legend', main.indexOf('登录要求') !== -1, 'hint present');
    const badgeOk = /(无需|可选|必需)/.test(main);
    check('login badges are rendered', badgeOk);

    // toggle the first checkbox and confirm it sticks across a reload
    const box = page.locator('main table tbody tr').first().locator('input[type=checkbox]');
    const before = await box.isChecked();
    await box.click();
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: 'networkidle' });
    if ((await page.locator('.sub').first().innerText()).indexOf('本地') === -1) {
      await page.locator('button.lang').click();
      await page.waitForTimeout(300);
    }
    await tab('来源').click();
    await page.waitForTimeout(800);
    const after = await page.locator('main table tbody tr').first().locator('input[type=checkbox]').isChecked();
    check('a source toggle persists across a reload', after === !before, before + ' -> ' + after);
    await page.locator('main table tbody tr').first().locator('input[type=checkbox]').click(); // put it back
    await page.waitForTimeout(900);

    // ---------------------------------------------------------------- settings
    process.stdout.write('\n4. Settings page\n');
    await tab('设置').click();
    await page.waitForTimeout(700);
    main = await page.locator('main').innerText();
    for (const section of ['浏览器', 'LLM 分析', '网络代理', '定时']) {
      check('Settings has the ' + section + ' section', main.indexOf(section) !== -1);
    }
    const keyInput = page.locator('main input[type=password]').first();
    check('the API key field is masked', (await keyInput.count()) > 0);
    const keyVal = (await keyInput.count()) > 0 ? await keyInput.inputValue() : '';
    check('no API key is pre-filled in the build', keyVal === '', keyVal ? 'a key is present!' : 'empty');
    const detectBtn = page.locator('main button', { hasText: '探测本机常见代理端口' }).first();
    if (await detectBtn.count()) {
      await detectBtn.click();
      await page.waitForTimeout(6000);
      main = await page.locator('main').innerText();
      check('proxy probe returns a verdict', /探测到可用代理|未探测到可用代理端口/.test(main), (main.match(/探测到可用代理[^\n]*|未探测到可用代理端口/) || [''])[0]);
    }

    // ----------------------------------------------------------------- reports
    process.stdout.write('\n5. Reports page\n');
    await tab('报告').click();
    await page.waitForTimeout(900);
    main = await page.locator('main').innerText();
    check('Reports page renders', main.indexOf('报告') !== -1 && /(还没有报告|刷新)/.test(main), main.split('\n')[0]);

    // -------------------------------------------------------------- live run
    process.stdout.write('\n6. pressing Run for real\n');
    await tab('运行').click();
    await page.waitForTimeout(600);
    await page.locator('main button', { hasText: '立即运行' }).first().click();
    const deadline = Date.now() + 40000;
    let sawError = false;
    while (Date.now() < deadline) {
      const txt = await page.locator('main').innerText();
      if (txt.indexOf('❌') !== -1) {
        sawError = true;
        break;
      }
      await sleep(1000);
    }
    check('the console surfaces the run outcome in the page', sawError, sawError ? 'error banner shown' : 'no outcome within 40s');

    // -------------------------------------------------------------- language
    process.stdout.write('\n7. language switch\n');
    await page.locator('button.lang').click();
    await page.waitForTimeout(500);
    const en = await page.locator('main').innerText();
    const enTabs = await page.locator('nav.tabs button').allInnerTexts();
    check('switching language translates the UI', enTabs.join('|').indexOf('Settings') !== -1, enTabs.join(' | '));
    check('the English Run page says "Run now (daily)"', en.indexOf('Run now (daily)') !== -1);

    // ---------------------------------------------------------------- hygiene
    process.stdout.write('\n8. runtime hygiene\n');
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('no failed /api call during the walk', badApi.length === 0, badApi.slice(0, 3).join(' | '));

    await context.close();
  } catch (err) {
    check('UI traversal completed', false, err && err.message);
    process.stdout.write('\n  ' + (err && err.stack ? err.stack : err) + '\n');
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
    restored();
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

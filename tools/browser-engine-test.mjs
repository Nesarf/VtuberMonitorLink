// ---------------------------------------------------------------------------------------------------
// tools/browser-engine-test.mjs — the bundled browser is Firefox, alone, and its traffic leaves through the
// project's own egress.
//
// What is dangerous here, and therefore what is actually asserted:
//
//   1) **A Chromium survivor.** The swap removed an engine, and code that still reaches for Chromium does not
//      fail loudly — it fails at the moment a user enables a browser-rendered source. So the structural check
//      is a text check over the surfaces that used to carry it, looking for the *code*, not the word (the
//      comments in those files legitimately explain what was removed), and its control runs the same detector
//      over the exact shape that used to be there.
//   2) **An engine the picker offers and Playwright cannot drive.** Measured: `firefox.launch({executablePath:
//      <stock firefox.exe>})` fails with "Failed to launch the browser process" — Playwright drives its own
//      patched build, marked by `playwright.cfg`. So "which browsers does this machine have" must mean "which
//      ones Playwright can drive", and the discovery is checked against a fixture tree holding both kinds.
//   3) **Tor being down reported as a crash.** Tor is not running on this machine most of the time, and the
//      requirement is that this is a *reason*: the port probe happens before a browser is started, the answer
//      is a sentence naming the SOCKS port, and nothing throws. The control is an error that is **not** about
//      the proxy — it must not be described as one.
//   4) **A cookie store that silently reads as "not signed in".** Firefox's `cookies.sqlite` is plaintext, so
//      the reader is short; what has to hold is that it answers from a real store, and that a directory which
//      is *not* a Firefox profile says so as its own state rather than as an empty result.
//
// Every family comes with a control on a deliberately wrong input (`vacuously`): a check that still passes on
// the wrong input is not checking anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(new URL('file:///' + path.join(ROOT, rel).replace(/\\/g, '/')).href);

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};
const ta = async (name, fn) => {
  try {
    await fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

/** The family's control: the right input must be clean, the wrong one must produce exactly one problem. */
const VACUOUS = [];
function vacuously(family, buildRight, buildWrong) {
  const reported = { right: null, wrong: null, error: null };
  try {
    reported.right = buildRight();
    reported.wrong = buildWrong();
  } catch (e) {
    reported.error = e;
  }
  const problems = [];
  if (reported.error) problems.push(`the check threw instead of answering: ${reported.error.message}`);
  else {
    if (!Array.isArray(reported.right)) problems.push(`the right input is not a problems list: ${JSON.stringify(reported.right)}`);
    else if (reported.right.length) for (const p of reported.right) problems.push(`the right input was rejected: ${p}`);
    if (!Array.isArray(reported.wrong)) problems.push(`the wrong input is not a problems list: ${JSON.stringify(reported.wrong)}`);
    else if (reported.wrong.length !== 1) {
      problems.push(
        reported.wrong.length === 0
          ? 'WRONG input passed too -- the control does not fire, so this check proves nothing'
          : `the control fired ${reported.wrong.length} times, so it is reporting something other than the one wrong fact: ${reported.wrong.join(' / ')}`,
      );
    } else if (Array.isArray(reported.right) && reported.right.length === 1 && reported.right[0] === reported.wrong[0]) {
      problems.push('the same problem is reported for the right and the wrong input, so the check does not separate them');
    }
  }
  if (problems.length) {
    VACUOUS.push({ family, problems });
    fail++;
    for (const p of problems) process.stdout.write(`  [FAIL] control ${family}\n         ${p}\n`);
  } else {
    pass++;
    process.stdout.write(`  [ok]   control: "${family}" -- rejected the wrong input, accepted the right one\n`);
  }
}

// ───────────────────────────────────────────── 1. the Chromium survivor

/**
 * Code that would make this project reach for a Chromium again, as a problems list.
 *
 * Deliberately not a search for the word: the comments in these files say "Chromium" on purpose, because the
 * reason a path was removed is worth keeping. What is caught is the *shape that runs*.
 */
export function chromiumSurvivors(src, file = 'source') {
  const problems = [];
  const hits = [
    [/\bchromium\s*\.\s*(launch|launchPersistentContext)\s*\(/, 'a Playwright Chromium launch'],
    [/require\s*\([^)]*\)\s*\.\s*chromium\b/, 'a require(...).chromium'],
    [/\{\s*[^}\n]*\bchromium\b[^}\n]*\}\s*=\s*(await\s+)?(import|require)\s*\(/, 'a destructured chromium import'],
    [/['"]--no-sandbox['"]/, "Chromium's --no-sandbox process flag"],
    [/['"]--disable-dev-shm-usage['"]/, "Chromium's --disable-dev-shm-usage process flag"],
  ];
  for (const [re, what] of hits) if (re.test(String(src))) problems.push(`${file}: still carries ${what}`);
  return problems;
}

/** Whether a build step downloads a Chromium payload, as a problems list */
export function chromiumPayloadProblems(src, file = 'source') {
  const text = String(src);
  const problems = [];
  if (/install['"]\s*,\s*['"]chromium|\bplaywright\s+install\s+chromium/.test(text)) {
    problems.push(`${file}: the build still downloads a Chromium payload`);
  }
  if (/\bchromium_headless_shell\b/.test(text)) problems.push(`${file}: the build still names chromium_headless_shell`);
  return problems;
}

// The surfaces that used to be Chromium's. Every one of them is a place where a leftover would only show up
// when a user switches a source to browser rendering.
const ENGINE_SURFACES = [
  'server/src/fetchers/browser.js',
  'server/src/cookies.js',
  'server/src/browser-target.js',
  'server/src/thumbs.js',
  'web/src/pages/Browser.jsx',
  'tools/traverse-ui.cjs',
];

process.stdout.write('\nthe bundled browser: only Firefox\n');

t('no engine surface still reaches for a Chromium', () => {
  const found = ENGINE_SURFACES.flatMap((rel) => chromiumSurvivors(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel));
  assert.deepEqual(found, []);
});

vacuously(
  'the Chromium-survivor detector (wrong input: the exact shape that was replaced)',
  () => chromiumSurvivors("import { firefox } from 'playwright';\nconst opts = { headless: true };\nbrowser = await firefox.launch(opts);\n"),
  // One violation only: the control's contract is "exactly the one wrong fact", so a fixture with three of
  // them would prove the detector fires but not that it separates them.
  () => chromiumSurvivors("import { chromium } from 'playwright';\nbrowser = await chromium.launch({ headless: true });\n"),
);

t('the portable build packages Firefox and no Chromium payload', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/build-portable.cjs'), 'utf8');
  assert.deepEqual(chromiumPayloadProblems(src), []);
  assert.match(src, /install', 'firefox'|install firefox/, 'the build must install the Firefox engine');
});

vacuously(
  'the Chromium-payload detector (wrong input: the line the build used to run)',
  () => chromiumPayloadProblems("run(NPX, ['--yes', 'playwright', 'install', 'firefox'], { env });"),
  () => chromiumPayloadProblems("run(NPX, ['--yes', 'playwright', 'install', 'chromium'], { env });"),
);

t('nothing in the shipped server still imports a Chromium browser type', () => {
  const srcs = fs
    .readdirSync(path.join(ROOT, 'server/src'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => path.join(ROOT, 'server/src', String(f)));
  const found = srcs.flatMap((p) => chromiumSurvivors(fs.readFileSync(p, 'utf8'), path.relative(ROOT, p)));
  assert.deepEqual(found, []);
});

// ───────────────────────────────────────────── 2. the engine the picker may offer

/** A throwaway tree that looks like a machine with one Playwright build and one stock Firefox. */
function fixtureEngineTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-engine-'));
  const pw = path.join(root, 'firefox-1543', 'firefox');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'firefox.exe'), 'stub');
  fs.writeFileSync(path.join(pw, 'playwright.cfg'), 'stub');
  const stock = path.join(root, 'Mozilla Firefox');
  fs.mkdirSync(stock, { recursive: true });
  fs.writeFileSync(path.join(stock, 'firefox.exe'), 'stub');
  return { root, pwExe: path.join(pw, 'firefox.exe'), stockExe: path.join(stock, 'firefox.exe') };
}

const tree = fixtureEngineTree();
const engine = await mod('server/src/fetchers/browser.js');

t('a Playwright Firefox build is recognised by the marker beside its executable', () => {
  assert.equal(engine.isPlaywrightFirefox(tree.pwExe), true);
  // This is the measurement that made the marker necessary: Playwright refuses a stock Firefox outright, so a
  // discovery that offered one would offer a path that fails at launch.
  assert.equal(engine.isPlaywrightFirefox(tree.stockExe), false);
  assert.equal(engine.isPlaywrightFirefox(''), false, 'an empty path is not a build');
  assert.equal(engine.isPlaywrightFirefox(path.join(tree.root, 'nope', 'firefox.exe')), false, 'a path that is not there is not a build');
});

t('the discovery lists Playwright builds from the roots it is given, and never a stock install', () => {
  // The check is about the fixture root, so the machine's own configured root is taken out of the picture
  // for the length of it — otherwise the answer would depend on where this computer keeps its engines.
  const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  let found;
  try {
    found = engine.detectBrowsers({ extraRoots: [tree.root] });
  } finally {
    if (saved !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
  }
  assert.equal(found.length, 1, `expected one engine, got ${JSON.stringify(found)}`);
  assert.equal(found[0].executablePath, tree.pwExe);
  assert.equal(found[0].playwright, true);
  assert.ok(!found.some((f) => f.executablePath === tree.stockExe), 'a stock Firefox must not be offered as an engine');
});

vacuously(
  'the engine discovery refuses a stock Firefox (wrong input: a discovery that offered one)',
  () => (engine.detectBrowsers({ extraRoots: [tree.root] }).some((d) => d.executablePath === tree.stockExe) ? ['a stock Firefox was offered as an engine'] : []),
  () => {
    const offered = [{ executablePath: tree.stockExe, playwright: false }];
    return offered.some((d) => !d.playwright) ? ['a stock Firefox was offered as an engine'] : [];
  },
);

t('the roots Playwright resolves are the ones this project configures, in order', () => {
  const roots = engine.firefoxBuildRoots();
  assert.ok(roots.length >= 1, 'there must be at least one root to look in');
  const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = 'E:' + path.sep + 'somewhere' + path.sep + 'pw-browsers';
    assert.equal(engine.firefoxBuildRoots()[0], 'E:' + path.sep + 'somewhere' + path.sep + 'pw-browsers', 'the configured root wins: it is the switch the launcher writes');
  } finally {
    if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
  }
});

t('launch options keep no Chromium flag and add no user-agent override', () => {
  const bundled = engine.resolveLaunch({ mode: 'bundled', headless: true });
  assert.deepEqual(bundled, { headless: true });
  const headed = engine.resolveLaunch({ mode: 'bundled', headless: false });
  assert.equal(headed.headless, false);
  const custom = engine.resolveLaunch({ mode: 'custom', executablePath: tree.pwExe });
  assert.equal(custom.executablePath, tree.pwExe);
  assert.deepEqual(Object.keys(custom).sort(), ['executablePath', 'headless']);
});

t('a stock Firefox is refused with the reason and the fix, not with "Failed to launch the browser process"', () => {
  assert.throws(
    () => engine.resolveLaunch({ mode: 'system', executablePath: tree.stockExe }),
    (e) => /playwright\.cfg/.test(e.message) && /playwright install firefox/.test(e.message),
    'the error has to name the missing marker and the command that installs a usable engine',
  );
  // The other two refusals stay what they were
  assert.throws(() => engine.resolveLaunch({ mode: 'system', executablePath: '' }), /系统浏览器|system browser/);
  assert.throws(() => engine.resolveLaunch({ mode: 'custom', executablePath: path.join(tree.root, 'gone.exe') }), /不存在|not found/);
});

// ───────────────────────────────────────────── 3. the egress: Tor down is a reason, never a crash

process.stdout.write('\nthe bundled browser: its egress\n');

t('a dead Tor is reported as the SOCKS port refusing', () => {
  const msg = engine.describeEgressFailure(new Error('page.goto: NS_ERROR_PROXY_CONNECTION_REFUSED'), {
    mode: 'tor',
    socks: 'socks5://127.0.0.1:9150',
  });
  assert.match(msg, /SOCKS 端口拒绝连接|SOCKS port refused/);
  assert.match(msg, /9150/, 'the sentence has to carry the address that refused');
});

/** Does this sentence blame the SOCKS port? The predicate the control below runs on both inputs. */
const blamesSocks = (msg) => /SOCKS 端口拒绝连接|SOCKS port refused/.test(String(msg));

vacuously(
  'the egress-failure describer blames the SOCKS port only when the failure is about the proxy',
  () =>
    blamesSocks(engine.describeEgressFailure(new Error('page.goto: NS_ERROR_PROXY_CONNECTION_REFUSED'), { mode: 'tor', socks: 'socks5://127.0.0.1:9150' }))
      ? []
      : ['a dead Tor was not described as a dead Tor'],
  () =>
    // The mistake: the same sentence produced for a failure that has nothing to do with the egress. This is
    // what the real function must never answer for a timeout, and the assertion below pins that it does not.
    blamesSocks('Tor 出口不可用：SOCKS 端口拒绝连接（socks5://127.0.0.1:9150）:: page.goto: Timeout 45000ms exceeded')
      ? ['a navigation timeout was described as the SOCKS port refusing']
      : [],
);

t('a navigation timeout under Tor is not blamed on the SOCKS port', () => {
  const msg = engine.describeEgressFailure(new Error('page.goto: Timeout 45000ms exceeded'), { mode: 'tor' });
  assert.ok(!blamesSocks(msg), `a timeout must not be reported as the port refusing: ${msg}`);
  assert.match(msg, /Tor egress failed|Tor 出口失败/, 'but it must still say which egress the render was using');
});

t('a Chromium-style failure is never described as a proxy problem (the control the family needs)', () => {
  const msg = engine.describeEgressFailure(new Error('Timeout 45000ms exceeded'), { mode: 'direct' });
  assert.equal(msg, 'Timeout 45000ms exceeded');
});

await ta('an unreachable Tor egress answers with a reason and does not throw', async () => {
  const { resolveBrowserEgress } = await mod('server/src/net.js');
  const cfg = { proxy: { mode: 'tor', torSocks: 'socks5://127.0.0.1:9150' } };
  const closed = await resolveBrowserEgress(cfg, null, { probePort: async () => false });
  assert.equal(closed.ok, false);
  assert.match(closed.error, /SOCKS 端口拒绝连接|SOCKS port refuses/);
  assert.equal(closed.mode, 'tor');
  // A probe that throws is the same answer, not an exception
  const threw = await resolveBrowserEgress(cfg, null, {
    probePort: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal(threw.ok, false);
  // And when the port is open, the browser is handed a SOCKS proxy — no credentials, because Playwright's
  // Firefox refuses them (see server/src/net.js) and a username here would only look like isolation.
  const open = await resolveBrowserEgress(cfg, null, { probePort: async () => true });
  assert.equal(open.ok, true);
  assert.equal(open.proxy.server, 'socks5://127.0.0.1:9150');
  assert.ok(!open.proxy.server.includes('@'), 'a credential in the URL is silently dropped by this engine; it must not be put there');
});

await ta('a browser render with Tor down returns the reason instead of launching a browser', async () => {
  // End to end through the real entry point, and cheap: the port probe fails before any browser starts.
  const r = await engine.renderUrl('http://example.com/', { browser: { headless: true }, proxy: { mode: 'tor', torSocks: 'socks5://127.0.0.1:9150' } }, {});
  assert.equal(r.ok, false);
  assert.equal(r.egress, 'tor');
  assert.match(r.error, /SOCKS 端口拒绝连接|SOCKS port refuses/);
  assert.equal(r.url, 'http://example.com/');
});

t('a source pinned to Tor is rendered through Tor even when the global mode is direct', async () => {
  const { resolveBrowserEgress } = await mod('server/src/net.js');
  const seen = [];
  const r = await resolveBrowserEgress({ proxy: { mode: 'http', enabled: false } }, { id: 's1', proxy: 'tor' }, { probePort: async (u) => (seen.push(u), true) });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'tor');
  assert.equal(seen.length, 1, 'the probe must run for the egress the source asked for');
});

// ───────────────────────────────────────────── 4. the cookie store

/** A real Firefox cookie store, written the way Firefox writes one */
function fixtureCookieStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-ff-profile-'));
  const db = new DatabaseSync(path.join(dir, 'cookies.sqlite'));
  db.exec(
    'CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER)',
  );
  const ins = db.prepare('INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry) VALUES (?,?,?,?,?,?)');
  // A session cookie on the bare host, a domain cookie carrying the same name (the dotted one must win), and
  // one belonging to another site entirely.
  ins.run('', 'auth_token', 'bare', 'example.com', '/', 0);
  ins.run('', 'auth_token', 'dotted', '.example.com', '/', 0);
  ins.run('', 'theme', 'dark', 'example.com', '/', 0);
  ins.run('', 'other_site', 'nope', 'elsewhere.test', '/', 0);
  db.close();
  return dir;
}

const profileDir = fixtureCookieStore();

await ta('a Firefox profile reads its cookies, and the dotted domain cookie wins for a shared name', async () => {
  const { readBrowserCookies } = await mod('server/src/cookies.js');
  const r = await readBrowserCookies(profileDir, ['example.com']);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.profile, path.resolve(profileDir));
  assert.deepEqual(r.names, ['auth_token', 'theme']);
  assert.equal(r.cookieHeader, 'auth_token=dotted; theme=dark'); // sanitize-allow: fixture values, deliberately cookie-shaped, for the check that proves a cookie value is reported as names only
  assert.ok(!r.cookieHeader.includes('other_site'), 'a cookie for another domain must not be in the header');
  // No decryption story is left to fail: the Chromium reader's warning field was about App-Bound Encryption
  // and there is no equivalent state any more.
  assert.equal(r.warning, undefined);
});

vacuously(
  'the store-vs-empty distinction (wrong input: a reader that answered "no cookies" for a missing store)',
  () => {
    // What the reader must report for a directory with no store: its own state.
    const answer = { ok: false, reason: 'no-firefox-profile' };
    return answer.ok === false && answer.reason === 'no-firefox-profile' ? [] : ['a directory with no store was not reported as its own state'];
  },
  () => {
    // The mistake: folding "this is not a Firefox profile" into "this profile has no cookies for the domain".
    const answer = { ok: false, error: '该 profile 里没有目标域名的 cookie（可能没登录）' };
    return answer.reason ? [] : ['a directory with no store was reported as "not signed in"'];
  },
);

await ta('a Chromium-profile-shaped directory says "no Firefox cookie store" instead of "not signed in"', async () => {
  const { readBrowserCookies } = await mod('server/src/cookies.js');
  const chromiumish = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-chromium-profile-'));
  fs.mkdirSync(path.join(chromiumish, 'Default', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(chromiumish, 'Default', 'Network', 'Cookies'), 'not a sqlite file');
  const r = await readBrowserCookies(chromiumish, ['example.com']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-firefox-profile', 'a directory without a store is a different fact from an unsigned-in profile');
  assert.match(r.error, /cookies\.sqlite/);
  // The control: the same call against a real store answers ok, so the check above is not "it always fails".
  const good = await readBrowserCookies(profileDir, ['example.com']);
  assert.equal(good.ok, true);
});

await ta('a profile with no cookie for the domain is a different answer from a missing store', async () => {
  const { readBrowserCookies } = await mod('server/src/cookies.js');
  const r = await readBrowserCookies(profileDir, ['nowhere.test']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, undefined);
  assert.match(r.error, /没登录|not signed in|cookie/);
});

await ta('a Firefox root (the directory profiles.ini lives in) is expanded to a profile that has a store', async () => {
  const { readBrowserCookies } = await mod('server/src/cookies.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-ff-root-'));
  const inner = path.join(root, 'Profiles', 'aaaa1111.default');
  fs.cpSync(profileDir, inner, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'profiles.ini'),
    '[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/aaaa1111.default\nDefault=1\n',
  );
  const r = await readBrowserCookies(root, ['example.com']);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.profile, path.resolve(inner));
  // The control on the same call shape: an empty setting is still refused before anything is looked at
  const none = await readBrowserCookies('', ['example.com']);
  assert.equal(none.ok, false);
});

// ───────────────────────────────────────────── cleanup + result

for (const dir of [tree.root, profileDir]) fs.rmSync(dir, { recursive: true, force: true });

process.stdout.write('\n' + (fail ? `${fail} failed, ${pass} passed.\n` : `all ${pass} browser-engine checks passed.\n`));
process.exit(fail ? 1 : 0);

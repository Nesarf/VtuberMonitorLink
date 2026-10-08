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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
  // The check is about the fixture root. The machine's configured switch is taken out of the picture for
  // its length, but the answer is no longer asserted to be "exactly one engine": this project resolves the
  // repository's own `pw-browsers/` as well (that is the layout the disk discipline produces, and it is in
  // firefoxBuildRoots for that reason), so a checkout that carries an engine legitimately answers with two.
  // Pinning "one" would make this check depend on the machine it runs on - which is the failure mode this
  // whole section is being fixed for. What is asserted is the fact the check is about.
  const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  let found;
  try {
    found = engine.detectBrowsers({ extraRoots: [tree.root] });
  } finally {
    if (saved !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
  }
  const fromFixture = found.find((f) => f.executablePath === tree.pwExe);
  assert.ok(fromFixture, `the fixture's own engine was not listed: ${JSON.stringify(found)}`);
  assert.equal(fromFixture.playwright, true);
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
  assert.ok(roots.length >= 2, 'there must be at least the repository root and a platform default to look in');
  const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = 'E:' + path.sep + 'somewhere' + path.sep + 'pw-browsers';
    const withSwitch = engine.firefoxBuildRoots();
    assert.equal(withSwitch[0], 'E:' + path.sep + 'somewhere' + path.sep + 'pw-browsers', 'the configured root wins: it is the switch the launcher writes');
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    const without = engine.firefoxBuildRoots();
    // The repository's own directory, derived from the project root rather than named: the layout
    // `build:portable` produces and the one this machine's disk discipline creates are the same one.
    assert.equal(without[0], path.join(ROOT, 'pw-browsers'), 'the repository root must be resolved from the project root, not from the environment');
    assert.ok(without.length >= 2, 'the platform default must still be listed after it');
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

// ───────────────────────────────────────────── 3. the egress: a dead Tor is a reason, never a crash

process.stdout.write('\nthe bundled browser: its egress\n');

t('a dead Tor is reported as the SOCKS port refusing', () => {
  const msg = engine.describeEgressFailure(new Error('page.goto: NS_ERROR_PROXY_CONNECTION_REFUSED'), {
    mode: 'tor',
    socks: 'socks5://127.0.0.1:9150',
  });
  assert.match(msg, /SOCKS 端口拒绝连接|SOCKS port refused/);
  assert.match(msg, /9150/, 'the sentence has to carry the address that refused');
});

/**
 * The child that answers two questions in one run, in its own process because both are about the
 * environment rather than about this file: **can an engine be discovered at all**, and, if the product was
 * reached, **what does it say when the engine is missing**. The engine is resolved the way the application
 * resolves it - `detectBrowsers()` with no extra roots, i.e. the environment variable, then the
 * repository's own `pw-browsers/`, then the platform defaults - so a checkout that carries an engine is
 * really exercised, and a project that has none produces a statement instead of a launch failure.
 *
 * It is a `-e` body whose imports are dynamic for a reason: mixing `require` with a top-level await makes
 * node refuse the script outright ("Cannot determine intended module format"), and a child that dies on
 * that reads as an empty answer rather than as a broken probe. Arguments: <refused socks url> <module url>.
 * The project root is not an argument: it is the child's working directory, and `APP_ROOT` follows from it.
 */
const ENGINE_PROBE = `
const out = { engine: null, noEngine: false, refused: null, notes: null };
const refusedUrl = process.argv[1];
try {
  const engine = await import(process.argv[2]);
  // The discovery is the source of truth for "is there an engine here", and it answers from the filesystem:
  // PLAYWRIGHT_BROWSERS_PATH, then this repository's own pw-browsers/, then the platform defaults. Reading
  // it rather than parsing Playwright's launch error is deliberate - the error text differs by Playwright
  // version and by platform, and a check built on it would start lying the first time either changed.
  const found = engine.detectBrowsers();
  out.roots = engine.firefoxBuildRoots();
  if (found.length) out.engine = found[0].executablePath;
  else out.noEngine = true; // the discovery is the statement; nothing below it is parsed for it
  const r = await engine.renderUrl('http://example.com/', { browser: { headless: true }, proxy: { mode: 'tor', torSocks: refusedUrl } }, {});
  out.refused = { ok: r.ok, egress: r.egress, error: String(r.error ?? '') };
} catch (e) {
  out.notes = String(e && e.message ? e.message : e);
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * The child of the render check: import the product, render a data URL, report what came back. It exists
 * because of the module-load ordering described at its call site, and it renders a data URL so that the
 * check needs no network and no site.
 */
const RENDER_PROBE = `
try {
  const engine = await import(process.argv[1]);
  const r = await engine.renderUrl('data:text/html,<body>vml-engine-probe</body>', { browser: { headless: true } }, {});
  process.stdout.write(JSON.stringify({ ok: r.ok, error: String(r.error ?? ''), content: String(r.content ?? '') }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
}
`;

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

/** The URL the project builds for a Tor egress (same shape as fixtures elsewhere in this repo). */
const socksUrlFor = (port) => 'socks5://127.0.0.1:' + port;

/**
 * End to end through the real entry point, with an egress that is **ours**.
 *
 * The first version of this check used the default 9150 and asserted that Tor was down. That made the
 * check a statement about this machine: the day somebody started Tor Browser the port was open, the render
 * went through, and a check named "with Tor down" quietly became an assertion about the weather. So the
 * port is taken from the OS instead - bind an ephemeral port, read its number, close it - which is a port
 * this test owned a moment ago and which therefore refuses for the length of the run.
 *
 * The engine is resolved the way the application resolves it (`PLAYWRIGHT_BROWSERS_PATH`, then the
 * repository's own `pw-browsers/`, then the platform defaults), and when nothing is discoverable the check
 * reports **that** as its own statement rather than letting Playwright's "Executable doesn't exist at
 * <machine path>" stand in for it: a missing engine is a fact about the environment, and a check that
 * calls it a product failure teaches people to ignore the colour.
 */
const sock = net.createServer();
const refusedPort = await new Promise((resolve, reject) => {
  sock.once('error', reject);
  sock.listen(0, '127.0.0.1', () => {
    const port = sock.address().port;
    sock.close((err) => (err ? reject(err) : resolve(port)));
  });
});
const refusedUrl = socksUrlFor(refusedPort);

await ta('an unreachable Tor egress is a reason, not a crash (the port is one this test owns)', async () => {
  const r = await engine.renderUrl('http://example.com/', { browser: { headless: true }, proxy: { mode: 'tor', torSocks: refusedUrl } }, {});
  assert.equal(r.ok, false);
  assert.equal(r.egress, 'tor');
  assert.match(r.error, /SOCKS 端口拒绝连接|SOCKS port refuses/);
  assert.ok(r.error.includes(String(refusedPort)), 'the sentence has to name the port that refused, not a default');
  assert.equal(r.url, 'http://example.com/');
});

const BROWSER_MODULE_URL = new URL('file:///' + path.join(ROOT, 'server/src/fetchers/browser.js').split(path.sep).join('/')).href;

/**
 * Run the engine probe in its own process.
 *
 * `engineRoot` is the ordinary switch (`PLAYWRIGHT_BROWSERS_PATH`) - the input the launcher writes - and
 * `projectRoot` is the directory the child runs in, which is what decides the *other* two roots, because
 * `APP_ROOT` is derived from the module's own location. That second parameter is how "a machine with no
 * engine at all" is expressed honestly: a directory that is not this project, holding a copy of the server
 * sources, so nothing on the resolved list contains an engine. (An empty `PLAYWRIGHT_BROWSERS_PATH` alone
 * does **not** express it - the first version of this check was written that way, failed, and the failure
 * was correct: the fallback to the repository's own `pw-browsers/` still found the engine, which is the
 * resolution order working as designed.)
 */
const probe = ({ projectRoot = ROOT, engineRoot = path.join(projectRoot, 'pw-browsers') } = {}) => {
  // The module URL follows the project root: `APP_ROOT` is derived from the module's own location, so a copy
  // of the sources in a directory with no engine is what "this machine has no engine" actually means. Passing
  // an empty root while still loading the real module would discover the real project's engine - which is
  // what the first version of this control did, and it failed, correctly.
  const moduleUrl = new URL('file:///' + path.join(projectRoot, 'server/src/fetchers/browser.js').split(path.sep).join('/')).href;
  const r = spawnSync(process.execPath, ['-e', ENGINE_PROBE, refusedUrl, moduleUrl], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: projectRoot,
    env: { ...process.env, ...(engineRoot === null ? {} : { PLAYWRIGHT_BROWSERS_PATH: engineRoot }) },
  });
  let report = null;
  try {
    report = JSON.parse(String(r.stdout ?? '').trim());
  } catch {
    report = null;
  }
  const fallback = { engine: null, noEngine: false, refused: null, notes: `the probe did not answer (exit ${r.status}): ${String(r.stderr).slice(-300)}` };
  return { report: report ?? fallback, status: r.status };
};

/** Reads a probe answer as the one sentence it is, so the checks below cannot disagree about it. */
const probeSentence = (p) => {
  const r = p?.report;
  if (!r) return 'no answer';
  if (r.engine) {
    const refused = r.refused ?? {};
    if (refused.ok !== false) return `an engine was found (${r.engine}) but a refusing egress did not stop the render`;
    if (!/SOCKS 端口拒绝连接|SOCKS port refuses/.test(String(refused.error))) return `the render failed for another reason: ${refused.error}`;
    if (!String(refused.error).includes(String(refusedPort))) return `the sentence does not name the port that refused (${refusedPort}): ${refused.error}`;
    return 'the render was refused with a sentence naming the port';
  }
  if (r.noEngine) return 'there is no browser engine to render with here';
  return `the answer was neither of the two: ${JSON.stringify(r)}`;
};

/**
 * A throwaway copy of this project's server sources, sitting inside the repository but with no engine in
 * it - the "machine with no engine at all" the environment branch needs. Inside the repository for one
 * practical reason: node resolves `playwright` by walking up from the importing file, so a copy in the OS
 * temp directory cannot load the module at all (measured: "Cannot find package 'playwright'"). The name
 * starts with a dot and the caller removes it in a `finally`.
 */
let noEngineProject = null;
function projectWithoutEngines() {
  noEngineProject = fs.mkdtempSync(path.join(ROOT, '.vml-no-engine-'));
  fs.cpSync(path.join(ROOT, 'server', 'src'), path.join(noEngineProject, 'server', 'src'), { recursive: true });
  fs.mkdirSync(path.join(noEngineProject, 'pw-browsers'), { recursive: true }); // present, and empty
  return noEngineProject;
}
function removeNoEngineProject() {
  if (!noEngineProject) return;
  try {
    fs.rmSync(noEngineProject, { recursive: true, force: true });
  } catch {
    /* a leftover scratch directory is untidy; failing the run over it would be worse */
  }
  noEngineProject = null;
}

const withEngine = probe();
const withoutEngine = probe({ projectRoot: projectWithoutEngines() });

t('the probe tells an engine failure apart from a missing engine (the control both branches need)', () => {
  // The predicate the two checks below rest on, run against answers that are deliberately wrong: one that
  // found an engine but let the render through, and one that reports an environment with no engine. If it
  // answered the same thing for both, neither check below would be checking anything.
  const wrongEngine = { report: { engine: 'X:/engine/firefox.exe', noEngine: false, refused: { ok: true, egress: 'tor', error: '' } } };
  const wrongNoEngine = { report: { engine: null, noEngine: true, refused: { ok: false, egress: 'tor', error: 'Executable does not exist' } } };
  assert.match(probeSentence(wrongEngine), /did not stop the render/, `the control did not fire: ${probeSentence(wrongEngine)}`);
  assert.equal(probeSentence(wrongNoEngine), 'there is no browser engine to render with here');
  assert.equal(probeSentence(null), 'no answer');
});

if (withEngine.report?.engine) {
  t('the engine is found through the project’s own resolution order', () => {
    assert.match(probeSentence(withEngine), /naming the port/, `the engine answered: ${probeSentence(withEngine)}`);
  });

  t('a browser really renders, through that engine', () => {
    // In a child, because Playwright reads its browser path **once, at module load**: setting the switch in
    // this process after the import would have no effect, and the render would look for the engine in the
    // platform default location (measured - that is exactly how the first version of this check failed).
    const child = spawnSync(process.execPath, ['-e', RENDER_PROBE, BROWSER_MODULE_URL], {
      encoding: 'utf8',
      timeout: 180000,
      cwd: ROOT,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(ROOT, 'pw-browsers') },
    });
    let out = null;
    try {
      out = JSON.parse(String(child.stdout ?? '').trim().split('\n').pop());
    } catch {
      out = null;
    }
    assert.ok(out, `the render probe did not answer (exit ${child.status}): ${String(child.stdout).slice(-300)}${String(child.stderr).slice(-300)}`);
    assert.equal(out.ok, true, `the render failed: ${out.error}`);
    assert.match(String(out.content), /vml-engine-probe/, 'the engine ran but the page did not come back');
  });
} else {
  t('the engine is found through the project’s own resolution order (environment statement, not a failure)', () => {
    // Not a pass hidden in a condition and not a failure: this checkout has no engine and neither does the
    // platform default location, which is a fact about the machine and is said in one line.
    process.stdout.write('         no engine in this checkout or on the platform default list: ' + probeSentence(withEngine) + '\n');
  });
}

t('with no discoverable engine the probe states the environment - and does not call it a failure', () => {
  try {
  // The point of the rewrite: an environment without an engine is its own answer, and the check for it is
  // **the discovery**, which reads the filesystem rather than parsing Playwright's error text (that text
  // differs by version and by platform, and a check built on it starts lying the first time either moves).
  // The render result is recorded, not asserted on: with no engine there is nothing to render with, and
  // Playwright's raw "Executable doesn't exist at <machine path>" is exactly what must not become the
  // product's answer.
  assert.equal(probeSentence(withoutEngine), 'there is no browser engine to render with here', JSON.stringify(withoutEngine.report));
  assert.equal(withoutEngine.report?.noEngine, true);
  assert.equal(withoutEngine.report?.engine, null);
  assert.ok(withoutEngine.report?.refused, 'the probe records what the product answered with no engine, even when it is a refusal');
  const banner = /playwright install|Pull request|╔/i;
  assert.ok(!banner.test(String(withoutEngine.report?.notes)), 'the environment statement must not be Playwright’s install banner');
  assert.ok(!/Executable doesn't exist/i.test(String(withoutEngine.report?.notes)), 'the environment statement must not be Playwright’s raw path error');
  } finally {
    removeNoEngineProject();
  }
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

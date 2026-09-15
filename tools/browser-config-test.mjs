// ---------------------------------------------------------------------------------------------------
// tools/browser-config-test.mjs — the browser/profile targeting: one page, one config path, one resolver.
//
// What is dangerous here, and therefore what is actually asserted:
//
//   1) **A feature that reads the setting differently from the others.** This is the defect the round is
//      about, and it is invisible at runtime: every consumer works on the machine where the setting happens
//      to be filled in, and only the machine where it is empty shows which ones disagreed. So the assertion
//      is structural — every module in the inventory (server/src/browser-consumers.js) resolves
//      `browser.profileDir` through server/src/browser-target.js, and **no** module reads the key itself.
//      The control points one consumer at a different key and requires the check to fire.
//   2) **A picker that offers a profile it cannot use.** The discovery shape is normalised, and an entry
//      without a path is refused rather than carried along as `path: ''` — a pick of that row would set the
//      setting to emptiness, which is exactly the state the owner was stuck in.
//   3) **A default that gets used behind the user's back.** Cookie stores are credentials, so the documented
//      default is *shown and offered*, never silently substituted: an empty setting resolves to empty. The
//      resolution still has to be the same function every consumer calls, so this file asserts both halves —
//      the resolution the consumers get, and the default the page offers.
//   4) **A dead end.** /api/browser/target reports, per consumer, what it needs and whether it is satisfied;
//      the module that reports it must be the same inventory the structural check reads, or the page can
//      describe a set of features that no longer exists.
//
// Every family comes with a control on a deliberately wrong input (`vacuously`): a check that still passes on
// the wrong input is not checking anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(new URL('file:///' + path.join(ROOT, rel).replace(/\\/g, '/')).href);

const {
  anonymousModeKey,
  browserProfileKey,
  directProfileReads,
  normalizeProfile,
  normalizeProfiles,
  listProfiles,
  resolveProfileDir,
  resolveProfileTarget,
  configuredProfileDir,
  defaultProfileDir,
  browserFromExecutable,
  pickerFor,
  pickProfile,
  applyPickProfile,
  discoverAccounts,
  browserConsumerProblems,
} = await mod('server/src/browser-target.js');
// The inventory lives in its own module, and it is the same list the route reports and the structural check
// reads — which is the point of importing it here rather than writing a second list of consumer files.
const { BROWSER_CONSUMERS, browserTargetReport, consumerSources, missingConsumerFiles } = await mod('server/src/browser-consumers.js');
const { inventoryKeyProblems } = await mod('server/src/browser-target.js');

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

/**
 * The family's control. Three things are asserted, in this order, so a control can never pass for the wrong
 * reason:
 *
 *   1) the **right** input produces no problems at all;
 *   2) the **wrong** input produces exactly one;
 *   3) that one problem is not also produced by the right input (the mistake this catches: a check that fires
 *      on everything, which looks like a control that works).
 *
 * The first version of this helper compared the two counts the wrong way round — measured, it reported "got 0"
 * for an empty list and made three controls fire on their own right input. The counters below are what make
 * that impossible to repeat: `problems` is only ever a container, never a source of truth.
 */
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
  if (reported.error) {
    problems.push(`the check threw instead of answering: ${reported.error.message}`);
  } else {
    if (!Array.isArray(reported.right)) problems.push(`the right input is not a problems list: ${JSON.stringify(reported.right)}`);
    else if (reported.right.length) for (const p of reported.right) problems.push(`the right input was rejected: ${p}`);
    if (!Array.isArray(reported.wrong)) problems.push(`the wrong input is not a problems list: ${JSON.stringify(reported.wrong)}`);
    else if (reported.wrong.length !== 1) {
      problems.push(
        reported.wrong.length === 0
          ? 'WRONG input passed too -- the control does not fire, so this check proves nothing'
          : `the control fired ${reported.wrong.length} times, which means it is reporting something other than the one wrong fact: ${reported.wrong.join(' / ')}`,
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

// A stand-in machine: two browsers, one with two profiles, one installed but never signed in, and a fixed
// filesystem so `present` is a fact of the fixture rather than of this computer.
const ROOT_CHROME = 'R:' + path.sep + 'chrome' + path.sep + 'User Data';
const ROOT_EDGE = 'R:' + path.sep + 'edge' + path.sep + 'User Data';
const P_DEFAULT = path.join(ROOT_CHROME, 'Default');
const P_WORK = path.join(ROOT_CHROME, 'Profile 1');
const exe = (browser) =>
  ({
    Chrome: 'C:' + path.sep + 'Program Files' + path.sep + 'Google' + path.sep + 'Chrome' + path.sep + 'Application' + path.sep + 'chrome.exe',
    Edge: 'C:' + path.sep + 'Program Files (x86)' + path.sep + 'Microsoft' + path.sep + 'Edge' + path.sep + 'Application' + path.sep + 'msedge.exe',
    Brave: 'C:' + path.sep + 'Program Files' + path.sep + 'BraveSoftware' + path.sep + 'Brave-Browser' + path.sep + 'Application' + path.sep + 'brave.exe',
  })[browser];

const machine = {
  roots: () => [
    ['Chrome', ROOT_CHROME],
    ['Edge', ROOT_EDGE],
    // A third browser, installed with a user-data root but no profile inside it: it is still offered, as a
    // row that says "here, but nothing signed in" rather than as an absence nobody can act on.
    ['Brave', 'R:' + path.sep + 'brave'],
  ],
  profiles: (root) => {
    if (root === ROOT_CHROME) return [P_DEFAULT, P_WORK];
    return [];
  },
  fs: { existsSync: (p) => [ROOT_CHROME, ROOT_EDGE, P_DEFAULT, P_WORK, exe('Chrome'), exe('Edge')].includes(String(p)) },
};

const emptyCfg = { browser: { mode: 'bundled', executablePath: '', profileDir: '' } };
const setCfg = (dir, extra = {}) => ({ browser: { mode: 'system', executablePath: exe('Chrome'), profileDir: dir, ...extra } });

/** The problems with a discovery answer: every offered row must be one a pick could actually apply, and a
 *  refusal must be recorded rather than swallowed */
function discoveryProblems(answer) {
  const rows = answer?.profiles ?? [];
  if (!rows.length) return ['the discovery offered nothing, so this check proves nothing'];
  if (!rows.every((r) => r && r.path && r.absolute)) return ['a row with no usable path survived'];
  return (answer.dropped ?? []).length ? [`${answer.dropped.length} entry/entries were refused without saying so`] : [];
}

/** The problems with a picker's rows: the same rule, on the mapping the page renders */
function rowProblems(rows) {
  if (!rows.length) return ['the picker offered nothing, so this check proves nothing'];
  return rows.every((r) => r && r.path && r.absolute) ? [] : ['the picker offered a row it cannot apply'];
}

// ───────────────────────────────────────────── 1. the discovery shape

process.stdout.write('\nbrowser target: the discovered profiles\n');

t('a profile entry without a path is refused, and nothing half-built is returned', () => {
  assert.equal(normalizeProfile(undefined), null);
  assert.equal(normalizeProfile(null), null);
  assert.equal(normalizeProfile({}), null);
  assert.equal(normalizeProfile({ browser: 'Chrome' }), null);
  assert.equal(normalizeProfile({ browser: 'Chrome', name: 'Default', path: '' }), null);
  assert.equal(normalizeProfile({ browser: 'Chrome', name: 'Default', path: '   ' }), null);
  // A path that is not a string is not a path: `42` would otherwise resolve to a file named "42" beside the
  // process, which is a setting nobody asked for dressed up as a discovered profile.
  assert.equal(normalizeProfile({ browser: 'Chrome', name: 'Default', path: 42 }), null);
  assert.equal(normalizeProfile({ browser: 'Chrome', name: 'Default', path: ['x'] }), null);
  assert.deepEqual(normalizeProfiles([{ browser: 'Chrome' }, null, { path: '' }]), []);
});

t('a usable entry carries a digest id (never the path), the browser, the name, and whether it exists here', () => {
  const a = normalizeProfile({ browser: 'Chrome', name: 'Default', path: P_DEFAULT }, { fs: machine.fs });
  assert.ok(a, 'a path-bearing entry must survive normalisation');
  assert.equal(a.browser, 'Chrome');
  assert.equal(a.name, 'Default');
  assert.equal(a.path, P_DEFAULT);
  assert.equal(a.absolute, path.resolve(P_DEFAULT));
  assert.equal(a.present, true);
  assert.match(a.id, /^[A-Za-z0-9_-]{16}$/);
  // The id is handed to the client, so it must not be a readable form of the path (BUGS #69 is the precedent)
  assert.ok(!a.id.includes('R:') && !a.id.includes('chrome'), `the id must not carry the path: ${a.id}`);
  assert.equal(a.id, normalizeProfile({ browser: 'x', path: P_DEFAULT }).id, 'the same path must give the same id');
});

t('enumeration offers every profile of every installed browser, plus the browser that has none yet', () => {
  const { profiles, dropped } = listProfiles(machine);
  const paths = profiles.map((p) => p.absolute);
  assert.deepEqual(paths, [path.resolve(P_DEFAULT), path.resolve(P_WORK), path.resolve(ROOT_EDGE), path.resolve('R:' + path.sep + 'brave')]);
  assert.equal(profiles[0].browser, 'Chrome');
  assert.equal(profiles[0].hasProfiles, true);
  // Edge and Brave have a user-data root and no profile inside it: they are rows too, and they say so.
  assert.equal(profiles[2].hasProfiles, false);
  assert.equal(profiles[3].hasProfiles, false);
  // Nothing on this fixture is unusable, so the refusals are empty rather than an absent field.
  assert.deepEqual(dropped, []);
});

t('a discovery that refuses an entry says so instead of quietly listing fewer browsers', () => {
  const { profiles, dropped } = listProfiles({ ...machine, roots: () => [['Chrome', ROOT_CHROME], ['Edge', '']] });
  assert.equal(profiles.length, 2, 'the usable rows still come back');
  assert.deepEqual(dropped, [{ browser: 'Edge', path: '', reason: 'no-path' }]);
  // And the picker folds that refusal into the count the page shows.
  const picker = pickerFor({ profiles, dropped }, setCfg(''));
  assert.deepEqual(picker.unusable, [{ browser: 'Edge', path: '', reason: 'no-path' }]);
});

vacuously(
  'the discovery refuses an entry with no path, and says that it did (wrong input: a discovery list holding one)',
  () => discoveryProblems(listProfiles(machine)),
  () => discoveryProblems({ profiles: listProfiles(machine).profiles, dropped: [{ browser: 'Chrome', path: '', reason: 'no-path' }] }),
);

// ───────────────────────────────────────────── 2. one resolution

process.stdout.write('\nbrowser target: the resolution every consumer gets\n');

t('an explicitly configured dir is what resolves, and the source says so', () => {
  const r = resolveProfileTarget(setCfg(P_DEFAULT), { fs: machine.fs, roots: machine.roots });
  assert.equal(r.dir, P_DEFAULT);
  assert.equal(r.source, 'configured');
  assert.equal(configuredProfileDir(setCfg(P_DEFAULT)), P_DEFAULT);
  assert.equal(resolveProfileDir(setCfg(P_DEFAULT), { fs: machine.fs, roots: machine.roots }), P_DEFAULT);
});

t('an EMPTY setting resolves to empty -- and the documented default is reported next to it, not substituted', () => {
  const r = resolveProfileTarget(emptyCfg, { fs: machine.fs, roots: machine.roots });
  assert.equal(r.dir, '', 'an empty setting must not silently become a credential nobody named');
  assert.equal(r.source, 'none');
  assert.equal(r.configured, '');
  // The reported default is the user-data dir of the **configured browser**. With the bundled Chromium there
  // is no such thing to point at, so the page has to say that instead of offering a path (see the next case);
  // what matters here is that the default is *reported beside* the answer and never substituted into it.
  assert.equal(r.default, '');
  assert.ok(r.reasons.includes('not-configured'), JSON.stringify(r.reasons));
  assert.equal(resolveProfileDir(emptyCfg, { fs: machine.fs, roots: machine.roots }), '', 'the consumers get the same empty answer');
});

t('the documented default follows the configured browser, and a bundled Chromium has none to point at', () => {
  assert.equal(defaultProfileDir(setCfg('', { executablePath: exe('Chrome') }), { fs: machine.fs, roots: machine.roots }), path.resolve(ROOT_CHROME));
  assert.equal(defaultProfileDir(setCfg('', { executablePath: exe('Edge') }), { fs: machine.fs, roots: machine.roots }), path.resolve(ROOT_EDGE));
  // bundled = Playwright's own Chromium: there is no user-data dir to read cookies out of, and the page says
  // so instead of showing an empty field with no explanation.
  assert.equal(defaultProfileDir(emptyCfg, { fs: machine.fs, roots: machine.roots }), '');
  assert.equal(browserFromExecutable(exe('Chrome')), 'Chrome');
  assert.equal(browserFromExecutable(exe('Brave')), 'Brave');
  assert.equal(browserFromExecutable(''), 'bundled');
});

t('a dir handed in on purpose wins over nothing, but never over the setting the user chose', () => {
  assert.equal(resolveProfileDir(emptyCfg, { profileDir: P_WORK }).valueOf(), P_WORK);
  assert.equal(resolveProfileTarget(emptyCfg, { profileDir: P_WORK }).source, 'given');
  const chosen = resolveProfileTarget(setCfg(P_DEFAULT), { profileDir: P_WORK });
  assert.equal(chosen.dir, P_DEFAULT);
  assert.equal(chosen.source, 'configured');
});

t('anonymous mode empties the resolution for every consumer at once, whatever the setting says', () => {
  const cfg = { browser: { profileDir: P_DEFAULT }, privacy: { anonymousMode: true } };
  const r = resolveProfileTarget(cfg, { fs: machine.fs, roots: machine.roots });
  assert.equal(r.dir, '');
  assert.equal(r.source, 'anonymous');
  assert.equal(r.configured, P_DEFAULT, 'the setting itself is still reported, so the page can show it');
  assert.deepEqual(r.reasons, ['anonymous-mode']);
  assert.equal(resolveProfileDir(cfg), '');
  assert.equal(anonymousModeKey(), 'privacy.anonymousMode');
});

vacuously(
  "an empty setting does not borrow an installed browser's cookies (wrong input: a resolution that fell back)",
  () => (resolveProfileTarget(emptyCfg, { fs: machine.fs, roots: machine.roots }).dir === '' ? [] : ['the resolution invented a profile']),
  () => {
    const fellBack = { ...resolveProfileTarget(emptyCfg, { fs: machine.fs, roots: machine.roots }), dir: path.resolve(ROOT_CHROME) };
    return fellBack.dir === '' ? [] : [`the resolution invented a profile: ${fellBack.dir}`];
  },
);

vacuously(
  'anonymous mode really empties the resolution (wrong input: the setting wins over the switch)',
  () => (resolveProfileTarget({ browser: { profileDir: P_DEFAULT }, privacy: { anonymousMode: true } }).dir === '' ? [] : ['anonymous mode did not stop a login from being resolved']),
  () => {
    const r = resolveProfileTarget({ browser: { profileDir: P_DEFAULT }, privacy: { anonymousMode: false } });
    return r.dir === '' ? [] : [`a login is resolved while the switch is off: ${r.dir}`];
  },
);

// ───────────────────────────────────────────── 3. the picker's mapping

process.stdout.write('\nbrowser target: the picker\'s mapping\n');

t('the selected row is the one the setting names, compared on the resolved path (either shape of it)', () => {
  const list = listProfiles(machine);
  const a = pickerFor(list, setCfg(P_DEFAULT));
  assert.equal(a.selected?.absolute, path.resolve(P_DEFAULT));
  assert.equal(a.options.filter((o) => o.selected).length, 1);
  // `...\User Data` and `...\User Data\Default` are both acceptable values for the same store (cookies.js
  // accepts either), so the picker must recognise both rather than reporting "nothing selected".
  const b = pickerFor(list, setCfg(''));
  assert.equal(b.selected, null);
  assert.equal(b.options.every((o) => !o.selected), true);
  const c = pickerFor(list, setCfg(P_DEFAULT + path.sep));
  assert.equal(c.selected?.absolute, path.resolve(P_DEFAULT));
});

t('a setting that was not discovered is offered as its own row, so the page can say what is set', () => {
  const configured = 'Q:' + path.sep + 'other' + path.sep + 'User Data';
  const p = pickerFor(listProfiles(machine), setCfg(configured));
  assert.equal(p.options[0].current, true, 'the row from the setting comes first');
  assert.equal(p.options[0].path, configured);
  assert.equal(p.options[0].selected, true);
  assert.equal(p.selected?.current, true);
});

t('an entry with no path is skipped, and the skip is counted rather than silent', () => {
  const p = pickerFor([{ browser: 'Chrome', name: 'Default' }, { browser: 'Chrome', name: 'Default', path: P_DEFAULT }], setCfg(''));
  assert.equal(p.options.length, 1);
  assert.deepEqual(p.unusable, [{ path: '', reason: 'no-path' }]);
  assert.equal(p.options[0].path, P_DEFAULT);
});

t('"use this one" maps a row to the config change, and cannot write an empty setting', () => {
  const row = pickerFor(listProfiles(machine), setCfg('')).options[0];
  const picked = pickProfile(row);
  assert.equal(picked.ok, true);
  assert.equal(picked.value, row.path);
  assert.deepEqual(picked.patch, { browser: { profileDir: row.path } });
  const applied = applyPickProfile(emptyCfg, row);
  assert.equal(applied.ok, true);
  assert.equal(applied.config.browser.profileDir, row.path);
  assert.equal(emptyCfg.browser.profileDir, '', 'the caller\'s config object is not mutated in place');
  // And the inverse: the thing a pick must never be able to do.
  assert.equal(pickProfile({ browser: 'Chrome', name: 'Default' }).ok, false);
  assert.equal(pickProfile({ path: '' }).ok, false);
  assert.equal(applyPickProfile(emptyCfg, { path: '' }).ok, false);
});

vacuously(
  'the picker never offers a row without a path (wrong input: a discovery with an empty entry in it)',
  () => rowProblems(pickerFor(listProfiles(machine), setCfg('')).options),
  () =>
    rowProblems(
      pickerFor(normalizeProfiles([{ browser: 'Chrome', name: 'Default', path: '' }]), setCfg('')).options.concat([
        { browser: 'Chrome', path: '' },
      ]),
    ),
);

// ───────────────────────────────────────────── 4. every consumer reads the same config path

process.stdout.write('\nbrowser target: one config path\n');

const sources = consumerSources().map((c) => ({ file: c.file, id: c.id, symbol: c.symbol, source: fs.readFileSync(c.path, 'utf8') }));

t('the inventory names only real files, and every one of them names the same key', () => {
  const missing = consumerSources().filter((c) => !fs.existsSync(c.path));
  assert.deepEqual(missing.map((c) => c.file), [], 'an inventory naming a moved file is worse than none');
  assert.deepEqual(missingConsumerFiles(), []);
  assert.deepEqual(inventoryKeyProblems(BROWSER_CONSUMERS), []);
  assert.equal(browserProfileKey(), 'browser.profileDir');
});

t('every consumer resolves the key through the shared module (and no module reads it directly)', () => {
  assert.deepEqual(browserConsumerProblems(sources), []);
});

t('the resolver itself is the one place that reads the key, and the page that owns the setting exists', () => {
  const resolved = fs.readFileSync(path.join(ROOT, 'server/src/browser-target.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'web/src/pages/Browser.jsx'), 'utf8');
  assert.deepEqual(
    browserConsumerProblems(sources, {
      // The resolver must really read the key (otherwise every consumer could go through it and get '' for ever)
      resolvers: [{ file: 'server/src/browser-target.js', source: resolved, must: /cfg\?\.browser\?\.profileDir/ }],
      // And the page that owns the setting must be the one that asks the server for the target and renders the
      // per-feature table: a page that merely mentions the word "browser" is not the page this round is about.
      page: { file: 'web/src/pages/Browser.jsx', source: page },
      pageMustMatch: /api\.browserTarget\(\)[\s\S]*browserFeatureStatus/,
    }),
    [],
  );
});

// A.1 — the right answer first: no consumer reads the key itself. If this fails, every control below is
// meaningless (a check that never says "clean" is not a check), so it gets its own named assertion.
const liveProblems = browserConsumerProblems(sources);
t('no consumer in the inventory reads the shared key directly', () => {
  assert.deepEqual(liveProblems, []);
});

// The controls below run the same detector over **deliberately wrong source text**, built here rather than
// mutated out of the live files: the point is to prove the detector fires, and a fixture says exactly what it
// fired on (the live files are covered by the check above).
const GOOD = "import { resolveProfileDir } from './browser-target.js';\nconst d = resolveProfileDir(cfg);\n";
const WRONG_DIRECT = 'const d = cfg.browser.profileDir;\n';
const WRONG_KEY = "import { resolveProfileDir } from './browser-target.js';\nconst d = cfg.browser.cookiesDir;\n";
const WRONG_IMPORT = "import { resolveProfileDir } from './cookies.js';\nconst d = resolveProfileDir(cfg);\n";
/** The detector's answer for one fixture source, as a problems list */
const one = (src) => browserConsumerProblems([{ file: 'server/src/whatever.js', source: src }]);

vacuously(
  'a consumer that reads the key itself is flagged (wrong input: `cfg.browser.profileDir` in the module)',
  () => one(GOOD),
  () => one(WRONG_DIRECT),
);

vacuously(
  'a consumer that lost the shared import is flagged (wrong input: the import from another module)',
  () => one(GOOD),
  () => one(WRONG_IMPORT),
);

t('a settings object named something else is not the shared key (control for the detector\'s precision)', () => {
  // The family is "reads **this key**", not "reads any config": a module reading `settings.cookiesDir` is
  // untouched by the detector, which is why it needs the inventory check instead (asserted below).
  assert.deepEqual(one("import { resolveProfileDir } from './browser-target.js';\nconst d = settings.cookiesDir;\n"), []);
  assert.deepEqual(one(WRONG_KEY), []);
  assert.equal(inventoryKeyProblems([{ id: 'x', file: 'a.js', key: 'browser.cookiesDir' }]).length, 1);
});

t('the direct-read detector tells a read apart from a comment, a string, a longer name and a call', () => {  const fixture = [
    'const a = cfg.browser.profileDir;', // 1: a read
    "const b = cfg?.browser?.profileDir ?? '';", // 2: a read
    '// cfg.browser.profileDir in a comment is prose, not a read',
    "const c = 'cfg.browser.profileDir in a string is not a read';",
    'const d = cfg.browser.profileDirX;',
    'const e = mybrowser.profileDir;',
    'const f = resolveProfileDir(cfg);',
  ].join('\n');
  assert.deepEqual(directProfileReads(fixture), [1, 2]);
  assert.deepEqual(directProfileReads('resolveProfileDir(cfg)'), []);
});

// ───────────────────────────────────────────── 5. the page's per-consumer status

process.stdout.write('\nbrowser target: what the page shows per feature\n');

t('the report is built from the same inventory the structural check reads', () => {
  const report = browserTargetReport(emptyCfg, { fs: machine.fs, roots: machine.roots });
  assert.equal(report.key, browserProfileKey());
  assert.deepEqual(report.consumers.map((c) => c.id), consumerSources().map((c) => c.id));
  for (const c of report.consumers) {
    assert.equal(c.key, browserProfileKey(), `${c.id} must report the one key`);
    assert.ok(typeof c.what === 'object' && c.what.en && c.what.zh, `${c.id} carries its own copy in both languages`);
    assert.ok(typeof c.why === 'object' && c.why.en && c.why.zh, `${c.id} explains why it needs what it needs`);
  }
  assert.deepEqual(report.keyProblems, []);
});

t('with nothing configured, the features that need a profile say so -- and the one that does not stays fine', () => {
  const report = browserTargetReport(emptyCfg, { fs: machine.fs, roots: machine.roots });
  const by = Object.fromEntries(report.consumers.map((c) => [c.id, c]));
  assert.equal(by.scraping.ok, true);
  assert.equal(by.scraping.reason, 'temporary-profile');
  assert.equal(by.loginProbe.ok, false);
  assert.equal(by.loginProbe.reason, 'nothing-configured');
  assert.equal(by.danmaku.reason, 'nothing-configured');
  assert.equal(by.sharePost.reason, 'nothing-configured');
  // The bilibili source reports the other half of the same fact: it is not "nothing is configured" from its
  // point of view (it falls back to browser rendering), it is "the dir it would read is empty". Keeping the
  // two apart is what lets the page say which one a person is looking at.
  assert.equal(by.scrapingLogin.reason, 'profile-is-empty');
});

t('with a profile configured, a dir that exists satisfies every consumer and a dir that does not says why', () => {
  const okReport = browserTargetReport(setCfg(P_DEFAULT), { fs: machine.fs, roots: machine.roots });
  assert.equal(okReport.profile.dir, P_DEFAULT);
  assert.equal(okReport.profile.source, 'configured');
  for (const c of okReport.consumers) {
    assert.equal(c.ok, true, `${c.id} should be satisfied: ${c.reason}`);
    assert.equal(c.reason, c.id === 'scraping' ? 'temporary-profile' : 'profile-resolves');
  }
  const gone = browserTargetReport(setCfg('Q:' + path.sep + 'nope'), { fs: machine.fs, roots: machine.roots });
  assert.equal(gone.consumers.find((c) => c.id === 'loginProbe').reason, 'profile-is-empty');
  assert.equal(gone.consumers.find((c) => c.id === 'loginProbe').ok, false);
});

t('anonymous mode is reported as the reason every login-dependent feature is missing one', () => {
  // The configured browser is named here so that "no profile" below is the switch's doing and not the
  // bundled-Chromium case, which has no default to point at.
  const report = browserTargetReport(
    { browser: { executablePath: exe('Chrome'), profileDir: P_DEFAULT }, privacy: { anonymousMode: true } },
    { fs: machine.fs, roots: machine.roots },
  );
  assert.equal(report.profile.anonymous, true);
  assert.equal(report.profile.dir, '');
  assert.equal(report.profile.configured, P_DEFAULT, 'the stored setting is still reported');
  assert.equal(report.consumers.find((c) => c.id === 'loginProbe').reason, 'anonymous-mode');
  assert.equal(report.consumers.find((c) => c.id === 'danmaku').reason, 'anonymous-mode');
  assert.equal(report.consumers.find((c) => c.id === 'scraping').ok, true, 'scraping does not need a login at all');
});

vacuously(
  'the report cannot claim a feature is fine while the profile it needs is missing (wrong input: a verdict flipped)',
  () => {
    const report = browserTargetReport(emptyCfg, { fs: machine.fs, roots: machine.roots });
    const bad = report.consumers.filter((c) => c.needsProfile && c.ok && !report.profile.dir);
    return bad.length ? [`${bad.map((c) => c.id).join(', ')} reported ready with no profile`] : [];
  },
  () => {
    // The mistake: a row that needs the profile reports ready while the report says there is none.
    const report = browserTargetReport(emptyCfg, { fs: machine.fs, roots: machine.roots });
    const flipped = { ...report, consumers: report.consumers.map((c) => (c.id === 'loginProbe' ? { ...c, ok: true } : c)) };
    const bad = flipped.consumers.filter((c) => c.needsProfile && c.ok && !flipped.profile.dir);
    return bad.length ? [`${bad.map((c) => c.id).join(', ')} reported ready with no profile`] : [];
  },
);

// ───────────────────────────────────────────── 6. the dead end the round is about

process.stdout.write('\nbrowser target: the answer a login check gives when nothing is configured\n');

t('a probe with no profile reports the state (no-profile-configured), not just a bare empty string', async () => {
  const { checkLoginState } = await mod('server/src/share.js');
  const calls = [];
  const r = await checkLoginState(emptyCfg, 'x-post', {
    readCookies: async (dir, domains) => {
      calls.push({ dir, domains });
      return { ok: false, error: '未配置浏览器 profileDir / profileDir is empty' };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'none');
  // The probe was actually asked to read the resolved dir (empty here), and the answer says why it is empty.
  assert.deepEqual(calls, [{ dir: '', domains: ['x.com'] }]);
  assert.equal(r.profileDir, null);
  assert.equal(r.profileSource, 'none');
  assert.equal(r.profileReason, 'no-profile-configured');
});

t('a probe with a configured profile reports the dir it read, so the page can show where it looked', async () => {
  const { checkLoginState } = await mod('server/src/share.js');
  const calls = [];
  const r = await checkLoginState(setCfg(P_DEFAULT), 'x-post', {
    readCookies: async (dir, domains) => {
      calls.push({ dir, domains });
      return { ok: true, names: ['auth_token'], cookieHeader: 'auth_token=x', profile: dir };
    },
  });
  assert.deepEqual(calls.map((c) => c.dir), [P_DEFAULT]);
  assert.equal(r.ok, true);
  assert.equal(r.profileDir, P_DEFAULT);
  assert.equal(r.profileSource, 'configured');
  assert.equal(r.profileReason, null);
});

t('the page side turns that state into a way to the page that fixes it', async () => {
  // The web module is JSX, so it cannot be imported here; the two facts that make the answer actionable are
  // asserted on its source instead: (1) a probe answer with no profile gets an action, (2) the action names
  // the browser tab, which is the page that owns the setting.
  const src = fs.readFileSync(path.join(ROOT, 'web/src/LoginCheck.jsx'), 'utf8');
  assert.match(src, /export function loginCheckAction/, 'the shared mapping must exist');
  assert.match(src, /profileReason === 'no-profile-configured'/, 'the empty setting must be recognised as a state');
  assert.match(src, /tab: 'browser'/, 'the action must point at the page that owns the setting');
  assert.match(src, /export function LoginActionLink/, 'and it must be renderable next to the message');
  const share = fs.readFileSync(path.join(ROOT, 'web/src/pages/Share.jsx'), 'utf8');
  assert.match(share, /<LoginActionLink action=\{r\.loginState\.message\.action\}/, 'the share page must render it next to the login check it just ran');
  const app = fs.readFileSync(path.join(ROOT, 'web/src/App.jsx'), 'utf8');
  assert.match(app, /GOTO_EVENT/, 'the shell must listen for the request');
  assert.match(app, /tab === 'browser' && <Browser \/>/, 'and the browser page must be a tab');
});

// ───────────────────────────────────────────── 7. accounts discovery is injected, not required

await ta('account discovery reports a failure as a failure instead of throwing at the caller', async () => {
  const r = await discoverAccounts(emptyCfg, {
    listAccounts: async () => {
      throw new Error('no sqlite');
    },
  });
  assert.deepEqual(r.accounts, []);
  assert.equal(r.errors.length, 1);
  const withList = await discoverAccounts(emptyCfg, { listAccounts: async () => ({ accounts: [{ id: 'a' }], scanned: 1, errors: [] }) });
  assert.equal(withList.accounts.length, 1);
});

// ───────────────────────────────────────────── result

process.stdout.write('\n' + (fail ? `${fail} failed, ${pass} passed.\n` : `all ${pass} browser-target checks passed.\n`));
process.exit(fail ? 1 : 0);

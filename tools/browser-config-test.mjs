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
import os from 'node:os';
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
  profilesUnder,
  profilesFromIni,
  isFirefoxProfileDir,
  resolveProfileDir,
  resolveProfileTarget,
  configuredProfileDir,
  defaultProfileDir,
  browserFromExecutable,
  pickerFor,
  pickProfile,
  applyPickProfile,
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

// A stand-in machine: one Firefox install root whose `profiles.ini` declares two profiles, plus a second root
// that is installed but declares none — and a fixed filesystem so `present` is a fact of the fixture rather
// than of this computer.
//
// The fixture filesystem can **read**, not only `existsSync`: Firefox names its profiles in `profiles.ini`
// rather than putting them in a fixed set of subdirectories, so the discovery cannot be checked without
// giving it something to parse. The two-argument shape (a file map plus a directory list) is what keeps
// "declared but gone" (a profile the ini names that no longer exists) expressible.
const ROOT_FIREFOX = 'R:' + path.sep + 'ff' + path.sep + 'Mozilla' + path.sep + 'Firefox';
const ROOT_LOCAL = 'R:' + path.sep + 'ff-local';
const P_DEFAULT = path.join(ROOT_FIREFOX, 'Profiles', 'aaaa1111.default-release');
const P_WORK = path.join(ROOT_FIREFOX, 'Profiles', 'bbbb2222.dev');
const INI = path.join(ROOT_FIREFOX, 'profiles.ini');
const EXE_FIREFOX = 'R:' + path.sep + 'pw-browsers' + path.sep + 'firefox-1543' + path.sep + 'firefox' + path.sep + 'firefox.exe';

const PROFILES_INI = [
  '[Install308046B0AF4A39CB]',
  'Default=Profiles/aaaa1111.default-release',
  'Locked=1',
  '',
  '[Profile1]',
  'Name=dev',
  'IsRelative=1',
  'Path=Profiles/bbbb2222.dev',
  '',
  '[Profile0]',
  'Name=default-release',
  'IsRelative=1',
  'Path=Profiles/aaaa1111.default-release',
  'Default=1',
  '',
  '[General]',
  'StartWithLastProfile=1',
  'Version=2',
  '',
].join('\n');

/** A filesystem with exactly the files and directories it was given — and `readFileSync`, which profiles.ini needs */
function fixtureFs(files = {}, dirs = []) {
  const names = new Set(dirs.map(String));
  return {
    existsSync: (p) => names.has(String(p)) || Object.prototype.hasOwnProperty.call(files, String(p)),
    readFileSync: (p) => {
      const key = String(p);
      if (!Object.prototype.hasOwnProperty.call(files, key)) {
        const err = new Error(`ENOENT: ${key}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[key];
    },
  };
}

/** What Firefox leaves in a profile: the store that makes a directory a profile to this project */
const storeOf = (...dirs) => Object.fromEntries(dirs.map((d) => [path.join(d, 'cookies.sqlite'), '']));

const FIX_FS = fixtureFs({ [INI]: PROFILES_INI, ...storeOf(P_DEFAULT, P_WORK) }, [ROOT_FIREFOX, ROOT_LOCAL, P_DEFAULT, P_WORK, EXE_FIREFOX]);

const machine = {
  roots: () => [
    ['Firefox', ROOT_FIREFOX],
    // A second root with no profiles.ini at all: it is still offered, as a row that says "here, but nothing
    // configured" rather than as an absence nobody can act on.
    ['Firefox (local)', ROOT_LOCAL],
  ],
  // The real expansion, against the fixture filesystem: the ini parsing is what this family is about, so a
  // stub that returned a fixed profile list would check nothing.
  profiles: (root) => profilesUnder(root, { fs: FIX_FS }),
  fs: FIX_FS,
};

const emptyCfg = { browser: { mode: 'bundled', executablePath: '', profileDir: '' } };
const setCfg = (dir, extra = {}) => ({ browser: { mode: 'system', executablePath: EXE_FIREFOX, profileDir: dir, ...extra } });

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
  assert.equal(normalizeProfile({ browser: 'Firefox' }), null);
  assert.equal(normalizeProfile({ browser: 'Firefox', name: 'dev', path: '' }), null);
  assert.equal(normalizeProfile({ browser: 'Firefox', name: 'dev', path: '   ' }), null);
  // A path that is not a string is not a path: `42` would otherwise resolve to a file named "42" beside the
  // process, which is a setting nobody asked for dressed up as a discovered profile.
  assert.equal(normalizeProfile({ browser: 'Firefox', name: 'dev', path: 42 }), null);
  assert.equal(normalizeProfile({ browser: 'Firefox', name: 'dev', path: ['x'] }), null);
  assert.deepEqual(normalizeProfiles([{ browser: 'Firefox' }, null, { path: '' }]), []);
});

t('a usable entry carries a digest id (never the path), the browser, the name, and whether it exists here', () => {
  const a = normalizeProfile({ browser: 'Firefox', name: 'default-release', path: P_DEFAULT }, { fs: machine.fs });
  assert.ok(a, 'a path-bearing entry must survive normalisation');
  assert.equal(a.browser, 'Firefox');
  assert.equal(a.name, 'default-release');
  assert.equal(a.path, P_DEFAULT);
  assert.equal(a.absolute, path.resolve(P_DEFAULT));
  assert.equal(a.present, true);
  assert.match(a.id, /^[A-Za-z0-9_-]{16}$/);
  // The id is handed to the client, so it must not be a readable form of the path (BUGS #69 is the precedent)
  assert.ok(!a.id.includes('R:') && !a.id.includes('aaaa1111'), `the id must not carry the path: ${a.id}`);
  assert.equal(a.id, normalizeProfile({ browser: 'x', path: P_DEFAULT }).id, 'the same path must give the same id');
});

t('the discovery reads profiles.ini: every profile it declares, in declaration order, and the root that declares none', () => {
  const { profiles, dropped } = listProfiles(machine);
  const paths = profiles.map((p) => p.absolute);
  // [Install…] Default= names a profile that is *also* declared by [Profile0], so it must not be listed twice.
  assert.deepEqual(paths, [path.resolve(P_WORK), path.resolve(P_DEFAULT), path.resolve(ROOT_LOCAL)]);
  assert.equal(profiles[0].browser, 'Firefox');
  assert.equal(profiles[0].hasProfiles, true);
  assert.equal(profiles[1].hasProfiles, true);
  // The second root has no ini at all: it is still a row, and it says so.
  assert.equal(profiles[2].hasProfiles, false);
  // Nothing on this fixture is unusable, so the refusals are empty rather than an absent field.
  assert.deepEqual(dropped, []);
});

t('the ini parser answers the shape, and answers [] rather than throwing on anything it cannot read', () => {
  const parsed = profilesFromIni(ROOT_FIREFOX, { fs: FIX_FS });
  assert.deepEqual(parsed.map((p) => p.name), ['dev', 'default-release']);
  // The user's own choice (Default=1) and the installation's (Install Default=) are kept apart: they can
  // disagree, and the default the page offers prefers the user's.
  assert.deepEqual(parsed.map((p) => p.isDefault), [false, true]);
  assert.deepEqual(parsed.map((p) => p.isInstall), [false, true]);
  const installOnly = fixtureFs({ [INI]: '[InstallABC]\nDefault=Profiles/x\n\n[Profile0]\nName=x\nPath=Profiles/x\n' }, [ROOT_FIREFOX]);
  assert.deepEqual(profilesFromIni(ROOT_FIREFOX, { fs: installOnly }), [
    { name: 'x', path: path.resolve(ROOT_FIREFOX, 'Profiles/x'), isDefault: false, isInstall: true },
  ]);
  // An absolute Path= is taken as written rather than joined onto the root
  const absolute = fixtureFs({ [INI]: `[Profile0]\nName=y\nIsRelative=0\nPath=${path.resolve('Q:' + path.sep + 'other')}\n` }, [ROOT_FIREFOX]);
  assert.equal(profilesFromIni(ROOT_FIREFOX, { fs: absolute })[0].path, path.resolve('Q:' + path.sep + 'other'));
  // No ini / unreadable / a filesystem that cannot read at all: an empty answer, never a thrown error
  assert.deepEqual(profilesFromIni(ROOT_FIREFOX, { fs: fixtureFs({}, [ROOT_FIREFOX]) }), []);
  assert.deepEqual(profilesFromIni(ROOT_FIREFOX, { fs: { existsSync: () => true } }), []);
  assert.deepEqual(profilesFromIni(ROOT_FIREFOX), [], 'the real machine must not leak into an offline fixture that named no ini');
});

t('a root whose cookie store is a zero-byte placeholder is still a ROOT (measured on this machine)', () => {
  // Measured: a real Firefox root carries empty cookies.sqlite and places.sqlite files left behind by an older
  // layout — this machine's %APPDATA%\Mozilla\Firefox has both. An existence test therefore answers "this root
  // is a profile", the picker offers the root, and the profile inside it is never reached.
  const rootWithStub = fixtureFs({ [INI]: PROFILES_INI, ...storeOf(P_DEFAULT, P_WORK), [path.join(ROOT_FIREFOX, 'cookies.sqlite')]: '' }, [ROOT_FIREFOX, P_DEFAULT, P_WORK]);
  const stubSize = {
    existsSync: rootWithStub.existsSync,
    readFileSync: rootWithStub.readFileSync,
    statSync: (p) => ({ size: String(p) === path.join(ROOT_FIREFOX, 'cookies.sqlite') ? 0 : 4096 }),
  };
  assert.equal(isFirefoxProfileDir(ROOT_FIREFOX, { fs: stubSize }), false, 'a zero-byte store is a placeholder, not a profile');
  assert.deepEqual(profilesUnder(ROOT_FIREFOX, { fs: stubSize }), [P_WORK, P_DEFAULT]);
  // The control, on the same fixture: a store with real content in it *is* a profile, and an ini in the same
  // directory is a stronger statement than any file beside it.
  const realStore = { ...stubSize, statSync: () => ({ size: 4096 }) };
  assert.equal(isFirefoxProfileDir(P_WORK, { fs: realStore }), true);
  assert.equal(isFirefoxProfileDir(ROOT_FIREFOX, { fs: realStore }), false, 'profiles.ini wins over a stray cookie store');
});

t('a profile whose directory is gone is not offered (the picker must not hand out a dead path)', () => {
  // The ini still declares both profiles, but only one of them exists on this fixture's disk.
  const halfGone = fixtureFs({ [INI]: PROFILES_INI, ...storeOf(P_WORK) }, [ROOT_FIREFOX, P_WORK]);
  assert.deepEqual(profilesUnder(ROOT_FIREFOX, { fs: halfGone }), [P_WORK]);
  assert.deepEqual(profilesUnder(ROOT_FIREFOX, { fs: FIX_FS }), [P_WORK, P_DEFAULT]);
  // A root that *is* a profile is its own answer (someone pointed straight at one)
  assert.deepEqual(profilesUnder(P_DEFAULT, { fs: FIX_FS }), [P_DEFAULT]);
  // And a root that neither holds a store nor declares one answers nothing rather than guessing
  assert.deepEqual(profilesUnder(ROOT_LOCAL, { fs: FIX_FS }), []);
});

t('a discovery that refuses an entry says so instead of quietly listing fewer browsers', () => {
  const { profiles, dropped } = listProfiles({ ...machine, roots: () => [['Firefox', ROOT_FIREFOX], ['Firefox', '']] });
  assert.equal(profiles.length, 2, 'the usable rows still come back');
  assert.deepEqual(dropped, [{ browser: 'Firefox', path: '', reason: 'no-path' }]);
  // And the picker folds that refusal into the count the page shows.
  const picker = pickerFor({ profiles, dropped }, setCfg(''));
  assert.deepEqual(picker.unusable, [{ browser: 'Firefox', path: '', reason: 'no-path' }]);
});

vacuously(
  'the discovery refuses an entry with no path, and says that it did (wrong input: a discovery list holding one)',
  () => discoveryProblems(listProfiles(machine)),
  () => discoveryProblems({ profiles: listProfiles(machine).profiles, dropped: [{ browser: 'Firefox', path: '', reason: 'no-path' }] }),
);

t('no injected filesystem means the REAL one, not "nothing exists" (measured: `null` made the default dead)', () => {
  // Found while checking the swap against this machine's real profiles.ini: the app passed `null` down as the
  // filesystem, so every existence test answered false — `present` was always false in the running app and
  // defaultProfileDir() always answered ''. The unit tests injected a filesystem, so neither showed up here.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-real-fs-'));
  const profile = path.join(root, 'Profiles', 'aaaa1111.default');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(root, 'profiles.ini'), '[Profile0]\nName=x\nIsRelative=1\nPath=Profiles/aaaa1111.default\nDefault=1\n');
  fs.writeFileSync(path.join(profile, 'cookies.sqlite'), 'x');
  try {
    const rows = listProfiles({ roots: () => [['Firefox', root]] }).profiles;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].present, true, 'a directory that exists on this disk must be reported as present');
    assert.equal(defaultProfileDir({ browser: {} }, { roots: () => [['Firefox', root]] }), path.resolve(profile));
    assert.equal(resolveProfileTarget({ browser: {} }, { roots: () => [['Firefox', root]] }).default, path.resolve(profile));
    // The control: a filesystem that says nothing exists answers false, so the assertions above are about the
    // real filesystem being used rather than about `present` being hard-coded or the default being invented.
    const blind = { existsSync: () => false };
    assert.equal(listProfiles({ roots: () => [['Firefox', root]], fs: blind }).profiles[0].present, false);
    assert.equal(defaultProfileDir({ browser: {} }, { roots: () => [['Firefox', root]], fs: blind }), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
  // The default is *reported beside* the answer and never substituted into it — an empty setting still
  // resolves to empty, whatever the machine happens to have signed in.
  assert.equal(r.default, path.resolve(P_DEFAULT));
  assert.equal(r.dir, '');
  assert.ok(r.reasons.includes('not-configured'), JSON.stringify(r.reasons));
  assert.equal(resolveProfileDir(emptyCfg, { fs: machine.fs, roots: machine.roots }), '', 'the consumers get the same empty answer');
});

t('the documented default is the profile Firefox itself calls default, in every mode', () => {
  assert.equal(defaultProfileDir(setCfg(''), { fs: machine.fs, roots: machine.roots }), path.resolve(P_DEFAULT));
  // `bundled` is no longer a special case: a Firefox profile belongs to the machine rather than to one
  // executable — measured, Playwright's Firefox opens a profile created by a stock Firefox — so the bundled
  // engine can reuse the login sitting on this machine, and the page must therefore offer it.
  assert.equal(defaultProfileDir(emptyCfg, { fs: machine.fs, roots: machine.roots }), path.resolve(P_DEFAULT));
  assert.equal(defaultProfileDir({ browser: { executablePath: 'C:\\somewhere\\firefox.exe' } }, { fs: machine.fs, roots: machine.roots }), path.resolve(P_DEFAULT)); // sanitize-allow: a synthetic drive path that is deliberately not this machine's, to prove an executable does not decide the profile
  assert.equal(browserFromExecutable(EXE_FIREFOX), 'Firefox');
  assert.equal(browserFromExecutable(''), 'bundled');
  // A Chromium path is no longer a browser this project can drive, so it must not be recognised as one
  // (the picker would otherwise label a path that fails at launch with a browser name it does not have).
  assert.equal(browserFromExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), 'custom');
});

t('a default is never invented: an ini that declares nothing, or names only profiles that are gone, answers empty', () => {
  // The root exists but has no profiles.ini at all
  assert.equal(defaultProfileDir({ browser: {} }, { fs: fixtureFs({}, [ROOT_LOCAL]), roots: () => [['Firefox', ROOT_LOCAL]] }), '');
  // The ini names a profile whose directory no longer exists
  const gone = fixtureFs({ [INI]: '[Profile0]\nName=x\nPath=Profiles/deleted\nDefault=1\n' }, [ROOT_FIREFOX]);
  assert.equal(defaultProfileDir({ browser: {} }, { fs: gone, roots: () => [['Firefox', ROOT_FIREFOX]] }), '');
  // A filesystem that cannot read files must not fall through to the machine's own disk
  assert.equal(defaultProfileDir({ browser: {} }, { fs: { existsSync: () => true }, roots: () => [['Firefox', ROOT_FIREFOX]] }), '');
});

t('the documented default is a *pick*, never a substitution', () => {
  const reported = resolveProfileTarget(emptyCfg, { fs: machine.fs, roots: machine.roots });
  assert.equal(reported.dir, '', 'the resolution must not use the documented default behind the user');
  assert.notEqual(reported.default, '', 'this fixture does have a default, so the check above is not vacuous');
});

vacuously(
  'the documented default stays out of the resolution (wrong input: a resolution that took it)',
  () => {
    const r = resolveProfileTarget(emptyCfg, { fs: machine.fs, roots: machine.roots });
    return r.dir === '' ? [] : [`the resolution used the documented default: ${r.dir}`];
  },
  () => {
    const r = resolveProfileTarget(emptyCfg, { fs: machine.fs, roots: machine.roots });
    const used = { ...r, dir: r.default };
    return used.dir === '' ? [] : [`the resolution used the documented default: ${used.dir}`];
  },
);

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
    const fellBack = { ...resolveProfileTarget(emptyCfg, { fs: machine.fs, roots: machine.roots }), dir: path.resolve(P_DEFAULT) };
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
  // `...\Mozilla\Firefox` (the root profiles.ini lives in) and the profile directory inside it are both
  // acceptable values for the same login store (cookies.js accepts either), so the picker must recognise the
  // setting it is given rather than reporting "nothing selected".
  const b = pickerFor(list, setCfg(''));
  assert.equal(b.selected, null);
  assert.equal(b.options.every((o) => !o.selected), true);
  const c = pickerFor(list, setCfg(P_DEFAULT + path.sep));
  assert.equal(c.selected?.absolute, path.resolve(P_DEFAULT));
});

t('a setting that was not discovered is offered as its own row, so the page can say what is set', () => {
  const configured = 'Q:' + path.sep + 'other' + path.sep + 'Profiles' + path.sep + 'zzzz9999.default';
  const p = pickerFor(listProfiles(machine), setCfg(configured));
  assert.equal(p.options[0].current, true, 'the row from the setting comes first');
  assert.equal(p.options[0].path, configured);
  assert.equal(p.options[0].selected, true);
  assert.equal(p.selected?.current, true);
});

t('an entry with no path is skipped, and the skip is counted rather than silent', () => {
  const p = pickerFor([{ browser: 'Firefox', name: 'Default' }, { browser: 'Firefox', name: 'Default', path: P_DEFAULT }], setCfg(''));
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
  assert.equal(pickProfile({ browser: 'Firefox', name: 'Default' }).ok, false);
  assert.equal(pickProfile({ path: '' }).ok, false);
  assert.equal(applyPickProfile(emptyCfg, { path: '' }).ok, false);
});

vacuously(
  'the picker never offers a row without a path (wrong input: a discovery with an empty entry in it)',
  () => rowProblems(pickerFor(listProfiles(machine), setCfg('')).options),
  () =>
    rowProblems(
      pickerFor(normalizeProfiles([{ browser: 'Firefox', name: 'Default', path: '' }]), setCfg('')).options.concat([
        { browser: 'Firefox', path: '' },
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
  assert.equal(by.sharePost.reason, 'nothing-configured');
  // `shareLoginCheck` is the page's own button, and it goes through the same resolver: "nothing is
  // configured" is the fact both rows report, and keeping them apart is what lets the table show which
  // feature is looking at which resolution. (The `danmaku` and `scrapingLogin` rows were removed with the
  // modules they described: an inventory row naming a file that is gone is worse than no row at all.)
  assert.equal(by.shareLoginCheck.reason, 'nothing-configured');
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
  // The profile is named here so that "no profile" below is the switch's doing and not "nothing was ever
  // configured" — the two states have to stay distinguishable on the page.
  const report = browserTargetReport(
    { browser: { executablePath: EXE_FIREFOX, profileDir: P_DEFAULT }, privacy: { anonymousMode: true } },
    { fs: machine.fs, roots: machine.roots },
  );
  assert.equal(report.profile.anonymous, true);
  assert.equal(report.profile.dir, '');
  assert.equal(report.profile.configured, P_DEFAULT, 'the stored setting is still reported');
  assert.equal(report.consumers.find((c) => c.id === 'loginProbe').reason, 'anonymous-mode');
  assert.equal(report.consumers.find((c) => c.id === 'shareLoginCheck').reason, 'anonymous-mode');
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
  const r = await checkLoginState(emptyCfg, 'reddit-post', {
    readCookies: async (dir, domains) => {
      calls.push({ dir, domains });
      return { ok: false, error: '未配置浏览器 profileDir / profileDir is empty' };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'none');
  // The probe was actually asked to read the resolved dir (empty here), and the answer says why it is empty.
  assert.deepEqual(calls, [{ dir: '', domains: ['reddit.com'] }]);
  assert.equal(r.profileDir, null);
  assert.equal(r.profileSource, 'none');
  assert.equal(r.profileReason, 'no-profile-configured');
});

t('a probe with a configured profile reports the dir it read, so the page can show where it looked', async () => {
  const { checkLoginState } = await mod('server/src/share.js');
  const calls = [];
  const r = await checkLoginState(setCfg(P_DEFAULT), 'reddit-post', {
    readCookies: async (dir, domains) => {
      calls.push({ dir, domains });
      return { ok: true, names: ['auth_token'], cookieHeader: 'auth_token=x', profile: dir }; // sanitize-allow: a fixture value, deliberately cookie-shaped, for the check that proves a cookie value cannot leak out of the resolver
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

// ───────────────────────────────────────────── 7. no login enumeration
//
// The one thing this module used to offer beyond the profile picker was `discoverAccounts()`: it turned
// every discovered profile into an "account" by reading its cookie store for one site and asking that site
// who the credential was. Both halves of that are gone with the site they were about, and what has to hold
// now is the **absence**, because it is the kind of code that comes back through a helper nobody meant to
// keep. The enumeration of browser profiles stays -- it is what the picker and the default are built on --
// and the control below proves that reader still works on an injected machine.

const loginEnumeration = (src) =>
  [
    [/\bdiscoverAccounts\s*\(/, 'the account-discovery entry point'],
    [/readBrowserCookies\s*\(/, 'a read of a browser cookie store'],
    [/whoAmI|isLogin\b/, 'a request that asks a site who a credential is'],
    [/SESSDATA|bili_jct/, 'a platform session cookie name'],
  ]
    .filter(([re]) => re.test(src))
    .map(([, what]) => what);

t('the browser-target module enumerates profiles and no longer enumerates logins', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/src/browser-target.js'), 'utf8');
  const found = loginEnumeration(src);
  assert.deepEqual(found, [], `server/src/browser-target.js still does ${found.join(', ')}`);
  assert.match(src, /export function browserRoots\(/, 'and it must keep the profile enumeration the picker is built on');
  assert.match(src, /export function profilesUnder\(/, 'and the per-root expansion');
});

vacuously(
  'the login-enumeration detector (wrong input: the code it replaced)',
  // Both builders answer with a **problems list**, which is what this file's helper expects: a detector that
  // returned the findings directly would make the control pass on its own right input (the mistake the
  // helper's own comment records).
  () => {
    const found = loginEnumeration(fs.readFileSync(path.join(ROOT, 'server/src/browser-target.js'), 'utf8'));
    return found.length ? [`still does ${found.join(', ')}`] : [];
  },
  () => {
    const found = loginEnumeration('export async function discoverAccounts(cfg) { const ck = await readBrowserCookies(dir, ["x"]); return whoAmI(cfg, ck.cookieHeader); }');
    return found.length ? [`still does ${found.join(', ')}`] : [];
  },
);

await ta('the profile enumeration still reads an injected machine (so the check above is not "the file is empty")', async () => {
  const { listProfiles } = await mod('server/src/browser-target.js');
  const roots = () => [['Firefox', 'C:/ff/Mozilla/Firefox']];
  const profiles = (root) => (root ? ['C:/ff/Mozilla/Firefox/Profiles/aaaa.default'] : []);
  const r = listProfiles({ roots, profiles });
  assert.equal(r.profiles.length, 1);
  assert.equal(r.profiles[0].browser, 'Firefox');
  assert.equal(r.profiles[0].hasProfiles, true);
  // A root that declares no profile is still offered as a reference row, so the page can say "Firefox is
  // here but nothing is configured" instead of showing nothing at all.
  const bare = listProfiles({ roots: () => [['Firefox (local)', 'C:/ff-local']], profiles: () => [] });
  assert.equal(bare.profiles.length, 1);
  assert.equal(bare.profiles[0].hasProfiles, false);
});

// ───────────────────────────────────────────── result

process.stdout.write('\n' + (fail ? `${fail} failed, ${pass} passed.\n` : `all ${pass} browser-target checks passed.\n`));
process.exit(fail ? 1 : 0);

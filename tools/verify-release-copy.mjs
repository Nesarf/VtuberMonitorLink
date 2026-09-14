// tools/verify-release-copy.mjs - check a release copy that tools/make-release.mjs produced.
//
// usage: node tools/verify-release-copy.mjs [--root ../VML-release] [--built <dist directory>]
//
// make-release.mjs does the building, the sanitizing copy and the packaging, and the repository's own
// tools/verify-release.cjs scans the result for secrets, machine paths and private names. What is left
// over is the part a scan cannot answer, because it is about *correspondence* rather than about
// content: does the copy actually leave the development-only layer out, does it carry the source fix
// that was made last, is the packaged UI newer than that fix rather than a reused older bundle, does the
// README's locale count agree with the registry inside the copy, and does the zip on disk still hash to
// what its own SHA256SUMS.txt claims. Those are the questions this answers.
//
// It is deliberately machine-independent: --root points at the copy, --built at the build output, and
// nothing here contains a path from the machine it was written on. Exit 0 means every check passed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const COPY = path.resolve(ROOT, value('--root', '../VML-release'));
const BUILT = path.resolve(ROOT, value('--built', 'dist/VtuberMonitorLink/app/web/dist'));
const SRC = path.join(COPY, 'src');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
  if (!ok) failures++;
};
const info = (message) => console.log(`        ${message}`);

console.log(`verify-release-copy: ${COPY}`);

// 1. The copy is there, and the project's own scanner has nothing to say about it.
check('src exists', fs.existsSync(SRC), SRC);
if (!fs.existsSync(SRC)) {
  console.log('\nverify-release-copy: nothing to check');
  process.exit(1);
}
const scan = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'verify-release.cjs'), '--dir', SRC, '--scan-only'], {
  encoding: 'utf8',
});
const scanTail = String(scan.stdout ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '(no output)';
check('release scanner reports no problems', scan.status === 0, scanTail.trim());

// 2. What must not be in the copy: the worker layer (development tree only) and the machine-local
//    overlay, whose entire content is this computer's interpreter paths.
check('no workers/ directory', !fs.existsSync(path.join(SRC, 'workers')), 'the worker layer does not ship yet');
const strayOverlay = [];
const walk = (dir, onFile) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full, entry.name);
  }
};
walk(SRC, (full, name) => {
  if (name === 'registry.local.json' || /^(_debug|tmp_fuzz|_jconsole)/.test(name) || name === '__pycache__') strayOverlay.push(full);
});
check('no machine-local overlay or scratch names', strayOverlay.length === 0, strayOverlay.length ? strayOverlay.slice(0, 3).join('; ') : 'clean');

// 3. The last source-level fix must be inside the copy, and the packaged bundle must actually carry it.
//
//    The content check is the one that decides, because it asks the question that matters: is the fix in
//    the artifact? The mtime comparison is printed but does not fail, and the reason is a lesson from
//    this check's own first run: writing a file back unchanged - a control experiment restoring what it
//    planted - makes a source file look newer than a bundle that already contains it, so a hard mtime
//    gate cries wolf. Content cannot.
const FIX_FILE = path.join('web', 'src', 'pages', 'Calendar.jsx');
const copiedFix = path.join(SRC, FIX_FILE);
const repoFix = path.join(ROOT, FIX_FILE);
if (fs.existsSync(copiedFix) && fs.existsSync(repoFix)) {
  const text = fs.readFileSync(copiedFix, 'utf8');
  check('the calendar fix is in the copy', /weekStart/.test(text) && /useI18n/.test(text), FIX_FILE);

  // The calendar decision, compiled into whatever the build produced: `calendar: 'gregory'` survives
  // minification because it is a string value, so its absence means the bundle predates the fix.
  const bundles = fs.existsSync(BUILT)
    ? fs.readdirSync(BUILT, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && /\.js$/.test(e.name))
    : [];
  const withPin = bundles.filter((e) => fs.readFileSync(path.join(e.parentPath ?? BUILT, e.name), 'utf8').includes('gregory'));
  check(
    'the packaged bundle carries the calendar decision',
    withPin.length > 0,
    withPin.length ? `${withPin.map((e) => e.name).join(', ')} contains "gregory"` : `no .js under ${BUILT} contains it`,
  );

  const newestBuilt = bundles.length
    ? Math.max(...bundles.map((e) => fs.statSync(path.join(e.parentPath ?? BUILT, e.name)).mtimeMs))
    : 0;
  const newestSource = (() => {
    let newest = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(jsx?|css|html)$/.test(entry.name)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    };
    walk(path.join(ROOT, 'web', 'src'));
    return newest;
  })();
  info(
    newestBuilt >= newestSource
      ? `bundle ${new Date(newestBuilt).toISOString()} is newer than the newest web/src file (${new Date(newestSource).toISOString()})`
      : `note: the newest web/src file is newer than the bundle (${new Date(newestSource).toISOString()} vs ${new Date(newestBuilt).toISOString()}) - rebuilding the UI would settle it, and a file written back unchanged also lands here`,
  );
} else {
  check('the calendar fix is in the copy', false, `${FIX_FILE} missing on one side (copy: ${fs.existsSync(copiedFix)}, repo: ${fs.existsSync(repoFix)})`);
}

// 4. The README's locale count against the registry inside the copy, imported from the copy itself.
const readmePath = path.join(SRC, 'README.md');
const localesIndex = path.join(SRC, 'web', 'src', 'locales', 'index.js');
if (fs.existsSync(readmePath) && fs.existsSync(localesIndex)) {
  const declared = Number((fs.readFileSync(readmePath, 'utf8').match(/\*\*(\d+) locales\*\*/) ?? [])[1] ?? -1);
  let actual = -1;
  try {
    const mod = await import(pathToFileURL(localesIndex).href);
    actual = Object.keys(mod.LOCALES ?? {}).length;
  } catch (error) {
    info(`could not import the copy's registry: ${error.message}`);
  }
  check('README locale count matches the copy', declared > 0 && declared === actual, `README says ${declared}, the copy's registry has ${actual}`);
} else {
  check('README locale count matches the copy', false, 'README.md or web/src/locales/index.js missing');
}

// 5. The current version's package, and whether it still hashes to what it says.
const version = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version;
const versionDir = path.join(COPY, 'releases', version);
const zips = fs.existsSync(versionDir) ? fs.readdirSync(versionDir).filter((n) => n.endsWith('.zip')) : [];
if (!zips.length) {
  check(`releases/${version} has a zip`, false, `nothing under ${versionDir}`);
} else {
  const zip = path.join(versionDir, zips[0]);
  const size = fs.statSync(zip).size;
  check(`releases/${version} has a zip`, true, `${zips[0]}, ${(size / 1048576).toFixed(1)} MB, built ${fs.statSync(zip).mtime.toISOString()}`);
  const sumsFile = path.join(versionDir, 'SHA256SUMS.txt');
  if (fs.existsSync(sumsFile)) {
    const line = fs.readFileSync(sumsFile, 'utf8').split('\n').find((l) => l.includes(zips[0]));
    const claimed = line?.trim().split(/\s+/)[0] ?? '';
    const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    check('the zip hashes to its SHA256SUMS.txt', claimed.toLowerCase() === actual, claimed ? `${claimed.slice(0, 16)}...` : 'no line for this zip');
  } else {
    check('the zip hashes to its SHA256SUMS.txt', false, 'SHA256SUMS.txt missing');
  }
  const manifestName = zips[0] + '.manifest.json';
  const manifestPath = path.join(versionDir, manifestName);
  let files = -1;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    files = (manifest.files ?? []).length;
  }
  check('the package has a manifest with files', files > 100, files >= 0 ? `${files} entries` : 'manifest missing');
}

console.log('');
if (failures === 0) {
  console.log('verify-release-copy: every check passed');
  process.exit(0);
}
console.log(`verify-release-copy: ${failures} check(s) failed`);
process.exit(1);

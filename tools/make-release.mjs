// make-release.mjs — build the public release tree / build the public release tree
//
// Target artifacts (default <sibling of the project>/VML-release, overridable with --out):
//
//   <out>/
//     README.md               <- public description (carries no local machine info)
//     PUBLISH-TO-GITHUB.md    <- the step-by-step commands for pushing to GitHub
//     src/ …                  <- the **complete, sanitized copy of the project** (can be git init'd and pushed directly)
//     releases/<version>/
//         VtuberMonitorLink-<version>-win-x64.zip
//         *.zip.manifest.json   <- the in-package file listing (release verification asserts "no runtime data" against it)
//         SHA256SUMS.txt
//         RELEASE-NOTES.md
//
// Sanitization here is a **hard gate**, not a best effort:
//   · runtime data (config.json / reports / feeds / logs / watch / thumbs / advice) never enters the copy
//   · .git / node_modules / build / dist do not enter the copy
//   · as soon as the copy is written it is re-scanned with the project's own scanner (tools/verify-release.cjs --scan-only --dir),
//     and any secret, absolute path, private name or harness marker -> the whole release aborts (exit code 1)
//   · the release zip's manifest is asserted too: any runtime data present aborts as well
//
// Note: this file **hardcodes no local path** -- the default output directory is derived from the VML_RELEASE_OUT
// environment variable or from the directory next to the project. A hardcoded drive letter is itself exactly what
// sanitization has to catch (and the scanner really would catch it).
//
//   node tools/make-release.mjs [--out <dir>] [--skip-copy]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {
  out: process.env.VML_RELEASE_OUT || path.join(path.dirname(ROOT), 'VML-release'),
  copy: true,
};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i]);
  else if (process.argv[i] === '--skip-copy') args.copy = false;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const log = (s) => process.stdout.write(s + '\n');
const problems = [];

// Things that never enter the public copy. The first three classes are runtime data (including secrets), the rest are development intermediates and local machine leftovers.
const NEVER_COPY = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'logs',
  'reports',
  'feeds',
  'watch',
  'thumbs',
  'advice',
  'pw-browsers',
  '.sanitize-names',
  'config.json',
  'coverage',
  '.vite',
  '.cache',
  '.cache',
]);
// The "example paths" allowed to appear (the kind the docs tell others to fill in); the scan lets them through
const EXAMPLE_PATH_HINTS = [/E:\\\\YourCache/, /E:\\YourCache/];

function copyTree(src, dst) {
  let files = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (NEVER_COPY.has(e.name)) continue;
    if (e.name.endsWith('.local.json') || e.name.endsWith('.local')) continue;
    if (e.name === '.env' || e.name.startsWith('.env.')) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      files += copyTree(from, to);
    } else if (e.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      files++;
    }
  }
  return files;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ───────────────────────────────────────────── 0. preconditions

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outRoot = args.out;
const srcOut = path.join(outRoot, 'src');
const relOut = path.join(outRoot, 'releases', version);

log(`\nrelease tree / release tree: ${outRoot}`);
log(`version / version: ${version}\n`);

const zipName = `VtuberMonitorLink-${version}-win-x64.zip`;
const zipPath = path.join(ROOT, 'dist', zipName);
const manifestPath = zipPath + '.manifest.json';
if (!fs.existsSync(zipPath)) {
  log('  ! no release package yet -- run node tools/build-portable.cjs first');
} else {
  log(`  ok found release package ${zipName} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ───────────────────────────────────────────── 1. copy the sanitized tree

if (args.copy) {
  log('\n[1/5] copying the sanitized project tree');
  fs.rmSync(srcOut, { recursive: true, force: true });
  fs.mkdirSync(srcOut, { recursive: true });
  const n = copyTree(ROOT, srcOut);
  log(`  -> ${rel(srcOut)} (${n} files)`);
  for (const skip of [...NEVER_COPY].sort()) log(`     excluding ${skip}`);
}

// ───────────────────────────────────────────── 2. re-scan with the project's own scanner

log('\n[2/5] sanitization scan (using the project\'s own verifier --scan-only)');
const scan = spawnSync(
  process.execPath,
  [path.join(ROOT, 'tools', 'verify-release.cjs'), '--scan-only', '--dir', srcOut],
  { encoding: 'utf8' }
);
const scanOut = (scan.stdout ?? '') + (scan.stderr ?? '');
for (const line of scanOut.split(/\r?\n/)) {
  if (/PROBLEM|problem\(s\)|note:/.test(line)) log('  ' + line.trim());
}
if (scan.status !== 0) {
  problems.push('the sanitization scan did not pass (see above) -- release aborted');
} else {
  log('  ok no secrets, absolute paths, private names or harness markers');
}

// ───────────────────────────────────────────── 3. release package + checksums

log('\n[3/5] assembling releases/');
fs.mkdirSync(relOut, { recursive: true });
if (fs.existsSync(zipPath)) {
  fs.copyFileSync(zipPath, path.join(relOut, zipName));
  if (fs.existsSync(manifestPath)) {
    const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Hard assertion: the package must not contain runtime data (config.json holds the API key, past reports are private)
    const bad = (man.files ?? []).filter((f) => /^app\/(config\.json|reports|feeds|logs|watch|thumbs|advice)(\/|$)/.test(f));
    if (bad.length) {
      problems.push(`runtime data appeared in the release package: ${bad.slice(0, 5).join(', ')}`);
    } else {
      log(`  ok ${man.files.length} files in the package, no runtime data (${man.excluded.length} items excluded)`);
    }
    fs.copyFileSync(manifestPath, path.join(relOut, path.basename(manifestPath)));
  } else {
    problems.push('the zip manifest (.manifest.json) is missing -- the package contents cannot be asserted, release aborted');
  }
}

const sums = [];
for (const f of fs.readdirSync(relOut).filter((f) => !f.endsWith('SHA256SUMS.txt'))) {
  sums.push(`${sha256(path.join(relOut, f))}  ${f}`);
}
fs.writeFileSync(path.join(relOut, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
log(`  -> ${rel(relOut)} (${fs.readdirSync(relOut).length} files + SHA256SUMS.txt)`);

// ───────────────────────────────────────────── 4. public documentation and release steps

log('\n[4/5] public documentation');
// The division of labour must be stated in the most obvious place: this directory is a **frozen release snapshot**, not a development tree.
// Editing code in the copy and then finding "my change had no effect" is an easy one-time mistake to make.
fs.writeFileSync(
  path.join(outRoot, 'README-FIRST.md'),
  `# What this directory is

**A public release snapshot, not a development tree.** Do not edit code here -- edits are not merged back, and the next regeneration overwrites them.

  · Development happens in: \`<the place where you cloned the project>\` (this file is generated by tools/make-release.mjs and carries no local machine path)
  · This directory holds **only things that can be published as they are**: the sanitized copy of the project + the official release package
  · Regenerate it (one command, run in the development tree):

        node tools/make-release.mjs --out <this directory>

  · Generation runs the sanitization scan automatically (secrets / local absolute paths / private names / harness markers);
    if any single item fails, the **whole run aborts** rather than producing a half-finished tree
  · The release package is in \`releases/<version>/\`, with the zip, the in-package manifest, SHA256SUMS and the release notes

## Directory layout

    src/                     the sanitized copy of the project (the whole directory can be git init'd and pushed to GitHub)
    releases/<version>/      the official release package (zip + manifest + SHA256SUMS + RELEASE-NOTES.md)
    PUBLISH-TO-GITHUB.md     the step-by-step commands for pushing to GitHub
    README.md                the outward-facing description, same as the project's

## Confirm before publishing

1. \`npm run verify\` has run in the **development tree** (integrity, coverage ratchet, seven self-check suites, release verification) and is fully green
2. \`npm run sanitize-check\` is clean
3. The API key in the local \`config.json\` is in no file that is about to be uploaded (the script asserts this in both the copy and the packaging step)
`,
  'utf8',
);

const publishDoc = `# Publishing to GitHub

This directory is the \`sanitized copy of the project\`: it holds **no** runtime data (the API key in
config.json, past reports, logs, browser login sessions) and no development intermediates. The whole
directory can be pushed as it is.

## One-time preparation

    cd ${outRoot}\\src
    git init
    git add -A
    git -c user.name="<your name>" -c user.email="<your email>" commit -m "Vtuber's Monitor Link ${version}"
    git branch -M main
    git remote add origin https://github.com/<your account>/<your repository>.git
    git push -u origin main

## Publishing an official release

    # tag it (the version number has to match package.json)
    git tag -a v${version} -m "v${version}"
    git push origin v${version}

After the tag is pushed, GitHub Actions (.github/workflows/release.yml) automatically:
installs dependencies -> runs the self-checks (integrity / calendar / push / release verification) -> builds the portable exe -> creates the Release and attaches the zip.

## Publishing by hand (no Actions, or you want to upload it yourself)

On the GitHub web page: Releases -> Draft a new release -> pick the tag -> drag in
\`releases\\${version}\\${zipName}\`
and paste the body from \`releases\\${version}\\RELEASE-NOTES.md\`.

## Confirm once more before publishing

1. \`npm run verify\` is fully green (integrity checks, Traditional Chinese entry freshness, calendar and push self-checks)
2. \`npm run sanitize-check\` is clean
3. \`releases\\${version}\\SHA256SUMS.txt\` and the zip are in the same release, so users can verify them
4. The API key in the local \`config.json\` is **not** in any file that is about to be uploaded (this script asserts it in both the copy and the packaging step)
`;
fs.writeFileSync(path.join(outRoot, 'PUBLISH-TO-GITHUB.md'), publishDoc, 'utf8');

const releaseNotes = `# Vtuber's Monitor Link ${version}

## What this version does

- **Anniversary countdown calendar**: birthdays / debut days / 3D reveals / anniversaries. A leap day (2/29)
  rolls over to 3/1 in common years and is marked in the interface; "today" is computed in the time zone you
  configured (set Asia/Tokyo when watching a Japanese group); the month grid's week start follows the region
  (HK, TW, JP, KR and US start on Sunday; China and Europe on Monday). The daily report lists the anniversaries
  of the next 30 days at its very top.
- **More push channels**: adds DingTalk (with HMAC signing), WeCom, ntfy, Gotify, PushPlus and Slack,
  12 in total; adds **quiet hours** (midnight crossing handled correctly; notifications raised during quiet
  hours are queued and re-sent once quiet hours end, **never dropped**; urgent ones are exempt by default;
  a broken configuration fails open) and **deduplication**.
- **Automatic egress matching per site**: scores direct or proxy by "effective latency = mean latency × (1 + loss × 4)"
  and picks one, with stickiness (no switch below a 20% edge); real fetch results feed the decision back, and a
  site that keeps failing switches egress automatically.
- **Interface globalization**: 25 regions to choose from (including regional variants: en-US/GB/AU/CA,
  zh-Hans/Hant/HK/TW, es-ES/419/MX/AR, pt-PT/BR, fr-FR/CA, de/ja/ko/it/ru/uk/pl/sr/ar), RTL support, and
  dates / numbers / relative time / week start formatted per region.
- **The daily report outputs .html by default** (VSCode can preview it directly), while the .json source is
  kept for export and search.
- Long lists start collapsed, the save status stays visible, and one click re-sends queued notifications.

## Installation

Unpack it and run \`VtuberMonitorLink.exe\` directly; the browser opens the local interface (by default
\`http://127.0.0.1:43110\`). It needs no Node.js installation and reports no data over the network.

Full details are in \`README.md\` and \`docs/\`.
`;
fs.writeFileSync(path.join(relOut, 'RELEASE-NOTES.md'), releaseNotes, 'utf8');

if (fs.existsSync(path.join(srcOut, 'README.md'))) {
  fs.copyFileSync(path.join(srcOut, 'README.md'), path.join(outRoot, 'README.md'));
}
log('  -> PUBLISH-TO-GITHUB.md, releases/' + version + '/RELEASE-NOTES.md');

// ───────────────────────────────────────────── 5. result

log('\n[5/5] result');
if (problems.length) {
  for (const p of problems) log('  PROBLEM: ' + p);
  log(`\n${problems.length} problems -- release aborted, fix them and re-run.\n`);
  process.exit(1);
}
log(`  ok release directory is ready: ${outRoot}`);
log('    next step: read PUBLISH-TO-GITHUB.md\n');

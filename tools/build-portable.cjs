// tools/build-portable.cjs - build the portable Windows/Linux/macOS release.
//
// ASCII only, CommonJS, no external build tooling beyond Node + npx.
//
//   node tools/build-portable.cjs [options]
//
//   --out <dir>        output root            (default <repo>/dist)
//   --name <name>      package folder / exe   (default VtuberMonitorLink)
//   --no-exe           do not build a launcher binary at all: ship launcher/ plus a bundled
//                      runtime/node.exe instead of the SEA exe (implies --with-runtime).
//                      This is the layout `npm run build:portable` uses.
//   --skip-sea         do not rebuild the SEA launcher, reuse build/ exe
//   --no-install       do not run npm install for app/server
//   --with-runtime     also bundle runtime/node.exe (with the SEA exe this is optional, because
//                      the exe can run the server in-process, but it doubles the package size)
//   --with-browsers    also run `playwright install firefox` into pw-browsers/
//                      (Firefox is the only engine this project ships: the bundled browser is
//                       Playwright's Firefox, and the Chromium payload is gone)
//
// Output layout (default, `--no-exe`):
//
//   dist/VtuberMonitorLink/
//     launcher/                 <- double-click launch.cmd (Windows) or launch.sh
//     runtime/node.exe          <- the bundled Node runtime the launcher spawns
//     package.json              <- version source for the launcher
//     README.txt                <- ASCII quickstart
//     app/                      <- the application itself
//       server/src/...  server/node_modules/...  web/dist/...
//       config.json             <- created on first save (gitignored)
//
// Output layout (with the SEA launcher, i.e. no --no-exe):
//
//   dist/VtuberMonitorLink/
//     VtuberMonitorLink.exe     <- SEA single-file launcher + app runner
//     package.json  README.txt  app/   (and runtime/ only if --with-runtime was given)
//
// Why `--no-exe` is the shipped layout: the SEA step was measured at about 220 s of a 304 s
// build - the single most expensive stage - and what it produced was a second copy of a Node
// runtime (89 MB) whose only job was to load `launcher/launch.cjs`, which the package can carry
// and run directly. Dropping it removes a build stage and one whole class of failure (a locked
// or half-written exe, BUGS #13/#27) without removing a single feature.
//
// Every stage prints its own elapsed time: "each build costs ten-plus minutes" is a complaint
// that deserves a number per stage rather than one number for the whole run.

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const { resolveLaunch, launchCandidates } = require('./launch-target.cjs');

function log(msg) {
  process.stdout.write(msg + '\n');
}

// Stage clock. The build took about 304 s before this existed and nobody could say which part of
// it was the expensive one until it was measured by hand; a per-stage number is the difference
// between "the build is slow" and "the SEA step is 220 s of a 304 s build".
const STAGES = 9;
let stageStart = Date.now();
function stage(n, title) {
  if (n > 1) log('       (' + ((Date.now() - stageStart) / 1000).toFixed(1) + 's in the previous stage)');
  stageStart = Date.now();
  log('[' + n + '/' + STAGES + '] ' + title);
}

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'dist'), name: 'VtuberMonitorLink', exe: true, sea: true, install: true, browsers: false, runtime: false, zip: true, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--name') out.name = String(argv[++i] || '').trim() || out.name;
    else if (a === '--no-exe') {
      // One flag, three consequences, stated here rather than spread over the file: no launcher
      // binary, no SEA step, and therefore a bundled runtime is not optional any more (without
      // one there would be nothing left that can start the app).
      out.exe = false;
      out.sea = false;
      out.runtime = true;
    } else if (a === '--skip-sea') out.sea = false;
    else if (a === '--no-install') out.install = false;
    else if (a === '--with-runtime') out.runtime = true;
    else if (a === '--with-browsers') out.browsers = true;
    else if (a === '--no-zip') out.zip = false;
    else if (a === '--fresh') out.fresh = true;
    // Authenticode-sign the launcher, naming the certificate by thumbprint. Off by default so a
    // developer build is not signed by accident: a signature is a claim about who made a file, and it
    // should be made deliberately. The signing happens in stage 2, between the SEA step and the
    // packing, because a manifest and a SHA256SUMS that describe an unsigned exe are both wrong the
    // moment a signature is appended afterwards.
    else if (a === '--sign') out.sign = String(argv[++i] || '').trim();
    else if (a === '--sign-tool') out.signTool = path.resolve(String(argv[++i] || ''));
    else if (a === '--sign-python') out.signPython = String(argv[++i] || 'python');
    else if (a === '--sign-ledger') out.signLedger = path.resolve(String(argv[++i] || ''));
  }
  return out;
}

/**
 * Every Node child this build starts gets a heap cap.
 *
 * Measured, and the reason is not a guess: Windows' Resource-Exhaustion-Detector logged four events between 04:39
 * and 05:06 in which a **single short-lived node process committed about 40 GB** - created 21:05:36, reported at
 * 21:06:06, 181 handles, so it was one burst of allocation rather than a leak. System commit reached 58.8 of a
 * 59.0 GB limit, physical memory 16.7 of 17.0 GB, and Chrome was killed to keep the machine alive. A build is the
 * heaviest thing this repository does, so the build caps what it starts: an OOM in a child is a failed build with
 * a stack trace, which is a much better outcome than the whole desktop going down.
 *
 * This is a cap, not a diagnosis. The event gives a pid and a size and no command line, and the process is gone by
 * the time anyone reads it - so naming the culprit still needs a watcher running while it happens.
 */
const NODE_HEAP_CAP_MB = 4096;

function run(cmd, args, opts) {
  log('  $ ' + [cmd].concat(args).join(' '));
  const options = Object.assign({ stdio: 'inherit', cwd: ROOT }, opts || {});
  if (cmd === process.execPath && !args.some((a) => String(a).startsWith('--max-old-space-size'))) {
    args = ['--max-old-space-size=' + NODE_HEAP_CAP_MB].concat(args);
  }
  // Node 20+ refuses to spawn .cmd/.bat without a shell (EINVAL), which is how
  // npx/npm/postject shims are exposed on Windows.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) options.shell = true;
  const res = spawnSync(cmd, args, options);
  if (res.error) throw new Error(cmd + ' failed: ' + res.error.message);
  if (res.status !== 0) throw new Error(cmd + ' exited with ' + res.status);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Prefer npm's own CLI entry over the .cmd shim: no shell, no EINVAL/DEP0190. */
function npmCliPath() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function runNpm(args, opts, attempts) {
  const tries = attempts || 2;
  const cli = npmCliPath();
  // When this build is itself started by `npm run`, the parent npm exports its
  // whole config as npm_config_* environment variables. npm reads those back as
  // command-line-equivalent flags, and a user-level `allow-scripts=<list>` then
  // aborts a project-scoped install with EALLOWSCRIPTS. Drop that one so the
  // build behaves the same however it was launched.
  const env = Object.assign({}, (opts && opts.env) || process.env);
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const options = Object.assign({}, opts, { env: env });

  for (let i = 1; i <= tries; i++) {
    try {
      if (cli) run(process.execPath, [cli].concat(args), options);
      else run(NPM, args, options);
      return;
    } catch (err) {
      // Package installation is the one step that talks to a registry, so it is
      // the one step that can fail for reasons that have nothing to do with us.
      if (i === tries) throw err;
      log('  npm failed (' + err.message + ') - retrying once');
    }
  }
}

/** Recursive copy that ignores a predicate. */
function copyDir(src, dst, ignore) {
  const skip = ignore || (() => false);
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (skip(from, entry)) continue;
    if (entry.isDirectory()) copyDir(from, to, skip);
    else if (entry.isSymbolicLink()) {
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch (e) {
        fs.copyFileSync(from, to);
      }
    } else fs.copyFileSync(from, to);
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/** Bytes on disk under one directory (used to report the bundled-engine payload) */
function dirBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

// The quickstart shipped in the package. Two variants on purpose: the shipped layout has no
// launcher binary, so a README that says "double-click VtuberMonitorLink.exe" would be describing
// a file that is not in the zip - the one kind of documentation error a user cannot work around.
const README_TXT_LAUNCHER = [
  "Vtuber's Monitor Link",
  '=====================',
  '',
  'A local web console that collects VTuber intelligence from public sources,',
  'analyzes it with your own LLM API key, and writes dated reports on disk.',
  '',
  'QUICK START',
  '-----------',
  '  1. Double-click launcher\\launch.cmd   (Windows)',
  '     or run          launcher/launch.sh  (Linux / macOS)',
  '  2. Your browser opens http://127.0.0.1:43110 automatically.',
  '  3. Open "Settings": paste your LLM API key and pick a browser.',
  '  4. Open "Sources": choose which sites to crawl and whether each needs login.',
  '  5. Open "Run" and press Start.',
  '',
  'COMMAND LINE',
  '------------',
  '  launcher\\launch.cmd --help      show all options',
  '  launcher\\launch.cmd --doctor    check this installation',
  '  launcher\\launch.cmd --paths     print the resolved paths',
  '  launcher\\launch.cmd --port 8080 use another port',
  '  launcher\\launch.cmd --no-open   do not open a browser',
  '',
  'WHAT IS WRITTEN WHERE',
  '---------------------',
  '  app/config.json   your settings (API key included - keep it private)',
  '  app/reports/      generated reports',
  '  app/feeds/        raw fetched content',
  '  app/logs/         run logs',
  '',
  'PRIVACY',
  '-------',
  '  This package ships no account, cookie, token, or API key.',
  '  Everything runs on 127.0.0.1 and only talks to the sites you enable',
  '  plus the LLM endpoint you configure. Login state is only ever reused',
  '  from the browser profile you point it at.',
  '',
  'REQUIREMENTS',
  '------------',
  '  Windows 10/11 (x64). No installer, no admin rights, no Node.js install:',
  '  runtime\\node.exe is included.',
  '  Keep launcher\\, runtime\\ and app\\ together - launch.cmd starts the',
  '  server from app\\ using runtime\\node.exe. The whole folder may be moved',
  '  or renamed freely, but the parts have to stay together.',
  '  For browser-rendered sources, either let it use its own Firefox',
  '  (Settings > Browser > bundled, one-time download) or point it at an',
  '  already installed Firefox.',
  '',
].join('\r\n');

/** The same quickstart for the SEA layout, still built by --skip-sea for existing users. */
const README_TXT_EXE = [
  "Vtuber's Monitor Link",
  '=====================',
  '',
  'A local web console that collects VTuber intelligence from public sources,',
  'analyzes it with your own LLM API key, and writes dated reports on disk.',
  '',
  'QUICK START',
  '-----------',
  '  1. Double-click VtuberMonitorLink.exe (or run it from a terminal).',
  '  2. Your browser opens http://127.0.0.1:43110 automatically.',
  '  3. Open "Settings": paste your LLM API key and pick a browser.',
  '  4. Open "Sources": choose which sites to crawl and whether each needs login.',
  '  5. Open "Run" and press Start.',
  '',
  'COMMAND LINE',
  '------------',
  '  VtuberMonitorLink.exe --help      show all options',
  '  VtuberMonitorLink.exe --doctor    check this installation',
  '  VtuberMonitorLink.exe --paths     print the resolved paths',
  '  VtuberMonitorLink.exe --port 8080 use another port',
  '  VtuberMonitorLink.exe --no-open   do not open a browser',
  '',
  'WHAT IS WRITTEN WHERE',
  '---------------------',
  '  app/config.json   your settings (API key included - keep it private)',
  '  app/reports/      generated reports',
  '  app/feeds/        raw fetched content',
  '  app/logs/         run logs',
  '',
  'PRIVACY',
  '-------',
  '  This package ships no account, cookie, token, or API key.',
  '  Everything runs on 127.0.0.1 and only talks to the sites you enable',
  '  plus the LLM endpoint you configure. Login state is only ever reused',
  '  from the browser profile you point it at.',
  '',
  'REQUIREMENTS',
  '------------',
  '  Windows 10/11 (x64). No installer, no admin rights, nothing to set up:',
  '  VtuberMonitorLink.exe embeds its own Node.js runtime.',
  '  Keep the exe and the app/ folder together - the exe loads the console',
  '  from app/. You may move or rename the whole folder freely, but a lone',
  '  copy of the exe has nothing to run.',
  '  For browser-rendered sources, either let it use its own Firefox',
  '  (Settings > Browser > bundled, one-time download) or point it at an',
  '  already installed Firefox.',
  '',
].join('\r\n');

function main() {
  const BUILD_START = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const pkgDir = path.join(args.out, args.name);
  const appDir = path.join(pkgDir, 'app');
  const buildDir = path.join(ROOT, 'build');

  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  log('');
  log("Vtuber's Monitor Link - portable build");
  log('  repo    : ' + ROOT);
  log('  output  : ' + pkgDir);
  log('  version : ' + rootPkg.version);
  log('  node    : ' + process.version + ' (' + process.execPath + ')');
  log('  layout  : ' + (args.exe ? 'SEA launcher binary' : 'launcher/ + bundled runtime (no exe)'));
  log('');

  // ------------------------------------------------------------------ 1. web
  stage(1, 'web UI build');
  const distIndex = path.join(ROOT, 'web', 'dist', 'index.html');
  // "Reusing the old artifacts" is a trap: you change the UI but forget to run npm run build
  // first, and the package still contains the old bundle — while the build log looks perfectly
  // normal (this project has been bitten by that "changed but the artifacts did not" class once,
  // see BUGS #27).
  // So compare timestamps before reusing: if the sources are newer than the artifacts, rebuild.
  function newestMtime(dir, acc = 0) {
    let newest = acc;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) newest = newestMtime(p, newest);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
    return newest;
  }
  const srcNewest = Math.max(
    newestMtime(path.join(ROOT, 'web', 'src')),
    fs.statSync(path.join(ROOT, 'web', 'index.html')).mtimeMs,
    fs.statSync(path.join(ROOT, 'web', 'vite.config.js')).mtimeMs,
  );
  const distMtime = fs.existsSync(distIndex) ? fs.statSync(distIndex).mtimeMs : 0;
  const stale = !fs.existsSync(distIndex) || srcNewest > distMtime;
  if (stale) {
    if (fs.existsSync(distIndex)) {
      log('  web/src is newer than web/dist -> rebuilding (otherwise the packaged UI stays stale)');
    }
    run(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'web/vite.config.js']);
  } else {
    log('  reusing existing web/dist (up to date; delete it to force a rebuild)');
  }

  // ------------------------------------------------------------------ 2. SEA
  stage(2, 'SEA launcher');
  const exeName = args.name + EXE;
  const exeOut = path.join(pkgDir, exeName);
  fs.mkdirSync(pkgDir, { recursive: true });

  if (!args.exe) {
    // A launcher binary left behind by an earlier build must not survive into the zip: the package
    // would then contain both layouts, the traversals would start it as the exe layout, and the
    // launcher layout - the one this package is supposed to be - would go unexercised.
    if (fs.existsSync(exeOut)) {
      rmrf(exeOut);
      log('  removed a launcher binary left by an earlier build: ' + exeOut);
    }
    log('  skipped (--no-exe): this package ships launcher/ + runtime/ instead');
  } else if (args.sea) {
    fs.mkdirSync(buildDir, { recursive: true });
    const seaConfig = path.join(buildDir, 'sea-config.json');
    const blob = path.join(buildDir, 'sea-prep.blob');
    fs.writeFileSync(
      seaConfig,
      JSON.stringify(
        {
          main: path.join(ROOT, 'launcher', 'launch.cjs'),
          output: blob,
          disableExperimentalSEAWarning: true,
          useSnapshot: false,
          useCodeCache: false,
        },
        null,
        2
      ),
      'utf8'
    );
    run(process.execPath, ['--experimental-sea-config', seaConfig]);

    // postject cannot patch a signed binary; drop the signature first.
    const stageExe = path.join(buildDir, exeName);
    fs.copyFileSync(process.execPath, stageExe);
    if (process.platform === 'darwin') {
      spawnSync('codesign', ['--remove-signature', stageExe], { stdio: 'inherit' });
    }
    const localPostject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
    const postjectArgs = [
      stageExe,
      'NODE_SEA_BLOB',
      blob,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ];
    if (fs.existsSync(localPostject)) {
      // Preferred: run the local CLI through Node, no shell shim involved.
      run(process.execPath, [localPostject].concat(postjectArgs));
    } else {
      run(NPX, ['--yes', 'postject'].concat(postjectArgs));
    }    if (process.platform === 'darwin') {
      spawnSync('codesign', ['--sign', '-', stageExe], { stdio: 'inherit' });
    }
    try {
      copyFile(stageExe, exeOut);
    } catch (err) {
      // Windows will not let us overwrite a running exe. While the user (or the debug instance
      // that just ran) still has it open, this throws EBUSY — a bare error explains nothing,
      // so translate it into plain words first.
      if (err && err.code === 'EBUSY') {
        throw new Error(
          'exe is running, cannot overwrite / the exe is currently running and cannot be replaced:\n    ' +
            exeOut +
            '\n  close it and rebuild (or use --out to write to a different directory).'
        );
      }
      throw err;
    }
    if (process.platform !== 'win32') fs.chmodSync(exeOut, 0o755);
    log('  -> ' + exeOut + '  (' + Math.round(fs.statSync(exeOut).size / 1048576) + ' MB)');

    // ------------------------------------------------------------------ 2b. signature
    // Here, and not later, because everything downstream describes these bytes: the package manifest
    // lists per-file sizes, the release's SHA256SUMS lists the zip's hash, and the release notes name
    // both. A signature appended after any of that makes each of them describe a file that no longer
    // exists. Signing before the pack means the description is of the artifact people download.
    if (args.sign) {
      stage(2, 'Authenticode signature');
      const signer = path.join(__dirname, 'sign-exe.cjs');
      const signArgs = [signer, exeOut, '--thumbprint', args.sign];
      const signTool = args.signTool || process.env.ONLYSIGN_DIR;
      if (signTool) signArgs.push('--onlysign', signTool);
      if (args.signPython) signArgs.push('--python', args.signPython);
      // The ledger is named rather than defaulted. Measured: without this the record of what was signed
      // lands in whichever directory the build was started from.
      if (args.signLedger) signArgs.push('--ledger', args.signLedger);
      // Fatal on failure. A build that ships an unsigned binary while the release notes claim a
      // signature is worse than a build that stops, and omitting --sign is how you build without one.
      run(process.execPath, signArgs);
    } else {
      log('  no --sign: the launcher is unsigned');
    }
  } else {
    log('  skipped (--skip-sea), keeping ' + exeOut);
  }

  // -------------------------------------------------------------- 3. runtime
  stage(3, 'bundled Node runtime');
  const runtimeDir = path.join(pkgDir, 'runtime');
  if (args.runtime) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const nodeOut = path.join(runtimeDir, 'node' + EXE);
    copyFile(process.execPath, nodeOut);
    log(
      '  -> runtime/node' + EXE + '  (' + (fs.statSync(nodeOut).size / 1048576).toFixed(1) + ' MB, ' +
        (args.exe ? 'the exe will spawn this instead of running inline' : 'the launcher spawns this; nothing else can start the app') + ')'
    );
  } else {
    rmrf(runtimeDir);
    log('  skipped (optional; the SEA exe runs the server in-process)');
  }

  // ------------------------------------------------------------- 4. launcher
  // The launcher is what a user double-clicks, so it has to be *in* the package for the launcher
  // layout to exist at all. It used to be embedded into the exe by the SEA step and never copied,
  // which is why a package without the exe had nothing to start it with.
  stage(4, 'launcher scripts');
  if (!args.exe) {
    const launcherOut = path.join(pkgDir, 'launcher');
    rmrf(launcherOut);
    copyDir(path.join(ROOT, 'launcher'), launcherOut);
    const copied = fs.readdirSync(launcherOut).sort();
    log('  -> launcher/  (' + copied.join(', ') + ')');
  } else {
    log('  skipped (the SEA exe embeds launcher/launch.cjs)');
  }

  // ------------------------------------------------------------- 5. app tree
  stage(5, 'application files');
  //
  // Runtime data has to survive this build.
  // This used to be "rmrf(appDir) and rebuild", while app/ holds **the user's config.json
  // (with the API key) and their entire history** (reports/feeds/logs/watch/thumbs/advice).
  // The result: every time a bug was fixed and the package rebuilt, the API key was wiped and
  // the history was gone.
  // Now those are moved into a staging area under build/ first and put back after the rebuild.
  // For a pristine factory state, use --fresh.
  const RUNTIME_KEEP = ['config.json', 'reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice'];
  const stash = path.join(buildDir, 'app-runtime-stash');
  const stashed = [];
  if (!args.fresh && fs.existsSync(appDir)) {
    rmrf(stash);
    for (const rel of RUNTIME_KEEP) {
      const from = path.join(appDir, rel);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(stash, { recursive: true });
      const to = path.join(stash, rel);
      try {
        fs.renameSync(from, to);
      } catch {
        // A cross-drive rename fails (EXDEV), so fall back to copy + delete
        copyDir(from, to, () => false);
        rmrf(from);
      }
      stashed.push(rel);
    }
    if (stashed.length) log('  preserving runtime state: ' + stashed.join(', '));
  } else if (args.fresh) {
    log('  --fresh: runtime state will NOT be preserved');
  }
  rmrf(appDir);
  const skipRuntime = (p) => {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    return (
      rel.startsWith('node_modules') ||
      rel.includes('/node_modules') ||
      rel.startsWith('dist') ||
      rel.startsWith('build') ||
      rel.startsWith('reports') ||
      rel.startsWith('feeds') ||
      rel.startsWith('logs') ||
      rel === 'config.json' ||
      rel.endsWith('/config.json')
    );
  };
  copyDir(path.join(ROOT, 'server'), path.join(appDir, 'server'), skipRuntime);
  copyDir(path.join(ROOT, 'web', 'dist'), path.join(appDir, 'web', 'dist'), (p) => p.includes('.vite'));
  if (fs.existsSync(path.join(ROOT, 'docs'))) copyDir(path.join(ROOT, 'docs'), path.join(appDir, 'docs'));
  // Deliberately NOT copying the repo's package.json / package-lock.json:
  // it declares npm workspaces, which would make `npm install` hoist every
  // dependency (including the web toolchain) into app/node_modules.
  // The About panel serves these files at runtime, so **both** READMEs have to be in the package:
  // README.md (English) and README.zh-CN.md (Chinese) — otherwise the in-app language toggle has
  // nothing to switch to.
  //
  // SECURITY.md is here for the same reason, one step removed: `docs/PRIVACY.md` is copied into the
  // package and names SECURITY.md as its companion document, so a packaged user could read the
  // privacy policy and not the threat model it points at. It ships next to the Readmes — the same
  // place the api/readme route looks — so the copy is where the document the user is reading says it is.
  for (const f of ['README.md', 'README.zh-CN.md', 'LICENSE', 'SECURITY.md']) {
    if (fs.existsSync(path.join(ROOT, f))) copyFile(path.join(ROOT, f), path.join(appDir, f));
  }
  if (fs.existsSync(path.join(ROOT, 'config.example.json'))) {
    copyFile(path.join(ROOT, 'config.example.json'), path.join(appDir, 'config.example.json'));
  }
  log('  -> app/');

  // Put the stashed runtime data back (API key, reports, intel, logs, watch baselines…)
  if (stashed.length) {
    for (const rel of stashed) {
      const from = path.join(stash, rel);
      const to = path.join(appDir, rel);
      try {
        fs.renameSync(from, to);
      } catch {
        copyDir(from, to, () => false);
      }
    }
    rmrf(stash);
    log('  restored runtime state: ' + stashed.join(', '));
  }

  // ------------------------------------------------------------- 6. runtime deps
  stage(6, 'server dependencies');
  const serverDir = path.join(appDir, 'server');
  const serverModules = path.join(serverDir, 'node_modules');
  rmrf(serverModules);
  if (args.install) {
    // --ignore-scripts on purpose: playwright's postinstall would download
    // ~150 MB of browser kernels into a system-level cache. Browser kernels are
    // a runtime choice (Settings > Browser) or an explicit --with-browsers.
    //
    // `npm ci`, not `npm install`, and server/package-lock.json is why: with `install`, the caret ranges in
    // server/package.json were resolved **at build time**, so two builds of one commit could ship different
    // dependency patches. Measured after v1.0.6: the published zip carried playwright-core 1.64.1 while a
    // local build of the same commit carried 1.64.0, and the only visible trace was one content-hashed asset
    // name inside that dependency - nothing in the release chain could see it (BUGS #92). `ci` installs
    // exactly the locked versions and refuses to run when the lock and the manifest disagree, which is the
    // honest failure rather than a silent drift.
    if (!fs.existsSync(path.join(serverDir, 'package-lock.json'))) {
      throw new Error(
        'server/package-lock.json is missing, so the packaged dependencies would be resolved at build time ' +
          'and two builds of one commit could ship different versions (BUGS #92). Regenerate it with: ' +
          'npm install --package-lock-only --ignore-scripts --workspaces=false (run in server/)'
      );
    }
    runNpm(
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: serverDir }
    );
    if (!fs.existsSync(serverModules)) {
      // Defensive: if npm hoisted elsewhere, the exe would still work, but the
      // layout would be surprising - say so instead of shipping it silently.
      throw new Error('expected dependencies in ' + serverModules + ' but they were not created');
    }
  } else {
    log('  skipped (--no-install)');
  }

  // --------------------------------------------------------------- 7. extras
  stage(7, 'package manifest and README');
  // A purpose-built manifest, not a copy of the repo one: the repo file is
  // bilingual (non-ASCII) and declares npm workspaces that do not exist here.
  const releaseManifest = {
    name: rootPkg.name || 'vtuber-monitor-link',
    version: rootPkg.version,
    private: true,
    description: "Vtuber's Monitor Link - portable release. Version source for the launcher.",
    license: rootPkg.license || 'MIT',
    type: 'module',
  };
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(releaseManifest, null, 2) + '\n', 'ascii');
  // The quickstart describes the layout that is actually in the zip, so the two cannot drift into
  // telling the user to double-click a file this build did not produce.
  fs.writeFileSync(path.join(pkgDir, 'README.txt'), args.exe ? README_TXT_EXE : README_TXT_LAUNCHER, 'ascii');
  log('  -> package.json, README.txt (' + (args.exe ? 'exe layout' : 'launcher layout') + ')');

  if (args.browsers) {
    const pwDir = path.join(pkgDir, 'pw-browsers');
    log('  downloading Firefox into pw-browsers/ ...');
    const pwCli = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
    const env = Object.assign({}, process.env, { PLAYWRIGHT_BROWSERS_PATH: pwDir });
    if (fs.existsSync(pwCli)) run(process.execPath, [pwCli, 'install', 'firefox'], { env: env });
    else run(NPX, ['--yes', 'playwright', 'install', 'firefox'], { env: env });
    // What the engine actually costs, reported rather than assumed: the whole point of naming the payload
    // is that the number can be checked against the package it went into.
    log('  pw-browsers/ payload: ' + (dirBytes(pwDir) / 1048576).toFixed(1) + ' MB');
  }

  // -------------------------------------------------------------- 8. verify
  stage(8, 'verify');
  // Verify through the same resolution the traversals use, so "the build verified itself" means
  // the package can actually be started - not merely that a file with the right name exists.
  const target = resolveLaunch(pkgDir);
  if (!target) {
    throw new Error(
      'the built package cannot be started: no launcher binary and no launcher/ + runtime/ pair\n' +
        launchCandidates(pkgDir)
          .map((c) => '    ' + (c.present ? 'present ' : 'missing ') + c.what + ': ' + c.path)
          .join('\n')
    );
  }
  log('  starting via ' + target.kind + ' layout: ' + target.shown);
  const doctor = spawnSync(target.cmd, target.args.concat(['--doctor']), { encoding: 'utf8', cwd: pkgDir });
  process.stdout.write(doctor.stdout || '');
  if (doctor.stderr) process.stderr.write(doctor.stderr);
  if (doctor.status !== 0) throw new Error('--doctor reported a problem');

  // -------------------------------------------------------------- 8. release zip
  // The release package has to be clean: runtime data (API key / history) must not go into it,
  // which make-zip.mjs guarantees.
  if (args.zip) {
    stage(9, 'release zip');
    const plat = process.platform === 'win32' ? 'win' : process.platform;
    const zipName = `${args.name}-${rootPkg.version}-${plat}-${process.arch}.zip`;
    run(process.execPath, [path.join(__dirname, 'make-zip.mjs'), pkgDir, path.join(args.out, zipName)]);
  }

  log('       (' + ((Date.now() - stageStart) / 1000).toFixed(1) + 's in the previous stage)');
  log('');
  log('done: ' + pkgDir);
  log('total: ' + ((Date.now() - BUILD_START) / 1000).toFixed(1) + 's');
  log('');
}

try {
  main();
} catch (err) {
  process.stderr.write('\nbuild failed: ' + (err && err.stack ? err.stack : err) + '\n\n');
  process.exit(1);
}

// tools/build-portable.cjs - build the portable Windows/Linux/macOS release.
//
// ASCII only, CommonJS, no external build tooling beyond Node + npx.
//
//   node tools/build-portable.cjs [options]
//
//   --out <dir>        output root            (default <repo>/dist)
//   --name <name>      package folder / exe   (default VtuberMonitorLink)
//   --skip-sea         do not rebuild the SEA launcher, reuse build/ exe
//   --no-install       do not run npm install for app/server
//   --with-runtime     also bundle runtime/node.exe (the SEA exe can run the
//                      server in-process, so this is optional and doubles size)
//   --with-browsers    also run `playwright install chromium` into pw-browsers/
//
// Output layout:
//
//   dist/VtuberMonitorLink/
//     VtuberMonitorLink.exe     <- SEA single-file launcher + app runner
//     package.json              <- version source for the launcher
//     README.txt                <- ASCII quickstart
//     app/                      <- the application itself
//       server/src/...  server/node_modules/...  web/dist/...
//       config.json             <- created on first save (gitignored)

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function log(msg) {
  process.stdout.write(msg + '\n');
}

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'dist'), name: 'VtuberMonitorLink', sea: true, install: true, browsers: false, runtime: false, zip: true, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--name') out.name = String(argv[++i] || '').trim() || out.name;
    else if (a === '--skip-sea') out.sea = false;
    else if (a === '--no-install') out.install = false;
    else if (a === '--with-runtime') out.runtime = true;
    else if (a === '--with-browsers') out.browsers = true;
    else if (a === '--no-zip') out.zip = false;
    else if (a === '--fresh') out.fresh = true;
  }
  return out;
}

function run(cmd, args, opts) {
  log('  $ ' + [cmd].concat(args).join(' '));
  const options = Object.assign({ stdio: 'inherit', cwd: ROOT }, opts || {});
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

const README_TXT = [
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
  '  For browser-rendered sources, either let it use its own Chromium',
  '  (Settings > Browser > bundled, one-time download) or point it at an',
  '  already installed Chrome / Edge / Opera.',
  '',
].join('\r\n');

function main() {
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
  log('');

  // ------------------------------------------------------------------ 1. web
  log('[1/7] web UI build');
  const distIndex = path.join(ROOT, 'web', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    run(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'web/vite.config.js']);
  } else {
    log('  reusing existing web/dist (delete it to force a rebuild)');
  }

  // ------------------------------------------------------------------ 2. SEA
  log('[2/7] SEA launcher');
  const exeName = args.name + EXE;
  const exeOut = path.join(pkgDir, exeName);
  fs.mkdirSync(pkgDir, { recursive: true });

  if (args.sea) {
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
      // Windows 不允许覆盖正在运行的 exe。使用者（或刚才那个调试实例）还开着时
      // 这里会抛 EBUSY —— 裸错误看不出所以然，所以翻译成人话再说。
      if (err && err.code === 'EBUSY') {
        throw new Error(
          'exe 正在运行，无法覆盖 / the exe is currently running and cannot be replaced:\n    ' +
            exeOut +
            '\n  先关掉它再打包（或者用 --out 输出到别的目录）。'
        );
      }
      throw err;
    }
    if (process.platform !== 'win32') fs.chmodSync(exeOut, 0o755);
    log('  -> ' + exeOut + '  (' + Math.round(fs.statSync(exeOut).size / 1048576) + ' MB)');
  } else {
    log('  skipped (--skip-sea), keeping ' + exeOut);
  }

  // -------------------------------------------------------------- 3. runtime
  log('[3/7] bundled Node runtime');
  const runtimeDir = path.join(pkgDir, 'runtime');
  if (args.runtime) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    copyFile(process.execPath, path.join(runtimeDir, 'node' + EXE));
    log('  -> runtime/node' + EXE + '  (the exe will spawn this instead of running inline)');
  } else {
    rmrf(runtimeDir);
    log('  skipped (optional; the SEA exe runs the server in-process)');
  }

  // ------------------------------------------------------------- 4. app tree
  log('[4/7] application files');
  //
  // ⚠️ 运行期数据必须活着穿过这次构建。
  // 以前这里是「直接 rmrf(appDir) 再重建」，而 app/ 里放着**用户的 config.json
  // （含 API Key）和全部历史**（reports/feeds/logs/watch/thumbs/advice）。
  // 结果：每次修完 bug 重新打包，API Key 就被清空、历史全没了。
  // 现在先把这些挪到 build/ 下的暂存区，重建完再放回去。
  // 想要一份干净出厂状态就用 --fresh。
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
        // 跨盘时 rename 会失败（EXDEV），退回复制 + 删除
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
  for (const f of ['README.md', 'LICENSE']) {
    if (fs.existsSync(path.join(ROOT, f))) copyFile(path.join(ROOT, f), path.join(appDir, f));
  }
  if (fs.existsSync(path.join(ROOT, 'config.example.json'))) {
    copyFile(path.join(ROOT, 'config.example.json'), path.join(appDir, 'config.example.json'));
  }
  log('  -> app/');

  // 把暂存的运行期数据放回去（API Key、报告、情报、日志、监视基线……）
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

  // ------------------------------------------------------------- 5. runtime deps
  log('[5/7] server dependencies');
  const serverDir = path.join(appDir, 'server');
  const serverModules = path.join(serverDir, 'node_modules');
  rmrf(serverModules);
  if (args.install) {
    // --ignore-scripts on purpose: playwright's postinstall would download
    // ~150 MB of browser kernels into a system-level cache. Browser kernels are
    // a runtime choice (Settings > Browser) or an explicit --with-browsers.
    runNpm(
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
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

  // --------------------------------------------------------------- 6. extras
  log('[6/7] launcher extras');
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
  fs.writeFileSync(path.join(pkgDir, 'README.txt'), README_TXT, 'ascii');
  log('  -> package.json, README.txt');

  if (args.browsers) {
    const pwDir = path.join(pkgDir, 'pw-browsers');
    log('  downloading Chromium into pw-browsers/ ...');
    const pwCli = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
    const env = Object.assign({}, process.env, { PLAYWRIGHT_BROWSERS_PATH: pwDir });
    if (fs.existsSync(pwCli)) run(process.execPath, [pwCli, 'install', 'chromium'], { env: env });
    else run(NPX, ['--yes', 'playwright', 'install', 'chromium'], { env: env });
  }

  // -------------------------------------------------------------- 7. verify
  log('[7/7] verify');
  const exe = path.join(pkgDir, exeName);
  if (fs.existsSync(exe)) {
    const doctor = spawnSync(exe, ['--doctor'], { encoding: 'utf8', cwd: pkgDir });
    process.stdout.write(doctor.stdout || '');
    if (doctor.stderr) process.stderr.write(doctor.stderr);
    if (doctor.status !== 0) throw new Error('--doctor reported a problem');
  } else {
    log('  (no exe to verify)');
  }

  // -------------------------------------------------------------- 8. release zip
  // 发行包必须干净：运行期数据（API Key / 历史）不进包，由 make-zip.mjs 保证。
  if (args.zip) {
    log('');
    log('[8/8] release zip');
    const plat = process.platform === 'win32' ? 'win' : process.platform;
    const zipName = `${args.name}-${rootPkg.version}-${plat}-${process.arch}.zip`;
    run(process.execPath, [path.join(__dirname, 'make-zip.mjs'), pkgDir, path.join(args.out, zipName)]);
  }

  log('');
  log('done: ' + pkgDir);
  log('');
}

try {
  main();
} catch (err) {
  process.stderr.write('\nbuild failed: ' + (err && err.stack ? err.stack : err) + '\n\n');
  process.exit(1);
}

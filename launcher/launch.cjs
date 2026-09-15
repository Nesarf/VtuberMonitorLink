// Vtuber's Monitor Link - launcher (ASCII only, cross-platform, CommonJS).
//
// Why CommonJS: Node's SEA (single executable application) embeds `main` as a
// CommonJS module. An ESM main fails at runtime with "Cannot use import
// statement outside a module", so this file must stay CJS to be embeddable.
//
// Responsibilities:
//   1. locate the application (source checkout OR portable package OR SEA exe)
//   2. locate a usable Node runtime (bundled runtime/node[.exe] first)
//   3. start the local server as a child process
//   4. report the URL (the server itself opens the browser)
//
// Design notes:
//   - ASCII only: this file must survive any system code page.
//   - No harness dependency: it only needs Node.
//   - Paths are resolved relative to this launcher, never hard-coded.
//   - SEA-safe: inside a SEA binary process.execPath IS this launcher, so
//     re-spawning it would recurse; a bundled runtime is therefore required.
//   - Diagnostics: --paths / --doctor print the resolved layout for proofreading.
//
// Layouts understood (any of these works):
//
//   A) source checkout                 B) portable package
//   <repo>/launcher/launch.cjs         <pkg>/VtuberMonitorLink.exe
//   <repo>/server/src/index.js         <pkg>/runtime/node.exe
//   <repo>/node_modules/...            <pkg>/app/server/src/index.js

'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const EXE = process.platform === 'win32' ? '.exe' : '';
const ENTRY = path.join('server', 'src', 'index.js');
const NAME = "Vtuber's Monitor Link";
const FALLBACK_VERSION = '1.0.0';

/** node:sea is present from Node 21.7; older runtimes simply report false. */
function detectSea() {
  try {
    const mod = require('node:sea');
    const fn = mod && (mod.isSea || (mod.default && mod.default.isSea));
    return typeof fn === 'function' ? !!fn() : false;
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function firstExistingDir(candidates) {
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/**
 * Resolve the layout. Deterministic function of (isSea, execPath, __dirname)
 * so --paths can print it without starting anything.
 */
function resolveLayout(isSea) {
  // HOME = the directory holding the launcher binary/script.
  // Inside SEA, process.execPath is authoritative; the embedded script has no
  // filesystem anchor, and process.argv[1] is a user-supplied argument.
  const home = path.resolve(isSea ? path.dirname(process.execPath) : __dirname);

  // PKG = the distributable root (portable package root, or the repo root).
  const pkg = isSea ? home : path.resolve(home, '..');

  const appRoot = firstExistingDir(
    [
      path.join(pkg, 'app'), // portable package
      path.join(home, 'app'), // exe sitting next to app/
      pkg, // source checkout / unpacked
      home,
    ].filter((c) => exists(path.join(c, ENTRY)))
  );

  const runtimeCandidates = [
    path.join(pkg, 'runtime', 'node' + EXE),
    path.join(home, 'runtime', 'node' + EXE),
  ];
  let node = firstExistingDir(runtimeCandidates);

  // How the application gets run:
  //   spawn  - a real Node runtime starts the server in a child process
  //   inline - the SEA binary imports the server entry in its own process
  //            (used when no runtime/ is bundled, which keeps the download
  //            one binary smaller instead of duplicating the runtime)
  let mode;
  if (node) {
    mode = 'spawn';
  } else if (isSea) {
    mode = 'inline';
  } else {
    node = process.execPath;
    mode = 'spawn';
  }

  return { isSea, home, pkg, appRoot, node, mode, runtimeCandidates };
}

function readVersion(pkg) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    if (raw && typeof raw.version === 'string') return raw.version;
  } catch {
    /* ignore */
  }
  return FALLBACK_VERSION;
}

const HELP = [
  NAME + ' - local web console for VTuber intelligence gathering.',
  '',
  'Usage:',
  '  VtuberMonitorLink' + EXE + ' [options]',
  '',
  'Options:',
  '  --port <n>      listen port (default 43110, or $PORT)',
  '  --no-open       do not open a browser window',
  '  --paths         print the resolved layout and exit (diagnostics)',
  '  --doctor        check runtime / app / config / web build, then exit',
  '  -h, --help      show this help',
  '  -v, --version   show version',
  '',
].join('\n');

function parseArgs(argv) {
  const out = { port: null, open: true, paths: false, doctor: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--paths') out.paths = true;
    else if (a === '--doctor') out.doctor = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--port') out.port = String(argv[i + 1] || '').trim() || null;
    else if (a.indexOf('--port=') === 0) out.port = a.slice(7).trim() || null;
  }
  return out;
}

/**
 * Is something already serving VML on this port?
 *
 * Two questions, and the order matters: is anything listening at all, and is it us. The second is answered by
 * asking for an endpoint only this application has, because "the port is busy" and "the app is already
 * running" need opposite answers. The first is a conflict to explain; the second is a reason to open the page
 * the person actually wanted when they double-clicked the icon. The child's own message for the first case
 * ("port 43110 in use - set the PORT environment variable to pick another port") is a developer's sentence,
 * and the person who just launched a portable app has no idea what to do with it.
 *
 * A refused connection is the normal case of nothing being there; a listener that answers with something else,
 * or that does not answer within the timeout, is somebody else's server and is treated as a conflict.
 */
async function probeExisting(port) {
  const ctl = new AbortController();
  const timer = setTimeout(function () {
    ctl.abort();
  }, 1500);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/sources', { signal: ctl.signal });
    if (!res.ok) return { kind: 'other', detail: 'answered HTTP ' + res.status };
    const body = await res.json();
    return Array.isArray(body && body.sources) ? { kind: 'vml' } : { kind: 'other', detail: 'answered, but not like VML' };
  } catch (err) {
    const code = (err && err.cause && err.cause.code) || (err && err.code);
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') return { kind: 'free' };
    return { kind: 'other', detail: (err && err.message) || 'no answer' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a URL in the default browser, without a shell.
 *
 * `explorer` is used on Windows rather than `cmd /c start`, for the reason the open-file endpoint learned the
 * same day: a shell re-parses its arguments, and the value here happens to be built by this program rather
 * than typed by anyone, but a URL is still data. The caller prints the address when this returns false, so a
 * machine where none of these exists is told the address instead of being left with nothing.
 */
function openInBrowser(url) {
  const spec =
    process.platform === 'win32'
      ? ['explorer', [url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    execFileSync(spec[0], spec[1], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold the window open when there is a person in front of it, and never otherwise.
 *
 * A double-clicked launcher closes the moment the process exits, so a failure that is only printed is a
 * failure nobody reads - the owner's report of this application ("it starts and then quits by itself") is
 * that, and the trace he needed was already in the log by then. `isTTY` is the whole guard: a pipe, a service
 * manager or CI gets no prompt, so nothing can ever hang waiting for a key that will not be pressed.
 */
function pauseForHuman(message) {
  if (!message) return;
  process.stdout.write('\n' + message + '\n');
  if (!process.stdin.isTTY) return;
  try {
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'pause'], { stdio: 'inherit' });
    else execFileSync('sh', ['-c', 'read _'], { stdio: 'inherit' });
  } catch {
    /* no console to read from: exiting is the right answer */
  }
}

/** Where the server writes its log - printed on failure, because that is where the reason already is */
function logPathFor() {
  try {
    const L = resolveLayout(detectSea());
    return L.appRoot ? path.join(L.appRoot, 'logs', 'server.log') : '(app root could not be resolved)';
  } catch {
    return '(app root could not be resolved)';
  }
}

function doctorReport(L, version) {
  const cfgPath = L.appRoot ? path.join(L.appRoot, 'config.json') : null;
  const distPath = L.appRoot ? path.join(L.appRoot, 'web', 'dist', 'index.html') : null;
  const rows = [
    ['version', version],
    ['sea', String(L.isSea)],
    ['platform', process.platform + '/' + process.arch],
    ['node (running)', process.versions.node],
    ['home', L.home],
    ['pkg', L.pkg],
    ['appRoot', L.appRoot || '(missing)'],
    ['mode', L.mode],
    ['runtime', L.mode === 'inline' ? '(inline / no runtime needed)' : L.node || '(missing)'],
    ['config', cfgPath ? cfgPath + (exists(cfgPath) ? ' [present]' : ' [defaults]') : '-'],
    ['webDist', distPath ? distPath + (exists(distPath) ? ' [ok]' : ' [missing]') : '-'],
  ];
  return rows;
}

function problemsFor(L) {
  const problems = [];
  if (!L.appRoot) {
    problems.push(
      'Application not found. Looked for ' +
        ENTRY +
        ' under:\n' +
        '    ' +
        [path.join(L.pkg, 'app'), path.join(L.home, 'app'), L.pkg, L.home].join('\n    ') +
        '\n  Unpack the whole release, or run "npm install && npm run build" in a source checkout.'
    );
  }
  if (L.mode === 'spawn' && !L.node) {
    problems.push(
      'No Node runtime found. Put a Node executable at:\n' +
        L.runtimeCandidates.map((c) => '    ' + c).join('\n')
    );
  }
  if (L.appRoot && !exists(path.join(L.appRoot, 'web', 'dist', 'index.html'))) {
    problems.push(
      'Web UI build missing: ' +
        path.join(L.appRoot, 'web', 'dist', 'index.html') +
        '\n  Run "npm run build" in a source checkout.'
    );
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isSea = detectSea();
  const L = resolveLayout(isSea);
  const version = readVersion(L.pkg);

  if (args.help) {
    process.stdout.write(HELP);
    return Promise.resolve(0);
  }
  if (args.version) {
    process.stdout.write(version + '\n');
    return Promise.resolve(0);
  }
  if (args.paths) {
    process.stdout.write(
      JSON.stringify(
        {
          version: version,
          sea: isSea,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.versions.node,
          execPath: process.execPath,
          home: L.home,
          pkg: L.pkg,
          appRoot: L.appRoot,
          node: L.node,
          nodeCandidates: L.runtimeCandidates,
          entry: L.appRoot ? path.join(L.appRoot, ENTRY) : null,
        },
        null,
        2
      ) + '\n'
    );
    return Promise.resolve(0);
  }

  const problems = problemsFor(L);

  if (args.doctor) {
    process.stdout.write(doctorReport(L, version).map(([k, v]) => '  ' + k.padEnd(16) + ' ' + v).join('\n') + '\n');
    if (problems.length) {
      process.stdout.write('\n  PROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n') + '\n');
      return Promise.resolve(1);
    }
    process.stdout.write('\n  All checks passed.\n');
    return Promise.resolve(0);
  }

  if (problems.length) {
    process.stderr.write('\n[' + NAME + '] cannot start:\n\n  - ' + problems.join('\n\n  - ') + '\n\n');
    return Promise.resolve(1);
  }

  const port = args.port || process.env.PORT || '43110';
  const entry = path.join(L.appRoot, ENTRY);

  // A port number that cannot be listened on is its own answer. Without this, a typo like --port 70000 fell
  // through to the probe, which reported "something that is not this application is using it" - a sentence
  // about a conflict that does not exist.
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    pauseForHuman('[' + NAME + '] ' + port + ' is not a usable port number (1-65535).');
    return 1;
  }

  // Before spawning anything: is this a second launch, and if so, of what? See probeExisting.
  const existing = await probeExisting(port);
  if (existing.kind === 'vml') {
    const url = 'http://127.0.0.1:' + port + '/';
    process.stdout.write('[' + NAME + '] already running - ' + url + '\n');
    if (args.open && openInBrowser(url)) {
      process.stdout.write('[' + NAME + '] opened in your browser.\n');
      return 0;
    }
    pauseForHuman('[' + NAME + '] open this address in your browser:\n  ' + url);
    return 0;
  }
  if (existing.kind === 'other') {
    // Not our instance, so this really is a conflict - but it is told in a sentence a person can act on,
    // rather than by handing the child's "set the PORT environment variable" to somebody who double-clicked.
    pauseForHuman(
      '[' + NAME + '] port ' + port + ' is already used by something that is not this application (' + existing.detail + ').\n' +
        'Start this one on another port:  --port 43111'
    );
    return 1;
  }

  const env = Object.assign({}, process.env);
  env.PORT = port;
  if (!args.open || process.env.NO_OPEN === '1') env.NO_OPEN = '1';
  // Keep the browser cache inside the package when present, so a portable
  // install never has to write to the system drive.
  const bundledBrowsers = path.join(L.pkg, 'pw-browsers');
  if (!env.PLAYWRIGHT_BROWSERS_PATH && exists(bundledBrowsers)) {
    env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  }

  // In inline mode there is no child process to hand `env` to: the server runs
  // right here, so the variables have to be applied to our own environment.
  if (L.mode === 'inline') Object.assign(process.env, env);

  process.stdout.write('[' + NAME + '] v' + version + '\n');
  process.stdout.write('[' + NAME + '] mode: ' + L.mode + '\n');
  if (L.mode === 'spawn') process.stdout.write('[' + NAME + '] node: ' + L.node + '\n');
  process.stdout.write('[' + NAME + '] app : ' + L.appRoot + '\n');
  process.stdout.write('[' + NAME + '] url : http://127.0.0.1:' + port + '\n\n');

  if (L.mode === 'inline') {
    // SEA without a bundled runtime: run the server in this very process.
    // The server is plain ESM on disk, so the normal ESM loader handles it;
    // only the embedded main script is restricted to CommonJS.
    try {
      process.chdir(L.appRoot);
    } catch (e) {
      /* keep cwd; the server resolves everything from its own file path */
    }
    return import(pathToFileURL(entry).href).then(
      function () {
        // The server keeps the event loop alive; never resolve.
        return new Promise(function () {});
      },
      function (err) {
        process.stderr.write('\n[' + NAME + '] failed to load the server: ' + (err && err.stack ? err.stack : err) + '\n\n');
        return 1;
      }
    );
  }

  const child = spawn(L.node, [entry], { cwd: L.appRoot, env: env, stdio: 'inherit' });
  const forward = function (sig) {
    try {
      child.kill(sig);
    } catch (e) {
      /* ignore */
    }
  };
  process.on('SIGINT', function () {
    forward('SIGINT');
  });
  process.on('SIGTERM', function () {
    forward('SIGTERM');
  });

  return new Promise(function (resolve) {
    child.on('error', function (err) {
      process.stderr.write('\n[' + NAME + '] failed to start the server: ' + err.message + '\n\n');
      resolve(1);
    });
    child.on('exit', function (code, signal) {
      if (signal) {
        // A child killed by a signal is not a success. `resolve(signal ? 0 : ...)` reported an out-of-memory
        // kill, a service manager's stop and a clean shutdown as the same thing - exit code 0 - which is the
        // one outcome a caller cannot tell apart from "everything went fine".
        process.stderr.write('\n[' + NAME + '] the server was stopped by ' + signal + '\n');
        resolve(1);
        return;
      }
      resolve(code || 0);
    });
  });
}

main().then(
  function (code) {
    if (code) {
      // A double-clicked window closes the instant the process exits, so a failure that is only printed is a
      // failure nobody reads - the owner's report ("it starts and then quits by itself") is exactly that, and
      // by the time it happens the reason has already been written to the log.
      pauseForHuman(
        '[' + NAME + '] exited with code ' + code + '.\n' + 'The server log, which has the reason:\n  ' + logPathFor()
      );
    }
    process.exit(code);
  },
  function (err) {
    process.stderr.write('\n[' + NAME + '] unexpected error: ' + (err && err.stack ? err.stack : err) + '\n\n');
    pauseForHuman('[' + NAME + '] the launcher itself failed.\n' + 'The server log:\n  ' + logPathFor());
    process.exit(1);
  }
);

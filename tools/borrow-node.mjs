// borrow-node.mjs - run any of this repository's scripts under the Node runtime that ships inside
// Visual Studio Code.
//
// Why this exists: VS Code bundles its own Node, reachable through its Electron binary with
// ELECTRON_RUN_AS_NODE=1, and it is deliberately a different build from the one on PATH. That makes
// it the cheapest way to answer a question a single runtime cannot: *does our tooling depend on this
// Node build, or would any do?* A tool that only passes under one patch release is a tool with a
// hidden dependency, and the way to find out is to run it under the other one.
//
// It is not a build step and nothing depends on it: this repository must keep working with plain
// `node`. It is a developer check, run by hand, and it says so when it cannot find VS Code instead of
// inventing a path.
//
// Usage:
//   node tools/borrow-node.mjs --where                 show what it found
//   node tools/borrow-node.mjs tools/workers.mjs --published-only
//   node tools/borrow-node.mjs --selfcheck
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** Find the Code executable without ever hard-coding somebody's install directory. */
function findCode() {
  if (process.env.VML_CODE_EXE && fs.existsSync(process.env.VML_CODE_EXE)) {
    return { exe: process.env.VML_CODE_EXE, how: 'VML_CODE_EXE' };
  }
  const shim = process.platform === 'win32' ? 'code.cmd' : 'code';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, shim);
    if (!fs.existsSync(candidate)) continue;
    // The shim lives in `bin/` next to the real binary: <install>/bin/code.cmd -> <install>/Code.exe
    for (const rel of ['..\\Code.exe', '../Code.exe', '../code', '..\\code.exe']) {
      const exe = path.resolve(dir, rel);
      if (fs.existsSync(exe)) return { exe, how: 'derived from the code shim on PATH (' + candidate + ')' };
    }
    if (fs.existsSync(candidate) && !candidate.endsWith('.cmd')) return { exe: candidate, how: 'the code binary on PATH' };
  }
  for (const guess of ['/usr/share/code/code', '/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron']) {
    if (fs.existsSync(guess)) return { exe: guess, how: 'well-known location' };
  }
  return null;
}

const found = findCode();
if (!found) {
  process.stderr.write(
    'borrow-node: no Visual Studio Code found (looked at PATH, VML_CODE_EXE and the usual places).\n' +
      '  Nothing here depends on it: plain `node` is the supported way to run everything in tools/.\n',
  );
  process.exit(2);
}

/** Run one script with VS Code's Node and report the version it used. */
function runWithBorrowedNode(scriptArgs, { capture = false } = {}) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const probe = spawnSync(found.exe, ['-e', 'console.log(process.version)'], { encoding: 'utf8', env });
  const borrowedVersion = (probe.stdout ?? '').trim() || '(unknown)';
  const res = spawnSync(found.exe, scriptArgs, {
    cwd: ROOT,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
  });
  return { borrowedVersion, status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

if (!argv.length || argv[0] === '--where') {
  const borrowed = runWithBorrowedNode(['-e', 'console.log(process.version)'], { capture: true });
  process.stdout.write('borrow-node: ' + found.exe + '\n');
  process.stdout.write('  found via  : ' + found.how + '\n');
  process.stdout.write('  its node   : ' + borrowed.borrowedVersion + '\n');
  process.stdout.write('  PATH node  : ' + process.version + ' (' + process.execPath + ')\n');
  process.stdout.write(
    borrowed.borrowedVersion === process.version
      ? '  the two are the same build, so this check proves nothing here - say so rather than claiming coverage\n'
      : '  the two differ, so a run under each is a real cross-runtime check\n',
  );
  process.exit(0);
}

if (argv[0] === '--selfcheck') {
  const checks = [];
  const t = (name, fn) => {
    let ok = false;
    let detail = '';
    try {
      ok = fn() === true;
    } catch (e) {
      detail = ': ' + e.message;
    }
    process.stdout.write(`${ok ? '  [ok]  ' : '  [FAIL]'} ${name}${detail}\n`);
    checks.push(ok);
  };
  t('the Code binary answers as a Node runtime', () => runWithBorrowedNode(['-e', '1'], { capture: true }).status === 0);
  t('it prints a version that looks like Node', () => /^v\d+\./.test(runWithBorrowedNode(['-e', 'console.log(process.version)'], { capture: true }).borrowedVersion));
  t('it can run a repository script and see the repository', () => {
    const r = runWithBorrowedNode(['-e', 'console.log(require("node:fs").existsSync("docs/WORKERS.md"))'], { capture: true });
    return r.stdout.trim() === 'true';
  });
  const passed = checks.filter(Boolean).length;
  process.stdout.write(`${passed}/${checks.length} checks passed\n`);
  process.exit(passed === checks.length ? 0 : 1);
}

const target = argv[0];
if (!fs.existsSync(path.resolve(ROOT, target))) {
  process.stderr.write(`borrow-node: no such script: ${target}\n`);
  process.exit(2);
}
process.stdout.write(`borrow-node: running \`${argv.join(' ')}\` under VS Code's Node (${found.exe})\n`);
const result = runWithBorrowedNode(argv);
process.exit(result.status ?? 1);

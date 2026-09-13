// workers/pwsh/build.mjs — the "build" step for the PowerShell worker.
//
// THERE IS NO COMPILATION. This is a script worker: `pwsh` reads `workers/pwsh/vmltext.ps1` and runs
// it, so nothing is produced that needed a compiler, and pretending otherwise would be the kind of
// claim this layer exists to avoid. What a build step is still worth here:
//
//   1. fail loudly and early if PowerShell 7 is not installed (a worker whose interpreter is missing
//      must be a clear `[skip]`, not a harness timeout);
//   2. fail loudly if the shared tables are missing — the worker reads workers/spec/*.json at
//      start-up and would otherwise exit 2 at the first request;
//   3. run the worker's own --selfcheck, so a broken edit is caught by the build rather than by the
//      cross-implementation diff;
//   4. record a manifest (artifact + interpreter + a hash of every source file it depends on) in the
//      gitignored workers/pwsh/dist/ directory. The artifact is itself a source file, so `make`-style
//      "artifact newer than its sources" freshness cannot see an edit; the manifest can.
//
// It prints the artifact path as its last stdout line, which is what the registry contract asks for.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const ARTIFACT = 'workers/pwsh/vmltext.ps1';
const MANIFEST = path.join(HERE, 'dist', 'build-manifest.json');

/** Every file the worker needs at run time, relative to the repository root. */
const SOURCES = [
  'workers/pwsh/vmltext.ps1',
  'workers/spec/latin-lower.json',
  'workers/spec/latin-fold.json',
];

/** Candidates in order: PowerShell 7 first, Windows PowerShell named only so the message can list it. */
const CANDIDATES = ['pwsh', 'powershell'];

function fail(message) {
  process.stderr.write(`build failed: ${message}\n`);
  process.exit(1);
}

function sourceSignature() {
  const hash = crypto.createHash('sha256');
  for (const file of SOURCES) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) fail(`required source is missing: ${file}`);
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(full));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function findInterpreter() {
  for (const command of CANDIDATES) {
    const probe = spawnSync(command, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (probe.error) continue; // not installed on this machine
    if (probe.status !== 0) continue;
    const version = String(probe.stdout ?? '').trim().split('\n').pop().trim();
    const major = Number.parseInt(version.split('.')[0], 10);
    if (!Number.isFinite(major)) continue;
    // `powershell` is Windows PowerShell 5.1, which is not enough: the worker needs 7 for its JSON
    // and string behaviour and says so on stderr if it is ever started under 5.1. Skipping it here
    // means the failure message names what was tried instead of blaming the worker later.
    if (major < 7) continue;
    return { command, version };
  }
  return null;
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

if (!fs.existsSync(path.join(ROOT, ARTIFACT))) fail(`${ARTIFACT} is missing from the checkout`);

const signature = sourceSignature();
const previous = readManifest();
const interpreter = findInterpreter();

if (!interpreter) {
  fail(
    'no PowerShell 7 interpreter found (tried: ' +
      CANDIDATES.join(', ') +
      '). Install PowerShell 7, or record the interpreter this machine has in workers/registry.local.json.',
  );
}

const upToDate =
  previous &&
  previous.artifact === ARTIFACT &&
  previous.sourceSignature === signature &&
  previous.interpreter &&
  previous.interpreter.command === interpreter.command &&
  previous.interpreter.version === interpreter.version;

if (upToDate) {
  process.stdout.write(`pwsh ${interpreter.version} (${interpreter.command}); nothing is compiled, artifact up to date\n`);
  process.stdout.write(`${ARTIFACT}\n`);
  process.exit(0);
}

// The worker's built-in case list. Running it here means a broken edit fails the build, and a failed
// build is a `[skip]` the harness reports — instead of a worker that answers nothing.
const check = spawnSync(interpreter.command, ['-NoProfile', '-NoLogo', '-NonInteractive', '-File', path.join(HERE, 'vmltext.ps1'), '--selfcheck'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const checkOut = String(check.stdout ?? '');
const summary = checkOut.trim().split('\n').filter(Boolean).pop() ?? '(no output)';
if (check.status !== 0) {
  process.stderr.write('selfcheck output:\n');
  process.stderr.write(checkOut);
  if (check.stderr) process.stderr.write(String(check.stderr));
  fail(`--selfcheck reported a failure (${summary})`);
}

fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
fs.writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      _doc: 'Written by workers/pwsh/build.mjs. Nothing is compiled: the artifact IS the source file. This manifest records what the run was checked against, so an edit to the script or to the shared tables is noticed.',
      artifact: ARTIFACT,
      language: 'pwsh',
      interpreter: { command: interpreter.command, version: interpreter.version },
      sources: SOURCES,
      sourceSignature: signature,
      selfcheck: summary,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

process.stdout.write(`pwsh ${interpreter.version} (${interpreter.command}); selfcheck ${summary}\n`);
process.stdout.write(`${ARTIFACT}\n`);

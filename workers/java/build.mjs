// workers/java/build.mjs — build the Java worker.
//
//   node workers/java/build.mjs
//
// Compiles workers/java/src with `javac -encoding UTF-8` into workers/java/dist/classes, packs
// workers/java/dist/vmltext.jar with `jar`, and prints the artifact path as its last stdout line.
// Portable and offline: nothing is downloaded and no third-party dependency is involved. If no JDK
// is found it fails with one clear English sentence on stderr and a non-zero exit.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const DIST = path.join(HERE, 'dist');
const CLASSES = path.join(DIST, 'classes');
const MANIFEST = path.join(DIST, 'MANIFEST.MF');
const JAR = path.join(DIST, 'vmltext.jar');
const MAIN_CLASS = 'vml.TextWorker';

/** One clear English line on stderr, then a non-zero exit. */
function fail(message) {
  process.stderr.write(`build.mjs: ${message}\n`);
  process.exit(1);
}

function run(file, args) {
  // stdio: 'inherit' keeps this portable and avoids capturing another process's pipes.
  return spawnSync(file, args, { stdio: 'inherit' });
}

/** javac.exe / java.exe next to a java binary, for JAVA_HOME that points at a JRE-style layout. */
function withTool(dir, name) {
  return path.join(dir, 'bin', name);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable candidate is simply not a candidate.
    }
  }
  return null;
}

function findJavac() {
  const names = process.platform === 'win32' ? ['javac.exe', 'javac'] : ['javac'];
  const candidates = [];
  const home = process.env.JAVA_HOME;
  if (home) for (const name of names) candidates.push(withTool(home, name));
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Java\\jdk-17\\bin\\javac.exe');
  }
  const found = firstExisting(candidates);
  if (found) return found;
  // Fall back to PATH.
  const probe = run(names[0], ['-version']);
  return probe.error ? null : names[0];
}

function findJarTool(javac) {
  const name = process.platform === 'win32' ? 'jar.exe' : 'jar';
  const beside = path.join(path.dirname(javac), name);
  if (fs.existsSync(beside)) return beside;
  return name; // PATH
}

function javaSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...javaSources(full));
    else if (entry.isFile() && entry.name.endsWith('.java')) out.push(full);
  }
  return out.sort();
}

function writeManifest() {
  const lines = [
    'Manifest-Version: 1.0',
    `Main-Class: ${MAIN_CLASS}`,
    'Implementation-Title: vml text worker (java)',
    'Implementation-Version: 1.0',
    'Created-By: workers/java/build.mjs',
    // A note for anyone who inspects the jar by hand: the worker sets up its own UTF-8 streams,
    // because System.out uses the platform code page on Java 17 (docs/WORKERS.md section 1.2).
    'X-Text-Encoding: UTF-8',
    '',
  ];
  fs.writeFileSync(MANIFEST, lines.join('\r\n'), 'utf8');
}

const javac = findJavac();
if (!javac) {
  fail('no JDK found: set JAVA_HOME to a JDK 17 installation (javac must be on JAVA_HOME/bin or on PATH)');
}

const sources = javaSources(SRC);
if (sources.length === 0) {
  fail(`no .java sources under ${SRC}`);
}

// Clean only what this script writes. `dist/` also holds the search worker's jar now (built by
// build-search.mjs), and wiping the whole directory here silently deleted it - the harness happened to
// build java-text first, so it never showed up as a broken run, only as a missing artifact on the next
// manual build. (Reported by the search implementation's author, fixed here rather than left as a trap.)
fs.rmSync(CLASSES, { recursive: true, force: true });
fs.rmSync(JAR, { force: true });
fs.mkdirSync(CLASSES, { recursive: true });

const compile = run(javac, [
  // Force English compiler diagnostics: the JDK otherwise localizes them to the host's language,
  // and this project's build output is English (docs/ENGLISH-LOGIC.md).
  '-J-Duser.language=en', '-J-Duser.country=US',
  '-encoding', 'UTF-8', '-source', '17', '-target', '17', '-Xlint:all', '-d', CLASSES, ...sources,
]);
if (compile.error) {
  fail(`could not run ${javac}: ${compile.error.message}`);
}
if (compile.status !== 0) {
  fail(`javac failed with exit code ${compile.status}; no artifact was produced`);
}
if (!fs.existsSync(path.join(CLASSES, ...MAIN_CLASS.split('.')) + '.class')) {
  fail('javac reported success but the main class was not produced');
}

writeManifest();

const jarTool = findJarTool(javac);
const pack = run(jarTool, ['--create', '--file', JAR, '--manifest', MANIFEST, '-C', CLASSES, '.']);
if (pack.error) {
  fail(`could not run the jar tool: ${pack.error.message}`);
}
if (pack.status !== 0) {
  fail(`the jar tool failed with exit code ${pack.status}`);
}
if (!fs.existsSync(JAR)) {
  fail(`the jar tool reported success but ${JAR} does not exist`);
}

// The host reads the artifact path from the last stdout line, relative to the repository root.
process.stdout.write(`${path.relative(process.cwd(), JAR).split(path.sep).join('/')}\n`);

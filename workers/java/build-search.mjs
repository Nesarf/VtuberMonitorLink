// workers/java/build-search.mjs — build the Java `search.query` worker.
//
//   node workers/java/build-search.mjs
//
// A sibling of build.mjs rather than a change to it, because build.mjs packs the *text* worker and
// two capabilities are two workers with two artifacts (docs/WORKERS.md section 1: one worker process
// handles one capability). Nothing here touches build.mjs's behaviour: it still compiles into
// dist/classes, packs dist/vmltext.jar, and prints that path.
//
// What this one does: compiles the search worker's sources - vml.Json (the shared hand-written JSON
// codec), vml.Tokenizer, vml.Search and vml.SearchWorker - with `javac -encoding UTF-8` into
// dist/search-classes, packs dist/vmlsearch.jar with `jar`, and prints the artifact path as its last
// stdout line, relative to the working directory, as section 6 of the contract asks.
//
// Note the deliberate asymmetry in dist/: build.mjs deletes the whole dist directory before it
// compiles, so running build.mjs after this script removes dist/vmlsearch.jar. Run this script again
// (or let the conformance runner run the registered build command for java-search, which is this
// script) before the next conformance run. It is written down in README.md rather than fixed here,
// because making build.mjs leave another artifact alone would change a file that is not this work's
// to change.
//
// Portable and offline: nothing is downloaded, no third-party dependency is involved, and if no JDK
// is found it fails with one clear English sentence on stderr and a non-zero exit.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const DIST = path.join(HERE, 'dist');
const CLASSES = path.join(DIST, 'search-classes');
const MANIFEST = path.join(DIST, 'MANIFEST-search.MF');
const JAR = path.join(DIST, 'vmlsearch.jar');
const MAIN_CLASS = 'vml.SearchWorker';

/** Compiled into this jar: the JSON codec and the search worker's own classes, and nothing else. */
const SOURCES = [
  path.join(SRC, 'vml', 'Json.java'),
  path.join(SRC, 'vml', 'Tokenizer.java'),
  path.join(SRC, 'vml', 'Search.java'),
  path.join(SRC, 'vml', 'SearchWorker.java'),
  path.join(SRC, 'vml', 'SearchSelfCheck.java'),
];

/** One clear English line on stderr, then a non-zero exit. */
function fail(message) {
  process.stderr.write(`build-search.mjs: ${message}\n`);
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
  const probe = run(names[0], ['-version']); // fall back to PATH
  return probe.error ? null : names[0];
}

function findJarTool(javac) {
  const name = process.platform === 'win32' ? 'jar.exe' : 'jar';
  const beside = path.join(path.dirname(javac), name);
  if (fs.existsSync(beside)) return beside;
  return name; // PATH
}

const javac = findJavac();
if (!javac) {
  fail('no JDK found: set JAVA_HOME to a JDK 17 installation (javac must be on JAVA_HOME/bin or on PATH)');
}

for (const source of SOURCES) {
  if (!fs.existsSync(source)) fail(`missing source ${path.relative(process.cwd(), source)}`);
}

fs.rmSync(CLASSES, { recursive: true, force: true });
fs.mkdirSync(CLASSES, { recursive: true });

const compile = run(javac, [
  // Force English compiler diagnostics: the JDK otherwise localizes them to the host's language.
  '-J-Duser.language=en', '-J-Duser.country=US',
  // This jar is the search worker; the text worker's sources are not compiled into it.
  '-encoding', 'UTF-8', '-source', '17', '-target', '17', '-Xlint:all', '-d', CLASSES, ...SOURCES,
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

// A note for anyone who inspects the jar by hand: the worker sets up its own UTF-8 streams, because
// System.out uses the platform code page on Java 17 (docs/WORKERS.md section 1.2).
fs.writeFileSync(
  MANIFEST,
  [
    'Manifest-Version: 1.0',
    `Main-Class: ${MAIN_CLASS}`,
    'Implementation-Title: vml search worker (java, inverted index)',
    'Implementation-Version: 1.0',
    'Created-By: workers/java/build-search.mjs',
    'X-Capability: search.query',
    'X-Text-Encoding: UTF-8',
    '',
  ].join('\r\n'),
  'utf8',
);

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

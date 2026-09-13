// workers/cpp/build.mjs — generates the spec-table header and compiles the C++ worker.
//
// Two jobs:
//
// 1. Code generation. docs/WORKERS.md section 2 says the case and fold tables are shared data
//    ("Every implementation reads them (or embeds them at build time); nobody consults their own
//    runtime's tables"). C++ is the language where this matters most, because it has no Unicode case
//    tables at all — there is nothing to consult even by accident. So the two JSON files are turned
//    into a C++ header here, once, at build time: the binary then carries the tables it was built
//    from, needs no file at run time, and — the reason this is a build step and not a "read the JSON
//    at startup" — stays dependency-free, with no JSON parser in the worker beyond the tiny one it
//    needs for the protocol itself. A table change is a rebuild, which is exactly the point: the
//    artifact records which revision of the spec it implements.
//
// 2. Compilation. g++ first (Strawberry GCC ships with this project's Windows tooling), then
//    clang++, then MSVC cl. No network access anywhere, no package manager, nothing to install.
//
// The artifact path is printed as the last stdout line.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // workers/cpp
const REPO = path.resolve(HERE, '..', '..');                     // repository root
const SPEC_DIR = path.join(REPO, 'workers', 'spec');
const SRC_DIR = path.join(HERE, 'src');
const DIST_DIR = path.join(HERE, 'dist');
const HEADER = path.join(SRC_DIR, 'tables.generated.h');
// The artifact name follows the platform, the way workers/registry.json declares it
// ({"win32": ".../vmltext.exe", "default": ".../vmltext"}). A hard-coded ".exe" would build fine on
// Windows and then produce a file that no host on any other platform looks for.
const ARTIFACT_NAME = process.platform === 'win32' ? 'vmltext.exe' : 'vmltext';
const ARTIFACT = path.join(DIST_DIR, ARTIFACT_NAME);
const ARTIFACT_REL = path.join('workers', 'cpp', 'dist', ARTIFACT_NAME);

const out = (line) => process.stdout.write(line + '\n');
const fail = (message) => {
  process.stderr.write('build.mjs: ' + message + '\n');
  process.exit(1);
};

// --- table generation -------------------------------------------------------------------------

/** Reads one spec table and returns its entries sorted by code point. */
function loadTable(file) {
  const full = path.join(SPEC_DIR, file);
  if (!fs.existsSync(full)) fail(`missing spec table: ${path.relative(REPO, full)}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    fail(`${path.relative(REPO, full)} is not valid JSON: ${error.message}`);
  }
  const entries = Object.entries(parsed.map ?? {}).map(([key, value]) => {
    const codePoint = Number(key);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      fail(`${file}: "${key}" is not a valid code point`);
    }
    return [codePoint, value];
  });
  entries.sort((a, b) => a[0] - b[0]);
  return entries;
}

/** A C++ string literal built from \xNN escapes, so no editor or compiler charset can interfere. */
function bytesLiteral(text, file) {
  let literal = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code > 0x7f) fail(`${file}: non-ASCII table value ${JSON.stringify(text)} is not supported`);
    literal += '\\x' + code.toString(16).padStart(2, '0');
  }
  return `"${literal}"`;
}

function generateHeader(compilerLabel) {
  const lower = loadTable('latin-lower.json');
  const fold = loadTable('latin-fold.json');

  const lines = [];
  lines.push('// GENERATED FILE - DO NOT EDIT.');
  lines.push('//');
  lines.push('// Produced by workers/cpp/build.mjs from workers/spec/latin-lower.json and');
  lines.push('// workers/spec/latin-fold.json. The contract requires every implementation to apply those');
  lines.push('// tables and not its own runtime\'s Unicode data; C++ has no such data, so the tables are');
  lines.push('// embedded here at build time and the artifact records the spec revision it was built from.');
  lines.push('#pragma once');
  lines.push('');
  lines.push('#include <cstdint>');
  lines.push('');
  lines.push('namespace vml {');
  lines.push('namespace generated {');
  lines.push('');
  lines.push(`// latin-lower.json: ${lower.length} code point -> code point entries, sorted.`);
  lines.push(`inline constexpr std::uint32_t kLowerFrom[] = {`);
  lines.push(chunkNumbers(lower.map(([cp]) => cp)));
  lines.push('};');
  lines.push('inline constexpr std::uint32_t kLowerTo[] = {');
  lines.push(chunkNumbers(lower.map(([, value]) => value)));
  lines.push('};');
  lines.push(`inline constexpr std::uint32_t kLowerCount = ${lower.length};`);
  lines.push('');
  lines.push(`// latin-fold.json: ${fold.length} code point -> ASCII string entries, sorted.`);
  lines.push('inline constexpr std::uint32_t kFoldFrom[] = {');
  lines.push(chunkNumbers(fold.map(([cp]) => cp)));
  lines.push('};');
  lines.push('inline constexpr const char* const kFoldTo[] = {');
  for (const [, value] of fold) lines.push(`    ${bytesLiteral(value, 'latin-fold.json')},`);
  lines.push('};');
  lines.push(`inline constexpr std::uint32_t kFoldCount = ${fold.length};`);
  lines.push('');
  lines.push('// The toolchain that produced this artifact, reported in the describe response.');
  lines.push(`inline constexpr const char* kCompilerId = "${compilerLabel.replace(/[\\"]/g, '\\$&')}";`);
  lines.push('');
  lines.push('}  // namespace generated');
  lines.push('}  // namespace vml');
  lines.push('');

  fs.writeFileSync(HEADER, lines.join('\n'), 'utf8');
  out(`[gen]  workers/spec/latin-lower.json -> ${path.relative(REPO, HEADER)} (${lower.length} entries)`);
  out(`[gen]  workers/spec/latin-fold.json  -> ${path.relative(REPO, HEADER)} (${fold.length} entries)`);
}

function chunkNumbers(numbers) {
  const lines = [];
  for (let i = 0; i < numbers.length; i += 10) {
    lines.push('    ' + numbers.slice(i, i + 10).map((n) => n + 'u').join(', ') + ',');
  }
  return lines.join('\n');
}

// --- compiler detection -----------------------------------------------------------------------

function probe(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) return null;             // not on PATH
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/**
 * Runs a command line through cmd.exe verbatim. Node would otherwise re-quote the string it builds
 * for CreateProcess, and the quotes and the `&&` that vcvars64.bat needs come out mangled - which
 * fails silently because the environment setup is redirected to nul.
 */
function runThroughCmd(inner, options = {}) {
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', inner], {
    windowsVerbatimArguments: true,
    ...options,
  });
}

const firstVersion = (text) => (/(\d+\.\d+(?:\.\d+)?)/.exec(text ?? '') ?? [])[1] ?? 'unknown';

/**
 * Finds MSVC. `cl` is only usable inside a developer environment - outside one it cannot find
 * its own headers - so if it is not already on PATH this looks for the Visual Studio installation
 * with vswhere and uses the vcvars64.bat that ships with it. Nothing about that search is written
 * into the repository: the path is discovered on the machine that builds, every time.
 */
function findMsvc() {
  const onPath = probe('cl', []);
  if (onPath) {
    return { command: 'cl', flavor: 'msvc', label: `MSVC cl ${firstVersion(onPath.stdout + onPath.stderr)}` };
  }
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? process.env['ProgramFiles'];
  if (!programFilesX86) return null;
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const found = probe(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ]);
  const install = (found?.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!install) return null;
  const vcvars = path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!fs.existsSync(vcvars)) return null;
  const banner = runThroughCmd(`call "${vcvars}" >nul 2>&1 && cl`, { encoding: 'utf8' });
  return {
    command: 'cl',
    flavor: 'msvc',
    vcvars,
    label: `MSVC cl ${firstVersion((banner?.stdout ?? '') + (banner?.stderr ?? ''))}`,
  };
}

function detectCompiler(forced) {
  const gcc = () => {
    const found = probe('g++', ['--version']);
    return found ? { command: 'g++', flavor: 'gcc', label: `g++ ${firstVersion(found.stdout || found.stderr)}` } : null;
  };
  const clang = () => {
    const found = probe('clang++', ['--version']);
    return found
      ? { command: 'clang++', flavor: 'gcc', label: `clang++ ${firstVersion(found.stdout || found.stderr)}` }
      : null;
  };
  const msvc = () => findMsvc();

  switch (forced) {
    case 'g++':
      return gcc();
    case 'clang++':
      return clang();
    case 'msvc':
      return msvc();
    default:
      return gcc() ?? clang() ?? msvc();
  }
}

function main() {
  const forced = (process.argv[2] === '--compiler' ? process.argv[3] : null) ?? null;
  if (forced && !['g++', 'clang++', 'msvc'].includes(forced)) {
    fail(`--compiler must be one of g++, clang++, msvc (got ${forced})`);
  }

  const compiler = detectCompiler(forced);
  if (!compiler) {
    fail(
      'no C++ compiler found' + (forced ? ` (--compiler ${forced} was requested)` : '') + '.\n' +
        'Install any one of these, or pass --compiler <g++|clang++|msvc> to pick a specific one:\n' +
        '  - Strawberry Perl, which ships a MinGW g++ on PATH\n' +
        '  - LLVM/clang, which puts clang++ on PATH\n' +
        '  - Visual Studio or its Build Tools with the "Desktop development with C++" workload;\n' +
        '    this script finds it through vswhere and calls vcvars64.bat itself, but you can also\n' +
        '    run the build from a Developer Command Prompt.',
    );
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  generateHeader(compiler.label);

  const sources = fs
    .readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.cpp'))
    .sort()
    .map((name) => path.join(SRC_DIR, name));
  if (sources.length === 0) fail(`no .cpp sources found in ${path.relative(REPO, SRC_DIR)}`);

  let command = compiler.command;
  let args;
  if (compiler.flavor === 'msvc') {
    // cl writes one .obj per source; keep them out of the directory that holds
    // the artifact, which has to stay clean enough for a host to find it.
    const objectDir = path.join(DIST_DIR, 'obj');
    fs.mkdirSync(objectDir, { recursive: true });
    args = ['/nologo', '/std:c++17', '/O2', '/EHsc', '/W4', ...sources, `/Fe:${ARTIFACT}`,
            `/Fo:${objectDir}${path.sep}`];
    out(`[cc]   ${compiler.label}`);
    if (compiler.vcvars) out(`[cc]   developer environment: vcvars64.bat from the Visual Studio install (found with vswhere)`);
    out(`[cc]   ${command} ${args.join(' ')}`);
    // vcvars64.bat is a batch file, so the compile has to run through cmd.exe.
    const inner = compiler.vcvars
      ? `call "${compiler.vcvars}" >nul 2>&1 && ${command} ${args.join(' ')}`
      : `${command} ${args.join(' ')}`;
    const result = runThroughCmd(inner, { stdio: 'inherit' });
    if (result.error) fail(`failed to run cmd.exe: ${result.error.message}`);
    if (result.status !== 0) {
      fail(
        `${compiler.label} failed with exit code ${result.status}. Outside a developer environment ` +
          'cl.exe cannot find its own headers: open a "Developer Command Prompt for VS" (or run ' +
          'vcvars64.bat) and build again, or let this script find it with vswhere.',
      );
    }
  } else {
    // Two attempts, because "-static-libgcc -static-libstdc++" are GNU flags and clang rejects them -
    // including the clang that answers to the name `g++` on macOS, which is why detecting the compiler
    // by its name is not enough. Attempt one gives a self-contained artifact where that is possible;
    // attempt two is the honest fallback, and it says so rather than failing the build. The macOS CI
    // run is what found this: the build reported `g++ 21.0.0` and then "unsupported option
    // '-static-libgcc'", and the job still went green because a build failure used to be downgraded to
    // a skip (that half is fixed in tools/workers.mjs).
    const common = ['-std=c++17', '-O2', '-Wall', '-Wextra'];
    const tail = ['-o', ARTIFACT, ...sources];
    const attempts = [
      ['-static-libgcc', '-static-libstdc++'],
      [],
    ];
    let built = false;
    for (const extra of attempts) {
      const args = [...common, ...extra, ...tail];
      out(`[cc]   ${compiler.label}: ${command} ${args.join(' ')}`);
      const result = spawnSync(command, args, { stdio: 'inherit' });
      if (result.error) fail(`failed to run ${command}: ${result.error.message}`);
      if (result.status === 0 && fs.existsSync(ARTIFACT)) {
        if (!extra.length) out('[cc]   note: built without the static link flags (this compiler does not have them)');
        built = true;
        break;
      }
      if (extra.length) out(`[cc]   ${compiler.label} rejected the static link flags; retrying without them`);
      else fail(`${compiler.label} failed with exit code ${result.status}`);
    }
    if (!built) fail(`${compiler.label} produced no artifact`);
  }

  if (!fs.existsSync(ARTIFACT)) fail(`the compiler reported success but ${ARTIFACT} does not exist`);

  out(ARTIFACT_REL);
}

main();

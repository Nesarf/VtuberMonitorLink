#!/usr/bin/env node
// workers/csharp/build.mjs - build the C# worker (docs/WORKERS.md section 6).
//
//   node workers/csharp/build.mjs
//
// One artifact comes out of this script:
//
//   workers/csharp/dist/vmltext[.exe]    text.normalize, text.extract, text.fingerprint
//
// What it does: locate the .NET SDK, report its version, publish the project into workers/csharp/dist,
// verify the artifact exists, and print the artifact path as the last stdout line (that is the line
// the host reads - see workers/go/build.mjs and workers/cpp/build.mjs for the same convention).
//
// Nothing here knows where .NET is installed on any particular machine. `dotnet` is looked for on
// PATH, and DOTNET_ROOT/DOTNET_ROOT(x86) are honoured as hints because that is what the environment
// says, not a directory one machine happened to have. There is no absolute path in this file, no
// package restore from a feed (the project has no PackageReference at all), and no network access:
// the artifact is built from the working tree it sits in.
//
// The build is expected to be WARNING-FREE. The project sets TreatWarningsAsErrors, so a warning is
// already a non-zero exit here; the stub below makes the reason legible when that happens.
//
// stdout: build diagnostics, then the artifact path. stderr: errors. Exit 0 on success, 1 on failure.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url)); // .../workers/csharp
const repoRoot = path.resolve(scriptDir, '..', '..'); // .../<repo>
const projectFile = path.join(scriptDir, 'VmlText.csproj');
const distDir = path.join(scriptDir, 'dist');

// The artifact, as workers/registry.json declares it: a platform-mapped form, because a compiled
// worker is `vmltext.exe` on Windows and `vmltext` everywhere else, and a hard-coded `.exe` would
// build fine here and then be "not built" on a Linux CI runner.
const ARTIFACT_NAME = process.platform === 'win32' ? 'vmltext.exe' : 'vmltext';
const ARTIFACT = path.join(distDir, ARTIFACT_NAME);
const ARTIFACT_REL = toPosix(path.relative(repoRoot, ARTIFACT));

// Where to look for the .NET SDK beyond PATH: the environment says so, not this repository. A local
// install belongs in workers/registry.local.json, which is gitignored and exists for exactly this.
const DOTNET_HINT_DIRS = [process.env.DOTNET_ROOT, process.env['DOTNET_ROOT(x86)']].filter(Boolean);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

const out = (line) => process.stdout.write(line + '\n');
const fail = (message) => {
  process.stderr.write('build.mjs: ' + message + '\n');
  process.exit(1);
};

function findDotnet() {
  const names = process.platform === 'win32' ? ['dotnet.exe', 'dotnet'] : ['dotnet'];
  const probe = (command) => {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore', shell: false });
    return result.error === undefined && result.status === 0;
  };

  for (const name of names) {
    if (probe(name)) return name;
  }
  for (const dir of DOTNET_HINT_DIRS) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate) && probe(candidate)) return candidate;
    }
  }
  return null;
}

/** The SDK version, read from its own report rather than from the directory layout. */
function sdkVersion(dotnet) {
  const result = spawnSync(dotnet, ['--version'], { encoding: 'utf8', shell: false });
  return result.status === 0 && result.stdout ? result.stdout.trim() : 'unknown';
}

/** The target framework the project declares, so the banner reports what was actually built. */
function targetFramework() {
  try {
    const text = readFileSync(projectFile, 'utf8');
    const match = /<TargetFramework>([^<]+)<\/TargetFramework>/.exec(text);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Runs `dotnet publish` into dist/.
 *
 * --nologo keeps the build's banner out of the way (it is not a contract violation - this is a build
 * script, not the worker - but the host prints the last stdout line, so a short log is easier to read
 * and easier to trust). No --no-restore: a project with no PackageReference still needs its obj/
 * assets file, and restore of a dependency-free project touches no feed.
 *
 * The SDK is asked for ENGLISH diagnostics. It localises them to the machine's locale otherwise, and
 * "正在确定要还原的项目" in a CI log is a build report that most of the people reading this repository
 * cannot read. DOTNET_CLI_UI_LANGUAGE and VSLANG are the documented switches for that; they are set
 * on this child only, so nothing about the caller's environment changes.
 */
function build(dotnet) {
  mkdirSync(distDir, { recursive: true });

  const args = ['publish', projectFile, '-c', 'Release', '-o', distDir, '--nologo', '-v', 'minimal'];
  out(`[publish] ${dotnet} ${args.join(' ')}`);

  const env = {
    ...process.env,
    DOTNET_CLI_UI_LANGUAGE: 'en',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    VSLANG: '1033',
  };

  // stdio "inherit": the compiler's own diagnostics go straight to the terminal. Nothing is captured,
  // so the artifact path printed at the end is still the only line this script adds after them.
  const result = spawnSync(dotnet, args, { cwd: repoRoot, env, stdio: 'inherit', shell: false });

  if (result.error) {
    fail('failed to run the .NET SDK: ' + result.error.message);
  }

  if (result.status !== 0) {
    fail(
      `dotnet publish failed with exit code ${result.status}.\n` +
        'The project is built with TreatWarningsAsErrors, so a warning fails the build too: the\n' +
        'warning text above says which one. Run it by hand for the full output:\n' +
        `  cd ${toPosix(repoRoot)} && dotnet publish ${toPosix(path.relative(repoRoot, projectFile))} -c Release -o ${toPosix(path.relative(repoRoot, distDir))}`,
    );
  }

  if (!existsSync(ARTIFACT) || !statSync(ARTIFACT).isFile()) {
    fail(`the SDK reported success but ${ARTIFACT_REL} does not exist.`);
  }
}

/** A one-line inventory of what the SDK actually emitted, so an unexpected extra file is visible. */
function reportDist() {
  const names = readdirSync(distDir).sort();
  out(`[dist]   ${names.join(' ')}`);
}

function main() {
  if (!existsSync(projectFile)) {
    fail(`cannot find the project file ${toPosix(path.relative(repoRoot, projectFile))}`);
  }

  const dotnet = findDotnet();
  if (!dotnet) {
    fail(
      'cannot find the .NET SDK.\n' +
        'build.mjs: looked for "dotnet" on PATH and for <dir>' + path.sep + 'dotnet under: ' +
        (DOTNET_HINT_DIRS.join(', ') || '(no hint directories set)') + '\n' +
        'build.mjs: install the .NET SDK (8.0 or newer), or set DOTNET_ROOT to the installation directory.',
    );
  }

  out(`[sdk]    dotnet ${sdkVersion(dotnet)} (${dotnet}), target framework ${targetFramework()}`);
  build(dotnet);
  reportDist();
  out(ARTIFACT_REL); // the last line is the artifact path, as the host expects
}

main();

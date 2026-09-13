#!/usr/bin/env node
// workers/go/build.mjs - build the Go workers (docs/WORKERS.md section 6).
//
// Two artifacts come out of this one script, because one module holds both programs:
//
//   workers/go/dist/vmltext[.exe]    the package at the module root: text.normalize, text.extract,
//                                    text.fingerprint
//   workers/go/dist/vmlfetch[.exe]   ./cmd/fetch: fetch.plan
//
// Standard library only, no network at build time: GOFLAGS=-mod=mod and GOPROXY=off are set, which is
// enough because go.mod declares no dependency at all. Run from anywhere:
//
//   node workers/go/build.mjs
//
// stdout: build diagnostics, then the artifact paths, one per line, each as soon as it is built (the
// host reads the last line). stderr: errors. Exit code 0 on success, 1 on failure. Nothing here
// downloads anything, and nothing here knows where Go is installed on any particular machine.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url)); // .../workers/go
const repoRoot = path.resolve(scriptDir, "..", ".."); // .../<repo>

// The artifacts, as workers/registry.json declares them. The name follows the platform: a compiled
// worker is `vmltext.exe` on Windows and `vmltext` everywhere else. A hard-coded `.exe` would build
// fine here and then be "not built" on a Linux CI runner.
const ARTIFACT_SUFFIX = process.platform === "win32" ? ".exe" : "";
const BUILD_TARGETS = [
  {
    // The module root holds the text worker's package, so its build target is ".".
    id: "go-text",
    packageDir: ".",
    artifactAbs: path.join(scriptDir, "dist", "vmltext" + ARTIFACT_SUFFIX),
  },
  {
    id: "go-fetch",
    packageDir: "./cmd/fetch",
    artifactAbs: path.join(scriptDir, "dist", "vmlfetch" + ARTIFACT_SUFFIX),
  },
];

// Where to look for Go beyond PATH: the environment says so, not this repository.
//
// This line has now had a hard-coded directory from one machine added to it twice, both times with a
// reasonable-sounding justification ("a last-resort fallback", "a worker that cannot be built where
// it ships from is worse"). It is still wrong both times: the repository is published, the release
// checks reject machine-specific paths, and a build script that only works on the machine that wrote
// it is not a build script. A local install belongs in workers/registry.local.json, which is
// gitignored and exists for exactly this.
const GO_HINT_DIRS = [process.env.GO_ROOT, process.env.GOROOT].filter(Boolean);

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function findGo() {
  const exe = process.platform === "win32" ? "go.exe" : "go";
  const names = process.platform === "win32" ? [exe, "go"] : ["go"];

  const probe = (command) => {
    const result = spawnSync(command, ["version"], { stdio: "ignore", shell: false });
    return result.error === undefined && result.status === 0;
  };

  for (const name of names) {
    if (probe(name)) return name;
  }
  for (const dir of GO_HINT_DIRS) {
    for (const name of names) {
      const candidate = path.join(dir, "bin", name);
      if (existsSync(candidate) && probe(candidate)) return candidate;
    }
  }
  return null;
}

/** Build one package and print its artifact path. Returns true on success. */
function buildTarget(go, target) {
  const artifactRel = toPosix(path.relative(repoRoot, target.artifactAbs));
  mkdirSync(path.dirname(target.artifactAbs), { recursive: true });

  const env = {
    ...process.env,
    GOFLAGS: "-mod=mod",
    GOPROXY: "off",
    CGO_ENABLED: "0",
  };

  process.stdout.write("build.mjs: go build -o " + artifactRel + " " + target.packageDir + " (" + target.id + ")\n");
  // stdio "inherit" on purpose: the build's own diagnostics go straight to the terminal, and nothing
  // of them is captured, so the artifact paths below are still the only lines we print.
  const build = spawnSync(go, ["build", "-o", target.artifactAbs, target.packageDir], {
    cwd: scriptDir,
    env,
    stdio: "inherit",
    shell: false,
  });

  if (build.error) {
    console.error("build.mjs: failed to run the Go compiler: " + build.error.message);
    return false;
  }
  if (build.status !== 0) {
    console.error("build.mjs: go build failed with exit code " + build.status + " for " + target.id + ".");
    console.error("build.mjs: run it by hand for the full output: cd " + toPosix(scriptDir) + " && go build -o dist/" + path.basename(target.artifactAbs) + " " + target.packageDir);
    return false;
  }
  if (!existsSync(target.artifactAbs) || !statSync(target.artifactAbs).isFile()) {
    console.error("build.mjs: go build reported success but " + artifactRel + " does not exist.");
    return false;
  }

  process.stdout.write(artifactRel + "\n"); // one artifact path per target
  return true;
}

function main() {
  const go = findGo();
  if (!go) {
    console.error("build.mjs: cannot find the Go toolchain.");
    console.error("build.mjs: looked for \"go\" on PATH and for <dir>" + path.sep + "bin" + path.sep + "go under: " + (GO_HINT_DIRS.join(", ") || "(no hint directories set)"));
    console.error("build.mjs: install Go, or set GO_ROOT to the Go installation directory.");
    process.exit(1);
  }

  const version = spawnSync(go, ["version"], { encoding: "utf8", shell: false });
  if (version.status === 0 && version.stdout) {
    process.stdout.write("build.mjs: " + version.stdout.trim() + "\n");
  }

  for (const target of BUILD_TARGETS) {
    if (!buildTarget(go, target)) process.exit(1);
  }
}

main();

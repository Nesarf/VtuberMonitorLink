#!/usr/bin/env node
// workers/go/build.mjs - build the Go text worker (docs/WORKERS.md section 6).
//
// Standard library only, no network at build time: GOFLAGS=-mod=mod and GOPROXY=off are set, which
// is enough because go.mod declares no dependency at all. Run from anywhere:
//
//   node workers/go/build.mjs
//
// stdout: build diagnostics, then the artifact path as the LAST line (the host reads that line).
// stderr: errors. Exit code 0 on success, 1 on failure. Nothing here downloads anything.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url)); // .../workers/go
const repoRoot = path.resolve(scriptDir, "..", ".."); // .../<repo>
// The artifact name follows the platform, as workers/registry.json declares it: a compiled worker is
// `vmltext.exe` on Windows and `vmltext` everywhere else. A hard-coded `.exe` would build fine here
// and then be "not built" on a Linux CI runner.
const ARTIFACT_NAME = process.platform === "win32" ? "vmltext.exe" : "vmltext";
const artifactAbs = path.join(scriptDir, "dist", ARTIFACT_NAME);
const artifactRel = toPosix(path.relative(repoRoot, artifactAbs));

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

  mkdirSync(path.dirname(artifactAbs), { recursive: true });

  const env = {
    ...process.env,
    GOFLAGS: "-mod=mod",
    GOPROXY: "off",
    CGO_ENABLED: "0",
  };

  process.stdout.write("build.mjs: go build -o " + artifactRel + "\n");
  // stdio "inherit" on purpose: the build's own diagnostics go straight to the terminal, and
  // nothing of them is captured, so the artifact path below is still the last line we print.
  const build = spawnSync(go, ["build", "-o", artifactAbs, "."], {
    cwd: scriptDir,
    env,
    stdio: "inherit",
    shell: false,
  });

  if (build.error) {
    console.error("build.mjs: failed to run the Go compiler: " + build.error.message);
    process.exit(1);
  }
  if (build.status !== 0) {
    console.error("build.mjs: go build failed with exit code " + build.status + ".");
    console.error("build.mjs: run it by hand for the full output: cd " + toPosix(scriptDir) + " && go build -o dist/" + ARTIFACT_NAME + " .");
    process.exit(1);
  }
  if (!existsSync(artifactAbs) || !statSync(artifactAbs).isFile()) {
    console.error("build.mjs: go build reported success but " + artifactRel + " does not exist.");
    process.exit(1);
  }

  process.stdout.write(artifactRel + "\n"); // last stdout line: the artifact path
}

main();

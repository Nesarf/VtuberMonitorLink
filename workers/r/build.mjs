#!/usr/bin/env node
/**
 * workers/r/build.mjs — build step for the R text worker (docs/WORKERS.md section 6).
 *
 * The R worker sources the shared case and fold tables from a single generated R file instead of
 * parsing JSON at startup: base R has no JSON parser, and the whole point of those tables is that
 * every implementation reads the same data rather than its runtime's Unicode tables. So this script
 * turns
 *
 *   workers/spec/latin-lower.json   (code point -> code point)
 *   workers/spec/latin-fold.json    (code point -> ASCII string of one or two characters)
 *
 * into
 *
 *   workers/r/tables.generated.R    (VML_LOWER, VML_FOLD, both indexed by code point + 1)
 *
 * and then proves the result loads by running the worker's own --selfcheck.
 *
 * Nothing here is machine-specific: the generated file is pure ASCII integers and the artifact path
 * printed on the last line is relative to the repository root. The machine's Rscript is found on
 * PATH, from $RSCRIPT, from $R_HOME/bin, or from the gitignored workers/registry.local.json
 * overlay — never hard-coded, because the release checks reject machine-specific paths in the
 * published tree.
 *
 * Usage from the repository root:  node workers/r/build.mjs
 * Output: English diagnostics on stdout, then the artifact path as the LAST stdout line.
 * Errors: English on stderr, exit 1. Nothing is downloaded and nothing outside workers/r is touched.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../workers/r
const repoRoot = path.resolve(here, '..', '..');           // .../<repo>
const specDir = path.join(repoRoot, 'workers', 'spec');
const artifactAbs = path.join(here, 'tables.generated.R');
const artifactRel = 'workers/r/tables.generated.R';
const workerRel = 'workers/r/vmltext.R';
const workerAbs = path.join(here, 'vmltext.R');

const SOURCES = [
  { file: 'latin-lower.json', role: 'lowercase table (step 3 of text.normalize)' },
  { file: 'latin-fold.json', role: 'accent fold table (step 4 of text.normalize)' },
];

/** Where is R on this machine? PATH, $RSCRIPT, $R_HOME/bin, then the machine-local overlay. */
function findRscript() {
  const exe = process.platform === 'win32' ? 'Rscript.exe' : 'Rscript';
  const probe = (cmd) => {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: false });
    return r.error === undefined && r.status === 0;
  };
  const candidates = [];
  if (process.env.RSCRIPT) candidates.push({ cmd: process.env.RSCRIPT, how: '$RSCRIPT' });
  candidates.push({ cmd: exe, how: 'PATH' });
  if (process.env.R_HOME) {
    candidates.push({ cmd: path.join(process.env.R_HOME, 'bin', exe), how: '$R_HOME/bin' });
  }
  const overlay = path.join(repoRoot, 'workers', 'registry.local.json');
  if (existsSync(overlay)) {
    try {
      const local = JSON.parse(readFileSync(overlay, 'utf8'));
      for (const w of local.workers ?? []) {
        if (w.id === 'r-text' && Array.isArray(w.launch) && typeof w.launch[0] === 'string') {
          candidates.push({ cmd: w.launch[0], how: 'workers/registry.local.json (worker id "r-text")' });
        }
      }
    } catch (e) {
      console.error(`build.mjs: workers/registry.local.json is not valid JSON (${e.message}); ignored`);
    }
  }
  for (const c of candidates) {
    if (c.how !== 'PATH' && !existsSync(c.cmd) && !c.cmd.includes(path.sep) && !c.cmd.includes('/')) continue;
    if (probe(c.cmd)) return c;
  }
  return null;
}

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function toAscii(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?');
}

/** "12L, 34L" wrapped so the generated file stays readable in a diff. */
function emitIntVector(values, perLine = 16) {
  const lines = [];
  for (let i = 0; i < values.length; i += perLine) {
    lines.push('  ' + values.slice(i, i + perLine).map((v) => `${v}L`).join(', ') + (i + perLine < values.length ? ',' : ''));
  }
  return lines.join('\n');
}

function emitList(elements, perLine = 8) {
  const items = elements.map((v) => (v === null ? 'NULL' : `c(${v.map((c) => `${c}L`).join(', ')})`));
  const lines = [];
  for (let i = 0; i < items.length; i += perLine) {
    lines.push('  ' + items.slice(i, i + perLine).join(', ') + (i + perLine < items.length ? ',' : ''));
  }
  return lines.join('\n');
}

function main() {
  const rscript = findRscript();
  if (!rscript) {
    fail([
      'build.mjs: cannot find Rscript.',
      'build.mjs: looked for Rscript on PATH, in $RSCRIPT, in $R_HOME/bin, and in workers/registry.local.json (worker id "r-text").',
      'build.mjs: install R, put Rscript on PATH, or set RSCRIPT to the full path of Rscript (Rscript.exe on Windows) and re-run:',
      'build.mjs:   node workers/r/build.mjs',
    ]);
  }
  console.log(`build.mjs: Rscript: ${rscript.cmd} (found via ${rscript.how})`);

  if (!existsSync(workerAbs)) {
    fail([`build.mjs: ${workerRel} is missing; there is nothing to build tables for.`]);
  }

  const tables = [];
  for (const src of SOURCES) {
    const p = path.join(specDir, src.file);
    if (!existsSync(p)) fail([`build.mjs: ${path.relative(repoRoot, p) || src.file} is missing; it is the shared table, not a local copy.`]);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      fail([`build.mjs: ${path.posix.join('workers/spec', src.file)} is not valid JSON: ${e.message}`]);
    }
    const map = parsed.map;
    if (!map || typeof map !== 'object') {
      fail([`build.mjs: workers/spec/${src.file} has no "map" object.`]);
    }
    tables.push({ ...src, map });
  }

  const MAX_INDEX = 592; // U+0000-U+024F, index = code point + 1
  const lower = new Array(MAX_INDEX).fill(0);
  const fold = new Array(MAX_INDEX).fill(null);

  // The generated R vector is indexed by code point + 1, and a JavaScript array index i becomes
  // R's element i + 1 — so the array slot for a code point is the code point itself. Writing
  // lower[cp + 1] here would shift the whole table one place and turn H into g.
  for (const [key, value] of Object.entries(tables[0].map)) {
    const cp = Number(key);
    if (!Number.isInteger(cp) || cp < 0 || cp >= MAX_INDEX) fail([`build.mjs: latin-lower.json: code point ${key} is outside U+0000-U+024F.`]);
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) fail([`build.mjs: latin-lower.json: value ${value} for ${key} is not a code point.`]);
    if (value >= 0xd800 && value <= 0xdfff) fail([`build.mjs: latin-lower.json: value ${value} for ${key} is a surrogate code point.`]);
    if (lower[cp] !== 0) fail([`build.mjs: latin-lower.json: duplicate entry for ${key}.`]);
    lower[cp] = value;
  }
  for (const [key, value] of Object.entries(tables[1].map)) {
    const cp = Number(key);
    if (!Number.isInteger(cp) || cp < 0 || cp >= MAX_INDEX) fail([`build.mjs: latin-fold.json: code point ${key} is outside U+0000-U+024F.`]);
    if (typeof value !== 'string' || value.length < 1 || value.length > 2) fail([`build.mjs: latin-fold.json: value for ${key} is not an ASCII string of one or two characters.`]);
    const cps = [...value].map((ch) => ch.codePointAt(0));
    if (cps.some((c) => c > 0x7f)) fail([`build.mjs: latin-fold.json: value for ${key} is not ASCII (the fold table is an ASCII fold table).`]);
    if (fold[cp] !== null) fail([`build.mjs: latin-fold.json: duplicate entry for ${key}.`]);
    fold[cp] = cps;
  }

  const header = [
    '# workers/r/tables.generated.R',
    '#',
    '# GENERATED FILE - do not edit by hand. Re-run: node workers/r/build.mjs',
    '#',
    '# Source of truth (shared by every implementation, in every language):',
    ...tables.map((t) => `#   workers/spec/${t.file}  -  ${toAscii(t.role)}`),
    '#',
    '# R has no JSON parser in base, so this file is the one place where those tables enter the R',
    '# worker. Each table is indexed by code point + 1 over U+0000-U+024F:',
    '#   VML_LOWER[[cp + 1]]  integer, 0 means "not in the table"; otherwise the lowercase code point',
    '#   VML_FOLD[[cp + 1]]   NULL means "not in the table"; otherwise ASCII code points, 1 or 2 of them',
    '# Everything here is an ASCII integer, so this file parses identically in any locale.',
    '',
    'VML_LOWER <- as.integer(c(',
    emitIntVector(lower),
    '))',
    '',
    'VML_FOLD <- list(',
    emitList(fold),
    ')',
    '',
  ].join('\n');

  if (!/^[\x00-\x7f]*$/.test(header)) fail(['build.mjs: refusing to write a non-ASCII generated file.']);
  writeFileSync(artifactAbs, header, 'utf8');
  console.log(`build.mjs: wrote ${artifactRel} (${lower.length} lower entries, ${fold.filter(Boolean).length} fold entries)`);
  console.log(`build.mjs: source hash ${tables.map((t) => JSON.stringify(t.map).length).join('/')} (bytes of canonical map JSON)`);

  // Prove the generated tables load and that the worker still answers its own cases. The selfcheck
  // report goes to stdout by contract; capture it so the artifact path stays the last line here.
  const check = spawnSync(rscript.cmd, [workerRel, '--selfcheck'], { cwd: repoRoot, encoding: 'utf8', shell: false });
  if (check.error) {
    fail([`build.mjs: could not run ${rscript.cmd}: ${check.error.message}`]);
  }
  const checkOut = String(check.stdout ?? '');
  const summary = checkOut.split('\n').find((l) => l.includes('checks passed'));
  if (check.status !== 0) {
    fail([
      `build.mjs: ${workerRel} --selfcheck exited ${check.status}; the generated tables are not usable.`,
      ...checkOut.split('\n').filter((l) => l.trim()).map((l) => `  ${l}`),
      ...String(check.stderr ?? '').split('\n').filter((l) => l.trim()).map((l) => `  stderr: ${l}`),
    ]);
  }
  if (summary) console.log(`build.mjs: selfcheck: ${summary.trim()}`);

  process.stdout.write(artifactRel + '\n'); // last stdout line: the artifact path
}

main();

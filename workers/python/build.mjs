#!/usr/bin/env node
/**
 * Build step for the Python text worker.
 *
 * Python needs no compilation: workers/python/vmltext.py *is* the artifact, and the host launches it
 * with `python workers/python/vmltext.py --capability <name>`. This script therefore does not build
 * anything -- it discovers the interpreter the machine actually has, proves it can run the artifact,
 * prints the interpreter command and the artifact path, and exits non-zero with an English message
 * when no usable interpreter is present, so `npm run workers -- --list` reports the worker as
 * [skip] rather than as a pass.
 *
 * Last stdout line is the artifact path (relative to the repository root).
 *
 * Usage from the repository root:  node workers/python/build.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const artifact = path.join('workers', 'python', 'vmltext.py');
const artifactAbs = path.join(here, 'vmltext.py');

if (!existsSync(artifactAbs)) {
  console.error(`[python-text] FAIL: artifact is missing: ${artifact}`);
  process.exit(1);
}

/** `python`, then `py -3`; anything that answers with a Python 3 version is accepted. */
const candidates = [
  { label: 'python', command: 'python', args: [] },
  { label: 'py -3', command: 'py', args: ['-3'] },
];

function probe(candidate) {
  const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) return null; // not installed / not on PATH
  if (result.status !== 0) return null;
  const banner = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0].trim();
  if (!/^Python 3\.\d+/.test(banner)) return null;
  return banner;
}

let chosen = null;
let banner = '';
for (const candidate of candidates) {
  const found = probe(candidate);
  if (found) {
    chosen = candidate;
    banner = found;
    break;
  }
  console.error(`[python-text] ${candidate.label}: no usable interpreter (skipped)`);
}

if (!chosen) {
  console.error('[python-text] FAIL: no Python 3 interpreter found.');
  console.error('[python-text] Tried: python --version, py -3 --version.');
  console.error('[python-text] Install Python 3.13+ (or put it on PATH) and re-run:');
  console.error('[python-text]   node workers/python/build.mjs');
  process.exit(1);
}

// Python needs no compilation, but the artifact must at least start and load the shared tables.
const selfcheck = spawnSync(chosen.command, [...chosen.args, artifact, '--selfcheck'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: false,
});
if (selfcheck.error) {
  console.error(`[python-text] FAIL: could not run ${chosen.label}: ${selfcheck.error.message}`);
  process.exit(1);
}
if (selfcheck.status !== 0) {
  console.error(`[python-text] FAIL: ${artifact} --selfcheck exited ${selfcheck.status}`);
  for (const line of `${selfcheck.stdout ?? ''}`.split('\n')) {
    if (line.includes('[FAIL]') || line.includes('checks passed')) console.error(`  ${line}`);
  }
  for (const line of `${selfcheck.stderr ?? ''}`.trim().split('\n')) {
    if (line.trim()) console.error(`  ${line}`);
  }
  process.exit(1);
}
const summary = `${selfcheck.stdout ?? ''}`.split('\n').find((l) => l.includes('checks passed'));

console.log(`[python-text] interpreter: ${chosen.label} (${banner})`);
console.log('[python-text] no build step: Python is interpreted, the source file is the artifact');
console.log(`[python-text] launch: ${chosen.label} ${artifact} --capability <name>`);
if (summary) console.log(`[python-text] selfcheck: ${summary.trim()}`);
console.log(artifact);

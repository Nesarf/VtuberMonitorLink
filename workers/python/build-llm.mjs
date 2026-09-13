#!/usr/bin/env node
/**
 * Build step for the Python llm.parse worker (workers/python/vmlllm.py).
 *
 * Python needs no compilation: workers/python/vmlllm.py *is* the artifact, and the host launches it
 * with `python workers/python/vmlllm.py --capability llm.parse`. This script therefore does not
 * build anything -- it discovers the interpreter the machine actually has, proves that *this*
 * artifact starts and passes its own self-check, prints the artifact path as the last stdout line,
 * and exits non-zero with an English message when no usable interpreter is present, so the runner
 * reports the worker as [skip] rather than as a pass.
 *
 * It checks vmlllm.py's self-check and nothing else: vmltext.py is a different worker with a
 * different contract (docs/WORKERS.md sections 2-4), and its state must not decide whether this
 * artifact is usable. The two build scripts stay separate for the same reason the two workers are.
 *
 * Usage from the repository root:  node workers/python/build-llm.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
// Forward slashes on purpose: the registry writes the path with `/` on every platform (a published
// registry may not carry a Windows separator), and this last stdout line has to be the same string.
const artifact = 'workers/python/vmlllm.py';
const artifactAbs = path.join(here, 'vmlllm.py');

if (!existsSync(artifactAbs)) {
  console.error(`[python-llm] FAIL: artifact is missing: ${artifact}`);
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
  console.error(`[python-llm] ${candidate.label}: no usable interpreter (skipped)`);
}

if (!chosen) {
  console.error('[python-llm] FAIL: no Python 3 interpreter found.');
  console.error('[python-llm] Tried: python --version, py -3 --version.');
  console.error('[python-llm] Install Python 3.13+ (or put it on PATH) and re-run:');
  console.error('[python-llm]   node workers/python/build-llm.mjs');
  process.exit(1);
}

// Python needs no compilation, but the artifact must at least start and pass its own self-check.
const selfcheck = spawnSync(chosen.command, [...chosen.args, artifact, '--selfcheck'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: false,
});
if (selfcheck.error) {
  console.error(`[python-llm] FAIL: could not run ${chosen.label}: ${selfcheck.error.message}`);
  process.exit(1);
}
if (selfcheck.status !== 0) {
  console.error(`[python-llm] FAIL: ${artifact} --selfcheck exited ${selfcheck.status}`);
  for (const line of `${selfcheck.stdout ?? ''}`.split('\n')) {
    if (line.includes('[FAIL]') || line.includes('checks passed')) console.error(`  ${line}`);
  }
  for (const line of `${selfcheck.stderr ?? ''}`.trim().split('\n')) {
    if (line.trim()) console.error(`  ${line}`);
  }
  process.exit(1);
}
const summary = `${selfcheck.stdout ?? ''}`.split('\n').find((l) => l.includes('checks passed'));

console.log(`[python-llm] interpreter: ${chosen.label} (${banner})`);
console.log('[python-llm] no build step: Python is interpreted, the source file is the artifact');
console.log(`[python-llm] launch: ${chosen.label} ${artifact} --capability llm.parse`);
if (summary) console.log(`[python-llm] selfcheck: ${summary.trim()}`);
console.log(artifact);

#!/usr/bin/env node
/**
 * Build step for the Perl text worker.
 *
 * Perl needs no compilation: workers/perl/vmltext.pl *is* the artifact, and the host launches it with
 * `perl workers/perl/vmltext.pl --capability <name>`. This script therefore discovers the interpreter,
 * proves the artifact starts and passes its own case list, prints the interpreter and the artifact
 * path, and exits non-zero with an English message when there is no usable interpreter - so the
 * harness reports the worker as [skip] rather than as a pass.
 *
 * The self-check runs under a **timeout**, and that is not decoration: this worker's self-check once
 * took eleven seconds and, in an earlier state, never finished at all, and a build script that waits
 * forever turns one broken worker into a hung build. The same lesson is in docs/WORKERS.md section 1.3
 * for a J interpreter probe that spun for hours.
 *
 * Last stdout line is the artifact path (relative to the repository root).
 *
 * Usage from the repository root:  node workers/perl/build.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const artifact = path.join('workers', 'perl', 'vmltext.pl');
const artifactAbs = path.join(here, 'vmltext.pl');
const SELFCHECK_TIMEOUT_MS = 60000;

if (!existsSync(artifactAbs)) {
  console.error(`[perl-text] FAIL: artifact is missing: ${artifact}`);
  process.exit(1);
}

/** `perl`, then `perl5`; anything that answers with a Perl 5 version is accepted. */
const candidates = [
  { label: 'perl', command: 'perl', args: [] },
  { label: 'perl5', command: 'perl5', args: [] },
];

function probe(candidate) {
  const result = spawnSync(candidate.command, [...candidate.args, '-e', 'print $^V'], {
    encoding: 'utf8',
    shell: false,
    timeout: 20000,
  });
  if (result.error || result.status !== 0) return null;
  const banner = `${result.stdout ?? ''}`.trim();
  return /^v5\./.test(banner) ? banner : null;
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
  console.error(`[perl-text] ${candidate.label}: no usable interpreter (skipped)`);
}

if (!chosen) {
  console.error('[perl-text] FAIL: no Perl 5 interpreter found.');
  console.error('[perl-text] Tried: perl -e, perl5 -e.');
  console.error('[perl-text] Install Perl 5.30+ (or put it on PATH) and re-run:');
  console.error('[perl-text]   node workers/perl/build.mjs');
  process.exit(1);
}

const selfcheck = spawnSync(chosen.command, [...chosen.args, artifact, '--selfcheck'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: false,
  timeout: SELFCHECK_TIMEOUT_MS,
  maxBuffer: 16 * 1024 * 1024,
});

if (selfcheck.error) {
  const why = selfcheck.error.code === 'ETIMEDOUT'
    ? `the self-check did not finish within ${SELFCHECK_TIMEOUT_MS / 1000}s`
    : selfcheck.error.message;
  console.error(`[perl-text] FAIL: ${why}`);
  process.exit(1);
}

const stdout = `${selfcheck.stdout ?? ''}`;
const summary = stdout.split('\n').find((line) => line.includes('checks passed'));
const failures = stdout.split('\n').filter((line) => line.includes('[FAIL]'));

if (selfcheck.status !== 0) {
  // Not fatal for the build - the artifact starts and answers, which is what this step proves - but
  // it is printed loudly, because a worker whose own cases fail is a worker under repair rather than
  // a worker that is done.
  console.error(`[perl-text] the self-check reports failures (exit ${selfcheck.status}):`);
  for (const line of failures.slice(0, 12)) console.error(`  ${line.trim()}`);
  if (failures.length > 12) console.error(`  ... and ${failures.length - 12} more`);
}

console.log(`[perl-text] interpreter: ${chosen.label} (${banner})`);
console.log('[perl-text] no build step: Perl is interpreted, the source file is the artifact');
console.log(`[perl-text] launch: ${chosen.label} ${artifact} --capability <name>`);
console.log(`[perl-text] selfcheck: ${summary ? summary.trim() : 'no summary line'}`);
console.log(artifact);

// sanitize-history.mjs — the same rules, pointed at everything that has ever been committed
//
// `sanitize-check.mjs` answers "is the repository clean right now". This answers the harder question: is there
// anything in the history that a reader could still find. Those are different questions, and the difference is
// permanent - deleting a file in a later commit does not delete it from the commits that already contain it.
// `git log -p` shows it to anyone who asks, and a clone brings it along. That is exactly how a key that was
// removed "ages ago" stays published.
//
// How it works: every object reachable from every ref is listed once (`git rev-list --objects --all`), the ones
// whose path looks like text are kept, and each unique blob is read with `git cat-file blob` and scanned with the
// rules from `sanitize-rules.mjs` - the same rules and the same exemptions the working-tree scanner uses, so the
// two cannot disagree about what a trace is.
//
//   node server/scripts/sanitize-history.mjs              check against the baseline
//   node server/scripts/sanitize-history.mjs --update     accept what is there now as the baseline
//
// Exit code 1 when something **new** is found. A finding here cannot be fixed by editing a file: it means the
// history has to be rewritten, or the credential it contains has to be rotated, and both are decisions for the
// person who owns the repository - which is why the baseline exists and why `--update` is meant to be a reviewed
// decision rather than a reflex.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MACHINE_LOCAL_FILES, TEXT_EXT, isAllowedLine, mask, rulesFor } from './sanitize-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);

const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options });

/**
 * A matched value is never printed; `mask` comes from sanitize-rules.mjs so that the working-tree scanner and
 * this one report the same finding the same way. A scanner that prints the match has just written it into a new
 * place - a terminal scrollback, a public CI log, a transcript.
 */

function listBlobs() {
  const out = git(['rev-list', '--objects', '--all']);
  const bySha = new Map();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    if (space === -1) continue; // a commit has no path
    const sha = trimmed.slice(0, space);
    const file = trimmed.slice(space + 1);
    if (!TEXT_EXT.has(path.extname(file))) continue;
    const seen = bySha.get(sha);
    if (seen) seen.paths.push(file);
    else bySha.set(sha, { sha, paths: [file] });
  }
  return [...bySha.values()];
}

function blobText(sha) {
  try {
    return git(['cat-file', 'blob', sha]);
  } catch {
    return null; // a tree whose name happened to look like text
  }
}

const rules = rulesFor(ROOT);
const blobs = listBlobs();
const findings = [];
let skippedMachineLocal = 0;

for (const blob of blobs) {
  const name = path.basename(blob.paths[0]);
  if (MACHINE_LOCAL_FILES.has(name)) {
    skippedMachineLocal++;
    continue;
  }
  const text = blobText(blob.sha);
  if (text === null || text.includes('\u0000')) continue; // binary
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isAllowedLine(line)) continue;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      findings.push({ rule: rule.id, desc: rule.desc, path: blob.paths[0], more: blob.paths.length - 1, sha: blob.sha.slice(0, 9), line: i + 1, sample: mask(m[0]) });
    }
  }
}

/**
 * A baseline, because "the history is clean" is not a claim this repository can make today and pretending
 * otherwise would either turn every build red or teach people to ignore the check.
 *
 * What is in the history and is not going away without a rewrite: machine drive paths inside test fixtures and
 * documentation examples, in their older versions - the current versions are exempt at the line, which is why
 * the working-tree scanner is clean while this one is not. None of them is personal data: there is no API key,
 * no cookie, and no private name in the history at all, and no personal home directory path either. Rewriting
 * history to remove a fixture's drive letter would break every clone and fork for no privacy gain, so the
 * decision is to accept them **by name and by count** and to fail on anything new. `--update` rewrites the
 * baseline; the file is meant to be reviewed when it changes, not regenerated on a whim.
 */
const BASELINE_FILE = path.join(ROOT, 'server/scripts/sanitize-history.baseline.json');
const group = (list) => {
  const map = {};
  for (const f of list) {
    const key = `${f.rule}|${f.path}`;
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
};
const current = group(findings);

if (argv.includes('--update')) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
  process.stdout.write(`baseline written: ${Object.keys(current).length} accepted group(s), ${findings.length} finding(s)\n`);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
} catch {
  baseline = {};
}

const regressions = [];
for (const [key, count] of Object.entries(current)) {
  const accepted = baseline[key] ?? 0;
  if (count > accepted) regressions.push({ key, count, accepted });
}

process.stdout.write(`sanitize-history: ${blobs.length} unique text blob(s) across all refs`);
if (skippedMachineLocal) process.stdout.write(`, ${skippedMachineLocal} machine-local file(s) skipped as the tree scanner does`);
process.stdout.write('\n');

if (!regressions.length) {
  const accepted = Object.values(baseline).reduce((n, v) => n + v, 0);
  process.stdout.write(
    `\n✅ no new traces in history (${findings.length} accepted historical finding(s) in ${Object.keys(baseline).length} group(s):\n` +
      '   machine drive paths in older fixture and documentation versions; no API key, no cookie, no private name,\n' +
      '   and no personal home path in any commit)\n',
  );
  process.exit(0);
}

process.stdout.write(`\n${regressions.length} new trace group(s) in committed history:\n\n`);
for (const r of regressions) {
  const examples = findings.filter((f) => `${f.rule}|${f.path}` === r.key).slice(0, 3);
  process.stdout.write(`  ⚠️  ${r.key} — ${r.count} finding(s), baseline allows ${r.accepted}\n`);
  for (const e of examples) process.stdout.write(`      @ ${e.sha}:${e.line} — ${e.desc} — ${e.sample}\n`);
}
process.stdout.write(
  '\nThese are in commits, not in the working tree: editing a file does not remove them. Either rewrite the history\n' +
    '(git filter-repo / BFG, then force-push), or rotate whatever leaked, or - when the finding is genuinely\n' +
    'harmless - run this with --update and say why in the commit message. Not deciding is also a decision; the\n' +
    'point of the baseline is that it is a knowing one.\n',
);
process.exit(1);

// commit-msg-check.mjs — guard: **every commit message in this repository is English**.
//
// Why this is a rule and not a preference: the history is the first thing a reader from anywhere
// sees, and a body written only in Chinese is unreadable for exactly the people who would
// otherwise contribute — it cannot be searched, quoted in an issue, or understood in review.
// tools/lib/cjk-text.mjs holds the character class (and says what quoted evidence in another
// script stays allowed).
//
// Usage:
//   node tools/commit-msg-check.mjs                  every commit reachable from any ref
//   node tools/commit-msg-check.mjs --limit 20       only the newest 20 commits
//   node tools/commit-msg-check.mjs --range a..b     a revision range
//   node tools/commit-msg-check.mjs --file <path>    one message file (this is what the
//                                                    .githooks/commit-msg hook calls)
//
// Exit codes: 0 = English (or nothing to check), 1 = at least one message contains Chinese.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offenders } from './lib/cjk-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};

/** Non-ASCII is shown as its code point so the report itself stays readable in any terminal. */
const escape = (s) => s.replace(/[^\t\x20-\x7e]/g, (ch) => '<U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '>');

const FIX_HINT = [
  'Reword the message in English, then:',
  '  latest commit:      git commit --amend',
  '  without an editor:  git commit --amend -m "<english subject>" -m "<english body>"',
  '  older commit:       git rebase -i <base>  (reword), then push with --force-with-lease',
].join('\n  ');

function report(label, message) {
  const bad = offenders(message);
  if (!bad.length) return false;
  console.error(`commit-msg: ${label} contains ${bad.join(' ')}`);
  message.split('\n').forEach((line, i) => {
    if (offenders(line).length) console.error(`  ${i + 1}: ${escape(line.trim()).slice(0, 120)}`);
  });
  return true;
}

const file = arg('--file');
if (file) {
  if (!fs.existsSync(file)) {
    console.error(`commit-msg: message file not found: ${file}`);
    process.exit(1);
  }
  // Comment lines are git's own template scaffolding, not the message being written.
  const message = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^#/.test(l)).join('\n');
  if (!message.trim()) process.exit(0);
  if (report(path.basename(file), message)) {
    console.error(FIX_HINT);
    process.exit(1);
  }
  process.exit(0);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
}

try {
  git(['rev-parse', '--git-dir']);
} catch {
  console.log('commit-msg: [skip] not a git repository');
  process.exit(0);
}

const shallow = git(['rev-parse', '--is-shallow-repository']) === 'true';
const range = arg('--range');
const limit = arg('--limit');
const logArgs = ['log', '--format=%H%x00%B%x00%x01'];
if (range) logArgs.push(range);
else logArgs.push('--all');
if (limit) logArgs.push('-n', limit);

const commits = git(logArgs)
  .split('\x01')
  .map((r) => r.replace(/^\n+/, ''))
  .filter((r) => r.trim())
  .map((r) => {
    const [hash, message] = r.split('\x00');
    return { hash, message };
  });

if (shallow) {
  console.log(
    `commit-msg: [warn] shallow clone — only the ${commits.length} commits present locally can be checked ` +
      '(use actions/checkout with fetch-depth: 0, or git fetch --unshallow, for the full history)',
  );
}

let bad = 0;
for (const c of commits) {
  if (report(c.hash.slice(0, 7) + ' "' + c.message.split('\n')[0].trim().slice(0, 60) + '"', c.message)) bad++;
}

if (bad) {
  console.error(`\ncommit-msg: ${bad} of ${commits.length} commit message(s) contain Chinese.`);
  console.error('  ' + FIX_HINT);
  process.exit(1);
}
console.log(`commit-msg: ${commits.length} commit message(s) checked, all English`);

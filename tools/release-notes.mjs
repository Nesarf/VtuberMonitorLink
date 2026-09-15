// release-notes.mjs — the notes for one released version, out of the repository's own release notes file
//
// Why this exists as a tool instead of a line of shell inside the workflow: the GitHub Release body and the file
// in the repository must be the same text, and the only way to guarantee that is for both to come from one
// source. It also makes "a release without notes" impossible rather than merely unlikely - the workflow fails if
// the section for the tag being released is missing, so the person cutting the release finds out then instead of
// a reader finding out later.
//
//   node tools/release-notes.mjs v1.0.2            -> the section, on stdout
//   node tools/release-notes.mjs v1.0.2 --out f.md -> the same text written to a file, as UTF-8
//   node tools/release-notes.mjs --check v1.0.2    -> exit 0 when the section exists and is not a stub
//
// `--out` exists because the obvious alternative in a PowerShell workflow step is a redirect, and a PowerShell
// redirect writes UTF-16 - the same trap this repository already has a section about for worker pipes. Writing
// the file here keeps the encoding out of the hands of the shell.
//
// The section runs from `## <version>` to the next `## ` heading. `--check` also refuses a section that is only
// a heading, because "the notes exist" and "the notes say something" are different claims and only the second is
// worth publishing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTES = path.join(ROOT, 'docs/RELEASE.md');

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const outIndex = argv.indexOf('--out');
const outFile = outIndex === -1 ? '' : (argv[outIndex + 1] ?? '');
const version = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--out') ?? '';

if (!version) {
  process.stderr.write('usage: node tools/release-notes.mjs [--check] v<version>\n');
  process.exit(2);
}

const normalised = version.replace(/^v/, '');
const text = fs.readFileSync(NOTES, 'utf8');
const blocks = text.split(/^## /m).slice(1);
const block = blocks.find((b) => b.split('\n', 1)[0].trim() === `v${normalised}`);

if (!block) {
  process.stderr.write(`no section for v${normalised} in docs/RELEASE.md\n`);
  process.exit(1);
}

const body = ('## ' + block).trimEnd() + '\n';
const words = body.replace(/^#+.*$/gm, '').trim().split(/\s+/).filter(Boolean).length;

if (check && words < 40) {
  process.stderr.write(`the section for v${normalised} is a stub (${words} words); release notes are what a reader gets\n`);
  process.exit(1);
}

if (check) {
  process.stderr.write(`release notes for v${normalised}: ${words} words, ${body.split('\n').length} lines\n`);
  process.exit(0);
}

if (outFile) {
  fs.writeFileSync(outFile, body, 'utf8');
  process.stderr.write(`release notes for v${normalised}: ${words} words written to ${outFile}\n`);
  process.exit(0);
}

process.stdout.write(body);

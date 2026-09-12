// format-i18n.mjs — repair "two keys glued onto one line"
//
// Background: while using an editing tool to insert entries into i18n.jsx, a few times old_string ended
// with a newline while the replacement did not, so a new key and the key that already followed it were
// spliced onto the same line (the values below stand for the Chinese UI labels):
//     llmFeat_probe: '<zh value>',    tab_live: '<zh value>',
// Syntactically perfectly legal, and the UI still works (both keys are there), but:
//   - checks/scripts that match at the start of a line miss the second key (that is how the completeness check found it)
//   - diffs and review become ugly
//
//   node tools/format-i18n.mjs        check only (exit code 1 when something is wrong)
//   node tools/format-i18n.mjs --fix  fix in place
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['web/src/i18n.jsx', 'web/src/locales/overlays.js', 'web/src/locales/index.js'];

// A line showing: end of string + comma + >=2 spaces + an "identifier:" -> the second key got glued on
const GLUED = /^(\s*)(.*?['"]),\s{2,}([A-Za-z_][A-Za-z0-9_]*\s*:.*)$/;

const fix = process.argv.includes('--fix');
let total = 0;
const lines = [];

for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const parts = src.split(/\r?\n/);
  let hits = 0;
  const out = [];
  for (const line of parts) {
    // leave comment lines alone (this shape appearing inside a comment is normal prose)
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) {
      out.push(line);
      continue;
    }
    const m = GLUED.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    hits++;
    lines.push(`${rel}: ${line.trim().slice(0, 100)}`);
    // split into two lines, reusing the original line's indentation
    out.push(`${m[1]}${m[2]},`);
    out.push(`${m[1]}${m[3]}`);
  }
  if (hits && fix) fs.writeFileSync(abs, out.join('\n'), 'utf8');
  if (hits) total += hits;
  process.stdout.write(`  ${rel.padEnd(30)} ${hits} glued${hits && fix ? ' (fixed)' : ''}\n`);
}

if (!total) {
  process.stdout.write('\n  no glued keys.\n');
  process.exit(0);
}
for (const l of lines) process.stdout.write('    ' + l + '\n');
if (!fix) {
  process.stdout.write(`\n${total} keys glued onto one line - run node tools/format-i18n.mjs --fix to repair.\n`);
  process.exit(1);
}
process.stdout.write(`\nfixed ${total}.\n`);

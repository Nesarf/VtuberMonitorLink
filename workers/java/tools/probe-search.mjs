// workers/java/tools/probe-search.mjs — run the corpus cases through the Java search worker over the
// real protocol and print the cases whose answer differs from the reviewed snapshot. A development
// probe, not a shipped test: tools/workers.mjs is the conformance runner and is the verdict.
//
//   node workers/java/tools/probe-search.mjs [path/to/cases.json]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const casesPath = process.argv[2] ?? path.join(ROOT, 'workers', 'spec', 'cases', 'search.query.json');
const expectedPath = path.join(ROOT, 'workers', 'spec', 'expected', 'search.query.json');
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases;
const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')).cases : {};

const canon = (v) =>
  Array.isArray(v)
    ? '[' + v.map(canon).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
      : JSON.stringify(v);

const child = spawn(
  'java',
  ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-jar', 'workers/java/dist/vmlsearch.jar', '--capability', 'search.query'],
  { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
);
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => (stderr += d));
let out = '';
const answers = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  out += d;
  let nl;
  while ((nl = out.indexOf('\n')) !== -1) {
    const line = out.slice(0, nl);
    out = out.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== null && msg.id !== undefined && msg.id !== 'describe') answers.set(msg.id, msg);
  }
});
child.stdin.write(JSON.stringify({ id: 'describe', op: 'describe' }) + '\n');
for (const c of cases) child.stdin.write(JSON.stringify({ id: c.id, op: 'invoke', capability: 'search.query', input: c.input }) + '\n');

await new Promise((r) => setTimeout(r, 1500));
child.stdin.write(JSON.stringify({ id: 'shutdown', op: 'shutdown' }) + '\n');
await new Promise((r) => child.on('exit', r));

let same = 0;
for (const c of cases) {
  const a = answers.get(c.id);
  if (!a) {
    console.log(`MISSING  ${c.id}`);
    continue;
  }
  const got = a.ok === false ? { __error: a.error.code } : a.output;
  const want = expected[c.id];
  if (canon(got) === canon(want)) {
    same++;
    continue;
  }
  console.log(`DIFFERS  ${c.id}`);
  console.log(`   want: ${canon(want)}`);
  console.log(`   got : ${canon(got)}`);
}
console.log(`\n${same}/${cases.length} cases match the snapshot`);
if (stderr.trim()) console.log('worker stderr: ' + stderr.trim().replace(/\n/g, ' | '));
process.exit(same === cases.length ? 0 : 1);

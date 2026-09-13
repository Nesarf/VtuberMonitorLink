// workers/java/tools/probe-search-cases-both.mjs — development probe: run inputs through the
// JavaScript reference and through the Java worker over the real protocol, and print both answers
// side by side. Used to pin behaviour on inputs the corpus does not carry; a disagreement is a
// question, and tools/workers.mjs remains the conformance verdict.
//
//   node workers/java/tools/probe-search-cases-both.mjs '[{...input...}, {...}]'
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from '../../js/vmlsearch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const inputs = JSON.parse(process.argv[2]);

const child = spawn(
  'java',
  [
    '-Dfile.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-jar',
    path.join(ROOT, 'workers', 'java', 'dist', 'vmlsearch.jar'),
    '--capability',
    'search.query',
  ],
  { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
);
let out = '';
const answers = new Map();
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => {});
child.stdout.on('data', (d) => {
  out += d;
  let nl;
  while ((nl = out.indexOf('\n')) !== -1) {
    const line = out.slice(0, nl);
    out = out.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== null && msg.id !== undefined) answers.set(msg.id, msg);
  }
});
inputs.forEach((input, i) => child.stdin.write(JSON.stringify({ id: i, op: 'invoke', capability: 'search.query', input }) + '\n'));

await new Promise((r) => setTimeout(r, 1200));
child.stdin.write(JSON.stringify({ id: 'shutdown', op: 'shutdown' }) + '\n');
await new Promise((r) => child.on('exit', r));

let same = 0;
inputs.forEach((input, i) => {
  const answer = answers.get(i);
  const java = answer?.ok === false ? { __error: answer.error.code } : answer?.output;
  let js;
  try {
    js = search(input);
  } catch (e) {
    js = { __error: e.code ?? 'internal' };
  }
  const a = JSON.stringify(js);
  const b = JSON.stringify(java);
  const ok = a === b;
  if (ok) same++;
  console.log(`${ok ? 'same ' : 'DIFF '} ${JSON.stringify(input.query)} tags=${JSON.stringify(input.docs.map((d) => d.tags))}`);
  if (!ok) {
    console.log(`   js  : ${a}`);
    console.log(`   java: ${b}`);
  }
});
console.log(`\n${same}/${inputs.length} identical`);
process.exit(same === inputs.length ? 0 : 1);

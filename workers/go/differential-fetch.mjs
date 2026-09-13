// workers/go/differential-fetch.mjs - a development-only differential run for `fetch.plan`.
//
// The corpus in workers/spec/cases/fetch.plan.json is the contract's floor, not its ceiling: it holds
// 25 reviewed cases, and a planner has branches no review reaches. This script generates inputs that
// the corpus does not contain - 300 from a seeded generator (a source with no egress key, a `due` flag
// that is neither true nor false, a `lastRunAt` of -5, a `maxConcurrent` of 2.5, the maximum int64 as
// `now` with the minimum int64 as `lastRunAt`, duplicate ids, astral and non-ASCII ids and egress
// names, budgets of every shape) plus 44 hand-written ones aimed at the protocol shapes - and puts
// every one of them through the Go worker and through the JavaScript reference over the real stdio
// protocol, comparing the answers with the conformance runner's own canonicalisation.
//
// It answered the one question the corpus cannot: whether the two implementations disagree anywhere
// else. They do, in exactly one place, and the result is written down in README.md ("Known limits",
// item 1) rather than in the corpus, which is not this worker's file to edit.
//
// It reuses tools/workers.mjs by slicing its worker-runner section out of the source and evaluating
// it, rather than reimplementing the protocol here: a private copy of the protocol could differ from
// the harness in the same way two implementations differ, and then the differential run would be
// measuring the wrong thing. That trick depends on `function artifactFor` and
// `function runWorker` still existing in that file - if the slice ever stops being found, the
// "no launch function" error says so immediately.
//
// Usage (from the repository root, with both artifacts built):
//
//   node workers/go/differential-fetch.mjs
//
// Exit code 0 always: this is a diagnostic, not a gate. Read the last three lines for the verdict.
// Nothing here is part of the release checks, and nothing here needs the network.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');

// ---------------------------------------------------------------- the harness's own runner
const src = fs.readFileSync(path.join(ROOT, 'tools/workers.mjs'), 'utf8');
const start = src.indexOf('function artifactFor');
const end = src.indexOf('const snapshotPath');
if (start === -1 || end === -1 || end < start) {
  console.error('differential-fetch: cannot find the worker-runner section in tools/workers.mjs; the slice needs updating.');
  process.exit(2);
}
const helper = src.slice(start, end);
const factory = new Function('spawn', 'ROOT', `return (function(){${helper}; return runWorker;})();`);
const runWorker = factory(spawn, ROOT);

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'workers/registry.json'), 'utf8')).workers;
const goWorker = registry.find((w) => w.id === 'go-fetch');
const jsWorker = registry.find((w) => w.id === 'js-fetch');
if (!goWorker || !jsWorker) {
  console.error('differential-fetch: registry.json must carry both go-fetch and js-fetch.');
  process.exit(2);
}

// ---------------------------------------------------------------- the input set
// A fixed seed, so a run is reproducible and a difference is a difference and not a lucky draw.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const IDS = ['a', 'b', 'z', 'A', 'Z', 'aa', 'ab', '\u00e9clair', 'zebra', '\u{1F600}', '\uFFFD', '\u65E5\u672C', 'xxx', 'B', '\u00E4'];
const EGRESSES = ['direct', 'tor', 'alpha', 'bravo', 'zebra', '\u00e9clair', '\u65E5\u672C', '\u017B'];

function randomSource(knownEgresses) {
  const s = { id: pick(IDS) };
  s.egress = rnd() < 0.8 ? pick(knownEgresses) : pick([...EGRESSES, 'ghost']);
  if (rnd() < 0.3) s.due = pick([true, false]);
  if (rnd() < 0.8) s.lastRunAt = pick([null, 0, 1, 999, 1000, 1001, 5000, -5, 1735689600000]);
  if (rnd() < 0.6) s.minIntervalMs = pick([0, 1, 500, 1000, 600000]);
  return s;
}

function randomInput() {
  const known = EGRESSES.slice(0, 1 + Math.floor(rnd() * 4));
  const egress = {};
  for (const name of known) egress[name] = rnd() < 0.7 ? { maxConcurrent: pick([1, 2, 3, 8, 0, -1]) } : {};
  const input = { now: pick([0, 1, 500, 1000, 1001, 5000, 1735689600000]), sources: [], egress };
  const n = Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) input.sources.push(randomSource(known));
  if (rnd() < 0.5) {
    input.budget = {};
    if (rnd() < 0.7) input.budget.maxRequests = pick([0, 1, 2, 5, 20]);
    if (rnd() < 0.6) {
      input.budget.maxPerEgress = {};
      for (const name of known) if (rnd() < 0.5) input.budget.maxPerEgress[name] = pick([0, 1, 2]);
      if (rnd() < 0.2) input.budget.maxPerEgress.ghost = 1; // a cap for an egress that is not there
    }
  }
  return input;
}

// Hand-written shapes: the generator cannot reach a wrong-typed member, and those are exactly the
// inputs where a language's own type rules decide the answer.
const HAND = [
  { now: 0, sources: [], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }] },
  { now: 0, sources: [{ id: 'a', egress: 5 }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 5, egress: 'direct' }], egress: { direct: {} } },
  { now: 0, sources: [{ id: '', egress: 'direct' }], egress: { direct: {} } },
  { now: 0, sources: [null], egress: { direct: {} } },
  { now: 0, sources: ['a'], egress: { direct: {} } },
  { now: 0, egress: {} },
  { sources: [] },
  { now: null, sources: [] },
  { now: 1.5, sources: [] },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: null },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: [] },
  { now: 0, sources: [{ id: 'a', egress: 'direct', lastRunAt: 1.5 }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', lastRunAt: 'x' }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', lastRunAt: true }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', due: 'yes' }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', due: 1 }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', due: false, lastRunAt: null }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', minIntervalMs: -1 }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', minIntervalMs: 1.5 }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', minIntervalMs: null }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: { direct: { maxConcurrent: 0 } } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: { direct: { maxConcurrent: -2 } } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: { direct: { maxConcurrent: null } } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: { direct: { maxConcurrent: 2.5 } } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: { direct: null } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: { direct: 'x' } },
  { now: 0, sources: [{ id: 'a', egress: 'direct' }], egress: { direct: [] } },
  { now: 0, sources: [], egress: {}, budget: { maxRequests: -1 } },
  { now: 0, sources: [], egress: {}, budget: { maxRequests: 1.5 } },
  { now: 0, sources: [], egress: {}, budget: { maxRequests: null } },
  { now: 0, sources: [], egress: {}, budget: { maxPerEgress: { tor: -1 } } },
  { now: 0, sources: [], egress: {}, budget: { maxPerEgress: { tor: 1.5 } } },
  { now: 0, sources: [], egress: {}, budget: { maxPerEgress: 5 } },
  { now: 0, sources: [], egress: {}, budget: null },
  { now: 0, sources: [], egress: {}, budget: [] },
  { now: 0, sources: [], extra: 'ignored', egress: {} },
  // Beyond the double range on purpose: an implementation that parses these into a float64, or that
  // subtracts them in int64, answers differently here.
  { now: 9007199254740993, sources: [{ id: 'a', egress: 'direct', lastRunAt: -9007199254740993 }], egress: { direct: {} } },
  { now: 9223372036854775807, sources: [{ id: 'a', egress: 'direct', lastRunAt: -9223372036854775808, minIntervalMs: 1 }], egress: { direct: {} } },
  // Number forms that are integers without looking like it.
  { now: 0, sources: [{ id: 'a', egress: 'direct', lastRunAt: 1e3, minIntervalMs: 1e2 }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', lastRunAt: 500.0 }], egress: { direct: {} } },
  // Duplicate ids: assumed unique by the contract, neither merged nor rejected.
  { now: 0, sources: [{ id: 'a', egress: 'direct' }, { id: 'a', egress: 'direct' }], egress: { direct: {} } },
  { now: 0, sources: [{ id: 'a', egress: 'direct', lastRunAt: null }, { id: 'a', egress: 'tor', lastRunAt: 0 }], egress: { direct: {}, tor: { maxConcurrent: 2 } }, budget: { maxRequests: 1, maxPerEgress: { direct: 1, tor: 1 } } },
];

const cases = [...HAND, ...Array.from({ length: 300 }, () => randomInput())].map((input, i) => ({ id: 'c' + i, input }));

// ---------------------------------------------------------------- run both
const go = await runWorker(goWorker, 'fetch.plan', cases);
const js = await runWorker(jsWorker, 'fetch.plan', cases);

const canon = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
const cell = (r, c) => {
  const a = r.answers.get(c.id);
  if (!a) return 'MISSING';
  if (a.ok === false) return 'ERR:' + (a.error?.code ?? '?');
  return canon(a.output);
};

let differ = 0;
const errorCodes = new Map();
for (const c of cases) {
  const g = cell(go, c);
  const j = cell(js, c);
  if (g.startsWith('ERR:')) errorCodes.set(g, (errorCodes.get(g) ?? 0) + 1);
  if (g === j) continue;
  differ++;
  if (differ <= 12) {
    console.log('DIVERGES  input=' + JSON.stringify(c.input));
    console.log('    go: ' + g.slice(0, 220));
    console.log('    js: ' + j.slice(0, 220));
  }
}
console.log(`cases=${cases.length} identical=${cases.length - differ} divergent=${differ}`);
console.log('answer kinds from go-fetch: ' + JSON.stringify([...errorCodes]));
if (go.stderrTail) console.log('go-fetch stderr tail: ' + JSON.stringify(go.stderrTail));
if (js.stderrTail) console.log('js-fetch stderr tail: ' + JSON.stringify(js.stderrTail));

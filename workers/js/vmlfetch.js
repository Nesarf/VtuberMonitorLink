// workers/js/vmlfetch.js - the reference implementation of `fetch.plan` (docs/WORKERS.md section 10).
//
// The planning half of fetching, and nothing else: which sources go out this round, on which egress,
// in what order, and what waits. The fetching itself stays in the application, because a capability
// that performs network I/O cannot be diffed across languages on a machine with no network - and the
// part worth comparing is the arithmetic anyway.
//
// The contract was written before this file existed, like `search.query`, and for the same reason: a
// scheduler is a pile of rules that each look obvious alone. The traps it pins are the ones every
// language gets wrong in its own way - `lastRunAt: 0` read as "never run" by a falsy test, a hash map
// dictating the batch order, a locale collation deciding between `id`s, and a shared budget spent in
// whatever order the egresses happened to come out of a dictionary.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bad = (message) => Object.assign(new Error(message), { code: 'bad-input' });

/**
 * Compare strings as UTF-8 bytes. The contract says byte order, not collation: `z` before `é`, and a
 * character above U+E000 before an astral one (which is where UTF-16 code-unit order, the order a JVM
 * or a .NET string sort gives by default, disagrees).
 */
const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** `undefined` and `null` both mean "absent"; `0` is a value, and that distinction runs this file. */
const absent = (v) => v === undefined || v === null;

/**
 * The whole capability. Pure: no clock (the caller passes `now`), no randomness, no environment.
 */
export function plan(input) {
  const sources = Array.isArray(input?.sources) ? input.sources : null;
  if (!sources) throw bad('input.sources must be an array');
  const now = input?.now;
  if (typeof now !== 'number' || !Number.isInteger(now)) throw bad('input.now must be an integer');

  const egress = input?.egress && typeof input.egress === 'object' && !Array.isArray(input.egress) ? input.egress : {};
  const budget = input?.budget && typeof input.budget === 'object' ? input.budget : {};
  const maxRequests = absent(budget.maxRequests) ? null : budget.maxRequests;
  if (maxRequests !== null && !isCount(maxRequests)) throw bad('budget.maxRequests must be a non-negative integer');
  const maxPerEgress = budget.maxPerEgress && typeof budget.maxPerEgress === 'object' ? budget.maxPerEgress : {};
  for (const [name, cap] of Object.entries(maxPerEgress)) {
    if (!isCount(cap)) throw bad(`budget.maxPerEgress.${name} must be a non-negative integer`);
  }

  const skipped = [];
  const deferred = [];
  const dueByEgress = new Map();
  const capacityOf = new Map();

  for (const source of sources) {
    const id = source?.id;
    if (typeof id !== 'string' || id === '') throw bad('every source needs a non-empty string id');

    // Rule 1 first: a source pointing at an egress that does not exist is a configuration the user has
    // to fix, whether or not it is due. Reporting it as "deferred" would hide it behind the clock.
    const egressName = source?.egress;
    if (typeof egressName !== 'string' || !Object.prototype.hasOwnProperty.call(egress, egressName)) {
      skipped.push({ id, reason: 'no-egress' });
      continue;
    }
    const config = egress[egressName] && typeof egress[egressName] === 'object' ? egress[egressName] : {};
    if (!capacityOf.has(egressName)) {
      const maxConcurrent = absent(config.maxConcurrent) ? 1 : config.maxConcurrent;
      if (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
        throw bad(`egress ${egressName}: maxConcurrent must be a positive integer`);
      }
      capacityOf.set(egressName, maxConcurrent);
    }

    const lastRunAt = absent(source?.lastRunAt) ? null : source.lastRunAt;
    if (lastRunAt !== null && (typeof lastRunAt !== 'number' || !Number.isInteger(lastRunAt))) {
      throw bad(`source ${id}: lastRunAt must be an integer or null`);
    }
    const minIntervalMs = absent(source?.minIntervalMs) ? 0 : source.minIntervalMs;
    if (!isCount(minIntervalMs)) throw bad(`source ${id}: minIntervalMs must be a non-negative integer`);

    // `lastRunAt: 0` is the epoch, not a missing value: `!lastRunAt` would schedule it as never-run.
    const due = source?.due === true || lastRunAt === null || now - lastRunAt >= minIntervalMs;
    if (!due) {
      deferred.push({ id, reason: 'interval' });
      continue;
    }
    const list = dueByEgress.get(egressName);
    if (list) list.push({ id, lastRunAt });
    else dueByEgress.set(egressName, [{ id, lastRunAt }]);
  }

  const batches = [];
  let left = maxRequests; // null means no limit

  for (const egressName of [...dueByEgress.keys()].sort(byUtf8)) {
    const list = dueByEgress.get(egressName);
    // Longest-waiting first, and never-run sources wait longest of all. Ties go to the id, by bytes.
    list.sort((a, b) => {
      const aNever = a.lastRunAt === null;
      const bNever = b.lastRunAt === null;
      if (aNever !== bNever) return aNever ? -1 : 1;
      if (!aNever && a.lastRunAt !== b.lastRunAt) return a.lastRunAt - b.lastRunAt;
      return byUtf8(a.id, b.id);
    });

    let capacity = capacityOf.get(egressName);
    const perEgress = maxPerEgress[egressName];
    if (perEgress !== undefined && perEgress !== null) capacity = Math.min(capacity, perEgress);
    if (left !== null) capacity = Math.min(capacity, left);

    const take = capacity > 0 ? list.slice(0, capacity) : [];
    for (let i = take.length; i < list.length; i++) deferred.push({ id: list[i].id, reason: 'budget' });
    if (take.length) {
      batches.push({ egress: egressName, sources: take.map((s) => s.id) });
      if (left !== null) left -= take.length;
    }
  }

  // Both lists are reports, so their order is part of the answer: sorted by id as bytes.
  const byId = (rows) => rows.sort((a, b) => byUtf8(a.id, b.id));
  byId(deferred);
  byId(skipped);

  return {
    batches,
    deferred,
    skipped,
    counts: {
      planned: batches.reduce((n, b) => n + b.sources.length, 0),
      deferred: deferred.length,
      skipped: skipped.length,
    },
  };
}

// ── the protocol, the same shape as the text and search workers ──────────────────────────────

export const CAPABILITIES = {
  'fetch.plan': (input) => plan(input),
};

export const describeWith = (capability) => ({
  protocol: 1,
  capability,
  language: 'javascript',
  impl: 'reference-scan',
  runtime: process.version,
  deterministic: true,
});

const SELFCHECK = [
  ['a never-run source is due and goes first', () => {
    const r = plan({
      now: 1000,
      sources: [
        { id: 'b', egress: 'direct', lastRunAt: 900, minIntervalMs: 0 },
        { id: 'a', egress: 'direct', lastRunAt: null, minIntervalMs: 60000 },
      ],
      egress: { direct: { maxConcurrent: 4 } },
    });
    return r.batches[0].sources.join(',') === 'a,b';
  }],
  ['lastRunAt 0 is the epoch, not a missing value', () => {
    const r = plan({
      now: 500,
      sources: [{ id: 'a', egress: 'direct', lastRunAt: 0, minIntervalMs: 1000 }],
      egress: { direct: {} },
    });
    return r.counts.planned === 0 && r.deferred[0].reason === 'interval';
  }],
  ['lastRunAt 0 is due once the interval has passed', () => {
    const r = plan({
      now: 1000,
      sources: [{ id: 'a', egress: 'direct', lastRunAt: 0, minIntervalMs: 1000 }],
      egress: { direct: {} },
    });
    return r.counts.planned === 1;
  }],
  ['an unknown egress is skipped even when the source is not due', () => {
    const r = plan({ now: 0, sources: [{ id: 'a', egress: 'nope', due: false, lastRunAt: 5000 }], egress: {} });
    return r.counts.skipped === 1 && r.skipped[0].reason === 'no-egress' && r.counts.deferred === 0;
  }],
  ['due:true wins over a fresh lastRunAt', () => {
    const r = plan({
      now: 1000,
      sources: [{ id: 'a', egress: 'direct', due: true, lastRunAt: 999, minIntervalMs: 60000 }],
      egress: { direct: {} },
    });
    return r.counts.planned === 1;
  }],
  ['a missing maxConcurrent is one lane', () => {
    const r = plan({
      now: 0,
      sources: [
        { id: 'a', egress: 'direct', lastRunAt: null },
        { id: 'b', egress: 'direct', lastRunAt: null },
      ],
      egress: { direct: {} },
    });
    return r.batches[0].sources.length === 1 && r.deferred[0].reason === 'budget';
  }],
  ['batches come out in byte order of egress name', () => {
    const r = plan({
      now: 0,
      sources: [
        { id: 'a', egress: 'éclair', lastRunAt: null },
        { id: 'b', egress: 'zebra', lastRunAt: null },
      ],
      egress: { éclair: {}, zebra: {} },
    });
    return r.batches.map((b) => b.egress).join(',') === 'zebra,éclair';
  }],
  ['ids of equal age are ordered by UTF-8 bytes, not by UTF-16 or collation', () => {
    // U+FFFD is 3 bytes and sorts before the 4-byte astral character in UTF-8, but after its leading
    // surrogate in UTF-16 - which is the default string order of a JVM and of .NET.
    const r = plan({
      now: 10,
      sources: [
        { id: '\u{1F600}', egress: 'direct', lastRunAt: 5 },
        { id: '\uFFFD', egress: 'direct', lastRunAt: 5 },
      ],
      egress: { direct: { maxConcurrent: 2 } },
    });
    return r.batches[0].sources.join(',') === '\uFFFD,\u{1F600}';
  }],
  ['a shared budget is spent in egress name order', () => {
    const r = plan({
      now: 0,
      sources: [
        { id: 'a', egress: 'bravo', lastRunAt: null },
        { id: 'b', egress: 'alpha', lastRunAt: null },
      ],
      egress: { alpha: {}, bravo: {} },
      budget: { maxRequests: 1 },
    });
    return r.batches.length === 1 && r.batches[0].egress === 'alpha' && r.deferred[0].id === 'a';
  }],
  ['maxPerEgress is applied before maxConcurrent', () => {
    const r = plan({
      now: 0,
      sources: [1, 2, 3].map((n) => ({ id: 's' + n, egress: 'tor', lastRunAt: null })),
      egress: { tor: { maxConcurrent: 8 } },
      budget: { maxPerEgress: { tor: 2 } },
    });
    return r.batches[0].sources.length === 2 && r.counts.deferred === 1;
  }],
  ['a budget of zero plans nothing and defers every due source', () => {
    const r = plan({
      now: 0,
      sources: [{ id: 'a', egress: 'direct', lastRunAt: null }],
      egress: { direct: {} },
      budget: { maxRequests: 0 },
    });
    return r.batches.length === 0 && r.counts.planned === 0 && r.counts.deferred === 1;
  }],
  ['an egress with no due source gets no empty batch', () => {
    const r = plan({
      now: 1000,
      sources: [{ id: 'a', egress: 'direct', lastRunAt: 900, minIntervalMs: 60000 }],
      egress: { direct: {}, tor: {} },
    });
    return r.batches.length === 0 && r.counts.deferred === 1;
  }],
  ['both lists are sorted by id', () => {
    const r = plan({
      now: 0,
      sources: [
        { id: 'z', egress: 'gone', lastRunAt: null },
        { id: 'a', egress: 'gone', lastRunAt: null },
        { id: 'y', egress: 'direct', lastRunAt: 10, minIntervalMs: 60000 },
        { id: 'b', egress: 'direct', lastRunAt: 10, minIntervalMs: 60000 },
      ],
      egress: { direct: {} },
    });
    return r.skipped.map((s) => s.id).join(',') === 'a,z' && r.deferred.map((d) => d.id).join(',') === 'b,y';
  }],
  ['counts are integers and agree with the lists', () => {
    const r = plan({
      now: 0,
      sources: [
        { id: 'a', egress: 'direct', lastRunAt: null },
        { id: 'b', egress: 'gone', lastRunAt: null },
        { id: 'c', egress: 'direct', lastRunAt: 0, minIntervalMs: 60000 },
      ],
      egress: { direct: { maxConcurrent: 4 } },
    });
    return Number.isInteger(r.counts.planned) && r.counts.planned === 1 && r.counts.skipped === 1 && r.counts.deferred === 1;
  }],
  ['missing sources is bad input', () => {
    try {
      plan({ now: 0 });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['a source without an id is bad input', () => {
    try {
      plan({ now: 0, sources: [{ egress: 'direct' }], egress: { direct: {} } });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['maxConcurrent below one is bad input', () => {
    try {
      plan({ now: 0, sources: [{ id: 'a', egress: 'direct', lastRunAt: null }], egress: { direct: { maxConcurrent: 0 } } });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['a negative budget is bad input', () => {
    try {
      plan({ now: 0, sources: [], egress: {}, budget: { maxRequests: -1 } });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['a missing now is bad input', () => {
    try {
      plan({ sources: [], egress: {} });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
];

async function selfcheck() {
  let pass = 0;
  for (const [name, fn] of SELFCHECK) {
    let ok = false;
    let detail = '';
    try {
      ok = fn() === true;
    } catch (e) {
      detail = ': ' + e.message;
    }
    process.stderr.write(`${ok ? '  [ok]  ' : '  [FAIL]'} ${name}${detail}\n`);
    if (ok) pass++;
  }
  process.stderr.write(`${pass}/${SELFCHECK.length} checks passed\n`);
  process.exit(pass === SELFCHECK.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck')) return selfcheck();
  const capIndex = argv.indexOf('--capability');
  const capability = capIndex === -1 ? null : argv[capIndex + 1];
  if (!capability || !CAPABILITIES[capability]) {
    process.stderr.write('usage: vmlfetch.js --capability fetch.plan | --selfcheck\n');
    process.exit(2);
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ id: null, ok: false, error: { code: 'bad-input', message: 'request is not JSON' } }) + '\n');
        continue;
      }
      if (req.op === 'shutdown') {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true }) + '\n');
        process.exit(0);
      }
      if (req.op === 'describe') {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true, worker: describeWith(capability) }) + '\n');
        continue;
      }
      if (req.op !== 'invoke') {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: 'unsupported', message: `unknown op ${req.op}` } }) + '\n');
        continue;
      }
      if (req.capability && req.capability !== capability) {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: 'unsupported', message: `this worker implements ${capability}` } }) + '\n');
        continue;
      }
      try {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true, output: CAPABILITIES[capability](req.input ?? {}) }) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: e.code ?? 'internal', message: e.message } }) + '\n');
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
void HERE;

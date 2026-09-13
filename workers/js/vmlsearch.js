// workers/js/vmlsearch.js - the reference implementation of `search.query` (docs/WORKERS.md section 9).
//
// The contract for this capability was written before any implementation of it existed, on purpose:
// a ranked capability is the one place where several languages can quietly disagree forever, because
// a floating-point score computed in a different order is a different number and "the results look
// about right" is not a verdict. So there are no floats here, the ordering is total, and every object
// whose key order a hash map could decide has a specified order.
//
// It is also a worker in its own right, speaking the same JSON-Lines protocol as the text workers, so
// the conformance harness can diff it against a Java inverted index and a SQL implementation later.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokensOf } from './vmltext.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── matching ────────────────────────────────────────────────────────────────────────────────

/** A field's tokens as a set: the contract says order and duplicates do not matter. */
const tokenSet = (text) => new Set(tokensOf(String(text ?? '')));

/** A term matches a field when every token of the term is in that field's set. */
const termMatches = (termTokens, fieldSet) => termTokens.length > 0 && termTokens.every((t) => fieldSet.has(t));

const SCORE_TITLE = 3;
const SCORE_TAG = 2;
const SCORE_TEXT = 1;
const SCORE_ALL_TERMS_IN_TITLE = 4;

const byUtf8 = (a, b) => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ab, bb);
};

/**
 * The whole capability. Pure: no clock, no randomness, no environment.
 */
export function search(input) {
  const docs = Array.isArray(input?.docs) ? input.docs : null;
  if (!docs) throw Object.assign(new Error('input.docs must be an array'), { code: 'bad-input' });
  const q = input?.query ?? {};
  const terms = Array.isArray(q.terms) ? q.terms.map(String) : [];
  const wantTags = Array.isArray(q.tags) ? q.tags.map(String) : [];
  const match = q.match === 'any' ? 'any' : 'all';
  const from = typeof q.from === 'number' ? q.from : null;
  const to = typeof q.to === 'number' ? q.to : null;
  const limit = typeof input?.limit === 'number' ? input.limit : 0;
  if (limit < 0) throw Object.assign(new Error('limit must not be negative'), { code: 'bad-input' });

  const termTokens = terms.map((t) => tokensOf(t));

  const hits = [];
  const tagCounts = Object.create(null);
  const monthCounts = Object.create(null);
  let total = 0;
  let excludedByTime = 0;

  for (const doc of docs) {
    const titleSet = tokenSet(doc.title);
    const textSet = tokenSet(doc.text);
    const tagList = Array.isArray(doc.tags) ? doc.tags.map(String) : [];
    const tagSets = tagList.map(tokenSet);

    // tag filter: every requested tag present, compared as exact strings after normalization
    if (wantTags.length && !wantTags.every((t) => tagList.includes(t))) continue;

    // term filter
    if (termTokens.length) {
      const matched = termTokens.map((tt) => termMatches(tt, titleSet) || tagSets.some((s) => termMatches(tt, s)) || termMatches(tt, textSet));
      const ok = match === 'all' ? matched.every(Boolean) : matched.some(Boolean);
      if (!ok) continue;
    }

    // time range: a document with no ts is excluded as soon as either bound is set, and counted
    const ts = typeof doc.ts === 'number' ? doc.ts : null;
    if (from !== null || to !== null) {
      if (ts === null) {
        excludedByTime++;
        continue;
      }
      if (from !== null && ts < from) {
        excludedByTime++;
        continue;
      }
      if (to !== null && ts > to) {
        excludedByTime++;
        continue;
      }
    }

    // score: integers only, and a term can earn all three fields
    let score = 0;
    for (const tt of termTokens) {
      if (termMatches(tt, titleSet)) score += SCORE_TITLE;
      if (tagSets.some((s) => termMatches(tt, s))) score += SCORE_TAG;
      if (termMatches(tt, textSet)) score += SCORE_TEXT;
    }
    if (termTokens.length && termTokens.every((tt) => termMatches(tt, titleSet))) score += SCORE_ALL_TERMS_IN_TITLE;

    total++;
    for (const tag of tagList) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    if (ts !== null) {
      const d = new Date(ts);
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      monthCounts[month] = (monthCounts[month] ?? 0) + 1;
    }
    hits.push({ id: String(doc.id), score, ts });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.ts === null ? -Infinity : a.ts;
    const bt = b.ts === null ? -Infinity : b.ts;
    if (at !== bt) return bt - at; // ts descending, null last
    return byUtf8(a.id, b.id); // UTF-8 bytes, not locale collation
  });

  const sortedFacet = (obj) => {
    const out = {};
    for (const key of Object.keys(obj).sort(byUtf8)) out[key] = obj[key];
    return out;
  };

  return {
    hits: (limit > 0 ? hits.slice(0, limit) : hits).map((h) => ({ id: h.id, score: h.score })),
    total,
    facets: { tags: sortedFacet(tagCounts), months: sortedFacet(monthCounts) },
    excludedByTime,
  };
}

// ── the protocol, the same shape as the text workers ────────────────────────────────────────

export const CAPABILITIES = {
  'search.query': (input) => search(input),
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
  ['empty query matches everything', () => search({ docs: [{ id: 'a', title: 'x', text: 'y', tags: [], ts: null }], query: {} }).total === 1],
  ['scoring adds title, tag and text for one term', () => {
    const r = search({ docs: [{ id: 'a', title: 'openai', text: 'openai', tags: ['openai'], ts: null }], query: { terms: ['openai'] } });
    return r.hits[0].score === 3 + 2 + 1 + 4;
  }],
  ['a CJK term matches through the bigram tokenizer', () => {
    const r = search({ docs: [{ id: 'a', title: '已经开播了', text: '', tags: [], ts: null }], query: { terms: ['已经'] } });
    return r.total === 1;
  }],
  ['match:all requires every term', () => {
    const docs = [{ id: 'a', title: 'one', text: '', tags: [], ts: null }];
    return search({ docs, query: { terms: ['one', 'two'], match: 'all' } }).total === 0 && search({ docs, query: { terms: ['one', 'two'], match: 'any' } }).total === 1;
  }],
  ['ties break by ts descending then id by UTF-8 bytes', () => {
    const docs = [
      { id: 'b', title: 'x', text: '', tags: [], ts: 200 },
      { id: 'a', title: 'x', text: '', tags: [], ts: 200 },
      { id: 'c', title: 'x', text: '', tags: [], ts: null },
    ];
    const ids = search({ docs, query: { terms: ['x'] } }).hits.map((h) => h.id);
    return ids.join(',') === 'a,b,c';
  }],
  ['a null ts is excluded by a range and counted', () => {
    const docs = [
      { id: 'a', title: 'x', text: '', tags: [], ts: null },
      { id: 'b', title: 'x', text: '', tags: [], ts: 100 },
    ];
    const r = search({ docs, query: { terms: ['x'], from: 1 } });
    return r.total === 1 && r.excludedByTime === 1;
  }],
  ['facets count the matching set, keys sorted by UTF-8 bytes', () => {
    const docs = [
      { id: 'a', title: 'x', text: '', tags: ['zeta', 'alpha'], ts: 0 },
      { id: 'b', title: 'x', text: '', tags: ['alpha'], ts: 0 },
    ];
    const r = search({ docs, query: { terms: ['x'] } });
    return r.facets.tags.alpha === 2 && r.facets.tags.zeta === 1 && Object.keys(r.facets.tags).join(',') === 'alpha,zeta';
  }],
  ['a tag filter is exact', () => {
    const docs = [{ id: 'a', title: 'x', text: '', tags: ['Nijisanji'], ts: null }];
    return search({ docs, query: { tags: ['nijisanji'] } }).total === 0;
  }],
  ['limit truncates hits but not total', () => {
    const docs = [1, 2, 3].map((n) => ({ id: 'd' + n, title: 'x', text: '', tags: [], ts: null }));
    const r = search({ docs, query: { terms: ['x'] }, limit: 2 });
    return r.hits.length === 2 && r.total === 3;
  }],
  ['a negative limit is bad input', () => {
    try {
      search({ docs: [], query: {}, limit: -1 });
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
    process.stderr.write('usage: vmlsearch.js --capability search.query | --selfcheck\n');
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

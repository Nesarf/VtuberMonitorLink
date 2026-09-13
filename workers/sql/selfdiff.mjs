// workers/sql/selfdiff.mjs — this worker's own differential against the JavaScript reference.
//
// It is not part of the protocol and the conformance harness does not call it. It exists because the
// corpus is a floor and not a ceiling: the 16 reviewed cases pin the rules one at a time, and the bugs in
// this file that mattered (the tag field summed as one token set, the token count used as the term count,
// the whole-query bonus compared against matched instead of requested terms, and the epoch's floor
// division) were all found by running *this* worker against the reference over inputs the corpus does not
// contain. It is kept so the next person can do the same after any change.
//
//   node workers/sql/selfdiff.mjs        # exit 0 when every input agrees, 1 with the differences shown
//
// The comparison is semantic (key order does not decide it, values do), which is the harness's own rule
// from tools/workers.mjs.
import fs from 'node:fs';
import { search as sqlSearch } from './vmlsearch.mjs';
import { search as refSearch } from '../js/vmlsearch.js';

const canon = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
};

let same = 0;
const diffs = [];
const run = (label, input) => {
  let a, b;
  try { a = canon(sqlSearch(input)); } catch (e) { a = 'ERR:' + e.code; }
  try { b = canon(refSearch(input)); } catch (e) { b = 'ERR:' + e.code; }
  if (a === b) same++;
  else diffs.push({ label, sql: a, ref: b, input });
};

// 1. the reviewed corpus
const corpus = JSON.parse(fs.readFileSync(new URL('../spec/cases/search.query.json', import.meta.url), 'utf8'));
for (const c of corpus.cases) run('corpus/' + c.id, c.input);

// 2. generated variants over the corpus documents, which is where the corpus's own coverage stops
const docsOf = (c) => c.input.docs ?? [];
const allDocs = corpus.cases.flatMap(docsOf);
const termPool = ['openai', 'hololive', '已经', '3d', 'x', 'stream', 'gpt', 'live', '披露', '??', 'a,b', 'Nijisanji', 'nijisanji', 'hololive 3d', '', '  ', '已经开播'];
const tagPool = [[], ['hololive'], ['3d'], ['nijisanji'], ['openai'], ['Nijisanji'], ['hololive', '3d']];
let seeds = 20240913;
const rnd = () => (seeds = (seeds * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 400; i++) {
  const docs = [];
  const n = 1 + Math.floor(rnd() * 6);
  for (let d = 0; d < n; d++) docs.push(allDocs[Math.floor(rnd() * allDocs.length)]);
  const terms = [];
  const nt = Math.floor(rnd() * 4);
  for (let t = 0; t < nt; t++) terms.push(termPool[Math.floor(rnd() * termPool.length)]);
  const tags = tagPool[Math.floor(rnd() * tagPool.length)];
  const query = { terms, tags, match: rnd() < 0.5 ? 'all' : 'any' };
  if (rnd() < 0.4) query.from = 1735689600000;
  if (rnd() < 0.4) query.to = 1736121600000;
  if (rnd() < 0.15) query.from = null;
  if (rnd() < 0.15) query.to = null;
  run('gen/' + i, { docs, query, limit: rnd() < 0.3 ? Math.floor(rnd() * 3) : 0 });
}

// 3. the rules one at a time, including the ones the corpus does not reach
const doc = (id, title, text, tags, ts) => ({ id, title, text, tags, ts });
run('edge/negative ts', { docs: [doc('a', 'x', '', [], -1), doc('b', 'x', '', [], -1000), doc('c', 'x', '', [], -31536000000)], query: {}, limit: 0 });
run('edge/ts exactly at 0', { docs: [doc('a', 'x', '', [], 0)], query: { from: 0, to: 0 }, limit: 0 });
run('edge/cjk bigram single char', { docs: [doc('a', '已', '', [], null)], query: { terms: ['已'] }, limit: 0 });
run('edge/cjk three char term', { docs: [doc('a', '已经开播了', '', [], null)], query: { terms: ['已经开'] }, limit: 0 });
run('edge/kana bigrams', { docs: [doc('a', 'アイドル', '', [], null)], query: { terms: ['イド'] }, limit: 0 });
run('edge/hangul bigrams', { docs: [doc('a', '방송중', '', [], null)], query: { terms: ['방송'] }, limit: 0 });
run('edge/latin punctuation edges', { docs: [doc('a', 'openai!', 'openai,', [], null)], query: { terms: ['openai.'] }, limit: 0 });
run('edge/punctuation-only term in any mode', { docs: [doc('a', 'x', '???', [], null)], query: { terms: ['???', 'x'], match: 'any' }, limit: 0 });
run('edge/punctuation-only term in all mode', { docs: [doc('a', 'x', '???', [], null)], query: { terms: ['???', 'x'], match: 'all' }, limit: 0 });
run('edge/term repeated three times', { docs: [doc('a', 'x', 'x', ['x'], null)], query: { terms: ['x', 'x', 'x'] }, limit: 0 });
run('edge/duplicate tags counted', { docs: [doc('a', 'x', '', ['t', 't'], null)], query: { terms: ['x'] }, limit: 0 });
run('edge/duplicate tags in filter', { docs: [doc('a', 'x', '', ['t'], null)], query: { tags: ['t', 't'] }, limit: 0 });
run('edge/tag that tokenizes to nothing', { docs: [doc('a', 'x', '', ['???'], null)], query: { terms: ['???'] }, limit: 0 });
run('edge/empty terms and tag filter only', { docs: [doc('a', 'x', '', ['t'], 5), doc('b', 'x', '', [], 6)], query: { tags: ['t'] }, limit: 0 });
run('edge/id bytes: ascii vs accented vs cjk', {
  docs: [doc('a', 'x', '', [], 1), doc('A', 'x', '', [], 1), doc('\u00e9', 'x', '', [], 1), doc('z', 'x', '', [], 1), doc('\u4e2d', 'x', '', [], 1), doc('_', 'x', '', [], 1)],
  query: { terms: ['x'] }, limit: 0,
});
run('edge/all null ts ties', { docs: [doc('b', 'x', '', [], null), doc('a', 'x', '', [], null)], query: { terms: ['x'] }, limit: 0 });
run('edge/limit larger than hits', { docs: [doc('a', 'x', '', [], null)], query: { terms: ['x'] }, limit: 99 });
run('edge/from only', { docs: [doc('a', 'x', '', [], null), doc('b', 'x', '', [], 5), doc('c', 'x', '', [], 50)], query: { from: 5 }, limit: 0 });
run('edge/to only', { docs: [doc('a', 'x', '', [], null), doc('b', 'x', '', [], 5), doc('c', 'x', '', [], 50)], query: { to: 5 }, limit: 0 });
run('edge/from greater than to', { docs: [doc('a', 'x', '', [], 5)], query: { from: 10, to: 1 }, limit: 0 });
run('edge/negative bounds', { docs: [doc('a', 'x', '', [], -5)], query: { from: -10, to: -1 }, limit: 0 });
run('edge/month boundary dec 31', { docs: [doc('a', 'x', '', [], 1735689599999)], query: {}, limit: 0 });
run('edge/month boundary jan 1', { docs: [doc('a', 'x', '', [], 1735689600000)], query: {}, limit: 0 });
run('edge/multi-token term split across fields', { docs: [doc('a', 'openai', 'gpt', [], null), doc('b', 'openai gpt', '', [], null)], query: { terms: ['openai gpt'] }, limit: 0 });
run('edge/multi-token term in a tag', { docs: [doc('a', 'x', '', ['openai gpt'], null)], query: { terms: ['openai gpt'] }, limit: 0 });
run('edge/multi-token term half in a tag', { docs: [doc('a', 'x', '', ['openai', 'gpt'], null)], query: { terms: ['openai gpt'] }, limit: 0 });
run('edge/bonus with duplicate term', { docs: [doc('a', 'x', '', [], null)], query: { terms: ['x', 'x'] }, limit: 0 });
run('edge/bonus single of two terms in title', { docs: [doc('a', 'x y', '', [], null)], query: { terms: ['x', 'z'], match: 'any' }, limit: 0 });
run('edge/no docs with a tag filter', { docs: [], query: { tags: ['t'] }, limit: 0 });
run('edge/star and unicode in facet keys', { docs: [doc('a', 'x', '', ['Z', 'a', '\u00e9', '\u4e2d'], 0)], query: {}, limit: 0 });
run('edge/whitespace-only title and text', { docs: [doc('a', '   ', '\t\n', ['  '], null)], query: { terms: ['x'] }, limit: 0 });
run('edge/full-width term', { docs: [doc('a', 'openai', '', [], null)], query: { terms: ['\uff4f\uff50\uff45\uff4e\uff41\uff49'] }, limit: 0 });
run('edge/tab inside a term', { docs: [doc('a', 'openai', '', [], null)], query: { terms: ['openai\t'] }, limit: 0 });
run('edge/missing query key', { docs: [doc('a', 'x', '', [], null)], limit: 0 });
run('edge/missing limit key', { docs: [doc('a', 'x', '', [], null)], query: { terms: ['x'] } });
run('edge/docs not an array', { docs: 'nope', query: {} });
run('edge/bad input limit', { docs: [], query: {}, limit: -1 });
run('edge/unknown match value', { docs: [doc('a', 'x y', '', [], null)], query: { terms: ['x', 'z'], match: 'ANY' }, limit: 0 });
run('edge/string ts is null', { docs: [doc('a', 'x', '', [], '100')], query: { from: 1 }, limit: 0 });
run('edge/numeric ids', { docs: [doc(7, 'x', '', [], null), doc(10, 'x', '', [], null)], query: { terms: ['x'] }, limit: 0 });

console.log(`differential: ${same}/${same + diffs.length} identical`);
for (const d of diffs.slice(0, 10)) {
  console.log('\nDIFF ' + d.label);
  console.log('  sql: ' + d.sql.slice(0, 400));
  console.log('  ref: ' + d.ref.slice(0, 400));
  console.log('  input: ' + JSON.stringify(d.input).slice(0, 400));
}
process.exit(diffs.length ? 1 : 0);

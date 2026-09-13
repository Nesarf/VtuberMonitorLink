// Diff the Java worker against the JavaScript reference over the real stdio protocol, and check the
// protocol edges that have no reference counterpart (bad input, unknown op, wrong capability).
//   node workers/java/tools/compare-reference.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const JAR = path.join(ROOT, 'workers', 'java', 'dist', 'vmltext.jar');
const REF = path.join(ROOT, 'workers', 'js', 'vmltext.js').replace(/\\/g, '/');

const reference = await import(`file:///${REF}`);

const JVM = [
  '-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8',
  '-jar', JAR,
];

function pipe(lines, capability) {
  const run = spawnSync('java', [...JVM, '--capability', capability], {
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return { out: run.stdout.split('\n').filter((l) => l.length > 0), err: run.stderr, status: run.status };
}

/** Every input the differential check runs, through both implementations. */
function corpus() {
  const mk = () => [];
  const rows = [];

  const normalizeTexts = [
    '\uFF23\uFF41\uFF46\u00E9\u3000\u2014\u3000L\'\u00C9T\u00C9\u200B', // probe a
    '\u0141\u00F3d\u017A   \u017B\u00D3\u0141\u0106',                   // probe b
    '',
    '   ',
    '\u00C9',
    '\u0130stanbul',
    'e\u0301',                                                          // decomposed e + acute
    '\u1AB0\u1DC0\u20D0\uFE20',                                         // the other mark ranges
    '\u5DF2\u7ECF\u5F00\u64AD\u4E86',
    '\u3053\u3093\u306B\u3061\u306F \uD55C\uAD6D\uC5B4',
    '\u041F\u0440\u0438\u0432\u0435\u0442 \u0645\u0631\u062D\u0628\u0627',
    'a\u200Bb\uFEFFc\u202Ed',
    '\u201Ca\u201D \u2018b\u2019 c\u2014d\u2026 1\u3001 2\u3002',
    '  a \t\r\n b  ',
    'a\u00A0\u3000\u2003b',
    'x'.repeat(200) + '\u00E9',
  ];
  for (const text of normalizeTexts) rows.push({ capability: 'text.normalize', input: { text } });

  const htmls = [
    '<p>Hello <b>world</b></p><a href="/x">Link</a> <img src=a>',       // probe c
    '',
    '<title>T</title><p>body</p><img src=a>',
    '<title>T</title><p>body</p>',
    '<title>  spaced  title  </title><p>x</p>',
    '<a href="/x">L</a> <a href="https://e.com">M</a>',
    '<a>no href</a>',
    '<a href="mailto:a@b.c">m</a>',
    '<a href="x">A</a><a href="y">B</a>',
    '<p>a<b>b</b>',
    'a<b',
    '<script>var a=1</script>x',
    '<STYLE>p{}</STYLE>y',
    '<script>never closes',
    '<!-- comment -->a<!-- another',
    '<!DOCTYPE html><p>a</p>',
    '<![CDATA[raw <b>text</b>]]>',
    'a &amp b &amp; c',
    'a &hellip b &hellip; c',
    'a &copy2024 b',
    'a &unknown; b &lone',
    'a &#32; b &#x20 c &#38; d',
    'a &#xD800; b &#1114112; c',
    '<a href="x>y">z</a>',
    "<a href='q'>s</a>",
    '<img src=a><IMG src=b></img><image src=c>',
    '<div><p>a</p><p>b</p></div>',
    '<br><hr/><li>i</li><td>d</td>',
    '<ul><li>one</li><li>two</li></ul>',
    'text & < not a tag',
    '<p>Caf\u00E9 \u5DF2\u7ECF</p>',
    '<title>Caf\u00E9</title>and <a href="/e">Caf\u00E9</a>',
    '&nbsp;&mdash;&ndash;&hellip;&laquo;&raquo;&copy;&reg;&trade;&times;&middot;',
    '<a href="">empty</a>',
    '<p>a</p><script>x</script><p>b</p>',
    // CDATA is character data: the body is literal text and must not be re-parsed as markup, and an
    // unclosed section keeps everything to the end of the input.
    '<![CDATA[<b>raw</b>]]>',
    '<![CDATA[unclosed',
    '<![CDATA[a &amp; b &#65;]]>',
    '<p><![CDATA[<script>alert(1)</script>]]></p>',
    '<![CDATA[<!-- comment -->]]>',
    '<![CDATA[]]>',
    'x<![CDATA[y]]>z',
    '<p><![CDATA[x',
    '<![CDATA[a<div>b',
    '<![CDATA[a]]]]>b',
    '<![CDATA[<p>]]>',
    '<title><![CDATA[T]]></title>',
    '<a><![CDATA[q]]></a>',
    // End of input inside a tag: the incomplete tag is dropped, name characters and all, and it
    // contributes no newline.
    '<p',
    '<p ',
    '<P',
    '<br',
    '</p',
    '<a',
    '<a href="/x"',
    '<p a="1"',
    '<b>a</b<b',
    'abc<b',
    '<p>abc<b',
    'a<',
    // A title's text belongs to the title, and to nothing else.
    '<a href="/x"><title>T</title>t</a>',
    '<a href="/x"><title>T</title>t</a><a href="/y">u</a>',
  ];
  for (const html of htmls) rows.push({ capability: 'text.extract', input: { html, baseUrl: null } });
  rows.push({ capability: 'text.extract', input: { html: '<a href="/r">R</a>', baseUrl: 'https://e.com' } });

  const fingerprintTexts = [
    'openai gpt \u5DF2\u7ECF \u5DF2\u7ECF',                              // probe d
    'x',                                                                 // probe e
    '',
    '   ',
    '-- !!',
    'hello, -- !! x.',
    ',,hello,,',
    'hello world',
    'hello world again',
    'hello world again and',
    '\u5DF2\u7ECF\u5F00\u64AD',
    '\u5DF2',
    '\u5DF2\u7ECF abc',
    'abc \u5DF2\u7ECF',
    '\uD55C\uAD6D\uC5B4',
    'caf\u00E9',
    'a\u0001b',
    '...',
    'a.b.c',
    '(',
    'a(b)c',
    'Hello, World!',
  ];
  for (const text of fingerprintTexts) rows.push({ capability: 'text.fingerprint', input: { text } });

  return rows;
}

const rows = corpus();
// One worker process per capability, which is what the contract says a worker handles: mixing
// capabilities in one process is correctly refused, so the harness must not do it either.
const actual = [];
for (const capability of ['text.normalize', 'text.extract', 'text.fingerprint']) {
  const indexes = rows.map((r, i) => (r.capability === capability ? i : -1)).filter((i) => i >= 0);
  const requests = indexes.map((i) => JSON.stringify({
    id: i + 1, op: 'invoke', capability, input: rows[i].input,
  }));
  const got = pipe(requests, capability).out;
  if (got.length !== indexes.length) {
    process.stdout.write(`  [DIFF] ${capability}: expected ${indexes.length} responses, got ${got.length}\n`);
  }
  indexes.forEach((i, k) => { actual[i] = got[k]; });
}
const expected = rows.map((r, i) => JSON.stringify({
  id: i + 1,
  ok: true,
  output: reference.CAPABILITIES[r.capability](r.input),
}));

let bad = 0;
for (let i = 0; i < rows.length; i++) {
  const label = `${i + 1} ${rows[i].capability} ${JSON.stringify(rows[i].input).slice(0, 70)}`;
  if (expected[i] === actual[i]) {
    process.stdout.write(`  [same] ${label}\n`);
  } else {
    bad++;
    process.stdout.write(`  [DIFF] ${label}\n     reference: ${expected[i]}\n     java     : ${actual[i]}\n`);
  }
}
if (actual.length !== expected.length) {
  bad++;
  process.stdout.write(`  [DIFF] response count: reference ${expected.length}, java ${actual.length}\n`);
}
process.stdout.write(`corpus: ${rows.length - bad}/${rows.length} responses byte-identical to the reference\n`);

// -- protocol edges, checked against the contract rather than against the reference ------------
const edges = [
  // [request line, expected response line (or /regex/), description]
  ['{"id":1,"op":"describe"}',
    /^\{"id":1,"ok":true,"worker":\{"protocol":1,"capability":"text\.normalize","language":"java","impl":"table-driven","runtime":"JDK [^"]+","deterministic":true\}\}$/,
    'describe'],
  ['{"id":2,"op":"invoke","capability":"text.normalize","input":{"text":42}}',
    '{"id":2,"ok":false,"error":{"code":"bad-input","message":"input.text must be a string"}}',
    'non-string input'],
  ['{"id":6,"op":"invoke","capability":"text.normalize","input":{}}',
    '{"id":6,"ok":false,"error":{"code":"bad-input","message":"input.text must be a string"}}',
    'missing input'],
  ['{"id":4,"op":"nonsense"}',
    '{"id":4,"ok":false,"error":{"code":"unsupported","message":"unknown op nonsense"}}',
    'unknown op'],
  ['{"id":5,"op":"invoke","capability":"text.fingerprint","input":{"text":"x"}}',
    '{"id":5,"ok":false,"error":{"code":"unsupported","message":"this worker implements text.normalize, not text.fingerprint"}}',
    'capability the worker was not started with'],
  ['{"i am not json',
    /^\{"id":null,"ok":false,"error":\{"code":"bad-input","message":"request is not JSON: .+"\}\}$/,
    'malformed request line'],
  ['{"id":7,"op":"shutdown"}',
    '{"id":7,"ok":true}',
    'shutdown answers the bare envelope (section 1: the reference carries an extra output payload)'],
];
let edgeBad = 0;
for (const [request, want, label] of edges) {
  const got = pipe([request], 'text.normalize').out[0];
  const ok = want instanceof RegExp ? want.test(got ?? '') : got === want;
  if (ok) {
    process.stdout.write(`  [ok]   edge: ${label}\n`);
  } else {
    edgeBad++;
    process.stdout.write(`  [DIFF] edge: ${label}\n     want: ${want}\n     got : ${got}\n`);
  }
}
process.stdout.write(`edges: ${edges.length - edgeBad}/${edges.length} as specified\n`);

process.exit(bad === 0 && edgeBad === 0 ? 0 : 1);

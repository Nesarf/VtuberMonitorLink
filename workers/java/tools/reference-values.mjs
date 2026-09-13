// Print the reference's answers for a batch of inputs, as Java string literals ready to paste into
// SelfCheck.java. Kept so the self-check's expected values are the reference's, not my guesses.
//   node workers/java/tools/reference-values.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(HERE, '..', '..', 'js', 'vmltext.js').replace(/\\/g, '/');
const reference = await import(`file:///${REF}`);

const normalize = [
  '\uFF21\uFF22\uFF23\u3000\uFF11\uFF12\uFF13',
  'Caf\u00E9',
  '\u00C9',
  '\u0141\u00F3d\u017A   \u017B\u00D3\u0141\u0106',
  '\u0130stanbul',
  'e\u0301',
  'a\u1AB0\u1DC0\u20D0\uFE20',
  '\u5DF2\u7ECF\u5F00\u64AD\u4E86',
  '\u3053\u3093\u306B\u3061\u306F \uD55C\uAD6D\uC5B4',
  'a\u200Bb',
  '\u201Ca\u201D \u2018b\u2019 c\u2014d\u2026 1\u3001 2\u3002',
  '  a \t\r\n b  ',
  '',
  '   ',
];
const extract = [
  '<p>x</p><script>var a=1</script>',
  '<STYLE>p{}</STYLE>y',
  '<p>a<b>b',
  'a<b',
  '<style>p{color:red}',
  'a &amp b',
  'a &amp; b',
  'a &hellip b',
  'a &unknown; b',
  'a &copy2024 b',
  'a &#32; b',
  'a &#x20 b',
  'a &#x2014; b',
  'a&nbsp;b',
  'a &#xD800; b',
  'a &#1114112; b',
  '<a href="/x">L</a> <a href="https://e.com">M</a>',
  '<a>L</a>',
  '<a href="x>y">z</a>',
  '<a href="/x">Caf\u00E9 </a>',
  '<title>T</title><p>body</p><img src=a>',
  '<p>no title here</p>',
  '<title>One</title><title>Two</title><p>body</p>',
  '<title>A &amp; B \u2014 C</title><p>x</p>',
  'CAF&eacute;',
  '<b>Caf\u00E9</b>',
  'a<!-- c -->b',
  '<p>a</p><script>var x = 1;',
  '<a href="/one">one<a href="/two">two',
  '<a href="/x">a <b>b</b> c</a>',
  '<p>a&nbsp;b\u3000\u3000c</p>',
  '<img src=a><IMG src=b><!-- <img src=c> --><img src=d>',
  '<a href="//cdn.e.com/x">3</a>',
  '<![CDATA[raw <b>text</b>]]>',
  '<p>Hello <b>world</b></p><a href="/x">Link</a> <img src=a>',
];
const fingerprint = [
  'openai gpt \u5DF2\u7ECF \u5DF2\u7ECF',
  'x',
  '-- !!',
  '',
  '\u5DF2\u7ECF\u5F00\u64AD',
  ',',
  'a(b)c',
  'hello',
  'hello,',
  ',hello,',
  'hello, world.',
];

const lit = (s) => JSON.stringify(s).replace(/\\u([0-9a-f]{4})/gi, (m, h) => {
  const cp = parseInt(h, 16);
  return cp < 0x20 ? m : `\\u${h.toUpperCase()}`;
});

for (const text of normalize) {
  process.stdout.write(`normalize ${lit(text)} -> ${lit(reference.normalize(text))}\n`);
}
for (const html of extract) {
  const r = reference.extract(html);
  process.stdout.write(`extract   ${lit(html)} -> title=${lit(r.title)} text=${lit(r.text)} images=${r.images} links=${JSON.stringify(r.links)}\n`);
}
for (const text of fingerprint) {
  const r = reference.fingerprint(text);
  process.stdout.write(`fingerprint ${lit(text)} -> tokens=${r.tokens} shingles=${r.shingles} simhash=${r.simhash}\n`);
}

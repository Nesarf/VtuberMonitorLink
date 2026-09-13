// Probe the reference on the CDATA and title-inside-anchor details the corpus cases do not pin.
//   node workers/java/tools/probe-reference-cdata.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(HERE, '..', '..', 'js', 'vmltext.js').replace(/\\/g, '/');
const reference = await import(`file:///${REF}`);

const cases = [
  '<![CDATA[<b>raw</b>]]>',
  '<![CDATA[unclosed',
  '<p',
  '<a href="/x"><title>T</title>t</a>',
  '<![CDATA[a &amp; b &#65;]]>',
  '<p><![CDATA[<script>alert(1)</script>]]></p>',
  '<![CDATA[<!-- comment -->]]>',
  '<![CDATA[]]>',
  'x<![CDATA[y]]>z',
  '<p><![CDATA[x',
  '<![CDATA[a<div>b',
  '<![CDATA[a]]]]>b',
  '<a><![CDATA[q]]></a>',
  '<![CDATA[<p>]]>',
  '<title><![CDATA[T]]></title>',
  '<![doctype html>',
  '<p',
  '<p ',
  '<P',
  '<br',
  '</p',
  '<a',
  '<a href="/x"',
];

for (const html of cases) {
  const r = reference.extract(html);
  process.stdout.write(`${JSON.stringify(html).padEnd(48)} -> ${JSON.stringify({
    title: r.title, text: r.text, links: r.links, images: r.images,
  })}\n`);
}

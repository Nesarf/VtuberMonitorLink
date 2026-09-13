// One-off generator for the corpus section of SelfCheck.java: reads the shipped corpus and the
// reviewed snapshot and prints the Java source for the assertions. The values are copied verbatim
// from workers/spec/expected/*.json, so the self-check is pinned to the contract, not to a guess.
//   node tools/gen-selfcheck-corpus.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.resolve(HERE, '..', '..', 'spec');

const jstr = (s) => {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp > 0x7E) out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
};

for (const capability of ['text.normalize', 'text.extract', 'text.fingerprint']) {
  const cases = JSON.parse(fs.readFileSync(path.join(SPEC, 'cases', capability + '.json'), 'utf8')).cases;
  const expected = JSON.parse(fs.readFileSync(path.join(SPEC, 'expected', capability + '.json'), 'utf8')).cases;
  process.stdout.write(`// ---- ${capability}\n`);
  for (const c of cases) {
    const e = expected[c.id];
    if (!e) {
      process.stdout.write(`// (no snapshot for ${c.id})\n`);
      continue;
    }
    const input = c.input;
    if (capability === 'text.normalize') {
      process.stdout.write(
        `corpus("${c.id}", normalize(${jstr(input.text)}), ${jstr(e.text)});\n`);
    } else if (capability === 'text.fingerprint') {
      process.stdout.write(
        `fingerprintCorpus("${c.id}", ${jstr(input.text)}, ${jstr(e.simhash)}, ${e.tokens}, ${e.shingles});\n`);
    } else {
      const links = e.links.map((l) => `link(${jstr(l.href)}, ${l.absolute}, ${jstr(l.text)})`).join(', ');
      process.stdout.write(
        `extractCorpus("${c.id}", ${jstr(input.html)}, ${jstr(e.title)}, ${jstr(e.text)}, `
        + `links(${links}), ${e.images});\n`);
    }
  }
}

// docs-test.mjs — the About panel's allowlist: which documents the app may show, and what each one is called.
//
// Why this list is worth a test: `GET /api/readme` used to hard-code two Readme file names, and the first change
// that adds a document is exactly where a user-controlled path creeps in - "just pass the file name" is one line
// and it turns a panel that shows three known documents into a route that reads whatever it is asked for. The
// property that has to hold is therefore not "privacy works" but "the caller picks a key and never a path", and
// that is a property of `server/src/docs.js` alone, so it can be tested here with no server, no port and no app.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, docFile, docLang, docTitle, pickDoc, readDocs } from '../server/src/docs.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

t('a known name picks its document, and any other name picks the Readme', () => {
  assert.equal(pickDoc('privacy').name, 'privacy');
  assert.equal(pickDoc('security').name, 'security');
  assert.equal(pickDoc('readme').name, 'readme');
  assert.equal(pickDoc('').name, 'readme', 'an empty name is the default document');
  assert.equal(pickDoc(undefined).name, 'readme', 'a missing name is the default document');
  assert.equal(pickDoc('PRIVACY').name, 'privacy', 'the name is matched case-insensitively');
  // The controls, and they are the point of this file: every traversal-shaped name is simply an unknown name.
  for (const bad of ['../../etc/passwd', '..\\..\\windows\\win.ini', 'docs/PRIVACY.md', 'PRIVACY.md', 'privacy/../secret']) {
    assert.equal(pickDoc(bad).name, 'readme', `${JSON.stringify(bad)} must not select a document`);
  }
});

t('every document resolves to a file from the allowlist and never to the name it was asked for', () => {
  const allowed = new Set(DOCS.flatMap((d) => Object.values(d.files)));
  for (const name of [...DOCS.map((d) => d.name), 'nonsense', '../README.md']) {
    for (const lang of ['en', 'zh', 'ja']) {
      const file = docFile(pickDoc(name), lang);
      assert.ok(allowed.has(file), `${JSON.stringify(name)} in ${lang} resolved to ${file}, which is not in the allowlist`);
    }
  }
  // control: a real document is reachable, so the loop above is not passing because nothing resolves at all.
  assert.equal(docFile(pickDoc('privacy'), 'en'), 'docs/PRIVACY.md');
});

t('the language is Chinese only when it is asked for, and a document without that language falls back', () => {
  assert.equal(docLang('zh'), 'zh');
  assert.equal(docLang('zh-CN'), 'zh');
  assert.equal(docLang('ZH-Hant'), 'zh');
  assert.equal(docLang('en'), 'en');
  assert.equal(docLang('en-US'), 'en');
  assert.equal(docLang(''), 'en');
  assert.equal(docLang(undefined), 'en');
  assert.notEqual(docLang('en'), 'zh', 'the control: English is not Chinese');
  // The Readmes exist in two languages; every other document exists in one, and asking for the other language
  // must yield the file that exists rather than an empty path.
  assert.equal(docFile(pickDoc('readme'), 'zh'), 'README.zh-CN.md');
  assert.equal(docFile(pickDoc('readme'), 'ja'), 'README.md', 'a language the document does not have falls back to the one it does');
  assert.equal(docFile(pickDoc('privacy'), 'zh'), 'docs/PRIVACY.md', 'a single-language document ignores the language asked for');
});

t('the title is the document\'s own first heading, and a document without one falls back to its file name', () => {
  assert.equal(docTitle('# Privacy\n\nbody'), 'Privacy');
  assert.equal(docTitle('intro line\n\n## Second heading\n'), 'Second heading', 'text before the heading does not win');
  assert.equal(docTitle('#### Deep\n# Later\n'), 'Deep', 'the first heading wins even when a shallower one follows');
  // The fallback is the second argument, and the first version of this test forgot to pass it - the assertion
  // failed with '' against 'FALLBACK.md', which is the useful kind of failure: the expectation was wrong.
  assert.equal(docTitle('#NoSpace', 'FALLBACK.md'), 'FALLBACK.md', 'a hash without a space is not a heading');
  assert.equal(docTitle('plain text only', 'FALLBACK.md'), 'FALLBACK.md', 'no heading at all falls back');
  assert.equal(docTitle('#   \n', 'FALLBACK.md'), 'FALLBACK.md', 'a heading with no text is not a title');
  assert.equal(docTitle('', 'FALLBACK.md'), 'FALLBACK.md');
  // control: the fallback is used, not an empty string, so a heading-less document cannot render as a blank label.
  assert.notEqual(docTitle('plain text only', 'FALLBACK.md'), '');
});

t('the three documents are readable from this checkout, with titles that come from the files', () => {
  const r = readDocs('privacy', 'en', [ROOT]);
  assert.equal(r.wanted, 'privacy');
  assert.equal(r.available.length, DOCS.length, `expected ${DOCS.length} documents, got ${r.available.map((d) => d.name).join(', ')}`);
  for (const d of r.available) {
    assert.ok(d.title && d.title.length > 1, `${d.name} has no usable title: ${JSON.stringify(d.title)}`);
    assert.ok(!d.title.startsWith('#'), `${d.name}'s title still carries its markdown: ${JSON.stringify(d.title)}`);
  }
  assert.ok(r.found && r.found.markdown.length > 1000, 'the privacy document has no text');
  assert.equal(r.found.file, 'docs/PRIVACY.md');
  // control: a different document really is a different file, so `found` is not simply the first thing read.
  const sec = readDocs('security', 'en', [ROOT]);
  assert.notEqual(sec.found.file, r.found.file, 'the control: the two documents are different files');
  assert.notEqual(sec.found.title, r.found.title, 'the control: and their titles differ');
});

t('a root with no documents answers "nothing found" rather than throwing', () => {
  const empty = path.join(ROOT, 'node_modules'); // a directory that exists and holds no Readme of ours
  const r = readDocs('readme', 'en', [empty]);
  assert.equal(r.found, null, 'a root without the documents must answer null');
  assert.deepEqual(r.available, [], 'and must report no available documents');
  // control: the same call against the real root finds them, so "null" is about the root and not about the call.
  assert.ok(readDocs('readme', 'en', [ROOT]).found, 'the control: the real root has the documents');
});

process.stdout.write(`\ndocs: ${pass} ok, ${fail} failed\n`);
if (fail) process.exit(1);

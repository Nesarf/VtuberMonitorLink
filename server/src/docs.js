// docs.js — which documents the app may show a reader, and what each one is called.
//
// Why this exists as a module rather than five lines inside the route: `GET /api/readme` used to hard-code two
// file names (`lang=zh` → README.zh-CN.md, anything else → README.md) and that was the whole allowlist. Adding a
// document to the panel is exactly the kind of change where a user-controlled path creeps in ("just pass the file
// name"), and the honest way to prevent that is to keep the list in one place where it can be tested without a
// server: an unknown name or a traversal-shaped one must fall back to the README, and that has to be a property
// of this module rather than of a route handler nobody can call from a test.
//
// The **title** comes from the document itself - its first heading - so it cannot drift from the file, and it
// costs no i18n key: `web/src/locales/generated.js` is a ratcheted surface (a new key moves the UI key count, the
// per-locale coverage denominators and the proofread counts), and the About panel showing the file's own first
// line is the same choice the config-fault banner makes for the server's sentences.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The allowlist. `readme` is the default and the only entry with more than one language, because the Readmes are
 * the only documents that exist in two languages; a document listed here with one file is offered in that file's
 * language and no other.
 */
export const DOCS = [
  { name: 'readme', label: 'Readme', files: { en: 'README.md', zh: 'README.zh-CN.md' } },
  { name: 'privacy', label: 'Privacy', files: { en: 'docs/PRIVACY.md' } },
  { name: 'security', label: 'Security', files: { en: 'SECURITY.md' } },
  // Not a file: generated from the running configuration (server/src/privacy.js). It is in this list because the
  // allowlist is the panel's table of contents, and because "which endpoints is *this* install talking to" is the
  // question the policy documents cannot answer. Passing it through here rather than adding a second panel means
  // the reader gets it in the same place, with the same renderer, and no new UI code or i18n key.
  { name: 'machine', label: 'This machine', files: {}, dynamic: true },
];

/** The document names a caller may ask for, in the order the panel lists them. */
export const DOC_NAMES = DOCS.map((d) => d.name);

/** The language a request asks for: anything starting with `zh` is Chinese, everything else English. */
export function docLang(value) {
  return String(value ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * The document a name refers to, or the default when the name is unknown.
 *
 * Unknown → `readme`, deliberately rather than an error: the route's contract has always been "give me a readme"
 * and an old client that sends nothing must keep working. A traversal-shaped name is simply an unknown name, and
 * it never reaches the filesystem because the file names come from this list and the caller only ever picks a
 * *key* in it.
 */
export function pickDoc(name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  return DOCS.find((d) => d.name === wanted) ?? DOCS[0];
}

/** The file for one document and language, or the first file it has when that language is not written. */
export function docFile(doc, lang) {
  return doc.files[lang] ?? Object.values(doc.files)[0];
}

/**
 * The title of a document: its first markdown heading, with the leading hashes removed.
 *
 * Falls back to the file name when the document has no heading at all - a title invented from nothing would be
 * worse than a file name, and an empty title renders as a button with no label.
 */
export function docTitle(markdown, fallback = '') {
  const first = String(markdown ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^#{1,6}\s+\S/.test(l));
  if (!first) return fallback;
  return first.replace(/^#{1,6}\s+/, '').trim() || fallback;
}

/**
 * Read one document out of the first directory that has it, or generate it when the document is dynamic.
 *
 * The roots are tried in order and the file name always comes from the allowlist above, so nothing here can read
 * a file the caller chose. A document that is missing from every root answers `null` rather than throwing: the
 * panel states which documents it could not find instead of failing the whole route over one file.
 *
 * `dynamic` is a map of name → () => markdown for the entries marked `dynamic` in the list. A dynamic document
 * whose generator is missing or throws is reported as missing, not as an empty page.
 */
export function readDoc(doc, lang, roots, dynamic = {}) {
  if (doc.dynamic) {
    const make = dynamic[doc.name];
    if (typeof make !== 'function') return null;
    let markdown = '';
    try {
      markdown = String(make() ?? '');
    } catch {
      return null;
    }
    if (!markdown.trim()) return null;
    return { name: doc.name, file: `${doc.name} (generated)`, title: docTitle(markdown, doc.label), markdown };
  }
  const file = docFile(doc, lang);
  for (const root of roots) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const markdown = fs.readFileSync(p, 'utf8');
    return { name: doc.name, file, title: docTitle(markdown, file), markdown };
  }
  return null;
}

/** Everything the panel needs: the documents that exist, each with its title, and the requested one's text. */
export function readDocs(name, lang, roots, dynamic = {}) {
  const wanted = pickDoc(name);
  const available = [];
  let found = null;
  for (const doc of DOCS) {
    const one = readDoc(doc, lang, roots, dynamic);
    if (!one) continue;
    available.push({ name: doc.name, label: doc.label, title: one.title, file: one.file });
    if (doc.name === wanted.name && !found) found = one;
  }
  return { wanted: wanted.name, lang, available, found };
}

// i18n-source.mjs - parse the shipped dictionaries out of i18n.jsx
//
// Why it is factored out: both the coverage report and the translation pipeline need to "read
// the zh entries" and "list the keys the UI uses". Two separate copies inevitably drift (one
// matching a 4-space indent, the other any indent, and the two counts stop agreeing), so this is
// the **single** parsing implementation.
//
// Two traps already hit in practice, both handled here:
//   - before counting braces you must **blank out string contents** (entry text itself can
//     contain things like `{ title, body }`)
//   - take only the keys of the dictionary's **own level** (indentation cannot tell them apart:
//     a wrapped entry value sits at 6 spaces, and a nested object's keys sit at 6 spaces too)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const I18N_PATH = path.join(ROOT, 'web/src/i18n.jsx');

/** Blank out string literal contents (quoting positions are kept) */
export function stripStrings(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') {
        out += '  ';
        i++;
      } else if (c === q) {
        q = null;
        out += c;
      } else out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += c;
    } else out += c;
  }
  return out;
}

/** Extract the text span of one dictionary (bounded by the 2-space-indented closing `},`) */
export function dictBlock(src, which) {
  const startIdx = src.indexOf(`  ${which}: {`);
  if (startIdx < 0) return '';
  const after = src.slice(startIdx);
  const end = /\n  \},\n/.exec(after);
  return after.slice(0, end ? end.index : after.length);
}

/** Blank out `//` line comments (a `//` inside quotes is not a comment) */
export function stripComments(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] ?? '';
        i++;
      } else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      break; // line comment: nothing after it is code (nor entry text)
    } else out += c;
  }
  return out;
}

/** The "strip strings + strip comments" combination, used to judge structure (commas, braces) */
export function noComment(s) {
  return String(s)
    .split(/\r?\n/)
    .map((l) => stripStrings(stripComments(l)))
    .join('\n');
}

/** Pull every string literal out of a source fragment and join them (across lines `'a' + 'b'` is one value) */
export function literalValue(src) {
  const out = [];
  const cleaned = String(src)
    .split(/\r?\n/)
    .map((l) => stripComments(l))
    .join('\n');
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  for (const m of cleaned.matchAll(re)) {
    const body = m[1] ?? m[2] ?? '';
    out.push(body.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n'));
  }
  return out.join('');
}

/**
 * The "key -> value" map of one dictionary level.
 *
 * Values come in four shapes and all of them must be recognized (an early version only
 * recognized "a single-quoted string on the same line", so `appTitle: "Vtuber's Monitor Link"`
 * (double quotes) and `loginHint:` followed by a newline and a `'a' + 'b' + 'c'` concatenation
 * were read as empty strings - and in this pipeline an empty string means "no translation
 * needed", so both kinds of entry were silently untranslated in **every language**).
 *   - a 'value' / "value" on the same line
 *   - a newline after the colon, with the value on the next line
 *   - a value joined across several lines with + (the usual shape for long sentences)
 *   - a value that is an object/array (nested) -> recorded as an empty string, and it must
 *     **not swallow the lines after it**
 */
export function dictEntries(block) {
  const entries = new Map();
  const lines = block.split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripStrings(raw);
    if (depth === 1) {
      const m = /^\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:/.exec(stripped);
      if (m) {
        const key = m[1] ?? m[2];
        const tail = raw.slice(m[0].length);
        const tailStripped = noComment(tail);
        if (/[{[]/.test(tailStripped)) {
          entries.set(key, ''); // nested object/array: not entry text
        } else {
          let acc = tail;
          let j = i;
          // Read the value up to the trailing comma (at most 40 lines, so malformed source
          // cannot swallow the whole dictionary)
          while (!/[,;]/.test(noComment(acc)) && j < lines.length - 1 && j - i < 40) {
            j++;
            acc += '\n' + lines[j];
          }
          entries.set(key, literalValue(acc));
          i = j;
        }
      }
    }
    // Depth: must be counted on the line **after i was rewritten** (braces inside a multi-line
    // value are always quoted, so they get blanked out)
    for (const ch of noComment(lines[i])) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return entries;
}

/** Read the zh / en dictionaries out of the source */
export function readDicts(src = fs.readFileSync(I18N_PATH, 'utf8')) {
  return {
    zh: dictEntries(dictBlock(src, 'zh')),
    en: dictEntries(dictBlock(src, 'en')),
  };
}

/** The keys the UI actually uses: `t('key')` plus dynamic prefixes (tab_/calKind_/...) */
export function usedKeys(extraDynPrefixes = []) {
  const files = [];
  const CODE = ['.js', '.jsx'];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'locales'].includes(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (CODE.includes(path.extname(e.name))) files.push(path.join(dir, e.name));
    }
  })(path.join(ROOT, 'web/src'));
  const used = new Set();
  for (const f of files) {
    // `t('key')` and the number-aware `tn('key', n)` both reference a dictionary key, so both
    // have to be counted — otherwise migrating a label to tn() would silently drop the key from
    // coverage / proofreading (see web/src/plural.js, BUGS #54).
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\btn?\(\s*'([^']+)'\s*[,)]/g)) used.add(m[1]);
  }
  const { en } = readDicts();
  const dyn = ['tab_', 'calKind_', 'llmFeat_', 'taskMode_', 'on_', 'freq_', 'field_', 'mode_', 'sort_', ...extraDynPrefixes];
  for (const k of en.keys()) if (dyn.some((p) => k.startsWith(p))) used.add(k);
  return used;
}

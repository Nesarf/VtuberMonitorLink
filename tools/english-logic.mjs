// english-logic.mjs — guard: **the engineering layer must be English** (comments + output strings).
//
// UI strings and API error strings are deliberately NOT in scope. Chinese in this repo falls
// into three classes, and mixing them up is exactly how this refactor goes wrong:
//   * comments (they explain why the code is written this way)  -> English, for maintainers
//   * server logs / test + traversal output                     -> English, it is engineering output
//   * UI strings (web/src/i18n.jsx), API error strings returned to the client, docs/*.md
//                                                               -> KEEP Chinese, do not touch
// So this script checks only the first two: comment text, and the strings handed to
// log/console/output helpers and to the traversal `check()` name. A Chinese literal that is
// *compared* against UI text is data, not output (`main.indexOf(<a Chinese UI label>) !== -1`)
// and is skipped.
//
// Usage:
//   node tools/english-logic.mjs            check; exits 1 if Chinese remains in comments/output
//   node tools/english-logic.mjs --list     list every hit per file (use it as a work order)
//   node tools/english-logic.mjs --json     machine-readable
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** What gets scanned: wherever engineering logic lives (the UI dictionary dirs are excluded). */
function targets() {
  const out = [];
  const add = (dir, exts, skip = () => false) => {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) return;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const rel = path.relative(ROOT, p).replace(/\\/g, '/');
        if (e.isDirectory()) {
          if (['node_modules', 'dist', 'build', '__pycache__', '.cache'].includes(e.name)) continue;
          // `locales/` under tools/ holds generated data; web/src/locales is scanned for its
          // comments (the values there are data and are never flagged).
          if (e.name === 'locales' && rel !== 'web/src/locales') continue;
          walk(p);
        } else if (exts.includes(path.extname(e.name)) && !skip(rel)) {
          out.push(rel);
        }
      }
    })(base);
  };
  add('server/src', ['.js']);
  add('server/scripts', ['.js', '.cjs', '.mjs']);
  // web/src is included in full: its UI dictionary values are data (never flagged), but the
  // comments around them are engineering comments and must be English. Only the *generated*
  // regional dictionary is skipped (build output, rewritten by tools/i18n-hant.mjs).
  add('web/src', ['.js', '.jsx'], (rel) => rel.endsWith('locales/generated.js'));
  add('tools', ['.mjs', '.cjs'], (rel) => rel.includes('/locales/'));
  add('launcher', ['.cjs']);
  return out.sort();
}

/** Split a source file into comment text and output-string text. */
function scanSource(src) {
  const comments = []; // { text, line }
  const outputStrings = []; // { text, line, call }

  const lineOf = (idx) => src.slice(0, idx).split(/\r?\n/).length;

  // -- 1. Comments: walk the file char by char, skipping string contents so that a `//`
  //       inside a URL is not mistaken for a comment.
  //
  //       Two blind spots were found the hard way (a batch reported them): a regex literal
  //       containing a quote (e.g. `/<link[^>]*href="([^"]+)"/`) desyncs a naive walker —
  //       everything after it is read as string content and its Chinese comments go unreported;
  //       and `log?.info(...)` did not match the output-call patterns. Both are handled here.
  let i = 0;
  let q = null;
  const regexAllowedAfter = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  const regexStart = (idx) => {
    // Walk back to the previous significant character: a `/` after a value is division,
    // after an operator/bracket it opens a regex literal.
    for (let k = idx - 1; k >= 0; k--) {
      const p = src[k];
      if (p === ' ' || p === '\t' || p === '\n' || p === '\r') continue;
      if (p === '/' && (src[k - 1] === '/' || src[k - 1] === '*')) return true; // after a comment
      return regexAllowedAfter.has(p);
    }
    return true; // start of file
  };
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (c === '\\') i += 2;
      else {
        if (c === q) q = null;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      comments.push({ text: src.slice(i + 2, stop), line: lineOf(i), kind: 'line' });
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end;
      comments.push({ text: src.slice(i + 2, stop), line: lineOf(i), kind: 'block' });
      i = stop + 2;
      continue;
    }
    if (c === '/' && regexStart(i)) {
      // Regex literal: skip it, honouring escapes and [...] classes.
      let k = i + 1;
      let inClass = false;
      while (k < src.length) {
        const r = src[k];
        if (r === '\\') k += 2;
        else if (r === '[') {
          inClass = true;
          k++;
        } else if (r === ']') {
          inClass = false;
          k++;
        } else if (r === '/' && !inClass) break;
        else if (r === '\n') break; // not a regex after all — bail out rather than eat the file
        else k++;
      }
      i = k + 1;
      continue;
    }
    i++;
  }

  // -- 2. Output strings.
  // `log.*` / `console.*` / `process.std*.write`: **every** argument is output text.
  // `check()/t()/ta()/note()/banner()`: the first argument is the check name (output);
  //   later arguments are usually a human-readable detail, so they are scanned too --
  //   but an argument that takes part in a comparison is skipped entirely, e.g.
  //   `check('name', main.indexOf(<UI label>) !== -1)`: that Chinese is asserting UI text,
  //   it is data rather than output, and must stay as it is.
  const ALL_ARGS = [
    // `log.info(...)`, `log?.info(...)` and `ctx.log?.info(...)` are all log output; the optional
    // chaining form is easy to miss and was a real blind spot (an agent had to hand-find them).
    /\b[\w$.]*log\s*(?:\?\.|\.)\s*(?:info|warn|error|debug)\s*\(/g,
    /\bconsole\s*\.\s*(?:log|warn|error|info|debug)\s*\(/g,
    /\bprocess\s*\.\s*std(?:out|err)\s*\.\s*write\s*\(/g,
  ];
  const FIRST_ARG = [/\b(?:check|t|ta|note|banner)\s*\(/g];
  const COMPARISON = /===|!==|==|!=|indexOf|includes|startsWith|endsWith|\.match\(|\.test\(|assert|expect|deepEqual|>|</;

  for (const re of ALL_ARGS) {
    for (const m of src.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      for (let nth = 0; ; nth++) {
        const span = balanced(src, open, nth);
        if (!span) break;
        for (const lit of stringLiterals(span.text)) {
          outputStrings.push({ text: lit, line: lineOf(span.start), call: m[0].replace(/[(]$/, '') });
        }
      }
    }
  }
  for (const re of FIRST_ARG) {
    for (const m of src.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      for (let nth = 0; ; nth++) {
        const span = balanced(src, open, nth);
        if (!span) break;
        if (nth === 0 || !COMPARISON.test(span.text)) {
          for (const lit of stringLiterals(span.text)) {
            outputStrings.push({ text: lit, line: lineOf(span.start), call: m[0].replace(/[(]$/, '') + (nth ? '[detail]' : '') });
          }
        }
      }
    }
  }
  return { comments, outputStrings };
}

/** Range of the nth argument of a call whose `(` sits at openIdx (comma-split, honouring nesting and strings). */
function balanced(src, openIdx, nth = 0) {
  if (src[openIdx] !== '(') return null;
  let depth = 0;
  let q = null;
  let argStart = openIdx + 1;
  let argIndex = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (argIndex === nth) return { text: src.slice(argStart, i), start: argStart };
        return null;
      }
    } else if (c === ',' && depth === 1) {
      if (argIndex === nth) return { text: src.slice(argStart, i), start: argStart };
      argIndex++;
      argStart = i + 1;
    }
  }
  return null;
}

/** String literals inside a snippet (single/double quotes and the static parts of template literals). */
function stringLiterals(span) {
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of span.matchAll(re)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

export function checkFile(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const { comments, outputStrings } = scanSource(src);
  const bad = [];
  for (const c of comments) {
    // Escape hatch, on purpose and by name: a comment that has to *quote* a CJK character
    // (e.g. the renderer's CJK emphasis brackets, or an example of a UI string) may carry the
    // marker below and is then skipped. Use it only when the character itself is the subject of
    // the sentence — not to keep a Chinese explanation around.
    if (/english-logic:allow/.test(c.text)) continue;
    if (CJK.test(c.text)) bad.push({ kind: 'comment', line: c.line, text: c.text.trim().slice(0, 100) });
  }
  for (const s of outputStrings) if (CJK.test(s.text)) bad.push({ kind: 'output', line: s.line, text: s.text.trim().slice(0, 100), call: s.call });
  return bad;
}

export function checkTree() {
  const files = targets();
  const report = [];
  let total = 0;
  for (const f of files) {
    const bad = checkFile(f);
    if (bad.length) {
      report.push({ file: f, count: bad.length, items: bad });
      total += bad.length;
    }
  }
  return { files: files.length, total, report };
}

// -- CLI ------------------------------------------------------------
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const res = checkTree();
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else if (args.includes('--list')) {
    for (const f of res.report) {
      process.stdout.write(`${f.file}  (${f.count})\n`);
      for (const it of f.items) process.stdout.write(`    ${String(it.line).padStart(5)}  ${it.kind === 'comment' ? '//' : it.call + '()'}  ${it.text}\n`);
    }
    process.stdout.write(`\ntotal ${res.total} hits in ${res.report.length} files (scanned ${res.files} files)\n`);
  } else {
    if (!res.total) {
      process.stdout.write(`english-logic: clean (scanned ${res.files} files, no Chinese left in comments or output strings)\n`);
    } else {
      // Note: the message is assembled with `+ '\n'` rather than a template literal ending in
      // "files:\n" — the release sanitizer's "absolute drive path" rule matches a letter, a colon
      // and a backslash, so `files:\n` inside a template string looks like a drive path to it and
      // aborts the whole release (see BUGS #67).
      process.stdout.write(
        `english-logic: ${res.total} Chinese hits left in comments/output strings, across ${res.report.length} files` + '\n'
      );
      for (const f of res.report.slice(0, 40)) process.stdout.write(`  ${f.file}  (${f.count})\n`);
      if (res.report.length > 40) process.stdout.write(`  ...and ${res.report.length - 40} more files (use --list)\n`);
      process.stdout.write('  (UI strings, API error strings and docs/*.md are out of scope)\n');
      process.exit(1);
    }
  }
}

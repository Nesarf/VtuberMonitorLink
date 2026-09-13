// workers/js/vmltext.js — the reference implementation of the three text capabilities.
//
// This is the implementation the Node core calls in-process and falls back to when no compiled
// worker is available, and it is also a worker in its own right: it speaks the same JSON-Lines
// protocol as the Java, C++ and Go builds, so the conformance harness can put all of them through
// the same corpus and diff them against each other. "The reference" is not a privileged oracle —
// it is one more implementation that has to agree.
//
// It follows docs/WORKERS.md exactly, including the parts that are tedious on purpose: the case and
// fold tables come from workers/spec/*.json rather than from JavaScript's own String.toLowerCase(),
// because the whole point of the exercise is that four languages applying "their" Unicode rules
// would disagree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.resolve(HERE, '..', 'spec');

const loadTable = (file) => {
  const raw = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'));
  const map = new Map();
  for (const [k, v] of Object.entries(raw.map)) map.set(Number(k), v);
  return map;
};
const LOWER = loadTable('latin-lower.json'); // code point -> code point
const FOLD = loadTable('latin-fold.json'); // code point -> ASCII string (1-2 chars)

// -- text.normalize -------------------------------------------------

// Deleted outright: C0 controls (except tab/LF/CR), DEL, zero-width and bidi controls, BOM.
const DELETE_RANGES = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x007f],
  [0x0300, 0x036f], // combining marks: makes a decomposed string compare equal to its composed form
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
];
// Mapped one-to-one to U+0020.
const SPACE_LIKE = new Set([0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const QUOTES_SINGLE = new Set([0x2018, 0x2019, 0x201b, 0x2032]);
const QUOTES_DOUBLE = new Set([0x201c, 0x201d, 0x201f, 0x2033]);
const DASHES = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212]);

const isDeleted = (cp) => DELETE_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** One code point -> its replacement string under the mapping table ('' when nothing applies). */
function mapOne(cp) {
  if (SPACE_LIKE.has(cp)) return ' ';
  if (cp >= 0xff01 && cp <= 0xff5e) return String.fromCodePoint(cp - 0xfee0);
  if (QUOTES_SINGLE.has(cp)) return "'";
  if (QUOTES_DOUBLE.has(cp)) return '"';
  if (DASHES.has(cp)) return '-';
  if (cp === 0x2026) return '...';
  if (cp === 0x3001) return ',';
  if (cp === 0x3002) return '.';
  return null;
}

export function normalize(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (isDeleted(cp)) continue;
    // The three steps compose, in order: map, then lowercase, then fold. That sequencing is the
    // whole reason there are two tables - a code point the lower table maps (E-acute -> e-acute)
    // still has to be folded afterwards (e-acute -> e). Treating the tables as alternatives instead
    // of steps was a real bug in this reference implementation: it passed "Cafe" and failed "L'ETE",
    // and it broke idempotency (the second pass folded what the first pass had left). The Java
    // implementation, written independently from the contract, is what exposed it.
    let piece = mapOne(cp);
    if (piece === null) piece = ch;
    for (const c of piece) {
      const p = c.codePointAt(0);
      const lowered = LOWER.has(p) ? String.fromCodePoint(LOWER.get(p)) : c;
      for (const l of lowered) {
        const lp = l.codePointAt(0);
        out += FOLD.has(lp) ? FOLD.get(lp) : l;
      }
    }
  }
  return out.replace(/[ \t\n\r]+/g, ' ').trim();
}

// -- text.extract ---------------------------------------------------

const REMOVED_ELEMENTS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe'];
const NEWLINE_TAGS = new Set([
  'br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'header', 'footer', 'aside', 'nav', 'blockquote', 'pre', 'table', 'hr',
  'dd', 'dt', 'figure', 'figcaption', 'main', 'form',
]);

const NAMED_ENTITIES = {
  // Each name decodes to its own character. An earlier version of this table mapped them straight to
  // the ASCII the normalizer would produce ("-" for mdash, "(c)" for copy) - that is the normalizer's
  // job, done later by the host, and folding it in here made extract() lie about the source text.
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', laquo: '\u00ab', raquo: '\u00bb',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', times: '\u00d7', middot: '\u00b7',
};

/** Decode the entity at `i` (which points at '&'); returns [text, nextIndex] or null if none. */
function decodeEntity(src, i) {
  // The reference is looked for within 12 characters of the '&'. Named and numeric references are
  // both decoded with or without the terminating semicolon, which is what the contract says and what
  // browsers do for this list of well-known names. No backtracking: `&copy2024` therefore stays
  // literal rather than decoding `&copy` and leaving `2024` (pinned by the corpus).
  const semi = src.indexOf(';', i + 1);
  const window = src.slice(i + 1, Math.min(semi === -1 ? i + 12 : semi + 1, i + 12));
  const m = /^(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,7})(;?)/.exec(window);
  if (!m) return null;
  const body = m[1];
  const hasSemi = m[2] === ';';
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    // Skip the '#' *and* the 'x': parseInt("x2014", 16) is NaN, which silently turned every hex
    // reference into literal text. The corpus caught it (the Go and Python implementations decoded
    // the same case correctly).
    const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    return [String.fromCodePoint(cp), i + 1 + body.length + (hasSemi ? 1 : 0)];
  }
  const decoded = NAMED_ENTITIES[body.toLowerCase()];
  if (decoded === undefined) return null;
  return [decoded, i + 1 + body.length + (hasSemi ? 1 : 0)];
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function extract(html, baseUrl = null) {
  let src = String(html ?? '');
  void baseUrl; // kept in the signature for the protocol; resolution is deliberately not done here

  // CDATA is character data: what is inside it is literal text and must not be parsed as markup, or
  // `<![CDATA[<b>raw</b>]]>` loses its tags and stops being the thing CDATA exists to carry. Each
  // section hides behind a sentinel that no rule below can touch (private-use code points cannot
  // occur in a feed by accident) and is put back at the very end. An unclosed section - `]]>` is
  // missing - keeps everything to the end of the input, the same principle as a removed element with
  // no closing tag. Both rules were pinned after the Python implementation's differential run found
  // them diverging from this file, which was re-parsing the body.
  const cdata = [];
  src = src.replace(/<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g, (_m, inner) => {
    cdata.push(inner);
    return `\uE000${cdata.length - 1}\uE001`;
  });
  src = src.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  src = src.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Elements removed with their content. A missing closing tag means "to the end of the input".
  for (const tag of REMOVED_ELEMENTS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi');
    src = src.replace(re, '');
  }

  let text = '';
  let title = '';
  let titleSeen = false;
  let inTitle = false;
  const links = [];
  let pending = null; // the <a> currently open
  let images = 0;

  const pushText = (chunk) => {
    // While a <title> is open its text belongs to the title and to nothing else: not to the body, and
    // not to an anchor that happens to contain it. An earlier version routed decoded entities to the
    // body unconditionally, so "A &amp; B" produced a title with a missing "&" and a stray "&" in the
    // text - a bug three of the four implementations shared, because they had all read this file.
    if (inTitle) {
      title += chunk;
      return;
    }
    text += chunk;
    if (pending) pending.text += chunk;
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '<' && /[A-Za-z/!]/.test(src[i + 1] ?? '')) {
      // Scan the tag, honouring quoted attribute values (a '>' inside them does not end the tag).
      let j = i + 1;
      let quote = null;
      while (j < src.length) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '>') {
          break;
        }
        j++;
      }
      const raw = src.slice(i + 1, j); // without the angle brackets
      const terminated = j < src.length; // a '>' was found
      i = terminated ? j + 1 : j;
      // An incomplete tag at the end of the input is dropped **including its name characters**, the
      // way a browser's eof-in-tag handling drops it - so it contributes no newline, no link and no
      // image either. This file used to apply the newline rule to a name it had managed to parse
      // (extract("<p") gave "\n"), which contradicted the rule; the Python implementation, running a
      // differential against this file, is what made the contradiction visible.
      if (!terminated) continue;
      const closing = raw.startsWith('/');
      const nameMatch = /^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(raw);
      const name = (nameMatch?.[1] ?? '').toLowerCase();
      if (name === 'title') {
        if (!closing && !titleSeen) {
          inTitle = true;
          titleSeen = true;
        } else if (closing && inTitle) {
          inTitle = false;
        }
        continue;
      }
      if (name === 'img' && !closing) images++;
      if (name === 'a') {
        if (!closing) {
          // HTML does not allow nested anchors: a browser closes the open one and starts the new one.
          // An earlier version of this contract said "ignore the inner anchor", which lost the inner
          // href without saying so; the Go implementation flagged it and the contract was corrected.
          if (pending) {
            links.push(pending);
            pending = null;
          }
          const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
          const href = hrefMatch ? (hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '') : '';
          pending = { href, absolute: SCHEME_RE.test(href), text: '' };
        } else if (pending) {
          links.push(pending);
          pending = null;
        }
        continue;
      }
      if (NEWLINE_TAGS.has(name)) pushText('\n');
      continue;
    }
    if (ch === '&') {
      const decoded = decodeEntity(src, i);
      if (decoded) {
        pushText(decoded[0]);
        i = decoded[1];
        continue;
      }
    }
    if (inTitle) title += ch;
    else pushText(ch);
    i++;
  }

  // An anchor still open at the end of the input is reported with the text it collected (the
  // contract says so; dropping it silently lost a link on every truncated document).
  if (pending) links.push(pending);

  // Put the CDATA bodies back, now that no rule can mistake them for markup.
  const restore = (s) => s.replace(/\uE000(\d+)\uE001/g, (_m, idx) => cdata[Number(idx)] ?? '');
  return {
    title: restore(title),
    text: restore(text),
    links: links.map((l) => ({ href: l.href, absolute: l.absolute, text: restore(l.text) })),
    images,
  };
}

// -- text.fingerprint -----------------------------------------------

const CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x3040, 0x30ff],
  [0xac00, 0xd7af],
];
const PUNCT_ONLY = new Set("!?,.;:'\"()[]{}<>-_/\\|*+=~`@#$%^&");
const PUNCT_EDGE_RE = /^[!?,.;:'"()[\]{}<>\-_/\\|*+=~`@#$%^&]+/;
const PUNCT_TRAIL_RE = /[!?,.;:'"()[\]{}<>\-_/\\|*+=~`@#$%^&]+$/;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = 0xffffffffffffffffn;

const isCjk = (cp) => CJK_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** Emitted tokens for one space-free token, per the contract's run/bigram rule. */
function tokenizeToken(token) {
  // Leading and trailing ASCII punctuation is trimmed first: "hello," and "hello" have to produce
  // the same tokens, otherwise every title that ends in a full stop is its own duplicate as far as
  // the fingerprint is concerned.
  const trimmed = token.replace(PUNCT_EDGE_RE, '').replace(PUNCT_TRAIL_RE, '');
  if (!trimmed) return [];
  const out = [];
  const cps = [...trimmed];
  if (!cps.length) return out;
  if (cps.every((c) => PUNCT_ONLY.has(c))) return out;
  let run = [];
  let runIsCjk = null;
  const flush = () => {
    if (!run.length) return;
    if (runIsCjk) {
      if (run.length === 1) out.push(run[0]);
      else for (let k = 0; k + 1 < run.length; k++) out.push(run[k] + run[k + 1]);
    } else {
      out.push(run.join(''));
    }
    run = [];
  };
  for (const c of cps) {
    const cjk = isCjk(c.codePointAt(0));
    if (runIsCjk === null || cjk === runIsCjk) {
      run.push(c);
      runIsCjk = cjk;
    } else {
      flush();
      run.push(c);
      runIsCjk = cjk;
    }
  }
  flush();
  return out;
}

function tokensOf(text) {
  const out = [];
  for (const piece of String(text).split(' ')) {
    if (!piece) continue;
    out.push(...tokenizeToken(piece));
  }
  return out;
}

// Exported because the search capability is specified to tokenize exactly the way the fingerprint
// capability does: two tokenizers would be two dialects, and the corpus would spend its time
// reporting the difference instead of the bugs.
export { tokensOf };

function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(str, 'utf8')) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

function shinglesOf(tokens) {
  if (!tokens.length) return [];
  if (tokens.length < 3) return [tokens.join(' ')];
  const out = [];
  for (let i = 0; i + 3 <= tokens.length; i++) out.push(tokens.slice(i, i + 3).join(' '));
  return out;
}

export function fingerprint(text) {
  const tokens = tokensOf(text);
  const shingles = shinglesOf(tokens);
  const counters = new Array(64).fill(0);
  for (const s of shingles) {
    const h = fnv1a64(s);
    for (let bit = 0; bit < 64; bit++) {
      counters[bit] += ((h >> BigInt(bit)) & 1n) === 1n ? 1 : -1;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) if (counters[bit] > 0) hash |= 1n << BigInt(bit);
  return { simhash: hash.toString(16).padStart(16, '0'), tokens: tokens.length, shingles: shingles.length };
}

// -- the protocol ---------------------------------------------------

export const CAPABILITIES = {
  'text.normalize': (input) => {
    if (typeof input?.text !== 'string') throw Object.assign(new Error('input.text must be a string'), { code: 'bad-input' });
    return { text: normalize(input.text) };
  },
  'text.extract': (input) => {
    if (typeof input?.html !== 'string') throw Object.assign(new Error('input.html must be a string'), { code: 'bad-input' });
    return extract(input.html, input.baseUrl ?? null);
  },
  'text.fingerprint': (input) => {
    if (typeof input?.text !== 'string') throw Object.assign(new Error('input.text must be a string'), { code: 'bad-input' });
    return fingerprint(input.text);
  },
};

export const DESCRIPTOR = {
  // Field order follows the contract's example. A descriptor can never be byte-identical across
  // implementations (language, impl and runtime differ by definition), so the harness does not diff
  // it - but "we agree except where we cannot" is a poor excuse for not matching the document.
  protocol: 1,
  language: 'javascript',
  impl: 'reference',
  runtime: process.version,
  deterministic: true,
};

/** The descriptor a worker answers `describe` with, in the contract's field order. */
export const describeWith = (capability) => ({
  protocol: DESCRIPTOR.protocol,
  capability,
  language: DESCRIPTOR.language,
  impl: DESCRIPTOR.impl,
  runtime: DESCRIPTOR.runtime,
  deterministic: DESCRIPTOR.deterministic,
});

// -- self-check -----------------------------------------------------

const SELFCHECK = [
  ['normalize folds full-width, spaces and case', () => normalize('ＡＢＣ　１２３') === 'abc 123'],
  ['normalize folds accents', () => normalize('Café') === 'cafe'],
  ['normalize folds non-decomposable letters', () => normalize('Łódź') === 'lodz'],
  ['normalize keeps CJK untouched', () => normalize('已经开播了') === '已经开播了'],
  ['normalize is idempotent', () => normalize(normalize('  É  ')) === normalize('  É  ')],
  ['normalize deletes zero-width and trims', () => normalize('a\u200bb ') === 'ab'],
  ['normalize maps dashes and ellipsis', () => normalize('a—b…') === 'a-b...'],
  ['extract drops script and style', () => extract('<p>x</p><script>var a=1</script>').text === '\nx\n'],
  ['extract decodes entities with and without a semicolon', () => extract('a &amp b &amp; c').text === 'a & b & c'],
  ['extract reads a href verbatim and marks absoluteness', () => {
    const r = extract('<a href="/x">L</a> <a href="https://e.com">M</a>');
    return r.links.length === 2 && r.links[0].href === '/x' && r.links[0].absolute === false && r.links[1].absolute === true;
  }],
  ['extract counts images and keeps the title out of the text', () => {
    const r = extract('<title>T</title><p>body</p><img src=a>');
    return r.title === 'T' && r.images === 1 && !r.text.includes('T');
  }],
  ['extract tolerates an unclosed tag', () => extract('<p>a<b>b').text === '\nab'],
  ['extract keeps a > inside a quoted attribute', () => extract('<a href="x>y">z</a>').links[0].href === 'x>y'],
  ['normalize deletes combining marks', () => normalize('e\u0301') === 'e'],
  ['normalize leaves Cyrillic and Arabic alone', () => normalize('Привет Мир مرحبا') === 'Привет Мир مرحبا'],
  ['fingerprint counts tokens and shingles', () => {
    const r = fingerprint('openai gpt 已经 已经');
    return r.tokens === 4 && r.shingles === 2;
  }],
  ['fingerprint of one token equals its own hash', () => {
    const r = fingerprint('x');
    return r.tokens === 1 && r.shingles === 1 && r.simhash === fnv1a64('x').toString(16).padStart(16, '0');
  }],
  ['fingerprint ignores punctuation-only tokens', () => fingerprint('-- !!').tokens === 0],
  ['fingerprint of empty text is the empty hex', () => {
    const r = fingerprint('');
    return r.tokens === 0 && r.shingles === 0 && r.simhash === '0000000000000000';
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
    process.stderr.write(`usage: vmltext.js --capability <${Object.keys(CAPABILITIES).join('|')}> [--selfcheck]\n`);
    process.exit(2);
  }

  // No banner: the contract's first protocol rule is that stdout carries protocol lines and nothing
  // else. This file had one, and it cost an afternoon of chasing a "missing answer" that was really
  // an extra line - the host counts lines by id, so an unsolicited id looks like a lost case.
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
      } catch (e) {
        process.stdout.write(JSON.stringify({ id: null, ok: false, error: { code: 'bad-input', message: 'request is not JSON' } }) + '\n');
        continue;
      }
      if (req.op === 'shutdown') {
        // The bare envelope, as the contract's response block says. Two implementations had copied an
        // earlier draft of this file that added an output payload; nothing diffs a shutdown line, so
        // the disagreement survived four implementations - which is why the contract now states it.
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
      try {
        const output = CAPABILITIES[capability](req.input ?? {});
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true, output }) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: e.code ?? 'internal', message: e.message } }) + '\n');
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

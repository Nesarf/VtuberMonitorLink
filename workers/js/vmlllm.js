// workers/js/vmlllm.js - the reference implementation of `llm.parse` (docs/WORKERS.md section 11).
//
// The believing half of the LLM glue, and nothing else. Asking a model - HTTP, retries, a key, a
// budget - is I/O and stays in the application, where the mock LLM and the mock vision server live.
// What is comparable across languages is what happens to the answer, and the answer is dirty by
// nature: fenced, wrapped in prose, with a trailing comma, with tags that are not in the vocabulary,
// with the same tag twice in two spellings, with a summary longer than the field can hold.
//
// Two rules here exist because a runtime's default would otherwise decide the contract: whitespace is
// ASCII-only (Java's trim strips code units below U+0021 and Python's strip strips U+00A0, so
// "whitespace" without a set is three different functions), and truncation counts code points (a
// UTF-16 code unit is not a character, and half an emoji is not text).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bad = (message) => Object.assign(new Error(message), { code: 'bad-input' });

/** Section 2's whitespace set: space, tab, LF, CR. Not U+00A0, not U+3000, not what trim() means. */
const ASCII_WS = ' \t\n\r';
const trimAscii = (s) => {
  let start = 0;
  let end = s.length;
  while (start < end && ASCII_WS.includes(s[start])) start++;
  while (end > start && ASCII_WS.includes(s[end - 1])) end--;
  return s.slice(start, end);
};

/** ASCII-only case folding: `I` is `i`, and no locale gets to disagree about it. */
const foldAscii = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** UTF-8 byte order, the order every ordering in this layer uses. */
const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** JSON text with no insignificant whitespace, for a `value` the contract has to name exactly. */
const jsonText = (value) => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jsonText).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).map((k) => JSON.stringify(k) + ':' + jsonText(value[k])).join(',') + '}';
  return JSON.stringify(value);
};

/** Is this line exactly three backticks? A trailing CR is a line ending, not content. */
const isFenceLine = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line) === '```';

/**
 * The first complete JSON object in `text`, with braces inside strings ignored. Returns null when
 * there is none: a model that answered prose with no object at all is a normal event, not an error.
 */
function firstObjectSlice(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The one repair the contract specifies: a comma followed by whitespace and a closing brace or bracket.
 * A comma inside a string is a character of that string, so string state is tracked here too - a
 * repair that corrupts data is worse than no repair.
 */
function dropTrailingCommas(slice) {
  let out = '';
  let inString = false;
  let escaped = false;
  let removed = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < slice.length && ASCII_WS.includes(slice[j])) j++;
      if (j < slice.length && (slice[j] === '}' || slice[j] === ']')) {
        removed++;
        continue; // the comma goes, the whitespace stays
      }
    }
    out += c;
  }
  return { text: out, removed };
}

/**
 * The whole capability. Pure: no clock, no randomness, no network, no floats.
 */
export function parseAnswer(input) {
  const raw = input?.raw;
  if (typeof raw !== 'string') throw bad('input.raw must be a string');

  const vocabularyInput = input?.vocabulary === undefined || input.vocabulary === null ? [] : input.vocabulary;
  if (!Array.isArray(vocabularyInput)) throw bad('input.vocabulary must be an array');
  for (const entry of vocabularyInput) if (typeof entry !== 'string') throw bad('every vocabulary entry must be a string');
  const vocabulary = vocabularyInput;

  const maxTags = input?.maxTags === undefined || input.maxTags === null ? 0 : input.maxTags;
  if (!Number.isInteger(maxTags) || maxTags < 0) throw bad('maxTags must be a non-negative integer');
  const maxSummaryChars = input?.maxSummaryChars === undefined || input.maxSummaryChars === null ? 0 : input.maxSummaryChars;
  if (!Number.isInteger(maxSummaryChars) || maxSummaryChars < 0) throw bad('maxSummaryChars must be a non-negative integer');

  // 1. the fence, and the payload inside whatever is left
  let repaired = false;
  let body = raw;
  const firstNonSpace = (() => {
    for (let i = 0; i < raw.length; i++) if (!ASCII_WS.includes(raw[i])) return i;
    return -1;
  })();
  if (firstNonSpace !== -1 && raw.startsWith('```', firstNonSpace)) {
    repaired = true;
    const nl = raw.indexOf('\n', firstNonSpace);
    if (nl === -1) {
      body = ''; // the fence is the whole answer: there is nothing inside it
    } else {
      body = raw.slice(nl + 1);
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (isFenceLine(lines[i])) {
          body = lines.slice(0, i).join('\n');
          break;
        }
      }
    }
  }

  const slice = firstObjectSlice(body);
  let payload = null;
  if (slice === null) {
    repaired = true; // nothing parseable at all: the same "it arrived wrong" signal
  } else {
    if (slice !== raw.trim()) repaired = true;
    const fixed = dropTrailingCommas(slice);
    if (fixed.removed > 0) repaired = true;
    try {
      const parsed = JSON.parse(fixed.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    } catch {
      payload = null;
    }
    if (payload === null) repaired = true;
  }

  // 4-7. the tags
  const dropped = [];
  const accepted = [];
  if (payload && Array.isArray(payload.tags)) {
    const index = new Map();
    for (const entry of vocabulary) {
      const key = foldAscii(entry);
      if (!index.has(key)) index.set(key, entry);
    }
    for (const element of payload.tags) {
      if (typeof element !== 'string') {
        dropped.push({ value: jsonText(element), reason: 'not-a-string' });
        continue;
      }
      const tag = trimAscii(element);
      if (tag === '') {
        dropped.push({ value: '', reason: 'empty' });
        continue;
      }
      const key = foldAscii(tag);
      if (!index.has(key)) {
        dropped.push({ value: tag, reason: 'not-in-vocabulary' });
        continue;
      }
      const canonical = index.get(key);
      if (accepted.includes(canonical)) {
        dropped.push({ value: canonical, reason: 'duplicate' });
        continue;
      }
      accepted.push(canonical);
    }
  }
  const tags = maxTags > 0 && accepted.length > maxTags ? accepted.slice(0, maxTags) : accepted;
  for (const extra of accepted.slice(tags.length)) dropped.push({ value: extra, reason: 'over-limit' });

  // 8. the summary, truncated by code points
  let summary = payload && typeof payload.summary === 'string' ? trimAscii(payload.summary) : '';
  let truncated = 0;
  if (maxSummaryChars > 0) {
    const points = [...summary];
    if (points.length > maxSummaryChars) {
      truncated = points.length - maxSummaryChars;
      summary = points.slice(0, maxSummaryChars).join('');
    }
  }

  // 10. a report that reads the same everywhere
  dropped.sort((a, b) => (a.value === b.value ? byUtf8(a.reason, b.reason) : byUtf8(a.value, b.value)));

  return {
    tags,
    summary,
    dropped,
    repaired,
    counts: { tags: tags.length, dropped: dropped.length, truncated },
  };
}

// ── the protocol, the same shape as the text, search and fetch workers ───────────────────────

export const CAPABILITIES = {
  'llm.parse': (input) => parseAnswer(input),
};

export const describeWith = (capability) => ({
  protocol: 1,
  capability,
  language: 'javascript',
  impl: 'reference-scan',
  runtime: process.version,
  deterministic: true,
});

const SELFCHECK = [
  ['a clean object needs no repair', () => {
    const r = parseAnswer({ raw: '{"tags": ["debut"], "summary": "ok"}', vocabulary: ['debut'] });
    return r.repaired === false && r.tags.join(',') === 'debut' && r.summary === 'ok';
  }],
  ['a fenced answer is found and reported as repaired', () => {
    const r = parseAnswer({ raw: 'Sure!\n```json\n{"tags": ["debut"], "summary": "ok"}\n```\n', vocabulary: ['debut'] });
    return r.repaired === true && r.tags.join(',') === 'debut' && r.summary === 'ok';
  }],
  ['a fence with CRLF endings closes at the right line', () => {
    const r = parseAnswer({ raw: '```json\r\n{"tags": ["debut"]}\r\n```\r\n', vocabulary: ['debut'] });
    return r.repaired === true && r.tags.join(',') === 'debut';
  }],
  ['braces inside a string do not end the payload', () => {
    const r = parseAnswer({ raw: 'prose {"summary": "a } b { c", "tags": ["debut"]} more prose', vocabulary: ['debut'] });
    return r.repaired === true && r.summary === 'a } b { c' && r.tags.join(',') === 'debut';
  }],
  ['an escaped quote inside a string does not end it', () => {
    const r = parseAnswer({ raw: '{"summary": "say \\"ok\\" now", "tags": []}' });
    return r.summary === 'say "ok" now';
  }],
  ['a trailing comma in an object and in an array is the one repair', () => {
    const r = parseAnswer({ raw: '{"tags": ["debut",], "summary": "ok",}', vocabulary: ['debut'] });
    return r.repaired === true && r.tags.join(',') === 'debut' && r.summary === 'ok';
  }],
  ['a comma inside a string is data, not a trailing comma', () => {
    const r = parseAnswer({ raw: '{"summary": "a,}", "tags": []}' });
    return r.repaired === false && r.summary === 'a,}';
  }],
  ['broken JSON yields nothing and says it was repaired', () => {
    const r = parseAnswer({ raw: '{"tags": ["debut"', vocabulary: ['debut'] });
    return r.repaired === true && r.tags.length === 0 && r.counts.tags === 0 && r.counts.dropped === 0;
  }],
  ['an answer with no object at all is not an error', () => {
    const r = parseAnswer({ raw: 'I am not sure what you want.' });
    return r.repaired === true && r.tags.length === 0 && r.summary === '' && r.dropped.length === 0;
  }],
  ['a tags field that is a string contributes nothing', () => {
    const r = parseAnswer({ raw: '{"tags": "debut, 3d"}', vocabulary: ['debut', '3d'] });
    return r.tags.length === 0 && r.dropped.length === 0;
  }],
  ['the vocabulary spelling wins over the model spelling', () => {
    const r = parseAnswer({ raw: '{"tags": ["DEBUT"]}', vocabulary: ['debut'] });
    return r.tags.join(',') === 'debut' && r.dropped.length === 0;
  }],
  ['a tag outside the vocabulary is dropped, not guessed', () => {
    const r = parseAnswer({ raw: '{"tags": ["singing"]}', vocabulary: ['debut'] });
    return r.tags.length === 0 && r.dropped[0].reason === 'not-in-vocabulary' && r.dropped[0].value === 'singing';
  }],
  ['the same tag twice in two spellings is a duplicate', () => {
    const r = parseAnswer({ raw: '{"tags": ["debut", "Debut", "DEBUT"]}', vocabulary: ['debut'] });
    return r.tags.join(',') === 'debut' && r.dropped.length === 2 && r.dropped.every((d) => d.reason === 'duplicate' && d.value === 'debut');
  }],
  ['maxTags keeps the first tags in the model order', () => {
    const r = parseAnswer({ raw: '{"tags": ["3d", "debut", "karaoke"]}', vocabulary: ['debut', '3d', 'karaoke'], maxTags: 2 });
    return r.tags.join(',') === '3d,debut' && r.dropped.length === 1 && r.dropped[0].reason === 'over-limit';
  }],
  ['an empty tag and a non-string are dropped with their own reasons', () => {
    const r = parseAnswer({ raw: '{"tags": ["  ", 7, ["x"], "debut"]}', vocabulary: ['debut'] });
    const reasons = r.dropped.map((d) => d.reason).sort().join(',');
    return r.tags.join(',') === 'debut' && reasons === 'empty,not-a-string,not-a-string' && r.dropped.every((d) => typeof d.value === 'string');
  }],
  ['a non-string element reports its JSON text, not its string value', () => {
    const r = parseAnswer({ raw: '{"tags": [{"a": 1}, true, 42]}' });
    const values = r.dropped.map((d) => d.value).sort().join('|');
    return values === '42|true|{"a":1}';
  }],
  ['the summary is truncated by code points, and the count is code points', () => {
    const r = parseAnswer({ raw: '{"summary": "\u{1F600}\u{1F600}ab"}', maxSummaryChars: 3 });
    return [...r.summary].length === 3 && r.summary === '\u{1F600}\u{1F600}a' && r.counts.truncated === 1;
  }],
  ['truncation never cuts an emoji in half', () => {
    const r = parseAnswer({ raw: '{"summary": "ab\u{1F600}"}', maxSummaryChars: 2 });
    return r.summary === 'ab' && !/[\uD800-\uDFFF]/.test(r.summary) && r.counts.truncated === 1;
  }],
  ['whitespace around a tag is ASCII whitespace, and U+00A0 is not whitespace', () => {
    const r = parseAnswer({ raw: '{"tags": ["\\tdebut\\n", "\\u00a0debut"]}', vocabulary: ['debut'] });
    return r.tags.join(',') === 'debut' && r.dropped.length === 1 && r.dropped[0].reason === 'not-in-vocabulary';
  }],
  ['the dropped report is sorted by value then reason', () => {
    const r = parseAnswer({ raw: '{"tags": ["zeta", "alpha", "Alpha"]}', vocabulary: ['alpha'] });
    return r.dropped.map((d) => d.value + ':' + d.reason).join('|') === 'alpha:duplicate|zeta:not-in-vocabulary';
  }],
  ['counts are integers', () => {
    const r = parseAnswer({ raw: '{"tags": ["debut"], "summary": "ok"}', vocabulary: ['debut'] });
    return Object.values(r.counts).every((n) => Number.isInteger(n));
  }],
  ['a raw that is not a string is bad input', () => {
    try {
      parseAnswer({ raw: 5 });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['a negative maxTags is bad input', () => {
    try {
      parseAnswer({ raw: '{}', maxTags: -1 });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['a vocabulary entry that is not a string is bad input', () => {
    try {
      parseAnswer({ raw: '{}', vocabulary: ['ok', 5] });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
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
    process.stderr.write('usage: vmlllm.js --capability llm.parse | --selfcheck\n');
    process.exit(2);
  }
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
      } catch {
        process.stdout.write(JSON.stringify({ id: null, ok: false, error: { code: 'bad-input', message: 'request is not JSON' } }) + '\n');
        continue;
      }
      if (req.op === 'shutdown') {
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
      if (req.capability && req.capability !== capability) {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: 'unsupported', message: `this worker implements ${capability}` } }) + '\n');
        continue;
      }
      try {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true, output: CAPABILITIES[capability](req.input ?? {}) }) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: e.code ?? 'internal', message: e.message } }) + '\n');
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
void HERE;

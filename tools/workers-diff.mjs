// tools/workers-diff.mjs - differential verification over inputs the corpus does not contain.
//
// The conformance runner (tools/workers.mjs) answers "do the implementations agree on the cases a human
// thought of?". This answers the next question: "and on the inputs nobody wrote down?" The corpus is a
// floor, not a ceiling - two of the four bugs the reference implementation had were found by an
// implementation disagreeing with it on an input the corpus did not contain - so the same machinery is
// pointed at generated input here.
//
// Everything is seeded: a divergence is reproducible from the seed and the case index printed with it,
// which is the difference between "one language is wrong somewhere" and a bug report. Inputs that
// diverge are printed as corpus case entries, ready to paste and review - promoting one is a decision,
// so this tool never writes to workers/spec/ itself.
//
// Every case is also asked twice, the second time in the opposite order. Every capability in this layer
// is specified to be deterministic, so the repeat is a check in its own right: it catches a hash-map
// order leaking into an answer, a random seed a runtime picked for itself, and state kept between
// requests - and it is the only check here that means anything for a capability with one implementation.
//
// Only the published registry is fuzzed by default. A worker under active development lives in the
// machine-local overlay and would report its own half-finished state as a divergence of the layer.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const SEED = Number(value('--seed', 1));
const COUNT = Number(value('--n', 200));
const ONLY = value('--cap', null);
const WITH_LOCAL = flag('--with-local');
const VERBOSE = flag('--verbose');

// ── input generation ────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG, so a found divergence is reproducible from `--seed`. */
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Characters that each language gets wrong in its own way: case pairs outside ASCII, compatibility
// forms the normalizer has to fold, marks that must not be dropped, and scripts whose case mapping is
// not the obvious one-to-one the Latin alphabet suggests.
const INTERESTING = [
  '\u0301', '\u0327', '\u0345', '\u00DF', '\u1E9E', '\u0130', '\u0131', '\u017F', '\u01C4', '\u01C6',
  '\u03A3', '\u03C2', '\u03C3', '\u0410', '\u0430', '\u0587', '\u0F77', '\u13A0', '\uAB70',
  '\u2126', '\u212A', '\u00BD', '\uFB01', '\uFB02', '\uFF21', '\uFF41', '\uFF9E', '\u3000', '\u200B',
  '\u00A0', '\u2028', '\u2029', '\uFEFF', '\uFFFD', '\u1D400', '\u10400', '\u10428', '\u{1F600}',
  '\u5DF2', '\u7ECF', '\u5F00', '\u64AD', '\u4E86', '\u3042', '\u30A2', '\uAC00',
];
const WORDS = ['alpha', 'beta', 'openai', 'gpt', 'news', 'x', 'Nijisanji', '3D', 'debut', 'stream'];
const PUNCT = [' ', '  ', '\t', '\n', '.', ',', '!', '?', '"', "'", '(', ')', '[', ']', '-', '_', '/', '\\', '*', '#', '@', '&', '<', '>', '|', '~', '\u2014', '\u3001', '\u3002'];
const ENTITIES = ['&amp;', '&amp', '&AMP;', '&#65;', '&#x41;', '&#X41', '&lt;', '&gt;', '&quot;', '&nbsp;', '&notreal;', '&', '&#;', '&#x;', '&#xZZ;', '&#999999999;'];
const FRAGMENTS = [
  '<p>', '</p>', '<div class="x">', '</div>', '<br>', '<br/>', '<hr />',
  '<a href="http://ex.example/a">', "</a>", "<a href='b?x=1&y=2'>", '<A HREF="C">', '</A>',
  '<a href="outer">', '<img src="i.png" alt="t">', '<img src=i.png>',
  '<script>if (a < b) { x = "</p>"; }</script>', '<script src="a>b">', '</script>',
  '<style>a{color:red}</style>', '<!-- comment -->', '<!-- <p>hidden</p> -->',
  '<![CDATA[<b>raw</b>]]>', '<!DOCTYPE html>', '<title>T</title>', '<h1>', '</h1>', '<span>', '</span>',
  '<', '>', '<<', '<>', '</>', '<p', '<p ', '<p t', '<p title="unclosed', '</p',
  '<p title="a>b">', '<a href="x">', '</a >', '< p>', '<p/>', '<p >',
  'text', 'word word', '\u5DF2\u7ECF\u5F00\u64AD\u4E86', 'line\nbreak', '&nbsp;', '\u{1F600}',
];

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

function randomString(rnd, { maxLen = 24, punctuation = 0.35, interesting = 0.3 } = {}) {
  let out = '';
  const n = 1 + Math.floor(rnd() * maxLen);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < interesting) out += pick(rnd, INTERESTING);
    else if (r < interesting + punctuation) out += pick(rnd, PUNCT);
    else if (r < interesting + punctuation + 0.12) out += pick(rnd, ENTITIES);
    else out += pick(rnd, WORDS);
  }
  return out;
}

function randomHtml(rnd) {
  const n = 1 + Math.floor(rnd() * 10);
  let out = '';
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.72) out += pick(rnd, FRAGMENTS);
    else if (r < 0.86) out += randomString(rnd, { maxLen: 8, punctuation: 0.2, interesting: 0.2 });
    else out += pick(rnd, ENTITIES);
  }
  return out;
}

const EGRESS_NAMES = ['direct', 'proxy', 'tor', 'zebra', '\u00E9clair', 'a10', 'a9'];

/** A vocabulary with the traps in it: a tag that needs trimming, one that must not match, one astral. */
const LLM_VOCABULARY = ['debut', '3d', 'karaoke', 'idol', 'singing'];

function randomLlmInput(rnd) {
  const tags = [];
  const count = Math.floor(rnd() * 5);
  for (let i = 0; i < count; i++) {
    const r = rnd();
    if (r < 0.14) tags.push(pick(rnd, LLM_VOCABULARY).toUpperCase());
    else if (r < 0.28) tags.push('\t' + pick(rnd, LLM_VOCABULARY) + '\n');
    else if (r < 0.38) tags.push('\u00A0' + pick(rnd, LLM_VOCABULARY));
    else if (r < 0.46) tags.push(pick(rnd, ['unknown', 'sing', '\u{1F600}', '\u00E9']));
    else if (r < 0.54) tags.push(Math.floor(rnd() * 10));
    else if (r < 0.58) tags.push(null);
    else tags.push(pick(rnd, LLM_VOCABULARY));
  }
  const payload = { tags };
  if (rnd() < 0.8) payload.summary = randomString(rnd, { maxLen: 10, punctuation: 0.15, interesting: 0.3 });
  let text = JSON.stringify(payload);
  const shape = rnd();
  if (shape < 0.18) text = text.replace(/]$/, ',]').replace(/}$/, ',}'); // the one repair the contract allows
  else if (shape < 0.34) text = '```json\n' + text + '\n```\n';
  else if (shape < 0.44) text = '```\r\n' + text + '\r\n```\r\n';
  else if (shape < 0.56) text = 'Sure! ' + text + ' Let me know if you need more.';
  else if (shape < 0.64) text = text.slice(0, -1); // broken: no partial recovery allowed
  else if (shape < 0.7) text = 'I am not sure what you want.';
  const input = { raw: text, vocabulary: LLM_VOCABULARY };
  if (rnd() < 0.5) input.maxTags = Math.floor(rnd() * 4);
  if (rnd() < 0.6) input.maxSummaryChars = Math.floor(rnd() * 12);
  return input;
}

function randomFetchInput(rnd) {
  const names = EGRESS_NAMES.filter(() => rnd() < 0.7);
  if (!names.length) names.push('direct');
  const egress = {};
  for (const name of names) {
    const config = {};
    if (rnd() < 0.75) config.maxConcurrent = 1 + Math.floor(rnd() * 4);
    egress[name] = config;
  }
  const count = Math.floor(rnd() * 7);
  const sources = [];
  for (let i = 0; i < count; i++) {
    const source = { id: 's' + i };
    const r = rnd();
    if (r < 0.1) source.egress = pick(rnd, ['ghost', 'nowhere', '', 'DIRECT']);
    else source.egress = pick(rnd, names);
    if (rnd() < 0.25) source.due = rnd() < 0.6;
    if (rnd() < 0.7) {
      const t = rnd();
      source.lastRunAt = t < 0.15 ? null : t < 0.3 ? 0 : Math.floor(rnd() * 2000000) - 1000;
    }
    if (rnd() < 0.6) source.minIntervalMs = pick(rnd, [0, 1, 1000, 600000, 1000000]);
    sources.push(source);
  }
  const input = { now: Math.floor(rnd() * 2000000), sources, egress };
  if (rnd() < 0.5) {
    const budget = {};
    if (rnd() < 0.7) budget.maxRequests = Math.floor(rnd() * 5);
    if (rnd() < 0.5) {
      const per = {};
      for (const name of names) if (rnd() < 0.5) per[name] = Math.floor(rnd() * 3);
      budget.maxPerEgress = per;
    }
    input.budget = budget;
  }
  return input;
}

function randomSearchInput(rnd) {
  const docs = [];
  const n = Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    const doc = { id: 'd' + i, title: randomString(rnd, { maxLen: 6, punctuation: 0.2, interesting: 0.25 }) };
    doc.text = randomString(rnd, { maxLen: 8, punctuation: 0.2, interesting: 0.25 });
    const tags = [];
    for (let k = 0; k < Math.floor(rnd() * 3); k++) tags.push(pick(rnd, WORDS.concat(['\u5DF2\u7ECF', 'debut'])));
    doc.tags = tags;
    doc.ts = rnd() < 0.2 ? null : Math.floor(rnd() * 2000000) - 1000;
    docs.push(doc);
  }
  const query = {};
  if (rnd() < 0.7) query.terms = [pick(rnd, ['openai', 'alpha', 'gpt', 'debut', '\u5DF2\u7ECF', 'alpha beta', 'OPENAI'])];
  if (rnd() < 0.3) query.match = rnd() < 0.5 ? 'any' : 'all';
  if (rnd() < 0.2) query.tags = [pick(rnd, WORDS)];
  if (rnd() < 0.3) query.from = Math.floor(rnd() * 1000000);
  if (rnd() < 0.2) query.to = Math.floor(rnd() * 2000000);
  const input = { docs, query };
  if (rnd() < 0.5) input.limit = Math.floor(rnd() * 4);
  return input;
}

const GENERATORS = {
  'text.normalize': (rnd) => ({ text: randomString(rnd, { maxLen: 30 }) }),
  'text.extract': (rnd) => ({ html: randomHtml(rnd), baseUrl: rnd() < 0.5 ? 'https://ex.example/base/' : null }),
  'text.fingerprint': (rnd) => ({ text: randomString(rnd, { maxLen: 40 }) }),
  'search.query': randomSearchInput,
  'fetch.plan': randomFetchInput,
  'llm.parse': randomLlmInput,
};

// ── worker plumbing (deliberately self-contained: this tool owns its own protocol talk) ──────

function resolveLaunch(worker) {
  const launch = worker.launch;
  const platform = process.platform;
  const candidates = Array.isArray(launch) && Array.isArray(launch[0]) ? launch : [launch];
  for (const candidate of candidates) {
    const argv0 = Array.isArray(candidate) ? candidate : candidate[platform] ?? candidate.default;
    if (argv0) return argv0;
  }
  return null;
}

function runWorker(worker, capability, cases) {
  return new Promise((resolve) => {
    const launch = resolveLaunch(worker);
    const child = spawn(launch[0], [...launch.slice(1), '--capability', capability], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const answers = new Map();
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ answers, stderr: stderr.trim(), descriptor });
    };
    let descriptor = null;
    const timer = setTimeout(finish, 180000);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.worker) { descriptor = msg.worker; continue; }
        if (msg.id !== undefined && msg.id !== null) answers.set(String(msg.id), msg);
      }
      if (answers.size >= cases.length * 2 && descriptor) finish();
    });
    child.on('close', finish);
    child.stdin.write(JSON.stringify({ id: 'describe', op: 'describe' }) + '\n');
    for (let i = 0; i < cases.length; i++) {
      child.stdin.write(JSON.stringify({ id: 'c' + i, op: 'invoke', capability, input: cases[i] }) + '\n');
    }
    // And the same cases again, in the opposite order. Every capability in this layer is specified to be
    // deterministic, so asking twice is a check in its own right: it catches a hash-map order that leaks
    // into an answer, a random seed a runtime decided for itself, and any state a worker keeps between
    // requests. It is also the only check that means anything for a capability with one implementation.
    for (let i = cases.length - 1; i >= 0; i--) {
      child.stdin.write(JSON.stringify({ id: 'r' + i, op: 'invoke', capability, input: cases[i] }) + '\n');
    }
  });
}

const canon = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
const answerKey = (msg) => (msg?.ok === false ? canon({ __error: msg.error?.code ?? 'internal' }) : canon(msg?.output));
const shape = (v) => {
  if (Array.isArray(v)) return '[' + (v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]) ? Object.keys(v[0]).join(',') : '') + ']';
  if (v && typeof v === 'object') return Object.keys(v).join(',');
  return typeof v;
};

// ── main ────────────────────────────────────────────────────────────────────────────────────

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'workers', 'registry.json'), 'utf8')).workers;
const overlayPath = path.join(ROOT, 'workers', 'registry.local.json');
let workers = registry;
if (WITH_LOCAL && fs.existsSync(overlayPath)) {
  const byId = new Map(workers.map((w) => [w.id, { ...w }]));
  for (const w of JSON.parse(fs.readFileSync(overlayPath, 'utf8')).workers ?? []) {
    byId.set(w.id, byId.has(w.id) ? { ...byId.get(w.id), ...w } : w);
  }
  workers = [...byId.values()];
  console.log('  overlay    : workers/registry.local.json included (--with-local)');
} else {
  console.log('  overlay    : ignored: the published registry is what is fuzzed');
}

const capabilities = Object.keys(GENERATORS).filter((c) => !ONLY || c === ONLY);
console.log(`  seed       : ${SEED}`);
console.log(`  cases      : ${COUNT} per capability`);
console.log(`  workers    : ${workers.map((w) => w.id).join(', ')}`);

let divergences = 0;
for (const capability of capabilities) {
  const rnd = mulberry32(SEED);
  const cases = [];
  for (let i = 0; i < COUNT; i++) cases.push(GENERATORS[capability](rnd));

  const active = workers.filter((w) => w.capabilities.includes(capability));
  const answers = new Map();
  const skipped = [];
  for (const worker of active) {
    const launch = resolveLaunch(worker);
    const r = await runWorker(worker, capability, cases);
    answers.set(worker.id, r.answers);
    const answered = [...r.answers.keys()].filter((k) => k.startsWith('c')).length;
    if (answered === 0) {
      skipped.push(`${worker.id} (${r.stderr.split('\n').slice(-1)[0]?.slice(0, 100) || 'said nothing'})`);
      answers.delete(worker.id);
    } else if (VERBOSE) {
      console.log(`  ${worker.id}: ${answered}/${cases.length} answered, implementation ${r.descriptor?.impl ?? '?'}`);
    }
    void launch;
  }

  console.log(`\n== ${capability}  (${COUNT} generated cases x ${answers.size} implementation(s): ${[...answers.keys()].join(', ')})`);
  if (skipped.length) console.log(`   skipped    : ${skipped.join(', ')}`);
  const canDiff = answers.size >= 2;
  if (!canDiff) {
    console.log('   [note] one implementation answered: there is no cross-implementation diff to make, and the');
    console.log('          repeat check below still runs, because determinism is a property of one implementation.');
  }

  let agree = 0;
  let stablePairs = 0;
  const unstable = [];
  for (let i = 0; i < cases.length; i++) {
    const id = 'c' + i;
    const byKey = new Map();
    const byShape = new Map();
    for (const [workerId, map] of answers) {
      const msg = map.get(id);
      const repeated = map.get('r' + i);
      if (msg && repeated) {
        const first = answerKey(msg);
        const second = answerKey(repeated);
        if (first !== second) unstable.push(`${workerId} case ${i}: ${first.slice(0, 120)} != ${second.slice(0, 120)}`);
        else stablePairs++;
      }
      if (!msg) { byKey.set('MISSING:' + workerId, [workerId]); continue; }
      const key = answerKey(msg);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(workerId);
      if (msg.ok !== false) {
        const s = shape(msg.output);
        if (!byShape.has(s)) byShape.set(s, []);
        byShape.get(s).push(workerId);
      }
    }
    if (byKey.size === 1 && ![...byKey.keys()][0].startsWith('MISSING')) {
      agree++;
      if (byShape.size > 1) {
        divergences++;
        console.log(`   SHAPE      : case ${i} (seed ${SEED}): field order or array shape differs`);
        for (const [s, who] of byShape) console.log(`       ${who.join(', ').padEnd(28)} ${s}`);
        console.log(`       input: ${JSON.stringify(cases[i]).slice(0, 400)}`);
      }
      continue;
    }
    if (!canDiff) continue; // with one implementation there is no disagreement to report
    divergences++;
    console.log(`   DIVERGES   : case ${i} (seed ${SEED})`);
    for (const [key, who] of byKey) console.log(`       ${who.join(', ').padEnd(28)} ${key.slice(0, 220)}`);
    const entry = { id: `fuzz-${SEED}-${i}`, note: `found by tools/workers-diff.mjs --seed ${SEED} --n ${COUNT}`, input: cases[i] };
    console.log(`       promote as: ${JSON.stringify(entry).slice(0, 900)}`);
  }
  console.log(`   agreement  : ${canDiff ? `${agree}/${cases.length} generated cases unanimous across ${answers.size} implementations` : 'not applicable: one implementation answered'}`);
  if (unstable.length) {
    divergences += unstable.length;
    console.log(`   UNSTABLE   : ${unstable.length} answer(s) changed when the same case was asked again in a different order`);
    for (const line of unstable.slice(0, 5)) console.log(`       ${line}`);
  } else {
    console.log(`   stability  : ${stablePairs} repeat answer(s) identical when asked again in the opposite order`);
  }
}

console.log(`\n${divergences === 0 ? 'no divergence found' : divergences + ' divergence(s) found'} over ${COUNT} generated case(s) per capability, seed ${SEED}`);
process.exit(divergences === 0 ? 0 : 1);

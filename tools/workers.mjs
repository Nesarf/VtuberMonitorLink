// workers.mjs - the conformance runner for the multilingual worker layer (docs/WORKERS.md section 5).
//
// What it does, and why it is the point of the whole layer:
//
//   * runs one corpus through EVERY implementation of a capability - the JavaScript reference plus
//     every registered worker whose artifact exists;
//   * the verdict is the **cross-implementation diff**, not "does it match the reference". When the
//     implementations disagree, the tool names them and shows their answers instead of quietly
//     declaring one of them right. A worker that agrees with the reference while three others agree
//     on something else is a finding;
//   * a case where every implementation agrees but the reviewed snapshot says otherwise also fails:
//     that is how the contract itself gets corrected, deliberately.
//
// A missing artifact is reported as [skip] - never as a pass, and never as a failure.
//
// Usage:
//   npm run workers                     build what is missing, run everything, diff
//   npm run workers -- --list           show what is registered and what is built
//   npm run workers -- --cap text.normalize --only go-text
//   npm run workers -- --update         rewrite the reviewed snapshot from the reference
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'workers', 'spec');
const CASES_DIR = path.join(SPEC, 'cases');
const EXPECTED_DIR = path.join(SPEC, 'expected');
const REGISTRY = path.join(ROOT, 'workers', 'registry.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

/** Field order the contract specifies; a worker that leaks an unordered map fails this check. */
const FIELD_ORDER = {
  'text.normalize': ['text'],
  'text.extract': ['title', 'text', 'links', 'images'],
  'text.fingerprint': ['simhash', 'tokens', 'shingles'],
  'search.query': ['hits', 'total', 'facets', 'excludedByTime'],
  'fetch.plan': ['batches', 'deferred', 'skipped', 'counts'],
  'llm.parse': ['tags', 'summary', 'dropped', 'repaired', 'counts'],
};
const NESTED_ORDER = {
  links: ['href', 'absolute', 'text'],
  hits: ['id', 'score'],
  batches: ['egress', 'sources'],
  deferred: ['id', 'reason'],
  skipped: ['id', 'reason'],
  dropped: ['value', 'reason'],
};
/** Facet objects are specified to be emitted with their keys sorted by UTF-8 bytes. */
const SORTED_KEY_OBJECTS = ['facets.tags', 'facets.months'];

/** An error is a legitimate answer, and only its `code` is comparable: the message is the language's. */
const errorCanon = (error) => canon({ __error: error?.code ?? 'internal' });

/** Semantic equality across languages: key order must not decide the diff, values must. */
function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function keyOrderIssues(capability, output) {
  const issues = [];
  const want = FIELD_ORDER[capability];
  const got = Object.keys(output);
  if (want && got.join(',') !== want.join(',')) issues.push(`field order ${got.join(',')} should be ${want.join(',')}`);
  for (const [field, order] of Object.entries(NESTED_ORDER)) {
    const arr = output[field];
    if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object' && arr[0] !== null) {
      const g = Object.keys(arr[0]);
      if (g.join(',') !== order.join(',')) issues.push(`${field}[].key order ${g.join(',')} should be ${order.join(',')}`);
    }
  }
  for (const path of SORTED_KEY_OBJECTS) {
    const [outer, inner] = path.split('.');
    const obj = output?.[outer]?.[inner];
    if (!obj || typeof obj !== 'object') continue;
    const keys = Object.keys(obj);
    const sorted = [...keys].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    if (keys.join('\u0000') !== sorted.join('\u0000')) issues.push(`${path} keys must be sorted by UTF-8 bytes (got ${keys.join(',')})`);
  }
  return issues;
}

const baseRegistry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).workers;

// Machine-local overlay. Tools that are installed only on some machines (an APL interpreter, a
// specific shell build, a JDK in a non-standard place) must not put their absolute paths into the
// published registry: the release checks reject machine-specific paths, and a registry that only
// works on one computer is not a registry. So `workers/registry.local.json` - gitignored - may add
// workers or override `launch`/`artifact`/`build` for a machine, and what it says wins here.
const OVERLAY = path.join(ROOT, 'workers', 'registry.local.json');
function applyOverlay(base) {
  // `--published-only` answers the question "what would a fresh clone see?": the machine-local workers
  // (an R or J interpreter, a particular shell build) are by definition not there, and a worker under
  // active development should not make the published set look broken.
  if (flag('--published-only')) {
    console.log('  overlay    : ignored (--published-only): this is the state of the published registry');
    return base;
  }
  if (!fs.existsSync(OVERLAY)) return base;
  let local;
  try {
    local = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
  } catch (e) {
    console.log(`  overlay    : workers/registry.local.json is not valid JSON (${e.message}); ignored`);
    return base;
  }
  const byId = new Map(base.map((w) => [w.id, { ...w }]));
  for (const w of local.workers ?? []) {
    const cur = byId.get(w.id);
    byId.set(w.id, cur ? { ...cur, ...w } : w);
  }
  console.log(`  overlay    : workers/registry.local.json (${(local.workers ?? []).length} machine-local entr${(local.workers ?? []).length === 1 ? 'y' : 'ies'})`);
  return [...byId.values()];
}
const registry = applyOverlay(baseRegistry);

const capabilities = fs
  .readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8')))
  .filter((c) => !value('--cap') || c.capability === value('--cap'));

/**
 * Resolve a worker's artifact and launch command for *this* platform.
 *
 * Both fields may be written in a platform-aware form, because the layer is meant to build and run on
 * Linux, macOS and Windows with the same registry: a compiled artifact is `vmltext.exe` on Windows
 * and `vmltext` elsewhere, and the interpreter is `python` on Windows but usually `python3` on Linux.
 *
 *   artifact: "workers/go/dist/vmltext.exe"
 *           | { "win32": "workers/go/dist/vmltext.exe", "default": "workers/go/dist/vmltext" }
 *   launch:   ["go", "x"]                       one command
 *           | [["python","x"],["python3","x"]]  candidates, first one that resolves wins
 */
function artifactFor(w) {
  const a = w.artifact;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') return a[process.platform] ?? a.default ?? null;
  return null;
}

function launchFor(w) {
  const l = w.launch;
  if (l && !Array.isArray(l) && typeof l === 'object') {
    // Platform-aware form: { "win32": [...], "default": [...] }
    const pick = l[process.platform] ?? l.default;
    return Array.isArray(pick) ? pick : null;
  }
  if (!Array.isArray(l) || !l.length) return null;
  if (Array.isArray(l[0])) {
    for (const candidate of l) {
      if (candidate.length && resolveCommand(candidate[0])) return candidate;
    }
    return l[0]; // none available: report the first so the skip message names something real
  }
  return l;
}

function workerAvailable(w) {
  const artifact = artifactFor(w);
  return artifact ? fs.existsSync(path.join(ROOT, artifact)) : false;
}

/**
 * Can this launcher actually start on this machine? A worker whose interpreter is not installed is a
 * [skip], not a failure: the layer is meant to run on machines that have different subsets of
 * Java, Go, R, J, an APL interpreter and three shells, and "the language is not installed here" must
 * never look like "the implementation is wrong".
 */
function resolveCommand(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) {
    return fs.existsSync(path.resolve(ROOT, cmd)) || fs.existsSync(cmd) ? cmd : null;
  }
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const buildFailures = [];

function tryBuild(w) {
  if (!w.build) return false;
  process.stdout.write(`   building ${w.id} (${w.build.join(' ')}) ... `);
  const res = spawnSync(w.build[0], w.build.slice(1), { cwd: ROOT, encoding: 'utf8' });
  const ok = res.status === 0 && workerAvailable(w);
  const tail = String(res.stdout ?? '').trim().split('\n').slice(-2).join(' | ');
  process.stdout.write((ok ? 'ok' : `FAILED (exit ${res.status})`) + (tail ? `  ${tail.slice(0, 120)}` : '') + '\n');
  if (!ok) {
    if (res.stderr) process.stdout.write('        ' + String(res.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 200) + '\n');
    // A build that was attempted and failed is a FAILURE, not a skip. The distinction matters: a
    // worker whose interpreter is simply not installed is "not applicable on this machine", but a
    // toolchain that is present and a build that breaks is exactly what this layer exists to catch.
    // Downgrading it to a skip made a macOS job report success while two of five implementations had
    // failed to compile - a green light for a real portability bug.
    buildFailures.push(w.id);
  }
  return ok;
}

/** Ask one worker for a descriptor and then for every case, over the real protocol. */
function runWorker(w, capability, cases) {
  return new Promise((resolve) => {
    const launch = launchFor(w);
    const child = spawn(launch[0], [...launch.slice(1), '--capability', capability], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = new Map();
    let descriptor = null;
    let stderr = '';
    let out = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.stdin.writable) child.stdin.write(JSON.stringify({ id: 'shutdown', op: 'shutdown' }) + '\n');
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
      resolve({ descriptor, answers, stderr: stderr.trim(), stderrTail: stderr.trim().split('\n').slice(-3).join(' | '), error: null });
    };
    const timer = setTimeout(() => {
      stderr += `\n(timeout after 30s: answered ${answers.size}/${cases.length})`;
      finish();
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (stderr += d));
    // A worker that exits before we finish talking to it turns the next write into EPIPE, and that
    // arrives as an *asynchronous* 'error' event on the stream, not as an exception at the write - so
    // an unhandled one takes the whole runner down instead of being reported as a worker problem.
    // Found by running this file under a second Node build (tools/borrow-node.mjs), which is exactly
    // what that check exists for.
    const ignorePipeNoise = () => {};
    child.stdin.on('error', ignorePipeNoise);
    child.stdout.on('error', ignorePipeNoise);
    child.stderr.on('error', ignorePipeNoise);
    child.on('error', (e) => {
      stderr += '\nspawn error: ' + e.message;
      finish();
    });
    child.on('exit', (code, signal) => {
      if (answers.size < cases.length) stderr += `\n(exited early: code ${code} signal ${signal})`;
      finish();
    });
    child.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          stderr += `\n(unparsable stdout line: ${line.slice(0, 80)})`;
          continue;
        }
        if (msg.id === 'describe') descriptor = msg;
        else if (msg.id !== null && msg.id !== undefined) answers.set(msg.id, msg);
      }
      if (answers.size >= cases.length) finish();
    });

    child.stdin.write(JSON.stringify({ id: 'describe', op: 'describe' }) + '\n');
    for (const c of cases) {
      child.stdin.write(JSON.stringify({ id: c.id, op: 'invoke', capability, input: c.input }) + '\n');
    }
  });
}

const snapshotPath = (capability) => path.join(EXPECTED_DIR, capability + '.json');
function loadSnapshot(capability) {
  const p = snapshotPath(capability);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------- run

if (flag('--list')) {
  console.log('registered workers\n');
  for (const w of registry) {
    const built = workerAvailable(w);
    console.log(`  ${w.id.padEnd(14)} ${String(w.language).padEnd(10)} ${built ? 'built' : 'NOT BUILT (run without --list to build)'}  caps: ${w.capabilities.join(' ')}`);
  }
  console.log('\ncorpus');
  for (const c of capabilities) console.log(`  ${c.capability.padEnd(18)} ${c.cases.length} cases`);
  process.exit(0);
}

const only = value('--only');
const workers = registry.filter((w) => (only ? w.id === only : true));
if (!workers.length) {
  console.error(`no worker matches --only ${only}; registered: ${registry.map((w) => w.id).join(', ')}`);
  process.exit(2);
}

console.log('workers: multilingual conformance run');
console.log(`  repository : ${ROOT}`);
console.log(`  corpus     : ${capabilities.map((c) => `${c.capability}(${c.cases.length})`).join(' ')}`);
console.log(`  workers    : ${workers.map((w) => w.id).join(', ')}`);
if (!flag('--no-build')) {
  const missing = workers.filter((w) => !workerAvailable(w) && w.build);
  if (missing.length) console.log('\nbuilding what is missing');
  for (const w of missing) tryBuild(w);
}
if (flag('--build-only')) {
  // A build-only pass is what the editor task uses: it compiles everything that is missing without
  // spending the time on the corpus, and it fails loudly if a build does not produce its artifact.
  const broken = workers.filter((w) => w.build && !workerAvailable(w));
  for (const w of workers) console.log(`  ${w.id.padEnd(14)} ${workerAvailable(w) ? 'built' : 'NOT BUILT'}`);
  process.exit(broken.length ? 1 : 0);
}

const results = new Map(); // capability -> workerId -> { output by case, issues }
const skipped = [];

for (const cap of capabilities) {
  results.set(cap.capability, new Map());
  for (const w of workers) {
    if (!workerAvailable(w)) {
      skipped.push(`${w.id}/${cap.capability}`);
      continue;
    }
    if (!w.capabilities.includes(cap.capability)) continue;
    const launchArgv = launchFor(w);
    if (!launchArgv || !resolveCommand(launchArgv[0])) {
      skipped.push(`${w.id}/${cap.capability} (interpreter not on this machine: ${launchArgv ? launchArgv[0] : w.launch[0]})`);
      continue;
    }
    const r = await runWorker(w, cap.capability, cap.cases);
    const perCase = new Map();
    const issues = [];
    if (!r.descriptor) issues.push('no describe answer');
    for (const c of cap.cases) {
      const a = r.answers.get(c.id);
      if (!a) {
        perCase.set(c.id, { missing: true, detail: r.stderr.split('\n').slice(-2).join(' ') });
        continue;
      }
      if (a.ok === false) {
        perCase.set(c.id, { error: a.error ?? { code: '?', message: '?' } });
        continue;
      }
      perCase.set(c.id, { output: a.output, issues: keyOrderIssues(cap.capability, a.output) });
    }
    results.get(cap.capability).set(w.id, { perCase, issues, descriptor: r.descriptor, stderrTail: r.stderrTail });
  }
}

// ---------------------------------------------------------------- verdict

let failures = 0;
const summary = [];

for (const cap of capabilities) {
  const perWorker = results.get(cap.capability);
  const active = [...perWorker.keys()];
  console.log(`\n== ${cap.capability}  (${cap.cases.length} cases x ${active.length} implementation(s): ${active.join(', ')})`);
  if (!active.length) {
    console.log('   [skip] no implementation available');
    continue;
  }
  const snapshot = loadSnapshot(cap.capability);
  let agree = 0;
  const disagreements = [];
  const snapshotDrift = [];
  const orderProblems = [];

  // An implementation that answered nothing is a problem of its own, counted once, and it must NOT
  // be folded into every case's verdict: with one worker timing out, "the other four disagree on
  // every case" is a lie that buries the four real answers. (It happened: an unflushed C++ worker
  // turned 58 clean cases into 58 apparent divergences.)
  // "Usable" means the worker said something for at least one case - an output OR an error. An error is
  // a legitimate answer (`bad-input` is part of the contract for `fetch.plan`), so a worker that reports
  // errors is not a broken worker; only silence is.
  const usable = active.filter((id) => {
    const cells = [...perWorker.get(id).perCase.values()];
    return cells.some((c) => c.output !== undefined || c.error !== undefined);
  });
  const unusable = active.filter((id) => !usable.includes(id));
  for (const id of unusable) {
    const w = perWorker.get(id);
    const cells = [...w.perCase.values()];
    const answered = cells.filter((c) => c.output !== undefined || c.error !== undefined).length;
    failures++;
    console.log(`   UNUSABLE   : ${id} answered ${answered}/${cap.cases.length} cases${w.stderrTail ? ' - ' + w.stderrTail.slice(0, 160) : ''}`);
  }

  for (const c of cap.cases) {
    const byCanon = new Map();
    for (const id of usable) {
      const cell = perWorker.get(id).perCase.get(c.id);
      const key = cell.missing ? 'MISSING' : cell.error ? errorCanon(cell.error) : canon(cell.output);
      if (!byCanon.has(key)) byCanon.set(key, []);
      byCanon.get(key).push(id);
      for (const issue of cell.issues ?? []) orderProblems.push(`${id}/${c.id}: ${issue}`);
    }
    const unanimous = byCanon.size === 1 && !byCanon.has('MISSING');
    if (unanimous) agree++;
    else disagreements.push({ case: c, byCanon });
    if (snapshot && snapshot.cases[c.id] !== undefined) {
      const want = canon(snapshot.cases[c.id]);
      const anyMatch = [...byCanon.keys()].some((k) => k === want);
      if (!anyMatch) snapshotDrift.push({ case: c, want, got: [...byCanon.keys()] });
    }
  }

  console.log(`   agreement  : ${agree}/${cap.cases.length} cases unanimous across ${usable.length} answering implementation(s)${unusable.length ? ` (${unusable.length} answered nothing)` : ''}`);
  const skippedHere = skipped.filter((s) => s.includes(cap.capability));
  if (skippedHere.length) {
    console.log(`   skipped    : ${skippedHere.join(', ')}`);
  }
  // Why a worker answered nothing: without this line a buffering bug and a crash look identical,
  // and "MISSING" sends the reader to the wrong file. The C++ worker's unflushed stdout was exactly
  // that trap (see docs/WORKERS.md section 1). Only silence counts here - an error answer is compared
  // like any other answer, and calling it "no usable answer" would hide a corpus of error cases behind
  // a warning that means something else.
  for (const id of active) {
    const w = perWorker.get(id);
    const silent = [...w.perCase.values()].filter((c) => c.missing).length;
    if (!silent || unusable.includes(id)) continue;
    console.log(`   note       : ${id} answered nothing for ${silent}/${cap.cases.length} case(s)${w.stderrTail ? '; worker stderr tail: ' + w.stderrTail.slice(0, 220) : ' (and said nothing on stderr)'}`);
  }
  for (const d of disagreements) {
    failures++;
    console.log(`   DIVERGES   : ${d.case.id}  (${d.case.note ?? ''})`);
    for (const [key, who] of d.byCanon) {
      console.log(`       ${who.join(', ').padEnd(30)} ${key.slice(0, 150)}`);
    }
  }
  for (const p of orderProblems.slice(0, 6)) {
    failures++;
    console.log(`   ORDER      : ${p}`);
  }
  for (const s of snapshotDrift) {
    failures++;
    console.log(`   SNAPSHOT   : ${s.case.id} - no implementation matches the reviewed snapshot`);
    console.log(`       snapshot : ${s.want.slice(0, 150)}`);
    for (const g of s.got) console.log(`       got      : ${g.slice(0, 150)}`);
  }
  if (!snapshot) console.log('   snapshot   : none yet (run with --update to record the reference output)');
  summary.push({ capability: cap.capability, implementations: active.length, cases: cap.cases.length, agree });
}

if (flag('--update')) {
  fs.mkdirSync(EXPECTED_DIR, { recursive: true });
  for (const cap of capabilities) {
    // The reference for a capability is whichever JavaScript worker implements it: `js-text` for the
    // three text capabilities, `js-search` for search. A hard-coded id worked until a second
    // capability existed and then quietly recorded nothing.
    const refId = [...results.get(cap.capability).keys()].find((id) => id.startsWith('js-'));
    const ref = refId ? results.get(cap.capability).get(refId) : null;
    if (!ref) {
      console.error(`cannot update ${cap.capability}: no JavaScript reference implementation ran`);
      failures++;
      continue;
    }
    const cases = {};
    for (const c of cap.cases) {
      const cell = ref.perCase.get(c.id);
      if (cell?.output !== undefined) cases[c.id] = cell.output;
      else if (cell?.error) cases[c.id] = { __error: cell.error.code ?? 'internal' };
    }
    fs.writeFileSync(
      snapshotPath(cap.capability),
      JSON.stringify(
        {
          capability: cap.capability,
          generatedBy: `${refId} (${registry.find((w) => w.id === refId)?.artifact ?? 'workers/js'})`,
          generatedAt: new Date().toISOString(),
          note: 'Reviewed snapshot. Regenerate only on purpose, with npm run workers -- --update, and say in the commit message why it changed.',
          cases,
        },
        null,
        1,
      ) + '\n',
      'utf8',
    );
    console.log(`\nsnapshot updated: workers/spec/expected/${cap.capability}.json (${Object.keys(cases).length} cases)`);
  }
}

console.log('\n== summary');
for (const id of buildFailures) {
  failures++;
  console.log(`   BUILD FAILED: ${id} - the toolchain is present but the build produced no artifact (see above)`);
}
for (const s of summary) console.log(`   ${s.capability.padEnd(18)} ${s.agree}/${s.cases} unanimous, ${s.implementations} implementation(s)`);

// The layer's fallback promise, checked rather than assumed: "fall back to JavaScript when a worker is
// missing" is only true if every capability has a JavaScript implementation that actually answered. This
// used to be a hard-coded existence check for the text reference alone, which said nothing about the
// capabilities added since - and a promise nobody checks is a sentence, not a property.
const missingReference = [];
for (const cap of capabilities) {
  const perWorker = results.get(cap.capability);
  const jsIds = [...perWorker.keys()].filter((id) => id.startsWith('js-'));
  const answered = jsIds.some((id) => [...perWorker.get(id).perCase.values()].some((c) => c.output !== undefined));
  if (!answered) missingReference.push(cap.capability);
}
if (missingReference.length) failures++;
console.log(
  `   reference : ${
    missingReference.length
      ? `MISSING for ${missingReference.join(', ')} - there is nothing to fall back to`
      : 'every capability has a JavaScript implementation that answered'
  }`,
);
console.log(`   ${failures === 0 ? 'all implementations agree' : failures + ' problem(s) (see above)'}`);
console.log('');
process.exit(failures === 0 ? 0 : 1);

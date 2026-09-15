// traverse.mjs — walk the running application and collect the things that are wrong
//
// Why a tool and not a one-off script: the question "what is broken right now" gets asked again after every
// feature, and the answer has to be comparable between runs. This walks three layers in order of cost:
//
//   1. **Every API route the server declares**, read out of `server/src/server.js` rather than typed here, so
//      a route added tomorrow is covered without anyone remembering to add it. Routes that change state are
//      called with a missing id and an empty body: a 4xx is the correct answer and still exercises routing,
//      validation and error handling, while a 5xx is a defect. Some of them answer 2xx to an empty body, which
//      is not automatically wrong (deleting something that is not there is idempotent); those are listed in
//      the report rather than judged, so a validation gap stays visible without turning the report into noise.
//   2. **The static shell**: the page and every asset it references must be served.
//   3. **The real UI in a real browser** (Playwright, if it can start): every navigation target is clicked,
//      and console errors, page errors and failed requests are collected. That is the only layer that can see
//      a React crash or a missing dictionary key.
//
//   node tools/traverse.mjs                  all three layers
//   node tools/traverse.mjs --api-only       no browser needed
//   node tools/traverse.mjs --base http://127.0.0.1:43110
//
// Nothing here writes to the application's config or its archive: the write-shaped routes are either skipped
// by name or called in a form that must fail. The report goes to the cache directory, never the system drive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { base: 'http://127.0.0.1:43110', apiOnly: false, out: 'E:/DaShaoHuo/cache/tmp', slowMs: 3000 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--base') args.base = String(process.argv[++i] ?? args.base);
  else if (a === '--api-only') args.apiOnly = true;
  else if (a === '--out') args.out = String(process.argv[++i] ?? args.out);
  else if (a === '--slow') args.slowMs = Number(process.argv[++i]) || args.slowMs;
}

const findings = [];
const notes = [];
const acceptedEmptyBody = [];
function finding(layer, where, what, detail) {
  findings.push({ layer, where, what, detail });
  process.stdout.write(`  [BUG]  ${layer}: ${where} -- ${what}${detail ? ' :: ' + detail : ''}\n`);
}
function ok(layer, where, extra) {
  process.stdout.write(`  [ok]   ${layer}: ${where}${extra ? ' -- ' + extra : ''}\n`);
}

/**
 * Routes out of the source. The substitution rules exist because a route with a parameter cannot be called
 * without one, and asking for something that does not exist is exactly the request that must be answered with
 * a 4xx rather than a 500 - which is the thing this sweep is looking for.
 */
function readRoutes() {
  const src = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  const out = [];
  const re = /app\.(get|post|patch|put|delete)\(\s*'(\/api\/[^']*)'/g;
  for (const m of src.matchAll(re)) out.push({ method: m[1].toUpperCase(), route: m[2] });
  return out;
}

/**
 * Which requests are safe to send.
 *
 * `skip` names the routes whose whole purpose is a side effect with no harmless form - starting a run,
 * sending a notification, posting to a site, writing the config. For everything else, a request that must be
 * refused is a safe request, and it covers far more of the surface than testing only the read-only half.
 */
const SKIP = [
  { method: 'POST', route: '/api/run', why: 'starts a collection run' },
  { method: 'POST', route: '/api/config', why: 'writes the config' },
  { method: 'PATCH', route: '/api/config', why: 'writes the config' },
  { method: 'POST', route: '/api/share/post', why: 'would post to a site' },
  { method: 'POST', route: '/api/share/handoff', why: 'records a hand-off' },
  { method: 'POST', route: '/api/open', why: 'starts an external program' },
  { method: 'POST', route: '/api/notify/test', why: 'sends a notification' },
  { method: 'DELETE', route: '/api/reports/:name', why: 'deletes a report' },
  // The long ones are skipped by name for a reason that has nothing to do with safety: with an empty body
  // they measure every source on the network (measured: 220s for a full probe, 37s for an extraction), which
  // would turn a traversal into a three-minute wait and leave the application busy for everything after it.
  { method: 'POST', route: '/api/probe', why: 'a full probe takes minutes and holds the in-flight guard' },
  { method: 'POST', route: '/api/sources/:id/diagnose', why: 'a diagnose measures the source over the network' },
  { method: 'POST', route: '/api/proxy/nodes/test', why: 'tests every node group over the network' },
  { method: 'POST', route: '/api/features/extract', why: 'extraction takes tens of seconds' },
  { method: 'POST', route: '/api/egress/decide', why: 'with an empty body it decides for everything, which measures every egress (timed out at 30s)' },
];

function materialise(route) {
  return route
    .replace(':id', 'traverse-does-not-exist')
    .replace(':name', 'traverse-does-not-exist')
    .replace(':file', 'traverse-does-not-exist')
    .replace(/:[A-Za-z_]+/g, 'traverse-does-not-exist');
}

async function sweepApi() {
  const routes = readRoutes();
  process.stdout.write(`\n1. API sweep -- ${routes.length} routes declared\n`);
  let called = 0;
  let skipped = 0;
  for (const { method, route } of routes) {
    const skip = SKIP.find((s) => s.method === method && s.route === route);
    if (skip) {
      skipped++;
      notes.push(`${method} ${route} skipped: ${skip.why}`);
      continue;
    }
    const url = args.base + materialise(route);
    const started = Date.now();
    let status = 0;
    let body = '';
    let ctype = '';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
        signal: AbortSignal.timeout(30000),
      });
      status = res.status;
      ctype = res.headers.get('content-type') ?? '';
      body = (await res.text()).slice(0, 400);
    } catch (e) {
      finding('api', `${method} ${route}`, 'request failed', e.message);
      continue;
    }
    const ms = Date.now() - started;
    called++;
    // An HTML body on an API route is only a defect when it is the framework's error page. The first run of
    // this tool flagged `POST /api/share/bundle` for returning `text/html`, which is exactly what that route
    // is for - it generates a document. A heuristic that cannot tell a generated file from a crash report
    // produces noise, and noise is what makes a report unreadable.
    const looksLikeErrorPage = /<title>\s*Error|Cannot (GET|POST|PATCH|PUT|DELETE)\s|at Object\.<anonymous>/i.test(body);
    const writeVerb = method !== 'GET';
    if (status >= 500) finding('api', `${method} ${route}`, `answered ${status}`, body.replace(/\s+/g, ' ').slice(0, 200));
    else if (ctype.includes('text/html') && looksLikeErrorPage)
      finding('api', `${method} ${route}`, 'answered with what looks like an error page', body.replace(/\s+/g, ' ').slice(0, 160));
    else if (ms > args.slowMs) finding('api', `${method} ${route}`, `slow: ${ms}ms`, '');
    else if (status === 0) finding('api', `${method} ${route}`, 'no status', '');
    else {
      ok('api', `${method} ${route}`, `${status} in ${ms}ms`);
      // A write-shaped route that accepts an empty body is not automatically wrong (deleting something that
      // is not there is idempotent, importing nothing imports nothing), but it is worth seeing in one place,
      // because "it accepted a request it had no reason to accept" is how a validation gap looks from here.
      if (writeVerb && status >= 200 && status < 300) acceptedEmptyBody.push(`${method} ${route} -> ${status}`);
    }
  }
  process.stdout.write(`   called ${called}, skipped ${skipped} (side effects), ${findings.length} finding(s) so far\n`);
}

async function sweepStatic() {
  process.stdout.write('\n2. static shell\n');
  const index = path.join(ROOT, 'web/dist/index.html');
  if (!fs.existsSync(index)) {
    finding('static', 'web/dist/index.html', 'the built UI is missing', 'run: npm run build');
    return;
  }
  const html = fs.readFileSync(index, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u));
  const wanted = ['/', ...refs];
  for (const ref of wanted) {
    const url = args.base + (ref.startsWith('/') ? ref : '/' + ref);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) finding('static', ref, `answered ${res.status}`, url);
      else ok('static', ref, `${res.status}`);
    } catch (e) {
      finding('static', ref, 'request failed', e.message);
    }
  }
}

/**
 * The UI layer. Every navigation target in the header is clicked in turn, and anything the page reports along
 * the way - console errors, uncaught exceptions, requests that failed - is collected. Requests that are
 * expected to fail (a probe for a source that is not there) are not distinguished here on purpose: a wall of
 * red would hide the one line that matters, so the report keeps them all and the reader decides.
 */
async function sweepUi() {
  process.stdout.write('\n3. UI traversal\n');
  // Playwright downloads its browsers to the system drive by default, and a packaged build of this app already
  // ships a copy under dist/. Pointing at that copy costs nothing where it exists (no download, no writes to
  // C:) and leaves the default alone where it does not, which is the difference between "the UI layer ran" and
  // "the UI layer was skipped" on this machine. It has to be set before the import below, because the browser
  // path is read at load time.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const candidates = [
      path.join(ROOT, 'pw-browsers'),
      path.join(ROOT, 'dist', 'VtuberMonitorLink', 'pw-browsers'),
      'E:/VML-r-1.0/pw-browsers',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = found;
      process.stdout.write(`   browsers: ${found}\n`);
    } else {
      notes.push('no bundled playwright browsers found; the UI layer will fall back to the default location');
    }
  }
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    notes.push('playwright is not installed: the UI layer was not walked (' + e.message + ')');
    process.stdout.write('   skipped: playwright is not available\n');
    return;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    notes.push('playwright could not start a browser: the UI layer was not walked (' + e.message + ')');
    process.stdout.write('   skipped: no browser (' + e.message.split('\n')[0] + ')\n');
    return;
  }
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} (${r.failure()?.errorText ?? '?'})`));
  page.on('response', (r) => {
    if (r.status() >= 500) failed.push(`${r.request().method()} ${r.url()} -> ${r.status()}`);
  });

  await page.goto(args.base + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);

  const shellCount = await page.locator('#root > *').count();
  if (shellCount === 0) finding('ui', '/', 'the application rendered nothing into #root', '');
  else ok('ui', '/', `${shellCount} root child(ren)`);

  // The navigation is `nav.tabs button` and nothing else. The first version of this tool swept in the header
  // too, clicked the About entry before any tab, and the About panel covered the page - so all eleven real tabs
  // were reported as unclickable. A tool that names the wrong element turns one overlay into eleven findings.
  // Escape is pressed before every click so a panel left open by a previous step cannot swallow the next one.
  const selector = 'nav.tabs button';
  const labels = (await page.locator(selector).allInnerTexts())
    .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 40))
    .filter(Boolean);
  process.stdout.write(`   ${labels.length} navigation target(s) found\n`);
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
    // Resolve the element at click time, by its own text: handles captured up front go stale the moment the
    // page re-renders.
    const target = page.locator(selector).filter({ hasText: label }).first();
    const before = failed.length + consoleErrors.length + pageErrors.length;
    const textBefore = await page.locator('#root').innerText().catch(() => '');
    try {
      await target.click({ timeout: 8000 });
      await page.waitForTimeout(1200);
      const body = await page.locator('#root').innerText().catch(() => '');
      const added = failed.length + consoleErrors.length + pageErrors.length - before;
      if (!body.trim()) finding('ui', label, 'the tab rendered an empty page', '');
      else if (body.trim() === textBefore.trim()) finding('ui', label, 'clicking it changed nothing on the page', 'the same text is still on screen');
      else if (added > 0) finding('ui', label, `the tab produced ${added} new error line(s)`, '');
      else ok('ui', label, `${body.trim().length} chars rendered`);
    } catch (e) {
      finding('ui', label, 'could not be clicked', e.message.split('\n')[0]);
    }
  }

  for (const e of pageErrors) finding('ui', 'pageerror', e, '');
  for (const e of [...new Set(consoleErrors)].slice(0, 20)) finding('ui', 'console.error', e, '');
  for (const e of [...new Set(failed)].slice(0, 25)) finding('ui', 'request failed', e, '');

  await browser.close();
}

async function main() {
  process.stdout.write(`traverse: ${args.base}\n`);
  try {
    const res = await fetch(args.base + '/api/sources', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('answered ' + res.status);
  } catch (e) {
    process.stdout.write(`\nThe application is not answering at ${args.base} (${e.message}).\nStart it first: node launcher/launch.cjs\n`);
    process.exit(2);
  }

  await sweepApi();
  await sweepStatic();
  if (!args.apiOnly) await sweepUi();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = path.join(args.out, `vml-traverse-${stamp}.md`);
  const lines = [
    `# traversal ${new Date().toISOString()}`,
    '',
    `base: ${args.base}`,
    `findings: ${findings.length}`,
    '',
    '## findings',
    '',
    ...(findings.length
      ? findings.map((f) => `- **${f.layer}** \`${f.where}\` -- ${f.what}${f.detail ? ` :: ${f.detail}` : ''}`)
      : ['(none)']),
    '',
    '## skipped / notes',
    '',
    ...(notes.length ? notes.map((n) => `- ${n}`) : ['(none)']),
    '',
    '## write-shaped routes that accepted an empty body (listed, not judged)',
    '',
    ...(acceptedEmptyBody.length ? acceptedEmptyBody.map((n) => `- ${n}`) : ['(none)']),
    '',
  ];
  fs.writeFileSync(report, lines.join('\n'), 'utf8');
  process.stdout.write(`\n${findings.length} finding(s). report: ${report}\n`);
  process.exit(findings.length ? 1 : 0);
}

main().catch((e) => {
  process.stdout.write('\ntraverse crashed: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(2);
});

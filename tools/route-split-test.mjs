// tools/route-split-test.mjs - the splitter's safety net, against fixtures rather than against the real factory.
//
// ASCII only.
//
// Why a fixture: this tool **rewrites source files**, so testing it against `server/src/server.js` would mean the
// test edits the thing it is testing. `--file` exists for exactly this. What is under test is not "does it move
// lines" - that is mechanical - but the two ways it can produce a module that is valid syntax, starts the app, and
// 500s the first time the route is called:
//
//   * a body that reaches for a name the *factory* provides and the context did not carry (`persist`, `busyGuard`)
//   * a body that reaches for a **local helper** defined elsewhere in the factory (`preserveSecretsIn`)
//
// The second one got out once. The net only knew the seven factory names, so the module referenced an undefined
// name and `PUT /api/watch` answered 500 - `node --check` clean, app up, nothing static could see it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPLITTER = path.join(ROOT, 'tools', 'route-split.cjs');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + (e && e.message) + '\n');
  }
};

const TMP_ROOT = process.env.VML_TEST_TMP || path.join(os.tmpdir(), 'vml-route-split');
const TMP_PREFIX = 'vml-route-split-';

function sweep() {
  let entries = [];
  try {
    entries = fs.readdirSync(TMP_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(TMP_PREFIX)) {
      fs.rmSync(path.join(TMP_ROOT, e.name), { recursive: true, force: true });
    }
  }
}

let seq = 0;
/**
 * A miniature factory with the three shapes that matter: a two-space local helper, a factory-provided name that is
 * only in the context when it is asked for, and a group whose body uses whichever of them the case names.
 */
function fixture({ useLocalHelper = false, useFactoryName = null } = {}) {
  const dir = path.join(TMP_ROOT, TMP_PREFIX + process.pid + '-' + seq++);
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  const body = [];
  body.push("  app.get('/api/probe', (_req, res) => {");
  if (useLocalHelper) body.push('    const shaped = rewriteBody(_req.body);');
  if (useFactoryName) body.push(`    const saved = ${useFactoryName}({ ...getConfig(), shaped: true });`);
  body.push('    res.json({ ok: true, cfg: getConfig() ?? null });');
  body.push('  });');
  body.push("  app.post('/api/probe/check', (_req, res) => res.json({ ok: true }));");
  const src = [
    "import express from 'express';",
    "import { docLang, pickDoc, readDocs } from './docs.js';",
    '',
    'export function createApp({ getConfig, patchConfig, log, persist, busyGuard }) {',
    '  const app = express();',
    '  const rewriteBody = (b) => ({ ...(b ?? {}) });',
    '',
    ...body,
    '',
    '  return app;',
    '}',
    '',
  ].join('\n');
  const file = path.join(dir, 'src', 'server.js');
  fs.writeFileSync(file, src);
  return { dir, file, src, body };
}

function split(file, group, ctx) {
  const args = [SPLITTER, group, '--file', file];
  if (ctx) args.splice(2, 0, ctx);
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
}

sweep();
process.stdout.write('\nroute split: the safety net, against fixtures\n\n');

t('a group whose body needs nothing extra is moved, and the module parses', () => {
  const f = fixture();
  const r = split(f.file, 'probe');
  assert.equal(r.status, 0, 'the splitter refused a group it should have moved: ' + r.stdout + r.stderr);
  const module = path.join(f.dir, 'src', 'routes', 'probe.js');
  assert.ok(fs.existsSync(module), 'no module was written');
  const check = spawnSync(process.execPath, ['--check', module], { encoding: 'utf8' });
  assert.equal(check.status, 0, 'the module does not parse: ' + check.stderr);
  const text = fs.readFileSync(f.file, 'utf8');
  assert.match(text, /registerProbeRoutes\(app, \{ getConfig, patchConfig, log \}\);/, 'the registrar call is not where the block was');
  assert.ok(!text.includes("app.get('/api/probe'"), 'the handlers are still in the factory');
  assert.match(text, /import \{ registerProbeRoutes \} from '\.\/routes\/probe\.js';/, 'the import was not added');
});

t('control: a factory name outside the context stops it, and nothing is written', () => {
  const f = fixture({ useFactoryName: 'persist' });
  const r = split(f.file, 'probe');
  assert.notEqual(r.status, 0, 'it moved a group that needs a name the context does not carry');
  assert.match(r.stdout, /STOP/, 'no STOP was printed');
  assert.match(r.stdout, /persist/, 'the name was not reported');
  assert.ok(!fs.existsSync(path.join(f.dir, 'src', 'routes', 'probe.js')), 'a module was written anyway');
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.src, 'the factory was modified anyway');
});

t('control: the same body proceeds once that name is given through ctx', () => {
  const f = fixture({ useFactoryName: 'persist' });
  const r = split(f.file, 'probe', 'persist');
  assert.equal(r.status, 0, 'it refused a group whose context carries what it needs: ' + r.stdout + r.stderr);
  const module = fs.readFileSync(path.join(f.dir, 'src', 'routes', 'probe.js'), 'utf8');
  assert.match(module, /export function registerProbeRoutes\(app, \{ getConfig, patchConfig, log, persist \}\)/, 'the module signature does not carry the extra');
  assert.match(fs.readFileSync(f.file, 'utf8'), /registerProbeRoutes\(app, \{ getConfig, patchConfig, log, persist \}\);/, 'the registrar call does not carry it either');
});

t('a local helper of the factory stops it - the hole that produced an undefined name', () => {
  const f = fixture({ useLocalHelper: true });
  const r = split(f.file, 'probe');
  assert.notEqual(r.status, 0, 'it moved a body that calls a helper left behind in the factory');
  assert.match(r.stdout, /rewriteBody/, 'the helper was not named: ' + r.stdout);
  assert.ok(!fs.existsSync(path.join(f.dir, 'src', 'routes', 'probe.js')), 'a module was written anyway');
});

t('control: that same helper given through ctx proceeds, so the net is not simply "always stop"', () => {
  const f = fixture({ useLocalHelper: true });
  const r = split(f.file, 'probe', 'rewriteBody');
  assert.equal(r.status, 0, 'the net stopped on a name that was supplied: ' + r.stdout + r.stderr);
});

t('an unknown group is refused with its own message rather than an empty module', () => {
  const f = fixture();
  const r = split(f.file, 'nosuchgroup');
  assert.notEqual(r.status, 0, 'it accepted a group with no routes');
  assert.match(r.stdout + r.stderr, /no \/api\/nosuchgroup routes found/);
});

sweep();

process.stdout.write('\n' + (fail === 0 ? 'all passed' : fail + ' failed') + ': ' + pass + ' passed, ' + fail + ' failed\n\n');
process.exit(fail === 0 ? 0 : 1);

// ---------------------------------------------------------------------------------------------------
// config-secrets-test.mjs — what a client is allowed to see of the config, and who is allowed to ask.
//
// Two findings from the v1.0.5 audit, and the checks are grouped the same way.
//
//   A. **the config went out with its secrets in it.** `GET /api/config` answered `res.json(getConfig())`
//      verbatim, so `llm.providers[].apiKey` and a watch target's `botPassword` reached any caller — a local
//      process with no trick at all, a web page through DNS rebinding. The rule that replaces it (one
//      declared list of secret *field names*, applied by walking the real config at any depth) lives in
//      server/src/config.js, and this file checks it as a structure rather than as two named fields:
//        · every secret-shaped field of the fixture is masked on every read route that carries config;
//        · a **new** secret-shaped field, added to the fixture by this test and named nowhere in src, is
//          masked too — the control against "the serializer only masks the two fields it was written for";
//        · a masked value sent back in a write is not stored — the export/import precedent, which says an
//          `apiKey: ''` from a redacted export must not wipe the key already on the machine.
//
//   B. **anyone could ask.** The service binds 127.0.0.1 and that was treated as the whole defence. A page
//      on evil.example that re-resolves its own name to 127.0.0.1 makes the browser send `Host: evil.example`
//      to our port, and the answer is readable as same-origin. The allowlist is over the `Host` header (and
//      over `Origin` when one is present); a refusal is JSON, not a reset.
//
// Every check is shown to be able to fail: each section carries an explicit `control:` check that runs the
// same probe against an input that must trip it — the unmasked config, a rebinding Host, a foreign Origin, a
// masked credential that must not reach the network. A check that cannot fail is not a check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  PUBLIC_FIELDS,
  SECRET_MASK,
  isMaskedSecret,
  mergeDefaults,
  preserveSecretStrings,
  publicConfig,
  stringLeaves,
} from '../server/src/config.js';
import express from 'express';
import { guardDecision, hostAllowed, originAllowed } from '../server/src/request-guard.js';
import { createApp } from '../server/src/server.js';

let pass = 0;
let fail = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    failures.push(name + ' — ' + e.message);
    process.stdout.write('  [FAIL] ' + name + ' — ' + e.message + '\n');
  }
};
/** The async half of the same thing: collected, then run in order (see the end of the file). */
const asyncChecks = [];
const ta = (name, fn) => asyncChecks.push([name, fn]);
const section = (s) => process.stdout.write('\n' + s + '\n');

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
// The secrets are distinctive literals on purpose: a check that searched for 'k' or 'password' would find
// those characters in unrelated text, and a red result would then be about the fixture, not the code.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-config-secrets-'));
const CFG_PATH = path.join(WORK, 'config.json');

const SECRETS = {
  apiKey: 'sk-live-LEAKCANARY-1111111111', // sanitize-allow: a synthetic canary, not a credential
  botPassword: 'BotPw-LEAKCANARY-2222222222',
  notifyKey: 'notify-LEAKCANARY-3333333333',
  webhookUrl: 'https://hooks.example.invalid/T000/B000/LEAKCANARY4444444444',
  controlSecret: 'ctrl-LEAKCANARY-5555555555',
};
// Added to the fixture *after* the two known fields, purely to check that the rule is a rule and not a
// lookup table. Nothing under server/src names this field.
const NEW_SECRET_FIELD = 'relaySigningKey';
const TYPED_KEY = 'sk-typed-by-the-user-7777'; // sanitize-allow: the key a user "types" in this test
const NEW_SECRET_VALUE = 'newfield-LEAKCANARY-6666666666';
const newSecretFlag = `has${NEW_SECRET_FIELD[0].toUpperCase()}${NEW_SECRET_FIELD.slice(1)}`;

const tmpDirs = (...names) => Object.fromEntries(names.map((n) => [n, path.join(WORK, n)]));

const baseConfig = () =>
  mergeDefaults({
    paths: tmpDirs('reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice', 'vdb'),
    llm: {
      activeId: 'p1',
      providers: [
        { id: 'p1', preset: 'custom', name: 'fixture', baseUrl: 'https://api.example.invalid/v1', apiKey: SECRETS.apiKey, model: 'm' },
      ],
      apiKey: '',
    },
    watch: {
      enabled: true,
      targets: [
        {
          id: 'w-wiki',
          kind: 'mediawiki-watchlist',
          label: 'wiki',
          apiUrl: 'https://wiki.example.invalid/w/api.php',
          username: 'Bot@Task',
          botPassword: SECRETS.botPassword,
          enabled: true,
          // This fixture's apiUrl is pointed at a fake wiki on 127.0.0.1 by the masked-password case below, so
          // the target carries the explicit loopback allowance (server/src/remote-url.js). Without it the check
          // would be refused before it left the process — which is the default the policy test pins, not an
          // accident this fixture should depend on.
          allowLoopback: true,
        },
        { id: 'w-url', kind: 'url', label: 'plain', url: 'https://example.com/', enabled: true },
      ],
    },
    notify: {
      desktop: false,
      targets: [
        { id: 'n1', kind: 'bark', name: 'phone', enabled: true, on: 'always', key: SECRETS.notifyKey },
        { id: 'n2', kind: 'custom', name: 'hook', enabled: true, on: 'always', webhookUrl: SECRETS.webhookUrl },
      ],
    },
    proxy: { enabled: false, mode: 'http', controlUrl: 'http://127.0.0.1:9090', controlSecret: SECRETS.controlSecret },
    share: { images: { mode: 'none', maxPerBundle: 4, maxPerPost: 1, inlineMaxBytes: 204800 } },
  });

/** The fixture as this test really writes it: the base config plus one secret-shaped field src does not know. */
function fixtureConfig() {
  const cfg = baseConfig();
  cfg.llm.providers[0][NEW_SECRET_FIELD] = NEW_SECRET_VALUE;
  return cfg;
}

// ── the probes ──────────────────────────────────────────────────────────────────────────────────────
/**
 * Every place the given plaintext appears in an object, by path. Built on `stringLeaves` (a plain
 * dict-of-leaves dump) rather than on the serializer, so "no secret in the answer" is a statement about the
 * answer and not a restatement of the serializer's own opinion.
 */
function leakHits(obj, secrets) {
  const leaves = stringLeaves(obj);
  const hits = [];
  for (const [p, v] of Object.entries(leaves)) {
    for (const [name, secret] of Object.entries(secrets)) {
      if (v.includes(secret)) hits.push(`${p} carries the plaintext ${name}`);
    }
  }
  return hits;
}

/** The same question for a response that arrived as text (a wrong content-type must not hide anything). */
const textHits = (text, secrets) =>
  Object.entries(secrets)
    .filter(([, s]) => String(text).includes(s))
    .map(([name]) => `the raw body contains the plaintext ${name}`);

/**
 * The structural probe: the shape a response must have *if* it was redacted. It reports a missing field as
 * well as an unmasked one, because "the page cannot read it any more" is a different failure from "the
 * secret is still there" and a naive "no plaintext" check would happily accept the first.
 */
function redactionProbe(obj, secrets) {
  const leaves = stringLeaves(obj);
  const out = [];
  const requireMasked = (suffix, handle) => {
    const at = Object.keys(leaves).find((p) => p.endsWith(suffix));
    if (!at) out.push(`no <${handle}> field in the answer (the page needs the field, redacted)`);
    else if (!isMaskedSecret(leaves[at])) out.push(`<${handle}> is not masked: ${JSON.stringify(leaves[at])}`);
  };
  requireMasked('.providers[0].apiKey', 'llm provider apiKey');
  requireMasked('.providers[0].' + NEW_SECRET_FIELD, NEW_SECRET_FIELD);
  requireMasked('proxy.controlSecret', 'proxy controlSecret');
  requireMasked('.targets[0].key', 'notify target key');
  requireMasked('.targets[1].webhookUrl', 'notify target webhookUrl');
  requireMasked('.targets[0].botPassword', 'watch target botPassword');
  return [...out, ...leakHits(obj, secrets)];
}

// ── small HTTP helpers ──────────────────────────────────────────────────────────────────────────────
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r)).then(() => server.address().port);
const shutdown = (server) => new Promise((r) => server.close(r));
const makeLogger = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

/**
 * An app whose config lives in memory and is written to a fixture file — never to the real config.json, and
 * never on the real port (listen(0) picks a spare one).
 *
 * `rawConfig: true` models the **pre-fix** server: it answers with the config object itself. That server is
 * the control for every "no plaintext in the answer" check below — the same detector has to fire on it, or
 * those checks would pass for a serializer that did nothing.
 */
async function startFixtureApp() {
  let cfg = fixtureConfig();
  const write = () => fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  write();
  const app = createApp({
    getConfig: () => cfg,
    setConfig: (next) => {
      cfg = mergeDefaults(next);
      write();
      return cfg;
    },
    log: makeLogger(),
    onConfigChanged: () => {},
  });
  const server = http.createServer(app);
  const port = await listen(server);
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    server,
    setConfig: (next) => {
      cfg = mergeDefaults(next);
      write();
    },
    disk: () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')),
  };
}

/**
 * The control server: `createApp`'s own stack, with a route that answers with the config **verbatim** mounted
 * in front of it. Mounting it that way is not a shortcut — a route added to the app after createApp() never
 * runs, because createApp ends with an `/api` catch-all that answers 404 (which is how this control first
 * failed, and is exactly the shape the leak used to have: one handler, early, handing the object over).
 */
async function startLeakServer() {
  const fixture = fixtureConfig();
  const leakExpress = express();
  leakExpress.get('/api/config-raw-for-control', (_req, res) => res.json(fixture));
  const server = http.createServer(leakExpress);
  const port = await listen(server);
  return { port, base: `http://127.0.0.1:${port}`, server };
}

async function req(base, method, route, body, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null: the caller decides whether JSON was promised */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const get = (base, route, headers) => req(base, 'GET', route, undefined, headers);
const send = (base, method, route, body, headers) => req(base, method, route, body, headers);

/**
 * A request that can actually forge `Host`. `fetch` silently drops that header (it is a forbidden header in
 * the Fetch spec — `Host: evil.example` sent through undici arrives as the real one, and a rebinding test
 * built on fetch would therefore always see a normal request and never be refused), so the DNS-rebinding
 * checks below go through `http.request`, which sends the headers it is given.
 */
function rawRequest(base, routePath, headers = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const rq = http.request(
      { hostname: url.hostname, port: url.port, path: routePath, method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* keep null */
          }
          resolve({ status: res.statusCode, json, text, headers: res.headers });
        });
      }
    );
    rq.on('error', reject);
    rq.end();
  });
}

/**
 * A stand-in wiki that records exactly what it was asked and answers as a successful login. The whole
 * request is kept (headers included), because `checkWatchLogin` proves the credential with an HTTP Basic
 * `authorization` header rather than a form body — a fixture that only recorded bodies would report "the
 * password was never sent" for a check that sent it correctly.
 */
async function startFakeWiki() {
  const seen = [];
  const server = http.createServer((rq, res) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      seen.push({ url: rq.url, headers: rq.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ query: { userinfo: { id: 7, name: 'Bot@Task' } } }));
    });
  });
  const port = await listen(server);
  return { port, server, seen, dump: () => JSON.stringify(seen) };
}

const main = async () => {
  process.stdout.write('\nconfig secrets & request guard\n');
  process.stdout.write('  fixture: ' + WORK + '\n');

  const fixture = fixtureConfig();

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  section('1. publicConfig — the serializer');

  t('every secret-shaped field of the fixture is masked, at every depth', () => {
    const problems = redactionProbe(publicConfig(fixture), SECRETS);
    assert.deepEqual(problems, [], problems.join('; '));
  });

  t('the mask is derived from the real config, so non-secret settings survive untouched', () => {
    const pub = publicConfig(fixture);
    assert.equal(pub.llm.providers[0].baseUrl, fixture.llm.providers[0].baseUrl);
    assert.equal(pub.watch.targets[0].username, 'Bot@Task', 'the username is not the secret');
    assert.equal(pub.watch.targets[1].url, 'https://example.com/');
    assert.equal(pub.paths.reportsDir, fixture.paths.reportsDir);
    assert.equal(pub.share.images.inlineMaxBytes, 204800, 'a declared non-secret must stay readable');
  });

  t('each masked field carries a hasXxx computed from the real value', () => {
    const pub = publicConfig(fixture);
    assert.equal(pub.llm.providers[0].hasApiKey, true);
    assert.equal(pub.llm.providers[0][newSecretFlag], true);
    assert.equal(pub.watch.targets[0].hasBotPassword, true);
    assert.equal(pub.proxy.hasControlSecret, true);
    // The absent case has to be distinguishable from the present one, or the flag says nothing.
    const cleared = publicConfig({ llm: { providers: [{ id: 'x', apiKey: '' }] } });
    assert.equal(cleared.llm.providers[0].hasApiKey, false, 'an empty secret must report has=false');
    assert.equal(cleared.llm.providers[0].apiKey, '');
  });

  t('the serializer does not mutate the config it was handed', () => {
    const before = JSON.stringify(fixture);
    publicConfig(fixture);
    assert.equal(JSON.stringify(fixture), before);
  });

  t('control: the leak detector fires on the unredacted config (so the check above is not vacuous)', () => {
    const hits = leakHits(fixture, SECRETS);
    for (const name of Object.keys(SECRETS)) {
      assert.ok(hits.some((h) => h.includes(name)), `the detector missed ${name}: ` + JSON.stringify(hits));
    }
    // …including the one field nothing in src names, which is the point of that field.
    assert.equal(leakHits(fixture, { [NEW_SECRET_FIELD]: NEW_SECRET_VALUE }).length, 1);
    // The same detector descends into arrays and nested objects, not only top-level keys.
    assert.equal(leakHits({ a: { b: [NEW_SECRET_VALUE] } }, { [NEW_SECRET_FIELD]: NEW_SECRET_VALUE }).length, 1);
  });

  t('control: the structural probe reports a dropped field as well as an unmasked one', () => {
    // Two deliberately wrong answers. A probe that only looked for plaintext would accept the first.
    const dropped = publicConfig(fixture);
    delete dropped.llm.providers[0].apiKey;
    assert.ok(redactionProbe(dropped, SECRETS).some((p) => /no <llm provider apiKey>/.test(p)), 'a dropped field must be reported');
    const unmasked = publicConfig(fixture);
    unmasked.llm.providers[0].apiKey = SECRETS.apiKey;
    assert.ok(redactionProbe(unmasked, SECRETS).some((p) => /not masked/.test(p)), 'an unmasked field must be reported');
    assert.deepEqual(redactionProbe(publicConfig(fixture), SECRETS), [], 'and the correct answer stays clean');
  });

  t('a look-alike name stays readable only because it is declared non-secret', () => {
    // `share.images.inlineMaxBytes` is a byte count. Remove the declaration and it would be masked — which is
    // why the list is a decision that has to be made out loud rather than an accident of naming.
    assert.ok(PUBLIC_FIELDS.includes('share.images.inlineMaxBytes'));
    assert.ok(!isMaskedSecret(String(publicConfig(fixture).share.images.inlineMaxBytes)));
    // The control: an *undeclared* name that matches the rule is masked, so the exception above is doing work.
    assert.equal(publicConfig({ x: { proxyToken: 'v' } }).x.proxyToken, SECRET_MASK);
    // …and one that does not match it stays readable, which is why `inlineMaxBytes` needs no declaration.
    assert.equal(publicConfig({ x: { inlineMaxBytes: 'v' } }).x.inlineMaxBytes, 'v');
  });

  t('a masked value sent back in a write is not a new value (unit level)', () => {
    const kept = preserveSecretStrings(publicConfig(fixture), fixture);
    assert.equal(kept.llm.providers[0].apiKey, SECRETS.apiKey);
    assert.equal(kept.llm.providers[0][NEW_SECRET_FIELD], NEW_SECRET_VALUE);
    assert.equal(kept.watch.targets[0].botPassword, SECRETS.botPassword);
    assert.equal(kept.notify.targets[0].key, SECRETS.notifyKey);
    assert.equal(kept.notify.targets[1].webhookUrl, SECRETS.webhookUrl);
    assert.equal(kept.proxy.controlSecret, SECRETS.controlSecret);
    assert.ok(!('hasApiKey' in kept.llm.providers[0]), 'hasXxx is derived output and must not be persisted');
  });

  t('a genuinely new secret still saves (masking must not block a real change)', () => {
    const typed = preserveSecretStrings({ llm: { providers: [{ id: 'p1', apiKey: TYPED_KEY }] } }, fixture); // sanitize-allow: a canary, not a credential
    assert.equal(typed.llm.providers[0].apiKey, TYPED_KEY);
    // A profile that has nothing stored keeps what it was given — and, because entries are matched by id, it
    // does not inherit the key of whatever sits at the same array position. (Position-only matching let a
    // newly added profile come out holding the deleted neighbour's key.)
    const fresh = preserveSecretStrings({ llm: { providers: [{ id: 'p2', apiKey: '' }] } }, fixture);
    assert.equal(fresh.llm.providers[0].apiKey, '', "a new profile must not inherit the stored profile's key");
    const inherited = preserveSecretStrings({ llm: { providers: [{ id: 'p1', apiKey: SECRET_MASK }] } }, fixture);
    assert.equal(inherited.llm.providers[0].apiKey, SECRETS.apiKey, 'p1 keeps its own key');
  });

  t('control: without the restore rule the mask itself would be stored', () => {
    // The mutation is "skip preserveSecretStrings": that is what the write path did before it was wired
    // through, and the value that lands is '***'.
    const incoming = publicConfig(fixture);
    assert.equal(incoming.llm.providers[0].apiKey, SECRET_MASK);
    assert.notEqual(incoming.llm.providers[0].apiKey, SECRETS.apiKey, 'the mask must differ from the secret');
    assert.equal(incoming.watch.targets[0].botPassword, SECRET_MASK);
    const storedAnyway = mergeDefaults(incoming);
    assert.equal(storedAnyway.llm.providers[0].apiKey, SECRET_MASK, 'this is the failure the restore prevents');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  section('2. the read routes');

  const app = await startFixtureApp();
  const control = await startLeakServer();

  for (const route of ['/api/config', '/api/llm/presets', '/api/watch', '/api/notify']) {
    ta(`GET ${route} carries no plaintext secret`, async () => {
      const r = await get(app.base, route);
      assert.equal(r.status, 200, `status ${r.status}`);
      assert.deepEqual(leakHits(r.json, SECRETS), [], 'leaked: ' + leakHits(r.json, SECRETS).join('; '));
      assert.deepEqual(textHits(r.text, { [NEW_SECRET_FIELD]: NEW_SECRET_VALUE }), [], `the new field leaked in ${route}`);
    });
  }

  ta('control: the same detector DOES fire on a server that answers with the config verbatim', async () => {
    // The pre-fix route, reachable here as a second route on a real server. The detector finds the secrets in
    // its answer, which is what makes its silence on the fixed routes evidence rather than a tautology.
    const raw = await get(control.base, '/api/config-raw-for-control');
    assert.equal(raw.status, 200);
    const hits = leakHits(raw.json, SECRETS);
    for (const name of Object.keys(SECRETS)) {
      assert.ok(hits.some((h) => h.includes(name)), `the detector did not fire on the leaking server (${name})`);
    }
    assert.ok(textHits(raw.text, { [NEW_SECRET_FIELD]: NEW_SECRET_VALUE }).length === 1, 'the new field must be visible here');
    // And the fixed route on that same server is still clean, so the difference is the serializer.
    assert.deepEqual(leakHits((await get(control.base, '/api/config')).json, SECRETS), []);
  });

  ta('GET /api/config has the shape a page needs, redacted', async () => {
    const r = await get(app.base, '/api/config');
    const problems = redactionProbe(r.json, SECRETS);
    assert.deepEqual(problems, [], problems.join('; '));
  });

  ta('GET /api/llm/presets masks the whole providers array, not only `active`', async () => {
    const r = await get(app.base, '/api/llm/presets');
    assert.ok(Array.isArray(r.json.providers), 'providers must stay a list');
    assert.equal(r.json.providers[0].apiKey, SECRET_MASK, 'a non-active profile must be masked too');
    assert.equal(r.json.providers[0].hasApiKey, true);
    assert.equal(r.json.providers[0][newSecretFlag], true, 'the field src does not know is masked here too');
    assert.equal(r.json.active.apiKey, SECRET_MASK);
    assert.equal(r.json.hasKey, true);
    assert.equal(r.json.active.baseUrl, 'https://api.example.invalid/v1', 'the page still needs the endpoint');
  });

  ta('control: masking the providers array is not the same as emptying it', async () => {
    const r = await get(app.base, '/api/llm/presets');
    assert.equal(r.json.providers.length, 1);
    assert.equal(r.json.providers[0].id, 'p1', 'the profile must still be identifiable');
    assert.equal(r.json.activeId, 'p1');
  });

  ta('GET /api/watch masks botPassword and keeps the target list intact', async () => {
    const r = await get(app.base, '/api/watch');
    assert.equal(r.json.targets.length, 2);
    assert.equal(r.json.targets[0].botPassword, SECRET_MASK);
    assert.equal(r.json.targets[0].username, 'Bot@Task');
    assert.equal(r.json.targets[1].url, 'https://example.com/');
  });

  ta('GET /api/notify masks the push credentials', async () => {
    const r = await get(app.base, '/api/notify');
    // The notifier has its own partial masker (it keeps the first/last characters of a key so the page shows
    // *which* key is configured). The requirement is the same either way: the plaintext must not be there.
    assert.ok(isMaskedSecret(r.json.targets[0].key), 'the key must be masked: ' + JSON.stringify(r.json.targets[0].key));
    assert.ok(!String(r.json.targets[0].key).includes('LEAKCANARY'), 'the key must not survive in the mask');
    assert.ok(String(r.json.targets[1].webhookUrl).startsWith('https://hooks.example.invalid/'), 'the origin may stay');
    assert.ok(!String(r.json.targets[1].webhookUrl).includes('LEAKCANARY'), 'the path must not stay');
    assert.deepEqual(textHits(r.text, SECRETS), [], 'no plaintext anywhere in the notify answer');
  });

  ta('the other config-derived GETs carry no secret either', async () => {
    for (const route of ['/api/state', '/api/share/targets', '/api/vdb/status']) {
      const r = await get(app.base, route);
      assert.ok(r.status < 400, route + ' status ' + r.status);
      assert.deepEqual(leakHits(r.json, SECRETS), [], route + ' leaked');
    }
  });

  ta('GET /api/config/export redacts by default (the precedent, unchanged)', async () => {
    const r = await get(app.base, '/api/config/export');
    assert.deepEqual(textHits(r.text, SECRETS), [], 'the default export leaked');
    // `proxy.controlSecret` is the one this route used to leak: its blank-the-fields list named the LLM key
    // and the wiki password but not the mihomo/Clash control credential. It is now covered by the serializer
    // that runs over the export after the blanking, and the blanking keeps the '' shape the import relies on.
    assert.ok(r.text.includes('"apiKey": ""'), 'the LLM key keeps the empty-string shape the import expects');
    assert.equal(textHits(r.text, { [NEW_SECRET_FIELD]: NEW_SECRET_VALUE }).length, 0, 'a secret the list does not name must be masked too');
    // `?secrets=1` is the deliberate backup switch: it must still carry the real values.
    const withSecrets = await get(app.base, '/api/config/export?secrets=1');
    assert.ok(textHits(withSecrets.text, SECRETS).length >= 4, 'the explicit backup must still contain the secrets');
  });

  t('control: the fixture on disk really holds the secrets (nothing above is checking an empty config)', () => {
    const disk = app.disk();
    assert.equal(disk.llm.providers[0].apiKey, SECRETS.apiKey);
    assert.equal(disk.watch.targets[0].botPassword, SECRETS.botPassword);
    assert.equal(disk.llm.providers[0][NEW_SECRET_FIELD], NEW_SECRET_VALUE);
    // …and the file this test writes is the fixture, not the repository's config.json.
    assert.ok(CFG_PATH.startsWith(WORK), 'the fixture must live in the temp dir');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  section('3. the write routes (a masked value is not a new value)');

  ta('PUT /api/config with the masked config does not wipe the stored secrets', async () => {
    const read = await get(app.base, '/api/config');
    assert.equal(read.json.llm.providers[0].apiKey, SECRET_MASK);
    const put = await send(app.base, 'PUT', '/api/config', read.json);
    assert.equal(put.status, 200, 'status ' + put.status);
    const disk = app.disk();
    assert.equal(disk.llm.providers[0].apiKey, SECRETS.apiKey, 'the key must survive the round-trip');
    assert.equal(disk.watch.targets[0].botPassword, SECRETS.botPassword);
    assert.equal(disk.notify.targets[0].key, SECRETS.notifyKey);
    assert.equal(disk.notify.targets[1].webhookUrl, SECRETS.webhookUrl);
    assert.equal(disk.proxy.controlSecret, SECRETS.controlSecret);
    assert.equal(disk.llm.providers[0][NEW_SECRET_FIELD], NEW_SECRET_VALUE, 'the field src does not know survives too');
    assert.ok(!('hasApiKey' in disk.llm.providers[0]), 'derived hasXxx must not be persisted');
    // And the answer to the write is itself masked.
    assert.deepEqual(leakHits(put.json, SECRETS), []);
  });

  ta('control: the same PUT would store the mask if the restore were removed', async () => {
    // Executed against a store that has no matching secret, which is the case where the restore has nothing
    // to put back: then the incoming value is what lands — and it is the mask, not a secret.
    const iso = await startFixtureApp();
    try {
      const read = await get(iso.base, '/api/config');
      const put = await send(iso.base, 'PUT', '/api/config', read.json);
      assert.equal(put.status, 200);
      assert.equal(iso.disk().llm.providers[0].apiKey, SECRETS.apiKey, 'the fixture app restores as well');
      const noRestore = mergeDefaults(read.json);
      assert.equal(noRestore.llm.providers[0].apiKey, SECRET_MASK, 'without the rule this is what would be stored');
    } finally {
      await shutdown(iso.server);
    }
  });

  ta('PUT /api/watch with masked targets does not wipe botPassword', async () => {
    const read = await get(app.base, '/api/watch');
    const put = await send(app.base, 'PUT', '/api/watch', { targets: read.json.targets, enabled: true });
    assert.equal(put.status, 200, 'status ' + put.status);
    assert.equal(app.disk().watch.targets[0].botPassword, SECRETS.botPassword);
    assert.equal(app.disk().watch.targets[0].username, 'Bot@Task');
  });

  ta('control: PUT /api/watch does store a password the user actually typed', async () => {
    const read = await get(app.base, '/api/watch');
    read.json.targets[0].botPassword = 'BotPw-typed-by-the-user-8888';
    await send(app.base, 'PUT', '/api/watch', { targets: read.json.targets });
    assert.equal(app.disk().watch.targets[0].botPassword, 'BotPw-typed-by-the-user-8888');
    // put the fixture back
    const again = await get(app.base, '/api/watch');
    again.json.targets[0].botPassword = SECRETS.botPassword;
    await send(app.base, 'PUT', '/api/watch', { targets: again.json.targets });
    assert.equal(app.disk().watch.targets[0].botPassword, SECRETS.botPassword);
  });

  ta('a real new key typed into a profile still saves', async () => {
    const read = await get(app.base, '/api/config');
    read.json.llm.providers[0].apiKey = TYPED_KEY;
    await send(app.base, 'PUT', '/api/config', read.json);
    assert.equal(app.disk().llm.providers[0].apiKey, TYPED_KEY);
    const back = app.disk();
    back.llm.providers[0].apiKey = SECRETS.apiKey;
    await send(app.base, 'PUT', '/api/config', back);
    assert.equal(app.disk().llm.providers[0].apiKey, SECRETS.apiKey);
  });

  ta('a wiki login check with a masked password uses the stored one, never the mask', async () => {
    const wiki = await startFakeWiki();
    try {
      const cfg = app.disk();
      cfg.watch.targets[0].apiUrl = `http://127.0.0.1:${wiki.port}/w/api.php`;
      await send(app.base, 'PUT', '/api/config', cfg);
      // '***' is what the settings page now holds, because that is what GET /api/config gave it.
      const r = await send(app.base, 'POST', '/api/watch/login-check', { id: 'w-wiki', username: 'Bot@Task', botPassword: SECRET_MASK });
      assert.equal(r.status, 200, 'status ' + r.status);
      assert.ok(wiki.seen.length >= 1, 'the check must actually reach the wiki');
      const dump = wiki.dump();
      // The password travels in the Basic authorization header (see buildWikiLoginRequest), so the assertion
      // is over everything the wiki received — headers and body alike.
      const expected = Buffer.from('Bot@Task:' + SECRETS.botPassword).toString('base64');
      const maskAsSent = Buffer.from('Bot@Task:' + SECRET_MASK).toString('base64');
      assert.ok(dump.includes(expected), 'the stored password is what was sent');
      assert.ok(!dump.includes(maskAsSent), 'the mask must never be sent as a credential');
      assert.ok(!dump.includes(SECRET_MASK), 'the literal mask must not appear in the request either');
    } finally {
      await shutdown(wiki.server);
    }
  });

  ta('control: that assertion is about the restore — the raw mask does not contain the password', async () => {
    // The negated assertion above ("the mask must not be sent") is only worth having if it can fail. It is
    // checked here against the wrong input: a body carrying the mask, which really does not carry the secret.
    const form = (pw) => 'lgpassword=' + encodeURIComponent(pw);
    assert.ok(form(SECRETS.botPassword).includes(encodeURIComponent(SECRETS.botPassword)));
    assert.ok(!form(SECRET_MASK).includes(encodeURIComponent(SECRETS.botPassword)));
    // A wrong restore would send the mask, and this is what that body looks like.
    assert.ok(form(SECRET_MASK).includes(encodeURIComponent(SECRET_MASK)));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  section('4. Host / Origin allowlist (DNS rebinding)');

  t('a loopback Host passes, with or without a port, in every form this app is reached by', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:43110', 'localhost', 'localhost:3080', '[::1]', '[::1]:43110', '127.0.0.2:8080']) {
      assert.equal(hostAllowed(h), true, h + ' must be allowed');
      assert.equal(guardDecision({ host: h }), null, h + ' must pass the guard');
    }
  });

  t('a non-loopback Host is refused', () => {
    for (const h of ['evil.example', 'evil.example:43110', '0.0.0.0', '192.168.1.10:43110', 'example.com', '']) {
      assert.equal(hostAllowed(h), false, h + ' must be refused');
      assert.match(String(guardDecision({ host: h })), /Host header/, h + ' must be refused with a reason');
    }
    assert.match(String(guardDecision({})), /Host header/, 'a request with no Host header is refused');
  });

  t('control: the Host check is not a prefix/substring test', () => {
    // These all *start with* an allowed name. A substring check would let a rebinding name through, and this
    // is the wrong input that pins which rule is implemented.
    for (const h of ['127.0.0.1.evil.example', 'localhost.evil.example', '127.0.0.1@evil.example', '[::1.evil.example', '127.0.0.1:43110.evil.example']) {
      assert.equal(hostAllowed(h), false, h + ' must be refused');
    }
    assert.equal(hostAllowed('127.0.0.1'), true, 'and the real thing is still allowed');
  });

  t('a foreign Origin is refused; a loopback one, or none, is fine', () => {
    assert.equal(guardDecision({ host: '127.0.0.1:43110' }), null, 'no Origin is the normal same-origin GET');
    assert.equal(guardDecision({ host: 'localhost', origin: 'http://localhost:43110' }), null);
    assert.equal(guardDecision({ host: '127.0.0.1', origin: 'http://127.0.0.1:43110' }), null);
    for (const origin of ['https://evil.example', 'null', 'file:///C:/x.html', 'not a url', 'http://evil.example:43110']) {
      assert.match(String(guardDecision({ host: '127.0.0.1:43110', origin })), /Origin/, origin + ' must be refused');
    }
    assert.equal(originAllowed('http://127.0.0.1:1'), true, 'the port is not compared: PORT can be overridden');
    assert.equal(originAllowed('https://[::1]:9'), true);
  });

  t('control: a foreign Origin is refused even when the Host is loopback (both rules are checked)', () => {
    // If only the Host were checked, this request is the one that would slip through.
    assert.ok(guardDecision({ host: '127.0.0.1:43110', origin: 'https://evil.example' }), 'must be refused');
    assert.equal(guardDecision({ host: '127.0.0.1:43110', origin: 'http://127.0.0.1:43110' }), null);
  });

  ta('over HTTP: a loopback Host is served, a rebinding Host is refused with JSON, not a reset', async () => {
    const ok = await get(app.base, '/api/state');
    assert.equal(ok.status, 200, 'the ordinary client must still be served');
    const rebind = await rawRequest(app.base, '/api/config', { Host: 'evil.example' });
    assert.equal(rebind.status, 403, 'a rebinding Host must be refused');
    assert.match(String(rebind.headers['content-type'] ?? ''), /application\/json/, 'a refusal is JSON, not a reset');
    assert.equal(rebind.json.ok, false);
    assert.match(String(rebind.json.error), /Host header/);
    assert.deepEqual(leakHits(rebind.json, SECRETS), [], 'the refusal must not leak either');
  });

  ta('over HTTP: a cross-origin Origin is refused, a same-origin one is served', async () => {
    const foreign = await get(app.base, '/api/config', { Origin: 'https://evil.example' });
    assert.equal(foreign.status, 403, 'status ' + foreign.status);
    assert.match(String(foreign.json.error), /Origin/);
    const same = await get(app.base, '/api/config', { Origin: app.base });
    assert.equal(same.status, 200);
    assert.equal(same.headers.get('vary'), 'Origin', 'the answer must be marked as origin-dependent');
  });

  ta('control: the guard does not answer 403 for everything', async () => {
    // Two requests that differ in exactly one header. If the middleware refused everything, the refusals
    // above would pass for the wrong reason; this pins that the header is what decides.
    const allowed = await get(app.base, '/api/config');
    const refused = await rawRequest(app.base, '/api/config', { Host: 'evil.example' });
    assert.equal(allowed.status, 200);
    assert.equal(refused.status, 403);
    assert.notEqual(allowed.status, refused.status);
  });

  ta('the guard does not break the routes the three traversals drive over 127.0.0.1', async () => {
    for (const route of ['/api/state', '/api/sources', '/api/health', '/api/config', '/api/llm/presets', '/api/watch', '/api/notify', '/api/share/targets', '/api/schedule', '/api/reports']) {
      const r = await get(app.base, route);
      assert.ok(r.status < 400, route + ' answered ' + r.status);
    }
  });

  // ── the async half ────────────────────────────────────────────────────────────────────────────────
  for (const [name, fn] of asyncChecks) {
    try {
      await fn();
      pass++;
      process.stdout.write('  [ok]   ' + name + '\n');
    } catch (e) {
      fail++;
      failures.push(name + ' — ' + e.message);
      process.stdout.write('  [FAIL] ' + name + ' — ' + e.message + '\n');
    }
  }

  await shutdown(app.server);
  await shutdown(control.server);
  process.stdout.write('\n' + (fail ? 'FAILED' : 'all good') + `: ${pass} passed, ${fail} failed\n`);
  if (fail) {
    process.stdout.write('\n' + failures.map((f) => '  - ' + f).join('\n') + '\n');
    process.exitCode = 1;
  }
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* the temp dir is disposable */
  }
};

main().catch((e) => {
  process.stdout.write('\nunexpected failure: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exitCode = 1;
});
